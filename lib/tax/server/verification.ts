import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { compositeAt, orgCurrency, queryAt, resolveAccount, SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import {
  activateOrderForBilling, applyOrderBillingSetup, generateOrderInvoices, loadOrderBilling, postOrderInvoice, requestOrderBillingSchedules, setOrderBillingDetails,
  type MutationOutcome, type OrderBillingState,
} from "@/lib/billing/server/orderBilling";
import { BadInputError, NotFoundError } from "@/lib/billing/server/payments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { getTaxConnection, idList, loadSnapshot, num, resolveProductRef, str, type TaxSnapshot } from "@/lib/tax/server/records";
import { calculationReadiness, CLONE_TABLE_STEPS, readStandardTax, TABLE_ADMIN_FIX, type DecisionTableState } from "@/lib/tax/server/engine";
import { resolveTaxRate, toResolverRate, type RateResolution } from "@/lib/tax/server/resolution";
import { categorize, type IssueCategory } from "@/lib/tax/server/admin";
import { resolveCountry } from "@/lib/tax/server/country";
import type { Named, TaxConnection, TaxEngineRow, TaxRateRow, TaxTreatmentRow } from "@/lib/tax/types";
import { isInvoiceProcessing, readInvoice, type TaxInvoice } from "@/lib/tax/server/invoiceTax";
export { readInvoice, type InvoiceTaxLine } from "@/lib/tax/server/invoiceTax";

/**
 * END-TO-END TAX VERIFICATION — proves that Salesforce CALCULATES tax for a configured product, separately from configuration:
 *
 *   Product → Order Product (tax treatment stamped) → billing setup → activation → Billing Schedule → Invoice → Invoice Line
 *   → InvoiceLineTax (Salesforce's Revenue Standard Tax result) → invoice totals → posting.
 *
 * Configuration is never created here (that's the Create flow). Before an order is created, the Salesforce tax engine must be
 * ready (StandardTax decision table current and refreshed) — otherwise the run stops with the exact reason and creates nothing.
 * The app never calculates or writes tax: every number comes from Salesforce, and 15 checks compare Salesforce's records with
 * the configured rate. "SUCCESS" requires all 15.
 */

const RUN_NAME = "Tax verification ";
const LEGACY_RUN_NAME = "Tax workflow ";
const RUN_TAG = /\[tax-run:([A-Za-z0-9-]{8,64})\]/;
const round2 = (n: number) => Math.round(n * 100) / 100;
const named = (id: unknown, rel: unknown, field = "Name"): Named | null => (typeof id === "string" ? { id, name: String((rel as Record<string, unknown> | null)?.[field] ?? id) } : null);
const today = () => new Date().toISOString().slice(0, 10);
const inflight = ((globalThis as { __rcbTaxVerifyRuns?: Map<string, Promise<unknown>> }).__rcbTaxVerifyRuns ??= new Map());
const failures = ((globalThis as { __rcbTaxVerifyFailures?: Map<string, TaxRunState["failure"]> }).__rcbTaxVerifyFailures ??= new Map());

/** What an admin must do about the decision table Salesforce uses (the engine-assigned one, or the system table). */
const adminFix = (dt: DecisionTableState | null) => (!dt?.outdated ? null : dt.source === "engine" ? CLONE_TABLE_STEPS : TABLE_ADMIN_FIX);

export class EngineNotReadyError extends Error { constructor(message: string, readonly code: string, readonly adminAction: string | null) { super(message); } }

interface RunModel { snap: TaxSnapshot; dt: DecisionTableState | null; connection: TaxConnection; currency: string | null }
async function runModel(client: SalesforceClient): Promise<RunModel> {
  const meta = await discoverTaxMetadata(client);
  const snap = await loadSnapshot(client, meta);
  const [dt, connection, cur] = await Promise.all([readStandardTax(client, meta.apiVersion, snap), getTaxConnection(client), orgCurrency(client)]);
  return { snap, dt, connection, currency: cur.symbol ?? cur.code };
}

/** The treatment Salesforce will use for a product's policy (Default → default treatment; Legal Entity → the entity's treatment). */
function expectedTreatment(m: RunModel, policyId: string | null, legalEntityId: string | null): TaxTreatmentRow | null {
  const policy = m.snap.policies.find(p => p.id === policyId);
  if (!policy) return null;
  const active = m.snap.treatments.filter(t => t.policyId === policy.id && t.status === "Active");
  if (policy.selection === "LegalEntity") return active.find(t => t.legalEntityId === legalEntityId) ?? null;
  return m.snap.treatments.find(t => t.id === policy.defaultTreatmentId) ?? null;
}
/** The tax code the treatment applies to a product: its Tax Treatment Item's code, else the treatment's own. */
function codeFor(m: RunModel, t: TaxTreatmentRow | null, productId: string | null): string | null {
  if (!t) return null;
  if (t.useItems) return m.snap.items.find(i => i.treatmentId === t.id && i.productId === productId)?.taxCode ?? t.taxCode;
  return t.taxCode;
}
/** The treatment engine's own decision table (its DecisionTableId, else the system table) — what Salesforce uses for the line. */
async function tableFor(client: SalesforceClient, m: RunModel, engineId: string | null | undefined): Promise<DecisionTableState | null> {
  return engineId ? readStandardTax(client, m.snap.meta.apiVersion, m.snap, engineId) : m.dt;
}
/**
 * The rates Salesforce's invoice-time lookup would match for a line — the shared resolver (same rules as activation and readiness):
 * ProductCode = the product's own code, the table's INPUT columns only, blank rate values = wildcards, two matches = multiple.
 */
function lookupRates(m: RunModel, dt: DecisionTableState | null, q: { taxCode: string | null; productCode: string | null; legalEntityId: string | null; country: string | null; state: string | null; city: string | null; zipCode: string | null; date: string }): { resolution: RateResolution; candidates: TaxRateRow[] } {
  const resolution = resolveTaxRate(m.snap.rates.map(toResolverRate), { taxCode: q.taxCode, countryIso: q.country, stateIso: q.state, city: q.city, zipCode: q.zipCode, productCode: q.productCode, legalEntityId: q.legalEntityId, effectiveDate: q.date, rateUsageType: "RevCloud", applicationBasis: null }, dt?.inputs.length ? dt.inputs.map(i => i.field) : null);
  const candidates = resolution.candidates.map(c => m.snap.rates.find(r => r.id === c.rate.id)).filter((r): r is TaxRateRow => !!r);
  return { resolution, candidates };
}

/* ───────────────────────────── Start ───────────────────────────── */

export interface StartInput { product: { id?: string | null; name?: string | null }; accountName: string | null; quantity: number | null; unitPrice: number | null; key: string;
  /** Explicit Salesforce Account / Contact (the contact must belong to the account) — instead of resolving by name / the first contact. */
  accountId?: string | null; contactId?: string | null }

/** Preflight (engine readiness, product's taxable chain, account billing data), then create the Draft order. Idempotent per key. */
export async function startVerificationRun(client: SalesforceClient, input: StartInput): Promise<{ success: true; orderId: string; orderNumber: string | null; duplicate: boolean }> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.key)) throw new BadInputError("A run key is required.");
  const lockKey = `${client.cacheScope}:${input.key}`;
  if (inflight.has(lockKey)) await inflight.get(lockKey)!.catch(() => null);
  const work = (async () => {
    const [existing] = await queryAt(client, client.apiVersion, `SELECT Id, OrderNumber FROM Order WHERE Name = '${RUN_NAME}${soqlEscape(input.key)}' LIMIT 1`);
    if (existing) return { success: true as const, orderId: existing.Id as string, orderNumber: str(existing.OrderNumber), duplicate: true };
    const m = await runModel(client);
    // 1. The product's configured chain (the engine readiness check follows, for the treatment's OWN engine).
    const meta = m.snap.meta;
    const pr = await resolveProductRef(client, meta, input.product);
    if (pr.status !== "found") throw new BadInputError(pr.message);
    const product = pr.product;
    const quantity = input.quantity && input.quantity > 0 ? input.quantity : 1;
    let acc: { status: "found"; record: { id: string; name: string } } | { status: string; message: string };
    if (input.accountId) {
      if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(input.accountId)) throw new BadInputError("accountId isn't a valid Salesforce Id.");
      const [row] = await queryAt(client, meta.apiVersion, `SELECT Id, Name FROM Account WHERE Id = '${soqlEscape(input.accountId)}'`);
      acc = row ? { status: "found", record: { id: row.Id as string, name: String(row.Name) } } : { status: "not-found", message: `Account ${input.accountId} doesn't exist.` };
    } else {
      if (!input.accountName?.trim()) throw new BadInputError("Which customer account should the verification order be for?");
      acc = await resolveAccount(client, input.accountName);
    }
    if (acc.status !== "found" || !("record" in acc)) throw new BadInputError("message" in acc ? acc.message : "Account not found.");
    const [a] = await queryAt(client, meta.apiVersion, `SELECT BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry, ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode, ShippingCountry FROM Account WHERE Id = '${soqlEscape(acc.record.id)}'`);
    const [contact] = input.contactId
      ? await queryAt(client, meta.apiVersion, `SELECT Id FROM Contact WHERE Id = '${soqlEscape(input.contactId)}' AND AccountId = '${soqlEscape(acc.record.id)}'`)
      : await queryAt(client, meta.apiVersion, `SELECT Id FROM Contact WHERE AccountId = '${soqlEscape(acc.record.id)}' ORDER BY CreatedDate LIMIT 1`);
    if (input.contactId && !contact) throw new BadInputError(`Contact ${input.contactId} doesn't belong to account "${acc.record.name}".`);
    if (!a?.BillingStreet || !a?.BillingCity || !a?.BillingCountry) throw new BadInputError(`Account "${acc.record.name}" has no complete billing address; Salesforce's billing schedules require one.`);
    if (!contact) throw new BadInputError(`Account "${acc.record.name}" has no Contact; Salesforce's billing schedules require a Bill To Contact.`);
    const country = resolveCountry(String(a.BillingCountry), m.snap.geoCountries);
    if (!country) throw new BadInputError(`Account "${acc.record.name}" billing country "${a.BillingCountry}" can't be mapped to an ISO country code.`);
    const les = m.snap.legalEntities.filter(l => !l.status || l.status === "Active");
    const treatment0 = expectedTreatment(m, product.taxPolicyId, les.length === 1 ? les[0].id : null);
    if (!treatment0 || treatment0.status !== "Active" || !treatment0.taxable) throw new BadInputError(`"${product.name}" has no active taxable tax treatment through its tax policy — configure it in Tax → Create first.`);
    // p10: taxable treatments without a Legal Entity never produced InvoiceLineTax (DOC-000000011/12/15/16).
    if (!treatment0.legalEntityId) throw new BadInputError(`Tax Treatment "${treatment0.name}" has no Legal Entity — in this org such treatments produced no InvoiceLineTax. Create a Draft treatment with the legal entity, activate it and make it the policy's default, then run the verification.`);
    const legalEntityId = treatment0.legalEntityId ?? (les.length === 1 ? les[0].id : null);
    const code = codeFor(m, treatment0, product.id);
    // 2. Salesforce must be able to calculate tax with the decision table of THIS treatment's engine — otherwise no order is created
    //    (an Error invoice can't be recalculated). A stale table (rates changed after its last successful refresh) blocks too.
    const dt = await tableFor(client, m, treatment0.engineId);
    const calc = calculationReadiness(dt, m.snap.engines.filter(e => e.native && e.status === "Active").length);
    if (!calc.ready) throw new EngineNotReadyError(`End-to-end verification not started — Salesforce can't calculate tax yet: ${calc.reason}`, calc.code ?? "TAX_ENGINE_NOT_READY", adminFix(dt));
    // The tax decision table compares State exactly ("Andhra Pradesh" ≠ "AP"): send the GeoState code, like the country's ISO code.
    const geoStates = await queryAt(client, meta.apiVersion, `SELECT Name, IsoCode FROM GeoState WHERE GeoCountry.IsoCode = '${soqlEscape(country.iso)}'`).catch(() => []);
    const stateCode = (v: unknown) => { const t = typeof v === "string" ? v.trim() : ""; const g = t ? geoStates.find(x => [x.Name, x.IsoCode].some(n => typeof n === "string" && n.toLowerCase() === t.toLowerCase())) : null; return g?.IsoCode ? String(g.IsoCode) : t || null; };
    // 3. Exactly one rate must match — the same lookup the activation check runs (ProductCode = the product's own code).
    const { resolution, candidates } = lookupRates(m, dt, { taxCode: code, productCode: product.code, legalEntityId, country: country.iso, state: stateCode(a.BillingState), city: str(a.BillingCity), zipCode: str(a.BillingPostalCode), date: today() });
    if (resolution.outcome !== "single") throw new BadInputError(resolution.outcome === "multiple"
      ? `${candidates.length} tax rates match "${product.name}" (product code ${product.code ?? "—"}) in ${country.iso}${stateCode(a.BillingState) ? `/${stateCode(a.BillingState)}` : ""} (${candidates.map(r => `${r.name} ${r.taxCode} ${r.rate}%${r.productCode ? "" : " · blank product code"}`).join(", ")}) — Salesforce's lookup returns Multiple Matches; make them distinct first.`
      : `No effective Revenue Cloud tax rate matches "${product.name}" (tax code ${code ?? "(none)"}, product code ${product.code ?? "—"}) in ${country.iso}${stateCode(a.BillingState) ? `/${stateCode(a.BillingState)}` : ""} — configure it in Tax → Create first.${resolution.nearMisses.length ? ` Closest: ${resolution.nearMisses.slice(0, 3).map(n => `${n.rate.name} (${n.reason})`).join("; ")}.` : ""}`);
    // Salesforce derives OrderItem.ProductSellingModelId from the PricebookEntry: prefer the entry linked to a selling model.
    const entries = await queryAt(client, meta.apiVersion, `SELECT Id, UnitPrice, Pricebook2Id, ProductSellingModelId FROM PricebookEntry WHERE Product2Id = '${soqlEscape(product.id)}' AND Pricebook2.IsStandard = true AND IsActive = true ORDER BY CreatedDate`)
      .catch(() => queryAt(client, meta.apiVersion, `SELECT Id, UnitPrice, Pricebook2Id FROM PricebookEntry WHERE Product2Id = '${soqlEscape(product.id)}' AND Pricebook2.IsStandard = true AND IsActive = true ORDER BY CreatedDate`));
    // A product with Product Selling Model options must be ordered through an entry that carries one (OrderItem.ProductSellingModelId
    // is derived from it and can't be set later) — never fall back to an entry without a selling model.
    const options = await queryAt(client, meta.apiVersion, `SELECT ProductSellingModelId, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(product.id)}'`).catch(() => null);
    const withModel = entries.filter(e => e.ProductSellingModelId && (!options || options.some(o => String(o.ProductSellingModelId).slice(0, 15) === String(e.ProductSellingModelId).slice(0, 15))));
    if (withModel.length > 1) throw new BadInputError(`"${product.name}" has ${withModel.length} Standard Price Book entries with selling models (${withModel.map(e => e.Id).join(", ")}) — the verification run can't choose; keep one active entry per selling model.`);
    const entry = withModel[0] ?? (options && options.length ? null : entries[0]);
    if (!entry) throw new BadInputError(entries.length
      ? `MISSING_SELLING_MODEL: "${product.name}" has selling model option(s) ${(options ?? []).map(o => String((o.ProductSellingModel as Record<string, unknown> | null)?.Name ?? o.ProductSellingModelId)).join(", ")}, but its Standard Price Book entr${entries.length > 1 ? "ies" : "y"} ${entries.map(e => e.Id).join(", ")} carr${entries.length > 1 ? "y" : "ies"} no Product Selling Model. PricebookEntry.ProductSellingModelId can only be set at creation — create an entry with the selling model (admin), then run again.`
      : `"${product.name}" has no active Standard Price Book entry.`);
    const unitPrice = input.unitPrice ?? Number(entry.UnitPrice);
    const shipCountry = a.ShippingStreet && a.ShippingCity && a.ShippingCountry ? resolveCountry(String(a.ShippingCountry), m.snap.geoCountries) : null;
    const ship = shipCountry?.iso === country.iso ? "Shipping" : "Billing";
    const res = await compositeAt(client, meta.apiVersion, [
      {
        method: "POST", url: "/sobjects/Order", referenceId: "order", body: {
          Name: `${RUN_NAME}${input.key}`, AccountId: acc.record.id, Pricebook2Id: entry.Pricebook2Id, EffectiveDate: today(), Status: "Draft", BillToContactId: contact.Id, LegalEntityId: legalEntityId,
          Description: `Tax verification: ${product.name} × ${quantity} @ ${unitPrice} (${code} ${candidates[0].rate}%) [tax-run:${input.key}]`,
          BillingStreet: a.BillingStreet, BillingCity: a.BillingCity, BillingState: stateCode(a.BillingState), BillingPostalCode: a.BillingPostalCode, BillingCountry: country.iso,
          ShippingStreet: a[`${ship}Street`], ShippingCity: a[`${ship}City`], ShippingState: stateCode(a[`${ship}State`]), ShippingPostalCode: a[`${ship}PostalCode`], ShippingCountry: country.iso,
        },
      },
      { method: "POST", url: "/sobjects/OrderItem", referenceId: "item0", body: { OrderId: "@{order.id}", Product2Id: product.id, PricebookEntryId: entry.Id, Quantity: quantity, UnitPrice: unitPrice, ServiceDate: today(), TaxTreatmentId: treatment0.id } },
    ]);
    if (!res.ok) throw new SalesforceCallError(`Order: ${res.errors.map(e => e.message).join("; ")}`, 422, res.errors, res.results);
    const orderId = (res.results[0].body as { id: string }).id;
    const [o] = await queryAt(client, meta.apiVersion, `SELECT OrderNumber FROM Order WHERE Id = '${soqlEscape(orderId)}'`);
    return { success: true as const, orderId, orderNumber: str(o?.OrderNumber), duplicate: false };
  })();
  inflight.set(lockKey, work);
  try { return await work; } finally { inflight.delete(lockKey); }
}

/* ───────────────────────────── Run state ───────────────────────────── */

export type RunStepState = "done" | "current" | "pending" | "failed" | "processing";
export interface RunStep { id: string; label: string; state: RunStepState; detail: string }
export interface VerificationCheck { id: string; label: string; passed: boolean | null; detail: string }
export type RunAction = "assign-treatment" | "setup" | "activate" | "schedules" | "generate-invoice" | "calculate-tax" | "post-invoice" | "wait";
/**
 * Billable / irreversible Salesforce steps: each needs its own confirmation (activation makes the order billable, schedules and
 * invoices create billing documents, posting finalises the invoice). Preparing the run's own Draft order and recalculating a
 * Draft invoice's estimated tax don't.
 */
export const BILLABLE_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(["activate", "schedules", "generate-invoice", "post-invoice"]);
export function confirmationFor(action: RunAction | null | undefined, ctx: { orderNumber: string | null; invoiceNumber: string | null }): { action: RunAction; detail: string } | null {
  if (!action || !BILLABLE_ACTIONS.has(action)) return null;
  const o = ctx.orderNumber ?? "the order";
  const detail = { activate: `Activate order ${o} in Salesforce. The order becomes billable.`, schedules: `Ask Salesforce to create the billing schedules for order ${o}.`, "generate-invoice": `Salesforce generates an invoice for order ${o} from its billing schedules and calculates its tax.`, "post-invoice": `Post invoice ${ctx.invoiceNumber ?? ""} in Salesforce. Posting is final — the invoice can't be returned to Draft.` }[action as "activate" | "schedules" | "generate-invoice" | "post-invoice"];
  return { action, detail };
}
export interface TaxRunState {
  success: true; orderId: string; connection: TaxConnection;
  order: { id: string; number: string | null; status: string | null; account: Named | null; total: number | null; activated: boolean; legalEntity: Named | null;
    /** Order billing address as Salesforce holds it (the transaction jurisdiction the tax lookup uses). */
    billingAddress?: { city: string | null; state: string | null; postalCode: string | null; country: string | null } | null };
  items: { id: string; product: (Named & { code: string | null }) | null; quantity: number | null; unitPrice: number | null; total: number | null; taxPolicy: Named | null; treatment: Named | null; expectedTreatment: (TaxTreatmentRow & { engine: TaxEngineRow | null }) | null; expectedCode: string | null; expectedRate: TaxRateRow | null; rateCandidates: TaxRateRow[] }[];
  schedules: { id: string; number: string; status: string | null; amount: number | null; invoiced: boolean; treatment: Named | null; product: string | null }[];
  invoice: TaxInvoice | null;
  readiness: { ready: boolean; reason: string | null };
  steps: RunStep[]; next: { action: RunAction; label: string } | null;
  /** Set when the next step is billable: it runs only with an explicit confirmation of exactly this action. */
  confirmation: { action: RunAction; detail: string } | null;
  failure: { step: string; reason: string; code: string | null; adminAction?: string | null; category?: IssueCategory; retryLabel?: string | null; retryable?: boolean; technical?: unknown } | null;
  checks: VerificationCheck[]; complete: boolean;
  taxCalculation: "SUCCESS" | "FAILED" | "PENDING"; endToEnd: "SUCCESS" | "FAILED" | "IN PROGRESS";
  currency: string | null; message: string;
}

const RETRY_LABEL: Record<string, string> = {
  config: "Retry Tax Treatment", setup: "Retry Billing Setup", activate: "Retry Activation", schedules: "Retry Billing Schedules",
  readiness: "Retry Tax Engine Validation", invoice: "Retry Invoice Generation", tax: "Retry Tax Calculation", post: "Retry Posting",
};


async function latestTaxError(client: SalesforceClient, v: string, refs: string[]) {
  if (!refs.length) return null;
  // A failed read is returned as { unavailable } (the caller reports it) — never as "no error log".
  try {
    const [log] = await queryAt(client, v, `SELECT ErrorLogNumber, ErrorCode, ErrorMessage, Category, CreatedDate FROM RevenueTransactionErrorLog WHERE PrimaryRecordId IN (${idList(refs)}) OR RelatedRecordId IN (${idList(refs)}) ORDER BY CreatedDate DESC LIMIT 1`);
    return log ?? null;
  } catch (e) { return { unavailable: `RevenueTransactionErrorLog couldn't be read: ${e instanceof Error ? e.message : String(e)}` } as Record<string, unknown>; }
}

export async function getTaxRun(client: SalesforceClient, orderId: string): Promise<TaxRunState> {
  const billing = await loadOrderBilling(client, orderId).catch(e => { if (/not found|invalid order/i.test(String(e?.message))) throw new NotFoundError("Order not found in the connected Salesforce org."); throw e; });
  const m0 = await runModel(client);
  const v = m0.snap.meta.apiVersion;
  const [ord] = await queryAt(client, v, `SELECT LegalEntityId, LegalEntity.Name, BillingCountry, BillingState, BillingCity, BillingPostalCode FROM Order WHERE Id = '${soqlEscape(orderId)}'`).catch(() => []);
  const legalEntity = named(ord?.LegalEntityId, ord?.LegalEntity);
  const country = str(ord?.BillingCountry)?.toUpperCase() ?? null;
  const rows = await queryAt(client, v, `SELECT Id, Product2Id, Product2.Name, Product2.ProductCode, Product2.TaxPolicyId, Quantity, UnitPrice, TotalPrice, TaxTreatmentId, TaxTreatment.Name FROM OrderItem WHERE OrderId = '${soqlEscape(orderId)}' ORDER BY CreatedDate, Id`);
  // The decision table of the (first taxable) line's own treatment engine — never "the first engine in the org".
  const engineId = rows.map(r => expectedTreatment(m0, m0.snap.policies.find(x => x.id === (r.Product2 as Record<string, unknown> | null)?.TaxPolicyId)?.id ?? null, legalEntity?.id ?? null)).find(t => t?.taxable)?.engineId ?? null;
  const m: RunModel = { ...m0, dt: await tableFor(client, m0, engineId) };
  const items: TaxRunState["items"] = rows.map(r => {
    const p = r.Product2 as Record<string, unknown> | null;
    const policy = m.snap.policies.find(x => x.id === p?.TaxPolicyId) ?? null;
    const t = expectedTreatment(m, policy?.id ?? null, legalEntity?.id ?? null);
    const code = codeFor(m, t, str(r.Product2Id));
    const candidates = t?.taxable ? lookupRates(m, m.dt, { taxCode: code, productCode: str(p?.ProductCode), legalEntityId: legalEntity?.id ?? t.legalEntityId, country, state: str(ord?.BillingState)?.toUpperCase() ?? null, city: str(ord?.BillingCity), zipCode: str(ord?.BillingPostalCode), date: today() }).candidates : [];
    return {
      id: r.Id as string, product: typeof r.Product2Id === "string" ? { id: r.Product2Id, name: String(p?.Name ?? r.Product2Id), code: str(p?.ProductCode) } : null,
      quantity: num(r.Quantity), unitPrice: num(r.UnitPrice), total: num(r.TotalPrice), taxPolicy: policy ? { id: policy.id, name: policy.name } : null, treatment: named(r.TaxTreatmentId, r.TaxTreatment),
      expectedTreatment: t ? { ...t, engine: m.snap.engines.find(e => e.id === t.engineId) ?? null } : null, expectedCode: code, expectedRate: candidates.length === 1 ? candidates[0] : null, rateCandidates: candidates,
    };
  });
  const schedTreatments = billing.schedules.length ? await queryAt(client, v, `SELECT Id, TaxTreatmentId, TaxTreatment.Name FROM BillingSchedule WHERE Id IN (${idList(billing.schedules.map(s => s.id))})`).catch(() => []) : [];
  const latest = [...billing.invoices].sort((a, b) => String(b.invoiceDate ?? "").localeCompare(String(a.invoiceDate ?? "")))[0] ?? null;
  const invoice = latest ? await readInvoice(client, v, latest.id) : null;
  const calc = calculationReadiness(m.dt, m.snap.engines.filter(e => e.native && e.status === "Active").length);
  let failure = failures.get(`${client.cacheScope}:${orderId}`) ?? null;
  // Salesforce records invoicing/tax failures in RevenueTransactionErrorLog (e.g. TAX_INTERNAL_ERROR "Decision Table lookup failed")
  // and marks the invoice/schedule "Error" — that exact message is reported.
  const errored = /error/i.test(invoice?.status ?? "") || billing.schedules.some(s => /error/i.test(s.status ?? ""));
  if (!failure && errored) {
    const log = await latestTaxError(client, v, [orderId, invoice?.id, ...billing.schedules.map(s => s.id)].filter((x): x is string => !!x));
    failure = {
      step: invoice ? "tax" : "invoice", code: str(log?.ErrorCode) ?? "SALESFORCE_ERROR",
      reason: log?.unavailable ? `Salesforce set ${invoice ? `invoice ${invoice.number}` : "the billing schedule"} to Error; the reason is unavailable — ${String(log.unavailable)}.` : log ? `Salesforce ${str(log.Category) ?? "error"} ${str(log.ErrorLogNumber) ?? ""}: ${str(log.ErrorMessage) ?? ""}`.replace(/\s+/g, " ").trim() : `Salesforce set ${invoice ? `invoice ${invoice.number}` : "the billing schedule"} to Error without an error log.`,
      category: categorize(str(log?.ErrorCode), str(log?.ErrorMessage)),
      adminAction: /decision table/i.test(str(log?.ErrorMessage) ?? "") ? (m.dt?.source === "engine" ? CLONE_TABLE_STEPS : TABLE_ADMIN_FIX) : null,
      // Salesforce only recalculates Draft invoices — an Error invoice can't be retried in place.
      retryable: !/error/i.test(invoice?.status ?? ""), technical: log ?? null,
    };
  }
  if (!failure && invoice?.taxRecordsError) failure = { step: "tax", code: "TAX_RECORDS_UNREADABLE", category: categorize("TAX_RECORDS_UNREADABLE", invoice.taxRecordsError), reason: `The InvoiceLineTax records of ${invoice.number ?? invoice.id} couldn't be read from Salesforce (${invoice.taxRecordsError}) — nothing is concluded about the tax.`, retryable: true };
  if (failure) failure = { ...failure, retryLabel: failure.retryable === false ? null : RETRY_LABEL[failure.step] ?? "Retry" };
  const schedules = billing.schedules.map(s => { const t = schedTreatments.find(x => x.Id === s.id); return { id: s.id, number: s.number, status: s.status, amount: s.amount, invoiced: s.invoiced, product: s.product, treatment: named(t?.TaxTreatmentId, t?.TaxTreatment) }; });
  return derive(billing, items, schedules, invoice, m, { ready: calc.ready, reason: calc.reason }, failure, legalEntity);
}

function derive(b: OrderBillingState, items: TaxRunState["items"], schedules: TaxRunState["schedules"], invoice: TaxRunState["invoice"], m: RunModel, readiness: TaxRunState["readiness"], failure: TaxRunState["failure"], legalEntity: Named | null): TaxRunState {
  const C = m.currency ?? "";
  const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${C}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const near = (a: number | null | undefined, e: number | null | undefined) => a !== null && a !== undefined && e !== null && e !== undefined && Math.abs(a - e) < 0.011;
  const chainOk = items.length > 0 && items.every(i => i.expectedTreatment && i.expectedTreatment.status === "Active");
  const ambiguous = items.filter(i => i.rateCandidates.length > 1);
  // Salesforce copies OrderItem.TaxTreatmentId to the billing schedule and invoice line; blank falls back to the legal entity's treatment.
  const unstamped = items.filter(i => i.expectedTreatment && i.treatment?.id !== i.expectedTreatment.id);
  const configured = chainOk && unstamped.length === 0;
  const setupDone = b.order.activated || b.items.every(i => i.pendingActions.length === 0);
  const scheduled = schedules.length > 0;
  const schedulesProcessing = !scheduled && b.jobs.some(j => /queued|processing|inprogress|in progress/i.test(j.status ?? ""));
  const expectedIds = new Set(items.map(i => i.expectedTreatment?.id).filter(Boolean));
  const replacedSchedules = schedules.filter(s => !s.treatment || !expectedIds.has(s.treatment.id));
  const invoiced = !!invoice;
  const draft = /^draft$/i.test(invoice?.status ?? "");
  const posted = /posted/i.test(invoice?.status ?? "");
  const taxLines = invoice?.lines.filter(l => l.taxes.length) ?? [];
  const taxCalculated = invoiceTaxSettled(invoice);

  const checks: VerificationCheck[] = [];
  const add = (id: string, label: string, passed: boolean | null, detail: string) => checks.push({ id, label, passed, detail });
  const engines = [...new Map(items.map(i => i.expectedTreatment?.engine).filter((e): e is TaxEngineRow => !!e).map(e => [e.id, e])).values()];
  const policies = items.map(i => (i.taxPolicy ? m.snap.policies.find(p => p.id === i.taxPolicy!.id) ?? null : null));
  add("engine-exists", "Tax Engine exists", engines.length > 0, engines.map(e => `${e.name} (${e.type})`).join(", ") || "none");
  add("engine-active", "Tax Engine is active (Revenue Standard Tax)", engines.length > 0 && engines.every(e => e.status === "Active" && e.native), engines.map(e => `${e.name}: ${e.status ?? "—"}`).join(", ") || "none");
  add("policy-exists", "Tax Policy exists", items.length > 0 && policies.every(p => !!p), items.map((i, n) => `${i.product?.name}: ${policies[n]?.name ?? "none"}`).join(" · "));
  add("policy-active", "Tax Policy is active", items.length > 0 && policies.every(p => p?.status === "Active"), policies.map(p => `${p?.name ?? "?"}: ${p?.status ?? "—"}`).join(" · "));
  add("treatment-exists", "Tax Treatment exists", items.length > 0 && items.every(i => !!i.expectedTreatment), items.map(i => i.expectedTreatment?.name ?? "none").join(" · "));
  add("treatment-active", "Tax Treatment is active and taxable", items.length > 0 && items.every(i => i.expectedTreatment?.status === "Active" && i.expectedTreatment.taxable), items.map(i => `${i.expectedTreatment?.name ?? "?"}: ${i.expectedTreatment?.status ?? "—"}${i.expectedTreatment?.taxable ? ", taxable" : ", not taxable"}`).join(" · "));
  add("rate-exists", "Tax Rate exists", items.length > 0 && items.every(i => i.rateCandidates.length > 0), items.map(i => i.rateCandidates.map(r => `${r.taxCode} ${r.rate}%`).join(" + ") || `none for ${i.expectedCode ?? "no code"}`).join(" · "));
  add("rate-valid", "Tax Rate is valid (effective, single match, country, legal entity)", items.length > 0 && items.every(i => !!i.expectedRate && (i.expectedRate.rate ?? -1) >= 0 && !!i.expectedRate.country && !!i.expectedRate.legalEntityId),
    items.map(i => (i.expectedRate ? `${i.expectedRate.taxCode} ${i.expectedRate.rate}% · ${i.expectedRate.country ?? "no country"}` : i.rateCandidates.length > 1 ? `${i.rateCandidates.length} rates match` : "no rate")).join(" · "));
  add("product-treatment", "Product has the correct tax treatment", items.length > 0 && items.every(i => !!i.taxPolicy && !!i.expectedTreatment?.taxable), items.map(i => `${i.product?.name}: ${i.taxPolicy?.name ?? "no policy"} → ${i.expectedTreatment?.name ?? "none"}${i.expectedCode ? ` (${i.expectedCode})` : ""}`).join(" · "));
  add("order-product-treatment", "Order Product has the correct tax treatment", configured, items.map(i => `${i.product?.name}: ${i.treatment?.name ?? "none"}${i.expectedTreatment && i.treatment?.id !== i.expectedTreatment.id ? ` (expected ${i.expectedTreatment.name})` : ""}`).join(" · "));
  add("schedule", "Billing Schedule exists with the tax treatment", scheduled && replacedSchedules.length === 0, schedules.map(s => `${s.number} · ${s.status} · ${s.treatment?.name ?? "no treatment"}`).join(", ") || "none");
  const lineMatches = invoice?.lines.map(l => { const i = items.find(x => x.product?.id === l.productId); return { l, ok: !!i && near(l.quantity, i.quantity) && near(l.unitPrice, i.unitPrice) && near(l.charge, (i.quantity ?? 0) * (i.unitPrice ?? 0)) }; }) ?? [];
  add("invoice", "Invoice exists with the order's lines", !!invoice && lineMatches.length === items.length && lineMatches.every(x => x.ok) && near(invoice.subtotal, lineMatches.reduce((s, x) => s + (x.l.charge ?? 0), 0)),
    invoice ? `${invoice.number} · ${invoice.status} · ${lineMatches.map(x => `${x.l.product ?? x.l.name} × ${x.l.quantity} @ ${money(x.l.unitPrice)} = ${money(x.l.charge)}`).join(" · ")} · subtotal ${money(invoice.subtotal)}` : "none");
  const lineTax = invoice?.lines.map(l => {
    const i = items.find(x => x.product?.id === l.productId);
    const rate = i?.expectedRate?.rate ?? null;
    const recorded = round2(l.taxes.reduce((s, t) => s + (t.amount ?? 0), 0));
    const expected = rate !== null && l.charge !== null ? round2(l.charge * rate / 100) : null;
    return { l, recorded, expected, ratesOk: l.taxes.length > 0 && rate !== null && l.taxes.every(t => near(t.rate, rate)) };
  }) ?? [];
  add("line-tax-records", "InvoiceLineTax exists for every line at the configured rate", !!invoice && lineTax.length > 0 && lineTax.every(x => x.ratesOk),
    invoice ? lineTax.map(x => `${x.l.product ?? x.l.name}: ${x.l.taxes.length ? x.l.taxes.map(t => `${t.name ?? t.code ?? "tax"} ${t.rate ?? "?"}% ${money(t.amount)} (${t.status})`).join("; ") : "none"}`).join(" · ") : "no invoice");
  const taxSum = round2(lineTax.reduce((s, x) => s + x.recorded, 0));
  const expectedTax = lineTax.every(x => x.expected !== null) ? round2(lineTax.reduce((s, x) => s + (x.expected ?? 0), 0)) : null;
  add("totals", "Actual tax and invoice totals match (Salesforce fields)", !!invoice && taxSum > 0 && near(taxSum, expectedTax) && lineTax.every(x => near(x.l.taxAmount, x.recorded)) && near(invoice.tax, taxSum) && near(invoice.totalWithTax, (invoice.subtotal ?? NaN) + (invoice.tax ?? NaN)),
    invoice ? `InvoiceLineTax ${money(taxSum)} (expected ${money(expectedTax)}) · invoice tax ${money(invoice.tax)} · subtotal ${money(invoice.subtotal)} · total with tax ${money(invoice.totalWithTax)}` : "no invoice");
  add("posted", "Invoice is posted", posted, invoice ? `${invoice.status}` : "no invoice");

  const taxOk = !!(checks.find(c => c.id === "line-tax-records")?.passed && checks.find(c => c.id === "totals")?.passed);
  const taxCalculation: TaxRunState["taxCalculation"] = failure && ["tax", "readiness"].includes(failure.step) ? "FAILED" : taxCalculated ? (taxOk ? "SUCCESS" : "FAILED") : "PENDING";
  const taxStop = taxCalculation === "FAILED" && !failure && !posted;
  const scheduleStop = scheduled && replacedSchedules.length > 0 && !invoiced;
  const steps: RunStep[] = [
    { id: "config", label: "Tax configuration", state: configured && !ambiguous.length ? "done" : chainOk && !b.order.activated && !ambiguous.length ? "current" : "failed", detail: ambiguous.length ? `${ambiguous[0].product?.name}: ${ambiguous[0].rateCandidates.length} tax rates match — Salesforce would apply all of them.` : configured ? items.map(i => `${i.product?.name}: ${i.expectedTreatment!.name}${i.expectedRate ? ` · ${i.expectedRate.rate}%` : ""}`).join(" · ") : !chainOk ? "An order product has no active tax treatment through its tax policy." : `${unstamped.map(i => i.product?.name).join(", ")} needs tax treatment "${unstamped[0].expectedTreatment!.name}".` },
    { id: "order", label: "Order created", state: "done", detail: `${b.order.number} · ${items.length} product(s) · ${money(b.order.totalAmount)}${legalEntity ? ` · ${legalEntity.name}` : ""}` },
    { id: "setup", label: "Billing setup", state: setupDone ? "done" : "current", detail: setupDone ? "Order actions and billing treatments set." : "Order actions / billing treatments pending." },
    { id: "activate", label: "Order activated", state: b.order.activated ? "done" : setupDone ? "current" : "pending", detail: b.order.status ?? "" },
    { id: "schedules", label: "Billing schedule", state: scheduleStop ? "failed" : scheduled ? "done" : schedulesProcessing ? "processing" : b.order.activated ? "current" : "pending", detail: scheduled ? schedules.map(s => `${s.number} (${s.status}) · ${s.treatment?.name ?? "no tax treatment"}`).join(", ") : schedulesProcessing ? "Salesforce is creating the billing schedules…" : "" },
    { id: "readiness", label: "Tax engine readiness", state: readiness.ready ? "done" : scheduled || invoiced ? "failed" : "pending", detail: readiness.ready ? "Ready" : readiness.reason ?? "" },
    { id: "invoice", label: "Invoice generated", state: invoiced ? "done" : scheduled && readiness.ready ? "current" : "pending", detail: invoice ? `${invoice.number} · ${invoice.status}` : "" },
    { id: "tax", label: "Salesforce tax calculation", state: taxCalculated && taxOk ? "done" : invoiced ? "processing" : "pending", detail: invoice ? `${taxLines.length} line(s) with InvoiceLineTax · tax ${money(invoice.tax)}` : "" },
    { id: "post", label: "Invoice posted", state: posted ? "done" : taxCalculated && taxOk ? "current" : "pending", detail: posted ? `${invoice!.number} Posted` : "" },
    { id: "verify", label: "Final values verified", state: checks.every(c => c.passed) ? "done" : posted ? "processing" : "pending", detail: `${checks.filter(c => c.passed).length}/${checks.length} checks` },
  ];
  if (taxStop) { const s = steps.find(x => x.id === "tax")!; s.state = "failed"; s.detail = `${s.detail} · ${checks.find(c => c.id === "line-tax-records")?.passed === false ? "Salesforce created no InvoiceLineTax at the configured rate" : "totals don't match the configured rate"}`; }
  let next: TaxRunState["next"] = null;
  if (failure) { const f = failure; const s = steps.find(x => x.id === f.step); if (s) s.state = "failed"; }
  else if (!chainOk || ambiguous.length || taxStop || scheduleStop) next = null;
  else if (!configured) next = b.order.activated ? null : { action: "assign-treatment", label: "Set tax treatment on order products" };
  else if (!setupDone) next = { action: "setup", label: "Apply billing setup" };
  else if (!b.order.activated) next = { action: "activate", label: "Activate order" };
  else if (!scheduled) next = schedulesProcessing ? { action: "wait", label: "Waiting for billing schedules" } : { action: "schedules", label: "Create billing schedules" };
  else if (!invoiced && !readiness.ready) next = null;
  else if (!invoiced) next = schedules.some(s => /processing/i.test(s.status ?? "")) ? { action: "wait", label: "Waiting for Salesforce" } : { action: "generate-invoice", label: "Generate invoice" };
  else if (!taxCalculated) next = draft && invoice!.lines.some(l => /pending/i.test(l.taxStatus ?? "")) ? { action: "calculate-tax", label: "Calculate tax in Salesforce" } : { action: "wait", label: "Waiting for Salesforce tax calculation" };
  else if (!posted) next = draft ? { action: "post-invoice", label: "Post invoice" } : { action: "wait", label: "Waiting for posting" };
  else if (!checks.every(c => c.passed)) next = { action: "wait", label: "Waiting for actual tax" };
  if (!failure && !next && scheduled && !invoiced && !readiness.ready) {
    failure = { step: "readiness", code: m.dt?.outdated ? (m.dt.source === "engine" ? "ENGINE_TABLE_NO_TAXCODE" : "STANDARD_TAX_TABLE_OUTDATED") : "TAX_ENGINE_NOT_READY", category: "tax-engine", reason: readiness.reason ?? "Salesforce tax engine isn't ready.", adminAction: adminFix(m.dt), retryLabel: RETRY_LABEL.readiness, retryable: true };
    steps.find(s => s.id === "readiness")!.state = "failed";
  }
  if (!failure && scheduleStop) failure = { step: "schedules", code: "SCHEDULE_TREATMENT_REPLACED", category: "configuration", reason: `Billing schedule ${replacedSchedules[0].number} carries tax treatment "${replacedSchedules[0].treatment?.name ?? "none"}" instead of the order product's taxable treatment — invoicing stopped.`, retryLabel: null, retryable: false };
  if (failure || taxStop) for (const s of steps) if (s.state === "current" || (s.state === "processing" && s.id !== failure?.step)) s.state = "pending";
  const complete = checks.length === 15 && checks.every(c => c.passed);
  const endToEnd = complete ? "SUCCESS" : failure || taxCalculation === "FAILED" || ambiguous.length || (!configured && b.order.activated) ? "FAILED" : "IN PROGRESS";
  const message = failure ? `Stopped at "${steps.find(s => s.id === failure!.step)?.label ?? failure.step}": ${failure.reason}`
    : complete ? `Salesforce calculated ${money(invoice!.tax)} tax on ${invoice!.number}; posted total ${money(invoice!.totalWithTax)}. 15/15 checks passed.`
      : taxCalculation === "FAILED" ? `Stopped: Salesforce calculated ${money(invoice?.tax)} tax on ${invoice?.number}, which doesn't match the configured rate. The invoice was not posted and nothing was adjusted.`
        : ambiguous.length || (!configured && b.order.activated) ? `Stopped: ${steps[0].detail}` : next ? `Next: ${next.label}.` : "Waiting for Salesforce.";
  return {
    success: true, orderId: b.order.id, connection: m.connection,
    order: { id: b.order.id, number: b.order.number, status: b.order.status, account: b.order.account, total: b.order.totalAmount, activated: b.order.activated, legalEntity,
      billingAddress: b.order.billingAddress ? { city: b.order.billingAddress.city, state: b.order.billingAddress.state, postalCode: b.order.billingAddress.postalCode, country: b.order.billingAddress.country } : null },
    items, schedules, invoice, readiness, steps, next: complete ? null : next, confirmation: complete || failure ? null : confirmationFor(next?.action, { orderNumber: b.order.number, invoiceNumber: invoice?.number ?? null }), failure, checks, complete, taxCalculation, endToEnd, currency: m.currency, message,
  };
}

/** Perform the NEXT Salesforce operation of the run, re-read and return the state. Stops at the first rejection. */
export async function advanceTaxRun(client: SalesforceClient, orderId: string, opts: { retry?: boolean; confirm?: RunAction | null } = {}): Promise<TaxRunState> {
  const fkey = `${client.cacheScope}:${orderId}`;
  const lockKey = `${fkey}:advance`;
  if (inflight.has(lockKey)) { await inflight.get(lockKey)!.catch(() => null); return getTaxRun(client, orderId); }
  const work = (async () => {
    if (opts.retry) failures.delete(fkey);
    const state = await getTaxRun(client, orderId);
    if (state.failure || !state.next || state.next.action === "wait") return state;
    // A billable step runs only when THIS step was confirmed (the state tells the caller which one awaits confirmation).
    if (BILLABLE_ACTIONS.has(state.next.action) && opts.confirm !== state.next.action) return state;
    const step = { "assign-treatment": "config", setup: "setup", activate: "activate", schedules: "schedules", "generate-invoice": "invoice", "calculate-tax": "tax", "post-invoice": "post" }[state.next.action];
    let out: MutationOutcome | { ok: false; status: number; code: string; error: string; technical?: unknown } | { ok: true };
    switch (state.next.action) {
      case "assign-treatment": {
        const targets = state.items.filter(i => i.expectedTreatment && i.treatment?.id !== i.expectedTreatment.id);
        const res = await compositeAt(client, client.apiVersion, targets.map((i, n) => ({ method: "PATCH" as const, url: `/sobjects/OrderItem/${i.id}`, referenceId: `item${n}`, body: { TaxTreatmentId: i.expectedTreatment!.id } })));
        out = res.ok ? { ok: true } : { ok: false, status: 422, code: res.errors[0]?.errorCode ?? "SALESFORCE_ERROR", error: `Salesforce rejected the tax treatment: ${res.errors.map(e => e.message).join("; ")}`, technical: res.results };
        break;
      }
      case "setup": out = await applyOrderBillingSetup(client, orderId, { operations: ["order-action", "billing-treatment"] }); break;
      case "activate": out = await activateOrderForBilling(client, orderId); break;
      case "schedules": {
        const b = await loadOrderBilling(client, orderId);
        if (!b.order.billToContact || !b.order.billingAddress || !b.order.shippingAddress) {
          const fix = await setOrderBillingDetails(client, orderId, { contactId: b.order.billToContact ? null : b.accountContacts[0]?.id ?? null, address: b.order.billingAddress ? null : b.addressSuggestions[0]?.address ?? null, shippingAddress: b.order.shippingAddress ? null : b.addressSuggestions[0]?.address ?? null });
          if (!fix.ok) { out = fix; break; }
        }
        out = await requestOrderBillingSchedules(client, orderId);
        break;
      }
      case "generate-invoice": {
        // Re-check the engine right before invoicing: an invoice that fails tax goes to Error and can't be recalculated.
        if (!state.readiness.ready) { out = { ok: false, status: 409, code: "TAX_ENGINE_NOT_READY", error: state.readiness.reason ?? "Salesforce tax engine isn't ready." }; break; }
        out = await generateOrderInvoices(client, orderId);
        break;
      }
      case "calculate-tax": out = await calculateEstimatedTax(client, state.invoice!.id); break;
      case "post-invoice": out = await postOrderInvoice(client, orderId, state.invoice!.id); break;
    }
    if (!out.ok) failures.set(fkey, { step, reason: out.error, code: out.code, category: categorize(out.code, out.error), retryable: true, technical: out.technical });
    return getTaxRun(client, orderId);
  })();
  inflight.set(lockKey, work);
  try { return await work; } finally { inflight.delete(lockKey); }
}

/**
 * Pure: has Salesforce finished the invoice's tax processing? Every line has a tax status other than Pending, the invoice isn't in
 * Error, and it isn't in a transient processing status (Draft In Progress… — lines stay "Estimated" while Salesforce works).
 */
export function invoiceTaxSettled(invoice: Pick<TaxInvoice, "status" | "lines"> | null): boolean {
  return !!invoice && invoice.lines.length > 0 && invoice.lines.every(l => l.taxStatus && l.taxStatus !== "Pending") && !/error/i.test(invoice.status ?? "") && !isInvoiceProcessing(invoice.status);
}

/** Salesforce's Invoice Estimated Tax Calculation API — Draft invoices only (Salesforce enforces it). */
export async function calculateEstimatedTax(client: SalesforceClient, invoiceId: string): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string; technical?: unknown }> {
  const res = await client.requestWithDiagnostics("/commerce/invoicing/invoices/collection/actions/calculate-estimated-tax", { method: "POST", body: JSON.stringify({ invoiceIds: [invoiceId] }) });
  const json = res.json as { success?: boolean; errors?: { message?: string; errorCode?: string }[] } | { message?: string; errorCode?: string }[] | null;
  const errs = Array.isArray(json) ? json : json && json.success === false ? json.errors ?? [] : [];
  if (res.status >= 400 || errs.length) return { ok: false, status: res.status >= 400 ? res.status : 422, code: errs[0]?.errorCode ?? "TAX_CALCULATION_FAILED", error: `Salesforce didn't calculate the tax: ${errs.map(e => e.message).filter(Boolean).join("; ") || res.statusText}`, technical: res.json ?? res.rawText };
  return { ok: true };
}

/** Verification orders (newest first), with their invoice tax. */
export async function listTaxRuns(client: SalesforceClient) {
  const rows = await queryAt(client, client.apiVersion, `SELECT Id, OrderNumber, Status, Account.Name, CreatedDate, Description FROM Order WHERE Name LIKE '${RUN_NAME}%' OR Name LIKE '${LEGACY_RUN_NAME}%' ORDER BY CreatedDate DESC LIMIT 50`);
  const orderIds = rows.map(r => r.Id as string);
  const scheds = orderIds.length ? await queryAt(client, client.apiVersion, `SELECT Id, ReferenceEntityId FROM BillingSchedule WHERE ReferenceEntityId IN (${idList(orderIds)})`).catch(() => []) : [];
  const lines = scheds.length ? await queryAt(client, client.apiVersion, `SELECT BillingScheduleId, InvoiceId, Invoice.DocumentNumber, Invoice.Status, Invoice.TotalTaxAmount, Invoice.TotalAmountWithTax FROM InvoiceLine WHERE BillingScheduleId IN (${idList(scheds.map(s => s.Id as string))})`).catch(() => []) : [];
  return {
    success: true as const,
    runs: rows.map(r => {
      const sIds = new Set(scheds.filter(s => s.ReferenceEntityId === r.Id).map(s => s.Id as string));
      const l = lines.find(x => sIds.has(x.BillingScheduleId as string));
      const inv = l?.Invoice as Record<string, unknown> | undefined;
      return {
        orderId: r.Id as string, orderNumber: str(r.OrderNumber), status: str(r.Status), account: str((r.Account as Record<string, unknown> | null)?.Name), createdDate: str(r.CreatedDate),
        description: str(r.Description)?.replace(RUN_TAG, "").trim() ?? null,
        invoice: l ? { id: l.InvoiceId as string, number: str(inv?.DocumentNumber), status: str(inv?.Status), tax: num(inv?.TotalTaxAmount), totalWithTax: num(inv?.TotalAmountWithTax) } : null,
      };
    }),
  };
}
export type TaxRunList = Awaited<ReturnType<typeof listTaxRuns>>;
