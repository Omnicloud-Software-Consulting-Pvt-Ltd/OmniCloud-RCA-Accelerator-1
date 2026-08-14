import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { updateTrackedEnvelope } from "@/lib/contracts/docusign/signatureStatusStore";
import { syncEnvelopeStatus, latestTimestampForStage, SignatureTrackingError } from "@/lib/contracts/docusign/statusSync";
import { resolveContractFieldSchema } from "@/lib/contracts/metadata/contractFields";
import { DocuSignError } from "@/lib/contracts/docusign/client";

type Params = { params: Promise<{ envelopeId: string }> };

interface SalesforceWritebackResult {
  attempted: boolean;
  companyDateWritten: boolean;
  customerDateWritten: boolean;
  /** Explains any field this attempt could NOT write, and why — e.g. "no safe field mapping exists." Never invents a Contract field API name. */
  notes: string[];
}

// POST /api/contracts/docusign/envelopes/[envelopeId]/refresh — the manual
// "Refresh DocuSign Status" fallback (§Phase 8). Webhook delivery can't reach
// localhost without a public HTTPS tunnel, so this is the primary way to
// observe Viewed/Signed/Completed during local development/demo. Uses the
// EXACT SAME status-mapping function (syncEnvelopeStatus /
// computeStageProgress) the webhook receiver uses — they can never diverge.
//
// This is ALSO the only place Salesforce Contract field writeback happens
// (§Phase 10): unlike the webhook (called directly by DocuSign, no
// Salesforce session), this route runs with a real browser-authenticated
// SalesforceClient (requireSFClient), so it can safely write
// CompanySignedDate/CustomerSignedDate once a signer in that role has
// signed. It deliberately does NOT attempt CompanySignedId/CustomerSignedId/
// CustomerSignedTitle — DocuSign only gives us the signer's name/email, not
// a Salesforce User/Contact Id, and guessing one from an email would risk
// writing the WRONG person's Id onto the Contract.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const orgId = client.instanceUrl;
  const { envelopeId } = await params;

  let tracked;
  let diagnostics;
  try {
    ({ tracked, diagnostics } = await syncEnvelopeStatus(orgId, envelopeId, "system"));
  } catch (err) {
    if (err instanceof SignatureTrackingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    if (err instanceof DocuSignError) {
      const body = err.body as { errorCode?: string; message?: string } | null;
      return NextResponse.json({ error: "Failed to refresh DocuSign status.", code: "DOCUSIGN_STATUS_REFRESH_FAILED", docuSignStatus: err.status, docuSignErrorCode: body?.errorCode ?? null, docuSignMessage: body?.message ?? err.message }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to refresh DocuSign status.", code: "DOCUSIGN_STATUS_REFRESH_FAILED" }, { status: 502 });
  }

  const sfWriteback: SalesforceWritebackResult = { attempted: false, companyDateWritten: false, customerDateWritten: false, notes: [] };
  const needsCompanyDate = (tracked.stage === "Company Signed" || tracked.stage === "Completed") && !tracked.salesforceSignedDatesWritten.company;
  const needsCustomerDate = (tracked.stage === "Customer Signed" || tracked.stage === "Completed") && !tracked.salesforceSignedDatesWritten.customer;

  if (needsCompanyDate || needsCustomerDate) {
    sfWriteback.attempted = true;
    try {
      const schema = await resolveContractFieldSchema(client);
      const patch: Record<string, unknown> = {};

      if (needsCompanyDate) {
        if (schema.companySignedDateField) {
          const at = latestTimestampForStage(tracked.timeline, "Company Signed");
          if (at) patch[schema.companySignedDateField.apiName] = at.slice(0, 10);
        } else {
          sfWriteback.notes.push("No safe Salesforce Contract field mapping exists for Company Signed Date in this org.");
        }
      }
      if (needsCustomerDate) {
        if (schema.customerSignedDateField) {
          const at = latestTimestampForStage(tracked.timeline, "Customer Signed");
          if (at) patch[schema.customerSignedDateField.apiName] = at.slice(0, 10);
        } else {
          sfWriteback.notes.push("No safe Salesforce Contract field mapping exists for Customer Signed Date in this org.");
        }
      }
      // CompanySignedId/CustomerSignedId/CustomerSignedTitle are deliberately
      // never written here — DocuSign gives us a signer name/email, not a
      // Salesforce User/Contact Id, and there is no safe way to resolve one
      // from the other without risking the wrong record.
      if (schema.companySignedByField || schema.customerSignedByField) {
        sfWriteback.notes.push("Company/Customer Signed By (a User/Contact reference) is not written automatically — DocuSign only reports the signer's name/email, not a matching Salesforce Id.");
      }

      if (Object.keys(patch).length > 0) {
        await client.updateRecord("Contract", tracked.contractId, patch);
      }

      const updated = await updateTrackedEnvelope(envelopeId, {
        salesforceSignedDatesWritten: {
          company: tracked.salesforceSignedDatesWritten.company || (needsCompanyDate && !!schema.companySignedDateField),
          customer: tracked.salesforceSignedDatesWritten.customer || (needsCustomerDate && !!schema.customerSignedDateField),
        },
      });
      if (updated) tracked = updated;
      sfWriteback.companyDateWritten = needsCompanyDate && !!schema.companySignedDateField;
      sfWriteback.customerDateWritten = needsCustomerDate && !!schema.customerSignedDateField;
    } catch (err) {
      sfWriteback.notes.push(err instanceof Error ? err.message : "Salesforce Contract update failed.");
    }
  }

  return NextResponse.json({
    success: true,
    envelopeId: diagnostics.envelopeId,
    envelopeStatus: diagnostics.envelopeStatus,
    sentDateTime: diagnostics.sentDateTime,
    createdDateTime: diagnostics.createdDateTime,
    statusChangedDateTime: diagnostics.statusChangedDateTime,
    recipients: diagnostics.recipients,
    auditEvents: diagnostics.auditEvents,
    stage: tracked.stage,
    timeline: tracked.timeline,
    signedContentVersionId: tracked.signedContentVersionId,
    salesforceWriteback: sfWriteback,
  });
}
