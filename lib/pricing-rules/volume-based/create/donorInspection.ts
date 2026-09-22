/**
 * Volume-Based Pricing Expression Set donor discovery — mirrors
 * lib/pricing-rules/bundle-based/create/donorInspection.ts's exact architecture and safety invariants,
 * targeting `VolumeDiscount` (the real Business Knowledge Model action type for Range/Slab quantity
 * pricing) instead of `BundleDiscount`.
 *
 * §The two-block trap — a real org's default Pricing Procedure template typically contains TWO
 * `VolumeDiscount` steps, not one:
 *   - A CONTRACT-based block: has an `Id` param wired to `ItemContract`, no `PriceAdjustmentScheduleId`
 *     param. Its Decision Table requires a `ContractItemId` that is always null outside a real contracted
 *     quote — using this block means the BKM permanently returns `adjustments:[]`.
 *   - A SCHEDULE-based block: has a `PriceAdjustmentScheduleId` param and `IsContractEnabled=false`. Its
 *     Decision Table is populated straight from `PriceAdjustmentTier` records this pipeline creates. This
 *     is the only block this module will ever select.
 * A candidate `VolumeDiscount` branch is therefore only eligible at all if its OWN bindings include a
 * param literally named `PriceAdjustmentScheduleId` — this is a hard filter, not a soft scoring signal,
 * because selecting the contract-based block would silently deploy a procedure that can never price
 * anything.
 *
 * `VolumeDiscount` cannot be hand-authored from a blank canvas (its legal values/behavior are
 * org-configured) — this module ONLY ever selects an existing, real, already-deployed donor whose own
 * schedule-based VolumeDiscount branch is PROVEN connected to that same donor's ListPrice step.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { extractStepGraph, getTagValue, type PhysicalStepNode } from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { retrieveExpressionSetDefinitionFiles } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";

/** Every OTHER standard pricing-procedure action type this org may also use — VolumeDiscount/VolumeTierDiscount
 * move OUT (self/target type), AttributeDiscount and BundleDiscount move IN. */
export const SHARED_SIGNAL_ACTION_TYPES = new Set([
  "FormulaBasedPricing", "ManualDiscount", "AttributeDiscount", "BundleDiscount", "Proration", "SubscriptionPricing",
]);

const MINIMUM_TRUSTED_DONOR_SCORE = 0;
const VOLUME_DISCOUNT_ACTION_TYPE = "VolumeDiscount";

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
function hasBindingNamed(bindings: RawParameterBinding[], name: string): boolean {
  return bindings.some(b => b.name === name);
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

function resolveListPriceViaVariableBinding(graph: PhysicalStepNode[], vdNode: PhysicalStepNode): { node: PhysicalStepNode | null } {
  const vdBindings = collectAllParameterBindings(ownFieldsOnly(vdNode));
  const inputUnitPrice = findBindingValue(vdBindings, "InputUnitPrice");
  if (!inputUnitPrice) return { node: null };
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const matches = listPriceNodes.filter(lp =>
    collectAllParameterBindings(lp.full).some(b => b.output && b.value === inputUnitPrice),
  );
  return matches.length === 1 ? { node: matches[0] } : { node: null };
}

/** The 4-signal connection resolver — identical priority order/logic to the attribute/bundle modules' own
 * `resolveConnectedAncestor`, generalized so the variable-binding signal fires for
 * `targetActionType === "ListPrice" && node.actionType === "VolumeDiscount"`. */
export function resolveConnectedAncestor(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ResolvedConnectedAncestor {
  const chain = walkParentStepChainNames(graph, node).chain;
  const viaChain = chain.find(n => n.actionType === targetActionType);
  if (viaChain) return { node: viaChain, mechanism: "parentStep-chain" };

  const viaPhysical = physicalAncestorNodes(graph, node).find(n => n.actionType === targetActionType);
  if (viaPhysical) return { node: viaPhysical, mechanism: "physical-nesting" };

  if (targetActionType === "ListPrice" && node.actionType === VOLUME_DISCOUNT_ACTION_TYPE) {
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

export interface VolumeDiscountBranchInspection {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string | null;
  sequenceNumber: string | null;
  physicalContainerAncestors: string[];
  parentStepChainDetail: ChainHopInfo[];
  listPriceConnection: ConnectionMechanism;
  connectedToListPrice: boolean;
  /** True only when this branch's own bindings include a param literally named `PriceAdjustmentScheduleId`
   * — the two-block trap discriminator (§ file header). False means this is (or looks like) the
   * contract-based block, which can never price anything outside a real contracted quote. */
  isScheduleBased: boolean;
  inputUnitPrice: string | null;
  isContractEnabled: string | null;
  allBindings: RawParameterBinding[];
  rawXml: string;
}

function inspectVolumeDiscountBranch(graph: PhysicalStepNode[], node: PhysicalStepNode): VolumeDiscountBranchInspection {
  const ownBindings = collectAllParameterBindings(ownFieldsOnly(node));
  const chain = walkParentStepChainNames(graph, node).chain;
  const listPriceConnection = resolveConnection(graph, node, "ListPrice");
  return {
    occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, name: node.name, parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber,
    physicalContainerAncestors: physicalAncestorNodes(graph, node).map(n => n.name ?? `(unnamed @${n.occurrenceIndex})`),
    parentStepChainDetail: chain.map(n => ({ name: n.name, actionType: n.actionType, sequenceNumber: n.sequenceNumber, parentStep: n.parentStep })),
    listPriceConnection, connectedToListPrice: listPriceConnection !== "none",
    isScheduleBased: hasBindingNamed(ownBindings, "PriceAdjustmentScheduleId"),
    inputUnitPrice: findBindingValue(ownBindings, "InputUnitPrice"),
    isContractEnabled: findBindingValue(ownBindings, "IsContractEnabled"),
    allBindings: collectAllParameterBindings(node.full),
    rawXml: node.full,
  };
}

export type DonorClassification =
  | "PRICING_PROCEDURE_LIKELY" | "SHARED_PRICING_PROCEDURE_LIKELY" | "VOLUME_BASED_PRICING_LIKELY"
  | "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY" | "UNCLASSIFIED";

export interface ExpressionSetDonorCandidate {
  fullName: string; fileName: string; label: string;
  physicalStepCount: number;
  volumeDiscountOccurrences: number;
  pricingSettingsOccurrences: number;
  listPriceOccurrences: number;
  orderedActionTypes: string[];
  uniqueActionTypes: string[];
  rootBranches: { name: string | null; actionType: string | null }[];
  classification: DonorClassification;
  classificationReasons: string[];
  volumeDiscountBranches: VolumeDiscountBranchInspection[];
  listPriceOccurrenceDetails: PricingStepOccurrenceDetail[];
  pricingSettingsOccurrenceDetails: PricingStepOccurrenceDetail[];
}

function classifyDonor(input: {
  uniqueActionTypes: string[]; hasVolumeDiscount: boolean; hasPricingSettings: boolean; hasListPrice: boolean;
  anyScheduleBasedConnectedToListPrice: boolean;
}): { classification: DonorClassification; reasons: string[] } {
  const unrelated = input.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));
  const reasons: string[] = [`${unrelated.length} unrelated pricing-type branch(es): ${unrelated.join(", ") || "(none)"}`];
  if (!input.hasVolumeDiscount) {
    if (!input.hasPricingSettings && !input.hasListPrice) return { classification: "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY", reasons };
    return { classification: "UNCLASSIFIED", reasons };
  }
  if (!input.hasPricingSettings || !input.hasListPrice) return { classification: "UNCLASSIFIED", reasons };
  if (unrelated.length >= 3) return { classification: "SHARED_PRICING_PROCEDURE_LIKELY", reasons };
  if (unrelated.length === 0 && input.anyScheduleBasedConnectedToListPrice) return { classification: "VOLUME_BASED_PRICING_LIKELY", reasons };
  return { classification: "PRICING_PROCEDURE_LIKELY", reasons };
}

export function inspectDonorCandidate(fileName: string, xml: string): ExpressionSetDonorCandidate {
  const fullName = getTagValue(xml, "fullName") ?? "(absent)";
  const label = getTagValue(xml, "label") ?? "(absent)";
  const graph = extractStepGraph(xml);

  const volumeDiscountNodes = graph.filter(n => n.actionType === VOLUME_DISCOUNT_ACTION_TYPE);
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");

  const listPriceOccurrenceDetails = listPriceNodes.map(inspectPricingStepOccurrence);
  const pricingSettingsOccurrenceDetails = pricingSettingsNodes.map(inspectPricingStepOccurrence);
  const rootBranches = graph.filter(n => n.depth === 0).map(n => ({ name: n.name, actionType: n.actionType }));
  const volumeDiscountBranches = volumeDiscountNodes.map(n => inspectVolumeDiscountBranch(graph, n));

  const orderedActionTypes = graph.map(n => n.actionType).filter((v): v is string => !!v);
  const uniqueActionTypes = [...new Set(orderedActionTypes)];

  const { classification, reasons: classificationReasons } = classifyDonor({
    uniqueActionTypes, hasVolumeDiscount: volumeDiscountNodes.length > 0,
    hasPricingSettings: pricingSettingsNodes.length > 0, hasListPrice: listPriceNodes.length > 0,
    anyScheduleBasedConnectedToListPrice: volumeDiscountBranches.some(b => b.connectedToListPrice && b.isScheduleBased),
  });

  return {
    fullName, fileName, label, physicalStepCount: graph.length,
    volumeDiscountOccurrences: volumeDiscountNodes.length, pricingSettingsOccurrences: pricingSettingsNodes.length, listPriceOccurrences: listPriceNodes.length,
    orderedActionTypes, uniqueActionTypes, rootBranches, classification, classificationReasons,
    volumeDiscountBranches, listPriceOccurrenceDetails, pricingSettingsOccurrenceDetails,
  };
}

export interface DonorCandidateRanking { fullName: string; score: number; reason: string }

export function rankCandidates(candidates: ExpressionSetDonorCandidate[]): DonorCandidateRanking[] {
  return candidates
    .filter(c => c.volumeDiscountBranches.some(b => b.isScheduleBased))
    .map(c => {
      let score = 0;
      const reasons: string[] = [];
      if (c.classification === "VOLUME_BASED_PRICING_LIKELY") { score += 5; reasons.push("classified VOLUME_BASED_PRICING_LIKELY"); }
      else if (c.classification === "PRICING_PROCEDURE_LIKELY") { score += 3; reasons.push("classified PRICING_PROCEDURE_LIKELY"); }
      else if (c.classification === "SHARED_PRICING_PROCEDURE_LIKELY") { score += 1; reasons.push("classified SHARED_PRICING_PROCEDURE_LIKELY (large, many unrelated branches)"); }
      else { reasons.push(`classified ${c.classification}`); }

      const unrelatedCount = c.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t)).length;
      if (unrelatedCount > 0) { score -= unrelatedCount; reasons.push(`${unrelatedCount} unrelated pricing-type branch(es) present (-${unrelatedCount})`); }

      const scheduleBasedConnected = c.volumeDiscountBranches.filter(b => b.connectedToListPrice && b.isScheduleBased);
      if (scheduleBasedConnected.length > 0) {
        score += 2;
        const bestMechanism = scheduleBasedConnected.some(b => b.listPriceConnection === "parentStep-chain")
          ? "parentStep-chain"
          : scheduleBasedConnected.some(b => b.listPriceConnection === "physical-nesting")
            ? "physical-nesting"
            : scheduleBasedConnected.some(b => b.listPriceConnection === "variable-binding")
              ? "variable-binding"
              : "sequence-order";
        const mechanismBonus = bestMechanism === "parentStep-chain" ? 3 : bestMechanism === "physical-nesting" ? 2 : bestMechanism === "variable-binding" ? 1 : 0;
        score += mechanismBonus;
        reasons.push(`>=1 schedule-based VolumeDiscount occurrence resolves to ListPrice (+2), strongest evidence: ${bestMechanism}${mechanismBonus > 0 ? ` (+${mechanismBonus})` : " (weakest signal — no bonus)"}`);
      } else reasons.push("no schedule-based VolumeDiscount occurrence resolves to ListPrice via any known mechanism");

      const contractEnabledFalseCount = c.volumeDiscountBranches.filter(b => b.isScheduleBased && b.isContractEnabled === "false").length;
      if (contractEnabledFalseCount > 0) { score += 1; reasons.push(`${contractEnabledFalseCount} schedule-based branch(es) explicitly declare IsContractEnabled=false (+1)`); }

      if (c.physicalStepCount <= 10) { score += 1; reasons.push(`small physical step count (${c.physicalStepCount}) — unlikely to be a large shared procedure (+1)`); }
      return { fullName: c.fullName, score, reason: reasons.join("; ") };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildNoCoherentDonorDiagnostic(candidates: ExpressionSetDonorCandidate[]): string {
  if (candidates.length === 0) {
    return "No ExpressionSetDefinition in this org contains any VolumeDiscount step at all — nothing to clone from.";
  }
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`--- ${c.fullName} (${c.fileName}) ---`);
    lines.push(`Classification: ${c.classification} — ${c.classificationReasons.join("; ")}`);
    lines.push(`PricingSettings x${c.pricingSettingsOccurrences}, ListPrice x${c.listPriceOccurrences}, VolumeDiscount x${c.volumeDiscountOccurrences}`);
    for (const b of c.volumeDiscountBranches) {
      lines.push(`  VolumeDiscount @${b.pathLabel} (name=${b.name ?? "(none)"}, parentStep=${b.parentStep ?? "(none)"}, sequenceNumber=${b.sequenceNumber ?? "(none)"})`);
      lines.push(`    Physical ancestors: ${b.physicalContainerAncestors.join(" -> ") || "(none, root-level)"}`);
      lines.push(`    Schedule-based (has PriceAdjustmentScheduleId param): ${b.isScheduleBased ? "YES" : "NO — this is the contract-based block; it can never price anything outside a real contracted quote"}`);
      lines.push(`    IsContractEnabled: ${b.isContractEnabled ?? "(none)"}`);
      lines.push(`    Connected to ListPrice: ${b.connectedToListPrice ? `YES via ${b.listPriceConnection}` : "NO"}`);
      lines.push(`    InputUnitPrice binding: ${b.inputUnitPrice ?? "(none)"}`);
    }
    lines.push("");
  }
  lines.push(
    "A valid Volume-Based Pricing Expression Set donor requires: PricingSettings, ListPrice, and a SCHEDULE-BASED " +
    "VolumeDiscount branch (one whose own bindings include a `PriceAdjustmentScheduleId` parameter — NOT the " +
    "contract-based block, which requires a ContractItemId that is always null outside a real contracted quote) " +
    "physically or logically connected to that same donor's ListPrice via a <parentStep> chain, physical " +
    "nesting, a matching InputUnitPrice/published-output variable binding, or declared sequence order. Configure " +
    "a working Volume-Based (Range) Adjustment pricing procedure manually in Salesforce Setup, then retry.",
  );
  return lines.join("\n");
}

export interface VolumeBasedPricingDonorSelection {
  fullName: string; fileName: string; fullXml: string; candidate: ExpressionSetDonorCandidate;
  ranking: DonorCandidateRanking[];
  connectedScheduleBasedOccurrenceIndexes: number[];
}

export interface VolumeBasedPricingDonorResolution {
  selection: VolumeBasedPricingDonorSelection | null;
  candidatesWithVolumeDiscount: ExpressionSetDonorCandidate[];
  lowConfidenceCandidates?: DonorCandidateRanking[];
}

export async function resolveVolumeBasedPricingDonor(client: SalesforceClient): Promise<VolumeBasedPricingDonorResolution> {
  const { files } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  const inspected = files.map(f => ({ file: f, candidate: inspectDonorCandidate(f.fileName, f.content) }));
  const candidatesWithVolumeDiscount = inspected.filter(e => e.candidate.volumeDiscountOccurrences > 0).map(e => e.candidate);

  const eligible = inspected.filter(({ candidate }) =>
    candidate.pricingSettingsOccurrences > 0
    && candidate.listPriceOccurrences > 0
    && candidate.volumeDiscountOccurrences > 0
    && candidate.volumeDiscountBranches.some(b => b.isScheduleBased && b.connectedToListPrice),
  );
  if (eligible.length === 0) return { selection: null, candidatesWithVolumeDiscount };

  const ranking = rankCandidates(eligible.map(e => e.candidate));
  const top = ranking[0];
  if (top.score < MINIMUM_TRUSTED_DONOR_SCORE) {
    client.logDebug("xml-diagnostic", `Volume-Based Pricing donor ranking (all below trust floor):\n${ranking.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`);
    return { selection: null, candidatesWithVolumeDiscount, lowConfidenceCandidates: ranking };
  }

  const selected = eligible.find(e => e.candidate.fullName === top.fullName)!;
  const connectedScheduleBasedOccurrenceIndexes = selected.candidate.volumeDiscountBranches
    .filter(b => b.isScheduleBased && b.connectedToListPrice)
    .map(b => b.occurrenceIndex);

  return {
    selection: {
      fullName: selected.candidate.fullName, fileName: selected.file.fileName, fullXml: selected.file.content,
      candidate: selected.candidate, ranking, connectedScheduleBasedOccurrenceIndexes,
    },
    candidatesWithVolumeDiscount,
  };
}

export interface ExpressionSetDonorInspectionResult {
  totalCandidates: number;
  firstFileContainingActionType: string | null;
  candidates: ExpressionSetDonorCandidate[];
  ranking: DonorCandidateRanking[];
  retrievalWarning?: string;
}

/** Diagnostic-only full-org donor inventory — never consulted for the actual selection decision. */
export async function inspectAllExpressionSetDefinitionDonors(client: SalesforceClient, targetActionType: string): Promise<ExpressionSetDonorInspectionResult> {
  const { files, warning } = await retrieveExpressionSetDefinitionFiles(client, ["*"]);
  const candidates = files.map(f => inspectDonorCandidate(f.fileName, f.content));
  const withTarget = candidates.filter(c => c.orderedActionTypes.includes(targetActionType));
  const ranking = rankCandidates(withTarget);
  const firstFileContainingActionType = withTarget[0]?.fileName ?? null;
  return { totalCandidates: candidates.length, firstFileContainingActionType, candidates: withTarget, ranking, retrievalWarning: warning };
}
