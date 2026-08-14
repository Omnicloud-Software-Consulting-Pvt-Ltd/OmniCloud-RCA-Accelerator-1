"use client";

import { Ic, tokens, GhostButton } from "@/components/data/quotes/shared";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Post-upload "what did I actually upload?" metadata card — the file-review
 * counterpart to the empty drag-and-drop zone (components/import/
 * ImportUploadStep.tsx). Purely informational: it renders fields the parse
 * response (lib/import/fileParsing.ts's ParsedImportFile, unchanged) already
 * carries — fileName/fileSize/headers.length/rowCount/totalRowsInFile/
 * truncated — it never re-parses or alters anything.
 */
export default function ImportFileSummary({
  isDark, fileName, fileSize, kindLabel, rowCount, columnCount, totalRowsInFile, truncated, onReplace, onRemove,
}: {
  isDark: boolean;
  fileName: string;
  fileSize: number;
  kindLabel: string;
  rowCount: number;
  columnCount: number;
  totalRowsInFile: number;
  truncated: boolean;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const t = tokens(isDark);
  return (
    <div style={{ borderRadius: 14, border: `1px solid rgba(34,197,94,0.35)`, background: isDark ? "rgba(34,197,94,0.06)" : "rgba(34,197,94,0.05)", padding: "14px 16px" }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 10, color: "#22C55E", fontSize: 12, fontWeight: 700 }}>
        <Ic n="check-circle" s={15} /> File uploaded — ready to import
      </div>
      <div className="flex items-start justify-between gap-4" style={{ flexWrap: "wrap" }}>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", background: `${t.accent}18`, border: `1px solid ${t.accent}30`, color: t.accent, flexShrink: 0 }}>
            <Ic n="file-text" s={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fileName}</div>
            <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>
              {kindLabel} · {rowCount} row{rowCount === 1 ? "" : "s"} · {columnCount} column{columnCount === 1 ? "" : "s"} · {formatBytes(fileSize)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <GhostButton isDark={isDark} label="Replace File" icon="refresh" onClick={onReplace} />
          <GhostButton isDark={isDark} label="Remove" icon="trash" danger onClick={onRemove} />
        </div>
      </div>
      {truncated && (
        <div className="flex items-start gap-2" style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${t.border}`, fontSize: 11.5, color: t.warn }}>
          <Ic n="alert" s={13} />
          <span>This file has {totalRowsInFile} rows — only the first {rowCount} will be imported. Split large files into batches to import the rest.</span>
        </div>
      )}
    </div>
  );
}
