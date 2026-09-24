"use client";

import { useState } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";

const PAGE_SIZE = 10;

/**
 * Read-only table of the actual parsed rows/columns — the "what did I
 * upload?" view called for before mapping/validation happens. Renders
 * exactly the `headers`/`rows` the parse endpoint already returned (see
 * lib/import/fileParsing.ts's ParsedImportFile — Papa Parse for CSV, SheetJS
 * for XLSX/XLS, both pre-existing); this component never re-parses the file
 * and never mutates a cell, column name, or row — it only paginates the
 * in-memory array client-side so a large file doesn't render all at once.
 */
export default function ImportFilePreview({
  isDark, headers, rows, totalRowsInFile, truncated,
}: {
  isDark: boolean;
  headers: string[];
  rows: Record<string, string>[];
  totalRowsInFile: number;
  truncated: boolean;
}) {
  const t = tokens(isDark);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim }}>File Preview</p>
        <p style={{ fontSize: 11, color: t.dim }}>
          Showing {rows.length === 0 ? 0 : start + 1}–{Math.min(start + PAGE_SIZE, rows.length)} of {rows.length}{truncated ? ` (of ${totalRowsInFile} in file)` : ""} rows
        </p>
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, overflow: "auto", maxWidth: "100%" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: t.surfaceAlt }}>
              <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, whiteSpace: "nowrap" }}>Row</th>
              {headers.map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr key={start + i} style={{ borderTop: `1px solid ${t.border}` }}>
                <td style={{ padding: "7px 12px", color: t.dim, whiteSpace: "nowrap" }}>{start + i + 1}</td>
                {headers.map(h => (
                  <td key={h} title={row[h] ?? ""} style={{ padding: "7px 12px", color: t.body, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row[h] || <span style={{ color: t.dim }}>—</span>}
                  </td>
                ))}
              </tr>
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={headers.length + 1} style={{ padding: "16px 12px", color: t.dim, textAlign: "center" }}>No rows to show.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 8 }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: "transparent", color: page === 0 ? t.dim : t.body, cursor: page === 0 ? "not-allowed" : "pointer", opacity: page === 0 ? 0.5 : 1 }}
          >
            <Ic n="chevron-left" s={12} /> Previous
          </button>
          <span style={{ fontSize: 11.5, color: t.dim }}>Page {page + 1} of {pageCount}</span>
          <button
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            aria-label="Next page"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: "transparent", color: page >= pageCount - 1 ? t.dim : t.body, cursor: page >= pageCount - 1 ? "not-allowed" : "pointer", opacity: page >= pageCount - 1 ? 0.5 : 1 }}
          >
            Next <Ic n="chevron-right" s={12} />
          </button>
        </div>
      )}
    </div>
  );
}
