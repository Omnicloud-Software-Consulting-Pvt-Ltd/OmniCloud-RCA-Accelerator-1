import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeProductCursor, encodeProductCursor, taxablePolicyIds, taxProductSoql } from "@/lib/tax/server/records";
import { buildLookupSoql, decodeLookupCursor, encodeLookupCursor, LOOKUP_SPECS, type FieldInfo } from "@/lib/tax/server/lookup";
import { exactMatch, lookupUrl, mergeOptions } from "@/components/data/taxes/SalesforceLookup";
import type { LookupOption, TaxEngineRow, TaxPolicyRow, TaxTreatmentRow } from "@/lib/tax/types";

const COLS = "Id, Name, ProductCode, IsActive, TaxPolicyId, Family";

test("Product lookup — browsing lists ACTIVE products in (Name, Id) order with one look-ahead row, no OFFSET and no fixed cap", () => {
  const soql = taxProductSoql(COLS, { q: "", after: null, pageSize: 50, hasCode: true });
  assert.equal(soql, `SELECT ${COLS} FROM Product2 WHERE IsActive = true ORDER BY Name, Id LIMIT 51`);
  assert.doesNotMatch(soql, /OFFSET/);
});

test("Product lookup — a search matches Name or Product Code, partial and case-insensitive (SOQL LIKE), with wildcards and quotes escaped", () => {
  assert.match(taxProductSoql(COLS, { q: " sams ", after: null, pageSize: 50, hasCode: true }), /WHERE IsActive = true AND \(Name LIKE '%sams%' OR ProductCode LIKE '%sams%'\)/);
  assert.match(taxProductSoql(COLS, { q: "50%_o'x", after: null, pageSize: 50, hasCode: true }), /Name LIKE '%50\\%\\_o\\'x%'/);
  assert.doesNotMatch(taxProductSoql(COLS, { q: "ab", after: null, pageSize: 50, hasCode: false }), /ProductCode LIKE/, "no Product Code field → name only");
});

test("Product lookup — the next page continues strictly after the last row (keyset), so pages never overlap", () => {
  const cursor = encodeProductCursor({ name: "O'Brien Mouse", id: "01tg8000003Abc1AAC" });
  const after = decodeProductCursor(cursor);
  assert.deepEqual(after, { name: "O'Brien Mouse", id: "01tg8000003Abc1AAC" });
  assert.match(taxProductSoql(COLS, { q: "mouse", after, pageSize: 50, hasCode: true }),
    /AND \(Name > 'O\\'Brien Mouse' OR \(Name = 'O\\'Brien Mouse' AND Id > '01tg8000003Abc1AAC'\)\) ORDER BY Name, Id LIMIT 51$/);
  for (const bad of ["", "not-base64!", Buffer.from(JSON.stringify(["x", "1' OR Id != '"])).toString("base64url"), Buffer.from("{}").toString("base64url")]) {
    assert.equal(decodeProductCursor(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test("Product lookup — a product is 'taxable' only when its active policy resolves to an active taxable treatment of an active engine", () => {
  const engines = [{ id: "E1", status: "Active" }, { id: "E2", status: "Inactive" }] as TaxEngineRow[];
  const policies = [
    { id: "P-default", status: "Active", defaultTreatmentId: "T1" }, { id: "P-le", status: "Active", defaultTreatmentId: null },
    { id: "P-inactive-engine", status: "Active", defaultTreatmentId: "T3" }, { id: "P-exempt", status: "Active", defaultTreatmentId: "T4" },
    { id: "P-draft", status: "Draft", defaultTreatmentId: "T1" },
  ] as TaxPolicyRow[];
  const treatments = [
    { id: "T1", status: "Active", taxable: true, engineId: "E1", policyId: "P-default" }, { id: "T2", status: "Active", taxable: true, engineId: "E1", policyId: "P-le" },
    { id: "T3", status: "Active", taxable: true, engineId: "E2", policyId: "P-inactive-engine" }, { id: "T4", status: "Active", taxable: false, engineId: "E1", policyId: "P-exempt" },
  ] as TaxTreatmentRow[];
  assert.deepEqual([...taxablePolicyIds(engines, policies, treatments)].sort(), ["P-default", "P-le"]);
});

test("Product lookup — a pasted Product2 Id also matches by Id; other Ids or text never become an Id clause", () => {
  assert.match(taxProductSoql(COLS, { q: "01tg80000072GsfAAE", after: null, pageSize: 25, hasCode: true }), /OR Id = '01tg80000072GsfAAE'\)/);
  assert.doesNotMatch(taxProductSoql(COLS, { q: "001g800000tRcJUAA0", after: null, pageSize: 25, hasCode: true }), /Id = /);
  assert.doesNotMatch(taxProductSoql(COLS, { q: "LPB-001", after: null, pageSize: 25, hasCode: true }), /Id = /);
});

/* ── SalesforceLookup: Account, Contact, Invoice, GeoCountry, GeoState ── */

const F = (...names: string[]): FieldInfo[] => names.map(n => n.endsWith("Id") && n !== "Id" ? { name: n, relationshipName: n.slice(0, -2) } : { name: n });
const ACCOUNT = F("Id", "Name", "AccountNumber", "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry");

test("Lookup — Account searches Name and Account Number, a pasted Account Id matches by Id, and only the org's fields are used", () => {
  assert.equal(buildLookupSoql("Account", ACCOUNT, { q: "" }),
    "SELECT Id, Name, AccountNumber, BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry FROM Account ORDER BY Name, Id LIMIT 26");
  assert.match(buildLookupSoql("Account", ACCOUNT, { q: "any" }), /WHERE \(Name LIKE '%any%' OR AccountNumber LIKE '%any%'\)/);
  assert.match(buildLookupSoql("Account", ACCOUNT, { q: "001g800000tRcJUAA0" }), /OR Id = '001g800000tRcJUAA0'\)/);
  const noNumber = buildLookupSoql("Account", F("Id", "Name", "BillingCity"), { q: "x" });
  assert.doesNotMatch(noNumber, /AccountNumber|BillingStreet/, "a field the org lacks is neither selected nor searched");
});

test("Lookup — Contact is scoped to the selected Account (none → asks for it) and searches name and email", () => {
  const fields = F("Id", "Name", "Email", "Title", "AccountId");
  assert.throws(() => buildLookupSoql("Contact", fields, { q: "" }), /Select an Account first/);
  assert.throws(() => buildLookupSoql("Contact", fields, { q: "", accountId: "x' OR Name != '" }), /Select an Account first/);
  assert.match(buildLookupSoql("Contact", fields, { q: "asha@", accountId: "001g800000tRcJUAA0" }),
    /SELECT Id, Name, Email, Title, AccountId, Account\.Name FROM Contact WHERE AccountId = '001g800000tRcJUAA0' AND \(Name LIKE '%asha@%' OR Email LIKE '%asha@%'\)/);
});

test("Lookup — GeoState is filtered by the selected country's ISO code; GeoCountry searches name and ISO code", () => {
  const fields = F("Id", "Name", "IsoCode", "GeoCountryId");
  assert.throws(() => buildLookupSoql("GeoState", fields, { q: "" }), /Select a Country first/);
  assert.throws(() => buildLookupSoql("GeoState", fields, { q: "", country: "India" }), /Select a Country first/, "an ISO code, never a name");
  assert.match(buildLookupSoql("GeoState", fields, { q: "", country: "in" }), /FROM GeoState WHERE GeoCountry\.IsoCode = 'IN' ORDER BY Name, Id/);
  assert.match(buildLookupSoql("GeoCountry", F("Id", "Name", "IsoCode"), { q: "ind" }), /WHERE \(Name LIKE '%ind%' OR IsoCode LIKE '%ind%'\)/);
  const opt = LOOKUP_SPECS.GeoState.toOption({ Id: "0Abg00000000001AAA", Name: "Karnataka", IsoCode: "ka", GeoCountry: { Name: "India" } });
  assert.deepEqual([opt.label, opt.code, opt.facts?.iso, opt.detail], ["Karnataka", "ka", "KA", "India"]);
});

test("Lookup — Invoice: newest first, searched by invoice number or account name, keyset on CreatedDate DESC", () => {
  const fields = F("Id", "DocumentNumber", "InvoiceNumber", "BillingAccountId", "Status", "InvoiceDate", "TotalAmountWithTax", "CreatedDate");
  assert.match(buildLookupSoql("Invoice", fields, { q: "DOC-0000000" }),
    /WHERE \(DocumentNumber LIKE '%DOC-0000000%' OR InvoiceNumber LIKE '%DOC-0000000%' OR BillingAccount\.Name LIKE '%DOC-0000000%'\) ORDER BY CreatedDate DESC, Id DESC LIMIT 26$/);
  const cursor = encodeLookupCursor("2026-10-30T07:26:58.000+0000", "3ttg8000000Tb5pAAC");
  assert.match(buildLookupSoql("Invoice", fields, { q: "", cursor }), /WHERE \(CreatedDate < 2026-10-30T07:26:58Z OR \(CreatedDate = 2026-10-30T07:26:58Z AND Id < '3ttg8000000Tb5pAAC'\)\)/);
  assert.equal(decodeLookupCursor(encodeLookupCursor("2026-10-30) OR (Id != null", "3ttg8000000Tb5pAAC"), "datetime"), null, "a forged datetime is rejected");
  const o = LOOKUP_SPECS.Invoice.toOption({ Id: "3ttg8000000Tb5pAAC", DocumentNumber: "DOC-000000031", Status: "Posted", InvoiceDate: "2026-10-30", TotalAmountWithTax: 149.98, BillingAccountId: "001g800000tRcJUAA0", BillingAccount: { Name: "Any Partner Inc" } });
  assert.deepEqual([o.id, o.label, o.code, o.detail], ["3ttg8000000Tb5pAAC", "DOC-000000031", "Posted", "Any Partner Inc · 2026-10-30 · total 149.98"]);
});

test("Lookup — an Account without street, city and country is flagged (the verification refuses it)", () => {
  const ok = LOOKUP_SPECS.Account.toOption({ Id: "001g800000tRcJUAA0", Name: "A", BillingStreet: "1 Rd", BillingCity: "Bengaluru", BillingState: "KA", BillingCountry: "IN" });
  assert.deepEqual([ok.facts?.billingComplete, ok.badge, ok.detail], [true, null, "Bengaluru, KA, IN"]);
  const bad = LOOKUP_SPECS.Account.toOption({ Id: "001g800000tRcJUAA1", Name: "B", BillingCity: "Pune" });
  assert.equal(bad.facts?.billingComplete, false);
  assert.equal(bad.badge?.tone, "warn");
});

test("Lookup (client) — pages merge without duplicates, the URL carries object/term/cursor/scope, prefilled text needs an exact match", () => {
  const o = (id: string, label = id, code: string | null = null): LookupOption => ({ id, label, code, detail: null, badge: null });
  assert.deepEqual(mergeOptions([o("a"), o("b")], [o("b", "dup"), o("c"), o("c")]).map(x => x.id), ["a", "b", "c"]);
  assert.equal(lookupUrl("Product2", "Laptop Basic", null), "/api/taxes/lookup?object=Product2&q=Laptop+Basic");
  assert.equal(lookupUrl("GeoState", "", "abc=", { country: "IN", accountId: null }), "/api/taxes/lookup?object=GeoState&q=&cursor=abc%3D&country=IN");
  const products = [o("01tA", "Laptop Basic", "LPB-001"), o("01tB", "Laptop Basic Plus", "LPB-002")];
  assert.equal(exactMatch(products, "lpb-001")?.id, "01tA");
  assert.equal(exactMatch(products, "laptop basic")?.id, "01tA");
  assert.equal(exactMatch(products, "Laptop"), null, "a partial name is never auto-selected");
});
