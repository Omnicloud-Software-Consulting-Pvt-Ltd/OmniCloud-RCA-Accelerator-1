import type { AssetFacts, AssetReason, AssetState, LifecycleKind } from "./types";

/**
 * Asset lifecycle state + eligibility — PURE (no Salesforce calls). The server feeds it facts read from the connected org; the UI
 * shows the same reasons, so every block is explained with the Salesforce value that caused it. Rules that Salesforce documents
 * (quote-first for usage assets, one price book per cancellation request, renewal start date ≥ today for expired assets) are
 * errors; behaviour Salesforce decides at run time is a warning, never a guess that blocks.
 */

export const EXPIRING_DAYS = 90;

export const day = (v: string | null | undefined) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);
export const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** date + n months − 1 day (a term of n months starting on `date`). */
export function termEnd(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return addDays(target.toISOString().slice(0, 10), -1);
}
/** Whole days from a to b (b − a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const wasCancelled = (a: AssetFacts) => /^cancel$/i.test(a.lastAction?.type ?? "") || /cancellation/i.test(a.lastAction?.category ?? "");

export function assetState(a: AssetFacts, today: string, expiringDays = EXPIRING_DAYS): AssetState {
  if (!a.hasLifecycle) return "unmanaged";
  const start = day(a.lifecycleStart), end = day(a.lifecycleEnd);
  if (wasCancelled(a)) return "cancelled";
  if (end && end < today) return "expired";
  if (a.quantity !== null && a.quantity <= 0) return "cancelled";
  if (start && start > today) return "future";
  if (end && end <= addDays(today, expiringDays)) return "expiring";
  return "active";
}

export interface EligibilityCtx { accountId: string | null; contractId: string | null; effectiveDate: string | null; today: string }

const label = (a: AssetFacts) => a.name;
const modelType = (a: AssetFacts) => a.sellingModel?.type ?? null;

/** Rules shared by every lifecycle. */
function common(a: AssetFacts, ctx: EligibilityCtx, kind: LifecycleKind): AssetReason[] {
  const r: AssetReason[] = [];
  const err = (code: string, message: string) => r.push({ code, severity: "error", message });
  if (!a.hasLifecycle) err("NOT_LIFECYCLE", `${label(a)} isn't lifecycle-managed (Asset.HasLifecycleManagement = false). Only assets created through Revenue Cloud's order-to-asset process can be amended, renewed or cancelled.`);
  else if (a.lifecycleActions === 0) err("NO_LIFECYCLE_HISTORY", `${label(a)} has no Asset Action records, so it wasn't created through the Revenue Cloud lifecycle.`);
  if (ctx.accountId && a.accountId && a.accountId !== ctx.accountId) err("OTHER_ACCOUNT", `${label(a)} belongs to a different account.`);
  if (ctx.contractId && !a.contracts.some(c => c.id === ctx.contractId)) err("NOT_ON_CONTRACT", `${label(a)} isn't related to the selected contract (no Asset Contract Relationship, contract on its origin order, or pricing contract).`);
  if (a.parentId) err("CHILD_ASSET", `${label(a)} is a bundle component. Select its root asset (${a.rootId ?? a.parentId}): Salesforce processes the components with it, which keeps the parent–child structure.`);
  for (const o of a.open) err("OPEN_TRANSACTION", `${label(a)} already has an open ${o.type ?? "lifecycle"} quote ${o.quoteNumber ?? o.quoteId} (${o.status ?? "status unknown"})${/order/.test(o.status ?? "") ? "" : " with no order"}. Finish (activate) or discard it in Salesforce first, or a second ${kind === "amend" ? "amendment" : kind === "renew" ? "renewal" : "cancellation"} would conflict with it.`);
  if (a.usage.usageBased) r.push({ code: "USAGE_QUOTE_FIRST", severity: "warning", message: `${label(a)} is usage-based (${a.usage.reason}). It goes through a Salesforce quote first, never a direct order, so its rate card and usage grants are carried over.` });
  if (a.childIds.length) r.push({ code: "BUNDLE_ROOT", severity: "warning", message: `${label(a)} is a bundle with ${a.childIds.length} component asset(s); Salesforce includes the components in the same transaction.` });
  return r;
}

function dateRules(a: AssetFacts, ctx: EligibilityCtx, what: string): AssetReason[] {
  const r: AssetReason[] = [];
  const start = day(a.lifecycleStart), end = day(a.lifecycleEnd), last = day(a.lastAction?.date);
  if (ctx.effectiveDate && last && ctx.effectiveDate < last) r.push({ code: "BEFORE_LAST_CHANGE", severity: "warning", message: `The ${what} date ${ctx.effectiveDate} is before ${label(a)}'s last lifecycle change (${a.lastAction?.type ?? "action"} on ${last}). Salesforce may reject a back-dated change; the quote it builds is what counts.` });
  if (ctx.effectiveDate) {
    if (start && ctx.effectiveDate < start) r.push({ code: "BEFORE_START", severity: "error", message: `The ${what} date ${ctx.effectiveDate} is before ${label(a)}'s lifecycle start (${start}).` });
    if (end && ctx.effectiveDate > end) r.push({ code: "AFTER_END", severity: "error", message: `The ${what} date ${ctx.effectiveDate} is after ${label(a)}'s lifecycle end (${end}).` });
  }
  return r;
}

export function assetEligibility(a: AssetFacts, kind: LifecycleKind, ctx: EligibilityCtx): AssetReason[] {
  const r = common(a, ctx, kind);
  if (!a.hasLifecycle) return r;
  const err = (code: string, message: string) => r.push({ code, severity: "error", message });
  const warn = (code: string, message: string) => r.push({ code, severity: "warning", message });
  const end = day(a.lifecycleEnd);
  const state = assetState(a, ctx.today);
  if (kind === "amend") {
    if (state === "cancelled") err("CANCELLED", `${label(a)} is cancelled (current quantity ${a.quantity ?? "unknown"}${a.lastAction?.type ? `, last action ${a.lastAction.type}` : ""}).`);
    else if (a.quantity === null || a.quantity <= 0) err("NO_QUANTITY", `${label(a)} has a current quantity of ${a.quantity ?? "unknown"}.`);
    if (end && end < ctx.today) err("ENDED", `${label(a)}'s lifecycle ended on ${end}. Renew it instead.`);
    r.push(...dateRules(a, ctx, "amendment"));
  } else if (kind === "renew") {
    const t = modelType(a);
    if (state === "cancelled") err("CANCELLED", `${label(a)} was cancelled${a.lastAction?.date ? ` (${day(a.lastAction.date)})` : ""}; a cancelled asset isn't renewed.`);
    if (t === "OneTime") err("ONE_TIME", `${label(a)} uses a One-Time selling model (${a.sellingModel?.name ?? "One-Time"}): there's no term to renew.`);
    else if (t === "Evergreen") err("EVERGREEN", `${label(a)} uses an Evergreen selling model (${a.sellingModel?.name ?? "Evergreen"}): it continues until cancelled, so there's no term to renew.`);
    else if (!end) err("NO_END_DATE", `${label(a)} has no lifecycle end date (Asset.LifecycleEndDate is empty), so there's no term to renew.`);
    if (a.usage.usageBased) warn("USAGE_RENEWAL", `${label(a)} is usage-based: Salesforce carries its rate card and usage grants onto the renewal quote — review them on the quote before ordering.`);
    if (end && end < ctx.today && state !== "cancelled") {
      if ((a.quantity ?? 0) <= 0) warn("EXPIRED_QUANTITY", `${label(a)}'s current quantity is ${a.quantity ?? "unknown"} after expiry; Salesforce decides the renewed quantity from its last state period — check it on the renewal quote.`);
      warn("EXPIRED", `${label(a)} expired on ${end}. Salesforce needs a renewal start date of today or later for expired assets.`);
      if (ctx.effectiveDate && ctx.effectiveDate < ctx.today) err("START_IN_PAST", `The renewal start ${ctx.effectiveDate} is in the past; expired assets renew from today (${ctx.today}) or later.`);
    }
    if (ctx.effectiveDate && end && ctx.effectiveDate > addDays(end, 1) && end >= ctx.today) warn("GAP", `The renewal starts ${ctx.effectiveDate}, leaving a gap after ${label(a)} ends on ${end}.`);
  } else {
    if (state === "cancelled") err("ALREADY_CANCELLED", `${label(a)} is already cancelled (current quantity ${a.quantity ?? "unknown"}${a.lastAction?.type ? `, last action ${a.lastAction.type}` : ""}).`);
    else if (a.quantity === null || a.quantity <= 0) err("NO_QUANTITY", `${label(a)} has a current quantity of ${a.quantity ?? "unknown"}: nothing to cancel.`);
    if (end && end < ctx.today) err("ENDED", `${label(a)}'s lifecycle already ended on ${end}.`);
    r.push(...dateRules(a, ctx, "cancellation"));
    if (modelType(a) === "OneTime") warn("ONE_TIME", `${label(a)} is a One-Time purchase: there's no recurring charge to stop. Salesforce decides whether it can be cancelled.`);
  }
  return r;
}

export const blocking = (reasons: AssetReason[]) => reasons.filter(r => r.severity === "error");
