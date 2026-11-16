import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { runEndToEndTaxValidation, type E2EMode } from "@/lib/tax/server/e2e";

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

// POST /api/taxes/e2e — { mode: "preview" | "start" | "advance" | "state", product, accountName, quantity, unitPrice, orderId, confirm }.
// preview/state are read-only; start (creates the validation order) and advance (next Salesforce step) require confirm: true, and a
// billable step (activation, billing schedules, invoice, posting) also confirmAction naming that step. A stale decision table is
// refreshed only with approveDecisionTableRefresh: true (an explicit, separately approved step) — never automatically.
export async function POST(req: NextRequest) {
  return taxRoute(req, (client, body) => {
    const mode = (["preview", "start", "advance", "state"].includes(String(body.mode)) ? body.mode : "preview") as E2EMode;
    const p = (body.product ?? {}) as { id?: unknown; name?: unknown };
    return runEndToEndTaxValidation(client, { mode, product: { id: s(p.id), name: s(p.name) }, accountName: s(body.accountName), quantity: n(body.quantity), unitPrice: n(body.unitPrice), country: s(body.country), state: s(body.state), orderId: s(body.orderId), confirm: body.confirm === true, confirmAction: s(body.confirmAction), key: s(body.key), approveDecisionTableRefresh: body.approveDecisionTableRefresh === true });
  }, "Tax validation failed", { mutates: true });
}
