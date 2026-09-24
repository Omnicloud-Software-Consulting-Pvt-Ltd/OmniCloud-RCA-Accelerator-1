"use client";

import { Ic, tokens } from "@/components/data/quotes/shared";

/**
 * Compact "currently importing X" reminder shown on the Mapping/Preview/
 * Create steps (the rich file-review UI — components/import/
 * ImportUploadReview.tsx — already covers the Upload step itself, so this
 * strip only needs to exist once the user has moved past it). Extracted from
 * six identical inline copies, one per importer.
 */
export default function ImportFileStrip({
  isDark, fileName, fileSize, rowCount, totalRowsInFile, truncated, onReplace,
}: {
  isDark: boolean;
  fileName: string;
  fileSize: number;
  rowCount: number;
  totalRowsInFile: number;
  truncated: boolean;
  onReplace: () => void;
}) {
  const t = tokens(isDark);
  return (
    <div className="flex items-center gap-3 mb-2" style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
      <Ic n="file-text" s={14} />
      <span style={{ fontSize: 12, fontWeight: 600, color: t.heading }}>{fileName}</span>
      <span style={{ fontSize: 11, color: t.dim }}>
        {(fileSize / 1024).toFixed(1)} KB · {rowCount} row{rowCount === 1 ? "" : "s"} detected{truncated ? ` (of ${totalRowsInFile})` : ""}
      </span>
      <button onClick={onReplace} style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 600, color: t.accent, background: "transparent", border: "none", cursor: "pointer" }}>
        Replace File
      </button>
    </div>
  );
}
