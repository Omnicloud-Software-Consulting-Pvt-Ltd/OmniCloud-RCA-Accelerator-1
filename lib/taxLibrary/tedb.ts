import type { FlatRow } from "@/lib/taxLibrary/importExport";
import type { DatasetManifest } from "@/lib/taxLibrary/datasets";

/**
 * EUROPEAN COMMISSION — TAXES IN EUROPE DATABASE (TEDB) VAT RETRIEVAL SERVICE → library rows.
 *
 * Source: the Commission's official, free SOAP service (no authentication) — WSDL
 * https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService.wsdl, operation retrieveVatRates (verified 2026-11-05).
 * Each result: memberState, type STANDARD|REDUCED, rate {type DEFAULT|REDUCED_RATE|SUPER_REDUCED_RATE|PARKING_RATE|EXEMPTED|
 * NOT_APPLICABLE|OUT_OF_SCOPE, value}, situationOn, CN / CPA codes, TEDB category, comment.
 *
 * Mapping decisions (stated, never hidden):
 *  · One library record per member state + rate kind + value + TEDB category (CN/CPA codes of the same group are merged).
 *  · NOT_APPLICABLE / OUT_OF_SCOPE carry no rate → not imported (counted in `skipped`). EXEMPTED → 0 % with category "Exempt".
 *  · TEDB has no tax codes: codes like "DE-VAT-RED-7" are APP-GENERATED reference codes (stated on every record).
 *  · Effective From = TEDB "situation" date (the date the rate is reported as applying) — the rate may have started earlier.
 *  · Greece is "EL" in TEDB → ISO "GR".
 *  · Verification "verified": retrieved directly from the authority's own service on `retrievedOn`. The Commission notes TEDB
 *    is informational and not a legal reference — that disclaimer is on every record.
 */

export const TEDB_ENDPOINT = "https://ec.europa.eu/taxation_customs/tedb/ws/";
export const TEDB_SOAP_ACTION = "urn:ec.europa.eu:taxud:tedb:services:v1:VatRetrievalService/RetrieveVatRates";
export const TEDB_SOURCE_URL = "https://ec.europa.eu/taxation_customs/tedb/";
/** TEDB member-state codes (Greece = EL). */
export const EU_MEMBER_STATES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"] as const;
export const toIsoCountry = (ms: string) => (ms === "EL" ? "GR" : ms);
export const toTedbCountry = (iso: string) => (iso === "GR" ? "EL" : iso);

export type TedbRateType = "DEFAULT" | "REDUCED_RATE" | "SUPER_REDUCED_RATE" | "PARKING_RATE" | "EXEMPTED" | "NOT_APPLICABLE" | "OUT_OF_SCOPE";
export interface TedbResult {
  memberState: string;
  type: "STANDARD" | "REDUCED";
  rateType: TedbRateType;
  value: number | null;
  situationOn: string;
  cnCodes: { value: string; description: string }[];
  cpaCodes: { value: string; description: string }[];
  category: { identifier: string; description: string } | null;
  comment: string | null;
}

export function buildTedbRequest(memberStates: string[], situationOn: string): string {
  const states = memberStates.map(m => `<urn1:isoCode>${toTedbCountry(m.toUpperCase())}</urn1:isoCode>`).join("");
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService" xmlns:urn1="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService:types"><soapenv:Header/><soapenv:Body><urn:retrieveVatRatesReqMsg><urn1:memberStates>${states}</urn1:memberStates><urn1:situationOn>${situationOn}</urn1:situationOn></urn:retrieveVatRatesReqMsg></soapenv:Body></soapenv:Envelope>`;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").trim();
/** Content of the FIRST <tag>…</tag> (namespace prefixes tolerated). */
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1] : null;
}
function all(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g"))].map(m => m[1]);
}
const codes = (block: string | null) => (block ? all(block, "code").map(c => ({ value: decode(tag(c, "value") ?? ""), description: decode(tag(c, "description") ?? "") })) : []);

/** Parse a retrieveVatRates SOAP response. Throws on a SOAP fault. */
export function parseTedbResponse(xml: string): TedbResult[] {
  const fault = tag(xml, "Fault") ?? tag(xml, "retrieveVatRatesFaultMsg");
  if (fault) throw new Error(`TEDB returned a fault: ${decode(fault.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ")}`);
  return all(xml, "vatRateResults").map(r => {
    const rate = tag(r, "rate") ?? "";
    const value = tag(rate, "value");
    const cat = tag(r, "category");
    // The result's own <type> is the first one outside <rate>.
    const outerType = tag(r.replace(/<(?:[\w-]+:)?rate>[\s\S]*?<\/(?:[\w-]+:)?rate>/, ""), "type");
    return {
      memberState: decode(tag(r, "memberState") ?? ""),
      type: (outerType === "STANDARD" ? "STANDARD" : "REDUCED") as TedbResult["type"],
      rateType: decode(tag(rate, "type") ?? "DEFAULT") as TedbRateType,
      value: value !== null && value.trim() !== "" ? Number(value) : null,
      situationOn: decode(tag(r, "situationOn") ?? "").slice(0, 10),
      cnCodes: codes(tag(r, "cnCodes")),
      cpaCodes: codes(tag(r, "cpaCodes")),
      category: cat ? { identifier: decode(tag(cat, "identifier") ?? ""), description: decode(tag(cat, "description") ?? "") } : null,
      comment: tag(r, "comment") !== null ? decode(tag(r, "comment")!) : null,
    };
  });
}

const KIND: Record<TedbRateType, { code: string; label: string } | null> = {
  DEFAULT: { code: "STD", label: "Standard" }, REDUCED_RATE: { code: "RED", label: "Reduced" }, SUPER_REDUCED_RATE: { code: "SRED", label: "Super-reduced" },
  PARKING_RATE: { code: "PARK", label: "Parking" }, EXEMPTED: { code: "EXEMPT", label: "Exempt" }, NOT_APPLICABLE: null, OUT_OF_SCOPE: null,
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmt = (n: number) => String(Number(n.toFixed(4)));

export interface TedbConversion { rows: FlatRow[]; skipped: { memberState: string; rateType: string; reason: string }[]; countries: string[] }

/** TEDB results → flat library rows (merged per state + kind + value + category). Pure. */
export function tedbToRows(results: TedbResult[], opts: { retrievedOn: string }): TedbConversion {
  const skipped: TedbConversion["skipped"] = [];
  const groups = new Map<string, TedbResult[]>();
  for (const r of results) {
    if (!KIND[r.rateType]) { skipped.push({ memberState: r.memberState, rateType: r.rateType, reason: "No rate (not applicable / out of scope)" }); continue; }
    if (r.rateType !== "EXEMPTED" && (r.value === null || !Number.isFinite(r.value))) { skipped.push({ memberState: r.memberState, rateType: r.rateType, reason: "No numeric rate value" }); continue; }
    const key = [r.memberState, r.type, r.rateType, r.value ?? 0, r.category?.identifier ?? "", r.situationOn].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // Member states with more than one STANDARD value: the highest is the national rate; the others are regional (e.g. ES 7 % =
  // Canary Islands per TEDB's comment). TEDB gives no ISO subdivision for them, so the region is recorded from its comment.
  const nationalStd = new Map<string, number>();
  for (const r of results) if (r.type === "STANDARD" && r.rateType === "DEFAULT" && r.value !== null) nationalStd.set(r.memberState, Math.max(nationalStd.get(r.memberState) ?? -1, r.value));
  const rows: FlatRow[] = [];
  for (const g of groups.values()) {
    const r = g[0];
    const cc = toIsoCountry(r.memberState);
    const kind = KIND[r.rateType]!;
    const pct = r.rateType === "EXEMPTED" ? 0 : r.value!;
    const cn = [...new Set(g.flatMap(x => x.cnCodes.map(c => c.value)))];
    const cpa = [...new Set(g.flatMap(x => x.cpaCodes.map(c => c.value)))];
    const comments = [...new Set(g.map(x => x.comment).filter((c): c is string => !!c))];
    const cat = r.category;
    const codeList = (label: string, list: string[]) => (list.length ? `${label}: ${list.slice(0, 25).join(", ")}${list.length > 25 ? ` (+${list.length - 25} more)` : ""}` : null);
    const regional = cat?.identifier === "REGION" || (r.type === "STANDARD" && r.value !== null && r.value < (nationalStd.get(r.memberState) ?? r.value));
    rows.push({
      countryCode: cc,
      locality: regional ? clip(comments[0] ?? "Specific region (see source)", 120) : null,
      placeOfSupply: regional ? "Region-specific rate (TEDB) — applies only in the region named, not country-wide" : null,
      taxCode: `${cc}-VAT-${kind.code}${r.rateType === "EXEMPTED" ? "" : `-${fmt(pct)}`}`,
      taxName: `VAT ${kind.label.toLowerCase()}${r.rateType === "EXEMPTED" ? "" : ` ${fmt(pct)}%`}${cat ? ` — ${clip(cat.description, 70)}` : ""}`,
      taxType: "VAT",
      taxStructure: "VAT",
      taxAuthority: "European Commission (TEDB) — as reported by the Member State",
      taxCategory: kind.label,
      ratePercent: pct,
      calculation: "percentage",
      classificationSystem: cat ? "TEDB category" : cn.length ? "CN" : cpa.length ? "CPA" : null,
      classificationCode: cat?.identifier ?? null,
      productCategory: cat ? clip(cat.description, 240) : null,
      conditions: [codeList("CN", cn), codeList("CPA", cpa)].filter(Boolean).join(" · ") || null,
      effectiveFrom: r.situationOn,
      effectiveTo: null,
      lifecycle: "published",
      sourceName: "European Commission — Taxes in Europe Database (TEDB)",
      sourceUrl: TEDB_SOURCE_URL,
      sourceReference: `TEDB VatRetrievalService, retrieved ${opts.retrievedOn} (situation ${r.situationOn}, ${r.type} / ${r.rateType})`,
      notes: [
        ...comments.map(c => `TEDB comment: ${clip(c, 400)}`),
        "App-generated Tax Code (TEDB has none). Effective From = TEDB situation date (may have applied earlier). Informational, not a legal reference (EC).",
      ].join(" "),
      verification: "verified",
      lastVerifiedAt: opts.retrievedOn,
    });
  }
  return { rows, skipped, countries: [...new Set(rows.map(r => String(r.countryCode)))].sort() };
}

export function tedbManifest(conv: TedbConversion, retrievedOn: string, requested: string[]): DatasetManifest {
  return {
    id: "eu-tedb-vat",
    name: "EU VAT rates — European Commission TEDB",
    version: retrievedOn,
    retrievedAt: retrievedOn,
    source: "European Commission, Directorate-General for Taxation and Customs Union — Taxes in Europe Database (TEDB), VatRetrievalService",
    sourceUrl: TEDB_SOURCE_URL,
    license: "© European Union. Reuse authorised provided the source is acknowledged (Commission Decision 2011/833/EU). TEDB is informational, not a legal reference.",
    coverage: {
      countries: requested.map(toIsoCountry).sort(),
      scope: "National VAT — standard, reduced, super-reduced, parking and exempt rates by TEDB category (EU Member States). No sub-national or non-VAT taxes.",
      complete: true,
    },
    recordCount: conv.rows.length,
    notes: `${conv.skipped.length} TEDB entries without a rate (not applicable / out of scope) were not imported.`,
  };
}
