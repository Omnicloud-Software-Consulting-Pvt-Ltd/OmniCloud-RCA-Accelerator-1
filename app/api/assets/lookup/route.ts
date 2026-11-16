import type { NextRequest } from "next/server";
import { soql } from "@/lib/ramp/server/api";
import { searchCatalog, lineItemFieldCaps } from "@/lib/ramp/server/catalog";
import { accountOpportunities, productLineOptions } from "@/lib/ramp/server/quoteBuilder";
import { idParam, lifecycleRoute, requireIdParam } from "@/lib/assetLifecycle/server/context";
import { accountContracts, assetStats, billingOptions, fieldsOf, lifecycleCapabilities } from "@/lib/assetLifecycle/server/reads";

// GET /api/assets/lookup?type=… — READ-ONLY pickers and org capabilities for the asset lifecycle pages.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return lifecycleRoute(req, async ({ api }) => {
    const q = (p.get("q") ?? "").trim().slice(0, 80);
    switch (p.get("type")) {
      case "accounts": {
        // Accounts that own lifecycle assets first (the ones these modules can act on); `all=1` searches every account.
        const asset = await fieldsOf(api, "Asset");
        const scoped = p.get("all") !== "1" && asset?.has("HasLifecycleManagement");
        const where = [scoped ? "Id IN (SELECT AccountId FROM Asset WHERE HasLifecycleManagement = true)" : null, q ? `Name LIKE ${soql(`%${q.replace(/[%_]/g, "")}%`)}` : null].filter(Boolean);
        const rows = await api.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Account${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY Name LIMIT 50`);
        return { success: true, rows: rows.map(r => ({ id: r.Id, name: r.Name })) };
      }
      case "contracts": return { success: true, rows: await accountContracts(api, requireIdParam(p.get("accountId"), "accountId")) };
      case "opportunities": return { success: true, rows: await accountOpportunities(api, requireIdParam(p.get("accountId"), "accountId")) };
      case "catalog": return { success: true, ...(await searchCatalog(api, { q, pricebookId: idParam(p.get("pricebookId"), "pricebookId"), page: Number(p.get("page") ?? 1) || 1, pageSize: 20, inPricebookOnly: !!p.get("pricebookId") })) };
      case "product-options": return { success: true, ...(await productLineOptions(api, requireIdParam(p.get("productId"), "productId"), idParam(p.get("pricebookId"), "pricebookId"))) };
      case "fields": {
        const caps = await lineItemFieldCaps(api);
        return { success: true, billingFrequencies: caps.billingFrequencyOptions };
      }
      case "capabilities": return { success: true, capabilities: await lifecycleCapabilities(api) };
      // Bill-To Contact + Billing / Shipping address choices for the lifecycle forms (orderIds = the assets' original orders).
      case "billing-details": return { success: true, ...(await billingOptions(api, requireIdParam(p.get("accountId"), "accountId"), (p.get("orderIds") ?? "").split(",").filter(Boolean).slice(0, 20).map(x => requireIdParam(x, "orderIds")))) };
      case "stats": return { success: true, stats: await assetStats(api) };
      default: return { success: false, error: "Unknown lookup type." };
    }
  }, "Asset lookup failed");
}
