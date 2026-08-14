/**
 * §Sequential Workflow — client-side reader for POST /api/pricing-rules/create-procedure's NDJSON
 * response. Deliberately only imports the `CreateProcedureStreamEvent`/`SalesforceCreationResult`
 * *types* (erased at build) — no server-only Salesforce client code has any business in this client
 * bundle, matching the same discipline already established in lib/pricing-rules/ui/friendlyCreateFailure.ts.
 *
 * The endpoint streams one "step" line per checklist row the instant it actually starts/finishes/fails
 * (see workflowRunner.ts), followed by exactly one "result" line carrying the complete
 * `SalesforceCreationResult` — identical in shape to what this endpoint used to return as a single JSON
 * response. `onEvent` is invoked once per "step" line, in the exact order they arrive; the returned
 * Promise resolves with the "result" line's payload once the stream ends, so existing callers built
 * around "await the final result" keep working unchanged aside from also wiring up `onEvent`.
 */
import type { CreateProcedureStreamEvent, SalesforceCreationResult } from "@/lib/pricing-rules/types";

export type CreateProcedureStepEvent = Extract<CreateProcedureStreamEvent, { type: "step" }>;
export type CreateProcedureAttributePreviewEvent = Extract<CreateProcedureStreamEvent, { type: "attributePreview" }>;
export type CreateProcedureNonResultEvent = CreateProcedureStepEvent | CreateProcedureAttributePreviewEvent;

export async function streamCreateProcedure(
  body: unknown,
  onEvent: (evt: CreateProcedureNonResultEvent) => void,
  timeoutMs = 180_000,
): Promise<SalesforceCreationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/pricing-rules/create-procedure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // The endpoint only ever returns a non-2xx status for a fast, pre-pipeline rejection (bad request
    // body, unauthenticated session, an unimplemented pricing type, or the zero-valid-rows §Row
    // validation gate) — none of those stream, so this preserves the exact "throw with .payload"
    // contract callers already handle for those cases.
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(json?.error ?? `Request failed (HTTP ${res.status})`) as Error & { status?: number; payload?: unknown };
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    if (!res.body) throw new Error("The server returned a streaming response with no body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: SalesforceCreationResult | null = null;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const evt = JSON.parse(trimmed) as CreateProcedureStreamEvent;
      if (evt.type === "result") finalResult = evt.result;
      else onEvent(evt);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (buffer.trim()) consumeLine(buffer);

    if (!finalResult) throw new Error("The streaming response ended without a final result.");
    return finalResult;
  } finally {
    clearTimeout(timer);
  }
}
