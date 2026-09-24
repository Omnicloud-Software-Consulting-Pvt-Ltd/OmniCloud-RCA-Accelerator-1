import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { resolveAttributeSchema, fieldExists, isFieldUpdateable, picklistValues, type AttributeSchema } from "./schema";
import type { AttributeListItem, AttributeDetail, AttributePicklistValueRow, AttributeRelatedProduct, AttributeProductConfig } from "@/lib/attributes/types";

interface AttrDefRow {
  Id: string;
  Name: string;
  Label?: string;
  DeveloperName?: string;
  IsActive: boolean;
  Description?: string;
  CreatedDate: string;
  LastModifiedDate: string;
  LastModifiedBy?: { Name: string } | null;
  [key: string]: unknown;
}

async function fetchAttrDefRows(client: SalesforceClient, schema: AttributeSchema, id?: string): Promise<AttrDefRow[]> {
  const d = schema.attributeDefinitionDescribe;
  const fields = ["Id", "Name", "DeveloperName", "IsActive", "CreatedDate", "LastModifiedDate", "LastModifiedBy.Name"];
  if (fieldExists(d, "Label")) fields.push("Label");
  if (fieldExists(d, "Description")) fields.push("Description");
  if (schema.attrDefDatatypeField) fields.push(schema.attrDefDatatypeField);
  if (schema.attrDefPicklistFKField) fields.push(schema.attrDefPicklistFKField);
  if (fieldExists(d, "DefaultValue")) fields.push("DefaultValue");

  const where = id ? `WHERE Id = '${soqlEscape(id)}'` : "";
  const order = id ? "" : "ORDER BY LastModifiedDate DESC LIMIT 500";
  const soql = `SELECT ${fields.join(", ")} FROM AttributeDefinition ${where} ${order}`.trim();
  const res = await client.query<AttrDefRow>(soql);
  return res.records;
}

async function resolvePicklistValueCounts(client: SalesforceClient, schema: AttributeSchema, picklistIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (picklistIds.length === 0) return counts;
  const idList = picklistIds.map(id => `'${soqlEscape(id)}'`).join(",");
  const plD = schema.attributePicklistValueDescribe;
  const hasStatus = fieldExists(plD, "Status");
  const hasIsActive = fieldExists(plD, "IsActive");
  let where = `WHERE ${schema.plValueFKField} IN (${idList})`;
  if (hasStatus) where += " AND Status != 'Inactive'";
  else if (hasIsActive) where += " AND IsActive = true";
  try {
    const res = await client.query<{ [k: string]: unknown; cnt: number }>(
      `SELECT ${schema.plValueFKField}, COUNT(Id) cnt FROM AttributePicklistValue ${where} GROUP BY ${schema.plValueFKField}`,
    );
    for (const r of res.records) {
      const key = r[schema.plValueFKField];
      if (typeof key === "string") counts.set(key, r.cnt);
    }
  } catch { /* AttributePicklistValue not accessible, or FK field mismatch — leave counts at 0 rather than guessing */ }
  return counts;
}

/** Every Product2 an AttributeDefinition is attached to via ProductAttributeDefinition, keyed by AttributeDefinitionId. */
async function resolveRelatedProducts(client: SalesforceClient, schema: AttributeSchema, attrDefIds: string[]): Promise<Map<string, AttributeRelatedProduct[]>> {
  const map = new Map<string, AttributeRelatedProduct[]>();
  if (attrDefIds.length === 0 || !schema.padProduct2FKField) return map;
  const idList = attrDefIds.map(id => `'${soqlEscape(id)}'`).join(",");
  try {
    const res = await client.query<{ AttributeDefinitionId: string; [k: string]: unknown }>(
      `SELECT AttributeDefinitionId, ${schema.padProduct2FKField} FROM ProductAttributeDefinition WHERE AttributeDefinitionId IN (${idList}) LIMIT 2000`,
    );
    const productIds = new Set<string>();
    const pairs: { attrDefId: string; productId: string }[] = [];
    for (const r of res.records) {
      const productId = r[schema.padProduct2FKField!] as string | undefined;
      if (!productId) continue;
      productIds.add(productId);
      pairs.push({ attrDefId: r.AttributeDefinitionId, productId });
    }
    if (productIds.size === 0) return map;
    const prodIdList = [...productIds].map(id => `'${soqlEscape(id)}'`).join(",");
    const prodRes = await client.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Product2 WHERE Id IN (${prodIdList})`);
    const nameById = new Map(prodRes.records.map(p => [p.Id, p.Name]));
    for (const { attrDefId, productId } of pairs) {
      const name = nameById.get(productId);
      if (!name) continue;
      const list = map.get(attrDefId) ?? [];
      if (!list.some(p => p.id === productId)) list.push({ id: productId, name });
      map.set(attrDefId, list);
    }
  } catch { /* ProductAttributeDefinition not accessible, or none linked */ }
  return map;
}

function rowToListItem(
  row: AttrDefRow,
  schema: AttributeSchema,
  picklistCounts: Map<string, number>,
  relatedProducts: Map<string, AttributeRelatedProduct[]>,
): AttributeListItem {
  const picklistId = schema.attrDefPicklistFKField ? ((row[schema.attrDefPicklistFKField] as string | undefined) ?? null) : null;
  const dataType = schema.attrDefDatatypeField ? ((row[schema.attrDefDatatypeField] as string | undefined) ?? null) : null;
  return {
    id: row.Id,
    name: row.Name,
    apiName: row.DeveloperName ?? null,
    dataType,
    isActive: row.IsActive !== false,
    description: row.Description ?? null,
    isPicklist: !!picklistId,
    picklistValueCount: picklistId ? (picklistCounts.get(picklistId) ?? 0) : 0,
    relatedProducts: relatedProducts.get(row.Id) ?? [],
    createdDate: row.CreatedDate,
    lastModifiedDate: row.LastModifiedDate,
    lastModifiedByName: row.LastModifiedBy?.Name ?? null,
  };
}

/** Every AttributeDefinition in the org — Attribute History/Dashboard/Catalog's shared read. */
export async function loadAttributeList(client: SalesforceClient): Promise<AttributeListItem[]> {
  const schema = await resolveAttributeSchema(client);
  const rows = await fetchAttrDefRows(client, schema);

  const picklistIds = schema.attrDefPicklistFKField
    ? [...new Set(rows.map(r => r[schema.attrDefPicklistFKField!] as string | undefined).filter((v): v is string => !!v))]
    : [];
  const [picklistCounts, relatedProducts] = await Promise.all([
    resolvePicklistValueCounts(client, schema, picklistIds),
    resolveRelatedProducts(client, schema, rows.map(r => r.Id)),
  ]);

  return rows.map(r => rowToListItem(r, schema, picklistCounts, relatedProducts));
}

/**
 * Every value on a picklist, including Inactive (removed) ones — used by the
 * PATCH route's duplicate guard so re-adding a previously removed value
 * restores that record instead of creating a second one with the same text.
 */
export async function loadPicklistValueRecords(
  client: SalesforceClient, picklistId: string,
): Promise<{ id: string; texts: string[]; sequence: number; isActive: boolean }[]> {
  const schema = await resolveAttributeSchema(client);
  const plD = schema.attributePicklistValueDescribe;
  const textFields = ["Name", "Value", "DisplayValue"].filter(f => fieldExists(plD, f));
  const fields = ["Id", ...textFields.filter(f => f !== "Name"), "Name"];
  if (fieldExists(plD, "Sequence")) fields.push("Sequence");
  if (fieldExists(plD, "Status")) fields.push("Status");
  else if (fieldExists(plD, "IsActive")) fields.push("IsActive");
  const res = await client.query<Record<string, unknown>>(
    `SELECT ${[...new Set(fields)].join(", ")} FROM AttributePicklistValue WHERE ${schema.plValueFKField} = '${soqlEscape(picklistId)}'`,
  );
  return res.records.map(r => ({
    id: r.Id as string,
    texts: textFields.map(f => r[f]).filter((v): v is string => typeof v === "string" && v.length > 0),
    sequence: typeof r.Sequence === "number" ? r.Sequence : 0,
    isActive: "Status" in r ? r.Status !== "Inactive" : r.IsActive !== false,
  }));
}

/** This attribute's ProductAttributeDefinition rows — its real per-product configuration. */
async function loadProductConfigs(client: SalesforceClient, schema: AttributeSchema, attrDefId: string): Promise<AttributeProductConfig[]> {
  const d = schema.productAttributeDefinitionDescribe;
  if (!d) return [];
  const cfgFields = ["DefaultValue", "MinimumValue", "MaximumValue", "StepValue"].filter(f => fieldExists(d, f));
  const fk = schema.padProduct2FKField;
  const fields = ["Id", ...cfgFields, ...(fk ? [fk] : [])];
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${fields.join(", ")} FROM ProductAttributeDefinition WHERE AttributeDefinitionId = '${soqlEscape(attrDefId)}' LIMIT 200`,
    );
    const productIds = fk ? [...new Set(res.records.map(r => r[fk] as string | undefined).filter((v): v is string => !!v))] : [];
    const names = new Map<string, string>();
    if (productIds.length) {
      const pr = await client.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Product2 WHERE Id IN (${productIds.map(i => `'${soqlEscape(i)}'`).join(",")})`);
      for (const p of pr.records) names.set(p.Id, p.Name);
    }
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return res.records.map(r => {
      const productId = fk ? ((r[fk] as string | undefined) ?? null) : null;
      return {
        id: r.Id as string,
        productId,
        productName: productId ? names.get(productId) ?? null : null,
        defaultValue: str(r.DefaultValue),
        minimumValue: str(r.MinimumValue),
        maximumValue: str(r.MaximumValue),
        stepValue: str(r.StepValue),
      };
    });
  } catch {
    return [];
  }
}

/** Full single-attribute read — Attribute Detail/Edit's shared load, including picklist values. */
export async function loadAttributeDetail(client: SalesforceClient, id: string): Promise<AttributeDetail> {
  const schema = await resolveAttributeSchema(client);
  const rows = await fetchAttrDefRows(client, schema, id);
  const row = rows[0];
  if (!row) throw new Error(`Attribute ${id} not found`);

  const picklistId = schema.attrDefPicklistFKField ? ((row[schema.attrDefPicklistFKField] as string | undefined) ?? null) : null;

  let picklistValueRows: AttributePicklistValueRow[] = [];
  if (picklistId) {
    const plD = schema.attributePicklistValueDescribe;
    const hasValue = fieldExists(plD, "Value");
    const hasDisplayValue = fieldExists(plD, "DisplayValue");
    const hasSequence = fieldExists(plD, "Sequence");
    const hasStatus = fieldExists(plD, "Status");
    const hasIsActive = fieldExists(plD, "IsActive");
    const fields = ["Id", "Name"];
    if (hasValue) fields.push("Value");
    if (hasDisplayValue) fields.push("DisplayValue");
    if (hasSequence) fields.push("Sequence");
    if (hasStatus) fields.push("Status");
    if (hasIsActive) fields.push("IsActive");

    // Removed values are soft-deactivated (Status/IsActive), never hard-deleted
    // when the org supports a status field (see removePicklistValue) — this
    // read MUST exclude them, or a "deleted" value reappears on next load.
    let where = `WHERE ${schema.plValueFKField} = '${soqlEscape(picklistId)}'`;
    if (hasStatus) where += " AND Status != 'Inactive'";
    else if (hasIsActive) where += " AND IsActive = true";

    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT ${fields.join(", ")} FROM AttributePicklistValue ${where}` +
        (hasSequence ? " ORDER BY Sequence" : ""),
      );
      picklistValueRows = res.records.map(v => ({
        id: v.Id as string,
        value: (hasValue ? v.Value as string : null) ?? (v.Name as string),
        displayValue: (hasDisplayValue ? v.DisplayValue as string : null) ?? (v.Name as string),
        sequence: (hasSequence ? v.Sequence as number : null) ?? 0,
        isActive: hasStatus ? v.Status !== "Inactive" : (hasIsActive ? v.IsActive !== false : true),
      }));
    } catch { /* AttributePicklistValue not accessible — leave empty rather than guessing */ }
  }

  const [picklistCounts, relatedProducts] = await Promise.all([
    picklistId ? resolvePicklistValueCounts(client, schema, [picklistId]) : Promise.resolve(new Map<string, number>()),
    resolveRelatedProducts(client, schema, [id]),
  ]);

  const listItem = rowToListItem(row, schema, picklistCounts, relatedProducts);
  const attrDefD = schema.attributeDefinitionDescribe;
  const dataTypeField = schema.attrDefDatatypeField;
  const dataTypeFieldDescribe = dataTypeField ? attrDefD?.fields.find(f => f.name === dataTypeField) ?? null : null;

  const padD = schema.productAttributeDefinitionDescribe;
  const [productConfigs, picklistSharedCount] = await Promise.all([
    loadProductConfigs(client, schema, id),
    picklistId && schema.attrDefPicklistFKField
      ? client.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM AttributeDefinition WHERE ${schema.attrDefPicklistFKField} = '${soqlEscape(picklistId)}'`)
          .then(r => r.records[0]?.cnt ?? 1).catch(() => 1)
      : Promise.resolve(0),
  ]);

  return {
    ...listItem,
    label: row.Label ?? null,
    picklistId,
    picklistValues: picklistValueRows,
    dataTypeEditable: dataTypeFieldDescribe?.updateable ?? false,
    validDataTypes: picklistValues(attrDefD, dataTypeField),
    defaultValue: (row.DefaultValue as string | null | undefined) ?? null,
    defaultValueEditable: isFieldUpdateable(attrDefD, "DefaultValue"),
    productConfigs,
    productConfigFields: ["DefaultValue", "MinimumValue", "MaximumValue", "StepValue"].filter(f => isFieldUpdateable(padD, f)),
    picklistSharedCount,
  };
}
