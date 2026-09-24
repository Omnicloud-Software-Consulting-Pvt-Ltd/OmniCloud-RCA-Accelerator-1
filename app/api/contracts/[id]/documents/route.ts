import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { listContractDocuments } from "@/lib/contracts/documents/contentVersion";

type Params = { params: Promise<{ id: string }> };

// GET /api/contracts/[id]/documents — Document History: real ContentVersion
// rows for this Contract via ContentDocumentLink (§4.4, §4.5).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;

  try {
    const documents = await listContractDocuments(auth.client, id);
    // Temporary sanitized trace (§Phase 1) — proves this list comes straight
    // from a live SOQL query against ContentDocumentLink/ContentVersion,
    // never localStorage/cache, and records which Salesforce instance
    // answered it so a later mismatch (e.g. Test C, run in a different
    // browser session) is provable rather than assumed.
    for (const doc of documents) {
      console.log(
        `[GENERATED DOCUMENT SOURCE]\n` +
        `contractId=${id}\n` +
        `contentVersionId=${doc.contentVersionId}\n` +
        `contentDocumentId=${doc.contentDocumentId}\n` +
        `instanceUrl=${auth.client.instanceUrl}\n` +
        `source=live-salesforce-soql`,
      );
    }
    return NextResponse.json({ success: true, documents });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list contract documents");
  }
}
