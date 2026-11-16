/**
 * Bundle-Based Pricing — lookup-table resolution, donor selection, Expression Set canvas binding,
 * deployed-binding inspection, and Pricing Waterfall parsing.
 *
 * The donor fixture reproduces the SHAPE of Salesforce's standard Revenue Management Default Pricing
 * Procedure (flat: every step at root, list containers linked by <parentStep>, data flowing by root
 * sequence, unrelated pricing branches around the Bundle Discount container, a Constant variable holding
 * the schedule) — every Id in it is fake. Run with `npx tsx --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  resolveBundleLookupTable, validateBundleLookupTableShape, NO_BUNDLE_LOOKUP_TABLE_MESSAGE, type ResolvedBundleLookupTable,
} from "./lookupTableResolver";
import { inspectDonorCandidate, rankCandidates, resolveConnection } from "./donorInspection";
import { buildBundleCanvasFromDonor, rebindScheduleConstant } from "./canvasBuilder";
import { inspectDeployedBundleBinding } from "./verifySalesforceState";
import { parsePricedContext } from "./quotePricingTest";
import { extractStepGraph } from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";

/* ── fixtures ── */

const P = (name: string, value: string, type: "Parameter" | "Literal" = "Parameter", output = false) =>
  `<parameters><input>${!output}</input><name>${name}</name><output>${output}</output><type>${type}</type><value>${value}</value></parameters>`;

const BD_INPUTS: [string, string][] = [
  ["PriceAdjustmentScheduleId", "BundlePASIdConstant"], ["ProductSellingModelId", "ProductSellingModel"],
  ["EffectiveFrom", "EffectiveDate"], ["EffectiveTo", "EffectiveDate"], ["ProductId", "Product"],
  ["ParentProductId", "MainItemProduct"], ["ParentProductSellingModelId", "MainItemProductSellingModel"],
  ["RootBundleId", "RootItemProduct"], ["RootProductSellingModelId", "RootProductSellingModel"],
  ["InclusivePrice", "InclusivePrice"], ["Quantity", "LineItemQuantity"], ["InputUnitPrice", "NetUnitPrice"],
];

function flatDonor(opts: { withLookup?: boolean; lookupId?: string } = {}): string {
  const lookup = opts.withLookup === false ? "" :
    P("LookUpName", "Bundle Based Adjustment Entries", "Literal") + P("LookUpId", opts.lookupId ?? "0lDFAKE00000000AAA", "Literal") + P("LookUpApiName", "Donor_Bundle_Table", "Literal");
  const step = (inner: string) => `<steps>${inner}<resultIncluded>false</resultIncluded><shouldExposExecPathMsgOnly>true</shouldExposExecPathMsgOnly><shouldExposeConditionDetails>false</shouldExposeConditionDetails><shouldShowExplExternally>false</shouldShowExplExternally></steps>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ExpressionSetDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <contextDefinitions>RevSalesTransactionContext</contextDefinitions>
    <interfaceSourceType>PricingProcedure</interfaceSourceType>
    <label>Standard Pricing Procedure</label>
    <processType>DefaultPricing</processType>
    <template>false</template>
    <versions>
        <fullName>Standard_Pricing_Procedure_V1</fullName>
        <description>Standard</description>
        <expressionSetDefinition>Standard_Pricing_Procedure</expressionSetDefinition>
        <interfaceSourceType>PricingProcedure</interfaceSourceType>
        <label>Standard Pricing Procedure V1</label>
        <processType>DefaultPricing</processType>
        <rank>1</rank>
        <shouldShowExplExternally>false</shouldShowExplExternally>
        <startDate>2025-01-01T00:00:00.000Z</startDate>
        <status>Active</status>
        ${step(`<actionType>PricingSettings</actionType><customElement>${P("LineItemId", "LineItem")}${P("NetUnitPrice", "NetUnitPrice", "Parameter", true)}</customElement><description>Pricing Setting</description><label>Pricing Setting</label><name>PricingSetting</name><sequenceNumber>1</sequenceNumber><stepType>BusinessKnowledgeModel</stepType>`)}
        ${step(`<actionType>ListPrice</actionType><customElement>${P("Product2Id", "Product")}${P("IsContractEnabled", "false", "Literal")}${P("ListPrice", "ListPrice", "Parameter", true)}</customElement><description>List Price</description><label>Price Book Entries</label><name>PriceBookEntries</name><sequenceNumber>2</sequenceNumber><stepType>BusinessKnowledgeModel</stepType>`)}
        ${step(`<label>List Container</label><name>VolumeContainer</name><sequenceNumber>3</sequenceNumber><stepType>ListGroup</stepType>`)}
        ${step(`<actionType>VolumeDiscount</actionType><customElement>${P("Quantity", "LineItemQuantity")}</customElement><description>Volume</description><label>Volume</label><name>VolumeStep</name><parentStep>VolumeContainer</parentStep><sequenceNumber>1</sequenceNumber><stepType>BusinessKnowledgeModel</stepType>`)}
        ${step(`<label>List Container</label><name>BundleContainer</name><sequenceNumber>4</sequenceNumber><stepType>ListGroup</stepType>`)}
        ${step(`<advancedCondition><conditionLogic>1</conditionLogic><criteria><operator>NotEquals</operator><sequenceNumber>1</sequenceNumber><sourceFieldName>ItemPricingSource</sourceFieldName><value>&apos;LastTransaction&apos;</value><valueType>Literal</valueType></criteria></advancedCondition><label>List Operation</label><name>BundleFilter</name><parentStep>BundleContainer</parentStep><sequenceNumber>1</sequenceNumber><stepType>AdvancedListFilter</stepType>`)}
        ${step(`<actionType>BundleDiscount</actionType><customElement>${BD_INPUTS.map(([n, v]) => P(n, v)).join("")}${lookup}${P("IsContractEnabled", "false", "Literal")}${P("sectionCount", "0", "Literal")}${P("NetUnitPrice", "NetUnitPrice", "Parameter", true)}${P("Subtotal", "ItemNetTotalPrice", "Parameter", true)}</customElement><description>Bundle</description><label>Bundle Based Adjustment Entries</label><name>BundleEntries</name><parentStep>BundleContainer</parentStep><sequenceNumber>2</sequenceNumber><stepType>BusinessKnowledgeModel</stepType>`)}
        <variables><collection>false</collection><dataType>Text</dataType><description>AmountStringConstant</description><input>false</input><name>AmountStringConstant</name><output>false</output><type>Constant</type><value>Amount</value></variables>
        <variables><collection>false</collection><dataType>Text</dataType><description>BundlePASIdConstant</description><input>false</input><name>BundlePASIdConstant</name><output>false</output><type>Constant</type><value>84XFAKEDONOR00001</value></variables>
    </versions>
</ExpressionSetDefinition>`;
}

const TABLE: ResolvedBundleLookupTable = {
  id: "0lDFAKE00000000BBB", developerName: "Resolved_Bundle_Table", label: "Resolved Bundle Table", sourceObject: "BundleBasedAdjustment",
  status: "Active", usageType: "DefaultPricing", refreshStatus: "Completed", lastSyncDate: null, selectedBy: "pricing-recipe-mapping",
  reason: "test", recipe: null,
  inputs: ["PriceAdjustmentScheduleId", "ProductSellingModelId", "EffectiveFrom", "EffectiveTo", "ProductId", "ParentProductId", "ParentProductSellingModelId", "RootBundleId", "RootProductSellingModelId"]
    .map((f, i) => ({ fieldName: f, operator: "Equals", sequence: i + 1, required: true })),
  outputs: ["AdjustmentValue", "AdjustmentType"], existingEntryCount: 0,
};

function donorResolutionFor(xml: string) {
  const candidate = inspectDonorCandidate("unpackaged/expressionSetDefinitions/Standard_Pricing_Procedure.expressionSetDefinition", xml);
  return {
    selection: {
      fullName: candidate.fullName, fileName: "unpackaged/expressionSetDefinitions/Standard_Pricing_Procedure.expressionSetDefinition", fullXml: xml, candidate,
      ranking: rankCandidates([candidate], TABLE),
      connectedBundleDiscountOccurrenceIndexes: candidate.bundleDiscountBranches.filter(b => b.connectedToListPrice).map(b => b.occurrenceIndex),
    },
    candidatesWithBundleDiscount: [candidate],
  };
}

const CTX = { procedureName: "Test Bundle Pricing", apiName: "Test_Bundle_Pricing", versionNumber: 1, rank: null, scheduleId: "84XFAKESCHED00001", lookupTable: TABLE };

/* ── lookup table resolution ── */

function lookupClient(data: { recipes?: unknown[]; mappings?: unknown[]; tables: Record<string, unknown>[]; params: Record<string, unknown>[] }) {
  return {
    logDebug() { /* no-op */ },
    async query(soql: string) {
      const recs =
        /FROM PricingRecipe WHERE/.test(soql) ? data.recipes ?? []
        : /FROM PricingRecipeTableMapping/.test(soql) ? data.mappings ?? []
        : /FROM DecisionTable WHERE Id = '([^']+)'/.test(soql) ? data.tables.filter(t => t.Id === soql.match(/Id = '([^']+)'/)![1])
        : /FROM DecisionTable WHERE SourceObject/.test(soql) ? data.tables.filter(t => t.SourceObject === "BundleBasedAdjustment" && t.Status === "Active")
        : /FROM DecisionTableParameter/.test(soql) ? data.params
        : /COUNT\(\)/.test(soql) ? [] : [];
      return { totalSize: recs.length, done: true, records: recs };
    },
    async toolingQuery() { return { totalSize: 0, done: true, records: [] }; },
    async describeObject() { return { fields: ["PriceAdjustmentScheduleId", "ProductId", "ParentProductId", "AdjustmentType", "AdjustmentValue"].map(name => ({ name })) }; },
  } as unknown as SalesforceClient;
}
const GOOD_PARAMS = [
  ...["PriceAdjustmentScheduleId", "ProductId", "ParentProductId"].map((f, i) => ({ FieldName: f, Usage: "INPUT", Operator: "Equals", Sequence: i + 1, IsRequired: true })),
  { FieldName: "AdjustmentValue", Usage: "OUTPUT" }, { FieldName: "AdjustmentType", Usage: "OUTPUT" },
];
const bundleTable = (id: string, name: string) => ({ Id: id, DeveloperName: name, SourceObject: "BundleBasedAdjustment", Status: "Active" });

test("lookup table: the active Pricing Recipe's BundleDiscount mapping wins, even when a similarly named table exists", async () => {
  const client = lookupClient({
    recipes: [{ Id: "12GR1", DeveloperName: "ActiveRecipe" }],
    mappings: [{ LookupTableId: "0lDMAPPED", PricingRecipeId: "12GR1" }],
    tables: [bundleTable("0lDMAPPED", "Recipe_Mapped_Table"), bundleTable("0lDOTHER", "Bundle_Discount_Entries")],
    params: GOOD_PARAMS,
  });
  const t = await resolveBundleLookupTable(client);
  assert.equal(t.id, "0lDMAPPED");
  assert.equal(t.selectedBy, "pricing-recipe-mapping");
  assert.match(t.reason, /ActiveRecipe/);
});

test("lookup table: without a recipe mapping, exactly one Active table sourced from BundleBasedAdjustment is used", async () => {
  const t = await resolveBundleLookupTable(lookupClient({ tables: [bundleTable("0lDONLY", "Only_Table")], params: GOOD_PARAMS }));
  assert.equal(t.id, "0lDONLY");
  assert.equal(t.selectedBy, "source-object-unique");
});

test("lookup table: two candidate tables and no recipe mapping is ambiguous — never 'first row'", async () => {
  await assert.rejects(
    resolveBundleLookupTable(lookupClient({ tables: [bundleTable("0lDA", "A"), bundleTable("0lDB", "B")], params: GOOD_PARAMS })),
    (err: Error) => err.message.startsWith(NO_BUNDLE_LOOKUP_TABLE_MESSAGE) && /2 Active Decision Tables/.test(err.message),
  );
});

test("lookup table: nothing resolvable fails with the required message", async () => {
  await assert.rejects(resolveBundleLookupTable(lookupClient({ tables: [], params: [] })), (err: Error) => err.message.startsWith(NO_BUNDLE_LOOKUP_TABLE_MESSAGE));
});

test("lookup table: incompatible columns fail with the expected and the actual columns", async () => {
  const client = lookupClient({ tables: [bundleTable("0lDBAD", "Bad")], params: [{ FieldName: "ProductId", Usage: "INPUT", Operator: "Equals", Sequence: 1, IsRequired: true }, { FieldName: "AdjustmentValue", Usage: "OUTPUT" }] });
  await assert.rejects(resolveBundleLookupTable(client), (err: Error) =>
    /Expected INPUT ⊇ \[PriceAdjustmentScheduleId, ProductId, ParentProductId\]/.test(err.message) && /actual INPUT \[ProductId\], OUTPUT \[AdjustmentValue\]/.test(err.message));
});

test("validateBundleLookupTableShape rejects a table sourced from a different object", () => {
  const problems = validateBundleLookupTableShape({ sourceObject: "AttributeBasedAdjustment", status: "Active", inputs: TABLE.inputs, outputs: TABLE.outputs }, null);
  assert.match(problems.join(" "), /SourceObject is "AttributeBasedAdjustment"/);
});

/* ── donor selection ── */

test("donor: a flat procedure's BundleDiscount connects to the non-contract ListPrice by root sequence", () => {
  const xml = flatDonor();
  const graph = extractStepGraph(xml);
  const bd = graph.find(n => n.actionType === "BundleDiscount")!;
  assert.equal(resolveConnection(graph, bd, "ListPrice"), "root-sequence");
  assert.equal(resolveConnection(graph, bd, "PricingSettings"), "root-sequence");
});

test("donor: a shared procedure whose BundleDiscount step executes the resolved table is trusted despite unrelated branches", () => {
  const bound = inspectDonorCandidate("f", flatDonor({ lookupId: TABLE.id }));
  assert.ok(rankCandidates([bound], TABLE)[0].score >= 0);
});

/* ── canvas binding ── */

test("canvas: the generated BundleDiscount step executes the RESOLVED table and this procedure's schedule", () => {
  const result = buildBundleCanvasFromDonor(donorResolutionFor(flatDonor()), CTX);
  assert.equal(result.success, true, result.fatalErrors.join("\n"));
  const deployed = inspectDeployedBundleBinding(result.finalFileXml!);
  assert.equal(deployed.lookUpId, TABLE.id, "donor's own lookup Id must be replaced by the resolved table");
  assert.equal(deployed.lookUpApiName, TABLE.developerName);
  assert.equal(deployed.scheduleConstantValue, CTX.scheduleId, "schedule constant must hold this procedure's schedule, not the donor's");
  assert.equal(deployed.bundleDiscountSteps, 1);
  assert.deepEqual(result.lookupBinding!.inputBindings.find(b => b.column === "ParentProductId"), { column: "ParentProductId", boundTo: "MainItemProduct" });
  assert.deepEqual(result.lookupBinding!.inputBindings.find(b => b.column === "RootBundleId"), { column: "RootBundleId", boundTo: "RootItemProduct" });
  assert.equal(result.bundleDiscountInputBinding!.inputUnitPriceValue, "ListPrice", "InputUnitPrice is bound to the retained ListPrice step's output");
  assert.ok(!result.observedActionTypes!.includes("VolumeDiscount"), "unrelated branches are pruned");
});

test("canvas: variable declarations are never renamed, and the version identity carries the version suffix", () => {
  const result = buildBundleCanvasFromDonor(donorResolutionFor(flatDonor()), { ...CTX, versionNumber: 2 });
  const xml = result.finalFileXml!;
  assert.match(xml, /<name>AmountStringConstant<\/name>/);
  assert.match(xml, /<name>BundlePASIdConstant<\/name>/);
  assert.doesNotMatch(xml, /<variables>[\s\S]*?<name>Test_Bundle_Pricing<\/name>[\s\S]*?<\/variables>/);
  assert.equal(result.outboundVersionFields!.fullName, "Test_Bundle_Pricing_V2");
  assert.match(xml, /<label>Test Bundle Pricing<\/label>/);
  assert.doesNotMatch(xml, /Standard Pricing Procedure V1/);
});

test("canvas: a donor BundleDiscount step with no lookup reference is refused, not invented", () => {
  const result = buildBundleCanvasFromDonor(donorResolutionFor(flatDonor({ withLookup: false })), CTX);
  assert.equal(result.success, false);
  assert.match(result.fatalErrors.join(" "), /no LookUpId\/LookUpApiName/);
});

test("canvas: a lookup-table INPUT column the step doesn't bind fails the build", () => {
  const table = { ...TABLE, inputs: [...TABLE.inputs, { fieldName: "CurrencyIsoCode", operator: "Equals", sequence: 10, required: true }] };
  const result = buildBundleCanvasFromDonor(donorResolutionFor(flatDonor()), { ...CTX, lookupTable: table });
  assert.equal(result.success, false);
  assert.match(result.fatalErrors.join(" "), /does not bind lookup-table INPUT column\(s\) \[CurrencyIsoCode\]/);
});

test("rebindScheduleConstant refuses a schedule binding that isn't a Constant variable", () => {
  const xml = `<variables><name>Sched</name><type>Formula</type><value>x</value></variables>`;
  assert.match(rebindScheduleConstant(xml, "Sched", "84XNEW").error ?? "", /not a Constant/);
});

/* ── waterfall parsing ── */

test("parsePricedContext groups Salesforce's context tags by quote line and reads the BundleDiscount step", () => {
  const waterfall = JSON.stringify({
    waterfall: [
      { sequence: 0, pricingElement: { elementType: "ListPrice", name: "Price Book Entries", adjustments: [{}] }, inputParameters: {}, outputParameters: { ListPrice: 5000 } },
      { sequence: 1, pricingElement: { elementType: "BundleDiscount", name: "Bundle Based Adjustment Entries", adjustments: [{ AdjustmentType: "Percentage", AdjustmentValue: "10.0" }] }, inputParameters: { ParentProductId: "P-BUNDLE" }, outputParameters: { NetUnitPrice: 4500 } },
    ],
  });
  const path = (line: string) => ["CTX", "QUOTE", line];
  const lines = parsePricedContext(
    {
      ListPrice: [{ tagValue: 5000, dataPath: path("QL-CHILD") }, { tagValue: 30000, dataPath: path("QL-PARENT") }],
      NetUnitPrice: [{ tagValue: 4500, dataPath: path("QL-CHILD") }, { tagValue: 30000, dataPath: path("QL-PARENT") }],
      price_water_fall: [{ tagValue: waterfall, dataPath: path("QL-CHILD") }],
    },
    [{ Id: "QL-PARENT", Product2Id: "P-BUNDLE", Product2: { Name: "Bundle" } }, { Id: "QL-CHILD", Product2Id: "P-CHILD", Product2: { Name: "Child" } }],
    [{ AssociatedQuoteLineId: "QL-CHILD", MainQuoteLineId: "QL-PARENT", AssociatedQuoteLinePricing: "NotIncludedInBundlePrice" }],
  );
  const child = lines.find(l => l.quoteLineId === "QL-CHILD")!;
  assert.equal(child.role, "component");
  assert.equal(child.includedInBundlePrice, false);
  assert.equal(child.listPrice, 5000);
  assert.equal(child.netUnitPrice, 4500);
  assert.equal(child.bundleDiscount!.matched, true);
  assert.deepEqual(child.waterfall.map(s => s.elementType), ["ListPrice", "BundleDiscount"]);
  const parent = lines.find(l => l.quoteLineId === "QL-PARENT")!;
  assert.equal(parent.role, "bundle");
  assert.deepEqual(parent.missing, ["price_water_fall"], "a tag Salesforce didn't return is reported missing, not fabricated");
});
