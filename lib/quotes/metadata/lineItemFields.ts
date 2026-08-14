import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField, findReferenceFieldByTargetObject, findAllReferenceFieldsToTarget, findRequiredCreateableFields, toFieldRef } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type {
  QuoteLineItemFieldSchema,
  QuoteLineItemAttributeFieldSchema,
  PricingModelDiagnosis,
} from "@/lib/quotes/types";

function fieldEvidence(f: DescribeField | null | undefined): PricingModelDiagnosis["evidence"]["unitPrice"] {
  if (!f) return null;
  return { apiName: f.name, label: f.label, type: f.type, createable: !!f.createable, updateable: !!f.updateable, calculated: !!f.calculated };
}

/**
 * Detect whether UnitPrice on QuoteLineItem is manually entered or computed
 * by a Revenue Cloud pricing engine (§2.8). There is no single documented
 * "pricing model" field that every org exposes, so this is a multi-signal
 * heuristic rather than a hardcoded field check:
 *   1. UnitPrice reported as a calculated/formula field -> the org's pricing
 *      engine owns it; the app must never try to write it directly.
 *   2. Presence of NetUnitPrice/NetTotalPrice/PricingStatus-shaped fields
 *      (Revenue Cloud's own pricing-result fields) -> RevenueCloudPricing,
 *      even if UnitPrice itself is still nominally writable.
 *   3. UnitPrice createable/updateable and neither signal above -> ManualPricing.
 *   4. Anything else -> Indeterminate (never assume, degrade to "ask Salesforce").
 *
 * §Phase 3/5 — never classify from a name alone: every candidate field's
 * REAL Describe evidence (apiName/label/type/createable/updateable/
 * calculated) is captured in `evidence` and logged in full below, so a
 * classification can be verified (or overridden) against the actual org
 * metadata instead of trusted blindly because "a Revenue-Cloud-looking
 * field exists".
 */
export function diagnosePricingModel(describe: DescribeResult): PricingModelDiagnosis {
  const unitPrice = describe.fields.find(f => f.name === "UnitPrice");
  const listPrice = describe.fields.find(f => f.name === "ListPrice");
  const totalPrice = describe.fields.find(f => f.name === "TotalPrice");
  const netUnitPrice = resolveField(describe, "NetUnitPrice", /^net unit price$/i);
  const netTotalPrice = resolveField(describe, "NetTotalPrice", /^net total price$/i);
  const pricingStatus = resolveField(describe, "PricingStatus", /^pricing status$/i);

  const evidence: PricingModelDiagnosis["evidence"] = {
    unitPrice: fieldEvidence(unitPrice), listPrice: fieldEvidence(listPrice), totalPrice: fieldEvidence(totalPrice),
    netUnitPrice: fieldEvidence(netUnitPrice), netTotalPrice: fieldEvidence(netTotalPrice), pricingStatus: fieldEvidence(pricingStatus),
  };

  let diagnosis: PricingModelDiagnosis;
  if (unitPrice?.calculated) {
    diagnosis = { model: "RevenueCloudPricing", reason: "UnitPrice is a calculated field — a pricing engine, not the app, owns its value.", evidence };
  } else if (netUnitPrice || netTotalPrice || pricingStatus) {
    diagnosis = { model: "RevenueCloudPricing", reason: "Org exposes Revenue Cloud pricing-result fields (NetUnitPrice/NetTotalPrice/PricingStatus).", evidence };
  } else if (unitPrice?.createable || unitPrice?.updateable) {
    diagnosis = { model: "ManualPricing", reason: "UnitPrice is directly writable and no pricing-engine fields were found.", evidence };
  } else {
    diagnosis = { model: "Indeterminate", reason: "Could not determine a pricing model from this org's QuoteLineItem schema.", evidence };
  }

  console.log(
    `[diagnosePricingModel] model=${diagnosis.model} reason="${diagnosis.reason}" ` +
    `UnitPrice=${JSON.stringify(evidence.unitPrice)} ListPrice=${JSON.stringify(evidence.listPrice)} TotalPrice=${JSON.stringify(evidence.totalPrice)} ` +
    `NetUnitPrice=${JSON.stringify(evidence.netUnitPrice)} NetTotalPrice=${JSON.stringify(evidence.netTotalPrice)} PricingStatus=${JSON.stringify(evidence.pricingStatus)}`,
  );
  return diagnosis;
}

const qliSchemaCache = createTTLCache<QuoteLineItemFieldSchema>();
const qliAttrSchemaCache = createTTLCache<QuoteLineItemAttributeFieldSchema>();

export async function resolveQuoteLineItemFieldSchema(client: SalesforceClient): Promise<QuoteLineItemFieldSchema> {
  return qliSchemaCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "QuoteLineItem");

    // All of these are write targets (used to build the QLI create payload)
    // and must gate on createable — otherwise a field that exists but is
    // read-only in this org gets sent anyway and Salesforce rejects the
    // whole create call with "Unable to create/update fields: <name>".
    const quoteField = findReferenceFieldByTargetObject(describe, "Quote", { requireCreateable: true })
      ?? resolveField(describe, "QuoteId", /^quote$/i, { requireCreateable: true });
    const productField = findReferenceFieldByTargetObject(describe, "Product2", { requireCreateable: true })
      ?? resolveField(describe, "Product2Id", /^product$/i, { requireCreateable: true });
    const pricebookEntryField = findReferenceFieldByTargetObject(describe, "PricebookEntry", { requireCreateable: true })
      ?? resolveField(describe, "PricebookEntryId", /^price\s?book entry$/i, { requireCreateable: true });

    const quantityField = resolveField(describe, "Quantity", /^quantity$/i, { requireCreateable: true });
    const unitPriceField = resolveField(describe, "UnitPrice", /^sales price$/i);
    const listPriceField = resolveField(describe, "ListPrice", /^list price$/i);
    const discountField = resolveField(describe, "Discount", /^discount$/i, { requireCreateable: true });
    const totalPriceField = resolveField(describe, "TotalPrice", /^total price$/i);
    // §$0.00 pricing bug: Revenue Cloud's Instant Pricing call persists its
    // result to NetUnitPrice/NetTotalPrice, NOT UnitPrice/TotalPrice — a
    // RevenueCloudPricing org's UnitPrice/TotalPrice can legitimately stay
    // 0/blank forever. These must be resolved and exposed here (previously
    // diagnosePricingModel computed the same DescribeFields purely to
    // classify pricingModel, then discarded them — nothing downstream could
    // ever read the authoritative price as a result).
    const netUnitPriceField = resolveField(describe, "NetUnitPrice", /^net unit price$/i);
    const netTotalPriceField = resolveField(describe, "NetTotalPrice", /^net total price$/i);
    // §Discount pricing fix — read-only, resolved purely for display/
    // diagnostics (never written to): lets the app show whether a line's
    // Revenue Cloud pricing run is fresh or stale, e.g. after a manual
    // Discount edit but before repricing runs.
    const pricingStatusField = resolveField(describe, "PricingStatus", /^pricing status$/i);
    // §Selling Model field split (Refresh Prices / blank Selling Model
    // investigation): Revenue Cloud's STANDARD QuoteLineItem shape is
    // `SellingModelId` referencing the PARENT `ProductSellingModel` object —
    // not `ProductSellingModelOption` (the child/option object this app
    // resolves candidates FROM). The two were previously resolved as a
    // single ambiguous field via a "ProductSellingModelOption target, else a
    // field literally named/labeled SellingModelId" fallback chain — on an
    // org whose real field targets ProductSellingModel (the common case),
    // that fallback found the field correctly by API name, but the app then
    // wrote the OPTION's Id into it (see relationshipCreate.ts's
    // buildQLIPayload) — a value belonging to the wrong object entirely.
    // Resolved as two independent fields now; a real org can have either,
    // both, or neither, and each gets its own correct value at write time.
    const sellingModelField = findReferenceFieldByTargetObject(describe, "ProductSellingModel", { requireCreateable: true })
      ?? resolveField(describe, "SellingModelId", /^(product )?selling model$/i, { requireCreateable: true });
    const sellingModelOptionField = findReferenceFieldByTargetObject(describe, "ProductSellingModelOption", { requireCreateable: true });
    const billingFrequencyField = resolveField(describe, "BillingFrequency", /^billing frequency$/i);
    // §Revenue Cloud page layouts commonly re-label this field "Pricing
    // Term" rather than the standard "Subscription Term" — the exact API
    // name match above is unaffected by label, but widen the label fallback
    // too so a genuinely differently-API-named field with either label is
    // still found.
    const subscriptionTermField = resolveField(describe, "SubscriptionTerm", /^(subscription|pricing) term$/i);

    // Self-reference fallback mechanism for bundle hierarchy (§5.5 mechanism B) — also a write target.
    const selfRefs = findAllReferenceFieldsToTarget(describe, "QuoteLineItem", { requireCreateable: true });
    const rootItemField = selfRefs.find(f => /root/i.test(f.label)) ?? null;
    const parentItemField = selfRefs.find(f => /parent/i.test(f.label) && f !== rootItemField) ?? null;

    const pricingModelDiagnosis = diagnosePricingModel(describe);

    // §Audit gap fix: QuoteLineRelationship already audits for required+
    // createable fields this app's curated list doesn't explicitly map
    // (see resolveQuoteLineRelationshipSchema below) — QuoteLineItem itself
    // never got the same treatment, despite being the one object Salesforce's
    // native Refresh Prices / bundle-configuration validation reads directly.
    // An org-specific required field outside this curated list would
    // otherwise be silently omitted from every create payload.
    const mapped = new Set(
      [
        quoteField, productField, pricebookEntryField, quantityField, unitPriceField, listPriceField,
        discountField, totalPriceField, netUnitPriceField, netTotalPriceField, pricingStatusField,
        sellingModelField, sellingModelOptionField, billingFrequencyField, subscriptionTermField, rootItemField, parentItemField,
      ]
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map(f => f.name),
    );
    const requiredFieldsNotMapped = findRequiredCreateableFields(describe)
      .filter(f => !mapped.has(f.name))
      .map(f => toFieldRef(f)!);

    return {
      quoteField: toFieldRef(quoteField),
      productField: toFieldRef(productField),
      pricebookEntryField: toFieldRef(pricebookEntryField),
      quantityField: toFieldRef(quantityField),
      unitPriceField: toFieldRef(unitPriceField),
      listPriceField: toFieldRef(listPriceField),
      discountField: toFieldRef(discountField),
      totalPriceField: toFieldRef(totalPriceField),
      netUnitPriceField: toFieldRef(netUnitPriceField),
      netTotalPriceField: toFieldRef(netTotalPriceField),
      pricingStatusField: toFieldRef(pricingStatusField),
      sellingModelField: toFieldRef(sellingModelField),
      sellingModelOptionField: toFieldRef(sellingModelOptionField),
      billingFrequencyField: toFieldRef(billingFrequencyField),
      subscriptionTermField: toFieldRef(subscriptionTermField),
      rootItemField: toFieldRef(rootItemField),
      parentItemField: toFieldRef(parentItemField),
      pricingModel: pricingModelDiagnosis.model,
      pricingModelDiagnosis,
      requiredFieldsNotMapped,
    };
  });
}

export async function resolveQuoteLineItemAttributeFieldSchema(client: SalesforceClient): Promise<QuoteLineItemAttributeFieldSchema> {
  return qliAttrSchemaCache.getOrCompute(client.instanceUrl, async () => {
    // Object name itself isn't universally standard-named across orgs with
    // customized RCA installs — try the well-known name first via describeGlobal.
    let describe: DescribeResult | null = null;
    let objectName: string | null = null;
    try {
      describe = await describeObjectCached(client, "QuoteLineItemAttribute");
      objectName = "QuoteLineItemAttribute";
    } catch {
      return { objectName: null, quoteLineItemField: null, attributeField: null, valueField: null };
    }

    const quoteLineItemField = findReferenceFieldByTargetObject(describe, "QuoteLineItem", { requireCreateable: true })
      ?? resolveField(describe, "QuoteLineItemId", /^quote line item$/i, { requireCreateable: true });
    const attributeField = resolveField(describe, "AttributeDefinitionId", /^attribute(\sdefinition)?$/i, { requireCreateable: true })
      ?? resolveField(describe, "ProductAttributeId", /^product attribute$/i, { requireCreateable: true });
    const valueField = resolveField(describe, "Value", /^value$/i, { requireCreateable: true })
      ?? resolveField(describe, "AttributeValue", /^attribute value$/i, { requireCreateable: true });

    return {
      objectName,
      quoteLineItemField: toFieldRef(quoteLineItemField),
      attributeField: toFieldRef(attributeField),
      valueField: toFieldRef(valueField),
    };
  });
}
