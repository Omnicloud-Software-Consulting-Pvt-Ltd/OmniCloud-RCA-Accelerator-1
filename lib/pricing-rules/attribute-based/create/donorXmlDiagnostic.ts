/**
 * §TEMPORARY diagnostic — captures the EXACT raw ExpressionSetDefinition XML this pipeline's existing
 * donor-retrieval path (`retrieveExpressionSetDefinitionFiles`) obtains from Salesforce, before any
 * parsing, and writes it to disk verbatim. Built because every prior turn's investigation of the
 * ListPrice<->AttributeDiscount pairing question was working from paraphrased/summarized field tables,
 * which turned out to be imprecise enough to produce a false-positive resolution in a reconstructed test
 * fixture. This module changes NOTHING about the real pipeline — it calls the exact same retrieval
 * function `resolveAttributeBasedPricingDonor`/`buildAttributeCanvas` already use, reads the SAME `content`
 * string those already read, and only ADDS a side-effect (writing files to disk) — it never mutates
 * Salesforce, never creates/updates/deploys anything, and never chooses a ListPrice pairing.
 *
 * Delete this file (and its API route + tests) once the real donor XML has been captured and the actual
 * resolver is implemented from it — it exists solely to answer "what does the donor's raw XML actually
 * say," not as a permanent feature.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { retrieveExpressionSetDefinitionFiles, type RetrievedMetadataFile } from "./templateExpressionSet";
import { EXPRESSION_SET_METADATA_TYPE } from "./soapEnvelope";
import {
  extractStepGraph, type PhysicalStepNode,
  getTagValue, extractFlatBlocks,
  getTopLevelParameterBlocks, getNestedCustomElementParameterBlocks,
  getParamName, getParamValue, isInputParam, isOutputParam,
} from "./xmlBlocks";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deriveFallbackFullName(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base.replace(/\.expressionSetDefinition-meta\.xml$/i, "");
}

/**
 * §Step 10 (security) — never write a credential into a diagnostic artifact. Expression Set metadata XML
 * has no legitimate reason to contain any of these patterns; if one is somehow present, only the matched
 * substring is replaced, everything else (Ids, variable names, bindings, structure) survives untouched,
 * and the caller is told a redaction happened plus which pattern triggered it — never silently.
 */
const CREDENTIAL_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "Authorization header", re: /Authorization:\s*\S+/gi },
  { label: "Bearer token", re: /Bearer\s+[A-Za-z0-9._-]+/gi },
  { label: "Salesforce session/access token shape", re: /00D[A-Za-z0-9]{12,}![A-Za-z0-9._-]{20,}/g },
  { label: "Anthropic API key shape", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { label: "generic sk- API key shape", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "refresh_token field", re: /"?refresh_token"?\s*[:=]\s*"?[A-Za-z0-9._-]{10,}"?/gi },
  { label: "access_token field", re: /"?access_token"?\s*[:=]\s*"?[A-Za-z0-9._-]{10,}"?/gi },
];

export function redactCredentials(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let out = text;
  for (const { label, re } of CREDENTIAL_PATTERNS) {
    if (re.test(out)) {
      redactions.push(label);
      out = out.replace(re, "[REDACTED-CREDENTIAL]");
    }
  }
  return { text: out, redactions };
}

interface RawParamBinding { name: string | null; value: string | null; input: boolean; output: boolean }

/** Truncates at the first nested `<steps>` child, if any — so a container/group node's OWN bindings are
 * never conflated with a physically-nested child step's bindings (that child is already visited as its
 * own separate entry in `graph`). Same truncation logic as donorInspection.ts's private `ownFieldsOnly`. */
function ownFieldsOnly(node: PhysicalStepNode): string {
  const nestedIdx = node.content.indexOf("<steps");
  return nestedIdx === -1 ? node.content : node.content.slice(0, nestedIdx);
}

function collectAllBindings(stepFullXml: string): RawParamBinding[] {
  const results: RawParamBinding[] = [];
  for (const b of getTopLevelParameterBlocks(stepFullXml)) {
    results.push({ name: getParamName(b.block), value: getParamValue(b.block), input: isInputParam(b.block), output: isOutputParam(b.block) });
  }
  for (const b of getNestedCustomElementParameterBlocks(stepFullXml)) {
    results.push({ name: getParamName(b.block), value: getParamValue(b.block), input: isInputParam(b.block), output: isOutputParam(b.block) });
  }
  return results;
}

/** Physical ancestry (via `parentOccurrenceIndex`) — nearest-first. Raw `.full` XML per ancestor, a
 * verbatim substring of the original document, never reconstructed. */
function physicalAncestry(graph: PhysicalStepNode[], node: PhysicalStepNode): PhysicalStepNode[] {
  const byOcc = new Map(graph.map(n => [n.occurrenceIndex, n]));
  const chain: PhysicalStepNode[] = [];
  let current = node.parentOccurrenceIndex;
  while (current !== null) {
    const parent = byOcc.get(current);
    if (!parent) break;
    chain.push(parent);
    current = parent.parentOccurrenceIndex;
  }
  return chain;
}

/** Logical `<parentStep>` NAME ancestry — Salesforce's own declared cross-reference, never assumed unique
 * without checking; stops (without throwing) the moment a name resolves to anything other than exactly 1
 * node, recording that as the chain's own note rather than guessing. */
function logicalAncestry(graph: PhysicalStepNode[], node: PhysicalStepNode): { chain: PhysicalStepNode[]; note: string } {
  const chain: PhysicalStepNode[] = [];
  const visited = new Set<string>();
  let currentName = node.parentStep;
  while (currentName) {
    if (visited.has(currentName)) return { chain, note: `Cycle detected at parentStep "${currentName}" — stopped.` };
    visited.add(currentName);
    const matches = graph.filter(n => n.name === currentName);
    if (matches.length !== 1) return { chain, note: `parentStep "${currentName}" resolved to ${matches.length} step(s) (expected exactly 1) — stopped.` };
    chain.push(matches[0]);
    currentName = matches[0].parentStep;
  }
  return { chain, note: chain.length > 0 ? `Reached root after ${chain.length} ancestor(s).` : "No <parentStep> set on this occurrence." };
}

function nodeSummary(n: PhysicalStepNode) {
  return {
    occurrenceIndex: n.occurrenceIndex,
    pathLabel: n.pathLabel,
    actionType: n.actionType,
    name: n.name,
    label: getTagValue(n.content, "label"),
    stepType: getTagValue(n.content, "stepType"),
    sequenceNumber: n.sequenceNumber,
    parentStep: n.parentStep,
    parentOccurrenceIndex: n.parentOccurrenceIndex,
  };
}

function buildRelevantNodeRecord(graph: PhysicalStepNode[], node: PhysicalStepNode) {
  const physicalParents = physicalAncestry(graph, node);
  const logical = logicalAncestry(graph, node);
  const physicalChildren = graph.filter(n => n.parentOccurrenceIndex === node.occurrenceIndex);
  const logicalChildren = node.name ? graph.filter(n => n.parentStep === node.name) : [];
  return {
    ...nodeSummary(node),
    completeRawXmlNode: node.full,
    directParentRawXml: physicalParents[0]?.full ?? null,
    physicalAncestryFromNodeToRoot: physicalParents.map(nodeSummary),
    logicalParentStepAncestry: { chain: logical.chain.map(nodeSummary), note: logical.note },
    immediatePhysicalChildren: physicalChildren.map(nodeSummary),
    immediateLogicalChildren_viaParentStepReference: logicalChildren.map(nodeSummary),
    allParameterBindings: collectAllBindings(node.full),
  };
}

export interface VariableTableRow {
  variable: string;
  declaredByEnvelopeVariables: boolean;
  producedBy: { occurrenceIndex: number; actionType: string | null; name: string | null; paramName: string | null }[];
  consumedBy: { occurrenceIndex: number; actionType: string | null; name: string | null; paramName: string | null }[];
}

function buildVariableTable(rawXml: string, graph: PhysicalStepNode[]): VariableTableRow[] {
  const envelopeVarNames = new Set(extractFlatBlocks(rawXml, "variables").map(b => getTagValue(b, "name")).filter((n): n is string => !!n));
  const byValue = new Map<string, VariableTableRow>();
  const get = (value: string) => {
    let row = byValue.get(value);
    if (!row) {
      row = { variable: value, declaredByEnvelopeVariables: envelopeVarNames.has(value), producedBy: [], consumedBy: [] };
      byValue.set(value, row);
    }
    return row;
  };
  for (const node of graph) {
    // §Own fields only — `node.full` includes nested `<steps>` children's XML too, which would otherwise
    // double-count a nested child's own bindings against this outer node (that child is already visited
    // as its own separate entry in this same loop).
    for (const b of collectAllBindings(ownFieldsOnly(node))) {
      if (!b.value) continue;
      const row = get(b.value);
      const entry = { occurrenceIndex: node.occurrenceIndex, actionType: node.actionType, name: node.name, paramName: b.name };
      if (b.output) row.producedBy.push(entry);
      if (b.input) row.consumedBy.push(entry);
    }
  }
  return [...byValue.values()].sort((a, b) => a.variable.localeCompare(b.variable));
}

export interface DonorXmlDiagnosticResult {
  success: boolean;
  error?: string;
  donorFullName: string;
  matchedFileName?: string;
  rawCaptureHash?: string;
  parserInputHash?: string;
  hashesMatch?: boolean;
  xmlLength?: number;
  redactionsApplied?: string[];
  artifactPaths?: {
    rawXml: string;
    captureMetadata: string;
    relevantNodes: string;
    variables: string;
  };
  counts?: { pricingSettings: number; listPrice: number; attributeDiscount: number };
}

/**
 * §Read-only, single-purpose. Calls ONLY `retrieveExpressionSetDefinitionFiles` (a Metadata API `retrieve`
 * — read-only by Salesforce's own definition) — never `createRecord`/`updateRecord`/`metadataSoapCall`
 * with a `deploy`/`create`/`update` action, never activation. Writes 3 files to `outDir` and returns their
 * paths plus integrity hashes; never returns the full raw XML in its own return value (callers needing it
 * read the written file), keeping any HTTP response built from this small.
 */
export async function captureDonorXmlDiagnostic(
  client: SalesforceClient,
  args: { donorFullName: string; outDir: string; sourceEndpoint?: string },
): Promise<DonorXmlDiagnosticResult> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  const match = files.find((f: RetrievedMetadataFile) => (getTagValue(f.content, "fullName") ?? deriveFallbackFullName(f.fileName)) === args.donorFullName);
  if (!match) {
    return {
      success: false,
      error: `No retrieved ExpressionSetDefinition file matched fullName "${args.donorFullName}". Retrieved ${files.length} file(s): ${files.map(f => getTagValue(f.content, "fullName") ?? f.fileName).join(", ") || "(none)"}.`,
      donorFullName: args.donorFullName,
    };
  }

  // §Step 2 — capture BEFORE any parsing. `match.content` is the exact string
  // `retrieveExpressionSetDefinitionFiles` already produces via `entry.async("string")` (the zip-decoded
  // XML) — the SAME string `resolveAttributeBasedPricingDonor`/`inspectDonorCandidate` already parse in
  // the real pipeline. No trim, no re-encoding, no reformatting applied here.
  const rawXml = match.content;
  const rawCaptureHash = sha256(rawXml);

  const { text: redactedXml, redactions } = redactCredentials(rawXml);

  // §Step 8 — pass the SAME variable into the SAME parser call the real pipeline uses, then re-hash at
  // the call site. In a single synchronous flow this necessarily matches (same reference); the point is
  // structural — if a future refactor inserts a transform between capture and parsing, this comparison
  // (and the dedicated regression test) will catch it instead of silently drifting.
  const graph = extractStepGraph(rawXml);
  const parserInputHash = sha256(rawXml);
  const hashesMatch = rawCaptureHash === parserInputHash;

  await fs.mkdir(args.outDir, { recursive: true });
  const rawXmlPath = path.join(args.outDir, `${args.donorFullName}.raw.xml`);
  const captureMetadataPath = path.join(args.outDir, `${args.donorFullName}.capture.json`);
  const relevantNodesPath = path.join(args.outDir, `${args.donorFullName}.relevant.json`);
  const variablesPath = path.join(args.outDir, `${args.donorFullName}.variables.json`);

  if (!hashesMatch) {
    // §Step 8 — fail loudly, write nothing else, never proceed to donor inference on unverified bytes.
    await fs.writeFile(captureMetadataPath, JSON.stringify({
      donorName: args.donorFullName, capturedAt: new Date().toISOString(),
      rawCaptureHash, parserInputHash, hashesMatch: false,
      error: "HASH MISMATCH — capture integrity check failed. Diagnostic artifacts were NOT written beyond this file.",
    }, null, 2), "utf8");
    return { success: false, error: "HASH MISMATCH — capture integrity check failed.", donorFullName: args.donorFullName, rawCaptureHash, parserInputHash, hashesMatch: false };
  }

  await fs.writeFile(rawXmlPath, redactedXml, "utf8");

  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const attributeDiscountNodes = graph.filter(n => n.actionType === "AttributeDiscount");

  const captureMetadata = {
    donorName: args.donorFullName,
    sourceEndpoint: args.sourceEndpoint ?? "Metadata API SOAP retrieve (ExpressionSetDefinition) — see retrieveExpressionSetDefinitionFiles, templateExpressionSet.ts",
    sourceObject: EXPRESSION_SET_METADATA_TYPE,
    sourceField: "zip entry content (entry.async(\"string\")) — templateExpressionSet.ts:38",
    matchedFileName: match.fileName,
    xmlLength: rawXml.length,
    capturedBeforeParsing: true,
    capturedAt: new Date().toISOString(),
    sha256: rawCaptureHash,
    parserInputSha256: parserInputHash,
    hashesMatch,
    redactionsApplied: redactions,
    physicalStepCount: graph.length,
    counts: { pricingSettings: pricingSettingsNodes.length, listPrice: listPriceNodes.length, attributeDiscount: attributeDiscountNodes.length },
  };
  await fs.writeFile(captureMetadataPath, JSON.stringify(captureMetadata, null, 2), "utf8");

  const relevantNodes = {
    pricingSettings: pricingSettingsNodes.map(n => buildRelevantNodeRecord(graph, n)),
    listPrice: listPriceNodes.map(n => buildRelevantNodeRecord(graph, n)),
    attributeDiscount: attributeDiscountNodes.map(n => buildRelevantNodeRecord(graph, n)),
  };
  await fs.writeFile(relevantNodesPath, JSON.stringify(relevantNodes, null, 2), "utf8");

  const variables = buildVariableTable(rawXml, graph);
  await fs.writeFile(variablesPath, JSON.stringify({ variables }, null, 2), "utf8");

  return {
    success: true,
    donorFullName: args.donorFullName,
    matchedFileName: match.fileName,
    rawCaptureHash, parserInputHash, hashesMatch,
    xmlLength: rawXml.length,
    redactionsApplied: redactions,
    artifactPaths: { rawXml: rawXmlPath, captureMetadata: captureMetadataPath, relevantNodes: relevantNodesPath, variables: variablesPath },
    counts: { pricingSettings: pricingSettingsNodes.length, listPrice: listPriceNodes.length, attributeDiscount: attributeDiscountNodes.length },
  };
}
