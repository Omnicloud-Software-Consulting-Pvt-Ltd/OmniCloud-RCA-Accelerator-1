import { redirect } from "next/navigation";
import { bulkAssignmentDataUrl } from "@/lib/policyAssignment/navigation";

// /data/tax-policy/bulk-assignment — direct-access path for the Tax Policy Bulk Product Assignment page. The page itself is a
// view of the Taxes workspace inside /data (app shell, sidebar, breadcrumbs, URL-restored on refresh).
export default function TaxPolicyBulkAssignmentRedirect() {
  redirect(bulkAssignmentDataUrl("tax"));
}
