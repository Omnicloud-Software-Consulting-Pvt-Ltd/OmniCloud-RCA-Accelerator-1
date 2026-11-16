import { BILLING_MODULES } from "@/lib/billing/registry";
import { TAX_MODULES } from "@/lib/taxes/modules";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";

/**
 * Where a notification takes the user. Every destination is an existing /data deep link — the same
 * query params the page already restores on refresh (module / qv+qid / ov+oid / cv+cid / bm+bv+bid /
 * tv+tm+tid / pdv+pdid / bdv+bdid / adv+adid / pv) — never an invented route.
 *
 * Priority: the record's own details view → its module (list) → nothing (Salesforce link only).
 */

export const APP_DEEP_LINK_EVENT = "omni:app-deep-link";

const DATA = "/data";
const INTERNAL_PATHS = new Set([DATA, "/dashboard", "/metadata"]);

export interface DestinationInput {
  objectApiName: string | null | undefined;
  recordId: string | null | undefined;
  /** Module label from the notification — disambiguates objects shared by two modules (Product2 = Products or Bundles). */
  module?: string | null;
  /** An Order notification from Billing opens Order Billing; from Tax, that order's tax run. */
  context?: "billing" | "tax" | null;
}

export interface Destination {
  href: string;
  /** true = that exact record's details view; false = its module, where the record can be located. */
  exact: boolean;
}

const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
export const isSalesforceId = (id: unknown): id is string => typeof id === "string" && SF_ID.test(id);

const href = (params: Record<string, string>) => `${DATA}?${new URLSearchParams(params).toString()}`;

/** Billing / Tax workspace module for an sObject, straight from the registries those workspaces render. */
function registryModule(objectApiName: string): { area: "billing" | "taxes"; key: string } | null {
  const tax = TAX_MODULES.find(m => m.candidates.includes(objectApiName));
  if (tax) return { area: "taxes", key: tax.key };
  const billing = BILLING_MODULES.find(m => m.candidates.includes(objectApiName));
  if (billing) return { area: "billing", key: billing.key };
  return null;
}

const isBundleModule = (module: string | null | undefined) => !!module && /bundle/i.test(module);

export function resolveDestination(input: DestinationInput): Destination | null {
  const obj = input.objectApiName ?? "";
  const id = isSalesforceId(input.recordId) ? input.recordId : null;
  const detail = (params: Record<string, string>): Destination => ({ href: href(params), exact: true });
  const list = (params: Record<string, string>): Destination => ({ href: href(params), exact: false });

  switch (obj) {
    case "Product2":
      if (isBundleModule(input.module)) return id ? detail({ module: "bundles", bdv: "detail", bdid: id }) : list({ module: "bundles", bdv: "history" });
      return id ? detail({ module: "products", pdv: "configuration", pdid: id }) : list({ module: "products", pdv: "history" });
    case "AttributeDefinition":
      return id ? detail({ module: "attributes", adv: "detail", adid: id }) : list({ module: "attributes", adv: "history" });
    case "ExpressionSet":
    case "ExpressionSetDefinition":
      // Pricing procedures have no in-app details view — open Pricing Procedure history.
      return list({ module: "pricing-rules", pv: "history" });
    case "Order":
      if (input.context === "billing" && id) return detail({ module: "billing", bv: "order", bid: id });
      if (input.context === "tax" && id) return detail({ module: "taxes", tv: "run", tid: id });
      return id ? detail({ module: "orders", ov: "workspace", oid: id }) : list({ module: "orders", ov: "history" });
    case "Quote":
      return id ? detail({ module: "quotes", qv: "workspace", qid: id }) : list({ module: "quotes", qv: "history" });
    case "Contract":
      return id ? detail({ module: "contracts", cv: "workspace", cid: id }) : list({ module: "contracts", cv: "history" });
    case "DebitMemo":
      return id ? detail({ module: "billing-debit-memos", bm: "debit-memos", bv: "debit-memo", bid: id }) : list({ module: "billing-debit-memos", bm: "debit-memos", bv: "debit-memos" });
    case "CreditMemo":
      return id ? detail({ module: "billing-credit-memos", bm: "credit-memos", bv: "credit-memo", bid: id }) : list({ module: "billing-credit-memos", bm: "credit-memos", bv: "credit-memos" });
    case "Payment":
      return id ? detail({ module: "billing-payments", bm: "payments", bv: "payment", bid: id }) : list({ module: "billing-payments", bm: "payments", bv: "payments" });
    case "Account":
      return list({ module: "accounts" });
    case "Contact":
      return list({ module: "contacts" });
    case "Opportunity":
      return list({ module: "opportunities" });
  }

  const reg = obj ? registryModule(obj) : null;
  if (reg?.area === "taxes") return id ? detail({ module: "taxes", tv: "detail", tm: reg.key, tid: id }) : list({ module: "taxes", tm: reg.key });
  if (reg?.area === "billing") return id ? detail({ module: "billing", bm: reg.key, bv: "detail", bid: id }) : list({ module: "billing", bm: reg.key });
  return null;
}

/** Only same-origin app paths this app actually serves — no protocol-relative, external or unknown routes. */
export function isSafeInternalHref(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return false;
  try {
    const u = new URL(value, "http://app.invalid");
    return u.origin === "http://app.invalid" && INTERNAL_PATHS.has(u.pathname);
  } catch {
    return false;
  }
}

/** Lightning record URL on the connected org — built from the configured instance URL and a real record Id only. */
export function salesforceRecordUrl(instanceUrl: string | null | undefined, objectApiName: string | null | undefined, recordId: string | null | undefined): string | null {
  if (!instanceUrl || !objectApiName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(objectApiName) || !isSalesforceId(recordId)) return null;
  let base: URL;
  try { base = new URL(instanceUrl); } catch { return null; }
  if (base.protocol !== "https:") return null;
  return buildSalesforceRecordUrl(base.origin, objectApiName, recordId);
}

/** A stored Salesforce link is opened only if it still points at the org the user is connected to now. */
export function isSafeSalesforceUrl(value: unknown, instanceUrl: string | null | undefined): value is string {
  if (typeof value !== "string" || !instanceUrl) return false;
  try {
    const u = new URL(value), org = new URL(instanceUrl);
    return u.protocol === "https:" && u.host === org.host && u.pathname.startsWith("/lightning/r/");
  } catch {
    return false;
  }
}

/**
 * Navigate to an in-app destination. /data restores deep links at mount, so a link into the page
 * already open pushes the URL (Next.js syncs native pushState) and asks the page to remount; any other
 * page is a normal load of that deep link. Returns false (and does nothing) for an unsafe href.
 */
export function openAppDestination(target: string): boolean {
  if (!isSafeInternalHref(target)) return false;
  const u = new URL(target, window.location.origin);
  const path = `${u.pathname}${u.search}`;
  if (u.pathname === window.location.pathname) {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new Event(APP_DEEP_LINK_EVENT));
  } else {
    window.location.assign(path);
  }
  return true;
}
