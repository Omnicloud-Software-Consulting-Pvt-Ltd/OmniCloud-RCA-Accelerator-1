import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";

export interface PricingRuleStatusBreakdown {
  status: string;
  count: number;
}

/** A recent-activity row — only fields Describe actually confirmed exist on this org's ExpressionSet are populated. */
export interface PricingRuleActivityItem {
  id: string;
  name: string;
  status: string | null;
  versionNumber: number | null;
  lastModifiedDate: string | null;
  createdDate: string | null;
}

export interface PricingRuleStatsResponse {
  success: true;
  totalProcedures: number;
  statusBreakdown: PricingRuleStatusBreakdown[];
  statusFieldAvailable: boolean;
  createdLast7d: number | null;
  recentProcedures: PricingRuleActivityItem[];
}

type PricingRuleStatsPayload = Omit<PricingRuleStatsResponse, "success">;

/** §REQUEST_LIMIT_EXCEEDED remediation — see app/api/quotes/stats/route.ts's identical comment. */
const pricingRuleStatsCache = createTTLCache<PricingRuleStatsPayload>(30_000);

async function computePricingRuleStats(client: SalesforceClient): Promise<PricingRuleStatsPayload> {
  let available = new Set<string>();
  try {
    const describe = await describeObjectCached(client, "ExpressionSet");
    available = new Set(describe.fields.map(f => f.name));
  } catch {
    // ExpressionSet isn't describable on this org (unlikely) — degrade to Id/Name-only below.
  }

  const hasStatus = available.has("Status");
  const hasVersionNumber = available.has("VersionNumber");
  const hasCreatedDate = available.has("CreatedDate");
  const hasLastModifiedDate = available.has("LastModifiedDate");

  let totalProcedures = 0;
  let statusBreakdown: PricingRuleStatusBreakdown[] = [];
  if (hasStatus) {
    const agg = await client.query<{ Status: string | null; cnt: number }>(
      "SELECT Status, COUNT(Id) cnt FROM ExpressionSet GROUP BY Status",
    );
    statusBreakdown = agg.records.map(r => ({ status: r.Status ?? "No Status", count: r.cnt }));
    totalProcedures = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
  } else {
    const agg = await client.query<{ cnt: number }>("SELECT COUNT(Id) cnt FROM ExpressionSet");
    totalProcedures = agg.records[0]?.cnt ?? 0;
  }

  const createdLast7d = hasCreatedDate
    ? (await client.query<{ cnt: number }>("SELECT COUNT(Id) cnt FROM ExpressionSet WHERE CreatedDate = LAST_N_DAYS:7")).records[0]?.cnt ?? 0
    : null;

  const recentFields = ["Id", "Name"];
  if (hasStatus) recentFields.push("Status");
  if (hasVersionNumber) recentFields.push("VersionNumber");
  if (hasCreatedDate) recentFields.push("CreatedDate");
  if (hasLastModifiedDate) recentFields.push("LastModifiedDate");
  const orderField = hasLastModifiedDate ? "LastModifiedDate" : hasCreatedDate ? "CreatedDate" : null;
  const recentSoql = `SELECT ${recentFields.join(", ")} FROM ExpressionSet${orderField ? ` ORDER BY ${orderField} DESC` : ""} LIMIT 8`;
  const recentResult = await client.query<Record<string, unknown>>(recentSoql);

  const recentProcedures: PricingRuleActivityItem[] = recentResult.records.map(r => ({
    id: r.Id as string,
    name: (r.Name as string) ?? (r.Id as string),
    status: hasStatus ? ((r.Status as string) ?? null) : null,
    versionNumber: hasVersionNumber ? ((r.VersionNumber as number) ?? null) : null,
    lastModifiedDate: hasLastModifiedDate ? (r.LastModifiedDate as string) : null,
    createdDate: hasCreatedDate ? (r.CreatedDate as string) : null,
  }));

  return { totalProcedures, statusBreakdown, statusFieldAvailable: hasStatus, createdLast7d, recentProcedures };
}

/**
 * GET /api/pricing-rules/stats — aggregate counts + recent activity for the
 * Pricing Rules dashboard (landing page shown before entering the type
 * picker/history). Schema-driven exactly like GET /api/pricing-rules/list —
 * never assumes Status/VersionNumber/CreatedDate exist on ExpressionSet
 * beyond what Describe actually confirms for this org. Separate from GET
 * /api/pricing-rules/list (which only returns the 20 most recent records for
 * the History tab) because dashboard totals must reflect the whole org.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const cacheKey = client.instanceUrl;
    const payload = await pricingRuleStatsCache.getOrCompute(cacheKey, () => computePricingRuleStats(client));
    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load pricing rule statistics");
  }
}
