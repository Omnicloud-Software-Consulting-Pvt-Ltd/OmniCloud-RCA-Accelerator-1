import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { validateContractRows, type ValidateContractRowsResult } from "@/lib/contracts/import/validateRows";
import { CONTRACT_FIELDS, type ContractField } from "@/lib/contracts/import/columnMapping";

export type ContractImportValidateResponse = { success: true } & ValidateContractRowsResult;

interface ValidateRequestBody {
  rows?: Record<string, string>[];
  mapping?: Partial<Record<string, string | null>>;
}

/**
 * POST /api/contracts/import/validate — second step of the bulk Contract
 * importer. Resolves Account/Price Book against the connected Salesforce
 * org, validates every row, and builds the exact ContractFormData each
 * creatable row will later POST (as `{ formData }`) to the existing
 * POST /api/contracts. Read-only — never creates anything.
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

  const validKeys = new Set<string>(CONTRACT_FIELDS.map(f => f.key));
  const mapping = Object.fromEntries(CONTRACT_FIELDS.map(f => [f.key, null])) as Record<ContractField, string | null>;
  if (body.mapping) {
    for (const [key, value] of Object.entries(body.mapping)) {
      if (validKeys.has(key) && typeof value === "string" && value) {
        mapping[key as ContractField] = value;
      }
    }
  }
  if (!mapping.accountName) {
    return NextResponse.json({ error: "Account must be mapped to a column before validating." }, { status: 400 });
  }

  try {
    const result = await validateContractRows(client, rows, mapping);
    const response: ContractImportValidateResponse = { success: true, ...result };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to validate import rows");
  }
}
