/**
 * Bundle-Based Pricing decision-table refresh — mirrors
 * lib/pricing-rules/attribute-based/create/decisionTableRefresh.ts's `refreshAttributeDiscountEntries`
 * pattern for whatever this org's standard "Bundle Discount Entries" Decision Table is actually named.
 * Never creates a table — absence is always a warning, never a failure.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";

export interface BundleDiscountEntriesResult { found: boolean; refreshed: boolean; developerName?: string; masterLabel?: string; warning?: string; }

export async function refreshBundleDiscountEntries(client: SalesforceClient): Promise<BundleDiscountEntriesResult> {
  let describe;
  try {
    describe = await client.describeObject("DecisionTable");
  } catch (err) {
    return { found: false, refreshed: false, warning: `Could not Describe DecisionTable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const fieldNames = new Set(describe.fields.map(f => f.name));
  const hasDeveloperName = fieldNames.has("DeveloperName");
  const hasMasterLabel = fieldNames.has("MasterLabel");
  const hasSetupName = fieldNames.has("SetupName");
  if (!hasDeveloperName && !hasMasterLabel && !hasSetupName) {
    return { found: false, refreshed: false, warning: "DecisionTable on this org exposes none of DeveloperName/MasterLabel/SetupName — cannot search for the Bundle Discount Entries table." };
  }

  const selectFields = ["Id", ...(hasDeveloperName ? ["DeveloperName"] : []), ...(hasMasterLabel ? ["MasterLabel"] : []), ...(hasSetupName ? ["SetupName"] : [])];
  const orClauses: string[] = [];
  if (hasMasterLabel) orClauses.push("MasterLabel LIKE '%Bundle Discount%'");
  if (hasDeveloperName) orClauses.push("DeveloperName LIKE '%Bundle%Discount%'");
  if (hasSetupName) orClauses.push("SetupName LIKE '%Bundle%Discount%'");
  const soql = `SELECT ${selectFields.join(", ")} FROM DecisionTable WHERE ${orClauses.join(" OR ")} LIMIT 10`;

  interface Row { Id: string; DeveloperName?: string; MasterLabel?: string; SetupName?: string }
  let candidates: Row[] = [];
  try {
    const res = await client.query<Row>(soql);
    candidates = res.records;
  } catch { /* fall through to Tooling API retry */ }
  if (candidates.length === 0) {
    try {
      const res = await client.toolingQuery<Row>(soql);
      candidates = res.records;
    } catch { /* both paths exhausted */ }
  }
  if (candidates.length === 0) {
    return { found: false, refreshed: false, warning: "No Bundle Discount Entries Decision Table was found on this org (checked both the standard query API and the Tooling API) — this must exist in Setup for the deployed procedure to price bundle discounts at runtime." };
  }

  const preferred = candidates.find(c => (c.MasterLabel ?? c.SetupName ?? "").toLowerCase() === "bundle discount entries") ?? candidates[0];
  const identifier = preferred.DeveloperName ?? preferred.Id;
  const body = preferred.DeveloperName ? { inputs: [{ DecisionTableApiName: identifier }] } : { inputs: [{ DecisionTableId: preferred.Id }] };
  try {
    await client.request("/actions/standard/refreshDecisionTable", { method: "POST", body: JSON.stringify(body) });
    return { found: true, refreshed: true, developerName: preferred.DeveloperName, masterLabel: preferred.MasterLabel ?? preferred.SetupName };
  } catch (err) {
    return { found: true, refreshed: false, developerName: preferred.DeveloperName, masterLabel: preferred.MasterLabel ?? preferred.SetupName, warning: `Found the Bundle Discount Entries table but the refresh action failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
