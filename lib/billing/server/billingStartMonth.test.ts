import { test } from "node:test";
import assert from "node:assert/strict";
import { billingStartMonth, billingStartMonthPatch, scheduleErrorCause } from "@/lib/billing/server/orderBilling";

test("Schedule error diagnosis — billingStartMonth names the annual Order Products and their context inputs", () => {
  const cause = scheduleErrorCause(["Required fields are missing: billingStartMonth"], [
    { product: { id: "01t1", name: "Antivirus", code: null }, billingFrequency: "Annual", billingStartMonth: { required: true, current: null, boundary: null, expected: "10", source: "EffectiveDate" } },
    { product: { id: "01t2", name: "Headset", code: null }, billingFrequency: null, billingStartMonth: { required: false, current: null, boundary: null, expected: null, source: null } },
  ]);
  assert.match(cause!, /PeriodBoundaryStartMonth/);
  assert.match(cause!, /Antivirus \(Period Boundary blank, Start Month blank\)/);
  assert.doesNotMatch(cause!, /Headset/);
});

test("Schedule error diagnosis — other missing inputs and non-field errors", () => {
  assert.match(scheduleErrorCause(["Required fields are missing: billToContact"], [])!, /Bill To Contact/);
  assert.match(scheduleErrorCause(["Required fields are missing: somethingNew"], [])!, /"somethingNew"/);
  assert.equal(scheduleErrorCause(["Insufficient access"], []), null);
});

test("Billing start month — annual line derives the month (1–12) from its Service Date", () => {
  assert.deepEqual(billingStartMonth({ frequency: "Annual", current: null, serviceDate: "2026-03-15", effectiveDate: "2026-10-29" }),
    { required: true, current: null, boundary: null, expected: "3", source: "ServiceDate" });
});

test("Billing start month — p10 order 00000149: no Service Date, Order Start Date 2026-10-29 → Anniversary + month 10", () => {
  const b = billingStartMonth({ frequency: "Annual", current: null, boundary: null, serviceDate: null, effectiveDate: "2026-10-29" });
  assert.deepEqual(b, { required: true, current: null, boundary: null, expected: "10", source: "EffectiveDate" });
  assert.deepEqual(billingStartMonthPatch(b), { PeriodBoundary: "Anniversary", PeriodBoundaryStartMonth: "10" });
});

test("Billing start month — existing Period Boundary / Start Month are never overwritten", () => {
  const set = billingStartMonth({ frequency: "Annual", current: "1", boundary: "AlignToCalendar", serviceDate: "2026-10-29", effectiveDate: "2026-10-29" });
  assert.equal(billingStartMonthPatch(set), null);
  assert.deepEqual(billingStartMonthPatch(billingStartMonth({ frequency: "Annual", current: "1", boundary: null, serviceDate: null, effectiveDate: "2026-10-29" })), { PeriodBoundary: "Anniversary" });
  assert.deepEqual(billingStartMonthPatch(billingStartMonth({ frequency: "Annual", current: null, boundary: "AlignToCalendar", serviceDate: null, effectiveDate: "2026-04-01" })), { PeriodBoundaryStartMonth: "4" });
});

test("Billing start month — annual line with no start date is unresolved, never a made-up month", () => {
  const b = billingStartMonth({ frequency: "Annual", current: null, serviceDate: null, effectiveDate: null });
  assert.deepEqual(b, { required: true, current: null, boundary: null, expected: null, source: null });
  assert.equal(billingStartMonthPatch(b), null);
  assert.equal(billingStartMonth({ frequency: "Annual", current: null, serviceDate: "not-a-date", effectiveDate: "2026-13-01" }).expected, null);
});

test("Billing start month — monthly, quarterly and one-time lines are left alone", () => {
  for (const frequency of ["Monthly", "Quarterly", "Semi-Annual", null]) {
    const r = billingStartMonth({ frequency, current: null, boundary: null, serviceDate: "2026-10-29", effectiveDate: "2026-10-29" });
    assert.equal(r.required, false, String(frequency));
    assert.equal(billingStartMonthPatch(r), null, String(frequency));
  }
});
