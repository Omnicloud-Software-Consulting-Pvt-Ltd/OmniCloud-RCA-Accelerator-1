import { NextRequest } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { runCreateAttributePricingPipeline, generateExecutionId } from "@/lib/pricing-rules/attribute-based/create/createPipeline";
import type { CombinationRulePlanRow, DiscoveredAttribute, DiscoveredProduct, PricingRulePlanRow } from "@/lib/pricing-rules/attribute-based/types";
import type { CreateStreamEvent } from "@/lib/pricing-rules/attribute-based/create/types";
import type { AdjustmentDecisionOverride } from "@/lib/pricing-rules/attribute-based/create/nativeRecords";

/**
 * POST /api/pricing-rules/attribute-based/create
 *
 * Parts G-Q: the first stage of this flow allowed to write to Salesforce.
 * Streams one NDJSON line per pipeline step (Part T's live status display),
 * ending with exactly one terminal `{"type":"result",...}` line carrying
 * the complete outcome — a dropped/truncated connection before that line
 * arrives must never be read by the client as a silent success.
 *
 * The caller must have already walked the read-only analyze pipeline
 * (/api/pricing-rules/attribute-based/analyze) to a `ready-for-review`
 * result and gotten explicit user confirmation (Part F) — this endpoint
 * itself does not re-run product/attribute/value validation from scratch,
 * though every create step still re-verifies its own prerequisites fresh
 * against Salesforce before writing (Part G).
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let body: {
    product: DiscoveredProduct;
    discoveredAttributes: DiscoveredAttribute[];
    rules: PricingRulePlanRow[];
    /** §Combination-expansion architecture fix — explicit combination-specific pricing requests, already
     * resolved against real Salesforce data by the analyze endpoint. Absent/empty (the default) means no
     * combinatorial expansion happens at all. */
    combinationRules?: CombinationRulePlanRow[];
    excludedAttributes: string[];
    procedureName: string;
    description?: string;
    activate?: boolean;
    /** §Phase 9/24 — resolutions for previously-reported `pendingAdjustmentConflicts` (from a prior call
     * to this SAME endpoint), keyed by `adjustmentDecisionKey(attributeName, value)`. Absent on a normal
     * first submission. */
    adjustmentDecisions?: Record<string, AdjustmentDecisionOverride>;
    /** §Root-cause fix (deterministic run-boundary provenance) — the `executionId` a PRIOR call's result
     * already returned, to resume THAT run's combinatorial-closure Rule-completion eligibility (see
     * `runBoundaryStore.ts`). Absent on a normal first submission — same optional, stateless-resubmit
     * convention as `adjustmentDecisions`. */
    resumeExecutionId?: string;
  };
  try {
    body = await req.json();
    if (!body?.product?.id || !Array.isArray(body.rules) || body.rules.length === 0 || !body.procedureName?.trim()) {
      return new Response(JSON.stringify({ error: "product, rules, and procedureName are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function write(event: CreateStreamEvent) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      try {
        const result = await runCreateAttributePricingPipeline(
          {
            client,
            product: body.product,
            discoveredAttributes: body.discoveredAttributes ?? [],
            rules: body.rules,
            combinationRules: body.combinationRules ?? [],
            excludedAttributes: body.excludedAttributes ?? [],
            procedureName: body.procedureName,
            description: body.description,
            activate: body.activate ?? true,
            adjustmentDecisions: body.adjustmentDecisions,
            resumeExecutionId: body.resumeExecutionId,
          },
          event => write({ type: "step", step: event.step, status: event.status, detail: event.detail }),
        );
        write({ type: "result", result });
      } catch (err) {
        const executionId = generateExecutionId();
        console.error(`[pricing-rules/attribute-based/create] [${executionId}] Unhandled error:`, err);
        write({
          type: "result",
          result: {
            success: false,
            error: `[${executionId}] An unexpected error occurred while creating this pricing procedure. Nothing further was attempted — check server logs for details.`,
            warnings: [],
            steps: [],
            executionId,
            auditLog: [],
            procedureSnapshot: {
              executionId,
              pricingType: "attribute-based",
              product: { name: body.product?.name ?? "", id: body.product?.id ?? "" },
              attributes: [],
              pricingRules: [],
              salesforce: {
                priceAdjustmentScheduleId: null,
                attributeBasedAdjustmentRuleIds: [],
                attributeAdjustmentConditionIds: [],
                attributeBasedAdjustmentIds: [],
                expressionSetId: null,
                expressionSetVersionId: null,
                pricingProcedureApiName: null,
              },
              verificationStatus: "failed",
            },
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
