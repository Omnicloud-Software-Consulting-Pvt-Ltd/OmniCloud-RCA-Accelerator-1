"use client";

import { useState } from "react";
import { tokens, GhostButton } from "@/components/data/quotes/shared";

interface HarEntrySummary {
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseSnippet: string;
}

const REDACT_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);

function redactHeaders(headers: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name] = REDACT_HEADERS.has(h.name.toLowerCase()) ? "[redacted]" : h.value;
  return out;
}

/**
 * Optional ground-truth tool (§5.9): import a browser HAR capture of
 * Salesforce's own native UI to inspect its bundle-related network traffic
 * when official docs are ambiguous about a field's real behavior. All
 * Authorization/Cookie/session headers are redacted before display.
 */
export default function HarImportTool({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [entries, setEntries] = useState<HarEntrySummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const har = JSON.parse(reader.result as string);
        const rawEntries: unknown[] = har?.log?.entries ?? [];
        const summarized: HarEntrySummary[] = rawEntries
          .map((e): HarEntrySummary | null => {
            const entry = e as Record<string, unknown>;
            const request = entry.request as Record<string, unknown> | undefined;
            const response = entry.response as Record<string, unknown> | undefined;
            if (!request || !response) return null;
            const url = String(request.url ?? "");
            if (!/product|bundle|component|quote|pricing|price|calculate|cpq|revenue/i.test(url)) return null;
            return {
              method: String(request.method ?? ""),
              url,
              status: Number((response.status as number) ?? 0),
              requestHeaders: redactHeaders((request.headers as { name: string; value: string }[]) ?? []),
              responseSnippet: String((response.content as Record<string, unknown> | undefined)?.text ?? "").slice(0, 2000),
            };
          })
          .filter((e): e is HarEntrySummary => e !== null);
        setEntries(summarized);
      } catch {
        setError("Could not parse this file as a HAR capture.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "inline-flex" }}>
        <input
          type="file"
          accept=".har,application/json"
          style={{ display: "none" }}
          onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <span style={{ display: "inline-flex" }}>
          <GhostButton label="Import HAR file" icon="upload" isDark={isDark} />
        </span>
      </label>
      {error && <div style={{ fontSize: 12, color: t.error }}>{error}</div>}
      {entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto" }}>
          {entries.map((e, i) => (
            <div key={i} style={{ padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 11.5 }}>
              <div style={{ color: t.heading, fontWeight: 600 }}>{e.method} — {e.status}</div>
              <div style={{ color: t.dim, wordBreak: "break-all" }}>{e.url}</div>
              <pre style={{ marginTop: 6, color: t.body, whiteSpace: "pre-wrap", maxHeight: 120, overflowY: "auto" }}>{e.responseSnippet}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
