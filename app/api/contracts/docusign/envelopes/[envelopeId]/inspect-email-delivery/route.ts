import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { inspectEmailDelivery } from "@/lib/contracts/docusign/emailDeliveryInspection";

type Params = { params: Promise<{ envelopeId: string }> };

// GET /api/contracts/docusign/envelopes/[envelopeId]/inspect-email-delivery
// (§Phase 5) — read-only, never creates/modifies anything. Diagnoses email
// delivery AFTER DocuSign has already accepted an envelope (HTTP 201,
// status "sent") — does not re-check or alter deliveryMethod/clientUserId/
// tabs/document extension/OAuth/webhook/signed-document-retrieval, all of
// which are out of scope for this investigation.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;
  const { envelopeId } = await params;

  try {
    const inspection = await inspectEmailDelivery(orgId, envelopeId);
    return NextResponse.json({ success: true, ...inspection });
  } catch (err) {
    return sfErrorResponse(err, "Failed to inspect email delivery for this envelope");
  }
}
