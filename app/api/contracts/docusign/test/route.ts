import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { getActiveDocuSignSession } from "@/lib/contracts/docusign/oauth";
import { getUserInfo } from "@/lib/contracts/docusign/client";

// POST /api/contracts/docusign/test — validate a connection with a real
// identity call (§5.1), not just local expiry-timestamp bookkeeping.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  const session = await getActiveDocuSignSession(orgId);
  if (!session) {
    return NextResponse.json({ success: false, error: "DocuSign is not connected for this organization." }, { status: 400 });
  }

  try {
    const info = await getUserInfo(session.environment, session.accessToken);
    const account = info.accounts.find(a => a.account_id === session.accountId) ?? info.accounts[0] ?? null;
    return NextResponse.json({
      success: true,
      userInfo: { name: info.name, email: info.email },
      account: account ? { id: account.account_id, name: account.account_name } : null,
      environment: session.environment,
    });
  } catch (err) {
    // Sanitized, never the raw DocuSign error body (which could echo back request details) — just a clear reason.
    const status = err instanceof Error && "status" in err ? (err as { status: number }).status : 502;
    const message = status === 401 ? "DocuSign authorization expired." : status === 404 ? "DocuSign account unavailable." : "Unable to reach DocuSign — please try again.";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
