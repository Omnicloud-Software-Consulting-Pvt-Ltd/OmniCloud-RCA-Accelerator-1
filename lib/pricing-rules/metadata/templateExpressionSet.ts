/**
 * Retrieve real, already-deployed Expression Set (Pricing Procedure)
 * metadata from the connected org via the Metadata API. Shared by:
 *  - the create-procedure canvas builder (§8.1): clone a template step
 *    whose actionType (e.g. `AttributeDiscount`) can't be hand-authored.
 *  - verify-execution Phase 2: retrieve the deployed procedure's own XML
 *    to extract its ListPrice Decision Table lookup.
 */
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  EXPRESSION_SET_METADATA_TYPE,
  metadataRetrieve,
  pollRetrieveStatus,
} from "./soapEnvelope";
import { findStepsByActionType, type ElementSpan } from "@/lib/pricing-rules/xml/blocks";

export interface RetrievedMetadataFile {
  fileName: string;
  content: string;
}

/** Retrieve one or more ExpressionSetDefinition members (pass `["*"]` for every one in the org) and unzip to raw file contents. */
export async function retrieveExpressionSetDefinitionFiles(
  client: SalesforceClient,
  members: string[],
): Promise<{ files: RetrievedMetadataFile[]; warning?: string }> {
  const asyncResult = await metadataRetrieve(client, members, EXPRESSION_SET_METADATA_TYPE);
  const status = await pollRetrieveStatus(client, asyncResult.id);

  if (!status.success || !status.zipFileBase64) {
    return { files: [], warning: status.errorMessage ?? "Metadata retrieve did not return a zip file." };
  }

  const zip = await JSZip.loadAsync(Buffer.from(status.zipFileBase64, "base64"));
  const files: RetrievedMetadataFile[] = [];
  for (const [fileName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!/expressionSetDefinition/i.test(fileName) && !fileName.endsWith(".xml")) continue;
    const content = await entry.async("string");
    if (content.includes("<steps>") || content.includes(`<${EXPRESSION_SET_METADATA_TYPE}`)) {
      files.push({ fileName, content });
    }
  }
  return { files };
}

export interface TemplateStepMatch {
  fileName: string;
  fullXml: string;
  matchingStep: ElementSpan;
}

/**
 * Retrieve every ExpressionSetDefinition in the org and find the first
 * step whose own actionType matches `actionType` — the "clone a real,
 * working template" strategy §2/§8.1 depends on (this action type is not
 * scriptable from a blank canvas; only cloning an existing correctly
 * configured step works).
 */
export async function findTemplateStepByActionType(
  client: SalesforceClient,
  actionType: string,
): Promise<TemplateStepMatch | null> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  for (const file of files) {
    const matches = findStepsByActionType(file.content, actionType);
    if (matches.length > 0) {
      return { fileName: file.fileName, fullXml: file.content, matchingStep: matches[0] };
    }
  }
  return null;
}

/** Retrieve a single named ExpressionSetDefinition's raw XML (verify-execution Phase 2). */
export async function retrieveNamedExpressionSetDefinition(
  client: SalesforceClient,
  apiName: string,
): Promise<string | null> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, [apiName]);
  return files[0]?.content ?? null;
}
