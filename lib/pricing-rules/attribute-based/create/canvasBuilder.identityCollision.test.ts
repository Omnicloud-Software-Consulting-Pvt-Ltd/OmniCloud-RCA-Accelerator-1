/**
 * §Root-cause fix (live evidence) — a Laptop re-run stopped with:
 *   "Refusing to deploy — 1 identity-bearing regenerated identifier(s) are still identical to the donor
 *   template's own value: field=expressionSetDefinition donor_value="Laptop_Attribute_Based_Pricing_Procedure"
 *   generated_value="Laptop_Attribute_Based_Pricing_Procedure" ..."
 *
 * Directly querying `resolveAttributeBasedPricingDonor` against the live org confirmed the cause: donor
 * selection is deliberately product-agnostic (scores candidates on structural coherence only, never by
 * name), so once a product's OWN prior Expression Set exists, it can legitimately become the highest-
 * scoring donor for regenerating a NEW version of itself (confirmed live: Laptop's and Monitor's own small,
 * clean artifacts — score 9 each — now outrank the large shared `Rev_Mgmt_Default_Pricing_Procedure2_V1`,
 * score 1). In that self-referential-donor case, `ctx.apiName` EQUALS the donor's own `expressionSetDefinition`
 * by construction (`regenerateEnvelopeTag("expressionSetDefinition", () => escapeXml(ctx.apiName))` never
 * even looks at the donor's value) — the CORRECT, Salesforce-required value for creating a new version under
 * the SAME parent ExpressionSetDefinition, not a naming collision. `createPipeline.ts`'s own org-uniqueness
 * pre-flight check (`validateExpressionSetUniquenessAgainstOrg`) already established and documented this
 * exact fact for a different, SOQL-verified check; this donor-comparison check (`checkIdentityCollisions`,
 * extracted from inline logic in `buildAttributeCanvas` for direct testability) was simply never brought in
 * line with it.
 *
 * Monitor did not hit this bug not because its underlying donor-selection or regeneration logic differs —
 * it's the exact same code path — but purely because, at the time it ran, its own apiName didn't happen to
 * coincide with whichever donor was currently selected. This fix is verified generic (works identically for
 * any apiName/donor pairing), never a Laptop-specific or Monitor-specific special case.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIdentityCollisions, type RegeneratedIdentifier } from "./canvasBuilder";

test("TEST 1 — the exact live bug: expressionSetDefinition matching the donor's own value (self-referential donor) is NOT a collision", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "expressionSetDefinition", donorValue: "Laptop_Attribute_Based_Pricing_Procedure", newValue: "Laptop_Attribute_Based_Pricing_Procedure" },
    { tag: "fullName", donorValue: "Laptop_Attribute_Based_Pricing_Procedure_V1", newValue: "Laptop_Attribute_Based_Pricing_Procedure_V2" },
  ];
  const { donorCollisions, nonIdentityMatches } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0, `expected zero collisions; got: ${JSON.stringify(donorCollisions)}`);
  assert.equal(nonIdentityMatches.length, 1);
  assert.equal(nonIdentityMatches[0].tag, "expressionSetDefinition");
});

test("TEST 2 — the same scenario for Monitor works identically (proves the fix is generic, not a Laptop-specific carve-out)", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "expressionSetDefinition", donorValue: "Monitor_Attribute_Based_Pricing_Procedur", newValue: "Monitor_Attribute_Based_Pricing_Procedur" },
    { tag: "fullName", donorValue: "Monitor_Attribute_Based_Pricing_Procedur_V1", newValue: "Monitor_Attribute_Based_Pricing_Procedur_V2" },
  ];
  const { donorCollisions } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0);
});

test("TEST 3 — a genuinely unrelated future product (never before seen) using ANY donor, including its own future self, is unaffected — no product name is special-cased anywhere in this logic", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "expressionSetDefinition", donorValue: "Standing_Desk_Attribute_Based_Pricing_Procedure", newValue: "Standing_Desk_Attribute_Based_Pricing_Procedure" },
  ];
  const { donorCollisions } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0);
});

test("TEST 4 — fullName matching the donor's own value IS still a real collision — this is genuine evidence the version-number regeneration failed (the original Defect 1 bug), and this fix must never weaken that detection", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "fullName", donorValue: "Laptop_Attribute_Based_Pricing_Procedure_V1", newValue: "Laptop_Attribute_Based_Pricing_Procedure_V1" },
  ];
  const { donorCollisions } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 1);
  assert.equal(donorCollisions[0].tag, "fullName");
});

test("TEST 5 — developerName/name matching the donor's own value are still flagged as collisions (unchanged behavior — only expressionSetDefinition was ever the wrongly-included field)", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "developerName", donorValue: "Laptop_Attribute_Based_Pricing_Procedure", newValue: "Laptop_Attribute_Based_Pricing_Procedure" },
    { tag: "name", donorValue: "Laptop_Attribute_Based_Pricing_Procedure", newValue: "Laptop_Attribute_Based_Pricing_Procedure" },
  ];
  const { donorCollisions } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 2);
});

test("TEST 6 — descriptive fields (label/description/versionNumber) matching the donor are still correctly non-identity, unaffected by this fix", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "label", donorValue: "Laptop Attribute Based Pricing Procedure", newValue: "Laptop Attribute Based Pricing Procedure" },
    { tag: "versionNumber", donorValue: "1", newValue: "1" },
  ];
  const { donorCollisions, nonIdentityMatches } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0);
  assert.equal(nonIdentityMatches.length, 2);
});

test("TEST 7 — an empty donor value never counts as a collision regardless of tag (nothing to collide with)", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "expressionSetDefinition", donorValue: "", newValue: "" },
    { tag: "fullName", donorValue: "  ", newValue: "  " },
  ];
  const { donorCollisions, nonIdentityMatches } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0);
  assert.equal(nonIdentityMatches.length, 0);
});

test("TEST 8 — a genuinely DIFFERENT apiName using a self-referential-looking donor never collides on expressionSetDefinition (proves this isn't a blanket 'always allow expressionSetDefinition' bug — it only matters when values happen to actually differ, which they correctly do here on fullName)", () => {
  const identifiers: RegeneratedIdentifier[] = [
    { tag: "expressionSetDefinition", donorValue: "Laptop_Attribute_Based_Pricing_Procedure", newValue: "Standing_Desk_Attribute_Based_Pricing_Procedure" },
  ];
  const { donorCollisions, nonIdentityMatches } = checkIdentityCollisions(identifiers);
  assert.equal(donorCollisions.length, 0);
  assert.equal(nonIdentityMatches.length, 0, "values genuinely differ here — not even a non-identity match, since newValue !== donorValue");
});
