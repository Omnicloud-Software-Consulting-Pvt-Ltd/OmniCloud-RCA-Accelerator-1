/**
 * Revenue Standard Tax decision table WITH TaxCode — configuration operation, against an in-memory Salesforce modelled on p10's
 * actual StandardTax records (settings, 9 inputs, 4 outputs, StandardTax_Default link).
 *
 * Run: `npx tsx --test lib/tax/server/decisionTable.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { configureTaxCodeDecisionTable, correctedTableSpec, CORRECTED_TABLE, type DtApi } from "./decisionTable";

type Row = Record<string, unknown>;
const SYS = "0lD000000000STD", ENGINE = "4wA000000000DGE", OTHER_ENGINE = "4wA000000000RST";
const INPUTS: [string, string, boolean, number][] = [["Country", "Equals", true, 1], ["State", "Equals", false, 2], ["City", "Equals", false, 3], ["ZipCode", "Equals", false, 4], ["ProductCode", "Equals", false, 5], ["StartDate", "GreaterOrEqual", false, 6], ["EndDate", "LessOrEqual", false, 7], ["RateUsageType", "Equals", true, 8], ["LegalEntityId", "Equals", false, 9]];
const OUTPUTS = ["ApplicationBasis", "Rate", "Priority", "FlatTaxAmount"];

interface Opts { createTableFails?: { status: number; json: unknown }; activation?: "instant" | "async" | "never"; refresh?: "completes" | "never" | "fails" | "refused"; seedCorrected?: "complete" | "missing-taxcode"; engineOnCorrected?: boolean; engineType?: string; engineFieldReadonly?: boolean; otherEngineOnCorrected?: boolean }
function fakeOrg(o: Opts = {}) {
  let n = 0;
  const id = (p: string) => `${p}${String(++n).padStart(12, "0")}`;
  const store: Record<string, Row[]> = {
    TaxEngine: [{ Id: ENGINE, TaxEngineName: "Desktop Germany Tax Engine", Status: "Active", Type: o.engineType ?? "RevenueStandardTax", DecisionTableId: null }, { Id: OTHER_ENGINE, TaxEngineName: "Revenue Standard Tax Engine", Status: "Active", Type: "RevenueStandardTax", DecisionTableId: null }],
    DecisionTable: [{ Id: SYS, DeveloperName: "StandardTax", MasterLabel: "Decision Tables", SetupName: "Revenue Standard Tax Entries", Status: "Active", UsageType: "RevenueStandardTax", SourceObject: "TaxRate", RefreshStatus: "Completed", LastSyncDate: "2026-10-06T06:12:10Z", Type: "MediumVolume", ConditionType: "All", ConditionCriteria: "1 AND 2 AND 3 AND 4 AND 5 AND 6 AND 7 AND 8 AND 9", DataSourceType: "SingleSobject", FilterResultBy: "OutputOrder", CollectOperator: "None", DoesConsiderNullValue: false, RowLevelOverrideType: "None", IsBestFitEnabled: false, Language: "en_US" }],
    DecisionTableParameter: [
      ...INPUTS.map(([f, op, req, seq]) => ({ Id: id("0lP"), DecisionTableId: SYS, FieldName: f, Usage: "INPUT", Operator: op, IsRequired: req, Sequence: seq, DataType: "String", FieldPath: f, IsGroupByField: false })),
      ...OUTPUTS.map(f => ({ Id: id("0lP"), DecisionTableId: SYS, FieldName: f, Usage: "OUTPUT", IsRequired: false, DataType: "String", FieldPath: f, IsGroupByField: false, ...(f === "Priority" ? { SortType: "AscNullFirst" } : {}) })),
    ],
    DecisionTableDatasetLink: [{ Id: "0lX000000000STD", DeveloperName: "StandardTax_Default", SetupName: "Default Payload", DecisionTableId: SYS, SourceObject: "TaxRate", IsDefault: true }],
    TaxRate: [{ Id: "0xq000000000DE1", LastModifiedDate: "2026-10-08T05:13:38Z" }],
    CalculationMatrix: [{ Id: "0lI000000000STD", Name: "Revenue Standard Tax Entries", DecisionMatrixDefinitionId: SYS, DecisionMatrixType: "DecisionTable", UsageType: "RevenueStandardTax" }],
  };
  const systemSnapshot = JSON.stringify({ t: store.DecisionTable[0], p: store.DecisionTableParameter.filter(p => p.DecisionTableId === SYS), l: store.DecisionTableDatasetLink });
  if (o.seedCorrected) {
    const tid = "0lD000000000COR";
    const spec = correctedTableSpec({ table: store.DecisionTable[0], params: store.DecisionTableParameter.filter(p => p.DecisionTableId === SYS), link: store.DecisionTableDatasetLink[0] });
    store.DecisionTable.push({ ...spec.header, Id: tid, Status: o.seedCorrected === "complete" ? "Active" : "Draft", RefreshStatus: o.seedCorrected === "complete" ? "Completed" : null, LastSyncDate: o.seedCorrected === "complete" ? "2026-10-08T10:00:00Z" : null });
    for (const p of spec.params.filter(p => o.seedCorrected === "complete" || p.FieldName !== "TaxCode")) store.DecisionTableParameter.push({ ...p, Id: id("0lP"), DecisionTableId: tid });
    if (o.seedCorrected === "complete") { store.DecisionTableDatasetLink.push({ ...spec.link, Id: id("0lX"), DecisionTableId: tid }); store.CalculationMatrix.push({ ...spec.matrix, Id: id("0lI"), DecisionMatrixDefinitionId: tid }); }
    if (o.engineOnCorrected) store.TaxEngine[0].DecisionTableId = tid;
    if (o.otherEngineOnCorrected) store.TaxEngine[1].DecisionTableId = tid;
  }
  const writes: { method: string; object: string; id: string | null; body: Row }[] = [];
  let pendingActivation: string | null = null, refreshTarget: string | null = null, refreshReads = 0;
  const api: DtApi = {
    query: async soql => {
      if (/FROM TaxRate ORDER BY LastModifiedDate DESC/.test(soql)) return [...store.TaxRate].sort((a, b) => String(b.LastModifiedDate).localeCompare(String(a.LastModifiedDate))).slice(0, 1);
      const m = /FROM (\w+) WHERE (.+?)(?: LIMIT \d+)?$/.exec(soql);
      if (!m) throw new Error(`fake: ${soql}`);
      const [, obj, where] = m;
      // async Salesforce behaviour on reads
      if (obj === "DecisionTable" && pendingActivation && o.activation === "async") { const t = store.DecisionTable.find(x => x.Id === pendingActivation)!; if (t.Status === "ActivationInProgress") { t.Status = "Active"; pendingActivation = null; } }
      if (obj === "DecisionTable" && refreshTarget) {
        const t = store.DecisionTable.find(x => x.DeveloperName === refreshTarget)!;
        refreshReads++;
        if (o.refresh === "completes") { t.RefreshStatus = refreshReads === 1 ? "InProgress" : "Completed"; if (refreshReads > 1) t.LastSyncDate = "2026-10-08T12:00:00Z"; }
        if (o.refresh === "fails") { t.RefreshStatus = "Failed"; t.RefreshFailureReason = "Row limit exceeded"; }
        if (o.refresh === "never") t.RefreshStatus = "InProgress";
      }
      const conds = where.split(" AND ").map(c => /(\w+) = '([^']*)'/.exec(c)!).map(x => [x[1], x[2]] as const);
      return store[obj].filter(r => conds.every(([f, v]) => String(r[f]) === v)).map(r => ({ ...r }));
    },
    write: async (method, object, recId, body) => {
      writes.push({ method, object, id: recId, body });
      if (method === "POST" && object === "DecisionTable" && o.createTableFails) return o.createTableFails;
      if (method === "POST") { const nid = id(object === "DecisionTable" ? "0lD" : object === "DecisionTableParameter" ? "0lP" : object === "CalculationMatrix" ? "0lI" : "0lX"); store[object].push({ ...body, Id: nid }); return { status: 201, json: { id: nid, success: true } }; }
      const r = store[object].find(x => x.Id === recId)!;
      if (object === "DecisionTable" && body.Status === "Active") {
        if (o.activation === "never") { r.Status = "ActivationInProgress"; return { status: 204, json: null }; }
        if (o.activation === "async") { pendingActivation = String(recId); r.Status = "ActivationInProgress"; return { status: 204, json: null }; }
      }
      Object.assign(r, body);
      return { status: 204, json: null };
    },
    refresh: async name => { if (o.refresh === "refused") return { ok: false, status: 400, message: "INVALID_INPUT Decision table can't be refreshed" }; refreshTarget = name; refreshReads = 0; return { ok: true, status: 200, message: null }; },
    fieldsOf: async object => object === "TaxEngine" ? [{ name: "DecisionTableId", type: "reference", updateable: o.engineFieldReadonly !== true }] : [...INPUTS.map(([f]) => ({ name: f, type: "string" })), ...OUTPUTS.map(f => ({ name: f, type: "string" })), { name: "TaxCode", type: "string" }],
    sleep: async () => {},
  };
  return { api, store, writes, systemUnchanged: () => JSON.stringify({ t: store.DecisionTable.find(x => x.Id === SYS), p: store.DecisionTableParameter.filter(p => p.DecisionTableId === SYS), l: store.DecisionTableDatasetLink.filter(l => l.DecisionTableId === SYS) }) === systemSnapshot };
}
const run = (org: ReturnType<typeof fakeOrg>, confirm = true) => configureTaxCodeDecisionTable(org.api, { engineId: ENGINE, confirm, pollMs: 1, maxWaitMs: 20 });
const BILLING = /Order|BillingSchedule|Invoice|Account|Contact/;

test("full run: new table with TaxCode INPUT (Equals, optional), StandardTax inputs/outputs preserved, own TaxRate link, active, refreshed, assigned → READY", async () => {
  const org = fakeOrg({ activation: "async", refresh: "completes" });
  const r = await run(org);
  assert.equal(r.status, "READY", r.message);
  const t = org.store.DecisionTable.find(x => x.DeveloperName === CORRECTED_TABLE.developerName)!;
  assert.deepEqual([t.UsageType, t.SourceObject, t.Status, t.RefreshStatus, t.ConditionCriteria], ["RevenueStandardTax", "TaxRate", "Active", "Completed", "1 AND 2 AND 3 AND 4 AND 5 AND 6 AND 7 AND 8 AND 9 AND 10"]);
  const params = org.store.DecisionTableParameter.filter(p => p.DecisionTableId === t.Id);
  const tc = params.find(p => p.FieldName === "TaxCode")!;
  assert.deepEqual([tc.Usage, tc.Operator, tc.IsRequired, tc.DataType, tc.FieldPath, tc.Sequence], ["INPUT", "Equals", false, "String", "TaxCode", 10]);
  for (const [f, op, req] of INPUTS) assert.ok(params.some(p => p.FieldName === f && p.Usage === "INPUT" && p.Operator === op && p.IsRequired === req), `input ${f}`);
  for (const f of OUTPUTS) assert.ok(params.some(p => p.FieldName === f && p.Usage === "OUTPUT"), `output ${f}`);
  assert.equal(params.find(p => p.FieldName === "Priority")!.SortType, "AscNullFirst");
  const link = org.store.DecisionTableDatasetLink.find(l => l.DecisionTableId === t.Id)!;
  assert.deepEqual([link.SourceObject, link.IsDefault, link.DeveloperName], ["TaxRate", true, `${CORRECTED_TABLE.developerName}_Default`]);
  assert.equal(org.store.TaxEngine.find(e => e.Id === ENGINE)!.DecisionTableId, t.Id);
  const m = org.store.CalculationMatrix.find(x => x.DecisionMatrixDefinitionId === t.Id)!;
  assert.deepEqual([m.DecisionMatrixType, m.UsageType], ["DecisionTable", "RevenueStandardTax"], "its own Lookup Table record");
  assert.ok(r.checks.every(c => c.passed));
  assert.ok(r.audit.every(a => a.result === "success"));
});

test("StandardTax (table, parameters, StandardTax_Default link) is never modified; no write targets it", async () => {
  const org = fakeOrg({ activation: "instant", refresh: "completes" });
  await run(org);
  assert.ok(org.systemUnchanged());
  assert.ok(!org.writes.some(w => w.id === SYS || w.id === "0lX000000000STD" || w.id === "0lI000000000STD" || w.body.DecisionTableId === SYS || w.body.DecisionMatrixDefinitionId === SYS));
});

test("only the requested engine is updated; billing objects are never written", async () => {
  const org = fakeOrg({ activation: "instant", refresh: "completes" });
  await run(org);
  assert.equal(org.store.TaxEngine.find(e => e.Id === OTHER_ENGINE)!.DecisionTableId, null);
  assert.deepEqual(org.writes.filter(w => w.object === "TaxEngine").map(w => w.id), [ENGINE]);
  assert.ok(org.writes.every(w => ["DecisionTable", "DecisionTableParameter", "DecisionTableDatasetLink", "CalculationMatrix", "TaxEngine"].includes(w.object) && !BILLING.test(w.object)));
});

test("idempotent: an existing corrected table is reused (no duplicate); an engine already on it → READY with no writes", async () => {
  const reuse = fakeOrg({ seedCorrected: "complete", activation: "instant", refresh: "completes" });
  const r = await run(reuse);
  assert.equal(r.status, "READY", r.message);
  assert.equal(reuse.writes.filter(w => w.method === "POST").length, 0, "nothing created");
  assert.equal(reuse.store.DecisionTable.filter(t => t.DeveloperName === CORRECTED_TABLE.developerName).length, 1);
  assert.ok(r.table?.reused);
  const twice = fakeOrg({ activation: "instant", refresh: "completes" });
  await run(twice); await run(twice);
  assert.equal(twice.store.DecisionTable.filter(t => t.DeveloperName === CORRECTED_TABLE.developerName).length, 1);
  const done = fakeOrg({ seedCorrected: "complete", engineOnCorrected: true });
  const d = await run(done);
  assert.deepEqual([d.status, done.writes.length], ["READY", 0]);
});

test("an existing table missing TaxCode gets the parameter (Draft), then is activated and verified", async () => {
  const org = fakeOrg({ seedCorrected: "missing-taxcode", activation: "instant", refresh: "completes" });
  const r = await run(org);
  assert.equal(r.status, "READY", r.message);
  assert.deepEqual(org.writes.filter(w => w.method === "POST").map(w => `${w.object}:${w.body.FieldName ?? w.body.DeveloperName}`), ["DecisionTableParameter:TaxCode", `DecisionTableDatasetLink:${CORRECTED_TABLE.developerName}_Default`, "CalculationMatrix:undefined"]);
});

test("preview changes nothing and lists the plan", async () => {
  const org = fakeOrg();
  const r = await run(org, false);
  assert.deepEqual([r.status, org.writes.length], ["PREVIEW", 0]);
  assert.ok(r.plan.some(p => /Create decision table/.test(p)) && r.plan.some(p => /TaxCode \(INPUT Equals\)/.test(p)) && r.plan.some(p => /StandardTax_Default is not touched/.test(p)));
  assert.ok(r.parameters.some(p => p.fieldName === "TaxCode" && p.usage === "INPUT" && p.operator === "Equals" && !p.required));
});

test("activation is verified from Salesforce: never Active → FAILED, engine untouched", async () => {
  const org = fakeOrg({ activation: "never", refresh: "completes" });
  const r = await run(org);
  assert.equal(r.status, "FAILED");
  assert.match(r.message, /still ActivationInProgress/);
  assert.equal(org.store.TaxEngine.find(e => e.Id === ENGINE)!.DecisionTableId, null);
});

test("refresh is verified from Salesforce: not confirmed → BLOCKED; failed → FAILED with Salesforce's reason; refused → FAILED; engine untouched", async () => {
  const never = fakeOrg({ activation: "instant", refresh: "never" });
  const a = await run(never);
  assert.equal(a.status, "BLOCKED");
  assert.equal(never.store.TaxEngine.find(e => e.Id === ENGINE)!.DecisionTableId, null);
  const fails = await run(fakeOrg({ activation: "instant", refresh: "fails" }));
  assert.deepEqual([fails.status, fails.diagnostics[0].salesforceMessage], ["FAILED", "Row limit exceeded"]);
  const refused = await run(fakeOrg({ activation: "instant", refresh: "refused" }));
  assert.equal(refused.status, "FAILED");
  assert.match(refused.message, /can't be refreshed/);
});

test("a Salesforce metadata-creation failure is surfaced verbatim (HTTP status, code, message) and stops before anything else", async () => {
  const org = fakeOrg({ createTableFails: { status: 400, json: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "You can't create a Revenue Standard Tax decision table." }] } });
  const r = await run(org);
  assert.equal(r.status, "PROGRAMMATIC_CREATION_UNSUPPORTED");
  assert.match(r.message, /HTTP 400 FIELD_INTEGRITY_EXCEPTION — You can't create/);
  assert.deepEqual([r.diagnostics[0].httpStatus, r.diagnostics[0].salesforceCode], [400, "FIELD_INTEGRITY_EXCEPTION"]);
  assert.equal(org.writes.length, 1, "nothing after the failed create");
  const perm = await run(fakeOrg({ createTableFails: { status: 403, json: [{ errorCode: "INSUFFICIENT_ACCESS", message: "no" }] } }));
  assert.deepEqual([perm.status, perm.diagnostics[0].code], ["BLOCKED", "PERMISSION_OR_LICENSE"]);
});

test("a non-Revenue-Standard-Tax engine is refused before anything is read or written", async () => {
  const org = fakeOrg({ engineType: "Avalara" });
  const r = await run(org);
  assert.deepEqual([r.status, org.writes.length], ["BLOCKED", 0]);
});

test("refresh only when needed: a table synced after the newest Tax Rate change isn't refreshed again (p10: the UI refresh succeeded, the API action fails)", async () => {
  const fresh = fakeOrg({ seedCorrected: "complete", refresh: "refused" });
  const r = await run(fresh);
  assert.equal(r.status, "READY", r.message);
  assert.ok(r.audit.some(a => a.step === "refresh" && a.result === "skipped"));
  assert.deepEqual(fresh.writes.map(w => `${w.method} ${w.object}`), ["PATCH TaxEngine"]);
  // A Tax Rate changed after the last sync → stale → a refresh is required (and here refused → FAILED, engine untouched).
  const stale = fakeOrg({ seedCorrected: "complete", refresh: "refused" });
  stale.store.TaxRate[0].LastModifiedDate = "2026-10-09T00:00:00Z";
  const s2 = await run(stale);
  assert.equal(s2.status, "FAILED");
  assert.equal(stale.store.TaxEngine.find(e => e.Id === ENGINE)!.DecisionTableId, null);
});

test("TaxEngine.DecisionTableId not updateable → ADMIN_ACTION_REQUIRED naming the expected table; nothing is written", async () => {
  const org = fakeOrg({ engineFieldReadonly: true, seedCorrected: "complete" });
  const r = await run(org);
  assert.equal(r.status, "ADMIN_ACTION_REQUIRED");
  assert.match(r.message, /RevenueStandardTaxWithTaxCode \(0lD000000000COR\)/);
  assert.match(r.message, /NOT configured/);
  assert.equal(org.writes.length, 0);
  assert.equal(org.store.TaxEngine[0].DecisionTableId, null);
});

test("an existing table shared with another engine is assigned without touching that engine's association", async () => {
  const org = fakeOrg({ seedCorrected: "complete", otherEngineOnCorrected: true, refresh: "completes" });
  const r = await run(org);
  assert.equal(r.status, "READY", r.message);
  assert.equal(org.store.TaxEngine[0].DecisionTableId, "0lD000000000COR");
  assert.equal(org.store.TaxEngine[1].DecisionTableId, "0lD000000000COR", "the other engine keeps its table");
  assert.ok(!org.writes.some(w => w.object === "TaxEngine" && w.id !== ENGINE), "only the requested engine is written");
  assert.ok(!org.writes.some(w => w.object === "DecisionTableParameter" || w.object === "DecisionTableDatasetLink"), "the shared table's structure is untouched");
});

test("a shared table that needs structural changes is never modified → BLOCKED", async () => {
  const org = fakeOrg({ seedCorrected: "missing-taxcode", otherEngineOnCorrected: true });
  const r = await run(org);
  assert.equal(r.status, "BLOCKED");
  assert.match(r.message, /shared with "Revenue Standard Tax Engine"/);
  assert.equal(org.writes.length, 0);
});
