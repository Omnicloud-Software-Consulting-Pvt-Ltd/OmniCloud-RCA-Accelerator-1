import { diag, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { resolveCountry } from "@/lib/tax/server/country";
import type { TaxRateRow } from "@/lib/tax/types";

/**
 * TAX CONFIGURATION RESOLUTION — which Salesforce records apply to a sale: Product → Tax Policy → Tax Treatment (→ Tax Treatment
 * Item) → Tax Engine → Tax Rate. Pure functions over records already read from Salesforce, so the same rules serve readiness,
 * calculation, order validation and invoice verification (and are unit-tested).
 *
 * Rate matching follows the Revenue Standard Tax decision table: only the table's INPUT columns are matching dimensions (read from
 * DecisionTableParameter — p10's StandardTax has Country, State, City, ZipCode, ProductCode, LegalEntityId, RateUsageType,
 * StartDate, EndDate and no TaxCode). A blank value on a rate matches anything; a set value must equal the sale's value.
 *
 * Outcome is none / single / multiple. Two or more matching rates are MULTIPLE regardless of how specific each is: Salesforce's own
 * evaluation returned "Multiple Matches" for a product-keyed rate plus a blank-ProductCode rate (p10, E2: TR-00000021 + TR-00000022
 * for LPB-001 in KA) and for two rates that differ only by a ProductCode the lookup didn't send. Priority isn't applied as a
 * tie-breaker (not verified), so a multiple outcome blocks.
 *
 * The ProductCode input is the PRODUCT's own code (Product2.ProductCode): E1-B (rate keyed to the treatment's code "GST18") produced
 * no InvoiceLineTax for LPB-001, E1c (rate keyed "LPB-001") produced it — the treatment's/item's ProductCode isn't the lookup value.
 */

export interface RRProduct { id: string; name: string; code: string | null; active: boolean; taxPolicyId: string | null }
export interface RRPolicy { id: string; name: string; status: string | null; selection: string | null; defaultTreatmentId: string | null }
export interface RRTreatment { id: string; name: string; status: string | null; taxable: boolean; taxCode: string | null; productCode: string | null; policyId: string | null; engineId: string | null; legalEntityId: string | null; useItems: boolean }
export interface RRItem { id: string; name: string; treatmentId: string | null; productId: string | null; taxCode: string | null; productCode: string | null }
export interface RREngine { id: string; name: string; type: string | null; status: string | null; native: boolean; decisionTableId: string | null; providerId: string | null }
export interface RRRate {
  id: string; name: string; taxCode: string | null; rate: number | null; countryIso: string | null; stateIso: string | null; city: string | null; zipCode: string | null;
  productCode: string | null; legalEntityId: string | null; usage: string | null; basis: string | null; start: string | null; end: string | null; priority: number | null;
  /** TaxRate.LastModifiedDate (set on create too) — compared with the decision table's last refresh. */
  changedAt?: string | null;
}
export interface RRGeo { countries: { id: string; name: string; iso: string }[]; states: { id: string; name: string; iso: string; countryIso: string | null }[] }
export interface ResolutionData {
  product: RRProduct | null;
  policies: RRPolicy[]; treatments: RRTreatment[]; items: RRItem[]; engines: RREngine[]; rates: RRRate[]; geo: RRGeo;
  legalEntities: { id: string; name: string; status: string | null; country?: string | null }[];
  /** The decision table's INPUT columns (null when unknown — then every dimension is matched). */
  tableInputs: string[] | null;
  /** INPUT columns of engine-assigned decision tables, by engine Id (the treatment's engine decides which table Salesforce uses). */
  engineTableInputs?: Record<string, string[]>;
}

export interface TaxContext {
  country?: string | null; state?: string | null; city?: string | null; zipCode?: string | null;
  legalEntityId?: string | null; effectiveDate?: string | null; rateUsageType?: string | null; applicationBasis?: string | null;
  /** A treatment already set on the transaction (Manual selection / order product). */
  treatmentId?: string | null;
  taxCode?: string | null; productCode?: string | null;
}

/** A loaded TaxRate row (records.ts) in the resolver's shape — so every caller matches with the same rules. */
export function toResolverRate(r: TaxRateRow): RRRate {
  return {
    id: r.id, name: r.name, taxCode: r.taxCode, rate: r.rate, countryIso: r.country, stateIso: r.state ?? null, city: r.city ?? null, zipCode: r.zipCode ?? null,
    productCode: r.productCode, legalEntityId: r.legalEntityId, usage: r.usage, basis: r.basis ?? null, start: r.start, end: r.end, priority: r.priority ?? null,
  };
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const id15 = (s: string | null | undefined) => (s ?? "").slice(0, 15);
export const today = () => new Date().toISOString().slice(0, 10);

/* ───────────── Geography ───────────── */

export function resolveGeography(geo: RRGeo, country: string | null | undefined, state: string | null | undefined): { countryIso: string | null; country: RRGeo["countries"][number] | null; stateIso: string | null; state: RRGeo["states"][number] | null; diagnostics: TaxDiagnostic[] } {
  const diagnostics: TaxDiagnostic[] = [];
  // Exact ISO/name first, then the app's country normaliser ("USA" → US, "United States" → US).
  const c = country ? geo.countries.find(x => lc(x.iso) === lc(country) || lc(x.name) === lc(country)) ?? (() => { const r = resolveCountry(country, geo.countries); return r ? geo.countries.find(x => x.iso === r.iso) ?? null : null; })() : null;
  if (!country) diagnostics.push(diag("MISSING_GEOGRAPHY", "No country given — Salesforce uses the order's billing country; rates were checked for any country.", { severity: "warning", action: "Give the customer's country (and state) to check the exact rate." }));
  else if (!c) diagnostics.push(diag("MISSING_GEOGRAPHY", `Country "${country}" has no GeoCountry record in this org.`));
  let s: RRGeo["states"][number] | null = null;
  if (state) {
    s = geo.states.find(x => (lc(x.iso) === lc(state) || lc(x.name) === lc(state)) && (!c || !x.countryIso || x.countryIso === c.iso)) ?? null;
    // A state without a GeoState record can still be matched by code; only rates without a state (or with this code) apply.
    if (!s) diagnostics.push(diag("MISSING_GEOGRAPHY", `State "${state}"${c ? ` in ${c.name}` : ""} has no GeoState record in this org — only rates without a state can apply.`, { severity: "warning" }));
  }
  const rawState = state && /^[A-Za-z]{1,3}$/.test(state.trim()) ? state.trim().toUpperCase() : null;
  return { countryIso: c?.iso ?? null, country: c, stateIso: s?.iso ?? rawState, state: s, diagnostics };
}

/* ───────────── Tax Treatment ───────────── */

export interface TreatmentResolution {
  status: "resolved" | "blocked";
  policy: RRPolicy | null;
  treatment: RRTreatment | null;
  item: RRItem | null;
  engine: RREngine | null;
  /** The tax code Salesforce works with for this product (item first, then treatment) and the item's / treatment's own
   *  ProductCode (display only — rate matching uses Product2.ProductCode). */
  taxCode: string | null; productCode: string | null;
  diagnostics: TaxDiagnostic[];
}

/**
 * The treatment Salesforce applies for the product's policy: Default → the policy's default treatment; Legal Entity → the active
 * treatment for the sale's legal entity; Manual → the treatment set on the transaction. Validates status, taxability, engine and
 * (when the treatment uses items) the product's Tax Treatment Item.
 */
export function resolveTaxTreatment(d: ResolutionData, ctx: TaxContext = {}): TreatmentResolution {
  const out: TreatmentResolution = { status: "blocked", policy: null, treatment: null, item: null, engine: null, taxCode: null, productCode: null, diagnostics: [] };
  const p = d.product;
  if (!p) { out.diagnostics.push(diag("MISSING_PRODUCT", "The product doesn't exist in this org.")); return out; }
  if (!p.active) out.diagnostics.push(diag("INACTIVE_PRODUCT", `Product "${p.name}" is inactive.`, { severity: "warning", recordId: p.id }));
  if (!p.taxPolicyId) { out.diagnostics.push(diag("MISSING_TAX_POLICY", `Product "${p.name}" has no Tax Policy.`, { recordId: p.id })); return out; }
  const policy = d.policies.find(x => id15(x.id) === id15(p.taxPolicyId)) ?? null;
  out.policy = policy;
  if (!policy) { out.diagnostics.push(diag("MISSING_TAX_POLICY", `Product "${p.name}" points to Tax Policy ${p.taxPolicyId}, which isn't visible in this org.`, { recordId: p.taxPolicyId })); return out; }
  if (policy.status !== "Active") out.diagnostics.push(diag("INACTIVE_TAX_POLICY", `Tax Policy "${policy.name}" is ${policy.status ?? "not Active"}.`, { recordId: policy.id }));
  const inPolicy = d.treatments.filter(t => id15(t.policyId) === id15(policy.id));
  let treatment: RRTreatment | null = null;
  if (ctx.treatmentId) {
    treatment = d.treatments.find(t => id15(t.id) === id15(ctx.treatmentId)) ?? null;
    if (!treatment) out.diagnostics.push(diag("MISSING_TAX_TREATMENT", `Tax Treatment ${ctx.treatmentId} (set on the transaction) doesn't exist.`));
  } else if (policy.selection === "Manual") {
    out.diagnostics.push(diag("MANUAL_TREATMENT_SELECTION", `Tax Policy "${policy.name}" uses Manual selection — Salesforce applies the treatment set on the order product, and none was given.`, { recordId: policy.id }));
    return out;
  } else if (policy.selection === "LegalEntity") {
    // Salesforce selects by the transaction's legal entity — without one, no treatment is picked (never an arbitrary one).
    if (!ctx.legalEntityId) {
      out.diagnostics.push(diag("AMBIGUOUS_TAX_TREATMENT", `Tax Policy "${policy.name}" selects the treatment by legal entity, and the sale's legal entity isn't known (this org has more than one, or none, active).`, { recordId: policy.id, action: "Give the legal entity of the sale." }));
      return out;
    }
    const active = inPolicy.filter(t => t.status === "Active");
    const matches = active.filter(t => id15(t.legalEntityId) === id15(ctx.legalEntityId));
    if (matches.length === 1) treatment = matches[0];
    else if (!matches.length) out.diagnostics.push(diag("MISSING_TAX_TREATMENT", `Tax Policy "${policy.name}" selects by legal entity, and no active treatment exists for that legal entity.`, { recordId: policy.id }));
    else out.diagnostics.push(diag("AMBIGUOUS_TAX_TREATMENT", `Tax Policy "${policy.name}" has ${matches.length} active treatments for that legal entity (${matches.map(t => t.name).join(", ")}).`, { recordId: policy.id }));
  } else {
    treatment = policy.defaultTreatmentId ? d.treatments.find(t => id15(t.id) === id15(policy.defaultTreatmentId)) ?? null : null;
    if (!treatment) out.diagnostics.push(diag("MISSING_TAX_TREATMENT", `Tax Policy "${policy.name}" has no default Tax Treatment.`, { recordId: policy.id }));
  }
  out.treatment = treatment;
  if (!treatment) return out;
  if (treatment.status !== "Active") out.diagnostics.push(diag("INACTIVE_TAX_TREATMENT", `Tax Treatment "${treatment.name}" is ${treatment.status ?? "not Active"}.`, { recordId: treatment.id }));
  if (!treatment.taxable) out.diagnostics.push(diag("NON_TAXABLE_TREATMENT", `Tax Treatment "${treatment.name}" is not taxable — Salesforce applies no tax to "${p.name}" through it.`, { severity: "warning", recordId: treatment.id }));
  if (treatment.taxable) {
    const engine = treatment.engineId ? d.engines.find(e => id15(e.id) === id15(treatment!.engineId)) ?? null : null;
    out.engine = engine;
    if (!engine) out.diagnostics.push(diag("MISSING_TAX_ENGINE", `Taxable Tax Treatment "${treatment.name}" has no Tax Engine.`, { recordId: treatment.id }));
    else {
      if (engine.status !== "Active") out.diagnostics.push(diag("INACTIVE_TAX_ENGINE", `Tax Engine "${engine.name}" is ${engine.status ?? "not Active"}.`, { recordId: engine.id }));
      if (!engine.native) out.diagnostics.push(diag("UNSUPPORTED_TAX_ENGINE", `Tax Engine "${engine.name}" is ${engine.type ?? "an external engine"}, not Revenue Standard Tax.`, { severity: "warning", recordId: engine.id }));
    }
  }
  if (treatment.useItems) {
    const item = d.items.find(i => id15(i.treatmentId) === id15(treatment!.id) && id15(i.productId) === id15(p.id)) ?? null;
    out.item = item;
    if (!item) out.diagnostics.push(diag("MISSING_TAX_TREATMENT_ITEM", `Tax Treatment "${treatment.name}" uses Tax Treatment Items and has none for "${p.name}".`, { recordId: treatment.id }));
  }
  out.taxCode = ctx.taxCode ?? out.item?.taxCode ?? treatment.taxCode ?? null;
  out.productCode = ctx.productCode ?? out.item?.productCode ?? treatment.productCode ?? null;
  if (treatment.taxable && !out.taxCode && !out.productCode) out.diagnostics.push(diag("MISSING_TAX_CODE", `Neither the ${out.item ? "Tax Treatment Item" : "Tax Treatment"} nor the treatment has a Tax Code or Product Code for "${p.name}" — the decision table has nothing to match a rate on.`, { severity: "warning", recordId: out.item?.id ?? treatment.id }));
  out.status = out.diagnostics.some(x => x.severity === "error" && x.code !== "NON_TAXABLE_TREATMENT") ? "blocked" : "resolved";
  return out;
}

/* ───────────── Tax Rate ───────────── */

/** Dimensions the rate resolver understands: decision-table input name → rate value / context value. */
const DIMENSIONS: { input: string; label: string; rate: (r: RRRate) => string | null; ctx: (c: RateContext) => string | null; id?: boolean }[] = [
  { input: "TaxCode", label: "Tax Code", rate: r => r.taxCode, ctx: c => c.taxCode },
  { input: "Country", label: "Country", rate: r => r.countryIso, ctx: c => c.countryIso },
  { input: "State", label: "State", rate: r => r.stateIso, ctx: c => c.stateIso },
  { input: "City", label: "City", rate: r => r.city, ctx: c => c.city },
  { input: "ZipCode", label: "Zip Code", rate: r => r.zipCode, ctx: c => c.zipCode },
  { input: "ProductCode", label: "Product Code", rate: r => r.productCode, ctx: c => c.productCode },
  { input: "LegalEntityId", label: "Legal Entity", rate: r => r.legalEntityId, ctx: c => c.legalEntityId, id: true },
];

export interface RateContext { taxCode: string | null; countryIso: string | null; stateIso: string | null; city: string | null; zipCode: string | null; productCode: string | null; legalEntityId: string | null; effectiveDate: string; rateUsageType: string; applicationBasis: string | null }
export interface RateMatch { rate: RRRate; specificity: number; matched: string[]; wildcard: string[] }
export type RateOutcome = "none" | "single" | "multiple";
export interface RateResolution {
  status: "resolved" | "none" | "ambiguous";
  /** none / single / multiple — the same three outcomes Salesforce's decision-table evaluation reports. */
  outcome: RateOutcome;
  selected: RRRate | null;
  why: string[];
  candidates: RateMatch[];
  /** Effective rates that didn't match, and the first reason (for "why not"). */
  nearMisses: { rate: RRRate; reason: string }[];
  dimensions: string[];
  diagnostics: TaxDiagnostic[];
}

/** The applicable rate for the context, matched only on the decision table's input dimensions. */
export function resolveTaxRate(rates: RRRate[], ctx: RateContext, tableInputs: string[] | null): RateResolution {
  const dims = DIMENSIONS.filter(d => !tableInputs || tableInputs.includes(d.input));
  const matches: RateMatch[] = [];
  const nearMisses: RateResolution["nearMisses"] = [];
  for (const r of rates) {
    const miss = (reason: string) => nearMisses.push({ rate: r, reason });
    if (lc(r.usage) !== lc(ctx.rateUsageType)) { miss(`Rate Application ${r.usage ?? "—"} ≠ ${ctx.rateUsageType}`); continue; }
    if ((r.start && r.start > ctx.effectiveDate) || (r.end && r.end < ctx.effectiveDate)) { miss(`not effective on ${ctx.effectiveDate} (${r.start ?? "…"} → ${r.end ?? "…"})`); continue; }
    if (ctx.applicationBasis && r.basis && lc(r.basis) !== lc(ctx.applicationBasis)) { miss(`Application Basis ${r.basis} ≠ ${ctx.applicationBasis}`); continue; }
    const matched: string[] = [], wildcard: string[] = [];
    let reason: string | null = null;
    for (const d of dims) {
      const rv = d.rate(r), cv = d.ctx(ctx);
      if (rv === null || rv === "") { wildcard.push(d.label); continue; }
      const eq = d.id ? id15(rv) === id15(cv) : lc(rv) === lc(cv);
      if (!eq) { reason = `${d.label} ${rv} ≠ ${cv ?? "(none)"}`; break; }
      matched.push(`${d.label} = ${rv}`);
    }
    if (reason) { miss(reason); continue; }
    matches.push({ rate: r, specificity: matched.length, matched, wildcard });
  }
  const dimensions = dims.map(d => d.input);
  const diagnostics: TaxDiagnostic[] = [];
  const base = { candidates: matches, nearMisses: nearMisses.slice(0, 8), dimensions };
  const noTaxCode = !!tableInputs && !tableInputs.includes("TaxCode");
  if (!matches.length) {
    diagnostics.push(diag("MISSING_TAX_RATE", `No effective ${ctx.rateUsageType} tax rate matches ${[ctx.countryIso && `country ${ctx.countryIso}`, ctx.stateIso && `state ${ctx.stateIso}`, ctx.productCode && `product code ${ctx.productCode}`, !noTaxCode && ctx.taxCode && `tax code ${ctx.taxCode}`].filter(Boolean).join(", ") || "this sale"} on ${ctx.effectiveDate}.${nearMisses.length ? ` Closest: ${nearMisses.slice(0, 3).map(n => `${n.rate.taxCode ?? n.rate.name} (${n.reason})`).join("; ")}.` : ""}`));
    return { status: "none", outcome: "none", selected: null, why: [], ...base, diagnostics };
  }
  // Any second match makes the lookup MULTIPLE (Salesforce's evaluation: "Multiple Matches"), however specific each rate is —
  // a blank value on one rate (wildcard) overlapping a set value on another is exactly that case.
  if (matches.length > 1) {
    const describe = (m: RateMatch) => `${m.rate.name}${m.rate.taxCode ? ` ${m.rate.taxCode}` : ""} ${m.rate.rate ?? "?"}%${m.rate.priority !== null ? ` priority ${m.rate.priority}` : ""}${m.wildcard.length ? ` (blank = any: ${m.wildcard.join(", ")})` : ""}`;
    diagnostics.push(diag("AMBIGUOUS_TAX_RATE", `${matches.length} rates match this sale (${matches.map(describe).join("; ")}) — Salesforce's lookup returns Multiple Matches. Make one dimension distinct (e.g. a product-specific Product Code instead of a blank one) or end-date one of them.`));
    return { status: "ambiguous", outcome: "multiple", selected: null, why: [], ...base, diagnostics };
  }
  const m = matches[0];
  const why = [...m.matched.map(x => `matched ${x}`), ...(m.wildcard.length ? [`blank on the rate (matches any): ${m.wildcard.join(", ")}`] : []), `effective ${m.rate.start ?? "…"} → ${m.rate.end ?? "open"}`, `Rate Application ${m.rate.usage}`];
  if (noTaxCode) why.push("the decision table has no TaxCode input, so Tax Code isn't a matching dimension");
  return { status: "resolved", outcome: "single", selected: m.rate, why, ...base, diagnostics };
}

/* ───────────── Whole chain ───────────── */

export interface ConfigurationResolution {
  status: "resolved" | "blocked";
  product: RRProduct | null;
  treatment: TreatmentResolution;
  geography: ReturnType<typeof resolveGeography>;
  rate: RateResolution | null;
  context: RateContext | null;
  legalEntity: { id: string; name: string } | null;
  diagnostics: TaxDiagnostic[];
}

/** Product → policy → treatment (→ item) → engine → geography → rate, with every diagnostic along the way. */
export function resolveTaxConfiguration(d: ResolutionData, ctx: TaxContext): ConfigurationResolution {
  // The sale's legal entity: given, else the org's only active one — decided BEFORE treatment selection.
  const activeLes = d.legalEntities.filter(l => !l.status || l.status === "Active");
  const saleLe = ctx.legalEntityId ?? (activeLes.length === 1 ? activeLes[0].id : null);
  const treatment = resolveTaxTreatment(d, { ...ctx, legalEntityId: saleLe });
  const leId = saleLe ?? treatment.treatment?.legalEntityId ?? null;
  const legalEntity = leId ? d.legalEntities.find(l => id15(l.id) === id15(leId)) ?? null : null;
  // The table Salesforce matches with is the treatment engine's own decision table when it has one, else the system table.
  const tableInputs = (treatment.engine && d.engineTableInputs?.[treatment.engine.id]) || d.tableInputs;
  // A decision table that matches on TaxCode needs one — it is never invented.
  if (treatment.treatment?.taxable && tableInputs?.includes("TaxCode") && !treatment.taxCode) {
    treatment.diagnostics = treatment.diagnostics.filter(x => x.code !== "MISSING_TAX_CODE");
    treatment.diagnostics.push(diag("MISSING_TAX_CODE", `The decision table matches rates on TaxCode, and neither ${treatment.item ? `Tax Treatment Item "${treatment.item.name}"` : "the Tax Treatment Item"} nor treatment "${treatment.treatment.name}" has a Tax Code.`, { recordId: treatment.item?.id ?? treatment.treatment.id }));
    treatment.status = "blocked";
  }
  // No country given: the legal entity's country is the selling geography (stated, not silently assumed).
  const country = ctx.country ?? legalEntity?.country ?? null;
  const geography = resolveGeography(d.geo, country, ctx.state);
  const diagnostics = [...treatment.diagnostics, ...geography.diagnostics];
  if (!ctx.country && country) diagnostics.push(diag("MISSING_GEOGRAPHY", `No country given — using the legal entity "${legalEntity!.name}" country ${country}.`, { severity: "info", action: "Give the customer's country/state to check a different geography." }));
  let rate: RateResolution | null = null, context: RateContext | null = null;
  if (treatment.treatment?.taxable) {
    // Salesforce sends the PRODUCT's own code to the ProductCode input (E1-B / E1c) — never the treatment's or item's code.
    context = {
      taxCode: treatment.taxCode, productCode: ctx.productCode ?? d.product?.code ?? null, countryIso: geography.countryIso, stateIso: geography.stateIso,
      city: ctx.city ?? null, zipCode: ctx.zipCode ?? null, legalEntityId: leId, effectiveDate: ctx.effectiveDate ?? today(),
      rateUsageType: ctx.rateUsageType ?? "RevCloud", applicationBasis: ctx.applicationBasis ?? null,
    };
    // Unknown country: match every non-geographic dimension and say so (the rate then depends on the customer's address).
    const inputs = geography.countryIso ? tableInputs : (tableInputs ?? ["TaxCode", "Country", "State", "City", "ZipCode", "ProductCode", "LegalEntityId"]).filter(i => !["Country", "State", "City", "ZipCode"].includes(i));
    rate = resolveTaxRate(d.rates, context, inputs);
    if (!geography.countryIso) rate.why.push("geography not given — country/state weren't matched");
    diagnostics.push(...rate.diagnostics);
  }
  const blocked = diagnostics.some(x => x.severity === "error" && x.code !== "NON_TAXABLE_TREATMENT") || treatment.status === "blocked";
  return { status: blocked ? "blocked" : "resolved", product: d.product, treatment, geography, rate, context, legalEntity: legalEntity ? { id: legalEntity.id, name: legalEntity.name } : null, diagnostics };
}
