import { getCountry, getSubdivision } from "@/lib/taxLibrary/jurisdictions";
import type { Classification, TaxRateReference } from "@/lib/taxLibrary/types";

/**
 * SEED DATASET shipped with the app — a small set of EXAMPLE reference rates, not a complete or authoritative tax database.
 *
 * Every record is `verification: "unverified"`: the values are widely published rates recorded from general knowledge, each
 * pointing at the tax authority to verify against, but none has been checked against that source by this app. Do not treat
 * them as tax determinations. Administrators verify/edit them, add their own, or import a vetted dataset (Import).
 * Records are added to a browser's library only if their id isn't there yet — a user's edits are never overwritten.
 */
export const SEED_DATASET = "omnicloud-seed-2026-11-05";
const T = "2026-11-05T00:00:00.000Z";

const NO_CLASS: Classification = { code: null, system: null, productCategory: null, serviceCategory: null, description: null, conditions: null, transactionType: null, placeOfSupply: null };
const UNVERIFIED_NOTE = "Seeded example — verify against the official source before using it for a Salesforce Tax Rate.";

interface S {
  id: string; lineage?: string; version?: number; supersedes?: string;
  cc: string; country: string; sub?: string; subName?: string;
  code: string; name: string; type: string; structure: string; component?: string; authority: string; category?: string;
  pct: number; order?: number;
  cls?: Partial<Classification>;
  from: string; to?: string;
  src: string; url: string; notes?: string;
}

function rec(s: S): TaxRateReference {
  return {
    id: s.id, lineageId: s.lineage ?? s.id, version: s.version ?? 1, supersedesId: s.supersedes ?? null,
    // Names come from the ISO 3166 reference (e.g. "Karnātaka"), so a seed can never drift from the jurisdiction data.
    jurisdiction: { countryCode: s.cc, countryName: getCountry(s.cc)?.name ?? s.country, subdivisionCode: s.sub ?? null, subdivisionName: s.sub ? getSubdivision(s.sub)?.name ?? s.subName ?? null : null, level: s.sub ? "subdivision" : "country", locality: null },
    tax: { taxCode: s.code, taxName: s.name, taxType: s.type, taxStructure: s.structure, taxComponent: s.component ?? null, taxAuthority: s.authority, taxCategory: s.category ?? null },
    rate: { ratePercent: s.pct, fixedAmount: null, fixedAmountCurrency: null, minRatePercent: null, maxRatePercent: null, calculation: "percentage", compound: false, componentOrder: s.order ?? null },
    classification: { ...NO_CLASS, ...(s.cls ?? {}) },
    effective: { effectiveFrom: s.from, effectiveTo: s.to ?? null },
    source: { sourceName: s.src, sourceUrl: s.url, sourceReference: null, notes: [s.notes, UNVERIFIED_NOTE].filter(Boolean).join(" "), verification: "unverified", lastVerifiedAt: null },
    lifecycle: "published", origin: `seed:${SEED_DATASET}`, createdAt: T, updatedAt: T,
    history: [{ at: T, action: "seeded", detail: `Seeded from ${SEED_DATASET} (unverified example).` }],
  };
}

const IN_SRC = { src: "CBIC / GST Council, Government of India", url: "https://cbic-gst.gov.in/", authority: "Central Board of Indirect Taxes and Customs / State tax departments" };
const CA_SRC = { src: "Canada Revenue Agency — GST/HST rates", url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html", authority: "Canada Revenue Agency" };
const AU_SRC = { src: "Australian Taxation Office — GST", url: "https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst", authority: "Australian Taxation Office" };
const AP = { cc: "IN", country: "India", sub: "IN-AP", subName: "Andhra Pradesh" };
const INTRA = "CGST + SGST (intra-state supply)";

export const SEED_RATES: TaxRateReference[] = [
  /* ── India · Andhra Pradesh: several rates in one state, components, GST 2.0 history ── */
  rec({ id: "seed-in-ap-gst-5", ...AP, code: "GST5", name: "GST 5%", type: "GST", structure: INTRA, ...IN_SRC, pct: 5, from: "2017-07-01" }),
  rec({ id: "seed-in-ap-gst-12", ...AP, code: "GST12", name: "GST 12%", type: "GST", structure: INTRA, ...IN_SRC, pct: 12, from: "2017-07-01", to: "2025-09-21",
    notes: "The 12% slab was merged into 5%/18% by the GST rate rationalisation effective 22 Sep 2025 — kept as history." }),
  rec({ id: "seed-in-ap-gst-18", ...AP, code: "GST18", name: "GST 18%", type: "GST", structure: INTRA, ...IN_SRC, pct: 18, from: "2017-07-01" }),
  rec({ id: "seed-in-ap-cgst-9", ...AP, code: "GST18-CGST", name: "CGST 9% (of GST 18%)", type: "CGST", structure: INTRA, component: "CGST", ...IN_SRC, pct: 9, order: 1, from: "2017-07-01", notes: "Central component of the 18% intra-state rate." }),
  rec({ id: "seed-in-ap-sgst-9", ...AP, code: "GST18-SGST", name: "SGST 9% (of GST 18%)", type: "SGST", structure: INTRA, component: "SGST", ...IN_SRC, pct: 9, order: 2, from: "2017-07-01", notes: "State component of the 18% intra-state rate." }),
  rec({ id: "seed-in-ap-gst-28", ...AP, code: "GST28", name: "GST 28%", type: "GST", structure: INTRA, ...IN_SRC, pct: 28, from: "2017-07-01", to: "2025-09-21",
    notes: "Removed as a general slab by the 22 Sep 2025 rationalisation (some specified goods may still carry it with cess — verify)." }),
  rec({ id: "seed-in-ap-gst-40", ...AP, code: "GST40", name: "GST 40% (special rate)", type: "GST", structure: INTRA, category: "Specified goods", ...IN_SRC, pct: 40, from: "2025-09-22",
    notes: "Special rate introduced by the 22 Sep 2025 rationalisation for specified goods." }),
  rec({ id: "seed-in-ap-hsn-8471", ...AP, code: "GST18-HSN8471", name: "GST 18% — computers (HSN 8471)", type: "GST", structure: INTRA, ...IN_SRC, pct: 18, from: "2017-07-01",
    cls: { system: "HSN", code: "8471", productCategory: "Automatic data-processing machines (computers, laptops)", description: "Classification-specific example." } }),
  rec({ id: "seed-in-ap-sac-9983", ...AP, code: "GST18-SAC9983", name: "GST 18% — professional & technical services (SAC 9983)", type: "GST", structure: INTRA, ...IN_SRC, pct: 18, from: "2017-07-01",
    cls: { system: "SAC", code: "9983", serviceCategory: "Other professional, technical and business services", description: "Classification-specific example." } }),
  rec({ id: "seed-in-igst-18", cc: "IN", country: "India", code: "IGST18", name: "IGST 18% (inter-state)", type: "IGST", structure: "IGST (inter-state supply)", ...IN_SRC, pct: 18, from: "2017-07-01",
    cls: { transactionType: "Inter-state supply" }, notes: "Country-level: applies to inter-state supplies regardless of state." }),
  rec({ id: "seed-in-ka-gst-18", cc: "IN", country: "India", sub: "IN-KA", subName: "Karnataka", code: "GST18", name: "GST 18%", type: "GST", structure: INTRA, ...IN_SRC, pct: 18, from: "2017-07-01" }),

  /* ── Canada: HST provinces, GST-only provinces, GST + provincial components, a versioned change ── */
  rec({ id: "seed-ca-gst-5", cc: "CA", country: "Canada", code: "GST5", name: "GST 5%", type: "GST", structure: "GST (federal)", ...CA_SRC, pct: 5, from: "2008-01-01", notes: "Country-level federal GST, applies where HST doesn't." }),
  rec({ id: "seed-ca-on-hst-13", cc: "CA", country: "Canada", sub: "CA-ON", subName: "Ontario", code: "HST13", name: "HST 13%", type: "HST", structure: "HST (harmonized)", ...CA_SRC, pct: 13, from: "2010-07-01" }),
  rec({ id: "seed-ca-ab-gst-5", cc: "CA", country: "Canada", sub: "CA-AB", subName: "Alberta", code: "GST5", name: "GST 5%", type: "GST", structure: "GST (federal)", ...CA_SRC, pct: 5, from: "2008-01-01", notes: "Alberta has no provincial sales tax." }),
  rec({ id: "seed-ca-bc-gst-5", cc: "CA", country: "Canada", sub: "CA-BC", subName: "British Columbia", code: "GST5", name: "GST 5%", type: "GST", structure: "GST + PST", component: "GST", ...CA_SRC, pct: 5, order: 1, from: "2008-01-01" }),
  rec({ id: "seed-ca-bc-pst-7", cc: "CA", country: "Canada", sub: "CA-BC", subName: "British Columbia", code: "BCPST7", name: "BC PST 7%", type: "PST", structure: "GST + PST", component: "PST", authority: "Government of British Columbia", src: "Government of British Columbia — PST", url: "https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst", pct: 7, order: 2, from: "2013-04-01" }),
  rec({ id: "seed-ca-qc-gst-5", cc: "CA", country: "Canada", sub: "CA-QC", subName: "Quebec", code: "GST5", name: "GST 5%", type: "GST", structure: "GST + QST", component: "GST", ...CA_SRC, pct: 5, order: 1, from: "2008-01-01" }),
  rec({ id: "seed-ca-qc-qst-9975", cc: "CA", country: "Canada", sub: "CA-QC", subName: "Quebec", code: "QST9975", name: "QST 9.975%", type: "QST", structure: "GST + QST", component: "QST", authority: "Revenu Québec", src: "Revenu Québec — GST/HST and QST", url: "https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/", pct: 9.975, order: 2, from: "2013-01-01" }),
  rec({ id: "seed-ca-mb-rst-7", cc: "CA", country: "Canada", sub: "CA-MB", subName: "Manitoba", code: "MBRST7", name: "Manitoba RST 7%", type: "RST", structure: "GST + RST", component: "RST", authority: "Government of Manitoba", src: "Government of Manitoba — Retail Sales Tax", url: "https://www.gov.mb.ca/finance/taxation/", pct: 7, order: 2, from: "2019-07-01" }),
  rec({ id: "seed-ca-ns-hst-15", lineage: "seed-ca-ns-hst", version: 1, cc: "CA", country: "Canada", sub: "CA-NS", subName: "Nova Scotia", code: "HST", name: "HST 15%", type: "HST", structure: "HST (harmonized)", ...CA_SRC, pct: 15, from: "2010-07-01", to: "2025-03-31",
    notes: "Version 1 — superseded by 14% from 1 Apr 2025." }),
  rec({ id: "seed-ca-ns-hst-14", lineage: "seed-ca-ns-hst", version: 2, supersedes: "seed-ca-ns-hst-15", cc: "CA", country: "Canada", sub: "CA-NS", subName: "Nova Scotia", code: "HST", name: "HST 14%", type: "HST", structure: "HST (harmonized)", ...CA_SRC, pct: 14, from: "2025-04-01" }),

  /* ── India · Union Territory: CGST + UTGST instead of SGST ── */
  rec({ id: "seed-in-ch-cgst-9", cc: "IN", country: "India", sub: "IN-CH", code: "GST18-CGST", name: "CGST 9% (of GST 18%)", type: "CGST", structure: "CGST + UTGST (union territory)", component: "CGST", ...IN_SRC, pct: 9, order: 1, from: "2017-07-01" }),
  rec({ id: "seed-in-ch-utgst-9", cc: "IN", country: "India", sub: "IN-CH", code: "GST18-UTGST", name: "UTGST 9% (of GST 18%)", type: "UTGST", structure: "CGST + UTGST (union territory)", component: "UTGST", ...IN_SRC, pct: 9, order: 2, from: "2017-07-01",
    notes: "Union territories without a legislature levy UTGST in place of SGST." }),

  /* ── United States: state-level sales tax only (local county/city/district rates need address-level data, e.g. SST files) ── */
  rec({ id: "seed-us-ca-state", cc: "US", country: "United States", sub: "US-CA", code: "CA-SALES-STATE", name: "California statewide sales tax 7.25%", type: "Sales Tax", structure: "State + local district taxes", component: "Statewide base", authority: "California Department of Tax and Fee Administration", src: "CDTFA — sales and use tax rates", url: "https://www.cdtfa.ca.gov/taxes-and-fees/sales-use-tax-rates.htm", pct: 7.25, order: 1, from: "2017-01-01",
    notes: "Statewide base (state + uniform local). District taxes add to it by location — not included." }),
  rec({ id: "seed-us-tx-state", cc: "US", country: "United States", sub: "US-TX", code: "TX-SALES-STATE", name: "Texas state sales tax 6.25%", type: "Sales Tax", structure: "State + local (city/county/transit/SPD)", component: "State", authority: "Texas Comptroller of Public Accounts", src: "Texas Comptroller — sales and use tax", url: "https://comptroller.texas.gov/taxes/sales/", pct: 6.25, order: 1, from: "1990-07-01",
    notes: "Local taxes (up to 2%) add by location — not included." }),
  rec({ id: "seed-us-ny-state", cc: "US", country: "United States", sub: "US-NY", code: "NY-SALES-STATE", name: "New York State sales tax 4%", type: "Sales Tax", structure: "State + local (county/city + MCTD)", component: "State", authority: "New York State Department of Taxation and Finance", src: "NYS Tax Department — sales tax rates", url: "https://www.tax.ny.gov/bus/st/rates.htm", pct: 4, order: 1, from: "2005-06-01",
    notes: "Local and MCTD rates add by location — not included." }),

  /* ── Australia: national GST, no state-level rate ── */
  rec({ id: "seed-au-input-taxed", cc: "AU", country: "Australia", code: "INPUTTAXED", name: "Input-taxed supply (no GST)", type: "GST", structure: "GST (national)", category: "Input-taxed supplies", ...AU_SRC, pct: 0, from: "2000-07-01",
    cls: { serviceCategory: "Input-taxed supplies (e.g. most financial supplies, residential rent)", description: "Classification-specific example — no GST is charged and GST credits can't be claimed for related purchases." } }),
  rec({ id: "seed-au-gst-10", cc: "AU", country: "Australia", code: "GST10", name: "GST 10%", type: "GST", structure: "GST (national)", ...AU_SRC, pct: 10, from: "2000-07-01", notes: "National rate — no state/territory variation." }),
  rec({ id: "seed-au-gst-free", cc: "AU", country: "Australia", code: "GSTFREE", name: "GST-free (0%)", type: "GST", structure: "GST (national)", category: "GST-free supplies", ...AU_SRC, pct: 0, from: "2000-07-01",
    cls: { productCategory: "GST-free supplies (e.g. most basic food)", description: "Classification-specific example — eligibility depends on the supply." } }),
];
