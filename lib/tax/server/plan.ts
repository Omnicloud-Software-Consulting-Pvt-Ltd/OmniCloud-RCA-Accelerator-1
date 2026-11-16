import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { discoverTaxMetadata, hasField, objectMeta, picklist, picklistValue } from "@/lib/tax/server/metadata";
import { getTaxConnection, loadSnapshot, NATIVE_ENGINE_TYPES, productsByPolicy, resolveProductRef, type ProductResolution, type TaxSnapshot } from "@/lib/tax/server/records";
import { resolveCountry, type ResolvedCountry } from "@/lib/tax/server/country";
import { getTaxAdminStatus, TAX_ADMIN_MISSING } from "@/lib/tax/server/admin";
import { rateOverlap, REVENUE_CLOUD_RATE_USAGE, type RateKey } from "@/lib/tax/server/rateRules";
import type { LegalEntityRow, PlanIssue, PlanStep, ProductRow, RecordRef, StepPhase, TaxConfigSpec, TaxConnection, TaxPlan, TaxPolicyRow, TaxRateRow, TaxTreatmentRow, TaxTreatmentSpec } from "@/lib/tax/types";

/**
 * TAX CONFIGURATION PLANNER — decides, without writing anything, which Salesforce records a TaxConfigSpec needs, in dependency
 * order, reusing every equivalent record that already exists (idempotency) and validating every object, field, picklist value,
 * relationship and reference against the connected org's metadata.
 *
 *   Tax Engine (native Revenue Standard Tax, or an external engine with its provider)
 *     → Legal Entity (resolved, never created)  → GeoCountry (created only when the tax country has none)
 *     → Tax Rate per tax code + country + legal entity (the "tax code" records of Revenue Standard Tax)
 *     → Tax Policy (Draft) → Tax Treatment(s) (Draft) → Tax Treatment Items
 *     → activate treatments → set the policy's default treatment and activate it
 *     → Product2 tax policy mapping.
 *
 * There is no TaxCode object in Revenue Cloud: tax codes are values on TaxRate / TaxTreatment / TaxTreatmentItem. A requested tax
 * code is resolved against the org's Revenue Cloud tax rates; a code that doesn't exist is created only when its rate is given
 * (TaxRate is createable) — otherwise the plan stops with the existing codes listed.
 *
 * Revenue Standard Tax matching: the engine's decision table matches rates by TaxCode, geography, legal entity, dates and
 * ProductCode — and the ProductCode it receives is the PRODUCT's own code (Product2.ProductCode). Proven in p10: a rate keyed to the
 * treatment's code produced no InvoiceLineTax (E1-B); the same rate keyed to the product's code did (E1c, ₹1,800 on ₹10,000).
 *  · Default: one rate per product, ProductCode = Product2.ProductCode (a product without a code is blocked).
 *  · rateDefaults.productCodeMode "blank" (explicit only): one rate with a blank ProductCode, matching every product with that tax
 *    code in the geography (E2: ₹188.82 on ₹1,049, treatment without items). Products sharing the code are listed, item-based
 *    treatments are flagged unverified, and any rate it would ALWAYS collide with blocks the plan (Multiple Matches).
 *  · Tax Treatment Items carry the product's code as ProductCode (as in DOC-13/17, which produced tax).
 * Rates are written with RateUsageType RevCloud and an explicit ApplicationBasis (Net) — never Salesforce's Commerce/Gross defaults.
 * Creating a rate makes the engine's decision table stale: the plan says so (refreshRequired) — the refresh itself is a separate,
 * approved step, and invoicing is blocked until a successful refresh is newer than the rate.
 */

export interface PlanContext {
  snapshot: TaxSnapshot;
  spec: TaxConfigSpec;
  products: Map<string, ProductResolution>;
  connection: TaxConnection;
  today: string;
  taxAdminMissing: boolean;
  /** Products already mapped (through their tax policy's treatments) to each tax code — who a blank-ProductCode rate would reach. */
  productsByTaxCode?: Record<string, { name: string; code: string | null; viaItems: boolean }[]>;
}

/** Composite (all-or-none) accepts at most 25 sub-requests per phase. */
const MAX_PER_PHASE = 25;

export const productKey = (r: RecordRef) => (r.id ? `id:${r.id}` : `name:${(r.name ?? "").trim().toLowerCase()}`);
export function allProductRefs(spec: TaxConfigSpec): RecordRef[] {
  const seen = new Map<string, RecordRef>();
  for (const r of [...spec.products.map(p => p.product), ...spec.items.map(i => i.product)]) if (!seen.has(productKey(r))) seen.set(productKey(r), r);
  return [...seen.values()];
}

const eqi = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const sameRate = (a: number | null | undefined, b: number | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) < 0.0001;
const ref = (stepId: string) => `@{${stepId}}`;
const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("@{");
const deriveCode = (taxName: string | null | undefined, rate: number) => `${(taxName ?? "TAX").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8) || "TAX"}${String(rate).replace(".", "_")}`;

type Code = { code: string; rate: number };
interface Desired { spec: TaxTreatmentSpec; code: Code | null; le: LegalEntityRow | null }

export function buildPlan(ctx: PlanContext): TaxPlan {
  const { snapshot: snap, spec } = ctx;
  const meta = snap.meta;
  const issues: PlanIssue[] = [];
  const steps: PlanStep[] = [];
  const error = (code: string, message: string, extra: Partial<PlanIssue> = {}) => { issues.push({ severity: "error", code, message, ...extra }); };
  const warn = (code: string, message: string, extra: Partial<PlanIssue> = {}) => { issues.push({ severity: "warning", code, message, ...extra }); };
  const info = (code: string, message: string) => { issues.push({ severity: "info", code, message }); };
  for (const p of meta.problems) error("MISSING_OBJECT", p);
  const rel = (from: string, to: string) => meta.relationships[`${from}→${to}`] ?? null;

  const need = (obj: string, mode: "create" | "update"): boolean => {
    const o = objectMeta(meta, obj);
    if (!o) { error("MISSING_OBJECT", `${obj} doesn't exist in this org (API ${meta.apiVersion}). Tax objects available: ${meta.availableTaxObjects.join(", ") || "none"}.`, { object: obj }); return false; }
    if (mode === "create" && !o.createable) { error("NOT_CREATEABLE", `The current Salesforce user can't create ${o.label} (${obj}) records.`, { object: obj, action: "Assign the Tax Admin permission set (Tax → Engine Readiness)." }); return false; }
    if (mode === "update" && !o.updateable) { error("NOT_UPDATEABLE", `The current Salesforce user can't edit ${o.label} (${obj}) records.`, { object: obj }); return false; }
    return true;
  };
  /** Build a payload from metadata: unknown fields, read-only fields, invalid picklist values and missing required fields are issues. */
  const payload = (obj: string, mode: "create" | "update", entries: [string | null, unknown, { required?: boolean; label?: string }?][]): Record<string, unknown> => {
    const o = objectMeta(meta, obj);
    const out: Record<string, unknown> = {};
    if (!o) return out;
    for (const [f, v, opt] of entries) {
      const empty = v === null || v === undefined || v === "";
      if (!f) { if (!empty || opt?.required) error("INVALID_FIELD", `${o.label} has no ${opt?.label ?? "relationship"} field in this org's metadata.`, { object: obj }); continue; }
      const fm = o.fields[f];
      if (empty) { if (opt?.required) error("REQUIRED_FIELD_MISSING", `${o.label}: ${fm?.label ?? f} (${f}) is required but has no value.`, { object: obj, field: f }); continue; }
      if (!fm) { error("INVALID_FIELD", `${obj}.${f} doesn't exist (or isn't visible to the current user) in this org.`, { object: obj, field: f }); continue; }
      if (mode === "create" ? !fm.createable : !fm.updateable) { error("FIELD_NOT_WRITABLE", `${o.label}: ${fm.label} (${f}) can't be ${mode === "create" ? "set on create" : "changed"} by the current user.`, { object: obj, field: f }); continue; }
      if (fm.type === "picklist" && typeof v === "string" && !isRef(v) && fm.picklist.length && !fm.picklist.some(p => p.value === v)) {
        error("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `${o.label}: "${v}" isn't a valid ${fm.label}. Valid values: ${fm.picklist.map(p => p.value).join(", ")}.`, { object: obj, field: f });
        continue;
      }
      out[f] = v;
    }
    if (mode === "create") for (const fm of Object.values(o.fields)) {
      if (fm.required && !(fm.name in out) && fm.name !== "OwnerId" && !issues.some(i => i.object === obj && i.field === fm.name)) error("REQUIRED_FIELD_MISSING", `${o.label}: ${fm.label} (${fm.name}) is required by Salesforce in this org, and the configuration has no value for it.`, { object: obj, field: fm.name });
    }
    return out;
  };
  const add = (s: Omit<PlanStep, "fields" | "dependsOn" | "expect" | "recordId"> & Partial<Pick<PlanStep, "fields" | "dependsOn" | "expect" | "recordId">>): string => {
    steps.push({ fields: {}, dependsOn: [], expect: {}, recordId: null, ...s });
    return s.id;
  };
  /** Keep only expectations on fields this org has. */
  const expect = (obj: string, e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== undefined && hasField(meta, obj, k)));

  const reportedProducts = new Set<string>();
  const productOf = (r: RecordRef, where: string): ProductRow | null => {
    const res = ctx.products.get(productKey(r));
    if (res?.status === "found") return res.product;
    if (reportedProducts.has(productKey(r))) return null;
    reportedProducts.add(productKey(r));
    if (!res) { error("PRODUCT_NOT_FOUND", `${where}: product "${r.name ?? r.id}" wasn't resolved.`, { object: "Product2" }); return null; }
    error(res.status === "ambiguous" ? "AMBIGUOUS_PRODUCT" : res.status === "inactive" ? "INACTIVE_PRODUCT" : "PRODUCT_NOT_FOUND", `${where}: ${res.message}`, { object: "Product2", action: res.status === "not-found" ? "Create the product in the Products module first, or pick an existing product." : res.status === "ambiguous" ? "Pick the exact product in Manual Configuration." : "Activate the product in Salesforce or pick another." });
    return null;
  };

  /* ── 1. Tax Engine ── */
  const anyTaxable = spec.treatments.some(t => t.taxable);
  let engine: { id: string | null; ref: string; name: string; type: string; native: boolean } | null = null;
  const es = spec.engine ?? {};
  const activeStatus = (obj: string) => picklistValue(meta, obj, "Status", "Active");
  const draftStatus = (obj: string) => picklistValue(meta, obj, "Status", "Draft") ?? activeStatus(obj);
  if (es.existingId) {
    const e = snap.engines.find(x => x.id === es.existingId);
    if (!e) error("ENGINE_NOT_FOUND", `Tax Engine ${es.existingId} doesn't exist in this org.`, { object: "TaxEngine" });
    else {
      if (e.status !== "Active") error("ENGINE_INACTIVE", `Tax Engine "${e.name}" is ${e.status ?? "not active"} — activate it in Salesforce or choose another.`, { object: "TaxEngine", field: "Status" });
      engine = { id: e.id, ref: e.id, name: e.name, type: e.type ?? "", native: e.native };
      add({ id: "engine", phase: "create", object: "TaxEngine", label: `Tax Engine "${e.name}"`, action: "reuse", recordId: e.id, detail: `Existing ${e.type} engine (${e.status}).`, expect: expect("TaxEngine", { Status: "Active" }) });
    }
  } else if (anyTaxable || es.name || es.type) {
    if (!objectMeta(meta, "TaxEngine")) need("TaxEngine", "create");
    else {
      const types = picklist(meta, "TaxEngine", "Type");
      const wanted = es.type ?? NATIVE_ENGINE_TYPES[0];
      const type = picklistValue(meta, "TaxEngine", "Type", wanted) ?? (/revenue\s*standard|standard\s*tax|native|standard/i.test(wanted) ? types.find(t => NATIVE_ENGINE_TYPES.includes(t)) ?? null : null);
      if (!type) error("INVALID_ENGINE_TYPE", `"${wanted}" isn't a Tax Engine type in this org. Available types: ${types.join(", ") || "none"}.`, { object: "TaxEngine", field: "Type" });
      else {
        const native = NATIVE_ENGINE_TYPES.includes(type);
        const byName = es.name ? snap.engines.find(x => eqi(x.name, es.name)) : undefined;
        // Prefer engines that already have their own decision table (the one Salesforce uses for their treatments); oldest first.
        const equivalent = snap.engines.filter(x => x.type === type && x.status === "Active" && (!es.providerId || x.provider?.id === es.providerId))
          .sort((a, b) => Number(!!b.decisionTableId) - Number(!!a.decisionTableId));
        const reuse = (e: (typeof snap.engines)[number], why: string) => {
          engine = { id: e.id, ref: e.id, name: e.name, type, native };
          add({ id: "engine", phase: "create", object: "TaxEngine", label: `Tax Engine "${e.name}"`, action: "reuse", recordId: e.id, detail: why, expect: expect("TaxEngine", { Status: "Active", Type: type }) });
          if (native && !e.decisionTableId) warn("ENGINE_NO_DECISION_TABLE", `Tax Engine "${e.name}" has no Decision Table of its own, so Salesforce uses the system table (StandardTax); engine readiness checks whether that table can match tax codes (in p10 it has no TaxCode input, so its invoices got no tax).`, { object: "TaxEngine", field: "DecisionTableId" });
        };
        if (byName) {
          if (byName.type !== type) error("DUPLICATE_VALUE", `A ${byName.type} Tax Engine named "${byName.name}" already exists — choose another name.`, { object: "TaxEngine", field: "TaxEngineName" });
          else if (byName.status !== "Active") error("ENGINE_INACTIVE", `Tax Engine "${byName.name}" exists but is ${byName.status} — activate it in Salesforce or choose another name.`, { object: "TaxEngine", field: "Status" });
          else reuse(byName, `Existing active ${type} engine.`);
        } else if (equivalent.length) {
          reuse(equivalent[0], `Existing active ${type} engine${equivalent.length > 1 ? ` (${equivalent.length} exist; the oldest is used)` : ""}.`);
          if (es.name) info("ENGINE_REUSED", `An active ${type} engine already exists ("${equivalent[0].name}"), so it's reused instead of creating "${es.name}".`);
        } else {
          if (!native && !es.providerId) error("PROVIDER_REQUIRED", `A ${type} engine calls an external tax service and needs a Tax Engine Provider${snap.providers.length ? ` (available: ${snap.providers.map(p => p.name).join(", ")})` : " — none exists in this org"}.`, { object: "TaxEngine", field: "TaxEngineProviderId", action: "Use the native Revenue Standard Tax engine type, or create the provider in Salesforce Setup first." });
          if (es.providerId && !snap.providers.some(p => p.id === es.providerId)) error("INVALID_CROSS_REFERENCE_KEY", "The selected Tax Engine Provider doesn't exist in this org.", { object: "TaxEngine", field: "TaxEngineProviderId" });
          if (need("TaxEngine", "create")) {
            const name = es.name ?? (native ? "Revenue Standard Tax Engine" : `${type} Tax Engine`);
            const a = es.address ?? {};
            const fields = payload("TaxEngine", "create", [
              ["TaxEngineName", name, { required: true }], ["Type", type, { required: true }], ["Status", activeStatus("TaxEngine"), { required: true }],
              [rel("TaxEngine", "TaxEngineProvider"), es.providerId, { label: "Tax Engine Provider" }], [rel("TaxEngine", "NamedCredential"), es.namedCredentialId, { label: "Named Credential" }],
              ["SellerCode", es.sellerCode], ["TaxEngineStreet", a.street], ["TaxEngineCity", a.city], ["TaxEngineState", a.state], ["TaxEnginePostalCode", a.postalCode], ["TaxEngineCountry", a.country],
              ["Description", native ? "Salesforce native Revenue Standard Tax engine." : null],
            ]);
            engine = { id: null, ref: ref("engine"), name, type, native };
            add({ id: "engine", phase: "create", object: "TaxEngine", label: `Tax Engine "${name}"`, action: "create", fields, detail: `New ${type} engine${native ? " (native — no external provider)" : ""}, Active.`, expect: expect("TaxEngine", { Status: "Active", Type: type }) });
          }
        }
      }
    }
  }
  const eng = engine as { id: string | null; ref: string; name: string; type: string; native: boolean } | null;

  /* ── 2. Legal Entity (resolved, never created) ── */
  const activeLEs = snap.legalEntities.filter(l => !l.status || l.status === "Active");
  const resolveLE = (r: RecordRef | null | undefined, where: string): LegalEntityRow | null => {
    if (!r?.id && !r?.name) return null;
    const contains = r.name ? snap.legalEntities.filter(l => l.name.toLowerCase().includes(r.name!.trim().toLowerCase())) : [];
    const hit = r.id ? snap.legalEntities.find(l => l.id === r.id) : snap.legalEntities.find(l => eqi(l.name, r.name)) ?? (contains.length === 1 ? contains[0] : undefined);
    if (!hit) { error("LEGAL_ENTITY_NOT_FOUND", `${where}: no Legal Entity matches "${r.name ?? r.id}" in this org (available: ${snap.legalEntities.map(l => l.name).join(", ") || "none"}).`, { object: "LegalEntity", action: "Create it in Revenue Cloud Billing → Legal Entities, or pick an existing one." }); return null; }
    if (hit.status && hit.status !== "Active") { error("LEGAL_ENTITY_INACTIVE", `${where}: Legal Entity "${hit.name}" is ${hit.status}.`, { object: "LegalEntity", field: "Status" }); return null; }
    return hit;
  };
  let le = resolveLE(spec.legalEntity, "Legal entity");
  if (!le && !spec.legalEntity?.id && !spec.legalEntity?.name) {
    if (activeLEs.length === 1) { le = activeLEs[0]; info("LEGAL_ENTITY_DEFAULT", `Using the org's only active legal entity "${le.name}".`); }
    else if (!activeLEs.length) error("NO_LEGAL_ENTITY", "This org has no active Legal Entity; tax treatments and rates need one.", { object: "LegalEntity", action: "Create it in Revenue Cloud Billing → Legal Entities first." });
    else error("AMBIGUOUS_LEGAL_ENTITY", `This org has ${activeLEs.length} active legal entities (${activeLEs.map(l => l.name).join(", ")}) — choose one.`, { object: "LegalEntity", field: "legalEntity" });
  }

  /* ── 3. Country & tax codes (Tax Rates) ── */
  const countryInput = spec.country ?? le?.country ?? null;
  let country: ResolvedCountry | null = resolveCountry(countryInput, snap.geoCountries);
  if (countryInput && !country) error("UNKNOWN_COUNTRY", `"${countryInput}" can't be mapped to an ISO country code. Salesforce tax rates are keyed by ISO-2 country (GeoCountry).`, { field: "country" });
  const revCloud = picklistValue(meta, "TaxRate", "RateUsageType", "RevCloud");
  const rcRates = snap.rates.filter(r => !revCloud || r.usage === revCloud);
  const plannedRates = new Map<string, number>();
  const existingCodes = [...new Set(rcRates.map(r => r.taxCode).filter((c): c is string => !!c))];
  const resolveCode = (input: { taxCode?: string | null; rate?: number | null; taxName?: string | null }, where: string): Code | null => {
    const rate0 = input.rate ?? null;
    if (input.taxCode) {
      const rows = rcRates.filter(r => eqi(r.taxCode, input.taxCode));
      const plannedKey = [...plannedRates.keys()].find(k => eqi(k, input.taxCode));
      const code = rows[0]?.taxCode ?? plannedKey ?? input.taxCode;
      let rate = rate0;
      if (rate === null) {
        const known = [...new Set(rows.map(r => r.rate).filter((x): x is number => x !== null))];
        if (plannedKey !== undefined) rate = plannedRates.get(plannedKey)!;
        else if (known.length === 1) rate = known[0];
        else if (!rows.length) { error("INVALID_TAX_CODE", `${where}: tax code "${input.taxCode}" doesn't exist in this org — no Revenue Cloud tax rate carries it${existingCodes.length ? ` (existing codes: ${existingCodes.join(", ")})` : ""}. Give its rate (%) to create it, or use an existing code.`, { object: "TaxRate", field: "TaxCode" }); return null; }
        else { error("AMBIGUOUS_TAX_CODE", `${where}: tax code ${code} has different rates in this org (${known.join("%, ")}%) — state the rate.`, { object: "TaxRate", field: "Rate" }); return null; }
      }
      if (plannedRates.has(code) && !sameRate(plannedRates.get(code), rate)) { error("CONFLICTING_RATES", `${where}: tax code ${code} is requested with ${plannedRates.get(code)}% and ${rate}%.`, { field: "rate" }); return null; }
      plannedRates.set(code, rate);
      return { code, rate };
    }
    if (rate0 !== null) {
      const base = deriveCode(input.taxName, rate0);
      let code = base;
      const exact = rcRates.find(r => eqi(r.taxCode, base));
      const sameRateCodes = [...new Set(rcRates.filter(r => sameRate(r.rate, rate0) && r.taxCode).map(r => r.taxCode as string))];
      if (exact && !sameRate(exact.rate, rate0)) { let n = 2; while (rcRates.some(r => eqi(r.taxCode, `${base}_${n}`)) || plannedRates.has(`${base}_${n}`)) n++; code = `${base}_${n}`; }
      else if (exact) code = exact.taxCode!;
      else if (!input.taxName && sameRateCodes.length === 1) code = sameRateCodes[0];
      if (plannedRates.has(code) && !sameRate(plannedRates.get(code), rate0)) { error("CONFLICTING_RATES", `${where}: tax code ${code} is requested with two rates.`, { field: "rate" }); return null; }
      plannedRates.set(code, rate0);
      return { code, rate: rate0 };
    }
    error("MISSING_TAX_RATE", `${where}: which tax rate (%) or existing tax code applies?`, { field: "rate" });
    return null;
  };

  let geoStepId: string | null = null;
  const ensureGeo = (c: ResolvedCountry): string | null => {
    if (c.geoCountryId) return c.geoCountryId;
    if (geoStepId) return ref(geoStepId);
    if (!need("GeoCountry", "create")) return null;
    const fields = payload("GeoCountry", "create", [["Name", c.name], ["IsoCode", c.iso, { required: true }]]);
    geoStepId = add({ id: `geo:${c.iso}`, phase: "create", object: "GeoCountry", label: `Tax country ${c.name} (${c.iso})`, action: "create", fields, detail: `This org has no GeoCountry for ${c.iso}; tax rates are keyed by it.`, expect: expect("GeoCountry", { IsoCode: c.iso }) });
    return ref(geoStepId);
  };
  const rateSteps = new Map<string, string>();
  const rateCodes: TaxPlan["resolved"]["taxCodes"] = [];
  /** Rates this plan creates (lookup keys) — checked against each other and the org's rates for Multiple-Match overlaps. */
  const plannedRateKeys: { key: RateKey; label: string }[] = [];
  const blankMode = spec.rateDefaults?.productCodeMode === "blank";
  const rowKey = (r: TaxRateRow): RateKey => ({ taxCode: r.taxCode, country: r.country, state: r.state ?? null, city: r.city ?? null, zipCode: r.zipCode ?? null, productCode: r.productCode, legalEntityId: r.legalEntityId, usage: r.usage, start: r.start, end: r.end });
  /** Who a rate applies to: one product (ProductCode = Product2.ProductCode — the default) or every product (blank, explicit only). */
  type RateTarget = { mode: "product"; product: ProductRow } | { mode: "blank" };
  const ensureRate = (code: Code, leRow: LegalEntityRow | null, where: string, target: RateTarget) => {
    if (eng && !eng.native) return; // an external engine calculates rates itself
    let c = country;
    if (!c) {
      const isos = [...new Set(rcRates.filter(r => eqi(r.taxCode, code.code)).map(r => r.country).filter((x): x is string => !!x))];
      if (isos.length === 1) { c = resolveCountry(isos[0], snap.geoCountries); if (c) { country = c; info("COUNTRY_FROM_RATES", `Tax country ${c.iso} taken from the existing ${code.code} rate.`); } }
      if (!c) { error("NO_TAX_COUNTRY", `${where}: which country does ${code.code} apply to? Tax rates are keyed by country.`, { field: "country" }); return; }
    }
    if (target.mode === "product" && !target.product.code) { error("PRODUCT_CODE_MISSING", `${where}: product "${target.product.name}" has no Product Code. Salesforce matches a Tax Rate's Product Code against the product's own Product Code, so a product-specific rate can't be keyed — set Product2.ProductCode, or explicitly request a rate with a blank Product Code.`, { object: "Product2", field: "ProductCode" }); return; }
    const pc = target.mode === "product" ? target.product.code : null;
    const key = `${code.code.toUpperCase()}|${c.iso}|${leRow?.id ?? ""}|${pc ?? "*"}`;
    if (rateSteps.has(key)) return;
    // Reuse only an exact lookup equivalent: same code, country, legal entity, Product Code (blank = blank) and no state/city/zip.
    const rows = rcRates.filter(r => eqi(r.taxCode, code.code) && r.country === c!.iso && (r.legalEntityId ?? null) === (leRow?.id ?? null) && (r.productCode ?? null) === pc && !r.state && !r.city && !r.zipCode);
    const eff = rows.find(r => r.effective);
    const stepId = `rate:${key}`;
    const label = `${code.code} ${pc ? `· ${pc}` : "· blank Product Code"} (${c.iso})`;
    if (eff) {
      if (!sameRate(eff.rate, code.rate)) error("RATE_CONFLICT", `${where}: tax code ${code.code} is already ${eff.rate}% for ${c.iso}${pc ? ` / ${pc}` : ""}${leRow ? ` / ${leRow.name}` : ""} (Tax Rate ${eff.id}). Existing rates aren't changed — use another tax code for ${code.rate}%.`, { object: "TaxRate", field: "Rate" });
      if (eff.basis && eff.basis !== "Net") error("RATE_BASIS_NOT_NET", `${where}: existing Tax Rate ${eff.name} uses Application Basis "${eff.basis}" — only Net has been verified to produce InvoiceLineTax. Replace it (Rate Replace) instead of reusing it.`, { object: "TaxRate", field: "ApplicationBasis" });
      rateSteps.set(key, add({ id: stepId, phase: "create", object: "TaxRate", label: `Tax Rate ${code.code} ${eff.rate}% ${pc ? `· ${pc}` : "· blank Product Code"} (${c.iso})`, action: "reuse", recordId: eff.id, detail: `Existing effective Revenue Cloud rate${leRow ? ` for ${leRow.name}` : ""}.`, expect: expect("TaxRate", { Rate: code.rate, TaxCode: eff.taxCode, ProductCode: pc }) }));
      rateCodes.push({ code: code.code, rate: eff.rate, exists: true, country: c.iso });
      return;
    }
    if (rows.length) { error("RATE_NOT_EFFECTIVE", `${where}: tax rate ${code.code} for ${c.iso}${pc ? ` / ${pc}` : ""} exists (${rows[0].id}) but isn't effective today (start ${rows[0].start ?? "—"}, end ${rows[0].end ?? "—"}) — correct its dates in Salesforce.`, { object: "TaxRate", field: "StartDate" }); return; }
    if (!need("TaxRate", "create")) return;
    if (!revCloud) error("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `Tax Rate's Rate Usage Type has no Revenue Cloud value in this org (values: ${picklist(meta, "TaxRate", "RateUsageType").join(", ") || "none"}).`, { object: "TaxRate", field: "RateUsageType" });
    const geoRef = ensureGeo(c);
    const start = spec.rateDefaults?.startDate ?? `${ctx.today.slice(0, 4)}-01-01`;
    const end = spec.rateDefaults?.endDate ?? null;
    if (end && end < start) error("INVALID_DATES", `Tax rate end date ${end} is before its start date ${start}.`, { object: "TaxRate", field: "EndDate" });
    // Overlaps (shared rule, rateRules.rateOverlap): ALWAYS → Salesforce's lookup can only return Multiple Matches → blocked;
    // CONDITIONAL (e.g. a state-specific rate) → warned, and the activation check blocks the affected sales.
    const newKey: RateKey = { taxCode: code.code, country: c.iso, state: null, city: null, zipCode: null, productCode: pc, legalEntityId: leRow?.id ?? null, usage: revCloud ?? REVENUE_CLOUD_RATE_USAGE, start, end };
    const others: [RateKey, string][] = [
      ...rcRates.map((r): [RateKey, string] => [rowKey(r), `Tax Rate ${r.name} (${r.taxCode ?? "—"} ${r.rate ?? "?"}%${r.productCode ? ` · ${r.productCode}` : " · blank Product Code"}${r.state ? ` · ${r.state}` : ""})`]),
      ...plannedRateKeys.map((p): [RateKey, string] => [p.key, `the planned rate ${p.label}`]),
    ];
    for (const [other, otherLabel] of others) {
      const o = rateOverlap(newKey, other);
      if (o === "always") error("RATE_WOULD_BE_AMBIGUOUS", `${where}: the new rate ${label} and ${otherLabel} would both match the same sales — Salesforce's lookup returns Multiple Matches. Use a product-specific Product Code, or end-date the other rate first.`, { object: "TaxRate", field: "ProductCode" });
      else if (o === "conditional") warn("AMBIGUOUS_RATE_OVERLAP", `${where}: the new rate ${label} and ${otherLabel} both match some sales (where the blank fields of one meet the values of the other) — those sales get Multiple Matches and are blocked at activation.`, { object: "TaxRate" });
    }
    plannedRateKeys.push({ key: newKey, label });
    if (target.mode === "blank") {
      const reach = ctx.productsByTaxCode?.[code.code.toUpperCase()] ?? [];
      warn("BLANK_PRODUCT_CODE", `${where}: the new rate ${label} has a blank Product Code, so it matches EVERY product whose treatment uses tax code ${code.code} in ${c.iso}${reach.length ? ` (today: ${reach.map(p => `${p.name}${p.code ? ` [${p.code}]` : ""}`).join(", ")})` : ""}. Proven at invoice time for treatments without Tax Treatment Items (E2).`, { object: "TaxRate", field: "ProductCode" });
      if (reach.some(p => p.viaItems)) warn("BLANK_PRODUCT_CODE_ITEMS_UNVERIFIED", `${where}: tax code ${code.code} is also used through Tax Treatment Items — a blank-Product-Code rate with item-based treatments isn't verified.`, { object: "TaxRate", field: "ProductCode" });
    }
    const fields = payload("TaxRate", "create", [
      ["TaxCode", code.code, { required: true }], [rel("TaxRate", "GeoCountry"), geoRef, { required: true, label: "Country" }], ["Rate", code.rate, { required: true }],
      ["RateUsageType", revCloud, { required: true }], [rel("TaxRate", "LegalEntity"), leRow?.id, { label: "Legal Entity" }], ["StartDate", start], ["EndDate", end],
      ["ApplicationBasis", picklistValue(meta, "TaxRate", "ApplicationBasis", "Net"), { required: true, label: "Application Basis" }], ["Priority", 1],
      ["ProductCode", pc],
    ]);
    rateSteps.set(key, add({ id: stepId, phase: "create", object: "TaxRate", label: `Tax Rate ${code.code} ${code.rate}% ${pc ? `· ${pc}` : "· blank Product Code"} (${c.iso})`, action: "create", fields, dependsOn: geoStepId ? [geoStepId] : [], detail: `New Revenue Cloud rate · ${c.iso} · Product Code ${pc ?? "blank (all products with this tax code)"}${leRow ? ` · ${leRow.name}` : ""} · from ${start}${end ? ` to ${end}` : ""}.`, expect: expect("TaxRate", { Rate: code.rate, TaxCode: code.code, LegalEntityId: leRow?.id, ProductCode: pc }) }));
    rateCodes.push({ code: code.code, rate: code.rate, exists: existingCodes.some(x => eqi(x, code.code)), country: c.iso });
  };
  /** Rates for a treatment applied to whole products (no items): one per product (default) or one blank rate (explicit). */
  const ensureTreatmentRates = (code: Code, leRow: LegalEntityRow | null, where: string) => {
    if (blankMode) { ensureRate(code, leRow, where, { mode: "blank" }); return; }
    const targets = spec.products.map(x => productOf(x.product, "Product mapping")).filter((p): p is ProductRow => !!p);
    if (!targets.length) {
      if (spec.products.length) return; // the unresolved products are already reported
      error("RATE_PRODUCT_REQUIRED", `${where}: which product(s) does ${code.code} apply to? Salesforce matches a Tax Rate's Product Code against the product's own Product Code, so rates are created per product. Name the products — or explicitly ask for one rate with a blank Product Code (it then applies to every product using ${code.code}).`, { object: "TaxRate", field: "ProductCode" });
      return;
    }
    for (const p of targets) ensureRate(code, leRow, `${where} · ${p.name}`, { mode: "product", product: p });
  };

  /* ── 4. Treatments: what is wanted ── */
  const selection = picklistValue(meta, "TaxPolicy", "TreatmentSelection", spec.policy.treatmentSelection ?? "Default");
  if (!selection) error("INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", `"${spec.policy.treatmentSelection ?? "Default"}" isn't a Treatment Selection value in this org (valid: ${picklist(meta, "TaxPolicy", "TreatmentSelection").join(", ")}).`, { object: "TaxPolicy", field: "TreatmentSelection" });
  if (!spec.treatments.length) error("NO_TREATMENT", "Describe at least one tax treatment (taxable, tax exempt or zero-rated).", { object: "TaxTreatment" });
  const desired: Desired[] = spec.treatments.map(t => {
    const where = `Treatment "${t.name ?? t.suggestedName ?? t.key}"`;
    const tle = (t.legalEntity ? resolveLE(t.legalEntity, where) : null) ?? le;
    if (!t.taxable && (t.rate ?? 0) > 0) warn("EXEMPT_WITH_RATE", `${where} is tax exempt, so the ${t.rate}% is ignored. For a product taxed at 0% use a zero-rated (taxable, 0%) treatment.`);
    const wantsCode = t.taxable && (!t.useItems || !!t.taxCode || (t.rate !== null && t.rate !== undefined));
    const code = wantsCode ? resolveCode(t, where) : null;
    if (code) ensureTreatmentRates(code, tle, where);
    if (t.taxable && code?.rate === 0) info("ZERO_RATED", `${where} is zero-rated: taxable at 0% (not exempt).`);
    return { spec: t, code, le: tle };
  });
  if (anyTaxable && !eng && !issues.some(i => i.object === "TaxEngine")) error("NO_TAX_ENGINE", "A taxable treatment needs a Tax Engine.", { object: "TaxEngine" });
  if (selection === "LegalEntity") for (const d of desired) if (!d.le) error("LEGAL_ENTITY_REQUIRED", `Treatment "${d.spec.name ?? d.spec.key}": Legal Entity selection needs a legal entity on every treatment.`, { object: "TaxTreatment", field: "LegalEntityId" });

  const engineId = eng?.id ?? null;
  const equivalent = (row: TaxTreatmentRow, d: Desired) =>
    row.taxable === d.spec.taxable
    && (!d.spec.taxable || (!!engineId && row.engineId === engineId))
    && (d.spec.useItems ? row.useItems : !row.useItems && (d.code ? eqi(row.taxCode, d.code.code) : !row.taxCode))
    && (!d.le || row.legalEntityId === d.le.id);
  const differences = (row: TaxTreatmentRow, d: Desired) => [
    row.taxable !== d.spec.taxable ? `taxable ${row.taxable ? "yes" : "no"} → ${d.spec.taxable ? "yes" : "no"}` : null,
    d.spec.taxable && row.engineId !== engineId ? "tax engine" : null,
    !d.spec.useItems && d.code && !eqi(row.taxCode, d.code.code) ? `tax code ${row.taxCode ?? "none"} → ${d.code.code}` : null,
    !!d.spec.useItems !== row.useItems ? `Use Tax Treatment Items ${row.useItems ? "on" : "off"} → ${d.spec.useItems ? "on" : "off"}` : null,
    d.le && row.legalEntityId !== d.le.id ? "legal entity" : null,
  ].filter(Boolean).join(", ");

  /* ── 5. Tax Policy ── */
  const ofPolicy = (pid: string) => snap.treatments.filter(t => t.policyId === pid && t.status !== "Inactive");
  const codesLabel = [...new Set(desired.map(d => d.code?.code).filter(Boolean))].join(" / ");
  const derivedPolicyName = desired.every(d => !d.spec.taxable) ? "Tax Exempt Policy" : codesLabel ? `${codesLabel} Tax Policy` : "Tax Policy";
  let policyRow: TaxPolicyRow | null = null;
  let policyRef: string | null = null;
  let policyName = spec.policy.name ?? spec.policy.suggestedName ?? derivedPolicyName;
  if (spec.policy.existingId) {
    policyRow = snap.policies.find(p => p.id === spec.policy.existingId) ?? null;
    if (!policyRow) error("POLICY_NOT_FOUND", `Tax Policy ${spec.policy.existingId} doesn't exist in this org.`, { object: "TaxPolicy" });
  } else if (spec.policy.name) policyRow = snap.policies.find(p => eqi(p.name, spec.policy.name)) ?? null;
  else {
    policyRow = (spec.policy.suggestedName ? snap.policies.find(p => eqi(p.name, spec.policy.suggestedName) && p.status !== "Inactive") : null) ?? null;
    if (!policyRow && desired.length && selection) {
      const candidates = snap.policies.filter(p => p.status !== "Inactive" && p.selection === selection).sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active"));
      policyRow = candidates.find(p => { const pool = ofPolicy(p.id); return desired.every(d => pool.some(r => equivalent(r, d))); }) ?? null;
      if (policyRow) info("POLICY_EQUIVALENT", `Tax Policy "${policyRow.name}" already has equivalent treatments, so it's reused${eqi(policyRow.name, policyName) ? "" : ` instead of creating "${policyName}"`}.`);
    }
  }
  if (policyRow) {
    policyName = policyRow.name;
    if (policyRow.status === "Inactive") error("POLICY_INACTIVE", `Tax Policy "${policyRow.name}" is Inactive — reactivate it in Salesforce or choose another name.`, { object: "TaxPolicy", field: "Status" });
    if (selection && policyRow.selection !== selection) error("POLICY_SELECTION_MISMATCH", `Tax Policy "${policyRow.name}" uses ${policyRow.selection} treatment selection, not ${selection}. Choose another policy name or the matching selection.`, { object: "TaxPolicy", field: "TreatmentSelection" });
    policyRef = policyRow.id;
    add({ id: "policy", phase: "create", object: "TaxPolicy", label: `Tax Policy "${policyRow.name}"`, action: "reuse", recordId: policyRow.id, detail: `Existing ${policyRow.selection} policy (${policyRow.status}, ${policyRow.products} product(s)).` });
  } else if (need("TaxPolicy", "create")) {
    if (!spec.policy.name && snap.policies.some(p => eqi(p.name, policyName))) { let n = 2; while (snap.policies.some(p => eqi(p.name, `${policyName} ${n}`))) n++; policyName = `${policyName} ${n}`; }
    const fields = payload("TaxPolicy", "create", [["Name", policyName, { required: true }], ["Status", draftStatus("TaxPolicy"), { required: true }], ["TreatmentSelection", selection, { required: true }], ["Description", spec.policy.description]]);
    policyRef = ref("policy");
    add({ id: "policy", phase: "create", object: "TaxPolicy", label: `Tax Policy "${policyName}"`, action: "create", fields, detail: `New ${selection ?? ""} policy (created as Draft, activated after its treatments).` });
  }

  /* ── 6. Tax Treatments ── */
  const treatments = new Map<string, { ref: string | null; row: TaxTreatmentRow | null; name: string; stepId: string; activation: string | null; d: Desired }>();
  const used = new Set<string>();
  for (const d of desired) {
    const t = d.spec;
    const stepId = `treatment:${t.key}`;
    let row: TaxTreatmentRow | null = null;
    if (t.existingId) {
      row = snap.treatments.find(x => x.id === t.existingId) ?? null;
      if (!row) error("TREATMENT_NOT_FOUND", `Tax Treatment ${t.existingId} doesn't exist in this org.`, { object: "TaxTreatment" });
      else if (!policyRow || row.policyId !== policyRow.id) { error("TREATMENT_OTHER_POLICY", `Tax Treatment "${row.name}" belongs to another tax policy; a treatment belongs to exactly one policy in Salesforce.`, { object: "TaxTreatment", field: "TaxPolicyId" }); row = null; }
    } else if (policyRow) {
      const pool = ofPolicy(policyRow.id).filter(r => !used.has(r.id));
      row = (t.name ? pool.find(r => eqi(r.name, t.name)) : undefined) ?? pool.find(r => equivalent(r, d)) ?? (t.suggestedName ? pool.find(r => eqi(r.name, t.suggestedName)) : undefined) ?? null;
    }
    const name = row?.name ?? t.name ?? t.suggestedName ?? (t.taxable ? (t.useItems ? `${policyName} Taxable` : `${d.code?.code ?? "Tax"} Taxable`) : "Tax Exempt");
    const exp = expect("TaxTreatment", { Status: "Active", IsTaxable: t.taxable, TaxPolicyId: policyRef ?? undefined, TaxEngineId: t.taxable ? eng?.ref : undefined, TaxCode: !t.useItems ? d.code?.code : undefined, LegalEntityId: d.le?.id, ShouldUseTaxTreatmentItems: t.useItems ? true : undefined });
    let activation: string | null = null;
    if (row) {
      used.add(row.id);
      if (row.status === "Inactive") error("TREATMENT_INACTIVE", `Tax Treatment "${row.name}" is Inactive.`, { object: "TaxTreatment", field: "Status" });
      const diff = differences(row, d);
      if (diff && row.status === "Active") error("TREATMENT_IMMUTABLE", `Active Tax Treatment "${row.name}" differs from the request (${diff}), and Salesforce doesn't allow editing an Active treatment. Give the new treatment another name.`, { object: "TaxTreatment" });
      add({ id: stepId, phase: "create", object: "TaxTreatment", label: `Tax Treatment "${row.name}"`, action: "reuse", recordId: row.id, detail: `Existing ${row.taxable ? "taxable" : "non-taxable"} treatment (${row.status}${row.taxCode ? `, ${row.taxCode}` : ""}${row.useItems ? ", per-product items" : ""}).`, expect: exp });
      if (diff && row.status !== "Active") {
        const fields = payload("TaxTreatment", "update", [["IsTaxable", t.taxable], [rel("TaxTreatment", "TaxEngine"), t.taxable ? eng?.ref : null], ["TaxCode", t.useItems ? null : d.code?.code], ["ProductCode", t.useItems ? null : d.code?.code], ["ShouldUseTaxTreatmentItems", t.useItems ? true : null], [rel("TaxTreatment", "LegalEntity"), d.le?.id]]);
        add({ id: `update:${stepId}`, phase: "create", object: "TaxTreatment", label: `Update Draft Tax Treatment "${row.name}"`, action: "update", recordId: row.id, fields, dependsOn: eng && !eng.id ? ["engine"] : [], detail: `Draft treatment updated: ${diff}.` });
      }
      if (row.status !== "Active") activation = add({ id: `activate:${stepId}`, phase: "activate", object: "TaxTreatment", label: `Activate Tax Treatment "${row.name}"`, action: "update", recordId: row.id, fields: payload("TaxTreatment", "update", [["Status", activeStatus("TaxTreatment")]]), detail: "Draft → Active." });
      treatments.set(t.key, { ref: row.id, row, name: row.name, stepId, activation, d });
    } else if (need("TaxTreatment", "create")) {
      if (t.useItems && !hasField(meta, "TaxTreatment", "ShouldUseTaxTreatmentItems")) error("INVALID_FIELD", "This org's Tax Treatment has no 'Use Tax Treatment Items' field, so per-product tax codes aren't supported — use one treatment per tax code.", { object: "TaxTreatment", field: "ShouldUseTaxTreatmentItems" });
      if (t.useItems && !objectMeta(meta, "TaxTreatmentItem")) need("TaxTreatmentItem", "create");
      const fields = payload("TaxTreatment", "create", [
        ["Name", name, { required: true }], [rel("TaxTreatment", "TaxPolicy"), policyRef, { required: true, label: "Tax Policy" }], [rel("TaxTreatment", "LegalEntity"), d.le?.id, { label: "Legal Entity" }],
        [rel("TaxTreatment", "TaxEngine"), t.taxable ? eng?.ref : null, { required: t.taxable, label: "Tax Engine" }], ["IsTaxable", t.taxable],
        ["TaxCode", d.code?.code], ["ProductCode", t.useItems ? null : d.code?.code], ["ShouldUseTaxTreatmentItems", t.useItems ? true : null],
        ["Status", draftStatus("TaxTreatment"), { required: true }],
        ["Description", t.description ?? (t.taxable ? (t.useItems ? `Tax codes per product (Tax Treatment Items) via ${eng?.name ?? "the tax engine"}` : `${d.code?.rate}% (${d.code?.code}) via ${eng?.name ?? "the tax engine"}`) : "Tax exempt")],
      ]);
      add({ id: stepId, phase: "create", object: "TaxTreatment", label: `Tax Treatment "${name}"`, action: "create", fields, dependsOn: ["policy", ...(eng && !eng.id && t.taxable ? ["engine"] : [])], detail: `${t.taxable ? (d.code?.rate === 0 ? "Zero-rated (taxable, 0%)" : "Taxable") : "Tax exempt"}${d.code && !t.useItems ? ` · tax code ${d.code.code}` : ""}${t.useItems ? " · tax codes per product (Tax Treatment Items)" : ""}${d.le ? ` · ${d.le.name}` : ""} (created as Draft).`, expect: exp });
      activation = add({ id: `activate:${stepId}`, phase: "activate", object: "TaxTreatment", label: `Activate Tax Treatment "${name}"`, action: "update", recordId: ref(stepId), fields: payload("TaxTreatment", "update", [["Status", activeStatus("TaxTreatment")]]), dependsOn: [stepId], detail: "Draft → Active." });
      treatments.set(t.key, { ref: ref(stepId), row: null, name, stepId, activation, d });
    }
  }

  /* ── 7. Default treatment & policy activation ── */
  const flagged = desired.filter(d => d.spec.isDefault);
  let defaultKey: string | null = null;
  if (flagged.length > 1) error("MULTIPLE_DEFAULTS", "Only one treatment can be the policy's default.", { object: "TaxPolicy", field: "DefaultTaxTreatmentId" });
  else if (flagged.length === 1) defaultKey = flagged[0].spec.key;
  else if (selection === "Default") {
    if (desired.length === 1) defaultKey = desired[0].spec.key;
    else if (desired.length > 1) error("DEFAULT_REQUIRED", "A Default-selection policy applies ONE treatment to every product — mark one treatment as default, use Tax Treatment Items for per-product tax codes, or use Manual selection.", { object: "TaxPolicy", field: "DefaultTaxTreatmentId" });
  }
  const def = defaultKey ? treatments.get(defaultKey) ?? null : null;
  const defaultField = rel("TaxPolicy", "TaxTreatment");
  const policyInactive = !policyRow || policyRow.status !== "Active";
  const defaultChanges = !!def && def.ref !== (policyRow?.defaultTreatmentId ?? null);
  if (policyRef && (policyInactive || defaultChanges)) {
    if (policyRow?.status === "Active" && defaultChanges && policyRow.defaultTreatmentId) warn("POLICY_DEFAULT_CHANGES", `Tax Policy "${policyRow.name}" will use "${def!.name}" as its default treatment instead of its current one — this changes tax for its ${policyRow.products} product(s).`, { object: "TaxPolicy", field: "DefaultTaxTreatmentId" });
    const fields = payload("TaxPolicy", "update", [[defaultField, def?.ref, { label: "Default Tax Treatment" }], ["Status", policyInactive ? activeStatus("TaxPolicy") : null]]);
    add({ id: "activate:policy", phase: "activate", object: "TaxPolicy", label: `${policyInactive ? "Activate" : "Update"} Tax Policy "${policyName}"`, action: "update", recordId: policyRef, fields, dependsOn: [...treatments.values()].map(x => x.activation).filter((x): x is string => !!x), detail: `${def ? `Default treatment → ${def.name}` : "No default treatment"}${policyInactive ? " · Draft → Active" : ""}.` });
  }
  const policyStep = steps.find(s => s.id === "policy");
  if (policyStep) policyStep.expect = expect("TaxPolicy", { Status: "Active", TreatmentSelection: selection ?? undefined, DefaultTaxTreatmentId: def?.ref });
  if (selection === "LegalEntity" && policyRow) {
    for (const d of desired) {
      const clash = ofPolicy(policyRow.id).find(r => r.legalEntityId === d.le?.id && r.status === "Active" && !equivalent(r, d));
      if (clash) error("DUPLICATE_LEGAL_ENTITY_TREATMENT", `Tax Policy "${policyRow.name}" already has an active treatment for legal entity ${d.le?.name} ("${clash.name}").`, { object: "TaxTreatment", field: "LegalEntityId" });
    }
  }

  /* ── 8. Tax Treatment Items ── */
  const resolvedItems: TaxPlan["resolved"]["items"] = [];
  const pairs = new Set<string>();
  const itemCodeUpdatable = hasField(meta, "TaxTreatmentItem", "TaxCode") && !!objectMeta(meta, "TaxTreatmentItem")?.fields.TaxCode?.updateable;
  for (const it of spec.items) {
    const tr = treatments.get(it.treatmentKey);
    if (!tr) { error("UNKNOWN_TREATMENT", `Tax Treatment Item for "${it.product.name ?? it.product.id}" refers to an unknown treatment.`, { object: "TaxTreatmentItem" }); continue; }
    const p = productOf(it.product, `Tax Treatment Item`);
    if (!p) continue;
    const where = `Tax Treatment Item "${p.name}"`;
    const ts = tr.d.spec;
    const code = ts.taxable ? resolveCode({ taxCode: it.taxCode ?? (it.rate == null ? ts.taxCode : null), rate: it.rate ?? (it.taxCode ? null : ts.rate), taxName: it.taxName ?? ts.taxName }, where) : null;
    // An item's rate is keyed to the item's product (Product2.ProductCode), or blank only when explicitly requested.
    if (code) ensureRate(code, tr.d.le, where, blankMode ? { mode: "blank" } : { mode: "product", product: p });
    if (code && blankMode) warn("BLANK_PRODUCT_CODE_ITEMS_UNVERIFIED", `${where}: a blank-Product-Code rate used through a Tax Treatment Item isn't verified at invoice time (E2 proved it only for treatments without items).`, { object: "TaxRate", field: "ProductCode" });
    const pairKey = `${tr.stepId}|${p.id}`;
    if (pairs.has(pairKey)) { error("DUPLICATE_ITEM", `${where} is listed twice for treatment "${tr.name}".`, { object: "TaxTreatmentItem" }); continue; }
    pairs.add(pairKey);
    if (spec.items.some(o => o !== it && o.treatmentKey !== it.treatmentKey && productKey(o.product) === productKey(it.product))) { error("PRODUCT_IN_TWO_TREATMENTS", `${where}: a product can have only one Tax Treatment Item per policy.`, { object: "TaxTreatmentItem" }); continue; }
    resolvedItems.push({ treatmentKey: it.treatmentKey, product: { id: p.id, name: p.name, code: p.code }, taxCode: code?.code ?? null, rate: code?.rate ?? null });
    const existing = tr.row ? snap.items.find(i => i.treatmentId === tr.row!.id && i.productId === p.id) : undefined;
    const stepId = `item:${it.treatmentKey}:${p.id}`;
    const exp = expect("TaxTreatmentItem", { TaxTreatmentId: tr.ref, ProductId: p.id, TaxCode: code?.code });
    if (existing) {
      add({ id: stepId, phase: "create", object: "TaxTreatmentItem", label: `Tax Treatment Item "${existing.name}"`, action: "reuse", recordId: existing.id, detail: `Existing item for ${p.name}${existing.taxCode ? ` (${existing.taxCode})` : ""}.`, expect: exp });
      if (code && !eqi(existing.taxCode, code.code)) {
        if (!itemCodeUpdatable) error("FIELD_NOT_WRITABLE", `${where} has tax code ${existing.taxCode ?? "none"} and its Tax Code can't be changed by the current user.`, { object: "TaxTreatmentItem", field: "TaxCode" });
        else add({ id: `update:${stepId}`, phase: "map", object: "TaxTreatmentItem", label: `Update Tax Treatment Item "${existing.name}"`, action: "update", recordId: existing.id, fields: payload("TaxTreatmentItem", "update", [["TaxCode", code.code], ["ProductCode", p.code]]), detail: `Tax code ${existing.taxCode ?? "none"} → ${code.code}.` });
      }
      continue;
    }
    if (!ts.useItems) { error("ITEMS_NOT_ENABLED", `${where}: treatment "${tr.name}" doesn't use Tax Treatment Items.`, { object: "TaxTreatment", field: "ShouldUseTaxTreatmentItems" }); continue; }
    if (tr.row?.status === "Active" && !tr.row.useItems) { error("ITEMS_NOT_ENABLED", `${where}: Active treatment "${tr.name}" doesn't use Tax Treatment Items and can't be changed.`, { object: "TaxTreatment", field: "ShouldUseTaxTreatmentItems" }); continue; }
    if (!need("TaxTreatmentItem", "create")) continue;
    const fields = payload("TaxTreatmentItem", "create", [
      ["Name", (it.name ?? `${p.name} · ${code?.code ?? "Exempt"}`).slice(0, 80), { required: true }], [rel("TaxTreatmentItem", "TaxTreatment"), tr.ref, { required: true, label: "Tax Treatment" }],
      [rel("TaxTreatmentItem", "Product2"), p.id, { required: true, label: "Product" }], ["TaxCode", code?.code], ["ProductCode", p.code],
    ]);
    add({ id: stepId, phase: "create", object: "TaxTreatmentItem", label: `Tax Treatment Item ${p.name}${code ? ` → ${code.code}` : ""}`, action: "create", fields, dependsOn: tr.row ? [] : [tr.stepId], detail: `${p.name}${p.code ? ` (${p.code})` : ""} → ${tr.name}${code ? ` · ${code.code} ${code.rate}%` : " · exempt"}.`, expect: exp });
  }

  /* ── 9. Product → Tax Policy ── */
  const productField = rel("Product2", "TaxPolicy");
  const resolvedProducts: TaxPlan["resolved"]["products"] = [];
  const itemProducts = new Set(resolvedItems.map(i => i.product.id));
  for (const r of allProductRefs(spec)) {
    const p = productOf(r, "Product mapping");
    if (!p) continue;
    const current = snap.policies.find(x => x.id === p.taxPolicyId) ?? null;
    resolvedProducts.push({ id: p.id, name: p.name, code: p.code, currentPolicy: current ? { id: current.id, name: current.name } : null });
    const stepId = `product:${p.id}`;
    const exp = productField ? expect("Product2", { [productField]: policyRef ?? undefined, IsActive: true }) : {};
    if (policyRow && p.taxPolicyId === policyRow.id) { add({ id: stepId, phase: "map", object: "Product2", label: `Product ${p.name}`, action: "reuse", recordId: p.id, detail: `Already uses Tax Policy "${policyRow.name}".`, expect: exp }); continue; }
    if (!productField) { error("INVALID_FIELD", "Product2 has no Tax Policy field in this org.", { object: "Product2" }); continue; }
    if (!need("Product2", "update")) continue;
    if (p.taxPolicyId) warn("PRODUCT_POLICY_CHANGES", `Product "${p.name}" moves from Tax Policy "${current?.name ?? p.taxPolicyId}" to "${policyName}" — this changes tax on its future orders and invoices.`, { object: "Product2", field: productField });
    const tDefault = def?.d.spec;
    if (tDefault?.useItems && !itemProducts.has(p.id)) warn("NO_ITEM_FOR_PRODUCT", `Product "${p.name}" has no Tax Treatment Item on "${def!.name}" — Salesforce uses the treatment's own tax code for it.`, { object: "TaxTreatmentItem" });
    add({ id: stepId, phase: "map", object: "Product2", label: `Product ${p.name} → ${policyName}`, action: "update", recordId: p.id, fields: payload("Product2", "update", [[productField, policyRef, { required: true }]]), dependsOn: steps.some(s => s.id === "activate:policy") ? ["activate:policy"] : [], detail: `Tax policy ${p.taxPolicyId ? `"${current?.name ?? p.taxPolicyId}" → ` : ""}"${policyName}".`, expect: exp });
  }
  if (!allProductRefs(spec).length) info("NO_PRODUCTS", "No products are mapped — the policy can be assigned to products later.");

  /* ── 10. Decision-table refresh (explicit) ── */
  // A new Tax Rate reaches Salesforce's lookup only after the engine's decision table is refreshed; invoicing stays blocked until a
  // successful (full or incremental) refresh is newer than the rate. The refresh is a separate, approved step — never part of Create.
  const refreshRequired = steps.some(s => s.object === "TaxRate" && s.action === "create");
  if (refreshRequired) warn("DECISION_TABLE_REFRESH_REQUIRED", `This configuration creates Tax Rates. Before any invoice, the tax engine's decision table${eng?.id ? "" : " (of the new engine)"} must be refreshed — an explicit, approved step (the refresh action, or Salesforce: App Launcher → Lookup Tables → the table → Refresh). Invoicing is blocked until a successful refresh is newer than the new rates.`, { object: "DecisionTable" });

  /* ── 11. Permission & limits ── */
  const writes = steps.filter(s => s.action === "create" || s.action === "update");
  const taxWrites = writes.filter(s => s.object.startsWith("Tax") || s.object === "GeoCountry");
  if (taxWrites.length && ctx.taxAdminMissing) error("TAX_ADMIN_MISSING", `${TAX_ADMIN_MISSING} It's needed to create tax configuration.`, { action: "Assign Tax Admin to yourself from Tax → Engine Readiness (only for your own user)." });
  for (const phase of ["create", "activate", "map"] as StepPhase[]) {
    const n = writes.filter(s => s.phase === phase).length;
    if (n > MAX_PER_PHASE) error("TOO_MANY_RECORDS", `This configuration writes ${n} records in one step (limit ${MAX_PER_PHASE} for an all-or-nothing Salesforce request) — split it into smaller requests.`);
  }

  const order: Record<StepPhase, number> = { create: 0, activate: 1, map: 2 };
  steps.sort((a, b) => order[a.phase] - order[b.phase]);
  const counts = { create: steps.filter(s => s.action === "create").length, reuse: steps.filter(s => s.action === "reuse").length, update: steps.filter(s => s.action === "update").length, blocked: steps.filter(s => s.action === "blocked").length };
  const token = createHash("sha256").update(JSON.stringify([ctx.connection.orgId, ctx.connection.userId, steps.map(s => [s.id, s.action, s.recordId, s.fields])])).digest("hex").slice(0, 32);
  const ok = !issues.some(i => i.severity === "error");
  // Field-level preview: labels/types/lookup targets from describe, and names of existing records the values point at.
  const fieldInfo: TaxPlan["fieldInfo"] = {};
  for (const s of steps) {
    const o = objectMeta(meta, s.object);
    if (!o) continue;
    const info = (fieldInfo[s.object] ??= {});
    for (const f of [...Object.keys(s.fields), ...Object.keys(s.expect)]) { const fm = o.fields[f]; if (fm && !info[f]) info[f] = { label: fm.label, type: fm.type, referenceTo: fm.referenceTo }; }
  }
  const refNames: TaxPlan["refNames"] = {};
  const put = (id: string | null | undefined, name: string) => { if (id) refNames[id] = name; };
  snap.engines.forEach(e => put(e.id, e.name)); snap.policies.forEach(p => put(p.id, p.name)); snap.treatments.forEach(t => put(t.id, t.name));
  snap.legalEntities.forEach(l => put(l.id, l.name)); snap.geoCountries.forEach(g => put(g.id, `${g.name} (${g.iso})`)); snap.items.forEach(i => put(i.id, i.name));
  for (const r of ctx.products.values()) if (r.status === "found") put(r.product.id, r.product.name);
  return {
    success: true, ok, connection: ctx.connection, apiVersion: meta.apiVersion, spec,
    resolved: {
      engine: eng ? { id: eng.id ?? "(new)", name: eng.name, type: eng.type } : null,
      legalEntity: le ? { id: le.id, name: le.name } : null,
      country: country ? { iso: country.iso, name: country.name, geoCountryId: country.geoCountryId } : null,
      policy: { id: policyRow?.id ?? null, name: policyName, selection: selection ?? spec.policy.treatmentSelection ?? "Default", status: policyRow?.status ?? null },
      treatments: desired.map(d => { const tr = treatments.get(d.spec.key); return { key: d.spec.key, id: tr?.row?.id ?? null, name: tr?.name ?? d.spec.name ?? d.spec.key, taxable: d.spec.taxable, taxCode: d.code?.code ?? null, rate: d.code?.rate ?? null, useItems: !!d.spec.useItems, legalEntity: d.le ? { id: d.le.id, name: d.le.name } : null, isDefault: d.spec.key === defaultKey }; }),
      items: resolvedItems, products: resolvedProducts, taxCodes: rateCodes,
    },
    steps, issues, counts,
    summary: steps.map(s => ({ object: s.object, label: s.label, action: s.action, recordId: s.recordId && !isRef(s.recordId) ? s.recordId : null, detail: s.detail })),
    fieldInfo, refNames, token, refreshRequired,
  };
}

/** Resolve everything in the connected org and plan — read-only. */
export async function planTaxConfiguration(client: SalesforceClient, spec: TaxConfigSpec): Promise<TaxPlan> {
  const meta = await discoverTaxMetadata(client);
  const [snapshot, connection, taxAdmin] = await Promise.all([loadSnapshot(client, meta), getTaxConnection(client), getTaxAdminStatus(client)]);
  const products = new Map<string, ProductResolution>();
  await Promise.all(allProductRefs(spec).map(async r => { products.set(productKey(r), await resolveProductRef(client, meta, r)); }));
  return buildPlan({ snapshot, spec, products, connection, today: new Date().toISOString().slice(0, 10), taxAdminMissing: taxAdmin.status === "missing", productsByTaxCode: await productsByTaxCode(client, snapshot) });
}

/** Read-only: which products reach each tax code today (policy → active treatment's code, or a Tax Treatment Item's code). */
async function productsByTaxCode(client: SalesforceClient, snap: TaxSnapshot): Promise<NonNullable<PlanContext["productsByTaxCode"]>> {
  const out: NonNullable<PlanContext["productsByTaxCode"]> = {};
  const push = (code: string | null, p: { name: string; code: string | null; viaItems: boolean }) => {
    if (!code) return;
    const list = (out[code.toUpperCase()] ??= []);
    if (!list.some(x => x.name === p.name)) list.push(p);
  };
  const live = snap.treatments.filter(t => t.status !== "Inactive" && t.taxable);
  const policyProducts = await productsByPolicy(client, snap.meta, [...new Set(live.filter(t => !t.useItems && t.taxCode && t.policyId).map(t => t.policyId!))]).catch(() => []);
  for (const t of live) if (!t.useItems && t.taxCode) for (const p of policyProducts.filter(x => x.taxPolicyId === t.policyId)) push(t.taxCode, { name: p.name, code: p.code, viaItems: false });
  for (const i of snap.items) if (live.some(t => t.id === i.treatmentId)) push(i.taxCode, { name: i.productName ?? i.productId ?? i.name, code: i.productCode, viaItems: true });
  return out;
}
