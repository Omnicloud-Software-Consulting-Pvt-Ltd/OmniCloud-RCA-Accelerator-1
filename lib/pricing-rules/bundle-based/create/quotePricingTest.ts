/**
 * Bundle-Based Pricing — price a real Quote through a SPECIFIC (generated) pricing procedure and return
 * Salesforce's own per-line results and Pricing Waterfall.
 *
 * Why a Flow: Quote pricing (`get-instant-price`, Place Sales Transaction) always runs the org's DEFAULT
 * procedure (the active PricingRecipe's DefaultPricingProcedureId), so it can't prove a newly generated
 * procedure works without re-pointing the org default. Salesforce's `runSalesforcePricing` action DOES run
 * a named procedure — but against a context instance, and a context built by one REST call is already gone
 * by the next ("This context instance is no longer active"). A Flow runs `buildContext` →
 * `runSalesforcePricing` → `queryContextTags` in ONE transaction, which is Salesforce's documented pattern.
 * The Flow only reads and prices in memory; it never saves prices back to the Quote.
 *
 * Nothing here fabricates a value: every price and waterfall step shown comes from the priced context's own
 * tags. A tag Salesforce didn't return is reported as missing.
 */
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape, buildDataApiUrl } from "@/lib/salesforce/client";
import { metadataDeploy, pollDeployStatus } from "@/lib/pricing-rules/attribute-based/create/soapEnvelope";
import { bundleLog } from "./bundleLog";

export const PRICING_TEST_FLOW_API_NAME = "RCA_Accelerator_Price_Quote_With_Procedure";
/** `queryContextTags` is only available to Flows from API v63; the Flow and this module's calls use v64. */
export const PRICING_TEST_API_VERSION = "v64.0";
const CONTEXT_TAGS = ["LineItem", "Product", "ListPrice", "NetUnitPrice", "ItemNetTotalPrice", "price_water_fall", "MainItemProduct", "RootItemProduct", "ProductSellingModel", "LineItemQuantity"];

export function buildPricingTestFlowXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>64.0</apiVersion>
    <description>RCA Accelerator: prices an existing Quote through a named pricing procedure (build context, run pricing, read tags in one transaction). Prices in memory only - writes no records.</description>
    <label>RCA Accelerator Price Quote With Procedure</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start><locationX>50</locationX><locationY>0</locationY><connector><targetReference>Build_Context</targetReference></connector></start>
    <actionCalls>
        <name>Build_Context</name><label>Build Context</label><locationX>50</locationX><locationY>100</locationY>
        <actionName>buildContext</actionName><actionType>buildContext</actionType>
        <connector><targetReference>Run_Pricing</targetReference></connector>
        <inputParameters><name>contextDefinitionId</name><value><elementReference>contextDefinition</elementReference></value></inputParameters>
        <inputParameters><name>contextMappingId</name><value><elementReference>contextMapping</elementReference></value></inputParameters>
        <inputParameters><name>contextData</name><value><elementReference>ContextDataJson</elementReference></value></inputParameters>
        <storeOutputAutomatically>false</storeOutputAutomatically>
        <outputParameters><assignToReference>contextId</assignToReference><name>contextId</name></outputParameters>
    </actionCalls>
    <actionCalls>
        <name>Run_Pricing</name><label>Run Pricing</label><locationX>50</locationX><locationY>200</locationY>
        <actionName>runSalesforcePricing</actionName><actionType>runSalesforcePricing</actionType>
        <connector><targetReference>Query_Tags</targetReference></connector>
        <inputParameters><name>contextInstanceId</name><value><elementReference>contextId</elementReference></value></inputParameters>
        <inputParameters><name>pricingProcedureName</name><value><elementReference>procedureName</elementReference></value></inputParameters>
        <inputParameters><name>isDeveloperName</name><value><booleanValue>true</booleanValue></value></inputParameters>
        <inputParameters><name>isSkipWaterfall</name><value><booleanValue>false</booleanValue></value></inputParameters>
        <inputParameters><name>skipDiscovery</name><value><booleanValue>true</booleanValue></value></inputParameters>
        <storeOutputAutomatically>false</storeOutputAutomatically>
        <outputParameters><assignToReference>executionId</assignToReference><name>executionId</name></outputParameters>
    </actionCalls>
    <actionCalls>
        <name>Query_Tags</name><label>Query Tags</label><locationX>50</locationX><locationY>300</locationY>
        <actionName>queryContextTags</actionName><actionType>queryContextTags</actionType>
        <inputParameters><name>contextId</name><value><elementReference>contextId</elementReference></value></inputParameters>
        <inputParameters><name>tagsList</name><value><elementReference>tagNames</elementReference></value></inputParameters>
        <storeOutputAutomatically>false</storeOutputAutomatically>
        <outputParameters><assignToReference>pricedContext</assignToReference><name>queryResult</name></outputParameters>
    </actionCalls>
    <formulas>
        <name>ContextDataJson</name><dataType>String</dataType>
        <expression>&apos;[{&quot;id&quot;:&quot;&apos; &amp; {!quoteId} &amp; &apos;&quot;,&quot;businessObjectType&quot;:&quot;Quote&quot;}]&apos;</expression>
    </formulas>
    <variables><name>quoteId</name><dataType>String</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    <variables><name>procedureName</name><dataType>String</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    <variables><name>contextDefinition</name><dataType>String</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    <variables><name>contextMapping</name><dataType>String</dataType><isCollection>false</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    <variables><name>tagNames</name><dataType>String</dataType><isCollection>true</isCollection><isInput>true</isInput><isOutput>false</isOutput></variables>
    <variables><name>contextId</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>true</isOutput></variables>
    <variables><name>executionId</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>true</isOutput></variables>
    <variables><name>pricedContext</name><dataType>String</dataType><isCollection>false</isCollection><isInput>false</isInput><isOutput>true</isOutput></variables>
</Flow>
`;
}

/** Installs the pricing Flow once; later calls find it active and do nothing. */
export async function ensurePricingTestFlow(client: SalesforceClient): Promise<{ installed: boolean; deployedNow: boolean; error?: string }> {
  try {
    const existing = (await client.query<{ ApiName: string; IsActive: boolean }>(
      `SELECT ApiName, IsActive FROM FlowDefinitionView WHERE ApiName = '${PRICING_TEST_FLOW_API_NAME}'`,
    )).records[0];
    if (existing?.IsActive) return { installed: true, deployedNow: false };
  } catch { /* fall through to deploy */ }

  const zip = new JSZip();
  zip.file("package.xml", `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${PRICING_TEST_FLOW_API_NAME}</members><name>Flow</name></types><version>64.0</version></Package>`);
  zip.file(`flows/${PRICING_TEST_FLOW_API_NAME}.flow`, buildPricingTestFlowXml());
  const started = await metadataDeploy(client, await zip.generateAsync({ type: "base64" }));
  if (!started.id) return { installed: false, deployedNow: false, error: "The Metadata API did not return a deploy id for the pricing test Flow." };
  const status = await pollDeployStatus(client, started.id);
  bundleLog(client, "pricing-test-flow-deploy", { success: status.success, errors: status.componentFailures?.map(f => f.problem) ?? [] });
  if (!status.success) {
    return { installed: false, deployedNow: false, error: `Deploying the pricing test Flow failed: ${status.componentFailures?.map(f => f.problem).join("; ") || status.errorMessage || "unknown error"}` };
  }
  return { installed: true, deployedNow: true };
}

/* ── Test Quote creation ── */

/** The newest REST API version this org serves (from `/services/data`), never a hardcoded guess. */
async function latestApiVersion(client: SalesforceClient): Promise<string> {
  const versions = await client.request<{ version: string }[]>(`${client.instanceUrl.replace(/\/+$/, "")}/services/data`);
  const newest = versions.map(v => v.version).sort((a, b) => Number(a) - Number(b)).pop();
  return newest ? `v${newest}` : PRICING_TEST_API_VERSION;
}

export interface TestQuoteResult { quoteId: string; lineCount: number }

/**
 * Creates a Quote holding the bundle and the given components through RCA's own Place Sales Transaction API
 * — the same path RCA's configurator uses, so parent/child QuoteLineItems and their QuoteLineRelationship
 * rows (Main, Associated AND Root quote line, the ProductRelatedComponent, and its included/not-included
 * pricing) are real. Pricing is skipped here; the named procedure prices it afterwards.
 */
export async function createBundleTestQuote(
  client: SalesforceClient,
  args: { bundleId: string; bundleName: string; componentProductIds: string[] },
): Promise<TestQuoteResult> {
  const pb = (await client.query<{ Id: string }>("SELECT Id FROM Pricebook2 WHERE IsStandard = true AND IsActive = true LIMIT 1")).records[0];
  if (!pb) throw new Error("No active Standard Price Book was found — a test Quote needs one.");
  const prc = (await client.query<{ Id: string; ChildProductId: string; ProductRelationshipTypeId: string; DoesBundlePriceIncludeChild: boolean; QuantityScaleMethod: string | null }>(
    `SELECT Id, ChildProductId, ProductRelationshipTypeId, DoesBundlePriceIncludeChild, QuantityScaleMethod FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(args.bundleId)}'`,
  )).records.filter(r => args.componentProductIds.includes(r.ChildProductId));
  if (prc.length === 0) throw new Error(`None of the selected components are components of "${args.bundleName}".`);

  const ids = [args.bundleId, ...prc.map(p => p.ChildProductId)];
  const pbe = (await client.query<{ Id: string; Product2Id: string; ProductSellingModel: { SellingModelType: string } | null }>(
    `SELECT Id, Product2Id, ProductSellingModel.SellingModelType FROM PricebookEntry WHERE Pricebook2Id = '${soqlEscape(pb.Id)}' AND IsActive = true AND Product2Id IN (${ids.map(i => `'${soqlEscape(i)}'`).join(",")})`,
  )).records;
  const entriesOf = (pid: string) => pbe.filter(p => p.Product2Id === pid);
  // Prefer a bundle selling model type the components share, so the quote is internally consistent.
  const childTypes = new Set(prc.flatMap(p => entriesOf(p.ChildProductId).map(e => e.ProductSellingModel?.SellingModelType)));
  const parentEntry = entriesOf(args.bundleId).find(e => childTypes.has(e.ProductSellingModel?.SellingModelType)) ?? entriesOf(args.bundleId)[0];
  if (!parentEntry) throw new Error(`"${args.bundleName}" has no active Standard Price Book entry.`);

  const billingField = (await client.describeObject("QuoteLineItem")).fields.find(f => f.name === "BillingFrequency");
  const billingFrequency = (billingField?.picklistValues ?? []).find(v => v.active && v.value === "Annual")?.value
    ?? (billingField?.picklistValues ?? []).find(v => v.active)?.value;
  const today = new Date().toISOString().slice(0, 10);
  const termFields = (entry: { ProductSellingModel: { SellingModelType: string } | null }) =>
    entry.ProductSellingModel?.SellingModelType === "OneTime" || !billingFrequency ? {} : { BillingFrequency: billingFrequency, StartDate: today, SubscriptionTerm: 1 };

  const records: unknown[] = [
    { referenceId: "refQuote", record: { attributes: { type: "Quote", method: "POST" }, Name: `Bundle Pricing Test — ${args.bundleName}`.slice(0, 80), Pricebook2Id: pb.Id } },
    { referenceId: "refParent", record: { attributes: { type: "QuoteLineItem", method: "POST" }, QuoteId: "@{refQuote.id}", Product2Id: args.bundleId, PricebookEntryId: parentEntry.Id, Quantity: 1, ...termFields(parentEntry) } },
  ];
  prc.forEach((p, i) => {
    const entry = entriesOf(p.ChildProductId)[0];
    if (!entry) throw new Error(`Component ${p.ChildProductId} has no active Standard Price Book entry.`);
    records.push({ referenceId: `refChild${i}`, record: { attributes: { type: "QuoteLineItem", method: "POST" }, QuoteId: "@{refQuote.id}", Product2Id: p.ChildProductId, PricebookEntryId: entry.Id, Quantity: 1, ...termFields(entry) } });
    records.push({
      referenceId: `refRel${i}`,
      record: {
        attributes: { type: "QuoteLineRelationship", method: "POST" },
        MainQuoteLineId: "@{refParent.id}", AssociatedQuoteLineId: `@{refChild${i}.id}`, RootQuoteLineId: "@{refParent.id}",
        ProductRelatedComponentId: p.Id, ProductRelationshipTypeId: p.ProductRelationshipTypeId,
        AssociatedQuoteLinePricing: p.DoesBundlePriceIncludeChild ? "IncludedInBundlePrice" : "NotIncludedInBundlePrice",
        AssociatedQuantScaleMethod: p.QuantityScaleMethod ?? "Proportional",
      },
    });
  });

  // QuoteLineRelationship.RootQuoteLineId (which RCA turns into the RootItemProduct context tag the bundle
  // lookup matches on) only exists at recent API versions — send this call at the org's newest version.
  const latest = await latestApiVersion(client);
  const qlrFields = new Set((await client.request<{ fields: { name: string }[] }>(buildDataApiUrl(client.instanceUrl, latest, "/sobjects/QuoteLineRelationship/describe"))).fields.map(f => f.name));
  if (!qlrFields.has("RootQuoteLineId")) {
    throw new Error(`QuoteLineRelationship has no RootQuoteLineId field at API ${latest} — bundle component lines would carry no root bundle, so no Bundle-Based Adjustment could match.`);
  }
  type PlaceResponse = { isSuccess: boolean; salesTransactionId: string; errorResponse?: { message: string; referenceId?: string }[] };
  let res: PlaceResponse;
  try {
    res = await client.request<PlaceResponse>(
      buildDataApiUrl(client.instanceUrl, latest, "/connect/rev/sales-transaction/actions/place"),
      { method: "POST", body: JSON.stringify({ pricingPref: "Skip", catalogRatesPref: "Skip", configurationPref: { configurationMethod: "Skip" }, graph: { graphId: "bundlePricingTest", records } }) },
    );
  } catch (err) {
    // Place Sales Transaction answers HTTP 400 with its real reasons in `errorResponse` — surface them.
    const body = (err as { body?: PlaceResponse }).body;
    if (body && Array.isArray(body.errorResponse)) res = body;
    else throw err;
  }
  if (!res.isSuccess || !res.salesTransactionId) {
    throw new Error(`Salesforce rejected the test Quote: ${(res.errorResponse ?? []).map(e => `${e.referenceId ?? ""} ${e.message}`).join("; ") || "no error detail returned"}`);
  }
  bundleLog(client, "test-quote-created", { quoteId: res.salesTransactionId, bundleId: args.bundleId, components: prc.map(p => p.ChildProductId) });
  return { quoteId: res.salesTransactionId, lineCount: 1 + prc.length };
}

/* ── Pricing ── */

export interface WaterfallStep {
  sequence: number | null;
  elementType: string | null;
  name: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  adjustments: Record<string, unknown>[];
}

export interface PricedQuoteLine {
  quoteLineId: string;
  productId: string | null;
  productName: string;
  role: "bundle" | "component" | "standalone";
  /** From QuoteLineRelationship: whether the component's price is included in the bundle's price. */
  includedInBundlePrice: boolean | null;
  listPrice: number | null;
  netUnitPrice: number | null;
  netTotalPrice: number | null;
  bundleDiscount: { executed: boolean; matched: boolean; adjustments: Record<string, unknown>[]; inputs: Record<string, unknown> } | null;
  waterfall: WaterfallStep[];
  /** Tags Salesforce did not return for this line — shown as missing, never filled in. */
  missing: string[];
}

export interface QuotePricingTestResult {
  success: boolean;
  error?: string;
  quoteId: string;
  procedureApiName: string;
  executionId: string | null;
  flow: { installed: boolean; deployedNow: boolean };
  lines: PricedQuoteLine[];
  note: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface TagEntry { tagValue: unknown; dataPath: string[] }

/** The shape of one step in Salesforce's PriceWaterFall tag, as returned by the pricing engine. */
interface RawWaterfallStep {
  sequence?: number;
  pricingElement?: { elementType?: string; name?: string; adjustments?: Record<string, unknown>[] };
  inputParameters?: Record<string, unknown>;
  outputParameters?: Record<string, unknown>;
}

/** Pure — groups the Flow's priced-context tags by quote line and parses each line's waterfall. Exported for tests. */
export function parsePricedContext(
  pricedContext: Record<string, TagEntry[]>,
  quoteLines: { Id: string; Product2Id: string; Product2: { Name: string } | null }[],
  relationships: { AssociatedQuoteLineId: string; MainQuoteLineId: string; AssociatedQuoteLinePricing: string | null }[],
): PricedQuoteLine[] {
  const byLine = new Map<string, Record<string, unknown>>();
  for (const [tag, entries] of Object.entries(pricedContext)) {
    for (const e of entries ?? []) {
      const lineId = [...(e.dataPath ?? [])].reverse().find(p => quoteLines.some(l => l.Id === p));
      if (!lineId) continue;
      const bucket = byLine.get(lineId) ?? {};
      bucket[tag] = e.tagValue;
      byLine.set(lineId, bucket);
    }
  }
  return quoteLines.map(line => {
    const tags = byLine.get(line.Id) ?? {};
    const asChild = relationships.find(r => r.AssociatedQuoteLineId === line.Id);
    const isParent = relationships.some(r => r.MainQuoteLineId === line.Id);
    let waterfall: WaterfallStep[] = [];
    const rawWaterfall = tags.price_water_fall;
    if (rawWaterfall) {
      try {
        const w = typeof rawWaterfall === "string" ? JSON.parse(rawWaterfall) : rawWaterfall;
        waterfall = ((w?.waterfall ?? []) as RawWaterfallStep[]).map(s => ({
          sequence: typeof s.sequence === "number" ? s.sequence : null,
          elementType: s.pricingElement?.elementType ?? null,
          name: s.pricingElement?.name ?? null,
          inputs: s.inputParameters ?? {},
          outputs: s.outputParameters ?? {},
          adjustments: ((s.pricingElement?.adjustments ?? []) as Record<string, unknown>[]).filter(a => a && Object.keys(a).length > 0),
        }));
      } catch { waterfall = []; }
    }
    const bd = waterfall.find(s => s.elementType === "BundleDiscount");
    const missing = ["ListPrice", "NetUnitPrice", "price_water_fall"].filter(t => tags[t] === undefined);
    return {
      quoteLineId: line.Id, productId: line.Product2Id ?? null, productName: line.Product2?.Name ?? line.Id,
      role: asChild ? "component" : isParent ? "bundle" : "standalone",
      includedInBundlePrice: asChild ? asChild.AssociatedQuoteLinePricing === "IncludedInBundlePrice" : null,
      listPrice: num(tags.ListPrice), netUnitPrice: num(tags.NetUnitPrice), netTotalPrice: num(tags.ItemNetTotalPrice),
      bundleDiscount: bd ? { executed: true, matched: bd.adjustments.length > 0, adjustments: bd.adjustments, inputs: bd.inputs } : null,
      waterfall, missing,
    };
  });
}

export async function priceQuoteWithProcedure(
  client: SalesforceClient,
  args: { quoteId: string; procedureApiName: string },
): Promise<QuotePricingTestResult> {
  const base = { quoteId: args.quoteId, procedureApiName: args.procedureApiName, executionId: null, lines: [] as PricedQuoteLine[] };
  const note = "Priced in memory through the named procedure. The Quote record's saved prices are not changed — Salesforce's standard Quote repricing uses the org's default pricing procedure.";

  const es = (await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSet WHERE ApiName = '${soqlEscape(args.procedureApiName)}' AND InterfaceSourceType = 'PricingProcedure'`)).records[0];
  if (!es) return { ...base, success: false, error: `Pricing procedure ${args.procedureApiName} was not found.`, flow: { installed: false, deployedNow: false }, note };
  const active = (await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSetVersion WHERE ExpressionSetId = '${soqlEscape(es.Id)}' AND IsActive = true`)).records;
  if (active.length === 0) return { ...base, success: false, error: `Pricing procedure ${args.procedureApiName} has no active version — activate it before testing.`, flow: { installed: false, deployedNow: false }, note };

  const quoteLines = (await client.query<{ Id: string; Product2Id: string; Product2: { Name: string } | null }>(
    `SELECT Id, Product2Id, Product2.Name FROM QuoteLineItem WHERE QuoteId = '${soqlEscape(args.quoteId)}'`,
  )).records;
  if (quoteLines.length === 0) return { ...base, success: false, error: `Quote ${args.quoteId} has no line items.`, flow: { installed: false, deployedNow: false }, note };
  let relationships: { AssociatedQuoteLineId: string; MainQuoteLineId: string; AssociatedQuoteLinePricing: string | null }[] = [];
  try {
    relationships = (await client.query<{ AssociatedQuoteLineId: string; MainQuoteLineId: string; AssociatedQuoteLinePricing: string | null }>(
      `SELECT AssociatedQuoteLineId, MainQuoteLineId, AssociatedQuoteLinePricing FROM QuoteLineRelationship WHERE MainQuoteLine.QuoteId = '${soqlEscape(args.quoteId)}'`,
    )).records;
  } catch { /* no relationship object: every line is standalone */ }

  const flow = await ensurePricingTestFlow(client);
  if (!flow.installed) return { ...base, success: false, error: flow.error, flow, note };

  // The Quote's own context definition + mapping, resolved by name (never a hardcoded Id).
  const mapping = (await client.query<{ Id: string; ContextDefinitionVersion: { ContextDefinition: { DeveloperName: string } } }>(
    "SELECT Id, ContextDefinitionVersion.ContextDefinition.DeveloperName FROM ContextMapping WHERE Title = 'QuoteEntitiesMapping'",
  )).records;
  const chosen = mapping.find(m => m.ContextDefinitionVersion?.ContextDefinition?.DeveloperName === "RevSalesTransactionContext") ?? mapping[0];
  if (!chosen) return { ...base, success: false, error: "No QuoteEntitiesMapping context mapping exists on this org.", flow, note };

  bundleLog(client, "quote-pricing-invoke", { quoteId: args.quoteId, procedureApiName: args.procedureApiName, contextDefinition: chosen.ContextDefinitionVersion.ContextDefinition.DeveloperName });
  let res: { isSuccess: boolean; errors?: { message: string }[] | null; outputValues?: { executionId?: string; pricedContext?: string } }[];
  try {
    res = await client.request(`/actions/custom/flow/${PRICING_TEST_FLOW_API_NAME}`, {
      method: "POST",
      body: JSON.stringify({ inputs: [{ quoteId: args.quoteId, procedureName: args.procedureApiName, contextDefinition: chosen.ContextDefinitionVersion.ContextDefinition.DeveloperName, contextMapping: "QuoteEntitiesMapping", tagNames: CONTEXT_TAGS }] }),
    });
  } catch (err) {
    return { ...base, success: false, error: `Salesforce pricing failed: ${err instanceof Error ? err.message : String(err)}`, flow, note };
  }
  const out = res[0];
  if (!out?.isSuccess) return { ...base, success: false, error: `Salesforce pricing failed: ${(out?.errors ?? []).map(e => e.message).join("; ") || "no error detail returned"}`, flow, note };

  let pricedContext: Record<string, TagEntry[]> = {};
  try { pricedContext = JSON.parse(out.outputValues?.pricedContext ?? "{}"); } catch { /* reported below as missing tags */ }
  const lines = parsePricedContext(pricedContext, quoteLines, relationships);
  const executionId = out.outputValues?.executionId ?? null;
  bundleLog(client, "quote-pricing-result", {
    quoteId: args.quoteId, executionId,
    lines: lines.map(l => ({ product: l.productName, role: l.role, list: l.listPrice, net: l.netUnitPrice, bundleDiscountMatched: l.bundleDiscount?.matched ?? null, adjustments: l.bundleDiscount?.adjustments ?? [] })),
  });
  if (lines.every(l => l.missing.length === 3)) {
    return { ...base, executionId, success: false, error: "Salesforce priced the Quote but returned no line data — the Quote's context could not be hydrated.", flow, lines, note };
  }
  return { ...base, success: true, executionId, flow, lines, note };
}
