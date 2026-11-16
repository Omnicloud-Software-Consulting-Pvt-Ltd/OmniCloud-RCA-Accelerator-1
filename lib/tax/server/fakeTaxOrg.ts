/**
 * In-memory tax org for tests: metadata shaped like p10's (v68 describe, incl. TaxTreatmentItem with required TaxTreatmentId and
 * ProductId), records, and a small SOQL evaluator behind the real TaxOrgApi. Never talks to Salesforce.
 */
import type { TaxOrgApi } from "./operations";
import type { FieldMeta, ObjectMeta, ProductRow, TaxMetadata } from "@/lib/tax/types";

export type Row = Record<string, unknown>;

const f = (name: string, type = "string", o: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name.replace(/Id$/, " ID").replace(/([a-z])([A-Z])/g, "$1 $2"), type, required: false, createable: true, updateable: true, nillable: true, picklist: [], referenceTo: [], ...o });
const pick = (name: string, values: string[], o: Partial<FieldMeta> = {}) => f(name, "picklist", { picklist: values.map(v => ({ value: v, label: v })), ...o });
const ref = (name: string, to: string, o: Partial<FieldMeta> = {}) => f(name, "reference", { referenceTo: [to], ...o });
const req = { required: true, nillable: false };
const obj = (name: string, label: string, fields: FieldMeta[]): ObjectMeta => ({ name, label, exists: true, createable: true, updateable: true, queryable: true, deletable: true, fields: Object.fromEntries([f("Id", "id", { createable: false, updateable: false }), ...fields].map(x => [x.name, x])) });

export const FAKE_META: TaxMetadata = {
  apiVersion: "v68.0", availableTaxObjects: [], relationships: {}, problems: [],
  objects: {
    TaxPolicy: obj("TaxPolicy", "Tax Policy", [f("Name", "string", { nameField: true, ...req }), pick("Status", ["Draft", "Active", "Inactive"], req), ref("DefaultTaxTreatmentId", "TaxTreatment")]),
    TaxTreatment: obj("TaxTreatment", "Tax Treatment", [f("Name", "string", { nameField: true, ...req }), ref("TaxPolicyId", "TaxPolicy"), ref("TaxEngineId", "TaxEngine"), ref("LegalEntityId", "LegalEntity"), f("TaxCode"), f("ProductCode"), f("IsTaxable", "boolean"), f("ShouldUseTaxTreatmentItems", "boolean"), pick("Status", ["Draft", "Active", "Inactive"], req), f("Description")]),
    TaxTreatmentItem: obj("TaxTreatmentItem", "Tax Treatment Item", [f("Name", "string", { nameField: true, ...req }), ref("TaxTreatmentId", "TaxTreatment", { ...req, updateable: false, label: "Tax Treatment ID" }), ref("ProductId", "Product2", { ...req, label: "Product ID" }), f("TaxCode"), f("ProductCode"), f("Description", "textarea"), f("CreatedDate", "datetime", { createable: false, updateable: false })]),
    TaxRate: obj("TaxRate", "Tax Rate", [f("TaxCode", "string", { updateable: false }), f("Rate", "percent")]),
    TaxEngine: obj("TaxEngine", "Tax Engine", [f("TaxEngineName", "string", { nameField: true, ...req }), pick("Status", ["Active", "Inactive"])]),
    GeoCountry: obj("GeoCountry", "Geo Country", [f("Name", "string", { nameField: true }), f("IsoCode", "string", { updateable: false })]),
    LegalEntity: obj("LegalEntity", "Legal Entity", [f("Name", "string", { nameField: true })]),
    Product2: obj("Product2", "Product", [f("Name", "string", { nameField: true }), f("ProductCode"), f("IsActive", "boolean"), ref("TaxPolicyId", "TaxPolicy")]),
  },
};

/** An org over `seed`; `writes` records any write attempt (tests assert it stays empty). */
export function fakeTaxOrg(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = Object.fromEntries(Object.keys(FAKE_META.objects).map(k => [k, (seed[k] ?? []).map(r => ({ ...r }))]));
  const writes: { method: string; object: string }[] = [];
  const meta = (o: string) => FAKE_META.objects[o] as ObjectMeta;
  const value = (o: string, r: Row, path: string): unknown => {
    if (!path.includes(".")) return r[path];
    const [rel, fld] = path.split(".");
    const target = meta(o).fields[`${rel}Id`]?.referenceTo[0];
    return target ? store[target].find(x => x.Id === r[`${rel}Id`])?.[fld] : undefined;
  };
  const lit = (s: string): unknown => (s === "null" ? null : /^'.*'$/.test(s) ? s.slice(1, -1).replace(/\\'/g, "'") : /^(true|false)$/.test(s) ? s === "true" : Number(s));
  const test = (o: string, r: Row, cond: string): boolean => {
    let m = /^(\S+) = (.+)$/.exec(cond);
    if (m) { const v = value(o, r, m[1]), want = lit(m[2]); return want === null ? v === null || v === undefined : v === want; }
    m = /^(\S+) LIKE '%(.*)%'$/.exec(cond);
    if (m) return String(value(o, r, m[1]) ?? "").toLowerCase().includes(m[2].toLowerCase());
    throw new Error(`fake SOQL: unsupported condition ${cond}`);
  };
  const query = async (soql: string): Promise<Row[]> => {
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY [\w.]+(?: (?:ASC|DESC))?)?(?: LIMIT (\d+))?$/.exec(soql.trim());
    if (!m) throw new Error(`fake SOQL: unsupported query ${soql}`);
    const [, , o, where, limit] = m;
    let rows = (store[o] ?? []).filter(r => !where || where.split(" AND ").every(c => test(o, r, c.trim())));
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map(r => ({ ...r }));
  };
  const products = (): ProductRow[] => store.Product2.map(p => ({ id: p.Id as string, name: String(p.Name), code: (p.ProductCode as string) ?? null, active: p.IsActive !== false, taxPolicyId: (p.TaxPolicyId as string) ?? null, family: null }));
  const api: TaxOrgApi = {
    meta: FAKE_META, query,
    describe: async () => ({ childRelationships: [] }),
    connection: async () => ({ orgId: "00Dtest", orgName: "Test org", orgType: null, isSandbox: true, instanceUrl: "https://test", userId: "005test", username: "tester", displayName: "Tester" }),
    resolveProduct: async name => {
      const hits = products().filter(p => p.name.toLowerCase() === name.toLowerCase() || (p.code ?? "").toLowerCase() === name.toLowerCase());
      if (hits.length === 1) return { status: "found", product: hits[0] };
      if (hits.length > 1) return { status: "ambiguous", message: `Several products are named "${name}".`, candidates: hits };
      return { status: "not-found", message: `No Salesforce product is named "${name}".`, candidates: [] };
    },
    geoCountries: async () => [],
    write: async (method, object) => { writes.push({ method, object }); throw new Error("fake org: writes are not allowed in these tests"); },
    previewRateReplacement: async () => { throw new Error("not used"); },
    executeRateReplacement: async () => { throw new Error("not used"); },
  };
  return { api, store, writes, query };
}
