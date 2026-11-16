import type { LineFacts, ProductFacts, QuoteFacts, RampSegmentFacts, Reason } from "./eligibility";

/**
 * GROUP RAMP DIAGNOSTICS (pure). Reads the quote's real QuoteLineGroup / QuoteLineItem state and explains it. Shapes verified
 * read-only in p12 (2026-11-10):
 *  · Chain ramp — the original group is converted to segment 1 (IsRamped = true, no parent); Salesforce's clones follow
 *    ("New Group 1", "New Group 1 - Year 2"), and each product's lines across the segments share one RampIdentifier.
 *  · Parent ramp — an un-ramped parent group ("RAMP GROUP", IsRamped = false) whose ramped children point to it through
 *    ParentQuoteLineGroupId ("YEAR 1", "YEAR 1 - Year 2", …).
 *  · UsageModelType = Anchor products were group-ramped by Salesforce in p12 (#46, #60–#64) although line ramps refuse them — a warning here.
 *  · Ramp schedules per quote: the dev guide says a quote can contain a single ramp schedule, and p12 refused EditGroup on a quote that
 *    had one (2026-11-10); yet p12 quote #40 holds two. So another ramped group on the quote is a WARNING (Salesforce decides) and is
 *    NOT a reason to block an un-ramped group.
 * IsRamped = false alone does not make a group eligible: a parent that already has ramped children is an existing ramp's container.
 */

export interface GroupFacts {
  id: string; name: string; quoteId: string; isRamped: boolean | null; parentId: string | null; sortOrder: number | null;
  segmentType: string | null; startDate: string | null; endDate: string | null; unitPriceUplift: number | null; rampUpliftType: string | null;
}
export interface RampChain {
  /** Stable key: the parent group Id, or the first segment's Id. */
  key: string;
  shape: "parent" | "chain";
  parent: GroupFacts | null;
  segments: GroupFacts[];
  rampIdentifiers: string[];
}
export type GroupState = "unramped" | "ramp-segment" | "ramp-container";

export interface LineDiagnostic { line: LineFacts & { productName?: string | null }; eligible: boolean; reasons: Reason[] }
export interface GroupRampDiagnostics {
  eligible: boolean;
  /** Errors block execution; warnings are shown. */
  reasons: Reason[];
  quoteReasons: Reason[];
  groupState: GroupState | null;
  /** The existing ramp this group belongs to (segment) or holds (container). */
  chain: RampChain | null;
  /** Other ramp schedules already on the quote (informational). */
  otherRamps: RampChain[];
  lines: LineDiagnostic[];
}

const bySegmentOrder = (a: GroupFacts, b: GroupFacts) => (a.startDate ?? "").localeCompare(b.startDate ?? "") || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

/** Every ramp schedule on the quote: ramped children grouped under their un-ramped parent; otherwise ramped groups linked by shared line RampIdentifiers. */
export function existingRamps(groups: GroupFacts[], lines: Pick<LineFacts, "groupId" | "rampIdentifier">[]): RampChain[] {
  const byId = new Map(groups.map(g => [g.id, g]));
  const ramped = groups.filter(g => g.isRamped);
  const idsOf = (gid: string) => [...new Set(lines.filter(l => l.groupId === gid && l.rampIdentifier).map(l => l.rampIdentifier!))];
  const chains: RampChain[] = [];
  const done = new Set<string>();
  // Parent shape
  for (const g of ramped) {
    const parent = g.parentId ? byId.get(g.parentId) : undefined;
    if (!parent || parent.isRamped || done.has(g.id)) continue;
    const segs = ramped.filter(x => x.parentId === parent.id).sort(bySegmentOrder);
    segs.forEach(x => done.add(x.id));
    chains.push({ key: parent.id, shape: "parent", parent, segments: segs, rampIdentifiers: [...new Set(segs.flatMap(x => idsOf(x.id)))] });
  }
  // Chain shape: union ramped groups that share any RampIdentifier
  const rest = ramped.filter(g => !done.has(g.id));
  const root = new Map(rest.map(g => [g.id, g.id]));
  const find = (x: string): string => (root.get(x) === x ? x : find(root.get(x)!));
  const byRid = new Map<string, string[]>();
  for (const g of rest) for (const rid of idsOf(g.id)) byRid.set(rid, [...(byRid.get(rid) ?? []), g.id]);
  for (const ids of byRid.values()) for (const id of ids.slice(1)) root.set(find(id), find(ids[0]));
  // Fallback for segments without lines (no RampIdentifier to share): Salesforce names a clone "<segment 1 name> - Year N"
  // (p12 #40: "New Group 1" → "New Group 1 - Year 2").
  for (const a of rest) for (const b of rest) if (a !== b && b.name.startsWith(`${a.name} - `)) root.set(find(b.id), find(a.id));
  const buckets = new Map<string, GroupFacts[]>();
  for (const g of rest) buckets.set(find(g.id), [...(buckets.get(find(g.id)) ?? []), g]);
  for (const segs of buckets.values()) {
    segs.sort(bySegmentOrder);
    chains.push({ key: segs[0].id, shape: "chain", parent: null, segments: segs, rampIdentifiers: [...new Set(segs.flatMap(x => idsOf(x.id)))] });
  }
  return chains;
}

export function groupState(group: GroupFacts, groups: GroupFacts[]): GroupState {
  if (group.isRamped) return "ramp-segment";
  return groups.some(g => g.parentId === group.id && g.isRamped) ? "ramp-container" : "unramped";
}

/** Diagnose one group for a NEW group ramp — the same rules the execution's validate step applies. */
export function groupRampDiagnostics(a: { quote: QuoteFacts | null; groupId: string | null; groups: GroupFacts[]; lines: (LineFacts & { productName?: string | null })[]; products: Map<string, ProductFacts>; segmentsByProduct: Map<string, RampSegmentFacts[]> }): GroupRampDiagnostics {
  const quoteReasons: Reason[] = [];
  if (!a.quote) quoteReasons.push({ code: "quote-missing", severity: "error", message: "The quote wasn't found (or your user can't read it)." });
  else if (a.quote.status !== "Draft") quoteReasons.push({ code: "quote-not-draft", severity: "error", message: `Quote ${a.quote.name} is ${a.quote.status ?? "not Draft"}; group ramps are added to Draft quotes only.` });
  const group = a.groups.find(g => g.id === a.groupId) ?? null;
  const ramps = existingRamps(a.groups, a.lines);
  const out: GroupRampDiagnostics = { eligible: false, reasons: [...quoteReasons], quoteReasons, groupState: null, chain: null, otherRamps: ramps, lines: [] };
  if (!a.groupId) return out;
  if (!group) { out.reasons.push({ code: "group-missing", severity: "error", message: "The quote line group wasn't found on this quote." }); return out; }
  if (a.quote && group.quoteId !== a.quote.id) out.reasons.push({ code: "group-other-quote", severity: "error", message: "The group belongs to another quote." });
  const state = groupState(group, a.groups);
  out.groupState = state;
  const mine = ramps.find(c => c.parent?.id === group.id || c.segments.some(s => s.id === group.id)) ?? null;
  out.chain = mine;
  out.otherRamps = ramps.filter(c => c !== mine);
  if (state === "ramp-segment") out.reasons.push({ code: "group-ramped", severity: "error", message: `${group.name} is already a ramp segment (IsRamped = true, SegmentType ${group.segmentType ?? "—"}, ${group.startDate ?? "?"} → ${group.endDate ?? "?"}) of an existing ramp with ${mine?.segments.length ?? 1} segment(s). Open the existing ramp instead — a second ramp can't be created on a segment.` });
  if (state === "ramp-container") out.reasons.push({ code: "group-has-ramp", severity: "error", message: `${group.name} already holds a ramp schedule: ${mine?.segments.length ?? 0} ramped child group(s) point to it (ParentQuoteLineGroupId). Open the existing ramp instead.` });
  if (group.parentId && !group.isRamped) out.reasons.push({ code: "group-is-child", severity: "warning", message: `${group.name} is a child group (parent ${a.groups.find(g => g.id === group.parentId)?.name ?? group.parentId}).` });
  if (out.otherRamps.length) out.reasons.push({ code: "quote-has-other-ramps", severity: "warning", message: `This quote already has ${out.otherRamps.length} ramp schedule(s). The Revenue Cloud guide says a quote can contain a single ramp schedule, and Salesforce refuses to convert a group once the quote has one ("You can’t convert a group to a ramped segment when the quote has a ramp schedule") — expect the conversion to be rejected unless this org allows several (p12 quote #40 holds two). Use a separate quote to be safe.` });

  const glines = a.lines.filter(l => l.groupId === group.id);
  if (!glines.length) out.reasons.push({ code: "group-empty", severity: "error", message: `${group.name} has no quote lines — add the products to ramp first.` });
  for (const l of glines) {
    const r: Reason[] = [];
    const p = l.productId ? a.products.get(l.productId) ?? null : null;
    const name = p?.name ?? l.productName ?? l.id;
    if (l.rampIdentifier) r.push({ code: "line-ramped", severity: "error", message: `${name} is already ramped (RampIdentifier ${l.rampIdentifier}).` });
    if (!l.sellingModelId && !l.sellingModelType) r.push({ code: "no-selling-model", severity: "error", message: `${name} has no selling model — re-add it with a term-defined selling model.` });
    else if (l.sellingModelType && l.sellingModelType !== "TermDefined") r.push({ code: "line-not-term", severity: "error", message: `${name}: selling model ${l.sellingModelType} can't be ramped (term-defined only).` });
    // Line ramps refuse usage-based products at commit, but Salesforce HAS group-ramped Anchor products (p12 #46, #60–#64: API Access
    // Premium, UsageModelType = Anchor, lines sharing a RampIdentifier) — so for a group ramp this is a warning, and Salesforce decides.
    if (p?.usageModelType) r.push({ code: "usage-based", severity: "warning", message: `${name} has UsageModelType ${p.usageModelType}. Line ramps refuse usage-based products; group ramps have accepted Anchor products in p12 — Salesforce will reject the conversion if this one isn't allowed.` });
    if (p && p.canRamp === false && !(a.segmentsByProduct.get(p.id) ?? []).length) r.push({ code: "no-segments", severity: "error", message: `${name} has no Product Ramp Segment (CanRamp = false) — create one in Product Ramp Setup.` });
    if (p && p.isActive === false) r.push({ code: "inactive", severity: "error", message: `${name} is inactive.` });
    if (!l.periodBoundary) r.push({ code: "no-period-boundary", severity: "warning", message: `${name} has no Period Boundary — pricing may need one.` });
    out.lines.push({ line: l, eligible: !r.some(x => x.severity === "error"), reasons: r });
  }
  const lineErrors = out.lines.flatMap(d => d.reasons.filter(r => r.severity === "error"));
  out.reasons.push(...lineErrors);
  out.eligible = !out.reasons.some(r => r.severity === "error");
  return out;
}
