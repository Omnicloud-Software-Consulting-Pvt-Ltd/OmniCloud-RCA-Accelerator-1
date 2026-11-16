import type { SalesforceClient } from "@/lib/salesforce/client";
import { compositeAt, queryAt, SalesforceCallError, type CompositeSub } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, hasField } from "@/lib/tax/server/metadata";
import { idList } from "@/lib/tax/server/records";
import { planTaxConfiguration } from "@/lib/tax/server/plan";
import { errorField, recommendationFor } from "@/lib/tax/server/errors";
import type { PlanStep, StepOutcome, StepPhase, TaxConfigSpec, TaxExecutionReport, TaxMetadata, TaxPlan, VerificationCheck } from "@/lib/tax/types";

/**
 * EXECUTION — creates the planned records in Salesforce in dependency order, in three all-or-nothing phases:
 *
 *   1. create   every new record (GeoCountry, Tax Engine, Tax Rates, Tax Policy as Draft, Tax Treatments as Draft, Items)
 *   2. activate treatments → policy default treatment + Active
 *   3. map      Product2 tax policy, item tax-code updates
 *
 * Each phase is a Composite request with allOrNone=true (activation: treatments, then policies, because Salesforce checks the
 * committed treatment status), so Salesforce rolls the whole request back on any error: a failure in
 * phase 1 leaves nothing behind; a failure in phase 2/3 leaves only Draft (inactive) records, which the next run reuses. The plan
 * is re-resolved first and must match the token the user previewed. Afterwards every record is re-read and verified.
 */

const PHASES: StepPhase[] = ["create", "activate", "map"];
const isRef = (v: unknown): v is string => typeof v === "string" && /^@\{.+\}$/.test(v);
const refTarget = (v: string) => v.slice(2, -1);

export async function executeTaxConfiguration(client: SalesforceClient, spec: TaxConfigSpec, token: string | null): Promise<TaxExecutionReport> {
  const plan = await planTaxConfiguration(client, spec);
  const base = { connection: plan.connection, calculation: "NOT VERIFIED" as const, plan };
  if (!plan.ok) {
    const first = plan.issues.find(i => i.severity === "error")!;
    return { ...base, success: false, outcome: "FAILED", message: `Nothing was created: ${first.message}`, steps: plan.steps.map(s => notRun(s)), failure: { phase: "create", object: first.object ?? "Tax configuration", label: "Validation", field: first.field ?? null, code: first.code, message: first.message, recommendation: first.action ?? recommendationFor(first.code, first.field, first.message), recordId: null }, verification: null };
  }
  if (token && token !== plan.token) {
    return { ...base, success: false, outcome: "STALE", message: "Salesforce changed since the preview (records were created, changed or reused differently). Review the refreshed preview and create again.", steps: plan.steps.map(s => notRun(s)), failure: null, verification: null };
  }

  const ids = new Map<string, string>();
  const outcomes = new Map<string, StepOutcome>();
  for (const s of plan.steps) {
    if (s.action === "reuse" && s.recordId) ids.set(s.id, s.recordId);
    outcomes.set(s.id, s.action === "reuse" ? { stepId: s.id, object: s.object, label: s.label, status: "reused", recordId: s.recordId } : notRun(s));
  }
  // Update steps on existing records keep their record id; activation steps on new records resolve it later.
  for (const s of plan.steps) if (s.action === "update" && s.recordId && !isRef(s.recordId) && !ids.has(s.id)) ids.set(s.id, s.recordId);

  let failure: TaxExecutionReport["failure"] = null;
  // Salesforce validates a policy's activation against the COMMITTED status of its default treatment ("default TaxTreatment …
  // is not in [Active] state" when both change in one request), so treatment activation commits before policy activation.
  const batches = PHASES.flatMap((phase): { phase: StepPhase; writes: PlanStep[] }[] => {
    const writes = plan.steps.filter(s => s.phase === phase && (s.action === "create" || s.action === "update"));
    if (phase !== "activate") return [{ phase, writes }];
    return [...new Set(writes.map(s => s.object))].map(object => ({ phase, writes: writes.filter(s => s.object === object) }));
  });
  for (const { phase, writes } of batches) {
    if (!writes.length) continue;
    const refOf = new Map(writes.map((s, i) => [s.id, `s${i}`]));
    const resolve = (v: unknown): unknown => {
      if (!isRef(v)) return v;
      const target = refTarget(v);
      if (refOf.has(target) && plan.steps.find(x => x.id === target)?.action === "create") return `@{${refOf.get(target)}.id}`;
      return ids.get(target) ?? v;
    };
    const subs: CompositeSub[] = writes.map(s => {
      const body = Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, resolve(v)]));
      if (s.action === "create") return { method: "POST", url: `/sobjects/${s.object}`, referenceId: refOf.get(s.id)!, body };
      const recordId = isRef(s.recordId) ? String(resolve(s.recordId)) : s.recordId!;
      return { method: "PATCH", url: `/sobjects/${s.object}/${recordId}`, referenceId: refOf.get(s.id)!, body };
    });
    const unresolved = subs.find(x => JSON.stringify(x).includes("@{") && !/@\{s\d+\.id\}/.test(JSON.stringify(x)));
    if (unresolved) {
      const s = writes[subs.indexOf(unresolved)];
      failure = { phase, object: s.object, label: s.label, field: null, code: "UNRESOLVED_REFERENCE", message: `${s.label} depends on a record that wasn't created.`, recommendation: "Preview again — a dependency is missing.", recordId: null };
      break;
    }
    try {
      const res = await compositeAt(client, plan.apiVersion, subs);
      if (res.ok) {
        // Match results by referenceId — Salesforce doesn't guarantee they come back in request order.
        writes.forEach(s => {
          const r = res.results.find(x => x.referenceId === refOf.get(s.id));
          const id = s.action === "create" ? ((r?.body as { id?: string } | null)?.id ?? null) : (isRef(s.recordId) ? String(resolve(s.recordId)) : s.recordId);
          if (id) ids.set(s.id, id);
          outcomes.set(s.id, { stepId: s.id, object: s.object, label: s.label, status: s.action === "create" ? "created" : "updated", recordId: id });
        });
        continue;
      }
      const err = res.errors[0];
      const failedIdx = Math.max(0, writes.findIndex(s => refOf.get(s.id) === err?.referenceId));
      const failed = writes[failedIdx];
      const field = errorField(err);
      failure = { phase, object: failed.object, label: failed.label, field, code: err?.errorCode ?? null, message: err?.message ?? "Salesforce rejected the request.", recommendation: recommendationFor(err?.errorCode, field, err?.message), recordId: isRef(failed.recordId) ? null : failed.recordId };
      writes.forEach((s, i) => outcomes.set(s.id, i === failedIdx
        ? { stepId: s.id, object: s.object, label: s.label, status: "failed", recordId: null, error: { message: failure!.message, code: failure!.code, field, recommendation: failure!.recommendation } }
        : { stepId: s.id, object: s.object, label: s.label, status: "rolled-back", recordId: null }));
      break;
    } catch (e) {
      const sfe = e instanceof SalesforceCallError ? e : null;
      const err = sfe?.errors[0];
      const field = errorField(err);
      failure = { phase, object: writes[0].object, label: writes[0].label, field, code: err?.errorCode ?? (sfe ? String(sfe.status) : null), message: err?.message ?? (e instanceof Error ? e.message : String(e)), recommendation: recommendationFor(err?.errorCode, field, err?.message), recordId: null };
      writes.forEach(s => outcomes.set(s.id, { stepId: s.id, object: s.object, label: s.label, status: "rolled-back", recordId: null }));
      break;
    }
  }

  const steps = plan.steps.map(s => outcomes.get(s.id)!);
  const created = steps.filter(s => s.status === "created");
  const anyWrites = plan.steps.some(s => s.action === "create" || s.action === "update");
  const meta = await discoverTaxMetadata(client);
  const verification = await verifySteps(client, meta, plan.steps.filter(s => ids.has(s.id) && Object.keys(s.expect).length), ids);
  if (failure) {
    const partial = created.length > 0;
    return {
      ...base, success: false, outcome: partial ? "PARTIAL" : "FAILED", steps, failure, verification,
      message: partial
        ? `${failure.label} failed in Salesforce (${failure.code ?? "error"}): ${failure.message} ${created.length} record(s) were created in an earlier step and stay as they are (Draft records aren't used for tax until activated); running Create again reuses them.`
        : `${failure.label} failed in Salesforce (${failure.code ?? "error"}): ${failure.message} Salesforce rolled the step back — nothing was created.`,
    };
  }
  return {
    ...base, success: verification.passed, outcome: created.length ? "CREATED" : anyWrites ? "UPDATED" : "NOTHING TO CREATE", steps, failure: null, verification,
    message: anyWrites
      ? `${created.length} record(s) created, ${steps.filter(s => s.status === "updated").length} updated, ${steps.filter(s => s.status === "reused").length} reused · verification ${verification.passed ? "passed" : "FAILED"} (${verification.checks.filter(c => c.passed).length}/${verification.checks.length}).`
      : `Everything already exists in Salesforce — ${steps.length} record(s) reused, nothing created · verification ${verification.passed ? "passed" : "FAILED"}.`,
  };
}

function notRun(s: PlanStep): StepOutcome { return { stepId: s.id, object: s.object, label: s.label, status: "not-run", recordId: s.recordId && !isRef(s.recordId) ? s.recordId : null }; }

/** Re-read every record and compare it with what the plan expects (status, relationships, codes, rates, product mapping). */
export async function verifySteps(client: SalesforceClient, meta: TaxMetadata, steps: PlanStep[], ids: Map<string, string>): Promise<{ passed: boolean; checks: VerificationCheck[] }> {
  const byObject = new Map<string, PlanStep[]>();
  for (const s of steps) byObject.set(s.object, [...(byObject.get(s.object) ?? []), s]);
  const checks: VerificationCheck[] = [];
  for (const [object, list] of byObject) {
    const fields = [...new Set(list.flatMap(s => Object.keys(s.expect)))].filter(f => hasField(meta, object, f));
    const recordIds = [...new Set(list.map(s => ids.get(s.id)!).filter(Boolean))];
    const rows = recordIds.length ? await queryAt(client, meta.apiVersion, `SELECT Id${fields.length ? `, ${fields.join(", ")}` : ""} FROM ${object} WHERE Id IN (${idList(recordIds)})`).catch(() => []) : [];
    for (const s of list) {
      const id = ids.get(s.id)!;
      const row = rows.find(r => r.Id === id);
      if (!row) { checks.push({ id: s.id, object, label: s.label, recordId: id, passed: false, detail: "Record not found in Salesforce." }); continue; }
      const parts: string[] = [];
      let passed = true;
      for (const [f, want0] of Object.entries(s.expect)) {
        if (!hasField(meta, object, f)) continue;
        const want = isRef(want0) ? ids.get(refTarget(want0)) ?? want0 : want0;
        const got = row[f];
        const ok = typeof want === "number" ? typeof got === "number" && Math.abs(got - want) < 0.0001 : typeof want === "string" && typeof got === "string" && /^[a-zA-Z0-9]{15,18}$/.test(want) ? got.slice(0, 15) === want.slice(0, 15) : got === want;
        if (!ok) passed = false;
        parts.push(`${f} ${ok ? "✓" : `✗ (expected ${String(want)}, Salesforce has ${got === null || got === undefined ? "blank" : String(got)})`}`);
      }
      checks.push({ id: s.id, object, label: s.label, recordId: id, passed, detail: parts.join(" · ") || "Exists." });
    }
  }
  return { passed: checks.length > 0 && checks.every(c => c.passed), checks };
}

/** Re-verify a configuration without writing: re-plan it, then check every resolved record. Passes only when nothing is left to create. */
export async function verifyTaxConfiguration(client: SalesforceClient, spec: TaxConfigSpec): Promise<{ success: true; plan: TaxPlan; complete: boolean; verification: { passed: boolean; checks: VerificationCheck[] } }> {
  const plan = await planTaxConfiguration(client, spec);
  const meta = await discoverTaxMetadata(client);
  const ids = new Map(plan.steps.filter(s => s.recordId && !isRef(s.recordId)).map(s => [s.id, s.recordId!]));
  const verification = await verifySteps(client, meta, plan.steps.filter(s => s.action === "reuse" && Object.keys(s.expect).length), ids);
  const complete = plan.ok && plan.counts.create === 0 && plan.counts.update === 0;
  return { success: true, plan, complete, verification: { passed: complete && verification.passed, checks: verification.checks } };
}
