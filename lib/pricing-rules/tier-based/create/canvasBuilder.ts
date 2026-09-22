/**
 * Tier-Based (Slab) Pricing Expression Set XML builder — mirrors
 * lib/pricing-rules/volume-based/create/canvasBuilder.ts's clone-and-patch architecture: `VolumeTierDiscount`
 * is a real, org-configured Business Knowledge Model action type that cannot be hand-authored from a blank
 * canvas, so this NEVER builds XML from scratch. It clones the donor's SCHEDULE-BASED VolumeTierDiscount
 * branch (donorInspection.ts already excludes any non-schedule-based block — see its file header for the
 * two-block trap), the donor's Price Book ListPrice branch, and PricingSettings, strips every donor-specific
 * literal, forces `PriceAdjustmentScheduleId` to a fresh runtime binding (this pipeline creates a NEW
 * PriceAdjustmentSchedule on every deploy — a donor's own hardcoded schedule Id/Constant would always be
 * wrong), rebinds the LookUp* params to a freshly-SOQL-resolved Decision Table, and re-validates the
 * assembled result before returning it.
 *
 * Two deliberate departures from the volume-based sibling (both fixes for known defects rather than
 * ported behavior — see the module's own commit history / design notes):
 *   1. The Tier Adjustment Decision Table resolution is FATAL if not found via SOQL — no donor-LookUpId
 *      fallback is attempted, symmetric with the Price Book Decision Table check just below it. A
 *      tier-based procedure without a resolved tier Decision Table can never produce a discount, so
 *      silently falling back to a possibly-stale donor literal would be worse than failing loudly.
 *   2. TIER_REQUIRED_ACTION_TYPES / TIER_BLOCKED_ACTION_TYPES are checked explicitly against the final
 *      composed canvas, mirroring lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own
 *      ATTR_REQUIRED_ACTION_TYPES/ATTR_BLOCKED_ACTION_TYPES pattern (the volume-based sibling enforces the
 *      same intent only via ad-hoc step-count assertions).
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  extractStepGraph, getTagValue, escapeXml,
  getTopLevelParameterBlocks, getNestedCustomElementParameterBlocks,
  getParamName, getParamValue,
} from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences, findDanglingParentStepReferences } from "@/lib/pricing-rules/attribute-based/create/pricingCanvasPruning";
import { compareExpressionSetSchema, compareStepStructure, type StepStructureReport } from "@/lib/pricing-rules/attribute-based/create/schemaDiff";
import { injectVersionNumberAndRank } from "@/lib/pricing-rules/attribute-based/create/versionEnvelopeFields";
import { resolveTierBasedPricingDonor, resolveConnectedAncestor, SHARED_SIGNAL_ACTION_TYPES, buildNoCoherentDonorDiagnostic } from "./donorInspection";

const UNIT_PRICE_SEMANTIC_PRIORITY = ["UnitPrice", "NetUnitPrice", "ListPrice"];

/** Mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's ATTR_REQUIRED_ACTION_TYPES /
 * ATTR_BLOCKED_ACTION_TYPES naming convention exactly (Section 9, bug #4 of the port spec this module
 * follows) — an explicit required/blocked action-type check against the final composed canvas, on top of
 * (not instead of) the exact-count assertions below. */
export const TIER_REQUIRED_ACTION_TYPES = new Set(["PricingSettings", "ListPrice", "VolumeTierDiscount"]);
export const TIER_BLOCKED_ACTION_TYPES = new Set(["PriceBookEntry", "ListContainer", "ListOperation", "AttributeBasedPrice", "AttributeDiscount", "BundleDiscount"]);

export interface DecisionTableLookup { id: string; name: string; apiName: string; }

/** §Decision Table resolution — never a hardcoded Salesforce Id; queried fresh on every build via
 * Describe-confirmed fields, matched by DeveloperName candidates first, then SourceObject regex (the most
 * reliable purpose discriminator — labels/DeveloperNames vary per org, SourceObject does not). */
export async function resolveDecisionTable(
  client: SalesforceClient,
  developerNameCandidates: string[],
  sourceObjectPatterns: RegExp[],
): Promise<DecisionTableLookup | null> {
  let labelField = "MasterLabel";
  try {
    const describe = await client.describeObject("DecisionTable");
    const fieldNames = new Set(describe.fields.map(f => f.name));
    if (!fieldNames.has("MasterLabel") && fieldNames.has("Name")) labelField = "Name";
  } catch {
    // fall through with the default label field guess
  }

  let records: { Id: string; DeveloperName?: string; SourceObject?: string; [k: string]: unknown }[] = [];
  try {
    const res = await client.query<{ Id: string; DeveloperName?: string; SourceObject?: string; [k: string]: unknown }>(
      `SELECT Id, ${labelField}, DeveloperName, SourceObject FROM DecisionTable LIMIT 500`,
    );
    records = res.records;
  } catch {
    return null;
  }
  if (records.length === 0) return null;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const exact = records.find(r => r.DeveloperName && developerNameCandidates.some(c => r.DeveloperName === c));
  const caseInsensitive = records.find(r => r.DeveloperName && developerNameCandidates.some(c => r.DeveloperName!.toLowerCase() === c.toLowerCase()));
  const normalizedDevName = records.find(r => r.DeveloperName && developerNameCandidates.some(c => normalize(r.DeveloperName!) === normalize(c)));
  const normalizedLabel = records.find(r => {
    const label = String(r[labelField] ?? "");
    return label && developerNameCandidates.some(c => normalize(label) === normalize(c));
  });
  const bySourceObject = records.find(r => r.SourceObject && sourceObjectPatterns.some(p => p.test(r.SourceObject!)));

  const match = exact ?? caseInsensitive ?? normalizedDevName ?? normalizedLabel ?? bySourceObject;
  if (!match) return null;
  const rawLabel = String(match[labelField] ?? "").trim();
  return { id: match.Id, name: rawLabel && rawLabel !== "Decision Tables" ? rawLabel : (match.DeveloperName ?? rawLabel), apiName: match.DeveloperName ?? "" };
}

function collectFieldMap(xmlSlice: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of [...getTopLevelParameterBlocks(xmlSlice), ...getNestedCustomElementParameterBlocks(xmlSlice)]) {
    const n = getParamName(b.block);
    if (n) map.set(n, getParamValue(b.block));
  }
  return map;
}

/** Generic "replace the <value> following this <name>" text patch — operates directly on a step's own
 * raw XML text rather than the structured parameter-block helpers, since these patches target params by
 * NAME across whatever position/type they happen to have in the donor (Literal or Parameter alike). */
function patchParamValue(block: string, paramName: string, newValue: string): string {
  return block.replace(
    new RegExp(`(<name>${paramName}<\\/name>[\\s\\S]{0,300}?<value>)[^<]*(<\\/value>)`, "g"),
    (_m, pre: string, suf: string) => `${pre}${escapeXml(newValue)}${suf}`,
  );
}

/** Forces the `<type>` immediately following a named param to a specific value (Constant -> Parameter). */
function patchParamType(block: string, paramName: string, newType: string): string {
  return block.replace(
    new RegExp(`(<name>${paramName}<\\/name>[\\s\\S]{0,300}?<type>)[^<]*(<\\/type>)`, "g"),
    (_m, pre: string, suf: string) => `${pre}${newType}${suf}`,
  );
}

function stripIdsAndParentStep(stepFullXml: string): string {
  return stepFullXml
    .replace(/<parentStep>[^<]*<\/parentStep>\s*/g, "")
    .replace(/<id>[0-9A-Za-z]{15,18}<\/id>\s*/g, "");
}

function renumberSequence(stepFullXml: string, seq: number): string {
  return stepFullXml.replace(/<sequenceNumber>\d+<\/sequenceNumber>/, `<sequenceNumber>${seq}</sequenceNumber>`);
}

function resolveTargetInputUnitPriceValue(donorInputUnitPrice: string | null, donorLpOutputValues: string[]): string | null {
  if (donorLpOutputValues.length === 1) return donorLpOutputValues[0];
  if (donorInputUnitPrice && donorLpOutputValues.includes(donorInputUnitPrice)) return donorInputUnitPrice;
  for (const name of UNIT_PRICE_SEMANTIC_PRIORITY) if (donorLpOutputValues.includes(name)) return name;
  return donorLpOutputValues[0] ?? null;
}

export interface CanvasStepStats { actionType: string; parameterCount: number; }

export interface CanvasBuildResult {
  success: boolean;
  fatalErrors: string[];
  warnings: string[];
  finalFileXml?: string;
  donorFileName?: string;
  lpLookup?: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null };
  vtdLookup?: DecisionTableLookup | null;
  observedActionTypes?: string[];
  stepStats?: CanvasStepStats[];
  variableCount?: number;
  schemaReport?: ReturnType<typeof compareExpressionSetSchema>;
  stepStructureReports?: StepStructureReport[];
  outboundVersionFields?: { versionNumber: string | null; rank: string | null; fullName: string | null; expressionSetDefinition: string | null };
  tierDiscountInputBinding?: { listPriceOutputValues: string[]; inputUnitPriceValue: string | null; originalInputUnitPriceValue: string | null; wasPatched: boolean; valid: boolean };
  generatedIdentifiers?: { tag: string; value: string }[];
  canvasComposition?: { donorFullName: string; donorFileName: string; donorPhysicalStepCount: number; prunedRootBranchCount: number; finalPhysicalStepCount: number };
}

export async function buildTierCanvas(
  client: SalesforceClient,
  ctx: { procedureName: string; apiName: string; description?: string; versionNumber?: number; rank?: number | null; onProgress?: (phase: "template-retrieved") => void },
): Promise<CanvasBuildResult> {
  const fatalErrors: string[] = [];
  const warnings: string[] = [];

  const donorResolution = await resolveTierBasedPricingDonor(client);
  if (!donorResolution.selection) {
    fatalErrors.push(
      "No valid Tier-Based (Slab) Pricing Expression Set donor was found in this org.\n\n" +
      buildNoCoherentDonorDiagnostic(donorResolution.candidatesWithTierDiscount) +
      (donorResolution.lowConfidenceCandidates
        ? `\n\nNote: some candidates DID prove a schedule-based VolumeTierDiscount->ListPrice connection but scored below the trust floor:\n${donorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`
        : ""),
    );
    return { success: false, fatalErrors, warnings };
  }
  ctx.onProgress?.("template-retrieved");
  const { fullXml: donorFileXml, fileName: donorFileName, candidate: donorCandidate, connectedScheduleBasedOccurrenceIndexes } = donorResolution.selection;

  const donorGraph = extractStepGraph(donorFileXml);
  if (connectedScheduleBasedOccurrenceIndexes.length === 0) {
    fatalErrors.push("No schedule-based VolumeTierDiscount branch was connected to ListPrice after donor resolution — refusing to guess.");
    return { success: false, fatalErrors, warnings };
  }
  // Prefer, among the eligible schedule-based branches, the one with IsContractEnabled explicitly "false".
  const vtdCandidates = donorGraph.filter(n => connectedScheduleBasedOccurrenceIndexes.includes(n.occurrenceIndex));
  const vtdNode = vtdCandidates.find(n => collectFieldMap(n.full).get("IsContractEnabled") === "false") ?? vtdCandidates[0];

  const psResolution = resolveConnectedAncestor(donorGraph, vtdNode, "PricingSettings");
  const lpResolution = resolveConnectedAncestor(donorGraph, vtdNode, "ListPrice");
  if (!psResolution.node || !lpResolution.node) {
    fatalErrors.push(`Selected VolumeTierDiscount branch (occurrence ${vtdNode.occurrenceIndex}) does not resolve to both a PricingSettings and a ListPrice ancestor.`);
    return { success: false, fatalErrors, warnings };
  }
  const psNode = psResolution.node;
  let lpNode = lpResolution.node;

  // §Prefer a Price Book LP over a Contract Pricing one, mirroring VolumeTierDiscount's own two-block trap
  // — if the resolved LP ancestor's own lookup mentions "contract", search for a sibling ListPrice step
  // that looks like the standard price-book lookup instead.
  const lpLookupNameCheck = collectFieldMap(lpNode.full).get("LookUpName") ?? collectFieldMap(lpNode.full).get("LookUpApiName") ?? "";
  if (/contract/i.test(lpLookupNameCheck)) {
    const alt = donorGraph.find(n => n.actionType === "ListPrice" && /price.?book/i.test(collectFieldMap(n.full).get("LookUpName") ?? collectFieldMap(n.full).get("LookUpApiName") ?? ""));
    if (alt) {
      warnings.push(`The ListPrice ancestor resolved via ${lpResolution.mechanism} looked contract-linked ("${lpLookupNameCheck}") — substituted a Price Book ListPrice step found elsewhere in the donor instead.`);
      lpNode = alt;
    } else {
      warnings.push(`The ListPrice ancestor resolved via ${lpResolution.mechanism} looks contract-linked ("${lpLookupNameCheck}") and no alternate Price Book ListPrice step was found in the donor — proceeding with it anyway.`);
    }
  }
  const psXml = psNode.full;
  const lpXml = lpNode.full;

  /* ── Resolve the Price Book Decision Table (for the LP step) ── */
  const pbDt = await resolveDecisionTable(
    client,
    ["Price_Book_Entries_V2", "Price_Book_Entry_Decision_Table_V2", "Price_Book_Entry_Decision_Table"],
    [/PricebookEntry/i, /Pricebook2/i, /Pricebook/i],
  );
  if (!pbDt) {
    fatalErrors.push("Could not resolve a Price Book Decision Table on this org (checked DeveloperName candidates and SourceObject=PricebookEntry/Pricebook2) — there is no valid procedure without a resolved pricebook lookup.");
    return { success: false, fatalErrors, warnings };
  }

  /* ── Resolve the Tier Adjustment Decision Table (for the VolumeTierDiscount step) ──
   * §Fatal-on-not-found — deliberately NO donor-LookUpId fallback here (unlike the volume-based sibling's
   * resolveDecisionTable call for VolumeDiscount), symmetric with the pbDt check just above: a tier-based
   * procedure without a resolved tier Decision Table can never produce a discount, so this must abort
   * rather than silently deploy against a possibly-stale/placeholder donor literal. */
  const tierDt = await resolveDecisionTable(
    client,
    ["Tiered_Adjustment_Tier_Decision_Table", "Tiered_Adjustment", "Price_Adjustment_Tier"],
    [/PriceAdjustmentTier/i, /AdjustmentTier/i],
  );
  if (!tierDt || !tierDt.id) {
    fatalErrors.push(
      "Could not resolve a Tier Adjustment Decision Table on this org (checked DeveloperName candidates " +
      "Tiered_Adjustment_Tier_Decision_Table/Tiered_Adjustment/Price_Adjustment_Tier and SourceObject=PriceAdjustmentTier) " +
      "— aborting deployment. A tier-based pricing procedure without this Decision Table can never produce a discount.",
    );
    return { success: false, fatalErrors, warnings };
  }
  const vtdLookup = tierDt;

  const lpBindings = collectFieldMap(lpXml);
  const lpLookup = {
    lookUpId: pbDt.id,
    lookUpApiName: pbDt.apiName || lpBindings.get("LookUpApiName") || null,
    lookUpName: pbDt.name || lpBindings.get("LookUpName") || null,
  };

  const vtdOwnBindingsMap = collectFieldMap(vtdNode.content.indexOf("<steps") === -1 ? vtdNode.content : vtdNode.content.slice(0, vtdNode.content.indexOf("<steps")));
  const donorInputUnitPrice = vtdOwnBindingsMap.get("InputUnitPrice") ?? null;
  const lpOwnBindings = getTopLevelParameterBlocks(lpXml).filter(b => getTagValue(b.block, "output") === "true");
  const donorLpOutputValues = lpOwnBindings.map(b => getParamValue(b.block)).filter((v): v is string => !!v);
  const targetInputUnitPriceValue = resolveTargetInputUnitPriceValue(donorInputUnitPrice, donorLpOutputValues);
  if (!targetInputUnitPriceValue) {
    fatalErrors.push("Could not resolve a target InputUnitPrice value from the donor's ListPrice outputs — refusing to bind VolumeTierDiscount to an unpublished value.");
    return { success: false, fatalErrors, warnings };
  }

  /* ── Patch the ListPrice step ── */
  let lpPatched = stripIdsAndParentStep(lpXml);
  lpPatched = patchParamValue(lpPatched, "LookUpId", lpLookup.lookUpId ?? "");
  if (lpLookup.lookUpApiName) lpPatched = patchParamValue(lpPatched, "LookUpApiName", lpLookup.lookUpApiName);
  if (lpLookup.lookUpName) lpPatched = patchParamValue(lpPatched, "LookUpName", lpLookup.lookUpName);
  lpPatched = patchParamValue(lpPatched, "IsContractEnabled", "false");
  // Waterfall bridge — the LP step's own output parameter must publish NetUnitPrice, not ListPrice, or
  // VolumeTierDiscount's InputUnitPrice (which reads NetUnitPrice) is always null.
  lpPatched = lpPatched.replace(
    /(<parameters>)([\s\S]*?)(<\/parameters>)/g,
    (whole, open: string, inner: string, close: string) => {
      if (inner.includes("<output>true</output>") && inner.includes("<type>Parameter</type>")
        && inner.includes("<name>ListPrice</name>") && inner.includes("<value>ListPrice</value>")) {
        return open + inner.replace("<value>ListPrice</value>", "<value>NetUnitPrice</value>") + close;
      }
      return whole;
    },
  );
  if (!/<value>NetUnitPrice<\/value>/.test(lpPatched)) {
    warnings.push("Could not find the expected <name>ListPrice</name>/<value>ListPrice</value> output pattern on the ListPrice step to rebind to NetUnitPrice — VolumeTierDiscount's InputUnitPrice may end up null. Review the ListPrice step's output binding manually if the deployed procedure never produces a discount.");
  }

  /* ── Patch the VolumeTierDiscount step ── */
  const closeIdx = vtdNode.full.lastIndexOf("</steps>");
  const customIdx = vtdNode.full.indexOf("<customElement");
  const splitAt = customIdx !== -1 ? customIdx : (closeIdx === -1 ? vtdNode.full.length : closeIdx);
  const vtdOwnPart = vtdNode.full.slice(0, splitAt);
  const vtdNestedAndClose = vtdNode.full.slice(splitAt);

  let vtdOwnPatched = stripIdsAndParentStep(vtdOwnPart);
  vtdOwnPatched = patchParamValue(vtdOwnPatched, "LookUpId", vtdLookup.id);
  if (vtdLookup.apiName) vtdOwnPatched = patchParamValue(vtdOwnPatched, "LookUpApiName", vtdLookup.apiName);
  if (vtdLookup.name) vtdOwnPatched = patchParamValue(vtdOwnPatched, "LookUpName", vtdLookup.name);
  // Every deployment creates a NEW PriceAdjustmentSchedule — a donor's hardcoded schedule Constant is
  // always wrong. Force it to a Parameter bound to the runtime context variable instead.
  vtdOwnPatched = patchParamType(vtdOwnPatched, "PriceAdjustmentScheduleId", "Parameter");
  vtdOwnPatched = patchParamValue(vtdOwnPatched, "PriceAdjustmentScheduleId", "PriceAdjustmentSchedule");
  if (donorInputUnitPrice !== targetInputUnitPriceValue) {
    vtdOwnPatched = patchParamValue(vtdOwnPatched, "InputUnitPrice", targetInputUnitPriceValue);
  }
  const vtdXml = vtdOwnPatched + vtdNestedAndClose;

  const requiredInputs = ["PriceAdjustmentScheduleId"];
  const vtdFieldMap = collectFieldMap(vtdXml);
  const missingInputs = requiredInputs.filter(name => !vtdFieldMap.has(name));
  if (missingInputs.length > 0) {
    fatalErrors.push(`Generated VolumeTierDiscount step is missing required binding(s): ${missingInputs.join(", ")}.`);
    return { success: false, fatalErrors, warnings };
  }
  if (vtdFieldMap.get("LookUpId") === "$DUMMY$" || vtdFieldMap.get("LookUpId") === "") {
    fatalErrors.push("Generated VolumeTierDiscount step's LookUpId is a placeholder or empty — refusing to deploy.");
    return { success: false, fatalErrors, warnings };
  }

  const psReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === psNode.occurrenceIndex) ?? null, stripIdsAndParentStep(psXml), "PricingSettings");
  const lpReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === lpNode.occurrenceIndex) ?? null, lpPatched, "ListPrice");
  const vtdReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === vtdNode.occurrenceIndex) ?? null, vtdXml, "VolumeTierDiscount");
  for (const r of [psReport, lpReport, vtdReport]) if (!r.structurallyValid) fatalErrors.push(`Step structure validation failed for ${r.actionType}:\n${r.reportText}`);
  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  const psPatchedFull = renumberSequence(stripIdsAndParentStep(psXml), 1);
  const lpPatchedFull = renumberSequence(lpPatched, 2);
  const vtdPatchedFull = renumberSequence(vtdXml, 3);

  // Splice the patched steps back into the donor bytes at their exact original spans — content-only
  // replacement, never adding/removing a <steps> tag, so occurrence indices stay stable for pruning.
  const spans = [
    { node: psNode, patched: psPatchedFull },
    { node: lpNode, patched: lpPatchedFull },
    { node: vtdNode, patched: vtdPatchedFull },
  ].sort((a, b) => b.node.start - a.node.start);
  let patchedDonorFileXml = donorFileXml;
  for (const { node, patched } of spans) {
    patchedDonorFileXml = patchedDonorFileXml.slice(0, node.start) + patched + patchedDonorFileXml.slice(node.end);
  }
  const patchedDonorGraph = extractStepGraph(patchedDonorFileXml);
  const patchedVtdNode = patchedDonorGraph.find(n => n.occurrenceIndex === vtdNode.occurrenceIndex)!;

  const requiredComputation = computeRequiredOccurrenceIndexes(patchedDonorGraph, patchedVtdNode.occurrenceIndex, [psNode.occurrenceIndex, lpNode.occurrenceIndex]);
  if (!requiredComputation) {
    fatalErrors.push("Could not compute the required-occurrence set for pruning.");
    return { success: false, fatalErrors, warnings };
  }
  const prunedXml = pruneXmlToRequiredOccurrences(patchedDonorFileXml, requiredComputation.removedRootBranches, patchedDonorGraph);
  const prunedDonorFileXmlForComparison = pruneXmlToRequiredOccurrences(donorFileXml, requiredComputation.removedRootBranches, donorGraph);

  const prunedGraph = extractStepGraph(prunedXml);
  const dangling = findDanglingParentStepReferences(prunedGraph, patchedDonorGraph);
  if (dangling.length > 0) {
    fatalErrors.push(`Pruning would create ${dangling.length} dangling <parentStep> reference(s) — aborting rather than deploying a broken canvas.`);
    return { success: false, fatalErrors, warnings };
  }
  const survivingUnrelated = [...new Set(prunedGraph.map(n => n.actionType).filter((t): t is string => !!t && SHARED_SIGNAL_ACTION_TYPES.has(t)))];
  if (survivingUnrelated.length > 0) {
    fatalErrors.push(`Pruned canvas still contains unrelated pricing-type branch(es): ${survivingUnrelated.join(", ")} — pruning did not fully isolate the Tier-Based Pricing branch.`);
    return { success: false, fatalErrors, warnings };
  }
  const psCount = prunedGraph.filter(n => n.actionType === "PricingSettings").length;
  const lpCount = prunedGraph.filter(n => n.actionType === "ListPrice").length;
  const vtdCount = prunedGraph.filter(n => n.actionType === "VolumeTierDiscount").length;
  if (psCount !== 1 || lpCount !== 1 || vtdCount !== 1) {
    fatalErrors.push(`Pruned canvas does not have exactly one each of PricingSettings/ListPrice/VolumeTierDiscount (got ${psCount}/${lpCount}/${vtdCount}).`);
    return { success: false, fatalErrors, warnings };
  }
  const blockedPresent = [...new Set(prunedGraph.map(n => n.actionType).filter((t): t is string => !!t && TIER_BLOCKED_ACTION_TYPES.has(t)))];
  if (blockedPresent.length > 0) {
    fatalErrors.push(`Pruned canvas contains explicitly blocked action type(s) for Tier-Based Pricing: ${blockedPresent.join(", ")}.`);
    return { success: false, fatalErrors, warnings };
  }
  const missingRequired = [...TIER_REQUIRED_ACTION_TYPES].filter(req => !prunedGraph.some(n => n.actionType === req));
  if (missingRequired.length > 0) {
    fatalErrors.push(`Pruned canvas is missing required action type(s) for Tier-Based Pricing: ${missingRequired.join(", ")}.`);
    return { success: false, fatalErrors, warnings };
  }

  /* ── Envelope regeneration ── */
  const rootSpans = extractElementSpansFor(prunedXml, "ExpressionSetDefinition");
  const rootSpan = rootSpans[0];
  if (!rootSpan) {
    fatalErrors.push("Could not locate the ExpressionSetDefinition root element in the pruned canvas.");
    return { success: false, fatalErrors, warnings };
  }
  const stepsRegionStart = prunedXml.indexOf("<steps", rootSpan.start);
  const envelopeBefore = prunedXml.slice(rootSpan.start, stepsRegionStart === -1 ? rootSpan.end : stepsRegionStart);
  const stepsRegion = stepsRegionStart === -1 ? "" : prunedXml.slice(stepsRegionStart, prunedXml.lastIndexOf("</steps>") + "</steps>".length);
  const envelopeAfterStart = stepsRegionStart === -1 ? rootSpan.end : prunedXml.lastIndexOf("</steps>") + "</steps>".length;
  const envelopeAfter = prunedXml.slice(envelopeAfterStart, rootSpan.end);

  const idFreeSteps = stepsRegion.replace(/<id>[\s\S]*?<\/id>/g, "");

  const generatedIdentifiers: { tag: string; value: string }[] = [
    { tag: "fullName", value: ctx.apiName }, { tag: "label", value: ctx.procedureName },
    { tag: "developerName", value: ctx.apiName }, { tag: "name", value: ctx.apiName },
    { tag: "expressionSetDefinition", value: ctx.apiName },
  ];

  function regenerate(envelope: string): string {
    let out = envelope;
    out = out.replace(/<label>[\s\S]*?<\/label>/, `<label>${escapeXml(ctx.procedureName)}</label>`);
    if (ctx.description) out = out.replace(/<description>[\s\S]*?<\/description>/, `<description>${escapeXml(ctx.description)}</description>`);
    out = out.replace(/<fullName>[\s\S]*?<\/fullName>/g, `<fullName>${escapeXml(ctx.apiName)}</fullName>`);
    out = out.replace(/<developerName>[\s\S]*?<\/developerName>/, `<developerName>${escapeXml(ctx.apiName)}</developerName>`);
    out = out.replace(/<name>[\s\S]*?<\/name>/, `<name>${escapeXml(ctx.apiName)}</name>`);
    out = out.replace(/<expressionSetDefinition>[\s\S]*?<\/expressionSetDefinition>/, `<expressionSetDefinition>${escapeXml(ctx.apiName)}</expressionSetDefinition>`);
    return out;
  }
  let regeneratedBefore = regenerate(envelopeBefore);
  let regeneratedAfter = regenerate(envelopeAfter);

  const injected = injectVersionNumberAndRank(regeneratedBefore, regeneratedAfter, { versionNumber: ctx.versionNumber, rank: ctx.rank }, Number(process.env.PRICING_RULES_DEPLOY_API_VERSION ?? 62));
  regeneratedBefore = injected.envelopeBefore;
  regeneratedAfter = injected.envelopeAfter;
  warnings.push(...injected.warnings);

  const identityBearingTags = ["fullName", "developerName", "name", "expressionSetDefinition"];
  for (const tag of identityBearingTags) {
    const donorMatch = envelopeBefore.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    const generatedMatch = regeneratedBefore.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (donorMatch && generatedMatch && donorMatch[1] === generatedMatch[1] && donorMatch[1] === ctx.apiName) {
      warnings.push(`Generated <${tag}> equals the donor's own value — this is only safe if it's also intentionally equal to your chosen API name.`);
    } else if (donorMatch && generatedMatch && donorMatch[1] === generatedMatch[1]) {
      fatalErrors.push(`Generated <${tag}> still equals the donor's own original value ("${donorMatch[1]}") — identity regeneration failed for this tag.`);
    }
  }
  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  const assembledFileXml = regeneratedBefore + idFreeSteps + regeneratedAfter;

  const schemaReport = compareExpressionSetSchema(prunedDonorFileXmlForComparison, assembledFileXml);
  if (!schemaReport.structurallyValid) {
    fatalErrors.push(`Structural schema comparison against the donor failed:\n${schemaReport.reportText}`);
    return { success: false, fatalErrors, warnings };
  }

  const finalGraph = extractStepGraph(assembledFileXml);
  const finalVtdNodes = finalGraph.filter(n => n.actionType === "VolumeTierDiscount");
  if (finalVtdNodes.length !== 1) {
    fatalErrors.push(`Final composed canvas does not have exactly one VolumeTierDiscount step (found ${finalVtdNodes.length}).`);
    return { success: false, fatalErrors, warnings };
  }
  const finalVtdNode = finalVtdNodes[0];
  const finalVtdFields = collectFieldMap(finalVtdNode.full);
  const finalInputUnitPrice = finalVtdFields.get("InputUnitPrice") ?? null;
  if (finalInputUnitPrice !== targetInputUnitPriceValue) {
    fatalErrors.push(`Final composed canvas's VolumeTierDiscount InputUnitPrice ("${finalInputUnitPrice}") does not match the expected value ("${targetInputUnitPriceValue}").`);
    return { success: false, fatalErrors, warnings };
  }
  if (finalVtdFields.get("PriceAdjustmentScheduleId") !== "PriceAdjustmentSchedule") {
    fatalErrors.push(`Final composed canvas's VolumeTierDiscount PriceAdjustmentScheduleId binding ("${finalVtdFields.get("PriceAdjustmentScheduleId")}") is not bound to the runtime "PriceAdjustmentSchedule" context variable.`);
    return { success: false, fatalErrors, warnings };
  }
  const finalDangling = findDanglingParentStepReferences(finalGraph);
  if (finalDangling.length > 0) {
    fatalErrors.push(`Final composed canvas has ${finalDangling.length} dangling <parentStep> reference(s).`);
    return { success: false, fatalErrors, warnings };
  }
  if (finalGraph.length !== prunedGraph.length) {
    fatalErrors.push(`Final composed canvas step count (${finalGraph.length}) does not match the validated pre-serialization count (${prunedGraph.length}).`);
    return { success: false, fatalErrors, warnings };
  }

  const observedActionTypes = [...new Set(finalGraph.map(n => n.actionType).filter((t): t is string => !!t))];
  const stepStats: CanvasStepStats[] = finalGraph.map(n => ({ actionType: n.actionType ?? "(none)", parameterCount: collectFieldMap(n.full).size }));
  const variableCount = (assembledFileXml.match(/<variables>/g) ?? []).length;
  const outboundFullNameMatch = (regeneratedBefore + regeneratedAfter).match(/<fullName>([\s\S]*?)<\/fullName>/);
  const outboundEsdMatch = (regeneratedBefore + regeneratedAfter).match(/<expressionSetDefinition>([\s\S]*?)<\/expressionSetDefinition>/);

  return {
    success: true, fatalErrors: [], warnings,
    finalFileXml: assembledFileXml, donorFileName,
    lpLookup, vtdLookup, observedActionTypes, stepStats, variableCount,
    schemaReport, stepStructureReports: [psReport, lpReport, vtdReport],
    outboundVersionFields: {
      versionNumber: injected.outboundVersionNumber, rank: injected.outboundRank,
      fullName: outboundFullNameMatch ? outboundFullNameMatch[1] : null,
      expressionSetDefinition: outboundEsdMatch ? outboundEsdMatch[1] : null,
    },
    tierDiscountInputBinding: {
      listPriceOutputValues: donorLpOutputValues, inputUnitPriceValue: finalInputUnitPrice,
      originalInputUnitPriceValue: donorInputUnitPrice, wasPatched: donorInputUnitPrice !== targetInputUnitPriceValue,
      valid: finalInputUnitPrice === targetInputUnitPriceValue,
    },
    generatedIdentifiers,
    canvasComposition: {
      donorFullName: donorCandidate.fullName, donorFileName, donorPhysicalStepCount: donorGraph.length,
      prunedRootBranchCount: requiredComputation.removedRootBranches.length, finalPhysicalStepCount: finalGraph.length,
    },
  };
}

/** Local copy of xmlBlocks.ts's `extractElementSpans` (not re-exported by name there under a stable public
 * alias for this use) scoped to a single tag — used only to find the ExpressionSetDefinition root span. */
function extractElementSpansFor(xml: string, tagName: string): { start: number; end: number; content: string; full: string }[] {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
  const closeTag = `</${tagName}>`;
  const tokens: { pos: number; type: "open" | "close"; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml))) tokens.push({ pos: m.index, type: "open", len: m[0].length });
  let searchFrom = 0;
  for (;;) {
    const p = xml.indexOf(closeTag, searchFrom);
    if (p === -1) break;
    tokens.push({ pos: p, type: "close", len: closeTag.length });
    searchFrom = p + closeTag.length;
  }
  tokens.sort((a, b) => a.pos - b.pos);
  const spans: { start: number; end: number; content: string; full: string }[] = [];
  const openStack: { tagStart: number; contentStart: number }[] = [];
  for (const t of tokens) {
    if (t.type === "open") {
      openStack.push({ tagStart: t.pos, contentStart: t.pos + t.len });
    } else {
      const top = openStack.pop();
      if (!top) continue;
      const end = t.pos + t.len;
      spans.push({ start: top.tagStart, end, content: xml.slice(top.contentStart, t.pos), full: xml.slice(top.tagStart, end) });
    }
  }
  return spans;
}
