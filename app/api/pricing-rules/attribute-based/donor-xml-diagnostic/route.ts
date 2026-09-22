import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { captureDonorXmlDiagnostic } from "@/lib/pricing-rules/attribute-based/create/donorXmlDiagnostic";

/**
 * GET /api/pricing-rules/attribute-based/donor-xml-diagnostic?donor=<fullName>
 *
 * §TEMPORARY — read-only diagnostic. Disabled unless DONOR_XML_DIAGNOSTIC=true is set in the server's
 * environment (never on by default, never in production config). Retrieves the SAME ExpressionSetDefinition
 * metadata the real Attribute-Based Pricing pipeline already retrieves (`retrieveExpressionSetDefinitionFiles`
 * — a Metadata API `retrieve`, which is read-only by Salesforce's own definition), captures the raw XML for
 * the requested donor verbatim to local disk, and writes structural/variable reports derived from it.
 *
 * Never creates, updates, deploys, or activates anything — this route calls nothing beyond the retrieve
 * used for donor inspection everywhere else in this codebase. The response body is a small JSON summary
 * (paths + hashes + counts) — never the full raw XML — so read the written files directly.
 *
 * Delete this route (and lib/.../donorXmlDiagnostic.ts + its test) once the real donor XML has been
 * captured and the actual ListPrice<->AttributeDiscount resolver is implemented from it.
 */
export async function GET(req: NextRequest) {
  if (process.env.DONOR_XML_DIAGNOSTIC !== "true") {
    return NextResponse.json(
      { error: "This diagnostic is disabled. Set DONOR_XML_DIAGNOSTIC=true in your local environment (e.g. .env.local) and restart the dev server to enable it." },
      { status: 404 },
    );
  }

  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  const donorFullName = req.nextUrl.searchParams.get("donor") ?? "Rev_Mgmt_Default_Pricing_Procedure2_V1";
  const outDir = path.join(process.cwd(), "diagnostics");

  try {
    const result = await captureDonorXmlDiagnostic(client, {
      donorFullName,
      outDir,
      sourceEndpoint: `Metadata API SOAP retrieve (ExpressionSetDefinition="${donorFullName}") via this app's existing donor-retrieval path`,
    });
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Donor XML diagnostic capture failed.");
  }
}
