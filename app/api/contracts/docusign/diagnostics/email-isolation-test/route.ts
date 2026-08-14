import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { sendEmailIsolationTestEnvelope, normalizeRecipientEmail, EnvelopeInvariantError } from "@/lib/contracts/docusign/envelope";
import { DocuSignError } from "@/lib/contracts/docusign/client";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CASES = [1, 2, 3, 4];

// POST /api/contracts/docusign/diagnostics/email-isolation-test — the
// four-case controlled experiment: each case adds exactly ONE more
// production-shaped input on top of Test A's own known-working
// document/email content, all through the SAME sendDocuSignEnvelope()
// canonical sender Test A/production/Test C already share. Never invoked
// automatically — one explicit POST (one button click in DocuSign Settings)
// = one new envelope. Diagnostic only: never touches localSignatureStore,
// signatureStatusStore, or any Contract field, so it cannot lock or advance
// a real signature request.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const orgId = client.instanceUrl;

  let caseNumber: number, recipientName: string, recipientEmail: string, contentVersionId: string | undefined, contractLabel: string | undefined;
  try {
    ({ caseNumber, recipientName, recipientEmail, contentVersionId, contractLabel } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!VALID_CASES.includes(caseNumber)) {
    return NextResponse.json({ error: "caseNumber must be 1, 2, 3, or 4." }, { status: 400 });
  }
  if (!recipientName?.trim() || !EMAIL_PATTERN.test(normalizeRecipientEmail(recipientEmail ?? ""))) {
    return NextResponse.json({ error: "A valid recipient name and email are required." }, { status: 400 });
  }
  if ((caseNumber === 3 || caseNumber === 4) && !contentVersionId?.trim()) {
    return NextResponse.json({ error: "contentVersionId is required for Case 3 and Case 4." }, { status: 400 });
  }

  try {
    const result = await sendEmailIsolationTestEnvelope(client, orgId, {
      caseNumber: caseNumber as 1 | 2 | 3 | 4,
      recipientName: recipientName.trim(),
      recipientEmail: recipientEmail.trim(),
      contentVersionId,
      contractLabel,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof EnvelopeInvariantError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: "DocuSign rejected the test envelope.", code: "DOCUSIGN_ENVELOPE_CREATE_FAILED", docuSignStatus: err.status, docuSignErrorCode: body?.errorCode ?? null, docuSignMessage: body?.message ?? err.message }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to send the isolation test envelope." }, { status: 502 });
  }
}
