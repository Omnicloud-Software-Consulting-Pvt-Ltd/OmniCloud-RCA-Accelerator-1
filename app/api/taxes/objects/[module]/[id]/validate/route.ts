import { POST as genericPOST } from "@/app/api/billing/[module]/[id]/validate/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module]/[id]/validate — Validate changes to a tax record (no writes).
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const POST = taxesOnly<{ module: string; id: string }>(genericPOST);
