import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { convertDocxToHtml, isConvertibleUpload } from "@/lib/contracts/documents/docxImport";

// POST /api/contracts/templates/upload — a STATELESS conversion helper only
// (§Upload Template "Automatically convert into editable templates where
// possible"). This route persists nothing — no database, no file storage.
// DOCX/HTML in multipart/form-data (`file`, optional `name`) comes back as
// `{ html }`; the caller (TemplateStudio, client-side) is the one that
// actually saves the result, into localStorage via localTemplateStore.
// PDF (and any DOCX mammoth can't parse) comes back with `html: null` —
// there's no server-side storage left to fall back to, so the caller
// creates a local placeholder template noting the original filename instead.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    const name = ((form.get("name") as string) || file.name || "Uploaded Template").trim();
    const mime = file.type || "application/octet-stream";

    const arrayBuffer = await file.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    let html: string | null = null;
    let warnings: string[] = [];
    if (isConvertibleUpload(mime, file.name)) {
      if (mime === "text/html" || /\.html?$/i.test(file.name)) {
        html = data.toString("utf8");
      } else {
        try {
          const converted = await convertDocxToHtml(data);
          html = converted.html;
          warnings = converted.warnings;
        } catch (err) {
          warnings = [`Could not convert this DOCX automatically: ${err instanceof Error ? err.message : "unknown error"}.`];
        }
      }
    }

    return NextResponse.json({ success: true, name, filename: file.name, html, warnings });
  } catch (err) {
    return sfErrorResponse(err, "Failed to process the uploaded file");
  }
}
