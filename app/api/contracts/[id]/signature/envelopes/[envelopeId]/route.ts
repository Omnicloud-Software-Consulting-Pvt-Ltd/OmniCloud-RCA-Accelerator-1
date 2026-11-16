import type { NextRequest } from "next/server";
import { InputError, docuSignRoute } from "@/lib/contracts/docusign/server/context";
import { getAuditEvents, getContractEnvelope } from "@/lib/contracts/docusign/envelopes";
import { isEnvelopeId } from "@/lib/contracts/docusign/signedDocuments";

type Params = { params: Promise<{ id: string; envelopeId: string }> };

// GET /api/contracts/[id]/signature/envelopes/[envelopeId] — envelope details, recipient progress and DocuSign's audit history.
// Only for an envelope that belongs to this contract and Salesforce org.
export async function GET(req: NextRequest, { params }: Params) {
  const { id, envelopeId } = await params;
  return docuSignRoute(req, { contractId: id }, async ({ api, contract, orgKey }) => {
    if (!isEnvelopeId(envelopeId)) throw new InputError("Invalid envelope Id.");
    const { view } = await getContractEnvelope(api, envelopeId, contract!.id, orgKey);
    const history = await getAuditEvents(api, envelopeId).catch(() => null);
    return { envelope: view, history };
  });
}
