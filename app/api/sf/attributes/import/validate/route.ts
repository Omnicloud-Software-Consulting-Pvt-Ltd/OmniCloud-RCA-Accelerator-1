import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateAttributeImportRows, type ValidateAttributeImportResult } from "@/lib/attributes/import/validateRows";
import { ATTRIBUTE_FIELDS, type AttributeCanonicalField } from "@/lib/attributes/import/columnMapping";

export type AttributeImportValidateResponse = { success: true } & ValidateAttributeImportResult;

interface ValidateRequestBody {
  rows?: Record<string, string>[];
  mapping?: Partial<Record<string, string | null>>;
}

/**
 * POST /api/sf/attributes/import/validate — resolves every row's Product
 * (reusing lib/attributes/server/productValidation.ts's validateProductExists,
 * the same exact-match-first Product resolution RCAAttributeStudio's own
 * Product Not Found flow uses) and every row's Data Type/Values against the
 * connected Salesforce org, groups rows by Product Name, and builds the
 * exact ParsedRCAData payload POST /api/sf/attributes/execute-batch already
 * accepts for each group. Read-only — never creates anything.
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

  const validKeys = new Set<string>(ATTRIBUTE_FIELDS.map(f => f.key));
  const mapping = Object.fromEntries(ATTRIBUTE_FIELDS.map(f => [f.key, null])) as Record<AttributeCanonicalField, string | null>;
  if (body.mapping) {
    for (const [key, value] of Object.entries(body.mapping)) {
      if (validKeys.has(key) && typeof value === "string" && value) {
        mapping[key as AttributeCanonicalField] = value;
      }
    }
  }
  if (!mapping.productName || !mapping.attributeName || !mapping.dataType) {
    return NextResponse.json({ error: "Product Name, Attribute Name, and Data Type must all be mapped to a column before validating." }, { status: 400 });
  }

  try {
    const result = await validateAttributeImportRows(client, rows, mapping);
    const response: AttributeImportValidateResponse = { success: true, ...result };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate import rows");
  }
}
