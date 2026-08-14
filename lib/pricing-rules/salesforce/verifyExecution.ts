/**
 * §9 — runtime verification: actually call the Salesforce pricing engine
 * against a deployed procedure and prove it prices correctly, rather than
 * trusting a clean metadata deploy.
 *
 * §10.1 bug fix applied here (vs. the ported spec): every deployed-step /
 * retrieved-XML action-type check below looks for `AttributeDiscount`,
 * the actual deployed action type (§8.1) — not the legacy
 * `AttributeBasedPrice` string, which would silently miss on a correctly
 * deployed canvas.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape, buildDataApiUrl } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { retrieveNamedExpressionSetDefinition } from "@/lib/pricing-rules/metadata/templateExpressionSet";
import { findStepsByActionType, getTopLevelParameterBlocks, getParamName, getParamValue, extractCustomElementBlocks, getAllTagValues } from "@/lib/pricing-rules/xml/blocks";
import { PRICING_ENGINE_API_VERSION } from "@/lib/pricing-rules/types";
import type { ExecutionReport, ExecutionReportBlocker, ProcedureStep } from "@/lib/pricing-rules/types";

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

const RESOLUTION_HINTS: Record<string, string> = {
  "decision-table-lookup": "The ListPrice step's Decision Table lookup could not be resolved — confirm the deployed procedure's ListPrice step still has a LookUpId.",
  "decision-table-row-match": "No Decision Table row matched this product/date — check the pricebook entry and Decision Table dataset.",
  "attribute-value-mismatch": "The requested attribute value isn't one of the values configured for this attribute — check for a typo or re-run attribute discovery.",
  "attribute-definition-mismatch": "The requested attribute name doesn't resolve to an AttributeDefinition on this product.",
  "expression-set-mapping": "The deployed AttributeDiscount step's bindings don't match the runtime context this call sent — re-check the AD_MAPPINGS patch (§8.5).",
  "metadata-deployment": "The metadata deploy may not have completed correctly — re-check the create-procedure response for deploy errors.",
  "pricing-engine-execution": "The Salesforce pricing engine itself returned an error — see details for the raw response.",
  "context-mapping": "The simulation's input context is missing a field the engine needs (Product2Id, ProductSellingModelId, ItemContractAttributePasId, or the attribute name/value).",
  "runtime-configuration": "Unexpected runtime shape — see details for the raw engine response.",
};

export interface VerifyExecutionArgs {
  procedureApiName?: string;
  procedureId?: string;
  versionId?: string;
  productId: string;
  productName?: string;
  sellingModelId?: string;
  attributeValue: string;
  attributeName?: string;
  pasId?: string;
  quantity?: number;
  currency?: string;
}

export async function verifyAttributeExecution(
  client: SalesforceClient,
  args: VerifyExecutionArgs,
): Promise<{ success: boolean; executionReport: ExecutionReport; steps: ProcedureStep[] }> {
  const steps: ProcedureStep[] = [];
  let blocker: ExecutionReportBlocker | null = null;

  /* ── Phase 1: resolve ExpressionSet / Version / Steps ── */
  let versionId = args.versionId ?? null;
  let expressionSetSteps: { ActionType?: string; SequenceNumber?: number }[] = [];
  try {
    let expressionSetId = args.procedureId ?? null;
    if (!expressionSetId && args.procedureApiName) {
      const esRes = await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSet WHERE DeveloperName = '${soqlEscape(args.procedureApiName)}' LIMIT 1`);
      expressionSetId = esRes.records[0]?.Id ?? null;
    }
    if (expressionSetId && !versionId) {
      const verRes = await client.query<{ Id: string; Status?: string }>(
        `SELECT Id, Status FROM ExpressionSetVersion WHERE ExpressionSetId = '${expressionSetId}' ORDER BY CreatedDate DESC LIMIT 10`,
      );
      versionId = verRes.records.find(r => r.Status === "Active")?.Id ?? verRes.records[0]?.Id ?? null;
    }
    if (versionId) {
      try {
        const stepRes = await client.query<{ ActionType?: string; SequenceNumber?: number }>(
          `SELECT ActionType, SequenceNumber FROM ExpressionSetStep WHERE ExpressionSetVersionId = '${versionId}' ORDER BY SequenceNumber ASC`,
        );
        expressionSetSteps = stepRes.records;
      } catch {
        // ExpressionSetStep may not be directly queryable in every org — not fatal, XML retrieval below is the authoritative source.
      }
    }
    step(steps, "resolve-expression-set", versionId ? "success" : "error", versionId ? `Resolved ExpressionSetVersion ${versionId}.` : "Could not resolve an ExpressionSetVersion.");
  } catch (err) {
    step(steps, "resolve-expression-set", "error", "Failed to resolve ExpressionSet/Version.", err instanceof Error ? err.message : String(err));
  }

  const hasDeployedAttributeDiscount = expressionSetSteps.some(s => s.ActionType === "AttributeDiscount");
  if (expressionSetSteps.length > 0 && !hasDeployedAttributeDiscount) {
    step(steps, "verify-action-type", "error", "The resolved ExpressionSetVersion has no AttributeDiscount step.");
  }

  /* ── Phase 2: resolve the ListPrice Decision Table ── */
  let dtId: string | null = null;
  let dtSourceObject: string | null = null;
  try {
    if (args.procedureApiName) {
      const fileXml = await retrieveNamedExpressionSetDefinition(client, args.procedureApiName);
      if (fileXml) {
        const lpSteps = findStepsByActionType(fileXml, "ListPrice");
        const adSteps = findStepsByActionType(fileXml, "AttributeDiscount");
        if (adSteps.length === 0) {
          step(steps, "verify-action-type-xml", "error", "The deployed ExpressionSetDefinition XML has no AttributeDiscount step.");
        }
        if (lpSteps[0]) {
          const lpBlock = getTopLevelParameterBlocks(lpSteps[0].full);
          dtId = lpBlock.map(b => b.block).map(b => (getParamName(b) === "LookUpId" ? getParamValue(b) : null)).find(Boolean) ?? null;
        }
      }
    }
    if (dtId) {
      const dtRes = await client.query<{ Id: string; SourceObject?: string; IsActive?: boolean }>(
        `SELECT Id, MasterLabel, DeveloperName, SourceObject, IsActive FROM DecisionTable WHERE Id = '${dtId}' LIMIT 1`,
      );
      dtSourceObject = dtRes.records[0]?.SourceObject ?? null;
      step(steps, "resolve-decision-table", "success", `Resolved ListPrice Decision Table ${dtId} (source: ${dtSourceObject ?? "unknown"}).`);
    } else {
      step(steps, "resolve-decision-table", "info", "Could not resolve the ListPrice Decision Table Id — skipping the local pre-check simulation.");
    }
  } catch (err) {
    step(steps, "resolve-decision-table", "error", "Failed to resolve the ListPrice Decision Table.", err instanceof Error ? err.message : String(err));
  }

  /* ── Phase 3/4: local pre-check simulation (best-effort sanity check) ── */
  let listPrice: number | null = null;
  let decisionTableRowMatched = false;
  if (dtSourceObject) {
    try {
      const precheck = await localPrecheckSimulation(client, dtSourceObject, args);
      listPrice = precheck.listPrice;
      decisionTableRowMatched = precheck.matched;
      if (!precheck.matched && precheck.category) {
        blocker = {
          step: "ListPrice",
          category: precheck.category,
          reason: precheck.reason ?? "No matching Decision Table row.",
          details: precheck.details,
          resolutionHint: RESOLUTION_HINTS[precheck.category] ?? RESOLUTION_HINTS["runtime-configuration"],
        };
      }
      step(steps, "local-precheck", precheck.matched ? "success" : "info", precheck.matched ? `Local pre-check found a matching row (ListPrice ${listPrice}).` : "Local pre-check found no matching row.");
    } catch (err) {
      step(steps, "local-precheck", "error", "Local pre-check simulation failed.", err instanceof Error ? err.message : String(err));
    }
  }

  /* ── Phase 5: call the real pricing engine ── */
  let enginePricing: { listPrice: number | null; adjustmentType: string | null; adjustmentValue: number | null; netUnitPrice: number | null; waterfall: unknown } | null = null;

  if (!versionId || !args.pasId || !args.attributeName || !args.attributeValue) {
    blocker = {
      step: "Context",
      category: "context-mapping",
      reason: "Missing one of versionId/pasId/attributeName/attributeValue — cannot call the pricing engine.",
      details: { versionId, pasId: args.pasId, attributeName: args.attributeName, attributeValue: args.attributeValue },
      resolutionHint: RESOLUTION_HINTS["context-mapping"],
    };
    step(steps, "call-engine", "error", "Skipped pricing-engine call — required context fields are missing.");
  } else {
    try {
      const payload = {
        pricingFlow: "PricingProcedure",
        inputContext: {
          SalesTransaction: [{
            CurrencyIsoCode: args.currency ?? "USD",
            SalesTransactionItem: [{
              Product2Id: args.productId,
              ProductSellingModelId: args.sellingModelId,
              ItemContractAttributePasId: args.pasId,
              LineItemQuantity: args.quantity ?? 1,
              CurrencyIsoCode: args.currency ?? "USD",
              SalesTransactionItemAttribute: [{
                Attribute: args.attributeName,
                AttributeValue: args.attributeValue,
                PriceImpactingAttribute: true,
              }],
            }],
          }],
        },
      };

      const execUrl = buildDataApiUrl(client.instanceUrl, PRICING_ENGINE_API_VERSION, `/connect/pricing/expression-sets/${versionId}/execute`);
      let raw: unknown;
      try {
        raw = await client.request(execUrl, { method: "POST", body: JSON.stringify(payload) });
      } catch {
        const runUrl = execUrl.replace(/\/execute$/, "/run");
        raw = await client.request(runUrl, { method: "POST", body: JSON.stringify(payload) });
      }
      enginePricing = parseEngineResponse(raw);
      step(steps, "call-engine", "success", "Pricing engine call succeeded.", raw);

      if (enginePricing.listPrice === null) {
        blocker = {
          step: "ListPrice",
          category: "decision-table-lookup",
          reason: "The pricing engine returned no ListPrice value.",
          resolutionHint: RESOLUTION_HINTS["decision-table-lookup"],
        };
      } else if (enginePricing.adjustmentType === null && enginePricing.adjustmentValue === null) {
        blocker = blocker ?? {
          step: "AttributeDiscount",
          category: "expression-set-mapping",
          reason: "The pricing engine returned no adjustments for AttributeDiscount.",
          resolutionHint: RESOLUTION_HINTS["expression-set-mapping"],
        };
      } else {
        blocker = null; // a successful engine response overrides the local pre-check.
      }

      if (enginePricing.listPrice !== null) listPrice = enginePricing.listPrice;
    } catch (err) {
      blocker = {
        step: "PricingEngine",
        category: "pricing-engine-execution",
        reason: err instanceof Error ? err.message : "The pricing engine call failed.",
        resolutionHint: RESOLUTION_HINTS["pricing-engine-execution"],
      };
      step(steps, "call-engine", "error", "Pricing engine call failed.", err instanceof Error ? err.message : String(err));
    }
  }

  /* ── Phase 6: output summary ── */
  const netUnitPrice = enginePricing?.netUnitPrice ?? null;
  const executionReport: ExecutionReport = {
    listPrice,
    adjustment: enginePricing && (enginePricing.adjustmentType || enginePricing.adjustmentValue !== null)
      ? { type: enginePricing.adjustmentType, value: enginePricing.adjustmentValue, computedAmount: listPrice !== null && netUnitPrice !== null ? listPrice - netUnitPrice : null }
      : null,
    netUnitPrice,
    subtotal: netUnitPrice !== null ? netUnitPrice * (args.quantity ?? 1) : null,
    decisionTableRowMatched,
    blocker,
    pricingWaterfall: enginePricing?.waterfall,
  };

  return { success: !blocker, executionReport, steps };
}

/* ── Phase 4 helper ── */
async function localPrecheckSimulation(
  client: SalesforceClient,
  sourceObject: string,
  args: VerifyExecutionArgs,
): Promise<{ listPrice: number | null; matched: boolean; category?: string; reason?: string; details?: unknown }> {
  let describe;
  try {
    describe = await describeObjectCached(client, sourceObject);
  } catch {
    return { listPrice: null, matched: false, category: "runtime-configuration", reason: `Could not describe ${sourceObject}.` };
  }

  const findField = (patterns: RegExp[]) => describe.fields.find(f => patterns.some(p => p.test(f.name)));
  const productField = findField([/^Product2Id$/i, /^ProductId$/i]);
  const attrValueField = findField([/^AttributeValue$/i, /^SelectedValue$/i, /^Value$/i, /^AttributePicklistValueId$/i]);
  const adjTypeField = findField([/^AdjustmentType$/i, /^PriceAdjustmentType$/i, /^TierType$/i]);
  const adjValueField = findField([/^AdjustmentValue$/i, /^TierValue$/i, /^Percent$/i, /^AdjustmentAmount$/i]);

  if (!productField) {
    return { listPrice: null, matched: false, category: "runtime-configuration", reason: `${sourceObject} has no recognizable Product reference field.` };
  }

  const fieldNames = Array.from(new Set(["Id", productField.name, attrValueField?.name, adjTypeField?.name, adjValueField?.name].filter(Boolean))) as string[];
  let records: Record<string, unknown>[] = [];
  try {
    const res = await client.query<Record<string, unknown>>(`SELECT ${fieldNames.join(", ")} FROM ${sourceObject} WHERE ${productField.name} = '${args.productId}'`);
    records = res.records;
  } catch (err) {
    return { listPrice: null, matched: false, category: "decision-table-row-match", reason: err instanceof Error ? err.message : "Query failed." };
  }

  if (records.length === 0) {
    return { listPrice: null, matched: false, category: "decision-table-row-match", reason: "No Decision Table rows found for this product." };
  }

  if (attrValueField) {
    const availableValues = [...new Set(records.map(r => String(r[attrValueField.name] ?? "")).filter(Boolean))];
    const match = records.find(r => String(r[attrValueField.name] ?? "").toLowerCase() === args.attributeValue.toLowerCase());
    if (!match) {
      return { listPrice: null, matched: false, category: "attribute-value-mismatch", reason: `"${args.attributeValue}" is not one of this attribute's configured values.`, details: { availableValues } };
    }
    return {
      listPrice: adjValueField ? Number(match[adjValueField.name]) || null : null,
      matched: true,
    };
  }

  return { listPrice: null, matched: true };
}

/* ── Phase 5 response parsing ── */
function parseEngineResponse(raw: unknown): { listPrice: number | null; adjustmentType: string | null; adjustmentValue: number | null; netUnitPrice: number | null; waterfall: unknown } {
  const root = (raw ?? {}) as Record<string, unknown>;
  const additional = (root.additionalOutputData ?? {}) as Record<string, unknown>;
  const waterfallRoot = (Array.isArray(additional.pricingWaterfall) ? additional.pricingWaterfall[0] : additional.pricingWaterfall) as Record<string, unknown> | undefined;
  const waterfall = (waterfallRoot?.waterfall as Record<string, unknown>[] | undefined) ?? [];

  let listPrice: number | null = null;
  let adjustmentType: string | null = null;
  let adjustmentValue: number | null = null;
  let netUnitPrice: number | null = null;

  for (const entry of waterfall) {
    const elementType = String(entry.elementType ?? entry.stepName ?? entry.name ?? "");
    const output = (entry.outputParameters ?? {}) as Record<string, unknown>;
    if (elementType === "ListPrice") {
      listPrice = toNumber(output.ListPrice ?? output.NetUnitPrice);
    }
    if (/attribute/i.test(elementType)) {
      netUnitPrice = toNumber(output.NetUnitPrice) ?? netUnitPrice;
      const adjustments = (entry.adjustments as Record<string, unknown>[] | undefined) ?? [];
      const first = adjustments[0];
      if (first) {
        adjustmentType = (first.type as string) ?? (first.adjustmentType as string) ?? null;
        adjustmentValue = toNumber(first.value ?? first.adjustmentValue);
      }
    }
  }

  const output = (root.output ?? {}) as Record<string, unknown>;
  listPrice = listPrice ?? toNumber(output.ListPrice);
  netUnitPrice = netUnitPrice ?? toNumber(output.NetUnitPrice);

  const simulationResults = (root.simulationResults as Record<string, unknown>[] | undefined) ?? [];
  if (simulationResults[0]) {
    listPrice = listPrice ?? toNumber(simulationResults[0].ListPrice);
    netUnitPrice = netUnitPrice ?? toNumber(simulationResults[0].NetUnitPrice);
  }

  return { listPrice, adjustmentType, adjustmentValue, netUnitPrice, waterfall: waterfall.length > 0 ? waterfall : undefined };
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

// Re-exported for the create-procedure route's own leakage/consistency checks, per §10.1's bug-fix note.
export function retrievedXmlHasAttributeDiscount(fileXml: string): boolean {
  return findStepsByActionType(fileXml, "AttributeDiscount").length > 0;
}
export function customElementFieldNames(fileXml: string): string[] {
  return extractCustomElementBlocks(fileXml).flatMap(ce => getAllTagValues(ce, "name"));
}
