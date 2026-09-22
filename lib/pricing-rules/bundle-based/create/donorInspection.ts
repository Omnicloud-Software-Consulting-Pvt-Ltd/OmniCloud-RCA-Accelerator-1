/**
 * Bundle-Based Pricing Expression Set donor discovery — mirrors
 * lib/pricing-rules/attribute-based/create/donorInspection.ts's exact architecture and safety invariants,
 * targeting `BundleDiscount` (this org's real, distinct Business Knowledge Model action type for
 * Bundle-Based Adjustments — already recognized elsewhere in this codebase's own
 * SHARED_SIGNAL_ACTION_TYPES list) instead of `AttributeDiscount`.
 *
 * `BundleDiscount` cannot be hand-authored from a blank canvas (its legal values/behavior are
 * org-configured, just like AttributeDiscount) — this module ONLY ever selects an existing, real,
 * already-deployed donor whose own BundleDiscount branch is PROVEN connected to that same donor's
 * ListPrice step. It never merges a BundleDiscount branch from one donor with PricingSettings/ListPrice
 * from another, never invents a `<parentStep>` link, and refuses the "least bad" candidate when nothing
 * scores above the trust floor.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { extractStepGraph, getTagValue, type PhysicalStepNode } from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { retrieveExpressionSetDefinitionFiles } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";

/** Every OTHER standard pricing-procedure action type this org may also use — swapped from the
 * attribute-based module's own list: AttributeDiscount moves IN (it's unrelated to bundle pricing),
 * BundleDiscount moves OUT (it's the self/target type here). */
export const SHARED_SIGNAL_ACTION_TYPES = new Set([
  "FormulaBasedPricing", "ManualDiscount", "VolumeTierDiscount", "VolumeDiscount", "AttributeDiscount", "Proration", "SubscriptionPricing",
]);

const MINIMUM_TRUSTED_DONOR_SCORE = 0;

export type ConnectionMechanism = "parentStep-chain" | "physical-nesting" | "variable-binding" | "sequence-order" | "none";

export interface ResolvedConnectedAncestor { node: PhysicalStepNode | null; mechanism: ConnectionMechanism; }

export interface RawParameterBinding { name: string | null; value: string | null; input: boolean; output: boolean; }

function ownFieldsOnly(node: PhysicalStepNode): string {
  const nestedIdx = node.content.indexOf("<steps");
  return nestedIdx === -1 ? node.content : node.content.slice(0, nestedIdx);
}

function collectAllParameterBindings(xmlSlice: string): RawParameterBinding[] {
  const out: RawParameterBinding[] = [];
  const re = /<parameters>[\s\S]*?<\/parameters>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xmlSlice))) {
    const block = m[0];
    out.push({
      name: getTagValue(block, "name"),
      value: getTagValue(block, "value"),
      input: getTagValue(block, "input") === "true",
      output: getTagValue(block, "output") === "true",
    });
  }
  return out;
}

function findBindingValue(bindings: RawParameterBinding[], name: string): string | null {
  return bindings.find(b => b.name === name)?.value ?? null;
}

function parsedSequenceNumber(node: PhysicalStepNode): number | null {
  const n = node.sequenceNumber != null ? Number(node.sequenceNumber) : NaN;
  return Number.isFinite(n) ? n : null;
}

function walkParentStepChainNames(graph: PhysicalStepNode[], start: PhysicalStepNode): { chain: PhysicalStepNode[] } {
  const chain: PhysicalStepNode[] = [];
  const visited = new Set<string>();
  let currentName = start.parentStep;
  while (currentName) {
    if (visited.has(currentName)) break;
    visited.add(currentName);
    const matches = graph.filter(n => n.name === currentName);
    if (matches.length !== 1) break;
    chain.push(matches[0]);
    currentName = matches[0].parentStep;
  }
  return { chain };
}

function physicalAncestorNodes(graph: PhysicalStepNode[], node: PhysicalStepNode): PhysicalStepNode[] {
  const byOccurrence = new Map(graph.map(n => [n.occurrenceIndex, n]));
  const out: PhysicalStepNode[] = [];
  let parentIdx = node.parentOccurrenceIndex;
  while (parentIdx !== null) {
    const parent = byOccurrence.get(parentIdx);
    if (!parent) break;
    out.push(parent);
    parentIdx = parent.parentOccurrenceIndex;
  }
  return out;
}

function resolveListPriceViaVariableBinding(graph: PhysicalStepNode[], bdNode: PhysicalStepNode): { node: PhysicalStepNode | null } {
  const bdBindings = collectAllParameterBindings(ownFieldsOnly(bdNode));
  const inputUnitPrice = findBindingValue(bdBindings, "InputUnitPrice");
  if (!inputUnitPrice) return { node: null };
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const matches = listPriceNodes.filter(lp =>
    collectAllParameterBindings(lp.full).some(b => b.output && b.value === inputUnitPrice),
  );
  return matches.length === 1 ? { node: matches[0] } : { node: null };
}

/** The 4-signal connection resolver — identical priority order/logic to the attribute-based module's own
 * `resolveConnectedAncestor`, generalized so the variable-binding signal (weak, hardcoded pair in the
 * original) fires for `targetActionType === "ListPrice" && node.actionType === "BundleDiscount"` instead. */
export function resolveConnectedAncestor(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ResolvedConnectedAncestor {
  const chain = walkParentStepChainNames(graph, node).chain;
  const viaChain = chain.find(n => n.actionType === targetActionType);
  if (viaChain) return { node: viaChain, mechanism: "parentStep-chain" };

  const viaPhysical = physicalAncestorNodes(graph, node).find(n => n.actionType === targetActionType);
  if (viaPhysical) return { node: viaPhysical, mechanism: "physical-nesting" };

  if (targetActionType === "ListPrice" && node.actionType === "BundleDiscount") {
    const viaBinding = resolveListPriceViaVariableBinding(graph, node);
    if (viaBinding.node) return { node: viaBinding.node, mechanism: "variable-binding" };
  }

  const nodeSeq = parsedSequenceNumber(node);
  if (nodeSeq !== null) {
    const candidates = graph
      .filter(n => n.actionType === targetActionType)
      .map(n => ({ n, seq: parsedSequenceNumber(n) }))
      .filter((c): c is { n: PhysicalStepNode; seq: number } => c.seq !== null && c.seq < nodeSeq)
      .sort((a, b) => b.seq - a.seq);
    if (candidates.length > 0) return { node: candidates[0].n, mechanism: "sequence-order" };
  }
  return { node: null, mechanism: "none" };
}

export function resolveConnection(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ConnectionMechanism {
  return resolveConnectedAncestor(graph, node, targetActionType).mechanism;
}

export interface BundleDiscountBindingSnapshot {
  inputUnitPrice: string | null;
  priceAdjustmentScheduleBinding: string | null;
  publishedOutputs: string[];
}

export interface PricingStepOccurrenceDetail {
  occurrenceIndex: number; pathLabel: string; name: string | null; parentStep: string | null; sequenceNumber: string | null;
  allBindings: RawParameterBinding[]; rawXml: string;
}

function inspectPricingStepOccurrence(node: PhysicalStepNode): PricingStepOccurrenceDetail {
  return {
    occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, name: node.name, parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber, allBindings: collectAllParameterBindings(node.full), rawXml: node.full,
  };
}

export interface ChainHopInfo { name: string | null; actionType: string | null; sequenceNumber: string | null; parentStep: string | null; }

export interface BundleDiscountBranchInspection {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string | null;
  sequenceNumber: string | null;
  physicalContainerAncestors: string[];
  parentStepChainDetail: ChainHopInfo[];
  listPriceConnection: ConnectionMechanism;
  connectedToListPrice: boolean;
  bindings: BundleDiscountBindingSnapshot;
  allBindings: RawParameterBinding[];
  rawXml: string;
}

function inspectBundleDiscountBranch(graph: PhysicalStepNode[], node: PhysicalStepNode): BundleDiscountBranchInspection {
  const ownBindings = collectAllParameterBindings(ownFieldsOnly(node));
  const chain = walkParentStepChainNames(graph, node).chain;
  const listPriceConnection = resolveConnection(graph, node, "ListPrice");
  return {
    occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, name: node.name, parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber,
    physicalContainerAncestors: physicalAncestorNodes(graph, node).map(n => n.name ?? `(unnamed @${n.occurrenceIndex})`),
    parentStepChainDetail: chain.map(n => ({ name: n.name, actionType: n.actionType, sequenceNumber: n.sequenceNumber, parentStep: n.parentStep })),
    listPriceConnection, connectedToListPrice: listPriceConnection !== "none",
    bindings: {
      inputUnitPrice: findBindingValue(ownBindings, "InputUnitPrice"),
      priceAdjustmentScheduleBinding: ownBindings.find(b => /^PriceAdjustmentSchedule/i.test(b.name ?? ""))?.value ?? null,
      publishedOutputs: ownBindings.filter(b => b.output).map(b => b.value).filter((v): v is string => !!v),
    },
    allBindings: collectAllParameterBindings(node.full),
    rawXml: node.full,
  };
}

export type DonorClassification =
  | "PRICING_PROCEDURE_LIKELY" | "SHARED_PRICING_PROCEDURE_LIKELY" | "BUNDLE_BASED_PRICING_LIKELY"
  | "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY" | "UNCLASSIFIED";

export interface ExpressionSetDonorCandidate {
  fullName: string; fileName: string; label: string;
  physicalStepCount: number;
  bundleDiscountOccurrences: number;
  pricingSettingsOccurrences: number;
  listPriceOccurrences: number;
  orderedActionTypes: string[];
  uniqueActionTypes: string[];
  rootBranches: { name: string | null; actionType: string | null }[];
  classification: DonorClassification;
  classificationReasons: string[];
  bundleDiscountBranches: BundleDiscountBranchInspection[];
  listPriceOccurrenceDetails: PricingStepOccurrenceDetail[];
  pricingSettingsOccurrenceDetails: PricingStepOccurrenceDetail[];
}

function classifyDonor(input: {
  uniqueActionTypes: string[]; hasBundleDiscount: boolean; hasPricingSettings: boolean; hasListPrice: boolean;
  anyBundleDiscountConnectedToListPrice: boolean;
}): { classification: DonorClassification; reasons: string[] } {
  const unrelated = input.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));
  const reasons: string[] = [`${unrelated.length} unrelated pricing-type branch(es): ${unrelated.join(", ") || "(none)"}`];
  if (!input.hasBundleDiscount) {
    if (!input.hasPricingSettings && !input.hasListPrice) return { classification: "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY", reasons };
    return { classification: "UNCLASSIFIED", reasons };
  }
  if (!input.hasPricingSettings || !input.hasListPrice) return { classification: "UNCLASSIFIED", reasons };
  if (unrelated.length >= 3) return { classification: "SHARED_PRICING_PROCEDURE_LIKELY", reasons };
  if (unrelated.length === 0 && input.anyBundleDiscountConnectedToListPrice) return { classification: "BUNDLE_BASED_PRICING_LIKELY", reasons };
  return { classification: "PRICING_PROCEDURE_LIKELY", reasons };
}

export function inspectDonorCandidate(fileName: string, xml: string): ExpressionSetDonorCandidate {
  const fullName = getTagValue(xml, "fullName") ?? "(absent)";
  const label = getTagValue(xml, "label") ?? "(absent)";
  const graph = extractStepGraph(xml);

  const bundleDiscountNodes = graph.filter(n => n.actionType === "BundleDiscount");
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");

  const listPriceOccurrenceDetails = listPriceNodes.map(inspectPricingStepOccurrence);
  const pricingSettingsOccurrenceDetails = pricingSettingsNodes.map(inspectPricingStepOccurrence);
  const rootBranches = graph.filter(n => n.depth === 0).map(n => ({ name: n.name, actionType: n.actionType }));
  const bundleDiscountBranches = bundleDiscountNodes.map(n => inspectBundleDiscountBranch(graph, n));

  const orderedActionTypes = graph.map(n => n.actionType).filter((v): v is string => !!v);
  const uniqueActionTypes = [...new Set(orderedActionTypes)];

  const { classification, reasons: classificationReasons } = classifyDonor({
    uniqueActionTypes, hasBundleDiscount: bundleDiscountNodes.length > 0,
    hasPricingSettings: pricingSettingsNodes.length > 0, hasListPrice: listPriceNodes.length > 0,
    anyBundleDiscountConnectedToListPrice: bundleDiscountBranches.some(b => b.connectedToListPrice),
  });

  return {
    fullName, fileName, label, physicalStepCount: graph.length,
    bundleDiscountOccurrences: bundleDiscountNodes.length, pricingSettingsOccurrences: pricingSettingsNodes.length, listPriceOccurrences: listPriceNodes.length,
    orderedActionTypes, uniqueActionTypes, rootBranches, classification, classificationReasons,
    bundleDiscountBranches, listPriceOccurrenceDetails, pricingSettingsOccurrenceDetails,
  };
}

export interface DonorCandidateRanking { fullName: string; score: number; reason: string }

export function rankCandidates(candidates: ExpressionSetDonorCandidate[]): DonorCandidateRanking[] {
  return candidates
    .filter(c => c.bundleDiscountOccurrences > 0)
    .map(c => {
      let score = 0;
      const reasons: string[] = [];
      if (c.classification === "BUNDLE_BASED_PRICING_LIKELY") { score += 5; reasons.push("classified BUNDLE_BASED_PRICING_LIKELY"); }
      else if (c.classification === "PRICING_PROCEDURE_LIKELY") { score += 3; reasons.push("classified PRICING_PROCEDURE_LIKELY"); }
      else if (c.classification === "SHARED_PRICING_PROCEDURE_LIKELY") { score += 1; reasons.push("classified SHARED_PRICING_PROCEDURE_LIKELY (large, many unrelated branches)"); }
      else { reasons.push(`classified ${c.classification}`); }

      const unrelatedCount = c.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t)).length;
      if (unrelatedCount > 0) { score -= unrelatedCount; reasons.push(`${unrelatedCount} unrelated pricing-type branch(es) present (-${unrelatedCount})`); }

      const connectedBranches = c.bundleDiscountBranches.filter(b => b.connectedToListPrice);
      if (connectedBranches.length > 0) {
        score += 2;
        const bestMechanism = connectedBranches.some(b => b.listPriceConnection === "parentStep-chain")
          ? "parentStep-chain"
          : connectedBranches.some(b => b.listPriceConnection === "physical-nesting")
            ? "physical-nesting"
            : connectedBranches.some(b => b.listPriceConnection === "variable-binding")
              ? "variable-binding"
              : "sequence-order";
        const mechanismBonus = bestMechanism === "parentStep-chain" ? 3 : bestMechanism === "physical-nesting" ? 2 : bestMechanism === "variable-binding" ? 1 : 0;
        score += mechanismBonus;
        reasons.push(`>=1 BundleDiscount occurrence resolves to ListPrice (+2), strongest evidence: ${bestMechanism}${mechanismBonus > 0 ? ` (+${mechanismBonus})` : " (weakest signal — no bonus)"}`);
      } else reasons.push("no BundleDiscount occurrence resolves to ListPrice via any known mechanism");

      if (c.physicalStepCount <= 10) { score += 1; reasons.push(`small physical step count (${c.physicalStepCount}) — unlikely to be a large shared procedure (+1)`); }
      return { fullName: c.fullName, score, reason: reasons.join("; ") };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildNoCoherentDonorDiagnostic(candidates: ExpressionSetDonorCandidate[]): string {
  if (candidates.length === 0) {
    return "No ExpressionSetDefinition in this org contains any BundleDiscount step at all — nothing to clone from.";
  }
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`--- ${c.fullName} (${c.fileName}) ---`);
    lines.push(`Classification: ${c.classification} — ${c.classificationReasons.join("; ")}`);
    lines.push(`PricingSettings x${c.pricingSettingsOccurrences}, ListPrice x${c.listPriceOccurrences}, BundleDiscount x${c.bundleDiscountOccurrences}`);
    for (const b of c.bundleDiscountBranches) {
      lines.push(`  BundleDiscount @${b.pathLabel} (name=${b.name ?? "(none)"}, parentStep=${b.parentStep ?? "(none)"}, sequenceNumber=${b.sequenceNumber ?? "(none)"})`);
      lines.push(`    Physical ancestors: ${b.physicalContainerAncestors.join(" -> ") || "(none, root-level)"}`);
      lines.push(`    parentStep chain: ${b.parentStepChainDetail.map(h => `${h.name ?? "(unnamed)"}[${h.actionType ?? "?"}]`).join(" -> ") || "(none)"}`);
      lines.push(`    Connected to ListPrice: ${b.connectedToListPrice ? `YES via ${b.listPriceConnection}` : "NO"}`);
      lines.push(`    InputUnitPrice binding: ${b.bindings.inputUnitPrice ?? "(none)"}`);
    }
    lines.push("");
  }
  lines.push(
    "A valid Bundle-Based Pricing Expression Set donor requires: PricingSettings, ListPrice, and a BundleDiscount " +
    "branch physically or logically connected to that same donor's ListPrice via a <parentStep> chain, physical " +
    "nesting, a matching InputUnitPrice/published-output variable binding, or declared sequence order. Configure " +
    "a working Bundle-Based Adjustment pricing procedure manually in Salesforce Setup, then retry.",
  );
  return lines.join("\n");
}

export interface AttributeBasedPricingDonorSelectionLike {
  fullName: string; fileName: string; fullXml: string; candidate: ExpressionSetDonorCandidate;
  ranking: DonorCandidateRanking[];
  connectedBundleDiscountOccurrenceIndexes: number[];
}

export interface BundleBasedPricingDonorResolution {
  selection: AttributeBasedPricingDonorSelectionLike | null;
  candidatesWithBundleDiscount: ExpressionSetDonorCandidate[];
  lowConfidenceCandidates?: DonorCandidateRanking[];
}

export async function resolveBundleBasedPricingDonor(client: SalesforceClient): Promise<BundleBasedPricingDonorResolution> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  const inspected = files.map(f => ({ file: f, candidate: inspectDonorCandidate(f.fileName, f.content) }));
  const candidatesWithBundleDiscount = inspected.filter(e => e.candidate.bundleDiscountOccurrences > 0).map(e => e.candidate);

  const eligible = inspected.filter(({ candidate }) =>
    candidate.pricingSettingsOccurrences > 0
    && candidate.listPriceOccurrences > 0
    && candidate.bundleDiscountOccurrences > 0
    && candidate.bundleDiscountBranches.some(b => b.connectedToListPrice),
  );
  if (eligible.length === 0) return { selection: null, candidatesWithBundleDiscount };

  const ranking = rankCandidates(eligible.map(e => e.candidate));
  const top = ranking[0];
  if (top.score < MINIMUM_TRUSTED_DONOR_SCORE) {
    client.logDebug("xml-diagnostic", `Bundle-Based Pricing donor ranking (all below trust floor):\n${ranking.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`);
    return { selection: null, candidatesWithBundleDiscount, lowConfidenceCandidates: ranking };
  }

  const selected = eligible.find(e => e.candidate.fullName === top.fullName)!;
  const connectedBundleDiscountOccurrenceIndexes = selected.candidate.bundleDiscountBranches
    .filter(b => b.connectedToListPrice)
    .map(b => b.occurrenceIndex);

  return {
    selection: {
      fullName: selected.candidate.fullName, fileName: selected.file.fileName, fullXml: selected.file.content,
      candidate: selected.candidate, ranking, connectedBundleDiscountOccurrenceIndexes,
    },
    candidatesWithBundleDiscount,
  };
}

export interface ExpressionSetDonorInspectionResult {
  totalCandidates: number;
  firstFileContainingActionType: string | null;
  candidates: ExpressionSetDonorCandidate[];
  ranking: DonorCandidateRanking[];
  retrievalWarning?: string;
}

/** Diagnostic-only full-org donor inventory (parallel to the attribute module's
 * `inspectAllExpressionSetDefinitionDonors`) — never consulted for the actual selection decision. */
export async function inspectAllExpressionSetDefinitionDonors(client: SalesforceClient, targetActionType: string): Promise<ExpressionSetDonorInspectionResult> {
  const { files, warning } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  const candidates = files.map(f => inspectDonorCandidate(f.fileName, f.content));
  const withTarget = candidates.filter(c => c.orderedActionTypes.includes(targetActionType));
  const ranking = rankCandidates(withTarget);
  const firstFileContainingActionType = withTarget[0]?.fileName ?? null;
  return { totalCandidates: candidates.length, firstFileContainingActionType, candidates: withTarget, ranking, retrievalWarning: warning };
}
