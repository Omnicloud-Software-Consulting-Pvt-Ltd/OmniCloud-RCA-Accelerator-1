/**
 * Tier-Based (Slab) Pricing Expression Set donor discovery — mirrors
 * lib/pricing-rules/volume-based/create/donorInspection.ts's exact architecture and safety invariants,
 * targeting `VolumeTierDiscount` (the real Business Knowledge Model action type for Slab quantity
 * pricing — a distinct action type from its `VolumeDiscount`/Range sibling, confirmed by this codebase's
 * own lib/pricing-rules/volume-based/rca/analyzeSimulation.ts already treating "VolumeDiscount" and
 * "VolumeTierDiscount" as the two possible `elementType` values a waterfall step can report) instead of
 * `VolumeDiscount`.
 *
 * §The two-block trap — carried over defensively from the volume-based module even though it has not been
 * confirmed against a real org for VolumeTierDiscount specifically: a candidate `VolumeTierDiscount`
 * branch is only eligible at all if its OWN bindings include a param literally named
 * `PriceAdjustmentScheduleId` (as opposed to a contract-based block wired to `ItemContract`, whose
 * Decision Table would require a `ContractItemId` that is always null outside a real contracted quote).
 *
 * `VolumeTierDiscount` cannot be hand-authored from a blank canvas (its legal values/behavior are
 * org-configured) — this module ONLY ever selects an existing, real, already-deployed donor whose own
 * schedule-based VolumeTierDiscount branch is PROVEN connected to that same donor's ListPrice step, OR (see
 * `resolveConnectedAncestor`'s `price-waterfall-variable` mechanism, mirrored from
 * lib/pricing-rules/attribute-based/create/donorInspection.ts's own proven fix for this exact real-org
 * shape) to that same donor's PricingSettings step via the shared running `NetUnitPrice` price-waterfall
 * context, for donors whose ListPrice branch(es) never publish that name directly. ListPrice's own presence
 * in the donor is required either way. There is deliberately no scratch-built fallback here, matching
 * lib/pricing-rules/volume-based's own choice not to author this BKM action type from scratch.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { extractStepGraph, getTagValue, type PhysicalStepNode } from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { retrieveVersionScopedExpressionSetDefinitionFiles } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";

/** Every OTHER standard pricing-procedure action type this org may also use — VolumeTierDiscount moves
 * OUT (self/target type). VolumeDiscount (its Range sibling) moves IN, since a shared donor whose
 * VolumeTierDiscount branch coexists with an unrelated VolumeDiscount branch is still a valid signal that
 * this Expression Set is a large shared procedure, not a clean single-purpose one. */
export const SHARED_SIGNAL_ACTION_TYPES = new Set([
  "FormulaBasedPricing", "ManualDiscount", "AttributeDiscount", "BundleDiscount", "Proration", "SubscriptionPricing", "VolumeDiscount",
]);

const MINIMUM_TRUSTED_DONOR_SCORE = 0;
const TIER_DISCOUNT_ACTION_TYPE = "VolumeTierDiscount";

export type ConnectionMechanism = "parentStep-chain" | "physical-nesting" | "variable-binding" | "price-waterfall-variable" | "sequence-order" | "none";

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

/**
 * §Generalized variable-binding resolver — mirrors
 * lib/pricing-rules/attribute-based/create/donorInspection.ts's own `resolveViaVariableBinding` exactly
 * (same recursive whole-subtree search via `p.full`, same "exactly 1 match or fail closed" discipline).
 * `publisherActionType` is the step type expected to PUBLISH the value VolumeTierDiscount's own
 * `InputUnitPrice` binds to — `"ListPrice"` for the original direct-binding signal, or `"PricingSettings"`
 * for the price-waterfall-variable signal added below (see that mechanism's own doc comment for the real
 * org evidence that made the PricingSettings case necessary). Two or more candidate publishers claiming the
 * SAME value is treated as genuine ambiguity and never resolved by guessing — this function returns
 * `{ node: null }` for both "zero matches" and "multiple tied matches"; see
 * `explainPricingSettingsWaterfallMatch` for the diagnostic-only breakdown of which case actually occurred.
 */
function resolveViaVariableBinding(
  graph: PhysicalStepNode[], vtdNode: PhysicalStepNode, publisherActionType: string,
): { node: PhysicalStepNode | null } {
  const vtdBindings = collectAllParameterBindings(ownFieldsOnly(vtdNode));
  const inputUnitPrice = findBindingValue(vtdBindings, "InputUnitPrice");
  if (!inputUnitPrice) return { node: null };
  const publisherNodes = graph.filter(n => n.actionType === publisherActionType);
  const matches = publisherNodes.filter(p =>
    collectAllParameterBindings(p.full).some(b => b.output && b.value === inputUnitPrice),
  );
  return matches.length === 1 ? { node: matches[0] } : { node: null };
}

/** §TEMPORARY — read-only diagnostic only, added to distinguish (A) zero ListPrice candidates output the
 * VolumeTierDiscount's InputUnitPrice value, from (B) more than one tied, from (C) the two are still being
 * resolved from different version contexts, when `connectedToListPrice` comes back false. Never consulted
 * by `resolveListPriceViaVariableBinding`/`resolveConnectedAncestor` themselves — those 4 mechanisms are
 * unchanged. Safe to delete once the real cause is confirmed and either fixed or ruled out; does not affect
 * eligibility, scoring, or which donor (if any) is selected. */
export interface PricingStepCandidateDiagnostic {
  pathLabel: string;
  occurrenceIndex: number;
  sequenceNumber: string | null;
  parentStep: string | null;
  actionType: string | null;
  outputBindings: { name: string | null; value: string | null }[];
}

function describeCandidatesForDiagnostics(graph: PhysicalStepNode[], actionType: string): PricingStepCandidateDiagnostic[] {
  return graph
    .filter(n => n.actionType === actionType)
    .map(n => ({
      pathLabel: n.pathLabel,
      occurrenceIndex: n.occurrenceIndex,
      sequenceNumber: n.sequenceNumber,
      parentStep: n.parentStep,
      actionType: n.actionType,
      outputBindings: collectAllParameterBindings(n.full)
        .filter(b => b.output)
        .map(b => ({ name: b.name, value: b.value })),
    }));
}

function describeListPriceCandidatesForDiagnostics(graph: PhysicalStepNode[]): PricingStepCandidateDiagnostic[] {
  return describeCandidatesForDiagnostics(graph, "ListPrice");
}

function describePricingSettingsCandidatesForDiagnostics(graph: PhysicalStepNode[]): PricingStepCandidateDiagnostic[] {
  return describeCandidatesForDiagnostics(graph, "PricingSettings");
}

/** §TEMPORARY — read-only diagnostic only, explaining (never deciding) exactly why
 * `resolveViaVariableBinding(graph, node, "PricingSettings")` did or didn't find a connection: uses the
 * IDENTICAL matching logic (same `.full` recursive search, same `output && value === inputUnitPrice` test,
 * same "exactly 1" requirement) so this text can never disagree with what the real resolver decided — it
 * only adds the WHY (zero producers vs which specific producers tied) that the boolean result alone can't
 * convey. Safe to delete once the real cause is confirmed. */
export interface PricingSettingsWaterfallMatchDiagnostic {
  matched: boolean;
  reason: string;
}

function explainPricingSettingsWaterfallMatch(graph: PhysicalStepNode[], vtdNode: PhysicalStepNode): PricingSettingsWaterfallMatchDiagnostic {
  const vtdBindings = collectAllParameterBindings(ownFieldsOnly(vtdNode));
  const inputUnitPrice = findBindingValue(vtdBindings, "InputUnitPrice");
  if (!inputUnitPrice) {
    return { matched: false, reason: "VolumeTierDiscount has no InputUnitPrice binding at all — nothing to match against any producer." };
  }
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");
  if (pricingSettingsNodes.length === 0) {
    return { matched: false, reason: "No PricingSettings node exists in this graph." };
  }
  const matches = pricingSettingsNodes.filter(p =>
    collectAllParameterBindings(p.full).some(b => b.output && b.value === inputUnitPrice),
  );
  if (matches.length === 0) {
    return {
      matched: false,
      reason: `Zero of the ${pricingSettingsNodes.length} PricingSettings occurrence(s) publish an output valued "${inputUnitPrice}" — the value VolumeTierDiscount's InputUnitPrice binds to.`,
    };
  }
  if (matches.length > 1) {
    return {
      matched: false,
      reason: `${matches.length} PricingSettings occurrences (${matches.map(m => `@${m.pathLabel}`).join(", ")}) all publish "${inputUnitPrice}" as an output — genuine ambiguity, never resolved by guessing.`,
    };
  }
  return {
    matched: true,
    reason: `Exactly one PricingSettings occurrence (@${matches[0].pathLabel}) publishes "${inputUnitPrice}" as its own output — unambiguous match.`,
  };
}

/** The 5-signal connection resolver — identical priority order/logic to the volume-based module's own
 * `resolveConnectedAncestor` for the first 3 signals (generalized so the variable-binding signal fires for
 * `targetActionType === "ListPrice" && node.actionType === "VolumeTierDiscount"`), plus a 4th signal mirrored
 * from lib/pricing-rules/attribute-based/create/donorInspection.ts's proven `price-waterfall-variable`
 * mechanism:
 *
 * §price-waterfall-variable — ONLY checked when `targetActionType === "PricingSettings"` and `node` is a
 * VolumeTierDiscount occurrence: its `InputUnitPrice` value unambiguously matches PricingSettings' own
 * published output value. Added because a real org (`Rev_Mgmt_Default_Pricing_Procedure2_V1` — the exact
 * donor already proven, in the sibling Attribute-Based module, to have this shape) has NEITHER of its two
 * ListPrice branches publish `NetUnitPrice` (they publish `ItemContractPrice`/`ListPrice` respectively),
 * while PricingSettings genuinely publishes `NetUnitPrice` and the schedule-based VolumeTierDiscount
 * occurrence consumes exactly that name — Revenue Cloud's documented "pricing waterfall" convention, a
 * shared running price context PricingSettings owns/coordinates. This is a PricingSettings-ONLY signal
 * (never generalized to arbitrary step pairing) and requires an UNAMBIGUOUS match — exactly one
 * PricingSettings occurrence publishing the consumed value; two or more is genuine ambiguity, never resolved
 * by guessing (see `resolveViaVariableBinding`). Never claims a fabricated DIRECT ListPrice dependency —
 * ListPrice's own presence in the donor is still required separately by the eligibility filter in
 * `resolveTierBasedPricingDonor`. */
export function resolveConnectedAncestor(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ResolvedConnectedAncestor {
  const chain = walkParentStepChainNames(graph, node).chain;
  const viaChain = chain.find(n => n.actionType === targetActionType);
  if (viaChain) return { node: viaChain, mechanism: "parentStep-chain" };

  const viaPhysical = physicalAncestorNodes(graph, node).find(n => n.actionType === targetActionType);
  if (viaPhysical) return { node: viaPhysical, mechanism: "physical-nesting" };

  if (targetActionType === "ListPrice" && node.actionType === TIER_DISCOUNT_ACTION_TYPE) {
    const viaBinding = resolveViaVariableBinding(graph, node, "ListPrice");
    if (viaBinding.node) return { node: viaBinding.node, mechanism: "variable-binding" };
  }

  if (targetActionType === "PricingSettings" && node.actionType === TIER_DISCOUNT_ACTION_TYPE) {
    const viaWaterfall = resolveViaVariableBinding(graph, node, "PricingSettings");
    if (viaWaterfall.node) return { node: viaWaterfall.node, mechanism: "price-waterfall-variable" };
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

export interface TierDiscountBranchInspection {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string | null;
  sequenceNumber: string | null;
  physicalContainerAncestors: string[];
  parentStepChainDetail: ChainHopInfo[];
  listPriceConnection: ConnectionMechanism;
  connectedToListPrice: boolean;
  /** §price-waterfall-variable — see `resolveConnectedAncestor`'s doc comment. Computed independently of
   * `listPriceConnection`/`connectedToListPrice`; a branch can be connected via EITHER or both. */
  pricingSettingsConnection: ConnectionMechanism;
  connectedToPricingSettings: boolean;
  /** True only when this branch's own bindings include a param literally named `PriceAdjustmentScheduleId`
   * — the two-block trap discriminator (§ file header). False means this is (or looks like) the
   * contract-based block, which can never price anything outside a real contracted quote. */
  isScheduleBased: boolean;
  inputUnitPrice: string | null;
  isContractEnabled: string | null;
  allBindings: RawParameterBinding[];
  rawXml: string;
  /** §TEMPORARY diagnostic-only fields — populated only when this branch failed to connect via EITHER
   * ListPrice or PricingSettings, so a failed pre-flight's own diagnostic text shows exactly what every
   * candidate publisher in the graph publishes, without needing a second Salesforce round-trip. */
  listPriceCandidateDiagnostics?: PricingStepCandidateDiagnostic[];
  pricingSettingsCandidateDiagnostics?: PricingStepCandidateDiagnostic[];
  pricingSettingsWaterfallMatch?: PricingSettingsWaterfallMatchDiagnostic;
}

function inspectTierDiscountBranch(graph: PhysicalStepNode[], node: PhysicalStepNode): TierDiscountBranchInspection {
  const ownBindings = collectAllParameterBindings(ownFieldsOnly(node));
  const chain = walkParentStepChainNames(graph, node).chain;
  const listPriceConnection = resolveConnection(graph, node, "ListPrice");
  const pricingSettingsConnection = resolveConnection(graph, node, "PricingSettings");
  const connectedToListPrice = listPriceConnection !== "none";
  const connectedToPricingSettings = pricingSettingsConnection !== "none";
  const overallConnected = connectedToListPrice || connectedToPricingSettings;
  return {
    occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, name: node.name, parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber,
    physicalContainerAncestors: physicalAncestorNodes(graph, node).map(n => n.name ?? `(unnamed @${n.occurrenceIndex})`),
    parentStepChainDetail: chain.map(n => ({ name: n.name, actionType: n.actionType, sequenceNumber: n.sequenceNumber, parentStep: n.parentStep })),
    listPriceConnection, connectedToListPrice,
    pricingSettingsConnection, connectedToPricingSettings,
    isScheduleBased: hasBindingNamed(ownBindings, "PriceAdjustmentScheduleId"),
    inputUnitPrice: findBindingValue(ownBindings, "InputUnitPrice"),
    isContractEnabled: findBindingValue(ownBindings, "IsContractEnabled"),
    allBindings: collectAllParameterBindings(node.full),
    rawXml: node.full,
    listPriceCandidateDiagnostics: overallConnected ? undefined : describeListPriceCandidatesForDiagnostics(graph),
    pricingSettingsCandidateDiagnostics: overallConnected ? undefined : describePricingSettingsCandidatesForDiagnostics(graph),
    pricingSettingsWaterfallMatch: overallConnected ? undefined : explainPricingSettingsWaterfallMatch(graph, node),
  };
}

export type DonorClassification =
  | "PRICING_PROCEDURE_LIKELY" | "SHARED_PRICING_PROCEDURE_LIKELY" | "TIER_BASED_PRICING_LIKELY"
  | "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY" | "UNCLASSIFIED";

export interface ExpressionSetDonorCandidate {
  fullName: string; fileName: string; label: string;
  physicalStepCount: number;
  tierDiscountOccurrences: number;
  pricingSettingsOccurrences: number;
  listPriceOccurrences: number;
  orderedActionTypes: string[];
  uniqueActionTypes: string[];
  rootBranches: { name: string | null; actionType: string | null }[];
  classification: DonorClassification;
  classificationReasons: string[];
  tierDiscountBranches: TierDiscountBranchInspection[];
  listPriceOccurrenceDetails: PricingStepOccurrenceDetail[];
  pricingSettingsOccurrenceDetails: PricingStepOccurrenceDetail[];
}

function classifyDonor(input: {
  uniqueActionTypes: string[]; hasTierDiscount: boolean; hasPricingSettings: boolean; hasListPrice: boolean;
  anyScheduleBasedConnectedToListPrice: boolean;
  /** §price-waterfall-variable — a real donor can have a schedule-based VolumeTierDiscount connected to
   * PricingSettings via the shared price-waterfall variable while genuinely NOT connected to either ListPrice
   * branch by name/output — still real, evidenced participation in the SAME pricing flow, since
   * PricingSettings owns the running NetUnitPrice context both ListPrice and VolumeTierDiscount read/write.
   * Never used alone: `hasListPrice` is still required separately, so this never claims coherence for a
   * donor that lacks a ListPrice branch entirely. Mirrors attribute-based's own classifyDonor exactly. */
  anyScheduleBasedConnectedToPricingSettings: boolean;
}): { classification: DonorClassification; reasons: string[] } {
  const unrelated = input.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));
  const reasons: string[] = [`${unrelated.length} unrelated pricing-type branch(es): ${unrelated.join(", ") || "(none)"}`];
  if (!input.hasTierDiscount) {
    if (!input.hasPricingSettings && !input.hasListPrice) return { classification: "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY", reasons };
    return { classification: "UNCLASSIFIED", reasons };
  }
  if (!input.hasPricingSettings || !input.hasListPrice) return { classification: "UNCLASSIFIED", reasons };
  if (unrelated.length >= 3) return { classification: "SHARED_PRICING_PROCEDURE_LIKELY", reasons };
  if (unrelated.length === 0 && input.anyScheduleBasedConnectedToListPrice) return { classification: "TIER_BASED_PRICING_LIKELY", reasons };
  if (unrelated.length === 0 && input.anyScheduleBasedConnectedToPricingSettings) {
    reasons.push("No unrelated pricing-type branches, and at least one schedule-based VolumeTierDiscount occurrence resolves back to PricingSettings via the shared price-waterfall variable, even though it does not resolve back to ListPrice directly.");
    return { classification: "TIER_BASED_PRICING_LIKELY", reasons };
  }
  return { classification: "PRICING_PROCEDURE_LIKELY", reasons };
}

export function inspectDonorCandidate(fileName: string, xml: string): ExpressionSetDonorCandidate {
  const fullName = getTagValue(xml, "fullName") ?? "(absent)";
  const label = getTagValue(xml, "label") ?? "(absent)";
  const graph = extractStepGraph(xml);

  const tierDiscountNodes = graph.filter(n => n.actionType === TIER_DISCOUNT_ACTION_TYPE);
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");

  const listPriceOccurrenceDetails = listPriceNodes.map(inspectPricingStepOccurrence);
  const pricingSettingsOccurrenceDetails = pricingSettingsNodes.map(inspectPricingStepOccurrence);
  const rootBranches = graph.filter(n => n.depth === 0).map(n => ({ name: n.name, actionType: n.actionType }));
  const tierDiscountBranches = tierDiscountNodes.map(n => inspectTierDiscountBranch(graph, n));

  const orderedActionTypes = graph.map(n => n.actionType).filter((v): v is string => !!v);
  const uniqueActionTypes = [...new Set(orderedActionTypes)];

  const { classification, reasons: classificationReasons } = classifyDonor({
    uniqueActionTypes, hasTierDiscount: tierDiscountNodes.length > 0,
    hasPricingSettings: pricingSettingsNodes.length > 0, hasListPrice: listPriceNodes.length > 0,
    anyScheduleBasedConnectedToListPrice: tierDiscountBranches.some(b => b.connectedToListPrice && b.isScheduleBased),
    anyScheduleBasedConnectedToPricingSettings: tierDiscountBranches.some(b => b.connectedToPricingSettings && b.isScheduleBased),
  });

  return {
    fullName, fileName, label, physicalStepCount: graph.length,
    tierDiscountOccurrences: tierDiscountNodes.length, pricingSettingsOccurrences: pricingSettingsNodes.length, listPriceOccurrences: listPriceNodes.length,
    orderedActionTypes, uniqueActionTypes, rootBranches, classification, classificationReasons,
    tierDiscountBranches, listPriceOccurrenceDetails, pricingSettingsOccurrenceDetails,
  };
}

export interface DonorCandidateRanking { fullName: string; score: number; reason: string }

export function rankCandidates(candidates: ExpressionSetDonorCandidate[]): DonorCandidateRanking[] {
  return candidates
    .filter(c => c.tierDiscountBranches.some(b => b.isScheduleBased))
    .map(c => {
      let score = 0;
      const reasons: string[] = [];
      let classificationBonus = 0;
      if (c.classification === "TIER_BASED_PRICING_LIKELY") { classificationBonus = 5; reasons.push("classified TIER_BASED_PRICING_LIKELY"); }
      else if (c.classification === "PRICING_PROCEDURE_LIKELY") { classificationBonus = 3; reasons.push("classified PRICING_PROCEDURE_LIKELY"); }
      else if (c.classification === "SHARED_PRICING_PROCEDURE_LIKELY") { classificationBonus = 1; reasons.push("classified SHARED_PRICING_PROCEDURE_LIKELY (large, many unrelated branches)"); }
      else { reasons.push(`classified ${c.classification}`); }
      score += classificationBonus;

      // §price-waterfall-variable — mirrors attribute-based's own rankCandidates split between
      // listPriceBranches/waterfallBranches exactly: `listPriceBranches` carries the 3 strongest, direct
      // ListPrice-scoped mechanisms; `waterfallBranches` is only ever "price-waterfall-variable" (the
      // PricingSettings-only signal — see `resolveConnectedAncestor`'s doc comment), consulted ONLY when no
      // direct ListPrice mechanism resolved. Computed BEFORE the unrelated-branch penalty below so that
      // penalty can be calibrated against how strong the evidence actually is.
      const scheduleBasedBranches = c.tierDiscountBranches.filter(b => b.isScheduleBased);
      const listPriceBranches = scheduleBasedBranches.filter(b => b.connectedToListPrice);
      const waterfallBranches = scheduleBasedBranches.filter(b => b.connectedToPricingSettings && b.pricingSettingsConnection === "price-waterfall-variable");
      const bestMechanism: ConnectionMechanism = listPriceBranches.some(b => b.listPriceConnection === "parentStep-chain")
        ? "parentStep-chain"
        : listPriceBranches.some(b => b.listPriceConnection === "physical-nesting")
          ? "physical-nesting"
          : listPriceBranches.some(b => b.listPriceConnection === "variable-binding")
            ? "variable-binding"
            : waterfallBranches.length > 0
              ? "price-waterfall-variable"
              : listPriceBranches.length > 0
                ? "sequence-order"
                : "none";

      let scheduleBasedFlowBonus = 0;
      let mechanismBonus = 0;
      if (listPriceBranches.length > 0 || waterfallBranches.length > 0) {
        scheduleBasedFlowBonus = 2;
        mechanismBonus = bestMechanism === "parentStep-chain" ? 3
          : bestMechanism === "physical-nesting" ? 2
          : (bestMechanism === "variable-binding" || bestMechanism === "price-waterfall-variable") ? 1
          : 0;
        score += scheduleBasedFlowBonus + mechanismBonus;
        reasons.push(`>=1 schedule-based VolumeTierDiscount occurrence resolves to its pricing flow (+${scheduleBasedFlowBonus}), strongest evidence: ${bestMechanism}${mechanismBonus > 0 ? ` (+${mechanismBonus})` : " (weakest signal — no bonus)"}`);
      } else reasons.push("no schedule-based VolumeTierDiscount occurrence resolves to ListPrice or PricingSettings via any known mechanism");

      // §Live-org fix (mirrors lib/pricing-rules/attribute-based/create/donorInspection.ts's own proven fix
      // for the SAME real donor, Rev_Mgmt_Default_Pricing_Procedure2_V1) — an uncapped, per-unrelated-branch-
      // type penalty makes it mathematically impossible for ANY donor with many unrelated branches to ever
      // clear MINIMUM_TRUSTED_DONOR_SCORE, regardless of how strong its OWN VolumeTierDiscount connectivity
      // evidence is — contradicting the floor's actual purpose (distrust WEAK evidence bundled with many
      // unrelated branches, not distrust STRONG evidence merely for being bundled with them). Capped at 3
      // (the same "unrelated.length >= 3" threshold `classifyDonor` already uses to accept "this IS a
      // legitimately large shared procedure" as a real, expected shape) — but ONLY when the best connectivity
      // mechanism found above is stronger than the weakest tier (sequence-order) or absent (none): a donor
      // whose ONLY evidence is sequence-order — or none at all — keeps the FULL, uncapped penalty, since weak
      // or absent evidence bundled with many unrelated branches is exactly the low-confidence shape (Case B:
      // "merely contains the right step names, no proven relationship") this floor must keep rejecting. A
      // donor with a real, unambiguous variable-binding or price-waterfall-variable proof (Case A) is exactly
      // what this cap exists to stop punishing merely for being bundled inside a large shared procedure.
      const unrelatedCount = c.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t)).length;
      const strongScheduleBasedTierFlow = bestMechanism !== "sequence-order" && bestMechanism !== "none";
      const penaltyCap = strongScheduleBasedTierFlow ? 3 : Infinity;
      const appliedPenalty = Math.min(unrelatedCount, penaltyCap);
      if (unrelatedCount > 0) {
        score -= appliedPenalty;
        reasons.push(
          appliedPenalty < unrelatedCount
            ? `${unrelatedCount} unrelated pricing-type branch(es) present, capped at -${appliedPenalty} (strong connectivity evidence: ${bestMechanism})`
            : `${unrelatedCount} unrelated pricing-type branch(es) present (-${appliedPenalty})`,
        );
      }

      const contractEnabledFalseCount = c.tierDiscountBranches.filter(b => b.isScheduleBased && b.isContractEnabled === "false").length;
      const contractBonus = contractEnabledFalseCount > 0 ? 1 : 0;
      if (contractBonus > 0) { score += contractBonus; reasons.push(`${contractEnabledFalseCount} schedule-based branch(es) explicitly declare IsContractEnabled=false (+${contractBonus})`); }

      const smallStepBonus = c.physicalStepCount <= 10 ? 1 : 0;
      if (smallStepBonus > 0) { score += smallStepBonus; reasons.push(`small physical step count (${c.physicalStepCount}) — unlikely to be a large shared procedure (+${smallStepBonus})`); }

      // §TEMPORARY diagnostic breakdown (never hides the raw score) — states the trust decision this exact
      // score/floor comparison implies, using the SAME `MINIMUM_TRUSTED_DONOR_SCORE` constant and the SAME
      // `>=` comparison `resolveTierBasedPricingDonor`'s own `top.score < MINIMUM_TRUSTED_DONOR_SCORE` check
      // uses (kept in sync deliberately — this never reimplements that decision independently, only reports
      // it). Safe to delete once no longer needed for diagnosis; does not affect eligibility or selection.
      const trustDecision = score >= MINIMUM_TRUSTED_DONOR_SCORE ? "ELIGIBLE" : "REJECTED";
      const breakdown = [
        `Strong schedule-based Tier-Based flow: ${strongScheduleBasedTierFlow ? "YES" : "NO"} (best mechanism: ${bestMechanism})`,
        `Raw donor score: ${score}`,
        `Classification bonus (${c.classification}): +${classificationBonus}`,
        `Schedule-based VTD evidence: +${scheduleBasedFlowBonus}`,
        `Connectivity mechanism evidence (${bestMechanism}): +${mechanismBonus}`,
        `Shared branch penalty: -${appliedPenalty}${appliedPenalty < unrelatedCount ? ` (raw -${unrelatedCount}, capped — strong connectivity evidence)` : ""}`,
        `Non-contract evidence (IsContractEnabled=false): +${contractBonus}`,
        `Small step count bonus: +${smallStepBonus}`,
        `Trust decision: ${trustDecision} (floor: ${MINIMUM_TRUSTED_DONOR_SCORE})`,
        `Reason: ${reasons.join("; ")}`,
      ];
      if (strongScheduleBasedTierFlow && appliedPenalty < unrelatedCount && trustDecision === "ELIGIBLE") {
        breakdown.push("Accepted via strong schedule-based Tier-Based branch evidence");
      }

      return { fullName: c.fullName, score, reason: breakdown.join("\n") };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildNoCoherentDonorDiagnostic(candidates: ExpressionSetDonorCandidate[]): string {
  if (candidates.length === 0) {
    return "No ExpressionSetDefinition in this org contains any VolumeTierDiscount step at all — nothing to clone from.";
  }
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`--- ${c.fullName} (${c.fileName}) ---`);
    lines.push(`Classification: ${c.classification} — ${c.classificationReasons.join("; ")}`);
    lines.push(`PricingSettings x${c.pricingSettingsOccurrences}, ListPrice x${c.listPriceOccurrences}, VolumeTierDiscount x${c.tierDiscountOccurrences}`);
    for (const b of c.tierDiscountBranches) {
      lines.push(`  VolumeTierDiscount @${b.pathLabel} (name=${b.name ?? "(none)"}, parentStep=${b.parentStep ?? "(none)"}, sequenceNumber=${b.sequenceNumber ?? "(none)"})`);
      lines.push(`    Physical ancestors: ${b.physicalContainerAncestors.join(" -> ") || "(none, root-level)"}`);
      lines.push(`    Schedule-based (has PriceAdjustmentScheduleId param): ${b.isScheduleBased ? "YES" : "NO — this is the contract-based block; it can never price anything outside a real contracted quote"}`);
      lines.push(`    IsContractEnabled: ${b.isContractEnabled ?? "(none)"}`);
      lines.push(`    Connected to ListPrice: ${b.connectedToListPrice ? `YES via ${b.listPriceConnection}` : "NO"}`);
      lines.push(`    Connected to PricingSettings: ${b.connectedToPricingSettings ? `YES via ${b.pricingSettingsConnection}` : "NO"}`);
      lines.push(`    InputUnitPrice binding: ${b.inputUnitPrice ?? "(none)"}`);
      if (b.listPriceCandidateDiagnostics || b.pricingSettingsCandidateDiagnostics) {
        lines.push("    [TEMP DIAGNOSTIC] Neither ListPrice nor PricingSettings resolved a connection — full candidate breakdown:");
      }
      if (b.listPriceCandidateDiagnostics) {
        lines.push(`      PricingSettings candidates: ${b.pricingSettingsCandidateDiagnostics?.length ?? 0}`);
        for (const ps of b.pricingSettingsCandidateDiagnostics ?? []) {
          const outputs = ps.outputBindings.length > 0
            ? ps.outputBindings.map(o => `${o.name ?? "(unnamed)"}=${o.value ?? "(no value)"}`).join(", ")
            : "(no output-flagged parameters found on this step)";
          lines.push(`        PricingSettings @${ps.pathLabel} (parentStep=${ps.parentStep ?? "(none)"}, sequenceNumber=${ps.sequenceNumber ?? "(none)"}) outputs: ${outputs}`);
        }
        if ((b.pricingSettingsCandidateDiagnostics?.length ?? 0) === 0) {
          lines.push("        (none — this candidate has no PricingSettings node at all, despite pricingSettingsOccurrences reported above)");
        }

        lines.push(`      ListPrice candidates: ${b.listPriceCandidateDiagnostics.length}`);
        if (b.listPriceCandidateDiagnostics.length === 0) {
          lines.push("        (none — this candidate has no ListPrice node at all, despite listPriceOccurrences reported above)");
        }
        for (const lp of b.listPriceCandidateDiagnostics) {
          const outputs = lp.outputBindings.length > 0
            ? lp.outputBindings.map(o => `${o.name ?? "(unnamed)"}=${o.value ?? "(no value)"}`).join(", ")
            : "(no output-flagged parameters found on this step)";
          lines.push(`        ListPrice @${lp.pathLabel} (parentStep=${lp.parentStep ?? "(none)"}, sequenceNumber=${lp.sequenceNumber ?? "(none)"}) outputs: ${outputs}`);
        }

        const inputUnitPrice = b.inputUnitPrice;
        const netUnitPriceProducers = [...(b.pricingSettingsCandidateDiagnostics ?? []), ...b.listPriceCandidateDiagnostics]
          .filter(cand => inputUnitPrice !== null && cand.outputBindings.some(o => o.value === inputUnitPrice));
        lines.push(`      NetUnitPrice producer candidates (any step whose output value equals VolumeTierDiscount's own InputUnitPrice binding "${inputUnitPrice ?? "(none)"}"): ${netUnitPriceProducers.length}`);
        for (const p of netUnitPriceProducers) {
          lines.push(`        ${p.actionType ?? "(unknown actionType)"} @${p.pathLabel} (sequenceNumber=${p.sequenceNumber ?? "(none)"}, parentStep=${p.parentStep ?? "(none)"})`);
        }

        if (b.pricingSettingsWaterfallMatch) {
          lines.push(`      PricingSettings -> VolumeTierDiscount variable match: ${b.pricingSettingsWaterfallMatch.matched ? "YES" : "NO"} — ${b.pricingSettingsWaterfallMatch.reason}`);
        }
      }
    }
    lines.push("");
  }
  lines.push(
    "A valid Tier-Based (Slab) Pricing Expression Set donor requires: PricingSettings, ListPrice, and a SCHEDULE-BASED " +
    "VolumeTierDiscount branch (one whose own bindings include a `PriceAdjustmentScheduleId` parameter — NOT a " +
    "contract-based block, which would require a ContractItemId that is always null outside a real contracted quote) " +
    "physically or logically connected to that same donor's ListPrice OR PricingSettings via a <parentStep> chain, " +
    "physical nesting, a matching InputUnitPrice/published-output variable binding against ListPrice, the shared " +
    "price-waterfall variable against PricingSettings, or declared sequence order. Configure " +
    "a working Tier-Based (Slab) Adjustment pricing procedure manually in Salesforce Setup, then retry.",
  );
  return lines.join("\n");
}

export interface TierBasedPricingDonorSelection {
  fullName: string; fileName: string; fullXml: string; candidate: ExpressionSetDonorCandidate;
  ranking: DonorCandidateRanking[];
  connectedScheduleBasedOccurrenceIndexes: number[];
}

export interface TierBasedPricingDonorResolution {
  selection: TierBasedPricingDonorSelection | null;
  candidatesWithTierDiscount: ExpressionSetDonorCandidate[];
  lowConfidenceCandidates?: DonorCandidateRanking[];
}

export async function resolveTierBasedPricingDonor(client: SalesforceClient): Promise<TierBasedPricingDonorResolution> {
  const { files } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
  const inspected = files.map(f => ({ file: f, candidate: inspectDonorCandidate(f.fileName, f.content) }));
  const candidatesWithTierDiscount = inspected.filter(e => e.candidate.tierDiscountOccurrences > 0).map(e => e.candidate);

  // §price-waterfall-variable — ListPrice's own presence is still separately required
  // (`listPriceOccurrences > 0`) even when the proven connection is via PricingSettings, not ListPrice
  // itself: this never claims eligibility for a donor that lacks a ListPrice branch entirely, only
  // recognizes a real, evidenced alternative path to the SAME pricing flow (mirrors attribute-based's own
  // `resolveAttributeBasedPricingDonor` eligibility filter exactly).
  const eligible = inspected.filter(({ candidate }) =>
    candidate.pricingSettingsOccurrences > 0
    && candidate.listPriceOccurrences > 0
    && candidate.tierDiscountOccurrences > 0
    && candidate.tierDiscountBranches.some(b => b.isScheduleBased && (b.connectedToListPrice || b.connectedToPricingSettings)),
  );
  if (eligible.length === 0) return { selection: null, candidatesWithTierDiscount };

  const ranking = rankCandidates(eligible.map(e => e.candidate));
  const top = ranking[0];
  if (top.score < MINIMUM_TRUSTED_DONOR_SCORE) {
    client.logDebug("xml-diagnostic", `Tier-Based Pricing donor ranking (all below trust floor):\n${ranking.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`);
    return { selection: null, candidatesWithTierDiscount, lowConfidenceCandidates: ranking };
  }

  const selected = eligible.find(e => e.candidate.fullName === top.fullName)!;
  const connectedScheduleBasedOccurrenceIndexes = selected.candidate.tierDiscountBranches
    .filter(b => b.isScheduleBased && (b.connectedToListPrice || b.connectedToPricingSettings))
    .map(b => b.occurrenceIndex);

  return {
    selection: {
      fullName: selected.candidate.fullName, fileName: selected.file.fileName, fullXml: selected.file.content,
      candidate: selected.candidate, ranking, connectedScheduleBasedOccurrenceIndexes,
    },
    candidatesWithTierDiscount,
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
  const { files, warning } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
  const candidates = files.map(f => inspectDonorCandidate(f.fileName, f.content));
  const withTarget = candidates.filter(c => c.orderedActionTypes.includes(targetActionType));
  const ranking = rankCandidates(withTarget);
  const firstFileContainingActionType = withTarget[0]?.fileName ?? null;
  return { totalCandidates: candidates.length, firstFileContainingActionType, candidates: withTarget, ranking, retrievalWarning: warning };
}
