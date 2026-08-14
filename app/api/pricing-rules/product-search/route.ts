import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { soqlEscape } from "@/lib/salesforce/client";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";

// POST /api/pricing-rules/product-search — type-ahead Product2 search
// backing the Product Name lookup on the Attribute-Based Pricing form.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let term: string;
  try {
    ({ term } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!term?.trim()) return NextResponse.json({ matches: [] });

  try {
    const escaped = soqlEscape(term.trim());
    const res = await client.query<{ Id: string; Name: string; ProductCode: string | null }>(
      `SELECT Id, Name, ProductCode FROM Product2 WHERE IsActive = true AND Name LIKE '%${escaped}%' ORDER BY Name LIMIT 10`,
    );
    return NextResponse.json({ matches: res.records.map(r => ({ id: r.Id, name: r.Name, productCode: r.ProductCode ?? undefined })) });
  } catch (err) {
    return sfErrorResponse(err, "Failed to search products.");
  }
}
