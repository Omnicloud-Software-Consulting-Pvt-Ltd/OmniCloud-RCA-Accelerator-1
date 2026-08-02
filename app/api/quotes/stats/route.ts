import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteListFieldSchema } from "@/lib/quotes/metadata/quoteFields";
import type { QuoteListItem } from "@/lib/quotes/types";

export interface QuoteStatusBreakdown {
  status: string;
  count: number;
  totalValue: number | null;
}

/** A recent-activity row — the shared QuoteListItem shape plus CreatedDate, so the dashboard can tell "just created" from "updated" without a second query. */
export type QuoteActivityItem = QuoteListItem & { createdDate: string };

export interface QuoteStatsResponse {
  success: true;
  totalQuotes: number;
  totalValue: number | null;
  grandTotalFieldAvailable: boolean;
  statusBreakdown: QuoteStatusBreakdown[];
  recentQuotes: QuoteActivityItem[];
}

/**
 * GET /api/quotes/stats — aggregate counts/value for the Quotes dashboard
 * (landing page shown before entering the existing Quote history/create
 * flows). Separate from GET /api/quotes (which returns the 50 most recent
 * quotes for the history list) because dashboard totals must reflect the
 * WHOLE org, not just the most recently modified page of records.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const schema = await resolveQuoteListFieldSchema(client);
    const grandTotalApi = schema.grandTotalField?.apiName ?? null;

    const aggSoql = grandTotalApi
      ? `SELECT Status, COUNT(Id) qCount, SUM(${grandTotalApi}) qTotal FROM Quote GROUP BY Status`
      : `SELECT Status, COUNT(Id) qCount FROM Quote GROUP BY Status`;
    const agg = await client.query<{ Status: string | null; qCount: number; qTotal?: number | null }>(aggSoql);

    const statusBreakdown: QuoteStatusBreakdown[] = agg.records.map(r => ({
      status: r.Status ?? "No Status",
      count: r.qCount,
      totalValue: grandTotalApi ? (r.qTotal ?? 0) : null,
    }));

    const totalQuotes = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
    const totalValue = grandTotalApi ? statusBreakdown.reduce((sum, s) => sum + (s.totalValue ?? 0), 0) : null;

    // Recent activity — same shape as GET /api/quotes, small page, includes
    // CreatedDate so the dashboard can tell "just created" from "updated".
    const selectFields = ["Id", "Name", "Status", "CreatedDate", "LastModifiedDate"];
    if (schema.quoteNumberField) selectFields.push(schema.quoteNumberField.apiName);
    if (grandTotalApi) selectFields.push(grandTotalApi);
    if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);

    const recentSoql = `SELECT ${selectFields.join(", ")} FROM Quote ORDER BY LastModifiedDate DESC LIMIT 8`;
    const recentResult = await client.query<Record<string, unknown>>(recentSoql);

    const recentQuotes: QuoteActivityItem[] = recentResult.records.map(r => {
      const accountRel = schema.accountRelationshipField?.relationshipName
        ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null)
        : null;
      return {
        id: r.Id as string,
        name: r.Name as string,
        quoteNumber: schema.quoteNumberField ? ((r[schema.quoteNumberField.apiName] as string) ?? null) : null,
        grandTotal: grandTotalApi ? ((r[grandTotalApi] as number) ?? null) : null,
        status: (r.Status as string) ?? null,
        accountName: (accountRel?.Name as string) ?? null,
        opportunityName: null,
        pricebookName: null,
        lastModifiedDate: r.LastModifiedDate as string,
        createdDate: r.CreatedDate as string,
        lineItemCount: null,
      };
    });

    return NextResponse.json({
      success: true,
      totalQuotes,
      totalValue,
      grandTotalFieldAvailable: !!grandTotalApi,
      statusBreakdown,
      recentQuotes,
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load quote statistics");
  }
}
