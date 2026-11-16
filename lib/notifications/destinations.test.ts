import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeInternalHref, isSafeSalesforceUrl, isSalesforceId, resolveDestination, salesforceRecordUrl } from "@/lib/notifications/destinations";
import { parseHistory } from "@/lib/notifications/history";

const ID = "01tg800000AbCdEFGH";
const params = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

test("Destinations — each module's record opens its existing /data details deep link", () => {
  const cases: [Parameters<typeof resolveDestination>[0], Record<string, string>][] = [
    [{ objectApiName: "Product2", recordId: ID }, { module: "products", pdv: "configuration", pdid: ID }],
    [{ objectApiName: "Product2", recordId: ID, module: "Bundles" }, { module: "bundles", bdv: "detail", bdid: ID }],
    [{ objectApiName: "AttributeDefinition", recordId: ID }, { module: "attributes", adv: "detail", adid: ID }],
    [{ objectApiName: "Order", recordId: ID }, { module: "orders", ov: "workspace", oid: ID }],
    [{ objectApiName: "Order", recordId: ID, context: "billing" }, { module: "billing", bv: "order", bid: ID }],
    [{ objectApiName: "Order", recordId: ID, context: "tax" }, { module: "taxes", tv: "run", tid: ID }],
    [{ objectApiName: "Quote", recordId: ID }, { module: "quotes", qv: "workspace", qid: ID }],
    [{ objectApiName: "Contract", recordId: ID }, { module: "contracts", cv: "workspace", cid: ID }],
    [{ objectApiName: "DebitMemo", recordId: ID }, { module: "billing-debit-memos", bm: "debit-memos", bv: "debit-memo", bid: ID }],
    [{ objectApiName: "CreditMemo", recordId: ID }, { module: "billing-credit-memos", bm: "credit-memos", bv: "credit-memo", bid: ID }],
    [{ objectApiName: "Payment", recordId: ID }, { module: "billing-payments", bm: "payments", bv: "payment", bid: ID }],
    [{ objectApiName: "BillingPolicy", recordId: ID }, { module: "billing", bm: "billing-policies", bv: "detail", bid: ID }],
    [{ objectApiName: "BillingTreatment", recordId: ID }, { module: "billing", bm: "billing-treatments", bv: "detail", bid: ID }],
    [{ objectApiName: "BillingSchedule", recordId: ID }, { module: "billing", bm: "billing-schedules", bv: "detail", bid: ID }],
    [{ objectApiName: "Invoice", recordId: ID }, { module: "billing", bm: "invoices", bv: "detail", bid: ID }],
    [{ objectApiName: "TaxPolicy", recordId: ID }, { module: "taxes", tv: "detail", tm: "tax-policies", tid: ID }],
    [{ objectApiName: "TaxTreatment", recordId: ID }, { module: "taxes", tv: "detail", tm: "tax-treatments", tid: ID }],
    [{ objectApiName: "TaxRate", recordId: ID }, { module: "taxes", tv: "detail", tm: "tax-rates", tid: ID }],
  ];
  for (const [input, expected] of cases) {
    const d = resolveDestination(input);
    assert.ok(d, `${input.objectApiName} resolves`);
    assert.equal(d.exact, true, `${input.objectApiName} is a details view`);
    assert.ok(d.href.startsWith("/data?"));
    assert.deepEqual(params(d.href), expected, `${input.objectApiName}/${input.context ?? input.module ?? ""}`);
  }
});

test("Destinations — no details view or no real Id falls back to the module, never a guessed record", () => {
  const proc = resolveDestination({ objectApiName: "ExpressionSet", recordId: ID });
  assert.deepEqual([proc?.exact, params(proc!.href)], [false, { module: "pricing-rules", pv: "history" }]);
  const acct = resolveDestination({ objectApiName: "Account", recordId: ID });
  assert.deepEqual([acct?.exact, params(acct!.href)], [false, { module: "accounts" }]);
  for (const bad of [null, "", "not-an-id", "123", "' OR 1=1", `${ID}x`]) {
    const d = resolveDestination({ objectApiName: "Product2", recordId: bad });
    assert.equal(d?.exact, false, String(bad));
    assert.doesNotMatch(d!.href, /pdid/);
  }
  assert.equal(resolveDestination({ objectApiName: "SomethingUnknown__c", recordId: ID }), null);
  assert.equal(resolveDestination({ objectApiName: null, recordId: ID }), null);
});

test("Internal href validation — only this app's own pages", () => {
  for (const ok of ["/data?module=orders", "/dashboard", "/metadata?x=1"]) assert.equal(isSafeInternalHref(ok), true, ok);
  for (const bad of ["https://evil.com/data", "//evil.com/data", "/\\evil.com", "javascript:alert(1)", "/api/sf/record", "/unknown", "data", 42, null]) {
    assert.equal(isSafeInternalHref(bad), false, String(bad));
  }
});

test("Salesforce links — built from the configured instance URL and a real Id, opened only on that org", () => {
  const inst = "https://acme.my.salesforce.com/";
  assert.equal(salesforceRecordUrl(inst, "Order", ID), `https://acme.my.salesforce.com/lightning/r/Order/${ID}/view`);
  assert.equal(salesforceRecordUrl(inst, "Order", "guess"), null);
  assert.equal(salesforceRecordUrl("http://acme.my.salesforce.com", "Order", ID), null);
  assert.equal(salesforceRecordUrl(null, "Order", ID), null);
  assert.equal(salesforceRecordUrl(inst, "Order/../x", ID), null);
  const url = salesforceRecordUrl(inst, "Order", ID)!;
  assert.equal(isSafeSalesforceUrl(url, inst), true);
  assert.equal(isSafeSalesforceUrl(url, "https://other.my.salesforce.com"), false, "a link from another org is not opened");
  assert.equal(isSafeSalesforceUrl("https://acme.my.salesforce.com/secur/frontdoor.jsp?sid=x", inst), false);
  assert.equal(isSalesforceId("001g8000018AU1J"), true);
  assert.equal(isSalesforceId("801g80000018AU1JAAW"), false, "19 characters is not an Id");
});

test("Restored history — navigation fields survive a refresh only when still valid", () => {
  const now = Date.now();
  const base = { id: "n1", tone: "success", title: "Order Created Successfully", message: "", module: "Orders", recordCount: 1, at: now, read: false };
  const [ok] = parseHistory(JSON.stringify([{ ...base, recordId: ID, recordName: "00000149", objectApiName: "Order", destinationUrl: `/data?module=orders&ov=workspace&oid=${ID}`, destinationExact: true, salesforceRecordUrl: `https://acme.my.salesforce.com/lightning/r/Order/${ID}/view` }]), now);
  assert.equal(ok.destinationUrl, `/data?module=orders&ov=workspace&oid=${ID}`);
  assert.equal(ok.destinationExact, true);
  assert.equal(ok.recordId, ID);
  const [tampered] = parseHistory(JSON.stringify([{ ...base, recordId: "x'; drop", objectApiName: "Order<script>", destinationUrl: "https://evil.com", salesforceRecordUrl: "javascript:alert(1)" }]), now);
  assert.equal(tampered.recordId, undefined);
  assert.equal(tampered.objectApiName, undefined);
  assert.equal(tampered.destinationUrl, undefined);
  assert.equal(tampered.salesforceRecordUrl, undefined);
  assert.equal(tampered.title, "Order Created Successfully", "the notification itself still shows");
});
