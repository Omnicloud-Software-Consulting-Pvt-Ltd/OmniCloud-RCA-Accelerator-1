/**
 * §Org-wide uniqueness validation — the LAST guard before Metadata Deploy for an Attribute-Based
 * Pricing Procedure's ExpressionSetDefinition. `canvasBuilder.ts` already regenerates every envelope
 * identifier (label/fullName/developerName/name/expressionSetDefinition) from the new Pricing
 * Procedure's own name/API name and confirms none of them still equals the DONOR template's value — but
 * the donor is only ONE existing metadata file. An org can (and typically does) contain many other
 * Expression Sets, and Salesforce enforces these identifiers' uniqueness across ALL of them, not just
 * against whichever one happened to be cloned as a donor.
 *
 * §Metadata identity — an existing ExpressionSet with the SAME DeveloperName is NEVER, by itself, proof
 * that this run is a safe update: the real metadata identity is the (ExpressionSet, Version) PAIR. When
 * an ExpressionSet already exists, its linked ExpressionSetVersion records are fetched and compared
 * against the GENERATED version's own identity (DeveloperName/Name-as-fullName), producing exactly one
 * of three outcomes:
 *   Case A — the generated version matches an EXISTING version under THIS SAME ExpressionSet -> update
 *            that version in place.
 *   Case B — no existing version (under this ExpressionSet) matches the generated version -> a new
 *            version is being legitimately added to an existing procedure.
 *   Case C — the generated version's identity matches an existing ExpressionSetVersion that belongs to
 *            a DIFFERENT ExpressionSet -> a genuine cross-record collision; stop before deployment.
 *
 * §No inferred VersionNumber — this module never derives a numeric version identifier by parsing a
 * generated string. `VersionNumber` is used ONLY as real, Salesforce-reported data — to enrich the
 * report and to raise this validator's CONFIDENCE — never as a match key compared against a value we
 * invented.
 *
 * Never modifies XML generation or deployment logic — this is a pure pre-flight read/compare.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export interface OrgIdentifierConflict {
  identifier: string;
  existingRecordId: string;
  generatedValue: string;
  conflictingMetadataType: "ExpressionSet" | "ExpressionSetVersion";
}

export type VersionIdentityDecision =
  | "create-new-expression-set"
  | "update-existing-version"
  | "create-new-version"
  | "duplicate-version-conflict"
  | "version-identity-unknown";

export type VersionIdentityConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface OrgUniquenessResult {
  ok: boolean;
  /** True ONLY for Case A (`decision === "update-existing-version"`) — an ACTUAL matching version was found under the SAME ExpressionSet, never inferred from a matching DeveloperName alone. */
  isUpdate: boolean;
  decision: VersionIdentityDecision;
  confidence: VersionIdentityConfidence;
  existingExpressionSetId: string | null;
  /** The specific ExpressionSetVersion this run will update in place — set only for Case A. */
  matchedVersionId: string | null;
  conflicts: OrgIdentifierConflict[];
  report: string;
}

export class OrgUniquenessConflictError extends Error {
  readonly result: OrgUniquenessResult;
  constructor(result: OrgUniquenessResult) {
    super(result.report);
    this.name = "OrgUniquenessConflictError";
    this.result = result;
  }
}

export interface OrgUniquenessCheckArgs {
  /** The new Pricing Procedure's own API Name / DeveloperName (never the donor's). */
  apiName: string;
  /** Every regenerated `fullName` value from the canvas build — the actual, version-suffixed PER-VERSION
   * identity. Deliberately EXCLUDES `expressionSetDefinition` (the version's back-reference to its
   * PARENT ExpressionSetDefinition, regenerated as the bare `apiName` with NO version suffix by design —
   * it must stay identical across every version). Including that parent reference here was the confirmed
   * root cause of a false collision: it always matches whichever existing version happens to have been
   * created before a version suffix was ever added to its own identity, regardless of which NEW version
   * is actually being generated. */
  generatedFullNames: string[];
  generatedLabel: string | null;
}

function dedupe(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))];
}

interface ExistingVersionRow {
  id: string;
  expressionSetId: string | null;
  /** §Root cause fix — Salesforce's own documented ExpressionSet/ExpressionSetVersion SObject schema
   * (developer.salesforce.com/.../sforce_api_objects_expressionset.htm) confirms the real, unique
   * identity field on BOTH objects is `ApiName` — there is no `DeveloperName` field on either object at
   * all. The prior code only ever checked for `DeveloperName`, which Describe correctly reports as
   * absent — so the existing-ExpressionSet lookup was silently skipped on EVERY run, always reporting
   * "no existing ExpressionSet found" regardless of what actually exists. `apiName` is now the PRIMARY
   * match field; `developerName` is kept (Describe-gated, never assumed) only in case some other org
   * variant genuinely exposes it. */
  apiName: string | null;
  developerName: string | null;
  name: string | null;
  versionNumber: string | null;
  label: string | null;
  /** Real, documented boolean field on `ExpressionSetVersion` (confirmed in `activation.ts`'s own
   * `pickActiveField` research) — Describe-gated the same way, never assumed present. */
  isActive: boolean | null;
  /** §Rank — real, documented field on the `ExpressionSetDefinitionVersion` metadata type (Salesforce
   * Metadata API Developer Guide, API v62.0+: "the version with the highest rank is chosen" among
   * overlapping enabled versions). Salesforce enforces this as a UNIQUE-per-ExpressionSet value at
   * deploy time — a deploy that omits it (or reuses an already-taken value) is rejected with "Assign a
   * unique rank to expression set version ... and try again." Describe-gated like every other field
   * here — never assumed present on an org whose API version predates it. */
  rank: number | null;
}

function formatVersionRow(v: ExistingVersionRow): string {
  return `Id=${v.id}, ApiName=${v.apiName ?? "(n/a)"}, Name=${v.name ?? "(n/a)"}, VersionNumber=${v.versionNumber ?? "(n/a)"}, Label=${v.label ?? "(n/a)"}, IsActive=${v.isActive === null ? "(n/a)" : v.isActive}, Rank=${v.rank ?? "(n/a)"}`;
}

function formatReport(args: {
  apiName: string;
  generatedFullNames: string[];
  generatedLabel: string | null;
  decision: VersionIdentityDecision;
  confidence: VersionIdentityConfidence;
  existingExpressionSetId: string | null;
  existingExpressionSetDeveloperName: string | null;
  ownVersions: ExistingVersionRow[];
  matchedVersionId: string | null;
  conflicts: OrgIdentifierConflict[];
  fieldsChecked: { object: string; fields: string[] }[];
}): string {
  const decisionLabel: Record<VersionIdentityDecision, string> = {
    "create-new-expression-set": "CREATE — no existing ExpressionSet found with this ApiName; a brand-new ExpressionSet and Version will be created.",
    "update-existing-version": `UPDATE EXISTING VERSION — the generated version matches existing ExpressionSetVersion ${args.matchedVersionId} under this same ExpressionSet.`,
    "create-new-version": "CREATE NEW VERSION — the ExpressionSet already exists, but no existing Version matches the generated version; a new Version will be added to it.",
    "duplicate-version-conflict": "DUPLICATE — the generated version's identity matches an existing ExpressionSetVersion that belongs to a DIFFERENT ExpressionSet. Stopping before deployment.",
    "version-identity-unknown": "UNKNOWN — this org's ExpressionSetVersion schema exposes no VersionNumber, ApiName, DeveloperName, or Name field to compare against; version identity could not be determined and was never guessed. Proceeding (never blocks deployment on an unverifiable comparison).",
  };
  const confidenceExplanation: Record<VersionIdentityConfidence, string> = {
    HIGH: "VersionNumber exists on this org — real, Salesforce-reported version data corroborates the ApiName/Name match.",
    MEDIUM: "Matched by ApiName/DeveloperName/Name only — VersionNumber does not exist on this org, so no extra numeric corroboration is available.",
    LOW: "No version identity field (VersionNumber, ApiName, DeveloperName, or Name) exists on this org's ExpressionSetVersion — identity is UNKNOWN, never inferred.",
  };
  return [
    "==================================================",
    "EXPRESSION SET DEFINITION — METADATA IDENTITY RESOLUTION",
    "==================================================",
    `ExpressionSet Id: ${args.existingExpressionSetId ?? "(none — no existing ExpressionSet found)"}`,
    `ApiName: ${args.existingExpressionSetDeveloperName ?? args.apiName}`,
    "",
    "Existing Versions (fetched for this ExpressionSet):",
    ...(args.ownVersions.length > 0 ? args.ownVersions.map(v => `  - ${formatVersionRow(v)}`) : ["  (none — either no ExpressionSet exists yet, or it has zero versions)"]),
    "",
    "Generated Version:",
    `  FullName(s): ${args.generatedFullNames.join(", ") || "(none)"}`,
    `  Label: ${args.generatedLabel ?? "(none)"}`,
    `  API Name: ${args.apiName}`,
    "  Version Number: (not generated — never inferred by parsing a string; see Confidence below for how VersionNumber factors in)",
    "",
    `Decision: ${args.decision}`,
    `  ${decisionLabel[args.decision]}`,
    "",
    `Confidence: ${args.confidence}`,
    `  ${confidenceExplanation[args.confidence]}`,
    "",
    "Fields checked (Describe-confirmed present on this org — a field not listed here doesn't exist on this org's object and was never queried):",
    ...args.fieldsChecked.map(f => `  ${f.object}: ${f.fields.length > 0 ? f.fields.join(", ") : "(none of the candidate fields exist on this object — that check was skipped entirely)"}`),
    "",
    args.conflicts.length > 0 ? `CONFLICTS FOUND (${args.conflicts.length}):` : "No conflicts found.",
    ...args.conflicts.flatMap(c => [
      `  Identifier: ${c.identifier}`,
      `  Existing Record: ${c.existingRecordId}`,
      `  Generated Value: ${c.generatedValue}`,
      `  Conflicting Metadata Type: ${c.conflictingMetadataType}`,
      "",
    ]),
    "==================================================",
  ].join("\n");
}

interface ExistingExpressionSetState {
  existingExpressionSetId: string | null;
  existingExpressionSetDeveloperName: string | null;
  ownVersions: ExistingVersionRow[];
  evHasApiName: boolean;
  evHasDeveloperName: boolean;
  evHasName: boolean;
  evHasExpressionSetId: boolean;
  evHasVersionNumber: boolean;
  evHasMasterLabel: boolean;
  evHasIsActive: boolean;
  evHasRank: boolean;
  fieldsChecked: { object: string; fields: string[] }[];
  conflicts: OrgIdentifierConflict[];
}

function evRowSelectAndMapper(
  evHasExpressionSetId: boolean, evHasApiName: boolean, evHasDeveloperName: boolean, evHasName: boolean,
  evHasVersionNumber: boolean, evHasMasterLabel: boolean, evHasIsActive: boolean, evHasRank = false,
) {
  const evSelect = [
    "Id",
    ...(evHasExpressionSetId ? ["ExpressionSetId"] : []),
    ...(evHasApiName ? ["ApiName"] : []),
    ...(evHasDeveloperName ? ["DeveloperName"] : []),
    ...(evHasName ? ["Name"] : []),
    ...(evHasVersionNumber ? ["VersionNumber"] : []),
    ...(evHasMasterLabel ? ["MasterLabel"] : []),
    ...(evHasIsActive ? ["IsActive"] : []),
    ...(evHasRank ? ["Rank"] : []),
  ];
  const toRow = (rec: Record<string, unknown> & { Id: string }): ExistingVersionRow => ({
    id: rec.Id,
    expressionSetId: evHasExpressionSetId ? (rec.ExpressionSetId as string | undefined) ?? null : null,
    apiName: evHasApiName ? (rec.ApiName as string | undefined) ?? null : null,
    developerName: evHasDeveloperName ? (rec.DeveloperName as string | undefined) ?? null : null,
    name: evHasName ? (rec.Name as string | undefined) ?? null : null,
    versionNumber: evHasVersionNumber ? String(rec.VersionNumber ?? "") || null : null,
    label: evHasMasterLabel ? (rec.MasterLabel as string | undefined) ?? null : null,
    isActive: evHasIsActive ? (rec.IsActive as boolean | undefined) ?? null : null,
    rank: evHasRank && rec.Rank !== undefined && rec.Rank !== null && Number.isFinite(Number(rec.Rank)) ? Number(rec.Rank) : null,
  });
  return { evSelect, toRow };
}

/**
 * §Shared lookup — fetches whatever ExpressionSet already exists under `apiName` and every
 * ExpressionSetVersion already deployed under it, purely by Describe-confirmed fields (never assuming a
 * field exists). Factored out so both the post-build conflict check below AND the pre-build
 * next-version-number resolution (`resolveNextExpressionSetVersionNumber`, used by `createPipeline.ts`
 * BEFORE the canvas is generated, so the generated version's own identity can avoid colliding with an
 * existing one) share the exact same org read instead of two subtly different queries.
 *
 * §Root cause fix (confirmed via Salesforce's own documented SObject reference) — `ExpressionSet` and
 * `ExpressionSetVersion` do NOT have a `DeveloperName` field at all; their real, unique identity field is
 * `ApiName`. The prior version of this function checked ONLY `DeveloperName`, which Describe correctly
 * reported absent on every real org — so `existingExpressionSetId` was NEVER resolved, regardless of
 * whether a matching ExpressionSet genuinely existed, and every build silently believed it was creating
 * Version 1 even when an active V1 (or later) already existed. `ApiName` is now the PRIMARY match field;
 * `DeveloperName`/`Name`/`MasterLabel` remain as Describe-gated secondary candidates, never assumed.
 */
async function fetchExistingExpressionSetState(
  client: SalesforceClient,
  apiName: string,
  generatedLabel: string | null,
): Promise<ExistingExpressionSetState> {
  const conflicts: OrgIdentifierConflict[] = [];
  const fieldsChecked: { object: string; fields: string[] }[] = [];

  const esDescribe = await client.describeObject("ExpressionSet");
  const esFieldNames = new Set(esDescribe.fields.map(f => f.name));
  const esHasApiName = esFieldNames.has("ApiName");
  const esHasDeveloperName = esFieldNames.has("DeveloperName");
  const esHasName = esFieldNames.has("Name");
  const esHasMasterLabel = esFieldNames.has("MasterLabel");
  const esCheckedFields = [esHasApiName && "ApiName", esHasDeveloperName && "DeveloperName", esHasName && "Name", esHasMasterLabel && "MasterLabel"].filter((v): v is string => !!v);
  fieldsChecked.push({ object: "ExpressionSet", fields: esCheckedFields });

  let existingExpressionSetId: string | null = null;
  let existingExpressionSetDeveloperName: string | null = null;
  if (esHasApiName || esHasDeveloperName) {
    const esSelect = ["Id", ...(esHasApiName ? ["ApiName"] : []), ...(esHasDeveloperName ? ["DeveloperName"] : []), ...(esHasName ? ["Name"] : []), ...(esHasMasterLabel ? ["MasterLabel"] : [])];
    const esWhereClauses: string[] = [];
    if (esHasApiName) esWhereClauses.push(`ApiName = '${soqlEscape(apiName)}'`);
    if (esHasDeveloperName) esWhereClauses.push(`DeveloperName = '${soqlEscape(apiName)}'`);
    if (esHasName) esWhereClauses.push(`Name = '${soqlEscape(apiName)}'`);
    if (esHasMasterLabel && generatedLabel) esWhereClauses.push(`MasterLabel = '${soqlEscape(generatedLabel)}'`);
    const res = await client.query<{ Id: string; ApiName?: string; DeveloperName?: string; Name?: string; MasterLabel?: string }>(
      `SELECT ${esSelect.join(", ")} FROM ExpressionSet WHERE ${esWhereClauses.join(" OR ")} LIMIT 200`,
    );
    const matchesOwn = (rec: { ApiName?: string; DeveloperName?: string }) => (esHasApiName && rec.ApiName === apiName) || (esHasDeveloperName && rec.DeveloperName === apiName);
    const ownRecord = res.records.find(matchesOwn);
    if (ownRecord) { existingExpressionSetId = ownRecord.Id; existingExpressionSetDeveloperName = ownRecord.ApiName ?? ownRecord.DeveloperName ?? null; }

    for (const rec of res.records) {
      if (rec.Id === existingExpressionSetId) continue;
      if (matchesOwn(rec)) {
        conflicts.push({ identifier: "Expression Set API Name", existingRecordId: rec.Id, generatedValue: apiName, conflictingMetadataType: "ExpressionSet" });
      }
      if (esHasName && rec.Name === apiName) {
        conflicts.push({ identifier: "Internal Name", existingRecordId: rec.Id, generatedValue: apiName, conflictingMetadataType: "ExpressionSet" });
      }
    }
  } else {
    fieldsChecked[0].fields.push("(neither ApiName nor DeveloperName found via Describe — Expression Set uniqueness check skipped entirely)");
  }

  const evDescribe = await client.describeObject("ExpressionSetVersion");
  const evFieldNames = new Set(evDescribe.fields.map(f => f.name));
  const evHasApiName = evFieldNames.has("ApiName");
  const evHasDeveloperName = evFieldNames.has("DeveloperName");
  const evHasName = evFieldNames.has("Name");
  const evHasExpressionSetId = evFieldNames.has("ExpressionSetId");
  const evHasVersionNumber = evFieldNames.has("VersionNumber");
  const evHasMasterLabel = evFieldNames.has("MasterLabel");
  const evHasIsActive = evFieldNames.has("IsActive");
  const evHasRank = evFieldNames.has("Rank");
  const evCheckedFields = [
    evHasApiName && "ApiName", evHasDeveloperName && "DeveloperName", evHasName && "Name", evHasExpressionSetId && "ExpressionSetId",
    evHasVersionNumber && "VersionNumber", evHasMasterLabel && "MasterLabel", evHasIsActive && "IsActive", evHasRank && "Rank",
  ].filter((v): v is string => !!v);
  fieldsChecked.push({ object: "ExpressionSetVersion", fields: evCheckedFields });

  const { evSelect, toRow } = evRowSelectAndMapper(evHasExpressionSetId, evHasApiName, evHasDeveloperName, evHasName, evHasVersionNumber, evHasMasterLabel, evHasIsActive, evHasRank);

  let ownVersions: ExistingVersionRow[] = [];
  if (existingExpressionSetId && evHasExpressionSetId) {
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE ExpressionSetId = '${soqlEscape(existingExpressionSetId)}'`,
    );
    ownVersions = res.records.map(toRow);
  }

  return {
    existingExpressionSetId, existingExpressionSetDeveloperName, ownVersions,
    evHasApiName, evHasDeveloperName, evHasName, evHasExpressionSetId, evHasVersionNumber, evHasMasterLabel, evHasIsActive, evHasRank,
    fieldsChecked, conflicts,
  };
}

export interface NextExpressionSetVersionResolution {
  existingExpressionSetId: string | null;
  /** The real, Describe-confirmed identity value (ApiName, falling back to DeveloperName) Salesforce
   * reports for the existing ExpressionSet, or `null` if none exists. */
  existingExpressionSetIdentity: string | null;
  existingVersionCount: number;
  /** Every existing version under this ExpressionSet, exactly as Salesforce reports it — for rich
   * lifecycle logging (Section 9's exact requested diagnostic sequence), never re-derived or guessed. */
  existingVersions: { id: string; versionNumber: string | null; isActive: boolean | null }[];
  /** Highest `VersionNumber` Salesforce actually reports across this ExpressionSet's own versions, or
   * null if the org's ExpressionSetVersion has no VersionNumber field (never guessed in that case). */
  highestExistingVersionNumber: number | null;
  /** `(highestExistingVersionNumber ?? existingVersionCount) + 1`, or `1` when nothing exists yet.
   * Falls back to counting rows (not parsing any generated string) when VersionNumber isn't queryable. */
  nextVersionNumber: number;
  versionNumberFieldExists: boolean;
  isActiveFieldExists: boolean;
}

/**
 * §Section 6 — resolves the version number a NEW build should target, BEFORE the canvas/XML is
 * generated, so the generated version's own `fullName`/`developerName` identity is built to be the NEXT
 * version rather than reproducing whatever numeric suffix happened to exist on the DONOR template
 * (the confirmed root cause of every repeated creation silently updating the same V1 in place). Read-only
 * — never creates, updates, or deletes anything.
 *
 * §Root cause fix — this previously always reported "no existing ExpressionSet found" because
 * `fetchExistingExpressionSetState` only ever checked for a `DeveloperName` field, which Salesforce's own
 * documented schema confirms does NOT exist on `ExpressionSet`/`ExpressionSetVersion` at all (the real,
 * unique identity field is `ApiName`). That's fixed at the shared-lookup level (`fetchExistingExpressionSetState`
 * now checks `ApiName` first) — this function's own logic is unchanged, it just now receives correct data.
 */
export async function resolveNextExpressionSetVersionNumber(
  client: SalesforceClient,
  apiName: string,
): Promise<NextExpressionSetVersionResolution> {
  const state = await fetchExistingExpressionSetState(client, apiName, null);
  const numericVersionNumbers = state.evHasVersionNumber
    ? state.ownVersions.map(v => Number(v.versionNumber)).filter(n => Number.isFinite(n))
    : [];
  const highestExistingVersionNumber = numericVersionNumbers.length > 0 ? Math.max(...numericVersionNumbers) : null;
  const nextVersionNumber = state.ownVersions.length === 0
    ? 1
    : (highestExistingVersionNumber ?? state.ownVersions.length) + 1;
  return {
    existingExpressionSetId: state.existingExpressionSetId,
    existingExpressionSetIdentity: state.existingExpressionSetDeveloperName,
    existingVersionCount: state.ownVersions.length,
    existingVersions: state.ownVersions.map(v => ({ id: v.id, versionNumber: v.versionNumber, isActive: v.isActive })),
    highestExistingVersionNumber,
    nextVersionNumber,
    versionNumberFieldExists: state.evHasVersionNumber,
    isActiveFieldExists: state.evHasIsActive,
  };
}

export interface ExpressionSetVersionInventoryEntry {
  id: string;
  apiName: string | null;
  developerName: string | null;
  name: string | null;
  versionNumber: number | null;
  isActive: boolean | null;
  /** §Rank — see `ExistingVersionRow.rank`. `null` only when this org's ExpressionSetVersion schema
   * has no Rank field at all (see `rankFieldExists`) — never a placeholder for "unset". */
  rank: number | null;
}

export interface ExpressionSetVersionInventory {
  existingExpressionSetId: string | null;
  existingExpressionSetIdentity: string | null;
  versions: ExpressionSetVersionInventoryEntry[];
  versionNumberFieldExists: boolean;
  isActiveFieldExists: boolean;
  rankFieldExists: boolean;
  fieldsChecked: { object: string; fields: string[] }[];
}

/**
 * §Section 3 — ONE authoritative query of the org's real ExpressionSetVersion state. Both next-version
 * calculation and collision detection call THIS, never two independent queries that could resolve to
 * different "existing ExpressionSet" records (e.g. if the org has more than one ExpressionSet record
 * whose ApiName/Name happens to match, an unordered SOQL result could hand back a different one on two
 * separate calls) or observe different point-in-time snapshots of the version list.
 */
export async function getExpressionSetVersionInventory(client: SalesforceClient, apiName: string): Promise<ExpressionSetVersionInventory> {
  const state = await fetchExistingExpressionSetState(client, apiName, null);
  return {
    existingExpressionSetId: state.existingExpressionSetId,
    existingExpressionSetIdentity: state.existingExpressionSetDeveloperName,
    versions: state.ownVersions.map(v => ({
      id: v.id, apiName: v.apiName, developerName: v.developerName, name: v.name,
      versionNumber: v.versionNumber !== null && Number.isFinite(Number(v.versionNumber)) ? Number(v.versionNumber) : null,
      isActive: v.isActive,
      rank: v.rank,
    })),
    versionNumberFieldExists: state.evHasVersionNumber,
    isActiveFieldExists: state.evHasIsActive,
    rankFieldExists: state.evHasRank,
    fieldsChecked: state.fieldsChecked,
  };
}

/**
 * §Root cause of the "resolver says only V1, collision check finds V2" contradiction — a candidate
 * computed as `(highest version already IN a query result) + 1` can, BY CONSTRUCTION, never appear
 * inside that SAME query's own results, no matter how many times that exact query is re-run. That query
 * (`ExpressionSetVersion WHERE ExpressionSetId = '<id>'`) is scoped by the PARENT ExpressionSet's Id — if
 * the real target version happens to be reachable through the org's OWN identity fields
 * (ApiName/DeveloperName/Name) but not, for whatever reason, through that particular relationship-scoped
 * query at that moment, self-consistency within one query can never catch it. A genuinely independent
 * check — does ANYTHING in the org, found by searching directly for this candidate identity STRING,
 * already exist? — is required, and is exactly the query `validateExpressionSetUniquenessAgainstOrg`'s
 * own collision detection already runs. This is that SAME check, factored out so the pre-build resolver
 * can run it too, BEFORE ever committing to a candidate.
 */
async function checkExpressionSetVersionIdentityExists(client: SalesforceClient, candidateIdentity: string): Promise<ExpressionSetVersionInventoryEntry | null> {
  const evDescribe = await client.describeObject("ExpressionSetVersion");
  const evFieldNames = new Set(evDescribe.fields.map(f => f.name));
  const evHasApiName = evFieldNames.has("ApiName");
  const evHasDeveloperName = evFieldNames.has("DeveloperName");
  const evHasName = evFieldNames.has("Name");
  const evHasVersionNumber = evFieldNames.has("VersionNumber");
  const evHasIsActive = evFieldNames.has("IsActive");
  const evHasRank = evFieldNames.has("Rank");
  if (!evHasApiName && !evHasDeveloperName && !evHasName) return null;

  const orClauses: string[] = [];
  if (evHasApiName) orClauses.push(`ApiName = '${soqlEscape(candidateIdentity)}'`);
  if (evHasDeveloperName) orClauses.push(`DeveloperName = '${soqlEscape(candidateIdentity)}'`);
  if (evHasName) orClauses.push(`Name = '${soqlEscape(candidateIdentity)}'`);
  const { evSelect, toRow } = evRowSelectAndMapper(true, evHasApiName, evHasDeveloperName, evHasName, evHasVersionNumber, false, evHasIsActive, evHasRank);
  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE ${orClauses.join(" OR ")} LIMIT 10`,
  );
  const row = res.records.map(toRow).find(v =>
    (evHasApiName && v.apiName === candidateIdentity) || (evHasDeveloperName && v.developerName === candidateIdentity) || (evHasName && v.name === candidateIdentity),
  );
  if (!row) return null;
  return {
    id: row.id, apiName: row.apiName, developerName: row.developerName, name: row.name,
    versionNumber: row.versionNumber !== null && Number.isFinite(Number(row.versionNumber)) ? Number(row.versionNumber) : null,
    isActive: row.isActive,
    rank: row.rank,
  };
}

/**
 * §Part 1/12 — "do not assume Rank only needs to be unique within this one ExpressionSet." Live
 * evidence (Rank=2, proven unused among THIS ExpressionSet's own reported versions, still rejected by
 * Salesforce with "Assign a unique rank ... and try again.") means the per-ExpressionSet-scoped
 * uniqueness check alone is not sufficient — this is a genuinely INDEPENDENT, org-wide (never scoped by
 * ExpressionSetId) search for any ExpressionSetVersion record anywhere in the org that already carries
 * the candidate Rank value. Mirrors `checkExpressionSetVersionIdentityExists` exactly, for the same
 * reason: never trust "not found inside the one relationship-scoped query the candidate was computed
 * from" as proof of anything.
 */
async function checkExpressionSetVersionRankExists(client: SalesforceClient, rank: number): Promise<ExistingVersionRow | null> {
  const evDescribe = await client.describeObject("ExpressionSetVersion");
  const evFieldNames = new Set(evDescribe.fields.map(f => f.name));
  if (!evFieldNames.has("Rank")) return null;
  const evHasExpressionSetId = evFieldNames.has("ExpressionSetId");
  const evHasApiName = evFieldNames.has("ApiName");
  const evHasDeveloperName = evFieldNames.has("DeveloperName");
  const evHasName = evFieldNames.has("Name");
  const evHasVersionNumber = evFieldNames.has("VersionNumber");
  const evHasIsActive = evFieldNames.has("IsActive");
  const { evSelect, toRow } = evRowSelectAndMapper(evHasExpressionSetId, evHasApiName, evHasDeveloperName, evHasName, evHasVersionNumber, false, evHasIsActive, true);
  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE Rank = ${rank} LIMIT 10`,
  );
  return res.records.map(toRow).find(v => v.rank === rank) ?? null;
}

function computeNextVersionFromInventory(inventory: ExpressionSetVersionInventory): number {
  const numbers = inventory.versions.map(v => v.versionNumber).filter((n): n is number => n !== null);
  if (numbers.length > 0) return Math.max(...numbers) + 1;
  return inventory.versions.length === 0 ? 1 : inventory.versions.length + 1;
}

/**
 * §Part 1 — "the lowest valid unused positive integer", exactly as specified: ranks {1} -> 2;
 * ranks {1,2,4} -> 3; ranks {1,2,3} -> 4. Never `max(existingRanks) + 1` — that would skip the gap at
 * 3 in the {1,2,4} example. Rank is Salesforce's own per-ExpressionSet uniqueness constraint on
 * `ExpressionSetDefinitionVersion` (Metadata API, v62.0+) — this never guesses a value, it only ever
 * picks the lowest one Salesforce's own reported existing ranks prove is not already taken.
 */
function computeLowestUnusedRank(existingRanks: number[]): number {
  const used = new Set(existingRanks);
  let candidate = 1;
  while (used.has(candidate)) candidate++;
  return candidate;
}

function buildCandidateExpressionSetVersionIdentity(apiName: string, versionNumber: number): string {
  return `${apiName}_V${versionNumber}`;
}

function findMatchingInventoryEntry(inventory: ExpressionSetVersionInventory, candidateIdentity: string): ExpressionSetVersionInventoryEntry | null {
  return inventory.versions.find(v => v.apiName === candidateIdentity || v.developerName === candidateIdentity || v.name === candidateIdentity) ?? null;
}

export interface ResolveNextAvailableVersionAttempt {
  attempt: number;
  inventory: ExpressionSetVersionInventory;
  candidateVersionNumber: number;
  candidateIdentity: string;
  collidesWith: ExpressionSetVersionInventoryEntry | null;
  /** §Part 1 — the existing Rank values excluded when computing `candidateRank`: this ExpressionSet's
   * own reported versions PLUS any rank independently proven taken ELSEWHERE in the org (via
   * `checkExpressionSetVersionRankExists`) — empty when `rankFieldExists` is false, never a guessed
   * list. */
  existingRanks: number[];
  /** §Part 1 — every rank value this attempt tried and found ALREADY TAKEN somewhere in the org (never
   * scoped to this one ExpressionSet) before landing on `candidateRank` — direct evidence for/against
   * "Rank is unique per-ExpressionSet only" vs. "Rank is unique org-wide." Empty when the first
   * candidate tried was already free. */
  orgWideRankCollisions: { rank: number; existingRecordId: string; existingExpressionSetId: string | null }[];
  /** §Part 1 — the lowest unused positive integer among `existingRanks` that ALSO independently proved
   * unused org-wide, or `null` when this org's ExpressionSetVersion schema has no Rank field at all (see
   * `inventory.rankFieldExists`) — a rank is then never injected into the deploy XML rather than sent
   * as an invented value. */
  candidateRank: number | null;
}

export interface ResolveNextAvailableVersionResult {
  inventory: ExpressionSetVersionInventory;
  versionNumber: number;
  identity: string;
  /** §Part 1/2 — the resolved unique Rank to embed in the deploy payload, or `null` when this org's
   * ExpressionSetVersion schema has no Rank field (see `rankFieldExists`) — `canvasBuilder.ts` skips
   * `<rank>` injection entirely in that case rather than sending an invented value. */
  rank: number | null;
  rankFieldExists: boolean;
  attempts: ResolveNextAvailableVersionAttempt[];
}

/**
 * §Sections 3/4/5 — resolves a candidate next version from the authoritative inventory, then verifies
 * that candidate identity with a SEPARATE, genuinely independent org-wide check (`checkExpressionSetVersionIdentityExists`)
 * — never merely by looking for it inside the SAME relationship-scoped inventory it was just computed
 * from, which can never find it there by construction (the candidate is deliberately one past everything
 * that inventory already contains). If the independent check finds the candidate already exists anyway
 * (Case E — the exact live bug: a relationship-scoped read that appeared to only contain V1 turned out
 * to be stale/incomplete the moment a genuinely independent identity search looked), that discovered
 * record is folded into a running "known extra" set AND the relationship-scoped inventory is re-fetched
 * (covering both a possible replication-lag explanation and a possible structural one), and the next
 * candidate is computed from the union of both — bounded, never an infinite loop, never a blind "+1
 * until it works" (each attempt re-verifies against fresh org state, it never just increments a guess).
 * Never deactivates, updates, or bypasses anything — a candidate that still collides after every attempt
 * is exhausted is a hard failure with the full attempt history attached, never a guess.
 */
export async function resolveNextAvailableExpressionSetVersion(
  client: SalesforceClient,
  apiName: string,
  maxAttempts = 5,
): Promise<ResolveNextAvailableVersionResult> {
  const attempts: ResolveNextAvailableVersionAttempt[] = [];
  const discoveredExtras: ExpressionSetVersionInventoryEntry[] = [];
  // §Part 1 — accumulates every rank independently PROVEN taken somewhere in the org (not just under
  // this ExpressionSet) across every attempt, so a rank already ruled out is never retried.
  const orgWideTakenRanks = new Set<number>();
  let inventory = await getExpressionSetVersionInventory(client, apiName);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const knownVersions = [...inventory.versions, ...discoveredExtras.filter(e => !inventory.versions.some(v => v.id === e.id))];
    const combinedInventory: ExpressionSetVersionInventory = { ...inventory, versions: knownVersions };
    const candidateVersionNumber = computeNextVersionFromInventory(combinedInventory);
    const candidateIdentity = buildCandidateExpressionSetVersionIdentity(apiName, candidateVersionNumber);
    const independentMatch = await checkExpressionSetVersionIdentityExists(client, candidateIdentity);
    const collidesWith = independentMatch ?? findMatchingInventoryEntry(combinedInventory, candidateIdentity);

    let existingRanks: number[] = [];
    let candidateRank: number | null = null;
    const orgWideRankCollisions: ResolveNextAvailableVersionAttempt["orgWideRankCollisions"] = [];
    if (combinedInventory.rankFieldExists) {
      const excluded = new Set<number>([...knownVersions.map(v => v.rank).filter((n): n is number => n !== null), ...orgWideTakenRanks]);
      // Bounded inner loop (never unbounded) — most orgs resolve this on the first try; a rank proven
      // taken org-wide is excluded and the next-lowest-unused is tried again immediately, without
      // needing a full outer attempt (which would also unnecessarily re-run identity resolution).
      for (let rankTry = 0; rankTry < 10; rankTry++) {
        const tryRank = computeLowestUnusedRank([...excluded]);
        const orgWideMatch = await checkExpressionSetVersionRankExists(client, tryRank);
        if (!orgWideMatch) { candidateRank = tryRank; break; }
        orgWideTakenRanks.add(tryRank);
        excluded.add(tryRank);
        orgWideRankCollisions.push({ rank: tryRank, existingRecordId: orgWideMatch.id, existingExpressionSetId: orgWideMatch.expressionSetId });
      }
      existingRanks = [...excluded];
    }

    attempts.push({ attempt, inventory: combinedInventory, candidateVersionNumber, candidateIdentity, collidesWith, existingRanks, orgWideRankCollisions, candidateRank });
    if (!collidesWith) {
      return {
        inventory: combinedInventory, versionNumber: candidateVersionNumber, identity: candidateIdentity,
        rank: candidateRank, rankFieldExists: combinedInventory.rankFieldExists, attempts,
      };
    }
    if (!discoveredExtras.some(e => e.id === collidesWith.id)) discoveredExtras.push(collidesWith);
    inventory = await getExpressionSetVersionInventory(client, apiName);
  }
  const last = attempts[attempts.length - 1];
  throw new Error(
    `Could not resolve an unused ExpressionSetVersion identity for "${apiName}" after ${maxAttempts} attempt(s) — the last candidate "${last.candidateIdentity}" still collides with existing ExpressionSetVersion ${last.collidesWith?.id ?? "(unknown)"} (IsActive=${last.collidesWith?.isActive ?? "(unknown)"}).`,
  );
}

export async function validateExpressionSetUniquenessAgainstOrg(
  client: SalesforceClient,
  args: OrgUniquenessCheckArgs,
): Promise<OrgUniquenessResult> {
  const generatedFullNames = dedupe(args.generatedFullNames);

  const state = await fetchExistingExpressionSetState(client, args.apiName, args.generatedLabel);
  const {
    existingExpressionSetId, existingExpressionSetDeveloperName, ownVersions,
    evHasApiName, evHasDeveloperName, evHasName, evHasExpressionSetId, evHasVersionNumber, evHasMasterLabel, evHasIsActive, fieldsChecked,
  } = state;
  const conflicts = [...state.conflicts];
  const { evSelect, toRow } = evRowSelectAndMapper(evHasExpressionSetId, evHasApiName, evHasDeveloperName, evHasName, evHasVersionNumber, evHasMasterLabel, evHasIsActive);

  const confidence: VersionIdentityConfidence = evHasVersionNumber ? "HIGH" : (evHasApiName || evHasDeveloperName || evHasName) ? "MEDIUM" : "LOW";

  let decision: VersionIdentityDecision;
  let matchedVersionId: string | null = null;
  let matchedVersionIsActive: boolean | null = null;

  if (!existingExpressionSetId) {
    decision = "create-new-expression-set";
  } else if (!evHasApiName && !evHasDeveloperName && !evHasName) {
    decision = "version-identity-unknown";
  } else if (generatedFullNames.length === 0) {
    decision = "create-new-version";
  } else {
    const inList = `(${generatedFullNames.map(v => `'${soqlEscape(v)}'`).join(", ")})`;
    const orClauses: string[] = [];
    if (evHasApiName) orClauses.push(`ApiName IN ${inList}`);
    if (evHasDeveloperName) orClauses.push(`DeveloperName IN ${inList}`);
    if (evHasName) orClauses.push(`Name IN ${inList}`);
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE ${orClauses.join(" OR ")} LIMIT 200`,
    );
    const matches = res.records.map(toRow).filter(v =>
      (v.apiName && generatedFullNames.includes(v.apiName)) ||
      (v.developerName && generatedFullNames.includes(v.developerName)) ||
      (v.name && generatedFullNames.includes(v.name)),
    );

    const ownMatch = matches.find(v => v.expressionSetId === existingExpressionSetId);
    const foreignMatches = matches.filter(v => v.expressionSetId !== existingExpressionSetId);

    for (const m of foreignMatches) {
      const matchedValue = [m.apiName, m.developerName, m.name].find(v => v && generatedFullNames.includes(v)) ?? "(unknown)";
      conflicts.push({
        identifier: "Version ApiName / ExpressionSetDefinition Reference",
        existingRecordId: m.id,
        generatedValue: matchedValue,
        conflictingMetadataType: "ExpressionSetVersion",
      });
    }

    if (ownMatch) {
      decision = "update-existing-version";
      matchedVersionId = ownMatch.id;
      matchedVersionIsActive = ownMatch.isActive;
      // §Section 4 — ACTIVE VERSION SAFETY GATE. Salesforce rejects an update to an already-active
      // ExpressionSetVersion outright ("You can't update the expression set version ... because it's
      // active. Deactivate it and try again.") — this is a genuine, unrecoverable conflict for THIS
      // deploy attempt, never something to silently retry or ask the user to manually deactivate. The
      // caller (`createPipeline.ts`) is expected to have already resolved a fresh next-version identity
      // via `resolveNextExpressionSetVersionNumber` BEFORE the canvas was built — reaching this state at
      // all means that resolution and the deploy identity have drifted apart, which is itself worth
      // surfacing as a conflict rather than attempting a doomed update.
      if (matchedVersionIsActive === true) {
        conflicts.push({
          identifier: "Active ExpressionSetVersion identity collision",
          existingRecordId: ownMatch.id,
          generatedValue: [ownMatch.apiName, ownMatch.developerName, ownMatch.name].find(v => !!v) ?? args.apiName,
          conflictingMetadataType: "ExpressionSetVersion",
        });
      }
    } else if (foreignMatches.length > 0) {
      decision = "duplicate-version-conflict";
    } else {
      decision = "create-new-version";
    }
  }

  const isUpdate = decision === "update-existing-version";

  const report = formatReport({
    apiName: args.apiName, generatedFullNames, generatedLabel: args.generatedLabel,
    decision, confidence, existingExpressionSetId, existingExpressionSetDeveloperName, ownVersions, matchedVersionId,
    conflicts, fieldsChecked,
  });
  client.logDebug("xml-diagnostic", report);
  if (matchedVersionIsActive === true) {
    client.logDebug(
      "xml-diagnostic",
      `✕ ACTIVE VERSION SAFETY GATE: the generated deployment identity matches ExpressionSetVersion ${matchedVersionId}, which is ACTIVE. Salesforce will reject an update to it outright. This deploy attempt is being stopped as a conflict rather than allowed to fail against Salesforce with a confusing error — the next-version resolution that ran before canvas build should have produced a fresh identity; if this is reached, that resolution and this deploy's identity have drifted apart.`,
    );
  }

  return { ok: conflicts.length === 0, isUpdate, decision, confidence, existingExpressionSetId, matchedVersionId, conflicts, report };
}

/**
 * §Pre-flight, never authoritative — a clean pre-flight result is never
 * treated as a guarantee; a post-deploy failure is always classified on
 * its OWN merits, and the pre-flight result is attached purely as context,
 * never suppressed or overridden. Never retries the deploy and never
 * changes what error Salesforce reported; it only reclassifies + explains.
 */
const POST_DEPLOY_UNIQUENESS_PATTERNS: RegExp[] = [
  /duplicate\s+value\s+found/i,
  /already\s+exists/i,
  /duplicate\s+developer\s*name/i,
  /duplicate\s+full\s*name/i,
  /duplicate\s+metadata/i,
];

export interface PostDeployFailureDiagnosis {
  isUniquenessConflict: boolean;
  classification: "POST_DEPLOY_UNIQUENESS_CONFLICT" | null;
  diagnosis: string;
}

function summarizePreflightResult(preflight: OrgUniquenessResult | null): string {
  if (!preflight) return "(pre-flight validation did not run, or its result was not captured for this attempt)";
  const conflictSummary = preflight.conflicts.length > 0
    ? `${preflight.conflicts.length} conflict(s) detected: ${preflight.conflicts.map(c => `${c.identifier} (${c.conflictingMetadataType} ${c.existingRecordId})`).join("; ")}`
    : "No conflicts detected";
  return [conflictSummary, `Confidence: ${preflight.confidence}`, `Decision: ${preflight.decision}`].join("\n");
}

export function diagnosePostDeployFailure(
  deployErrorMessage: string,
  preflight: OrgUniquenessResult | null,
): PostDeployFailureDiagnosis {
  const isUniquenessConflict = POST_DEPLOY_UNIQUENESS_PATTERNS.some(p => p.test(deployErrorMessage));
  if (!isUniquenessConflict) {
    return { isUniquenessConflict: false, classification: null, diagnosis: deployErrorMessage };
  }

  const diagnosis = [
    "Pre-flight Result:",
    summarizePreflightResult(preflight),
    "",
    "Deployment Result:",
    deployErrorMessage,
    "",
    "Final Diagnosis:",
    "Salesforce rejected deployment due to an org-level uniqueness rule that is not queryable through the Metadata API pre-flight validation.",
  ].join("\n");

  return { isUniquenessConflict: true, classification: "POST_DEPLOY_UNIQUENESS_CONFLICT", diagnosis };
}
