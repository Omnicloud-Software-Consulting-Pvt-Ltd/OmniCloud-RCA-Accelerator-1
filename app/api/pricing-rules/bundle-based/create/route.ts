import { NextRequest } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { runCreateBundlePricingPipeline, generateExecutionId } from "@/lib/pricing-rules/bundle-based/create/createPipeline";
import type { DiscoveredBundle, BundleComponentPlanRow } from "@/lib/pricing-rules/bundle-based/types";
import type { CreateStreamEvent } from "@/lib/pricing-rules/bundle-based/create/types";

/**
 * POST /api/pricing-rules/bundle-based/create
 *
 * The first stage of this flow allowed to write to Salesforce. Mirrors
 * /api/pricing-rules/attribute-based/create exactly: streams one NDJSON line per pipeline step, ending
 * with exactly one terminal `{"type":"result",...}` line — a dropped/truncated connection before that
 * line arrives must never be read by the client as a silent success.
 *
 * The caller must have already walked the read-only analyze pipeline
 * (/api/pricing-rules/bundle-based/analyze) to a `ready-for-review` result and gotten explicit user
 * confirmation — this endpoint does not re-run bundle/component validation from scratch, though every
 * create step still re-verifies its own prerequisites fresh against Salesforce before writing.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let body: {
    bundle: DiscoveredBundle;
    rules: BundleComponentPlanRow[];
    ignoredComponents: string[];
    procedureName: string;
    description?: string;
    activate?: boolean;
  };
  try {
    body = await req.json();
    if (!body?.bundle?.id || !Array.isArray(body.rules) || body.rules.length === 0 || !body.procedureName?.trim()) {
      return new Response(JSON.stringify({ error: "bundle, rules, and procedureName are required" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
        const result = await runCreateBundlePricingPipeline(
          {
            client,
            bundle: body.bundle,
            rules: body.rules,
            ignoredComponents: body.ignoredComponents ?? [],
            procedureName: body.procedureName,
            description: body.description,
            activate: body.activate ?? true,
          },
          event => write({ type: "step", step: event.step, status: event.status, detail: event.detail }),
        );
        write({ type: "result", result });
      } catch (err) {
        const executionId = generateExecutionId();
        console.error(`[pricing-rules/bundle-based/create] [${executionId}] Unhandled error:`, err);
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
              pricingType: "bundle-based",
              bundle: { name: body.bundle?.name ?? "", id: body.bundle?.id ?? "" },
              components: [],
              salesforce: {
                priceAdjustmentScheduleId: null,
                bundleBasedAdjRuleIds: [],
                bundleAdjustmentConditionIds: [],
                bundleBasedAdjustmentIds: [],
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
