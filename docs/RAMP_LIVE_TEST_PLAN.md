# RAMP — Live Salesforce test plan

**Status: NOT RUN.** Everything in the RAMP module has been verified only against the mocked org
(`lib/ramp/server/fakeOrg.ts`, 27 automated tests). No RAMP Salesforce write has been executed. Every step below
writes to Salesforce and **requires explicit approval before it is run**.

## Ground rules

- Use a **dedicated, new Draft test quote** on a test account. Never use a production or customer quote.
- Run one scenario at a time. Record every Id the app reports (they also land in RAMP History).
- Do not retry a failed write blindly. Read the step message and the recorded Salesforce request/response first.
  Retry re-reads Salesforce before writing again.
- Deleting test data afterwards is a separate, explicitly approved action. It is not part of this plan.
- Set `RAMP_DATA_DIR` to a durable directory when testing on a hosted deployment. On Vercel/Lambda the default
  `.data/ramp` store is ephemeral.

## Prerequisites (read-only checks — the app does these)

| Check | Where | Expected |
|---|---|---|
| Org capabilities | RAMP home → capability banner (`GET /api/ramp/capabilities`) | p12: line + group ramps available, compound = group ramps. p10: group ramps unavailable. |
| Pricing procedure readiness | Salesforce Setup → the active default pricing procedure (Group Ramp Deals diagnostics shows which one is active) | Standard ready; Compound ready on p12 (`IsCompoundUpliftEnabled = true`, `UpliftMethod ← ItemRampUpliftType__std`). |
| Price Book Entry decision table | Setup → Decision Tables | Refreshed **after** the newest PricebookEntry (see the earlier p12 commit `UNKNOWN_EXCEPTION`). |
| Test product | Product Ramp Setup | Active, TermDefined selling model, PricebookEntry for that selling model in the quote's price book. |

## Scenario 1 — Product Ramp Segment (1 insert)

1. Product Ramp Setup → pick the test product (untick "Already rampable only").
2. Create a `Yearly` segment for its TermDefined selling model and **confirm**.
3. Expected: `POST /sobjects/ProductRampSegment` → 201. The app reads the record back and shows `Product2.CanRamp`.
4. Record: ProductRampSegment Id, and CanRamp after creation (true/false/unknown).

## Scenario 2 — Line ramp, 3 yearly segments, Standard +10 % (p12)

1. Create a Draft quote with one TermDefined line: 36 months, start date = a 1st-of-month, qty 10.
2. Ramp Deals → New ramp deal → pick the account, quote and line. Apply a schedule: Yearly × 3, percent 10, Standard.
3. Save, then **Execute** → confirm.
4. Expected calls, in order:
   - `ramp-deal-create`, then `place` with `pricingPref: Skip`;
   - read-back of 3 segment lines sharing a RampIdentifier;
   - QuoteLineItem PATCHes where quantity, discount or uplift differ;
   - `place` with `Force`;
   - verification.
5. Expected verification:
   - 3 segments;
   - uplift 0 / 10 / 20 % (Standard is relative to the base);
   - NetUnitPrice saved on every segment;
   - `CalculationStatus` priced;
   - `LastPricedDate` ≥ the price request.
6. Record: quote Id, base line Id, RampIdentifier, segment line Ids, execution Id, and the final verification table.

**Unverified points this scenario settles:**

- Does Force pricing persist the segment prices? Instant Pricing did not (LastPricedDate stayed null).
- The `segmentType: "Yearly"` casing.

## Scenario 3 — Line ramp with a free trial

Same as Scenario 2, with a 3-month trial. Settles the `trialTermUnit` casing (the app sends `"Days"`, which is unverified).

## Scenario 4 — Group ramp, 4 quarterly segments, Compound +2 % (p12 only)

1. Draft quote with one QuoteLineGroup containing 2 TermDefined lines, 12 months.
2. Group Ramp Deals → New group ramp → pick the quote and group. Apply a schedule: Quarterly × 4, percent 2, Compound.
3. Save, then **Execute** → confirm.
4. Expected calls:
   - `place` + `EditGroup` — ONCE, only to convert the group into segment 1;
   - 3 × `clone` (last segment only, `lineScope: AllLines`), each awaited;
   - `EditRampSchedule` for dates only where they differ;
   - ONE `EditRampSchedule` for every segment: its current dates + UnitPriceUplift + `RampUpliftType` (never `EditGroup` after conversion);
   - read-back, `Force` pricing, verification.
5. Expected verification:
   - 4 ramped QuoteLineGroups with SortOrder 1–4;
   - each has 2 lines;
   - contiguous dates;
   - applied uplift ≠ 0 from segment 2;
   - net prices compounding (base × 1.02ⁿ);
   - pricing saved.
6. Record: QuoteLineGroup Ids per segment, line Ids, async request Ids, and the verification table.

**Unverified points this scenario settles:**

- Settled 2026-11-10: `EditGroup` after conversion is refused ("You can’t convert a group to a ramped segment when the quote has a ramp schedule").
- Settled 2026-11-10: `pricingPref: Skip` is accepted for EditGroup (conversion returned 201).
- Still open: whether `EditRampSchedule` saves UnitPriceUplift / RampUpliftType on the segments (Scenario 4c).

## Scenario 4c — Segment uplift + method via EditRampSchedule (fix of 2026-11-10; p12 only)

Isolated: a NEW Draft quote, so the failed runs on quotes #72 / #73 and every other ramp stay untouched.

1. New Draft quote (Any Partner Inc, Standard Price Book) → new group → add API Access Premium (Term Based - Yearly), quantity 1,
   2027-01-01 → 2029-12-31.
2. Group ramp: Yearly × 3, Standard, 5 % → Save → **Execute** → confirm.
3. Expected requests, in this order and nothing else:
   - `place` EditGroup on the group: StartDate, EndDate, SortOrder 1, IsRamped true, SegmentType Yearly — nothing else;
   - `clone` of segment 1, then `clone` of segment 2;
   - (`EditRampSchedule` for dates only if the clones' dates differ — p12's #72 / #73 clones already matched);
   - ONE `place` EditRampSchedule listing all 3 segments, each with its current StartDate / EndDate, UnitPriceUplift (0, 5, 5) and
     RampUpliftType Standard (Salesforce defaulted Compound);
   - `place` pricingPref Force; read-back; verify.
4. Read back: the 3 segment groups and their lines show UnitPriceUplift 0 / 5 / 5 and RampUpliftType Standard; dates unchanged;
   one RampIdentifier per product across the 3 segments; LastPricedDate after the Force request.
5. If Salesforce returns 201 but does NOT keep the uplift, the run stops at "Set segment uplift" with that message — no other write
   is sent. Record the response; the next option to evaluate is then a separate decision.

Also check in this run (fix of 2026-11-10 — uplift was 0% on every group segment because a group deal's base price is 0):
- Apply the saved schedule "Ramp trail" (5 %) — the preview must show 0 / 5 / 5 and the EditRampSchedule request must carry
  UnitPriceUplift 0 / 5 / 5.
- Optional second run: a segment group discount (e.g. 10 % on segment 2). The request then also carries QuoteLineGroup.Discount;
  confirm Salesforce keeps it on the segment group (its own Trial segments use Discount = 100) and how pricing applies it to the lines.

Not part of this test: retrying the failed runs on quotes #72 / #73. They can be retried afterwards on explicit request — Retry
re-runs only "Set segment uplift" with the same single EditRampSchedule (no re-conversion, no clones).

## Scenario 4b — Group Ramp from scratch: new quote, new group, new lines (p12 only)

1. Group Ramp Deals → New group ramp → pick a test Account → **Create New Quote** with a name and the Standard Price Book → confirm.
   - Expected: `POST /sobjects/Quote` with Name, QuoteAccountId, Pricebook2Id and optionally ExpirationDate.
   - Read back with its Id and Quote Number; Status is Draft.
2. **Create New Group** "Platform Ramp" → confirm.
   - Expected: `POST /sobjects/QuoteLineGroup` with Name, QuoteId and SortOrder.
   - Read back with IsRamped = false.
3. Add API Access Premium (Term Based - Yearly), quantity 5 → confirm.
   - Expected: `POST /sobjects/QuoteLineItem` with the Yearly PricebookEntry, QuoteLineGroupId, StartDate, EndDate and PeriodBoundary = Anniversary.
   - Read back inside the group with a TermDefined selling model.
   - Unverified: whether Salesforce accepts the line without a Billing Frequency or Billing Treatment. The Quote module once hit
     "Add a Billing Treatment" when the PricebookEntry didn't match the selling model.
4. The diagnostics panel should show the group as eligible. API Access Premium (UsageModelType Anchor) appears as a warning;
   p12 group-ramped it on quotes #46 and #60–#64.
5. Continue with Scenario 4 (3 yearly segments) and record every Id.

## Scenario 5 — Resume and idempotency

During Scenario 2 or 4, close the tab after the commit/clone step. Reopen Execution Center → the run shows interrupted
→ Resume. Expected: completed steps are not repeated (no duplicate segments or clones), and the run finishes and verifies.

## Scenario 6 — p10 (negative)

Group Ramp Deals on p10 must be blocked at validation with the org-setting message. A line ramp with Compound must be
refused (RampUpliftType is read-only on QuoteLineItem). No write may be sent.

## Results log (fill in when run)

| Scenario | Date | Org | Approved by | Result | Ids |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
