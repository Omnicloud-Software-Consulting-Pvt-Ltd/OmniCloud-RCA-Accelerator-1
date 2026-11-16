import type { RampApi } from "@/lib/ramp/server/api";
import { ID } from "@/lib/ramp/server/api";
import { isIsoDate } from "../eligibility";
import { blankSteps, hasLineEdits, snapshotOf, validateTransaction } from "../plan";
import { cleanAddress } from "../billing";
import { KIND_LABEL, LIFECYCLE_KINDS, type AddedProduct, type AssetChange, type AttributeChange, type AuditEvent, type BillingDetails, type CancelOptions, type PolicyResolution, type TreatmentResolution, type LifecycleKind, type LifecycleTransaction, type RenewalOptions, type StepId } from "../types";
import { LifecycleError, runStep, type LifecycleDeps, type StepOptions } from "./lifecycle";
import { assetAttributes, assetFactsByIds, discoverReasonFields, lifecycleCapabilities } from "./reads";
import { newId, type LifecycleStore } from "./store";

/** Lifecycle service: transactions, step execution and the audit trail — per org, per user, server-side. */
export interface LifecycleCtx { api: RampApi; orgId: string; userId: string | null; store: LifecycleStore }
export class LifecycleInputError extends Error {}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const id = (v: unknown, label: string) => { if (typeof v !== "string" || !ID.test(v)) throw new LifecycleInputError(`${label} must be a Salesforce Id.`); return v; };
const optId = (v: unknown, label: string) => (v === null || v === undefined || v === "" ? null : id(v, label));
export const parseKind = (v: unknown): LifecycleKind => { if (typeof v === "string" && (LIFECYCLE_KINDS as string[]).includes(v)) return v as LifecycleKind; throw new LifecycleInputError("kind must be amend, renew or cancel."); };

function parseChange(v: unknown): AssetChange {
  const o = (v ?? {}) as Record<string, unknown>;
  const sw = o.swap && typeof o.swap === "object" ? (o.swap as Record<string, unknown>) : null;
  const attrs: AttributeChange[] = Array.isArray(o.attributes) ? o.attributes.map(a => { const x = (a ?? {}) as Record<string, unknown>; return { definitionId: id(x.definitionId, "attribute definitionId"), name: str(x.name) ?? "", value: typeof x.value === "string" ? x.value : "", picklistValueId: optId(x.picklistValueId, "picklistValueId") }; }) : [];
  return {
    assetId: id(o.assetId, "assetId"),
    quantityChange: num(o.quantityChange) ?? 0,
    unitPrice: num(o.unitPrice), discount: num(o.discount),
    billingFrequency: str(o.billingFrequency), endDate: str(o.endDate),
    swap: sw ? { kind: sw.kind === "downgrade" ? "downgrade" : sw.kind === "swap" ? "swap" : "upgrade", productId: id(sw.productId, "swap productId"), productName: str(sw.productName) ?? "", pricebookEntryId: id(sw.pricebookEntryId, "swap pricebookEntryId"), quantity: num(sw.quantity) ?? 0, unitPrice: num(sw.unitPrice), outQuantity: num(sw.outQuantity), billingFrequency: str(sw.billingFrequency), endDate: str(sw.endDate) } : null,
    ...(attrs.length ? { attributes: attrs } : {}),
  };
}
function parseAdd(v: unknown): AddedProduct {
  const o = (v ?? {}) as Record<string, unknown>;
  return { productId: id(o.productId, "productId"), productName: str(o.productName) ?? "", pricebookEntryId: id(o.pricebookEntryId, "pricebookEntryId"), quantity: num(o.quantity) ?? 0, unitPrice: num(o.unitPrice), billingFrequency: str(o.billingFrequency), startDate: str(o.startDate), endDate: str(o.endDate) };
}
function parseRenewal(v: unknown): RenewalOptions {
  const o = (v ?? {}) as Record<string, unknown>;
  const r = o.ramp && typeof o.ramp === "object" ? (o.ramp as Record<string, unknown>) : null;
  return {
    endDate: str(o.endDate), termMonths: num(o.termMonths),
    ramp: r ? { segmentType: r.segmentType === "Custom" ? "Custom" : "Yearly", durationInMonths: num(r.durationInMonths) ?? 0, segmentCount: num(r.segmentCount) } : null,
  };
}

/** Bill-To + addresses from the form. Ids are validated; values are only trusted after the order / quote reads them back. */
export function parseBilling(v: unknown): BillingDetails | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const b: BillingDetails = {
    billToContactId: optId(o.billToContactId, "billToContactId"), billToContactName: str(o.billToContactName),
    billingAddress: cleanAddress(o.billingAddress as Record<string, string> | null), shippingAddress: cleanAddress(o.shippingAddress as Record<string, string> | null),
    source: str(o.source),
  };
  for (const a of [b.billingAddress, b.shippingAddress]) for (const [k, x] of Object.entries(a ?? {})) if (typeof x === "string" && x.length > (k === "street" ? 255 : 80)) throw new LifecycleInputError(`Address ${k} is too long.`);
  return b.billToContactId || b.billingAddress || b.shippingAddress ? b : null;
}

export async function audit(ctx: LifecycleCtx, e: Omit<AuditEvent, "id" | "at" | "userId">) {
  await ctx.store.update(ctx.orgId, d => { d.audit.push({ ...e, id: newId("a"), at: new Date().toISOString(), userId: ctx.userId }); });
}

const BLANK_SF = { requestIdentifier: null, quoteId: null, quoteNumber: null, orderId: null, orderNumber: null, initiatedAt: null, activatedAt: null, priceRequestedAt: null, orderRequestedAt: null, initiatedQuantityChange: null };
const sent = (t: LifecycleTransaction) => !!(t.sf.quoteId || t.sf.requestIdentifier || t.sf.initiatedAt);

/**
 * Save (create / update) a transaction. Assets are re-read from Salesforce and their ORIGINAL values snapshotted; the plan is validated
 * (eligibility included). Once initiated, only the quote-line changes stay editable (until the order is requested).
 */
export async function saveTransaction(ctx: LifecycleCtx, input: Record<string, unknown>, today: string): Promise<{ transaction: LifecycleTransaction; errors: string[] }> {
  const kind = parseKind(input.kind);
  const accountId = id(input.accountId, "accountId");
  const assetIds = [...new Set(Array.isArray(input.assetIds) ? input.assetIds.map(a => id(a, "assetId")) : [])];
  const effectiveDate = str(input.effectiveDate) ?? "";
  if (effectiveDate && !isIsoDate(effectiveDate)) throw new LifecycleInputError("effectiveDate must be YYYY-MM-DD.");
  const contractId = optId(input.contractId, "contractId");
  const opportunityId = optId(input.opportunityId, "opportunityId");
  const facts = await assetFactsByIds(ctx.api, assetIds, today);
  const attrs = kind === "amend" ? await assetAttributes(ctx.api, assetIds).catch(() => new Map()) : new Map();
  const assets = assetIds.map(a => facts.get(a)).filter((a): a is NonNullable<typeof a> => !!a).map(a => snapshotOf(a, attrs.get(a.id) ?? []));
  const changes = (Array.isArray(input.changes) ? input.changes : []).map(parseChange).filter(c => assetIds.includes(c.assetId));
  const adds = kind === "amend" ? (Array.isArray(input.adds) ? input.adds : []).map(parseAdd) : [];
  const renewal = kind === "renew" ? parseRenewal(input.renewal) : null;
  let cancel: CancelOptions | null = null;
  if (kind === "cancel") {
    const o = (input.cancel ?? {}) as Record<string, unknown>;
    const fields = await discoverReasonFields(ctx.api);
    const wanted = str(o.reasonField);
    const reasonField = wanted ? fields.find(f => `${f.object}.${f.field}` === wanted) ?? null : null;
    if (wanted && !reasonField) throw new LifecycleInputError(`${wanted} isn't a writable cancellation-reason field in this org.`);
    cancel = { reason: str(o.reason), reasonField };
  }
  const billing = parseBilling(input.billing);
  const amendSubtype = kind === "amend" && input.amendSubtype === "StartDateAdjustment" ? "StartDateAdjustment" as const : null;
  if (amendSubtype && !(await lifecycleCapabilities(ctx.api)).features.startDateAdjustment) throw new LifecycleInputError("This org's initiateAmendment has no actionSubtype input — start-date adjustments aren't available.");
  const now = new Date().toISOString();
  const existingId = str(input.id);

  const tx = await ctx.store.update(ctx.orgId, d => {
    const prev = existingId ? d.transactions.find(x => x.id === existingId) : null;
    if (existingId && !prev) throw new LifecycleInputError("That transaction no longer exists.");
    if (prev && prev.kind !== kind) throw new LifecycleInputError(`That transaction is a ${KIND_LABEL[prev.kind].toLowerCase()}.`);
    if (prev && sent(prev)) {
      // The lifecycle quote exists: its LINE changes can still be modified (re-applied to the quote) until an order is requested.
      // Assets, dates, contract and options are fixed — Salesforce built the quote from them.
      if (prev.sf.orderId || prev.sf.orderRequestedAt) {
        // The order exists: only who is billed and where can still change (billing readiness re-applies them before activation).
        if (prev.sf.activatedAt) throw new LifecycleInputError("The order is activated — nothing can change any more.");
        const nextTx: LifecycleTransaction = { ...prev, updatedAt: now, billing, steps: prev.steps.map(s => (s.id === "prepare-billing" && s.status !== "pending" ? { ...s, status: "pending", message: "Billing details changed — they are re-applied to the order.", finishedAt: null } : s)), status: "in-progress" };
        d.transactions = d.transactions.map(x => (x.id === prev.id ? nextTx : x));
        return nextTx;
      }
      const sameAssets = prev.assets.length === assetIds.length && prev.assets.every(a => assetIds.includes(a.id));
      if (!sameAssets || prev.effectiveDate !== effectiveDate || (prev.contractId ?? null) !== contractId) throw new LifecycleInputError("The quote was already created for these assets, this date and contract — only the line changes can be modified. Start a new transaction to change the assets or dates.");
      const nextTx: LifecycleTransaction = { ...prev, updatedAt: now, changes, adds, billing, cancel: kind === "cancel" ? cancel : prev.cancel, status: "in-progress", checks: [], sf: { ...prev.sf, priceRequestedAt: null, changesSentAt: null } };
      const reopen = new Set<StepId>(["apply-changes", "price", "validate"]);
      const edits = hasLineEdits(nextTx, nextTx.sf.initiatedQuantityChange);
      nextTx.steps = prev.steps.map(s => {
        if (!reopen.has(s.id)) return s;
        if (s.id === "apply-changes" && !edits && kind !== "amend") return { ...s, status: "skipped", message: "No line changes requested — nothing to send.", finishedAt: null };
        return { ...s, status: "pending", message: "Line changes modified — re-apply them to the quote.", finishedAt: null };
      });
      d.transactions = d.transactions.map(x => (x.id === prev.id ? nextTx : x));
      return nextTx;
    }
    const base = { kind, changes, adds, cancel, assets, amendSubtype };
    const nextTx: LifecycleTransaction = {
      id: prev?.id ?? newId(kind), kind, orgId: ctx.orgId, createdBy: prev?.createdBy ?? ctx.userId, createdAt: prev?.createdAt ?? now, updatedAt: now,
      name: str(input.name) ?? prev?.name ?? `${KIND_LABEL[kind]} ${now.slice(0, 10)}`,
      accountId, accountName: str(input.accountName), contractId, contractNumber: str(input.contractNumber), opportunityId, opportunityName: str(input.opportunityName),
      effectiveDate, amendSubtype, assets, changes, adds, renewal, cancel, status: "draft", steps: blankSteps(base), sf: prev?.sf ?? { ...BLANK_SF }, checks: [],
      billing, billingResolutions: { policies: [], treatments: [] }, billingNeeds: [], billingLog: [],
    };
    // Duplicate guard: the same assets already in another unfinished lifecycle transaction of this app that reached Salesforce.
    const clash = d.transactions.find(x => x.id !== nextTx.id && x.status !== "completed" && sent(x) && !x.sf.activatedAt && x.assets.some(a => assetIds.includes(a.id)));
    if (clash) throw new LifecycleInputError(`Asset(s) ${clash.assets.filter(a => assetIds.includes(a.id)).map(a => a.name).join(", ")} are already in ${KIND_LABEL[clash.kind].toLowerCase()} "${clash.name}" (quote ${clash.sf.quoteNumber ?? clash.sf.quoteId ?? "pending"}) — finish that one first.`);
    if (prev) d.transactions = d.transactions.map(x => (x.id === prev.id ? nextTx : x)); else d.transactions.unshift(nextTx);
    return nextTx;
  });
  const missing = assetIds.filter(a => !facts.has(a));
  const errors = [...missing.map(a => `Asset ${a} wasn't found in Salesforce.`), ...validateTransaction(tx, facts, today)];
  await audit(ctx, { transactionId: tx.id, kind, action: existingId ? "update" : "create", status: "info", summary: `${tx.name}: ${tx.assets.length} asset(s)${tx.adds.length ? `, ${tx.adds.length} added product(s)` : ""}, ${kind === "renew" ? `renewal start ${tx.effectiveDate || "Salesforce default"}` : `effective ${tx.effectiveDate || "—"}`}${kind === "cancel" && tx.cancel?.reason ? `, reason "${tx.cancel.reason}"` : ""}.`, refs: { accountId, contractId: tx.contractId } });
  return { transaction: tx, errors };
}

const inFlight = new Set<string>();

/** Run one lifecycle step (in order; writes need confirmation). One request at a time per transaction. */
export async function executeStep(ctx: LifecycleCtx, transactionId: string, stepId: StepId, confirmed: boolean, deps: LifecycleDeps, opts: StepOptions = {}): Promise<LifecycleTransaction> {
  const key = `${ctx.orgId}:${transactionId}`;
  if (inFlight.has(key)) throw new LifecycleInputError("A step of this transaction is already running — wait for it to finish.");
  inFlight.add(key);
  try {
    const data = await ctx.store.load(ctx.orgId);
    const t = data.transactions.find(x => x.id === transactionId);
    if (!t) throw new LifecycleInputError("Transaction not found.");
    let out: LifecycleTransaction;
    try { out = await runStep(ctx.api, t, stepId, confirmed, deps, opts); }
    catch (e) { if (e instanceof LifecycleError) throw new LifecycleInputError(e.message); throw e; }
    await ctx.store.update(ctx.orgId, x => { x.transactions = x.transactions.map(y => (y.id === out.id ? out : y)); });
    const st = out.steps.find(s => s.id === stepId)!;
    await audit(ctx, { transactionId, kind: out.kind, action: stepId, status: st.status === "completed" ? "success" : st.status === "failed" ? "failed" : "info", summary: `${st.label}: ${st.message ?? st.status}`, refs: { quoteId: out.sf.quoteId, orderId: out.sf.orderId, requestIdentifier: out.sf.requestIdentifier } });
    return out;
  } finally { inFlight.delete(key); }
}

/** Delete a transaction that was never sent to Salesforce (sent ones stay as history). */
export async function deleteTransaction(ctx: LifecycleCtx, transactionId: string) {
  let kind: LifecycleKind | null = null;
  await ctx.store.update(ctx.orgId, data => {
    const t = data.transactions.find(x => x.id === transactionId);
    if (!t) throw new LifecycleInputError("Transaction not found.");
    if (sent(t)) throw new LifecycleInputError("This transaction was sent to Salesforce — it's kept as history and can't be deleted here.");
    kind = t.kind;
    data.transactions = data.transactions.filter(x => x.id !== transactionId);
  });
  await audit(ctx, { transactionId, kind, action: "delete", status: "info", summary: "Unsent draft deleted.", refs: {} });
}

/**
 * Store the user's answers to billing readiness's open questions (the popup) — app-side only; the prepare-billing step writes them to
 * Salesforce (and reads them back) when execution resumes. Only answers to questions actually open on this transaction are accepted;
 * the caller has already checked each choice against the org (eligible policy / treatment of the right policy).
 */
export async function resolveBilling(ctx: LifecycleCtx, transactionId: string, input: { policies: Omit<PolicyResolution, "confirmedAt" | "appliedAt">[]; treatments: Omit<TreatmentResolution, "confirmedAt" | "appliedAt">[] }): Promise<LifecycleTransaction> {
  const now = new Date().toISOString();
  const tx = await ctx.store.update(ctx.orgId, d => {
    const t = d.transactions.find(x => x.id === transactionId);
    if (!t) throw new LifecycleInputError("Transaction not found.");
    if (t.sf.activatedAt) throw new LifecycleInputError("The order is already activated.");
    const needs = t.billingNeeds ?? [];
    for (const p of input.policies) if (!needs.some(n => n.kind === "billing-policy" && n.product?.id === p.productId)) throw new LifecycleInputError(`${p.productName} has no open Billing Policy question on this transaction.`);
    for (const x of input.treatments) if (!needs.some(n => n.kind === "billing-treatment" && n.orderItemIds.includes(x.orderItemId))) throw new LifecycleInputError(`That order product has no open Billing Treatment question on this transaction.`);
    const prev = t.billingResolutions ?? { policies: [], treatments: [] };
    const next: LifecycleTransaction = {
      ...t, updatedAt: now,
      billingResolutions: {
        policies: [...prev.policies.filter(p => !input.policies.some(q => q.productId === p.productId)), ...input.policies.map(p => ({ ...p, confirmedAt: now, appliedAt: null }))],
        treatments: [...prev.treatments.filter(p => !input.treatments.some(q => q.orderItemId === p.orderItemId)), ...input.treatments.map(p => ({ ...p, confirmedAt: now, appliedAt: null }))],
      },
    };
    d.transactions = d.transactions.map(x => (x.id === t.id ? next : x));
    return next;
  });
  await audit(ctx, { transactionId, kind: tx.kind, action: "billing-decision", status: "info", summary: [...input.policies.map(p => `Approved: ${p.productName} → Billing Policy ${p.policyName}`), ...input.treatments.map(x => `Approved: ${x.productName} order product → Billing Treatment ${x.treatmentName}`)].join("; "), refs: { orderId: tx.sf.orderId } });
  return tx;
}
