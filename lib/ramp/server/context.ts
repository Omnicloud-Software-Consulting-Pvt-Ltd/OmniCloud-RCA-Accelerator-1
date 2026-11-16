import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { latestApiVersion } from "@/lib/billing/server/billingDocuments";
import { sessionIdentity } from "@/lib/salesforce/sessionIdentity";
import { rampApiFor, type RampApi } from "./api";
import { rampStore, type RampStore } from "./store";

/**
 * Every /api/ramp/* request: this request's own Salesforce session (httpOnly cookie, server-side — no token reaches the browser) at the
 * org's NEWEST API version, the org + user it belongs to (OAuth userinfo, never the browser's cached metadata), and the RAMP store for
 * that org. Identity is cached per access token for a few minutes so each request doesn't re-ask Salesforce.
 */
export interface RampContext { client: SalesforceClient; api: RampApi; orgId: string; userId: string | null; username: string | null; store: RampStore }
export class RampInputError extends Error {}

const identityCache = new Map<string, { at: number; v: { orgId: string | null; userId: string | null; username: string | null } }>();

export async function rampRoute(req: NextRequest, run: (ctx: RampContext, body: Record<string, unknown>) => Promise<unknown>, fallback: string): Promise<NextResponse> {
  const base = requireSFClient(req);
  if ("unauthorized" in base) return base.unauthorized;
  let body: Record<string, unknown> = {};
  if (req.method !== "GET") {
    try { body = (await req.json()) ?? {}; } catch { return NextResponse.json({ success: false, error: "Invalid request body.", code: "INVALID_REQUEST" }, { status: 400 }); }
  }
  try {
    const version = await latestApiVersion(base.client);
    const auth = version === base.client.apiVersion ? base : requireSFClient(req, version);
    if ("unauthorized" in auth) return auth.unauthorized;
    const client = auth.client;
    // Keyed by a hash of the session token (never the token itself).
    const key = createHash("sha256").update(`${client.instanceUrl}|${(client as unknown as { accessToken?: string }).accessToken ?? ""}`).digest("hex");
    let id = identityCache.get(key);
    if (!id || Date.now() - id.at > 5 * 60_000) { id = { at: Date.now(), v: await sessionIdentity(client) }; identityCache.set(key, id); }
    if (!id.v.orgId) return NextResponse.json({ success: false, error: "The Salesforce org couldn't be identified, so RAMP can't load or save anything.", code: "NO_ORG" }, { status: 409 });
    return NextResponse.json(await run({ client, api: rampApiFor(client, version), orgId: id.v.orgId, userId: id.v.userId, username: id.v.username, store: rampStore() }, body));
  } catch (err) {
    if (err instanceof RampInputError) return NextResponse.json({ success: false, error: err.message, code: "INVALID_REQUEST" }, { status: 400 });
    return sfErrorResponse(err, fallback);
  }
}

export const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
export function requireId(v: unknown, label: string, prefix?: string): string {
  if (typeof v !== "string" || !ID.test(v) || (prefix && !v.startsWith(prefix))) throw new RampInputError(`${label} must be a valid Salesforce Id${prefix ? ` (prefix ${prefix})` : ""}.`);
  return v;
}
export const optionalId = (v: unknown, label: string, prefix?: string) => (v === null || v === undefined || v === "" ? null : requireId(v, label, prefix));
