import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { compareDocuSignEnvelopes } from "@/lib/contracts/docusign/envelope";

// POST /api/contracts/docusign/diagnostics/compare — one-click server-side
// comparison of two envelopes (e.g. an API-created envelope vs. one created
// manually in the DocuSign web UI). Fetches BOTH envelopes' raw DocuSign
// responses (envelope, recipients with extended fields, notification
// settings, audit events) using this org's existing DocuSign connection and
// returns a structured field-by-field diff — no manual JSON copy/paste
// required. Read-only; never creates or modifies anything.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  let apiEnvelopeId: string, manualEnvelopeId: string;
  try {
    ({ apiEnvelopeId, manualEnvelopeId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!apiEnvelopeId?.trim() || !manualEnvelopeId?.trim()) {
    return NextResponse.json({ error: "Both envelope IDs are required." }, { status: 400 });
  }

  try {
    const result = await compareDocuSignEnvelopes(orgId, apiEnvelopeId.trim(), manualEnvelopeId.trim());
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return sfErrorResponse(err, "Failed to compare the two DocuSign envelopes");
  }
}
