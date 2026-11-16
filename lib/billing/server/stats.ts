import type { SalesforceClient } from "@/lib/salesforce/client";
import { normalizeApiVersionNumber, soqlEscape } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { BILLING_MODULES, getBillingModule, type BillingModuleDef } from "@/lib/billing/registry";
import { billingDescribeGlobal, resolveModuleFromGlobal } from "@/lib/billing/server/discovery";
import { TAX_DASHBOARD_MODULES, TAX_MODULES } from "@/lib/taxes/modules";
import type { BillingModuleStatus } from "@/lib/billing/types";

interface BatchResult {
  hasErrors: boolean;
  results: { statusCode: number; result: unknown }[];
}

type AggRow = { s?: unknown; c?: number; m?: string | null };

const BATCH_LIMIT = 25;

/**
 * Run several SOQL queries in as few API calls as possible via the Composite
 * Batch resource (up to 25 subrequests per call). Each subrequest succeeds or
 * fails independently, so a query against a field one org doesn't have never
 * sinks the whole dashboard. §REQUEST_LIMIT_EXCEEDED: ~25 billing modules cost
 * 1–2 API calls here instead of 25–50.
 */
async function batchQueries(client: SalesforceClient, soqls: string[]): Promise<({ ok: true; records: AggRow[] } | { ok: false; error: string })[]> {
  const version = `v${normalizeApiVersionNumber(client.apiVersion)}`;
  const out: ({ ok: true; records: AggRow[] } | { ok: false; error: string })[] = [];
  for (let i = 0; i < soqls.length; i += BATCH_LIMIT) {
    const chunk = soqls.slice(i, i + BATCH_LIMIT);
    const res = await client.request<BatchResult>("/composite/batch", {
      method: "POST",
      body: JSON.stringify({ haltOnError: false, batchRequests: chunk.map(q => ({ method: "GET", url: `${version}/query/?q=${encodeURIComponent(q)}` })) }),
    });
    for (const r of res.results) {
      if (r.statusCode >= 200 && r.statusCode < 300) {
        out.push({ ok: true, records: ((r.result as { records?: AggRow[] })?.records ?? []) });
      } else {
        const err = Array.isArray(r.result) ? (r.result[0] as { message?: string })?.message : undefined;
        out.push({ ok: false, error: err ?? `HTTP ${r.statusCode}` });
      }
    }
  }
  return out;
}

function statusLabel(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "No Status";
  if (typeof raw === "boolean") return raw ? "Active" : "Inactive";
  return String(raw);
}

const statsCache = createTTLCache<BillingModuleStatus[]>(30_000);

/** The part of a module definition the counter reads — lets non-billing areas (e.g. Revenue Cloud Core) reuse it. */
export type CountableModuleDef = Pick<BillingModuleDef, "key" | "candidates" | "labelPattern" | "statusFields" | "listFilter" | "viewOnly"> & { group?: BillingModuleDef["group"] };

async function computeModuleStats(client: SalesforceClient, modules: CountableModuleDef[]): Promise<BillingModuleStatus[]> {
  const global = await billingDescribeGlobal(client);
  const resolved = new Map(modules.map(def => [def.key, resolveModuleFromGlobal(def, global)]));

  const base: BillingModuleStatus[] = modules.map(def => {
    const obj = resolved.get(def.key) ?? null;
    return {
      moduleKey: def.key,
      group: def.group ?? "configuration",
      available: !!obj,
      sobject: obj?.sobject ?? null,
      sobjectLabel: obj?.label ?? null,
      candidatesTried: def.candidates,
      // View-only modules (administrative configuration) are never offered for creation, whatever Describe says.
      createable: !def.viewOnly && (obj?.createable ?? false),
      queryable: obj?.queryable ?? false,
      recordCount: null,
      statusBreakdown: null,
      lastModifiedDate: null,
      countError: null,
    };
  });

  // Pass 1: grouped by the first candidate status field (count + breakdown + last-modified in one query).
  // Modules without a status concept, or whose status candidate doesn't exist, fall back to a plain count in pass 2.
  const queryable = base.filter(s => s.available && s.queryable && s.sobject);
  const defOf = (key: string) => modules.find(d => d.key === key)!;
  // Fixed list filters (e.g. only Revenue Standard Tax decision tables) apply to the counts too.
  const whereOf = (key: string) => { const f = defOf(key).listFilter ?? []; return f.length ? ` WHERE ${f.map(x => `${x.field} = '${soqlEscape(x.value)}'`).join(" AND ")}` : ""; };
  const grouped = queryable.filter(s => defOf(s.moduleKey).statusFields.length > 0);
  const groupedSoql = grouped.map(s => {
    const statusField = defOf(s.moduleKey).statusFields[0];
    return `SELECT ${statusField} s, COUNT(Id) c, MAX(LastModifiedDate) m FROM ${s.sobject}${whereOf(s.moduleKey)} GROUP BY ${statusField}`;
  });
  const groupedResults = groupedSoql.length ? await batchQueries(client, groupedSoql) : [];

  const needsPlain: BillingModuleStatus[] = queryable.filter(s => !grouped.includes(s));
  grouped.forEach((s, i) => {
    const r = groupedResults[i];
    if (r?.ok) {
      s.statusBreakdown = r.records.map(row => ({ status: statusLabel(row.s), count: row.c ?? 0 }));
      s.recordCount = s.statusBreakdown.reduce((sum, b) => sum + b.count, 0);
      s.lastModifiedDate = r.records.map(row => row.m ?? null).filter((v): v is string => !!v).sort().pop() ?? null;
    } else {
      needsPlain.push(s);
    }
  });

  const plainResults = needsPlain.length
    ? await batchQueries(client, needsPlain.map(s => `SELECT COUNT(Id) c, MAX(LastModifiedDate) m FROM ${s.sobject}${whereOf(s.moduleKey)}`))
    : [];
  needsPlain.forEach((s, i) => {
    const r = plainResults[i];
    if (r?.ok) {
      s.recordCount = r.records[0]?.c ?? 0;
      s.lastModifiedDate = r.records[0]?.m ?? null;
    } else {
      s.countError = r?.error ?? "Count unavailable";
    }
  });

  return base;
}

export async function getBillingStats(client: SalesforceClient, opts: { fresh?: boolean } = {}): Promise<BillingModuleStatus[]> {
  const key = `${client.cacheScope}:${client.apiVersion}`;
  if (opts.fresh) statsCache.clear(key);
  return statsCache.getOrCompute(key, () => computeModuleStats(client, BILLING_MODULES));
}

/** The Taxes section's cards: the tax modules plus the shared Legal Entities module — counts read live from Salesforce. */
export async function getTaxModuleStats(client: SalesforceClient, opts: { fresh?: boolean } = {}): Promise<BillingModuleStatus[]> {
  const key = `${client.cacheScope}:${client.apiVersion}:taxes`;
  if (opts.fresh) statsCache.clear(key);
  const defs = [...TAX_MODULES, ...TAX_DASHBOARD_MODULES.filter(k => !TAX_MODULES.some(m => m.key === k)).map(k => getBillingModule(k)).filter((d): d is BillingModuleDef => !!d)];
  return statsCache.getOrCompute(key, () => computeModuleStats(client, defs));
}

/**
 * Counts for any set of module definitions — same Describe-resolved, Composite-Batch, 30s-cached path as the Billing
 * dashboard. Objects the org doesn't have come back `available: false`; a failed count is `countError`, never a fake 0.
 */
export async function getObjectCountStats(client: SalesforceClient, defs: CountableModuleDef[], cacheSuffix: string, opts: { fresh?: boolean } = {}): Promise<BillingModuleStatus[]> {
  const key = `${client.cacheScope}:${client.apiVersion}:${cacheSuffix}`;
  if (opts.fresh) statsCache.clear(key);
  return statsCache.getOrCompute(key, () => computeModuleStats(client, defs));
}

export function clearBillingStatsCache(): void {
  statsCache.clear();
}
