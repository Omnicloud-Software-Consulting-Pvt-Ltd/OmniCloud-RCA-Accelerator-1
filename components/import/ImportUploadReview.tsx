"use client";

import { tokens, PrimaryButton } from "@/components/data/quotes/shared";
import type { ImportFieldDef } from "@/lib/import/columnMapping";
import ImportFileSummary from "./ImportFileSummary";
import ImportValidationSummary, { type ImportCheck } from "./ImportValidationSummary";
import ImportFilePreview from "./ImportFilePreview";

function detectKindLabel(fileName: string): string {
  return /\.(xlsx|xls)$/i.test(fileName) ? "Excel Workbook" : "CSV File";
}

/**
 * The "you uploaded this — here's what's in it" review screen shown on the
 * Upload step once a file has parsed successfully, before the user commits
 * to Column Mapping (§ file-preview requirement). Composes the file summary
 * card, a structural validation checklist, and the actual-rows preview table
 * — all read-only views over the SAME parse response
 * (lib/import/fileParsing.ts's ParsedImportFile) every importer already
 * received; nothing here re-parses the file or changes what gets sent to
 * `.../import/validate`. `fields`/`mapping` are each module's own existing
 * ImportFieldDef[] and auto-suggested mapping record — reused, not
 * reimplemented, purely to render "which required columns were found".
 */
export default function ImportUploadReview<K extends string>({
  isDark, fileName, fileSize, headers, rows, rowCount, totalRowsInFile, truncated,
  fields, mapping, continueLabel = "Continue to Column Mapping", onContinue, onReplace, onRemove,
}: {
  isDark: boolean;
  fileName: string;
  fileSize: number;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  totalRowsInFile: number;
  truncated: boolean;
  fields: ImportFieldDef<K>[];
  mapping: Record<K, string | null>;
  continueLabel?: string;
  onContinue: () => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const t = tokens(isDark);
  const kindLabel = detectKindLabel(fileName);

  const requiredChecks: ImportCheck[] = fields.filter(f => f.required).map(f => ({
    id: f.key,
    label: mapping[f.key] ? `Required column "${f.label}" found` : `Required column "${f.label}" wasn't auto-detected — you can map it manually in the next step`,
    status: mapping[f.key] ? "ok" : "warning",
  }));
  const checks: ImportCheck[] = [
    { id: "format", label: `File format supported (${kindLabel})`, status: "ok" },
    { id: "rows", label: `${rowCount} row${rowCount === 1 ? "" : "s"} detected`, status: rowCount > 0 ? "ok" : "error" },
    { id: "columns", label: `${headers.length} column${headers.length === 1 ? "" : "s"} detected`, status: headers.length > 0 ? "ok" : "error" },
    ...requiredChecks,
  ];
  const hasBlockingError = checks.some(c => c.status === "error");

  return (
    <div style={{ padding: "0 24px 24px", maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}>
      <ImportFileSummary
        isDark={isDark} fileName={fileName} fileSize={fileSize} kindLabel={kindLabel}
        rowCount={rowCount} columnCount={headers.length} totalRowsInFile={totalRowsInFile} truncated={truncated}
        onReplace={onReplace} onRemove={onRemove}
      />
      <ImportValidationSummary isDark={isDark} checks={checks} />
      <ImportFilePreview isDark={isDark} headers={headers} rows={rows} totalRowsInFile={totalRowsInFile} truncated={truncated} />

      <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
        {hasBlockingError ? (
          <span style={{ fontSize: 12, color: t.error }}>This file has no usable rows or columns — upload a different file to continue.</span>
        ) : <span />}
        <PrimaryButton isDark={isDark} label={continueLabel} icon="arrow-right" disabled={hasBlockingError} onClick={onContinue} />
      </div>
    </div>
  );
}
