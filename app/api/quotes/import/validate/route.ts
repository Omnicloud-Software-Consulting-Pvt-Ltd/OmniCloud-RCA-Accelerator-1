import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateQuoteRows, type ValidateQuoteRowsResult } from "@/lib/quotes/import/validateRows";
import { QUOTE_FIELDS, type QuoteField } from "@/lib/quotes/import/columnMapping";

export type QuoteImportValidateResponse = { success: true } & ValidateQuoteRowsResult;

interface ValidateRequestBody {
  rows?: Record<string, string>[];
  mapping?: Partial<Record<string, string | null>>;
}

/**
 * POST /api/quotes/import/validate — resolves Account/Opportunity/Price
 * Book and every line item's Product against the connected Salesforce org
 * (reusing lib/quotes/quote/reference.ts + lib/quotes/catalog/search.ts —
 * the same helpers the manual Quote/Add Line Items UI already uses),
 * groups rows into Quote header + line items by the mapped "Quote Name"
 * column, and builds the exact QuoteFormData + QuoteLineItemDraft[] each
 * creatable group will later POST to the existing POST /api/quotes and
 * POST /api/quotes/[id]/line-items. Read-only — never creates anything.
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

  const validKeys = new Set<string>(QUOTE_FIELDS.map(f => f.key));
  const mapping = Object.fromEntries(QUOTE_FIELDS.map(f => [f.key, null])) as Record<QuoteField, string | null>;
  if (body.mapping) {
    for (const [key, value] of Object.entries(body.mapping)) {
      if (validKeys.has(key) && typeof value === "string" && value) {
        mapping[key as QuoteField] = value;
      }
    }
  }
  if (!mapping.name) {
    return NextResponse.json({ error: "Quote Name must be mapped to a column before validating." }, { status: 400 });
  }

  try {
    const result = await validateQuoteRows(client, rows, mapping);
    const response: QuoteImportValidateResponse = { success: true, ...result };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate import rows");
  }
}
