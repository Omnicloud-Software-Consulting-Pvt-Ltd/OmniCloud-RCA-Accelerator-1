import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { searchCatalogProducts, rankProductNameMatches } from "@/lib/quotes/catalog/search";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { resolveProductConfigurationBase, computeConfigurationBlockingReasons } from "@/lib/quotes/server/productConfiguration";
import { createRootDraft, buildAutoSelectedDraftChildren } from "@/lib/quotes/bundles/autoSelect";
import type { OrderFormData } from "@/lib/orders/types";
import type { QuoteLineItemDraft } from "@/lib/quotes/types";
import type { OrderField } from "./columnMapping";

export type RowStatus = "ready" | "warning" | "error";
export interface RowIssue { level: "error" | "warning" | "info"; field?: string; message: string }

export interface OrderHeaderInput {
  orderKey: string;
  accountName: string;
  pricebookName: string;
  effectiveDate: string;
  status: string;
  type: string;
  poNumber: string;
  poDate: string;
  contractName: string;
  sourceQuoteName: string;
  description: string;
}

export interface OrderLineItemInput { product: string; quantity: string; unitPrice: string }

export interface OrderLineItemResult {
  rowIndex: number;
  input: OrderLineItemInput;
  status: "ready" | "error";
  issues: RowIssue[];
  resolvedProductName: string | null;
  draft: QuoteLineItemDraft | null;
}

export interface OrderGroupResult {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  input: OrderHeaderInput;
  /** The exact shape POSTed as `{ formData }` to /api/orders — null for groups excluded from creation (error). */
  formData: OrderFormData | null;
  resolvedPricebookId: string | null;
  lineItems: OrderLineItemResult[];
}

export interface ValidateOrderRowsResult {
  groups: OrderGroupResult[];
  summary: { total: number; ready: number; warnings: number; errors: number; totalLineItems: number };
}

/**
 * Validates + resolves every parsed Order import row against the connected
 * Salesforce org. Rows sharing the same mapped "Order Number" column value
 * are grouped into ONE Order header + N line items (never one Order per
 * row) — mirroring how the manual flow creates an Order header via
 * POST /api/orders, then attaches line items via
 * POST /api/orders/[id]/line-items, both reused unchanged by the importer.
 * Product name → PricebookEntry resolution reuses the exact
 * searchCatalogProducts/rankProductNameMatches helpers the manual Add Line
 * Items UI already uses.
 *
 * Every resolved product is ALSO run through
 * resolveProductConfigurationBase() — the exact same Selling Model/Billing
 * Frequency/Attribute/Bundle resolution chain POST /api/orders/products/
 * configure performs on a manual "+ Add" — mirrors the identical fix in
 * lib/quotes/import/validateRows.ts; see that file's comment for why
 * skipping this chain was the actual root cause of imported line items
 * failing to reach Salesforce (createOrderItems() validates that a draft
 * already carries a resolved Billing Frequency whenever required — it does
 * not re-derive one). This module only reads from Salesforce.
 */
export async function validateOrderRows(
  client: SalesforceClient,
  rawRows: Record<string, string>[],
  mapping: Record<OrderField, string | null>,
): Promise<ValidateOrderRowsResult> {
  const get = (row: Record<string, string>, field: OrderField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const rowInputs = rawRows.map(row => ({
    orderKey: get(row, "orderKey"),
    accountName: get(row, "accountName"),
    pricebookName: get(row, "pricebookName"),
    effectiveDate: get(row, "effectiveDate"),
    status: get(row, "status"),
    type: get(row, "type"),
    poNumber: get(row, "poNumber"),
    poDate: get(row, "poDate"),
    contractName: get(row, "contractName"),
    sourceQuoteName: get(row, "sourceQuoteName"),
    description: get(row, "description"),
    product: get(row, "product"),
    quantity: get(row, "quantity"),
    unitPrice: get(row, "unitPrice"),
  }));

  // Group rows sharing a non-empty orderKey; a row with no orderKey (or no
  // orderKey column mapped at all) becomes its own single-row group.
  const groupIndices: number[][] = [];
  const keyToGroup = new Map<string, number>();
  rowInputs.forEach((input, i) => {
    if (input.orderKey) {
      const existing = keyToGroup.get(input.orderKey);
      if (existing !== undefined) { groupIndices[existing].push(i); return; }
      keyToGroup.set(input.orderKey, groupIndices.length);
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

  const headerInputs: OrderHeaderInput[] = groupIndices.map(indices => ({
    orderKey: firstNonEmpty(indices, "orderKey"),
    accountName: firstNonEmpty(indices, "accountName"),
    pricebookName: firstNonEmpty(indices, "pricebookName"),
    effectiveDate: firstNonEmpty(indices, "effectiveDate"),
    status: firstNonEmpty(indices, "status"),
    type: firstNonEmpty(indices, "type"),
    poNumber: firstNonEmpty(indices, "poNumber"),
    poDate: firstNonEmpty(indices, "poDate"),
    contractName: firstNonEmpty(indices, "contractName"),
    sourceQuoteName: firstNonEmpty(indices, "sourceQuoteName"),
    description: firstNonEmpty(indices, "description"),
  }));

  const accountResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Account" as const, name: h.accountName })));
  const pricebookResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Pricebook2" as const, name: h.pricebookName })));
  const contractResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Contract" as const, name: h.contractName })));
  const quoteResults = await resolveReferencesByName(client, headerInputs.map(h => ({ objectType: "Quote" as const, name: h.sourceQuoteName })));

  // Resolved once for the whole import — the same org-wide bundle-relationship
  // discovery every configure call needs; it never varies per product.
  const discovery = await resolveBundleObjectDiscovery(client);

  const groups: OrderGroupResult[] = [];
  for (let g = 0; g < groupIndices.length; g++) {
    const input = headerInputs[g];
    const issues: RowIssue[] = [];

    if (!input.accountName) issues.push({ level: "error", field: "accountName", message: "Account is required." });
    else if (!accountResults[g]) issues.push({ level: "error", field: "accountName", message: `Account "${input.accountName}" could not be resolved in Salesforce.` });

    if (!input.pricebookName) issues.push({ level: "error", field: "pricebookName", message: "Price Book is required." });
    else if (!pricebookResults[g]) issues.push({ level: "error", field: "pricebookName", message: `Price Book "${input.pricebookName}" could not be resolved in Salesforce.` });

    if (input.contractName && !contractResults[g]) issues.push({ level: "warning", field: "contractName", message: `Contract "${input.contractName}" could not be resolved — the Order will be created without a linked Contract.` });
    if (input.sourceQuoteName && !quoteResults[g]) issues.push({ level: "warning", field: "sourceQuoteName", message: `Quote "${input.sourceQuoteName}" could not be resolved — the Order will be created without a linked Quote.` });

    const resolvedPricebookId = pricebookResults[g]?.id ?? null;

    // Resolve line items for every row belonging to this group that named a product.
    const lineItems: OrderLineItemResult[] = [];
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

      if (!resolvedPricebookId) {
        liIssues.push({ level: "error", field: "product", message: `Product "${li.product}" could not be resolved — this Order's Price Book itself could not be resolved.` });
      } else if (liIssues.every(iss => iss.level !== "error")) {
        try {
          const candidates = await searchCatalogProducts(client, resolvedPricebookId, li.product, 10);
          const ranked = rankProductNameMatches(li.product, candidates);
          if (ranked.autoSelected) {
            const product = ranked.autoSelected.product;
            resolvedProductName = product.name;

            // Reuse the EXACT resolution chain a manual "+ Add" performs
            // (POST /api/orders/products/configure) before building a draft —
            // never hand createOrderItems() an under-configured one.
            const base = await resolveProductConfigurationBase(client, discovery, product, resolvedPricebookId, "OrderItem");
            if (base.billingTreatment?.blocks && base.billingTreatment.outcome !== "no-billing-policy") {
              liIssues.push({ level: "error", field: "product", message: `"${product.name}" cannot be added: ${base.billingTreatment.message ?? "billing configuration issue"}.` });
            } else {
              const blockingReasons = computeConfigurationBlockingReasons(base);
              if (blockingReasons.length > 0) {
                liIssues.push({ level: "error", field: "product", message: `"${product.name}" requires manual configuration that this import cannot supply — ${blockingReasons.join(" ")} This line item will be skipped; add it manually after import.` });
              } else {
                const root = createRootDraft(product, base.bundle.isBundle);
                root.quantity = quantity;
                root.unitPrice = unitPriceOverride ?? product.listPrice;
                root.sellingModelOptionId = base.sellingModel.chosen?.id ?? null;
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

    const formData: OrderFormData | null = headerHasError ? null : {
      accountName: input.accountName,
      pricebookName: input.pricebookName,
      effectiveDate: input.effectiveDate,
      status: input.status,
      contractName: contractResults[g] ? input.contractName : "",
      type: input.type,
      poNumber: input.poNumber,
      poDate: input.poDate,
      description: input.description,
      sourceQuoteName: quoteResults[g] ? input.sourceQuoteName : "",
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
