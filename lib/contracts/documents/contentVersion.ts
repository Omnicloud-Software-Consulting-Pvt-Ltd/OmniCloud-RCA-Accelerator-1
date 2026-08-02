import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import type { GeneratedDocument } from "@/lib/contracts/types";

/**
 * ContentVersion helpers (§4.4) — Salesforce's own native file versioning IS
 * the document's version history; no separate version table is built here.
 */

/** First generation for a logical document: no contentDocumentId, FirstPublishLocationId = the Contract — Salesforce creates ContentVersion + ContentDocument + the ContentDocumentLink to the Contract in one call. */
export async function createFirstContentVersion(
  client: SalesforceClient,
  opts: { contractId: string; title: string; base64Data: string; pathOnClient: string; templateName: string },
): Promise<{ id: string }> {
  const result = await client.createRecord("ContentVersion", {
    Title: opts.title,
    PathOnClient: opts.pathOnClient,
    VersionData: opts.base64Data,
    FirstPublishLocationId: opts.contractId,
    // Salesforce has no native "template used" field — stash it in Description (§4.4).
    Description: `Generated from template: ${opts.templateName}`,
  });
  return { id: result.id };
}

/** Regeneration: pass the existing contentDocumentId — Salesforce auto-increments VersionNumber on the same ContentDocument. */
export async function createNextContentVersion(
  client: SalesforceClient,
  opts: { contentDocumentId: string; title: string; base64Data: string; pathOnClient: string; templateName: string },
): Promise<{ id: string }> {
  const result = await client.createRecord("ContentVersion", {
    Title: opts.title,
    PathOnClient: opts.pathOnClient,
    VersionData: opts.base64Data,
    ContentDocumentId: opts.contentDocumentId,
    Description: `Generated from template: ${opts.templateName}`,
  });
  return { id: result.id };
}

/** List a Contract's documents via ContentDocumentLink — not just FirstPublishLocationId — so a file attached any other way still surfaces in Document History (§4.4). */
export async function listContractDocuments(client: SalesforceClient, contractId: string): Promise<GeneratedDocument[]> {
  const links = await client.query<{ ContentDocumentId: string }>(
    `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${soqlEscape(contractId)}'`,
  );
  const docIds = [...new Set(links.records.map(r => r.ContentDocumentId))];
  if (docIds.length === 0) return [];

  const idList = docIds.map(id => `'${soqlEscape(id)}'`).join(",");
  const versions = await client.query<{
    Id: string; ContentDocumentId: string; Title: string; VersionNumber: string | number;
    CreatedDate: string; Description: string | null; IsLatest: boolean; CreatedBy: { Name: string } | null;
  }>(
    `SELECT Id, ContentDocumentId, Title, VersionNumber, CreatedDate, Description, IsLatest, CreatedBy.Name FROM ContentVersion WHERE ContentDocumentId IN (${idList}) ORDER BY ContentDocumentId, VersionNumber DESC`,
  );

  return versions.records.map(v => ({
    contentVersionId: v.Id,
    contentDocumentId: v.ContentDocumentId,
    versionNumber: v.VersionNumber != null ? Number(v.VersionNumber) : null,
    title: v.Title,
    templateName: v.Description ? v.Description.replace(/^Generated from template:\s*/, "") : null,
    createdDate: v.CreatedDate,
    createdByName: v.CreatedBy?.Name ?? null,
    isLatest: !!v.IsLatest,
  }));
}

/** Deleting the ContentDocument cascades every ContentVersion and ContentDocumentLink for it — the whole logical document, not just one version. */
export async function deleteContentDocument(client: SalesforceClient, contentDocumentId: string): Promise<void> {
  await client.deleteRecord("ContentDocument", contentDocumentId);
}

/** Proxy download (§4.4) — the app has no browser-level Salesforce session cookie, so the file streams through this server rather than a direct Salesforce URL. */
export async function downloadContentVersion(client: SalesforceClient, contentVersionId: string): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const record = await client.getRecord("ContentVersion", contentVersionId, ["Title", "FileExtension"]);
  const { buffer, contentType } = await client.getBinary(`/sobjects/ContentVersion/${contentVersionId}/VersionData`);
  const ext = ((record.FileExtension as string) || "pdf").toLowerCase();
  const title = (record.Title as string) || "document";
  const filename = title.toLowerCase().endsWith(`.${ext}`) ? title : `${title}.${ext}`;
  return { buffer, filename, contentType: contentType === "application/octet-stream" && ext === "pdf" ? "application/pdf" : contentType };
}
