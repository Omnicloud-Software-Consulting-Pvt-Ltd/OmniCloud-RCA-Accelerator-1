import { salesforceStateIso } from "@/lib/taxLibrary/jurisdictions";
import { classificationLabel } from "@/lib/taxLibrary/library";
import { rateLabel, statusOf, todayIso, type TaxRateReference } from "@/lib/taxLibrary/types";

/**
 * "Use This Rate" → the EXISTING Salesforce Tax Rate create form. Builds the prefill only; nothing is written. Field names are
 * the TaxRate fields verified in p10 (API 68): TaxCode, Rate, GeoCountryId, GeoStateId, StartDate, EndDate, FlatTaxAmount — and
 * the form drops any that this org's Describe doesn't mark createable. GeoCountryId / GeoStateId are lookups the page resolves
 * against the org's GeoCountry / GeoState records by ISO code (GeoState.IsoCode holds "AP", not "IN-AP"); a country-level
 * rate gets NO state (none is invented). RateUsageType / ApplicationBasis / LegalEntityId are Salesforce decisions the existing
 * form and its tax-rate rules ask for — they're never guessed from reference data.
 */
export interface TaxRatePrefill {
  fields: Record<string, string | number>;
  geo: { countryIso: string; stateIso: string | null; countryName: string; stateName: string | null };
  /** Shown above the form. */
  notices: string[];
  warnings: string[];
  /** Must the user explicitly confirm before the form opens (expired / draft / unverified)? */
  requiresConfirmation: boolean;
  confirmationReasons: string[];
  /** Can't be used at all (archived). */
  blocked: string | null;
  summary: string;
}

/**
 * `opts.state` — the Geo State of a Country → Geo State mapping row whose national rate the source explicitly applies in every state
 * (mapping.ts "Inherited national rate"); the form then gets that state. Never used to put a national rate on a state otherwise.
 */
export function buildTaxRatePrefill(r: TaxRateReference, today = todayIso(), opts: { state?: { code: string; name: string } } = {}): TaxRatePrefill {
  const state = opts.state && !r.jurisdiction.subdivisionCode && opts.state.code.startsWith(`${r.jurisdiction.countryCode}-`) ? opts.state : null;
  const status = statusOf(r, today);
  const fields: Record<string, string | number> = { TaxCode: r.tax.taxCode };
  if (r.rate.ratePercent !== null) fields.Rate = r.rate.ratePercent;
  if (r.rate.fixedAmount !== null) fields.FlatTaxAmount = r.rate.fixedAmount;
  fields.StartDate = r.effective.effectiveFrom;
  if (r.effective.effectiveTo) fields.EndDate = r.effective.effectiveTo;

  const notices = [`Prefilled from the Global Tax Rate Library: ${r.tax.taxName} (${rateLabel(r.rate)}) — ${r.jurisdiction.subdivisionName ? `${r.jurisdiction.subdivisionName}, ` : ""}${r.jurisdiction.countryName}. Review every field; nothing is created until you validate and click Create.`];
  const warnings: string[] = [];
  const reasons: string[] = [];
  notices.push(`Reference source: ${r.source.sourceName ?? "not recorded"}${r.source.sourceUrl ? ` (${r.source.sourceUrl})` : ""} · ${r.source.verification === "verified" ? `verified${r.source.lastVerifiedAt ? ` ${r.source.lastVerifiedAt}` : ""}` : r.source.verification} · reference record ${r.id} v${r.version}.`);
  if (r.jurisdiction.locality) notices.push(`Region-specific reference rate (${r.jurisdiction.locality}) — a Salesforce Tax Rate created from it applies country-wide unless you narrow it (e.g. City / Zip Code).`);
  notices.push(`Tax name "${r.tax.taxName}" is shown for reference only — Salesforce names Tax Rates automatically (TaxRate.Name can't be set).`);
  if (state) notices.push(`National rate selected for ${state.name} (${state.code}) — the source states this country has no state/provincial tax layer, so the national rate applies there. Geo State is set to ${state.name}.`);
  else if (!r.jurisdiction.subdivisionCode) notices.push("Country-level rate — Geo State is left empty on purpose.");
  if (r.tax.taxComponent) notices.push(`This is one component (${r.tax.taxComponent}) of "${r.tax.taxStructure}" — create a Salesforce Tax Rate per component if your configuration needs them.`);
  if (classificationLabel(r)) notices.push(`Reference classification: ${classificationLabel(r)}${r.classification.conditions ? ` — ${r.classification.conditions}` : ""}. Salesforce Tax Rates don't store it; map it through your Tax Code / Product Code design.`);
  if (status === "Expired") { warnings.push(`This reference rate EXPIRED on ${r.effective.effectiveTo}. A Salesforce rate created from it only applies to invoices dated ${r.effective.effectiveFrom} → ${r.effective.effectiveTo}.`); reasons.push("The rate is expired."); }
  if (status === "Upcoming") warnings.push(`This rate only takes effect on ${r.effective.effectiveFrom} — invoices dated before then won't match it.`);
  if (status === "Draft") { warnings.push("This reference record is a DRAFT — it hasn't been published in the library."); reasons.push("The record is a draft."); }
  if (r.source.verification !== "verified") { warnings.push(`Reference data is ${r.source.verification === "needs-review" ? "flagged for review" : "UNVERIFIED"} — confirm the rate with ${r.source.sourceName ?? "the tax authority"}${r.source.sourceUrl ? ` (${r.source.sourceUrl})` : ""} before relying on it.`); reasons.push("The reference data isn't verified."); }

  return {
    fields,
    geo: state
      ? { countryIso: r.jurisdiction.countryCode, stateIso: salesforceStateIso(state.code), countryName: r.jurisdiction.countryName, stateName: state.name }
      : { countryIso: r.jurisdiction.countryCode, stateIso: r.jurisdiction.subdivisionCode ? salesforceStateIso(r.jurisdiction.subdivisionCode) : null, countryName: r.jurisdiction.countryName, stateName: r.jurisdiction.subdivisionName },
    notices, warnings,
    requiresConfirmation: reasons.length > 0, confirmationReasons: reasons,
    blocked: status === "Archived" ? "Archived reference rates can't be used — restore it first." : null,
    summary: `${r.tax.taxCode} · ${rateLabel(r.rate)} · ${state?.code ?? r.jurisdiction.subdivisionCode ?? r.jurisdiction.countryCode}`,
  };
}
