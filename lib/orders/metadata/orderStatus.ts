import type { SalesforceClient } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import { describeObjectCached, findPicklistFieldByLabel } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { OrderActivationResult, OrderMutabilityCheck, OrderStatusResolution, PicklistFieldRef } from "@/lib/orders/types";

const orderStatusCache = createTTLCache<OrderStatusResolution>();

/**
 * Resolve the org's own Order.Status active values and which of them
 * represents "not yet activated" / "activated" / "cancelled" (§2.9) — a
 * semantic/label match against whatever the org actually configured, NEVER
 * the hardcoded literals "Draft"/"Activated"/"Cancelled", because orgs
 * customize this picklist's label text freely.
 */
export async function resolveOrderStatusResolution(client: SalesforceClient): Promise<OrderStatusResolution> {
  return orderStatusCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Order");
    const picklist = findPicklistFieldByLabel(describe, "Status", /^status$/i);
    if (!picklist) {
      return { statusField: null, draftValue: null, activatedValue: null, cancelledValue: null };
    }

    const statusField: PicklistFieldRef = {
      apiName: picklist.field.name, label: picklist.field.label,
      options: picklist.activeOptions, defaultValue: picklist.defaultValue,
    };

    const findBy = (pattern: RegExp) => statusField.options.find(o => pattern.test(o.label) || pattern.test(o.value))?.value ?? null;

    const activatedValue = findBy(/^activated$/i) ?? findBy(/activat/i);
    const cancelledValue = findBy(/^cancel+ed$/i) ?? findBy(/cancel/i);
    // "Draft-equivalent" default: the org's marked default value if it isn't
    // itself the activated/cancelled value, else the first remaining active option.
    const draftValue = (statusField.defaultValue && statusField.defaultValue !== activatedValue && statusField.defaultValue !== cancelledValue)
      ? statusField.defaultValue
      : (statusField.options.find(o => o.value !== activatedValue && o.value !== cancelledValue)?.value ?? null);

    return { statusField, draftValue, activatedValue, cancelledValue };
  });
}

/**
 * Read Order.Status live and classify whether OrderItem mutation is
 * currently allowed (§2.9, §4.7). This is a "degrade to attempt, then react
 * to whatever Salesforce actually enforces" case — mutability is only ever
 * classified "blocked" when the current Status positively equals the
 * resolved "activated" value; anything else the org might separately
 * enforce (a validation rule tied to Status in an unexpected way) is left
 * "inconclusive" so the real Salesforce error surfaces instead of a guess.
 */
export async function checkOrderMutability(client: SalesforceClient, orderId: string): Promise<OrderMutabilityCheck> {
  const resolution = await resolveOrderStatusResolution(client);
  if (!resolution.statusField) {
    return { status: "inconclusive", currentStatus: null, reason: "Could not resolve an Order Status field in this org." };
  }

  let currentStatus: string | null = null;
  try {
    const record = await client.getRecord("Order", orderId, [resolution.statusField.apiName]);
    currentStatus = (record[resolution.statusField.apiName] as string) ?? null;
  } catch {
    return { status: "inconclusive", currentStatus: null, reason: "Could not read this Order's current Status." };
  }

  if (!resolution.activatedValue) {
    return { status: "inconclusive", currentStatus, reason: "Could not determine this org's 'Activated' Status value — attempting line-item writes and surfacing Salesforce's own error if this Order is actually locked." };
  }

  if (currentStatus === resolution.activatedValue) {
    return { status: "blocked", currentStatus, reason: `This Order's Status is "${currentStatus}" — Salesforce orgs typically lock OrderItem mutation once an Order is Activated.` };
  }

  return { status: "mutable", currentStatus, reason: `Status is "${currentStatus ?? "unset"}", not the org's Activated value ("${resolution.activatedValue}") — line items should be mutable.` };
}

export type OrderActivationAction = "activate" | "deactivate" | "cancel";

/**
 * Transition Order.Status via a direct field update (§3.6) — the standard
 * mechanism most orgs use. If Salesforce rejects it (e.g. because this org
 * actually exposes a dedicated Activate/Deactivate Apex action or Flow
 * instead of a raw Status write), the org's own rejection text is
 * surfaced verbatim rather than silently retrying a guessed alternative.
 */
export async function activateOrder(client: SalesforceClient, orderId: string, action: OrderActivationAction): Promise<OrderActivationResult> {
  const resolution = await resolveOrderStatusResolution(client);
  if (!resolution.statusField) {
    return { success: false, attemptedTransition: null, message: "Could not resolve an Order Status field in this org — cannot activate.", salesforceError: null };
  }

  const targetValue = action === "activate" ? resolution.activatedValue : action === "cancel" ? resolution.cancelledValue : resolution.draftValue;
  if (!targetValue) {
    return {
      success: false, attemptedTransition: null,
      message: `Could not resolve this org's "${action}" Status value from its active Order.Status picklist options.`,
      salesforceError: null,
    };
  }

  let currentStatus: string | null = null;
  try {
    const record = await client.getRecord("Order", orderId, [resolution.statusField.apiName]);
    currentStatus = (record[resolution.statusField.apiName] as string) ?? null;
  } catch {
    /* proceed without a "from" value — not fatal to the transition itself */
  }

  try {
    await client.updateRecord("Order", orderId, { [resolution.statusField.apiName]: targetValue });
    return { success: true, attemptedTransition: { from: currentStatus, to: targetValue }, message: `Order Status updated to "${targetValue}".`, salesforceError: null };
  } catch (err) {
    const message = err instanceof SalesforceError ? err.message : (err instanceof Error ? err.message : "Failed to update Order Status.");
    return { success: false, attemptedTransition: { from: currentStatus, to: targetValue }, message: `Salesforce rejected the Status transition to "${targetValue}".`, salesforceError: message };
  }
}
