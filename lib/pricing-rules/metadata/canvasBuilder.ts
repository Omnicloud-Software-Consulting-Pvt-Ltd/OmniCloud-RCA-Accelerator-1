/**
 * Attribute-based pricing canvas builder — clone-and-patch, never
 * build-from-scratch. `AttributeDiscount` is a real BusinessKnowledgeModel
 * action type that is not scriptable on a blank canvas in Revenue Cloud
 * (its legal enum values are org-configured); the only reliable way to get
 * a correctly-configured step is to clone one from an already-working
 * Expression Set in the connected org and patch out the product-specific
 * parts.
 *
 * Deviation from a hardcoded "known product attribute names" list: rather
 * than guessing the donor org's actual attribute names (Display/Storage/
 * etc — genuinely unknowable without that org), Patch A generalizes the
 * same intent structurally: any INPUT parameter whose name isn't one of
 * the small set of generic bindings this engine actually supports
 * (RECOGNIZED_PARAM_NAMES) is stripped, exactly like a hardcoded literal
 * attribute-name parameter would be.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  type ElementSpan,
  extractStepBlocks,
  extractFlatBlocks,
  extractCustomElementBlocks,
  findStepsByActionType,
  getOwnActionType,
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
  stripStepIdentity,
  outermostSpans,
  escapeXml,
} from "@/lib/pricing-rules/xml/blocks";
import { findTemplateStepByActionType } from "./templateExpressionSet";
import { compareExpressionSetSchema, compareStepStructure } from "./schemaDiff";

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
  { paramName: "InputUnitPrice", ctxVar: "NetUnitPrice" },
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

/* ── Helpers ── */

function getParamValueByName(stepFullXml: string, paramName: string): string | null {
  const found = getTopLevelParameterBlocks(stepFullXml).find(b => getParamName(b.block) === paramName);
  return found ? getParamValue(found.block) : null;
}

function getDeclaredVariableNames(fullXml: string): Set<string> {
  const names = new Set<string>();
  for (const b of extractFlatBlocks(fullXml, "variables")) {
    const n = getTagValue(b, "name");
    if (n) names.add(n);
  }
  return names;
}

/**
 * §Pricing-waterfall connection investigation — every `<parameters>` block in a step, BOTH top-level
 * (direct child of `<steps>`) and nested inside `<customElement>`. The structural-fidelity patches
 * (patchListPriceWaterfall etc.) already search both locations when SETTING a value — never assuming
 * the donor put it at the top level — but several validation/diagnostic call sites only ever looked
 * at `getTopLevelParameterBlocks`, producing a false "no output parameter found" even when the patch
 * had already correctly placed it inside `<customElement>`. This is the one shared "search
 * everywhere" primitive every such call site should use instead.
 */
function getAllParameterBlocks(stepFullXml: string): { block: string; nested: boolean }[] {
  const blocks: { block: string; nested: boolean }[] = getTopLevelParameterBlocks(stepFullXml).map(b => ({ block: b.block, nested: false }));
  for (const ce of extractFlatBlocks(stepFullXml, "customElement")) {
    for (const p of extractFlatBlocks(ce, "parameters")) {
      blocks.push({ block: p, nested: true });
    }
  }
  return blocks;
}

/** §9 — one report line per matching parameter (name/value/location), for the pre-deploy "ListPrice Outputs" / "AttributeDiscount Inputs" validation print. */
function describeParameters(stepFullXml: string, filter: (block: string) => boolean): string[] {
  return getAllParameterBlocks(stepFullXml)
    .filter(p => filter(p.block))
    .map(p => `  - name=${getParamName(p.block) ?? "(none)"}, value=${getParamValue(p.block) ?? "(none)"}, location=${p.nested ? "nested (<customElement>)" : "top-level (<steps>)"}`);
}

/** Diagnostic snapshot of a single step's XML — used to log every ListPrice candidate found/patched/validated (§ waterfall-patch bug investigation) without dumping raw XML everywhere. */
function describeStepForDiagnostics(xml: string): Record<string, unknown> {
  const allParams = getAllParameterBlocks(xml);
  return {
    sequenceNumber: getTagValue(xml, "sequenceNumber"),
    actionType: getOwnActionType(xml),
    parentStep: getTagValue(xml, "parentStep"),
    lookUpName: getParamValueByName(xml, "LookUpName"),
    lookUpId: getParamValueByName(xml, "LookUpId"),
    lookUpApiName: getParamValueByName(xml, "LookUpApiName"),
    inputUnitPrice: getParamValueByName(xml, "InputUnitPrice"),
    outputParameters: allParams.filter(b => isOutputParam(b.block)).map(b => ({ name: getParamName(b.block), value: getParamValue(b.block), type: getTagValue(b.block, "type"), nested: b.nested })),
    allParameters: allParams.map(b => ({ name: getParamName(b.block), value: getParamValue(b.block), input: isInputParam(b.block), output: isOutputParam(b.block), type: getTagValue(b.block, "type"), nested: b.nested })),
  };
}

/**
 * §Structural rules (donor-fidelity hardening) — the ONLY two ways any patch below may touch a
 * parameter, full stop:
 *   1. Rule 5 — the parameter already exists SOMEWHERE in the step (top-level OR nested inside
 *      <customElement>, wherever the donor originally put it): find it and replace ONLY its <value>,
 *      never its position or parent.
 *   2. Rule 7 — the parameter doesn't exist anywhere yet: insert it into the donor's EXISTING
 *      <customElement> block — never as a new top-level <parameters> sibling of <steps> (Rules 1/6/10),
 *      never inside a freshly-created <customElement> wrapper. If the step has no <customElement> at
 *      all, nothing is inserted (`applied: false`) — the caller must warn, never fabricate a structure
 *      the donor never had.
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
 * §8.1.2 waterfall bridge patch: any output Parameter on ListPrice — wherever it currently lives,
 * top-level or nested inside <customElement> — not already bound to NetUnitPrice gets its value
 * rewritten in place (Rule 5). When the template's ListPrice step has no existing output-Parameter
 * block to rewrite at all, the new one is inserted into the donor's EXISTING <customElement> (Rule 7)
 * — never a new top-level <parameters> node; if the step has no <customElement> either, this is left
 * unset with a warning rather than fabricating a structure the donor never had.
 */
function patchListPriceWaterfall(stepFullXml: string, warnings: string[]): string {
  let result = stepFullXml;
  let rewroteAny = false;

  const topBlocks = getTopLevelParameterBlocks(result);
  for (let i = topBlocks.length - 1; i >= 0; i--) {
    const b = topBlocks[i];
    if (isOutputParam(b.block) && getTagValue(b.block, "type") === "Parameter") {
      rewroteAny = true;
      if (getParamValue(b.block) !== "NetUnitPrice") {
        result = result.slice(0, b.start) + setParamValue(b.block, "NetUnitPrice") + result.slice(b.end);
      }
    }
  }
  for (const ce of extractFlatBlocks(result, "customElement")) {
    for (const p of extractFlatBlocks(ce, "parameters")) {
      if (isOutputParam(p) && getTagValue(p, "type") === "Parameter") {
        rewroteAny = true;
        if (getParamValue(p) !== "NetUnitPrice") {
          const updatedCe = ce.replace(p, setParamValue(p, "NetUnitPrice"));
          result = result.replace(ce, updatedCe);
        }
      }
    }
  }

  if (!rewroteAny) {
    const inserted = insertIntoExistingCustomElement(result, buildParameterBlock({ name: "NetUnitPrice", type: "Parameter", value: "NetUnitPrice", output: true }));
    if (inserted.applied) {
      result = inserted.xml;
    } else {
      warnings.push("ListPrice's template has no existing output Parameter and no <customElement> to nest a new NetUnitPrice output into — the waterfall bridge output was left unset (never added as a new top-level <parameters> node).");
    }
  }
  return result;
}

/* ── §8.2 Patch A: strip product-specific literal bindings. ── */
function patchA_stripProductLiterals(stepFullXml: string): string {
  return removeTopLevelParameters(stepFullXml, block => {
    if (isOutputParam(block)) return false; // never touch outputs
    const name = getParamName(block);
    const value = getParamValue(block);
    if (!name || !RECOGNIZED_PARAM_NAMES.has(name)) return true; // unrecognized param name -> strip unconditionally
    const isInput = isInputParam(block) || getTagValue(block, "type") === "Parameter";
    if (isInput && value && !ABP_STANDARD_CTX.has(value) && !RECOGNIZED_PARAM_NAMES.has(value)) return true; // bound to an unrecognized context var -> strip
    return false;
  });
}

/* ── §8.3 Patch B: force InputUnitPrice -> NetUnitPrice — update in place wherever it lives, never a new top-level node. ── */
function patchB_forceNetUnitPrice(stepFullXml: string, warnings: string[]): string {
  const { xml, applied } = setOrInsertParameterValue(stepFullXml, "InputUnitPrice", "NetUnitPrice", { input: true });
  if (!applied) {
    warnings.push("AttributeDiscount's template has no existing InputUnitPrice parameter and no <customElement> to nest a new one into — left unset (never added as a new top-level <parameters> node).");
  }
  return xml;
}

/* ── §8.4 Patch C: preserve PriceAdjustmentScheduleId verbatim, nested inside the donor's EXISTING <customElement> — never a freshly-created wrapper, never top-level. ── */
function patchC_preserveScheduleId(originalStepXml: string, patchedStepXml: string, warnings: string[]): string {
  const scheduleRe = /^PriceAdjustmentSchedule(Id|Name|Ids|Type)?$/i;

  const alreadyNested = extractCustomElementBlocks(patchedStepXml).some(ce => getAllTagValues(ce, "name").some(n => scheduleRe.test(n)));
  if (alreadyNested) return patchedStepXml;

  const originalTopLevelMatch = getTopLevelParameterBlocks(originalStepXml).find(b => {
    const n = getParamName(b.block);
    return !!n && scheduleRe.test(n);
  });

  // Drop it from the top level if a patch happened to leave it there (wrong nesting level per §8.7).
  const result = removeTopLevelParameters(patchedStepXml, block => {
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
 * §8.5 Patch D: normalize AD_MAPPINGS bindings — update the EXISTING parameter in place, wherever the
 * donor put it (Rule 5), or insert into the donor's EXISTING <customElement> only when the parameter
 * is truly absent everywhere (Rule 7) — never a new top-level <parameters> node. Unlike the prior
 * version of this patch, a var-check mapping's ALREADY-EXISTING parameter (top-level or nested) is
 * now always rewritten to our own context-variable binding too, not left alone — leaving a nested,
 * Patch-A-blind-spot value untouched risked silently deploying a donor org's own product-specific
 * literal (exactly what Patch A exists to strip at the top level).
 */
function patchD_normalizeMappings(stepFullXml: string, declaredVars: Set<string>, warnings: string[]): string {
  let result = stepFullXml;
  for (const mapping of AD_MAPPINGS) {
    if (mapping.requiresVarCheck && !declaredVars.has(mapping.ctxVar)) {
      warnings.push(`AttributeDiscount binding "${mapping.paramName}" -> "${mapping.ctxVar}" was left unset: the template Expression Set doesn't declare "${mapping.ctxVar}" as a variable.`);
      continue;
    }
    const { xml, applied } = setOrInsertParameterValue(result, mapping.paramName, mapping.ctxVar, { input: true });
    result = xml;
    if (!applied) {
      warnings.push(`AttributeDiscount binding "${mapping.paramName}" -> "${mapping.ctxVar}" could not be set: this parameter isn't present in the template and there's no <customElement> to nest a new one into.`);
    }
  }
  return result;
}

/* ── §8.6/§8.7 guards ── */
function postBuildGuard(steps: { actionType: string; xml: string }[]): string[] {
  const errors: string[] = [];
  for (const s of steps) {
    if (ATTR_BLOCKED_ACTION_TYPES.has(s.actionType)) errors.push(`Blocked/legacy actionType present in the built canvas: ${s.actionType}`);
  }
  const ad = steps.find(s => s.actionType === "AttributeDiscount");
  if (ad) {
    const leaked = getTopLevelParameterBlocks(ad.xml)
      .map(b => getParamName(b.block))
      .filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
    if (leaked.length > 0) errors.push(`Unrecognized/leaked parameter name(s) survived patching on AttributeDiscount: ${leaked.join(", ")}`);
  }
  return errors;
}

function validateAttributeCanvas(
  parts: { psXml: string; lpXml: string; adXml: string },
  templateActionTypesObserved: Set<string>,
  declaredVars: Set<string>,
): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const built = [
    { actionType: "PricingSettings", xml: parts.psXml },
    { actionType: "ListPrice", xml: parts.lpXml },
    { actionType: "AttributeDiscount", xml: parts.adXml },
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
  const topLevelHasSchedule = getTopLevelParameterBlocks(parts.adXml).some(b => { const n = getParamName(b.block); return !!n && scheduleRe.test(n); });
  const nestedHasSchedule = extractCustomElementBlocks(parts.adXml).some(ce => getAllTagValues(ce, "name").some(n => scheduleRe.test(n)));
  if (topLevelHasSchedule) fatal.push('PriceAdjustmentScheduleId is present at the top level of AttributeDiscount instead of nested inside <customElement> — Salesforce rejects this with "Element parameters invalid at this location in type ExpressionSetStep".');
  if (!nestedHasSchedule) fatal.push("AttributeDiscount has no PriceAdjustmentScheduleId parameter (top-level or nested) — the deployed procedure would have no way to resolve its PriceAdjustmentSchedule at runtime.");

  // Re-verify AD_MAPPINGS bindings landed as expected (defense in depth vs. §8.5).
  for (const mapping of AD_MAPPINGS.filter(m => m.requiresVarCheck)) {
    const existing = getTopLevelParameterBlocks(parts.adXml).find(b => getParamName(b.block) === mapping.paramName);
    if (!existing) continue;
    const value = getParamValue(existing.block);
    if (value && !declaredVars.has(value) && !RCA_NATIVE_CTX.has(value)) {
      warnings.push(`AttributeDiscount binding "${mapping.paramName}" is bound to "${value}", which is neither a declared template variable nor a known native runtime context variable.`);
    }
  }

  // Leakage scan (defense in depth vs. §8.6).
  const leaked = getTopLevelParameterBlocks(parts.adXml).map(b => getParamName(b.block)).filter((n): n is string => !!n && !RECOGNIZED_PARAM_NAMES.has(n));
  if (leaked.length > 0) fatal.push(`Unrecognized parameter name(s) on AttributeDiscount: ${leaked.join(", ")}`);

  // ListPrice: must publish EXACTLY ONE output Parameter whose value is NetUnitPrice — searched
  // top-level AND nested inside <customElement> (§6/§ pricing-waterfall connection investigation:
  // the structural-fidelity patches correctly search both locations when setting this value, so
  // validation must too, or a correctly-nested output reads as "not found").
  const lpOutputs = getAllParameterBlocks(parts.lpXml).filter(p => isOutputParam(p.block) && getTagValue(p.block, "type") === "Parameter");
  const lpNetUnitPriceOutputs = lpOutputs.filter(p => getParamValue(p.block) === "NetUnitPrice");
  if (lpNetUnitPriceOutputs.length !== 1) {
    // §Waterfall-patch bug investigation — Validation checkpoint: report exactly what was found
    // vs. expected, so the failing step can be identified without re-reading raw XML by hand.
    const actualOutput = lpOutputs.length > 0
      ? lpOutputs.map(p => `${getParamValue(p.block) ?? "(output Parameter with no value)"} [${p.nested ? "nested" : "top-level"}]`).join(", ")
      : "none (no output Parameter block found on this step at all, top-level or nested)";
    const snippetSource = lpOutputs[0]?.block ?? parts.lpXml;
    const xmlSnippet = snippetSource.length > 500 ? `${snippetSource.slice(0, 500)}...(truncated)` : snippetSource;
    fatal.push(
      [
        `ListPrice does not publish exactly one NetUnitPrice output (found ${lpNetUnitPriceOutputs.length} matching, ${lpOutputs.length} output parameter(s) total) — the waterfall bridge patch (§8.1.2) did not take effect as expected.`,
        `Expected Output: exactly one output Parameter with value NetUnitPrice.`,
        `Actual Output: ${actualOutput}`,
        `Sequence Number: ${getTagValue(parts.lpXml, "sequenceNumber") ?? "(unknown)"}`,
        `Action Type: ${getOwnActionType(parts.lpXml) ?? "ListPrice"}`,
        `XML Snippet: ${xmlSnippet}`,
      ].join(" | ")
    );
  }
  const lpCustom = extractCustomElementBlocks(parts.lpXml).join("");
  for (const requiredField of ["LookUpId", "LookUpName", "LookUpApiName", "ListPriceField"]) {
    if (!getAllTagValues(lpCustom, "name").includes(requiredField)) {
      fatal.push(`ListPrice's <customElement> is missing required field "${requiredField}".`);
    }
  }

  return { fatal, warnings };
}

/** §XML Generation verification — number of `<parameters>` blocks (top-level + nested) on a single step's XML. */
function countParameters(xml: string): number {
  return extractFlatBlocks(xml, "parameters").length;
}

/** §Uniqueness — one envelope-level identifier tag (label/description/fullName/developerName/name/
 * expressionSetDefinition) whose value was regenerated from the new Pricing Procedure's own name/API
 * name instead of being copied from the donor — see `regenerateEnvelopeTag` in `buildAttributeCanvas`. */
interface RegeneratedIdentifier {
  tag: string;
  donorValue: string;
  newValue: string;
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
  /** The real Metadata API zip path the donor (AttributeDiscount template) file was retrieved at — e.g. "unpackaged/expressionSetDefinitions/Donor.expressionSetDefinition-meta.xml". This is the deploy packaging step's reference for the real folder/suffix convention this org's Metadata API actually uses, instead of guessing one (§ZIP packaging bug investigation). */
  donorFileName?: string;
  lpLookup?: { lookUpId: string | null; lookUpApiName: string | null; lookUpName: string | null };
  /** Every actionType actually observed in the retrieved template Expression Set(s) — §Expression Set Retrieval verification. */
  observedActionTypes?: string[];
  /** Per-step parameter counts on the FINAL (patched) canvas — §XML Generation verification. */
  stepStats?: CanvasStepStats[];
  /** Variables declared on the donor template Expression Set. */
  variableCount?: number;
  /** §Structural schema comparison (donor vs. generated) — present when the comparison ran, whether it passed or not. Only non-empty text; see lib/pricing-rules/metadata/schemaDiff.ts. */
  schemaReport?: string;
  /** §Uniqueness — every envelope-level identifier tag (label/fullName/developerName/name/
   * expressionSetDefinition) this run actually regenerated, with its FINAL (generated, never donor)
   * value — present on success so a caller can validate them against the ORG (not just the donor this
   * function already compares against) before deploying. See `regenerateEnvelopeTag` below and
   * lib/pricing-rules/salesforce/orgUniquenessValidation.ts. */
  generatedIdentifiers?: { tag: string; value: string }[];
  fatalErrors: string[];
  warnings: string[];
}

export async function buildAttributeCanvas(
  client: SalesforceClient,
  ctx: {
    procedureName: string; apiName: string; description?: string;
    /** §Live progress — fired once, the moment the donor template's PricingSettings/ListPrice/
     * AttributeDiscount steps are all confirmed present (i.e. "Template Retrieved" is genuinely true) —
     * everything from here on is XML generation/validation, not template retrieval. Optional; omitting
     * it leaves this function's behavior completely unchanged. */
    onProgress?: (phase: "template-retrieved") => void;
  },
): Promise<CanvasBuildResult> {
  const warnings: string[] = [];
  const fatalErrors: string[] = [];

  const adMatch = await findTemplateStepByActionType(client, "AttributeDiscount");
  if (!adMatch) {
    return {
      success: false,
      fatalErrors: [
        "No deployed Expression Set in this org contains an AttributeDiscount step to clone from. Attribute-based pricing requires at least one existing, working Pricing Procedure with an attribute-based adjustment already configured — this action type cannot be authored from a blank canvas.",
      ],
      warnings,
    };
  }

  const donorFileXml = adMatch.fullXml;
  const observedActionTypes = new Set(
    extractStepBlocks(donorFileXml).map(s => getOwnActionType(s.content)).filter((v): v is string => !!v),
  );

  let psMatch: ElementSpan | null = findStepsByActionType(donorFileXml, "PricingSettings")[0] ?? null;
  if (!psMatch) {
    const alt = await findTemplateStepByActionType(client, "PricingSettings");
    if (alt) { psMatch = alt.matchingStep; observedActionTypes.add("PricingSettings"); }
  }

  let lpCandidates = findStepsByActionType(donorFileXml, "ListPrice");
  if (lpCandidates.length === 0) {
    const alt = await findTemplateStepByActionType(client, "ListPrice");
    if (alt) { lpCandidates = [alt.matchingStep]; observedActionTypes.add("ListPrice"); }
  }

  // §Waterfall-patch bug investigation — Checkpoint 1: every ListPrice step discovered in the
  // template, before any selection/patching happens.
  client.logDebug("xml-diagnostic", `[ListPrice discovery] ${lpCandidates.length} candidate(s) found: ${JSON.stringify(lpCandidates.map(c => describeStepForDiagnostics(c.full)))}`);

  const lpMatch: ElementSpan | null =
    lpCandidates.find(c => /price.?book/i.test(getParamValueByName(c.full, "LookUpName") ?? "")) ??
    lpCandidates.find(c => !/contract/i.test(getParamValueByName(c.full, "LookUpName") ?? "")) ??
    lpCandidates[0] ??
    null;

  if (!psMatch) fatalErrors.push("No PricingSettings step found in any retrieved template Expression Set.");
  if (!lpMatch) fatalErrors.push("No ListPrice step found in any retrieved template Expression Set.");
  if (fatalErrors.length > 0 || !psMatch || !lpMatch) {
    return { success: false, fatalErrors, warnings, observedActionTypes: [...observedActionTypes] };
  }

  // §Live progress — PricingSettings/ListPrice/AttributeDiscount are all confirmed present at this
  // point; everything below builds/validates/deploys XML, none of it is "retrieving the template".
  ctx.onProgress?.("template-retrieved");

  client.logDebug("xml-diagnostic", `[ListPrice selected] ${JSON.stringify(describeStepForDiagnostics(lpMatch.full))}`);

  const lpLookup = {
    lookUpId: getParamValueByName(lpMatch.full, "LookUpId"),
    lookUpApiName: getParamValueByName(lpMatch.full, "LookUpApiName"),
    lookUpName: getParamValueByName(lpMatch.full, "LookUpName"),
  };
  if (!lpLookup.lookUpId) warnings.push("Template ListPrice step has no LookUpId — the post-deploy Decision Table dataset refresh will be skipped.");

  const declaredVars = getDeclaredVariableNames(donorFileXml);

  const psXml = stripStepIdentity(psMatch.full, 1);

  // §Waterfall-patch bug investigation — Checkpoint 2: exact XML before the patch runs.
  client.logDebug("xml-diagnostic", `[ListPrice before patch] ${lpMatch.full}`);
  const lpPatched = patchListPriceWaterfall(lpMatch.full, warnings);
  // §Waterfall-patch bug investigation — Checkpoint 3: exact XML after the patch runs, plus an
  // explicit pass/fail on whether an output Parameter now carries NetUnitPrice.
  const lpPatchedHasNetUnitPriceOutput = getAllParameterBlocks(lpPatched).some(b => isOutputParam(b.block) && getParamValue(b.block) === "NetUnitPrice");
  client.logDebug("xml-diagnostic", `[ListPrice after patch] netUnitPriceOutputPresent=${lpPatchedHasNetUnitPriceOutput} (searched top-level AND nested inside <customElement>) xml=${lpPatched}`);

  const lpXml = stripStepIdentity(lpPatched, 2);

  // §7 — before generating AttributeDiscount AT ALL, verify ListPrice actually publishes NetUnitPrice
  // as an output (searched top-level AND nested inside <customElement> — never assumed). Wiring
  // AttributeDiscount's InputUnitPrice to consume a value ListPrice never actually produced would be
  // patching a connection that doesn't exist.
  const lpNetUnitPriceOutputsBeforeAd = getAllParameterBlocks(lpXml).filter(
    p => isOutputParam(p.block) && getTagValue(p.block, "type") === "Parameter" && getParamValue(p.block) === "NetUnitPrice",
  );
  if (lpNetUnitPriceOutputsBeforeAd.length !== 1) {
    fatalErrors.push(
      `ListPrice does not publish exactly one NetUnitPrice output (found ${lpNetUnitPriceOutputsBeforeAd.length}) — refusing to generate AttributeDiscount, since its InputUnitPrice binding would have nothing real to consume.`,
    );
    return { success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes] };
  }

  const originalAdXml = adMatch.matchingStep.full;
  let adXml = stripStepIdentity(originalAdXml, 3);
  adXml = patchA_stripProductLiterals(adXml);
  adXml = patchB_forceNetUnitPrice(adXml, warnings);
  adXml = patchC_preserveScheduleId(originalAdXml, adXml, warnings);
  adXml = patchD_normalizeMappings(adXml, declaredVars, warnings);

  // §8/§9/§10 — pricing-waterfall connection validation: print exactly what ListPrice publishes and
  // what AttributeDiscount consumes, then fail generation (before deployment) unless AttributeDiscount
  // is wired to consume the EXACT value ListPrice publishes — never two independently-hardcoded
  // literals that happen to match by convention.
  client.logDebug("xml-diagnostic", [
    "[Pricing Waterfall Validation]",
    "ListPrice Outputs:",
    ...(describeParameters(lpXml, b => isOutputParam(b) && getTagValue(b, "type") === "Parameter").length > 0
      ? describeParameters(lpXml, b => isOutputParam(b) && getTagValue(b, "type") === "Parameter")
      : ["  (none)"]),
    "AttributeDiscount Inputs (InputUnitPrice):",
    ...(describeParameters(adXml, b => getParamName(b) === "InputUnitPrice").length > 0
      ? describeParameters(adXml, b => getParamName(b) === "InputUnitPrice")
      : ["  (none)"]),
  ].join("\n"));

  const lpPublishedValue = getAllParameterBlocks(lpXml)
    .filter(p => isOutputParam(p.block) && getTagValue(p.block, "type") === "Parameter")
    .map(p => getParamValue(p.block))
    .find(v => v === "NetUnitPrice") ?? null;
  const adConsumedValue = getAllParameterBlocks(adXml)
    .filter(p => getParamName(p.block) === "InputUnitPrice")
    .map(p => getParamValue(p.block))[0] ?? null;

  if (!lpPublishedValue) {
    fatalErrors.push("Pricing-waterfall connection: ListPrice does not publish a NetUnitPrice output — see \"ListPrice Outputs\" in Debug Mode.");
  } else if (adConsumedValue !== lpPublishedValue) {
    fatalErrors.push(
      `Pricing-waterfall connection: AttributeDiscount's InputUnitPrice consumes "${adConsumedValue ?? "(not set)"}", but ListPrice publishes "${lpPublishedValue}" — AttributeDiscount must consume the exact parameter ListPrice publishes.`,
    );
  }

  fatalErrors.push(...postBuildGuard([
    { actionType: "PricingSettings", xml: psXml },
    { actionType: "ListPrice", xml: lpXml },
    { actionType: "AttributeDiscount", xml: adXml },
  ]));

  // §Waterfall-patch bug investigation — Checkpoint 4: every ListPrice-actionType step present in
  // the canvas about to be validated (there should be exactly one — the just-patched `lpXml` — but
  // this scans generically so a real duplicate would show up here instead of being assumed away).
  const lpStepsAtValidationTime = findStepsByActionType(lpXml, "ListPrice");
  client.logDebug("xml-diagnostic", `[Before validation] ${lpStepsAtValidationTime.length} ListPrice step(s) in the canvas about to be validated: ${JSON.stringify(lpStepsAtValidationTime.map(s => describeStepForDiagnostics(s.full)))}`);

  // §Step-level structural comparison — `compareExpressionSetSchema` (run later, against the full
  // spliced file) only sees the ROOT's direct children, so a repeated <steps> tag is one entry with
  // its own internal shape invisible to it. This walks INTO each <steps> element (donor vs. the
  // corresponding generated/patched step) and compares its OWN direct children, exact order, and
  // whether <parameters> is a direct child of <steps> or nested inside <customElement> — the exact
  // distinction behind "Element parameters invalid at this location in type ExpressionSetStep".
  // Always logged, for every one of the 3 steps individually; a mismatch is fatal, same as any other
  // structural validation failure in this function.
  const stepStructureReports = [
    compareStepStructure(psMatch, psXml, "PricingSettings"),
    compareStepStructure(lpMatch, lpXml, "ListPrice"),
    compareStepStructure(adMatch.matchingStep, adXml, "AttributeDiscount"),
  ];
  client.logDebug("xml-diagnostic", stepStructureReports.map(r => r.reportText).join("\n\n"));
  for (const report of stepStructureReports) {
    if (!report.structurallyValid) {
      fatalErrors.push(`Step-level structural mismatch on "${report.actionType}" — ${[...report.invalidPlacements, ...report.missingNodes.map(n => `Missing node ${n}`)].join(" ")}`);
    }
  }

  const validation = validateAttributeCanvas({ psXml, lpXml, adXml }, observedActionTypes, declaredVars);
  fatalErrors.push(...validation.fatal);
  warnings.push(...validation.warnings);

  const stepStats: CanvasStepStats[] = [
    { actionType: "PricingSettings", parameterCount: countParameters(psXml) },
    { actionType: "ListPrice", parameterCount: countParameters(lpXml) },
    { actionType: "AttributeDiscount", parameterCount: countParameters(adXml) },
  ];

  if (fatalErrors.length > 0) {
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size,
      schemaReport: stepStructureReports.map(r => r.reportText).join("\n\n"),
    };
  }

  // Splice the 3 new steps into the donor file in place of every existing top-level step,
  // AT THE EXACT POSITION the donor's own <steps> elements occupied in its sibling sequence.
  //
  // §Schema-order bug investigation: a prior version of this splice removed every top-level
  // <steps> block and then inserted the replacement steps immediately before the ROOT closing
  // tag, regardless of what other sibling elements (e.g. <status>/<versions>/other trailing
  // metadata) originally followed the donor's <steps> in the file. Salesforce's Metadata API
  // enforces a strict child-element ORDER for ExpressionSetDefinition (an XSD sequence) — moving
  // <steps> after elements that must follow it is exactly what produces "Element steps invalid
  // at this location in type ExpressionSetDefinition". The donor's OWN structure is the only
  // reliable reference for where <steps> belongs, so this now re-inserts at the donor's original
  // first-<steps> offset instead of guessing "right before the root close tag".
  let finalFileXml = donorFileXml;
  const originalStepSpans = outermostSpans(extractStepBlocks(finalFileXml));
  if (originalStepSpans.length === 0) {
    fatalErrors.push("The donor Expression Set has no top-level <steps> element — there is no safe, non-guessed position to insert the generated steps at.");
    return { success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size };
  }
  const toRemove = [...originalStepSpans].sort((a, b) => b.start - a.start);
  // `toRemove` is sorted descending by start, so its LAST entry has the smallest start — i.e.
  // the donor's FIRST <steps> element. Nothing before that offset is ever touched by the removal
  // loop below, so it remains the correct re-insertion point after every <steps> block is removed.
  const insertionOffset = toRemove[toRemove.length - 1].start;
  client.logDebug("xml-diagnostic", `[Schema-order] donor has ${originalStepSpans.length} top-level <steps> element(s); first one starts at offset ${insertionOffset} — re-inserting the generated steps there to preserve the donor's original sibling order.`);
  for (const span of toRemove) {
    finalFileXml = finalFileXml.slice(0, span.start) + finalFileXml.slice(span.end);
  }
  const newStepsXml = psXml + lpXml + adXml;
  finalFileXml = finalFileXml.slice(0, insertionOffset) + newStepsXml + finalFileXml.slice(insertionOffset);

  // §Uniqueness — every identifier Salesforce enforces as unique across the org (the version's own
  // fullName/label, its self-reference back to this definition, any internal name/developerName) must
  // NEVER be copied verbatim from the donor: that's exactly what a deploy-time "duplicate value found...
  // duplicates value on record with id" means — the file being deployed still declares the DONOR's own
  // unique key, not an XML shape problem. Every occurrence is regenerated from the new Pricing
  // Procedure's own name/API name instead. Scoped strictly to the envelope OUTSIDE the freshly-generated
  // <steps> region (`newStepsXml`, already spliced in above) — a step parameter's own `<name>`/`<label>`
  // (e.g. `<name>InputUnitPrice</name>`) is legitimate donor-derived content that must never be touched;
  // only the envelope around the steps (label/description/fullName/developerName/name/
  // expressionSetDefinition — wherever any of those tags actually appear in THIS org's donor) is rewritten,
  // and only the identifier VALUES change — no tag is added, removed, or reordered (§5).
  const stepsRegionStart = insertionOffset;
  const stepsRegionEnd = insertionOffset + newStepsXml.length;
  let envelopeBefore = finalFileXml.slice(0, stepsRegionStart);
  let envelopeAfter = finalFileXml.slice(stepsRegionEnd);

  // §D bug fix — a `<variables>` element's own `<name>`/`<description>` (the variable's IDENTITY,
  // legitimately unique per-variable in the donor) lives in this same envelope region and was being
  // caught by the generic `<name>`/`<description>` regeneration below, overwriting EVERY variable's name
  // with the SAME apiName — this is the exact "Variable name already exists" deploy failure found in the
  // attached failed package. Every `<variables>...</variables>` block is swapped out for an opaque,
  // never-XML-shaped placeholder token BEFORE any regeneration runs, and restored byte-for-byte
  // afterward — the donor's own (already-unique) variable identities are never touched by this pass.
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
   * pre-deployment report (§3). A tag that doesn't occur in this org's donor is simply never matched;
   * nothing is fabricated. */
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
  // `versions/fullName` (and any other `<fullName>`) commonly carries a "<DeveloperName><separator><
  // VersionNumber>" shape (e.g. "Donor.1", "Donor-1") — the donor's own SEPARATOR+NUMBER suffix is
  // preserved (never guessed as a literal format) while only the identifying name portion is replaced,
  // exactly the same "preserve donor structure, substitute only the identifying value" principle already
  // used by the parameter patches above.
  regenerateEnvelopeTag("fullName", donorValue => {
    const suffixMatch = donorValue.match(/^(.*?)([._-]\d+)$/);
    return escapeXml(suffixMatch ? `${ctx.apiName}${suffixMatch[2]}` : ctx.apiName);
  });
  regenerateEnvelopeTag("developerName", () => escapeXml(ctx.apiName));
  regenerateEnvelopeTag("name", () => escapeXml(ctx.apiName));
  // `versions/expressionSetDefinition` — a version's self-reference back to its OWN parent Definition —
  // must point at the NEW Definition's identifier, never the donor's.
  regenerateEnvelopeTag("expressionSetDefinition", () => escapeXml(ctx.apiName));

  // Restore every `<variables>` block exactly as the donor had it — untouched by any of the
  // regeneration above.
  envelopeBefore = restoreBlocks(envelopeBefore);
  envelopeAfter = restoreBlocks(envelopeAfter);

  finalFileXml = envelopeBefore + newStepsXml + envelopeAfter;

  // §D — pre-deployment validation: no two `<variables><name>` values may collide (this is exactly what
  // Salesforce's Metadata API rejects a deploy for with "Variable name already exists. Please enter a
  // different name."). Independent of the protection above — this is the hard backstop that guarantees
  // deployment is never even attempted if a duplicate somehow still exists, regardless of how it got
  // there.
  interface VariableNameOccurrence { name: string; description: string | null }
  const variableOccurrences: VariableNameOccurrence[] = extractFlatBlocks(finalFileXml, "variables").map(block => ({
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
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size,
    };
  }

  // §3 — the complete pre-deployment validation report: every regenerated identifier next to the
  // donor's original value for that same tag occurrence, always logged (pass or fail).
  const donorCollisions = regeneratedIdentifiers.filter(r => r.donorValue.trim() !== "" && r.newValue === r.donorValue);
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
    "Donor -> Generated (every occurrence):",
    ...(regeneratedIdentifiers.length > 0
      ? regeneratedIdentifiers.map(r => `  <${r.tag}> donor="${r.donorValue}" -> generated="${r.newValue}"${r.newValue === r.donorValue ? "  *** STILL IDENTICAL TO DONOR ***" : ""}`)
      : ["  (no unique-identifier tags found in this org's donor envelope — nothing to regenerate)"]),
    "==================================================",
  ].join("\n"));
  if (donorCollisions.length > 0) {
    fatalErrors.push(
      `Refusing to deploy — ${donorCollisions.length} regenerated identifier(s) are still identical to the donor template's own value: ${donorCollisions.map(c => `<${c.tag}>="${c.donorValue}"`).join(", ")}. This only happens when the new Pricing Procedure's own name/API name coincidentally matches the donor template's — rename the Pricing Procedure (or its API Name) so it cannot collide with the donor before retrying.`,
    );
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes], stepStats, variableCount: declaredVars.size,
    };
  }

  // §Structural schema comparison — before deployment, compare the generated file's SHAPE
  // (root element, namespaces, child ordering, every child under the root) against the donor's,
  // per explicit instruction: the donor is the only canonical reference this build has access to
  // (no live org, no published XSD). Always logged; a structural divergence — wrong root, reordered
  // children, or a donor-required child missing — is fatal and blocks deploy, same as any other
  // validation failure below.
  const schemaComparison = compareExpressionSetSchema(donorFileXml, finalFileXml);
  client.logDebug("xml-diagnostic", schemaComparison.reportText);
  // Combined report — root-level shape (compareExpressionSetSchema) AND per-step internal shape
  // (compareStepStructure, computed earlier) together, so the failure panel always shows both levels
  // of structural comparison rather than just whichever one happened to catch the failure.
  const combinedSchemaReport = [schemaComparison.reportText, ...stepStructureReports.map(r => r.reportText)].join("\n\n");
  if (!schemaComparison.structurallyValid) {
    fatalErrors.push(...schemaComparison.issues);
    return {
      success: false, fatalErrors, warnings, lpLookup, observedActionTypes: [...observedActionTypes],
      stepStats, variableCount: declaredVars.size, schemaReport: combinedSchemaReport,
    };
  }

  return {
    success: true,
    finalFileXml,
    finalSteps: [
      { actionType: "PricingSettings", xml: psXml },
      { actionType: "ListPrice", xml: lpXml },
      { actionType: "AttributeDiscount", xml: adXml },
    ],
    donorFileName: adMatch.fileName,
    lpLookup,
    observedActionTypes: [...observedActionTypes],
    stepStats,
    variableCount: declaredVars.size,
    schemaReport: combinedSchemaReport,
    generatedIdentifiers: regeneratedIdentifiers.map(r => ({ tag: r.tag, value: r.newValue })),
    fatalErrors: [],
    warnings,
  };
}
