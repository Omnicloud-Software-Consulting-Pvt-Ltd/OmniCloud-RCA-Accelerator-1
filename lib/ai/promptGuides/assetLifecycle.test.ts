/** Lifecycle prompt examples + tooltips: every example must parse with the module's own rules; every lifecycle field has help. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ruleExtract } from "@/lib/assetLifecycle/ai";
import { assetLifecyclePromptGuides, LIFECYCLE_QUICK_EXAMPLES } from "./assetLifecycle";
import { LIFECYCLE_HELP, LIFECYCLE_SECTION_HELP } from "@/lib/help/lifecycleHelp";
import type { LifecycleKind } from "@/lib/assetLifecycle/types";

const TODAY = "2026-11-13";
type Item = { toQuantity: number | null; quantityChange: number | null; unitPrice: number | null; billingFrequency: string | null; swap: { kind: string; productName: string } | null };

test("every quick example and guide example parses as its own kind, for the named account, with the change it describes", () => {
  for (const kind of ["amend", "renew", "cancel"] as LifecycleKind[]) {
    const guide = assetLifecyclePromptGuides[kind];
    const all = [...LIFECYCLE_QUICK_EXAMPLES[kind], guide.example, ...(guide.moreExamples ?? [])];
    for (const ex of all) {
      const x = ruleExtract(ex.prompt, TODAY) as { kind: string; accountName: string; effectiveDate: string | null; renewal: { startDate: string | null; termMonths: number | null }; discount: number | null; cancelReason: string | null; items: Item[]; billTo: string | null };
      assert.equal(x.kind, kind, `kind of "${ex.prompt}"`);
      assert.equal(x.accountName, "Acme Corporation", `account of "${ex.prompt}"`);
      const it = x.items[0];
      if (kind === "amend") assert.ok(x.effectiveDate, `amendment date of "${ex.prompt}"`);
      if (kind === "amend") assert.ok(it.toQuantity != null || it.quantityChange != null || it.swap || it.billingFrequency || x.discount != null, `amendment change of "${ex.prompt}"`);
      if (kind === "renew") assert.ok(x.renewal.termMonths, `renewal term of "${ex.prompt}"`);
      if (kind === "cancel") assert.ok(x.effectiveDate, `cancellation date of "${ex.prompt}"`);
    }
  }
  const [up] = LIFECYCLE_QUICK_EXAMPLES.amend.filter(e => e.label === "Upgrade").map(e => ruleExtract(e.prompt, TODAY) as { items: Item[] });
  assert.deepEqual(up.items[0].swap && { kind: up.items[0].swap.kind, productName: up.items[0].swap.productName }, { kind: "upgrade", productName: "Laptop Pro" });
  const billing = ruleExtract(assetLifecyclePromptGuides.amend.moreExamples!.at(-1)!.prompt, TODAY) as { billTo: string | null; billingAddress: string | null; shippingSameAsBilling: boolean };
  assert.equal(billing.billTo, "Jane Doe");
  assert.ok(billing.billingAddress?.startsWith("1 Market St"));
  assert.equal(billing.shippingSameAsBilling, true);
  const cancel = ruleExtract(LIFECYCLE_QUICK_EXAMPLES.cancel[0].prompt, TODAY) as { cancelReason: string | null };
  assert.equal(cancel.cancelReason, "budget cuts");
});

test("help content is complete, and no lifecycle form field opts out of its tooltip", () => {
  for (const [k, v] of Object.entries({ ...LIFECYCLE_HELP, ...LIFECYCLE_SECTION_HELP })) assert.ok(v.text.length > 20, `help text for ${k}`);
  const dir = join(process.cwd(), "components/data/assetLifecycle");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".tsx"))) {
    assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /help=\{null\}/, `${file} has a field without a tooltip`);
  }
  const box = readFileSync(join(dir, "LifecyclePromptBox.tsx"), "utf8");
  assert.match(box, /data-testid="lifecycle-prompt-examples"/);
  assert.match(box, /<PromptGuide isDark=\{isDark\} config=\{assetLifecyclePromptGuides\[kind\]\} onUseExample=\{setPrompt\} \/>/);
});
