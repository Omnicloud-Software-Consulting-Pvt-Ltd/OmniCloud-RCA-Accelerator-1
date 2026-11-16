/**
 * Bundle-Based Pricing Expression Set XML builder — mirrors
 * lib/pricing-rules/attribute-based/create/canvasBuilder.ts's clone-and-patch architecture: `BundleDiscount`
 * is a real, org-configured Business Knowledge Model action type that cannot be hand-authored from a blank
 * canvas, so this NEVER builds XML from scratch. It clones exactly ONE donor's own coherent
 * PricingSettings/ListPrice/BundleDiscount branch (selected by donorInspection.ts), strips every
 * donor-specific literal (never leaking a donor's own bundle/component/schedule Ids or names), preserves
 * only generic, reusable runtime bindings, and re-validates the assembled result before returning it.
 *
 * The RECOGNIZED_PARAM_NAMES / BBP_STANDARD_CTX vocab below is taken from a live org's own Revenue
 * Management Default Pricing Procedure BundleDiscount step. Three things are explicitly (re)bound rather
 * than cloned: the lookup reference (LookUpId/LookUpApiName → the table `lookupTableResolver` resolved),
 * the schedule (the Constant variable the step's PriceAdjustmentScheduleId reads → this procedure's own
 * schedule), and InputUnitPrice (→ the retained ListPrice step's published output). The build then
 * proves every lookup-table INPUT column is bound on the generated step before returning.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  extractStepGraph, getTagValue, escapeXml, type PhysicalStepNode,
  getTopLevelParameterBlocks, getNestedCustomElementParameterBlocks, removeTopLevelParameters, removeNestedCustomElementParameters,
  getParamName, isOutputParam, isInputParam, getParamValue, setParamValue, extractElementSpans,
} from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences, findDanglingParentStepReferences } from "@/lib/pricing-rules/attribute-based/create/pricingCanvasPruning";
import { compareExpressionSetSchema, compareStepStructure, type StepStructureReport } from "@/lib/pricing-rules/attribute-based/create/schemaDiff";
import { injectVersionNumberAndRank, regenerateVersionedFullName, protectXmlBlocks, restoreXmlBlocks } from "@/lib/pricing-rules/attribute-based/create/versionEnvelopeFields";
import { resolveBundleBasedPricingDonor, resolveConnectedAncestor, SHARED_SIGNAL_ACTION_TYPES, buildNoCoherentDonorDiagnostic } from "./donorInspection";
import type { ResolvedBundleLookupTable } from "./lookupTableResolver";

const UNIT_PRICE_SEMANTIC_PRIORITY = ["UnitPrice", "NetUnitPrice", "ListPrice"];

/** Bindings this BundleDiscount engine actually understands and preserves — everything else (an
 * unrecognized NAME) is stripped unconditionally, exactly like AttributeDiscount's own RECOGNIZED_PARAM_NAMES.
 *
 * §Live-org fix — the org's real BundleDiscount step (Revenue Management Default Pricing Procedure) binds
 * one input per Bundle-Based Adjustment lookup-table column — ProductId, ParentProductId, RootBundleId and
 * the three selling models — plus the lookup reference itself (LookUpId/LookUpApiName/LookUpName) and
 * standard element flags. None of those were listed here before, so every one of them was stripped and
 * the generated step no longer executed any lookup table at all. */
const RECOGNIZED_PARAM_NAMES = new Set([
  "InputUnitPrice", "EffectiveFrom", "EffectiveTo", "Quantity", "InclusivePrice",
  "PriceAdjustmentScheduleId", "PriceAdjustmentScheduleName", "PriceAdjustmentScheduleIds", "PriceAdjustmentScheduleType",
  "ProductId", "ParentProductId", "RootBundleId",
  "ProductSellingModelId", "ParentProductSellingModelId", "RootProductSellingModelId",
  "BundleProductId", "ComponentProductId", "ChildProductId", "ComponentQuantity",
  "AdjustmentTypeField", "AdjustmentValueField",
  "LookUpId", "LookUpApiName", "LookUpName",
  "NetUnitPrice", "Subtotal",
  ...["IsContractEnabled", "HideWaterfall", "sectionCount", "selectedFunction", "IsRealTime"],
]);

/** Literal-typed element configuration flags — generic across every org, never a donor-specific record. */
const LITERAL_CONFIG_NAMES = new Set(["IsContractEnabled", "HideWaterfall", "sectionCount", "selectedFunction", "IsRealTime"]);
/** Lookup-reference literals — kept, then overwritten with the RESOLVED table (never trusted from the donor). */
const LOOKUP_REFERENCE_NAMES = new Set(["LookUpId", "LookUpApiName", "LookUpName"]);

/** Generic/context values a recognized-name input may legitimately be bound to — a recognized name bound
 * to anything NOT in this set (e.g. a literal donor bundle/component Id) is stripped conditionally. */
const BBP_STANDARD_CTX = new Set([
  "NetUnitPrice", "ListPrice", "Product", "Product2Id",
  "ProductSellingModel", "SellingModelType",
  "LineItemQuantity", "Quantity", "InclusivePrice",
  "PriceAdjustmentSchedule", "PriceAdjustmentScheduleId", "PriceAdjustmentScheduleName", "PriceAdjustmentScheduleIds", "PriceAdjustmentScheduleType",
  "EffectiveDate", "EffectiveFrom", "EffectiveTo", "PricingDate", "StartDate", "EndDate",
  "LineItem", "price_water_fall", "ItemNetTotalPrice",
  // RevSalesTransactionContext tags for a bundle component line's parent (main item) and root bundle.
  "MainItemProduct", "MainItemProductSellingModel", "RootItemProduct", "RootProductSellingModel",
  "BundleProduct", "ComponentProduct", "ChildProduct", "ParentProduct", "BundleComponent", "ComponentQuantity",
  "AdjustmentType", "AdjustmentValue", "Constant_AdjustmentType_Bundle_Based", "Constant_AdjustmentValue_Bundle_Based",
]);

function shouldStripBundleDiscountParam(block: string): boolean {
  if (isOutputParam(block)) return false;
  const name = getParamName(block);
  if (name === "InputUnitPrice") return false;
  // The schedule binding is a reference to a Constant variable (e.g. BundlePASIdConstant) that
  // `rebindScheduleConstant` re-points at this procedure's own schedule — never stripped.
  if (name === "PriceAdjustmentScheduleId") return false;
  const value = getParamValue(block);
  if (!name || !RECOGNIZED_PARAM_NAMES.has(name)) return true;
  if (getTagValue(block, "type") === "Literal" && (LITERAL_CONFIG_NAMES.has(name) || LOOKUP_REFERENCE_NAMES.has(name))) return false;
  const isInput = isInputParam(block) || getTagValue(block, "type") === "Parameter";
  if (isInput && value && !BBP_STANDARD_CTX.has(value) && !RECOGNIZED_PARAM_NAMES.has(value)) return true;
  return false;
}

/** Points the step's LookUp* literals at the resolved table. Fails if the donor step has no lookup
 * reference at all — this pipeline never invents step XML. */
export function bindLookupReference(
  ownPart: string,
  table: { id: string; developerName: string; label: string },
): { xml: string; before: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null }; error?: string } {
  const blocks = getNestedCustomElementParameterBlocks(ownPart);
  const find = (n: string) => blocks.find(b => getParamName(b.block) === n);
  const before = {
    lookUpId: find("LookUpId") ? getParamValue(find("LookUpId")!.block) : null,
    lookUpApiName: find("LookUpApiName") ? getParamValue(find("LookUpApiName")!.block) : null,
    lookUpName: find("LookUpName") ? getParamValue(find("LookUpName")!.block) : null,
  };
  if (!find("LookUpId") || !find("LookUpApiName")) {
    return { xml: ownPart, before, error: "The donor BundleDiscount step has no LookUpId/LookUpApiName parameters — it cannot be bound to a lookup table." };
  }
  const replacements: [string, string][] = [["LookUpId", table.id], ["LookUpApiName", table.developerName]];
  // LookUpName is a display label; keep the donor's when it already names the same table.
  const sameTable = before.lookUpId?.slice(0, 15) === table.id.slice(0, 15) || before.lookUpApiName === table.developerName;
  if (find("LookUpName") && !sameTable) replacements.push(["LookUpName", table.label]);
  let xml = ownPart;
  // Replace from the end so earlier offsets stay valid.
  const targets = replacements
    .map(([n, v]) => ({ block: find(n)!, value: v }))
    .sort((a, b) => b.block.start - a.block.start);
  for (const t of targets) xml = xml.slice(0, t.block.start) + setParamValue(t.block.block, t.value) + xml.slice(t.block.end);
  return { xml, before };
}

/** Re-points the Constant variable a BundleDiscount step reads its schedule from at `scheduleId`. */
export function rebindScheduleConstant(fileXml: string, variableName: string, scheduleId: string): { xml: string; previousValue: string | null; error?: string } {
  const re = /<variables>[\s\S]*?<\/variables>/g;
  let m: RegExpExecArray | null;
  const matches: { start: number; end: number; block: string }[] = [];
  while ((m = re.exec(fileXml))) {
    if (getTagValue(m[0], "name") === variableName) matches.push({ start: m.index, end: m.index + m[0].length, block: m[0] });
  }
  if (matches.length === 0) return { xml: fileXml, previousValue: null, error: `The schedule binding "${variableName}" is not a declared variable in the donor.` };
  let xml = fileXml;
  let previousValue: string | null = null;
  for (const match of matches.sort((a, b) => b.start - a.start)) {
    if (getTagValue(match.block, "type") !== "Constant") {
      return { xml: fileXml, previousValue: null, error: `The schedule binding "${variableName}" is a ${getTagValue(match.block, "type") ?? "non-constant"} variable, not a Constant — it can't be pointed at this procedure's schedule.` };
    }
    previousValue = getTagValue(match.block, "value");
    const updated = match.block.includes("<value>")
      ? match.block.replace(/<value>[\s\S]*?<\/value>/, `<value>${escapeXml(scheduleId)}</value>`)
      : match.block.replace("</variables>", `<value>${escapeXml(scheduleId)}</value></variables>`);
    xml = xml.slice(0, match.start) + updated + xml.slice(match.end);
  }
  return { xml, previousValue };
}

export function patchA_stripBundleLiterals(ownPart: string): string {
  let result = removeTopLevelParameters(ownPart, shouldStripBundleDiscountParam);
  result = removeNestedCustomElementParameters(result, shouldStripBundleDiscountParam);
  return result;
}

function collectFieldMap(xmlSlice: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of [...getTopLevelParameterBlocks(xmlSlice), ...getNestedCustomElementParameterBlocks(xmlSlice)]) {
    const n = getParamName(b.block);
    if (n) map.set(n, getParamValue(b.block));
  }
  return map;
}

export interface BundleDiscountBranchCandidate { occurrenceIndex: number; score: number; reasons: string[]; }
export interface BundleDiscountBranchSelection {
  selectedOccurrenceIndex: number | null;
  candidates: BundleDiscountBranchCandidate[];
  ambiguous: boolean;
}

function selectBundleDiscountBranch(donorGraph: PhysicalStepNode[], occurrences: PhysicalStepNode[]): BundleDiscountBranchSelection {
  if (occurrences.length === 0) return { selectedOccurrenceIndex: null, candidates: [], ambiguous: false };
  if (occurrences.length === 1) {
    return { selectedOccurrenceIndex: occurrences[0].occurrenceIndex, candidates: [{ occurrenceIndex: occurrences[0].occurrenceIndex, score: 0, reasons: ["no disambiguation needed"] }], ambiguous: false };
  }
  const fieldMaps = occurrences.map(n => ({ node: n, fields: collectFieldMap(n.full) }));
  const candidates: BundleDiscountBranchCandidate[] = fieldMaps.map(({ node, fields }) => {
    let score = 0;
    const reasons: string[] = [];
    const contractEnabled = fields.get("IsContractEnabled");
    if (contractEnabled === "true") { score -= 3; reasons.push("IsContractEnabled=true (-3)"); }
    else if (contractEnabled === "false") { score += 3; reasons.push("IsContractEnabled=false (+3)"); }
    const schedule = fields.get("PriceAdjustmentScheduleId");
    if (schedule && /contract/i.test(schedule)) { score -= 2; reasons.push("schedule binding mentions contract (-2)"); }
    else if (schedule && /constant/i.test(schedule)) { score += 2; reasons.push("schedule binding is a constant (+2)"); }
    const exclusiveNames = [...fields.keys()].filter(name => !fieldMaps.some(other => other.node !== node && other.fields.has(name)));
    for (const name of exclusiveNames) {
      const value = fields.get(name);
      if (/contract/i.test(name) || (value && /contract/i.test(value))) { score -= 1; reasons.push(`branch-exclusive field "${name}" mentions contract (-1)`); }
    }
    return { occurrenceIndex: node.occurrenceIndex, score, reasons, __exclusiveCount: exclusiveNames.length } as BundleDiscountBranchCandidate & { __exclusiveCount: number };
  });
  const minExclusive = Math.min(...candidates.map(c => (c as BundleDiscountBranchCandidate & { __exclusiveCount: number }).__exclusiveCount));
  for (const c of candidates) {
    if ((c as BundleDiscountBranchCandidate & { __exclusiveCount: number }).__exclusiveCount === minExclusive) { c.score += 1; c.reasons.push("fewest branch-exclusive fields — most generic/base candidate (+1)"); }
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const ambiguous = sorted.length > 1 && sorted[0].score === sorted[1].score;
  return { selectedOccurrenceIndex: ambiguous ? null : sorted[0].occurrenceIndex, candidates: sorted, ambiguous };
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
  observedActionTypes?: string[];
  stepStats?: CanvasStepStats[];
  variableCount?: number;
  schemaReport?: ReturnType<typeof compareExpressionSetSchema>;
  stepStructureReports?: StepStructureReport[];
  outboundVersionFields?: { versionNumber: string | null; rank: string | null; fullName: string | null; expressionSetDefinition: string | null };
  bundleDiscountBranchSelection?: BundleDiscountBranchSelection;
  bundleDiscountInputBinding?: { listPriceOutputValues: string[]; inputUnitPriceValue: string | null; originalInputUnitPriceValue: string | null; wasPatched: boolean; valid: boolean };
  generatedIdentifiers?: { tag: string; value: string }[];
  canvasComposition?: { donorFullName: string; donorFileName: string; donorPhysicalStepCount: number; prunedRootBranchCount: number; finalPhysicalStepCount: number };
  /** Exactly how the generated BundleDiscount step reaches the lookup table and schedule. */
  lookupBinding?: BundleLookupBindingReport;
}

export interface BundleLookupBindingReport {
  lookupTableId: string;
  lookupTableApiName: string;
  donorLookUpId: string | null;
  donorLookUpApiName: string | null;
  scheduleVariable: string;
  scheduleId: string;
  donorScheduleId: string | null;
  /** Lookup-table INPUT column → the context tag / variable the generated step binds it to. */
  inputBindings: { column: string; boundTo: string | null }[];
  outputs: string[];
  /** The step's published outputs (what it writes back into the pricing context). */
  stepOutputs: string[];
}

export interface BundleCanvasContext {
  procedureName: string;
  apiName: string;
  description?: string;
  versionNumber?: number;
  rank?: number | null;
  /** This procedure's own Bundle Price Adjustment Schedule — the step is bound to it. */
  scheduleId: string;
  lookupTable: ResolvedBundleLookupTable;
  onProgress?: (phase: "template-retrieved") => void;
}

export async function buildBundleCanvas(client: SalesforceClient, ctx: BundleCanvasContext): Promise<CanvasBuildResult> {
  const donorResolution = await resolveBundleBasedPricingDonor(client, { lookupTable: ctx.lookupTable, excludeDefinitionApiName: ctx.apiName });
  return buildBundleCanvasFromDonor(donorResolution, ctx);
}

/** The pure (no Salesforce I/O) half of `buildBundleCanvas` — exported so it can be exercised against a real
 * retrieved donor file in tests. */
export function buildBundleCanvasFromDonor(
  donorResolution: Awaited<ReturnType<typeof resolveBundleBasedPricingDonor>>,
  ctx: BundleCanvasContext,
): CanvasBuildResult {
  const fatalErrors: string[] = [];
  const warnings: string[] = [];

  if (!donorResolution.selection) {
    fatalErrors.push(
      "No valid Bundle-Based Pricing Expression Set donor was found in this org.\n\n" +
      buildNoCoherentDonorDiagnostic(donorResolution.candidatesWithBundleDiscount) +
      (donorResolution.lowConfidenceCandidates
        ? `\n\nNote: some candidates DID prove a BundleDiscount->ListPrice connection but scored below the trust floor:\n${donorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`
        : ""),
    );
    return { success: false, fatalErrors, warnings };
  }
  ctx.onProgress?.("template-retrieved");
  const { fullXml: donorFileXml, fileName: donorFileName, candidate: donorCandidate, connectedBundleDiscountOccurrenceIndexes } = donorResolution.selection;

  const donorGraphOriginal = extractStepGraph(donorFileXml);
  const donorGraphSecondPass = extractStepGraph(donorFileXml);
  const deterministic = donorGraphOriginal.length === donorGraphSecondPass.length
    && donorGraphOriginal.every((n, i) => n.name === donorGraphSecondPass[i].name && n.actionType === donorGraphSecondPass[i].actionType && n.parentStep === donorGraphSecondPass[i].parentStep);
  if (!deterministic) {
    fatalErrors.push("Donor XML extraction was non-deterministic across two identical parses — refusing to proceed on unstable input.");
    return { success: false, fatalErrors, warnings };
  }

  const connectedBdNodes = donorGraphOriginal.filter(n => n.actionType === "BundleDiscount" && connectedBundleDiscountOccurrenceIndexes.includes(n.occurrenceIndex));
  const branchSelection = selectBundleDiscountBranch(donorGraphOriginal, connectedBdNodes);
  if (branchSelection.selectedOccurrenceIndex === null) {
    if (branchSelection.ambiguous) {
      fatalErrors.push(`Multiple equally-plausible BundleDiscount branches were found in donor "${donorCandidate.fullName}" and none could be confidently disambiguated — refusing to guess.`);
    } else {
      fatalErrors.push(`No connected BundleDiscount branch could be selected from donor "${donorCandidate.fullName}".`);
    }
    return { success: false, fatalErrors, warnings };
  }
  const bdNode = donorGraphOriginal.find(n => n.occurrenceIndex === branchSelection.selectedOccurrenceIndex)!;

  const psResolution = resolveConnectedAncestor(donorGraphOriginal, bdNode, "PricingSettings");
  const lpResolution = resolveConnectedAncestor(donorGraphOriginal, bdNode, "ListPrice");
  if (!psResolution.node || !lpResolution.node) {
    fatalErrors.push(`Selected BundleDiscount branch (occurrence ${bdNode.occurrenceIndex}) does not resolve to both a PricingSettings and a ListPrice ancestor.`);
    return { success: false, fatalErrors, warnings };
  }
  const psNode = psResolution.node;
  const lpNode = lpResolution.node;
  const psXml = psNode.full;
  const lpXml = lpNode.full;

  const lpBindings = collectFieldMap(lpXml);
  const lpLookup = {
    lookUpId: lpBindings.get("LookUpId") ?? null,
    lookUpApiName: lpBindings.get("LookUpApiName") ?? null,
    lookUpName: lpBindings.get("LookUpName") ?? null,
  };

  const bdOwnBindings = collectFieldMap(collectOwnFields(bdNode));
  const donorInputUnitPrice = bdOwnBindings.get("InputUnitPrice") ?? null;
  const lpOwnBindings = [...getTopLevelParameterBlocks(lpXml), ...getNestedCustomElementParameterBlocks(lpXml)].filter(b => getTagValue(b.block, "output") === "true");
  const donorLpOutputValues = lpOwnBindings.map(b => getParamValue(b.block)).filter((v): v is string => !!v);
  const targetInputUnitPriceValue = resolveTargetInputUnitPriceValue(donorInputUnitPrice, donorLpOutputValues);
  if (!targetInputUnitPriceValue) {
    fatalErrors.push("Could not resolve a target InputUnitPrice value from the donor's ListPrice outputs — refusing to bind BundleDiscount to an unpublished value.");
    return { success: false, fatalErrors, warnings };
  }

  // §Live-org fix — BundleDiscount is a leaf step: every binding lives inside its own <customElement>.
  // The previous split-before-<customElement> left all of them in the untouched "nested" half, so the
  // strip, the InputUnitPrice alignment, and schedule handling silently never ran. Patch the step whole.
  if (bdNode.content.includes("<steps")) {
    fatalErrors.push(`The selected BundleDiscount step (occurrence ${bdNode.occurrenceIndex}) unexpectedly contains nested steps — refusing to patch it.`);
    return { success: false, fatalErrors, warnings };
  }
  let bdXml = patchA_stripBundleLiterals(bdNode.full);
  const inputUnitPriceNeedsAlignment = donorInputUnitPrice !== targetInputUnitPriceValue;
  if (inputUnitPriceNeedsAlignment) {
    const existingBlock = getTopLevelParameterBlocks(bdXml).find(b => getParamName(b.block) === "InputUnitPrice")
      ?? getNestedCustomElementParameterBlocks(bdXml).find(b => getParamName(b.block) === "InputUnitPrice");
    if (existingBlock) {
      bdXml = bdXml.slice(0, existingBlock.start) + setParamValue(existingBlock.block, targetInputUnitPriceValue) + bdXml.slice(existingBlock.end);
    }
  }

  const lookupBound = bindLookupReference(bdXml, ctx.lookupTable);
  if (lookupBound.error) {
    fatalErrors.push(lookupBound.error);
    return { success: false, fatalErrors, warnings };
  }
  bdXml = lookupBound.xml;
  if (lookupBound.before.lookUpId && lookupBound.before.lookUpId.slice(0, 15) !== ctx.lookupTable.id.slice(0, 15)) {
    warnings.push(`Donor BundleDiscount step executed lookup table ${lookupBound.before.lookUpApiName ?? lookupBound.before.lookUpId}; the generated step is re-bound to the resolved table ${ctx.lookupTable.developerName} (${ctx.lookupTable.id}).`);
  }

  const requiredInputs = ["PriceAdjustmentScheduleId"];
  const bdFieldMap = collectFieldMap(bdXml);
  const missingInputs = requiredInputs.filter(name => !bdFieldMap.has(name));
  if (missingInputs.length > 0) {
    fatalErrors.push(`Generated BundleDiscount step is missing required binding(s): ${missingInputs.join(", ")}.`);
    return { success: false, fatalErrors, warnings };
  }
  const scheduleVariable = bdFieldMap.get("PriceAdjustmentScheduleId");
  if (!scheduleVariable) {
    fatalErrors.push("Generated BundleDiscount step's PriceAdjustmentScheduleId binding has no value.");
    return { success: false, fatalErrors, warnings };
  }

  // Every column the lookup table matches on must be fed by the step, or no row could ever match.
  const unboundColumns = ctx.lookupTable.inputs.map(i => i.fieldName).filter(col => !bdFieldMap.get(col));
  if (unboundColumns.length > 0) {
    fatalErrors.push(
      `Generated BundleDiscount step does not bind lookup-table INPUT column(s) [${unboundColumns.join(", ")}] of ${ctx.lookupTable.developerName}. ` +
      `Step bindings: ${[...bdFieldMap.entries()].map(([k, v]) => `${k}=${v ?? ""}`).join(", ")}.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  const hasOutput = [...getTopLevelParameterBlocks(bdXml), ...getNestedCustomElementParameterBlocks(bdXml)].some(b => getTagValue(b.block, "output") === "true");
  if (!hasOutput) warnings.push("Generated BundleDiscount step has no output parameter — Salesforce may reject a step that publishes nothing.");

  const leakCheck = [...getTopLevelParameterBlocks(bdXml), ...getNestedCustomElementParameterBlocks(bdXml)]
    .map(b => getParamName(b.block))
    .filter((n): n is string => !!n)
    .filter(n => !RECOGNIZED_PARAM_NAMES.has(n));
  if (leakCheck.length > 0) {
    fatalErrors.push(`Generated BundleDiscount step still contains unrecognized parameter name(s) after stripping: ${leakCheck.join(", ")} — refusing to deploy a possible donor-literal leak.`);
    return { success: false, fatalErrors, warnings };
  }

  const psReport = compareStepStructure(extractElementSpans(donorFileXml, "steps").find(s => s.start === psNode.start) ?? null, psXml, "PricingSettings");
  const lpReport = compareStepStructure(extractElementSpans(donorFileXml, "steps").find(s => s.start === lpNode.start) ?? null, lpXml, "ListPrice");
  const bdReport = compareStepStructure(extractElementSpans(donorFileXml, "steps").find(s => s.start === bdNode.start) ?? null, bdXml, "BundleDiscount");
  for (const r of [psReport, lpReport, bdReport]) if (!r.structurallyValid) fatalErrors.push(`Step structure validation failed for ${r.actionType}:\n${r.reportText}`);
  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  // Splice the patched BundleDiscount content back into the donor bytes at its exact original span —
  // content-only replacement, never adding/removing a <steps> tag, so occurrence indices stay stable.
  const patchedDonorFileXml = donorFileXml.slice(0, bdNode.start) + bdXml + donorFileXml.slice(bdNode.end);
  const patchedDonorGraph = extractStepGraph(patchedDonorFileXml);
  const patchedBdNode = patchedDonorGraph.find(n => n.occurrenceIndex === bdNode.occurrenceIndex)!;

  const requiredComputation = computeRequiredOccurrenceIndexes(patchedDonorGraph, patchedBdNode.occurrenceIndex, [psNode.occurrenceIndex, lpNode.occurrenceIndex]);
  if (!requiredComputation) {
    fatalErrors.push("Could not compute the required-occurrence set for pruning.");
    return { success: false, fatalErrors, warnings };
  }
  const prunedXml = pruneXmlToRequiredOccurrences(patchedDonorFileXml, requiredComputation.removedRootBranches, patchedDonorGraph);
  const prunedDonorFileXmlForComparison = pruneXmlToRequiredOccurrences(donorFileXml, requiredComputation.removedRootBranches, donorGraphOriginal);

  const prunedGraph = extractStepGraph(prunedXml);
  const dangling = findDanglingParentStepReferences(prunedGraph, patchedDonorGraph);
  if (dangling.length > 0) {
    fatalErrors.push(`Pruning would create ${dangling.length} dangling <parentStep> reference(s) — aborting rather than deploying a broken canvas.`);
    return { success: false, fatalErrors, warnings };
  }
  const survivingUnrelated = [...new Set(prunedGraph.map(n => n.actionType).filter((t): t is string => !!t && SHARED_SIGNAL_ACTION_TYPES.has(t)))];
  if (survivingUnrelated.length > 0) {
    fatalErrors.push(`Pruned canvas still contains unrelated pricing-type branch(es): ${survivingUnrelated.join(", ")} — pruning did not fully isolate the Bundle-Based Pricing branch.`);
    return { success: false, fatalErrors, warnings };
  }
  const psCount = prunedGraph.filter(n => n.actionType === "PricingSettings").length;
  const lpCount = prunedGraph.filter(n => n.actionType === "ListPrice").length;
  const bdCount = prunedGraph.filter(n => n.actionType === "BundleDiscount").length;
  if (psCount !== 1 || lpCount !== 1 || bdCount !== 1) {
    fatalErrors.push(`Pruned canvas does not have exactly one each of PricingSettings/ListPrice/BundleDiscount (got ${psCount}/${lpCount}/${bdCount}).`);
    return { success: false, fatalErrors, warnings };
  }

  /* ── Envelope regeneration ── */
  const rootSpans = extractElementSpans(prunedXml, "ExpressionSetDefinition");
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
    { tag: "fullName", value: regenerateVersionedFullName(getTagValue(envelopeBefore, "fullName") ?? ctx.apiName, ctx.apiName, ctx.versionNumber) },
    { tag: "label", value: ctx.procedureName },
    { tag: "developerName", value: ctx.apiName }, { tag: "name", value: ctx.apiName },
    { tag: "expressionSetDefinition", value: ctx.apiName },
  ];

  function regenerate(envelope: string): string {
    // §Fix — `<variables>` declarations live in this same envelope and carry their own <name>/<description>.
    // An unshielded <name> replacement renamed the first variable after the steps to the procedure's API
    // name (a live deploy showed exactly that); shield them exactly like the attribute builder does.
    const shielded = new Map<string, string>();
    let out = protectXmlBlocks(envelope, "variables", shielded);
    // Global: the envelope holds both the definition's and the version's own <label>/<description> —
    // leaving the version's would show the generated procedure as the donor ("…Default Pricing
    // Procedure V1") in Setup.
    out = out.replace(/<label>[\s\S]*?<\/label>/g, `<label>${escapeXml(ctx.procedureName)}</label>`);
    out = out.replace(/<description>[\s\S]*?<\/description>/g, `<description>${escapeXml(ctx.description || `Bundle-Based Pricing procedure: ${ctx.procedureName}`)}</description>`);
    // The version's own identity carries a version suffix whenever a next version was resolved, so a second
    // version of this procedure never collides with the first.
    out = out.replace(/<fullName>([\s\S]*?)<\/fullName>/g, (_m, donorValue: string) => `<fullName>${escapeXml(regenerateVersionedFullName(donorValue, ctx.apiName, ctx.versionNumber))}</fullName>`);
    out = out.replace(/<developerName>[\s\S]*?<\/developerName>/, `<developerName>${escapeXml(ctx.apiName)}</developerName>`);
    out = out.replace(/<name>[\s\S]*?<\/name>/, `<name>${escapeXml(ctx.apiName)}</name>`);
    out = out.replace(/<expressionSetDefinition>[\s\S]*?<\/expressionSetDefinition>/, `<expressionSetDefinition>${escapeXml(ctx.apiName)}</expressionSetDefinition>`);
    return restoreXmlBlocks(out, shielded);
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
      // apiName happens to equal the donor's own value — not itself an error, but flag it since it means
      // the "still equals donor" check below can't distinguish a real collision from a coincidence.
      warnings.push(`Generated <${tag}> equals the donor's own value — this is only safe if it's also intentionally equal to your chosen API name.`);
    } else if (donorMatch && generatedMatch && donorMatch[1] === generatedMatch[1]) {
      fatalErrors.push(`Generated <${tag}> still equals the donor's own original value ("${donorMatch[1]}") — identity regeneration failed for this tag.`);
    }
  }
  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  const rebound = rebindScheduleConstant(regeneratedBefore + idFreeSteps + regeneratedAfter, scheduleVariable, ctx.scheduleId);
  if (rebound.error) {
    fatalErrors.push(rebound.error);
    return { success: false, fatalErrors, warnings };
  }
  const assembledFileXml = rebound.xml;

  const schemaReport = compareExpressionSetSchema(prunedDonorFileXmlForComparison, assembledFileXml);
  if (!schemaReport.structurallyValid) {
    fatalErrors.push(`Structural schema comparison against the donor failed:\n${schemaReport.reportText}`);
    return { success: false, fatalErrors, warnings };
  }

  const finalGraph = extractStepGraph(assembledFileXml);
  const finalBdNodes = finalGraph.filter(n => n.actionType === "BundleDiscount");
  if (finalBdNodes.length !== 1) {
    fatalErrors.push(`Final composed canvas does not have exactly one BundleDiscount step (found ${finalBdNodes.length}).`);
    return { success: false, fatalErrors, warnings };
  }
  const finalBdNode = finalBdNodes[0];
  const finalBdFields = collectFieldMap(finalBdNode.full);
  const finalInputUnitPrice = finalBdFields.get("InputUnitPrice") ?? null;
  if (finalInputUnitPrice !== targetInputUnitPriceValue) {
    fatalErrors.push(`Final composed canvas's BundleDiscount InputUnitPrice ("${finalInputUnitPrice}") does not match the expected value ("${targetInputUnitPriceValue}").`);
    return { success: false, fatalErrors, warnings };
  }
  if (finalBdFields.get("LookUpId") !== ctx.lookupTable.id || finalBdFields.get("LookUpApiName") !== ctx.lookupTable.developerName) {
    fatalErrors.push(`Final composed canvas's BundleDiscount step is not bound to the resolved lookup table ${ctx.lookupTable.developerName} (${ctx.lookupTable.id}) — found LookUpId="${finalBdFields.get("LookUpId") ?? ""}", LookUpApiName="${finalBdFields.get("LookUpApiName") ?? ""}".`);
    return { success: false, fatalErrors, warnings };
  }
  const finalScheduleVar = extractElementSpans(assembledFileXml, "variables").map(s => assembledFileXml.slice(s.start, s.end)).find(v => getTagValue(v, "name") === scheduleVariable);
  if (!finalScheduleVar || getTagValue(finalScheduleVar, "value") !== ctx.scheduleId) {
    fatalErrors.push(`Final composed canvas's schedule variable "${scheduleVariable}" does not hold this procedure's schedule ${ctx.scheduleId}.`);
    return { success: false, fatalErrors, warnings };
  }
  const lookupBindingReport: BundleLookupBindingReport = {
    lookupTableId: ctx.lookupTable.id, lookupTableApiName: ctx.lookupTable.developerName,
    donorLookUpId: lookupBound.before.lookUpId, donorLookUpApiName: lookupBound.before.lookUpApiName,
    scheduleVariable, scheduleId: ctx.scheduleId, donorScheduleId: rebound.previousValue,
    inputBindings: ctx.lookupTable.inputs.map(i => ({ column: i.fieldName, boundTo: finalBdFields.get(i.fieldName) ?? null })),
    outputs: ctx.lookupTable.outputs,
    stepOutputs: [...getTopLevelParameterBlocks(finalBdNode.full), ...getNestedCustomElementParameterBlocks(finalBdNode.full)]
      .filter(b => isOutputParam(b.block)).map(b => `${getParamName(b.block)}→${getParamValue(b.block)}`),
  };
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
    lpLookup, observedActionTypes, stepStats, variableCount,
    schemaReport, stepStructureReports: [psReport, lpReport, bdReport],
    outboundVersionFields: {
      versionNumber: injected.outboundVersionNumber, rank: injected.outboundRank,
      fullName: outboundFullNameMatch ? outboundFullNameMatch[1] : null,
      expressionSetDefinition: outboundEsdMatch ? outboundEsdMatch[1] : null,
    },
    bundleDiscountBranchSelection: branchSelection,
    bundleDiscountInputBinding: {
      listPriceOutputValues: donorLpOutputValues, inputUnitPriceValue: finalInputUnitPrice,
      originalInputUnitPriceValue: donorInputUnitPrice, wasPatched: inputUnitPriceNeedsAlignment,
      valid: finalInputUnitPrice === targetInputUnitPriceValue,
    },
    generatedIdentifiers,
    canvasComposition: {
      donorFullName: donorCandidate.fullName, donorFileName, donorPhysicalStepCount: donorGraphOriginal.length,
      prunedRootBranchCount: requiredComputation.removedRootBranches.length, finalPhysicalStepCount: finalGraph.length,
    },
    lookupBinding: lookupBindingReport,
  };
}

function collectOwnFields(node: PhysicalStepNode): string {
  const nestedIdx = node.content.indexOf("<steps");
  return nestedIdx === -1 ? node.content : node.content.slice(0, nestedIdx);
}
