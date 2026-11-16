import { NextRequest, NextResponse } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireBillingClient } from "@/lib/billing/server/discovery";
import { billingErrorResponse } from "@/lib/billing/server/errors";
import { SalesforceCallError } from "@/lib/billing/server/billingDocuments";
import { PolicyNotFoundError, RelationshipMissingError } from "@/lib/policyAssignment/server";
import { isPolicyKind, POLICY_KIND_LABELS, type PolicyKind } from "@/lib/policyAssignment/types";

export type KindParams = { params: Promise<{ kind: string }> };

/**
 * Shared handler for /api/policy-assignment/[kind]/*: the app's existing Salesforce session (Billing → billing API version,
 * Tax → taxes version), an unknown kind is a 404, and Salesforce's own error message is passed through.
 */
export async function policyRoute(req: NextRequest, { params }: KindParams, run: (client: SalesforceClient, kind: PolicyKind) => Promise<unknown>): Promise<NextResponse> {
  const { kind } = await params;
  if (!isPolicyKind(kind)) return NextResponse.json({ success: false, code: "UNKNOWN_POLICY_KIND", error: `Unknown policy type "${kind}" — use billing or tax.` }, { status: 404 });
  const auth = requireBillingClient(req, { taxes: kind === "tax" });
  if ("unauthorized" in auth) return auth.unauthorized;
  try {
    const out = await run(auth.client, kind);
    if (out instanceof NextResponse) return out;
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof RelationshipMissingError) return NextResponse.json({ success: false, code: "RELATIONSHIP_MISSING", error: err.message }, { status: 422 });
    if (err instanceof PolicyNotFoundError) return NextResponse.json({ success: false, code: "POLICY_NOT_FOUND", error: err.message }, { status: 404 });
    if (err instanceof SalesforceCallError && err.status !== 401) {
      const first = err.errors[0];
      return NextResponse.json({ success: false, code: first?.errorCode ?? "SALESFORCE_ERROR", error: `Salesforce rejected the request: ${err.message}` }, { status: err.status === 403 ? 403 : 422 });
    }
    return billingErrorResponse(err, `Bulk ${POLICY_KIND_LABELS[kind].policy} assignment failed`, { objectLabel: "Product" });
  }
}
