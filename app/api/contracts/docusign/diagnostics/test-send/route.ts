import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { sendDocuSignControlTestEnvelope } from "@/lib/contracts/docusign/envelope";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/contracts/docusign/diagnostics/test-send — email-delivery
// control test (§ Phase 7): sends ONE new, real envelope (one PDF, one
// signer, no clientUserId, status "sent") through the exact same
// createAndSendEnvelope() the real Send-for-Signature flow uses, then
// immediately re-queries envelope + recipients + audit events straight from
// DocuSign. Not tied to any Contract. One explicit POST = one envelope —
// this route never sends more than what's requested here, and has no retry
// loop of its own.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  let recipientName: string, recipientEmail: string, explicitDeliveryMethod: boolean | undefined, omitTabs: boolean | undefined;
  try {
    ({ recipientName, recipientEmail, explicitDeliveryMethod, omitTabs } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!recipientName?.trim() || !EMAIL_PATTERN.test(recipientEmail ?? "")) {
    return NextResponse.json({ error: "A valid recipient name and email are required." }, { status: 400 });
  }

  try {
    const diagnostics = await sendDocuSignControlTestEnvelope(orgId, {
      recipientName: recipientName.trim(),
      recipientEmail: recipientEmail.trim(),
      explicitDeliveryMethod: !!explicitDeliveryMethod,
      omitTabs: !!omitTabs,
    });
    return NextResponse.json({ success: true, ...diagnostics });
  } catch (err) {
    return sfErrorResponse(err, "Failed to send the DocuSign test envelope");
  }
}
