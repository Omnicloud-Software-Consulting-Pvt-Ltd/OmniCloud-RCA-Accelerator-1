/**
 * §Root-cause investigation (this turn) — live error: "PriceAdjustmentScheduleId isn't a valid variable
 * name" during the actual Salesforce Metadata API deploy (Create Expression Set Version / Create Pricing
 * Procedure), i.e. AFTER every local validation gate already passed. Static analysis alone could not
 * conclusively distinguish which of two structurally different uses of this name Salesforce rejected:
 * AttributeDiscount's own nested `<parameters>` value, or a genuine envelope-level `<variables>`
 * declaration — so rather than guess a rename, `buildScheduleVariableDiagnostic` dumps both exactly as
 * they exist in the deployed bytes. These tests prove the diagnostic itself correctly finds/reports each
 * shape, so the NEXT live failure's output gives real evidence instead of another blind guess.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScheduleVariableDiagnostic } from "./canvasBuilder";

test("buildScheduleVariableDiagnostic reports a genuine envelope-level <variables> declaration named PriceAdjustmentScheduleId", () => {
  const xml =
    `<Metadata>` +
    `<variables><name>PriceAdjustmentScheduleId</name><description>test</description><dataType>Text</dataType></variables>` +
    `<variables><name>SomeOtherVariable</name></variables>` +
    `<steps><actionType>AttributeDiscount</actionType></steps>` +
    `</Metadata>`;

  const report = buildScheduleVariableDiagnostic(xml);
  assert.match(report, /Envelope-level <variables> declarations found: 2/);
  assert.match(report, /name="PriceAdjustmentScheduleId" ◄◄◄ MATCHES THE REJECTED NAME/);
  assert.match(report, /name="SomeOtherVariable"/);
});

test("buildScheduleVariableDiagnostic correctly reports ZERO envelope-level <variables> when none exist (rules out mechanism #2)", () => {
  const xml = `<Metadata><steps><actionType>AttributeDiscount</actionType></steps></Metadata>`;
  const report = buildScheduleVariableDiagnostic(xml);
  assert.match(report, /Envelope-level <variables> declarations found: 0/);
  assert.match(report, /rules out mechanism #2/);
});

test("buildScheduleVariableDiagnostic dumps every raw occurrence of the name with surrounding context, for a parameter-value-only shape", () => {
  const xml =
    `<Metadata>` +
    `<steps><actionType>AttributeDiscount</actionType>` +
    `<customElement><parameters><name>PriceAdjustmentScheduleId</name><value>PriceAdjustmentScheduleId</value></parameters></customElement>` +
    `</steps></Metadata>`;

  const report = buildScheduleVariableDiagnostic(xml);
  assert.match(report, /Envelope-level <variables> declarations found: 0/);
  assert.match(report, /byte offset \d+/);
  // Both occurrences (the <name> and the <value>) must be captured, not just the first.
  const occurrenceLines = report.split("\n").filter(l => l.startsWith("[byte offset"));
  assert.equal(occurrenceLines.length, 2, `expected both occurrences dumped; got: ${JSON.stringify(occurrenceLines)}`);
});

test("buildScheduleVariableDiagnostic reports explicitly when the name doesn't appear at all", () => {
  const xml = `<Metadata><steps><actionType>AttributeDiscount</actionType></steps></Metadata>`;
  const report = buildScheduleVariableDiagnostic(xml);
  assert.match(report, /was not found anywhere in the deployed file/);
});
