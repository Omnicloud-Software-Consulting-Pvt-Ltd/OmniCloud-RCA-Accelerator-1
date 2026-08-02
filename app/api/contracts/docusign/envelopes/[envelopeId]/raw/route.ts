import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { getEnvelopeRawDiagnostics } from "@/lib/contracts/docusign/envelope";

type Params = { params: Promise<{ envelopeId: string }> };

// GET /api/contracts/docusign/envelopes/[envelopeId]/raw — read-only, full-
// fidelity dump of an envelope's raw DocuSign responses (envelope, recipients
// with extended fields, notification settings, audit events), straight from
// DocuSign, for any envelopeId this org's connection can see. Exists so two
// envelopes (e.g. one created by this app vs. one created manually in the
// DocuSign web UI) can be compared field-by-field when the curated
// /diagnostics endpoint's narrower fields aren't enough. Recipient emails are
// redacted; everything else is passed through verbatim. Never creates or
// modifies anything.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;
  const { envelopeId } = await params;

  try {
    const raw = await getEnvelopeRawDiagnostics(orgId, envelopeId);
    return NextResponse.json({ success: true, envelopeId, ...raw });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load raw envelope diagnostics");
  }
}
