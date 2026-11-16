import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { getObjectCountStats } from "@/lib/billing/server/stats";
import { createTTLCache } from "@/lib/salesforce/cache";
import { REVENUE_CORE_MODULES } from "@/lib/revenueCore/modules";
import type { BillingModuleStatus } from "@/lib/billing/types";
import type { SalesforceClient } from "@/lib/salesforce/client";

export type RevenueCoreModuleStatus = Omit<BillingModuleStatus, "group">;

export interface RevenueCoreRecentProduct {
  id: string;
  name: string;
  productCode: string | null;
  type: string | null;
  isActive: boolean;
  createdDate: string;
}

export interface RevenueCoreStatsResponse {
  success: true;
  modules: RevenueCoreModuleStatus[];
  /** Most recently CREATED products (null when the query failed — the error is in recentProductsError). */
  recentProducts: RevenueCoreRecentProduct[] | null;
  recentProductsError: string | null;
  apiVersion: string;
  generatedAt: string;
}

const recentCache = createTTLCache<RevenueCoreRecentProduct[]>(30_000);

async function loadRecentProducts(client: SalesforceClient): Promise<RevenueCoreRecentProduct[]> {
  const res = await client.query<Record<string, unknown>>("SELECT Id, Name, ProductCode, Type, IsActive, CreatedDate FROM Product2 ORDER BY CreatedDate DESC LIMIT 6");
  return res.records.map(r => ({
    id: String(r.Id), name: String(r.Name ?? ""), productCode: (r.ProductCode as string) ?? null,
    type: (r.Type as string) ?? null, isActive: !!r.IsActive, createdDate: String(r.CreatedDate ?? ""),
  }));
}

/**
 * GET /api/revenue-core/stats — read-only counts for the Revenue Cloud Core dashboard (products, attributes, catalogs,
 * bundles, selling models, price books, pricing procedures, adjustments, configurator). One Describe Global + 1–2
 * Composite Batch calls, cached 30s per org/user; `?fresh=1` bypasses the cache (dashboard Refresh). Never writes.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const recentKey = `${client.cacheScope}:revenue-core-recent`;
    if (fresh) recentCache.clear(recentKey);
    const [statuses, recent] = await Promise.all([
      getObjectCountStats(client, REVENUE_CORE_MODULES, "revenue-core", { fresh }),
      recentCache.getOrCompute(recentKey, () => loadRecentProducts(client)).then(
        v => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
      ),
    ]);
    const body: RevenueCoreStatsResponse = {
      success: true,
      // `group` is a billing-only concept — dropped from the Revenue Cloud Core payload.
      modules: statuses.map(s => { const rest: RevenueCoreModuleStatus & { group?: unknown } = { ...s }; delete rest.group; return rest; }),
      recentProducts: recent.ok ? recent.v : null,
      recentProductsError: recent.ok ? null : recent.e,
      apiVersion: client.apiVersion,
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (err) {
    return sfErrorResponse(err, "Failed to load Revenue Cloud Core statistics");
  }
}
