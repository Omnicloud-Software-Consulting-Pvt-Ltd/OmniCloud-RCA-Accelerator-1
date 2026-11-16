import { NextResponse, type NextRequest } from "next/server";
import { applyCreditMemo, postCreditMemo, voidCreditMemo } from "@/lib/billing/server/creditMemos";
import { creditMutation } from "@/lib/billing/server/creditMemosRoute";
import { BadInputError } from "@/lib/billing/server/payments";

type Params = { params: Promise<{ id: string; action: string }> };

// POST /api/billing/credit-memos/[id]/post  — { stateToken }            postDraftCreditMemo (Draft only)
// POST /api/billing/credit-memos/[id]/apply — { invoiceId, amount, invoiceToken, stateToken }   credit-memos/{id}/actions/apply
// POST /api/billing/credit-memos/[id]/void  — { stateToken }            voidPostedCreditMemo (Posted only)
// Each re-reads the credit memo (and invoice), checks capability + stale state, then re-reads Salesforce for the result.
export async function POST(req: NextRequest, { params }: Params) {
  const { id, action } = await params;
  if (!["post", "apply", "void"].includes(action)) return NextResponse.json({ error: `Unknown credit memo action "${action}".`, code: "NOT_FOUND" }, { status: 404 });
  return creditMutation(req, (client, body) => {
    const token = typeof body.stateToken === "string" ? body.stateToken : null;
    if (action === "post") return postCreditMemo(client, id, token);
    if (action === "void") return voidCreditMemo(client, id, token);
    if (typeof body.invoiceId !== "string" || !body.invoiceId) throw new BadInputError("Choose an invoice.");
    return applyCreditMemo(client, id, { invoiceId: body.invoiceId, amount: Number(body.amount), invoiceToken: typeof body.invoiceToken === "string" ? body.invoiceToken : null, token });
  }, `Failed to ${action} the credit memo`);
}
