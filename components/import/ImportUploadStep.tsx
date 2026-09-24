"use client";

import { useRef, useState } from "react";
import { Ic, tokens, ErrorPanel, Spinner, type ErrorPanelData } from "@/components/data/quotes/shared";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/import/limits";

const ACCEPTED_EXT = [".csv", ".xlsx", ".xls"];
const MAX_SIZE_LABEL = `${Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024)} MB`;

export interface GenericParseResponse {
  success: true;
  fileName: string;
  fileSize: number;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  truncated: boolean;
  totalRowsInFile: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hasValidExtension(fileName: string): boolean {
  return ACCEPTED_EXT.some(ext => fileName.toLowerCase().endsWith(ext));
}

/**
 * Shared bulk-import Upload step — originally built for Products
 * (components/data/products/import/ImportUploadStep.tsx, which now
 * delegates here), generalized with a `parseEndpoint` prop so Quotes/
 * Contracts/Orders reuse the exact same drag-and-drop UI, validation, and
 * parse-request handling instead of a per-module copy.
 */
export default function ImportUploadStep<T extends GenericParseResponse>({
  isDark, parseEndpoint, dropLabel = "Drag and drop your file here", onParsed,
}: {
  isDark: boolean;
  parseEndpoint: string;
  dropLabel?: string;
  onParsed: (file: File, result: T) => void;
}) {
  const t = tokens(isDark);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<ErrorPanelData | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const upload = async (file: File) => {
    setError(null);
    if (!hasValidExtension(file.name)) {
      setError({ title: "Unsupported file type", message: `"${file.name}" isn't a CSV or Excel file.`, possibleCause: "Upload a .csv, .xlsx, or .xls file." });
      return;
    }
    setSelectedFile(file);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(parseEndpoint, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError({ title: "Could not read this file", message: data.error ?? "Unknown error" });
        setSelectedFile(null);
        return;
      }
      onParsed(file, data as T);
    } catch {
      setError({ title: "Network error", message: "Could not reach the server to parse this file." });
      setSelectedFile(null);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !uploading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload a CSV or Excel file"
        onKeyDown={e => {
          if (uploading) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); }
        }}
        style={{
          border: `1.5px dashed ${dragOver ? t.accent : t.border}`,
          background: dragOver ? (isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.05)") : t.surfaceAlt,
          borderRadius: 16,
          padding: "40px 24px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          cursor: uploading ? "default" : "pointer",
          transition: "border-color .15s ease, background .15s ease",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={e => { const file = e.target.files?.[0]; if (file) upload(file); e.target.value = ""; }}
        />
        <div style={{ width: 52, height: 52, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", background: `${t.accent}18`, border: `1px solid ${t.accent}30`, color: t.accent, opacity: uploading ? 0.5 : 1, marginBottom: 4 }}>
          <Ic n="upload" s={26} />
        </div>
        {uploading ? (
          <div className="flex items-center gap-2" style={{ color: t.dim, fontSize: 13 }}>
            <Spinner isDark={isDark} /> Parsing {selectedFile?.name}…
          </div>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.heading }}>Upload your file</div>
            <div style={{ fontSize: 13, color: t.body }}>{dropLabel}</div>
            <div style={{ fontSize: 12, color: t.dim }}>or</div>
            <button
              onClick={e => { e.stopPropagation(); inputRef.current?.click(); }}
              style={{
                padding: "8px 16px", borderRadius: 10, fontSize: 12.5, fontWeight: 600,
                background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`, color: "#04101F", border: "none", cursor: "pointer",
              }}
            >
              Browse Files
            </button>
            <div style={{ fontSize: 11, color: t.dim, marginTop: 6, textAlign: "center" }}>
              Supported formats: CSV &bull; XLSX &bull; XLS<br />Maximum file size: {MAX_SIZE_LABEL}
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 16 }}>
          <ErrorPanel isDark={isDark} error={error} />
        </div>
      )}

      {selectedFile && !uploading && !error && (
        <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <Ic n="file-text" s={16} />
            <span style={{ fontSize: 13, fontWeight: 600, color: t.heading }}>{selectedFile.name}</span>
            <span style={{ fontSize: 11.5, color: t.dim }}>{formatBytes(selectedFile.size)}</span>
          </div>
          <button
            onClick={() => { setSelectedFile(null); setError(null); }}
            style={{ background: "transparent", border: "none", color: t.dim, cursor: "pointer" }}
            title="Remove file"
            aria-label="Remove file"
          >
            <Ic n="x" s={14} />
          </button>
        </div>
      )}
    </div>
  );
}
