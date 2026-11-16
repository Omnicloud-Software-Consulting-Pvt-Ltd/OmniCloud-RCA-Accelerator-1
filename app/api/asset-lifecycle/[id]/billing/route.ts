import type { NextRequest } from "next/server";
import { lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { LifecycleInputError, resolveBilling } from "@/lib/assetLifecycle/server/service";
import { billingChoices } from "@/lib/assetLifecycle/server/billingService";
import { discoverAssignmentField } from "@/lib/billing/server/assignment";
import { soql } from "@/lib/ramp/server/api";
import type { LifecycleTransaction } from "@/lib/assetLifecycle/types";

type Params = { params: Promise<{ id: string }> };
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

async function load(ctx: { store: { load: (o: string) => Promise<{ transactions: LifecycleTransaction[] }> }; orgId: string }, id: string) {
  const t = (await ctx.store.load(ctx.orgId)).transactions.find(x => x.id === id);
  if (!t) throw new LifecycleInputError("Transaction not found.");
  return t;
}

// GET /api/asset-lifecycle/[id]/billing — the open billing-readiness questions of this transaction, the order products they concern
// (read from Salesforce) and the eligible choices (real Billing Policies / Treatments of this org). Read-only.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async ctx => {
    const t = await load(ctx, id);
    const needs = t.billingNeeds ?? [];
    if (!needs.length || !ctx.billingClient) return { success: true, needs, orderProducts: [], policies: [], treatments: [] };
    const itemIds = [...new Set(needs.flatMap(n => n.orderItemIds))].filter(i => ID.test(i));
    const orderProducts = itemIds.length ? (await ctx.api.query<Record<string, unknown>>(`SELECT Id, Product2Id, Product2.Name, Product2.ProductCode, Quantity, UnitPrice, TotalPrice, ServiceDate, EndDate, ProductSellingModel.Name, Order.OrderNumber FROM OrderItem WHERE Id IN (${itemIds.map(soql).join(",")})`)).map(r => {
      const rel = (k: string) => (r[k] as Record<string, unknown> | null) ?? null;
      return { id: String(r.Id), product: String(rel("Product2")?.Name ?? ""), productCode: (rel("Product2")?.ProductCode as string) ?? null, quantity: (r.Quantity as number) ?? null, unitPrice: (r.UnitPrice as number) ?? null, totalPrice: (r.TotalPrice as number) ?? null, start: (r.ServiceDate as string) ?? null, end: (r.EndDate as string) ?? null, sellingModel: (rel("ProductSellingModel")?.Name as string) ?? null, orderNumber: (rel("Order")?.OrderNumber as string) ?? null };
    }) : [];
    const choices = await billingChoices(ctx.billingClient, needs.filter(n => n.policy).map(n => n.policy!.id));
    return { success: true, needs, orderProducts, ...choices };
  }, "Couldn't load the billing questions");
}

// POST /api/asset-lifecycle/[id]/billing { confirmed: true, policies: [{ productId, policyId }], treatments: [{ orderItemId, treatmentId }] }
// The user's CONFIRMED answers. Each is checked against the org now (eligible policy; Active treatment of that line's policy; the
// product still has no policy) and stored on the transaction; nothing is written to Salesforce here — resuming execution does it.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return lifecycleRoute(req, async (ctx, body) => {
    if (body.confirmed !== true) throw new LifecycleInputError("Confirm the Salesforce updates first (confirmed: true).");
    if (!ctx.billingClient) throw new LifecycleInputError("Not authenticated for billing.");
    const t = await load(ctx, id);
    const needs = t.billingNeeds ?? [];
    const wantP = (Array.isArray(body.policies) ? body.policies : []) as { productId?: unknown; policyId?: unknown }[];
    const wantT = (Array.isArray(body.treatments) ? body.treatments : []) as { orderItemId?: unknown; treatmentId?: unknown }[];
    for (const x of [...wantP.flatMap(p => [p.productId, p.policyId]), ...wantT.flatMap(p => [p.orderItemId, p.treatmentId])]) if (typeof x !== "string" || !ID.test(x)) throw new LifecycleInputError("Every choice must be a Salesforce record Id.");
    const choices = await billingChoices(ctx.billingClient, needs.filter(n => n.policy).map(n => n.policy!.id));
    const field = await discoverAssignmentField(ctx.billingClient);
    if (wantP.length && !field) throw new LifecycleInputError("This org has no Product → Billing Policy field.");
    const policies = [];
    for (const p of wantP) {
      const need = needs.find(n => n.kind === "billing-policy" && n.product?.id === p.productId);
      const pol = choices.policies.find(x => x.id === p.policyId);
      if (!need?.product) throw new LifecycleInputError("That product has no open Billing Policy question.");
      if (!pol?.eligible) throw new LifecycleInputError(`Billing Policy ${pol?.name ?? p.policyId} isn't eligible: ${pol?.reason ?? "not found"}.`);
      const [prod] = await ctx.api.query<Record<string, unknown>>(`SELECT Id, Name, ${field!.name} FROM Product2 WHERE Id = ${soql(String(p.productId))}`);
      if (!prod) throw new LifecycleInputError(`${need.product.name} no longer exists.`);
      if (prod[field!.name]) throw new LifecycleInputError(`${need.product.name} has a Billing Policy now — resume execution to re-read it.`);
      policies.push({ productId: need.product.id, productName: need.product.name, policyId: pol.id, policyName: pol.name, previousPolicyId: null });
    }
    const treatments = [];
    for (const x of wantT) {
      const need = needs.find(n => n.kind === "billing-treatment" && n.orderItemIds.includes(String(x.orderItemId)));
      const tr = choices.treatments.find(c => c.id === x.treatmentId);
      if (!need) throw new LifecycleInputError("That order product has no open Billing Treatment question.");
      if (!tr || !tr.eligible || (need.policy && tr.policyId.slice(0, 15) !== need.policy.id.slice(0, 15))) throw new LifecycleInputError(`That Billing Treatment isn't eligible for ${need.product?.name ?? "the order product"}${tr?.reason ? `: ${tr.reason}` : ""}.`);
      treatments.push({ orderItemId: String(x.orderItemId), productName: need.product?.name ?? "Order product", policyId: need.policy?.id ?? null, treatmentId: tr.id, treatmentName: tr.name });
    }
    if (!policies.length && !treatments.length) throw new LifecycleInputError("Nothing chosen.");
    return { success: true, transaction: await resolveBilling(ctx, id, { policies, treatments }) };
  }, "Couldn't save the billing decisions");
}
