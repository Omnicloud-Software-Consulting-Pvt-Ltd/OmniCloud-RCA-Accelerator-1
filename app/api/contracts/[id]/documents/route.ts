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
    return NextResponse.json({ success: true, documents });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list contract documents");
  }
}
