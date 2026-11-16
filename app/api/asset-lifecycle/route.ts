import type { NextRequest } from "next/server";
import { idParam, lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { lifecycleCapabilities, salesforceTransactions } from "@/lib/assetLifecycle/server/reads";
import { parseKind, saveTransaction } from "@/lib/assetLifecycle/server/service";

// GET /api/asset-lifecycle?kind=amend|renew|cancel — the dashboard: org capabilities, this app's transactions, the lifecycle quotes /
// orders that exist in Salesforce, and the audit trail. POST — create / update a transaction (app storage only; nothing is sent to
// Salesforce here — every write is a separately confirmed step).
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return lifecycleRoute(req, async ({ api, orgId, store }) => {
    const kind = parseKind(p.get("kind"));
    const accountId = idParam(p.get("accountId"), "accountId");
    const [capabilities, salesforce, data] = await Promise.all([lifecycleCapabilities(api), salesforceTransactions(api, kind, accountId).catch(e => ({ error: e instanceof Error ? e.message : String(e) })), store.load(orgId)]);
    const transactions = data.transactions.filter(t => t.kind === kind && (!accountId || t.accountId === accountId));
    return {
      success: true, kind, capabilities, durability: store.durability(),
      transactions: transactions.map(t => ({ id: t.id, name: t.name, status: t.status, accountId: t.accountId, accountName: t.accountName, contractNumber: t.contractNumber, effectiveDate: t.effectiveDate, assets: t.assets.length, createdAt: t.createdAt, updatedAt: t.updatedAt, sf: t.sf, nextStep: t.steps.find(s => s.status !== "completed" && s.status !== "skipped")?.label ?? null })),
      salesforce: Array.isArray(salesforce) ? salesforce : [], salesforceError: Array.isArray(salesforce) ? null : salesforce.error,
      audit: data.audit.filter(a => a.kind === kind).slice(-100).reverse(),
    };
  }, "Failed to load lifecycle transactions");
}

export async function POST(req: NextRequest) {
  return lifecycleRoute(req, async (ctx, body) => {
    const { transaction, errors } = await saveTransaction(ctx, body, ctx.today);
    return { success: true, transaction, errors };
  }, "Failed to save the transaction");
}
