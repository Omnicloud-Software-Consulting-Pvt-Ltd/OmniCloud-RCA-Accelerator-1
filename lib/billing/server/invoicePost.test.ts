/**
 * Invoice posting (Order Setup → Post Invoice): Salesforce's response handling, the read-back message, the UI eligibility and the
 * app-route 404 diagnosis. Pure functions + source wiring — nothing here talks to Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { INVOICE_POST_PATH, invoicePostFailure, invoicePostedMessage } from "./orderBilling";
import { invoicePostable, withAppRouteDiagnosis } from "@/components/data/billing/BillingOrderSetup";

const URL = "https://example.my.salesforce.com/services/data/v64.0" + INVOICE_POST_PATH;
const res = (status: number, json: unknown, rawText = json === null ? "" : JSON.stringify(json)) => ({ url: URL, status, statusText: status === 404 ? "Not Found" : "OK", json, rawText });

test("a Salesforce 404 is a failure that keeps Salesforce's errorCode, message, endpoint and raw body", () => {
  const body = [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }];
  const f = invoicePostFailure(res(404, body), "v64.0");
  assert.ok(f, "404 is never a success");
  assert.equal(f.ok, false);
  assert.equal(f.status, 404);
  assert.equal(f.code, "NOT_FOUND");
  assert.match(f.error, /HTTP 404 NOT_FOUND\): The requested resource does not exist/);
  assert.match(f.possibleCause ?? "", /API v64\.0/);
  assert.deepEqual(f.technical, { endpoint: `POST ${URL}`, apiVersion: "v64.0", httpStatus: 404, salesforceErrors: body, rawBody: body });
});

test("a 2xx with success:false is a failure with Salesforce's own error; a non-JSON error body is preserved as text", () => {
  const f = invoicePostFailure(res(200, { success: false, errors: [{ errorCode: "INVALID_INPUT", message: "Invoice is not in Draft status" }] }), "v64.0");
  assert.equal(f?.status, 422);
  assert.equal(f?.code, "INVALID_INPUT");
  assert.match(f?.error ?? "", /Invoice is not in Draft status/);
  const html = invoicePostFailure({ ...res(500, null, "<html>Server error</html>"), statusText: "Internal Server Error" }, "v64.0");
  assert.equal(html?.code, "INVOICE_POST_FAILED");
  assert.match(html?.error ?? "", /<html>Server error<\/html>/);
});

test("an accepted request is not a failure — and success is only claimed from the status read back from Salesforce", () => {
  assert.equal(invoicePostFailure(res(201, { success: true }), "v64.0"), null);
  assert.equal(invoicePostFailure(res(200, null), "v64.0"), null);
  assert.equal(invoicePostedMessage("DOC-000000001", "Posted"), "Invoice DOC-000000001 is Posted in Salesforce.");
  assert.match(invoicePostedMessage("DOC-000000001", "In Progress"), /is In Progress\. Use Refresh Billing Status/);
  assert.match(invoicePostedMessage("DOC-000000001", "Draft"), /still reads Draft .* isn't Posted until Salesforce says so/);
  assert.doesNotMatch(invoicePostedMessage("DOC-000000001", null), /is Posted/);
});

test("Post Invoice eligibility: Draft + verified (or not yet read) tax only", () => {
  assert.equal(invoicePostable({ status: "Draft", tax: { state: "VERIFIED_TAX_APPLIED" } }), true);
  assert.equal(invoicePostable({ status: "Draft", tax: { state: "VERIFIED_ZERO_TAX" } }), true);
  assert.equal(invoicePostable({ status: "Draft", tax: null }), true, "server re-verifies tax before posting");
  assert.equal(invoicePostable({ status: "Draft", tax: { state: "TAX_VERIFICATION_FAILED" } }), false);
  for (const status of ["Posted", "In Progress", "Canceled", null]) assert.equal(invoicePostable({ status, tax: { state: "VERIFIED_TAX_APPLIED" } }), false, String(status));
});

test("a non-JSON 404 is reported as the app's route missing (never reached Salesforce); JSON errors are left untouched", () => {
  const route = "/api/billing/orders/801x/invoices/3ttx/post";
  const d = withAppRouteDiagnosis({ title: "Post Invoice", message: "Request failed with status 404", status: 404, raw: null as unknown, possibleCause: null as string | null }, route);
  assert.match(d.message, /never reached Salesforce/);
  assert.match(d.message, new RegExp(route.replace(/\//g, "\\/")));
  assert.match(d.possibleCause ?? "", /Restart the dev server/);
  const sf = { title: "Post Invoice", message: "Salesforce didn't post the invoice (HTTP 404 NOT_FOUND): …", status: 404, raw: { error: "x", code: "NOT_FOUND" } };
  assert.equal(withAppRouteDiagnosis(sf, route), sf);
});

test("wiring: the route exists, the server posts the clicked invoice with a lock + read-back, the UI posts the clicked invoice", () => {
  assert.ok(existsSync("app/api/billing/orders/[id]/invoices/[invoiceId]/post/route.ts"));
  const svc = readFileSync("lib/billing/server/orderBilling.ts", "utf8");
  const fn = svc.slice(svc.indexOf("export async function postOrderInvoice"), svc.indexOf("export const INVOICE_POST_PATH"));
  assert.match(fn, /postingInFlight\.has\(lockKey\)/);
  assert.match(fn, /requestWithDiagnostics\(INVOICE_POST_PATH, \{ method: "POST", body: JSON\.stringify\(\{ invoiceIds: \[inv\.id\] \}\) \}\)/);
  assert.ok(fn.indexOf("invoicePostingGate(") < fn.indexOf("requestWithDiagnostics("), "tax gate runs before the post request");
  assert.match(fn, /const after = await loadOrderBilling/);
  assert.doesNotMatch(fn, /Status: "Posted"|sobjects\/Invoice/, "never sets the status itself");
  const ui = readFileSync("components/data/billing/BillingOrderSetup.tsx", "utf8");
  assert.match(ui, /onClick=\{\(\) => \{ setPostTargetId\(inv\.id\); setModal\("post"\); \}\}/);
  assert.match(ui, /disabled=\{!!busy \|\| !invoicePostable\(inv\)\}/);
  assert.match(ui, /void postInvoice\(postTarget\.id\)/);
  assert.doesNotMatch(ui, /postInvoice\(draftInvoice\.id\)/);
});
