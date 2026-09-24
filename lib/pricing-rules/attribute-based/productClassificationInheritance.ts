/**
 * §Live-org fix (Desktop) — shared, org-agnostic resolver for Salesforce Revenue Cloud Advanced's
 * PRODUCT CLASSIFICATION attribute-inheritance mechanism:
 *
 *   Product2 --(reference field, discovered via Describe)--> ProductClassification
 *   ProductClassificationAttr --(reference field)--> ProductClassification
 *   ProductClassificationAttr --(reference field)--> AttributeDefinition
 *
 * A product's Salesforce UI "Attributes" tab can show "Inherited Attributes" purely through this path —
 * with ZERO direct/overridden ProductAttributeDefinition records on the product at all. That is exactly
 * the live "Desktop" bug this exists to fix: Salesforce reports 6 inherited attributes and 0 overrides,
 * but every attribute-resolution path in this app previously only ever queried ProductAttributeDefinition
 * directly by Product2Id — which returns zero rows for a product with no direct/overridden attributes,
 * even though 6 attributes are genuinely applicable to it via its Product Classification.
 *
 * `ProductClassification`/`ProductClassificationAttr` are Salesforce's own standard, non-customizable
 * Revenue Cloud object API names — the same category as `Product2`/`AttributeDefinition`, already
 * referenced literally elsewhere in this codebase (see nativeRecords.ts's `resolveBaseProductConfiguration`,
 * which already reads `ProductClassificationAttr.DefaultValue` via a product's existing
 * `ProductAttributeDefinition.ProductClassificationAttributeId` link). Referencing these two object names
 * literally is not org-specific hardcoding, exactly like this codebase's existing treatment of
 * `ProductCategoryProduct`/`ProductCategoryAttribute`/`AttributePicklist` elsewhere — every FIELD that
 * connects them, by contrast, is discovered dynamically via Describe and never assumed by name.
 *
 * Both `discoverAttributes.ts` (Step 4's analyze-time discovery, feeding prompt validation) and
 * `create/nativeRecords.ts` (create-time price-impacting/baseline-default-value resolution, feeding
 * AttributeBasedAdjRule/Condition/Adjustment creation) import this ONE resolver rather than each
 * re-implementing their own classification lookup — so there is exactly one place that could disagree
 * with itself about what a product inherits. Never throws: every "not supported on this org"/"no
 * classification set"/"query failed" case degrades to an empty, `supported: false`/`rowsByAttributeDefinitionId:
 * empty` result rather than surfacing an error the caller has to special-case.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached, describeGlobalCached, findAllReferenceFieldsToTarget } from "@/lib/salesforce/describe";
import { resolvePriceImpactingField } from "./create/nativeSchemaResolver";

export interface ProductClassificationAttributeRow {
  /** ProductClassificationAttr's own Id — the record identity Salesforce itself uses to distinguish
   * "this classification-level attribute slot," independent of AttributeDefinition (two different
   * classifications could reference the same AttributeDefinition with different defaults/price-impacting
   * flags). Never derived from — or compared against — AttributeDefinitionId alone. */
  id: string;
  attributeDefinitionId: string;
  isPriceImpacting: boolean | null;
  defaultValue: string | null;
}

export interface ProductClassificationInheritance {
  /** False only when ProductClassification/ProductClassificationAttr (or the relationship fields
   * connecting them) aren't usable on this org at all — distinct from "usable, but this product has no
   * classification set" or "usable, but the classification has zero attributes," both of which report
   * `supported: true` with an empty map (a real, correct answer, not a capability gap). */
  supported: boolean;
  classificationId: string | null;
  rowsByAttributeDefinitionId: Map<string, ProductClassificationAttributeRow>;
}

const UNSUPPORTED: ProductClassificationInheritance = { supported: false, classificationId: null, rowsByAttributeDefinitionId: new Map() };

export async function resolveProductClassificationInheritance(
  client: SalesforceClient,
  productId: string,
): Promise<ProductClassificationInheritance> {
  const globalDescribe = await describeGlobalCached(client);
  const hasClassification = globalDescribe.some(o => o.name === "ProductClassification" && o.queryable);
  const hasClassificationAttr = globalDescribe.some(o => o.name === "ProductClassificationAttr" && o.queryable);
  if (!hasClassification || !hasClassificationAttr) {
    client.logDebug("execution-trace", "resolveProductClassificationInheritance — ProductClassification/ProductClassificationAttr is not supported on this org; no classification-based inheritance to resolve.");
    return UNSUPPORTED;
  }

  const product2Describe = await describeObjectCached(client, "Product2");
  const classificationField = findAllReferenceFieldsToTarget(product2Describe, "ProductClassification")[0];
  if (!classificationField) {
    client.logDebug("execution-trace", "resolveProductClassificationInheritance — Product2 has no reference field to ProductClassification on this org.");
    return UNSUPPORTED;
  }

  let classificationId: string | null = null;
  try {
    const productRes = await client.query<Record<string, unknown>>(`SELECT ${classificationField.name} FROM Product2 WHERE Id = '${productId}' LIMIT 1`);
    const v = productRes.records[0]?.[classificationField.name];
    classificationId = typeof v === "string" && v ? v : null;
  } catch (err) {
    client.logDebug("execution-trace", `resolveProductClassificationInheritance — Product2 classification lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return UNSUPPORTED;
  }
  if (!classificationId) {
    client.logDebug("execution-trace", `resolveProductClassificationInheritance — Product2 ${productId} has no ${classificationField.name} set; nothing to inherit via classification.`);
    return { supported: true, classificationId: null, rowsByAttributeDefinitionId: new Map() };
  }

  const pcaDescribe = await describeObjectCached(client, "ProductClassificationAttr");
  const pcaClassificationField = findAllReferenceFieldsToTarget(pcaDescribe, "ProductClassification")[0];
  const pcaAttrDefField = findAllReferenceFieldsToTarget(pcaDescribe, "AttributeDefinition")[0];
  if (!pcaClassificationField || !pcaAttrDefField) {
    client.logDebug(
      "execution-trace",
      `resolveProductClassificationInheritance — ProductClassificationAttr does not expose the expected ProductClassification/AttributeDefinition relationship field(s) on this org ` +
      `(ProductClassification field: ${pcaClassificationField?.name ?? "NOT FOUND"}, AttributeDefinition field: ${pcaAttrDefField?.name ?? "NOT FOUND"}).`,
    );
    return { supported: true, classificationId, rowsByAttributeDefinitionId: new Map() };
  }
  const priceImpactingField = resolvePriceImpactingField(pcaDescribe);
  const defaultValueField = pcaDescribe.fields.find(f => /^DefaultValue$/i.test(f.name)) ?? null;
  const selectFields = Array.from(new Set([
    "Id", pcaAttrDefField.name,
    ...(priceImpactingField ? [priceImpactingField.name] : []),
    ...(defaultValueField ? [defaultValueField.name] : []),
  ]));

  const rows = new Map<string, ProductClassificationAttributeRow>();
  try {
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${selectFields.join(", ")} FROM ProductClassificationAttr WHERE ${pcaClassificationField.name} = '${classificationId}'`,
    );
    for (const rec of res.records) {
      const attrDefId = rec[pcaAttrDefField.name];
      if (typeof attrDefId !== "string" || !attrDefId) continue;
      rows.set(attrDefId, {
        id: rec.Id,
        attributeDefinitionId: attrDefId,
        isPriceImpacting: priceImpactingField ? ((rec[priceImpactingField.name] as boolean | undefined) ?? null) : null,
        defaultValue: defaultValueField ? ((rec[defaultValueField.name] as string | undefined) ?? null) : null,
      });
    }
  } catch (err) {
    client.logDebug("execution-trace", `resolveProductClassificationInheritance — ProductClassificationAttr query failed: ${err instanceof Error ? err.message : String(err)}`);
    return { supported: true, classificationId, rowsByAttributeDefinitionId: new Map() };
  }

  client.logDebug(
    "execution-trace",
    `resolveProductClassificationInheritance — Product ${productId} (classification ${classificationId}) has ${rows.size} inherited attribute(s) via ProductClassificationAttr: [${[...rows.keys()].join(", ")}].`,
  );
  return { supported: true, classificationId, rowsByAttributeDefinitionId: rows };
}
