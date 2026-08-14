/**
 * Salesforce Lightning record URL — the single place this shape is
 * assembled (server or client), so every "View in Salesforce" button always
 * points at the exact record on the exact org that created it. Mirrors the
 * `${instanceUrl}/lightning/...` convention already used ad hoc elsewhere in
 * this app (e.g. lib/quotes/billing/treatment.ts's `orgSetupUrl`). Never
 * hardcode a Salesforce domain — `instanceUrl` must always come from the
 * connected org's own session/client, never a literal string.
 */
export function buildSalesforceRecordUrl(instanceUrl: string, objectApiName: string, recordId: string): string {
  return `${instanceUrl.replace(/\/+$/, "")}/lightning/r/${objectApiName}/${recordId}/view`;
}

/** The only Salesforce record information ever exposed to the frontend for navigation — no tokens, no secrets. */
export interface CreatedSalesforceRecord {
  objectApiName: string;
  recordId: string;
  recordName: string;
  salesforceUrl: string;
}

export function toCreatedSalesforceRecord(instanceUrl: string, objectApiName: string, recordId: string, recordName: string): CreatedSalesforceRecord {
  return { objectApiName, recordId, recordName, salesforceUrl: buildSalesforceRecordUrl(instanceUrl, objectApiName, recordId) };
}
