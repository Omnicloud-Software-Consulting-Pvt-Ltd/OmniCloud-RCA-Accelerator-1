import type { NextRequest } from "next/server";
import { apiUrl, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta } from "@/lib/tax/server/metadata";
import { taxRoute } from "@/lib/tax/server/route";
import { ensureGeography, type GeoApi } from "@/lib/taxLibrary/server/geoEnsure";

/**
 * POST /api/taxes/rate-library/geo — create the Salesforce Geo Country (and Geo State) a Global Tax Library mapping row needs, only
 * when missing, only with `confirmed: true` (the user's explicit "Yes, Create Automatically"). Server-side, with this request's own
 * Salesforce session (no token reaches the browser). Duplicates are re-checked immediately before each write; existing records are
 * reused; every returned Id is read back from Salesforce. Body: { confirmed: true, country: { iso, name }, state?: { code, name } }.
 */
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => {
    if (body.confirmed !== true) return { success: false, error: "Geo records are created only after you confirm (confirmed: true). Nothing was created." };
    const country = body.country as { iso?: unknown; name?: unknown } | undefined;
    const state = body.state as { code?: unknown; name?: unknown } | null | undefined;
    const meta = await discoverTaxMetadata(client);
    const api: GeoApi = {
      query: soql => queryAt(client, meta.apiVersion, soql),
      meta: async sobject => {
        const m = objectMeta(meta, sobject);
        return m ? { createable: m.createable, fields: Object.fromEntries(Object.values(m.fields).map(f => [f.name, { createable: f.createable, required: f.required }])) } : null;
      },
      create: async (sobject, fields) => {
        const r = await client.requestWithDiagnostics(apiUrl(client, meta.apiVersion, `/sobjects/${sobject}`), { method: "POST", body: JSON.stringify(fields) });
        const j = r.json as { id?: string } | { errorCode?: string; message?: string }[] | null;
        if (r.status < 300 && j && !Array.isArray(j) && j.id) return { ok: true, id: j.id };
        const e = Array.isArray(j) ? j[0] : null;
        return { ok: false, status: r.status, errorCode: e?.errorCode ?? null, message: e?.message ? `${e.errorCode ? `${e.errorCode}: ` : ""}${e.message}` : `HTTP ${r.status}` };
      },
    };
    const result = await ensureGeography(api, {
      country: { iso: String(country?.iso ?? ""), name: String(country?.name ?? "") },
      state: state ? { code: String(state.code ?? ""), name: String(state.name ?? "") } : null,
    }, client.instanceUrl);
    return { success: result.ok, ...result };
  }, "Failed to create the Salesforce geography", { mutates: true });
}
