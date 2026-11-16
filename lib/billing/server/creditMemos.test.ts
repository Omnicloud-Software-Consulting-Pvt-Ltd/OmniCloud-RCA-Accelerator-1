import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creditMemoTotalWithTax, sumAggregate } from "@/lib/billing/server/creditMemos";
import { money } from "@/components/data/billing/creditMemoFormat";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("Credit Memo total — TotalAmountWithTax is shown even when it differs from TotalAmount", () => {
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: 11800 }), 11800);
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 11800, TotalAmountWithTax: 10000 }), 10000);
});

test("Credit Memo total — missing / invalid TotalAmountWithTax is unavailable, never TotalAmount", () => {
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000 }), null);
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: null }), null);
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: "11800" }), null);
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: Number.NaN }), null);
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 10000, TotalAmountWithTax: Number.POSITIVE_INFINITY }), null);
  assert.equal(creditMemoTotalWithTax(null), null);
  assert.equal(money(creditMemoTotalWithTax({ TotalAmount: 10000 }), "INR"), "—");
});

test("Credit Memo total — a genuine zero inclusive total stays zero", () => {
  assert.equal(creditMemoTotalWithTax({ TotalAmount: 5, TotalAmountWithTax: 0 }), 0);
  assert.equal(money(0, "INR"), `INR ${(0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
});

test("Credit Memo aggregate — no numeric SUM is unavailable (—), a genuine zero SUM stays zero", () => {
  assert.equal(sumAggregate([], "amt"), null);
  assert.equal(sumAggregate([{ Status: "Posted", amt: null }], "amt"), null);
  assert.equal(money(sumAggregate([], "amt"), "INR"), "—");
  assert.equal(sumAggregate([{ Status: "Posted", amt: 0 }], "amt"), 0);
  assert.notEqual(money(sumAggregate([{ Status: "Posted", amt: 0 }], "amt"), "INR"), "—");
  assert.equal(sumAggregate([{ amt: 6 }, { amt: 10 }, { amt: null }], "amt"), 16);
});

test("Credit Memo source guard — no TotalAmount fallback; sort and aggregate use TotalAmountWithTax; UI labels and tile", () => {
  const server = read("lib/billing/server/creditMemos.ts");
  assert.doesNotMatch(server, /\?\?\s*num\(r\.TotalAmount\)/);
  assert.match(server, /amount: creditMemoTotalWithTax\(r\)/);
  assert.match(server, /amount: "TotalAmountWithTax"/);
  assert.match(server, /SUM\(TotalAmountWithTax\) amt/);
  const ui = read("components/data/billing/BillingCreditMemosWorkspace.tsx");
  assert.match(ui, /label="Total Credit Amount" value=\{money\(data\.stats\.amount, data\.currency\)\}/);
  assert.match(ui, /\["amount", "Total with Tax"\]/);
  assert.match(ui, /label="Total with Tax">\{money\(cm\.creditMemo\.amount\)\}/);
  assert.match(ui, /label="Total with Tax">\{money\(cm\.amount\)\}/);
  assert.doesNotMatch(ui, /label="Amount"/);
});

test("Credit Memo Applied / Remaining Balance cards — missing or invalid SUM shows —, a genuine zero shows 0.00", () => {
  const zero = `INR ${(0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const key of ["app", "bal"]) {
    assert.equal(money(sumAggregate([], key), "INR"), "—");
    assert.equal(money(sumAggregate([{ Status: "Posted", [key]: null }], key), "INR"), "—");
    assert.equal(money(sumAggregate([{ Status: "Posted", [key]: "12" }], key), "INR"), "—");
    assert.equal(money(sumAggregate([{ Status: "Posted", [key]: Number.NaN }], key), "INR"), "—");
    assert.equal(money(sumAggregate([{ Status: "Posted", [key]: 0 }], key), "INR"), zero);
    assert.equal(sumAggregate([{ [key]: 6 }, { [key]: 4 }], key), 10);
  }
  assert.equal(money(Number.POSITIVE_INFINITY, "INR"), "—");
  assert.equal(money(undefined, "INR"), "—");
  const server = read("lib/billing/server/creditMemos.ts");
  assert.match(server, /SUM\(TotalCreditAmountApplied\) app, SUM\(Balance\) bal/);
  assert.match(server, /applied: sumAggregate\(live, "app"\), balance: sumAggregate\(live, "bal"\)/);
  const ui = read("components/data/billing/BillingCreditMemosWorkspace.tsx");
  assert.match(ui, /label="Applied" value=\{money\(data\.stats\.applied, data\.currency\)\}/);
  assert.match(ui, /label="Remaining Balance" value=\{money\(data\.stats\.balance, data\.currency\)\}/);
  assert.doesNotMatch(ui, /data\.stats\.\w+ \?\? 0/);
});
