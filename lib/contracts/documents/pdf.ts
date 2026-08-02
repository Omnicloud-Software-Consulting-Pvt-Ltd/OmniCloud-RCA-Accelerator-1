import React from "react";
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { BrandingConfig, MergeFieldValues } from "@/lib/contracts/types";
import { substituteMergeFields } from "@/lib/contracts/documents/mergeFields";
import { parseHtmlToPdfBlocks, type PdfBlock, type PdfTextRun } from "@/lib/contracts/documents/pdfTagConverter";
import { renderFooterElements } from "@/lib/contracts/documents/render";

/**
 * PDF generation via @react-pdf/renderer (§4.3) — NOT an HTML renderer.
 * Consumes only the block set lib/contracts/documents/pdfTagConverter.ts
 * extracts (headings/paragraphs/lists/tables/images/page breaks); applies
 * the SAME BrandingConfig the HTML preview uses (render.ts) so the two can
 * never drift. Plain React.createElement (not JSX) so this stays a .ts file,
 * matching the rest of lib/'s convention.
 */

const PAGE_SIZE_MAP: Record<BrandingConfig["pageSize"], "A4" | "LETTER" | "LEGAL"> = { A4: "A4", Letter: "LETTER", Legal: "LEGAL" };

function styles(branding: BrandingConfig) {
  const m = branding.pageMargins;
  return StyleSheet.create({
    page: { paddingTop: m.top, paddingRight: m.right, paddingBottom: m.bottom, paddingLeft: m.left, fontSize: branding.fontSize, lineHeight: branding.lineHeight, color: branding.textColor, backgroundColor: branding.pageBackground },
    h1: { fontSize: branding.fontSize + 9, fontWeight: 700, marginBottom: 10 },
    h2: { fontSize: branding.fontSize + 3, fontWeight: 700, marginTop: 14, marginBottom: 6 },
    h3: { fontSize: branding.fontSize + 1, fontWeight: 700, marginTop: 10, marginBottom: 4 },
    p: { marginBottom: 8 },
    listItem: { flexDirection: "row", marginBottom: 4 },
    bullet: { width: 14 },
    table: { marginBottom: 10, borderWidth: 1, borderColor: "#ccc" },
    tableRow: { flexDirection: "row" },
    tableCell: { flex: 1, padding: 5, borderWidth: 0.5, borderColor: "#ccc", fontSize: branding.fontSize - 1 },
    tableHeaderCell: { flex: 1, padding: 5, borderWidth: 0.5, borderColor: "#ccc", fontSize: branding.fontSize - 1, fontWeight: 700, backgroundColor: "#f2f2f2" },
    image: { marginBottom: 10, maxWidth: "100%" },
    headerBar: { borderBottomWidth: 2, marginBottom: 16, paddingBottom: 10, flexDirection: "row", alignItems: "center" },
    headerText: { fontSize: 14, fontWeight: 700 },
    footer: { position: "absolute", bottom: 30, left: m.left, right: m.right, fontSize: 9, color: "#666", borderTopWidth: 1, borderTopColor: "#ddd", paddingTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  });
}

function runStyle(run: PdfTextRun) {
  if (run.bold && run.italic) return { fontWeight: 700 as const, fontStyle: "italic" as const };
  if (run.bold) return { fontWeight: 700 as const };
  if (run.italic) return { fontStyle: "italic" as const };
  return undefined;
}

/** Each run becomes its own nested <Text> so bold/italic apply per-run within one visual line — react-pdf composes nested Text elements' styles independently. */
function runsText(lines: PdfTextRun[][], key: string) {
  const children: React.ReactNode[] = [];
  lines.forEach((line, li) => {
    line.forEach((run, ri) => {
      children.push(React.createElement(Text, { key: `${key}-${li}-${ri}`, style: runStyle(run) }, run.text));
    });
    if (li < lines.length - 1) children.push(React.createElement(Text, { key: `${key}-${li}-br` }, "\n"));
  });
  return children;
}

function renderBlock(block: PdfBlock, index: number, s: ReturnType<typeof styles>): React.ReactNode {
  const key = `block-${index}`;
  switch (block.kind) {
    case "heading":
      return React.createElement(Text, { key, style: block.level === 1 ? s.h1 : block.level === 2 ? s.h2 : s.h3 }, runsText(block.lines, key));
    case "paragraph":
      return React.createElement(Text, { key, style: s.p }, runsText(block.lines, key));
    case "list":
      return React.createElement(
        View, { key, style: { marginBottom: 8 } },
        block.items.map((item, i) => React.createElement(
          View, { key: `${key}-item-${i}`, style: s.listItem },
          React.createElement(Text, { style: s.bullet }, block.ordered ? `${i + 1}.` : "•"),
          React.createElement(Text, { style: { flex: 1 } }, runsText(item, `${key}-${i}`)),
        )),
      );
    case "table":
      return React.createElement(
        View, { key, style: s.table },
        block.rows.map((row, ri) => React.createElement(
          View, { key: `${key}-row-${ri}`, style: s.tableRow },
          row.cells.map((cell, ci) => React.createElement(
            Text, { key: `${key}-cell-${ri}-${ci}`, style: row.header ? s.tableHeaderCell : s.tableCell }, runsText(cell, `${key}-${ri}-${ci}`),
          )),
        )),
      );
    case "image":
      return React.createElement(Image, { key, src: block.src, style: s.image });
    case "pagebreak":
      return React.createElement(View, { key, break: true });
    default:
      return null;
  }
}

export async function renderContractPdf(bodyHtml: string, branding: BrandingConfig, values: MergeFieldValues): Promise<Buffer> {
  const merged = substituteMergeFields(bodyHtml, values);
  const blocks = parseHtmlToPdfBlocks(merged);
  const s = styles(branding);
  const footerLabels = renderFooterElements(branding);

  const headerChildren: React.ReactNode[] = [];
  if (branding.logoUrl) headerChildren.push(React.createElement(Image, { key: "logo", src: branding.logoUrl, style: { width: branding.logoWidth, height: branding.logoMaintainAspectRatio ? undefined : branding.logoHeight, marginRight: 10 } }));
  headerChildren.push(React.createElement(Text, { key: "name", style: [s.headerText, { color: branding.primaryColor }] }, branding.companyName));

  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: PAGE_SIZE_MAP[branding.pageSize], orientation: branding.orientation, style: [s.page, { fontFamily: branding.font }] },
      React.createElement(View, { style: [s.headerBar, { borderBottomColor: branding.primaryColor, justifyContent: branding.logoPosition === "center" ? "center" : branding.logoPosition === "right" ? "flex-end" : "flex-start" }] }, headerChildren),
      ...blocks.map((b, i) => renderBlock(b, i, s)),
      React.createElement(
        View,
        { style: s.footer, fixed: true },
        ...footerLabels.map((label, i) => React.createElement(Text, { key: `footer-${i}` }, label)),
        React.createElement(Text, {
          render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
        }),
      ),
    ),
  );

  return renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
}
