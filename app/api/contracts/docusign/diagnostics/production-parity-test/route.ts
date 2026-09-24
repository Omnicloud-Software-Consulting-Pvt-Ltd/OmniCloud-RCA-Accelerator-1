import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { soqlEscape, SalesforceError } from "@/lib/salesforce/client";
import { sendProductionParityTestEnvelope, getEnvelopeDiagnostics, normalizeRecipientEmail, EnvelopeInvariantError } from "@/lib/contracts/docusign/envelope";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { DocuSignError } from "@/lib/contracts/docusign/client";

interface ContentVersionVerifyRow {
  Id: string;
  ContentDocumentId: string;
  Title: string;
  FileExtension: string;
  ContentSize: number;
  IsLatest: boolean;
}

/** Sanitized layer-by-layer trace — never logs the access token. Every hop is logged with the SAME id string so a value silently changing between layers is provable from logs alone. */
function logParityTrace(fields: Record<string, string | number | boolean | null>): void {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  console.log(`[PRODUCTION PARITY TEST]\n${lines.join("\n")}`);
}

// POST /api/contracts/docusign/diagnostics/production-parity-test — "Test C":
// diagnostic-only, but sends through the EXACT SAME createAndSendEnvelope()
// production uses, with a REAL Salesforce Contract ContentVersion instead of
// the synthetic control-test PDF. Never writes to localSignatureStore,
// signatureStatusStore, or any Contract field — this cannot lock or advance
// a real signature request. Immediately re-queries the envelope from
// DocuSign afterward so the full request/response is visible in one call.
//
// Verifies the ContentVersion exists in THIS org/session BEFORE attempting
// the download+send — a SELECT Id, ContentDocumentId, Title, FileExtension,
// ContentSize, IsLatest FROM ContentVersion WHERE Id = '...' lookup, scoped
// to this diagnostic route only (never added to the real
// sendContractForSignature()/downloadContentVersion() production path). If
// zero rows come back, this org/session cannot see that ContentVersion —
// e.g. it was copied from a different org, or the record was deleted — and
// that is reported explicitly instead of falling through to a generic
// download failure.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const orgId = client.instanceUrl;

  let contentVersionId: string, recipientName: string, recipientEmail: string, contractLabel: string | undefined;
  try {
    ({ contentVersionId, recipientName, recipientEmail, contractLabel } = await req.json());
    if (!contentVersionId?.trim() || !recipientName?.trim() || !recipientEmail?.trim()) {
      return NextResponse.json({ error: "contentVersionId, recipientName, and recipientEmail are all required.", code: "DOCUSIGN_RECIPIENT_CONFIGURATION_FAILED" }, { status: 400 });
    }
    if (!EMAIL_PATTERN.test(normalizeRecipientEmail(recipientEmail))) {
      return NextResponse.json({ error: "recipientEmail is not a valid email address.", code: "DOCUSIGN_RECIPIENT_CONFIGURATION_FAILED" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const trimmedId = contentVersionId.trim();
  logParityTrace({
    "ContentVersion ID received by API route": trimmedId,
    "Salesforce instanceUrl": client.instanceUrl,
    "Salesforce API version": client.apiVersion,
  });

  let verified: ContentVersionVerifyRow;
  try {
    const verifyResult = await client.query<ContentVersionVerifyRow>(
      `SELECT Id, ContentDocumentId, Title, FileExtension, ContentSize, IsLatest FROM ContentVersion WHERE Id = '${soqlEscape(trimmedId)}'`,
    );
    logParityTrace({
      "Verify query totalSize": verifyResult.totalSize,
      "Verify query record found": verifyResult.records.length > 0,
    });
    if (verifyResult.records.length === 0) {
      return NextResponse.json({
        error: `ContentVersion ${trimmedId} does not exist (or is not visible) in the currently authenticated Salesforce org (${client.instanceUrl}). Verify this is a ContentVersion Id (not a ContentDocument Id — check the Documents tab's "CV:" line, not "CD:"), and that you're connected to the same org this Contract lives in.`,
        code: "SALESFORCE_CONTENT_VERSION_NOT_FOUND",
        contentVersionId: trimmedId,
        instanceUrl: client.instanceUrl,
      }, { status: 404 });
    }
    verified = verifyResult.records[0];
    logParityTrace({
      "Verified Title": verified.Title,
      "Verified FileExtension": verified.FileExtension,
      "Verified ContentSize": verified.ContentSize,
      "Verified IsLatest": verified.IsLatest,
      "Verified ContentDocumentId": verified.ContentDocumentId,
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      return NextResponse.json({ error: err.message, code: "SALESFORCE_CONTENT_VERSION_NOT_FOUND", salesforceHttpStatus: err.status, salesforceErrorCode: err.errorCode ?? null, instanceUrl: client.instanceUrl }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to verify the ContentVersion.", code: "SALESFORCE_CONTENT_VERSION_NOT_FOUND" }, { status: 502 });
  }

  try {
    logParityTrace({ "ContentVersion ID passed to sendProductionParityTestEnvelope": trimmedId });
    const send = await sendProductionParityTestEnvelope(client, orgId, {
      contentVersionId: trimmedId,
      recipientName: recipientName.trim(),
      recipientEmail: recipientEmail.trim(),
      contractLabel: contractLabel?.trim() || "Production Parity Test",
    });
    const diagnostics = await getEnvelopeDiagnostics(orgId, send.envelopeId);
    return NextResponse.json({ success: true, verified, send, diagnostics });
  } catch (err) {
    if (err instanceof EnvelopeInvariantError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: "DocuSign rejected the test envelope.", code: "DOCUSIGN_ENVELOPE_CREATE_FAILED", docuSignStatus: err.status, docuSignErrorCode: body?.errorCode ?? null, docuSignMessage: body?.message ?? err.message }, { status: 502 });
    }
    if (err instanceof SalesforceError) {
      logParityTrace({ "Salesforce HTTP status on download": err.status, "Salesforce errorCode": err.errorCode ?? "(none)", "Salesforce message": err.message });
      return NextResponse.json({ error: err.message, code: "SALESFORCE_DOCUMENT_DOWNLOAD_FAILED", salesforceHttpStatus: err.status, salesforceErrorCode: err.errorCode ?? null, instanceUrl: client.instanceUrl }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to send the production parity test envelope.", code: "SALESFORCE_DOCUMENT_DOWNLOAD_FAILED" }, { status: 502 });
  }
}
