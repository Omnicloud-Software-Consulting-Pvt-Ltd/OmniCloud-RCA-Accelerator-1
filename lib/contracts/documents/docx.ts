import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  ImageRun, PageBreak, AlignmentType, WidthType, Header, Footer, convertInchesToTwip,
} from "docx";
import type { BrandingConfig, MergeFieldValues } from "@/lib/contracts/types";
import { substituteMergeFields } from "@/lib/contracts/documents/mergeFields";
import { parseHtmlToPdfBlocks, type PdfBlock, type PdfTextRun } from "@/lib/contracts/documents/pdfTagConverter";
import { renderFooterElements } from "@/lib/contracts/documents/render";

/**
 * DOCX generation via the `docx` package (§Template Actions "Generate DOCX")
 * — consumes the SAME block model as the PDF renderer
 * (pdfTagConverter.ts's parseHtmlToPdfBlocks) so PDF and DOCX output can
 * never structurally diverge; only the rendering primitives differ.
 */

const HEADING_LEVEL: Record<1 | 2 | 3, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

function runsToTextRuns(lines: PdfTextRun[][], color: string): (TextRun | Paragraph)[] {
  const children: TextRun[] = [];
  lines.forEach((line, li) => {
    line.forEach(run => children.push(new TextRun({ text: run.text, bold: run.bold, italics: run.italic, color })));
    if (li < lines.length - 1) children.push(new TextRun({ break: 1 }));
  });
  return children;
}

function blockToDocxElements(block: PdfBlock, branding: BrandingConfig): (Paragraph | Table)[] {
  const color = branding.textColor.replace("#", "");
  switch (block.kind) {
    case "heading":
      return [new Paragraph({ heading: HEADING_LEVEL[block.level], children: runsToTextRuns(block.lines, color) as TextRun[] })];
    case "paragraph":
      return [new Paragraph({ children: runsToTextRuns(block.lines, color) as TextRun[], spacing: { after: 160 } })];
    case "list":
      return block.items.map(item => new Paragraph({
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: "template-numbering", level: 0 } : undefined,
        children: runsToTextRuns(item, color) as TextRun[],
      }));
    case "table":
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map(row => new TableRow({
          children: row.cells.map(cell => new TableCell({
            children: [new Paragraph({ children: runsToTextRuns(cell, color) as TextRun[] })],
            shading: row.header ? { fill: "F2F2F2" } : undefined,
          })),
        })),
      })];
    case "image":
      try {
        const base64 = block.src.startsWith("data:") ? block.src.split(",")[1] : null;
        if (!base64) return []; // remote-URL images aren't fetched at generation time — only data-URI images inserted via the editor's own uploader are supported here.
        return [new Paragraph({ children: [new ImageRun({ data: Buffer.from(base64, "base64"), transformation: { width: 300, height: 200 }, type: "png" })] })];
      } catch {
        return [];
      }
    case "pagebreak":
      return [new Paragraph({ children: [new PageBreak()] })];
    default:
      return [];
  }
}

export async function renderContractDocx(bodyHtml: string, branding: BrandingConfig, values: MergeFieldValues): Promise<Buffer> {
  const merged = substituteMergeFields(bodyHtml, values);
  const blocks = parseHtmlToPdfBlocks(merged);
  const footerLabels = renderFooterElements(branding);
  const alignment = branding.logoPosition === "center" ? AlignmentType.CENTER : branding.logoPosition === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const doc = new Document({
    numbering: { config: [{ reference: "template-numbering", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }] }] },
    sections: [{
      properties: {
        page: {
          size: { orientation: branding.orientation },
          margin: {
            top: convertInchesToTwip(branding.pageMargins.top / 72),
            right: convertInchesToTwip(branding.pageMargins.right / 72),
            bottom: convertInchesToTwip(branding.pageMargins.bottom / 72),
            left: convertInchesToTwip(branding.pageMargins.left / 72),
          },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({ alignment, children: [new TextRun({ text: branding.companyName, bold: true, color: branding.primaryColor.replace("#", "") })] })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({ children: [new TextRun({ text: footerLabels.join("  |  "), size: 16, color: "999999" })] })],
        }),
      },
      children: blocks.flatMap(b => blockToDocxElements(b, branding)),
    }],
  });

  return Packer.toBuffer(doc);
}
