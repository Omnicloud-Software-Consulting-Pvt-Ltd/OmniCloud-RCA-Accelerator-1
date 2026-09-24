import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, filterDependentPicklistValues } from "@/lib/salesforce/describe";
import { resolveRealDefaultForField } from "@/lib/quotes/util/realDefaults";
import type {
  BundleHierarchyStep,
  QuoteLineItemDraft,
  QuoteLineItemFieldSchema,
  QuoteLineRelationshipFieldSchema,
} from "@/lib/quotes/types";

export interface FlatDraftItem {
  draft: QuoteLineItemDraft;
  index: number;
  parentIndex: number | null;
  /** Flat index of the top-level bundle root this item descends from (its own index, if it IS a root). */
  rootIndex: number;
  path: string[];
}

/** Flatten a draft forest into dependency-orderable items, each knowing its parent's AND its ultimate bundle root's flat index (§2.7). */
export function flattenForestWithParentIndex(roots: QuoteLineItemDraft[]): FlatDraftItem[] {
  const flat: FlatDraftItem[] = [];
  function walk(node: QuoteLineItemDraft, parentIndex: number | null, rootIndex: number | null, path: string[]) {
    const index = flat.length;
    const resolvedRootIndex = rootIndex ?? index;
    flat.push({ draft: node, index, parentIndex, rootIndex: resolvedRootIndex, path });
    for (const child of node.children) walk(child, index, resolvedRootIndex, [...path, child.product.name]);
  }
  for (const root of roots) walk(root, null, null, [root.product.name]);
  return flat;
}

/**
 * §Confirmed $0.00 bug fix — the create payload's starting price must be
 * decided from this org's actual Describe capabilities, never from the
 * coarse `pricingModel` label. `pricingModel` classifies to
 * "RevenueCloudPricing" merely because NetUnitPrice/NetTotalPrice/
 * PricingStatus-shaped fields EXIST on this org's QuoteLineItem (see
 * diagnosePricingModel, lib/quotes/metadata/lineItemFields.ts) — that is
 * evidence a pricing engine COULD own the price, not proof that Salesforce
 * will compute one for a QLI inserted with no starting price at all.
 * Runtime evidence (Price Pipeline Trace) proved the opposite in this org:
 * omitting a starting price at create time inserts the QuoteLineItem at
 * $0.00, and nothing downstream ever populates it.
 *
 * The correct question is "what pricing input does this QuoteLineItem
 * object actually accept?" — answered purely from real Describe evidence:
 * UnitPrice first (if createable and not calculated), else ListPrice (if
 * createable and not calculated). Only when NEITHER is writable does this
 * genuinely become a Salesforce-engine-owned field, and the payload
 * correctly omits a starting price.
 */
export function resolveInitialPricingField(
  qliSchema: QuoteLineItemFieldSchema,
): { apiName: string | null; source: "UnitPrice" | "ListPrice" | null } {
  const evidence = qliSchema.pricingModelDiagnosis.evidence;
  if (evidence.unitPrice?.createable && !evidence.unitPrice.calculated) {
    return { apiName: evidence.unitPrice.apiName, source: "UnitPrice" };
  }
  if (evidence.listPrice?.createable && !evidence.listPrice.calculated) {
    return { apiName: evidence.listPrice.apiName, source: "ListPrice" };
  }
  return { apiName: null, source: null };
}

/**
 * §Salesforce's own pricing/configuration engine (Get Products and Prices /
 * Calculate — "We couldn't refresh the prices and validate the
 * configuration" when this data is missing) uses QuoteLineItem's own
 * RootId/ParentItemId self-reference fields to identify which lines form one
 * bundle configuration — independent of whether this org ALSO has a
 * dedicated QuoteLineRelationship object. These are populated on EVERY
 * non-root line whenever the fields exist on this org's QuoteLineItem, not
 * only when "self-reference" is the org's ONLY bundle-hierarchy mechanism —
 * a real Revenue Cloud org commonly has both simultaneously, and previously
 * only the relationship-object records were created, leaving RootId/
 * ParentItemId null even though the fields were already being resolved via
 * Describe (`lib/quotes/metadata/lineItemFields.ts`) and simply never
 * written to the create payload.
 */
export function buildQLIPayload(
  item: FlatDraftItem,
  quoteId: string,
  qliSchema: QuoteLineItemFieldSchema,
  parentRealId: string | null,
  rootRealId: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const d = item.draft;
  if (qliSchema.quoteField) payload[qliSchema.quoteField.apiName] = quoteId;
  if (qliSchema.pricebookEntryField) payload[qliSchema.pricebookEntryField.apiName] = d.product.pricebookEntryId;
  if (qliSchema.productField) payload[qliSchema.productField.apiName] = d.productId;
  if (qliSchema.quantityField) payload[qliSchema.quantityField.apiName] = d.quantity;
  if (qliSchema.discountField) payload[qliSchema.discountField.apiName] = d.discountPercent;
  const initialPricingField = resolveInitialPricingField(qliSchema);
  if (initialPricingField.apiName) payload[initialPricingField.apiName] = d.unitPrice;
  // §List Price gap: on real Revenue Cloud orgs, List Price mirrors the raw
  // PricebookEntry price and is a SEPARATE field from Sales Price/UnitPrice —
  // a manually-added QLI always has both. resolveInitialPricingField only
  // ever picks ONE of UnitPrice/ListPrice as the starting-price write target
  // (preferring UnitPrice when both are writable), which previously left
  // ListPrice completely unwritten — showing as 0.00 — whenever UnitPrice
  // won that choice. Written here from the SAME Describe evidence
  // resolveInitialPricingField already computed, only when ListPrice is
  // writable/non-calculated and wasn't already the field chosen above.
  const listPriceEvidence = qliSchema.pricingModelDiagnosis.evidence.listPrice;
  if (
    qliSchema.listPriceField && listPriceEvidence?.createable && !listPriceEvidence.calculated &&
    qliSchema.listPriceField.apiName !== initialPricingField.apiName
  ) {
    payload[qliSchema.listPriceField.apiName] = d.product.listPrice;
  }
  // §Selling Model field split: ProductSellingModel (parent) and
  // ProductSellingModelOption (child) are DISTINCT reference targets that
  // require DISTINCT values — never write the option's Id into a
  // parent-typed field or vice versa. sellingModelOptionId is only ever
  // populated on the draft with a REAL Salesforce Id (never a synthetic
  // `direct:` placeholder — see resolveSellingModelForProduct/toDirectOption
  // in lib/quotes/catalog/sellingModel.ts), so no synthetic-value check is
  // needed here.
  if (qliSchema.sellingModelField && d.sellingModelId) payload[qliSchema.sellingModelField.apiName] = d.sellingModelId;
  if (qliSchema.sellingModelOptionField && d.sellingModelOptionId) payload[qliSchema.sellingModelOptionField.apiName] = d.sellingModelOptionId;
  if (qliSchema.billingFrequencyField && d.billingFrequency) payload[qliSchema.billingFrequencyField.apiName] = d.billingFrequency;
  if (qliSchema.subscriptionTermField && d.subscriptionTerm != null) payload[qliSchema.subscriptionTermField.apiName] = d.subscriptionTerm;
  if (parentRealId && qliSchema.parentItemField) payload[qliSchema.parentItemField.apiName] = parentRealId;
  if (rootRealId && qliSchema.rootItemField) payload[qliSchema.rootItemField.apiName] = rootRealId;
  return payload;
}

/** Payload-integrity preflight (§4.7, §5.8 step 8) — the fields a create call cannot proceed without. */
export function integrityCheckPayload(payload: Record<string, unknown>, qliSchema: QuoteLineItemFieldSchema): string[] {
  const missing: string[] = [];
  if (qliSchema.quoteField && !payload[qliSchema.quoteField.apiName]) missing.push("Quote reference");
  if (qliSchema.pricebookEntryField && !payload[qliSchema.pricebookEntryField.apiName]) missing.push("PricebookEntry reference");
  if (qliSchema.quantityField && (payload[qliSchema.quantityField.apiName] == null || (payload[qliSchema.quantityField.apiName] as number) <= 0)) {
    missing.push("a positive Quantity");
  }
  return missing;
}

export interface RequiredQuoteLineItemFieldResolution {
  apiName: string;
  label: string;
  type: string;
  selectedValue: unknown;
  reasonSelected: string;
}

export interface RequiredQuoteLineItemFieldAuditResult {
  success: boolean;
  extraFields: Record<string, unknown>;
  resolutions: RequiredQuoteLineItemFieldResolution[];
  error: string | null;
}

/**
 * Audit QuoteLineItem's own required+createable fields with no explicit
 * mapping (qliSchema.requiredFieldsNotMapped) and resolve a REAL value for
 * each — an org-marked default/sole-active-picklist-value/reusable-or-
 * auto-created reference record — exactly the same never-fabricate strategy
 * createNativeBundleRelationships already applies to the bundle relationship
 * object below. Resolved ONCE per create request (not per line): these are
 * QuoteLineItem-object-level requirements, not edge-specific data, so the
 * same extraFields are merged into every line's create payload (see
 * createInDependencyOrderedPasses's `extraFields` param). Returns
 * success:false (never a fabricated value) when any field can't be resolved
 * — this is the mechanism that surfaces "Salesforce Setup must define a
 * default for QuoteLineItem.<field>" instead of silently omitting a field a
 * real org requires for Revenue Cloud configuration/pricing to make sense of
 * the record (e.g. what native "Refresh Prices" later reads).
 */
export async function resolveRequiredQuoteLineItemFields(
  client: SalesforceClient,
  qliSchema: QuoteLineItemFieldSchema,
): Promise<RequiredQuoteLineItemFieldAuditResult> {
  if (qliSchema.requiredFieldsNotMapped.length === 0) {
    return { success: true, extraFields: {}, resolutions: [], error: null };
  }
  let describe: DescribeResult;
  try {
    describe = await describeObjectCached(client, "QuoteLineItem");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to Describe QuoteLineItem.";
    return { success: false, extraFields: {}, resolutions: [], error: message };
  }

  const extraFields: Record<string, unknown> = {};
  const resolutions: RequiredQuoteLineItemFieldResolution[] = [];
  for (const ref of qliSchema.requiredFieldsNotMapped) {
    const field = describe.fields.find(f => f.name === ref.apiName);
    if (!field) continue;

    let selectedValue: unknown;
    let reasonSelected: string;
    if (field.type === "boolean") {
      selectedValue = false;
      reasonSelected = "Boolean field defaulted to false.";
    } else if (field.type === "picklist" || field.type === "multipicklist") {
      const active = field.picklistValues?.filter(v => v.active) ?? [];
      const withDefault = active.find(v => v.defaultValue);
      selectedValue = withDefault?.value ?? (active.length === 1 ? active[0].value : undefined);
      reasonSelected = selectedValue === undefined
        ? `${active.length} active value(s), none marked default and not exactly one option.`
        : withDefault ? "Org-marked active default." : "Sole active picklist value.";
    } else if (field.type === "reference") {
      selectedValue = await resolveRealDefaultForField(client, "QuoteLineItem", field.name, field.type, field.picklistValues);
      reasonSelected = selectedValue === undefined
        ? "Reference field: no existing record to reuse and no resolvable default for its own required fields."
        : "Reference field: reused/created a real record via resolveRealDefaultForField.";
    } else {
      selectedValue = undefined;
      reasonSelected = `Field type "${field.type}" has no automatic resolution strategy.`;
    }

    resolutions.push({ apiName: field.name, label: field.label, type: field.type, selectedValue, reasonSelected });
    if (selectedValue === undefined) {
      return {
        success: false, extraFields, resolutions,
        error: `Required QuoteLineItem field "${field.name}" (${field.label}, type ${field.type}) could not be resolved automatically. ${reasonSelected} This app never fabricates a value for a field Salesforce hasn't defined a resolvable default for — Salesforce Setup must define an active default value (or reduce this to a single active option) for QuoteLineItem.${field.name}.`,
      };
    }
    extraFields[field.name] = selectedValue;
  }
  return { success: true, extraFields, resolutions, error: null };
}

export interface PassCreationResult {
  success: boolean;
  idByIndex: Map<number, string>;
  error: string | null;
  failedIndex: number | null;
}

/**
 * Create QuoteLineItems in dependency-ordered passes (§2.7, §5.8 step 9):
 * pass 0 creates every item with no unresolved parent; each later pass
 * creates items whose parent now has a real Id, substituting it into the
 * child's own parent-reference field where that mechanism applies.
 */
export async function createInDependencyOrderedPasses(
  client: SalesforceClient,
  flatItems: FlatDraftItem[],
  quoteId: string,
  qliSchema: QuoteLineItemFieldSchema,
  onStep: (step: BundleHierarchyStep) => void,
  extraFields: Record<string, unknown> = {},
): Promise<PassCreationResult> {
  const idByIndex = new Map<number, string>();
  const remaining = new Set(flatItems.map(i => i.index));
  const byIndex = new Map(flatItems.map(i => [i.index, i]));
  let passNumber = 0;

  while (remaining.size > 0) {
    const passItems = [...remaining].map(i => byIndex.get(i)!).filter(item => item.parentIndex === null || idByIndex.has(item.parentIndex));
    if (passItems.length === 0) {
      return { success: false, idByIndex, error: "Dependency cycle or unresolved parent detected while creating line items.", failedIndex: [...remaining][0] ?? null };
    }
    onStep({ step: `create-pass-${passNumber}`, status: "start", message: `Creating ${passItems.length} line item(s) (pass ${passNumber}).`, timestamp: Date.now() });

    const chunkSize = 200;
    for (let offset = 0; offset < passItems.length; offset += chunkSize) {
      const chunkItems = passItems.slice(offset, offset + chunkSize);
      const chunkPayloads = chunkItems.map(item => ({
        ...extraFields,
        ...buildQLIPayload(
          item, quoteId, qliSchema,
          item.parentIndex != null ? (idByIndex.get(item.parentIndex) ?? null) : null,
          item.rootIndex !== item.index ? (idByIndex.get(item.rootIndex) ?? null) : null,
        ),
      }));

      let results;
      try {
        results = await client.compositeCreate("QuoteLineItem", chunkPayloads, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Line item creation failed.";
        onStep({ step: `create-pass-${passNumber}`, status: "error", message, timestamp: Date.now() });
        return { success: false, idByIndex, error: message, failedIndex: chunkItems[0]?.index ?? null };
      }

      for (let k = 0; k < results.length; k++) {
        const result = results[k];
        const item = chunkItems[k];
        if (result.success && result.id) {
          idByIndex.set(item.index, result.id);
        } else {
          const message = result.errors?.[0]?.message ?? "Unknown error creating line item.";
          onStep({ step: `create-pass-${passNumber}`, status: "error", message: `Failed to create "${item.draft.product.name}": ${message}`, timestamp: Date.now() });
          return { success: false, idByIndex, error: message, failedIndex: item.index };
        }
      }
    }

    for (const item of passItems) remaining.delete(item.index);
    onStep({ step: `create-pass-${passNumber}`, status: "success", message: `Pass ${passNumber} created ${passItems.length} line item(s).`, timestamp: Date.now() });
    passNumber += 1;
  }

  return { success: true, idByIndex, error: null, failedIndex: null };
}

/** Best-effort rollback — never throws; a failure to delete one stray record must not mask the original error. */
export async function rollbackRecords(client: SalesforceClient, sobject: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await client.compositeDelete(ids, false);
  } catch {
    /* best effort — nothing further we can do server-side */
  }
}

export interface RelationshipCreationResult {
  success: boolean;
  createdIds: string[];
  error: string | null;
  /** The QuoteLineRelationship payload(s) as built — present even on failure, so the caller can surface exactly what was (or would have been) sent. */
  payloads: Record<string, unknown>[];
}

interface FieldResolutionDiagnostics {
  apiName: string;
  label: string;
  type: string;
  restrictedPicklist: boolean;
  controllerName: string | null;
  activeValues: string[];
  inactiveValues: string[];
  defaultValue: string | null;
  controllingValue: unknown;
  validValuesForController: string[] | null;
  selectedValue: unknown;
  reasonSelected: string;
}

/**
 * Resolve ONE required-and-unmapped field for ONE specific relationship
 * edge (§Remove Guesswork) — never fabricates a value. Dependent-picklist
 * aware: if the field has a `controllerName`, the controlling field's
 * ACTUAL value for THIS edge (read from the payload already built for it —
 * e.g. RelationshipTypeId, which can vary per edge) is used to filter to
 * only the values Salesforce's own `validFor` metadata allows, and a
 * value is chosen ONLY from that filtered set (its marked default, or the
 * sole remaining option). Returns `{ diagnostics }` with `selectedValue:
 * undefined` when nothing can be resolved — the caller must treat that as
 * a hard stop, never a fabricated fallback.
 */
async function resolveRequiredFieldForEdge(
  client: SalesforceClient,
  sobject: string,
  describe: DescribeResult,
  field: DescribeField,
  edgePayloadSoFar: Record<string, unknown>,
): Promise<FieldResolutionDiagnostics> {
  const base: Omit<FieldResolutionDiagnostics, "selectedValue" | "reasonSelected" | "controllingValue" | "validValuesForController"> = {
    apiName: field.name,
    label: field.label,
    type: field.type,
    restrictedPicklist: !!field.restrictedPicklist,
    controllerName: field.controllerName ?? null,
    activeValues: field.picklistValues?.filter(v => v.active).map(v => v.value) ?? [],
    inactiveValues: field.picklistValues?.filter(v => !v.active).map(v => v.value) ?? [],
    defaultValue: field.picklistValues?.find(v => v.active && v.defaultValue)?.value ?? null,
  };

  if (field.type === "picklist" || field.type === "multipicklist") {
    if (field.controllerName) {
      const controllerField = describe.fields.find(f => f.name === field.controllerName) ?? null;
      const controllingValue = edgePayloadSoFar[field.controllerName];
      if (controllerField && controllingValue !== undefined) {
        const filtered = filterDependentPicklistValues(field, controllerField, controllingValue as string | boolean);
        const filteredDefault = filtered.find(v => v.defaultValue)?.value;
        const selected = filteredDefault ?? (filtered.length === 1 ? filtered[0].value : undefined);
        return {
          ...base, controllingValue, validValuesForController: filtered.map(v => v.value), selectedValue: selected,
          reasonSelected: selected === undefined
            ? `${filtered.length} value(s) valid for controller "${field.controllerName}" = ${JSON.stringify(controllingValue)}, none marked default and not exactly one option — cannot pick automatically.`
            : filteredDefault ? `Marked default among values valid for controller "${field.controllerName}" = ${JSON.stringify(controllingValue)}.` : `Sole value valid for controller "${field.controllerName}" = ${JSON.stringify(controllingValue)}.`,
        };
      }
      // Controller's value isn't known for this edge — degrade to the field's own global default/sole-active rather than fabricating a filter.
      return resolveIndependentPicklist(base, field, `Controller "${field.controllerName}" value not available for this edge — falling back to the field's own unfiltered active values.`);
    }
    return resolveIndependentPicklist(base, field, null);
  }

  if (field.type === "boolean") {
    return { ...base, controllingValue: null, validValuesForController: null, selectedValue: false, reasonSelected: "Boolean field defaulted to false." };
  }

  if (field.type === "reference") {
    const value = await resolveRealDefaultForField(client, sobject, field.name, field.type, field.picklistValues);
    return {
      ...base, controllingValue: null, validValuesForController: null, selectedValue: value,
      reasonSelected: value === undefined ? "Reference field: no existing record to reuse and no resolvable default for its own required fields." : "Reference field: reused/created a real record via resolveRealDefaultForField.",
    };
  }

  return { ...base, controllingValue: null, validValuesForController: null, selectedValue: undefined, reasonSelected: `Field type "${field.type}" has no automatic resolution strategy.` };
}

function resolveIndependentPicklist(
  base: Omit<FieldResolutionDiagnostics, "selectedValue" | "reasonSelected" | "controllingValue" | "validValuesForController">,
  field: DescribeField,
  fallbackNote: string | null,
): FieldResolutionDiagnostics {
  const active = field.picklistValues?.filter(v => v.active) ?? [];
  const withDefault = active.find(v => v.defaultValue);
  const selected = withDefault?.value ?? (active.length === 1 ? active[0].value : undefined);
  const reason = selected === undefined
    ? `${active.length} active value(s), none marked default and not exactly one option.`
    : withDefault ? "Org-marked active default." : "Sole active picklist value.";
  return {
    ...base, controllingValue: null, validValuesForController: null, selectedValue: selected,
    reasonSelected: fallbackNote ? `${fallbackNote} ${reason}` : reason,
  };
}

export interface InvalidBundleEdge {
  parentProductId: string;
  parentName: string;
  childProductId: string;
  childName: string;
  candidateId: string;
  expectedObject: string;
}

export interface BundleEdgeValidationResult {
  valid: boolean;
  error: string | null;
  invalidEdges: InvalidBundleEdge[];
}

/**
 * §Fail before mutate (§Issue 1B): verify every bundle edge's candidate
 * relationship-component Id genuinely belongs to the object the resolved
 * QuoteLineRelationship field actually references (bundleDiscovery's
 * relationshipObject, e.g. ProductRelatedComponent) — BEFORE any
 * QuoteLineItem is created, not after Salesforce rejects the relationship
 * create with "id value of incorrect type".
 *
 * A candidate Id's source object is never assumed from where it was
 * populated or what a variable happens to be named — Salesforce's own
 * object-typed SOQL is the authority: a query against the wrong object
 * for a real Id of a different object returns zero rows. This needs no
 * key-prefix table and no guess about which object an unfamiliar Id
 * prefix belongs to.
 */
export async function validateBundleRelationshipEdges(
  client: SalesforceClient,
  flatItems: FlatDraftItem[],
  qlrSchema: QuoteLineRelationshipFieldSchema,
  relationshipObjectName: string | null,
): Promise<BundleEdgeValidationResult> {
  const edges = flatItems.filter(i => i.parentIndex !== null);
  if (qlrSchema.mechanism !== "relationship-object" || !qlrSchema.relatedComponentField || !relationshipObjectName || edges.length === 0) {
    return { valid: true, error: null, invalidEdges: [] };
  }

  const candidateIds = [...new Set(edges.map(e => e.draft.relatedComponentId).filter((id): id is string => !!id))];
  if (candidateIds.length === 0) return { valid: true, error: null, invalidEdges: [] };

  let foundIds: Set<string>;
  try {
    const idList = candidateIds.map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ${relationshipObjectName} WHERE Id IN (${idList})`);
    foundIds = new Set(res.records.map(r => r.Id));
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to verify candidate ${relationshipObjectName} Ids.`;
    return { valid: false, error: `Could not verify bundle relationship component Ids against ${relationshipObjectName}: ${message}`, invalidEdges: [] };
  }

  const invalidEdges: InvalidBundleEdge[] = [];
  for (const edge of edges) {
    const candidateId = edge.draft.relatedComponentId;
    if (!candidateId || foundIds.has(candidateId)) continue;
    const parent = flatItems[edge.parentIndex!];
    invalidEdges.push({
      parentProductId: parent.draft.productId,
      parentName: parent.draft.product.name,
      childProductId: edge.draft.productId,
      childName: edge.draft.product.name,
      candidateId,
      expectedObject: relationshipObjectName,
    });
  }
  if (invalidEdges.length === 0) return { valid: true, error: null, invalidEdges: [] };

  const error = invalidEdges
    .map(e =>
      `Bundle relationship could not be resolved. Parent: ${e.parentName} Parent Product2Id: ${e.parentProductId} ` +
      `Child: ${e.childName} Child Product2Id: ${e.childProductId} Expected relationship reference: ${e.expectedObject} Candidate: ${e.candidateId}`,
    )
    .join(" | ");
  return { valid: false, error, invalidEdges };
}

/**
 * Create the native bundle relationship records linking parent/child
 * QuoteLineItems by their real, just-created Ids (§5.5, §5.8 step 11).
 * No-op (success, zero created) when the mechanism is self-reference
 * (already embedded at QLI creation time) or when there are no edges.
 */
export async function createNativeBundleRelationships(
  client: SalesforceClient,
  flatItems: FlatDraftItem[],
  idByIndex: Map<number, string>,
  qlrSchema: QuoteLineRelationshipFieldSchema,
  onStep: (step: BundleHierarchyStep) => void,
): Promise<RelationshipCreationResult> {
  const edges = flatItems.filter(i => i.parentIndex !== null);
  if (qlrSchema.mechanism !== "relationship-object" || !qlrSchema.objectName || edges.length === 0) {
    return { success: true, createdIds: [], error: null, payloads: [] };
  }

  onStep({ step: "create-relationships", status: "start", message: `Creating ${edges.length} bundle relationship record(s).`, timestamp: Date.now() });

  let describe: DescribeResult;
  try {
    describe = await describeObjectCached(client, qlrSchema.objectName);
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to Describe ${qlrSchema.objectName}.`;
    onStep({ step: "audit-relationship-fields", status: "error", message, timestamp: Date.now() });
    return { success: false, createdIds: [], error: message, payloads: [] };
  }

  if (qlrSchema.requiredFieldsNotMapped.length > 0) {
    onStep({
      step: "audit-relationship-fields", status: "start",
      message: `Auditing ${qlrSchema.requiredFieldsNotMapped.length} required ${qlrSchema.objectName} field(s) with no explicit mapping: ${qlrSchema.requiredFieldsNotMapped.map(f => f.apiName).join(", ")}.`,
      timestamp: Date.now(),
    });
    for (const ref of qlrSchema.requiredFieldsNotMapped) {
      const field = describe.fields.find(f => f.name === ref.apiName);
      if (!field) continue;
      onStep({
        step: "audit-relationship-fields", status: "info",
        message: `${qlrSchema.objectName}.${field.name}: type=${field.type}, restrictedPicklist=${!!field.restrictedPicklist}, controllerName=${field.controllerName ?? "none"}, activeValues=[${field.picklistValues?.filter(v => v.active).map(v => v.value).join(", ") ?? ""}], defaultValue=${field.picklistValues?.find(v => v.active && v.defaultValue)?.value ?? "none"}.`,
        timestamp: Date.now(),
      });
    }
  }

  // §Verify Payload / §Log Picklist Values: resolve required-but-unmapped
  // fields PER EDGE, not once globally — a dependent picklist's valid
  // values can depend on a field (like RelationshipTypeId) that varies
  // per edge, so a single global value would be wrong for some edges.
  const payloads: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const payload: Record<string, unknown> = {};
    const parentId = idByIndex.get(edge.parentIndex!);
    const childId = idByIndex.get(edge.index);
    if (qlrSchema.mainQuoteLineField && parentId) payload[qlrSchema.mainQuoteLineField.apiName] = parentId;
    if (qlrSchema.associatedQuoteLineField && childId) payload[qlrSchema.associatedQuoteLineField.apiName] = childId;
    if (qlrSchema.relatedComponentField && edge.draft.relatedComponentId) payload[qlrSchema.relatedComponentField.apiName] = edge.draft.relatedComponentId;
    if (qlrSchema.relationshipTypeField && edge.draft.relationshipTypeId) payload[qlrSchema.relationshipTypeField.apiName] = edge.draft.relationshipTypeId;

    // §Bundle Pricing: every bundle child defaults to "included in the parent
    // bundle price" (edge.draft.pricingInclusion) — this must be serialized
    // as whatever real shape Salesforce's own field actually is, never a raw
    // boolean shoved into a picklist. Fail loudly (never fabricate) if a
    // picklist-shaped field's "included" value couldn't be identified from
    // Describe's own active values.
    if (qlrSchema.pricingInclusionField) {
      if (qlrSchema.pricingInclusionKind === "picklist") {
        const value = edge.draft.pricingInclusion ? qlrSchema.pricingInclusionIncludedValue : qlrSchema.pricingInclusionNotIncludedValue;
        if (!value) {
          const message = `Cannot create bundle relationship for "${edge.draft.product.name}": ${qlrSchema.objectName}.${qlrSchema.pricingInclusionField.apiName} is a picklist but this app could not identify which of its active values means "${edge.draft.pricingInclusion ? "included in bundle price" : "not included / separately priced"}" from Describe. Salesforce Setup must expose an active value whose name/label contains "Included"/"Not Included" wording for this field, or the app must be told explicitly which value to use — never fabricated.`;
          onStep({ step: "audit-relationship-fields", status: "error", message, timestamp: Date.now() });
          return { success: false, createdIds: [], error: message, payloads: [...payloads, payload] };
        }
        payload[qlrSchema.pricingInclusionField.apiName] = value;
        onStep({
          step: "audit-relationship-fields", status: "success",
          message: `${qlrSchema.objectName}.${qlrSchema.pricingInclusionField.apiName} for "${edge.draft.product.name}" = "${value}" (edge.draft.pricingInclusion=${edge.draft.pricingInclusion}; included="${qlrSchema.pricingInclusionIncludedValue}", notIncluded="${qlrSchema.pricingInclusionNotIncludedValue}").`,
          timestamp: Date.now(),
        });
      } else if (qlrSchema.pricingInclusionKind === "boolean") {
        payload[qlrSchema.pricingInclusionField.apiName] = edge.draft.pricingInclusion;
      }
    }

    for (const ref of qlrSchema.requiredFieldsNotMapped) {
      const field = describe.fields.find(f => f.name === ref.apiName);
      if (!field) continue;
      const resolution = await resolveRequiredFieldForEdge(client, qlrSchema.objectName, describe, field, payload);
      onStep({
        step: "audit-relationship-fields", status: resolution.selectedValue !== undefined ? "success" : "error",
        message: `${qlrSchema.objectName}.${field.name} for "${edge.draft.product.name}": active=[${resolution.activeValues.join(", ")}] inactive=[${resolution.inactiveValues.join(", ")}] default=${resolution.defaultValue ?? "none"} restricted=${resolution.restrictedPicklist} controller=${resolution.controllerName ?? "none"} controllingValue=${JSON.stringify(resolution.controllingValue)} validForController=${resolution.validValuesForController ? `[${resolution.validValuesForController.join(", ")}]` : "n/a"} selected=${JSON.stringify(resolution.selectedValue)} reason="${resolution.reasonSelected}"`,
        timestamp: Date.now(),
      });
      if (resolution.selectedValue === undefined) {
        const message = `Cannot create bundle relationship for "${edge.draft.product.name}": required field ${qlrSchema.objectName}.${field.name} (type ${field.type}) could not be resolved automatically. ${resolution.reasonSelected} Active values: [${resolution.activeValues.join(", ")}]. This app never fabricates a value for a field Salesforce hasn't defined a resolvable default for — Salesforce Setup must define an active default value (or reduce this to a single active option) for ${qlrSchema.objectName}.${field.name}.`;
        onStep({ step: "audit-relationship-fields", status: "error", message, timestamp: Date.now() });
        return { success: false, createdIds: [], error: message, payloads: [...payloads, payload] };
      }
      payload[field.name] = resolution.selectedValue;
    }

    payloads.push(payload);
  }

  onStep({
    step: "verify-relationship-payload", status: "info",
    message: `Complete ${qlrSchema.objectName} payload for ${payloads.length} edge(s), immediately before create.`,
    detail: payloads,
    timestamp: Date.now(),
  });

  const createdIds: string[] = [];
  const chunkSize = 200;
  for (let offset = 0; offset < payloads.length; offset += chunkSize) {
    const chunk = payloads.slice(offset, offset + chunkSize);
    let results;
    try {
      results = await client.compositeCreate(qlrSchema.objectName, chunk, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create bundle relationship records.";
      onStep({ step: "create-relationships", status: "error", message, timestamp: Date.now() });
      return { success: false, createdIds, error: message, payloads };
    }
    for (const result of results) {
      if (result.success && result.id) {
        createdIds.push(result.id);
      } else {
        const message = result.errors?.[0]?.message ?? "Unknown error creating bundle relationship.";
        onStep({ step: "create-relationships", status: "error", message, timestamp: Date.now() });
        return { success: false, createdIds, error: message, payloads };
      }
    }
  }

  onStep({ step: "create-relationships", status: "success", message: `Created ${createdIds.length} bundle relationship record(s).`, timestamp: Date.now() });
  return { success: true, createdIds, error: null, payloads };
}
