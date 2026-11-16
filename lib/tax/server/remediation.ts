import { createHash } from "node:crypto";
import type { AssistantOperation, AssistantPreview, AssistantResult } from "@/lib/tax/types";

/**
 * TAX REMEDIATION — structured diagnostics with resolution options, approval-bound execution and verification.
 *
 *   Diagnostic (stable code, stage, severity, evidence)  →  options in preference order: reuse · link · update · create · ask ·
 *   unsupported (each option: itemized steps in APPROVAL GROUPS — config / link / activation / refresh)  →  the user approves ONE
 *   group  →  the server rebuilds the plan from fresh Salesforce reads, recomputes the approval token (plan version + diagnostic +
 *   option + group + the exact operations) and refuses a stale one  →  executes the group through the Tax Assistant (which validates
 *   lifecycle rules, duplicates and field access and re-reads every written record)  →  re-plans: the diagnostic is RESOLVED only
 *   when it no longer appears in the fresh plan.
 *
 * Nothing here decides actions from human-readable text, and nothing an AI says is executed: options are built by the deterministic
 * planner from Salesforce records; every write needs the user's approval token.
 */

export type DiagnosticSeverity = "blocker" | "error" | "warning" | "info";
/** 1 transaction identity · 2 product/account/jurisdiction/legal entity · 3 policy & treatment · 4 items & tax code · 5 rates ·
 *  6 engine & decision table · 7 billing pipeline · 8 result verification. */
export type DiagnosticStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type ResolutionKind = "reuse" | "link" | "update" | "create" | "activate" | "refresh" | "end-date" | "ask" | "unsupported";
export type ApprovalGroup = "config" | "link" | "activation" | "refresh" | "permission";

/**
 * Non-assistant actions (each executed by an existing, self-validating service and verified by re-reading Salesforce):
 *  · record      — an allowlisted record write (product tax/billing policy link, price book entry, Draft order address) — recordWrites.ts
 *  · order-setup — the order billing setup service (order action, billing treatment, tax treatment stamping) on a Draft order
 *  · tax-admin   — assign the Tax Admin permission set to the CURRENT user (only when the user may assign permission sets)
 */
export type StepAction =
  | { kind: "record"; object: "Product2" | "PricebookEntry" | "Order"; op: "create" | "update"; recordId?: string | null; fields: Record<string, string | number | boolean | null> }
  | { kind: "order-setup"; orderId: string; operations: ("order-action" | "billing-treatment" | "tax-treatment" | "billing-start-month" | "billing-end-date")[] }
  | { kind: "tax-admin" };

export interface RemediationStep {
  id: string;
  group: ApprovalGroup;
  title: string;
  object: string;
  /** Existing record (update / activate / link / end-date) or null (create). */
  recordId: string | null;
  /** The Tax Assistant operation; null only for the decision-table refresh. */
  operation: AssistantOperation | null;
  refresh?: { engineId: string; decisionTableId: string | null } | null;
  /** A non-assistant action (record write / order setup / permission) — see StepAction. */
  action?: StepAction | null;
  /** Human-readable proposed values (the assistant preview shows current → new from Salesforce). */
  changes: { field: string; value: string }[];
}
export interface ResolutionInput { field: string; question: string; options?: { value: string; label: string }[] }
export interface ResolutionOption {
  id: string;
  kind: ResolutionKind;
  label: string;
  /** Why this option is (or isn't) appropriate. */
  rationale: string;
  supported: boolean;
  unsupportedReason?: string | null;
  steps: RemediationStep[];
  /** Details the user must give before the steps can be built (the plan re-evaluates with them). */
  inputs?: ResolutionInput[];
  /** Records the option reuses, links, updates or creates. */
  records: { role: "reuse" | "link" | "update" | "create" | "activate" | "end-date"; object: string; id: string | null; name: string }[];
  consequences?: string[];
  reversible: boolean;
  /** A follow-up request the page can run in place (e.g. plan the product's tax configuration) — no write by itself. */
  prompt?: string | null;
  /**
   * Record-by-record preview of everything the option would create / update / link / reuse — shown BEFORE approval, even while values
   * are still missing (those are marked required, never invented). `when` says whether it runs in this option's approvals or is the
   * regular plan's next, separately approved step (activation, refresh).
   */
  proposal?: ProposedRecord[];
}
export interface ProposedRecord {
  object: string;
  action: "create" | "update" | "link" | "reuse" | "activate" | "refresh";
  name: string;
  recordId?: string | null;
  when: "this approval" | "next approval";
  fields: { field: string; value: string | null; required: boolean; source?: string | null }[];
}
export interface TaxDiagnosticItem {
  id: string;
  code: string;
  severity: DiagnosticSeverity;
  stage: DiagnosticStage;
  title: string;
  object: string | null;
  record: { id: string; name: string } | null;
  cause: string;
  evidence: string[];
  blocksCalculation: boolean;
  options: ResolutionOption[];
  recommendedOptionId: string | null;
  recommendation: string;
  /** Diagnostics that must be resolved first (their steps create or change what this one needs). */
  dependsOn: string[];
  expected: string;
}

const SEV: Record<DiagnosticSeverity, number> = { blocker: 0, error: 1, warning: 2, info: 3 };

/** Pure: dependency-respecting order — stage, then severity, with every diagnostic after the ones it depends on. */
export function rankDiagnostics(list: TaxDiagnosticItem[]): TaxDiagnosticItem[] {
  const sorted = [...list].sort((a, b) => a.stage - b.stage || SEV[a.severity] - SEV[b.severity]);
  const out: TaxDiagnosticItem[] = [];
  const placed = new Set<string>();
  const visit = (d: TaxDiagnosticItem, path: Set<string>) => {
    if (placed.has(d.id) || path.has(d.id)) return;
    path.add(d.id);
    for (const dep of d.dependsOn) { const x = sorted.find(y => y.id === dep); if (x) visit(x, path); }
    placed.add(d.id); out.push(d);
  };
  for (const d of sorted) visit(d, new Set());
  return out;
}

/** The plan version: a digest of everything the diagnostics and their steps were built from (any Salesforce change alters it). */
export function planVersion(diagnostics: TaxDiagnosticItem[]): string {
  return createHash("sha256").update(JSON.stringify(diagnostics.map(d => [d.id, d.code, d.record?.id ?? null, d.cause, d.options.map(o => [o.id, o.supported, o.steps.map(s => [s.id, s.group, s.recordId, s.operation, s.refresh ?? null, s.action ?? null])])]))).digest("hex").slice(0, 32);
}

/** The steps of a group, and the option's approval groups in its own dependency (step) order — e.g. a replacement treatment is
 *  created (config), activated (activation), then made the policy's default (link). */
export function stepsFor(o: ResolutionOption, group: ApprovalGroup): RemediationStep[] { return o.steps.filter(s => s.group === group); }
export function groupsOf(o: ResolutionOption): ApprovalGroup[] { return [...new Set(o.steps.map(s => s.group))]; }

/** Bound to the exact plan version, diagnostic, option, group and operations: any change in Salesforce or in the proposal voids it. */
export function approvalToken(version: string, diagnosticId: string, optionId: string, group: ApprovalGroup, steps: RemediationStep[]): string {
  return createHash("sha256").update(JSON.stringify([version, diagnosticId, optionId, group, steps.map(s => [s.id, s.object, s.recordId, s.operation, s.refresh ?? null, s.action ?? null])])).digest("hex");
}

/* ───────────── Approval-bound execution (Salesforce access injected) ───────────── */

export interface RemediationApi {
  /** Fresh plan diagnostics from Salesforce (revalidation before and after the write). */
  diagnose(): Promise<TaxDiagnosticItem[]>;
  preview(operations: AssistantOperation[]): Promise<AssistantPreview>;
  execute(operations: AssistantOperation[], previewToken: string): Promise<AssistantResult>;
  refresh(engineId: string, decisionTableId: string | null): Promise<{ ok: boolean; message: string }>;
  /** Read-only pre-check of a non-assistant action (blockers; [] = executable). */
  checkAction?(action: StepAction): Promise<string[]>;
  /** Run a non-assistant action and verify it by re-reading Salesforce (ok only when verified). */
  runAction?(action: StepAction): Promise<{ ok: boolean; message: string; recordId?: string | null; permission?: boolean }>;
}
export interface RemediationRequest { diagnosticId: string; optionId: string; group?: ApprovalGroup | null; approvalToken?: string | null }
export type RemediationOutcome =
  | { mode: "preview"; planVersion: string; diagnostic: TaxDiagnosticItem; option: ResolutionOption; group: ApprovalGroup; steps: RemediationStep[]; preview: AssistantPreview | null; approvalToken: string | null; executable: boolean; blockers: string[]; remainingGroups: ApprovalGroup[] }
  | { mode: "executed"; ok: boolean; verified: boolean; group: ApprovalGroup; result: AssistantResult | null; refresh: { ok: boolean; message: string } | null; actions?: { ok: boolean; message: string; recordId?: string | null }[]; failure: { code: string; message: string; permission: boolean } | null;
      resolved: boolean; remainingGroups: ApprovalGroup[]; diagnostics: TaxDiagnosticItem[]; message: string }
  | { mode: "stale"; code: "STALE_PLAN" | "STALE_APPROVAL" | "UNSUPPORTED"; message: string; diagnostics: TaxDiagnosticItem[] };

const PERMISSION = /INSUFFICIENT_ACCESS|insufficient access|permission|not authorized|FORBIDDEN|403/i;

/**
 * Preview (no token) → the itemized group with the assistant's Salesforce-resolved preview and the approval token.
 * Execute (token) → revalidate, refuse stale approvals, run the group, verify by re-planning. A failed write is never marked
 * resolved and never retried with other targets; a permission error is reported as such (no retry).
 */
export async function remediate(api: RemediationApi, req: RemediationRequest): Promise<RemediationOutcome> {
  const diags = await api.diagnose();
  const version = planVersion(diags);
  const d = diags.find(x => x.id === req.diagnosticId);
  if (!d) return { mode: "stale", code: "STALE_PLAN", message: "This issue no longer appears in the plan — it was resolved or the configuration changed. The plan was re-evaluated.", diagnostics: diags };
  const o = d.options.find(x => x.id === req.optionId);
  if (!o) return { mode: "stale", code: "STALE_PLAN", message: "That resolution is no longer offered — the plan was re-evaluated.", diagnostics: diags };
  if (!o.supported || !o.steps.length) return { mode: "stale", code: "UNSUPPORTED", message: o.unsupportedReason ?? "This resolution has no Salesforce steps to run.", diagnostics: diags };
  const groups = groupsOf(o);
  const group = req.group && groups.includes(req.group) ? req.group : groups[0];
  const steps = stepsFor(o, group);
  const token = approvalToken(version, d.id, o.id, group, steps);
  const ops = steps.map(s => s.operation).filter((x): x is AssistantOperation => !!x);

  const actions = steps.map(s => s.action).filter((x): x is StepAction => !!x);
  if (!req.approvalToken) {
    const preview = ops.length ? await api.preview(ops) : null;
    const blockers = preview ? preview.operations.flatMap(p => p.issues.filter(i => i.severity === "error").map(i => `${p.objectLabel}: ${i.message}`)) : [];
    for (const a of actions) blockers.push(...(api.checkAction ? await api.checkAction(a) : ["This action can't be checked in this context."]));
    const needsChoice = !!preview?.needsSelection;
    const executable = (!preview || preview.ok) && !needsChoice && !blockers.length;
    return { mode: "preview", planVersion: version, diagnostic: d, option: o, group, steps, preview, approvalToken: executable ? token : null, executable, blockers: needsChoice ? [...blockers, "Salesforce found several matching records — the proposal must name exactly one."] : blockers, remainingGroups: groups };
  }
  if (req.approvalToken !== token) return { mode: "stale", code: "STALE_APPROVAL", message: "The approval no longer matches the current Salesforce state or the proposed values — nothing was changed. Review the refreshed proposal and approve it again.", diagnostics: diags };

  let result: AssistantResult | null = null;
  const actionResults: { ok: boolean; message: string; recordId?: string | null }[] = [];
  let refresh: { ok: boolean; message: string } | null = null;
  let failure: { code: string; message: string; permission: boolean } | null = null;
  try {
    if (ops.length) {
      const p = await api.preview(ops);
      if (!p.ok) failure = { code: "PREVIEW_BLOCKED", message: p.operations.flatMap(x => x.issues.filter(i => i.severity === "error").map(i => i.message)).join(" ") || "Salesforce validation blocks this change.", permission: false };
      else {
        result = await api.execute(ops, p.token);
        if (!result.success) failure = { code: result.failure?.code ?? "WRITE_FAILED", message: result.failure?.message ?? result.message, permission: PERMISSION.test(`${result.failure?.code ?? ""} ${result.failure?.message ?? ""}`) };
      }
    }
    if (!failure) for (const a of actions) {
      const pre = api.checkAction ? await api.checkAction(a) : ["This action can't be run in this context."];
      if (pre.length) { failure = { code: "PRECHECK_FAILED", message: pre.join(" "), permission: false }; break; }
      const r = await api.runAction!(a);
      actionResults.push(r);
      if (!r.ok) { failure = { code: r.permission ? "PERMISSION_DENIED" : "WRITE_FAILED", message: r.message, permission: !!r.permission || PERMISSION.test(r.message) }; break; }
    }
    if (!failure) for (const s of steps.filter(x => x.refresh)) {
      refresh = await api.refresh(s.refresh!.engineId, s.refresh!.decisionTableId);
      if (!refresh.ok) { failure = { code: "REFRESH_FAILED", message: refresh.message, permission: PERMISSION.test(refresh.message) }; break; }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    failure = { code: PERMISSION.test(message) ? "PERMISSION_DENIED" : "WRITE_FAILED", message, permission: PERMISSION.test(message) };
  }

  // Verification: re-read Salesforce (a fresh plan). The diagnostic is resolved only when it is gone; a group is done only when the
  // option no longer contains its steps.
  const after = await api.diagnose();
  const still = after.find(x => x.code === d.code && (x.record?.id ?? null) === (d.record?.id ?? null));
  const sameOption = still?.options.find(x => x.id === o.id);
  const groupDone = !failure && (!sameOption || !groupsOf(sameOption).includes(group));
  const resolved = !failure && !still;
  const remainingGroups = sameOption ? groupsOf(sameOption) : [];
  const verified = !failure && (resolved || groupDone);
  const message = failure
    ? `${failure.permission ? "Salesforce denied the change (permission) — it was not retried. " : ""}Not resolved: ${failure.message}`
    : resolved ? "Resolved — verified by re-reading Salesforce: the issue no longer appears in the plan."
    : groupDone ? `This step was applied and verified in Salesforce. Remaining for this issue: ${remainingGroups.join(", ") || "re-check"}.`
    : "The change was written, but re-reading Salesforce still shows the issue — it is NOT marked resolved.";
  return { mode: "executed", ok: !failure, verified, group, result, refresh, actions: actionResults, failure, resolved, remainingGroups, diagnostics: after, message };
}
