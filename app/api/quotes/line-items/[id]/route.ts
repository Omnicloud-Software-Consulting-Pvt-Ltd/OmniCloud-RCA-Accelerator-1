import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { describeObjectCached, findPicklistFieldByLabel } from "@/lib/salesforce/describe";
import { repriceQuote } from "@/lib/quotes/pricing/reprice";

type Params = { params: Promise<{ id: string }> };

interface UpdateBody {
  quoteId?: string;
  quantity?: number;
  discountPercent?: number;
  unitPrice?: number;
  billingFrequency?: string;
  subscriptionTerm?: number;
}

// PATCH /api/quotes/line-items/[id] — inline edit of an existing line item (§4.8).
// UnitPrice is only ever written directly under ManualPricing; under RevenueCloudPricing
// a price-relevant edit triggers a repricing call instead of a raw field write.
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
    const schema = await resolveQuoteLineItemFieldSchema(client);
    const updates: Record<string, unknown> = {};

    if (body.quantity != null && schema.quantityField) updates[schema.quantityField.apiName] = body.quantity;
    if (body.discountPercent != null && schema.discountField) updates[schema.discountField.apiName] = body.discountPercent;
    if (body.billingFrequency != null && schema.billingFrequencyField) {
      // §Billing Frequency VALUE MAPPING: never write a client-supplied
      // value straight through — validate it against QuoteLineItem.Billing
      // Frequency's CURRENT active picklist values first (Describe is the
      // only source of truth), and fail here rather than let Salesforce
      // reject an internal code / stale value.
      const qliDescribe = await describeObjectCached(client, "QuoteLineItem");
      const picklist = findPicklistFieldByLabel(qliDescribe, "BillingFrequency", /^billing frequency$/i);
      if (picklist && !picklist.activeOptions.some(o => o.value === body.billingFrequency)) {
        return NextResponse.json(
          {
            error: `"${body.billingFrequency}" is not one of QuoteLineItem.BillingFrequency's currently active picklist values (${picklist.activeOptions.map(o => o.value).join(", ")}).`,
            code: "BILLING_FREQUENCY_INVALID_VALUE",
          },
          { status: 422 },
        );
      }
      updates[schema.billingFrequencyField.apiName] = body.billingFrequency;
    }
    if (body.subscriptionTerm != null && schema.subscriptionTermField) updates[schema.subscriptionTermField.apiName] = body.subscriptionTerm;

    const priceEditRequested = body.unitPrice != null;
    if (priceEditRequested && schema.pricingModel === "ManualPricing" && schema.unitPriceField) {
      updates[schema.unitPriceField.apiName] = body.unitPrice;
    }

    if (Object.keys(updates).length > 0) {
      await client.updateRecord("QuoteLineItem", id, updates);
    }

    // §Discount pricing fix: a Discount%-only edit (no unitPrice in the
    // request — this is exactly what QuoteWorkspace.tsx's inline "Disc %"
    // field sends) previously never triggered repricing at all, since this
    // gate only checked `priceEditRequested` (unitPrice != null). On a
    // RevenueCloudPricing org that meant the just-written Discount value
    // sat there unpriced — Salesforce's engine was never asked to compute
    // NetUnitPrice/NetTotalPrice from it, so nothing on the record ever
    // reflected the new discount.
    const discountEditRequested = body.discountPercent != null;
    let repricing = null;
    if ((priceEditRequested || discountEditRequested) && schema.pricingModel === "RevenueCloudPricing" && body.quoteId) {
      repricing = await repriceQuote(client, body.quoteId);
    }

    return NextResponse.json({ success: true, repricing });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update line item");
  }
}
