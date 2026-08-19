/**
 * Step 4/6 — schema-driven discovery of a product's real attributes AND
 * their real values. The only hardcoded object names are the standard RCA
 * ones (Product2, ProductCategoryProduct, ProductCategoryAttribute,
 * AttributeCategory, AttributePicklist, AttributePicklistValue,
 * AttributeSetItem) plus a final-fallback literal "AttributeDefinition" —
 * the object that actually links Product2 to its overridden attributes
 * varies by org/package and is discovered at runtime via Describe, exactly
 * like the rest of this app's schema-driven modules. Never hardcodes a
 * product's actual attribute/value names — those always come from a live
 * Salesforce query (Step 14).
 */
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { describeObjectCached, describeGlobalCached, findAllReferenceFieldsToTarget } from "@/lib/salesforce/describe";
import { resolveProductClassificationInheritance } from "./productClassificationInheritance";
import type { DiscoveredAttribute, DiscoveredAttributeValue } from "./types";

const SYSTEM_FIELD_EXCLUDE = /^(OwnerId|CreatedById|LastModifiedById|RecordTypeId|CreatedDate|LastModifiedDate|SystemModstamp|IsDeleted)$/i;
const CHILD_RELATIONSHIP_EXCLUDE = /definition|ChangeEvent|Share|History|Feed/i;
const NON_SELECTABLE_TYPES = new Set(["base64", "location", "address"]);

/**
 * §Live-org fix (Desktop) — Product2's COMPLETE EFFECTIVE ATTRIBUTE SET: direct/overridden
 * ProductAttributeDefinition records UNION every attribute inherited via ProductCategory or Product
 * Classification (excluding whichever of those an override already covers). A product can legitimately
 * have "Inherited Attributes (6), Overridden Inherited Attributes (0)" in Salesforce's own UI — meaning
 * ZERO direct/overridden records exist at all, yet 6 attributes are genuinely applicable via Product
 * Classification. Never returns "no attributes" just because the direct/overridden query came back empty.
 */
export async function discoverProductAttributes(
  client: SalesforceClient,
  productId: string,
): Promise<{ attributes: DiscoveredAttribute[]; warnings: string[] }> {
  const warnings: string[] = [];
  client.logDebug("execution-trace", `→ Discovering effective attributes for Product2 ${productId}`);

  let overridden: OverriddenDiscovery = { attrDefIds: new Set(), priceImpactingMap: new Map(), attrDefObjectNames: new Set(), sourceById: new Map(), padIdById: new Map() };
  try {
    overridden = await discoverOverriddenAttributes(client, productId);
  } catch (err) {
    warnings.push(`Could not discover direct/overridden product attributes: ${err instanceof Error ? err.message : String(err)}`);
  }

  let categoryInheritedIds: string[] = [];
  try {
    categoryInheritedIds = await discoverInheritedAttributes(client, productId, overridden.attrDefIds);
  } catch (err) {
    warnings.push(`Could not discover category-inherited product attributes: ${err instanceof Error ? err.message : String(err)}`);
  }

  let classification: Awaited<ReturnType<typeof resolveProductClassificationInheritance>> = { supported: false, classificationId: null, rowsByAttributeDefinitionId: new Map() };
  try {
    classification = await resolveProductClassificationInheritance(client, productId);
  } catch (err) {
    warnings.push(`Could not discover Product Classification-inherited attributes: ${err instanceof Error ? err.message : String(err)}`);
  }
  const classificationInheritedIds = [...classification.rowsByAttributeDefinitionId.keys()].filter(id => !overridden.attrDefIds.has(id));

  const inheritedIds = [...new Set([...categoryInheritedIds, ...classificationInheritedIds])];
  const allAttrDefIds = [...new Set([...overridden.attrDefIds, ...inheritedIds])];

  const directCount = [...overridden.sourceById.values()].filter(s => s === "DIRECT").length;
  const overrideCount = [...overridden.sourceById.values()].filter(s => s === "OVERRIDE").length;
  client.logDebug("execution-trace", [
    `✓ Direct attributes found: ${directCount}`,
    `✓ Override (of an inherited attribute) attributes found: ${overrideCount}`,
    `✓ Category-inherited attributes found: ${categoryInheritedIds.length}`,
    `✓ Classification-inherited attributes found: ${classificationInheritedIds.length}`,
    `✓ Effective attributes after inheritance/override resolution: ${allAttrDefIds.length}`,
  ].join("\n"));

  if (allAttrDefIds.length === 0) {
    client.logDebug("execution-trace", [
      "No effective attributes resolved for this product via any path:",
      `  Direct/overridden ProductAttributeDefinition-equivalent query → 0`,
      `  Category-inherited (ProductCategoryProduct/ProductCategoryAttribute) → 0`,
      `  Classification-inherited (Product2 -> ProductClassification -> ProductClassificationAttr) → ${classification.supported ? (classification.classificationId ? "0 (classification set, but has no attributes)" : "0 (product has no Product Classification set)") : "not supported on this org"}`,
      "This product genuinely has no attributes configured in Salesforce through any of the mechanisms this application knows how to resolve.",
    ].join("\n"));
    return { attributes: [], warnings };
  }

  let enrichment: EnrichmentResult = { meta: new Map(), sourceObject: new Map() };
  try {
    enrichment = await enrichAttributeDefinitions(client, allAttrDefIds, [...overridden.attrDefObjectNames]);
  } catch (err) {
    warnings.push(`Failed to enrich attribute definitions with labels/data types: ${err instanceof Error ? err.message : String(err)}`);
  }

  // §Live-org fix — keyed by the real Salesforce AttributeDefinition Id, never by display name: two
  // distinct records can legitimately share an identical Name, and matching by name alone (the prior
  // version's approach) would silently misattribute one attribute's discovered values to another's entry.
  const byId = new Map<string, DiscoveredAttribute>();
  for (const id of allAttrDefIds) {
    const meta = enrichment.meta.get(id);
    if (!meta) continue;
    const source: DiscoveredAttribute["source"] = overridden.sourceById.get(id) ?? "INHERITED";
    const classificationRow = classification.rowsByAttributeDefinitionId.get(id) ?? null;
    // Direct/override price-impacting (from this product's own record) takes precedence; a purely
    // inherited attribute falls back to its classification-level price-impacting flag.
    const isPriceImpacting = overridden.priceImpactingMap.has(id)
      ? overridden.priceImpactingMap.get(id) ?? null
      : classificationRow?.isPriceImpacting ?? null;
    byId.set(id, {
      name: meta.name,
      label: meta.label || meta.name,
      dataType: meta.dataType || "",
      isPriceImpacting,
      values: [],
      source,
      attributeDefinitionId: id,
      productAttributeDefinitionId: overridden.padIdById.get(id) ?? null,
      isActive: meta.isActive ?? null,
      isRequired: meta.isRequired ?? null,
      defaultValue: classificationRow?.defaultValue ?? null,
    });
  }

  for (const id of allAttrDefIds) {
    const attr = byId.get(id);
    if (!attr) continue;
    const sourceObject = enrichment.sourceObject.get(id) ?? "AttributeDefinition";
    try {
      attr.values = await discoverAttributeValues(client, id, sourceObject);
    } catch (err) {
      warnings.push(`Could not discover values for attribute "${attr.label}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const attributes = [...byId.values()];
  client.logDebug(
    "execution-trace",
    ["Effective attribute set:", ...attributes.map(a =>
      `  ${a.attributeDefinitionId} — ${a.label} (${a.name}) — source=${a.source} — IsPriceImpacting=${a.isPriceImpacting ?? "(unknown)"} — active=${a.isActive ?? "(unknown)"}`,
    )].join("\n"),
  );

  return { attributes, warnings };
}

/* ── Discover the org's "direct/overridden attribute" link object(s) — a product-level record directly
 * attached to Product2, which Salesforce's own UI can distinguish as either a purely product-specific
 * (DIRECT) attribute or an OVERRIDE of a classification-inherited one (via a populated reference field
 * to ProductClassificationAttr on that same record). ── */
interface OverriddenDiscovery {
  attrDefIds: Set<string>;
  priceImpactingMap: Map<string, boolean | null>;
  attrDefObjectNames: Set<string>;
  /** DIRECT when the product-level record has no populated reference to a ProductClassificationAttr;
   * OVERRIDE when it does (Salesforce's own signal that this record supersedes an inherited one). */
  sourceById: Map<string, "DIRECT" | "OVERRIDE">;
  /** The product-level record's OWN Id (e.g. ProductAttributeDefinition.Id), keyed by AttributeDefinitionId — absent for a purely inherited attribute. */
  padIdById: Map<string, string>;
}

async function discoverOverriddenAttributes(client: SalesforceClient, productId: string): Promise<OverriddenDiscovery> {
  const product2Describe = await describeObjectCached(client, "Product2");
  const candidateNames = new Set<string>();

  for (const rel of product2Describe.childRelationships ?? []) {
    if (/attribute/i.test(rel.childSObject) || (rel.relationshipName && /attribute/i.test(rel.relationshipName))) {
      candidateNames.add(rel.childSObject);
    }
  }

  const globalDescribe = await describeGlobalCached(client);
  for (const obj of globalDescribe) {
    if (!obj.queryable) continue;
    if (/attribute/i.test(obj.name) || /attribute/i.test(obj.label)) candidateNames.add(obj.name);
  }
  for (const skip of ["AttributeDefinition", "AttributePicklist", "AttributePicklistValue", "AttributeCategory", "AttributeSetItem", "ProductCategoryAttribute"]) {
    candidateNames.delete(skip);
  }

  const attrDefIds = new Set<string>();
  const priceImpactingMap = new Map<string, boolean | null>();
  const attrDefObjectNames = new Set<string>();
  const sourceById = new Map<string, "DIRECT" | "OVERRIDE">();
  const padIdById = new Map<string, string>();
  const pendingSetItemIds = new Set<string>();

  for (const candidateName of candidateNames) {
    let describe: DescribeResult;
    try {
      describe = await describeObjectCached(client, candidateName);
    } catch {
      continue;
    }
    const product2Fields = findAllReferenceFieldsToTarget(describe, "Product2");
    if (product2Fields.length === 0) continue;

    const attrDefFields = describe.fields.filter(f => f.type === "reference" && f.referenceTo?.some(r => /attributedefinition/i.test(r)));
    const setItemFields = describe.fields.filter(f => f.type === "reference" && f.referenceTo?.some(r => /attributesetitem/i.test(r)));
    const priceImpactFields = describe.fields.filter(f => /priceimpact|isprice/i.test(f.name));
    // §Live-org fix — Salesforce's own OVERRIDE signal: a product-level record that references a
    // ProductClassificationAttr (the classification-level attribute slot it supersedes) is an OVERRIDE;
    // one with no such reference is a genuinely DIRECT, product-specific attribute. Discovered dynamically
    // via Describe — never assumed to be literally named "ProductClassificationAttributeId".
    const classificationAttrLinkFields = describe.fields.filter(f => f.type === "reference" && f.referenceTo?.some(r => /^productclassificationattr$/i.test(r)));
    if (attrDefFields.length === 0 && setItemFields.length === 0) continue;

    const product2Field = product2Fields[0];
    const fieldNames = Array.from(new Set([
      "Id", product2Field.name, ...attrDefFields.map(f => f.name), ...setItemFields.map(f => f.name),
      ...priceImpactFields.map(f => f.name), ...classificationAttrLinkFields.map(f => f.name),
    ]));

    let records: (Record<string, unknown> & { Id: string })[];
    try {
      const res = await client.query<Record<string, unknown> & { Id: string }>(`SELECT ${fieldNames.join(", ")} FROM ${candidateName} WHERE ${product2Field.name} = '${productId}'`);
      records = res.records;
    } catch {
      continue;
    }
    if (records.length === 0) continue;

    for (const f of attrDefFields) for (const target of f.referenceTo ?? []) if (/attributedefinition/i.test(target)) attrDefObjectNames.add(target);

    for (const rec of records) {
      let defId: string | null = null;
      for (const f of attrDefFields) {
        const v = rec[f.name];
        if (typeof v === "string" && v) { defId = v; break; }
      }
      if (defId) {
        attrDefIds.add(defId);
        padIdById.set(defId, rec.Id);
        const isOverride = classificationAttrLinkFields.some(f => {
          const v = rec[f.name];
          return typeof v === "string" && !!v;
        });
        sourceById.set(defId, isOverride ? "OVERRIDE" : "DIRECT");
        for (const f of priceImpactFields) {
          const v = rec[f.name];
          if (typeof v === "boolean") priceImpactingMap.set(defId, v);
        }
      } else {
        for (const f of setItemFields) {
          const v = rec[f.name];
          if (typeof v === "string" && v) pendingSetItemIds.add(v);
        }
      }
    }
  }

  if (pendingSetItemIds.size > 0) {
    try {
      const res = await client.query<{ Id: string; AttributeDefinitionId?: string }>(
        `SELECT Id, AttributeDefinitionId FROM AttributeSetItem WHERE Id IN (${[...pendingSetItemIds].map(id => `'${id}'`).join(",")})`,
      );
      for (const rec of res.records) {
        if (rec.AttributeDefinitionId) {
          attrDefIds.add(rec.AttributeDefinitionId);
          padIdById.set(rec.AttributeDefinitionId, rec.Id);
          if (!sourceById.has(rec.AttributeDefinitionId)) sourceById.set(rec.AttributeDefinitionId, "DIRECT");
        }
      }
    } catch {
      // best-effort
    }
  }

  return { attrDefIds, priceImpactingMap, attrDefObjectNames, sourceById, padIdById };
}

/* ── Inherited attributes via category. ProductCategoryAttribute is an OPTIONAL capability — some
 * orgs genuinely don't expose it ("sObject type 'ProductCategoryAttribute' is not supported"). That
 * is never a real failure worth a user-visible warning as long as it's confirmed via Describe first
 * (never a blind query), so it's checked and skipped silently (debug-logged only) here rather than
 * thrown and caught by the caller as a warning. A genuine query error on a SUPPORTED object still
 * propagates normally — only the "object doesn't exist here" case is treated as optional. ── */
async function discoverInheritedAttributes(client: SalesforceClient, productId: string, exclude: Set<string>): Promise<string[]> {
  const globalDescribe = await describeGlobalCached(client);
  const supported = globalDescribe.some(obj => obj.name === "ProductCategoryAttribute" && obj.queryable);
  if (!supported) {
    client.logDebug("execution-trace", "ProductCategoryAttribute is not supported in this org; skipping category-inherited attribute discovery.");
    return [];
  }

  const catRes = await client.query<{ ProductCategoryId: string }>(`SELECT ProductCategoryId FROM ProductCategoryProduct WHERE ProductId = '${productId}' LIMIT 10`);
  const categoryIds = catRes.records.map(r => r.ProductCategoryId).filter(Boolean);
  if (categoryIds.length === 0) return [];
  const attrRes = await client.query<{ AttributeDefinitionId: string }>(
    `SELECT AttributeDefinitionId FROM ProductCategoryAttribute WHERE ProductCategoryId IN (${categoryIds.map(id => `'${id}'`).join(",")})`,
  );
  return [...new Set(attrRes.records.map(r => r.AttributeDefinitionId).filter(id => id && !exclude.has(id)))];
}

/* ── Enrich AttributeDefinition rows (name/label/data type/active/required). ── */
interface EnrichmentResult {
  meta: Map<string, { name: string; label: string; dataType: string; isActive: boolean | null; isRequired: boolean | null }>;
  sourceObject: Map<string, string>;
}

async function enrichAttributeDefinitions(client: SalesforceClient, ids: string[], candidateObjectNames: string[]): Promise<EnrichmentResult> {
  const meta: EnrichmentResult["meta"] = new Map();
  const sourceObject = new Map<string, string>();
  if (ids.length === 0) return { meta, sourceObject };

  const objectsToTry = [...new Set([...candidateObjectNames, "AttributeDefinition"])];
  const remaining = new Set(ids);
  const idsList = ids.map(id => `'${id}'`).join(",");

  for (const objName of objectsToTry) {
    if (remaining.size === 0) break;
    // §Live-org fix — Active/Required field NAMES are discovered dynamically via Describe (never assumed
    // literal), then opportunistically included in the SELECT; if Describe itself fails for this object,
    // fall back to the base field sets without them rather than skipping the object entirely.
    let activeField: DescribeField | null = null;
    let requiredField: DescribeField | null = null;
    try {
      const describe = await describeObjectCached(client, objName);
      activeField = describe.fields.find(f => f.type === "boolean" && /^(IsActive|Active)$/i.test(f.name)) ?? null;
      requiredField = describe.fields.find(f => f.type === "boolean" && /^(IsRequired|Required)$/i.test(f.name)) ?? null;
    } catch {
      // Describe failed — proceed with the base field sets below (no active/required enrichment for this object).
    }
    const fieldSets = [
      Array.from(new Set(["Id", "Name", "Label", "DataType", ...(activeField ? [activeField.name] : []), ...(requiredField ? [requiredField.name] : [])])).join(", "),
      "Id, Name, Label, DataType", "Id, Name, Label", "Id, Name",
    ];
    for (const fields of fieldSets) {
      try {
        const res = await client.query<Record<string, unknown>>(`SELECT ${fields} FROM ${objName} WHERE Id IN (${idsList})`);
        for (const rec of res.records) {
          const id = rec.Id as string;
          meta.set(id, {
            name: (rec.Name as string) ?? id,
            label: (rec.Label as string) ?? (rec.Name as string) ?? id,
            dataType: (rec.DataType as string) ?? "",
            isActive: activeField ? ((rec[activeField.name] as boolean | undefined) ?? null) : null,
            isRequired: requiredField ? ((rec[requiredField.name] as boolean | undefined) ?? null) : null,
          });
          sourceObject.set(id, objName);
          remaining.delete(id);
        }
        break; // this object worked with this field set — no need to try smaller field sets for it
      } catch {
        continue; // try a smaller field list on this same object
      }
    }
  }
  return { meta, sourceObject };
}

/* ── Per-attribute value discovery. ── */
function isReadableLabel(value: string): boolean {
  if (!value) return false;
  if (/^\d+(\.\d+)?$/.test(value)) return false; // pure numeric
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(value)) return false; // ALL_CAPS_SNAKE
  return true;
}

function pickLabelAndValue(record: Record<string, unknown>, fields: DescribeField[]): { label: string; value: string } | null {
  const get = (n: string): string | null => {
    const v = record[n];
    return typeof v === "string" || typeof v === "number" ? String(v) : null;
  };
  const directValue = get("Value");

  for (const candidateName of ["MasterLabel", "Label", "DisplayLabel", "ValueLabel"]) {
    const v = get(candidateName);
    if (v && isReadableLabel(v)) return { label: v, value: directValue ?? v };
  }
  if (directValue) return { label: directValue, value: directValue };

  const labelField = fields.find(f => /label/i.test(f.name) && get(f.name));
  if (labelField) { const v = get(labelField.name)!; return { label: v, value: v }; }

  const stringField = fields.find(f => (f.type === "string" || f.type === "textarea") && get(f.name));
  if (stringField) { const v = get(stringField.name)!; return { label: v, value: v }; }

  const name = get("Name");
  if (name) return { label: name, value: name };
  return null;
}

async function discoverAttributeValues(client: SalesforceClient, attrId: string, sourceObject: string): Promise<DiscoveredAttributeValue[]> {
  let describe: DescribeResult;
  try {
    describe = await describeObjectCached(client, sourceObject);
  } catch {
    return [];
  }

  const refFields = describe.fields.filter(f => f.type === "reference" && !SYSTEM_FIELD_EXCLUDE.test(f.name));
  if (refFields.length === 0) return [];

  let record: Record<string, unknown> | null = null;
  try {
    const res = await client.query<Record<string, unknown>>(`SELECT Id, ${refFields.map(f => f.name).join(", ")} FROM ${sourceObject} WHERE Id = '${attrId}' LIMIT 1`);
    record = res.records[0] ?? null;
  } catch {
    return [];
  }
  if (!record) return [];

  // Fast path: a reference field pointing at AttributePicklist (not …Value).
  const picklistField = refFields.find(f => f.referenceTo?.some(r => /^attributepicklist$/i.test(r)));
  if (picklistField && record[picklistField.name]) {
    const picklistId = record[picklistField.name] as string;
    try {
      const res = await client.query<{ Id: string; Name?: string; DisplayValue?: string; Value?: string; Sequence?: number }>(
        `SELECT Id, Name, DisplayValue, Value, Sequence, IsDefault FROM AttributePicklistValue WHERE PicklistId = '${picklistId}' ORDER BY Sequence ASC NULLS LAST`,
      );
      if (res.records.length > 0) {
        return res.records.map(r => {
          const label = r.Value ?? r.DisplayValue ?? r.Name ?? r.Id;
          return { value: label, label };
        });
      }
    } catch {
      // fall through to generic path
    }
  }

  const genericValues = await discoverValuesGenericPath(client, record, refFields);
  if (genericValues.length > 0) return genericValues;

  return discoverValuesFromDirectChildren(client, describe, attrId);
}

async function discoverValuesGenericPath(
  client: SalesforceClient,
  record: Record<string, unknown>,
  refFields: DescribeField[],
): Promise<DiscoveredAttributeValue[]> {
  const candidates: { childObject: string; fkField: string; refId: string }[] = [];

  for (const field of refFields) {
    const refId = record[field.name];
    if (!refId || typeof refId !== "string") continue;
    for (const targetObject of field.referenceTo ?? []) {
      let targetDescribe: DescribeResult;
      try {
        targetDescribe = await describeObjectCached(client, targetObject);
      } catch {
        continue;
      }
      const children = (targetDescribe.childRelationships ?? [])
        .filter(r => !CHILD_RELATIONSHIP_EXCLUDE.test(r.childSObject) && !CHILD_RELATIONSHIP_EXCLUDE.test(r.relationshipName ?? ""))
        .sort((a, b) => (/value/i.test(a.childSObject) ? 0 : 1) - (/value/i.test(b.childSObject) ? 0 : 1))
        .slice(0, 5);
      for (const child of children) candidates.push({ childObject: child.childSObject, fkField: child.field, refId });
    }
  }

  for (const candidate of candidates) {
    let childDescribe: DescribeResult;
    try {
      childDescribe = await describeObjectCached(client, candidate.childObject);
    } catch {
      continue;
    }
    const orderField = childDescribe.fields.find(f => /^(Sequence|SortOrder)$/i.test(f.name));
    const selectableFields = childDescribe.fields.filter(f => !NON_SELECTABLE_TYPES.has(f.type) && !SYSTEM_FIELD_EXCLUDE.test(f.name));
    const fieldNames = Array.from(new Set(["Id", ...selectableFields.map(f => f.name)]));
    const orderBy = orderField ? ` ORDER BY ${orderField.name} ASC NULLS LAST` : "";

    let records: Record<string, unknown>[] = [];
    try {
      const res = await client.query<Record<string, unknown>>(`SELECT ${fieldNames.join(", ")} FROM ${candidate.childObject} WHERE ${candidate.fkField} = '${candidate.refId}'${orderBy}`);
      records = res.records;
    } catch {
      try {
        const res = await client.query<Record<string, unknown>>(`SELECT Id, Name FROM ${candidate.childObject} WHERE ${candidate.fkField} = '${candidate.refId}'`);
        records = res.records;
      } catch {
        continue;
      }
    }
    if (records.length === 0) continue;

    const values: DiscoveredAttributeValue[] = [];
    for (const rec of records) {
      const picked = pickLabelAndValue(rec, selectableFields);
      if (picked) values.push({ value: picked.value, label: picked.label });
    }
    if (values.length > 0) return values;
  }
  return [];
}

async function discoverValuesFromDirectChildren(client: SalesforceClient, describe: DescribeResult, attrId: string): Promise<DiscoveredAttributeValue[]> {
  const children = (describe.childRelationships ?? []).filter(r => !CHILD_RELATIONSHIP_EXCLUDE.test(r.childSObject));
  for (const child of children) {
    let childDescribe: DescribeResult;
    try {
      childDescribe = await describeObjectCached(client, child.childSObject);
    } catch {
      continue;
    }
    const selectableFields = childDescribe.fields.filter(f => !NON_SELECTABLE_TYPES.has(f.type) && !SYSTEM_FIELD_EXCLUDE.test(f.name));
    const fieldNames = Array.from(new Set(["Id", ...selectableFields.map(f => f.name)]));
    let records: Record<string, unknown>[] = [];
    try {
      const res = await client.query<Record<string, unknown>>(`SELECT ${fieldNames.join(", ")} FROM ${child.childSObject} WHERE ${child.field} = '${attrId}'`);
      records = res.records;
    } catch {
      continue;
    }
    if (records.length < 2) continue; // only accept as a real picklist with >= 2 rows
    return records.map(rec => {
      const picked = pickLabelAndValue(rec, selectableFields) ?? { label: rec.Id as string, value: rec.Id as string };
      return { value: picked.value, label: picked.label };
    });
  }
  return [];
}
