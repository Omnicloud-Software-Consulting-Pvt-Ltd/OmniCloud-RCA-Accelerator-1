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
import { extractStepGraph, extractFlatBlocks, getTagValue, type PhysicalStepNode } from "./xmlBlocks";

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

/**
 * §Version-scoping fix (confirmed live incident — a donor's retrieved ExpressionSetDefinition XML
 * contained TWO `<versions>` blocks, each a normal, single-branch, non-duplicated Expression Set Version;
 * `extractStepGraph` has no `<versions>`-boundary awareness and flattened both versions' steps into one
 * graph, making a perfectly ordinary donor look like it had two identical duplicate branches — a false
 * ambiguity, not a real one) — one `<versions>` block in a retrieved ExpressionSetDefinition file
 * represents ONE real Salesforce ExpressionSetVersion. Salesforce's Metadata API returns EVERY version
 * (active or not) bundled under one ExpressionSetDefinition file; retrieving the same Definition more than
 * once (an ordinary occurrence — any product redeployed/retried more than once) naturally accumulates
 * multiple `<versions>` blocks. Nothing before this fix ever narrowed that down to the one version callers
 * actually mean.
 */
export interface ExpressionSetDefinitionVersionInfo {
  /** Position among the `<versions>` blocks in document order — DIAGNOSTIC ONLY, never the selection rule. */
  occurrenceIndex: number;
  fullName: string | null;
  status: string | null;
  /** Parsed from the trailing "_V<n>" on this version's own `<fullName>` — Salesforce's own documented
   * ExpressionSetVersion fullName numbering convention (confirmed live: "..._V1", "..._V2", ...). There is
   * no dedicated `<versionNumber>` field on `<versions>` itself in this metadata representation, so this is
   * the one reliable, Salesforce-assigned per-version ordinal actually available — never array position or
   * document order. `null` when `fullName` is absent or doesn't match the convention. */
  versionNumber: number | null;
  /** The verbatim `<versions>...</versions>` XML for this one version — never re-serialized. */
  xml: string;
}

export interface ExpressionSetDefinitionVersionSelection {
  versions: ExpressionSetDefinitionVersionInfo[];
  selected: ExpressionSetDefinitionVersionInfo | null;
  /** A reconstructed document containing ONLY the selected version's `<versions>` block (with every
   * Definition-level field outside `<versions>` preserved verbatim) — this, never `fullXml` itself, is
   * what step-graph extraction should run against. Equal to the original `fullXml` when there was nothing
   * to scope (0 or 1 `<versions>` blocks found). When `ambiguous` is true, this contains NO version's steps
   * at all (so a caller that uses it anyway safely sees zero steps/branches, never a guessed pick). */
  selectedXml: string;
  /** True only when 2+ versions exist and no single one could be identified as the intended one — callers
   * MUST treat this as a hard "nothing usable here," never fall back to guessing or to the raw `fullXml`. */
  ambiguous: boolean;
  reason: string;
}

const VERSION_FULLNAME_NUMBER_SUFFIX = /_V(\d+)$/i;

/** Splices `versionBlockXml` (or nothing, when `null`) in place of ALL `<versions>...</versions>` content
 * in `fullXml`, keeping everything before the first `<versions>` and after the last `</versions>` — i.e.
 * every Definition-level field (`label`, `template`, `contextDefinitions`, etc.) survives untouched, and
 * step-graph extraction sees exactly the one supplied version's steps (or none, when `null`). A pure
 * substring splice, never a re-serialization — matches this whole toolkit's existing "addressable text
 * blocks, never a DOM" architecture. */
function spliceInVersionBlock(fullXml: string, versionBlockXml: string | null): string {
  const firstOpenIdx = fullXml.indexOf("<versions>");
  const lastCloseIdx = fullXml.lastIndexOf("</versions>");
  if (firstOpenIdx === -1 || lastCloseIdx === -1) return fullXml;
  const prefix = fullXml.slice(0, firstOpenIdx);
  const suffix = fullXml.slice(lastCloseIdx + "</versions>".length);
  return `${prefix}${versionBlockXml ?? ""}${suffix}`;
}

/**
 * Narrows a retrieved ExpressionSetDefinition's raw, possibly-multi-version XML down to exactly the one
 * `<versions>` block callers should treat as "the donor." Never selects by array position, document order,
 * or "first"/"last" — mirrors the same semantic concept `selectExpressionSetVersion`
 * (verifySalesforceState.ts, the Connect-REST-based ExpressionSetVersion resolver already used during
 * post-deploy verification) already established: prefer the highest version-number signal actually
 * present, and never guess when that signal can't produce a clear, single answer.
 */
export function selectExpressionSetDefinitionVersion(fullXml: string): ExpressionSetDefinitionVersionSelection {
  const versionBlocks = extractFlatBlocks(fullXml, "versions");

  if (versionBlocks.length === 0) {
    return {
      versions: [], selected: null, selectedXml: fullXml, ambiguous: false,
      reason: "No <versions> block found in this document — nothing to scope; using the content as-is.",
    };
  }

  const versions: ExpressionSetDefinitionVersionInfo[] = versionBlocks.map((xml, occurrenceIndex) => {
    const fullName = getTagValue(xml, "fullName");
    const status = getTagValue(xml, "status");
    const suffixMatch = fullName ? VERSION_FULLNAME_NUMBER_SUFFIX.exec(fullName) : null;
    return { occurrenceIndex, fullName, status, versionNumber: suffixMatch ? Number(suffixMatch[1]) : null, xml };
  });

  if (versions.length === 1) {
    return {
      versions, selected: versions[0], selectedXml: spliceInVersionBlock(fullXml, versions[0].xml), ambiguous: false,
      reason: "Exactly one <versions> block was found — no disambiguation needed.",
    };
  }

  const withNumbers = versions.filter(v => v.versionNumber !== null);
  if (withNumbers.length === versions.length) {
    const sorted = [...withNumbers].sort((a, b) => (b.versionNumber as number) - (a.versionNumber as number));
    const top = sorted[0];
    const runnerUp = sorted[1];
    if (!runnerUp || top.versionNumber !== runnerUp.versionNumber) {
      return {
        versions, selected: top, selectedXml: spliceInVersionBlock(fullXml, top.xml), ambiguous: false,
        reason: `Selected "${top.fullName ?? "(no fullName)"}" — highest version number (${top.versionNumber}) among ${versions.length} <versions> blocks found, per each version's own Salesforce-assigned fullName suffix.`,
      };
    }
  }

  // Genuinely can't tell — either 2+ versions tie on the same parsed number, or not every version's
  // fullName carries a parseable one. Never guessed past: no version's steps are used at all.
  return {
    versions, selected: null, selectedXml: spliceInVersionBlock(fullXml, null), ambiguous: true,
    reason: `${versions.length} <versions> blocks were found (${versions.map(v => `"${v.fullName ?? "(no fullName)"}"`).join(", ")}), but their version numbers could not unambiguously identify exactly one intended version — refusing to guess. No step content from any of them will be used.`,
  };
}

/**
 * Retrieve ExpressionSetDefinition metadata and narrow EACH file's content down to exactly one intended
 * `<versions>` block before returning — this, not `retrieveExpressionSetDefinitionFiles` directly, is what
 * every donor-inspection/selection caller should use. `retrieveExpressionSetDefinitionFiles` itself is
 * left completely unchanged (still returns the full, unscoped, multi-version content verbatim) for callers
 * that genuinely need the raw bytes as retrieved — e.g. `donorXmlDiagnostic.ts`'s own hash-integrity
 * capture, which exists specifically to prove what Salesforce actually returned, byte for byte.
 */
export async function retrieveVersionScopedExpressionSetDefinitionFiles(
  client: SalesforceClient,
  members: string[],
): Promise<{ files: RetrievedMetadataFile[]; warning?: string }> {
  const { files, warning } = await retrieveExpressionSetDefinitionFiles(client, members);
  const scopedFiles: RetrievedMetadataFile[] = files.map(f => {
    const versionSelection = selectExpressionSetDefinitionVersion(f.content);
    if (versionSelection.versions.length > 1) {
      client.logDebug(
        "xml-diagnostic",
        `${versionSelection.ambiguous ? "⚠" : "✓"} ${f.fileName} — ${versionSelection.reason}`,
      );
    }
    return { fileName: f.fileName, content: versionSelection.selectedXml };
  });
  return { files: scopedFiles, warning };
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
  // §Version-scoping fix — version-scoped retrieval, not the raw multi-version content, so a Definition
  // with 2+ accumulated <versions> blocks never makes this look like it has more occurrences of
  // `actionType` than the intended single version actually does.
  const { files } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
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
