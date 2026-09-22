/**
 * Bundle-Based Pricing donor-selection coverage — mirrors
 * lib/pricing-rules/attribute-based/create/donorInspection.scoreFloor.test.ts's exact end-to-end pattern
 * (a real client.metadataSoapCall/zip round-trip, never a hand-rolled reimplementation of the
 * eligibility/scoring logic), verifying:
 *   1. A clean, connected BundleDiscount donor is selected.
 *   2. A net-negative-scoring donor is NEVER selected, even as the only candidate.
 *   3. AttributeDiscount is treated as an "unrelated" shared-pricing-branch type for BUNDLE scoring —
 *      the exact swap this module's own donorInspection.ts documents (opposite of the attribute module,
 *      which treats BundleDiscount as unrelated).
 *
 * Same caveat as every other *.test.ts in this repo: no test framework/runner is installed — this file
 * type-checks under `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `npx tsx --test`) to execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveBundleBasedPricingDonor } from "./donorInspection";

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`test fixture SOAP body is missing <${tag}>`);
  return m[1];
}

async function buildMockClient(donorXmlByFileName: Record<string, string>): Promise<SalesforceClient> {
  const zip = new JSZip();
  for (const [fileName, xml] of Object.entries(donorXmlByFileName)) zip.file(fileName, xml);
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

test("resolveBundleBasedPricingDonor selects a clean, strongly-connected BundleDiscount donor", async () => {
  const cleanDonor = `<ExpressionSetDefinition>
    <fullName>Clean_Bundle_Pricing_V1</fullName>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
      <steps><name>BD1</name><actionType>BundleDiscount</actionType><parentStep>LP1</parentStep></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Clean_Bundle_Pricing_V1.expressionSetDefinition-meta.xml": cleanDonor });

  const resolution = await resolveBundleBasedPricingDonor(client);

  assert.ok(resolution.selection, "a clean, unbundled, strongly-connected BundleDiscount donor must be selected");
  assert.equal(resolution.selection!.fullName, "Clean_Bundle_Pricing_V1");
  assert.equal(resolution.lowConfidenceCandidates, undefined);
});

test("resolveBundleBasedPricingDonor NEVER selects a connected donor whose overall confidence score is negative", async () => {
  const negativeScoreDonor = `<ExpressionSetDefinition>
    <fullName>Shared_Pricing_Procedure_V1</fullName>
    <versions>
      <steps><name>Formula1</name><actionType>FormulaBasedPricing</actionType><sequenceNumber>1</sequenceNumber></steps>
      <steps><name>Manual1</name><actionType>ManualDiscount</actionType><sequenceNumber>2</sequenceNumber></steps>
      <steps><name>Volume1</name><actionType>VolumeTierDiscount</actionType><sequenceNumber>3</sequenceNumber></steps>
      <steps><name>Attr1</name><actionType>AttributeDiscount</actionType><sequenceNumber>4</sequenceNumber></steps>
      <steps><name>Proration1</name><actionType>Proration</actionType><sequenceNumber>5</sequenceNumber></steps>
      <steps><name>Subscription1</name><actionType>SubscriptionPricing</actionType><sequenceNumber>6</sequenceNumber></steps>
      <steps><name>Filler1</name><actionType>SomeOtherStep</actionType><sequenceNumber>7</sequenceNumber></steps>
      <steps><name>Filler2</name><actionType>SomeOtherStep</actionType><sequenceNumber>8</sequenceNumber></steps>
      <steps><name>PS1</name><actionType>PricingSettings</actionType><sequenceNumber>9</sequenceNumber></steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType><sequenceNumber>10</sequenceNumber></steps>
      <steps><name>BD1</name><actionType>BundleDiscount</actionType><sequenceNumber>11</sequenceNumber></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Shared_Pricing_Procedure_V1.expressionSetDefinition-meta.xml": negativeScoreDonor });

  const resolution = await resolveBundleBasedPricingDonor(client);

  assert.equal(resolution.selection, null, "a net-negative-scoring donor must never be selected, even when it's the only candidate and even though it DOES prove a real connection");
  assert.ok(resolution.lowConfidenceCandidates, "the rejection must be reported as a distinct 'low confidence' case");
  assert.ok(resolution.lowConfidenceCandidates![0].score < 0);
});

test("resolveBundleBasedPricingDonor treats AttributeDiscount as an unrelated shared-pricing branch (the swap vs. the attribute module)", async () => {
  // A donor with BOTH AttributeDiscount and BundleDiscount, connected via <parentStep> — from the BUNDLE
  // resolver's perspective, AttributeDiscount is one unrelated branch (penalized), never the target.
  const mixedDonor = `<ExpressionSetDefinition>
    <fullName>Mixed_Pricing_V1</fullName>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
      <steps><name>BD1</name><actionType>BundleDiscount</actionType><parentStep>LP1</parentStep></steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const client = await buildMockClient({ "unpackaged/expressionSetDefinitions/Mixed_Pricing_V1.expressionSetDefinition-meta.xml": mixedDonor });

  const resolution = await resolveBundleBasedPricingDonor(client);

  assert.ok(resolution.selection, "one unrelated branch alone should not drop the score below the trust floor");
  const candidate = resolution.selection!.candidate;
  assert.ok(candidate.uniqueActionTypes.includes("AttributeDiscount"), "AttributeDiscount must be observed in the donor's action types");
  assert.notEqual(candidate.classification, "BUNDLE_BASED_PRICING_LIKELY", "the presence of an unrelated branch (AttributeDiscount) must prevent the cleanest classification tier");
});
