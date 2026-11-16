import {
  MAX_BULK_PRODUCTS, POLICY_KIND_LABELS, TREATMENT_ITEM_COMPLETE, summarizeResults,
  type BulkAssignError, type BulkAssignResponse, type BulkProductResult, type FailureKind, type PolicyCheckResult, type PolicyKind, type TreatmentItemResult, type TreatmentItemSummary,
} from "@/lib/policyAssignment/types";

/**
 * BULK POLICY ASSIGNMENT ENGINE — pure logic over an injected backend (lib/policyAssignment/server.ts wires the real
 * Salesforce one; tests use an in-memory org). The same rules hold for Billing and Tax; only the backend differs.
 *
 *  1. The policy must exist and pass its kind's validation (blockers refuse the whole request).
 *  2. Every product is RE-READ from Salesforce now — the list the user saw is never trusted:
 *       no policy of this kind → write;  same policy → already-assigned;  different policy → ineligible (never overwritten).
 *  3. Writes are conditional: each carries the LastModifiedDate just read (If-Unmodified-Since). If the product changed in
 *     between (someone else assigned a policy, or edited it), Salesforce refuses with 412 and nothing is overwritten.
 *  4. Every write is re-read; "assigned" is only reported when Salesforce shows the selected policy on the product.
 * Retrying is safe: assigned products now carry the policy, so a retry reports them as already-assigned and writes nothing.
 *
 * TREATMENT ITEMS (when the backend provides `treatmentItems`) — order, per product:
 *    a. ensure the Treatment Item mapping BEFORE linking the policy (tax: create/reuse the product's TaxTreatmentItem;
 *       billing: the shared item is verified). If it can't be completed (e.g. no Tax Code), the policy is NOT linked — the
 *       product stays eligible, so nothing is left half-configured and a retry starts cleanly;
 *    b. link the policy (the conditional Product2 write above);
 *    c. re-read both the product and its Treatment Item. Only when both are confirmed is the product "assigned".
 * A product that already has THIS policy gets step (a) too — that's how a retry completes a partial state (assigned-incomplete)
 * without re-writing the policy. Items are created before the link, so a link that then fails leaves a correct, reusable item
 * for an unlinked product — never a policy pointing at a missing item.
 */

export interface ProductState { id: string; name: string; code: string | null; policyId: string | null; lastModified: string | null }
export interface ConditionalWrite { id: string; ifUnmodifiedSince: string | null }
export interface WriteResult { id: string; status: number; errorCode?: string | null; message?: string | null }

export interface AssignmentBackend {
  kind: PolicyKind;
  /** The Product2 field for this kind, and whether this user may update it. null = the org has no such relationship. */
  field: { name: string; updateable: boolean } | null;
  loadPolicy(id: string): Promise<PolicyCheckResult | null>;
  policyNames(ids: string[]): Promise<Map<string, string>>;
  /** Fresh read of the products (missing/invisible products are simply absent). */
  readProducts(ids: string[]): Promise<ProductState[]>;
  /** Conditionally set the field to `policyId` on each product; one result per write. */
  writePolicy(policyId: string, writes: ConditionalWrite[]): Promise<WriteResult[]>;
  /** Treatment Item configuration for this kind (optional — without it the engine only links policies). */
  treatmentItems?: TreatmentItemBackend;
}

/**
 * Treatment Item mapping for one policy kind. `ensure` is idempotent: it reuses the product's existing item, completes a
 * missing Tax Code on it, or creates the item — never a duplicate, never another product's item. `verify` re-reads Salesforce.
 * Results are keyed by 15-char product Id.
 */
export interface TreatmentItemBackend {
  ensure(policy: PolicyCheckResult, summary: TreatmentItemSummary, products: ProductState[]): Promise<Map<string, TreatmentItemResult>>;
  verify(policy: PolicyCheckResult, summary: TreatmentItemSummary, products: ProductState[]): Promise<Map<string, TreatmentItemResult>>;
}

export const itemComplete = (r: TreatmentItemResult | null | undefined) => !!r && TREATMENT_ITEM_COMPLETE.has(r.status);
const PERMISSION_CODES = new Set(["INSUFFICIENT_ACCESS_OR_READONLY", "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY", "INSUFFICIENT_ACCESS"]);

export const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
export const id15 = (id: string | null | undefined) => (id ? id.slice(0, 15) : null);
const sameId = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && id15(a) === id15(b);

export interface BulkInput { policyId: string; productIds: string[] }

export function parseBulkInput(body: Record<string, unknown>): BulkInput | BulkAssignError {
  const bad = (error: string): BulkAssignError => ({ success: false, status: 400, code: "INVALID_REQUEST", error });
  if (typeof body.policyId !== "string" || !SALESFORCE_ID_RE.test(body.policyId)) return bad("Select a valid policy.");
  if (!Array.isArray(body.productIds) || body.productIds.length === 0) return bad("Select at least one product.");
  if (!body.productIds.every(x => typeof x === "string" && SALESFORCE_ID_RE.test(x))) return bad("One or more product references are invalid.");
  const seen = new Set<string>();
  const productIds = (body.productIds as string[]).filter(id => { const k = id15(id)!; if (seen.has(k)) return false; seen.add(k); return true; });
  if (productIds.length > MAX_BULK_PRODUCTS) return bad(`Select at most ${MAX_BULK_PRODUCTS} products per assignment.`);
  // The Tax Code is resolved from Salesforce configuration (Tax Treatment → Tax Engine); it can't be supplied or overridden.
  if (body.taxCode !== undefined || body.defaultTaxCode !== undefined) return bad("A Tax Code can't be supplied — it's resolved from the selected Tax Policy's Tax Treatment (or its Tax Engine).");
  return { policyId: body.policyId, productIds };
}

export async function runBulkAssignment(backend: AssignmentBackend, input: { policyId: string; productIds: string[] }): Promise<BulkAssignResponse | BulkAssignError> {
  const L = POLICY_KIND_LABELS[backend.kind];
  const err = (status: number, code: string, error: string): BulkAssignError => ({ success: false, status, code, error });

  if (!backend.field) return err(422, "RELATIONSHIP_MISSING", `This org has no Product field that references ${L.policy}, so ${L.policies.toLowerCase()} can't be assigned to products.`);
  if (!backend.field.updateable) return err(403, "FIELD_NOT_UPDATEABLE", `Your user can't update Product2.${backend.field.name} (object permission or field-level security).`);
  const field = backend.field.name;

  const policy = await backend.loadPolicy(input.policyId);
  if (!policy) return err(404, "POLICY_NOT_FOUND", `The selected ${L.policy} no longer exists in Salesforce or isn't visible to your user.`);
  if (policy.blockers.length) return err(422, "POLICY_NOT_ASSIGNABLE", policy.blockers[0]);
  const summary = backend.treatmentItems ? policy.treatmentItems ?? null : null;
  const items = backend.treatmentItems && summary ? backend.treatmentItems : null;

  // 1. Live state of every requested product.
  const before = new Map((await backend.readProducts(input.productIds)).map(p => [id15(p.id)!, p]));
  const otherPolicyIds = [...new Set([...before.values()].map(p => p.policyId).filter((x): x is string => !!x && !sameId(x, policy.id)))];
  const names = otherPolicyIds.length ? await backend.policyNames(otherPolicyIds) : new Map<string, string>();
  const nameIn = (m: Map<string, string>, id: string) => m.get(id) ?? [...m.entries()].find(([k]) => sameId(k, id))?.[1] ?? `${L.policy} ${id}`;

  const results = new Map<string, BulkProductResult>();
  const set = (id: string, r: Omit<BulkProductResult, "productId"> & { productId?: string }) => results.set(id15(id)!, { productId: id, ...r } as BulkProductResult);
  const toLink: ProductState[] = [];
  const already: ProductState[] = [];
  for (const id of input.productIds) {
    const p = before.get(id15(id)!);
    const base = { productName: p?.name ?? id, productCode: p?.code ?? null, existingPolicy: null, retryable: false, treatmentItem: null };
    if (!p) set(id, { ...base, outcome: "failed", failureKind: "not-found", reason: "Product not found in Salesforce or not visible to your user." });
    else if (sameId(p.policyId, policy.id)) already.push(p);
    else if (p.policyId) set(id, { ...base, outcome: "ineligible", existingPolicy: { id: p.policyId, name: nameIn(names, p.policyId) }, reason: `Already has ${L.policy} "${nameIn(names, p.policyId)}" — existing assignments are never overwritten.` });
    else toLink.push(p);
  }

  // 2a. Treatment Items BEFORE the link (and for products that already have this policy — repair).
  const ensured = items ? await items.ensure(policy, summary!, [...toLink, ...already]) : new Map<string, TreatmentItemResult>();
  const itemOf = (p: ProductState) => ensured.get(id15(p.id)!) ?? null;
  const linkable = toLink.filter(p => {
    if (!items) return true;
    const it = itemOf(p);
    if (itemComplete(it)) return true;
    const kind: FailureKind = /can't (create|update)/.test(it?.detail ?? "") ? "permission" : "treatment-item";
    set(p.id, { productName: p.name, productCode: p.code, existingPolicy: null, treatmentItem: it, outcome: "failed", failureKind: kind, retryable: kind !== "permission",
      reason: `${L.policy} not assigned — the Treatment Item couldn't be configured first: ${it?.detail ?? "no result"}` });
    return false;
  });

  // 2b. Conditional writes.
  const written: string[] = [];
  const changed: string[] = [];
  if (linkable.length) {
    const outcomes = await backend.writePolicy(policy.id, linkable.map(p => ({ id: p.id, ifUnmodifiedSince: p.lastModified })));
    const byId = new Map(outcomes.map(o => [id15(o.id)!, o]));
    for (const p of linkable) {
      const o = byId.get(id15(p.id)!);
      const base = { productName: p.name, productCode: p.code, existingPolicy: null, treatmentItem: itemOf(p) };
      if (!o) set(p.id, { ...base, outcome: "failed", failureKind: "salesforce", reason: "Salesforce returned no result for this product.", retryable: true });
      else if (o.status >= 200 && o.status < 300) written.push(p.id);
      else if (o.status === 412) changed.push(p.id);
      else {
        const perm = PERMISSION_CODES.has(o.errorCode ?? "");
        set(p.id, { ...base, outcome: "failed", failureKind: perm ? "permission" : "salesforce", retryable: !perm,
          reason: `Salesforce rejected the update: ${o.message ?? `HTTP ${o.status}`}${o.errorCode ? ` (${o.errorCode})` : ""}${base.treatmentItem?.status === "created" ? " The Treatment Item created for it is kept and will be reused." : ""}` });
      }
    }
  }

  // 2c. Re-read everything we wrote or that changed underneath us.
  const linked: ProductState[] = [];
  const recheckIds = [...written, ...changed];
  if (recheckIds.length) {
    const after = new Map((await backend.readProducts(recheckIds)).map(p => [id15(p.id)!, p]));
    const late = await backend.policyNames([...after.values()].map(p => p.policyId).filter((x): x is string => !!x && !sameId(x, policy.id)));
    for (const id of recheckIds) {
      const prev = linkable.find(p => sameId(p.id, id))!;
      const now = after.get(id15(id)!);
      const wasConflict = changed.includes(id);
      const base = { productName: now?.name ?? prev.name, productCode: now?.code ?? prev.code, existingPolicy: null, treatmentItem: itemOf(prev) };
      if (now && sameId(now.policyId, policy.id)) {
        if (wasConflict) already.push(now); // assigned by another operation meanwhile — treated like an existing assignment
        else linked.push(now);
      } else if (now?.policyId) {
        set(id, { ...base, outcome: "ineligible", existingPolicy: { id: now.policyId, name: nameIn(late, now.policyId) }, retryable: false,
          reason: `${L.policy} "${nameIn(late, now.policyId)}" was assigned in Salesforce after the list loaded — this product is no longer eligible and was not changed.` });
      } else if (wasConflict) {
        set(id, { ...base, outcome: "failed", failureKind: "concurrent-change", retryable: true, reason: "The product was edited in Salesforce during the assignment, so it wasn't changed. It still has no policy — retry to assign it." });
      } else {
        set(id, { ...base, outcome: "failed", failureKind: "verification", retryable: true, reason: `Salesforce accepted the update but the product doesn't show ${policy.name} — check automation on Product2, then retry.` });
      }
    }
  }

  // 3. Verify Treatment Items for every product that now has the policy (newly linked + already assigned).
  const withPolicy = [...linked, ...already.filter(p => !results.has(id15(p.id)!))];
  const verified = items && withPolicy.length ? await items.verify(policy, summary!, withPolicy) : new Map<string, TreatmentItemResult>();
  for (const p of withPolicy) {
    const isNew = linked.includes(p);
    const ensuredItem = itemOf(p);
    const v = items ? verified.get(id15(p.id)!) ?? null : null;
    const ok = !items || (itemComplete(ensuredItem) && itemComplete(v));
    // Report the action taken (created / updated / reused) once Salesforce confirms it.
    // Verified values (item Id/name/code as Salesforce has them), but keep what this run did and where the Tax Code came from.
    const treatmentItem = items ? (ok ? { ...v!, status: ensuredItem!.status, taxCodeSource: ensuredItem!.taxCodeSource ?? v!.taxCodeSource } : (v && !itemComplete(v) ? v : ensuredItem)) : null;
    const base = { productName: p.name, productCode: p.code, existingPolicy: null, treatmentItem };
    if (ok) {
      const repaired = !isNew && (ensuredItem?.status === "created" || ensuredItem?.status === "updated");
      set(p.id, { ...base, outcome: isNew ? "assigned" : "already-assigned", retryable: false,
        reason: isNew ? null : repaired ? `Already assigned to ${policy.name}; its missing Treatment Item configuration was completed now (the policy wasn't re-written).` : `Already assigned to ${policy.name} — nothing changed.` });
    } else {
      set(p.id, { ...base, outcome: "assigned-incomplete", failureKind: treatmentItem?.status === "missing-tax-code" ? "missing-tax-code" : "treatment-item", retryable: true,
        reason: `${isNew ? `${L.policy} assigned` : `Already assigned to ${policy.name}`}, but the Treatment Item configuration isn't complete: ${treatmentItem?.detail ?? "not verified"} Retry completes it without re-assigning the policy.` });
    }
  }

  const ordered = input.productIds.map(id => results.get(id15(id)!)!).filter(Boolean);
  const s = summarizeResults(ordered);
  return { success: true, kind: backend.kind, field, policy: { id: policy.id, name: policy.name, status: policy.status }, requested: input.productIds.length, ...s, warnings: policy.warnings, treatmentItems: summary, results: ordered };
}


/* ── SOQL builders (shared by both kinds; the field is always the kind's own relationship) ── */

export interface ProductCursor { name: string; id: string }

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const escLike = (s: string) => esc(s).replace(/[%_]/g, m => `\\${m}`);

export function encodeCursor(c: ProductCursor): string { return Buffer.from(JSON.stringify([c.name, c.id]), "utf8").toString("base64url"); }
export function decodeCursor(raw: string | null | undefined): ProductCursor | null {
  if (!raw) return null;
  try {
    const [name, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
    return typeof name === "string" && typeof id === "string" && SALESFORCE_ID_RE.test(id) ? { name, id } : null;
  } catch { return null; }
}

/** WHERE clause for "eligible for <field>": the field is null (this kind only), plus an optional Name/Code search. */
export function eligibleWhere(field: string, opts: { q?: string; hasCode: boolean }): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`Invalid field name ${field}`);
  const where = [`${field} = null`];
  const term = (opts.q ?? "").trim().slice(0, 80);
  if (term) {
    const or = [`Name LIKE '%${escLike(term)}%'`];
    if (opts.hasCode) or.push(`ProductCode LIKE '%${escLike(term)}%'`);
    where.push(`(${or.join(" OR ")})`);
  }
  return where;
}

/** One keyset page (Name, Id) of eligible products — no OFFSET, so no 2,000-row ceiling and pages never overlap. Fetches one extra row. */
export function eligibleProductSoql(cols: string, field: string, opts: { q?: string; after: ProductCursor | null; pageSize: number; hasCode: boolean }): string {
  const where = eligibleWhere(field, opts);
  if (opts.after) {
    const n = esc(opts.after.name);
    where.push(`(Name > '${n}' OR (Name = '${n}' AND Id > '${esc(opts.after.id)}'))`);
  }
  return `SELECT ${cols} FROM Product2 WHERE ${where.join(" AND ")} ORDER BY Name, Id LIMIT ${opts.pageSize + 1}`;
}
