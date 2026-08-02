import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderFieldSchema } from "@/lib/orders/metadata/orderFields";
import { checkOrderMutability } from "@/lib/orders/metadata/orderStatus";
import type { OrderDetail } from "@/lib/orders/types";

type Params = { params: Promise<{ id: string }> };

// GET /api/orders/[id] — single-record read, including raw lookup Ids so the
// "add more line items" flow can reuse the exact creation-flow component, and
// the current activation-mutability status so the UI can gate line-item controls (§3.9, §4.7).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const schema = await resolveOrderFieldSchema(client);
    const record = await client.getRecord("Order", id);
    const mutability = await checkOrderMutability(client, id);

    const detail: OrderDetail = {
      id,
      orderNumber: (record.OrderNumber as string) ?? null,
      record,
      accountId: schema.accountField ? ((record[schema.accountField.apiName] as string) ?? null) : null,
      pricebookId: schema.pricebookField ? ((record[schema.pricebookField.apiName] as string) ?? null) : null,
      contractId: schema.contractField ? ((record[schema.contractField.apiName] as string) ?? null) : null,
      status: (record.Status as string) ?? null,
      mutability,
    };

    return NextResponse.json({ success: true, order: detail });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load order");
  }
}
