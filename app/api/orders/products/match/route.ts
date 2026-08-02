import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { searchCatalogProducts, rankProductNameMatches } from "@/lib/quotes/catalog/search";

// POST /api/orders/products/match — AI-assisted product name matching + ranking (§4.1),
// resolving free-text product mentions from the order line-item AI parser against the real catalog.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let pricebookId: string, productName: string;
  try {
    ({ pricebookId, productName } = await req.json());
    if (!pricebookId || !productName?.trim()) {
      return NextResponse.json({ error: "pricebookId and productName are required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const searchTerm = productName.trim().split(/\s+/).slice(0, 3).join(" ");
    const candidates = await searchCatalogProducts(auth.client, pricebookId, searchTerm, 25);
    const ranking = rankProductNameMatches(productName, candidates);
    return NextResponse.json({ success: true, ...ranking });
  } catch (err) {
    return sfErrorResponse(err, "Failed to match product name");
  }
}
