import type { NextRequest } from "next/server";
import { listTaxRuns, startVerificationRun } from "@/lib/tax/server/verification";
import { taxRoute } from "@/lib/tax/server/route";
import { BadInputError } from "@/lib/billing/server/payments";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// GET /api/billing/tax/runs — end-to-end verification orders with their invoice tax.
export async function GET(req: NextRequest) {
  return taxRoute(req, client => listTaxRuns(client), "Failed to list tax verifications");
}

// POST /api/billing/tax/runs — { product: {id|name}, accountId|accountName, quantity, unitPrice, key, confirm: true }. Checks that
// Salesforce can calculate tax and that the product's tax chain is configured, then creates the Draft verification order (idempotent
// per key). Creates no tax configuration. The billing steps run through /runs/[orderId].
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => {
    if (body.confirm !== true) throw new BadInputError("Confirm the verification order first.");
    const p = (body.product ?? {}) as { id?: unknown; name?: unknown };
    return startVerificationRun(client, {
      product: { id: typeof p.id === "string" ? p.id : null, name: typeof p.name === "string" ? p.name : null },
      accountId: typeof body.accountId === "string" && body.accountId ? body.accountId : null,
      accountName: typeof body.accountName === "string" ? body.accountName : null, quantity: num(body.quantity), unitPrice: num(body.unitPrice), key: typeof body.key === "string" ? body.key : "",
    });
  }, "Failed to start the tax verification", { mutates: true });
}
