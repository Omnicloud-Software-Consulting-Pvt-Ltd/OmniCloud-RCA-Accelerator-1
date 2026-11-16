import { GET as genericGET } from "@/app/api/billing/[module]/schema/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module]/schema — Describe-driven form schema of a tax object.
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const GET = taxesOnly<{ module: string }>(genericGET);
