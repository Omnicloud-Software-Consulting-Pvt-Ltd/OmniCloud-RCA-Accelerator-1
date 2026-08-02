import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteFieldSchema } from "@/lib/quotes/metadata/quoteFields";
import type { QuoteDetail } from "@/lib/quotes/types";

type Params = { params: Promise<{ id: string }> };

// GET /api/quotes/[id] — single-record read, including raw lookup Ids so the
// "add more line items" flow can reuse the exact creation-flow component (§3.7, §3.9).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const schema = await resolveQuoteFieldSchema(client);
    const record = await client.getRecord("Quote", id);

    const detail: QuoteDetail = {
      id,
      name: (record.Name as string) ?? "",
      record,
      accountId: schema.accountField ? ((record[schema.accountField.apiName] as string) ?? null) : null,
      pricebookId: schema.pricebookField ? ((record[schema.pricebookField.apiName] as string) ?? null) : null,
      opportunityId: schema.opportunityField ? ((record[schema.opportunityField.apiName] as string) ?? null) : null,
    };

    return NextResponse.json({ success: true, quote: detail });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load quote");
  }
}
