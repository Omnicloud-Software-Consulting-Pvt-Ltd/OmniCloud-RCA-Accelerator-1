import type { GeneratedSegment, PeriodUnit, RampSchedule, ScheduleInput, SchedulePreview, UpliftMethod } from "./types";

/**
 * RAMP SCHEDULE ENGINE (pure). Turns a schedule template + contract dates + base price into segments.
 *
 * Dates (ISO YYYY-MM-DD, calendar math only — no time zones):
 *  · Boundaries are anchored to the CONTRACT START: boundary k = start + k·months, clamped to the month's last day (Jan 31 + 1 month
 *    = Feb 28/29). Segment k runs from boundary k to the day before boundary k+1, so segments are always contiguous and a
 *    month-end start never drifts (Jan 31 → Feb 28 → Mar 30 drift is impossible because each boundary is computed from the start).
 *  · The last segment ends on the contract end date; if it's shorter than a full period it is "prorated" (Salesforce's own
 *    Prorated segment type — p12 group ramps show e.g. "Year 4 - Pro-rated").
 *  · Yearly = 12 months — the anniversary segments Salesforce generates for a Yearly line ramp (verified on p12 segment lines:
 *    2026-11-09 → 2027-11-08 → 2028-11-08 …).
 *
 * Prices are a PREVIEW. Salesforce only takes a percentage uplift per segment (QuoteLineItem / QuoteLineGroup.UnitPriceUplift) and
 * its pricing procedure computes the price (Standard = relative to the base price; Compound = on top of the previous segment, via the
 * Price Revision element). `toSalesforceUplift` converts any schedule (fixed increase, target price, multiplier) into those percentages.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const { y, m, d } = parse(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); // 2026-02-30 is not a date (Date.parse would roll it over)
};

function parse(s: string): { y: number; m: number; d: number } { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; }
function toIso(p: { y: number; m: number; d: number }): string { return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** start + n months, clamped to the target month's last day (2024-01-31 + 1 → 2024-02-29). */
export function addMonths(iso: string, n: number): string {
  const p = parse(iso);
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  return toIso({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}
export function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Whole months from start to end-inclusive (start → the day before start + n months), or null when it isn't whole. */
export function wholeMonths(start: string, endInclusive: string): number | null {
  for (let n = 1; n <= 1200; n++) {
    const e = addDays(addMonths(start, n), -1);
    if (e === endInclusive) return n;
    if (e > endInclusive) return null;
  }
  return null;
}
/** Months (fractional for the last partial month) — for display only. */
export function monthsApprox(start: string, endInclusive: string): number {
  let n = 0;
  while (addDays(addMonths(start, n + 1), -1) <= endInclusive) n++;
  const rest = daysBetween(addMonths(start, n), addDays(endInclusive, 1));
  const next = daysBetween(addMonths(start, n), addMonths(start, n + 1));
  return Math.round((n + (next ? rest / next : 0)) * 100) / 100;
}

export const periodMonths = (period: PeriodUnit, customMonths: number | null): number | null =>
  period === "Monthly" ? 1 : period === "Quarterly" ? 3 : period === "Yearly" ? 12 : customMonths && customMonths > 0 && Number.isInteger(customMonths) ? customMonths : null;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

type ScheduleShape = Pick<RampSchedule, "period" | "customMonths" | "segments" | "trialMonths" | "priceChange" | "defaultChange" | "upliftMethod" | "basePriceMultiplier" | "overrides">;

/** Segment boundaries only (trial first, then paid periods, last one prorated if needed). */
export function segmentBoundaries(s: Pick<ScheduleShape, "period" | "customMonths" | "segments" | "trialMonths">, contractStart: string, contractEnd: string): { start: string; end: string; kind: GeneratedSegment["kind"]; months: number }[] {
  const out: { start: string; end: string; kind: GeneratedSegment["kind"]; months: number }[] = [];
  let paidStart = contractStart;
  if (s.trialMonths && s.trialMonths > 0) {
    const end = addDays(addMonths(contractStart, s.trialMonths), -1);
    out.push({ start: contractStart, end: end > contractEnd ? contractEnd : end, kind: "trial", months: s.trialMonths });
    paidStart = addMonths(contractStart, s.trialMonths);
  }
  const m = periodMonths(s.period, s.customMonths);
  if (!m || paidStart > contractEnd) return out;
  for (let k = 0; ; k++) {
    const start = addMonths(paidStart, k * m);
    if (start > contractEnd) break;
    const fullEnd = addDays(addMonths(paidStart, (k + 1) * m), -1);
    const end = fullEnd > contractEnd ? contractEnd : fullEnd;
    out.push({ start, end, kind: fullEnd > contractEnd ? "prorated" : "full", months: fullEnd > contractEnd ? monthsApprox(start, end) : m });
    if (end === contractEnd) break;
  }
  return out;
}

/** The change (percent / fixed / price) configured for paid segment n (1-based), override first. */
function changeFor(s: ScheduleShape, n: number): number | null {
  const o = s.overrides.find(x => x.segment === n);
  if (o && o.value !== null && o.value !== undefined) return o.value;
  return n === 1 ? null : s.defaultChange;
}

/** Preview: segments with dates, quantity, discount, the Salesforce uplift % and the implied unit price. */
export function generateSchedule(s: ScheduleShape, input: ScheduleInput): SchedulePreview {
  const issues: SchedulePreview["issues"] = [];
  if (!isIsoDate(input.contractStart) || !isIsoDate(input.contractEnd)) return { segments: [], totalMonths: 0, previewTotal: 0, issues: [{ severity: "error", message: "Set valid contract start and end dates (YYYY-MM-DD)." }] };
  if (input.contractEnd < input.contractStart) return { segments: [], totalMonths: 0, previewTotal: 0, issues: [{ severity: "error", message: "The contract end date is before the start date." }] };
  if (!periodMonths(s.period, s.customMonths)) issues.push({ severity: "error", message: "Custom periods need a whole number of months per segment." });
  if (!(input.basePrice >= 0)) issues.push({ severity: "error", message: "The base unit price must be zero or more." });
  if (!(input.baseQuantity > 0)) issues.push({ severity: "error", message: "The base quantity must be more than zero." });
  if (!(s.basePriceMultiplier > 0)) issues.push({ severity: "error", message: "The base price multiplier must be more than zero." });
  if (issues.some(i => i.severity === "error")) return { segments: [], totalMonths: 0, previewTotal: 0, issues };

  const bounds = segmentBoundaries(s, input.contractStart, input.contractEnd);
  const paidCount = bounds.filter(b => b.kind !== "trial").length;
  if (s.segments && paidCount !== s.segments) issues.push({ severity: "warning", message: `The contract produces ${paidCount} paid segment(s) for ${s.period === "Custom" ? `${s.customMonths}-month` : s.period.toLowerCase()} periods; the schedule asks for ${s.segments}. Adjust the dates or the segment count.` });
  if (paidCount === 1 && !bounds.some(b => b.kind === "trial")) issues.push({ severity: "warning", message: "Only one segment — a ramp needs at least two segments to change anything over time." });

  const base = input.basePrice * s.basePriceMultiplier;
  // Percent / no-change schedules ARE Salesforce uplifts already — taken directly, never derived from a price (a group ramp has no single
  // base price; deriving through base 0 made every uplift 0%). Fixed-amount / target-price schedules must be converted through a price.
  const needsPrice = s.priceChange === "fixed" || s.priceChange === "price";
  if (needsPrice && !(base > 0)) {
    issues.push({ severity: "error", message: `${s.priceChange === "fixed" ? "Fixed-amount" : "Price-per-segment"} changes are converted into the uplift % Salesforce takes (UnitPriceUplift) through the base unit price — set a base unit price above 0, or describe the change as a percentage.` });
  }
  let prev = base;
  let n = 0;
  const segments: GeneratedSegment[] = bounds.map((b, i) => {
    const o = b.kind === "trial" ? undefined : s.overrides.find(x => x.segment === n + 1);
    const quantity = (input.ignoreQuantityOverrides ? undefined : o?.quantity) ?? input.baseQuantity;
    const discount = o?.discount ?? 0;
    if (b.kind === "trial") {
      return { index: i, name: "Trial", kind: "trial", startDate: b.start, endDate: b.end, months: b.months, upliftPercent: 0, upliftSource: "trial", quantity, discount: 100, previewUnitPrice: 0, previewTotal: 0 };
    }
    n++;
    const override = o && o.value !== null && o.value !== undefined;
    const ch = changeFor(s, n);
    let uplift: number;
    let target: number;
    let source: GeneratedSegment["upliftSource"];
    if (s.priceChange === "none") { uplift = 0; source = "none"; }
    else if (s.priceChange === "percent") {
      uplift = ch ?? 0;
      source = override ? "override" : n === 1 ? "first" : ch === null ? "unset" : "default";
      if (source === "unset") issues.push({ severity: "warning", message: `Segment ${n} has no uplift configured (no default and no override) — 0% will be sent.` });
    } else { uplift = 0; source = override ? "override" : n === 1 ? "first" : ch === null ? "unset" : "default"; }
    if (s.priceChange === "percent" || s.priceChange === "none") target = s.upliftMethod === "Compound" ? (n === 1 ? base : prev) * (1 + uplift / 100) : base * (1 + uplift / 100);
    else {
      target = n === 1 ? base : prev;
      if (s.priceChange === "fixed" && ch !== null) target = s.upliftMethod === "Compound" ? prev + ch : base + ch * (n - 1 > 0 ? 1 : 0);
      else if (s.priceChange === "price" && ch !== null) target = ch;
      else if (ch === null) target = s.upliftMethod === "Compound" || n === 1 ? (n === 1 ? base : prev) : base;
      uplift = base > 0 ? toSalesforceUplift(base, n === 1 ? base : prev, target, s.upliftMethod) : 0;
      if (source !== "first" && source !== "unset") source = "price";
    }
    if (target < 0) issues.push({ severity: "error", message: `Segment ${n}'s price would be negative.` });
    const unit = round4(target * (1 - discount / 100));
    prev = target;
    const name = b.kind === "prorated" ? `${segmentLabel(s.period, n)} - Pro-rated` : segmentLabel(s.period, n);
    return { index: i, name, kind: b.kind, startDate: b.start, endDate: b.end, months: b.months, upliftPercent: round2(uplift), upliftSource: source, quantity, discount, previewUnitPrice: unit, previewTotal: round2(unit * quantity * (b.months / (periodMonths(s.period, s.customMonths) ?? 1))) };
  });
  if (input.ignoreQuantityOverrides && s.overrides.some(o => o.quantity !== null && o.quantity !== undefined)) issues.push({ severity: "warning", message: "Per-segment quantity overrides aren't applied: a group ramp keeps each line's own quantity (QuoteLineGroup has no quantity field)." });
  for (const seg of segments) {
    if (seg.discount < 0 || seg.discount > 100) issues.push({ severity: "error", message: `${seg.name}: discount must be between 0 and 100.` });
    if (!(seg.quantity > 0)) issues.push({ severity: "error", message: `${seg.name}: quantity must be more than zero.` });
    if (Math.abs(seg.upliftPercent) > 1000) issues.push({ severity: "error", message: `${seg.name}: an uplift of ${seg.upliftPercent}% is outside what Salesforce's UnitPriceUplift field holds.` });
  }
  for (let i = 1; i < segments.length; i++) if (addDays(segments[i - 1].endDate, 1) !== segments[i].startDate) issues.push({ severity: "error", message: `Gap or overlap between ${segments[i - 1].name} and ${segments[i].name}.` });
  return { segments, totalMonths: monthsApprox(input.contractStart, input.contractEnd), issues, previewTotal: round2(segments.reduce((a, s2) => a + s2.previewTotal, 0)) };
}

function segmentLabel(period: PeriodUnit, n: number): string {
  return period === "Yearly" ? `Year ${n}` : period === "Quarterly" ? `Quarter ${n}` : period === "Monthly" ? `Month ${n}` : `Segment ${n}`;
}

/**
 * The Salesforce UnitPriceUplift (percent, 2 dp) that makes Salesforce's Price Revision reach `target`:
 *  · Standard — relative to the BASE price: (target / base − 1) · 100.
 *  · Compound — relative to the PREVIOUS segment's price: (target / previous − 1) · 100.
 */
export function toSalesforceUplift(base: number, previous: number, target: number, method: UpliftMethod): number {
  const ref = method === "Compound" ? previous : base;
  if (!(ref > 0)) return 0;
  return round2((target / ref - 1) * 100);
}

/** Preview of what Salesforce's Price Revision computes from per-segment uplift percentages. */
export function applyUplifts(base: number, upliftsPct: number[], method: UpliftMethod): number[] {
  let prev = base;
  return upliftsPct.map((u, i) => {
    const p = method === "Compound" ? (i === 0 ? base * (1 + u / 100) : prev * (1 + u / 100)) : base * (1 + u / 100);
    prev = p;
    return round4(p);
  });
}

/** Cumulative uplift (percent) a compound chain applies by segment n — what ApplUnitPriceUpliftPct should show for compound. */
export function cumulativeCompound(upliftsPct: number[]): number[] {
  let f = 1;
  return upliftsPct.map(u => { f *= 1 + u / 100; return round4((f - 1) * 100); });
}

/** The Salesforce segment type for a schedule (ramp-deal-create accepts Yearly | Custom | FreeTrial — verified in p12). */
export function salesforceSegmentType(period: PeriodUnit): "Yearly" | "Custom" { return period === "Yearly" ? "Yearly" : "Custom"; }

export function blankSchedule(now = new Date().toISOString()): RampSchedule {
  return { id: "", name: "", description: null, period: "Yearly", customMonths: null, segments: 3, trialMonths: null, priceChange: "percent", defaultChange: 5, upliftMethod: "Standard", basePriceMultiplier: 1, overrides: [], createdAt: now, updatedAt: now, createdBy: null, version: 1 };
}

/** Validation of a schedule template itself (independent of a contract). */
export function validateSchedule(s: Partial<RampSchedule>): string[] {
  const e: string[] = [];
  if (!s.name?.trim()) e.push("Name is required.");
  if (!s.period || !["Monthly", "Quarterly", "Yearly", "Custom"].includes(s.period)) e.push("Choose a period: Monthly, Quarterly, Yearly or Custom.");
  if (s.period === "Custom" && !(s.customMonths && Number.isInteger(s.customMonths) && s.customMonths > 0)) e.push("Custom periods need a whole number of months.");
  if (!(s.segments && Number.isInteger(s.segments) && s.segments >= 1 && s.segments <= 60)) e.push("Number of segments must be a whole number from 1 to 60.");
  if (s.trialMonths !== null && s.trialMonths !== undefined && !(Number.isInteger(s.trialMonths) && s.trialMonths > 0 && s.trialMonths <= 24)) e.push("Trial months must be a whole number from 1 to 24.");
  if (!s.upliftMethod || !["Standard", "Compound"].includes(s.upliftMethod)) e.push("Uplift method must be Standard or Compound.");
  if (!(typeof s.basePriceMultiplier === "number" && s.basePriceMultiplier > 0)) e.push("Base price multiplier must be more than zero.");
  for (const o of s.overrides ?? []) if (!(Number.isInteger(o.segment) && o.segment >= 1 && o.segment <= (s.segments ?? 0))) e.push(`Override for segment ${o.segment} is outside 1–${s.segments}.`);
  return e;
}

/** Contract length a schedule covers from a start date (whole periods). */
export function contractEndFor(s: Pick<ScheduleShape, "period" | "customMonths" | "segments" | "trialMonths">, start: string): string | null {
  const m = periodMonths(s.period, s.customMonths);
  if (!m || !isIsoDate(start)) return null;
  return addDays(addMonths(start, (s.trialMonths ?? 0) + m * s.segments), -1);
}

/** A saved schedule template as the schedule body a deal carries (everything except its own identity / audit fields). */
export function scheduleBodyOf(saved: RampSchedule): Omit<RampSchedule, "id" | "createdAt" | "updatedAt" | "createdBy" | "version"> {
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...body } = saved;
  void _i; void _c; void _u; void _b; void _v;
  return { ...body, overrides: body.overrides.map(o => ({ ...o })) };
}

/**
 * Selecting a saved schedule on a deal: the template REPLACES the deal's schedule as a whole (period, segments, trial, price-change
 * method, default uplift, uplift method, multiplier and every per-segment override) — nothing from a previously selected schedule or
 * the blank defaults survives. A group ramp's end date follows the schedule from the current start; a line ramp keeps its line's dates.
 */
export function applySavedSchedule<D extends { kind: "line" | "group"; contractStart?: string | null; contractEnd?: string | null }>(deal: D, saved: RampSchedule | null): { scheduleId: string | null; schedule?: ReturnType<typeof scheduleBodyOf>; contractEnd?: string } {
  if (!saved) return { scheduleId: null }; // clearing the selection keeps the deal's own schedule + dates
  const schedule = scheduleBodyOf(saved);
  const end = deal.kind === "group" ? contractEndFor(schedule, deal.contractStart ?? "") : null;
  return { scheduleId: saved.id, schedule, ...(end ? { contractEnd: end } : {}) };
}
