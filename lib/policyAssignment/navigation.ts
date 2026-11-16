import type { PolicyKind } from "@/lib/policyAssignment/types";

/**
 * Dedicated Bulk Product Assignment pages. Like every other /data screen, each page is a view of its workspace addressed by
 * URL parameters (so the app shell, sidebar, breadcrumbs and refresh/deep-link restore all work):
 *   Billing → /data?module=billing-policies&bm=billing-policies&bv=bulk-assignment   (BillingWorkspace view "bulk-assign")
 *   Tax     → /data?module=taxes-policies&tm=tax-policies&tv=bulk-assignment         (TaxesWorkspace view "bulk-assign")
 * The friendly paths /data/billing-policy/bulk-assignment and /data/tax-policy/bulk-assignment redirect there.
 */
export const BULK_ASSIGNMENT_VIEW = "bulk-assignment";

/** The registry module (billing/tax module key) whose dashboard shows the card. */
export const BULK_ASSIGNMENT_MODULE: Record<PolicyKind, string> = { billing: "billing-policies", tax: "tax-policies" };
export const BULK_ASSIGNMENT_KIND_FOR_MODULE: Record<string, PolicyKind> = { "billing-policies": "billing", "tax-policies": "tax" };

/** Friendly direct-access paths (Next routes that redirect to the canonical /data URL). */
export const BULK_ASSIGNMENT_PATHS: Record<PolicyKind, string> = {
  billing: "/data/billing-policy/bulk-assignment",
  tax: "/data/tax-policy/bulk-assignment",
};

/** Canonical /data URL of a kind's assignment page (sidebar item + workspace view parameters). */
export function bulkAssignmentDataUrl(kind: PolicyKind): string {
  const p = kind === "billing"
    ? new URLSearchParams({ module: "billing-policies", bm: "billing-policies", bv: BULK_ASSIGNMENT_VIEW })
    : new URLSearchParams({ module: "taxes-policies", tm: "tax-policies", tv: BULK_ASSIGNMENT_VIEW });
  return `/data?${p.toString()}`;
}

export const BULK_ASSIGNMENT_TITLE: Record<PolicyKind, string> = {
  billing: "Billing Policy Bulk Product Assignment",
  tax: "Tax Policy Bulk Product Assignment",
};
