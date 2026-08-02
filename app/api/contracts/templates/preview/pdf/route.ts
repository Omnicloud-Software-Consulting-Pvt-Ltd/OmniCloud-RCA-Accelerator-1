import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { renderContractPdf } from "@/lib/contracts/documents/pdf";
import type { BrandingConfig, MergeFieldValues } from "@/lib/contracts/types";

// POST /api/contracts/templates/preview/pdf — a real, rendered PDF using
// whatever merge values the caller already has in memory (the real Contract's
// values once a Contract is open, since @react-pdf/renderer needs a Node
// server and can't run client-side like the live HTML preview does). This
// route is a pure rendering utility — it never resolves merge values itself,
// so PDF preview and the live HTML preview can never drift on data.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let bodyHtml: string, branding: BrandingConfig, values: MergeFieldValues;
  try {
    ({ bodyHtml, branding, values } = await req.json());
    if (!bodyHtml?.trim()) return NextResponse.json({ error: "bodyHtml is required" }, { status: 400 });
    if (!values) return NextResponse.json({ error: "values is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const pdfBuffer = await renderContractPdf(bodyHtml, branding, values);
    return NextResponse.json({ success: true, pdfBase64: pdfBuffer.toString("base64") });
  } catch (err) {
    return sfErrorResponse(err, "Failed to render PDF preview");
  }
}
