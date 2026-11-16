import type { NextRequest } from "next/server";
import { setOrderBillingDetails, type BillingAddress } from "@/lib/billing/server/orderBilling";
import { orderBillingMutation, tokenOf } from "@/lib/billing/server/orderBillingRoute";

type Params = { params: Promise<{ id: string }> };

// POST /api/billing/orders/[id]/bill-to — { contactId?, address?, shippingAddress? ({street, city, state, postalCode, country}), stateToken }.
// Sets the order's billing details that Salesforce's billing schedule action requires: Order.BillToContactId (only a
// Contact of the order's Account, validated server-side) and the Order billing and shipping addresses.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return orderBillingMutation(req, (client, body) => setOrderBillingDetails(client, id, {
    contactId: typeof body.contactId === "string" ? body.contactId : null,
    address: body.address && typeof body.address === "object" ? (body.address as Partial<BillingAddress>) : null,
    shippingAddress: body.shippingAddress && typeof body.shippingAddress === "object" ? (body.shippingAddress as Partial<BillingAddress>) : null,
  }, tokenOf(body)), "Failed to set the order's billing details");
}
