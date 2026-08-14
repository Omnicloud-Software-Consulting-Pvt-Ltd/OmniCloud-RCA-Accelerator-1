import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { correctAndResendEnvelopeRecipient, EnvelopeInvariantError } from "@/lib/contracts/docusign/envelope";
import { DocuSignError } from "@/lib/contracts/docusign/client";

type Params = { params: Promise<{ envelopeId: string }> };

// POST /api/contracts/docusign/envelopes/[envelopeId]/correct-recipient
// (§Phase 6) — recovery action for a recipient DocuSign has already reported
// as undeliverable. Corrects that recipient's email on the SAME envelope and
// forces DocuSign to resend the invitation (DocuSign's documented
// PUT .../recipients?resend_envelope=true operation) — never creates a new
// envelope. One POST = one correction + one resend; no automatic retry.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;
  const { envelopeId } = await params;

  let recipientId: string, name: string, email: string;
  try {
    ({ recipientId, name, email } = await req.json());
    if (!recipientId?.trim() || !name?.trim() || !email?.trim()) {
      return NextResponse.json({ error: "recipientId, name, and email are all required.", code: "DOCUSIGN_RECIPIENT_CONFIGURATION_FAILED" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const diagnostics = await correctAndResendEnvelopeRecipient(orgId, envelopeId, { recipientId, name, email });
    return NextResponse.json({ success: true, ...diagnostics });
  } catch (err) {
    if (err instanceof EnvelopeInvariantError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: "DocuSign rejected the recipient correction.", code: "DOCUSIGN_RECIPIENT_CORRECTION_FAILED", docuSignStatus: err.status, docuSignErrorCode: body?.errorCode ?? null, docuSignMessage: body?.message ?? err.message }, { status: 502 });
    }
    return sfErrorResponse(err, "Failed to correct and resend this recipient");
  }
}
