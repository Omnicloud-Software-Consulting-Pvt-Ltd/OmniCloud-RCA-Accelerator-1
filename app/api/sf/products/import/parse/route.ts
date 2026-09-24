import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { parseImportFormData } from "@/lib/import/fileParsing";

export interface ProductImportParseResponse {
  success: true;
  fileName: string;
  fileSize: number;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  /** True if the file had more than the max row cap — only the first N rows were kept. */
  truncated: boolean;
  totalRowsInFile: number;
}

/**
 * POST /api/sf/products/import/parse — first step of the bulk Product
 * importer. Delegates the actual CSV/XLSX/XLS parsing to the shared
 * lib/import/fileParsing module (used by every bulk importer — Products,
 * Quotes, Contracts, Orders) so parsing is written once; this route's own
 * job is just the request/response shape Product Import's client already
 * expects. Does not touch Salesforce — that only happens in
 * /api/sf/products/import/validate and the existing /api/sf/products/save.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const form = await req.formData();
    const result = await parseImportFormData(form);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const response: ProductImportParseResponse = { success: true, ...result.data };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to parse the uploaded file");
  }
}
