import type { SignatureStage, SignatureTimelineEntry } from "@/lib/contracts/types";

/**
 * ============================================================================
 * TEMPORARY DEVELOPMENT STORAGE — NOT PRODUCTION-PERSISTENT.
 * ============================================================================
 * Same accepted limitation as lib/contracts/docusign/connectionStore.ts (see
 * that file's doc comment for the full rationale): no Postgres/KV/secrets
 * manager is provisioned in this app yet, so this is in-memory only, lost on
 * server restart/redeploy/cold start, and not shared across instances.
 *
 * WHY THIS STORE EXISTS AT ALL: lib/contracts/docusign/localSignatureStore.ts
 * (recipients, email template, draft/sent bookkeeping) lives in the BROWSER's
 * localStorage — there is no server-side record of a signature request at
 * all today. But a DocuSign Connect webhook is called BY DOCUSIGN, with no
 * browser involved and no Salesforce session cookie — it has no way to reach
 * into a specific user's browser storage. So the moment an envelope is sent,
 * this store records just enough server-side state (which Contract/document
 * it belongs to, each recipient's role, and the DocuSign-derived status
 * ladder) for the webhook — and the manual "Refresh DocuSign Status"
 * fallback — to have something to update. `orgId` is still always the
 * Salesforce org's instanceUrl, matching connectionStore.ts's tenancy model.
 *
 * Anchored on `globalThis` for the same empirically-confirmed reason as
 * connectionStore.ts: separate route files can otherwise get separate
 * module evaluations of this file under this app's Next.js 16 + Turbopack
 * dev server.
 */

export interface TrackedSignatureRecipient {
  /** Matches the DocuSign recipientId assigned at send time (createAndSendEnvelope's `String(i + 1)`) — NOT matched by email, since DocuSign diagnostics only ever expose a masked email. */
  recipientId: string;
  name: string;
  email: string;
  role: string;
}

export interface TrackedSignatureEnvelope {
  envelopeId: string;
  orgId: string;
  contractId: string;
  sourceContentVersionId: string;
  documentTitle: string;
  recipients: TrackedSignatureRecipient[];
  /** The forward-only stage ladder (§5.4/§7) — never regresses; see lib/contracts/docusign/statusSync.ts. */
  stage: SignatureStage;
  /** DocuSign's own raw envelope status string (e.g. "sent", "completed", "voided") — independent of `stage`, never itself used to move the ladder backward. */
  envelopeStatus: string | null;
  timeline: SignatureTimelineEntry[];
  signedContentVersionId: string | null;
  /** Guards against writing the same Salesforce Contract signed-date field twice (§10) — set once a writeback for that role has actually succeeded. */
  salesforceSignedDatesWritten: { company: boolean; customer: boolean };
  createdAt: string;
  updatedAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __omnicloudSignatureStatusStore: Map<string, TrackedSignatureEnvelope> | undefined;
}
if (!globalThis.__omnicloudSignatureStatusStore) {
  globalThis.__omnicloudSignatureStatusStore = new Map();
}
const records = globalThis.__omnicloudSignatureStatusStore;

/** Called once, immediately after a real envelope is created and sent — never re-called for the same envelopeId. */
export async function trackSentEnvelope(input: {
  envelopeId: string;
  orgId: string;
  contractId: string;
  sourceContentVersionId: string;
  documentTitle: string;
  recipients: TrackedSignatureRecipient[];
  envelopeStatus: string | null;
  sentDateTime: string | null;
}): Promise<TrackedSignatureEnvelope> {
  const now = new Date().toISOString();
  const record: TrackedSignatureEnvelope = {
    envelopeId: input.envelopeId,
    orgId: input.orgId,
    contractId: input.contractId,
    sourceContentVersionId: input.sourceContentVersionId,
    documentTitle: input.documentTitle,
    recipients: input.recipients,
    stage: "Sent",
    envelopeStatus: input.envelopeStatus,
    timeline: [{
      stage: "Sent",
      at: input.sentDateTime ?? now,
      detail: `Envelope ${input.envelopeId} sent via DocuSign.`,
      source: "system",
      dedupeKey: `sent:${input.envelopeId}`,
    }],
    signedContentVersionId: null,
    salesforceSignedDatesWritten: { company: false, customer: false },
    createdAt: now,
    updatedAt: now,
  };
  records.set(input.envelopeId, record);
  return record;
}

export async function getTrackedEnvelope(envelopeId: string): Promise<TrackedSignatureEnvelope | null> {
  return records.get(envelopeId) ?? null;
}

export async function updateTrackedEnvelope(envelopeId: string, patch: Partial<TrackedSignatureEnvelope>): Promise<TrackedSignatureEnvelope | null> {
  const current = records.get(envelopeId);
  if (!current) return null;
  const updated: TrackedSignatureEnvelope = { ...current, ...patch, updatedAt: new Date().toISOString() };
  records.set(envelopeId, updated);
  return updated;
}
