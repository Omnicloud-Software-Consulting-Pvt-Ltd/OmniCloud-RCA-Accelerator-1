import { diag, isPermissionError, type TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { resolveTaxConfiguration, today, type ConfigurationResolution } from "@/lib/tax/server/resolution";
import { calculationReadiness, type DecisionTableState } from "@/lib/tax/server/engine";
import { tableForEngine, type TaxRuntimeApi } from "@/lib/tax/server/runtime";

/**
 * TAX CALCULATION SERVICE — resolves Product → Tax Policy → Tax Treatment → Tax Engine → Tax Rate for a sale, then asks
 * SALESFORCE to calculate the tax. Nothing is calculated by the application:
 *
 *  · The direct route is Salesforce's Tax Calculation API, POST /commerce/taxes/actions/calculate. Its schema was read from the
 *    org itself (p10, v68): required taxEngineId, taxType, transactionDate, lineItems, currencyIsoCode = the org currency; line
 *    items accept lineNumber, amount, quantity, productCode, taxCode and addresses.shipTo {country, state, city, postalCode}
 *    (unknown fields are refused with JSON_PARSER_ERROR, so nothing else is sent).
 *  · In p10 that API returns NOT_FOUND for Revenue Standard Tax engines (they have no Tax Engine Provider adapter) — Salesforce
 *    calculates Revenue Standard Tax on invoices instead. The result is then CONFIGURATION_READY with that exact Salesforce
 *    message, never CALCULATED; the billing-lifecycle validation (order → invoice → InvoiceLineTax) is the way to Salesforce's tax.
 *
 * Statuses are deliberately distinct: INVALID_REQUEST, NOT_READY (configuration problems), NO_TAX_EXPECTED (the applicable
 * treatment is non-taxable — nothing to calculate), CONFIGURATION_READY (everything resolves, Salesforce didn't calculate),
 * CALCULATED (Salesforce returned tax), CALCULATION_FAILED (Salesforce rejected it).
 */

export type CalculationStatus = "INVALID_REQUEST" | "NOT_READY" | "NO_TAX_EXPECTED" | "CONFIGURATION_READY" | "CALCULATED" | "CALCULATION_FAILED";
export type CalculationMode = "validate" | "preview" | "calculate";

export interface CalculationInput {
  product: { id?: string | null; name?: string | null };
  quantity?: number | string | null; unitPrice?: number | string | null;
  accountId?: string | null; orderId?: string | null; orderItemId?: string | null;
  effectiveDate?: string | null;
  country?: string | null; state?: string | null; city?: string | null; zipCode?: string | null;
  legalEntityId?: string | null; currencyIsoCode?: string | null;
}
export interface NormalizedRequest {
  product: { id: string | null; name: string | null }; quantity: number; unitPrice: number | null; effectiveDate: string;
  country: string | null; state: string | null; city: string | null; zipCode: string | null; legalEntityId: string | null;
  accountId: string | null; orderId: string | null; orderItemId: string | null; currencyIsoCode: string | null;
}

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Validate & normalise the request (no Salesforce access). Unsupported fields simply aren't part of the shape. */
export function validateCalculationRequest(input: CalculationInput): { ok: true; request: NormalizedRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const pid = s(input.product?.id), pname = s(input.product?.name);
  if (!pid && !pname) errors.push("Which product? Give its name, product code or Id.");
  if (pid && !SFID.test(pid)) errors.push("product.id isn't a Salesforce Id.");
  const qty = input.quantity === null || input.quantity === undefined || input.quantity === "" ? 1 : Number(String(input.quantity).replace(/,/g, ""));
  if (!Number.isFinite(qty) || qty <= 0) errors.push("quantity must be a positive number.");
  const priceRaw = input.unitPrice === null || input.unitPrice === undefined || input.unitPrice === "" ? null : Number(String(input.unitPrice).replace(/[,\s₹$€£]/g, ""));
  if (priceRaw !== null && (!Number.isFinite(priceRaw) || priceRaw < 0)) errors.push("unitPrice must be zero or a positive number.");
  const date = s(input.effectiveDate) ?? today();
  if (!DATE.test(date) || Number.isNaN(Date.parse(date))) errors.push("effectiveDate must be a date (YYYY-MM-DD).");
  for (const k of ["accountId", "orderId", "orderItemId", "legalEntityId"] as const) if (s(input[k]) && !SFID.test(s(input[k])!)) errors.push(`${k} isn't a Salesforce Id.`);
  const cur = s(input.currencyIsoCode);
  if (cur && !/^[A-Z]{3}$/.test(cur)) errors.push("currencyIsoCode must be a 3-letter ISO code.");
  if (errors.length) return { ok: false, errors };
  return { ok: true, request: {
    product: { id: pid, name: pname }, quantity: qty, unitPrice: priceRaw, effectiveDate: date,
    country: s(input.country), state: s(input.state), city: s(input.city), zipCode: s(input.zipCode), legalEntityId: s(input.legalEntityId),
    accountId: s(input.accountId), orderId: s(input.orderId), orderItemId: s(input.orderItemId), currencyIsoCode: cur,
  } };
}

/** The Tax Calculation API request — only the fields the org's own validation accepts (see the header). */
export function buildCommerceTaxRequest(r: NormalizedRequest, res: ConfigurationResolution, engineId: string, currencyIsoCode: string): Record<string, unknown> {
  const shipTo: Record<string, string> = {};
  if (res.geography.countryIso) shipTo.country = res.geography.countryIso;
  if (res.geography.stateIso) shipTo.state = res.geography.stateIso;
  if (r.city) shipTo.city = r.city;
  if (r.zipCode) shipTo.postalCode = r.zipCode;
  const line: Record<string, unknown> = { lineNumber: "1", amount: round2(r.quantity * (r.unitPrice ?? 0)), quantity: r.quantity };
  // The same product/tax codes rate resolution uses (Tax Treatment Item, else treatment) — never the product's SKU as a stand-in.
  if (res.treatment.productCode) line.productCode = res.treatment.productCode;
  if (res.treatment.taxCode) line.taxCode = res.treatment.taxCode;
  if (Object.keys(shipTo).length) line.addresses = { shipTo };
  return { taxEngineId: engineId, taxType: "Estimated", transactionDate: `${r.effectiveDate}T00:00:00.000Z`, currencyIsoCode, lineItems: [line] };
}

export interface SalesforceTaxLine { lineNumber: string | null; taxAmount: number | null; rate: number | null; taxCode: string | null; taxName: string | null }
/**
 * Normalise a Tax Calculation API response. The success shape couldn't be observed in p10 (the API returns NOT_FOUND for
 * Revenue Standard Tax), so this reads the documented fields tolerantly — and reports "no tax amount" rather than inventing one.
 */
export function normalizeCommerceTaxResponse(json: unknown): { totalTax: number | null; lines: SalesforceTaxLine[] } {
  const o = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  const rawLines = (Array.isArray(o.lineItems) ? o.lineItems : Array.isArray(o.lines) ? o.lines : []) as Record<string, unknown>[];
  const lines: SalesforceTaxLine[] = rawLines.map(l => {
    const taxes = (Array.isArray(l.taxes) ? l.taxes : []) as Record<string, unknown>[];
    const taxObj = (l.tax && typeof l.tax === "object" ? l.tax : {}) as Record<string, unknown>;
    const fromTaxes = taxes.map(t => n(t.tax) ?? n(t.taxAmount) ?? n(t.amount)).filter((x): x is number => x !== null);
    const amount = n(taxObj.totalAmount) ?? n(l.taxAmount) ?? n(l.totalTax) ?? (fromTaxes.length ? round2(fromTaxes.reduce((a, b) => a + b, 0)) : null);
    const t0 = taxes[0] ?? {};
    return { lineNumber: s(l.lineNumber) ?? (n(l.lineNumber) !== null ? String(l.lineNumber) : null), taxAmount: amount, rate: n(t0.rate) ?? n(l.rate), taxCode: s(t0.taxCode) ?? s(l.taxCode), taxName: s(t0.taxName) ?? s(t0.name) };
  });
  const total = n(o.totalTax) ?? n(o.taxAmount) ?? n((o.tax as Record<string, unknown> | undefined)?.totalAmount) ?? (lines.some(l => l.taxAmount !== null) ? round2(lines.reduce((a, l) => a + (l.taxAmount ?? 0), 0)) : null);
  return { totalTax: total, lines };
}

/** Salesforce's error list → first code + joined message (Salesforce sometimes nests a JSON {description} in the message). */
export function salesforceError(json: unknown): { code: string | null; message: string | null } {
  const arr = Array.isArray(json) ? (json as { errorCode?: string; message?: string }[]) : json && typeof json === "object" && Array.isArray((json as { errors?: unknown }).errors) ? (json as { errors: { errorCode?: string; message?: string }[] }).errors : [];
  const msgs = arr.map(e => { const m = e.message ?? ""; try { const p = JSON.parse(m) as { description?: string }; return p.description ?? m; } catch { return m; } }).filter(Boolean);
  return { code: arr[0]?.errorCode ?? null, message: msgs.join("; ") || (typeof json === "string" ? json.slice(0, 500) : null) };
}

export interface TaxCalculationResult {
  success: true;
  status: CalculationStatus;
  mode: CalculationMode;
  message: string;
  request: NormalizedRequest | null;
  resolution: ConfigurationResolution | null;
  summary: {
    product: { id: string; name: string; code: string | null } | null; quantity: number | null; unitPrice: number | null; taxableAmount: number | null;
    policy: { id: string; name: string } | null; treatment: { id: string; name: string; taxable: boolean; status: string | null } | null; item: { id: string; name: string } | null;
    engine: { id: string; name: string; status: string | null } | null;
    taxCode: string | null; productCode: string | null;
    taxRate: { id: string; name: string; rate: number | null; taxCode: string | null } | null;
    geography: { country: string | null; state: string | null; city: string | null; zipCode: string | null };
    legalEntity: { id: string; name: string } | null;
  } | null;
  /** The configured rate × taxable amount — what Salesforce SHOULD calculate. Never presented as Salesforce's result. */
  expected: { rate: number; taxAmount: number; note: string } | null;
  salesforce: { endpoint: string; request: Record<string, unknown> | null; httpStatus: number | null; errorCode: string | null; message: string | null; totalTax: number | null; lines: SalesforceTaxLine[] } | null;
  decisionTable: { name: string; status: string | null; refreshStatus: string | null; ready: boolean; reason: string | null } | null;
  /** Where Salesforce's tax can actually be obtained when the direct API can't (Revenue Standard Tax: on the invoice). */
  fallback: { path: "billing-lifecycle"; reason: string } | null;
  diagnostics: TaxDiagnostic[];
}

export const COMMERCE_TAX_ENDPOINT = "/commerce/taxes/actions/calculate";

/** Validate → resolve → (preview the Salesforce request) → (ask Salesforce to calculate). */
export async function calculateTax(api: TaxRuntimeApi, input: CalculationInput, mode: CalculationMode = "calculate"): Promise<TaxCalculationResult> {
  const empty = { request: null, resolution: null, summary: null, expected: null, salesforce: null, decisionTable: null, fallback: null };
  const v = validateCalculationRequest(input);
  if (!v.ok) return { success: true, status: "INVALID_REQUEST", mode, message: v.errors.join(" "), ...empty, diagnostics: [] };
  const r = v.request;
  const loaded = await api.loadData(r.product);
  if (!loaded.data.product) {
    const d = diag("MISSING_PRODUCT", loaded.productLookup.message ?? "Product not found.");
    return { success: true, status: "NOT_READY", mode, message: d.explanation, ...empty, request: r, diagnostics: [d] };
  }
  const unitPrice = r.unitPrice ?? loaded.listPrice;
  const req = { ...r, unitPrice };
  const res = resolveTaxConfiguration(loaded.data, { country: r.country, state: r.state, city: r.city, zipCode: r.zipCode, legalEntityId: r.legalEntityId, effectiveDate: r.effectiveDate });
  const diagnostics = [...res.diagnostics];
  const dt = tableForEngine(loaded, res.treatment.engine?.id);
  const dtState = tableState(dt, loaded.data.engines.filter(e => e.native && e.status === "Active").length);
  if (dtState && !dtState.ready) diagnostics.push(diag(/refresh/i.test(dtState.code ?? "") ? "DECISION_TABLE_REFRESHING" : "DECISION_TABLE_NOT_READY", dtState.reason ?? "Decision table isn't ready.", { severity: dtState.blocking ? "error" : "warning", action: dtState.action }));
  if (unitPrice === null) diagnostics.push(diag("ORDER_NOT_READY", `No unit price given and "${loaded.data.product.name}" has no active Standard Price Book entry.`));
  const t = res.treatment, rate = res.rate?.selected ?? null;
  const taxable = round2(r.quantity * (unitPrice ?? 0));
  const summary: TaxCalculationResult["summary"] = {
    product: { id: loaded.data.product.id, name: loaded.data.product.name, code: loaded.data.product.code }, quantity: r.quantity, unitPrice, taxableAmount: unitPrice === null ? null : taxable,
    policy: t.policy ? { id: t.policy.id, name: t.policy.name } : null, treatment: t.treatment ? { id: t.treatment.id, name: t.treatment.name, taxable: t.treatment.taxable, status: t.treatment.status } : null,
    item: t.item ? { id: t.item.id, name: t.item.name } : null, engine: t.engine ? { id: t.engine.id, name: t.engine.name, status: t.engine.status } : null,
    taxCode: t.taxCode, productCode: t.productCode, taxRate: rate ? { id: rate.id, name: rate.name, rate: rate.rate, taxCode: rate.taxCode } : null,
    geography: { country: res.geography.countryIso ?? r.country, state: res.geography.stateIso ?? r.state, city: r.city, zipCode: r.zipCode }, legalEntity: res.legalEntity,
  };
  const expected = rate?.rate !== null && rate?.rate !== undefined && unitPrice !== null ? { rate: rate.rate, taxAmount: round2(taxable * rate.rate / 100), note: "Expected at the configured rate — not a Salesforce calculation." } : null;
  const decisionTable = dt ? { name: dt.name, status: dt.status, refreshStatus: dt.refreshStatus, ready: !!dtState?.ready, reason: dtState?.reason ?? null } : null;
  const tableBlocked = !!dtState && !dtState.ready && dtState.blocking;
  const tableNote = tableBlocked ? ` Salesforce can't calculate this tax yet either way: ${dtState!.reason}` : "";
  const fallback = { path: "billing-lifecycle" as const, reason: tableBlocked ? "Blocked until the decision table is corrected by an administrator." : "Salesforce calculates Revenue Standard Tax on invoices: order → billing schedule → invoice → InvoiceLineTax (confirmation required)." };
  const base = { success: true as const, mode, request: req, resolution: res, summary, decisionTable, fallback: null as TaxCalculationResult["fallback"] };
  const configBlocked = res.status === "blocked" || unitPrice === null;
  if (configBlocked) return { ...base, status: "NOT_READY", expected: null, salesforce: null, diagnostics, message: `Not ready: ${diagnostics.filter(d => d.severity === "error").map(d => d.explanation).join(" ") || "the tax configuration doesn't resolve."}` };
  if (t.treatment && !t.treatment.taxable) return { ...base, status: "NO_TAX_EXPECTED", expected: null, salesforce: null, diagnostics, message: `NO TAX EXPECTED: "${t.treatment.name}" is not taxable, so Salesforce applies no tax to ${loaded.data.product.name}. Nothing was calculated — this is not a tax calculation result.` };
  const currency = r.currencyIsoCode ?? await api.currencyIsoCode();
  const sfRequest = t.engine && currency ? buildCommerceTaxRequest(req, res, t.engine.id, currency) : null;
  if (mode !== "calculate") return { ...base, status: "CONFIGURATION_READY", expected, salesforce: sfRequest ? { endpoint: COMMERCE_TAX_ENDPOINT, request: sfRequest, httpStatus: null, errorCode: null, message: null, totalTax: null, lines: [] } : null, diagnostics,
    message: (mode === "validate" ? "The tax configuration resolves. Nothing was sent to Salesforce." : "Preview of the Salesforce request. Nothing was sent to Salesforce.") + tableNote };
  if (!sfRequest) return { ...base, status: "CALCULATION_FAILED", expected, salesforce: null, diagnostics: [...diagnostics, diag("CALCULATION_REJECTED", "The org currency couldn't be determined, so no calculation request was sent.")], message: "No calculation request was sent: the org currency is unknown." };
  const out = await api.commerceCalculate(sfRequest);
  const err = salesforceError(out.json);
  const op = `Tax Calculation API (POST ${COMMERCE_TAX_ENDPOINT})`;
  const sf = { endpoint: COMMERCE_TAX_ENDPOINT, request: sfRequest, httpStatus: out.status, errorCode: err.code, message: err.message, totalTax: null as number | null, lines: [] as SalesforceTaxLine[] };
  if (out.status >= 400) {
    if (out.status === 404 && /NOT_FOUND/i.test(err.code ?? "")) {
      const d = diag("CALCULATION_ENDPOINT_UNAVAILABLE", `Salesforce's Tax Calculation API returned ${err.code}: "${err.message}" for tax engine "${t.engine!.name}" (${t.engine!.type ?? "—"}${t.engine!.providerId ? "" : ", no Tax Engine Provider adapter"}). Revenue Standard Tax is calculated by Salesforce on invoices.`, { severity: "warning", salesforceCode: err.code, salesforceMessage: err.message, httpStatus: out.status, operation: op });
      return { ...base, status: "CONFIGURATION_READY", expected, salesforce: sf, fallback, diagnostics: [...diagnostics, d], message: `Configuration ready, but Salesforce did not calculate tax: the Tax Calculation API isn't available for "${t.engine!.name}" (HTTP ${out.status} ${err.code}). Salesforce's tax comes from the billing-lifecycle validation (invoice → InvoiceLineTax).${tableNote}` };
    }
    const perm = isPermissionError(out.status, err.code, err.message);
    const d = diag(perm ? "PERMISSION_OR_LICENSE" : "CALCULATION_REJECTED", `Salesforce rejected the calculation (HTTP ${out.status}${err.code ? ` ${err.code}` : ""}): ${err.message ?? "no message"}`, { salesforceCode: err.code, salesforceMessage: err.message, httpStatus: out.status, operation: op });
    return { ...base, status: "CALCULATION_FAILED", expected, salesforce: sf, diagnostics: [...diagnostics, d], message: d.explanation };
  }
  const norm = normalizeCommerceTaxResponse(out.json);
  sf.totalTax = norm.totalTax; sf.lines = norm.lines;
  if (norm.totalTax === null) return { ...base, status: "CALCULATION_FAILED", expected, salesforce: sf, diagnostics: [...diagnostics, diag("CALCULATION_REJECTED", "Salesforce answered without a tax amount — no result is reported.", { httpStatus: out.status, operation: op })], message: "Salesforce returned no tax amount." };
  return { ...base, status: "CALCULATED", expected, salesforce: sf, diagnostics, message: `Salesforce calculated tax ${norm.totalTax} on ${taxable}.` };
}

/** The explicit, approval-gated remediation for a stale / not-yet-refreshed decision table (never performed silently). */
export const REFRESH_REQUIRED_ACTION = "Refresh the decision table before invoicing — an explicit, approved step (the refresh action with approval, or Salesforce: App Launcher → Lookup Tables → the table → Refresh); the application never refreshes it on its own.";

/**
 * Decision-table readiness in calculation terms. Every not-ready state BLOCKS invoicing: a table without the required structure
 * needs an admin; a stale table (a TaxRate changed after its last successful full or incremental refresh) needs an explicit,
 * approved refresh first — `refreshable` tells which.
 */
export function tableState(dt: DecisionTableState | null, activeNativeEngines: number): { ready: boolean; code: string | null; reason: string | null; blocking: boolean; refreshable: boolean; action: string | null } | null {
  const c = calculationReadiness(dt, activeNativeEngines);
  if (c.ready) return { ready: true, code: null, reason: null, blocking: false, refreshable: false, action: null };
  const refreshable = c.code === "STANDARD_TAX_REFRESH" || c.code === "STANDARD_TAX_STALE";
  return { ...c, blocking: true, refreshable, action: refreshable ? REFRESH_REQUIRED_ACTION : dt?.outdated ? (dt.source === "engine" ? "Add the Tax Code input to the engine's decision table (Salesforce Setup), then activate and refresh it." : "A Salesforce admin must give the engine a decision table with a TaxCode input (clone Revenue Standard Tax Entries in Setup → Lookup Tables, add Tax Code, activate, refresh, and select it on the tax engine).") : null };
}
