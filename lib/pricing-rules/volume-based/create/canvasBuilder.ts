/**
 * Volume-Based Pricing Expression Set XML builder — mirrors
 * lib/pricing-rules/bundle-based/create/canvasBuilder.ts's clone-and-patch architecture: `VolumeDiscount`
 * is a real, org-configured Business Knowledge Model action type that cannot be hand-authored from a blank
 * canvas, so this NEVER builds XML from scratch. It clones the donor's SCHEDULE-BASED VolumeDiscount
 * branch (donorInspection.ts already excludes the contract-based block — see its file header for the
 * two-block trap), the donor's Price Book ListPrice branch, and PricingSettings, strips every donor-specific
 * literal, forces `PriceAdjustmentScheduleId` to a fresh runtime binding (this pipeline creates a NEW
 * PriceAdjustmentSchedule on every deploy — a donor's own hardcoded schedule Id/Constant would always be
 * wrong), rebinds the LookUp* params to a freshly-SOQL-resolved Decision Table, and re-validates the
 * assembled result before returning it.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import {
  extractStepGraph, getTagValue, escapeXml,
  getTopLevelParameterBlocks, getNestedCustomElementParameterBlocks,
  getParamName, getParamValue, type PhysicalStepNode,
} from "@/lib/pricing-rules/attribute-based/create/xmlBlocks";
import { computeRequiredOccurrenceIndexes, pruneXmlToRequiredOccurrences, findDanglingParentStepReferences } from "@/lib/pricing-rules/attribute-based/create/pricingCanvasPruning";
import { compareExpressionSetSchema, compareStepStructure, type StepStructureReport } from "@/lib/pricing-rules/attribute-based/create/schemaDiff";
import {
  injectVersionNumberAndRank, regenerateVersionedFullName, stripEnvelopeSalesforceIds,
  protectXmlBlocks, restoreXmlBlocks,
} from "@/lib/pricing-rules/attribute-based/create/versionEnvelopeFields";
import {
  resolvePriceBookEntriesV2DecisionTable, resolveVolumeDiscountEntriesDecisionTable,
  formatExactDecisionTableFailure, formatDecisionTableMappingDiagnostic,
  PRICE_BOOK_DECISION_TABLE_LABEL, VOLUME_DISCOUNT_DECISION_TABLE_LABEL,
} from "@/lib/pricing-rules/attribute-based/create/decisionTableExactResolver";
import { resolveVolumeBasedPricingDonor, resolveConnectedAncestor, SHARED_SIGNAL_ACTION_TYPES, buildNoCoherentDonorDiagnostic } from "./donorInspection";

const UNIT_PRICE_SEMANTIC_PRIORITY = ["UnitPrice", "NetUnitPrice", "ListPrice"];

export interface DecisionTableLookup { id: string; name: string; apiName: string; }

function collectFieldMap(xmlSlice: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of [...getTopLevelParameterBlocks(xmlSlice), ...getNestedCustomElementParameterBlocks(xmlSlice)]) {
    const n = getParamName(b.block);
    if (n) map.set(n, getParamValue(b.block));
  }
  return map;
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
 * VolumeDiscount fragment (see `stripIdsAndParentStep`'s own doc comment for why). */
function stripIds(stepFullXml: string): string {
  return stepFullXml.replace(/<id>[0-9A-Za-z]{15,18}<\/id>\s*/g, "");
}

/**
 * §Live-org fix — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own
 * `stripIdsAndParentStep` doc comment exactly: `<parentStep>` removal is a PRUNING-INPUT concern (avoid the
 * composed root-level PS/LP/VD steps carrying a canvas-placement reference into a UI-grouping container
 * that isn't one of the 3 required steps), completely separate from `compareStepStructure`'s SCHEMA-
 * COMPLETENESS check: that check only compares direct-child TAG NAMES/order against the donor's own step —
 * a VolumeDiscount step that declares a real, non-empty `<parentStep>` as one of its required direct
 * children (the same donor family already proven, in Tier-Based, to require this for its
 * VolumeTierDiscount sibling) would fail that comparison whenever the tag itself is missing. Kept for
 * PricingSettings/ListPrice (`psXml`/`lpXml` below) — evidenced, not assumed: their own structural reports
 * pass even with this stripping. VolumeDiscount uses `stripIds` alone below, preserving its own
 * `<parentStep>` (donor value, donor position) verbatim so `compareStepStructure` sees the same direct-
 * child shape the donor has — never blindly assumed either way; the structural report
 * (`compareStepStructure`) is the actual authority that would reject this choice if it were wrong.
 */
function stripIdsAndParentStep(stepFullXml: string): string {
  return stripIds(stepFullXml.replace(/<parentStep>[^<]*<\/parentStep>\s*/g, ""));
}

function renumberSequence(stepFullXml: string, seq: number): string {
  return stepFullXml.replace(/<sequenceNumber>\d+<\/sequenceNumber>/, `<sequenceNumber>${seq}</sequenceNumber>`);
}

/**
 * §Live-org fix (real donor `Rev_Mgmt_Default_Pricing_Procedure2_V1`) — LAST-RESORT ListPrice pairing, used
 * only when `resolveConnectedAncestor` finds no direct mechanism (parentStep chain, physical nesting,
 * variable binding, or sequence order) connecting the selected VolumeDiscount branch to a specific ListPrice
 * occurrence — the same real, confirmed live shape already fixed for Attribute-Based Pricing
 * (donorInspection.ts's own `price-waterfall-variable` mechanism proves VolumeDiscount participates in the
 * SAME pricing flow as PricingSettings via the shared NetUnitPrice variable, but that says nothing about
 * WHICH of the donor's ListPrice branches — Price Book vs Contract Pricing — is the correct one). Mirrors
 * lib/pricing-rules/attribute-based/create/canvasBuilder.ts's own `resolveListPriceByContractEnabledBinding`
 * exactly (same discriminated outcome, same "conflict never falls through to a guess" discipline), adapted
 * to VolumeDiscount's own field naming in diagnostics.
 */
export type ContractEnabledBindingOutcome =
  | { status: "resolved"; node: PhysicalStepNode; reason: string }
  | { status: "not-applicable"; reason: string }
  | { status: "conflict"; reason: string };

export function resolveListPriceByContractEnabledBinding(graph: PhysicalStepNode[], vdNode: PhysicalStepNode): ContractEnabledBindingOutcome {
  const vdRaw = collectFieldMap(vdNode.full).get("IsContractEnabled") ?? null;
  if (vdRaw === null) {
    return { status: "not-applicable", reason: `VolumeDiscount [${vdNode.occurrenceIndex}] declares no IsContractEnabled parameter — this mechanism does not apply.` };
  }
  const vdNorm = vdRaw.trim().toLowerCase();
  if (vdNorm !== "true" && vdNorm !== "false") {
    return { status: "conflict", reason: `VolumeDiscount [${vdNode.occurrenceIndex}]'s IsContractEnabled value ("${vdRaw}") is not a literal true/false — refusing to guess.` };
  }
  const vdBool = vdNorm === "true";

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

  const matches = withValues.filter(v => (v.raw!.trim().toLowerCase() === "true") === vdBool);
  if (matches.length === 0) {
    return {
      status: "conflict",
      reason: `0 of ${listPriceNodes.length} ListPrice occurrence(s) declare IsContractEnabled=${vdBool} (all declare the opposite) — refusing to guess.`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "conflict",
      reason: `ambiguous: ${matches.length} ListPrice occurrences share IsContractEnabled=${vdBool} ([${matches.map(m => m.lp.occurrenceIndex).join(", ")}]) — refusing to guess which one.`,
    };
  }
  const winner = matches[0];
  return {
    status: "resolved",
    node: winner.lp,
    reason: `Matched ListPrice [${winner.lp.occurrenceIndex}] via the donor's own explicit IsContractEnabled=${vdBool} binding — a direct parameter declared on both VolumeDiscount [${vdNode.occurrenceIndex}] and this ListPrice occurrence, unambiguous among ${listPriceNodes.length} candidate(s).`,
  };
}

/**
 * §Live-org fix — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own
 * `resolveTargetInputUnitPriceValue` exactly. Resolution order:
 *   1. Exactly one output published → use it (unambiguous by definition).
 *   2. The donor's OWN existing InputUnitPrice binding already equals one of the real published outputs
 *      → keep it, no guess needed.
 *   3. Otherwise, the FIRST name from `UNIT_PRICE_SEMANTIC_PRIORITY` that IS one of the published outputs.
 *   4. None of the above resolves (2+ outputs, none matching) → `null` — the caller must treat this as a
 *      hard failure, never a guess. A prior version of this function fell back to `donorLpOutputValues[0]`
 *      here — an array-order assumption Tier-Based's own proven copy never makes; removed.
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
  volumeDiscountInputBinding?: { listPriceOutputValues: string[]; inputUnitPriceValue: string | null; originalInputUnitPriceValue: string | null; wasPatched: boolean; valid: boolean };
  generatedIdentifiers?: { tag: string; value: string }[];
  canvasComposition?: { donorFullName: string; donorFileName: string; donorPhysicalStepCount: number; prunedRootBranchCount: number; finalPhysicalStepCount: number };
}

export async function buildVolumeCanvas(
  client: SalesforceClient,
  ctx: {
    procedureName: string; apiName: string; description?: string; versionNumber?: number; rank?: number | null;
    /** §TBP-20260923-210132-FAD5 — the AUTHORITATIVE, already-resolved ExpressionSetVersion identity,
     * computed ONCE by `resolveExpressionSetIdentityPlan` (orgUniquenessValidation.ts) before this function
     * runs. When provided, `<fullName>` is set to this value VERBATIM — never independently reconstructed
     * from the donor's own suffix shape. Omitted only by a caller that hasn't resolved a plan. */
    fullName?: string;
    onProgress?: (phase: "template-retrieved") => void;
  },
): Promise<CanvasBuildResult> {
  const fatalErrors: string[] = [];
  const warnings: string[] = [];

  const donorResolution = await resolveVolumeBasedPricingDonor(client);
  if (!donorResolution.selection) {
    fatalErrors.push(
      "No valid Volume-Based Pricing Expression Set donor was found in this org.\n\n" +
      buildNoCoherentDonorDiagnostic(donorResolution.candidatesWithVolumeDiscount) +
      (donorResolution.lowConfidenceCandidates
        ? `\n\nNote: some candidates DID prove a schedule-based VolumeDiscount->ListPrice connection but scored below the trust floor:\n${donorResolution.lowConfidenceCandidates.map((r, i) => `${i + 1}. ${r.fullName} — score ${r.score} — ${r.reason}`).join("\n")}`
        : ""),
    );
    return { success: false, fatalErrors, warnings };
  }
  ctx.onProgress?.("template-retrieved");
  const { fullXml: donorFileXml, fileName: donorFileName, candidate: donorCandidate, connectedScheduleBasedOccurrenceIndexes } = donorResolution.selection;

  const donorGraph = extractStepGraph(donorFileXml);
  if (connectedScheduleBasedOccurrenceIndexes.length === 0) {
    fatalErrors.push("No schedule-based VolumeDiscount branch was connected to ListPrice after donor resolution — refusing to guess.");
    return { success: false, fatalErrors, warnings };
  }
  // Prefer, among the eligible schedule-based branches, the one with IsContractEnabled explicitly "false".
  const vdCandidates = donorGraph.filter(n => connectedScheduleBasedOccurrenceIndexes.includes(n.occurrenceIndex));
  const vdNode = vdCandidates.find(n => collectFieldMap(n.full).get("IsContractEnabled") === "false") ?? vdCandidates[0];

  const psResolution = resolveConnectedAncestor(donorGraph, vdNode, "PricingSettings");
  const lpResolution = resolveConnectedAncestor(donorGraph, vdNode, "ListPrice");

  // §Live-org fix — `lpResolution` can legitimately come back `none` even for a donor
  // `resolveVolumeBasedPricingDonor` already accepted: donor eligibility now also accepts a VolumeDiscount
  // branch proven connected to PricingSettings via the shared price-waterfall variable (NetUnitPrice)
  // WITHOUT any ListPrice branch directly publishing that same value (see donorInspection.ts's own
  // `price-waterfall-variable` mechanism doc comment) — real for `Rev_Mgmt_Default_Pricing_Procedure2_V1`,
  // whose two ListPrice branches publish the Price Book / Contract Pricing outputs, never NetUnitPrice
  // directly. In that case, WHICH ListPrice branch to clone is a separate question the price-waterfall
  // proof does not answer — fall back to the donor's own explicit IsContractEnabled binding (the same
  // highest-confidence, evidence-based mechanism lib/pricing-rules/attribute-based's canvasBuilder.ts uses
  // for the identical real donor), never a guess.
  let lpNode: PhysicalStepNode | null = lpResolution.node;
  let lpMechanismLabel: string = lpResolution.mechanism;
  if (!lpNode) {
    const contractEnabledOutcome = resolveListPriceByContractEnabledBinding(donorGraph, vdNode);
    if (contractEnabledOutcome.status !== "resolved") {
      fatalErrors.push(
        `Selected VolumeDiscount branch (occurrence ${vdNode.occurrenceIndex}) does not resolve to a ListPrice ancestor via any known mechanism` +
        (psResolution.node ? ` (PricingSettings resolved via ${psResolution.mechanism}).` : ", nor to a PricingSettings ancestor.") +
        ` The IsContractEnabled-based fallback also could not disambiguate: ${contractEnabledOutcome.reason}`,
      );
      return { success: false, fatalErrors, warnings };
    }
    lpNode = contractEnabledOutcome.node;
    lpMechanismLabel = "explicit-contract-enabled-binding";
    warnings.push(`ℹ ListPrice paired via the donor's explicit IsContractEnabled binding — no direct parentStep/physical-nesting/variable-binding/sequence-order connection existed: ${contractEnabledOutcome.reason}`);
  }
  if (!psResolution.node) {
    fatalErrors.push(`Selected VolumeDiscount branch (occurrence ${vdNode.occurrenceIndex}) resolves to ListPrice (via ${lpMechanismLabel}) but does not resolve to a PricingSettings ancestor via any known mechanism.`);
    return { success: false, fatalErrors, warnings };
  }
  const psNode = psResolution.node;

  // §Prefer a Price Book LP over a Contract Pricing one, mirroring VolumeDiscount's own two-block trap —
  // if the resolved LP ancestor's own lookup mentions "contract", search for a sibling ListPrice step that
  // looks like the standard price-book lookup instead.
  const lpLookupNameCheck = collectFieldMap(lpNode.full).get("LookUpName") ?? collectFieldMap(lpNode.full).get("LookUpApiName") ?? "";
  if (/contract/i.test(lpLookupNameCheck)) {
    const alt = donorGraph.find(n => n.actionType === "ListPrice" && /price.?book/i.test(collectFieldMap(n.full).get("LookUpName") ?? collectFieldMap(n.full).get("LookUpApiName") ?? ""));
    if (alt) {
      warnings.push(`The ListPrice ancestor resolved via ${lpResolution.mechanism} looked contract-linked ("${lpLookupNameCheck}") — substituted a Price Book ListPrice step found elsewhere in the donor instead.`);
      lpNode = alt;
    } else {
      warnings.push(`The ListPrice ancestor resolved via ${lpResolution.mechanism} looks contract-linked ("${lpLookupNameCheck}") and no alternate Price Book ListPrice step was found in the donor — proceeding with it anyway.`);
    }
  }
  const psXml = psNode.full;
  const lpXml = lpNode.full;

  /* ── Resolve the EXACT "Price Book Entries V2" Decision Table (for the ListPrice step) ──
   * §Live-org fix — deterministic resolution against MULTIPLE real identity fields (MasterLabel,
   * DeveloperName, SetupName — see decisionTableExactResolver.ts's own file header for why a
   * MasterLabel-only assumption is not safe on every org), never a fuzzy candidate-list/SourceObject-only
   * search. This org has multiple similarly-shaped Decision Tables, so only an EXACT, verified-unique match
   * against "Price Book Entries V2" is trusted. Never falls back to "Price Book Entries" (without "V2") or
   * any other candidate. */
  const pbDtResolution = await resolvePriceBookEntriesV2DecisionTable(client);
  if (pbDtResolution.status !== "resolved") {
    fatalErrors.push(`Could not resolve the exact "${PRICE_BOOK_DECISION_TABLE_LABEL}" Decision Table on this org — ${formatExactDecisionTableFailure(pbDtResolution)}`);
    return { success: false, fatalErrors, warnings };
  }
  /* ── Resolve the EXACT "Volume Discount Entries" Decision Table (for the VolumeDiscount step) ──
   * §Live-org fix — the donor's own LookUpId is NEVER used as a fallback target: the donor supplies XML
   * STRUCTURE only (see this module's own file header) — the Decision Table IDENTITY must always come
   * from a fresh org lookup, never from a possibly stale/wrong-org donor literal. A prior version of this
   * code fell back to the donor's own (non-`$DUMMY$`) LookUpId when discovery failed — removed entirely;
   * discovery failure is now always fatal. */
  const vtdResolution = await resolveVolumeDiscountEntriesDecisionTable(client);
  if (vtdResolution.status !== "resolved") {
    fatalErrors.push(`Could not resolve the exact "${VOLUME_DISCOUNT_DECISION_TABLE_LABEL}" Decision Table on this org — ${formatExactDecisionTableFailure(vtdResolution)}`);
    return { success: false, fatalErrors, warnings };
  }
  // §Task 5 — the two semantic tables are resolved fully independently (two separate calls, two separate
  // exported functions — see decisionTableExactResolver.ts's own file header for why there is no shared
  // "candidate label" parameter a call site could confuse); this asserts that independence actually held:
  // the SAME physical DecisionTable record must never be used for two different semantic pricing nodes.
  if (pbDtResolution.table.id === vtdResolution.table.id) {
    fatalErrors.push(
      `DECISION_TABLE_CROSS_MAPPING: the SAME DecisionTable (Id ${pbDtResolution.table.id}) was resolved for BOTH "${PRICE_BOOK_DECISION_TABLE_LABEL}" (ListPrice) and "${VOLUME_DISCOUNT_DECISION_TABLE_LABEL}" (VolumeDiscount) — these must be two distinct records; refusing to bind two different pricing nodes to one table.`,
    );
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(
    "Decision Table resolution (independent, per semantic target):\n" +
    `ListPrice:\n  requested = ${PRICE_BOOK_DECISION_TABLE_LABEL}\n  resolvedId = ${pbDtResolution.table.id}\n  resolvedIdentity = MasterLabel="${pbDtResolution.table.masterLabel ?? "(none)"}" DeveloperName="${pbDtResolution.table.developerName ?? "(none)"}" SetupName="${pbDtResolution.table.setupName ?? "(none)"}" (matched via ${pbDtResolution.mechanism})\n` +
    `VolumeDiscount:\n  requested = ${VOLUME_DISCOUNT_DECISION_TABLE_LABEL}\n  resolvedId = ${vtdResolution.table.id}\n  resolvedIdentity = MasterLabel="${vtdResolution.table.masterLabel ?? "(none)"}" DeveloperName="${vtdResolution.table.developerName ?? "(none)"}" SetupName="${vtdResolution.table.setupName ?? "(none)"}" (matched via ${vtdResolution.mechanism})`,
  );
  // §Display-name fallback chain — MasterLabel is preferred (most human-readable) but is not guaranteed
  // non-null (see decisionTableExactResolver.ts): falls back to DeveloperName, then SetupName, then the
  // semantic target name itself as an absolute last resort — never null, so the patched LookUpName is
  // always a real, meaningful value and the final-XML validation below can compare against this SAME
  // computed value rather than re-deriving it (and risking a spurious null-vs-value mismatch).
  const vtdResolvedName = vtdResolution.table.masterLabel ?? vtdResolution.table.developerName ?? vtdResolution.table.setupName ?? VOLUME_DISCOUNT_DECISION_TABLE_LABEL;
  const vtdLookup: DecisionTableLookup = { id: vtdResolution.table.id, name: vtdResolvedName, apiName: vtdResolution.table.developerName ?? "" };

  const lpBindingsBefore = collectFieldMap(lpXml);
  // §Live-org fix — never falls back to the donor's OWN LookUpApiName/LookUpName as a display-value
  // substitute (a prior version did `pbDt.apiName || lpBindings.get("LookUpApiName")`): the resolved
  // table's own fields are used verbatim, even when DeveloperName is absent on this org, so the deployed
  // step's LookUp* fields can never silently carry a donor-org literal forward.
  const pbResolvedName = pbDtResolution.table.masterLabel ?? pbDtResolution.table.developerName ?? pbDtResolution.table.setupName ?? PRICE_BOOK_DECISION_TABLE_LABEL;
  const lpLookup = { lookUpId: pbDtResolution.table.id, lookUpApiName: pbDtResolution.table.developerName ?? null, lookUpName: pbResolvedName };
  warnings.push(formatDecisionTableMappingDiagnostic({
    pricingTypeLabel: "VOLUME — LISTPRICE", actionType: "ListPrice", table: pbDtResolution.table, mechanism: pbDtResolution.mechanism,
    before: { lookUpId: lpBindingsBefore.get("LookUpId") ?? null, lookUpApiName: lpBindingsBefore.get("LookUpApiName") ?? null, lookUpName: lpBindingsBefore.get("LookUpName") ?? null },
    after: lpLookup,
  }));

  const vdOwnBindingsMap = collectFieldMap(vdNode.content.indexOf("<steps") === -1 ? vdNode.content : vdNode.content.slice(0, vdNode.content.indexOf("<steps")));
  const donorInputUnitPrice = vdOwnBindingsMap.get("InputUnitPrice") ?? null;
  // §Live-org fix — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own proven fix for this
  // EXACT donor (Rev_Mgmt_Default_Pricing_Procedure2_V1): searched recursively through ListPrice's WHOLE
  // subtree (top-level params AND params nested inside a <customElement>, exactly like `collectFieldMap`
  // above) — a top-level-only scan silently missed this donor's real ListPrice output (it lives inside a
  // <customElement>, the same standard Decision-Table-lookup shape every LookUpId/LookUpApiName/
  // IsContractEnabled field on this step already lives in), making `donorLpOutputValues` wrongly empty and
  // `targetInputUnitPriceValue` wrongly null even though the selected ListPrice genuinely publishes a real,
  // usable output. Also requires `type="Parameter"` (excluding `Literal` outputs, which are not real
  // bindable published variables).
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
      `Could not resolve a target InputUnitPrice value from the donor's ListPrice outputs — refusing to bind VolumeDiscount to an unpublished value. ` +
      `Selected ListPrice [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) publishes ${donorLpOutputValues.length} output(s) of type="Parameter": ${lpOutputDiscoveryText}. ` +
      `VolumeDiscount [${vdNode.occurrenceIndex}]'s own InputUnitPrice binding is "${donorInputUnitPrice ?? "(none)"}". ` +
      (donorLpOutputValues.length === 0
        ? "No output at all was found (checked both top-level and customElement-nested parameter blocks)."
        : `${donorLpOutputValues.length} output(s) exist but none matches VolumeDiscount's InputUnitPrice or any known unit-price-semantic name (${UNIT_PRICE_SEMANTIC_PRIORITY.join(", ")}) — refusing to guess by array order.`),
    );
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(`Selected ListPrice [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) real output(s) discovered: ${lpOutputDiscoveryText}. Target InputUnitPrice value resolved: "${targetInputUnitPriceValue}".`);

  // §Live-org fix — mirrors lib/pricing-rules/tier-based & attribute-based's own, already-proven
  // architecture exactly: PricingSettings and ListPrice are used 100% VERBATIM from the donor — ListPrice's
  // own output parameter is NEVER rewritten to fabricate a "NetUnitPrice" output the real donor never
  // declared (a prior version of this file did exactly that as a "waterfall bridge," which is precisely the
  // kind of invented producer-side binding the architecture must avoid). Instead, VolumeDiscount's OWN
  // `InputUnitPrice` binding (a step this pipeline already owns and patches) is aligned below to whatever
  // ListPrice's REAL published output actually is (`targetInputUnitPriceValue`, resolved immediately above
  // from ListPrice's own real bindings). This guarantees VolumeDiscount always consumes a value ListPrice
  // genuinely publishes, never a value invented to make validation pass.
  let lpPatched = stripIdsAndParentStep(lpXml);
  lpPatched = patchParamValue(lpPatched, "LookUpId", lpLookup.lookUpId ?? "");
  if (lpLookup.lookUpApiName) lpPatched = patchParamValue(lpPatched, "LookUpApiName", lpLookup.lookUpApiName);
  if (lpLookup.lookUpName) lpPatched = patchParamValue(lpPatched, "LookUpName", lpLookup.lookUpName);
  lpPatched = patchParamValue(lpPatched, "IsContractEnabled", "false");

  /* ── Patch the VolumeDiscount step ──
   * §Live-org fix — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own proven fix exactly: a
   * prior version of this block split `vdNode.full` at its first `<customElement>` tag (`vdOwnPart` /
   * `vdNestedAndClose`) and patched ONLY `vdOwnPart`, leaving everything from the first `<customElement>`
   * onward byte-for-byte untouched. If this donor declares VolumeDiscount's own `LookUpId`/
   * `PriceAdjustmentScheduleId`/`InputUnitPrice` parameters INSIDE that `<customElement>` (the same standard
   * Decision-Table-lookup wrapper already proven for ListPrice above, and for VolumeTierDiscount in the
   * sibling Tier-Based module against this SAME donor), every `patchParamValue`/`patchParamType` call below
   * would silently match nothing (a no-op `.replace()`) and the untouched nested remainder would carry the
   * donor's original values straight through graph construction, pruning, assembly, and reparse.
   * `patchParamValue`/`patchParamType` are already plain text-regex operations with no customElement
   * awareness of their own, so there is no correctness reason to split before patching — every patch below
   * now runs over the step's WHOLE text, and nothing is reassembled afterward since nothing was split out.
   *
   * §Live-org fix — uses `stripIds` (id-only), NOT `stripIdsAndParentStep`: mirrors Tier-Based's own
   * precedent for the twin action type in this SAME donor family — VolumeDiscount's own `<parentStep>` is
   * preserved here verbatim, donor value and donor position, never stripped, invented, or moved (see
   * `stripIdsAndParentStep`'s own doc comment above). None of the `patchParamValue`/`patchParamType` calls
   * below can touch it either way — they only ever match text following a specific `<name>PARAM</name>`
   * tag, never `<parentStep>`.
   */
  const inputUnitPriceNameIdx = vdNode.full.indexOf("<name>InputUnitPrice</name>");
  const customElementIdx = vdNode.full.indexOf("<customElement");
  const donorInputUnitPriceScope = inputUnitPriceNameIdx === -1
    ? "(not found)"
    : (customElementIdx !== -1 && inputUnitPriceNameIdx > customElementIdx ? "customElement-nested" : "top-level");

  const vdBindingsBefore = collectFieldMap(vdNode.full);
  let vdPatched = stripIds(vdNode.full);
  vdPatched = patchParamValue(vdPatched, "LookUpId", vtdLookup.id);
  if (vtdLookup.apiName) vdPatched = patchParamValue(vdPatched, "LookUpApiName", vtdLookup.apiName);
  if (vtdLookup.name) vdPatched = patchParamValue(vdPatched, "LookUpName", vtdLookup.name);
  const vdBindingsAfterLookupPatch = collectFieldMap(vdPatched);
  warnings.push(formatDecisionTableMappingDiagnostic({
    pricingTypeLabel: "VOLUME", actionType: "VolumeDiscount", table: vtdResolution.table, mechanism: vtdResolution.mechanism,
    before: { lookUpId: vdBindingsBefore.get("LookUpId") ?? null, lookUpApiName: vdBindingsBefore.get("LookUpApiName") ?? null, lookUpName: vdBindingsBefore.get("LookUpName") ?? null },
    after: { lookUpId: vdBindingsAfterLookupPatch.get("LookUpId") ?? null, lookUpApiName: vdBindingsAfterLookupPatch.get("LookUpApiName") ?? null, lookUpName: vdBindingsAfterLookupPatch.get("LookUpName") ?? null },
  }));
  // Every deployment creates a NEW PriceAdjustmentSchedule — a donor's hardcoded schedule Constant is
  // always wrong. Force it to a Parameter bound to the runtime context variable instead.
  vdPatched = patchParamType(vdPatched, "PriceAdjustmentScheduleId", "Parameter");
  vdPatched = patchParamValue(vdPatched, "PriceAdjustmentScheduleId", "PriceAdjustmentSchedule");
  if (donorInputUnitPrice !== targetInputUnitPriceValue) {
    // §Pricing-waterfall alignment (see the file-level fix note above) — VolumeDiscount's own InputUnitPrice
    // binding, patched here to the exact value the (untouched, verbatim) ListPrice step already publishes,
    // never the other way around.
    warnings.push(`VolumeDiscount.InputUnitPrice patched from "${donorInputUnitPrice ?? "(none)"}" (${donorInputUnitPriceScope}) to "${targetInputUnitPriceValue}" to match the selected ListPrice [${lpNode.occurrenceIndex}]'s own real published output — ListPrice itself was not modified.`);
    vdPatched = patchParamValue(vdPatched, "InputUnitPrice", targetInputUnitPriceValue);
  }
  const vdXml = vdPatched;

  // §Live-org fix — authoritative assertion, immediately after patching and before this fragment is used
  // for anything else, so a future regression fails at the exact point the patch happened rather than
  // resurfacing as a confusing mismatch after graph construction/pruning/assembly/reparse.
  const vdXmlInputUnitPrice = collectFieldMap(vdXml).get("InputUnitPrice") ?? null;
  if (donorInputUnitPrice !== targetInputUnitPriceValue && vdXmlInputUnitPrice !== targetInputUnitPriceValue) {
    fatalErrors.push(
      `VOLUME_DISCOUNT_PATCH_LOST_BEFORE_SERIALIZATION: the InputUnitPrice patch did not take effect on the selected VolumeDiscount fragment. ` +
      `Original InputUnitPrice: "${donorInputUnitPrice ?? "(none)"}" (${donorInputUnitPriceScope}). Target value: "${targetInputUnitPriceValue}". ` +
      `Patched fragment's InputUnitPrice reads: "${vdXmlInputUnitPrice ?? "(none)"}". Selected VolumeDiscount occurrence: ${vdNode.occurrenceIndex}. ` +
      "This means patchParamValue found no matching <name>InputUnitPrice</name> parameter to rewrite in the patched text.",
    );
    return { success: false, fatalErrors, warnings };
  }

  const requiredInputs = ["PriceAdjustmentScheduleId"];
  const vdFieldMap = collectFieldMap(vdXml);
  const missingInputs = requiredInputs.filter(name => !vdFieldMap.has(name));
  if (missingInputs.length > 0) {
    fatalErrors.push(`Generated VolumeDiscount step is missing required binding(s): ${missingInputs.join(", ")}.`);
    return { success: false, fatalErrors, warnings };
  }
  if (vdFieldMap.get("LookUpId") === "$DUMMY$" || vdFieldMap.get("LookUpId") === "") {
    fatalErrors.push("Generated VolumeDiscount step's LookUpId is a placeholder or empty — refusing to deploy.");
    return { success: false, fatalErrors, warnings };
  }

  const psReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === psNode.occurrenceIndex) ?? null, stripIdsAndParentStep(psXml), "PricingSettings");
  const lpReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === lpNode.occurrenceIndex) ?? null, lpPatched, "ListPrice");
  const vdReport = compareStepStructure(donorGraph.find(n => n.occurrenceIndex === vdNode.occurrenceIndex) ?? null, vdXml, "VolumeDiscount");
  for (const r of [psReport, lpReport, vdReport]) if (!r.structurallyValid) fatalErrors.push(`Step structure validation failed for ${r.actionType}:\n${r.reportText}`);
  if (fatalErrors.length > 0) return { success: false, fatalErrors, warnings };

  const psPatchedFull = renumberSequence(stripIdsAndParentStep(psXml), 1);
  const lpPatchedFull = renumberSequence(lpPatched, 2);
  const vdPatchedFull = renumberSequence(vdXml, 3);

  // Splice the patched steps back into the donor bytes at their exact original spans — content-only
  // replacement, never adding/removing a <steps> tag, so occurrence indices stay stable for pruning.
  const spans = [
    { node: psNode, patched: psPatchedFull },
    { node: lpNode, patched: lpPatchedFull },
    { node: vdNode, patched: vdPatchedFull },
  ].sort((a, b) => b.node.start - a.node.start);
  let patchedDonorFileXml = donorFileXml;
  for (const { node, patched } of spans) {
    patchedDonorFileXml = patchedDonorFileXml.slice(0, node.start) + patched + patchedDonorFileXml.slice(node.end);
  }
  const patchedDonorGraph = extractStepGraph(patchedDonorFileXml);
  const patchedVdNode = patchedDonorGraph.find(n => n.occurrenceIndex === vdNode.occurrenceIndex)!;

  const requiredComputation = computeRequiredOccurrenceIndexes(patchedDonorGraph, patchedVdNode.occurrenceIndex, [psNode.occurrenceIndex, lpNode.occurrenceIndex]);
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
    fatalErrors.push(`Pruned canvas still contains unrelated pricing-type branch(es): ${survivingUnrelated.join(", ")} — pruning did not fully isolate the Volume-Based Pricing branch.`);
    return { success: false, fatalErrors, warnings };
  }
  const psCount = prunedGraph.filter(n => n.actionType === "PricingSettings").length;
  const lpCount = prunedGraph.filter(n => n.actionType === "ListPrice").length;
  const vdCount = prunedGraph.filter(n => n.actionType === "VolumeDiscount").length;
  if (psCount !== 1 || lpCount !== 1 || vdCount !== 1) {
    fatalErrors.push(`Pruned canvas does not have exactly one each of PricingSettings/ListPrice/VolumeDiscount (got ${psCount}/${lpCount}/${vdCount}).`);
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

  const idFreeSteps = stepsRegion.replace(/<id>[\s\S]*?<\/id>/g, "");

  // §TBP-20260923-210132-FAD5 — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own fix:
  // the ENVELOPE region (`envelopeBefore`/`envelopeAfter` — everything in `<versions>` OUTSIDE `<steps>`,
  // where the donor's OWN ExpressionSetVersion/definition-version record references legitimately live) was
  // never touched by any Id-stripping pass at all, so a donor's own internal version-identity reference
  // could survive verbatim into every deployed version. Uses the same narrow, proven-safe pattern as
  // `stripIds` (only a genuine 15-18-char alphanumeric Salesforce Id).
  const envelopeBeforeIdFree = stripEnvelopeSalesforceIds(envelopeBefore);
  const envelopeAfterIdFree = stripEnvelopeSalesforceIds(envelopeAfter);

  // §TBP-20260924-064323-C4D9 — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own fix:
  // a `<variables>` element's own `<name>` (a variable declaration a step's parameter can reference by
  // name — e.g. VolumeDiscount's LowerBoundField/UpperBoundField) lives in this same envelope region and
  // would otherwise be caught by the generic `<name>`/`<label>`/`<description>` regeneration below,
  // detaching any parameter that references it BY NAME from its own declaration. Protected exactly like
  // attribute-based/create/canvasBuilder.ts's own already-proven fix for this class of bug.
  const protectedVariableBlocks = new Map<string, string>();
  const envelopeBeforeProtected = protectXmlBlocks(envelopeBeforeIdFree, "variables", protectedVariableBlocks);
  const envelopeAfterProtected = protectXmlBlocks(envelopeAfterIdFree, "variables", protectedVariableBlocks);

  /**
   * §Active ExpressionSetVersion identity collision investigation (9QMak000000t6nxGAA) — mirrors
   * lib/pricing-rules/tier-based/create/canvasBuilder.ts's own fix exactly: `<fullName>` is the
   * ExpressionSetVersion's OWN per-version identity and carries a numeric version suffix in real
   * Salesforce metadata — unlike `<developerName>`/`<name>`/`<expressionSetDefinition>`, which are the
   * shared, version-INDEPENDENT parent identity and correctly stay as the bare `apiName` across every
   * version. This function used to regenerate `<fullName>` as the bare apiName too (no suffix at all),
   * meaning every version ever built for the same procedure carried the IDENTICAL `<fullName>` —
   * Salesforce's real per-version differentiator was never produced. Downstream,
   * `validateExpressionSetUniquenessAgainstOrg`'s collision search (which expects a version-suffixed
   * identity — see its own tests) then matched ANY existing sibling version sharing that bare name,
   * including an unrelated ACTIVE one, and reported a false "Active ExpressionSetVersion identity
   * collision" — blocking every subsequent legitimate new-version build. Never invents a suffix when the
   * donor's own fullName has none.
   */
  function regenerate(envelope: string): string {
    let out = envelope;
    out = out.replace(/<label>[\s\S]*?<\/label>/, `<label>${escapeXml(ctx.procedureName)}</label>`);
    if (ctx.description) out = out.replace(/<description>[\s\S]*?<\/description>/, `<description>${escapeXml(ctx.description)}</description>`);
    // §Part 5, single source of truth — when the caller has already resolved an authoritative identity
    // (`ctx.fullName`), it is used VERBATIM; this function never independently reconstructs it.
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
  const finalVdNodes = finalGraph.filter(n => n.actionType === "VolumeDiscount");
  if (finalVdNodes.length !== 1) {
    fatalErrors.push(`Final composed canvas does not have exactly one VolumeDiscount step (found ${finalVdNodes.length}).`);
    return { success: false, fatalErrors, warnings };
  }
  const finalVdNode = finalVdNodes[0];
  const finalVdFields = collectFieldMap(finalVdNode.full);
  const finalInputUnitPrice = finalVdFields.get("InputUnitPrice") ?? null;

  // §Live-org fix — mirrors lib/pricing-rules/tier-based/create/canvasBuilder.ts's own proven identity-based
  // re-verification against the FINAL, reparsed, post-prune/post-patch XML. occurrenceIndex is NOT a stable
  // identity across pruning: `pruneXmlToRequiredOccurrences` physically removes entire unrelated root-branch
  // <steps> spans, and `extractStepGraph` recomputes every occurrenceIndex fresh via a pre-order walk of
  // whatever <steps> tags remain — so a step that fully survives pruning is still renumbered once its
  // preceding unrelated siblings are gone. The strongest identity actually available here is
  // `actionType === "ListPrice"` itself: the earlier `lpCount !== 1` gate (on `prunedGraph`, before
  // serialization) and the `finalGraph.length !== prunedGraph.length` round-trip check below already
  // GUARANTEE the final canvas contains exactly one ListPrice step, so filtering by actionType here is
  // unambiguous BY CONSTRUCTION. Reinforced by a LookUpId cross-check against `lpLookup.lookUpId` (the value
  // THIS build just patched in), confirming it's genuinely the patched clone, not a stray leftover.
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
    fatalErrors.push(`VOLUME_DISCOUNT_INPUT_MISMATCH: final composed canvas's VolumeDiscount InputUnitPrice ("${finalInputUnitPrice}") does not match the expected value ("${targetInputUnitPriceValue}").`);
    return { success: false, fatalErrors, warnings };
  }
  warnings.push(
    `Final ListPrice identity verified: donor occurrence [${lpNode.occurrenceIndex}] (${lpNode.pathLabel}) -> final occurrence [${finalLpNode.occurrenceIndex}] (${finalLpNode.pathLabel})` +
    `${finalLpNode.occurrenceIndex !== lpNode.occurrenceIndex ? " — occurrence renumbered by pruning, as expected; not a failure" : ""}. ` +
    `ListPrice output(s): ${finalLpOutputValues.join(", ") || "(none)"}. VolumeDiscount InputUnitPrice: "${finalInputUnitPrice}". Validation: PASS.`,
  );
  if (finalVdFields.get("PriceAdjustmentScheduleId") !== "PriceAdjustmentSchedule") {
    fatalErrors.push(`Final composed canvas's VolumeDiscount PriceAdjustmentScheduleId binding ("${finalVdFields.get("PriceAdjustmentScheduleId")}") is not bound to the runtime "PriceAdjustmentSchedule" context variable.`);
    return { success: false, fatalErrors, warnings };
  }
  // §Task 8 — the deterministic "Volume Discount Entries" Decision Table mapping must hold in the FINAL,
  // reparsed XML too, not just the intermediate patched fragment. Single fatal code covering LookUpId/
  // LookUpApiName/LookUpName — any of them drifting is the SAME underlying mapping failure.
  const vdMappingMismatches: string[] = [];
  if (finalVdFields.get("LookUpId") !== vtdLookup.id) {
    vdMappingMismatches.push(`LookUpId ("${finalVdFields.get("LookUpId") ?? "(none)"}") does not equal the resolved table's Id ("${vtdLookup.id}")`);
  }
  if (vtdResolution.table.developerName !== null && finalVdFields.get("LookUpApiName") !== vtdResolution.table.developerName) {
    vdMappingMismatches.push(`LookUpApiName ("${finalVdFields.get("LookUpApiName") ?? "(none)"}") does not equal the resolved table's DeveloperName ("${vtdResolution.table.developerName}")`);
  }
  if (finalVdFields.get("LookUpName") !== vtdLookup.name) {
    vdMappingMismatches.push(`LookUpName ("${finalVdFields.get("LookUpName") ?? "(none)"}") does not equal the resolved table's name ("${vtdLookup.name}")`);
  }
  if (vdMappingMismatches.length > 0) {
    fatalErrors.push(`VOLUME_DISCOUNT_DECISION_TABLE_MAPPING_MISMATCH: final VolumeDiscount does not reflect the resolved "${VOLUME_DISCOUNT_DECISION_TABLE_LABEL}" Decision Table (Id ${vtdLookup.id}, matched via ${vtdResolution.mechanism}): ${vdMappingMismatches.join("; ")}.`);
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
    schemaReport, stepStructureReports: [psReport, lpReport, vdReport],
    outboundVersionFields: {
      versionNumber: injected.outboundVersionNumber, rank: injected.outboundRank,
      fullName: outboundFullNameMatch ? outboundFullNameMatch[1] : null,
      expressionSetDefinition: outboundEsdMatch ? outboundEsdMatch[1] : null,
    },
    volumeDiscountInputBinding: {
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
