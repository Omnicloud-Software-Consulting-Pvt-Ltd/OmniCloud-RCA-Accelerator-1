import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderItemFieldSchema } from "@/lib/orders/metadata/lineItemFields";
import { checkOrderMutability } from "@/lib/orders/metadata/orderStatus";
import { repriceOrder } from "@/lib/orders/pricing/reprice";

type Params = { params: Promise<{ id: string }> };

interface UpdateBody {
  orderId?: string;
  quantity?: number;
  discountPercent?: number;
  unitPrice?: number;
  billingFrequency?: string;
  subscriptionTerm?: number;
}

// PATCH /api/orders/line-items/[id] — inline edit of an existing order line item (§4.8).
// Re-checks Order mutability server-side first (§4.7) — a client-side gate is only a UX
// convenience, never trusted on its own. UnitPrice is only ever written directly under
// ManualPricing; under RevenueCloudPricing a price-relevant edit triggers a reprice instead.
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let body: UpdateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    if (body.orderId) {
      const mutability = await checkOrderMutability(client, body.orderId);
      if (mutability.status === "blocked") {
        return NextResponse.json({ error: `This Order is no longer editable: ${mutability.reason}` }, { status: 422 });
      }
    }

    const schema = await resolveOrderItemFieldSchema(client);
    const updates: Record<string, unknown> = {};

    if (body.quantity != null && schema.quantityField) updates[schema.quantityField.apiName] = body.quantity;
    if (body.discountPercent != null && schema.discountField) updates[schema.discountField.apiName] = body.discountPercent;
    if (body.billingFrequency != null && schema.billingFrequencyField) updates[schema.billingFrequencyField.apiName] = body.billingFrequency;
    if (body.subscriptionTerm != null && schema.subscriptionTermField) updates[schema.subscriptionTermField.apiName] = body.subscriptionTerm;

    const priceEditRequested = body.unitPrice != null;
    if (priceEditRequested && schema.pricingModel === "ManualPricing" && schema.unitPriceField) {
      updates[schema.unitPriceField.apiName] = body.unitPrice;
    }

    if (Object.keys(updates).length > 0) {
      await client.updateRecord("OrderItem", id, updates);
    }

    let repricing = null;
    if (priceEditRequested && schema.pricingModel === "RevenueCloudPricing" && body.orderId) {
      repricing = await repriceOrder(client, body.orderId);
    }

    return NextResponse.json({ success: true, repricing });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update order line item");
  }
}
