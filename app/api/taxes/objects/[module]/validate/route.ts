import { POST as genericPOST } from "@/app/api/billing/[module]/validate/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module]/validate — Validate a draft tax record against live metadata (no writes).
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const POST = taxesOnly<{ module: string }>(genericPOST);
