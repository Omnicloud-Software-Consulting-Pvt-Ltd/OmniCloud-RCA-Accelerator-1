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
import { regenerateVersionedFullName, stripEnvelopeSalesforceIds, protectXmlBlocks, restoreXmlBlocks } from "./versionEnvelopeFields";

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

test("Test 7 — donor fullName has NO numeric suffix at all, but versionNumber IS resolved -> a suffix is REQUIRED, defaults to '_V<n>', never bare (TBP-20260923-210132-FAD5)", () => {
  const result = regenerateVersionedFullName("Some_Donor_With_No_Version_Suffix", "New_Api_Name", 2);
  assert.equal(result, "New_Api_Name_V2", "a resolved version number must ALWAYS produce a suffixed identity — falling back to bare apiName is exactly the identity-drift bug this guards against");
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

// §TBP-20260923-210132-FAD5 — the exact live reproduction: donor is the app's OWN prior output
// ("Keyboard_Tier_Based_Pricing_Procedure", already existing, self-referential donor-chaining) whose own
// fullName carries NO suffix at all (e.g. because it predates this fix, or came from an unrelated donor
// convention) — this must NOT reproduce the reported bug ("Target identity 'Keyboard_Tier_Based_Pricing_
// Procedure' matches an existing Draft ExpressionSetVersion ... will be updated in place").
test("Test 10 — exact live reproduction: self-referential donor with no suffix + resolved version 2 -> still produces a suffixed identity, never the bare name that collided with the existing Draft version", () => {
  const result = regenerateVersionedFullName("Keyboard_Tier_Based_Pricing_Procedure", "Keyboard_Tier_Based_Pricing_Procedure", 2);
  assert.equal(result, "Keyboard_Tier_Based_Pricing_Procedure_V2");
  assert.notEqual(result, "Keyboard_Tier_Based_Pricing_Procedure", "must never equal the bare apiName once a version number has been resolved — that is precisely the identity drift that caused an unintended update-in-place against an existing Draft version");
});

test("Invariant — for ANY donor value, a resolved versionNumber NEVER produces the bare apiName", () => {
  const donors = ["Anything", "Some_Thing_With_No_Suffix", "Weird.Value-123abc", ""];
  for (const donor of donors) {
    const result = regenerateVersionedFullName(donor, "My_Api_Name", 7);
    assert.notEqual(result, "My_Api_Name", `donor="${donor}" must not collapse to the bare apiName when versionNumber is resolved`);
    assert.match(result, /7$/, `donor="${donor}" must end in the resolved version number`);
  }
});

// §TBP-20260923-210132-FAD5, Part 3/6/8 test 6 — the envelope-region Id-hygiene fix: a donor's own
// ExpressionSetVersion record Id (real Salesforce Id shape) living in the `<versions>` envelope (OUTSIDE
// `<steps>`, where no `<id>` strip ever ran before this fix) must never survive into a newly-generated
// version.
test("stripEnvelopeSalesforceIds — a donor's own real Salesforce Id in the envelope (<versions><id>...</id>) is removed", () => {
  const envelope = `<versions><id>9QMak000000t9XJGAY</id><fullName>Keyboard_Tier_Based_Pricing_Procedure_V1</fullName><status>Draft</status></versions>`;
  const result = stripEnvelopeSalesforceIds(envelope);
  assert.doesNotMatch(result, /<id>9QMak000000t9XJGAY<\/id>/, "the donor's own record Id must not survive into a newly-generated version's envelope");
  assert.match(result, /<fullName>Keyboard_Tier_Based_Pricing_Procedure_V1<\/fullName>/, "non-Id envelope content must be left untouched");
});

test("stripEnvelopeSalesforceIds — a non-Salesforce-Id-shaped value (e.g. the exact live 'U#190f.3fffffff' shape) is left untouched by this narrow pass (caught instead by the final-payload scanner, salesforceIdValidation.ts)", () => {
  const envelope = `<versions><expressionSetDefinitionVersionId>U#190f.3fffffff</expressionSetDefinitionVersionId></versions>`;
  const result = stripEnvelopeSalesforceIds(envelope);
  assert.match(result, /U#190f\.3fffffff/, "this pass only strips genuine 15-18 char Salesforce Ids — never invents a broader pattern that risks removing a legitimate value");
});

test("stripEnvelopeSalesforceIds — an envelope with no <id> tag at all is returned unchanged", () => {
  const envelope = `<versions><fullName>Some_Procedure_V1</fullName></versions>`;
  assert.equal(stripEnvelopeSalesforceIds(envelope), envelope);
});

// §TBP-20260924-064323-C4D9 — "Specify a valid data type for the LowerBoundField variable." Root cause:
// a `<variables>` declaration's own `<name>` was never protected from the generic envelope-wide `<name>`
// regeneration, so a step's parameter referencing that variable BY NAME survived unchanged while the
// variable's own declaration got silently renamed to the apiName — a dangling reference.
test("protectXmlBlocks/restoreXmlBlocks — a <variables> block's own <name> survives a generic '<name>...' regex replace that would otherwise corrupt it", () => {
  const envelope = `<versions><name>Donor_Procedure</name><variables><name>TierLowerBoundVar</name><dataType>Double</dataType></variables></versions>`;
  const blocks = new Map<string, string>();
  const protectedText = protectXmlBlocks(envelope, "variables", blocks);
  // Simulate the exact hazard: a blanket, non-global <name> regeneration (this codebase's own real pattern).
  const regenerated = protectedText.replace(/<name>[\s\S]*?<\/name>/, `<name>Monitor_Tier_Based_Pricing_Procedure</name>`);
  const restored = restoreXmlBlocks(regenerated, blocks);
  assert.match(restored, /<variables><name>TierLowerBoundVar<\/name><dataType>Double<\/dataType><\/variables>/, "the variable's own name/dataType must survive byte-for-byte");
  assert.match(restored, /<name>Monitor_Tier_Based_Pricing_Procedure<\/name>/, "the version's own <name> is still correctly regenerated");
});

test("protectXmlBlocks/restoreXmlBlocks — multiple <variables> blocks are each independently protected and restored", () => {
  const envelope = `<versions><variables><name>VarA</name><dataType>Double</dataType></variables><variables><name>VarB</name><dataType>Currency</dataType></variables></versions>`;
  const blocks = new Map<string, string>();
  const protectedText = protectXmlBlocks(envelope, "variables", blocks);
  assert.doesNotMatch(protectedText, /VarA|VarB/, "both blocks must be swapped out for opaque tokens");
  const restored = restoreXmlBlocks(protectedText, blocks);
  assert.equal(restored, envelope);
});

test("protectXmlBlocks — an envelope with no matching block at all is returned unchanged, and restore is a no-op", () => {
  const envelope = `<versions><name>Some_Procedure</name></versions>`;
  const blocks = new Map<string, string>();
  const protectedText = protectXmlBlocks(envelope, "variables", blocks);
  assert.equal(protectedText, envelope);
  assert.equal(restoreXmlBlocks(protectedText, blocks), envelope);
});
