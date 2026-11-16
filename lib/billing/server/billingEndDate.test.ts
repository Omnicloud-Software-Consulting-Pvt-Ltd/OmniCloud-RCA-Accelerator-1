import { test } from "node:test";
import assert from "node:assert/strict";
import { billingEndDate, billingEndDatePatch, scheduleErrorCause } from "@/lib/billing/server/orderBilling";

const line = (x: Partial<Parameters<typeof billingEndDate>[0]>) => billingEndDate({
  sellingModelType: "TermDefined", current: null, serviceDate: null, effectiveDate: "2026-10-30", orderEndDate: null,
  pricingTerm: 1, pricingTermUnit: "Months", subscriptionTerm: 1, pricingTermCount: null, ...x,
});

test("End date — p10 order 00000152 'Basic Training' (Term Based - Monthly, term 1, no dates) → Order start 2026-10-30, end 2026-11-29", () => {
  const b = line({});
  assert.deepEqual(b, { required: true, current: null, start: "2026-10-30", startSource: "EffectiveDate", expected: "2026-11-29", source: "Term", term: "1 month", invalid: null });
  assert.deepEqual(billingEndDatePatch(b), { EndDate: "2026-11-29" });
});

test("End date — one-time and evergreen lines need none (Salesforce sets one-time end = start; evergreen bills without an end)", () => {
  for (const sellingModelType of ["OneTime", "Evergreen", null]) {
    const b = line({ sellingModelType, subscriptionTerm: null, pricingTerm: null, pricingTermUnit: null });
    assert.equal(b.required, false, String(sellingModelType));
    assert.equal(billingEndDatePatch(b), null);
  }
});

test("End date — each Order Product uses its own service period and term", () => {
  assert.equal(line({ serviceDate: "2026-11-15", subscriptionTerm: 12 }).expected, "2027-11-14", "12 months from its own Start Date");
  assert.equal(line({ serviceDate: "2026-11-15", subscriptionTerm: 12 }).startSource, "ServiceDate");
  assert.equal(line({ pricingTermUnit: "Annual", subscriptionTerm: 3 }).expected, "2029-10-29");
  assert.equal(line({ pricingTermUnit: "Quarterly", subscriptionTerm: 2 }).expected, "2027-04-29");
  assert.equal(line({ pricingTermUnit: "Weekly", subscriptionTerm: 2 }).expected, "2026-11-12");
  assert.equal(line({ pricingTermCount: 2, pricingTerm: 3, subscriptionTerm: 99 }).expected, "2027-04-29", "PricingTermCount × the model's pricing term wins");
  assert.equal(line({ serviceDate: "2027-01-31" }).expected, "2027-02-27", "month-end start clamps like Salesforce Date.addMonths");
});

test("End date — an existing End Date is kept (never overwritten) and checked against the start", () => {
  const ok = line({ current: "2026-12-31" });
  assert.equal(ok.invalid, null);
  assert.equal(billingEndDatePatch(ok), null);
  assert.match(line({ current: "2026-10-01" }).invalid!, /before the billing start date 2026-10-30/);
});

test("End date — without a term the Order End Date (explicit period) is used; otherwise unresolved, never invented", () => {
  const fromOrder = line({ subscriptionTerm: null, orderEndDate: "2027-03-31" });
  assert.deepEqual([fromOrder.expected, fromOrder.source], ["2027-03-31", "OrderEndDate"]);
  assert.match(line({ subscriptionTerm: null, orderEndDate: "2026-01-01" }).invalid!, /no Subscription Term/, "an Order End Date before the start isn't used");
  assert.match(line({ subscriptionTerm: null }).invalid!, /no Subscription Term/);
  assert.match(line({ effectiveDate: null }).invalid!, /Start Date/);
  assert.equal(billingEndDatePatch(line({ effectiveDate: null })), null);
});

test("Schedule error diagnosis — 'end date can't be null' names the term-defined Order Products and OrderItem.EndDate", () => {
  const cause = scheduleErrorCause(["When the billing method is OrderAmount, the end date can't be null."], [
    { product: { id: "01t1", name: "Basic Training", code: null }, billingFrequency: "Monthly", billingEndDate: line({}) },
    { product: { id: "01t2", name: "Laptop Bag", code: null }, billingFrequency: null, billingEndDate: line({ sellingModelType: "OneTime" }) },
  ]);
  assert.match(cause!, /OrderItem\.EndDate/);
  assert.match(cause!, /Basic Training \(End Date blank\)/);
  assert.doesNotMatch(cause!, /Laptop Bag/);
});
