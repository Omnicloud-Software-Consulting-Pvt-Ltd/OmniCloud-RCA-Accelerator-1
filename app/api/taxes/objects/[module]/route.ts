import { GET as genericGET, POST as genericPOST } from "@/app/api/billing/[module]/route";
import { taxesOnly } from "@/lib/taxes/routeGuard";

// /api/taxes/objects/[module] — List tax records (GET ?search&limit) / create a reviewed record (POST { draft, links }).
// Delegates to the app's generic describe-driven record handler; only Taxes-section modules are accepted.
export const GET = taxesOnly<{ module: string }>(genericGET);
export const POST = taxesOnly<{ module: string }>(genericPOST);
