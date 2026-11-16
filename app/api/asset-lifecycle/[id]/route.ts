import type { NextRequest } from "next/server";
import { lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { lifecycleOrder, lifecycleQuote } from "@/lib/assetLifecycle/server/reads";
import { deleteTransaction, LifecycleInputError } from "@/lib/assetLifecycle/server/service";
import { previewRows, renewalWindow, validateTransaction, initiateRequest, swapRequest } from "@/lib/assetLifecycle/plan";

type Params = { params: Promise<{ id: string }> };

// GET /api/asset-lifecycle/[id] — one transaction: plan, preview, the exact initiate request, the LIVE lifecycle quote / order read
// from Salesforce, and its audit trail. DELETE — remove an unsent draft (sent transactions stay as history).
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async ({ api, orgId, store, today, instanceUrl }) => {
    const data = await store.load(orgId);
    const t = data.transactions.find(x => x.id === id);
    if (!t) throw new LifecycleInputError("Transaction not found.");
    const [quote, order] = await Promise.all([
      t.sf.quoteId ? lifecycleQuote(api, t.sf.quoteId, t.cancel?.reasonField).catch(e => ({ error: e instanceof Error ? e.message : String(e) })) : Promise.resolve(null),
      t.sf.orderId ? lifecycleOrder(api, { orderId: t.sf.orderId }).catch(e => ({ error: e instanceof Error ? e.message : String(e) })) : Promise.resolve(null),
    ]);
    return {
      success: true, instanceUrl, transaction: t, preview: previewRows(t), request: swapRequest(t) ?? initiateRequest(t), window: t.kind === "renew" ? renewalWindow(t) : null,
      problems: t.sf.quoteId ? [] : validateTransaction(t, null, today),
      quote, order, audit: data.audit.filter(a => a.transactionId === id).reverse(),
    };
  }, "Failed to load the transaction");
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async ctx => { await deleteTransaction(ctx, id); return { success: true }; }, "Failed to delete the transaction");
}
