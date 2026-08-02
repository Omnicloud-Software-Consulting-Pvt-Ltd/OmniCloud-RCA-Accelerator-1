import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { describeObjectCached, filterDependentPicklistValues } from "@/lib/salesforce/describe";
import { resolveRealDefaultForField } from "@/lib/quotes/util/realDefaults";
import type { BundleHierarchyStep, QuoteLineItemDraft } from "@/lib/quotes/types";
import type { OrderItemFieldSchema, OrderItemRelationshipFieldSchema } from "@/lib/orders/types";

export interface FlatDraftItem {
  draft: QuoteLineItemDraft;
  index: number;
  parentIndex: number | null;
  /** Flat index of the top-level bundle root this item descends from (its own index, if it IS a root). */
  rootIndex: number;
  path: string[];
}

/** Flatten a draft forest into dependency-orderable items (identical algorithm to the Quote side — the draft tree shape is shared, §8). */
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
 * §Same fix as the Quote side (lib/quotes/bundles/relationshipCreate.ts):
 * RootId/ParentItemId self-reference fields are populated on every non-root
 * line whenever they exist on this org's OrderItem, independent of whether
 * OrderItemRelationship records are ALSO being created — Salesforce's own
 * pricing/configuration engine relies on these regardless of mechanism.
 */
export function buildOrderItemPayload(
  item: FlatDraftItem,
  orderId: string,
  oiSchema: OrderItemFieldSchema,
  parentRealId: string | null,
  rootRealId: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const d = item.draft;
  if (oiSchema.orderField) payload[oiSchema.orderField.apiName] = orderId;
  if (oiSchema.pricebookEntryField) payload[oiSchema.pricebookEntryField.apiName] = d.product.pricebookEntryId;
  if (oiSchema.productField) payload[oiSchema.productField.apiName] = d.productId;
  if (oiSchema.quantityField) payload[oiSchema.quantityField.apiName] = d.quantity;

  // Unlike QuoteLineItem (which can be created "empty" and priced afterward
  // by a Revenue Cloud repricing call), standard OrderItem always requires a
  // UnitPrice or TotalPrice ("Product Subtotal") at create time — Salesforce
  // rejects the row otherwise, regardless of this org's diagnosed pricing
  // model. Resolve the unit price from the draft (itself sourced from the
  // resolved PricebookEntry's list price at product-configuration/bundle-
  // expansion time, §4.4) and always send it when the field is writable.
  // Only fall back to TotalPrice — and only then apply the Discount into the
  // total directly rather than sending both — when UnitPrice genuinely isn't
  // writable in this org (e.g. it's a calculated field).
  const resolvedUnitPrice = d.unitPrice ?? d.product.listPrice;
  if (oiSchema.unitPriceField && oiSchema.unitPriceWritable) {
    payload[oiSchema.unitPriceField.apiName] = resolvedUnitPrice;
    if (oiSchema.discountField) payload[oiSchema.discountField.apiName] = d.discountPercent;
  } else if (oiSchema.totalPriceField && oiSchema.totalPriceWritable) {
    const netUnitPrice = resolvedUnitPrice * (1 - d.discountPercent / 100);
    payload[oiSchema.totalPriceField.apiName] = Math.round(netUnitPrice * d.quantity * 100) / 100;
  }

  if (oiSchema.sellingModelOptionField && d.sellingModelOptionId) payload[oiSchema.sellingModelOptionField.apiName] = d.sellingModelOptionId;
  if (oiSchema.billingFrequencyField && d.billingFrequency) payload[oiSchema.billingFrequencyField.apiName] = d.billingFrequency;
  if (oiSchema.subscriptionTermField && d.subscriptionTerm != null) payload[oiSchema.subscriptionTermField.apiName] = d.subscriptionTerm;
  if (parentRealId && oiSchema.parentItemField) payload[oiSchema.parentItemField.apiName] = parentRealId;
  if (rootRealId && oiSchema.rootItemField) payload[oiSchema.rootItemField.apiName] = rootRealId;
  return payload;
}

export function integrityCheckPayload(payload: Record<string, unknown>, oiSchema: OrderItemFieldSchema): string[] {
  const missing: string[] = [];
  if (oiSchema.orderField && !payload[oiSchema.orderField.apiName]) missing.push("Order reference");
  if (oiSchema.pricebookEntryField && !payload[oiSchema.pricebookEntryField.apiName]) missing.push("PricebookEntry reference");
  if (oiSchema.quantityField && (payload[oiSchema.quantityField.apiName] == null || (payload[oiSchema.quantityField.apiName] as number) <= 0)) {
    missing.push("a positive Quantity");
  }

  // Standard OrderItem requires a UnitPrice or TotalPrice ("Product
  // Subtotal") at create time — never send a payload with neither, since
  // Salesforce would reject it with "Order Products must have a unit price
  // or total product amount." Catch that here, before the Salesforce call.
  const hasUnitPrice = !!oiSchema.unitPriceField && payload[oiSchema.unitPriceField.apiName] != null;
  const hasTotalPrice = !!oiSchema.totalPriceField && payload[oiSchema.totalPriceField.apiName] != null;
  if (!hasUnitPrice && !hasTotalPrice) {
    missing.push("a Unit Price or Total Price (Product Subtotal) — Order Products require one of these at creation time");
  }

  return missing;
}

export interface PassCreationResult {
  success: boolean;
  idByIndex: Map<number, string>;
  error: string | null;
  failedIndex: number | null;
}

/** Create OrderItems in dependency-ordered passes (parents before children) — same algorithm as the Quote side, targeting the "OrderItem" sobject. */
export async function createInDependencyOrderedPasses(
  client: SalesforceClient,
  flatItems: FlatDraftItem[],
  orderId: string,
  oiSchema: OrderItemFieldSchema,
  onStep: (step: BundleHierarchyStep) => void,
): Promise<PassCreationResult> {
  const idByIndex = new Map<number, string>();
  const remaining = new Set(flatItems.map(i => i.index));
  const byIndex = new Map(flatItems.map(i => [i.index, i]));
  let passNumber = 0;

  while (remaining.size > 0) {
    const passItems = [...remaining].map(i => byIndex.get(i)!).filter(item => item.parentIndex === null || idByIndex.has(item.parentIndex));
    if (passItems.length === 0) {
      return { success: false, idByIndex, error: "Dependency cycle or unresolved parent detected while creating order line items.", failedIndex: [...remaining][0] ?? null };
    }
    onStep({ step: `create-pass-${passNumber}`, status: "start", message: `Creating ${passItems.length} order line item(s) (pass ${passNumber}).`, timestamp: Date.now() });

    const chunkSize = 200;
    for (let offset = 0; offset < passItems.length; offset += chunkSize) {
      const chunkItems = passItems.slice(offset, offset + chunkSize);
      const chunkPayloads = chunkItems.map(item =>
        buildOrderItemPayload(
          item, orderId, oiSchema,
          item.parentIndex != null ? (idByIndex.get(item.parentIndex) ?? null) : null,
          item.rootIndex !== item.index ? (idByIndex.get(item.rootIndex) ?? null) : null,
        ),
      );

      let results;
      try {
        results = await client.compositeCreate("OrderItem", chunkPayloads, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Order line item creation failed.";
        onStep({ step: `create-pass-${passNumber}`, status: "error", message, timestamp: Date.now() });
        return { success: false, idByIndex, error: message, failedIndex: chunkItems[0]?.index ?? null };
      }

      for (let k = 0; k < results.length; k++) {
        const result = results[k];
        const item = chunkItems[k];
        if (result.success && result.id) {
          idByIndex.set(item.index, result.id);
        } else {
          const message = result.errors?.[0]?.message ?? "Unknown error creating order line item.";
          onStep({ step: `create-pass-${passNumber}`, status: "error", message: `Failed to create "${item.draft.product.name}": ${message}`, timestamp: Date.now() });
          return { success: false, idByIndex, error: message, failedIndex: item.index };
        }
      }
    }

    for (const item of passItems) remaining.delete(item.index);
    onStep({ step: `create-pass-${passNumber}`, status: "success", message: `Pass ${passNumber} created ${passItems.length} order line item(s).`, timestamp: Date.now() });
    passNumber += 1;
  }

  return { success: true, idByIndex, error: null, failedIndex: null };
}

export interface RelationshipCreationResult {
  success: boolean;
  createdIds: string[];
  error: string | null;
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

/** Resolve ONE required-and-unmapped OrderItemRelationship field for ONE edge — never fabricates a value. Identical strategy to the Quote-side resolver, applied independently to OrderItemRelationship's own Describe response. */
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

/** Create the native OrderItemRelationship records linking parent/child OrderItems by their real, just-created Ids (§5.1). No-op for self-reference mechanism or zero edges. */
export async function createNativeBundleRelationships(
  client: SalesforceClient,
  flatItems: FlatDraftItem[],
  idByIndex: Map<number, string>,
  oirSchema: OrderItemRelationshipFieldSchema,
  onStep: (step: BundleHierarchyStep) => void,
): Promise<RelationshipCreationResult> {
  const edges = flatItems.filter(i => i.parentIndex !== null);
  if (oirSchema.mechanism !== "relationship-object" || !oirSchema.objectName || edges.length === 0) {
    return { success: true, createdIds: [], error: null, payloads: [] };
  }

  onStep({ step: "create-relationships", status: "start", message: `Creating ${edges.length} bundle relationship record(s).`, timestamp: Date.now() });

  let describe: DescribeResult;
  try {
    describe = await describeObjectCached(client, oirSchema.objectName);
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to Describe ${oirSchema.objectName}.`;
    onStep({ step: "audit-relationship-fields", status: "error", message, timestamp: Date.now() });
    return { success: false, createdIds: [], error: message, payloads: [] };
  }

  if (oirSchema.requiredFieldsNotMapped.length > 0) {
    onStep({
      step: "audit-relationship-fields", status: "start",
      message: `Auditing ${oirSchema.requiredFieldsNotMapped.length} required ${oirSchema.objectName} field(s) with no explicit mapping: ${oirSchema.requiredFieldsNotMapped.map(f => f.apiName).join(", ")}.`,
      timestamp: Date.now(),
    });
    for (const ref of oirSchema.requiredFieldsNotMapped) {
      const field = describe.fields.find(f => f.name === ref.apiName);
      if (!field) continue;
      onStep({
        step: "audit-relationship-fields", status: "info",
        message: `${oirSchema.objectName}.${field.name}: type=${field.type}, restrictedPicklist=${!!field.restrictedPicklist}, controllerName=${field.controllerName ?? "none"}, activeValues=[${field.picklistValues?.filter(v => v.active).map(v => v.value).join(", ") ?? ""}], defaultValue=${field.picklistValues?.find(v => v.active && v.defaultValue)?.value ?? "none"}.`,
        timestamp: Date.now(),
      });
    }
  }

  const payloads: Record<string, unknown>[] = [];
  for (const edge of edges) {
    const payload: Record<string, unknown> = {};
    const parentId = idByIndex.get(edge.parentIndex!);
    const childId = idByIndex.get(edge.index);
    if (oirSchema.mainOrderItemField && parentId) payload[oirSchema.mainOrderItemField.apiName] = parentId;
    if (oirSchema.associatedOrderItemField && childId) payload[oirSchema.associatedOrderItemField.apiName] = childId;
    if (oirSchema.relatedComponentField && edge.draft.relatedComponentId) payload[oirSchema.relatedComponentField.apiName] = edge.draft.relatedComponentId;
    if (oirSchema.relationshipTypeField && edge.draft.relationshipTypeId) payload[oirSchema.relationshipTypeField.apiName] = edge.draft.relationshipTypeId;
    if (oirSchema.pricingInclusionField) payload[oirSchema.pricingInclusionField.apiName] = edge.draft.pricingInclusion;

    for (const ref of oirSchema.requiredFieldsNotMapped) {
      const field = describe.fields.find(f => f.name === ref.apiName);
      if (!field) continue;
      const resolution = await resolveRequiredFieldForEdge(client, oirSchema.objectName, describe, field, payload);
      onStep({
        step: "audit-relationship-fields", status: resolution.selectedValue !== undefined ? "success" : "error",
        message: `${oirSchema.objectName}.${field.name} for "${edge.draft.product.name}": active=[${resolution.activeValues.join(", ")}] inactive=[${resolution.inactiveValues.join(", ")}] default=${resolution.defaultValue ?? "none"} restricted=${resolution.restrictedPicklist} controller=${resolution.controllerName ?? "none"} controllingValue=${JSON.stringify(resolution.controllingValue)} validForController=${resolution.validValuesForController ? `[${resolution.validValuesForController.join(", ")}]` : "n/a"} selected=${JSON.stringify(resolution.selectedValue)} reason="${resolution.reasonSelected}"`,
        timestamp: Date.now(),
      });
      if (resolution.selectedValue === undefined) {
        const message = `Cannot create bundle relationship for "${edge.draft.product.name}": required field ${oirSchema.objectName}.${field.name} (type ${field.type}) could not be resolved automatically. ${resolution.reasonSelected} Active values: [${resolution.activeValues.join(", ")}]. This app never fabricates a value for a field Salesforce hasn't defined a resolvable default for — Salesforce Setup must define an active default value (or reduce this to a single active option) for ${oirSchema.objectName}.${field.name}.`;
        onStep({ step: "audit-relationship-fields", status: "error", message, timestamp: Date.now() });
        return { success: false, createdIds: [], error: message, payloads: [...payloads, payload] };
      }
      payload[field.name] = resolution.selectedValue;
    }

    payloads.push(payload);
  }

  onStep({
    step: "verify-relationship-payload", status: "info",
    message: `Complete ${oirSchema.objectName} payload for ${payloads.length} edge(s), immediately before create.`,
    detail: payloads,
    timestamp: Date.now(),
  });

  const createdIds: string[] = [];
  const chunkSize = 200;
  for (let offset = 0; offset < payloads.length; offset += chunkSize) {
    const chunk = payloads.slice(offset, offset + chunkSize);
    let results;
    try {
      results = await client.compositeCreate(oirSchema.objectName, chunk, false);
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
