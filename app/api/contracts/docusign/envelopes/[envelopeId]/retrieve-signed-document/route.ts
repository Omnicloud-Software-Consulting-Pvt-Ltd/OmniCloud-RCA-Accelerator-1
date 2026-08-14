import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { getTrackedEnvelope, updateTrackedEnvelope } from "@/lib/contracts/docusign/signatureStatusStore";
import { retrieveSignedDocument } from "@/lib/contracts/docusign/envelope";
import { createFirstContentVersion } from "@/lib/contracts/documents/contentVersion";
import { DocuSignError } from "@/lib/contracts/docusign/client";

type Params = { params: Promise<{ envelopeId: string }> };

// POST /api/contracts/docusign/envelopes/[envelopeId]/retrieve-signed-document
// (§Phase 9) — wires envelope.ts's previously-orphaned retrieveSignedDocument()
// (defined, but never called from any route before this) to a real endpoint.
// Only usable once the tracked envelope has reached "Completed" (call
// Refresh DocuSign Status first). Uploads the combined signed PDF as a NEW,
// SEPARATE ContentDocument linked to the Contract — never overwrites or
// versions over the original unsigned document, which stays exactly as it
// was, visible as its own entry in the Documents list.
//
// Idempotent: once signedContentVersionId is recorded, a repeat call returns
// the existing Id instead of re-fetching/re-uploading — clicking twice
// cannot create a duplicate signed copy.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const orgId = client.instanceUrl;
  const { envelopeId } = await params;

  const tracked = await getTrackedEnvelope(envelopeId);
  if (!tracked || tracked.orgId !== orgId) {
    return NextResponse.json({ error: "This DocuSign envelope is not tracked by this server.", code: "DOCUSIGN_ENVELOPE_NOT_TRACKED" }, { status: 404 });
  }

  if (tracked.signedContentVersionId) {
    return NextResponse.json({ success: true, contentVersionId: tracked.signedContentVersionId, alreadyRetrieved: true });
  }

  if (tracked.stage !== "Completed") {
    return NextResponse.json({ error: "The envelope has not reached Completed yet — use Refresh DocuSign Status first.", code: "DOCUSIGN_ENVELOPE_NOT_COMPLETED" }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = await retrieveSignedDocument(orgId, envelopeId);
  } catch (err) {
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: "Failed to fetch the signed document from DocuSign.", code: "DOCUSIGN_SIGNED_DOCUMENT_FETCH_FAILED", docuSignStatus: err.status, docuSignErrorCode: body?.errorCode ?? null, docuSignMessage: body?.message ?? err.message }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to fetch the signed document from DocuSign.", code: "DOCUSIGN_SIGNED_DOCUMENT_FETCH_FAILED" }, { status: 502 });
  }

  const signedTitle = `${tracked.documentTitle} - Signed`;
  const sanitizedBaseName = tracked.documentTitle.replace(/[\\/:*?"<>|]/g, "").trim() || "Document";
  const pathOnClient = `${sanitizedBaseName}-Signed.pdf`;

  try {
    const result = await createFirstContentVersion(client, {
      contractId: tracked.contractId,
      title: signedTitle,
      base64Data: buffer.toString("base64"),
      pathOnClient,
      templateName: "DocuSign Signed Document",
    });
    await updateTrackedEnvelope(envelopeId, { signedContentVersionId: result.id });
    return NextResponse.json({ success: true, contentVersionId: result.id, alreadyRetrieved: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to upload the signed document to Salesforce.";
    return NextResponse.json({ error: message, code: "SALESFORCE_SIGNED_DOCUMENT_UPLOAD_FAILED" }, { status: 502 });
  }
}
