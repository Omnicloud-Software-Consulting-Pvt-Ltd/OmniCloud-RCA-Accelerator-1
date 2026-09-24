import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";
import { logSfCacheEvent } from "@/lib/salesforce/requestDebug";
import { resolveOrderListFieldSchema } from "@/lib/orders/metadata/orderFields";
import type { OrderListItem } from "@/lib/orders/types";

export interface OrderStatusBreakdown {
  status: string;
  count: number;
  totalValue: number | null;
}

/** A recent-activity row — the shared OrderListItem shape plus CreatedDate, so the dashboard can tell "just created" from "updated". */
export type OrderActivityItem = OrderListItem & { createdDate: string };

export interface OrderStatsResponse {
  success: true;
  totalOrders: number;
  totalValue: number | null;
  totalAmountFieldAvailable: boolean;
  statusBreakdown: OrderStatusBreakdown[];
  recentOrders: OrderActivityItem[];
}

type OrderStatsPayload = Omit<OrderStatsResponse, "success">;

/** §REQUEST_LIMIT_EXCEEDED remediation — see app/api/sf/products/stats/route.ts's identical comment. */
const orderStatsCache = createTTLCache<OrderStatsPayload>(30_000);

async function computeOrderStats(client: SalesforceClient): Promise<OrderStatsPayload> {
  const schema = await resolveOrderListFieldSchema(client);
  const totalAmountApi = schema.totalAmountField?.apiName ?? null;

  const aggSoql = totalAmountApi
    ? `SELECT Status, COUNT(Id) oCount, SUM(${totalAmountApi}) oTotal FROM Order GROUP BY Status`
    : `SELECT Status, COUNT(Id) oCount FROM Order GROUP BY Status`;
  const agg = await client.query<{ Status: string | null; oCount: number; oTotal?: number | null }>(aggSoql);

  const statusBreakdown: OrderStatusBreakdown[] = agg.records.map(r => ({
    status: r.Status ?? "No Status",
    count: r.oCount,
    totalValue: totalAmountApi ? (r.oTotal ?? 0) : null,
  }));

  const totalOrders = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
  const totalValue = totalAmountApi ? statusBreakdown.reduce((sum, s) => sum + (s.totalValue ?? 0), 0) : null;

  // Recent activity — same shape as GET /api/orders, small page, includes
  // CreatedDate so the dashboard can tell "just created" from "updated".
  const selectFields = ["Id", "Status", "CreatedDate", "LastModifiedDate"];
  if (schema.orderNumberField) selectFields.push(schema.orderNumberField.apiName);
  if (totalAmountApi) selectFields.push(totalAmountApi);
  if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);

  const recentSoql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM Order ORDER BY LastModifiedDate DESC LIMIT 8`;
  const recentResult = await client.query<Record<string, unknown>>(recentSoql);

  const recentOrders: OrderActivityItem[] = recentResult.records.map(r => {
    const accountRel = schema.accountRelationshipField?.relationshipName
      ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null)
      : null;
    return {
      id: r.Id as string,
      orderNumber: schema.orderNumberField ? ((r[schema.orderNumberField.apiName] as string) ?? null) : null,
      totalAmount: totalAmountApi ? ((r[totalAmountApi] as number) ?? null) : null,
      status: (r.Status as string) ?? null,
      accountName: (accountRel?.Name as string) ?? null,
      pricebookName: null,
      contractName: null,
      lastModifiedDate: r.LastModifiedDate as string,
      createdDate: r.CreatedDate as string,
      lineItemCount: null,
    };
  });

  return { totalOrders, totalValue, totalAmountFieldAvailable: !!totalAmountApi, statusBreakdown, recentOrders };
}

/**
 * GET /api/orders/stats — aggregate counts/value for the Orders dashboard
 * (landing page shown before entering the existing Order history/create
 * flows). Separate from GET /api/orders (the 50 most recent Orders for the
 * history list) because dashboard totals must reflect the WHOLE org.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const cacheKey = client.instanceUrl;
    const payload = await orderStatsCache.getOrCompute(cacheKey, () => computeOrderStats(client));
    logSfCacheEvent({
      endpoint: "/api/orders/stats", caller: "computeOrderStats", cacheKey,
      status: orderStatsCache.peekStatus(cacheKey) ?? "miss-computed",
    });
    return NextResponse.json({ success: true, ...payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load order statistics");
  }
}
