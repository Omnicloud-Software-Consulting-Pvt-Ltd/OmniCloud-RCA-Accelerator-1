import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadMergeFieldValuesForContract } from "@/lib/contracts/documents/mergeFields";
import { renderContractPdf } from "@/lib/contracts/documents/pdf";
import { renderContractDocx } from "@/lib/contracts/documents/docx";
import { findUnrecognizedTags } from "@/lib/contracts/documents/pdfTagConverter";
import { createFirstContentVersion, createNextContentVersion } from "@/lib/contracts/documents/contentVersion";
import type { BrandingConfig, CompanySettings } from "@/lib/contracts/types";

type Params = { params: Promise<{ id: string }> };
type Format = "pdf" | "docx";

// POST /api/contracts/[id]/documents/generate — merge Contract fields into a
// template and generate/regenerate a PDF or DOCX, stored as a Salesforce
// ContentVersion (§4.3, §4.4, §Template Actions "Generate PDF"/"Generate
// DOCX"). Pass `contentDocumentId` to regenerate (adds a new version to the
// SAME ContentDocument); omit it for the first generation of a new document.
// Templates live client-side only (bundled built-ins + localStorage), so
// there is no server-side template lookup by id anymore — the caller sends
// the template's own `name`/`bodyHtml`/`branding` (already in memory) plus
// `companySettings` (read from its own localStorage) directly in the body.
// The ContentVersion remains the one authoritative, downloadable copy — no
// local audit-trail row is written anymore (that table has been removed).
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: contractId } = await params;

  let templateName: string,
    bodyHtml: string,
    branding: BrandingConfig,
    companySettings: Partial<CompanySettings> | undefined,
    contentDocumentId: string | undefined,
    format: Format;
  try {
    const body = await req.json();
    templateName = body.templateName;
    bodyHtml = body.bodyHtml;
    branding = body.branding;
    companySettings = body.companySettings;
    contentDocumentId = body.contentDocumentId;
    format = body.format === "docx" ? "docx" : "pdf";
    if (!templateName?.trim()) return NextResponse.json({ error: "templateName is required" }, { status: 400 });
    if (!bodyHtml?.trim()) return NextResponse.json({ error: "bodyHtml is required" }, { status: 400 });
    if (!branding) return NextResponse.json({ error: "branding is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    // §4.1: merge fields resolve from an already-loaded Contract detail, never a fresh ad-hoc query shape.
    const values = await loadMergeFieldValuesForContract(client, contractId, companySettings ?? null);

    const fileBuffer = format === "docx"
      ? await renderContractDocx(bodyHtml, branding, values)
      : await renderContractPdf(bodyHtml, branding, values);
    const base64Data = fileBuffer.toString("base64");
    const titleSuffix = values.ContractNumber !== "—" ? values.ContractNumber : contractId;
    const title = `${templateName} — ${titleSuffix}`;
    const pathOnClient = `${title.replace(/[\\/:*?"<>|]/g, "_")}.${format}`;

    const result = contentDocumentId
      ? await createNextContentVersion(client, { contentDocumentId, title, base64Data, pathOnClient, templateName })
      : await createFirstContentVersion(client, { contractId, title, base64Data, pathOnClient, templateName });

    return NextResponse.json({ success: true, contentVersionId: result.id, unrecognizedTags: findUnrecognizedTags(bodyHtml) });
  } catch (err) {
    return sfErrorResponse(err, "Failed to generate document");
  }
}
