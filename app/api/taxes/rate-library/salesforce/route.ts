import type { NextRequest } from "next/server";
import { soqlEscape } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta, referenceField } from "@/lib/tax/server/metadata";
import { taxRoute } from "@/lib/tax/server/route";
import { sessionIdentity } from "@/lib/salesforce/sessionIdentity";
import { verifyRateGeo } from "@/lib/taxLibrary/server/geoEnsure";

/**
 * GET /api/taxes/rate-library/salesforce — READ-ONLY Salesforce lookups for the Global Tax Rate Library (never writes):
 *  · ?mode=geo&country=IN&state=AP — the org's GeoCountry (IsoCode = country) and GeoState (IsoCode = state, under that
 *    country) records, so "Use This Rate" can preselect the Tax Rate form's Geo Country / Geo State lookups. A record the org
 *    doesn't have is reported as missing — it's never created here.
 *  · ?mode=product&id=01t… — a product's classification metadata: Product2's reference to ProductClassification (BasedOnId in
 *    Revenue Cloud, found via Describe) → Name / Code. ProductCode is deliberately NOT used as a tax classification.
 */
const ISO = /^[A-Za-z0-9]{1,6}$/;
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return taxRoute(req, async client => {
    const meta = await discoverTaxMetadata(client);
    if (sp.get("mode") === "product") {
      const id = sp.get("id") ?? "";
      if (!ID.test(id)) return { success: false, error: "Invalid product Id." };
      const product = objectMeta(meta, "Product2");
      const ref = product ? Object.values(product.fields).find(f => f.type === "reference" && f.referenceTo.includes("ProductClassification")) : undefined;
      const rel = ref ? ref.name.replace(/Id$/, "") : null;
      const cols = ["Id", "Name", ...(product?.fields.ProductCode ? ["ProductCode"] : []), ...(ref && rel ? [ref.name, `${rel}.Name`, `${rel}.Code`] : [])];
      const [p] = await queryAt(client, meta.apiVersion, `SELECT ${cols.join(", ")} FROM Product2 WHERE Id = '${soqlEscape(id)}' LIMIT 1`).catch(async () =>
        // Code may not exist on ProductClassification in every org — retry without it.
        queryAt(client, meta.apiVersion, `SELECT ${cols.filter(c => !c.endsWith(".Code")).join(", ")} FROM Product2 WHERE Id = '${soqlEscape(id)}' LIMIT 1`));
      if (!p) return { success: false, error: "Product not found in Salesforce." };
      const cls = rel ? (p[rel] as { Name?: string; Code?: string } | null) : null;
      return {
        success: true,
        product: { id: String(p.Id), name: String(p.Name), productCode: (p.ProductCode as string) ?? null },
        classification: cls ? { field: ref!.name, name: cls.Name ?? null, code: cls.Code ?? null } : null,
        classificationFieldAvailable: !!ref,
      };
    }

    // ?mode=dashboard — the Taxes dashboard's Tax Library widget (read-only): the CURRENT Salesforce user's tax configuration per
    // country (Tax Rates, Geo States, Geo Countries they created), the org's Tax Rates per country, and the user's recent Tax Rates.
    // Each part fails on its own (reported in `errors`), so one missing permission never blanks the widget.
    if (sp.get("mode") === "dashboard") {
      const me = await sessionIdentity(client);
      const errors: string[] = [];
      const run = async <T,>(label: string, soql: string, map: (r: Record<string, unknown>) => T): Promise<T[] | null> => {
        try { return (await queryAt(client, meta.apiVersion, soql)).map(map); } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null; }
      };
      const uid = me.userId ? soqlEscape(me.userId) : null;
      const rate = objectMeta(meta, "TaxRate");
      const hasGeo = !!rate?.fields.GeoCountryId, hasState = !!rate?.fields.GeoStateId;
      const iso = (r: Record<string, unknown>) => String(r.iso ?? "").toUpperCase();
      const activity = (r: Record<string, unknown>) => ({ iso: iso(r), n: Number(r.n ?? 0), lastAt: (r.lastAt as string) ?? null });
      const [myRates, myStates, myCountries, configured, recentRates] = await Promise.all([
        uid && hasGeo ? run("Your Tax Rates", `SELECT GeoCountry.IsoCode iso, COUNT(Id) n, MAX(CreatedDate) lastAt FROM TaxRate WHERE CreatedById = '${uid}' AND GeoCountryId != null GROUP BY GeoCountry.IsoCode`, activity) : null,
        uid && objectMeta(meta, "GeoState") ? run("Your Geo States", `SELECT GeoCountry.IsoCode iso, COUNT(Id) n, MAX(CreatedDate) lastAt FROM GeoState WHERE CreatedById = '${uid}' GROUP BY GeoCountry.IsoCode`, activity) : null,
        uid && objectMeta(meta, "GeoCountry") ? run("Your Geo Countries", `SELECT IsoCode, CreatedDate FROM GeoCountry WHERE CreatedById = '${uid}' LIMIT 500`, r => ({ iso: String(r.IsoCode ?? "").toUpperCase(), n: 1, lastAt: (r.CreatedDate as string) ?? null })) : null,
        hasGeo ? run("Org Tax Rates by country", "SELECT GeoCountry.IsoCode iso, GeoCountry.Name name, COUNT(Id) n FROM TaxRate WHERE GeoCountryId != null GROUP BY GeoCountry.IsoCode, GeoCountry.Name ORDER BY COUNT(Id) DESC LIMIT 50", r => ({ iso: iso(r), name: (r.name as string) ?? null, n: Number(r.n ?? 0) })) : null,
        uid && rate ? run("Your recent Tax Rates", `SELECT Id, Name, TaxCode, Rate, CreatedDate, LastModifiedDate${hasGeo ? ", GeoCountry.Name, GeoCountry.IsoCode" : ""}${hasState ? ", GeoState.Name, GeoState.IsoCode" : ""} FROM TaxRate WHERE CreatedById = '${uid}' OR LastModifiedById = '${uid}' ORDER BY LastModifiedDate DESC LIMIT 8`, r => {
          const c = r.GeoCountry as { Name?: string; IsoCode?: string } | null, s = r.GeoState as { Name?: string; IsoCode?: string } | null;
          return { id: String(r.Id), name: String(r.Name ?? r.Id), taxCode: (r.TaxCode as string) ?? null, rate: typeof r.Rate === "number" ? r.Rate : null, countryIso: c?.IsoCode ?? null, countryName: c?.Name ?? null, stateIso: s?.IsoCode ?? null, stateName: s?.Name ?? null, createdDate: String(r.CreatedDate), lastModifiedDate: String(r.LastModifiedDate) };
        }) : null,
      ]);
      const mine = myRates || myStates || myCountries ? [...(myRates ?? []), ...(myStates ?? []), ...(myCountries ?? [])] : null;
      if (!uid) errors.push("The Salesforce user couldn't be identified — your activity isn't shown.");
      return { success: true, orgId: me.orgId, userId: me.userId, myActivity: mine, myTaxRates: myRates, myGeo: myStates || myCountries ? [...(myStates ?? []), ...(myCountries ?? [])] : null, configured: configured ?? [], recentRates: recentRates ?? [], errors };
    }

    // ?mode=verify-rate&id=0xq…&geoCountryId=…&geoStateId=… — read back a Tax Rate created from a mapping row and confirm it references
    // exactly the intended Geo Country / Geo State (the relationship fields, not names). Read-only.
    if (sp.get("mode") === "verify-rate") {
      const id = sp.get("id") ?? "", gcId = sp.get("geoCountryId") ?? "", gsId = sp.get("geoStateId") || null;
      if (!ID.test(id) || !ID.test(gcId) || (gsId && !ID.test(gsId))) return { success: false, error: "Invalid Tax Rate / Geo Id." };
      const [row] = await queryAt(client, meta.apiVersion, `SELECT Id, Name, GeoCountryId, GeoStateId FROM TaxRate WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
      const v = verifyRateGeo(row ?? null, { geoCountryId: gcId, geoStateId: gsId });
      return { success: v.ok, verified: v.ok, message: v.message, rate: row ? { id: String(row.Id), name: String(row.Name ?? ""), geoCountryId: (row.GeoCountryId as string) ?? null, geoStateId: (row.GeoStateId as string) ?? null } : null };
    }

    // ?mode=geo-all — EVERY GeoCountry and GeoState in the connected org (all pages), so the mapping table can show which Geo records
    // exist for any row. Geo States carry their parent's Id and ISO code (GeoState → GeoCountry lookup). Read-only.
    if (sp.get("mode") === "geo-all") {
      const gcm = objectMeta(meta, "GeoCountry"), gsm = objectMeta(meta, "GeoState");
      const parentField = gsm ? referenceField(gsm, "GeoCountry") : null;
      const available = { geoCountry: !!gcm?.fields.IsoCode, geoState: !!gsm?.fields.IsoCode && !!parentField, createGeoCountry: !!gcm?.createable, createGeoState: !!gsm?.createable };
      const countries = available.geoCountry ? await queryAt(client, meta.apiVersion, "SELECT Id, Name, IsoCode FROM GeoCountry ORDER BY IsoCode") : [];
      const rel = parentField ? parentField.replace(/Id$/, "") : null;
      const states = available.geoState && rel ? await queryAt(client, meta.apiVersion, `SELECT Id, Name, IsoCode, ${parentField}, ${rel}.IsoCode FROM GeoState ORDER BY Name`) : [];
      return {
        success: true, available,
        countries: countries.map(c => ({ id: String(c.Id), name: String(c.Name ?? ""), isoCode: String(c.IsoCode ?? "").toUpperCase() })),
        states: states.map(s => ({ id: String(s.Id), name: String(s.Name ?? ""), isoCode: s.IsoCode == null ? null : String(s.IsoCode).toUpperCase(), geoCountryId: String(s[parentField!] ?? ""), countryIso: String((s[rel!] as { IsoCode?: string } | null)?.IsoCode ?? "").toUpperCase() })),
      };
    }

    const country = (sp.get("country") ?? "").toUpperCase();
    const state = (sp.get("state") ?? "").toUpperCase();
    if (!ISO.test(country) || (state && !ISO.test(state))) return { success: false, error: "Invalid country or state code." };
    const gc = objectMeta(meta, "GeoCountry"), gs = objectMeta(meta, "GeoState");

    // ?mode=geo-states&country=AU — the org's GeoCountry for that ISO code and EVERY GeoState under it (by the GeoState → GeoCountry
    // lookup, not by name), for the Country → Geo State mapping table. Two queries per selected country; nothing is written.
    if (sp.get("mode") === "geo-states") {
      const parentField = gs ? referenceField(gs, "GeoCountry") : null;
      const available = { geoCountry: !!gc?.fields.IsoCode, geoState: !!gs?.fields.IsoCode && !!parentField };
      if (!available.geoCountry) return { success: true, country: null, states: [], available };
      const [c] = await queryAt(client, meta.apiVersion, `SELECT Id, Name, IsoCode FROM GeoCountry WHERE IsoCode = '${soqlEscape(country)}' LIMIT 2`);
      if (!c || !available.geoState) return { success: true, country: c ? { id: String(c.Id), name: String(c.Name), isoCode: String(c.IsoCode) } : null, states: [], available };
      const rows = await queryAt(client, meta.apiVersion, `SELECT Id, Name, IsoCode FROM GeoState WHERE ${parentField} = '${soqlEscape(String(c.Id))}' ORDER BY Name LIMIT 2000`);
      return {
        success: true, available,
        country: { id: String(c.Id), name: String(c.Name), isoCode: String(c.IsoCode) },
        states: rows.map(s => ({ id: String(s.Id), name: String(s.Name), isoCode: s.IsoCode == null ? null : String(s.IsoCode) })),
      };
    }
    const out: { success: true; country: { id: string; name: string; isoCode: string } | null; state: { id: string; name: string; isoCode: string } | null; available: { geoCountry: boolean; geoState: boolean } } =
      { success: true, country: null, state: null, available: { geoCountry: !!gc?.fields.IsoCode, geoState: !!gs?.fields.IsoCode } };
    if (!gc?.fields.IsoCode) return out;
    const [c] = await queryAt(client, meta.apiVersion, `SELECT Id, Name, IsoCode FROM GeoCountry WHERE IsoCode = '${soqlEscape(country)}' LIMIT 2`);
    if (c) out.country = { id: String(c.Id), name: String(c.Name), isoCode: String(c.IsoCode) };
    const parent = gs ? referenceField(gs, "GeoCountry") : null;
    if (state && c && gs?.fields.IsoCode && parent) {
      const [s] = await queryAt(client, meta.apiVersion, `SELECT Id, Name, IsoCode FROM GeoState WHERE IsoCode = '${soqlEscape(state)}' AND ${parent} = '${soqlEscape(String(c.Id))}' LIMIT 2`);
      if (s) out.state = { id: String(s.Id), name: String(s.Name), isoCode: String(s.IsoCode) };
    }
    return out;
  }, "Failed to read Salesforce geography for the Tax Rate Library");
}
