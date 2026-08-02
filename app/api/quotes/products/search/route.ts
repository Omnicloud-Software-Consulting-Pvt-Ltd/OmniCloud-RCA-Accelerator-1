import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { searchCatalogProducts } from "@/lib/quotes/catalog/search";

// POST /api/quotes/products/search — debounced product search within a price book (§4.1).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let pricebookId: string, searchTerm: string;
  try {
    ({ pricebookId, searchTerm = "" } = await req.json());
    if (!pricebookId) return NextResponse.json({ error: "pricebookId is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const products = await searchCatalogProducts(auth.client, pricebookId, searchTerm);
    return NextResponse.json({ success: true, products });
  } catch (err) {
    return sfErrorResponse(err, "Failed to search products");
  }
}
