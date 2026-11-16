/**
 * Tax Configuration Assistant — regression tests for the three reported bugs, run against an in-memory org (metadata + records +
 * a small SOQL evaluator) through the real preview/execute service:
 *   1. TaxTreatmentItem creation from a treatment name + product name (Ids resolved; nothing created when either is missing).
 *   2. TaxRate duplicate detection (distinct geography/product/period allowed; a real conflict detected).
 *   3. ASSIGN default treatment to an existing policy (no CREATE validation; not-found; ambiguity; re-read after the update).
 *
 * Run: `npx tsx --test lib/tax/server/assistantBugs.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWith, findDuplicates, previewWith, DUPLICATE_RULES, type TaxOrgApi } from "./operations";
import { classifyIntent, parseAssignPrompt, reconcileOperations, requestedLifecycle } from "./assistantAi";
import type { AssistantOperation, FieldMeta, ObjectMeta, ProductRow, TaxMetadata } from "@/lib/tax/types";

/* ───────────── in-memory org ───────────── */

const f = (name: string, type = "string", o: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name.replace(/Id$/, " ID").replace(/([a-z])([A-Z])/g, "$1 $2"), type, required: false, createable: true, updateable: true, nillable: true, picklist: [], referenceTo: [], ...o });
const pick = (name: string, values: string[], o: Partial<FieldMeta> = {}) => f(name, "picklist", { picklist: values.map(v => ({ value: v, label: v })), ...o });
const ref = (name: string, to: string, o: Partial<FieldMeta> = {}) => f(name, "reference", { referenceTo: [to], ...o });
const req = { required: true, nillable: false };
const obj = (name: string, label: string, fields: FieldMeta[]): ObjectMeta => ({ name, label, exists: true, createable: true, updateable: true, queryable: true, deletable: true, fields: Object.fromEntries([f("Id", "id", { createable: false, updateable: false }), ...fields].map(x => [x.name, x])) });

const META: TaxMetadata = {
  apiVersion: "v68.0", availableTaxObjects: [], relationships: {}, problems: [],
  objects: {
    TaxPolicy: obj("TaxPolicy", "Tax Policy", [f("Name", "string", { nameField: true, label: "Tax Policy Name", ...req }), pick("Status", ["Draft", "Active", "Inactive"], req), pick("TreatmentSelection", ["Default", "Manual", "LegalEntity"], { label: "Treatment Selection", ...req }), ref("DefaultTaxTreatmentId", "TaxTreatment", { label: "Default Tax Treatment" }), f("Description")]),
    TaxTreatment: obj("TaxTreatment", "Tax Treatment", [f("Name", "string", { nameField: true, ...req }), ref("TaxPolicyId", "TaxPolicy"), ref("TaxEngineId", "TaxEngine"), ref("LegalEntityId", "LegalEntity"), f("TaxCode"), f("ProductCode"), f("IsTaxable", "boolean"), f("ShouldUseTaxTreatmentItems", "boolean"), pick("Status", ["Draft", "Active", "Inactive"], req), f("Description")]),
    TaxTreatmentItem: obj("TaxTreatmentItem", "Tax Treatment Item", [f("Name", "string", { nameField: true, ...req }), ref("TaxTreatmentId", "TaxTreatment", { ...req, updateable: false, label: "Tax Treatment ID" }), ref("ProductId", "Product2", { ...req, label: "Product ID" }), f("TaxCode"), f("ProductCode"), f("Description")]),
    TaxRate: obj("TaxRate", "Tax Rate", [f("Name", "string", { nameField: true, createable: false, updateable: false }), f("TaxCode", "string", { updateable: false }), ref("GeoCountryId", "GeoCountry", { updateable: false }), ref("GeoStateId", "GeoState", { updateable: false }), f("City"), f("ZipCode"), f("ProductCode"), ref("LegalEntityId", "LegalEntity"), f("Rate", "percent"), f("Priority", "int"), pick("RateUsageType", ["Commerce", "RevCloud"]), pick("ApplicationBasis", ["Gross", "Net"]), f("StartDate", "date"), f("EndDate", "date")]),
    TaxEngine: obj("TaxEngine", "Tax Engine", [f("TaxEngineName", "string", { nameField: true, ...req }), pick("Status", ["Active", "Inactive"])]),
    GeoCountry: obj("GeoCountry", "Geo Country", [f("Name", "string", { nameField: true }), f("IsoCode", "string", { updateable: false })]),
    GeoState: obj("GeoState", "Geo State", [f("Name", "string", { nameField: true }), f("IsoCode"), ref("GeoCountryId", "GeoCountry")]),
    LegalEntity: obj("LegalEntity", "Legal Entity", [f("Name", "string", { nameField: true })]),
    Product2: obj("Product2", "Product", [f("Name", "string", { nameField: true }), f("ProductCode"), f("IsActive", "boolean"), ref("TaxPolicyId", "TaxPolicy")]),
  },
};

type Row = Record<string, unknown>;
const PREFIX: Record<string, string> = { TaxPolicy: "1Tp", TaxTreatment: "1tt", TaxTreatmentItem: "1tu", TaxRate: "0xq", GeoCountry: "0vf", GeoState: "0yx", LegalEntity: "0fw", Product2: "01t", TaxEngine: "4wA" };
let seq = 0;
const newId = (o: string) => `${PREFIX[o] ?? "a00"}${String(++seq).padStart(12, "0")}`;

function fakeOrg(seed: Record<string, Row[]>) {
  const store: Record<string, Row[]> = Object.fromEntries(Object.keys(META.objects).map(k => [k, (seed[k] ?? []).map(r => ({ ...r }))]));
  const writes: { method: string; object: string; id: string | null; body: Row | null }[] = [];
  const meta = (o: string) => META.objects[o] as ObjectMeta;
  const value = (o: string, r: Row, path: string): unknown => {
    if (!path.includes(".")) return r[path];
    const [rel, fld] = path.split(".");
    const idField = `${rel}Id`;
    const target = meta(o).fields[idField]?.referenceTo[0];
    const parent = target ? store[target].find(x => x.Id === r[idField]) : undefined;
    return parent?.[fld];
  };
  const lit = (s: string): unknown => (s === "null" ? null : /^'.*'$/.test(s) ? s.slice(1, -1).replace(/\\'/g, "'") : /^(true|false)$/.test(s) ? s === "true" : Number(s));
  const test = (o: string, r: Row, cond: string): boolean => {
    let m = /^(\S+) = (.+)$/.exec(cond);
    if (m) { const v = value(o, r, m[1]), want = lit(m[2]); return want === null ? v === null || v === undefined : v === want; }
    m = /^(\S+) LIKE '%(.*)%'$/.exec(cond);
    if (m) return String(value(o, r, m[1]) ?? "").toLowerCase().includes(m[2].toLowerCase());
    m = /^(\S+) IN \((.*)\)$/.exec(cond);
    if (m) return m[2].split(",").map(x => lit(x.trim())).includes(value(o, r, m[1]));
    throw new Error(`fake SOQL: unsupported condition ${cond}`);
  };
  const query = async (soql: string): Promise<Row[]> => {
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY [\w.]+(?: (?:ASC|DESC))?)?(?: LIMIT (\d+))?$/.exec(soql.trim());
    if (!m) throw new Error(`fake SOQL: unsupported query ${soql}`);
    const [, cols, o, where, limit] = m;
    let rows = (store[o] ?? []).filter(r => !where || where.split(" AND ").every(c => test(o, r, c.trim())));
    if (/^COUNT\(Id\) n$/.test(cols)) return [{ n: rows.length }];
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map(r => {
      const out: Row = { ...r };
      for (const c of cols.split(",").map(x => x.trim()).filter(x => x.includes("."))) { const [rel, fld] = c.split("."); out[rel] = { ...(out[rel] as Row | undefined), [fld]: value(o, r, c) }; }
      return out;
    });
  };
  const products = (): ProductRow[] => store.Product2.map(p => ({ id: p.Id as string, name: String(p.Name), code: (p.ProductCode as string) ?? null, active: p.IsActive !== false, taxPolicyId: (p.TaxPolicyId as string) ?? null, family: null }));
  const api: TaxOrgApi = {
    meta: META, query,
    describe: async () => ({ childRelationships: [] }),
    connection: async () => ({ orgId: "00Dtest", orgName: "Test org", orgType: null, isSandbox: true, instanceUrl: "https://test", userId: "005test", username: "tester", displayName: "Tester" }),
    resolveProduct: async name => {
      const hits = products().filter(p => p.name.toLowerCase() === name.toLowerCase() || (p.code ?? "").toLowerCase() === name.toLowerCase());
      if (hits.length === 1) return { status: "found", product: hits[0] };
      if (hits.length > 1) return { status: "ambiguous", message: `Several products are named "${name}".`, candidates: hits };
      return { status: "not-found", message: `No Salesforce product is named "${name}".`, candidates: [] };
    },
    geoCountries: async () => store.GeoCountry.map(g => ({ id: g.Id as string, name: String(g.Name), iso: String(g.IsoCode) })),
    write: async (method, object, id, body) => {
      writes.push({ method, object, id, body });
      if (method === "POST") { const nid = newId(object); store[object].push({ Id: nid, ...body }); return { status: 201, json: { id: nid, success: true } }; }
      const i = store[object].findIndex(r => r.Id === id);
      if (i < 0) return { status: 404, json: [{ errorCode: "NOT_FOUND", message: "not found" }] };
      if (method === "DELETE") { store[object].splice(i, 1); return { status: 204, json: null }; }
      store[object][i] = { ...store[object][i], ...body };
      return { status: 204, json: null };
    },
    previewRateReplacement: async () => { throw new Error("not used"); },
    executeRateReplacement: async () => { throw new Error("not used"); },
  };
  return { api, store, writes };
}

/** p10-like data: names as the user would type them. */
const IN = "0vf000000000IN1", KA = "0yx000000000KA1", TS = "0yx000000000TS1", LE = "0fw000000000LE1";
const POLICY = "1Tp000000000PO1", TREAT = "1tt000000000TR1", TREAT_OLD = "1tt000000000TR0", TREAT_NOITEMS = "1tt000000000TR2", PRODUCT = "01t000000000PR1";
const seed = (): Record<string, Row[]> => ({
  GeoCountry: [{ Id: IN, Name: "India", IsoCode: "IN" }],
  GeoState: [{ Id: KA, Name: "Andhra Pradesh", IsoCode: "AP", GeoCountryId: IN }, { Id: TS, Name: "Telangana", IsoCode: "TS", GeoCountryId: IN }],
  LegalEntity: [{ Id: LE, Name: "Default Legal Entity - US" }],
  TaxPolicy: [{ Id: POLICY, Name: "Cloud Storage GST Policy", Status: "Draft", TreatmentSelection: "Manual", DefaultTaxTreatmentId: TREAT_OLD, Description: "existing" }],
  TaxTreatment: [
    { Id: TREAT_OLD, Name: "Cloud Storage Old Treatment", Status: "Draft", TaxPolicyId: POLICY, ShouldUseTaxTreatmentItems: false, IsTaxable: true },
    { Id: TREAT, Name: "Cloud Storage GST Treatment", Status: "Draft", TaxPolicyId: POLICY, ShouldUseTaxTreatmentItems: true, IsTaxable: true, TaxCode: "GST18" },
    { Id: TREAT_NOITEMS, Name: "Plain Treatment", Status: "Draft", TaxPolicyId: POLICY, ShouldUseTaxTreatmentItems: false, IsTaxable: true, TaxCode: "GST5" },
  ],
  Product2: [{ Id: PRODUCT, Name: "Cloud Storage Pro", ProductCode: "CSP-001", IsActive: true }],
  TaxRate: [{ Id: "0xq000000000RA1", Name: "TR-1", TaxCode: "GST18", GeoCountryId: IN, GeoStateId: KA, City: null, ZipCode: null, ProductCode: null, LegalEntityId: LE, Rate: 18, RateUsageType: "RevCloud", ApplicationBasis: "Gross", StartDate: "2026-01-01", EndDate: null }],
});

const itemOp = (treatment: string, product: string): AssistantOperation => ({ key: "op1", op: "create", object: "TaxTreatmentItem", fields: { Name: "Cloud Storage GST Item", TaxTreatmentId: treatment, ProductId: product } });
const errors = (p: Awaited<ReturnType<typeof previewWith>>) => p.operations.flatMap(o => o.issues.filter(i => i.severity === "error").map(i => i.code));

/* ───────────── BUG 1 — TaxTreatmentItem ───────────── */

test("Test 1: item from treatment NAME + product NAME — TaxTreatmentId/ProductId resolved to Ids, created after confirmation, re-read", async () => {
  const { api, store, writes } = fakeOrg(seed());
  const op = itemOp("Cloud Storage GST Treatment", "Cloud Storage Pro");
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
  const step = p.operations[0].steps[0];
  assert.equal(step.kind, "create");
  assert.equal(step.fields.TaxTreatmentId, TREAT);
  assert.equal(step.fields.ProductId, PRODUCT);
  assert.equal(step.fields.ProductCode, "CSP-001", "Product Code taken from the product");
  assert.equal(step.fields.TaxCode, undefined, "Tax Code is never invented");
  assert.match(step.changes.find(c => c.field === "TaxTreatmentId")!.nextDisplay!, /Cloud Storage GST Treatment \(1tt000000000TR1\)/);
  assert.equal(writes.length, 0, "nothing written by the preview");
  const r = await executeWith(api, { operations: [op] }, p.token);
  assert.equal(r.success, true, r.message);
  assert.deepEqual(writes.map(w => [w.method, w.object, w.body?.TaxTreatmentId, w.body?.ProductId]), [["POST", "TaxTreatmentItem", TREAT, PRODUCT]]);
  const created = store.TaxTreatmentItem.find(x => x.Id === r.audit[0].recordId);
  assert.ok(created && created.TaxTreatmentId === TREAT && created.ProductId === PRODUCT);
  assert.match(r.audit[0].message, /Verified in Salesforce/);
});

test("Test 1b: the treatment/product given as relation/target or selector aliases resolve the same way", async () => {
  const { api } = fakeOrg(seed());
  for (const op of [
    { key: "a", op: "create", object: "TaxTreatmentItem", fields: { Name: "X", TaxTreatmentId: { treatmentName: "Cloud Storage GST Treatment" }, ProductId: { productName: "Cloud Storage Pro" } } },
    { key: "b", op: "create", object: "TaxTreatmentItem", fields: { Name: "X" }, target: { productName: "Cloud Storage Pro" }, relation: { object: "TaxTreatment", target: { name: "Cloud Storage GST Treatment" } } },
  ] as AssistantOperation[]) {
    const p = await previewWith(api, { operations: [op] });
    assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
    assert.deepEqual([p.operations[0].steps[0].fields.TaxTreatmentId, p.operations[0].steps[0].fields.ProductId], [TREAT, PRODUCT]);
  }
});

test("Test 2: item with a nonexistent treatment — no Salesforce create request", async () => {
  const { api, writes } = fakeOrg(seed());
  const op = itemOp("No Such Treatment", "Cloud Storage Pro");
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.ok, false);
  assert.ok(errors(p).includes("RECORD_NOT_FOUND"));
  assert.equal(p.operations[0].steps.length, 0);
  const r = await executeWith(api, { operations: [op] }, p.token);
  assert.equal(r.success, false);
  assert.equal(writes.length, 0);
});

test("Test 3: item with a nonexistent product — no Salesforce create request", async () => {
  const { api, writes } = fakeOrg(seed());
  const op = itemOp("Cloud Storage GST Treatment", "No Such Product");
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.ok, false);
  assert.ok(errors(p).includes("RECORD_NOT_FOUND"));
  await executeWith(api, { operations: [op] }, p.token);
  assert.equal(writes.length, 0);
});

test("Bug 1: a treatment without 'Use Tax Treatment Items' is refused before Salesforce; one item per product per treatment", async () => {
  const { api, writes } = fakeOrg(seed());
  const p = await previewWith(api, { operations: [itemOp("Plain Treatment", "Cloud Storage Pro")] });
  assert.deepEqual(errors(p), ["ITEMS_NOT_ENABLED"]);
  assert.equal(p.operations[0].offers?.[0].operation.fields?.ShouldUseTaxTreatmentItems, true);
  const org = fakeOrg({ ...seed(), TaxTreatmentItem: [{ Id: "1tu000000000IT1", Name: "Existing", TaxTreatmentId: TREAT, ProductId: PRODUCT }] });
  const dup = await previewWith(org.api, { operations: [{ ...itemOp("Cloud Storage GST Treatment", "Cloud Storage Pro"), fields: { Name: "Other name", TaxTreatmentId: "Cloud Storage GST Treatment", ProductId: "Cloud Storage Pro", TaxCode: "OTHER" } }] });
  assert.equal(dup.operations[0].status, "exists");
  // Same product under ANOTHER treatment, or another product under the same treatment, is not a duplicate.
  const rows = [{ Id: "1tu1", TaxTreatmentId: TREAT, ProductId: "01tOTHER" }, { Id: "1tu2", TaxTreatmentId: "1ttOTHER", ProductId: PRODUCT }];
  assert.equal(findDuplicates(META, "TaxTreatmentItem", { TaxTreatmentId: TREAT, ProductId: PRODUCT }, rows).length, 0);
  assert.equal(writes.length, 0);
});

/* ───────────── BUG 2 — TaxRate duplicates ───────────── */

const rateOp = (fields: Record<string, unknown>): AssistantOperation => ({ key: "op1", op: "create", object: "TaxRate", fields: { TaxCode: "GST18", GeoCountryId: { isoCode: "IN" }, Rate: 18, LegalEntityId: "Default Legal Entity - US", ApplicationBasis: "Gross", StartDate: "2026-10-07", ...fields } });

test("Test 4: a rate with a genuinely different state / product code / city / period is not rejected as a duplicate", async () => {
  const { api } = fakeOrg(seed());
  const ts = await previewWith(api, { operations: [rateOp({ GeoStateId: { isoCode: "TS", country: "IN" } })] });
  assert.equal(ts.operations[0].status, "ready", JSON.stringify(ts.operations[0].issues));
  // Same AP geography as the existing blank-ProductCode rate TR-1: a product- or city-specific rate is NOT a duplicate, but every
  // sale it matches is also matched by TR-1 → Salesforce's lookup returns Multiple Matches (p10 E2) → blocked, never "already exists".
  for (const extra of [{ GeoStateId: { isoCode: "AP", country: "IN" }, ProductCode: "DIFFERENT_PRODUCT" }, { GeoStateId: { isoCode: "AP", country: "IN" }, City: "Vijayawada" }]) {
    const p = await previewWith(api, { operations: [rateOp(extra)] });
    assert.equal(p.operations[0].status, "blocked", `${JSON.stringify(extra)}: ${JSON.stringify(p.operations[0].issues)}`);
    assert.ok(p.operations[0].issues.some(i => i.code === "RATE_ALWAYS_AMBIGUOUS"));
    assert.ok(!p.operations[0].issues.some(i => i.code === "ALREADY_EXISTS"));
  }
  // A different usage type is a distinct rate (not "already exists") — but a Commerce rate is refused: Revenue Cloud invoices
  // look rates up with RevCloud (p10 Smart LED Bulb TR-00000020: decision-table No Match).
  const commerce = await previewWith(api, { operations: [rateOp({ GeoStateId: { isoCode: "AP", country: "IN" }, RateUsageType: "Commerce" })] });
  assert.equal(commerce.operations[0].status, "blocked");
  assert.ok(commerce.operations[0].issues.some(i => i.code === "RATE_USAGE_INCOMPATIBLE"));
  assert.ok(!commerce.operations[0].issues.some(i => i.code === "ALREADY_EXISTS"));
  // Pure: a non-overlapping period of the same configuration is a distinct rate.
  const existing = [{ Id: "r1", TaxCode: "GST18", GeoCountryId: IN, StartDate: "2026-01-01", EndDate: "2026-06-30" }];
  assert.equal(findDuplicates(META, "TaxRate", { TaxCode: "GST18", GeoCountryId: IN, StartDate: "2026-07-01" }, existing).length, 0);
  assert.equal(findDuplicates(META, "TaxRate", { TaxCode: "GST18", GeoCountryId: IN, StartDate: "2026-06-01" }, existing).length, 1);
});

test("Test 5: an actual duplicate rate (every dimension the same, overlapping dates) is detected — nothing created", async () => {
  const { api, writes } = fakeOrg(seed());
  const op = rateOp({ GeoStateId: { isoCode: "AP", country: "IN" } });
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.operations[0].status, "exists");
  assert.equal(p.operations[0].record?.id, "0xq000000000RA1");
  assert.match(p.operations[0].issues[0].message, /overlapping effective dates/);
  await executeWith(api, { operations: [op] }, p.token);
  assert.equal(writes.length, 0);
});

test("Bug 2: TaxRate duplicate dimensions include geography, product, entity, usage, basis and dates — not only code + country", () => {
  assert.deepEqual(DUPLICATE_RULES.TaxRate[0].keys, ["TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis"]);
  assert.equal(DUPLICATE_RULES.TaxRate[0].effectiveDates, true);
});

/* ───────────── BUG 3 — ASSIGN default treatment ───────────── */

const assignOp = (treatment: string, policy: string): AssistantOperation => ({ key: "op1", op: "assign", object: "TaxTreatment", target: { name: treatment }, relation: { object: "TaxPolicy", target: { name: policy }, kind: "default" } });
const PROMPT = "Assign 'Cloud Storage GST Treatment' as the default tax treatment for 'Cloud Storage GST Policy'.";

test("Test 6: assign an existing treatment to an existing policy — no CREATE validation errors; current/new default shown", async () => {
  const { api } = fakeOrg(seed());
  const p = await previewWith(api, { operations: [assignOp("Cloud Storage GST Treatment", "Cloud Storage GST Policy")] });
  assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
  assert.ok(!errors(p).some(c => c === "REQUIRED_FIELD_MISSING"));
  const step = p.operations[0].steps.at(-1)!;
  assert.deepEqual([step.kind, step.object, step.recordId, step.fields], ["update", "TaxPolicy", POLICY, { DefaultTaxTreatmentId: TREAT }]);
  const c = step.changes[0];
  assert.equal(c.current, TREAT_OLD);
  assert.equal(c.currentDisplay, `Cloud Storage Old Treatment (${TREAT_OLD})`);
  assert.equal(c.next, TREAT);
  assert.equal(c.nextDisplay, `Cloud Storage GST Treatment (${TREAT})`);
  assert.equal(p.operations[0].relationship?.field, "DefaultTaxTreatmentId");
});

test("Test 6b: routing — an AI 'create TaxPolicy {Name, DefaultTaxTreatmentId}' or 'configure' for an assignment never becomes a CREATE", async () => {
  assert.equal(classifyIntent(PROMPT), "assign");
  assert.equal(classifyIntent("Make 'GST 18' the default treatment of 'India GST Policy'"), "assign");
  assert.equal(classifyIntent("Create a tax policy named 'Assign Me Policy'"), "create");
  assert.equal(classifyIntent("Change the treatment selection on policy 'Y' to Manual"), "update");
  assert.equal(classifyIntent("Create a tax treatment item named 'X' under 'Y' for product 'Z'"), "create");
  const misrouted: AssistantOperation[] = [{ key: "op1", op: "create", object: "TaxPolicy", fields: { Name: "Cloud Storage GST Policy", TreatmentSelection: "Default", DefaultTaxTreatmentId: "Cloud Storage GST Treatment" } }];
  const routed = reconcileOperations(META, "assign", misrouted, PROMPT);
  assert.deepEqual(routed.operations.map(o => [o.op, o.object, o.target?.name, o.fields]), [["update", "TaxPolicy", "Cloud Storage GST Policy", { DefaultTaxTreatmentId: "Cloud Storage GST Treatment" }]]);
  const { api } = fakeOrg(seed());
  const p = await previewWith(api, { operations: routed.operations });
  assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
  assert.deepEqual(p.operations[0].steps.at(-1)!.fields, { DefaultTaxTreatmentId: TREAT });
  // "configure" for an assignment is dropped; the assignment is read from the request itself.
  const fromConfigure = reconcileOperations(META, "assign", [{ key: "op1", op: "configure", object: "TaxPolicy" }], PROMPT);
  assert.deepEqual(fromConfigure.operations, [{ ...parseAssignPrompt(PROMPT)!, key: "op1" }]);
  assert.deepEqual(parseAssignPrompt(PROMPT), assignOp("Cloud Storage GST Treatment", "Cloud Storage GST Policy"));
});

test("Test 7: assign to a nonexistent policy — clear record-not-found, nothing written", async () => {
  const { api, writes } = fakeOrg(seed());
  const op = assignOp("Cloud Storage GST Treatment", "No Such Policy");
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.operations[0].status, "blocked");
  assert.deepEqual(errors(p), ["RECORD_NOT_FOUND"]);
  assert.match(p.operations[0].issues[0].message, /Record not found: no Tax Policy matches name "No Such Policy"/);
  await executeWith(api, { operations: [op] }, p.token);
  assert.equal(writes.length, 0);
});

test("Test 8: ambiguous policy name — the user must select one; nothing changes until they do", async () => {
  const data = seed();
  data.TaxPolicy.push({ Id: "1Tp000000000PO2", Name: "Cloud Storage GST Policy", Status: "Draft", TreatmentSelection: "Default", DefaultTaxTreatmentId: null });
  const { api, writes } = fakeOrg(data);
  const op = assignOp("Cloud Storage GST Treatment", "Cloud Storage GST Policy");
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.operations[0].status, "needs-selection");
  assert.equal(p.ok, false);
  const choice = p.operations[0].choices![0];
  assert.equal(choice.selectionKey, "op1:relation");
  assert.deepEqual(choice.options.map(o => o.id).sort(), [POLICY, "1Tp000000000PO2"].sort());
  await executeWith(api, { operations: [op] }, p.token);
  assert.equal(writes.length, 0);
  const chosen = await previewWith(api, { operations: [op], selections: { "op1:relation": POLICY } });
  assert.equal(chosen.ok, true);
});

test("Test 9: after the assignment, the re-read TaxPolicy has DefaultTaxTreatmentId = the selected treatment; audit has before/after", async () => {
  const { api, store, writes } = fakeOrg(seed());
  const op = assignOp("Cloud Storage GST Treatment", "Cloud Storage GST Policy");
  const p = await previewWith(api, { operations: [op] });
  const r = await executeWith(api, { operations: [op] }, p.token);
  assert.equal(r.success, true, r.message);
  assert.deepEqual(writes.map(w => [w.method, w.object, w.id, w.body]), [["PATCH", "TaxPolicy", POLICY, { DefaultTaxTreatmentId: TREAT }]]);
  const policy = store.TaxPolicy.find(x => x.Id === POLICY)!;
  assert.equal(policy.DefaultTaxTreatmentId, TREAT);
  assert.equal(policy.Name, "Cloud Storage GST Policy");
  assert.equal(policy.TreatmentSelection, "Manual", "other policy fields are preserved");
  const a = r.audit.at(-1)!;
  assert.deepEqual([a.operation, a.object, a.recordId, a.result], ["ASSIGN", "TaxPolicy", POLICY, "success"]);
  assert.deepEqual(a.fields[0], { field: "DefaultTaxTreatmentId", label: "Default Tax Treatment", before: `Cloud Storage Old Treatment (${TREAT_OLD})`, after: `Cloud Storage GST Treatment (${TREAT})` });
  assert.match(a.message, new RegExp(`Verified in Salesforce: DefaultTaxTreatmentId = ${TREAT}`));
});

test("Bug 3: a stale token (Salesforce changed after the preview) changes nothing", async () => {
  const { api, writes } = fakeOrg(seed());
  const r = await executeWith(api, { operations: [assignOp("Cloud Storage GST Treatment", "Cloud Storage GST Policy")] }, "not-the-token");
  assert.equal(r.success, false);
  assert.equal(r.failure?.code, "STALE");
  assert.equal(writes.length, 0);
});

/* ───────────── Tax Treatment Item create page (Taxes → Tax Treatment Items → Create) ───────────── */

test("item page: the page object scopes the AI request; unknown objects are ignored", async () => {
  const { assistantObject, pageContextPrompt } = await import("./assistantAi");
  assert.equal(assistantObject("TaxTreatmentItem"), "TaxTreatmentItem");
  assert.equal(assistantObject("Tax Treatment Items"), null, "a UI label is never an object API name");
  assert.equal(assistantObject("InvoiceLineTax"), null);
  assert.match(pageContextPrompt(META, "TaxTreatmentItem"), /"Tax Treatment Item" create page[\s\S]*op create on TaxTreatmentItem \(never configure\)/);
});

test("item page: treatment without items enabled — blocked, but the preview shows the resolved Ids; nothing can be created", async () => {
  const data = seed();
  data.TaxTreatment.push({ Id: "1tt000000000MO1", Name: "Mouse Canada Sales Tax Treatment", Status: "Draft", TaxPolicyId: POLICY, ShouldUseTaxTreatmentItems: false });
  data.Product2.push({ Id: "01t000000000MO1", Name: "Mouse", ProductCode: "MO001", IsActive: true }, { Id: "01t000000000MO2", Name: "Wireless Mouse", ProductCode: "WIRELESS_MOUSE", IsActive: true });
  const { api, writes } = fakeOrg(data);
  const op = { key: "op1", op: "create", object: "TaxTreatmentItem", fields: { Name: "Mouse Canada Sales Tax Item", TaxTreatmentId: "Mouse Canada Sales Tax Treatment", ProductId: "Mouse" } } as AssistantOperation;
  const p = await previewWith(api, { operations: [op] });
  assert.equal(p.ok, false);
  assert.deepEqual(errors(p), ["ITEMS_NOT_ENABLED"]);
  const step = p.operations[0].steps[0];
  assert.deepEqual([step.fields.TaxTreatmentId, step.fields.ProductId], ["1tt000000000MO1", "01t000000000MO1"], "exact 'Mouse', not 'Wireless Mouse'");
  assert.match(step.changes.find(c => c.field === "ProductId")!.nextDisplay!, /^Mouse \(01t000000000MO1\)$/);
  const r = await executeWith(api, { operations: [op] }, p.token);
  assert.equal(r.success, false);
  assert.equal(writes.length, 0);
});

/* ───────────── State-aware lifecycle: TaxTreatment.ShouldUseTaxTreatmentItems ───────────── */

const MOUSE_PROMPT = "Enable \"Use Tax Treatment Items\" for the existing Mouse Canada Sales Tax Treatment. First check its current status and current ShouldUseTaxTreatmentItems value. If Salesforce allows the change, show me the current and new values and do not execute until I confirm. If the treatment is Active and Salesforce does not allow this field to be changed while Active, explain the required lifecycle steps instead of forcing the update.";
const withTreatment = (status: string) => { const d = seed(); d.TaxTreatment.push({ Id: "1tt000000000MO1", Name: "Mouse Canada Sales Tax Treatment", Status: status, TaxPolicyId: POLICY, ShouldUseTaxTreatmentItems: false, IsTaxable: true }); return fakeOrg(d); };
const T_MOUSE = { name: "Mouse Canada Sales Tax Treatment" };
const enableItems: AssistantOperation = { key: "u", op: "update", object: "TaxTreatment", target: T_MOUSE, fields: { ShouldUseTaxTreatmentItems: true } };
const stepsOf = (p: Awaited<ReturnType<typeof previewWith>>) => p.operations.flatMap(o => o.steps.map(s => `${s.kind} ${s.object} ${JSON.stringify(s.fields)}`));
const mouseRow = (store: Record<string, Row[]>) => store.TaxTreatment.find(x => x.Id === "1tt000000000MO1")!;

test("Lifecycle 1: Draft treatment, false → true — a single UPDATE (no deactivate/reactivate), executed after confirmation and re-read", async () => {
  const { api, store, writes } = withTreatment("Draft");
  const p = await previewWith(api, { operations: [enableItems] });
  assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
  assert.deepEqual(stepsOf(p), ['update TaxTreatment {"ShouldUseTaxTreatmentItems":true}']);
  assert.deepEqual(p.operations[0].lifecycle, { current: "Draft", changes: [] }, "lifecycle changes: none required");
  const c = p.operations[0].steps[0].changes[0];
  assert.deepEqual([c.field, c.current, c.next], ["ShouldUseTaxTreatmentItems", false, true]);
  assert.equal(writes.length, 0, "nothing changes before confirmation");
  const r = await executeWith(api, { operations: [enableItems] }, p.token);
  assert.equal(r.success, true, r.message);
  assert.deepEqual(writes.map(w => [w.method, w.body]), [["PATCH", { ShouldUseTaxTreatmentItems: true }]]);
  assert.deepEqual([mouseRow(store).ShouldUseTaxTreatmentItems, mouseRow(store).Status], [true, "Draft"]);
  assert.deepEqual([r.audit[0].fields[0].field, r.audit[0].fields[0].before, r.audit[0].fields[0].after], ["ShouldUseTaxTreatmentItems", "false", "true"]);
  assert.match(r.audit[0].message, /Verified in Salesforce: ShouldUseTaxTreatmentItems = true/);
});

test("Lifecycle 1b: even an AI plan 'deactivate → update → activate' on a Draft treatment runs only the field update", async () => {
  const { api, store } = withTreatment("Draft");
  const ops: AssistantOperation[] = [{ key: "a", op: "deactivate", object: "TaxTreatment", target: T_MOUSE }, enableItems, { key: "c", op: "activate", object: "TaxTreatment", target: T_MOUSE }];
  const p = await previewWith(api, { operations: ops });
  assert.deepEqual(stepsOf(p), ['update TaxTreatment {"ShouldUseTaxTreatmentItems":true}']);
  assert.deepEqual(p.operations.map(o => o.status), ["no-change", "ready", "no-change"]);
  assert.equal(p.operations[2].issues[0].code, "NOT_REACTIVATED");
  await executeWith(api, { operations: ops }, p.token);
  assert.equal(mouseRow(store).Status, "Draft");
  // …and the routing layer drops lifecycle operations the prompt only mentions conditionally.
  assert.equal(classifyIntent(MOUSE_PROMPT), "update");
  assert.equal(requestedLifecycle(MOUSE_PROMPT).size, 0);
  assert.deepEqual(reconcileOperations(META, classifyIntent(MOUSE_PROMPT), ops, MOUSE_PROMPT).operations.map(o => o.op), ["update"]);
});

test("Lifecycle 2: Active treatment — the Salesforce restriction is explained with the required sequence; no mutation before confirmation", async () => {
  const { api, store, writes } = withTreatment("Active");
  const p = await previewWith(api, { operations: [enableItems] });
  assert.equal(p.ok, false);
  assert.deepEqual(errors(p), ["LOCKED_WHILE_ACTIVE"]);
  assert.equal(p.operations[0].steps.length, 0);
  assert.match(p.operations[0].issues[0].message, /Deactivate .*Active → Inactive.*doesn't allow Active → Draft.*stays Inactive unless you also ask to activate/);
  const offer = p.operations[0].offers![0].operation;
  assert.deepEqual(offer.fields, { Status: "Inactive", ShouldUseTaxTreatmentItems: true }, "the offered sequence does not re-activate");
  await executeWith(api, { operations: [enableItems] }, p.token);
  assert.equal(writes.length, 0);
  // Accepting the offer (after its own preview + confirmation): deactivate, then the field — and it stays Inactive.
  const accepted = await previewWith(api, { operations: [offer] });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.operations[0].issues));
  assert.deepEqual(stepsOf(accepted), ['update TaxTreatment {"Status":"Inactive"}', 'update TaxTreatment {"ShouldUseTaxTreatmentItems":true}']);
  assert.deepEqual(accepted.operations[0].lifecycle?.changes, ["Mouse Canada Sales Tax Treatment: Active → Inactive"]);
  assert.equal(writes.length, 0, "still nothing until confirmed");
  const r = await executeWith(api, { operations: [offer] }, accepted.token);
  assert.equal(r.success, true, r.message);
  assert.deepEqual([mouseRow(store).Status, mouseRow(store).ShouldUseTaxTreatmentItems], ["Inactive", true]);
  // Moving a treatment back to Draft is refused (Salesforce: "Can't change status from Inactive to Draft").
  const toDraft = await previewWith(api, { operations: [{ key: "d", op: "draft", object: "TaxTreatment", target: T_MOUSE }] });
  assert.deepEqual(errors(toDraft), ["INVALID_STATUS"]);
});

test("Lifecycle 3: Inactive treatment — Salesforce allows the field while Inactive, so only the field changes (no activation)", async () => {
  const { api, store } = withTreatment("Inactive");
  const p = await previewWith(api, { operations: [enableItems] });
  assert.equal(p.ok, true, JSON.stringify(p.operations[0].issues));
  assert.deepEqual(stepsOf(p), ['update TaxTreatment {"ShouldUseTaxTreatmentItems":true}']);
  await executeWith(api, { operations: [enableItems] }, p.token);
  assert.deepEqual([mouseRow(store).Status, mouseRow(store).ShouldUseTaxTreatmentItems], ["Inactive", true]);
});

test("Lifecycle 4: Draft + 'Enable Use Tax Treatment Items and then activate the treatment.' — update, then activate (explicitly requested)", async () => {
  const prompt = "Enable Use Tax Treatment Items and then activate the treatment.";
  assert.deepEqual([...requestedLifecycle(prompt)], ["activate"]);
  const ops: AssistantOperation[] = [enableItems, { key: "a", op: "activate", object: "TaxTreatment", target: T_MOUSE }];
  assert.deepEqual(reconcileOperations(META, classifyIntent(prompt), ops, prompt).operations.map(o => o.op), ["update", "activate"]);
  const { api, store } = withTreatment("Draft");
  const p = await previewWith(api, { operations: ops });
  assert.deepEqual(stepsOf(p), ['update TaxTreatment {"ShouldUseTaxTreatmentItems":true}', 'update TaxTreatment {"Status":"Active"}']);
  const r = await executeWith(api, { operations: ops }, p.token);
  assert.equal(r.success, true, r.message);
  assert.deepEqual([mouseRow(store).ShouldUseTaxTreatmentItems, mouseRow(store).Status], [true, "Active"]);
});

test("Lifecycle 5: Draft + 'Enable Use Tax Treatment Items.' — remains Draft after the update", async () => {
  const prompt = "Enable Use Tax Treatment Items.";
  assert.equal(requestedLifecycle(prompt).size, 0);
  const aiOps: AssistantOperation[] = [enableItems, { key: "a", op: "activate", object: "TaxTreatment", target: T_MOUSE }];
  const routed = reconcileOperations(META, classifyIntent(prompt), aiOps, prompt);
  assert.deepEqual(routed.operations.map(o => o.op), ["update"], "an activation the user didn't ask for is dropped");
  const { api, store } = withTreatment("Draft");
  const p = await previewWith(api, { operations: routed.operations });
  await executeWith(api, { operations: routed.operations }, p.token);
  assert.deepEqual([mouseRow(store).ShouldUseTaxTreatmentItems, mouseRow(store).Status], [true, "Draft"]);
});
