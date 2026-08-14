import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { searchCatalogProducts, rankProductNameMatches } from "@/lib/quotes/catalog/search";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import {
  resolveProductConfigurationBase, computeConfigurationBlockingReasons, computeBundleConfigurationErrors,
} from "@/lib/quotes/server/productConfiguration";
import { createRootDraft, buildAutoSelectedDraftChildren } from "@/lib/quotes/bundles/autoSelect";
import type { QuoteFormData, QuoteLineItemDraft } from "@/lib/quotes/types";
import type { QuoteField } from "./columnMapping";

export type RowStatus = "ready" | "warning" | "error";
export interface RowIssue { level: "error" | "warning" | "info"; field?: string; message: string }

export interface QuoteHeaderInput {
  name: string;
  accountName: string;
  opportunityName: string;
  pricebookName: string;
  startDate: string;
  expirationDate: string;
  status: string;
  description: string;
}

export interface QuoteLineItemInput { product: string; quantity: string; unitPrice: string; discount: string }

export interface QuoteLineItemResult {
  rowIndex: number;
  input: QuoteLineItemInput;
  status: "ready" | "error";
  issues: RowIssue[];
  resolvedProductName: string | null;
  draft: QuoteLineItemDraft | null;
}

export interface QuoteGroupResult {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  input: QuoteHeaderInput;
  /** The exact shape POSTed as `{ formData }` to /api/quotes — null for groups excluded from creation (error). */
  formData: QuoteFormData | null;
  resolvedPricebookId: string | null;
  lineItems: QuoteLineItemResult[];
}

export interface ValidateQuoteRowsResult {
  groups: QuoteGroupResult[];
  summary: { total: number; ready: number; warnings: number; errors: number; totalLineItems: number };
}

/**
 * §Pricing Configuration Missing: searchCatalogProducts (and therefore
 * rankProductNameMatches) is scoped to PricebookEntry rows in ONE specific
 * price book — a Product2 that genuinely exists in the org but has no
 * PricebookEntry in THIS Quote's price book is invisible to it, indistinguishable
 * from "no such product anywhere". A plain, unscoped Product2 name lookup
 * here is the only way to tell those two cases apart, so the reported reason
 * names the real problem (missing Price Book Entry) instead of a generic
 * "could not be resolved" that reads like a typo in the product name.
 */
async function productExistsAnywhere(client: SalesforceClient, name: string): Promise<boolean> {
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM Product2 WHERE Name = '${soqlEscape(name)}' LIMIT 1`);
    return res.records.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validates + resolves every parsed Quote import row against the connected
 * Salesforce org. Rows sharing the same mapped "Quote Name" column value
 * are grouped into ONE Quote header + N line items (never one Quote per
 * row) — mirroring how the manual flow creates a Quote header via
 * POST /api/quotes, then attaches line items via
 * POST /api/quotes/[id]/line-items, both reused unchanged by the importer.
 * Product name → PricebookEntry resolution reuses the exact
 * searchCatalogProducts/rankProductNameMatches helpers the manual Add Quote
 * Line Items UI already uses.
 *
 * Every resolved product is ALSO run through
 * resolveProductConfigurationBase() — the exact same Selling Model/Billing
 * Frequency/Attribute/Bundle resolution chain POST /api/quotes/products/
 * configure performs on a manual "+ Add" — and the resulting draft is built
 * via the SAME createRootDraft()/buildAutoSelectedDraftChildren() helpers
 * the manual Add-to-Quote flow uses (lib/quotes/bundles/autoSelect.ts).
 * Skipping this chain was the actual root cause of imported line items
 * failing to reach Salesforce: createQuoteLineItems() (lib/quotes/server/
 * lineItemCreate.ts) VALIDATES that a draft already carries a resolved
 * Billing Frequency whenever its Selling Model requires one — it does not
 * (and must not) re-derive it — so a product added via import with a
 * null billingFrequency reliably failed at creation time whenever its
 * Selling Model was Evergreen/Term-Defined, taking every OTHER line in
 * that same batch down with it (one Salesforce call creates the whole
 * batch). A product whose configuration cannot be fully auto-resolved
 * (a required attribute, an ambiguous bundle choice, or an unresolvable
 * billing frequency — none of which the CSV format can supply) is now
 * reported as a skipped line item instead of silently corrupting the
 * whole Quote's batch. This module only reads from Salesforce.
 */
export async function validateQuoteRows(
  client: SalesforceClient,
  rawRows: Record<string, string>[],
  mapping: Record<QuoteField, string | null>,
): Promise<ValidateQuoteRowsResult> {
  const get = (row: Record<string, string>, field: QuoteField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const rowInputs = rawRows.map(row => ({
    name: get(row, "name"),
    accountName: get(row, "accountName"),
    opportunityName: get(row, "opportunityName"),
    pricebookName: get(row, "pricebookName"),
    startDate: get(row, "startDate"),
    expirationDate: get(row, "expirationDate"),
    status: get(row, "status"),
    description: get(row, "description"),
    product: get(row, "product"),
    quantity: get(row, "quantity"),
    unitPrice: get(row, "unitPrice"),
    discount: get(row, "discount"),
  }));

  // Group rows sharing a non-empty Quote Name; a row with no name becomes its own single-row group.
  const groupIndices: number[][] = [];
  const keyToGroup = new Map<string, number>();
  rowInputs.forEach((input, i) => {
    if (input.name) {
      const existing = keyToGroup.get(input.name);
      if (existing !== undefined) { groupIndices[existing].push(i); return; }
      keyToGroup.set(input.name, groupIndices.length);
      groupIndices.push([i]);
    } else {
      groupIndices.push([i]);
    }
  });

  const firstNonEmpty = (indices: number[], field: keyof typeof rowInputs[number]): string => {
    for (const i of indices) {
      const v = rowInputs[i][field];
      if (v) return v as string;
    }
    return "";
  };

  const headerInputs: QuoteHeaderInput[] = groupIndices.map(indices => ({
    name: firstNonEmpty(indices, "name"),
    accountName: firstNonEmpty(indices, "accountName"),
    opportunityName: firstNonEmpty(indices, "opportunityName"),
    pricebookName: firstNonEmpty(indices, "pricebookName"),
    startDate: firstNonEmpty(indices, "startDate"),
    expirationDate: firstNonEmpty(indices, "expirationDate"),
    status: firstNonEmpty(indices, "status"),
    description: firstNonEmpty(indices, "description"),
  }));

  const accountResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Account" as const, name: h.accountName })));
  const opportunityResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Opportunity" as const, name: h.opportunityName })));
  const pricebookResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Pricebook2" as const, name: h.pricebookName })));

  // Resolved once for the whole import — the same org-wide bundle-relationship
  // discovery every configure call needs; it never varies per product.
  const discovery = await resolveBundleObjectDiscovery(client);
  // §Selling Model Not Found (only meaningful when this org's QuoteLineItem
  // actually HAS a selling-model-shaped field to populate — a plain
  // ManualPricing org with no such field at all must never be blocked for
  // "missing" something it doesn't use).
  const qliSchema = await resolveQuoteLineItemFieldSchema(client);
  const orgHasSellingModelField = !!(qliSchema.sellingModelField || qliSchema.sellingModelOptionField);

  const groups: QuoteGroupResult[] = [];
  for (let g = 0; g < groupIndices.length; g++) {
    const input = headerInputs[g];
    const issues: RowIssue[] = [];

    if (!input.name) issues.push({ level: "error", field: "name", message: "Quote Name is required." });

    if (input.accountName && !accountResults[g]) issues.push({ level: "warning", field: "accountName", message: `Account "${input.accountName}" could not be resolved — the Quote will be created without a linked Account.` });
    if (input.opportunityName && !opportunityResults[g]) issues.push({ level: "warning", field: "opportunityName", message: `Opportunity "${input.opportunityName}" could not be resolved — the Quote will be created without a linked Opportunity.` });
    if (input.pricebookName && !pricebookResults[g]) issues.push({ level: "warning", field: "pricebookName", message: `Price Book "${input.pricebookName}" could not be resolved — the Quote will be created without a Price Book.` });

    const resolvedPricebookId = pricebookResults[g]?.id ?? null;
    if (!resolvedPricebookId && groupIndices[g].some(i => rowInputs[i].product)) {
      issues.push({ level: "warning", field: "product", message: "Line items were provided, but no Price Book could be resolved for this Quote — line items cannot be added without one." });
    }

    const lineItems: QuoteLineItemResult[] = [];
    for (const rowIndex of groupIndices[g]) {
      const li = rowInputs[rowIndex];
      if (!li.product) continue;
      const liIssues: RowIssue[] = [];
      let draft: QuoteLineItemDraft | null = null;
      let resolvedProductName: string | null = null;

      const quantity = li.quantity ? Number(li.quantity) : 1;
      if (Number.isNaN(quantity) || quantity <= 0) liIssues.push({ level: "error", field: "quantity", message: `Quantity "${li.quantity}" is not a valid positive number.` });

      let unitPriceOverride: number | null = null;
      if (li.unitPrice) {
        const parsed = Number(li.unitPrice.replace(/[^0-9.-]/g, ""));
        if (Number.isNaN(parsed)) liIssues.push({ level: "error", field: "unitPrice", message: `Unit Price "${li.unitPrice}" is not a valid number.` });
        else unitPriceOverride = parsed;
      }

      let discountPercent = 0;
      if (li.discount) {
        const parsedDiscount = Number(li.discount.replace(/[^0-9.-]/g, ""));
        if (Number.isNaN(parsedDiscount)) liIssues.push({ level: "error", field: "discount", message: `Discount "${li.discount}" is not a valid percentage.` });
        else discountPercent = parsedDiscount;
      }

      if (!resolvedPricebookId) {
        liIssues.push({ level: "error", field: "product", message: `Product "${li.product}" could not be resolved — this Quote's Price Book itself could not be resolved.` });
      } else if (liIssues.every(iss => iss.level !== "error")) {
        try {
          const candidates = await searchCatalogProducts(client, resolvedPricebookId, li.product, 10);
          const ranked = rankProductNameMatches(li.product, candidates);
          if (ranked.autoSelected) {
            const product = ranked.autoSelected.product;
            resolvedProductName = product.name;

            // Reuse the EXACT resolution chain a manual "+ Add" performs
            // (POST /api/quotes/products/configure) before building a draft —
            // never hand createQuoteLineItems() an under-configured one.
            const base = await resolveProductConfigurationBase(client, discovery, product, resolvedPricebookId, "QuoteLineItem");
            const bundleConfigErrors = computeBundleConfigurationErrors(base.bundle);
            if (orgHasSellingModelField && !base.sellingModel.chosen) {
              // §Selling Model Not Found: this org's QuoteLineItem has a
              // selling-model-shaped field to populate, but resolution found
              // NO ProductSellingModelOption/PricebookEntry-linked selling
              // model for this product at all — never create a QLI with
              // that field silently blank; Salesforce's own native pricing/
              // configuration validation depends on it being populated.
              liIssues.push({
                level: "error", field: "product",
                message: `⚠ Selling Model Not Found — "${product.name}" exists, but no valid Product Selling Model could be resolved for this Quote. This line item will not be created.`,
              });
            } else if (base.billingTreatment?.blocks && base.billingTreatment.outcome !== "no-billing-policy") {
              liIssues.push({ level: "error", field: "product", message: `"${product.name}" cannot be added: ${base.billingTreatment.message ?? "billing configuration issue"}.` });
            } else if (bundleConfigErrors.length > 0) {
              // §Bundle Configuration Error — distinct from "needs manual
              // configuration" below: the bundle's own structure/data
              // couldn't be resolved from Salesforce at all, so there is no
              // configuration a human could complete to fix this from the
              // import UI. Never create a QLI against an unresolvable bundle
              // and let Salesforce discover the gap later.
              liIssues.push({
                level: "error", field: "product",
                message: `⚠ Bundle Configuration Error — "${product.name}" exists as a Bundle, but its product/configuration information could not be resolved: ${bundleConfigErrors.join(" ")} This Quote Line Item will be skipped until the bundle configuration is fixed.`,
              });
            } else {
              const blockingReasons = computeConfigurationBlockingReasons(base);
              if (blockingReasons.length > 0) {
                liIssues.push({ level: "error", field: "product", message: `"${product.name}" requires manual configuration that this import cannot supply — ${blockingReasons.join(" ")} This line item will be skipped; add it manually after import.` });
              } else {
                const root = createRootDraft(product, base.bundle.isBundle);
                root.quantity = quantity;
                root.unitPrice = unitPriceOverride ?? product.listPrice;
                root.discountPercent = discountPercent;
                // §Never send a synthetic option id to Salesforce — see toDirectOption in lib/quotes/catalog/sellingModel.ts.
                root.sellingModelOptionId = (base.sellingModel.chosen && !base.sellingModel.chosen.isSynthetic) ? base.sellingModel.chosen.id : null;
                root.sellingModelId = base.sellingModel.chosen?.sellingModelId ?? null;
                root.sellingModelName = base.sellingModel.chosen?.name ?? null;
                root.sellingModelType = base.sellingModel.chosen?.type ?? null;
                root.billingFrequency = base.billingFrequency?.value ?? null;
                root.billingFrequencySource = base.billingFrequency?.source ?? null;
                root.subscriptionTerm = base.subscriptionTerm?.value ?? null;
                root.billingTreatmentOutcome = base.billingTreatment?.outcome ?? null;
                if (base.bundle.isBundle) {
                  root.children = buildAutoSelectedDraftChildren(base.bundle.components, base.bundle.groups, root.draftId);
                }
                draft = root;
              }
            }
          } else if (candidates.length === 0 && (await productExistsAnywhere(client, li.product))) {
            // §Pricing Configuration Missing (§19): the product genuinely
            // exists in this org — it's simply not priced in THIS Quote's
            // price book. Distinct from "no such product" so the reported
            // reason names the real fix (add a Price Book Entry) instead of
            // reading like a typo.
            liIssues.push({
              level: "error", field: "product",
              message: `⚠ Pricing Configuration Missing — Product "${li.product}" exists, but no valid Price Book Entry was found for this Quote's Price Book. This Quote Line Item will be skipped.`,
            });
          } else {
            liIssues.push({ level: "error", field: "product", message: `Product "${li.product}" could not be confidently resolved to a single product in this Price Book${candidates.length ? ` (${candidates.length} similar match(es) found)` : ""}.` });
          }
        } catch {
          liIssues.push({ level: "error", field: "product", message: `Product "${li.product}" could not be resolved — a Salesforce lookup error occurred.` });
        }
      }

      lineItems.push({ rowIndex, input: li, status: liIssues.some(iss => iss.level === "error") ? "error" : "ready", issues: liIssues, resolvedProductName, draft });
    }

    const headerHasError = issues.some(iss => iss.level === "error");
    const lineItemsHaveError = lineItems.some(li => li.status === "error");
    const status: RowStatus = headerHasError ? "error" : (issues.some(iss => iss.level === "warning") || lineItemsHaveError) ? "warning" : "ready";

    const formData: QuoteFormData | null = headerHasError ? null : {
      name: input.name,
      accountName: accountResults[g] ? input.accountName : "",
      pricebookName: pricebookResults[g] ? input.pricebookName : "",
      opportunityName: opportunityResults[g] ? input.opportunityName : "",
      startDate: input.startDate,
      expirationDate: input.expirationDate,
      status: input.status,
      description: input.description,
    };

    groups.push({ index: g, status, issues, input, formData, resolvedPricebookId, lineItems });
  }

  const summary = {
    total: groups.length,
    ready: groups.filter(g => g.status === "ready").length,
    warnings: groups.filter(g => g.status === "warning").length,
    errors: groups.filter(g => g.status === "error").length,
    totalLineItems: groups.reduce((sum, g) => sum + g.lineItems.length, 0),
  };

  return { groups, summary };
}
