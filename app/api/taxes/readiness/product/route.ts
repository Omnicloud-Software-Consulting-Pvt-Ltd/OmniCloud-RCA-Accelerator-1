import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { getProductTaxReadiness } from "@/lib/tax/server/pipeline";

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// POST /api/taxes/readiness/product — { product: { id? | name? }, country?, state?, city?, zipCode?, legalEntityId?, effectiveDate? }.
// Read-only: engine, policy, treatment, item, rate, geography, decision table, configuration, calculation and billing readiness.
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => {
    const p = (body.product ?? {}) as { id?: unknown; name?: unknown };
    return getProductTaxReadiness(await runtimeApiFor(client), { id: s(p.id), name: s(p.name) }, { country: s(body.country), state: s(body.state), city: s(body.city), zipCode: s(body.zipCode), legalEntityId: s(body.legalEntityId), effectiveDate: s(body.effectiveDate) });
  }, "Failed to check tax readiness");
}
