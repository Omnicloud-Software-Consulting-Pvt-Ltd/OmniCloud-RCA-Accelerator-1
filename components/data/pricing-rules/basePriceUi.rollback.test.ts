/**
 * §Rollback — Tests 2 & 3: the editable "Base Price ($)" field and its propagation into the create payload
 * were restored verbatim in TierBasedPricingCreate.tsx/VolumeBasedPricingCreate.tsx (the "Current List
 * Price" read-only display and its exclusively-display-only markup were removed). Neither component can be
 * driven through a real render here (both are full stateful page components with no browser/JSDOM harness
 * in this repo — see shared.currentListPriceDisplay.test.tsx's own note for the same limitation), so this
 * asserts directly against the restored source: a numeric, editable `<input>` bound to Base Price exists,
 * its onChange handler is wired to state, and the user's edited value is what's sent to the create route —
 * never a read-only "Current List Price" display in its place.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["TierBasedPricingCreate.tsx", "VolumeBasedPricingCreate.tsx"];

for (const file of FILES) {
  const source = readFileSync(join(__dirname, file), "utf8");

  test(`Test 2 — ${file}: an editable Base Price ($) input exists in the review UI`, () => {
    assert.match(source, /Base Price \(\$\)/);
    assert.match(source, /<input type="number" value=\{basePriceInput\} onChange=\{e => onBasePriceChange\(e\.target\.value\)\}/);
  });

  test(`Test 3 — ${file}: the user's edited Base Price value is sent in the create payload, not a fixed/derived one`, () => {
    assert.match(source, /basePriceInput/, "the input's own state must exist");
    assert.match(source, /callbacks\.onConfirmCreate\(result\.product, tiers, Number\(basePriceInput\)/, "the edited value must be read back out when confirming create");
    assert.match(source, /\{ product: \{ id: product\.id, name: product\.name \}, tiers: confirmedTiers, basePrice, procedureName, activate: true \}/, "basePrice must be part of the literal POST body sent to the create route");
  });

  test(`${file}: the read-only Current List Price display is gone`, () => {
    assert.doesNotMatch(source, /CurrentListPriceDisplay/);
    assert.doesNotMatch(source, /Source: Standard Price Book/);
  });
}
