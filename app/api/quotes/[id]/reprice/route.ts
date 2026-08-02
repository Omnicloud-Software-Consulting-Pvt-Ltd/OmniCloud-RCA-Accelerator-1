import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { repriceQuote } from "@/lib/quotes/pricing/reprice";

type Params = { params: Promise<{ id: string }> };

// POST /api/quotes/[id]/reprice — manually trigger Salesforce's own repricing/Instant Pricing (§6.4).
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;

  try {
    const repricing = await repriceQuote(auth.client, id);
    return NextResponse.json({ success: repricing.succeeded, repricing });
  } catch (err) {
    return sfErrorResponse(err, "Failed to reprice quote");
  }
}
