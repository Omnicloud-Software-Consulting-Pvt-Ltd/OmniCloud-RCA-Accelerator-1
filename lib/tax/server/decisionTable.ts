import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { diag, isPermissionError, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { BadInputError } from "@/lib/billing/server/payments";
import { effectiveRefresh } from "@/lib/tax/server/engine";

/**
 * REVENUE STANDARD TAX DECISION TABLE WITH TAX CODE — a dedicated configuration operation (not the generic CREATE).
 *
 * Salesforce's system table StandardTax ("Revenue Standard Tax Entries") has no TaxCode input. This operation builds a NEW,
 * separate Revenue Standard Tax decision table through the sObject REST API (verified createable in p10: DecisionTable,
 * DecisionTableParameter, DecisionTableDatasetLink; UsageType = RevenueStandardTax), modelled on StandardTax's own records:
 * the same table settings, the same inputs (operators, required flags, sequence, FieldPath, DataType) and outputs (incl. the
 * Priority sort), its OWN TaxRate dataset link (StandardTax_Default belongs to StandardTax and is never touched), its own Lookup
 * Table record (CalculationMatrix, DecisionMatrixType DecisionTable — StandardTax has one: "Revenue Standard Tax Entries"), plus
 *   TaxCode — INPUT, Equals, not required, DataType String, FieldPath TaxCode (TaxRate.TaxCode is a string field).
 * Then: activate → refresh (Salesforce's refreshDecisionTable action; success only when Salesforce reports a completed sync
 * AFTER the request) → set TaxEngine.DecisionTableId on the ONE requested Revenue Standard Tax engine → re-read & verify.
 *
 * Never: modifies or clones StandardTax, touches other engines, creates billing records. Idempotent: an existing table with this
 * API name is reused (missing parameters/link added), an engine already on a valid corrected table is left alone. Each step
 * re-reads Salesforce; the first Salesforce error stops the run and is returned verbatim (HTTP status, code, message, object).
 */

export const SYSTEM_TABLE = "StandardTax";
export const CORRECTED_TABLE = { developerName: "RevenueStandardTaxWithTaxCode", label: "Revenue Standard Tax Entries with Tax Code" };
export const TAXCODE_PARAM = { FieldName: "TaxCode", Usage: "INPUT", Operator: "Equals", IsRequired: false, DataType: "String", FieldPath: "TaxCode" } as const;
/** Table settings copied from StandardTax (system-managed fields such as ExecutionType, LastSyncDate are left to Salesforce). */
const TABLE_SETTINGS = ["Type", "ConditionType", "DataSourceType", "FilterResultBy", "CollectOperator", "DoesConsiderNullValue", "RowLevelOverrideType", "IsBestFitEnabled", "Language"] as const;
const PARAM_FIELDS = ["FieldName", "Usage", "Operator", "Sequence", "IsRequired", "DataType", "FieldPath", "SortType", "IsGroupByField"] as const;

type Row = Record<string, unknown>;
export interface DtApi {
  query(soql: string): Promise<Row[]>;
  write(method: "POST" | "PATCH", object: string, id: string | null, body: Row): Promise<{ status: number; json: unknown }>;
  refresh(apiName: string): Promise<{ ok: boolean; status: number; message: string | null }>;
  fieldsOf(object: string): Promise<{ name: string; type: string; updateable?: boolean }[]>;
  sleep(ms: number): Promise<void>;
}

export async function dtApiFor(client: SalesforceClient): Promise<DtApi> {
  const v = (await discoverTaxMetadata(client)).apiVersion;
  return {
    query: soql => queryAt(client, v, soql),
    write: async (method, object, id, body) => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, id ? `/sobjects/${object}/${id}` : `/sobjects/${object}`), { method, body: JSON.stringify(body) });
      return { status: res.status, json: res.json ?? res.rawText };
    },
    refresh: async apiName => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, "/actions/standard/refreshDecisionTable"), { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableApiName: apiName, isDecisionTableIncremental: false }] }) });
      const out = Array.isArray(res.json) ? (res.json[0] as { isSuccess?: boolean; errors?: { message?: string; statusCode?: string }[] } | undefined) : undefined;
      const ok = res.status < 300 && out?.isSuccess !== false;
      return { ok, status: res.status, message: ok ? null : out?.errors?.map(e => `${e.statusCode ?? ""} ${e.message ?? ""}`.trim()).join("; ") || JSON.stringify(res.json).slice(0, 500) };
    },
    fieldsOf: async object => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, `/sobjects/${object}/describe`), { method: "GET" });
      return ((res.json as { fields?: { name: string; type: string; updateable?: boolean }[] } | null)?.fields ?? []).map(f => ({ name: f.name, type: f.type, updateable: f.updateable }));
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
}

/* ───────────── Model (pure) ───────────── */

export interface TableModel { header: Row; params: Row[]; link: Row | null }

/** The corrected table's specification, derived from StandardTax's actual records + the TaxCode input. */
export function correctedTableSpec(system: { table: Row; params: Row[]; link: Row | null; matrix?: Row | null }): { header: Row; params: Row[]; link: Row; matrix: Row } {
  const inputs = system.params.filter(p => p.Usage === "INPUT").sort((a, b) => Number(a.Sequence ?? 0) - Number(b.Sequence ?? 0));
  const outputs = system.params.filter(p => p.Usage === "OUTPUT");
  const pick = (p: Row) => Object.fromEntries(PARAM_FIELDS.filter(k => p[k] !== null && p[k] !== undefined).map(k => [k, p[k]]));
  const taxCode = { ...TAXCODE_PARAM, Sequence: Math.max(0, ...inputs.map(p => Number(p.Sequence ?? 0))) + 1 };
  const params = [...inputs.filter(p => p.FieldName !== "TaxCode").map(pick), taxCode, ...outputs.map(pick)];
  const n = params.filter(p => p.Usage === "INPUT").length;
  const header: Row = {
    DeveloperName: CORRECTED_TABLE.developerName, MasterLabel: CORRECTED_TABLE.label, SetupName: CORRECTED_TABLE.label,
    Description: "Revenue Standard Tax entries with a Tax Code input (created by the OmniCloud RCA Accelerator from the Revenue Standard Tax Entries structure).",
    UsageType: "RevenueStandardTax", SourceObject: system.table.SourceObject ?? "TaxRate", Status: "Draft",
    ConditionCriteria: Array.from({ length: n }, (_, i) => i + 1).join(" AND "),
    ...Object.fromEntries(TABLE_SETTINGS.filter(k => system.table[k] !== null && system.table[k] !== undefined).map(k => [k, system.table[k]])),
  };
  const link: Row = { DeveloperName: `${CORRECTED_TABLE.developerName}_Default`, MasterLabel: "Decision Table Dataset Links", SetupName: system.link?.SetupName ?? "Default Payload", IsDefault: true, SourceObject: system.link?.SourceObject ?? system.table.SourceObject ?? "TaxRate" };
  // The Lookup Table record, shaped like StandardTax's own matrix ("Revenue Standard Tax Entries").
  const matrix: Row = { Name: CORRECTED_TABLE.label, UniqueName: CORRECTED_TABLE.label, Description: header.Description, DecisionMatrixType: system.matrix?.DecisionMatrixType ?? "DecisionTable", UsageType: system.matrix?.UsageType ?? "RevenueStandardTax" };
  return { header, params, link, matrix };
}

/**
 * A completed sync that is not older than the newest Tax Rate change (else Salesforce would match on outdated rows). The same rule
 * as readiness (engine.effectiveRefresh): the latest successful refresh of EITHER kind — a full refresh (LastSyncDate) or an
 * incremental one (LastIncrementalSyncDate, unless HasIncrementalSyncFailed). Verified in p10: the same refresh action ran full in
 * E1c and incremental in E2, and Salesforce matched the new rate after both.
 */
export function isFresh(table: Row | null, newestRateChange: string | null): boolean {
  if (!table || !/^completed/i.test(String(table.RefreshStatus ?? ""))) return false;
  const last = effectiveRefresh(typeof table.LastSyncDate === "string" ? table.LastSyncDate : null, typeof table.LastIncrementalSyncDate === "string" ? table.LastIncrementalSyncDate : null, table.HasIncrementalSyncFailed === true);
  if (!last) return false;
  return !newestRateChange || Date.parse(last) >= Date.parse(newestRateChange);
}

export interface TableCheck { code: string; label: string; passed: boolean; detail: string }
/** Pure: does a (re-read) table satisfy the corrected spec? */
export function verifyCorrectedTable(t: { table: Row | null; params: Row[]; links: Row[]; matrices?: Row[] }, spec: { params: Row[] }, newestRateChange: string | null = null): TableCheck[] {
  const checks: TableCheck[] = [];
  const add = (code: string, label: string, passed: boolean, detail: string) => checks.push({ code, label, passed, detail });
  if (!t.table) { add("TABLE_EXISTS", "Corrected table exists", false, "Not found."); return checks; }
  add("TABLE_IS_NOT_SYSTEM", "Is a new table (not StandardTax)", t.table.DeveloperName !== SYSTEM_TABLE, String(t.table.DeveloperName));
  add("TABLE_USAGE", "UsageType = RevenueStandardTax", t.table.UsageType === "RevenueStandardTax", String(t.table.UsageType));
  add("TABLE_SOURCE", "SourceObject = TaxRate", t.table.SourceObject === "TaxRate", String(t.table.SourceObject));
  add("TABLE_DATASET", "Own TaxRate dataset link", t.links.some(l => l.SourceObject === "TaxRate" && l.DecisionTableId === t.table!.Id), t.links.map(l => `${l.DeveloperName} → ${l.SourceObject}`).join(", ") || "none");
  if (t.matrices) add("TABLE_LOOKUP_RECORD", "Own Lookup Table record (CalculationMatrix)", t.matrices.some(m => m.DecisionMatrixDefinitionId === t.table!.Id && m.DecisionMatrixType === "DecisionTable"), t.matrices.map(m => `${m.Name} (${m.Id})`).join(", ") || "none");
  const tc = t.params.find(p => p.FieldName === "TaxCode" && p.Usage === "INPUT");
  add("TAXCODE_INPUT", "TaxCode is an INPUT", !!tc, tc ? "present" : "missing");
  add("TAXCODE_EQUALS", "TaxCode operator Equals", tc?.Operator === "Equals", String(tc?.Operator ?? "—"));
  add("TAXCODE_OPTIONAL", "TaxCode not required", tc?.IsRequired === false, String(tc?.IsRequired ?? "—"));
  const has = (p: Row) => t.params.some(x => x.FieldName === p.FieldName && x.Usage === p.Usage && (p.Usage !== "INPUT" || (x.Operator === p.Operator && x.IsRequired === p.IsRequired)));
  const missingIn = spec.params.filter(p => p.Usage === "INPUT" && p.FieldName !== "TaxCode" && !has(p)).map(p => p.FieldName);
  const missingOut = spec.params.filter(p => p.Usage === "OUTPUT" && !has(p)).map(p => p.FieldName);
  add("INPUTS_PRESERVED", "StandardTax inputs preserved (operator + required)", !missingIn.length, missingIn.length ? `missing/different: ${missingIn.join(", ")}` : "all present");
  add("OUTPUTS_PRESERVED", "StandardTax outputs preserved", !missingOut.length, missingOut.length ? `missing: ${missingOut.join(", ")}` : "all present");
  add("TABLE_ACTIVE", "Table is Active", t.table.Status === "Active", String(t.table.Status));
  add("TABLE_REFRESHED", "Refresh completed after the latest Tax Rate change", isFresh(t.table, newestRateChange), `${t.table.RefreshStatus ?? "—"} · last full sync ${t.table.LastSyncDate ?? "never"} · last incremental sync ${t.table.LastIncrementalSyncDate ?? "never"}${t.table.HasIncrementalSyncFailed === true ? " (failed)" : ""}${newestRateChange ? ` · newest Tax Rate change ${newestRateChange}` : ""}`);
  return checks;
}

/* ───────────── Operation ───────────── */

export interface AuditEntry { step: string; object: string; operation: "create" | "update" | "action"; recordId: string | null; before: unknown; after: unknown; result: "success" | "failed" | "skipped"; detail: string; at: string }
export interface DecisionTableResult {
  success: true;
  /** ADMIN_ACTION_REQUIRED = Salesforce doesn't let this user/API version set TaxEngine.DecisionTableId — a Setup change, not done here. */
  status: "READY" | "PREVIEW" | "BLOCKED" | "FAILED" | "PROGRAMMATIC_CREATION_UNSUPPORTED" | "ADMIN_ACTION_REQUIRED";
  message: string;
  engine: { id: string; name: string; status: string | null; type: string | null; decisionTableId: string | null } | null;
  systemTable: { id: string; name: string } | null;
  table: { id: string | null; developerName: string; status: string | null; refreshStatus: string | null; lastSync: string | null; reused: boolean } | null;
  parameters: { fieldName: string; usage: string; operator: string | null; required: boolean; sequence: number | null; dataType: string | null; fieldPath: string | null }[];
  plan: string[];
  checks: TableCheck[];
  audit: AuditEntry[];
  diagnostics: TaxDiagnostic[];
}

const TABLE_COLS = "Id, DeveloperName, MasterLabel, SetupName, Description, Status, UsageType, SourceObject, RefreshStatus, RefreshFailureReason, LastSyncDate, LastIncrementalSyncDate, HasIncrementalSyncFailed, Type, ConditionType, ConditionCriteria, DataSourceType, FilterResultBy, CollectOperator, DoesConsiderNullValue, RowLevelOverrideType, IsBestFitEnabled, Language";
const PARAM_COLS = "Id, DecisionTableId, FieldName, Usage, Operator, Sequence, IsRequired, DataType, FieldPath, SortType, IsGroupByField";
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

async function readTable(api: DtApi, where: string) {
  const [table] = await api.query(`SELECT ${TABLE_COLS} FROM DecisionTable WHERE ${where} LIMIT 1`);
  if (!table) return { table: null, params: [] as Row[], links: [] as Row[], matrices: [] as Row[] };
  const [params, links, matrices] = await Promise.all([
    api.query(`SELECT ${PARAM_COLS} FROM DecisionTableParameter WHERE DecisionTableId = '${soqlEscape(String(table.Id))}'`),
    api.query(`SELECT Id, DeveloperName, SetupName, DecisionTableId, SourceObject, IsDefault FROM DecisionTableDatasetLink WHERE DecisionTableId = '${soqlEscape(String(table.Id))}'`),
    api.query(`SELECT Id, Name, DecisionMatrixDefinitionId, DecisionMatrixType, UsageType FROM CalculationMatrix WHERE DecisionMatrixDefinitionId = '${soqlEscape(String(table.Id))}'`),
  ]);
  return { table, params, links, matrices };
}

function sfError(json: unknown): { code: string | null; message: string } {
  const arr = Array.isArray(json) ? (json as { errorCode?: string; message?: string }[]) : [];
  return { code: arr[0]?.errorCode ?? null, message: arr.map(e => e.message).filter(Boolean).join("; ") || (typeof json === "string" ? json.slice(0, 500) : JSON.stringify(json ?? "").slice(0, 500)) };
}

/**
 * Preview (confirm = false) or configure (confirm = true) the corrected Revenue Standard Tax decision table for ONE engine.
 */
export async function configureTaxCodeDecisionTable(api: DtApi, input: { engineId: string; confirm?: boolean; pollMs?: number; maxWaitMs?: number }): Promise<DecisionTableResult> {
  const { pollMs = 4000, maxWaitMs = 180_000 } = input;
  const audit: AuditEntry[] = [], diagnostics: TaxDiagnostic[] = [], plan: string[] = [];
  const now = () => new Date().toISOString();
  if (!SFID.test(input.engineId)) throw new BadInputError("engineId isn't a valid Salesforce Id.");

  // 1. Engine (only a Revenue Standard Tax engine is ever touched).
  const [eng] = await api.query(`SELECT Id, TaxEngineName, Status, Type, DecisionTableId FROM TaxEngine WHERE Id = '${soqlEscape(input.engineId)}'`);
  const engine = eng ? { id: String(eng.Id), name: String(eng.TaxEngineName), status: (eng.Status as string) ?? null, type: (eng.Type as string) ?? null, decisionTableId: (eng.DecisionTableId as string) ?? null } : null;
  const base = (status: DecisionTableResult["status"], message: string, extra: Partial<DecisionTableResult> = {}): DecisionTableResult => ({ success: true, status, message, engine, systemTable: null, table: null, parameters: [], plan, checks: [], audit, diagnostics, ...extra });
  if (!engine) return base("BLOCKED", `Tax engine ${input.engineId} doesn't exist.`, { diagnostics: [diag("MISSING_TAX_ENGINE", `Tax engine ${input.engineId} doesn't exist.`, { recordId: input.engineId })] });
  if (engine.type !== "RevenueStandardTax") return base("BLOCKED", `"${engine.name}" is ${engine.type}, not a Revenue Standard Tax engine.`, { diagnostics: [diag("UNSUPPORTED_TAX_ENGINE", `"${engine.name}" is ${engine.type}.`, { recordId: engine.id })] });

  // 1b. TaxEngine.DecisionTableId must be writable through the API (API 68+, edit access) — otherwise it's a Setup change.
  const dtField = (await api.fieldsOf("TaxEngine")).find(f => f.name === "DecisionTableId");
  if (!dtField || dtField.updateable === false) {
    const [expected] = await api.query(`SELECT Id, DeveloperName FROM DecisionTable WHERE DeveloperName = '${CORRECTED_TABLE.developerName}'`);
    const target = expected ? `${expected.DeveloperName} (${expected.Id})` : CORRECTED_TABLE.developerName;
    const why = dtField ? "isn't updateable for your user" : "isn't available through the API in this org/version";
    return base("ADMIN_ACTION_REQUIRED", `TaxEngine.DecisionTableId ${why}, so "${engine.name}" can't be assigned a decision table here. Admin action in Salesforce Setup: open Tax Engine "${engine.name}" (${engine.id}) → Decision Table → select ${target} → Save, then refresh the table. The engine is NOT configured until then.`,
      { diagnostics: [diag("MISSING_DECISION_TABLE_RELATIONSHIP", `Tax engine "${engine.name}" has no usable decision table assignment; TaxEngine.DecisionTableId ${why}. Expected table: ${target}.`, { recordId: engine.id })] });
  }

  // 2. The model: StandardTax's actual records (read only). TaxRate must have the TaxCode field.
  const system = await readTable(api, `DeveloperName = '${SYSTEM_TABLE}' AND UsageType = 'RevenueStandardTax'`);
  if (!system.table) return base("BLOCKED", "The system Revenue Standard Tax table (StandardTax) wasn't found to model the new table on.", { diagnostics: [diag("MISSING_DECISION_TABLE_RELATIONSHIP", "StandardTax not found.")] });
  const systemTable = { id: String(system.table.Id), name: SYSTEM_TABLE };
  const taxRateFields = await api.fieldsOf("TaxRate");
  const tcField = taxRateFields.find(f => f.name === "TaxCode");
  if (!tcField) return base("PROGRAMMATIC_CREATION_UNSUPPORTED", "TaxRate has no TaxCode field in this org — a TaxCode input can't be sourced.", { systemTable });
  const spec = correctedTableSpec({ table: system.table, params: system.params, link: system.links.find(l => l.SourceObject === "TaxRate") ?? null, matrix: system.matrices[0] ?? null });
  const unknownPaths = spec.params.filter(p => p.FieldPath && !taxRateFields.some(f => f.name === p.FieldPath)).map(p => String(p.FieldPath));
  if (unknownPaths.length) return base("BLOCKED", `StandardTax parameter field path(s) not on TaxRate: ${unknownPaths.join(", ")}.`, { systemTable });

  const [newestRate] = await api.query("SELECT LastModifiedDate FROM TaxRate ORDER BY LastModifiedDate DESC LIMIT 1");
  const newest = (newestRate?.LastModifiedDate as string) ?? null;
  // 3. Existing corrected table (idempotent): by API name; the engine's current table if it's already a valid corrected one.
  let current = await readTable(api, `DeveloperName = '${CORRECTED_TABLE.developerName}'`);
  if (engine.decisionTableId && engine.decisionTableId !== current.table?.Id) {
    const onEngine = await readTable(api, `Id = '${soqlEscape(engine.decisionTableId)}'`);
    if (onEngine.table && verifyCorrectedTable(onEngine, spec, newest).every(c => c.passed)) current = onEngine;
  }
  const view = (t: typeof current, reused: boolean): Partial<DecisionTableResult> => ({
    systemTable,
    table: { id: (t.table?.Id as string) ?? null, developerName: String(t.table?.DeveloperName ?? spec.header.DeveloperName), status: (t.table?.Status as string) ?? null, refreshStatus: (t.table?.RefreshStatus as string) ?? null, lastSync: (t.table?.LastSyncDate as string) ?? null, reused },
    parameters: (t.table ? t.params : spec.params).map(p => ({ fieldName: String(p.FieldName), usage: String(p.Usage), operator: (p.Operator as string) ?? null, required: p.IsRequired === true, sequence: p.Sequence === null || p.Sequence === undefined ? null : Number(p.Sequence), dataType: (p.DataType as string) ?? null, fieldPath: (p.FieldPath as string) ?? null }))
      .sort((a, b) => (a.usage === b.usage ? (a.sequence ?? 99) - (b.sequence ?? 99) : a.usage === "INPUT" ? -1 : 1)),
  });
  const reused = !!current.table;
  const missingParams = spec.params.filter(p => !current.params.some(x => x.FieldName === p.FieldName && x.Usage === p.Usage));
  const needsLink = !current.links.some(l => l.SourceObject === "TaxRate");
  const fullyOk = !!current.table && verifyCorrectedTable(current, spec, newest).every(c => c.passed);
  // A table other engines already use is shared configuration: it may be assigned (and refreshed, separately approved), but its
  // structure is never changed here — that would change every other engine's tax lookup.
  const sharedWith = current.table ? (await api.query(`SELECT Id, TaxEngineName FROM TaxEngine WHERE DecisionTableId = '${soqlEscape(String(current.table.Id))}'`)).filter(e => String(e.Id).slice(0, 15) !== engine.id.slice(0, 15)) : [];
  const sharedStructural = !!current.table && (missingParams.length > 0 || needsLink || !current.matrices.some(m => m.DecisionMatrixType === "DecisionTable") || current.table.Status !== "Active");
  if (sharedWith.length && sharedStructural) return base("BLOCKED", `Decision table ${current.table!.DeveloperName} (${current.table!.Id}) is shared with ${sharedWith.map(e => `"${e.TaxEngineName}"`).join(", ")} and needs structural changes (${[missingParams.length ? `${missingParams.length} parameter(s)` : null, needsLink ? "TaxRate dataset link" : null, current.table!.Status !== "Active" ? "activation" : null].filter(Boolean).join(", ") || "Lookup Table record"}). Changing a shared table changes those engines' tax lookups too — an admin must fix it in Setup → Lookup Tables. Nothing was changed.`, view(current, true));
  if (fullyOk && engine.decisionTableId === current.table!.Id) {
    return base("READY", `"${engine.name}" already uses the corrected table ${current.table!.DeveloperName} (TaxCode input, active, refreshed). Nothing to do.`, { ...view(current, true), checks: verifyCorrectedTable(current, spec, newest) });
  }
  if (!current.table) plan.push(`Create decision table ${spec.header.DeveloperName} (UsageType RevenueStandardTax, source TaxRate, Draft) modelled on StandardTax.`);
  else plan.push(`Reuse existing table ${current.table.DeveloperName} (${current.table.Id}, ${current.table.Status}).`);
  if (missingParams.length) plan.push(`Create ${missingParams.length} parameter(s): ${missingParams.map(p => `${p.FieldName} (${p.Usage}${p.Operator ? ` ${p.Operator}` : ""}${p.IsRequired ? ", required" : ""})`).join(", ")}.`);
  if (needsLink) plan.push(`Create its own TaxRate dataset link ${spec.link.DeveloperName} (StandardTax_Default is not touched).`);
  if (!current.matrices.some(m => m.DecisionMatrixType === "DecisionTable")) plan.push(`Create its Lookup Table record (CalculationMatrix "${spec.matrix.Name}", DecisionTable type, Revenue Standard Tax) — as StandardTax has.`);
  if (current.table?.Status !== "Active") plan.push("Activate the table.");
  if (!isFresh(current.table, newest)) plan.push("Refresh it with Salesforce's refreshDecisionTable action and wait for Salesforce to confirm the sync.");
  else plan.push(`No refresh needed — Salesforce completed a sync at ${current.table!.LastSyncDate}, after the newest Tax Rate change.`);
  if (engine.decisionTableId !== (current.table?.Id ?? "(new)")) plan.push(`Set DecisionTableId on "${engine.name}" (${engine.id}) only${engine.decisionTableId ? ` (currently ${engine.decisionTableId})` : ""}.`);
  if (!input.confirm) return base("PREVIEW", "Preview only — nothing was changed. Confirm to configure.", view(current, reused));

  // ── Execute (each step: write → re-read → verify; first Salesforce error stops) ──
  const fail = (step: string, object: string, recordId: string | null, res: { status: number; json: unknown }, what: string): DecisionTableResult => {
    const e = sfError(res.json);
    audit.push({ step, object, operation: what.startsWith("Refresh") ? "action" : recordId ? "update" : "create", recordId, before: null, after: null, result: "failed", detail: `HTTP ${res.status} ${e.code ?? ""}: ${e.message}`, at: now() });
    const perm = isPermissionError(res.status, e.code, e.message);
    const unsupported = /NOT_SUPPORTED|INVALID_TYPE|cannot create|can't create|not allowed|INSUFFICIENT_ACCESS_OR_READONLY|FIELD_INTEGRITY_EXCEPTION|INVALID_OPERATION/i.test(`${e.code} ${e.message}`);
    diagnostics.push(diag(perm ? "PERMISSION_OR_LICENSE" : "DECISION_TABLE_NOT_READY", `${what} failed — Salesforce HTTP ${res.status}${e.code ? ` ${e.code}` : ""}: ${e.message}`, { httpStatus: res.status, salesforceCode: e.code, salesforceMessage: e.message, operation: `${what} (${object})`, recordId }));
    return base(perm ? "BLOCKED" : unsupported && step === "create-table" ? "PROGRAMMATIC_CREATION_UNSUPPORTED" : "FAILED", `Stopped at "${what}": Salesforce HTTP ${res.status}${e.code ? ` ${e.code}` : ""} — ${e.message}`, view(current, reused));
  };

  // a. table
  if (!current.table) {
    const res = await api.write("POST", "DecisionTable", null, spec.header);
    if (res.status >= 300) return fail("create-table", "DecisionTable", null, res, "Create decision table");
    const id = (res.json as { id?: string }).id!;
    current = await readTable(api, `Id = '${soqlEscape(id)}'`);
    if (!current.table) return base("FAILED", `Salesforce returned Id ${id} but the table can't be re-read.`, view(current, false));
    audit.push({ step: "create-table", object: "DecisionTable", operation: "create", recordId: id, before: null, after: { DeveloperName: current.table.DeveloperName, UsageType: current.table.UsageType, SourceObject: current.table.SourceObject, Status: current.table.Status }, result: "success", detail: "Created and re-read.", at: now() });
  }
  const tableId = String(current.table!.Id);
  // b. parameters (only the missing ones; the table must not be Active while its structure changes)
  for (const p of spec.params.filter(p => !current.params.some(x => x.FieldName === p.FieldName && x.Usage === p.Usage))) {
    const res = await api.write("POST", "DecisionTableParameter", null, { ...p, DecisionTableId: tableId });
    if (res.status >= 300) return fail(`param-${p.FieldName}`, "DecisionTableParameter", null, res, `Create parameter ${p.FieldName} (${p.Usage})`);
    audit.push({ step: `param-${p.FieldName}`, object: "DecisionTableParameter", operation: "create", recordId: (res.json as { id?: string }).id ?? null, before: null, after: p, result: "success", detail: "Created.", at: now() });
  }
  // c. own TaxRate dataset link
  current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
  if (!current.links.some(l => l.SourceObject === "TaxRate")) {
    const res = await api.write("POST", "DecisionTableDatasetLink", null, { ...spec.link, DecisionTableId: tableId });
    if (res.status >= 300) return fail("dataset-link", "DecisionTableDatasetLink", null, res, "Create TaxRate dataset link");
    audit.push({ step: "dataset-link", object: "DecisionTableDatasetLink", operation: "create", recordId: (res.json as { id?: string }).id ?? null, before: null, after: spec.link, result: "success", detail: "Created.", at: now() });
    current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
  }
  // c2. own Lookup Table record (CalculationMatrix → this decision table)
  if (!current.matrices.some(m => m.DecisionMatrixType === "DecisionTable")) {
    const res = await api.write("POST", "CalculationMatrix", null, { ...spec.matrix, DecisionMatrixDefinitionId: tableId });
    if (res.status >= 300) return fail("lookup-table", "CalculationMatrix", null, res, "Create Lookup Table record");
    audit.push({ step: "lookup-table", object: "CalculationMatrix", operation: "create", recordId: (res.json as { id?: string }).id ?? null, before: null, after: spec.matrix, result: "success", detail: "Created.", at: now() });
    current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
  }
  // Structure verified BEFORE activation (TaxCode INPUT/Equals/optional, inputs + outputs preserved, TaxRate source + link).
  const structural = verifyCorrectedTable(current, spec).filter(c => !["TABLE_ACTIVE", "TABLE_REFRESHED"].includes(c.code));
  if (!structural.every(c => c.passed)) return base("FAILED", `Re-read table doesn't match the specification: ${structural.filter(c => !c.passed).map(c => `${c.label} (${c.detail})`).join("; ")}.`, { ...view(current, reused), checks: structural });
  // d. activate (Salesforce may pass through ActivationInProgress)
  if (current.table!.Status !== "Active") {
    const before = current.table!.Status;
    const res = await api.write("PATCH", "DecisionTable", tableId, { Status: "Active" });
    if (res.status >= 300) return fail("activate", "DecisionTable", tableId, res, "Activate decision table");
    for (let waited = 0; waited <= maxWaitMs; waited += pollMs) {
      current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
      if (current.table?.Status === "Active") break;
      await api.sleep(pollMs);
    }
    if (current.table?.Status !== "Active") { audit.push({ step: "activate", object: "DecisionTable", operation: "update", recordId: tableId, before, after: current.table?.Status, result: "failed", detail: "Salesforce didn't confirm activation.", at: now() }); return base("FAILED", `Salesforce accepted the activation but the table is still ${current.table?.Status}.`, view(current, reused)); }
    audit.push({ step: "activate", object: "DecisionTable", operation: "update", recordId: tableId, before: { Status: before }, after: { Status: "Active" }, result: "success", detail: "Re-read: Active.", at: now() });
  }
  // e. refresh — only when needed; success only when Salesforce reports a completed sync after this request
  if (isFresh(current.table, newest)) audit.push({ step: "refresh", object: "DecisionTable", operation: "action", recordId: tableId, before: null, after: { RefreshStatus: current.table!.RefreshStatus, LastSyncDate: current.table!.LastSyncDate }, result: "skipped", detail: "Already refreshed after the newest Tax Rate change.", at: now() });
  else {
    const before = { status: current.table!.RefreshStatus ?? null, sync: current.table!.LastSyncDate ?? null };
    const r = await api.refresh(String(current.table!.DeveloperName));
    if (!r.ok) return fail("refresh", "DecisionTable", tableId, { status: r.status, json: [{ errorCode: "REFRESH_REFUSED", message: r.message ?? "" }] }, "Refresh decision table");
    let acted = false, done = false;
    for (let waited = 0; waited <= maxWaitMs; waited += pollMs) {
      await api.sleep(pollMs);
      current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
      const t = current.table!;
      if (t.RefreshStatus !== before.status || t.LastSyncDate !== before.sync) acted = true;
      if (!acted) continue;
      if (/fail/i.test(String(t.RefreshStatus))) { audit.push({ step: "refresh", object: "DecisionTable", operation: "action", recordId: tableId, before, after: { RefreshStatus: t.RefreshStatus }, result: "failed", detail: String(t.RefreshFailureReason ?? ""), at: now() }); diagnostics.push(diag("DECISION_TABLE_NOT_READY", `Salesforce's refresh of ${t.DeveloperName} failed: ${t.RefreshFailureReason ?? "no reason given"}`, { salesforceMessage: (t.RefreshFailureReason as string) ?? null, operation: "refreshDecisionTable", recordId: tableId })); return base("FAILED", `Salesforce's refresh failed: ${t.RefreshFailureReason ?? "no reason given"}`, view(current, reused)); }
      if (/^completed/i.test(String(t.RefreshStatus)) && t.LastSyncDate && t.LastSyncDate !== before.sync) { done = true; break; }
    }
    if (!done) { audit.push({ step: "refresh", object: "DecisionTable", operation: "action", recordId: tableId, before, after: { RefreshStatus: current.table?.RefreshStatus, LastSyncDate: current.table?.LastSyncDate }, result: "failed", detail: "Not confirmed within the wait.", at: now() }); return base("BLOCKED", `Refresh requested; Salesforce hasn't confirmed it yet (${current.table?.RefreshStatus ?? "—"}). Re-run to continue — nothing is redone.`, view(current, reused)); }
    audit.push({ step: "refresh", object: "DecisionTable", operation: "action", recordId: tableId, before, after: { RefreshStatus: current.table!.RefreshStatus, LastSyncDate: current.table!.LastSyncDate }, result: "success", detail: "Salesforce confirmed a new completed sync.", at: now() });
  }
  // f. engine — only the requested engine
  if (engine.decisionTableId !== tableId) {
    const res = await api.write("PATCH", "TaxEngine", engine.id, { DecisionTableId: tableId });
    if (res.status >= 300) return fail("engine", "TaxEngine", engine.id, res, `Set DecisionTableId on "${engine.name}"`);
    const [after] = await api.query(`SELECT Id, DecisionTableId, Status FROM TaxEngine WHERE Id = '${soqlEscape(engine.id)}'`);
    if (String(after?.DecisionTableId ?? "").slice(0, 15) !== tableId.slice(0, 15)) return base("FAILED", `Salesforce didn't keep DecisionTableId on "${engine.name}" (re-read ${after?.DecisionTableId ?? "empty"}).`, view(current, reused));
    audit.push({ step: "engine", object: "TaxEngine", operation: "update", recordId: engine.id, before: { DecisionTableId: engine.decisionTableId }, after: { DecisionTableId: after.DecisionTableId }, result: "success", detail: "Re-read.", at: now() });
    engine.decisionTableId = String(after.DecisionTableId);
  }
  // g. final verification from Salesforce
  current = await readTable(api, `Id = '${soqlEscape(tableId)}'`);
  const checks = verifyCorrectedTable(current, spec, newest);
  checks.push({ code: "ENGINE_ASSIGNED", label: `"${engine.name}" uses the corrected table`, passed: engine.decisionTableId?.slice(0, 15) === tableId.slice(0, 15), detail: `DecisionTableId ${engine.decisionTableId}` });
  checks.push({ code: "ENGINE_ACTIVE", label: "Engine is Active", passed: engine.status === "Active", detail: String(engine.status) });
  const ok = checks.every(c => c.passed);
  return base(ok ? "READY" : "FAILED", ok ? `Decision table ${current.table!.DeveloperName} (${tableId}) has the TaxCode input, reads Tax Rates, is active and refreshed, and "${engine.name}" uses it.` : `Configured, but verification failed: ${checks.filter(c => !c.passed).map(c => c.label).join(", ")}.`, { ...view(current, reused), checks });
}
