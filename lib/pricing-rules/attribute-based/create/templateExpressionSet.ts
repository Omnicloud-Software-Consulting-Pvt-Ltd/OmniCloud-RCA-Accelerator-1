/**
 * Retrieve real, already-deployed Expression Set (Pricing Procedure)
 * metadata from the connected org via the Metadata API. Used to clone a
 * template step whose actionType (e.g. `AttributeDiscount`) can't be
 * hand-authored — see canvasBuilder.ts.
 */
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  EXPRESSION_SET_METADATA_TYPE,
  metadataRetrieve,
  pollRetrieveStatus,
} from "./soapEnvelope";
import { extractStepGraph, type PhysicalStepNode } from "./xmlBlocks";

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

export interface TemplateStepOccurrences {
  fileName: string;
  fullXml: string;
  /** EVERY physical step in `fullXml` whose own actionType matches, in document order — never
   * collapsed to "the first one." `<name>` is not a safe identity/uniqueness key in this metadata (donor
   * evidence: multiple physically distinct steps across unrelated branches legitimately share a name),
   * so callers must decide how to handle more than one occurrence rather than have this function guess. */
  occurrences: PhysicalStepNode[];
}

/**
 * Retrieve every ExpressionSetDefinition in the org and find every physical step (occurrence-aware —
 * see `extractStepGraph`) whose own actionType matches `actionType`, in the FIRST file that has at least
 * one — the "clone a real, working template" strategy this action type is not scriptable from a blank
 * canvas; only cloning an existing correctly configured step works. Returns ALL matching occurrences in
 * that file, never just the first — see the file-level architecture note in `canvasBuilder.ts` for why
 * silently picking `occurrences[0]` is exactly the bug this exists to avoid.
 */
export async function findTemplateStepOccurrences(
  client: SalesforceClient,
  actionType: string,
): Promise<TemplateStepOccurrences | null> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  for (const file of files) {
    const occurrences = extractStepGraph(file.content).filter(n => n.actionType === actionType);
    if (occurrences.length > 0) {
      return { fileName: file.fileName, fullXml: file.content, occurrences };
    }
  }
  return null;
}

/** Retrieve a single named ExpressionSetDefinition's raw XML. */
export async function retrieveNamedExpressionSetDefinition(
  client: SalesforceClient,
  apiName: string,
): Promise<string | null> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, [apiName]);
  return files[0]?.content ?? null;
}
