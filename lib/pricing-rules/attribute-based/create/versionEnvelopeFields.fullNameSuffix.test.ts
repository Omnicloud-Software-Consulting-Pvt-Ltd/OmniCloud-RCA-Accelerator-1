/**
 * §Active ExpressionSetVersion identity collision investigation (live error: "Active ExpressionSetVersion
 * identity collision", ExpressionSetVersion 9QMak000000t6nxGAA). ROOT CAUSE: Tier-Based and Volume-Based
 * canvas builders regenerated `<fullName>` as the BARE apiName on every build — never a version-suffixed
 * identity (e.g. "..._V2") — so every version of the same procedure carried the IDENTICAL `<fullName>`.
 * `validateExpressionSetUniquenessAgainstOrg`'s collision search (which expects a version-suffixed
 * identity — see orgUniquenessValidation.test.ts) then matched ANY existing sibling version sharing that
 * bare name, including an unrelated ACTIVE one, and reported a false collision — blocking every
 * subsequent legitimate new-version build. `regenerateVersionedFullName` is the extracted fix, now shared
 * by both canvas builders; these tests exercise it directly.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { regenerateVersionedFullName } from "./versionEnvelopeFields";

test("Test 1 — donor fullName ends in '_V1', target version 2 -> produces '..._V2', never the bare apiName", () => {
  const result = regenerateVersionedFullName("Printer_Tier_Based_Pricing_Procedure_V1", "Printer_Tier_Based_Pricing_Procedure", 2);
  assert.equal(result, "Printer_Tier_Based_Pricing_Procedure_V2");
});

test("Test 2 — the exact live-reported shape: donor 'Rev_Mgmt_Default_Pricing_Procedure2_V1' style suffix, new apiName, version 1", () => {
  const result = regenerateVersionedFullName("Rev_Mgmt_Default_Pricing_Procedure2_V1", "Keyboard_Tier_Based_Pricing_Procedure", 1);
  assert.equal(result, "Keyboard_Tier_Based_Pricing_Procedure_V1");
});

test("Test 3 — preserves the donor's own separator style: bare '_1' (no V letter) stays '_<n>'", () => {
  const result = regenerateVersionedFullName("Some_Donor_1", "New_Api_Name", 3);
  assert.equal(result, "New_Api_Name_3");
});

test("Test 4 — preserves the donor's own separator style: '.1' (dot) stays '.<n>'", () => {
  const result = regenerateVersionedFullName("Some_Donor.1", "New_Api_Name", 4);
  assert.equal(result, "New_Api_Name.4");
});

test("Test 5 — preserves the donor's own separator style: '-1' (dash) stays '-<n>'", () => {
  const result = regenerateVersionedFullName("Some_Donor-1", "New_Api_Name", 5);
  assert.equal(result, "New_Api_Name-5");
});

test("Test 6 — lowercase 'v' suffix preserved (case-insensitive separator detection, not a guess)", () => {
  const result = regenerateVersionedFullName("Some_Donor_v1", "New_Api_Name", 2);
  assert.equal(result, "New_Api_Name_v2");
});

test("Test 7 — donor fullName has NO numeric suffix at all -> no suffix is invented, bare apiName returned", () => {
  const result = regenerateVersionedFullName("Some_Donor_With_No_Version_Suffix", "New_Api_Name", 2);
  assert.equal(result, "New_Api_Name", "must never guess/invent a separator style that isn't evidenced in the donor");
});

test("Test 8 — versionNumber is undefined (resolution did not run) -> falls back to reproducing the donor's own suffix digits", () => {
  const result = regenerateVersionedFullName("Printer_Tier_Based_Pricing_Procedure_V1", "Printer_Tier_Based_Pricing_Procedure", undefined);
  assert.equal(result, "Printer_Tier_Based_Pricing_Procedure_V1", "without a resolved version, the donor's own suffix is reproduced — never a fabricated one");
});

test("Test 9 — repeated builds for the SAME product never collide: V1 then V2 produce genuinely different identities", () => {
  const v1 = regenerateVersionedFullName("Rev_Mgmt_Default_Pricing_Procedure2_V1", "Printer_Tier_Based_Pricing_Procedure", 1);
  const v2 = regenerateVersionedFullName(v1, "Printer_Tier_Based_Pricing_Procedure", 2);
  assert.notEqual(v1, v2, "each successive version must get its OWN distinct identity");
  assert.equal(v1, "Printer_Tier_Based_Pricing_Procedure_V1");
  assert.equal(v2, "Printer_Tier_Based_Pricing_Procedure_V2");
});
