import type { NextRequest } from "next/server";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { searchProducts } from "@/lib/tax/server/records";
import { taxRoute } from "@/lib/tax/server/route";

// GET /api/billing/tax/products?q= — Salesforce-backed product search for the Manual form (read-only).
// (The paged lookup used by the calculation and verification forms is /api/taxes/lookup?object=Product2.)
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 80);
  return taxRoute(req, async client => ({ success: true, products: await searchProducts(client, await discoverTaxMetadata(client), q) }), "Failed to search products");
}
