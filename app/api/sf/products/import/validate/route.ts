import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateImportRows, type ValidateRowsResult } from "@/lib/products/import/validateRows";
import { CANONICAL_FIELDS, type CanonicalField } from "@/lib/products/import/columnMapping";

export type ProductImportValidateResponse = { success: true } & ValidateRowsResult;

interface ValidateRequestBody {
  rows?: Record<string, string>[];
  mapping?: Partial<Record<string, string | null>>;
}

/**
 * POST /api/sf/products/import/validate — second step of the bulk Product
 * importer. Given the parsed rows + the user-confirmed column mapping,
 * resolves Selling Model/Catalog/Category against the connected Salesforce
 * org, validates every row, and builds the exact ProductPayload each
 * creatable row will later POST to the existing /api/sf/products/save —
 * this route only reads from Salesforce, it never creates anything.
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

  const validKeys = new Set<string>(CANONICAL_FIELDS.map(f => f.key));
  const mapping = Object.fromEntries(CANONICAL_FIELDS.map(f => [f.key, null])) as Record<CanonicalField, string | null>;
  if (body.mapping) {
    for (const [key, value] of Object.entries(body.mapping)) {
      if (validKeys.has(key) && typeof value === "string" && value) {
        mapping[key as CanonicalField] = value;
      }
    }
  }
  if (!mapping.name) {
    return NextResponse.json({ error: "Product Name must be mapped to a column before validating." }, { status: 400 });
  }

  try {
    const result = await validateImportRows(client, rows, mapping);
    const response: ProductImportValidateResponse = { success: true, ...result };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate import rows");
  }
}
