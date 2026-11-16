import type { SalesforceClient } from "@/lib/salesforce/client";
import type { ProductPayload } from "@/lib/products/types";
import { apiUrl, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";
import { resolveProductFields } from "@/lib/products/server/productFieldResolution";
import { persistProductPrice } from "@/lib/products/server/pricebookEntry";
import { parseProductPrice } from "@/lib/products/price";
import {
  isBlocking, RELATION_KEYS, RELATION_META,
  type ConfigValue, type ProductConfiguration, type RecordRef, type RelationKey, type RelationRequest, type RelationResolution, type RevenueConfigResolution,
} from "@/lib/products/revenueConfig";

/**
 * PRODUCT REVENUE CLOUD CONFIGURATION (server): resolve tax/billing relationships by name to real Salesforce records, read a
 * product's complete configuration (Product2 + selling model + catalog/category + price book + tax chain + billing chain)
 * with readiness, and plan/execute targeted updates (before → after). Only Product2.TaxPolicyId and Product2.BillingPolicyId
 * are written for tax/billing; treatments, items and engines are RELATED records that are resolved and verified, never faked
 * onto Product2. Nothing is created here — a missing referenced record is reported.
 */

type Row = Record<string, unknown>;
export interface ConfigApi {
  query(soql: string): Promise<Row[]>;
  /** Field names (+ picklist values) of an object in this org. */
  describe(object: string): Promise<{ name: string; picklistValues?: { value: string; active: boolean }[] }[]>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const rel = (r: Row | undefined | null, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), r ?? undefined);
const same15 = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.slice(0, 15) === b.slice(0, 15);
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const like = (s: string) => soqlEscape(s).replace(/[%_]/g, m => `\\${m}`);

const SELECTS: Record<RelationKey, string[]> = {
  taxPolicy: ["Id", "Name", "Status", "TreatmentSelection", "DefaultTaxTreatmentId"],
  taxTreatment: ["Id", "Name", "Status", "TaxPolicyId", "TaxEngineId", "IsTaxable", "TaxCode", "ProductCode", "ProductId", "LegalEntityId", "ShouldUseTaxTreatmentItems"],
  taxTreatmentItem: ["Id", "Name", "TaxTreatmentId", "ProductId", "TaxCode", "ProductCode"],
  taxEngine: ["Id", "TaxEngineName", "Type", "Status", "DecisionTableId"],
  billingPolicy: ["Id", "Name", "Status", "BillingTreatmentSelection", "DefaultBillingTreatmentId"],
  billingTreatment: ["Id", "Name", "Status", "BillingPolicyId"],
  billingTreatmentItem: ["Id", "Name", "Status", "BillingTreatmentId", "Type", "BillingType"],
};
const STOP = new Set(["tax", "billing", "policy", "treatment", "item", "engine", "the", "a", "an", "and", "of", "for", "to"]);

/** Only the fields that exist in this org (relationship paths kept when their Id field exists). */
async function pick(api: ConfigApi, object: string, wanted: string[]): Promise<string> {
  let names: Set<string>;
  try { names = new Set((await api.describe(object)).map(f => f.name)); } catch { return wanted.filter(f => !f.includes(".")).join(", "); }
  return wanted.filter(f => { const base = f.split(".")[0]; return names.has(f) || (f.includes(".") && names.has(base.endsWith("__r") ? base.replace(/__r$/, "__c") : `${base}Id`)); }).join(", ");
}
const toRef = (key: RelationKey, r: Row): RecordRef & Row => ({ ...r, id: String(r.Id), name: String(r[RELATION_META[key].nameField] ?? r.Name ?? r.Id), status: str(r.Status) });

/* ───────────── Relationship resolution ───────────── */

export async function resolveRelation(api: ConfigApi, key: RelationKey, requested: string, explicitId?: string | null): Promise<RelationResolution> {
  const m = RELATION_META[key];
  const base = { key, label: m.label, object: m.object, storage: m.storage, direct: m.direct, requested, candidates: [] as RecordRef[] };
  const sel = await pick(api, m.object, SELECTS[key]);
  if (explicitId) {
    if (!ID.test(explicitId)) return { ...base, status: "invalid", matchedBy: null, record: null, message: `${explicitId} isn't a valid Salesforce Id.` };
    const [r] = await api.query(`SELECT ${sel} FROM ${m.object} WHERE Id = '${soqlEscape(explicitId)}' LIMIT 1`);
    return r ? { ...base, status: "resolved", matchedBy: "id", record: toRef(key, r), message: `${m.label} "${toRef(key, r).name}" (selected).` } : { ...base, status: "not_found", matchedBy: null, record: null, message: `${m.label} ${explicitId} doesn't exist in this org.` };
  }
  const name = requested.trim();
  if (!name) return { ...base, status: "invalid", matchedBy: null, record: null, message: `No ${m.label} name was given.` };
  const exact = await api.query(`SELECT ${sel} FROM ${m.object} WHERE ${m.nameField} = '${soqlEscape(name)}' ORDER BY CreatedDate LIMIT 10`);
  if (exact.length === 1) return { ...base, status: "resolved", matchedBy: "exact", record: toRef(key, exact[0]), message: `${m.label} "${toRef(key, exact[0]).name}".` };
  if (exact.length > 1) return { ...base, status: "ambiguous", matchedBy: null, record: null, candidates: exact.map(r => toRef(key, r)), message: `${exact.length} ${m.label} records are named "${name}" — choose one.` };
  const tokens = name.split(/[^A-Za-z0-9]+/).filter(w => w.length > 1 && !/^(the|a|an|and|of|for|to)$/i.test(w));
  const words = tokens.filter(w => !STOP.has(w.toLowerCase()));
  if (!words.length) return { ...base, status: "invalid", matchedBy: null, record: null, message: `"${name}" doesn't name a specific ${m.label}.` };
  // Every word first ("India Tax Treatment" → India AND Tax AND Treatment), then only the distinctive ones ("India").
  const likeAll = (ws: string[]) => api.query(`SELECT ${sel} FROM ${m.object} WHERE ${ws.map(w => `${m.nameField} LIKE '%${like(w)}%'`).join(" AND ")} ORDER BY ${m.nameField} LIMIT 20`);
  let partial = tokens.length > words.length ? await likeAll(tokens) : [];
  if (!partial.length) partial = await likeAll(words);
  if (partial.length === 1) return { ...base, status: "resolved", matchedBy: "partial", record: toRef(key, partial[0]), message: `${m.label} "${toRef(key, partial[0]).name}" — matched by partial name "${name}"; confirm it is the intended record.` };
  if (partial.length > 1) return { ...base, status: "ambiguous", matchedBy: null, record: null, candidates: partial.map(r => toRef(key, r)), message: `"${name}" matches ${partial.length} ${m.label} records — choose one.` };
  return { ...base, status: "not_found", matchedBy: null, record: null, message: `${m.label} "${name}" doesn't exist in this org (not created automatically).` };
}

async function byId(api: ConfigApi, key: RelationKey, id: string | null): Promise<(RecordRef & Row) | null> {
  if (!id) return null;
  const [r] = await api.query(`SELECT ${await pick(api, RELATION_META[key].object, SELECTS[key])} FROM ${RELATION_META[key].object} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  return r ? toRef(key, r) : null;
}
const derived = (key: RelationKey, record: RecordRef & Row, from: string): RelationResolution => ({ key, label: RELATION_META[key].label, object: RELATION_META[key].object, storage: RELATION_META[key].storage, direct: RELATION_META[key].direct, requested: `(from ${from})`, status: "derived", matchedBy: "derived", record, candidates: [], message: `${RELATION_META[key].label} "${record.name}" — derived from ${from}.` });
const mismatch = (r: RelationResolution, message: string): RelationResolution => ({ ...r, status: "mismatch", message });

/**
 * Resolve every requested relationship and check that they form ONE consistent Salesforce chain:
 * treatment ∈ policy (and is its default under Default selection), engine = treatment's engine, item ∈ treatment and belongs to
 * THIS product (items are product-specific), billing treatment ∈ billing policy, billing item ∈ billing treatment. A treatment
 * named without its policy derives the policy (Product2 can only reference the policy).
 */
export async function resolveRevenueConfig(api: ConfigApi, input: { relations: RelationRequest; ids?: Partial<Record<RelationKey, string | null>> }, productId: string | null): Promise<RevenueConfigResolution> {
  const out = new Map<RelationKey, RelationResolution>();
  for (const k of RELATION_KEYS) {
    const name = input.relations[k], id = input.ids?.[k];
    if (name || id) out.set(k, await resolveRelation(api, k, name ?? "", id ?? null));
  }
  const ok = (k: RelationKey) => { const r = out.get(k); return r && (r.status === "resolved" || r.status === "derived") ? r.record : null; };
  const warnings: string[] = [];

  /* tax chain */
  let T = ok("taxTreatment");
  if (T && !out.has("taxPolicy")) {
    const p = await byId(api, "taxPolicy", str(T.TaxPolicyId));
    if (p) out.set("taxPolicy", derived("taxPolicy", p, `Tax Treatment "${T.name}"`));
    else out.set("taxTreatment", mismatch(out.get("taxTreatment")!, `Tax Treatment "${T.name}" isn't attached to a Tax Policy — Product2 can only reference a Tax Policy (Product2.TaxPolicyId).`));
  }
  const P = ok("taxPolicy");
  T = ok("taxTreatment");
  if (P && T) {
    if (!same15(T.TaxPolicyId, P.id)) out.set("taxTreatment", mismatch(out.get("taxTreatment")!, `Tax Treatment "${T.name}" belongs to another Tax Policy, not "${P.name}".`));
    else if (P.TreatmentSelection === "Default" && !same15(P.DefaultTaxTreatmentId, T.id)) out.set("taxTreatment", mismatch(out.get("taxTreatment")!, `Tax Policy "${P.name}" uses Default selection and its default treatment isn't "${T.name}" — Salesforce would apply the policy's default instead.`));
    else if (P.TreatmentSelection !== "Default") warnings.push(`Tax Policy "${P.name}" uses ${P.TreatmentSelection ?? "—"} selection — Salesforce picks the treatment ${P.TreatmentSelection === "LegalEntity" ? "by the sale's legal entity" : "on the order product"}.`);
  }
  if (P && P.status !== "Active") warnings.push(`Tax Policy "${P.name}" is ${P.status ?? "not Active"}.`);
  const effectiveT = ok("taxTreatment") ?? (P && P.TreatmentSelection === "Default" ? await byId(api, "taxTreatment", str(P.DefaultTaxTreatmentId)) : null);
  const E = ok("taxEngine");
  if (E && effectiveT && !same15(effectiveT.TaxEngineId, E.id)) out.set("taxEngine", mismatch(out.get("taxEngine")!, `Tax Engine "${E.name}" isn't the engine of Tax Treatment "${effectiveT.name}" — the engine comes from the treatment (TaxTreatment.TaxEngineId).`));
  if (E && !effectiveT) warnings.push(`Tax Engine "${E.name}" can only be verified through a Tax Treatment — none resolved.`);
  const TI = ok("taxTreatmentItem");
  if (TI) {
    if (effectiveT && !same15(TI.TaxTreatmentId, effectiveT.id)) out.set("taxTreatmentItem", mismatch(out.get("taxTreatmentItem")!, `Tax Treatment Item "${TI.name}" belongs to another treatment, not "${effectiveT.name}".`));
    else if (!productId) out.set("taxTreatmentItem", { ...mismatch(out.get("taxTreatmentItem")!, `Tax Treatment Items are product-specific (TaxTreatmentItem.ProductId): "${TI.name}" belongs to an existing product. A new product needs its own item under "${effectiveT?.name ?? "the treatment"}" — a pending dependency, not created automatically.`), dependency: true });
    else if (!same15(TI.ProductId, productId)) out.set("taxTreatmentItem", mismatch(out.get("taxTreatmentItem")!, `Tax Treatment Items are product-specific (TaxTreatmentItem.ProductId): "${TI.name}" belongs to another product. This product needs its own item under the treatment — not created automatically.`));
  }

  /* billing chain */
  let BT = ok("billingTreatment");
  if (BT && !out.has("billingPolicy")) {
    const p = await byId(api, "billingPolicy", str(BT.BillingPolicyId));
    if (p) out.set("billingPolicy", derived("billingPolicy", p, `Billing Treatment "${BT.name}"`));
    else out.set("billingTreatment", mismatch(out.get("billingTreatment")!, `Billing Treatment "${BT.name}" isn't attached to a Billing Policy — Product2 can only reference a Billing Policy (Product2.BillingPolicyId).`));
  }
  const BP = ok("billingPolicy");
  BT = ok("billingTreatment");
  if (BP && BT) {
    if (!same15(BT.BillingPolicyId, BP.id)) out.set("billingTreatment", mismatch(out.get("billingTreatment")!, `Billing Treatment "${BT.name}" belongs to another Billing Policy, not "${BP.name}".`));
    else if (BP.BillingTreatmentSelection === "Default" && !same15(BP.DefaultBillingTreatmentId, BT.id)) out.set("billingTreatment", mismatch(out.get("billingTreatment")!, `Billing Policy "${BP.name}" uses Default selection and its default treatment isn't "${BT.name}".`));
  }
  if (BP && BP.status !== "Active") warnings.push(`Billing Policy "${BP.name}" is ${BP.status ?? "not Active"}.`);
  const effectiveBT = ok("billingTreatment") ?? (BP && BP.BillingTreatmentSelection === "Default" ? await byId(api, "billingTreatment", str(BP.DefaultBillingTreatmentId)) : null);
  const BTI = ok("billingTreatmentItem");
  if (BTI && effectiveBT && !same15(BTI.BillingTreatmentId, effectiveBT.id)) out.set("billingTreatmentItem", mismatch(out.get("billingTreatmentItem")!, `Billing Treatment Item "${BTI.name}" belongs to another treatment, not "${effectiveBT.name}".`));
  if (BTI && !effectiveBT) warnings.push(`Billing Treatment Item "${BTI.name}" can only be verified through a Billing Treatment — none resolved.`);

  const resolutions = RELATION_KEYS.filter(k => out.has(k)).map(k => out.get(k)!);
  for (const r of resolutions) if (r.matchedBy === "partial" || r.dependency) warnings.push(r.message);
  const fp = ok("taxPolicy"), fb = ok("billingPolicy");
  return {
    resolutions,
    product2: { ...(fp ? { TaxPolicyId: fp.id } : {}), ...(fb ? { BillingPolicyId: fb.id } : {}) },
    blockers: resolutions.filter(r => isBlocking(r.status) && !r.dependency).map(r => `${r.label}: ${r.message}`),
    warnings,
  };
}

/* ───────────── Read the complete configuration ───────────── */

const cv = <T = string>(value: T | null, source: string, direct: boolean, record?: RecordRef | null, note?: string | null): ConfigValue<T> => ({ value, source, direct, record: record ?? null, note: note ?? null });

export async function readProductConfiguration(api: ConfigApi, productId: string): Promise<ProductConfiguration> {
  if (!ID.test(productId)) throw new Error("Invalid Product Id.");
  const psel = await pick(api, "Product2", ["Id", "Name", "ProductCode", "Family", "Description", "IsActive", "TaxPolicyId", "BillingPolicyId", "QuantityUnitOfMeasure", "UnitOfMeasureId", "UnitOfMeasure.Name"]);
  const [p] = await api.query(`SELECT ${psel} FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`);
  if (!p) throw new Error(`Product ${productId} doesn't exist in this org.`);
  const notes: Record<string, string> = {};
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => { try { return await fn(); } catch (e) { notes[label] = `${label} couldn't be read: ${(e as Error).message}`; return fallback; } };

  const uomName = str(rel(p, "UnitOfMeasure.Name")), uomPick = str(p.QuantityUnitOfMeasure);
  const unitOfMeasure = cv(uomName ?? uomPick, uomName ? "Product2.UnitOfMeasureId" : "Product2.QuantityUnitOfMeasure", true, uomName && p.UnitOfMeasureId ? { id: String(p.UnitOfMeasureId), name: uomName } : null, uomName && uomPick && uomName !== uomPick ? `Quantity Unit Of Measure picklist: ${uomPick}` : null);

  const sellingModels = await safe("Product Selling Models", async () => (await api.query(`SELECT Id, ProductSellingModelId, ProductSellingModel.Name, ProductSellingModel.SellingModelType FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(productId)}'`))
    .map(r => ({ id: String(r.ProductSellingModelId), name: String(rel(r, "ProductSellingModel.Name") ?? r.ProductSellingModelId), type: str(rel(r, "ProductSellingModel.SellingModelType")) })), []);
  const cats = await safe("Catalog / Category", () => api.query(`SELECT Id, ProductCategoryId, ProductCategory.Name, ProductCategory.CatalogId, ProductCategory.Catalog.Name FROM ProductCategoryProduct WHERE ProductId = '${soqlEscape(productId)}'`), [] as Row[]);
  const categories = cats.map(r => ({ id: String(r.ProductCategoryId), name: String(rel(r, "ProductCategory.Name") ?? r.ProductCategoryId), catalog: str(rel(r, "ProductCategory.Catalog.Name")) }));
  const catalogs = [...new Map(cats.filter(r => rel(r, "ProductCategory.CatalogId")).map(r => [String(rel(r, "ProductCategory.CatalogId")), { id: String(rel(r, "ProductCategory.CatalogId")), name: String(rel(r, "ProductCategory.Catalog.Name") ?? "") }])).values()];
  const pbeSel = await pick(api, "PricebookEntry", ["Id", "UnitPrice", "IsActive", "Pricebook2Id", "Pricebook2.Name", "Pricebook2.IsStandard", "ProductSellingModel.Name"]);
  const pricebookEntries = await safe("Pricebook Entries", async () => (await api.query(`SELECT ${pbeSel} FROM PricebookEntry WHERE Product2Id = '${soqlEscape(productId)}' ORDER BY Pricebook2.IsStandard DESC LIMIT 20`))
    .map(r => ({ id: String(r.Id), pricebook: { id: String(r.Pricebook2Id), name: String(rel(r, "Pricebook2.Name") ?? ""), isStandard: rel(r, "Pricebook2.IsStandard") === true }, unitPrice: num(r.UnitPrice), isActive: r.IsActive === true, sellingModel: str(rel(r, "ProductSellingModel.Name")) })), []);

  /* tax */
  const tp = await safe("Tax Policy", () => byId(api, "taxPolicy", str(p.TaxPolicyId)), null);
  let tt: (RecordRef & Row) | null = null;
  let treatmentNote: string | null = null;
  if (tp) {
    if (tp.TreatmentSelection === "Default") tt = await safe("Tax Treatment", () => byId(api, "taxTreatment", str(tp.DefaultTaxTreatmentId)), null);
    else {
      const list = await safe("Tax Treatment", () => api.query(`SELECT Id, Name, Status FROM TaxTreatment WHERE TaxPolicyId = '${soqlEscape(tp.id)}' ORDER BY Name LIMIT 20`), [] as Row[]);
      treatmentNote = `Tax Policy uses ${tp.TreatmentSelection ?? "—"} selection — Salesforce chooses among: ${list.map(r => r.Name).join(", ") || "none"}.`;
    }
  }
  const usesItems = tt ? tt.ShouldUseTaxTreatmentItems === true : null;
  const item = tt && usesItems ? await safe("Tax Treatment Item", async () => { const [r] = await api.query(`SELECT ${await pick(api, "TaxTreatmentItem", SELECTS.taxTreatmentItem)} FROM TaxTreatmentItem WHERE TaxTreatmentId = '${soqlEscape(tt!.id)}' AND ProductId = '${soqlEscape(productId)}' LIMIT 1`); return r ? toRef("taxTreatmentItem", r) : null; }, null) : null;
  const engine = tt ? await safe("Tax Engine", () => byId(api, "taxEngine", str(tt!.TaxEngineId)), null) : null;
  const taxCode = item ? str(item.TaxCode) : tt ? str(tt.TaxCode) : null;

  /* billing */
  const bp = await safe("Billing Policy", () => byId(api, "billingPolicy", str(p.BillingPolicyId)), null);
  const bt = bp && bp.BillingTreatmentSelection === "Default" ? await safe("Billing Treatment", () => byId(api, "billingTreatment", str(bp.DefaultBillingTreatmentId)), null) : null;
  const bItems = bt ? await safe("Billing Treatment Items", async () => (await api.query(`SELECT ${await pick(api, "BillingTreatmentItem", SELECTS.billingTreatmentItem)} FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(bt.id)}' ORDER BY Name`)).map(r => ({ ...toRef("billingTreatmentItem", r), billingType: str(r.BillingType), type: str(r.Type) })), []) : [];

  const cfg: ProductConfiguration = {
    product: { id: String(p.Id), name: String(p.Name), code: str(p.ProductCode), family: str(p.Family), description: str(p.Description), isActive: p.IsActive === true, unitOfMeasure },
    revenue: { sellingModels, catalogs, categories, pricebookEntries },
    tax: {
      policy: { ...cv(tp?.name ?? null, "Product2.TaxPolicyId", true, tp, notes["Tax Policy"]), selection: str(tp?.TreatmentSelection) },
      treatment: { ...cv(tt?.name ?? null, "TaxPolicy.DefaultTaxTreatmentId", false, tt, treatmentNote ?? notes["Tax Treatment"]), taxable: tt ? tt.IsTaxable === true : null, usesItems, engineId: str(tt?.TaxEngineId) },
      treatmentItem: cv(item?.name ?? null, "TaxTreatmentItem (TaxTreatmentId + ProductId)", false, item, tt && usesItems === false ? "The treatment doesn't use Tax Treatment Items." : notes["Tax Treatment Item"]),
      engine: { ...cv(engine?.name ?? null, "TaxTreatment.TaxEngineId", false, engine, notes["Tax Engine"]), type: str(engine?.Type), decisionTableId: str(engine?.DecisionTableId) },
      taxCode: cv(taxCode, item ? "TaxTreatmentItem.TaxCode" : "TaxTreatment.TaxCode", false),
      taxable: cv<boolean>(tt ? tt.IsTaxable === true : null, "TaxTreatment.IsTaxable", false),
    },
    billing: {
      policy: { ...cv(bp?.name ?? null, "Product2.BillingPolicyId", true, bp, notes["Billing Policy"]), selection: str(bp?.BillingTreatmentSelection) },
      treatment: cv(bt?.name ?? null, "BillingPolicy.DefaultBillingTreatmentId", false, bt, bp && bp.BillingTreatmentSelection !== "Default" ? `Billing Policy uses ${bp.BillingTreatmentSelection} selection.` : notes["Billing Treatment"]),
      treatmentItems: bItems,
    },
    readiness: { ready: false, checks: [], missing: [] },
  };
  cfg.readiness = productReadiness(cfg);
  return cfg;
}

/** Pure: is this product configured for Order → Billing → Tax calculation? Every gap is named. */
export function productReadiness(c: ProductConfiguration): ProductConfiguration["readiness"] {
  const checks: ProductConfiguration["readiness"]["checks"] = [];
  const add = (id: string, label: string, passed: boolean, detail: string) => checks.push({ id, label, passed, detail });
  const active = (r: RecordRef | null | undefined) => !!r && r.status === "Active";
  add("product-active", "Product active", c.product.isActive, c.product.isActive ? "Active" : "Product2.IsActive is false");
  add("selling-model", "Product Selling Model assigned", c.revenue.sellingModels.length > 0, c.revenue.sellingModels.map(s => s.name).join(", ") || "No ProductSellingModelOption");
  add("catalog", "Catalog assigned", c.revenue.catalogs.length > 0, c.revenue.catalogs.map(s => s.name).join(", ") || "No catalog (via category)");
  add("category", "Category assigned", c.revenue.categories.length > 0, c.revenue.categories.map(s => s.name).join(", ") || "No ProductCategoryProduct");
  const pbe = c.revenue.pricebookEntries.find(e => e.isActive) ?? c.revenue.pricebookEntries[0];
  add("pricebook-entry", "Pricebook Entry exists", !!pbe && pbe.isActive, pbe ? `${pbe.pricebook.name}${pbe.isActive ? "" : " (inactive)"}` : "No PricebookEntry");
  add("unit-price", "Unit Price configured", !!pbe && pbe.unitPrice !== null, pbe?.unitPrice !== null && pbe?.unitPrice !== undefined ? String(pbe.unitPrice) : "No price");
  const t = c.tax;
  add("tax-policy", "Tax Policy assigned", active(t.policy.record), t.policy.record ? `${t.policy.record.name} · ${t.policy.record.status ?? "—"}` : "Product2.TaxPolicyId is empty");
  add("tax-treatment", "Tax Treatment resolved", active(t.treatment.record), t.treatment.record ? `${t.treatment.record.name} · ${t.treatment.record.status ?? "—"} · ${t.treatment.taxable ? "taxable" : "not taxable"}` : t.treatment.note ?? "No treatment resolves from the policy");
  if (t.treatment.usesItems) add("tax-treatment-item", "Tax Treatment Item for this product", !!t.treatmentItem.record, t.treatmentItem.record ? `${t.treatmentItem.record.name} · ${t.taxCode.value ?? "no tax code"}` : "The treatment uses items and none exists for this product");
  if (t.treatment.taxable !== false) add("tax-engine", "Tax Engine resolved", active(t.engine.record), t.engine.record ? `${t.engine.record.name} · ${t.engine.type ?? "—"} · ${t.engine.record.status ?? "—"}` : "No engine on the treatment");
  const b = c.billing;
  add("billing-policy", "Billing Policy assigned", active(b.policy.record), b.policy.record ? `${b.policy.record.name} · ${b.policy.record.status ?? "—"}` : "Product2.BillingPolicyId is empty");
  add("billing-treatment", "Billing Treatment resolved", active(b.treatment.record), b.treatment.record ? `${b.treatment.record.name} · ${b.treatment.record.status ?? "—"}` : b.treatment.note ?? "No default billing treatment");
  add("billing-treatment-item", "Billing Treatment Item resolved", b.treatmentItems.some(i => i.status === "Active"), b.treatmentItems.map(i => `${i.name} · ${i.status ?? "—"}`).join(", ") || "No billing treatment item");
  const missing = checks.filter(x => !x.passed).map(x => x.label.replace(/ (assigned|resolved|exists|configured|for this product)$/, "").replace(/^Product active$/, "Active product"));
  return { ready: missing.length === 0, checks, missing };
}

/* ───────────── Unit of Measure options (from Salesforce, never hardcoded) ───────────── */

export async function unitOfMeasureOptions(api: ConfigApi): Promise<{ value: string; source: "UnitOfMeasure" | "QuantityUnitOfMeasure"; id?: string }[]> {
  const out: { value: string; source: "UnitOfMeasure" | "QuantityUnitOfMeasure"; id?: string }[] = [];
  const fields = await api.describe("Product2");
  if (fields.some(f => f.name === "UnitOfMeasureId")) {
    // One option per name (an org can hold several UnitOfMeasure records with the same name — e.g. two "MB" in p10).
    try { for (const r of await api.query("SELECT Id, Name, UnitCode, Status FROM UnitOfMeasure ORDER BY Name LIMIT 200")) if ((!r.Status || r.Status === "Active") && !out.some(o => o.value.toLowerCase() === String(r.Name).toLowerCase())) out.push({ value: String(r.Name), source: "UnitOfMeasure", id: String(r.Id) }); } catch { /* UnitOfMeasure not queryable */ }
  }
  for (const v of fields.find(f => f.name === "QuantityUnitOfMeasure")?.picklistValues ?? []) if (v.active && !out.some(o => o.value.toLowerCase() === v.value.toLowerCase())) out.push({ value: v.value, source: "QuantityUnitOfMeasure" });
  return out;
}

/* ───────────── Find a product by name / code ───────────── */

export async function findProduct(api: ConfigApi, ref: string): Promise<{ status: "found" | "not_found" | "ambiguous"; product: RecordRef & { code: string | null } | null; candidates: (RecordRef & { code: string | null })[] }> {
  const s = ref.trim();
  if (ID.test(s)) { const [r] = await api.query(`SELECT Id, Name, ProductCode FROM Product2 WHERE Id = '${soqlEscape(s)}'`); return r ? { status: "found", product: { id: String(r.Id), name: String(r.Name), code: str(r.ProductCode) }, candidates: [] } : { status: "not_found", product: null, candidates: [] }; }
  const rows = await api.query(`SELECT Id, Name, ProductCode, IsActive FROM Product2 WHERE Name = '${soqlEscape(s)}' OR ProductCode = '${soqlEscape(s)}' ORDER BY CreatedDate LIMIT 10`);
  const refs = rows.map(r => ({ id: String(r.Id), name: String(r.Name), code: str(r.ProductCode), status: r.IsActive ? "Active" : "Inactive" }));
  return refs.length === 1 ? { status: "found", product: refs[0], candidates: [] } : refs.length ? { status: "ambiguous", product: null, candidates: refs } : { status: "not_found", product: null, candidates: [] };
}

/* ───────────── Targeted update: plan (before → after) and execute ───────────── */

export interface ProductConfigChange {
  relations?: RelationRequest;
  ids?: Partial<Record<RelationKey, string | null>>;
  unitOfMeasure?: string | null;
  unitPrice?: string | number | null;
  priceBook?: string | null;
}
export interface ProductUpdatePlan {
  productId: string;
  before: ProductConfiguration;
  changes: { field: string; label: string; storage: string; from: string | null; to: string | null }[];
  resolution: RevenueConfigResolution | null;
  blockers: string[];
  warnings: string[];
}

export async function planProductUpdate(api: ConfigApi, productId: string, change: ProductConfigChange): Promise<ProductUpdatePlan> {
  const before = await readProductConfiguration(api, productId);
  const blockers: string[] = [], warnings: string[] = [];
  const changes: ProductUpdatePlan["changes"] = [];
  const wantsRel = RELATION_KEYS.some(k => change.relations?.[k] || change.ids?.[k]);
  const resolution = wantsRel ? await resolveRevenueConfig(api, { relations: change.relations ?? {}, ids: change.ids }, productId) : null;
  if (resolution) {
    blockers.push(...resolution.blockers); warnings.push(...resolution.warnings);
    const tp = resolution.resolutions.find(r => r.key === "taxPolicy"), bp = resolution.resolutions.find(r => r.key === "billingPolicy");
    if (resolution.product2.TaxPolicyId && !same15(resolution.product2.TaxPolicyId, before.tax.policy.record?.id)) changes.push({ field: "TaxPolicyId", label: "Tax Policy", storage: "Product2.TaxPolicyId", from: before.tax.policy.record ? `${before.tax.policy.record.name} (${before.tax.policy.record.id})` : null, to: `${tp!.record!.name} (${tp!.record!.id})` });
    if (resolution.product2.BillingPolicyId && !same15(resolution.product2.BillingPolicyId, before.billing.policy.record?.id)) changes.push({ field: "BillingPolicyId", label: "Billing Policy", storage: "Product2.BillingPolicyId", from: before.billing.policy.record ? `${before.billing.policy.record.name} (${before.billing.policy.record.id})` : null, to: `${bp!.record!.name} (${bp!.record!.id})` });
    for (const r of resolution.resolutions.filter(x => !x.direct && !isBlocking(x.status))) warnings.push(`${r.label} "${r.record?.name}" is a related record — verified through the policy, not written to Product2.`);
  }
  if (change.unitOfMeasure) {
    const opts = await unitOfMeasureOptions(api);
    const hit = opts.find(o => o.value.toLowerCase() === change.unitOfMeasure!.trim().toLowerCase());
    if (!hit) blockers.push(`Unit of Measure "${change.unitOfMeasure}" isn't a UnitOfMeasure record or Quantity Unit Of Measure value in this org (valid: ${opts.map(o => o.value).join(", ") || "none"}).`);
    else if ((before.product.unitOfMeasure.value ?? "").toLowerCase() !== hit.value.toLowerCase()) changes.push({ field: "UnitOfMeasure", label: "Unit of Measure", storage: hit.source === "UnitOfMeasure" ? "Product2.UnitOfMeasureId" : "Product2.QuantityUnitOfMeasure", from: before.product.unitOfMeasure.value, to: hit.value });
  }
  if (change.unitPrice !== null && change.unitPrice !== undefined && change.unitPrice !== "") {
    const price = parseProductPrice(String(change.unitPrice));
    if (!price?.ok) blockers.push(price && !price.ok ? price.error : `"${change.unitPrice}" isn't a valid price.`);
    else {
      const pb = change.priceBook?.trim() || "Standard Price Book";
      const cur = before.revenue.pricebookEntries.find(e => (pb === "Standard Price Book" ? e.pricebook.isStandard : e.pricebook.name === pb));
      if (cur?.unitPrice !== price.value) changes.push({ field: "UnitPrice", label: `Unit Price (${pb})`, storage: "PricebookEntry.UnitPrice", from: cur?.unitPrice !== undefined && cur?.unitPrice !== null ? String(cur.unitPrice) : null, to: String(price.value) });
    }
  }
  if (!changes.length && !blockers.length) warnings.push("Nothing to change — the product already has the requested configuration.");
  return { productId, before, changes, resolution, blockers, warnings };
}

export interface ProductUpdateOutcome { ok: boolean; plan: ProductUpdatePlan; after: ProductConfiguration | null; verification: { label: string; expected: string | null; actual: string | null; passed: boolean }[]; errors: string[] }

/** Re-plans server-side (never trusting the preview), writes ONLY the planned changes, re-reads Salesforce and verifies each. */
export async function executeProductUpdate(client: SalesforceClient, api: ConfigApi, productId: string, change: ProductConfigChange): Promise<ProductUpdateOutcome> {
  const plan = await planProductUpdate(api, productId, change);
  if (plan.blockers.length) return { ok: false, plan, after: null, verification: [], errors: plan.blockers };
  const errors: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const c of plan.changes) {
    if (c.field === "TaxPolicyId") patch.TaxPolicyId = plan.resolution!.product2.TaxPolicyId;
    if (c.field === "BillingPolicyId") patch.BillingPolicyId = plan.resolution!.product2.BillingPolicyId;
  }
  if (plan.changes.some(c => c.field === "UnitOfMeasure")) {
    const r = await resolveProductFields(client, { unitOfMeasure: change.unitOfMeasure ?? undefined }, { forUpdate: true });
    Object.assign(patch, r.fields);
    errors.push(...r.skipped.map(s => s.reason));
  }
  if (Object.keys(patch).length) {
    try { await client.updateRecord("Product2", productId, patch); }
    catch (e) { errors.push(`Product2 update failed: ${(e as Error).message}`); return { ok: false, plan, after: null, verification: [], errors }; }
  }
  if (plan.changes.some(c => c.field === "UnitPrice")) {
    const price = parseProductPrice(String(change.unitPrice))!;
    if (price.ok) {
      const out = await persistProductPrice(client, { productId, unitPrice: price.value, priceBook: change.priceBook ?? undefined, isActive: plan.before.product.isActive });
      if (!out.entry) errors.push(out.error ?? "The price wasn't saved.");
    }
  }
  const after = await readProductConfiguration(api, productId);
  const actualOf = (field: string) => field === "TaxPolicyId" ? (after.tax.policy.record ? `${after.tax.policy.record.name} (${after.tax.policy.record.id})` : null)
    : field === "BillingPolicyId" ? (after.billing.policy.record ? `${after.billing.policy.record.name} (${after.billing.policy.record.id})` : null)
    : field === "UnitOfMeasure" ? after.product.unitOfMeasure.value
    : field === "UnitPrice" ? (() => { const pb = change.priceBook?.trim() || "Standard Price Book"; const e = after.revenue.pricebookEntries.find(x => (pb === "Standard Price Book" ? x.pricebook.isStandard : x.pricebook.name === pb)); return e?.unitPrice !== null && e?.unitPrice !== undefined ? String(e.unitPrice) : null; })()
    : null;
  const verification = plan.changes.map(c => { const actual = actualOf(c.field); return { label: c.label, expected: c.to, actual, passed: (actual ?? "").toLowerCase() === (c.to ?? "").toLowerCase() }; });
  return { ok: !errors.length && verification.every(v => v.passed), plan, after, verification, errors };
}

/* ───────────── Real API (the org's tax/billing-capable API version) ───────────── */

export async function configApiFor(client: SalesforceClient): Promise<ConfigApi> {
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const cache = new Map<string, Promise<{ name: string; picklistValues?: { value: string; active: boolean }[] }[]>>();
  return {
    query: soql => queryAt(client, v, soql),
    describe: object => {
      if (!cache.has(object)) cache.set(object, client.request<{ fields: { name: string; picklistValues?: { value: string; active: boolean }[] }[] }>(apiUrl(client, v, `/sobjects/${object}/describe`)).then(d => d.fields));
      return cache.get(object)!;
    },
  };
}

/* ───────────── Create / edit integration ───────────── */

/** The tax/billing relationships a product payload requests (names + explicit Ids). */
export function relationsOf(p: Partial<ProductPayload>): { relations: RelationRequest; ids: Partial<Record<RelationKey, string>>; requested: boolean } {
  const relations: RelationRequest = {};
  for (const k of RELATION_KEYS) { const v = p[k]; if (typeof v === "string" && v.trim()) relations[k] = v.trim(); }
  const ids = Object.fromEntries(Object.entries(p.relationIds ?? {}).filter(([k, v]) => RELATION_KEYS.includes(k as RelationKey) && typeof v === "string" && v)) as Partial<Record<RelationKey, string>>;
  return { relations, ids, requested: Object.keys(relations).length > 0 || Object.keys(ids).length > 0 };
}

/** Compare what was requested (resolved records + tax code) with the configuration re-read from Salesforce. */
export function verifyRequestedConfiguration(cfg: ProductConfiguration, resolution: RevenueConfigResolution | null, taxCode?: string | null): { label: string; expected: string | null; actual: string | null; passed: boolean }[] {
  const out: { label: string; expected: string | null; actual: string | null; passed: boolean }[] = [];
  const actualOf: Record<RelationKey, () => RecordRef[]> = {
    taxPolicy: () => (cfg.tax.policy.record ? [cfg.tax.policy.record] : []),
    taxTreatment: () => (cfg.tax.treatment.record ? [cfg.tax.treatment.record] : []),
    taxTreatmentItem: () => (cfg.tax.treatmentItem.record ? [cfg.tax.treatmentItem.record] : []),
    taxEngine: () => (cfg.tax.engine.record ? [cfg.tax.engine.record] : []),
    billingPolicy: () => (cfg.billing.policy.record ? [cfg.billing.policy.record] : []),
    billingTreatment: () => (cfg.billing.treatment.record ? [cfg.billing.treatment.record] : []),
    billingTreatmentItem: () => cfg.billing.treatmentItems,
  };
  for (const r of resolution?.resolutions ?? []) {
    if (!r.record || isBlocking(r.status) && !r.dependency) continue;
    const actual = actualOf[r.key]();
    out.push({ label: r.label, expected: `${r.record.name} (${r.record.id})`, actual: actual.map(a => `${a.name} (${a.id})`).join(", ") || null, passed: actual.some(a => same15(a.id, r.record!.id)) });
  }
  if (taxCode) out.push({ label: "Tax Code", expected: taxCode, actual: cfg.tax.taxCode.value, passed: (cfg.tax.taxCode.value ?? "").toLowerCase() === taxCode.toLowerCase() });
  return out;
}
