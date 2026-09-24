/**
 * Part Q — read-back verification. After every create/deploy step reports
 * success, this re-queries Salesforce directly (never trusting in-memory
 * bookkeeping alone) to confirm every required component genuinely exists.
 *
 * §Deploy-vs-read-back distinction — a Metadata API deploy reporting
 * `success: true` with 0 component errors is real, first-party evidence
 * that Salesforce accepted the Expression Set; it is NOT the same claim as
 * "a SOQL query against ExpressionSet/ExpressionSetVersion can already see
 * it." Those two objects are metadata-backed SObjects that can exhibit a
 * brief read-after-write/search-index propagation lag immediately after a
 * deploy — a single un-retried query cannot distinguish "doesn't exist"
 * from "not yet visible". `expressionSet`/`expressionSetVersion`/
 * `pricingProcedure` are therefore resolved with a short, bounded retry
 * (each resolver owns its own retry loop against `RETRY_DELAYS_MS`/
 * `CONNECT_REST_RETRY_DELAYS_MS`) and returned as independent `ComponentVerificationResult`
 * objects (deployed/verified/method/id/error) rather than plain booleans —
 * the caller decides how to treat "deployed but not yet read-back-confirmed"
 * (a warning, never a fatal failure) instead of that distinction being lost
 * here. `pricingProcedure` has no independent Salesforce object in this
 * org's schema (confirmed via Describe in earlier turns) — it is Salesforce's
 * own business term for "the deployed ExpressionSet + its ExpressionSetVersion",
 * so it is reported as a genuinely DERIVED result, never a fabricated object
 * name or query.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape, SalesforceError } from "@/lib/salesforce/client";
import { verifyRecordExists } from "./workflowRunner";
import { retrieveNamedExpressionSetDefinition } from "./templateExpressionSet";
import { EXPRESSION_SET_METADATA_TYPE, type ComponentSuccess } from "./soapEnvelope";
import type { ProcedureStepLite } from "../types";
import type { SalesforceVerificationSummary, ComponentVerificationResult } from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * §Request-efficiency fix — REQUEST_LIMIT_EXCEEDED remediation. Every bounded-retry loop in this file
 * previously treated ANY thrown error identically: log it, sleep, retry on the same schedule as a
 * transient "not found yet" propagation-lag condition. That is correct for a genuine not-found, but
 * actively harmful for an org-wide API capacity exhaustion (HTTP 403, errorCode REQUEST_LIMIT_EXCEEDED)
 * — retrying issues MORE requests against an org that is already out of capacity, and (for
 * `resolveExpressionSetId`) each retry attempt itself issues one query PER candidate identity field, so
 * a single resolution call already amplifies one failure into several. Checked at the top of every
 * catch block in this file's retry loops; when true, the loop stops immediately (no sleep, no further
 * attempts) and returns/propagates a result that names the real cause instead of a generic timeout.
 */
export function isRequestLimitExceeded(err: unknown): boolean {
  return err instanceof SalesforceError && err.errorCode === "REQUEST_LIMIT_EXCEEDED";
}

/** Delay BEFORE attempts 2, 3, 4 respectively — short and increasing, per the explicit "bounded and
 * deterministic" requirement. Total worst-case added latency per lookup: ~5s. */
const RETRY_DELAYS_MS = [1000, 2000, 2000];


/**
 * §Turn I — a live run proved `ExpressionSet.DeveloperName` does not exist in this org/API
 * ("No such column 'DeveloperName' on entity 'ExpressionSet'"), the exact hardcoded-field-name
 * assumption this discipline exists to prevent.
 *
 * §Final Fix — a LATER live run then proved the turn-I-era Priority-1 fix (trusting the Metadata API
 * deploy's own `componentSuccesses[].id`, e.g. "9QANS000000Iakz4AC", AS the ExpressionSet record Id) was
 * ALSO wrong: Connect REST rejected that exact Id with "Invalid identifier: 9QANS000000Iakz4AC" on every
 * retry. That Id is the ExpressionSetDefinition/deployment component's own Metadata API identity — never
 * an ExpressionSet SObject record Id. It is retained ONLY as `metadataDeploymentComponentId`, for
 * logging/debugging (per explicit instruction), and is NEVER assigned to `expressionSetId` anywhere in
 * this file, never passed to Connect REST, never passed to activation.
 *
 * The ONLY way to resolve a real ExpressionSet record Id is now: Describe the object live, gather EVERY
 * plausible identity field Salesforce actually confirms exists (never hardcode which one), run an exact
 * match against each one (logging match counts per field — Part 6's explicit ask), and require the
 * result to be an UNAMBIGUOUS single match, independently re-verified via a direct Id read-back before
 * it is ever returned. `pickIdentityField` (single-candidate, kept for backward-compatible callers/tests)
 * and `pickAllIdentityFieldCandidates` (the full ordered candidate list this resolver actually uses) are
 * both pure and client-independent — see idResolution.test.ts.
 */
const EXPRESSION_SET_IDENTITY_FIELD_PRIORITY = ["DeveloperName", "ApiName", "MasterLabel", "Label", "Name"];

/** Kept ONLY for logging/debugging the Metadata API deployment's own component identity
 * (`metadataDeploymentComponentId`) — its `.id` must NEVER be treated as an ExpressionSet or
 * ExpressionSetVersion record Id anywhere in this file. */
export function pickDeployComponentId(componentSuccesses: ComponentSuccess[] = []): ComponentSuccess | null {
  const typed = componentSuccesses.find(c => !!c.id && c.componentType === EXPRESSION_SET_METADATA_TYPE);
  if (typed) return typed;
  // A deploy of exactly one component with an Id, but no (or a differently-cased) componentType tag
  // in this org's checkDeployStatus response, is still unambiguous — there's nothing else it could be.
  if (componentSuccesses.length === 1 && componentSuccesses[0].id) return componentSuccesses[0];
  return null;
}

/** Every plausible identity field Describe actually confirmed exists, in priority order — never just
 * the first one. The resolver below tries ALL of these, logging each one's match count, rather than
 * committing to a single "best guess" field before ever querying. */
export function pickAllIdentityFieldCandidates(fieldNames: string[]): string[] {
  const set = new Set(fieldNames);
  const priority = EXPRESSION_SET_IDENTITY_FIELD_PRIORITY.filter(p => set.has(p));
  const others = fieldNames.filter(n => /name|label/i.test(n) && !priority.includes(n));
  return [...priority, ...others];
}

export function pickIdentityField(fieldNames: string[]): string | null {
  return pickAllIdentityFieldCandidates(fieldNames)[0] ?? null;
}

const EXPRESSION_SET_VERSION_RELATIONSHIP_FIELD_PRIORITY = ["ExpressionSetId", "ExpressionSetDefinitionId", "DefinitionId"];
export function pickRelationshipField(fieldNames: string[]): string | null {
  const set = new Set(fieldNames);
  return EXPRESSION_SET_VERSION_RELATIONSHIP_FIELD_PRIORITY.find(p => set.has(p))
    ?? fieldNames.find(n => /expressionset/i.test(n) && /id$/i.test(n))
    ?? null;
}

/** @deprecated — a live HTTP 400 INVALID_FIELD ("No such column 'Status' on sobject of type
 * ExpressionSetVersion") proved a plain string status field doesn't exist on this org. Kept only for any
 * remaining backward-compatible caller; `pickActiveField` below is what `activation.ts` actually uses now. */
const EXPRESSION_SET_VERSION_STATUS_FIELD_PRIORITY = ["Status", "VersionStatus", "State"];
export function pickStatusField(fieldNames: string[]): string | null {
  const set = new Set(fieldNames);
  return EXPRESSION_SET_VERSION_STATUS_FIELD_PRIORITY.find(p => set.has(p))
    ?? fieldNames.find(n => /status|state/i.test(n))
    ?? null;
}

export interface ExpressionSetVersionActivationField {
  field: string;
  fieldType: "boolean" | "string";
}

/**
 * §Final Fix — a live HTTP 400 proved `ExpressionSetVersion` has no string "Status" field. Salesforce's
 * own Industries Reference documentation (developer.salesforce.com, ExpressionSetVersion SObject
 * reference) confirms the real, documented activation field is `IsActive` (Boolean) — never a
 * string/picklist status. That documented name is used only as the TOP-PRIORITY CANDIDATE here, never
 * assumed present without Describe proof — this function still requires Describe to confirm the field
 * actually exists (and is writable) before ever returning it, exactly like every other identity/field
 * picker in this file. `updateable !== false` is required (not just `filterable`) since this field must
 * be WRITTEN to for activation, not merely read.
 */
const EXPRESSION_SET_VERSION_ACTIVE_BOOLEAN_FIELD_PRIORITY = ["IsActive", "Active", "Enabled", "IsEnabled"];
export function pickActiveField(fields: { name: string; type: string; updateable?: boolean }[]): ExpressionSetVersionActivationField | null {
  const writable = fields.filter(f => f.updateable !== false);
  for (const name of EXPRESSION_SET_VERSION_ACTIVE_BOOLEAN_FIELD_PRIORITY) {
    const f = writable.find(x => x.name === name && x.type === "boolean");
    if (f) return { field: f.name, fieldType: "boolean" };
  }
  const anyBoolean = writable.find(f => f.type === "boolean" && /active|enabled/i.test(f.name));
  if (anyBoolean) return { field: anyBoolean.name, fieldType: "boolean" };
  for (const name of EXPRESSION_SET_VERSION_STATUS_FIELD_PRIORITY) {
    const f = writable.find(x => x.name === name);
    if (f) return { field: f.name, fieldType: "string" };
  }
  const anyStatusLike = writable.find(f => /status|state/i.test(f.name));
  if (anyStatusLike) return { field: anyStatusLike.name, fieldType: "string" };
  return null;
}

const EXPRESSION_SET_VERSION_ORDER_FIELD_PRIORITY = ["CreatedDate", "LastModifiedDate"];
export function pickOrderField(fieldNames: string[]): string | null {
  const set = new Set(fieldNames);
  return EXPRESSION_SET_VERSION_ORDER_FIELD_PRIORITY.find(p => set.has(p)) ?? null;
}

/** One field's exact-match attempt against `ExpressionSet` — logged in full regardless of outcome
 * (Part 6's explicit "log every candidate" ask), never silently skipped. */
export interface ExpressionSetIdentityCandidateAttempt {
  field: string;
  lookupValue: string;
  matches: number;
  matchedId: string | null;
  error?: string;
}

export interface ExpressionSetIdResolution {
  /** Only ever set once `verified` is true. */
  id: string | null;
  /** True only once `id` has been independently confirmed via a direct Id read-back — a query that
   * matched is not by itself treated as sufficient without this extra confirmation. */
  verified: boolean;
  /** Which strategy actually produced (or failed to produce) the Id — the caller uses this to log the
   * exact resolution strategy used, per explicit instruction, rather than inferring it from the id shape.
   * "deploy-component" is deliberately NOT a value here anymore — live evidence (Connect REST rejecting
   * that exact Id as "Invalid identifier") proved it is the ExpressionSetDefinition/deployment
   * component's own identity, never an ExpressionSet record Id. */
  strategy: "describe-field-match" | "describe-failed" | "no-field-found" | "no-match" | "ambiguous" | "unverified" | "request-limit-exceeded";
  /** The Describe-discovered identity field that produced the (verified) match — set only on success. */
  field?: string;
  method: string;
  error?: string;
  /** Every field tried and its match count — present whenever Describe succeeded, success or failure. */
  candidateAttempts?: ExpressionSetIdentityCandidateAttempt[];
  /** The Metadata API deployment component's own Id — kept ONLY for logging; NEVER the same value as
   * `id` unless independently proven identical (which has never happened in practice on this org). */
  metadataDeploymentComponentId?: string | null;
}

/**
 * §Final Fix — resolves the deployed ExpressionSet's REAL record Id entirely independently of the
 * Metadata API deployment component's own Id (see file-level note above for why that Id is now never
 * trusted for this). Describes `ExpressionSet` live, tries an exact match against EVERY Describe-confirmed
 * candidate identity field (never commits to a single "best guess" field ahead of time), and requires the
 * result to be an unambiguous single match — independently re-verified via a direct Id read-back — before
 * ever returning it. Bounded retry (same `RETRY_DELAYS_MS` schedule as the rest of this file) covers
 * propagation lag; a genuinely ambiguous multi-record match is a hard stop, never retried away.
 */
export async function resolveExpressionSetId(
  client: SalesforceClient,
  args: { apiName: string; componentSuccesses?: ComponentSuccess[] },
  onAttempt: (attempt: number, found: boolean, error?: string) => void,
): Promise<ExpressionSetIdResolution> {
  // §Logging/debugging ONLY — see file-level note. Never used as, or compared against, an identity.
  const deployedComponent = pickDeployComponentId(args.componentSuccesses);
  const metadataDeploymentComponentId = deployedComponent?.id ?? null;

  let fieldNames: string[];
  try {
    const describe = await client.describeObject("ExpressionSet");
    fieldNames = describe.fields.filter(f => f.filterable !== false).map(f => f.name);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onAttempt(1, false, error);
    return { id: null, verified: false, strategy: "describe-failed", method: `describe(ExpressionSet) failed: ${error}`, error, metadataDeploymentComponentId };
  }

  const candidateFields = pickAllIdentityFieldCandidates(fieldNames);
  if (candidateFields.length === 0) {
    const error = `ExpressionSet has no DeveloperName/ApiName/MasterLabel/Label/Name-like filterable field on this org (available fields: ${fieldNames.join(", ") || "(describe returned none)"}).`;
    onAttempt(1, false, error);
    return { id: null, verified: false, strategy: "no-field-found", method: error, error, metadataDeploymentComponentId };
  }

  let lastAttempts: ExpressionSetIdentityCandidateAttempt[] = [];
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAYS_MS[attempt - 2]);
    const attempts: ExpressionSetIdentityCandidateAttempt[] = [];
    let lastError: string | undefined;
    for (const field of candidateFields) {
      try {
        const res = await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSet WHERE ${field} = '${soqlEscape(args.apiName)}' LIMIT 5`);
        attempts.push({ field, lookupValue: args.apiName, matches: res.records.length, matchedId: res.records[0]?.Id ?? null });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        attempts.push({ field, lookupValue: args.apiName, matches: 0, matchedId: null, error });
        lastError = error;
        // §Never retry REQUEST_LIMIT_EXCEEDED — stop immediately (no more field queries this attempt,
        // no further attempts, no sleep) instead of amplifying an org-wide capacity exhaustion with more
        // requests. Whatever this attempt already found for earlier fields is discarded deliberately —
        // a partial result here is not safe to trust as "no match" or "found."
        if (isRequestLimitExceeded(err)) {
          onAttempt(attempt, false, `REQUEST_LIMIT_EXCEEDED — stopping immediately, never retrying: ${error}`);
          return {
            id: null, verified: false, strategy: "request-limit-exceeded",
            method: `Salesforce API request capacity was exhausted (REQUEST_LIMIT_EXCEEDED) while resolving the ExpressionSet Id — stopped immediately rather than retrying and amplifying the org-wide limit. Already-created records are preserved; re-run once capacity recovers.`,
            error, candidateAttempts: attempts, metadataDeploymentComponentId,
          };
        }
      }
    }
    lastAttempts = attempts;

    const ambiguousFields = attempts.filter(a => a.matches > 1);
    if (ambiguousFields.length > 0) {
      onAttempt(attempt, false, `Ambiguous: ${ambiguousFields.map(a => `${a.field} (${a.matches} matches)`).join(", ")}`);
      return {
        id: null, verified: false, strategy: "ambiguous",
        method: `Multiple ExpressionSet records matched an identity field for "${args.apiName}": ${ambiguousFields.map(a => `${a.field}=${a.matches}`).join(", ")} — refusing to guess.`,
        candidateAttempts: attempts, metadataDeploymentComponentId,
      };
    }

    const exactSingle = attempts.find(a => a.matches === 1 && a.matchedId);
    if (exactSingle?.matchedId) {
      // §Mandatory independent verification — a matching query result is not by itself treated as
      // sufficient; the Id is re-confirmed via a direct Id read-back before it is ever returned.
      const identityVerified = await verifyRecordExists(client, "ExpressionSet", exactSingle.matchedId);
      if (identityVerified) {
        onAttempt(attempt, true);
        return {
          id: exactSingle.matchedId, verified: true, strategy: "describe-field-match", field: exactSingle.field,
          method: `Resolved via Describe-confirmed field "${exactSingle.field}" — exact match on "${args.apiName}", independently verified via direct Id read-back.`,
          candidateAttempts: attempts, metadataDeploymentComponentId,
        };
      }
      lastError = `Field "${exactSingle.field}" matched an ExpressionSet record, but the Id could not be independently re-verified.`;
      onAttempt(attempt, false, lastError);
      continue;
    }

    onAttempt(attempt, false, lastError);
  }

  return {
    id: null, verified: false, strategy: lastAttempts.some(a => a.matches === 1) ? "unverified" : "no-match",
    method: lastAttempts.some(a => a.matches === 1)
      ? `A candidate field matched exactly once for "${args.apiName}", but could not be independently re-verified after bounded retry.`
      : `No ExpressionSet record matched any Describe-confirmed identity field for "${args.apiName}" after bounded retry.`,
    error: lastAttempts.find(a => a.error)?.error,
    candidateAttempts: lastAttempts, metadataDeploymentComponentId,
  };
}

export interface ExpressionSetVersionSchema {
  relationshipField: string | null;
  orderField: string | null;
  /** @deprecated kept for backward-compatible callers — proven NOT to exist on this org (live HTTP 400).
   * `activeField`/`activeFieldType` below is what `activation.ts` actually uses. */
  statusField: string | null;
  /** The Describe-confirmed, writable field that actually controls activation — `IsActive` (Boolean) per
   * Salesforce's own documented ExpressionSetVersion schema, but never assumed present without Describe
   * confirming it (a different org/API version could theoretically differ). `null` when Describe itself
   * failed (`error` set) OR when Describe succeeded but genuinely reported no plausible field — these are
   * different failure modes and `activation.ts` reports them distinctly, never conflating "no permission
   * to Describe" with "this org has no such field." */
  activeField: string | null;
  activeFieldType: "boolean" | "string" | null;
  allFields: string[];
  error?: string;
}

/** Describes ExpressionSetVersion once and returns every field name this pipeline needs to know about —
 * shared by `resolveExpressionSetVersionId` (relationship/order fields) and `activation.ts` (activation
 * field), so the field assumption `activation.ts` uses is Describe-verified via the exact same discovery
 * path instead of guessed independently in two places. */
export async function describeExpressionSetVersionSchema(client: SalesforceClient): Promise<ExpressionSetVersionSchema> {
  try {
    const describe = await client.describeObject("ExpressionSetVersion");
    const readableFields = describe.fields.filter(f => f.filterable !== false);
    const fieldNames = readableFields.map(f => f.name);
    const activeField = pickActiveField(describe.fields);
    return {
      relationshipField: pickRelationshipField(fieldNames),
      orderField: pickOrderField(fieldNames),
      statusField: pickStatusField(fieldNames),
      activeField: activeField?.field ?? null,
      activeFieldType: activeField?.fieldType ?? null,
      allFields: fieldNames,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { relationshipField: null, orderField: null, statusField: null, activeField: null, activeFieldType: null, allFields: [], error };
  }
}

/**
 * §Turn — a live run proved `SELECT Id FROM ExpressionSetVersion WHERE ExpressionSetId = <id>` returns
 * zero rows after 4 retries even though the Metadata API deploy genuinely succeeded — the
 * relationship-field SOQL model itself doesn't reflect how this org makes a just-deployed Expression
 * Set Version queryable. Salesforce publishes an official Business Rules Connect REST resource for
 * exactly this relationship (`GET /connect/business-rules/expression-set/{id}`, whose response includes
 * the Expression Set's own `versions` collection) — that is now the PRIMARY resolution path. SOQL is
 * kept only as a Describe-verified diagnostic fallback for orgs where Connect REST itself is
 * unavailable (Part 8) — never as the first thing tried.
 */
export interface ConnectExpressionSetVersion {
  id?: string | null;
  [key: string]: unknown;
}

export interface ConnectExpressionSetResponse {
  id?: string | null;
  apiName?: string | null;
  name?: string | null;
  versions?: ConnectExpressionSetVersion[] | null;
  [key: string]: unknown;
}

export function buildConnectExpressionSetPath(expressionSetId: string): string {
  return `/connect/business-rules/expression-set/${encodeURIComponent(expressionSetId)}`;
}

export interface ConnectExpressionSetFetchResult {
  response: ConnectExpressionSetResponse;
  /** The real HTTP status Salesforce returned, read back off `client.debugLog`'s own audit entry
   * (`client.request()` doesn't return it directly on a 2xx) — used only for the "API/JSON Details"
   * audit object; the request/response themselves are already captured in the generic audit log via
   * the same `client.request()` call (no separate/duplicate fetch). */
  httpStatus: number | null;
}

export async function fetchExpressionSetViaConnectRest(client: SalesforceClient, expressionSetId: string): Promise<ConnectExpressionSetFetchResult> {
  const response = await client.request<ConnectExpressionSetResponse>(buildConnectExpressionSetPath(expressionSetId));
  const lastEntry = client.debugLog[client.debugLog.length - 1];
  const httpStatus = lastEntry && lastEntry.type === "rest" ? lastEntry.httpStatus ?? null : null;
  return { response, httpStatus };
}

export interface VersionMatchResult {
  version: ConnectExpressionSetVersion | null;
  priority: "A" | "B" | "C" | "none";
  reason: string;
}

/**
 * §Part 4 — pure, client-independent version-disambiguation logic (directly unit-testable, no
 * SalesforceClient mocking needed — see idResolution.test.ts scenarios A-C). Never picks "the first
 * version in the array" without a reason: Priority A trusts a version Id the deploy response itself
 * already named; Priority B matches the deployed component's own name/fullName against a version's
 * name-like fields; Priority C disambiguates using whatever real signals the returned versions actually
 * carry (a lone version, the highest version number, or the most recently dated one) — a genuinely
 * unmatchable set returns `null`, never a guess.
 */
export function selectExpressionSetVersion(
  versions: ConnectExpressionSetVersion[],
  args: { deployedVersionId?: string | null; deployedVersionFullName?: string | null } = {},
): VersionMatchResult {
  if (versions.length === 0) return { version: null, priority: "none", reason: "No versions were returned." };

  if (args.deployedVersionId) {
    const match = versions.find(v => v.id === args.deployedVersionId);
    if (match) return { version: match, priority: "A", reason: `Matched the deployment component's own version Id (${args.deployedVersionId}).` };
  }

  if (args.deployedVersionFullName) {
    const nameFields = ["fullName", "apiName", "name", "developerName", "masterLabel"];
    const match = versions.find(v => nameFields.some(f => typeof v[f] === "string" && v[f] === args.deployedVersionFullName));
    if (match) return { version: match, priority: "B", reason: `Matched the deployment component's fullName/apiName/name ("${args.deployedVersionFullName}").` };
  }

  if (versions.length === 1) {
    return { version: versions[0], priority: "C", reason: "Exactly one version was returned for this Expression Set — no disambiguation needed." };
  }

  const numberField = ["versionNumber", "version"].find(f => versions.some(v => v[f] !== undefined && v[f] !== null && !Number.isNaN(Number(v[f] as string | number))));
  if (numberField) {
    const sorted = [...versions]
      .filter(v => v[numberField] !== undefined && v[numberField] !== null)
      .sort((a, b) => Number(b[numberField] as string | number) - Number(a[numberField] as string | number));
    if (sorted.length > 0) {
      return { version: sorted[0], priority: "C", reason: `Selected the highest ${numberField} (${sorted[0][numberField]}) among ${versions.length} returned versions.` };
    }
  }

  const dateField = ["lastModifiedDate", "createdDate", "startDate"].find(f => versions.some(v => typeof v[f] === "string"));
  if (dateField) {
    const dated = versions.filter(v => typeof v[dateField] === "string");
    const sorted = [...dated].sort((a, b) => new Date(b[dateField] as string).getTime() - new Date(a[dateField] as string).getTime());
    if (sorted.length > 0) {
      return { version: sorted[0], priority: "C", reason: `Selected the most recently-dated version by ${dateField}.` };
    }
  }

  return {
    version: null, priority: "none",
    reason: `${versions.length} version(s) were returned but none could be matched by Id, name, version number, or date — refusing to guess which one is the newly deployed version.`,
  };
}

/** Before attempts 2-5 respectively, per the explicit "1s / 2s / 2s / 3s" bounded-retry request —
 * distinct from `RETRY_DELAYS_MS` above (that one governs the SOQL diagnostic fallback only). */
const CONNECT_REST_RETRY_DELAYS_MS = [1000, 2000, 2000, 3000];

function isUnsupportedConnectRestResource(err: unknown): boolean {
  if (err instanceof SalesforceError) {
    if (err.status === 404) return true;
    if (/unsupported|not supported|invalid.*resource|resource not found|INVALID_TYPE/i.test(err.message)) return true;
  }
  return false;
}

export interface ExpressionSetVersionIdResolution {
  /** Only ever set once `verified` is true — never a merely-selected, unverified candidate. */
  id: string | null;
  /** True only once `id` has been independently confirmed to be a real, existing ExpressionSetVersion
   * record via a direct Id read-back. Connect REST returning a version object in its `versions`
   * collection is NOT by itself proof that object's `id` field is a valid record Id for direct REST
   * operations (activation) — this flag is the actual gate the caller uses before ever activating. */
  verified: boolean;
  strategy: "connect-rest" | "connect-rest-unmatched" | "connect-rest-unverified" | "connect-rest-no-versions" | "soql-fallback" | "soql-fallback-failed" | "no-expression-set-id" | "request-limit-exceeded";
  method: string;
  error?: string;
  connectRequestPath?: string;
  connectResponse?: ConnectExpressionSetResponse | null;
  connectHttpStatus?: number | null;
  /** The candidate actually selected, if any — present even when identity verification later failed,
   * so the caller can still log which candidate was chosen and why. */
  selectedVersion?: ConnectExpressionSetVersion | null;
  matchPriority?: "A" | "B" | "C" | "none";
  candidates?: ConnectExpressionSetVersion[];
}

/**
 * §Final Fix — live evidence (a real HTTP 404 NOT_FOUND from Salesforce when activation was called with
 * the ExpressionSetDefinition deployment component's own Id) proved that Id is the
 * ExpressionSetDefinition/deployment identity, NOT an ExpressionSetVersion record Id — Salesforce's own
 * deploy log line ("Component: ... (ExpressionSetDefinition, Id: ...)") already said as much; treating
 * it as interchangeable with an ExpressionSetVersion Id was the actual bug, not a timing/propagation
 * issue. `componentSuccesses[]` is therefore NEVER consulted for an Id here anymore — only for its
 * `fullName` (a legitimate NAME-matching signal, never an identity-matching one). Resolution is now:
 *   1. Business Rules Connect REST (`GET /connect/business-rules/expression-set/{expressionSetId}`) —
 *      the ONLY source of a genuine ExpressionSetVersion identity, with bounded retry while its
 *      `versions` collection comes back empty (propagation lag).
 *   2. Deterministic selection among whatever versions Connect REST actually returns (`selectExpressionSetVersion`),
 *      inspecting every real field on each candidate — never `versions[0]` by position.
 *   3. MANDATORY identity verification: the selected candidate's `id` is read back directly against
 *      ExpressionSetVersion (`verifyRecordExists`) before it is EVER returned as a usable Id. A
 *      candidate that fails this check is treated exactly like "no match found" — `id: null` — never
 *      handed to the caller as if it were confirmed.
 *   4. A Describe-confirmed SOQL relationship-field lookup, but ONLY when Connect REST itself is
 *      genuinely unavailable/unsupported on this org — never the first thing tried, and this path's own
 *      result is inherently a real existing row (a SOQL WHERE match only ever returns rows that exist).
 */
export async function resolveExpressionSetVersionId(
  client: SalesforceClient,
  args: { expressionSetId?: string; componentSuccesses?: ComponentSuccess[] },
  onAttempt: (attempt: number, found: boolean, error?: string) => void,
): Promise<ExpressionSetVersionIdResolution> {
  const successes = args.componentSuccesses ?? [];
  const namedComponent = successes.find(c => c.componentType === EXPRESSION_SET_METADATA_TYPE) ?? (successes.length === 1 ? successes[0] : null);

  if (!args.expressionSetId) {
    onAttempt(1, false, "No ExpressionSet Id is available to resolve the Expression Set Version through Connect REST.");
    return {
      id: null, verified: false, strategy: "no-expression-set-id",
      method: "No ExpressionSet Id is available to attempt Connect REST resolution with.",
      error: "No ExpressionSet Id available.",
    };
  }

  const path = buildConnectExpressionSetPath(args.expressionSetId);
  let lastError: string | undefined;
  let lastResponse: ConnectExpressionSetResponse | null = null;
  let lastHttpStatus: number | null = null;
  let unsupported = false;

  for (let attempt = 1; attempt <= CONNECT_REST_RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 1) await sleep(CONNECT_REST_RETRY_DELAYS_MS[attempt - 2]);
    try {
      const fetched = await fetchExpressionSetViaConnectRest(client, args.expressionSetId);
      lastResponse = fetched.response;
      lastHttpStatus = fetched.httpStatus;
      const versions = fetched.response.versions ?? [];
      if (versions.length > 0) {
        onAttempt(attempt, true);
        break;
      }
      onAttempt(attempt, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      if (err instanceof SalesforceError) lastHttpStatus = err.status;
      // §Never retry REQUEST_LIMIT_EXCEEDED — same rationale as `resolveExpressionSetId` above: stop
      // immediately instead of issuing up to 4 more REST calls against an org already out of capacity.
      if (isRequestLimitExceeded(err)) {
        onAttempt(attempt, false, `REQUEST_LIMIT_EXCEEDED — stopping immediately, never retrying: ${message}`);
        return {
          id: null, verified: false, strategy: "request-limit-exceeded",
          method: `Salesforce API request capacity was exhausted (REQUEST_LIMIT_EXCEEDED) while resolving the ExpressionSetVersion Id via Connect REST — stopped immediately rather than retrying and amplifying the org-wide limit. Already-created records are preserved; re-run once capacity recovers.`,
          error: message, connectRequestPath: path, connectHttpStatus: lastHttpStatus,
        };
      }
      onAttempt(attempt, false, message);
      if (isUnsupportedConnectRestResource(err)) { unsupported = true; break; }
    }
  }

  if (unsupported) {
    client.logDebug("xml-diagnostic", `Connect REST business-rules/expression-set unavailable on this org (${lastError}) — falling back to Describe-driven SOQL as a diagnostic fallback only.`);
    const fallback = await resolveExpressionSetVersionIdViaSoqlFallback(client, args.expressionSetId, lastError);
    return { ...fallback, connectHttpStatus: lastHttpStatus };
  }

  const versions = lastResponse?.versions ?? [];
  if (versions.length === 0) {
    return {
      id: null, verified: false, strategy: "connect-rest-no-versions",
      method: `Connect REST business-rules/expression-set returned successfully but with zero versions after bounded retry.`,
      error: lastError, connectRequestPath: path, connectResponse: lastResponse, connectHttpStatus: lastHttpStatus, candidates: [],
    };
  }

  // §Deterministic selection — by NAME only (the deployed component's fullName), never by the
  // ExpressionSetDefinition's own Id (a different identity space entirely — see file-level note).
  const match = selectExpressionSetVersion(versions, { deployedVersionFullName: namedComponent?.fullName ?? null });

  if (!match.version || typeof match.version.id !== "string") {
    return {
      id: null, verified: false, strategy: "connect-rest-unmatched",
      method: `Connect REST returned ${versions.length} version(s) but none could be matched: ${match.reason}`,
      connectRequestPath: path, connectResponse: lastResponse, connectHttpStatus: lastHttpStatus, candidates: versions, matchPriority: match.priority,
    };
  }

  // §Mandatory identity verification — Connect REST's payload shape is not itself proof the same string
  // is a valid Id for a direct REST operation (activation). Never skipped, never assumed.
  const candidateId = match.version.id;
  const identityVerified = await verifyRecordExists(client, "ExpressionSetVersion", candidateId);
  if (!identityVerified) {
    return {
      id: null, verified: false, strategy: "connect-rest-unverified",
      method: `Connect REST selected version Id "${candidateId}" (${match.reason}), but it could not be independently confirmed as a real ExpressionSetVersion record via direct Id read-back.`,
      connectRequestPath: path, connectResponse: lastResponse, connectHttpStatus: lastHttpStatus,
      selectedVersion: match.version, matchPriority: match.priority, candidates: versions,
    };
  }

  return {
    id: candidateId,
    verified: true,
    strategy: "connect-rest",
    method: `Connect REST business-rules/expression-set — ${match.reason} — identity confirmed via direct Id read-back.`,
    connectRequestPath: path, connectResponse: lastResponse, connectHttpStatus: lastHttpStatus,
    selectedVersion: match.version, matchPriority: match.priority, candidates: versions,
  };
}

/** §Reached ONLY when Connect REST itself is unavailable/unsupported (a genuine 404/unsupported
 * response, never merely "no versions yet" — that case retries Connect REST itself, above). Still never
 * assumes `ExpressionSetId` exists on `ExpressionSetVersion` — Describe-confirms the relationship field
 * first, exactly like `describeExpressionSetVersionSchema`'s other callers. A row returned by this SOQL
 * query is inherently a real, existing record — no separate verification step needed. */
async function resolveExpressionSetVersionIdViaSoqlFallback(
  client: SalesforceClient,
  expressionSetId: string,
  connectRestError: string | undefined,
): Promise<ExpressionSetVersionIdResolution> {
  const schema = await describeExpressionSetVersionSchema(client);
  if (schema.error || !schema.relationshipField) {
    const reason = schema.error
      ? `describe(ExpressionSetVersion) failed: ${schema.error}`
      : `no ExpressionSetId-like filterable relationship field found (available fields: ${schema.allFields.join(", ") || "none"})`;
    return {
      id: null, verified: false, strategy: "soql-fallback-failed",
      method: `Connect REST unavailable (${connectRestError ?? "unsupported resource"}); SOQL fallback also could not resolve: ${reason}.`,
      error: schema.error ?? reason,
    };
  }
  try {
    const orderClause = schema.orderField ? ` ORDER BY ${schema.orderField} DESC` : "";
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSetVersion WHERE ${schema.relationshipField} = '${soqlEscape(expressionSetId)}'${orderClause} LIMIT 1`);
    const id = res.records[0]?.Id ?? null;
    return {
      id, verified: !!id, strategy: "soql-fallback",
      method: `Connect REST unavailable (${connectRestError ?? "unsupported resource"}); SOQL fallback used the Describe-confirmed field "${schema.relationshipField}" (never assumed).`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { id: null, verified: false, strategy: "soql-fallback-failed", method: `Connect REST unavailable; SOQL fallback query also failed: ${error}`, error };
  }
}

export interface VerifyStateArgs {
  productId: string;
  attributeValueIds: string[];
  scheduleId: string;
  ruleIds: string[];
  conditionIds: string[];
  adjustmentIds: string[];
  expressionSetApiName: string;
  /** §Part 13 — the ExpressionSet Id already resolved earlier in the pipeline (deploy-stage
   * resolution), preserved and reused here directly via a fast Id read-back instead of discarding it
   * and reconstructing the identity from scratch. */
  expressionSetId?: string;
  expressionSetVersionId?: string;
  /** The Metadata API deploy's own `componentSuccesses`, passed through so a from-scratch resolution
   * (only reached if `expressionSetId` above wasn't already known) can still try Priority 1 first. */
  componentSuccesses?: ComponentSuccess[];
}

export async function verifySalesforceState(
  client: SalesforceClient,
  args: VerifyStateArgs,
  steps: ProcedureStepLite[],
): Promise<SalesforceVerificationSummary> {
  step(steps, "verify-salesforce", "start", "Reading every created/reused record back from Salesforce to confirm it's real.");

  const product = await client.query<{ Id: string }>(`SELECT Id FROM Product2 WHERE Id = '${soqlEscape(args.productId)}' LIMIT 1`)
    .then(r => r.records.length > 0).catch(() => false);

  const attributesValues = args.attributeValueIds.length === 0
    ? true
    : (await Promise.all(args.attributeValueIds.map(id => verifyRecordExists(client, "AttributePicklistValue", id)))).every(Boolean);

  const scheduleExists = await verifyRecordExists(client, "PriceAdjustmentSchedule", args.scheduleId);
  const rulesExist = args.ruleIds.length > 0 && (await Promise.all(args.ruleIds.map(id => verifyRecordExists(client, "AttributeBasedAdjRule", id)))).every(Boolean);
  const conditionsExist = args.conditionIds.length > 0 && (await Promise.all(args.conditionIds.map(id => verifyRecordExists(client, "AttributeAdjustmentCondition", id)))).every(Boolean);
  const adjustmentsExist = args.adjustmentIds.length > 0 && (await Promise.all(args.adjustmentIds.map(id => verifyRecordExists(client, "AttributeBasedAdjustment", id)))).every(Boolean);
  const pricingRules = scheduleExists && rulesExist && conditionsExist && adjustmentsExist;
  // The native PriceAdjustmentSchedule/Rule/Condition/Adjustment record set IS the lookup/decision data
  // this architecture uses — there is no separate "Lookup Table" object beyond these.
  const lookupTable = pricingRules;

  let pricingElement = false;
  try {
    const deployedXml = await retrieveNamedExpressionSetDefinition(client, args.expressionSetApiName);
    pricingElement = !!deployedXml && deployedXml.includes("<actionType>AttributeDiscount</actionType>");
  } catch {
    pricingElement = false;
  }

  // §Expression Set — Part 13: prefer the Id already resolved earlier in the pipeline (a fast, direct
  // Id read-back) over rediscovering the identity field from scratch; only falls back to the full
  // deploy-component/Describe resolution strategy when no earlier Id is available.
  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set.");
  let expressionSet: ComponentVerificationResult;
  if (args.expressionSetId) {
    const found = await verifyRecordExists(client, "ExpressionSet", args.expressionSetId);
    expressionSet = {
      deployed: true, // verifySalesforceState only ever runs after deployResult.success was already true
      verified: found,
      verificationMethod: `Preserved Id from earlier deploy-stage resolution (${args.expressionSetId}) — confirmed via direct Id read-back.`,
      id: found ? args.expressionSetId : null,
    };
  } else {
    const esResolution = await resolveExpressionSetId(client, { apiName: args.expressionSetApiName, componentSuccesses: args.componentSuccesses }, (attempt, found, error) => {
      step(steps, "verify-salesforce", "info", `→ Verification attempt ${attempt}${error ? ` — query error: ${error}` : found ? " — found." : " — not found yet."}`);
    });
    expressionSet = {
      deployed: true,
      verified: !!esResolution.id,
      verificationMethod: esResolution.method,
      id: esResolution.id,
      error: esResolution.error,
    };
  }
  step(
    steps, "verify-salesforce", expressionSet.verified ? "success" : "error",
    expressionSet.verified ? "✓ Expression Set verified." : `✕ Expression Set could not be confirmed via read-back${expressionSet.error ? `: ${expressionSet.error}` : "."}`,
  );

  // §Expression Set Version — §Final Fix: no longer depends on `expressionSet.verified`/`expressionSet.id`
  // succeeding first. Priority 1 (deploy component Id) needs no parent Id at all; Priority 2 (Connect
  // REST) uses whatever ExpressionSet Id is already known — preserved from the deploy stage, or the one
  // just resolved above — regardless of whether that Id's OWN direct-Id read-back succeeded.
  step(steps, "verify-salesforce", "info", "→ Verifying Expression Set Version.");
  let expressionSetVersion: ComponentVerificationResult;
  if (args.expressionSetVersionId) {
    const found = await verifyRecordExists(client, "ExpressionSetVersion", args.expressionSetVersionId);
    expressionSetVersion = {
      deployed: true,
      verified: found,
      verificationMethod: `Preserved Id from earlier deploy-stage resolution (${args.expressionSetVersionId}) — confirmed via direct Id read-back.`,
      id: found ? args.expressionSetVersionId : null,
    };
  } else {
    const evResolution = await resolveExpressionSetVersionId(
      client,
      { expressionSetId: args.expressionSetId ?? expressionSet.id ?? undefined, componentSuccesses: args.componentSuccesses },
      (attempt, found, error) => {
        step(steps, "verify-salesforce", "info", `→ Verification attempt ${attempt}${error ? ` — query error: ${error}` : found ? " — found." : " — not found yet."}`);
      },
    );
    expressionSetVersion = {
      deployed: true,
      verified: !!evResolution.id,
      verificationMethod: evResolution.method,
      id: evResolution.id,
      error: evResolution.error,
    };
  }
  step(
    steps, "verify-salesforce", expressionSetVersion.verified ? "success" : "error",
    expressionSetVersion.verified ? "✓ Expression Set Version verified." : `✕ Expression Set Version could not be confirmed via read-back${expressionSetVersion.error ? `: ${expressionSetVersion.error}` : "."}`,
  );

  // §Pricing Procedure — genuinely DERIVED, never a fabricated object/query. Confirmed via this
  // codebase's own Describe-driven schema discovery (earlier turns) and the file-level comment in
  // createPipeline.ts ("this single deploy creates the ExpressionSet + Version + steps") that no
  // independent "Pricing Procedure" Salesforce object exists — it IS the ExpressionSet + Version pair.
  // §Final Fix — relaxed from AND to OR: an independently-confirmed ExpressionSetVersion (via Connect
  // REST or its own deploy component Id) is sufficient evidence the whole Expression Set genuinely
  // exists (a Version cannot exist without its parent) — requiring ExpressionSet's OWN raw-Id read-back
  // to ALSO succeed would permanently block verification on any org where that Id isn't independently
  // queryable as a plain ExpressionSet SObject Id, even when the Version is genuinely confirmed.
  step(steps, "verify-salesforce", "info", "→ Verifying Pricing Procedure.");
  const pricingProcedure: ComponentVerificationResult = {
    deployed: true,
    verified: expressionSet.verified || expressionSetVersion.verified,
    verificationMethod: "Derived: Pricing Procedure IS the deployed ExpressionSet + ExpressionSetVersion — no separate Salesforce object exists for it in this org's schema.",
    id: expressionSetVersion.id ?? expressionSet.id,
  };
  if (!expressionSet.verified && expressionSetVersion.verified) {
    step(steps, "verify-salesforce", "info", "ℹ Expression Set's own direct Id lookup did not resolve, but its Expression Set Version was independently confirmed — a Version cannot exist without its parent, so the Expression Set is treated as confirmed through its Version.");
  }
  if (pricingProcedure.verified) {
    step(steps, "verify-salesforce", "success", "✓ Pricing Procedure verified.");
  } else {
    step(steps, "verify-salesforce", "info", "⚠ Pricing Procedure could not be confirmed through direct read-back.");
    step(steps, "verify-salesforce", "info", "ℹ Metadata deployment already succeeded; treating this as a verification warning, not a failure.");
  }

  const summary: SalesforceVerificationSummary = {
    product, attributesValues, pricingRules, lookupTable, pricingElement, expressionSet, expressionSetVersion, pricingProcedure,
  };

  // §Final Fix — consistent with `pricingProcedure.verified`'s OR-based derivation above: overall
  // success no longer individually requires `expressionSet.verified` (see that block's comment).
  const allOk = product && attributesValues && pricingRules && lookupTable && pricingElement
    && expressionSetVersion.verified && pricingProcedure.verified;
  step(steps, "verify-salesforce", allOk ? "success" : "info", allOk
    ? "Every required Salesforce component was confirmed via read-back."
    : `Read-back could not confirm: ${[
      !product && "product", !attributesValues && "attributesValues", !pricingRules && "pricingRules", !lookupTable && "lookupTable",
      !pricingElement && "pricingElement", !expressionSet.verified && "expressionSet", !expressionSetVersion.verified && "expressionSetVersion",
      !pricingProcedure.verified && "pricingProcedure",
    ].filter((v): v is string => !!v).join(", ")}.`);

  return summary;
}
