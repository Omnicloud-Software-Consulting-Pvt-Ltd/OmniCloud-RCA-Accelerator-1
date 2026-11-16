import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import {
  PRICING_TEST_API_VERSION, createBundleTestQuote, priceQuoteWithProcedure,
} from "@/lib/pricing-rules/bundle-based/create/quotePricingTest";

/**
 * POST /api/pricing-rules/bundle-based/test-quote
 *
 * Prices a Quote through one specific Bundle-Based pricing procedure and returns Salesforce's own per-line
 * results and Pricing Waterfall. Pass `quoteId` to price an existing Quote, or `createTestQuote` to have a
 * Quote with the bundle and the chosen components created first (via RCA's Place Sales Transaction API).
 * Pricing happens in memory — the Quote's saved prices are never changed.
 */
export async function POST(req: NextRequest) {
  // queryContextTags (used by the pricing Flow) needs API v63+.
  const auth = requireSFClient(req, PRICING_TEST_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let body: {
    procedureApiName?: string;
    quoteId?: string;
    createTestQuote?: { bundleId: string; bundleName: string; componentProductIds: string[] };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.procedureApiName?.trim()) return NextResponse.json({ error: "procedureApiName is required" }, { status: 400 });
  if (!body.quoteId && !body.createTestQuote) return NextResponse.json({ error: "Provide quoteId or createTestQuote" }, { status: 400 });
  if (body.quoteId && !/^0Q0[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(body.quoteId.trim())) {
    return NextResponse.json({ error: "quoteId must be a Quote Id (starts with 0Q0)" }, { status: 400 });
  }

  try {
    let quoteId = body.quoteId?.trim();
    let createdQuote = false;
    if (!quoteId && body.createTestQuote) {
      const created = await createBundleTestQuote(client, body.createTestQuote);
      quoteId = created.quoteId;
      createdQuote = true;
    }
    const result = await priceQuoteWithProcedure(client, { quoteId: quoteId!, procedureApiName: body.procedureApiName.trim() });
    return NextResponse.json({ ...result, createdQuote }, { status: result.success ? 200 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Bundle pricing test failed");
  }
}
