import type { SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, queryAt } from "@/lib/billing/server/billingDocuments";

/**
 * The only Salesforce surface the RAMP module uses — one org, one session, one API version (the org's newest, so v65+ ramp fields
 * and v68 RampUpliftType are visible). Implemented by the real session below and by an in-memory org in tests, so every Salesforce
 * call the module makes is also exercised by automated tests (without writing to a real org).
 */
export interface RampApi {
  apiVersion: string;
  instanceUrl: string;
  query<T = Record<string, unknown>>(soql: string): Promise<T[]>;
  /** REST call. `path` is relative to /services/data/{version} ("/sobjects/…", "/connect/…") or an absolute "/services/data/…" path. */
  call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  describe(sobject: string): Promise<Record<string, unknown> | null>;
}

export function rampApiFor(client: SalesforceClient, version: string): RampApi {
  const describes = new Map<string, Promise<Record<string, unknown> | null>>();
  const url = (path: string) => (path.startsWith("/services/") ? `${client.instanceUrl}${path}` : apiUrl(client, version, path));
  return {
    apiVersion: version,
    instanceUrl: client.instanceUrl,
    query: <T,>(soql: string) => queryAt(client, version, soql) as Promise<T[]>,
    async call(method, path, body) {
      const r = await client.requestWithDiagnostics(url(path), { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: r.json ?? (r.rawText || null) };
    },
    describe(sobject) {
      if (!describes.has(sobject)) {
        describes.set(sobject, client.requestWithDiagnostics(url(`/sobjects/${sobject}/describe`), { method: "GET" })
          .then(r => (r.status < 300 && r.json && typeof r.json === "object" ? (r.json as Record<string, unknown>) : null)).catch(() => null));
      }
      return describes.get(sobject)!;
    },
  };
}

/** Salesforce's own error text from any error body shape ([{errorCode,message}], {errors}, {errorResponse}, {responseError}). */
export function sfMessage(body: unknown, fallback: string): string {
  const pick = (e: unknown): string | null => {
    if (!e || typeof e !== "object") return typeof e === "string" ? e : null;
    const o = e as Record<string, unknown>;
    const m = o.message ?? o.errorMessage;
    const code = o.errorCode ?? o.statusCode;
    return typeof m === "string" ? `${typeof code === "string" ? `${code}: ` : ""}${m}` : null;
  };
  if (Array.isArray(body)) { const ms = body.map(pick).filter(Boolean); if (ms.length) return ms.join("; "); }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["errors", "errorResponse", "responseError"]) {
      const v = o[k];
      if (Array.isArray(v) && v.length) { const ms = v.map(pick).filter(Boolean); if (ms.length) return ms.join("; "); }
    }
    const single = pick(o);
    if (single) return single;
  }
  return typeof body === "string" && body ? body.slice(0, 500) : fallback;
}

/** A Connect "sales transaction" response failed (any of the shapes Salesforce uses: success / isSuccess / errors / errorResponse / responseError). */
export function connectFailed(status: number, body: unknown): boolean {
  if (status >= 400) return true;
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.success === false || b.isSuccess === false) return true;
  return ["errors", "errorResponse", "responseError"].some(k => Array.isArray(b[k]) && (b[k] as unknown[]).length > 0);
}

export const soql = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
export const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
