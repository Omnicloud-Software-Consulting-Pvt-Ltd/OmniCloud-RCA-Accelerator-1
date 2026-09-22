"use client";

import { useState } from "react";
import { Ic, tokens, Section, GhostButton } from "./shared";
import type { ProcedureStepLite } from "@/lib/pricing-rules/attribute-based/types";
import type { GeneratedProcedureSnapshot } from "@/lib/pricing-rules/attribute-based/create/types";
import type { SanitizedAuditEntry } from "@/lib/salesforce/auditLog";

/**
 * §Parts 11-22 — Execution Log + API/JSON Details, the two collapsible (default-collapsed)
 * observability panels for the Attribute-Based Pricing creation flow. Purely presentational: every
 * value rendered here (steps, auditLog, procedureSnapshot) was already sanitized/assembled server-side
 * (lib/salesforce/auditLog.ts, createPipeline.ts's buildProcedureSnapshot) — this file never redacts
 * or filters anything itself, it only formats what it's given. Both panels stay populated after a
 * failure (Part 20) since they're driven entirely by props the caller already has, not by any
 * "in-progress" state that gets cleared.
 */

function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) void navigator.clipboard.writeText(text);
}

function downloadJson(filename: string, text: string) {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function JsonBlock({ isDark, value, filename }: { isDark: boolean; value: unknown; filename: string }) {
  const t = tokens(isDark);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <GhostButton
          label={copied ? "Copied" : "Copy JSON"}
          icon={copied ? "check" : "copy"}
          isDark={isDark}
          onClick={() => { copyToClipboard(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        />
        <GhostButton label="Download JSON" icon="download" isDark={isDark} onClick={() => downloadJson(filename, text)} />
      </div>
      <pre style={{
        margin: 0, padding: 12, borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt,
        color: t.body, fontSize: 11.5, lineHeight: 1.5, overflowX: "auto", maxHeight: 420, overflowY: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }}>
        {text}
      </pre>
    </div>
  );
}

const STEP_GLYPH: Record<ProcedureStepLite["status"], string> = { success: "✓", error: "✕", info: "ℹ", start: "…" };

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** §Part 17-20 — chronological, human-readable execution events merged from the read-only analyze
 * phase's steps and the Salesforce-write create phase's steps (once available), sorted by real
 * timestamp so the two phases interleave correctly rather than analyze-then-create as two blocks. */
export function ExecutionLogPanel({
  isDark, analyzeSteps, createSteps,
}: {
  isDark: boolean;
  analyzeSteps: ProcedureStepLite[];
  createSteps: ProcedureStepLite[];
}) {
  const t = tokens(isDark);
  const merged = [...analyzeSteps, ...createSteps].slice().sort((a, b) => a.timestamp - b.timestamp);
  if (merged.length === 0) return null;

  return (
    <Section title="Execution Log" icon="list" isDark={isDark} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingTop: 8, maxHeight: 360, overflowY: "auto" }}>
        {merged.map((s, i) => {
          const color = s.status === "success" ? "#22C55E" : s.status === "error" ? t.error : s.status === "info" ? t.dim : t.accent;
          return (
            <div key={i} className="flex items-start gap-2" style={{ fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
              <span style={{ color: t.dim, flexShrink: 0 }}>{formatTime(s.timestamp)}</span>
              <span style={{ color, flexShrink: 0, width: 14, textAlign: "center" }}>{STEP_GLYPH[s.status] ?? "•"}</span>
              <span style={{ color: t.body }}>{s.message}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function AuditEntryRow({ isDark, entry }: { isDark: boolean; entry: SanitizedAuditEntry }) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(false);
  const color = entry.status === "success" ? "#22C55E" : t.error;
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <span className="flex items-center gap-2" style={{ fontSize: 12, color: t.heading, minWidth: 0 }}>
          <span style={{ color, flexShrink: 0 }}><Ic n={entry.status === "success" ? "check-circle" : "alert"} s={13} /></span>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>{entry.method ?? ""}</span>
          <span style={{ color: t.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.object ?? entry.url ?? ""}</span>
        </span>
        <span className="flex items-center gap-2" style={{ fontSize: 11, color: t.dim, flexShrink: 0 }}>
          {entry.durationMs != null && <span>{entry.durationMs}ms</span>}
          {entry.httpStatus != null && <span style={{ color }}>{entry.httpStatus}</span>}
          <Ic n={open ? "chevron-down" : "chevron-right"} s={12} />
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: t.dim }}>{entry.method} {entry.url}</div>
          <div>
            <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 4px" }}>Request</p>
            <pre style={{ margin: 0, padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, fontSize: 11, overflowX: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
              {JSON.stringify(entry.request ?? null, null, 2)}
            </pre>
          </div>
          <div>
            <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 4px" }}>Response</p>
            <pre style={{ margin: 0, padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body, fontSize: 11, overflowX: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
              {JSON.stringify(entry.response ?? null, null, 2)}
            </pre>
          </div>
          <div style={{ fontSize: 11, color, fontWeight: 700 }}>Status: {entry.status.toUpperCase()}</div>
        </div>
      )}
    </div>
  );
}

/** §Part 11-16/18 — the sanitized JSON audit trail: the generated procedure JSON (with copy/download),
 * the exact CREATE-vs-REUSE decision for every Attribute-Based Adjustment, then every individual
 * Salesforce REST operation this run performed, each independently expandable. */
/** One deploy-vs-read-back component result — see `ComponentVerificationResult` in
 * lib/pricing-rules/attribute-based/create/types.ts. Duplicated here (not imported) since this is a
 * client component and the type is purely structural. */
interface ComponentVerificationResultLike {
  deployed: boolean;
  verified: boolean;
  verificationMethod: string;
  id: string | null;
  error?: string;
}

interface AttributePricingLifecycleStatusLike {
  expressionSetDeployment: "success" | "failed";
  expressionSetVersionDeployment: "success" | "failed";
  expressionSetVersionResolution: "success" | "failed" | "skipped";
  activation: "success" | "failed" | "skipped" | "not_requested";
  pricingProcedure: "verified" | "deployed" | "not_verified";
}

interface ExpressionSetVersionResolutionAuditLike {
  strategy: "connect-rest" | "fallback";
  metadataDeploymentComponentId: string | null;
  expressionSetId: string | null;
  expressionSetVersionId: string | null;
  verified: boolean;
  selectedBy: string | null;
  request: { method: "GET"; path: string };
  response: unknown;
  method: string;
  selectedVersion: unknown;
  candidates: unknown[];
  error?: string;
}

interface AttributePricingActivationAuditLike {
  attempted: boolean;
  versionId: string | null;
  success: boolean;
  status: "Draft" | "Active" | null;
}

export function ApiJsonDetailsPanel({
  isDark, auditLog, procedureSnapshot, adjustmentDecisions, expressionSetValidation,
  parentStepValidation, duplicateStepNames, deployPayloadFingerprint,
  listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison,
  donorExtractionDeterministic, identityFieldDrift, unrelatedBranchIntegrity, attributeDiscountBranchSelection,
  status, deploymentSummary, verificationWarning, verification, lifecycleStatus, expressionSetVersionResolution, activationAudit,
  expressionSetDonorInspection,
}: {
  isDark: boolean;
  auditLog: SanitizedAuditEntry[];
  procedureSnapshot: GeneratedProcedureSnapshot | null;
  adjustmentDecisions?: unknown[];
  expressionSetValidation?: Record<string, unknown>;
  parentStepValidation?: unknown[];
  duplicateStepNames?: string[];
  deployPayloadFingerprint?: string;
  status?: "success" | "deployed_with_verification_warning" | "failed" | "pending-adjustment-confirmation" | "blocked";
  deploymentSummary?: { success: boolean; deploymentId: string | null; componentsDeployed: number; errors: number };
  verificationWarning?: string;
  verification?: {
    product: boolean; attributesValues: boolean; pricingRules: boolean; lookupTable: boolean; pricingElement: boolean;
    expressionSet: ComponentVerificationResultLike; expressionSetVersion: ComponentVerificationResultLike; pricingProcedure: ComponentVerificationResultLike;
  };
  lifecycleStatus?: AttributePricingLifecycleStatusLike;
  expressionSetVersionResolution?: ExpressionSetVersionResolutionAuditLike;
  activationAudit?: AttributePricingActivationAuditLike;
  /** §Phase 2 — evidence-only donor inventory (see lib/pricing-rules/attribute-based/create/donorInspection.ts);
   * loosely typed here since this panel only ever renders it as JSON, never inspects individual fields. */
  expressionSetDonorInspection?: unknown;
  listPriceOutputValidation?: { donorOutputs: string[]; generatedOutputs: string[]; outputCount: number; valid: boolean };
  attributeDiscountInputBinding?: {
    listPriceOutputValues: string[]; inputUnitPriceValue: string | null; originalInputUnitPriceValue: string | null; wasPatched: boolean; valid: boolean;
  };
  hierarchyComparison?: { donorStepCount: number; generatedStepCount: number; missingDonorOccurrences: number[]; hierarchyMatches: boolean; donorTree: string; generatedTree: string };
  donorExtractionDeterministic?: boolean;
  identityFieldDrift?: { occurrenceIndex: number; pathLabel: string; field: string; donorValue: string | null; generatedValue: string | null }[];
  unrelatedBranchIntegrity?: { checkedBranches: number; changedBranches: string[] };
  attributeDiscountBranchSelection?: {
    candidates: {
      occurrenceIndex: number; pathLabel: string; parentStepName: string | null; ancestorNames: string[]; ancestryNote: string;
      isContractEnabled: boolean | null; priceAdjustmentScheduleBinding: string | null; effectiveFromBinding: string | null;
      effectiveToBinding: string | null; exclusiveFieldNames: string[]; branchType: string; score: number; reasons: string[];
    }[];
    selectedOccurrenceIndex: number | null;
    selectionReason: string;
    ambiguous: boolean;
  };
}) {
  const t = tokens(isDark);
  const hasDecisions = !!adjustmentDecisions && adjustmentDecisions.length > 0;
  const hasExpressionSetValidation = !!expressionSetValidation && Object.keys(expressionSetValidation).length > 0;
  const hasParentStepValidation = !!parentStepValidation && parentStepValidation.length > 0;
  const hasWaterfallValidation = !!listPriceOutputValidation || !!attributeDiscountInputBinding;
  const hasHierarchyComparison = !!hierarchyComparison;
  const hasBranchSelection = !!attributeDiscountBranchSelection;
  const hasIntegrityGates = !!unrelatedBranchIntegrity || !!identityFieldDrift || donorExtractionDeterministic !== undefined;
  const hasDeploymentSummary = !!deploymentSummary || !!verification;
  const hasVersionResolution = !!expressionSetVersionResolution || !!lifecycleStatus || !!activationAudit;
  const hasDonorInspection = !!expressionSetDonorInspection;
  if (!procedureSnapshot && auditLog.length === 0 && !hasDecisions && !hasExpressionSetValidation && !hasParentStepValidation && !hasWaterfallValidation && !hasHierarchyComparison && !hasIntegrityGates && !hasBranchSelection && !hasDeploymentSummary && !hasVersionResolution && !hasDonorInspection) return null;

  return (
    <Section title="API / JSON Details" icon="code" isDark={isDark} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 8 }}>
        {procedureSnapshot && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Generated Pricing Procedure JSON</p>
            <JsonBlock isDark={isDark} value={procedureSnapshot} filename={`${procedureSnapshot.executionId}-procedure.json`} />
          </div>
        )}
        {hasDeploymentSummary && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Deployment &amp; Verification Summary</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              The actual Metadata API deploy result (deployment Id, components deployed/errors) and the independent deploy-vs-read-back status of Expression Set, Expression Set Version, and Pricing Procedure — a read-back gap on an already-successful deploy is a warning, never converted into a failure.
              {status === "deployed_with_verification_warning" ? " ⚠ Deployed with verification warning." : status === "failed" ? " ✕ Failed." : status === "success" ? " ✓ Fully verified." : status === "pending-adjustment-confirmation" ? " ⚠ Awaiting an adjustment-value decision — see the conflict panel above." : ""}
            </p>
            <JsonBlock
              isDark={isDark}
              value={{ status, deploymentSummary, verification, verificationWarning }}
              filename={`${procedureSnapshot?.executionId ?? "run"}-deployment-verification-summary.json`}
            />
          </div>
        )}
        {hasDonorInspection && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Expression Set Donor Inspection (Phase 2 — evidence only)</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Every ExpressionSetDefinition in the org, inspected read-only — never selects a donor, never deploys. &quot;firstFileContainingActionType&quot; below is NOT what the real build used — it&apos;s simply the first file found with zero connectivity check. The donor actually used by the real build (with its proven connection evidence) is reported separately under &quot;Selected donor&quot; in the Execution Log&apos;s build-expression-set step.
            </p>
            <JsonBlock
              isDark={isDark}
              value={expressionSetDonorInspection}
              filename={`${procedureSnapshot?.executionId ?? "run"}-expression-set-donor-inspection.json`}
            />
          </div>
        )}
        {hasVersionResolution && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Expression Set Version Resolution (Business Rules Connect REST)</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              The exact Connect REST request/response and version-matching decision — SOQL against <code>ExpressionSetVersion.ExpressionSetId</code> is no longer the primary resolution path (that field doesn&apos;t exist as a queryable relationship on this org); SOQL is used only as a Describe-verified diagnostic fallback if Connect REST itself is unavailable.
              {expressionSetVersionResolution?.expressionSetVersionId ? ` ✓ Resolved via ${expressionSetVersionResolution.strategy}${expressionSetVersionResolution.selectedBy ? ` (${expressionSetVersionResolution.selectedBy})` : ""}.` : expressionSetVersionResolution ? " ✕ Could not be resolved — see detail below." : ""}
            </p>
            {lifecycleStatus && (
              <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, padding: "10px 12px", fontSize: 11.5, color: t.body, display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                <span>Expression Set deployment: {lifecycleStatus.expressionSetDeployment.toUpperCase()}</span>
                <span>Expression Set Version deployment: {lifecycleStatus.expressionSetVersionDeployment.toUpperCase()}</span>
                <span>Expression Set Version resolution: {lifecycleStatus.expressionSetVersionResolution.toUpperCase()}</span>
                <span>Activation: {lifecycleStatus.activation.replace("_", " ").toUpperCase()}</span>
                <span>Pricing Procedure: {lifecycleStatus.pricingProcedure.toUpperCase()}</span>
              </div>
            )}
            <JsonBlock
              isDark={isDark}
              value={{
                metadataDeploymentComponentId: expressionSetVersionResolution?.metadataDeploymentComponentId ?? null,
                expressionSet: { id: expressionSetVersionResolution?.expressionSetId ?? null, source: "describe-field-match" },
                expressionSetVersion: {
                  id: expressionSetVersionResolution?.expressionSetVersionId ?? null,
                  source: expressionSetVersionResolution?.strategy ?? null,
                  verified: expressionSetVersionResolution?.verified ?? false,
                  selectedBy: expressionSetVersionResolution?.selectedBy ?? null,
                },
                activation: activationAudit ?? null,
                lifecycleStatus,
                expressionSetVersionResolutionDetail: expressionSetVersionResolution,
              }}
              filename={`${procedureSnapshot?.executionId ?? "run"}-expression-set-version-resolution.json`}
            />
          </div>
        )}
        {hasDecisions && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>
              Attribute-Based Adjustment Decisions ({adjustmentDecisions!.length})
            </p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              The exact CREATE-vs-REUSE decision for every requested configuration, including the condition signature it was matched against.
            </p>
            <JsonBlock isDark={isDark} value={adjustmentDecisions} filename={`${procedureSnapshot?.executionId ?? "run"}-adjustment-decisions.json`} />
          </div>
        )}
        {hasExpressionSetValidation && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Expression Set Structural Validation</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Donor vs. generated child-element comparison for every step (ListPrice, AttributeDiscount, PricingSettings) — never bypassed or weakened.
            </p>
            <JsonBlock isDark={isDark} value={{ step: "create-expression-set", structuralValidation: expressionSetValidation }} filename={`${procedureSnapshot?.executionId ?? "run"}-expression-set-validation.json`} />
          </div>
        )}
        {hasWaterfallValidation && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Pricing Waterfall — ListPrice → AttributeDiscount</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Confirms ListPrice publishes at least one real output and AttributeDiscount&apos;s InputUnitPrice binds to that exact value — the actual data dependency, distinct from the structural/parentStep checks above.
              {attributeDiscountInputBinding?.wasPatched
                ? ` The donor's own binding ("${attributeDiscountInputBinding.originalInputUnitPriceValue}") was inconsistent with ListPrice's single published output and was corrected in-place to "${attributeDiscountInputBinding.inputUnitPriceValue}" — never a synthesized/invented value.`
                : " Never renamed or invented when already consistent."}
            </p>
            <JsonBlock
              isDark={isDark}
              value={{ step: "create-expression-set", listPriceOutputValidation, attributeDiscountInputBinding }}
              filename={`${procedureSnapshot?.executionId ?? "run"}-pricing-waterfall-validation.json`}
            />
          </div>
        )}
        {hasHierarchyComparison && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Expression Set Hierarchy Comparison</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Donor step count {hierarchyComparison!.donorStepCount} vs. generated {hierarchyComparison!.generatedStepCount} (every container/list/child step, every depth, matched by physical occurrence — never by name, since this donor legitimately reuses names across unrelated branches).
              {hierarchyComparison!.missingDonorOccurrences.length > 0
                ? ` Missing donor step occurrence(s): ${hierarchyComparison!.missingDonorOccurrences.join(", ")}.`
                : hierarchyComparison!.hierarchyMatches ? " ✓ Hierarchy preserved." : " ✕ Hierarchy shape differs from donor — see the tree diff below."}
            </p>
            <JsonBlock isDark={isDark} value={hierarchyComparison} filename={`${procedureSnapshot?.executionId ?? "run"}-hierarchy-comparison.json`} />
          </div>
        )}
        {hasBranchSelection && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>
              AttributeDiscount Branch Selection ({attributeDiscountBranchSelection!.candidates.length} candidate{attributeDiscountBranchSelection!.candidates.length === 1 ? "" : "s"})
            </p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Deterministic, donor-driven selection among every physical AttributeDiscount occurrence — never by array index, never by a single field alone.
              {attributeDiscountBranchSelection!.ambiguous
                ? ` ✕ ${attributeDiscountBranchSelection!.selectionReason}`
                : ` ✓ ${attributeDiscountBranchSelection!.selectionReason}`}
            </p>
            <JsonBlock
              isDark={isDark}
              value={attributeDiscountBranchSelection}
              filename={`${procedureSnapshot?.executionId ?? "run"}-attributediscount-branch-selection.json`}
            />
          </div>
        )}
        {hasIntegrityGates && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Patch Isolation Gates (occurrence-aware)</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Gate A (donor extraction determinism) and Gate B (identity-field drift + unrelated-branch content-hash integrity) — all occurrence-index-based, never name-based.
              {donorExtractionDeterministic === false ? " ✕ Donor extraction was NOT deterministic." : ""}
              {identityFieldDrift && identityFieldDrift.length > 0 ? ` ✕ ${identityFieldDrift.length} identity field drift(s).` : ""}
              {unrelatedBranchIntegrity && unrelatedBranchIntegrity.changedBranches.length > 0 ? ` ✕ ${unrelatedBranchIntegrity.changedBranches.length} unrelated branch(es) changed.` : ""}
              {(donorExtractionDeterministic !== false && !(identityFieldDrift && identityFieldDrift.length > 0) && !(unrelatedBranchIntegrity && unrelatedBranchIntegrity.changedBranches.length > 0)) ? " ✓ All gates passed." : ""}
            </p>
            <JsonBlock
              isDark={isDark}
              value={{ donorExtractionDeterministic, identityFieldDrift, unrelatedBranchIntegrity }}
              filename={`${procedureSnapshot?.executionId ?? "run"}-patch-isolation-gates.json`}
            />
          </div>
        )}
        {hasParentStepValidation && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 6px" }}>Expression Set parentStep Referential Integrity</p>
            <p style={{ fontSize: 11, color: t.dim, margin: "0 0 6px" }}>
              Confirms every &lt;parentStep&gt; VALUE resolves to a real step in the final generated set and matches the donor&apos;s own value — distinct from the structural check above, which only confirms the node is present.
              {duplicateStepNames && duplicateStepNames.length > 0
                ? ` Duplicate generated step name(s) detected: ${duplicateStepNames.join(", ")}.`
                : " No duplicate generated step names."}
              {deployPayloadFingerprint ? ` Deployed payload sha256: ${deployPayloadFingerprint}.` : ""}
            </p>
            <JsonBlock
              isDark={isDark}
              value={{ step: "create-expression-set", parentStepValidation, duplicateStepNames: duplicateStepNames ?? [], deployPayloadFingerprint }}
              filename={`${procedureSnapshot?.executionId ?? "run"}-parentstep-validation.json`}
            />
          </div>
        )}
        {auditLog.length > 0 && (
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 8px" }}>Salesforce API Calls ({auditLog.length})</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
              {auditLog.map((entry, i) => <AuditEntryRow key={i} isDark={isDark} entry={entry} />)}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
