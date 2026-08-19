/**
 * Regex/string-based Expression Set XML toolkit.
 *
 * Deliberately NOT a full XML/DOM parser: Expression Set step XML is
 * manipulated here as addressable text blocks (a `<steps>` element per
 * ExpressionSetStep, a `<parameters>` element per binding). This keeps the
 * dependency footprint to just `jszip` for the deploy/retrieve zip itself.
 *
 * The one place nesting actually matters is `<steps>` — a container step
 * can hold child `<steps>` inside it. Every other block type used here
 * (`<parameters>`, `<customElement>`) never nests within itself, so those
 * use flat non-greedy regexes.
 */

export interface ElementSpan {
  start: number;
  end: number;
  /** Everything between the opening tag's `>` and the matching closing tag's `<` — includes any nested same-name children. */
  content: string;
  /** The full `<tag>...</tag>` text, including the tag itself. */
  full: string;
}

/** Every `<tagName>...</tagName>` element in `xml`, at EVERY nesting depth (both a container and its nested children each get their own span) — correct for a tag that can nest within itself, like `<steps>`. */
export function extractElementSpans(xml: string, tagName: string): ElementSpan[] {
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

  const spans: ElementSpan[] = [];
  const openStack: { tagStart: number; contentStart: number }[] = [];
  for (const t of tokens) {
    if (t.type === "open") {
      openStack.push({ tagStart: t.pos, contentStart: t.pos + t.len });
    } else {
      const top = openStack.pop();
      if (!top) continue; // stray/unbalanced closing tag — ignore rather than throw on malformed input
      const end = t.pos + t.len;
      spans.push({ start: top.tagStart, end, content: xml.slice(top.contentStart, t.pos), full: xml.slice(top.tagStart, end) });
    }
  }
  return spans;
}

/** Flat (non-nesting) extraction — safe for `<parameters>`/`<customElement>`, which never nest within themselves. */
export function extractFlatBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tagName}>`, "g");
  return xml.match(re) ?? [];
}

/** First `<tagName>...</tagName>` text content within `block`, or null if absent. */
export function getTagValue(block: string, tagName: string): string | null {
  const m = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`));
  return m ? m[1].trim() : null;
}

export function getAllTagValues(block: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(m[1].trim());
  return out;
}

/** Top-level `<steps>` blocks in `xml` — every ExpressionSetStep, including container steps (whose `.content` also contains their nested child steps' text). */
export function extractStepBlocks(xml: string): ElementSpan[] {
  return extractElementSpans(xml, "steps");
}

/**
 * The actionType belonging to THIS step, not a nested child's — found by
 * looking only at the portion of `stepContent` before any nested `<steps`
 * child begins. Every real ExpressionSetStep puts its own `<actionType>`
 * before any nested step children, so this is a safe, simple boundary.
 */
export function getOwnActionType(stepContent: string): string | null {
  const nestedIdx = stepContent.indexOf("<steps");
  const own = nestedIdx === -1 ? stepContent : stepContent.slice(0, nestedIdx);
  return getTagValue(own, "actionType");
}

/** Find every `<steps>` span (top-level or nested inside a container) whose OWN actionType matches. */
export function findStepsByActionType(xml: string, actionType: string): ElementSpan[] {
  return extractStepBlocks(xml).filter(s => getOwnActionType(s.content) === actionType);
}

/** Find every `<steps>` span whose own `<name>` exactly matches `name` — no case/whitespace
 * normalization, since Salesforce's own `parentStep` resolution is an exact-string lookup (this is
 * the real mechanism a `<parentStep>` value refers back to). */
export function findStepsByName(xml: string, name: string): ElementSpan[] {
  return extractStepBlocks(xml).filter(s => getTagValue(s.content, "name") === name);
}

/**
 * §Occurrence-aware step identity — a donor Expression Set can legitimately contain many physically
 * distinct `<steps>` nodes that share the same `<name>` (e.g. every "set the price adjustment schedule"
 * sub-step across unrelated pricing-type branches conventionally named "PriceAdjustmentScheduleId", or
 * generic list-operation inputs named "section-0-input1"). `<name>` is therefore NOT a safe identity key
 * for application-side graph operations — two nodes sharing a name must remain two distinct nodes. This
 * is the one place that identity is derived instead from PHYSICAL POSITION: a stack-based, single-pass
 * walk over every `<steps>`/`</steps>` tag (ignoring every other tag) that assigns each node a stable
 * `occurrenceIndex` (pre-order document position — the Nth `<steps>` tag opened, reading top to bottom)
 * and a `path` (sibling-index chain from the root, e.g. `[5, 0, 2]` = "6th root branch → 1st child →
 * 3rd grandchild"). As long as a caller only ever REPLACES the TEXT CONTENT between one node's own open
 * and close tag (never adding/removing a `<steps>` tag anywhere), `extractStepGraph(before)[i]` and
 * `extractStepGraph(after)[i]` are guaranteed to refer to the exact same physical node for every `i` —
 * this is the actual property every donor/generated comparison in this codebase needs, and `<name>`
 * equality was never able to guarantee it.
 */
export interface PhysicalStepNode {
  /** Pre-order document position — the Nth `<steps>` tag opened, reading top to bottom. Stable across a
   * before/after pair as long as no `<steps>` tag was added or removed anywhere in between. */
  occurrenceIndex: number;
  /** Sibling-index chain from the root to this node, e.g. `[5, 0, 2]`. */
  path: number[];
  /** Human-readable rendering of `path`, e.g. `"steps[5]/steps[0]/steps[2]"` — for diagnostics only. */
  pathLabel: string;
  /** `path.length - 1` — 0 for a top-level/root step. */
  depth: number;
  /** `occurrenceIndex` of the immediate parent node, or null for a root step. */
  parentOccurrenceIndex: number | null;
  name: string | null;
  actionType: string | null;
  /** The donor's own `<parentStep>` VALUE — a name Salesforce resolves at deploy time; distinct from
   * `parentOccurrenceIndex`, which is this node's real PHYSICAL nesting parent and may differ. */
  parentStep: string | null;
  sequenceNumber: string | null;
  start: number;
  end: number;
  /** Everything between the opening tag's `>` and the matching closing tag's `<` — includes nested children. */
  content: string;
  /** The full `<steps>...</steps>` text, including nested children. */
  full: string;
}

/**
 * Walk `xml` once, tracking only `<steps>`/`</steps>` tags via a stack, and return one `PhysicalStepNode`
 * per physical occurrence — see the interface doc above. Nodes are returned sorted by `occurrenceIndex`
 * (document/open-tag order). A stray/unbalanced closing tag is skipped defensively rather than throwing.
 */
export function extractStepGraph(xml: string): PhysicalStepNode[] {
  const openRe = /<steps(?:\s[^>]*)?>/g;
  const closeTag = "</steps>";

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

  interface Frame {
    tagStart: number;
    contentStart: number;
    occurrenceIndex: number;
    path: number[];
    parentOccurrenceIndex: number | null;
    childCounter: number;
  }
  const stack: Frame[] = [];
  let rootCounter = 0;
  let occurrenceCounter = 0;
  const partial = new Map<number, {
    occurrenceIndex: number; path: number[]; parentOccurrenceIndex: number | null;
    tagStart: number; contentStart: number; end?: number;
  }>();

  for (const t of tokens) {
    if (t.type === "open") {
      const parentFrame = stack[stack.length - 1] ?? null;
      const siblingIndex = parentFrame ? parentFrame.childCounter++ : rootCounter++;
      const path = parentFrame ? [...parentFrame.path, siblingIndex] : [siblingIndex];
      const occurrenceIndex = occurrenceCounter++;
      const frame: Frame = {
        tagStart: t.pos,
        contentStart: t.pos + t.len,
        occurrenceIndex,
        path,
        parentOccurrenceIndex: parentFrame ? parentFrame.occurrenceIndex : null,
        childCounter: 0,
      };
      stack.push(frame);
      partial.set(occurrenceIndex, {
        occurrenceIndex, path, parentOccurrenceIndex: frame.parentOccurrenceIndex,
        tagStart: frame.tagStart, contentStart: frame.contentStart,
      });
    } else {
      const frame = stack.pop();
      if (!frame) continue; // stray/unbalanced closing tag — ignore rather than throw on malformed input
      const rec = partial.get(frame.occurrenceIndex);
      if (rec) rec.end = t.pos + t.len;
    }
  }

  const nodes: PhysicalStepNode[] = [];
  for (const rec of [...partial.values()].sort((a, b) => a.occurrenceIndex - b.occurrenceIndex)) {
    if (rec.end === undefined) continue; // never closed — malformed input, skip defensively
    const full = xml.slice(rec.tagStart, rec.end);
    const content = xml.slice(rec.contentStart, rec.end - closeTag.length);
    const nestedIdx = content.indexOf("<steps");
    const ownFieldsText = nestedIdx === -1 ? content : content.slice(0, nestedIdx);
    nodes.push({
      occurrenceIndex: rec.occurrenceIndex,
      path: rec.path,
      pathLabel: rec.path.map(i => `steps[${i}]`).join("/"),
      depth: rec.path.length - 1,
      parentOccurrenceIndex: rec.parentOccurrenceIndex,
      name: getTagValue(ownFieldsText, "name"),
      actionType: getTagValue(ownFieldsText, "actionType"),
      parentStep: getTagValue(ownFieldsText, "parentStep"),
      sequenceNumber: getTagValue(ownFieldsText, "sequenceNumber"),
      start: rec.tagStart,
      end: rec.end,
      content,
      full,
    });
  }
  return nodes;
}

/** `<customElement>...</customElement>` blocks directly inside a step's full XML. */
export function extractCustomElementBlocks(stepFullXml: string): string[] {
  return extractFlatBlocks(stepFullXml, "customElement");
}

/**
 * `<parameters>` blocks in `stepFullXml` that are NOT nested inside a
 * `<customElement>` — i.e. the step's own direct bindings. Needed because
 * some parameters (e.g. PriceAdjustmentScheduleId) are only valid when
 * nested inside `<customElement>`, and patches must never touch those.
 */
export function getTopLevelParameterBlocks(stepFullXml: string): { block: string; start: number; end: number }[] {
  const customSpans: { start: number; end: number }[] = [];
  const ceRe = /<customElement(?:\s[^>]*)?>[\s\S]*?<\/customElement>/g;
  let m: RegExpExecArray | null;
  while ((m = ceRe.exec(stepFullXml))) customSpans.push({ start: m.index, end: m.index + m[0].length });

  const results: { block: string; start: number; end: number }[] = [];
  const pRe = /<parameters>[\s\S]*?<\/parameters>/g;
  while ((m = pRe.exec(stepFullXml))) {
    const start = m.index;
    const end = m.index + m[0].length;
    const insideCustom = customSpans.some(s => start >= s.start && end <= s.end);
    if (!insideCustom) results.push({ block: m[0], start, end });
  }
  return results;
}

export function getParamName(paramBlock: string): string | null {
  return getTagValue(paramBlock, "name");
}
export function getParamValue(paramBlock: string): string | null {
  return getTagValue(paramBlock, "value");
}
export function isInputParam(paramBlock: string): boolean {
  return getTagValue(paramBlock, "input") === "true";
}
export function isOutputParam(paramBlock: string): boolean {
  return getTagValue(paramBlock, "output") === "true";
}

/** Replace (or insert, if absent) `<value>` inside a single parameters block. */
export function setParamValue(paramBlock: string, newValue: string): string {
  if (/<value>[\s\S]*?<\/value>/.test(paramBlock)) {
    return paramBlock.replace(/<value>[\s\S]*?<\/value>/, `<value>${newValue}</value>`);
  }
  return paramBlock.replace(/<\/parameters>$/, `<value>${newValue}</value></parameters>`);
}

/** Remove every top-level `<parameters>` block in `stepFullXml` for which `shouldRemove` returns true, leaving `<customElement>`-nested ones untouched. */
export function removeTopLevelParameters(stepFullXml: string, shouldRemove: (paramBlock: string) => boolean): string {
  const blocks = getTopLevelParameterBlocks(stepFullXml);
  let result = stepFullXml;
  // Remove from the end backwards so earlier indices stay valid.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (shouldRemove(b.block)) {
      result = result.slice(0, b.start) + result.slice(b.end);
    }
  }
  return result;
}

/** Build a new `<parameters>` block in the canonical alphabetical field order Salesforce's own serializer uses. */
export function buildParameterBlock(opts: { name: string; value: string; type?: string; input?: boolean; output?: boolean }): string {
  const fields: string[] = [];
  if (opts.input !== undefined) fields.push(`<input>${opts.input}</input>`);
  fields.push(`<name>${opts.name}</name>`);
  if (opts.output !== undefined) fields.push(`<output>${opts.output}</output>`);
  fields.push(`<type>${opts.type ?? "Parameter"}</type>`);
  fields.push(`<value>${opts.value}</value>`);
  return `<parameters>${fields.join("")}</parameters>`;
}

/** Insert a new parameters block after the last existing top-level one, else before `<customElement>`, else before the closing `</steps>`. */
export function insertParameterIntoStep(stepFullXml: string, newParamBlockXml: string): string {
  const topLevel = getTopLevelParameterBlocks(stepFullXml);
  if (topLevel.length > 0) {
    const lastEnd = topLevel[topLevel.length - 1].end;
    return stepFullXml.slice(0, lastEnd) + newParamBlockXml + stepFullXml.slice(lastEnd);
  }
  const customElIdx = stepFullXml.indexOf("<customElement");
  if (customElIdx !== -1) {
    return stepFullXml.slice(0, customElIdx) + newParamBlockXml + stepFullXml.slice(customElIdx);
  }
  const closeIdx = stepFullXml.lastIndexOf("</steps>");
  if (closeIdx === -1) return stepFullXml + newParamBlockXml;
  return stepFullXml.slice(0, closeIdx) + newParamBlockXml + stepFullXml.slice(closeIdx);
}

export function stepInner(stepFullXml: string): string {
  return stepFullXml.replace(/^<steps(?:\s[^>]*)?>/, "").replace(/<\/steps>\s*$/, "");
}
export function wrapStep(innerXml: string): string {
  return `<steps>${innerXml}</steps>`;
}

/** Every `<name>` value anywhere in a block, top-level or nested — used for the leakage scan (known product-literal attribute names must never survive into the deployed XML). */
export function allNameValuesDeep(xmlBlock: string): string[] {
  return getAllTagValues(xmlBlock, "name");
}

/** From a set of (possibly nested) spans, keep only the ones not contained inside another span in the same set — i.e. the outermost element at each position. Removing exactly these spans (highest `start` first) from the source string is always safe, since child spans are removed as part of removing their parent's range. */
export function outermostSpans(spans: ElementSpan[]): ElementSpan[] {
  return spans.filter(s => !spans.some(o => o !== s && o.start <= s.start && o.end >= s.end));
}

export interface RootElementInfo {
  tagName: string;
  attributes: Record<string, string>;
  /** Immediate (depth-0) child element tag names, in document order, including duplicates (e.g. multiple `<steps>`) — a structural fingerprint of the root element's schema shape, not its content. */
  childOrder: string[];
}

/** Every depth-0 opening tag name inside `content`, in document order — walks the whole string tracking nesting depth generically. Exported so the same generic logic can compare a single `<steps>` element's own direct children too — see schemaDiff.ts's `compareStepStructure`. */
export function scanImmediateChildTags(content: string): string[] {
  const tagRe = /<\/?([A-Za-z][\w:-]*)(?:\s[^>]*)?(\/?)>/g;
  const order: string[] = [];
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content))) {
    const isClosing = m[0].startsWith("</");
    const isSelfClosing = m[2] === "/";
    if (isClosing) {
      depth = Math.max(0, depth - 1);
    } else {
      if (depth === 0) order.push(m[1]);
      if (!isSelfClosing) depth++;
    }
  }
  return order;
}

/** Parse an XML document's root element: tag name, attributes (incl. namespaces), and the ordered list of its immediate children's tag names. Returns null if no root element is found. */
export function parseRootElement(xml: string): RootElementInfo | null {
  const openMatch = xml.match(/<([A-Za-z][\w:-]*)((?:\s[^>]*)?)>/);
  if (!openMatch || openMatch.index === undefined) return null;
  const tagName = openMatch[1];
  const attrsRaw = openMatch[2];
  const attributes: Record<string, string> = {};
  const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(attrsRaw))) attributes[am[1]] = am[2];

  const rootSpans = extractElementSpans(xml, tagName);
  const root = rootSpans.find(s => s.start === openMatch.index) ?? rootSpans[0];
  if (!root) return null;

  return { tagName, attributes, childOrder: scanImmediateChildTags(root.content) };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
