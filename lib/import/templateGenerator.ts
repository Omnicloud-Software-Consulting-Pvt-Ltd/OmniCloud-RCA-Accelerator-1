import * as XLSX from "xlsx";
import Papa from "papaparse";
import type { ImportFieldDef, ImportToolkitConfig } from "./columnMapping";

/**
 * Turns a module's own canonical field list + example rows (the exact same
 * arrays the Import Toolkit renders and the mapping engine matches against)
 * into a downloadable template — so the Toolkit, the mapping/validation,
 * and the template can never drift apart (§22 "one source of truth").
 * Column headers are each field's `label`, which every module's alias list
 * already recognizes on re-upload.
 */
function toAoa<K extends string>(fields: ImportFieldDef<K>[], config: ImportToolkitConfig<K>): string[][] {
  const headers = fields.map(f => f.label);
  const rows = config.exampleRows.map(row => fields.map(f => row[f.key] ?? ""));
  return [headers, ...rows];
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadExcelTemplate<K extends string>(fields: ImportFieldDef<K>[], config: ImportToolkitConfig<K>, filename: string) {
  const worksheet = XLSX.utils.aoa_to_sheet(toAoa(fields, config));
  worksheet["!cols"] = fields.map(f => ({ wch: Math.max(12, f.label.length + 2) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, config.moduleLabel.replace(/[^\w ]/g, "").slice(0, 31) || "Template");
  XLSX.writeFile(workbook, filename);
}

export function downloadCsvTemplate<K extends string>(fields: ImportFieldDef<K>[], config: ImportToolkitConfig<K>, filename: string) {
  const csv = Papa.unparse(toAoa(fields, config));
  triggerBlobDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), filename);
}
