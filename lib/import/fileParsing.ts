import Papa from "papaparse";
import * as XLSX from "xlsx";
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS } from "./limits";

/**
 * Shared CSV/XLSX/XLS parsing for every bulk importer (Products, Quotes,
 * Contracts, Orders) — extracted from the original Product importer's parse
 * route (app/api/sf/products/import/parse/route.ts) so file parsing is
 * written once. Column *meaning* (what a header maps to) is entirely
 * module-specific and lives elsewhere; this module only turns a raw upload
 * into headers + string rows.
 */

export { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS };

export interface ParsedImportFile {
  fileName: string;
  fileSize: number;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  /** True if the file had more than IMPORT_MAX_ROWS data rows — only the first IMPORT_MAX_ROWS were kept. */
  truncated: boolean;
  totalRowsInFile: number;
}

export type ParseImportFileResult =
  | { ok: true; data: ParsedImportFile }
  | { ok: false; error: string; status: number };

function toStringCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transform: v => (v ?? "").trim() });
  const headers = (parsed.meta.fields ?? []).map(h => h.trim()).filter(Boolean);
  const rows = parsed.data.filter(row => Object.values(row).some(v => (v ?? "").toString().trim() !== ""));
  return { headers, rows };
}

function parseWorkbook(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  const headers = raw.length > 0 ? Object.keys(raw[0]).map(h => h.trim()).filter(Boolean) : [];
  const rows = raw
    .map(r => Object.fromEntries(headers.map(h => [h, toStringCell(r[h])])))
    .filter(row => Object.values(row).some(v => v !== ""));
  return { headers, rows };
}

/** Parses the `file` field of an upload FormData into headers/rows, enforcing size/type/row-count limits. Never throws — every failure comes back as `{ ok: false }` with a user-facing message. */
export async function parseImportFormData(form: FormData): Promise<ParseImportFileResult> {
  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "A file is required.", status: 400 };
  }
  if (file.size === 0) {
    return { ok: false, error: "The uploaded file is empty.", status: 400 };
  }
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    return { ok: false, error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum supported size is ${IMPORT_MAX_FILE_BYTES / 1024 / 1024}MB.`, status: 400 };
  }

  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(ext)) {
    return { ok: false, error: `Unsupported file type "${ext || "unknown"}". Please upload a .csv, .xlsx, or .xls file.`, status: 400 };
  }

  let parsed: { headers: string[]; rows: Record<string, string>[] };
  try {
    if (ext === "csv") {
      const text = await file.text();
      parsed = parseCsv(text);
    } else {
      const buffer = Buffer.from(await file.arrayBuffer());
      parsed = parseWorkbook(buffer);
    }
  } catch (err) {
    return { ok: false, error: `Could not read this file: ${err instanceof Error ? err.message : "unknown parsing error"}. Make sure it's a valid ${ext.toUpperCase()} file.`, status: 400 };
  }

  if (parsed.headers.length === 0) {
    return { ok: false, error: "No column headers were found in the first row of this file.", status: 400 };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, error: "No data rows were found below the header row.", status: 400 };
  }

  const totalRowsInFile = parsed.rows.length;
  const truncated = totalRowsInFile > IMPORT_MAX_ROWS;
  const rows = truncated ? parsed.rows.slice(0, IMPORT_MAX_ROWS) : parsed.rows;

  return {
    ok: true,
    data: {
      fileName: file.name,
      fileSize: file.size,
      headers: parsed.headers,
      rows,
      rowCount: rows.length,
      truncated,
      totalRowsInFile,
    },
  };
}
