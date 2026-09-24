/**
 * ============================================================================
 * TEMPORARY DEVELOPMENT STORAGE — NOT PRODUCTION-PERSISTENT.
 * ============================================================================
 * Same accepted limitation as lib/contracts/docusign/connectionStore.ts and
 * lib/contracts/docusign/signatureStatusStore.ts (see those files' doc comments
 * for the full rationale, confirmed again by investigation this turn: no
 * Postgres/KV/secrets manager/Salesforce custom object is provisioned in this
 * app anywhere): in-memory only, lost on server restart/redeploy/cold start,
 * and never shared across multiple server instances. Anchored on `globalThis`
 * for the same empirically-confirmed reason as those two files — separate
 * route files can otherwise get separate module evaluations of this file
 * under this app's Next.js 16 + Turbopack dev server.
 *
 * §Root-cause fix (deterministic run-boundary provenance) — content-only Rule
 * matching (`matchExistingRulesToCombinations` in nativeRecords.ts) correctly
 * refuses to guess whether an incomplete existing Rule belongs to the CURRENT
 * combinatorial-expansion run or is a historical artifact from an earlier
 * product-attribute configuration — content alone cannot tell the two apart
 * (proven live: this session's own forensic investigation found 85 legacy
 * Rules content-indistinguishable from a genuinely-partial current Rule).
 * `CreatedDate` clustering (used in that forensic pass) is a real, working
 * READ-ONLY signal but is explicitly NOT to become the authoritative
 * production mechanism (a heuristic gap threshold is not a real boundary).
 *
 * The real, deterministic boundary this store provides instead: at the start
 * of a run, `beginRunSnapshot` records which Rule Ids already existed (never
 * used to decide anything by itself — kept only for diagnostics/symmetry with
 * the "pre-run snapshot" design). During the run, every Rule THIS run itself
 * creates is recorded via `recordRuleCreatedDuringRun`, keyed by that run's
 * own `executionId` (already generated once per pipeline invocation by
 * `createPipeline.ts`'s `generateExecutionId()` — reused here, not
 * reinvented). `getRuleIdsCreatedDuringRun` returns exactly the Ids this
 * specific run created — a Rule not in that set was never created by this
 * run, whether it's a genuine historical artifact OR was created by a
 * DIFFERENT concurrent run (own separate `executionId`, own separate entry —
 * runs never share or race on each other's created-set). A Rule IS eligible
 * for the run's own "COMPLETE" reconciliation once its Id appears here —
 * proven, not guessed, and safe to check again on a resumed call presenting
 * the SAME `executionId` (survives across multiple requests within the same
 * server process — a client retry, a browser refresh mid-run, an NDJSON
 * reconnect — for as long as the process itself stays up).
 */

export interface RunSnapshot {
  executionId: string;
  productId: string;
  /** Every Rule Id that already existed for this product when the run began — kept for diagnostics only,
   * never itself used to decide eligibility (see `getRuleIdsCreatedDuringRun`, the actual decision source). */
  preRunRuleIds: ReadonlySet<string>;
  /** Every Rule Id this SAME run (`executionId`) has created so far — the actual eligibility source. */
  createdRuleIds: Set<string>;
  startedAt: number;
  lastActivityAt: number;
}

declare global {
  var __omnicloudAttributeCombinationRunSnapshots: Map<string, RunSnapshot> | undefined;
}
if (!globalThis.__omnicloudAttributeCombinationRunSnapshots) {
  globalThis.__omnicloudAttributeCombinationRunSnapshots = new Map();
}
const snapshots = globalThis.__omnicloudAttributeCombinationRunSnapshots;

/**
 * Starts (or, for a genuine resume presenting the same `executionId` within the same server process,
 * reuses) this run's snapshot. Idempotent by design — calling it again for an `executionId` that already
 * has a snapshot returns the EXISTING one unchanged (never resets `createdRuleIds`, which would lose track
 * of what a prior call under the same `executionId` already created).
 */
export function beginRunSnapshot(executionId: string, productId: string, preRunRuleIds: ReadonlySet<string>): RunSnapshot {
  const existing = snapshots.get(executionId);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return existing;
  }
  const snapshot: RunSnapshot = {
    executionId, productId, preRunRuleIds, createdRuleIds: new Set<string>(),
    startedAt: Date.now(), lastActivityAt: Date.now(),
  };
  snapshots.set(executionId, snapshot);
  return snapshot;
}

/** Called immediately after a new combination Rule is genuinely created (never for a reused/completed one). */
export function recordRuleCreatedDuringRun(executionId: string, ruleId: string): void {
  const snapshot = snapshots.get(executionId);
  if (!snapshot) return; // no snapshot for this executionId — nothing to record against; never throws
  snapshot.createdRuleIds.add(ruleId);
  snapshot.lastActivityAt = Date.now();
}

/** The actual eligibility source for "COMPLETE" reconciliation — every Rule Id THIS run (`executionId`)
 * has created so far, across however many calls have presented this same `executionId`. Returns an empty
 * set (never throws, never falls back to guessing) when no snapshot exists for this `executionId` — e.g.
 * the server process restarted since the run began, or this is genuinely the first call and nothing has
 * been created yet either way. */
export function getRuleIdsCreatedDuringRun(executionId: string): ReadonlySet<string> {
  return snapshots.get(executionId)?.createdRuleIds ?? new Set<string>();
}

export function getRunSnapshot(executionId: string): RunSnapshot | undefined {
  return snapshots.get(executionId);
}

/** Diagnostic/test-only — never called by production pipeline code. */
export function _clearAllRunSnapshotsForTests(): void {
  snapshots.clear();
}
