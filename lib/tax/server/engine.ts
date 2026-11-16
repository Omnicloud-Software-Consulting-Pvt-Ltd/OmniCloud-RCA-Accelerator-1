import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { getTaxConnection, loadSnapshot, str, type TaxSnapshot } from "@/lib/tax/server/records";
import { getTaxAdminStatus, type IssueCategory } from "@/lib/tax/server/admin";
import type { TaxConnection } from "@/lib/tax/types";

/**
 * TAX ENGINE READINESS — strictly read-only diagnostics of whether Salesforce can CALCULATE tax in the connected org.
 *
 * Revenue Standard Tax reads rates through a decision table: the tax engine's own table (TaxEngine.DecisionTableId, API 68+ —
 * Salesforce's documented "Extend Your Revenue Standard Tax Engine" route: clone the Revenue Standard Tax Entries table in Lookup
 * Tables, add Tax Rate columns, activate, refresh, select it on the engine), else Salesforce's system table "Revenue Standard Tax
 * Entries" (API name StandardTax). Setup offers only Activate, Deactivate, Refresh and Clone for the system table (no Delete) and
 * API deletion is refused with DEPENDENCY_EXISTS (verified 2026-10-06). The application never deactivates, deletes, clones,
 * regenerates or refreshes any decision table and never toggles Billing — it reports what is wrong and what an admin must do.
 */

export const DECISION_TABLE = "StandardTax";
export const STANDARD_TAX_OUTDATED = "StandardTax decision table requires Salesforce regeneration/upgrade. The current table is missing the TaxCode input required by the current Revenue Standard Tax matching model.";
/** Salesforce's documented alternative to regenerating the system table (Help: Extend Your Revenue Standard Tax Engine). */
export const CLONE_TABLE_STEPS = "In Salesforce: App Launcher → Lookup Tables → Revenue Standard Tax Entries → Show menu → Clone (new name + API name). On the clone, add the Tax Code column from Tax Rate as an input (operator Equals, not required), then Activate and Refresh it. Then open the Revenue Standard Tax Engine record and select the cloned table in Decision Table. Refresh the clone whenever tax rates change.";
export const TABLE_ADMIN_FIX = `Setup does not provide Delete for this system decision table, and API deletion is blocked by a Salesforce internal dependency (DEPENDENCY_EXISTS from the Revenue Standard Tax Entries matrix); Refresh does not add the TaxCode column. Admin action required — either ask Salesforce Support to regenerate/upgrade the Revenue Standard Tax Entries decision table, or use Salesforce's documented engine-specific table: ${CLONE_TABLE_STEPS}`;
export const STANDARD_TAX_ADMIN_ACTION = `Regenerate/upgrade the Revenue Standard Tax Entries decision table (Salesforce Support), or assign the tax engine its own decision table: ${CLONE_TABLE_STEPS}`;

export interface DecisionTableState {
  id: string; name: string; setupName: string | null; status: string | null; refreshStatus: string | null; refreshFailure: string | null; lastSync: string | null; createdDate: string | null;
  inputs: { field: string; required: boolean }[]; hasTaxCode: boolean; outdated: boolean; stale: boolean;
  /** Output columns (Rate, Priority, ApplicationBasis, FlatTaxAmount…), the source object and its dataset links (p10: TaxRate). */
  outputs: string[]; sourceObject: string | null; /** DecisionTable.UsageType (RevenueStandardTax for tax tables). */ usageType?: string | null;
  /** DecisionTable.LastIncrementalSyncDate — set by an incremental refresh (Refresh button / refreshDecisionTable action); LastSyncDate is the full refresh. */
  lastIncrementalSync?: string | null; incrementalFailed?: boolean;
  datasetLinks: { id: string; name: string; sourceObject: string | null }[];
  /** "engine" = the table assigned on the tax engine (TaxEngine.DecisionTableId); "system" = Salesforce's StandardTax table. */
  source: "engine" | "system";
  engineName: string | null;
}

const DT_COLS = "Id, DeveloperName, SetupName, Status, RefreshStatus, RefreshFailureReason, LastSyncDate, LastIncrementalSyncDate, HasIncrementalSyncFailed, CreatedDate, SourceObject, UsageType";

/**
 * The latest SUCCESSFUL refresh of a decision table. Salesforce records a full refresh in LastSyncDate ("Last Refreshed Date")
 * and an incremental refresh — what the Refresh button and the refreshDecisionTable action run (verified in p10: both left
 * LastSyncDate unchanged and set LastIncrementalSyncDate, and Salesforce's evaluation then returned the new rate) — in
 * LastIncrementalSyncDate. An incremental refresh counts unless Salesforce flags it failed (HasIncrementalSyncFailed).
 */
export function effectiveRefresh(lastSync: string | null, lastIncrementalSync: string | null | undefined, incrementalFailed: boolean | undefined): string | null {
  const ok = [lastSync, incrementalFailed ? null : lastIncrementalSync ?? null].filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)));
  return ok.sort((a, b) => Date.parse(a) - Date.parse(b)).pop() ?? null;
}
/** Inputs Salesforce's Revenue Standard Tax table requires (IsRequired in p10's StandardTax) and the output carrying the rate. */
export const REQUIRED_TABLE_INPUTS = ["Country", "RateUsageType"];
export const REQUIRED_TABLE_OUTPUTS = ["Rate"];

/**
 * The decision table Salesforce will actually use for Revenue Standard Tax: the engine's DecisionTableId when one is set, else the
 * system table — by its standard API name, else by its setup name (a regenerated table may get another API name).
 *
 * `engineId` = the treatment's own engine (what Salesforce uses for that transaction). Without it — org-level dashboards only — the
 * first active native engine with a table is shown; transaction paths must always pass the engine.
 */
export async function readStandardTax(client: SalesforceClient, v: string, snapshot?: TaxSnapshot | null, engineId?: string | null): Promise<DecisionTableState | null> {
  const engine = engineId
    ? (snapshot?.engines ?? []).find(e => e.id.slice(0, 15) === engineId.slice(0, 15) && e.decisionTableId) ?? null
    : (snapshot?.engines ?? []).find(e => e.native && e.status === "Active" && e.decisionTableId) ?? null;
  let dt: Record<string, unknown> | undefined;
  // Query errors propagate (a permission problem must not look like "no decision table").
  if (engine) [dt] = await queryAt(client, v, `SELECT ${DT_COLS} FROM DecisionTable WHERE Id = '${soqlEscape(engine.decisionTableId!)}' LIMIT 1`);
  else {
    const [byName] = await queryAt(client, v, `SELECT ${DT_COLS} FROM DecisionTable WHERE DeveloperName = '${DECISION_TABLE}' LIMIT 1`);
    dt = byName ?? (await queryAt(client, v, `SELECT ${DT_COLS} FROM DecisionTable WHERE SetupName = 'Revenue Standard Tax Entries' ORDER BY CreatedDate DESC LIMIT 1`))[0];
  }
  if (!dt) return null;
  const [params, links] = await Promise.all([
    queryAt(client, v, `SELECT FieldName, Usage, IsRequired, Sequence FROM DecisionTableParameter WHERE DecisionTableId = '${soqlEscape(dt.Id as string)}' ORDER BY Usage, Sequence`),
    queryAt(client, v, `SELECT Id, DeveloperName, SourceObject FROM DecisionTableDatasetLink WHERE DecisionTableId = '${soqlEscape(dt.Id as string)}'`),
  ]);
  const inputs = params.filter(p => p.Usage === "INPUT").map(p => ({ field: String(p.FieldName), required: p.IsRequired === true }));
  // DecisionTableParameter.DataType reports every column as "String" (Setup shows StartDate/EndDate as Date), so only the presence
  // of the TaxCode input — required by the current matching model — decides whether the table is current.
  const hasTaxCode = inputs.some(i => i.field === "TaxCode");
  const lastSync = str(dt.LastSyncDate);
  const lastIncrementalSync = str(dt.LastIncrementalSyncDate);
  const incrementalFailed = dt.HasIncrementalSyncFailed === true;
  const refreshedAt = effectiveRefresh(lastSync, lastIncrementalSync, incrementalFailed);
  const newestRate = (snapshot?.rates ?? []).map(r => r.lastModified).filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    id: dt.Id as string, name: String(dt.DeveloperName), setupName: str(dt.SetupName), status: str(dt.Status), refreshStatus: str(dt.RefreshStatus), refreshFailure: str(dt.RefreshFailureReason),
    lastSync, createdDate: str(dt.CreatedDate), inputs, hasTaxCode, outdated: inputs.length > 0 && !hasTaxCode,
    stale: !!newestRate && (!refreshedAt || Date.parse(newestRate) > Date.parse(refreshedAt)),
    lastIncrementalSync, incrementalFailed,
    source: engine ? "engine" : "system", engineName: engine?.name ?? null,
    outputs: params.filter(p => p.Usage === "OUTPUT").map(p => String(p.FieldName)), sourceObject: str(dt.SourceObject), usageType: str(dt.UsageType),
    datasetLinks: links.map(l => ({ id: l.Id as string, name: String(l.DeveloperName), sourceObject: str(l.SourceObject) })),
  };
}

/** Revenue Standard Tax decision tables other than the system one (e.g. a clone) — to spot a clone that isn't assigned to the engine yet. */
export async function findEngineTableCandidates(client: SalesforceClient, v: string): Promise<{ id: string; name: string; status: string | null; hasTaxCode: boolean; refreshStatus: string | null; lastSync: string | null }[]> {
  const rows = await queryAt(client, v, `SELECT Id, DeveloperName, Status, RefreshStatus, LastSyncDate FROM DecisionTable WHERE UsageType = 'RevenueStandardTax' AND DeveloperName != '${DECISION_TABLE}' ORDER BY CreatedDate DESC LIMIT 10`);
  if (!rows.length) return [];
  const params = await queryAt(client, v, `SELECT DecisionTableId, FieldName FROM DecisionTableParameter WHERE Usage = 'INPUT' AND FieldName = 'TaxCode' AND DecisionTableId IN (${rows.map(r => `'${soqlEscape(r.Id as string)}'`).join(",")})`);
  return rows.map(r => ({ id: r.Id as string, name: String(r.DeveloperName), status: str(r.Status), hasTaxCode: params.some(p => p.DecisionTableId === r.Id), refreshStatus: str(r.RefreshStatus), lastSync: str(r.LastSyncDate) }));
}

/** Can Salesforce calculate tax right now? (Checked before any verification order is created.) */
export function calculationReadiness(dt: DecisionTableState | null, activeNativeEngines: number): { ready: boolean; code: string | null; reason: string | null } {
  if (!activeNativeEngines) return { ready: false, code: "NO_TAX_ENGINE", reason: "No active Revenue Standard Tax engine." };
  if (!dt) return { ready: false, code: "STANDARD_TAX_MISSING", reason: `Salesforce's Revenue Standard Tax decision table "${DECISION_TABLE}" doesn't exist in this org.` };
  if (dt.status !== "Active") return { ready: false, code: "STANDARD_TAX_INACTIVE", reason: `Decision table ${dt.name} is ${dt.status ?? "not active"}.` };
  if (dt.outdated) return dt.source === "engine"
    ? { ready: false, code: "ENGINE_TABLE_NO_TAXCODE", reason: `Decision table ${dt.name}, assigned to tax engine "${dt.engineName}", has no TaxCode input — add the Tax Code column from Tax Rate (input, operator Equals), then activate and refresh it.` }
    : { ready: false, code: "STANDARD_TAX_TABLE_OUTDATED", reason: STANDARD_TAX_OUTDATED };
  // Structure of the table (as the admin's clone must preserve it): required inputs, the Rate output, and the TaxRate dataset.
  const missingIn = REQUIRED_TABLE_INPUTS.filter(f => !dt.inputs.some(i => i.field === f));
  if (dt.inputs.length && missingIn.length) return { ready: false, code: "ENGINE_TABLE_INPUTS", reason: `Decision table ${dt.name} is missing the required input(s) ${missingIn.join(", ")}.` };
  const missingOut = REQUIRED_TABLE_OUTPUTS.filter(f => !(dt.outputs ?? []).includes(f));
  if ((dt.outputs ?? []).length && missingOut.length) return { ready: false, code: "ENGINE_TABLE_OUTPUTS", reason: `Decision table ${dt.name} has no ${missingOut.join(", ")} output.` };
  if (dt.sourceObject !== undefined && dt.datasetLinks !== undefined && (dt.sourceObject !== "TaxRate" || !dt.datasetLinks.some(l => l.sourceObject === "TaxRate"))) return { ready: false, code: "ENGINE_TABLE_DATASET", reason: `Decision table ${dt.name} doesn't read Tax Rates (source ${dt.sourceObject ?? "none"}, ${dt.datasetLinks.length} dataset link(s)).` };
  if (!/completed/i.test(dt.refreshStatus ?? "")) return { ready: false, code: "STANDARD_TAX_REFRESH", reason: `Decision table ${dt.name} refresh is ${dt.refreshStatus ?? "unknown"} — it must be refreshed in Salesforce before invoicing.` };
  if (dt.stale) return { ready: false, code: "STANDARD_TAX_STALE", reason: `Tax rates changed after decision table ${dt.name} was last refreshed — a Salesforce admin must refresh it (Setup → Lookup Tables) before invoicing.` };
  return { ready: true, code: null, reason: null };
}

export type ReadinessStatus = "PASS" | "WARNING" | "FAILED" | "ACTION REQUIRED";
export interface ReadinessItem { id: string; label: string; status: ReadinessStatus; detail: string; category: IssueCategory | null; action: string | null }
export interface AdminActionRequired {
  required: boolean; status: "FAILED"; category: "Salesforce tax engine";
  error: { number: string | null; code: string | null; message: string | null; at: string | null } | null;
  issue: string; adminAction: string;
  decisionTable: { id: string; apiName: string; name: string | null; status: string | null; refreshStatus: string | null; lastRefresh: string | null } | null;
  internalMatrix: { id: string; name: string } | null;
  currentInputs: string[]; missingInputs: string[];
  supportCase: { subject: string; details: string[] };
}
export interface TaxReadiness {
  success: true; connection: TaxConnection; ready: boolean; headline: string; items: ReadinessItem[];
  /** The latest TAX_* error log; `unavailable` = the log couldn't be read (never shown as "no error"). */
  latestError: { number: string | null; code: string | null; message: string | null; category: string | null; at: string | null; recordId: string | null; unavailable?: string | null } | null;
  adminAction: AdminActionRequired | null;
}

async function latestTaxError(client: SalesforceClient, v: string): Promise<TaxReadiness["latestError"]> {
  let log: Record<string, unknown> | undefined;
  try { [log] = await queryAt(client, v, "SELECT ErrorLogNumber, ErrorCode, ErrorMessage, Category, CreatedDate, PrimaryRecordId FROM RevenueTransactionErrorLog WHERE ErrorCode LIKE 'TAX%' ORDER BY CreatedDate DESC LIMIT 1"); }
  catch (e) { return { number: null, code: null, message: null, category: null, at: null, recordId: null, unavailable: `RevenueTransactionErrorLog couldn't be read: ${e instanceof Error ? e.message : String(e)}` }; }
  return log ? { number: str(log.ErrorLogNumber), code: str(log.ErrorCode), message: str(log.ErrorMessage), category: str(log.Category), at: str(log.CreatedDate), recordId: str(log.PrimaryRecordId) } : null;
}

/** Read-only readiness of the whole chain (permission, configuration, Salesforce tax engine), each item categorised. */
export async function getTaxReadiness(client: SalesforceClient): Promise<TaxReadiness> {
  const meta = await discoverTaxMetadata(client);
  const v = meta.apiVersion;
  const [snap, connection, taxAdmin, latestError] = await Promise.all([loadSnapshot(client, meta), getTaxConnection(client), getTaxAdminStatus(client), latestTaxError(client, v)]);
  const [dt, candidates] = await Promise.all([readStandardTax(client, v, snap), findEngineTableCandidates(client, v)]);
  const matrices = dt ? await queryAt(client, v, `SELECT Id, Name FROM CalculationMatrix WHERE DecisionMatrixDefinitionId = '${soqlEscape(dt.id)}'`).catch(() => []) : [];
  const items: ReadinessItem[] = [];
  const add = (id: string, label: string, status: ReadinessStatus, detail: string, category: IssueCategory | null = null, action: string | null = null) => items.push({ id, label, status, detail, category, action });
  const c = connection;
  add("org", "Salesforce Org", c.orgId ? "PASS" : "FAILED", `${c.orgName ?? "—"} (${c.orgId ?? "unknown"}) · ${c.instanceUrl}`);
  add("user", "Current User", c.userId ? "PASS" : "FAILED", `${c.displayName ?? "—"} (${c.username ?? "?"}) · ${c.userId ?? "unknown"}`);
  add("tax-admin", "Tax Admin", taxAdmin.status === "enabled" ? "PASS" : "ACTION REQUIRED", taxAdmin.message, taxAdmin.status === "enabled" ? null : "permission", taxAdmin.adminInstruction);
  const engines = snap.engines.filter(e => e.native && e.status === "Active");
  add("engine", "Tax Engine", engines.length ? "PASS" : "ACTION REQUIRED", engines.length ? engines.map(e => `${e.name} (${e.type}, ${e.status})`).join(", ") : "No active Revenue Standard Tax engine.", engines.length ? null : "configuration");
  const taxable = snap.treatments.filter(t => t.status === "Active" && t.taxable && engines.some(e => e.id === t.engineId));
  const policies = snap.policies.filter(p => p.status === "Active" && taxable.some(t => t.id === p.defaultTreatmentId || t.policyId === p.id));
  add("policy", "Tax Policy", policies.length ? "PASS" : "WARNING", policies.length ? policies.map(p => `${p.name} (${p.selection}, ${p.products} product(s))`).join(", ") : "No active tax policy uses a taxable Revenue Standard Tax treatment.", policies.length ? null : "configuration");
  add("treatment", "Tax Treatment", taxable.length ? "PASS" : "WARNING", taxable.length ? taxable.map(t => `${t.name} (${t.useItems ? "tax codes per Tax Treatment Item" : `tax code ${t.taxCode ?? "none"}`})`).join(", ") : "No active taxable treatment on the Revenue Standard Tax engine.", taxable.length ? null : "configuration");
  const rates = snap.rates.filter(r => r.effective && r.usage === "RevCloud");
  add("rate", "Tax Rate", rates.length ? "PASS" : "WARNING", rates.length ? rates.map(r => `${r.taxCode ?? r.name} ${r.rate ?? "?"}% · ${r.country ?? "no country"}`).join(", ") : "No effective Revenue Cloud tax rates.", rates.length ? null : "configuration");
  add("table", "Tax Decision Table", dt ? "PASS" : "FAILED", dt ? `${dt.name} (${dt.id}) · ${dt.source === "engine" ? `assigned to tax engine "${dt.engineName}"` : `Salesforce system table${dt.setupName ? ` "${dt.setupName}"` : ""}`} · created ${(dt.createdDate ?? "").slice(0, 10)}` : "No Revenue Standard Tax Entries decision table in this org.", dt ? null : "tax-engine", dt ? null : STANDARD_TAX_ADMIN_ACTION);
  // A clone exists but the engine still uses the system table: the admin's last step is selecting it on the engine.
  // Only a table Salesforce has actually refreshed can be assigned (an Active table that never synced has no rows to match).
  const unlinked = dt?.source === "system" ? candidates.filter(c => c.status === "Active" && c.hasTaxCode && /^completed/i.test(c.refreshStatus ?? "") && !!c.lastSync) : [];
  if (unlinked.length) add("engine-table", "Engine Decision Table", "ACTION REQUIRED", `Active Revenue Standard Tax table${unlinked.length > 1 ? "s" : ""} with a TaxCode input found (${unlinked.map(c => `${c.name} ${c.id}`).join(", ")}) but the tax engine still uses StandardTax.`, "tax-engine", "Open the Revenue Standard Tax Engine record in Salesforce and select the cloned table in Decision Table.");
  else if (dt?.source === "system" && candidates.length) add("engine-table", "Engine Decision Table", "WARNING", `Revenue Standard Tax table(s) found but not usable yet: ${candidates.map(c => `${c.name} (${c.status ?? "—"}${c.hasTaxCode ? "" : ", no TaxCode input"}${/^completed/i.test(c.refreshStatus ?? "") && c.lastSync ? "" : ", never refreshed successfully"})`).join(", ")}.`, "tax-engine", CLONE_TABLE_STEPS);
  add("table-status", "Decision Table Status", dt?.status === "Active" ? "PASS" : "FAILED", dt?.status ?? "—", dt?.status === "Active" ? null : "tax-engine");
  add("table-schema", "Decision Table Schema Status", !dt || dt.outdated ? "FAILED" : "PASS", dt ? `Inputs: ${dt.inputs.map(i => `${i.field}${i.required ? " (required)" : ""}`).join(", ")}.${dt.outdated ? ` ${dt.source === "engine" ? "No TaxCode input — add the Tax Code column from Tax Rate, then activate and refresh it." : STANDARD_TAX_OUTDATED}` : ""}` : "—", !dt || dt.outdated ? "tax-engine" : null, dt?.outdated ? (dt.source === "engine" ? CLONE_TABLE_STEPS : TABLE_ADMIN_FIX) : null);
  add("table-refresh", "Decision Table Refresh Status", !dt ? "FAILED" : /completed/i.test(dt.refreshStatus ?? "") ? (dt.stale ? "WARNING" : "PASS") : /fail|error/i.test(dt.refreshStatus ?? "") ? "FAILED" : "WARNING",
    dt ? `${dt.refreshStatus ?? "—"} · last synced ${dt.lastSync ?? "never"}${dt.lastIncrementalSync ? ` · incremental ${dt.lastIncrementalSync}${dt.incrementalFailed ? " (failed)" : ""}` : ""}${dt.refreshFailure ? ` · ${dt.refreshFailure}` : ""}${dt.stale ? " · rates changed after the last refresh" : ""}` : "—");
  const calc = calculationReadiness(dt, engines.length);
  const errorText = latestError?.unavailable ? `unavailable (${latestError.unavailable})` : latestError ? `${latestError.number}: ${latestError.code} — ${latestError.message}` : null;
  add("engine-readiness", "Tax Engine Readiness", calc.ready ? "PASS" : "FAILED", calc.ready ? "Salesforce can calculate tax." : `Salesforce tax engine: ${calc.reason}${errorText ? ` Last Salesforce tax error ${errorText}` : ""}`, calc.ready ? null : "tax-engine", calc.ready ? null : dt?.outdated ? TABLE_ADMIN_FIX : null);

  const tableProblem = !dt || dt.outdated;
  const matrix = matrices[0] ? { id: matrices[0].Id as string, name: String(matrices[0].Name) } : null;
  const currentInputs = dt?.inputs.map(i => i.field) ?? [];
  const missingInputs = dt?.hasTaxCode ? [] : ["TaxCode"];
  const adminAction: AdminActionRequired | null = tableProblem ? {
    required: true, status: "FAILED", category: "Salesforce tax engine",
    error: latestError && !latestError.unavailable ? { number: latestError.number, code: latestError.code, message: latestError.message, at: latestError.at } : null,
    issue: dt ? STANDARD_TAX_OUTDATED : "The Revenue Standard Tax Entries (StandardTax) decision table doesn't exist in this org.", adminAction: STANDARD_TAX_ADMIN_ACTION,
    decisionTable: dt ? { id: dt.id, apiName: dt.name, name: dt.setupName, status: dt.status, refreshStatus: dt.refreshStatus, lastRefresh: dt.lastSync } : null,
    internalMatrix: matrix, currentInputs, missingInputs,
    supportCase: {
      subject: "Revenue Standard Tax: Revenue Standard Tax Entries decision table can't be regenerated; tax calculation fails with TAX_INTERNAL_ERROR",
      details: [
        `Org: ${c.orgName ?? "—"} (${c.orgId ?? "unknown"}) · ${c.instanceUrl} · API ${v}`,
        latestError?.unavailable ? `RevenueTransactionErrorLog: ${latestError.unavailable}` : latestError ? `RevenueTransactionErrorLog ${latestError.number}: ${latestError.code} — ${latestError.message}` : "No TAX_* RevenueTransactionErrorLog yet.",
        dt ? `Decision table ${dt.name} / "${dt.setupName ?? ""}" ${dt.id} · ${dt.status} · refresh ${dt.refreshStatus ?? "—"} · last synced ${dt.lastSync ?? "never"}` : "No Revenue Standard Tax Entries decision table exists.",
        `Current inputs: ${currentInputs.join(", ") || "—"} · missing: ${missingInputs.join(", ") || "—"} (documented matching uses tax code, legal entity, country/state ISO and product code).`,
        matrix ? `Internal decision matrix ${matrix.name} ${matrix.id} references the table; API deletion returns DEPENDENCY_EXISTS.` : "No internal decision matrix found for the table.",
        "Setup → Lookup Tables offers only Activate, Deactivate, Refresh and Clone for this table (no Delete); Refresh doesn't add the TaxCode column.",
        "Request: regenerate/upgrade the Revenue Standard Tax Entries decision table to the current structure for this release, or advise the supported procedure.",
      ],
    },
  } : null;
  return { success: true, connection: c, ready: calc.ready, headline: calc.ready ? "Salesforce tax engine is ready." : calc.reason ?? "Salesforce tax engine isn't ready.", items, latestError, adminAction };
}
