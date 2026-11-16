import type { RampApi } from "@/lib/ramp/server/api";
import { connectFailed, sfMessage, soql } from "@/lib/ramp/server/api";
import { lineItemFieldCaps, sellingModelDetails } from "@/lib/ramp/server/catalog";
import { repriceQuote, type RunDeps } from "@/lib/ramp/server/runner";
import { planSellingModelFields } from "@/lib/quotes/lineItem/sellingModelFields";
import { day } from "../eligibility";
import { addressComplete, billingHash, nextBillingAction, pricedSince, PRICING_BUSY, PRICING_FAILED, type LifecycleBillingService, type OrderPricing } from "../billing";
import { expectedQuantities, initiateRequest, isEmptyPlan, lifecycleLine, lineChangePlan, nextStep, renewalWindow, swapKindOf, swapPath, swapRequest, validateTransaction, type LinePlan } from "../plan";
import { ACTION_TYPE, INITIATE_ACTION, KIND_LABEL, type BillingLogEntry, type LifecycleStep, type LifecycleTransaction, type SfCall, type StepId, type SwapKind, type VerificationCheck } from "../types";
import { assetBilling, assetFactsByIds, assetsAfter, assetsFromOrder, findInitiatedQuote, lifecycleCapabilities, lifecycleOrder, lifecycleQuote, replacementRelationships, trackerStatus } from "./reads";

/**
 * The amendment / renewal / cancellation lifecycle, one step per request. Rules:
 *  · steps run in order; a write step runs only with explicit confirmation;
 *  · every write step re-reads Salesforce first and adopts what already exists (never a second initiation, order or line), and an
 *    initiation whose response was lost is RESUMED from Salesforce (request identifier / the quote it created), never re-sent;
 *  · Salesforce's response decides the outcome — nothing is marked done without a read-back, and no status is set by hand: the order
 *    is activated through the app's standard Order activation (billing + tax readiness); asset changes come from Salesforce itself.
 */

export interface LifecycleDeps extends RunDeps {
  /** Activate an order through the app's standard Order activation (billing + tax readiness). */
  activate: (orderId: string) => Promise<{ success: boolean; message: string; salesforceError: string | null }>;
  today: () => string;
  /** Billing readiness (Order Setup + Billing Policy assignment) — required for the prepare-billing step. */
  billing?: LifecycleBillingService;
}

export type StepOutcome = { status: "completed" | "failed" | "waiting" | "needs-input" | "skipped"; message: string };
const ok = (message: string): StepOutcome => ({ status: "completed", message });
const fail = (message: string): StepOutcome => ({ status: "failed", message });
const wait = (message: string): StepOutcome => ({ status: "waiting", message });
const needsInput = (message: string): StepOutcome => ({ status: "needs-input", message });

const PLACE = "/connect/rev/sales-transaction/actions/place";
const WAIT_MS = 18_000;
const GIVE_UP_MS = 15 * 60_000;
const BUSY = /InProgress|Queued|Saving|Waiting|Hydration|Submitted/i;
const FAILED = /Failed|Incomplete|Failure/i;

type Call = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
type Mut = (m: (d: LifecycleTransaction) => LifecycleTransaction) => void;

export class LifecycleError extends Error {}
/** Per-request options: activation needs its own explicit confirmation. */
export interface StepOptions { activationConfirmed?: boolean }

/** Run one step of a transaction. Never throws for Salesforce errors — they become the step's failure message. */
export async function runStep(api: RampApi, tx: LifecycleTransaction, stepId: StepId, confirmed: boolean, deps: LifecycleDeps, opts: StepOptions = {}): Promise<LifecycleTransaction> {
  const next = nextStep(tx.steps);
  if (!next) throw new LifecycleError(`Every step of this ${KIND_LABEL[tx.kind].toLowerCase()} is already complete.`);
  if (next.id !== stepId) throw new LifecycleError(`Run the steps in order — the next step is "${next.label}".`);
  if (next.writes && !confirmed) throw new LifecycleError(`"${next.label}" writes to Salesforce — confirm it first (confirmed: true).`);
  // Activation is irreversible: it needs its OWN confirmation, separate from the confirmation that created the quote / order.
  if (next.id === "activate" && !opts.activationConfirmed) throw new LifecycleError("Activating the order is irreversible — it needs its own confirmation (activationConfirmed: true) after the order to activate is shown.");

  const calls: SfCall[] = [];
  const call: Call = async (method, path, body) => {
    const r = await api.call(method, path, body);
    calls.push({ at: deps.now(), method, path, request: body, status: r.status, response: r.body });
    return r;
  };
  let d: LifecycleTransaction = mark(tx, stepId, { status: "in-progress", startedAt: next.startedAt ?? deps.now() });
  let out: StepOutcome;
  try {
    out = await STEPS[stepId](api, d, call, deps, m => (d = m(d)));
  } catch (e) {
    out = fail(e instanceof Error ? e.message : String(e));
  }
  const started = Date.parse(d.steps.find(s => s.id === stepId)!.startedAt ?? deps.now());
  if (out.status === "waiting" && Date.parse(deps.now()) - started > GIVE_UP_MS) out = fail(`${out.message} Salesforce hadn't finished after ${GIVE_UP_MS / 60_000} minutes — check the records in Salesforce, then retry the step (it re-reads Salesforce first).`);
  d = mark(d, stepId, { status: out.status, message: out.message, finishedAt: out.status === "waiting" ? null : deps.now(), calls: [...(d.steps.find(s => s.id === stepId)!.calls), ...calls] });
  const status = out.status === "failed" ? "failed" : out.status === "waiting" ? "waiting" : out.status === "needs-input" ? "needs-input" : nextStep(d.steps) ? "in-progress" : "completed";
  return { ...d, status, updatedAt: deps.now() };
}

function mark(d: LifecycleTransaction, id: StepId, patch: Partial<LifecycleStep>): LifecycleTransaction {
  return { ...d, steps: d.steps.map(s => (s.id === id ? { ...s, ...patch } : s)) };
}

const outputs = (r: { status: number; body: unknown }) => (Array.isArray(r.body) ? (r.body[0] as { isSuccess?: boolean; errors?: unknown; outputValues?: Record<string, unknown> } | undefined) : undefined);
const outStr = (o: Record<string, unknown> | undefined, ...keys: string[]) => { for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k] as string; return null; };
const lifecycleNoun = (d: LifecycleTransaction) => KIND_LABEL[d.kind].toLowerCase();

type Step = (api: RampApi, d: LifecycleTransaction, call: Call, deps: LifecycleDeps, mut: Mut) => Promise<StepOutcome>;

/**
 * Upgrade / Downgrade / Swap: Salesforce's dedicated Transaction Management API (API 66.0+) builds the amendment quote with the
 * linked quote action subtypes and, on assetization, the asset relationship between the replaced and the new asset. The replacement
 * line's selling-model fields come from its price book entry, exactly like any other quote line the app creates.
 */
async function initiateSwap(api: RampApi, d: LifecycleTransaction, swap: SwapKind, call: Call, deps: LifecycleDeps, mut: Mut, available: boolean): Promise<StepOutcome> {
  if (!available) return fail(`This org has no ${swap} resource (POST ${swapPath(swap)}, API 66.0+) — the ${swap} can't be sent.`);
  const changes = d.changes.filter(c => c.swap);
  const entries = await api.query<Record<string, unknown>>(`SELECT Id, Product2Id, UnitPrice, ProductSellingModelId FROM PricebookEntry WHERE Id IN (${changes.map(c => soql(c.swap!.pricebookEntryId)).join(",")})`);
  const models = await sellingModelDetails(api, entries.map(e => String(e.ProductSellingModelId ?? "")).filter(Boolean));
  const caps = await lineItemFieldCaps(api);
  const snap = new Map(d.assets.map(a => [a.id, a]));
  const fields = new Map<string, Record<string, unknown>>();
  for (const c of changes) {
    const pbe = entries.find(e => e.Id === c.swap!.pricebookEntryId);
    if (!pbe) return fail(`Price book entry ${c.swap!.pricebookEntryId} for the ${swap} of ${snap.get(c.assetId)?.name ?? c.assetId} wasn't found.`);
    if (pbe.Product2Id !== c.swap!.productId) return fail(`Price book entry ${c.swap!.pricebookEntryId} isn't for ${c.swap!.productName}.`);
    const sm = typeof pbe.ProductSellingModelId === "string" ? models.get(pbe.ProductSellingModelId) ?? null : null;
    const s = snap.get(c.assetId);
    const fp = planSellingModelFields(sm, caps, { startDate: d.effectiveDate, endDate: c.swap!.endDate ?? s?.endDate ?? s?.lifecycleEnd ?? null, billingFrequency: c.swap!.billingFrequency ?? null });
    if (fp.errors.length) return fail(`${swap} of ${s?.name ?? c.assetId}: ${fp.errors.join(" ")}`);
    const f: Record<string, unknown> = { ...fp.fields };
    delete f.StartDate;
    fields.set(c.assetId, { ...f, UnitPrice: pbe.UnitPrice });
  }
  const req = swapRequest(d, fields)!;
  mut(x => ({ ...x, sf: { ...x.sf, initiatedAt: deps.now() } }));
  const r = await call("POST", req.path, req.body);
  if (connectFailed(r.status, r.body)) {
    mut(x => ({ ...x, sf: { ...x.sf, initiatedAt: null } }));
    return fail(`Salesforce rejected the ${swap}: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
  }
  const body = (r.body ?? {}) as Record<string, unknown>;
  const recordId = typeof body.salesTransactionId === "string" ? body.salesTransactionId : null;
  const requestIdentifier = typeof body.requestIdentifier === "string" ? body.requestIdentifier : null;
  if (!recordId && !requestIdentifier) return fail(`Salesforce accepted the ${swap} but returned no sales transaction Id.`);
  mut(x => ({ ...x, sf: { ...x.sf, quoteId: recordId, requestIdentifier } }));
  return ok(`${swap[0].toUpperCase()}${swap.slice(1)} initiated — Salesforce created amendment quote ${recordId ?? "(pending)"}.`);
}

const STEPS: Record<StepId, Step> = {
  /* 1. initiate* — once. A lost response is recovered from Salesforce, never re-sent. */
  async initiate(api, d, call, deps, mut) {
    if (d.sf.quoteId || d.sf.requestIdentifier) return ok(`Already initiated (${lifecycleNoun(d)} record ${d.sf.quoteId ?? "pending"}) — not sent again.`);
    const swap = swapKindOf(d);
    if (d.sf.initiatedAt) {
      // A previous attempt was sent but its result wasn't recorded: adopt what Salesforce created, or keep waiting — never resend.
      const found = await findInitiatedQuote(api, d.kind, d.assets.map(a => a.id), d.sf.initiatedAt, !!swap);
      if (found) { mut(x => ({ ...x, sf: { ...x.sf, quoteId: found.quoteId, quoteNumber: found.quoteNumber } })); return ok(`Recovered the ${lifecycleNoun(d)} quote ${found.quoteNumber ?? found.quoteId} that Salesforce created for the earlier request — nothing re-sent.`); }
      if (Date.parse(deps.now()) - Date.parse(d.sf.initiatedAt) < GIVE_UP_MS) return wait(`The ${INITIATE_ACTION[d.kind]} request sent at ${d.sf.initiatedAt} has no recorded result yet — waiting for its quote to appear in Salesforce instead of sending it again.`);
      return fail(`The ${INITIATE_ACTION[d.kind]} request sent at ${d.sf.initiatedAt} produced no ${ACTION_TYPE[d.kind]} quote for these assets. Check Salesforce (Async Operation Tracker); start a new transaction only if nothing was created.`);
    }
    const caps = await lifecycleCapabilities(api);
    if (caps.missing[d.kind].length) return fail(caps.missing[d.kind].join(" "));
    const facts = await assetFactsByIds(api, d.assets.map(a => a.id), deps.today());
    const errors = validateTransaction(d, facts, deps.today(), { actionInputs: caps.actions[d.kind].inputs });
    if (errors.length) return fail(`Not sent — ${errors.join(" ")}`);
    if (swap) return initiateSwap(api, d, swap, call, deps, mut, caps.features[swap]);
    const body = initiateRequest(d);
    mut(x => ({ ...x, sf: { ...x.sf, initiatedAt: deps.now() } }));
    const r = await call("POST", `/actions/standard/${INITIATE_ACTION[d.kind]}`, body);
    const res = outputs(r);
    if (r.status >= 300 || !res || res.isSuccess === false) {
      mut(x => ({ ...x, sf: { ...x.sf, initiatedAt: null } }));
      return fail(`Salesforce rejected ${INITIATE_ACTION[d.kind]}: ${sfMessage(res?.errors ?? r.body, `HTTP ${r.status}`)}`);
    }
    const recordId = outStr(res.outputValues, `${d.kind}RecordId`, "record_id", "recordId");
    const requestIdentifier = outStr(res.outputValues, "requestIdentifier");
    if (!recordId && !requestIdentifier) return fail(`Salesforce accepted ${INITIATE_ACTION[d.kind]} but returned neither a record Id nor a request identifier.`);
    mut(x => ({ ...x, sf: { ...x.sf, quoteId: recordId, requestIdentifier, initiatedQuantityChange: d.kind === "amend" ? (body.inputs[0].quantityChange as number) : null } }));
    return ok(`${KIND_LABEL[d.kind]} initiated — Salesforce returned record ${recordId ?? "(pending)"}${requestIdentifier ? ` and async request ${requestIdentifier}` : ""}.`);
  },

  /* 2. Wait for the lifecycle quote and its lines (one per asset). */
  async "await-quote"(api, d, _call, deps, mut) {
    const until = Date.now() + (deps.waitMs ?? WAIT_MS);
    for (;;) {
      const t = await trackerStatus(api, d.sf.requestIdentifier);
      if (t.status && /^(Failure|CompletedWithFailures)$/i.test(t.status)) return fail(`Salesforce's ${lifecycleNoun(d)} request ${d.sf.requestIdentifier} ended ${t.status}${t.response ? `: ${t.response}` : ""}.`);
      let quoteId = d.sf.quoteId;
      if (!quoteId && t.referenceId?.startsWith("0Q0")) { quoteId = t.referenceId; mut(x => ({ ...x, sf: { ...x.sf, quoteId } })); }
      const q = quoteId ? await lifecycleQuote(api, quoteId, d.cancel?.reasonField) : null;
      if (q) {
        mut(x => ({ ...x, sf: { ...x.sf, quoteNumber: q.quoteNumber } }));
        const missing = d.assets.filter(a => !lifecycleLine(q.lines, d.kind, a.id, !!swapKindOf(d)));
        if (!missing.length) {
          // Amendments: once Salesforce applied the single quantityChange, skip the edit step when nothing else differs.
          if (d.kind === "amend" && isEmptyPlan(lineChangePlan(d, q.lines))) mut(x => mark(x, "apply-changes", { status: "skipped", message: "The amendment quote already matches the plan — nothing to send." }));
          return ok(`${KIND_LABEL[d.kind]} quote ${q.quoteNumber ?? q.id} is ready with ${q.lines.length} line(s)${q.originalActionType ? ` (OriginalActionType ${q.originalActionType})` : ""}.`);
        }
        if (t.status && /^Completed$/i.test(t.status)) return fail(`Salesforce finished the request but quote ${q.quoteNumber ?? q.id} has no ${ACTION_TYPE[d.kind]} line for ${missing.map(a => a.name).join(", ")}.`);
        // No async request (Salesforce answered synchronously — observed live) and the quote is priced: its lines won't change by
        // waiting. Report what Salesforce actually built instead of polling for 15 minutes.
        const settled = !!q.calculationStatus && !BUSY.test(q.calculationStatus);
        const since = d.sf.initiatedAt ? Date.parse(deps.now()) - Date.parse(d.sf.initiatedAt) : Infinity;
        if (!d.sf.requestIdentifier && settled && since > 90_000) {
          const found = missing.map(a => { const l = q.lines.find(x => x.sourceAssetId === a.id && !x.parentLineId); return l ? `${a.name}: QuoteAction ${l.actionType ?? "none"}${l.actionSubtype ? `/${l.actionSubtype}` : ""}` : `${a.name}: no line`; });
          return fail(`Salesforce built quote ${q.quoteNumber ?? q.id} (CalculationStatus ${q.calculationStatus}) but not the expected ${ACTION_TYPE[d.kind]} line — ${found.join("; ")}. Review the quote in Salesforce.`);
        }
      } else if (quoteId && t.status && /^Completed$/i.test(t.status)) {
        return fail(`Salesforce returned record ${quoteId}, but it isn't a readable Quote.`);
      }
      if (Date.now() >= until) return wait(`Salesforce is still building the ${lifecycleNoun(d)} quote${t.status ? ` (request ${t.status})` : ""}.`);
      await deps.sleep(2000);
    }
  },

  /* 3. Line changes on the lifecycle quote (one Place Sales Transaction, pricing skipped — priced in step 4). */
  async "apply-changes"(api, d, call, deps, mut) {
    const quoteId = d.sf.quoteId!;
    const q = await lifecycleQuote(api, quoteId, d.cancel?.reasonField);
    if (!q) return fail(`Quote ${quoteId} couldn't be read.`);
    const clearSent = () => mut(x => ({ ...x, sf: { ...x.sf, changesSentAt: null } }));
    if (d.sf.changesSentAt) {
      // Already sent: only read back — re-sending while Salesforce saves could add a line twice.
      const left = lineChangePlan(d, q.lines, q);
      if (isEmptyPlan(left)) { clearSent(); return ok("Every planned change is on the quote — read back from Salesforce."); }
      if (BUSY.test(q.calculationStatus ?? "") || Date.parse(deps.now()) - Date.parse(d.sf.changesSentAt) < 60_000) return wait(`Salesforce is saving the quote changes sent at ${d.sf.changesSentAt} (CalculationStatus ${q.calculationStatus ?? "unknown"}).`);
      clearSent();
      return fail(`Salesforce didn't keep every change sent at ${d.sf.changesSentAt}. Retry to send the remaining changes.`);
    }
    if (BUSY.test(q.calculationStatus ?? "")) return wait(`The quote is busy (CalculationStatus ${q.calculationStatus}).`);
    // The (possibly modified) changes are re-validated; eligibility isn't re-read — this transaction's own quote is now "open".
    const invalid = validateTransaction(d, null, deps.today());
    if (invalid.length) return fail(`Not sent — ${invalid.join(" ")}`);
    const plan = lineChangePlan(d, q.lines, q);
    if (plan.errors.length) return fail(plan.errors.join(" "));
    if (isEmptyPlan(plan)) return ok("The quote already has every planned change — nothing to send.");

    const records: unknown[] = [{ referenceId: "refQuote", record: { attributes: { type: "Quote", method: "PATCH", id: quoteId }, ...(plan.quotePatch ?? {}) } }];
    for (const p of plan.patches) records.push({ referenceId: `line_${p.lineId}`, record: { attributes: { type: "QuoteLineItem", method: "PATCH", id: p.lineId }, ...p.fields } });
    for (const p of plan.actionPatches) records.push({ referenceId: `action_${p.actionId}`, record: { attributes: { type: "QuoteAction", method: "PATCH", id: p.actionId }, ...p.fields } });
    for (const p of plan.attributePatches) records.push({ referenceId: `attr_${p.id}`, record: { attributes: { type: "QuoteLineItemAttribute", method: "PATCH", id: p.id }, ...p.fields } });
    if (plan.creates.length) {
      const entries = await api.query<Record<string, unknown>>(`SELECT Id, Product2Id, UnitPrice, ProductSellingModelId FROM PricebookEntry WHERE Id IN (${plan.creates.map(c => soql(c.product.pricebookEntryId)).join(",")})`);
      const models = await sellingModelDetails(api, entries.map(e => String(e.ProductSellingModelId ?? "")).filter(Boolean));
      const caps = await lineItemFieldCaps(api);
      for (const c of plan.creates) {
        const pbe = entries.find(e => e.Id === c.product.pricebookEntryId);
        if (!pbe) return fail(`Price book entry ${c.product.pricebookEntryId} for ${c.for} wasn't found.`);
        if (pbe.Product2Id !== c.product.productId) return fail(`Price book entry ${c.product.pricebookEntryId} isn't for the chosen product (${c.for}).`);
        const sm = typeof pbe.ProductSellingModelId === "string" ? models.get(pbe.ProductSellingModelId) ?? null : null;
        const fp = planSellingModelFields(sm, caps, { startDate: c.product.startDate ?? d.effectiveDate, endDate: c.product.endDate ?? null, billingFrequency: c.product.billingFrequency ?? null });
        if (fp.errors.length) return fail(`${c.for}: ${fp.errors.join(" ")}`);
        records.push({ referenceId: `new_${c.key.replace(/[^a-zA-Z0-9]/g, "_")}`, record: { attributes: { type: "QuoteLineItem", method: "POST" }, QuoteId: "@{refQuote.id}", PricebookEntryId: pbe.Id, Product2Id: pbe.Product2Id, Quantity: c.product.quantity, UnitPrice: c.product.unitPrice ?? pbe.UnitPrice, ...fp.fields } });
      }
    }
    mut(x => ({ ...x, sf: { ...x.sf, changesSentAt: deps.now() } }));
    const r = await call("POST", PLACE, { pricingPref: "Skip", graph: { graphId: `${d.kind}Quote`, records } });
    if (connectFailed(r.status, r.body)) { clearSent(); return fail(`Salesforce rejected the quote changes: ${sfMessage(r.body, `HTTP ${r.status}`)}`); }
    // Read back until Salesforce has saved them (or hand back "waiting").
    const until = Date.now() + (deps.waitMs ?? WAIT_MS);
    for (;;) {
      const after = await lifecycleQuote(api, quoteId, d.cancel?.reasonField);
      if (after && FAILED.test(after.calculationStatus ?? "")) return fail(`Salesforce couldn't save the quote changes (CalculationStatus ${after.calculationStatus}).`);
      const left: LinePlan | null = after ? lineChangePlan(d, after.lines, after) : null;
      if (left && isEmptyPlan(left)) { clearSent(); return ok(`Applied ${plan.patches.length} line update(s), ${plan.actionPatches.length} action update(s), ${plan.attributePatches.length} attribute update(s), ${plan.creates.length} new line(s)${plan.quotePatch ? " and the quote field" : ""} — read back from Salesforce.`); }
      if (Date.now() >= until && left && !BUSY.test(after?.calculationStatus ?? "")) clearSent();
      if (Date.now() >= until) return left && !BUSY.test(after?.calculationStatus ?? "")
        ? fail(`Salesforce accepted the request but didn't keep every change: ${[...left.errors, ...(left.quotePatch ? [`quote ${JSON.stringify(left.quotePatch)}`] : []), ...left.patches.map(p => `line ${p.lineId} ${JSON.stringify(p.fields)}`), ...left.actionPatches.map(p => `action ${p.actionId} ${JSON.stringify(p.fields)}`), ...left.attributePatches.map(p => `attribute ${p.id} ${JSON.stringify(p.fields)}`), ...left.creates.map(c => `new line for ${c.for}`)].join("; ")}.`)
        : wait(`Salesforce is saving the quote changes (CalculationStatus ${after?.calculationStatus ?? "unknown"}).`);
      await deps.sleep(2000);
    }
  },

  /* 4. Salesforce pricing (reuses the app's Place Sales Transaction Force + persistence check). */
  async price(api, d, call, deps, mut) {
    const quoteId = d.sf.quoteId!;
    // Bill-To + addresses on the quote (informational there — the ORDER fields are what billing needs, set before activation).
    await quoteBillingDetails(api, d, call, deps, mut);
    const q = await lifecycleQuote(api, quoteId, d.cancel?.reasonField);
    if (!q) return fail(`Quote ${quoteId} couldn't be read.`);
    if (d.sf.priceRequestedAt) {
      if (q.lastPricedDate && Date.parse(q.lastPricedDate) >= Date.parse(d.sf.priceRequestedAt) - 5000 && !BUSY.test(q.calculationStatus ?? "")) return ok(`Priced and saved (CalculationStatus ${q.calculationStatus}, LastPricedDate ${q.lastPricedDate}).`);
      if (BUSY.test(q.calculationStatus ?? "")) return wait(`Salesforce is still pricing (CalculationStatus ${q.calculationStatus}).`);
    }
    // Nothing was edited after Salesforce built (and priced, skipPricing=false) the quote: its saved prices stand — nothing re-sent.
    const edited = d.steps.find(s => s.id === "apply-changes")?.calls.length ?? 0;
    if (!edited && !d.sf.priceRequestedAt && q.lastPricedDate && !BUSY.test(q.calculationStatus ?? "") && !FAILED.test(q.calculationStatus ?? "")) return ok(`Salesforce priced the quote when it created it (CalculationStatus ${q.calculationStatus}, LastPricedDate ${q.lastPricedDate}) and no line was changed since — nothing re-sent.`);
    mut(x => ({ ...x, sf: { ...x.sf, priceRequestedAt: deps.now() } }));
    const r = await repriceQuote(api, quoteId, deps);
    mut(x => ({ ...x, steps: x.steps.map(s => (s.id === "price" ? { ...s, calls: [...s.calls, ...r.calls.map(c => ({ at: c.at, method: c.method, path: c.path, request: c.request, status: c.status, response: c.response }))] } : s)) }));
    return r.ok ? ok(r.message) : r.waiting ? wait(r.message) : fail(r.message);
  },

  /* 5. Validate the saved quote against the plan (read-only). */
  async validate(api, d, _call, _deps, mut) {
    const q = await lifecycleQuote(api, d.sf.quoteId!, d.cancel?.reasonField);
    if (!q) return fail("The quote couldn't be read.");
    const checks: VerificationCheck[] = [];
    checks.push({ id: "calc", label: "Quote calculation", ok: !!q.calculationStatus && !BUSY.test(q.calculationStatus) && !FAILED.test(q.calculationStatus), detail: `CalculationStatus ${q.calculationStatus ?? "unknown"}, LastPricedDate ${q.lastPricedDate ?? "none"}` });
    if (q.originalActionType) checks.push({ id: "type", label: "Quote type", ok: q.originalActionType.toLowerCase() === ACTION_TYPE[d.kind].toLowerCase(), detail: `OriginalActionType ${q.originalActionType}` });
    const plan = lineChangePlan(d, q.lines, q);
    checks.push({ id: "plan", label: "Every planned change is on the quote", ok: isEmptyPlan(plan), detail: [...plan.errors, ...(plan.quotePatch ? [`quote still differs: ${JSON.stringify(plan.quotePatch)}`] : []), ...plan.patches.map(p => `line ${p.lineId} still differs: ${JSON.stringify(p.fields)}`), ...plan.attributePatches.map(p => `attribute ${p.id} still differs`), ...plan.creates.map(c => `missing ${c.for}`)].join("; ") || "All present." });
    const expected = expectedQuantities(d);
    const w = d.kind === "renew" ? renewalWindow(d) : null;
    for (const a of d.assets) {
      const line = lifecycleLine(q.lines, d.kind, a.id, !!swapKindOf(d));
      if (!line) continue;
      const want = expected.get(a.id);
      if (d.kind === "amend" && line.endQuantity !== null) checks.push({ id: `end-${a.id}`, label: `${a.name}: resulting quantity`, ok: line.endQuantity === want, detail: `Salesforce EndQuantity ${line.endQuantity}, planned ${want ?? "?"}` });
      if (d.kind === "cancel" && line.endQuantity !== null) checks.push({ id: `end-${a.id}`, label: `${a.name}: quantity after cancellation`, ok: line.endQuantity === 0, detail: `Salesforce EndQuantity ${line.endQuantity} (line quantity ${line.quantity ?? "—"})` });
      if (d.kind === "cancel" && line.startDate) checks.push({ id: `date-${a.id}`, label: `${a.name}: cancellation date`, ok: day(line.startDate) === d.effectiveDate, detail: `Line start ${day(line.startDate)} (requested ${d.effectiveDate})`, required: false });
      if (d.kind === "renew") {
        if (w?.start && line.startDate) checks.push({ id: `start-${a.id}`, label: `${a.name}: renewal start`, ok: day(line.startDate) === w.start, detail: `Line start ${day(line.startDate)} (requested ${w.start})`, required: false });
        if (w?.end && line.endDate) checks.push({ id: `end-${a.id}`, label: `${a.name}: renewal end`, ok: day(line.endDate) === w.end, detail: `Line end ${day(line.endDate)} (requested ${w.end})`, required: false });
      }
      const c = d.changes.find(x => x.assetId === a.id);
      if (c?.unitPrice != null) checks.push({ id: `price-${a.id}`, label: `${a.name}: price`, ok: line.unitPrice === c.unitPrice, detail: `UnitPrice ${line.unitPrice ?? "—"} (requested ${c.unitPrice}); Salesforce net unit price ${line.netUnitPrice ?? "—"}` });
      if (c?.discount != null) checks.push({ id: `disc-${a.id}`, label: `${a.name}: discount`, ok: (line.discount ?? 0) === c.discount, detail: `Discount ${line.discount ?? 0}% (requested ${c.discount}%)` });
    }
    checks.push({ id: "total", label: "Financial impact (Salesforce)", ok: true, required: false, detail: `Quote total ${q.totalPrice ?? "—"}${q.tax != null ? `, tax ${q.tax}` : ""}${q.grandTotal != null ? `, grand total ${q.grandTotal}` : ""} — as priced by Salesforce.` });
    mut(x => ({ ...x, checks }));
    const bad = checks.filter(c => !c.ok && c.required !== false);
    return bad.length ? fail(`Validation failed: ${bad.map(b => `${b.label} — ${b.detail}`).join(" · ")}`) : ok(`Quote ${q.quoteNumber ?? q.id} validated: ${checks.filter(c => c.required !== false).length} check(s) passed. Total ${q.totalPrice ?? "—"}.`);
  },

  /* 6. createOrderFromQuote — once; an order already created from this quote is adopted. */
  async "create-order"(api, d, call, deps, mut) {
    const quoteId = d.sf.quoteId!;
    const existing = await lifecycleOrder(api, { quoteId });
    if (existing) { mut(x => ({ ...x, sf: { ...x.sf, orderId: existing.id, orderNumber: existing.orderNumber } })); return ok(`Order ${existing.orderNumber ?? existing.id} exists for this quote (${existing.status ?? "status unknown"}) — adopted, not created again.`); }
    if (d.sf.orderRequestedAt) return wait("Waiting for Salesforce to create the order from the quote (already requested — not sent again).");
    const caps = await lifecycleCapabilities(api);
    if (!caps.actions.createOrderFromQuote.available) return fail(caps.missing[d.kind].join(" "));
    mut(x => ({ ...x, sf: { ...x.sf, orderRequestedAt: deps.now() } }));
    const r = await call("POST", "/actions/standard/createOrderFromQuote", { inputs: [{ quoteRecordId: quoteId }] });
    const res = outputs(r);
    if (r.status >= 300 || !res || res.isSuccess === false) {
      mut(x => ({ ...x, sf: { ...x.sf, orderRequestedAt: null } }));
      return fail(`Salesforce didn't create the order: ${sfMessage(res?.errors ?? r.body, `HTTP ${r.status}`)}`);
    }
    const until = Date.now() + (deps.waitMs ?? WAIT_MS);
    for (;;) {
      const orderId = outStr(res.outputValues, "orderId");
      const o = await lifecycleOrder(api, orderId ? { orderId } : { quoteId });
      if (o) { mut(x => ({ ...x, sf: { ...x.sf, orderId: o.id, orderNumber: o.orderNumber } })); return ok(`${KIND_LABEL[d.kind]} order ${o.orderNumber ?? o.id} created (${o.status ?? "status unknown"}, ${o.items.length} item(s)).`); }
      if (Date.now() >= until) return wait(`Salesforce accepted the request${outStr(res.outputValues, "requestId") ? ` (${outStr(res.outputValues, "requestId")})` : ""}; the order isn't readable yet.`);
      await deps.sleep(2000);
    }
  },

  /* 7. Billing readiness — the order Salesforce created is made activatable without manual Order Setup / Reprice All clicks. */
  "prepare-billing": prepareBilling,

  /* 8. Activate the NEW lifecycle order (never an original order or one from another quote). */
  async activate(api, d, _call, deps, mut) {
    const o = await lifecycleOrder(api, { orderId: d.sf.orderId! });
    if (!o) return fail(`Order ${d.sf.orderId} couldn't be read.`);
    if (o.quoteId !== d.sf.quoteId) return fail(`Order ${o.orderNumber ?? o.id} wasn't created from this ${lifecycleNoun(d)} quote — it isn't activated.`);
    if (o.originalActionType && o.originalActionType.toLowerCase() !== ACTION_TYPE[d.kind].toLowerCase()) return fail(`Order ${o.orderNumber ?? o.id} is a ${o.originalActionType} order, not a ${ACTION_TYPE[d.kind]} order — it isn't activated.`);
    if (/^activated$/i.test(o.status ?? "")) { mut(x => ({ ...x, sf: { ...x.sf, activatedAt: x.sf.activatedAt ?? deps.now() } })); return ok(`Order ${o.orderNumber ?? o.id} is Activated.`); }
    const at = deps.now();
    const r = await deps.activate(o.id);
    if (!r.success) return fail(`Activation refused: ${r.salesforceError ?? r.message}`);
    const after = await lifecycleOrder(api, { orderId: o.id });
    if (!/^activated$/i.test(after?.status ?? "")) return fail(`Activation was accepted but the order reads ${after?.status ?? "unknown"}.`);
    mut(x => ({ ...x, sf: { ...x.sf, activatedAt: at } }));
    return ok(`Order ${o.orderNumber ?? o.id} activated (read back: ${after?.status}).`);
  },

  /* 9. Verify what Salesforce did to the assets (and billing) — read-only. */
  async verify(api, d, _call, deps, mut) {
    const expected = expectedQuantities(d);
    const assets = await assetsAfter(api, d.assets.map(a => a.id), d.sf.activatedAt);
    const checks: VerificationCheck[] = [];
    const today = deps.today();
    const w = d.kind === "renew" ? renewalWindow(d) : null;
    for (const a of d.assets) {
      const now = assets.find(x => x.id === a.id);
      const acts = now?.newActions ?? [];
      const list = acts.map(x => `${x.type}/${x.category}${x.subtype ? `/${x.subtype}` : ""}${x.quantityChange != null ? ` ${x.quantityChange}` : ""}`).join(", ") || "No new Asset Action since activation.";
      if (d.kind === "amend") {
        const want = expected.get(a.id);
        // A future-dated amendment changes the quantity on its start date.
        const effective = d.effectiveDate <= today;
        checks.push({ id: `qty-${a.id}`, label: `${a.name}: quantity`, ok: !!now && (effective ? now.quantity === want : true), required: effective, detail: `Salesforce CurrentQuantity ${now?.quantity ?? "unreadable"} (was ${a.quantity ?? "?"}, expected ${want ?? "?"}${effective ? "" : ` from ${d.effectiveDate}`})` });
        const c = d.changes.find(x => x.assetId === a.id);
        // A quantity change or replacement must produce an Asset Action; for a price / field-only change (a "No Change" line) what
        // Salesforce records is unverified, so that check is informational.
        const qtyChanges = (want ?? 0) !== (a.quantity ?? 0) || !!c?.swap;
        if (c || d.amendSubtype) checks.push({ id: `action-${a.id}`, label: `${a.name}: asset action recorded`, ok: acts.length > 0, required: qtyChanges && effective, detail: list });
      } else if (d.kind === "renew") {
        checks.push({ id: `action-${a.id}`, label: `${a.name}: renewal recorded`, ok: acts.some(x => /renew/i.test(x.category ?? "") || /renew/i.test(x.type ?? "")) || acts.length > 0, detail: list });
        const was = a.lifecycleEnd ?? a.endDate;
        const want = w?.end ?? null;
        checks.push({ id: `end-${a.id}`, label: `${a.name}: lifecycle end extended`, ok: !!now?.lifecycleEnd && (want ? now.lifecycleEnd === want : !was || now.lifecycleEnd > was), detail: `Lifecycle end ${now?.lifecycleEnd ?? "none"} (was ${was ?? "none"}${want ? `, requested ${want}` : ""})` });
        checks.push({ id: `qty-${a.id}`, label: `${a.name}: quantity carried over`, ok: !!now && (now.quantity ?? 0) > 0, required: false, detail: `Salesforce CurrentQuantity ${now?.quantity ?? "unreadable"} (was ${a.quantity ?? "?"})` });
      } else {
        checks.push({ id: `action-${a.id}`, label: `${a.name}: cancellation recorded`, ok: acts.some(x => /cancel/i.test(x.type ?? "") || /cancel/i.test(x.category ?? "")), detail: list });
        const effective = d.effectiveDate <= today;
        checks.push({ id: `qty-${a.id}`, label: `${a.name}: quantity`, ok: !!now && (effective ? now.quantity === 0 : true), required: effective, detail: effective ? `Salesforce CurrentQuantity ${now?.quantity ?? "unreadable"} (expected 0 from ${d.effectiveDate})` : `Future-dated: quantity stays ${now?.quantity ?? "?"} until ${d.effectiveDate}.` });
      }
    }
    const newLines = d.kind === "amend" ? d.adds.length + d.changes.filter(c => c.swap).length : 0;
    if (newLines && d.sf.orderId) {
      const created = (await assetsFromOrder(api, d.sf.orderId)).filter(x => /generate/i.test(x.type ?? ""));
      checks.push({ id: "new-assets", label: "New assets for added / replacement products", ok: created.length >= newLines, detail: `${created.length} new asset(s) from the order (expected ${newLines}).` });
    }
    const swapKind = swapKindOf(d);
    if (swapKind) {
      // Salesforce links the replaced and the new asset (AssetRelationship Upgrade / Replacement / Crossgrade) — informational.
      const rels = await replacementRelationships(api, d.assets.map(a => a.id)).catch(() => []);
      checks.push({ id: "relationship", label: `${swapKind} relationship between old and new asset`, ok: rels.length > 0, required: false, detail: rels.length ? rels.map(r => `${r.assetName ?? r.assetId} → ${r.relatedAssetName ?? r.relatedAssetId} (${r.type})`).join(", ") : "No Asset Relationship found yet." });
    }
    // Revenue Cloud Billing (only where the org bills these assets) — informational, never assumed.
    const billing = await assetBilling(api, d.assets.map(a => a.id)).catch(() => new Map());
    if (billing.size) {
      for (const a of d.assets) {
        const g = billing.get(a.id) ?? [];
        if (!g.length) continue;
        const detail = g.map((x: { number: string | null; groupId: string; cancellationDate: string | null; endDate: string | null; billed: number | null; pending: number | null; schedules: number }) => `${x.number ?? x.groupId}: ${x.schedules} schedule(s), end ${x.endDate ?? "—"}${x.cancellationDate ? `, cancellation ${x.cancellationDate}` : ""}, billed ${x.billed ?? "—"}, pending ${x.pending ?? "—"}`).join(" · ");
        const cancelled = g.some((x: { cancellationDate: string | null }) => !!x.cancellationDate);
        checks.push({ id: `billing-${a.id}`, label: `${a.name}: billing`, ok: d.kind === "cancel" ? cancelled : true, required: false, detail: d.kind === "cancel" && !cancelled ? `No cancellation date on the billing schedule group yet — ${detail}` : detail });
      }
    } else checks.push({ id: "billing", label: "Billing", ok: true, required: false, detail: "No Revenue Cloud billing schedule groups reference these assets — nothing downstream to verify." });
    if (d.contractId) {
      const [c] = await api.query<Record<string, unknown>>(`SELECT Id, Status, EndDate FROM Contract WHERE Id = ${soql(d.contractId)} LIMIT 1`).catch(() => []);
      checks.push({ id: "contract", label: "Contract", ok: !!c, required: false, detail: c ? `Contract ${d.contractNumber ?? d.contractId}: ${c.Status ?? "—"}, ends ${c.EndDate ?? "—"}` : "The contract couldn't be read." });
    }
    mut(x => ({ ...x, checks }));
    const bad = checks.filter(c => !c.ok && c.required !== false);
    if (!bad.length) return ok(`Verified in Salesforce: ${checks.filter(c => c.required !== false).length} check(s) passed.`);
    // Asset updates are asynchronous after activation — keep polling a while before failing.
    return wait(`Waiting for Salesforce to update the assets: ${bad.map(b => `${b.label} — ${b.detail}`).join(" · ")}`);
  },
};


/* ───────────── billing readiness ───────────── */

const log = (mut: Mut, deps: LifecycleDeps, action: string, detail: string, ok = true) =>
  mut(x => ({ ...x, billingLog: [...(x.billingLog ?? []), { at: deps.now(), action, detail, ok } satisfies BillingLogEntry].slice(-60) }));
const MAX_REPRICES = 4;
const orderGraph = (orderId: string) => ({ graphId: "updateOrder", records: [{ referenceId: orderId, record: { attributes: { type: "Order", method: "PATCH", id: orderId } } }] });

async function orderPricing(api: RampApi, orderId: string): Promise<OrderPricing> {
  const [o] = await api.query<{ CalculationStatus?: string | null; LastPricedDate?: string | null }>(`SELECT CalculationStatus, LastPricedDate FROM Order WHERE Id = ${soql(orderId)}`);
  return { calculationStatus: o?.CalculationStatus ?? null, lastPricedDate: o?.LastPricedDate ?? null };
}

/**
 * Re-read readiness, run the ONE next action, repeat — until ready, waiting for Salesforce, blocked, or a decision only the user can
 * make (needs-input: the transaction page shows the products / order products and real Salesforce choices, then resumes here).
 * Every write is read back by the service that makes it; the order is never activated here.
 */
async function prepareBilling(api: RampApi, d0: LifecycleTransaction, call: Call, deps: LifecycleDeps, mut: Mut): Promise<StepOutcome> {
  if (!deps.billing) return fail("Billing readiness isn't available in this context.");
  let d = d0;
  const m: Mut = f => { mut(f); d = f(d); };
  const orderId = d.sf.orderId!;
  const label = () => d.sf.orderNumber ?? orderId;
  for (let round = 0; round < 12; round++) {
    let pricing = await orderPricing(api, orderId);
    if (d.sf.orderPriceRequestedAt) {
      if (PRICING_BUSY.test(pricing.calculationStatus ?? "")) return wait(`Salesforce is pricing order ${label()} (CalculationStatus ${pricing.calculationStatus}).`);
      if (PRICING_FAILED.test(pricing.calculationStatus ?? "")) {
        m(x => ({ ...x, sf: { ...x.sf, orderPriceRequestedAt: null } }));
        log(m, deps, "Re-price order", `Salesforce pricing failed (CalculationStatus ${pricing.calculationStatus}).`, false);
        return fail(`Salesforce couldn't price order ${label()}: CalculationStatus ${pricing.calculationStatus}. Check the order's pricing in Salesforce, then resume.`);
      }
    }
    if (d.sf.orderPriceRequestedAt && pricedSince(pricing, d.sf.orderPriceRequestedAt)) {
      const at = d.sf.orderPriceRequestedAt;
      log(m, deps, "Re-price order", `Priced by Salesforce: ${pricing.calculationStatus}, LastPricedDate ${pricing.lastPricedDate}.`);
      m(x => ({ ...x, sf: { ...x.sf, orderPriceRequestedAt: null, billingDirty: Date.parse(x.sf.billingChangedAt ?? "") > Date.parse(at) ? x.sf.billingDirty : false } }));
    }
    const snap = await deps.billing.load(orderId);
    const a = nextBillingAction(snap, pricing, d);
    switch (a.type) {
      case "ready":
        m(x => ({ ...x, billingNeeds: [], sf: { ...x.sf, orderPriceRequestedAt: null } }));
        log(m, deps, "Billing ready", a.summary.join(" · "));
        return ok(`Order ${label()} is billing-ready — read back from Salesforce: ${a.summary.join("; ")}.`);
      case "needs":
        m(x => ({ ...x, billingNeeds: a.needs }));
        log(m, deps, "Your input needed", a.needs.map(n => n.message).join(" "), false);
        return needsInput(`${a.needs.length} billing decision${a.needs.length > 1 ? "s" : ""} needed before the order can be activated: ${a.needs.map(n => n.message).join(" ")}`);
      case "blocked":
        log(m, deps, "Blocked", a.message, false);
        return fail(`Order ${label()} can't be made billing-ready: ${a.message}`);
      case "set-details": {
        const r = await deps.billing.setDetails(orderId, a.input, snap.stateToken);
        log(m, deps, "Bill-To & addresses", r.ok ? a.summary : `${a.summary} — ${r.error}`, r.ok);
        if (!r.ok) return fail(`Couldn't set the order's Bill-To / addresses: ${r.error}`);
        m(x => ({ ...x, billingNeeds: [], sf: { ...x.sf, orderBillingHash: a.hash, billingChangedAt: deps.now(), billingDirty: true } }));
        continue;
      }
      case "assign-policy": {
        const res = a.resolution;
        const r = await deps.billing.assignPolicy(res.productId, res.policyId, res.previousPolicyId);
        log(m, deps, "Billing Policy → product", `${res.productName}: ${res.policyName}${r.ok ? "" : ` — ${r.error}`}`, r.ok);
        if (!r.ok) return fail(`Couldn't assign Billing Policy "${res.policyName}" to ${res.productName}: ${r.error}`);
        m(x => ({ ...x, billingNeeds: [], billingResolutions: { policies: (x.billingResolutions?.policies ?? []).map(p => (p.productId === res.productId ? { ...p, appliedAt: deps.now() } : p)), treatments: x.billingResolutions?.treatments ?? [] }, sf: { ...x.sf, billingChangedAt: deps.now(), billingDirty: true } }));
        continue;
      }
      case "reprice": {
        const count = d.sf.orderRepriceCount ?? 0;
        if (count >= MAX_REPRICES) return fail(`Order ${label()} was re-priced ${count} times and its prices still aren't current (${a.reason}) — check the order's pricing in Salesforce.`);
        const at = deps.now();
        m(x => ({ ...x, sf: { ...x.sf, orderPriceRequestedAt: at, orderRepriceCount: count + 1 } }));
        const body = { pricingPref: "Force", graph: orderGraph(orderId) };
        const r = await call("POST", PLACE, body);
        if (connectFailed(r.status, r.body)) {
          m(x => ({ ...x, sf: { ...x.sf, orderPriceRequestedAt: null } }));
          log(m, deps, "Re-price order", `${a.reason} Salesforce rejected it: ${sfMessage(r.body, `HTTP ${r.status}`)}`, false);
          return fail(`Salesforce didn't re-price order ${label()} (Place Sales Transaction, pricingPref Force): ${sfMessage(r.body, `HTTP ${r.status}`)}`);
        }
        const until = Date.now() + (deps.waitMs ?? WAIT_MS);
        for (;;) {
          pricing = await orderPricing(api, orderId);
          if (pricedSince(pricing, at) || PRICING_FAILED.test(pricing.calculationStatus ?? "")) break;
          if (Date.now() >= until) { log(m, deps, "Re-price order", `${a.reason} Requested — Salesforce is still pricing.`); return wait(`Re-pricing order ${label()} in Salesforce (CalculationStatus ${pricing.calculationStatus ?? "unknown"}).`); }
          await deps.sleep(2000);
        }
        if (!pricedSince(pricing, at)) continue; // a failure is reported at the top of the next round
        log(m, deps, "Re-price order", `${a.reason} Priced by Salesforce: ${pricing.calculationStatus}, LastPricedDate ${pricing.lastPricedDate}.`);
        m(x => ({ ...x, sf: { ...x.sf, orderPriceRequestedAt: null, billingDirty: false } }));
        continue;
      }
      case "apply-setup": {
        const r = await deps.billing.applySetup(orderId, a.operations, snap.stateToken);
        log(m, deps, "Order Setup", r.ok ? `${a.summary}${r.message ? ` — ${r.message}` : ""}` : `${a.summary} — ${r.error}`, r.ok);
        if (!r.ok) return fail(`Order Setup couldn't apply ${a.operations.join(", ")}: ${r.error}`);
        m(x => ({ ...x, sf: { ...x.sf, billingChangedAt: deps.now(), billingDirty: true } }));
        continue;
      }
      case "set-treatment": {
        const res = a.resolution;
        const r = await deps.billing.setTreatment(res.orderItemId, res.treatmentId, res.policyId);
        log(m, deps, "Billing Treatment → order product", `${res.productName}: ${res.treatmentName}${r.ok ? "" : ` — ${r.error}`}`, r.ok);
        if (!r.ok) return fail(`Couldn't set Billing Treatment "${res.treatmentName}" on ${res.productName}'s order product: ${r.error}`);
        m(x => ({ ...x, billingNeeds: [], billingResolutions: { policies: x.billingResolutions?.policies ?? [], treatments: (x.billingResolutions?.treatments ?? []).map(t => (t.orderItemId === res.orderItemId ? { ...t, appliedAt: deps.now() } : t)) }, sf: { ...x.sf, billingChangedAt: deps.now(), billingDirty: true } }));
        continue;
      }
    }
  }
  return wait("Billing readiness is still in progress — it continues from the current Salesforce state.");
}

const QUOTE_ADDRESS: Record<"billing" | "shipping", Record<"street" | "city" | "state" | "postalCode" | "country", string>> = {
  billing: { street: "BillingStreet", city: "BillingCity", state: "BillingState", postalCode: "BillingPostalCode", country: "BillingCountry" },
  shipping: { street: "ShippingStreet", city: "ShippingCity", state: "ShippingState", postalCode: "ShippingPostalCode", country: "ShippingCountry" },
};
/**
 * Bill-To + addresses on the lifecycle quote (Quote.BillToContactId — else Quote.ContactId — and Billing / Shipping address), once per
 * change of the chosen values, only fields this org lets the user update; read back. Not required for activation (the ORDER fields
 * are, and prepare-billing sets them), so a refusal is recorded with Salesforce's exact error and the lifecycle continues.
 */
async function quoteBillingDetails(api: RampApi, d: LifecycleTransaction, call: Call, deps: LifecycleDeps, mut: Mut): Promise<void> {
  const b = d.billing;
  const hash = billingHash(b);
  if (!b || !hash || hash === d.sf.quoteBillingHash) return;
  const desc = await api.describe("Quote");
  const writable = new Set(((desc?.fields as { name: string; updateable?: boolean }[] | undefined) ?? []).filter(f => f.updateable).map(f => f.name));
  const fields: Record<string, unknown> = {};
  const contactField = writable.has("BillToContactId") ? "BillToContactId" : writable.has("ContactId") ? "ContactId" : null;
  if (b.billToContactId && contactField) fields[contactField] = b.billToContactId;
  for (const kind of ["billing", "shipping"] as const) {
    const addr = kind === "billing" ? b.billingAddress : b.shippingAddress;
    if (!addressComplete(addr)) continue;
    for (const [k, f] of Object.entries(QUOTE_ADDRESS[kind])) if (writable.has(f)) fields[f] = addr[k as keyof typeof addr];
  }
  if (!Object.keys(fields).length) return;
  const r = await call("PATCH", `/sobjects/Quote/${d.sf.quoteId}`, fields);
  if (r.status >= 300) {
    log(mut, deps, "Quote Bill-To & addresses", `Salesforce refused: ${sfMessage(r.body, `HTTP ${r.status}`)} — the order's own fields are set before activation.`, false);
    mut(x => ({ ...x, sf: { ...x.sf, quoteBillingHash: hash } }));
    return;
  }
  const [q] = await api.query<Record<string, unknown>>(`SELECT ${Object.keys(fields).join(", ")} FROM Quote WHERE Id = ${soql(d.sf.quoteId!)}`);
  const okBack = !!q && (!contactField || !fields[contactField] || String(q[contactField] ?? "").slice(0, 15) === String(fields[contactField]).slice(0, 15));
  log(mut, deps, "Quote Bill-To & addresses", okBack ? `Set on quote ${d.sf.quoteNumber ?? d.sf.quoteId}: ${Object.keys(fields).join(", ")}.` : "Salesforce accepted the update but the quote doesn't show the Bill-To Contact.", okBack);
  mut(x => ({ ...x, sf: { ...x.sf, quoteBillingHash: hash } }));
}
