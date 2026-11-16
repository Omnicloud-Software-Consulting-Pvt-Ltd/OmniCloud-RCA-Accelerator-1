import { nextStep, STEP_ORDER } from "./plan";
import type { LifecycleTransaction, StepId } from "./types";

/**
 * One-click lifecycle execution — PURE orchestration (client + tests). It runs the transaction's OWN step list (which already differs
 * per lifecycle: initiateAmendment / initiateRenewal / initiateCancellation / Upgrade·Downgrade·Swap API, apply-changes skipped only
 * when there is nothing to send) one step at a time through the same server step endpoint the manual controls used:
 *  · every step's result comes from Salesforce read-back on the server — this loop never marks anything done itself;
 *  · "waiting" (Salesforce still processing) is polled; "failed" STOPS — nothing after it runs — with the exact stage and error;
 *  · re-running resumes at the failed / next step; the server's guards adopt existing quotes / orders, so nothing is duplicated;
 *  · the execution goal is explicit: stop after the draft quote is validated, after the order is created, or go on to activation;
 *  · activation is NEVER part of the bulk confirmation: before it runs, `confirmActivation` must return true for the actual order
 *    (and the server independently refuses activation without its own `activationConfirmed` flag).
 */

export type ExecutionTarget = "quote" | "order" | "activate";
export const TARGET_LAST_STEP: Record<ExecutionTarget, StepId> = { quote: "validate", order: "prepare-billing", activate: "verify" };
export const TARGET_LABEL: Record<ExecutionTarget, string> = {
  quote: "Create and validate the draft quote",
  order: "… and create the order and make it billing-ready (Bill-To, addresses, billing policy & treatment, re-pricing)",
  activate: "… and activate the order (asks again before activating)",
};

export type ExecutionStatus = "completed" | "stopped" | "failed" | "awaiting-activation" | "needs-input" | "cancelled";
export interface ExecutionResult { status: ExecutionStatus; tx: LifecycleTransaction; step: StepId | null; message: string }

export interface ExecuteOptions {
  target: ExecutionTarget;
  /** Run ONE step on the server (POST /step). `confirmed` is true for write steps — the user confirmed the execution. */
  runStep: (step: StepId, o: { confirmed: boolean; activationConfirmed: boolean }) => Promise<LifecycleTransaction>;
  /** Show the order that will be activated and ask. Resolve false to stop before activation. */
  confirmActivation: (tx: LifecycleTransaction) => Promise<boolean>;
  /** A step stopped for decisions only the user can make (billing policy / treatment …): show them, store the CONFIRMED answers, and
   * resolve the updated transaction to continue — or null to pause there. Without it, execution pauses with status "needs-input". */
  resolveNeeds?: (tx: LifecycleTransaction) => Promise<LifecycleTransaction | null>;
  onProgress?: (tx: LifecycleTransaction, note: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Safety cap on polls of one waiting step (the server itself fails a step still waiting after 15 minutes). */
  maxPolls?: number;
  /** Transient transport errors (network) retried per step before stopping. */
  maxTransportRetries?: number;
  cancelled?: () => boolean;
}

const isTransport = (e: unknown) => e instanceof TypeError || /network|fetch failed|failed to fetch|ECONN|socket|timed? ?out/i.test(e instanceof Error ? e.message : String(e));

export async function executeLifecycle(start: LifecycleTransaction, o: ExecuteOptions): Promise<ExecutionResult> {
  let tx = start;
  const last = STEP_ORDER.indexOf(TARGET_LAST_STEP[o.target]);
  let polls = 0, transport = 0, pollingStep: StepId | null = null;
  for (;;) {
    if (o.cancelled?.()) return { status: "cancelled", tx, step: nextStep(tx.steps)?.id ?? null, message: "Execution paused — resume to continue from the next step." };
    const next = nextStep(tx.steps);
    if (!next) return { status: "completed", tx, step: null, message: "Every lifecycle step is complete — verified in Salesforce." };
    if (STEP_ORDER.indexOf(next.id) > last) {
      const done = tx.steps.find(s => s.id === TARGET_LAST_STEP[o.target]);
      return { status: "stopped", tx, step: next.id, message: `Stopped as requested after "${done?.label ?? TARGET_LAST_STEP[o.target]}". Next: "${next.label}".` };
    }
    if (pollingStep !== next.id) { polls = 0; transport = 0; pollingStep = next.id; }
    let activationConfirmed = false;
    if (next.id === "activate") {
      activationConfirmed = await o.confirmActivation(tx);
      if (!activationConfirmed) return { status: "awaiting-activation", tx, step: "activate", message: "The order was not activated — activation needs your explicit confirmation." };
    }
    o.onProgress?.(tx, `Running "${next.label}"…`);
    try {
      tx = await o.runStep(next.id, { confirmed: next.writes, activationConfirmed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isTransport(e) && transport < (o.maxTransportRetries ?? 2)) { transport++; await o.sleep((o.pollMs ?? 5000) * transport); continue; }
      return { status: "failed", tx, step: next.id, message: `"${next.label}" couldn't run: ${msg}` };
    }
    const st = tx.steps.find(s => s.id === next.id)!;
    o.onProgress?.(tx, `${st.label}: ${st.status}${st.message ? ` — ${st.message}` : ""}`);
    if (st.status === "completed" || st.status === "skipped") continue;
    if (st.status === "needs-input") {
      const answered = o.resolveNeeds ? await o.resolveNeeds(tx) : null;
      if (!answered) return { status: "needs-input", tx, step: st.id, message: `"${st.label}" needs your decision: ${st.message ?? ""}` };
      tx = answered;
      polls = 0;
      continue;
    }
    if (st.status === "waiting") {
      if (++polls > (o.maxPolls ?? 200)) return { status: "stopped", tx, step: st.id, message: `"${st.label}" is still waiting for Salesforce: ${st.message ?? ""} Resume later — it re-reads Salesforce first.` };
      await o.sleep(o.pollMs ?? 5000);
      continue;
    }
    return { status: "failed", tx, step: st.id, message: `"${st.label}" failed: ${st.message ?? "no message from Salesforce"}` };
  }
}
