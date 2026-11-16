import type { NextRequest } from "next/server";
import { GET as moduleSchema } from "@/app/api/billing/[module]/schema/route";

// GET /api/billing/payments/schema — keeps the generic "Salesforce Config" inspector working for the payments
// module now that /api/billing/payments/* is served by the dedicated payment routes.
export async function GET(req: NextRequest) {
  return moduleSchema(req, { params: Promise.resolve({ module: "payments" }) });
}
