import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveContractListFieldSchema } from "@/lib/contracts/metadata/contractFields";
import { describeObjectCached } from "@/lib/salesforce/describe";
import type { ContractListItem } from "@/lib/contracts/types";

export interface ContractStatusBreakdown {
  status: string;
  count: number;
  totalValue: number | null;
}

/** A recent-activity row — the shared ContractListItem shape plus CreatedDate, so the dashboard can tell "just created" from "updated". */
export type ContractActivityItem = ContractListItem & { createdDate: string };

export interface ContractStatsResponse {
  success: true;
  totalContracts: number;
  expiringSoonContracts: number;
  totalValue: number | null;
  valueFieldAvailable: boolean;
  statusBreakdown: ContractStatusBreakdown[];
  recentContracts: ContractActivityItem[];
}

function soqlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/contracts/stats — aggregate counts/value for the Contracts
 * dashboard (landing page shown before entering the existing Contract
 * history/create flows). Separate from GET /api/contracts (the 50 most
 * recent Contracts for the history list) because dashboard totals must
 * reflect the WHOLE org, and "expiring soon" needs its own date-range query.
 */
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const schema = await resolveContractListFieldSchema(client);

    // Standard Contract has no monetary total (unlike Quote.GrandTotal /
    // Order.TotalAmount) — best-effort Describe search for whatever this
    // org calls it (a custom Currency field), never a hardcoded API name.
    // Falls back to unavailable (never fabricated) if this org has none.
    const describe = await describeObjectCached(client, "Contract");
    const valueField = describe.fields.find(
      f => f.type === "currency" && /contract\s*value|total\s*value|annual\s*(contract\s*)?value|deal\s*value|\bacv\b|\btcv\b/i.test(f.label),
    ) ?? null;

    const aggSoql = valueField
      ? `SELECT Status, COUNT(Id) ctCount, SUM(${valueField.name}) ctTotal FROM Contract GROUP BY Status`
      : `SELECT Status, COUNT(Id) ctCount FROM Contract GROUP BY Status`;
    const agg = await client.query<{ Status: string | null; ctCount: number; ctTotal?: number | null }>(aggSoql);

    const statusBreakdown: ContractStatusBreakdown[] = agg.records.map(r => ({
      status: r.Status ?? "No Status",
      count: r.ctCount,
      totalValue: valueField ? (r.ctTotal ?? 0) : null,
    }));

    const totalContracts = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
    const totalValue = valueField ? statusBreakdown.reduce((sum, s) => sum + (s.totalValue ?? 0), 0) : null;

    // Expiring soon: EndDate falls within [today, today+30d]. EndDate is a
    // formula field on virtually every org, so this can't be derived from
    // the status breakdown — a dedicated range query is the only way.
    let expiringSoonContracts = 0;
    if (schema.endDateField) {
      const today = new Date();
      const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
      try {
        const expResult = await client.query<{ ctCount: number }>(
          `SELECT COUNT(Id) ctCount FROM Contract WHERE ${schema.endDateField.apiName} >= ${soqlDate(today)} AND ${schema.endDateField.apiName} <= ${soqlDate(in30Days)}`,
        );
        expiringSoonContracts = expResult.records[0]?.ctCount ?? 0;
      } catch {
        // Best-effort — leave at 0 rather than fail the whole dashboard.
        expiringSoonContracts = 0;
      }
    }

    // Recent activity — same shape as GET /api/contracts, small page.
    const selectFields = ["Id", "Status", "CreatedDate", "LastModifiedDate"];
    if (schema.contractNumberField) selectFields.push(schema.contractNumberField.apiName);
    if (schema.startDateField) selectFields.push(schema.startDateField.apiName);
    if (schema.endDateField) selectFields.push(schema.endDateField.apiName);
    if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);

    const recentSoql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM Contract ORDER BY LastModifiedDate DESC LIMIT 8`;
    const recentResult = await client.query<Record<string, unknown>>(recentSoql);

    const recentContracts: ContractActivityItem[] = recentResult.records.map(r => {
      const accountRel = schema.accountRelationshipField?.relationshipName
        ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null)
        : null;
      return {
        id: r.Id as string,
        contractNumber: schema.contractNumberField ? ((r[schema.contractNumberField.apiName] as string) ?? null) : null,
        status: (r.Status as string) ?? null,
        accountName: (accountRel?.Name as string) ?? null,
        startDate: schema.startDateField ? ((r[schema.startDateField.apiName] as string) ?? null) : null,
        endDate: schema.endDateField ? ((r[schema.endDateField.apiName] as string) ?? null) : null,
        lastModifiedDate: r.LastModifiedDate as string,
        createdDate: r.CreatedDate as string,
      };
    });

    return NextResponse.json({
      success: true,
      totalContracts,
      expiringSoonContracts,
      totalValue,
      valueFieldAvailable: !!valueField,
      statusBreakdown,
      recentContracts,
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load contract statistics");
  }
}
