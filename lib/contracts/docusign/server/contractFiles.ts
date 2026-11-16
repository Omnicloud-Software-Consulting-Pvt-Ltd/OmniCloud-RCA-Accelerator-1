import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import type { DocuSignApi } from "@/lib/contracts/docusign/client";
import { downloadCertificate, downloadSignedDocument, listEnvelopeDocuments, type EnvelopeDocumentInput } from "@/lib/contracts/docusign/envelopes";
import { parseSignedFileDescription, planSignedFiles, signedFileDescription } from "@/lib/contracts/docusign/signedDocuments";
import type { SignableDocument, StoredSignedFile } from "@/lib/contracts/docusign/types";
import { documentCompatibility, LIMITS } from "@/lib/contracts/docusign/validation";
import { InputError } from "@/lib/contracts/docusign/server/context";

/**
 * Salesforce Files side of signing — reuses the Contracts module's existing storage (ContentVersion linked to the Contract through
 * ContentDocumentLink). Every document Id coming from the browser is checked against THIS contract's links, so a user can never
 * send or read a file that belongs to another record.
 */

interface VersionRow { Id: string; ContentDocumentId: string; Title: string; FileExtension: string | null; ContentSize: number | null; CreatedDate: string; VersionNumber: string | number | null; IsLatest: boolean; Description: string | null }

async function contractVersions(sf: SalesforceClient, contractId: string, latestOnly: boolean): Promise<VersionRow[]> {
  const links = await sf.query<{ ContentDocumentId: string }>(`SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${soqlEscape(contractId)}'`);
  const docIds = [...new Set(links.records.map(r => r.ContentDocumentId))];
  if (!docIds.length) return [];
  const rows: VersionRow[] = [];
  for (let i = 0; i < docIds.length; i += 200) {
    const ids = docIds.slice(i, i + 200).map(id => `'${soqlEscape(id)}'`).join(",");
    const res = await sf.query<VersionRow>(`SELECT Id, ContentDocumentId, Title, FileExtension, ContentSize, CreatedDate, VersionNumber, IsLatest, Description FROM ContentVersion WHERE ContentDocumentId IN (${ids})${latestOnly ? " AND IsLatest = true" : ""} ORDER BY CreatedDate DESC`);
    rows.push(...res.records);
  }
  return rows;
}

/** The contract's documents that can be sent: latest version of each file, excluding signed copies / certificates already stored. */
export async function listSignableDocuments(sf: SalesforceClient, contractId: string): Promise<SignableDocument[]> {
  const rows = await contractVersions(sf, contractId, true);
  return rows
    .filter(r => !parseSignedFileDescription(r.Description))
    .map(r => {
      const size = Number(r.ContentSize) || 0;
      const c = documentCompatibility(r.FileExtension, size);
      return {
        contentVersionId: r.Id,
        contentDocumentId: r.ContentDocumentId,
        title: r.Title,
        fileExtension: (r.FileExtension ?? "").toLowerCase(),
        sizeBytes: size,
        createdDate: r.CreatedDate,
        versionNumber: r.VersionNumber != null ? Number(r.VersionNumber) : null,
        compatible: c.compatible,
        incompatibleReason: c.reason,
      };
    });
}

/** Loads the selected files for an envelope — only files linked to this contract, compatible, and within DocuSign's size limits. */
export async function loadDocumentsForSending(sf: SalesforceClient, contractId: string, ids: string[]): Promise<EnvelopeDocumentInput[]> {
  const rows = await contractVersions(sf, contractId, false);
  const byId = new Map(rows.map(r => [r.Id, r]));
  const issues: { field: string; message: string }[] = [];
  let total = 0;
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) { issues.push({ field: "documentIds", message: `Document ${id} isn't attached to this contract (it may have been deleted).` }); continue; }
    const size = Number(r.ContentSize) || 0;
    const c = documentCompatibility(r.FileExtension, size);
    if (!c.compatible) issues.push({ field: "documentIds", message: `${r.Title}: ${c.reason}` });
    total += size;
  }
  if (total > LIMITS.maxEnvelopeBytes) issues.push({ field: "documentIds", message: "The selected documents add up to more than 25 MB — send fewer documents at once." });
  if (issues.length) throw new InputError(issues[0].message, 422, "INVALID_DOCUMENTS", issues);

  const out: EnvelopeDocumentInput[] = [];
  for (const id of ids) {
    const r = byId.get(id)!;
    const { buffer } = await sf.getBinary(`/sobjects/ContentVersion/${id}/VersionData`);
    out.push({ title: r.Title, fileExtension: (r.FileExtension ?? "pdf").toLowerCase(), base64: buffer.toString("base64") });
  }
  return out;
}

/**
 * Downloads every signed document of a COMPLETED envelope plus its certificate of completion and stores each as a new file on the
 * Contract. Files already stored for this envelope are reused, never duplicated (checked against what's on the Contract right now).
 */
export async function storeSignedCopies(sf: SalesforceClient, api: DocuSignApi, contractId: string, envelopeId: string, envelopeLabel: string): Promise<StoredSignedFile[]> {
  const [documents, existing] = await Promise.all([listEnvelopeDocuments(api, envelopeId), contractVersions(sf, contractId, true)]);
  const plan = planSignedFiles(envelopeId, documents, existing.map(r => ({ contentVersionId: r.Id, title: r.Title, description: r.Description })), envelopeLabel);
  const out: StoredSignedFile[] = [];
  for (const p of plan) {
    if (p.existing) {
      out.push({ kind: p.marker.kind, envelopeId, documentId: p.marker.documentId, contentVersionId: p.existing.contentVersionId, title: p.existing.title, alreadyStored: true });
      continue;
    }
    const file = p.marker.kind === "signed" ? await downloadSignedDocument(api, envelopeId, p.marker.documentId!) : await downloadCertificate(api, envelopeId);
    const created = await sf.createRecord("ContentVersion", {
      Title: p.title,
      PathOnClient: `${p.title.replace(/[\\/:*?"<>|]/g, "-")}.pdf`,
      VersionData: file.buffer.toString("base64"),
      FirstPublishLocationId: contractId,
      Description: signedFileDescription(p.marker),
    });
    out.push({ kind: p.marker.kind, envelopeId, documentId: p.marker.documentId, contentVersionId: created.id, title: p.title, alreadyStored: false });
  }
  return out;
}
