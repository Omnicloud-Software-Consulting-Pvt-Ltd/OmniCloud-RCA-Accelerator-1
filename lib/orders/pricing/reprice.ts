import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField } from "@/lib/salesforce/describe";
import type { OrderRepricingAttemptError, OrderRepricingLineResult, OrderRepricingSummary } from "@/lib/orders/types";

/**
 * Candidate Connect REST paths for Salesforce's Order-side Instant Pricing
 * action (§6.2). This is deliberately a SEPARATE candidate list from the
 * Quote side's (lib/quotes/pricing/reprice.ts) — an org's Order repricing
 * action is commonly a distinct Connect REST resource, not guaranteed to
 * exist just because the Quote-side one does, so it is never assumed to
 * share Quote's path or reused against an Order payload.
 */
const ORDER_REPRICING_CANDIDATES = [
  { path: "/pricing/order-calculate", body: (orderId: string) => ({ orderId }) },
  { path: (orderId: string) => `/pricing/orders/${orderId}/calculate`, body: () => ({}) },
];

interface RepriceLineResponse {
  orderItemId?: string;
  id?: string;
  netUnitPrice?: number;
  netTotalPrice?: number;
  listPrice?: number;
  discount?: number;
}

/** Same wording set as the Quote side's `looksLikeConfigurationIssue` — see lib/quotes/pricing/reprice.ts for why these specific phrases (incl. the native "Product Discovery"/"validate the configuration" text) are matched. */
function looksLikeConfigurationIssue(message: string): boolean {
  return /pricing.?context|pricing procedure|pricing engine|no active price|catalog not published|couldn.?t refresh the prices|couldn.?t retrieve the product and price|product discovery|validate the configuration/i.test(message);
}

/** §Do not truncate the message: unwrap the COMPLETE Salesforce error — errorCode, fields, nested errors, the untouched raw body — not just `.message`. */
function extractAttemptError(err: unknown, path: string): OrderRepricingAttemptError {
  if (err instanceof SalesforceError) {
    const bodyArr = Array.isArray(err.body) ? err.body : err.body != null ? [err.body] : [];
    const first = (bodyArr[0] ?? {}) as { fields?: unknown };
    return {
      path,
      status: err.status,
      errorCode: err.errorCode ?? null,
      message: err.message,
      fields: Array.isArray(first.fields) ? (first.fields as string[]) : null,
      rawBody: err.body ?? null,
    };
  }
  return {
    path, status: null, errorCode: null,
    message: err instanceof Error ? err.message : "Repricing request failed.",
    fields: null, rawBody: null,
  };
}

/**
 * Trigger Salesforce's own repricing for a RevenueCloudPricing-model org's
 * Order (§6.2, §4.9) after OrderItems have been created/discount-edited.
 * If no Order-side repricing action resolves in this org, this degrades to
 * a genuine "repricing unavailable for Orders in this org" outcome
 * (§2.5's inconclusive-never-blocks rule) rather than falling back to the
 * Quote-side endpoint.
 */
export async function repriceOrder(client: SalesforceClient, orderId: string): Promise<OrderRepricingSummary> {
  const attemptErrors: OrderRepricingAttemptError[] = [];

  for (const candidate of ORDER_REPRICING_CANDIDATES) {
    const path = typeof candidate.path === "function" ? candidate.path(orderId) : candidate.path;
    const body = candidate.body(orderId);
    try {
      const response = await client.connectPost<{ lineItems?: RepriceLineResponse[] }>(path, body);
      const lines: OrderRepricingLineResult[] = [];
      const oiDescribe = await describeObjectCached(client, "OrderItem").catch(() => null);
      const unitPriceField = oiDescribe ? resolveField(oiDescribe, "UnitPrice", /^sales price$/i) : null;
      const writable = !!(unitPriceField?.updateable);

      for (const line of response.lineItems ?? []) {
        const id = line.orderItemId ?? line.id;
        if (!id) continue;
        let written = false;
        if (writable && line.netUnitPrice != null) {
          try {
            await client.updateRecord("OrderItem", id, { [unitPriceField!.name]: line.netUnitPrice });
            written = true;
          } catch {
            written = false;
          }
        }
        lines.push({
          orderItemId: id,
          netUnitPrice: line.netUnitPrice ?? null,
          netTotalPrice: line.netTotalPrice ?? null,
          listPrice: line.listPrice ?? null,
          discount: line.discount ?? null,
          written,
        });
      }

      return { attempted: true, succeeded: true, isConfigurationIssue: false, message: null, lines, attemptErrors };
    } catch (err) {
      const detail = extractAttemptError(err, path);
      attemptErrors.push(detail);
      console.error(`[repriceOrder] candidate path "${detail.path}" failed: status=${detail.status ?? "n/a"} errorCode=${detail.errorCode ?? "n/a"} fields=${JSON.stringify(detail.fields)} message="${detail.message}" rawBody=${JSON.stringify(detail.rawBody)}`);
      continue;
    }
  }

  const lastError = attemptErrors[attemptErrors.length - 1]?.message ?? null;
  const isConfigurationIssue = lastError ? looksLikeConfigurationIssue(lastError) : false;
  return {
    attempted: true,
    succeeded: false,
    isConfigurationIssue,
    message: isConfigurationIssue
      ? `Repricing failed due to a Revenue Cloud pricing configuration issue in this org: ${lastError}`
      : `Repricing is unavailable for Orders in this org${lastError ? ` (${lastError})` : ""} — this org may not expose a distinct Order-side Instant Pricing action.`,
    lines: [],
    attemptErrors,
  };
}
