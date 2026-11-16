/**
 * Debit memos are billed only through the standard billing cycle (2026-11-16: "Process Now" removed — it confused users and
 * invoiced memos outside the customer's billing cycle). Neither the UI, the API, nor an AI prompt can select it any more.
 *
 * Run: `npx tsx --test lib/billing/server/debitMemoBillingMode.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BILLING_MODES } from "./debitMemoLifecycle";
import { DEBIT_AI_SYSTEM } from "./debitMemos";

test("the only billing mode is the standard billing cycle", () => {
  assert.deepEqual([...BILLING_MODES], ["standard"]);
});

test("the lifecycle no longer invoices a debit memo through Invoice Ingestion (Process Now)", () => {
  const src = readFileSync("lib/billing/server/debitMemoLifecycle.ts", "utf8");
  assert.doesNotMatch(src, /actions\/ingest/);
  assert.doesNotMatch(src, /generate-invoice/);
  assert.doesNotMatch(src, /mode === "now"/);
});

test("the API ignores a 'now' mode — it maps to the standard cycle", () => {
  const route = readFileSync("app/api/billing/debit-memos/[id]/lifecycle/route.ts", "utf8");
  assert.match(route, /\(BILLING_MODES as readonly string\[\]\)\.includes\(String\(v\)\) \? \(v as BillingMode\) : "standard"/);
});

test("the UI has no Process Now option and always shows the standard billing cycle", () => {
  const ui = readFileSync("components/data/billing/BillingDebitMemosWorkspace.tsx", "utf8");
  assert.doesNotMatch(ui, /PROCESS NOW|Process Now/);
  assert.doesNotMatch(ui, /name="dm-mode"/);
  assert.match(ui, /STANDARD_BILLING = \{ label: "Standard billing cycle"/);
});

test("an AI prompt can't request immediate processing", () => {
  assert.doesNotMatch(DEBIT_AI_SYSTEM, /billingMode/);
  assert.doesNotMatch(readFileSync("lib/ai/promptGuides/billing.ts", "utf8"), /invoice it now/);
});
