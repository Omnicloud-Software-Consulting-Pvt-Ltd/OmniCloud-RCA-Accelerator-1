/**
 * §Live-org fix (Org B) regression coverage — a real connected donor whose overall confidence score is
 * still NEGATIVE (dominated by several unrelated shared-pricing-branch penalties) must never be selected
 * just because nothing else beat it ("the current code selects the donor with a negative score"
 * live-org report). Exercises the REAL exported `resolveAttributeBasedPricingDonor` end-to-end — through
 * a genuine `client.metadataSoapCall`/zip round-trip — never a hand-rolled reimplementation of the
 * eligibility/scoring logic.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveAttributeBasedPricingDonor } from "./donorInspection";

/** A donor with a REAL AttributeDiscount->ListPrice connection (proven via the weakest signal,
 * declared sequence order — no <parentStep>, no physical nesting, no matching variable binding) but
 * bundled with all 6 known "unrelated shared-pricing-branch" action types plus 2 harmless filler steps
 * (pushing physicalStepCount past the small-step-count bonus threshold) — reproduces the exact "real
 * connection, but net-negative confidence score" shape from the live report. */
const NEGATIVE_SCORE_CONNECTED_DONOR = `<ExpressionSetDefinition>
  <fullName>Rev_Mgmt_Default_Pricing_Procedure2_V1</fullName>
  <versions>
    <steps><name>Formula1</name><actionType>FormulaBasedPricing</actionType><sequenceNumber>1</sequenceNumber></steps>
    <steps><name>Manual1</name><actionType>ManualDiscount</actionType><sequenceNumber>2</sequenceNumber></steps>
    <steps><name>Volume1</name><actionType>VolumeTierDiscount</actionType><sequenceNumber>3</sequenceNumber></steps>
    <steps><name>Bundle1</name><actionType>BundleDiscount</actionType><sequenceNumber>4</sequenceNumber></steps>
    <steps><name>Proration1</name><actionType>Proration</actionType><sequenceNumber>5</sequenceNumber></steps>
    <steps><name>Subscription1</name><actionType>SubscriptionPricing</actionType><sequenceNumber>6</sequenceNumber></steps>
    <steps><name>Filler1</name><actionType>SomeOtherStep</actionType><sequenceNumber>7</sequenceNumber></steps>
    <steps><name>Filler2</name><actionType>SomeOtherStep</actionType><sequenceNumber>8</sequenceNumber></steps>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>9</sequenceNumber></steps>
    <steps><name>LP1</name><actionType>ListPrice</actionType><sequenceNumber>10</sequenceNumber></steps>
    <steps><name>AD1</name><actionType>AttributeDiscount</actionType><sequenceNumber>11</sequenceNumber></steps>
  </versions>
</ExpressionSetDefinition>`;

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`test fixture SOAP body is missing <${tag}>`);
  return m[1];
}

/** A minimal mock of `client.metadataSoapCall` that serves one ExpressionSetDefinition file (zipped, as
 * the real Metadata API retrieve would) regardless of which members were requested — sufficient for
 * `retrieveExpressionSetDefinitionFiles(client, ["*"])`'s single real round-trip. */
async function buildMockClient(donorXmlByFileName: Record<string, string>): Promise<SalesforceClient> {
  const zip = new JSZip();
  for (const [fileName, xml] of Object.entries(donorXmlByFileName)) {
    zip.file(fileName, xml);
  }
  const zipBase64 = await zip.generateAsync({ type: "base64" });

  return {
    apiVersion: "62.0",
    logDebug() { /* no-op */ },
    async metadataSoapCall(soapAction: string, bodyXml: string) {
      if (soapAction === "retrieve") return `<result><id>proc-1</id><done>true</done></result>`;
      if (soapAction === "checkRetrieveStatus") {
        const asyncProcessId = extractTag(bodyXml, "asyncProcessId");
        assert.equal(asyncProcessId, "proc-1");
        return `<result><id>proc-1</id><done>true</done><success>true</success><zipFile>${zipBase64}</zipFile></result>`;
      }
      throw new Error(`unexpected metadataSoapCall: ${soapAction}`);
    },
  } as unknown as SalesforceClient;
}

test("resolveAttributeBasedPricingDonor NEVER selects a connected donor whose overall confidence score is negative — Org B live-org regression", async () => {
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Rev_Mgmt_Default_Pricing_Procedure2_V1.expressionSetDefinition-meta.xml": NEGATIVE_SCORE_CONNECTED_DONOR });

  const resolution = await resolveAttributeBasedPricingDonor(client);

  assert.equal(resolution.selection, null, "a net-negative-scoring donor must never be selected, even when it's the only candidate and even though it DOES prove a real connection");
  assert.ok(resolution.lowConfidenceCandidates, "the rejection must be reported as a distinct 'low confidence' case, not conflated with 'no connection proved at all'");
  assert.equal(resolution.lowConfidenceCandidates![0].fullName, "Rev_Mgmt_Default_Pricing_Procedure2_V1");
  assert.ok(resolution.lowConfidenceCandidates![0].score < 0, `expected a negative score, got ${resolution.lowConfidenceCandidates![0].score}`);
});

test("resolveAttributeBasedPricingDonor DOES select a genuinely clean, positively-scored connected donor — positive control", async () => {
  const cleanDonor = `<ExpressionSetDefinition>
    <fullName>Clean_Attribute_Pricing_V1</fullName>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Clean_Attribute_Pricing_V1.expressionSetDefinition-meta.xml": cleanDonor });

  const resolution = await resolveAttributeBasedPricingDonor(client);

  assert.ok(resolution.selection, "a clean, unbundled, strongly-connected donor must be selected");
  assert.equal(resolution.selection!.fullName, "Clean_Attribute_Pricing_V1");
  assert.equal(resolution.lowConfidenceCandidates, undefined);
});
