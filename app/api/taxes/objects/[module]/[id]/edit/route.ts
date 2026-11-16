import { GET as genericGET } from "@/app/api/billing/[module]/[id]/edit/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module]/[id]/edit — Edit form data of a tax record.
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const GET = taxesOnly<{ module: string; id: string }>(genericGET);
