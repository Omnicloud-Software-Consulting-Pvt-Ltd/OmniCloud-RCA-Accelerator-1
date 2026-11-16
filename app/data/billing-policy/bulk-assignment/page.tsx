import { redirect } from "next/navigation";
import { bulkAssignmentDataUrl } from "@/lib/policyAssignment/navigation";

// /data/billing-policy/bulk-assignment — direct-access path for the Billing Policy Bulk Product Assignment page. The page itself
// is a view of the Revenue Cloud Billing workspace inside /data (app shell, sidebar, breadcrumbs, URL-restored on refresh).
export default function BillingPolicyBulkAssignmentRedirect() {
  redirect(bulkAssignmentDataUrl("billing"));
}
