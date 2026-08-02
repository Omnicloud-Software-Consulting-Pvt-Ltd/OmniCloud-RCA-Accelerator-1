import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import {
  resolveField,
  findAllReferenceFieldsToTarget,
  findReferenceFieldByTargetObject,
  findReferenceFieldByLabel,
  findRequiredCreateableFields,
  toFieldRef,
} from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import { resolveOrderItemFieldSchema } from "@/lib/orders/metadata/lineItemFields";
import type { BundleObjectDiscovery } from "@/lib/quotes/types";
import type { OrderItemRelationshipFieldSchema } from "@/lib/orders/types";

const oirSchemaCache = createTTLCache<OrderItemRelationshipFieldSchema>();

/**
 * Resolve the native mechanism for representing an OrderItem parent/child
 * bundle link (§5.1) — an INDEPENDENT discovery pass from
 * resolveQuoteLineRelationshipSchema. Deliberately does not assume
 * OrderItemRelationship's field shape mirrors QuoteLineRelationship's just
 * because the two objects are conceptually parallel; every field here is
 * re-resolved from OrderItemRelationship's own Describe response, and the
 * required-field audit is run fresh against this object, never copied over
 * from the Quote-side result. `bundleDiscovery` (ProductRelatedComponent /
 * ProductComponentGroup) IS reused as-is from the Quote module — that
 * discovery is entirely Product2-keyed and has nothing Quote-specific in it.
 */
export async function resolveOrderItemRelationshipSchema(
  client: SalesforceClient,
  bundleDiscovery: BundleObjectDiscovery,
): Promise<OrderItemRelationshipFieldSchema> {
  return oirSchemaCache.getOrCompute(client.instanceUrl, async () => {
    let describe: DescribeResult | null = null;
    try {
      describe = await describeObjectCached(client, "OrderItemRelationship");
    } catch {
      describe = null;
    }

    if (describe) {
      const orderItemRefs = findAllReferenceFieldsToTarget(describe, "OrderItem", { requireCreateable: true });
      const mainOrderItemField =
        orderItemRefs.find(f => /^order (product|item)$/i.test(f.label)) ??
        orderItemRefs.find(f => /main|primary/i.test(f.label)) ??
        orderItemRefs[0] ?? null;
      const associatedOrderItemField =
        orderItemRefs.find(f => /associated|related|component|child/i.test(f.label) && f !== mainOrderItemField) ??
        orderItemRefs.find(f => f !== mainOrderItemField) ?? null;

      if (mainOrderItemField && associatedOrderItemField) {
        const relatedComponentField = bundleDiscovery.relationshipObject
          ? findReferenceFieldByTargetObject(describe, bundleDiscovery.relationshipObject)
          : null;
        const quantityScaleMethodField = resolveField(describe, "QuantityScaleMethod", /^quantity scale method$/i);
        const relationshipTypeField =
          resolveField(describe, "ProductRelationshipTypeId", /^relationship type$/i) ?? findReferenceFieldByLabel(describe, /relationship type/i);
        const pricingInclusionField = resolveField(describe, "IsComponentPriceIncluded", /price included/i);

        const mapped = new Set(
          [mainOrderItemField, associatedOrderItemField, relatedComponentField, quantityScaleMethodField, relationshipTypeField, pricingInclusionField]
            .filter((f): f is NonNullable<typeof f> => !!f)
            .map(f => f.name),
        );
        const requiredFieldsNotMapped = findRequiredCreateableFields(describe)
          .filter(f => !mapped.has(f.name))
          .map(f => toFieldRef(f)!);

        return {
          mechanism: "relationship-object",
          objectName: describe.name,
          mainOrderItemField: toFieldRef(mainOrderItemField),
          associatedOrderItemField: toFieldRef(associatedOrderItemField),
          relatedComponentField: toFieldRef(relatedComponentField),
          quantityScaleMethodField: toFieldRef(quantityScaleMethodField),
          relationshipTypeField: toFieldRef(relationshipTypeField),
          pricingInclusionField: toFieldRef(pricingInclusionField),
          requiredFieldsNotMapped,
        };
      }
    }

    // Mechanism B: OrderItem self-reference (Root/Parent Item), if this org has one.
    const oiSchema = await resolveOrderItemFieldSchema(client);
    if (oiSchema.rootItemField || oiSchema.parentItemField) {
      return {
        mechanism: "self-reference",
        objectName: "OrderItem",
        mainOrderItemField: oiSchema.rootItemField,
        associatedOrderItemField: oiSchema.parentItemField,
        relatedComponentField: null,
        quantityScaleMethodField: null,
        relationshipTypeField: null,
        pricingInclusionField: null,
        requiredFieldsNotMapped: [],
      };
    }

    return {
      mechanism: "unsupported",
      objectName: null,
      mainOrderItemField: null,
      associatedOrderItemField: null,
      relatedComponentField: null,
      quantityScaleMethodField: null,
      relationshipTypeField: null,
      pricingInclusionField: null,
      requiredFieldsNotMapped: [],
    };
  });
}
