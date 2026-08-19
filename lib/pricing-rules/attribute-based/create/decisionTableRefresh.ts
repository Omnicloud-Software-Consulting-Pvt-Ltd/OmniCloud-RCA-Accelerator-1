/**
 * Part I — refresh the ListPrice step's Decision Table dataset after deploy
 * so the standard-pricebook lookup the cloned ListPrice step depends on
 * actually reflects current data. Non-blocking: any failure here is a
 * warning on the create response, never a reason to fail the whole request —
 * the metadata already deployed successfully by this point.
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

/**
 * §Attribute Discount Entries — Salesforce's standard Decision Table for Attribute-Based Pricing
 * runtime lookups is a DIFFERENT concept from PriceAdjustmentSchedule (the native "lookup table"
 * object created above): after creating/updating attribute-based adjustments, Salesforce's own
 * documented process refreshes this decision table so the new data is reflected. This never creates
 * one — if the standard table isn't found on this org, that's reported as a warning, never a reason
 * to fail the run, and never a reason to invent a custom decision-table structure (Parts 6-8).
 */
export interface AttributeDiscountEntriesResult {
  found: boolean;
  refreshed: boolean;
  developerName?: string;
  masterLabel?: string;
  warning?: string;
}

/**
 * §Fix — DecisionTable's field set is org-specific; a prior version hardcoded `IsActive` and blew up
 * with "No such column 'IsActive' on entity 'DecisionTable'" on an org that doesn't expose it. Every
 * field used below (including the identifying DeveloperName/MasterLabel fields) is now confirmed via
 * Describe first — never assumed, never treated as fatal when absent (an active/status field is
 * simply omitted from the query if this org doesn't have one).
 *
 * §Part 4 root-cause fix — Salesforce's own documented `DecisionTable` Tooling API object reference
 * confirms its real fields are `DeveloperName`, `MasterLabel`, `SetupName` (a required setup identifier
 * distinct from both — never checked by the prior version at all) and `Status` (a picklist:
 * Draft/Active/Inactive/ActivationInProgress — NOT a boolean `IsActive`, which the prior version's
 * `/^is.?active$/i` guess would never match against a field literally named "Status"). The same
 * reference confirms `DecisionTable` is queryable via the Tooling API; whether the standard REST
 * `/query` endpoint also returns real rows for it is NOT documented and was never observed live — so
 * this now tries the standard endpoint FIRST (unchanged default path) and, only if that finds zero
 * candidates, retries the identical search via `client.toolingQuery` (Tooling API) before concluding
 * "not found." A table found by either path is refreshed the same way; the discovery path actually
 * used is logged so a live run makes it obvious which one worked (or that BOTH came back empty, which
 * is real proof of absence rather than a guess).
 */
interface DecisionTableCandidate extends Record<string, unknown> { Id: string }

async function queryDecisionTableCandidates(
  client: SalesforceClient,
  soql: string,
  via: "standard" | "tooling",
): Promise<{ candidates: DecisionTableCandidate[]; error?: string }> {
  try {
    const records = via === "standard"
      ? (await client.query<DecisionTableCandidate>(soql)).records
      : (await client.toolingQuery<DecisionTableCandidate>(soql)).records;
    return { candidates: records };
  } catch (err) {
    return { candidates: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function refreshAttributeDiscountEntries(client: SalesforceClient): Promise<AttributeDiscountEntriesResult> {
  let describeFieldNames: Set<string>;
  try {
    const describe = await client.describeObject("DecisionTable");
    describeFieldNames = new Set(describe.fields.map(f => f.name));
  } catch (err) {
    const warning = `Could not describe DecisionTable: ${err instanceof Error ? err.message : String(err)} — skipping the refresh.`;
    client.logDebug("xml-diagnostic", warning);
    return { found: false, refreshed: false, warning };
  }

  const hasDeveloperName = describeFieldNames.has("DeveloperName");
  const hasMasterLabel = describeFieldNames.has("MasterLabel");
  const hasSetupName = describeFieldNames.has("SetupName");
  const hasStatus = describeFieldNames.has("Status");
  const activeFieldName = hasStatus ? "Status" : ([...describeFieldNames].find(n => /^is.?active$/i.test(n)) ?? null);

  client.logDebug("xml-diagnostic", [
    "DecisionTable schema discovered",
    `Available fields: ${[...describeFieldNames].sort().join(", ")}`,
    `Attribute Discount Entries lookup fields: Id${hasDeveloperName ? ", DeveloperName" : ""}${hasMasterLabel ? ", MasterLabel" : ""}${hasSetupName ? ", SetupName" : ""}${activeFieldName ? `, ${activeFieldName}` : " (no Status/active field on this org — omitted, not treated as fatal)"}`,
  ].join("\n"));

  if (!hasDeveloperName && !hasMasterLabel && !hasSetupName) {
    const warning = "DecisionTable has no DeveloperName, MasterLabel, or SetupName field on this org — cannot identify the standard \"Attribute Discount Entries\" table by name. Skipping the refresh.";
    client.logDebug("xml-diagnostic", `DecisionTable found/reused/created: NOT FOUND — ${warning}`);
    return { found: false, refreshed: false, warning };
  }

  const selectFields = [
    "Id",
    ...(hasDeveloperName ? ["DeveloperName"] : []),
    ...(hasMasterLabel ? ["MasterLabel"] : []),
    ...(hasSetupName ? ["SetupName"] : []),
    ...(activeFieldName ? [activeFieldName] : []),
  ];
  const whereClauses = [
    hasMasterLabel ? `MasterLabel LIKE '%Attribute Discount%'` : null,
    hasDeveloperName ? `DeveloperName LIKE '%Attribute%Discount%'` : null,
    hasSetupName ? `SetupName LIKE '%Attribute%Discount%'` : null,
  ].filter((c): c is string => !!c);
  const soql = `SELECT ${selectFields.join(", ")} FROM DecisionTable WHERE ${whereClauses.join(" OR ")} LIMIT 10`;

  const standardResult = await queryDecisionTableCandidates(client, soql, "standard");
  client.logDebug("xml-diagnostic", [
    `Attribute Discount Entries discovery — standard REST query — ${standardResult.candidates.length} candidate(s) found${standardResult.error ? ` (error: ${standardResult.error})` : ""}.`,
    `SOQL: ${soql}`,
    `Records: ${JSON.stringify(standardResult.candidates)}`,
  ].join("\n"));

  let candidates: DecisionTableCandidate[] = standardResult.candidates;
  let foundVia: "standard" | "tooling" = "standard";
  if (candidates.length === 0) {
    const toolingResult = await queryDecisionTableCandidates(client, soql, "tooling");
    client.logDebug("xml-diagnostic", [
      `Attribute Discount Entries discovery — standard REST query found nothing; retrying via Tooling API — ${toolingResult.candidates.length} candidate(s) found${toolingResult.error ? ` (error: ${toolingResult.error})` : ""}.`,
      `Records: ${JSON.stringify(toolingResult.candidates)}`,
    ].join("\n"));
    if (toolingResult.candidates.length > 0) {
      candidates = toolingResult.candidates;
      foundVia = "tooling";
    }
  }

  if (candidates.length === 0) {
    const warning = "No standard \"Attribute Discount Entries\" decision table was found on this org via either the standard REST query or the Tooling API — skipping the post-creation refresh. If Attribute-Based Pricing isn't reflecting the new adjustments, refresh the relevant Decision Table manually via Setup → Decision Tables.";
    client.logDebug("xml-diagnostic", `DecisionTable found/reused/created: NOT FOUND (both standard and Tooling API queries returned zero rows) — ${warning}`);
    return { found: false, refreshed: false, warning };
  }
  client.logDebug("xml-diagnostic", `DecisionTable discovery succeeded via the ${foundVia === "standard" ? "standard REST" : "Tooling API"} query.`);

  const chosen = candidates.find(c => hasMasterLabel && /^attribute discount entries$/i.test((c.MasterLabel as string | undefined) ?? ""))
    ?? candidates.find(c => hasSetupName && /^attribute discount entries$/i.test((c.SetupName as string | undefined) ?? ""))
    ?? candidates[0];
  const developerName = hasDeveloperName ? (chosen.DeveloperName as string | undefined) : undefined;
  const masterLabel = hasMasterLabel ? (chosen.MasterLabel as string | undefined) : undefined;
  const label = developerName ?? masterLabel ?? chosen.Id;
  client.logDebug("xml-diagnostic", `DecisionTable found/reused/created: FOUND existing "${label}" (${chosen.Id}) — will refresh, never create a new one.`);

  try {
    if (developerName) {
      await client.request(`/actions/standard/refreshDecisionTable`, { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableApiName: developerName }] }) });
    } else {
      await client.request(`/actions/standard/refreshDecisionTable`, { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableId: chosen.Id }] }) });
    }
    return { found: true, refreshed: true, developerName, masterLabel };
  } catch (err) {
    return {
      found: true,
      refreshed: false,
      developerName,
      masterLabel,
      warning: `Found the "${label}" decision table but the refresh action failed: ${err instanceof Error ? err.message : String(err)} — manually refresh via Setup → Decision Tables.`,
    };
  }
}
