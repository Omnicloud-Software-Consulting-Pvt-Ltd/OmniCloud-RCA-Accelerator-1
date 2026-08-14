import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { parseImportFormData } from "@/lib/import/fileParsing";

export interface ImportParseResponse {
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
 * POST /api/import/parse — shared file-parsing step for the Quote/Contract/
 * Order bulk importers (Products keeps its own /api/sf/products/import/parse
 * route, unchanged, though it now delegates to the same lib/import/fileParsing
 * module under the hood). Module-agnostic: it just turns a CSV/XLSX/XLS
 * upload into headers + string rows. Column meaning and Salesforce
 * resolution are handled by each module's own .../import/validate route.
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
    const response: ImportParseResponse = { success: true, ...result.data };
    return NextResponse.json(response);
  } catch (err) {
    return sfErrorResponse(err, "Failed to parse the uploaded file");
  }
}
