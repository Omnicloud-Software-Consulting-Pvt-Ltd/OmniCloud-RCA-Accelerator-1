import type { NextRequest } from "next/server";
import { InputError, contractLabel, docuSignRoute } from "@/lib/contracts/docusign/server/context";
import { loadDocumentsForSending } from "@/lib/contracts/docusign/server/contractFiles";
import { buildEnvelopeDefinition, createEnvelope, getContractEnvelope, listContractEnvelopes } from "@/lib/contracts/docusign/envelopes";
import { parseSendRequest, validateSendRequest } from "@/lib/contracts/docusign/validation";

type Params = { params: Promise<{ id: string }> };

// GET /api/contracts/[id]/signature/envelopes — envelopes sent for this contract, read live from DocuSign.
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return docuSignRoute(req, { contractId: id }, async ({ api, contract, orgKey }) => ({ envelopes: await listContractEnvelopes(api, contract!.id, orgKey) }));
}

// POST /api/contracts/[id]/signature/envelopes { confirmed: true, documentIds, recipients, emailSubject, emailMessage, companyName? }
// Validates everything on the server, then creates AND sends the envelope from the connected DocuSign account. Success is reported
// only when DocuSign returns an envelope Id.
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return docuSignRoute(req, { contractId: id }, async ({ sf, api, contract, orgKey, conn }) => {
    if (body?.confirmed !== true) throw new InputError("Sending for signature emails real people — confirm it first (confirmed: true).", 400, "CONFIRMATION_REQUIRED");
    const request = parseSendRequest(body);
    const c = contract!;
    const placeholders = { ContractName: contractLabel(c), ContractNumber: c.contractNumber ?? "", AccountName: c.accountName ?? "", CompanyName: request.companyName ?? "" };
    const issues = validateSendRequest(request, { ...placeholders, RecipientName: request.recipients[0]?.name ?? "" });
    if (issues.length) throw new InputError(issues[0].message, 422, "INVALID_SIGNATURE_REQUEST", issues);

    const documents = await loadDocumentsForSending(sf, c.id, request.documentIds);
    const definition = buildEnvelopeDefinition({ contractId: c.id, orgKey, documents, recipients: request.recipients, emailSubject: request.emailSubject, emailMessage: request.emailMessage, placeholders });
    const created = await createEnvelope(api, definition);
    // Read it back so the user sees DocuSign's own view of what was sent (best effort — the envelope Id above is already confirmed).
    const view = await getContractEnvelope(api, created.envelopeId, c.id, orgKey).then(r => r.view).catch(() => null);
    return {
      envelope: created,
      view,
      sentFrom: { accountName: conn.accountName, accountId: conn.accountId, userName: conn.userName, userEmail: conn.userEmail, environment: conn.environment },
      message: `DocuSign ${created.status === "sent" ? "sent" : `accepted (status "${created.status}")`} envelope ${created.envelopeId}.`,
    };
  });
}
