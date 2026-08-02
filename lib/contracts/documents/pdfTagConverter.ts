/**
 * Narrow, explicit HTML→PDF-primitive converter (§4.3, extended for the
 * Template Studio's richer editor). The PDF renderer (@react-pdf/renderer)
 * does NOT render arbitrary HTML — it only recognizes the tag set below,
 * matched at the TOP LEVEL of the body (the shape the Studio's own editor
 * actually produces: flat headings/paragraphs/lists/tables/images/page
 * breaks, never deeply nested custom markup). Any other tag renders fine in
 * the HTML preview but is silently absent from the generated PDF/DOCX unless
 * surfaced as a warning elsewhere (see findUnrecognizedTags).
 */

export const RECOGNIZED_TAGS = new Set(["h1", "h2", "h3", "p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "table", "tr", "td", "th", "img", "hr"]);

export interface PdfTextRun {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type PdfBlock =
  | { kind: "heading"; level: 1 | 2 | 3; lines: PdfTextRun[][] }
  | { kind: "paragraph"; lines: PdfTextRun[][] }
  | { kind: "list"; ordered: boolean; items: PdfTextRun[][][] }
  | { kind: "table"; rows: { cells: PdfTextRun[][][]; header: boolean }[] }
  | { kind: "image"; src: string }
  | { kind: "pagebreak" };

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** Split inline HTML on <br> into visual lines, each a run-list of bold/italic-tagged text. */
function parseInline(html: string): PdfTextRun[][] {
  const brParts = html.split(/<br\s*\/?>/gi);
  return brParts.map(part => {
    const runs: PdfTextRun[] = [];
    const re = /<(strong|b)>([\s\S]*?)<\/\1>|<(em|i)>([\s\S]*?)<\/\3>|([^<]+)|<[^>]+>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      if (m[2] != null) runs.push({ text: decodeEntities(m[2]), bold: true, italic: false });
      else if (m[4] != null) runs.push({ text: decodeEntities(m[4]), bold: false, italic: true });
      else if (m[5] != null) {
        const text = decodeEntities(m[5]);
        if (text.trim().length > 0 || runs.length > 0) runs.push({ text, bold: false, italic: false });
      }
      // Any other tag matched by the final alternative is intentionally dropped —
      // it's an unrecognized tag, already surfaced as a warning by findUnrecognizedTags.
    }
    return runs;
  });
}

function parseListItems(listHtml: string): PdfTextRun[][][] {
  const items: PdfTextRun[][][] = [];
  const re = /<li>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(listHtml))) items.push(parseInline(m[1]));
  return items;
}

function parseTableRows(tableHtml: string): { cells: PdfTextRun[][][]; header: boolean }[] {
  const rows: { cells: PdfTextRun[][][]; header: boolean }[] = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(tableHtml))) {
    const rowHtml = rm[1];
    const cells: PdfTextRun[][][] = [];
    let header = false;
    const cellRe = /<(td|th)>([\s\S]*?)<\/\1>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowHtml))) {
      if (cm[1].toLowerCase() === "th") header = true;
      cells.push(parseInline(cm[2]));
    }
    rows.push({ cells, header });
  }
  return rows;
}

/**
 * Extract top-level blocks in document order — headings, paragraphs, lists,
 * tables, images, and page breaks. Everything else in the body is dropped
 * from the PDF/DOCX (§4.3's disclosed limitation), surfaced via
 * findUnrecognizedTags rather than silently.
 */
export function parseHtmlToPdfBlocks(bodyHtml: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const re = /<(h1|h2|h3|p)>([\s\S]*?)<\/\1>|<(ul|ol)>([\s\S]*?)<\/\3>|<table>([\s\S]*?)<\/table>|<img[^>]*\bsrc=["']([^"']*)["'][^>]*>|<hr\b[^>]*\bclass=["'][^"']*pdf-pagebreak[^"']*["'][^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const lines = parseInline(m[2]);
      if (tag === "p") blocks.push({ kind: "paragraph", lines });
      else blocks.push({ kind: "heading", level: Number(tag[1]) as 1 | 2 | 3, lines });
    } else if (m[3]) {
      blocks.push({ kind: "list", ordered: m[3].toLowerCase() === "ol", items: parseListItems(m[4]) });
    } else if (m[5] != null) {
      blocks.push({ kind: "table", rows: parseTableRows(m[5]) });
    } else if (m[6] != null) {
      blocks.push({ kind: "image", src: m[6] });
    } else {
      blocks.push({ kind: "pagebreak" });
    }
  }
  return blocks;
}

/** Every HTML tag in the body NOT in the recognized set — surfaced as a visible warning in the template customization UI (§4.3), never silently hidden. */
export function findUnrecognizedTags(bodyHtml: string): string[] {
  const found = new Set<string>();
  const re = /<\/?([a-zA-Z0-9]+)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) {
    const tag = m[1].toLowerCase();
    if (!RECOGNIZED_TAGS.has(tag)) found.add(tag);
  }
  return [...found];
}
