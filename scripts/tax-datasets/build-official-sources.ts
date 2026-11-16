/**
 * INTERNAL dataset build — not part of the app UI. Turns researched official-source evidence (scripts/tax-datasets/research/*.json:
 * one entry per rate with the official URL, publishing organisation and a VERBATIM quote captured when the page was read) into
 * the bundled reference dataset lib/taxLibrary/datasets/official-sources.json.
 *
 *   npx tsx scripts/tax-datasets/build-official-sources.ts            # build + automated re-check of every source page
 *   npx tsx scripts/tax-datasets/build-official-sources.ts --offline  # build without re-checking (keeps previous verification)
 *
 * Rules enforced here (nothing is invented):
 *  · a rate is kept only with a source URL on an allowed (non-aggregator) domain and a verbatim quote;
 *  · verification is EARNED: "verified" only when this script re-reads the source page and finds the quote text and the rate
 *    number on it; otherwise "partially-verified" (official URL + quote captured by the researcher, automated re-check failed);
 *  · no effective date is invented: when the source states none, Effective From is the date the source was read and the record
 *    says so; tax codes the source doesn't publish are GENERATED and flagged (taxCodeGenerated);
 *  · countries without a confirmed official source get a profile (status + missing scope) and no rates.
 */
import fs from "node:fs";
import path from "node:path";
import type { FlatRow } from "@/lib/taxLibrary/importExport";
import type { CountryProfile, LayerCoverage, ReferenceDataset } from "@/lib/taxLibrary/reference";
import { COUNTRIES } from "@/lib/taxLibrary/jurisdictions";

interface ResearchRate {
  subdivisionCode: string | null; taxType: string; taxName: string; officialTaxCode: string | null; taxComponent: string | null; taxStructure: string;
  rateCategory: string; ratePercent: number | null; appliesTo: string; classification: string; effectiveFrom: string | null;
  sourceUrl: string; sourceOrganization: string; sourceQuote: string;
}
interface ResearchEntry { countryCode?: string; subdivisionCode?: string | null; status: "found" | "not-found" | "no-consumption-tax"; note?: string; rates: ResearchRate[] }
interface ResearchFile { group: string; retrievedOn: string; countries?: ResearchEntry[]; subdivisions?: ResearchEntry[]; entries?: ResearchEntry[] }

const ROOT = process.cwd();
const RESEARCH_DIR = path.join(ROOT, "scripts/tax-datasets/research");
const OUT = path.join(ROOT, "lib/taxLibrary/datasets/official-sources.json");
const OFFLINE = process.argv.includes("--offline");
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
const BLOCKED = /wikipedia|avalara|pwc\.|kpmg|(^|\.)ey\.com|deloitte|vatcalc|tradingeconomics|cleartax|taxfoundation|salestaxinstitute|taxjar|vatupdate|globalvatcompliance/i;

/** Structural facts about tax layers (where the library's scope is known to stop). Everything else defaults to "not-assessed". */
const LAYERS: Record<string, { subnational?: LayerCoverage; local?: LayerCoverage; missing?: string[]; note?: string }> = {
  US: { subnational: "included", local: "not-included", missing: ["County, city and district (local) sales taxes", "State-specific product exemptions beyond those listed"], note: "No federal sales tax: state sales tax applies per state, and local jurisdictions add their own rates." },
  CA: { subnational: "included", local: "none", note: "Federal GST everywhere; HST provinces replace GST with a combined rate; BC/SK/MB/QC add a provincial sales tax." },
  IN: { subnational: "none", local: "none", missing: ["HSN/SAC-level rate schedule (item-by-item notifications)"], note: "GST slabs are uniform nationwide: intra-state supplies split equally into CGST + SGST (or UTGST); inter-state supplies bear IGST." },
  AU: { subnational: "none", local: "none", note: "GST is a single national tax; states and territories levy no GST." },
  BR: { subnational: "partial", local: "not-included", missing: ["Municipal ISS on services", "IPI and PIS/COFINS federal taxes"], note: "State ICMS rates differ per state; the CBS/IBS reform phases in from 2026." },
  PK: { subnational: "partial", local: "not-assessed", note: "Federal sales tax on goods; provinces levy sales tax on services." },
  ES: { missing: ["Canary Islands IGIC and Ceuta/Melilla IPSI (outside the EU VAT territory)"] },
  MX: { subnational: "not-assessed", local: "not-assessed", missing: ["State-level taxes (e.g. lodging taxes)"] },
};

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}%.,]+/gu, " ").replace(/\s+/g, " ").trim();
const htmlText = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

const pageCache = new Map<string, Promise<string | null>>();
function fetchText(url: string): Promise<string | null> {
  if (!pageCache.has(url)) pageCache.set(url, (async () => {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (tax-reference-dataset-builder)", Accept: "text/html,*/*" }, signal: AbortSignal.timeout(25000), redirect: "follow" });
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "";
      if (!/html|text|xml|json/i.test(type)) return null; // PDFs and binaries can't be re-checked here
      return fold(htmlText(await res.text()));
    } catch { return null; }
  })());
  return pageCache.get(url)!;
}

/** The quote is "found" when a long run of its words appears on the page; the rate is found when its number appears. */
function quoteOnPage(page: string, quote: string): boolean {
  const words = fold(quote).split(" ").filter(Boolean);
  if (words.length < 4) return page.includes(words.join(" "));
  for (let len = Math.min(8, words.length); len >= 5; len--) for (let i = 0; i + len <= words.length; i++) if (page.includes(words.slice(i, i + len).join(" "))) return true;
  return false;
}
function rateOnPage(page: string, rate: number | null): boolean {
  if (rate === null) return true;
  const s = String(rate);
  return [s, s.replace(".", ",")].some(v => new RegExp(`(^|[^\\d.,])${v.replace(".", "\\.")}(\\s?%|\\s?per ?cent|\\s?percent|[^\\d.,]|$)`).test(page));
}

const ABBR: Record<string, string> = { standard: "STD", reduced: "RED", "super-reduced": "SRED", parking: "PARK", zero: "ZERO", exempt: "EXEMPT", other: "OTH" };
const typeCode = (r: ResearchRate) => (r.taxComponent && /^[A-Z]{2,6}$/.test(r.taxComponent) ? r.taxComponent : r.taxType).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12);
const CATEGORY_LABEL: Record<string, string> = { standard: "Standard", reduced: "Reduced", "super-reduced": "Super-reduced", parking: "Parking", zero: "Zero", exempt: "Exempt", other: "Other" };
const CLASS_LABEL: Record<string, [string | null, string | null]> = {
  goods: ["Goods", null], services: [null, "Services"], "goods-and-services": [null, null], food: ["Food", null], medicine: ["Medicine", null], education: [null, "Education"],
  healthcare: [null, "Healthcare"], transport: [null, "Transportation"], accommodation: [null, "Accommodation"], "financial-services": [null, "Financial services"],
  "digital-services": [null, "Digital services"], exports: ["Export supplies", null], imports: ["Import supplies", null], other: [null, null],
};

async function main() {
  const files = fs.readdirSync(RESEARCH_DIR).filter(f => f.endsWith(".json")).sort();
  const entries: { cc: string; e: ResearchEntry; retrievedOn: string }[] = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, f), "utf8")) as ResearchFile;
    for (const e of [...(j.countries ?? []), ...(j.subdivisions ?? []), ...(j.entries ?? [])]) {
      const cc = (e.countryCode ?? e.subdivisionCode?.split("-")[0] ?? "").toUpperCase();
      if (cc) entries.push({ cc, e, retrievedOn: j.retrievedOn });
    }
  }
  const previous = fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as ReferenceDataset) : null;
  const prevVerification = new Map((previous?.rows ?? []).map(r => [`${r.sourceUrl}|${r.taxCode}|${r.ratePercent}|${r.productCategory}|${r.serviceCategory}`, { v: r.verification, at: r.lastVerifiedAt }]));
  const rows: FlatRow[] = [];
  const rejected: string[] = [];
  const stats = { verified: 0, partial: 0 };
  const today = new Date().toISOString().slice(0, 10);

  // National rates are inherited by every subdivision — a subdivision row that merely restates one is dropped, never duplicated.
  const nationalKeys = new Set(entries.flatMap(({ cc, e }) => (e.rates ?? []).filter(r => !r.subdivisionCode).map(r => `${cc}|${r.taxType}|${r.taxComponent ?? ""}|${r.ratePercent}|${r.rateCategory}`)));
  for (const { cc, e, retrievedOn } of entries) {
    if (e.status === "no-consumption-tax") continue; // recorded in the country profile, not as a rate
    for (const r of e.rates ?? []) {
      const where = `${cc}${r.subdivisionCode ? `/${r.subdivisionCode}` : ""} ${r.taxName} ${r.ratePercent}`;
      if (!/^https?:\/\//.test(r.sourceUrl ?? "")) { rejected.push(`${where}: no source URL`); continue; }
      if (BLOCKED.test(new URL(r.sourceUrl).hostname)) { rejected.push(`${where}: non-official source ${r.sourceUrl}`); continue; }
      if (!r.sourceQuote?.trim()) { rejected.push(`${where}: no verbatim quote`); continue; }
      if (r.ratePercent !== null && (typeof r.ratePercent !== "number" || !Number.isFinite(r.ratePercent) || r.ratePercent < 0 || r.ratePercent > 100)) { rejected.push(`${where}: invalid rate`); continue; }
      if (r.ratePercent === null && r.rateCategory !== "exempt") { rejected.push(`${where}: no rate (descriptive row)`); continue; }
      if (r.subdivisionCode && nationalKeys.has(`${cc}|${r.taxType}|${r.taxComponent ?? ""}|${r.ratePercent}|${r.rateCategory}`)) { rejected.push(`${where}: restates the national rate (inherited instead)`); continue; }

      const sub = r.subdivisionCode ? r.subdivisionCode.toUpperCase() : null;
      const cat = r.rateCategory in ABBR ? r.rateCategory : "other";
      const generated = !r.officialTaxCode;
      const rateStr = r.ratePercent === null ? "" : `-${String(r.ratePercent)}`;
      const taxCode = `${sub ?? cc}-${typeCode(r)}-${ABBR[cat]}${rateStr}`;
      const [productCategory, serviceCategory] = CLASS_LABEL[r.classification] ?? [null, null];
      const datedBySource = !!r.effectiveFrom && /^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom);
      const key = `${r.sourceUrl}|${taxCode}|${r.ratePercent}|${productCategory ?? r.appliesTo}|${serviceCategory}`;

      let verification: "verified" | "partially-verified" = "partially-verified";
      let lastVerifiedAt: string | null = null;
      if (OFFLINE) { const p = prevVerification.get(key); if (p?.v === "verified") { verification = "verified"; lastVerifiedAt = p.at ? String(p.at) : null; } }
      else {
        const page = await fetchText(r.sourceUrl);
        if (page && quoteOnPage(page, r.sourceQuote) && rateOnPage(page, r.ratePercent)) { verification = "verified"; lastVerifiedAt = today; }
      }
      if (verification === "verified") stats.verified++; else stats.partial++;

      rows.push({
        countryCode: cc, subdivisionCode: sub, locality: null,
        taxCode, officialTaxCode: r.officialTaxCode ?? null, taxCodeGenerated: generated,
        taxName: `${r.taxName}${r.ratePercent !== null ? ` ${r.ratePercent}%` : ""}${cat !== "standard" ? ` — ${r.appliesTo}`.slice(0, 120) : ""}`,
        taxType: r.taxType, taxStructure: r.taxStructure || r.taxType, taxComponent: r.taxComponent, taxAuthority: r.sourceOrganization, taxCategory: CATEGORY_LABEL[cat],
        ratePercent: r.ratePercent, calculation: "percentage",
        classificationSystem: r.classification && r.classification !== "goods-and-services" ? "Official category" : null, classificationCode: null,
        productCategory: productCategory ?? (cat !== "standard" && !serviceCategory ? r.appliesTo : null), serviceCategory,
        classificationDescription: r.appliesTo, conditions: null,
        effectiveFrom: datedBySource ? r.effectiveFrom : retrievedOn, effectiveTo: null, lifecycle: "published",
        sourceName: r.sourceOrganization, sourceOrganization: r.sourceOrganization, sourceUrl: r.sourceUrl,
        sourceReference: `Quote (read ${retrievedOn}): “${r.sourceQuote.trim().slice(0, 300)}”`,
        notes: [datedBySource ? null : `The source states no start date — Effective From is the date the source was read (${retrievedOn}); the rate was in force then.`,
          generated ? "The source publishes no tax code; Tax Code was generated by the library." : null,
          verification === "partially-verified" ? "Automated re-check couldn't confirm the quote on the page (page unavailable, script-rendered or PDF) — check the source before relying on it." : null].filter(Boolean).join(" ") || null,
        verification, lastVerifiedAt,
      });
    }
  }

  // Profiles: one per non-EU country (EU coverage comes from TEDB) + EU structural notes.
  const byCc = new Map<string, { status: ResearchEntry["status"]; notes: string[]; rated: boolean }>();
  for (const { cc, e } of entries) {
    const cur = byCc.get(cc) ?? { status: "not-found" as ResearchEntry["status"], notes: [], rated: false };
    if (e.status === "found" && (e.rates ?? []).length) cur.status = "found";
    else if (e.status === "no-consumption-tax" && cur.status !== "found") cur.status = "no-consumption-tax";
    if (e.note && !e.subdivisionCode) cur.notes.push(e.note.trim());
    byCc.set(cc, cur);
  }
  const rowsByCc = new Map<string, FlatRow[]>();
  for (const r of rows) rowsByCc.set(String(r.countryCode), [...(rowsByCc.get(String(r.countryCode)) ?? []), r]);
  const profiles: CountryProfile[] = [];
  for (const c of COUNTRIES) {
    const research = byCc.get(c.code);
    const layer = LAYERS[c.code] ?? {};
    const rs = rowsByCc.get(c.code) ?? [];
    if (EU.has(c.code)) { profiles.push({ countryCode: c.code, status: "found", note: "National VAT from the European Commission TEDB.", subnational: layer.subnational ?? "not-assessed", local: layer.local ?? "not-assessed", missingScope: layer.missing ?? [] }); continue; }
    const status: CountryProfile["status"] = rs.length ? "found" : research?.status === "no-consumption-tax" ? "no-consumption-tax" : "not-found";
    const missing = [...(layer.missing ?? [])];
    if (!rs.length && status === "not-found") missing.unshift("National consumption-tax rates (no official source confirmed)");
    if (rs.length && !rs.some(r => r.taxCategory !== "Standard")) missing.push("Reduced / zero / exempt categories (not captured from the official source)");
    let subnational = layer.subnational ?? "not-assessed";
    if (subnational === "included" && c.code !== "CA" && c.code !== "US") subnational = "partial";
    profiles.push({ countryCode: c.code, status, note: [layer.note, ...(research?.notes ?? [])].filter(Boolean).join(" ").slice(0, 600) || null, subnational, local: layer.local ?? "not-assessed", missingScope: missing });
  }

  const countriesWithRows = [...new Set(rows.map(r => String(r.countryCode)))].sort();
  const ds: ReferenceDataset = {
    manifest: {
      id: "official-national", name: "Consumption taxes — official tax-authority sources", version: today, retrievedAt: today,
      source: "National tax authorities, ministries of finance, official gazettes/legislation; US state revenue departments; Canadian, Indian, Australian and Brazilian federal/state authorities — one cited source per record",
      sourceUrl: null, license: "Public official information; each record cites its source URL and a verbatim quote. Informational, not a tax determination.",
      coverage: { countries: countriesWithRows, scope: "National consumption-tax rates stated by the cited official source (and US state / Canadian provincial / Brazilian state / Indian GST rules where listed)", complete: false },
      recordCount: rows.length,
      notes: `Built by scripts/tax-datasets/build-official-sources.ts from ${files.length} research files. ${stats.verified} verified by automated re-check, ${stats.partial} partially verified.`,
    },
    rows, profiles,
  };
  fs.writeFileSync(OUT, JSON.stringify(ds, null, 1));
  console.log(`rows ${rows.length} (verified ${stats.verified}, partially ${stats.partial}) · countries with rows ${countriesWithRows.length} · rejected ${rejected.length}`);
  for (const r of rejected) console.log("  rejected:", r);
}

main().catch(e => { console.error(e); process.exit(1); });
