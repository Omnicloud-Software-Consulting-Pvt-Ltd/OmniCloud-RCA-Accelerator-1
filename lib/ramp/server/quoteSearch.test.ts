/**
 * RAMP Draft-quote lookup (MOCKED Salesforce shaped like p10/p12 as verified read-only on 2026-11-09: quotes carry their account in
 * Quote.QuoteAccountId, Quote.AccountId is null on most of them; Status picklist includes "Draft"). Covers the server search, the lookup
 * route contract, errors (never an empty list), pagination, and that the picked quote Id is what the ramp execution uses.
 * Run: `npx tsx --test lib/ramp/server/quoteSearch.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeOrg } from "./fakeOrg";
import { RampStore } from "./store";
import { likeContains, quoteFacts, searchQuotes } from "./reads";
import { saveDeal, startExecution } from "./service";
import { blankSchedule } from "@/lib/ramp/schedule";

const SFC = "001g500000j9RBQAA2", ANY = "001g500000j9RBTAA2", EDGE = "001g500000j9RBWAA2";
const q = (id: string, name: string, num: string, status: string, o: Record<string, unknown> = {}) =>
  ({ Id: id, Name: name, QuoteNumber: num, Status: status, QuoteAccountId: null, AccountId: null, Pricebook2Id: "01sA00000000001AAA", GrandTotal: 100, LastModifiedDate: `2026-11-${num.slice(-2)}T00:00:00.000+0000`, ...o });
function seed() {
  return {
    Account: [{ Id: SFC, Name: "SFC Partners" }, { Id: ANY, Name: "Any Partner Inc" }, { Id: EDGE, Name: "Edge Communications" }],
    Quote: [
      q("0Q0g5000001juOrCAI", "Ramp Deal Test", "00000071", "Draft", { QuoteAccountId: ANY }),
      q("0Q0g5000001jtz3CAA", "ramp test 11-9-26", "00000070", "Draft", { QuoteAccountId: ANY }),
      q("0Q0g5000001jtRBCAY", "office", "00000069", "Draft", { QuoteAccountId: ANY }),
      q("0Q0g5000001hnxlCAA", "Approved one", "00000058", "Approved", { QuoteAccountId: ANY }),
      q("0Q0g8000001me13CAA", "Office Supplies", "00000025", "Draft", { AccountId: EDGE }), // only the standard AccountId set
      q("0Q0g5000001fa8bCAA", "RAMP 26", "00000064", "Draft"),
    ],
  };
}
const api = (o: Parameters<typeof fakeOrg>[1] = {}) => fakeOrg(seed(), o).api;

test("account filter: matches QuoteAccountId OR AccountId, Draft only, newest first", async () => {
  const sent: string[] = [];
  const r = await searchQuotes(api({ onQuery: s => sent.push(s) }), { accountId: ANY });
  assert.deepEqual(r.rows.map(x => x.quoteNumber), ["00000071", "00000070", "00000069"]);
  assert.ok(r.rows.every(x => x.status === "Draft" && x.accountId === ANY && x.accountName === "Any Partner Inc"));
  assert.deepEqual(r.accountFields, ["QuoteAccountId", "AccountId"]);
  assert.equal(r.draftStatus, "Draft");
  const soqlQ = sent.find(s => / FROM Quote /.test(s))!;
  assert.match(soqlQ, /WHERE Status = 'Draft' AND \(QuoteAccountId = '001g500000j9RBTAA2' OR AccountId = '001g500000j9RBTAA2'\)/);
  assert.match(soqlQ, /ORDER BY LastModifiedDate DESC, Id DESC LIMIT 26 OFFSET 0$/);
  // a quote whose account is only on the standard AccountId field is found too
  assert.deepEqual((await searchQuotes(api(), { accountId: EDGE })).rows.map(x => x.name), ["Office Supplies"]);
});

test("returns the display fields: Id, Name, Quote Number, Account, Status", async () => {
  const [row] = (await searchQuotes(api(), { accountId: ANY, q: "00000071" })).rows;
  assert.deepEqual({ id: row.id, name: row.name, quoteNumber: row.quoteNumber, status: row.status, accountId: row.accountId, accountName: row.accountName },
    { id: "0Q0g5000001juOrCAI", name: "Ramp Deal Test", quoteNumber: "00000071", status: "Draft", accountId: ANY, accountName: "Any Partner Inc" });
});

test("search by Quote Name and by Quote Number", async () => {
  assert.deepEqual((await searchQuotes(api(), { accountId: ANY, q: "office" })).rows.map(x => x.id), ["0Q0g5000001jtRBCAY"]);
  assert.deepEqual((await searchQuotes(api(), { accountId: ANY, q: "0000007" })).rows.map(x => x.quoteNumber), ["00000071", "00000070"]);
  const sent: string[] = [];
  await searchQuotes(api({ onQuery: s => sent.push(s) }), { q: "ramp" });
  assert.match(sent.find(s => / FROM Quote /.test(s))!, /\(Name LIKE '%ramp%' OR QuoteNumber LIKE '%ramp%'\)/);
});

test("LIKE text is escaped (quotes, backslashes, wildcards) — no SOQL injection", () => {
  assert.equal(likeContains("O'Brien"), "'%O\\'Brien%'");
  assert.equal(likeContains("50%_off"), "'%50\\%\\_off%'");
  assert.equal(likeContains("a\\b"), "'%a\\\\b%'");
});

test("empty result is a genuine success: an account with no quotes (SFC Partners, as in p10/p12)", async () => {
  const r = await searchQuotes(api(), { accountId: SFC });
  assert.deepEqual(r.rows, []);
  assert.equal(r.hasMore, false);
  assert.deepEqual((await searchQuotes(api(), { accountId: ANY, q: "no such quote" })).rows, []);
});

test("Salesforce errors THROW (never an empty list): query failure, Quote Describe failure, missing Draft status", async () => {
  await assert.rejects(searchQuotes(api({ failQuery: s => / FROM Quote /.test(s) }), { accountId: ANY }), /INVALID_FIELD/);
  await assert.rejects(searchQuotes(api({ failDescribe: ["Quote"] }), { accountId: ANY }), /Quote object's fields/);
  await assert.rejects(quoteFacts(fakeOrg(seed(), { failDescribe: ["Quote"] }).api, "0Q0g5000001juOrCAI"), /Quote object's fields/);
  const o = fakeOrg(seed());
  const d = (await o.api.describe("Quote")) as { fields: { name: string; picklistValues: { value: string }[] }[] };
  d.fields.find(f => f.name === "Status")!.picklistValues = [{ value: "Open" }];
  await assert.rejects(searchQuotes(o.api, { accountId: ANY }), /no "Draft" value/);
});

test("pagination: pageSize + hasMore + OFFSET, pages don't overlap", async () => {
  const p1 = await searchQuotes(api(), { accountId: ANY, pageSize: 2, page: 1 });
  const p2 = await searchQuotes(api(), { accountId: ANY, pageSize: 2, page: 2 });
  assert.deepEqual(p1.rows.map(x => x.quoteNumber), ["00000071", "00000070"]);
  assert.equal(p1.hasMore, true);
  assert.deepEqual(p2.rows.map(x => x.quoteNumber), ["00000069"]);
  assert.equal(p2.hasMore, false);
  const sent: string[] = [];
  await searchQuotes(api({ onQuery: s => sent.push(s) }), { pageSize: 1000, page: 99999 });
  assert.match(sent.find(s => / FROM Quote /.test(s))!, /LIMIT 101 OFFSET 2000$/, "clamped to SOQL limits");
});

test("all statuses (Pricing page) drops the Draft filter", async () => {
  const r = await searchQuotes(api(), { accountId: ANY, draftOnly: false });
  assert.ok(r.rows.some(x => x.status === "Approved"));
  assert.equal(r.draftStatus, null);
});

test("quoteFacts reads the account from QuoteAccountId, falling back to AccountId", async () => {
  assert.equal((await quoteFacts(api(), "0Q0g5000001juOrCAI"))?.accountId, ANY);
  assert.equal((await quoteFacts(api(), "0Q0g8000001me13CAA"))?.accountId, EDGE);
});

test("the selected quote's Salesforce Id is the one the ramp deal + execution use", async () => {
  const [picked] = (await searchQuotes(api(), { accountId: ANY, q: "Ramp Deal Test" })).rows;
  const ctx = { store: new RampStore(fs.mkdtempSync(path.join(os.tmpdir(), "rampq-"))), orgId: "00Dg500000KSpiPEAT", userId: null };
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...schedule } = { ...blankSchedule(), name: "3y", segments: 3 };
  void _i; void _c; void _u; void _b; void _v;
  const deal = await saveDeal(ctx, { kind: "line", name: "Picked quote deal", accountId: ANY, accountName: "Any Partner Inc", quoteId: picked.id, quoteName: picked.name, lineId: "0QLg5000001AAAAAAA", contractStart: "2027-01-01", contractEnd: "2029-12-31", basePrice: 100, baseQuantity: 1, schedule, periodBoundary: "Anniversary" });
  assert.equal(deal.quoteId, "0Q0g5000001juOrCAI");
  const ex = await startExecution(ctx, deal.id, true);
  assert.equal(ex.sf.quoteId, "0Q0g5000001juOrCAI");
});
