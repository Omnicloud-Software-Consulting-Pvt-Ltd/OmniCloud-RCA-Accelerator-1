import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField, findReferenceFieldByTargetObject, findAllReferenceFieldsToTarget, toFieldRef } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import { diagnosePricingModel } from "@/lib/quotes/metadata/lineItemFields";
import type { OrderItemFieldSchema, OrderItemAttributeFieldSchema } from "@/lib/orders/types";

const orderItemSchemaCache = createTTLCache<OrderItemFieldSchema>();
const orderItemAttrSchemaCache = createTTLCache<OrderItemAttributeFieldSchema>();

/**
 * Resolve the writable OrderItem field schema — the Order-side counterpart
 * of resolveQuoteLineItemFieldSchema. `diagnosePricingModel` is reused
 * verbatim from the Quote module (lib/quotes/metadata/lineItemFields.ts):
 * it only inspects a passed-in DescribeResult, so it is genuinely
 * object-agnostic and correctly diagnoses OrderItem's own UnitPrice-source
 * field without any Quote-specific coupling.
 */
export async function resolveOrderItemFieldSchema(client: SalesforceClient): Promise<OrderItemFieldSchema> {
  return orderItemSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "OrderItem");

    const orderField = findReferenceFieldByTargetObject(describe, "Order", { requireCreateable: true })
      ?? resolveField(describe, "OrderId", /^order$/i, { requireCreateable: true });
    const productField = findReferenceFieldByTargetObject(describe, "Product2", { requireCreateable: true })
      ?? resolveField(describe, "Product2Id", /^product$/i, { requireCreateable: true });
    const pricebookEntryField = findReferenceFieldByTargetObject(describe, "PricebookEntry", { requireCreateable: true })
      ?? resolveField(describe, "PricebookEntryId", /^price\s?book entry$/i, { requireCreateable: true });

    const quantityField = resolveField(describe, "Quantity", /^quantity$/i, { requireCreateable: true });
    const unitPriceField = resolveField(describe, "UnitPrice", /^sales price$/i);
    const listPriceField = resolveField(describe, "ListPrice", /^list price$/i);
    // §4.6 delta: unlike QuoteLineItem, not every org extends OrderItem with
    // Revenue Cloud's Discount field — resolve it like any other field and
    // let it be null rather than assuming parity.
    const discountField = resolveField(describe, "Discount", /^discount$/i, { requireCreateable: true });
    const totalPriceField = resolveField(describe, "TotalPrice", /^total price$/i);
    const sellingModelOptionField = findReferenceFieldByTargetObject(describe, "ProductSellingModelOption", { requireCreateable: true })
      ?? resolveField(describe, "SellingModelId", /^selling model$/i, { requireCreateable: true });
    const billingFrequencyField = resolveField(describe, "BillingFrequency", /^billing frequency$/i);
    const subscriptionTermField = resolveField(describe, "SubscriptionTerm", /^subscription term$/i);

    const selfRefs = findAllReferenceFieldsToTarget(describe, "OrderItem", { requireCreateable: true });
    const rootItemField = selfRefs.find(f => /root/i.test(f.label)) ?? null;
    const parentItemField = selfRefs.find(f => /parent/i.test(f.label) && f !== rootItemField) ?? null;

    return {
      orderField: toFieldRef(orderField),
      productField: toFieldRef(productField),
      pricebookEntryField: toFieldRef(pricebookEntryField),
      quantityField: toFieldRef(quantityField),
      unitPriceField: toFieldRef(unitPriceField),
      unitPriceWritable: !!(unitPriceField?.createable || unitPriceField?.updateable),
      listPriceField: toFieldRef(listPriceField),
      discountField: toFieldRef(discountField),
      totalPriceField: toFieldRef(totalPriceField),
      totalPriceWritable: !!(totalPriceField?.createable || totalPriceField?.updateable),
      sellingModelOptionField: toFieldRef(sellingModelOptionField),
      billingFrequencyField: toFieldRef(billingFrequencyField),
      subscriptionTermField: toFieldRef(subscriptionTermField),
      rootItemField: toFieldRef(rootItemField),
      parentItemField: toFieldRef(parentItemField),
      pricingModel: diagnosePricingModel(describe).model,
    };
  });
}

export async function resolveOrderItemAttributeFieldSchema(client: SalesforceClient): Promise<OrderItemAttributeFieldSchema> {
  return orderItemAttrSchemaCache.getOrCompute(client.instanceUrl, async () => {
    let describe: DescribeResult | null = null;
    let objectName: string | null = null;
    try {
      describe = await describeObjectCached(client, "OrderItemAttribute");
      objectName = "OrderItemAttribute";
    } catch {
      return { objectName: null, orderItemField: null, attributeField: null, valueField: null };
    }

    const orderItemField = findReferenceFieldByTargetObject(describe, "OrderItem", { requireCreateable: true })
      ?? resolveField(describe, "OrderItemId", /^order (product|item)$/i, { requireCreateable: true });
    const attributeField = resolveField(describe, "AttributeDefinitionId", /^attribute(\sdefinition)?$/i, { requireCreateable: true })
      ?? resolveField(describe, "ProductAttributeId", /^product attribute$/i, { requireCreateable: true });
    const valueField = resolveField(describe, "Value", /^value$/i, { requireCreateable: true })
      ?? resolveField(describe, "AttributeValue", /^attribute value$/i, { requireCreateable: true });

    return {
      objectName,
      orderItemField: toFieldRef(orderItemField),
      attributeField: toFieldRef(attributeField),
      valueField: toFieldRef(valueField),
    };
  });
}
