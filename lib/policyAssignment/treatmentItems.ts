import { id15, type ProductState, type TreatmentItemBackend } from "@/lib/policyAssignment/engine";
import type { TaxCodeSource, TreatmentItemResult, TreatmentItemSummary } from "@/lib/policyAssignment/types";

/**
 * TREATMENT ITEM MAPPING for bulk policy assignment — pure logic over a small I/O interface (Salesforce adapters live in
 * server.ts; tests use an in-memory org). Rules come from the org's verified behaviour already encoded in this app:
 *
 * TAX (lib/tax/server/operations.ts, plan.ts — verified in p10):
 *  · TaxTreatmentItem = TaxTreatmentId + ProductId + TaxCode (+ ProductCode). Salesforce accepts items ONLY under a treatment
 *    with "Use Tax Treatment Items" (ShouldUseTaxTreatmentItems) and allows ONE item per product per treatment
 *    (DUPLICATE_VALUE "A tax treatment item already exists for this product").
 *  · The Tax Code is resolved ONCE per policy from Salesforce configuration — never typed by the user, never inferred from a
 *    Product Code or Tax Rate:  default TaxTreatment.TaxCode  →  its Tax Engine's Tax Code (only when the org's TaxEngine
 *    schema has a TaxCode field — p10 API 68 has none)  →  empty. An empty code doesn't block: the item is created without one.
 *  · An existing item is reused: a non-empty Tax Code is never changed (a different one is reported as a conflict); an EMPTY
 *    one is filled with the policy's code when there is one.
 *
 * BILLING (lib/billing/server/rules.ts R2/R3 — verified): a non-milestone Billing Treatment must have exactly ONE item, and items
 * can't be created or updated while the treatment is Active. Billing Treatment Items carry no product, so they're SHARED by
 * every product on the policy: nothing is created per product (that would break the treatment); the shared item is verified.
 */

/* ───────────────────────────── TAX ───────────────────────────── */

export interface TaxItemRow { id: string; name: string; treatmentId: string; productId: string; taxCode: string | null; productCode: string | null }

export interface TaxItemApi {
  /** Existing items for these products under these treatments. */
  items(treatmentIds: string[], productIds: string[]): Promise<TaxItemRow[]>;
  /** All treatments of the policy (to detect an item under a non-default treatment). */
  policyTreatmentIds(policyId: string): Promise<{ id: string; name: string }[]>;
  /** `taxCode` null = create the item without a Tax Code. */
  createItems(rows: { treatmentId: string; productId: string; name: string; taxCode: string | null; productCode: string | null }[]): Promise<{ productId: string; id: string | null; errorCode: string | null; message: string | null }[]>;
  updateItemTaxCode(itemId: string, taxCode: string): Promise<{ ok: boolean; errorCode: string | null; message: string | null }>;
}

const blank = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The policy's authoritative Tax Code: Tax Treatment → Tax Engine → empty. The engine is consulted only when the treatment's
 * code is empty AND the org's TaxEngine schema actually has a Tax Code field (`engineHasTaxCodeField`); a missing field resolves
 * to empty — no other field is ever substituted.
 */
export function resolvePolicyTaxCode(input: { treatmentTaxCode: string | null; engineTaxCode: string | null; engineHasTaxCodeField: boolean }): { code: string | null; source: TaxCodeSource } {
  const t = blank(input.treatmentTaxCode);
  if (t) return { code: t, source: "tax-treatment" };
  const e = input.engineHasTaxCodeField ? blank(input.engineTaxCode) : null;
  if (e) return { code: e, source: "tax-engine" };
  return { code: null, source: "not-configured" };
}

export function taxTreatmentItemBackend(api: TaxItemApi): TreatmentItemBackend {
  const base = (s: TreatmentItemSummary): Pick<TreatmentItemResult, "treatmentName"> => ({ treatmentName: s.treatmentName });
  const policyCode = (s: TreatmentItemSummary) => s.resolvedTaxCode ?? null;
  const policySource = (s: TreatmentItemSummary): TaxCodeSource => s.taxCodeSource ?? "not-configured";
  const conflictDetail = (row: TaxItemRow, s: TreatmentItemSummary) =>
    `Existing Tax Treatment Item "${row.name}" has Tax Code ${row.taxCode}, but the policy's Tax Code is ${policyCode(s)} (from the ${policySource(s) === "tax-engine" ? "Tax Engine" : "Tax Treatment"}). It was kept and NOT overwritten — review it in Tax Treatment Items.`;

  return {
    async ensure(policy, s, products) {
      const out = new Map<string, TreatmentItemResult>();
      const code = policyCode(s);
      if (s.mode === "tax-treatment-code" || s.mode === "none") {
        for (const p of products) out.set(id15(p.id)!, { ...base(s), status: "not-required", itemId: null, itemName: null, taxCode: code, taxCodeSource: policySource(s),
          detail: s.mode === "none" ? `${policy.name} has no default Tax Treatment yet — no Tax Treatment Item to map.` : `Tax Treatment "${s.treatmentName}" doesn't use Tax Treatment Items — its own Tax Code${code ? ` ${code}` : ""} applies to every product; Salesforce doesn't accept items on it.` });
        return out;
      }
      if (s.mode !== "tax-per-product" || !s.treatmentId) return out;
      const treatments = await api.policyTreatmentIds(policy.id);
      const rows = await api.items([...new Set([s.treatmentId, ...treatments.map(t => t.id)])], products.map(p => p.id));
      const toCreate: ProductState[] = [];

      for (const p of products) {
        const k = id15(p.id)!;
        const mine = rows.filter(r => id15(r.productId) === k);
        const onDefault = mine.find(r => id15(r.treatmentId) === id15(s.treatmentId));
        const elsewhere = mine.find(r => id15(r.treatmentId) !== id15(s.treatmentId));
        if (onDefault) {
          if (onDefault.taxCode) {
            // Reuse; a non-empty Tax Code is never changed — a different one is reported.
            const conflict = !!code && onDefault.taxCode !== code;
            out.set(k, { ...base(s), status: conflict ? "conflict" : "reused", itemId: onDefault.id, itemName: onDefault.name, taxCode: onDefault.taxCode, taxCodeSource: "existing-item",
              detail: conflict ? conflictDetail(onDefault, s) : `Existing Tax Treatment Item "${onDefault.name}" (${onDefault.taxCode}) reused — unchanged.` });
          } else if (!code) {
            out.set(k, { ...base(s), status: "reused", itemId: onDefault.id, itemName: onDefault.name, taxCode: null, taxCodeSource: "not-configured", detail: `Existing Tax Treatment Item "${onDefault.name}" reused. No Tax Code is configured on the policy's Tax Treatment or Tax Engine, so it stays empty.` });
          } else if (!s.canCreateItems) {
            out.set(k, { ...base(s), status: "failed", itemId: onDefault.id, itemName: onDefault.name, taxCode: code, taxCodeSource: policySource(s), detail: "Your user can't update Tax Treatment Items, so the item's empty Tax Code can't be completed." });
          } else {
            // Its Tax Code is empty — fill it with the policy's code (nothing non-empty is ever overwritten).
            const u = await api.updateItemTaxCode(onDefault.id, code);
            out.set(k, u.ok
              ? { ...base(s), status: "updated", itemId: onDefault.id, itemName: onDefault.name, taxCode: code, taxCodeSource: policySource(s), detail: `Tax Code ${code} (from the ${policySource(s) === "tax-engine" ? "Tax Engine" : "Tax Treatment"}) added to existing item "${onDefault.name}", which had none.` }
              : { ...base(s), status: "failed", itemId: onDefault.id, itemName: onDefault.name, taxCode: code, taxCodeSource: policySource(s), detail: `Salesforce rejected the Tax Code update: ${u.message ?? u.errorCode ?? "unknown error"}` });
          }
          continue;
        }
        if (elsewhere) {
          const tn = treatments.find(t => id15(t.id) === id15(elsewhere.treatmentId))?.name ?? "another treatment";
          out.set(k, { ...base(s), status: "failed", itemId: elsewhere.id, itemName: elsewhere.name, taxCode: elsewhere.taxCode, taxCodeSource: null,
            detail: `${p.name} already has a Tax Treatment Item under "${tn}" of this policy, not under the default "${s.treatmentName}". A product can have only one item per policy — review it in Tax Treatment Items; nothing was changed.` });
          continue;
        }
        if (!s.canCreateItems) { out.set(k, { ...base(s), status: "failed", itemId: null, itemName: null, taxCode: code, taxCodeSource: policySource(s), detail: "Your user can't create Tax Treatment Items (object permission or field-level security)." }); continue; }
        toCreate.push(p);
      }

      if (toCreate.length) {
        const name = (p: ProductState) => `${p.name}${code ? ` · ${code}` : ""}`.slice(0, 80);
        const created = await api.createItems(toCreate.map(p => ({ treatmentId: s.treatmentId!, productId: p.id, name: name(p), taxCode: code, productCode: p.code })));
        const dupes: ProductState[] = [];
        for (const p of toCreate) {
          const r = created.find(x => id15(x.productId) === id15(p.id));
          const k = id15(p.id)!;
          if (r?.id) out.set(k, { ...base(s), status: "created", itemId: r.id, itemName: name(p), taxCode: code, taxCodeSource: policySource(s),
            detail: code ? `Tax Treatment Item created under "${s.treatmentName}" with Tax Code ${code} (from the ${policySource(s) === "tax-engine" ? "Tax Engine" : "Tax Treatment"}).` : `Tax Treatment Item created under "${s.treatmentName}" without a Tax Code — none is configured on the policy's Tax Treatment or Tax Engine.` });
          else if (r?.errorCode === "DUPLICATE_VALUE") dupes.push(p); // created concurrently — re-read below, never a second item
          else out.set(k, { ...base(s), status: "failed", itemId: null, itemName: null, taxCode: code, taxCodeSource: policySource(s), detail: `Salesforce rejected the Tax Treatment Item: ${r?.message ?? r?.errorCode ?? "no result"}` });
        }
        if (dupes.length) {
          const again = await api.items([s.treatmentId], dupes.map(d => d.id));
          for (const d of dupes) {
            const row = again.find(r => id15(r.productId) === id15(d.id));
            const conflict = !!row && !!code && !!row.taxCode && row.taxCode !== code;
            out.set(id15(d.id)!, row
              ? { ...base(s), status: conflict ? "conflict" : "reused", itemId: row.id, itemName: row.name, taxCode: row.taxCode, taxCodeSource: "existing-item", detail: conflict ? conflictDetail(row, s) : `Tax Treatment Item "${row.name}" already existed (created concurrently) — reused.` }
              : { ...base(s), status: "failed", itemId: null, itemName: null, taxCode: code, taxCodeSource: policySource(s), detail: "Salesforce reported a duplicate item but it couldn't be read back." });
          }
        }
      }
      return out;
    },

    async verify(policy, s, products) {
      const out = new Map<string, TreatmentItemResult>();
      const code = policyCode(s);
      if (s.mode !== "tax-per-product" || !s.treatmentId) {
        for (const p of products) out.set(id15(p.id)!, { ...base(s), status: "not-required", itemId: null, itemName: null, taxCode: code, taxCodeSource: policySource(s), detail: s.mode === "none" ? "No default Tax Treatment." : `Treatment "${s.treatmentName}" applies its own Tax Code to every product.` });
        return out;
      }
      const rows = await api.items([s.treatmentId], products.map(p => p.id));
      for (const p of products) {
        const row = rows.find(r => id15(r.productId) === id15(p.id));
        if (!row) { out.set(id15(p.id)!, { ...base(s), status: "not-verified", itemId: null, itemName: null, taxCode: null, taxCodeSource: null, detail: `No Tax Treatment Item for ${p.name} under "${s.treatmentName}" in Salesforce.` }); continue; }
        const conflict = !!code && !!row.taxCode && row.taxCode !== code;
        out.set(id15(p.id)!, { ...base(s), status: conflict ? "conflict" : "reused", itemId: row.id, itemName: row.name, taxCode: row.taxCode, taxCodeSource: "existing-item",
          detail: conflict ? conflictDetail(row, s) : `Verified in Salesforce: "${row.name}" maps ${p.name} under "${s.treatmentName}"${row.taxCode ? ` with Tax Code ${row.taxCode}` : " (no Tax Code configured)"}.` });
      }
      return out;
    },
  };
}

export function taxSummary(
  t: { id: string; name: string; status: string | null; taxCode: string | null; usesItems: boolean | null } | null,
  canCreateItems: boolean,
  engine: { name: string | null; taxCode: string | null; taxCodeField: string | null } | null = null,
): TreatmentItemSummary {
  const none = { engineName: engine?.name ?? null, engineTaxCodeField: engine?.taxCodeField ?? null };
  if (!t) return { mode: "none", treatmentId: null, treatmentName: null, treatmentStatus: null, treatmentTaxCode: null, resolvedTaxCode: null, taxCodeSource: "not-configured", ...none, sharedItems: [], canCreateItems, detail: "This Tax Policy has no default Tax Treatment, so there is no Tax Treatment Item to map and no Tax Code to resolve." };
  const r = resolvePolicyTaxCode({ treatmentTaxCode: t.taxCode, engineTaxCode: engine?.taxCode ?? null, engineHasTaxCodeField: !!engine?.taxCodeField });
  const common = { treatmentId: t.id, treatmentName: t.name, treatmentStatus: t.status, treatmentTaxCode: t.taxCode, resolvedTaxCode: r.code, taxCodeSource: r.source, ...none, sharedItems: [], canCreateItems };
  const codeText = r.code ? `Tax Code ${r.code} (from the ${r.source === "tax-engine" ? "Tax Engine" : "Tax Treatment"})` : "no Tax Code (none is configured on the Tax Treatment or Tax Engine)";
  if (t.usesItems) return { mode: "tax-per-product", ...common,
    detail: `Default Tax Treatment "${t.name}" uses Tax Treatment Items — each product gets its own item under it, with ${codeText}. Existing items are reused and their Tax Code is never changed.${canCreateItems ? "" : " Your user can't create Tax Treatment Items, so products without one can't be assigned."}` };
  return { mode: "tax-treatment-code", ...common,
    detail: `Default Tax Treatment "${t.name}" doesn't use Tax Treatment Items — ${codeText} applies to every product through the treatment, so no per-product item is needed (Salesforce refuses items on such a treatment).` };
}

/* ───────────────────────────── BILLING ───────────────────────────── */

export interface BillingItemRow { id: string; name: string; status: string | null }
export interface BillingItemApi { items(treatmentId: string): Promise<BillingItemRow[]> }

export function billingSummary(t: { id: string; name: string; status: string | null; milestone: boolean } | null, items: BillingItemRow[], productRefFields: string[]): TreatmentItemSummary {
  if (!t) return { mode: "none", treatmentId: null, treatmentName: null, treatmentStatus: null, treatmentTaxCode: null, sharedItems: [], canCreateItems: false, detail: "This Billing Policy has no default Billing Treatment, so there is no Billing Treatment Item." };
  const fieldNote = productRefFields.length
    ? ` (This org's BillingTreatmentItem has ${productRefFields.join(", ")} referencing Product2, but setting it on the shared item would apply to every product — the app never writes it.)`
    : " BillingTreatmentItem has no Product field in this org (checked in Describe).";
  return { mode: "billing-shared", treatmentId: t.id, treatmentName: t.name, treatmentStatus: t.status, treatmentTaxCode: null, sharedItems: items, canCreateItems: false,
    detail: `Billing Treatment Items are shared by every product on the policy: "${t.name}" ${t.milestone ? "is a milestone treatment" : "may have exactly one item"} and Salesforce doesn't allow items to be created while it's Active, so nothing is created per product — the shared item${items.length === 1 ? ` "${items[0].name}"` : "s"} must be Active.${fieldNote}` };
}

export function billingTreatmentItemBackend(api: BillingItemApi): TreatmentItemBackend {
  const check = async (s: TreatmentItemSummary, products: ProductState[]) => {
    const out = new Map<string, TreatmentItemResult>();
    if (s.mode !== "billing-shared" || !s.treatmentId) {
      for (const p of products) out.set(id15(p.id)!, { treatmentName: null, status: "not-verified", itemId: null, itemName: null, taxCode: null, taxCodeSource: null, detail: s.detail });
      return out;
    }
    const items = await api.items(s.treatmentId);
    const active = items.find(i => i.status === "Active");
    for (const p of products) {
      out.set(id15(p.id)!, active
        ? { treatmentName: s.treatmentName, status: "shared", itemId: active.id, itemName: active.name, taxCode: null, taxCodeSource: null, detail: `Billed through the policy's shared Billing Treatment Item "${active.name}" (Active) on "${s.treatmentName}" — verified in Salesforce.` }
        : { treatmentName: s.treatmentName, status: "not-verified", itemId: items[0]?.id ?? null, itemName: items[0]?.name ?? null, taxCode: null, taxCodeSource: null,
            detail: items.length ? `Billing Treatment Item "${items[0].name}" is ${items[0].status ?? "not Active"} — activate the policy's billing chain (Billing Policies → Complete Policy Chain) so products bill.` : `"${s.treatmentName}" has no Billing Treatment Item.` });
    }
    return out;
  };
  return {
    // Nothing is written for billing — the shared item is read; an inactive one is reported after the link (partial state).
    ensure: async (_policy, s, products) => {
      const out = await check(s, products);
      for (const [k, v] of out) if (v.status === "not-verified" && s.sharedItems.length) out.set(k, { ...v, status: "shared" });
      return out;
    },
    verify: async (_policy, s, products) => check(s, products),
  };
}
