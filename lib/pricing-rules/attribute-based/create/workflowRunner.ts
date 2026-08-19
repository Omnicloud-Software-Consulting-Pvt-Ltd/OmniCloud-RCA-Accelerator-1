/**
 * §Sequential Workflow — a generic state-machine runner for the Attribute-Based
 * Pricing creation pipeline (Part T's 16-step flow). Every stage is expressed
 * as one `WorkflowStepDefinition` with exactly three phases:
 *   1. Execute   — perform the real Salesforce operation.
 *   2. Verify    — confirm the operation's result is real (for a create, this
 *                  means querying the record back — never just trusting the
 *                  REST response's returned Id).
 *   3. Commit    — persist whatever this step resolved onto the shared,
 *                  mutable pipeline context, so later steps read it from
 *                  there rather than re-deriving it.
 * "Continue" is simply `runWorkflow`'s loop moving to the next definition —
 * ONLY when the current one's execute+verify+commit all succeeded. There is
 * no Promise.all/parallel execution anywhere in this runner: steps run one at
 * a time, in array order, and a failure stops the loop immediately (Part R).
 */
import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";

export interface WorkflowSalesforceError {
  httpStatus?: number;
  errorCode?: string;
  message?: string;
}

/** The uniform failure shape every step (and the runner itself) reports — never a generic "this step didn't complete." */
export interface WorkflowStepFailure {
  step: string;
  object: string;
  operation: string;
  salesforceId: string | null;
  reason: string;
  salesforceError?: WorkflowSalesforceError;
  lastSuccessfulStep: string | null;
}

export interface VerifyFailure {
  object: string;
  operation: string;
  salesforceId: string | null;
  reason: string;
  salesforceError?: WorkflowSalesforceError;
  /** Overrides the runner's own `lastSuccessfulStep` tracking — for a step whose single Execute call internally covers several conceptual sub-stages, this names exactly which sub-stage actually got furthest before the failure. */
  lastSuccessfulStep?: string;
}

export type VerifyOutcome = { ok: true } | { ok: false; failure: VerifyFailure };

export interface WorkflowStepDefinition<TCtx, TResult> {
  name: string;
  /** 1. Execute — the real Salesforce operation (query/create/deploy/...). A thrown SalesforceError/Error is caught by the runner and converted into this step's failure automatically. */
  execute: (ctx: TCtx) => Promise<TResult>;
  /** 2. Verify — confirm `result` is real (query the record back for a create). Never assumes success just because `execute` didn't throw. */
  verify: (ctx: TCtx, result: TResult) => Promise<VerifyOutcome>;
  /** 3. Commit — persist `result` onto `ctx`. Only ever called after `verify` returns ok. */
  commit: (ctx: TCtx, result: TResult) => void;
  /** Classifies a thrown exception from `execute` into {object, operation} for failure reporting. An EXPECTED failure should be a normal `result` that `verify` rejects, not a throw. */
  classifyExecuteError?: (err: unknown) => { object: string; operation: string };
}

/** Extracts the uniform {httpStatus, errorCode, message} shape from any thrown value. */
export function extractSalesforceError(err: unknown): WorkflowSalesforceError | undefined {
  if (err instanceof SalesforceError) {
    return { httpStatus: err.status, errorCode: err.errorCode, message: err.message };
  }
  if (err instanceof Error) return { message: err.message };
  return undefined;
}

/** §Query-back verification — never trust a create response's returned Id alone. Returns false (never throws) on any read failure. */
export async function verifyRecordExists(client: SalesforceClient, sobject: string, id: string): Promise<boolean> {
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM ${sobject} WHERE Id = '${id}' LIMIT 1`);
    return res.records.some(r => r.Id === id);
  } catch {
    return false;
  }
}

/** Runs one step's Execute -> Verify -> Commit. */
export async function runWorkflowStep<TCtx, TResult>(
  def: WorkflowStepDefinition<TCtx, TResult>,
  ctx: TCtx,
  lastSuccessfulStep: string | null,
): Promise<{ ok: true } | { ok: false; failure: WorkflowStepFailure }> {
  let result: TResult;
  try {
    result = await def.execute(ctx); // 1. Execute
  } catch (err) {
    const classified = def.classifyExecuteError?.(err) ?? { object: def.name, operation: "Execute" };
    return {
      ok: false,
      failure: {
        step: def.name, object: classified.object, operation: classified.operation, salesforceId: null,
        reason: err instanceof Error ? err.message : String(err),
        salesforceError: extractSalesforceError(err),
        lastSuccessfulStep,
      },
    };
  }

  const verified = await def.verify(ctx, result); // 2. Verify
  if (!verified.ok) {
    return { ok: false, failure: { step: def.name, ...verified.failure, lastSuccessfulStep: verified.failure.lastSuccessfulStep ?? lastSuccessfulStep } };
  }

  def.commit(ctx, result); // 3. Commit Context
  return { ok: true }; // 4. Continue — the caller's loop proceeds to the next step definition.
}

/**
 * Runs every step in `defs`, strictly in array order, awaiting each one fully
 * before starting the next (no parallel execution). Stops at the FIRST
 * failure and reports it with the name of the last step that actually
 * completed — the caller never has to guess which stage got how far.
 */
export async function runWorkflow<TCtx>(
  ctx: TCtx,
  defs: WorkflowStepDefinition<TCtx, unknown>[],
  hooks?: { onStepStart?: (name: string) => void; onStepSuccess?: (name: string) => void },
): Promise<{ success: true } | { success: false; failure: WorkflowStepFailure }> {
  let lastSuccessfulStep: string | null = null;
  for (const def of defs) {
    hooks?.onStepStart?.(def.name);
    const outcome = await runWorkflowStep(def, ctx, lastSuccessfulStep);
    if (!outcome.ok) return { success: false, failure: outcome.failure };
    lastSuccessfulStep = def.name;
    hooks?.onStepSuccess?.(def.name);
  }
  return { success: true };
}
