import { addDays, assetEligibility, day, daysBetween, isIsoDate, termEnd } from "./eligibility";
import { ACTION_TYPE, type AddedProduct, type AssetChange, type AssetFacts, type AssetSnapshot, type LifecycleKind, type LifecycleStep, type LifecycleTransaction, type StepId, type SwapKind } from "./types";

/**
 * Lifecycle planning — PURE (no Salesforce calls): the step list, transaction validation, the exact initiate* request, the
 * lifecycle-quote change plan and the original-vs-changed preview. The server feeds these with facts read from the org.
 */

/** Every transaction is quote-first: the initiate* action creates a QUOTE, never an order directly. Usage-based assets REQUIRE this
 * (Salesforce documents that a direct order can miss the usage rate-card relationships); every other asset uses it too, so pricing,
 * taxes and billing policies are applied and reviewed on a quote before an order exists. */
export const OUTPUT_TYPE = "Quote";
export const MAX_ASSETS = 1000;

const STEP_LABELS: Record<LifecycleKind, Record<StepId, string>> = {
  amend: {
    initiate: "Initiate amendment (initiateAmendment → amendment quote)", "await-quote": "Wait for Salesforce to build the amendment quote",
    "apply-changes": "Modify the amendment quote's lines", price: "Run Salesforce pricing and save the quote", validate: "Validate the amendment quote",
    "create-order": "Create the amendment order from the quote", "prepare-billing": "Make the amendment order billing-ready (Bill-To, addresses, billing policy & treatment, Salesforce re-pricing)", activate: "Activate the amendment order", verify: "Verify the updated assets",
  },
  renew: {
    initiate: "Initiate renewal (initiateRenewal → renewal quote)", "await-quote": "Wait for Salesforce to build the renewal quote",
    "apply-changes": "Apply negotiated prices / discounts", price: "Run Salesforce pricing and save the quote", validate: "Validate the renewal quote",
    "create-order": "Create the renewal order from the quote", "prepare-billing": "Make the renewal order billing-ready (Bill-To, addresses, billing policy & treatment, Salesforce re-pricing)", activate: "Activate the renewal order", verify: "Verify the renewed assets",
  },
  cancel: {
    initiate: "Initiate cancellation (initiateCancellation → cancellation quote)", "await-quote": "Wait for Salesforce to build the cancellation quote",
    "apply-changes": "Record the cancellation reason on the quote", price: "Run Salesforce pricing and save the quote", validate: "Validate the cancellation quote",
    "create-order": "Create the cancellation order from the quote", "prepare-billing": "Make the cancellation order billing-ready (Bill-To, addresses, billing policy & treatment, Salesforce re-pricing)", activate: "Activate the cancellation order", verify: "Verify the cancelled assets and billing",
  },
};
const WRITES: Record<StepId, boolean> = { initiate: true, "await-quote": false, "apply-changes": true, price: true, validate: false, "create-order": true, "prepare-billing": true, activate: true, verify: false };
export const STEP_ORDER: StepId[] = ["initiate", "await-quote", "apply-changes", "price", "validate", "create-order", "prepare-billing", "activate", "verify"];
const SWAP_LABEL: Record<SwapKind, string> = { upgrade: "Initiate upgrade (Upgrade API → amendment quote)", downgrade: "Initiate downgrade (Downgrade API → amendment quote)", swap: "Initiate swap (Swap API → amendment quote)" };
export const stepDefs = (kind: LifecycleKind, swap: SwapKind | null = null) => STEP_ORDER.map(id => ({ id, label: swap && id === "initiate" ? SWAP_LABEL[swap] : STEP_LABELS[kind][id], writes: WRITES[id] }));

/** The replacement kind when this amendment is an upgrade / downgrade / swap (then EVERY change must be one of that kind). */
export function swapKindOf(d: Pick<LifecycleTransaction, "kind" | "changes">): SwapKind | null {
  if (d.kind !== "amend") return null;
  return d.changes.find(c => c.swap)?.swap?.kind ?? null;
}
/** Salesforce Transaction Management resource for a replacement. */
export const swapPath = (k: SwapKind) => `/revenue/transaction-management/assets/actions/${k}`;

/** Whether the lifecycle quote needs line edits after Salesforce builds it (otherwise that step is skipped, nothing is sent). */
export function hasLineEdits(d: Pick<LifecycleTransaction, "kind" | "changes" | "adds" | "cancel" | "assets" | "amendSubtype">, initiatedQuantityChange: number | null = null): boolean {
  if (d.kind === "cancel") return !!(d.cancel?.reason && d.cancel.reasonField);
  if (d.kind === "renew") return d.changes.some(c => c.unitPrice != null || c.discount != null);
  if (d.amendSubtype || swapKindOf(d)) return false;
  const snap = new Map(d.assets.map(a => [a.id, a]));
  return d.adds.length > 0 || d.changes.some(c => !!c.swap || c.unitPrice != null || c.discount != null || !!c.billingFrequency || !!c.endDate || !!c.attributes?.length
    || (initiatedQuantityChange !== null && desiredDelta(c, snap.get(c.assetId)) !== initiatedQuantityChange));
}

export function blankSteps(d: Pick<LifecycleTransaction, "kind" | "changes" | "adds" | "cancel" | "assets" | "amendSubtype">): LifecycleStep[] {
  // Amendments: whether lines need patching is only known once Salesforce applied the single quantityChange — decided in the step.
  const skipEdits = (d.kind !== "amend" || !!swapKindOf(d)) && !hasLineEdits(d);
  return stepDefs(d.kind, swapKindOf(d)).map(s => ({ ...s, status: skipEdits && s.id === "apply-changes" ? "skipped" : "pending", message: skipEdits && s.id === "apply-changes" ? "No line changes requested — nothing to send." : null, startedAt: null, finishedAt: null, calls: [] }));
}
export const nextStep = (steps: LifecycleStep[]) => steps.find(s => s.status !== "completed" && s.status !== "skipped") ?? null;

/**
 * Transactions saved before billing readiness existed get the prepare-billing step (before activate): pending while the order isn't
 * activated yet; already-activated ones mark it skipped (their order was billed without it). Idempotent.
 */
export function withBillingStep(tx: LifecycleTransaction): LifecycleTransaction {
  if (tx.steps.some(s => s.id === "prepare-billing")) return tx;
  const def = stepDefs(tx.kind).find(s => s.id === "prepare-billing")!;
  const done = tx.steps.find(s => s.id === "activate")?.status === "completed";
  const step: LifecycleStep = { ...def, status: done ? "skipped" : "pending", message: done ? "Added after this order was activated — not run." : null, startedAt: null, finishedAt: null, calls: [] };
  const at = tx.steps.findIndex(s => s.id === "activate");
  const steps = at < 0 ? [...tx.steps, step] : [...tx.steps.slice(0, at), step, ...tx.steps.slice(at)];
  return { ...tx, steps, status: !done && tx.status === "completed" ? "in-progress" : tx.status };
}

export const snapshotOf = (a: AssetFacts, attributes: AssetSnapshot["attributes"] = []): AssetSnapshot => ({
  id: a.id, name: a.name, productId: a.productId, productName: a.productName, quantity: a.quantity, unitPrice: a.unitPrice, discount: a.discount, mrr: a.mrr,
  sellingModelType: a.sellingModel?.type ?? null, sellingModelName: a.sellingModel?.name ?? null, billingFrequency: a.billingFrequency,
  startDate: day(a.startDate), endDate: day(a.endDate), lifecycleEnd: day(a.lifecycleEnd), parentId: a.parentId, childIds: a.childIds,
  usageBased: a.usage.usageBased, pricebookId: a.pricebookId, attributes,
});

/** The quantity change on the asset: a replacement gives up `outQuantity` (default all of it); the new product becomes a new asset. */
export function desiredDelta(c: AssetChange, s: AssetSnapshot | undefined): number {
  return c.swap ? -(c.swap.outQuantity ?? s?.quantity ?? 0) : c.quantityChange;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const set = (v: unknown) => v !== undefined && v !== null;

type Plannable = Pick<LifecycleTransaction, "kind" | "accountId" | "contractId" | "effectiveDate" | "assets" | "changes" | "adds" | "renewal" | "cancel" | "amendSubtype">;

/** The renewal window sent to Salesforce: start (optional) and end (explicit, or start + term). */
export function renewalWindow(d: Pick<LifecycleTransaction, "effectiveDate" | "renewal" | "assets">): { start: string | null; end: string | null } {
  const start = isIsoDate(d.effectiveDate) ? d.effectiveDate : null;
  if (d.renewal?.endDate && isIsoDate(d.renewal.endDate)) return { start, end: d.renewal.endDate };
  const months = d.renewal?.termMonths ?? null;
  if (!months) return { start, end: null };
  // Without an explicit start, the renewal follows the current term: only computable when every asset ends on the same day.
  const ends = [...new Set(d.assets.map(a => a.lifecycleEnd ?? a.endDate).filter((x): x is string => !!x))];
  const from = start ?? (ends.length === 1 ? addDays(ends[0], 1) : null);
  return { start, end: from ? termEnd(from, months) : null };
}

/** Blocking problems with a transaction before anything is sent. `facts` = freshly read assets (eligibility re-checked server-side). */
export function validateTransaction(d: Plannable, facts: Map<string, AssetFacts> | null, today: string, caps?: { actionInputs?: string[] }): string[] {
  const e: string[] = [];
  const kind = d.kind;
  if (!d.accountId) e.push("Choose an account.");
  if (!d.assets.length) e.push("Select at least one asset.");
  if (d.assets.length > MAX_ASSETS) e.push(`Salesforce processes at most ${MAX_ASSETS} assets per request.`);
  if (kind !== "renew" && !isIsoDate(d.effectiveDate)) e.push(`Set a valid ${kind === "amend" ? "amendment start" : "cancellation"} date (YYYY-MM-DD).`);
  if (kind === "renew" && d.effectiveDate && !isIsoDate(d.effectiveDate)) e.push("The renewal start date must be YYYY-MM-DD.");
  const snap = new Map(d.assets.map(a => [a.id, a]));
  for (const a of d.assets) if (a.parentId && snap.has(a.parentId)) e.push(`${a.name} is a component of a selected bundle — Salesforce includes it with its root; deselect it.`);

  if (kind === "amend") e.push(...validateAmendment(d, snap));
  if (kind === "renew") {
    const w = renewalWindow(d);
    if (d.renewal?.termMonths != null && (!Number.isInteger(d.renewal.termMonths) || d.renewal.termMonths < 1 || d.renewal.termMonths > 600)) e.push("The renewal term must be a whole number of months (1–600).");
    if (d.renewal?.endDate && !isIsoDate(d.renewal.endDate)) e.push("The renewal end date must be YYYY-MM-DD.");
    if (d.renewal?.termMonths && !d.renewal.endDate && !w.end) e.push("Set a renewal start date: the selected assets end on different days, so the term can't be placed.");
    if (w.start && w.end && w.end <= w.start) e.push(`The renewal end ${w.end} must be after its start ${w.start}.`);
    // From the planned snapshot too (not only fresh facts), so the review step shows it before anything is sent.
    for (const a of d.assets) {
      const end = a.lifecycleEnd ?? a.endDate;
      if (end && end < today && !isIsoDate(d.effectiveDate)) e.push(`${a.name} has expired (${end}) — set a renewal start date of today (${today}) or later.`);
      else if (end && end < today && d.effectiveDate < today) e.push(`${a.name} has expired — its renewal must start today (${today}) or later, not ${d.effectiveDate}.`);
    }
    const r = d.renewal?.ramp;
    if (r) {
      if (caps?.actionInputs && !caps.actionInputs.includes("rampOptionsDetails")) e.push("This org's initiateRenewal has no rampOptionsDetails input (API 67.0+) — ramped renewals aren't available.");
      if (!Number.isInteger(r.durationInMonths) || r.durationInMonths < 1) e.push("Ramp duration must be a whole number of months.");
      if (r.segmentType === "Custom" && (!Number.isInteger(r.segmentCount) || (r.segmentCount ?? 0) < 1 || (r.segmentCount ?? 0) > r.durationInMonths)) e.push("A Custom ramp needs a segment count between 1 and the duration in months.");
    }
    for (const c of d.changes) {
      const s = snap.get(c.assetId);
      if (!s) { e.push(`A price change refers to asset ${c.assetId}, which isn't selected.`); continue; }
      if (set(c.unitPrice) && (!isNum(c.unitPrice) || c.unitPrice! < 0)) e.push(`${s.name}: the renewal unit price must be 0 or more.`);
      if (set(c.discount) && (!isNum(c.discount) || c.discount! < 0 || c.discount! > 100)) e.push(`${s.name}: the discount must be between 0 and 100%.`);
    }
  }
  if (kind === "cancel") {
    const books = new Set(d.assets.map(a => a.pricebookId).filter(Boolean));
    if (books.size > 1) e.push("Salesforce cancels assets of ONE price book per request — the selected assets come from different price books. Cancel them in separate transactions.");
    const rf = d.cancel?.reasonField;
    if (d.cancel?.reason && rf && rf.options.length && !rf.options.includes(d.cancel.reason)) e.push(`"${d.cancel.reason}" isn't a value of ${rf.object}.${rf.field}.`);
  }

  if (facts) {
    for (const a of d.assets) {
      const f = facts.get(a.id);
      if (!f) { e.push(`${a.name} (${a.id}) wasn't found in Salesforce.`); continue; }
      const eff = kind === "renew" ? (isIsoDate(d.effectiveDate) ? d.effectiveDate : null) : isIsoDate(d.effectiveDate) ? d.effectiveDate : null;
      for (const r of assetEligibility(f, kind, { accountId: d.accountId, contractId: d.contractId, effectiveDate: eff, today })) if (r.severity === "error") e.push(r.message);
      if (kind === "renew" && day(f.lifecycleEnd) && day(f.lifecycleEnd)! < today && !isIsoDate(d.effectiveDate)) e.push(`${f.name} has expired — set a renewal start date of today (${today}) or later.`);
    }
  }
  return [...new Set(e)];
}

function validateAmendment(d: Plannable, snap: Map<string, AssetSnapshot>): string[] {
  const e: string[] = [];
  if (d.amendSubtype === "StartDateAdjustment") {
    if (d.adds.length || d.changes.some(c => c.quantityChange !== 0 || c.swap || set(c.unitPrice) || set(c.discount) || c.billingFrequency || c.endDate || c.attributes?.length)) e.push("A start-date adjustment only moves the start date — remove the other changes or amend them separately.");
    return e;
  }
  const swap = swapKindOf(d);
  if (swap) {
    // Salesforce's Upgrade / Downgrade / Swap API builds its own amendment quote: one kind per request, nothing else mixed in.
    if (d.changes.some(c => !c.swap || c.swap.kind !== swap)) e.push(`An ${swap} is sent through Salesforce's ${swap[0].toUpperCase()}${swap.slice(1)} API on its own — every selected asset must be an ${swap}. Amend the other changes in a separate amendment.`);
    if (d.adds.length) e.push(`Added products can't be combined with an ${swap} — add them in a separate amendment.`);
  }
  for (const c of d.changes) {
    const s = snap.get(c.assetId);
    if (!s) { e.push(`A change refers to asset ${c.assetId}, which isn't selected.`); continue; }
    if (!isNum(c.quantityChange) || !Number.isInteger(c.quantityChange)) e.push(`${s.name}: the quantity change must be a whole number.`);
    else if ((s.quantity ?? 0) + c.quantityChange < 0) e.push(`${s.name}: reducing by ${-c.quantityChange} would leave ${(s.quantity ?? 0) + c.quantityChange} (current quantity ${s.quantity ?? 0}).`);
    // Reducing to zero ends the asset — that's a CANCELLATION (initiateCancellation, Cancel asset action), not an amendment downsell.
    else if (!c.swap && c.quantityChange < 0 && (s.quantity ?? 0) + c.quantityChange === 0) e.push(`${s.name}: reducing the quantity to 0 ends the asset — use Cancellations (initiateCancellation) instead of an amendment.`);
    if (c.swap && set(c.swap.outQuantity) && (!isNum(c.swap.outQuantity) || !Number.isInteger(c.swap.outQuantity) || c.swap.outQuantity! < 1 || c.swap.outQuantity! > (s.quantity ?? 0))) e.push(`${s.name}: the quantity given up must be a whole number from 1 to ${s.quantity ?? 0}.`);
    if (c.swap && (set(c.discount) || c.billingFrequency || c.endDate || c.attributes?.length || set(c.unitPrice))) e.push(`${s.name}: an ${c.swap.kind} replaces the product — set the new product's price on the replacement, not other changes on the old asset.`);
    if (set(c.unitPrice) && (!isNum(c.unitPrice) || c.unitPrice! < 0)) e.push(`${s.name}: the new unit price must be 0 or more.`);
    if (set(c.discount) && (!isNum(c.discount) || c.discount! < 0 || c.discount! > 100)) e.push(`${s.name}: the discount must be between 0 and 100%.`);
    if (c.billingFrequency && s.sellingModelType === "OneTime") e.push(`${s.name}: billing frequency can't be set on a One-Time asset.`);
    if (c.endDate) {
      if (!isIsoDate(c.endDate)) e.push(`${s.name}: the end date must be YYYY-MM-DD.`);
      else if (s.sellingModelType !== "TermDefined") e.push(`${s.name}: only Term-Defined assets have an end date to change.`);
      else if (isIsoDate(d.effectiveDate) && c.endDate < d.effectiveDate) e.push(`${s.name}: the end date ${c.endDate} is before the amendment start.`);
    }
    for (const at of c.attributes ?? []) if (!at.definitionId || typeof at.value !== "string") e.push(`${s.name}: attribute ${at.name || "?"} needs a value.`);
    if (c.swap) {
      if (!c.swap.productId || !c.swap.pricebookEntryId) e.push(`${s.name}: choose the ${c.swap.kind} product and its price book entry.`);
      else if (c.swap.productId === s.productId) e.push(`${s.name}: the ${c.swap.kind} product must differ from the current product.`);
      if (!isNum(c.swap.quantity) || c.swap.quantity <= 0) e.push(`${s.name}: the ${c.swap.kind} quantity must be above 0.`);
      if (set(c.swap.unitPrice) && (!isNum(c.swap.unitPrice) || c.swap.unitPrice! < 0)) e.push(`${s.name}: the ${c.swap.kind} unit price must be 0 or more.`);
      if (c.quantityChange !== 0) e.push(`${s.name}: an ${c.swap.kind} sets the quantity given up itself — leave the quantity change at 0.`);
    }
    const changesSomething = c.swap || c.quantityChange !== 0 || set(c.unitPrice) || set(c.discount) || !!c.billingFrequency || !!c.endDate || !!c.attributes?.length;
    if (!changesSomething) e.push(`${s.name}: nothing changes — set a quantity, price, discount, field, attribute change or an upgrade/downgrade, or deselect it.`);
  }
  for (const a of d.assets) if (!d.changes.some(c => c.assetId === a.id)) e.push(`${a.name}: no change entered.`);
  for (const [i, a] of d.adds.entries()) {
    if (!a.productId || !a.pricebookEntryId) e.push(`Added product ${i + 1}: choose a product and its price book entry.`);
    if (!isNum(a.quantity) || a.quantity <= 0) e.push(`Added product ${a.productName || i + 1}: quantity must be above 0.`);
  }
  return e;
}

/** Amendments: the most common requested change — initiateAmendment takes ONE quantityChange; other assets' lines are patched after. */
export function commonQuantityChange(d: Pick<LifecycleTransaction, "assets" | "changes">): number {
  const snap = new Map(d.assets.map(a => [a.id, a]));
  const counts = new Map<number, number>();
  for (const c of d.changes) { const v = desiredDelta(c, snap.get(c.assetId)); counts.set(v, (counts.get(v) ?? 0) + 1); }
  let best = 0, n = -1;
  for (const [v, k] of counts) if (k > n) { best = v; n = k; }
  return best;
}

/** Salesforce stores lifecycle starts as 00:00:00 and ends as 23:59:59 UTC (Asset / AssetStatePeriod, any org time zone); the
 * documented examples send the same (renewalEndDate "…T23:59:59"). */
const dt = (date: string) => `${date}T00:00:00.000Z`;
const dtEnd = (date: string) => `${date}T23:59:59.000Z`;

/**
 * The exact Upgrade / Downgrade / Swap request (Transaction Management, API 66.0+): one group per asset — outGroup = the asset and
 * quantity given up, inGroup = a QuoteLineItem POST for the replacement. `lineFields` adds the replacement's selling-model fields
 * (EndDate, BillingFrequency, …) and list price, which the server resolves from the price book entry before sending.
 */
export function swapRequest(d: Pick<LifecycleTransaction, "kind" | "assets" | "changes" | "effectiveDate" | "contractId" | "opportunityId">, lineFields: Map<string, Record<string, unknown>> = new Map()): { path: string; body: Record<string, unknown> } | null {
  const kind = swapKindOf(d);
  if (!kind) return null;
  const snap = new Map(d.assets.map(a => [a.id, a]));
  const groups = d.changes.filter(c => c.swap).map((c, i) => ({
    referenceId: `${kind.toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
    outGroup: { swapAssets: [{ assetId: c.assetId, quantity: c.swap!.outQuantity ?? snap.get(c.assetId)?.quantity ?? 0 }] },
    inGroup: {
      graphId: `${kind}Request${i + 1}`,
      records: [{ referenceId: `refQuoteLine${i}`, record: { attributes: { type: "QuoteLineItem", method: "POST" }, Product2Id: c.swap!.productId, PricebookEntryId: c.swap!.pricebookEntryId, Quantity: c.swap!.quantity, StartDate: d.effectiveDate, ...(lineFields.get(c.assetId) ?? {}), ...(set(c.swap!.unitPrice) ? { UnitPrice: c.swap!.unitPrice } : {}) } }],
    },
  }));
  const body: Record<string, unknown> = { swapStartDate: dt(d.effectiveDate), outputRecordType: OUTPUT_TYPE, swapGroups: { groups } };
  if (d.contractId) body.contractId = d.contractId;
  if (d.opportunityId) body.opportunityId = d.opportunityId;
  return { path: swapPath(kind), body };
}

/** The exact standard-action request (initiateAmendment / initiateRenewal / initiateCancellation). */
export function initiateRequest(d: Pick<LifecycleTransaction, "kind" | "assets" | "changes" | "effectiveDate" | "contractId" | "opportunityId" | "renewal" | "amendSubtype">): { inputs: Record<string, unknown>[] } {
  const ids = d.assets.map(a => a.id);
  let input: Record<string, unknown>;
  if (d.kind === "amend") {
    input = { amendAssetIds: ids, amendStartDate: dt(d.effectiveDate), quantityChange: d.amendSubtype ? 0 : commonQuantityChange(d), amendOutputType: OUTPUT_TYPE, skipPricing: false };
    if (d.amendSubtype) input.actionSubtype = d.amendSubtype;
    if (d.contractId) input.amendContractId = d.contractId;
    if (d.opportunityId) input.amendOpportunityId = d.opportunityId;
  } else if (d.kind === "renew") {
    const w = renewalWindow(d);
    input = { renewAssetIds: ids, renewOutputType: OUTPUT_TYPE, skipPricing: false };
    if (w.start) input.renewStartDate = dt(w.start);
    if (w.end) input.renewEndDate = dtEnd(w.end);
    if (d.contractId) input.renewContractId = d.contractId;
    if (d.opportunityId) input.renewOpportunityId = d.opportunityId;
    // ConnectApi.RampOptionInputRepresentation (API 67.0+): segmentType, durationInMonths, segmentCount (Custom only).
    if (d.renewal?.ramp) input.rampOptionsDetails = { segmentType: d.renewal.ramp.segmentType, durationInMonths: d.renewal.ramp.durationInMonths, ...(d.renewal.ramp.segmentType === "Custom" ? { segmentCount: d.renewal.ramp.segmentCount } : {}) };
  } else {
    input = { cancelAssetIds: ids, cancelStartDate: dt(d.effectiveDate), cancelOutputType: OUTPUT_TYPE, skipPricing: false };
    if (d.contractId) input.cancelContractId = d.contractId;
    if (d.opportunityId) input.cancelOpportunityId = d.opportunityId;
  }
  return { inputs: [input] };
}

/** One line of the lifecycle quote, as read back from Salesforce. */
export interface QuoteLineFacts {
  id: string; productId: string | null; productName: string | null; pricebookEntryId: string | null;
  quantity: number | null; startQuantity: number | null; endQuantity: number | null;
  unitPrice: number | null; netUnitPrice: number | null; totalPrice: number | null; listPrice: number | null; discount: number | null;
  billingFrequency: string | null; startDate: string | null; endDate: string | null; sellingModelType: string | null;
  quoteActionId: string | null; actionType: string | null; actionSubtype: string | null; sourceAssetId: string | null; parentLineId: string | null;
  reasonValue?: string | null;
  attributes?: { id: string; definitionId: string | null; value: string | null; picklistValueId: string | null }[];
}

export interface LinePlan {
  quotePatch: Record<string, unknown> | null;
  patches: { lineId: string; assetId: string; fields: Record<string, unknown> }[];
  actionPatches: { actionId: string; assetId: string; fields: Record<string, unknown> }[];
  attributePatches: { id: string; lineId: string; assetId: string; fields: Record<string, unknown> }[];
  creates: { key: string; for: string; product: AddedProduct }[];
  errors: string[];
}

/** The quote line Salesforce created for an asset. Replacement quotes (Upgrade / Downgrade / Swap API) set their own quote action
 * types and subtypes — there the line is matched by its source asset only (`anyType`). */
export const lifecycleLine = (lines: QuoteLineFacts[], kind: LifecycleKind, assetId: string, anyType = false) =>
  lines.find(l => l.sourceAssetId === assetId && (anyType || LINE_TYPES[kind].includes((l.actionType ?? "").toLowerCase())) && !l.parentLineId);
/** QuoteAction types Salesforce writes on a lifecycle quote's asset lines. Verified live (p13, 2026-11-11): initiateAmendment with
 * quantityChange 0 creates the asset's line with QuoteAction Type "No Change" (Quantity 0, StartQuantity = EndQuantity = current). */
export const LINE_TYPE_VALUES: Record<LifecycleKind, string[]> = { amend: ["Amend", "No Change"], renew: ["Renew"], cancel: ["Cancel"] };
export const LINE_TYPES: Record<LifecycleKind, string[]> = { amend: LINE_TYPE_VALUES.amend.map(t => t.toLowerCase()), renew: LINE_TYPE_VALUES.renew.map(t => t.toLowerCase()), cancel: LINE_TYPE_VALUES.cancel.map(t => t.toLowerCase()) };

export const isEmptyPlan = (p: LinePlan) => !p.errors.length && !p.quotePatch && !p.patches.length && !p.actionPatches.length && !p.attributePatches.length && !p.creates.length;

/** What has to change on Salesforce's lifecycle quote so it matches the plan. Re-running it after the changes yields nothing to do. */
export function lineChangePlan(d: Pick<LifecycleTransaction, "kind" | "assets" | "changes" | "adds" | "effectiveDate" | "cancel" | "amendSubtype">, lines: QuoteLineFacts[], quote?: { reasonValue?: string | null }): LinePlan {
  const plan: LinePlan = { quotePatch: null, patches: [], actionPatches: [], attributePatches: [], creates: [], errors: [] };
  const snap = new Map(d.assets.map(a => [a.id, a]));
  const kind = d.kind;
  const swap = swapKindOf(d);
  for (const a of d.assets) if (!lifecycleLine(lines, kind, a.id, !!swap)) plan.errors.push(`Salesforce's ${swap ?? (kind === "amend" ? "amendment" : kind === "renew" ? "renewal" : "cancellation")} quote has no ${swap ? "" : `${ACTION_TYPE[kind]} `}line for ${a.name}.`);
  // Replacements: Salesforce's Upgrade / Downgrade / Swap API built the whole quote (out + in lines, quote action subtypes).
  if (plan.errors.length || swap) return plan;

  if (kind === "cancel") {
    const rf = d.cancel?.reasonField, reason = d.cancel?.reason;
    if (rf && reason) {
      if (rf.object === "Quote") { if ((quote?.reasonValue ?? null) !== reason) plan.quotePatch = { [rf.field]: reason }; }
      for (const a of d.assets) {
        const line = lifecycleLine(lines, kind, a.id)!;
        if (rf.object === "QuoteLineItem" && line.reasonValue !== reason) plan.patches.push({ lineId: line.id, assetId: a.id, fields: { [rf.field]: reason } });
        if (rf.object === "QuoteAction" && line.quoteActionId && line.reasonValue !== reason) plan.actionPatches.push({ actionId: line.quoteActionId, assetId: a.id, fields: { [rf.field]: reason } });
      }
    }
    return plan;
  }

  for (const c of d.changes) {
    const s = snap.get(c.assetId);
    const line = lifecycleLine(lines, kind, c.assetId);
    if (!line) continue;
    const fields: Record<string, unknown> = {};
    if (kind === "amend" && !d.amendSubtype) {
      const want = desiredDelta(c, s);
      if (line.quantity !== want) fields.Quantity = want;
      if (c.billingFrequency && line.billingFrequency !== c.billingFrequency) fields.BillingFrequency = c.billingFrequency;
      if (c.endDate && day(line.endDate) !== c.endDate) fields.EndDate = c.endDate;
    }
    if (set(c.unitPrice) && line.unitPrice !== c.unitPrice) fields.UnitPrice = c.unitPrice;
    if (set(c.discount) && (line.discount ?? 0) !== c.discount) fields.Discount = c.discount;
    if (Object.keys(fields).length) plan.patches.push({ lineId: line.id, assetId: c.assetId, fields });
    if (kind !== "amend") continue;
    for (const at of c.attributes ?? []) {
      const row = line.attributes?.find(x => x.definitionId === at.definitionId);
      if (!row) { plan.errors.push(`${s?.name ?? c.assetId}: the amendment line has no "${at.name}" attribute to change.`); continue; }
      const f: Record<string, unknown> = {};
      if (row.value !== at.value) f.AttributeValue = at.value;
      if (at.picklistValueId && row.picklistValueId !== at.picklistValueId) f.AttributePicklistValueId = at.picklistValueId;
      if (Object.keys(f).length) plan.attributePatches.push({ id: row.id, lineId: line.id, assetId: c.assetId, fields: f });
    }
  }
  if (kind === "amend") d.adds.forEach((a, i) => plan.creates.push({ key: `add-${i}`, for: `added ${a.productName || a.productId}`, product: { ...a, startDate: a.startDate ?? d.effectiveDate } }));
  // Already on the quote (a previous apply succeeded): a line without a source asset for the same entry + quantity — never added twice.
  const free = lines.filter(l => !l.sourceAssetId && !l.parentLineId);
  plan.creates = plan.creates.filter(cr => {
    const i = free.findIndex(l => l.pricebookEntryId === cr.product.pricebookEntryId && l.quantity === cr.product.quantity);
    if (i < 0) return true;
    free.splice(i, 1);
    return false;
  });
  return plan;
}

export interface PreviewRow {
  assetId: string; name: string; productName: string | null; kind: string;
  originalQuantity: number | null; quantityChange: number; resultingQuantity: number | null;
  originalUnitPrice: number | null; newUnitPrice: number | null; originalDiscount: number | null; newDiscount: number | null;
  originalEnd: string | null; newEnd: string | null;
  /** Cancellations: days of the current term left after the cancellation date. */
  remainingDays: number | null;
  /** App ESTIMATE (unit price × quantity, no proration / tax) — Salesforce pricing on the quote is authoritative. */
  estimatedChange: number | null;
  fieldChanges: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export function previewRows(d: Pick<LifecycleTransaction, "kind" | "assets" | "changes" | "effectiveDate" | "renewal" | "amendSubtype">): PreviewRow[] {
  const w = d.kind === "renew" ? renewalWindow(d) : null;
  return d.assets.map(s => {
    const c = d.changes.find(x => x.assetId === s.id) ?? { assetId: s.id, quantityChange: 0 };
    const base = { assetId: s.id, name: s.name, productName: s.productName, originalQuantity: s.quantity, originalUnitPrice: s.unitPrice, originalDiscount: s.discount, originalEnd: s.lifecycleEnd ?? s.endDate };
    if (d.kind === "cancel") {
      const end = s.lifecycleEnd ?? s.endDate;
      const remaining = end && isIsoDate(d.effectiveDate) ? Math.max(0, daysBetween(d.effectiveDate, end) + 1) : null;
      return { ...base, kind: "cancellation", quantityChange: -(s.quantity ?? 0), resultingQuantity: 0, newUnitPrice: null, newDiscount: null, newEnd: isIsoDate(d.effectiveDate) ? d.effectiveDate : null, remainingDays: remaining,
        // No app estimate: a cancellation's credit (if any) depends on proration policy, what was already billed and the selling model —
        // a One-Time purchase has nothing to credit. Only the priced cancellation quote shows the real amount.
        estimatedChange: null, fieldChanges: [`Cancelled from ${d.effectiveDate || "—"}${remaining !== null ? ` (${remaining} day(s) of the current term left)` : ""}`] };
    }
    if (d.kind === "renew") {
      const price = c.unitPrice ?? s.unitPrice;
      const net = price === null ? null : price * (1 - (c.discount ?? 0) / 100);
      const was = s.unitPrice === null ? null : s.unitPrice * (1 - (s.discount ?? 0) / 100);
      return { ...base, kind: "renewal", quantityChange: 0, resultingQuantity: s.quantity, newUnitPrice: c.unitPrice ?? null, newDiscount: c.discount ?? null, newEnd: w?.end ?? null, remainingDays: null, estimatedChange: net !== null && was !== null && s.quantity !== null ? round((net - was) * s.quantity) : null, fieldChanges: [`Renewed${w?.start ? ` from ${w.start}` : ""}${w?.end ? ` to ${w.end}` : " for the asset's renewal term"}`, ...(set(c.unitPrice) ? [`Negotiated price ${c.unitPrice}`] : []), ...(set(c.discount) ? [`Discount ${c.discount}%`] : [])] };
    }
    if (d.amendSubtype === "StartDateAdjustment") return { ...base, kind: "start-date", quantityChange: 0, resultingQuantity: s.quantity, newUnitPrice: null, newDiscount: null, newEnd: null, remainingDays: null, estimatedChange: null, fieldChanges: [`Start date ${s.startDate ?? "—"} → ${d.effectiveDate}`] };
    const delta = desiredDelta(c, s);
    const resulting = s.quantity === null ? null : s.quantity + delta;
    const newPrice = c.unitPrice ?? null;
    const unit = (newPrice ?? s.unitPrice);
    const disc = c.discount ?? s.discount ?? 0;
    const est = unit === null || s.unitPrice === null || resulting === null || s.quantity === null ? null : round(unit * (1 - disc / 100) * resulting - s.unitPrice * (1 - (s.discount ?? 0) / 100) * s.quantity);
    const fieldChanges = [
      c.billingFrequency ? `Billing frequency ${s.billingFrequency ?? "—"} → ${c.billingFrequency}` : null,
      c.endDate ? `End date ${s.endDate ?? "—"} → ${c.endDate}` : null,
      set(c.discount) ? `Discount ${s.discount ?? 0}% → ${c.discount}%` : null,
      ...(c.attributes ?? []).map(a => `${a.name} → ${a.value}`),
      c.swap ? `${c.swap.kind === "upgrade" ? "Upgrade" : "Downgrade"} to ${c.swap.productName} × ${c.swap.quantity}` : null,
    ].filter((x): x is string => !!x);
    const kind = c.swap ? c.swap.kind : delta !== 0 ? (delta > 0 ? "quantity increase" : "quantity decrease") : newPrice !== null || set(c.discount) ? "price" : "field";
    return { ...base, kind, quantityChange: delta, resultingQuantity: resulting, newUnitPrice: newPrice, newDiscount: c.discount ?? null, newEnd: c.endDate ?? null, remainingDays: null, estimatedChange: c.swap ? null : est, fieldChanges };
  });
}

/** Expected asset quantities after activation (verification). Renewals keep the quantity; cancellations go to 0 once effective. */
export function expectedQuantities(d: Pick<LifecycleTransaction, "kind" | "assets" | "changes" | "amendSubtype">): Map<string, number | null> {
  return new Map(d.assets.map(s => {
    if (d.kind === "cancel") return [s.id, 0];
    if (d.kind === "renew" || d.amendSubtype) return [s.id, s.quantity];
    const c = d.changes.find(x => x.assetId === s.id);
    return [s.id, s.quantity === null ? null : s.quantity + (c ? desiredDelta(c, s) : 0)];
  }));
}
