import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { getConnection } from "@/lib/contracts/docusign/connectionStore";
import { sendContractForSignature } from "@/lib/contracts/docusign/envelope";
import { DocuSignError } from "@/lib/contracts/docusign/client";
import type { SignatureRecipient } from "@/lib/contracts/types";

type Params = { params: Promise<{ id: string }> };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENVELOPE_ENDPOINT = "POST /restapi/v2.1/accounts/{accountId}/envelopes";

interface SendBody {
  recipients: SignatureRecipient[];
  contentVersionId: string;
  documentName: string;
  contractNumber: string;
  emailSubject: string;
  emailBody: string;
}

/** Never logs Client Secret, access token, or refresh token — only their presence/expiry as booleans. */
function logSignatureSend(fields: Record<string, string | number | boolean | null>): void {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  console.log(`[SIGNATURE SEND]\n${lines.join("\n")}`);
}

// POST /api/contracts/[id]/signature/send — the ONLY place a real DocuSign
// envelope gets created. Everything else about a signature request
// (recipients, selected document, email template, status/timeline) lives
// client-side in lib/contracts/docusign/localSignatureStore.ts; this route
// is intentionally stateless — it takes the full request from the client,
// downloads the REAL generated Salesforce document, and either returns a
// real envelopeId or a clear, sanitized error. It never marks anything as
// sent itself — the caller does that, and only after this returns success.
//
// `getConnection(orgId)` here, `lib/contracts/docusign/oauth.ts`'s
// `getActiveDocuSignSession` (used by Test Connection and by
// `sendContractForSignature` below), and every other DocuSign route all
// resolve the SAME org's connection through the SAME
// `lib/contracts/docusign/connectionStore.ts` — there is exactly one
// canonical store, anchored on `globalThis` (see that file's doc comment
// for why that specifically matters for this app's dev server).
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: contractId } = await params;
  const orgId = client.instanceUrl;

  let body: SendBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (recipients.length === 0) {
    return NextResponse.json({ error: "Please add at least one recipient." }, { status: 400 });
  }
  const invalidRecipient = recipients.find(r => !r.name?.trim() || !EMAIL_PATTERN.test(r.email ?? ""));
  if (invalidRecipient) {
    return NextResponse.json({ error: "Recipient email is invalid." }, { status: 400 });
  }
  if (!body.contentVersionId?.trim()) {
    return NextResponse.json({ error: "Please select a document." }, { status: 400 });
  }

  const connection = await getConnection(orgId);
  const tokenExpiresAt = connection?.tokenExpiresAt ? new Date(connection.tokenExpiresAt).getTime() : null;
  const accessTokenExpired = tokenExpiresAt != null ? Date.now() >= tokenExpiresAt : null;

  const diagnostics: Record<string, string | number | boolean | null> = {
    "Salesforce Org ID": orgId,
    "DocuSign connection found": !!connection,
    "DocuSign environment": connection?.environment ?? null,
    "DocuSign account ID present": !!connection?.docusignAccountId,
    "Access token present": !!connection?.accessToken,
    "Refresh token present": !!connection?.refreshToken,
    "Access token expired": accessTokenExpired,
    "Selected document ID": body.contentVersionId,
    "Recipient count": recipients.length,
  };

  if (!connection || connection.status === "disconnected") {
    logSignatureSend({ ...diagnostics, "Envelope creation attempted": false, "DocuSign HTTP status": null, "Envelope ID": null });
    return NextResponse.json({ error: "DocuSign is not connected." }, { status: 400 });
  }
  if (connection.status === "reauthorization_required") {
    logSignatureSend({ ...diagnostics, "Envelope creation attempted": false, "DocuSign HTTP status": null, "Envelope ID": null });
    return NextResponse.json({ error: "DocuSign authorization expired." }, { status: 400 });
  }

  try {
    const result = await sendContractForSignature(client, orgId, {
      contentVersionId: body.contentVersionId,
      recipients,
      contractLabel: body.contractNumber || body.documentName || contractId,
      emailSubject: body.emailSubject,
      emailBody: body.emailBody,
    });
    logSignatureSend({ ...diagnostics, "Envelope creation attempted": true, "DocuSign HTTP status": 201, "Envelope ID": result.envelopeId });
    return NextResponse.json({ success: true, envelopeId: result.envelopeId, envelopeStatus: result.envelopeStatus, sentDateTime: result.sentDateTime });
  } catch (err) {
    if (err instanceof DocuSignError) {
      // DocuSign's own errorCode/message describe what's wrong with the request — safe to
      // surface (never our secrets/tokens). accountId/environment are already shown in the
      // Settings UI, not sensitive; the endpoint is a fixed, public DocuSign REST path.
      const docuSignBody = err.body as { errorCode?: string; message?: string } | null;
      const docuSignErrorCode = docuSignBody?.errorCode ?? null;
      const docuSignMessage = docuSignBody?.message ?? err.message;
      logSignatureSend({ ...diagnostics, "Envelope creation attempted": true, "DocuSign HTTP status": err.status, "Envelope ID": null });

      const detail = {
        docuSignStatus: err.status,
        docuSignErrorCode,
        docuSignMessage,
        endpoint: ENVELOPE_ENDPOINT,
        accountId: connection.docusignAccountId,
        environment: connection.environment,
      };
      if (err.status === 401) {
        return NextResponse.json({ error: "DocuSign authorization expired.", ...detail }, { status: 401 });
      }
      return NextResponse.json({ error: "DocuSign rejected the envelope.", ...detail }, { status: 502 });
    }
    logSignatureSend({ ...diagnostics, "Envelope creation attempted": true, "DocuSign HTTP status": null, "Envelope ID": null });
    const message = err instanceof Error ? err.message : "Unable to retrieve the Salesforce document.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
