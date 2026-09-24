/**
 * Deterministic Decision Table resolution for the three specific, user-named semantic target tables that
 * `ListPrice`/`VolumeTierDiscount`/`VolumeDiscount` steps must bind to:
 *
 *   ListPrice             -> "Price Book Entries V2"
 *   VolumeTierDiscount    -> "Tiered Adjustment Entries"
 *   VolumeDiscount        -> "Volume Discount Entries"
 *
 * §Live-org fix — replaces the fuzzy discovery each of `tier-based`/`volume-based`'s own `canvasBuilder.ts`
 * used to do independently (a DeveloperName candidate-list match, falling through to a SourceObject regex,
 * falling through to "first row"): on an org with MULTIPLE similarly-shaped Decision Tables for adjacent
 * pricing purposes (e.g. "Rate Adjustment by Volume Entries" / "Rate Adjustment by Tier Entries" / "Contract
 * Pricing Volume Tiers" alongside the real "Volume Discount Entries"/"Tiered Adjustment Entries"), that
 * fuzzy search could silently select the WRONG table — it only needed to match ONE candidate name or ONE
 * SourceObject regex, never proving uniqueness.
 *
 * §Live-org fix #2 (execution TBP-20260923-120316-D114) — a first version of this module hard-assumed the
 * semantic display name IS the literal `MasterLabel` value (`WHERE MasterLabel = 'Price Book Entries V2'`)
 * and failed when that org returned zero rows. That assumption was wrong to bake in as the ONLY signal:
 * `lib/pricing-rules/attribute-based/create/decisionTableRefresh.ts`'s own `refreshAttributeDiscountEntries`
 * already documents, for this SAME standard object, a real Salesforce quirk this codebase has hit before —
 * `MasterLabel` can come back as the generic placeholder `"Decision Tables"` for every row, with the REAL,
 * human-meaningful identity living in `DeveloperName` (or `SetupName`, a third, distinct required setup
 * identifier the same file's own comments document) instead. This module now tries multiple REAL identity
 * fields, in priority order, against the semantic name — MasterLabel first (cheapest, most direct when it
 * works), then DeveloperName (exact, then normalized), then SetupName (exact, then normalized) — never a
 * substring/LIKE search across the WHOLE object, only exact-or-normalized-exact comparisons against the ONE
 * specific semantic name a caller requested. A tier that finds 2+ matches is immediately ambiguous and never
 * falls through to a weaker signal (that would risk silently picking one of candidates just proven
 * indistinguishable). If NO tier matches anything, the full row inventory (every DecisionTable this org
 * exposes, with every identity field available) is included in the failure diagnostic so a human can see
 * the actual ground truth instead of being told only "not found."
 *
 * Named per-target functions (not a single function taking an arbitrary label string) are exported
 * deliberately: a call site can only ever request one of the three real target tables — there is no
 * parameter a caller could typo or swap to accidentally cross-map (e.g. Volume-Based resolving "Tiered
 * Adjustment Entries"), which is real defense-in-depth expressed as a structural guarantee rather than a
 * runtime assertion.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";

export const PRICE_BOOK_DECISION_TABLE_LABEL = "Price Book Entries V2";
export const TIERED_ADJUSTMENT_DECISION_TABLE_LABEL = "Tiered Adjustment Entries";
export const VOLUME_DISCOUNT_DECISION_TABLE_LABEL = "Volume Discount Entries";

/**
 * §Soft corroboration only, NEVER the identity decision — the identity decision is made by
 * `findUniqueMatch` below. These patterns are the SAME SourceObject expectations the prior fuzzy resolvers
 * already used (real, previously-working signal — not a fresh guess): Price Book Entries V2 is expected to
 * derive from `PricebookEntry`; both Tiered Adjustment Entries and Volume Discount Entries are expected to
 * derive from `PriceAdjustmentTier` (the exact object this pipeline's own `PriceAdjustmentTier` records
 * feed). A SourceObject that is PRESENT but does not match is treated as real, fatal evidence of a
 * wrong-purpose table — but a MISSING SourceObject field/value (some orgs don't expose it, or it's simply
 * not populated) is never treated as a mismatch, only as "unverifiable."
 */
const EXPECTED_SOURCE_OBJECT_PATTERNS: Record<string, RegExp> = {
  [PRICE_BOOK_DECISION_TABLE_LABEL]: /pricebook/i,
  [TIERED_ADJUSTMENT_DECISION_TABLE_LABEL]: /priceadjustmenttier/i,
  [VOLUME_DISCOUNT_DECISION_TABLE_LABEL]: /priceadjustmenttier/i,
};

export interface ExactDecisionTableRecord {
  id: string;
  masterLabel: string | null;
  developerName: string | null;
  sourceObject: string | null;
  setupName: string | null;
}

export type DecisionTableMatchMechanism =
  | "exact-master-label" | "exact-developer-name" | "normalized-developer-name"
  | "exact-setup-name" | "normalized-setup-name";

export type ExactDecisionTableResolution =
  | { status: "resolved"; table: ExactDecisionTableRecord; mechanism: DecisionTableMatchMechanism }
  | { status: "not-found"; targetSemanticName: string; reason: string; allTables: ExactDecisionTableRecord[] }
  | { status: "ambiguous"; targetSemanticName: string; reason: string; candidates: ExactDecisionTableRecord[] }
  | { status: "source-object-mismatch"; targetSemanticName: string; reason: string; table: ExactDecisionTableRecord };

interface RawDecisionTableRow extends Record<string, unknown> { Id: string; MasterLabel?: string; DeveloperName?: string; SourceObject?: string; SetupName?: string }

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toRecord(r: RawDecisionTableRow, has: { masterLabel: boolean; developerName: boolean; sourceObject: boolean; setupName: boolean }): ExactDecisionTableRecord {
  return {
    id: r.Id,
    masterLabel: has.masterLabel ? (r.MasterLabel ?? null) : null,
    developerName: has.developerName ? (r.DeveloperName ?? null) : null,
    sourceObject: has.sourceObject ? (r.SourceObject ?? null) : null,
    setupName: has.setupName ? (r.SetupName ?? null) : null,
  };
}

/** One matching tier: a field accessor + comparison mode. Tried in array order; the first tier that finds
 * ANY match (1 or more) decides the outcome — 1 match resolves, 2+ matches is immediately ambiguous, 0
 * matches falls through to the next tier. Never falls through past a tier that found 2+ matches. */
function buildMatchTiers(targetSemanticName: string): { mechanism: DecisionTableMatchMechanism; matches: (t: ExactDecisionTableRecord) => boolean }[] {
  const normalizedTarget = normalize(targetSemanticName);
  return [
    { mechanism: "exact-master-label", matches: t => t.masterLabel === targetSemanticName },
    { mechanism: "exact-developer-name", matches: t => t.developerName === targetSemanticName },
    { mechanism: "normalized-developer-name", matches: t => t.developerName !== null && normalize(t.developerName) === normalizedTarget },
    { mechanism: "exact-setup-name", matches: t => t.setupName === targetSemanticName },
    { mechanism: "normalized-setup-name", matches: t => t.setupName !== null && normalize(t.setupName) === normalizedTarget },
  ];
}

async function fetchAllDecisionTables(client: SalesforceClient): Promise<
  | { status: "ok"; tables: ExactDecisionTableRecord[]; queriedVia: "standard" | "tooling" }
  | { status: "describe-failed" | "query-failed"; reason: string }
> {
  let fieldNames: Set<string>;
  try {
    const describe = await client.describeObject("DecisionTable");
    fieldNames = new Set(describe.fields.map(f => f.name));
  } catch (err) {
    return { status: "describe-failed", reason: `Could not describe the DecisionTable object: ${err instanceof Error ? err.message : String(err)}.` };
  }
  const has = {
    masterLabel: fieldNames.has("MasterLabel"),
    developerName: fieldNames.has("DeveloperName"),
    sourceObject: fieldNames.has("SourceObject"),
    setupName: fieldNames.has("SetupName"),
  };
  const selectFields = [
    "Id",
    ...(has.masterLabel ? ["MasterLabel"] : []),
    ...(has.developerName ? ["DeveloperName"] : []),
    ...(has.sourceObject ? ["SourceObject"] : []),
    ...(has.setupName ? ["SetupName"] : []),
  ];
  const soql = `SELECT ${selectFields.join(", ")} FROM DecisionTable LIMIT 500`;

  try {
    const standardResult = await client.query<RawDecisionTableRow>(soql);
    if (standardResult.records.length > 0) {
      return { status: "ok", tables: standardResult.records.map(r => toRecord(r, has)), queriedVia: "standard" };
    }
  } catch {
    // fall through to the Tooling API attempt below
  }

  // §Live-org precedent — mirrors `refreshAttributeDiscountEntries`'s own documented fallback for this
  // SAME object: whether the standard REST /query endpoint returns real DecisionTable rows is not fully
  // documented and has been observed to come back empty on some orgs even when rows genuinely exist —
  // retried via the Tooling API before concluding "this org has zero DecisionTable records."
  try {
    const toolingResult = await client.toolingQuery<RawDecisionTableRow>(soql);
    return { status: "ok", tables: toolingResult.records.map(r => toRecord(r, has)), queriedVia: "tooling" };
  } catch (err) {
    return { status: "query-failed", reason: `Both the standard REST query and the Tooling API query for DecisionTable failed or returned nothing. Tooling API error: ${err instanceof Error ? err.message : String(err)}. SOQL: ${soql}` };
  }
}

function formatTableRow(t: ExactDecisionTableRecord): string {
  return `  [${t.id}] MasterLabel="${t.masterLabel ?? "(none)"}" DeveloperName="${t.developerName ?? "(none)"}" SetupName="${t.setupName ?? "(none)"}" SourceObject="${t.sourceObject ?? "(none)"}"`;
}

async function resolveExactDecisionTableByLabel(client: SalesforceClient, targetSemanticName: string): Promise<ExactDecisionTableResolution> {
  const fetched = await fetchAllDecisionTables(client);
  if (fetched.status !== "ok") {
    return { status: "not-found", targetSemanticName, reason: fetched.reason, allTables: [] };
  }
  const { tables } = fetched;

  for (const tier of buildMatchTiers(targetSemanticName)) {
    const matches = tables.filter(tier.matches);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        targetSemanticName,
        reason: `${matches.length} DecisionTable records all match "${targetSemanticName}" via ${tier.mechanism} (Ids: ${matches.map(m => m.id).join(", ")}) — refusing to guess which one is the real pricing table.`,
        candidates: matches,
      };
    }
    const table = matches[0];
    const expectedPattern = EXPECTED_SOURCE_OBJECT_PATTERNS[targetSemanticName];
    if (expectedPattern && table.sourceObject && !expectedPattern.test(table.sourceObject)) {
      return {
        status: "source-object-mismatch",
        targetSemanticName,
        reason: `DecisionTable "${targetSemanticName}" (Id ${table.id}, matched via ${tier.mechanism}) has SourceObject="${table.sourceObject}", which does not match this pricing purpose's expected source (${expectedPattern}) — refusing to trust a table whose own metadata contradicts its intended use.`,
        table,
      };
    }
    return { status: "resolved", table, mechanism: tier.mechanism };
  }

  return {
    status: "not-found",
    targetSemanticName,
    reason: `None of MasterLabel, DeveloperName, or SetupName on any of the ${tables.length} DecisionTable record(s) in this org matches "${targetSemanticName}" (exactly or normalized). Full inventory below — identify the correct record's DeveloperName/MasterLabel/SetupName and this resolver's candidate matching can be extended to recognize it.`,
    allTables: tables,
  };
}

export function resolvePriceBookEntriesV2DecisionTable(client: SalesforceClient): Promise<ExactDecisionTableResolution> {
  return resolveExactDecisionTableByLabel(client, PRICE_BOOK_DECISION_TABLE_LABEL);
}
export function resolveTieredAdjustmentEntriesDecisionTable(client: SalesforceClient): Promise<ExactDecisionTableResolution> {
  return resolveExactDecisionTableByLabel(client, TIERED_ADJUSTMENT_DECISION_TABLE_LABEL);
}
export function resolveVolumeDiscountEntriesDecisionTable(client: SalesforceClient): Promise<ExactDecisionTableResolution> {
  return resolveExactDecisionTableByLabel(client, VOLUME_DISCOUNT_DECISION_TABLE_LABEL);
}

/** Formats any non-"resolved" outcome into a single human-readable diagnostic string, including the full
 * candidate dump for an "ambiguous" result, the table's own fields for a "source-object-mismatch", and the
 * complete org inventory for a "not-found" (capped to keep the message bounded). */
export function formatExactDecisionTableFailure(resolution: Exclude<ExactDecisionTableResolution, { status: "resolved" }>): string {
  if (resolution.status === "ambiguous") {
    return `${resolution.reason}\n${resolution.candidates.map(formatTableRow).join("\n")}`;
  }
  if (resolution.status === "source-object-mismatch") {
    return `${resolution.reason}\n${formatTableRow(resolution.table)}`;
  }
  if (resolution.allTables.length === 0) return resolution.reason;
  const shown = resolution.allTables.slice(0, 50);
  return `${resolution.reason}\n${shown.map(formatTableRow).join("\n")}${resolution.allTables.length > shown.length ? `\n  ... and ${resolution.allTables.length - shown.length} more (truncated)` : ""}`;
}

/** Formats a before/after mapping diagnostic for a single step's LookUp* patch, including which identity
 * field actually matched (never assumed to be MasterLabel). */
export function formatDecisionTableMappingDiagnostic(input: {
  pricingTypeLabel: string;
  actionType: string;
  table: ExactDecisionTableRecord;
  mechanism: DecisionTableMatchMechanism;
  before: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null };
  after: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null };
}): string {
  const { pricingTypeLabel, actionType, table, mechanism, before, after } = input;
  return [
    `[${pricingTypeLabel}]`,
    actionType,
    "DecisionTable:",
    `    MasterLabel = ${table.masterLabel ?? "(none)"}`,
    `    DeveloperName = ${table.developerName ?? "(none)"}`,
    `    SetupName = ${table.setupName ?? "(none)"}`,
    `    Id = ${table.id}`,
    `    SourceObject = ${table.sourceObject ?? "(none)"}`,
    `    Matched via = ${mechanism}`,
    "",
    "LookUpId:",
    `    BEFORE = ${before.lookUpId ?? "(none)"}`,
    `    AFTER  = ${after.lookUpId ?? "(none)"}`,
    "",
    "LookUpApiName:",
    `    BEFORE = ${before.lookUpApiName ?? "(none)"}`,
    `    AFTER  = ${after.lookUpApiName ?? "(none)"}`,
    "",
    "LookUpName:",
    `    BEFORE = ${before.lookUpName ?? "(none)"}`,
    `    AFTER  = ${after.lookUpName ?? "(none)"}`,
  ].join("\n");
}
