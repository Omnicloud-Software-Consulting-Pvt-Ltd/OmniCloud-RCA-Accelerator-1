import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { soqlEscape } from "@/lib/salesforce/client";
import { getConnection } from "@/lib/contracts/docusign/connectionStore";
import { sendEmbeddedSigningTestEnvelope, normalizeRecipientEmail, EnvelopeInvariantError } from "@/lib/contracts/docusign/envelope";
import { DocuSignError } from "@/lib/contracts/docusign/client";
import { resolvePublicAppUrl } from "@/lib/contracts/docusign/publicAppUrl";

type Params = { params: Promise<{ id: string }> };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SendTestLinkBody {
  contentVersionId: string;
  contractNumber: string;
  recipientName: string;
  recipientEmail: string;
  emailSubject?: string;
  emailBody?: string;
}

// POST /api/contracts/[id]/signature/send-test-link — "Open Email & Send
// Signing Link" test/delivery option. Deliberately SEPARATE from
// /api/contracts/[id]/signature/send (the real Send-for-Signature route) —
// creates its OWN new envelope with one captive/clientUserId recipient (see
// envelope.ts's sendEmbeddedSigningTestEnvelope) and returns a stable,
// reusable link this app itself hosts, instead of relying on DocuSign's own
// notification email. Never marks anything in localSignatureStore as sent —
// this flow has no concept of "Sent" status on the document's normal
// signature request, by design, so it can never block or interfere with a
// real Send for Signature on the same document.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: contractId } = await params;
  const orgId = client.instanceUrl;

  let body: SendTestLinkBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.recipientName?.trim() || !EMAIL_PATTERN.test(normalizeRecipientEmail(body.recipientEmail ?? ""))) {
    return NextResponse.json({ error: "A recipient name and valid email are required.", code: "DOCUSIGN_RECIPIENT_CONFIGURATION_FAILED" }, { status: 400 });
  }
  if (!body.contentVersionId?.trim()) {
    return NextResponse.json({ error: "Please select a document.", code: "DOCUSIGN_RECIPIENT_CONFIGURATION_FAILED" }, { status: 400 });
  }

  const connection = await getConnection(orgId);
  if (!connection || connection.status === "disconnected") {
    return NextResponse.json({ error: "DocuSign is not connected.", code: "DOCUSIGN_NOT_CONNECTED" }, { status: 400 });
  }
  if (connection.status === "reauthorization_required") {
    return NextResponse.json({ error: "DocuSign authorization expired.", code: "DOCUSIGN_OAUTH_FAILED" }, { status: 400 });
  }

  // Same ownership check the real send route applies (§Phase 4/7 there) —
  // an arbitrary browser-supplied ContentVersion Id is never trusted just
  // because it resolves to *some* document somewhere.
  try {
    const verify = await client.query<{ Id: string; ContentDocumentId: string }>(
      `SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id = '${soqlEscape(body.contentVersionId.trim())}'`,
    );
    if (verify.records.length === 0) {
      return NextResponse.json({
        error: "The selected Salesforce document is no longer available in the current Salesforce org. Regenerate or select another document.",
        code: "SALESFORCE_CONTENT_VERSION_NOT_FOUND",
      }, { status: 404 });
    }
    const contentDocumentId = verify.records[0].ContentDocumentId;
    const link = await client.query<{ Id: string }>(
      `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${soqlEscape(contractId)}' AND ContentDocumentId = '${soqlEscape(contentDocumentId)}'`,
    );
    if (link.records.length === 0) {
      return NextResponse.json({ error: "The selected document does not belong to this Contract.", code: "SALESFORCE_CONTENT_VERSION_NOT_LINKED_TO_CONTRACT" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not verify the selected Salesforce document.";
    return NextResponse.json({ error: message, code: "SALESFORCE_CONTENT_VERSION_NOT_FOUND" }, { status: 502 });
  }

  // The signing link is emailed to a DIFFERENT person on a DIFFERENT
  // machine, unlike the DocuSign OAuth redirect_uri (same browser, same
  // request) — so the request's own origin is only a fallback here, never
  // trusted blindly. See publicAppUrl.ts's doc comment for why.
  const publicAppUrl = resolvePublicAppUrl(req.nextUrl.origin);

  try {
    const result = await sendEmbeddedSigningTestEnvelope(client, orgId, {
      contractId,
      contentVersionId: body.contentVersionId,
      recipientName: body.recipientName,
      recipientEmail: body.recipientEmail,
      contractLabel: body.contractNumber || contractId,
      appOrigin: publicAppUrl.baseUrl,
      emailSubject: body.emailSubject,
      emailBody: body.emailBody,
    });
    return NextResponse.json({
      success: true,
      ...result,
      isLocalhostSigningLink: publicAppUrl.isLocalhost,
      publicAppUrlSource: publicAppUrl.source,
    });
  } catch (err) {
    if (err instanceof EnvelopeInvariantError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DocuSignError) {
      const docuSignBody = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({
        error: "DocuSign rejected the test envelope.",
        code: "DOCUSIGN_ENVELOPE_CREATE_FAILED",
        docuSignErrorCode: docuSignBody?.errorCode ?? null,
        docuSignMessage: docuSignBody?.message ?? err.message,
      }, { status: err.status === 401 ? 401 : 502 });
    }
    const message = err instanceof Error ? err.message : "Unable to create the test signing link.";
    return NextResponse.json({ error: message, code: "SALESFORCE_DOCUMENT_DOWNLOAD_FAILED" }, { status: 502 });
  }
}
