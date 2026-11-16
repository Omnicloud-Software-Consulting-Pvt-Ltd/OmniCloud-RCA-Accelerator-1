import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { latestApiVersion } from "@/lib/billing/server/billingDocuments";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { activateOrderWithReadiness } from "@/lib/billing/server/orderBilling";
import { sessionIdentity } from "@/lib/salesforce/sessionIdentity";
import { rampApiFor } from "@/lib/ramp/server/api";
import { realDeps } from "@/lib/ramp/server/runner";
import type { LifecycleDeps } from "./lifecycle";
import { lifecycleBillingService } from "./billingService";
import { LifecycleInputError, type LifecycleCtx } from "./service";
import { lifecycleStore } from "./store";

/**
 * Every /api/assets/* and /api/asset-lifecycle/* request: this request's own Salesforce session (httpOnly cookie — no token reaches the
 * browser) at the org's NEWEST API version, the org + user from OAuth userinfo, and the lifecycle store for that org. Activation goes
 * through the app's existing Order activation (billing + tax readiness), exactly like the Orders module.
 */
export interface LifecycleRouteCtx extends LifecycleCtx { instanceUrl: string; deps: LifecycleDeps; today: string; billingClient: SalesforceClient | null }

const identityCache = new Map<string, { at: number; v: { orgId: string | null; userId: string | null } }>();
export const todayUtc = () => new Date().toISOString().slice(0, 10);

export async function lifecycleRoute(req: NextRequest, run: (ctx: LifecycleRouteCtx, body: Record<string, unknown>) => Promise<unknown>, fallback: string): Promise<NextResponse> {
  const base = requireSFClient(req);
  if ("unauthorized" in base) return base.unauthorized;
  let body: Record<string, unknown> = {};
  if (req.method !== "GET" && req.method !== "DELETE") {
    try { body = (await req.json()) ?? {}; } catch { return NextResponse.json({ success: false, error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  }
  try {
    const version = await latestApiVersion(base.client);
    const auth = version === base.client.apiVersion ? base : requireSFClient(req, version);
    if ("unauthorized" in auth) return auth.unauthorized;
    const client = auth.client;
    const key = createHash("sha256").update(`${client.instanceUrl}|${(client as unknown as { accessToken?: string }).accessToken ?? ""}`).digest("hex");
    let id = identityCache.get(key);
    if (!id || Date.now() - id.at > 5 * 60_000) { const v = await sessionIdentity(client); id = { at: Date.now(), v: { orgId: v.orgId, userId: v.userId } }; identityCache.set(key, id); }
    if (!id.v.orgId) return NextResponse.json({ success: false, error: "The Salesforce org couldn't be identified, so lifecycle transactions can't be loaded or saved.", code: "NO_ORG" }, { status: 409 });
    const billing = requireBillingClient(req);
    const deps: LifecycleDeps = {
      ...realDeps,
      today: todayUtc,
      activate: async orderId => {
        if ("unauthorized" in billing) return { success: false, message: "Not authenticated.", salesforceError: null };
        const r = await activateOrderWithReadiness(billing.client, orderId);
        return { success: r.success, message: r.message, salesforceError: r.salesforceError };
      },
      // Billing readiness before activation: the same Order Setup + Billing Policy services, on the billing API version.
      billing: "unauthorized" in billing ? undefined : lifecycleBillingService(billing.client),
    };
    return NextResponse.json(await run({ api: rampApiFor(client, version), orgId: id.v.orgId, userId: id.v.userId, store: lifecycleStore(), instanceUrl: client.instanceUrl, deps, today: todayUtc(), billingClient: "unauthorized" in billing ? null : billing.client }, body));
  } catch (err) {
    if (err instanceof LifecycleInputError) return NextResponse.json({ success: false, error: err.message, code: "INVALID_REQUEST" }, { status: 400 });
    return sfErrorResponse(err, fallback);
  }
}

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
/** A Salesforce Id query parameter (or null); anything else is a 400, never interpolated into SOQL. */
export function idParam(v: string | null, label: string): string | null {
  if (v === null || v === "") return null;
  if (!SFID.test(v)) throw new LifecycleInputError(`${label} must be a Salesforce Id.`);
  return v;
}
export function requireIdParam(v: string | null, label: string): string {
  const x = idParam(v, label);
  if (!x) throw new LifecycleInputError(`${label} is required.`);
  return x;
}
