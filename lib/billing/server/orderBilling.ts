import { createHash } from "node:crypto";
import { normalizeApiVersionNumber, soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { activateOrder } from "@/lib/orders/metadata/orderStatus";
import { billingDescribe, billingDescribeGlobal } from "@/lib/billing/server/discovery";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { discoverAssignmentField, evaluatePolicyChain, loadPolicyChain, type AssignmentCheckItem, type AssignmentPolicyChain } from "@/lib/billing/server/assignment";
import { summarizeSalesforceErrors, type SalesforceErrorItem } from "@/lib/billing/server/errors";
import { invoicePostingGate, invoiceTotalWithTax, readScheduleTreatments, verifyInvoiceTax } from "@/lib/tax/server/invoiceTax";
import { geographyLabel, normalizeGeography } from "@/lib/tax/server/geography";
import { evaluateOrderItemTax, evaluateTaxGeography, loadOrderItemTaxFacts, loadTaxGeoFacts, taxAddress, taxIssueCategory, type OrderItemTaxEvaluation, type OrderTaxContext, type TaxGeoFacts, type TaxReadinessCategory } from "@/lib/tax/server/orderItemTax";

/**
 * ORDER → REVENUE CLOUD BILLING service: the one backend behind "Continue with Revenue Cloud
 * Billing" (entered from order creation, Order History and Order Details alike).
 *
 * Every relationship is discovered from Describe at runtime and every step is derived from, and
 * written to, Salesforce — there is no local workflow state:
 *   Product2.<BillingPolicy ref> → BillingPolicy.DefaultBillingTreatmentId → BillingTreatmentItem
 *   OrderItem.<OrderAction ref>       ← one OrderAction (Type "Add") per new order
 *   OrderItem.<BillingTreatment ref>  ← the product policy's default treatment (never overwritten)
 *   OrderItem.TaxTreatmentId          ← the product's Tax Policy treatment (never overwritten). Salesforce does NOT derive it from
 *                                       Product2.TaxPolicyId: left blank, the legal entity's treatment is billed (no tax).
 *   OrderItem.ProductSellingModelId   ← read-only, derived from the PricebookEntry — checked, never written
 *   usage: ProductUsageResource config before activation, TransactionUsageEntitlement after
 *   BillingSchedule(.ReferenceEntityId = Order) → InvoiceLine.BillingScheduleId → Invoice
 * Mutations are idempotent (existing records are reused, never duplicated) and every mutating call
 * re-loads and re-validates server-side, guarded by a state token against concurrent changes.
 */

export type OrderSetupOperation = "order-action" | "billing-treatment" | "tax-treatment" | "billing-start-month" | "billing-end-date";
export type ItemStatus = "READY" | "ACTION_REQUIRED" | "WARNING" | "BLOCKED" | "ALREADY_CONFIGURED";
export type StepStatus = "done" | "current" | "pending" | "blocked" | "not-required";

export interface OrderBillingItem {
  id: string;
  product: { id: string; name: string; code: string | null } | null;
  quantity: number | null;
  totalPrice: number | null;
  sellingModelType: string | null;
  billingFrequency: string | null;
  billingModel: string;
  policy: AssignmentPolicyChain | null;
  chainChecks: AssignmentCheckItem[];
  treatment: { current: { id: string; name: string } | null; expected: { id: string; name: string } | null; state: "set" | "will-set" | "conflict" | "unavailable" };
  /** Order Product → Tax Treatment (what Salesforce copies to the billing schedule and invoice line). */
  tax: Omit<OrderItemTaxEvaluation, "state"> & { state: OrderItemTaxEvaluation["state"] | "unavailable" };
  /** OrderItem.ProductSellingModelId (derived by Salesforce from the PricebookEntry). */
  sellingModel: { id: string; name: string | null } | null;
  orderAction: { id: string; name: string; type: string | null } | null;
  usage: { required: boolean; reason: string; resources: { name: string; status: string | null }[]; entitlements: { id: string; name: string; resource: string }[]; state: "not-required" | "configured" | "generated" | "missing" };
  status: ItemStatus;
  /** `code` is set for tax / selling-model issues (structured activation blockers). */
  issues: { severity: "error" | "warning" | "info"; message: string; code?: string }[];
  pendingActions: OrderSetupOperation[];
  /** OrderItem.LegalEntityId (read; Salesforce fills it). */
  legalEntityId?: string | null;
  pricebookEntryId?: string | null;
  /** The product has a Billing or Tax Policy (or the line already carries a treatment) — activation must pass billing readiness. */
  billingRequired?: boolean;
  /** Annual billing: OrderItem.PeriodBoundaryStartMonth, from which Salesforce derives BillingScheduleGroup.BillingStartMonth. */
  billingStartMonth?: BillingStartMonth;
  /** Term-defined subscriptions: OrderItem.EndDate, the end Salesforce needs for an OrderAmount billing schedule. */
  billingEndDate?: BillingEndDate;
}

/** The billing start month an order product needs (Annual only). Months are Salesforce's picklist values "1".."12". */
export interface BillingStartMonth { required: boolean; current: string | null; boundary: string | null; expected: string | null; source: "ServiceDate" | "EffectiveDate" | null }

/**
 * The billing end date an order product needs. `start` is what Salesforce bills from (OrderItem.ServiceDate, else the Order Start
 * Date); `expected` is derived from the subscription term, else the Order End Date. `invalid` explains an end date that can't be used.
 */
export interface BillingEndDate {
  required: boolean; current: string | null; start: string | null; startSource: "ServiceDate" | "EffectiveDate" | null;
  expected: string | null; source: "Term" | "OrderEndDate" | null; term: string | null; invalid: string | null;
}

/** A structured activation blocker: what failed, its category and the order product it belongs to. */
export interface ReadinessBlocker { code: string; category: TaxReadinessCategory | "BILLING_NOT_READY"; message: string; orderItemId: string | null; product: string | null }

export interface BillingAddress { street: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }
export type AddressKind = "billing" | "shipping";
export interface AddressLabels { country: string | null; state: string | null }
const ADDRESS_PREFIX: Record<AddressKind, string> = { billing: "Billing", shipping: "Shipping" };
const ADDRESS_LABEL: Record<AddressKind, string> = { billing: "Billing Address", shipping: "Shipping Address" };
const addressFields = (prefix: string) => ({ street: `${prefix}Street`, city: `${prefix}City`, state: `${prefix}State`, postalCode: `${prefix}PostalCode`, country: `${prefix}Country` });
const addressSelect = (prefix: string) => Object.values(addressFields(prefix)).join(", ");
const addressText = (a: BillingAddress) => [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ");
const addressOf = (row: Record<string, unknown>, prefix = "Billing"): BillingAddress | null => {
  const a: BillingAddress = { street: (row[`${prefix}Street`] as string) ?? null, city: (row[`${prefix}City`] as string) ?? null, state: (row[`${prefix}State`] as string) ?? null, postalCode: (row[`${prefix}PostalCode`] as string) ?? null, country: (row[`${prefix}Country`] as string) ?? null };
  return Object.values(a).some(Boolean) ? a : null;
};
const addressComplete = (a: BillingAddress | null) => !!a && !!a.street?.trim() && !!a.city?.trim() && !!a.country?.trim();
const addressKey = (a: BillingAddress) => Object.values(a).map(v => (v ?? "").trim().toLowerCase()).join("|");
/** The address with Country/State as the ISO codes the tax decision table matches ("canada"/"ontario" → CA/ON). */
const withGeoCodes = (a: BillingAddress, geo: TaxGeoFacts | null): BillingAddress => { const g = normalizeGeography(a, geo); return { ...a, country: g.country, state: g.state }; };
const addressLabels = (a: BillingAddress | null, geo: TaxGeoFacts | null): AddressLabels | null => {
  if (!a) return null;
  const g = normalizeGeography(a, geo);
  return { country: geographyLabel(g.countryName, g.country), state: geographyLabel(g.stateName, g.state) };
};

export interface OrderBillingState {
  success: true;
  order: {
    id: string; number: string | null; name: string | null; status: string | null; activated: boolean;
    account: { id: string; name: string } | null; effectiveDate: string | null; currency: string | null; totalAmount: number | null;
    salesforceUrl: string; lastModifiedDate: string | null;
    /** Order.BillToContactId — Salesforce's billing schedule action requires it ("Required fields are missing: billToContact"). */
    billToContact: { id: string; name: string } | null; billToSupported: boolean;
    /** Order billing address (Order.Billing* fields) — Salesforce's schedule action also requires it ("Required fields are missing: billingAddress"). */
    billingAddress: BillingAddress | null;
    /** Order shipping address (Order.Shipping* fields) — also required by the schedule action ("Required fields are missing: shippingAddress"). */
    shippingAddress: BillingAddress | null;
    /** Readable Country / State of each address ("Canada (CA)", "Ontario (ON)") — the fields themselves hold the ISO codes. */
    addressLabels: { billing: AddressLabels | null; shipping: AddressLabels | null };
  };
  /** The order Account's Contacts — the only valid Bill To Contact choices. */
  accountContacts: { id: string; name: string; email: string | null }[];
  /** Addresses found on real Salesforce records (Account billing, Contact mailing, this Account's previous orders) — offered, never auto-applied. */
  addressSuggestions: { source: string; address: BillingAddress }[];
  items: OrderBillingItem[];
  orderActions: { id: string; name: string; type: string | null }[];
  schedules: { id: string; number: string; status: string | null; start: string | null; end: string | null; term: string | null; amount: number | null; nextBillingDate: string | null; groupId: string | null; product: string | null; treatmentItem: string | null; invoiced: boolean;
    /** BillingSchedule.TaxTreatmentId and its order product (read at the tax API version; null when not read). */
    taxTreatment?: { id: string; name: string } | null; orderItemId?: string | null }[];
  /** Why the schedules' tax treatments couldn't be read (they are then unknown, not blank). */
  scheduleTaxError?: string | null;
  scheduleGroups: { id: string; number: string }[];
  invoices: { id: string; number: string | null; status: string | null; amount: number | null; balance: number | null; invoiceDate: string | null; scheduleIds: string[]; salesforceUrl: string;
    /** Salesforce's invoice tax, verified from InvoiceLineTax (state VERIFIED_TAX_APPLIED / VERIFIED_ZERO_TAX / TAX_VERIFICATION_FAILED …). */
    tax?: { state: string; message: string; totalTax: number | null; totalWithTax: number | null; invoiceLineTax: { id: string; amount: number | null; rate: number | null; code: string | null }[] } | null }[];
  /** Salesforce async jobs (AsyncOperationTracker) referencing this order — e.g. billing schedule creation. */
  jobs: { id: string; number: string | null; status: string | null; jobType: string | null; createdDate: string | null; finishedAt: string | null; failedItems: number | null; response: string | null }[];
  /** Whether Salesforce's "Create Billing Schedules from Billing Transaction" action can be requested now. */
  scheduleCreation: { available: boolean; reason: string };
  readiness: {
    ready: boolean; checks: { id: string; label: string; status: "passed" | "warning" | "failed" | "pending"; detail?: string }[]; blockers: string[];
    /** Structured blockers (tax/selling-model ones carry their category: MISSING_TAX_RATE, TREATMENT_MISMATCH, INVALID_GEOGRAPHY…). */
    blockerDetails: ReadinessBlocker[];
    /** READY, or the first tax blocker's category. */
    taxStatus: "READY" | "NOT_APPLICABLE" | TaxReadinessCategory;
  };
  /** Order.LegalEntityId (read). */
  legalEntityId: string | null;
  /** True when at least one order product is configured for billing or tax — activation then requires billing readiness. */
  requiresBillingReadiness: boolean;
  lifecycle: { id: string; label: string; status: StepStatus; detail: string }[];
  fields: Record<string, string | null>;
  /** Hash of everything activation depends on — sent back with mutations to detect concurrent changes. */
  stateToken: string;
}

const statusText = (v: unknown) => (typeof v === "boolean" ? (v ? "Active" : "Inactive") : typeof v === "string" ? v : null);
const q = async (client: SalesforceClient, soql: string) => (await client.queryAll<Record<string, unknown>>(soql));
const idList = (ids: string[]) => ids.map(i => `'${soqlEscape(i)}'`).join(",");
const rel = (row: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), row);

interface DiscoveredFields {
  orderAction: string | null; orderActionRel: string | null; treatment: string | null; treatmentRel: string | null;
  sellingModel: string | null; sellingModelRel: string | null; frequency: string | null; totalPrice: string | null; currency: string | null;
  taxTreatment: string | null; taxTreatmentRel: string | null; productTaxPolicy: string | null; entrySellingModel: boolean; hasSellingModelOption: boolean;
  productPolicy: string | null; usageModelType: string | null;
  hasProductUsageResource: boolean; hasTUE: boolean; hasOrderAction: boolean; hasBillingSchedule: boolean; hasInvoice: boolean; billTo: string | null; billToRel: string | null; hasAsyncTracker: boolean; hasScheduleAction: boolean;
  scheduleRef: string | null; invoiceLineSchedule: string | null;
  orderLegalEntity: string | null; itemLegalEntity: string | null; itemServiceDate: string | null;
  /** OrderItem.PeriodBoundaryStartMonth / PeriodBoundary (both updateable) — the transaction inputs (BillingContext tags
   * BillingStartMonth__std / PeriodBoundary__std) behind BillingScheduleGroup.BillingStartMonth (read-only there). */
  periodStartMonth: string | null; periodBoundary: string | null;
  /** OrderItem.EndDate (BillingContext: BillingTransactionItem.EndDate) and the term inputs it is derived from. */
  itemEndDate: string | null; itemEndDateUpdateable: boolean; itemSubscriptionTerm: string | null; itemPricingTermCount: string | null;
  sellingModelTerm: boolean;
}

/** The period boundary set on an annual line that has none: billing periods anniversary the line's start date, the date the start month is derived from. */
export const ANNUAL_PERIOD_BOUNDARY = "Anniversary";

/**
 * Pure: the billing start month for an order product. Salesforce's schedule action rejects an Annual line without one
 * ("Required fields are missing: billingStartMonth"); it hydrates OrderItem.PeriodBoundary and PeriodBoundaryStartMonth and derives
 * the read-only BillingScheduleGroup.BillingStartMonth from them. Verified on p10 order 00000149: the start month alone still failed;
 * with PeriodBoundary "Anniversary" as well, BSG-000000033 was created (Year, BillingStartMonth 10). The month is the line's start:
 * its Service Date, else the Order Start Date. Other frequencies (monthly, one-time…) don't use it, so nothing is derived for them.
 */
export function billingStartMonth(x: { frequency: string | null; current: string | null; boundary?: string | null; serviceDate: string | null; effectiveDate: string | null }): BillingStartMonth {
  const boundary = x.boundary ?? null;
  if (x.frequency !== "Annual") return { required: false, current: x.current, boundary, expected: null, source: null };
  const monthOf = (d: string | null) => { const m = /^\d{4}-(\d{2})-\d{2}/.exec(d ?? ""); const n = m ? Number(m[1]) : NaN; return n >= 1 && n <= 12 ? String(n) : null; };
  const fromService = monthOf(x.serviceDate);
  const expected = fromService ?? monthOf(x.effectiveDate);
  return { required: true, current: x.current, boundary, expected, source: fromService ? "ServiceDate" : expected ? "EffectiveDate" : null };
}

/** Pure: the OrderItem fields an annual line still needs (blank ones only — never overwritten); null when complete or unresolvable. */
export function billingStartMonthPatch(b: BillingStartMonth | undefined): { PeriodBoundary?: string; PeriodBoundaryStartMonth?: string } | null {
  if (!b?.required || (!b.current && !b.expected)) return null;
  const patch = { ...(!b.boundary && { PeriodBoundary: ANNUAL_PERIOD_BOUNDARY }), ...(!b.current && { PeriodBoundaryStartMonth: b.expected! }) };
  return Object.keys(patch).length ? patch : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const parseIsoDate = (d: string | null | undefined): Date | null => {
  const m = ISO_DATE.exec((d ?? "").slice(0, 10));
  if (!m) return null;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return date.getUTCMonth() === +m[2] - 1 ? date : null;
};
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
/** Calendar months, clamped to the last day of a shorter month (Jan 31 + 1 month = Feb 28/29), as Salesforce's Date.addMonths does. */
function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}
/** Months (or weeks) per ProductSellingModel.PricingTermUnit. */
const TERM_UNIT: Record<string, { months?: number; weeks?: number; label: string }> = {
  Months: { months: 1, label: "month" }, Quarterly: { months: 3, label: "quarter" }, "Semi-Annual": { months: 6, label: "half-year" },
  Annual: { months: 12, label: "year" }, Weekly: { weeks: 1, label: "week" },
};

/**
 * Pure: the billing end date for an order product. Salesforce bills a term-defined subscription with billing method OrderAmount and
 * hydrates its end from OrderItem.EndDate (BillingContext__stdctx: OrderItem.EndDate → BillingTransactionItem.EndDate,
 * OrderItem.ServiceDate → StartDate). A blank one fails the schedule action with FIELD_INTEGRITY_EXCEPTION "When the billing method
 * is OrderAmount, the end date can't be null" (p10 order 00000152, "Basic Training", Term Based - Monthly).
 *
 * - One-time lines: Salesforce sets the schedule's end to its start itself (BS-000000032/35 — OneTime, OrderAmount, end = start,
 *   OrderItem.EndDate blank), so nothing is required.
 * - Evergreen lines bill with method Evergreen and have no end.
 * - Term-defined: end = start + term − 1 day, the term being PricingTermCount (else SubscriptionTerm) × the selling model's pricing
 *   term in its unit; without a term, the Order End Date (the order's explicitly configured period) if it isn't before the start.
 *   Nothing is guessed: no start or no term and no Order End Date leaves it unresolved.
 */
export function billingEndDate(x: {
  sellingModelType: string | null; current: string | null; serviceDate: string | null; effectiveDate: string | null; orderEndDate: string | null;
  pricingTerm: number | null; pricingTermUnit: string | null; subscriptionTerm: number | null; pricingTermCount: number | null;
}): BillingEndDate {
  const startDate = parseIsoDate(x.serviceDate) ?? parseIsoDate(x.effectiveDate);
  const start = startDate ? isoOf(startDate) : null;
  const startSource = parseIsoDate(x.serviceDate) ? "ServiceDate" : startDate ? "EffectiveDate" : null;
  const base = { current: x.current, start, startSource, term: null, invalid: null } as const;
  if (x.sellingModelType !== "TermDefined") return { ...base, required: false, expected: null, source: null };

  if (x.current) {
    const cur = parseIsoDate(x.current);
    const invalid = !cur ? `End Date "${x.current}" isn't a valid date.` : startDate && cur < startDate ? `End Date ${x.current} is before the billing start date ${start}.` : null;
    return { ...base, required: true, expected: null, source: null, invalid };
  }
  if (!startDate) return { ...base, required: true, expected: null, source: null, invalid: "Neither the Order Product's Start Date nor the Order Start Date is set, so the billing period can't be determined." };

  const unit = x.pricingTermUnit ? TERM_UNIT[x.pricingTermUnit] : undefined;
  const count = x.pricingTermCount && x.pricingTermCount > 0 ? x.pricingTermCount : x.subscriptionTerm && x.subscriptionTerm > 0 ? x.subscriptionTerm : null;
  const per = x.pricingTermCount && x.pricingTermCount > 0 ? (x.pricingTerm && x.pricingTerm > 0 ? x.pricingTerm : 1) : 1;
  if (unit && count && Number.isInteger(count * per)) {
    const n = count * per;
    const after = unit.months ? addMonthsClamped(startDate, n * unit.months) : new Date(startDate.getTime() + n * (unit.weeks ?? 0) * 7 * 86_400_000);
    const end = new Date(after.getTime() - 86_400_000);
    return { ...base, required: true, expected: isoOf(end), source: "Term", term: `${n} ${unit.label}${n === 1 ? "" : "s"}` };
  }
  const orderEnd = parseIsoDate(x.orderEndDate);
  if (orderEnd && orderEnd >= startDate) return { ...base, required: true, expected: isoOf(orderEnd), source: "OrderEndDate", term: null };
  return {
    ...base, required: true, expected: null, source: null,
    invalid: !unit ? `The selling model's pricing term unit "${x.pricingTermUnit ?? "blank"}" isn't one Salesforce bills by term, and the Order has no End Date.`
      : "The Order Product has no Subscription Term / Pricing Term Count, and the Order has no End Date.",
  };
}

/** Pure: the blank OrderItem.EndDate a term-defined line still needs — null when set, not required or unresolvable. */
export function billingEndDatePatch(b: BillingEndDate | undefined): { EndDate: string } | null {
  return b?.required && !b.current && b.expected ? { EndDate: b.expected } : null;
}

/** Salesforce's standard invocable action that creates billing schedules for an activated order (the order is the billing transaction). */
export const SCHEDULE_ACTION = "createBillingSchedulesFromBillingTransaction";
const actionCache = new Map<string, boolean>();
export async function hasStandardAction(client: SalesforceClient, name: string): Promise<boolean> {
  const key = `${client.cacheScope}:${name}`;
  if (!actionCache.has(key)) {
    const res = await client.requestWithDiagnostics(`/actions/standard/${name}`, { method: "GET" }).catch(() => null);
    actionCache.set(key, !!res && res.status < 400);
  }
  return actionCache.get(key)!;
}

/** Discover the order ↔ billing relationships from Describe (never assumed). */
async function discoverFields(client: SalesforceClient): Promise<DiscoveredFields> {
  const global = new Set((await billingDescribeGlobal(client)).map(g => g.name));
  const oi = await billingDescribe(client, "OrderItem");
  const ord = await billingDescribe(client, "Order");
  const refTo = (d: typeof oi, target: string) => d.fields.find(f => f.type === "reference" && f.referenceTo?.includes(target));
  const oa = global.has("OrderAction") ? refTo(oi, "OrderAction") : undefined;
  const bt = global.has("BillingTreatment") ? refTo(oi, "BillingTreatment") : undefined;
  const psm = refTo(oi, "ProductSellingModel");
  const tt = global.has("TaxTreatment") ? refTo(oi, "TaxTreatment") : undefined;
  const pbe = await billingDescribe(client, "PricebookEntry");
  const freq = oi.fields.find(f => f.name === "BillingFrequency2") ?? oi.fields.find(f => /billing frequency/i.test(f.label) && f.type === "picklist");
  const prod = await billingDescribe(client, "Product2");
  const taxPolicyRef = global.has("TaxPolicy") ? refTo(prod, "TaxPolicy") : undefined;
  const productPolicy = (await discoverAssignmentField(client))?.name ?? null;
  let scheduleRef: string | null = null;
  if (global.has("BillingSchedule")) {
    const bs = await billingDescribe(client, "BillingSchedule");
    scheduleRef = bs.fields.find(f => f.name === "ReferenceEntityId" && f.referenceTo?.includes("Order"))?.name ?? bs.fields.find(f => f.type === "reference" && f.referenceTo?.includes("Order"))?.name ?? null;
  }
  let invoiceLineSchedule: string | null = null;
  if (global.has("InvoiceLine")) {
    const il = await billingDescribe(client, "InvoiceLine");
    invoiceLineSchedule = il.fields.find(f => f.type === "reference" && f.referenceTo?.includes("BillingSchedule"))?.name ?? null;
  }
  return {
    orderAction: oa?.name ?? null, orderActionRel: oa?.relationshipName ?? null,
    treatment: bt?.name ?? null, treatmentRel: bt?.relationshipName ?? null,
    sellingModel: psm?.name ?? null, sellingModelRel: psm?.relationshipName ?? null, frequency: freq?.name ?? null,
    taxTreatment: tt?.updateable ? tt.name : null, taxTreatmentRel: tt?.updateable ? tt.relationshipName ?? null : null,
    productTaxPolicy: taxPolicyRef?.name ?? null,
    entrySellingModel: pbe.fields.some(x => x.name === "ProductSellingModelId"), hasSellingModelOption: global.has("ProductSellingModelOption"),
    totalPrice: oi.fields.some(f => f.name === "TotalPrice") ? "TotalPrice" : null,
    currency: ord.fields.some(f => f.name === "CurrencyIsoCode") ? "CurrencyIsoCode" : null,
    productPolicy, usageModelType: prod.fields.some(f => f.name === "UsageModelType") ? "UsageModelType" : null,
    hasProductUsageResource: global.has("ProductUsageResource"), hasTUE: global.has("TransactionUsageEntitlement"),
    hasOrderAction: global.has("OrderAction"), hasBillingSchedule: global.has("BillingSchedule"), hasInvoice: global.has("Invoice"),
    billTo: ord.fields.find(x => x.name === "BillToContactId" && x.updateable)?.name ?? null,
    billToRel: ord.fields.find(x => x.name === "BillToContactId")?.relationshipName ?? null,
    hasAsyncTracker: global.has("AsyncOperationTracker"), hasScheduleAction: await hasStandardAction(client, SCHEDULE_ACTION),
    scheduleRef, invoiceLineSchedule,
    orderLegalEntity: ord.fields.find(x => x.name === "LegalEntityId")?.name ?? null,
    itemLegalEntity: oi.fields.find(x => x.name === "LegalEntityId")?.name ?? null,
    itemServiceDate: oi.fields.find(x => x.name === "ServiceDate")?.name ?? null,
    periodStartMonth: oi.fields.find(x => x.name === "PeriodBoundaryStartMonth" && x.updateable)?.name ?? null,
    periodBoundary: oi.fields.find(x => x.name === "PeriodBoundary" && x.updateable)?.name ?? null,
    itemEndDate: oi.fields.find(x => x.name === "EndDate")?.name ?? null,
    itemEndDateUpdateable: !!oi.fields.find(x => x.name === "EndDate" && x.updateable),
    itemSubscriptionTerm: oi.fields.find(x => x.name === "SubscriptionTerm")?.name ?? null,
    itemPricingTermCount: oi.fields.find(x => x.name === "PricingTermCount")?.name ?? null,
    sellingModelTerm: global.has("ProductSellingModel") && (await billingDescribe(client, "ProductSellingModel")).fields.some(x => x.name === "PricingTermUnit"),
  };
}

/**
 * Pure: the issue for an Order Product without a Product Selling Model whose product has selling model options. Salesforce
 * derives OrderItem.ProductSellingModelId from the PricebookEntry (read-only on the Order Product; create-only on the entry).
 */
export function sellingModelIssue(x: { productName: string; pricebookEntryId: string | null; optionNames: string[]; alternative: { id: string; sellingModel: string | null } | null }): string {
  const names = [...new Set(x.optionNames)].join(", ");
  return `No Product Selling Model on this Order Product: its PricebookEntry ${x.pricebookEntryId ?? "—"} has none, and Salesforce derives OrderItem.ProductSellingModelId from the PricebookEntry (it can't be set on the Order Product). ${x.alternative
    ? `Remove this Order Product and add ${x.productName} again from PricebookEntry ${x.alternative.id} (${x.alternative.sellingModel ?? "selling model"}).`
    : `Required change (admin): create a PricebookEntry for ${x.productName} in this order's price book with Product Selling Model ${names} — PricebookEntry.ProductSellingModelId can only be set when the entry is created — then add the product again.`}`;
}

/** Load everything about an order's billing lifecycle from Salesforce and evaluate readiness. Read-only. */
export async function loadOrderBilling(client: SalesforceClient, orderId: string): Promise<OrderBillingState> {
  if (!SALESFORCE_ID.test(orderId)) throw new Error("Invalid Order Id.");
  const f = await discoverFields(client);

  const [o] = await q(client, `SELECT Id, OrderNumber, Name, Status, Pricebook2Id, AccountId, Account.Name, EffectiveDate, EndDate, TotalAmount, ActivatedDate, LastModifiedDate, ${addressSelect("Billing")}, ${addressSelect("Shipping")}${f.currency ? `, ${f.currency}` : ""}${f.billTo ? `, ${f.billTo}${f.billToRel ? `, ${f.billToRel}.Name` : ""}` : ""}${f.orderLegalEntity ? `, ${f.orderLegalEntity}` : ""} FROM Order WHERE Id = '${soqlEscape(orderId)}' LIMIT 1`);
  if (!o) throw new Error("Order not found in Salesforce (or not visible to your user).");
  const activated = o.Status === "Activated" || !!o.ActivatedDate;

  const itemSelect = ["Id", "Product2Id", "Product2.Name", "Product2.ProductCode", "Quantity", "SystemModstamp", "PricebookEntryId",
    f.totalPrice, f.frequency, f.sellingModel, f.sellingModelRel && `${f.sellingModelRel}.SellingModelType`, f.sellingModelRel && `${f.sellingModelRel}.Name`,
    f.taxTreatment, f.taxTreatmentRel && `${f.taxTreatmentRel}.Name`, f.productTaxPolicy && `Product2.${f.productTaxPolicy}`,
    f.orderAction, f.orderActionRel && `${f.orderActionRel}.Name`, f.orderActionRel && `${f.orderActionRel}.Type`,
    f.treatment, f.treatmentRel && `${f.treatmentRel}.Name`,
    f.productPolicy && `Product2.${f.productPolicy}`, f.usageModelType && `Product2.${f.usageModelType}`, f.itemLegalEntity, f.itemServiceDate, f.periodStartMonth, f.periodBoundary,
    f.itemEndDate, f.itemSubscriptionTerm, f.itemPricingTermCount, f.sellingModelRel && f.sellingModelTerm && `${f.sellingModelRel}.PricingTerm`, f.sellingModelRel && f.sellingModelTerm && `${f.sellingModelRel}.PricingTermUnit`].filter(Boolean).join(", ");
  const rows = await q(client, `SELECT ${itemSelect} FROM OrderItem WHERE OrderId = '${soqlEscape(orderId)}' ORDER BY CreatedDate, Id`);

  const productIds = [...new Set(rows.map(r => r.Product2Id as string).filter(Boolean))];
  const policyIds = [...new Set(rows.map(r => (f.productPolicy ? rel(r, `Product2.${f.productPolicy}`) : null) as string | null).filter((x): x is string => !!x))];
  const chains = new Map<string, AssignmentPolicyChain | null>();
  await Promise.all(policyIds.map(async pid => chains.set(pid, await loadPolicyChain(client, pid, null).catch(() => null))));

  const pur = f.hasProductUsageResource && productIds.length
    ? await q(client, `SELECT ProductId, Status, UsageResource.Name FROM ProductUsageResource WHERE ProductId IN (${idList(productIds)})`).catch(() => [])
    : [];
  const tue = f.hasTUE && rows.length
    ? await q(client, `SELECT Id, Name, OrderItemId, UsageResource.Name FROM TransactionUsageEntitlement WHERE OrderItemId IN (${idList(rows.map(r => r.Id as string))})`).catch(() => [])
    : [];
  const orderActions = f.hasOrderAction
    ? (await q(client, `SELECT Id, Name, Type FROM OrderAction WHERE OrderId = '${soqlEscape(orderId)}' ORDER BY CreatedDate`).catch(() => [])).map(a => ({ id: a.Id as string, name: String(a.Name), type: (a.Type as string) ?? null }))
    : [];

  // Tax: the treatment each Order Product needs (Salesforce never derives it from the product's Tax Policy). Products with a Tax
  // Policy (or lines that already carry a treatment) need READABLE tax records: a Salesforce error while loading them blocks
  // activation (TAX_RECORDS_UNREADABLE) — it never becomes "no tax applies".
  const sv = (v: unknown) => (typeof v === "string" && v ? v : null);
  const needsTax = !!f.taxTreatment && rows.some(r => (f.productTaxPolicy && rel(r, `Product2.${f.productTaxPolicy}`)) || r[f.taxTreatment!]);
  let taxFacts: Awaited<ReturnType<typeof loadOrderItemTaxFacts>> = null;
  let taxError: string | null = null;
  let geo: TaxGeoFacts | null = null;
  if (needsTax) {
    try {
      taxFacts = await loadOrderItemTaxFacts(client, rows.map(r => ({
        key: r.Id as string, productId: (r.Product2Id as string) ?? null, productName: String(rel(r, "Product2.Name") ?? "Product"),
        taxPolicyId: f.productTaxPolicy ? ((rel(r, `Product2.${f.productTaxPolicy}`) as string | null) ?? null) : null,
        currentTreatmentId: (r[f.taxTreatment!] as string | null) ?? null, productCode: sv(rel(r, "Product2.ProductCode")),
      })));
      geo = await loadTaxGeoFacts(client);
    } catch (e) { taxError = e instanceof Error ? e.message : String(e); }
    // Products carry a Tax Policy, yet the tax objects weren't describable (permission / API version): not "no tax".
    if (!taxError && !taxFacts) taxError = "the Tax Policy / Tax Treatment objects aren't visible to this user (describe failed or this API version lacks them)";
  }
  const today = new Date().toISOString().slice(0, 10);
  const orderLegalEntityId = f.orderLegalEntity ? sv(o[f.orderLegalEntity]) : null;
  const taxAddresses = (() => {
    const list = [taxAddress("Billing Address", addressOf(o), geo), taxAddress("Shipping Address", addressOf(o, "Shipping"), geo)].filter((x): x is NonNullable<typeof x> => !!x);
    return list.filter((x, i) => list.findIndex(y => y.countryIso === x.countryIso && y.stateIso === x.stateIso && y.city === x.city && y.zipCode === x.zipCode) === i);
  })();
  // Selling model: OrderItem.ProductSellingModelId is derived from the PricebookEntry and can't be written.
  const noModel = f.sellingModel ? rows.filter(r => !r[f.sellingModel!] && r.Product2Id) : [];
  const noModelProducts = [...new Set(noModel.map(r => r.Product2Id as string))];
  const modelOptions = noModelProducts.length && f.hasSellingModelOption
    ? await q(client, `SELECT Product2Id, ProductSellingModelId, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id IN (${idList(noModelProducts)})`).catch(() => [])
    : [];
  const modelEntries = noModelProducts.length && f.entrySellingModel && o.Pricebook2Id
    ? await q(client, `SELECT Id, Product2Id, ProductSellingModel.Name FROM PricebookEntry WHERE Pricebook2Id = '${soqlEscape(o.Pricebook2Id as string)}' AND IsActive = true AND ProductSellingModelId != null AND Product2Id IN (${idList(noModelProducts)})`).catch(() => [])
    : [];

  const items: OrderBillingItem[] = rows.map(r => {
    const issues: OrderBillingItem["issues"] = [];
    const pending: OrderBillingItem["pendingActions"] = [];
    const productName = (rel(r, "Product2.Name") as string) ?? "Product";
    const policyId = f.productPolicy ? (rel(r, `Product2.${f.productPolicy}`) as string | null) : null;
    const chain = policyId ? chains.get(policyId) ?? null : null;
    const sellingModelType = f.sellingModelRel ? (rel(r, `${f.sellingModelRel}.SellingModelType`) as string | null) : null;

    // Billing configuration chain (the same evaluation the Product assignment workflow uses).
    let chainChecks: AssignmentCheckItem[] = [];
    if (!f.productPolicy) issues.push({ severity: "error", message: "This org has no Product → Billing Policy relationship, so the order can't be configured for billing." });
    else if (!policyId) issues.push({ severity: "error", message: `${productName} does not have a Billing Policy assigned.` });
    else if (!chain) issues.push({ severity: "error", message: `${productName}'s Billing Policy no longer exists or isn't visible to your user.` });
    else {
      chainChecks = evaluatePolicyChain(chain, "bill");
      for (const c of chainChecks) if (c.status === "failed") issues.push({ severity: "error", message: c.detail! }); else if (c.status === "warning") issues.push({ severity: "warning", message: c.detail! });
    }

    // Order Product → Billing Treatment (a real OrderItem field — never overwritten).
    const currentId = f.treatment ? (r[f.treatment] as string | null) : null;
    const current = currentId ? { id: currentId, name: String(rel(r, `${f.treatmentRel}.Name`) ?? "Billing Treatment") } : null;
    const expected = chain?.defaultTreatment ? { id: chain.defaultTreatment.id, name: chain.defaultTreatment.name } : null;
    let tState: OrderBillingItem["treatment"]["state"] = "unavailable";
    if (!f.treatment) tState = "unavailable";
    else if (current && expected && current.id.slice(0, 15) === expected.id.slice(0, 15)) tState = "set";
    else if (current && expected) { tState = "conflict"; issues.push({ severity: "warning", message: `This Order Product already uses Billing Treatment "${current.name}", but ${productName}'s Billing Policy defaults to "${expected.name}". The existing value is kept.` }); }
    else if (current) tState = "set";
    else if (expected) { tState = "will-set"; if (!activated) pending.push("billing-treatment"); }

    // Order Product → Tax Treatment (a real OrderItem field — never overwritten).
    let tax: OrderBillingItem["tax"] = { current: null, expected: null, state: "unavailable", effective: null, issues: [] };
    const facts = taxFacts?.get(r.Id as string);
    if (facts) {
      const ctx: OrderTaxContext = {
        addresses: taxAddresses, orderLegalEntityId, orderItemLegalEntityId: f.itemLegalEntity ? sv(r[f.itemLegalEntity]) : null,
        // The invoice date (generated now) and the line's service date (else the order's effective date).
        dates: [today, (f.itemServiceDate ? sv(r[f.itemServiceDate]) : null) ?? sv(o.EffectiveDate)].filter((x): x is string => !!x),
      };
      tax = evaluateOrderItemTax(facts, ctx);
      for (const i of tax.issues) issues.push({ severity: i.severity, message: `Tax: ${i.message}`, code: i.code });
      if (tax.state === "will-set") {
        if (!activated) { if (!tax.issues.some(i => i.severity === "error")) pending.push("tax-treatment"); }
        else issues.push({ severity: "warning", code: "TAX_TREATMENT_NOT_SET", message: `Tax: activated without a Tax Treatment on this Order Product — Salesforce bills it with the legal entity's default treatment instead of "${tax.expected!.name}". An activated order's products can't be changed; create a new order.` });
      }
    } else if (needsTax && taxError) issues.push({ severity: "error", code: "TAX_RECORDS_UNREADABLE", message: `Tax: the Order Product's tax configuration couldn't be read from Salesforce (${taxError}). Activation is blocked until it can be verified — check the user's access to Tax Policy, Tax Treatment, Tax Rate, Tax Engine and Decision Table.` });

    const smId = f.sellingModel ? ((r[f.sellingModel] as string | null) ?? null) : null;
    const sellingModel = smId ? { id: smId, name: (rel(r, `${f.sellingModelRel}.Name`) as string) ?? null } : null;
    const options = modelOptions.filter(x => x.Product2Id === r.Product2Id);
    if (f.sellingModel && !smId && options.length) {
      const alt = modelEntries.find(x => x.Product2Id === r.Product2Id);
      issues.push({ severity: "error", code: "MISSING_SELLING_MODEL", message: sellingModelIssue({
        productName, pricebookEntryId: (r.PricebookEntryId as string) ?? null,
        optionNames: options.map(x => String(rel(x, "ProductSellingModel.Name") ?? x.ProductSellingModelId)),
        alternative: alt ? { id: String(alt.Id), sellingModel: (rel(alt, "ProductSellingModel.Name") as string) ?? null } : null,
      }) });
    }

    // Annual billing → OrderItem.PeriodBoundary + PeriodBoundaryStartMonth (Salesforce derives BillingScheduleGroup.BillingStartMonth from them).
    const startMonth = billingStartMonth({
      frequency: f.frequency ? sv(r[f.frequency]) : null, current: f.periodStartMonth ? sv(r[f.periodStartMonth]) : null,
      boundary: f.periodBoundary ? sv(r[f.periodBoundary]) : null,
      serviceDate: f.itemServiceDate ? sv(r[f.itemServiceDate]) : null, effectiveDate: sv(o.EffectiveDate),
    });
    if (startMonth.required && (!startMonth.current || !startMonth.boundary)) {
      const patch = billingStartMonthPatch(startMonth);
      if (!f.periodStartMonth || !f.periodBoundary) issues.push({ severity: "error", code: "BILLING_START_MONTH_UNAVAILABLE", message: `Annual billing needs a billing start month, but this user can't update the Order Product's Period Boundary / Period Boundary Start Month — Salesforce rejects the billing schedule ("Required fields are missing: billingStartMonth"). Check the user's field access to OrderItem.PeriodBoundary and OrderItem.PeriodBoundaryStartMonth.` });
      else if (!patch) issues.push({ severity: "error", code: "BILLING_START_MONTH_UNRESOLVED", message: `Annual billing needs a billing start month, and neither this Order Product's Service Date nor the Order Start Date is set to derive it from. Set the Order Start Date (or the Order Product's Start Date) or its Period Boundary Start Month in Salesforce.` });
      else {
        const from = startMonth.source === "ServiceDate" ? "the Order Product's Start Date" : "the Order Start Date";
        const what = [patch.PeriodBoundary && `Period Boundary → ${patch.PeriodBoundary}`, patch.PeriodBoundaryStartMonth && `Period Boundary Start Month → ${patch.PeriodBoundaryStartMonth} (from ${from})`].filter(Boolean).join(", ");
        if (!activated) pending.push("billing-start-month");
        issues.push({ severity: "info", code: "BILLING_START_MONTH_NOT_SET", message: `Annual billing: Salesforce requires a billing start month for annual schedules — ${activated ? "set when billing schedules are requested" : "setup sets"}: ${what}.` });
      }
    }

    // Term-defined subscriptions → OrderItem.EndDate (Salesforce bills them with method OrderAmount, which needs an end date).
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const endDate = billingEndDate({
      sellingModelType, current: f.itemEndDate ? sv(r[f.itemEndDate]) : null,
      serviceDate: f.itemServiceDate ? sv(r[f.itemServiceDate]) : null, effectiveDate: sv(o.EffectiveDate), orderEndDate: sv(o.EndDate),
      pricingTerm: f.sellingModelRel && f.sellingModelTerm ? num(rel(r, `${f.sellingModelRel}.PricingTerm`)) : null,
      pricingTermUnit: f.sellingModelRel && f.sellingModelTerm ? sv(rel(r, `${f.sellingModelRel}.PricingTermUnit`)) : null,
      subscriptionTerm: f.itemSubscriptionTerm ? num(r[f.itemSubscriptionTerm]) : null,
      pricingTermCount: f.itemPricingTermCount ? num(r[f.itemPricingTermCount]) : null,
    });
    if (endDate.required) {
      const patch = billingEndDatePatch(endDate);
      if (endDate.invalid) issues.push({ severity: "error", code: endDate.current ? "BILLING_END_DATE_INVALID" : "BILLING_END_DATE_UNRESOLVED", message: `${productName} is a term-defined subscription billed by order amount, which needs a valid end date. ${endDate.invalid} Set the Order Product's End Date in Salesforce.` });
      else if (patch && !f.itemEndDateUpdateable) issues.push({ severity: "error", code: "BILLING_END_DATE_UNAVAILABLE", message: `${productName} needs an End Date (${patch.EndDate}), but this user can't update OrderItem.EndDate — Salesforce rejects the billing schedule ("When the billing method is OrderAmount, the end date can't be null"). Check field access to OrderItem.EndDate.` });
      else if (patch) {
        if (!activated) pending.push("billing-end-date");
        const from = endDate.source === "Term" ? `${endDate.start} + ${endDate.term}` : "the Order End Date";
        issues.push({ severity: "info", code: "BILLING_END_DATE_NOT_SET", message: `Term-defined billing: Salesforce needs an end date for this subscription — ${activated ? "set when billing schedules are requested" : "setup sets"}: End Date → ${patch.EndDate} (from ${from}).` });
      }
    }

    // Order Action (OrderItem → OrderAction).
    const oaId = f.orderAction ? (r[f.orderAction] as string | null) : null;
    const orderAction = oaId ? { id: oaId, name: String(rel(r, `${f.orderActionRel}.Name`) ?? "Order Action"), type: (rel(r, `${f.orderActionRel}.Type`) as string) ?? null } : null;
    if (f.orderAction && !orderAction && !activated) pending.push("order-action");

    // Usage: required only when the product is actually configured for usage.
    const resources = pur.filter(p => p.ProductId === r.Product2Id).map(p => ({ name: String(rel(p, "UsageResource.Name") ?? "Usage Resource"), status: statusText(p.Status) }));
    const usageModel = f.usageModelType ? (rel(r, `Product2.${f.usageModelType}`) as string | null) : null;
    const entitlements = tue.filter(t => t.OrderItemId === r.Id).map(t => ({ id: t.Id as string, name: String(t.Name), resource: String(rel(t, "UsageResource.Name") ?? "") }));
    const usageRequired = resources.length > 0 || !!usageModel;
    let usageState: OrderBillingItem["usage"]["state"] = "not-required";
    let usageReason = "Not usage-based — no Product Usage Resource or usage model on this product.";
    if (usageRequired) {
      const active = resources.filter(x => x.status === "Active");
      if (entitlements.length) { usageState = "generated"; usageReason = `${entitlements.length} usage entitlement(s) generated by Salesforce for this Order Product.`; }
      else if (active.length) { usageState = "configured"; usageReason = `Usage-based: ${active.map(a => a.name).join(", ")}. Salesforce generates the usage entitlements when the order is activated.`; }
      else {
        usageState = "missing";
        usageReason = usageModel && resources.length === 0 ? `${productName} has usage model "${usageModel}" but no Product Usage Resource.` : `${productName}'s Product Usage Resources aren't Active.`;
        issues.push({ severity: "error", message: `Usage-based billing isn't configured: ${usageReason}` });
      }
      if (activated && usageState === "configured") issues.push({ severity: "warning", message: "The order is activated but Salesforce hasn't generated usage entitlements for this Order Product yet." });
    }

    const billingModel = usageRequired ? `Usage-Based${sellingModelType ? ` (${sellingModelType === "OneTime" ? "One-Time" : "Recurring"} base)` : ""}`
      : sellingModelType === "OneTime" ? "One-Time" : sellingModelType === "TermDefined" ? "Recurring (term)" : sellingModelType === "Evergreen" ? "Recurring (evergreen)" : "Unknown";

    // Activated orders: the Order Product is locked, so "fix it before activation" no longer applies.
    if (activated) {
      if (current) {
        // Billed with the treatment it had at activation — today's product config is informational only.
        for (const i of issues) if (i.severity === "error") { i.severity = "warning"; i.message = `Informational (order already activated with "${current.name}"): ${i.message}`; }
      } else if (f.treatment) {
        for (const i of issues) if (i.severity === "error") i.severity = "warning";
        issues.push({ severity: "warning", message: "Activated without a Billing Treatment on this Order Product — Salesforce doesn't generate a billing schedule for it, and an activated order's products can't be changed." });
      }
    }

    const hasError = issues.some(i => i.severity === "error");
    const status: ItemStatus = hasError ? "BLOCKED"
      : activated && (tState === "set" || tState === "conflict") && orderAction && !issues.some(i => i.severity === "warning" && /Activated without/.test(i.message)) ? "ALREADY_CONFIGURED"
      : activated ? "WARNING"
      : pending.length ? "ACTION_REQUIRED"
      : issues.some(i => i.severity === "warning") ? "WARNING"
      : activated ? "ALREADY_CONFIGURED" : "READY";

    return {
      id: r.Id as string,
      product: r.Product2Id ? { id: r.Product2Id as string, name: productName, code: (rel(r, "Product2.ProductCode") as string) ?? null } : null,
      quantity: (r.Quantity as number) ?? null, totalPrice: f.totalPrice ? ((r[f.totalPrice] as number) ?? null) : null,
      sellingModelType, billingFrequency: f.frequency ? ((r[f.frequency] as string) ?? null) : null, billingModel,
      policy: chain, chainChecks,
      treatment: { current, expected, state: tState },
      tax, sellingModel,
      orderAction,
      usage: { required: usageRequired, reason: usageReason, resources, entitlements, state: usageState },
      status, issues, pendingActions: pending,
      legalEntityId: f.itemLegalEntity ? sv(r[f.itemLegalEntity]) : null,
      pricebookEntryId: sv(r.PricebookEntryId),
      billingRequired: !!policyId || !!(f.productTaxPolicy && rel(r, `Product2.${f.productTaxPolicy}`)) || !!currentId || !!(f.taxTreatment && r[f.taxTreatment]),
      billingStartMonth: startMonth,
      billingEndDate: endDate,
    };
  });

  // Billing schedules / groups / invoices — whatever Salesforce generated for this order.
  const scheduleRows = f.hasBillingSchedule && f.scheduleRef
    ? await q(client, `SELECT Id, BillingScheduleNumber, Status, BillingScheduleStartDate, BillingScheduleEndDate, BillingTermUnit, TotalAmount, NextBillingDate, BillingScheduleGroupId, BillingScheduleGroup.BillingScheduleGroupNumber, BillingScheduleGroup.Product2.Name, BillingTreatmentItem.Name FROM BillingSchedule WHERE ${f.scheduleRef} = '${soqlEscape(orderId)}' ORDER BY BillingScheduleNumber`).catch(() => [])
    : [];
  const scheduleIds = scheduleRows.map(s => s.Id as string);
  const lines = f.invoiceLineSchedule && scheduleIds.length
    ? await q(client, `SELECT InvoiceId, ${f.invoiceLineSchedule} FROM InvoiceLine WHERE ${f.invoiceLineSchedule} IN (${idList(scheduleIds)})`).catch(() => [])
    : [];
  const invoicedSchedules = new Set(lines.map(l => String(l[f.invoiceLineSchedule!]).slice(0, 15)));
  const invoiceIds = [...new Set(lines.map(l => l.InvoiceId as string))];
  const invoiceRows = f.hasInvoice && invoiceIds.length
    ? await q(client, `SELECT Id, DocumentNumber, Status, TotalAmountWithTax, Balance, InvoiceDate FROM Invoice WHERE Id IN (${idList(invoiceIds)}) ORDER BY CreatedDate DESC`).catch(() => [])
    : [];

  const jobRows = f.hasAsyncTracker
    ? await q(client, `SELECT Id, AsyncOperationNumber, Status, JobType, CreatedDate, FinishedAt, FailedJobItems, Response FROM AsyncOperationTracker WHERE ReferenceEntityId = '${soqlEscape(orderId)}' ORDER BY CreatedDate DESC LIMIT 10`).catch(() => [])
    : [];
  const jobs = jobRows.map(j => ({
    id: j.Id as string, number: (j.AsyncOperationNumber as string) ?? null, status: (j.Status as string) ?? null, jobType: (j.JobType as string) ?? null,
    createdDate: (j.CreatedDate as string) ?? null, finishedAt: (j.FinishedAt as string) ?? null, failedItems: (j.FailedJobItems as number) ?? null,
    response: typeof j.Response === "string" ? j.Response.slice(0, 2000) : null,
  }));

  const schedules = scheduleRows.map(s => ({
    id: s.Id as string, number: String(s.BillingScheduleNumber), status: (s.Status as string) ?? null,
    start: (s.BillingScheduleStartDate as string) ?? null, end: (s.BillingScheduleEndDate as string) ?? null,
    term: (s.BillingTermUnit as string) ?? null, amount: (s.TotalAmount as number) ?? null, nextBillingDate: (s.NextBillingDate as string) ?? null,
    groupId: (s.BillingScheduleGroupId as string) ?? null, product: (rel(s, "BillingScheduleGroup.Product2.Name") as string) ?? null,
    treatmentItem: (rel(s, "BillingTreatmentItem.Name") as string) ?? null, invoiced: invoicedSchedules.has((s.Id as string).slice(0, 15)),
  }));
  // Tax propagation & invoice tax (only for orders whose products carry tax configuration).
  let scheduleTaxError: string | null = null;
  if (needsTax && schedules.length) {
    try {
      const st = await readScheduleTreatments(client, schedules.map(s => s.id));
      for (const s of schedules) { const x = st.find(y => y.id === s.id); Object.assign(s, { taxTreatment: x?.treatment ?? null, orderItemId: x?.orderItemId ?? null }); }
      for (const b of scheduleTreatmentBlockers(items, st)) items.find(i => i.id === b.orderItemId)?.issues.push({ severity: "warning", code: b.code, message: `Tax: ${b.message}` });
    } catch (e) { scheduleTaxError = e instanceof Error ? e.message : String(e); }
  }
  const groupMap = new Map<string, string>();
  for (const s of scheduleRows) if (s.BillingScheduleGroupId) groupMap.set(s.BillingScheduleGroupId as string, String(rel(s, "BillingScheduleGroup.BillingScheduleGroupNumber") ?? s.BillingScheduleGroupId));
  const invoices = invoiceRows.map(i => ({
    id: i.Id as string, number: (i.DocumentNumber as string) ?? null, status: (i.Status as string) ?? null,
    // Invoice.TotalAmountWithTax only — Invoice.TotalAmount is the PRE-tax amount on taxed invoices (p10 DOC-000000019/21: 10000
    // vs 11800), so it's never a fallback for the total. Missing → null (shown as "—").
    amount: invoiceTotalWithTax(i), balance: (i.Balance as number) ?? null, invoiceDate: (i.InvoiceDate as string) ?? null,
    scheduleIds: lines.filter(l => l.InvoiceId === i.Id).map(l => String(l[f.invoiceLineSchedule!])),
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "Invoice", i.Id as string),
    tax: null as NonNullable<OrderBillingState["invoices"][number]["tax"]> | null,
  }));
  if (needsTax) for (const inv of invoices) {
    const v = await verifyInvoiceTax(client, inv.id);
    inv.tax = { state: v.state, message: v.derivation.message, totalTax: v.invoice?.tax ?? null, totalWithTax: v.invoice?.totalWithTax ?? null, invoiceLineTax: (v.invoice?.lines ?? []).flatMap(l => l.taxes.map(x => ({ id: x.id, amount: x.amount, rate: x.rate, code: x.code }))) };
  }

  const accountContacts = f.billTo && o.AccountId
    ? (await q(client, `SELECT Id, Name, Email FROM Contact WHERE AccountId = '${soqlEscape(o.AccountId as string)}' ORDER BY Name LIMIT 50`).catch(() => [])).map(c => ({ id: c.Id as string, name: String(c.Name), email: (c.Email as string) ?? null }))
    : [];
  const billToSet = !f.billTo || !!o[f.billTo];
  const orderAddress = addressOf(o);
  const shippingAddress = addressOf(o, "Shipping");
  const addressSet = addressComplete(orderAddress);
  const shippingSet = addressComplete(shippingAddress);
  const addressSuggestions: OrderBillingState["addressSuggestions"] = [];
  if ((!addressSet || !shippingSet) && o.AccountId) {
    const seen = new Set<string>();
    const add = (source: string, a: BillingAddress | null) => { const key = a && addressKey(withGeoCodes(a, geo)); if (a && key && addressComplete(a) && !seen.has(key)) { seen.add(key); addressSuggestions.push({ source, address: a }); } };
    if (orderAddress && addressSet) add("This order's billing address", orderAddress);
    if (shippingAddress && shippingSet) add("This order's shipping address", shippingAddress);
    const acctName = String(rel(o, "Account.Name") ?? "");
    const [acct] = await q(client, `SELECT ${addressSelect("Billing")}, ${addressSelect("Shipping")} FROM Account WHERE Id = '${soqlEscape(o.AccountId as string)}'`).catch(() => []);
    if (acct) { add(`Account ${acctName} billing address`, addressOf(acct)); add(`Account ${acctName} shipping address`, addressOf(acct, "Shipping")); }
    if (f.billTo && o[f.billTo]) {
      const [c] = await q(client, `SELECT Name, ${addressSelect("Mailing")} FROM Contact WHERE Id = '${soqlEscape(o[f.billTo] as string)}'`).catch(() => []);
      if (c) add(`Contact ${String(c.Name)} mailing address`, addressOf(c, "Mailing"));
    }
    const prev = await q(client, `SELECT OrderNumber, ${addressSelect("Billing")}, ${addressSelect("Shipping")} FROM Order WHERE AccountId = '${soqlEscape(o.AccountId as string)}' AND Id != '${soqlEscape(orderId)}' AND (BillingCity != null OR ShippingCity != null) ORDER BY CreatedDate DESC LIMIT 10`).catch(() => []);
    for (const p of prev) { add(`Previous order ${String(p.OrderNumber)} billing address (same Account)`, addressOf(p)); add(`Previous order ${String(p.OrderNumber)} shipping address (same Account)`, addressOf(p, "Shipping")); }
  }

  // Readiness (server-side; re-run before every mutation).
  const checks: OrderBillingState["readiness"]["checks"] = [];
  const blockers: string[] = [];
  const check = (id: string, label: string, ok: boolean | "pending" | "warning", detail?: string) => {
    checks.push({ id, label, status: ok === true ? "passed" : ok === "pending" ? "pending" : ok === "warning" ? "warning" : "failed", detail });
    if (ok === false && detail) blockers.push(detail);
  };
  check("order", "Order exists", true, String(o.OrderNumber ?? o.Id));
  check("eligible", "Order is eligible for activation", activated ? "warning" : o.Status === "Draft" ? true : false, activated ? "Order is already activated." : o.Status === "Draft" ? "Draft" : `Order status "${String(o.Status)}" can't be activated.`);
  check("account", "Order has an Account", !!o.AccountId, o.AccountId ? String(rel(o, "Account.Name")) : "The Order has no Account.");
  check("billTo", "Bill To Contact set", billToSet ? true : "pending", !f.billTo ? "This org's Order has no Bill To Contact field." : billToSet ? String((f.billToRel && rel(o, `${f.billToRel}.Name`)) ?? o[f.billTo]) : "Salesforce requires a Bill To Contact to create billing schedules for this order.");
  check("billingAddress", "Billing Address set", addressSet ? true : "pending", addressSet ? [orderAddress!.street, orderAddress!.city, orderAddress!.country].join(", ") : "Salesforce requires the order's Billing Address (Street, City, Country) to create billing schedules.");
  check("shippingAddress", "Shipping Address set", shippingSet ? true : "pending", shippingSet ? addressText(shippingAddress!) : "Salesforce requires the order's Shipping Address (Street, City, Country) to create billing schedules.");
  check("items", "Order Products found", items.length > 0, items.length ? `${items.length} Order Product(s)` : "The Order has no Order Products.");
  const blockedItems = items.filter(i => i.status === "BLOCKED");
  check("config", "Billing configuration valid", blockedItems.length === 0, blockedItems.length ? blockedItems.map(i => `${i.product?.name ?? "Order Product"}: ${i.issues.find(x => x.severity === "error")?.message}`).join(" | ") : "Product → Billing Policy → Treatment → Item resolved for every Order Product");
  const needAction = items.filter(i => i.pendingActions.includes("order-action"));
  check("orderAction", "Order Actions configured", !f.orderAction ? "warning" : needAction.length ? "pending" : true, !f.orderAction ? "This org has no Order Product → Order Action relationship." : needAction.length ? `${needAction.length} Order Product(s) need an Order Action.` : orderActions.map(a => `${a.name} (${a.type})`).join(", "));
  const needTreatment = items.filter(i => i.pendingActions.includes("billing-treatment"));
  check("treatments", "Order Product Billing Treatments set", !f.treatment ? "warning" : needTreatment.length ? "pending" : true, needTreatment.length ? `${needTreatment.length} Order Product(s) need their Billing Treatment applied.` : "Every Order Product has a Billing Treatment");
  const needTax = items.filter(i => i.pendingActions.includes("tax-treatment"));
  const activatedWithoutTax = activated ? items.filter(i => i.tax.state === "will-set") : [];
  check("taxTreatments", "Order Product Tax Treatments set", !f.taxTreatment ? "warning" : needTax.length ? "pending" : activatedWithoutTax.length ? "warning" : true,
    !f.taxTreatment ? "This org's Order Product has no updateable Tax Treatment field." : activatedWithoutTax.length ? `${activatedWithoutTax.length} Order Product(s) were activated without the Tax Treatment from their product's Tax Policy — Salesforce billed the legal entity's default treatment. Create a new order.` : needTax.length ? `${needTax.length} Order Product(s) need the Tax Treatment from their product's Tax Policy — left blank, Salesforce bills the legal entity's default treatment.` : items.every(i => i.tax.state === "not-applicable" || i.tax.state === "unavailable") ? "No Order Product resolves a Tax Treatment" : "Every Order Product with a Tax Policy has its Tax Treatment");
  const needStartMonth = items.filter(i => i.pendingActions.includes("billing-start-month"));
  const annualItems = items.filter(i => i.billingStartMonth?.required);
  if (annualItems.length) check("billingStartMonth", "Annual billing start month set", needStartMonth.length ? "pending" : true,
    needStartMonth.length ? `${needStartMonth.length} annual Order Product(s) need their Period Boundary / Period Boundary Start Month — Salesforce requires a billing start month for annual billing schedules.` : annualItems.map(i => {
      const b = i.billingStartMonth!; const patch = billingStartMonthPatch(b);
      return `${i.product?.name ?? "Order Product"}: ${patch ? (activated ? `${patch.PeriodBoundary ?? b.boundary} / month ${patch.PeriodBoundaryStartMonth ?? b.current} (set when schedules are requested)` : "unresolved") : b.current ? `${b.boundary ?? "—"} / month ${b.current}` : "unresolved"}`;
    }).join(", "));
  const needEndDate = items.filter(i => i.pendingActions.includes("billing-end-date"));
  const termItems = items.filter(i => i.billingEndDate?.required);
  if (termItems.length) check("billingEndDate", "Subscription billing end dates", termItems.some(i => i.billingEndDate!.invalid) ? false : needEndDate.length ? "pending" : true,
    termItems.map(i => {
      const b = i.billingEndDate!; const patch = billingEndDatePatch(b);
      return `${i.product?.name ?? "Order Product"}: ${b.invalid ? `unresolved — ${b.invalid}` : b.current ? `${b.start ?? "?"} → ${b.current}` : patch ? `${b.start} → ${patch.EndDate} (${activated ? "set when schedules are requested" : "pending"})` : "unresolved"}`;
    }).join(", "));
  // Tax geography: the decision table matches the address values exactly — "India"/"Andhra Pradesh" never match a rate for IN/AP.
  let geoIssues: ReturnType<typeof evaluateTaxGeography> = [];
  if (items.some(i => i.tax.effective?.taxable) && (addressSet || shippingSet)) {
    geoIssues = geo ? [
      ...(addressSet ? evaluateTaxGeography("Billing Address", { country: orderAddress!.country, state: orderAddress!.state }, geo) : []),
      ...(shippingSet ? evaluateTaxGeography("Shipping Address", { country: shippingAddress!.country, state: shippingAddress!.state }, geo) : []),
    ] : [];
    check("taxGeography", "Tax geography (Country/State codes)", !geo ? "warning" : geoIssues.length ? (activated ? "warning" : false) : true,
      !geo ? "This org has no GeoCountry records to check the address against." : geoIssues.length ? `${geoIssues.map(x => x.message).join(" ")}${activated ? " The order is activated — its invoices keep this address." : ""}` : [orderAddress?.country, orderAddress?.state].filter(Boolean).join(" / "));
  }
  // Order.LegalEntityId: set from the (single) legal entity of the taxable treatments during setup, as the verified run does
  // (DOC-000000017). A different value, or treatments with different legal entities, block activation.
  const treatmentLes = [...new Set(items.filter(i => i.tax.effective?.taxable && i.tax.effective.legalEntityId).map(i => i.tax.effective!.legalEntityId!))];
  const needOrderLe = !activated && !!f.orderLegalEntity && !orderLegalEntityId && treatmentLes.length === 1;
  if (f.orderLegalEntity && treatmentLes.length) {
    const mixed = treatmentLes.length > 1;
    check("taxLegalEntity", "Order Legal Entity", mixed ? false : needOrderLe ? "pending" : true,
      mixed ? `The order's taxable products use tax treatments of different legal entities (${treatmentLes.join(", ")}) — split them into separate orders.`
        : needOrderLe ? `Order.LegalEntityId is blank — "Apply" sets it to the tax treatments' legal entity ${treatmentLes[0]}.` : orderLegalEntityId ?? treatmentLes[0]);
  }
  const usageItems = items.filter(i => i.usage.required);
  check("usage", "Usage-Based configuration", usageItems.some(i => i.usage.state === "missing") ? false : true, usageItems.length ? usageItems.map(i => `${i.product?.name}: ${i.usage.state}`).join(", ") : "Not required");
  const ready = !activated && blockers.length === 0 && needAction.length === 0 && needTreatment.length === 0 && needTax.length === 0 && needStartMonth.length === 0 && needEndDate.length === 0 && !needOrderLe && items.length > 0 && o.Status === "Draft" && billToSet && addressSet && shippingSet;

  // Structured blockers: every reason activation is refused, tax ones with their category (never only a sentence).
  const blockerDetails: ReadinessBlocker[] = [];
  if (!activated) {
    for (const i of items) for (const x of i.issues) if (x.severity === "error") blockerDetails.push({ code: x.code ?? "BILLING_CONFIGURATION", category: x.code ? taxIssueCategory(x.code) : "BILLING_NOT_READY", message: x.message, orderItemId: i.id, product: i.product?.name ?? null });
    for (const g of geoIssues) blockerDetails.push({ code: g.code, category: taxIssueCategory(g.code), message: g.message, orderItemId: null, product: null });
    for (const c of checks) if ((c.status === "failed" || c.status === "pending") && !["config", "taxGeography"].includes(c.id)) blockerDetails.push({ code: c.id === "taxTreatments" ? "TAX_TREATMENT_NOT_SET" : c.id === "taxLegalEntity" ? (c.status === "pending" ? "ORDER_LEGAL_ENTITY_NOT_SET" : "TAX_LEGAL_ENTITY_MISMATCH") : `BILLING_${c.id.toUpperCase()}`, category: (c.id === "taxTreatments" || c.id === "taxLegalEntity") && c.status !== "pending" ? "TREATMENT_MISMATCH" : "BILLING_NOT_READY", message: c.detail ?? c.label, orderItemId: null, product: null });
  }
  // Tax status summary: the blockers of a Draft order; for an activated order (its issues are informational — it can't change)
  // the tax problems it was billed with, so an order activated without a treatment never reads "READY".
  const taxCats = activated
    ? items.flatMap(i => i.issues).filter(x => x.code && x.severity !== "info").map(x => taxIssueCategory(x.code!))
    : blockerDetails.filter(b => b.category !== "BILLING_NOT_READY").map(b => b.category as TaxReadinessCategory);
  const taxStatus: OrderBillingState["readiness"]["taxStatus"] = !needsTax ? "NOT_APPLICABLE" : taxCats.includes("TREATMENT_MISMATCH") ? "TREATMENT_MISMATCH" : taxCats[0] ?? "READY";

  // Lifecycle — derived only from Salesforce records.
  const configured = items.length > 0 && blockedItems.length === 0 && (!activated || items.every(i => !!i.treatment.current));
  const allActions = items.length > 0 && needAction.length === 0 && !!f.orderAction;
  const usageDone = usageItems.length === 0 ? "not-required" : usageItems.every(i => i.usage.state === "generated") ? "done" : usageItems.some(i => i.usage.state === "missing") ? "blocked" : activated ? "current" : "done";
  const anyInvoicePosted = invoices.some(i => /posted/i.test(i.status ?? ""));
  // Billing schedule creation — requested explicitly through Salesforce's standard action; never simulated.
  const runningJob = jobs.find(j => /submitted|inprogress/i.test(j.status ?? ""));
  const failedJob = !schedules.length ? jobs.find(j => /failure/i.test(j.status ?? "")) : undefined;
  const untreated = items.filter(i => !i.treatment.current);
  // Annual lines whose billing start month can't be supplied: the action would fail with "Required fields are missing: billingStartMonth".
  const noStartMonth = items.filter(i => i.treatment.current && i.billingStartMonth?.required && (!i.billingStartMonth.current || !i.billingStartMonth.boundary)
    && (!f.periodStartMonth || !f.periodBoundary || !billingStartMonthPatch(i.billingStartMonth)));
  // Term-defined lines whose end date can't be supplied: the action would fail with "When the billing method is OrderAmount, the end date can't be null".
  const noEndDate = items.filter(i => i.treatment.current && i.billingEndDate?.required && (i.billingEndDate.invalid || (!i.billingEndDate.current && (!f.itemEndDateUpdateable || !billingEndDatePatch(i.billingEndDate)))));
  const scheduleCreation: OrderBillingState["scheduleCreation"] = !f.hasScheduleAction
    ? { available: false, reason: `This org doesn't expose Salesforce's "${SCHEDULE_ACTION}" action.` }
    : !activated ? { available: false, reason: "Billing schedules are created after the order is activated." }
    : schedules.length ? { available: false, reason: `${schedules.length} billing schedule(s) already exist for this order.` }
    : runningJob ? { available: false, reason: `Salesforce is processing ${runningJob.number ?? "a job"} (${runningJob.status}).` }
    : !billToSet || !addressSet || !shippingSet ? { available: false, reason: `Complete the order's billing details first (${[!billToSet && "Bill To Contact", !addressSet && "Billing Address", !shippingSet && "Shipping Address"].filter(Boolean).join(", ")}) — Salesforce requires them to create billing schedules.` }
    : untreated.length === items.length ? { available: false, reason: "No Order Product has a Billing Treatment — Salesforce has nothing to schedule." }
    : noStartMonth.length ? { available: false, reason: `Salesforce requires a billing start month for annual billing, and it can't be resolved for ${noStartMonth.map(i => i.product?.name ?? i.id).join(", ")}: ${noStartMonth.map(i => i.issues.find(x => /^BILLING_START_MONTH_/.test(x.code ?? ""))?.message).filter(Boolean)[0] ?? "set the Order Product's Period Boundary Start Month in Salesforce."}` }
    : noEndDate.length ? { available: false, reason: `Salesforce needs a billing end date for term-defined subscriptions, and it can't be determined for ${noEndDate.map(i => i.product?.name ?? i.id).join(", ")}: ${noEndDate.map(i => i.issues.find(x => /^BILLING_END_DATE_/.test(x.code ?? ""))?.message).filter(Boolean)[0] ?? "set the Order Product's End Date in Salesforce."}` }
    : { available: true, reason: untreated.length ? `${untreated.length} Order Product(s) without a Billing Treatment won't get a schedule.` : "Ready — Salesforce will create the billing schedules asynchronously." };

  const lifecycle: OrderBillingState["lifecycle"] = [
    { id: "order", label: "Order Created", status: "done", detail: `${String(o.OrderNumber ?? "")} · ${items.length} Order Product(s)` },
    { id: "config", label: "Billing Configuration", status: configured ? "done" : blockedItems.length || activated ? "blocked" : "current", detail: configured ? "Resolved" : activated ? `${items.filter(i => !i.treatment.current).length} Order Product(s) activated without a Billing Treatment` : `${blockedItems.length} blocked` },
    { id: "action", label: "Order Action", status: allActions ? "done" : activated ? "not-required" : "current", detail: allActions ? orderActions.map(a => a.name).join(", ") : "Not created" },
    { id: "usage", label: "Usage Assignment", status: usageDone as StepStatus, detail: usageItems.length === 0 ? "Not required" : usageItems.map(i => i.usage.state).join(", ") },
    { id: "validation", label: "Billing Validation", status: activated || ready ? "done" : blockers.length ? "blocked" : "pending", detail: activated ? "Passed (order activated)" : ready ? "Ready to activate" : blockers.length ? `${blockers.length} blocker(s)` : "Waiting for setup" },
    { id: "activated", label: "Order Activated", status: activated ? "done" : ready ? "current" : "pending", detail: activated ? `Activated${o.ActivatedDate ? ` ${String(o.ActivatedDate).slice(0, 10)}` : ""}` : "Not activated" },
    { id: "schedule", label: "Billing Schedule", status: schedules.length ? "done" : failedJob ? "blocked" : activated ? "current" : "pending", detail: schedules.length ? `${schedules.length} schedule(s)` : runningJob ? `Processing (${runningJob.status})` : failedJob ? `${failedJob.number ?? "Job"} failed` : activated ? "Not created yet" : "After activation" },
    { id: "invoice", label: "Invoice", status: invoices.length ? (anyInvoicePosted ? "done" : "current") : schedules.length ? "current" : "pending", detail: invoices.length ? invoices.map(i => `${i.number ?? "Invoice"} (${i.status})`).join(", ") : "Not generated" },
    { id: "payment", label: "Payment", status: anyInvoicePosted ? "current" : "pending", detail: anyInvoicePosted ? "Available from the Invoice" : "After the invoice is posted" },
  ];

  // Deterministic: rows and chains sorted by Id (parallel loads / equal CreatedDate must not change the token).
  const byId = <T,>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const tokenSource = JSON.stringify([o.Status, o.LastModifiedDate, o.EndDate, f.billTo ? o[f.billTo] : null, orderAddress ? addressKey(orderAddress) : null, shippingAddress ? addressKey(shippingAddress) : null, rows.map(r => [r.Id as string, [r.SystemModstamp, f.orderAction ? r[f.orderAction] : null, f.treatment ? r[f.treatment] : null, f.taxTreatment ? r[f.taxTreatment] : null, f.periodStartMonth ? r[f.periodStartMonth] : null, f.periodBoundary ? r[f.periodBoundary] : null, f.itemEndDate ? r[f.itemEndDate] : null]] as [string, unknown]).sort(byId), [...chains.entries()].sort(byId).map(([k, v]) => [k, v?.status, v?.defaultTreatment?.id, v?.defaultTreatment?.status, v?.items.map(i => `${i.id}:${i.status}`).sort()])]);

  return {
    success: true,
    order: {
      id: o.Id as string, number: (o.OrderNumber as string) ?? null, name: (o.Name as string) ?? null, status: (o.Status as string) ?? null, activated,
      account: o.AccountId ? { id: o.AccountId as string, name: String(rel(o, "Account.Name") ?? "") } : null,
      effectiveDate: (o.EffectiveDate as string) ?? null, currency: f.currency ? ((o[f.currency] as string) ?? null) : null, totalAmount: (o.TotalAmount as number) ?? null,
      salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "Order", o.Id as string), lastModifiedDate: (o.LastModifiedDate as string) ?? null,
      billToContact: f.billTo && o[f.billTo] ? { id: o[f.billTo] as string, name: String((f.billToRel && rel(o, `${f.billToRel}.Name`)) ?? o[f.billTo]) } : null,
      billToSupported: !!f.billTo, billingAddress: orderAddress, shippingAddress,
      addressLabels: { billing: addressLabels(orderAddress, geo), shipping: addressLabels(shippingAddress, geo) },
    },
    accountContacts, addressSuggestions,
    items, orderActions, schedules, scheduleTaxError, scheduleGroups: [...groupMap.entries()].map(([id, number]) => ({ id, number })), invoices, jobs, scheduleCreation,
    readiness: { ready, checks, blockers, blockerDetails, taxStatus }, lifecycle,
    legalEntityId: orderLegalEntityId, requiresBillingReadiness: items.some(i => i.billingRequired),
    fields: {
      "OrderItem → OrderAction": f.orderAction ? `OrderItem.${f.orderAction}` : null,
      "OrderItem → BillingTreatment": f.treatment ? `OrderItem.${f.treatment}` : null,
      "OrderItem → TaxTreatment": f.taxTreatment ? `OrderItem.${f.taxTreatment}` : null,
      "Product2 → TaxPolicy": f.productTaxPolicy ? `Product2.${f.productTaxPolicy}` : null,
      "Product2 → BillingPolicy": f.productPolicy ? `Product2.${f.productPolicy}` : null,
      "BillingSchedule → Order": f.scheduleRef ? `BillingSchedule.${f.scheduleRef}` : null,
      "InvoiceLine → BillingSchedule": f.invoiceLineSchedule ? `InvoiceLine.${f.invoiceLineSchedule}` : null,
      "Billing frequency": f.frequency ? `OrderItem.${f.frequency}` : null,
      "Billing end date (term-defined)": f.itemEndDate ? `OrderItem.${f.itemEndDate} → BillingTransactionItem.EndDate (OrderAmount)` : null,
      "Billing start month (annual)": f.periodStartMonth && f.periodBoundary ? `OrderItem.${f.periodBoundary} + OrderItem.${f.periodStartMonth} → BillingScheduleGroup.BillingStartMonth` : null,
    },
    stateToken: createHash("sha256").update(tokenSource).digest("hex").slice(0, 24),
  };
}

export type MutationOutcome = { ok: true; state: OrderBillingState; message: string } | { ok: false; status: number; code: string; error: string; possibleCause?: string | null; state?: OrderBillingState; technical?: unknown; blockers?: ReadinessBlocker[] };

function stale(state: OrderBillingState, token: string | null | undefined): MutationOutcome | null {
  if (token && token !== state.stateToken) return { ok: false, status: 409, code: "ORDER_CHANGED", error: "This order (or its products' billing configuration) changed in Salesforce since you reviewed it. The latest state has been loaded — review it and try again.", state };
  return null;
}

/**
 * Apply the billing setup the order still needs — idempotently, in ONE all-or-nothing Composite
 * request: reuse the order's existing "Add" Order Action (or create exactly one), link every Order
 * Product that has none, and set each Order Product's Billing and Tax Treatment from its product's
 * policies where it has none. Existing values are never overwritten; nothing is duplicated.
 */
export async function applyOrderBillingSetup(client: SalesforceClient, orderId: string, input: { operations: OrderSetupOperation[]; stateToken?: string | null }): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, input.stateToken); if (s) return s;
  if (state.order.activated) return { ok: false, status: 409, code: "ORDER_ACTIVATED", error: "This order is already activated — Salesforce doesn't allow changing its Order Products' Order Action or Billing Treatment.", state };
  if (state.order.status !== "Draft") return { ok: false, status: 422, code: "ORDER_NOT_DRAFT", error: `Order status "${state.order.status}" can't be set up for billing.`, state };

  const f = await discoverFields(client);
  const base = `/services/data/v${normalizeApiVersionNumber(client.apiVersion)}`;
  const requests: { method: "POST" | "PATCH"; url: string; referenceId: string; body: Record<string, unknown> }[] = [];
  const patches = new Map<string, Record<string, unknown>>();
  const summary: string[] = [];

  if (input.operations.includes("order-action") && f.orderAction) {
    const targets = state.items.filter(i => i.pendingActions.includes("order-action"));
    if (targets.length) {
      const existing = state.orderActions.find(a => a.type === "Add") ?? null;
      let actionRef: string;
      if (existing) {
        actionRef = existing.id;
        summary.push(`Linked ${targets.length} Order Product(s) to existing Order Action ${existing.name}`);
      } else {
        const oaDescribe = await billingDescribe(client, "OrderAction");
        const typeField = oaDescribe.fields.find(x => x.name === "Type");
        if (!typeField?.picklistValues?.some(p => p.active && p.value === "Add")) return { ok: false, status: 422, code: "ORDER_ACTION_TYPE", error: "This org's Order Action Type picklist has no \"Add\" value.", state };
        requests.push({ method: "POST", url: `${base}/sobjects/OrderAction`, referenceId: "orderAction", body: { OrderId: orderId, Type: "Add" } });
        actionRef = "@{orderAction.id}";
        summary.push(`Created Order Action (Add) and linked ${targets.length} Order Product(s)`);
      }
      for (const t of targets) patches.set(t.id, { ...(patches.get(t.id) ?? {}), [f.orderAction]: actionRef });
    }
  }
  if (input.operations.includes("billing-treatment") && f.treatment) {
    const targets = state.items.filter(i => i.pendingActions.includes("billing-treatment") && i.treatment.expected && i.status !== "BLOCKED");
    for (const t of targets) patches.set(t.id, { ...(patches.get(t.id) ?? {}), [f.treatment]: t.treatment.expected!.id });
    if (targets.length) summary.push(`Applied Billing Treatment to ${targets.length} Order Product(s)`);
  }
  if (input.operations.includes("tax-treatment") && f.taxTreatment) {
    // Explicitly resolved from the product's Tax Policy: Salesforce would otherwise bill the legal entity's treatment.
    const targets = state.items.filter(i => i.pendingActions.includes("tax-treatment") && i.tax.expected && i.status !== "BLOCKED");
    for (const t of targets) patches.set(t.id, { ...(patches.get(t.id) ?? {}), [f.taxTreatment]: t.tax.expected!.id });
    if (targets.length) summary.push(`Applied Tax Treatment to ${targets.length} Order Product(s)`);
    // Order.LegalEntityId ← the single legal entity of the taxable treatments (header field, Draft only, never overwritten).
    const les = [...new Set(state.items.filter(i => i.tax.effective?.taxable && i.tax.effective.legalEntityId).map(i => i.tax.effective!.legalEntityId!))];
    if (f.orderLegalEntity && !state.legalEntityId && les.length === 1) {
      requests.push({ method: "PATCH", url: `${base}/sobjects/Order/${orderId}`, referenceId: "order_le", body: { [f.orderLegalEntity]: les[0] } });
      summary.push(`Set the order's Legal Entity to ${les[0]}`);
    }
  }
  if (input.operations.includes("billing-start-month") && f.periodStartMonth && f.periodBoundary) {
    // Annual lines only, from the line's start date; existing values are never overwritten.
    const targets = state.items.filter(i => i.pendingActions.includes("billing-start-month") && billingStartMonthPatch(i.billingStartMonth) && i.status !== "BLOCKED");
    for (const t of targets) patches.set(t.id, { ...(patches.get(t.id) ?? {}), ...billingStartMonthPatch(t.billingStartMonth)! });
    if (targets.length) summary.push(`Set the billing start month on ${targets.length} annual Order Product(s)`);
  }
  if (input.operations.includes("billing-end-date") && f.itemEndDate && f.itemEndDateUpdateable) {
    // Term-defined lines only, from the line's start + subscription term; an existing End Date is never overwritten.
    const targets = state.items.filter(i => i.pendingActions.includes("billing-end-date") && billingEndDatePatch(i.billingEndDate) && i.status !== "BLOCKED");
    for (const t of targets) patches.set(t.id, { ...(patches.get(t.id) ?? {}), [f.itemEndDate]: billingEndDatePatch(t.billingEndDate)!.EndDate });
    if (targets.length) summary.push(`Set the billing end date on ${targets.length} term-defined Order Product(s)`);
  }
  [...patches.entries()].forEach(([id, body], i) => requests.push({ method: "PATCH", url: `${base}/sobjects/OrderItem/${id}`, referenceId: `item_${i}`, body }));
  if (requests.length === 0) return { ok: true, state, message: "Nothing to apply — the order is already set up." };

  const res = await client.request<{ compositeResponse: { body: unknown; httpStatusCode: number; referenceId: string }[] }>("/composite", { method: "POST", body: JSON.stringify({ allOrNone: true, compositeRequest: requests }) });
  const failures = res.compositeResponse.filter(r => r.httpStatusCode >= 400);
  if (failures.length) {
    const items: SalesforceErrorItem[] = failures.flatMap(x => (Array.isArray(x.body) ? (x.body as SalesforceErrorItem[]) : [{ message: String(x.body) }]));
    const sum = summarizeSalesforceErrors(items, { objectLabel: "Order Product" });
    return { ok: false, status: 400, code: sum.code ?? "SALESFORCE_ERROR", error: `Nothing was saved. ${sum.message}`, possibleCause: sum.possibleCause, state, technical: { requests, response: res.compositeResponse } };
  }
  return { ok: true, state: await loadOrderBilling(client, orderId), message: summary.join(" · ") };
}

/** Full server-side re-validation, then activation through the existing Orders activation logic; re-reads Salesforce afterwards. */
export async function activateOrderForBilling(client: SalesforceClient, orderId: string, stateToken?: string | null): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, stateToken); if (s) return s;
  if (state.order.activated) return { ok: true, state, message: "The order is already activated." };
  if (!state.readiness.ready) {
    const first = state.readiness.blockerDetails[0];
    return { ok: false, status: 422, code: state.readiness.taxStatus !== "READY" && state.readiness.taxStatus !== "NOT_APPLICABLE" ? state.readiness.taxStatus : "BILLING_NOT_READY", error: first?.message ?? state.readiness.blockers[0] ?? "Billing setup isn't complete — apply the pending Order Actions / Billing Treatments first.", state, blockers: state.readiness.blockerDetails };
  }
  const result = await activateOrder(client, orderId, "activate");
  const after = await loadOrderBilling(client, orderId);
  if (!result.success) return { ok: false, status: 422, code: "ACTIVATION_REJECTED", error: result.salesforceError ? `Salesforce rejected activation: ${result.salesforceError}` : result.message, state: after };
  if (!after.order.activated) return { ok: false, status: 500, code: "ACTIVATION_NOT_CONFIRMED", error: "Salesforce accepted the update but the order doesn't show as Activated.", state: after };
  return { ok: true, state: after, message: `Order ${after.order.number} activated.` };
}

/**
 * The ONE activation entry point for every route (Orders API and Revenue Cloud Billing): an order with any product configured for
 * billing or tax is activated only through activateOrderForBilling's full readiness (treatment, legal entity, geography, rate,
 * selling model, billing setup). Only an order whose products have neither a Billing nor a Tax Policy (and no treatments) keeps
 * the plain status transition. If the readiness can't be read, nothing is activated — "couldn't check" never means "not needed".
 */
export async function activateOrderWithReadiness(client: SalesforceClient, orderId: string): Promise<{ success: boolean; attemptedTransition: { from: string | null; to: string } | null; message: string; salesforceError: string | null; code?: string; blockers?: ReadinessBlocker[]; readinessApplied: boolean }> {
  let state: OrderBillingState;
  try { state = await loadOrderBilling(client, orderId); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, attemptedTransition: null, message: `Activation refused — the order's billing and tax readiness couldn't be verified: ${msg}`, salesforceError: msg, code: "READINESS_UNREADABLE", readinessApplied: true };
  }
  if (!state.requiresBillingReadiness) return { ...(await activateOrder(client, orderId, "activate")), readinessApplied: false };
  const out = await activateOrderForBilling(client, orderId);
  if (out.ok) return { success: true, attemptedTransition: { from: state.order.status, to: out.state.order.status ?? "Activated" }, message: out.message, salesforceError: null, readinessApplied: true };
  return { success: false, attemptedTransition: null, message: `Activation refused: ${out.error}`, salesforceError: out.code === "ACTIVATION_REJECTED" ? out.error : null, code: out.code, blockers: out.blockers ?? out.state?.readiness.blockerDetails, readinessApplied: true };
}

/** Set the order's billing details: Order.BillToContactId (must be a Contact of the order's Account) and/or the Order
 * billing address (user-entered or a suggestion from real records). Header fields — allowed before and after activation. */
export async function setOrderBillingDetails(client: SalesforceClient, orderId: string, input: { contactId?: string | null; address?: Partial<BillingAddress> | null; shippingAddress?: Partial<BillingAddress> | null }, stateToken?: string | null): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, stateToken); if (s) return s;
  if (!input.contactId && !input.address && !input.shippingAddress) return { ok: false, status: 400, code: "NOTHING_TO_SET", error: "Provide a Bill To Contact, a Billing Address and/or a Shipping Address.", state };
  const body: Record<string, string | null> = {};
  const summary: string[] = [];
  if (input.contactId) {
    if (!state.order.billToSupported) return { ok: false, status: 422, code: "FIELD_UNAVAILABLE", error: "This org's Order has no updateable Bill To Contact field.", state };
    const contact = state.accountContacts.find(c => c.id === input.contactId || c.id.slice(0, 15) === input.contactId);
    if (!contact) return { ok: false, status: 422, code: "INVALID_CONTACT", error: `Choose a Contact of the order's Account (${state.order.account?.name ?? "none"}).`, state };
    if (state.order.billToContact?.id !== contact.id) { body.BillToContactId = contact.id; summary.push(`Bill To Contact → ${contact.name}`); }
  }
  const orderDescribe = await billingDescribe(client, "Order");
  // Country/State are stored as the org's ISO codes ("canada"/"ontario" → CA/ON) — the tax decision table matches exact values.
  const geo = input.address || input.shippingAddress ? await loadTaxGeoFacts(client).catch(() => null) : null;
  for (const [kind, value] of [["billing", input.address], ["shipping", input.shippingAddress]] as [AddressKind, Partial<BillingAddress> | null | undefined][]) {
    if (!value) continue;
    const fields = addressFields(ADDRESS_PREFIX[kind]);
    const normalizedValue = normalizeGeography({ country: value.country, state: value.state }, geo);
    const a: BillingAddress = { street: null, city: null, state: null, postalCode: null, country: null };
    for (const [k, field] of Object.entries(fields) as [keyof BillingAddress, string][]) {
      const raw = k === "country" || k === "state" ? normalizedValue[k] : value[k];
      const v = typeof raw === "string" ? raw.trim() : "";
      const meta = orderDescribe.fields.find(x => x.name === field);
      if (!meta?.updateable) return { ok: false, status: 422, code: "FIELD_UNAVAILABLE", error: `Order.${field} isn't updateable in this org.`, state };
      if (meta.length && v.length > meta.length) return { ok: false, status: 422, code: "VALUE_TOO_LONG", error: `${ADDRESS_LABEL[kind]}: ${meta.label} is longer than ${meta.length} characters.`, state };
      a[k] = v || null;
    }
    if (!addressComplete(a)) return { ok: false, status: 422, code: "ADDRESS_INCOMPLETE", error: `${ADDRESS_LABEL[kind]} needs at least Street, City and Country.`, state };
    const current = kind === "billing" ? state.order.billingAddress : state.order.shippingAddress;
    if (!current || addressKey(current) !== addressKey(a)) {
      for (const [k, field] of Object.entries(fields) as [keyof BillingAddress, string][]) body[field] = a[k];
      summary.push(`${ADDRESS_LABEL[kind]} → ${addressText(a)}`);
    }
  }
  if (!Object.keys(body).length) return { ok: true, state, message: "Billing details are already set to these values." };
  const res = await client.requestWithDiagnostics(`/sobjects/Order/${orderId}`, { method: "PATCH", body: JSON.stringify(body) });
  if (res.status >= 400) {
    const sum = summarizeSalesforceErrors(Array.isArray(res.json) ? (res.json as SalesforceErrorItem[]) : [{ message: res.rawText ?? res.statusText }], { objectLabel: "Order" });
    return { ok: false, status: 400, code: sum.code ?? "SALESFORCE_ERROR", error: sum.message, possibleCause: sum.possibleCause, state, technical: res.json ?? res.rawText };
  }
  return { ok: true, state: await loadOrderBilling(client, orderId), message: summary.join(" · ") };
}

/**
 * Pure: a diagnosis for the schedule action's "Required fields are missing: x" — which Salesforce record field feeds x. The
 * action takes only the order Id; Salesforce hydrates BillingContext__stdctx from the Order / Order Products, so a missing input is
 * always a blank field on those records.
 */
export function scheduleErrorCause(messages: string[], items: Pick<OrderBillingItem, "product" | "billingFrequency" | "billingStartMonth" | "billingEndDate">[]): string | null {
  if (messages.some(m => /end date can.?t be null/i.test(m))) {
    const term = items.filter(i => i.billingEndDate?.required).map(i => `${i.product?.name ?? "Order Product"} (End Date ${i.billingEndDate!.current ?? "blank"})`);
    return `Salesforce bills term-defined subscriptions with billing method OrderAmount and takes the end date from the Order Product's End Date (BillingContext: OrderItem.EndDate → BillingTransactionItem.EndDate).${term.length ? ` Term-defined Order Products: ${term.join(", ")}.` : ""} Set each one's End Date to the end of its subscription term.`;
  }
  const missing = messages.flatMap(m => /Required fields are missing:\s*(.+)$/i.exec(m)?.[1].split(/[,;]\s*/) ?? []).map(x => x.trim()).filter(Boolean);
  if (!missing.length) return null;
  const annual = items.filter(i => i.billingStartMonth?.required).map(i => `${i.product?.name ?? "Order Product"} (Period Boundary ${i.billingStartMonth!.boundary ?? "blank"}, Start Month ${i.billingStartMonth!.current ?? "blank"})`);
  const known: Record<string, string> = {
    billtocontact: "Order.BillToContactId is blank — set the order's Bill To Contact.",
    billingaddress: "The order's Billing Address (Street, City, Country) is incomplete.",
    shippingaddress: "The order's Shipping Address (Street, City, Country) is incomplete.",
    billingstartmonth: `Salesforce derives the billing start month of annual schedules from the Order Product's Period Boundary and Period Boundary Start Month (BillingContext: OrderItem.PeriodBoundary → PeriodBoundary__std, OrderItem.PeriodBoundaryStartMonth → BillingStartMonth__std).${annual.length ? ` Annual Order Products: ${annual.join(", ")}.` : ""} Check both fields on the annual Order Products.`,
  };
  return missing.map(m => known[m.toLowerCase()] ?? `Salesforce's billing context input "${m}" is blank on the Order or its Order Products.`).join(" ");
}

/** Ask Salesforce to create this activated order's billing schedules (standard action, async). Refused when schedules
 * already exist or a job is still running, so it never duplicates. */
export async function requestOrderBillingSchedules(client: SalesforceClient, orderId: string, stateToken?: string | null): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, stateToken); if (s) return s;
  if (!state.scheduleCreation.available) {
    if (state.schedules.length) return { ok: true, state, message: state.scheduleCreation.reason };
    const code = state.scheduleCreation.reason.includes("billing start month") ? "BILLING_START_MONTH_REQUIRED" : state.scheduleCreation.reason.includes("billing end date") ? "BILLING_END_DATE_REQUIRED" : "SCHEDULES_NOT_AVAILABLE";
    return { ok: false, status: 422, code, error: state.scheduleCreation.reason, state };
  }
  // Annual lines activated without a Period Boundary / Period Boundary Start Month: supply the blank ones (from the line's start
  // date) before Salesforce hydrates them — otherwise the action fails with "Required fields are missing: billingStartMonth".
  // Term-defined lines activated without an End Date likewise get it (start + subscription term) — otherwise "When the billing
  // method is OrderAmount, the end date can't be null". Both go in one all-or-nothing request; existing values are never overwritten.
  const sf = await discoverFields(client);
  const startMonthTargets = sf.periodStartMonth && sf.periodBoundary ? state.items.filter(i => i.treatment.current && billingStartMonthPatch(i.billingStartMonth)) : [];
  const endDateTargets = sf.itemEndDate && sf.itemEndDateUpdateable ? state.items.filter(i => i.treatment.current && billingEndDatePatch(i.billingEndDate)) : [];
  const itemPatches = new Map<string, Record<string, string>>();
  for (const t of startMonthTargets) itemPatches.set(t.id, { ...itemPatches.get(t.id), ...billingStartMonthPatch(t.billingStartMonth)! });
  for (const t of endDateTargets) itemPatches.set(t.id, { ...itemPatches.get(t.id), [sf.itemEndDate!]: billingEndDatePatch(t.billingEndDate)!.EndDate });
  if (itemPatches.size) {
    const base = `/services/data/v${normalizeApiVersionNumber(client.apiVersion)}`;
    const requests = [...itemPatches.entries()].map(([id, body], i) => ({ method: "PATCH", url: `${base}/sobjects/OrderItem/${id}`, referenceId: `item_${i}`, body }));
    const patch = await client.request<{ compositeResponse: { body: unknown; httpStatusCode: number; referenceId: string }[] }>("/composite", { method: "POST", body: JSON.stringify({ allOrNone: true, compositeRequest: requests }) });
    const failures = patch.compositeResponse.filter(r => r.httpStatusCode >= 400);
    if (failures.length) {
      const sum = summarizeSalesforceErrors(failures.flatMap(x => (Array.isArray(x.body) ? (x.body as SalesforceErrorItem[]) : [{ message: String(x.body) }])), { objectLabel: "Order Product" });
      const names = (ts: OrderBillingItem[]) => ts.map(t => t.product?.name ?? t.id).join(", ");
      const what = [startMonthTargets.length && `the billing start month (Period Boundary / Period Boundary Start Month) on ${names(startMonthTargets)}`, endDateTargets.length && `the subscription End Date on ${names(endDateTargets)}`].filter(Boolean).join(" and ");
      return { ok: false, status: 400, code: startMonthTargets.length ? "BILLING_START_MONTH_REQUIRED" : "BILLING_END_DATE_REQUIRED", error: `Salesforce didn't accept ${what}: ${sum.message} Nothing was changed. Set them on the Order Product in Salesforce, then request the schedules again.`, possibleCause: sum.possibleCause, state, technical: { requests, response: patch.compositeResponse } };
    }
  }
  const payload = { inputs: [{ billingTransactionId: orderId }] };
  const endpoint = `/services/data/v${normalizeApiVersionNumber(client.apiVersion)}/actions/standard/${SCHEDULE_ACTION}`;
  if (process.env.NODE_ENV !== "production") console.info(`[billing-schedules] POST ${endpoint} ${JSON.stringify(payload)}`);
  const res = await client.requestWithDiagnostics(`/actions/standard/${SCHEDULE_ACTION}`, { method: "POST", body: JSON.stringify(payload) });
  const out = (Array.isArray(res.json) ? res.json[0] : null) as { isSuccess?: boolean; errors?: { message?: string; statusCode?: string; fields?: string[] }[] | null; outputValues?: { requestId?: string; statusUrl?: string } | null } | null;
  if (res.status >= 400 || !out?.isSuccess) {
    const errs = out?.errors ?? (Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string; fields?: string[] }[]) : []);
    const code = (errs[0] as { statusCode?: string; errorCode?: string })?.statusCode ?? (errs[0] as { errorCode?: string })?.errorCode ?? "SCHEDULE_CREATION_FAILED";
    const messages = errs.map(e => e.message).filter((m): m is string => !!m);
    // Sanitized: endpoint, status, Salesforce code and field-level messages only — never headers or tokens.
    console.error(`[billing-schedules] ${SCHEDULE_ACTION} failed for order ${orderId}: HTTP ${res.status} ${code} — ${JSON.stringify(errs.map(e => ({ message: e.message, fields: e.fields ?? [] })))}`);
    return { ok: false, status: res.status >= 400 ? res.status : 422, code, error: `Salesforce didn't accept the billing schedule request: ${messages.join("; ") || res.statusText}`, possibleCause: scheduleErrorCause(messages, state.items), state, technical: { endpoint, payload, response: res.json ?? res.rawText } };
  }
  return { ok: true, state: await loadOrderBilling(client, orderId), message: `${startMonthTargets.length ? `Set the billing start month on ${startMonthTargets.length} annual Order Product(s). ` : ""}${endDateTargets.length ? `Set the subscription End Date on ${endDateTargets.map(t => `${t.product?.name ?? t.id} (${billingEndDatePatch(t.billingEndDate)!.EndDate})`).join(", ")}. ` : ""}Salesforce accepted the billing schedule request${out.outputValues?.requestId ? ` (request ${out.outputValues.requestId})` : ""} — schedules are created asynchronously; use Refresh Billing Status.` };
}

/**
 * Pure: does each billing schedule carry the tax treatment of its order product? Salesforce copies OrderItem.TaxTreatmentId to the
 * schedule and from there to the invoice line; a blank order-product treatment becomes the legal entity's fallback (p10 BS-000000018
 * → DOC-000000014, no tax). Invoicing such a schedule can only produce an untaxed invoice, so it is a blocker.
 */
export function scheduleTreatmentBlockers(items: OrderBillingItem[], schedules: { id: string; number: string | null; orderItemId: string | null; treatment: { id: string; name: string } | null; taxable: boolean | null }[]): ReadinessBlocker[] {
  const id15 = (x: string | null | undefined) => (x ?? "").slice(0, 15);
  const out: ReadinessBlocker[] = [];
  for (const s of schedules) {
    const item = items.find(i => id15(i.id) === id15(s.orderItemId));
    if (!item) continue;
    const label = `Billing schedule ${s.number ?? s.id}`;
    if (item.tax.current && id15(s.treatment?.id) !== id15(item.tax.current.id)) out.push({ code: "TAX_TREATMENT_NOT_APPLIED", category: "TREATMENT_MISMATCH", orderItemId: item.id, product: item.product?.name ?? null, message: `${label} carries tax treatment "${s.treatment?.name ?? "none"}", but its order product carries "${item.tax.current.name}" — Salesforce didn't propagate it.` });
    else if (!item.tax.current && item.tax.effective?.taxable) out.push({ code: "TAX_TREATMENT_NOT_APPLIED", category: "TREATMENT_MISMATCH", orderItemId: item.id, product: item.product?.name ?? null, message: `${label} carries "${s.treatment?.name ?? "no tax treatment"}"${s.taxable === false ? " (not taxable)" : ""} because the order product was activated without a Tax Treatment — ${item.product?.name ?? "the product"}'s tax policy selects "${item.tax.expected?.name ?? "a taxable treatment"}". An invoice from it gets no tax; create a new order.` });
  }
  return out;
}

/** Pure: the order products' tax errors (and unreadable tax records) that keep an invoice from being generated. */
export function invoiceTaxBlockers(items: Pick<OrderBillingItem, "id" | "product" | "tax" | "issues">[]): ReadinessBlocker[] {
  const out: ReadinessBlocker[] = [];
  for (const i of items) {
    const product = i.product?.name ?? null;
    if (i.tax.state === "unavailable") {
      for (const x of i.issues.filter(x => x.code === "TAX_RECORDS_UNREADABLE")) out.push({ code: "TAX_RECORDS_UNREADABLE", category: "TAX_RECORDS_UNREADABLE", orderItemId: i.id, product, message: `${product ?? "Order product"}: ${x.message.replace(/^Tax: /, "")}` });
      continue;
    }
    for (const x of i.tax.issues.filter(x => x.severity === "error")) out.push({ code: x.code, category: taxIssueCategory(x.code), orderItemId: i.id, product, message: `${product ?? "Order product"}: ${x.message}` });
  }
  return out;
}

export async function generateOrderInvoices(client: SalesforceClient, orderId: string, stateToken?: string | null): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, stateToken); if (s) return s;
  if (!state.order.activated) return { ok: false, status: 422, code: "ORDER_NOT_ACTIVATED", error: "Activate the order first — invoices are generated from its billing schedules.", state };
  const pending = state.schedules.filter(x => !x.invoiced && /readyforinvoicing|ready for invoicing/i.test(x.status ?? ""));
  if (!state.schedules.length) return { ok: false, status: 422, code: "NO_SCHEDULES", error: "Salesforce hasn't generated billing schedules for this order yet.", state };
  if (!pending.length) {
    const processing = state.schedules.filter(x => !x.invoiced && /processing/i.test(x.status ?? ""));
    if (processing.length) return { ok: false, status: 409, code: "SCHEDULES_PROCESSING", error: `Salesforce is still processing ${processing.length} billing schedule(s) — use Refresh Billing Status and try again.`, state };
    const notReady = state.schedules.filter(x => !x.invoiced);
    if (notReady.length) return { ok: false, status: 422, code: "SCHEDULES_NOT_READY", error: `${notReady.length} billing schedule(s) aren't Ready for Invoicing (${[...new Set(notReady.map(x => x.status))].join(", ")}).`, state };
    return { ok: true, state, message: "Every billing schedule is already invoiced." };
  }
  // Unresolved tax readiness on an order product (no or several matching rates, a treatment Salesforce can't be shown to apply,
  // unreadable tax records…): an invoice generated now could only be untaxed or wrongly taxed, so it isn't generated.
  const taxBlockers = invoiceTaxBlockers(state.items);
  if (taxBlockers.length) return { ok: false, status: 422, code: "TAX_NOT_READY", error: `The invoice isn't generated — tax isn't ready: ${taxBlockers[0].message}${taxBlockers.length > 1 ? ` (+${taxBlockers.length - 1} more)` : ""}`, state, blockers: taxBlockers };
  // Tax propagation: OrderItem.TaxTreatmentId → BillingSchedule.TaxTreatmentId, read from Salesforce before anything is invoiced.
  if (state.items.some(i => i.tax.state !== "unavailable" && (i.tax.current || i.tax.expected))) {
    let blockers: ReadinessBlocker[];
    try { blockers = scheduleTreatmentBlockers(state.items, await readScheduleTreatments(client, pending.map(p => p.id))); }
    catch (e) { return { ok: false, status: 502, code: "TAX_RECORDS_UNREADABLE", error: `The billing schedules' tax treatments couldn't be read from Salesforce (${e instanceof Error ? e.message : String(e)}) — the invoice isn't generated until they can be verified.`, state }; }
    if (blockers.length) return { ok: false, status: 422, code: "TREATMENT_MISMATCH", error: blockers[0].message, state, blockers };
  }
  const res = await client.requestWithDiagnostics("/commerce/invoicing/invoices/collection/actions/generate", {
    method: "POST", body: JSON.stringify({ billingScheduleIds: pending.map(p => p.id), action: "Draft", invoiceDate: new Date().toISOString().slice(0, 10), targetDate: new Date().toISOString().slice(0, 10) }),
  });
  const json = res.json as { success?: boolean; errors?: { message?: string; errorCode?: string }[]; message?: string } | { message?: string; errorCode?: string }[] | null;
  const errs = Array.isArray(json) ? json : json && json.success === false ? json.errors ?? [] : [];
  if (res.status >= 400 || errs.length) {
    return { ok: false, status: res.status >= 400 ? res.status : 422, code: (errs[0] as { errorCode?: string })?.errorCode ?? "INVOICE_GENERATION_FAILED", error: `Salesforce didn't generate the invoice: ${errs.map(e => e.message).filter(Boolean).join("; ") || res.statusText}`, state, technical: res.json ?? res.rawText };
  }
  return { ok: true, state: await loadOrderBilling(client, orderId), message: `Invoice generation requested for ${pending.length} billing schedule(s).` };
}

/** Post a Draft invoice of this order through Salesforce's invoicing API. */
export async function postOrderInvoice(client: SalesforceClient, orderId: string, invoiceId: string, stateToken?: string | null, opts: { allowUnverifiedTax?: boolean } = {}): Promise<MutationOutcome> {
  const state = await loadOrderBilling(client, orderId);
  const s = stale(state, stateToken); if (s) return s;
  const inv = state.invoices.find(i => i.id.slice(0, 15) === invoiceId.slice(0, 15));
  if (!inv) return { ok: false, status: 404, code: "INVOICE_NOT_ON_ORDER", error: "That invoice doesn't belong to this order's billing schedules.", state };
  if (/posted/i.test(inv.status ?? "")) return { ok: true, state, message: `Invoice ${inv.number} is already posted.` };
  if (!/^draft$/i.test(inv.status ?? "")) return { ok: false, status: 422, code: "INVOICE_NOT_DRAFT", error: `Invoice ${inv.number} is ${inv.status} — only Draft invoices can be posted.`, state };
  // Posting is final: only an invoice whose tax Salesforce verifiably applied (InvoiceLineTax on every taxable line) or verifiably
  // didn't need (non-taxable configuration) is posted. Anything else is blocked unless the caller explicitly accepts it.
  const tax = await verifyInvoiceTax(client, inv.id);
  const gate = invoicePostingGate(tax, { allowUnverifiedTax: opts.allowUnverifiedTax === true });
  if (!gate.allowed) {
    return { ok: false, status: 409, code: gate.code, error: gate.error, state, technical: { taxState: tax.state, reason: tax.derivation.reason, diagnostics: gate.findings } };
  }
  // One posting request per invoice at a time (double clicks, two tabs): the second is refused, never sent to Salesforce.
  const lockKey = `${client.instanceUrl}#${inv.id}`;
  if (postingInFlight.has(lockKey)) return { ok: false, status: 409, code: "INVOICE_POST_IN_PROGRESS", error: `A posting request for invoice ${inv.number} is already running — wait for it, then use Refresh Billing Status.`, state };
  postingInFlight.add(lockKey);
  try {
    const res = await client.requestWithDiagnostics(INVOICE_POST_PATH, { method: "POST", body: JSON.stringify({ invoiceIds: [inv.id] }) });
    const failure = invoicePostFailure(res, client.apiVersion);
    if (failure) return { ...failure, state };
    // Salesforce accepted the request — report the invoice's status as Salesforce now has it, never an assumed "Posted".
    const after = await loadOrderBilling(client, orderId);
    const now = after.invoices.find(i => i.id === inv.id);
    return { ok: true, state: after, message: invoicePostedMessage(inv.number ?? inv.id, now?.status ?? null) };
  } finally {
    postingInFlight.delete(lockKey);
  }
}

/** Salesforce Revenue Cloud Billing "post draft invoices" Connect resource (relative to the client's /services/data/vXX.X). */
export const INVOICE_POST_PATH = "/commerce/invoicing/invoices/collection/actions/post";
const postingInFlight = new Set<string>();

type SfErr = { message?: string; errorCode?: string };
/**
 * Pure: the outcome of Salesforce's response to the post request, or null when Salesforce accepted it. Salesforce's own status,
 * errorCode, message and raw body are preserved; a 404 is never a success.
 */
export function invoicePostFailure(res: { url: string; status: number; statusText: string; json: unknown; rawText: string }, apiVersion: string): Extract<MutationOutcome, { ok: false }> | null {
  const json = res.json as { success?: boolean; errors?: SfErr[] } | SfErr[] | null;
  const errs: SfErr[] = Array.isArray(json) ? json : json && json.success === false ? json.errors ?? [] : [];
  if (res.status < 400 && !errs.length) return null;
  const code = errs.find(e => e.errorCode)?.errorCode ?? (res.status === 404 ? "NOT_FOUND" : "INVOICE_POST_FAILED");
  const sfMessage = errs.map(e => e.message).filter(Boolean).join("; ") || res.rawText.slice(0, 500) || res.statusText || `HTTP ${res.status}`;
  return {
    ok: false, status: res.status >= 400 ? res.status : 422, code,
    error: `Salesforce didn't post the invoice (HTTP ${res.status}${code ? ` ${code}` : ""}): ${sfMessage}`,
    possibleCause: res.status === 404
      ? `Salesforce reported that the invoice posting resource doesn't exist at API ${apiVersion} for this user. Check that Revenue Cloud Billing invoicing is enabled in this org and that the user has the Billing Operations permissions.`
      : null,
    technical: { endpoint: `POST ${res.url}`, apiVersion, httpStatus: res.status, salesforceErrors: errs, rawBody: res.json ?? res.rawText },
  };
}

/** Pure: the success message, stated from the invoice status read back from Salesforce after the request. */
export function invoicePostedMessage(number: string, status: string | null): string {
  if (status && /^posted$/i.test(status)) return `Invoice ${number} is Posted in Salesforce.`;
  if (status && /progress/i.test(status)) return `Salesforce accepted the posting request — invoice ${number} is ${status}. Use Refresh Billing Status until it shows Posted.`;
  return `Salesforce accepted the posting request, but invoice ${number} still reads ${status ?? "an unknown status"} — use Refresh Billing Status; it isn't Posted until Salesforce says so.`;
}

/** Read-only: the Order (and billing schedules) behind a billing schedule or an invoice — for "View Order" navigation. */
export async function findOrderContext(client: SalesforceClient, input: { scheduleId?: string | null; invoiceId?: string | null }): Promise<{ orderId: string | null; orderNumber: string | null; scheduleIds: string[]; invoices: { id: string; number: string | null }[] }> {
  const f = await discoverFields(client);
  let orderId: string | null = null;
  let scheduleIds: string[] = [];
  if (input.invoiceId && SALESFORCE_ID.test(input.invoiceId)) {
    const [inv] = await q(client, `SELECT ReferenceEntityId FROM Invoice WHERE Id = '${soqlEscape(input.invoiceId)}'`).catch(() => []);
    // Polymorphic (Order/Quote/…): keep it only if it really is an Order.
    if (typeof inv?.ReferenceEntityId === "string") {
      const [isOrder] = await q(client, `SELECT Id FROM Order WHERE Id = '${soqlEscape(inv.ReferenceEntityId)}'`).catch(() => []);
      if (isOrder) orderId = inv.ReferenceEntityId;
    }
    if (f.invoiceLineSchedule) {
      const lines = await q(client, `SELECT ${f.invoiceLineSchedule} FROM InvoiceLine WHERE InvoiceId = '${soqlEscape(input.invoiceId)}' AND ${f.invoiceLineSchedule} != null`).catch(() => []);
      scheduleIds = [...new Set(lines.map(l => String(l[f.invoiceLineSchedule!])))];
    }
  }
  let invoices: { id: string; number: string | null }[] = [];
  if (input.scheduleId && SALESFORCE_ID.test(input.scheduleId)) {
    scheduleIds = [input.scheduleId, ...scheduleIds.filter(x => x !== input.scheduleId)];
    // The invoices this billing schedule was billed on (InvoiceLine → BillingSchedule).
    if (f.invoiceLineSchedule) {
      const lines = await q(client, `SELECT InvoiceId, Invoice.DocumentNumber FROM InvoiceLine WHERE ${f.invoiceLineSchedule} = '${soqlEscape(input.scheduleId)}'`).catch(() => []);
      invoices = [...new Map(lines.map(l => [l.InvoiceId as string, { id: l.InvoiceId as string, number: (rel(l, "Invoice.DocumentNumber") as string) ?? null }])).values()];
    }
  }
  if (!orderId && scheduleIds.length && f.scheduleRef) {
    const rows = await q(client, `SELECT ${f.scheduleRef} FROM BillingSchedule WHERE Id IN (${idList(scheduleIds)})`).catch(() => []);
    orderId = (rows.map(r => r[f.scheduleRef!]).find(v => typeof v === "string") as string | undefined) ?? null;
  }
  const [o] = orderId ? await q(client, `SELECT OrderNumber FROM Order WHERE Id = '${soqlEscape(orderId)}'`).catch(() => []) : [];
  return { orderId: o ? orderId : null, orderNumber: (o?.OrderNumber as string) ?? null, scheduleIds, invoices };
}
