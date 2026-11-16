import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseBulkInput, runBulkAssignment, type AssignmentBackend, type ProductState } from "@/lib/policyAssignment/engine";
import { billingSummary, billingTreatmentItemBackend, resolvePolicyTaxCode, taxSummary, taxTreatmentItemBackend, type BillingItemRow, type TaxItemApi, type TaxItemRow } from "@/lib/policyAssignment/treatmentItems";
import { currentFor, listKeyFor } from "@/lib/policyAssignment/selection";
import { engineTaxCodeField } from "@/lib/policyAssignment/server";
import { BULK_ASSIGNMENT_PATHS, BULK_ASSIGNMENT_VIEW, bulkAssignmentDataUrl } from "@/lib/policyAssignment/navigation";
import { moduleGuideKeyFor, taxesIntroKey, MODULE_GUIDES } from "@/lib/help/moduleGuides";
import type { TaxMetadata } from "@/lib/tax/types";
import type { BulkAssignResponse, PolicyKind, TreatmentItemSummary } from "@/lib/policyAssignment/types";

/* ── In-memory org: Product2 (both policy fields), TaxTreatmentItem, BillingTreatmentItem. ── */

const pid = (n: number) => `01t000000000${String(n).padStart(3, "0")}AAA`;
const TAX_POLICY = "1Tp000000000001AAA", OTHER_TAX = "1Tp000000000002AAA", BILL_POLICY = "0Ze000000000001AAA";
const TREAT = "1tt000000000001AAA", OTHER_TREAT = "1tt000000000002AAA", BTREAT = "0Zt000000000001AAA";

interface Prod { id: string; name: string; code: string | null; TaxPolicyId: string | null; BillingPolicyId: string | null; modified: number }

class Org {
  products = new Map<string, Prod>();
  items: TaxItemRow[] = [];
  billingItems: BillingItemRow[] = [{ id: "0Zi000000000001AAA", name: "Advance 100%", status: "Active" }];
  productWrites: string[] = [];
  itemCreates = 0;
  itemUpdates: { id: string; code: string }[] = [];
  /** Simulates another process creating the item between our read and our create (→ DUPLICATE_VALUE). */
  raceCreate = new Map<string, string | null>();
  /** Simulates automation deleting an item right after creation (→ verification fails). */
  vanish = new Set<string>();
  clock = 1_700_000_000_000;

  add(n: number, p: Partial<Prod> = {}) { const r: Prod = { id: pid(n), name: `Product ${n}`, code: `P-${n}`, TaxPolicyId: null, BillingPolicyId: null, modified: this.clock, ...p }; this.products.set(r.id, r); return r; }

  taxApi(): TaxItemApi {
    return {
      items: async (tids, pids) => this.items.filter(i => tids.includes(i.treatmentId) && pids.includes(i.productId)),
      policyTreatmentIds: async policyId => policyId === TAX_POLICY ? [{ id: TREAT, name: "GST 18% Treatment" }, { id: OTHER_TREAT, name: "GST LE Treatment" }] : [],
      createItems: async rows => rows.map(r => {
        if (this.raceCreate.has(r.productId)) {
          this.items.push({ id: `0IT${r.productId.slice(3)}`, name: "Concurrent item", treatmentId: r.treatmentId, productId: r.productId, taxCode: this.raceCreate.get(r.productId) ?? null, productCode: r.productCode });
          return { productId: r.productId, id: null, errorCode: "DUPLICATE_VALUE", message: "A tax treatment item already exists for this product" };
        }
        if (this.items.some(i => i.treatmentId === r.treatmentId && i.productId === r.productId)) return { productId: r.productId, id: null, errorCode: "DUPLICATE_VALUE", message: "dup" };
        this.itemCreates++;
        const id = `0IT${String(this.itemCreates).padStart(12, "0")}AAA`;
        if (!this.vanish.has(r.productId)) this.items.push({ id, name: r.name, treatmentId: r.treatmentId, productId: r.productId, taxCode: r.taxCode, productCode: r.productCode });
        else this.vanish.delete(r.productId);
        return { productId: r.productId, id, errorCode: null, message: null };
      }),
      updateItemTaxCode: async (id, code) => { const i = this.items.find(x => x.id === id); if (!i) return { ok: false, errorCode: "NOT_FOUND", message: "gone" }; i.taxCode = code; this.itemUpdates.push({ id, code }); return { ok: true, errorCode: null, message: null }; },
    };
  }

  backend(kind: PolicyKind, summary: TreatmentItemSummary): AssignmentBackend {
    const f = kind === "tax" ? "TaxPolicyId" : "BillingPolicyId";
    const policies: Record<string, string> = { [TAX_POLICY]: "Australia GST Tax Policy", [OTHER_TAX]: "VAT Policy", [BILL_POLICY]: "Standard Billing" };
    return {
      kind,
      field: { name: f, updateable: true },
      loadPolicy: async id => policies[id] ? { id, name: policies[id], status: "Active", blockers: [], warnings: [], treatmentItems: summary } : null,
      policyNames: async ids => new Map(ids.map(i => [i, policies[i] ?? i])),
      readProducts: async ids => ids.map(id => this.products.get(id)).filter((p): p is Prod => !!p).map((p): ProductState => ({ id: p.id, name: p.name, code: p.code, policyId: p[f], lastModified: new Date(p.modified).toISOString() })),
      writePolicy: async (policyId, writes) => writes.map(w => { const p = this.products.get(w.id)!; this.productWrites.push(w.id); this.clock += 1000; p[f] = policyId; p.modified = this.clock; return { id: w.id, status: 204 }; }),
      treatmentItems: kind === "tax" ? taxTreatmentItemBackend(this.taxApi()) : billingTreatmentItemBackend({ items: async () => this.billingItems }),
    };
  }
}

/** Per-product items; Tax Code resolved from the treatment (or engine) exactly as the server does. */
const PER_PRODUCT = (treatmentTaxCode: string | null = "AU_GST_10", opts: { canCreate?: boolean; engine?: { taxCode: string | null; taxCodeField: string | null } } = {}) =>
  taxSummary({ id: TREAT, name: "Australia GST Treatment", status: "Active", taxCode: treatmentTaxCode, usesItems: true }, opts.canCreate ?? true, { name: "Native Tax Engine", taxCode: opts.engine?.taxCode ?? null, taxCodeField: opts.engine?.taxCodeField ?? null });
const ok = (r: Awaited<ReturnType<typeof runBulkAssignment>>): BulkAssignResponse => { assert.ok(r.success, JSON.stringify(r)); return r as BulkAssignResponse; };
const res = (r: BulkAssignResponse, n: number) => r.results.find(x => x.productId === pid(n))!;

/* ───────────── TAX CODE RESOLUTION (Tax Treatment → Tax Engine → empty) ───────────── */

test("resolution: Tax Treatment Tax Code is used as is", () => {
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: "AU_GST_10", engineTaxCode: null, engineHasTaxCodeField: false }), { code: "AU_GST_10", source: "tax-treatment" });
});

test("resolution: empty Treatment Tax Code + Tax Engine Tax Code (field exists) → Tax Engine value", () => {
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: null, engineTaxCode: "ENG-CODE", engineHasTaxCodeField: true }), { code: "ENG-CODE", source: "tax-engine" });
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: "  ", engineTaxCode: "ENG-CODE", engineHasTaxCodeField: true }), { code: "ENG-CODE", source: "tax-engine" }, "blank treatment code counts as empty");
});

test("resolution: both empty → Tax Code stays empty (Not Configured)", () => {
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: null, engineTaxCode: null, engineHasTaxCodeField: true }), { code: null, source: "not-configured" });
});

test("resolution: Tax Treatment value takes priority over the Tax Engine value", () => {
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: "TREAT", engineTaxCode: "ENG", engineHasTaxCodeField: true }), { code: "TREAT", source: "tax-treatment" });
});

test("resolution: no Tax Engine Tax Code field in the schema → empty, even if a value is passed (no field is invented)", () => {
  assert.deepEqual(resolvePolicyTaxCode({ treatmentTaxCode: null, engineTaxCode: "SHOULD-NOT-BE-USED", engineHasTaxCodeField: false }), { code: null, source: "not-configured" });
  // Schema-aware detection: only a field literally named TaxCode on TaxEngine counts. p10 (API 68) TaxEngine has none.
  const meta = (fields: Record<string, { type: string }>) => ({ objects: { TaxEngine: { name: "TaxEngine", label: "Tax Engine", exists: true, createable: true, updateable: true, queryable: true, fields: Object.fromEntries(Object.entries(fields).map(([n, f]) => [n, { name: n, label: n, type: f.type, required: false, createable: false, updateable: false, nillable: true, picklist: [], referenceTo: [] }])) } } } as unknown as TaxMetadata);
  const P10_TAX_ENGINE_FIELDS = ["TaxEngineName", "TaxEngineProviderId", "MerchantCredentialId", "Description", "Status", "ExternalReference", "SellerCode", "Type", "TaxPrvdAccountIdentifier", "CustomMetadataTypeApiName", "DecisionTableId"];
  assert.equal(engineTaxCodeField(meta(Object.fromEntries(P10_TAX_ENGINE_FIELDS.map(n => [n, { type: "string" }])))), null);
  assert.equal(engineTaxCodeField(meta({ TaxCode: { type: "string" } })), "TaxCode");
  assert.equal(engineTaxCodeField({ objects: {} } as unknown as TaxMetadata), null, "no TaxEngine object → empty");
});

test("summary: treatment and engine Tax Codes resolve into the policy summary; changing policy re-resolves it", () => {
  const a = PER_PRODUCT("AU_GST_10");
  assert.deepEqual([a.resolvedTaxCode, a.taxCodeSource, a.engineName], ["AU_GST_10", "tax-treatment", "Native Tax Engine"]);
  const b = PER_PRODUCT(null, { engine: { taxCode: "ENG", taxCodeField: "TaxCode" } });
  assert.deepEqual([b.resolvedTaxCode, b.taxCodeSource], ["ENG", "tax-engine"]);
  const c = PER_PRODUCT(null);
  assert.deepEqual([c.resolvedTaxCode, c.taxCodeSource], [null, "not-configured"]);
  assert.match(c.detail, /none is configured/);
  // The page only shows the list state whose key matches the CURRENT policy — never a previous policy's Tax Code.
  const loaded = { key: listKeyFor("POLICY_A", "", 0), policy: { treatmentItems: a } };
  assert.equal(currentFor(loaded, listKeyFor("POLICY_A", "", 0))?.policy.treatmentItems.resolvedTaxCode, "AU_GST_10");
  assert.equal(currentFor(loaded, listKeyFor("POLICY_B", "", 0)), null, "after switching policy the old Tax Code is not shown");
});

/* ───────────── TAX TREATMENT ITEMS ───────────── */

test("tax: creates the product's Tax Treatment Item with the resolved Tax Code, unmodified (not the Product Code)", async () => {
  const o = new Org();
  o.add(1, { name: "Laptop Basic", code: "LPB-001" });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10")), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  const x = res(r, 1);
  assert.equal(x.outcome, "assigned");
  assert.equal(x.treatmentItem?.status, "created");
  assert.equal(x.treatmentItem?.taxCodeSource, "tax-treatment");
  assert.deepEqual({ t: o.items[0].treatmentId, p: o.items[0].productId, c: o.items[0].taxCode, pc: o.items[0].productCode }, { t: TREAT, p: pid(1), c: "AU_GST_10", pc: "LPB-001" });
  assert.equal(o.products.get(pid(1))!.TaxPolicyId, TAX_POLICY);
});

test("tax: Tax Engine fallback value is used when the treatment has none", async () => {
  const o = new Org();
  o.add(1);
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT(null, { engine: { taxCode: "ENG-AU", taxCodeField: "TaxCode" } })), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).treatmentItem?.taxCodeSource, "tax-engine");
  assert.equal(o.items[0].taxCode, "ENG-AU");
});

test("tax: an empty Tax Code does NOT block assignment — the item is created without one", async () => {
  const o = new Org();
  o.add(1, { code: "LPB-001" });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT(null)), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "assigned");
  assert.equal(res(r, 1).treatmentItem?.status, "created");
  assert.equal(o.items[0].taxCode, null, "TaxCode left empty — never the Product Code");
  assert.equal(o.products.get(pid(1))!.TaxPolicyId, TAX_POLICY);
});

test("tax: a manual Tax Code can't be supplied to the API", () => {
  for (const key of ["taxCode", "defaultTaxCode"]) {
    const r = parseBulkInput({ policyId: TAX_POLICY, productIds: [pid(1)], [key]: "GST18" });
    assert.ok("success" in r && !r.success && /can't be supplied/.test(r.error), key);
  }
  assert.ok(!("success" in parseBulkInput({ policyId: TAX_POLICY, productIds: [pid(1)] })));
});

test("tax: an existing item is reused and its Tax Code is never overwritten — same code → reused", async () => {
  const o = new Org();
  o.add(1);
  o.items.push({ id: "0IT000000000EX1AAA", name: "Existing", treatmentId: TREAT, productId: pid(1), taxCode: "AU_GST_10", productCode: null });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10")), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "assigned");
  assert.equal(res(r, 1).treatmentItem?.status, "reused");
  assert.equal(o.itemCreates, 0);
  assert.deepEqual(o.itemUpdates, []);
});

test("tax: an existing item with a DIFFERENT Tax Code is kept, reported as a conflict, and not overwritten", async () => {
  const o = new Org();
  o.add(1);
  o.items.push({ id: "0IT000000000EX2AAA", name: "Old item", treatmentId: TREAT, productId: pid(1), taxCode: "OLD_CODE", productCode: null });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10")), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "assigned", "the mapping exists, so the policy is linked");
  assert.equal(res(r, 1).treatmentItem?.status, "conflict");
  assert.match(res(r, 1).treatmentItem!.detail, /OLD_CODE.*AU_GST_10.*NOT overwritten/);
  assert.equal(r.conflicts, 1);
  assert.equal(o.items[0].taxCode, "OLD_CODE");
  assert.deepEqual(o.itemUpdates, []);
});

test("tax: an existing item with an EMPTY Tax Code is filled with the resolved code; with none resolved it stays empty", async () => {
  const o = new Org();
  o.add(1); o.add(2);
  o.items.push({ id: "0IT000000000EX3AAA", name: "Empty 1", treatmentId: TREAT, productId: pid(1), taxCode: null, productCode: null });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10")), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).treatmentItem?.status, "updated");
  assert.deepEqual(o.itemUpdates, [{ id: "0IT000000000EX3AAA", code: "AU_GST_10" }]);
  o.items.push({ id: "0IT000000000EX4AAA", name: "Empty 2", treatmentId: TREAT, productId: pid(2), taxCode: null, productCode: null });
  const r2 = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT(null)), { policyId: TAX_POLICY, productIds: [pid(2)] }));
  assert.equal(res(r2, 2).outcome, "assigned");
  assert.equal(res(r2, 2).treatmentItem?.status, "reused");
  assert.equal(o.itemUpdates.length, 1, "nothing written when no Tax Code is configured");
});

test("tax: concurrent item creation (DUPLICATE_VALUE) is reused — never a second item", async () => {
  const o = new Org();
  o.add(1);
  o.raceCreate.set(pid(1), "AU_GST_10");
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10")), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "assigned");
  assert.equal(o.items.filter(i => i.productId === pid(1)).length, 1);
});

test("tax: running the assignment twice creates no duplicate items and no second policy write", async () => {
  const o = new Org();
  o.add(1); o.add(2);
  ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1), pid(2)] }));
  const second = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1), pid(2)] }));
  assert.deepEqual(second.results.map(x => x.outcome), ["already-assigned", "already-assigned"]);
  assert.equal(o.items.length, 2);
  assert.equal(o.productWrites.length, 2, "each product written exactly once across both runs");
});

test("tax: an item under another treatment of the same policy blocks the product (one item per policy) — nothing changed", async () => {
  const o = new Org();
  o.add(1);
  o.items.push({ id: "0IT000000000EX5AAA", name: "Other treatment item", treatmentId: OTHER_TREAT, productId: pid(1), taxCode: "X", productCode: null });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "failed");
  assert.equal(res(r, 1).failureKind, "treatment-item");
  assert.equal(o.items.length, 1);
  assert.equal(o.products.get(pid(1))!.TaxPolicyId, null);
});

test("tax: a treatment WITHOUT items needs no item (its own Tax Code applies) and none is created", async () => {
  const o = new Org();
  o.add(1);
  const s = taxSummary({ id: TREAT, name: "GST Flat", status: "Active", taxCode: "GST18", usesItems: false }, true, { name: "Engine", taxCode: null, taxCodeField: null });
  assert.equal(s.mode, "tax-treatment-code");
  assert.deepEqual([s.resolvedTaxCode, s.taxCodeSource], ["GST18", "tax-treatment"]);
  const r = ok(await runBulkAssignment(o.backend("tax", s), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "assigned");
  assert.equal(res(r, 1).treatmentItem?.status, "not-required");
  assert.equal(o.items.length, 0);
});

test("tax: without permission to create items the product isn't linked (permission failure)", async () => {
  const o = new Org();
  o.add(1);
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT("AU_GST_10", { canCreate: false })), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "failed");
  assert.equal(res(r, 1).failureKind, "permission");
  assert.equal(o.products.get(pid(1))!.TaxPolicyId, null);
});

test("tax: partial state (policy linked, item missing) is reported, and a retry completes the item without re-writing the policy", async () => {
  const o = new Org();
  o.add(1);
  o.vanish.add(pid(1));
  const first = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(first, 1).outcome, "assigned-incomplete");
  assert.equal(res(first, 1).retryable, true);
  const writes = o.productWrites.length;
  const retry = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1)] }));
  assert.equal(res(retry, 1).outcome, "already-assigned");
  assert.match(res(retry, 1).reason!, /completed now/);
  assert.equal(o.productWrites.length, writes, "policy not written again");
  assert.equal(o.items.filter(i => i.productId === pid(1)).length, 1);
});

test("tax: eligibility stays Tax-only — a product with only a Billing Policy is assigned; another Tax Policy is never overwritten", async () => {
  const o = new Org();
  o.add(1, { BillingPolicyId: BILL_POLICY });
  o.add(2, { TaxPolicyId: OTHER_TAX });
  const r = ok(await runBulkAssignment(o.backend("tax", PER_PRODUCT()), { policyId: TAX_POLICY, productIds: [pid(1), pid(2)] }));
  assert.equal(res(r, 1).outcome, "assigned");
  assert.equal(o.products.get(pid(1))!.BillingPolicyId, BILL_POLICY);
  assert.equal(res(r, 2).outcome, "ineligible");
  assert.equal(o.products.get(pid(2))!.TaxPolicyId, OTHER_TAX);
  assert.equal(o.items.filter(i => i.productId === pid(2)).length, 0, "no item for an ineligible product");
});

test("UI: the bulk assignment page has no manual Tax Code input and shows the resolved value read-only", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "components/data/policy-assignment/BulkPolicyAssignment.tsx"), "utf8");
  assert.ok(!/defaultTaxCode|setDefaultTaxCode|Default Tax Code/.test(src), "no manual/default Tax Code state or field");
  assert.ok(!/taxCode\s*:/.test(src.slice(src.indexOf("quoteApiPost<BulkAssignResponse>"), src.indexOf("quoteApiPost<BulkAssignResponse>") + 200)), "assign request carries no Tax Code");
  const panel = src.slice(src.indexOf("function ResolvedTaxCode"), src.indexOf("function ResultSummary"));
  assert.ok(panel.length > 0 && !/<input|<select|<textarea/.test(panel), "resolved Tax Code is read-only");
  assert.match(panel, /Not configured/);
  assert.match(panel, /TAX_CODE_SOURCE_LABEL\[source\]/);
  assert.match(src, /<TreatmentItemPanel key=\{policyId\}/, "panel remounts on policy change");
});

/* ───────────── BILLING ───────────── */

const BSUM = (items: BillingItemRow[]) => billingSummary({ id: BTREAT, name: "Advance Monthly", status: "Active", milestone: false }, items, []);

test("billing: the shared Active Billing Treatment Item is verified per product — nothing is created per product", async () => {
  const o = new Org();
  o.add(1); o.add(2, { TaxPolicyId: TAX_POLICY });
  const r = ok(await runBulkAssignment(o.backend("billing", BSUM(o.billingItems)), { policyId: BILL_POLICY, productIds: [pid(1), pid(2)] }));
  assert.deepEqual(r.results.map(x => x.outcome), ["assigned", "assigned"]);
  assert.deepEqual(r.results.map(x => x.treatmentItem?.status), ["shared", "shared"]);
  assert.equal(r.results[0].treatmentItem?.itemName, "Advance 100%");
  assert.equal(o.billingItems.length, 1, "still exactly one item on the treatment");
  assert.equal(o.products.get(pid(2))!.TaxPolicyId, TAX_POLICY, "tax policy untouched");
});

test("billing: an inactive shared item → assigned-incomplete; after activation a retry completes it without a second write", async () => {
  const o = new Org();
  o.billingItems = [{ id: "0Zi000000000001AAA", name: "Advance 100%", status: "Draft" }];
  o.add(1);
  const first = ok(await runBulkAssignment(o.backend("billing", BSUM(o.billingItems)), { policyId: BILL_POLICY, productIds: [pid(1)] }));
  assert.equal(res(first, 1).outcome, "assigned-incomplete");
  assert.match(res(first, 1).reason!, /Draft/);
  o.billingItems[0].status = "Active";
  const writes = o.productWrites.length;
  const retry = ok(await runBulkAssignment(o.backend("billing", BSUM(o.billingItems)), { policyId: BILL_POLICY, productIds: [pid(1)] }));
  assert.equal(res(retry, 1).outcome, "already-assigned");
  assert.equal(o.productWrites.length, writes);
});

test("billing: an existing Billing Policy is never overwritten", async () => {
  const o = new Org();
  o.add(1, { BillingPolicyId: "0Ze000000000009AAA" });
  const r = ok(await runBulkAssignment(o.backend("billing", BSUM(o.billingItems)), { policyId: BILL_POLICY, productIds: [pid(1)] }));
  assert.equal(res(r, 1).outcome, "ineligible");
  assert.equal(o.productWrites.length, 0);
});

test("billing summary explains the shared item and reports (never writes) a Product field on the item", () => {
  assert.equal(BSUM([]).mode, "billing-shared");
  assert.equal(BSUM([]).canCreateItems, false);
  assert.match(billingSummary({ id: BTREAT, name: "T", status: "Active", milestone: false }, [], ["Product__c"]).detail, /never writes it/);
  assert.equal(billingSummary(null, [], []).mode, "none");
});

/* ───────────── NAVIGATION ───────────── */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("navigation: dedicated routes redirect to the workspace views (direct URL access)", () => {
  assert.equal(BULK_ASSIGNMENT_PATHS.billing, "/data/billing-policy/bulk-assignment");
  assert.equal(BULK_ASSIGNMENT_PATHS.tax, "/data/tax-policy/bulk-assignment");
  assert.equal(bulkAssignmentDataUrl("billing"), "/data?module=billing-policies&bm=billing-policies&bv=bulk-assignment");
  assert.equal(bulkAssignmentDataUrl("tax"), "/data?module=taxes-policies&tm=tax-policies&tv=bulk-assignment");
  assert.match(read("app/data/billing-policy/bulk-assignment/page.tsx"), /redirect\(bulkAssignmentDataUrl\("billing"\)\)/);
  assert.match(read("app/data/tax-policy/bulk-assignment/page.tsx"), /redirect\(bulkAssignmentDataUrl\("tax"\)\)/);
  // the sidebar items those URLs select exist
  const page = read("app/data/page.tsx");
  assert.ok(page.includes(`{ id: "billing-policies", label: "Billing Policies"`) && page.includes(`{ id: "taxes-policies", label: "Tax Policies"`));
});

test("navigation: the dashboard card navigates to the page (no inline panel) and both workspaces route + restore it", () => {
  const dash = read("components/data/billing/BillingModuleDashboard.tsx");
  assert.match(dash, /workflow === "bulk-assign"\) onNavigate\(\{ billing: \{ moduleKey, view: "bulk-assignment" \} \}\)/);
  assert.ok(!dash.includes("<BulkPolicyAssignment"), "no inline assignment panel on the dashboard");
  assert.equal((dash.match(/id: "bulk-assign"/g) ?? []).length, 1, "one card");
  for (const [file, kind] of [["components/data/billing/BillingWorkspace.tsx", "billing"], ["components/data/taxes/TaxesWorkspace.tsx", "tax"]] as const) {
    const src = read(file);
    assert.match(src, /view === BULK_ASSIGNMENT_VIEW && BULK_ASSIGNMENT_KIND_FOR_MODULE\[(i\.)?moduleKey\] === "/, `${file}: URL → page (refresh / deep link)`);
    assert.match(src, /bulk-assign"\) (return|crumbs|: )|case "bulk-assign"/, `${file}: page → URL`);
    assert.match(src, /b\.view === "bulk-assignment"\) go\(\{ kind: "bulk-assign"/, `${file}: card navigation target`);
    assert.ok(src.includes(`<BulkAssignmentPage isDark={isDark} kind="${kind}"`), `${file}: renders the ${kind} page`);
    assert.ok(src.includes("Bulk Product Assignment"), `${file}: breadcrumb`);
    assert.match(src, /onBackToPolicies=\{\(\) => go\(\{ kind: "module", moduleKey: view\.moduleKey \}\)\}/, `${file}: back to policies`);
  }
  assert.equal(BULK_ASSIGNMENT_VIEW, "bulk-assignment");
});

test("navigation: the page intro follows the dedicated pages; policy intros explain the feature", () => {
  assert.equal(moduleGuideKeyFor({ itemId: "billing-policies", groupId: "billing", billingModule: "billing-policies", billingView: "bulk-assignment" }), "billing-bulk-assignment");
  assert.equal(moduleGuideKeyFor({ itemId: "taxes-policies", groupId: "taxes", taxesKey: taxesIntroKey({ tv: "bulk-assignment", tm: "tax-policies", tid: null }) }), "tax-bulk-assignment");
  assert.equal(taxesIntroKey({ tv: null, tm: "tax-policies", tid: null }), "tax-policies");
  const b = JSON.stringify(MODULE_GUIDES["billing-policies"]), t = JSON.stringify(MODULE_GUIDES["tax-policies"]);
  for (const s of [b, t]) { assert.match(s, /dedicated Bulk Product Assignment page/); assert.match(s, /never overwrites/); }
  assert.match(b, /Billing Treatment Item/); assert.match(b, /Tax Policy doesn't matter/);
  assert.match(t, /Tax Treatment Item/); assert.match(t, /Billing Policy doesn't matter/);
});
