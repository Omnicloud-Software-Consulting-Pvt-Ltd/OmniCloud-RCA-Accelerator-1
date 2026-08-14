import { NextRequest, NextResponse } from "next/server";
import { resolveEmbeddedSigningRedirect } from "@/lib/contracts/docusign/envelope";
import { DocuSignError } from "@/lib/contracts/docusign/client";

type Params = { params: Promise<{ token: string }> };

// GET /api/contracts/docusign/sign/[token] — the ONLY public, unauthenticated
// route in the entire Contracts/DocuSign module. Deliberately has NO
// requireSFClient check: the person clicking this link is an external
// signing recipient with no Salesforce session at all. The opaque token
// itself (see lib/contracts/docusign/embeddedSigningLinkStore.ts) is the
// sole authorization — it is unguessable, scoped to exactly one envelope/
// recipient, and never enumerable.
//
// Mints a BRAND NEW DocuSign recipientView url on every single hit (never
// caches/reuses one) and 302-redirects to it — this is what lets the STABLE
// link in the sender's manually-sent email survive an arbitrary delay before
// the recipient actually clicks it, even though DocuSign's own url expires
// in minutes.
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;
  const returnUrl = new URL("/contracts/sign-complete", req.nextUrl.origin).toString();

  try {
    const view = await resolveEmbeddedSigningRedirect(token, returnUrl);
    if (!view) {
      return NextResponse.json({ error: "This signing link is invalid or has expired. Please contact the sender for a new one." }, { status: 404 });
    }
    return NextResponse.redirect(view.url, { status: 302 });
  } catch (err) {
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: body?.message ?? "DocuSign could not create a signing session for this link." }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Could not open this signing link.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
