import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { parseImportFormData } from "@/lib/import/fileParsing";

export interface BundleImportParseResponse {
  success: true;
  fileName: string;
  fileSize: number;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  truncated: boolean;
  totalRowsInFile: number;
}

/**
 * POST /api/bundles/import/parse — first step of the Bundle Importer.
 * Delegates to the same shared lib/import/fileParsing module every other
 * bulk importer (Products, Quotes, Contracts, Orders) uses — parsing
 * CSV/XLSX/XLS has nothing bundle-specific about it.
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
    const response: BundleImportParseResponse = { success: true, ...result.data };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to parse the uploaded file");
  }
}
