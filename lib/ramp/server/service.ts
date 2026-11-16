import { generateSchedule, isIsoDate, validateSchedule } from "@/lib/ramp/schedule";
import { canResume, markInterrupted, newExecution, nextStep, resetForRetry } from "@/lib/ramp/execution";
import type { HistoryEvent, HistoryKind, RampDealDraft, RampExecution, RampSchedule } from "@/lib/ramp/types";
import { historyEvent, newId, type RampStore } from "./store";
import { runNextStep, realDeps, type RunDeps } from "./runner";
import type { RampApi } from "./api";

/**
 * RAMP application service — schedules, deals, executions and history in the server-side store (per Salesforce org). Salesforce
 * writes happen ONLY in executions (runner.ts) and Product Ramp Segment creation, each after an explicit confirmation.
 */
export class RampServiceError extends Error {}

type Ctx = { store: RampStore; orgId: string; userId: string | null };
const now = () => new Date().toISOString();
const ev = (ctx: Ctx, kind: HistoryKind, action: string, status: HistoryEvent["status"], summary: string, refs: HistoryEvent["refs"], detail?: unknown) =>
  historyEvent({ kind, action, status, summary, orgId: ctx.orgId, userId: ctx.userId, refs, detail });

/* ── schedules (application templates — Salesforce has no ramp schedule object) ── */

export async function saveSchedule(ctx: Ctx, input: Partial<RampSchedule>): Promise<RampSchedule> {
  const errors = validateSchedule(input);
  if (errors.length) throw new RampServiceError(errors.join(" "));
  return ctx.store.update(ctx.orgId, d => {
    const t = now();
    const existing = input.id ? d.schedules.find(s => s.id === input.id) : undefined;
    if (input.id && !existing) throw new RampServiceError("That schedule no longer exists.");
    if (d.schedules.some(s => s.id !== input.id && s.name.trim().toLowerCase() === input.name!.trim().toLowerCase())) throw new RampServiceError(`A schedule named "${input.name}" already exists.`);
    const s: RampSchedule = {
      id: existing?.id ?? newId("sch"), name: input.name!.trim(), description: input.description?.trim() || null, period: input.period!, customMonths: input.period === "Custom" ? input.customMonths ?? null : null,
      segments: input.segments!, trialMonths: input.trialMonths ?? null, priceChange: input.priceChange ?? "percent", defaultChange: input.defaultChange ?? null,
      upliftMethod: input.upliftMethod!, basePriceMultiplier: input.basePriceMultiplier ?? 1, overrides: (input.overrides ?? []).filter(o => o.segment >= 1 && o.segment <= input.segments!),
      createdAt: existing?.createdAt ?? t, updatedAt: t, createdBy: existing?.createdBy ?? ctx.userId, version: (existing?.version ?? 0) + 1,
    };
    d.schedules = existing ? d.schedules.map(x => (x.id === s.id ? s : x)) : [...d.schedules, s];
    d.history.push(ev(ctx, "schedule", existing ? "updated" : "created", "success", `${existing ? "Updated" : "Created"} schedule "${s.name}" (v${s.version}, ${s.segments} × ${s.period}${s.period === "Custom" ? ` ${s.customMonths} months` : ""}, ${s.upliftMethod}).`, { scheduleId: s.id }, s));
    return s;
  });
}

export async function deleteSchedule(ctx: Ctx, id: string): Promise<void> {
  await ctx.store.update(ctx.orgId, d => {
    const s = d.schedules.find(x => x.id === id);
    if (!s) throw new RampServiceError("That schedule no longer exists.");
    d.schedules = d.schedules.filter(x => x.id !== id);
    d.history.push(ev(ctx, "schedule", "deleted", "info", `Deleted schedule "${s.name}" (deals keep their own copy).`, { scheduleId: id }));
  });
}

/* ── deals ── */

export function validateDeal(d: Partial<RampDealDraft>): string[] {
  const e: string[] = [];
  if (!d.name?.trim()) e.push("Name the ramp deal.");
  if (d.kind !== "line" && d.kind !== "group") e.push("Choose a line or group ramp.");
  if (!d.quoteId) e.push("Select a Draft quote.");
  if (d.kind === "line" && !d.lineId) e.push("Select the quote line to ramp.");
  if (d.kind === "group" && !d.groupId) e.push("Select the quote line group to ramp.");
  if (!isIsoDate(d.contractStart) || !isIsoDate(d.contractEnd)) e.push("Set the contract start and end dates.");
  if (d.schedule) e.push(...validateSchedule({ ...d.schedule, name: d.schedule.name || d.name || "x" }));
  else e.push("Choose or configure a ramp schedule.");
  if (!e.length) {
    const p = generateSchedule(d.schedule!, { contractStart: d.contractStart!, contractEnd: d.contractEnd!, basePrice: d.basePrice ?? 0, baseQuantity: d.baseQuantity ?? 1 });
    e.push(...p.issues.filter(i => i.severity === "error").map(i => i.message));
  }
  return e;
}

export async function saveDeal(ctx: Ctx, input: Partial<RampDealDraft>): Promise<RampDealDraft> {
  const errors = validateDeal(input);
  if (errors.length) throw new RampServiceError(errors.join(" "));
  return ctx.store.update(ctx.orgId, d => {
    const t = now();
    const existing = input.id ? d.deals.find(x => x.id === input.id) : undefined;
    if (input.id && !existing) throw new RampServiceError("That deal no longer exists.");
    if (existing?.executionId) {
      const ex = d.executions.find(x => x.id === existing.executionId);
      if (ex && ex.steps.some(s => s.wrote)) throw new RampServiceError("This deal has already written to Salesforce — its execution can be resumed, but the deal can't be edited. Create a new deal for different values.");
    }
    // One active deal per quote line / group (a second would race the same Salesforce records).
    const clash = d.deals.find(x => x.id !== input.id && x.quoteId === input.quoteId && ((input.kind === "line" && x.lineId === input.lineId) || (input.kind === "group" && x.groupId === input.groupId)) && d.executions.find(ex => ex.id === x.executionId && ex.status !== "completed" && ex.status !== "failed"));
    if (clash) throw new RampServiceError(`Deal "${clash.name}" is already running for this ${input.kind === "line" ? "quote line" : "group"}.`);
    const deal: RampDealDraft = {
      id: existing?.id ?? newId(input.kind === "group" ? "grd" : "rd"), kind: input.kind!, name: input.name!.trim(),
      accountId: input.accountId ?? null, accountName: input.accountName ?? null, quoteId: input.quoteId!, quoteName: input.quoteName ?? null,
      lineId: input.kind === "line" ? input.lineId! : null, groupId: input.kind === "group" ? input.groupId! : null, groupName: input.groupName ?? null,
      productId: input.productId ?? null, productName: input.productName ?? null, sellingModelId: input.sellingModelId ?? null, scheduleId: input.scheduleId ?? null,
      schedule: input.schedule!, contractStart: input.contractStart!, contractEnd: input.contractEnd!, basePrice: input.basePrice ?? 0, baseQuantity: input.baseQuantity ?? 1,
      periodBoundary: input.periodBoundary ?? "Anniversary", createdAt: existing?.createdAt ?? t, updatedAt: t, createdBy: existing?.createdBy ?? ctx.userId, orgId: ctx.orgId, executionId: existing?.executionId ?? null,
    };
    d.deals = existing ? d.deals.map(x => (x.id === deal.id ? deal : x)) : [...d.deals, deal];
    d.history.push(ev(ctx, deal.kind === "group" ? "group-deal" : "deal", existing ? "updated" : "created", "success", `${existing ? "Updated" : "Created"} ${deal.kind} ramp deal "${deal.name}" on ${deal.quoteName ?? deal.quoteId}.`, { dealId: deal.id, quoteId: deal.quoteId, accountId: deal.accountId, productId: deal.productId, lineId: deal.lineId, groupId: deal.groupId, scheduleId: deal.scheduleId }, deal));
    return deal;
  });
}

export async function deleteDeal(ctx: Ctx, id: string): Promise<void> {
  await ctx.store.update(ctx.orgId, d => {
    const deal = d.deals.find(x => x.id === id);
    if (!deal) throw new RampServiceError("That deal no longer exists.");
    const ex = deal.executionId ? d.executions.find(x => x.id === deal.executionId) : null;
    if (ex && ex.steps.some(s => s.wrote)) throw new RampServiceError("This deal wrote to Salesforce, so it stays in history. (Salesforce records are never deleted by the app.)");
    d.deals = d.deals.filter(x => x.id !== id);
    d.history.push(ev(ctx, deal.kind === "group" ? "group-deal" : "deal", "deleted", "info", `Deleted draft deal "${deal.name}" (nothing had been written to Salesforce).`, { dealId: id, quoteId: deal.quoteId }));
  });
}

/* ── executions ── */

export async function startExecution(ctx: Ctx, dealId: string, confirmed: boolean): Promise<RampExecution> {
  if (!confirmed) throw new RampServiceError("Executing writes to Salesforce — confirm it first (confirmed: true).");
  return ctx.store.update(ctx.orgId, d => {
    const deal = d.deals.find(x => x.id === dealId);
    if (!deal) throw new RampServiceError("That deal no longer exists.");
    const existing = deal.executionId ? d.executions.find(x => x.id === deal.executionId) : null;
    if (existing && existing.status !== "failed") return existing; // already started — resume it, never start a second run
    if (existing?.steps.some(s => s.wrote)) return existing; // a failed run that wrote must be resumed (retried), not restarted
    const ex = newExecution({ id: newId("ex"), dealId, kind: deal.kind, orgId: ctx.orgId, userId: ctx.userId, quoteId: deal.quoteId, lineId: deal.lineId, groupId: deal.groupId, now: now() });
    d.executions.push(ex);
    d.deals = d.deals.map(x => (x.id === dealId ? { ...x, executionId: ex.id } : x));
    d.history.push(ev(ctx, "execution", "started", "info", `Started ${deal.kind} ramp execution for "${deal.name}".`, { dealId, executionId: ex.id, quoteId: deal.quoteId, lineId: deal.lineId, groupId: deal.groupId, productId: deal.productId }));
    return ex;
  });
}

/** Loading an execution whose step was still "running" (the server stopped mid-step) marks it interrupted. */
export async function getExecution(ctx: Ctx, id: string): Promise<RampExecution> {
  const d = await ctx.store.load(ctx.orgId);
  const ex = d.executions.find(x => x.id === id);
  if (!ex) throw new RampServiceError("That execution no longer exists.");
  const stale = ex.steps.some(s => s.status === "running" && s.startedAt && Date.now() - Date.parse(s.startedAt) > 120_000);
  if (!stale) return ex;
  return ctx.store.update(ctx.orgId, dd => {
    const m = markInterrupted(dd.executions.find(x => x.id === id)!, now());
    dd.executions = dd.executions.map(x => (x.id === id ? m : x));
    return m;
  });
}

/** Run the next step (one per request) and persist the checkpoint — with a history record at the end of every step. */
export async function stepExecution(ctx: Ctx, api: RampApi, id: string, deps: RunDeps = realDeps): Promise<RampExecution> {
  const d = await ctx.store.load(ctx.orgId);
  let ex = d.executions.find(x => x.id === id);
  if (!ex) throw new RampServiceError("That execution no longer exists.");
  const deal = d.deals.find(x => x.id === ex!.dealId);
  if (!deal) throw new RampServiceError("The execution's deal no longer exists.");
  if (ex.status === "completed") return ex;
  if (ex.status === "failed") throw new RampServiceError("The execution failed — use Retry to re-run the failed step.");
  const step = nextStep(ex);
  if (!step) return ex;
  // Checkpoint "running" first, so a crash mid-step is detected as an interruption on the next load.
  ex = await ctx.store.update(ctx.orgId, dd => { const cur = dd.executions.find(x => x.id === id)!; const m = { ...cur, steps: cur.steps.map(s => (s.id === step.id ? { ...s, status: "running" as const, startedAt: s.startedAt ?? deps.now() } : s)) }; dd.executions = dd.executions.map(x => (x.id === id ? m : x)); return m; });
  const out = await runNextStep(api, deal, ex, deps);
  return ctx.store.update(ctx.orgId, dd => {
    dd.executions = dd.executions.map(x => (x.id === id ? out : x));
    const s = out.steps.find(x => x.id === step.id)!;
    if (s.status !== "waiting") {
      dd.history.push(ev(ctx, step.id === "price" ? "pricing" : step.id === "verify" ? "verification" : "execution", step.id, s.status === "failed" ? "failed" : "success", `${deal.name}: ${s.label} — ${s.message ?? s.status}`, { dealId: deal.id, executionId: id, quoteId: deal.quoteId, lineId: deal.lineId, groupId: deal.groupId, productId: deal.productId, salesforceId: out.sf.rampIdentifier ?? out.sf.contextId ?? null }, { calls: s.calls.slice(-5), verification: step.id === "verify" ? out.verification : undefined }));
    }
    if (out.status === "completed") dd.history.push(ev(ctx, deal.kind === "group" ? "group-deal" : "deal", "completed", "success", `${deal.name}: ramp created, priced and verified in Salesforce.`, { dealId: deal.id, executionId: id, quoteId: deal.quoteId, salesforceId: out.sf.rampIdentifier ?? out.sf.segmentGroupIds[0] ?? null }));
    return out;
  });
}

export async function retryExecution(ctx: Ctx, id: string): Promise<RampExecution> {
  return ctx.store.update(ctx.orgId, d => {
    const ex = d.executions.find(x => x.id === id);
    if (!ex) throw new RampServiceError("That execution no longer exists.");
    if (!canResume(ex)) throw new RampServiceError(ex.status === "completed" ? "The execution is complete." : "Nothing to retry yet.");
    const m = resetForRetry(markInterrupted(ex, now()), now());
    d.executions = d.executions.map(x => (x.id === id ? m : x));
    d.history.push(ev(ctx, "execution", "retry", "info", `Retry requested at step "${nextStep(m)?.label ?? "—"}".`, { executionId: id, dealId: ex.dealId }));
    return m;
  });
}

/* ── history ── */

export interface HistoryFilter { kind?: string | null; status?: string | null; q?: string | null; from?: string | null; to?: string | null; quoteId?: string | null; accountId?: string | null; productId?: string | null; dealId?: string | null; salesforceId?: string | null; page?: number; pageSize?: number }
export function filterHistory(events: HistoryEvent[], f: HistoryFilter) {
  const q = f.q?.trim().toLowerCase();
  const rows = events.filter(e =>
    (!f.kind || e.kind === f.kind) && (!f.status || e.status === f.status) && (!f.from || e.at >= f.from) && (!f.to || e.at <= `${f.to}T23:59:59.999Z`) &&
    (!f.quoteId || e.refs.quoteId === f.quoteId) && (!f.accountId || e.refs.accountId === f.accountId) && (!f.productId || e.refs.productId === f.productId) &&
    (!f.dealId || e.refs.dealId === f.dealId) && (!f.salesforceId || Object.values(e.refs).some(v => v === f.salesforceId)) &&
    (!q || `${e.summary} ${e.action} ${Object.values(e.refs).filter(Boolean).join(" ")}`.toLowerCase().includes(q)),
  ).sort((a, b) => b.at.localeCompare(a.at));
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(f.page ?? 1, 1), pageCount);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageCount };
}

export async function recordEvent(ctx: Ctx, e: Omit<HistoryEvent, "id" | "at" | "orgId" | "userId">): Promise<void> {
  await ctx.store.update(ctx.orgId, d => { d.history.push(historyEvent({ ...e, orgId: ctx.orgId, userId: ctx.userId })); });
}
