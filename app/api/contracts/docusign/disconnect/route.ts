import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { disconnectConnection, getConnection, toPublicConfig } from "@/lib/contracts/docusign/connectionStore";

// POST /api/contracts/docusign/disconnect — clears the live connection
// (tokens, connected account/user) but deliberately keeps the Client
// ID/Secret/webhook-secret configuration, so reconnecting is just a fresh
// OAuth grant, not re-entering credentials. DocuSign has no documented
// "revoke this specific grant" endpoint for this OAuth flow, so this is a
// local disconnect (stop using the stored tokens) — the underlying DocuSign
// user can separately revoke app access from their own DocuSign account if desired.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  try {
    await disconnectConnection(orgId);
    const row = await getConnection(orgId);
    return NextResponse.json({ success: true, config: toPublicConfig(row, orgId) });
  } catch (err) {
    return sfErrorResponse(err, "Failed to disconnect DocuSign");
  }
}
