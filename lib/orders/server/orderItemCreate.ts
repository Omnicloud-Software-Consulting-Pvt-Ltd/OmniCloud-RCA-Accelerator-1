import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, findPicklistFieldByLabel } from "@/lib/salesforce/describe";
import { resolveOrderItemFieldSchema, resolveOrderItemAttributeFieldSchema } from "@/lib/orders/metadata/lineItemFields";
import { resolveOrderItemRelationshipSchema } from "@/lib/orders/metadata/relationshipFields";
import { checkOrderMutability } from "@/lib/orders/metadata/orderStatus";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { expandBundle } from "@/lib/quotes/bundles/expansion";
import { validateDraftForest, type DraftValidationProductInfo } from "@/lib/quotes/bundles/validate";
import {
  flattenForestWithParentIndex,
  integrityCheckPayload,
  buildOrderItemPayload,
  createInDependencyOrderedPasses,
  createNativeBundleRelationships,
  type FlatDraftItem,
} from "@/lib/orders/bundles/relationshipCreate";
import { rollbackRecords } from "@/lib/quotes/bundles/relationshipCreate";
import { fetchCatalogProductsByIds } from "@/lib/quotes/catalog/search";
import { resolveSellingModelsBatch } from "@/lib/quotes/catalog/sellingModel";
import { resolveProductAttributesBatch } from "@/lib/quotes/catalog/attributes";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import { resolveBillingFrequency } from "@/lib/quotes/billing/frequency";
import { repriceOrder } from "@/lib/orders/pricing/reprice";
import type { BillingTreatmentValidation, BundleHierarchyStep, QuoteLineItemDraft } from "@/lib/quotes/types";
import type {
  OrderLineItemCreationError,
  OrderLineItemCreationResult,
  OrderLineItemFailureDetail,
  OrderLineItemRollbackDetail,
  RefreshedOrderItem,
} from "@/lib/orders/types";

function uniqueProductIds(flatItems: FlatDraftItem[]): string[] {
  return [...new Set(flatItems.map(i => i.draft.productId))];
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
 * The core server-side OrderItem creation sequence (§5.2) — the Order-side
 * counterpart of createQuoteLineItems (lib/quotes/server/lineItemCreate.ts),
 * reusing every genuinely object-agnostic service (bundle expansion/
 * validation, product/selling-model/attribute/billing resolution) verbatim,
 * with two Order-specific additions: Step 0 re-verifies the Order is still
 * mutable server-side (never trusts the client's belief that it still is),
 * and every write targets OrderItem/OrderItemAttribute/OrderItemRelationship
 * instead of their Quote-side counterparts.
 */
export async function createOrderItems(
  client: SalesforceClient,
  orderId: string,
  pricebookId: string,
  draftRoots: QuoteLineItemDraft[],
): Promise<OrderLineItemCreationResult> {
  const steps: BundleHierarchyStep[] = [];
  const errors: OrderLineItemCreationError[] = [];
  let lastSuccessfulStep: string | null = null;
  let oirSchemaRef: Awaited<ReturnType<typeof resolveOrderItemRelationshipSchema>> | null = null;

  function logStep(name: string, status: BundleHierarchyStep["status"], input: unknown, output: unknown, reason: string) {
    steps.push({ step: name, status, message: reason, detail: { input, output, reason }, timestamp: Date.now() });
    if (status === "success") lastSuccessfulStep = name;
  }

  async function rollbackWithLog(records: { sobject: string; ids: string[] }[]): Promise<OrderLineItemRollbackDetail> {
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
  }): Promise<OrderLineItemCreationResult> {
    logStep(params.currentStep, "error", { validationRule: params.validationRule }, null, params.reason);
    errors.push({ message: params.reason, code: params.code ?? null, path: params.path ?? null });

    const rollback = await rollbackWithLog(params.rollbackRecords ?? []);

    const failureDetail: OrderLineItemFailureDetail = {
      currentStep: params.currentStep,
      validationRule: params.validationRule,
      reason: params.reason,
      missingField: params.missingField ?? null,
      invalidValue: params.invalidValue ?? null,
      salesforceObject: params.salesforceObject ?? null,
      orderId,
      productId: params.productId ?? null,
      productName: params.productName ?? null,
      pricebookEntryId: params.pricebookEntryId ?? null,
      sellingModel: params.sellingModel ?? null,
      billingFrequency: params.billingFrequency ?? null,
      bundle: params.bundle ?? null,
      attributes: params.attributes ?? null,
      relationshipFields: oirSchemaRef,
      generatedPayload: params.generatedPayload ?? null,
      validationErrors: errors.map(e => e.message),
      rollback,
      lastSuccessfulStep,
    };

    return {
      success: false, createdIds: [], createdCount: 0, bundleHierarchyValid: false,
      issues: [params.reason], steps, repricing: null, errors, refreshedLineItems: [], failureDetail,
    };
  }

  // Step 0 (Order-specific, §5.2): re-verify server-side that the Order is
  // still in a mutable Status — never trust the client's cached belief.
  logStep("Verify Order Mutability", "start", { orderId }, null, "Re-checking this Order's current Status server-side.");
  const mutability = await checkOrderMutability(client, orderId);
  if (mutability.status === "blocked") {
    return fail({
      currentStep: "Verify Order Mutability",
      validationRule: "the Order must not be in a Status the org has confirmed blocks OrderItem writes",
      reason: `This Order is no longer editable: ${mutability.reason}`,
      salesforceObject: "Order",
      code: "ORDER_NOT_MUTABLE",
    });
  }
  logStep("Verify Order Mutability", "success", { orderId }, mutability, mutability.reason);

  logStep("Dependency Graph", "start", { draftRootCount: draftRoots.length }, null, "Flattening the draft forest into a dependency-ordered list.");
  const flatItems = flattenForestWithParentIndex(draftRoots);
  const dependencyGraph = flatItems.map(i => ({ index: i.index, product: i.draft.product.name, parentIndex: i.parentIndex, depth: i.path.length - 1 }));
  logStep("Dependency Graph", "success", { draftRootCount: draftRoots.length }, dependencyGraph, `${flatItems.length} line item(s) flattened; ${flatItems.filter(i => i.parentIndex === null).length} root (parent) line(s), ${flatItems.filter(i => i.parentIndex !== null).length} child line(s).`);
  // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
  // failures are confirmed resolved): the EXACT request payload this server
  // call received, per line, before any server-side re-resolution — proves
  // whether the client's draft still carried a Billing Frequency by the
  // time it reached this endpoint.
  for (const item of flatItems) {
    console.log(`[BILLING FREQUENCY LINE REQUEST] productId=${item.draft.productId} ("${item.draft.product.name}") sellingModelType=${item.draft.sellingModelType ?? "null"} parentIndex=${item.parentIndex ?? "root"} -> draft.billingFrequency=${item.draft.billingFrequency ?? "null"} source=${item.draft.billingFrequencySource ?? "null"}.`);
  }

  if (flatItems.length === 0) {
    return fail({ currentStep: "Dependency Graph", validationRule: "non-empty request", reason: "No order line items to create.", missingField: "draftRoots" });
  }

  const distinctProductIds = uniqueProductIds(flatItems);

  logStep("Resolve Metadata", "start", { orderId, pricebookId }, null, "Resolving OrderItem/attribute schema and bundle object discovery via Describe.");
  const [oiSchema, oiAttrSchema, discovery] = await Promise.all([
    resolveOrderItemFieldSchema(client),
    resolveOrderItemAttributeFieldSchema(client),
    resolveBundleObjectDiscovery(client),
  ]);
  const oirSchema = await resolveOrderItemRelationshipSchema(client, discovery);
  oirSchemaRef = oirSchema;
  logStep("Resolve Metadata", "success", { orderId, pricebookId }, { oiSchema, oiAttrSchema, discovery, oirSchema }, `Pricing model: ${oiSchema.pricingModel}. Bundle mechanism: ${oirSchema.mechanism}.`);

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

  logStep("Resolve PricebookEntry", "start", { pricebookId }, null, "Verifying each line's cached PricebookEntry Id still matches the fresh lookup.");
  for (const item of flatItems) {
    const fresh = freshCatalog.get(item.draft.productId);
    if (!fresh || fresh.pricebookEntryId !== item.draft.product.pricebookEntryId) {
      return fail({
        currentStep: "Resolve PricebookEntry",
        validationRule: "PricebookEntry Id must match the price book currently in use",
        reason: `"${item.draft.product.name}" no longer has an active PricebookEntry in this price book (expected ${fresh?.pricebookEntryId ?? "none"}, draft had ${item.draft.product.pricebookEntryId}).`,
        missingField: "PricebookEntryId", invalidValue: item.draft.product.pricebookEntryId, salesforceObject: "PricebookEntry",
        productId: item.draft.productId, productName: item.draft.product.name, pricebookEntryId: fresh?.pricebookEntryId ?? null,
        path: item.path, code: "PRICEBOOK_ENTRY_INVALID",
      });
    }
  }
  const pricingBreakdown = flatItems.map(i => {
    const unitPrice = i.draft.unitPrice ?? i.draft.product.listPrice;
    const lineTotal = Math.round(unitPrice * (1 - i.draft.discountPercent / 100) * i.draft.quantity * 100) / 100;
    return {
      productName: i.draft.product.name,
      productId: i.draft.productId,
      pricebookEntryId: i.draft.product.pricebookEntryId,
      unitPrice,
      quantity: i.draft.quantity,
      lineTotal,
    };
  });
  logStep("Resolve PricebookEntry", "success", { pricebookId }, pricingBreakdown, "All PricebookEntry Ids verified against Salesforce; resolved unit price and calculated line total for each line.");

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

  logStep("Resolve Billing Frequency", "start", null, null, "Validating that Billing Frequency is already configured on the draft for every line whose Selling Model Type requires one (resolved once, at product-configuration time).");
  let billingFrequencyActiveValues: string[] | null = null;
  if (oiSchema.billingFrequencyField) {
    try {
      const oiDescribe = await describeObjectCached(client, "OrderItem");
      const picklist = findPicklistFieldByLabel(oiDescribe, "BillingFrequency", /^billing frequency$/i);
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
      const skipReason = !sm
        ? "No SellingModelResolution entry at all for this product."
        : sm.options.length === 0
          ? "Zero ProductSellingModelOption rows found for this product."
          : !sm.chosen
            ? `${sm.options.length} option(s) found but none could be chosen (chosenReason: ${sm.chosenReason}).`
            : `Chosen option "${sm.chosen.name}" classified as ${sm.chosen.type} — not Evergreen/Term-Defined, so no billing frequency required.`;
      billingFrequencyValidation[item.draft.product.name] = { skipped: true, reason: skipReason };
      continue;
    }

    if (!item.draft.billingFrequency) {
      // §Selling Model reclassification: the draft's own sellingModelType was
      // cached at add-time from this SAME resolver. If it disagrees with what
      // was just re-resolved above, this product's Selling Model configuration
      // is genuinely ambiguous in the org (e.g. multiple active
      // ProductSellingModelOption rows with no default flagged) — that's why
      // Billing Frequency was never prompted for at add-time but is required
      // now. Name that explicitly instead of a bare "no Billing Frequency"
      // message that gives no indication of why.
      const reclassified = !!item.draft.sellingModelType && item.draft.sellingModelType !== sm.chosen.type;
      // §Diagnose, don't just report: resolveBillingFrequency() is not
      // re-run during create by design (it's only ever resolved once, at
      // add-time) — but that means, until now, THIS failure carried no
      // record of WHY the original resolution came up empty. Re-run it here
      // purely for diagnostics (read-only, never written to the draft) so
      // the failure detail's "Billing Frequency" panel shows the actual
      // step-by-step trace (which sources were tried, what each one found
      // or why it was rejected) instead of nothing.
      const diagnosticResolution = await resolveBillingFrequency(
        client, item.draft.productId, sm.chosen.sellingModelId, sm.chosen.name, "OrderItem",
      );
      return fail({
        currentStep: "Resolve Billing Frequency",
        validationRule: "the draft OrderItem for a Selling Model Type of Evergreen or Term-Defined must already carry a configured Billing Frequency",
        reason: reclassified
          ? `"${item.draft.product.name}" was added to this Order as Selling Model Type "${item.draft.sellingModelType}" (no Billing Frequency required at that time), but now re-resolves to "${sm.chosen.type}" (chosenReason: ${sm.chosenReason}), which requires one. This product has an ambiguous Selling Model configuration in this org — remove it and add it again to re-resolve Billing Frequency, or ask an admin to flag a single Selling Model Option as both Default and Active for this product.`
          : `"${item.draft.product.name}" (Selling Model Type: ${sm.chosen.type}) reached order line item creation with no Billing Frequency on its draft.`,
        missingField: "BillingFrequency", invalidValue: null, salesforceObject: "OrderItem",
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
        missingField: null, invalidValue: item.draft.billingFrequency, salesforceObject: "OrderItem",
        productId: item.draft.productId, productName: item.draft.product.name, sellingModel: sm,
        path: item.path, code: "BILLING_FREQUENCY_INVALID_VALUE",
      });
    }

    billingFrequencyValidation[item.draft.product.name] = { value: item.draft.billingFrequency, source: item.draft.billingFrequencySource ?? "unknown", validActivePicklistValue: true };
  }
  logStep("Resolve Billing Frequency", "success", null, billingFrequencyValidation, `Billing Frequency validated as already configured for every line that requires one (${Object.keys(billingFrequencyValidation).length} product(s)).`);

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
          missingField: attr.name, invalidValue: item.draft.attributeValues[attr.attributeId] ?? null, salesforceObject: "OrderItemAttribute",
          productId: item.draft.productId, productName: item.draft.product.name, attributes: attrs,
          path: item.path, code: "ATTRIBUTE_REQUIRED",
        });
      }
    }
  }
  logStep("Resolve Attributes", "success", { productIds: distinctProductIds }, Object.fromEntries(attributesByProduct), "All required attributes are set.");

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

  const hasBundleStructure = flatItems.some(i => i.parentIndex !== null);
  logStep("Resolve Relationship Fields", "start", { hasBundleStructure }, null, "Determining the org's native OrderItem bundle-relationship mechanism.");
  if (hasBundleStructure && oirSchema.mechanism === "unsupported") {
    return fail({
      currentStep: "Resolve Relationship Fields",
      validationRule: "a native bundle-relationship mechanism must exist when the request has bundle structure",
      reason: "This org has no native mechanism to represent OrderItem bundle relationships (no OrderItemRelationship-shaped object and no OrderItem self-reference fields).",
      salesforceObject: "OrderItemRelationship", missingField: "mainOrderItemField/associatedOrderItemField or a self-reference field pair",
      code: "BUNDLE_NOT_SUPPORTED",
    });
  }
  logStep("Resolve Relationship Fields", "success", { hasBundleStructure }, oirSchema, `Bundle hierarchy mechanism: ${oirSchema.mechanism}.`);

  logStep(
    "Verify Draft", "info", null,
    flatItems.map(i => ({
      product: i.draft.product.name, productId: i.draft.productId, pricebookEntryId: i.draft.product.pricebookEntryId,
      sellingModelOptionId: i.draft.sellingModelOptionId, billingFrequency: i.draft.billingFrequency,
      billingFrequencySource: i.draft.billingFrequencySource, billingTreatmentOutcome: i.draft.billingTreatmentOutcome,
      subscriptionTerm: i.draft.subscriptionTerm, attributeValues: i.draft.attributeValues,
      isBundleParent: i.draft.isBundleParent, parentDraftId: i.draft.parentDraftId,
    })),
    `Complete configured draft for ${flatItems.length} line item(s), printed before payload generation.`,
  );

  logStep("Build Payload", "start", { itemCount: flatItems.length }, null, "Building the OrderItem create payload for every line via buildOrderItemPayload() — the one and only serializer.");
  const builtPayloads = flatItems.map(item => ({ item, payload: buildOrderItemPayload(item, orderId, oiSchema, null, null) }));
  logStep("Build Payload", "success", { itemCount: flatItems.length }, builtPayloads.map(b => b.payload), `${builtPayloads.length} payload(s) generated via buildOrderItemPayload().`);

  logStep("Validate Payload", "start", null, null, "Integrity-checking every generated payload before any write.");
  for (const { item, payload } of builtPayloads) {
    const missing = integrityCheckPayload(payload, oiSchema);
    if (missing.length > 0) {
      return fail({
        currentStep: "Validate Payload",
        validationRule: "payload must include Order/PricebookEntry reference and a positive Quantity",
        reason: `"${item.draft.product.name}" payload is missing: ${missing.join(", ")}.`,
        missingField: missing.join(", "), salesforceObject: "OrderItem", generatedPayload: payload,
        productId: item.draft.productId, productName: item.draft.product.name, path: item.path, code: "PAYLOAD_INTEGRITY",
      });
    }
  }
  logStep("Validate Payload", "success", null, builtPayloads.map(b => b.payload), "All payloads passed integrity checks.");

  // §Verify Billing Treatment (mirrors lib/quotes/server/lineItemCreate.ts):
  // wherever the resolved Billing Treatment explicitly says
  // CanChangeBillingFrequency = false, cross-check that the value about to
  // be sent actually matches the Selling Model's own resolved cadence —
  // a mismatch is exactly what produces Salesforce's "Add a Billing
  // Treatment to make sure that you can change the Billing Frequency..."
  // rejection, caught locally here with a specific diagnosis instead of a
  // bare Salesforce error.
  for (const item of flatItems) {
    const sm = sellingModels.get(item.draft.productId);
    if (!sm?.chosen?.requiresBillingFrequency) continue;
    const bt = billingTreatments[item.draft.productId] as BillingTreatmentValidation | undefined;
    if (bt?.canChangeBillingFrequency !== false) continue; // true or unresolved (null) — nothing this app can positively enforce

    const natural = await resolveBillingFrequency(client, item.draft.productId, sm.chosen.sellingModelId, sm.chosen.name, "OrderItem");
    if (natural.value && natural.value !== item.draft.billingFrequency) {
      return fail({
        currentStep: "Verify Billing Treatment",
        validationRule: "when Billing Treatment.CanChangeBillingFrequency is false, the payload's BillingFrequency must match the Selling Model's own resolved value",
        reason: `"${item.draft.product.name}" (Selling Model: "${sm.chosen.name}") has draft.billingFrequency = "${item.draft.billingFrequency}" (source: ${item.draft.billingFrequencySource ?? "unknown"}), but Billing Treatment "${bt?.billingTreatmentName ?? bt?.billingTreatmentId}" does not allow changing Billing Frequency (CanChangeBillingFrequency = false), and the Selling Model's own resolved value is "${natural.value}". Salesforce will reject this mismatch with "Add a Billing Treatment to make sure that you can change the Billing Frequency of its related Order Item." — use "${natural.value}" for this line instead.`,
        invalidValue: item.draft.billingFrequency, salesforceObject: "BillingTreatment",
        productId: item.draft.productId, productName: item.draft.product.name,
        sellingModel: sm, billingFrequency: { draftValue: item.draft.billingFrequency, naturalValue: natural.value, canChangeBillingFrequency: bt?.canChangeBillingFrequency ?? null },
        path: item.path, code: "BILLING_FREQUENCY_NOT_CHANGEABLE",
      });
    }
  }

  logStep("Create Parent Lines", "start", { rootCount: flatItems.filter(i => i.parentIndex === null).length }, null, "Creating order line items in dependency order (parents first, then children).");
  const creation = await createInDependencyOrderedPasses(client, flatItems, orderId, oiSchema, s => steps.push(s));
  if (!creation.success) {
    const failedItem = creation.failedIndex != null ? flatItems[creation.failedIndex] : null;
    const failedSellingModel = failedItem ? sellingModels.get(failedItem.draft.productId) ?? null : null;
    return fail({
      currentStep: failedItem?.parentIndex != null ? "Create Child Lines" : "Create Parent Lines",
      validationRule: "Salesforce must accept the OrderItem create call",
      reason: creation.error ?? "Failed to create order line items.",
      salesforceObject: "OrderItem",
      generatedPayload: creation.failedIndex != null ? builtPayloads[creation.failedIndex]?.payload : builtPayloads.map(b => b.payload),
      productId: failedItem?.draft.productId ?? null,
      productName: failedItem?.draft.product.name ?? null,
      sellingModel: failedSellingModel,
      billingFrequency: failedItem ? { draftValue: failedItem.draft.billingFrequency, source: failedItem.draft.billingFrequencySource } : null,
      code: "CREATE_FAILED",
      rollbackRecords: [{ sobject: "OrderItem", ids: [...creation.idByIndex.values()] }],
    });
  }
  logStep("Create Parent Lines", "success", null, { createdCount: creation.idByIndex.size }, `Created ${creation.idByIndex.size} order line item(s) across dependency-ordered passes.`);

  // §Investigation Required (repricing failure ticket) — same field set as
  // the Quote side (lib/quotes/server/lineItemCreate.ts): everything needed
  // to diff a created OrderItem against one added through native Salesforce.
  logStep(
    "Verify Created Line Items", "info", null,
    flatItems.map(item => {
      const id = creation.idByIndex.get(item.index) ?? null;
      const sm = sellingModels.get(item.draft.productId);
      const bt = billingTreatments[item.draft.productId] as BillingTreatmentValidation | undefined;
      return {
        orderItemId: id,
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
    `Complete per-line field snapshot for ${creation.idByIndex.size} created OrderItem(s) — compare against a bundle added through native Salesforce if repricing still fails after this.`,
  );

  logStep("Create Relationships", "start", { edgeCount: flatItems.filter(i => i.parentIndex !== null).length, mechanism: oirSchema.mechanism }, null, "Creating native bundle relationship records for every parent/child edge.");
  const relationships = await createNativeBundleRelationships(client, flatItems, creation.idByIndex, oirSchema, s => steps.push(s));
  if (!relationships.success) {
    return fail({
      currentStep: "Create Relationships",
      validationRule: "every bundle edge must produce a valid relationship record",
      reason: relationships.error ?? "Failed to create bundle relationships.",
      salesforceObject: oirSchema.objectName ?? "OrderItemRelationship",
      generatedPayload: relationships.payloads,
      code: "RELATIONSHIP_CREATE_FAILED",
      rollbackRecords: [
        { sobject: oirSchema.objectName ?? "OrderItemRelationship", ids: relationships.createdIds },
        { sobject: "OrderItem", ids: [...creation.idByIndex.values()] },
      ],
    });
  }
  logStep("Create Relationships", "success", null, { createdCount: relationships.createdIds.length }, `Created ${relationships.createdIds.length} relationship record(s).`);

  const attrCreated: string[] = [];
  if (oiAttrSchema.objectName && oiAttrSchema.orderItemField && oiAttrSchema.attributeField && oiAttrSchema.valueField) {
    const attrPayloads: Record<string, unknown>[] = [];
    for (const item of flatItems) {
      const oiId = creation.idByIndex.get(item.index);
      if (!oiId) continue;
      for (const [attributeId, value] of Object.entries(item.draft.attributeValues)) {
        attrPayloads.push({
          [oiAttrSchema.orderItemField.apiName]: oiId,
          [oiAttrSchema.attributeField.apiName]: attributeId,
          [oiAttrSchema.valueField.apiName]: value,
        });
      }
    }
    if (attrPayloads.length > 0) {
      logStep("Create Attributes", "start", { count: attrPayloads.length }, attrPayloads, `Creating ${attrPayloads.length} OrderItemAttribute record(s).`);
      try {
        for (let offset = 0; offset < attrPayloads.length; offset += 200) {
          const chunk = attrPayloads.slice(offset, offset + 200);
          const results = await client.compositeCreate(oiAttrSchema.objectName, chunk, false);
          for (const r of results) {
            if (r.success && r.id) attrCreated.push(r.id);
            else throw new Error(r.errors?.[0]?.message ?? "Failed to create an OrderItemAttribute record.");
          }
        }
        logStep("Create Attributes", "success", { count: attrPayloads.length }, { createdCount: attrCreated.length }, `Created ${attrCreated.length} attribute value record(s).`);
      } catch (err) {
        return fail({
          currentStep: "Create Attributes",
          validationRule: "every attribute value record must be accepted by Salesforce",
          reason: err instanceof Error ? err.message : "Failed to create attribute records.",
          salesforceObject: oiAttrSchema.objectName, generatedPayload: attrPayloads,
          code: "ATTRIBUTE_CREATE_FAILED",
          rollbackRecords: [
            { sobject: oiAttrSchema.objectName, ids: attrCreated },
            { sobject: oirSchema.objectName ?? "OrderItemRelationship", ids: relationships.createdIds },
            { sobject: "OrderItem", ids: [...creation.idByIndex.values()] },
          ],
        });
      }
    }
  }

  let repricing = null;
  if (oiSchema.pricingModel === "RevenueCloudPricing") {
    logStep("Reprice", "start", { orderId }, null, "Triggering Salesforce repricing for a RevenueCloudPricing org.");
    repricing = await repriceOrder(client, orderId);
    logStep("Reprice", repricing.succeeded ? "success" : "error", { orderId }, repricing, repricing.message ?? "Repricing complete.");
  }

  logStep("Verification", "start", { createdCount: creation.idByIndex.size }, null, "Re-querying created order line items for verification.");
  const createdIds = [...creation.idByIndex.values()];
  const refreshedLineItems = await readBackOrderItems(client, oiSchema, creation, flatItems);
  let bundleHierarchyValid = true;
  const issues: string[] = [];
  if (hasBundleStructure && oirSchema.mechanism === "relationship-object" && oirSchema.objectName && oirSchema.mainOrderItemField) {
    try {
      const idList = createdIds.map(id => `'${soqlEscape(id)}'`).join(",");
      const check = await client.query<Record<string, unknown>>(
        `SELECT Id FROM ${oirSchema.objectName} WHERE ${oirSchema.mainOrderItemField.apiName} IN (${idList})`,
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
  logStep("Verification", "success", { createdCount: creation.idByIndex.size }, { refreshedCount: refreshedLineItems.length, bundleHierarchyValid, issues }, `Verified ${refreshedLineItems.length} created order line item(s).`);

  return {
    success: true,
    createdIds,
    createdCount: createdIds.length,
    bundleHierarchyValid,
    issues,
    steps,
    repricing,
    errors,
    refreshedLineItems,
    failureDetail: null,
  };
}

async function readBackOrderItems(
  client: SalesforceClient,
  oiSchema: Awaited<ReturnType<typeof resolveOrderItemFieldSchema>>,
  creation: { idByIndex: Map<number, string> },
  flatItems: FlatDraftItem[],
): Promise<RefreshedOrderItem[]> {
  const ids = [...creation.idByIndex.values()];
  if (ids.length === 0) return [];

  const selectFields = ["Id"];
  if (oiSchema.quantityField) selectFields.push(oiSchema.quantityField.apiName);
  if (oiSchema.unitPriceField) selectFields.push(oiSchema.unitPriceField.apiName);
  if (oiSchema.listPriceField) selectFields.push(oiSchema.listPriceField.apiName);
  if (oiSchema.discountField) selectFields.push(oiSchema.discountField.apiName);
  if (oiSchema.totalPriceField) selectFields.push(oiSchema.totalPriceField.apiName);
  if (oiSchema.rootItemField) selectFields.push(oiSchema.rootItemField.apiName);
  if (oiSchema.parentItemField) selectFields.push(oiSchema.parentItemField.apiName);

  let rows: Record<string, unknown>[] = [];
  try {
    const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await client.query<Record<string, unknown>>(`SELECT ${selectFields.join(", ")} FROM OrderItem WHERE Id IN (${idList})`);
    rows = res.records;
  } catch {
    rows = [];
  }
  const rowById = new Map(rows.map(r => [r.Id as string, r]));

  const nodesByIndex = new Map<number, RefreshedOrderItem>();
  for (const item of flatItems) {
    const id = creation.idByIndex.get(item.index);
    if (!id) continue;
    const row = rowById.get(id) ?? {};
    nodesByIndex.set(item.index, {
      id,
      productId: item.draft.productId,
      productName: item.draft.product.name,
      quantity: oiSchema.quantityField ? ((row[oiSchema.quantityField.apiName] as number) ?? item.draft.quantity) : item.draft.quantity,
      unitPrice: oiSchema.unitPriceField ? ((row[oiSchema.unitPriceField.apiName] as number) ?? 0) : 0,
      listPrice: oiSchema.listPriceField ? ((row[oiSchema.listPriceField.apiName] as number) ?? 0) : 0,
      discount: oiSchema.discountField ? ((row[oiSchema.discountField.apiName] as number) ?? 0) : 0,
      totalPrice: oiSchema.totalPriceField ? ((row[oiSchema.totalPriceField.apiName] as number) ?? 0) : 0,
      parentDraftId: item.draft.parentDraftId,
      rootItemId: oiSchema.rootItemField
        ? ((row[oiSchema.rootItemField.apiName] as string) ?? null)
        : (item.rootIndex !== item.index ? (creation.idByIndex.get(item.rootIndex) ?? null) : null),
      parentItemId: oiSchema.parentItemField
        ? ((row[oiSchema.parentItemField.apiName] as string) ?? null)
        : (item.parentIndex != null ? (creation.idByIndex.get(item.parentIndex) ?? null) : null),
      children: [],
    });
  }
  for (const item of flatItems) {
    if (item.parentIndex == null) continue;
    const parent = nodesByIndex.get(item.parentIndex);
    const child = nodesByIndex.get(item.index);
    if (parent && child) parent.children.push(child);
  }
  return flatItems.filter(i => i.parentIndex === null).map(i => nodesByIndex.get(i.index)!).filter(Boolean);
}
