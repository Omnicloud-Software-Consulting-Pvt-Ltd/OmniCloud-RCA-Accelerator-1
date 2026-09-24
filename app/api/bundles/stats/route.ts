import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { logSfCacheEvent } from "@/lib/salesforce/requestDebug";

export interface BundleActivityItem {
  id: string;
  name: string;
  /** Derived from real Created/LastModified timestamps — "Created" when they're within a few seconds of each other, "Updated" otherwise. Salesforce has no field distinguishing AI-created/imported/manually-edited, so this app never claims one. */
  action: "Created" | "Updated";
  isActive: boolean;
  lastModifiedDate: string;
  lastModifiedByName: string | null;
}

export interface BundleStatsResponse {
  success: true;
  totalBundles: number;
  activeBundles: number;
  draftBundles: number;
  totalComponents: number;
  recentlyUpdated: number;
  recentActivity: BundleActivityItem[];
}

type BundleStatsPayload = Omit<BundleStatsResponse, "success">;

/** §REQUEST_LIMIT_EXCEEDED remediation — see app/api/sf/products/stats/route.ts's identical comment. */
const bundleStatsCache = createTTLCache<BundleStatsPayload>(30_000);

async function computeBundleStats(client: SalesforceClient): Promise<BundleStatsPayload> {
  const bundleAgg = await client.query<{ IsActive: boolean; cnt: number }>(
    "SELECT IsActive, COUNT(Id) cnt FROM Product2 WHERE Type = 'Bundle' GROUP BY IsActive",
  );
  let totalBundles = 0, activeBundles = 0, draftBundles = 0;
  for (const r of bundleAgg.records) {
    totalBundles += r.cnt;
    if (r.IsActive) activeBundles += r.cnt; else draftBundles += r.cnt;
  }

  let totalComponents = 0;
  try {
    const compAgg = await client.query<{ cnt: number }>(
      "SELECT COUNT(Id) cnt FROM ProductRelatedComponent WHERE ParentProduct.Type = 'Bundle'",
    );
    totalComponents = compAgg.records[0]?.cnt ?? 0;
  } catch {
    /* ProductRelatedComponent may not be accessible — leave at 0 rather than guessing */
  }

  const recentAgg = await client.query<{ cnt: number }>(
    "SELECT COUNT(Id) cnt FROM Product2 WHERE Type = 'Bundle' AND LastModifiedDate = LAST_N_DAYS:7",
  );
  const recentlyUpdated = recentAgg.records[0]?.cnt ?? 0;

  const recentResult = await client.query<{
    Id: string; Name: string; IsActive: boolean; CreatedDate: string; LastModifiedDate: string; LastModifiedBy: { Name: string } | null;
  }>(
    "SELECT Id, Name, IsActive, CreatedDate, LastModifiedDate, LastModifiedBy.Name FROM Product2 WHERE Type = 'Bundle' ORDER BY LastModifiedDate DESC LIMIT 8",
  );

  const recentActivity: BundleActivityItem[] = recentResult.records.map(r => {
    const created = new Date(r.CreatedDate).getTime();
    const modified = new Date(r.LastModifiedDate).getTime();
    return {
      id: r.Id,
      name: r.Name,
      action: Math.abs(modified - created) < 5000 ? "Created" : "Updated",
      isActive: !!r.IsActive,
      lastModifiedDate: r.LastModifiedDate,
      lastModifiedByName: r.LastModifiedBy?.Name ?? null,
    };
  });

  return { totalBundles, activeBundles, draftBundles, totalComponents, recentlyUpdated, recentActivity };
}

/**
 * GET /api/bundles/stats — real numbers for the Bundle Workspace dashboard.
 * Mirrors /api/sf/products/stats's shape/conventions (IsActive is the only
 * org-tracked publish-state signal, so "Draft" = IsActive false) scoped to
 * Type = 'Bundle', the same filter /api/bundles/list already uses.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const cacheKey = client.instanceUrl;
    const payload = await bundleStatsCache.getOrCompute(cacheKey, () => computeBundleStats(client));
    logSfCacheEvent({
      endpoint: "/api/bundles/stats", caller: "computeBundleStats", cacheKey,
      status: bundleStatsCache.peekStatus(cacheKey) ?? "miss-computed",
    });
    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load bundle statistics");
  }
}
