/**
 * §8.11 — refresh the ListPrice step's Decision Table dataset after deploy
 * so the standard-pricebook lookup the cloned ListPrice step depends on
 * actually reflects current data. Non-blocking: any failure here is a
 * warning on the create-procedure response, never a reason to fail the
 * whole request — the metadata already deployed successfully by this point.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export interface DecisionTableRefreshResult {
  attempted: boolean;
  succeeded: boolean;
  warning?: string;
}

export async function refreshListPriceDecisionTable(
  client: SalesforceClient,
  lookUpId: string | null,
  lookUpApiName: string | null,
): Promise<DecisionTableRefreshResult> {
  if (!lookUpId) {
    return { attempted: false, succeeded: false, warning: "No LookUpId captured from the template ListPrice step — skipping the Decision Table refresh." };
  }

  let apiName = lookUpApiName;
  if (!apiName) {
    try {
      const res = await client.query<{ DeveloperName?: string; MasterLabel?: string }>(
        `SELECT DeveloperName, MasterLabel FROM DecisionTable WHERE Id = '${soqlEscape(lookUpId)}' LIMIT 1`,
      );
      apiName = res.records[0]?.DeveloperName ?? null;
    } catch {
      apiName = null;
    }
  }

  if (apiName) {
    try {
      await client.request(`/actions/standard/refreshDecisionTable`, {
        method: "POST",
        body: JSON.stringify({ inputs: [{ DecisionTableApiName: apiName }] }),
      });
      return { attempted: true, succeeded: true };
    } catch {
      // fall through to Id-based attempt
    }
  }

  try {
    await client.request(`/actions/standard/refreshDecisionTable`, {
      method: "POST",
      body: JSON.stringify({ inputs: [{ DecisionTableId: lookUpId }] }),
    });
    return { attempted: true, succeeded: true };
  } catch (err) {
    return {
      attempted: true,
      succeeded: false,
      warning: `Decision Table refresh failed for "${apiName ?? lookUpId}" — manually refresh via Setup → Decision Tables → refresh the dataset. (${err instanceof Error ? err.message : "unknown error"})`,
    };
  }
}
