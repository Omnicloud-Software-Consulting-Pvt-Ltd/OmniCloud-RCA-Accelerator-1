import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { billingDescribe, billingDescribeGlobal, getModuleSchema, nameFieldOf } from "@/lib/billing/server/discovery";
import { resolveNamesById, SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { billingFieldSection, getBillingModule } from "@/lib/billing/registry";
import type {
  BillingDetailField, BillingDetailResponse, BillingListResponse,
  BillingModuleSchema, BillingRecordRow, BillingReferenceValue,
} from "@/lib/billing/types";

function statusText(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "boolean") return raw ? "Active" : "Inactive";
  return String(raw);
}

/** Relationship traversal for a reference column: `Rel.NameField`, using the target's real Describe name field (polymorphic → the `Name` entity). */
async function relationshipSelect(client: SalesforceClient, col: { field: string; referenceTo: string[] }, schema: BillingModuleSchema): Promise<{ path: string; rel: string; nameField: string } | null> {
  const meta = schema.fields.find(f => f.name === col.field);
  if (!meta?.relationshipName) return null;
  if (col.referenceTo.length !== 1) return { path: `${meta.relationshipName}.Name`, rel: meta.relationshipName, nameField: "Name" };
  try {
    const nameField = nameFieldOf(await billingDescribe(client, col.referenceTo[0]))?.name;
    return nameField ? { path: `${meta.relationshipName}.${nameField}`, rel: meta.relationshipName, nameField } : null;
  } catch {
    return null;
  }
}

export interface ListOptions {
  search?: string;
  limit?: number;
  /** Restrict to children of one parent, e.g. treatment items of a treatment. Field must be a real reference field on this object. */
  parentField?: string;
  parentId?: string;
}

export async function listBillingRecords(client: SalesforceClient, moduleKey: string, opts: ListOptions = {}): Promise<BillingListResponse> {
  const schema = await getModuleSchema(client, moduleKey);
  const has = (name: string) => schema.fields.some(f => f.name === name);

  const select = new Set<string>(["Id"]);
  if (schema.nameField) select.add(schema.nameField);
  if (schema.statusField) select.add(schema.statusField);
  for (const f of ["CreatedDate", "LastModifiedDate"]) if (has(f)) select.add(f);
  const createdByRel = schema.fields.find(f => f.name === "CreatedById")?.relationshipName;
  if (createdByRel) select.add(`${createdByRel}.Name`);

  const relSelects = new Map<string, { rel: string; nameField: string }>();
  for (const col of schema.columns) {
    select.add(col.field);
    if (col.type === "reference") {
      const rs = await relationshipSelect(client, col, schema);
      if (rs) { select.add(rs.path); relSelects.set(col.field, rs); }
    }
  }

  const where: string[] = [];
  const nameMeta = schema.fields.find(f => f.name === schema.nameField);
  const term = opts.search?.trim();
  if (term && nameMeta && ["string", "textarea", "email", "phone", "url"].includes(nameMeta.type)) {
    where.push(`${nameMeta.name} LIKE '%${soqlEscape(term).replace(/%/g, "\\%").replace(/_/g, "\\_")}%'`);
  }
  if (opts.parentField && opts.parentId) {
    const pf = schema.fields.find(f => f.name === opts.parentField && f.type === "reference");
    if (!pf) throw new Error(`${opts.parentField} is not a reference field on ${schema.sobject}.`);
    if (!SALESFORCE_ID.test(opts.parentId)) throw new Error("Invalid parent record Id.");
    where.push(`${pf.name} = '${soqlEscape(opts.parentId)}'`);
  }

  for (const f of getBillingModule(moduleKey)?.listFilter ?? []) {
    const head = f.field.split(".")[0];
    const ok = f.field.includes(".") ? schema.fields.some(x => x.relationshipName === head) : has(f.field);
    if (!ok || !/^[A-Za-z0-9_.]+$/.test(f.field)) throw new Error(`${f.field} isn't a field of ${schema.sobject} in this org.`);
    where.push(`${f.field} = '${soqlEscape(f.value)}'`);
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const orderBy = has("LastModifiedDate") ? "LastModifiedDate DESC" : (schema.nameField ?? "Id");
  const soql = `SELECT ${[...select].join(", ")} FROM ${schema.sobject}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy} LIMIT ${limit}`;
  const res = await client.query<Record<string, unknown>>(soql);

  // Polymorphic lookups traverse the generic `Name` entity, whose attributes.type is literally "Name" —
  // the real object comes from the Id's key prefix in the org's own global Describe.
  const hasPolymorphic = schema.columns.some(c => c.type === "reference" && c.referenceTo.length > 1);
  const byPrefix = hasPolymorphic
    ? new Map((await billingDescribeGlobal(client)).filter(g => g.keyPrefix).map(g => [g.keyPrefix as string, g.name]))
    : new Map<string, string>();

  const records: BillingRecordRow[] = res.records.map(r => {
    const references: Record<string, BillingReferenceValue | null> = {};
    const values: Record<string, unknown> = {};
    for (const col of schema.columns) {
      values[col.field] = r[col.field] ?? null;
      if (col.type !== "reference") continue;
      const id = r[col.field] as string | null;
      const rs = relSelects.get(col.field);
      const relObj = rs ? (r[rs.rel] as Record<string, unknown> | null) : null;
      const sobject = col.referenceTo.length > 1
        ? (id ? byPrefix.get(id.slice(0, 3)) : undefined) ?? col.referenceTo[0] ?? ""
        : col.referenceTo[0] ?? (relObj?.attributes as { type?: string } | undefined)?.type ?? "";
      const meta = schema.fields.find(f => f.name === col.field);
      references[col.field] = id
        ? { id, name: (relObj?.[rs!.nameField] as string) ?? "Linked record", sobject, moduleKey: meta?.referenceModules[sobject] ?? null }
        : null;
    }
    const createdBy = createdByRel ? (r[createdByRel] as { Name?: string } | null) : null;
    return {
      id: r.Id as string,
      name: schema.nameField ? ((r[schema.nameField] as string) ?? (r.Id as string)) : (r.Id as string),
      status: schema.statusField ? statusText(r[schema.statusField]) : null,
      createdDate: (r.CreatedDate as string) ?? null,
      lastModifiedDate: (r.LastModifiedDate as string) ?? null,
      createdByName: createdBy?.Name ?? null,
      values,
      references,
    };
  });

  // Product association column: records that point at these rows via the discovered Product2 link
  // (e.g. Product2.BillingPolicyId), read in ONE query for the whole page — Salesforce is the source.
  let linkedColumn: BillingListResponse["linkedColumn"] = null;
  const productLink = schema.inboundLinks.find(l => l.sobject === "Product2" && l.valueSource === "self");
  if (productLink && records.length) {
    try {
      const ids = records.map(r => `'${soqlEscape(r.id)}'`).join(",");
      const linked = await client.query<Record<string, unknown>>(`SELECT Id, Name, ${productLink.field} FROM Product2 WHERE ${productLink.field} IN (${ids}) ORDER BY Name LIMIT 2000`);
      const byParent = new Map<string, { id: string; name: string }[]>();
      for (const p of linked.records) {
        const key = String(p[productLink.field]).slice(0, 15);
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push({ id: p.Id as string, name: String(p.Name) });
      }
      for (const r of records) r.linked = byParent.get(r.id.slice(0, 15)) ?? [];
      linkedColumn = { label: "Product", relation: `Product2.${productLink.field}` };
    } catch {
      // The column is an addition — a user without Product2 read access still gets the list.
    }
  }

  return { success: true, records, totalSize: res.totalSize, soql, columns: schema.columns, nameField: schema.nameField, statusField: schema.statusField, linkedColumn };
}

/** Single record with every readable field grouped for display, reference names resolved, and related child records. */
export async function getBillingRecordDetail(client: SalesforceClient, moduleKey: string, id: string): Promise<BillingDetailResponse> {
  if (!SALESFORCE_ID.test(id)) throw new Error("Invalid record Id.");
  const schema = await getModuleSchema(client, moduleKey);
  const record = await client.getRecord(schema.sobject, id);

  const refs = schema.fields
    .filter(f => f.type === "reference" && typeof record[f.name] === "string")
    .map(f => ({ id: record[f.name] as string, referenceTo: f.referenceTo }));
  const names = await resolveNamesById(client, refs);

  const fields: BillingDetailField[] = schema.fields
    .filter(f => f.type !== "base64" && f.name !== "IsDeleted" && f.name !== "SystemModstamp")
    .map(f => {
      const value = record[f.name] ?? null;
      const reference = f.type === "reference" && typeof value === "string"
        ? (names.get(value) ?? { id: value, name: "Linked record", sobject: f.referenceTo[0] ?? "", moduleKey: f.referenceModules[f.referenceTo[0] ?? ""] ?? null })
        : null;
      return { name: f.name, label: f.label, type: f.type, value, reference, section: billingFieldSection(f, schema) };
    });

  // Related lists: inline child modules, billing objects that point at this record, and products that use it.
  const relatedSpecs = new Map<string, { sobject: string; field: string; moduleKey: string | null; label: string }>();
  for (const c of schema.children) relatedSpecs.set(`${c.sobject}.${c.parentField}`, { sobject: c.sobject, field: c.parentField, moduleKey: c.moduleKey, label: c.label });
  for (const c of schema.childRelationships) {
    const key = `${c.childSObject}.${c.field}`;
    if (relatedSpecs.has(key)) continue;
    const label = c.moduleKey ? getBillingModule(c.moduleKey)?.label ?? c.childSObject : c.childSObject === "Product2" ? "Products" : c.childSObject;
    relatedSpecs.set(key, { sobject: c.childSObject, field: c.field, moduleKey: c.moduleKey, label });
  }

  const children: BillingDetailResponse["children"] = [];
  await Promise.all([...relatedSpecs.values()].map(async spec => {
    try {
      const d = await billingDescribe(client, spec.sobject);
      const nameField = nameFieldOf(d)?.name ?? "Id";
      const statusField = d.fields.find(f => f.name === "Status")?.name ?? d.fields.find(f => f.name === "IsActive")?.name ?? null;
      const select = ["Id", nameField, statusField].filter((v, i, a) => v && a.indexOf(v) === i).join(", ");
      const orderBy = d.fields.some(f => f.name === "LastModifiedDate") ? " ORDER BY LastModifiedDate DESC" : "";
      const res = await client.query<Record<string, unknown>>(`SELECT ${select} FROM ${spec.sobject} WHERE ${spec.field} = '${soqlEscape(id)}'${orderBy} LIMIT 25`);
      if (res.records.length === 0 && !spec.moduleKey) return;
      children.push({
        moduleKey: spec.moduleKey,
        label: spec.label,
        sobject: spec.sobject,
        field: spec.field,
        records: res.records.map(r => ({ id: r.Id as string, name: (r[nameField] as string) ?? (r.Id as string), status: statusField ? statusText(r[statusField]) : null })),
        totalSize: res.totalSize,
      });
    } catch {
      // A related list the user can't read is omitted, not shown as a failure of the whole record.
    }
  }));
  children.sort((a, b) => Number(!!b.moduleKey) - Number(!!a.moduleKey) || a.label.localeCompare(b.label));

  return {
    success: true,
    moduleKey,
    sobject: schema.sobject,
    id,
    name: schema.nameField ? ((record[schema.nameField] as string) ?? id) : id,
    status: schema.statusField ? statusText(record[schema.statusField]) : null,
    fields,
    children,
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, schema.sobject, id),
  };
}
