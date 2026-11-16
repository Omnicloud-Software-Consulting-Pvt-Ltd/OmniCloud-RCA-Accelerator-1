import { addDays, addMonths, isIsoDate, periodMonths } from "./schedule";
import type { PeriodUnit, PriceChangeKind, SchedulePeriodOverride, UpliftMethod } from "./types";

/**
 * RAMP AI FORM SCHEMA (pure — client + server). The AI's raw JSON is NEVER trusted: every value is checked against this schema
 * server-side (type, supported values, ranges), normalized (dates → YYYY-MM-DD, "5%" → 5), checked for invalid combinations, and
 * tagged with where it came from:
 *  · explicit — the user said it (as reported by the AI and accepted only if the value is valid);
 *  · inferred — the AI or this module derived it (e.g. 3-year yearly → 3 segments; start + 36 months → end date).
 * Required fields that are still missing are listed — never invented. Salesforce records are only ever NAMES here; Ids come from
 * the server-side resolution against the connected org (lib/ramp/server/aiForms.ts), never from the AI.
 */

export type RampAiForm = "product-segment" | "schedule" | "deal" | "group-deal";
export const RAMP_AI_FORMS: RampAiForm[] = ["product-segment", "schedule", "deal", "group-deal"];
export type AiSource = "explicit" | "inferred";
export interface AiValue<T = unknown> { value: T; source: AiSource }

type Kind =
  | { t: "text"; max: number }
  | { t: "enum"; values: readonly string[] }
  | { t: "int"; min: number; max: number }
  | { t: "number"; min: number; max: number }
  | { t: "percent" }
  | { t: "date" }
  | { t: "bool" }
  | { t: "overrides" };
export interface FieldSpec { key: string; label: string; kind: Kind }

const PERIODS = ["Monthly", "Quarterly", "Yearly", "Custom"] as const;
const PRICE_CHANGES = ["none", "percent", "fixed", "price"] as const;
const UPLIFTS = ["Standard", "Compound"] as const;
const BOUNDARIES = ["Anniversary", "AlignToCalendar", "DayOfPeriod", "LastDayOfPeriod"] as const;

const SCHEDULE_FIELDS: FieldSpec[] = [
  { key: "period", label: "Period", kind: { t: "enum", values: PERIODS } },
  { key: "customMonths", label: "Segment duration (months)", kind: { t: "int", min: 1, max: 120 } },
  { key: "segments", label: "Number of segments", kind: { t: "int", min: 1, max: 60 } },
  { key: "contractMonths", label: "Contract duration (months)", kind: { t: "int", min: 1, max: 600 } },
  { key: "freeTrial", label: "Free trial", kind: { t: "bool" } },
  { key: "trialMonths", label: "Free trial months", kind: { t: "int", min: 1, max: 24 } },
  { key: "priceChange", label: "Price change method", kind: { t: "enum", values: PRICE_CHANGES } },
  { key: "defaultChange", label: "Default uplift / change", kind: { t: "percent" } },
  { key: "upliftMethod", label: "Uplift method", kind: { t: "enum", values: UPLIFTS } },
  { key: "basePriceMultiplier", label: "Base price multiplier", kind: { t: "number", min: 0.0001, max: 1000 } },
  { key: "overrides", label: "Per-segment overrides", kind: { t: "overrides" } },
];
const DEAL_COMMON: FieldSpec[] = [
  { key: "dealName", label: "Deal name", kind: { t: "text", max: 120 } },
  { key: "accountName", label: "Account", kind: { t: "text", max: 255 } },
  { key: "quoteName", label: "Quote (name or number)", kind: { t: "text", max: 255 } },
  { key: "useSelectedQuote", label: "Use the selected quote", kind: { t: "bool" } },
  { key: "scheduleName", label: "Saved ramp schedule", kind: { t: "text", max: 120 } },
  { key: "contractStart", label: "Contract start", kind: { t: "date" } },
  { key: "contractEnd", label: "Contract end", kind: { t: "date" } },
  { key: "periodBoundary", label: "Period boundary", kind: { t: "enum", values: BOUNDARIES } },
];

export const RAMP_AI_FIELDS: Record<RampAiForm, FieldSpec[]> = {
  "product-segment": [
    { key: "productName", label: "Product", kind: { t: "text", max: 255 } },
    { key: "productCode", label: "Product code", kind: { t: "text", max: 255 } },
    { key: "sellingModelName", label: "Selling model", kind: { t: "text", max: 255 } },
    { key: "segmentType", label: "Segment type", kind: { t: "enum", values: ["Yearly", "Custom", "FreeTrial", "Prorated"] } },
    { key: "trialDuration", label: "Trial duration", kind: { t: "int", min: 1, max: 730 } },
    { key: "durationType", label: "Trial duration type", kind: { t: "enum", values: ["Months", "Days"] } },
    { key: "contractMonths", label: "Contract duration (months)", kind: { t: "int", min: 1, max: 600 } },
    { key: "period", label: "Period", kind: { t: "enum", values: PERIODS } },
  ],
  schedule: [
    { key: "name", label: "Schedule name", kind: { t: "text", max: 120 } },
    { key: "description", label: "Description", kind: { t: "text", max: 1000 } },
    ...SCHEDULE_FIELDS,
    { key: "periodBoundary", label: "Period boundary", kind: { t: "enum", values: BOUNDARIES } },
  ],
  deal: [
    ...DEAL_COMMON,
    { key: "productName", label: "Product (quote line)", kind: { t: "text", max: 255 } },
    { key: "useSelectedLine", label: "Use the selected quote line", kind: { t: "bool" } },
    { key: "sellingModelName", label: "Selling model", kind: { t: "text", max: 255 } },
    { key: "baseQuantity", label: "Base quantity", kind: { t: "number", min: 0.0001, max: 1e9 } },
    ...SCHEDULE_FIELDS,
  ],
  "group-deal": [
    ...DEAL_COMMON,
    { key: "groupName", label: "Quote line group", kind: { t: "text", max: 255 } },
    { key: "useSelectedGroup", label: "Use the selected quote line group", kind: { t: "bool" } },
    ...SCHEDULE_FIELDS,
  ],
};

/** What each form cannot proceed without (labels shown in "Still required"). */
export const RAMP_AI_REQUIRED: Record<RampAiForm, string[]> = {
  "product-segment": ["Product", "Selling model", "Segment type"],
  schedule: ["Schedule name", "Period", "Number of segments"],
  deal: ["Deal name", "Quote", "Quote line", "Period", "Number of segments"],
  "group-deal": ["Deal name", "Quote", "Quote line group", "Contract start", "Contract end", "Period", "Number of segments"],
};

/* ── value normalization ── */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD, YYYY/MM/DD, "January 15, 2027", "15 Jan 2027" → ISO; anything ambiguous (01/02/2027) or invalid → null. */
export function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s))) { m = MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1; d = +r[2]; y = +r[3]; }
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?,? (\d{4})$/.exec(s))) { d = +r[1]; m = MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1; y = +r[3]; }
  else return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return m >= 1 && isIsoDate(iso) ? iso : null;
}
/** 5, "5", "5%", "5 %" → 5. Fractions are NOT rescaled (0.05 stays 0.05%) — the prompt asks the AI for percent units. */
export function normalizePercent(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?\s*%?$/.test(v.trim()) ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > -100 && n <= 1000 ? Math.round(n * 10000) / 10000 : null;
}

function check(spec: FieldSpec, v: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  const k = spec.kind;
  switch (k.t) {
    case "text": return typeof v === "string" && v.trim() ? (v.trim().length <= k.max ? { ok: true, value: v.trim() } : { ok: false, reason: `longer than ${k.max} characters` }) : { ok: false, reason: "must be text" };
    case "enum": {
      const hit = typeof v === "string" ? k.values.find(x => x.toLowerCase() === v.trim().toLowerCase().replace(/[\s_-]/g, "") || x.toLowerCase() === v.trim().toLowerCase()) : undefined;
      return hit ? { ok: true, value: hit } : { ok: false, reason: `must be one of ${k.values.join(", ")}` };
    }
    case "int": { const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v; return typeof n === "number" && Number.isInteger(n) && n >= k.min && n <= k.max ? { ok: true, value: n } : { ok: false, reason: `must be a whole number from ${k.min} to ${k.max}` }; }
    case "number": { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= k.min && n <= k.max ? { ok: true, value: n } : { ok: false, reason: `must be a number from ${k.min} to ${k.max}` }; }
    case "percent": { const n = normalizePercent(v); return n === null ? { ok: false, reason: "must be a percentage between -100 and 1000" } : { ok: true, value: n }; }
    case "date": { const d = normalizeDate(v); return d ? { ok: true, value: d } : { ok: false, reason: "must be a calendar date (YYYY-MM-DD)" }; }
    case "bool": return typeof v === "boolean" ? { ok: true, value: v } : v === "true" || v === "false" ? { ok: true, value: v === "true" } : { ok: false, reason: "must be true or false" };
    case "overrides": {
      if (!Array.isArray(v)) return { ok: false, reason: "must be a list" };
      const out: SchedulePeriodOverride[] = [];
      for (const o of v) {
        const r = (o ?? {}) as Record<string, unknown>;
        const seg = typeof r.segment === "number" && Number.isInteger(r.segment) && r.segment >= 1 && r.segment <= 60 ? r.segment : null;
        if (!seg) return { ok: false, reason: "each override needs a segment number from 1 to 60" };
        const value = r.value === null || r.value === undefined ? null : normalizePercent(r.value);
        const quantity = r.quantity === null || r.quantity === undefined ? null : typeof r.quantity === "number" && r.quantity > 0 ? r.quantity : NaN;
        const discount = r.discount === null || r.discount === undefined ? null : normalizePercent(r.discount);
        if (r.value != null && value === null) return { ok: false, reason: `segment ${seg}: value must be a number` };
        if (Number.isNaN(quantity)) return { ok: false, reason: `segment ${seg}: quantity must be more than zero` };
        if (discount !== null && (discount < 0 || discount > 100)) return { ok: false, reason: `segment ${seg}: discount must be 0–100` };
        if (value === null && quantity === null && discount === null) continue;
        out.push({ segment: seg, value, quantity, discount });
      }
      return { ok: true, value: out.sort((a, b) => a.segment - b.segment) };
    }
  }
}

export interface ValidatedAiExtraction {
  form: RampAiForm;
  fields: Record<string, AiValue>;
  /** Values the AI returned that were rejected (wrong type / unsupported value / not a field of this form). */
  rejected: { key: string; reason: string }[];
  errors: string[];
  warnings: string[];
  /** The user explicitly asked to replace values already in the form. */
  replace: boolean;
  notes: string[];
}

/**
 * Validate + normalize the AI's raw output for one form. Expected shape (also accepted: a bare value instead of {value, source},
 * treated as explicit): { "fields": { "<key>": { "value": …, "source": "explicit" | "inferred" } }, "replace": bool, "notes": [] }.
 */
export function validateAiExtraction(form: RampAiForm, raw: unknown, today: string): ValidatedAiExtraction {
  const out: ValidatedAiExtraction = { form, fields: {}, rejected: [], errors: [], warnings: [], replace: false, notes: [] };
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  out.replace = r.replace === true;
  out.notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string" && !!n.trim()).slice(0, 10).map(n => n.slice(0, 300)) : [];
  const fields = (r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? r.fields : {}) as Record<string, unknown>;
  const specs = new Map(RAMP_AI_FIELDS[form].map(s => [s.key, s]));
  for (const [key, entry] of Object.entries(fields)) {
    const e = entry && typeof entry === "object" && !Array.isArray(entry) && "value" in (entry as object) ? (entry as { value: unknown; source?: unknown }) : { value: entry, source: "explicit" };
    if (e.value === null || e.value === undefined || e.value === "") continue;
    const spec = specs.get(key);
    if (!spec) { out.rejected.push({ key, reason: /id$/i.test(key) ? "Salesforce Ids are never taken from the AI — records are looked up by name" : "not a field of this form" }); continue; }
    const c = check(spec, e.value);
    if (!c.ok) { out.rejected.push({ key, reason: `${spec.label} ${c.reason}` }); continue; }
    out.fields[key] = { value: c.value, source: e.source === "inferred" ? "inferred" : "explicit" };
  }
  deriveAndCheck(out, today);
  return out;
}

const inferred = (value: unknown): AiValue => ({ value, source: "inferred" });

/** Derivations (marked inferred) + invalid-combination checks. Never fills a REQUIRED field from nothing. */
function deriveAndCheck(x: ValidatedAiExtraction, today: string) {
  const f = x.fields;
  const v = <T,>(k: string) => f[k]?.value as T | undefined;
  if (x.form === "product-segment") {
    if (v<string>("segmentType") === "FreeTrial") {
      if (!f.trialDuration) x.warnings.push("A FreeTrial segment needs a trial duration.");
      if (!f.durationType && f.trialDuration) f.durationType = inferred("Months");
    } else if (f.trialDuration || f.durationType) { x.warnings.push("Trial duration only applies to a FreeTrial segment type — ignored."); delete f.trialDuration; delete f.durationType; }
    if (f.contractMonths || f.period) x.notes.push("Contract length and period are set on the ramp schedule / deal, not on the Product Ramp Segment — shown for reference only.");
    return;
  }
  // Schedule fields (schedule, deal, group-deal)
  if (f.customMonths && !f.period) f.period = inferred("Custom");
  const period = v<PeriodUnit>("period");
  if (period && period !== "Custom" && f.customMonths) {
    if (periodMonths(period, null) !== v<number>("customMonths")) x.errors.push(`A ${period.toLowerCase()} period is ${periodMonths(period, null)} month(s) per segment, not ${v<number>("customMonths")}.`);
    delete f.customMonths;
  }
  if (period === "Custom" && !f.customMonths) x.warnings.push("A custom period needs the segment duration in months.");
  const months = period ? periodMonths(period, v<number>("customMonths") ?? null) : null;
  const trial = f.freeTrial?.value === false ? 0 : v<number>("trialMonths") ?? 0;
  if (f.freeTrial?.value === true && !f.trialMonths) x.warnings.push("A free trial was requested but its length isn't given — add the trial months.");
  if (f.freeTrial?.value === false && f.trialMonths) { x.errors.push("The prompt says no free trial but also gives trial months."); delete f.trialMonths; }
  if (f.trialMonths && !f.freeTrial) f.freeTrial = inferred(true);
  if (f.contractMonths && months) {
    const paid = v<number>("contractMonths")! - trial;
    if (paid <= 0) x.errors.push("The free trial is as long as (or longer than) the whole contract.");
    else {
      const derived = Math.ceil(paid / months);
      if (!f.segments) f.segments = inferred(derived);
      else if (v<number>("segments") !== derived) x.warnings.push(`${v<number>("contractMonths")} months of ${period!.toLowerCase()} segments${trial ? ` after a ${trial}-month trial` : ""} gives ${derived} segment(s), but the prompt asks for ${v<number>("segments")}.`);
      if (paid % months) x.warnings.push(`${paid} paid months isn't a whole number of ${months}-month segments — the last segment will be prorated.`);
    }
  }
  if (f.defaultChange && !f.priceChange) f.priceChange = inferred("percent");
  if (v<PriceChangeKind>("priceChange") === "none" && f.defaultChange) { x.errors.push("The prompt asks for no price change but also gives an uplift."); delete f.defaultChange; }
  if (f.defaultChange && !f.upliftMethod) f.upliftMethod = inferred("Standard" satisfies UpliftMethod);
  const segs = v<number>("segments");
  const ov = v<SchedulePeriodOverride[]>("overrides");
  if (ov && segs) { const bad = ov.filter(o => o.segment > segs); if (bad.length) { x.errors.push(`Overrides for segment(s) ${bad.map(o => o.segment).join(", ")} are beyond the ${segs} segment(s).`); f.overrides = { ...f.overrides!, value: ov.filter(o => o.segment <= segs) }; } }
  if (x.form === "group-deal" && f.periodBoundary) { x.notes.push(`Period boundary (${v<string>("periodBoundary")}) isn't part of a group ramp — Salesforce keeps each line's own boundary.`); delete f.periodBoundary; }
  if (x.form === "schedule" && f.periodBoundary) { x.notes.push(`Period boundary (${v<string>("periodBoundary")}) is set per ramp deal, not on a schedule template — apply it on the deal.`); delete f.periodBoundary; }
  if (x.form === "group-deal" && ov?.some(o => o.quantity !== null)) {
    // Group ramps carry uplift (UnitPriceUplift) and discount (Discount) per segment GROUP; QuoteLineGroup has no quantity field.
    x.warnings.push("Group ramps set uplift and discount per segment group (QuoteLineGroup.UnitPriceUplift / Discount); per-segment quantity isn't part of a group ramp — removed (each line keeps its own quantity).");
    f.overrides = { ...f.overrides!, value: ov.map(o => ({ ...o, quantity: null })).filter(o => o.value !== null || o.discount !== null) };
  }
  if (x.form === "deal" && period && period !== "Yearly") x.warnings.push("Line ramps (Ramp Deal API) produce Yearly segments only — use a Group Ramp for monthly / quarterly / custom periods.");
  if (x.form === "deal" && v<UpliftMethod>("upliftMethod") === "Compound") x.warnings.push("Compound uplift needs a group ramp unless this org lets the app write RampUpliftType on quote lines.");
  if (x.form === "deal" || x.form === "group-deal") {
    const start = v<string>("contractStart"), end = v<string>("contractEnd");
    if (start && end && end < start) { x.errors.push("The contract end date is before the start date."); delete f.contractEnd; }
    if (start && !end && months && segs) f.contractEnd = inferred(addDays(addMonths(start, trial + months * segs), -1));
    else if (start && !end && f.contractMonths) f.contractEnd = inferred(addDays(addMonths(start, v<number>("contractMonths")!), -1));
    if (start && start < today) x.warnings.push(`The contract start ${start} is in the past.`);
    if (f.quoteName && f.useSelectedQuote?.value === true) delete f.useSelectedQuote;
  }
}

/* ── merging into a form (client) ── */

export interface RefGroup<T> { key: keyof T & string; with?: (keyof T & string)[]; resets?: (keyof T & string)[] }
export interface MergeConflict<T> { key: keyof T & string; label: string; current: unknown; proposed: unknown; patch: Partial<T>; reference: boolean }

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merge an AI patch into the current form without clobbering the user's work:
 *  · Salesforce record selections (`refs`) the user already made are NEVER replaced silently — a different AI choice becomes a
 *    conflict the user must confirm (applying it also applies its companion fields and resets dependents, e.g. quote → line).
 *  · Other fields: applied when the form still has its default / empty value, or when the user explicitly asked to replace;
 *    otherwise a differing value is a conflict ("keep mine" is the default).
 */
export function mergeAiPatch<T extends object>(current: T, patch: Partial<T>, o: { defaults: Partial<T>; refs: RefGroup<T>[]; replace: boolean; labels?: Partial<Record<keyof T & string, string>> }): { next: T; applied: string[]; conflicts: MergeConflict<T>[] } {
  const next = { ...current } as T;
  const cur = current as Record<string, unknown>, pat = patch as Record<string, unknown>, def = o.defaults as Record<string, unknown>;
  const applied: string[] = [];
  const conflicts: MergeConflict<T>[] = [];
  const companion = new Set(o.refs.flatMap(r => r.with ?? []));
  const label = (k: string) => (o.labels as Record<string, string> | undefined)?.[k] ?? k;
  const groupOf = (k: string) => o.refs.find(r => r.key === k);
  const blocked = new Set<string>(); // dependents of a reference the user must confirm first
  for (const ref of o.refs) {
    if (!(ref.key in pat) || blocked.has(ref.key)) continue;
    const proposed = pat[ref.key];
    const bundle = Object.fromEntries([ref.key, ...(ref.with ?? [])].filter(k => k in pat).map(k => [k, pat[k]])) as Partial<T>;
    if (empty(proposed) || same(cur[ref.key], proposed)) continue;
    const resets = Object.fromEntries((ref.resets ?? []).filter(k => !(k in pat)).map(k => [k, null])) as Partial<T>;
    if (empty(cur[ref.key])) { Object.assign(next, bundle, resets); applied.push(ref.key); continue; }
    // Conflict: the AI's dependents (e.g. the line it found on ITS quote) travel with this confirmation, never applied on their own.
    const deps: Record<string, unknown> = {};
    for (const d of ref.resets ?? []) {
      if (!(d in pat)) continue;
      blocked.add(d);
      for (const k of [d, ...(groupOf(d)?.with ?? [])]) if (k in pat) deps[k] = pat[k];
    }
    conflicts.push({ key: ref.key, label: label(ref.key), current: cur[(ref.with ?? [])[0] ?? ref.key] ?? cur[ref.key], proposed: pat[(ref.with ?? [])[0] ?? ref.key] ?? proposed, patch: { ...bundle, ...resets, ...deps } as Partial<T>, reference: true });
  }
  const refKeys = new Set(o.refs.map(r => r.key));
  for (const [k, proposed] of Object.entries(pat)) {
    if (refKeys.has(k as keyof T & string) || companion.has(k as keyof T & string) || proposed === undefined) continue;
    if (same(cur[k], proposed)) continue;
    const untouched = empty(cur[k]) || same(cur[k], def[k]);
    if (untouched || o.replace) { (next as Record<string, unknown>)[k] = proposed; applied.push(k); }
    else conflicts.push({ key: k as keyof T & string, label: label(k), current: cur[k], proposed, patch: { [k]: proposed } as Partial<T>, reference: false });
  }
  // a reference applied above may have reset a dependent that the patch also proposes — the patch wins for those
  return { next, applied, conflicts };
}

/** Labels the UI shows for missing / optional lists. */
export function optionalNotSupplied(form: RampAiForm, fields: Record<string, AiValue>): string[] {
  const required = new Set(RAMP_AI_REQUIRED[form]);
  const skip = new Set(["useSelectedQuote", "useSelectedLine", "useSelectedGroup", "contractMonths", "freeTrial"]);
  return RAMP_AI_FIELDS[form].filter(s => !skip.has(s.key) && !fields[s.key] && !required.has(s.label)).map(s => s.label);
}

/** The JSON contract the AI is asked for — listed per form so the prompt and the validator can't drift apart. */
export function aiSchemaDescription(form: RampAiForm): string {
  return RAMP_AI_FIELDS[form].map(s => {
    const k = s.kind;
    const type = k.t === "enum" ? k.values.map(x => `"${x}"`).join(" | ") : k.t === "int" ? `integer ${k.min}-${k.max}` : k.t === "number" ? "number" : k.t === "percent" ? "number (percent units: 5 means 5%)" : k.t === "date" ? '"YYYY-MM-DD"' : k.t === "bool" ? "boolean" : k.t === "overrides" ? "[{segment: integer (1 = first paid segment), value: number|null (uplift % / amount / price), quantity: number|null, discount: number|null}]" : "string";
    return `  "${s.key}": ${type}   // ${s.label}`;
  }).join("\n");
}
