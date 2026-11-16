/**
 * Signed copies are stored as NEW Salesforce Files on the Contract (the original generated document is never overwritten). Each
 * stored file's ContentVersion.Description carries a marker naming the envelope (and document), which is how the app knows a copy
 * is already stored (idempotent "Save to Salesforce") and how Documents shows it as signed. Pure — no I/O.
 */

export type SignedFileKind = "signed" | "certificate";
export interface SignedFileMarker { kind: SignedFileKind; envelopeId: string; documentId: string | null }

const ENVELOPE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isEnvelopeId = (v: unknown): v is string => typeof v === "string" && ENVELOPE_ID.test(v);

export function signedFileDescription(m: SignedFileMarker): string {
  return m.kind === "signed"
    ? `DocuSign signed copy | envelope=${m.envelopeId} | document=${m.documentId}`
    : `DocuSign certificate of completion | envelope=${m.envelopeId}`;
}

export function parseSignedFileDescription(description: string | null | undefined): SignedFileMarker | null {
  if (!description) return null;
  const signed = /^DocuSign signed copy \| envelope=([0-9a-f-]{36}) \| document=([A-Za-z0-9-]{1,40})$/i.exec(description.trim());
  if (signed) return { kind: "signed", envelopeId: signed[1].toLowerCase(), documentId: signed[2] };
  const cert = /^DocuSign certificate of completion \| envelope=([0-9a-f-]{36})$/i.exec(description.trim());
  if (cert) return { kind: "certificate", envelopeId: cert[1].toLowerCase(), documentId: null };
  return null;
}

export interface ExistingFile { contentVersionId: string; title: string; description: string | null }
export interface PlannedFile { marker: SignedFileMarker; title: string; existing: ExistingFile | null }

/** Which files to upload for an envelope: every signed document plus the certificate, minus those already stored on the Contract. */
export function planSignedFiles(envelopeId: string, documents: { documentId: string; name: string }[], existing: ExistingFile[], envelopeLabel: string): PlannedFile[] {
  const id = envelopeId.toLowerCase();
  const stored = existing.map(f => ({ f, m: parseSignedFileDescription(f.description) })).filter(x => x.m && x.m.envelopeId === id);
  const find = (kind: SignedFileKind, documentId: string | null) => stored.find(x => x.m!.kind === kind && x.m!.documentId === documentId)?.f ?? null;
  const base = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return [
    ...documents.map(d => ({ marker: { kind: "signed" as const, envelopeId: id, documentId: d.documentId }, title: `${base(d.name)} - Signed`, existing: find("signed", d.documentId) })),
    { marker: { kind: "certificate", envelopeId: id, documentId: null }, title: `${envelopeLabel} - Certificate of Completion`, existing: find("certificate", null) },
  ];
}
