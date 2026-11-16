import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderFieldSchema } from "@/lib/orders/metadata/orderFields";
import { checkOrderMutability } from "@/lib/orders/metadata/orderStatus";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { billingDetailsPayload, isSalesforceId, validateBillingDetails, withGeographyCodes, type BillingFieldErrors } from "@/lib/orders/order/billingDetails";
import { loadTaxGeoFacts } from "@/lib/tax/server/orderItemTax";
import { verifyBillToContact } from "@/lib/orders/order/billToContact";
import { resolveRecordDisplay } from "@/lib/salesforce/recordReferences";
import type { OrderDetail, OrderFormData } from "@/lib/orders/types";

type Params = { params: Promise<{ id: string }> };

// GET /api/orders/[id] — single-record read, including raw lookup Ids so the
// "add more line items" flow can reuse the exact creation-flow component, and
// the current activation-mutability status so the UI can gate line-item controls (§3.9, §4.7).
// Lookup display names are resolved alongside (recordReferences.ts) — `record` itself keeps the raw Ids.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const schema = await resolveOrderFieldSchema(client);
    const record = await client.getRecord("Order", id);
    const [mutability, resolution] = await Promise.all([
      checkOrderMutability(client, id),
      resolveRecordDisplay(client, "Order", id, record),
    ]);

    const detail: OrderDetail = {
      ...resolution,
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

// PATCH /api/orders/[id] — update ONLY the Order's Bill To Contact and Billing/Shipping Address. Used when the
// user goes back from Order Items / Preview and changes just those details, so the already-created Order is
// corrected in place instead of a second Order being created. Same validation as create; the Contact is
// re-verified against the order's own Account in Salesforce.
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;
  if (!isSalesforceId(id)) return NextResponse.json({ error: "Invalid Order Id" }, { status: 400 });

  let formData: Pick<OrderFormData, "billToContactId" | "billingAddress" | "shippingAddress">;
  try {
    ({ formData } = await req.json());
    if (!formData || typeof formData !== "object") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const schema = await resolveOrderFieldSchema(client);
    const fieldErrors: BillingFieldErrors = validateBillingDetails(formData, schema, { required: true });
    if (!fieldErrors.billToContact && formData.billToContactId && schema.billToContactField) {
      const record = schema.accountField ? await client.getRecord("Order", id, [schema.accountField.apiName]) : null;
      const accountId = record && schema.accountField ? ((record[schema.accountField.apiName] as string) ?? null) : null;
      const check = await verifyBillToContact(client, formData.billToContactId, accountId);
      if (!check.ok) fieldErrors.billToContact = check.error;
    }
    if (Object.keys(fieldErrors).length) {
      return NextResponse.json({ error: "Fix the highlighted billing details before updating the order.", code: "BILLING_DETAILS_INVALID", fieldErrors }, { status: 400 });
    }

    const payload = billingDetailsPayload(schema, withGeographyCodes(formData, await loadTaxGeoFacts(client).catch(() => null)), { forUpdate: true });
    const describe = await describeObjectCached(client, "Order");
    const notUpdateable = Object.keys(payload).filter(name => !describe.fields.find(f => f.name === name)?.updateable);
    if (notUpdateable.length) {
      return NextResponse.json({ error: `This org doesn't allow updating ${notUpdateable.join(", ")} on Order.`, code: "FIELD_UNAVAILABLE" }, { status: 422 });
    }
    if (Object.keys(payload).length) await client.updateRecord("Order", id, payload);
    return NextResponse.json({ success: true, id, payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update the order's billing details");
  }
}
