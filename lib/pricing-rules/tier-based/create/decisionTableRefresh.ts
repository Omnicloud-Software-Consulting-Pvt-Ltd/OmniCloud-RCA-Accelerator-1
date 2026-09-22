/**
 * Tier-Based Pricing decision-table refresh — new `PriceAdjustmentTier` rows are invisible to the
 * VolumeTierDiscount BKM until its bound Decision Table's dataset is rebuilt. Tries the resolved
 * DeveloperName (ApiName) first, then falls back to the resolved Id. Never fatal — a failure here is
 * logged as a non-blocking warning, since the metadata/records have already been created successfully by
 * this point. Mirrors lib/pricing-rules/volume-based/create/decisionTableRefresh.ts exactly.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";

export interface RefreshTierDecisionTableResult { attempted: boolean; refreshed: boolean; warning?: string; }

export async function refreshTierDecisionTable(
  client: SalesforceClient,
  lookup: { id: string | null; apiName: string | null; name: string | null },
): Promise<RefreshTierDecisionTableResult> {
  if (!lookup.id) {
    return { attempted: false, refreshed: false, warning: "No Decision Table Id was resolved for this VolumeTierDiscount step — skipping the refresh." };
  }

  if (lookup.apiName) {
    try {
      await client.request("/actions/standard/refreshDecisionTable", { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableApiName: lookup.apiName }] }) });
      return { attempted: true, refreshed: true };
    } catch { /* fall through to Id-based attempt */ }
  }

  try {
    await client.request("/actions/standard/refreshDecisionTable", { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableId: lookup.id }] }) });
    return { attempted: true, refreshed: true };
  } catch (err) {
    return {
      attempted: true, refreshed: false,
      warning: `Tier Adjustment Decision Table ("${lookup.name ?? lookup.id}") was NOT refreshed automatically (${err instanceof Error ? err.message : String(err)}) — go to Setup → Decision Tables → "${lookup.name ?? lookup.id}" → Refresh Dataset (or Refresh).`,
    };
  }
}
