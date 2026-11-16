/**
 * Bundle-Based Pricing — deterministic resolution of the lookup (Decision) table the generated
 * `BundleDiscount` step must execute.
 *
 * Never selects a table by name. Resolution order, first hit wins:
 *   1. explicit-reference      — a table Id / DeveloperName the caller's configuration names directly.
 *   2. pricing-recipe-mapping  — the org's ACTIVE PricingRecipe's `PricingRecipeTableMapping` row with
 *                                `PricingComponentType = 'BundleDiscount'`. This is Salesforce's own
 *                                declaration of which table backs the Bundle Discount pricing element.
 *   3. source-object-unique    — the single Active DecisionTable whose `SourceObject` is
 *                                `BundleBasedAdjustment` (the object this pipeline writes rows to). Two or
 *                                more is ambiguous and fails — never "first row".
 * Whatever is selected is then VALIDATED against its real metadata before it is ever used:
 *   - SourceObject must be BundleBasedAdjustment (the rows this pipeline creates are the table's rows),
 *   - Status must be Active,
 *   - its INPUT columns must include the bundle identity keys and its OUTPUT columns the adjustment result,
 *   - every INPUT column must be a real field on BundleBasedAdjustment (so every row can populate it).
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { bundleLog } from "./bundleLog";

export const BUNDLE_LOOKUP_SOURCE_OBJECT = "BundleBasedAdjustment";
export const BUNDLE_PRICING_COMPONENT_TYPE = "BundleDiscount";
/** The minimum INPUT columns a table must expose for parent + child + schedule to be matchable at all. */
export const REQUIRED_BUNDLE_LOOKUP_INPUTS = ["PriceAdjustmentScheduleId", "ProductId", "ParentProductId"];
export const REQUIRED_BUNDLE_LOOKUP_OUTPUTS = ["AdjustmentType", "AdjustmentValue"];

export const NO_BUNDLE_LOOKUP_TABLE_MESSAGE =
  "Bundle-Based Pricing requires a valid Bundle-Based Adjustment lookup table, but no matching table could be resolved.";

export interface BundleLookupColumn {
  fieldName: string;
  operator: string | null;
  sequence: number | null;
  required: boolean;
}

export interface ResolvedBundleLookupTable {
  id: string;
  developerName: string;
  label: string;
  sourceObject: string;
  status: string;
  usageType: string | null;
  refreshStatus: string | null;
  lastSyncDate: string | null;
  selectedBy: "explicit-reference" | "pricing-recipe-mapping" | "source-object-unique";
  reason: string;
  recipe: { id: string; developerName: string } | null;
  inputs: BundleLookupColumn[];
  outputs: string[];
  /** Rows the table is built from (SingleSobject tables source every BundleBasedAdjustment row). */
  existingEntryCount: number | null;
}

export class BundleLookupTableError extends Error {
  constructor(message: string, public readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "BundleLookupTableError";
  }
}

interface DecisionTableRow {
  Id: string;
  DeveloperName: string;
  MasterLabel?: string | null;
  SetupName?: string | null;
  SourceObject?: string | null;
  Status?: string | null;
  UsageType?: string | null;
  RefreshStatus?: string | null;
  LastSyncDate?: string | null;
}

const DT_FIELDS = "Id, DeveloperName, MasterLabel, SetupName, SourceObject, Status, UsageType, RefreshStatus, LastSyncDate";

/** DecisionTable is documented as a Tooling object; this org also serves it on the standard endpoint — try both. */
async function queryDecisionTables(client: SalesforceClient, where: string): Promise<DecisionTableRow[]> {
  const soql = `SELECT ${DT_FIELDS} FROM DecisionTable WHERE ${where}`;
  try {
    return (await client.query<DecisionTableRow>(soql)).records;
  } catch {
    try {
      return (await client.toolingQuery<DecisionTableRow>(soql)).records;
    } catch {
      return [];
    }
  }
}

async function findRecipeMappedTableIds(client: SalesforceClient): Promise<{ ids: string[]; recipes: { id: string; developerName: string }[]; error?: string }> {
  try {
    const recipes = (await client.query<{ Id: string; DeveloperName: string }>(
      "SELECT Id, DeveloperName FROM PricingRecipe WHERE IsActive = true",
    )).records;
    if (recipes.length === 0) return { ids: [], recipes: [] };
    const recipeIds = recipes.map(r => `'${soqlEscape(r.Id)}'`).join(",");
    const mappings = (await client.query<{ LookupTableId: string | null; PricingRecipeId: string }>(
      `SELECT LookupTableId, PricingRecipeId FROM PricingRecipeTableMapping WHERE PricingRecipeId IN (${recipeIds}) AND PricingComponentType = '${BUNDLE_PRICING_COMPONENT_TYPE}'`,
    )).records;
    const ids = [...new Set(mappings.map(m => m.LookupTableId).filter((v): v is string => !!v))];
    const usedRecipeIds = new Set(mappings.map(m => m.PricingRecipeId));
    return { ids, recipes: recipes.filter(r => usedRecipeIds.has(r.Id)).map(r => ({ id: r.Id, developerName: r.DeveloperName })) };
  } catch (err) {
    // PricingRecipe/PricingRecipeTableMapping are absent on orgs without Salesforce Pricing recipes —
    // not fatal, fall through to source-object resolution.
    return { ids: [], recipes: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadColumns(client: SalesforceClient, tableId: string): Promise<{ inputs: BundleLookupColumn[]; outputs: string[] }> {
  const rows = (await client.query<{ FieldName: string; Usage: string; Operator: string | null; Sequence: number | null; IsRequired: boolean }>(
    `SELECT FieldName, Usage, Operator, Sequence, IsRequired FROM DecisionTableParameter WHERE DecisionTableId = '${soqlEscape(tableId)}' ORDER BY Sequence`,
  )).records;
  return {
    inputs: rows.filter(r => r.Usage === "INPUT").map(r => ({ fieldName: r.FieldName, operator: r.Operator ?? null, sequence: r.Sequence ?? null, required: !!r.IsRequired })),
    outputs: rows.filter(r => r.Usage === "OUTPUT").map(r => r.FieldName),
  };
}

/** Pure metadata-compatibility check, exported for unit tests. Returns a list of human-readable problems (empty = compatible). */
export function validateBundleLookupTableShape(
  table: { sourceObject: string | null; status: string | null; inputs: BundleLookupColumn[]; outputs: string[] },
  sourceObjectFieldNames: Set<string> | null,
): string[] {
  const problems: string[] = [];
  if (table.sourceObject !== BUNDLE_LOOKUP_SOURCE_OBJECT) {
    problems.push(`SourceObject is "${table.sourceObject ?? "(none)"}", expected "${BUNDLE_LOOKUP_SOURCE_OBJECT}".`);
  }
  if (table.status !== "Active") problems.push(`Status is "${table.status ?? "(none)"}", expected "Active".`);
  const inputNames = table.inputs.map(i => i.fieldName);
  const missingInputs = REQUIRED_BUNDLE_LOOKUP_INPUTS.filter(n => !inputNames.includes(n));
  const missingOutputs = REQUIRED_BUNDLE_LOOKUP_OUTPUTS.filter(n => !table.outputs.includes(n));
  if (missingInputs.length > 0 || missingOutputs.length > 0) {
    problems.push(
      `Incompatible columns. Expected INPUT ⊇ [${REQUIRED_BUNDLE_LOOKUP_INPUTS.join(", ")}] and OUTPUT ⊇ [${REQUIRED_BUNDLE_LOOKUP_OUTPUTS.join(", ")}]; ` +
      `actual INPUT [${inputNames.join(", ") || "none"}], OUTPUT [${table.outputs.join(", ") || "none"}].`,
    );
  }
  if (sourceObjectFieldNames) {
    const unknown = inputNames.filter(n => !sourceObjectFieldNames.has(n));
    if (unknown.length > 0) problems.push(`INPUT column(s) [${unknown.join(", ")}] are not fields on ${BUNDLE_LOOKUP_SOURCE_OBJECT} — rows could never populate them.`);
  }
  return problems;
}

export async function resolveBundleLookupTable(
  client: SalesforceClient,
  opts: { explicitReference?: string | null } = {},
): Promise<ResolvedBundleLookupTable> {
  let candidate: DecisionTableRow | null = null;
  let selectedBy: ResolvedBundleLookupTable["selectedBy"];
  let reason: string;
  let recipe: ResolvedBundleLookupTable["recipe"] = null;

  const explicit = opts.explicitReference?.trim();
  const recipeLookup = explicit ? null : await findRecipeMappedTableIds(client);

  if (explicit) {
    const isId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(explicit) && explicit.startsWith("0lD");
    const rows = await queryDecisionTables(client, isId ? `Id = '${soqlEscape(explicit)}'` : `DeveloperName = '${soqlEscape(explicit)}'`);
    if (rows.length !== 1) {
      throw new BundleLookupTableError(`${NO_BUNDLE_LOOKUP_TABLE_MESSAGE} The configured lookup-table reference "${explicit}" matched ${rows.length} Decision Table(s).`, { explicit });
    }
    candidate = rows[0];
    selectedBy = "explicit-reference";
    reason = `The Bundle-Based Adjustment configuration names this lookup table directly ("${explicit}").`;
  } else if (recipeLookup && recipeLookup.ids.length > 1) {
    throw new BundleLookupTableError(
      `${NO_BUNDLE_LOOKUP_TABLE_MESSAGE} Active Pricing Recipe(s) map ${BUNDLE_PRICING_COMPONENT_TYPE} to ${recipeLookup.ids.length} different tables (${recipeLookup.ids.join(", ")}) — refusing to guess.`,
      { recipeTableIds: recipeLookup.ids },
    );
  } else if (recipeLookup && recipeLookup.ids.length === 1) {
    const rows = await queryDecisionTables(client, `Id = '${soqlEscape(recipeLookup.ids[0])}'`);
    if (rows.length !== 1) {
      throw new BundleLookupTableError(`${NO_BUNDLE_LOOKUP_TABLE_MESSAGE} The active Pricing Recipe maps ${BUNDLE_PRICING_COMPONENT_TYPE} to ${recipeLookup.ids[0]}, but that Decision Table could not be read.`, {});
    }
    candidate = rows[0];
    selectedBy = "pricing-recipe-mapping";
    recipe = recipeLookup.recipes[0] ?? null;
    reason = `The active Pricing Recipe${recipe ? ` "${recipe.developerName}"` : ""} maps the ${BUNDLE_PRICING_COMPONENT_TYPE} pricing element to this table (PricingRecipeTableMapping).`;
  } else {
    const rows = await queryDecisionTables(client, `SourceObject = '${BUNDLE_LOOKUP_SOURCE_OBJECT}' AND Status = 'Active'`);
    if (rows.length === 0) {
      throw new BundleLookupTableError(
        `${NO_BUNDLE_LOOKUP_TABLE_MESSAGE} No active Pricing Recipe maps ${BUNDLE_PRICING_COMPONENT_TYPE}${recipeLookup?.error ? ` (recipe lookup failed: ${recipeLookup.error})` : ""}, and no Active Decision Table has SourceObject = ${BUNDLE_LOOKUP_SOURCE_OBJECT}.`,
        {},
      );
    }
    if (rows.length > 1) {
      throw new BundleLookupTableError(
        `${NO_BUNDLE_LOOKUP_TABLE_MESSAGE} ${rows.length} Active Decision Tables have SourceObject = ${BUNDLE_LOOKUP_SOURCE_OBJECT} (${rows.map(r => r.DeveloperName).join(", ")}) and no Pricing Recipe disambiguates them.`,
        { candidates: rows.map(r => ({ id: r.Id, developerName: r.DeveloperName })) },
      );
    }
    candidate = rows[0];
    selectedBy = "source-object-unique";
    reason = `No Pricing Recipe mapping exists; this is the only Active Decision Table sourced from ${BUNDLE_LOOKUP_SOURCE_OBJECT}.`;
  }

  const { inputs, outputs } = await loadColumns(client, candidate.Id);
  let bbaFieldNames: Set<string> | null = null;
  try {
    bbaFieldNames = new Set((await client.describeObject(BUNDLE_LOOKUP_SOURCE_OBJECT)).fields.map(f => f.name));
  } catch { /* column-to-field check skipped; the source-object check still applies */ }

  const problems = validateBundleLookupTableShape(
    { sourceObject: candidate.SourceObject ?? null, status: candidate.Status ?? null, inputs, outputs }, bbaFieldNames,
  );
  if (problems.length > 0) {
    bundleLog(client, "lookup-table-incompatible", { tableId: candidate.Id, developerName: candidate.DeveloperName, problems });
    throw new BundleLookupTableError(
      `Bundle-Based Pricing lookup table "${candidate.DeveloperName}" (${candidate.Id}) was resolved via ${selectedBy} but is not usable: ${problems.join(" ")}`,
      { tableId: candidate.Id, problems },
    );
  }

  let existingEntryCount: number | null = null;
  try {
    existingEntryCount = (await client.query(`SELECT COUNT() FROM ${BUNDLE_LOOKUP_SOURCE_OBJECT}`)).totalSize;
  } catch { /* count is diagnostic only */ }

  const resolved: ResolvedBundleLookupTable = {
    id: candidate.Id,
    developerName: candidate.DeveloperName,
    label: candidate.SetupName ?? candidate.MasterLabel ?? candidate.DeveloperName,
    sourceObject: candidate.SourceObject ?? BUNDLE_LOOKUP_SOURCE_OBJECT,
    status: candidate.Status ?? "Active",
    usageType: candidate.UsageType ?? null,
    refreshStatus: candidate.RefreshStatus ?? null,
    lastSyncDate: candidate.LastSyncDate ?? null,
    selectedBy, reason, recipe, inputs, outputs, existingEntryCount,
  };
  bundleLog(client, "lookup-table-resolved", {
    tableId: resolved.id, developerName: resolved.developerName, selectedBy, reason,
    inputs: inputs.map(i => `${i.fieldName}(${i.operator ?? "?"})`), outputs, existingEntryCount,
  });
  return resolved;
}

/**
 * Refreshes the resolved table so rows created/updated this run are visible to pricing, then waits until
 * Salesforce reports the refresh finished. Returns the terminal status; never throws for a slow refresh —
 * the caller decides whether a non-Completed status is fatal.
 */
export async function refreshAndAwaitBundleLookupTable(
  client: SalesforceClient,
  table: ResolvedBundleLookupTable,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ refreshed: boolean; finalStatus: string | null; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3_000;
  try {
    const res = await client.request<{ isSuccess?: boolean; errors?: { message?: string }[]; outputValues?: { Status?: string; ErrorMessage?: string } }[]>(
      "/actions/standard/refreshDecisionTable",
      { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableApiName: table.developerName }] }) },
    );
    const first = Array.isArray(res) ? res[0] : undefined;
    if (first && first.isSuccess === false) {
      const error = first.errors?.map(e => e.message).join("; ") || first.outputValues?.ErrorMessage || "refreshDecisionTable returned isSuccess=false";
      bundleLog(client, "lookup-table-refresh-failed", { tableId: table.id, error });
      return { refreshed: false, finalStatus: null, error };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    bundleLog(client, "lookup-table-refresh-failed", { tableId: table.id, error });
    return { refreshed: false, finalStatus: null, error };
  }

  const deadline = Date.now() + timeoutMs;
  let status: string | null = null;
  while (Date.now() < deadline) {
    const rows = await queryDecisionTables(client, `Id = '${soqlEscape(table.id)}'`);
    status = rows[0]?.RefreshStatus ?? null;
    if (status === "Completed" || status === "CompletedWithWarnings" || status === "Failed") break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  bundleLog(client, "lookup-table-refreshed", { tableId: table.id, developerName: table.developerName, finalStatus: status });
  return { refreshed: status === "Completed" || status === "CompletedWithWarnings", finalStatus: status };
}
