/**
 * §Follow-on 36 / Part 17 — direct regression coverage for the exact reported live bug: the resolver
 * correctly computed Rank 3 (Rank 2 was proven taken elsewhere in the org — see
 * `orgUniquenessValidation.test.ts`'s Follow-on 35 tests), but the outbound XML still carried the
 * donor's own leftover `<rank>1</rank>`. These tests exercise `injectVersionNumberAndRank` directly —
 * the exact function responsible for writing (or, per the reported bug, allegedly failing to write)
 * these two fields — without needing a full donor-XML/SalesforceClient mock.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute — `tsc --noEmit` only
 * type-checks it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectVersionNumberAndRank } from "./versionEnvelopeFields";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";

const DONOR_ENVELOPE_BEFORE = [
  "<fullName>Laptop_Attribute_Based_Pricing_Procedure_V1</fullName>",
  "<versions>",
  "  <versionNumber>1</versionNumber>",
  "  <rank>1</rank>",
  "  <status>Active</status>",
].join("\n");
const DONOR_ENVELOPE_AFTER = "\n</versions>\n";

// Part 17 TEST 2 — the exact reported bug, reproduced directly: donor has <rank>1</rank>, resolved
// candidate is 3 -> generated XML MUST contain 3, never the donor's leftover 1.
test("TEST 2 — donor has <rank>1</rank>, resolved Rank is 3: generated XML contains <rank>3</rank>, never 1", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: 3 }, 62);
  assert.equal(result.outboundRank, "3");
  assert.ok(!result.envelopeBefore.includes("<rank>1</rank>"), "the donor's leftover rank must not survive");
  assert.ok(result.envelopeBefore.includes("<rank>3</rank>"));
});

// Part 17 TEST 3 — resolved VersionNumber=2 -> generated XML contains versionNumber=2.
test("TEST 3 — resolved VersionNumber=2: generated XML contains <versionNumber>2</versionNumber>", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: 3 }, 62);
  assert.equal(result.outboundVersionNumber, "2");
  assert.ok(result.envelopeBefore.includes("<versionNumber>2</versionNumber>"));
  assert.ok(!result.envelopeBefore.includes("<versionNumber>1</versionNumber>"));
});

// Part 17 TEST 1 (payload half) — Rank 3 was resolved (after excluding Rank 2, occupied elsewhere —
// covered independently in orgUniquenessValidation.test.ts); the payload must carry exactly that value.
test("TEST 1 — resolved Rank 3 (after excluding an org-wide-occupied Rank 2) is what lands in the payload", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: 3 }, 62);
  assert.equal(result.outboundRank, "3");
  assert.equal(result.warnings.length, 0);
});

test("donor has NO <rank> tag at all: the resolved value is INSERTED immediately after <versionNumber>, never left absent", () => {
  const envelopeBeforeNoRank = [
    "<fullName>Laptop_Attribute_Based_Pricing_Procedure_V1</fullName>",
    "<versions>",
    "  <versionNumber>1</versionNumber>",
    "  <status>Active</status>",
  ].join("\n");
  const result = injectVersionNumberAndRank(envelopeBeforeNoRank, "\n</versions>\n", { versionNumber: 2, rank: 5 }, 62);
  assert.equal(result.outboundRank, "5");
  assert.ok(result.envelopeBefore.includes("<versionNumber>2</versionNumber><rank>5</rank>"));
});

test("rank is null (this org's ExpressionSetVersion schema has no Rank field): <rank> is never touched or invented", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: null }, 62);
  assert.equal(result.outboundRank, "1", "the donor's own rank is left completely alone when no rank was resolved — never zeroed out or removed");
  assert.equal(result.regeneratedIdentifiers.some(r => r.tag === "rank"), false);
});

test("deploy API version predates Rank (v62.0+): a resolved rank is NOT embedded, and a warning explains why", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: 3 }, 58);
  assert.equal(result.outboundRank, "1", "on a pre-v62 org the donor's rank is left untouched rather than sending an element Salesforce might reject");
  assert.ok(result.warnings.some(w => w.includes("predates Rank's introduction")));
});

// §Follow-on 38 — the ACTUAL root cause of the whole "Resolved Rank 3, Outbound Rank 1" saga: this was
// never a defect in the injection or verification logic (both were already correct and directly
// tested, above) — it was `PRICING_RULES_API_VERSION` (lib/pricing-rules/types.ts), the constant this
// entire module's Metadata API deploy declares itself against, being pinned to "v61.0" — exactly ONE
// version short of v62.0, the version Salesforce's Metadata API Developer Guide documents as the first
// to support `ExpressionSetDefinitionVersion.rank` at all. Every single prior run tripped the
// version-gate in `injectVersionNumberAndRank` (correctly, given a v61.0 deploy) and silently left the
// donor's leftover rank untouched — this reproduces that exact historical failure directly at 61, and
// guards against the constant ever being lowered back below 62 again.
test("Follow-on 38 root cause reproduced directly: deploy API version 61 (one short of Rank's v62.0 requirement) silently skips rank injection", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { versionNumber: 2, rank: 3 }, 61);
  assert.equal(result.outboundRank, "1", "this is the exact historical bug: v61.0 is below Rank's v62.0 minimum, so the donor's rank=1 survives untouched even though 3 was correctly resolved");
});

test("Follow-on 38 guard rail: PRICING_RULES_API_VERSION must be at least v62.0, or every Attribute-Based Pricing Rank injection silently no-ops again", () => {
  const numeric = Number.parseFloat(PRICING_RULES_API_VERSION.replace(/^v/i, ""));
  assert.ok(Number.isFinite(numeric), `PRICING_RULES_API_VERSION ("${PRICING_RULES_API_VERSION}") must parse to a number`);
  assert.ok(numeric >= 62, `PRICING_RULES_API_VERSION is "${PRICING_RULES_API_VERSION}" (${numeric}) — below 62.0, ExpressionSetDefinitionVersion.rank is unsupported and every deploy will silently skip rank injection, reproducing the exact "Resolved Rank 3, Outbound Rank 1" defect this session spent multiple turns diagnosing.`);
});

test("versionNumber undefined (no version resolution ran): <versionNumber> is left completely untouched", () => {
  const result = injectVersionNumberAndRank(DONOR_ENVELOPE_BEFORE, DONOR_ENVELOPE_AFTER, { rank: 3 }, 62);
  assert.equal(result.outboundVersionNumber, "1");
});

// §Part 4/7 TEST 3 — a step can legitimately contain an unrelated field that happens to share the tag
// name "rank" (e.g. a decision-table row's own priority/ordering value). `injectVersionNumberAndRank`
// is never even given the steps region at all (only envelopeBefore/envelopeAfter) — so by construction
// it cannot confuse the two. This test proves the contrast explicitly: a naive unscoped scan of the
// FULL assembled document (envelope + steps concatenated) would find the STEP's rank=1 first and report
// the wrong answer, while the properly-scoped function call (this codebase's actual behavior) correctly
// reports 3.
test("TEST 3 — a step's own unrelated <rank> field (appearing BEFORE the envelope's own rank in document order) is never mistaken for the ExpressionSetVersion envelope's rank", () => {
  // The version envelope's own <versionNumber>/<rank> live in envelopeAfter here (a real, valid layout
  // depending on where a given donor's <versions> block places them relative to <steps>) — meaning the
  // steps region sits BEFORE them in document order.
  const envelopeBefore = "<fullName>Laptop_Attribute_Based_Pricing_Procedure_V1</fullName>\n<versions>\n";
  const envelopeAfter = ["  <versionNumber>1</versionNumber>", "  <rank>1</rank>", "</versions>"].join("\n");
  // A step's own, entirely unrelated decision-table-row "rank"/priority field, appearing FIRST in
  // document order — exactly the shape that would fool a naive unscoped first-match scan.
  const stepsRegionXml = "<steps><actionType>AttributeDiscount</actionType><rank>1</rank></steps>";

  const result = injectVersionNumberAndRank(envelopeBefore, envelopeAfter, { versionNumber: 2, rank: 3 }, 62);
  assert.equal(result.outboundRank, "3", "the properly-scoped function correctly resolves the envelope's own rank regardless of where the step region sits");

  // Demonstrates the exact false-positive a naive unscoped scan of the FULL assembled document would
  // produce — proof of the bug class this scoping avoids, not a claim the current code does this (it
  // doesn't: `injectVersionNumberAndRank` is never given `stepsRegionXml` at all, so it structurally
  // cannot make this mistake).
  const fullAssembledDocument = result.envelopeBefore + stepsRegionXml + result.envelopeAfter;
  const naiveUnscopedMatch = fullAssembledDocument.match(/<rank>([\s\S]*?)<\/rank>/);
  assert.equal(naiveUnscopedMatch?.[1], "1", "an unscoped first-match scan finds the STEP's unrelated rank=1 first — the exact false-positive class of bug the envelope-scoped extraction avoids");
});
