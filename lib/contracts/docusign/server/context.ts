import { NextResponse, type NextRequest } from "next/server";
import { SalesforceError, soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { DocuSignApiError, docuSignApi, friendlyDocuSignError, type DocuSignApi } from "@/lib/contracts/docusign/client";
import { encryptionKeyState, loadEncryptionKey, sessionBinding } from "@/lib/contracts/docusign/crypto";
import { EnvelopeNotFoundError, orgKeyOf } from "@/lib/contracts/docusign/envelopes";
import { DocuSignOAuthError, refreshAccessToken, type FetchLike } from "@/lib/contracts/docusign/oauth";
import { CookieJar, CredentialTooLargeError, readAccessToken, readConnection } from "@/lib/contracts/docusign/server/session";
import { serverSecurityMessage, type StoredConnection } from "@/lib/contracts/docusign/types";
import { SFID } from "@/lib/contracts/docusign/validation";

/**
 * The one gate every DocuSign route goes through, in this order:
 *  1. a Salesforce session (requireSFClient) — DocuSign is only reachable by a signed-in app user;
 *  2. the server encryption key — without it credentials can't be stored safely, so the feature is off;
 *  3. a DocuSign connection that was created in THIS Salesforce session (binding) — never another user's or another org's;
 *  4. (contract routes) the Contract, read with the user's own Salesforce session, so Salesforce sharing decides access;
 *  5. a valid DocuSign access token (refreshed server-side when needed; rotated tokens are re-encrypted into the cookie).
 * Errors are mapped to plain-language messages; DocuSign's own status/code/message is kept in `docusign`.
 */

export class InputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_INPUT", readonly issues: { field: string; message: string }[] = []) { super(message); }
}
class ConnectionExpiredError extends Error {}

export interface ContractRef { id: string; contractNumber: string | null; name: string | null; accountName: string | null; status: string | null }

export interface DocuSignContext {
  sf: SalesforceClient;
  conn: StoredConnection;
  api: DocuSignApi;
  orgKey: string;
  contract: ContractRef | null;
  jar: CookieJar;
}

export function jsonError(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error, code, ...extra }, { status });
}

export async function loadContract(sf: SalesforceClient, contractId: string): Promise<ContractRef | null> {
  const run = async (withName: boolean) => {
    const res = await sf.query<Record<string, unknown>>(`SELECT Id, ContractNumber,${withName ? " Name," : ""} Status, Account.Name FROM Contract WHERE Id = '${soqlEscape(contractId)}' LIMIT 1`);
    const r = res.records[0];
    if (!r) return null;
    return {
      id: String(r.Id),
      contractNumber: typeof r.ContractNumber === "string" ? r.ContractNumber : null,
      name: withName && typeof r.Name === "string" ? r.Name : null,
      status: typeof r.Status === "string" ? r.Status : null,
      accountName: typeof (r.Account as { Name?: unknown } | null)?.Name === "string" ? String((r.Account as { Name: string }).Name) : null,
    };
  };
  try {
    return await run(true);
  } catch (e) {
    // Contract Name can be hidden by field-level security; the rest of the flow doesn't need it.
    if (e instanceof SalesforceError && e.errorCode === "INVALID_FIELD") return run(false);
    throw e;
  }
}

export const contractLabel = (c: ContractRef) => c.name || (c.contractNumber ? `Contract ${c.contractNumber}` : `Contract ${c.id}`);

export interface RouteOptions { contractId?: string | null; fetchImpl?: FetchLike }

export async function docuSignRoute(req: NextRequest, opts: RouteOptions, run: (ctx: DocuSignContext) => Promise<NextResponse | Record<string, unknown>>): Promise<NextResponse> {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const key = loadEncryptionKey();
  // Same plain message users see everywhere; the code distinguishes the case for support and server logs.
  if (!key) { const invalid = encryptionKeyState() === "invalid"; return jsonError(503, invalid ? "DOCUSIGN_ENCRYPTION_KEY_INVALID" : "DOCUSIGN_ENCRYPTION_KEY_MISSING", serverSecurityMessage(invalid ? "invalid" : "missing")); }

  const jar = new CookieJar(key);
  const binding = sessionBinding(auth.client.cacheScope);
  const conn = readConnection(req, key);
  if (!conn) return jsonError(409, "DOCUSIGN_NOT_CONNECTED", "DocuSign isn't connected yet. Open DocuSign Settings to connect your account.");
  if (conn.binding !== binding) return jsonError(409, "DOCUSIGN_REAUTHORIZATION_REQUIRED", "Your Salesforce sign-in changed since DocuSign was connected. Reconnect DocuSign in DocuSign Settings.");

  const fetchImpl = opts.fetchImpl ?? fetch;
  let current: StoredConnection = conn;
  const cached = readAccessToken(req, key);
  let token: string | null = cached && cached.binding === binding && cached.expiresAt - 60_000 > Date.now() ? cached.token : null;

  const refresh = async (): Promise<string> => {
    try {
      const t = await refreshAccessToken({ environment: current.environment, integrationKey: current.integrationKey, secretKey: current.secretKey, refreshToken: current.refreshToken }, fetchImpl);
      token = t.accessToken;
      jar.setAccessToken({ v: 1, token: t.accessToken, expiresAt: Date.now() + t.expiresInSeconds * 1000, binding });
      if (t.refreshToken && t.refreshToken !== current.refreshToken) {
        current = { ...current, refreshToken: t.refreshToken };
        jar.setConnection(current);
      }
      return t.accessToken;
    } catch (e) {
      if (e instanceof DocuSignOAuthError && (e.code === "invalid_grant" || e.code === "invalid_client" || e.status === 400 || e.status === 401)) throw new ConnectionExpiredError(e.message);
      throw e;
    }
  };

  try {
    let contract: ContractRef | null = null;
    if (opts.contractId !== undefined && opts.contractId !== null) {
      if (!SFID.test(opts.contractId)) return jar.apply(jsonError(400, "INVALID_CONTRACT_ID", "Invalid contract Id."));
      contract = await loadContract(auth.client, opts.contractId);
      if (!contract) return jar.apply(jsonError(404, "CONTRACT_NOT_FOUND", "This contract doesn't exist or isn't visible to your Salesforce user."));
    }
    const api = docuSignApi({
      baseUri: current.baseUri,
      accountId: current.accountId,
      fetchImpl,
      tokens: { get: async () => token ?? refresh(), refresh: async () => { try { return await refresh(); } catch (e) { if (e instanceof ConnectionExpiredError) throw e; return null; } } },
    });
    const out = await run({ sf: auth.client, conn: current, api, orgKey: orgKeyOf(auth.client.instanceUrl), contract, jar });
    return jar.apply(out instanceof NextResponse ? out : NextResponse.json({ success: true, ...out }));
  } catch (e) {
    if (e instanceof ConnectionExpiredError) {
      jar.clear("omni_ds_at");
      return jar.apply(jsonError(401, "DOCUSIGN_CONNECTION_EXPIRED", `${e.message} Open DocuSign Settings and click Reconnect.`));
    }
    return jar.apply(errorResponse(e));
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof InputError) return jsonError(e.status, e.code, e.message, e.issues.length ? { issues: e.issues } : {});
  if (e instanceof CredentialTooLargeError) return jsonError(500, "DOCUSIGN_CREDENTIAL_TOO_LARGE", `${e.message} The connection was not changed — reconnect DocuSign, and contact support if this repeats.`);
  if (e instanceof EnvelopeNotFoundError) return jsonError(404, "ENVELOPE_NOT_FOUND", "This envelope doesn't exist in the connected DocuSign account or doesn't belong to this contract.");
  if (e instanceof DocuSignApiError) {
    const status = e.status === 401 ? 401 : e.status === 403 ? 403 : e.status === 404 ? 404 : e.status === 400 ? 422 : e.status === 503 ? 503 : 502;
    return jsonError(status, e.errorCode ?? "DOCUSIGN_ERROR", friendlyDocuSignError(e), { docusign: { status: e.status, errorCode: e.errorCode, message: e.message } });
  }
  if (e instanceof DocuSignOAuthError) return jsonError(e.status === 503 ? 503 : 502, e.code, e.message);
  if (e instanceof SalesforceError) return sfErrorResponse(e, "Salesforce request failed");
  return jsonError(500, "UNEXPECTED_ERROR", e instanceof Error ? e.message : "Unexpected error.");
}
