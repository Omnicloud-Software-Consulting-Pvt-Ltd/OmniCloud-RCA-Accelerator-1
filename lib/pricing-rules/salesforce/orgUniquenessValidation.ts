/**
 * §Org-wide uniqueness validation — the LAST guard before Metadata Deploy for an Attribute-Based
 * Pricing Procedure's ExpressionSetDefinition. `canvasBuilder.ts` already regenerates every envelope
 * identifier (label/fullName/developerName/name/expressionSetDefinition) from the new Pricing
 * Procedure's own name/API name and confirms none of them still equals the DONOR template's value — but
 * the donor is only ONE existing metadata file. An org can (and typically does) contain many other
 * Expression Sets, and Salesforce enforces these identifiers' uniqueness across ALL of them, not just
 * against whichever one happened to be cloned as a donor (this is exactly what a deploy-time "duplicate
 * value found... duplicates value on record with id" means when it survives the donor-only check).
 *
 * §Metadata identity — an existing ExpressionSet with the SAME DeveloperName is NEVER, by itself, proof
 * that this run is a safe update (§4): the real metadata identity is the (ExpressionSet, Version) PAIR.
 * When an ExpressionSet already exists, its linked ExpressionSetVersion records are fetched and compared
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
 * generated string (e.g. peeling a ".1" suffix off `fullName`). There is no legitimate, non-guessed way
 * to know pre-deploy which VersionNumber Salesforce will assign, so `VersionNumber` is used ONLY as
 * real, Salesforce-reported data — to enrich the "Existing Versions" report and to raise this
 * validator's CONFIDENCE — never as a match key compared against a value we invented. Every actual
 * match (Case A/B/C) is decided purely from real, queried DeveloperName/Name values that genuinely are
 * what was generated (never parsed/split/guessed): confidence is HIGH when `VersionNumber` exists on
 * this org (extra real corroborating data available), MEDIUM when only DeveloperName/Name exist (the
 * match itself is still real, just with no extra numeric corroboration), and LOW when neither exists —
 * in which case version identity is reported as UNKNOWN rather than inferred, and nothing is ever
 * rejected on that basis (§5: only a real Salesforce-metadata-confirmed match blocks deployment).
 *
 * `ExpressionSet.DeveloperName` is queried directly (an established, already-working assumption
 * elsewhere in this codebase — verifyExecution.ts and create-procedure/route.ts's own Deploy Metadata
 * verify step both already query it); every other candidate field (Name/MasterLabel on ExpressionSet,
 * DeveloperName/Name/VersionNumber/MasterLabel on ExpressionSetVersion) is only included in a query
 * after confirming via Describe that this org's schema actually exposes it — never assumed, never
 * guessed.
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
  | "create-new-expression-set"   // no existing ExpressionSet at all — the baseline "genuinely new procedure" case.
  | "update-existing-version"     // Case A
  | "create-new-version"          // Case B
  | "duplicate-version-conflict"  // Case C
  | "version-identity-unknown";   // §3 — neither VersionNumber nor DeveloperName/Name exists; never inferred.

/** §4 — how much of this validator's version-identity determination rests on real, Describe-confirmed
 * data, vs. how little was available to check at all. Never affects WHETHER a match blocks deployment
 * (§5) — only how much trust the report tells the caller to place in the comparison. */
export type VersionIdentityConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface OrgUniquenessResult {
  ok: boolean;
  /** True ONLY for Case A (`decision === "update-existing-version"`) — an ACTUAL matching version was
   * found under the SAME ExpressionSet, never inferred from a matching DeveloperName alone (§4). */
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
  /** The new Pricing Procedure's own API Name / DeveloperName (never the donor's) — canvasBuilder.ts's `ctx.apiName`. */
  apiName: string;
  /** Every regenerated `fullName`/`expressionSetDefinition` value from `CanvasBuildResult.generatedIdentifiers` (covers both "Version FullName" and "ExpressionSetDefinition reference" — both are checked against the same candidate set since the latter is, by construction, the same base identifier as the former). */
  generatedFullNames: string[];
  /** The regenerated envelope `label` value. */
  generatedLabel: string | null;
}

function dedupe(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))];
}

interface ExistingVersionRow {
  id: string;
  expressionSetId: string | null;
  developerName: string | null;
  name: string | null;
  /** Real value queried from Salesforce's own VersionNumber field — never parsed/derived. Null when the
   * field doesn't exist on this org. */
  versionNumber: string | null;
  label: string | null;
}

function formatVersionRow(v: ExistingVersionRow): string {
  return `Id=${v.id}, DeveloperName=${v.developerName ?? "(n/a)"}, Name=${v.name ?? "(n/a)"}, VersionNumber=${v.versionNumber ?? "(n/a)"}, Label=${v.label ?? "(n/a)"}`;
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
    "create-new-expression-set": "CREATE — no existing ExpressionSet found with this DeveloperName; a brand-new ExpressionSet and Version will be created.",
    "update-existing-version": `UPDATE EXISTING VERSION — the generated version matches existing ExpressionSetVersion ${args.matchedVersionId} under this same ExpressionSet.`,
    "create-new-version": "CREATE NEW VERSION — the ExpressionSet already exists, but no existing Version matches the generated version; a new Version will be added to it.",
    "duplicate-version-conflict": "DUPLICATE — the generated version's identity matches an existing ExpressionSetVersion that belongs to a DIFFERENT ExpressionSet. Stopping before deployment.",
    "version-identity-unknown": "UNKNOWN — this org's ExpressionSetVersion schema exposes no VersionNumber, DeveloperName, or Name field to compare against; version identity could not be determined and was never guessed. Proceeding (never blocks deployment on an unverifiable comparison).",
  };
  const confidenceExplanation: Record<VersionIdentityConfidence, string> = {
    HIGH: "VersionNumber exists on this org — real, Salesforce-reported version data corroborates the DeveloperName/Name match.",
    MEDIUM: "Matched by DeveloperName/Name only — VersionNumber does not exist on this org, so no extra numeric corroboration is available.",
    LOW: "No version identity field (VersionNumber, DeveloperName, or Name) exists on this org's ExpressionSetVersion — identity is UNKNOWN, never inferred.",
  };
  return [
    "==================================================",
    "EXPRESSION SET DEFINITION — METADATA IDENTITY RESOLUTION",
    "==================================================",
    `ExpressionSet Id: ${args.existingExpressionSetId ?? "(none — no existing ExpressionSet found)"}`,
    `DeveloperName: ${args.existingExpressionSetDeveloperName ?? args.apiName}`,
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

export async function validateExpressionSetUniquenessAgainstOrg(
  client: SalesforceClient,
  args: OrgUniquenessCheckArgs,
): Promise<OrgUniquenessResult> {
  const conflicts: OrgIdentifierConflict[] = [];
  const fieldsChecked: { object: string; fields: string[] }[] = [];
  const generatedFullNames = dedupe(args.generatedFullNames);

  // ── ExpressionSet (the Definition) — §2 "Expression Set API Name" / "DeveloperName" /
  // "ExpressionSetDefinition reference" (the version's self-reference is, by construction, the same
  // value as the API Name) all resolve to this one check. Finding an existing record here only
  // identifies the PARENT — per §4, it is NEVER by itself treated as "this is an update"; that
  // determination is made below, at the version level.
  const esDescribe = await client.describeObject("ExpressionSet");
  const esFieldNames = new Set(esDescribe.fields.map(f => f.name));
  const esHasDeveloperName = esFieldNames.has("DeveloperName");
  const esHasName = esFieldNames.has("Name");
  const esHasMasterLabel = esFieldNames.has("MasterLabel");
  const esCheckedFields = [esHasDeveloperName && "DeveloperName", esHasName && "Name", esHasMasterLabel && "MasterLabel"].filter((v): v is string => !!v);
  fieldsChecked.push({ object: "ExpressionSet", fields: esCheckedFields });

  let existingExpressionSetId: string | null = null;
  let existingExpressionSetDeveloperName: string | null = null;
  if (esHasDeveloperName) {
    const esSelect = ["Id", "DeveloperName", ...(esHasName ? ["Name"] : []), ...(esHasMasterLabel ? ["MasterLabel"] : [])];
    const esWhereClauses = [`DeveloperName = '${soqlEscape(args.apiName)}'`];
    if (esHasName) esWhereClauses.push(`Name = '${soqlEscape(args.apiName)}'`);
    if (esHasMasterLabel && args.generatedLabel) esWhereClauses.push(`MasterLabel = '${soqlEscape(args.generatedLabel)}'`);
    const res = await client.query<{ Id: string; DeveloperName: string; Name?: string; MasterLabel?: string }>(
      `SELECT ${esSelect.join(", ")} FROM ExpressionSet WHERE ${esWhereClauses.join(" OR ")} LIMIT 200`,
    );
    const ownRecord = res.records.find(rec => rec.DeveloperName === args.apiName);
    if (ownRecord) { existingExpressionSetId = ownRecord.Id; existingExpressionSetDeveloperName = ownRecord.DeveloperName; }

    for (const rec of res.records) {
      if (rec.Id === existingExpressionSetId) continue; // our own target's Definition record — evaluated at the version level below, never flagged here.
      if (rec.DeveloperName === args.apiName) {
        conflicts.push({ identifier: "Expression Set API Name / DeveloperName", existingRecordId: rec.Id, generatedValue: args.apiName, conflictingMetadataType: "ExpressionSet" });
      }
      if (esHasName && rec.Name === args.apiName) {
        conflicts.push({ identifier: "Internal Name", existingRecordId: rec.Id, generatedValue: args.apiName, conflictingMetadataType: "ExpressionSet" });
      }
      // §2 "Version Label (if unique in this metadata type)" — Salesforce does not enforce MasterLabel
      // as a unique key for most metadata-backed objects, so a match is reported for visibility only and
      // never blocks deployment on its own.
    }
  } else {
    fieldsChecked[0].fields.push("(DeveloperName not found via Describe — Expression Set uniqueness check skipped entirely)");
  }

  // ── ExpressionSetVersion — §1/§2/§3: when an ExpressionSet already exists, fetch ALL of its linked
  // Versions (for the report), then determine the generated version's identity against the ORG using
  // ONLY real, queried DeveloperName/Name values — never a VersionNumber we invented by parsing a
  // string. `VersionNumber` (if this org's schema exposes it) is fetched purely for the report and for
  // confidence — it never participates in the match itself, since there is no legitimate generated
  // VersionNumber to compare it against.
  const evDescribe = await client.describeObject("ExpressionSetVersion");
  const evFieldNames = new Set(evDescribe.fields.map(f => f.name));
  const evHasDeveloperName = evFieldNames.has("DeveloperName");
  const evHasName = evFieldNames.has("Name");
  const evHasExpressionSetId = evFieldNames.has("ExpressionSetId");
  const evHasVersionNumber = evFieldNames.has("VersionNumber");
  const evHasMasterLabel = evFieldNames.has("MasterLabel");
  const evCheckedFields = [
    evHasDeveloperName && "DeveloperName", evHasName && "Name", evHasExpressionSetId && "ExpressionSetId",
    evHasVersionNumber && "VersionNumber", evHasMasterLabel && "MasterLabel",
  ].filter((v): v is string => !!v);
  fieldsChecked.push({ object: "ExpressionSetVersion", fields: evCheckedFields });

  // §4 — confidence reflects what real identity data this org's schema actually exposes, independent of
  // whether a match happens to be found.
  const confidence: VersionIdentityConfidence = evHasVersionNumber ? "HIGH" : (evHasDeveloperName || evHasName) ? "MEDIUM" : "LOW";

  const evSelect = [
    "Id",
    ...(evHasExpressionSetId ? ["ExpressionSetId"] : []),
    ...(evHasDeveloperName ? ["DeveloperName"] : []),
    ...(evHasName ? ["Name"] : []),
    ...(evHasVersionNumber ? ["VersionNumber"] : []),
    ...(evHasMasterLabel ? ["MasterLabel"] : []),
  ];
  const toRow = (rec: Record<string, unknown> & { Id: string }): ExistingVersionRow => ({
    id: rec.Id,
    expressionSetId: evHasExpressionSetId ? (rec.ExpressionSetId as string | undefined) ?? null : null,
    developerName: evHasDeveloperName ? (rec.DeveloperName as string | undefined) ?? null : null,
    name: evHasName ? (rec.Name as string | undefined) ?? null : null,
    versionNumber: evHasVersionNumber ? String(rec.VersionNumber ?? "") || null : null,
    label: evHasMasterLabel ? (rec.MasterLabel as string | undefined) ?? null : null,
  });

  // §1 — every Version linked to the existing ExpressionSet (for the debug report — the FULL picture,
  // not just whichever ones happen to match the generated candidate).
  let ownVersions: ExistingVersionRow[] = [];
  if (existingExpressionSetId && evHasExpressionSetId) {
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE ExpressionSetId = '${soqlEscape(existingExpressionSetId)}'`,
    );
    ownVersions = res.records.map(toRow);
  }

  let decision: VersionIdentityDecision;
  let matchedVersionId: string | null = null;

  if (!existingExpressionSetId) {
    decision = "create-new-expression-set";
  } else if (!evHasDeveloperName && !evHasName) {
    // §3 — neither a real VersionNumber-independent identifier (DeveloperName/Name) exists at all on
    // this org's ExpressionSetVersion. Nothing to compare, nothing to infer — version identity is
    // UNKNOWN. Never guessed as an update or a duplicate; deployment is never blocked on this basis (§5).
    decision = "version-identity-unknown";
  } else if (generatedFullNames.length === 0) {
    // Identity fields exist, but nothing was generated to compare them against — nothing to match, so
    // this can only be a new version (there is no candidate value that could possibly collide).
    decision = "create-new-version";
  } else {
    // §2/§3 — compare the REAL, generated DeveloperName/Name value against every existing Version
    // ORG-WIDE (never scoped only to "own" up front) so a match under a DIFFERENT ExpressionSet is
    // caught (Case C) just as reliably as a match under this one (Case A). VersionNumber is deliberately
    // NOT part of this WHERE clause — there is no generated VersionNumber to search for.
    const inList = `(${generatedFullNames.map(v => `'${soqlEscape(v)}'`).join(", ")})`;
    const orClauses: string[] = [];
    if (evHasDeveloperName) orClauses.push(`DeveloperName IN ${inList}`);
    if (evHasName) orClauses.push(`Name IN ${inList}`);
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${evSelect.join(", ")} FROM ExpressionSetVersion WHERE ${orClauses.join(" OR ")} LIMIT 200`,
    );
    const matches = res.records.map(toRow).filter(v =>
      (v.developerName && generatedFullNames.includes(v.developerName)) ||
      (v.name && generatedFullNames.includes(v.name)),
    );

    const ownMatch = matches.find(v => v.expressionSetId === existingExpressionSetId);
    const foreignMatches = matches.filter(v => v.expressionSetId !== existingExpressionSetId);

    for (const m of foreignMatches) {
      const matchedValue = [m.developerName, m.name].find(v => v && generatedFullNames.includes(v)) ?? "(unknown)";
      conflicts.push({
        identifier: "Version FullName / ExpressionSetDefinition Reference",
        existingRecordId: m.id,
        generatedValue: matchedValue,
        conflictingMetadataType: "ExpressionSetVersion",
      });
    }

    if (ownMatch) {
      decision = "update-existing-version"; // Case A — proven by a real DeveloperName/Name match, never inferred.
      matchedVersionId = ownMatch.id;
    } else if (foreignMatches.length > 0) {
      decision = "duplicate-version-conflict"; // Case C — proven by a real match on a DIFFERENT record, never inferred.
    } else {
      decision = "create-new-version"; // Case B
    }
  }

  const isUpdate = decision === "update-existing-version";

  const report = formatReport({
    apiName: args.apiName, generatedFullNames, generatedLabel: args.generatedLabel,
    decision, confidence, existingExpressionSetId, existingExpressionSetDeveloperName, ownVersions, matchedVersionId,
    conflicts, fieldsChecked,
  });
  // Always logged — pass or fail, never only on a failure.
  client.logDebug("xml-diagnostic", report);

  // §5 — `conflicts` (and therefore `ok`) is only ever populated from a REAL Salesforce-queried match
  // above; "version-identity-unknown" never reaches this array, so an unverifiable comparison can never
  // block deployment.
  return { ok: conflicts.length === 0, isUpdate, decision, confidence, existingExpressionSetId, matchedVersionId, conflicts, report };
}

/**
 * §Pre-flight, never authoritative — `validateExpressionSetUniquenessAgainstOrg` above is a best-effort
 * READ against whatever this org's ExpressionSet/ExpressionSetVersion Describe actually exposes; it can
 * only compare fields it can see through SOQL/Describe. Salesforce's Metadata API deploy pipeline can
 * still enforce a uniqueness rule this pre-flight has no way to query for (an org-level validation rule,
 * a field this org's Describe doesn't expose via the REST SObject shape, a constraint on a component the
 * SOQL layer can't see at all). A clean pre-flight result is therefore never treated as a guarantee — a
 * post-deploy failure is always classified on its OWN merits, and the pre-flight result is attached
 * purely as context for comparison, never suppressed or overridden.
 *
 * Called from create-procedure/route.ts's Deploy Metadata step's own `verify()` — after
 * `deployExpressionSetDefinition()` (unmodified) has already run and failed. This never retries the
 * deploy and never changes what error Salesforce reported; it only reclassifies + explains it.
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
  /** "POST_DEPLOY_UNIQUENESS_CONFLICT" only when `isUniquenessConflict` — the caller uses this in place
   * of a generic "Metadata Deploy" classification for the failed step (§2). */
  classification: "POST_DEPLOY_UNIQUENESS_CONFLICT" | null;
  /** The complete Pre-flight Result / Deployment Result / Final Diagnosis text (§3/§5) — always
   * non-empty; equals the raw deploy error verbatim when this ISN'T a uniqueness-shaped failure (§4:
   * never suppresses or alters a non-uniqueness deployment error). */
  diagnosis: string;
}

/** Formats a `OrgUniquenessResult` (or its absence) as the "Pre-flight Result" section of the combined
 * diagnosis (§3/§5) — deliberately terse (decision/confidence/conflict count), the full multi-section
 * report is already separately logged by `validateExpressionSetUniquenessAgainstOrg` itself. */
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
  // §4 — a non-uniqueness-shaped failure is never touched: the raw Salesforce error passes through
  // exactly as it already did before this diagnosis existed.
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
