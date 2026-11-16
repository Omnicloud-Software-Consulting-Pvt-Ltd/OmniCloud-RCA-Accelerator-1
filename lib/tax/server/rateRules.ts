/**
 * TAX RATE RULES (pure) — what a TaxRate must carry to be usable by Revenue Cloud Billing's invoice-time tax, shared by every
 * path that creates or edits a rate: the Tax Assistant (operations.ts), the Taxes record pages (billing rules.ts) and the
 * configuration planner (plan.ts writes these values itself).
 *
 * Evidence (p10, 2026-10-08…12):
 *  · TaxRate.RateUsageType defaults to "Commerce" and ApplicationBasis to "Gross" when a create omits them (describe defaults).
 *  · Every invoice that got InvoiceLineTax (DOC-000000013, DOC-000000017) matched a RevCloud / Net rate; configurations whose only
 *    rate was Commerce never produced tax, and the engine's decision table returns "No Match" for a RevCloud lookup against a
 *    Commerce rate (Smart LED Bulb TR-00000020). So RateUsageType must be RevCloud — that is enforced.
 *  · Only Net has been observed producing InvoiceLineTax. Gross is a legitimate business choice (tax-inclusive prices) that has
 *    not been verified here, so it must be chosen explicitly and is flagged — never taken silently from the picklist default.
 *  · Fields that only exist from API v68 (ApplicationBasis, LegalEntityId) must never be dropped by an older API version.
 *  · ProductCode is matched against the PRODUCT's own code (Product2.ProductCode): E1-B (rate keyed "GST18" ≠ LPB-001) → ₹0 and no
 *    InvoiceLineTax; E1c (rate keyed "LPB-001") → InvoiceLineTax ₹1,800 on ₹10,000. A product-specific code is the default.
 *  · A BLANK ProductCode matches any product (E2: ₹188.82 on ₹1,049 for LP001, KA-specific rate, treatment without items). It is an
 *    explicit choice: it also matches every other product with the same tax code and geography, so overlaps become Multiple
 *    Matches (E2: LPB-001 in KA). Blank codes with item-based treatments are not verified.
 */

export const REVENUE_CLOUD_RATE_USAGE = "RevCloud";
export const VERIFIED_APPLICATION_BASIS = "Net";
/** TaxRate fields every write needs to see in the org's describe — absent means the API version is too old for tax writes. */
export const TAX_RATE_WRITE_FIELDS = ["RateUsageType", "ApplicationBasis", "LegalEntityId", "StartDate", "TaxCode", "GeoCountryId"] as const;

export interface RateRuleIssue { severity: "error" | "warning" | "info"; code: string; field: string | null; message: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Validate a TaxRate create or update. `values` are the values the record will have after the save (update: current merged with
 * changes). On update, `changed` lists the fields being changed: a problem on a field that ISN'T being changed is a warning (so a
 * legacy rate can still be end-dated/retired), a problem on a changed field is an error.
 */
export function evaluateTaxRateRules(input: { mode: "create" | "update"; values: Record<string, unknown>; changed?: Iterable<string> | null; availableFields: Iterable<string>; today: string }): RateRuleIssue[] {
  const out: RateRuleIssue[] = [];
  const v = input.values;
  const fields = new Set(input.availableFields);
  const changed = input.mode === "update" ? new Set(input.changed ?? []) : null;
  const sev = (field: string): "error" | "warning" => (!changed || changed.has(field) ? "error" : "warning");
  const add = (severity: RateRuleIssue["severity"], code: string, field: string | null, message: string) => out.push({ severity, code, field, message });

  const missing = TAX_RATE_WRITE_FIELDS.filter(f => !fields.has(f));
  if (missing.length) {
    add("error", "TAX_API_VERSION_UNSUPPORTED", null, `This API version doesn't expose TaxRate.${missing.join(", TaxRate.")} — a write here would silently drop them. Tax Rates are only written through the org's newest API version (v68+).`);
    return out;
  }

  const usage = s(v.RateUsageType);
  if (!usage) add(sev("RateUsageType"), "RATE_USAGE_REQUIRED", "RateUsageType", `Rate Usage Type must be set explicitly to "${REVENUE_CLOUD_RATE_USAGE}" — left blank, Salesforce defaults it to "Commerce", which Revenue Cloud Billing's invoice tax lookup doesn't match.`);
  else if (usage !== REVENUE_CLOUD_RATE_USAGE) add(sev("RateUsageType"), "RATE_USAGE_INCOMPATIBLE", "RateUsageType", `Rate Usage Type "${usage}" isn't used by Revenue Cloud Billing invoices — they look rates up with "${REVENUE_CLOUD_RATE_USAGE}" (in this org the decision table returns No Match for a "${usage}" rate). Use "${REVENUE_CLOUD_RATE_USAGE}".`);

  const basis = s(v.ApplicationBasis);
  if (!basis) add(sev("ApplicationBasis"), "RATE_BASIS_REQUIRED", "ApplicationBasis", `Application Basis must be chosen explicitly ("${VERIFIED_APPLICATION_BASIS}" = tax on the net price; "Gross" = tax-inclusive price). Left blank, Salesforce defaults it to "Gross".`);
  else if (basis !== VERIFIED_APPLICATION_BASIS) add("warning", "RATE_BASIS_UNVERIFIED", "ApplicationBasis", `Application Basis "${basis}" means prices are tax-inclusive. Only "${VERIFIED_APPLICATION_BASIS}" has been verified to produce InvoiceLineTax in this org — confirm "${basis}" is intended.`);

  if (input.mode === "create" || changed?.has("TaxCode")) if (blank(v.TaxCode)) add("error", "RATE_TAX_CODE_REQUIRED", "TaxCode", "Tax Code is required — the decision table matches the treatment's tax code against it.");
  if ((input.mode === "create" || changed?.has("ProductCode")) && blank(v.ProductCode)) add("warning", "RATE_PRODUCT_CODE_BLANK", "ProductCode", "Product Code is blank — the rate then matches EVERY product whose treatment uses this tax code in this geography (proven at invoice time for treatments without Tax Treatment Items; not verified with items). The default is the product's own Product Code (Product2.ProductCode), which Salesforce matches.");
  if (blank(v.GeoCountryId)) add(sev("GeoCountryId"), "RATE_COUNTRY_REQUIRED", "GeoCountryId", "Geo Country is required — Country is a required input of the Revenue Standard Tax decision table.");
  if (blank(v.LegalEntityId)) add(sev("LegalEntityId"), "RATE_LEGAL_ENTITY_REQUIRED", "LegalEntityId", "Legal Entity is required — set it to the legal entity of the tax treatment that uses this rate (the configurations that produced InvoiceLineTax all had it).");
  if (blank(v.Rate) && blank(v.FlatTaxAmount)) add(sev("Rate"), "RATE_VALUE_REQUIRED", "Rate", "Rate (percent) or Flat Tax Amount is required.");
  else if (!blank(v.Rate) && (!Number.isFinite(Number(v.Rate)) || Number(v.Rate) < 0)) add("error", "RATE_VALUE_INVALID", "Rate", "Rate must be a number ≥ 0.");

  const start = s(v.StartDate), end = s(v.EndDate);
  if (!start) add(sev("StartDate"), "RATE_START_REQUIRED", "StartDate", "Start Date is required — the decision table compares it with the invoice date.");
  else if (!DATE.test(start)) add("error", "RATE_DATE_INVALID", "StartDate", "Start Date must be YYYY-MM-DD.");
  if (end && !DATE.test(end)) add("error", "RATE_DATE_INVALID", "EndDate", "End Date must be YYYY-MM-DD.");
  if (start && end && DATE.test(start) && DATE.test(end) && end < start) add("error", "RATE_DATES_INVERTED", "EndDate", `End Date ${end} is before Start Date ${start}.`);
  // Ending a rate in the past is how a rate is retired — allowed on update, refused on create (a new rate would never apply).
  else if (input.mode === "create" && end && DATE.test(end) && end < input.today) add("error", "RATE_EXPIRED", "EndDate", `End Date ${end} is in the past — this rate would never apply.`);
  if (start && DATE.test(start) && start > input.today) add("warning", "RATE_FUTURE_EFFECTIVE", "StartDate", `Start Date ${start} is in the future — invoices dated before it get no tax from this rate.`);
  return out;
}

const DIMENSIONS = ["TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId"] as const;
const id15 = (x: string) => (/^[a-zA-Z0-9]{18}$/.test(x) ? x.slice(0, 15) : x.toLowerCase());
const datesOverlap = (aS: string | null, aE: string | null, bS: string | null, bE: string | null) => (aS ?? "0000-01-01") <= (bE ?? "9999-12-31") && (bS ?? "0000-01-01") <= (aE ?? "9999-12-31");

/** A rate's lookup dimensions (null = blank = matches any value), plus usage type and effective dates. */
export interface RateKey { taxCode: string | null; country: string | null; state: string | null; city: string | null; zipCode: string | null; productCode: string | null; legalEntityId: string | null; usage: string | null; start: string | null; end: string | null }
export type RateOverlap = "none" | "conditional" | "always";

/**
 * Pure: can one decision-table lookup match BOTH rates?
 *  · "none" — some dimension is set on both and differs, the usage types differ, or the effective dates don't overlap.
 *  · "always" — one rate's set values are a subset of the other's (blank = any): every sale matching the narrower rate matches the
 *    wider one too, so Salesforce's lookup returns Multiple Matches for it (e.g. a blank-ProductCode rate with no state vs. a
 *    product-specific rate with no state, same tax code / country / legal entity).
 *  · "conditional" — they collide only for some inputs (p10 E2: TR-00000021 LPB-001/no state vs TR-00000022 blank/KA collide for
 *    LPB-001 in KA only — Salesforce's evaluation returned Multiple Matches there).
 * Identical keys are "always" (an exact duplicate).
 */
export function rateOverlap(a: RateKey, b: RateKey): RateOverlap {
  const norm = (x: string | null) => (x && x.trim() ? id15(x.trim()) : null);
  if ((a.usage ?? "").toLowerCase() !== (b.usage ?? "").toLowerCase()) return "none";
  if (!datesOverlap(a.start, a.end, b.start, b.end)) return "none";
  const dims: (keyof RateKey)[] = ["taxCode", "country", "state", "city", "zipCode", "productCode", "legalEntityId"];
  let aCoversB = true, bCoversA = true;
  for (const d of dims) {
    const x = norm(a[d]), y = norm(b[d]);
    if (x && y && x !== y) return "none";
    if (x && !y) aCoversB = false; // a requires a value b accepts as "any" → a is narrower here
    if (y && !x) bCoversA = false;
  }
  return aCoversB || bCoversA ? "always" : "conditional";
}

/** TaxRate field values (API names) → RateKey. */
export function rateKeyOf(v: Record<string, unknown>, opts: { country?: string | null; state?: string | null } = {}): RateKey {
  return { taxCode: s(v.TaxCode), country: opts.country ?? s(v.GeoCountryId), state: opts.state ?? s(v.GeoStateId), city: s(v.City), zipCode: s(v.ZipCode), productCode: s(v.ProductCode), legalEntityId: s(v.LegalEntityId), usage: s(v.RateUsageType), start: s(v.StartDate), end: s(v.EndDate) };
}

/**
 * Existing RevCloud rates that a lookup would match TOGETHER with the new/edited rate. "always" overlaps are ERRORS (the lookup can
 * only return Multiple Matches for the narrower rate); "conditional" ones are warnings naming the wildcard dimensions. Exact
 * duplicates are reported by the duplicate rules and skipped here.
 */
export function overlappingRates(values: Record<string, unknown>, rows: Record<string, unknown>[], selfId: string | null = null): RateRuleIssue[] {
  if (s(values.RateUsageType) !== REVENUE_CLOUD_RATE_USAGE) return [];
  const out: RateRuleIssue[] = [];
  const mine = rateKeyOf(values);
  for (const r of rows) {
    if (selfId && typeof r.Id === "string" && id15(r.Id) === id15(selfId)) continue;
    if (s(r.RateUsageType) !== REVENUE_CLOUD_RATE_USAGE) continue;
    const kind = rateOverlap(mine, rateKeyOf(r));
    if (kind === "none") continue;
    const wild: string[] = [];
    let identical = true;
    for (const d of DIMENSIONS) {
      const a = s(values[d]), b = s(r[d]);
      if (a && b) continue;
      if (a || b) { identical = false; wild.push(`${d} (${a ? "blank on the existing rate" : "blank on this rate"})`); }
    }
    if (identical) continue;
    if (kind === "always") out.push({ severity: "error", code: "RATE_ALWAYS_AMBIGUOUS", field: null, message: `Every sale this rate matches is also matched by ${String(r.Name ?? r.Id)} (${r.Rate ?? "?"}%) or vice versa — wildcard ${wild.join(", ")} — so Salesforce's lookup returns Multiple Matches. Make a dimension distinct (e.g. a product-specific Product Code) or end-date one of them.` });
    else out.push({ severity: "warning", code: "AMBIGUOUS_RATE_OVERLAP", field: null, message: `Overlaps existing rate ${String(r.Name ?? r.Id)} (${r.Rate ?? "?"}%) for some sales: every dimension is equal or blank and the dates overlap. Differs only by wildcard ${wild.join(", ")} — those sales get Multiple Matches; make a dimension distinct or end-date one of them.` });
  }
  return out;
}
