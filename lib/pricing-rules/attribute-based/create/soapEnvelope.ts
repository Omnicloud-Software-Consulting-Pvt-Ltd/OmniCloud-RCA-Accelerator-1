/**
 * Metadata API SOAP envelope bodies + response parsing for deploy/retrieve.
 *
 * `SalesforceClient.metadataSoapCall()` (lib/salesforce/client.ts) owns
 * auth + fault detection; everything here is pure request/response shape,
 * parsed via targeted regex rather than a full XML parser (see xmlBlocks.ts
 * for why).
 *
 * The Metadata API type used for Pricing Procedures (Expression Sets) is
 * `ExpressionSetDefinition`.
 */

import type { SalesforceClient } from "@/lib/salesforce/client";
import { normalizeApiVersionNumber } from "@/lib/salesforce/client";

export const EXPRESSION_SET_METADATA_TYPE = "ExpressionSetDefinition";

function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`));
  return m ? m[1].trim() : null;
}
function extractAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>`, "g");
  return xml.match(re) ?? [];
}

export interface AsyncResultInfo {
  id: string;
  done: boolean;
  state: string | null;
}

export function parseAsyncResult(xml: string): AsyncResultInfo {
  const id = extractTag(xml, "id") ?? "";
  const done = extractTag(xml, "done") === "true";
  const state = extractTag(xml, "state");
  return { id, done, state };
}

export interface ComponentFailure {
  fileName: string | null;
  fullName: string | null;
  problem: string | null;
  componentType: string | null;
  problemType: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

/** One `<componentSuccesses>` entry from a real `checkDeployStatus` response — the Salesforce-assigned
 * identity of a successfully deployed component. Part 3 — this is the actual deployment result identity
 * (id/fullName/componentType), never reconstructed from the UI-supplied name; a caller should prefer
 * this over a separate post-deploy SOQL re-query wherever Salesforce actually returns it. */
export interface ComponentSuccess {
  id: string | null;
  fullName: string | null;
  componentType: string | null;
  fileName: string | null;
  created: boolean;
  changed: boolean;
}

export interface DeployStatusInfo {
  id: string;
  done: boolean;
  success: boolean;
  status: string | null;
  numberComponentsDeployed: number;
  numberComponentErrors: number;
  errorMessage: string | null;
  componentFailures: ComponentFailure[];
  /** Every `<componentSuccesses>` entry Salesforce actually returned — previously parsed nowhere, so
   * the deploy response's own Id/fullName for the deployed ExpressionSetDefinition was discarded and a
   * separate DeveloperName-based SOQL re-query was the only way to recover it. */
  componentSuccesses: ComponentSuccess[];
  /** The exact raw SOAP checkDeployStatus response XML this was parsed from, carried alongside the parsed fields so a caller can fall back to it when componentFailures is empty. */
  rawXml: string;
}

export function parseDeployStatus(xml: string): DeployStatusInfo {
  const componentFailures = extractAllBlocks(xml, "componentFailures").map(b => {
    const lineNumberRaw = extractTag(b, "lineNumber");
    const columnNumberRaw = extractTag(b, "columnNumber");
    return {
      fileName: extractTag(b, "fileName"),
      fullName: extractTag(b, "fullName"),
      problem: extractTag(b, "problem"),
      componentType: extractTag(b, "componentType"),
      problemType: extractTag(b, "problemType"),
      lineNumber: lineNumberRaw != null ? Number(lineNumberRaw) : null,
      columnNumber: columnNumberRaw != null ? Number(columnNumberRaw) : null,
    };
  });
  const componentSuccesses = extractAllBlocks(xml, "componentSuccesses").map(b => ({
    id: extractTag(b, "id"),
    fullName: extractTag(b, "fullName"),
    componentType: extractTag(b, "componentType"),
    fileName: extractTag(b, "fileName"),
    created: extractTag(b, "created") === "true",
    changed: extractTag(b, "changed") === "true",
  }));
  return {
    id: extractTag(xml, "id") ?? "",
    done: extractTag(xml, "done") === "true",
    success: extractTag(xml, "success") === "true",
    status: extractTag(xml, "status"),
    numberComponentsDeployed: Number(extractTag(xml, "numberComponentsDeployed") ?? 0),
    numberComponentErrors: Number(extractTag(xml, "numberComponentErrors") ?? 0),
    errorMessage: extractTag(xml, "errorMessage") ?? extractTag(xml, "message"),
    componentFailures,
    componentSuccesses,
    rawXml: xml,
  };
}

export interface RetrieveStatusInfo {
  id: string;
  done: boolean;
  success: boolean;
  zipFileBase64: string | null;
  errorMessage: string | null;
  messages: { fileName: string | null; problem: string | null }[];
}

export function parseRetrieveStatus(xml: string): RetrieveStatusInfo {
  const messages = extractAllBlocks(xml, "messages").map(b => ({
    fileName: extractTag(b, "fileName"),
    problem: extractTag(b, "problem"),
  }));
  return {
    id: extractTag(xml, "id") ?? "",
    done: extractTag(xml, "done") === "true",
    success: extractTag(xml, "success") === "true",
    zipFileBase64: extractTag(xml, "zipFile"),
    errorMessage: extractTag(xml, "errorMessage") ?? extractTag(xml, "message"),
    messages,
  };
}

/* ── Deploy ── */
export async function metadataDeploy(client: SalesforceClient, zipBase64: string): Promise<AsyncResultInfo> {
  const body =
    `<deploy xmlns="http://soap.sforce.com/2006/04/metadata">` +
    `<zipFile>${zipBase64}</zipFile>` +
    `<deployOptions>` +
    `<allowMissingFiles>false</allowMissingFiles>` +
    `<autoUpdatePackage>false</autoUpdatePackage>` +
    `<checkOnly>false</checkOnly>` +
    `<ignoreWarnings>true</ignoreWarnings>` +
    `<purgeOnDelete>false</purgeOnDelete>` +
    `<rollbackOnError>true</rollbackOnError>` +
    `<singlePackage>true</singlePackage>` +
    `</deployOptions>` +
    `</deploy>`;
  const res = await client.metadataSoapCall("deploy", body);
  client.logDebug("deploy-response", `Raw SOAP deploy() response:\n${res}`);
  return parseAsyncResult(res);
}

export async function metadataCheckDeployStatus(client: SalesforceClient, asyncProcessId: string): Promise<DeployStatusInfo> {
  const body =
    `<checkDeployStatus xmlns="http://soap.sforce.com/2006/04/metadata">` +
    `<asyncProcessId>${asyncProcessId}</asyncProcessId>` +
    `<includeDetails>true</includeDetails>` +
    `</checkDeployStatus>`;
  const res = await client.metadataSoapCall("checkDeployStatus", body);
  client.logDebug("deploy-response", `Raw SOAP checkDeployStatus() response:\n${res}`);
  return parseDeployStatus(res);
}

export async function pollDeployStatus(
  client: SalesforceClient,
  asyncProcessId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<DeployStatusInfo> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  for (;;) {
    const status = await metadataCheckDeployStatus(client, asyncProcessId);
    if (status.done) return status;
    if (Date.now() - start > timeoutMs) {
      return { ...status, done: true, success: false, errorMessage: status.errorMessage ?? "Deploy status polling timed out." };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/* ── Retrieve ── */
export async function metadataRetrieve(client: SalesforceClient, members: string[], typeName = EXPRESSION_SET_METADATA_TYPE): Promise<AsyncResultInfo> {
  const membersXml = members.map(m => `<types><members>${m}</members><name>${typeName}</name></types>`).join("");
  const versionNumber = normalizeApiVersionNumber(client.apiVersion);
  const body =
    `<retrieve xmlns="http://soap.sforce.com/2006/04/metadata">` +
    `<retrieveRequest>` +
    `<apiVersion>${versionNumber}</apiVersion>` +
    `<singlePackage>true</singlePackage>` +
    `<unpackaged>${membersXml}<version>${versionNumber}</version></unpackaged>` +
    `</retrieveRequest>` +
    `</retrieve>`;
  const res = await client.metadataSoapCall("retrieve", body);
  return parseAsyncResult(res);
}

export async function metadataCheckRetrieveStatus(client: SalesforceClient, asyncProcessId: string): Promise<RetrieveStatusInfo> {
  const body =
    `<checkRetrieveStatus xmlns="http://soap.sforce.com/2006/04/metadata">` +
    `<asyncProcessId>${asyncProcessId}</asyncProcessId>` +
    `<includeZip>true</includeZip>` +
    `</checkRetrieveStatus>`;
  const res = await client.metadataSoapCall("checkRetrieveStatus", body);
  return parseRetrieveStatus(res);
}

export async function pollRetrieveStatus(
  client: SalesforceClient,
  asyncProcessId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<RetrieveStatusInfo> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  for (;;) {
    const status = await metadataCheckRetrieveStatus(client, asyncProcessId);
    if (status.done) return status;
    if (Date.now() - start > timeoutMs) {
      return { ...status, done: true, success: false, errorMessage: status.errorMessage ?? "Retrieve status polling timed out." };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
