import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { applyOrderBillingSetup, loadOrderBilling, setOrderBillingDetails, type MutationOutcome, type OrderSetupOperation } from "@/lib/billing/server/orderBilling";
import { assignBillingPolicy, discoverAssignmentField, evaluatePolicyChain, loadPolicyChain } from "@/lib/billing/server/assignment";
import type { LifecycleBillingService, OrderBillingSnapshot } from "../billing";

/**
 * Billing readiness for lifecycle orders, on the app's EXISTING billing services (no second implementation):
 *  · readiness — Order Setup's loadOrderBilling (Product → Billing Policy → Treatment → Item, Bill-To, addresses, tax);
 *  · Bill-To / addresses — setOrderBillingDetails (contact must belong to the order's account; ISO country/state; read back);
 *  · default treatments and the other deterministic line settings — applyOrderBillingSetup (never overwrites a set value);
 *  · a product's Billing Policy — assignBillingPolicy (Product2 field discovered from metadata; refuses to replace; read back).
 * Only the user-chosen order-product treatment is written here, after checking it is an Active treatment of that line's policy.
 */

const errorOf = (r: MutationOutcome) => (r.ok ? undefined : `${r.error}${r.possibleCause ? ` (${r.possibleCause})` : ""}`);
const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const SETUP_OPS: OrderSetupOperation[] = ["order-action", "billing-treatment", "tax-treatment", "billing-start-month", "billing-end-date"];

export function lifecycleBillingService(client: SalesforceClient): LifecycleBillingService {
  return {
    async load(orderId) {
      const s = await loadOrderBilling(client, orderId);
      const snap: OrderBillingSnapshot = {
        orderId: s.order.id, orderNumber: s.order.number, status: s.order.status, activated: s.order.activated,
        billToContact: s.order.billToContact, billingAddress: s.order.billingAddress, shippingAddress: s.order.shippingAddress,
        items: s.items.map(i => ({
          id: i.id,
          product: i.product ? { id: i.product.id, name: i.product.name } : null,
          policy: i.policy ? { id: i.policy.id, name: i.policy.name } : null,
          policyErrors: i.chainChecks.filter(c => c.status === "failed").map(c => c.detail ?? c.label),
          treatment: i.treatment.current, expectedTreatment: i.treatment.expected,
          pendingActions: i.pendingActions,
        })),
        requiresBilling: s.requiresBillingReadiness,
        ready: s.readiness.ready,
        blockers: (s.readiness.blockerDetails ?? []).map(b => ({ message: b.message, orderItemId: b.orderItemId, product: b.product })),
        stateToken: s.stateToken,
      };
      return snap;
    },
    async setDetails(orderId, input, stateToken) {
      const r = await setOrderBillingDetails(client, orderId, { contactId: input.contactId, address: input.address ?? null, shippingAddress: input.shippingAddress ?? null }, stateToken);
      return r.ok ? { ok: true } : { ok: false, error: errorOf(r) };
    },
    async applySetup(orderId, operations, stateToken) {
      const ops = operations.filter((o): o is OrderSetupOperation => (SETUP_OPS as string[]).includes(o));
      if (!ops.length) return { ok: false, error: `Unknown Order Setup operation(s): ${operations.join(", ")}.` };
      const r = await applyOrderBillingSetup(client, orderId, { operations: ops, stateToken });
      return r.ok ? { ok: true, message: r.message } : { ok: false, error: errorOf(r) };
    },
    async assignPolicy(productId, policyId, expectedCurrentPolicyId) {
      const r = await assignBillingPolicy(client, { productId, policyId, expectedCurrentPolicyId, confirmReplace: false });
      if (r.ok) return { ok: true, message: `${r.product.name} → ${r.policy.name} (read back from Salesforce).` };
      if (r.code === "ALREADY_ASSIGNED") return { ok: true, message: r.error };
      return { ok: false, error: r.error };
    },
    async setTreatment(orderItemId, treatmentId, policyId) {
      if (!ID.test(orderItemId) || !ID.test(treatmentId)) return { ok: false, error: "Invalid record Id." };
      const [t] = await client.queryAll<Record<string, unknown>>(`SELECT Id, Name, Status, BillingPolicyId FROM BillingTreatment WHERE Id = '${soqlEscape(treatmentId)}'`);
      if (!t) return { ok: false, error: "That Billing Treatment no longer exists or isn't visible to your user." };
      if (t.Status !== "Active") return { ok: false, error: `Billing Treatment "${t.Name}" is ${t.Status ?? "not Active"}.` };
      if (policyId && String(t.BillingPolicyId ?? "").slice(0, 15) !== policyId.slice(0, 15)) return { ok: false, error: `Billing Treatment "${t.Name}" doesn't belong to the product's Billing Policy.` };
      const [it] = await client.queryAll<Record<string, unknown>>(`SELECT Id, BillingTreatmentId, Order.Status FROM OrderItem WHERE Id = '${soqlEscape(orderItemId)}'`);
      if (!it) return { ok: false, error: "The order product no longer exists." };
      if ((it.Order as Record<string, unknown> | null)?.Status !== "Draft") return { ok: false, error: "The order isn't Draft any more." };
      if (it.BillingTreatmentId && String(it.BillingTreatmentId).slice(0, 15) !== treatmentId.slice(0, 15)) return { ok: false, error: "The order product already has a different Billing Treatment — it isn't overwritten." };
      if (!it.BillingTreatmentId) await client.updateRecord("OrderItem", orderItemId, { BillingTreatmentId: treatmentId });
      const [after] = await client.queryAll<Record<string, unknown>>(`SELECT BillingTreatmentId FROM OrderItem WHERE Id = '${soqlEscape(orderItemId)}'`);
      return String(after?.BillingTreatmentId ?? "").slice(0, 15) === treatmentId.slice(0, 15) ? { ok: true } : { ok: false, error: "Salesforce accepted the update but the order product doesn't show the Billing Treatment." };
    },
  };
}

/** Eligible choices for the "your input needed" popup — real records only. */
export async function billingChoices(client: SalesforceClient, policyIds: string[]) {
  const policies = await client.queryAll<Record<string, unknown>>("SELECT Id, Name, Status, BillingTreatmentSelection, DefaultBillingTreatmentId FROM BillingPolicy ORDER BY Name LIMIT 200");
  const ids = [...new Set(policyIds.filter(i => ID.test(i)))];
  const treatments = ids.length ? await client.queryAll<Record<string, unknown>>(`SELECT Id, Name, Status, BillingPolicyId, LegalEntity.Name, IsMilestoneBilling, ExcludeFromBilling FROM BillingTreatment WHERE BillingPolicyId IN (${ids.map(i => `'${soqlEscape(i)}'`).join(",")}) ORDER BY Name`) : [];
  const tIds = treatments.map(t => String(t.Id));
  const items = tIds.length ? await client.queryAll<Record<string, unknown>>(`SELECT Id, Name, Status, BillingType, BillingTreatmentId FROM BillingTreatmentItem WHERE BillingTreatmentId IN (${tIds.map(i => `'${soqlEscape(i)}'`).join(",")})`) : [];
  const productField = (await discoverAssignmentField(client))?.name ?? null;
  // A policy is offered as eligible only when its chain passes the same check billing readiness applies ("bill" mode).
  const policyRows = await Promise.all(policies.map(async p => {
    const chain = await loadPolicyChain(client, String(p.Id), productField).catch(() => null);
    const failed = chain ? evaluatePolicyChain(chain, "bill").filter(c => c.status === "failed").map(c => c.detail ?? c.label) : ["The policy chain couldn't be read."];
    return { id: String(p.Id), name: String(p.Name), status: (p.Status as string) ?? null, selection: (p.BillingTreatmentSelection as string) ?? null, defaultTreatment: chain?.defaultTreatment?.name ?? null, items: chain?.items.map(i => `${i.name}${i.billingType ? ` (${i.billingType})` : ""}`) ?? [], eligible: failed.length === 0, reason: failed.join(" ") || null };
  }));
  return {
    policies: policyRows,
    treatments: treatments.map(t => {
      const its = items.filter(i => i.BillingTreatmentId === t.Id);
      const activeItems = its.filter(i => i.Status === "Active");
      const reason = t.Status !== "Active" ? `Treatment is ${t.Status ?? "not Active"}.` : !activeItems.length && !t.IsMilestoneBilling ? "No Active Billing Treatment Item." : null;
      return { id: String(t.Id), name: String(t.Name), policyId: String(t.BillingPolicyId ?? ""), status: (t.Status as string) ?? null, legalEntity: ((t.LegalEntity as Record<string, unknown> | null)?.Name as string) ?? null, items: its.map(i => `${i.Name}${i.BillingType ? ` (${i.BillingType})` : ""} · ${i.Status}`), eligible: !reason, reason };
    }),
  };
}
