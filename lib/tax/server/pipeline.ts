import { soqlEscape } from "@/lib/salesforce/client";
import { diag, isPermissionError, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { resolveTaxConfiguration, type ConfigurationResolution, type TaxContext } from "@/lib/tax/server/resolution";
import { REFRESH_REQUIRED_ACTION, tableState } from "@/lib/tax/server/calculation";
import { effectiveRefresh, REQUIRED_TABLE_INPUTS, REQUIRED_TABLE_OUTPUTS, type DecisionTableState } from "@/lib/tax/server/engine";
import { tableForEngine, type TaxRuntimeApi } from "@/lib/tax/server/runtime";
import type { TaxRunState } from "@/lib/tax/server/verification";
import type { OrderBillingState } from "@/lib/billing/server/orderBilling";
import { BadInputError } from "@/lib/billing/server/payments";
import { evaluateTaxGeography } from "@/lib/tax/server/orderItemTax";
import { isInvoiceProcessing } from "@/lib/tax/server/invoiceTax";

/** Record Ids from a URL/body are checked before any Salesforce call (a malformed Id is a 400, not a Salesforce error). */
export function assertSalesforceId(id: string, what: string): void {
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) throw new BadInputError(`${what} isn't a valid Salesforce Id.`);
}

/**
 * TAX PIPELINE — readiness and verification around Salesforce's own tax lifecycle:
 *
 *   CONFIGURATION → READY → ORDER → ORDER ACTIVATED → BILLING SCHEDULE → INVOICE → INVOICE LINE → INVOICE LINE TAX → TAX VERIFIED
 *
 * Billing schedules, invoices, invoice lines and InvoiceLineTax are Salesforce-generated; this module only reads them, triggers
 * Salesforce's supported actions (through the existing order-billing services) and verifies the outcome. "Configuration exists",
 * "Salesforce calculated tax" and "InvoiceLineTax was generated" are reported separately; TAX VERIFIED needs Salesforce's
 * InvoiceLineTax at the applicable rate. The decision table is NEVER refreshed silently: a stale table (a TaxRate changed after its
 * last successful full or incremental refresh) blocks invoicing until an explicit, approved refresh — refresh: "approved" — or the
 * Salesforce Refresh button. A missing TaxCode input can't be fixed by a refresh and stays an admin action.
 */

export type AreaStatus = "READY" | "WARNING" | "BLOCKED" | "FAILED";
export interface ReadinessArea { id: string; label: string; status: AreaStatus; detail: string; recordId?: string | null }
export type TableState = "Ready" | "Not Ready" | "Refreshing" | "Failed";

const worst = (xs: AreaStatus[]): AreaStatus => (xs.includes("FAILED") ? "FAILED" : xs.includes("BLOCKED") ? "BLOCKED" : xs.includes("WARNING") ? "WARNING" : "READY");
const has = (r: ConfigurationResolution, ...codes: string[]) => r.diagnostics.some(d => codes.includes(d.code) && d.severity === "error");
const IN_PROGRESS = /progress|queued|pending|running|processing|initiated/i;

/* ───────────── Decision table ───────────── */

export function decisionTableDisplay(dt: DecisionTableState | null, activeNativeEngines: number): { state: TableState; status: AreaStatus; reason: string } {
  if (!dt) return { state: "Not Ready", status: "BLOCKED", reason: "No Revenue Standard Tax decision table exists in this org." };
  const ts = tableState(dt, activeNativeEngines)!;
  if (ts.ready) return { state: "Ready", status: "READY", reason: `${dt.name} is active and refreshed (${effectiveRefresh(dt.lastSync, dt.lastIncrementalSync, dt.incrementalFailed) ?? "—"}).` };
  if (IN_PROGRESS.test(dt.refreshStatus ?? "")) return { state: "Refreshing", status: "BLOCKED", reason: `${dt.name} is refreshing in Salesforce — invoicing waits until it completes.` };
  if (/fail|error/i.test(dt.refreshStatus ?? "")) return { state: "Failed", status: "BLOCKED", reason: `The last refresh of ${dt.name} failed${dt.refreshFailure ? `: ${dt.refreshFailure}` : ""}. ${REFRESH_REQUIRED_ACTION}` };
  return { state: "Not Ready", status: "BLOCKED", reason: `${ts.reason}${ts.action ? ` ${ts.action}` : ""}` };
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = ms => new Promise(r => setTimeout(r, ms));
/** The refresh timestamps Salesforce moves when it acts on a refresh request (a full refresh sets LastSyncDate, an incremental one
 *  LastIncrementalSyncDate — p10 ran the same request as full in E1c and incremental in E2). */
const syncMark = (dt: DecisionTableState) => `${dt.refreshStatus ?? ""}|${dt.lastSync ?? ""}|${dt.lastIncrementalSync ?? ""}`;

/**
 * Is the decision table current before Salesforce calculates tax? Inspect-only by default: a stale or failed table returns
 * "Not Ready" with the explicit remediation. Only refresh: "approved" (the caller obtained the user's approval for exactly this
 * step) calls Salesforce's refreshDecisionTable action and waits for Salesforce to finish. Never clones, edits or activates a table.
 */
export async function ensureDecisionTableFresh(api: TaxRuntimeApi, opts: { maxWaitMs?: number; intervalMs?: number; sleep?: Sleep; refresh?: "approved" | "never"; engineId?: string | null } = {}): Promise<{ state: TableState; reason: string; refreshed: boolean; dt: DecisionTableState | null }> {
  const { maxWaitMs = 60_000, intervalMs = 3_000, sleep = defaultSleep } = opts;
  let dt = await api.decisionTable(opts.engineId ?? null);
  if (!dt) return { state: "Not Ready", reason: "No Revenue Standard Tax decision table exists in this org.", refreshed: false, dt };
  const ts = tableState(dt, 1)!;
  if (ts.ready) return { state: "Ready", reason: `${dt.name} is active and refreshed.`, refreshed: false, dt };
  if (!ts.refreshable) return { state: "Not Ready", reason: `${ts.reason}${ts.action ? ` ${ts.action}` : ""}`, refreshed: false, dt };
  const inProgress = IN_PROGRESS.test(dt.refreshStatus ?? "");
  if (opts.refresh !== "approved" && !inProgress) return { state: "Not Ready", reason: `${dt.name} isn't current (${ts.reason}). It isn't refreshed automatically — ${REFRESH_REQUIRED_ACTION} (App Launcher → Lookup Tables → ${dt.setupName ?? dt.name} → Refresh), then re-check.`, refreshed: false, dt };
  let refreshed = false;
  const before = syncMark(dt);
  let acted = false;
  if (!inProgress) {
    const r = await api.refreshDecisionTable(dt.name);
    // p10: the refreshDecisionTable API action has failed (UNKNOWN_EXCEPTION) for an API-created table that Salesforce's own
    // Refresh button refreshed fine — so the remediation names that button.
    if (!r.ok) return { state: "Failed", reason: `Salesforce refused to refresh ${dt.name}: ${r.message ?? `HTTP ${r.status}`}. Refresh it in Salesforce: App Launcher → Lookup Tables → ${dt.setupName ?? dt.name} → Refresh, then re-check.`, refreshed: false, dt };
    refreshed = true;
  }
  for (let waited = 0; waited < maxWaitMs; waited += intervalMs) {
    await sleep(intervalMs);
    dt = await api.decisionTable(opts.engineId ?? null);
    if (!dt) break;
    // Only states Salesforce reports once it has acted on the request count (a previous refresh's "Failed"/"Completed" isn't this
    // refresh's result): wait until the status or either sync timestamp differs from the snapshot taken before the request.
    if (syncMark(dt) !== before) acted = true;
    if (!acted) continue;
    if (/fail|error/i.test(dt.refreshStatus ?? "") || dt.incrementalFailed) return { state: "Failed", reason: `Salesforce's refresh of ${dt.name} failed${dt.refreshFailure ? `: ${dt.refreshFailure}` : ""}.`, refreshed, dt };
    if (tableState(dt, 1)!.ready) return { state: "Ready", reason: `${dt.name} refreshed by Salesforce (${effectiveRefresh(dt.lastSync, dt.lastIncrementalSync, dt.incrementalFailed) ?? "—"}).`, refreshed, dt };
  }
  return { state: "Refreshing", reason: `${dt?.name ?? "The decision table"} refresh isn't confirmed by Salesforce yet (still ${dt?.refreshStatus ?? "unknown"}).`, refreshed, dt };
}

/* ───────────── Tax engine readiness (structured) ───────────── */

export interface EngineCheck { code: string; label: string; object: string; recordId: string | null; passed: boolean; detail: string; salesforceMessage: string | null; remediation: string | null }
export interface EngineReadiness {
  status: "READY" | "BLOCKED";
  engine: { id: string; name: string; type: string | null; status: string | null; decisionTableId: string | null } | null;
  decisionTable: { id: string; name: string; setupName?: string | null; source: "engine" | "system"; status: string | null; usageType?: string | null; refreshStatus: string | null; lastSync: string | null; lastIncrementalSync?: string | null; inputs: string[]; outputs: string[]; sourceObject: string | null } | null;
  checks: EngineCheck[];
}

const ADMIN_TABLE_STEPS = "In Salesforce: App Launcher → Lookup Tables → Revenue Standard Tax Entries → Clone; keep every input (Country, State, City, ZipCode, ProductCode, StartDate, EndDate, RateUsageType, LegalEntityId), the outputs (Rate, Priority, ApplicationBasis, FlatTaxAmount) and the Tax Rate source; add Tax Code (from Tax Rate) as an INPUT with operator Equals, not required; Save, Activate, Refresh; then set the clone as Decision Table on the tax engine used by the treatment.";

/**
 * Pure: can THIS engine calculate Revenue Standard Tax? Engine active and Revenue Standard Tax → the decision table Salesforce uses
 * for it (its DecisionTableId, else the system StandardTax table) is active, reads Tax Rates, has the required inputs, the TaxCode
 * input and the Rate output, and its refresh completed after the latest rate change. Any failed check → BLOCKED.
 */
export function evaluateEngineReadiness(engine: { id: string; name: string; type: string | null; status: string | null; native: boolean; decisionTableId: string | null } | null, dt: DecisionTableState | null): EngineReadiness {
  const checks: EngineCheck[] = [];
  const add = (code: string, label: string, object: string, recordId: string | null, passed: boolean, detail: string, remediation: string | null, salesforceMessage: string | null = null) => checks.push({ code, label, object, recordId, passed, detail, salesforceMessage, remediation: passed ? null : remediation });
  if (!engine) {
    add("ENGINE_MISSING", "Tax Engine exists", "TaxEngine", null, false, "The treatment has no tax engine.", "Set the Revenue Standard Tax engine on the taxable treatment.");
    return { status: "BLOCKED", engine: null, decisionTable: null, checks };
  }
  add("ENGINE_ACTIVE", "Tax Engine is Active", "TaxEngine", engine.id, engine.status === "Active", `${engine.name}: ${engine.status ?? "—"}`, `Activate tax engine "${engine.name}".`);
  add("ENGINE_TYPE", "Engine type is RevenueStandardTax", "TaxEngine", engine.id, engine.native, `${engine.name}: ${engine.type ?? "—"}`, "Use a Revenue Standard Tax engine (external engines calculate through their provider).");
  add("ENGINE_TABLE_ASSIGNED", "Engine has its own decision table (TaxEngine.DecisionTableId)", "TaxEngine", engine.id, !!engine.decisionTableId, engine.decisionTableId ? `DecisionTableId = ${engine.decisionTableId}` : `No DecisionTableId — Salesforce uses the system table ${dt?.name ?? "StandardTax"}.`, `Select the corrected decision table in the Decision Table field of tax engine "${engine.name}".`);
  if (!dt) {
    add("TABLE_MISSING", "Decision table exists", "DecisionTable", engine.decisionTableId, false, "No Revenue Standard Tax decision table found.", ADMIN_TABLE_STEPS);
    return { status: "BLOCKED", engine: { id: engine.id, name: engine.name, type: engine.type, status: engine.status, decisionTableId: engine.decisionTableId }, decisionTable: null, checks };
  }
  const inputs = dt.inputs.map(i => i.field);
  add("TABLE_ACTIVE", "Decision table is Active", "DecisionTable", dt.id, dt.status === "Active", `${dt.name}: ${dt.status ?? "—"}`, `Activate decision table ${dt.name} (Setup → Lookup Tables).`);
  add("TABLE_TAXCODE_INPUT", "TaxCode is an INPUT", "DecisionTableParameter", dt.id, dt.hasTaxCode, `Inputs: ${inputs.join(", ") || "—"}`, ADMIN_TABLE_STEPS);
  const missingIn = REQUIRED_TABLE_INPUTS.filter(f => !inputs.includes(f));
  add("TABLE_REQUIRED_INPUTS", `Required inputs present (${REQUIRED_TABLE_INPUTS.join(", ")})`, "DecisionTableParameter", dt.id, !missingIn.length, missingIn.length ? `Missing: ${missingIn.join(", ")}` : "Present", "Keep the inputs of Revenue Standard Tax Entries in the clone.");
  const missingOut = REQUIRED_TABLE_OUTPUTS.filter(f => !dt.outputs.includes(f));
  add("TABLE_RATE_OUTPUT", "Rate is an OUTPUT", "DecisionTableParameter", dt.id, !missingOut.length, `Outputs: ${dt.outputs.join(", ") || "—"}`, "Keep the Rate output (and Priority, ApplicationBasis, FlatTaxAmount) in the clone.");
  const dataset = dt.sourceObject === "TaxRate" && dt.datasetLinks.some(l => l.sourceObject === "TaxRate");
  add("TABLE_TAXRATE_SOURCE", "Reads Tax Rates (source object + dataset link)", "DecisionTableDatasetLink", dt.datasetLinks[0]?.id ?? dt.id, dataset, `Source ${dt.sourceObject ?? "—"} · links: ${dt.datasetLinks.map(l => `${l.name} → ${l.sourceObject}`).join(", ") || "none"}`, "Keep Tax Rate as the decision table's source (clone, don't create a new table).");
  const refreshed = /completed/i.test(dt.refreshStatus ?? "") && !dt.stale;
  add("TABLE_REFRESHED", "Refresh completed after the latest rate change", "DecisionTable", dt.id, refreshed, `${dt.refreshStatus ?? "—"} · last sync ${dt.lastSync ?? "never"}${dt.lastIncrementalSync ? ` · incremental ${dt.lastIncrementalSync}` : ""}${dt.stale ? " · rates changed since" : ""}`, `Refresh ${dt.name} — ${REFRESH_REQUIRED_ACTION}`, dt.refreshFailure);
  return {
    status: checks.every(c => c.passed || c.code === "ENGINE_TABLE_ASSIGNED" && checks.filter(x => x.code.startsWith("TABLE_")).every(x => x.passed)) ? "READY" : "BLOCKED",
    engine: { id: engine.id, name: engine.name, type: engine.type, status: engine.status, decisionTableId: engine.decisionTableId },
    decisionTable: { id: dt.id, name: dt.name, setupName: dt.setupName, source: dt.source, status: dt.status, usageType: dt.usageType ?? null, lastIncrementalSync: dt.lastIncrementalSync ?? null, refreshStatus: dt.refreshStatus, lastSync: dt.lastSync, inputs, outputs: dt.outputs, sourceObject: dt.sourceObject },
    checks,
  };
}

/* ───────────── Product readiness ───────────── */

export interface ProductTaxReadiness {
  success: true;
  status: AreaStatus;
  product: { id: string; name: string; code: string | null } | null;
  areas: ReadinessArea[];
  decisionTable: { state: TableState; reason: string };
  resolution: ConfigurationResolution | null;
  /** Structured readiness of the treatment's tax engine and the decision table Salesforce uses for it (null if not taxable). */
  engineReadiness?: EngineReadiness | null;
  /** Standard Price Book unit price of the product (null when it has none). */
  listPrice?: number | null;
  diagnostics: TaxDiagnostic[];
  message: string;
}

/** Pure: readiness areas from a resolution, the decision table and billing facts. */
export function evaluateProductReadiness(res: ConfigurationResolution, dt: DecisionTableState | null, activeNativeEngines: number, billing: { listPrice: number | null }): { status: AreaStatus; areas: ReadinessArea[]; decisionTable: { state: TableState; reason: string } } {
  const t = res.treatment;
  const taxable = !!t.treatment?.taxable;
  const areas: ReadinessArea[] = [];
  const add = (id: string, label: string, status: AreaStatus, detail: string, recordId?: string | null) => areas.push({ id, label, status, detail, recordId: recordId ?? null });
  add("policy", "Tax Policy", !t.policy ? "BLOCKED" : has(res, "INACTIVE_TAX_POLICY", "MANUAL_TREATMENT_SELECTION") ? "BLOCKED" : "READY",
    t.policy ? `${t.policy.name} · ${t.policy.status ?? "—"} · ${t.policy.selection ?? "—"} selection` : res.diagnostics.find(d => d.code === "MISSING_TAX_POLICY")?.explanation ?? "No tax policy.", t.policy?.id);
  add("treatment", "Tax Treatment", !t.treatment ? "BLOCKED" : has(res, "INACTIVE_TAX_TREATMENT", "AMBIGUOUS_TAX_TREATMENT") ? "BLOCKED" : !taxable ? "WARNING" : "READY",
    t.treatment ? `${t.treatment.name} · ${t.treatment.status ?? "—"} · ${taxable ? "taxable" : "NOT taxable — Salesforce applies no tax"}${t.treatment.useItems ? " · uses Tax Treatment Items" : ""}` : res.diagnostics.find(d => /TREATMENT/.test(d.code))?.explanation ?? "No applicable treatment.", t.treatment?.id);
  add("item", "Tax Treatment Item", !t.treatment?.useItems ? "READY" : t.item ? "READY" : "BLOCKED", !t.treatment ? "—" : !t.treatment.useItems ? "Not used by this treatment." : t.item ? `${t.item.name} · tax code ${t.item.taxCode ?? "—"} · product code ${t.item.productCode ?? "—"}` : `No Tax Treatment Item for ${res.product?.name ?? "the product"}.`, t.item?.id);
  add("engine", "Tax Engine", !taxable ? "WARNING" : !t.engine ? "BLOCKED" : t.engine.status !== "Active" ? "BLOCKED" : !t.engine.native ? "WARNING" : "READY",
    !taxable ? "Not used — the treatment isn't taxable." : t.engine ? `${t.engine.name} · ${t.engine.type ?? "—"} · ${t.engine.status ?? "—"}` : "No tax engine on the taxable treatment.", t.engine?.id);
  add("geography", "Geography", res.geography.diagnostics.some(d => d.severity === "error") ? "BLOCKED" : res.geography.diagnostics.length ? "WARNING" : "READY", res.geography.diagnostics.length ? res.geography.diagnostics.map(d => d.explanation).join(" ") : `${res.geography.country?.name ?? res.geography.countryIso}${res.geography.state ? ` · ${res.geography.state.name}` : ""}`);
  const rate = res.rate;
  add("rate", "Tax Rate", !taxable ? "WARNING" : !rate ? "BLOCKED" : rate.status === "resolved" ? "READY" : "BLOCKED",
    !taxable ? "Not used — the treatment isn't taxable." : !rate ? "Not resolved (see the blocked items above)." : rate.selected ? `${rate.selected.taxCode ?? rate.selected.name} ${rate.selected.rate ?? "?"}% (${rate.selected.name}) — ${rate.why.join("; ")}` : rate.diagnostics.map(d => d.explanation).join(" "), rate?.selected?.id);
  const table = decisionTableDisplay(dt, activeNativeEngines);
  add("decision-table", "Decision Table", table.status, `${table.state}: ${table.reason}`, dt?.id);
  const config = worst(areas.filter(a => a.id !== "decision-table").map(a => a.status));
  add("configuration", "Configuration readiness", config, config === "READY" ? "Product → policy → treatment → engine → rate resolves." : config === "WARNING" ? "Resolves with warnings (see above)." : "The tax configuration doesn't resolve (see the blocked items above).");
  const calc: AreaStatus = config === "BLOCKED" || config === "FAILED" ? "BLOCKED" : !taxable ? "WARNING" : table.status === "BLOCKED" ? "BLOCKED" : table.status === "READY" && config === "READY" ? "READY" : "WARNING";
  add("calculation", "Calculation readiness", calc, calc === "READY" ? "Salesforce can calculate tax for this product." : !taxable && config !== "BLOCKED" ? "No tax will be calculated: the applicable treatment isn't taxable." : table.status === "BLOCKED" ? `Salesforce can't calculate tax yet — decision table: ${table.reason}` : calc === "BLOCKED" ? "Fix the configuration first." : "Ready once the decision table refresh completes.");
  add("billing", "Billing integration readiness", res.product && !res.product.active ? "BLOCKED" : billing.listPrice === null ? "BLOCKED" : "READY", res.product && !res.product.active ? "The product is inactive." : billing.listPrice === null ? "No active Standard Price Book entry — the product can't be ordered." : `Standard price ${billing.listPrice}${res.legalEntity ? ` · legal entity ${res.legalEntity.name}` : ""}.`);
  return { status: worst(areas.filter(a => ["configuration", "calculation", "billing"].includes(a.id)).map(a => a.status)), areas, decisionTable: { state: table.state, reason: table.reason } };
}

/** Resolution diagnostics plus one for each BLOCKED area that resolution doesn't already explain (decision table, billing). */
export function readinessDiagnostics(areas: ReadinessArea[], res: ConfigurationResolution, dt: DecisionTableState | null): TaxDiagnostic[] {
  const out = [...res.diagnostics];
  const table = areas.find(a => a.id === "decision-table");
  if (table?.status === "BLOCKED") out.push(dt ? diag("DECISION_TABLE_NOT_READY", table.detail, { recordId: dt.id, operation: `DecisionTable ${dt.name}` }) : diag("MISSING_DECISION_TABLE_RELATIONSHIP", table.detail));
  const billing = areas.find(a => a.id === "billing");
  if (billing?.status === "BLOCKED") out.push(res.product && !res.product.active ? diag("INACTIVE_PRODUCT", billing.detail, { recordId: res.product.id }) : diag("ORDER_NOT_READY", billing.detail, { recordId: res.product?.id ?? null, action: "Add an active Standard Price Book entry for the product." }));
  return out;
}

/** Read-only: is a product ready for Salesforce tax calculation (and billing)? Never changes anything. */
export async function getProductTaxReadiness(api: TaxRuntimeApi, product: { id?: string | null; name?: string | null }, ctx: TaxContext): Promise<ProductTaxReadiness> {
  const loaded = await api.loadData(product);
  const p = loaded.data.product;
  if (!p) {
    const d = diag("MISSING_PRODUCT", loaded.productLookup.message ?? "Product not found.");
    return { success: true, status: "BLOCKED", product: null, areas: [{ id: "product", label: "Product", status: "BLOCKED", detail: d.explanation }], decisionTable: { state: "Not Ready", reason: "—" }, resolution: null, diagnostics: [d], message: d.explanation };
  }
  const res = resolveTaxConfiguration(loaded.data, ctx);
  const engineDt = tableForEngine(loaded, res.treatment.engine?.id);
  const ev = evaluateProductReadiness(res, engineDt, loaded.data.engines.filter(e => e.native && e.status === "Active").length, { listPrice: loaded.listPrice });
  return {
    success: true, status: ev.status, product: { id: p.id, name: p.name, code: p.code }, listPrice: loaded.listPrice, areas: ev.areas, decisionTable: ev.decisionTable, resolution: res,
    engineReadiness: res.treatment.treatment?.taxable ? evaluateEngineReadiness(res.treatment.engine, engineDt) : null, diagnostics: readinessDiagnostics(ev.areas, res, engineDt),
    message: ev.status === "READY" ? `${p.name} is ready for Salesforce tax calculation.` : `${p.name}: ${res.treatment.treatment && !res.treatment.treatment.taxable ? `NOT taxable — its applicable treatment "${res.treatment.treatment.name}" isn't taxable, so Salesforce applies no tax.` : ev.status === "WARNING" ? "ready with warnings." : "NOT ready for tax calculation."} ${ev.areas.filter(a => a.status !== "READY" && !["configuration", "calculation"].includes(a.id)).map(a => `${a.label} ${a.status}: ${a.detail}`).join(" · ")}`.trim(),
  };
}

/* ───────────── Order ───────────── */

export interface OrderTaxReadiness {
  success: true; orderId: string; status: AreaStatus;
  order: { number: string | null; status: string | null; account: string | null; country: string | null; state: string | null; legalEntityId: string | null } | null;
  items: { id: string; product: string | null; quantity: number | null; unitPrice: number | null; sellingModel: string | null; treatmentOnItem: string | null; resolution: ConfigurationResolution | null; checks: ReadinessArea[] }[];
  checks: ReadinessArea[];
  diagnostics: TaxDiagnostic[];
  message: string;
}

/** Pure: order-level and per-item tax checks before activation. */
export function evaluateOrderTaxReadiness(order: Record<string, unknown> | null, items: { row: Record<string, unknown>; resolution: ConfigurationResolution | null; engine?: EngineReadiness | null }[]): Omit<OrderTaxReadiness, "success" | "orderId"> {
  const checks: ReadinessArea[] = [];
  const add = (arr: ReadinessArea[], id: string, label: string, ok: boolean | "warn", detail: string) => arr.push({ id, label, status: ok === true ? "READY" : ok === "warn" ? "WARNING" : "BLOCKED", detail });
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  if (!order) return { status: "BLOCKED", order: null, items: [], checks: [{ id: "order", label: "Order", status: "BLOCKED", detail: "Order not found." }], diagnostics: [diag("ORDER_NOT_READY", "Order not found in the connected org.")], message: "Order not found." };
  add(checks, "account", "Account", !!order.AccountId, s((order.Account as Record<string, unknown> | null)?.Name) ?? "No account.");
  add(checks, "address", "Billing address (tax geography)", !!s(order.BillingCountry), s(order.BillingCountry) ? [order.BillingCity, order.BillingState, order.BillingCountry].filter(Boolean).join(", ") : "The order has no billing country — Salesforce's tax needs the country.");
  add(checks, "items", "Order products", items.length > 0, `${items.length} order product(s).`);
  const diagnostics: TaxDiagnostic[] = [];
  const out = items.map(({ row, resolution, engine }) => {
    const c: ReadinessArea[] = [];
    const prod = s((row.Product2 as Record<string, unknown> | null)?.Name);
    add(c, "product", "Product", !!row.Product2Id, prod ?? "—");
    add(c, "quantity", "Quantity", Number(row.Quantity) > 0, String(row.Quantity ?? "—"));
    add(c, "price", "Unit price", row.UnitPrice !== null && row.UnitPrice !== undefined && Number(row.UnitPrice) >= 0, String(row.UnitPrice ?? "—"));
    if ("ProductSellingModelId" in row) add(c, "selling-model", "Product Selling Model", row.ProductSellingModelId ? true : "warn", s((row.ProductSellingModel as Record<string, unknown> | null)?.Name) ?? (row.ProductSellingModelId ? String(row.ProductSellingModelId) : "None — Revenue Cloud billing usually needs one."));
    if (resolution) {
      const t = resolution.treatment;
      add(c, "policy", "Tax Policy", !!t.policy && t.policy.status === "Active", t.policy ? `${t.policy.name} (${t.policy.status})` : "None.");
      add(c, "treatment", "Tax Treatment", !!t.treatment && t.treatment.status === "Active" ? (t.treatment.taxable ? true : "warn") : false, t.treatment ? `${t.treatment.name} (${t.treatment.status}${t.treatment.taxable ? ", taxable" : ", NOT taxable"})` : "None.");
      if (t.treatment?.taxable) {
        add(c, "engine", "Tax Engine", !!t.engine && t.engine.status === "Active", t.engine ? `${t.engine.name} (${t.engine.status})` : "None.");
        add(c, "rate", "Tax Rate", resolution.rate?.status === "resolved", resolution.rate?.selected ? `${resolution.rate.selected.taxCode ?? resolution.rate.selected.name} ${resolution.rate.selected.rate}%` : resolution.rate?.diagnostics.map(d => d.explanation).join(" ") ?? "—");
      }
      add(c, "geography", "Tax geography", resolution.geography.diagnostics.some(d => d.severity === "error") ? false : resolution.geography.diagnostics.length ? "warn" : true, resolution.geography.diagnostics.map(d => d.explanation).join(" ") || `${resolution.geography.countryIso}${resolution.geography.stateIso ? `/${resolution.geography.stateIso}` : ""}`);
      if (row.TaxTreatmentId && t.treatment && String(row.TaxTreatmentId).slice(0, 15) !== t.treatment.id.slice(0, 15)) add(c, "stamp", "Treatment on the order product", "warn", `The order product carries a different treatment than the policy resolves.`);
      // Salesforce copies OrderItem.TaxTreatmentId to the schedule and invoice line; it never derives it from the Tax Policy.
      if ("TaxTreatmentId" in row && !row.TaxTreatmentId && t.treatment && t.policy?.selection !== "LegalEntity") add(c, "stamp", "Tax Treatment on the order product", false, `Not set. Salesforce doesn't take it from Tax Policy "${t.policy?.name ?? "—"}" — the billing schedule and invoice line would get the legal entity's default treatment instead of "${t.treatment.name}". Set it on the order product before activation (Revenue Cloud Billing → Apply Order Actions, Billing & Tax Treatments); an activated order needs a new order.`);
      if (t.treatment?.taxable) {
        const g = resolution.geography;
        const codes = evaluateTaxGeography("Order billing address", { country: s(order.BillingCountry), state: s(order.BillingState) }, { countries: g.country ? [{ name: g.country.name, iso: g.country.iso }] : [], states: g.state ? [{ name: g.state.name, iso: g.state.iso, countryIso: g.state.countryIso }] : [] }).filter(x => x.code === "TAX_GEOGRAPHY_NOT_CODE");
        if (codes.length) add(c, "geography-codes", "Tax geography codes", false, codes.map(x => x.message).join(" "));
        // Same rule as the activation gate (orderItemTax.ts): in p10 no treatment without a Legal Entity ever produced InvoiceLineTax.
        if (!t.treatment.legalEntityId) add(c, "treatment-legal-entity", "Treatment legal entity", false, `Tax Treatment "${t.treatment.name}" has no Legal Entity — every taxable treatment without one produced no InvoiceLineTax in this org. LegalEntityId is locked once the treatment is Active: create a Draft treatment with it, activate it and make it the policy's default.`);
        if (engine && engine.status !== "READY") add(c, "decision-table", "Engine decision table", false, engine.checks.filter(x => !x.passed && !(x.code === "ENGINE_TABLE_ASSIGNED" && engine.checks.filter(y => y.code.startsWith("TABLE_")).every(y => y.passed))).map(x => `${x.label}: ${x.detail}${x.remediation ? ` — ${x.remediation}` : ""}`).join(" · "));
      }
      diagnostics.push(...resolution.diagnostics);
    }
    return { id: row.Id as string, product: prod, quantity: Number(row.Quantity ?? NaN), unitPrice: row.UnitPrice === null || row.UnitPrice === undefined ? null : Number(row.UnitPrice), sellingModel: s((row.ProductSellingModel as Record<string, unknown> | null)?.Name), treatmentOnItem: s((row.TaxTreatment as Record<string, unknown> | null)?.Name), resolution, checks: c };
  });
  const status = worst([...checks, ...out.flatMap(i => i.checks)].map(x => x.status));
  return {
    status, order: { number: s(order.OrderNumber), status: s(order.Status), account: s((order.Account as Record<string, unknown> | null)?.Name), country: s(order.BillingCountry), state: s(order.BillingState), legalEntityId: s(order.LegalEntityId) },
    items: out, checks, diagnostics,
    message: (() => { const all = [...checks, ...out.flatMap(i => i.checks.map(x => ({ ...x, label: `${i.product ?? "line"}: ${x.label}` })))]; const list = (st: AreaStatus) => all.filter(x => x.status === st).map(x => `${x.label} — ${x.detail}`).join(" · "); return status === "READY" ? "The order is ready for Salesforce tax." : status === "WARNING" ? `The order is ready for Salesforce tax with warnings: ${list("WARNING")}.` : `The order isn't ready for tax: ${list("BLOCKED")}.`; })(),
  };
}

export async function validateOrderTaxReadiness(api: TaxRuntimeApi, orderId: string): Promise<OrderTaxReadiness> {
  assertSalesforceId(orderId, "Order Id");
  const id = soqlEscape(orderId);
  const [order] = await api.query(`SELECT Id, OrderNumber, Status, AccountId, Account.Name, EffectiveDate, BillingCountry, BillingState, BillingCity, BillingPostalCode, LegalEntityId FROM Order WHERE Id = '${id}'`);
  const base = "SELECT Id, Product2Id, Product2.Name, Quantity, UnitPrice, TaxTreatmentId, TaxTreatment.Name";
  // OrderItem.ProductSellingModelId only exists with Revenue Cloud selling models; only that field's absence falls back.
  const rows = await api.query(`${base}, ProductSellingModelId, ProductSellingModel.Name FROM OrderItem WHERE OrderId = '${id}' ORDER BY CreatedDate`)
    .catch(e => (/INVALID_FIELD|No such column|ProductSellingModel/i.test(String((e as Error)?.message)) ? api.query(`${base} FROM OrderItem WHERE OrderId = '${id}' ORDER BY CreatedDate`) : Promise.reject(e)));
  const items = [];
  for (const row of rows) {
    const loaded = row.Product2Id ? await api.loadData({ id: String(row.Product2Id) }) : null;
    const resolution = loaded?.data.product ? resolveTaxConfiguration(loaded.data, { country: order?.BillingCountry as string, state: order?.BillingState as string, city: order?.BillingCity as string, zipCode: order?.BillingPostalCode as string, legalEntityId: (order?.LegalEntityId as string) ?? null, effectiveDate: (order?.EffectiveDate as string) ?? null, treatmentId: (row.TaxTreatmentId as string) ?? null }) : null;
    const engine = loaded && resolution?.treatment.treatment?.taxable ? evaluateEngineReadiness(resolution.treatment.engine, tableForEngine(loaded, resolution.treatment.engine?.id)) : null;
    items.push({ row, resolution, engine });
  }
  return { success: true, orderId, ...evaluateOrderTaxReadiness(order ?? null, items) };
}

/* ───────────── Billing schedule ───────────── */

export interface BillingScheduleVerification {
  success: true; orderId: string; status: "FOUND" | "PROCESSING" | "MISSING";
  order: { number: string | null; status: string | null; activated: boolean } | null;
  schedules: { id: string; number: string; status: string | null; product: string | null; start: string | null; end: string | null; nextBillingDate: string | null; amount: number | null; billingTreatmentItem: string | null; taxTreatment: string | null; invoiced: boolean }[];
  diagnostics: TaxDiagnostic[]; message: string;
}

/** Pure: what the order's Salesforce-generated billing schedules say, and why there are none. */
export function evaluateBillingSchedules(b: Pick<OrderBillingState, "order" | "schedules" | "jobs" | "scheduleCreation">, treatments: { id: string; treatmentName: string | null }[], errorLog: { code: string | null; message: string | null; number: string | null } | null): Omit<BillingScheduleVerification, "success" | "orderId"> {
  const schedules = b.schedules.map(s => ({ id: s.id, number: s.number, status: s.status, product: s.product, start: s.start, end: s.end, nextBillingDate: s.nextBillingDate, amount: s.amount, billingTreatmentItem: s.treatmentItem, taxTreatment: treatments.find(t => t.id === s.id)?.treatmentName ?? null, invoiced: s.invoiced }));
  const order = { number: b.order.number, status: b.order.status, activated: b.order.activated };
  if (schedules.length) {
    const noTax = schedules.filter(s => !s.taxTreatment);
    const errored = schedules.filter(s => /error/i.test(s.status ?? ""));
    const diagnostics = [
      ...noTax.map(s => diag("BILLING_SCHEDULE_MISSING", `Billing schedule ${s.number} has no tax treatment — Salesforce won't calculate tax on its invoice lines.`, { severity: "warning", recordId: s.id })),
      ...errored.map(s => diag("BILLING_SCHEDULE_MISSING", `Billing schedule ${s.number} is in Error.`, { recordId: s.id, salesforceCode: errorLog?.code, salesforceMessage: errorLog?.message })),
    ];
    return { status: "FOUND", order, schedules, diagnostics, message: `${schedules.length} billing schedule(s): ${schedules.map(s => `${s.number} (${s.status ?? "—"}, tax treatment ${s.taxTreatment ?? "none"})`).join(", ")}.` };
  }
  const job = b.jobs.find(j => IN_PROGRESS.test(j.status ?? ""));
  if (job) return { status: "PROCESSING", order, schedules, diagnostics: [], message: `Salesforce is still creating the billing schedules (job ${job.number ?? job.id}: ${job.status}).` };
  const failedJob = b.jobs.find(j => /fail|error/i.test(j.status ?? "") || (j.failedItems ?? 0) > 0);
  const reason = !b.order.activated ? "The order isn't activated — Salesforce creates billing schedules after activation."
    : failedJob ? `Salesforce's schedule job ${failedJob.number ?? failedJob.id} ${failedJob.status}: ${failedJob.response ?? "no response"}`
      : errorLog ? `Salesforce ${errorLog.number ?? ""} ${errorLog.code ?? ""}: ${errorLog.message ?? ""}`.trim()
        : b.scheduleCreation.available ? "Salesforce hasn't created billing schedules yet; they can be requested now." : b.scheduleCreation.reason;
  return { status: "MISSING", order, schedules, diagnostics: [diag("BILLING_SCHEDULE_MISSING", reason, { salesforceCode: errorLog?.code ?? null, salesforceMessage: errorLog?.message ?? failedJob?.response ?? null })], message: `No billing schedule: ${reason}` };
}

export async function verifyBillingScheduleForTax(api: TaxRuntimeApi, orderId: string): Promise<BillingScheduleVerification> {
  assertSalesforceId(orderId, "Order Id");
  const b = await api.orderBilling(orderId);
  const [treatments, log] = await Promise.all([api.scheduleTreatments(b.schedules.map(s => s.id)), api.errorLog([orderId, ...b.schedules.map(s => s.id)])]);
  return { success: true, orderId, ...evaluateBillingSchedules(b, treatments, log) };
}

/* ───────────── Invoice line tax ───────────── */

type Invoice = NonNullable<TaxRunState["invoice"]>;
export type LineTaxStatus = "VERIFIED" | "NO_TAX_EXPECTED" | "MISMATCH" | "PENDING" | "MISSING" | "ERROR";
/** What the configuration says a line should carry: an applicable rate, explicitly no tax (non-taxable treatment), or unknown. */
export type LineExpectation = { rateId: string; rate: number | null; taxCode: string | null } | { notTaxable: true; treatment: string } | null;
export interface InvoiceLineTaxVerification {
  /** SUCCESS = Salesforce's InvoiceLineTax verified · NO_TAX_EXPECTED = every line's treatment is non-taxable (nothing calculated). */
  success: true; invoiceId: string; status: "SUCCESS" | "NO_TAX_EXPECTED" | "FAILED" | "PENDING";
  invoice: { number: string | null; status: string | null; subtotal: number | null; tax: number | null; totalWithTax: number | null; date: string | null } | null;
  lines: { invoiceLineId: string; product: string | null; productId: string | null; charge: number | null; lineTaxAmount: number | null; taxStatus: string | null; treatment: string | null; treatmentId: string | null; status: LineTaxStatus;
    expected: { rateId: string; rate: number | null; taxCode: string | null; taxAmount: number | null } | null;
    taxes: { id: string; name: string | null; amount: number | null; rate: number | null; code: string | null; status: string | null; treatmentId: string | null }[]; detail: string }[];
  diagnostics: TaxDiagnostic[]; message: string;
}

/** Pure: verify Salesforce's InvoiceLineTax for every line against the applicable rate. */
export function evaluateInvoiceLineTax(inv: Invoice | null, expectations: Map<string, LineExpectation>, errorLog: { code: string | null; message: string | null; number: string | null } | null): Omit<InvoiceLineTaxVerification, "success" | "invoiceId"> {
  if (!inv) return { status: "FAILED", invoice: null, lines: [], diagnostics: [diag("INVOICE_MISSING", "Invoice not found.")], message: "Invoice not found." };
  const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.011;
  const diagnostics: TaxDiagnostic[] = [];
  if (!inv.lines.length) diagnostics.push(diag("INVOICE_LINE_MISSING", `Invoice ${inv.number ?? inv.id} has no invoice lines.`));
  const lines = inv.lines.map(l => {
    const e = expectations.get(l.id) ?? null;
    const notTaxable = !!e && "notTaxable" in e;
    const exp = e && !("notTaxable" in e) ? e : null;
    const sum = l.taxes.length ? Math.round(l.taxes.reduce((s, t) => s + (t.amount ?? 0), 0) * 100) / 100 : null;
    const expTax = exp?.rate !== null && exp?.rate !== undefined && l.charge !== null ? Math.round(l.charge * exp.rate) / 100 : null;
    let status: LineTaxStatus, detail: string;
    if (notTaxable && !l.taxes.length && !/error/i.test(l.taxStatus ?? "")) { status = "NO_TAX_EXPECTED"; detail = `No InvoiceLineTax — correct: treatment "${(e as { treatment: string }).treatment}" is not taxable.`; }
    else if (/error/i.test(l.taxStatus ?? "") || /error/i.test(inv.status ?? "")) { status = "ERROR"; detail = `Salesforce tax processing: ${l.taxStatus ?? inv.status}${errorLog ? ` — ${errorLog.code}: ${errorLog.message}` : ""}`; diagnostics.push(diag("INVOICE_LINE_TAX_MISSING", `Salesforce couldn't calculate tax for ${l.product ?? l.name} on ${inv.number}.`, { salesforceCode: errorLog?.code ?? null, salesforceMessage: errorLog?.message ?? null, recordId: l.id })); }
    else if (!l.taxes.length && /pending/i.test(l.taxStatus ?? "")) { status = "PENDING"; detail = "Tax not calculated yet (Draft invoice)."; diagnostics.push(diag("INVOICE_LINE_TAX_PENDING", `${l.product ?? l.name}: Salesforce hasn't calculated tax yet (TaxProcessingStatus ${l.taxStatus}).`, { severity: "warning", recordId: l.id })); }
    // The invoice is still being processed (Draft In Progress…): a line without InvoiceLineTax isn't missing it yet.
    else if (!l.taxes.length && isInvoiceProcessing(inv.status)) { status = "PENDING"; detail = `Salesforce is still processing the invoice (${inv.status}).`; diagnostics.push(diag("INVOICE_LINE_TAX_PENDING", `${l.product ?? l.name}: Salesforce is still processing ${inv.number ?? "the invoice"} (${inv.status}) — InvoiceLineTax isn't final yet.`, { severity: "warning", recordId: l.id })); }
    else if (!l.taxes.length) { status = "MISSING"; detail = `No InvoiceLineTax${l.treatment ? ` (treatment ${l.treatment.name})` : " — the line has no tax treatment"}.`; diagnostics.push(diag("INVOICE_LINE_TAX_MISSING", `${l.product ?? l.name} on ${inv.number}: Salesforce produced no InvoiceLineTax${l.treatment ? "" : " (no tax treatment on the line)"}${l.taxStatus ? `; TaxProcessingStatus ${l.taxStatus}` : ""}.`, { recordId: l.id })); }
    else if (exp && (!l.taxes.every(t => near(t.rate, exp.rate)) || !near(sum, expTax))) { status = "MISMATCH"; detail = `InvoiceLineTax ${l.taxes.map(t => `${t.rate}% ${t.amount}`).join(" + ")} vs applicable ${exp.taxCode ?? ""} ${exp.rate}% (${expTax}).`; diagnostics.push(diag("INVOICE_LINE_TAX_MISMATCH", `${l.product ?? l.name}: ${detail}`, { recordId: l.id })); }
    else { status = exp ? "VERIFIED" : "MISMATCH"; detail = exp ? `InvoiceLineTax ${sum} at ${exp.rate}% matches the applicable rate${near(l.taxAmount, sum) ? " and the line's tax amount" : ""}.` : "InvoiceLineTax exists, but no applicable rate resolves to compare it with."; if (!exp) diagnostics.push(diag("INVOICE_LINE_TAX_MISMATCH", `${l.product ?? l.name}: Salesforce produced InvoiceLineTax, but the configuration resolves no applicable rate to verify it against.`, { severity: "warning", recordId: l.id })); }
    return { invoiceLineId: l.id, product: l.product, productId: l.productId, charge: l.charge, lineTaxAmount: l.taxAmount, taxStatus: l.taxStatus, treatment: l.treatment?.name ?? null, treatmentId: l.treatment?.id ?? null, status, expected: exp ? { ...exp, taxAmount: expTax } : null,
      taxes: l.taxes.map(t => ({ id: t.id, name: t.name, amount: t.amount, rate: t.rate, code: t.code, status: t.status, treatmentId: t.treatment?.id ?? null })), detail };
  });
  const status: InvoiceLineTaxVerification["status"] = lines.length && lines.every(l => l.status === "NO_TAX_EXPECTED") ? "NO_TAX_EXPECTED" : lines.length && lines.every(l => l.status === "VERIFIED" || l.status === "NO_TAX_EXPECTED") ? "SUCCESS" : lines.some(l => l.status === "PENDING") && !lines.some(l => ["ERROR", "MISMATCH", "MISSING"].includes(l.status)) ? "PENDING" : "FAILED";
  return {
    status, invoice: { number: inv.number, status: inv.status, subtotal: inv.subtotal, tax: inv.tax, totalWithTax: inv.totalWithTax, date: inv.date }, lines, diagnostics,
    message: status === "NO_TAX_EXPECTED" ? `${inv.number}: no InvoiceLineTax, as configured — every line's tax treatment is non-taxable. (Salesforce calculated no tax; this is not a tax calculation result.)` : status === "SUCCESS" ? `Salesforce generated InvoiceLineTax for every line of ${inv.number} at the applicable rate (tax ${inv.tax}).` : status === "PENDING" ? `${inv.number}: Salesforce hasn't calculated the tax yet.` : `${inv.number}: InvoiceLineTax not verified — ${lines.filter(l => l.status !== "VERIFIED").map(l => `${l.product}: ${l.detail}`).join(" · ") || "no lines"}.`,
  };
}

/** Verify Salesforce's InvoiceLineTax on an invoice against the configuration that applies to each line. */
export async function verifyInvoiceLineTax(api: TaxRuntimeApi, invoiceId: string): Promise<InvoiceLineTaxVerification> {
  assertSalesforceId(invoiceId, "Invoice Id");
  const inv = await api.invoice(invoiceId);
  const expected = new Map<string, LineExpectation>();
  if (inv?.lines.length) {
    const [o] = await api.query(`SELECT ReferenceEntityId FROM BillingSchedule WHERE Id IN (SELECT BillingScheduleId FROM InvoiceLine WHERE InvoiceId = '${soqlEscape(invoiceId)}') LIMIT 1`);
    const [order] = o?.ReferenceEntityId ? await api.query(`SELECT BillingCountry, BillingState, BillingCity, BillingPostalCode, LegalEntityId, EffectiveDate FROM Order WHERE Id = '${soqlEscape(String(o.ReferenceEntityId))}'`) : [];
    // One read of the org's treatments (they don't depend on the product) to know which lines are non-taxable.
    const firstProduct = inv.lines.find(l => l.productId)?.productId ?? null;
    const treatments = (await api.loadData(firstProduct ? { id: firstProduct } : { name: inv.lines[0].product ?? "" })).data.treatments;
    for (const l of inv.lines) {
      const lineTreatment = l.treatment ? treatments.find(t => t.id.slice(0, 15) === l.treatment!.id.slice(0, 15)) ?? null : null;
      if (lineTreatment && !lineTreatment.taxable) { expected.set(l.id, { notTaxable: true, treatment: lineTreatment.name }); continue; }
      if (!l.productId) { expected.set(l.id, null); continue; }
      const loaded = await api.loadData({ id: l.productId });
      const res = resolveTaxConfiguration(loaded.data, { country: (order?.BillingCountry as string) ?? null, state: (order?.BillingState as string) ?? null, city: (order?.BillingCity as string) ?? null, zipCode: (order?.BillingPostalCode as string) ?? null, legalEntityId: (order?.LegalEntityId as string) ?? null, effectiveDate: inv.date ?? null, treatmentId: l.treatment?.id ?? null });
      const r = res.rate?.selected ?? null;
      expected.set(l.id, r ? { rateId: r.id, rate: r.rate, taxCode: r.taxCode } : null);
    }
  }
  const log = inv ? await api.errorLog([invoiceId, ...(inv.lines.map(l => l.id))]) : null;
  return { success: true, invoiceId, ...evaluateInvoiceLineTax(inv, expected, log) };
}

/** The most recent invoice line Salesforce generated for a product (newest first). */
export async function latestInvoiceForProduct(api: TaxRuntimeApi, productId: string): Promise<{ invoiceId: string; invoiceLineId: string } | null> {
  const [l] = await api.query(`SELECT Id, InvoiceId FROM InvoiceLine WHERE Product2Id = '${soqlEscape(productId)}' ORDER BY CreatedDate DESC LIMIT 1`);
  return l ? { invoiceId: String(l.InvoiceId), invoiceLineId: String(l.Id) } : null;
}

/* ───────────── Invoice generation ───────────── */

export interface TaxInvoiceGeneration {
  success: true; orderId: string; status: "PREVIEW" | "GENERATED" | "PROCESSING" | "BLOCKED" | "FAILED";
  eligibility: { eligible: boolean; reasons: string[] };
  decisionTable: { state: TableState; reason: string; refreshed: boolean } | null;
  invoice: { id: string; number: string | null; status: string | null } | null;
  lineTax: InvoiceLineTaxVerification | null;
  diagnostics: TaxDiagnostic[]; message: string;
}

/**
 * Generate the invoice from the order's Salesforce billing schedules (confirm required): eligibility → decision table fresh →
 * Salesforce invoice generation (existing order-billing service) → wait for the invoice → verify its lines' InvoiceLineTax.
 */
export async function generateTaxInvoice(api: TaxRuntimeApi, orderId: string, opts: { confirm?: boolean; maxWaitMs?: number; intervalMs?: number; sleep?: Sleep; refresh?: "approved" | "never" } = {}): Promise<TaxInvoiceGeneration> {
  const { maxWaitMs = 60_000, intervalMs = 4_000, sleep = defaultSleep } = opts;
  const sched = await verifyBillingScheduleForTax(api, orderId);
  const b = await api.orderBilling(orderId);
  const reasons: string[] = [];
  if (!b.order.activated) reasons.push("The order isn't activated.");
  if (sched.status !== "FOUND") reasons.push(sched.message);
  const open = sched.schedules.filter(s => !s.invoiced && !/error/i.test(s.status ?? ""));
  if (sched.status === "FOUND" && !open.length) reasons.push("Every billing schedule is already invoiced (or in Error).");
  const base = { success: true as const, orderId, eligibility: { eligible: !reasons.length, reasons }, invoice: null, lineTax: null };
  if (reasons.length) return { ...base, status: "BLOCKED", decisionTable: null, diagnostics: sched.diagnostics, message: `Invoice can't be generated: ${reasons.join(" ")}` };
  if (!opts.confirm) return { ...base, status: "PREVIEW", decisionTable: null, diagnostics: [], message: `Salesforce will generate the invoice from ${open.length} billing schedule(s): ${open.map(s => s.number).join(", ")}. Confirm to proceed.` };
  // An invoice whose tax fails goes to Error and can't be recalculated — the decision table must be current first.
  // The decision table of the order's own treatment engine (first taxable line) — inspect-only unless the refresh was approved.
  const engineId = b.items.map(i => i.tax.effective).find(e => e?.taxable)?.engineId ?? null;
  const table = await ensureDecisionTableFresh(api, { sleep, refresh: opts.refresh === "approved" ? "approved" : "never", engineId });
  if (table.state !== "Ready") return { ...base, status: "BLOCKED", decisionTable: { state: table.state, reason: table.reason, refreshed: table.refreshed }, diagnostics: [diag(table.state === "Refreshing" ? "DECISION_TABLE_REFRESHING" : "DECISION_TABLE_NOT_READY", table.reason)], message: `Invoice not generated — the tax decision table is ${table.state}: ${table.reason}` };
  const before = new Set(b.invoices.map(i => i.id));
  const out = await api.generateInvoices(orderId);
  if (!out.ok) {
    const perm = isPermissionError(out.status, out.code, out.error);
    return { ...base, status: "FAILED", decisionTable: { state: table.state, reason: table.reason, refreshed: table.refreshed }, diagnostics: [diag(perm ? "PERMISSION_OR_LICENSE" : "INVOICE_GENERATION_FAILED", `Salesforce didn't generate the invoice (${out.code}): ${out.error}`, { salesforceCode: out.code, salesforceMessage: out.error, httpStatus: out.status, operation: `Invoice generation for order ${orderId}`, recordId: orderId })], message: `Invoice generation failed: ${out.error}` };
  }
  let inv: OrderBillingState["invoices"][number] | null = null;
  for (let waited = 0; waited <= maxWaitMs; waited += intervalMs) {
    const now = await api.orderBilling(orderId);
    inv = now.invoices.find(i => !before.has(i.id)) ?? null;
    if (inv) break;
    await sleep(intervalMs);
  }
  if (!inv) return { ...base, status: "PROCESSING", decisionTable: { state: table.state, reason: table.reason, refreshed: table.refreshed }, diagnostics: [], message: "Salesforce accepted the invoice request and is still processing it." };
  const lineTax = await verifyInvoiceLineTax(api, inv.id);
  return { ...base, status: "GENERATED", decisionTable: { state: table.state, reason: table.reason, refreshed: table.refreshed }, invoice: { id: inv.id, number: inv.number, status: inv.status }, lineTax, diagnostics: lineTax.diagnostics, message: `Salesforce generated invoice ${inv.number} (${inv.status}). ${lineTax.message}` };
}

/* ───────────── End-to-end pipeline view ───────────── */

/** WARNING = evaluated, not blocking, but needs attention (e.g. non-taxable) — never shown as progress or success. */
export type StageStatus = "DONE" | "WARNING" | "IN_PROGRESS" | "PENDING" | "BLOCKED" | "FAILED" | "NOT_STARTED";
export interface PipelineStage { id: string; label: string; status: StageStatus; recordId: string | null; timestamp: string | null; error: string | null; diagnostic: string | null; verification: string | null }
export const PIPELINE_LABELS: [string, string][] = [["configuration", "CONFIGURATION"], ["ready", "READY"], ["order", "ORDER"], ["activated", "ORDER ACTIVATED"], ["schedule", "BILLING SCHEDULE"], ["invoice", "INVOICE"], ["line", "INVOICE LINE"], ["line-tax", "INVOICE LINE TAX"], ["verified", "TAX VERIFIED"]];

/** Pipeline before any order exists: configuration + readiness evaluated, everything else not started. */
export function pipelineFromReadiness(r: ProductTaxReadiness): PipelineStage[] {
  const config = r.areas.find(a => a.id === "configuration");
  const calc = r.areas.find(a => a.id === "calculation");
  return PIPELINE_LABELS.map(([id, label]) => {
    const st = (s: AreaStatus | undefined): StageStatus => (s === "READY" ? "DONE" : s === "WARNING" ? "WARNING" : s ? "BLOCKED" : "NOT_STARTED");
    if (id === "configuration") return { id, label, status: st(config?.status), recordId: r.resolution?.treatment.treatment?.id ?? null, timestamp: null, error: config?.status === "BLOCKED" ? config.detail : null, diagnostic: r.diagnostics.filter(d => d.severity === "error").map(d => d.explanation).join(" ") || null, verification: config?.detail ?? null };
    if (id === "ready") return { id, label, status: st(calc?.status), recordId: null, timestamp: null, error: calc?.status === "BLOCKED" ? calc.detail : null, diagnostic: r.decisionTable.reason, verification: calc?.detail ?? null };
    return { id, label, status: "NOT_STARTED", recordId: null, timestamp: null, error: null, diagnostic: null, verification: null };
  });
}

/** Pipeline of an existing verification run (order → … → InvoiceLineTax), from Salesforce's records. */
export function pipelineFromRun(s: TaxRunState): PipelineStage[] {
  const step = (id: string) => s.steps.find(x => x.id === id);
  const map = (state: string | undefined): StageStatus => (state === "done" ? "DONE" : state === "failed" ? "FAILED" : state === "processing" || state === "current" ? "IN_PROGRESS" : "PENDING");
  const fail = (id: string) => (s.failure?.step === id ? s.failure.reason : null);
  const inv = s.invoice;
  const lines = inv?.lines ?? [];
  const lineTax = lines.flatMap(l => l.taxes);
  const check = (id: string) => s.checks.find(c => c.id === id);
  return [
    { id: "configuration", label: "CONFIGURATION", status: map(step("config")?.state), recordId: s.items[0]?.expectedTreatment?.id ?? null, timestamp: null, error: fail("config"), diagnostic: step("config")?.detail ?? null, verification: [check("treatment-active"), check("rate-valid")].map(c => c && `${c.passed ? "✓" : "✗"} ${c.label}`).filter(Boolean).join(" · ") || null },
    { id: "ready", label: "READY", status: map(step("readiness")?.state), recordId: null, timestamp: null, error: fail("readiness"), diagnostic: s.readiness.reason, verification: s.readiness.ready ? "Salesforce tax engine ready" : null },
    { id: "order", label: "ORDER", status: "DONE", recordId: s.order.id, timestamp: null, error: null, diagnostic: step("order")?.detail ?? null, verification: `${s.order.number} · ${s.order.status}` },
    { id: "activated", label: "ORDER ACTIVATED", status: s.order.activated ? "DONE" : s.failure?.step === "activate" || s.failure?.step === "setup" ? "FAILED" : map(step("activate")?.state), recordId: s.order.id, timestamp: null, error: fail("activate") ?? fail("setup"), diagnostic: step("activate")?.detail ?? null, verification: s.order.activated ? "Order activated in Salesforce" : null },
    { id: "schedule", label: "BILLING SCHEDULE", status: map(step("schedules")?.state), recordId: s.schedules[0]?.id ?? null, timestamp: null, error: fail("schedules"), diagnostic: step("schedules")?.detail ?? null, verification: s.schedules.length ? s.schedules.map(x => `${x.number} · ${x.treatment?.name ?? "no tax treatment"}`).join(", ") : null },
    { id: "invoice", label: "INVOICE", status: inv ? "DONE" : map(step("invoice")?.state), recordId: inv?.id ?? null, timestamp: inv?.date ?? null, error: fail("invoice"), diagnostic: step("invoice")?.detail ?? null, verification: inv ? `${inv.number} · ${inv.status}` : null },
    { id: "line", label: "INVOICE LINE", status: lines.length ? "DONE" : inv ? "FAILED" : "PENDING", recordId: lines[0]?.id ?? null, timestamp: inv?.date ?? null, error: inv && !lines.length ? "The invoice has no lines." : null, diagnostic: null, verification: lines.length ? lines.map(l => `${l.product ?? l.name} × ${l.quantity} = ${l.charge}`).join(" · ") : null },
    { id: "line-tax", label: "INVOICE LINE TAX", status: lineTax.length && check("line-tax-records")?.passed ? "DONE" : s.taxCalculation === "FAILED" ? "FAILED" : inv ? "IN_PROGRESS" : "PENDING", recordId: lineTax[0]?.id ?? null, timestamp: lineTax[0]?.effectiveDate ?? null, error: fail("tax") ?? (s.taxCalculation === "FAILED" ? check("line-tax-records")?.detail ?? "Salesforce's tax doesn't match the configured rate." : null), diagnostic: check("line-tax-records")?.detail ?? null, verification: check("totals")?.detail ?? null },
    { id: "verified", label: "TAX VERIFIED", status: s.complete ? "DONE" : s.endToEnd === "FAILED" ? "FAILED" : "PENDING", recordId: inv?.id ?? null, timestamp: null, error: s.endToEnd === "FAILED" ? s.message : null, diagnostic: `${s.checks.filter(c => c.passed).length}/${s.checks.length} checks`, verification: s.complete ? `Tax Calculation = SUCCESS (${s.message})` : null },
  ];
}
