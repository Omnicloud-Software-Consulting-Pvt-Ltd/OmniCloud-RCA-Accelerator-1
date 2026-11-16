import type { ProductTaxReadiness } from "@/lib/tax/server/pipeline";
import type { TaxDiagnostic } from "@/lib/tax/server/diagnostics";
import { REFERENCE_LABEL, round2, type TaxCalcReason, type TaxInputs } from "@/lib/tax/server/calculationResult";

/**
 * TAX CALCULATION — VALIDATION (lifecycle stages 1–6: validate, resolve treatment, engine, decision table, table readiness, rate).
 * Pure: evaluates what was READ from Salesforce (product readiness + the account) into explicit checks. Nothing is silently
 * assumed — a missing value is a FAIL or a WARN with the reason, and the one stated default (RateUsageType "RevCloud", the
 * value Revenue Cloud Billing invoices carry) is labelled as such.
 */

export interface CalcAccount { id: string; name: string; street: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }
export interface ValidationInput {
  account: CalcAccount | null;
  contact: { id: string; name: string } | null;
  quantity: number | null;
  unitPrice: number | null;
  effectiveDate: string;
  /** Geography to use when no account is given (validate / preview only). */
  geography?: { country: string | null; state: string | null; city: string | null; postalCode: string | null } | null;
}
export interface ValidationCheck { id: string; label: string; status: "PASS" | "WARN" | "FAIL"; detail: string; recordId: string | null }
export interface ResolvedTreatment {
  treatmentId: string; treatmentName: string; policyId: string | null; policySelection: string | null; engineId: string | null;
  taxCode: string | null; isTaxable: boolean; shouldUseTaxTreatmentItems: boolean; legalEntityId: string | null; itemId: string | null;
}
export interface ExpectedReference { source: "EXPECTED_ONLY"; label: typeof REFERENCE_LABEL; rate: number | null; taxCode: string | null; taxableAmount: number | null; taxAmount: number | null; note: string }
export interface TaxCalcValidation {
  status: "READY" | "NOT_READY";
  reason: TaxCalcReason | null;
  /** Every check except the account/billing ones passed (enough for a decision-table preview). */
  configurationReady: boolean;
  checks: ValidationCheck[];
  account: CalcAccount | null;
  contact: { id: string; name: string } | null;
  product: { id: string; name: string; code: string | null } | null;
  quantity: number | null;
  unitPrice: number | null;
  unitPriceSource: "input" | "standard price" | null;
  treatment: ResolvedTreatment | null;
  engine: { id: string; name: string; status: string | null; type: string | null; decisionTableId: string | null } | null;
  decisionTable: { id: string; name: string; setupName: string | null; status: string | null; usageType: string | null; sourceObject: string | null; refreshStatus: string | null; lastSync: string | null; lastIncrementalSync: string | null; inputs: string[]; outputs: string[] } | null;
  rate: { id: string; name: string; taxCode: string | null; rate: number | null; applicationBasis: string | null; usage: string | null; start: string | null; end: string | null } | null;
  legalEntity: { id: string; name: string } | null;
  inputs: TaxInputs;
  expected: ExpectedReference | null;
  diagnostics: TaxDiagnostic[];
  message: string;
}

/** The decision-table inputs a Revenue Standard Tax calculation has to support. */
export const SUPPORTED_TABLE_INPUTS = ["Country", "State", "City", "ZipCode", "ProductCode", "StartDate", "EndDate", "RateUsageType", "LegalEntityId", "TaxCode"] as const;
/** Revenue Cloud Billing invoices are matched with this rate usage type (not stored on the transaction — stated, not read). */
export { REVENUE_CLOUD_RATE_USAGE } from "@/lib/tax/server/rateRules";
import { REVENUE_CLOUD_RATE_USAGE } from "@/lib/tax/server/rateRules";

export function evaluateCalculationValidation(r: ProductTaxReadiness, v: ValidationInput): TaxCalcValidation {
  const checks: ValidationCheck[] = [];
  const add = (id: string, label: string, status: ValidationCheck["status"], detail: string, recordId: string | null = null) => checks.push({ id, label, status, detail, recordId });
  const res = r.resolution;
  const t = res?.treatment ?? null;
  const er = r.engineReadiness ?? null;

  /* account, billing account, address */
  const geo = v.account ? { country: v.account.country, state: v.account.state, city: v.account.city, postalCode: v.account.postalCode } : v.geography ?? null;
  if (v.account) add("account", "Account", "PASS", v.account.name, v.account.id);
  else add("account", "Account", "FAIL", "No account — a Salesforce calculation bills an order to an account (validation and preview can use a country instead).");
  if (v.account) add("billing-account", "Billing account (Bill To Contact)", v.contact ? "PASS" : "FAIL", v.contact ? `${v.account.name} · Bill To ${v.contact.name}` : `"${v.account.name}" has no Contact — Salesforce's billing schedules need a Bill To Contact.`, v.contact?.id ?? null);
  add("country", "Country", geo?.country ? (res?.geography.countryIso ? "PASS" : "FAIL") : "FAIL", geo?.country ? `${geo.country}${res?.geography.countryIso ? ` → ${res.geography.countryIso}` : " — no GeoCountry record in this org"}` : "No country — the decision table requires Country.");
  // The order gets the GeoState code (the decision table compares State exactly — "Andhra Pradesh" never matches "AP").
  const stateCode = res?.geography.state?.iso ?? null;
  add("state", "State", geo?.state ? "PASS" : "WARN", geo?.state ? `${geo.state}${stateCode && stateCode !== geo.state ? ` → ${stateCode}` : ""}${res?.geography.diagnostics.some(d => d.code === "MISSING_GEOGRAPHY" && /State/.test(d.explanation)) ? " (no GeoState record — only rates without a state can apply)" : ""}` : "Not given — only rates without a state can apply.");
  add("city", "City", geo?.city ? "PASS" : "WARN", geo?.city ?? "Not given — only rates without a city can apply.");
  add("postal-code", "Postal Code", geo?.postalCode ? "PASS" : "WARN", geo?.postalCode ?? "Not given — only rates without a zip code can apply.");

  /* product, quantity, price */
  const product = r.product;
  if (!product) add("product", "Product", "FAIL", r.message);
  else add("product", "Product", res?.product && !res.product.active ? "FAIL" : "PASS", `${product.name}${res?.product && !res.product.active ? " — inactive" : ""}`, product.id);
  add("product-code", "ProductCode", product?.code ? "PASS" : "WARN", product?.code ?? "The product has no ProductCode — only rates without a product code can apply.", product?.id ?? null);
  const qty = v.quantity ?? null;
  add("quantity", "Quantity", qty !== null && qty > 0 ? "PASS" : "FAIL", qty !== null && qty > 0 ? String(qty) : "Quantity must be greater than 0.");
  const unitPrice = v.unitPrice ?? r.listPrice ?? null;
  const unitPriceSource = v.unitPrice !== null && v.unitPrice !== undefined ? "input" : r.listPrice !== null && r.listPrice !== undefined ? "standard price" : null;
  add("unit-price", "Unit price", unitPrice !== null && unitPrice >= 0 ? "PASS" : "FAIL", unitPrice !== null ? `${unitPrice} (${unitPriceSource})` : "No unit price given and the product has no active Standard Price Book entry.");

  /* treatment resolution */
  const ambiguous = res?.diagnostics.find(d => d.code === "AMBIGUOUS_TAX_TREATMENT") ?? null;
  const policy = t?.policy ?? null;
  add("tax-policy", "Tax Policy", !policy ? "FAIL" : policy.status === "Active" ? "PASS" : "FAIL", policy ? `${policy.name} · ${policy.status ?? "—"} · ${policy.selection ?? "—"} selection` : res?.diagnostics.find(d => d.code === "MISSING_TAX_POLICY")?.explanation ?? "No tax policy.", policy?.id ?? null);
  const tr = t?.treatment ?? null;
  if (ambiguous) add("tax-treatment", "Tax Treatment", "FAIL", `${ambiguous.explanation} Select the treatment to use.`);
  else add("tax-treatment", "Tax Treatment", !tr ? "FAIL" : tr.status !== "Active" ? "FAIL" : tr.taxable ? "PASS" : "WARN", tr ? `${tr.name} · ${tr.status ?? "—"} · ${tr.taxable ? "taxable" : "NOT taxable — no tax is expected"}${tr.useItems ? " · uses Tax Treatment Items" : ""}` : res?.diagnostics.find(d => /TREATMENT/.test(d.code))?.explanation ?? "No applicable tax treatment.", tr?.id ?? null);
  // Same rule as the activation gate (orderItemTax TAX_TREATMENT_LEGAL_ENTITY_MISSING): in this org every taxable treatment without
  // a Legal Entity produced no InvoiceLineTax (DOC-000000011/12/15/16) and the same configuration with one did (DOC-000000013/17).
  if (tr?.taxable && !tr.legalEntityId) add("tax-treatment-legal-entity", "Tax Treatment legal entity", "FAIL", `Tax Treatment "${tr.name}" has no Legal Entity — in this org taxable treatments without one produced no InvoiceLineTax. It can only be set while the treatment is Draft.`, tr.id);
  if (tr?.useItems) add("tax-treatment-item", "Tax Treatment Item", t?.item ? "PASS" : "FAIL", t?.item ? `${t.item.name} · TaxCode ${t.item.taxCode ?? "—"} · ProductCode ${t.item.productCode ?? "—"}` : `No Tax Treatment Item for ${product?.name ?? "the product"}.`, t?.item?.id ?? null);
  const taxable = !!tr?.taxable;
  const tableHasTaxCode = !!er?.decisionTable?.inputs.includes("TaxCode");
  if (taxable) add("tax-code", "TaxCode", t?.taxCode ? "PASS" : tableHasTaxCode ? "FAIL" : "WARN", t?.taxCode ?? "No TaxCode on the treatment item or treatment.", t?.item?.id ?? tr?.id ?? null);

  /* engine */
  const eng = er?.engine ?? null;
  if (taxable) {
    if (!eng) add("tax-engine", "Tax Engine", "FAIL", "The taxable treatment has no tax engine.");
    else {
      add("tax-engine", "Tax Engine", eng.status === "Active" ? "PASS" : "FAIL", `${eng.name} · ${eng.status ?? "—"}`, eng.id);
      add("tax-engine-type", "Engine type RevenueStandardTax", eng.type === "RevenueStandardTax" ? "PASS" : "FAIL", eng.type ?? "—", eng.id);
      add("tax-engine-table", "TaxEngine.DecisionTableId", eng.decisionTableId ? "PASS" : "FAIL", eng.decisionTableId ? `${eng.decisionTableId} (read from Salesforce)` : `Tax engine "${eng.name}" has no DecisionTableId — assign the Revenue Standard Tax decision table on the engine.`, eng.id);
    }
  }

  /* decision table */
  const dt = er?.decisionTable ?? null;
  const stale = !!er?.checks.find(c => c.code === "TABLE_REFRESHED" && !c.passed);
  const refreshStep = dt ? `Refresh it in Salesforce: App Launcher → Lookup Tables → ${dt.setupName ?? dt.name} → Refresh (the application never calls the API refresh).` : "";
  if (taxable && eng?.decisionTableId) {
    if (!dt || dt.source !== "engine") add("decision-table", "Decision Table", "FAIL", `The engine's decision table ${eng.decisionTableId} couldn't be read.`, eng.decisionTableId);
    else {
      add("decision-table", "Decision Table Active", dt.status === "Active" ? "PASS" : "FAIL", `${dt.name} · ${dt.status ?? "—"}`, dt.id);
      add("decision-table-usage", "UsageType RevenueStandardTax", dt.usageType === "RevenueStandardTax" ? "PASS" : dt.usageType ? "FAIL" : "WARN", dt.usageType ?? "UsageType not readable", dt.id);
      add("decision-table-source", "SourceObject TaxRate", dt.sourceObject === "TaxRate" ? "PASS" : "FAIL", dt.sourceObject ?? "—", dt.id);
      const missing = SUPPORTED_TABLE_INPUTS.filter(i => !dt.inputs.includes(i));
      const required = er!.checks.find(c => c.code === "TABLE_REQUIRED_INPUTS");
      add("decision-table-inputs", "Decision table inputs", required?.passed === false || !dt.inputs.includes("TaxCode") ? "FAIL" : missing.length ? "WARN" : "PASS", missing.length ? `Inputs: ${dt.inputs.join(", ")} · not an input: ${missing.join(", ")}` : `Inputs: ${dt.inputs.join(", ")}`, dt.id);
      add("decision-table-outputs", "Decision table outputs", dt.outputs.includes("Rate") ? "PASS" : "FAIL", `Outputs: ${dt.outputs.join(", ") || "—"}`, dt.id);
      add("decision-table-refresh", "Decision table refreshed", stale ? "FAIL" : /completed/i.test(dt.refreshStatus ?? "") ? "PASS" : "FAIL", `${dt.refreshStatus ?? "—"} · last full refresh ${dt.lastSync ?? "never"}${dt.lastIncrementalSync ? ` · last incremental refresh ${dt.lastIncrementalSync}` : ""}${stale ? ` · rates changed since the last refresh. ${refreshStep}` : ""}`, dt.id);
    }
  }

  /* rate, legal entity, usage, date */
  const rr = res?.rate ?? null;
  const sel = rr?.selected ?? null;
  if (taxable) add("tax-rate", "Tax Rate", rr?.status === "resolved" ? "PASS" : "FAIL", sel ? `${sel.name} · ${sel.taxCode ?? "—"} ${sel.rate ?? "?"}% ${sel.basis ?? ""} — ${rr!.why.join("; ")}` : rr?.diagnostics.map(d => d.explanation).join(" ") || "Not resolved (see the failed checks above).", sel?.id ?? null);
  add("legal-entity", "Legal Entity", res?.legalEntity ? "PASS" : "FAIL", res?.legalEntity ? `${res.legalEntity.name}` : "The sale's legal entity can't be determined (none or several active).", res?.legalEntity?.id ?? null);
  add("rate-usage-type", "RateUsageType", "PASS", `${REVENUE_CLOUD_RATE_USAGE} — the value Revenue Cloud Billing invoices are matched with (stated, not read from a record).`);
  add("effective-date", "Effective date", sel && ((sel.start && sel.start > v.effectiveDate) || (sel.end && sel.end < v.effectiveDate)) ? "FAIL" : "PASS", `${v.effectiveDate}${sel ? ` · rate ${sel.start ?? "…"} → ${sel.end ?? "open"}` : ""}`);

  /* result */
  const fails = checks.filter(c => c.status === "FAIL");
  const accountIds = new Set(["account", "billing-account"]);
  const configurationReady = !fails.some(c => !accountIds.has(c.id));
  const reason: TaxCalcReason | null = !fails.length ? null
    : stale ? "DECISION_TABLE_STALE"
    : ambiguous ? "AMBIGUOUS_TAX_TREATMENT"
    : configurationReady ? "ACCOUNT_REQUIRED"
    : "CONFIGURATION_NOT_READY";
  const taxableAmount = qty !== null && unitPrice !== null ? round2(qty * unitPrice) : null;
  const expected: ExpectedReference | null = taxable && sel ? { source: "EXPECTED_ONLY", label: REFERENCE_LABEL, rate: sel.rate, taxCode: sel.taxCode, taxableAmount, taxAmount: taxableAmount !== null && sel.rate !== null ? round2(taxableAmount * sel.rate / 100) : null, note: `${REFERENCE_LABEL} Configured ${sel.taxCode ?? ""} ${sel.rate ?? "?"}% × taxable amount.` } : null;
  const inputs: TaxInputs = {
    Country: res?.geography.countryIso ?? null, State: stateCode ?? geo?.state ?? null, City: geo?.city ?? null, ZipCode: geo?.postalCode ?? null,
    ProductCode: product?.code ?? null, StartDate: v.effectiveDate, EndDate: v.effectiveDate, RateUsageType: REVENUE_CLOUD_RATE_USAGE,
    LegalEntityId: res?.legalEntity?.id ?? null, TaxCode: t?.taxCode ?? null,
  };
  return {
    status: fails.length ? "NOT_READY" : "READY", reason, configurationReady, checks,
    account: v.account, contact: v.contact, product: product ? { id: product.id, name: product.name, code: product.code } : null,
    quantity: qty, unitPrice, unitPriceSource,
    treatment: tr ? { treatmentId: tr.id, treatmentName: tr.name, policyId: policy?.id ?? null, policySelection: policy?.selection ?? null, engineId: tr.engineId, taxCode: t?.taxCode ?? null, isTaxable: tr.taxable, shouldUseTaxTreatmentItems: tr.useItems, legalEntityId: tr.legalEntityId, itemId: t?.item?.id ?? null } : null,
    engine: eng ? { id: eng.id, name: eng.name, status: eng.status, type: eng.type, decisionTableId: eng.decisionTableId } : null,
    decisionTable: dt ? { id: dt.id, name: dt.name, setupName: dt.setupName ?? null, status: dt.status, usageType: dt.usageType ?? null, sourceObject: dt.sourceObject, refreshStatus: dt.refreshStatus, lastSync: dt.lastSync, lastIncrementalSync: dt.lastIncrementalSync ?? null, inputs: dt.inputs, outputs: dt.outputs } : null,
    rate: sel ? { id: sel.id, name: sel.name, taxCode: sel.taxCode, rate: sel.rate, applicationBasis: sel.basis, usage: sel.usage, start: sel.start, end: sel.end } : null,
    legalEntity: res?.legalEntity ?? null, inputs, expected,
    diagnostics: r.diagnostics,
    message: !fails.length ? `READY — ${product?.name ?? "the product"} resolves to ${tr?.name ?? "—"}${sel ? ` · ${sel.taxCode} ${sel.rate}%` : ""}${dt ? ` · decision table ${dt.name}` : ""}.`
      : reason === "DECISION_TABLE_STALE" ? `NOT READY — decision table ${dt?.name} is stale. ${refreshStep}`
      : reason === "ACCOUNT_REQUIRED" ? "Configuration READY — an account (with a Bill To Contact) is required to calculate with Salesforce."
      : `NOT READY — ${fails.map(f => `${f.label}: ${f.detail}`).join(" · ")}`,
  };
}
