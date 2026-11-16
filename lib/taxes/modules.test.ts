/**
 * Taxes module registry contract: only the audited Salesforce API names, plugged into the generic engine without leaking into
 * Revenue Cloud Billing, decision-table objects view-only, no fabricated Tax Region / Tax Code objects.
 *
 * Run: `npx tsx --test lib/taxes/modules.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TAX_DASHBOARD_MODULES, TAX_MODULES } from "./modules";
import { BILLING_MODULES, getBillingModule } from "@/lib/billing/registry";

// Verified by the 2026-10-07 describe/Tooling audit of the connected org.
const AUDITED = new Set(["TaxEngine", "TaxPolicy", "TaxTreatment", "TaxTreatmentItem", "TaxRate", "GeoCountry", "GeoState", "LegalEntity", "DecisionTable", "DecisionTableParameter", "DecisionTableDatasetLink", "CalculationMatrix"]);

test("every Taxes module uses only audited Salesforce API names", () => {
  for (const m of TAX_MODULES) for (const c of m.candidates) assert.ok(AUDITED.has(c), `${m.key} → ${c} wasn't verified by the audit`);
});

test("no Tax Region, Jurisdiction, Tax Code, Provider or InvoiceLineTax object is modelled", () => {
  const all = TAX_MODULES.flatMap(m => m.candidates);
  for (const banned of ["TaxRegion", "TaxJurisdiction", "TaxCode", "TaxEngineProvider", "InvoiceLineTax"]) assert.ok(!all.includes(banned), banned);
});

test("tax modules resolve through the generic engine but stay out of the Billing section", () => {
  for (const m of TAX_MODULES) {
    assert.equal(getBillingModule(m.key)?.candidates[0], m.candidates[0]);
    assert.ok(!BILLING_MODULES.some(b => b.key === m.key), `${m.key} leaked into BILLING_MODULES`);
    assert.equal(m.group, "taxes");
  }
  // Billing's own modules are untouched and still resolvable.
  assert.equal(getBillingModule("billing-policies")?.candidates[0], "BillingPolicy");
  assert.ok(!BILLING_MODULES.some(b => /^Tax|^Geo|^Decision|^CalculationMatrix/.test(b.candidates[0])), "Billing modules must not include tax objects");
});

test("decision-table objects are view-only and filtered to Revenue Standard Tax", () => {
  for (const key of ["tax-decision-tables", "tax-decision-table-parameters", "tax-decision-dataset-links", "tax-lookup-tables"]) {
    const m = getBillingModule(key)!;
    assert.ok(m.viewOnly, `${key} must be view-only`);
    assert.ok(m.listFilter?.some(f => /UsageType$/.test(f.field) && f.value === "RevenueStandardTax"), `${key} must list only Revenue Standard Tax tables`);
  }
  for (const key of ["tax-policies", "tax-treatments", "tax-treatment-items", "tax-rates", "geo-countries", "geo-states", "tax-engines"]) assert.ok(!getBillingModule(key)!.viewOnly, `${key} must be creatable`);
});

test("policy and treatment start as Draft (lifecycle), rates default to Revenue Cloud usage", () => {
  assert.equal(getBillingModule("tax-policies")!.defaults?.Status, "Draft");
  assert.equal(getBillingModule("tax-treatments")!.defaults?.Status, "Draft");
  assert.equal(getBillingModule("tax-rates")!.defaults?.RateUsageType, "RevCloud");
});

test("every dashboard card resolves to a module (Legal Entities reuses the Billing module)", () => {
  for (const k of TAX_DASHBOARD_MODULES) assert.ok(getBillingModule(k), k);
  assert.equal(getBillingModule("legal-entities")?.candidates[0], "LegalEntity");
});

test("Tax Treatment Item create page: AI goes through the Tax Assistant for TaxTreatmentItem; examples are placeholders, never org records", () => {
  const m = getBillingModule("tax-treatment-items")!;
  assert.equal(m.aiViaTaxAssistant, true);
  assert.equal(m.candidates[0], "TaxTreatmentItem");
  assert.deepEqual(m.aiExampleLabels, ["Create tax treatment item"]);
  assert.equal(m.aiExamples.length, m.aiExampleLabels!.length);
  assert.match(m.aiExamples[0], /^Create a tax treatment item named <item name> under the existing <tax treatment> for the existing <product>\./);
  assert.doesNotMatch(m.aiExamples.join(" "), /Laptop Basic|GST18|Cloud Storage Pro|Mouse|Desktop/);
  // Revenue Cloud Billing modules keep the generic Billing AI analysis.
  for (const b of BILLING_MODULES) assert.ok(!b.aiViaTaxAssistant, `${b.key} must not use the Tax Assistant`);
});
