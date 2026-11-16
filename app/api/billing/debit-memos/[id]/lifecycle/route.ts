import type { NextRequest } from "next/server";
import { advanceLifecycle, BILLING_MODES, getLifecycle, LIFECYCLE_TARGETS, type BillingMode, type LifecycleTarget } from "@/lib/billing/server/debitMemoLifecycle";
import { paymentRoute } from "@/lib/billing/server/paymentsRoute";
import { creditMutation } from "@/lib/billing/server/creditMemosRoute";

type Params = { params: Promise<{ id: string }> };
const targetOf = (v: unknown): LifecycleTarget => (LIFECYCLE_TARGETS as readonly string[]).includes(String(v)) ? (v as LifecycleTarget) : "draft";
// Debit memos are billed only through the standard billing cycle — any other "mode" value is ignored.
const modeOf = (v: unknown): BillingMode => (BILLING_MODES as readonly string[]).includes(String(v)) ? (v as BillingMode) : "standard";

// GET /api/billing/debit-memos/[id]/lifecycle?target=draft|posted|invoiced|settled&mode=standard — the lifecycle derived
// from Salesforce records: eligibility, Salesforce invoice schedulers/batch runs, the resulting invoice, payment and settlement.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const q = req.nextUrl.searchParams;
  return paymentRoute(req, client => getLifecycle(client, id, targetOf(q.get("target")), modeOf(q.get("mode"))), "Failed to read the debit memo lifecycle");
}

// POST /api/billing/debit-memos/[id]/lifecycle — { target, mode, confirmBilling?, previewToken?, confirmPayment?, paymentKey? }.
// Performs the NEXT Salesforce operation toward the target (configure → post → [Salesforce invoice batch run when the
// billing date has arrived] → post invoice → payment), re-reads Salesforce and returns the state.
// Stops at the first failure with Salesforce's reason. The billing run and the payment each need explicit confirmation.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return creditMutation(req, async (client, body) => {
    const state = await advanceLifecycle(client, id, targetOf(body.target), modeOf(body.mode), {
      confirmPayment: body.confirmPayment === true, paymentKey: typeof body.paymentKey === "string" ? body.paymentKey : null,
      confirmBilling: body.confirmBilling === true, previewToken: typeof body.previewToken === "string" ? body.previewToken : null,
    });
    return { ok: true, status: 200, ...state };
  }, "Failed to advance the debit memo lifecycle");
}
