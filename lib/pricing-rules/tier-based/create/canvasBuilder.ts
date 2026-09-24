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
  extractStepGraph, getTagValue, escapeXml, type PhysicalStepNode,
  getTopLevelParameterBlocks, getNestedCustomElementParameterBlocks,
  getParamName, getParamValue, extractFlatBlocks,
} from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences, findDanglingParentStepReferences } from "@/lib/pricing-rules/attribute-based/create/pricingCanvasPruning";
import { compareExpressionSetSchema, compareStepStructure, type StepStructureReport } from "@/lib/pricing-rules/attribute-based/create/schemaDiff";
import {
  injectVersionNumberAndRank, regenerateVersionedFullName, stripEnvelopeSalesforceIds,
  protectXmlBlocks, restoreXmlBlocks,
} from "@/lib/pricing-rules/attribute-based/create/versionEnvelopeFields";
import {
  resolvePriceBookEntriesV2DecisionTable, resolveTieredAdjustmentEntriesDecisionTable,
  formatExactDecisionTableFailure, formatDecisionTableMappingDiagnostic,
  PRICE_BOOK_DECISION_TABLE_LABEL, TIERED_ADJUSTMENT_DECISION_TABLE_LABEL,
} from "@/lib/pricing-rules/attribute-based/create/decisionTableExactResolver";
import { resolveTierBasedPricingDonor, resolveConnectedAncestor, SHARED_SIGNAL_ACTION_TYPES, buildNoCoherentDonorDiagnostic, type ConnectionMechanism } from "./donorInspection";

const UNIT_PRICE_SEMANTIC_PRIORITY = ["UnitPrice", "NetUnitPrice", "ListPrice"];

/** Mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's ATTR_REQUIRED_ACTION_TYPES /
 * ATTR_BLOCKED_ACTION_TYPES naming convention exactly (Section 9, bug #4 of the port spec this module
 * follows) — an explicit required/blocked action-type check against the final composed canvas, on top of
 * (not instead of) the exact-count assertions below. */
export const TIER_REQUIRED_ACTION_TYPES = new Set(["PricingSettings", "ListPrice", "VolumeTierDiscount"]);
export const TIER_BLOCKED_ACTION_TYPES = new Set(["PriceBookEntry", "ListContainer", "ListOperation", "AttributeBasedPrice", "AttributeDiscount", "BundleDiscount"]);

export interface DecisionTableLookup { id: string; name: string; apiName: string; }

function collectFieldMap(xmlSlice: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of [...getTopLevelParameterBlocks(xmlSlice), ...getNestedCustomElementParameterBlocks(xmlSlice)]) {
    const n = getParamName(b.block);
    if (n) map.set(n, getParamValue(b.block));
  }
  return map;
}

/** Full raw `<parameters>...</parameters>` block (top-level or customElement-nested) for a given parameter
 * `<name>` within a step's own full XML, or null if the step declares no such parameter at all. */
export function findNamedParameterBlock(stepFullXml: string, paramName: string): string | null {
  const blocks = [...getTopLevelParameterBlocks(stepFullXml), ...getNestedCustomElementParameterBlocks(stepFullXml)];
  return blocks.find(b => getParamName(b.block) === paramName)?.block ?? null;
}

/**
 * §Live-org investigation — TBP-20260923-183424-4B03 ("Specify a valid data type for the LowerBoundField
 * variable"). `LowerBoundField`/`UpperBoundField` are a VolumeTierDiscount field/variable REFERENCE (their
 * own datatype + binding), NOT the numeric `LowerBound`/`UpperBound` threshold values — this codebase has
 * zero bespoke handling of either name (grep-verified against the whole repo), and neither is ever named
 * in any `patchParamValue`/`patchParamType` call in this file, so this pipeline never intentionally
 * rewrites either parameter. The only defensible invariant assertable here WITHOUT fabricating a specific
 * expected Salesforce datatype string (which would just be a different guess) is: whatever the donor's own
 * VolumeTierDiscount declares for this parameter must survive, byte-for-byte, all the way through
 * stripIds/pruning/splicing/reparse into the FINAL composed canvas — any difference proves something in
 * THIS pipeline corrupted it, and deploying it forward instead of failing closed here is exactly what let
 * the Metadata API discover it far too late. A donor that declares no such parameter at all is not itself
 * an error (some orgs' schedule-based VolumeTierDiscount may not declare an open-ended-tier field
 * reference) — there is nothing to preserve in that case.
 */
export function validateFieldReferenceParamPreserved(
  donorVtdFullXml: string, finalVtdFullXml: string, paramName: string, errorCode: string,
): { fatal: string | null; diagnostic: string } {
  const before = findNamedParameterBlock(donorVtdFullXml, paramName);
  const after = findNamedParameterBlock(finalVtdFullXml, paramName);
  const diagnostic =
    `${paramName}:\n` +
    `  donor VolumeTierDiscount fragment:    ${before ?? "(this parameter is not declared at all)"}\n` +
    `  final composed VolumeTierDiscount fragment: ${after ?? "(this parameter is not declared at all)"}`;

  if (before === null) return { fatal: null, diagnostic };
  if (after === null) {
    return {
      fatal: `${errorCode}: the donor's VolumeTierDiscount declares a "${paramName}" parameter, but the final composed canvas's VolumeTierDiscount has NO "${paramName}" parameter at all — it was lost during cloning/patching/pruning.\n${diagnostic}`,
      diagnostic,
    };
  }
  if (before !== after) {
    return {
      fatal: `${errorCode}: the final composed canvas's "${paramName}" parameter no longer matches the donor's own "${paramName}" parameter byte-for-byte — this pipeline never intentionally patches this field, so any difference means it was corrupted (a stray text-patch match, an over-broad <id> strip, or a lost customElement/variable-definition block).\n${diagnostic}`,
      diagnostic,
    };
  }
  const value = getParamValue(after);
  const type = getTagValue(after, "type");
  if (!value || value.trim() === "") {
    return { fatal: `${errorCode}: the final composed canvas's "${paramName}" parameter has an empty <value> — refusing to deploy a field reference with no target.\n${diagnostic}`, diagnostic };
  }
  if (!type || type.trim() === "") {
    return { fatal: `${errorCode}: the final composed canvas's "${paramName}" parameter has no <type> (datatype/binding-kind) — Salesforce requires this; refusing to deploy.\n${diagnostic}`, diagnostic };
  }
  return { fatal: null, diagnostic };
}

/**
 * §TBP-20260924-064323-C4D9 — "Specify a valid data type for the LowerBoundField variable." Byte-for-byte
 * PARAMETER preservation (`validateFieldReferenceParamPreserved` above) proves the `<parameters>` block
 * itself survived unchanged — it does NOT prove the thing that parameter's `<value>` REFERENCES BY NAME
 * (a `<variables>` declaration, living in the envelope region — see `protectVariableBlocks` above) also
 * survived, still under the SAME name, still carrying a real datatype. This function traces that second
 * link explicitly: if the parameter's value matches the `<name>` of a `<variables>` block declared
 * anywhere in the donor, it locates that SAME-named variable in the final assembled file and reports
 * whether it's still there and still carries type/dataType metadata — never assumed from the parameter's
 * own preservation alone.
 */
export interface FieldReferenceVariableAudit {
  paramName: string;
  donorParamFragment: string | null;
  finalParamFragment: string | null;
  /** The variable name the parameter's `<value>` appears to reference — null when that value doesn't
   * match any `<variables>` declaration found in the donor (e.g. it's a literal, not a variable reference). */
  referencedVariableName: string | null;
  donorVariableFragment: string | null;
  finalVariableFragment: string | null;
}

function findVariableBlockByName(fullXml: string, variableName: string): string | null {
  return extractFlatBlocks(fullXml, "variables").find(b => getTagValue(b, "name") === variableName) ?? null;
}

/** Any sub-tag whose name contains "type" (case-insensitive) inside a `<variables>` block — e.g.
 * `<dataType>`/`<type>`/`<objectType>`, whichever this org's real schema actually uses; never assumed to
 * be one specific tag name, since no real donor sample of this exact block shape is available to confirm it. */
function extractAnyTypeLikeTagValue(variableBlock: string): { tag: string; value: string } | null {
  const re = /<([A-Za-z][\w]*)>([^<]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(variableBlock))) {
    if (/type/i.test(m[1]) && m[2].trim() !== "") return { tag: m[1], value: m[2].trim() };
  }
  return null;
}

export function auditFieldReferenceVariable(
  paramName: string,
  donorVtdFullXml: string,
  finalVtdFullXml: string,
  donorFullFileXml: string,
  finalFullFileXml: string,
): FieldReferenceVariableAudit {
  const donorParam = findNamedParameterBlock(donorVtdFullXml, paramName);
  const finalParam = findNamedParameterBlock(finalVtdFullXml, paramName);
  const referencedValue = donorParam ? getParamValue(donorParam) : null;
  const referencedVariableName = referencedValue && findVariableBlockByName(donorFullFileXml, referencedValue) ? referencedValue : null;
  return {
    paramName,
    donorParamFragment: donorParam,
    finalParamFragment: finalParam,
    referencedVariableName,
    donorVariableFragment: referencedVariableName ? findVariableBlockByName(donorFullFileXml, referencedVariableName) : null,
    finalVariableFragment: referencedVariableName ? findVariableBlockByName(finalFullFileXml, referencedVariableName) : null,
  };
}

/**
 * §Part 8 — semantic (not merely byte-for-byte) validation: if the donor proves `paramName`'s value is a
 * reference to a declared variable, that SAME variable must still exist, under the SAME name, in the
 * final canvas, and must still carry SOME type/dataType-shaped metadata. Fails closed with
 * `errorCode` (e.g. "LOWER_BOUND_FIELD_INVALID_DATATYPE") — never silently trusts that parameter-level
 * preservation alone proves the reference still resolves to something valid.
 */
export function validateFieldReferenceVariableSemantics(
  audit: FieldReferenceVariableAudit,
  errorCode: string,
): { fatal: string | null; diagnostic: string } {
  const diagnostic =
    `${audit.paramName} referenced variable: ${audit.referencedVariableName ?? "(not a variable reference — value does not match any declared <variables> name)"}\n` +
    `  donor variable fragment: ${audit.donorVariableFragment ?? "(none)"}\n` +
    `  final variable fragment: ${audit.finalVariableFragment ?? "(none)"}`;

  if (!audit.referencedVariableName) return { fatal: null, diagnostic };
  if (!audit.finalVariableFragment) {
    return {
      fatal: `${errorCode}: "${audit.paramName}" references variable "${audit.referencedVariableName}", which the donor declares (${audit.donorVariableFragment}) but which no longer exists in the final composed canvas — the reference is dangling; Salesforce cannot resolve a data type for a variable that isn't declared.\n${diagnostic}`,
      diagnostic,
    };
  }
  const finalTypeInfo = extractAnyTypeLikeTagValue(audit.finalVariableFragment);
  if (!finalTypeInfo) {
    return {
      fatal: `${errorCode}: "${audit.paramName}" references variable "${audit.referencedVariableName}", which exists in the final canvas but declares no type/dataType-shaped field at all (fragment: ${audit.finalVariableFragment}) — refusing to deploy a variable reference with no resolvable data type.\n${diagnostic}`,
      diagnostic,
    };
  }
  if (audit.donorVariableFragment && audit.donorVariableFragment !== audit.finalVariableFragment) {
    return {
      fatal: `${errorCode}: "${audit.paramName}"'s referenced variable "${audit.referencedVariableName}" changed between donor and final canvas — donor: ${audit.donorVariableFragment} | final: ${audit.finalVariableFragment}. This pipeline never intentionally edits a <variables> declaration; any difference is corruption.\n${diagnostic}`,
      diagnostic,
    };
  }
  return { fatal: null, diagnostic };
}

/**
 * §Live-org fix — mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own
 * `resolveListPriceByContractFlavorFallback` exactly (same donor evidence: `Rev_Mgmt_Default_Pricing_
 * Procedure2_V1` has two ListPrice branches — one Price Book, one Contract Pricing — where the schedule-
 * based VolumeTierDiscount branch resolves to PricingSettings via `price-waterfall-variable` but to NEITHER
 * ListPrice branch via any of the 4 direct connectivity mechanisms, because neither ListPrice branch
 * publishes the `NetUnitPrice` value VolumeTierDiscount consumes — PricingSettings does). LAST-RESORT
 * ListPrice pairing, used only when `resolveConnectedAncestor(..., "ListPrice")` finds no mechanism at all.
 * ListPrice still must be cloned — it remains a real, required step in the pricing procedure (the "waterfall
 * bridge" patch further down forces whichever LP step is chosen here to publish `NetUnitPrice`) — this only
 * decides WHICH ListPrice occurrence to clone when direct evidence can't. Never a name-only/arbitrary pick:
 * matches VolumeTierDiscount's own `IsContractEnabled` flag against each ListPrice candidate's own
 * contract-flavored field naming, and refuses to guess (returns `node: null`) unless exactly one candidate
 * matches.
 */
export type ContractEnabledBindingOutcome =
  | { status: "resolved"; node: PhysicalStepNode; reason: string }
  | { status: "not-applicable"; reason: string }
  | { status: "conflict"; reason: string };

/**
 * §Live-org fix — mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own
 * `resolveListPriceByContractEnabledBinding` exactly. This is a MORE PRECISE signal than
 * `resolveListPriceByContractFlavorFallback` below: it compares each ListPrice candidate's OWN declared
 * `IsContractEnabled` parameter VALUE (a literal true/false a Decision-Table-lookup step declares about
 * itself) against VolumeTierDiscount's own value — a direct field-to-field match, never a fuzzy
 * name/value substring search. Tried FIRST, before the flavor fallback, exactly matching
 * `resolvePricingFlowAncestors`'s own priority order in the attribute-based module. A "conflict" (missing
 * values, all-mismatched, or ambiguous multi-match) is fail-closed and must never fall through to a
 * weaker signal that could pick one of the very candidates this mechanism just proved indistinguishable.
 */
export function resolveListPriceByContractEnabledBinding(graph: PhysicalStepNode[], vtdNode: PhysicalStepNode): ContractEnabledBindingOutcome {
  const vtdRaw = collectFieldMap(vtdNode.full).get("IsContractEnabled") ?? null;
  if (vtdRaw === null) {
    return { status: "not-applicable", reason: `VolumeTierDiscount [${vtdNode.occurrenceIndex}] declares no IsContractEnabled parameter — this mechanism does not apply.` };
  }
  const vtdNorm = vtdRaw.trim().toLowerCase();
  if (vtdNorm !== "true" && vtdNorm !== "false") {
    return { status: "conflict", reason: `VolumeTierDiscount [${vtdNode.occurrenceIndex}]'s IsContractEnabled value ("${vtdRaw}") is not a literal true/false — refusing to guess.` };
  }
  const vtdBool = vtdNorm === "true";

  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  if (listPriceNodes.length === 0) {
    return { status: "not-applicable", reason: "No ListPrice occurrence exists anywhere in this donor — this mechanism does not apply." };
  }

  const withValues = listPriceNodes.map(lp => ({ lp, raw: collectFieldMap(lp.full).get("IsContractEnabled") ?? null }));
  const invalid = withValues.filter(v => v.raw === null || !["true", "false"].includes(v.raw.trim().toLowerCase()));
  if (invalid.length > 0) {
    return {
      status: "conflict",
      reason: `${invalid.length} of ${listPriceNodes.length} ListPrice occurrence(s) have a missing or non-literal IsContractEnabled value (${invalid.map(v => `[${v.lp.occurrenceIndex}]=${v.raw ?? "(none)"}`).join(", ")}) — insufficient evidence to trust this mechanism for any candidate; refusing to guess.`,
    };
  }

  const matches = withValues.filter(v => (v.raw!.trim().toLowerCase() === "true") === vtdBool);
  if (matches.length === 0) {
    return {
      status: "conflict",
      reason: `0 of ${listPriceNodes.length} ListPrice occurrence(s) declare IsContractEnabled=${vtdBool} (all declare the opposite) — refusing to guess.`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "conflict",
      reason: `ambiguous: ${matches.length} ListPrice occurrences share IsContractEnabled=${vtdBool} ([${matches.map(m => m.lp.occurrenceIndex).join(", ")}]) — refusing to guess which one.`,
    };
  }
  const winner = matches[0];
  return {
    status: "resolved",
    node: winner.lp,
    reason: `Matched ListPrice [${winner.lp.occurrenceIndex}] via the donor's own explicit IsContractEnabled=${vtdBool} binding — a direct parameter declared on both VolumeTierDiscount [${vtdNode.occurrenceIndex}] and this ListPrice occurrence, unambiguous among ${listPriceNodes.length} candidate(s).`,
  };
}

export function resolveListPriceByContractFlavorFallback(graph: PhysicalStepNode[], vtdNode: PhysicalStepNode): { node: PhysicalStepNode | null; reason: string } {
  const listPriceNodes = graph.filter(n => n.actionType === "ListPrice");
  if (listPriceNodes.length === 0) return { node: null, reason: "No ListPrice occurrence exists anywhere in this donor." };
  if (listPriceNodes.length === 1) {
    return { node: listPriceNodes[0], reason: "Exactly one ListPrice occurrence exists in this donor — unambiguous regardless of connectivity signal." };
  }

  const vtdFields = collectFieldMap(vtdNode.full);
  const vtdIsContractEnabledRaw = vtdFields.get("IsContractEnabled") ?? null;
  if (vtdIsContractEnabledRaw === null) {
    return {
      node: null,
      reason: `${listPriceNodes.length} ListPrice occurrences exist in this donor, and VolumeTierDiscount [${vtdNode.occurrenceIndex}] declares no IsContractEnabled flag to disambiguate by — refusing to guess which one it uses.`,
    };
  }
  const vtdIsContractEnabled = vtdIsContractEnabledRaw.toLowerCase() === "true";

  const matches = listPriceNodes.filter(lp => {
    const fields = collectFieldMap(lp.full);
    const contractFlavored = [...fields.entries()].some(([k, v]) => /contract/i.test(k) || (v !== null && /contract/i.test(v)));
    return contractFlavored === vtdIsContractEnabled;
  });
  if (matches.length !== 1) {
    return {
      node: null,
      reason: `${listPriceNodes.length} ListPrice occurrences exist; VolumeTierDiscount [${vtdNode.occurrenceIndex}]'s IsContractEnabled=${vtdIsContractEnabled} matched ${matches.length} of them by contract-flavored field naming (expected exactly 1) — refusing to guess which one it uses.`,
    };
  }
  return {
    node: matches[0],
    reason: `Matched ListPrice [${matches[0].occurrenceIndex}] via IsContractEnabled=${vtdIsContractEnabled} against its own contract-flavored field naming — a lower-confidence, last-resort signal used only because no direct connectivity mechanism (parentStep chain, physical nesting, variable binding, or sequence order) resolved.`,
  };
}

/** §TEMPORARY — read-only diagnostic only, never consulted by either resolver above. Dumps every ListPrice
 * occurrence's full identity (path/sequence/parentStep), every output-flagged parameter, and its own
 * IsContractEnabled value, so a disambiguation failure (or success) is fully auditable without needing a
 * second Salesforce round-trip. */
export interface ListPriceCandidateFieldDump {
  occurrenceIndex: number;
  pathLabel: string;
  sequenceNumber: string | null;
  parentStep: string | null;
  actionType: string | null;
  outputBindings: { name: string | null; value: string | null }[];
  isContractEnabled: string | null;
}

function dumpListPriceCandidates(graph: PhysicalStepNode[]): ListPriceCandidateFieldDump[] {
  return graph.filter(n => n.actionType === "ListPrice").map(n => ({
    occurrenceIndex: n.occurrenceIndex, pathLabel: n.pathLabel, sequenceNumber: n.sequenceNumber, parentStep: n.parentStep, actionType: n.actionType,
    outputBindings: [...getTopLevelParameterBlocks(n.full), ...getNestedCustomElementParameterBlocks(n.full)]
      .filter(b => getTagValue(b.block, "output") === "true")
      .map(b => ({ name: getParamName(b.block), value: getParamValue(b.block) })),
    isContractEnabled: collectFieldMap(n.full).get("IsContractEnabled") ?? null,
  }));
}

function formatListPriceCandidateDump(dump: ListPriceCandidateFieldDump[], selectedOccurrenceIndex: number | null): string {
  const lines: string[] = [];
  for (const c of dump) {
    lines.push("ListPrice candidate:");
    lines.push(`  occurrence: ${c.occurrenceIndex} (${c.pathLabel}, sequenceNumber=${c.sequenceNumber ?? "(none)"}, parentStep=${c.parentStep ?? "(none)"})`);
    lines.push(`  IsContractEnabled: ${c.isContractEnabled ?? "(none)"}`);
    lines.push("  outputs:");
    if (c.outputBindings.length === 0) lines.push("    (none)");
    for (const o of c.outputBindings) lines.push(`    ${o.name ?? "(unnamed)"} = ${o.value ?? "(no value)"}`);
  }
  lines.push(selectedOccurrenceIndex !== null ? `Selected: occurrence ${selectedOccurrenceIndex}` : "Selected: (none — resolution failed)");
  return lines.join("\n");
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

/** Strips only stale donor-org record `<id>` tags — never touches `<parentStep>`. Used on its own for the
 * VolumeTierDiscount fragment (see `stripIdsAndParentStep`'s own doc comment for why). */
function stripIds(stepFullXml: string): string {
  return stepFullXml.replace(/<id>[0-9A-Za-z]{15,18}<\/id>\s*/g, "");
}

/**
 * §Live-org fix — `<parentStep>` removal is a PRUNING-INPUT concern (avoid the composed root-level PS/LP/
 * VTD steps carrying a canvas-placement reference into a UI-grouping container that isn't one of the 3
 * required steps), completely separate from `compareStepStructure`'s SCHEMA-COMPLETENESS check (Task 2):
 * that check only compares direct-child TAG NAMES/order against the donor's own step — it never inspects
 * `<parentStep>`'s VALUE — so this donor's own VolumeTierDiscount, which (unlike PricingSettings/ListPrice
 * in this exact donor) declares a real, non-empty `<parentStep>` as one of its required direct children,
 * fails that comparison whenever the tag itself is missing, regardless of whether the value would still
 * make semantic sense post-pruning. Kept for PricingSettings/ListPrice (`psXml`/`lpXml` below) — evidenced,
 * not assumed: their own structural reports passed even with this stripping, meaning their donor children
 * either have no `<parentStep>` at all or an already-empty one, so stripping it is a no-op for them; only
 * VolumeTierDiscount is documented (via this exact failure) to require the tag itself. Applied to `psXml`/
 * `lpXml` only — VolumeTierDiscount uses `stripIds` alone below, preserving its own `<parentStep>` (donor
 * value, donor position) so `compareStepStructure` sees the same direct-child shape the donor has.
 */
function stripIdsAndParentStep(stepFullXml: string): string {
  return stripIds(stepFullXml.replace(/<parentStep>[^<]*<\/parentStep>\s*/g, ""));
}

function renumberSequence(stepFullXml: string, seq: number): string {
  return stepFullXml.replace(/<sequenceNumber>\d+<\/sequenceNumber>/, `<sequenceNumber>${seq}</sequenceNumber>`);
}

/**
 * §Live-org fix — mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own
 * `resolveTargetInputUnitPriceValue` exactly. Resolution order:
 *   1. Exactly one output published → use it (unambiguous by definition).
 *   2. The donor's OWN existing InputUnitPrice binding already equals one of the real published outputs
 *      → keep it, no guess needed.
 *   3. Otherwise, the FIRST name from `UNIT_PRICE_SEMANTIC_PRIORITY` that IS one of the published outputs.
 *   4. None of the above resolves (2+ outputs, none matching) → `null` — the caller must treat this as a
 *      hard failure, never a guess. A prior version of this function fell back to `donorLpOutputValues[0]`
 *      here — an array-order assumption attribute-based's own proven copy never makes; removed.
 */
function resolveTargetInputUnitPriceValue(donorInputUnitPrice: string | null, donorLpOutputValues: string[]): string | null {
  if (donorLpOutputValues.length === 1) return donorLpOutputValues[0];
  if (donorInputUnitPrice && donorLpOutputValues.includes(donorInputUnitPrice)) return donorInputUnitPrice;
  return UNIT_PRICE_SEMANTIC_PRIORITY.find(name => donorLpOutputValues.includes(name)) ?? null;
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
  ctx: {
    procedureName: string; apiName: string; description?: string; versionNumber?: number; rank?: number | null;
    /** §TBP-20260923-210132-FAD5 — the AUTHORITATIVE, already-resolved ExpressionSetVersion identity
     * (e.g. "Keyboard_Tier_Based_Pricing_Procedure_V2"), computed ONCE by
     * `resolveExpressionSetIdentityPlan` (orgUniquenessValidation.ts) before this function ever runs. When
     * provided, `<fullName>` is set to this value VERBATIM — this function never independently
     * reconstructs the identity from the donor's own suffix shape or from `apiName`/`versionNumber` alone.
     * Omitted only by a caller that hasn't been updated to resolve a plan (falls back to the donor-suffix-
     * mirroring `regenerateVersionedFullName` behavior for backward compatibility). */
    fullName?: string;
    onProgress?: (phase: "template-retrieved") => void;
  },
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
  if (!psResolution.node) {
    fatalErrors.push(`Selected VolumeTierDiscount branch (occurrence ${vtdNode.occurrenceIndex}) does not resolve to a PricingSettings ancestor via any known mechanism (<parentStep> chain, physical nesting, the shared price-waterfall variable, or declared sequence order).`);
    return { success: false, fatalErrors, warnings };
  }
  const psNode = psResolution.node;
  let lpNode = lpResolution.node;
  // Tracks how `lpNode` was actually obtained, for the warnings below — distinct from `lpResolution.mechanism`,
  // which stays "none" when one of the fallbacks further down is what actually supplied it.
  let lpMechanismLabel: ConnectionMechanism | "contract-enabled-binding" | "contract-flavor-fallback" = lpResolution.mechanism;

  if (!lpNode) {
    // §Live-org fix — mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own proven fix for
    // this exact donor (Rev_Mgmt_Default_Pricing_Procedure2_V1): PricingSettings is proven connected (here,
    // via price-waterfall-variable — donor resolution already confirmed VolumeTierDiscount's InputUnitPrice
    // unambiguously matches PricingSettings' own published NetUnitPrice output), but no direct ListPrice
    // connectivity signal resolves, because this donor's ListPrice branches never publish NetUnitPrice
    // themselves. ListPrice must still be cloned — it remains a real, required step in the pricing procedure
    // (see TIER_REQUIRED_ACTION_TYPES, and the waterfall-bridge patch below, which forces whichever LP step
    // is chosen here to publish NetUnitPrice so the composed canvas has a real, self-consistent structural
    // chain even though PricingSettings was the donor's actual original producer). Two fallbacks are tried,
    // in the SAME priority order attribute-based's own `resolvePricingFlowAncestors` already established:
    // the more precise IsContractEnabled-BINDING match first (each ListPrice's own declared value vs
    // VolumeTierDiscount's), then — only if that mechanism doesn't apply at all — the looser
    // contract-flavored-field-NAMING heuristic. Never accepts arbitrary step-name co-occurrence; a
    // "conflict" from the binding check is fatal immediately, never silently falls through.
    const dump = dumpListPriceCandidates(donorGraph);
    const bindingOutcome = resolveListPriceByContractEnabledBinding(donorGraph, vtdNode);
    if (bindingOutcome.status === "conflict") {
      fatalErrors.push(
        `Selected VolumeTierDiscount branch (occurrence ${vtdNode.occurrenceIndex}) resolves to PricingSettings (via ${psResolution.mechanism}) but its own IsContractEnabled binding conflicts with the donor's ListPrice candidates: ${bindingOutcome.reason}\n\n${formatListPriceCandidateDump(dump, null)}`,
      );
      return { success: false, fatalErrors, warnings };
    }
    if (bindingOutcome.status === "resolved") {
      lpNode = bindingOutcome.node;
      lpMechanismLabel = "contract-enabled-binding";
      warnings.push(`ListPrice paired via the donor's own explicit IsContractEnabled binding, not a direct connectivity signal: ${bindingOutcome.reason}\n\n${formatListPriceCandidateDump(dump, lpNode.occurrenceIndex)}`);
    } else {
      // bindingOutcome.status === "not-applicable" — fall through to the looser flavor-naming fallback.
      const fallback = resolveListPriceByContractFlavorFallback(donorGraph, vtdNode);
      if (!fallback.node) {
        fatalErrors.push(
          `Selected VolumeTierDiscount branch (occurrence ${vtdNode.occurrenceIndex}) resolves to PricingSettings (via ${psResolution.mechanism}) but does not resolve to any ListPrice step via any known mechanism. Neither the IsContractEnabled-binding check (${bindingOutcome.reason}) nor the last-resort contract-flavor fallback (${fallback.reason}) could disambiguate.\n\n${formatListPriceCandidateDump(dump, null)}`,
        );
        return { success: false, fatalErrors, warnings };
      }
      lpNode = fallback.node;
      lpMechanismLabel = "contract-flavor-fallback";
      warnings.push(`ListPrice paired via last-resort contract-flavor matching, not a direct connectivity signal: ${fallback.reason}\n\n${formatListPriceCandidateDump(dump, lpNode.occurrenceIndex)}`);
    }
  }

  // §Prefer a Price Book LP over a Contract Pricing one, mirroring VolumeTierDiscount's own two-block trap
  // — if the resolved LP ancestor's own lookup mentions "contract", search for a sibling ListPrice step
  // that looks like the standard price-book lookup instead.
  const lpLookupNameCheck = collectFieldMap(lpNode.full).get("LookUpName") ?? collectFieldMap(lpNode.full).get("LookUpApiName") ?? "";
  if (/contract/i.test(lpLookupNameCheck)) {
    const alt = donorGraph.find(n => n.actionType === "ListPrice" && /price.?book/i.test(collectFieldMap(n.full).get("LookUpName") ?? collectFieldMap(n.full).get("LookUpApiName") ?? ""));
    if (alt) {
      warnings.push(`The ListPrice ancestor resolved via ${lpMechanismLabel} looked contract-linked ("${lpLookupNameCheck}") — substituted a Price Book ListPrice step found elsewhere in the donor instead.`);
      lpNode = alt;
    } else {
      warnings.push(`The ListPrice ancestor resolved via ${lpMechanismLabel} looks contract-linked ("${lpLookupNameCheck}") and no alternate Price Book ListPrice step was found in the donor — proceeding with it anyway.`);
    }
  }
  const psXml = psNode.full;
  const lpXml = lpNode.full;

  /* ── Resolve the EXACT "Price Book Entries V2" Decision Table (for the ListPrice step) ──
   * §Live-org fix — deterministic resolution against MULTIPLE real identity fields (MasterLabel,
   * DeveloperName, SetupName — see decisionTableExactResolver.ts's own file header for why a
   * MasterLabel-only assumption is not safe on every org), never a fuzzy candidate-list/SourceObject-only
   * search. This org has multiple similarly-shaped Decision Tables, so only an EXACT, verified-unique match
   * against "Price Book Entries V2" is trusted. */
  const pbDtResolution = await resolvePriceBookEntriesV2DecisionTable(client);
  if (pbDtResolution.status !== "resolved") {
    fatalErrors.push(`Could not resolve the exact "${PRICE_BOOK_DECISION_TABLE_LABEL}" Decision Table on this org — ${formatExactDecisionTableFailure(pbDtResolution)}`);
    return { success: false, fatalErrors, warnings };
  }
  /* ── Resolve the EXACT "Tiered Adjustment Entries" Decision Table (for the VolumeTierDiscount step) ──
   * §Live-org fix — no fuzzy candidate list, no SourceObject-only fallback, no donor-LookUpId fallback: a
   * tier-based procedure without this exact table can never produce a discount, so discovery failure of
   * ANY kind (not-found, ambiguous, or source-object-mismatch) is fatal — never resolved by guessing. */
  const tierDtResolution = await resolveTieredAdjustmentEntriesDecisionTable(client);
  if (tierDtResolution.status !== "resolved") {
    fatalErrors.push(`Could not resolve the exact "${TIERED_ADJUSTMENT_DECISION_TABLE_LABEL}" Decision Table on this org — ${formatExactDecisionTableFailure(tierDtResolution)} A tier-based pricing procedure without this Decision Table can never produce a discount.`);
    return { success: false, fatalErrors, warnings };
  }
  // §Task 5 — the two semantic tables are resolved fully independently (two separate calls, two separate
  // exported functions — see decisionTableExactResolver.ts's own file header for why there is no shared
  // "candidate label" parameter a call site could confuse); this asserts that independence actually held:
  // the SAME physical DecisionTable record must never be used for two different semantic pricing nodes.
  if (pbDtResolution.table.id === tierDtResolution.table.id) {
    fatalErrors.push(
      `DECISION_TABLE_CROSS_MAPPING: the SAME DecisionTable (Id ${pbDtResolution.table.id}) was resolved for BOTH "${PRICE_BOOK_DECISION_TABLE_LABEL}" (ListPrice) and "${TIERED_ADJUSTMENT_DECISION_TABLE_LABEL}" (VolumeTierDiscount) — these must be two distinct records; refusing to bind two different pricing nodes to one table.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(
    "Decision Table resolution (independent, per semantic target):\n" +
    `ListPrice:\n  requested = ${PRICE_BOOK_DECISION_TABLE_LABEL}\n  resolvedId = ${pbDtResolution.table.id}\n  resolvedIdentity = MasterLabel="${pbDtResolution.table.masterLabel ?? "(none)"}" DeveloperName="${pbDtResolution.table.developerName ?? "(none)"}" SetupName="${pbDtResolution.table.setupName ?? "(none)"}" (matched via ${pbDtResolution.mechanism})\n` +
    `VolumeTierDiscount:\n  requested = ${TIERED_ADJUSTMENT_DECISION_TABLE_LABEL}\n  resolvedId = ${tierDtResolution.table.id}\n  resolvedIdentity = MasterLabel="${tierDtResolution.table.masterLabel ?? "(none)"}" DeveloperName="${tierDtResolution.table.developerName ?? "(none)"}" SetupName="${tierDtResolution.table.setupName ?? "(none)"}" (matched via ${tierDtResolution.mechanism})`,
  );
  // §Display-name fallback chain — MasterLabel is preferred (most human-readable) but is not guaranteed
  // non-null (see decisionTableExactResolver.ts): falls back to DeveloperName, then SetupName, then the
  // semantic target name itself as an absolute last resort — never null, so the patched LookUpName is
  // always a real, meaningful value and the final-XML validation below can compare against this SAME
  // computed value rather than re-deriving it (and risking a spurious null-vs-value mismatch).
  const tierResolvedName = tierDtResolution.table.masterLabel ?? tierDtResolution.table.developerName ?? tierDtResolution.table.setupName ?? TIERED_ADJUSTMENT_DECISION_TABLE_LABEL;
  const vtdLookup: DecisionTableLookup = { id: tierDtResolution.table.id, name: tierResolvedName, apiName: tierDtResolution.table.developerName ?? "" };

  const lpBindingsBefore = collectFieldMap(lpXml);
  // §Live-org fix — never falls back to the donor's OWN LookUpApiName/LookUpName as a display-value
  // substitute: the resolved table's own fields are used verbatim, even when DeveloperName is absent on
  // this org, so the deployed step's LookUp* fields can never silently carry a donor-org literal forward.
  const pbResolvedName = pbDtResolution.table.masterLabel ?? pbDtResolution.table.developerName ?? pbDtResolution.table.setupName ?? PRICE_BOOK_DECISION_TABLE_LABEL;
  const lpLookup = { lookUpId: pbDtResolution.table.id, lookUpApiName: pbDtResolution.table.developerName ?? null, lookUpName: pbResolvedName };
  warnings.push(formatDecisionTableMappingDiagnostic({
    pricingTypeLabel: "TIER — LISTPRICE", actionType: "ListPrice", table: pbDtResolution.table, mechanism: pbDtResolution.mechanism,
    before: { lookUpId: lpBindingsBefore.get("LookUpId") ?? null, lookUpApiName: lpBindingsBefore.get("LookUpApiName") ?? null, lookUpName: lpBindingsBefore.get("LookUpName") ?? null },
    after: lpLookup,
  }));

  const vtdOwnBindingsMap = collectFieldMap(vtdNode.content.indexOf("<steps") === -1 ? vtdNode.content : vtdNode.content.slice(0, vtdNode.content.indexOf("<steps")));
  const donorInputUnitPrice = vtdOwnBindingsMap.get("InputUnitPrice") ?? null;
  // §Live-org fix — searched recursively through ListPrice's WHOLE subtree (top-level params AND params
  // nested inside a <customElement>, exactly like `collectFieldMap` above and mirroring
  // lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own `getAllParameterBlocksRecursive`
  // scan for this exact purpose) — a top-level-only scan silently missed this donor's real ListPrice
  // output (it lives inside a <customElement>, the same standard Decision-Table-lookup shape every
  // LookUpId/LookUpApiName/IsContractEnabled field on this step already lives in), making
  // `donorLpOutputValues` wrongly empty and `targetInputUnitPriceValue` wrongly null even though the
  // selected ListPrice genuinely publishes a real, usable output. Also requires `type="Parameter"`
  // (excluding `Literal` outputs, which are not real bindable published variables), matching
  // attribute-based's own filter exactly.
  const lpOutputDiscovery = [
    ...getTopLevelParameterBlocks(lpXml).map(b => ({ b, scope: "top-level" as const })),
    ...getNestedCustomElementParameterBlocks(lpXml).map(b => ({ b, scope: "customElement-nested" as const })),
  ]
    .filter(({ b }) => getTagValue(b.block, "output") === "true" && getTagValue(b.block, "type") === "Parameter")
    .map(({ b, scope }) => ({ name: getParamName(b.block), value: getParamValue(b.block), scope }));
  const donorLpOutputValues = lpOutputDiscovery.map(o => o.value).filter((v): v is string => !!v);
  const lpOutputDiscoveryText = lpOutputDiscovery.length > 0
    ? lpOutputDiscovery.map(o => `${o.name ?? "(unnamed)"}=${o.value ?? "(no value)"} [${o.scope}]`).join(", ")
    : "(none discovered)";
  const targetInputUnitPriceValue = resolveTargetInputUnitPriceValue(donorInputUnitPrice, donorLpOutputValues);
  if (!targetInputUnitPriceValue) {
    fatalErrors.push(
      `Could not resolve a target InputUnitPrice value from the donor's ListPrice outputs — refusing to bind VolumeTierDiscount to an unpublished value. ` +
      `Selected ListPrice [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) publishes ${donorLpOutputValues.length} output(s) of type="Parameter": ${lpOutputDiscoveryText}. ` +
      `VolumeTierDiscount [${vtdNode.occurrenceIndex}]'s own InputUnitPrice binding is "${donorInputUnitPrice ?? "(none)"}". ` +
      (donorLpOutputValues.length === 0
        ? "No output at all was found (checked both top-level and customElement-nested parameter blocks)."
        : `${donorLpOutputValues.length} output(s) exist but none matches VolumeTierDiscount's InputUnitPrice or any known unit-price-semantic name (${UNIT_PRICE_SEMANTIC_PRIORITY.join(", ")}) — refusing to guess by array order.`),
    );
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(`Selected ListPrice [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) real output(s) discovered: ${lpOutputDiscoveryText}. Target InputUnitPrice value resolved: "${targetInputUnitPriceValue}".`);

  // §Live-org fix — mirrors lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own, already-proven
  // architecture exactly: PricingSettings and ListPrice are used 100% VERBATIM from the donor — ListPrice's
  // own output parameter is NEVER rewritten to fabricate a "NetUnitPrice" output the real donor never
  // declared (a prior version of this file did exactly that as a "waterfall bridge," which is precisely the
  // kind of invented producer-side binding the architecture must avoid — see this function's own file
  // header). Instead, VolumeTierDiscount's OWN `InputUnitPrice` binding (a step this pipeline already owns
  // and patches) is aligned below to whatever ListPrice's REAL published output actually is
  // (`targetInputUnitPriceValue`, resolved immediately above from ListPrice's own real bindings) — the same
  // direction attribute-based already aligns AttributeDiscount's InputUnitPrice. This guarantees VTD always
  // consumes a value ListPrice genuinely publishes, never a value invented to make validation pass.
  let lpPatched = stripIdsAndParentStep(lpXml);
  lpPatched = patchParamValue(lpPatched, "LookUpId", lpLookup.lookUpId ?? "");
  if (lpLookup.lookUpApiName) lpPatched = patchParamValue(lpPatched, "LookUpApiName", lpLookup.lookUpApiName);
  if (lpLookup.lookUpName) lpPatched = patchParamValue(lpPatched, "LookUpName", lpLookup.lookUpName);
  lpPatched = patchParamValue(lpPatched, "IsContractEnabled", "false");

  /* ── Patch the VolumeTierDiscount step ──
   * §Live-org fix — a prior version of this block split `vtdNode.full` at its first `<customElement>` tag
   * (`vtdOwnPart` / `vtdNestedAndClose`) and patched ONLY `vtdOwnPart`, leaving everything from the first
   * `<customElement>` onward byte-for-byte untouched. This donor declares VolumeTierDiscount's own
   * `InputUnitPrice` parameter INSIDE that `<customElement>` — the same standard Decision-Table-lookup
   * wrapper this donor already nests `LookUpId`/`LookUpApiName`/`IsContractEnabled` in (already proven for
   * ListPrice earlier in this function). `patchParamValue(vtdOwnPatched, "InputUnitPrice", ...)` therefore
   * matched nothing (a no-op `.replace()`) and the untouched nested remainder still carried the donor's
   * original `NetUnitPrice` value straight through graph construction, pruning, assembly, and reparse —
   * this was the "consumer alignment does not survive" bug, and it was a patch-SCOPE bug, not a
   * pruning/assembly bug. `patchParamValue`/`patchParamType` are already plain text-regex operations with
   * no customElement awareness of their own (unlike the structural readers like
   * `getNestedCustomElementParameterBlocks`), so there is no correctness reason to split before patching —
   * every patch below now runs over the step's WHOLE text, and nothing is reassembled afterward since
   * nothing was split out.
   *
   * §Live-org fix — uses `stripIds` (id-only), NOT `stripIdsAndParentStep`: this donor's structural report
   * proved VolumeTierDiscount requires its own `<parentStep>` tag as a direct child (see `stripIdsAndParentStep`'s
   * own doc comment above for the full reasoning) — it is preserved here verbatim, donor value and donor
   * position, never stripped, invented, or moved. None of the `patchParamValue`/`patchParamType` calls below
   * can touch it either way — they only ever match text following a specific `<name>PARAM</name>` tag, never
   * `<parentStep>`.
   */
  const vtdBindingsBefore = collectFieldMap(vtdNode.full);
  let vtdPatched = stripIds(vtdNode.full);
  vtdPatched = patchParamValue(vtdPatched, "LookUpId", vtdLookup.id);
  if (vtdLookup.apiName) vtdPatched = patchParamValue(vtdPatched, "LookUpApiName", vtdLookup.apiName);
  if (vtdLookup.name) vtdPatched = patchParamValue(vtdPatched, "LookUpName", vtdLookup.name);
  const vtdBindingsAfterLookupPatch = collectFieldMap(vtdPatched);
  warnings.push(formatDecisionTableMappingDiagnostic({
    pricingTypeLabel: "TIER", actionType: "VolumeTierDiscount", table: tierDtResolution.table, mechanism: tierDtResolution.mechanism,
    before: { lookUpId: vtdBindingsBefore.get("LookUpId") ?? null, lookUpApiName: vtdBindingsBefore.get("LookUpApiName") ?? null, lookUpName: vtdBindingsBefore.get("LookUpName") ?? null },
    after: { lookUpId: vtdBindingsAfterLookupPatch.get("LookUpId") ?? null, lookUpApiName: vtdBindingsAfterLookupPatch.get("LookUpApiName") ?? null, lookUpName: vtdBindingsAfterLookupPatch.get("LookUpName") ?? null },
  }));
  // Every deployment creates a NEW PriceAdjustmentSchedule — a donor's hardcoded schedule Constant is
  // always wrong. Force it to a Parameter bound to the runtime context variable instead.
  vtdPatched = patchParamType(vtdPatched, "PriceAdjustmentScheduleId", "Parameter");
  vtdPatched = patchParamValue(vtdPatched, "PriceAdjustmentScheduleId", "PriceAdjustmentSchedule");
  if (donorInputUnitPrice !== targetInputUnitPriceValue) {
    // §Pricing-waterfall alignment (see the file-level fix note above) — VolumeTierDiscount's own
    // InputUnitPrice binding, patched here to the exact value the (untouched, verbatim) ListPrice step
    // already publishes, never the other way around.
    warnings.push(`VolumeTierDiscount.InputUnitPrice patched from "${donorInputUnitPrice ?? "(none)"}" to "${targetInputUnitPriceValue}" to match the selected ListPrice [${lpNode.occurrenceIndex}]'s own real published output — ListPrice itself was not modified.`);
    vtdPatched = patchParamValue(vtdPatched, "InputUnitPrice", targetInputUnitPriceValue);
  }
  const vtdXml = vtdPatched;

  // §Live-org fix — authoritative assertion, immediately after patching and before this fragment is used
  // for anything else, so a future regression fails at the exact point the patch happened rather than
  // resurfacing as a confusing mismatch after graph construction/pruning/assembly/reparse.
  const vtdXmlInputUnitPrice = collectFieldMap(vtdXml).get("InputUnitPrice") ?? null;
  if (donorInputUnitPrice !== targetInputUnitPriceValue && vtdXmlInputUnitPrice !== targetInputUnitPriceValue) {
    fatalErrors.push(
      `VTD_PATCH_LOST_BEFORE_SERIALIZATION: the InputUnitPrice patch did not take effect on the selected VolumeTierDiscount fragment. ` +
      `Original InputUnitPrice: "${donorInputUnitPrice ?? "(none)"}". Target value: "${targetInputUnitPriceValue}". ` +
      `Patched fragment's InputUnitPrice reads: "${vtdXmlInputUnitPrice ?? "(none)"}". ` +
      "This means patchParamValue found no matching <name>InputUnitPrice</name> parameter to rewrite in the patched text.",
    );
    return { success: false, fatalErrors, warnings };
  }

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

  // §TBP-20260923-183424-4B03 investigation — this used to be `/<id>[\s\S]*?<\/id>/g`: unlike `stripIds`
  // above (deliberately scoped to ONLY a 15-18-char alphanumeric Salesforce record Id), this second,
  // redundant strip ran over the WHOLE assembled steps region and matched ANY `<id>...</id>` pair
  // regardless of content — so it could silently remove a non-record-Id `<id>`-tagged value that a
  // parameter (e.g. a VolumeTierDiscount field/variable reference like LowerBoundField/UpperBoundField)
  // legitimately requires, even though every step was already correctly stripped of its own stale record
  // Ids beforehand via `stripIds`/`stripIdsAndParentStep`. Narrowed to the exact same pattern so this pass
  // can only ever remove what the per-step pass already proved safe to remove — never a broader class.
  const idFreeSteps = stepsRegion.replace(/<id>[0-9A-Za-z]{15,18}<\/id>\s*/g, "");

  // §TBP-20260923-210132-FAD5 — root-cause gap found for the "U#190f.3fffffff / couldn't find a record
  // with the ID (ExpressionSetDefinitionVersion)" failure: EVERY `<id>` strip up to this point (`stripIds`,
  // `idFreeSteps`) only ever operates on the STEPS region. The ENVELOPE region (`envelopeBefore`/
  // `envelopeAfter` below — everything in `<versions>` OUTSIDE `<steps>`, where the donor's OWN
  // ExpressionSetVersion/definition-version record references legitimately live) was never touched by any
  // Id-stripping pass at all, so a donor's own internal version-identity reference — valid for the DONOR's
  // existing record, meaningless (or actively colliding) for a brand-new version being created — could
  // survive verbatim into every deployed version this pipeline ever produced. Uses the exact same narrow,
  // proven-safe pattern as `stripIds` (only a genuine 15-18-char alphanumeric Salesforce Id) — never the
  // broader pattern that caused the LowerBoundField regression — applied here for the first time to the
  // envelope region specifically.
  const envelopeBeforeIdFree = stripEnvelopeSalesforceIds(envelopeBefore);
  const envelopeAfterIdFree = stripEnvelopeSalesforceIds(envelopeAfter);

  // §TBP-20260924-064323-C4D9 — "Specify a valid data type for the LowerBoundField variable." A
  // `<variables>` element's own `<name>` (a variable declaration — the thing a step's parameter, e.g.
  // VolumeTierDiscount's LowerBoundField/UpperBoundField, can REFERENCE by name) lives in this same
  // envelope region and would otherwise be caught by the generic `<name>`/`<label>`/`<description>`
  // regeneration below, overwriting EVERY variable's own name with the SAME apiName/label — silently
  // detaching any parameter that references it BY NAME from its own declaration (the declaration survives,
  // renamed; the reference still points to the OLD name; Salesforce reports "no valid data type" because
  // the name the reference resolves to no longer declares one). Mirrors
  // lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own proven fix for this EXACT class of bug
  // (documented there against the same envelope-wide regeneration hazard) — never previously ported here.
  // Every `<variables>...</variables>` block is swapped out for an opaque, never-XML-shaped placeholder
  // token BEFORE any regeneration runs, and restored byte-for-byte afterward — this is a preservation
  // fix, never a rewrite: no variable's own name/dataType/value is ever changed by this pipeline.
  const protectedVariableBlocks = new Map<string, string>();
  const envelopeBeforeProtected = protectXmlBlocks(envelopeBeforeIdFree, "variables", protectedVariableBlocks);
  const envelopeAfterProtected = protectXmlBlocks(envelopeAfterIdFree, "variables", protectedVariableBlocks);

  /**
   * §Active ExpressionSetVersion identity collision investigation (9QMak000000t6nxGAA) — `<fullName>` is
   * the ExpressionSetVersion's OWN per-version identity and carries a numeric version suffix in real
   * Salesforce metadata (the org's own donor template, e.g. "Rev_Mgmt_Default_Pricing_Procedure2_V1",
   * demonstrates this convention directly in its own name) — unlike `<developerName>`/`<name>`/
   * `<expressionSetDefinition>`, which are the shared, version-INDEPENDENT parent identity and correctly
   * stay as the bare `apiName` across every version. This function used to regenerate `<fullName>` as the
   * bare apiName too (no suffix at all), meaning every version ever built for the same procedure carried
   * the IDENTICAL `<fullName>` — Salesforce's real per-version differentiator was never produced.
   * Downstream, `validateExpressionSetUniquenessAgainstOrg`'s collision search (which expects a
   * version-suffixed identity — see its own tests) then matched ANY existing sibling version sharing that
   * bare name, including an unrelated ACTIVE one, and reported a false "Active ExpressionSetVersion
   * identity collision" — blocking every subsequent legitimate new-version build. Mirrors
   * lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own `fullName` regeneration exactly:
   * preserves the donor's own separator style when a numeric suffix is found in the donor's OWN fullName,
   * and targets `ctx.versionNumber` (the caller's org-verified next-version resolution) rather than
   * reproducing the donor's own suffix digits. Never invents a suffix when the donor's own fullName has
   * none — matching attribute-based's behavior, never guessing a separator style that isn't evidenced.
   */
  function regenerate(envelope: string): string {
    let out = envelope;
    out = out.replace(/<label>[\s\S]*?<\/label>/, `<label>${escapeXml(ctx.procedureName)}</label>`);
    if (ctx.description) out = out.replace(/<description>[\s\S]*?<\/description>/, `<description>${escapeXml(ctx.description)}</description>`);
    // §TBP-20260923-210132-FAD5 — Part 5, single source of truth: when the caller has already resolved an
    // authoritative identity (`ctx.fullName`, from `resolveExpressionSetIdentityPlan`), it is used VERBATIM
    // — this function never independently reconstructs it from the donor's own suffix shape in that case.
    // `regenerateVersionedFullName` remains only as a fallback for a caller that hasn't resolved a plan.
    out = out.replace(/<fullName>([\s\S]*?)<\/fullName>/g, (_m, donorValue: string) => `<fullName>${escapeXml(ctx.fullName ?? regenerateVersionedFullName(donorValue, ctx.apiName, ctx.versionNumber))}</fullName>`);
    out = out.replace(/<developerName>[\s\S]*?<\/developerName>/, `<developerName>${escapeXml(ctx.apiName)}</developerName>`);
    out = out.replace(/<name>[\s\S]*?<\/name>/, `<name>${escapeXml(ctx.apiName)}</name>`);
    out = out.replace(/<expressionSetDefinition>[\s\S]*?<\/expressionSetDefinition>/, `<expressionSetDefinition>${escapeXml(ctx.apiName)}</expressionSetDefinition>`);
    return out;
  }
  let regeneratedBefore = regenerate(envelopeBeforeProtected);
  let regeneratedAfter = regenerate(envelopeAfterProtected);

  const injected = injectVersionNumberAndRank(regeneratedBefore, regeneratedAfter, { versionNumber: ctx.versionNumber, rank: ctx.rank }, Number(process.env.PRICING_RULES_DEPLOY_API_VERSION ?? 62));
  regeneratedBefore = injected.envelopeBefore;
  regeneratedAfter = injected.envelopeAfter;
  warnings.push(...injected.warnings);

  regeneratedBefore = restoreXmlBlocks(regeneratedBefore, protectedVariableBlocks);
  regeneratedAfter = restoreXmlBlocks(regeneratedAfter, protectedVariableBlocks);

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

  // §TBP-20260923-183424-4B03 — "Specify a valid data type for the LowerBoundField variable." Pre-deployment,
  // fail-closed check: see `validateFieldReferenceParamPreserved`'s own doc comment above for why
  // byte-for-byte donor preservation (never a fabricated expected datatype) is the invariant asserted here.
  const lowerBoundFieldCheck = validateFieldReferenceParamPreserved(vtdNode.full, finalVtdNode.full, "LowerBoundField", "LOWER_BOUND_FIELD_INVALID");
  const upperBoundFieldCheck = validateFieldReferenceParamPreserved(vtdNode.full, finalVtdNode.full, "UpperBoundField", "UPPER_BOUND_FIELD_INVALID");
  warnings.push(`LowerBoundField/UpperBoundField preservation diagnostic (donor vs. final composed canvas):\n${lowerBoundFieldCheck.diagnostic}\n${upperBoundFieldCheck.diagnostic}`);
  if (lowerBoundFieldCheck.fatal) fatalErrors.push(lowerBoundFieldCheck.fatal);
  if (upperBoundFieldCheck.fatal) fatalErrors.push(upperBoundFieldCheck.fatal);

  // §TBP-20260924-064323-C4D9 — "Specify a valid data type for the LowerBoundField variable," live run
  // TBP-20260924-064323-C4D9 (donor Keyboard_Tier_Based_Pricing_Procedure). Byte-for-byte parameter
  // preservation above does NOT prove the VARIABLE that parameter's value references (if any) also
  // survived under the same name with a valid data type — this traces that second link explicitly and
  // logs exactly the fragments requested, before deployment.
  const lowerBoundVariableAudit = auditFieldReferenceVariable("LowerBoundField", vtdNode.full, finalVtdNode.full, donorFileXml, assembledFileXml);
  const upperBoundVariableAudit = auditFieldReferenceVariable("UpperBoundField", vtdNode.full, finalVtdNode.full, donorFileXml, assembledFileXml);
  client.logDebug("xml-diagnostic", `LOWER_BOUND_FIELD_DONOR:\n${lowerBoundVariableAudit.donorParamFragment ?? "(not declared in donor)"}`);
  client.logDebug("xml-diagnostic", `LOWER_BOUND_FIELD_FINAL:\n${lowerBoundVariableAudit.finalParamFragment ?? "(not present in final canvas)"}`);
  client.logDebug("xml-diagnostic", `LOWER_BOUND_FIELD_REFERENCED_VARIABLE_DONOR:\n${lowerBoundVariableAudit.donorVariableFragment ?? "(no variable reference detected, or donor declares none by that name)"}`);
  client.logDebug("xml-diagnostic", `LOWER_BOUND_FIELD_REFERENCED_VARIABLE_FINAL:\n${lowerBoundVariableAudit.finalVariableFragment ?? "(not present in final canvas)"}`);
  client.logDebug("xml-diagnostic", `UPPER_BOUND_FIELD_DONOR:\n${upperBoundVariableAudit.donorParamFragment ?? "(not declared in donor)"}`);
  client.logDebug("xml-diagnostic", `UPPER_BOUND_FIELD_FINAL:\n${upperBoundVariableAudit.finalParamFragment ?? "(not present in final canvas)"}`);
  client.logDebug("xml-diagnostic", `UPPER_BOUND_FIELD_REFERENCED_VARIABLE_DONOR:\n${upperBoundVariableAudit.donorVariableFragment ?? "(no variable reference detected, or donor declares none by that name)"}`);
  client.logDebug("xml-diagnostic", `UPPER_BOUND_FIELD_REFERENCED_VARIABLE_FINAL:\n${upperBoundVariableAudit.finalVariableFragment ?? "(not present in final canvas)"}`);

  const lowerBoundVariableSemantics = validateFieldReferenceVariableSemantics(lowerBoundVariableAudit, "LOWER_BOUND_FIELD_INVALID_DATATYPE");
  const upperBoundVariableSemantics = validateFieldReferenceVariableSemantics(upperBoundVariableAudit, "UPPER_BOUND_FIELD_INVALID_DATATYPE");
  warnings.push(`LowerBoundField/UpperBoundField referenced-variable semantic diagnostic:\n${lowerBoundVariableSemantics.diagnostic}\n${upperBoundVariableSemantics.diagnostic}`);
  if (lowerBoundVariableSemantics.fatal) fatalErrors.push(lowerBoundVariableSemantics.fatal);
  if (upperBoundVariableSemantics.fatal) fatalErrors.push(upperBoundVariableSemantics.fatal);

  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  // §Live-org fix — identity-based re-verification against the FINAL, reparsed, post-prune/post-patch XML.
  // occurrenceIndex is NOT a stable identity across pruning: `pruneXmlToRequiredOccurrences`
  // (lib/pricing-rules/attribute-based/create/pricingCanvasPruning.ts) physically removes entire unrelated
  // root-branch <steps> spans from the document, and `extractStepGraph` recomputes every occurrenceIndex
  // fresh via a pre-order walk of whatever <steps> tags remain — so a step that fully survives pruning is
  // still renumbered once its preceding unrelated siblings are gone. A prior version of this check compared
  // against `lpNode.occurrenceIndex` (the PRE-prune coordinate) and reported ListPrice "missing" purely
  // because that number no longer exists in the much smaller final graph, even when ListPrice was never
  // pruned at all. The strongest identity actually available here is `actionType === "ListPrice"` itself:
  // the earlier `lpCount !== 1` gate (on `prunedGraph`, before serialization) and the
  // `finalGraph.length !== prunedGraph.length` round-trip check below already GUARANTEE the final canvas
  // contains exactly one ListPrice step, so filtering by actionType here is unambiguous BY CONSTRUCTION —
  // never "pick the first/arbitrary one." Reinforced by a LookUpId cross-check against `lpLookup.lookUpId`
  // (the value THIS build just patched in), confirming it's genuinely the patched clone, not a stray
  // leftover — mirroring Decision-table identity as the next-strongest signal per this donor's own shape.
  const finalLpCandidates = finalGraph.filter(n => n.actionType === "ListPrice");
  if (finalLpCandidates.length === 0) {
    fatalErrors.push(
      `LISTPRICE_NOT_PRESENT: final composed canvas contains no ListPrice step at all. Originally selected ListPrice: donor occurrence [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}), outputs: ${donorLpOutputValues.join(", ") || "(none)"}.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  if (finalLpCandidates.length > 1) {
    fatalErrors.push(
      `LISTPRICE_IDENTITY_MISMATCH: final composed canvas unexpectedly contains ${finalLpCandidates.length} ListPrice steps (final occurrences: ${finalLpCandidates.map(n => n.occurrenceIndex).join(", ")}) — expected exactly one; refusing to guess which is the selected one.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  const finalLpNode = finalLpCandidates[0];
  const finalLpFields = collectFieldMap(finalLpNode.full);
  // §Task 8 — deterministic Decision Table mapping must hold all the way through to the FINAL, reparsed
  // XML, not just the intermediate patched fragment. Checks LookUpId, LookUpApiName, AND LookUpName against
  // the resolved "Price Book Entries V2" table under ONE fatal code, since any of them drifting from the
  // resolved table is the SAME underlying failure: the final canvas no longer reflects the deterministic
  // ListPrice -> Price Book Entries V2 mapping (this is the exact class of bug a live run surfaced as
  // "List Price is currently mapped/displayed as 'Price Book Entries'").
  const lpMappingMismatches: string[] = [];
  if (finalLpFields.get("LookUpId") !== lpLookup.lookUpId) {
    lpMappingMismatches.push(`LookUpId ("${finalLpFields.get("LookUpId") ?? "(none)"}") does not equal the resolved table's Id ("${lpLookup.lookUpId ?? "(none)"}")`);
  }
  if (pbDtResolution.table.developerName !== null && finalLpFields.get("LookUpApiName") !== pbDtResolution.table.developerName) {
    lpMappingMismatches.push(`LookUpApiName ("${finalLpFields.get("LookUpApiName") ?? "(none)"}") does not equal the resolved table's DeveloperName ("${pbDtResolution.table.developerName}")`);
  }
  if (finalLpFields.get("LookUpName") !== lpLookup.lookUpName) {
    lpMappingMismatches.push(`LookUpName ("${finalLpFields.get("LookUpName") ?? "(none)"}") does not equal the resolved table's name ("${lpLookup.lookUpName}")`);
  }
  if (lpMappingMismatches.length > 0) {
    fatalErrors.push(`LISTPRICE_DECISION_TABLE_MAPPING_MISMATCH: final ListPrice does not reflect the resolved "${PRICE_BOOK_DECISION_TABLE_LABEL}" Decision Table (Id ${pbDtResolution.table.id}, matched via ${pbDtResolution.mechanism}): ${lpMappingMismatches.join("; ")}.`);
    return { success: false, fatalErrors, warnings };
  }
  const finalLpOutputValues = [...getTopLevelParameterBlocks(finalLpNode.full), ...getNestedCustomElementParameterBlocks(finalLpNode.full)]
    .filter(b => getTagValue(b.block, "output") === "true" && getTagValue(b.block, "type") === "Parameter")
    .map(b => getParamValue(b.block))
    .filter((v): v is string => !!v);
  if (JSON.stringify([...finalLpOutputValues].sort()) !== JSON.stringify([...donorLpOutputValues].sort())) {
    fatalErrors.push(
      `LISTPRICE_OUTPUT_CHANGED: final ListPrice [final occurrence ${finalLpNode.occurrenceIndex}, originally donor occurrence ${lpNode.occurrenceIndex}] outputs (${finalLpOutputValues.join(", ") || "(none)"}) no longer match the originally-selected donor outputs (${donorLpOutputValues.join(", ") || "(none)"}) — ListPrice must remain verbatim; something rewrote it.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  if (!finalLpOutputValues.includes(targetInputUnitPriceValue)) {
    fatalErrors.push(
      `LISTPRICE_OUTPUT_CHANGED: final ListPrice [final occurrence ${finalLpNode.occurrenceIndex}] does not actually publish the resolved target value "${targetInputUnitPriceValue}" among its final output(s) (${finalLpOutputValues.join(", ") || "(none)"}) — refusing to trust an unproven binding.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  if (finalInputUnitPrice !== targetInputUnitPriceValue) {
    fatalErrors.push(
      `VTD_INPUT_MISMATCH: final composed canvas's VolumeTierDiscount InputUnitPrice ("${finalInputUnitPrice}") does not match the expected value ("${targetInputUnitPriceValue}").`,
    );
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(
    `Final ListPrice identity verified: donor occurrence [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) -> final occurrence [${finalLpNode.occurrenceIndex}] (${finalLpNode.pathLabel})` +
    `${finalLpNode.occurrenceIndex !== lpNode.occurrenceIndex ? " — occurrence renumbered by pruning, as expected; not a failure" : ""}. ` +
    `ListPrice output(s): ${finalLpOutputValues.join(", ") || "(none)"}. VolumeTierDiscount InputUnitPrice: "${finalInputUnitPrice}". Validation: PASS.`,
  );
  // §Task 8 — the deterministic "Tiered Adjustment Entries" Decision Table mapping must hold in the FINAL,
  // reparsed XML too, not just the intermediate patched fragment. Single fatal code covering LookUpId/
  // LookUpApiName/LookUpName — any of them drifting is the SAME underlying mapping failure (this is the
  // exact class of bug a live run surfaced as "Tier Discount is currently mapped/displayed as 'Decision
  // Tables'" — the generic placeholder, not the real "Tiered Adjustment Entries" table).
  const vtdMappingMismatches: string[] = [];
  if (finalVtdFields.get("LookUpId") !== vtdLookup.id) {
    vtdMappingMismatches.push(`LookUpId ("${finalVtdFields.get("LookUpId") ?? "(none)"}") does not equal the resolved table's Id ("${vtdLookup.id}")`);
  }
  if (tierDtResolution.table.developerName !== null && finalVtdFields.get("LookUpApiName") !== tierDtResolution.table.developerName) {
    vtdMappingMismatches.push(`LookUpApiName ("${finalVtdFields.get("LookUpApiName") ?? "(none)"}") does not equal the resolved table's DeveloperName ("${tierDtResolution.table.developerName}")`);
  }
  if (finalVtdFields.get("LookUpName") !== vtdLookup.name) {
    vtdMappingMismatches.push(`LookUpName ("${finalVtdFields.get("LookUpName") ?? "(none)"}") does not equal the resolved table's name ("${vtdLookup.name}")`);
  }
  if (vtdMappingMismatches.length > 0) {
    fatalErrors.push(`VOLUME_TIER_DECISION_TABLE_MAPPING_MISMATCH: final VolumeTierDiscount does not reflect the resolved "${TIERED_ADJUSTMENT_DECISION_TABLE_LABEL}" Decision Table (Id ${vtdLookup.id}, matched via ${tierDtResolution.mechanism}): ${vtdMappingMismatches.join("; ")}.`);
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
  // §Active ExpressionSetVersion identity collision investigation — `fullName`'s value is read back from
  // the ACTUAL regenerated (version-suffixed) envelope text, never re-guessed as the bare `ctx.apiName`:
  // this is what `createPipeline.ts` feeds into `validateExpressionSetUniquenessAgainstOrg`'s collision
  // search, so it must reflect the real, per-version identity that will actually be deployed.
  const generatedIdentifiers: { tag: string; value: string }[] = [
    { tag: "fullName", value: outboundFullNameMatch ? outboundFullNameMatch[1] : ctx.apiName }, { tag: "label", value: ctx.procedureName },
    { tag: "developerName", value: ctx.apiName }, { tag: "name", value: ctx.apiName },
    { tag: "expressionSetDefinition", value: ctx.apiName },
  ];

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
