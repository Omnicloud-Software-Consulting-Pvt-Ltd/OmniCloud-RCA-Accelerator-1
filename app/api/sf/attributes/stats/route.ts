import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { logSfCacheEvent } from "@/lib/salesforce/requestDebug";
import { loadAttributeList } from "@/lib/attributes/server/attributeDetail";
import type { AttributeListItem } from "@/lib/attributes/types";

export interface AttributeActivityItem {
  id: string;
  name: string;
  dataType: string | null;
  relatedProductName: string | null;
  isActive: boolean;
  /** Derived from CreatedDate vs LastModifiedDate, same convention as /api/bundles/stats — Salesforce has no field distinguishing them. */
  action: "Created" | "Updated";
  lastModifiedDate: string;
}

export interface AttributeStatsResponse {
  success: true;
  totalAttributes: number;
  activeAttributes: number;
  recentlyCreated: number;
  picklistAttributes: number;
  productsUsingAttributes: number;
  recentActivity: AttributeActivityItem[];
}

type AttributeStatsPayload = Omit<AttributeStatsResponse, "success">;

function isRecentlyCreated(a: AttributeListItem): boolean {
  return Date.now() - new Date(a.createdDate).getTime() <= 7 * 24 * 60 * 60 * 1000;
}

/**
 * §REQUEST_LIMIT_EXCEEDED remediation — see app/api/sf/products/stats/route.ts's
 * identical comment. Scoped to THIS route's own invocation of
 * loadAttributeList() only — the Attribute History/Catalog pages call it via
 * their own route, unaffected by this cache, so they never show data staler
 * than a fresh Salesforce read.
 */
const attributeStatsCache = createTTLCache<AttributeStatsPayload>(30_000);

async function computeAttributeStats(client: SalesforceClient): Promise<AttributeStatsPayload> {
  const attributes = await loadAttributeList(client);

  const totalAttributes = attributes.length;
  const activeAttributes = attributes.filter(a => a.isActive).length;
  const recentlyCreated = attributes.filter(isRecentlyCreated).length;
  const picklistAttributes = attributes.filter(a => a.isPicklist).length;
  const productsUsingAttributes = new Set(attributes.flatMap(a => a.relatedProducts.map(p => p.id))).size;

  const recentActivity: AttributeActivityItem[] = attributes
    .slice()
    .sort((a, b) => new Date(b.lastModifiedDate).getTime() - new Date(a.lastModifiedDate).getTime())
    .slice(0, 8)
    .map(a => {
      const created = new Date(a.createdDate).getTime();
      const modified = new Date(a.lastModifiedDate).getTime();
      return {
        id: a.id,
        name: a.name,
        dataType: a.dataType,
        relatedProductName: a.relatedProducts[0]?.name ?? null,
        isActive: a.isActive,
        action: Math.abs(modified - created) < 5000 ? "Created" : "Updated",
        lastModifiedDate: a.lastModifiedDate,
      };
    });

  return { totalAttributes, activeAttributes, recentlyCreated, picklistAttributes, productsUsingAttributes, recentActivity };
}

/**
 * GET /api/sf/attributes/stats — real numbers for the Attribute Workspace
 * dashboard. Built on the same loadAttributeList() read Attribute
 * History/Catalog use — never a second query path, per the task's own
 * "reuse the existing Attribute Creation and Deployment APIs" instruction
 * extended to reads.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const cacheKey = auth.client.instanceUrl;
    const payload = await attributeStatsCache.getOrCompute(cacheKey, () => computeAttributeStats(auth.client));
    logSfCacheEvent({
      endpoint: "/api/sf/attributes/stats", caller: "computeAttributeStats", cacheKey,
      status: attributeStatsCache.peekStatus(cacheKey) ?? "miss-computed",
    });
    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load attribute statistics");
  }
}
