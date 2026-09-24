import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, findPicklistFieldByLabel } from "@/lib/salesforce/describe";
import { resolveQuoteLineItemFieldSchema, resolveQuoteLineItemAttributeFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveQuoteFieldSchema } from "@/lib/quotes/metadata/quoteFields";
import { resolveBundleObjectDiscovery, resolveQuoteLineRelationshipSchema } from "@/lib/quotes/metadata/relationshipFields";
import { expandBundle } from "@/lib/quotes/bundles/expansion";
import { validateDraftForest, type DraftValidationProductInfo } from "@/lib/quotes/bundles/validate";
import {
  flattenForestWithParentIndex,
  integrityCheckPayload,
  buildQLIPayload,
  resolveInitialPricingField,
  createInDependencyOrderedPasses,
  rollbackRecords,
  createNativeBundleRelationships,
  validateBundleRelationshipEdges,
  resolveRequiredQuoteLineItemFields,
  type FlatDraftItem,
} from "@/lib/quotes/bundles/relationshipCreate";
import { fetchCatalogProductsByIds } from "@/lib/quotes/catalog/search";
import { resolveSellingModelsBatch } from "@/lib/quotes/catalog/sellingModel";
import { resolveProductAttributesBatch } from "@/lib/quotes/catalog/attributes";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import { resolveBillingFrequency } from "@/lib/quotes/billing/frequency";
import { applyListPriceFallback } from "@/lib/quotes/pricing/applyListPrice";
import { netUnitPrice as computeNetUnitPrice } from "@/lib/quotes/pricing/calc";
import { repriceQuote } from "@/lib/quotes/pricing/reprice";
import { resolveQuoteLineAdjustmentDiscovery } from "@/lib/quotes/metadata/adjustmentFields";
import type {
  BillingTreatmentValidation,
  BundleHierarchyStep,
  LineItemCreationError,
  LineItemCreationResult,
  LineItemFailureDetail,
  LineItemRollbackDetail,
  PricingTraceLine,
  QuoteLineItemDraft,
  RefreshedLineItem,
  RepricingSummary,
} from "@/lib/quotes/types";

function uniqueProductIds(flatItems: FlatDraftItem[]): string[] {
  return [...new Set(flatItems.map(i => i.draft.productId))];
}

/**
 * §Confirmed breakpoint #2 — readBackLineItems previously preferred
 * NetUnitPrice/NetTotalPrice for display/verification purely because those
 * fields EXIST on this org's QuoteLineItem, regardless of whether this app
 * (or anything else) had ever written to them. Runtime evidence: create
 * payload UnitPrice=1149 succeeds, a subsequent PATCH UnitPrice=1149 also
 * succeeds, yet "After Insert"/"Final Salesforce" both showed $0.00 — because
 * both checkpoints were reading NetUnitPrice (a Revenue Cloud engine-owned
 * field this app has never populated, since Instant Pricing repricing is
 * disabled — see the "Repricing" step below), never the real UnitPrice value
 * this app actually wrote and Salesforce actually persisted.
 *
 * The authoritative field for display/verification must be whichever field
 * THIS APP actually targeted for the write being verified — never assumed
 * from mere schema presence. `writtenUnitPriceField`/`writtenTotalPriceField`
 * are the exact API names the relevant write step (buildQLIPayload at
 * create time, or applyListPriceFallback's `fieldsUsed` afterward) targeted;
 * null means nothing was written and this falls back to whatever price
 * field the schema resolved, never to an unrelated Net* field.
 */
function resolveAuthoritativePriceField(
  qliSchema: Awaited<ReturnType<typeof resolveQuoteLineItemFieldSchema>>,
  writtenUnitPriceField: string | null,
): { unitPriceApiName: string | null; totalPriceApiName: string | null } {
  if (writtenUnitPriceField && writtenUnitPriceField === qliSchema.netUnitPriceField?.apiName) {
    return {
      unitPriceApiName: writtenUnitPriceField,
      totalPriceApiName: qliSchema.netTotalPriceField?.apiName ?? qliSchema.totalPriceField?.apiName ?? null,
    };
  }
  if (writtenUnitPriceField) {
    return { unitPriceApiName: writtenUnitPriceField, totalPriceApiName: qliSchema.totalPriceField?.apiName ?? null };
  }
  return { unitPriceApiName: qliSchema.unitPriceField?.apiName ?? null, totalPriceApiName: qliSchema.totalPriceField?.apiName ?? null };
}

// §Discount pricing investigation Phase 1 — "discount"/"adjust" added
// explicitly: a field literally named e.g. "Discount" or "AdjustmentType"
// (no "amount"/"net"/"list"/"price" substring) previously never appeared in
// this diagnostic at all.
const PRICING_FIELD_KEYWORD_RE = /price|amount|total|net|list|pricing|discount|adjust/i;

export interface PricingFieldDiagnosticRow {
  apiName: string;
  label: string;
  createable: boolean;
  updateable: boolean;
  calculated: boolean;
  value: unknown;
}

/**
 * §Runtime evidence item 1 — every pricing-shaped field this org's
 * QuoteLineItem Describe actually exposes (never collapsed to one generic
 * "price"), queried live and reported with its own Describe capability
 * evidence next to its live value, for every given Id. Built straight from
 * Describe + a fresh SOQL query — independent of the narrow unitPrice/
 * netUnitPrice fields this app already resolved for its own write/read
 * paths, so it can catch exactly the case where the real authoritative
 * field is one neither of those paths names. Exported so a read-only
 * diagnostics endpoint (app/api/quotes/line-items/[id]/pricing-diagnostics/
 * route.ts) can reuse the exact same evidence-gathering for ANY QuoteLineItem
 * Id — including one discounted manually in the Salesforce UI, never only
 * ones this app created — for direct side-by-side comparison.
 */
export async function capturePricingFieldDiagnostics(
  client: SalesforceClient,
  ids: string[],
): Promise<Record<string, PricingFieldDiagnosticRow[]>> {
  const result: Record<string, PricingFieldDiagnosticRow[]> = {};
  if (ids.length === 0) return result;
  const describe = await describeObjectCached(client, "QuoteLineItem");
  const candidates = describe.fields.filter(f => PRICING_FIELD_KEYWORD_RE.test(f.name) || PRICING_FIELD_KEYWORD_RE.test(f.label));
  if (candidates.length === 0) return result;

  const selectFields = ["Id", ...candidates.map(f => f.name)];
  let rows: Record<string, unknown>[] = [];
  try {
    const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await client.query<Record<string, unknown>>(`SELECT ${selectFields.join(", ")} FROM QuoteLineItem WHERE Id IN (${idList})`);
    rows = res.records;
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const id = row.Id as string;
    result[id] = candidates.map(f => ({
      apiName: f.name,
      label: f.label,
      createable: !!f.createable,
      updateable: !!f.updateable,
      calculated: !!f.calculated,
      value: row[f.name] ?? null,
    }));
  }
  return result;
}

function findNode(roots: QuoteLineItemDraft[], productId: string): QuoteLineItemDraft | null {
  for (const root of roots) {
    if (root.productId === productId) return root;
    const found = findNode(root.children, productId);
    if (found) return found;
  }
  return null;
}

/**
 * The core server-side line-item creation sequence (§5.8). Independently
 * re-verifies everything the client already checked — never trusts a
 * client-supplied "this is valid" signal (§2.6) — then creates the full
 * bundle hierarchy in dependency-ordered passes with rollback on any
 * failure at any stage.
 *
 * Every validation stage logs Input/Output/Reason before moving on
 * (§Issue 2), and any failure returns a fully structured
 * `LineItemFailureDetail` — never a bare "Request failed" message
 * (§Issue 3/4) — naming the exact step, rule, field, and payload involved.
 */
export async function createQuoteLineItems(
  client: SalesforceClient,
  quoteId: string,
  pricebookId: string,
  draftRoots: QuoteLineItemDraft[],
): Promise<LineItemCreationResult> {
  const steps: BundleHierarchyStep[] = [];
  const errors: LineItemCreationError[] = [];
  let lastSuccessfulStep: string | null = null;
  let qlrSchemaRef: Awaited<ReturnType<typeof resolveQuoteLineRelationshipSchema>> | null = null;
  // `pricebookId` is reassigned below (never trust the caller's copy — see
  // "Verify Quote Pricebook") — every later reference in this function
  // (freshCatalog lookups, bundle expansion, logs) reads whatever value
  // this variable holds at that point, so the reassignment alone is
  // sufficient to correct every downstream usage.

  /** Log one stage — always Step Name / Input / Output / Reason, per §Issue 2. */
  function logStep(name: string, status: BundleHierarchyStep["status"], input: unknown, output: unknown, reason: string) {
    steps.push({ step: name, status, message: reason, detail: { input, output, reason }, timestamp: Date.now() });
    if (status === "success") lastSuccessfulStep = name;
  }

  /** Best-effort rollback that is ALWAYS logged as its own step (§Issue 5) — never silent. */
  async function rollbackWithLog(records: { sobject: string; ids: string[] }[]): Promise<LineItemRollbackDetail> {
    const nonEmpty = records.filter(r => r.ids.length > 0);
    if (nonEmpty.length === 0) {
      logStep("Rollback", "info", records, null, "Nothing to roll back — no records had been created yet.");
      return { attempted: false, records: [] };
    }
    logStep("Rollback", "start", nonEmpty, null, `Rolling back ${nonEmpty.map(r => `${r.ids.length} ${r.sobject}`).join(", ")}.`);
    for (const r of nonEmpty) await rollbackRecords(client, r.sobject, r.ids);
    logStep("Rollback", "success", nonEmpty, nonEmpty, "Rollback complete.");
    return { attempted: true, records: nonEmpty };
  }

  /** Build the full structured failure response — the ONLY way this function returns success:false. */
  async function fail(params: {
    currentStep: string;
    validationRule: string;
    reason: string;
    missingField?: string | null;
    invalidValue?: unknown;
    salesforceObject?: string | null;
    productId?: string | null;
    productName?: string | null;
    pricebookEntryId?: string | null;
    sellingModel?: unknown;
    billingFrequency?: unknown;
    bundle?: unknown;
    attributes?: unknown;
    generatedPayload?: unknown;
    path?: string[] | null;
    code?: string | null;
    rollbackRecords?: { sobject: string; ids: string[] }[];
  }): Promise<LineItemCreationResult> {
    logStep(params.currentStep, "error", { validationRule: params.validationRule }, null, params.reason);
    errors.push({ message: params.reason, code: params.code ?? null, path: params.path ?? null });

    const rollback = await rollbackWithLog(params.rollbackRecords ?? []);

    const failureDetail: LineItemFailureDetail = {
      currentStep: params.currentStep,
      validationRule: params.validationRule,
      reason: params.reason,
      missingField: params.missingField ?? null,
      invalidValue: params.invalidValue ?? null,
      salesforceObject: params.salesforceObject ?? null,
      quoteId,
      productId: params.productId ?? null,
      productName: params.productName ?? null,
      pricebookEntryId: params.pricebookEntryId ?? null,
      sellingModel: params.sellingModel ?? null,
      billingFrequency: params.billingFrequency ?? null,
      bundle: params.bundle ?? null,
      attributes: params.attributes ?? null,
      relationshipFields: qlrSchemaRef,
      generatedPayload: params.generatedPayload ?? null,
      validationErrors: errors.map(e => e.message),
      rollback,
      lastSuccessfulStep,
    };

    return {
      success: false, createdIds: [], createdCount: 0, bundleHierarchyValid: false, pricingVerified: false,
      issues: [params.reason], steps, repricing: null, errors, refreshedLineItems: [], pricingTrace: [], failureDetail,
    };
  }

  // §Verify Quote Pricebook (fixes "The price book entry is in a different
  // price book than the one assigned to the Quote"): the `pricebookId`
  // this function received is whatever the CLIENT resolved (commonly a
  // separate, independent "Pricebook2 WHERE Name = ..." lookup made
  // client-side — see CreateQuoteFlow.tsx/QuoteWorkspace.tsx) — it is never
  // guaranteed to be the same Id Quote creation actually persisted onto
  // this Quote's own Pricebook2Id field. Every PricebookEntry lookup below
  // (fetchCatalogProductsByIds, bundle expansion) is scoped to whatever
  // `pricebookId` holds — if it doesn't match the Quote's real, persisted
  // price book, every PricebookEntry it resolves is correctly scoped to
  // the WRONG price book, and Salesforce rejects the QuoteLineItem create.
  // The Quote's own persisted Pricebook2Id is authoritative: re-read it
  // directly from Salesforce here, hard-stop if it was never actually
  // persisted, and correct `pricebookId` in place (loudly logged, never
  // silently) if the caller's value disagrees with it.
  logStep("Verify Quote Pricebook", "start", { quoteId, requestedPricebookId: pricebookId }, null, "Re-reading the Quote's own persisted Pricebook2Id directly from Salesforce, before trusting the pricebookId this request supplied.");
  const quoteFieldSchema = await resolveQuoteFieldSchema(client);
  if (!quoteFieldSchema.pricebookField) {
    return fail({
      currentStep: "Verify Quote Pricebook",
      validationRule: "Quote must have a resolvable Pricebook2 lookup field in this org",
      reason: `This org's Quote object has no createable/resolvable Pricebook2 lookup field — cannot verify which price book Quote ${quoteId} is actually assigned to before creating line items.`,
      missingField: "Pricebook2Id", salesforceObject: "Quote", code: "QUOTE_PRICEBOOK_FIELD_UNRESOLVED",
    });
  }
  const quoteRecord = await client.getRecord("Quote", quoteId);
  const persistedQuotePricebookId = (quoteRecord[quoteFieldSchema.pricebookField.apiName] as string | null | undefined) ?? null;
  console.log(`[QUOTE PRICEBOOK]\nquoteId: ${quoteId}\nquotePricebook2Id: ${persistedQuotePricebookId ?? "null"}`);
  if (!persistedQuotePricebookId) {
    return fail({
      currentStep: "Verify Quote Pricebook",
      validationRule: "Quote must have a persisted Pricebook2Id before line items can be created",
      reason: `Quote ${quoteId} has no Pricebook2Id persisted on the Salesforce record (field "${quoteFieldSchema.pricebookField.apiName}" is null/blank). Every PricebookEntry lookup below would therefore be scoped to the wrong (or no) price book. This means Quote creation never actually assigned a price book to this Quote — fix that at the root (lib/quotes/quote/payload.ts buildQuotePayload / app/api/quotes/route.ts), then re-create the Quote, before retrying line item creation.`,
      missingField: quoteFieldSchema.pricebookField.apiName, salesforceObject: "Quote", code: "QUOTE_PRICEBOOK_NOT_PERSISTED",
    });
  }
  if (persistedQuotePricebookId !== pricebookId) {
    logStep(
      "Verify Quote Pricebook", "info",
      { quoteId, requestedPricebookId: pricebookId, persistedQuotePricebookId },
      { quoteId, requestedPricebookId: pricebookId, persistedQuotePricebookId },
      `MISMATCH: this request's pricebookId (${pricebookId}) does not match the Pricebook2Id actually persisted on Quote ${quoteId} (${persistedQuotePricebookId}). This is very likely the cause of "The price book entry is in a different price book than the one assigned to the Quote." The Quote's own persisted Pricebook2Id is authoritative — using ${persistedQuotePricebookId} for every PricebookEntry lookup for the remainder of this request.`,
    );
    pricebookId = persistedQuotePricebookId;
  } else {
    logStep("Verify Quote Pricebook", "success", { quoteId, pricebookId }, { persistedQuotePricebookId }, `Confirmed: this request's pricebookId matches Quote ${quoteId}'s persisted Pricebook2Id (${persistedQuotePricebookId}).`);
  }

  logStep("Dependency Graph", "start", { draftRootCount: draftRoots.length }, null, "Flattening the draft forest into a dependency-ordered list.");
  const flatItems = flattenForestWithParentIndex(draftRoots);
  const dependencyGraph = flatItems.map(i => ({ index: i.index, product: i.draft.product.name, parentIndex: i.parentIndex, depth: i.path.length - 1 }));
  logStep("Dependency Graph", "success", { draftRootCount: draftRoots.length }, dependencyGraph, `${flatItems.length} line item(s) flattened; ${flatItems.filter(i => i.parentIndex === null).length} root (parent) line(s), ${flatItems.filter(i => i.parentIndex !== null).length} child line(s).`);
  // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
  // failures are confirmed resolved): the EXACT request payload this server
  // call received, per line, before any server-side re-resolution.
  for (const item of flatItems) {
    console.log(`[BILLING FREQUENCY LINE REQUEST] productId=${item.draft.productId} ("${item.draft.product.name}") sellingModelType=${item.draft.sellingModelType ?? "null"} parentIndex=${item.parentIndex ?? "root"} -> draft.billingFrequency=${item.draft.billingFrequency ?? "null"} source=${item.draft.billingFrequencySource ?? "null"}.`);
  }

  if (flatItems.length === 0) {
    return fail({ currentStep: "Dependency Graph", validationRule: "non-empty request", reason: "No line items to create.", missingField: "draftRoots" });
  }

  const distinctProductIds = uniqueProductIds(flatItems);

  logStep("Resolve Metadata", "start", { quoteId, pricebookId }, null, "Resolving QuoteLineItem/attribute schema and bundle object discovery via Describe.");
  const [qliSchema, qliAttrSchema, discovery] = await Promise.all([
    resolveQuoteLineItemFieldSchema(client),
    resolveQuoteLineItemAttributeFieldSchema(client),
    resolveBundleObjectDiscovery(client),
  ]);
  const qlrSchema = await resolveQuoteLineRelationshipSchema(client, discovery);
  qlrSchemaRef = qlrSchema;
  logStep("Resolve Metadata", "success", { quoteId, pricebookId }, { qliSchema, qliAttrSchema, discovery, qlrSchema }, `Pricing model: ${qliSchema.pricingModel}. Bundle mechanism: ${qlrSchema.mechanism}.`);

  // §Audit required QuoteLineItem fields (mirrors the pre-existing bundle-
  // relationship-object audit below): an org-specific required field this
  // app's curated payload builder doesn't know about would otherwise be
  // silently omitted from every create call — which can succeed at the raw
  // API layer while leaving Salesforce's own Revenue Cloud configuration/
  // pricing validation (e.g. native "Refresh Prices") unable to make sense
  // of the record. Resolved via real Describe-driven defaults only; never
  // fabricated — a field with no resolvable default hard-stops here with
  // the exact field name, instead of surfacing later as an opaque
  // Salesforce rejection or a QLI that native pricing can't process.
  let qliExtraFields: Record<string, unknown> = {};
  if (qliSchema.requiredFieldsNotMapped.length > 0) {
    logStep(
      "Audit Required QuoteLineItem Fields", "start", { fields: qliSchema.requiredFieldsNotMapped.map(f => f.apiName) }, null,
      `Resolving ${qliSchema.requiredFieldsNotMapped.length} required QuoteLineItem field(s) with no explicit mapping: ${qliSchema.requiredFieldsNotMapped.map(f => f.apiName).join(", ")}.`,
    );
    const audit = await resolveRequiredQuoteLineItemFields(client, qliSchema);
    if (!audit.success) {
      return fail({
        currentStep: "Audit Required QuoteLineItem Fields",
        validationRule: "every required+createable QuoteLineItem field must have a resolvable real value",
        reason: audit.error ?? "One or more required QuoteLineItem fields could not be resolved.",
        salesforceObject: "QuoteLineItem", generatedPayload: audit.resolutions, code: "QLI_REQUIRED_FIELD_UNRESOLVED",
      });
    }
    qliExtraFields = audit.extraFields;
    logStep(
      "Audit Required QuoteLineItem Fields", "success", { fields: qliSchema.requiredFieldsNotMapped.map(f => f.apiName) }, audit.resolutions,
      `Resolved ${Object.keys(qliExtraFields).length} required field(s): ${JSON.stringify(qliExtraFields)}.`,
    );
  }

  // Resolve Product + Resolve PricebookEntry — re-verify server-side, never trust the client's cached copy.
  logStep("Resolve Product", "start", { productIds: distinctProductIds, pricebookId }, null, "Re-fetching each distinct product from the price book.");
  const freshCatalog = await fetchCatalogProductsByIds(client, pricebookId, distinctProductIds);
  const productResolution = distinctProductIds.map(id => ({ productId: id, resolved: freshCatalog.has(id), pricebookEntryId: freshCatalog.get(id)?.pricebookEntryId ?? null }));
  const unresolvedProduct = productResolution.find(p => !p.resolved);
  if (unresolvedProduct) {
    return fail({
      currentStep: "Resolve Product", validationRule: "product must have an active PricebookEntry in this price book",
      reason: `Product ${unresolvedProduct.productId} could not be resolved against price book ${pricebookId}.`,
      productId: unresolvedProduct.productId, pricebookEntryId: null, missingField: "PricebookEntry", salesforceObject: "PricebookEntry",
    });
  }
  logStep("Resolve Product", "success", { productIds: distinctProductIds }, productResolution, `${freshCatalog.size} of ${distinctProductIds.length} product(s) resolved.`);

  // §PricebookEntry Resolution: the draft's PricebookEntryId is a
  // point-in-time snapshot captured whenever the product was configured —
  // it commonly goes stale by the time Create is clicked (an admin
  // deactivates/replaces the org's active PricebookEntry for this product
  // in the interim). Never trust it and never hard-fail on a mismatch —
  // silently re-resolve to whatever Salesforce reports as the CURRENT
  // active PricebookEntry for this exact Product2Id + the Quote's
  // Pricebook2Id (freshCatalog, queried immediately above, IS that lookup)
  // and correct every affected draft node (root, every bundle child) in
  // place before anything downstream (buildQLIPayload, relationship
  // payloads) ever reads pricebookEntryId — so the correction propagates
  // to every payload for free, with nothing left referencing the stale Id.
  logStep("Resolve PricebookEntry", "start", { pricebookId }, null, "Re-resolving each line's active PricebookEntry (and its current List Price) for this price book — never trusting the draft's stored value.");
  const pricebookEntryCorrections: { product: string; previous: string; resolved: string }[] = [];
  const listPriceCorrections: { product: string; previous: number; resolved: number }[] = [];
  for (const item of flatItems) {
    const fresh = freshCatalog.get(item.draft.productId);
    if (!fresh) {
      // Unreachable given the "Resolve Product" gate above already required
      // every distinct product to resolve — kept as a defensive hard stop,
      // since silently proceeding without ANY active PricebookEntry is
      // never acceptable (there is nothing to re-resolve to).
      return fail({
        currentStep: "Resolve PricebookEntry", validationRule: "product must have an active PricebookEntry in this price book",
        reason: `"${item.draft.product.name}" has no active PricebookEntry in price book ${pricebookId}.`,
        missingField: "PricebookEntryId", salesforceObject: "PricebookEntry",
        productId: item.draft.productId, productName: item.draft.product.name, path: item.path, code: "PRICEBOOK_ENTRY_UNRESOLVED",
      });
    }
    if (fresh.pricebookEntryId !== item.draft.product.pricebookEntryId) {
      pricebookEntryCorrections.push({ product: item.draft.product.name, previous: item.draft.product.pricebookEntryId, resolved: fresh.pricebookEntryId });
      item.draft.product = { ...item.draft.product, pricebookEntryId: fresh.pricebookEntryId };
    }
    // §The user's explicit "never $0" directive is only as authoritative as
    // the List Price it's computed from — re-resolve it from Salesforce
    // right before pricing, the same way pricebookEntryId already is,
    // rather than trusting a value captured whenever the product was added
    // to this session (which may have gone stale).
    if (fresh.listPrice !== item.draft.product.listPrice) {
      const previousListPrice = item.draft.product.listPrice;
      listPriceCorrections.push({ product: item.draft.product.name, previous: previousListPrice, resolved: fresh.listPrice });
      // draft.unitPrice defaults to the catalog List Price at Add-time but,
      // on a ManualPricing org, may since have been deliberately edited by
      // the user via the visible "Unit $" field — only correct it in
      // lockstep with the freshly-resolved List Price when it still equals
      // the STALE list price (i.e. it was never manually touched); a real
      // manual edit must never be silently discarded by this correction.
      const unitPriceWasUntouched = item.draft.unitPrice === previousListPrice;
      item.draft.product = { ...item.draft.product, listPrice: fresh.listPrice };
      if (unitPriceWasUntouched) item.draft.unitPrice = fresh.listPrice;
    }
  }
  logStep(
    "Resolve PricebookEntry", "success", { pricebookId },
    { corrections: pricebookEntryCorrections, listPriceCorrections, final: flatItems.map(i => ({ product: i.draft.product.name, pricebookEntryId: i.draft.product.pricebookEntryId, listPrice: i.draft.product.listPrice })) },
    [
      pricebookEntryCorrections.length > 0
        ? `Re-resolved ${pricebookEntryCorrections.length} stale PricebookEntry Id(s): ${pricebookEntryCorrections.map(c => `"${c.product}" ${c.previous} → ${c.resolved}`).join("; ")}.`
        : "Every draft PricebookEntry Id already matches the currently active entry.",
      listPriceCorrections.length > 0
        ? `Re-resolved ${listPriceCorrections.length} stale List Price(s): ${listPriceCorrections.map(c => `"${c.product}" ${c.previous} → ${c.resolved}`).join("; ")}.`
        : "Every draft List Price already matches the current PricebookEntry.",
    ].join(" "),
  );

  // Resolve Selling Model + Resolve Billing Frequency.
  // Scope resolution to the SPECIFIC PricebookEntry each line is using —
  // a product can have multiple PricebookEntries (one per selling model,
  // e.g. "One-Time" vs "Annual"), so resolving from Product2Id alone can
  // silently pick the wrong selling model when more than one exists.
  const pricebookEntryByProductId = new Map(flatItems.map(i => [i.draft.productId, i.draft.product.pricebookEntryId]));
  logStep("Resolve Selling Model", "start", { productIds: distinctProductIds, pricebookEntryByProductId: Object.fromEntries(pricebookEntryByProductId) }, null, "Re-resolving selling model options for each product, preferring the selling model each line's PricebookEntry is linked to.");
  const sellingModels = await resolveSellingModelsBatch(client, distinctProductIds, pricebookEntryByProductId);
  logStep(
    "Resolve Selling Model", "success", { productIds: distinctProductIds },
    Object.fromEntries([...sellingModels].map(([id, r]) => [id, {
      chosen: r.chosen ? { name: r.chosen.name, type: r.chosen.type, requiresBillingFrequency: r.chosen.requiresBillingFrequency, isDefault: r.chosen.isDefault, isActive: r.chosen.isActive } : null,
      chosenReason: r.chosenReason,
      pricebookEntrySellingModelId: r.pricebookEntrySellingModelId,
      allOptions: r.options.map(o => ({ name: o.name, type: o.type, isDefault: o.isDefault, isActive: o.isActive, requiresBillingFrequency: o.requiresBillingFrequency })),
    }])),
    `Resolved selling models for ${sellingModels.size} product(s).`,
  );

  // §Do Not Re-Resolve During Create: Billing Frequency is resolved EXACTLY
  // ONCE, when the product is configured (client-side product-configure call
  // / bundle expansion) — the draft Quote Line Item is the single source of
  // truth. This step VALIDATES that configuration, it does not rediscover
  // it. Two checks: (1) a value exists whenever the Selling Model Type
  // requires one, (2) that value is one of the field's real active picklist
  // values right now (Salesforce could have deactivated it since the draft
  // was configured). Failing either stops before Salesforce, naming exactly
  // which line/field/value is at fault.
  logStep("Resolve Billing Frequency", "start", null, null, "Validating that Billing Frequency is already configured on the draft for every line whose Selling Model Type is Evergreen or Term-Defined (resolution happens once, at product-configuration time).");

  let billingFrequencyActiveValues: string[] | null = null;
  if (qliSchema.billingFrequencyField) {
    try {
      const qliDescribe = await describeObjectCached(client, "QuoteLineItem");
      const picklist = findPicklistFieldByLabel(qliDescribe, "BillingFrequency", /^billing frequency$/i);
      billingFrequencyActiveValues = picklist ? picklist.activeOptions.map(o => o.value) : null;
    } catch {
      billingFrequencyActiveValues = null;
    }
  }

  const billingFrequencyValidation: Record<string, unknown> = {};
  for (const item of flatItems) {
    const sm = sellingModels.get(item.draft.productId);
    // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
    // failures are confirmed resolved): the final decision inputs for this
    // line, at the exact point Resolve Billing Frequency evaluates it.
    console.log(`[BILLING FREQUENCY FINAL] productId=${item.draft.productId} ("${item.draft.product.name}") sellingModelType=${sm?.chosen?.type ?? "null"} requiresBillingFrequency=${!!sm?.chosen?.requiresBillingFrequency} chosenReason=${sm?.chosenReason ?? "null"} -> draft.billingFrequency=${item.draft.billingFrequency ?? "null"} source=${item.draft.billingFrequencySource ?? "null"}.`);
    if (!sm?.chosen?.requiresBillingFrequency) {
      // Log every line, even ones we determined don't need billing frequency —
      // never let "success" mean "silently skipped" (§Issue: log incorrectly marked Success).
      // Three genuinely different cases, logged distinctly so a wrong
      // determination is visible without expanding a separate log entry:
      const skipReason = !sm
        ? "No SellingModelResolution entry at all for this product (unexpected — check distinctProductIds)."
        : sm.options.length === 0
          ? "resolveSellingModelsForProducts found ZERO ProductSellingModelOption rows for this product — either it genuinely has none, or the query/relationship-name resolution silently failed."
          : !sm.chosen
            ? `${sm.options.length} option(s) found but none could be chosen (chosenReason: ${sm.chosenReason}).`
            : `Chosen option "${sm.chosen.name}" classified as ${sm.chosen.type} (isDefault=${sm.chosen.isDefault}, isActive=${sm.chosen.isActive}, chosenReason=${sm.chosenReason}) — not Evergreen/Term-Defined, so no billing frequency required.`;
      billingFrequencyValidation[item.draft.product.name] = {
        skipped: true,
        reason: skipReason,
        allOptionsFound: sm?.options.map(o => ({ name: o.name, type: o.type, isDefault: o.isDefault, isActive: o.isActive })) ?? [],
        pricebookEntrySellingModelId: sm?.pricebookEntrySellingModelId ?? null,
      };
      continue;
    }

    if (!item.draft.billingFrequency) {
      // §Selling Model reclassification (mirrors lib/orders/server/orderItemCreate.ts):
      // the draft's cached sellingModelType disagreeing with the freshly
      // re-resolved type means this product's Selling Model configuration is
      // genuinely ambiguous in the org — name that explicitly rather than a
      // bare "no Billing Frequency" message.
      const reclassified = !!item.draft.sellingModelType && item.draft.sellingModelType !== sm.chosen.type;
      // §Diagnose, don't just report (mirrors lib/orders/server/orderItemCreate.ts):
      // re-run resolveBillingFrequency() purely for diagnostics (read-only,
      // never written to the draft) so the failure detail's "Billing
      // Frequency" panel shows the actual step-by-step trace instead of
      // nothing.
      const diagnosticResolution = await resolveBillingFrequency(
        client, item.draft.productId, sm.chosen.sellingModelId, sm.chosen.name, "QuoteLineItem",
      );
      return fail({
        currentStep: "Resolve Billing Frequency",
        validationRule: "the draft Quote Line Item for a Selling Model Type of Evergreen or Term-Defined must already carry a configured Billing Frequency",
        reason: reclassified
          ? `"${item.draft.product.name}" was added to this Quote as Selling Model Type "${item.draft.sellingModelType}" (no Billing Frequency required at that time), but now re-resolves to "${sm.chosen.type}" (chosenReason: ${sm.chosenReason}), which requires one. This product has an ambiguous Selling Model configuration in this org — remove it and add it again to re-resolve Billing Frequency, or ask an admin to flag a single Selling Model Option as both Default and Active for this product.`
          : `"${item.draft.product.name}" (Selling Model Type: ${sm.chosen.type}) reached line-item creation with no Billing Frequency on its draft. Product configuration (POST /api/quotes/products/configure, or bundle expansion for a component) is the ONLY place this is resolved — it was never set there, or was lost before this request was sent.`,
        missingField: "BillingFrequency", invalidValue: null, salesforceObject: "QuoteLineItem",
        productId: item.draft.productId, productName: item.draft.product.name, sellingModel: sm,
        billingFrequency: diagnosticResolution,
        path: item.path, code: reclassified ? "SELLING_MODEL_RECLASSIFIED" : "DRAFT_NOT_CONFIGURED",
      });
    }

    if (billingFrequencyActiveValues && !billingFrequencyActiveValues.includes(item.draft.billingFrequency)) {
      return fail({
        currentStep: "Resolve Billing Frequency",
        validationRule: "Billing Frequency must be one of the field's currently active picklist values",
        reason: `"${item.draft.product.name}" has Billing Frequency "${item.draft.billingFrequency}" on its draft, which is not among the currently active values Salesforce allows (${billingFrequencyActiveValues.join(", ")}).`,
        missingField: null, invalidValue: item.draft.billingFrequency, salesforceObject: "QuoteLineItem",
        productId: item.draft.productId, productName: item.draft.product.name, sellingModel: sm,
        path: item.path, code: "BILLING_FREQUENCY_INVALID_VALUE",
      });
    }

    billingFrequencyValidation[item.draft.product.name] = {
      value: item.draft.billingFrequency,
      source: item.draft.billingFrequencySource ?? "unknown",
      validActivePicklistValue: true,
    };
  }
  logStep("Resolve Billing Frequency", "success", null, billingFrequencyValidation, `Billing Frequency validated as already configured for every line that requires one (${Object.keys(billingFrequencyValidation).length} product(s)).`);

  // Resolve Attributes.
  logStep("Resolve Attributes", "start", { productIds: distinctProductIds }, null, "Re-fetching required product attributes.");
  const attributesByProduct = await resolveProductAttributesBatch(client, distinctProductIds);
  for (const item of flatItems) {
    const attrs = attributesByProduct.get(item.draft.productId) ?? [];
    for (const attr of attrs) {
      if (attr.required && (item.draft.attributeValues[attr.attributeId] == null || item.draft.attributeValues[attr.attributeId] === "")) {
        return fail({
          currentStep: "Resolve Attributes",
          validationRule: "required product attributes must have a value",
          reason: `"${item.draft.product.name}": required attribute "${attr.name}" is not set.`,
          missingField: attr.name, invalidValue: item.draft.attributeValues[attr.attributeId] ?? null, salesforceObject: "QuoteLineItemAttribute",
          productId: item.draft.productId, productName: item.draft.product.name, attributes: attrs,
          path: item.path, code: "ATTRIBUTE_REQUIRED",
        });
      }
    }
  }
  logStep("Resolve Attributes", "success", { productIds: distinctProductIds }, Object.fromEntries(attributesByProduct), "All required attributes are set.");

  // Resolve Bundle Structure + Resolve Bundle Groups.
  logStep("Resolve Bundle Structure", "start", { productIds: distinctProductIds }, null, "Re-expanding bundle structure for every bundle-parent line.");
  const bundleInfoCache = new Map<string, DraftValidationProductInfo | null>();
  const bundleExpansions: Record<string, unknown> = {};
  const resolveInfo = (productId: string): DraftValidationProductInfo | null => bundleInfoCache.get(productId) ?? null;
  for (const productId of distinctProductIds) {
    const node = findNode(draftRoots, productId);
    if (!node?.isBundleParent) continue;
    try {
      const expansion = await expandBundle(client, discovery, productId, pricebookId);
      bundleExpansions[productId] = { groups: expansion.groups, componentCount: expansion.components.length };
      bundleInfoCache.set(productId, {
        attributes: attributesByProduct.get(productId) ?? [],
        requiresBillingFrequency: !!sellingModels.get(productId)?.chosen?.requiresBillingFrequency,
        groups: expansion.groups,
        candidates: expansion.components,
      });
    } catch (err) {
      bundleExpansions[productId] = { error: err instanceof Error ? err.message : "expansion failed" };
      bundleInfoCache.set(productId, null);
    }
  }
  for (const productId of distinctProductIds) {
    if (bundleInfoCache.has(productId)) continue;
    bundleInfoCache.set(productId, {
      attributes: attributesByProduct.get(productId) ?? [],
      requiresBillingFrequency: !!sellingModels.get(productId)?.chosen?.requiresBillingFrequency,
      groups: [],
      candidates: [],
    });
  }
  logStep("Resolve Bundle Structure", "success", { productIds: distinctProductIds }, bundleExpansions, `Expanded bundle structure for ${Object.keys(bundleExpansions).length} bundle-parent product(s).`);

  logStep("Resolve Bundle Groups", "start", null, null, "Validating the draft tree against Salesforce's confirmed component-group minimums.");
  const treeValidation = validateDraftForest(draftRoots, resolveInfo);
  if (!treeValidation.valid) {
    const firstIssue = treeValidation.unresolvedNodes[0];
    for (const node of treeValidation.unresolvedNodes) errors.push({ message: node.message, code: "BUNDLE_VALIDATION", path: node.path });
    return fail({
      currentStep: "Resolve Bundle Groups",
      validationRule: "each component group's selection count must meet Salesforce's confirmed minimum",
      reason: firstIssue?.message ?? "Bundle component group validation failed.",
      salesforceObject: "ProductComponentGroup", bundle: treeValidation, path: firstIssue?.path ?? null, code: "BUNDLE_VALIDATION",
    });
  }
  logStep("Resolve Bundle Groups", "success", null, treeValidation, "Every component group meets its confirmed minimum.");

  // Resolve Billing Treatment.
  logStep("Resolve Billing Treatment", "start", { productIds: distinctProductIds }, null, "Re-validating billing treatment for every product requiring a billing frequency.");
  const billingTreatments: Record<string, unknown> = {};
  for (const productId of distinctProductIds) {
    if (!sellingModels.get(productId)?.chosen?.requiresBillingFrequency) continue;
    const validation = await validateBillingTreatment(client, productId);
    billingTreatments[productId] = validation;
    if (validation.blocks) {
      const node = findNode(draftRoots, productId);
      return fail({
        currentStep: "Resolve Billing Treatment",
        validationRule: `billing treatment outcome must not be "${validation.outcome}"`,
        reason: validation.message ?? "Billing treatment configuration is invalid for this product.",
        salesforceObject: "BillingTreatment", productId, productName: node?.product.name ?? null,
        invalidValue: validation.outcome, code: `BILLING_TREATMENT_${validation.outcome.toUpperCase()}`,
      });
    }
  }
  logStep("Resolve Billing Treatment", "success", { productIds: distinctProductIds }, billingTreatments, "Billing treatment verified for every product that requires it.");

  // Resolve Relationship Fields (native bundle capability).
  const hasBundleStructure = flatItems.some(i => i.parentIndex !== null);
  logStep("Resolve Relationship Fields", "start", { hasBundleStructure }, null, "Determining the org's native QuoteLineItem bundle-relationship mechanism.");
  if (hasBundleStructure && qlrSchema.mechanism === "unsupported") {
    return fail({
      currentStep: "Resolve Relationship Fields",
      validationRule: "a native bundle-relationship mechanism must exist when the request has bundle structure",
      reason: "This org has no native mechanism to represent QuoteLineItem bundle relationships (no QuoteLineRelationship-shaped object and no QuoteLineItem self-reference fields).",
      salesforceObject: "QuoteLineRelationship", missingField: "mainQuoteLineField/associatedQuoteLineField or a self-reference field pair",
      code: "BUNDLE_NOT_SUPPORTED",
    });
  }
  logStep("Resolve Relationship Fields", "success", { hasBundleStructure }, qlrSchema, `Bundle hierarchy mechanism: ${qlrSchema.mechanism}.`);

  // §Validate Bundle Relationship Edges (§Issue 1B, fail before mutate): verify
  // every bundle edge's candidate relationship-component Id genuinely belongs
  // to the resolved relationship object BEFORE any QuoteLineItem is created —
  // never discover an invalid ProductRelatedComponentId only after QLIs
  // already exist and need rolling back.
  if (hasBundleStructure) {
    const edgeCount = flatItems.filter(i => i.parentIndex !== null).length;
    logStep(
      "Validate Bundle Relationship Edges", "start", { edgeCount },
      null,
      `Verifying every bundle edge's candidate relationship-component Id against ${discovery.relationshipObject ?? "(no relationship object discovered)"}, before creating any QuoteLineItem.`,
    );
    const edgeValidation = await validateBundleRelationshipEdges(client, flatItems, qlrSchema, discovery.relationshipObject);
    if (!edgeValidation.valid) {
      return fail({
        currentStep: "Validate Bundle Relationship Edges",
        validationRule: "every bundle edge's relationship-component Id must belong to the object the resolved relationship field actually references",
        reason: edgeValidation.error ?? "One or more bundle edges could not be resolved.",
        salesforceObject: discovery.relationshipObject ?? qlrSchema.objectName,
        bundle: edgeValidation.invalidEdges,
        code: "BUNDLE_RELATIONSHIP_ID_UNRESOLVED",
      });
    }
    logStep(
      "Validate Bundle Relationship Edges", "success", { edgeCount },
      { checkedCandidateIds: [...new Set(flatItems.filter(i => i.parentIndex !== null).map(i => i.draft.relatedComponentId).filter(Boolean))] },
      `Every bundle edge's candidate relationship-component Id was verified to exist on ${discovery.relationshipObject ?? "the expected object"}.`,
    );
  }

  // §Verify Draft: print the complete configured draft for every line,
  // immediately before it is handed to the payload builder — the draft is
  // the single source of truth from here on; nothing below re-derives it.
  logStep(
    "Verify Draft", "info", null,
    flatItems.map(i => ({
      product: i.draft.product.name,
      productId: i.draft.productId,
      pricebookEntryId: i.draft.product.pricebookEntryId,
      sellingModelOptionId: i.draft.sellingModelOptionId,
      sellingModelName: i.draft.sellingModelName,
      sellingModelType: i.draft.sellingModelType,
      billingFrequency: i.draft.billingFrequency,
      billingFrequencySource: i.draft.billingFrequencySource,
      billingTreatmentOutcome: i.draft.billingTreatmentOutcome,
      subscriptionTerm: i.draft.subscriptionTerm,
      attributeValues: i.draft.attributeValues,
      isBundleParent: i.draft.isBundleParent,
      parentDraftId: i.draft.parentDraftId,
    })),
    `Complete configured draft for ${flatItems.length} line item(s), printed before payload generation.`,
  );

  // Build Payload + Validate Payload.
  logStep("Build Payload", "start", { itemCount: flatItems.length }, null, "Building the QuoteLineItem create payload for every line via buildQLIPayload() — the one and only serializer.");
  const builtPayloads = flatItems.map(item => ({ item, payload: { ...qliExtraFields, ...buildQLIPayload(item, quoteId, qliSchema, null, null) } }));

  // §Sales Price double-discount investigation (Phase 3): print, per line,
  // exactly what is about to be sent as the Sales Price input vs. the
  // Discount input, immediately before anything is serialized further —
  // proof that Sales Price is the raw PricebookEntry price, never a
  // pre-discounted value, at the moment this app hands off to Salesforce.
  const buildPayloadInitialPricingField = resolveInitialPricingField(qliSchema);
  const qliPricingInputLog = flatItems.map(item => {
    const payload = builtPayloads.find(b => b.item === item)?.payload ?? {};
    const salesPriceField = buildPayloadInitialPricingField.apiName;
    const discountField = qliSchema.discountField?.apiName ?? null;
    const row = {
      productName: item.draft.product.name,
      productId: item.draft.productId,
      pricebookEntryId: item.draft.product.pricebookEntryId,
      pbeUnitPrice: item.draft.product.listPrice,
      salesPriceField,
      salesPriceSent: salesPriceField ? (payload[salesPriceField] as number | undefined) ?? null : null,
      discountField,
      discountSent: discountField ? (payload[discountField] as number | undefined) ?? null : null,
      quantity: item.draft.quantity,
    };
    console.log(
      `[QLI PRICING INPUT]\nproductName: ${row.productName}\nproductId: ${row.productId}\npricebookEntryId: ${row.pricebookEntryId}\n` +
      `pbeUnitPrice: ${row.pbeUnitPrice}\nsalesPriceField: ${row.salesPriceField ?? "none"}\nsalesPriceSent: ${row.salesPriceSent ?? "none"}\n` +
      `discountField: ${row.discountField ?? "none"}\ndiscountSent: ${row.discountSent ?? "none"}\nquantity: ${row.quantity}`,
    );
    return row;
  });
  logStep(
    "Build Payload", "info", null, qliPricingInputLog,
    `Sales Price / Discount input about to be sent for ${qliPricingInputLog.length} line(s) — Sales Price must equal the PricebookEntry's raw list price, never a pre-discounted value.`,
  );

  // §Verify Payload: assert every configured draft value survived
  // serialization. Any mismatch means buildQLIPayload() itself dropped it —
  // name it explicitly rather than letting Salesforce discover it first.
  const equalityChecks = builtPayloads.map(({ item, payload }) => {
    const sellingModelField = qliSchema.sellingModelOptionField?.apiName ?? null;
    const billingFrequencyFieldName = qliSchema.billingFrequencyField?.apiName ?? null;
    const draftBillingFrequency = item.draft.billingFrequency;
    const payloadBillingFrequency = billingFrequencyFieldName ? (payload[billingFrequencyFieldName] as string | undefined) ?? null : null;
    const draftSellingModel = item.draft.sellingModelOptionId;
    const payloadSellingModel = sellingModelField ? (payload[sellingModelField] as string | undefined) ?? null : null;
    return {
      product: item.draft.product.name,
      billingFrequency: { draft: draftBillingFrequency, payload: payloadBillingFrequency, match: draftBillingFrequency === payloadBillingFrequency },
      sellingModel: { draft: draftSellingModel, payload: payloadSellingModel, match: draftSellingModel === payloadSellingModel },
      billingTreatment: { draft: item.draft.billingTreatmentOutcome, note: "QuoteLineItem has no direct BillingTreatment field to serialize — validated as an outcome (Resolve Billing Treatment step), not copied into the payload." },
    };
  });
  logStep("Build Payload", "success", { itemCount: flatItems.length }, { payloads: builtPayloads.map(b => b.payload), equalityChecks }, `${builtPayloads.length} payload(s) generated via buildQLIPayload().`);

  const droppedBillingFrequency = equalityChecks.find(c => c.billingFrequency.draft && !c.billingFrequency.match);
  if (droppedBillingFrequency) {
    return fail({
      currentStep: "Build Payload",
      validationRule: "buildQLIPayload() must copy draft.billingFrequency into the payload unchanged",
      reason: `"${droppedBillingFrequency.product}" draft.billingFrequency = ${JSON.stringify(droppedBillingFrequency.billingFrequency.draft)}, but the payload generated by buildQLIPayload() has ${JSON.stringify(droppedBillingFrequency.billingFrequency.payload)} — the serializer dropped a configured value. This is a bug in buildQLIPayload (lib/quotes/bundles/relationshipCreate.ts), not a resolution failure.`,
      missingField: "BillingFrequency", invalidValue: droppedBillingFrequency.billingFrequency.payload,
      salesforceObject: "QuoteLineItem", code: "SERIALIZER_DROPPED_BILLING_FREQUENCY",
    });
  }

  logStep("Validate Payload", "start", null, null, "Integrity-checking every generated payload before any write.");
  for (const { item, payload } of builtPayloads) {
    const missing = integrityCheckPayload(payload, qliSchema);
    if (missing.length > 0) {
      return fail({
        currentStep: "Validate Payload",
        validationRule: "payload must include Quote/PricebookEntry reference and a positive Quantity",
        reason: `"${item.draft.product.name}" payload is missing: ${missing.join(", ")}.`,
        missingField: missing.join(", "), salesforceObject: "QuoteLineItem", generatedPayload: payload,
        productId: item.draft.productId, productName: item.draft.product.name, path: item.path, code: "PAYLOAD_INTEGRITY",
      });
    }

    // Defense in depth (§Payload Builder audit): the payload must NEVER
    // silently omit BillingFrequency for a line whose resolved Selling
    // Model Type is Evergreen/Term-Defined, no matter what happened
    // upstream. This is the last checkpoint before Salesforce.
    const sm = sellingModels.get(item.draft.productId);
    if (sm?.chosen?.requiresBillingFrequency) {
      const fieldApiName = qliSchema.billingFrequencyField?.apiName ?? null;
      const payloadValue = fieldApiName ? payload[fieldApiName] : undefined;
      if (!fieldApiName || !payloadValue) {
        return fail({
          currentStep: "Validate Payload",
          validationRule: "a payload for a Selling Model Type of Evergreen or Term-Defined must contain a non-null BillingFrequency",
          reason: `"${item.draft.product.name}" (Selling Model Type: ${sm.chosen.type}) has draft.billingFrequency = ${JSON.stringify(item.draft.billingFrequency)}, but the generated payload does not carry it — ${fieldApiName ? `key "${fieldApiName}" is missing/falsy in the payload` : "no BillingFrequency field was resolved on QuoteLineItem at all"}.`,
          missingField: fieldApiName ?? "BillingFrequency", invalidValue: item.draft.billingFrequency, salesforceObject: "QuoteLineItem",
          generatedPayload: payload, productId: item.draft.productId, productName: item.draft.product.name,
          sellingModel: sm, path: item.path, code: "PAYLOAD_BILLING_FREQUENCY_OMITTED",
        });
      }
    }
  }
  logStep("Validate Payload", "success", null, builtPayloads.map(b => b.payload), "All payloads passed integrity checks, including the Billing Frequency payload-presence assertion.");

  // §Verify Billing Treatment: print the complete resolved Billing
  // Policy/Treatment/Selling Model/BillingFrequency context for every line,
  // immediately before the QuoteLineItem create call — exactly what's
  // needed to diagnose a Salesforce rejection without re-deriving it from
  // scratch. Then, wherever the resolved Billing Treatment explicitly says
  // CanChangeBillingFrequency = false, cross-check that the value about to
  // be sent actually matches the Selling Model's own resolved cadence
  // (never trust the draft's value blindly here either) — a mismatch is
  // exactly what produces Salesforce's "Add a Billing Treatment to make
  // sure that you can change the Billing Frequency..." rejection, and this
  // catches it locally with a specific diagnosis instead of a bare
  // Salesforce error.
  logStep(
    "Verify Billing Treatment", "info", null,
    await Promise.all(flatItems.map(async item => {
      const sm = sellingModels.get(item.draft.productId);
      const bt = billingTreatments[item.draft.productId] as BillingTreatmentValidation | undefined;
      return {
        product: item.draft.product.name,
        billingPolicyId: bt?.billingPolicyId ?? null,
        billingPolicyName: bt?.billingPolicyName ?? null,
        billingTreatmentId: bt?.billingTreatmentId ?? null,
        billingTreatmentName: bt?.billingTreatmentName ?? null,
        canChangeBillingFrequency: bt?.canChangeBillingFrequency ?? null,
        sellingModelId: sm?.chosen?.sellingModelId ?? null,
        sellingModelName: sm?.chosen?.name ?? null,
        sellingModelType: sm?.chosen?.type ?? null,
        billingFrequency: item.draft.billingFrequency,
        billingFrequencySource: item.draft.billingFrequencySource,
        payload: builtPayloads.find(b => b.item === item)?.payload ?? null,
      };
    })),
    "Complete Billing Policy/Treatment/Selling Model/BillingFrequency context for every line, immediately before the QuoteLineItem create call.",
  );

  for (const item of flatItems) {
    const sm = sellingModels.get(item.draft.productId);
    if (!sm?.chosen?.requiresBillingFrequency) continue;
    const bt = billingTreatments[item.draft.productId] as BillingTreatmentValidation | undefined;
    if (bt?.canChangeBillingFrequency !== false) continue; // true or unresolved (null) — nothing this app can positively enforce

    const natural = await resolveBillingFrequency(client, item.draft.productId, sm.chosen.sellingModelId, sm.chosen.name, "QuoteLineItem");
    if (natural.value && natural.value !== item.draft.billingFrequency) {
      return fail({
        currentStep: "Verify Billing Treatment",
        validationRule: "when Billing Treatment.CanChangeBillingFrequency is false, the payload's BillingFrequency must match the Selling Model's own resolved value",
        reason: `"${item.draft.product.name}" (Selling Model: "${sm.chosen.name}") has draft.billingFrequency = "${item.draft.billingFrequency}" (source: ${item.draft.billingFrequencySource ?? "unknown"}), but Billing Treatment "${bt?.billingTreatmentName ?? bt?.billingTreatmentId}" does not allow changing Billing Frequency (CanChangeBillingFrequency = false), and the Selling Model's own resolved value is "${natural.value}". Salesforce will reject this mismatch with "Add a Billing Treatment to make sure that you can change the Billing Frequency of its related Quote Line Item." — use "${natural.value}" for this line instead.`,
        missingField: null, invalidValue: item.draft.billingFrequency, salesforceObject: "BillingTreatment",
        productId: item.draft.productId, productName: item.draft.product.name,
        sellingModel: sm, billingFrequency: { draftValue: item.draft.billingFrequency, naturalValue: natural.value, canChangeBillingFrequency: bt?.canChangeBillingFrequency ?? null },
        path: item.path, code: "BILLING_FREQUENCY_NOT_CHANGEABLE",
      });
    }
  }

  // §Verify PricebookEntry Integrity (Phase 4 pre-send guard): immediately
  // before any QuoteLineItem is created, independently re-query every
  // distinct PricebookEntryId about to be sent straight from Salesforce and
  // assert its OWN persisted Pricebook2Id equals the Quote's persisted
  // Pricebook2Id verified above. "Resolve PricebookEntry" already only ever
  // populates pricebookEntryId from a query scoped to this same
  // (now-authoritative) pricebookId, so this should always match by
  // construction — this is a final, independent assertion so a mismatch is
  // caught here, with full diagnostics, rather than surfacing only as
  // Salesforce's opaque create-time rejection.
  logStep("Verify PricebookEntry Integrity", "start", { pricebookId }, null, "Re-querying every PricebookEntry about to be sent directly from Salesforce and asserting its Pricebook2Id matches the Quote's persisted Pricebook2Id, before any QuoteLineItem create.");
  const distinctPbeIds = [...new Set(flatItems.map(i => i.draft.product.pricebookEntryId).filter(Boolean))];
  let pbeIntegrityRows: { Id: string; Product2Id: string; Product2: { Name: string } | null; Pricebook2Id: string; Pricebook2: { Name: string } | null; UnitPrice: number; IsActive: boolean }[] = [];
  if (distinctPbeIds.length > 0) {
    const idList = distinctPbeIds.map(id => `'${soqlEscape(id)}'`).join(",");
    const pbeRes = await client.query<typeof pbeIntegrityRows[number]>(
      `SELECT Id, Product2Id, Product2.Name, Pricebook2Id, Pricebook2.Name, UnitPrice, IsActive FROM PricebookEntry WHERE Id IN (${idList})`,
    );
    pbeIntegrityRows = pbeRes.records;
  }
  const pbeById = new Map(pbeIntegrityRows.map(r => [r.Id, r]));
  const integrityReport = flatItems.map(item => {
    const pbe = pbeById.get(item.draft.product.pricebookEntryId);
    const match = !!pbe && pbe.Pricebook2Id === pricebookId;
    console.log(
      `[QLI PRICEBOOK INTEGRITY]\nproduct: ${item.draft.product.name}\nproductId: ${item.draft.productId}\nquoteId: ${quoteId}\n` +
      `quotePricebook2Id: ${pricebookId}\npricebookEntryId: ${item.draft.product.pricebookEntryId}\n` +
      `pbePricebook2Id: ${pbe?.Pricebook2Id ?? "not found"}\npbePrice: ${pbe?.UnitPrice ?? "not found"}\nmatch: ${match ? "YES" : "NO"}`,
    );
    return {
      product: item.draft.product.name, productId: item.draft.productId,
      pricebookEntryId: item.draft.product.pricebookEntryId,
      pbePricebook2Id: pbe?.Pricebook2Id ?? null, pbePricebook2Name: pbe?.Pricebook2?.Name ?? null,
      pbePrice: pbe?.UnitPrice ?? null, pbeActive: pbe?.IsActive ?? null, match,
    };
  });
  const mismatch = integrityReport.find(r => !r.match);
  if (mismatch) {
    return fail({
      currentStep: "Verify PricebookEntry Integrity",
      validationRule: "resolvedPBE.Pricebook2Id must equal the Quote's persisted Pricebook2Id for every line, before any QuoteLineItem create is attempted",
      reason: `"${mismatch.product}" would be sent to Salesforce with PricebookEntryId ${mismatch.pricebookEntryId}, whose own Pricebook2Id (${mismatch.pbePricebook2Id ?? "not found"}${mismatch.pbePricebook2Name ? ` / "${mismatch.pbePricebook2Name}"` : ""}) does not match Quote ${quoteId}'s persisted Pricebook2Id (${pricebookId}). Aborted before any Salesforce write — this is exactly the condition that produces "The price book entry is in a different price book than the one assigned to the Quote."`,
      missingField: null, invalidValue: mismatch.pricebookEntryId, salesforceObject: "PricebookEntry",
      productId: mismatch.productId, productName: mismatch.product, pricebookEntryId: mismatch.pricebookEntryId,
      generatedPayload: integrityReport, code: "PRICEBOOK_ENTRY_MISMATCH",
    });
  }
  logStep("Verify PricebookEntry Integrity", "success", { pricebookId }, integrityReport, `Verified ${integrityReport.length} line(s): every PricebookEntry's own persisted Pricebook2Id matches Quote ${quoteId}'s persisted Pricebook2Id (${pricebookId}).`);

  // Create Parent Lines + Create Child Lines (dependency-ordered passes).
  logStep("Create Parent Lines", "start", { rootCount: flatItems.filter(i => i.parentIndex === null).length }, null, "Creating line items in dependency order (parents first, then children).");
  const creation = await createInDependencyOrderedPasses(client, flatItems, quoteId, qliSchema, s => steps.push(s), qliExtraFields);
  if (!creation.success) {
    const failedItem = creation.failedIndex != null ? flatItems[creation.failedIndex] : null;
    const failedSellingModel = failedItem ? sellingModels.get(failedItem.draft.productId) ?? null : null;
    const errorMessage = creation.error ?? "Failed to create line items.";

    // Salesforce's own validation just told us, authoritatively, that this
    // Selling Model Type IS Evergreen/Term-Defined — if our own resolution
    // (logged above in "Resolve Selling Model"/"Resolve Billing Frequency")
    // disagreed, THIS is the proof of the mismatch, not a new failure mode.
    const isEvergreenTermRejection = /SellingModelType is Evergreen or Term-Defined.*BillingFrequency/i.test(errorMessage);
    const reason = isEvergreenTermRejection
      ? `Salesforce rejected "${failedItem?.draft.product.name}" with: "${errorMessage}". This means Salesforce's own authoritative record for this product's Selling Model has SellingModelType = Evergreen or Term-Defined, but THIS APP resolved it differently (see "sellingModel" below — chosen.requiresBillingFrequency was ${failedSellingModel?.chosen?.requiresBillingFrequency ?? "unresolved (no chosen option at all)"}). The mismatch is in selling-model resolution (lib/quotes/catalog/sellingModel.ts), not in payload construction — this app's classification of this specific product's selling model disagrees with Salesforce's own answer.`
      : errorMessage;

    return fail({
      currentStep: failedItem?.parentIndex != null ? "Create Child Lines" : "Create Parent Lines",
      validationRule: "Salesforce must accept the QuoteLineItem create call",
      reason,
      salesforceObject: "QuoteLineItem",
      generatedPayload: creation.failedIndex != null ? builtPayloads[creation.failedIndex]?.payload : builtPayloads.map(b => b.payload),
      productId: failedItem?.draft.productId ?? null,
      productName: failedItem?.draft.product.name ?? null,
      sellingModel: failedSellingModel,
      billingFrequency: failedItem ? { draftValue: failedItem.draft.billingFrequency, source: failedItem.draft.billingFrequencySource } : null,
      code: isEvergreenTermRejection ? "SELLING_MODEL_RESOLUTION_MISMATCH" : "CREATE_FAILED",
      rollbackRecords: [{ sobject: "QuoteLineItem", ids: [...creation.idByIndex.values()] }],
    });
  }
  logStep("Create Parent Lines", "success", null, { createdCount: creation.idByIndex.size }, `Created ${creation.idByIndex.size} line item(s) across dependency-ordered passes.`);

  // §Investigation Required (repricing failure ticket): the exact field set
  // requested for every created QuoteLineItem, now that real Ids exist —
  // Product2Id, PricebookEntryId, Pricebook2Id (the Quote's own price book —
  // this call's own `pricebookId` param), ProductSellingModelId,
  // SellingModelType, BillingFrequency, and the RootId/ParentItemId
  // self-reference values just written (see buildQLIPayload) — everything
  // needed to diff against a bundle added through native Salesforce without
  // re-deriving it from scratch on the next live test.
  logStep(
    "Verify Created Line Items", "info", null,
    flatItems.map(item => {
      const id = creation.idByIndex.get(item.index) ?? null;
      const sm = sellingModels.get(item.draft.productId);
      const bt = billingTreatments[item.draft.productId] as BillingTreatmentValidation | undefined;
      return {
        quoteLineItemId: id,
        product2Id: item.draft.productId,
        productName: item.draft.product.name,
        pricebookEntryId: item.draft.product.pricebookEntryId,
        pricebook2Id: pricebookId,
        productSellingModelId: sm?.chosen?.sellingModelId ?? null,
        sellingModelName: sm?.chosen?.name ?? null,
        sellingModelType: sm?.chosen?.type ?? null,
        billingPolicyId: bt?.billingPolicyId ?? null,
        billingTreatmentId: bt?.billingTreatmentId ?? null,
        billingFrequency: item.draft.billingFrequency,
        rootItemId: item.rootIndex !== item.index ? (creation.idByIndex.get(item.rootIndex) ?? null) : null,
        parentItemId: item.parentIndex != null ? (creation.idByIndex.get(item.parentIndex) ?? null) : null,
        isBundleParent: item.draft.isBundleParent,
      };
    }),
    `Complete per-line field snapshot for ${creation.idByIndex.size} created QuoteLineItem(s) — compare against a bundle added through native Salesforce if repricing still fails after this.`,
  );

  // §Price Pipeline Trace, Checkpoint C: read every price field back
  // IMMEDIATELY after INSERT — before relationships, attributes, or the
  // List Price write below — so it's possible to prove whether a $0 came
  // from the create call itself or from something after it. Never coerced
  // to 0 here beyond what readBackLineItems already does for display.
  //
  // §Runtime evidence item 7 — read from whichever field buildQLIPayload
  // ACTUALLY wrote (initialPricingField), never from an unrelated Net*
  // field merely because Net* exists on this org's schema.
  const initialPricingField = resolveInitialPricingField(qliSchema);
  const checkpointCAuthoritativeField = resolveAuthoritativePriceField(qliSchema, initialPricingField.apiName);
  const priceAfterInsert = await readBackLineItems(client, qliSchema, creation, flatItems, checkpointCAuthoritativeField);
  const priceAfterInsertById = new Map(
    (function flattenTrace(nodes: RefreshedLineItem[]): RefreshedLineItem[] { return nodes.flatMap(n => [n, ...flattenTrace(n.children)]); })(priceAfterInsert)
      .map(n => [n.id, n]),
  );
  logStep(
    "Price Pipeline: After Insert", "info", null,
    flatItems.map(item => {
      const id = creation.idByIndex.get(item.index);
      const row = id ? priceAfterInsertById.get(id) : undefined;
      return {
        product: item.draft.product.name, quoteLineItemId: id ?? null, pricebookEntryPrice: item.draft.product.listPrice,
        unitPriceAfterInsert: row?.unitPrice ?? null, totalPriceAfterInsert: row?.totalPrice ?? null,
        displaySourceField: checkpointCAuthoritativeField.unitPriceApiName,
      };
    }),
    `Raw QuoteLineItem price fields immediately after creation, before relationships/attributes/List Price are applied (Checkpoint C). Display source field: ${checkpointCAuthoritativeField.unitPriceApiName ?? "(none writable)"}.`,
  );

  // §Runtime evidence item 1 — every pricing-shaped field this org's
  // QuoteLineItem Describe exposes, with full createable/updateable/
  // calculated evidence and its live value, immediately after insert.
  const createdIdsForDiagnostics = [...creation.idByIndex.values()];
  const pricingFieldDiagnosticsAfterInsert = await capturePricingFieldDiagnostics(client, createdIdsForDiagnostics);
  logStep(
    "Price Pipeline: Full Field Diagnostic (After Insert)", "info", { ids: createdIdsForDiagnostics }, pricingFieldDiagnosticsAfterInsert,
    `Every pricing-shaped QuoteLineItem field (name/label matching price/amount/total/net/list/pricing), with Describe evidence and live value, for ${Object.keys(pricingFieldDiagnosticsAfterInsert).length} created record(s), immediately after insert.`,
  );

  // Create Relationships.
  logStep("Create Relationships", "start", { edgeCount: flatItems.filter(i => i.parentIndex !== null).length, mechanism: qlrSchema.mechanism }, null, "Creating native bundle relationship records for every parent/child edge.");
  const relationships = await createNativeBundleRelationships(client, flatItems, creation.idByIndex, qlrSchema, s => steps.push(s));
  if (!relationships.success) {
    return fail({
      currentStep: "Create Relationships",
      validationRule: "every bundle edge must produce a valid relationship record",
      reason: relationships.error ?? "Failed to create bundle relationships.",
      salesforceObject: qlrSchema.objectName ?? "QuoteLineRelationship",
      generatedPayload: relationships.payloads,
      code: "RELATIONSHIP_CREATE_FAILED",
      rollbackRecords: [
        { sobject: qlrSchema.objectName ?? "QuoteLineRelationship", ids: relationships.createdIds },
        { sobject: "QuoteLineItem", ids: [...creation.idByIndex.values()] },
      ],
    });
  }
  logStep("Create Relationships", "success", null, { createdCount: relationships.createdIds.length }, `Created ${relationships.createdIds.length} relationship record(s).`);

  // Create Attributes.
  const attrCreated: string[] = [];
  if (qliAttrSchema.objectName && qliAttrSchema.quoteLineItemField && qliAttrSchema.attributeField && qliAttrSchema.valueField) {
    const attrPayloads: Record<string, unknown>[] = [];
    for (const item of flatItems) {
      const qliId = creation.idByIndex.get(item.index);
      if (!qliId) continue;
      for (const [attributeId, value] of Object.entries(item.draft.attributeValues)) {
        attrPayloads.push({
          [qliAttrSchema.quoteLineItemField.apiName]: qliId,
          [qliAttrSchema.attributeField.apiName]: attributeId,
          [qliAttrSchema.valueField.apiName]: value,
        });
      }
    }
    if (attrPayloads.length > 0) {
      logStep("Create Attributes", "start", { count: attrPayloads.length }, attrPayloads, `Creating ${attrPayloads.length} QuoteLineItemAttribute record(s).`);
      try {
        for (let offset = 0; offset < attrPayloads.length; offset += 200) {
          const chunk = attrPayloads.slice(offset, offset + 200);
          const results = await client.compositeCreate(qliAttrSchema.objectName, chunk, false);
          for (const r of results) {
            if (r.success && r.id) attrCreated.push(r.id);
            else throw new Error(r.errors?.[0]?.message ?? "Failed to create a QuoteLineItemAttribute record.");
          }
        }
        logStep("Create Attributes", "success", { count: attrPayloads.length }, { createdCount: attrCreated.length }, `Created ${attrCreated.length} attribute value record(s).`);
      } catch (err) {
        return fail({
          currentStep: "Create Attributes",
          validationRule: "every attribute value record must be accepted by Salesforce",
          reason: err instanceof Error ? err.message : "Failed to create attribute records.",
          salesforceObject: qliAttrSchema.objectName, generatedPayload: attrPayloads,
          code: "ATTRIBUTE_CREATE_FAILED",
          rollbackRecords: [
            { sobject: qliAttrSchema.objectName, ids: attrCreated },
            { sobject: qlrSchema.objectName ?? "QuoteLineRelationship", ids: relationships.createdIds },
            { sobject: "QuoteLineItem", ids: [...creation.idByIndex.values()] },
          ],
        });
      }
    }
  }

  // §Apply List Price (unconditional, unchanged base-price mechanism — the
  // product price must never be $0): writes the PricebookEntry's own List
  // Price, with the line's discount applied via the LOCAL formula, directly
  // to every non-included line. This runs for EVERY line regardless of
  // discount, exactly as before — it is what guarantees a 0%-discount line
  // (standalone or bundle) always prices correctly, and it is what a
  // discounted line shows as a provisional value BEFORE the real Salesforce
  // repricing step below (if applicable) overwrites it with Salesforce's
  // own authoritative, engine-computed result.
  let repricing: RepricingSummary | null = null;
  logStep("Apply List Price", "start", { createdCount: creation.idByIndex.size }, null, "Computing and writing List Price (with discount applied) directly for every line — Salesforce Revenue Cloud repricing is not used.");
  const listPriceResult = await applyListPriceFallback(client, qliSchema, flatItems, creation.idByIndex);
  logStep(
    "Apply List Price", listPriceResult.issues.length > 0 ? "error" : "success",
    { createdCount: creation.idByIndex.size }, listPriceResult,
    listPriceResult.attempted
      ? `Applied list price to ${listPriceResult.appliedCount} line(s) via ${listPriceResult.fieldsUsed.netUnitPriceField ?? listPriceResult.fieldsUsed.unitPriceField ?? "no writable field"}; ${listPriceResult.skippedIncludedCount} bundle-included child line(s) left untouched; ${listPriceResult.failedIds.length} failed.`
      : listPriceResult.issues[0] ?? "List price could not be applied.",
  );

  // §Runtime evidence item 4/12 — an HTTP-success compositeUpdate response
  // is NEVER treated as "price applied" on its own: capture the SAME full
  // pricing-field diagnostic table again, right after this write, so a
  // Salesforce-side automation silently reverting the value is visible
  // (updateSucceeded=true but value back to 0) instead of assumed away.
  const pricingFieldDiagnosticsAfterListPriceWrite = await capturePricingFieldDiagnostics(client, createdIdsForDiagnostics);
  logStep(
    "Price Pipeline: Full Field Diagnostic (After List Price Write)", "info", { ids: createdIdsForDiagnostics }, pricingFieldDiagnosticsAfterListPriceWrite,
    `Every pricing-shaped QuoteLineItem field, with Describe evidence and live value, for ${Object.keys(pricingFieldDiagnosticsAfterListPriceWrite).length} record(s), immediately after the List Price write — compare against the "After Insert" diagnostic above to see exactly which field(s), if any, a Salesforce-side process changed.`,
  );

  // §Discount pricing fix (Phases 2/4/5): a discounted line's real,
  // Salesforce-computed net price ("Percentage-Based (Line-Level)" in
  // Revenue Cloud's own Calculation Details) is NOT reproducible from
  // `listPrice * (1 - discount/100)` locally — runtime evidence shows
  // Salesforce's pricing procedure applying its own chain of steps that a
  // local formula cannot see. The only way to get the SAME result Salesforce
  // would show for a manually-discounted line is to let Salesforce compute
  // it: the line's Discount% is already correctly persisted (buildQLIPayload,
  // unchanged), so invoking Salesforce's own documented Instant Pricing
  // repricing call (lib/quotes/pricing/reprice.ts) — now fixed to actually
  // include Discount in its request, see that file — makes Salesforce's
  // engine compute and persist the authoritative NetUnitPrice/NetTotalPrice
  // from that same field, exactly as a manual UI edit would.
  //
  // Scoped strictly to requests that actually have a discounted, non-
  // included line: a 0%-discount request (standalone or bundle) never
  // reaches this block at all — the "Apply List Price" write above already
  // produces the correct price for it, and it is left completely untouched
  // (§Phase 6 regression protection).
  const discountedLines = flatItems.filter(i => i.draft.discountPercent > 0 && !i.draft.pricingInclusion);
  // §Bundle configuration validation: Salesforce's native "Refresh Prices"
  // button validates a bundle's configuration as PART OF running its own
  // Revenue Cloud pricing engine. A bundle created by this app but never
  // actually processed by that engine (a 0%-discount bundle previously
  // skipped straight to the local "Apply List Price" write above, which is a
  // raw field write, not a Salesforce pricing run) reaches the user's later
  // native Refresh Prices click having NEVER been priced by Salesforce at
  // all — a leading, testable explanation for "We couldn't retrieve the
  // product and price information... Ensure Product Discovery is set up
  // correctly." Bundles are therefore always repriced via the SAME existing
  // Instant Pricing call (never a new/invented pricing path), even at 0%
  // discount. A plain NON-bundle 0%-discount line keeps its exact prior
  // behavior — the existing regression protection for that case is
  // unchanged.
  const hasBundleForRepricing = flatItems.some(i => i.draft.isBundleParent || i.parentIndex !== null);
  let adjustmentDiscovery: Awaited<ReturnType<typeof resolveQuoteLineAdjustmentDiscovery>> | null = null;
  if (discountedLines.length === 0 && !hasBundleForRepricing) {
    logStep(
      "Repricing", "info", { discountedLineCount: 0, hasBundleForRepricing }, { called: false },
      "SKIPPED — no line in this request has a non-zero discount percentage and this request has no bundle structure; the List Price write above already produces the correct (undiscounted) price and Salesforce repricing is not needed.",
    );
  } else {
    // §Phase 2 — diagnostic-only discovery of a possible DISTINCT Revenue
    // Cloud manual-adjustment object, purely to report evidence (never used
    // to create/write anything) in case this org's "Percentage-Based
    // (Line-Level)" adjustment is NOT simply the standard Discount field —
    // see lib/quotes/metadata/adjustmentFields.ts for why this never
    // fabricates an object/field name.
    logStep(
      "Discover Discount Adjustment Object", "start", { discountedLineCount: discountedLines.length }, null,
      "Diagnostic-only: checking whether this org represents a manual line-level price adjustment as a DISTINCT related object (discovered via QuoteLineItem's own Describe childRelationships, never a guessed name) — this app's actual fix does not write to whatever is found here; it's evidence for comparing against Salesforce's own Calculation Details.",
    );
    adjustmentDiscovery = await resolveQuoteLineAdjustmentDiscovery(client);
    logStep(
      "Discover Discount Adjustment Object", "info", { discountedLineCount: discountedLines.length }, adjustmentDiscovery,
      adjustmentDiscovery.objectName
        ? `Found candidate object "${adjustmentDiscovery.objectName}" with a reference to QuoteLineItem and adjustment-shaped fields (percentField=${adjustmentDiscovery.percentField?.apiName ?? "none"}, amountField=${adjustmentDiscovery.amountField?.apiName ?? "none"}, valueField=${adjustmentDiscovery.valueField?.apiName ?? "none"}, typeField=${adjustmentDiscovery.typeField?.apiName ?? "none"}). Full field evidence attached. This app does NOT write to it — it relies on the standard Discount field + Salesforce's own repricing call below instead.`
        : `No distinct adjustment object found: ${adjustmentDiscovery.diagnostics.reason}`,
    );

    logStep(
      "Reprice via Salesforce", "start", { quoteId, discountedLineCount: discountedLines.length }, null,
      "Invoking Salesforce's documented Instant Pricing repricing call so its own Revenue Cloud engine computes NetUnitPrice/NetTotalPrice from the persisted Discount field, the same way a manual UI edit would — never a locally recomputed estimate.",
    );
    repricing = await repriceQuote(client, quoteId);
    logStep(
      "Reprice via Salesforce", repricing.succeeded ? "success" : "error", { quoteId }, repricing,
      repricing.succeeded
        ? `Salesforce repriced ${repricing.lines.length} line(s). The subsequent "Verification" re-query below will reflect whatever Salesforce's engine actually persisted.`
        : `Repricing did not succeed: ${repricing.message ?? "unknown reason"}. Discounted line(s) keep the local List-Price-fallback estimate written above — NOT confirmed to match Salesforce's own Calculation Details.`,
    );
  }

  // Verification.
  logStep("Verification", "start", { createdCount: creation.idByIndex.size }, null, "Re-querying created line items for verification.");
  const createdIds = [...creation.idByIndex.values()];
  // §Runtime evidence item 7 — the authoritative read-back field is
  // whichever field applyListPriceFallback ACTUALLY targeted (never an
  // unrelated Net* field merely because it exists); falls back to the
  // create-time field when nothing was writable to update post-creation.
  const finalAuthoritativeField = resolveAuthoritativePriceField(
    qliSchema,
    listPriceResult.fieldsUsed.netUnitPriceField ?? listPriceResult.fieldsUsed.unitPriceField ?? initialPricingField.apiName,
  );
  const refreshedLineItems = await readBackLineItems(client, qliSchema, creation, flatItems, finalAuthoritativeField);
  let bundleHierarchyValid = true;
  const issues: string[] = [];
  if (hasBundleStructure && qlrSchema.mechanism === "relationship-object" && qlrSchema.objectName && qlrSchema.mainQuoteLineField) {
    try {
      const idList = createdIds.map(id => `'${soqlEscape(id)}'`).join(",");
      const check = await client.query<Record<string, unknown>>(
        `SELECT Id FROM ${qlrSchema.objectName} WHERE ${qlrSchema.mainQuoteLineField.apiName} IN (${idList})`,
      );
      const expectedEdges = flatItems.filter(i => i.parentIndex !== null).length;
      if (check.records.length !== expectedEdges) {
        bundleHierarchyValid = false;
        issues.push(`Expected ${expectedEdges} bundle relationship record(s), found ${check.records.length} on read-back.`);
      }
    } catch {
      bundleHierarchyValid = false;
      issues.push("Could not verify bundle relationship records on read-back.");
    }
  }
  // §$0.00 pricing bug — never silently treat $0.00 as success: the
  // product price must never be $0 (explicit user directive) — every
  // non-included line's authoritative Salesforce price is verified against
  // its List Price (with discount applied), regardless of pricingModel,
  // since Apply List Price now writes this for every org. A bundle CHILD
  // whose price is genuinely included in its parent's price is correctly
  // $0 and must never be flagged.
  let pricingVerified = true;
  if (listPriceResult.failedIds.length > 0) {
    pricingVerified = false;
    issues.push(`Pricing verification failed: ${listPriceResult.issues.join(" ")}`);
  }
  // §Always check the actual read-back, regardless of whether the fallback
  // write above was even attempted — a create-only (createable but not
  // updateable) price field would already have its correct value from
  // buildQLIPayload's creation-time write, with nothing left for the
  // fallback to do; the read-back is the one true test of correctness,
  // never assume failure just because there was no post-creation write to
  // attempt.
  const flattenRefreshed = (nodes: RefreshedLineItem[]): RefreshedLineItem[] => nodes.flatMap(n => [n, ...flattenRefreshed(n.children)]);
  const refreshedById = new Map(flattenRefreshed(refreshedLineItems).map(n => [n.id, n]));
  const zeroedButExpected = flatItems.filter(item => {
    const id = creation.idByIndex.get(item.index);
    if (!id) return false;
    const refreshed = refreshedById.get(id);
    if (!refreshed || refreshed.pricingInclusion) return false;
    return item.draft.unitPrice > 0 && refreshed.unitPrice === 0 && refreshed.totalPrice === 0;
  });
  if (zeroedButExpected.length > 0) {
    pricingVerified = false;
    // §Phase 4 — show the mismatch explicitly: expected price vs the $0
    // actually persisted, per line, not just a name list.
    issues.push(
      `Pricing verification failed: ${zeroedButExpected.length} line item(s) expected a non-zero price but returned $0.00 on read-back: ` +
      zeroedButExpected.map(i => `"${i.draft.product.name}" (expected ${i.draft.unitPrice})`).join("; ") + ".",
    );
    if (!listPriceResult.attempted) {
      issues.push(`Additionally, List Price could not be written at all: ${listPriceResult.issues.join(" ") || "no writable price field found."}`);
    }
  }
  logStep(
    "Verification", "success",
    { createdCount: creation.idByIndex.size },
    { refreshedCount: refreshedLineItems.length, bundleHierarchyValid, pricingVerified, issues },
    `Verified ${refreshedLineItems.length} created line item(s). Pricing verified: ${pricingVerified}.`,
  );

  // §Price Pipeline Trace — every checkpoint for every non-included line,
  // assembled from data already captured above (nothing re-derived/re-
  // guessed): PBE price (Resolve PricebookEntry), the exact create payload
  // value (builtPayloads), the raw price immediately after INSERT
  // (Checkpoint C above, before Create Relationships), whether/what the
  // List Price fallback wrote, and the final authoritative re-query.
  // (initialPricingField, checkpointCAuthoritativeField, finalAuthoritativeField already resolved above.)
  const builtPayloadByIndex = new Map(builtPayloads.map(b => [b.item.index, b.payload]));
  const pricingTrace: PricingTraceLine[] = flatItems.map(item => {
    const id = creation.idByIndex.get(item.index) ?? "";
    const insertRow = priceAfterInsertById.get(id);
    const finalRow = refreshedById.get(id);
    const payload = builtPayloadByIndex.get(item.index);
    const createPayloadPrice = initialPricingField.apiName && payload && payload[initialPricingField.apiName] != null ? (payload[initialPricingField.apiName] as number) : null;

    // §Phase 8 — "confirmed" is the ONLY field allowed to gate a "yes" in
    // the UI: attempted reflects whether a write was even tried; updateSucceeded
    // reflects only what compositeUpdate's own response said (Salesforce can
    // report success on a write a trigger/flow silently reverts); confirmed
    // requires the SEPARATE read-back below to actually match the value sent.
    const listPriceWriteField = listPriceResult.fieldsUsed.netUnitPriceField ?? listPriceResult.fieldsUsed.unitPriceField ?? null;
    const listPriceWriteValue = item.draft.pricingInclusion ? null : computeNetUnitPrice(item.draft.unitPrice, item.draft.discountPercent);
    const listPriceAttempted = !item.draft.pricingInclusion && listPriceResult.attempted;
    const listPriceUpdateSucceeded = listPriceAttempted && !listPriceResult.failedIds.includes(id);
    const readBackValue = finalRow?.unitPrice ?? null;
    const listPriceConfirmed = listPriceUpdateSucceeded && listPriceWriteValue != null && readBackValue != null && Math.abs(readBackValue - listPriceWriteValue) < 0.005;

    // §Discount pricing fix — what Salesforce's OWN repricing response
    // (if it was attempted for this Quote) actually returned for this exact
    // line, never a locally recomputed value. `confirmed` is true only when
    // Salesforce's response body itself carried a result for this
    // quoteLineItemId — never merely because the repricing HTTP call as a
    // whole returned 200/201.
    const repricedLine = repricing?.lines.find(l => l.quoteLineItemId === id) ?? null;
    const discountRepricing = item.draft.discountPercent > 0 && !item.draft.pricingInclusion
      ? {
          requestedPercent: item.draft.discountPercent,
          salesforceNetUnitPrice: repricedLine?.netUnitPrice ?? null,
          salesforceNetTotalPrice: repricedLine?.netTotalPrice ?? null,
          salesforceAdjustmentAmount: repricedLine?.netUnitPrice != null ? item.draft.product.listPrice - repricedLine.netUnitPrice : null,
          confirmed: repricedLine != null && repricedLine.netUnitPrice != null,
        }
      : null;

    return {
      productName: item.draft.product.name,
      productId: item.draft.productId,
      quoteLineItemId: id,
      pricingInclusion: item.draft.pricingInclusion,
      pricebookEntryPrice: item.draft.product.listPrice,
      createPayloadPrice,
      createPayloadFieldUsed: createPayloadPrice != null ? initialPricingField.apiName : null,
      priceAfterInsert: insertRow?.unitPrice ?? 0,
      afterInsertSourceField: checkpointCAuthoritativeField.unitPriceApiName,
      listPriceWrite: {
        attempted: listPriceAttempted,
        field: listPriceWriteField,
        value: listPriceWriteValue,
        updateSucceeded: listPriceUpdateSucceeded,
        readBackValue,
        confirmed: listPriceConfirmed,
      },
      finalPrice: finalRow?.unitPrice ?? 0,
      finalPriceSourceField: finalAuthoritativeField.unitPriceApiName,
      discountRepricing,
    };
  });
  console.log(`[Price Pipeline Trace] ${JSON.stringify(pricingTrace)}`);

  return {
    success: true,
    createdIds,
    createdCount: createdIds.length,
    bundleHierarchyValid,
    pricingVerified,
    issues,
    steps,
    repricing,
    errors,
    refreshedLineItems,
    pricingTrace,
    failureDetail: null,
  };
}

async function readBackLineItems(
  client: SalesforceClient,
  qliSchema: Awaited<ReturnType<typeof resolveQuoteLineItemFieldSchema>>,
  creation: { idByIndex: Map<number, string> },
  flatItems: FlatDraftItem[],
  authoritativeField: { unitPriceApiName: string | null; totalPriceApiName: string | null },
): Promise<RefreshedLineItem[]> {
  const ids = [...creation.idByIndex.values()];
  if (ids.length === 0) return [];

  const selectFields = ["Id"];
  if (qliSchema.quantityField) selectFields.push(qliSchema.quantityField.apiName);
  if (qliSchema.unitPriceField) selectFields.push(qliSchema.unitPriceField.apiName);
  if (qliSchema.listPriceField) selectFields.push(qliSchema.listPriceField.apiName);
  if (qliSchema.discountField) selectFields.push(qliSchema.discountField.apiName);
  if (qliSchema.totalPriceField) selectFields.push(qliSchema.totalPriceField.apiName);
  if (qliSchema.netUnitPriceField) selectFields.push(qliSchema.netUnitPriceField.apiName);
  if (qliSchema.netTotalPriceField) selectFields.push(qliSchema.netTotalPriceField.apiName);
  if (qliSchema.pricingStatusField) selectFields.push(qliSchema.pricingStatusField.apiName);
  if (qliSchema.rootItemField) selectFields.push(qliSchema.rootItemField.apiName);
  if (qliSchema.parentItemField) selectFields.push(qliSchema.parentItemField.apiName);

  let rows: Record<string, unknown>[] = [];
  try {
    const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await client.query<Record<string, unknown>>(`SELECT ${selectFields.join(", ")} FROM QuoteLineItem WHERE Id IN (${idList})`);
    rows = res.records;
  } catch {
    rows = [];
  }
  const rowById = new Map(rows.map(r => [r.Id as string, r]));

  const nodesByIndex = new Map<number, RefreshedLineItem>();
  for (const item of flatItems) {
    const id = creation.idByIndex.get(item.index);
    if (!id) continue;
    const row = rowById.get(id) ?? {};
    // §Confirmed breakpoint #2 fix: read from whichever field this app
    // ACTUALLY wrote for this checkpoint (`authoritativeField`, resolved by
    // the caller from the real write it just performed — buildQLIPayload at
    // create time, or applyListPriceFallback's `fieldsUsed` afterward).
    // Previously this unconditionally preferred Net* whenever it existed on
    // the org's schema, regardless of whether anything had ever written to
    // it — on this org, Net* is never populated (Revenue Cloud Instant
    // Pricing is disabled, see the "Repricing" step), so that silently
    // displayed/verified $0 from an untouched field while the real UnitPrice
    // this app wrote held the correct, persisted value.
    const rawUnitPrice = authoritativeField.unitPriceApiName
      ? (row[authoritativeField.unitPriceApiName] as number | null | undefined)
      : undefined;
    const rawTotalPrice = authoritativeField.totalPriceApiName
      ? (row[authoritativeField.totalPriceApiName] as number | null | undefined)
      : undefined;
    nodesByIndex.set(item.index, {
      id,
      productId: item.draft.productId,
      productName: item.draft.product.name,
      quantity: qliSchema.quantityField ? ((row[qliSchema.quantityField.apiName] as number) ?? item.draft.quantity) : item.draft.quantity,
      unitPrice: rawUnitPrice ?? 0,
      listPrice: qliSchema.listPriceField ? ((row[qliSchema.listPriceField.apiName] as number) ?? 0) : 0,
      discount: qliSchema.discountField ? ((row[qliSchema.discountField.apiName] as number) ?? 0) : 0,
      totalPrice: rawTotalPrice ?? 0,
      pricingStatus: qliSchema.pricingStatusField ? ((row[qliSchema.pricingStatusField.apiName] as string) ?? null) : null,
      pricingInclusion: item.draft.pricingInclusion,
      parentDraftId: item.draft.parentDraftId,
      // §Verify the persisted value, not just what we intended to send —
      // read straight back from Salesforce (falling back to the locally
      // known Id only when this org has no such field at all to read).
      rootItemId: qliSchema.rootItemField
        ? ((row[qliSchema.rootItemField.apiName] as string) ?? null)
        : (item.rootIndex !== item.index ? (creation.idByIndex.get(item.rootIndex) ?? null) : null),
      parentItemId: qliSchema.parentItemField
        ? ((row[qliSchema.parentItemField.apiName] as string) ?? null)
        : (item.parentIndex != null ? (creation.idByIndex.get(item.parentIndex) ?? null) : null),
      children: [],
    });
  }
  // Wire up children by parentIndex.
  for (const item of flatItems) {
    if (item.parentIndex == null) continue;
    const parent = nodesByIndex.get(item.parentIndex);
    const child = nodesByIndex.get(item.index);
    if (parent && child) parent.children.push(child);
  }
  return flatItems.filter(i => i.parentIndex === null).map(i => nodesByIndex.get(i.index)!).filter(Boolean);
}
