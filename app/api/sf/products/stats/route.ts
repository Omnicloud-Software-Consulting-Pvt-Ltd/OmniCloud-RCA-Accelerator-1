import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { logSfCacheEvent } from "@/lib/salesforce/requestDebug";

export interface ProductBreakdownEntry {
  status: string;
  count: number;
}

export type ProductActivityItem = {
  id: string;
  name: string;
  productCode: string | null;
  family: string | null;
  type: string | null;
  isActive: boolean;
  createdDate: string;
  lastModifiedDate: string;
};

export interface ProductStatsResponse {
  success: true;
  totalProducts: number;
  activeProducts: number;
  draftProducts: number;
  bundleProducts: number;
  recentlyCreated: number;
  statusBreakdown: ProductBreakdownEntry[];
  typeBreakdown: ProductBreakdownEntry[];
  recentProducts: ProductActivityItem[];
}

type ProductStatsPayload = Omit<ProductStatsResponse, "success">;

/**
 * §REQUEST_LIMIT_EXCEEDED remediation: dashboard statistics are read-only
 * and don't need to be second-fresh — a short TTL absorbs the single-page
 * app's remount-on-every-navigation behavior (Products → Orders → back to
 * Products previously re-ran this route's 3 SOQL queries from scratch every
 * time) and coalesces concurrent requests (e.g. two dashboard widgets
 * mounting in the same tick) into one Salesforce round trip via
 * createTTLCache's built-in in-flight de-duplication. Never applied to any
 * create/update/delete route — reads only.
 */
const productStatsCache = createTTLCache<ProductStatsPayload>(30_000);

/** Product2 has no native Draft/Active picklist — IsActive is the only org-tracked publish-state signal, so "Draft" here means IsActive = false (mirrors how the Create Product form and app/api/bundles/list already treat an un-activated/unpriced record as effectively still a draft). "Bundles" reuses the exact Type = 'Bundle' filter app/api/bundles/list uses. */
async function computeProductStats(client: SalesforceClient): Promise<ProductStatsPayload> {
  const agg = await client.query<{ IsActive: boolean; Type: string | null; cnt: number }>(
    "SELECT IsActive, Type, COUNT(Id) cnt FROM Product2 GROUP BY IsActive, Type",
  );

  let totalProducts = 0;
  let activeProducts = 0;
  let draftProducts = 0;
  let bundleProducts = 0;
  const typeCounts = new Map<string, number>();

  for (const r of agg.records) {
    totalProducts += r.cnt;
    if (r.IsActive) activeProducts += r.cnt;
    else draftProducts += r.cnt;
    if (r.Type === "Bundle") bundleProducts += r.cnt;
    const typeLabel = r.Type ?? "Standard";
    typeCounts.set(typeLabel, (typeCounts.get(typeLabel) ?? 0) + r.cnt);
  }

  const recentAgg = await client.query<{ cnt: number }>(
    "SELECT COUNT(Id) cnt FROM Product2 WHERE CreatedDate = LAST_N_DAYS:7",
  );
  const recentlyCreated = recentAgg.records[0]?.cnt ?? 0;

  const recentResult = await client.query<Record<string, unknown>>(
    "SELECT Id, Name, ProductCode, Family, Type, IsActive, CreatedDate, LastModifiedDate FROM Product2 ORDER BY LastModifiedDate DESC LIMIT 8",
  );

  const recentProducts: ProductActivityItem[] = recentResult.records.map(r => ({
    id: r.Id as string,
    name: r.Name as string,
    productCode: (r.ProductCode as string) ?? null,
    family: (r.Family as string) ?? null,
    type: (r.Type as string) ?? null,
    isActive: !!r.IsActive,
    createdDate: r.CreatedDate as string,
    lastModifiedDate: r.LastModifiedDate as string,
  }));

  const statusBreakdown: ProductBreakdownEntry[] = [
    { status: "Active", count: activeProducts },
    { status: "Draft", count: draftProducts },
  ];
  const typeBreakdown: ProductBreakdownEntry[] = Array.from(typeCounts.entries()).map(([status, count]) => ({ status, count }));

  return { totalProducts, activeProducts, draftProducts, bundleProducts, recentlyCreated, statusBreakdown, typeBreakdown, recentProducts };
}

/**
 * GET /api/sf/products/stats — aggregate counts for the Products dashboard
 * (landing page shown before entering Create Product/Product History).
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const cacheKey = client.instanceUrl;
    const payload = await productStatsCache.getOrCompute(cacheKey, () => computeProductStats(client));
    logSfCacheEvent({
      endpoint: "/api/sf/products/stats", caller: "computeProductStats", cacheKey,
      status: productStatsCache.peekStatus(cacheKey) ?? "miss-computed",
    });
    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load product statistics");
  }
}
