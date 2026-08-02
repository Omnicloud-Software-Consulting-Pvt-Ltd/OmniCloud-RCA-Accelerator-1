import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { getEnvelopeDiagnostics } from "@/lib/contracts/docusign/envelope";

type Params = { params: Promise<{ envelopeId: string }> };

// GET /api/contracts/docusign/envelopes/[envelopeId]/diagnostics — read-only
// inspection of an EXISTING envelope, straight from DocuSign (never creates
// or modifies anything). Uses this org's existing DocuSign connection —
// same session resolver every other DocuSign route uses. Returns only
// safe, non-sensitive fields (masked recipient emails, status/timestamps,
// booleans) — never access tokens, refresh tokens, or Client Secret.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;
  const { envelopeId } = await params;

  try {
    const diagnostics = await getEnvelopeDiagnostics(orgId, envelopeId);
    return NextResponse.json({ success: true, ...diagnostics });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load envelope diagnostics");
  }
}
