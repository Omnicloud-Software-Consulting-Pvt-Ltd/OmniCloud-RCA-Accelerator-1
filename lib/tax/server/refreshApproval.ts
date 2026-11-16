import { soqlEscape } from "@/lib/salesforce/client";
import { effectiveRefresh } from "@/lib/tax/server/engine";
import { ensureDecisionTableFresh } from "@/lib/tax/server/pipeline";
import type { TaxRuntimeApi } from "@/lib/tax/server/runtime";
import { BadInputError, NotFoundError } from "@/lib/billing/server/payments";

/**
 * DECISION-TABLE REFRESH — an explicit, separately approved administrative step (never part of a tax calculation request).
 *
 *  · No engine        → the decision tables of the org's engines with their freshness (read-only).
 *  · engine, no token → preview: the table Salesforce uses for that engine, its last full / incremental refresh, the newest Tax Rate
 *                       change, the other engines that share it, and the exact confirmation token (read-only).
 *  · engine + token   → Salesforce's refreshDecisionTable action (ensureDecisionTableFresh, refresh "approved"), then waits for
 *                       Salesforce to report the sync. The token names the table, so an approval can't be replayed for another one.
 * A table that is already current is never refreshed. Nothing else (table definition, engine assignment) is ever changed.
 */

export interface RefreshTableView {
  engine: { id: string; name: string } | null;
  decisionTable: { id: string; name: string; setupName: string | null; status: string | null; refreshStatus: string | null; lastFullRefresh: string | null; lastIncrementalRefresh: string | null; incrementalFailed: boolean; source: "engine" | "system" };
  lastSuccessfulRefresh: string | null;
  newestRateChange: string | null;
  stale: boolean;
  /** Tax Rates created or changed after the last successful refresh — Salesforce's lookup doesn't see them yet. */
  ratesChangedAfterRefresh: { id: string; name: string; changedAt: string | null }[];
  sharedWith: { id: string; name: string }[];
}
export type RefreshResult =
  | { mode: "list"; tables: RefreshTableView[] }
  | { mode: "preview"; table: RefreshTableView; needsRefresh: boolean; confirmation: string | null; message: string }
  | { mode: "refresh"; table: RefreshTableView; state: "Ready" | "Refreshing" | "Failed" | "Not Ready"; refreshed: boolean; message: string };

export const refreshToken = (decisionTableId: string) => `refresh-decision-table:${decisionTableId.slice(0, 15)}`;
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

async function view(api: TaxRuntimeApi, engine: { id: string; name: string } | null): Promise<RefreshTableView | null> {
  const dt = await api.decisionTable(engine?.id ?? null);
  if (!dt) return null;
  const [newest] = await api.query("SELECT LastModifiedDate FROM TaxRate ORDER BY LastModifiedDate DESC LIMIT 1");
  const refreshedAt = effectiveRefresh(dt.lastSync, dt.lastIncrementalSync, dt.incrementalFailed);
  // SOQL datetime literal: unquoted ISO-8601 (Salesforce returns "…+0000", which SOQL accepts as Z only).
  const since = refreshedAt ? new Date(refreshedAt).toISOString().replace(/.d{3}Z$/, "Z") : null;
  const changed = await api.query(`SELECT Id, Name, LastModifiedDate FROM TaxRate${since ? ` WHERE LastModifiedDate > ${since}` : ""} ORDER BY LastModifiedDate DESC LIMIT 50`);
  const shared = dt.source === "engine" ? await api.query(`SELECT Id, TaxEngineName FROM TaxEngine WHERE DecisionTableId = '${soqlEscape(dt.id)}'`) : [];
  return {
    engine,
    decisionTable: { id: dt.id, name: dt.name, setupName: dt.setupName, status: dt.status, refreshStatus: dt.refreshStatus, lastFullRefresh: dt.lastSync, lastIncrementalRefresh: dt.lastIncrementalSync ?? null, incrementalFailed: !!dt.incrementalFailed, source: dt.source },
    lastSuccessfulRefresh: refreshedAt,
    newestRateChange: typeof newest?.LastModifiedDate === "string" ? newest.LastModifiedDate : null,
    stale: dt.stale,
    ratesChangedAfterRefresh: changed.map(r => ({ id: String(r.Id), name: String(r.Name ?? r.Id), changedAt: typeof r.LastModifiedDate === "string" ? r.LastModifiedDate : null })),
    sharedWith: shared.filter(e => !engine || String(e.Id).slice(0, 15) !== engine.id.slice(0, 15)).map(e => ({ id: String(e.Id), name: String(e.TaxEngineName ?? e.Id) })),
  };
}

export async function decisionTableRefresh(api: TaxRuntimeApi, input: { engineId?: string | null; confirm?: string | null }, opts: { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {}): Promise<RefreshResult> {
  if (!input.engineId) {
    const engines = await api.query("SELECT Id, TaxEngineName FROM TaxEngine WHERE Status = 'Active' AND DecisionTableId != null ORDER BY TaxEngineName");
    const seen = new Set<string>();
    const tables: RefreshTableView[] = [];
    for (const e of engines) {
      const v = await view(api, { id: String(e.Id), name: String(e.TaxEngineName ?? e.Id) });
      if (v && !seen.has(v.decisionTable.id)) { seen.add(v.decisionTable.id); tables.push(v); }
    }
    return { mode: "list", tables };
  }
  if (!SFID.test(input.engineId)) throw new BadInputError("engineId isn't a valid Salesforce Id.");
  const [e] = await api.query(`SELECT Id, TaxEngineName FROM TaxEngine WHERE Id = '${soqlEscape(input.engineId)}'`);
  if (!e) throw new NotFoundError(`Tax Engine ${input.engineId} doesn't exist in the connected org.`);
  const engine = { id: String(e.Id), name: String(e.TaxEngineName ?? e.Id) };
  const table = await view(api, engine);
  if (!table) throw new NotFoundError(`No Revenue Standard Tax decision table is available for Tax Engine "${engine.name}".`);
  const token = refreshToken(table.decisionTable.id);
  const shared = table.sharedWith.length ? ` It is shared with ${table.sharedWith.map(s => s.name).join(", ")} — the refresh affects their lookups too.` : "";
  if (input.confirm !== token) {
    if (input.confirm) throw new BadInputError(`The confirmation doesn't match decision table ${table.decisionTable.name} — nothing was refreshed.`);
    return table.stale
      ? { mode: "preview", table, needsRefresh: true, confirmation: token, message: `${table.decisionTable.name} is stale: a Tax Rate changed at ${table.newestRateChange ?? "—"}, after its last successful refresh (${table.lastSuccessfulRefresh ?? "never"}). Approve the refresh to ask Salesforce to re-sync it.${shared}` }
      : { mode: "preview", table, needsRefresh: false, confirmation: null, message: `${table.decisionTable.name} is current (last successful refresh ${table.lastSuccessfulRefresh ?? "—"}, newest Tax Rate change ${table.newestRateChange ?? "—"}). No refresh is needed.` };
  }
  if (!table.stale) return { mode: "refresh", table, state: "Ready", refreshed: false, message: `${table.decisionTable.name} is already current — it wasn't refreshed.` };
  const r = await ensureDecisionTableFresh(api, { engineId: engine.id, refresh: "approved", sleep: opts.sleep, maxWaitMs: opts.maxWaitMs });
  const after = (await view(api, engine)) ?? table;
  return { mode: "refresh", table: after, state: r.state, refreshed: r.refreshed, message: r.reason };
}
