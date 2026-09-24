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
  getNestedCustomElementParameterBlocks,
  removeNestedCustomElementParameters,
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
import { SHARED_SIGNAL_ACTION_TYPES, resolveAttributeBasedPricingDonor, resolveConnectedAncestor, buildNoCoherentDonorDiagnostic, type ConnectionMechanism } from "./donorInspection";
import { injectVersionNumberAndRank, regenerateVersionedFullName } from "./versionEnvelopeFields";

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

/**
 * The generic bindings this engine actually knows how to wire — see the file-level "Deviation" note above.
 *
 * §Root-cause fix (live evidence — Salesforce deploy rejection "Select list filter as the first element in
 * list group. Please remove Attribute Discount Entries.") — a hash-verified capture of this donor's real raw
 * XML proved `ProductId`, `ProductSellingModelId`, `LookUpName`, `LookUpId`, `LookUpApiName`,
 * `IsContractEnabled`, `HideWaterfall`, `sectionCount`, `selectedFunction` and `IsRealTime` are NOT
 * per-attribute/org-specific literals (the class this allowlist was built to exclude) — they are the
 * SAME 10 field names, present identically, across EVERY Decision-Table-lookup pricing step in this donor
 * (AttributeDiscount, BundleDiscount, VolumeDiscount, VolumeTierDiscount, the Contract-Pricing ListPrice
 * lookup) — i.e. the standard, universal shape of an RCA Decision-Table "Select" lookup configuration
 * (Salesforce's own "list group"/"list filter" concept), never invented per org. Their absence from this
 * allowlist meant `shouldStripAttributeDiscountParam` removed them unconditionally, producing an
 * AttributeDiscount step with no lookup configuration at all — exactly the malformed shape Salesforce
 * rejected. `IsContracted` (the paired output) was never at risk — outputs are already exempt from
 * stripping — but is listed here too for documentation completeness.
 */
const RECOGNIZED_PARAM_NAMES = new Set([
  "InputUnitPrice", "EffectiveFrom", "EffectiveTo", "Quantity",
  "PriceAdjustmentScheduleId", "PriceAdjustmentScheduleName", "PriceAdjustmentScheduleIds", "PriceAdjustmentScheduleType",
  "AttributeName", "AttributeValue", "IsPriceImpacting", "AdjustmentTypeField", "AdjustmentValueField",
  "ProductId", "ProductSellingModelId", "LookUpName", "LookUpId", "LookUpApiName",
  "IsContractEnabled", "HideWaterfall", "sectionCount", "selectedFunction", "IsRealTime", "IsContracted",
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

/**
 * §Live-org fix (Rev_Mgmt_Default_Pricing_Procedure2_V1) — LAST-RESORT ListPrice pairing, used only when
 * `resolveConnectedAncestor` finds no mechanism (parentStep chain, physical nesting, variable binding, or
 * sequence order) connecting the selected AttributeDiscount branch to a ListPrice occurrence — a real,
 * confirmed live shape: two ListPrice branches (Price Book / Contract) that publish outputs named
 * `ListPrice`/`ItemContractPrice`, neither matching AttributeDiscount's `InputUnitPrice="NetUnitPrice"`,
 * and an AttributeDiscount whose `<parentStep>` names a `ListContainer` (canvas placement, not a ListPrice
 * step). Reuses the SAME `IsContractEnabled`/contract-flavored-naming signal `selectAttributeBasedDiscountBranch`
 * already uses to disambiguate MULTIPLE AttributeDiscount occurrences — applied here to pair the CHOSEN
 * AttributeDiscount with the ListPrice occurrence whose own field naming agrees on contract-vs-standard.
 * Returns `node: null` (never a guess) unless the match is genuinely unambiguous: either exactly one
 * ListPrice occurrence exists at all (no pairing decision needed), or exactly one shares the same
 * contract-flavor as the AttributeDiscount branch.
 */
/**
 * §Live-org fix (real donor XML captured via the donor-xml-diagnostic tool, `Rev_Mgmt_Default_Pricing_
 * Procedure2_V1`) — the HIGHEST-CONFIDENCE ListPrice-pairing mechanism: the donor explicitly declares
 * `IsContractEnabled` as a literal boolean parameter on BOTH the AttributeDiscount branch AND each
 * ListPrice occurrence, and the captured XML proves exact equality between them correctly identifies the
 * paired branch for BOTH AttributeDiscount occurrences (AD [13] IsContractEnabled=true -> ListPrice [60]
 * IsContractEnabled=true, LookUpApiName=Contract_Pricing_Entries_Decision_Table; AD [14]
 * IsContractEnabled=false -> ListPrice [63] IsContractEnabled=false, LookUpApiName=
 * Price_Book_Entry_Decision_Table_v2). This is NOT a name/label/parentStep/sequence signal — it is a
 * direct, explicit `<name>IsContractEnabled</name>...<value>true|false</value>` parameter binding the
 * donor itself declares on both sides, present in the raw XML captured from the org, never inferred.
 *
 * Returns a discriminated outcome, never just `node | null`, because "the mechanism doesn't apply here"
 * and "the mechanism applies but the data conflicts with itself" must be handled differently by the
 * caller: `not-applicable` (AttributeDiscount has no IsContractEnabled, or there are no ListPrice
 * occurrences at all) is safe to fall through to weaker, pre-existing signals; `conflict` (zero matches,
 * 2+ matches, or ANY ListPrice occurrence has a missing/non-literal IsContractEnabled value) means this
 * high-confidence mechanism found real, unresolvable evidence problems and MUST stop the whole resolution
 * — falling through to a weaker signal after detecting a conflict here would risk silently picking one of
 * the very candidates this mechanism just proved indistinguishable or contradictory, which is exactly the
 * "never silently select one" behavior this exists to prevent.
 */
export type ContractEnabledBindingOutcome =
  | { status: "resolved"; node: PhysicalStepNode; reason: string }
  | { status: "not-applicable"; reason: string }
  | { status: "conflict"; reason: string };

export function resolveListPriceByContractEnabledBinding(graph: PhysicalStepNode[], adNode: PhysicalStepNode): ContractEnabledBindingOutcome {
  const adRaw = collectFieldMap(adNode).get("IsContractEnabled") ?? null;
  if (adRaw === null) {
    return { status: "not-applicable", reason: `AttributeDiscount [${adNode.occurrenceIndex}] declares no IsContractEnabled parameter — this mechanism does not apply.` };
  }
  const adNorm = adRaw.trim().toLowerCase();
  if (adNorm !== "true" && adNorm !== "false") {
    return { status: "conflict", reason: `AttributeDiscount [${adNode.occurrenceIndex}]'s IsContractEnabled value ("${adRaw}") is not a literal true/false — refusing to guess.` };
  }
  const adBool = adNorm === "true";

  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  if (listPriceNodes.length === 0) {
    return { status: "not-applicable", reason: "No ListPrice occurrence exists anywhere in this donor — this mechanism does not apply." };
  }

  const withValues = listPriceNodes.map(lp => ({ lp, raw: collectFieldMap(lp).get("IsContractEnabled") ?? null }));
  const invalid = withValues.filter(v => v.raw === null || !["true", "false"].includes(v.raw.trim().toLowerCase()));
  if (invalid.length > 0) {
    return {
      status: "conflict",
      reason: `${invalid.length} of ${listPriceNodes.length} ListPrice occurrence(s) have a missing or non-literal IsContractEnabled value (${invalid.map(v => `[${v.lp.occurrenceIndex}]=${v.raw ?? "(none)"}`).join(", ")}) — insufficient evidence to trust this mechanism for any candidate; refusing to guess.`,
    };
  }

  const matches = withValues.filter(v => (v.raw!.trim().toLowerCase() === "true") === adBool);
  if (matches.length === 0) {
    return {
      status: "conflict",
      reason: `0 of ${listPriceNodes.length} ListPrice occurrence(s) declare IsContractEnabled=${adBool} (all declare the opposite) — refusing to guess.`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "conflict",
      reason: `ambiguous: ${matches.length} ListPrice occurrences share IsContractEnabled=${adBool} ([${matches.map(m => m.lp.occurrenceIndex).join(", ")}]) — refusing to guess which one.`,
    };
  }
  const winner = matches[0];
  return {
    status: "resolved",
    node: winner.lp,
    reason: `Matched ListPrice [${winner.lp.occurrenceIndex}] via the donor's own explicit IsContractEnabled=${adBool} binding — a direct parameter declared on both AttributeDiscount [${adNode.occurrenceIndex}] and this ListPrice occurrence, unambiguous among ${listPriceNodes.length} candidate(s).`,
  };
}

export function resolveListPriceByContractFlavorFallback(graph: PhysicalStepNode[], adNode: PhysicalStepNode): { node: PhysicalStepNode | null; reason: string } {
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  if (listPriceNodes.length === 0) return { node: null, reason: "No ListPrice occurrence exists anywhere in this donor." };
  if (listPriceNodes.length === 1) {
    return { node: listPriceNodes[0], reason: "Exactly one ListPrice occurrence exists in this donor — unambiguous regardless of connectivity signal." };
  }

  const adFields = collectFieldMap(adNode);
  const adIsContractEnabledRaw = adFields.get("IsContractEnabled") ?? null;
  if (adIsContractEnabledRaw === null) {
    return {
      node: null,
      reason: `${listPriceNodes.length} ListPrice occurrences exist in this donor, and AttributeDiscount [${adNode.occurrenceIndex}] declares no IsContractEnabled flag to disambiguate by — refusing to guess which one it uses.`,
    };
  }
  const adIsContractEnabled = adIsContractEnabledRaw.toLowerCase() === "true";

  const matches = listPriceNodes.filter(lp => {
    const fields = collectFieldMap(lp);
    const contractFlavored = [...fields.entries()].some(([k, v]) => /contract/i.test(k) || /contract/i.test(v));
    return contractFlavored === adIsContractEnabled;
  });
  if (matches.length !== 1) {
    return {
      node: null,
      reason: `${listPriceNodes.length} ListPrice occurrences exist; AttributeDiscount [${adNode.occurrenceIndex}]'s IsContractEnabled=${adIsContractEnabled} matched ${matches.length} of them by contract-flavored field naming (expected exactly 1) — refusing to guess which one it uses.`,
    };
  }
  return {
    node: matches[0],
    reason: `Matched ListPrice [${matches[0].occurrenceIndex}] via IsContractEnabled=${adIsContractEnabled} against its own contract-flavored field naming — a lower-confidence, last-resort signal used only because no direct connectivity mechanism (parentStep chain, physical nesting, variable binding, or sequence order) resolved.`,
  };
}

/**
 * §Live diagnostics (Rev_Mgmt_Default_Pricing_Procedure2_V1) — a per-candidate evidence dump comparing
 * `adNode` against EVERY ListPrice occurrence in the donor, so a rejected/ambiguous resolution shows
 * exactly what was checked and why each candidate did or didn't match, instead of a bare "not found."
 * Purely diagnostic (never used to make a selection decision itself — `resolveConnectedAncestor` and
 * `resolveListPriceByContractFlavorFallback` remain the sole decision-makers); "a field value equals..."
 * is an approximate signal here (this function doesn't distinguish input/output the way the real
 * resolvers do) precisely so it stays honest about being informational, not authoritative.
 *
 * §Nothing is discarded — every field printed here (including `stepType`/`label`, which `PhysicalStepNode`
 * does not pre-extract into a named property) is read on demand via `getTagValue(node.full, ...)` from
 * the COMPLETE raw XML `extractStepGraph` already retains verbatim for every node (`.full`/`.content`).
 * The parser was never the bottleneck — no bytes are thrown away — only which fields get a NAMED property
 * is limited; anything else is still reachable this way if a future investigation needs it. Caveat:
 * `getTagValue` returns the FIRST match anywhere in the given text, so if a node ever has a NESTED
 * `<steps>` child that also declares its own `<stepType>`, this could read the child's instead of the
 * node's own — a real but low-probability imprecision for ListPrice/AttributeDiscount specifically (they
 * don't typically nest further `<steps>`), acceptable here since this is diagnostic-only, never decisive.
 */
function buildListPriceEvidenceTable(graph: PhysicalStepNode[], adNode: PhysicalStepNode): string {
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const adFields = collectFieldMap(adNode);
  const adInputUnitPrice = adFields.get("InputUnitPrice") ?? null;
  const adIsContractEnabledRaw = adFields.get("IsContractEnabled") ?? null;
  const adIsContractEnabled = adIsContractEnabledRaw === null ? null : adIsContractEnabledRaw.toLowerCase() === "true";
  const adStepType = getTagValue(adNode.content, "stepType");
  const adLabel = getTagValue(adNode.content, "label");
  const siblingsOfAd = adNode.parentStep ? graph.filter(n => n.parentStep === adNode.parentStep && n.occurrenceIndex !== adNode.occurrenceIndex) : [];

  // §Live investigation — one remaining REAL (non-heuristic) data-flow path that hadn't been checked: does
  // ANY ListPrice's own OUTPUT value get consumed as one of PricingSettings' own INPUT values? If so, that
  // is genuine one-hop-removed proof (ListPrice -> PricingSettings input -> PricingSettings' own NetUnitPrice
  // output -> AttributeDiscount), the SAME kind of exact output/input value match already trusted for the
  // direct `variable-binding`/`price-waterfall-variable` signals — never a name/label/stepType comparison.
  // Reported here as DIAGNOSTIC ONLY (never auto-selected) until an actual match is confirmed against real
  // donor bytes; this codebase does not wire unconfirmed signals into automatic resolution.
  const pricingSettingsNodes = graph.filter(n => n.actionType === "PricingSettings");
  const psInputBindings = pricingSettingsNodes.flatMap(ps =>
    getAllParameterBlocksRecursive(ps.full).filter(p => isInputParam(p.block)).map(p => ({ name: getParamName(p.block), value: getParamValue(p.block) })),
  );
  const psInputSummary = pricingSettingsNodes.length === 0
    ? "(no PricingSettings occurrence found in this donor)"
    : psInputBindings.length === 0
      ? "(PricingSettings has no input parameters anywhere in its subtree)"
      : psInputBindings.map(b => `${b.name ?? "(none)"}=${b.value ?? "(none)"}`).join(", ");

  const header = [
    `[ListPrice evidence] AttributeDiscount [${adNode.occurrenceIndex}] (name=${adNode.name ?? "(none)"}, label=${adLabel ?? "(none)"}, stepType=${adStepType ?? "(not present in raw XML)"}, parentStep=${adNode.parentStep ?? "(none)"}, sequenceNumber=${adNode.sequenceNumber ?? "(none)"}, InputUnitPrice=${adInputUnitPrice ?? "(none)"}, IsContractEnabled=${adIsContractEnabledRaw ?? "(none)"}):`,
    `  Sibling steps (same <parentStep>, i.e. same container as this AttributeDiscount): ${siblingsOfAd.length === 0 ? "(none)" : siblingsOfAd.map(s => `[${s.occurrenceIndex}] ${s.actionType ?? "(no actionType)"} name=${s.name ?? "(none)"}`).join("; ")}`,
    `  PricingSettings own input bindings (checked for a ListPrice-output match below — a real, non-heuristic data-flow path, not yet confirmed): ${psInputSummary}`,
  ].join("\n");

  if (listPriceNodes.length === 0) return `${header}\n  NO ListPrice occurrence exists anywhere in this donor.`;

  const rows = listPriceNodes.map(lp => {
    const lpFields = collectFieldMap(lp);
    const lpStepType = getTagValue(lp.content, "stepType");
    const lpLabel = getTagValue(lp.content, "label");
    const lpOutputValues = getAllParameterBlocksRecursive(lp.full).filter(p => isOutputParam(p.block)).map(p => getParamValue(p.block)).filter((v): v is string => !!v);
    // §Deliberately NOT match signals — an earlier turn treated "same <parentStep>" as proof of a real
    // branch relationship, then found it directly contradicted this file's own already-established
    // finding about THIS donor: "<parentStep> naming a ListContainer/ListGroup governs canvas PLACEMENT,
    // not pricing DATA dependency" (see donorInspection.ts's removed `shared-container-sibling` signal).
    // `name`/`label`/`stepType` are reported purely as RAW FACTS for a human to judge — never as automated
    // verdicts, per explicit instruction not to reason from name similarity (e.g. "ContractId"/"Product2Id").
    const sameParentStep = !!adNode.parentStep && lp.parentStep === adNode.parentStep;
    const fieldValueMatch = adInputUnitPrice !== null && [...lpFields.values()].includes(adInputUnitPrice);
    const contractFlavored = [...lpFields.entries()].some(([k, v]) => /contract/i.test(k) || /contract/i.test(v));
    const contractMatch = adIsContractEnabled !== null && contractFlavored === adIsContractEnabled;
    const feedsIntoPricingSettings = lpOutputValues.some(v => psInputBindings.some(b => b.value === v));
    const verdict = fieldValueMatch
      ? "possible match — a field value equals AttributeDiscount's InputUnitPrice (see resolveConnectedAncestor for the authoritative input/output-aware check)"
      : feedsIntoPricingSettings
        ? "possible match — this ListPrice's own output value is consumed as one of PricingSettings' own input values (a real one-hop data-flow path, not yet wired into automatic resolution)"
        : contractMatch
          ? `possible match — contract-flavored naming (${contractFlavored}) agrees with IsContractEnabled (${adIsContractEnabled})`
          : "no proven match via any currently-trusted signal";
    return `  ListPrice [${lp.occurrenceIndex}] (name=${lp.name ?? "(none)"}, label=${lpLabel ?? "(none)"}, stepType=${lpStepType ?? "(not present in raw XML)"}, parentStep=${lp.parentStep ?? "(none)"}${sameParentStep ? " [same parentStep as AttributeDiscount — NOT treated as proof, see note above]" : ""}, sequenceNumber=${lp.sequenceNumber ?? "(none)"}, outputs=[${lpOutputValues.join(", ") || "none"}]) — ${verdict}`;
  });
  return [header, ...rows].join("\n");
}

export interface PricingFlowAncestorsResult {
  success: boolean;
  lpMatch: PhysicalStepNode | null;
  psMatch: PhysicalStepNode | null;
  lpMechanism: string | null;
  psMechanism: string | null;
  fatalErrors: string[];
  warnings: string[];
  evidenceLog: string;
}

/**
 * §Diagnostic log format requested alongside `resolveListPriceByContractEnabledBinding` — prints every
 * ListPrice candidate's own IsContractEnabled value and whether it was rejected or matched, so a human can
 * verify the decision without re-deriving it from `evidenceLog`'s more general table.
 */
function buildContractEnabledDiagnosticLog(graph: PhysicalStepNode[], adNode: PhysicalStepNode, outcome: ContractEnabledBindingOutcome): string {
  const adRaw = collectFieldMap(adNode).get("IsContractEnabled") ?? "(none)";
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  const lines = [
    "[ListPrice resolution]",
    `AttributeDiscount [${adNode.occurrenceIndex}]`,
    `  IsContractEnabled=${adRaw}`,
    "",
    "Candidates:",
  ];
  if (listPriceNodes.length === 0) {
    lines.push("  (no ListPrice occurrences exist in this donor)");
  } else {
    for (const lp of listPriceNodes) {
      const raw = collectFieldMap(lp).get("IsContractEnabled") ?? "(none)";
      const isMatch = outcome.status === "resolved" && outcome.node.occurrenceIndex === lp.occurrenceIndex;
      lines.push(`  ListPrice [${lp.occurrenceIndex}] IsContractEnabled=${raw} → ${isMatch ? "MATCH" : "rejected"}`);
    }
  }
  lines.push("");
  if (outcome.status === "resolved") {
    lines.push("Resolved:", `  ListPrice [${outcome.node.occurrenceIndex}]`, "  confidence=explicit-contract-enabled-binding");
  } else {
    lines.push(`Not resolved via this mechanism (${outcome.status}): ${outcome.reason}`);
  }
  return lines.join("\n");
}

/**
 * §Extracted (unchanged logic apart from the new Priority 1 below) — the EXACT resolution
 * `buildAttributeCanvas` uses to pair the selected AttributeDiscount branch with its PricingSettings/
 * ListPrice ancestors, factored out so it is directly unit-testable without mocking the entire deploy
 * pipeline (per explicit instruction: "test the actual canvas-building selection, do not only unit-test a
 * helper while the real canvas path still fails"). Priority, evidence-based end to end:
 *   1. `resolveListPriceByContractEnabledBinding` — the donor's own explicit `IsContractEnabled` literal
 *      binding, proven from REAL captured donor XML (`Rev_Mgmt_Default_Pricing_Procedure2_V1`) to correctly
 *      identify both branches. HIGH CONFIDENCE. A `conflict` outcome stops the whole resolution here —
 *      never falls through, since that would risk silently picking one of candidates just proven
 *      indistinguishable/contradictory. Only a `not-applicable` outcome (the donor doesn't declare this
 *      parameter at all) falls through to (2).
 *   2. `resolveConnectedAncestor`'s 5 signals (parentStep-chain, physical-nesting, variable-binding,
 *      price-waterfall-variable, sequence-order), then `resolveListPriceByContractFlavorFallback` as the
 *      final, lowest-confidence attempt — unchanged from before this turn.
 * Never fabricates a match — `success: false` with a complete evidence dump when nothing resolves.
 * §Note: a `shared-container-sibling` signal ("two steps declaring the same <parentStep> belong to the
 * same branch") was added and then REMOVED in an earlier turn — it directly contradicted this exact
 * donor's own already-established finding that <parentStep> here governs canvas placement, not data
 * dependency (see donorInspection.ts). The explicit IsContractEnabled binding above is NOT that kind of
 * inference — it is a literal parameter value, not a structural/positional guess.
 */
/** Mechanisms `resolveConnectedAncestor` can return for ListPrice that constitute real, direct,
 * mechanical proof of a data-flow/structural relationship — an explicit `<parentStep>` reference, actual
 * XML nesting, or an exact InputUnitPrice==published-output variable match. Deliberately excludes
 * `sequence-order` (relative execution order only — the donor's own doc comment on
 * `resolveConnectedAncestor` calls this out as "does not PROVE a data dependency"), which stays ranked
 * BELOW the conditional `IsContractEnabled` signal, not above it. */
const STRONG_LIST_PRICE_MECHANISMS = new Set<ConnectionMechanism>(["parentStep-chain", "physical-nesting", "variable-binding"]);

/**
 * §Root-cause fix (offline+live forensic analysis, 2nd org — `Laptop_Attribute_Pricing_Timeout_Fix_Test_V1`)
 * — real, hash-verified donor XML captured from this org proved `IsContractEnabled` is NOT a reliable
 * branch discriminator here: the donor has exactly ONE ListPrice occurrence (nothing to disambiguate
 * between at all), and its `IsContractEnabled=false` merely differs from AttributeDiscount's
 * `IsContractEnabled=true` as two independently-configured step properties — completely unconnected to
 * which ListPrice branch is correct, since there IS no other branch. Meanwhile the donor's OWN explicit
 * data-flow proof is unambiguous and was present the whole time: ListPrice publishes an output whose
 * `<value>` is `NetUnitPrice`, and AttributeDiscount's `InputUnitPrice` reads exactly that same
 * `NetUnitPrice` variable — the exact match `resolveViaVariableBinding`/`resolveConnectedAncestor`
 * (`variable-binding` mechanism) already existed to prove, correctly, for this donor. The bug was never in
 * that mechanism — it was in this function's PRIORITY ORDER: `IsContractEnabled` ran FIRST and its
 * `conflict` outcome was an absolute hard stop, so the strong, correct `variable-binding` proof was never
 * even attempted.
 *
 * Fixed generally (no org/donor/product/name/Id of any kind referenced): `resolveConnectedAncestor`'s
 * strong-tier mechanisms (`parentStep-chain`, `physical-nesting`, `variable-binding` — real structural/
 * data-flow proof) are now tried FIRST. If one resolves unambiguously, it is used directly —
 * `IsContractEnabled` is still computed and logged for transparency, but never blocks a resolution the
 * donor's own structure already proves. Only when no strong mechanism resolves (0 or 2+ ambiguous
 * candidates, or no parentStep/nesting connection either) does `IsContractEnabled` become the deciding
 * CONDITIONAL signal — preserving its original role and its original "conflict = hard stop, never
 * silently fall through" behavior exactly, for donors where it's genuinely needed (a real prior donor has
 * MULTIPLE ListPrice occurrences where `variable-binding` cannot disambiguate at all — see this function's
 * git history / `resolveListPriceByContractEnabledBinding`'s own doc comment). `sequence-order` (weakest)
 * still ranks below `IsContractEnabled`, exactly as the pre-existing 5-signal priority already established.
 */
export function resolvePricingFlowAncestors(donorGraph: PhysicalStepNode[], adNode: PhysicalStepNode, donorFullName: string): PricingFlowAncestorsResult {
  const warnings: string[] = [];
  const evidenceLog = buildListPriceEvidenceTable(donorGraph, adNode);

  // §Priority 1 — real, direct structural/data-flow evidence (see STRONG_LIST_PRICE_MECHANISMS above).
  // Computed once, reused below whether or not it resolves strongly.
  const lpResolvedFirst = resolveConnectedAncestor(donorGraph, adNode, "ListPrice");
  const hasStrongLpEvidence = lpResolvedFirst.node !== null && STRONG_LIST_PRICE_MECHANISMS.has(lpResolvedFirst.mechanism);

  const contractEnabledOutcome = resolveListPriceByContractEnabledBinding(donorGraph, adNode);
  const contractEnabledLog = buildContractEnabledDiagnosticLog(donorGraph, adNode, contractEnabledOutcome);

  if (hasStrongLpEvidence) {
    const psResolvedForStrongMatch = resolveConnectedAncestor(donorGraph, adNode, "PricingSettings");
    warnings.push(`ℹ Resolved ListPrice via direct structural/data-flow evidence (${lpResolvedFirst.mechanism}) — the donor's own IsContractEnabled binding was checked but is not the deciding signal here (see below).`);
    warnings.push(contractEnabledLog);
    if (!psResolvedForStrongMatch.node) {
      return {
        success: false, lpMatch: lpResolvedFirst.node, psMatch: null, lpMechanism: lpResolvedFirst.mechanism, psMechanism: null, warnings, evidenceLog,
        fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}" resolves to ListPrice ("${lpResolvedFirst.node!.name ?? "(unnamed)"}") via ${lpResolvedFirst.mechanism}, but never resolves to a PricingSettings step via any known mechanism — a coherent Attribute-Based Pricing flow requires both.\n\n${evidenceLog}`],
      };
    }
    return {
      success: true, lpMatch: lpResolvedFirst.node, psMatch: psResolvedForStrongMatch.node,
      lpMechanism: lpResolvedFirst.mechanism, psMechanism: psResolvedForStrongMatch.mechanism,
      fatalErrors: [], warnings, evidenceLog,
    };
  }

  // §Priority 2 — no strong direct evidence resolved ListPrice. Fall back to the donor's own explicit
  // IsContractEnabled binding (CONDITIONAL evidence). A `conflict` outcome (ambiguous, zero-match, or any
  // candidate's IsContractEnabled is missing/non-literal) STOPS the whole resolution here — never falls
  // through to a weaker signal, which would risk silently picking one of the very candidates this
  // mechanism just proved indistinguishable or contradictory.
  if (contractEnabledOutcome.status === "conflict") {
    return {
      success: false, lpMatch: null, psMatch: null, lpMechanism: null, psMechanism: null, warnings, evidenceLog,
      fatalErrors: [
        `Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}": no strong direct data-flow evidence (parentStep chain, physical nesting, or an exact InputUnitPrice/published-output variable match) resolved a ListPrice candidate, and the donor's own explicit IsContractEnabled binding found a conflict that must not be silently worked around: ${contractEnabledOutcome.reason}\n\n${contractEnabledLog}\n\n${evidenceLog}`,
      ],
    };
  }
  if (contractEnabledOutcome.status === "resolved") {
    const psResolvedForContractMatch = resolveConnectedAncestor(donorGraph, adNode, "PricingSettings");
    warnings.push(contractEnabledLog);
    if (!psResolvedForContractMatch.node) {
      return {
        success: false, lpMatch: contractEnabledOutcome.node, psMatch: null, lpMechanism: "explicit-contract-enabled-binding", psMechanism: null, warnings, evidenceLog,
        fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}" resolves to ListPrice ("${contractEnabledOutcome.node.name ?? "(unnamed)"}") via its explicit IsContractEnabled binding, but never resolves to a PricingSettings step via any known mechanism — a coherent Attribute-Based Pricing flow requires both.\n\n${evidenceLog}`],
      };
    }
    return {
      success: true, lpMatch: contractEnabledOutcome.node, psMatch: psResolvedForContractMatch.node,
      lpMechanism: "explicit-contract-enabled-binding", psMechanism: psResolvedForContractMatch.mechanism,
      fatalErrors: [], warnings, evidenceLog,
    };
  }
  // contractEnabledOutcome.status === "not-applicable" — fall through to the pre-existing signal chain
  // (the weak sequence-order/none result already computed above as lpResolvedFirst, then the last-resort
  // contract-flavor fallback), unchanged from before this fix.
  warnings.push(contractEnabledLog);

  const psResolved = resolveConnectedAncestor(donorGraph, adNode, "PricingSettings");
  let lpMatch = lpResolvedFirst.node;
  const psMatch = psResolved.node;
  let lpMechanismLabel: string = lpResolvedFirst.mechanism;

  if (!lpMatch && psMatch) {
    const fallback = resolveListPriceByContractFlavorFallback(donorGraph, adNode);
    if (fallback.node) {
      lpMatch = fallback.node;
      lpMechanismLabel = "contract-flavor-fallback";
      warnings.push(`ℹ ListPrice paired via last-resort contract-flavor matching, not a direct connectivity signal: ${fallback.reason}`);
    } else {
      return {
        success: false, lpMatch: null, psMatch, lpMechanism: null, psMechanism: psResolved.mechanism, warnings, evidenceLog,
        fatalErrors: [
          `Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}" resolves to PricingSettings (via the shared price-waterfall variable) but does not resolve to any ListPrice step via any known mechanism, and the last-resort contract-flavor fallback could not disambiguate either: ${fallback.reason}\n\n${evidenceLog}`,
        ],
      };
    }
  }

  if (!lpMatch) {
    return {
      success: false, lpMatch: null, psMatch, lpMechanism: null, psMechanism: psResolved.mechanism, warnings, evidenceLog,
      fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}" does not resolve to a ListPrice step via any known mechanism (<parentStep> chain, physical nesting, shared-container sibling, variable binding, or sequence order) — this should be unreachable given the donor-selection stage already proved connectivity; refusing to guess.\n\n${evidenceLog}`],
    };
  }
  if (!psMatch) {
    return {
      success: false, lpMatch, psMatch: null, lpMechanism: lpMechanismLabel, psMechanism: null, warnings, evidenceLog,
      fatalErrors: [`Selected AttributeDiscount branch [${adNode.occurrenceIndex}] in donor "${donorFullName}" resolves to ListPrice ("${lpMatch.name ?? "(unnamed)"}") but never resolves to a PricingSettings step via any known mechanism — a coherent Attribute-Based Pricing flow requires both.\n\n${evidenceLog}`],
    };
  }

  return { success: true, lpMatch, psMatch, lpMechanism: lpMechanismLabel, psMechanism: psResolved.mechanism, fatalErrors: [], warnings, evidenceLog };
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

/**
 * §Live-org fix — the ONE predicate deciding whether an AttributeDiscount parameter is a safe, generic,
 * reusable binding or a donor-specific literal that must never survive into a newly-generated procedure.
 * Applied to BOTH top-level parameters AND parameters nested inside `<customElement>` — a donor can carry
 * a product/attribute-specific literal (e.g. an ad-hoc parameter literally named after one specific
 * attribute, with its value hardcoded, from however that donor was originally hand-configured in
 * Salesforce) OR a stale creation-time Id (e.g. a PriceAdjustmentScheduleId parameter whose `<value>` is
 * a literal Id instead of the generic context-variable reference) in EITHER location — `PriceAdjustmentScheduleId`
 * itself is required to live nested (see Patch C), so nested content can never be assumed safe just
 * because top-level content is checked.
 */
// §Live-org fix (real donor evidence) — a real Salesforce record Id (15 or 18 alphanumeric characters, no
// separators) is NEVER a valid variable/constant reference — this is the one shape Patch A must always
// strip from PriceAdjustmentScheduleId, regardless of name-recognition. A real donor's own constant/
// context-variable name (e.g. "AttributePASIdConstant", "ItemContractAttributePasId") is inherently
// unenumerable in advance (see the file-level "generic allowlist" note) and is never this shape.
function looksLikeSalesforceIdLiteral(value: string): boolean {
  return /^[a-zA-Z0-9]{15}$/.test(value) || /^[a-zA-Z0-9]{18}$/.test(value);
}

function shouldStripAttributeDiscountParam(block: string): boolean {
  if (isOutputParam(block)) return false; // never touch outputs
  const name = getParamName(block);
  // InputUnitPrice is the pricing-waterfall binding — preserved verbatim from the donor regardless of
  // its bound value, never stripped/renamed (see file-level "Pricing-waterfall binding" note).
  if (name === "InputUnitPrice") return false;
  const value = getParamValue(block);
  // §Live-org fix (real donor evidence, Rev_Mgmt_Default_Pricing_Procedure2_V1) — PriceAdjustmentScheduleId
  // is entirely owned by Patch C (verbatim-clone-or-decline-to-fabricate) and the self-reference check in
  // `validateAttributeCanvas` — Patch A must never second-guess its value against a hardcoded allowlist
  // (ABP_STANDARD_CTX/RECOGNIZED_PARAM_NAMES can never enumerate every real org's own constant/context-
  // variable name), only strip the ONE genuinely unsafe shape: a literal, stale Salesforce record Id.
  if (name && /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i.test(name)) {
    return !!value && looksLikeSalesforceIdLiteral(value);
  }
  if (!name || !RECOGNIZED_PARAM_NAMES.has(name)) return true; // unrecognized param name -> strip unconditionally
  // §Root-cause fix (live evidence — same deploy rejection as the RECOGNIZED_PARAM_NAMES comment above) —
  // the "is this value a recognized context variable" check only makes sense for a type=Parameter
  // (variable-REFERENCE) input; it is a category error for a type=Literal input, whose <value> is org/
  // decision-table DATA (a Salesforce Id, a Decision Table API name, a UI function name, a boolean/count),
  // never a variable name, and was NEVER going to appear in a context-variable allowlist. Applying this
  // check to Literal-typed lookup-configuration parameters (LookUpId/LookUpApiName/LookUpName/
  // IsContractEnabled/HideWaterfall/sectionCount/selectedFunction/IsRealTime) unconditionally stripped
  // them regardless of the RECOGNIZED_PARAM_NAMES fix above. Restricting this check to genuine
  // variable-reference inputs (`isInputParam(block) && type === "Parameter"`, AND not OR) preserves the
  // existing, already-correct behavior for AttributeName/AttributeValue/EffectiveFrom/etc. (all
  // type=Parameter) while letting Literal-typed values pass through verbatim once their name is recognized
  // — the same "preserve the donor's own real data, never second-guess it" treatment PriceAdjustmentScheduleId
  // already gets above.
  const isVariableReferenceInput = isInputParam(block) && getTagValue(block, "type") === "Parameter";
  if (isVariableReferenceInput && value && !ABP_STANDARD_CTX.has(value) && !RECOGNIZED_PARAM_NAMES.has(value)) return true; // bound to an unrecognized context var -> strip
  return false;
}

/* ── Patch A: strip product-specific literal bindings — both top-level AND customElement-nested (Patch C
 * later re-adds a clean, generic PriceAdjustmentScheduleId binding if this step removed a bad one). ── */
export function patchA_stripProductLiterals(ownPart: string): string {
  let result = removeTopLevelParameters(ownPart, shouldStripAttributeDiscountParam);
  result = removeNestedCustomElementParameters(result, shouldStripAttributeDiscountParam);
  return result;
}

/* ── Patch C: preserve PriceAdjustmentScheduleId verbatim, nested inside the donor's EXISTING <customElement> — never a freshly-created wrapper, never top-level. ── */
export function patchC_preserveScheduleId(originalOwnPart: string, patchedOwnPart: string, warnings: string[]): string {
  const scheduleRe = /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i;

  // §Live-deploy investigation (this turn) — Salesforce's real Metadata API rejected the deployed
  // AttributeDiscount's nested PriceAdjustmentScheduleId parameter with "isn't a valid variable name."
  // Static analysis alone cannot tell which of THREE structurally distinct paths through this function
  // produced the offending value for a given build (already-nested passthrough / verbatim top-level
  // clone / synthetic self-referential fallback) — each is reachable depending on what the SELECTED
  // donor's own template actually contains, which varies build to build. Rather than guess, every path
  // now unconditionally logs which branch fired and the exact value it leaves in place, so the next
  // live run's own warnings settle this with evidence instead of another round of static inference.
  const alreadyNestedBlock = getNestedCustomElementParameterBlocks(patchedOwnPart)
    .find(b => { const n = getParamName(b.block); return !!n && scheduleRe.test(n); });
  if (alreadyNestedBlock) {
    warnings.push(
      `ℹ [ScheduleId trace] PATH=already-nested-passthrough — the SELECTED donor's own AttributeDiscount step already had a nested PriceAdjustmentScheduleId parameter before this patch ran, so it was left completely untouched. name="${getParamName(alreadyNestedBlock.block)}" value="${getParamValue(alreadyNestedBlock.block)}". Raw block: ${alreadyNestedBlock.block}`,
    );
    return patchedOwnPart;
  }

  const originalTopLevelMatch = getTopLevelParameterBlocks(originalOwnPart).find(b => {
    const n = getParamName(b.block);
    return !!n && scheduleRe.test(n);
  });

  // Drop it from the top level if a patch happened to leave it there (wrong nesting level).
  const result = removeTopLevelParameters(patchedOwnPart, block => {
    const n = getParamName(block);
    return !!n && scheduleRe.test(n);
  });

  // §Root-cause fix (live evidence confirmed) — Salesforce's own deploy rejection ("PriceAdjustmentScheduleId
  // isn't a valid variable name") proved this fallback's prior behavior wrong: it manufactured
  // `value="PriceAdjustmentScheduleId"` — the value equal to the parameter's own name — whenever the
  // SELECTED donor had no PriceAdjustmentScheduleId binding anywhere to clone from. A `<value>` on an
  // input `<parameters>` of `type=Parameter` is a REFERENCE to an actually-declared variable, never a
  // literal; a self-referential value is never a valid reference unless the parameter's own name also
  // happens to be independently declared as a real envelope variable (checked, and enforced, by
  // `validateAttributeCanvas` below — never assumed safe here). This function has no way to safely
  // invent what a real donor's correct binding would be (see the file-level investigation notes on
  // "contract"/"constant"-flavored real donor values) — per explicit instruction, it must never fabricate
  // one. When no genuine donor binding exists, PriceAdjustmentScheduleId is left GENUINELY ABSENT — the
  // existing "AttributeDiscount has no PriceAdjustmentScheduleId parameter" fatal in `validateAttributeCanvas`
  // already stops the build for exactly this reason, with an honest cause instead of invalid XML reaching
  // Salesforce.
  if (!originalTopLevelMatch) {
    warnings.push(
      `✕ [ScheduleId trace] PATH=no-donor-binding-found — the SELECTED donor's AttributeDiscount step has NO PriceAdjustmentScheduleId binding anywhere (top-level or nested). A self-referential fallback (value=name) is NOT fabricated here, because that is exactly the shape Salesforce's Metadata API has been confirmed to reject as "isn't a valid variable name." Left genuinely unset — the build will fail fast below rather than deploy invalid XML. To fix: either select a donor whose AttributeDiscount step has a real PriceAdjustmentScheduleId binding, or determine this org's correct declared context-variable name for it and add it to this donor before cloning.`,
    );
    return result;
  }

  const paramBlockXml = originalTopLevelMatch.block; // verbatim — never synthesize a replacement when the template already had one

  warnings.push(
    `ℹ [ScheduleId trace] PATH=verbatim-top-level-clone — the SELECTED donor's AttributeDiscount step had PriceAdjustmentScheduleId at the top level (wrong nesting for deploy) and it was re-nested VERBATIM, unmodified. Raw block: ${originalTopLevelMatch.block}`,
  );

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
    // §Root-cause fix (this turn) — live evidence: a donor org's AttributeDiscount legitimately publishes
    // OUTPUT parameters under its own org-specific names (e.g. NetUnitPrice/Subtotal/IsContracted — the
    // donor's own already-working declaration of what this step computes and hands to whatever consumes
    // it downstream). `RECOGNIZED_PARAM_NAMES` was built to enumerate only the small set of INPUT bindings
    // this engine actively manages (see the file-level "Deviation" note) — it was never meant to be a
    // complete list of every legal AttributeDiscount parameter, and an output's real name is inherently
    // org-specific (there is no fixed, portable set to hardcode, exactly the same reasoning that already
    // rules out a hardcoded product-attribute-name list elsewhere in this file). `shouldStripAttributeDiscountParam`
    // already encodes the correct rule — "never touch outputs" — because an output parameter only NAMES
    // what this step publishes; it carries no bound literal value the way an input does, so it can never be
    // a "leaked donor-specific literal" the way an unrecognized INPUT can. This guard must apply the exact
    // same rule, or it flags every donor's genuine (and harmless) output declarations as a fabricated
    // failure — which is exactly what produced this run's false "leaked parameter" error. Scans BOTH
    // top-level AND customElement-NESTED input parameters; a donor-specific literal can live in either
    // location, and PriceAdjustmentScheduleId itself is required to live nested, so nested content was
    // never safe to skip here.
    const leaked = [...getTopLevelParameterBlocks(ad.ownXml), ...getNestedCustomElementParameterBlocks(ad.ownXml)]
      .filter(b => !isOutputParam(b.block))
      .map(b => getParamName(b.block))
      .filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
    if (leaked.length > 0) errors.push(`Unrecognized/leaked parameter name(s) survived patching on AttributeDiscount: ${leaked.join(", ")}`);
  }
  return errors;
}

export interface SelfReferentialParameterIssue {
  name: string;
  value: string;
  rawBlock: string;
}

/**
 * §Evidence-scoped exemption for the self-referential-input check below — deliberately NARROWER than
 * `RCA_NATIVE_CTX`. `RCA_NATIVE_CTX` answers "is this VALUE a name Salesforce's RCA runtime recognizes at
 * all" (used for the separate, weaker "unresolved binding" check) — it says nothing about whether a
 * PARTICULAR parameter is safe to bind to ITSELF. `PriceAdjustmentScheduleId`, for instance, IS in
 * `RCA_NATIVE_CTX` (some other step's value can legitimately equal that string), but a hash-verified capture
 * of this exact donor's real, live XML (`Rev_Mgmt_Default_Pricing_Procedure2_V1`, occurrences 13/14) proves
 * its OWN `PriceAdjustmentScheduleId` parameter is NEVER self-referential — both branches bind it to a
 * genuinely distinct name (`ItemContractAttributePasId` / `AttributePASIdConstant`) — exactly the shape of
 * the original, real bug this validator was built to catch. Reusing the whole `RCA_NATIVE_CTX` set here would
 * silently re-open that exact hole. Only `AttributeValue` currently has real, both-branches evidence of being
 * a legitimate self-reference (see `findInvalidSelfReferentialInputParameters`'s own comment) — extend this
 * set only when the SAME rigor (a real capture, both IsContractEnabled branches, cross-checked against
 * sibling parameters) proves a specific NEW name safe, never by assuming symmetry with `RCA_NATIVE_CTX`.
 */
const RCA_NATIVE_SELF_REFERENTIAL_CTX = new Set(["AttributeValue"]);

/**
 * §Centralized parameter-binding rule (generalized from the PriceAdjustmentScheduleId investigation, then
 * proven to recur on AttributeValue) — the ONE place that decides whether an input Parameter's
 * self-referential value (`<name>X</name>...<value>X</value>`) is valid. It is valid when `X` is either
 * (a) independently declared as a real envelope variable, or (b) a member of `RCA_NATIVE_SELF_REFERENTIAL_CTX`
 * — the narrow, evidence-proven set of Salesforce RCA implicit context variables PROVEN safe to
 * self-reference (see that const's own comment for why this is deliberately NOT `RCA_NATIVE_CTX`).
 *
 * §Root-cause correction (live donor evidence, hash-verified capture of Rev_Mgmt_Default_Pricing_Procedure2_V1) —
 * this function originally checked `declaredVars` alone, on the theory that any allowlist of "safe" names was
 * the same mistake as a hardcoded `ABP_STANDARD_CTX`-style bypass. That theory was correct for the
 * PriceAdjustmentScheduleId case (a value fabricated by an EARLIER, buggy patch, with no donor-native
 * precedent) but proved WRONG for AttributeValue: raw XML captured directly from the live org shows
 * `<name>AttributeValue</name>...<value>AttributeValue</value>` present verbatim in BOTH AttributeDiscount
 * occurrences of this donor (occurrence 13, IsContractEnabled=true; occurrence 14, IsContractEnabled=false).
 * `AttributeValue` was only ever flagged because its context-variable name happens to be spelled identically
 * to the parameter name that references it (`AttributeName`→`Attribute` is the exact same binding shape and
 * was never flagged, purely because the two strings differ) — its sibling context variables (`Product`,
 * `Attribute`, `PriceImpactingAttribute`, `LineItemQuantity`, `ProductSellingModel`, `PricingDate`) are
 * likewise never envelope-declared or step-produced in this donor, but NONE of them ever appear
 * self-referentially in the real data (their consuming parameter is always spelled differently, e.g.
 * `ProductId`≠`Product`), so they are deliberately NOT added to the exemption — there is no evidence they
 * need it, and adding them anyway would be exactly the "allowlist by assumption" this fix avoids. A
 * self-referential value that is neither declared nor in this narrow proven set (e.g. a freshly fabricated
 * one, like the original ScheduleId bug) is still caught — nothing about that detection is weakened.
 *
 * OUTPUT parameters are always exempt — an output legitimately "announces" its own name as its value (e.g.
 * `<name>NetUnitPrice</name><output>true</output><value>NetUnitPrice</value>` is how a donor declares "this
 * step publishes NetUnitPrice," a completely different semantic from an INPUT reference). Reused by
 * `validateAttributeCanvas` across every cloned pricing element (PricingSettings/ListPrice/AttributeDiscount)
 * so the rule is applied uniformly, never re-implemented per call site.
 */
export function findInvalidSelfReferentialInputParameters(stepXml: string, declaredVars: Set<string>): SelfReferentialParameterIssue[] {
  const all = [...getTopLevelParameterBlocks(stepXml), ...getNestedCustomElementParameterBlocks(stepXml)];
  const issues: SelfReferentialParameterIssue[] = [];
  for (const p of all) {
    const name = getParamName(p.block);
    const value = getParamValue(p.block);
    const isInputTypeParameter = isInputParam(p.block) && getTagValue(p.block, "type") === "Parameter";
    if (isInputTypeParameter && name && value && name === value && !declaredVars.has(value) && !RCA_NATIVE_SELF_REFERENTIAL_CTX.has(value)) {
      issues.push({ name, value, rawBlock: p.block });
    }
  }
  return issues;
}

export function validateAttributeCanvas(
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

  // §Root-cause fix (live evidence confirmed, generalized across turns from PriceAdjustmentScheduleId to
  // AttributeValue — the same shape recurs on different parameters) — Salesforce's real Metadata API
  // rejects a deployed input Parameter whose `<value>` is self-referential (equal to its own `<name>`)
  // with "isn't a valid variable name." A `<value>` on an input `<parameters>` of `type=Parameter` is a
  // REFERENCE to an actually declared variable, never a literal — so a self-referential value is invalid
  // UNLESS that same name is independently declared as a real envelope variable (checked against
  // `declaredVars`, never a hardcoded allowlist — a generic allowlist would just accidentally treat a
  // parameter's own name as a valid reference to itself, exactly the bug this replaces). Applied to EVERY
  // cloned pricing element's own input parameters — PricingSettings and ListPrice included, not just
  // AttributeDiscount — since the same invalid shape is possible on any of them and none were checked
  // before this fix; catches it regardless of whether the self-reference was freshly synthesized by a
  // patch or came verbatim from the donor's own (latent, never-previously-deployed-through-this-path)
  // template.
  for (const [stepLabel, stepXml] of [["PricingSettings", parts.psXml], ["ListPrice", parts.lpXml], ["AttributeDiscount", parts.adOwnXml]] as const) {
    for (const issue of findInvalidSelfReferentialInputParameters(stepXml, declaredVars)) {
      fatal.push(
        `${stepLabel} input parameter "${issue.name}" has a self-referential value ("${issue.value}" — identical to its own name) that is NOT declared as a variable anywhere in this Expression Set's envelope. Salesforce rejects this as "isn't a valid variable name" — a Parameter's <value> must reference an actually-declared variable, never the parameter's own name as a literal. Raw block: ${issue.rawBlock}`,
      );
    }
  }

  // Re-verify AD_MAPPINGS bindings landed as expected (defense in depth).
  for (const mapping of AD_MAPPINGS.filter(m => m.requiresVarCheck)) {
    const existing = getTopLevelParameterBlocks(parts.adOwnXml).find(b => getParamName(b.block) === mapping.paramName);
    if (!existing) continue;
    const value = getParamValue(existing.block);
    if (value && !declaredVars.has(value) && !RCA_NATIVE_CTX.has(value)) {
      warnings.push(`AttributeDiscount binding "${mapping.paramName}" is bound to "${value}", which is neither a declared template variable nor a known native runtime context variable.`);
    }
  }

  // Leakage scan (defense in depth) — both top-level AND customElement-nested (see postBuildGuard's
  // identical scope fix for why nested content can never be assumed already-clean). Output parameters are
  // exempt for the SAME reason postBuildGuard exempts them: a donor's own AttributeDiscount can legitimately
  // publish org-specific output names (e.g. NetUnitPrice/Subtotal/IsContracted) that `RECOGNIZED_PARAM_NAMES`
  // — an INPUT-binding allowlist, never meant to enumerate every legal output name — was never going to
  // contain; `shouldStripAttributeDiscountParam` already never touches outputs, so this check must not
  // flag what that function correctly left alone.
  const leaked = [...getTopLevelParameterBlocks(parts.adOwnXml), ...getNestedCustomElementParameterBlocks(parts.adOwnXml)]
    .filter(b => !isOutputParam(b.block))
    .map(b => getParamName(b.block)).filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
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

/**
 * §Root-cause investigation (this turn) — live error: "PriceAdjustmentScheduleId isn't a valid variable
 * name" during the actual Salesforce Metadata API deploy (Create Expression Set Version / Create Pricing
 * Procedure) — i.e. this is NOT one of this codebase's own local validation gates (those all passed —
 * "Bind Inputs ✓"); Salesforce's own server-side validation rejected something in the submitted metadata.
 *
 * Traced as far as static code analysis allows, WITHOUT guessing a fix (per explicit instruction): this
 * codebase's clone-and-patch architecture uses "PriceAdjustmentScheduleId" in at least two structurally
 * different ways that could each independently produce this exact wording, and only the real deployed
 * bytes + Salesforce's own line/column-level error detail (already captured elsewhere in this pipeline —
 * see `deployResult.status.componentFailures` in createPipeline.ts) can distinguish them:
 *   1. `patchC_preserveScheduleId` nests a `<parameters>` block inside AttributeDiscount's own
 *      `<customElement>` whose `<value>` is the string "PriceAdjustmentScheduleId" — EITHER cloned
 *      verbatim from the donor's own already-working binding, OR (only when the donor's template had NO
 *      such parameter at all) synthesized as a self-referential fallback. If the donor's own binding
 *      actually resolves via some OTHER mechanism (e.g. a step this build's single-donor pruning removes,
 *      or a donor-side construct tolerated by Salesforce only because it predates a stricter CREATE-time
 *      validation that a brand-new component now goes through), that reference would deploy broken.
 *   2. A genuinely separate, envelope-level `<variables><name>...</name></variables>` declaration (the
 *      real Expression Set "variables" construct this file already protects from renaming during envelope
 *      regeneration — see the `protectedVariableBlocks` mechanism above) could itself be named
 *      "PriceAdjustmentScheduleId" and be what Salesforce is actually rejecting — entirely independent of
 *      AttributeDiscount's own parameter.
 * This function dumps BOTH exactly as they exist in the given (already-deployed-and-rejected) XML, so the
 * next attempt's evidence settles which one it actually is, instead of another guess.
 */
export function buildScheduleVariableDiagnostic(finalFileXml: string): string {
  const lines: string[] = ["=== PriceAdjustmentScheduleId — RAW DEPLOYED-XML EVIDENCE ==="];

  const variableBlocks = extractFlatBlocks(finalFileXml, "variables");
  lines.push("", `Envelope-level <variables> declarations found: ${variableBlocks.length}`);
  if (variableBlocks.length === 0) {
    lines.push("(none — this file declares no top-level <variables> at all; rules out mechanism #2 below)");
  } else {
    for (const block of variableBlocks) {
      const name = getTagValue(block, "name") ?? "(no <name> found)";
      lines.push(`--- <variables> name="${name}" ${name === "PriceAdjustmentScheduleId" ? "◄◄◄ MATCHES THE REJECTED NAME" : ""} ---`, block);
    }
  }

  lines.push("", '=== every raw occurrence of the string "PriceAdjustmentScheduleId" in the deployed file (±120 chars of context) ===');
  const needle = "PriceAdjustmentScheduleId";
  let idx = finalFileXml.indexOf(needle);
  let count = 0;
  while (idx !== -1 && count < 50) {
    const start = Math.max(0, idx - 120);
    const end = Math.min(finalFileXml.length, idx + needle.length + 120);
    lines.push(`[byte offset ${idx}] ...${finalFileXml.slice(start, end)}...`);
    idx = finalFileXml.indexOf(needle, idx + needle.length);
    count++;
  }
  if (count === 0) lines.push('(the literal string was not found anywhere in the deployed file — surprising, given Salesforce\'s own error names it directly; check whether the error is about a DIFFERENT, similarly-worded name instead.)');
  else lines.push(`(${count} occurrence(s) shown, newest scan capped at 50)`);

  lines.push(
    "",
    "Mechanism #1 (AttributeDiscount's own nested parameter) vs #2 (an envelope-level <variables> declaration) — " +
    "whichever actually appears above, cross-reference against Salesforce's own componentFailures lineNumber/columnNumber " +
    "(captured separately, see the full deploy diagnostic) to identify the EXACT XML location Salesforce rejected, rather than assuming.",
  );
  return lines.join("\n");
}

export interface FinalCanvasStructuralAudit {
  envelopeVariables: { name: string; raw: string }[];
  pricingElementOccurrences: { occurrenceIndex: number; actionType: string | null; name: string | null }[];
  inputParameters: { stepActionType: string | null; occurrenceIndex: number; name: string | null; value: string | null }[];
  outputParameters: { stepActionType: string | null; occurrenceIndex: number; name: string | null; value: string | null }[];
  unresolvedInputBindings: { stepActionType: string | null; occurrenceIndex: number; name: string | null; value: string | null }[];
  selfReferentialInputs: { stepActionType: string | null; occurrenceIndex: number; name: string; value: string }[];
  missingRequiredBindings: string[];
  /** §ListGroup structural check (live evidence — Salesforce deploy rejection "Select list filter as the
   * first element in list group. Please remove Attribute Discount Entries.") — for every step in the final
   * canvas with `<stepType>ListGroup</stepType>`, reports its real children (by `<parentStep>` match),
   * ordered by `<sequenceNumber>`, and whether the first one is an `AdvancedListFilter` — the exact,
   * evidence-proven shape every one of the real donor's 21 ListGroup containers has, with zero exceptions. */
  listGroups: {
    occurrenceIndex: number; name: string | null;
    children: { occurrenceIndex: number; name: string | null; stepType: string | null; sequenceNumber: string | null }[];
    firstChildIsAdvancedListFilter: boolean;
    issue: string | null;
  }[];
  selectedListPrice: { occurrenceIndex: number; name: string | null; isContractEnabled: string | null } | null;
  selectedAttributeDiscount: { occurrenceIndex: number; name: string | null; isContractEnabled: string | null } | null;
  passed: boolean;
  summary: string;
}

/**
 * §Step 8 requirement — a complete, human-readable structural audit of the FINAL, fully composed and
 * pruned Expression Set XML (`finalFileXml` — the exact bytes handed to Salesforce's deploy call), run
 * REGARDLESS of whether `validateAttributeCanvas` already passed or failed on the pre-prune parts, so a
 * human reviewing a failed (or successful) build sees the complete picture in one place: every envelope
 * variable, every pricing element occurrence, every input/output parameter, which inputs are self-
 * referential/unresolved, and which branch (ListPrice/AttributeDiscount, with their IsContractEnabled
 * values) was actually selected. This is a REPORTING function — it never makes a selection decision and
 * never mutates anything; the actual pass/fail gate remains `validateAttributeCanvas` (already invoked
 * earlier in the same build, before pruning) plus this audit's own `passed` flag, which the caller must
 * still check before ever deploying (see `createPipeline.ts`'s use of `canvas.finalFileXml`/`canvas.success`).
 */
export function buildFinalCanvasStructuralAudit(finalFileXml: string): FinalCanvasStructuralAudit {
  const graph = extractStepGraph(finalFileXml);
  const envelopeVariables = extractFlatBlocks(finalFileXml, "variables").map(raw => ({ name: getTagValue(raw, "name") ?? "(no <name> found)", raw }));
  // §Self-contained — derives the SAME declared-variables set from `finalFileXml`'s own envelope, never
  // requiring the caller to pass in whatever internal `declaredVars` `buildAttributeCanvas` used, so this
  // audit can be run independently against any already-composed final XML (e.g. from a saved diagnostic
  // artifact) without needing anything beyond the XML itself.
  const declaredVars = new Set(envelopeVariables.map(v => v.name).filter(n => n !== "(no <name> found)"));
  const pricingElementOccurrences = graph.map(n => ({ occurrenceIndex: n.occurrenceIndex, actionType: n.actionType, name: n.name }));

  const inputParameters: FinalCanvasStructuralAudit["inputParameters"] = [];
  const outputParameters: FinalCanvasStructuralAudit["outputParameters"] = [];
  const unresolvedInputBindings: FinalCanvasStructuralAudit["unresolvedInputBindings"] = [];
  const selfReferentialInputs: FinalCanvasStructuralAudit["selfReferentialInputs"] = [];

  for (const node of graph) {
    const bindings = [...getTopLevelParameterBlocks(node.full), ...getNestedCustomElementParameterBlocks(node.full)];
    for (const b of bindings) {
      const name = getParamName(b.block);
      const value = getParamValue(b.block);
      const isInputTypeParameter = isInputParam(b.block) && getTagValue(b.block, "type") === "Parameter";
      const entry = { stepActionType: node.actionType, occurrenceIndex: node.occurrenceIndex, name, value };
      if (isOutputParam(b.block)) {
        outputParameters.push(entry);
        continue;
      }
      if (isInputTypeParameter) {
        inputParameters.push(entry);
        if (value && !declaredVars.has(value) && !RCA_NATIVE_CTX.has(value)) unresolvedInputBindings.push(entry);
        // §Same NARROW exemption as `findInvalidSelfReferentialInputParameters` — deliberately
        // `RCA_NATIVE_SELF_REFERENTIAL_CTX`, not `RCA_NATIVE_CTX` (see that const's doc comment): only
        // `AttributeValue` has real, both-branches evidence of being a legitimate self-reference.
        if (name && value && name === value && !declaredVars.has(value) && !RCA_NATIVE_SELF_REFERENTIAL_CTX.has(value)) selfReferentialInputs.push({ ...entry, name, value });
      }
    }
  }

  const scheduleRe = /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i;
  const adNode = graph.find(n => n.actionType === "AttributeDiscount") ?? null;
  const lpNode = graph.find(n => n.actionType === "ListPrice") ?? null;
  const missingRequiredBindings: string[] = [];
  if (!adNode) missingRequiredBindings.push("No AttributeDiscount occurrence in the final canvas.");
  else {
    if (!extractCustomElementBlocks(adNode.full).some(ce => getAllTagValues(ce, "name").some(n => scheduleRe.test(n)))) {
      missingRequiredBindings.push("AttributeDiscount has no PriceAdjustmentScheduleId parameter (top-level or nested) in the final canvas.");
    }
    // §Root-cause fix (live evidence — Salesforce deploy rejection "Select list filter as the first
    // element in list group. Please remove Attribute Discount Entries.") — this is the gap that let that
    // bug slip past every prior local check: `validateAttributeCanvas`'s "Part 10" required-fields check
    // (see buildAttributeCanvas) only verifies the DONOR's selected branch has these fields BEFORE Patch A
    // strips anything; nothing previously re-verified they SURVIVE into the FINAL, post-strip canvas. These
    // 10 names are Salesforce's own standard Decision-Table-lookup configuration for a Select/Get step
    // (proven, via this donor's own real XML, to be universal across every pricing decision-table action
    // type, never a per-attribute literal) — their absence here is exactly the shape Salesforce rejected.
    const adFields = collectFieldMap(adNode);
    for (const required of ["ProductId", "ProductSellingModelId", "LookUpName", "LookUpId", "LookUpApiName", "selectedFunction", "sectionCount"]) {
      if (!adFields.has(required)) {
        missingRequiredBindings.push(`AttributeDiscount is missing required Decision-Table lookup parameter "${required}" in the final canvas — Salesforce will reject this as an incomplete list-group/list-filter configuration.`);
      }
    }
  }
  if (!lpNode) missingRequiredBindings.push("No ListPrice occurrence in the final canvas.");

  // §ListGroup structural check — see the `listGroups` field's own doc comment. Evaluated over the WHOLE
  // final graph (not just the selected AttributeDiscount's own container) so any ListGroup left incomplete
  // by pruning is caught, regardless of which pricing element it belongs to.
  const listGroups: FinalCanvasStructuralAudit["listGroups"] = [];
  for (const node of graph) {
    if (getTagValue(node.content, "stepType") !== "ListGroup") continue;
    const children = graph
      .filter(n => n.parentStep === node.name)
      .sort((a, b) => Number(a.sequenceNumber ?? 0) - Number(b.sequenceNumber ?? 0))
      .map(n => ({ occurrenceIndex: n.occurrenceIndex, name: n.name, stepType: getTagValue(n.content, "stepType"), sequenceNumber: n.sequenceNumber }));
    const firstChildIsAdvancedListFilter = children.length > 0 && children[0].stepType === "AdvancedListFilter";
    let issue: string | null = null;
    if (children.length === 0) issue = `ListGroup "${node.name}" has no children in the final canvas — Salesforce requires a list filter as its first element.`;
    else if (!firstChildIsAdvancedListFilter) issue = `ListGroup "${node.name}"'s first child (by sequenceNumber) is "${children[0].name}" (stepType=${children[0].stepType ?? "none"}), not an AdvancedListFilter — Salesforce rejects this as "Select list filter as the first element in list group."`;
    listGroups.push({ occurrenceIndex: node.occurrenceIndex, name: node.name, children, firstChildIsAdvancedListFilter, issue });
  }
  const listGroupIssues = listGroups.filter(g => g.issue).map(g => g.issue as string);

  const isContractEnabledOf = (n: PhysicalStepNode | null) => n ? (collectFieldMap(n).get("IsContractEnabled") ?? null) : null;
  const selectedAttributeDiscount = adNode ? { occurrenceIndex: adNode.occurrenceIndex, name: adNode.name, isContractEnabled: isContractEnabledOf(adNode) } : null;
  const selectedListPrice = lpNode ? { occurrenceIndex: lpNode.occurrenceIndex, name: lpNode.name, isContractEnabled: isContractEnabledOf(lpNode) } : null;

  const passed = selfReferentialInputs.length === 0 && missingRequiredBindings.length === 0 && listGroupIssues.length === 0;
  const summary = [
    `Final canvas structural audit: ${passed ? "PASSED" : "FAILED"}.`,
    `${pricingElementOccurrences.length} pricing element occurrence(s), ${envelopeVariables.length} envelope variable(s), ${inputParameters.length} input parameter(s), ${outputParameters.length} output parameter(s).`,
    `Self-referential invalid inputs: ${selfReferentialInputs.length}. Unresolved input bindings (value not declared/native): ${unresolvedInputBindings.length}. Missing required bindings: ${missingRequiredBindings.length}. ListGroup structural issues: ${listGroupIssues.length}.`,
    `Selected AttributeDiscount: [${selectedAttributeDiscount?.occurrenceIndex ?? "none"}] IsContractEnabled=${selectedAttributeDiscount?.isContractEnabled ?? "(none)"}. Selected ListPrice: [${selectedListPrice?.occurrenceIndex ?? "none"}] IsContractEnabled=${selectedListPrice?.isContractEnabled ?? "(none)"}.`,
  ].join(" ");

  return {
    envelopeVariables, pricingElementOccurrences, inputParameters, outputParameters,
    unresolvedInputBindings, selfReferentialInputs, missingRequiredBindings, listGroups,
    selectedListPrice, selectedAttributeDiscount, passed, summary,
  };
}

/** Number of `<parameters>` blocks (top-level + nested) in a subtree of text. */
function countParameters(xml: string): number {
  return extractFlatBlocks(xml, "parameters").length;
}

/** One envelope-level identifier tag (label/description/fullName/developerName/name/
 * expressionSetDefinition) whose value was regenerated from the new Pricing Procedure's own name/API
 * name instead of being copied from the donor. */
export interface RegeneratedIdentifier {
  tag: string;
  donorValue: string;
  newValue: string;
}

/**
 * §Root-cause fix (live evidence — "Refusing to deploy" false-positive on a Laptop re-run) — deliberately
 * EXCLUDES `expressionSetDefinition`. It is the VERSION's foreign-key reference back to its PARENT
 * ExpressionSetDefinition, always regenerated as the bare `ctx.apiName` with no version suffix — by
 * Salesforce's own schema this reference is intentionally STABLE across every version of the same
 * Expression Set, never a per-version identity. `createPipeline.ts`'s OWN org-uniqueness pre-flight check
 * (`validateExpressionSetUniquenessAgainstOrg`) already established and documented this exact fact for a
 * different, SOQL-verified check; this donor-comparison check simply hadn't been brought in line with it.
 *
 * Donor selection (`resolveAttributeBasedPricingDonor`) is deliberately product-agnostic — it scores
 * candidates purely on structural coherence, never by name — so once a product's OWN prior Expression Set
 * exists in the org, it can legitimately become the highest-scoring donor for regenerating a NEW version of
 * ITSELF (confirmed live: once Laptop's own V1 existed, `resolveAttributeBasedPricingDonor` started
 * returning Laptop's/Monitor's own small, clean, product-specific artifacts ahead of the large shared
 * `Rev_Mgmt_Default_Pricing_Procedure2_V1`). In that self-referential-donor case, `ctx.apiName` EQUALS the
 * donor's own `expressionSetDefinition` by construction — the CORRECT, required value for creating a new
 * version under the same parent, not a naming collision. `fullName` (the version's OWN, genuinely
 * version-suffixed identity) remains identity-bearing; only its match would indicate the version-number
 * regeneration actually failed.
 */
const IDENTITY_BEARING_TAGS = new Set(["fullName", "developerName", "name"]);

export interface IdentityCollisionCheckResult {
  donorCollisions: RegeneratedIdentifier[];
  nonIdentityMatches: RegeneratedIdentifier[];
}

/** Extracted for direct unit testing — the exact same logic `buildAttributeCanvas` uses to decide whether a
 * regenerated envelope identifier's match against the donor's own value is a real collision (identity-
 * bearing field) or expected/benign (descriptive field, or the deliberately-stable expressionSetDefinition
 * reference). */
export function checkIdentityCollisions(regeneratedIdentifiers: RegeneratedIdentifier[]): IdentityCollisionCheckResult {
  const donorCollisions = regeneratedIdentifiers.filter(r => IDENTITY_BEARING_TAGS.has(r.tag) && r.donorValue.trim() !== "" && r.newValue === r.donorValue);
  const nonIdentityMatches = regeneratedIdentifiers.filter(r => !IDENTITY_BEARING_TAGS.has(r.tag) && r.donorValue.trim() !== "" && r.newValue === r.donorValue);
  return { donorCollisions, nonIdentityMatches };
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
  // via `resolvePricingFlowAncestors` — the exact same function this file's own regression tests exercise
  // directly, so testing it IS testing the real canvas-building selection path, never a parallel
  // reimplementation. Never assumed to be "the only one in the file" (a coherent donor can legitimately
  // bundle more than one pricing flow, and MULTIPLE ListPrice occurrences, each paired with a different
  // AttributeDiscount via its own evidence), and never a guess: whichever real mechanism proved
  // eligibility during donor selection is exactly what's used here too, so the two stages can never
  // disagree about whether/how this branch is connected.
  const ancestors = resolvePricingFlowAncestors(donorGraph, adNode, donorSelection.fullName);
  warnings.push(...ancestors.warnings);
  if (!ancestors.success || !ancestors.lpMatch || !ancestors.psMatch) {
    return { success: false, fatalErrors: ancestors.fatalErrors, warnings, attributeDiscountBranchSelection, donorExtractionDeterministic };
  }
  const { lpMatch, psMatch } = ancestors;
  const lpMechanismLabel = ancestors.lpMechanism ?? "none";
  client.logDebug(
    "xml-diagnostic",
    [
      `✓ Donor steps in this flow: PricingSettings ("${psMatch.name ?? "(unnamed)"}"), ListPrice ("${lpMatch.name ?? "(unnamed)"}").`,
      `→ AttributeDiscount → ListPrice relationship: ${lpMechanismLabel}${lpMechanismLabel === "sequence-order" || lpMechanismLabel === "contract-flavor-fallback" ? " (lower-confidence signal)" : ""}.`,
      `→ AttributeDiscount → PricingSettings relationship: ${ancestors.psMechanism ?? "none"}${ancestors.psMechanism === "sequence-order" ? " (lower-confidence signal)" : ""}.`,
      ancestors.evidenceLog,
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
  client.logDebug("xml-diagnostic", `[Canvas composition] AttributeDiscount.parentStep ("${adNode.parentStep ?? "(none)"}") is unmodified — it already resolves to ListPrice ("${lpMatch.name ?? "(unnamed)"}") within the selected donor's own graph via ${lpMechanismLabel}.`);

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
  // §TBP-20260923-210132-FAD5 — delegates to the SAME shared function tier-based/volume-based use
  // (versionEnvelopeFields.ts's `regenerateVersionedFullName`), which GUARANTEES a version suffix
  // whenever `ctx.versionNumber` is resolved — even when the donor's own fullName has no recognizable
  // suffix pattern of its own to mirror. The prior inline copy here fell back to the bare `ctx.apiName`
  // in exactly that case, silently discarding a correctly-resolved version number (the identity-drift
  // root cause confirmed live: candidate resolution proved "..._V2" free of collisions, but the deployed
  // identity reverted to the bare apiName and matched an existing Draft version instead).
  regenerateEnvelopeTag("fullName", donorValue => escapeXml(regenerateVersionedFullName(donorValue, ctx.apiName, ctx.versionNumber)));
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
  //
  // §Root-cause fix (live evidence — "Refusing to deploy" false-positive on a Laptop re-run) — see
  // `checkIdentityCollisions`'s own doc comment for why `expressionSetDefinition` is deliberately excluded:
  // it's the version's stable, never-version-suffixed reference back to its PARENT ExpressionSetDefinition,
  // and donor selection is product-agnostic enough that a product's own prior artifact can legitimately
  // become its own new version's donor — making that match CORRECT, not a collision.
  const { donorCollisions, nonIdentityMatches } = checkIdentityCollisions(regeneratedIdentifiers);
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
