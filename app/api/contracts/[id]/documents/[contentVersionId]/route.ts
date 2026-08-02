import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { deleteContentDocument } from "@/lib/contracts/documents/contentVersion";

type Params = { params: Promise<{ id: string; contentVersionId: string }> };

// DELETE /api/contracts/[id]/documents/[contentVersionId]?contentDocumentId=...
// Deletes the WHOLE logical document (every version), not just this one
// ContentVersion row — `contentDocumentId` comes from the caller, which
// already has it from listContractDocuments, so no extra lookup is needed here.
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  await params;

  const contentDocumentId = req.nextUrl.searchParams.get("contentDocumentId");
  if (!contentDocumentId) return NextResponse.json({ error: "contentDocumentId is required" }, { status: 400 });

  try {
    await deleteContentDocument(auth.client, contentDocumentId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return sfErrorResponse(err, "Failed to delete this document");
  }
}
