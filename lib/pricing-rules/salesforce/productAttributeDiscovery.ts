/**
 * §4 — schema-driven discovery of a product's price-impacting attributes.
 * The only hardcoded object names are the standard RCA ones (Product2,
 * ProductSellingModel(Option), PricebookEntry, ProductCategoryProduct,
 * ProductCategoryAttribute, AttributeCategory, AttributePicklist,
 * AttributePicklistValue, AttributeSetItem) plus a final-fallback literal
 * "AttributeDefinition" — the object that actually links Product2 to its
 * overridden attributes varies by org/package and is discovered at
 * runtime via Describe.
 */
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import { describeObjectCached, describeGlobalCached, findAllReferenceFieldsToTarget } from "@/lib/salesforce/describe";
import { resolveProduct2ByName, resolveProduct2ById, resolveSellingModelForProduct, resolveStandardPricebookEntry } from "./productLookup";
import type { AttributeDefinition, AttributeValue, ProductAttributeData, ProcedureStep } from "@/lib/pricing-rules/types";

export class ProductAttributeAuthError extends Error {}
export class ProductNotFoundError extends Error {}

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

/** Re-throw as ProductAttributeAuthError when `err` looks like an expired/invalid session; otherwise return normally so the caller can degrade to a warning. */
function rethrowIfAuthError(err: unknown): void {
  if (err instanceof SalesforceError) {
    const bodyStr = JSON.stringify(err.body ?? "");
    if (err.status === 401 || bodyStr.includes("INVALID_SESSION_ID")) {
      throw new ProductAttributeAuthError(err.message);
    }
  }
}

const SYSTEM_FIELD_EXCLUDE = /^(OwnerId|CreatedById|LastModifiedById|RecordTypeId|CreatedDate|LastModifiedDate|SystemModstamp|IsDeleted)$/i;
const CHILD_RELATIONSHIP_EXCLUDE = /definition|ChangeEvent|Share|History|Feed/i;
const NON_SELECTABLE_TYPES = new Set(["base64", "location", "address"]);

export async function discoverProductAttributes(
  client: SalesforceClient,
  productName: string,
  productId?: string,
): Promise<{ data: ProductAttributeData; steps: ProcedureStep[] }> {
  const steps: ProcedureStep[] = [];
  const warnings: string[] = [];

  // Resolving by Id (when the caller already has one — e.g. the user picked an exact record from the
  // ProductLookup dropdown) is mandatory whenever available: Product2.Name is not unique in Salesforce,
  // so a name-only re-resolve here could silently land on a different record than the one actually
  // selected. Only fall back to name-based resolution when no Id was supplied.
  step(steps, "resolve-product", "start", productId ? `Resolving Product2 by Id ${productId}.` : `Resolving Product2 "${productName}".`);
  let product;
  try {
    product = productId ? await resolveProduct2ById(client, productId) : await resolveProduct2ByName(client, productName);
  } catch (err) {
    rethrowIfAuthError(err);
    throw err;
  }
  if (!product) {
    const message = productId ? `Product Id "${productId}" was not found.` : `Product "${productName}" was not found.`;
    step(steps, "resolve-product", "error", message);
    throw new ProductNotFoundError(productId ? `Product Id "${productId}" was not found in Salesforce.` : `Product "${productName}" was not found in Salesforce.`);
  }
  step(steps, "resolve-product", "success", `Found Product2 ${product.id}.`, product);

  let sellingModel: { id: string; name: string } | null = null;
  try {
    sellingModel = await resolveSellingModelForProduct(client, product.id);
    step(steps, "resolve-selling-model", sellingModel ? "success" : "info", sellingModel ? `Selling model: ${sellingModel.name}` : "No ProductSellingModelOption found for this product.");
  } catch (err) {
    rethrowIfAuthError(err);
    step(steps, "resolve-selling-model", "error", "Failed to resolve selling model.", String(err));
  }

  let pricebookEntry = { effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: "2099-12-31", basePrice: null as number | null };
  try {
    pricebookEntry = await resolveStandardPricebookEntry(client, product.id);
    step(steps, "resolve-pricebook-entry", pricebookEntry.basePrice !== null ? "success" : "info",
      pricebookEntry.basePrice !== null
        ? `Base Price ${pricebookEntry.basePrice} (effective ${pricebookEntry.effectiveFrom} -> ${pricebookEntry.effectiveTo}).`
        : `No active Standard Price Book entry found — Base Price could not be determined (effective dates defaulted to ${pricebookEntry.effectiveFrom} -> ${pricebookEntry.effectiveTo}).`);
    if (pricebookEntry.basePrice === null) warnings.push("No active Standard Price Book entry was found for this product — Base Price could not be determined automatically. You can continue without it.");
  } catch (err) {
    rethrowIfAuthError(err);
  }

  let overridden: OverriddenDiscovery = { attrDefIds: new Set(), priceImpactingMap: new Map(), linkObjectNames: [], attrDefObjectNames: new Set() };
  try {
    overridden = await discoverOverriddenAttributes(client, product.id);
    step(steps, "discover-overrides", "success", `Found ${overridden.attrDefIds.size} overridden attribute(s) via [${overridden.linkObjectNames.join(", ") || "none"}].`);
  } catch (err) {
    rethrowIfAuthError(err);
    warnings.push("Could not discover overridden product attributes.");
    step(steps, "discover-overrides", "error", "Overridden-attribute discovery failed.", err instanceof Error ? err.message : String(err));
  }

  let inheritedIds: string[] = [];
  try {
    inheritedIds = await discoverInheritedAttributes(client, product.id, overridden.attrDefIds);
    step(steps, "discover-inherited", "success", `Found ${inheritedIds.length} inherited attribute(s) via category.`);
  } catch (err) {
    rethrowIfAuthError(err);
    warnings.push("Could not discover category-inherited product attributes.");
  }

  const allAttrDefIds = [...overridden.attrDefIds, ...inheritedIds];
  if (allAttrDefIds.length === 0) warnings.push("No attributes (overridden or inherited) were found for this product.");

  let enrichment: EnrichmentResult = { meta: new Map(), sourceObject: new Map() };
  try {
    enrichment = await enrichAttributeDefinitions(client, allAttrDefIds, [...overridden.attrDefObjectNames]);
  } catch (err) {
    rethrowIfAuthError(err);
    warnings.push("Failed to enrich attribute definitions with labels/data types.");
  }

  const categoryIds = [...new Set([...enrichment.meta.values()].map(v => v.attributeCategoryId).filter((v): v is string => !!v))];
  const picklistIds = [...new Set([...enrichment.meta.values()].map(v => v.attributePicklistId).filter((v): v is string => !!v))];
  const categoryNames = await safeIdNameMap(client, "AttributeCategory", categoryIds);
  const picklistNames = await safeIdNameMap(client, "AttributePicklist", picklistIds);

  const attributes: AttributeDefinition[] = [];
  for (const id of allAttrDefIds) {
    const meta = enrichment.meta.get(id);
    if (!meta) continue;
    attributes.push({
      id,
      name: meta.name,
      label: meta.label || meta.name,
      developerName: meta.developerName || meta.name,
      dataType: meta.dataType || "",
      attributeCategory: (meta.attributeCategoryId && categoryNames.get(meta.attributeCategoryId)) || "",
      attributePicklistName: (meta.attributePicklistId && picklistNames.get(meta.attributePicklistId)) || "",
      isPriceImpacting: overridden.priceImpactingMap.has(id) ? overridden.priceImpactingMap.get(id) ?? null : null,
      values: [],
      source: overridden.attrDefIds.has(id) ? "overridden" : "inherited",
    });
  }
  step(steps, "combine-attributes", "success", `Combined ${attributes.length} attribute definition(s).`);

  for (const attr of attributes) {
    const sourceObject = enrichment.sourceObject.get(attr.id) ?? "AttributeDefinition";
    try {
      attr.values = await discoverAttributeValues(client, attr.id, sourceObject);
      step(steps, "discover-values", attr.values.length > 0 ? "success" : "info", `${attr.label}: ${attr.values.length} value(s).`);
    } catch (err) {
      rethrowIfAuthError(err);
      warnings.push(`Could not discover values for attribute "${attr.label}".`);
    }
  }

  const data: ProductAttributeData = {
    product: {
      id: product.id,
      name: product.name,
      productCode: product.productCode,
      status: product.isActive ? "Active" : "Inactive",
      currency: product.currencyIsoCode ?? "USD",
      sellingModelId: sellingModel?.id ?? "",
      sellingModelName: sellingModel?.name ?? "",
      effectiveFrom: pricebookEntry.effectiveFrom,
      effectiveTo: pricebookEntry.effectiveTo,
      basePrice: pricebookEntry.basePrice,
    },
    attributes,
    totalAttributes: attributes.length,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };

  return { data, steps };
}

/* ── Step 4: discover the org's "overridden attribute" link object(s). ── */
interface OverriddenDiscovery {
  attrDefIds: Set<string>;
  priceImpactingMap: Map<string, boolean | null>;
  linkObjectNames: string[];
  attrDefObjectNames: Set<string>;
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
  const linkObjectNames: string[] = [];
  const attrDefObjectNames = new Set<string>();
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
    if (attrDefFields.length === 0 && setItemFields.length === 0) continue;

    const product2Field = product2Fields[0];
    const fieldNames = Array.from(new Set(["Id", product2Field.name, ...attrDefFields.map(f => f.name), ...setItemFields.map(f => f.name), ...priceImpactFields.map(f => f.name)]));

    let records: Record<string, unknown>[];
    try {
      const res = await client.query<Record<string, unknown>>(`SELECT ${fieldNames.join(", ")} FROM ${candidateName} WHERE ${product2Field.name} = '${productId}'`);
      records = res.records;
    } catch {
      continue;
    }
    if (records.length === 0) continue;

    linkObjectNames.push(candidateName);
    for (const f of attrDefFields) for (const target of f.referenceTo ?? []) if (/attributedefinition/i.test(target)) attrDefObjectNames.add(target);

    for (const rec of records) {
      let defId: string | null = null;
      for (const f of attrDefFields) {
        const v = rec[f.name];
        if (typeof v === "string" && v) { defId = v; break; }
      }
      if (defId) {
        attrDefIds.add(defId);
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
      for (const rec of res.records) if (rec.AttributeDefinitionId) attrDefIds.add(rec.AttributeDefinitionId);
    } catch {
      // best-effort
    }
  }

  return { attrDefIds, priceImpactingMap, linkObjectNames, attrDefObjectNames };
}

/* ── Step 5: inherited attributes via category. ── */
async function discoverInheritedAttributes(client: SalesforceClient, productId: string, exclude: Set<string>): Promise<string[]> {
  const catRes = await client.query<{ ProductCategoryId: string }>(`SELECT ProductCategoryId FROM ProductCategoryProduct WHERE ProductId = '${productId}' LIMIT 10`);
  const categoryIds = catRes.records.map(r => r.ProductCategoryId).filter(Boolean);
  if (categoryIds.length === 0) return [];
  const attrRes = await client.query<{ AttributeDefinitionId: string }>(
    `SELECT AttributeDefinitionId FROM ProductCategoryAttribute WHERE ProductCategoryId IN (${categoryIds.map(id => `'${id}'`).join(",")})`,
  );
  return [...new Set(attrRes.records.map(r => r.AttributeDefinitionId).filter(id => id && !exclude.has(id)))];
}

/* ── Step 6: enrich AttributeDefinition rows. ── */
interface EnrichmentResult {
  meta: Map<string, { name: string; label: string; developerName: string; dataType: string; attributeCategoryId: string | null; attributePicklistId: string | null }>;
  sourceObject: Map<string, string>;
}

async function enrichAttributeDefinitions(client: SalesforceClient, ids: string[], candidateObjectNames: string[]): Promise<EnrichmentResult> {
  const meta: EnrichmentResult["meta"] = new Map();
  const sourceObject = new Map<string, string>();
  if (ids.length === 0) return { meta, sourceObject };

  const objectsToTry = [...new Set([...candidateObjectNames, "AttributeDefinition"])];
  const fieldSets = [
    "Id, Name, Label, DeveloperName, DataType, AttributeCategoryId, AttributePicklistId",
    "Id, Name, Label, DeveloperName, DataType, AttributeCategoryId",
    "Id, Name, Label, DeveloperName, DataType",
    "Id, Name, Label",
  ];
  const remaining = new Set(ids);
  const idsList = ids.map(id => `'${id}'`).join(",");

  for (const objName of objectsToTry) {
    if (remaining.size === 0) break;
    for (const fields of fieldSets) {
      try {
        const res = await client.query<Record<string, unknown>>(`SELECT ${fields} FROM ${objName} WHERE Id IN (${idsList})`);
        for (const rec of res.records) {
          const id = rec.Id as string;
          meta.set(id, {
            name: (rec.Name as string) ?? id,
            label: (rec.Label as string) ?? (rec.Name as string) ?? id,
            developerName: (rec.DeveloperName as string) ?? (rec.Name as string) ?? id,
            dataType: (rec.DataType as string) ?? "",
            attributeCategoryId: (rec.AttributeCategoryId as string) ?? null,
            attributePicklistId: (rec.AttributePicklistId as string) ?? null,
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

async function safeIdNameMap(client: SalesforceClient, objectName: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  try {
    const res = await client.query<{ Id: string; Name?: string }>(`SELECT Id, Name FROM ${objectName} WHERE Id IN (${ids.map(id => `'${id}'`).join(",")})`);
    for (const rec of res.records) map.set(rec.Id, rec.Name ?? rec.Id);
  } catch {
    // best-effort; leave names blank
  }
  return map;
}

/* ── Step 8: per-attribute picklist-value discovery. ── */
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

export async function discoverAttributeValues(client: SalesforceClient, attrId: string, sourceObject: string): Promise<AttributeValue[]> {
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
        return res.records.map((r, i) => {
          const label = r.Value ?? r.DisplayValue ?? r.Name ?? r.Id;
          return { id: r.Id, label, value: label, isActive: null, sortOrder: r.Sequence ?? i };
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
): Promise<AttributeValue[]> {
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

    const values: AttributeValue[] = [];
    records.forEach((rec, i) => {
      const picked = pickLabelAndValue(rec, selectableFields);
      if (!picked) return;
      values.push({ id: rec.Id as string, label: picked.label, value: picked.value, isActive: (rec.IsActive as boolean) ?? null, sortOrder: (rec.Sequence as number) ?? (rec.SortOrder as number) ?? i });
    });
    if (values.length > 0) return values;
  }
  return [];
}

async function discoverValuesFromDirectChildren(client: SalesforceClient, describe: DescribeResult, attrId: string): Promise<AttributeValue[]> {
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
    return records.map((rec, i) => {
      const picked = pickLabelAndValue(rec, selectableFields) ?? { label: rec.Id as string, value: rec.Id as string };
      return { id: rec.Id as string, label: picked.label, value: picked.value, isActive: (rec.IsActive as boolean) ?? null, sortOrder: i };
    });
  }
  return [];
}
