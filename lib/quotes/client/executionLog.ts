import type { ExecutionLogEntry } from "@/lib/quotes/types";

/**
 * In-memory, pub/sub execution log (§3.8, §6.5) — client-side only (there is
 * no server-side persistence across serverless invocations, so this is the
 * one consistent place every internal API call gets logged for the current
 * session). A React hook subscribes via `subscribe`/`getSnapshot`.
 */

let entries: ExecutionLogEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeExecutionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getExecutionLogSnapshot(): ExecutionLogEntry[] {
  return entries;
}

export function clearExecutionLog(): void {
  entries = [];
  notify();
}

export function beginExecutionLogEntry(label: string, method: string, path: string, requestBody: unknown): string {
  const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ExecutionLogEntry = {
    id, label, method, path, status: "pending", httpStatus: null,
    startedAt: Date.now(), durationMs: null,
    requestBody: redact(requestBody), responseBody: null, errorSummary: null,
  };
  entries = [...entries, entry];
  notify();
  return id;
}

export function completeExecutionLogEntry(id: string, httpStatus: number, responseBody: unknown, errorSummary: ExecutionLogEntry["errorSummary"] = null): void {
  entries = entries.map(e =>
    e.id === id
      ? {
          ...e,
          status: errorSummary ? "error" : "success",
          httpStatus,
          durationMs: Date.now() - e.startedAt,
          responseBody: redact(responseBody),
          errorSummary,
        }
      : e,
  );
  notify();
}

/** Replay server-returned bundle-hierarchy steps verbatim into the client's execution log (§4.7) — never re-derived or reformatted. */
export function replayServerSteps(label: string, steps: { step: string; status: string; message: string; timestamp: number }[]): void {
  for (const step of steps) {
    const id = `log-${step.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    entries = [
      ...entries,
      {
        id,
        label: `${label}: ${step.step}`,
        method: "SERVER",
        path: step.step,
        status: step.status === "error" ? "error" : "success",
        httpStatus: null,
        startedAt: step.timestamp,
        durationMs: 0,
        requestBody: null,
        responseBody: step.message,
        errorSummary: step.status === "error" ? { message: step.message, possibleCause: null, isConfigurationIssue: false, code: null } : null,
      },
    ];
  }
  notify();
}

const REDACT_KEY_PATTERN = /token|password|secret|authorization|accesstoken|refreshtoken/i;

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return value;
}

export { redact };
