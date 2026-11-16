import { GET as genericGET, PATCH as genericPATCH } from "@/app/api/billing/[module]/[id]/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module]/[id] — Record detail (GET) / apply reviewed changes to updateable fields (PATCH).
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const GET = taxesOnly<{ module: string; id: string }>(genericGET);
export const PATCH = taxesOnly<{ module: string; id: string }>(genericPATCH);
