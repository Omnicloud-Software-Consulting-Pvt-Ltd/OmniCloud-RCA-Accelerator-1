import mammoth from "mammoth";

/**
 * DOCX → editable HTML conversion (§Upload Template "Automatically convert
 * into editable templates where possible"). Uses mammoth's default style
 * map, which maps Word's built-in Heading 1-3 / bold / italic / bullet /
 * numbered-list / table styles onto plain h1-h3/strong/em/ul/ol/li/table —
 * exactly the Template Studio's own recognized tag set (pdfTagConverter.ts),
 * so a converted DOCX renders in the PDF/DOCX regenerator immediately, not
 * just the HTML preview. Anything mammoth couldn't map comes back as a
 * warning message rather than being silently dropped.
 */
export interface DocxConversionResult {
  html: string;
  warnings: string[];
}

export async function convertDocxToHtml(buffer: Buffer): Promise<DocxConversionResult> {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Title'] => h1:fresh",
      ],
    },
  );
  return {
    html: result.value,
    warnings: result.messages.map(m => m.message),
  };
}

/** PDF/HTML are not natively convertible to editable rich text here (§Upload Template disclosed limitation) — stored as a browsable/downloadable attachment only, same as before this feature. */
export function isConvertibleUpload(mime: string, filename: string): boolean {
  return mime.includes("wordprocessingml") || /\.docx$/i.test(filename) || mime === "text/html" || /\.html?$/i.test(filename);
}
