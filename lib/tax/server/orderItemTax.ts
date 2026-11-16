import type { SalesforceClient } from "@/lib/salesforce/client";
import { compositeAt, describeAt, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta, selectable } from "@/lib/tax/server/metadata";
import { DECISION_TABLE, effectiveRefresh } from "@/lib/tax/server/engine";
import { idList } from "@/lib/tax/server/records";
import { resolveTaxRate, type RRRate } from "@/lib/tax/server/resolution";
import { REVENUE_CLOUD_RATE_USAGE } from "@/lib/tax/server/rateRules";
import { normalizeCountry, normalizeState, type TaxGeoFacts } from "@/lib/tax/server/geography";

/**
 * ORDER PRODUCT → TAX TREATMENT — the treatment Salesforce copies to the billing schedule and the invoice line.
 *
 * Verified in p10 (order 00000131 → BS-000000018 → DOC-000000014): Salesforce does NOT derive OrderItem.TaxTreatmentId from
 * Product2.TaxPolicyId. A blank OrderItem.TaxTreatmentId makes Salesforce apply the legal entity's treatment (there: "Tax Treatment
 * for US LE", not taxable) and the invoice gets no tax, with no error log. So the treatment the product's policy selects has to be
 * resolved here and written to the Order Product BEFORE activation (an activated order's products can't be changed).
 *
 * `evaluateOrderItemTax` is pure (unit-tested); `loadOrderItemTaxFacts` reads the records it needs (SOQL SELECT only, tax API
 * version). Nothing here edits tax configuration — problems are returned as actionable issues for the admin.
 */

export interface TaxPolicyFact { id: string; name: string; status: string | null; selection: string | null; defaultTreatmentId: string | null }
export interface TaxTreatmentFact { id: string; name: string; status: string | null; taxable: boolean; legalEntityId: string | null; engineId: string | null; taxCode: string | null; productCode: string | null; useItems: boolean; policyId?: string | null }
export interface TaxEngineFact { id: string; name: string; status: string | null; type: string | null; decisionTableId: string | null }
export interface DecisionTableFact {
  id: string; name: string; hasTaxCode: boolean; engines: string[];
  /** DecisionTable.Status / RefreshStatus and the latest successful refresh (full or incremental) — absent when not read. */
  status?: string | null; refreshStatus?: string | null; refreshedAt?: string | null;
}

export interface OrderItemTaxFacts {
  productName: string;
  taxPolicyId: string | null;
  policy: TaxPolicyFact | null;
  /** The treatment the product's policy selects (Default selection → the policy's default treatment). */
  expected: TaxTreatmentFact | null;
  /** OrderItem.TaxTreatmentId as read from Salesforce (with its record when visible). */
  currentId: string | null;
  current: TaxTreatmentFact | null;
  /** Engines by Id (for the effective treatment's engine). */
  engines: Record<string, TaxEngineFact>;
  /** Tax Treatment Item tax codes by treatment Id, for this product (absent key = no item). */
  itemTaxCodes: Record<string, string | null>;
  /** Decision tables by Id (engine-assigned) plus the system table Salesforce falls back to. */
  tables: Record<string, DecisionTableFact>;
  systemTable: DecisionTableFact | null;
  /** Product2.ProductCode of the order product's product. */
  productCode?: string | null;
  /** Tax Treatment Item ProductCode by treatment Id, for this product. */
  itemProductCodes?: Record<string, string | null>;
  /** Tax Rates of the org (for the rate the decision table would match). Absent = the rate isn't checked. */
  rates?: RRRate[];
  /** INPUT columns of each decision table, by table Id (as TaxEngine.DecisionTableId / the system table hold it). */
  tableInputs?: Record<string, string[]>;
  /** LegalEntity selection: every treatment of the product's policy (the one for the order's legal entity is stamped). */
  policyTreatments?: TaxTreatmentFact[];
  /** Order.LegalEntityId (LegalEntity selection resolves the treatment from it when no OrderTaxContext is given). */
  orderLegalEntityId?: string | null;
}

/**
 * The transaction context Salesforce's invoice-time lookup uses — the order's addresses (ISO codes), legal entity and the
 * dates the rate must be effective on. Without it only the configuration chain is evaluated (e.g. right after line creation).
 */
export interface OrderTaxContext {
  addresses: { label: string; countryIso: string | null; stateIso: string | null; city: string | null; zipCode: string | null }[];
  orderLegalEntityId: string | null;
  orderItemLegalEntityId: string | null;
  /** YYYY-MM-DD: the invoice date (today) and the line's service/effective date. */
  dates: string[];
}

export type OrderItemTaxState = "set" | "will-set" | "conflict" | "not-applicable";
export interface OrderItemTaxIssue { severity: "error" | "warning" | "info"; code: string; message: string }
export interface MatchedTaxRate {
  id: string; name: string; rate: number | null; taxCode: string | null; productCode: string | null; usage: string | null; basis: string | null;
  countryIso: string | null; stateIso: string | null; legalEntityId: string | null; start: string | null; end: string | null;
}
export interface OrderItemTaxEvaluation {
  current: { id: string; name: string } | null;
  expected: { id: string; name: string } | null;
  state: OrderItemTaxState;
  /** The treatment Salesforce will apply (current, else expected) and its decision table. */
  effective: {
    treatmentId: string; taxable: boolean; engineId: string | null; decisionTable: { id: string; name: string; source: "engine" | "system" } | null; taxCode: string | null;
    treatmentName?: string; legalEntityId?: string | null; productCode?: string | null; engineName?: string | null;
    /** The product's Tax Treatment Item under this treatment (when the treatment uses items). */
    item?: { taxCode: string | null; productCode: string | null } | null;
    /** The single Tax Rate the decision table's dimensions select (local pre-validation — not Salesforce's invoice-time result). */
    rate?: MatchedTaxRate | null;
  } | null;
  issues: OrderItemTaxIssue[];
  /** The product's Tax Policy (for diagnostics). */
  policy?: { id: string; name: string; status: string | null; selection: string | null } | null;
}

/** Issue codes → the readiness category reported to the user (activation blockers). */
export type TaxReadinessCategory = "BLOCKED_CONFIGURATION" | "MISSING_TAX_RATE" | "TREATMENT_MISMATCH" | "INVALID_GEOGRAPHY" | "MISSING_SELLING_MODEL" | "TAX_RECORDS_UNREADABLE";
export function taxIssueCategory(code: string): TaxReadinessCategory {
  if (/^(MISSING_TAX_RATE|AMBIGUOUS_TAX_RATE|RATE_USAGE_INCOMPATIBLE|RATE_NOT_EFFECTIVE|PRODUCT_CODE_UNVERIFIED)$/.test(code)) return "MISSING_TAX_RATE";
  if (/^TAX_GEOGRAPHY_/.test(code)) return "INVALID_GEOGRAPHY";
  if (/^(TAX_TREATMENT_CONFLICT|TAX_TREATMENT_NOT_APPLIED|TAX_TREATMENT_NOT_SET|TAX_LEGAL_ENTITY_MISMATCH)$/.test(code)) return "TREATMENT_MISMATCH";
  if (code === "MISSING_SELLING_MODEL") return "MISSING_SELLING_MODEL";
  if (code === "TAX_RECORDS_UNREADABLE") return "TAX_RECORDS_UNREADABLE";
  return "BLOCKED_CONFIGURATION";
}

const id15 = (s: string | null | undefined) => (s ?? "").slice(0, 15);

/**
 * Pure: can Salesforce's lookup see the selected rate? The decision table is Salesforce's cached copy of the Tax Rates — a rate created
 * or changed after its last successful refresh isn't in it, and the invoice is created with no InvoiceLineTax and no error (p10:
 * TR-00000027 created 07:00 after a 05:25 refresh → DOC-000000034; TR-00000028 created 10:22 after a 09:53 refresh →
 * DOC-000000035; Salesforce's own evaluation returned No Match for both until the table was refreshed).
 */
export function decisionTableFreshnessIssues(table: DecisionTableFact, rate: { id: string; name: string; changedAt?: string | null }, rates: { id: string; name: string; changedAt?: string | null }[]): OrderItemTaxIssue[] {
  const label = `decision table ${table.name} (${table.id})`;
  if (table.status !== undefined && table.status !== "Active") return [{ severity: "error", code: "TAX_DECISION_TABLE_INACTIVE", message: `The ${label} is ${table.status ?? "not Active"} — Salesforce's tax lookup can't use it. Activate it in Setup → Lookup Tables, then refresh it.` }];
  if (table.refreshStatus !== undefined && !/^completed/i.test(table.refreshStatus ?? "")) return [{ severity: "error", code: "TAX_DECISION_TABLE_NOT_REFRESHED", message: `The ${label} refresh is ${table.refreshStatus ?? "unknown"} — it must complete before invoicing. Refresh it (an approved action) and wait for Salesforce to report Completed.` }];
  if (table.refreshedAt === undefined || !rate.changedAt) return [];
  const after = (x: { changedAt?: string | null }) => !!x.changedAt && (!table.refreshedAt || Date.parse(x.changedAt) > Date.parse(table.refreshedAt));
  if (!after(rate)) return [];
  const others = rates.filter(x => after(x) && !same(x.id, rate.id));
  return [{ severity: "error", code: "TAX_DECISION_TABLE_STALE", message: `Tax Rate ${rate.name} (${rate.id}) was created or changed at ${rate.changedAt}, after the ${label} was last refreshed (${table.refreshedAt ?? "never"}). Salesforce's lookup doesn't see it yet — the invoice would get no InvoiceLineTax (No Match).${others.length ? ` ${others.length} other rate(s) also changed since then: ${others.slice(0, 5).map(x => x.name).join(", ")}${others.length > 5 ? "…" : ""}.` : ""} Refresh ${table.name} (Taxes → Engine Readiness → approve the refresh) before activating.` }];
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && id15(a) === id15(b);

/**
 * Pure: which treatment the Order Product needs, and every reason Salesforce would not tax it. With `ctx` (the order's ISO
 * addresses, legal entity and dates) the rate the decision table would select is resolved too — the same dimension rules as the
 * Calculation tab (resolution.ts) — so activation can't pass with a configuration whose lookup finds no rate.
 */
export function evaluateOrderItemTax(f: OrderItemTaxFacts, ctx?: OrderTaxContext | null): OrderItemTaxEvaluation {
  const issues: OrderItemTaxIssue[] = [];
  const add = (severity: OrderItemTaxIssue["severity"], code: string, message: string) => issues.push({ severity, code, message });
  const p = f.productName;
  const named = (t: TaxTreatmentFact | null, id: string | null) => (t ? { id: t.id, name: t.name } : id ? { id, name: id } : null);

  let expected: TaxTreatmentFact | null = null;
  if (!f.taxPolicyId) {
    if (!f.currentId) add("warning", "TAX_POLICY_MISSING", `${p} has no Tax Policy, so the Order Product gets no Tax Treatment and Salesforce applies the legal entity's default treatment. Assign a Tax Policy to the product if it should be taxed.`);
  } else if (!f.policy) {
    add("error", "TAX_POLICY_NOT_VISIBLE", `${p}'s Tax Policy ${f.taxPolicyId} doesn't exist or isn't visible to your user.`);
  } else {
    if (f.policy.status !== "Active") add("error", "TAX_POLICY_INACTIVE", `Tax Policy "${f.policy.name}" is ${f.policy.status ?? "not Active"} — activate it in Salesforce.`);
    if (f.policy.selection === "Manual") {
      if (!f.currentId) add("error", "TAX_TREATMENT_MANUAL", `Tax Policy "${f.policy.name}" uses Manual treatment selection — set the Tax Treatment on this Order Product explicitly.`);
    } else if (f.policy.selection === "LegalEntity") {
      // Not assumed: a blank Order Product treatment made Salesforce apply a non-taxable fallback in this org (DOC-000000014), so
      // the treatment for the order's legal entity is resolved here and stamped — or the workflow is blocked when it can't be.
      const le = ctx?.orderLegalEntityId ?? f.orderLegalEntityId ?? null;
      const active = (f.policyTreatments ?? []).filter(t => t.status === "Active" && same(t.policyId, f.policy!.id));
      const byLe = le ? active.filter(t => same(t.legalEntityId, le)) : [];
      if (byLe.length === 1) expected = byLe[0];
      else if (!f.currentId) {
        if (active.length && active.every(t => !t.taxable)) add("warning", "TAX_TREATMENT_BY_LEGAL_ENTITY", `Tax Policy "${f.policy.name}" selects the treatment by legal entity and none of its active treatments is taxable — no tax applies whichever one Salesforce selects.`);
        else add("error", "TAX_TREATMENT_BY_LEGAL_ENTITY_UNRESOLVED", `Tax Policy "${f.policy.name}" selects the treatment by legal entity, and ${!le ? "the order has no Legal Entity" : byLe.length ? `${byLe.length} active treatments have the order's legal entity ${le}` : `no active treatment has the order's legal entity ${le}`}. Which treatment Salesforce would apply can't be proven (a blank Order Product treatment fell back to a non-taxable one in this org, DOC-000000014) — set the Order Product's Tax Treatment explicitly, or give the order the legal entity of exactly one active treatment of the policy.`);
      }
    } else if (!f.policy.defaultTreatmentId) {
      add("error", "TAX_DEFAULT_TREATMENT_MISSING", `Tax Policy "${f.policy.name}" has no default Tax Treatment — set one in Salesforce.`);
    } else {
      expected = f.expected;
      if (!expected) add("error", "TAX_TREATMENT_NOT_VISIBLE", `Tax Policy "${f.policy.name}" defaults to Tax Treatment ${f.policy.defaultTreatmentId}, which isn't visible to your user.`);
    }
  }

  // The treatment Salesforce will actually apply: whatever is on the Order Product, else what will be stamped.
  const effective = f.currentId ? f.current : expected;
  let state: OrderItemTaxState = "not-applicable";
  if (f.currentId && expected) {
    state = same(f.currentId, expected.id) ? "set" : "conflict";
    if (state === "conflict") {
      // Another active, taxable treatment of the SAME policy may be deliberate (kept, flagged). A non-taxable one, or one from
      // another policy, is what a blank/fallback assignment looks like (DOC-000000014) — never silently billed.
      const related = !!f.current && f.current.taxable && f.current.status === "Active" && !!f.current.policyId && same(f.current.policyId, f.policy?.id);
      add(related ? "warning" : "error", "TAX_TREATMENT_CONFLICT", `This Order Product uses Tax Treatment "${f.current?.name ?? f.currentId}", but ${p}'s Tax Policy "${f.policy?.name ?? "—"}" defaults to "${expected.name}".${related ? " Both belong to that policy; the existing value is kept." : ` "${f.current?.name ?? f.currentId}" ${f.current && !f.current.taxable ? "isn't taxable" : "belongs to another tax policy"} — remove the order product and add it again (an Order Product's treatment is never overwritten automatically).`}`);
    }
  } else if (f.currentId) state = "set";
  else if (expected) state = "will-set";

  let decisionTable: NonNullable<OrderItemTaxEvaluation["effective"]>["decisionTable"] = null;
  let taxCode: string | null = null;
  if (effective) {
    const t = effective;
    if (t.status !== "Active") add("error", "TAX_TREATMENT_INACTIVE", `Tax Treatment "${t.name}" is ${t.status ?? "not Active"} — Salesforce rejects or ignores an inactive treatment.`);
    if (!t.taxable) add("warning", "TAX_TREATMENT_NOT_TAXABLE", `Tax Treatment "${t.name}" is not taxable — Salesforce applies no tax to ${p}.`);
    else {
      if (t.useItems && !(t.id in f.itemTaxCodes)) add("error", "TAX_TREATMENT_ITEM_MISSING", `Tax Treatment "${t.name}" uses Tax Treatment Items and has none for ${p} — create the item for this product.`);
      taxCode = (t.useItems ? f.itemTaxCodes[t.id] : null) ?? t.taxCode ?? null;
      // p10: every taxable treatment without a Legal Entity got TaxAmount 0 and no InvoiceLineTax (DOC-000000011/12/15/16); the
      // same configuration with it produced tax (DOC-000000013/17). LegalEntityId is locked once a treatment leaves Draft.
      if (!t.legalEntityId) add("error", "TAX_TREATMENT_LEGAL_ENTITY_MISSING", `Tax Treatment "${t.name}" has no Legal Entity. In this org every taxable treatment without one produced no InvoiceLineTax. TaxTreatment.LegalEntityId can't be edited once the treatment is Active or Inactive — create a Draft treatment with the legal entity, activate it and make it the policy's default treatment.`);
      else if (ctx?.orderLegalEntityId && !same(ctx.orderLegalEntityId, t.legalEntityId)) add("error", "TAX_LEGAL_ENTITY_MISMATCH", `Order.LegalEntityId ${ctx.orderLegalEntityId} differs from Tax Treatment "${t.name}"'s Legal Entity ${t.legalEntityId}.`);
      else if (ctx?.orderItemLegalEntityId && !same(ctx.orderItemLegalEntityId, t.legalEntityId)) add("error", "TAX_LEGAL_ENTITY_MISMATCH", `OrderItem.LegalEntityId ${ctx.orderItemLegalEntityId} differs from Tax Treatment "${t.name}"'s Legal Entity ${t.legalEntityId}.`);
      const engine = t.engineId ? f.engines[t.engineId] ?? null : null;
      if (!t.engineId) add("error", "TAX_ENGINE_MISSING", `Taxable Tax Treatment "${t.name}" has no Tax Engine.`);
      else if (!engine) add("error", "TAX_ENGINE_NOT_VISIBLE", `Tax Engine ${t.engineId} of treatment "${t.name}" isn't visible to your user.`);
      else {
        if (engine.status !== "Active") add("error", "TAX_ENGINE_INACTIVE", `Tax Engine "${engine.name}" is ${engine.status ?? "not Active"}.`);
        const own = engine.decisionTableId ? f.tables[engine.decisionTableId] ?? null : null;
        const table = own ?? (engine.decisionTableId ? null : f.systemTable);
        decisionTable = table ? { id: table.id, name: table.name, source: own ? "engine" : "system" } : null;
        if (!engine.decisionTableId) {
          // The intended table (RevenueStandardTaxWithTaxCode) first, then any other table with a TaxCode input.
          const candidates = [...new Map(Object.values(f.tables).filter(x => x.hasTaxCode).map(x => [id15(x.id), x])).values()].sort((x, y) => Number(y.name === "RevenueStandardTaxWithTaxCode") - Number(x.name === "RevenueStandardTaxWithTaxCode"));
          const fix = candidates.length
            ? ` Expected decision table: ${candidates[0].name} (${candidates[0].id}). Required change (admin, not automatic): set TaxEngine.DecisionTableId on "${engine.name}" to ${candidates.map(c => `${c.name} (${c.id}${c.engines.length ? `, already used by ${c.engines.join(", ")}` : ""})`).join(" or ")} — every treatment on this engine would then use that table — or move the treatment to an engine that already has it.`
            : " Required change (admin): give the engine a Revenue Standard Tax decision table with a TaxCode input (Lookup Tables → clone Revenue Standard Tax Entries, add Tax Code, activate, refresh) and set it as the engine's Decision Table.";
          if (taxCode && f.systemTable && !f.systemTable.hasTaxCode) add("error", "TAX_ENGINE_DECISION_TABLE_MISSING", `Tax Engine "${engine.name}" has no Decision Table, so Salesforce uses the system table ${f.systemTable.name}, which has no TaxCode input — a lookup that includes tax code ${taxCode} fails on that table (Salesforce's evaluation returns UNKNOWN_EXCEPTION for a condition on a column the table lacks).${fix}`);
          else add("warning", "TAX_ENGINE_DECISION_TABLE_MISSING", `Tax Engine "${engine.name}" has no Decision Table; Salesforce falls back to the system table ${f.systemTable?.name ?? DECISION_TABLE}.${fix}`);
        } else if (!own) add("error", "TAX_DECISION_TABLE_NOT_VISIBLE", `Decision table ${engine.decisionTableId} of engine "${engine.name}" isn't visible to your user.`);
        else if (taxCode && !own.hasTaxCode) add("error", "TAX_DECISION_TABLE_NO_TAXCODE", `Decision table ${own.name} (engine "${engine.name}") has no TaxCode input, so the rate for tax code ${taxCode} can't match.`);
      }
    }
  }
  let rate: MatchedTaxRate | null = null;
  // The decision table's ProductCode input is Product2.ProductCode (E1-B ₹0 with a rate keyed to the treatment's code; E1c ₹1,800
  // with the rate keyed to the product's code). The item's/treatment's ProductCode is shown, never used for matching.
  const itemProductCode = effective?.useItems ? f.itemProductCodes?.[effective.id] ?? null : null;
  const lineProductCode = f.productCode ?? null;
  if (effective?.taxable && effective.useItems && itemProductCode && f.productCode && itemProductCode !== f.productCode)
    add("warning", "TAX_ITEM_PRODUCT_CODE_UNVERIFIED", `${p}: its Tax Treatment Item's Product Code "${itemProductCode}" differs from the product's code "${f.productCode}". The rate lookup is checked with "${f.productCode}" (proven for treatments without items); which code Salesforce uses for item-based treatments isn't verified yet (E5).`);
  // Only a usable table is evaluated: with an engine/table error (no table, StandardTax without TaxCode…) Salesforce's lookup fails
  // outright, so no rate is ever reported as "selected".
  const tableBlocked = issues.some(i => i.severity === "error" && /^TAX_(ENGINE|DECISION_TABLE)/.test(i.code));
  if (effective?.taxable && effective.status === "Active" && ctx && f.rates && decisionTable && !tableBlocked) {
    const inputs = f.tableInputs?.[decisionTable.id] ?? null;
    rate = evaluateRate(add, { name: p, treatment: effective, taxCode, productCode: f.productCode ?? null, rates: f.rates, inputs, ctx, tableName: decisionTable.name });
    const table = decisionTable.source === "engine" ? Object.values(f.tables).find(x => same(x.id, decisionTable!.id)) ?? null : f.systemTable;
    const selected = rate ? f.rates.find(x => same(x.id, rate!.id)) ?? null : null;
    if (table && selected) for (const i of decisionTableFreshnessIssues(table, selected, f.rates)) add(i.severity, i.code, i.message);
  }
  return {
    current: named(f.current, f.currentId), expected: named(expected, null), state,
    effective: effective ? { treatmentId: effective.id, taxable: effective.taxable, engineId: effective.engineId, decisionTable, taxCode, treatmentName: effective.name, legalEntityId: effective.legalEntityId, productCode: lineProductCode, rate,
      engineName: effective.engineId ? f.engines[effective.engineId]?.name ?? null : null,
      item: effective.useItems && effective.id in f.itemTaxCodes ? { taxCode: f.itemTaxCodes[effective.id], productCode: f.itemProductCodes?.[effective.id] ?? null } : null } : null,
    issues,
    policy: f.policy ? { id: f.policy.id, name: f.policy.name, status: f.policy.status, selection: f.policy.selection } : null,
  };
}

const toMatched = (r: RRRate): MatchedTaxRate => ({ id: r.id, name: r.name, rate: r.rate, taxCode: r.taxCode, productCode: r.productCode, usage: r.usage, basis: r.basis, countryIso: r.countryIso, stateIso: r.stateIso, legalEntityId: r.legalEntityId, start: r.start, end: r.end });

/**
 * The rate Salesforce's invoice-time lookup would select, for every order address and date, using the shared resolver with the
 * PRODUCT's code as the ProductCode input (proven: E1-B / E1c / E2). none → blocked (Salesforce produced ₹0 for E1-B), multiple →
 * blocked (Salesforce's evaluation returns Multiple Matches, e.g. a blank-ProductCode rate overlapping a product-specific one).
 */
function evaluateRate(add: (s: OrderItemTaxIssue["severity"], c: string, m: string) => void,
  a: { name: string; treatment: TaxTreatmentFact; taxCode: string | null; productCode: string | null; rates: RRRate[]; inputs: string[] | null; ctx: OrderTaxContext; tableName: string }): MatchedTaxRate | null {
  const usable = a.ctx.addresses.filter(x => x.countryIso);
  if (!usable.length) { add("warning", "TAX_RATE_NOT_CHECKED", `${a.name}: the tax rate can't be checked until the order has a billing/shipping country that maps to a GeoCountry ISO code.`); return null; }
  const dates = [...new Set(a.ctx.dates)];
  let chosen: RRRate | null = null;
  for (const addr of usable) for (const date of dates) {
    const pc = a.productCode;
    const r = resolveTaxRate(a.rates, { taxCode: a.taxCode, countryIso: addr.countryIso, stateIso: addr.stateIso, city: addr.city, zipCode: addr.zipCode, productCode: pc, legalEntityId: a.treatment.legalEntityId, effectiveDate: date, rateUsageType: REVENUE_CLOUD_RATE_USAGE, applicationBasis: null }, a.inputs);
    const where = `${addr.label} ${[addr.countryIso, addr.stateIso].filter(Boolean).join("/")}, tax code ${a.taxCode ?? "—"}${pc ? `, product code ${pc}` : ""}, legal entity ${a.treatment.legalEntityId ?? "—"}, ${date}`;
    if (r.outcome === "multiple") { add("error", "AMBIGUOUS_TAX_RATE", `${a.name}: ${r.candidates.length} ${REVENUE_CLOUD_RATE_USAGE} rates match ${where} in decision table ${a.tableName} (${r.candidates.map(m => `${m.rate.name} ${m.rate.rate ?? "?"}%${m.wildcard.length ? ` — blank = any: ${m.wildcard.join(", ")}` : ""}`).join("; ")}). Salesforce's lookup returns Multiple Matches — make one dimension distinct (e.g. a product-specific Product Code) or end-date one.`); return null; }
    if (r.status === "none") {
      // From ALL rates (resolveTaxRate keeps only the first near misses): a rate with this tax code but another usage type / dates.
      const sameCode = a.rates.filter(x => !a.taxCode || x.taxCode === a.taxCode);
      const usageRate = sameCode.find(x => (x.usage ?? "").toLowerCase() !== REVENUE_CLOUD_RATE_USAGE.toLowerCase());
      const usage = usageRate && !sameCode.some(x => (x.usage ?? "").toLowerCase() === REVENUE_CLOUD_RATE_USAGE.toLowerCase()) ? { rate: usageRate } : null;
      const dated = r.nearMisses.find(n => /^not effective/.test(n.reason) && (!a.taxCode || n.rate.taxCode === a.taxCode));
      const closest = r.nearMisses.slice(0, 3).map(n => `${n.rate.name} (${n.reason})`).join("; ");
      if (usage) add("error", "RATE_USAGE_INCOMPATIBLE", `${a.name}: no ${REVENUE_CLOUD_RATE_USAGE} tax rate matches ${where}. Rate ${usage.rate.name} has the tax code but Rate Usage Type "${usage.rate.usage ?? "—"}" — Revenue Cloud invoices look up "${REVENUE_CLOUD_RATE_USAGE}" (the decision table returns No Match). Replace it with a ${REVENUE_CLOUD_RATE_USAGE} / Net rate carrying the country, state, legal entity and start date.`);
      else if (dated) add("error", "RATE_NOT_EFFECTIVE", `${a.name}: the tax rate for ${where} isn't effective — ${dated.rate.name} ${dated.reason}.`);
      else add("error", "MISSING_TAX_RATE", `${a.name}: no effective ${REVENUE_CLOUD_RATE_USAGE} tax rate matches ${where} in decision table ${a.tableName}.${closest ? ` Closest: ${closest}.` : ""}`);
      return null;
    }
    const r1 = r.selected!;
    if (chosen && chosen.id !== r1.id) { add("error", "AMBIGUOUS_TAX_RATE", `${a.name}: the billing and shipping addresses select different rates (${chosen.name}, ${r1.name}); Salesforce's choice of address for the lookup isn't verified — use one geography.`); return null; }
    chosen = r1;
  }
  if (chosen && chosen.basis && chosen.basis !== "Net") add("warning", "RATE_BASIS_UNVERIFIED", `${a.name}: rate ${chosen.name} uses Application Basis "${chosen.basis}" (tax-inclusive). Only Net has been verified to produce InvoiceLineTax in this org.`);
  return chosen ? toMatched(chosen) : null;
}

const s = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Read-only: the tax facts for each Order Product (key → product, its Tax Policy, the treatment already on the line). Returns
 * null when this org has no tax objects (then no tax checks apply).
 */
export async function loadOrderItemTaxFacts(client: SalesforceClient, rows: { key: string; productId: string | null; productName: string; taxPolicyId: string | null; currentTreatmentId: string | null; productCode?: string | null; orderLegalEntityId?: string | null }[]): Promise<Map<string, OrderItemTaxFacts> | null> {
  // A metadata failure is an error (the caller blocks on it) — only a successfully read org WITHOUT tax objects means "no tax".
  const meta = await discoverTaxMetadata(client);
  if (!objectMeta(meta, "TaxPolicy") || !objectMeta(meta, "TaxTreatment")) return null;
  const v = meta.apiVersion;
  const q = (soql: string) => queryAt(client, v, soql);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];

  const policyIds = uniq(rows.map(r => r.taxPolicyId));
  const policies = policyIds.length ? await q(`SELECT Id, Name, Status, TreatmentSelection, DefaultTaxTreatmentId FROM TaxPolicy WHERE Id IN (${idList(policyIds)})`) : [];
  const treatmentIds = uniq([...policies.map(p => s(p.DefaultTaxTreatmentId)), ...rows.map(r => r.currentTreatmentId)]);
  // LegalEntity-selection policies: all their treatments (the order's legal entity picks one).
  const lePolicyIds = policies.filter(p => p.TreatmentSelection === "LegalEntity").map(p => p.Id as string);
  const where = [treatmentIds.length ? `Id IN (${idList(treatmentIds)})` : null, lePolicyIds.length ? `TaxPolicyId IN (${idList(lePolicyIds)})` : null].filter(Boolean).join(" OR ");
  const treatments = where ? await q(`SELECT Id, Name, Status, IsTaxable, LegalEntityId, TaxEngineId, TaxCode, ProductCode, ShouldUseTaxTreatmentItems, TaxPolicyId FROM TaxTreatment WHERE ${where}`) : [];
  const productIds = uniq(rows.map(r => r.productId));
  const items = objectMeta(meta, "TaxTreatmentItem") && treatments.length && productIds.length
    ? await q(`SELECT TaxTreatmentId, ProductId, TaxCode, ProductCode FROM TaxTreatmentItem WHERE TaxTreatmentId IN (${idList(treatments.map(t => t.Id as string))}) AND ProductId IN (${idList(productIds)})`)
    : [];
  // Every engine with a decision table (to name the table a mis-configured engine could use, and who already shares it).
  // Salesforce errors propagate: an unreadable engine/table/rate must never look like "nothing configured".
  const engineRows = objectMeta(meta, "TaxEngine") ? await q(`SELECT Id, TaxEngineName, Status, Type, DecisionTableId FROM TaxEngine WHERE Id IN (${idList(uniq(treatments.map(t => s(t.TaxEngineId))).concat("000000000000000"))}) OR DecisionTableId != null`) : [];
  const tableIds = uniq(engineRows.map(e => s(e.DecisionTableId)));
  const tableRows = await q(`SELECT Id, DeveloperName, Status, RefreshStatus, LastSyncDate, LastIncrementalSyncDate, HasIncrementalSyncFailed FROM DecisionTable WHERE DeveloperName = '${DECISION_TABLE}'${tableIds.length ? ` OR Id IN (${idList(tableIds)})` : ""}`);
  const inputParams = tableRows.length ? await q(`SELECT DecisionTableId, FieldName FROM DecisionTableParameter WHERE Usage = 'INPUT' AND DecisionTableId IN (${idList(tableRows.map(t => t.Id as string))})`) : [];
  const taxable = treatments.some(t => t.IsTaxable === true);
  const rateCols = selectable(meta, "TaxRate", ["Name", "TaxCode", "Rate", "GeoCountry.IsoCode", "GeoState.IsoCode", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis", "StartDate", "EndDate", "Priority", "LastModifiedDate"]);
  const rateRows = taxable && objectMeta(meta, "TaxRate") ? await q(`SELECT Id, ${rateCols.join(", ")} FROM TaxRate ORDER BY CreatedDate LIMIT 2000`) : [];
  const iso = (r: Record<string, unknown>, k: string) => s((r[k] as Record<string, unknown> | null)?.IsoCode)?.toUpperCase() ?? null;
  const num = (x: unknown) => (typeof x === "number" ? x : null);
  const rates: RRRate[] = rateRows.map(r => ({
    id: r.Id as string, name: String(r.Name ?? r.Id), taxCode: s(r.TaxCode), rate: num(r.Rate), countryIso: iso(r, "GeoCountry"), stateIso: iso(r, "GeoState"), city: s(r.City), zipCode: s(r.ZipCode),
    productCode: s(r.ProductCode), legalEntityId: s(r.LegalEntityId), usage: s(r.RateUsageType), basis: s(r.ApplicationBasis), start: s(r.StartDate), end: s(r.EndDate), priority: num(r.Priority), changedAt: s(r.LastModifiedDate),
  }));

  const policy = (r: Record<string, unknown>): TaxPolicyFact => ({ id: r.Id as string, name: String(r.Name), status: s(r.Status), selection: s(r.TreatmentSelection), defaultTreatmentId: s(r.DefaultTaxTreatmentId) });
  const treatment = (r: Record<string, unknown>): TaxTreatmentFact => ({ id: r.Id as string, name: String(r.Name), status: s(r.Status), taxable: r.IsTaxable === true, legalEntityId: s(r.LegalEntityId), engineId: s(r.TaxEngineId), taxCode: s(r.TaxCode), productCode: s(r.ProductCode), useItems: r.ShouldUseTaxTreatmentItems === true, policyId: s(r.TaxPolicyId) });
  const engines: Record<string, TaxEngineFact> = {};
  for (const e of engineRows) engines[e.Id as string] = { id: e.Id as string, name: String(e.TaxEngineName ?? e.Id), status: s(e.Status), type: s(e.Type), decisionTableId: s(e.DecisionTableId) };
  const tables: Record<string, DecisionTableFact> = {};
  const tableInputs: Record<string, string[]> = {};
  let systemTable: DecisionTableFact | null = null;
  for (const t of tableRows) {
    const inputs = inputParams.filter(p => same(s(p.DecisionTableId), t.Id as string)).map(p => String(p.FieldName));
    const fact: DecisionTableFact = { id: t.Id as string, name: String(t.DeveloperName), hasTaxCode: inputs.includes("TaxCode"), engines: Object.values(engines).filter(e => same(e.decisionTableId, t.Id as string)).map(e => e.name),
      status: s(t.Status), refreshStatus: s(t.RefreshStatus), refreshedAt: effectiveRefresh(s(t.LastSyncDate), s(t.LastIncrementalSyncDate), t.HasIncrementalSyncFailed === true) };
    if (t.DeveloperName === DECISION_TABLE) { systemTable = fact; tableInputs[fact.id] = inputs; }
    // Keyed by the Id exactly as TaxEngine.DecisionTableId holds it.
    for (const id of tableIds) if (same(id, t.Id as string)) { tables[id] = fact; tableInputs[id] = inputs; }
  }
  const byId = <T extends { id: string }>(xs: T[], id: string | null) => (id ? xs.find(x => same(x.id, id)) ?? null : null);
  const P = policies.map(policy), T = treatments.map(treatment);

  const out = new Map<string, OrderItemTaxFacts>();
  for (const r of rows) {
    const pol = byId(P, r.taxPolicyId);
    const itemTaxCodes: Record<string, string | null> = {};
    const itemProductCodes: Record<string, string | null> = {};
    for (const i of items) if (same(s(i.ProductId), r.productId)) { const t = byId(T, s(i.TaxTreatmentId)); if (t) { itemTaxCodes[t.id] = s(i.TaxCode); itemProductCodes[t.id] = s(i.ProductCode); } }
    out.set(r.key, { productName: r.productName, taxPolicyId: r.taxPolicyId, policy: pol, expected: byId(T, pol?.defaultTreatmentId ?? null), currentId: r.currentTreatmentId, current: byId(T, r.currentTreatmentId), engines, itemTaxCodes, tables, systemTable, productCode: r.productCode ?? null, itemProductCodes, rates, tableInputs,
      policyTreatments: pol?.selection === "LegalEntity" ? T.filter(t => same(t.policyId, pol.id)) : undefined, orderLegalEntityId: r.orderLegalEntityId ?? null });
  }
  return out;
}

/**
 * Write the policy-selected Tax Treatment on freshly created (Draft) Order Products that have none — one all-or-nothing Composite
 * request, never overwriting an existing value. Anything that keeps Salesforce from taxing a line is returned as an issue (the
 * billing activation readiness blocks on the same evaluation), so creation itself is never silently "fine".
 */
export async function stampOrderItemTaxTreatments(client: SalesforceClient, lines: { orderItemId: string; productId: string; productName: string }[]): Promise<{ applied: { orderItemId: string; treatmentId: string; treatmentName: string }[]; issues: OrderItemTaxIssue[]; skipped: string | null }> {
  if (!lines.length) return { applied: [], issues: [], skipped: null };
  // The tax API version (the org's newest), not the caller's client version: the orders routes run at v62, and the tax objects and
  // fields this reads/writes are only guaranteed at the version the rest of the tax module uses.
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const q = (soql: string) => queryAt(client, v, soql);
  const oi = await describeAt(client, v, "OrderItem");
  if (!oi) return { applied: [], issues: [], skipped: "The Order Product describe couldn't be read at the tax API version." };
  const field = oi.fields.find(x => x.type === "reference" && x.referenceTo?.includes("TaxTreatment") && x.updateable);
  if (!field) return { applied: [], issues: [], skipped: "This org's Order Product has no updateable Tax Treatment field." };
  const prod = await describeAt(client, v, "Product2");
  const ord = await describeAt(client, v, "Order");
  const orderLe = ord?.fields.some(x => x.name === "LegalEntityId") ? "Order.LegalEntityId" : null;
  const policyField = prod?.fields.find(x => x.type === "reference" && x.referenceTo?.includes("TaxPolicy"))?.name ?? null;
  const productIds = [...new Set(lines.map(l => l.productId))];
  const products = policyField ? await q(`SELECT Id, ${policyField} FROM Product2 WHERE Id IN (${idList(productIds)})`) : [];
  const current = await q(`SELECT Id, ${field.name}${orderLe ? `, ${orderLe}` : ""} FROM OrderItem WHERE Id IN (${idList(lines.map(l => l.orderItemId))})`);
  const row = (id: string) => current.find(c => same(c.Id as string, id));
  const facts = await loadOrderItemTaxFacts(client, lines.map(l => ({
    key: l.orderItemId, productId: l.productId, productName: l.productName,
    taxPolicyId: policyField ? s(products.find(p => same(p.Id as string, l.productId))?.[policyField]) : null,
    currentTreatmentId: s(row(l.orderItemId)?.[field.name]),
    orderLegalEntityId: s((row(l.orderItemId)?.Order as Record<string, unknown> | null | undefined)?.LegalEntityId),
  })));
  if (!facts) return { applied: [], issues: [], skipped: "This org has no Revenue Cloud tax objects." };
  const issues: OrderItemTaxIssue[] = [];
  const targets: { orderItemId: string; treatmentId: string; treatmentName: string }[] = [];
  for (const l of lines) {
    const ev = evaluateOrderItemTax(facts.get(l.orderItemId)!);
    issues.push(...ev.issues.map(i => ({ ...i, message: `${l.productName}: ${i.message}` })));
    if (ev.state === "will-set" && ev.expected) targets.push({ orderItemId: l.orderItemId, treatmentId: ev.expected.id, treatmentName: ev.expected.name });
  }
  if (!targets.length) return { applied: [], issues, skipped: null };
  const res = await compositeAt(client, v, targets.map((t, i) => ({ method: "PATCH" as const, url: `/sobjects/OrderItem/${t.orderItemId}`, referenceId: `tax_${i}`, body: { [field.name]: t.treatmentId } })));
  if (!res.ok) {
    const msg = res.errors.map(e => `${e.errorCode ?? ""} ${e.message ?? ""}`.trim()).filter(Boolean).join("; ");
    return { applied: [], issues: [...issues, { severity: "error", code: "TAX_TREATMENT_NOT_APPLIED", message: `Salesforce rejected setting the Tax Treatment on the Order Product(s): ${msg || "unknown error"}. Nothing was changed.` }], skipped: null };
  }
  return { applied: targets, issues, skipped: null };
}

/* ───────────── Transaction geography ───────────── */

export type { TaxGeoFacts } from "@/lib/tax/server/geography";

/**
 * Pure: is an order address usable for Revenue Standard Tax? The decision table compares Country/State as exact values — in p10
 * "IN"/"AP" match TR-00000019 while "India"/"Andhra Pradesh" return No Match from Salesforce's own evaluation, and the invoice
 * with the names (DOC-000000014) got no tax. So a name where the code is needed is an error with the exact value to use.
 */
export function evaluateTaxGeography(label: string, address: { country: string | null; state: string | null }, geo: TaxGeoFacts): OrderItemTaxIssue[] {
  const issues: OrderItemTaxIssue[] = [];
  const country = address.country?.trim() || null, state = address.state?.trim() || null;
  if (!country) { issues.push({ severity: "error", code: "TAX_GEOGRAPHY_MISSING", message: `${label} Country is blank — the tax decision table requires Country.` }); return issues; }
  const match = normalizeCountry(country, geo), c = match?.known ? match : null;
  if (!c) issues.push({ severity: "error", code: "TAX_GEOGRAPHY_UNKNOWN", message: `${label} Country "${country}" has no GeoCountry record in this org — no tax rate can match it.` });
  else if (country !== c.iso) issues.push({ severity: "error", code: "TAX_GEOGRAPHY_NOT_CODE", message: `${label} Country is "${country}" — set it to the ISO code "${c.iso}". Salesforce's tax decision table compares the exact value, and "${country}" doesn't match a rate for ${c.iso}.` });
  if (state) {
    const match = normalizeState(state, c?.iso ?? null, geo), st = match?.known ? match : null;
    if (st && state !== st.iso) issues.push({ severity: "error", code: "TAX_GEOGRAPHY_NOT_CODE", message: `${label} State is "${state}" — set it to the code "${st.iso}". Salesforce's tax decision table compares the exact value, and "${state}" doesn't match a rate for ${st.iso}.` });
  }
  return issues;
}

/**
 * Pure: an order address as the decision table's Country/State inputs, resolved through the org's GeoCountry/GeoState records.
 * A name ("Andhra Pradesh") still resolves here so the RATE can be checked — evaluateTaxGeography separately blocks the name,
 * because Salesforce compares the exact stored value.
 */
export function taxAddress(label: string, a: { country: string | null; state: string | null; city?: string | null; postalCode?: string | null } | null, geo: TaxGeoFacts | null): OrderTaxContext["addresses"][number] | null {
  if (!a || !geo) return null;
  const cm = normalizeCountry(a.country, geo), c = cm?.known ? cm : null;
  const sm = normalizeState(a.state, c?.iso ?? null, geo), st = sm?.known ? sm : null;
  return { label, countryIso: c?.iso ?? null, stateIso: st?.iso ?? (a.state?.trim() ? a.state.trim().toUpperCase() : null), city: a.city?.trim() || null, zipCode: a.postalCode?.trim() || null };
}

/** Read-only: GeoCountry / GeoState codes (tax API version). Null when the org has no GeoCountry object. */
export async function loadTaxGeoFacts(client: SalesforceClient): Promise<TaxGeoFacts | null> {
  const meta = await discoverTaxMetadata(client);
  if (!objectMeta(meta, "GeoCountry")) return null;
  const countries = await queryAt(client, meta.apiVersion, "SELECT Name, IsoCode FROM GeoCountry");
  const states = objectMeta(meta, "GeoState") ? await queryAt(client, meta.apiVersion, "SELECT Name, IsoCode, GeoCountry.IsoCode FROM GeoState") : [];
  return {
    countries: countries.filter(x => s(x.IsoCode)).map(x => ({ name: String(x.Name), iso: String(x.IsoCode) })),
    states: states.filter(x => s(x.IsoCode)).map(x => ({ name: String(x.Name), iso: String(x.IsoCode), countryIso: s((x.GeoCountry as Record<string, unknown> | null)?.IsoCode) })),
  };
}
