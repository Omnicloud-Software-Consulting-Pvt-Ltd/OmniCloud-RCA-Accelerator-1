import { NextResponse, type NextRequest } from "next/server";
import { InputError, contractLabel, docuSignRoute } from "@/lib/contracts/docusign/server/context";
import { storeSignedCopies } from "@/lib/contracts/docusign/server/contractFiles";
import {
  correctRecipient, downloadCertificate, downloadCombinedSigned, downloadSignedDocument, getContractEnvelope, resendEnvelope, voidEnvelope,
} from "@/lib/contracts/docusign/envelopes";
import { isEnvelopeId } from "@/lib/contracts/docusign/signedDocuments";
import { assertActionAllowed } from "@/lib/contracts/docusign/status";
import type { EnvelopeAction } from "@/lib/contracts/docusign/types";
import { LIMITS, isValidEmail } from "@/lib/contracts/docusign/validation";

type Params = { params: Promise<{ id: string; envelopeId: string; action: string }> };

const POST_ACTIONS = ["resend", "void", "correct", "store"] as const;
const GET_ACTIONS = { signed: "download-signed", certificate: "download-certificate" } as const;

/**
 * Every action first re-reads the envelope from DocuSign (it must belong to this contract + org) and checks the action is allowed in
 * its CURRENT state; DocuSign then enforces its own permissions on top.
 */

// GET .../[envelopeId]/signed[?documentId=] | .../[envelopeId]/certificate — downloads (completed envelopes only).
export async function GET(req: NextRequest, { params }: Params) {
  const { id, envelopeId, action } = await params;
  const kind = GET_ACTIONS[action as keyof typeof GET_ACTIONS];
  return docuSignRoute(req, { contractId: id }, async ({ api, contract, orgKey }) => {
    if (!kind) throw new InputError("Unknown download.", 404, "NOT_FOUND");
    if (!isEnvelopeId(envelopeId)) throw new InputError("Invalid envelope Id.");
    const { view } = await getContractEnvelope(api, envelopeId, contract!.id, orgKey);
    const blocked = assertActionAllowed(view.status, kind);
    if (blocked) throw new InputError(blocked, 409, "ENVELOPE_NOT_COMPLETED");
    const documentId = req.nextUrl.searchParams.get("documentId");
    if (documentId && !view.documents.some(d => d.documentId === documentId)) throw new InputError("That document isn't part of this envelope.", 404, "NOT_FOUND");
    const file = kind === "download-certificate" ? await downloadCertificate(api, envelopeId) : documentId ? await downloadSignedDocument(api, envelopeId, documentId) : await downloadCombinedSigned(api, envelopeId);
    const base = (contract!.contractNumber ? `Contract-${contract!.contractNumber}` : "Contract").replace(/[^A-Za-z0-9._-]/g, "-");
    const filename = `${base}-${kind === "download-certificate" ? "Certificate-of-Completion" : "Signed"}.pdf`;
    return new NextResponse(new Uint8Array(file.buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
  });
}

// POST .../resend | .../void { reason } | .../correct { recipientId, name, email } | .../store
export async function POST(req: NextRequest, { params }: Params) {
  const { id, envelopeId, action } = await params;
  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return docuSignRoute(req, { contractId: id }, async ({ sf, api, contract, orgKey }) => {
    if (!(POST_ACTIONS as readonly string[]).includes(action)) throw new InputError("Unknown action.", 404, "NOT_FOUND");
    if (!isEnvelopeId(envelopeId)) throw new InputError("Invalid envelope Id.");
    if (action !== "store" && body.confirmed !== true) throw new InputError("This changes the envelope in DocuSign — confirm it first (confirmed: true).", 400, "CONFIRMATION_REQUIRED");
    const { view } = await getContractEnvelope(api, envelopeId, contract!.id, orgKey);
    const blocked = assertActionAllowed(view.status, action as EnvelopeAction);
    if (blocked) throw new InputError(blocked, 409, "ACTION_NOT_ALLOWED");

    if (action === "resend") {
      await resendEnvelope(api, envelopeId);
      return { message: "DocuSign resent the signing email to everyone who still needs to act." };
    }
    if (action === "void") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) throw new InputError("Tell recipients why the envelope is being voided.", 422, "REASON_REQUIRED");
      if (reason.length > LIMITS.voidReason) throw new InputError(`The reason must be ${LIMITS.voidReason} characters or fewer.`, 422, "REASON_TOO_LONG");
      await voidEnvelope(api, envelopeId, reason);
      return { message: "The envelope was voided. Recipients can no longer sign it." };
    }
    if (action === "correct") {
      const recipient = view.recipients.find(r => r.recipientId === String(body.recipientId ?? ""));
      if (!recipient) throw new InputError("That recipient isn't on this envelope.", 404, "RECIPIENT_NOT_FOUND");
      if (!recipient.canCorrect) throw new InputError(`${recipient.name} has already finished, so their details can't be changed.`, 409, "RECIPIENT_FINISHED");
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!name || name.length > LIMITS.name || /[<>]/.test(name)) throw new InputError("Enter the recipient's full name (up to 100 characters, no < or >).", 422, "INVALID_NAME");
      if (!isValidEmail(email)) throw new InputError(`"${email}" isn't a valid email address.`, 422, "INVALID_EMAIL");
      await correctRecipient(api, envelopeId, { recipientId: recipient.recipientId, type: recipient.type, name, email });
      return { message: `Updated the recipient to ${name} (${email}) and resent the signing email.` };
    }
    const files = await storeSignedCopies(sf, api, contract!.id, envelopeId, contractLabel(contract!));
    const added = files.filter(f => !f.alreadyStored).length;
    return { files, message: added ? `Saved ${added} file${added === 1 ? "" : "s"} to this contract in Salesforce.` : "The signed copies were already saved to this contract — nothing was duplicated." };
  });
}
