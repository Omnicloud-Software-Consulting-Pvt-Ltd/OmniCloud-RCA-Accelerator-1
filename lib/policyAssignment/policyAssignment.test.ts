import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, eligibleProductSoql, eligibleWhere, encodeCursor, parseBulkInput, runBulkAssignment, type AssignmentBackend, type ProductState } from "@/lib/policyAssignment/engine";
import { applyResults, deselectMany, emptySelection, mergePage, pageState, selectMany, toggle } from "@/lib/policyAssignment/selection";
import { toHttpDate } from "@/lib/policyAssignment/server";
import { MAX_BULK_PRODUCTS, type BulkAssignResponse, type EligibleProduct, type PolicyKind } from "@/lib/policyAssignment/types";

/* ── In-memory org: Product2 with BOTH policy fields, and Salesforce's If-Unmodified-Since behaviour (412 when changed). ── */

const FIELD: Record<PolicyKind, "BillingPolicyId" | "TaxPolicyId"> = { billing: "BillingPolicyId", tax: "TaxPolicyId" };
const pid = (n: number) => `01t000000000${String(n).padStart(3, "0")}AAA`;
const BP = (n: number) => `0Ze00000000000${n}AAA`.slice(0, 18);
const TP = (n: number) => `1Tp00000000000${n}AAA`.slice(0, 18);

interface Row { id: string; name: string; code: string; BillingPolicyId: string | null; TaxPolicyId: string | null; modified: number }

class FakeOrg {
  products = new Map<string, Row>();
  policies: Record<PolicyKind, Map<string, { name: string; status: string; blockers?: string[] }>> = { billing: new Map(), tax: new Map() };
  clock = Date.parse("2026-11-05T10:00:00Z");
  writes: { kind: PolicyKind; id: string }[] = [];
  /** Runs once, right after the engine's fresh read and before its writes (simulates another user). */
  beforeWrite: (() => void) | null = null;
  failWrite = new Set<string>();

  addProduct(n: number, p: Partial<Row> = {}) {
    const row: Row = { id: pid(n), name: `Product ${n}`, code: `P-${n}`, BillingPolicyId: null, TaxPolicyId: null, modified: this.clock, ...p };
    this.products.set(row.id, row);
    return row;
  }
  touch(id: string, change: Partial<Row>) { this.clock += 5000; Object.assign(this.products.get(id)!, change, { modified: this.clock }); }
  eligible(kind: PolicyKind): string[] { return [...this.products.values()].filter(p => p[FIELD[kind]] === null).map(p => p.id); }

  backend(kind: PolicyKind, opts: { updateable?: boolean; noField?: boolean } = {}): AssignmentBackend {
    const f = FIELD[kind];
    return {
      kind,
      field: opts.noField ? null : { name: f, updateable: opts.updateable ?? true },
      loadPolicy: async id => {
        const p = this.policies[kind].get(id);
        if (!p) return null;
        return { id, name: p.name, status: p.status, blockers: p.blockers ?? (p.status === "Inactive" ? [`${p.name} is Inactive.`] : []), warnings: p.status === "Draft" ? [`${p.name} is Draft.`] : [] };
      },
      policyNames: async ids => new Map(ids.map(id => [id, [...Object.values(this.policies)].map(m => m.get(id)?.name).find(Boolean) ?? id])),
      readProducts: async ids => ids.map(id => this.products.get(id)).filter((r): r is Row => !!r)
        .map((r): ProductState => ({ id: r.id, name: r.name, code: r.code, policyId: r[f], lastModified: new Date(r.modified).toISOString() })),
      writePolicy: async (policyId, writes) => {
        if (this.beforeWrite) { const fn = this.beforeWrite; this.beforeWrite = null; fn(); }
        return writes.map(w => {
          const r = this.products.get(w.id);
          if (!r) return { id: w.id, status: 404, errorCode: "NOT_FOUND", message: "not found" };
          if (this.failWrite.has(w.id)) return { id: w.id, status: 400, errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Validation rule blocked it" };
          if (w.ifUnmodifiedSince && Math.floor(r.modified / 1000) > Math.floor(Date.parse(w.ifUnmodifiedSince) / 1000)) return { id: w.id, status: 412, errorCode: "PRECONDITION_FAILED", message: "modified" };
          this.writes.push({ kind, id: w.id });
          this.clock += 1000;
          r[f] = policyId; r.modified = this.clock;
          return { id: w.id, status: 204 };
        });
      },
    };
  }
}

function org() {
  const o = new FakeOrg();
  o.policies.billing.set(BP(1), { name: "Standard Billing", status: "Active" });
  o.policies.billing.set(BP(2), { name: "Old Billing", status: "Active" });
  o.policies.billing.set(BP(3), { name: "Retired Billing", status: "Inactive" });
  o.policies.tax.set(TP(1), { name: "GST 18", status: "Active" });
  o.policies.tax.set(TP(2), { name: "VAT 20", status: "Active" });
  o.policies.tax.set(TP(3), { name: "Draft Tax", status: "Draft" });
  return o;
}
const ok = (r: Awaited<ReturnType<typeof runBulkAssignment>>): BulkAssignResponse => { assert.ok(r.success, JSON.stringify(r)); return r as BulkAssignResponse; };
const outcome = (r: BulkAssignResponse, id: string) => r.results.find(x => x.productId === id)?.outcome;

/* ── Eligibility (independent per kind) ── */

for (const kind of ["billing", "tax"] as PolicyKind[]) {
  const other: PolicyKind = kind === "billing" ? "tax" : "billing";
  const P = kind === "billing" ? BP : TP;
  const OP = kind === "billing" ? TP : BP;

  test(`${kind}: eligibility filters ONLY on ${FIELD[kind]} (SOQL + semantics)`, () => {
    const where = eligibleWhere(FIELD[kind], { hasCode: true }).join(" AND ");
    assert.match(where, new RegExp(`${FIELD[kind]} = null`));
    assert.doesNotMatch(where, new RegExp(FIELD[other]));
    const o = org();
    o.addProduct(1);                                      // neither → eligible
    o.addProduct(2, { [FIELD[kind]]: P(2) });             // has this kind → excluded
    o.addProduct(3, { [FIELD[other]]: OP(1) });           // only the other kind → still eligible
    o.addProduct(4, { [FIELD[kind]]: P(1), [FIELD[other]]: OP(1) }); // both → excluded
    assert.deepEqual(o.eligible(kind), [pid(1), pid(3)]);
  });

  test(`${kind}: assigns eligible products, never overwrites an existing ${kind} policy, ignores the other kind`, async () => {
    const o = org();
    o.addProduct(1);
    o.addProduct(2, { [FIELD[kind]]: P(2) });
    o.addProduct(3, { [FIELD[other]]: OP(2) });
    o.addProduct(4, { [FIELD[kind]]: P(1) });
    const r = ok(await runBulkAssignment(o.backend(kind), { policyId: P(1), productIds: [pid(1), pid(2), pid(3), pid(4)] }));
    assert.equal(outcome(r, pid(1)), "assigned");
    assert.equal(outcome(r, pid(2)), "ineligible");
    assert.equal(r.results.find(x => x.productId === pid(2))!.existingPolicy?.id, P(2));
    assert.equal(outcome(r, pid(3)), "assigned", "a product with only the OTHER policy is eligible");
    assert.equal(outcome(r, pid(4)), "already-assigned");
    assert.equal(o.products.get(pid(2))![FIELD[kind]], P(2), "existing policy untouched");
    assert.equal(o.products.get(pid(3))![FIELD[other]], OP(2), "other kind untouched");
    assert.deepEqual(o.writes.map(w => w.id).sort(), [pid(1), pid(3)], "only eligible products written");
    assert.deepEqual([r.requested, r.assigned, r.skipped, r.failed], [4, 2, 2, 0]);
    // successfully assigned products are no longer eligible
    assert.deepEqual(o.eligible(kind), []);
  });

  test(`${kind}: a policy assigned by someone else after the list loaded is detected and not overwritten`, async () => {
    const o = org();
    o.addProduct(1); o.addProduct(2);
    // Another user assigns a different policy to product 2 between our fresh read and our write.
    o.beforeWrite = () => o.touch(pid(2), { [FIELD[kind]]: P(2) });
    const r = ok(await runBulkAssignment(o.backend(kind), { policyId: P(1), productIds: [pid(1), pid(2)] }));
    assert.equal(outcome(r, pid(1)), "assigned");
    assert.equal(outcome(r, pid(2)), "ineligible");
    assert.match(r.results[1].reason!, /after the list loaded/);
    assert.equal(o.products.get(pid(2))![FIELD[kind]], P(2), "concurrent assignment preserved");
  });

  test(`${kind}: a concurrent unrelated edit fails the product safely and a retry assigns it without duplicating others`, async () => {
    const o = org();
    o.addProduct(1); o.addProduct(2);
    o.beforeWrite = () => o.touch(pid(2), { name: "Renamed" });
    const first = ok(await runBulkAssignment(o.backend(kind), { policyId: P(1), productIds: [pid(1), pid(2)] }));
    assert.equal(outcome(first, pid(2)), "failed");
    assert.equal(first.results[1].retryable, true);
    const writesBefore = o.writes.length;
    const retry = ok(await runBulkAssignment(o.backend(kind), { policyId: P(1), productIds: [pid(1), pid(2)] }));
    assert.equal(outcome(retry, pid(1)), "already-assigned", "already-assigned product is not written again");
    assert.equal(outcome(retry, pid(2)), "assigned");
    assert.equal(o.writes.length - writesBefore, 1, "exactly one new write");
  });

  test(`${kind}: partial failure is reported per product`, async () => {
    const o = org();
    o.addProduct(1); o.addProduct(2);
    o.failWrite.add(pid(2));
    const r = ok(await runBulkAssignment(o.backend(kind), { policyId: P(1), productIds: [pid(1), pid(2), pid(9)] }));
    assert.deepEqual(r.results.map(x => x.outcome), ["assigned", "failed", "failed"]);
    assert.match(r.results[1].reason!, /Validation rule/);
    assert.match(r.results[2].reason!, /not found/);
    assert.equal(r.results[2].retryable, false);
  });

  test(`${kind}: invalid / missing policy and missing permissions refuse the whole request`, async () => {
    const o = org();
    o.addProduct(1);
    const notFound = await runBulkAssignment(o.backend(kind), { policyId: P(7), productIds: [pid(1)] });
    assert.equal(notFound.success, false); assert.equal((notFound as { status: number }).status, 404);
    const noField = await runBulkAssignment(o.backend(kind, { noField: true }), { policyId: P(1), productIds: [pid(1)] });
    assert.equal((noField as { code: string }).code, "RELATIONSHIP_MISSING");
    const ro = await runBulkAssignment(o.backend(kind, { updateable: false }), { policyId: P(1), productIds: [pid(1)] });
    assert.equal((ro as { code: string }).code, "FIELD_NOT_UPDATEABLE");
    assert.equal(o.writes.length, 0);
  });
}

test("billing: an Inactive policy is refused; tax: a Draft policy is allowed with a warning", async () => {
  const o = org();
  o.addProduct(1);
  const inactive = await runBulkAssignment(o.backend("billing"), { policyId: BP(3), productIds: [pid(1)] });
  assert.equal((inactive as { code: string }).code, "POLICY_NOT_ASSIGNABLE");
  assert.equal(o.writes.length, 0);
  const draft = ok(await runBulkAssignment(o.backend("tax"), { policyId: TP(3), productIds: [pid(1)] }));
  assert.equal(draft.assigned, 1);
  assert.match(draft.warnings[0], /Draft/);
});

/* ── Request validation (backend-enforced) ── */

test("parseBulkInput validates ids, de-duplicates (15/18-char) and caps the batch", () => {
  assert.equal((parseBulkInput({ productIds: [pid(1)] }) as { code: string }).code, "INVALID_REQUEST");
  assert.equal((parseBulkInput({ policyId: BP(1), productIds: [] }) as { code: string }).code, "INVALID_REQUEST");
  assert.equal((parseBulkInput({ policyId: BP(1), productIds: ["x'; DELETE"] }) as { code: string }).code, "INVALID_REQUEST");
  const ok15 = parseBulkInput({ policyId: BP(1), productIds: [pid(1), pid(1).slice(0, 15), pid(2)] });
  assert.ok(!("success" in ok15)); assert.deepEqual((ok15 as { productIds: string[] }).productIds, [pid(1), pid(2)]);
  const tooMany = parseBulkInput({ policyId: BP(1), productIds: Array.from({ length: MAX_BULK_PRODUCTS + 1 }, (_, i) => pid(i)) });
  assert.equal((tooMany as { code: string }).code, "INVALID_REQUEST");
});

test("eligible SOQL: keyset pagination, escaped search, validated field name", () => {
  const soql = eligibleProductSoql("Id, Name", "TaxPolicyId", { q: "50%_o'k", after: { name: "Lap'top", id: pid(1) }, pageSize: 50, hasCode: true });
  assert.match(soql, /WHERE TaxPolicyId = null AND/);
  assert.match(soql, /Name LIKE '%50\\%\\_o\\'k%'/);
  assert.match(soql, /\(Name > 'Lap\\'top' OR \(Name = 'Lap\\'top' AND Id > '01t/);
  assert.match(soql, /ORDER BY Name, Id LIMIT 51$/);
  assert.throws(() => eligibleWhere("TaxPolicyId; DELETE", { hasCode: false }));
  const c = encodeCursor({ name: "A", id: pid(1) });
  assert.deepEqual(decodeCursor(c), { name: "A", id: pid(1) });
  assert.equal(decodeCursor("garbage"), null);
});

test("toHttpDate converts Salesforce timestamps for If-Unmodified-Since", () => {
  assert.equal(toHttpDate("2026-11-05T10:00:00.000+0000"), "Thu, 05 Nov 2026 10:00:00 GMT");
  assert.equal(toHttpDate(null), null);
  assert.equal(toHttpDate("nope"), null);
});

/* ── Selection (UI state) ── */

const ep = (n: number): EligibleProduct => ({ id: pid(n), name: `Product ${n}`, code: `P-${n}`, family: null, active: true });

test("selection: toggle, select all, clear, page state; survives search/pagination", () => {
  let s = emptySelection();
  s = toggle(s, ep(1)); s = toggle(s, ep(2));
  assert.equal(s.size, 2);
  s = toggle(s, ep(1));
  assert.deepEqual([...s.keys()], [pid(2)]);
  const page1 = [ep(1), ep(2)], page2 = [ep(3)];
  assert.equal(pageState(s, page1), "some");
  s = selectMany(s, page1);
  assert.equal(pageState(s, page1), "all");
  // a different page (search result / next page) doesn't drop earlier selections
  assert.equal(pageState(s, page2), "none");
  s = selectMany(s, page2);
  assert.equal(s.size, 3);
  s = deselectMany(s, page2);
  assert.equal(s.size, 2);
  assert.equal(emptySelection().size, 0);
  assert.equal(mergePage(page1, [ep(2), ep(3)]).length, 3, "no duplicates when merging pages");
});

test("selection: select-all respects the per-request cap", () => {
  const many = Array.from({ length: MAX_BULK_PRODUCTS + 20 }, (_, i) => ep(i));
  assert.equal(selectMany(emptySelection(), many).size, MAX_BULK_PRODUCTS);
});

test("after assignment: settled products leave the list and selection, failures stay selected for retry", async () => {
  const o = org();
  o.addProduct(1); o.addProduct(2, { BillingPolicyId: BP(2) }); o.addProduct(3);
  o.failWrite.add(pid(3));
  const r = ok(await runBulkAssignment(o.backend("billing"), { policyId: BP(1), productIds: [pid(1), pid(2), pid(3)] }));
  const sel = selectMany(emptySelection(), [ep(1), ep(2), ep(3)]);
  const after = applyResults([ep(1), ep(2), ep(3), ep(4)], sel, r.results);
  assert.deepEqual(after.list.map(p => p.id), [pid(3), pid(4)]);
  assert.deepEqual([...after.selection.keys()], [pid(3)]);
});
