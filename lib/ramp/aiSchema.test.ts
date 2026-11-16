/**
 * RAMP AI schema validation (pure): types, supported values, normalization, explicit vs inferred, derivations, invalid combinations,
 * missing-required honesty, and merging into a form without clobbering the user's values. Run: `npx tsx --test lib/ramp/aiSchema.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeAiPatch, normalizeDate, normalizePercent, optionalNotSupplied, validateAiExtraction, aiSchemaDescription, RAMP_AI_FIELDS } from "./aiSchema";

const T = "2026-11-10";
const v = (value: unknown, source: "explicit" | "inferred" = "explicit") => ({ value, source });

test("dates normalize to YYYY-MM-DD; ambiguous / impossible dates are rejected", () => {
  assert.equal(normalizeDate("2027-01-01"), "2027-01-01");
  assert.equal(normalizeDate("2027/1/5"), "2027-01-05");
  assert.equal(normalizeDate("January 15, 2027"), "2027-01-15");
  assert.equal(normalizeDate("15 Jan 2027"), "2027-01-15");
  assert.equal(normalizeDate("01/02/2027"), null, "US vs EU order is ambiguous — never guessed");
  assert.equal(normalizeDate("2027-02-30"), null);
  assert.equal(normalizeDate(20270101), null);
});

test("percentages normalize ('5%' → 5); out-of-range / non-numeric rejected", () => {
  assert.equal(normalizePercent("5%"), 5);
  assert.equal(normalizePercent(" 7.5 % "), 7.5);
  assert.equal(normalizePercent(10), 10);
  assert.equal(normalizePercent("five"), null);
  assert.equal(normalizePercent(-150), null);
  assert.equal(normalizePercent(5000), null);
});

test("invalid field types and unsupported values are rejected, Id fields are never accepted from the AI", () => {
  const x = validateAiExtraction("schedule", { fields: { period: v("Weekly"), segments: v("three"), upliftMethod: v("Exponential"), basePriceMultiplier: v(-2), productId: v("01t000000000001AAA"), bogus: v(1), name: v("3y") } }, T);
  const reasons = Object.fromEntries(x.rejected.map(r => [r.key, r.reason]));
  assert.match(reasons.period, /Monthly, Quarterly, Yearly, Custom/);
  assert.match(reasons.segments, /whole number/);
  assert.match(reasons.upliftMethod, /Standard, Compound/);
  assert.match(reasons.basePriceMultiplier, /number from/);
  assert.match(reasons.productId, /never taken from the AI/);
  assert.match(reasons.bogus, /not a field/);
  assert.deepEqual(Object.keys(x.fields), ["name"]);
});

test("enum values are matched case/space-insensitively to the exact Salesforce value", () => {
  const x = validateAiExtraction("product-segment", { fields: { segmentType: v("free trial"), trialDuration: v(30), durationType: v("days") } }, T);
  assert.equal(x.fields.segmentType.value, "FreeTrial");
  assert.equal(x.fields.durationType.value, "Days");
});

test("explicit vs inferred: '3-year yearly, 5% standard' → segments inferred from contract length; uplift method inferred", () => {
  const x = validateAiExtraction("schedule", { fields: { name: v("3y 5%"), period: v("Yearly"), contractMonths: v(36), defaultChange: v("5%"), freeTrial: v(false) } }, T);
  assert.deepEqual(x.fields.segments, { value: 3, source: "inferred" });
  assert.deepEqual(x.fields.priceChange, { value: "percent", source: "inferred" });
  assert.deepEqual(x.fields.upliftMethod, { value: "Standard", source: "inferred" });
  assert.equal(x.fields.defaultChange.source, "explicit");
  assert.equal(x.fields.defaultChange.value, 5);
  assert.deepEqual(x.errors, []);
});

test("an AI-claimed source other than inferred is treated as explicit; bare values are accepted as explicit", () => {
  const x = validateAiExtraction("schedule", { fields: { name: "Bare", period: { value: "Yearly", source: "made-up" } } }, T);
  assert.equal(x.fields.name.source, "explicit");
  assert.equal(x.fields.period.source, "explicit");
});

test("invalid combinations are reported", () => {
  const a = validateAiExtraction("schedule", { fields: { period: v("Yearly"), customMonths: v(6), freeTrial: v(false), trialMonths: v(3), priceChange: v("none"), defaultChange: v(5), segments: v(2), overrides: v([{ segment: 4, value: 10 }]) } }, T);
  assert.ok(a.errors.some(e => /yearly period is 12 month/.test(e)));
  assert.ok(a.errors.some(e => /no free trial but also gives trial months/.test(e)));
  assert.ok(a.errors.some(e => /no price change but also gives an uplift/.test(e)));
  assert.ok(a.errors.some(e => /segment\(s\) 4 are beyond the 2/.test(e)));
  assert.equal(a.fields.trialMonths, undefined);
  const b = validateAiExtraction("schedule", { fields: { period: v("Yearly"), contractMonths: v(30), segments: v(2) } }, T);
  assert.ok(b.warnings.some(w => /gives 3 segment/.test(w)));
  assert.ok(b.warnings.some(w => /prorated/.test(w)));
  const c = validateAiExtraction("schedule", { fields: { freeTrial: v(true) } }, T);
  assert.ok(c.warnings.some(w => /length isn't given/.test(w)));
  assert.equal(c.fields.trialMonths, undefined, "trial length is never invented");
});

test("free-trial months shift the derived segments; contract end is derived from the start (inferred)", () => {
  const x = validateAiExtraction("group-deal", { fields: { period: v("Yearly"), contractMonths: v(39), trialMonths: v(3), contractStart: v("2027-01-01") } }, T);
  assert.equal(x.fields.segments.value, 3);
  assert.deepEqual(x.fields.contractEnd, { value: "2030-03-31", source: "inferred" });
  assert.deepEqual(x.fields.freeTrial, { value: true, source: "inferred" });
});

test("form-specific rules: group ramps drop per-segment quantity (keep uplift + group discount); line ramps warn on non-yearly / compound; schedule drops period boundary", () => {
  const g = validateAiExtraction("group-deal", { fields: { overrides: v([{ segment: 2, value: 5, quantity: 10 }, { segment: 3, quantity: 20 }, { segment: 4, discount: 10 }]) } }, T);
  assert.deepEqual(g.fields.overrides.value, [{ segment: 2, value: 5, quantity: null, discount: null }, { segment: 4, value: null, quantity: null, discount: 10 }]);
  assert.ok(g.warnings.some(w => /per-segment quantity isn't part of a group ramp/.test(w)));
  const l = validateAiExtraction("deal", { fields: { period: v("Quarterly"), upliftMethod: v("Compound") } }, T);
  assert.ok(l.warnings.some(w => /Yearly segments only/.test(w)));
  assert.ok(l.warnings.some(w => /Compound uplift needs a group ramp/.test(w)));
  const s = validateAiExtraction("schedule", { fields: { periodBoundary: v("Anniversary") } }, T);
  assert.equal(s.fields.periodBoundary, undefined);
  assert.ok(s.notes.some(n => /set per ramp deal/.test(n)));
  const p = validateAiExtraction("product-segment", { fields: { segmentType: v("Yearly"), trialDuration: v(3) } }, T);
  assert.equal(p.fields.trialDuration, undefined);
  assert.ok(p.warnings.some(w => /only applies to a FreeTrial/.test(w)));
});

test("past start dates, end-before-start and replace flag", () => {
  const x = validateAiExtraction("group-deal", { replace: true, fields: { contractStart: v("2025-01-01"), contractEnd: v("2024-01-01") } }, T);
  assert.ok(x.warnings.some(w => /in the past/.test(w)));
  assert.ok(x.errors.some(e => /end date is before/.test(e)));
  assert.equal(x.replace, true);
  assert.equal(validateAiExtraction("deal", { fields: {} }, T).replace, false);
});

test("garbage in → nothing out (never throws)", () => {
  for (const raw of [null, "text", 42, [], { fields: "x" }, { fields: [1, 2] }]) {
    const x = validateAiExtraction("deal", raw, T);
    assert.deepEqual(x.fields, {});
  }
});

test("optional-not-supplied lists only optional fields; schema description matches the validator", () => {
  const opt = optionalNotSupplied("schedule", { name: v("x") });
  assert.ok(opt.includes("Description") && opt.includes("Uplift method"));
  assert.ok(!opt.includes("Schedule name") && !opt.includes("Period"));
  for (const form of ["product-segment", "schedule", "deal", "group-deal"] as const) for (const f of RAMP_AI_FIELDS[form]) assert.match(aiSchemaDescription(form), new RegExp(`"${f.key}"`));
});

/* ── merging into a form ── */

type F = { accountId: string | null; accountName: string | null; quoteId: string | null; quoteName: string | null; lineId: string | null; productName: string | null; name: string; segments: number };
const D: F = { accountId: null, accountName: null, quoteId: null, quoteName: null, lineId: null, productName: null, name: "", segments: 3 };
const refs = [
  { key: "accountId" as const, with: ["accountName" as const], resets: ["quoteId" as const, "quoteName" as const, "lineId" as const] },
  { key: "quoteId" as const, with: ["quoteName" as const], resets: ["lineId" as const] },
  { key: "lineId" as const, with: ["productName" as const] },
];

test("empty form: AI values are applied (references with their names)", () => {
  const m = mergeAiPatch<F>(D, { quoteId: "0Q0A", quoteName: "Q1", lineId: "0QLA", productName: "API", name: "Deal", segments: 5 }, { defaults: D, refs, replace: false });
  assert.deepEqual(m.next, { ...D, quoteId: "0Q0A", quoteName: "Q1", lineId: "0QLA", productName: "API", name: "Deal", segments: 5 });
  assert.deepEqual(m.conflicts, []);
});

test("user values are preserved: a different AI quote is a confirmation, carrying its line; scalars the user typed are kept", () => {
  const cur: F = { ...D, quoteId: "0Q0MINE", quoteName: "Mine", lineId: "0QLMINE", productName: "Mine P", name: "My deal", segments: 4 };
  const m = mergeAiPatch<F>(cur, { quoteId: "0Q0AI", quoteName: "AI quote", lineId: "0QLAI", productName: "AI P", name: "AI deal", segments: 5 }, { defaults: D, refs, replace: false });
  assert.deepEqual(m.next, cur, "nothing the user chose changed");
  const q = m.conflicts.find(c => c.key === "quoteId")!;
  assert.equal(q.reference, true);
  assert.deepEqual(q.patch, { quoteId: "0Q0AI", quoteName: "AI quote", lineId: "0QLAI", productName: "AI P" }, "the AI's line travels with its quote");
  assert.ok(!m.conflicts.some(c => c.key === "lineId"), "the line is never offered against the user's quote");
  assert.deepEqual(m.conflicts.filter(c => !c.reference).map(c => c.key).sort(), ["name", "segments"]);
});

test("replace: true applies scalar values, but Salesforce selections STILL need confirmation", () => {
  const cur: F = { ...D, quoteId: "0Q0MINE", quoteName: "Mine", name: "My deal", segments: 4 };
  const m = mergeAiPatch<F>(cur, { quoteId: "0Q0AI", quoteName: "AI", name: "AI deal", segments: 5 }, { defaults: D, refs, replace: true });
  assert.equal(m.next.name, "AI deal");
  assert.equal(m.next.segments, 5);
  assert.equal(m.next.quoteId, "0Q0MINE");
  assert.deepEqual(m.conflicts.map(c => c.key), ["quoteId"]);
});

test("a newly applied account resets the dependent quote/line unless the AI also supplied them", () => {
  const cur: F = { ...D, quoteId: null };
  const m = mergeAiPatch<F>(cur, { accountId: "001A", accountName: "Acme" }, { defaults: D, refs, replace: false });
  assert.equal(m.next.accountId, "001A");
  assert.equal(m.next.quoteId, null);
  assert.deepEqual(m.applied, ["accountId"]);
});
