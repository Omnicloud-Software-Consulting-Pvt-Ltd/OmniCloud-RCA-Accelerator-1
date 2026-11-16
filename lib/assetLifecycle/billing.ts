import type { BillingDetails, BillingNeed, LifecycleTransaction, PolicyResolution, PostalAddress, TreatmentResolution } from "./types";

/**
 * Billing readiness for a lifecycle order — PURE decisions (no Salesforce calls). The prepare-billing step feeds it a snapshot read
 * from the org (the app's Order Setup readiness: Product → Billing Policy → Treatment → Item, Bill-To, addresses) plus the order's
 * pricing state, and runs the ONE next action it returns, then re-reads and asks again until the order is ready, waiting, blocked or
 * a user decision is needed. Facts this is built on (read from a live org, 2026-11-12):
 *  · createOrderFromQuote creates the lifecycle order UNPRICED (Order.CalculationStatus CompletedWithoutPricing, no
 *    OrderItem.BillingTreatmentId); every lifecycle order that activated had been re-priced on the order first, and that pricing is
 *    what stamped OrderItem.BillingTreatmentId (the policy's default treatment). Activation of unpriced orders was refused
 *    ("prices aren't currently up to date … Reprice All", "Billing Treatment").
 *  · The Billing Policy is a PRODUCT setting (Product2.BillingPolicyId) — shared by every order of that product; OrderItem carries only
 *    BillingTreatmentId (the Billing Treatment Item belongs to the treatment, there is no order-product field for it).
 */

export interface BillingItemSnapshot {
  id: string;
  product: { id: string; name: string } | null;
  /** The product's Billing Policy (Product2 field) — null when none is assigned. */
  policy: { id: string; name: string } | null;
  /** Failed checks of the policy chain (policy / default treatment / item inactive …) — the policy itself must be fixed. */
  policyErrors: string[];
  treatment: { id: string; name: string } | null;
  /** What Order Setup would stamp (the policy's default treatment), when resolvable. */
  expectedTreatment: { id: string; name: string } | null;
  /** Order Setup operations still to apply on this line (order-action, billing-treatment, tax-treatment, billing-start-month, billing-end-date). */
  pendingActions: string[];
}
export interface OrderBillingSnapshot {
  orderId: string; orderNumber: string | null; status: string | null; activated: boolean;
  billToContact: { id: string; name: string } | null;
  billingAddress: PostalAddress | null; shippingAddress: PostalAddress | null;
  items: BillingItemSnapshot[];
  /** Some product has billing configuration → Salesforce billing readiness applies to the whole order. */
  requiresBilling: boolean;
  ready: boolean;
  blockers: { message: string; orderItemId: string | null; product: string | null }[];
  stateToken: string | null;
}
export interface OrderPricing { calculationStatus: string | null; lastPricedDate: string | null }

export type BillingAction =
  | { type: "set-details"; input: { contactId?: string; address?: PostalAddress; shippingAddress?: PostalAddress }; hash: string; summary: string }
  | { type: "assign-policy"; resolution: PolicyResolution }
  | { type: "reprice"; reason: string }
  | { type: "apply-setup"; operations: string[]; summary: string }
  | { type: "set-treatment"; resolution: TreatmentResolution; item: BillingItemSnapshot }
  | { type: "needs"; needs: BillingNeed[] }
  | { type: "blocked"; message: string }
  | { type: "ready"; summary: string[] };

export const PRICED = /^CompletedWithPricing$/i;
export const PRICING_BUSY = /InProgress|Queued|Saving|Waiting|Submitted|Pending/i;
export const PRICING_FAILED = /Failed|Failure|Error/i;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
const t = (v: string | null | undefined) => (v ?? "").trim();

/** Street, City and Country — what Salesforce's billing schedule creation requires of the order's addresses. */
export const addressComplete = (a: PostalAddress | null | undefined): a is PostalAddress => !!a && !!t(a.street) && !!t(a.city) && !!t(a.country);
export const addressText = (a: PostalAddress | null | undefined) => (a ? [a.street, a.city, a.state, a.postalCode, a.country].map(t).filter(Boolean).join(", ") : "");
export function cleanAddress(a: Partial<PostalAddress> | null | undefined): PostalAddress | null {
  if (!a) return null;
  const x: PostalAddress = { street: t(a.street) || null, city: t(a.city) || null, state: t(a.state) || null, postalCode: t(a.postalCode) || null, country: t(a.country) || null };
  return Object.values(x).some(Boolean) ? x : null;
}
/** Stable fingerprint of the billing details (detects "changed since written" without comparing Salesforce's normalised values). */
export const billingHash = (b: BillingDetails | null | undefined) => (b ? JSON.stringify([b.billToContactId?.slice(0, 15) ?? null, addressText(b.billingAddress), addressText(b.shippingAddress)]) : null);

/** Problems with the billing details entered on the form (empty = valid). Required: Bill-To Contact, complete billing + shipping address. */
export function validateBillingDetails(b: BillingDetails | null | undefined): string[] {
  const out: string[] = [];
  if (!b?.billToContactId) out.push("Choose the Bill-To Contact (a contact of the account) — Salesforce needs it to bill the order.");
  if (!addressComplete(b?.billingAddress)) out.push("Enter the Billing Address (at least Street, City and Country).");
  if (!addressComplete(b?.shippingAddress)) out.push("Enter the Shipping Address (at least Street, City and Country).");
  return out;
}

/** The order's prices are current: Salesforce priced it (not just created it) and billing readiness changed nothing since. */
export function orderPriced(p: OrderPricing, changedSincePricing: boolean | null | undefined): boolean {
  return PRICED.test(p.calculationStatus ?? "") && !!p.lastPricedDate && !changedSincePricing;
}
/** A re-pricing WE requested at `requestedAt` (app clock) has been saved by Salesforce (small tolerance for clock skew). */
export const pricedSince = (p: OrderPricing, requestedAt: string) => PRICED.test(p.calculationStatus ?? "") && !!p.lastPricedDate && Date.parse(p.lastPricedDate) >= Date.parse(requestedAt) - 5000;

/** The ONE next action to make the lifecycle order billing-ready. */
export function nextBillingAction(s: OrderBillingSnapshot, pricing: OrderPricing, tx: Pick<LifecycleTransaction, "billing" | "billingResolutions" | "sf">): BillingAction {
  if (s.activated) return { type: "ready", summary: [`Order ${s.orderNumber ?? s.orderId} is already activated.`] };
  const b = tx.billing ?? null;
  const res = tx.billingResolutions ?? { policies: [], treatments: [] };

  // 1. Bill-To + addresses chosen on the form → the order (once per change of the chosen values).
  const hash = billingHash(b);
  if (b && hash !== (tx.sf.orderBillingHash ?? null)) {
    const input: { contactId?: string; address?: PostalAddress; shippingAddress?: PostalAddress } = {};
    if (b.billToContactId && !same(b.billToContactId, s.billToContact?.id)) input.contactId = b.billToContactId;
    if (addressComplete(b.billingAddress)) input.address = b.billingAddress;
    if (addressComplete(b.shippingAddress)) input.shippingAddress = b.shippingAddress;
    if (Object.keys(input).length) return { type: "set-details", input, hash: hash!, summary: [input.contactId ? `Bill-To ${b.billToContactName ?? b.billToContactId}` : null, input.address ? `billing address ${addressText(input.address)}` : null, input.shippingAddress ? `shipping address ${addressText(input.shippingAddress)}` : null].filter(Boolean).join("; ") };
  }

  // 2. Decisions only the user can make — all of them at once (one popup, not one per round trip).
  const needs: BillingNeed[] = [];
  // No product on the order has billing configuration → the app activates it without billing readiness (as Order activation does):
  // nothing to ask, only Salesforce pricing.
  if (s.requiresBilling && !s.billToContact && !b?.billToContactId) needs.push({ kind: "bill-to", message: `Order ${s.orderNumber ?? ""} has no Bill-To Contact.`, product: null, orderItemIds: [], policy: null });
  if (s.requiresBilling && !addressComplete(s.billingAddress) && !addressComplete(b?.billingAddress)) needs.push({ kind: "billing-address", message: "The order has no complete Billing Address (Street, City, Country).", product: null, orderItemIds: [], policy: null });
  if (s.requiresBilling && !addressComplete(s.shippingAddress) && !addressComplete(b?.shippingAddress)) needs.push({ kind: "shipping-address", message: "The order has no complete Shipping Address (Street, City, Country).", product: null, orderItemIds: [], policy: null });
  if (s.requiresBilling) {
    const noPolicy = new Map<string, BillingItemSnapshot[]>();
    for (const i of s.items) if (i.product && !i.policy) noPolicy.set(i.product.id, [...(noPolicy.get(i.product.id) ?? []), i]);
    for (const [productId, items] of noPolicy) {
      const r = res.policies.find(p => same(p.productId, productId));
      if (r) return { type: "assign-policy", resolution: r };
      needs.push({ kind: "billing-policy", message: `${items[0].product!.name} has no Billing Policy, so its order product${items.length > 1 ? "s" : ""} can't be billed.`, product: items[0].product, orderItemIds: items.map(i => i.id), policy: null });
    }
  }
  if (needs.length) return { type: "needs", needs };

  // 3. A broken policy chain is a policy problem (shared by every product using it) — never patched over from an order.
  const broken = s.items.filter(i => i.policy && i.policyErrors.length);
  if (broken.length) return { type: "blocked", message: broken.map(i => `${i.product?.name ?? "Order product"} — Billing Policy "${i.policy!.name}": ${i.policyErrors.join(" ")}`).join(" | ") + " Complete the policy's chain (Billing Policies → Complete chain), then resume." };

  // 4. Salesforce pricing on the ORDER (what "Reprice All" does) — it also stamps each line's Billing Treatment from its policy.
  if (!orderPriced(pricing, tx.sf.billingDirty)) return { type: "reprice", reason: !PRICED.test(pricing.calculationStatus ?? "") ? `Order prices aren't calculated (CalculationStatus ${pricing.calculationStatus ?? "unknown"}).` : "Billing configuration changed after the last pricing." };

  // 5. What Salesforce pricing didn't stamp: Order Setup's deterministic operations (default treatment, order action, tax treatment …).
  const ops = [...new Set(s.items.flatMap(i => i.pendingActions))];
  if (ops.length) return { type: "apply-setup", operations: ops, summary: s.items.filter(i => i.pendingActions.length).map(i => `${i.product?.name ?? i.id}: ${i.pendingActions.join(", ")}`).join("; ") };

  // 6. Treatments the user chose for lines nothing could resolve; then ask for the rest.
  const unresolved = s.requiresBilling ? s.items.filter(i => i.policy && !i.treatment && !i.expectedTreatment) : [];
  for (const i of unresolved) {
    const r = res.treatments.find(x => same(x.orderItemId, i.id));
    if (r) return { type: "set-treatment", resolution: r, item: i };
  }
  if (unresolved.length) return { type: "needs", needs: unresolved.map(i => ({ kind: "billing-treatment" as const, message: `${i.product?.name ?? "Order product"}: Salesforce couldn't resolve a Billing Treatment from Billing Policy "${i.policy!.name}".`, product: i.product, orderItemIds: [i.id], policy: i.policy })) };

  if (s.requiresBilling && !s.ready) return { type: "blocked", message: s.blockers.length ? s.blockers.map(x => (x.product ? `${x.product}: ${x.message}` : x.message)).join(" | ") : "Order Setup reports the order isn't ready for activation." };
  return {
    type: "ready",
    summary: [
      `Bill-To: ${s.billToContact?.name ?? "—"}`,
      `Billing address: ${addressText(s.billingAddress) || "—"}`,
      `Shipping address: ${addressText(s.shippingAddress) || "—"}`,
      `Prices calculated by Salesforce (${pricing.calculationStatus}, ${pricing.lastPricedDate})`,
      ...s.items.map(i => `${i.product?.name ?? i.id}: ${i.policy ? `policy ${i.policy.name}, treatment ${i.treatment?.name ?? "—"}` : "no billing configuration"}`),
    ],
  };
}

/** The org-side services billing readiness uses — the app's Order Setup + Billing Policy assignment (real: server/billingService.ts). */
export interface LifecycleBillingService {
  /** Order Setup readiness for the order, re-read from Salesforce. */
  load(orderId: string): Promise<OrderBillingSnapshot>;
  /** Order.BillToContactId / Billing* / Shipping* (contact must belong to the order's account; read back). */
  setDetails(orderId: string, input: { contactId?: string; address?: PostalAddress; shippingAddress?: PostalAddress }, stateToken: string | null): Promise<{ ok: boolean; error?: string }>;
  /** Order Setup's deterministic operations (default treatment, order action, tax treatment …) — never overwrites a set value. */
  applySetup(orderId: string, operations: string[], stateToken: string | null): Promise<{ ok: boolean; message?: string; error?: string }>;
  /** Product2 → Billing Policy, only when the product still has `expectedCurrentPolicyId` (null = none); read back. */
  assignPolicy(productId: string, policyId: string, expectedCurrentPolicyId: string | null): Promise<{ ok: boolean; message?: string; error?: string }>;
  /** OrderItem → Billing Treatment, only an Active treatment of the line's policy and only when the line has none; read back. */
  setTreatment(orderItemId: string, treatmentId: string, policyId: string | null): Promise<{ ok: boolean; error?: string }>;
}
