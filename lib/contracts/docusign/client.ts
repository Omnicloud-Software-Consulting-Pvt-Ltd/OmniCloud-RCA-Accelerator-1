import { isDocuSignBaseUri, type FetchLike } from "@/lib/contracts/docusign/oauth";

/**
 * eSignature REST API v2.1 client for ONE connected account. Paths are relative to /restapi/v2.1/accounts/{accountId}.
 * The access token comes from a provider (the server context refreshes it); a 401 triggers exactly one refresh + retry.
 * Docs: https://developers.docusign.com/docs/esign-rest-api/reference/
 */

export class DocuSignApiError extends Error {
  constructor(message: string, readonly status: number, readonly errorCode: string | null, readonly raw: unknown) { super(message); }
}

export interface DocuSignApi {
  accountId: string;
  json<T = Record<string, unknown>>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
  binary(path: string): Promise<{ buffer: Buffer; contentType: string }>;
}

export interface TokenProvider {
  /** A currently valid access token (refreshing first when needed). */
  get(): Promise<string>;
  /** Called after DocuSign returns 401: force a refresh and return the new token, or null when the connection can't be refreshed. */
  refresh(): Promise<string | null>;
}

export function docuSignApi(o: { baseUri: string; accountId: string; tokens: TokenProvider; fetchImpl?: FetchLike }): DocuSignApi {
  if (!isDocuSignBaseUri(o.baseUri)) throw new DocuSignApiError("The stored DocuSign API address isn't a DocuSign address — reconnect DocuSign.", 400, "INVALID_BASE_URI", null);
  const doFetch = o.fetchImpl ?? fetch;
  const root = `${o.baseUri.replace(/\/+$/, "")}/restapi/v2.1/accounts/${encodeURIComponent(o.accountId)}`;

  async function send(method: string, path: string, init: RequestInit): Promise<Response> {
    const go = async (token: string) => {
      try {
        return await doFetch(`${root}${path}`, { ...init, method, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` }, cache: "no-store" });
      } catch {
        throw new DocuSignApiError("Couldn't reach DocuSign. Check your network connection and try again.", 503, "NETWORK_ERROR", null);
      }
    };
    let res = await go(await o.tokens.get());
    if (res.status === 401) {
      const fresh = await o.tokens.refresh();
      if (fresh) res = await go(fresh);
    }
    return res;
  }

  async function fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
    const code = typeof body?.errorCode === "string" ? body.errorCode : null;
    const message = typeof body?.message === "string" ? body.message : `DocuSign returned HTTP ${res.status}.`;
    throw new DocuSignApiError(res.status === 401 ? "DocuSign rejected the connection's credentials — reconnect DocuSign." : message, res.status, code ?? (res.status === 401 ? "AUTHORIZATION_INVALID" : null), body ?? (text ? text.slice(0, 500) : null));
  }

  return {
    accountId: o.accountId,
    async json<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
      const res = await send(method, path, body === undefined ? { headers: { Accept: "application/json" } } : { headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) return fail(res);
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    },
    async binary(path: string) {
      const res = await send("GET", path, { headers: { Accept: "application/pdf" } });
      if (!res.ok) return fail(res);
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/pdf" };
    },
  };
}

/** Plain-language message for common DocuSign error codes (the original code is always kept alongside it). */
export function friendlyDocuSignError(err: DocuSignApiError): string {
  switch (err.errorCode) {
    case "ANCHOR_TAB_STRING_NOT_FOUND": return "DocuSign couldn't find the text you chose for signature placement in the document. Check the text matches the document exactly, or choose \"Let the signer choose where to sign\".";
    case "USER_LACKS_PERMISSIONS":
    case "USER_NOT_AUTHORIZED_FOR_ACCOUNT": return "Your DocuSign user isn't allowed to do this in the connected account. Ask your DocuSign administrator for sending permission.";
    case "ENVELOPE_DOES_NOT_EXIST": return "DocuSign has no envelope with this Id in the connected account.";
    case "INVALID_EMAIL_ADDRESS_FOR_RECIPIENT": return "DocuSign rejected one of the recipient email addresses.";
    case "ENVELOPE_CANNOT_VOID_INVALID_STATE": return "This envelope can't be voided in its current state.";
    case "ACCOUNT_LACKS_PERMISSIONS": return "The connected DocuSign account's plan doesn't allow this action.";
    default: return err.message;
  }
}
