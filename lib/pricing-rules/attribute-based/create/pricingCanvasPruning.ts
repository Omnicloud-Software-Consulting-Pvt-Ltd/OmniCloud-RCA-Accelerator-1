/**
 * §Defect 2 fix — pruning must run BEFORE structural validation, and validation must run against the
 * EXACT bytes that get deployed, never the original 76-step donor clone. This module now exposes its
 * reachability analysis and physical-removal step as SEPARATE, reusable pieces (`computeRequiredOccurrenceIndexes`
 * / `pruneXmlToRequiredOccurrences`) so `canvasBuilder.ts` can prune BOTH the generated tree AND filter its
 * own donor-comparison baseline to the SAME kept-occurrence set, before any of its existing occurrence-index-
 * aligned validators (`validateParentStepReferences`, `computeIdentityFieldDrift`, `checkUnrelatedBranchIntegrity`)
 * ever run — those validators are NOT rewritten; they simply now receive pruned, still-aligned input instead
 * of the full clone. `pruneToPricingRelevantSubtree` (the original all-in-one entry point) is kept for any
 * caller that only has the assembled XML and no donor graph to keep aligned.
 *
 * §Defect 2 — no silent fallback on a genuine dangling reference. `findDanglingParentStepReferences` is a
 * pure, unconditional check with no "give up and return the original" behavior of its own — the CALLER
 * decides what to do with a non-empty result. `canvasBuilder.ts` treats a non-empty result as fatal, per
 * explicit instruction: silently redeploying the original 76-step donor after pruning has been attempted
 * would defeat the entire point of this fix, since it hides the actual defect instead of surfacing it.
 *
 * Only ever removes an ENTIRE root branch, never a mid-tree slice — the exact class of operation that
 * caused the original `ExpressionSetStep.getParentStep()` NPE was deleting containers that something
 * else's `<parentStep>` still pointed at. Removing only root branches with zero incoming references from
 * anything kept structurally cannot reproduce that.
 */
import { extractStepGraph, getTagValue, type PhysicalStepNode } from "./xmlBlocks";

export interface PrunedRootBranch {
  rootOccurrenceIndex: number;
  name: string | null;
  actionType: string | null;
  physicalStepCount: number;
}

export interface KeptRootBranch {
  rootOccurrenceIndex: number;
  name: string | null;
  actionType: string | null;
  reason: string;
}

export interface DanglingReference {
  occurrenceIndex: number;
  pathLabel: string;
  name: string | null;
  parentStep: string;
  /** Which occurrence (in the graph passed to `findDanglingParentStepReferences`, e.g. the PRE-prune
   * generated graph) this `parentStep` name resolved to before pruning — null if it never resolved to
   * anything even before pruning (a pre-existing donor issue, not something pruning caused). */
  expectedDonorOccurrenceIndex: number | null;
}

function subtreeOccurrenceIndexes(graph: PhysicalStepNode[], root: PhysicalStepNode): number[] {
  const out: number[] = [];
  const byParent = new Map<number, PhysicalStepNode[]>();
  for (const n of graph) {
    if (n.parentOccurrenceIndex === null) continue;
    const list = byParent.get(n.parentOccurrenceIndex) ?? [];
    list.push(n);
    byParent.set(n.parentOccurrenceIndex, list);
  }
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node.occurrenceIndex);
    for (const child of byParent.get(node.occurrenceIndex) ?? []) stack.push(child);
  }
  return out;
}

/**
 * Walks the LOGICAL `<parentStep>` NAME chain upward from `start`, exactly like `canvasBuilder.ts`'s own
 * `walkParentChain` (independent re-implementation, same proven-unique-lookup discipline — a name that
 * doesn't resolve to exactly one step stops the walk rather than guessing) — every node visited (and its
 * own physical ancestors) is added to `required`.
 */
function markLogicalParentChainRequired(graph: PhysicalStepNode[], start: PhysicalStepNode, required: Set<number>): void {
  const byOccurrence = new Map(graph.map(n => [n.occurrenceIndex, n]));
  const visitedNames = new Set<string>();
  let currentName = start.parentStep;
  while (currentName) {
    if (visitedNames.has(currentName)) break;
    visitedNames.add(currentName);
    const matches = graph.filter(n => n.name === currentName);
    if (matches.length !== 1) break;
    const node = matches[0];
    required.add(node.occurrenceIndex);
    let ancestor = node.parentOccurrenceIndex;
    while (ancestor !== null) {
      required.add(ancestor);
      ancestor = byOccurrence.get(ancestor)?.parentOccurrenceIndex ?? null;
    }
    currentName = node.parentStep;
  }
}

/**
 * §ListGroup completeness (live evidence — Salesforce deploy rejection "Select list filter as the first
 * element in list group. Please remove Attribute Discount Entries.") — a hash-verified capture of the real
 * donor's raw XML proved a `<stepType>ListGroup</stepType>` container is an ATOMIC structural unit in
 * Salesforce's schema: ALL 21 ListGroup containers in this donor share the exact same shape — an
 * `AdvancedListFilter` step at `sequenceNumber` 1 (the "list filter" Salesforce's error refers to), followed
 * by the container's real pricing/business-logic step(s) — with zero exceptions across AttributeDiscount,
 * BundleDiscount, VolumeDiscount, VolumeTierDiscount, ManualDiscount, FormulaBasedPricing, and more.
 *
 * `computeRequiredOccurrenceIndexes`'s reachability walk only follows a target UPWARD: its own subtree, its
 * physical ancestors, and its logical `<parentStep>` NAME chain. It has no notion of "this container's OTHER
 * children must survive too." When AttributeDiscount's `<parentStep>` chain passes through a ListGroup
 * (`ListContainer27`), that container's `AdvancedListFilter` SIBLING (also declaring
 * `<parentStep>ListContainer27</parentStep>`, but never an ancestor or descendant of AttributeDiscount) was
 * pruned away as an "unrelated root branch" — leaving the ListGroup with AttributeDiscount as its ONLY
 * (and therefore first) child, exactly the malformed shape Salesforce rejected.
 *
 * Whenever a required occurrence's `<parentStep>` resolves to a ListGroup-typed container, this marks EVERY
 * other step declaring that SAME `<parentStep>` name as required too (plus their own physical ancestors) —
 * treating the ListGroup's full, real child set as one atomic unit, exactly like a root branch is already
 * never split mid-tree. Fixed-point (like `computeRequiredOccurrenceIndexes`'s own root-promotion loop)
 * because a newly-required sibling could itself sit under another ListGroup that then also needs completing.
 */
function markListGroupSiblingsRequired(graph: PhysicalStepNode[], required: Set<number>): void {
  const byOccurrence = new Map(graph.map(n => [n.occurrenceIndex, n]));
  const byParentStepName = new Map<string, PhysicalStepNode[]>();
  for (const n of graph) {
    if (!n.parentStep) continue;
    const list = byParentStepName.get(n.parentStep) ?? [];
    list.push(n);
    byParentStepName.set(n.parentStep, list);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const occ of [...required]) {
      const node = byOccurrence.get(occ);
      if (!node?.parentStep) continue;
      const parentMatches = graph.filter(n => n.name === node.parentStep);
      if (parentMatches.length !== 1 || getTagValue(parentMatches[0].content, "stepType") !== "ListGroup") continue;
      for (const sibling of byParentStepName.get(node.parentStep) ?? []) {
        if (required.has(sibling.occurrenceIndex)) continue;
        required.add(sibling.occurrenceIndex);
        changed = true;
        let ancestor = sibling.parentOccurrenceIndex;
        while (ancestor !== null) {
          if (!required.has(ancestor)) { required.add(ancestor); changed = true; }
          ancestor = byOccurrence.get(ancestor)?.parentOccurrenceIndex ?? null;
        }
      }
    }
  }
}

export interface RequiredOccurrenceComputation {
  required: Set<number>;
  removedRootBranches: PrunedRootBranch[];
  keptRootBranches: KeptRootBranch[];
}

/**
 * §Core reachability analysis, extracted for reuse — marks as "required": the target occurrence's own
 * subtree, its physical container ancestors, every step on its LOGICAL `<parentStep>` chain (plus THEIR
 * ancestors), any EXPLICITLY-supplied additional occurrence (plus THEIR physical ancestors — see
 * `additionalRequiredOccurrenceIndexes` below), and any root branch a REQUIRED step's own `<parentStep>`
 * still resolves into by name (the actual proof a branch is genuinely referenced, not an assumption).
 * Returns `null` if `targetOccurrenceIndex` doesn't exist in `graph` at all.
 *
 * @param additionalRequiredOccurrenceIndexes §Live-org fix — this reachability walk only understands TWO
 * of the three real connection mechanisms this codebase now recognizes (physical nesting via
 * `parentOccurrenceIndex`, and the logical `<parentStep>` name chain); it has no way to know about a THIRD
 * step being required purely because `donorInspection.ts`'s `resolveConnectedAncestor` proved a
 * sequence-order connection to it. Without this parameter, a donor whose ListPrice/PricingSettings are only
 * connected to AttributeDiscount via declared sequence order (no `<parentStep>`, no nesting — the exact
 * live-org shape this fix targets) would have its OWN ListPrice/PricingSettings wrongly pruned away as
 * "unrelated root branches," directly undoing the donor-selection stage's proof. Callers that already
 * resolved a step via ANY mechanism (not just the two this function understands on its own) must pass its
 * occurrence index here so it — and its own physical ancestors — are never removed.
 */
export function computeRequiredOccurrenceIndexes(
  graph: PhysicalStepNode[], targetOccurrenceIndex: number, additionalRequiredOccurrenceIndexes: number[] = [],
): RequiredOccurrenceComputation | null {
  const target = graph.find(n => n.occurrenceIndex === targetOccurrenceIndex);
  if (!target) return null;

  const required = new Set<number>(subtreeOccurrenceIndexes(graph, target));
  const byOccurrence = new Map(graph.map(n => [n.occurrenceIndex, n]));
  let ancestor = target.parentOccurrenceIndex;
  while (ancestor !== null) {
    required.add(ancestor);
    ancestor = byOccurrence.get(ancestor)?.parentOccurrenceIndex ?? null;
  }
  markLogicalParentChainRequired(graph, target, required);

  for (const idx of additionalRequiredOccurrenceIndexes) {
    const node = byOccurrence.get(idx);
    if (!node) continue;
    required.add(idx);
    let a = node.parentOccurrenceIndex;
    while (a !== null) {
      required.add(a);
      a = byOccurrence.get(a)?.parentOccurrenceIndex ?? null;
    }
  }

  // §ListGroup completeness — see `markListGroupSiblingsRequired`'s own doc comment. Must run after every
  // other way a step can become required (subtree/ancestors/logical chain/explicit additions) and before
  // root-branch classification below, so a sibling this pulls in correctly keeps its OWN root branch too.
  markListGroupSiblingsRequired(graph, required);

  const roots = graph.filter(n => n.depth === 0);
  const rootSubtree = new Map<number, number[]>();
  const rootIsRequired = new Map<number, boolean>();
  for (const root of roots) {
    const occs = subtreeOccurrenceIndexes(graph, root);
    rootSubtree.set(root.occurrenceIndex, occs);
    rootIsRequired.set(root.occurrenceIndex, occs.some(o => required.has(o)));
  }

  const rootOfOccurrence = new Map<number, number>();
  for (const root of roots) for (const o of rootSubtree.get(root.occurrenceIndex)!) rootOfOccurrence.set(o, root.occurrenceIndex);
  const nameToOccurrences = new Map<string, number[]>();
  for (const n of graph) {
    if (!n.name) continue;
    const list = nameToOccurrences.get(n.name) ?? [];
    list.push(n.occurrenceIndex);
    nameToOccurrences.set(n.name, list);
  }
  const promotedToRequired = new Set<number>();
  // §Fixed-point iteration — a root promoted to required on pass N can itself reference a THIRD root by
  // name, which must also be promoted; repeats until nothing new is promoted, never just one pass.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [rootOcc, isReq] of rootIsRequired) {
      if (!isReq) continue;
      for (const occ of rootSubtree.get(rootOcc)!) {
        const node = byOccurrence.get(occ);
        if (!node?.parentStep) continue;
        for (const targetOcc of nameToOccurrences.get(node.parentStep) ?? []) {
          const targetRoot = rootOfOccurrence.get(targetOcc);
          if (targetRoot !== undefined && !rootIsRequired.get(targetRoot)) {
            rootIsRequired.set(targetRoot, true);
            promotedToRequired.add(targetRoot);
            changed = true;
          }
        }
      }
    }
  }
  // Every occurrence inside a required root is itself required (a root can be required without every one
  // of its occurrences having been individually marked above, e.g. purely via promotion).
  for (const [rootOcc, isReq] of rootIsRequired) {
    if (!isReq) continue;
    for (const occ of rootSubtree.get(rootOcc)!) required.add(occ);
  }

  const removedRootBranches = roots.filter(r => !rootIsRequired.get(r.occurrenceIndex)).map(r => ({
    rootOccurrenceIndex: r.occurrenceIndex, name: r.name, actionType: r.actionType, physicalStepCount: rootSubtree.get(r.occurrenceIndex)!.length,
  }));
  const keptRootBranches = roots.filter(r => rootIsRequired.get(r.occurrenceIndex)).map(r => ({
    rootOccurrenceIndex: r.occurrenceIndex, name: r.name, actionType: r.actionType,
    reason: promotedToRequired.has(r.occurrenceIndex) ? "kept: a required step's <parentStep> chain resolves into this branch" : "kept: contains the target occurrence or its ancestors/logical dependencies",
  }));

  return { required, removedRootBranches, keptRootBranches };
}

/** Physically removes every root branch in `removedRootBranches` from `xml`, end-to-start so offsets stay valid. */
export function pruneXmlToRequiredOccurrences(xml: string, removedRootBranches: PrunedRootBranch[], graph: PhysicalStepNode[]): string {
  const roots = graph.filter(n => n.depth === 0);
  const removedSet = new Set(removedRootBranches.map(r => r.rootOccurrenceIndex));
  const toRemove = roots.filter(r => removedSet.has(r.occurrenceIndex));
  let out = xml;
  for (const r of [...toRemove].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out;
}

/**
 * §PARENTSTEP SAFETY — pure, unconditional check: for every node in `graph` (normally the PRUNED,
 * freshly re-extracted graph — never the pre-prune one), does its `<parentStep>` name resolve to a
 * `<name>` that still exists SOMEWHERE in `graph`? No fallback behavior lives here; the caller decides
 * what a non-empty result means. `preprunGraph` (optional) is used ONLY to populate
 * `expectedDonorOccurrenceIndex` for diagnostics — never to decide whether something is dangling.
 */
export function findDanglingParentStepReferences(graph: PhysicalStepNode[], preprunGraph?: PhysicalStepNode[]): DanglingReference[] {
  const nameSet = new Set(graph.map(n => n.name).filter((v): v is string => !!v));
  const preprunByName = new Map<string, number>();
  if (preprunGraph) {
    for (const n of preprunGraph) {
      if (n.name && !preprunByName.has(n.name)) preprunByName.set(n.name, n.occurrenceIndex);
    }
  }
  return graph
    .filter(n => n.parentStep && !nameSet.has(n.parentStep))
    .map(n => ({
      occurrenceIndex: n.occurrenceIndex, pathLabel: n.pathLabel, name: n.name, parentStep: n.parentStep as string,
      expectedDonorOccurrenceIndex: preprunByName.get(n.parentStep as string) ?? null,
    }));
}

export interface PruneToPricingRelevantSubtreeResult {
  finalXml: string;
  /** False whenever pruning could not be safely applied — `finalXml` is then the ORIGINAL, unpruned,
   * already-working input, never a partially-pruned or broken tree. */
  pruned: boolean;
  skippedReason?: string;
  removedRootBranches: PrunedRootBranch[];
  keptRootBranches: KeptRootBranch[];
  danglingReferencesFound: DanglingReference[];
  finalPhysicalStepCount: number;
  finalOrderedActionTypes: string[];
  finalUniqueActionTypes: string[];
}

function actionTypesOf(nodes: PhysicalStepNode[]): { ordered: string[]; unique: string[] } {
  const ordered = nodes.map(n => n.actionType).filter((v): v is string => !!v);
  return { ordered, unique: [...new Set(ordered)] };
}

/**
 * §All-in-one convenience entry point for a caller that only has assembled XML and no donor graph of its
 * own to keep aligned (e.g. a standalone diagnostic). `canvasBuilder.ts` does NOT use this directly — it
 * calls `computeRequiredOccurrenceIndexes` + `pruneXmlToRequiredOccurrences` itself so it can filter its
 * own donor-comparison baseline to the identical kept-set. Unlike `canvasBuilder.ts`'s own usage, THIS
 * entry point still falls back to the unpruned tree on a dangling reference — appropriate only for a
 * caller with no better hard-fail path of its own.
 */
export function pruneToPricingRelevantSubtree(finalFileXml: string, targetOccurrenceIndex: number): PruneToPricingRelevantSubtreeResult {
  const graph = extractStepGraph(finalFileXml);

  const computation = computeRequiredOccurrenceIndexes(graph, targetOccurrenceIndex);
  if (!computation) {
    const { ordered, unique } = actionTypesOf(graph);
    return {
      finalXml: finalFileXml, pruned: false, skippedReason: `Target occurrence index ${targetOccurrenceIndex} was not found in the generated tree — pruning skipped, deploying the full tree unpruned.`,
      removedRootBranches: [], keptRootBranches: [], danglingReferencesFound: [],
      finalPhysicalStepCount: graph.length, finalOrderedActionTypes: ordered, finalUniqueActionTypes: unique,
    };
  }
  const { removedRootBranches, keptRootBranches } = computation;

  if (removedRootBranches.length === 0) {
    const { ordered, unique } = actionTypesOf(graph);
    return {
      finalXml: finalFileXml, pruned: false, skippedReason: "Every root branch is required (directly or via a proven <parentStep> dependency) — nothing could be safely removed.",
      removedRootBranches: [], keptRootBranches,
      danglingReferencesFound: [], finalPhysicalStepCount: graph.length, finalOrderedActionTypes: ordered, finalUniqueActionTypes: unique,
    };
  }

  const prunedXml = pruneXmlToRequiredOccurrences(finalFileXml, removedRootBranches, graph);
  const prunedGraph = extractStepGraph(prunedXml);
  const dangling = findDanglingParentStepReferences(prunedGraph, graph);

  if (dangling.length > 0) {
    const { ordered, unique } = actionTypesOf(graph);
    return {
      finalXml: finalFileXml, pruned: false,
      skippedReason: `Pruning would have created ${dangling.length} dangling <parentStep> reference(s) — aborted; deploying the full tree unpruned instead.`,
      removedRootBranches: [], keptRootBranches: [...keptRootBranches, ...removedRootBranches.map(r => ({ rootOccurrenceIndex: r.rootOccurrenceIndex, name: r.name, actionType: r.actionType, reason: "pruning aborted" }))],
      danglingReferencesFound: dangling, finalPhysicalStepCount: graph.length, finalOrderedActionTypes: ordered, finalUniqueActionTypes: unique,
    };
  }

  const { ordered, unique } = actionTypesOf(prunedGraph);
  return {
    finalXml: prunedXml, pruned: true,
    removedRootBranches, keptRootBranches,
    danglingReferencesFound: [], finalPhysicalStepCount: prunedGraph.length, finalOrderedActionTypes: ordered, finalUniqueActionTypes: unique,
  };
}
