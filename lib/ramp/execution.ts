import { addDays } from "./schedule";
import type { DealKind, ExecutionStatus, ExecutionStep, GeneratedSegment, RampExecution, SegmentResult, StepId, StepStatus, VerificationCheck } from "./types";

/**
 * RAMP EXECUTION — step model, state transitions and verification (pure; the steps run server-side in server/runner.ts).
 *
 * One step runs per request, and the state is persisted after every step, so a run survives a browser refresh or a server
 * restart and resumes exactly where it stopped. Every write step is idempotent: it first READS Salesforce and skips the write when
 * the result already exists (line already ramped, segment group already cloned, value already set), so a retry never duplicates.
 * A run is "completed" only when every required verification check passed — never on an API "success" alone.
 */

export const LINE_STEPS: { id: StepId; label: string }[] = [
  { id: "validate", label: "Validate quote, line and product" },
  { id: "stage", label: "Stage the ramp (Ramp Deal API)" },
  { id: "commit", label: "Commit (Place Sales Transaction)" },
  { id: "read-back", label: "Read back segment lines" },
  { id: "segment-values", label: "Apply segment quantity, discount, uplift" },
  { id: "price", label: "Price and persist (Place Sales Transaction, Force)" },
  { id: "verify", label: "Verify segments and saved prices" },
];
export const GROUP_STEPS: { id: StepId; label: string }[] = [
  { id: "validate", label: "Validate quote, group and lines" },
  { id: "convert-group", label: "Convert the group into segment 1 (EditGroup)" },
  { id: "clone-segments", label: "Create the next segments (Clone Sales Transaction)" },
  { id: "edit-schedule", label: "Set segment dates (EditRampSchedule)" },
  { id: "segment-values", label: "Set segment uplift and method (EditGroup)" },
  { id: "read-back", label: "Read back segment groups and lines" },
  { id: "price", label: "Price and persist (Place Sales Transaction, Force)" },
  { id: "verify", label: "Verify segments and saved prices" },
];

export function newExecution(a: { id: string; dealId: string; kind: DealKind; orgId: string; userId: string | null; quoteId: string | null; lineId: string | null; groupId: string | null; now: string }): RampExecution {
  const defs = a.kind === "line" ? LINE_STEPS : GROUP_STEPS;
  return {
    id: a.id, dealId: a.dealId, kind: a.kind, orgId: a.orgId, status: "pending",
    steps: defs.map(d => ({ id: d.id, label: d.label, status: "pending", message: null, startedAt: null, endedAt: null, attempts: 0, wrote: false, calls: [] })),
    sf: { quoteId: a.quoteId, lineId: a.lineId, groupId: a.groupId, contextId: null, rampIdentifier: null, segmentGroupIds: [], segmentLineIds: [], asyncRequestIds: [], priceRequestedAt: null },
    segments: [], quote: null, verification: [], createdAt: a.now, updatedAt: a.now, createdBy: a.userId,
  };
}

/** The step to run next: the first that isn't completed/skipped (a failed or waiting step is re-run on resume). */
export function nextStep(e: RampExecution): ExecutionStep | null {
  return e.steps.find(s => s.status !== "completed" && s.status !== "skipped") ?? null;
}

export interface StepOutcome { status: Extract<StepStatus, "completed" | "failed" | "waiting" | "skipped">; message: string }

export function applyOutcome(e: RampExecution, id: StepId, o: StepOutcome, now: string): RampExecution {
  const steps = e.steps.map(s => (s.id === id ? { ...s, status: o.status as StepStatus, message: o.message, endedAt: o.status === "waiting" ? null : now } : s));
  const next = { ...e, steps, updatedAt: now };
  return { ...next, status: overallStatus(next) };
}

export function startStep(e: RampExecution, id: StepId, now: string): RampExecution {
  return { ...e, status: "in-progress", updatedAt: now, steps: e.steps.map(s => (s.id === id ? { ...s, status: "running", startedAt: s.startedAt ?? now, attempts: s.attempts + 1 } : s)) };
}

export function overallStatus(e: Pick<RampExecution, "steps">): ExecutionStatus {
  if (e.steps.some(s => s.status === "failed")) return "failed";
  if (e.steps.some(s => s.status === "running")) return "interrupted"; // a step that never reported back (server stopped mid-step)
  if (e.steps.some(s => s.status === "waiting")) return "waiting";
  if (e.steps.every(s => s.status === "completed" || s.status === "skipped")) return "completed";
  return e.steps.some(s => s.status !== "pending") ? "in-progress" : "pending";
}

/** A run whose step is still "running" when it's loaded was cut off (browser closed / server restarted). */
export function markInterrupted(e: RampExecution, now: string): RampExecution {
  if (!e.steps.some(s => s.status === "running")) return e;
  return { ...e, status: "interrupted", updatedAt: now, steps: e.steps.map(s => (s.status === "running" ? { ...s, status: "failed", message: `${s.message ? `${s.message} ` : ""}Interrupted — the step didn't report back. Resume re-checks Salesforce before writing again.`, endedAt: now } : s)) };
}

export const canResume = (e: RampExecution) => e.status !== "completed" && e.status !== "pending";

/**
 * Retry a failed step: back to pending and `wrote` cleared, so the step may send its write ONE more time — but only after its own
 * read of Salesforce shows the result still isn't there (every write step re-reads first), so a retry never duplicates.
 */
export function resetForRetry(e: RampExecution, now: string): RampExecution {
  const steps = e.steps.map(s => (s.status === "failed" ? { ...s, status: "pending" as const, wrote: false, message: `${s.message ?? ""} (retrying)`.trim() } : s));
  return { ...e, steps, status: overallStatus({ steps }), updatedAt: now };
}

/* ── verification ── */

const n2 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const same = (a: number | null | undefined, b: number | null | undefined, tol = 0.01) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= tol;
export const QUOTE_PRICED = ["CompletedWithPricing", "CompletedWithTax", "TaxCalculationSuccess"];
export const QUOTE_BUSY = ["PriceCalculationQueued", "PriceCalculationInProgress", "Saving", "QueuedForConfiguration", "QueuedForPricingAndSaving", "QueuedForPricing", "QueuedForSaving", "ConfigurationInProgress", "ReconciliationInProgress", "ContextHydrationInProgress", "TaxCalculationWaiting", "TaxCalculationInProcess", "ImportQLIInProgress", "ARCInProgress", "QueuedForARC", "CloneInProgress", "QueuedForClone"];
export const QUOTE_FAILED = ["PriceCalculationFailed", "SaveFailedOrIncomplete", "QuoteRequestFailed", "ConfigurationFailed", "ReconciliationFailed", "GroupRampConfigurationFailed", "PstBaseStepFailed", "ARCStepFailed", "CloneFailed", "TaxCalculationFailed", "QuoteRequestPartiallySaved", "ImportQLIFailed"];

/**
 * Line ramp: Salesforce generated the segments (dates are Salesforce's own — compared with the preview, not forced), every segment
 * carries the requested Quantity / Discount / UnitPriceUplift, the quote was priced AFTER the price request and saved, every
 * segment has a saved NetUnitPrice, and a requested uplift was actually applied (ApplUnitPriceUpliftPct > 0).
 */
export function verifySegments(a: {
  kind: DealKind;
  expected: GeneratedSegment[];
  actual: SegmentResult[];
  quote: { calculationStatus: string | null; lastPricedDate: string | null } | null;
  priceRequestedAt: string | null;
  appliedUpliftField: boolean;
  /** Group ramp: products ramped per segment (each segment must have every product). */
  productsPerSegment?: number;
}): VerificationCheck[] {
  const c: VerificationCheck[] = [];
  const add = (id: string, label: string, passed: boolean, expected: string | null, actual: string | null, severity: "error" | "info" = "error") => c.push({ id, label, passed, expected, actual, severity });
  const paid = a.expected; // every planned segment (a free trial is a segment in Salesforce too)
  const segCount = a.kind === "group" ? new Set(a.actual.map(s => s.groupId)).size : a.actual.length;
  add("segment-count", "Segment count", segCount === paid.length, String(paid.length), String(segCount));
  if (a.kind === "group" && a.productsPerSegment) add("lines-per-segment", "Every segment has every product", a.actual.length === segCount * a.productsPerSegment, String(segCount * a.productsPerSegment), String(a.actual.length));
  if (a.kind === "group") {
    // Salesforce links one product's lines across the segments with a shared RampIdentifier (p12: quote #46, RDI0bbe4b989d714b7).
    const byProduct = new Map<string, SegmentResult[]>();
    for (const s of a.actual) byProduct.set(s.productId ?? s.id, [...(byProduct.get(s.productId ?? s.id) ?? []), s]);
    for (const [pid, ls] of byProduct) {
      const ids = [...new Set(ls.map(s => s.rampIdentifier ?? null))];
      add(`ramp-id-${pid}`, `Product ${pid}: one RampIdentifier across its ${ls.length} segment line(s)`, ids.length === 1 && !!ids[0], "one shared RampIdentifier", ids.map(x => x ?? "blank").join(", "));
    }
  }
  const byStart = [...a.actual].sort((x, y) => (x.startDate ?? "").localeCompare(y.startDate ?? ""));
  const starts = [...new Set(byStart.map(s => s.startDate))];
  for (let i = 1; i < starts.length; i++) {
    const prevEnd = byStart.find(s => s.startDate === starts[i - 1])?.endDate ?? null;
    add(`continuity-${i}`, `Segment ${i} → ${i + 1} dates are contiguous`, !!prevEnd && addDays(prevEnd, 1) === starts[i], prevEnd ? addDays(prevEnd, 1) : null, starts[i]);
  }
  paid.forEach((exp, i) => {
    const segs = a.kind === "group" ? byStart.filter(s => s.startDate === starts[i]) : [byStart[i]].filter(Boolean);
    if (!segs.length) return;
    const s0 = segs[0];
    add(`dates-${i + 1}`, `${exp.name} dates`, s0.startDate === exp.startDate && s0.endDate === exp.endDate, `${exp.startDate} → ${exp.endDate}`, `${s0.startDate} → ${s0.endDate}`, a.kind === "line" ? "info" : "error");
    for (const s of segs) {
      if (a.kind === "line") {
        add(`qty-${s.id}`, `${exp.name} quantity`, same(s.quantity, exp.quantity), String(exp.quantity), String(s.quantity));
        add(`disc-${s.id}`, `${exp.name} discount`, same(s.discount ?? 0, exp.discount), `${exp.discount}%`, `${s.discount ?? 0}%`);
      }
      add(`uplift-${s.id}`, `${exp.name} uplift`, same(s.unitPriceUplift ?? 0, exp.upliftPercent), `${exp.upliftPercent}%`, `${s.unitPriceUplift ?? 0}%`);
      add(`price-${s.id}`, `${exp.name} has a saved net price`, s.netUnitPrice !== null, "NetUnitPrice set", s.netUnitPrice === null ? "blank" : String(n2(s.netUnitPrice)));
      if (a.appliedUpliftField && exp.upliftPercent !== 0) add(`applied-${s.id}`, `${exp.name}: Salesforce applied the uplift`, (s.appliedUpliftPct ?? 0) !== 0, "ApplUnitPriceUpliftPct ≠ 0", `${s.appliedUpliftPct ?? 0}%`);
    }
  });
  const q = a.quote;
  add("quote-priced", "Quote pricing saved (CalculationStatus)", !!q && QUOTE_PRICED.includes(q.calculationStatus ?? ""), QUOTE_PRICED.join(" / "), q?.calculationStatus ?? "unknown");
  add("quote-priced-after", "Quote priced after this run's price request (LastPricedDate)", !!q?.lastPricedDate && !!a.priceRequestedAt && Date.parse(q.lastPricedDate) >= Date.parse(a.priceRequestedAt) - 5000, a.priceRequestedAt ? `≥ ${a.priceRequestedAt}` : "a price request", q?.lastPricedDate ?? "never priced");
  return c;
}

export const verificationPassed = (checks: VerificationCheck[]) => checks.length > 0 && checks.every(c => c.passed || c.severity === "info");
