import type { RecordRef, TaxConfigSpec, TaxEngineSpec, TaxItemSpec, TaxTreatmentSpec } from "@/lib/tax/types";

/**
 * Normalises an untrusted request body (from the AI interpretation or the Manual form) into a TaxConfigSpec. Shapes and limits
 * only — no Salesforce knowledge here; every value is resolved against the org by the planner.
 */

export class SpecError extends Error { constructor(message: string, readonly field: string) { super(message); } }

const MAX_TREATMENTS = 10, MAX_ITEMS = 50, MAX_PRODUCTS = 50;
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

const s = (v: unknown, max = 255): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const n = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) { const x = Number(v.replace(/[%\s,]/g, "")); return Number.isFinite(x) ? x : null; }
  return null;
};
const id = (v: unknown): string | null => (typeof v === "string" && SFID.test(v.trim()) ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(x => x && typeof x === "object").map(x => x as Record<string, unknown>) : []);
const ref = (v: unknown): RecordRef | null => {
  if (typeof v === "string") return s(v) ? { name: s(v) } : null;
  const o = obj(v);
  const r = { id: id(o.id), name: s(o.name) };
  return r.id || r.name ? r : null;
};
const date = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);

export function normalizeSpec(body: unknown): TaxConfigSpec {
  const root = obj(obj(body).spec ?? body);
  const e = obj(root.engine);
  const addr = obj(e.address);
  const engine: TaxEngineSpec | null = Object.keys(e).length ? {
    existingId: id(e.existingId), name: s(e.name, 80), type: s(e.type, 80), providerId: id(e.providerId), namedCredentialId: id(e.namedCredentialId), sellerCode: s(e.sellerCode, 255),
    address: Object.keys(addr).length ? { street: s(addr.street), city: s(addr.city, 40), state: s(addr.state, 80), postalCode: s(addr.postalCode, 20), country: s(addr.country, 80) } : null,
  } : null;
  const p = obj(root.policy);

  const rawTreatments = arr(root.treatments);
  if (rawTreatments.length > MAX_TREATMENTS) throw new SpecError(`At most ${MAX_TREATMENTS} tax treatments per configuration.`, "treatments");
  const keys = new Set<string>();
  const treatments: TaxTreatmentSpec[] = rawTreatments.map((t, i) => {
    let key = s(t.key, 40) ?? `t${i + 1}`;
    while (keys.has(key)) key = `${key}_${i + 1}`;
    keys.add(key);
    const rate = n(t.rate);
    if (rate !== null && (rate < 0 || rate > 100)) throw new SpecError(`Treatment ${i + 1}: a tax rate must be between 0 and 100%.`, `treatments.${i}.rate`);
    return {
      key, existingId: id(t.existingId), name: s(t.name, 80), suggestedName: s(t.suggestedName, 80), description: s(t.description, 1000),
      taxable: t.taxable !== false, taxCode: s(t.taxCode, 80), taxName: s(t.taxName, 40), rate,
      legalEntity: ref(t.legalEntity), useItems: t.useItems === true, isDefault: t.isDefault === true,
    };
  });

  const rawItems = arr(root.items);
  if (rawItems.length > MAX_ITEMS) throw new SpecError(`At most ${MAX_ITEMS} tax treatment items per configuration.`, "items");
  const items: TaxItemSpec[] = rawItems.map((it, i) => {
    const product = ref(it.product ?? it.productName);
    if (!product) throw new SpecError(`Tax Treatment Item ${i + 1}: which product?`, `items.${i}.product`);
    const rate = n(it.rate);
    if (rate !== null && (rate < 0 || rate > 100)) throw new SpecError(`Tax Treatment Item ${i + 1}: a tax rate must be between 0 and 100%.`, `items.${i}.rate`);
    const treatmentKey = s(it.treatmentKey, 40) ?? treatments[0]?.key ?? "";
    return { treatmentKey, product, name: s(it.name, 80), taxCode: s(it.taxCode, 80), taxName: s(it.taxName, 40), rate };
  });
  // A treatment that has items resolves tax per product.
  for (const t of treatments) if (items.some(i => i.treatmentKey === t.key)) t.useItems = true;

  const products = arr(root.products).map(x => ({ product: ref(x.product ?? x.productName ?? x.name) })).filter((x): x is { product: RecordRef } => !!x.product);
  if (products.length > MAX_PRODUCTS) throw new SpecError(`At most ${MAX_PRODUCTS} products per configuration.`, "products");
  const rd = obj(root.rateDefaults);
  return {
    engine, legalEntity: ref(root.legalEntity), country: s(root.country, 80),
    policy: { existingId: id(p.existingId), name: s(p.name, 80), suggestedName: s(p.suggestedName, 80), description: s(p.description, 1000), treatmentSelection: s(p.treatmentSelection, 40) },
    treatments, items, products,
    rateDefaults: Object.keys(rd).length ? { startDate: date(rd.startDate), endDate: date(rd.endDate), productCodeMode: rd.productCodeMode === "blank" ? "blank" : rd.productCodeMode === "product" ? "product" : null } : null,
  };
}
