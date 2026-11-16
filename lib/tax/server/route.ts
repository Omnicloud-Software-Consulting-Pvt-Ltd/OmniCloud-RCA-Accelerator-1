import { NextResponse, type NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { knownError } from "@/lib/billing/server/paymentsRoute";
import { SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { categorize } from "@/lib/tax/server/admin";
import { SpecError } from "@/lib/tax/server/spec";
import { EngineNotReadyError } from "@/lib/tax/server/verification";
import { errorField, recommendationFor } from "@/lib/tax/server/errors";

/**
 * The AI service refused the request (rejected/expired key → 503 AI_KEY_REJECTED; any other Anthropic failure → 502 AI_ERROR).
 * Returned as an HTTP error — like a missing key (503 NO_AI_KEY) — never as a successful response. The key itself is never echoed.
 */
export class AiServiceError extends Error {
  constructor(public status: number, public code: "NO_AI_KEY" | "AI_KEY_REJECTED" | "AI_ERROR", message: string) { super(message); }
}
/** The response for a missing Anthropic key (the routes check this before calling the AI). */
export const noAiKeyResponse = () => NextResponse.json({ success: false, code: "NO_AI_KEY", error: "Anthropic API key not configured. Complete Setup to add your key." }, { status: 503 });

/**
 * Shared handler for every /api/billing/tax route: the app's existing Salesforce session (httpOnly cookie → server-side client;
 * no token ever reaches the browser), a JSON body, one service call, and Salesforce's exact error (object, field, code, message,
 * recommended fix) — never a generic "Tax creation failed". The org and user always come from the session, never the request.
 */
export async function taxRoute(req: NextRequest, run: (client: SalesforceClient, body: Record<string, unknown>) => Promise<unknown>, fallback: string, opts: { mutates?: boolean } = {}): Promise<NextResponse> {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: Record<string, unknown> = {};
  if (req.method !== "GET") {
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  }
  try {
    const out = await run(auth.client, body);
    if (opts.mutates) clearBillingStatsCache();
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof AiServiceError) return NextResponse.json({ success: false, code: err.code, error: err.message }, { status: err.status });
    if (err instanceof SpecError) return NextResponse.json({ success: false, code: "INVALID_REQUEST", field: err.field, error: err.message }, { status: 400 });
    if (err instanceof EngineNotReadyError) return NextResponse.json({ success: false, code: err.code, category: "tax-engine", error: err.message, adminAction: err.adminAction }, { status: 409 });
    if (err instanceof SalesforceCallError && err.status !== 401) {
      console.error("[tax] Salesforce call failed", { status: err.status, errors: err.errors });
      const first = err.errors[0];
      const code = first?.errorCode ?? "SALESFORCE_ERROR";
      const field = errorField(first);
      return NextResponse.json({ success: false, code, category: categorize(code, err.message), field, error: `Salesforce rejected the request: ${err.message}`, recommendation: recommendationFor(code, field, err.message), technical: err.raw }, { status: err.status === 403 ? 403 : 422 });
    }
    return knownError(err) ?? billingErrorResponse(err, fallback, { objectLabel: "Tax" });
  }
}
