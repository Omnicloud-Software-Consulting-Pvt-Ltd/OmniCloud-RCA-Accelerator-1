import type { NextRequest } from "next/server";
import { docuSignRoute } from "@/lib/contracts/docusign/server/context";
import { listSignableDocuments } from "@/lib/contracts/docusign/server/contractFiles";

type Params = { params: Promise<{ id: string }> };

// GET /api/contracts/[id]/signature/documents — this contract's documents that can be sent for signature (latest versions,
// with type/size/compatibility). Requires a connected DocuSign account and a contract visible to the user.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return docuSignRoute(req, { contractId: id }, async ({ sf, contract }) => ({ documents: await listSignableDocuments(sf, contract!.id) }));
}
