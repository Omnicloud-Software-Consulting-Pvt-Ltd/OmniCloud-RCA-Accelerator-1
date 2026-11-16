import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";

/**
 * The Salesforce org + user behind THIS request's session, resolved from Salesforce itself (OAuth userinfo + Organization) — never
 * from the browser's cached session metadata. Read-only. Used to scope per-user / per-org reads (e.g. the Tax Library's
 * "records you created" activity).
 */
export interface SessionIdentity {
  orgId: string | null;
  userId: string | null;
  username: string | null;
  orgName: string | null;
  /** Organization.IsSandbox — null when it couldn't be read. */
  isSandbox: boolean | null;
}

/** Per-call ceiling — a stalled upstream fails fast instead of hanging the request. */
export const IDENTITY_CALL_TIMEOUT_MS = 12_000;

export async function sessionIdentity(client: SalesforceClient): Promise<SessionIdentity> {
  // userinfo first, with a timeout: an expired/revoked token must surface as 401, not as an identity with null Ids.
  const info = await client.requestWithDiagnostics(`${client.instanceUrl}/services/oauth2/userinfo`, { method: "GET", signal: AbortSignal.timeout(IDENTITY_CALL_TIMEOUT_MS) }).catch((e: unknown) => {
    throw new SalesforceError(e instanceof Error && e.name === "TimeoutError" ? `Salesforce didn't answer the identity check within ${IDENTITY_CALL_TIMEOUT_MS / 1000} s.` : `Couldn't reach Salesforce: ${e instanceof Error ? e.message : String(e)}`, 504);
  });
  if (info.status === 401 || info.status === 403) throw new SalesforceError("Salesforce session expired or invalid.", 401, info.json);
  if (info.status >= 400) throw new SalesforceError(`Salesforce identity check failed (HTTP ${info.status}).`, info.status, info.json);
  const u = (info.json ?? {}) as { user_id?: string; organization_id?: string; preferred_username?: string };
  const orgRes = await client.requestWithDiagnostics(`${client.instanceUrl}/services/data/${client.apiVersion}/query?q=${encodeURIComponent("SELECT Id, Name, IsSandbox FROM Organization LIMIT 1")}`, { method: "GET", signal: AbortSignal.timeout(IDENTITY_CALL_TIMEOUT_MS) }).catch(() => null);
  const org = orgRes && orgRes.status < 400 ? ((orgRes.json as { records?: Record<string, unknown>[] } | null)?.records?.[0] ?? null) : null;
  return {
    orgId: (typeof org?.Id === "string" ? org.Id : null) ?? u.organization_id ?? null,
    userId: u.user_id ?? null,
    username: u.preferred_username ?? null,
    orgName: typeof org?.Name === "string" ? org.Name : null,
    isSandbox: typeof org?.IsSandbox === "boolean" ? org.IsSandbox : null,
  };
}
