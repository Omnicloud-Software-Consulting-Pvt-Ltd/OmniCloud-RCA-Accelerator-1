/**
 * Structural (schema-shape) comparison of the generated ExpressionSetDefinition
 * against the donor it was cloned from — root element, namespaces, immediate
 * child elements AND their order, and a per-child-tag presence/count check.
 *
 * Deliberately NOT a value/content diff — this exists because "Element steps
 * invalid at this location in type ExpressionSetDefinition" is a SHAPE
 * error: Salesforce's Metadata API enforces a strict child-element order
 * for ExpressionSetDefinition that this codebase has no access to directly
 * (no published XSD file). The donor Expression Set is a real,
 * already-successfully-deployed component, so its own shape is the only
 * trustworthy reference for what's "required" vs "optional" — this module
 * treats every child element PRESENT IN THE DONOR as expected-required
 * (flagging its absence from the generated file as fatal).
 */
import {
  parseRootElement, type RootElementInfo, type ElementSpan, scanImmediateChildTags, stepInner,
  getTopLevelParameterBlocks, extractFlatBlocks, getParamName,
  type PhysicalStepNode,
} from "./xmlBlocks";

export interface SchemaComparisonRow {
  field: string;
  donor: string;
  generated: string;
  status: "MATCH" | "DIFFERENT" | "MISSING" | "ADDED";
  note?: string;
}

export interface ChildElementCheck {
  tagName: string;
  donorCount: number;
  generatedCount: number;
  /** True when this tag is present in the donor at all — this module's only available signal for "required," since no real Salesforce XSD is accessible here. */
  requiredInferredFromDonor: boolean;
  status: "MATCH" | "DIFFERENT" | "MISSING" | "ADDED";
}

export interface ExpressionSetSchemaReport {
  donorRoot: RootElementInfo | null;
  generatedRoot: RootElementInfo | null;
  rows: SchemaComparisonRow[];
  children: ChildElementCheck[];
  /** False when a required-per-donor child is missing, or child ordering diverges — the conditions known to trigger Salesforce's "invalid at this location" schema error. Does NOT fail merely for an added/extra child. */
  structurallyValid: boolean;
  issues: string[];
  reportText: string;
}

function countBy<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const item of items) m.set(item, (m.get(item) ?? 0) + 1);
  return m;
}

export function compareExpressionSetSchema(donorXml: string, generatedXml: string): ExpressionSetSchemaReport {
  const donorRoot = parseRootElement(donorXml);
  const generatedRoot = parseRootElement(generatedXml);
  const rows: SchemaComparisonRow[] = [];
  const issues: string[] = [];

  const donorNsEntries = Object.entries(donorRoot?.attributes ?? {}).filter(([k]) => k === "xmlns" || k.startsWith("xmlns:"));
  const generatedNsEntries = Object.entries(generatedRoot?.attributes ?? {}).filter(([k]) => k === "xmlns" || k.startsWith("xmlns:"));
  const donorNs = donorNsEntries.map(([k, v]) => `${k}="${v}"`).sort().join(" ");
  const generatedNs = generatedNsEntries.map(([k, v]) => `${k}="${v}"`).sort().join(" ");

  rows.push({
    field: "Root element",
    donor: donorRoot?.tagName ?? "(not found)",
    generated: generatedRoot?.tagName ?? "(not found)",
    status: donorRoot && generatedRoot && donorRoot.tagName === generatedRoot.tagName ? "MATCH" : "DIFFERENT",
  });
  if (rows[rows.length - 1].status === "DIFFERENT") issues.push(`Root element differs: donor is "${donorRoot?.tagName ?? "(not found)"}", generated is "${generatedRoot?.tagName ?? "(not found)"}".`);

  rows.push({
    field: "Namespaces",
    donor: donorNs || "(none)",
    generated: generatedNs || "(none)",
    status: donorNs === generatedNs ? "MATCH" : "DIFFERENT",
  });
  if (rows[rows.length - 1].status === "DIFFERENT") issues.push(`Namespace declarations differ: donor "${donorNs || "(none)"}" vs. generated "${generatedNs || "(none)"}".`);

  const versionTag = donorRoot?.childOrder.find(t => /version/i.test(t)) ?? generatedRoot?.childOrder.find(t => /version/i.test(t)) ?? null;
  rows.push({
    field: "Metadata version element",
    donor: versionTag ? String(countBy(donorRoot?.childOrder ?? []).get(versionTag) ?? 0) + `x <${versionTag}>` : "(no version-named child present)",
    generated: versionTag ? String(countBy(generatedRoot?.childOrder ?? []).get(versionTag) ?? 0) + `x <${versionTag}>` : "(no version-named child present)",
    status: !versionTag
      ? "MATCH"
      : (countBy(donorRoot?.childOrder ?? []).get(versionTag) ?? 0) === (countBy(generatedRoot?.childOrder ?? []).get(versionTag) ?? 0) ? "MATCH" : "DIFFERENT",
    note: versionTag ? undefined : "Neither file has a child element with \"version\" in its name at the root level.",
  });

  const donorOrder = donorRoot?.childOrder ?? [];
  const generatedOrder = generatedRoot?.childOrder ?? [];
  const orderingMatches = donorOrder.length === generatedOrder.length && donorOrder.every((t, i) => t === generatedOrder[i]);
  rows.push({
    field: "Ordering",
    donor: donorOrder.join(", ") || "(empty)",
    generated: generatedOrder.join(", ") || "(empty)",
    status: orderingMatches ? "MATCH" : "DIFFERENT",
  });
  if (!orderingMatches) issues.push(`Child element ORDER diverges from the donor — donor order: [${donorOrder.join(", ")}], generated order: [${generatedOrder.join(", ")}]. This is the exact shape of divergence that produces "Element <X> invalid at this location" from the Metadata API.`);

  const donorCounts = countBy(donorOrder);
  const generatedCounts = countBy(generatedOrder);
  const allTags = new Set<string>([...donorCounts.keys(), ...generatedCounts.keys()]);
  const children: ChildElementCheck[] = [];
  for (const tagName of allTags) {
    const donorCount = donorCounts.get(tagName) ?? 0;
    const generatedCount = generatedCounts.get(tagName) ?? 0;
    const requiredInferredFromDonor = donorCount > 0;
    let status: ChildElementCheck["status"];
    if (donorCount > 0 && generatedCount === 0) status = "MISSING";
    else if (donorCount === 0 && generatedCount > 0) status = "ADDED";
    else if (donorCount === generatedCount) status = "MATCH";
    else status = "DIFFERENT";
    children.push({ tagName, donorCount, generatedCount, requiredInferredFromDonor, status });
    if (status === "MISSING") issues.push(`Required child element <${tagName}> (present ${donorCount}x in the donor) is missing from the generated file.`);
  }
  children.sort((a, b) => a.tagName.localeCompare(b.tagName));

  const structurallyValid = !!donorRoot && !!generatedRoot
    && donorRoot.tagName === generatedRoot.tagName
    && orderingMatches
    && children.every(c => c.status !== "MISSING");

  const lines: string[] = [];
  lines.push("=== Expression Set Structural Schema Comparison (donor vs. generated) ===");
  lines.push("");
  for (const row of rows) {
    lines.push(`${row.field}:`);
    lines.push(`  Donor: ${row.donor}`);
    lines.push(`  Generated: ${row.generated}`);
    lines.push(`  Result: ${row.status}${row.note ? ` (${row.note})` : ""}`);
  }
  lines.push("");
  lines.push("Every child element under the root (Required = present in the donor; this module has no access to Salesforce's actual XSD, so \"required\" is inferred from the donor's own real, already-deployed structure):");
  for (const c of children) {
    lines.push(`  - <${c.tagName}>: donor x${c.donorCount}, generated x${c.generatedCount}, required (inferred from donor): ${c.requiredInferredFromDonor ? "YES" : "NO"} — ${c.status}`);
  }
  lines.push("");
  lines.push(`Structurally valid: ${structurallyValid ? "YES" : "NO"}`);
  if (!structurallyValid) {
    lines.push("Issues:");
    for (const issue of issues) lines.push(`  - ${issue}`);
  }

  return { donorRoot, generatedRoot, rows, children, structurallyValid, issues, reportText: lines.join("\n") };
}

/**
 * Step-level structural comparison — `compareExpressionSetSchema` above
 * only walks the ROOT element's direct children (so a repeated `<steps>`
 * tag is a single entry, its OWN internal shape invisible); this walks INTO
 * one `<steps>` element (donor vs. the corresponding generated/patched
 * step) and compares ITS direct children, exact order, and — specifically
 * — whether `<parameters>` is a direct child of `<steps>` or nested inside
 * `<customElement>`. That distinction is exactly what produces Salesforce's
 * "Element parameters invalid at this location in type ExpressionSetStep".
 */
export interface StepStructureReport {
  actionType: string;
  expectedChildOrder: string[];
  generatedChildOrder: string[];
  expectedChildCount: number;
  generatedChildCount: number;
  missingNodes: string[];
  extraNodes: string[];
  invalidPlacements: string[];
  orderMatches: boolean;
  structurallyValid: boolean;
  reportText: string;
}

/** Every named `<parameters>` block in a step, mapped to WHERE it lives — "top-level" (direct child of `<steps>`) or "nested" (inside `<customElement>`). */
function paramPlacements(stepFullXml: string): Map<string, "top-level" | "nested"> {
  const map = new Map<string, "top-level" | "nested">();
  for (const b of getTopLevelParameterBlocks(stepFullXml)) {
    const n = getParamName(b.block);
    if (n && !map.has(n)) map.set(n, "top-level");
  }
  for (const ce of extractFlatBlocks(stepFullXml, "customElement")) {
    for (const p of extractFlatBlocks(ce, "parameters")) {
      const n = getParamName(p);
      if (n && !map.has(n)) map.set(n, "nested");
    }
  }
  return map;
}

export function compareStepStructure(donorStep: ElementSpan | null, generatedStepFullXml: string | null, actionType: string): StepStructureReport {
  const donorChildren = donorStep ? scanImmediateChildTags(donorStep.content) : [];
  const generatedChildren = generatedStepFullXml ? scanImmediateChildTags(stepInner(generatedStepFullXml)) : [];

  const donorCounts = countBy(donorChildren);
  const generatedCounts = countBy(generatedChildren);
  const allTags = new Set<string>([...donorCounts.keys(), ...generatedCounts.keys()]);

  const missingNodes: string[] = [];
  const extraNodes: string[] = [];
  for (const tag of [...allTags].sort()) {
    const d = donorCounts.get(tag) ?? 0;
    const g = generatedCounts.get(tag) ?? 0;
    if (d > g) missingNodes.push(`<${tag}> (donor x${d}, generated x${g})`);
    if (g > d) extraNodes.push(`<${tag}> (donor x${d}, generated x${g})`);
  }

  const invalidPlacements: string[] = [];

  if (donorStep && generatedStepFullXml) {
    const donorPlacements = paramPlacements(donorStep.full);
    const generatedPlacements = paramPlacements(generatedStepFullXml);
    for (const [name, place] of generatedPlacements) {
      const donorPlace = donorPlacements.get(name);
      if (donorPlace && donorPlace !== place) {
        invalidPlacements.push(`Parameter "${name}" is ${place} in the generated step but ${donorPlace} in the donor (actionType "${actionType}").`);
      } else if (!donorPlace && place === "top-level") {
        invalidPlacements.push(`Parameter "${name}" is a NEW top-level <parameters> node not present anywhere in the donor (actionType "${actionType}") — <parameters> may never be emitted directly under <steps> unless the donor step also has one.`);
      }
    }
  }

  const donorDirectParams = donorCounts.get("parameters") ?? 0;
  const generatedDirectParams = generatedCounts.get("parameters") ?? 0;
  if (donorDirectParams !== generatedDirectParams && invalidPlacements.length === 0) {
    invalidPlacements.push(
      `<parameters> is a direct child of <steps> ${donorDirectParams}x in the donor but ${generatedDirectParams}x in the generated file (same step, actionType "${actionType}") — Salesforce requires <parameters> to be either a direct child of <steps> or nested inside <customElement> consistently with the donor's own shape; this mismatch is the exact cause of "Element parameters invalid at this location in type ExpressionSetStep".`,
    );
  }

  const orderMatches = donorChildren.length === generatedChildren.length && donorChildren.every((t, i) => t === generatedChildren[i]);
  if (!orderMatches && donorStep && generatedStepFullXml) {
    invalidPlacements.push(`Direct child element ORDER diverges from the donor for step "${actionType}" — donor order: [${donorChildren.join(", ")}], generated order: [${generatedChildren.join(", ")}].`);
  }

  const structurallyValid = !!donorStep && !!generatedStepFullXml && missingNodes.length === 0 && invalidPlacements.length === 0;

  const lines: string[] = [];
  lines.push(`Step: ${actionType}`);
  lines.push(`Donor children: ${donorChildren.length}`);
  lines.push(`Generated children: ${generatedChildren.length}`);
  lines.push(`Expected child order: [${donorChildren.join(", ") || "(donor step not found)"}]`);
  lines.push(`Generated child order: [${generatedChildren.join(", ") || "(generated step not found)"}]`);
  lines.push(`Missing: ${missingNodes.join("; ") || "none"}`);
  lines.push(`Unexpected: ${extraNodes.join("; ") || "none"}`);
  lines.push(`Invalid node placement: ${invalidPlacements.join("; ") || "(none)"}`);
  lines.push(`Order: ${orderMatches ? "MATCH" : "NO MATCH"}`);
  lines.push(`Result: ${structurallyValid ? "PASS" : "FAIL"}`);

  return {
    actionType, expectedChildOrder: donorChildren, generatedChildOrder: generatedChildren,
    expectedChildCount: donorChildren.length, generatedChildCount: generatedChildren.length,
    missingNodes, extraNodes, invalidPlacements, orderMatches, structurallyValid,
    reportText: lines.join("\n"),
  };
}

export interface ParentStepValidationEntry {
  occurrenceIndex: number;
  pathLabel: string;
  actionType: string | null;
  stepName: string | null;
  parentStep: string | null;
  parentExists: boolean;
  matchesDonor: boolean;
  valid: boolean;
  reason?: string;
}

export interface ParentStepValidationResult {
  entries: ParentStepValidationEntry[];
  /** Generated `<name>` values that occur more than once. INFORMATIONAL ONLY — this donor's own
   * metadata legitimately reuses names across unrelated branches (e.g. every pricing-type branch's own
   * "set the schedule id" sub-step is conventionally named "PriceAdjustmentScheduleId"); duplicate names
   * never fail validation on their own. See the file-level "Occurrence identity" note below. */
  duplicateStepNames: string[];
  allValid: boolean;
}

/**
 * §Referential integrity, occurrence-aware — `<name>` is NOT a safe identity key in this donor's
 * metadata: physically distinct nodes across unrelated branches legitimately share a `<name>` (proven
 * live: 5 separate physical steps named "PriceAdjustmentScheduleId", one per pricing-type branch). A
 * name-keyed comparison (e.g. `Map<name, donorParentStep>`) silently collapses those distinct nodes
 * into one entry, comparing several unrelated generated nodes against whichever donor node happened to
 * be seen last for that name — producing exactly the "nonsense" mismatches this donor's live run
 * exposed. This validator instead takes the donor's and generated's FULL `PhysicalStepNode[]` graphs
 * (same length, positionally aligned by `occurrenceIndex` — guaranteed by the caller's single-span,
 * content-only replacement strategy, never re-derived by name) and compares `donorNodes[i]` against
 * `generatedNodes[i]` directly, for every `i`.
 *
 * Two distinct checks, deliberately different in kind:
 *   - `parentExists` — does the referenced `<parentStep>` name exist ANYWHERE in the generated set?
 *     This mirrors Salesforce's OWN resolution semantics (an exact-name lookup across the whole deployed
 *     step set) and is correctly existence-only: Salesforce will resolve to SOME node with that name: the
 *     raw NPE this whole investigation started from is precisely this lookup returning null, and existence
 *     is genuinely all that prevents it, regardless of how many nodes share the name.
 *   - `matchesDonor` — does THIS EXACT physical occurrence's `<parentStep>` value still equal what the
 *     SAME physical occurrence had in the donor? This is the check that must be occurrence-based, not
 *     name-based, since it's asking "did anything change here," not "does something exist somewhere."
 */
export function validateParentStepReferences(
  donorNodes: PhysicalStepNode[],
  generatedNodes: PhysicalStepNode[],
): ParentStepValidationResult {
  const nameCounts = new Map<string, number>();
  for (const n of generatedNodes) if (n.name) nameCounts.set(n.name, (nameCounts.get(n.name) ?? 0) + 1);
  const duplicateStepNames = [...nameCounts.entries()].filter(([, count]) => count > 1).map(([n]) => n);
  const nameSet = new Set(generatedNodes.map(n => n.name).filter((n): n is string => !!n));
  const donorByOccurrence = new Map(donorNodes.map(n => [n.occurrenceIndex, n]));

  const entries: ParentStepValidationEntry[] = generatedNodes.map(n => {
    const donor = donorByOccurrence.get(n.occurrenceIndex) ?? null;
    const parentExists = !n.parentStep || nameSet.has(n.parentStep);
    const matchesDonor = n.parentStep === (donor?.parentStep ?? null);
    const valid = parentExists && matchesDonor;
    const reason = !parentExists
      ? `parentStep "${n.parentStep}" does not match any generated step's <name> — Salesforce would throw ExpressionSetStep.getParentStep() on a null lookup.`
      : !matchesDonor
        ? `Generated parentStep "${n.parentStep ?? "(none)"}" differs from the donor's own value "${donor?.parentStep ?? "(none)"}" for this exact physical occurrence (${n.pathLabel}).`
        : undefined;
    return {
      occurrenceIndex: n.occurrenceIndex, pathLabel: n.pathLabel, actionType: n.actionType, stepName: n.name,
      parentStep: n.parentStep, parentExists, matchesDonor, valid, reason,
    };
  });

  // Duplicate names are informational only (Part 5) — never contribute to allValid.
  return { entries, duplicateStepNames, allValid: entries.every(e => e.valid) };
}
