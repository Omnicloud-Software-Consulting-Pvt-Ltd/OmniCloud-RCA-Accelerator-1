import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";

export interface ProductListItem {
  id: string;
  name: string;
  productCode: string | null;
  family: string | null;
  type: string | null;
  isActive: boolean;
  createdDate: string;
  lastModifiedDate: string;
}

/** GET /api/sf/products — history: 100 most recently modified Products, for the Product History view. */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const soql = "SELECT Id, Name, ProductCode, Family, Type, IsActive, CreatedDate, LastModifiedDate FROM Product2 ORDER BY LastModifiedDate DESC LIMIT 100";
    const result = await client.query<Record<string, unknown>>(soql);

    const products: ProductListItem[] = result.records.map(r => ({
      id: r.Id as string,
      name: r.Name as string,
      productCode: (r.ProductCode as string) ?? null,
      family: (r.Family as string) ?? null,
      type: (r.Type as string) ?? null,
      isActive: !!r.IsActive,
      createdDate: r.CreatedDate as string,
      lastModifiedDate: r.LastModifiedDate as string,
    }));

    return NextResponse.json({ success: true, products, soql });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list products");
  }
}
