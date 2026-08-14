import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { resolveAttributeSchema, fieldExists, picklistValues, type AttributeSchema } from "./schema";
import type { AttributeListItem, AttributeDetail, AttributePicklistValueRow, AttributeRelatedProduct } from "@/lib/attributes/types";

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
  try {
    const res = await client.query<{ [k: string]: unknown; cnt: number }>(
      `SELECT ${schema.plValueFKField}, COUNT(Id) cnt FROM AttributePicklistValue WHERE ${schema.plValueFKField} IN (${idList}) GROUP BY ${schema.plValueFKField}`,
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
    const fields = ["Id", "Name"];
    if (hasValue) fields.push("Value");
    if (hasDisplayValue) fields.push("DisplayValue");
    if (hasSequence) fields.push("Sequence");
    if (hasStatus) fields.push("Status");

    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT ${fields.join(", ")} FROM AttributePicklistValue WHERE ${schema.plValueFKField} = '${soqlEscape(picklistId)}'` +
        (hasSequence ? " ORDER BY Sequence" : ""),
      );
      picklistValueRows = res.records.map(v => ({
        id: v.Id as string,
        value: (hasValue ? v.Value as string : null) ?? (v.Name as string),
        displayValue: (hasDisplayValue ? v.DisplayValue as string : null) ?? (v.Name as string),
        sequence: (hasSequence ? v.Sequence as number : null) ?? 0,
        isActive: hasStatus ? v.Status !== "Inactive" : true,
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

  return {
    ...listItem,
    label: row.Label ?? null,
    picklistId,
    picklistValues: picklistValueRows,
    dataTypeEditable: dataTypeFieldDescribe?.updateable ?? false,
    validDataTypes: picklistValues(attrDefD, dataTypeField),
  };
}
