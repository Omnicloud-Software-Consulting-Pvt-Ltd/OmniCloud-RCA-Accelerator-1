import { daysBetween, addMonths, generateSchedule, salesforceSegmentType, wholeMonths } from "@/lib/ramp/schedule";
import { groupEligibility, lineEligibility } from "@/lib/ramp/eligibility";
import { applyOutcome, nextStep, QUOTE_BUSY, QUOTE_FAILED, startStep, verificationPassed, verifySegments, type StepOutcome } from "@/lib/ramp/execution";
import type { GeneratedSegment, RampDealDraft, RampExecution, SalesforceCall, StepId, VerificationCheck } from "@/lib/ramp/types";
import { connectFailed, sfMessage, soql, type RampApi } from "./api";
import { asyncStatus, capabilities, lineFacts, objectCaps, productFacts, productRampSegments, quoteFacts, quoteGroups, quoteLines, quotePricing, segmentLines } from "./reads";

/**
 * RAMP STEP RUNNER — runs ONE step of a line or group ramp against Salesforce and returns the updated execution (the route persists
 * it). Verified API contracts (Revenue Management Developer Guide v68 + live p12 calls):
 *  · Line ramp: POST /connect/revenue-management/sales-transaction-contexts/{lineId}/actions/ramp-deal-create
 *      { transactionId, transactionLineId, subscriptionTerm, subscriptionTermUnit: "Months", segmentType: "Yearly" | … } → transactionContextId
 *    then POST /connect/rev/sales-transaction/actions/place { pricingPref, contextDetails: { contextId }, graph: updateQuote }.
 *  · Group ramp: place { groupRampAction: "EditGroup", graph: Quote PATCH + QuoteLineGroup PATCH { IsRamped, SegmentType, StartDate,
 *    EndDate, SortOrder } } converts the group into segment 1; POST /connect/rev/sales-transaction/actions/clone { recordIds: [last
 *    segment group], salesTransactionId, options: { lineScope: "AllLines" } } adds the next segment (only the LAST can be cloned; async);
 *    place { groupRampAction: "EditRampSchedule" } sets every segment's dates.
 *  · Price persistence: place { pricingPref: "Force", graph: updateQuote } — async; success is decided ONLY by reading back
 *    Quote.CalculationStatus + LastPricedDate and the lines' NetUnitPrice / ApplUnitPriceUpliftPct (Instant Pricing never saves).
 * Every write step re-reads Salesforce first and skips what already exists, so a retry or resume never creates duplicates.
 */

const PLACE = "/connect/rev/sales-transaction/actions/place";
const CLONE = "/connect/rev/sales-transaction/actions/clone";
/** How long one request waits for Salesforce's async processing before handing back "waiting" (the client polls again). */
const WAIT_MS = 18_000;
/** A step still waiting after this long fails with Salesforce's last known state (no silent hang). */
const GIVE_UP_MS = 10 * 60_000;

export interface RunDeps { now: () => string; sleep: (ms: number) => Promise<void>; waitMs?: number }
export const realDeps: RunDeps = { now: () => new Date().toISOString(), sleep: ms => new Promise(r => setTimeout(r, ms)) };

export function dealPreview(deal: RampDealDraft): GeneratedSegment[] {
  return generateSchedule(deal.schedule, { contractStart: deal.contractStart, contractEnd: deal.contractEnd, basePrice: deal.basePrice, baseQuantity: deal.baseQuantity, ignoreQuantityOverrides: deal.kind === "group" }).segments;
}

const updateQuoteGraph = (quoteId: string, extra: unknown[] = []) => ({ graphId: "updateQuote", records: [{ referenceId: quoteId, record: { attributes: { type: "Quote", method: "PATCH", id: quoteId } } }, ...extra] });
const groupRecord = (id: string, fields: Record<string, unknown>) => ({ referenceId: id, record: { attributes: { type: "QuoteLineGroup", method: "PATCH", id }, ...fields } });

/** Run the next step. Never throws for Salesforce errors — they become a failed step with Salesforce's message. */
export async function runNextStep(api: RampApi, deal: RampDealDraft, exec: RampExecution, deps: RunDeps = realDeps): Promise<RampExecution> {
  const step = nextStep(exec);
  if (!step) return exec;
  let e = startStep(exec, step.id, deps.now());
  const calls: SalesforceCall[] = [];
  const call = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => {
    const r = await api.call(method, path, body);
    const b = (r.body ?? {}) as Record<string, unknown>;
    calls.push({ at: deps.now(), method, path, request: body, status: r.status, response: r.body, requestId: (typeof b.requestIdentifier === "string" ? b.requestIdentifier : typeof b.requestId === "string" ? b.requestId : null) });
    return r;
  };
  let outcome: StepOutcome;
  try {
    outcome = deal.kind === "line" ? await lineStep(step.id, api, deal, e, call, deps, m => (e = m(e))) : await groupStep(step.id, api, deal, e, call, deps, m => (e = m(e)));
  } catch (err) {
    outcome = { status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
  const elapsed = Date.parse(deps.now()) - Date.parse(e.steps.find(s => s.id === step.id)!.startedAt ?? deps.now());
  if (outcome.status === "waiting" && elapsed > GIVE_UP_MS) outcome = { status: "failed", message: `${outcome.message} Salesforce hadn't finished after ${Math.round(GIVE_UP_MS / 60000)} minutes — check the quote in Salesforce, then Retry (the step re-reads Salesforce before writing again).` };
  e = { ...e, steps: e.steps.map(s => (s.id === step.id ? { ...s, calls: [...s.calls, ...calls], wrote: s.wrote || calls.some(c => c.method !== "GET") } : s)) };
  return applyOutcome(e, step.id, outcome, deps.now());
}

type Call = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
type Mut = (m: (e: RampExecution) => RampExecution) => void;
const ok = (message: string): StepOutcome => ({ status: "completed", message });
const fail = (message: string): StepOutcome => ({ status: "failed", message });
const wait = (message: string): StepOutcome => ({ status: "waiting", message });

function statusUrlOf(body: unknown): string | null { const b = (body ?? {}) as Record<string, unknown>; return typeof b.statusURL === "string" ? b.statusURL : null; }

/** Poll the quote (and the async tracker if given) until Salesforce isn't busy, or WAIT_MS passes. */
async function settle(api: RampApi, quoteId: string, statusUrl: string | null, deps: RunDeps): Promise<{ busy: boolean; failed: string | null; calculationStatus: string | null; lastPricedDate: string | null }> {
  const until = Date.now() + (deps.waitMs ?? WAIT_MS);
  for (;;) {
    const q = await quotePricing(api, quoteId);
    const a = statusUrl ? await asyncStatus(api, statusUrl) : { status: null, error: null };
    const asyncBusy = !!a.status && !/^(Completed|Success|Failed|Error|Aborted|Cancelled|CompletedWithErrors)$/i.test(a.status);
    const asyncFailed = a.status && /Fail|Error|Abort/i.test(a.status) ? `${a.status}${a.error ? `: ${a.error}` : ""}` : null;
    const busy = asyncBusy || QUOTE_BUSY.includes(q.calculationStatus ?? "");
    const failed = asyncFailed ?? (QUOTE_FAILED.includes(q.calculationStatus ?? "") ? `Quote CalculationStatus = ${q.calculationStatus}` : null);
    if (!busy || failed || Date.now() >= until) return { busy: busy && !failed, failed, ...q };
    await deps.sleep(2000);
  }
}

async function priceStep(api: RampApi, quoteId: string, e: RampExecution, call: Call, deps: RunDeps, mut: Mut): Promise<StepOutcome> {
  const priceStepState = e.steps.find(s => s.id === "price")!;
  // Already requested and the quote has been priced since → done (never re-send a price request that Salesforce is processing).
  if (e.sf.priceRequestedAt && priceStepState.wrote) {
    const s = await settle(api, quoteId, null, deps);
    if (s.failed) return fail(`Salesforce pricing failed: ${s.failed}. Retry sends one new pricing request.`);
    if (s.busy) return wait(`Salesforce is still pricing the quote (CalculationStatus ${s.calculationStatus}).`);
    if (s.lastPricedDate && Date.parse(s.lastPricedDate) >= Date.parse(e.sf.priceRequestedAt) - 5000) return ok(`Quote priced and saved (CalculationStatus ${s.calculationStatus}, LastPricedDate ${s.lastPricedDate}).`);
    if (priceStepState.status !== "failed") return wait(`Waiting for Salesforce to save the prices (CalculationStatus ${s.calculationStatus ?? "unknown"}, LastPricedDate ${s.lastPricedDate ?? "none"}).`);
  }
  const requestedAt = deps.now();
  mut(x => ({ ...x, sf: { ...x.sf, priceRequestedAt: requestedAt } }));
  const body = { pricingPref: "Force", graph: updateQuoteGraph(quoteId) };
  const r = await call("POST", PLACE, body);
  if (connectFailed(r.status, r.body)) return fail(`Place Sales Transaction (pricingPref Force) failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
  const s = await settle(api, quoteId, statusUrlOf(r.body), deps);
  if (s.failed) return fail(`Salesforce pricing failed: ${s.failed}.`);
  if (s.busy || !s.lastPricedDate || Date.parse(s.lastPricedDate) < Date.parse(requestedAt) - 5000) return wait(`Pricing requested; waiting for Salesforce to save it (CalculationStatus ${s.calculationStatus ?? "unknown"}).`);
  return ok(`Quote priced and saved (CalculationStatus ${s.calculationStatus}, LastPricedDate ${s.lastPricedDate}).`);
}

/** Group ramp: what Salesforce saved on each segment GROUP (uplift, method, discount) against the plan. */
export function groupChecks(groups: { id: string; name: string; unitPriceUplift: number | null; rampUpliftType: string | null; discount?: number | null }[], preview: GeneratedSegment[], method: string, qlg?: { fields: Record<string, { updateable?: boolean }> }): VerificationCheck[] {
  const out: VerificationCheck[] = [];
  const add = (id: string, label: string, expected: string, actual: string) => out.push({ id, label, passed: expected === actual, expected, actual, severity: "error" });
  groups.forEach((g, i) => {
    const p = preview[i];
    if (!p) return;
    if (qlg?.fields.UnitPriceUplift?.updateable !== false) add(`group-uplift-${g.id}`, `${g.name}: segment uplift (QuoteLineGroup.UnitPriceUplift)`, `${p.upliftPercent}%`, `${g.unitPriceUplift ?? 0}%`);
    if (qlg?.fields.RampUpliftType?.updateable) add(`group-method-${g.id}`, `${g.name}: uplift method (RampUpliftType)`, method, g.rampUpliftType ?? "blank");
    if (qlg?.fields.Discount && (p.discount || g.discount)) add(`group-discount-${g.id}`, `${g.name}: segment discount (QuoteLineGroup.Discount)`, `${p.discount}%`, `${g.discount ?? 0}%`);
  });
  return out;
}

async function verifyStep(api: RampApi, deal: RampDealDraft, e: RampExecution, mut: Mut, productsPerSegment?: number, extra: VerificationCheck[] = []): Promise<StepOutcome> {
  const quoteId = e.sf.quoteId!;
  const segments = deal.kind === "line" ? await segmentLines(api, quoteId, { rampIdentifier: e.sf.rampIdentifier! }) : await segmentLines(api, quoteId, { groupIds: e.sf.segmentGroupIds });
  const quote = await quotePricing(api, quoteId);
  const caps = await capabilities(api);
  const checks = [...verifySegments({ kind: deal.kind, expected: dealPreview(deal), actual: segments, quote, priceRequestedAt: e.sf.priceRequestedAt, appliedUpliftField: caps.pricing.appliedUplift, productsPerSegment }), ...extra];
  mut(x => ({ ...x, segments, quote, verification: checks }));
  const failed = checks.filter(c => !c.passed && c.severity === "error");
  return verificationPassed(checks) ? ok(`All ${checks.length} checks passed against Salesforce.`) : fail(`${failed.length} check(s) failed: ${failed.slice(0, 4).map(c => `${c.label} (expected ${c.expected}, Salesforce has ${c.actual})`).join("; ")}${failed.length > 4 ? "; …" : ""}`);
}

/* ───────────── line ramp ───────────── */

async function lineStep(id: StepId, api: RampApi, deal: RampDealDraft, e: RampExecution, call: Call, deps: RunDeps, mut: Mut): Promise<StepOutcome> {
  const quoteId = e.sf.quoteId!, lineId = e.sf.lineId!;
  const preview = dealPreview(deal);
  switch (id) {
    case "validate": {
      const caps = await capabilities(api);
      if (!caps.lineRamp.available) return fail(caps.lineRamp.reason!);
      const [quote, line] = await Promise.all([quoteFacts(api, quoteId), lineFacts(api, lineId)]);
      if (line?.rampIdentifier && e.steps.some(s => s.id === "stage" && s.wrote)) return ok("Line already ramped by this run — continuing.");
      const product = line?.productId ? (await productFacts(api, [line.productId])).get(line.productId) ?? null : null;
      const segs = line?.productId ? await productRampSegments(api, [line.productId]) : [];
      const el = lineEligibility(line, quote, product, segs);
      if (!el.eligible) return fail(el.reasons.filter(r => r.severity === "error").map(r => r.message).join(" "));
      if (deal.schedule.period !== "Yearly") return fail("Salesforce generates line-ramp segments itself as Yearly anniversary segments (ramp-deal-create segmentType Yearly). Monthly / quarterly / custom boundaries need a Group Ramp, where the app sets every segment's dates.");
      if (line!.startDate !== deal.contractStart || line!.endDate !== deal.contractEnd) return fail(`The line runs ${line!.startDate} → ${line!.endDate} but the deal is set for ${deal.contractStart} → ${deal.contractEnd}. Salesforce splits the line's own dates — set the deal dates to the line's (or change the line in the quote).`);
      if (!wholeMonths(line!.startDate!, line!.endDate!)) return fail("The line's dates aren't a whole number of months (start → the day before the same day N months later).");
      if (deal.schedule.upliftMethod === "Compound" && !caps.compound.line) return fail(`Compound uplift can't be requested on a line ramp in this org (QuoteLineItem.RampUpliftType is read-only) — use a Group Ramp for compound uplift, or Standard here.`);
      if (preview.length < 2) return fail("The schedule produces fewer than two segments.");
      return ok(`Eligible: ${el.reasons.length ? el.reasons.map(r => r.message).join(" ") : "quote Draft, line term-based, product rampable."}`);
    }
    case "stage": {
      const line = await lineFacts(api, lineId);
      if (line?.rampIdentifier) { mut(x => ({ ...x, sf: { ...x.sf, rampIdentifier: line.rampIdentifier } })); return { status: "skipped", message: `Already ramped (RampIdentifier ${line.rampIdentifier}) — nothing staged.` }; }
      if (e.sf.contextId) return { status: "skipped", message: `Staged earlier (context ${e.sf.contextId}) — not staged again.` };
      const months = wholeMonths(line!.startDate!, line!.endDate!)!;
      const body: Record<string, unknown> = { transactionId: quoteId, transactionLineId: lineId, subscriptionTerm: months, subscriptionTermUnit: "Months", segmentType: salesforceSegmentType(deal.schedule.period) };
      if (deal.schedule.trialMonths) { body.trialTerm = daysBetween(line!.startDate!, addMonths(line!.startDate!, deal.schedule.trialMonths)); body.trialTermUnit = "Days"; }
      const r = await call("POST", `/connect/revenue-management/sales-transaction-contexts/${encodeURIComponent(lineId)}/actions/ramp-deal-create`, body);
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (connectFailed(r.status, r.body)) return fail(`Ramp Deal Create failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
      const ctx = typeof b.transactionContextId === "string" ? b.transactionContextId : null;
      if (!ctx) return fail("Ramp Deal Create returned no transactionContextId.");
      mut(x => ({ ...x, sf: { ...x.sf, contextId: ctx } }));
      return ok(`Staged in Salesforce context ${ctx} (${months} months, ${body.segmentType}).`);
    }
    case "commit": {
      const before = await lineFacts(api, lineId);
      if (before?.rampIdentifier) { mut(x => ({ ...x, sf: { ...x.sf, rampIdentifier: before.rampIdentifier } })); return ok(`Committed (RampIdentifier ${before.rampIdentifier}).`); }
      const commitStep = e.steps.find(s => s.id === "commit")!;
      if (!commitStep.wrote) {
        if (!e.sf.contextId) return fail("No staged context to commit — retry the Stage step.");
        const r = await call("POST", PLACE, { pricingPref: "Skip", contextDetails: { contextId: e.sf.contextId }, graph: updateQuoteGraph(quoteId) });
        if (connectFailed(r.status, r.body)) return fail(`Place Sales Transaction didn't commit the ramp: ${sfMessage(r.body, `HTTP ${r.status}`)}. Not retried automatically; the staged context is kept.`);
        await settle(api, quoteId, statusUrlOf(r.body), deps);
      }
      const after = await lineFacts(api, lineId);
      let ramp = after?.rampIdentifier ?? null;
      if (!ramp && !after && before?.productId) {
        // Salesforce may replace the base line with segment lines — find the ramp it produced for this product on this quote.
        const rows = await api.query<{ RampIdentifier: string }>(`SELECT RampIdentifier FROM QuoteLineItem WHERE QuoteId = ${soql(quoteId)} AND Product2Id = ${soql(before.productId)} AND RampIdentifier != null ORDER BY CreatedDate DESC LIMIT 1`);
        ramp = rows[0]?.RampIdentifier ?? null;
      }
      if (!ramp) return wait("Commit sent; waiting for Salesforce to create the segment lines.");
      mut(x => ({ ...x, sf: { ...x.sf, rampIdentifier: ramp } }));
      return ok(`Committed — RampIdentifier ${ramp}.`);
    }
    case "read-back": {
      const segs = await segmentLines(api, quoteId, { rampIdentifier: e.sf.rampIdentifier! });
      mut(x => ({ ...x, segments: segs, sf: { ...x.sf, segmentLineIds: segs.map(s => s.id) } }));
      if (!segs.length) return wait("No segment lines yet.");
      return ok(`${segs.length} segment line(s): ${segs.map(s => `${s.name ?? s.id} ${s.startDate}→${s.endDate}`).join(", ")}${segs.length !== preview.length ? ` (the preview planned ${preview.length} — Salesforce's segments are used)` : ""}.`);
    }
    case "segment-values": {
      const caps = await objectCaps(api);
      const can = (f: string) => !!caps.QuoteLineItem?.fields[f]?.updateable;
      const segs = (await segmentLines(api, quoteId, { rampIdentifier: e.sf.rampIdentifier! })).sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
      const lines = await quoteLines(api, quoteId);
      const notes: string[] = [];
      let changed = 0;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], p = preview[Math.min(i, preview.length - 1)];
        const fields: Record<string, unknown> = {};
        if (can("Quantity") && s.quantity !== p.quantity) fields.Quantity = p.quantity;
        if (can("Discount") && (s.discount ?? 0) !== p.discount) fields.Discount = p.discount;
        if (can("UnitPriceUplift") && (s.unitPriceUplift ?? 0) !== p.upliftPercent) fields.UnitPriceUplift = p.upliftPercent;
        if (can("PeriodBoundary") && !lines.find(l => l.id === s.id)?.periodBoundary) fields.PeriodBoundary = deal.periodBoundary;
        if (!Object.keys(fields).length) continue;
        const r = await call("PATCH", `/sobjects/QuoteLineItem/${encodeURIComponent(s.id)}`, fields);
        if (r.status >= 300) return fail(`${s.name ?? s.id}: Salesforce refused ${Object.keys(fields).join(", ")}: ${sfMessage(r.body, `HTTP ${r.status}`)}. ${changed} segment(s) were updated before this; retry continues with the rest.`);
        changed++;
      }
      for (const f of ["Quantity", "Discount", "UnitPriceUplift"]) if (!can(f)) notes.push(`${f} isn't updateable for your user — left as Salesforce set it.`);
      return ok(`${changed ? `Updated ${changed} segment line(s)` : "Every segment already had the planned values"}.${notes.length ? ` ${notes.join(" ")}` : ""}`);
    }
    case "price": return priceStep(api, quoteId, e, call, deps, mut);
    case "verify": return verifyStep(api, deal, e, mut);
    default: return { status: "skipped", message: "Not part of a line ramp." };
  }
}

/* ───────────── group ramp ───────────── */

/** This run's segment groups: the converted group + ramped groups that appeared after the run started (never another ramp on the quote). */
async function rampedGroups(api: RampApi, quoteId: string, e?: RampExecution) {
  const base = e?.sf.baselineGroupIds;
  return (await quoteGroups(api, quoteId)).filter(g => g.isRamped && (!base || g.id === e!.sf.groupId || !base.includes(g.id))).sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? "") || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

async function groupStep(id: StepId, api: RampApi, deal: RampDealDraft, e: RampExecution, call: Call, deps: RunDeps, mut: Mut): Promise<StepOutcome> {
  const quoteId = e.sf.quoteId!, groupId = e.sf.groupId!;
  const preview = dealPreview(deal);
  const caps = await capabilities(api);
  const qlg = (await objectCaps(api)).QuoteLineGroup;
  const compoundWanted = deal.schedule.upliftMethod === "Compound";
  switch (id) {
    case "validate": {
      if (!caps.groupRamp.available) return fail(caps.groupRamp.reason!);
      if (compoundWanted && !caps.compound.group) return fail(caps.compound.reason ?? "Compound uplift isn't available for group ramps in this org.");
      const [quote, groups, lines] = await Promise.all([quoteFacts(api, quoteId), quoteGroups(api, quoteId), quoteLines(api, quoteId)]);
      const group = groups.find(g => g.id === groupId) ?? null;
      if (group?.isRamped && e.steps.some(s => s.id === "convert-group" && s.wrote)) return ok("Group already converted by this run — continuing.");
      const glines = lines.filter(l => l.groupId === groupId);
      const products = await productFacts(api, glines.map(l => l.productId!).filter(Boolean));
      const segs = await productRampSegments(api, [...products.keys()]);
      const byProduct = new Map<string, typeof segs>();
      for (const s of segs) byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
      const el = groupEligibility({ quote, groupId, groups, lines, products, segmentsByProduct: byProduct });
      // Remember which groups existed before this run, so read-back / verify only look at THIS ramp's segments (a quote can hold several).
      if (!e.sf.baselineGroupIds) mut(x => ({ ...x, sf: { ...x.sf, baselineGroupIds: groups.map(g => g.id) } }));
      if (!el.eligible) return fail(el.reasons.filter(r => r.severity === "error").map(r => r.message).join(" "));
      const seg1Type = preview[0]?.kind === "trial" ? "FreeTrial" : salesforceSegmentType(deal.schedule.period);
      if (caps.groupRamp.segmentTypes.length && !caps.groupRamp.segmentTypes.includes(seg1Type === "FreeTrial" ? "Custom" : seg1Type)) return fail(`QuoteLineGroup.SegmentType has no "${seg1Type}" value in this org (${caps.groupRamp.segmentTypes.join(", ")}).`);
      if (preview.length < 2) return fail("The schedule produces fewer than two segments.");
      return ok(`Eligible: ${glines.length} line(s) in ${group!.name}; ${preview.length} segments planned.`);
    }
    case "convert-group": {
      const groups = await quoteGroups(api, quoteId);
      const g = groups.find(x => x.id === groupId);
      if (!g) return fail("The quote line group no longer exists.");
      if (g.isRamped) { mut(x => ({ ...x, sf: { ...x.sf, segmentGroupIds: [groupId] } })); return { status: e.steps.find(s => s.id === "convert-group")!.wrote ? "completed" : "skipped", message: `${g.name} is a ramp segment (IsRamped = true).` }; }
      if (e.steps.find(s => s.id === "convert-group")!.wrote) {
        const st = await settle(api, quoteId, null, deps);
        if (st.failed) return fail(`Salesforce failed converting the group: ${st.failed}.`);
        return st.busy ? wait("Waiting for Salesforce to convert the group.") : fail(`Salesforce accepted EditGroup but ${g.name} isn't ramped (CalculationStatus ${st.calculationStatus}). Retry sends EditGroup once more.`);
      }
      const p = preview[0];
      const fields: Record<string, unknown> = { StartDate: p.startDate, EndDate: p.endDate, SortOrder: 1, IsRamped: true, SegmentType: p.kind === "trial" ? "Custom" : salesforceSegmentType(deal.schedule.period) };
      const r = await call("POST", PLACE, { groupRampAction: "EditGroup", pricingPref: "Skip", graph: updateQuoteGraph(quoteId, [groupRecord(groupId, fields)]) });
      if (connectFailed(r.status, r.body)) return fail(`EditGroup failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
      const st = await settle(api, quoteId, statusUrlOf(r.body), deps);
      if (st.failed) return fail(`Salesforce failed converting the group: ${st.failed}.`);
      const after = (await quoteGroups(api, quoteId)).find(x => x.id === groupId);
      if (!after?.isRamped) return wait("EditGroup sent; waiting for Salesforce to mark the group as a ramp segment.");
      mut(x => ({ ...x, sf: { ...x.sf, segmentGroupIds: [groupId] } }));
      return ok(`${after.name} is now segment 1 (${after.startDate} → ${after.endDate}).`);
    }
    case "clone-segments": {
      const ramped = await rampedGroups(api, quoteId, e);
      mut(x => ({ ...x, sf: { ...x.sf, segmentGroupIds: ramped.map(g => g.id) } }));
      if (ramped.length >= preview.length) return ok(`${ramped.length} segment group(s) exist.`);
      // Only ONE clone is in flight at a time: a clone requested at count k is waited for (never re-sent) until the count moves.
      const marker = `clone@${ramped.length}`;
      if (e.sf.asyncRequestIds.includes(marker) && e.steps.find(s => s.id === "clone-segments")!.wrote) {
        const st = await settle(api, quoteId, null, deps);
        if (st.failed) return fail(`Salesforce failed cloning segment ${ramped.length + 1}: ${st.failed}.`);
        return wait(`Waiting for Salesforce to create segment ${ramped.length + 1} of ${preview.length}.`);
      }
      const last = ramped[ramped.length - 1];
      const r = await call("POST", CLONE, { recordIds: [last.id], salesTransactionId: quoteId, options: { lineScope: "AllLines" } });
      if (connectFailed(r.status, r.body)) return fail(`Clone Sales Transaction failed for segment ${ramped.length + 1}: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
      mut(x => ({ ...x, sf: { ...x.sf, asyncRequestIds: [...x.sf.asyncRequestIds, marker] } }));
      await settle(api, quoteId, null, deps);
      const now = await rampedGroups(api, quoteId, e);
      mut(x => ({ ...x, sf: { ...x.sf, segmentGroupIds: now.map(g => g.id) } }));
      return now.length >= preview.length ? ok(`${now.length} segment group(s) exist.`) : wait(`Segment ${Math.min(now.length + 1, preview.length)} of ${preview.length}: ${now.length > ramped.length ? "created; cloning the next" : "clone requested"}.`);
    }
    case "edit-schedule": {
      const ramped = await rampedGroups(api, quoteId, e);
      if (ramped.length !== preview.length) return fail(`Expected ${preview.length} segment groups, Salesforce has ${ramped.length}.`);
      const changes = ramped.map((g, i) => ({ g, p: preview[i] })).filter(({ g, p }) => g.startDate !== p.startDate || g.endDate !== p.endDate);
      if (!changes.length) return ok("Every segment already has the planned dates.");
      if (e.steps.find(s => s.id === "edit-schedule")!.wrote) {
        const st = await settle(api, quoteId, null, deps);
        if (st.busy) return wait("Waiting for Salesforce to apply the segment dates.");
        if (st.failed) return fail(`Salesforce failed applying the dates: ${st.failed}.`);
      }
      const r = await call("POST", PLACE, { groupRampAction: "EditRampSchedule", pricingPref: "Skip", graph: updateQuoteGraph(quoteId, ramped.map((g, i) => groupRecord(g.id, { StartDate: preview[i].startDate, EndDate: preview[i].endDate }))) });
      if (connectFailed(r.status, r.body)) return fail(`EditRampSchedule failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
      const st = await settle(api, quoteId, statusUrlOf(r.body), deps);
      if (st.failed) return fail(`Salesforce failed applying the dates: ${st.failed}.`);
      const again = await rampedGroups(api, quoteId, e);
      const off = again.filter((g, i) => g.startDate !== preview[i]?.startDate || g.endDate !== preview[i]?.endDate);
      return off.length ? wait(`Dates sent; ${off.length} segment(s) not updated yet.`) : ok(`Dates set on ${ramped.length} segments.`);
    }
    case "segment-values": {
      // Uplift + method on EXISTING segments. EditGroup is never used here: once the quote has a ramp schedule Salesforce treats every
      // EditGroup as a conversion and refuses it ("You can't convert a group to a ramped segment when the quote has a ramp schedule",
      // p12 2026-11-10 — even for segment 1 with only Name / RampUpliftType). Segments are edited with groupRampAction EditRampSchedule
      // ("Edits details of the group ramp segments, including start and end dates" — Revenue Cloud dev guide v68): ONE request for every
      // segment of THIS ramp, each carrying its current Salesforce dates unchanged, so continuity, order and RampIdentifiers are untouched.
      // Segment names are left as Salesforce created them (renaming would need EditGroup).
      const ramped = await rampedGroups(api, quoteId, e);
      if (ramped.length !== preview.length) return fail(`Expected ${preview.length} segment groups, Salesforce has ${ramped.length}.`);
      const canUplift = !!qlg?.fields.UnitPriceUplift?.updateable;
      const canMethod = !!qlg?.fields.RampUpliftType?.updateable;
      // Segment discount = QuoteLineGroup.Discount ("discount percentage at the group level"; Salesforce's own Trial segments carry 100 —
      // p12 #39 / #40 / #43). Sent only when the plan or Salesforce has a non-zero discount, so groups without discounts are untouched.
      const canDiscount = !!qlg?.fields.Discount?.updateable;
      const discountDiffers = (g: (typeof ramped)[number], i: number) => (g.discount ?? 0) !== preview[i].discount;
      const sendDiscount = canDiscount && ramped.some(discountDiffers);
      const method = deal.schedule.upliftMethod;
      const differs = (gs: typeof ramped) => gs.filter((g, i) => (canUplift && (g.unitPriceUplift ?? 0) !== preview[i].upliftPercent) || (canMethod && g.rampUpliftType !== method) || (sendDiscount && discountDiffers(g, i)));
      const done = (n: number) => ok(`${n ? `Uplift${canMethod ? ` + method ${method}` : ""} saved on ${n} segment(s) with EditRampSchedule` : "Every segment already had the planned uplift and method"}${canMethod ? "" : " (RampUpliftType isn't updateable — Salesforce's own method kept)"}${canUplift ? "" : " (UnitPriceUplift isn't updateable — not changed)"}.`);
      const pending = differs(ramped);
      if (!canDiscount && preview.some(p => p.discount)) return fail("The schedule has segment discounts, but QuoteLineGroup.Discount isn't updateable for your user — they can't be saved. Remove the discounts or get edit access.");
      if (!pending.length) return done(0);
      if (e.steps.find(s => s.id === "segment-values")!.wrote) {
        // Already sent by this run: never re-send blindly — wait for Salesforce, then report what it kept.
        const st = await settle(api, quoteId, null, deps);
        if (st.failed) return fail(`Salesforce failed applying the uplift: ${st.failed}.`);
        if (st.busy) return wait(`Waiting for Salesforce to save the uplift on ${pending.length} segment(s).`);
        return fail(`Salesforce accepted EditRampSchedule but didn't keep ${pending.map(g => `${g.name} (uplift ${g.unitPriceUplift ?? "blank"}, method ${g.rampUpliftType ?? "blank"})`).join(", ")}. Nothing else was sent — Retry sends the same EditRampSchedule once more.`);
      }
      const records = ramped.map((g, i) => groupRecord(g.id, {
        StartDate: g.startDate, EndDate: g.endDate,
        ...(canUplift ? { UnitPriceUplift: preview[i].upliftPercent } : {}),
        ...(canMethod ? { RampUpliftType: method } : {}),
        ...(sendDiscount ? { Discount: preview[i].discount } : {}),
      }));
      const r = await call("POST", PLACE, { groupRampAction: "EditRampSchedule", pricingPref: "Skip", graph: updateQuoteGraph(quoteId, records) });
      if (connectFailed(r.status, r.body)) return fail(`EditRampSchedule (uplift / method) failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`);
      const st = await settle(api, quoteId, statusUrlOf(r.body), deps);
      if (st.failed) return fail(`Salesforce failed applying the uplift: ${st.failed}.`);
      const still = differs(await rampedGroups(api, quoteId, e));
      return still.length ? wait(`EditRampSchedule sent; ${still.length} segment(s) not updated yet.`) : done(pending.length);
    }
    case "read-back": {
      const ramped = await rampedGroups(api, quoteId, e);
      const segs = await segmentLines(api, quoteId, { groupIds: ramped.map(g => g.id) });
      mut(x => ({ ...x, segments: segs, sf: { ...x.sf, segmentGroupIds: ramped.map(g => g.id), segmentLineIds: segs.map(s => s.id), rampIdentifier: x.sf.rampIdentifier ?? null } }));
      return segs.length ? ok(`${ramped.length} segment group(s), ${segs.length} segment line(s).`) : wait("No segment lines yet.");
    }
    case "price": return priceStep(api, quoteId, e, call, deps, mut);
    case "verify": {
      const first = (await quoteLines(api, quoteId)).filter(l => l.groupId === e.sf.segmentGroupIds[0]);
      const groups = await rampedGroups(api, quoteId, e);
      return verifyStep(api, deal, e, mut, new Set(first.map(l => l.productId)).size || undefined, groupChecks(groups, preview, deal.schedule.upliftMethod, qlg));
    }
    default: return { status: "skipped", message: "Not part of a group ramp." };
  }
}

/**
 * Re-price a quote and persist the prices (Ramp Pricing page): ONE place { pricingPref: "Force" } request, then read back. Reported as
 * saved only when Salesforce shows a LastPricedDate after the request and a priced CalculationStatus.
 */
export async function repriceQuote(api: RampApi, quoteId: string, deps: RunDeps = realDeps): Promise<{ ok: boolean; waiting: boolean; message: string; calls: SalesforceCall[]; requestedAt: string; quote: { calculationStatus: string | null; lastPricedDate: string | null } }> {
  const requestedAt = deps.now();
  const body = { pricingPref: "Force", graph: updateQuoteGraph(quoteId) };
  const r = await api.call("POST", PLACE, body);
  const calls: SalesforceCall[] = [{ at: requestedAt, method: "POST", path: PLACE, request: body, status: r.status, response: r.body }];
  if (connectFailed(r.status, r.body)) return { ok: false, waiting: false, message: `Place Sales Transaction (Force) failed: ${sfMessage(r.body, `HTTP ${r.status}`)}`, calls, requestedAt, quote: await quotePricing(api, quoteId) };
  const s = await settle(api, quoteId, statusUrlOf(r.body), deps);
  const quote = { calculationStatus: s.calculationStatus, lastPricedDate: s.lastPricedDate };
  if (s.failed) return { ok: false, waiting: false, message: `Salesforce pricing failed: ${s.failed}.`, calls, requestedAt, quote };
  const saved = !!s.lastPricedDate && Date.parse(s.lastPricedDate) >= Date.parse(requestedAt) - 5000 && !s.busy;
  return { ok: saved, waiting: !saved && s.busy, message: saved ? `Priced and saved (CalculationStatus ${s.calculationStatus}, LastPricedDate ${s.lastPricedDate}).` : s.busy ? `Salesforce is still pricing (CalculationStatus ${s.calculationStatus}) — refresh to check.` : `Salesforce accepted the request but the quote shows no new LastPricedDate (CalculationStatus ${s.calculationStatus ?? "unknown"}) — prices were NOT confirmed as saved.`, calls, requestedAt, quote };
}
