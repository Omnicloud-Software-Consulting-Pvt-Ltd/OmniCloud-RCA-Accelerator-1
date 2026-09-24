/**
 * §PRE-FLIGHT regression coverage (new this turn) — "IMPORTANT: DO NOT FAIL AFTER PARTIAL CREATION."
 * Before this fix, schema/donor resolution ran interleaved with (and in the donor's case, long after)
 * real mutating steps — a broken/missing Expression Set donor in the org was only discovered after
 * Attribute Values, a Price Adjustment Schedule, and every Rule/Condition/Adjustment had already been
 * created in Salesforce. This exercises the REAL exported `runCreateAttributePricingPipeline` end-to-end
 * against a mock client that has NO `createRecord`/`updateRecord` implementation at all — if the pipeline
 * ever attempts to mutate Salesforce before PRE-FLIGHT passes, the test fails with a TypeError instead of
 * silently succeeding.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import type { SalesforceClient, DescribeField, DescribeResult } from "@/lib/salesforce/client";
import { runCreateAttributePricingPipeline, type CreatePipelineInput } from "./createPipeline";
import type { DiscoveredProduct, DiscoveredAttribute, PricingRulePlanRow } from "../types";

function field(name: string, type: string, extra: Partial<DescribeField> = {}): DescribeField {
  return { name, label: name, type, createable: true, updateable: true, ...extra } as DescribeField;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) throw new Error(`test fixture SOAP body is missing <${tag}>`);
  return m[1];
}

const RULE_DESCRIBE: DescribeResult = {
  name: "AttributeBasedAdjRule", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [field("Id", "id"), field("Name", "string"), field("Product2Id", "reference", { referenceTo: ["Product2"] }), field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] })],
} as unknown as DescribeResult;
const CONDITION_DESCRIBE: DescribeResult = {
  name: "AttributeAdjustmentCondition", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
    field("ProductAttributeDefinitionId", "reference", { referenceTo: ["ProductAttributeDefinition"] }),
    field("Product2Id", "reference", { referenceTo: ["Product2"] }), field("StringValue", "string"),
  ],
} as unknown as DescribeResult;
const ABA_DESCRIBE: DescribeResult = {
  name: "AttributeBasedAdjustment", label: "", labelPlural: "", recordTypeInfos: [], urls: {},
  fields: [
    field("Id", "id"), field("Product2Id", "reference", { referenceTo: ["Product2"] }),
    field("PriceAdjustmentScheduleId", "reference", { referenceTo: ["PriceAdjustmentSchedule"] }),
    field("AttributeBasedAdjRuleId", "reference", { referenceTo: ["AttributeBasedAdjRule"] }),
    field("ProductSellingModelId", "reference", { referenceTo: ["ProductSellingModel"] }),
  ],
} as unknown as DescribeResult;

/** A mock client with NO createRecord/updateRecord at all — any attempt by the pipeline to mutate
 * Salesforce before PRE-FLIGHT passes throws a TypeError ("... is not a function"), failing the test. */
async function buildNoMutationClient(donorZipEntries: Record<string, string>): Promise<SalesforceClient> {
  const zip = new JSZip();
  for (const [fileName, xml] of Object.entries(donorZipEntries)) zip.file(fileName, xml);
  const zipBase64 = await zip.generateAsync({ type: "base64" });

  return {
    apiVersion: "62.0",
    debugLog: [],
    logDebug() { /* no-op */ },
    async describeObject(objectName: string) {
      if (objectName === "AttributeBasedAdjRule") return RULE_DESCRIBE;
      if (objectName === "AttributeAdjustmentCondition") return CONDITION_DESCRIBE;
      if (objectName === "AttributeBasedAdjustment") return ABA_DESCRIBE;
      throw new Error(`unexpected describeObject(${objectName})`);
    },
    async query() {
      // Every query the pipeline issues before/during PRE-FLIGHT (selling model lookup, the read-only
      // "existing records" sample inside schema prep) is already wrapped in a try/catch or `.catch()` by
      // the caller — safe to simply fail every one of them here; PRE-FLIGHT must still complete using
      // only Describe + the donor Metadata retrieval.
      throw new Error("no SOQL data configured for this test — PRE-FLIGHT must not depend on it");
    },
    async metadataSoapCall(soapAction: string, bodyXml: string) {
      if (soapAction === "retrieve") return `<result><id>proc-1</id><done>true</done></result>`;
      if (soapAction === "checkRetrieveStatus") {
        const asyncProcessId = extractTag(bodyXml, "asyncProcessId");
        assert.equal(asyncProcessId, "proc-1");
        return `<result><id>proc-1</id><done>true</done><success>true</success><zipFile>${zipBase64}</zipFile></result>`;
      }
      throw new Error(`unexpected metadataSoapCall: ${soapAction}`);
    },
    // Deliberately NO createRecord / updateRecord.
  } as unknown as SalesforceClient;
}

function buildInput(client: SalesforceClient): CreatePipelineInput {
  const product: DiscoveredProduct = { id: "01tPRODUCT000000AAA", name: "Test Product", productCode: "TP-1", status: "Active", currency: "USD", basePrice: 100 };
  const attributes: DiscoveredAttribute[] = [{ name: "Memory", label: "Memory", dataType: "Text", isPriceImpacting: true, values: [{ value: "RAM 8GB", label: "RAM 8GB" }] }];
  const rules: PricingRulePlanRow[] = [{ attributeName: "Memory", attributeLabel: "Memory", value: "RAM 8GB", valueLabel: "RAM 8GB", adjustmentType: "fixed", adjustment: -10, stated: true, isNewValue: false }];
  return { client, product, discoveredAttributes: attributes, rules, excludedAttributes: [], procedureName: "Test Procedure", activate: false };
}

test("PRE-FLIGHT: no valid Expression Set donor in the org -> pipeline fails at the 'preflight' step with ZERO createRecord/updateRecord calls (no Attribute Value, Schedule, Rule, Condition, or Adjustment is ever created)", async () => {
  // An empty org: zero ExpressionSetDefinition files retrieved at all.
  const client = await buildNoMutationClient({});
  const result = await runCreateAttributePricingPipeline(buildInput(client));

  assert.equal(result.success, false);
  assert.equal(result.failure?.step, "preflight", `expected failure at the 'preflight' step, got '${result.failure?.step}'`);
  assert.ok(/AttributeDiscount/.test(result.failure!.reason), "the diagnostic must explain the missing donor, not a generic error");
  // No Rule/Condition/Adjustment/Schedule Id was ever produced — proof nothing was created.
  assert.equal(result.ruleIds, undefined);
  assert.equal(result.conditionIds, undefined);
  assert.equal(result.adjustmentIds, undefined);
  assert.equal(result.priceAdjustmentScheduleId, undefined);
  assert.equal(result.createdValues, undefined);
});

test("PRE-FLIGHT: a genuinely coherent donor exists -> PRE-FLIGHT passes and the pipeline proceeds past it (fails later, at the next real mutating step, once the mock's unconfigured SOQL is hit — proving PRE-FLIGHT itself is not what blocked it)", async () => {
  const cleanDonor = `<ExpressionSetDefinition>
    <fullName>Clean_Attribute_Pricing_V1</fullName>
    <versions>
      <steps><name>PS1</name><actionType>PricingSettings</actionType></steps>
      <steps><name>LP1</name><actionType>ListPrice</actionType><parentStep>PS1</parentStep></steps>
      <steps><name>AD1</name><actionType>AttributeDiscount</actionType><parentStep>LP1</parentStep></steps>
    </versions>
  </ExpressionSetDefinition>`;
  const client = await buildNoMutationClient({ "unpackaged/expressionSetDefinitions/Clean_Attribute_Pricing_V1.expressionSetDefinition-meta.xml": cleanDonor });
  const result = await runCreateAttributePricingPipeline(buildInput(client));

  assert.equal(result.success, false, "this test's mock has no configured SOQL data beyond schema/donor resolution, so the run must fail somewhere AFTER preflight");
  assert.notEqual(result.failure?.step, "preflight", "PRE-FLIGHT itself must have passed — the donor in this test is genuinely coherent");
  const preflightSteps = (result.steps ?? []).filter(s => s.step === "preflight");
  assert.ok(preflightSteps.some(s => s.message.includes("PRE-FLIGHT PASSED")), "the Execution Log must show PRE-FLIGHT PASSED before the run proceeds further");
});
