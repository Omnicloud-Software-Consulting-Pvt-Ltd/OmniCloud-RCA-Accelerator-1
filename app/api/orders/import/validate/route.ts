import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateOrderRows, type ValidateOrderRowsResult } from "@/lib/orders/import/validateRows";
import { ORDER_FIELDS, type OrderField } from "@/lib/orders/import/columnMapping";

export type OrderImportValidateResponse = { success: true } & ValidateOrderRowsResult;

interface ValidateRequestBody {
  rows?: Record<string, string>[];
  mapping?: Partial<Record<string, string | null>>;
}

/**
 * POST /api/orders/import/validate — resolves Account/Price Book/Contract/
 * Quote and every line item's Product against the connected Salesforce org
 * (reusing lib/quotes/quote/reference.ts + lib/quotes/catalog/search.ts —
 * the same helpers the manual Order/Add Line Items UI already uses),
 * groups rows into Order header + line items by the mapped "Order Number"
 * column, and builds the exact OrderFormData + QuoteLineItemDraft[] each
 * creatable group will later POST to the existing POST /api/orders and
 * POST /api/orders/[id]/line-items. Read-only — never creates anything.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let body: ValidateRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "No rows to validate." }, { status: 400 });
  }
  if (rows.length > 1000) {
    return NextResponse.json({ error: "Too many rows — maximum 1000 per import." }, { status: 400 });
  }

  const validKeys = new Set<string>(ORDER_FIELDS.map(f => f.key));
  const mapping = Object.fromEntries(ORDER_FIELDS.map(f => [f.key, null])) as Record<OrderField, string | null>;
  if (body.mapping) {
    for (const [key, value] of Object.entries(body.mapping)) {
      if (validKeys.has(key) && typeof value === "string" && value) {
        mapping[key as OrderField] = value;
      }
    }
  }
  if (!mapping.accountName || !mapping.pricebookName) {
    return NextResponse.json({ error: "Account and Price Book must both be mapped to a column before validating." }, { status: 400 });
  }

  try {
    const result = await validateOrderRows(client, rows, mapping);
    const response: OrderImportValidateResponse = { success: true, ...result };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate import rows");
  }
}
