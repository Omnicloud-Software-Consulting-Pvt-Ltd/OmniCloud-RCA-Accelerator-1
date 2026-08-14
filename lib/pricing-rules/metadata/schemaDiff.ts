/**
 * Structural (schema-shape) comparison of the generated ExpressionSetDefinition
 * against the donor it was cloned from — root element, namespaces, immediate
 * child elements AND their order, and a per-child-tag presence/count check.
 *
 * Deliberately NOT a value/content diff (patchA-D and the tests elsewhere
 * already cover that) — this exists because "Element steps invalid at this
 * location in type ExpressionSetDefinition" is a SHAPE error: Salesforce's
 * Metadata API enforces a strict child-element order (an XSD sequence) for
 * ExpressionSetDefinition that this codebase has no access to directly (no
 * live org, no published XSD file). The donor Expression Set is a real,
 * already-successfully-deployed component, so its own shape is the only
 * trustworthy reference for what's "required" vs "optional" — this module
 * treats every child element PRESENT IN THE DONOR as expected-required
 * (flagging its absence from the generated file as fatal) and says so
 * explicitly rather than claiming to know Salesforce's actual XSD.
 */
import {
  parseRootElement, type RootElementInfo, type ElementSpan, scanImmediateChildTags, stepInner,
  getTopLevelParameterBlocks, extractFlatBlocks, getParamName,
} from "@/lib/pricing-rules/xml/blocks";

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

  // "Metadata version" — some Salesforce metadata files carry an explicit top-level <version> (or
  // similarly-named) child; report whatever is actually found rather than assuming one exists.
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

  // Every distinct child tag under the root, donor vs. generated, by count.
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
 * §Step-level structural comparison — `compareExpressionSetSchema` above only walks the ROOT
 * element's direct children (so a repeated `<steps>` tag is a single entry, its OWN internal shape
 * invisible); this walks INTO one `<steps>` element (donor vs. the corresponding generated/patched
 * step) and compares ITS direct children, exact order, and — specifically — whether `<parameters>`
 * is a direct child of `<steps>` or nested inside `<customElement>`. That distinction is exactly what
 * produces Salesforce's "Element parameters invalid at this location in type ExpressionSetStep":
 * a direct-child `<parameters>` COUNT mismatch between donor and generated, at the same total
 * parameter count, means some parameter moved between the two locations rather than being added or
 * removed outright — reported here as an explicit "invalid node placement," not folded into a
 * generic missing/extra-node bucket.
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

/** Every named `<parameters>` block in a step, mapped to WHERE it lives — "top-level" (direct child of `<steps>`) or "nested" (inside `<customElement>`) — the exact distinction §9's "parent of every parameters node" check needs. */
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

  // §8 — child names: every distinct tag name present in either side.
  const donorNames = new Set(donorCounts.keys());
  const generatedNames = new Set(generatedCounts.keys());

  const missingNodes: string[] = [];
  const extraNodes: string[] = [];
  for (const tag of [...allTags].sort()) {
    const d = donorCounts.get(tag) ?? 0;
    const g = generatedCounts.get(tag) ?? 0;
    if (d > g) missingNodes.push(`<${tag}> (donor x${d}, generated x${g})`);
    if (g > d) extraNodes.push(`<${tag}> (donor x${d}, generated x${g})`);
  }

  const invalidPlacements: string[] = [];

  // §8 — parent of every <parameters> node: per-NAME placement (top-level vs. nested inside
  // <customElement>), not just an aggregate direct-child count — catches a relocated parameter even
  // when the total top-level count happens to match by coincidence.
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

  // Aggregate direct-child <parameters> count — kept as a second, coarser signal (catches a
  // placement mismatch even for an unnamed/unparseable parameter block the per-name check above
  // would miss).
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
  lines.push(`Expected child order: [${donorChildren.join(", ") || "(donor step not found)"}]`);
  lines.push(`Generated child order: [${generatedChildren.join(", ") || "(generated step not found)"}]`);
  lines.push(`Expected child count: ${donorChildren.length}`);
  lines.push(`Generated child count: ${generatedChildren.length}`);
  lines.push(`Child names — donor: [${[...donorNames].sort().join(", ") || "(none)"}]`);
  lines.push(`Child names — generated: [${[...generatedNames].sort().join(", ") || "(none)"}]`);
  lines.push(`Missing nodes: ${missingNodes.join("; ") || "(none)"}`);
  lines.push(`Extra nodes: ${extraNodes.join("; ") || "(none)"}`);
  lines.push(`Invalid node placement: ${invalidPlacements.join("; ") || "(none)"}`);

  return {
    actionType, expectedChildOrder: donorChildren, generatedChildOrder: generatedChildren,
    expectedChildCount: donorChildren.length, generatedChildCount: generatedChildren.length,
    missingNodes, extraNodes, invalidPlacements, orderMatches, structurallyValid,
    reportText: lines.join("\n"),
  };
}
