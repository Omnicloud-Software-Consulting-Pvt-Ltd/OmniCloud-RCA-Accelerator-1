/**
 * Attribute-based pricing canvas builder — clone-and-patch, never
 * build-from-scratch, never rebuild-from-a-partial-step-list, and never key
 * step identity by `<name>`. `AttributeDiscount` is a real
 * BusinessKnowledgeModel action type that is not scriptable on a blank
 * canvas in Revenue Cloud (its legal enum values are org-configured); the
 * only reliable way to get a correctly-configured step is to clone one from
 * an already-working Expression Set in the connected org and patch out the
 * product-specific parts.
 *
 * §Occurrence-based identity — live donor evidence proved `<name>` is NOT a
 * unique identifier in this metadata: physically distinct nodes across
 * unrelated pricing-type branches (FormulaBasedPricing, ManualDiscount,
 * Proration, SubscriptionPricing, VolumeTierDiscount, BundleDiscount,
 * DerivedPricing, AttributeDiscount) legitimately share conventional names
 * like "PriceAdjustmentScheduleId"/"Quantity"/"EffectiveFrom" for their own
 * per-branch sub-steps. A name-keyed comparison (e.g. a `Map<name, ...>` or
 * `.find(s => s.name === x)`) silently collapses distinct physical nodes
 * into one entry, comparing unrelated generated nodes against whichever
 * donor node happened to be seen last for that name — this is what produced
 * the "nonsense" mismatches (unrelated branches appearing to have changed
 * parentStep) in the prior version of this file. Every donor/generated
 * comparison here is now occurrence-index-based (`extractStepGraph`, see
 * xmlBlocks.ts) — donor and generated graphs are positionally aligned by
 * `occurrenceIndex`, which is guaranteed stable as long as the splice
 * strategy below only ever replaces the CONTENT of one physical node's span,
 * never adding/removing a `<steps>` tag anywhere. `<name>` is used only for
 * two things that are inherently name-based by Salesforce's own design: (1)
 * confirming a `<parentStep>` reference exists SOMEWHERE (Salesforce's own
 * resolution is an exact-name lookup — existence, never identity), and (2)
 * a proven-unique lookup (verified via an explicit count check) when
 * resolving the real donor parent chain — never trusted blindly.
 *
 * §Single-donor, prune-to-required architecture — exactly ONE donor is used, selected because its OWN
 * graph already contains PricingSettings + ListPrice + AttributeDiscount as a coherent, connected flow
 * (`resolveAttributeBasedPricingDonor`, donorInspection.ts) — never a hybrid stitched from two unrelated
 * donors (a prior version of this file did that, extracting AttributeDiscount from one donor and
 * PricingSettings/ListPrice from a separate "minimal" donor, then trying to re-parent the extracted branch
 * to point at the other donor's ListPrice; that produced a structurally disconnected graph and, whenever
 * the extracted branch had no `<parentStep>` of its own to hijack, a hard failure). The selected
 * AttributeDiscount occurrence's own `<steps>` span is patched in place, at its exact original position in
 * the donor tree; every step this branch's real `<parentStep>` chain (and physical ancestry) depends on —
 * which already includes PricingSettings/ListPrice, since the donor was only selected because that
 * connection is proven — is kept byte-for-byte untouched, and every OTHER root branch the donor bundles
 * (FormulaBasedPricing/ManualDiscount/etc.) is pruned away entirely (`pricingCanvasPruning.ts`). PricingSettings
 * and ListPrice are used 100% verbatim from the donor — nothing about them is ever patched.
 *
 * §Pricing-waterfall binding — this codebase previously assumed
 * AttributeDiscount's `InputUnitPrice` must be forced to a literal
 * `"NetUnitPrice"` binding. Live donor inspection proved that assumption
 * wrong (the real donor's ListPrice publishes org-specific outputs like
 * `ItemContractPrice`, never `NetUnitPrice`). Both ListPrice's output
 * Parameter(s) and AttributeDiscount's `InputUnitPrice` are therefore left
 * completely unpatched — the donor's own, already-working binding is
 * preserved verbatim — and validation only CONFIRMS self-consistency
 * (`InputUnitPrice` already equals one of ListPrice's real output values),
 * searched recursively through the WHOLE selected branch (not assumed to be
 * a direct child of the outer step), never inventing or forcing a name.
 *
 * Deviation from a hardcoded "known product attribute names" list: rather
 * than guessing the donor org's actual attribute names (Display/Storage/
 * etc — genuinely unknowable without that org), Patch A generalizes the
 * same intent structurally: any INPUT parameter whose name isn't one of
 * the small set of generic bindings this engine actually supports
 * (RECOGNIZED_PARAM_NAMES) is stripped, exactly like a hardcoded literal
 * attribute-name parameter would be. `InputUnitPrice` is explicitly exempt
 * from this stripping, regardless of its bound value — see above. Every
 * patch is scoped to AttributeDiscount's OWN fields only (never a nested
 * child's, if it has any) — see `splitOwnFromNested`.
 */
import { createHash } from "node:crypto";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { normalizeApiVersionNumber } from "@/lib/salesforce/client";
import {
  type PhysicalStepNode,
  extractStepGraph,
  extractFlatBlocks,
  extractCustomElementBlocks,
  getTagValue,
  getAllTagValues,
  getTopLevelParameterBlocks,
  removeTopLevelParameters,
  buildParameterBlock,
  isOutputParam,
  isInputParam,
  getParamName,
  getParamValue,
  setParamValue,
  escapeXml,
} from "./xmlBlocks";
import {
  compareExpressionSetSchema,
  compareStepStructure,
  type StepStructureReport,
  type ParentStepValidationEntry,
} from "./schemaDiff";
import {
  findDanglingParentStepReferences,
  computeRequiredOccurrenceIndexes,
  pruneXmlToRequiredOccurrences,
} from "./pricingCanvasPruning";
import { SHARED_SIGNAL_ACTION_TYPES, resolveAttributeBasedPricingDonor, resolveConnectedAncestor, buildNoCoherentDonorDiagnostic } from "./donorInspection";
import { injectVersionNumberAndRank } from "./versionEnvelopeFields";

/* ── Constants (framework-level context variable names — safe to hardcode; NOT product/org-specific literals) ── */

const ABP_STANDARD_CTX = new Set([
  "NetUnitPrice", "ListPrice", "Product", "Product2Id",
  "ProductSellingModel", "SellingModelType",
  "LineItemQuantity", "Quantity",
  "PriceAdjustmentSchedule", "PriceAdjustmentScheduleId",
  "PriceAdjustmentScheduleName", "PriceAdjustmentScheduleIds", "PriceAdjustmentScheduleType",
  "EffectiveDate", "EffectiveFrom", "EffectiveTo", "PricingDate", "StartDate", "EndDate",
  "LineItem", "DerivedPricingAttribute", "ItemContract",
  "price_water_fall", "ItemNetTotalPrice",
  "Attribute", "AttributeValue", "PriceImpactingAttribute",
  "Constant_AdjustmentType_Attribute_Based", "Constant_AdjustmentValue_Attribute_Based",
  "AdjustmentType", "AdjustmentValue", "ItemContractAttributePasId",
]);

const RCA_NATIVE_CTX = new Set([
  "Attribute", "AttributeValue", "PriceImpactingAttribute",
  "AdjustmentType", "AdjustmentValue", "ItemContractAttributePasId",
  "NetUnitPrice", "ListPrice", "Product2Id", "ProductSellingModel",
  "LineItemQuantity", "PricingDate", "EffectiveFrom", "EffectiveTo",
  "PriceAdjustmentScheduleId", "PriceAdjustmentSchedule",
]);

/** The generic bindings this engine actually knows how to wire — see the file-level "Deviation" note above. */
const RECOGNIZED_PARAM_NAMES = new Set([
  "InputUnitPrice", "EffectiveFrom", "EffectiveTo", "Quantity",
  "PriceAdjustmentScheduleId", "PriceAdjustmentScheduleName", "PriceAdjustmentScheduleIds", "PriceAdjustmentScheduleType",
  "AttributeName", "AttributeValue", "IsPriceImpacting", "AdjustmentTypeField", "AdjustmentValueField",
]);

interface AdMapping {
  paramName: string;
  ctxVar: string;
  requiresVarCheck?: boolean;
}

const AD_MAPPINGS: AdMapping[] = [
  { paramName: "EffectiveFrom", ctxVar: "PricingDate" },
  { paramName: "EffectiveTo", ctxVar: "PricingDate" },
  { paramName: "Quantity", ctxVar: "LineItemQuantity" },
  // InputUnitPrice is intentionally NOT mapped/forced here — the donor's own binding (whatever real
  // output name it actually references in this org) is preserved verbatim. See the file-level
  // "Pricing-waterfall binding" note.
  // PriceAdjustmentScheduleId is intentionally NOT normalized here — Patch C
  // owns its exact shape (verbatim clone from the template, or a synthetic
  // fallback only if the template never had it at all). Re-normalizing it
  // here would overwrite that carefully-preserved block.
  { paramName: "AttributeName", ctxVar: "Attribute", requiresVarCheck: true },
  { paramName: "AttributeValue", ctxVar: "AttributeValue", requiresVarCheck: true },
  { paramName: "IsPriceImpacting", ctxVar: "PriceImpactingAttribute", requiresVarCheck: true },
  { paramName: "AdjustmentTypeField", ctxVar: "AdjustmentType", requiresVarCheck: true },
  { paramName: "AdjustmentValueField", ctxVar: "AdjustmentValue", requiresVarCheck: true },
];

const ATTR_REQUIRED_ACTION_TYPES = new Set(["PricingSettings", "ListPrice", "AttributeDiscount"]);
const ATTR_BLOCKED_ACTION_TYPES = new Set(["PriceBookEntry", "ListContainer", "ListOperation", "AttributeBasedPrice"]);

/**
 * §Semantic multi-output selection — live evidence proved a real base donor can publish MORE than one
 * ListPrice output (e.g. `[PriceBookEntryId, IsDerived, UnitPrice, SubTotal]`), so "exactly one output is
 * the only safe target" is no longer sufficient on its own. Priority order for selecting AMONG values
 * ListPrice genuinely publishes — never an invented name, never array position: "UnitPrice" first (this
 * org's real, documented Revenue Cloud unit-price output), falling back to "NetUnitPrice"/"ListPrice"
 * only if genuinely published under those exact names. `PriceBookEntryId`/`IsDerived`/`SubTotal` are never
 * selected — they carry no price-semantic meaning (a lookup Id, a boolean flag, and a derived/aggregate
 * total, respectively) and are simply never on this list.
 */
export const UNIT_PRICE_SEMANTIC_PRIORITY = ["UnitPrice", "NetUnitPrice", "ListPrice"];

/**
 * Resolves which of ListPrice's real, published output values AttributeDiscount's `InputUnitPrice`
 * should target. Resolution order:
 *   1. Exactly one output published → use it (unambiguous by definition).
 *   2. The donor's OWN existing `InputUnitPrice` binding already equals one of the real published
 *      outputs → keep it, no guess needed.
 *   3. Otherwise, the FIRST name from `UNIT_PRICE_SEMANTIC_PRIORITY` that IS one of the published
 *      outputs.
 *   4. None of the above resolves → `null` — the caller must treat this as a hard failure, never a guess.
 */
export function resolveTargetInputUnitPriceValue(donorAdInputUnitPrice: string | null, donorLpOutputValues: string[]): string | null {
  if (donorLpOutputValues.length === 1) return donorLpOutputValues[0];
  if (donorAdInputUnitPrice && donorLpOutputValues.includes(donorAdInputUnitPrice)) return donorAdInputUnitPrice;
  return UNIT_PRICE_SEMANTIC_PRIORITY.find(name => donorLpOutputValues.includes(name)) ?? null;
}

export interface FinalComposedCanvasValidation {
  failures: string[];
  /** The sole AttributeDiscount node found in the final graph, or `null` if there wasn't exactly one. */
  finalTargetNode: PhysicalStepNode | null;
  counts: { pricingSettings: number; listPrice: number; attributeDiscount: number };
}

/**
 * §Final canvas contract — validates the FINAL, reparsed composed graph entirely on its own semantic
 * terms. The target AttributeDiscount is located by `actionType` (exactly one expected) — NEVER by
 * comparing occurrence index against the SOURCE donor's own occurrence numbering. Source occurrence
 * index (e.g. 14, from a 76-step shared donor) is provenance information about where the branch was
 * EXTRACTED FROM; it is structurally unrelated to where anything ends up in the freshly-composed final
 * canvas (occurrence indices are assigned fresh, from 0, by `extractStepGraph` over the NEW bytes) —
 * comparing the two is not merely wrong, it's asking a question that has no coherent answer.
 */
export function validateFinalComposedCanvas(
  finalGraph: PhysicalStepNode[],
  expected: { inputUnitPrice: string | null; parentStep: string | null; stepCount: number },
): FinalComposedCanvasValidation {
  const failures: string[] = [];
  const pricingSettingsNodes = finalGraph.filter(n => n.actionType === "PricingSettings");
  const listPriceNodes = finalGraph.filter(n => n.actionType === "ListPrice");
  const attributeDiscountNodes = finalGraph.filter(n => n.actionType === "AttributeDiscount");
  const unrelatedActionTypes = [...new Set(finalGraph.map(n => n.actionType).filter((v): v is string => !!v))].filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));
  const finalTargetNode = attributeDiscountNodes.length === 1 ? attributeDiscountNodes[0] : null;
  const finalInputUnitPrice = finalTargetNode ? getAnyParamValueByName(finalTargetNode.full, "InputUnitPrice") : null;
  const dangling = findDanglingParentStepReferences(finalGraph);

  if (pricingSettingsNodes.length !== 1) {
    failures.push(`Final serialized Expression Set reparse failed: expected exactly one PricingSettings in the composed final canvas, but found ${pricingSettingsNodes.length}.`);
  }
  if (listPriceNodes.length !== 1) {
    failures.push(`Final serialized Expression Set reparse failed: expected exactly one ListPrice in the composed final canvas, but found ${listPriceNodes.length}.`);
  }
  if (attributeDiscountNodes.length !== 1) {
    failures.push(`Final serialized Expression Set reparse failed: expected exactly one AttributeDiscount in the composed final canvas, but found ${attributeDiscountNodes.length}.`);
  } else if (finalInputUnitPrice !== expected.inputUnitPrice) {
    failures.push(`Final serialized Expression Set reparse failed: AttributeDiscount.InputUnitPrice="${finalInputUnitPrice ?? "(none)"}", expected "${expected.inputUnitPrice ?? "(none)"}".`);
  } else if (finalTargetNode!.parentStep !== expected.parentStep) {
    failures.push(`Final serialized Expression Set reparse failed: AttributeDiscount parentStep="${finalTargetNode!.parentStep ?? "(none)"}" does not resolve within the final canvas (expected "${expected.parentStep ?? "(none)"}").`);
  }
  if (unrelatedActionTypes.length > 0) {
    failures.push(`Final serialized Expression Set reparse failed: unrelated actionType(s) survived final composition: [${unrelatedActionTypes.join(", ")}].`);
  }
  if (dangling.length > 0) {
    failures.push(
      `Final serialized Expression Set reparse failed: ${dangling.length} dangling parentStep reference(s) in the final canvas: ${dangling.map(d => `[${d.occurrenceIndex}] ${d.pathLabel} parentStep="${d.parentStep}"`).join("; ")}.`,
    );
  }
  if (finalGraph.length !== expected.stepCount) {
    failures.push(`Final serialized Expression Set reparse failed: total physical steps ${finalGraph.length} (expected ${expected.stepCount}) — the serialized bytes diverge from what was validated.`);
  }

  return {
    failures, finalTargetNode,
    counts: { pricingSettings: pricingSettingsNodes.length, listPrice: listPriceNodes.length, attributeDiscount: attributeDiscountNodes.length },
  };
}

/* ── Helpers ── */

function hashText(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * §Structural rules (donor-fidelity hardening) — the ONLY two ways any patch below may touch a
 * parameter, full stop:
 *   1. Rule 5 — the parameter already exists SOMEWHERE in the step's OWN fields (top-level OR nested
 *      inside <customElement>, wherever the donor originally put it): find it and replace ONLY its
 *      <value>, never its position or parent.
 *   2. Rule 7 — the parameter doesn't exist anywhere yet: insert it into the donor's EXISTING
 *      <customElement> block — never as a new top-level <parameters> sibling of <steps>, never inside
 *      a freshly-created <customElement> wrapper. If the step has no <customElement> at all, nothing
 *      is inserted (`applied: false`) — the caller must warn, never fabricate a structure the donor
 *      never had.
 * No patch function past this point calls `insertParameterIntoStep` with a `<parameters>` block
 * directly — that was the one code path capable of appending a new top-level `<parameters>` node,
 * exactly the shape Salesforce rejects with "Element parameters invalid at this location in type
 * ExpressionSetStep".
 */
function insertIntoExistingCustomElement(stepFullXml: string, newParamBlockXml: string): { xml: string; applied: boolean } {
  const first = extractFlatBlocks(stepFullXml, "customElement")[0];
  if (!first) return { xml: stepFullXml, applied: false };
  const closeTag = "</customElement>";
  const updatedCe = first.slice(0, first.length - closeTag.length) + newParamBlockXml + closeTag;
  return { xml: stepFullXml.replace(first, updatedCe), applied: true };
}

function setExistingParameterValue(stepFullXml: string, paramName: string, newValue: string): string | null {
  const top = getTopLevelParameterBlocks(stepFullXml).find(b => getParamName(b.block) === paramName);
  if (top) return stepFullXml.slice(0, top.start) + setParamValue(top.block, newValue) + stepFullXml.slice(top.end);
  for (const ce of extractFlatBlocks(stepFullXml, "customElement")) {
    const nested = extractFlatBlocks(ce, "parameters").find(p => getParamName(p) === paramName);
    if (nested) {
      const updatedCe = ce.replace(nested, setParamValue(nested, newValue));
      return stepFullXml.replace(ce, updatedCe);
    }
  }
  return null;
}

/** The one call every patch below makes to set a business value: update in place if the parameter already exists anywhere (Rule 5), else insert into the donor's existing `<customElement>` only (Rule 7). `applied: false` means neither was possible — the caller must warn. */
function setOrInsertParameterValue(
  stepFullXml: string, paramName: string, newValue: string,
  opts: { input?: boolean; output?: boolean; type?: string } = {},
): { xml: string; applied: boolean } {
  const updated = setExistingParameterValue(stepFullXml, paramName, newValue);
  if (updated !== null) return { xml: updated, applied: true };
  const newBlock = buildParameterBlock({ name: paramName, value: newValue, type: opts.type, input: opts.input, output: opts.output });
  return insertIntoExistingCustomElement(stepFullXml, newBlock);
}

/**
 * §Own-fields-only scoping (Part 8) — a step's OWN fields text is everything from its opening `<steps>`
 * tag up to (but not including) its first NESTED child `<steps>` tag, if it has any. `getTopLevelParameterBlocks`/
 * `extractFlatBlocks` are flat, non-nesting-aware regex scans: given a CONTAINER's full text (which
 * includes every nested descendant's text too), they would treat a nested child's own top-level
 * parameter as if it belonged to the outer step, letting a patch accidentally mutate content that isn't
 * the outer step's own. Every patch below is applied to `ownPart` only, then reassembled with
 * `nestedAndClose` completely untouched — this makes that leak structurally impossible regardless of
 * whether the selected step happens to have nested children.
 */
function splitOwnFromNested(stepFullXml: string): { ownPart: string; nestedAndClose: string } {
  const ownOpenEnd = stepFullXml.indexOf(">") + 1;
  const nestedIdx = stepFullXml.indexOf("<steps", ownOpenEnd);
  if (nestedIdx === -1) return { ownPart: stepFullXml, nestedAndClose: "" };
  return { ownPart: stepFullXml.slice(0, nestedIdx), nestedAndClose: stepFullXml.slice(nestedIdx) };
}

/**
 * §Pricing-waterfall connection investigation (Part 9/10) — every `<parameters>` block ANYWHERE within
 * the given text, top-level or nested inside ANY `<customElement>` at ANY depth (including inside a
 * nested child step, if the given text is a container's full subtree) — a deliberately recursive,
 * whole-subtree search, since a real donor's price-input parameter may not be a direct child of the
 * outer step. Read-only diagnostics/validation use this; patches never do (see `splitOwnFromNested`).
 */
function getAllParameterBlocksRecursive(subtreeXml: string): { block: string; nested: boolean }[] {
  const blocks: { block: string; nested: boolean }[] = getTopLevelParameterBlocks(subtreeXml).map(b => ({ block: b.block, nested: false }));
  for (const ce of extractFlatBlocks(subtreeXml, "customElement")) {
    for (const p of extractFlatBlocks(ce, "parameters")) {
      blocks.push({ block: p, nested: true });
    }
  }
  return blocks;
}

function getAnyParamValueByName(subtreeXml: string, paramName: string): string | null {
  const found = getAllParameterBlocksRecursive(subtreeXml).find(b => getParamName(b.block) === paramName);
  return found ? getParamValue(found.block) : null;
}

/** One report line per matching parameter (name/value/location), for the pre-deploy "ListPrice Outputs" / "AttributeDiscount Inputs" validation print. */
function describeParameters(xml: string, filter: (block: string) => boolean): string[] {
  return getAllParameterBlocksRecursive(xml)
    .filter(p => filter(p.block))
    .map(p => `  - name=${getParamName(p.block) ?? "(none)"}, value=${getParamValue(p.block) ?? "(none)"}, location=${p.nested ? "nested (<customElement>)" : "top-level"}`);
}

/** Rich per-occurrence diagnostic line (Part 7/12) — physical occurrence index/path, own fields, every
 * input/output binding found anywhere in its subtree, and a content hash for exact identification. */
function describeOccurrenceForDiagnostics(node: PhysicalStepNode): string {
  const allParams = getAllParameterBlocksRecursive(node.full);
  const inputs = allParams.filter(p => isInputParam(p.block)).map(p => `${getParamName(p.block) ?? "(none)"}=${getParamValue(p.block) ?? "(none)"}`);
  const outputs = allParams.filter(p => isOutputParam(p.block)).map(p => `${getParamName(p.block) ?? "(none)"}=${getParamValue(p.block) ?? "(none)"}`);
  return [
    `occurrenceIndex=${node.occurrenceIndex}`,
    `path=${node.pathLabel}`,
    `name=${node.name ?? "(none)"}`,
    `sequenceNumber=${node.sequenceNumber ?? "(none)"}`,
    `parentStep=${node.parentStep ?? "(none)"}`,
    `hasCustomElement=${extractCustomElementBlocks(node.full).length > 0}`,
    `inputs=[${inputs.join(", ") || "none"}]`,
    `outputs=[${outputs.join(", ") || "none"}]`,
    `contentHash=${hashText(node.full).slice(0, 16)}`,
  ].join(" | ");
}

/** Every input+output parameter's name → value, searched recursively through the whole subtree
 * (top-level and any customElement, at any depth) — the same "search everywhere" primitive used for
 * the pricing-waterfall lookups, reused here as the raw signal source for branch identification. */
function collectFieldMap(node: PhysicalStepNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of getAllParameterBlocksRecursive(node.full)) {
    const name = getParamName(p.block);
    const value = getParamValue(p.block);
    if (name && value !== null && !map.has(name)) map.set(name, value);
  }
  return map;
}

/** §Part 2 — walk the LOGICAL <parentStep> name chain upward from `start` to the root, resolving each
 * name via a PROVEN-UNIQUE lookup (never trusted blindly — see the file-level "Occurrence-based
 * identity" note). Stops (without failing the caller) the moment a name doesn't resolve to exactly one
 * donor step, or a cycle is detected, recording exactly how far it got either way. */
function walkParentChain(graph: PhysicalStepNode[], start: PhysicalStepNode): { chain: PhysicalStepNode[]; reachedRoot: boolean; note: string } {
  const chain: PhysicalStepNode[] = [];
  const visitedNames = new Set<string>();
  let currentParentName = start.parentStep;
  while (currentParentName) {
    if (visitedNames.has(currentParentName)) {
      return { chain, reachedRoot: false, note: `Cycle detected at parentStep "${currentParentName}" — ancestry walk stopped.` };
    }
    visitedNames.add(currentParentName);
    const matches = graph.filter(n => n.name === currentParentName);
    if (matches.length !== 1) {
      return { chain, reachedRoot: false, note: `parentStep "${currentParentName}" resolved to ${matches.length} donor step(s) (expected exactly 1) — ancestry walk stopped here.` };
    }
    chain.push(matches[0]);
    currentParentName = matches[0].parentStep;
  }
  return { chain, reachedRoot: true, note: `Reached root after ${chain.length} ancestor(s).` };
}

export interface AttributeDiscountBranchCandidate {
  occurrenceIndex: number;
  pathLabel: string;
  parentStepName: string | null;
  ancestorNames: string[];
  ancestryNote: string;
  isContractEnabled: boolean | null;
  priceAdjustmentScheduleBinding: string | null;
  effectiveFromBinding: string | null;
  effectiveToBinding: string | null;
  exclusiveFieldNames: string[];
  branchType: string;
  score: number;
  reasons: string[];
}

export interface AttributeDiscountBranchSelection {
  candidates: AttributeDiscountBranchCandidate[];
  selectedOccurrenceIndex: number | null;
  selectionReason: string;
  ambiguous: boolean;
}

/**
 * §Parts 2-8 — deterministic, donor-driven Attribute-Based Pricing branch selection among multiple
 * physical AttributeDiscount occurrences. Never picks by array index/position — every candidate's
 * ancestry is walked via the real `<parentStep>` chain, and a score is computed from MULTIPLE
 * independent signals actually present in the donor (never a single field alone, per explicit
 * instruction): an explicit `IsContractEnabled` flag if present, contract-flavored vs. constant/generic
 * naming in the PriceAdjustmentSchedule/EffectiveFrom/EffectiveTo bindings (the same `/contract/i`
 * convention already used elsewhere in this file for ListPrice candidate selection — not a new
 * invented rule), and how many of a candidate's own fields are NOT shared with any other candidate
 * (the more distinctive/specialized branch carries more exclusive, often contract-specific, fields).
 * Ties are never broken by guessing — an ambiguous result is returned instead, and the caller must fail.
 */
function selectAttributeBasedDiscountBranch(
  donorGraph: PhysicalStepNode[], occurrences: PhysicalStepNode[],
): AttributeDiscountBranchSelection {
  const fieldMaps = occurrences.map(node => ({ node, fields: collectFieldMap(node) }));

  if (occurrences.length === 1) {
    const { node, fields } = fieldMaps[0];
    const ancestry = walkParentChain(donorGraph, node);
    const isContractEnabledRaw = fields.get("IsContractEnabled") ?? null;
    const isContractEnabled = isContractEnabledRaw === null ? null : isContractEnabledRaw.toLowerCase() === "true";
    const candidate: AttributeDiscountBranchCandidate = {
      occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, parentStepName: node.parentStep,
      ancestorNames: ancestry.chain.map(a => a.name ?? "(unnamed)"), ancestryNote: ancestry.note,
      isContractEnabled, priceAdjustmentScheduleBinding: fields.get("PriceAdjustmentScheduleId") ?? null,
      effectiveFromBinding: fields.get("EffectiveFrom") ?? null, effectiveToBinding: fields.get("EffectiveTo") ?? null,
      exclusiveFieldNames: [], branchType: "N/A (only candidate)", score: 0,
      reasons: ["Exactly one physical AttributeDiscount occurrence exists — no disambiguation needed."],
    };
    return { candidates: [candidate], selectedOccurrenceIndex: node.occurrenceIndex, selectionReason: candidate.reasons[0], ambiguous: false };
  }

  const candidates: AttributeDiscountBranchCandidate[] = fieldMaps.map(({ node, fields }) => {
    const ancestry = walkParentChain(donorGraph, node);
    const otherFieldNames = new Set<string>();
    for (const other of fieldMaps) {
      if (other.node.occurrenceIndex === node.occurrenceIndex) continue;
      for (const name of other.fields.keys()) otherFieldNames.add(name);
    }
    const exclusiveFieldNames = [...fields.keys()].filter(n => !otherFieldNames.has(n));

    const isContractEnabledRaw = fields.get("IsContractEnabled") ?? null;
    const isContractEnabled = isContractEnabledRaw === null ? null : isContractEnabledRaw.toLowerCase() === "true";
    const pasBinding = fields.get("PriceAdjustmentScheduleId") ?? null;
    const effFrom = fields.get("EffectiveFrom") ?? null;
    const effTo = fields.get("EffectiveTo") ?? null;

    let score = 0;
    const reasons: string[] = [];
    if (isContractEnabled === true) { score -= 3; reasons.push("IsContractEnabled=true (contract-leaning, -3)"); }
    else if (isContractEnabled === false) { score += 3; reasons.push("IsContractEnabled=false (standard-leaning, +3)"); }

    if (pasBinding) {
      if (/contract/i.test(pasBinding)) { score -= 2; reasons.push(`PriceAdjustmentScheduleId bound to "${pasBinding}" (contract-flavored name, -2)`); }
      if (/constant/i.test(pasBinding)) { score += 2; reasons.push(`PriceAdjustmentScheduleId bound to "${pasBinding}" (generic/reusable "constant" naming, +2)`); }
    }
    for (const [label, val] of [["EffectiveFrom", effFrom], ["EffectiveTo", effTo]] as const) {
      if (val && /contract/i.test(val)) { score -= 1; reasons.push(`${label} bound to "${val}" (contract-flavored name, -1)`); }
    }

    const exclusiveContractFlavored = exclusiveFieldNames.filter(n => /contract/i.test(n) || /contract/i.test(fields.get(n) ?? ""));
    if (exclusiveContractFlavored.length > 0) {
      score -= exclusiveContractFlavored.length;
      reasons.push(`Field(s) unique to this branch with contract-flavored name/value: ${exclusiveContractFlavored.join(", ")} (-${exclusiveContractFlavored.length})`);
    }

    return {
      occurrenceIndex: node.occurrenceIndex, pathLabel: node.pathLabel, parentStepName: node.parentStep,
      ancestorNames: ancestry.chain.map(a => a.name ?? "(unnamed)"), ancestryNote: ancestry.note,
      isContractEnabled, priceAdjustmentScheduleBinding: pasBinding, effectiveFromBinding: effFrom, effectiveToBinding: effTo,
      exclusiveFieldNames,
      branchType: isContractEnabled === true ? "Contract Attribute Pricing" : isContractEnabled === false ? "Standard Attribute-Based Pricing" : "Unlabeled Attribute-Based Pricing Branch",
      score, reasons,
    };
  });

  const minExclusive = Math.min(...candidates.map(c => c.exclusiveFieldNames.length));
  const maxExclusive = Math.max(...candidates.map(c => c.exclusiveFieldNames.length));
  if (minExclusive < maxExclusive) {
    for (const c of candidates) {
      if (c.exclusiveFieldNames.length === minExclusive) {
        c.score += 1;
        c.reasons.push(`Fewest branch-exclusive fields (${c.exclusiveFieldNames.length}) among candidates — leans generic/base branch (+1)`);
      }
    }
  }

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const runnerUp = sorted[1];
  if (runnerUp && top.score === runnerUp.score) {
    return {
      candidates, selectedOccurrenceIndex: null, ambiguous: true,
      selectionReason: `Multiple Attribute-Based Pricing branches are structurally identical and cannot be distinguished safely (tied score ${top.score}).`,
    };
  }
  return {
    candidates, selectedOccurrenceIndex: top.occurrenceIndex, ambiguous: false,
    selectionReason: `Selected occurrence [${top.occurrenceIndex}] (parentStep="${top.parentStepName ?? "(none)"}", branchType=${top.branchType}) with score ${top.score} vs. runner-up score ${runnerUp?.score ?? "(none)"} — ${top.reasons.join("; ")}.`,
  };
}

/** Indented PHYSICAL-nesting tree view (Part 11/13) — grouped by real XML nesting (`parentOccurrenceIndex`,
 * always well-defined, never ambiguous under duplicate names), with each node's LOGICAL `<parentStep>`
 * value shown alongside for cross-reference/diagnosis. */
function renderPhysicalTree(nodes: PhysicalStepNode[]): string {
  const byParentOccurrence = new Map<number | string, PhysicalStepNode[]>();
  for (const n of nodes) {
    const key = n.parentOccurrenceIndex ?? "root";
    const list = byParentOccurrence.get(key) ?? [];
    list.push(n);
    byParentOccurrence.set(key, list);
  }
  const lines: string[] = [];
  function walk(node: PhysicalStepNode, depth: number): void {
    lines.push(`${"  ".repeat(depth)}[${node.occurrenceIndex}] ${node.name ?? "(unnamed)"} (${node.actionType ?? "?"}) parentStep="${node.parentStep ?? "(none)"}"`);
    for (const child of byParentOccurrence.get(node.occurrenceIndex) ?? []) walk(child, depth + 1);
  }
  for (const root of byParentOccurrence.get("root") ?? []) walk(root, 0);
  return lines.join("\n");
}

/* ── Patch A: strip product-specific literal bindings. ── */
function patchA_stripProductLiterals(ownPart: string): string {
  return removeTopLevelParameters(ownPart, block => {
    if (isOutputParam(block)) return false; // never touch outputs
    const name = getParamName(block);
    // InputUnitPrice is the pricing-waterfall binding — preserved verbatim from the donor regardless of
    // its bound value, never stripped/renamed (see file-level "Pricing-waterfall binding" note).
    if (name === "InputUnitPrice") return false;
    const value = getParamValue(block);
    if (!name || !RECOGNIZED_PARAM_NAMES.has(name)) return true; // unrecognized param name -> strip unconditionally
    const isInput = isInputParam(block) || getTagValue(block, "type") === "Parameter";
    if (isInput && value && !ABP_STANDARD_CTX.has(value) && !RECOGNIZED_PARAM_NAMES.has(value)) return true; // bound to an unrecognized context var -> strip
    return false;
  });
}

/* ── Patch C: preserve PriceAdjustmentScheduleId verbatim, nested inside the donor's EXISTING <customElement> — never a freshly-created wrapper, never top-level. ── */
function patchC_preserveScheduleId(originalOwnPart: string, patchedOwnPart: string, warnings: string[]): string {
  const scheduleRe = /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i;

  const alreadyNested = extractCustomElementBlocks(patchedOwnPart).some(ce => getAllTagValues(ce, "name").some(n => scheduleRe.test(n)));
  if (alreadyNested) return patchedOwnPart;

  const originalTopLevelMatch = getTopLevelParameterBlocks(originalOwnPart).find(b => {
    const n = getParamName(b.block);
    return !!n && scheduleRe.test(n);
  });

  // Drop it from the top level if a patch happened to leave it there (wrong nesting level).
  const result = removeTopLevelParameters(patchedOwnPart, block => {
    const n = getParamName(block);
    return !!n && scheduleRe.test(n);
  });

  const paramBlockXml = originalTopLevelMatch
    ? originalTopLevelMatch.block // verbatim — never synthesize a replacement when the template already had one
    : buildParameterBlock({ input: true, name: "PriceAdjustmentScheduleId", output: false, type: "Parameter", value: "PriceAdjustmentScheduleId" });

  const inserted = insertIntoExistingCustomElement(result, paramBlockXml);
  if (!inserted.applied) {
    warnings.push("AttributeDiscount's template has no <customElement> to nest PriceAdjustmentScheduleId into — left unset (never added as a new top-level <parameters> node or a freshly-created <customElement> wrapper). The downstream validation below will fail this build, since the deployed procedure would have no way to resolve its PriceAdjustmentSchedule at runtime.");
    return result;
  }
  return inserted.xml;
}

/**
 * Patch D: normalize AD_MAPPINGS bindings — update the EXISTING parameter in place, wherever the donor
 * put it (Rule 5), or insert into the donor's EXISTING <customElement> only when the parameter is truly
 * absent everywhere (Rule 7) — never a new top-level <parameters> node. A var-check mapping's
 * ALREADY-EXISTING parameter (top-level or nested) is always rewritten to our own context-variable
 * binding too, not left alone — leaving a nested value untouched risked silently deploying a donor
 * org's own product-specific literal. `InputUnitPrice` is deliberately absent from AD_MAPPINGS — see
 * the file-level "Pricing-waterfall binding" note.
 */
/**
 * §Part 15/16 — a missing declared variable is reported at one of two distinct severities, never a
 * single generic message: if the donor's OWN AttributeDiscount step already carries a value for this
 * parameter (its own pre-existing binding, from an already-deployed, presumably-working template), that
 * value is left completely untouched by the `continue` below — this is genuinely optional, informational
 * only. If the parameter is truly absent from the donor too, that's still reported as informational
 * (never fatal) — the SAME donor branch this build clones from already runs in this org without it
 * declared, which is itself evidence Salesforce's runtime doesn't require it here. The only case that
 * escalates to "cannot safely deploy" is the pre-existing `applied: false` path below: a parameter this
 * engine actively tried to set but had nowhere to put (no matching field anywhere AND no `<customElement>`
 * to insert into) — never a hypothetical severity invented ahead of what the donor's own structure proves.
 */
function patchD_normalizeMappings(ownPart: string, declaredVars: Set<string>, warnings: string[]): string {
  let result = ownPart;
  for (const mapping of AD_MAPPINGS) {
    if (mapping.requiresVarCheck && !declaredVars.has(mapping.ctxVar)) {
      const existingValue = getAnyParamValueByName(ownPart, mapping.paramName);
      warnings.push(
        existingValue !== null
          ? `ℹ Optional donor binding "${mapping.paramName}" -> "${mapping.ctxVar}" not declared as a variable by this template — the donor's own existing value ("${existingValue}") is preserved unchanged.`
          : `ℹ Optional donor binding "${mapping.paramName}" -> "${mapping.ctxVar}" not declared as a variable by this template, and the parameter is absent from the donor's own AttributeDiscount step — preserved absent, matching this donor's own (already-deployed) template behavior.`,
      );
      continue;
    }
    const { xml, applied } = setOrInsertParameterValue(result, mapping.paramName, mapping.ctxVar, { input: true });
    result = xml;
    if (!applied) {
      warnings.push(`✕ Required AttributeDiscount binding "${mapping.paramName}" -> "${mapping.ctxVar}" could not be set: this parameter isn't present in the template and there's no <customElement> to nest a new one into. This may prevent correct runtime evaluation — cannot safely confirm this deploy.`);
    }
  }
  return result;
}

/* ── guards ── */
function postBuildGuard(steps: { actionType: string; ownXml: string }[]): string[] {
  const errors: string[] = [];
  for (const s of steps) {
    if (ATTR_BLOCKED_ACTION_TYPES.has(s.actionType)) errors.push(`Blocked/legacy actionType present in the built canvas: ${s.actionType}`);
  }
  const ad = steps.find(s => s.actionType === "AttributeDiscount");
  if (ad) {
    const leaked = getTopLevelParameterBlocks(ad.ownXml)
      .map(b => getParamName(b.block))
      .filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
    if (leaked.length > 0) errors.push(`Unrecognized/leaked parameter name(s) survived patching on AttributeDiscount: ${leaked.join(", ")}`);
  }
  return errors;
}

function validateAttributeCanvas(
  parts: { psXml: string; lpXml: string; adOwnXml: string },
  templateActionTypesObserved: Set<string>,
  declaredVars: Set<string>,
): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const built = [
    { actionType: "PricingSettings" },
    { actionType: "ListPrice" },
    { actionType: "AttributeDiscount" },
  ];

  for (const t of built) {
    if (!templateActionTypesObserved.has(t.actionType)) {
      fatal.push(`actionType "${t.actionType}" was never observed in any retrieved template Expression Set — refusing to deploy an invented action type.`);
    }
  }
  for (const required of ATTR_REQUIRED_ACTION_TYPES) {
    if (!built.some(b => b.actionType === required)) warnings.push(`Required step type "${required}" is missing from the built canvas.`);
  }
  for (const t of built) {
    if (ATTR_BLOCKED_ACTION_TYPES.has(t.actionType)) fatal.push(`Blocked actionType "${t.actionType}" present in the built canvas.`);
  }

  // AttributeDiscount: PriceAdjustmentScheduleId must be nested inside <customElement>, never top-level.
  const scheduleRe = /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i;
  const topLevelHasSchedule = getTopLevelParameterBlocks(parts.adOwnXml).some(b => { const n = getParamName(b.block); return !!n && scheduleRe.test(n); });
  const nestedHasSchedule = extractCustomElementBlocks(parts.adOwnXml).some(ce => getAllTagValues(ce, "name").some(n => scheduleRe.test(n)));
  if (topLevelHasSchedule) fatal.push('PriceAdjustmentScheduleId is present at the top level of AttributeDiscount instead of nested inside <customElement> — Salesforce rejects this with "Element parameters invalid at this location in type ExpressionSetStep".');
  if (!nestedHasSchedule) fatal.push("AttributeDiscount has no PriceAdjustmentScheduleId parameter (top-level or nested) — the deployed procedure would have no way to resolve its PriceAdjustmentSchedule at runtime.");

  // Re-verify AD_MAPPINGS bindings landed as expected (defense in depth).
  for (const mapping of AD_MAPPINGS.filter(m => m.requiresVarCheck)) {
    const existing = getTopLevelParameterBlocks(parts.adOwnXml).find(b => getParamName(b.block) === mapping.paramName);
    if (!existing) continue;
    const value = getParamValue(existing.block);
    if (value && !declaredVars.has(value) && !RCA_NATIVE_CTX.has(value)) {
      warnings.push(`AttributeDiscount binding "${mapping.paramName}" is bound to "${value}", which is neither a declared template variable nor a known native runtime context variable.`);
    }
  }

  // Leakage scan (defense in depth).
  const leaked = getTopLevelParameterBlocks(parts.adOwnXml).map(b => getParamName(b.block)).filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
  if (leaked.length > 0) fatal.push(`Unrecognized parameter name(s) on AttributeDiscount: ${leaked.join(", ")}`);

  // ListPrice: the required lookup/customElement fields must still be present — unrelated to the
  // pricing-waterfall output check (that lives in buildAttributeCanvas itself, against the donor's real,
  // unpatched output values — never a hardcoded literal here).
  const lpCustom = extractCustomElementBlocks(parts.lpXml).join("");
  for (const requiredField of ["LookUpId", "LookUpName", "LookUpApiName", "ListPriceField"]) {
    if (!getAllTagValues(lpCustom, "name").includes(requiredField)) {
      fatal.push(`ListPrice's <customElement> is missing required field "${requiredField}".`);
    }
  }

  return { fatal, warnings };
}

/** Number of `<parameters>` blocks (top-level + nested) in a subtree of text. */
function countParameters(xml: string): number {
  return extractFlatBlocks(xml, "parameters").length;
}

/** One envelope-level identifier tag (label/description/fullName/developerName/name/
 * expressionSetDefinition) whose value was regenerated from the new Pricing Procedure's own name/API
 * name instead of being copied from the donor. */
interface RegeneratedIdentifier {
  tag: string;
  donorValue: string;
  newValue: string;
}


/** §Part 1/9 — the version envelope's own identity/lifecycle field values, read back from the exact
 * serialized bytes right after generation, scoped to ONLY the envelope (never `stepsRegionXml`) — see
 * the file-level note where this is computed for why an unscoped scan of the whole file is unsafe. */
export interface OutboundVersionFields {
  fullName: string | null;
  versionNumber: string | null;
  rank: string | null;
  expressionSetDefinition: string | null;
}

/* ── Public API ── */
export interface CanvasStepStats {
  actionType: string;
  parameterCount: number;
}

export interface CanvasBuildResult {
  success: boolean;
  finalFileXml?: string;
  finalSteps?: { actionType: string; xml: string }[];
  /** The real Metadata API zip path the donor (AttributeDiscount template) file was retrieved at — e.g. "unpackaged/expressionSetDefinitions/Donor.expressionSetDefinition-meta.xml". This is the deploy packaging step's reference for the real folder/suffix convention this org's Metadata API actually uses, instead of guessing one. */
  donorFileName?: string;
  lpLookup?: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null };
  /** Every actionType actually observed in the retrieved template Expression Set(s). */
  observedActionTypes?: string[];
  /** Per-step parameter counts on the FINAL (patched) canvas. */
  stepStats?: CanvasStepStats[];
  /** Variables declared on the donor template Expression Set. */
  variableCount?: number;
  /** Structural schema comparison (donor vs. generated) — present when the comparison ran, whether it passed or not. */
  schemaReport?: string;
  /** §JSON audit — the structured (not just flattened-text) per-step structural comparison, present
   * whenever the per-step comparison ran (i.e. once the donor's PricingSettings/ListPrice steps were
   * found), whether every step passed or not. */
  stepStructureReports?: StepStructureReport[];
  /** §Referential integrity — occurrence-aware, across the COMPLETE generated step graph (every
   * container/list/child step, every depth). Present whenever the check ran. */
  parentStepValidation?: ParentStepValidationEntry[];
  /** Generated `<name>` values that occur more than once — INFORMATIONAL ONLY, legitimate in this
   * donor's metadata. Never contributes to pass/fail. */
  duplicateStepNames?: string[];
  /** Every envelope-level identifier tag (label/fullName/developerName/name/expressionSetDefinition)
   * this run actually regenerated, with its FINAL (generated, never donor) value — present on success
   * so a caller can validate them against the ORG before deploying. */
  generatedIdentifiers?: { tag: string; value: string }[];
  /** §Part 1/9 — present on every success; see `OutboundVersionFields` for why this must be used
   * instead of a caller re-scanning `finalFileXml` for these tags itself. */
  outboundVersionFields?: OutboundVersionFields;
  /** §Pricing-waterfall — ListPrice's own (donor-verbatim, never patched) output Parameter value(s).
   * `valid` only requires at least one real output to exist — never requires a specific literal name. */
  listPriceOutputValidation?: { donorOutputs: string[]; generatedOutputs: string[]; outputCount: number; valid: boolean };
  /** §Pricing-waterfall — AttributeDiscount's InputUnitPrice value (found via a recursive whole-subtree
   * search, never assumed to be a direct child), checked against ListPrice's real (donor-verbatim)
   * output values. `inputUnitPriceValue` is the FINAL value (post-patch); `originalInputUnitPriceValue`
   * is the donor's raw value; `wasPatched` is true only when the donor's own value was inconsistent AND
   * ListPrice published exactly one unambiguous output to align to — never forced/invented otherwise. */
  attributeDiscountInputBinding?: {
    listPriceOutputValues: string[];
    inputUnitPriceValue: string | null;
    originalInputUnitPriceValue: string | null;
    wasPatched: boolean;
    valid: boolean;
  };
  /** §Complete donor/generated hierarchy comparison — total physical step counts (every depth), any
   * donor step missing from the generated set (by occurrence, never by name), and rendered donor/
   * generated physical-nesting trees for visual diff. */
  hierarchyComparison?: {
    donorStepCount: number;
    generatedStepCount: number;
    missingDonorOccurrences: number[];
    hierarchyMatches: boolean;
    donorTree: string;
    generatedTree: string;
  };
  /** §Gate A — sanity check on `extractStepGraph` itself: re-running it on the same donor bytes twice
   * must produce an identical graph. This codebase never parses-and-reserializes a DOM (every edit is a
   * substring splice on the original bytes), so there is no serializer whose lossiness to test — this
   * checks the one thing that actually could be non-deterministic: the extraction function. */
  donorExtractionDeterministic?: boolean;
  /** §Gate B / Part 6/15 — identity-field drift, donor vs. generated. Not applicable/never populated
   * under the current two-donor composition architecture (there is no single donor to compare the
   * WHOLE tree against anymore) — kept only so existing consumers (JSON audit panel) degrade gracefully
   * to "no drift reported" rather than needing a type change. */
  identityFieldDrift?: { occurrenceIndex: number; pathLabel: string; field: string; donorValue: string | null; generatedValue: string | null }[];
  /** §Gate B / Part 15 — root-branch content-hash comparison. Not applicable/never populated under the
   * current two-donor composition architecture — see `identityFieldDrift` above for why. */
  unrelatedBranchIntegrity?: { checkedBranches: number; changedBranches: string[] };
  /** §Parts 2-8/12/15 — every physical AttributeDiscount branch candidate discovered in the donor, with
   * full ancestry/signal/score diagnostics, and which one (if any) was deterministically selected as the
   * Attribute-Based Pricing branch. Always present once discovery has run — even when ambiguous. */
  attributeDiscountBranchSelection?: AttributeDiscountBranchSelection;
  /** §Root-cause fix — the SINGLE coherent donor PricingSettings/ListPrice/AttributeDiscount were all
   * sourced from (never two unrelated donors stitched together), and how many of its OTHER root pricing
   * branches (FormulaBasedPricing/ManualDiscount/etc.) were pruned away to reach the final canvas. Present
   * once the donor has been selected, whether the build ultimately succeeds or not. */
  canvasComposition?: {
    donorFullName: string;
    donorFileName: string;
    donorPhysicalStepCount: number;
    prunedRootBranchCount: number;
    finalActionTypes: string[];
    finalPhysicalStepCount: number;
  };
  fatalErrors: string[];
  warnings: string[];
}

export async function buildAttributeCanvas(
  client: SalesforceClient,
  ctx: {
    procedureName: string; apiName: string; description?: string;
    /** §Section 6 — the version this build should identify itself as, resolved by the caller BEFORE
     * this function runs (`resolveNextExpressionSetVersionNumber` in orgUniquenessValidation.ts), never
     * guessed here. When omitted, `fullName`'s numeric suffix and the `<versionNumber>` tag are both left
     * exactly as the donor had them (the original, pre-Section-6 behavior) — this is what previously
     * caused every repeated build to regenerate the SAME identity as an existing version. Supplying this
     * makes the generated version's own identity target the NEXT version instead. */
    versionNumber?: number;
    /** §Part 1/2 — the unique-per-ExpressionSet Rank to embed in the deployed `<versions>` block,
     * resolved by the caller (`resolveNextAvailableExpressionSetVersion` in orgUniquenessValidation.ts)
     * from the org's own real existing Rank values BEFORE this function runs — never guessed here.
     * `rank` is a real, documented field on the `ExpressionSetDefinitionVersion` metadata type (Metadata
     * API Developer Guide, available API v62.0+): Salesforce enforces it as unique among a single
     * ExpressionSet's own versions, and rejects a deploy that omits/reuses it with "Assign a unique rank
     * to expression set version ... and try again." When omitted (org predates Rank, or resolution
     * failed upstream), no `<rank>` tag is added or changed — never an invented value. */
    rank?: number | null;
    /** Fired once, the moment the donor template's PricingSettings/ListPrice/AttributeDiscount steps
     * are all confirmed present (i.e. "Template Retrieved" is genuinely true) — everything from here on
     * is XML generation/validation, not template retrieval. Optional. */
    onProgress?: (phase: "template-retrieved") => void;
  },
): Promise<CanvasBuildResult> {
  const warnings: string[] = [];
  const fatalErrors: string[] = [];

  // §Root-cause fix — select ONE donor whose OWN graph already contains PricingSettings + ListPrice +
  // AttributeDiscount as a coherent, connected pricing flow. This replaces the prior architecture, which
  // cloned AttributeDiscount from whichever donor happened to have one, cloned PricingSettings+ListPrice
  // from a SEPARATE, unrelated minimal donor, and then tried to re-parent the extracted branch to point at
  // the other donor's ListPrice — composing two structurally DISCONNECTED graphs and requiring a fabricated
  // cross-donor <parentStep> link. That is exactly what produced "Selected AttributeDiscount branch has no
  // <parentStep> tag in its own fields": the branch was a root step in ITS donor with no parentStep to
  // hijack, and inventing one is not a legitimate fix. See `resolveAttributeBasedPricingDonor` (donorInspection.ts)
  // for the full, evidence-based selection contract — never picks by name/label, never accepts a donor
  // whose AttributeDiscount isn't PROVEN (via its real <parentStep> chain) to already resolve to that same
  // donor's ListPrice.
  client.logDebug("xml-diagnostic", "→ Resolving Attribute-Based Pricing Expression Set donor.");
  const donorResolution = await resolveAttributeBasedPricingDonor(client);
  const donorSelection = donorResolution.selection;
  if (!donorSelection) {
    client.logDebug("xml-diagnostic", "→ No valid Attribute-Based donor found.");
    client.logDebug("xml-diagnostic", "→ Switching to canonical Attribute-Based canvas construction.");
    const noDonorDiagnostic = buildNoCoherentDonorDiagnostic(donorResolution.candidatesWithAttributeDiscount);
    client.logDebug("xml-diagnostic", noDonorDiagnostic);
    // §Requirement: AttributeDiscount is a real BusinessKnowledgeModel action type that is not scriptable
    // on a blank canvas (its legal enum values are org-configured) — so "canonical construction" can never
    // mean authoring a brand-new AttributeDiscount step from scratch, and merging one donor's
    // AttributeDiscount with another donor's PricingSettings/ListPrice is explicitly forbidden (that is
    // the exact prior architecture this fix replaced). `resolveAttributeBasedPricingDonor` already IS the
    // canonical-construction attempt — it checks every donor in the org against all 4 real connection
    // signals (parentStep chain, physical nesting, InputUnitPrice/published-output variable binding,
    // declared sequence order) before concluding none qualifies. There is no legitimate, non-fabricating
    // fallback beyond that check, so a failure here means precisely what `noDonorDiagnostic` says: STOP,
    // do not fabricate.
    // §Live-org fix (Org B) — a DIFFERENT reason than "nothing connects at all": every candidate that DID
    // prove a real connection still scored below this codebase's own confidence floor (dominated by
    // unrelated shared-pricing-branch penalties). Reported distinctly so a human reading this doesn't
    // conclude "no donor has AttributeDiscount at all" when the real issue is "every connected donor looks
    // untrustworthy for other reasons."
    const lowConfidenceNote = donorResolution.lowConfidenceCandidates
      ? "\n\nNote: this is NOT \"no donor proved a connection\" — every eligible candidate below DID prove an AttributeDiscount->ListPrice connection, but each one's overall confidence score was still negative (dominated by unrelated shared-pricing-branch penalties), so none was trusted:\n"
        + donorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")
      : "";
    return {
      success: false,
      fatalErrors: [
        "No ExpressionSetDefinition in this org has PricingSettings, ListPrice, AND an AttributeDiscount branch proven connected to that SAME ListPrice via any recognized mechanism (<parentStep> chain, physical nesting, or declared sequence order) with sufficient confidence. AttributeDiscount cannot be authored from a blank canvas (its legal values are org-configured), and this codebase never merges AttributeDiscount from one donor with PricingSettings/ListPrice from another, or invents a <parentStep> link, to fake a connection.\n\n"
        + noDonorDiagnostic + lowConfidenceNote,
      ],
      warnings,
    };
  }
  const donorFileXml = donorSelection.fullXml;
  const donorGraph = extractStepGraph(donorFileXml);
  const observedActionTypes = new Set(donorGraph.map(n => n.actionType).filter((v): v is string => !!v));
  client.logDebug(
    "xml-diagnostic",
    [
      `✓ Selected donor: ${donorSelection.fullName} (${donorSelection.candidate.physicalStepCount} physical step(s), actionTypes=[${donorSelection.candidate.uniqueActionTypes.join(", ")}]).`,
      `Ranking (all eligible donors, highest-scored first): ${donorSelection.ranking.map(r => `${r.fullName} (score ${r.score}: ${r.reason})`).join(" | ")}`,
    ].join("\n"),
  );

  // §Gate A — extraction determinism (this architecture never parses-and-reserializes a DOM — every
  // edit below is a substring splice on the ORIGINAL donor bytes, so there is no serializer to lose
  // fidelity; the one thing that COULD be non-deterministic is the extraction function itself).
  const donorGraphRecheck = extractStepGraph(donorFileXml);
  const donorExtractionDeterministic = donorGraph.length === donorGraphRecheck.length
    && donorGraph.every((n, i) => n.name === donorGraphRecheck[i].name && n.actionType === donorGraphRecheck[i].actionType
      && n.parentStep === donorGraphRecheck[i].parentStep && n.path.join(",") === donorGraphRecheck[i].path.join(","));
  client.logDebug("xml-diagnostic", `[Gate A] Donor step graph: ${donorGraph.length} physical step(s). Extraction determinism: ${donorExtractionDeterministic ? "PASS" : "FAIL"}.`);
  if (!donorExtractionDeterministic) {
    return {
      success: false,
      fatalErrors: ["Donor round-trip is not lossless — extractStepGraph produced a different graph on a second pass over the identical, unchanged donor bytes. This indicates a bug in the extraction function itself; refusing to proceed on an unreliable donor graph."],
      warnings, donorExtractionDeterministic,
    };
  }

  // §Parts 2-8/12/15 — deterministic, donor-driven branch selection, restricted to the occurrences the
  // donor-selection stage above already PROVED are connected to this same graph's ListPrice via their real
  // <parentStep> chain (never array index, never "first found", never a disconnected branch). See
  // `selectAttributeBasedDiscountBranch`'s own doc comment for the full signal set used to disambiguate
  // among more than one connected candidate.
  const connectedAdNodes = donorGraph.filter(n => n.actionType === "AttributeDiscount" && donorSelection.connectedAttributeDiscountOccurrenceIndexes.includes(n.occurrenceIndex));
  if (connectedAdNodes.length === 0) {
    return {
      success: false,
      fatalErrors: [`Selected donor "${donorSelection.fullName}" was chosen for having a ListPrice-connected AttributeDiscount branch, but none could be re-located in its own graph — this should be unreachable; refusing to guess.`],
      warnings, donorExtractionDeterministic,
    };
  }
  const branchSelection = selectAttributeBasedDiscountBranch(donorGraph, connectedAdNodes);
  const branchDiagnosticTable = branchSelection.candidates.map((c, i) => [
    `Candidate ${i + 1}`,
    "-----------",
    `Step: [${c.occurrenceIndex}] ${c.pathLabel}`,
    `Parent: ${c.parentStepName ?? "(none)"}`,
    `Ancestors: ${c.ancestorNames.length > 0 ? c.ancestorNames.join(" → ") : "(none)"} (${c.ancestryNote})`,
    `Contract Enabled: ${c.isContractEnabled === null ? "(not present in donor)" : c.isContractEnabled}`,
    `PAS Input: ${c.priceAdjustmentScheduleBinding ?? "(none)"}`,
    `Effective From: ${c.effectiveFromBinding ?? "(none)"}`,
    `Effective To: ${c.effectiveToBinding ?? "(none)"}`,
    `Branch Type: ${c.branchType}`,
    `Score: ${c.score}`,
    `Reason: ${c.reasons.join("; ") || "(no signals present)"}`,
    "",
  ].join("\n")).join("\n");
  client.logDebug("xml-diagnostic", [
    `[AttributeDiscount branch discovery] ${connectedAdNodes.length} ListPrice-connected physical occurrence(s) found in "${donorSelection.fileName}".`,
    branchDiagnosticTable,
    branchSelection.ambiguous ? `AMBIGUOUS: ${branchSelection.selectionReason}` : `Selected Candidate: [${branchSelection.selectedOccurrenceIndex}] — ${branchSelection.selectionReason}`,
  ].join("\n"));
  if (branchSelection.selectedOccurrenceIndex === null) {
    return {
      success: false,
      fatalErrors: [`${branchSelection.selectionReason}\n\n${branchDiagnosticTable}`],
      warnings,
      attributeDiscountBranchSelection: branchSelection,
      donorExtractionDeterministic,
    };
  }
  const adNode = connectedAdNodes.find(o => o.occurrenceIndex === branchSelection.selectedOccurrenceIndex)!;
  const attributeDiscountBranchSelection = branchSelection;

  // §Live-org fix — PricingSettings/ListPrice are resolved against the SELECTED AttributeDiscount branch
  // using the SAME 4-signal, priority-ordered evidence `resolveAttributeBasedPricingDonor` already proved
  // connectivity with (`<parentStep>` chain, then physical nesting, then a matching InputUnitPrice/
  // published-output variable binding, then declared sequence-order — see `resolveConnectedAncestor`'s doc
  // comment, donorInspection.ts) — never assumed to be "the only one in the file" (a coherent donor can
  // legitimately bundle more than one pricing flow, and MULTIPLE ListPrice occurrences, each paired with a
  // different AttributeDiscount via its own variable binding), and never a guess: whichever real mechanism
  // proved eligibility during donor selection is exactly what's used here too, so the two stages can never
  // disagree about whether/how this branch is connected.
  const lpResolved = resolveConnectedAncestor(donorGraph, adNode, "ListPrice");
  const psResolved = resolveConnectedAncestor(donorGraph, adNode, "PricingSettings");
  const lpMatch = lpResolved.node;
  const psMatch = psResolved.node;
  if (!lpMatch) {
    return {
      success: false,
      fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorSelection.fullName}" does not resolve to a ListPrice step via any known mechanism (<parentStep> chain, physical nesting, or sequence order) — this should be unreachable given the donor-selection stage already proved connectivity; refusing to guess.`],
      warnings, attributeDiscountBranchSelection, donorExtractionDeterministic,
    };
  }
  if (!psMatch) {
    return {
      success: false,
      fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorSelection.fullName}" resolves to ListPrice ("${lpMatch.name ?? "(unnamed)"}") but never resolves to a PricingSettings step via any known mechanism — a coherent Attribute-Based Pricing flow requires both.`],
      warnings, attributeDiscountBranchSelection, donorExtractionDeterministic,
    };
  }
  client.logDebug(
    "xml-diagnostic",
    [
      `✓ Donor steps in this flow: PricingSettings ("${psMatch.name ?? "(unnamed)"}"), ListPrice ("${lpMatch.name ?? "(unnamed)"}").`,
      `→ AttributeDiscount → ListPrice relationship: ${lpResolved.mechanism}${lpResolved.mechanism === "sequence-order" ? " (lower-confidence signal — no explicit <parentStep> or physical nesting was found; relies on declared execution order only)" : ""}.`,
      `→ AttributeDiscount → PricingSettings relationship: ${psResolved.mechanism}${psResolved.mechanism === "sequence-order" ? " (lower-confidence signal)" : ""}.`,
    ].join("\n"),
  );

  ctx.onProgress?.("template-retrieved");

  client.logDebug("xml-diagnostic", `[ListPrice selected] ${describeOccurrenceForDiagnostics(lpMatch)}`);
  client.logDebug("xml-diagnostic", `[PricingSettings selected] ${describeOccurrenceForDiagnostics(psMatch)}`);
  client.logDebug("xml-diagnostic", "→ Extracting AttributeDiscount implementation from the selected donor.");
  client.logDebug("xml-diagnostic", `✓ AttributeDiscount structure extracted: ${describeOccurrenceForDiagnostics(adNode)}`);

  // §Donor inspection (Parts 1/13) — log the donor's OWN, REAL output Parameter(s) verbatim, searched
  // recursively through ListPrice's whole subtree. Never assume a specific name (e.g. "NetUnitPrice") —
  // a real donor may publish org-specific output names (confirmed live: e.g.
  // ItemContractDiscountType/ItemContractDiscountValue/ItemContractPrice/IsContracted). Neither this
  // step nor AttributeDiscount's InputUnitPrice binding is ever patched — both are used 100% verbatim.
  const donorLpOutputs = getAllParameterBlocksRecursive(lpMatch.full).filter(p => isOutputParam(p.block) && getTagValue(p.block, "type") === "Parameter");
  const donorLpOutputValues = donorLpOutputs.map(p => getParamValue(p.block)).filter((v): v is string => !!v);
  client.logDebug("xml-diagnostic", `[Donor ListPrice inspection] ${describeOccurrenceForDiagnostics(lpMatch)}`);

  const lpLookup = {
    lookUpId: getAnyParamValueByName(lpMatch.full, "LookUpId"),
    lookUpApiName: getAnyParamValueByName(lpMatch.full, "LookUpApiName"),
    lookUpName: getAnyParamValueByName(lpMatch.full, "LookUpName"),
  };
  if (!lpLookup.lookUpId) warnings.push("Template ListPrice step has no LookUpId — the post-deploy Decision Table dataset refresh will be skipped.");

  const declaredVars = new Set(extractFlatBlocks(donorFileXml, "variables").map(b => getTagValue(b, "name")).filter((n): n is string => !!n));

  // §Complete-donor-hierarchy architecture — PricingSettings and ListPrice are used 100% VERBATIM from
  // the donor. Nothing about them is ever patched — only AttributeDiscount is.
  const psXml = psMatch.full;
  const lpXml = lpMatch.full;

  // §Pricing-waterfall self-consistency + alignment (Parts 9/10/13, refined by live evidence) — read
  // the donor's REAL InputUnitPrice binding via a RECURSIVE whole-subtree search (never assumed to be a
  // direct child of the outer step). Salesforce's real Attribute-Based Price convention requires
  // InputUnitPrice to reference the EXACT value ListPrice publishes.
  const donorAdInputUnitPrice = getAnyParamValueByName(adNode.full, "InputUnitPrice");
  const listPriceOutputValidation = {
    donorOutputs: donorLpOutputValues,
    generatedOutputs: donorLpOutputValues, // identical — ListPrice is never patched
    outputCount: donorLpOutputValues.length,
    valid: donorLpOutputValues.length > 0,
  };
  if (donorLpOutputValues.length === 0) {
    fatalErrors.push(
      `ListPrice (name="${lpMatch.name ?? "(unknown)"}") publishes no output Parameter at all, searched recursively through its whole subtree — AttributeDiscount's InputUnitPrice binding would have nothing real to consume. This is the donor's own structure, unmodified — no output was invented to work around it.`,
    );
  }
  const targetInputUnitPriceValue = resolveTargetInputUnitPriceValue(donorAdInputUnitPrice, donorLpOutputValues);
  const inputUnitPriceNeedsAlignment = !!donorAdInputUnitPrice && !!targetInputUnitPriceValue && donorAdInputUnitPrice !== targetInputUnitPriceValue;
  if (donorLpOutputValues.length > 1) {
    client.logDebug(
      "xml-diagnostic",
      `[Pricing Waterfall — semantic output selection] ListPrice outputs: [${donorLpOutputValues.join(", ")}]. Selected price output: ${targetInputUnitPriceValue ?? "(none resolved)"}${targetInputUnitPriceValue ? ` (${targetInputUnitPriceValue === donorAdInputUnitPrice ? "matches the donor's own existing binding" : `priority match against [${UNIT_PRICE_SEMANTIC_PRIORITY.join(", ")}]`})` : ""}.`,
    );
  }
  if (!donorAdInputUnitPrice) {
    fatalErrors.push("AttributeDiscount has no InputUnitPrice parameter (or it has no value) anywhere in its subtree, searched recursively — cannot verify it consumes a real ListPrice output. No synthetic binding was manufactured.");
  } else if (!targetInputUnitPriceValue) {
    fatalErrors.push(
      `AttributeDiscount.InputUnitPrice="${donorAdInputUnitPrice}" does not match any of ListPrice's ${donorLpOutputValues.length} published output(s): [${donorLpOutputValues.join(", ")}], and none of the known unit-price-semantic output names (${UNIT_PRICE_SEMANTIC_PRIORITY.join(", ")}) are published either — refusing to guess which output is correct.`,
    );
  } else if (inputUnitPriceNeedsAlignment) {
    client.logDebug(
      "xml-diagnostic",
      `[Pricing Waterfall alignment] AttributeDiscount.InputUnitPrice="${donorAdInputUnitPrice}" does not match the selected published output "${targetInputUnitPriceValue}" — will be corrected in-place on the selected branch only, using the exact value ListPrice already publishes (never a synthesized/invented value).`,
    );
  } else if (donorLpOutputValues.length > 0) {
    client.logDebug("xml-diagnostic", `AttributeDiscount.InputUnitPrice → ListPrice.${donorAdInputUnitPrice} (already consistent — unmodified).`);
  }

  // §Own-fields-only patching (Part 8) — split the selected AttributeDiscount occurrence into its OWN
  // fields (patched) and its nested children, if any (preserved completely untouched, byte-for-byte).
  const { ownPart: adOwnOriginal, nestedAndClose: adNestedAndClose } = splitOwnFromNested(adNode.full);
  let adOwnPatched = adOwnOriginal;
  adOwnPatched = patchA_stripProductLiterals(adOwnPatched);
  adOwnPatched = patchC_preserveScheduleId(adOwnOriginal, adOwnPatched, warnings);
  adOwnPatched = patchD_normalizeMappings(adOwnPatched, declaredVars, warnings);
  if (inputUnitPriceNeedsAlignment && targetInputUnitPriceValue) {
    const aligned = setOrInsertParameterValue(adOwnPatched, "InputUnitPrice", targetInputUnitPriceValue, { input: true });
    adOwnPatched = aligned.xml;
    if (aligned.applied) {
      client.logDebug("xml-diagnostic", `[Pricing Waterfall alignment] AttributeDiscount.InputUnitPrice patched: "${donorAdInputUnitPrice}" → "${targetInputUnitPriceValue}".`);
    } else {
      fatalErrors.push(`Could not align AttributeDiscount.InputUnitPrice to "${targetInputUnitPriceValue}" — no existing InputUnitPrice parameter and no <customElement> to nest a new one into.`);
    }
  }
  // §Root-cause/live-org fix — NO re-parenting happens here anymore, and the `<parentStep>` tag itself is
  // never touched by any patch (AD_MAPPINGS/Patch A/C/D operate on `<parameters>`/`<customElement>` blocks
  // only) — it survives verbatim from the donor into `adXml`, whatever value (or absence) it originally
  // had. `lpMatch`/`psMatch` above were resolved via whichever real mechanism actually proves the
  // connection (`<parentStep>` chain, physical nesting, or declared sequence order — see
  // `resolveAttributeBasedPricingDonor`) — this donor is used exactly as it already exists.
  const adXml = adOwnPatched + adNestedAndClose;
  client.logDebug("xml-diagnostic", `[Canvas composition] AttributeDiscount.parentStep ("${adNode.parentStep ?? "(none)"}") is unmodified — it already resolves to ListPrice ("${lpMatch.name ?? "(unnamed)"}") within the selected donor's own graph via ${lpResolved.mechanism}.`);

  // Finalize the structured pricing-waterfall result AFTER patching — `inputUnitPriceValue` reflects
  // what is ACTUALLY in the generated XML, never the pre-patch donor value once a correction was applied.
  const finalAdInputUnitPrice = getAnyParamValueByName(adXml, "InputUnitPrice");
  const attributeDiscountInputBinding = {
    listPriceOutputValues: donorLpOutputValues,
    inputUnitPriceValue: finalAdInputUnitPrice,
    originalInputUnitPriceValue: donorAdInputUnitPrice,
    wasPatched: inputUnitPriceNeedsAlignment,
    valid: !!finalAdInputUnitPrice && donorLpOutputValues.includes(finalAdInputUnitPrice),
  };
  if (!attributeDiscountInputBinding.valid && donorAdInputUnitPrice && targetInputUnitPriceValue) {
    fatalErrors.push(
      `AttributeDiscount.InputUnitPrice="${finalAdInputUnitPrice ?? "(none)"}" still does not match ListPrice's published output "${targetInputUnitPriceValue}" after alignment — the patch did not take effect as expected.`,
    );
  }

  // §Part 10 — validate the selected branch actually has every input a real Attribute-Based Pricing
  // AttributeDiscount step needs, searched recursively through its whole subtree (never assumed to be a
  // direct child) — read-only, never invents a missing value.
  const adFieldMap = collectFieldMap(adNode);
  for (const required of ["ProductId", "ProductSellingModelId", "AttributeName", "AttributeValue", "IsPriceImpacting", "PriceAdjustmentScheduleId", "LookUpName", "LookUpId", "LookUpApiName"]) {
    if (!adFieldMap.has(required)) {
      fatalErrors.push(`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] is missing required input "${required}" — this donor occurrence cannot be used for Attribute-Based Pricing.`);
    }
  }
  const adOwnOutputs = getAllParameterBlocksRecursive(adNode.full).filter(p => isOutputParam(p.block));
  if (adOwnOutputs.length === 0) {
    fatalErrors.push(`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] publishes no output Parameter at all.`);
  }
  client.logDebug(
    "xml-diagnostic",
    `[Part 10 branch validation] Selected [${adNode.occurrenceIndex}] — required inputs present: ${["ProductId", "ProductSellingModelId", "AttributeName", "AttributeValue", "IsPriceImpacting", "PriceAdjustmentScheduleId", "LookUpName", "LookUpId", "LookUpApiName"].filter(r => adFieldMap.has(r)).join(", ")}; own outputs: ${adOwnOutputs.map(p => `${getParamName(p.block)}=${getParamValue(p.block)}`).join(", ") || "none"}.`,
  );

  client.logDebug("xml-diagnostic", [
    "[Pricing Waterfall — final binding]",
    "ListPrice Outputs (donor-verbatim, never patched, recursive search):",
    ...(describeParameters(lpXml, b => isOutputParam(b) && getTagValue(b, "type") === "Parameter").length > 0
      ? describeParameters(lpXml, b => isOutputParam(b) && getTagValue(b, "type") === "Parameter")
      : ["  (none)"]),
    `AttributeDiscount Inputs (InputUnitPrice, recursive search — ${attributeDiscountInputBinding.wasPatched ? `patched from "${attributeDiscountInputBinding.originalInputUnitPriceValue}"` : "unmodified"}):`,
    ...(describeParameters(adXml, b => getParamName(b) === "InputUnitPrice").length > 0
      ? describeParameters(adXml, b => getParamName(b) === "InputUnitPrice")
      : ["  (none)"]),
  ].join("\n"));

  fatalErrors.push(...postBuildGuard([
    { actionType: "PricingSettings", ownXml: psXml },
    { actionType: "ListPrice", ownXml: lpXml },
    { actionType: "AttributeDiscount", ownXml: adOwnPatched },
  ]));

  const stepStructureReports = [
    compareStepStructure(psMatch, psXml, "PricingSettings"),
    compareStepStructure(lpMatch, lpXml, "ListPrice"),
    compareStepStructure(adNode, adXml, "AttributeDiscount"),
  ];
  client.logDebug("xml-diagnostic", stepStructureReports.map(r => r.reportText).join("\n\n"));
  for (const report of stepStructureReports) {
    if (!report.structurallyValid) {
      fatalErrors.push(`Step-level structural mismatch on "${report.actionType}" — ${[...report.invalidPlacements, ...report.missingNodes.map(n => `Missing node ${n}`)].join(" ")}`);
    }
  }

  const validation = validateAttributeCanvas({ psXml, lpXml, adOwnXml: adOwnPatched }, observedActionTypes, declaredVars);
  fatalErrors.push(...validation.fatal);
  warnings.push(...validation.warnings);

  const stepStats: CanvasStepStats[] = [
    { actionType: "PricingSettings", parameterCount: countParameters(psXml) },
    { actionType: "ListPrice", parameterCount: countParameters(lpXml) },
    { actionType: "AttributeDiscount", parameterCount: countParameters(adXml) },
  ];

  // §Root-cause fix — compose the final canvas by PRUNING the single selected donor down to exactly what
  // this AttributeDiscount branch needs: its own subtree, its physical container ancestors, and every step
  // on its real <parentStep> chain (which already includes PricingSettings/ListPrice, proven above) — via
  // `pricingCanvasPruning.ts`'s reachability analysis. This removes every OTHER pricing-type branch the
  // donor may bundle (FormulaBasedPricing/ManualDiscount/etc.) without ever inventing a cross-donor link.
  // The patched AttributeDiscount content is spliced into the donor bytes FIRST — a pure content
  // replacement at its own original span, never adding/removing a <steps> tag, so occurrence indexes stay
  // stable — and THEN the tree is pruned, exactly as `pricingCanvasPruning.ts`'s own file-level doc
  // anticipated ("prune BOTH the generated tree AND filter its own donor-comparison baseline to the SAME
  // kept-occurrence set").
  client.logDebug("xml-diagnostic", "→ Composing Attribute-Based Pricing canvas.");
  const patchedDonorFileXml = donorFileXml.slice(0, adNode.start) + adXml + donorFileXml.slice(adNode.end);
  const patchedDonorGraph = extractStepGraph(patchedDonorFileXml);
  // §Live-org fix — psMatch/lpMatch were resolved via WHICHEVER real mechanism actually proved the
  // connection (possibly sequence-order alone, which the pruning reachability walk below has no way to
  // discover on its own) — their occurrence indexes are passed explicitly so pruning can never strip away
  // the very PricingSettings/ListPrice this branch was proven to depend on.
  const requiredComputation = computeRequiredOccurrenceIndexes(patchedDonorGraph, adNode.occurrenceIndex, [psMatch.occurrenceIndex, lpMatch.occurrenceIndex]);
  if (!requiredComputation) {
    fatalErrors.push(`Patched AttributeDiscount occurrence [${adNode.occurrenceIndex}] could not be re-located in the patched donor graph — this should be unreachable (patching never adds/removes a <steps> tag); refusing to guess.`);
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size, stepStructureReports,
      listPriceOutputValidation, attributeDiscountInputBinding, attributeDiscountBranchSelection, donorExtractionDeterministic,
    };
  }
  client.logDebug(
    "xml-diagnostic",
    `[Pruning] Keeping ${requiredComputation.keptRootBranches.length} root branch(es), removing ${requiredComputation.removedRootBranches.length} unrelated root branch(es): ${requiredComputation.removedRootBranches.map(b => `[${b.rootOccurrenceIndex}] ${b.name ?? "(unnamed)"} (${b.actionType ?? "?"}, ${b.physicalStepCount} step(s))`).join(", ") || "(none — nothing to prune)"}.`,
  );
  const finalFileXml = pruneXmlToRequiredOccurrences(patchedDonorFileXml, requiredComputation.removedRootBranches, patchedDonorGraph);
  // §The SAME required/removed set applied to the UNPATCHED donor bytes too — this is the donor-comparison
  // BASELINE `compareExpressionSetSchema` uses further below, so it is compared against a donor pruned to
  // the SAME shape as the final canvas, never the donor's full, much larger, bundled-procedure form (which
  // would otherwise spuriously report a root child-count/order mismatch on every single build).
  const prunedDonorFileXmlForComparison = pruneXmlToRequiredOccurrences(donorFileXml, requiredComputation.removedRootBranches, donorGraph);

  const generatedGraph = extractStepGraph(finalFileXml);
  const expectedFinalStepCount = generatedGraph.length;

  // §FINAL-XML SEMANTIC VALIDATION (CRITICAL STRUCTURAL RULE) — every check below validates the FINAL
  // PRUNED graph on its own semantic terms — never by comparing root indexes or content hashes against the
  // donor's own (much larger, pre-prune) layout.
  const finalPricingSettingsCount = generatedGraph.filter(n => n.actionType === "PricingSettings").length;
  const finalListPriceCount = generatedGraph.filter(n => n.actionType === "ListPrice").length;
  const finalAttributeDiscountCount = generatedGraph.filter(n => n.actionType === "AttributeDiscount").length;
  if (finalPricingSettingsCount !== 1) fatalErrors.push(`Final pruned Expression Set has ${finalPricingSettingsCount} PricingSettings step(s) — expected exactly 1.`);
  if (finalListPriceCount !== 1) fatalErrors.push(`Final pruned Expression Set has ${finalListPriceCount} ListPrice step(s) — expected exactly 1.`);
  if (finalAttributeDiscountCount !== 1) fatalErrors.push(`Final pruned Expression Set has ${finalAttributeDiscountCount} AttributeDiscount step(s) — expected exactly 1.`);
  client.logDebug("xml-diagnostic", `✓ Final steps: PricingSettings → ListPrice → AttributeDiscount (${generatedGraph.length} physical step(s) total, pruned from donor "${donorSelection.fullName}" — ${donorGraph.length} physical step(s) originally).`);

  const finalActionTypesArr = [...new Set(generatedGraph.map(n => n.actionType).filter((v): v is string => !!v))];
  const unrelatedActionTypesRemaining = finalActionTypesArr.filter(t => SHARED_SIGNAL_ACTION_TYPES.has(t));
  if (unrelatedActionTypesRemaining.length > 0) {
    client.logDebug("xml-diagnostic", `✕ Unrelated pricing branches present in pruned canvas: [${unrelatedActionTypesRemaining.join(", ")}]`);
    fatalErrors.push(
      `The pruned Attribute-Based Pricing Expression Set still contains unrelated pricing-type action(s): ${unrelatedActionTypesRemaining.join(", ")}. This means pruning could not safely remove them (most likely a genuine <parentStep> dependency from the kept branch) — refusing to deploy rather than force-remove something still referenced.`,
    );
  } else {
    client.logDebug("xml-diagnostic", `✓ Unrelated pricing branches removed: ${[...SHARED_SIGNAL_ACTION_TYPES].join(", ")} (pruned away — not required by the kept PricingSettings/ListPrice/AttributeDiscount chain).`);
  }

  // §PARENTSTEP SAFETY — self-contained: every node's parentStep must resolve to a name that exists
  // SOMEWHERE in this SAME final pruned graph.
  const dangling = findDanglingParentStepReferences(generatedGraph, patchedDonorGraph);
  if (dangling.length > 0) {
    for (const d of dangling) {
      client.logDebug("xml-diagnostic", `✕ Dangling parentStep in composed canvas\n  step=${d.pathLabel} (name="${d.name ?? "(none)"}")\n  occurrenceIndex=${d.occurrenceIndex}\n  parentStep=${d.parentStep}`);
    }
    fatalErrors.push(
      `${dangling.length} dangling <parentStep> reference(s) in the composed canvas — refusing to deploy. Dangling: ${dangling.map(d => `[${d.occurrenceIndex}] ${d.pathLabel} parentStep="${d.parentStep}"`).join("; ")}.`,
    );
  } else {
    client.logDebug("xml-diagnostic", "✓ No dangling parentStep references — every parentStep in the composed canvas resolves.");
  }

  const duplicateStepNamesArr = (() => {
    const counts = new Map<string, number>();
    for (const n of generatedGraph) if (n.name) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
    return [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  })();
  client.logDebug(
    "xml-diagnostic",
    duplicateStepNamesArr.length > 0
      ? `Duplicate generated step names (informational only): ${duplicateStepNamesArr.join(", ")}`
      : "No duplicate generated step names.",
  );

  const danglingByOccurrence = new Set(dangling.map(d => d.occurrenceIndex));
  const parentStepValidation: ParentStepValidationEntry[] = generatedGraph.map(n => ({
    occurrenceIndex: n.occurrenceIndex, pathLabel: n.pathLabel, actionType: n.actionType, stepName: n.name,
    parentStep: n.parentStep, parentExists: !danglingByOccurrence.has(n.occurrenceIndex),
    // §Not a donor-comparison field under this architecture (no single donor to compare the composed
    // tree against) — trivially true whenever the referential-integrity check itself passed.
    matchesDonor: !danglingByOccurrence.has(n.occurrenceIndex),
    valid: !danglingByOccurrence.has(n.occurrenceIndex),
  }));

  const hierarchyComparison = {
    donorStepCount: donorGraph.length,
    generatedStepCount: generatedGraph.length,
    missingDonorOccurrences: [] as number[],
    hierarchyMatches: fatalErrors.length === 0,
    donorTree: renderPhysicalTree(donorGraph),
    generatedTree: renderPhysicalTree(generatedGraph),
  };
  client.logDebug("xml-diagnostic", [
    "Expression Set composition (selected donor → final pruned canvas)",
    `Donor total steps: ${hierarchyComparison.donorStepCount}`,
    `Final pruned total steps: ${hierarchyComparison.generatedStepCount}`,
    "",
    "SELECTED DONOR (physical nesting):",
    hierarchyComparison.donorTree || "(empty)",
    "",
    "FINAL PRUNED CANVAS (physical nesting):",
    hierarchyComparison.generatedTree || "(empty)",
  ].join("\n"));

  const canvasComposition: NonNullable<CanvasBuildResult["canvasComposition"]> = {
    donorFullName: donorSelection.fullName,
    donorFileName: donorSelection.fileName,
    donorPhysicalStepCount: donorGraph.length,
    prunedRootBranchCount: requiredComputation.removedRootBranches.length,
    finalActionTypes: finalActionTypesArr,
    finalPhysicalStepCount: generatedGraph.length,
  };

  if (fatalErrors.length > 0) {
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison,
      donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }

  // §Uniqueness — every identifier Salesforce enforces as unique across the org must NEVER be copied
  // verbatim from the donor. Scoped strictly to the envelope OUTSIDE the COMPLETE steps region (every
  // top-level step) — a step parameter's own `<name>`/`<label>` is legitimate donor-derived content that
  // must never be touched; only the envelope around the steps is rewritten, and only the identifier
  // VALUES change — no tag is added, removed, or reordered.
  const generatedRootSpans = generatedGraph.filter(n => n.depth === 0);
  if (generatedRootSpans.length === 0) {
    fatalErrors.push("The base canvas has no top-level <steps> element — there is no safe, non-guessed position to identify the steps region at.");
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison, donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }
  const stepsRegionStart = generatedRootSpans[0].start;
  const stepsRegionEnd = generatedRootSpans[generatedRootSpans.length - 1].end;
  let envelopeBefore = finalFileXml.slice(0, stepsRegionStart);
  let stepsRegionXml = finalFileXml.slice(stepsRegionStart, stepsRegionEnd);
  let envelopeAfter = finalFileXml.slice(stepsRegionEnd);

  // §Id handling (Part 16) — every step's own `<id>` is stripped, since the whole file is being
  // deployed as a brand-new ExpressionSetDefinition and Salesforce assigns its own new Id on create
  // regardless. `<id>` never occurs inside a `<parameters>`/`<customElement>` block anywhere in this
  // document type (verified empirically below, not assumed): the count of `<id>` tags removed is logged
  // against the number of physical steps, so any unexpected mismatch is visible rather than silent.
  const idTagsBefore = (stepsRegionXml.match(/<id>[\s\S]*?<\/id>/g) ?? []).length;
  stepsRegionXml = stepsRegionXml.replace(/<id>[\s\S]*?<\/id>/g, "");
  client.logDebug("xml-diagnostic", `[Id handling] ${idTagsBefore} <id> tag(s) found and stripped across ${generatedGraph.length} physical step(s) in the steps region.`);

  // A `<variables>` element's own `<name>`/`<description>` (the variable's IDENTITY, legitimately
  // unique per-variable in the donor) lives in this same envelope region and would otherwise be caught
  // by the generic `<name>`/`<description>` regeneration below, overwriting EVERY variable's name with
  // the SAME apiName. Every `<variables>...</variables>` block is swapped out for an opaque,
  // never-XML-shaped placeholder token BEFORE any regeneration runs, and restored byte-for-byte
  // afterward.
  const protectedVariableBlocks = new Map<string, string>();
  function protectBlocks(text: string, tagName: string): string {
    return text.replace(new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`, "g"), match => {
      const token = `__PROTECTED_${tagName.toUpperCase()}_BLOCK_${protectedVariableBlocks.size}__`;
      protectedVariableBlocks.set(token, match);
      return token;
    });
  }
  function restoreBlocks(text: string): string {
    let out = text;
    for (const [token, original] of protectedVariableBlocks) out = out.split(token).join(original);
    return out;
  }
  envelopeBefore = protectBlocks(envelopeBefore, "variables");
  envelopeAfter = protectBlocks(envelopeAfter, "variables");

  const regeneratedIdentifiers: RegeneratedIdentifier[] = [];
  /** Replaces every occurrence of `<tag>...</tag>` in both envelope halves with a value computed from
   * the donor's own old value — never the donor's literal value itself — recording each one for the
   * pre-deployment report. A tag that doesn't occur in this org's donor is simply never matched. */
  function regenerateEnvelopeTag(tag: string, computeNewValue: (donorValue: string) => string): void {
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    const apply = (text: string) => text.replace(pattern, (_match, donorValue: string) => {
      const newValue = computeNewValue(donorValue);
      regeneratedIdentifiers.push({ tag, donorValue, newValue });
      return `<${tag}>${newValue}</${tag}>`;
    });
    envelopeBefore = apply(envelopeBefore);
    envelopeAfter = apply(envelopeAfter);
  }

  const newLabel = escapeXml(ctx.procedureName);
  regenerateEnvelopeTag("label", () => newLabel);
  if (ctx.description) {
    const newDescription = escapeXml(ctx.description);
    regenerateEnvelopeTag("description", () => newDescription);
  }
  regenerateEnvelopeTag("fullName", donorValue => {
    // §Widened to also capture an optional literal "V"/"v" letter as part of the separator — this org's
    // own real base donor is itself named "pricingProcedure_V1" (a "_V{n}" suffix, not a bare "_{n}"),
    // confirmed by live evidence across many turns. The narrower `[._-](\d+)$` pattern never matched that
    // shape at all (there's no `._-` character immediately before the "1" — it's preceded by "V"), so it
    // silently fell through to the no-suffix branch, meaning every generated fullName carried NO version
    // suffix regardless of `ctx.versionNumber` — a second, independent contributor to the confirmed live
    // bug where every repeated build reused the exact same identity as the already-active version.
    const suffixMatch = donorValue.match(/^(.*?)([._-][Vv]?)(\d+)$/);
    if (!suffixMatch) return escapeXml(ctx.apiName);
    const separator = suffixMatch[2];
    // §Section 6 — when the caller resolved a next-version-number, the generated version's OWN identity
    // targets that version instead of reproducing whatever numeric suffix the donor happened to have.
    // This is the actual fix for repeated creation always updating the same existing version in place:
    // that always regenerated the SAME suffix (the donor's own), which Salesforce necessarily reads back
    // as "this is the same version." Never inferred from a string here — `ctx.versionNumber` is the
    // caller's own org-verified next-version resolution, computed before this function ever runs.
    const suffixDigits = ctx.versionNumber !== undefined ? String(ctx.versionNumber) : suffixMatch[3];
    return escapeXml(`${ctx.apiName}${separator}${suffixDigits}`);
  });
  regenerateEnvelopeTag("developerName", () => escapeXml(ctx.apiName));
  regenerateEnvelopeTag("name", () => escapeXml(ctx.apiName));
  regenerateEnvelopeTag("expressionSetDefinition", () => escapeXml(ctx.apiName));

  /** §Part 1/2/9 — `<versionNumber>`/`<rank>` injection is extracted into `versionEnvelopeFields.ts` as
   * a standalone, directly-unit-testable pure function (see that file for why) — the resolved
   * `nextVersionResolution` values are the SINGLE source of truth for both, never the donor's own
   * leftover values. Its `regeneratedIdentifiers`/`warnings` are merged into this function's own
   * running lists so every existing report/log/collision-check downstream sees them exactly as if they
   * had been produced inline (no behavior change to anything else in this function). */
  const deployApiVersionNumber = Number.parseFloat(normalizeApiVersionNumber(client.apiVersion));
  const versionInjection = injectVersionNumberAndRank(
    envelopeBefore, envelopeAfter, { versionNumber: ctx.versionNumber, rank: ctx.rank }, deployApiVersionNumber,
  );
  envelopeBefore = versionInjection.envelopeBefore;
  envelopeAfter = versionInjection.envelopeAfter;
  regeneratedIdentifiers.push(...versionInjection.regeneratedIdentifiers);
  warnings.push(...versionInjection.warnings);

  envelopeBefore = restoreBlocks(envelopeBefore);
  envelopeAfter = restoreBlocks(envelopeAfter);

  const assembledFileXml = envelopeBefore + stepsRegionXml + envelopeAfter;

  /**
   * §Part 1/9 — reparse the EXACT bytes about to be serialized for the version's own envelope-level
   * identity/lifecycle fields, scoped to ONLY `envelopeBefore`/`envelopeAfter` — deliberately EXCLUDING
   * `stepsRegionXml`. A step (e.g. one bound to a decision table) can legitimately contain its own
   * unrelated field that happens to share a tag name (a row/priority ordering value, for instance) —
   * scanning the FULL assembled file for the first `<rank>...</rank>` match risks matching one of those
   * instead of the version's own envelope tag, a false positive that would incorrectly block a deploy
   * that was actually correct (or, worse, silently approve one that WASN'T). This is the authoritative,
   * correctly-scoped answer to "what did we actually put in the outbound version envelope" — callers
   * must use THIS, never re-derive it themselves via their own regex over the full `finalFileXml`.
   */
  const envelopeOnlyForVerification = envelopeBefore + envelopeAfter;
  function extractOutboundEnvelopeTag(tag: string): string | null {
    const m = envelopeOnlyForVerification.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1] : null;
  }
  const outboundVersionFields: OutboundVersionFields = {
    fullName: extractOutboundEnvelopeTag("fullName"),
    // versionNumber/rank come from `versionEnvelopeFields.ts`'s own read-back (computed the moment
    // those two tags were written, from the exact same envelope text) rather than re-extracted here —
    // one source of truth, never two independently-computed answers to the same question.
    versionNumber: versionInjection.outboundVersionNumber,
    rank: versionInjection.outboundRank,
    expressionSetDefinition: extractOutboundEnvelopeTag("expressionSetDefinition"),
  };

  // Pre-deployment validation: no two `<variables><name>` values may collide — the hard backstop that
  // guarantees deployment is never even attempted if a duplicate somehow still exists.
  interface VariableNameOccurrence { name: string; description: string | null }
  const variableOccurrences: VariableNameOccurrence[] = extractFlatBlocks(assembledFileXml, "variables").map(block => ({
    name: getTagValue(block, "name") ?? "(no <name> found)",
    description: getTagValue(block, "description"),
  }));
  const variablesByName = new Map<string, VariableNameOccurrence[]>();
  for (const v of variableOccurrences) {
    const list = variablesByName.get(v.name) ?? [];
    list.push(v);
    variablesByName.set(v.name, list);
  }
  const duplicateVariableNames = [...variablesByName.entries()].filter(([, list]) => list.length > 1);
  const duplicateVariableReport = [
    "==================================================",
    "DUPLICATE EXPRESSION SET VARIABLE NAMES",
    "==================================================",
    duplicateVariableNames.length === 0
      ? "(none — every <variables><name> in the generated file is unique)"
      : "",
    ...duplicateVariableNames.flatMap(([name, list]) => [
      `Variable Name: ${name}`,
      `Occurrences: ${list.length}`,
      `Variable Descriptions: ${list.map(v => v.description ?? "(none)").join(" | ")}`,
      "",
    ]),
    "==================================================",
  ].filter(Boolean).join("\n");
  client.logDebug("xml-diagnostic", duplicateVariableReport);
  if (duplicateVariableNames.length > 0) {
    fatalErrors.push(
      `${duplicateVariableNames.length} Expression Set variable name(s) are duplicated in the generated XML — Salesforce's Metadata API rejects this with "Variable name already exists. Please enter a different name." Deployment refused.\n\n${duplicateVariableReport}`,
    );
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison, donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }

  // §Defect 1 fix — `versionNumber` (and `label`/`description`) are metadata that DESCRIBE a version,
  // never a unique IDENTITY for it: Salesforce's own documented `ExpressionSetDefinitionVersion` schema
  // has NO uniqueness constraint on `versionNumber` in isolation — a brand-new Pricing Procedure's own V1
  // legitimately having the SAME `versionNumber` ("1") as a donor that also happens to be a V1 is not a
  // collision at all, it's simply both being a first version. Only the fields Salesforce's Metadata API
  // actually enforces uniqueness on — the identity-bearing name/reference fields — can ever produce a
  // real collision. `fullName`'s OWN numeric suffix (which does encode a version number, but as part of a
  // compound identity string together with `ctx.apiName`) is correctly still checked here: two DIFFERENT
  // apiNames can never collide there since the base name differs, and Section 6's version-number injection
  // (above) already guarantees this run's OWN suffix targets the resolved next version, not the donor's.
  const IDENTITY_BEARING_TAGS = new Set(["fullName", "developerName", "name", "expressionSetDefinition"]);
  const donorCollisions = regeneratedIdentifiers.filter(r => IDENTITY_BEARING_TAGS.has(r.tag) && r.donorValue.trim() !== "" && r.newValue === r.donorValue);
  const nonIdentityMatches = regeneratedIdentifiers.filter(r => !IDENTITY_BEARING_TAGS.has(r.tag) && r.donorValue.trim() !== "" && r.newValue === r.donorValue);
  const donorFullName = regeneratedIdentifiers.find(r => r.tag === "fullName")?.donorValue ?? "(none found in donor)";
  const generatedFullName = regeneratedIdentifiers.find(r => r.tag === "fullName")?.newValue ?? "(none generated)";
  client.logDebug("xml-diagnostic", [
    "==================================================",
    "EXPRESSION SET DEFINITION — UNIQUE IDENTIFIER VALIDATION",
    "==================================================",
    `ExpressionSetDefinition Name: ${newLabel}`,
    `Version FullName(s): ${regeneratedIdentifiers.filter(r => r.tag === "fullName").map(r => r.newValue).join(", ") || "(none found in donor)"}`,
    `Version Label(s): ${regeneratedIdentifiers.filter(r => r.tag === "label").map(r => r.newValue).join(", ") || "(none found in donor)"}`,
    `ExpressionSetDefinition Reference (versions/expressionSetDefinition): ${regeneratedIdentifiers.filter(r => r.tag === "expressionSetDefinition").map(r => r.newValue).join(", ") || "(none found in donor)"}`,
    `Internal Name value(s): ${regeneratedIdentifiers.filter(r => r.tag === "name").map(r => r.newValue).join(", ") || "(none found in donor)"}`,
    `DeveloperName value(s): ${regeneratedIdentifiers.filter(r => r.tag === "developerName").map(r => r.newValue).join(", ") || "(none found in donor)"}`,
    "",
    "Donor -> Generated (every occurrence; only fullName/developerName/name/expressionSetDefinition are identity-bearing — versionNumber/label/description matching the donor is expected, not a collision):",
    ...(regeneratedIdentifiers.length > 0
      ? regeneratedIdentifiers.map(r => `  <${r.tag}> donor="${r.donorValue}" -> generated="${r.newValue}"${r.newValue === r.donorValue ? (IDENTITY_BEARING_TAGS.has(r.tag) ? "  *** IDENTITY COLLISION ***" : "  (non-identity field, matching donor is fine)") : ""}`)
      : ["  (no unique-identifier tags found in this org's donor envelope — nothing to regenerate)"]),
    "==================================================",
  ].join("\n"));
  for (const m of nonIdentityMatches) {
    client.logDebug("xml-diagnostic", `✓ Donor ${m.tag}="${m.donorValue}" is not an identity collision (${m.tag} is descriptive version metadata, not a unique identity field).`);
  }
  if (donorCollisions.length > 0) {
    const collisionDetail = donorCollisions.map(c =>
      `  field=${c.tag} donor_value="${c.donorValue}" generated_value="${c.newValue}" donor_fullName="${donorFullName}" generated_fullName="${generatedFullName}"`,
    ).join("\n");
    fatalErrors.push(
      `Refusing to deploy — ${donorCollisions.length} identity-bearing regenerated identifier(s) are still identical to the donor template's own value:\n${collisionDetail}\nThis only happens when the new Pricing Procedure's own name/API name coincidentally matches the donor template's — rename the Pricing Procedure (or its API Name) so it cannot collide with the donor before retrying.`,
    );
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison, donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }

  const schemaComparison = compareExpressionSetSchema(prunedDonorFileXmlForComparison, assembledFileXml);
  client.logDebug("xml-diagnostic", schemaComparison.reportText);
  const combinedSchemaReport = [schemaComparison.reportText, ...stepStructureReports.map(r => r.reportText)].join("\n\n");
  if (!schemaComparison.structurallyValid) {
    fatalErrors.push(...schemaComparison.issues);
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes],
      stepStats, variableCount: declaredVars.size, schemaReport: combinedSchemaReport, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison, donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }

  // §Gate C — final payload reparse (Part 4/10/14/18): reparse the EXACT final serialized XML about to
  // be deployed, from scratch, and validate it against the FINAL CANVAS CONTRACT — never against the
  // donor's own (pre-prune) layout. The target AttributeDiscount is located in THIS reparsed graph by
  // actionType (exactly one expected), NEVER by comparing occurrence index against `adNode.occurrenceIndex`
  // — that index is an identity belonging to the DONOR's own (potentially much larger) graph; the final
  // pruned canvas has its OWN, unrelated occurrence numbering assigned fresh by `extractStepGraph` over the
  // NEW bytes. Comparing them is structurally impossible by construction — `adNode.occurrenceIndex` is
  // provenance information only ("this branch came from this occurrence in the donor"), never an
  // expectation about where anything ends up in the final canvas. `expected.parentStep` is `adNode`'s own,
  // UNMODIFIED `<parentStep>` value — no re-parenting ever happens under this architecture.
  const finalGraph = extractStepGraph(assembledFileXml);
  const expectedFinalInputUnitPrice = attributeDiscountInputBinding.inputUnitPriceValue;
  const expectedAdParentStep = adNode.parentStep;
  const gateC = validateFinalComposedCanvas(finalGraph, {
    inputUnitPrice: expectedFinalInputUnitPrice, parentStep: expectedAdParentStep, stepCount: expectedFinalStepCount,
  });
  client.logDebug(
    "xml-diagnostic",
    `[Gate C — final payload reparse] Source AttributeDiscount occurrence [${adNode.occurrenceIndex}] from "${donorSelection.fileName}" — provenance only, never expected as a final occurrence index. ` +
    `Final canvas (reparsed from the actual serialized bytes): PricingSettings x${gateC.counts.pricingSettings}, ListPrice x${gateC.counts.listPrice}, AttributeDiscount x${gateC.counts.attributeDiscount}, total steps=${finalGraph.length} (expected ${expectedFinalStepCount}). ` +
    `Final AttributeDiscount ${gateC.finalTargetNode ? "FOUND" : "NOT FOUND / not exactly one"}; parentStep="${gateC.finalTargetNode?.parentStep ?? "(none)"}" (expected "${expectedAdParentStep ?? "(none)"}"); InputUnitPrice="${gateC.finalTargetNode ? getAnyParamValueByName(gateC.finalTargetNode.full, "InputUnitPrice") ?? "(none)" : "(none)"}" (expected "${expectedFinalInputUnitPrice ?? "(none)"}").`,
  );
  fatalErrors.push(...gateC.failures);
  if (fatalErrors.length > 0) {
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes],
      stepStats, variableCount: declaredVars.size, schemaReport: combinedSchemaReport, stepStructureReports,
      parentStepValidation, duplicateStepNames: duplicateStepNamesArr,
      listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison, donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    };
  }
  client.logDebug("xml-diagnostic", "→ Re-parsing final serialized Expression Set.");
  client.logDebug("xml-diagnostic", `✓ Final canvas contains exactly ${finalGraph.length} pricing step(s).`);
  client.logDebug("xml-diagnostic", "✓ Final PricingSettings found.");
  client.logDebug("xml-diagnostic", "✓ Final ListPrice found.");
  client.logDebug("xml-diagnostic", "✓ Final AttributeDiscount found.");
  client.logDebug("xml-diagnostic", `✓ Final AttributeDiscount.InputUnitPrice = ${expectedFinalInputUnitPrice}.`);
  client.logDebug("xml-diagnostic", "✓ Final AttributeDiscount parentStep resolves.");
  client.logDebug("xml-diagnostic", "✓ No unrelated pricing branches remain.");
  client.logDebug("xml-diagnostic", "✓ Final serialized Expression Set passed composition validation.");

  return {
    success: true,
    finalFileXml: assembledFileXml,
    finalSteps: [
      { actionType: "PricingSettings", xml: psXml },
      { actionType: "ListPrice", xml: lpXml },
      { actionType: "AttributeDiscount", xml: adXml },
    ],
    // §The deployed file's envelope/naming-convention shape comes from the single selected donor — this
    // is the file whose folder/suffix packaging convention `deploy.ts` should mirror.
    donorFileName: donorSelection.fileName,
    lpLookup,
    observedActionTypes: [...observedActionTypes],
    stepStats,
    variableCount: declaredVars.size,
    schemaReport: combinedSchemaReport,
    stepStructureReports,
    parentStepValidation,
    duplicateStepNames: duplicateStepNamesArr,
    listPriceOutputValidation, attributeDiscountInputBinding, hierarchyComparison,
    donorExtractionDeterministic, attributeDiscountBranchSelection, canvasComposition,
    generatedIdentifiers: regeneratedIdentifiers.map(r => ({ tag: r.tag, value: r.newValue })),
    outboundVersionFields,
    fatalErrors: [],
    warnings,
  };
}
