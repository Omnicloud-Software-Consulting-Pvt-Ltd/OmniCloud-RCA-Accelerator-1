import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, queryAt, SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { discoverAssignmentField, evaluatePolicyChain, loadPolicyChain } from "@/lib/billing/server/assignment";
import { billingDescribe } from "@/lib/billing/server/discovery";
import { discoverTaxMetadata, objectMeta, referenceField, selectable } from "@/lib/tax/server/metadata";
import { readPolicies } from "@/lib/tax/server/records";
import type { TaxMetadata } from "@/lib/tax/types";
import {
  decodeCursor, eligibleProductSoql, eligibleWhere, encodeCursor, id15,
  type AssignmentBackend, type ConditionalWrite, type ProductState, type WriteResult,
} from "@/lib/policyAssignment/engine";
import { billingSummary, billingTreatmentItemBackend, taxSummary, taxTreatmentItemBackend, type TaxItemApi } from "@/lib/policyAssignment/treatmentItems";
import {
  ELIGIBLE_PAGE_SIZE, MAX_BULK_PRODUCTS,
  type BulkPolicyOption, type EligibleProduct, type EligibleProductsResponse, type PolicyCheckResult, type PolicyKind, type TreatmentItemSummary,
} from "@/lib/policyAssignment/types";

/**
 * Salesforce side of Bulk Product Policy Assignment. Each kind keeps its OWN field, validation, Treatment Item rules and API version:
 *  · billing: Product2 → BillingPolicy reference field from Product2 Describe (discoverAssignmentField — the same discovery the
 *    single-product "Assign Billing Policy" flow uses), validated with the same Policy → Treatment → Item chain check
 *    (evaluatePolicyChain "assign"); Billing Treatment Items are shared per treatment and only VERIFIED (never created per
 *    product — Salesforce allows one item on a non-milestone treatment and none while it's Active).
 *  · tax: Product2 → TaxPolicy reference field from tax metadata (TaxPolicyId — the field the Tax assistant's ASSIGN writes);
 *    TaxTreatmentItem (TaxTreatmentId + ProductId + TaxCode + ProductCode) created/reused per product when the policy's default
 *    treatment uses items. All on the tax metadata's API version.
 * Product2 writes: PATCH Product2.<field> = policy Id — the same write the single-product flows make — as Composite sub-requests
 * (allOrNone false, 25 per call) carrying If-Unmodified-Since, so a concurrently changed product is refused (412).
 */

interface KindContext {
  kind: PolicyKind;
  version: string;
  field: { name: string; updateable: boolean } | null;
  policySobject: string;
  hasCode: boolean;
  hasFamily: boolean;
  hasActive: boolean;
  meta: TaxMetadata | null;
}

async function contextFor(client: SalesforceClient, kind: PolicyKind): Promise<KindContext> {
  if (kind === "billing") {
    const f = await discoverAssignmentField(client);
    const d = await billingDescribe(client, "Product2");
    const has = (n: string) => d.fields.some(x => x.name === n);
    return {
      kind, version: client.apiVersion.startsWith("v") ? client.apiVersion : `v${client.apiVersion}`,
      field: f ? { name: f.name, updateable: f.updateable && f.productUpdateable } : null,
      policySobject: "BillingPolicy", hasCode: has("ProductCode"), hasFamily: has("Family"), hasActive: has("IsActive"), meta: null,
    };
  }
  const meta = await discoverTaxMetadata(client);
  const product = objectMeta(meta, "Product2");
  const name = meta.relationships["Product2→TaxPolicy"] ?? null;
  return {
    kind, version: meta.apiVersion,
    field: name && product ? { name, updateable: product.updateable && !!product.fields[name]?.updateable } : null,
    policySobject: "TaxPolicy", hasCode: !!product?.fields.ProductCode, hasFamily: !!product?.fields.Family, hasActive: !!product?.fields.IsActive, meta,
  };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const statusText = (v: unknown) => (typeof v === "boolean" ? (v ? "Active" : "Inactive") : str(v));
const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function productCols(ctx: KindContext, extra: string[] = []): string {
  return ["Id", "Name", ctx.hasCode && "ProductCode", ctx.hasFamily && "Family", ctx.hasActive && "IsActive", ...extra].filter(Boolean).join(", ");
}
function toEligible(r: Record<string, unknown>): EligibleProduct {
  return { id: String(r.Id), name: String(r.Name ?? ""), code: str(r.ProductCode), family: str(r.Family), active: typeof r.IsActive === "boolean" ? r.IsActive : null };
}

/** Composite with allOrNone false — every sub-request succeeds or fails on its own. */
interface Sub { method: "POST" | "PATCH"; url: string; body: Record<string, unknown>; headers?: Record<string, string> }
async function compositeIndependent(client: SalesforceClient, version: string, subs: Sub[]): Promise<{ status: number; body: unknown }[]> {
  const out: { status: number; body: unknown }[] = [];
  for (const part of chunks(subs, 25)) {
    const res = await client.requestWithDiagnostics(apiUrl(client, version, "/composite"), {
      method: "POST",
      body: JSON.stringify({
        allOrNone: false,
        compositeRequest: part.map((s, i) => ({ method: s.method, referenceId: `r${i}`, url: `/services/data/${version}${s.url}`, body: s.body, ...(s.headers ? { httpHeaders: s.headers } : {}) })),
      }),
    });
    if (res.status >= 400) {
      const errs = Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : [];
      throw new SalesforceCallError(errs.map(e => e.message).join("; ") || res.statusText, res.status, errs, res.json ?? res.rawText);
    }
    const results = ((res.json as { compositeResponse?: { referenceId: string; httpStatusCode: number; body: unknown }[] })?.compositeResponse) ?? [];
    part.forEach((_, i) => { const r = results.find(x => x.referenceId === `r${i}`); out.push({ status: r?.httpStatusCode ?? 500, body: r?.body ?? null }); });
  }
  return out;
}
const firstError = (body: unknown) => (Array.isArray(body) ? (body as { message?: string; errorCode?: string }[])[0] ?? null : null);

/* ── Policies ── */

export async function listPolicies(client: SalesforceClient, kind: PolicyKind): Promise<{ field: string; policies: BulkPolicyOption[] }> {
  const ctx = await contextFor(client, kind);
  if (!ctx.field) throw new RelationshipMissingError(kind);
  if (kind === "tax") {
    const rows = await readPolicies(client, ctx.meta!);
    return { field: ctx.field.name, policies: rows.map(p => ({ id: p.id, name: p.name, status: p.status, productCount: p.products })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  const rows = await queryAt(client, ctx.version, "SELECT Id, Name, Status FROM BillingPolicy ORDER BY Name LIMIT 2000");
  const counts = await queryAt(client, ctx.version, `SELECT ${ctx.field.name} p, COUNT(Id) c FROM Product2 WHERE ${ctx.field.name} != null GROUP BY ${ctx.field.name}`).catch(() => null);
  const byId = new Map((counts ?? []).map(c => [id15(String(c.p))!, Number(c.c) || 0]));
  return { field: ctx.field.name, policies: rows.map(r => ({ id: String(r.Id), name: String(r.Name), status: statusText(r.Status), productCount: counts ? byId.get(id15(String(r.Id))!) ?? 0 : null })) };
}

/* ── Tax Treatment Item metadata ── */

function taxItemFields(meta: TaxMetadata) {
  const item = objectMeta(meta, "TaxTreatmentItem");
  const tr = item ? referenceField(item, "TaxTreatment") : null;
  const pr = item ? referenceField(item, "Product2") : null;
  const f = (n: string | null) => (n && item ? item.fields[n] : undefined);
  return {
    item, tr, pr,
    // TaxCode is only written when the policy resolves one; creating the item itself needs the two references.
    canCreate: !!item?.createable && !!tr && !!pr && !!f(tr)?.createable && !!f(pr)?.createable,
    codeCreateable: !!f("TaxCode")?.createable,
    codeUpdateable: !!f("TaxCode")?.updateable,
    productCodeCreateable: !!f("ProductCode")?.createable,
    nameCreateable: !!f("Name")?.createable,
  };
}

/**
 * The Tax Engine's Tax Code field — ONLY a field literally named TaxCode on this org's TaxEngine Describe (no other field is
 * treated as one). Verified 2026-11-05: p10 (API 68) TaxEngine has no TaxCode field, so this is null there and the fallback
 * resolves to empty.
 */
export function engineTaxCodeField(meta: TaxMetadata): string | null {
  const f = objectMeta(meta, "TaxEngine")?.fields.TaxCode;
  return f && f.type !== "reference" ? "TaxCode" : null;
}

/** Default treatment → Tax Code resolution (Tax Treatment → Tax Engine → empty) for the selected policy. */
async function taxItemSummary(client: SalesforceClient, meta: TaxMetadata, defaultTreatmentId: string | null): Promise<TreatmentItemSummary> {
  const f = taxItemFields(meta);
  const engineField = engineTaxCodeField(meta);
  if (!defaultTreatmentId) return taxSummary(null, f.canCreate, { name: null, taxCode: null, taxCodeField: engineField });
  const cols = selectable(meta, "TaxTreatment", ["Id", "Name", "Status", "TaxCode", "ShouldUseTaxTreatmentItems", "TaxEngineId"]);
  const [t] = await queryAt(client, meta.apiVersion, `SELECT ${cols.join(", ")} FROM TaxTreatment WHERE Id = '${soqlEscape(defaultTreatmentId)}' LIMIT 1`);
  if (!t) return taxSummary(null, f.canCreate, { name: null, taxCode: null, taxCodeField: engineField });
  let engine: { name: string | null; taxCode: string | null; taxCodeField: string | null } = { name: null, taxCode: null, taxCodeField: engineField };
  const engineId = str(t.TaxEngineId);
  if (engineId && objectMeta(meta, "TaxEngine")) {
    const ecols = selectable(meta, "TaxEngine", ["Id", "TaxEngineName", ...(engineField ? [engineField] : [])]);
    const [e] = await queryAt(client, meta.apiVersion, `SELECT ${ecols.join(", ")} FROM TaxEngine WHERE Id = '${soqlEscape(engineId)}' LIMIT 1`).catch(() => []);
    if (e) engine = { name: str(e.TaxEngineName), taxCode: engineField ? str(e[engineField]) : null, taxCodeField: engineField };
  }
  const usesItems = t.ShouldUseTaxTreatmentItems === true && !!f.item;
  return taxSummary({ id: String(t.Id), name: String(t.Name), status: statusText(t.Status), taxCode: str(t.TaxCode), usesItems }, f.canCreate, engine);
}

function taxItemApi(client: SalesforceClient, meta: TaxMetadata): TaxItemApi {
  const f = taxItemFields(meta);
  const v = meta.apiVersion;
  const itemCols = () => selectable(meta, "TaxTreatmentItem", ["Id", "Name", f.tr!, f.pr!, "TaxCode", "ProductCode"]).join(", ");
  const policyRef = referenceField(objectMeta(meta, "TaxTreatment") ?? undefined, "TaxPolicy");
  return {
    async items(treatmentIds, productIds) {
      if (!f.item || !f.tr || !f.pr || !treatmentIds.length || !productIds.length) return [];
      const out = [];
      for (const part of chunks(productIds, 200)) {
        const rows = await queryAt(client, v, `SELECT ${itemCols()} FROM TaxTreatmentItem WHERE ${f.tr} IN (${idList(treatmentIds)}) AND ${f.pr} IN (${idList(part)})`);
        out.push(...rows.map(r => ({ id: String(r.Id), name: String(r.Name ?? r.Id), treatmentId: String(r[f.tr!]), productId: String(r[f.pr!]), taxCode: str(r.TaxCode), productCode: str(r.ProductCode) })));
      }
      return out;
    },
    async policyTreatmentIds(policyId) {
      if (!policyRef) return [];
      return (await queryAt(client, v, `SELECT Id, Name FROM TaxTreatment WHERE ${policyRef} = '${soqlEscape(policyId)}'`)).map(r => ({ id: String(r.Id), name: String(r.Name) }));
    },
    async createItems(rows) {
      const res = await compositeIndependent(client, v, rows.map(r => ({
        method: "POST" as const, url: "/sobjects/TaxTreatmentItem",
        body: {
          ...(f.nameCreateable ? { Name: r.name } : {}), [f.tr!]: r.treatmentId, [f.pr!]: r.productId,
          // The resolved policy Tax Code, unmodified — omitted (left empty) when none is configured.
          ...(r.taxCode && f.codeCreateable ? { TaxCode: r.taxCode } : {}),
          ...(f.productCodeCreateable && r.productCode ? { ProductCode: r.productCode } : {}),
        },
      })));
      return rows.map((r, i) => {
        const x = res[i];
        const e = firstError(x?.body);
        return { productId: r.productId, id: x && x.status < 300 ? str((x.body as { id?: string } | null)?.id) : null, errorCode: e?.errorCode ?? null, message: e?.message ?? null };
      });
    },
    async updateItemTaxCode(itemId, taxCode) {
      if (!f.codeUpdateable) return { ok: false, errorCode: "FIELD_NOT_UPDATEABLE", message: "Your user can't update TaxTreatmentItem.TaxCode." };
      const [x] = await compositeIndependent(client, v, [{ method: "PATCH", url: `/sobjects/TaxTreatmentItem/${itemId}`, body: { TaxCode: taxCode } }]);
      const e = firstError(x?.body);
      return { ok: !!x && x.status < 300, errorCode: e?.errorCode ?? null, message: e?.message ?? null };
    },
  };
}

/* ── Policy check (+ Treatment Item summary) ── */

async function loadPolicyCheck(client: SalesforceClient, ctx: KindContext, policyId: string): Promise<PolicyCheckResult | null> {
  if (ctx.kind === "billing") {
    const chain = await loadPolicyChain(client, policyId, null).catch(() => null);
    if (!chain) return null;
    const items = evaluatePolicyChain(chain, "assign");
    const itemDescribe = await billingDescribe(client, "BillingTreatmentItem").catch(() => null);
    const productRefs = (itemDescribe?.fields ?? []).filter(f => f.type === "reference" && f.referenceTo?.includes("Product2")).map(f => f.name);
    const t = chain.defaultTreatment;
    return {
      id: chain.id, name: chain.name, status: chain.status,
      blockers: items.filter(i => i.status === "failed").map(i => i.detail ?? i.label),
      warnings: items.filter(i => i.status === "warning").map(i => i.detail ?? i.label),
      treatmentItems: billingSummary(t ? { id: t.id, name: t.name, status: t.status, milestone: t.milestone } : null, chain.items.map(i => ({ id: i.id, name: i.name, status: i.status })), productRefs),
    };
  }
  const meta = ctx.meta!;
  const [p] = await queryAt(client, ctx.version, `SELECT Id, Name, Status, DefaultTaxTreatmentId FROM TaxPolicy WHERE Id = '${soqlEscape(policyId)}' LIMIT 1`).catch(() => []);
  if (!p) return null;
  const status = statusText(p.Status);
  const name = String(p.Name);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (status === "Inactive") blockers.push(`Tax Policy "${name}" is Inactive — activate it (or choose an Active policy) before assigning it to products.`);
  else if (status !== "Active") warnings.push(`Tax Policy "${name}" is ${status ?? "not Active"} — Salesforce only calculates tax with an Active policy, so these products won't be taxed until it's activated.`);
  if (!p.DefaultTaxTreatmentId) warnings.push(`Tax Policy "${name}" has no Default Tax Treatment yet — invoices for these products get no tax until one is set.`);
  const summary = await taxItemSummary(client, meta, str(p.DefaultTaxTreatmentId)).catch(() => null);
  if (summary?.mode === "tax-per-product" && !summary.canCreateItems) warnings.push("Your user can't create Tax Treatment Items — only products that already have their item can be assigned.");
  return { id: String(p.Id), name, status, blockers, warnings, treatmentItems: summary };
}

/* ── Eligible products ── */

export async function eligibleProducts(client: SalesforceClient, kind: PolicyKind, opts: { q?: string; cursor?: string | null; all?: boolean; policyId?: string | null }): Promise<EligibleProductsResponse> {
  const ctx = await contextFor(client, kind);
  if (!ctx.field) throw new RelationshipMissingError(kind);
  const field = ctx.field.name;
  const cols = productCols(ctx);
  const loaded = opts.policyId ? await loadPolicyCheck(client, ctx, opts.policyId) : null;
  if (opts.policyId && !loaded) throw new PolicyNotFoundError(kind);
  const policy: PolicyCheckResult | null = loaded ? { id: loaded.id, name: loaded.name, status: loaded.status, blockers: loaded.blockers, warnings: loaded.warnings, treatmentItems: loaded.treatmentItems ?? null } : null;

  const countSoql = `SELECT COUNT(Id) c FROM Product2 WHERE ${eligibleWhere(field, { q: opts.q, hasCode: ctx.hasCode }).join(" AND ")}`;
  const countP = queryAt(client, ctx.version, countSoql).then(r => Number(r[0]?.c ?? 0)).catch(() => null);

  if (opts.all) {
    const soql = `SELECT ${cols} FROM Product2 WHERE ${eligibleWhere(field, { q: opts.q, hasCode: ctx.hasCode }).join(" AND ")} ORDER BY Name, Id LIMIT ${MAX_BULK_PRODUCTS + 1}`;
    const [rows, total] = await Promise.all([queryAt(client, ctx.version, soql), countP]);
    return { success: true, kind, field, products: rows.slice(0, MAX_BULK_PRODUCTS).map(toEligible), nextCursor: null, totalEligible: total, truncated: rows.length > MAX_BULK_PRODUCTS, policy };
  }

  const soql = eligibleProductSoql(cols, field, { q: opts.q, after: decodeCursor(opts.cursor), pageSize: ELIGIBLE_PAGE_SIZE, hasCode: ctx.hasCode });
  const [rows, total] = await Promise.all([queryAt(client, ctx.version, soql), countP]);
  const page = rows.slice(0, ELIGIBLE_PAGE_SIZE).map(toEligible);
  const last = page[page.length - 1];
  return { success: true, kind, field, products: page, nextCursor: rows.length > ELIGIBLE_PAGE_SIZE && last ? encodeCursor({ name: last.name, id: last.id }) : null, totalEligible: total, truncated: false, policy };
}

/* ── Assignment backend ── */

/** Salesforce returns "2026-11-05T10:00:00.000+0000"; If-Unmodified-Since wants an HTTP date. */
export function toHttpDate(sfDate: string | null): string | null {
  if (!sfDate) return null;
  const d = new Date(sfDate.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

export async function salesforceBackend(client: SalesforceClient, kind: PolicyKind): Promise<AssignmentBackend> {
  const ctx = await contextFor(client, kind);
  const field = ctx.field?.name ?? null;

  const readProducts = async (ids: string[]): Promise<ProductState[]> => {
    if (!field || !ids.length) return [];
    const out: ProductState[] = [];
    for (const part of chunks(ids, 200)) {
      const rows = await queryAt(client, ctx.version, `SELECT ${productCols(ctx, [field, "LastModifiedDate"])} FROM Product2 WHERE Id IN (${idList(part)})`);
      out.push(...rows.map(r => ({ id: String(r.Id), name: String(r.Name ?? ""), code: str(r.ProductCode), policyId: str(r[field]), lastModified: str(r.LastModifiedDate) })));
    }
    return out;
  };

  const writePolicy = async (policyId: string, writes: ConditionalWrite[]): Promise<WriteResult[]> => {
    if (!field) return [];
    const res = await compositeIndependent(client, ctx.version, writes.map(w => {
      const since = toHttpDate(w.ifUnmodifiedSince);
      return { method: "PATCH" as const, url: `/sobjects/Product2/${w.id}`, body: { [field]: policyId }, ...(since ? { headers: { "If-Unmodified-Since": since } } : {}) };
    }));
    return writes.map((w, i) => { const e = firstError(res[i]?.body); return { id: w.id, status: res[i]?.status ?? 500, errorCode: e?.errorCode ?? null, message: e?.message ?? null }; });
  };

  const policyNames = async (ids: string[]): Promise<Map<string, string>> => {
    if (!ids.length) return new Map();
    const rows = await queryAt(client, ctx.version, `SELECT Id, Name FROM ${ctx.policySobject} WHERE Id IN (${idList(ids)})`).catch(() => []);
    return new Map(rows.map(r => [String(r.Id), String(r.Name)]));
  };

  const loadPolicy = (id: string) => loadPolicyCheck(client, ctx, id);

  const treatmentItems = kind === "billing"
    ? billingTreatmentItemBackend({ items: async treatmentId => (await queryAt(client, ctx.version, `SELECT Id, Name, Status FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(treatmentId)}' ORDER BY ProcessingOrder`)).map(r => ({ id: String(r.Id), name: String(r.Name), status: statusText(r.Status) })) })
    : taxTreatmentItemBackend(taxItemApi(client, ctx.meta!));

  return { kind, field: ctx.field, loadPolicy, policyNames, readProducts, writePolicy, treatmentItems };
}

export class RelationshipMissingError extends Error {
  constructor(readonly kind: PolicyKind) { super(kind === "billing" ? "This org has no Product field that references Billing Policy." : "Product2 has no field referencing TaxPolicy in this org — products can't be assigned a tax policy."); }
}
export class PolicyNotFoundError extends Error {
  constructor(readonly kind: PolicyKind) { super(`The selected ${kind === "billing" ? "Billing" : "Tax"} Policy no longer exists in Salesforce or isn't visible to your user.`); }
}
