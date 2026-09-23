/**
 * §Phase 2 — evidence-only ExpressionSetDefinition donor inventory/inspection.
 *
 * Read-only, diagnostic-only: never deploys anything, never selects/switches the donor the real build
 * actually uses, never prunes/rewrites any XML. Deliberately does NOT import anything from
 * `canvasBuilder.ts` — every primitive used here is one of xmlBlocks.ts's existing, already-exported,
 * unchanged functions, re-composed independently. This means this module can neither affect, nor be
 * affected by, the working donor-selection/branch-selection/patch logic `canvasBuilder.ts`/
 * `templateExpressionSet.ts`'s `findTemplateStepOccurrences()` actually use for the real build — that
 * function is untouched and still the only thing the real pipeline calls.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { retrieveVersionScopedExpressionSetDefinitionFiles } from "./templateExpressionSet";
import {
  extractStepGraph, type PhysicalStepNode,
  getTagValue,
  getTopLevelParameterBlocks, extractCustomElementBlocks, extractFlatBlocks,
  getParamName, getParamValue, isOutputParam, isInputParam,
} from "./xmlBlocks";

const ABSENT = "<absent>";

/** Unrelated-pricing-type signals per Phase 2B's own suggested classification — the same "shared/default
 * procedure bundles every pricing capability" signal set the earlier investigation turn already named. */
export const SHARED_SIGNAL_ACTION_TYPES = new Set([
  "FormulaBasedPricing", "ManualDiscount", "VolumeTierDiscount", "VolumeDiscount", "BundleDiscount", "Proration", "SubscriptionPricing",
]);

function deriveFallbackFullName(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base.replace(/\.expressionSetDefinition-meta\.xml$/i, "");
}

/** Every input/output parameter (top-level or nested inside a `<customElement>`) within `xml` — a
 * from-scratch re-composition of xmlBlocks.ts's own exported primitives, deliberately not importing
 * canvasBuilder.ts's private equivalent (`getAllParameterBlocksRecursive`). */
function collectAllParameterBindings(xml: string): { name: string | null; value: string | null; input: boolean; output: boolean }[] {
  const results: { name: string | null; value: string | null; input: boolean; output: boolean }[] = [];
  for (const b of getTopLevelParameterBlocks(xml)) {
    results.push({ name: getParamName(b.block), value: getParamValue(b.block), input: isInputParam(b.block), output: isOutputParam(b.block) });
  }
  for (const ce of extractCustomElementBlocks(xml)) {
    for (const p of extractFlatBlocks(ce, "parameters")) {
      results.push({ name: getParamName(p), value: getParamValue(p), input: isInputParam(p), output: isOutputParam(p) });
    }
  }
  return results;
}

function findBindingValue(bindings: { name: string | null; value: string | null }[], name: string): string | null {
  return bindings.find(b => b.name === name)?.value ?? null;
}

/** This occurrence's OWN fields text only — truncated at its first nested `<steps` child, exactly like
 * `xmlBlocks.ts`'s `getOwnActionType` scopes itself, so a container's nested child's own parameters are
 * never misattributed to the container. */
function ownFieldsOnly(node: PhysicalStepNode): string {
  const nestedIdx = node.content.indexOf("<steps");
  return nestedIdx === -1 ? node.content : node.content.slice(0, nestedIdx);
}

/** Walks the LOGICAL `<parentStep>` NAME chain upward (Salesforce's own resolution mechanism) —
 * independent re-implementation of the same proven-unique-lookup discipline `canvasBuilder.ts`'s
 * `walkParentChain` already uses, so a cycle or an ambiguous name never causes an infinite loop or a
 * silently-wrong "ancestor". */
function walkParentStepChainNames(graph: PhysicalStepNode[], start: PhysicalStepNode): { chain: PhysicalStepNode[]; note: string } {
  const chain: PhysicalStepNode[] = [];
  const visited = new Set<string>();
  let currentName = start.parentStep;
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

/** Physical XML-nesting ancestor NODES (container→child), via `parentOccurrenceIndex` — distinct from, and
 * frequently different from, the logical `<parentStep>` chain above; live evidence (every Attribute-Based
 * donor in the org having AttributeDiscount with NO `<parentStep>` at all) proved the named-chain signal
 * alone is not sufficient to recognize a genuinely coherent, already-deployed pricing flow — Salesforce's
 * Expression Set canvas can also express "this step consumes that one's output" purely through physical
 * containment (a step nested inside another's own `<steps>` children), with `<parentStep>` reserved for
 * cases that need an explicit cross-branch reference. Returns full nodes (not just names) so both name AND
 * actionType are available to callers. */
function physicalAncestorNodes(graph: PhysicalStepNode[], node: PhysicalStepNode): PhysicalStepNode[] {
  const byOcc = new Map(graph.map(n => [n.occurrenceIndex, n]));
  const ancestors: PhysicalStepNode[] = [];
  let current = node.parentOccurrenceIndex;
  while (current !== null) {
    const parent = byOcc.get(current);
    if (!parent) break;
    ancestors.push(parent);
    current = parent.parentOccurrenceIndex;
  }
  return ancestors;
}

/** Physical XML-nesting ancestor NAMES — thin wrapper over `physicalAncestorNodes` kept for the existing
 * `physicalContainerAncestors` diagnostic field's shape. */
function physicalContainerAncestors(graph: PhysicalStepNode[], node: PhysicalStepNode): string[] {
  return physicalAncestorNodes(graph, node).map(n => n.name ?? `(unnamed ${n.actionType ?? "step"})`);
}

/** Parses a step's `<sequenceNumber>` (if present and numeric) — used only for the weakest, last-resort
 * connectivity signal below. Never assumed present; a non-numeric or absent value simply can't produce this
 * signal for that node. */
function parsedSequenceNumber(node: PhysicalStepNode): number | null {
  if (node.sequenceNumber === null) return null;
  const n = Number(node.sequenceNumber);
  return Number.isFinite(n) ? n : null;
}

export type ConnectionMechanism = "parentStep-chain" | "physical-nesting" | "variable-binding" | "price-waterfall-variable" | "sequence-order" | "none";

/**
 * §REMOVED (self-contradiction found, not disproved by live data — this environment has no live
 * Salesforce session and no persisted copy of this donor's raw XML, so the hypothesis below could never
 * be confirmed OR refuted from real bytes). A `shared-container-sibling` signal — two steps declaring the
 * IDENTICAL `<parentStep>` value treated as proof they belong to the same pricing branch — was added and
 * shipped, then found to directly contradict THIS FILE'S OWN already-established finding about this exact
 * donor (see the very next doc comment below): "`<parentStep>` in this org governs canvas PLACEMENT, not
 * the actual pricing DATA dependency" — discovered when AttributeDiscount's own `<parentStep>` naming a
 * `ListContainer` was proven NOT to indicate a real dependency on whatever else that container touches.
 * Treating "two steps share a parentStep container" as reliable evidence uses the EXACT SAME assumption
 * (this donor's ListContainer/parentStep values carry semantic meaning) that was already discredited one
 * investigation earlier, on the same donor. Since ListPrice's specific identity is load-bearing — the
 * selected occurrence's raw XML is cloned verbatim into the deployed canvas (see `resolvePricingFlowAncestors`
 * in canvasBuilder.ts: `lpXml = lpMatch.full`, then spliced into the composed Expression Set and its own
 * LookUpId/output values read directly) — a wrong pairing would not fail loudly, it would silently deploy
 * a procedure that computes price from the WRONG ListPrice branch. An unproven, self-contradicting
 * mechanism is worse than no mechanism here; removed rather than kept because a synthetic test passed.
 */

/**
 * §Live-org fix (2nd occurrence) — a REAL org's working Attribute-Based donor (`Rev_Mgmt_Default_...`)
 * proved even the 3-signal model above is incomplete: its AttributeDiscount occurrences have a real,
 * non-empty `<parentStep>` — but it names a `ListContainer` (a physical/UI canvas grouping step), not
 * ListPrice or PricingSettings, and there is no physical nesting either. `<parentStep>` in this org
 * governs canvas PLACEMENT, not the actual pricing DATA dependency. The real dependency Salesforce's
 * calculation engine relies on is expressed the way every dataflow engine expresses it: AttributeDiscount
 * declares an `InputUnitPrice` parameter naming the exact variable it reads, and the ListPrice occurrence
 * that PUBLISHES that same variable as one of its own OUTPUT parameters is the one it actually depends on.
 * This is not invented — both the input value and the output value are already present, verbatim, in the
 * donor's own XML; recognizing a match between them as connectivity proof only promotes a signal
 * `canvasBuilder.ts` already trusted for pricing-waterfall VALIDATION (see `resolveTargetInputUnitPriceValue`)
 * into ALSO serving as donor-connectivity proof. Requires an UNAMBIGUOUS match — exactly one occurrence of
 * `publisherActionType` in the donor publishes the value AttributeDiscount consumes; two or more candidates
 * publishing the same value is genuine ambiguity, never resolved by guessing.
 *
 * §Live-org fix (3rd occurrence, `Rev_Mgmt_Default_Pricing_Procedure2_V1`) — generalized from
 * ListPrice-only to an arbitrary `publisherActionType`. Real donor evidence: NEITHER of this org's two
 * ListPrice branches publishes an output named `NetUnitPrice` (they publish `ListPrice`/`ItemContractPrice`
 * respectively) — but PricingSettings genuinely DOES declare `NetUnitPrice` as one of its own outputs, and
 * BOTH AttributeDiscount occurrences declare `InputUnitPrice` bound to exactly that name. This is Revenue
 * Cloud's documented "pricing waterfall" convention: `NetUnitPrice` is a shared, running price context that
 * PricingSettings owns/coordinates and that price-affecting steps (ListPrice, AttributeDiscount, ...) read
 * and write in sequence — a real, org-native mechanism, not a step-to-step point-to-point binding the way
 * `variable-binding` (ListPrice-scoped) models it. Callers use this to prove AttributeDiscount participates
 * in the SAME pricing flow as PricingSettings even when neither `<parentStep>` nor physical nesting nor a
 * direct ListPrice output match exists — never used to claim a fabricated DIRECT ListPrice dependency.
 */
function resolveViaVariableBinding(
  graph: PhysicalStepNode[], adNode: PhysicalStepNode, publisherActionType: string,
): { node: PhysicalStepNode | null; matchedValue: string | null } {
  const adBindings = collectAllParameterBindings(ownFieldsOnly(adNode));
  const inputUnitPrice = findBindingValue(adBindings, "InputUnitPrice");
  if (!inputUnitPrice) return { node: null, matchedValue: null };

  const publisherNodes = graph.filter(n => n.actionType === publisherActionType);
  const matches = publisherNodes.filter(p =>
    // Searched through the WHOLE publisher subtree (never assumed to be a direct/top-level field) —
    // passing `p.full` (not `ownFieldsOnly(p)`) to the same binding collector used everywhere else in
    // this file gives exactly that recursive scope, matching canvasBuilder.ts's own established pattern.
    collectAllParameterBindings(p.full).some(b => b.output && b.value === inputUnitPrice),
  );
  if (matches.length !== 1) return { node: null, matchedValue: null };
  return { node: matches[0], matchedValue: inputUnitPrice };
}

/**
 * §Live-org fix — resolves how (if at all) `node` (an AttributeDiscount occurrence) is connected to the
 * nearest ancestor in `graph` with actionType `targetActionType`, checking FIVE independent, real,
 * already-present signals in this exact priority order (strongest evidence first — never a guess, never an
 * invented tag):
 *   1. `parentStep-chain` — `node`'s own `<parentStep>` NAME chain (Salesforce's own resolution mechanism)
 *      reaches a step of `targetActionType`.
 *   2. `physical-nesting` — `node` is physically nested (via `parentOccurrenceIndex`) inside a step of
 *      `targetActionType` — a real, different-but-equally-legitimate way Salesforce's canvas can express
 *      "this step runs within/consumes that one," proven necessary by live evidence: every genuinely
 *      deployed Attribute-Based donor found in one org has AttributeDiscount with an EMPTY `<parentStep>`.
 *   3. `variable-binding` — ONLY checked when `targetActionType === "ListPrice"` and `node` is an
 *      AttributeDiscount occurrence (the one relationship this signal has live evidence for): its
 *      `InputUnitPrice` value unambiguously matches one specific ListPrice occurrence's own published
 *      output value (see `resolveViaVariableBinding`) — proven necessary by a SECOND real org
 *      whose AttributeDiscount's `<parentStep>` names a `ListContainer` (canvas placement), not ListPrice.
 *   4. `price-waterfall-variable` — ONLY checked when `targetActionType === "PricingSettings"` and `node`
 *      is an AttributeDiscount occurrence: its `InputUnitPrice` value unambiguously matches PricingSettings'
 *      own published output value — proven necessary by a THIRD real org (`Rev_Mgmt_Default_Pricing_
 *      Procedure2_V1`) whose two ListPrice branches publish `ListPrice`/`ItemContractPrice` (never
 *      `NetUnitPrice`), while PricingSettings genuinely publishes `NetUnitPrice` and BOTH AttributeDiscount
 *      occurrences consume exactly that name — Revenue Cloud's documented shared "pricing waterfall"
 *      variable, owned/coordinated by PricingSettings, not a direct ListPrice→AttributeDiscount link.
 *      §This is a PricingSettings-only signal, deliberately never generalized to ListPrice pairing — see
 *      the removed `shared-container-sibling` signal's doc comment above for why extending "shared
 *      container" reasoning to ListPrice specifically was found to self-contradict this exact donor's own
 *      established parentStep semantics.
 *   5. `sequence-order` — weakest signal, used only when none of the above resolves: within the SAME
 *      donor graph, a step of `targetActionType` exists whose own `<sequenceNumber>` is strictly less than
 *      `node`'s (i.e. it executes earlier in this donor's own declared canvas order). This does not PROVE a
 *      data dependency, only relative execution order that is already explicit in the donor's own XML —
 *      callers must log this mechanism explicitly as lower-confidence, never silently treat it the same as
 *      the stronger signals.
 * Returns `"none"` if nothing resolves — never fabricates a connection.
 */
export interface ResolvedConnectedAncestor {
  node: PhysicalStepNode | null;
  mechanism: ConnectionMechanism;
}

/** Same 5-signal priority as the file-level doc above, but returns the actual matching ANCESTOR NODE
 * alongside the mechanism that found it — `canvasBuilder.ts` needs the real node (to read its `<name>`,
 * splice its content, etc.), not just a boolean/label. For `sequence-order`, picks the closest predecessor
 * (highest `<sequenceNumber>` that is still less than `node`'s own) among same-actionType candidates —
 * never an arbitrary "first found." */
export function resolveConnectedAncestor(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ResolvedConnectedAncestor {
  const chain = walkParentStepChainNames(graph, node).chain;
  const viaChain = chain.find(n => n.actionType === targetActionType);
  if (viaChain) return { node: viaChain, mechanism: "parentStep-chain" };

  const viaPhysical = physicalAncestorNodes(graph, node).find(n => n.actionType === targetActionType);
  if (viaPhysical) return { node: viaPhysical, mechanism: "physical-nesting" };

  if (targetActionType === "ListPrice" && node.actionType === "AttributeDiscount") {
    const viaBinding = resolveViaVariableBinding(graph, node, "ListPrice");
    if (viaBinding.node) return { node: viaBinding.node, mechanism: "variable-binding" };
  }

  if (targetActionType === "PricingSettings" && node.actionType === "AttributeDiscount") {
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

/** Thin wrapper over `resolveConnectedAncestor` for callers that only need the mechanism, not the node
 * itself — see that function's doc comment for the full 4-signal priority order. */
export function resolveConnection(graph: PhysicalStepNode[], node: PhysicalStepNode, targetActionType: string): ConnectionMechanism {
  return resolveConnectedAncestor(graph, node, targetActionType).mechanism;
}

export interface AttributeDiscountBindingSnapshot {
  inputUnitPrice: string | null;
  priceAdjustmentScheduleBinding: string | null;
  attributeName: string | null;
  attributeValue: string | null;
  isPriceImpacting: string | null;
  adjustmentType: string | null;
  adjustmentValue: string | null;
  publishedOutputs: string[];
}

/** §Live-org forensic diagnostics (Org B) — EVERY `<parameters>` binding found anywhere in a step's own
 * subtree, verbatim (name/value/input/output), never filtered down to only the handful of parameter
 * names this resolver already knows to look for by name (InputUnitPrice, PriceAdjustmentScheduleId,
 * etc.). Exists so a rejected-donor diagnostic can show the COMPLETE real parameter set Salesforce
 * actually sent — the only way to tell whether the org expresses a value under a name this resolver
 * doesn't yet recognize, versus that value genuinely not existing anywhere in the donor's XML. */
export interface RawParameterBinding {
  name: string | null;
  value: string | null;
  input: boolean;
  output: boolean;
}

/** One hop's raw, unfiltered facts (name/actionType/sequenceNumber/parentStep) — used to render the
 * COMPLETE `<parentStep>` chain (not just names) in forensic diagnostics, so a hop that names a
 * non-pricing grouping/container step (e.g. a `ListContainer`) is visibly distinguishable from one that
 * names a real PricingSettings/ListPrice/AttributeDiscount step. */
export interface ChainHopInfo {
  name: string | null;
  actionType: string | null;
  sequenceNumber: string | null;
  parentStep: string | null;
}

/** §Live-org forensic diagnostics (Org B) — what (if anything) a `<parentStep>` VALUE actually resolves
 * to in this donor's own graph, independent of whether the overall chain walk found a pricing step.
 * `found: false` means the name doesn't match any physical step in this donor at all (a genuinely
 * dangling reference, or the name belongs to a metadata construct `extractStepGraph` doesn't model as a
 * `<steps>` node — e.g. a canvas-only grouping element). Never assumed to be a data-flow parent merely
 * because it resolves — see the `actionType` field, which is the actual evidence for that judgment. */
export interface ParentStepTargetInspection {
  found: boolean;
  name: string | null;
  actionType: string | null;
  sequenceNumber: string | null;
  parentStep: string | null;
  rawXml: string | null;
}

export interface AttributeDiscountBranchInspection {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string | null;
  sequenceNumber: string | null;
  physicalContainerAncestors: string[];
  parentStepChainAncestors: string[];
  parentStepChainNote: string;
  /** §Live-org forensic diagnostics — the SAME chain as `parentStepChainAncestors`, but with each hop's
   * full raw facts (actionType/sequenceNumber/parentStep), not just its name. */
  parentStepChainDetail: ChainHopInfo[];
  /** §Live-org forensic diagnostics — what `parentStep` (this occurrence's OWN `<parentStep>` value, if
   * any) actually resolves to, independent of the multi-hop chain walk above. `null` when this occurrence
   * has no `<parentStep>` at all. */
  parentStepTarget: ParentStepTargetInspection | null;
  /** Which real, already-present signal (if any) proves this branch resolves back to ListPrice/PricingSettings
   * — see `resolveConnection`'s doc comment for the exact priority order and what each mechanism means. */
  listPriceConnection: ConnectionMechanism;
  pricingSettingsConnection: ConnectionMechanism;
  connectedToListPrice: boolean;
  connectedToPricingSettings: boolean;
  bindings: AttributeDiscountBindingSnapshot;
  /** §Live-org forensic diagnostics — every parameter binding found anywhere in this occurrence's own
   * subtree, unfiltered. */
  allBindings: RawParameterBinding[];
  /** §Live-org forensic diagnostics — the complete `<steps>...</steps>` text for this occurrence, verbatim. */
  rawXml: string;
}

export type DonorClassification =
  | "PRICING_PROCEDURE_LIKELY" | "SHARED_PRICING_PROCEDURE_LIKELY" | "ATTRIBUTE_BASED_PRICING_LIKELY"
  | "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY" | "UNCLASSIFIED";

export interface ExpressionSetDonorCandidate {
  fullName: string;
  fileName: string;
  label: string;
  template: string;
  type: string;
  processType: string;
  usageSubType: string;
  physicalStepCount: number;
  attributeDiscountOccurrences: number;
  pricingSettingsOccurrences: number;
  listPriceOccurrences: number;
  orderedActionTypes: string[];
  uniqueActionTypes: string[];
  rootBranches: { name: string | null; actionType: string | null }[];
  attributeDiscountInMultipleBranches: boolean;
  classification: DonorClassification;
  classificationReasons: string[];
  attributeDiscountBranches: AttributeDiscountBranchInspection[];
  /** §Live-org forensic diagnostics (Org B) — every ListPrice/PricingSettings occurrence's complete,
   * unfiltered facts (all bindings, sequenceNumber, raw XML) — never collapsed to just a count, so a
   * rejected-donor diagnostic can show exactly what each occurrence actually publishes. */
  listPriceOccurrenceDetails: PricingStepOccurrenceDetail[];
  pricingSettingsOccurrenceDetails: PricingStepOccurrenceDetail[];
}

/**
 * §Phase 2B — evidence-only classification. Every branch below is driven ONLY by counted signals on
 * THIS candidate; "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY" is reserved for the case the metadata itself
 * gives no pricing-element signal at all — never applied merely because a file has many steps.
 */
function classifyDonor(input: {
  uniqueActionTypes: string[];
  attributeDiscountCount: number;
  pricingSettingsCount: number;
  listPriceCount: number;
  anyAttributeDiscountConnectedToListPrice: boolean;
  // §Live-org fix (Rev_Mgmt_Default_Pricing_Procedure2_V1) — a real donor can have AttributeDiscount
  // connected to PricingSettings via the shared price-waterfall variable (see `price-waterfall-variable`
  // in `resolveConnectedAncestor`'s doc comment) while genuinely NOT connected to either ListPrice branch
  // by name/output — this is still real, evidenced participation in the SAME pricing flow, since
  // PricingSettings owns the running NetUnitPrice context both ListPrice and AttributeDiscount read/write.
  // Never used alone: `hasListPrice` is still required separately, so this never claims coherence for a
  // donor that lacks a ListPrice branch entirely.
  anyAttributeDiscountConnectedToPricingSettings: boolean;
}): { classification: DonorClassification; reasons: string[] } {
  const reasons: string[] = [];
  const hasPricingSettings = input.pricingSettingsCount > 0;
  const hasListPrice = input.listPriceCount > 0;
  const hasAttributeDiscount = input.attributeDiscountCount > 0;
  const unrelated = input.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));

  if (hasPricingSettings) reasons.push("Contains PricingSettings.");
  if (hasListPrice) reasons.push("Contains ListPrice.");
  if (hasAttributeDiscount) reasons.push(`Contains AttributeDiscount (${input.attributeDiscountCount} occurrence(s)).`);
  if (unrelated.length > 0) reasons.push(`Also contains unrelated pricing-type branch(es): ${unrelated.join(", ")}.`);

  if (!hasAttributeDiscount) {
    if (!hasPricingSettings && !hasListPrice) {
      reasons.push("No PricingSettings, ListPrice, or AttributeDiscount signal at all.");
      return { classification: "CONTEXT_OR_GENERIC_EXPRESSIONSET_LIKELY", reasons };
    }
    reasons.push("Has PricingSettings/ListPrice but no AttributeDiscount occurrence — not a candidate for Attribute-Based Pricing.");
    return { classification: "UNCLASSIFIED", reasons };
  }
  if (!hasPricingSettings || !hasListPrice) {
    reasons.push("Has AttributeDiscount but is missing PricingSettings and/or ListPrice — not a coherent pricing hierarchy.");
    return { classification: "UNCLASSIFIED", reasons };
  }
  if (unrelated.length >= 3) {
    reasons.push(`${unrelated.length} unrelated pricing-type actionTypes present alongside AttributeDiscount — consistent with one large shared/default pricing procedure.`);
    return { classification: "SHARED_PRICING_PROCEDURE_LIKELY", reasons };
  }
  if (unrelated.length === 0 && input.anyAttributeDiscountConnectedToListPrice) {
    reasons.push("No unrelated pricing-type branches, and at least one AttributeDiscount occurrence resolves back to ListPrice (via its <parentStep> chain, physical nesting, a matching input/output variable binding, or declared sequence order).");
    return { classification: "ATTRIBUTE_BASED_PRICING_LIKELY", reasons };
  }
  if (unrelated.length === 0 && input.anyAttributeDiscountConnectedToPricingSettings) {
    reasons.push("No unrelated pricing-type branches, and at least one AttributeDiscount occurrence resolves back to PricingSettings via the shared price-waterfall variable (its InputUnitPrice matches PricingSettings' own published output), even though it does not resolve back to ListPrice directly.");
    return { classification: "ATTRIBUTE_BASED_PRICING_LIKELY", reasons };
  }
  reasons.push("Has the core PricingSettings/ListPrice/AttributeDiscount signal, but not enough evidence for a more specific classification.");
  return { classification: "PRICING_PROCEDURE_LIKELY", reasons };
}

/** Resolve what `parentStepName` actually is in `graph` — independent of the multi-hop chain walk, so a
 * single confusing/ambiguous hop doesn't hide what the IMMEDIATE target actually is. Never assumes a
 * unique match is required to report facts: if the name resolves to more than one node (a real,
 * loggable ambiguity), the first is reported for inspection purposes with that ambiguity noted via
 * `found`/`actionType` still reflecting real data, never fabricated. */
function inspectParentStepTarget(graph: PhysicalStepNode[], parentStepName: string | null): ParentStepTargetInspection | null {
  if (!parentStepName) return null;
  const matches = graph.filter(n => n.name === parentStepName);
  if (matches.length === 0) return { found: false, name: parentStepName, actionType: null, sequenceNumber: null, parentStep: null, rawXml: null };
  const target = matches[0];
  return { found: true, name: target.name, actionType: target.actionType, sequenceNumber: target.sequenceNumber, parentStep: target.parentStep, rawXml: target.full };
}

function inspectAttributeDiscountBranch(graph: PhysicalStepNode[], node: PhysicalStepNode): AttributeDiscountBranchInspection {
  const bindings = collectAllParameterBindings(ownFieldsOnly(node));
  const parentChain = walkParentStepChainNames(graph, node);
  const listPriceConnection = resolveConnection(graph, node, "ListPrice");
  const pricingSettingsConnection = resolveConnection(graph, node, "PricingSettings");
  return {
    occurrenceIndex: node.occurrenceIndex,
    pathLabel: node.pathLabel,
    name: node.name,
    parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber,
    physicalContainerAncestors: physicalContainerAncestors(graph, node),
    parentStepChainAncestors: parentChain.chain.map(n => n.name ?? `(unnamed ${n.actionType ?? "step"})`),
    parentStepChainNote: parentChain.note,
    parentStepChainDetail: parentChain.chain.map(n => ({ name: n.name, actionType: n.actionType, sequenceNumber: n.sequenceNumber, parentStep: n.parentStep })),
    parentStepTarget: inspectParentStepTarget(graph, node.parentStep),
    listPriceConnection,
    pricingSettingsConnection,
    connectedToListPrice: listPriceConnection !== "none",
    connectedToPricingSettings: pricingSettingsConnection !== "none",
    bindings: {
      inputUnitPrice: findBindingValue(bindings, "InputUnitPrice"),
      priceAdjustmentScheduleBinding: findBindingValue(bindings, "PriceAdjustmentScheduleId"),
      attributeName: findBindingValue(bindings, "AttributeName"),
      attributeValue: findBindingValue(bindings, "AttributeValue"),
      isPriceImpacting: findBindingValue(bindings, "IsPriceImpacting"),
      adjustmentType: findBindingValue(bindings, "AdjustmentTypeField"),
      adjustmentValue: findBindingValue(bindings, "AdjustmentValueField"),
      publishedOutputs: bindings.filter(b => b.output && b.value).map(b => b.value as string),
    },
    allBindings: bindings,
    rawXml: node.full,
  };
}

/** §Live-org forensic diagnostics (Org B) — the complete, unfiltered facts for one ListPrice/
 * PricingSettings occurrence: every parameter binding found ANYWHERE in its own subtree (via `.full`,
 * matching `resolveListPriceViaVariableBinding`'s own recursive scope — never just its direct fields),
 * its sequenceNumber (or explicitly "not set" — the resolver's sequence-order signal silently excludes
 * any occurrence with no `<sequenceNumber>` tag, so knowing WHETHER it's set at all, not just its value,
 * is essential evidence), and its raw XML verbatim. */
export interface PricingStepOccurrenceDetail {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string | null;
  sequenceNumber: string | null;
  allBindings: RawParameterBinding[];
  rawXml: string;
}

function inspectPricingStepOccurrence(node: PhysicalStepNode): PricingStepOccurrenceDetail {
  return {
    occurrenceIndex: node.occurrenceIndex,
    pathLabel: node.pathLabel,
    name: node.name,
    parentStep: node.parentStep,
    sequenceNumber: node.sequenceNumber,
    allBindings: collectAllParameterBindings(node.full),
    rawXml: node.full,
  };
}

export function inspectDonorCandidate(fileName: string, xml: string): ExpressionSetDonorCandidate {
  const label = getTagValue(xml, "label") ?? ABSENT;
  const template = getTagValue(xml, "template") ?? ABSENT;
  const type = getTagValue(xml, "type") ?? ABSENT;
  const processType = getTagValue(xml, "processType") ?? ABSENT;
  const usageSubType = getTagValue(xml, "usageSubType") ?? ABSENT;
  const fullName = getTagValue(xml, "fullName") ?? deriveFallbackFullName(fileName);

  const graph = extractStepGraph(xml);
  const attributeDiscountNodes = graph.filter(n => n.actionType === "AttributeDiscount");
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const pricingSettingsOccurrences = pricingSettingsNodes.length;
  const listPriceOccurrences = listPriceNodes.length;
  const listPriceOccurrenceDetails = listPriceNodes.map(inspectPricingStepOccurrence);
  const pricingSettingsOccurrenceDetails = pricingSettingsNodes.map(inspectPricingStepOccurrence);
  const orderedActionTypes = graph.map(n => n.actionType).filter((v): v is string => !!v);
  const uniqueActionTypes = [...new Set(orderedActionTypes)];
  const rootBranches = graph.filter(n => n.depth === 0).map(n => ({ name: n.name, actionType: n.actionType }));
  const attributeDiscountBranches = attributeDiscountNodes.map(n => inspectAttributeDiscountBranch(graph, n));
  const rootOf = (b: AttributeDiscountBranchInspection) => b.physicalContainerAncestors[b.physicalContainerAncestors.length - 1] ?? b.parentStepChainAncestors[b.parentStepChainAncestors.length - 1] ?? "(root)";

  const { classification, reasons } = classifyDonor({
    uniqueActionTypes,
    attributeDiscountCount: attributeDiscountNodes.length,
    pricingSettingsCount: pricingSettingsOccurrences,
    listPriceCount: listPriceOccurrences,
    anyAttributeDiscountConnectedToListPrice: attributeDiscountBranches.some(b => b.connectedToListPrice),
    anyAttributeDiscountConnectedToPricingSettings: attributeDiscountBranches.some(b => b.connectedToPricingSettings),
  });

  return {
    fullName, fileName, label, template, type, processType, usageSubType,
    physicalStepCount: graph.length,
    attributeDiscountOccurrences: attributeDiscountNodes.length,
    pricingSettingsOccurrences, listPriceOccurrences,
    orderedActionTypes, uniqueActionTypes, rootBranches,
    attributeDiscountInMultipleBranches: new Set(attributeDiscountBranches.map(rootOf)).size > 1,
    classification, classificationReasons: reasons,
    attributeDiscountBranches,
    listPriceOccurrenceDetails, pricingSettingsOccurrenceDetails,
  };
}

export interface DonorCandidateRanking { fullName: string; score: number; reason: string }

export function rankCandidates(candidates: ExpressionSetDonorCandidate[]): DonorCandidateRanking[] {
  return candidates
    .filter(c => c.attributeDiscountOccurrences > 0)
    .map(c => {
      let score = 0;
      const reasons: string[] = [];
      if (c.classification === "ATTRIBUTE_BASED_PRICING_LIKELY") { score += 5; reasons.push("classified ATTRIBUTE_BASED_PRICING_LIKELY"); }
      else if (c.classification === "PRICING_PROCEDURE_LIKELY") { score += 3; reasons.push("classified PRICING_PROCEDURE_LIKELY"); }
      else if (c.classification === "SHARED_PRICING_PROCEDURE_LIKELY") { score += 1; reasons.push("classified SHARED_PRICING_PROCEDURE_LIKELY (large, many unrelated branches)"); }
      else { reasons.push(`classified ${c.classification}`); }

      // §Live-org fix — prefer STRONGER evidence: a branch proven via its own real <parentStep> name, via
      // genuine physical nesting, via a matching ListPrice input/output variable binding, or via the
      // shared PricingSettings price-waterfall variable, all outrank one whose only signal is declared
      // sequence-order (the weakest — "does not PROVE a data dependency," per `resolveConnectedAncestor`'s
      // own doc comment) — never picks a weakly-evidenced donor over a strongly-evidenced one. Computed
      // once here (not separately per target) so the unrelated-branch penalty below can be calibrated
      // against it.
      const listPriceBranches = c.attributeDiscountBranches.filter(b => b.connectedToListPrice);
      const waterfallBranches = c.attributeDiscountBranches.filter(b => b.connectedToPricingSettings && b.pricingSettingsConnection === "price-waterfall-variable");
      const bestMechanism = listPriceBranches.some(b => b.listPriceConnection === "parentStep-chain") ? "parentStep-chain"
        : listPriceBranches.some(b => b.listPriceConnection === "physical-nesting") ? "physical-nesting"
        : listPriceBranches.some(b => b.listPriceConnection === "variable-binding") ? "variable-binding"
        : waterfallBranches.length > 0 ? "price-waterfall-variable"
        : listPriceBranches.length > 0 ? "sequence-order"
        : "none";
      const connectivityScore = bestMechanism === "parentStep-chain" ? 5 : bestMechanism === "physical-nesting" ? 4
        : bestMechanism === "variable-binding" ? 3 : bestMechanism === "price-waterfall-variable" ? 3
        : bestMechanism === "sequence-order" ? 2 : 0;
      score += connectivityScore;
      if (bestMechanism === "none") reasons.push("no AttributeDiscount occurrence resolves to ListPrice or PricingSettings via any known mechanism");
      else reasons.push(`≥1 AttributeDiscount occurrence resolves to its pricing flow — strongest evidence: ${bestMechanism} (+${connectivityScore})`);

      const unrelatedCount = c.uniqueActionTypes.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t)).length;
      if (unrelatedCount > 0) {
        // §Live-org fix (Rev_Mgmt_Default_Pricing_Procedure2_V1) — this uncapped, per-unrelated-branch-type
        // penalty made it mathematically impossible for ANY donor with many unrelated branches to ever
        // clear `MINIMUM_TRUSTED_DONOR_SCORE`, regardless of how strong its OWN AttributeDiscount
        // connectivity evidence was — contradicting the floor's actual purpose (distrust WEAK evidence
        // bundled with many unrelated branches, not distrust STRONG evidence merely for being bundled).
        // Capped at 3 (the same "unrelated.length >= 3" threshold `classifyDonor` already uses to accept
        // "this IS a legitimately large shared procedure" as a real, expected shape) — but ONLY when the
        // best connectivity mechanism is stronger than the weakest tier (sequence-order); a donor whose
        // ONLY evidence is sequence-order keeps the FULL, uncapped penalty, since weak evidence bundled
        // with many unrelated branches is exactly the low-confidence shape this floor must keep rejecting
        // (see donorInspection.scoreFloor.test.ts's "Org B" regression).
        const penaltyCap = bestMechanism !== "sequence-order" && bestMechanism !== "none" ? 3 : Infinity;
        const penalty = Math.min(unrelatedCount, penaltyCap);
        score -= penalty;
        reasons.push(
          penalty < unrelatedCount
            ? `${unrelatedCount} unrelated pricing-type branch(es) present, capped at -${penalty} (strong connectivity evidence: ${bestMechanism})`
            : `${unrelatedCount} unrelated pricing-type branch(es) present (-${penalty})`,
        );
      }
      if (c.physicalStepCount <= 10) { score += 1; reasons.push(`small physical step count (${c.physicalStepCount}) — unlikely to be a large shared procedure (+1)`); }
      return { fullName: c.fullName, score, reason: reasons.join("; ") };
    })
    .sort((a, b) => b.score - a.score);
}

export interface ExpressionSetDonorInspectionResult {
  totalCandidates: number;
  /** §Renamed from the misleading `selectedByCurrentLogic` — this is NEVER what the real build selects.
   * It is simply "the first file (in whatever order the Metadata API happened to return) that contains
   * ANY occurrence of the target actionType," with ZERO connectivity gate — mirroring the dead
   * `findTemplateStepOccurrences()` purely for diagnostic/inventory purposes. The REAL, connectivity-gated
   * selection is `resolveAttributeBasedPricingDonor()`, called independently by `buildAttributeCanvas()` —
   * this field must never be read as "what was actually used." */
  firstFileContainingActionType: string | null;
  candidates: ExpressionSetDonorCandidate[];
  ranking: DonorCandidateRanking[];
  retrievalWarning?: string;
}

export interface MinimalPricingFoundationDonor {
  fullName: string;
  fileName: string;
  fullXml: string;
  candidate: ExpressionSetDonorCandidate;
}

/**
 * §Final architectural fix — selects the CLEAN, minimal donor to use as the base canvas for a
 * purpose-built Attribute-Based Pricing Expression Set: one that has PricingSettings AND ListPrice, but
 * ZERO AttributeDiscount occurrences (so it structurally cannot be one of the large shared/default
 * pricing procedures that bundle every pricing capability — those all have AttributeDiscount already,
 * per live evidence). Ties broken by smallest physical step count — never by name/label, since a real
 * org's naming convention is not something this codebase can assume. Reuses `inspectDonorCandidate`'s
 * existing classification signals entirely; invents no new detection logic.
 */
export async function selectMinimalPricingFoundationDonor(client: SalesforceClient): Promise<MinimalPricingFoundationDonor | null> {
  const { files } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
  const candidates = files.map(f => ({ file: f, candidate: inspectDonorCandidate(f.fileName, f.content) }));
  const eligible = candidates.filter(c =>
    c.candidate.pricingSettingsOccurrences > 0
    && c.candidate.listPriceOccurrences > 0
    && c.candidate.attributeDiscountOccurrences === 0,
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.candidate.physicalStepCount - b.candidate.physicalStepCount);
  const selected = eligible[0];
  return { fullName: selected.candidate.fullName, fileName: selected.file.fileName, fullXml: selected.file.content, candidate: selected.candidate };
}

export interface AttributeBasedPricingDonorSelection {
  fullName: string;
  fileName: string;
  fullXml: string;
  candidate: ExpressionSetDonorCandidate;
  /** Every donor that had ≥1 AttributeDiscount occurrence, ranked (same scoring `rankCandidates` already
   * uses for the read-only Phase 2 inspection) — kept for logging/diagnostics regardless of which one
   * was actually selected. */
  ranking: DonorCandidateRanking[];
  /** Occurrence indexes, WITHIN THIS donor's own graph, of every AttributeDiscount branch PROVEN (by real
   * evidence, not assumption — see `resolveConnection`'s 4-signal priority: `<parentStep>` chain, then
   * physical nesting, then a matching InputUnitPrice/published-output variable binding, then declared
   * sequence-order) to resolve back to a ListPrice step in this SAME graph — the only branches eligible to
   * be used, since only these are structurally connected to the pricing waterfall at all. */
  connectedAttributeDiscountOccurrenceIndexes: number[];
}

/**
 * §Root-cause fix — replaces the prior "clone AttributeDiscount from whichever donor happens to have one,
 * clone PricingSettings+ListPrice from a SEPARATE, unrelated minimal donor, then re-parent the extracted
 * branch to point at the other donor's ListPrice" architecture. That composed two structurally
 * DISCONNECTED graphs and required inventing a cross-donor `<parentStep>` link — exactly what produced
 * "Selected AttributeDiscount branch has no <parentStep> tag in its own fields" whenever the donor's
 * AttributeDiscount branch was itself a root step with no parentStep of its own to hijack.
 *
 * §Live-org fix — live evidence proved EVERY existing Attribute-Based donor in a real org can legitimately
 * have AttributeDiscount with an entirely EMPTY `<parentStep>` (these are genuinely deployed, org-native
 * Expression Sets, not malformed ones) — the named-chain signal alone was too strict and rejected every
 * real candidate. A SECOND org then proved `<parentStep>` can be non-empty but name a canvas-placement
 * `ListContainer` rather than ListPrice/PricingSettings, with no physical nesting either — the real
 * dependency there is expressed by AttributeDiscount's `InputUnitPrice` matching one specific ListPrice
 * occurrence's own published output. `resolveConnection` now recognizes physical nesting, that
 * input/output variable-binding match, and (as a last-resort, clearly weaker signal) declared
 * `<sequenceNumber>` ordering — all four are REAL facts already present in the donor's own XML; none is
 * invented, and a `<parentStep>` link is still NEVER written where the donor didn't already have the
 * relationship some other way.
 *
 * This selects exactly ONE donor whose OWN graph already contains PricingSettings + ListPrice +
 * AttributeDiscount, with at least one AttributeDiscount branch PROVEN (via one of the four real signals
 * above) to resolve back to that SAME donor's ListPrice step — i.e. an already-coherent, already-executable
 * pricing flow, never a hybrid assembled from unrelated donors. The caller (`canvasBuilder.ts`) then PRUNES this
 * one donor down to just the required occurrences (the target AttributeDiscount branch, its ancestors, and
 * its logical parentStep chain) via `pricingCanvasPruning.ts` — never rewrites `<parentStep>` to point
 * somewhere it was never bound to. Ranking reuses the exact same evidence-based scoring `rankCandidates`
 * already computes for the read-only Phase 2 inspection (classification, unrelated-branch penalty,
 * connected-to-ListPrice bonus, small-step-count bonus favoring a focused procedure over a giant shared
 * one) — never picks by name/label.
 */
export interface AttributeBasedPricingDonorResolution {
  selection: AttributeBasedPricingDonorSelection | null;
  /** Every candidate in the org with ≥1 AttributeDiscount occurrence — present whether or not any of them
   * were eligible, so a caller whose selection came back null (`selection === null`) can build a precise,
   * per-candidate "here's exactly why each one was rejected" diagnostic (§requirement: never fabricate a
   * connection, but never fail silently either — name exactly which Salesforce structure is missing)
   * without a second Salesforce round-trip. This is the SAME inventory a real Salesforce admin could
   * inspect in Setup — nothing here is synthesized. */
  candidatesWithAttributeDiscount: ExpressionSetDonorCandidate[];
  /** §Live-org fix (Org B) — populated ONLY when `selection === null` because every candidate that
   * proved a real ListPrice connection still scored below the confidence floor (e.g. it also carries
   * several unrelated shared-pricing branches that outweigh the connection bonus) — distinct from "no
   * candidate proved any connection at all" (§`buildNoCoherentDonorDiagnostic`'s normal case). Lets the
   * caller report the more precise "a connection was proven, but confidence was too low" reason instead
   * of the generic "nothing connects" message. */
  lowConfidenceCandidates?: DonorCandidateRanking[];
}

/** §Live-org fix (Org B) — Salesforce's own donor scoring can legitimately go negative for a candidate
 * that has SOME evidence of an AttributeDiscount->ListPrice connection but is dominated by unrelated
 * shared-pricing-branch penalties (`rankCandidates`'s `SHARED_SIGNAL_ACTION_TYPES` deduction). Selecting
 * "the least-bad of several untrustworthy donors" is exactly the bug report's "current code selects the
 * donor with a negative score" — a negative score is this codebase's own signal that it does NOT trust
 * the candidate, so a top score below this floor must never be silently accepted just because nothing
 * else beat it.
 */
const MINIMUM_TRUSTED_DONOR_SCORE = 0;

export async function resolveAttributeBasedPricingDonor(client: SalesforceClient): Promise<AttributeBasedPricingDonorResolution> {
  const { files } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
  const inspected = files.map(f => ({ file: f, candidate: inspectDonorCandidate(f.fileName, f.content) }));
  const candidatesWithAttributeDiscount = inspected.filter(e => e.candidate.attributeDiscountOccurrences > 0).map(e => e.candidate);

  // §Live-org fix (Rev_Mgmt_Default_Pricing_Procedure2_V1) — a candidate is also eligible when at least
  // one AttributeDiscount branch is proven connected to PricingSettings via the shared price-waterfall
  // variable (`price-waterfall-variable`), even when NEITHER of the donor's ListPrice branches is the
  // direct publisher of the value AttributeDiscount consumes. ListPrice's own presence is still separately
  // required (`listPriceOccurrences > 0` above) — this never claims eligibility for a donor that lacks a
  // ListPrice branch entirely, only recognizes a real, evidenced alternative path to the SAME pricing flow.
  const eligible = inspected.filter(({ candidate }) =>
    candidate.pricingSettingsOccurrences > 0
    && candidate.listPriceOccurrences > 0
    && candidate.attributeDiscountOccurrences > 0
    && candidate.attributeDiscountBranches.some(b => b.connectedToListPrice || b.connectedToPricingSettings),
  );
  if (eligible.length === 0) return { selection: null, candidatesWithAttributeDiscount };

  const ranking = rankCandidates(eligible.map(e => e.candidate));
  const top = ranking[0];
  if (top.score < MINIMUM_TRUSTED_DONOR_SCORE) {
    client.logDebug(
      "xml-diagnostic",
      `→ Donor rejected — every candidate with a proven ListPrice/PricingSettings connection still scored below the confidence floor (top: "${top.fullName}" scored ${top.score}, minimum trusted score is ${MINIMUM_TRUSTED_DONOR_SCORE}). ` +
      `Never selecting "the least-bad of several untrustworthy donors" — see the ranking below for exactly why each one was penalized.\n` +
      ranking.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n"),
    );
    return { selection: null, candidatesWithAttributeDiscount, lowConfidenceCandidates: ranking };
  }
  const selected = eligible.find(e => e.candidate.fullName === top.fullName)!;
  const connectedAttributeDiscountOccurrenceIndexes = selected.candidate.attributeDiscountBranches
    .filter(b => b.connectedToListPrice || b.connectedToPricingSettings)
    .map(b => b.occurrenceIndex);

  return {
    selection: {
      fullName: selected.candidate.fullName,
      fileName: selected.file.fileName,
      fullXml: selected.file.content,
      candidate: selected.candidate,
      ranking,
      connectedAttributeDiscountOccurrenceIndexes,
    },
    candidatesWithAttributeDiscount,
  };
}

/**
 * §Requirement: "STOP with a precise diagnostic explaining exactly which Salesforce structure is missing.
 * Do not fabricate XML." — for every AttributeDiscount-bearing candidate in the org (whether small/focused
 * or a large bundled procedure like a "Rev_Mgmt_Default..." style default), names its PricingSettings/
 * ListPrice/AttributeDiscount counts and, per AttributeDiscount branch, its exact `<parentStep>` value,
 * physical container ancestors, and BOTH resolved connection mechanisms (ListPrice/PricingSettings) — so a
 * human reading this can see precisely why every candidate was rejected, never just "none found."
 */
function formatBindingsBlock(bindings: RawParameterBinding[], indent: string): string[] {
  if (bindings.length === 0) return [`${indent}(no <parameters> found anywhere in this occurrence's own subtree)`];
  return bindings.map(b => `${indent}name=${b.name ?? "(none)"} | value=${b.value ?? "(none)"} | input=${b.input} | output=${b.output}`);
}

function formatPricingStepOccurrence(label: string, o: PricingStepOccurrenceDetail, indent: string): string[] {
  return [
    `${indent}${label} occurrence [${o.occurrenceIndex}] (${o.pathLabel}) — name=${o.name ?? "(none)"}`,
    `${indent}  <parentStep>: ${o.parentStep ?? "(none)"}`,
    `${indent}  <sequenceNumber>: ${o.sequenceNumber ?? "NOT SET — this occurrence can never be matched by the sequence-order mechanism, regardless of any other step's own sequenceNumber value"}`,
    `${indent}  All parameter bindings (unfiltered — every <parameters> block in this occurrence's subtree, not just the ones this resolver already knows to look for by name):`,
    ...formatBindingsBlock(o.allBindings, `${indent}    `),
    `${indent}  Raw XML:`,
    `${indent}    ${o.rawXml}`,
  ];
}

/**
 * §Requirement: "STOP with a precise diagnostic explaining exactly which Salesforce structure is missing.
 * Do not fabricate XML." — for every AttributeDiscount-bearing candidate in the org (whether small/focused
 * or a large bundled procedure like a "Rev_Mgmt_Default..." style default), names its PricingSettings/
 * ListPrice/AttributeDiscount counts and, per AttributeDiscount branch, its exact `<parentStep>` value,
 * physical container ancestors, and BOTH resolved connection mechanisms (ListPrice/PricingSettings) — so a
 * human reading this can see precisely why every candidate was rejected, never just "none found."
 *
 * §Live-org forensic diagnostics (Org B) — extended to dump the COMPLETE, unfiltered ground truth needed
 * to determine how THIS org actually expresses its ListPrice -> AttributeDiscount data flow, without
 * requiring a live Salesforce session to inspect it separately: every ListPrice/PricingSettings
 * occurrence's raw XML and full (unfiltered) parameter bindings, every AttributeDiscount occurrence's raw
 * XML/full bindings/sequenceNumber, the COMPLETE multi-hop <parentStep> chain (not just names — each
 * hop's own actionType/sequenceNumber/parentStep), and — critically — what each AttributeDiscount's OWN
 * immediate <parentStep> value actually resolves to in this donor's graph (name/actionType/sequenceNumber/
 * raw XML), independent of whether the broader chain walk reached a pricing step. This never changes
 * selection behavior by itself — it is diagnostic-only, so the exact real mechanism (if any exists beyond
 * the 4 already recognized) can be identified from genuine evidence rather than guessed.
 */
export function buildNoCoherentDonorDiagnostic(candidates: ExpressionSetDonorCandidate[]): string {
  if (candidates.length === 0) {
    return "No ExpressionSetDefinition in this org contains an AttributeDiscount step at all — there is nothing to clone from, and this action type cannot be authored from a blank canvas.";
  }
  const lines: string[] = [
    `${candidates.length} ExpressionSetDefinition(s) in this org contain an AttributeDiscount occurrence, but none has one PROVEN connected to its own ListPrice:`,
    "",
  ];
  for (const c of candidates) {
    lines.push(`Donor: ${c.fullName}`);
    lines.push(`  Classification: ${c.classification} (${c.classificationReasons.join(" ")})`);
    lines.push(`  PricingSettings x${c.pricingSettingsOccurrences}, ListPrice x${c.listPriceOccurrences}, AttributeDiscount x${c.attributeDiscountOccurrences}`);
    lines.push("");

    lines.push("  === PricingSettings occurrences (complete, unfiltered) ===");
    for (const o of c.pricingSettingsOccurrenceDetails) lines.push(...formatPricingStepOccurrence("PricingSettings", o, "  "));
    lines.push("");

    lines.push("  === ListPrice occurrences (complete, unfiltered — investigated INDEPENDENTLY, never collapsed) ===");
    for (const o of c.listPriceOccurrenceDetails) lines.push(...formatPricingStepOccurrence("ListPrice", o, "  "));
    lines.push("");

    lines.push("  === AttributeDiscount occurrences (complete, unfiltered) ===");
    for (const b of c.attributeDiscountBranches) {
      lines.push(`  AttributeDiscount occurrence [${b.occurrenceIndex}] (${b.pathLabel}) — name=${b.name ?? "(none)"}:`);
      lines.push(`    <parentStep>: ${b.parentStep ?? "(none)"}`);
      lines.push(`    <sequenceNumber>: ${b.sequenceNumber ?? "NOT SET"}`);
      lines.push(`    Physical container ancestors: ${b.physicalContainerAncestors.join(" -> ") || "(none — this is a root step)"}`);
      lines.push(`    Full <parentStep> chain (every hop's real facts, not just names): ${
        b.parentStepChainDetail.length > 0
          ? b.parentStepChainDetail.map(h => `${h.name ?? "(unnamed)"} [actionType=${h.actionType ?? "(none)"}, sequenceNumber=${h.sequenceNumber ?? "(none)"}, parentStep=${h.parentStep ?? "(none)"}]`).join(" -> ")
          : "(empty — " + b.parentStepChainNote + ")"
      }`);
      if (b.parentStepTarget) {
        lines.push(
          b.parentStepTarget.found
            ? `    Immediate <parentStep> target "${b.parentStepTarget.name}" resolves to: actionType=${b.parentStepTarget.actionType ?? "(none)"}, sequenceNumber=${b.parentStepTarget.sequenceNumber ?? "(none)"}, its own parentStep=${b.parentStepTarget.parentStep ?? "(none)"}` +
              (b.parentStepTarget.actionType !== "ListPrice" && b.parentStepTarget.actionType !== "PricingSettings"
                ? ` — NOT itself a pricing calculation step; this is a ${b.parentStepTarget.actionType ?? "(untyped)"} element (likely canvas placement/grouping, not proof of a data dependency on its own — see whether ITS OWN parentStep/sequenceNumber continues the chain to a real pricing step above).`
                : ".")
            : `    Immediate <parentStep> target "${b.parentStepTarget.name}" does NOT match any physical <steps> node in this donor's graph at all — either a dangling reference, or this name belongs to a metadata construct not modeled as a <steps> element (e.g. a canvas-only grouping construct).`,
        );
        if (b.parentStepTarget.rawXml) lines.push(`    Immediate <parentStep> target raw XML: ${b.parentStepTarget.rawXml}`);
      } else {
        lines.push("    No <parentStep> at all on this occurrence.");
      }
      lines.push(`    InputUnitPrice: ${b.bindings.inputUnitPrice ?? "(none)"}`);
      lines.push("    All parameter bindings (unfiltered):");
      lines.push(...formatBindingsBlock(b.allBindings, "      "));
      lines.push(`    ListPrice connection: ${b.listPriceConnection}`);
      lines.push(`    PricingSettings connection: ${b.pricingSettingsConnection}`);
      lines.push(`    Raw XML: ${b.rawXml}`);
    }
    lines.push("");
  }
  lines.push(
    "None of the above resolves via any of the 4 recognized real mechanisms (an explicit <parentStep> chain, physical nesting, a matching InputUnitPrice/published-output variable binding, or declared sequence order). "
    + "A Salesforce admin must configure and successfully activate at least one genuinely working Attribute-Based Pricing procedure in this org (Setup > Revenue Cloud > Pricing Procedures) before this tool can clone one — this codebase will never fabricate the AttributeDiscount/ListPrice relationship or merge it from an unrelated donor. "
    + "The complete raw XML/bindings above are printed so a genuinely new, real connection mechanism can be identified and implemented from actual evidence, never guessed or invented.",
  );
  return lines.join("\n");
}

export async function inspectAllExpressionSetDefinitionDonors(
  client: SalesforceClient,
  targetActionType: string,
): Promise<ExpressionSetDonorInspectionResult> {
  const { files, warning } = await retrieveVersionScopedExpressionSetDefinitionFiles(client, ["*"]);
  const candidates = files.map(f => inspectDonorCandidate(f.fileName, f.content));

  const selectedFile = files.find(f => extractStepGraph(f.content).some(n => n.actionType === targetActionType));
  const firstFileContainingActionType = selectedFile
    ? (getTagValue(selectedFile.content, "fullName") ?? deriveFallbackFullName(selectedFile.fileName))
    : null;

  return {
    totalCandidates: candidates.length,
    firstFileContainingActionType,
    candidates,
    ranking: rankCandidates(candidates),
    retrievalWarning: warning,
  };
}
