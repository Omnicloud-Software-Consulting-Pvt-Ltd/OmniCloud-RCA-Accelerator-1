"use client";

import { useState } from "react";
import { Ic, tokens, Section, GhostButton } from "./shared";
import type { DebugLogEntry, ProcedureStep } from "@/lib/pricing-rules/types";

const TYPE_LABEL: Record<DebugLogEntry["type"], string> = {
  soql: "SOQL Query",
  rest: "REST Endpoint",
  "metadata-soap": "Metadata API",
  record: "Record",
  retry: "Retry",
  "deploy-response": "Deploy Response",
  "xml-diagnostic": "XML Diagnostic",
  "zip-diagnostic": "ZIP Packaging",
  "native-create-request": "Native Record Request",
  "native-create-response": "Native Record Response",
  "execution-trace": "Execution Trace",
};

const TYPE_ICON: Record<DebugLogEntry["type"], string> = {
  soql: "table",
  rest: "zap",
  "metadata-soap": "layers",
  record: "check-circle",
  retry: "refresh",
  "deploy-response": "package",
  "xml-diagnostic": "activity",
  "zip-diagnostic": "package",
  "native-create-request": "arrow-right",
  "native-create-response": "arrow-left",
  "execution-trace": "list",
};

/**
 * Development-only raw trace: every SOQL query, REST endpoint, Metadata
 * API call, record Id created/updated, and retry the server made while
 * handling this request, plus the full step-by-step diagnostic trace.
 * Only populated when Debug Mode is on (§Debug Mode) — the server never
 * computes/serializes any of this otherwise.
 */
export default function DebugLogPanel({
  isDark,
  entries,
  steps,
  warnings,
}: {
  isDark: boolean;
  entries: DebugLogEntry[];
  steps: ProcedureStep[];
  warnings: string[];
}) {
  const t = tokens(isDark);
  const [showRawSteps, setShowRawSteps] = useState(false);

  if (entries.length === 0 && steps.length === 0 && warnings.length === 0) return null;

  return (
    <Section title="Debug Log" icon="terminal" isDark={isDark} defaultOpen={false}>
      <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 11, color: t.dim }}>Development only — every Salesforce call made while processing the last request(s) this session.</div>

        {entries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto", border: `1px solid ${t.border}`, borderRadius: 9, padding: 8, background: t.surfaceAlt }}>
            {entries.map((e, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
                <span style={{ flexShrink: 0, color: t.accent, display: "inline-flex", alignItems: "center", gap: 4, minWidth: 110 }}>
                  <Ic n={TYPE_ICON[e.type]} s={11} /> {TYPE_LABEL[e.type]}
                </span>
                <span style={{ color: t.body, wordBreak: "break-all" }}>{e.detail}</span>
              </div>
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, marginBottom: 4 }}>Warnings</div>
            {warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</div>)}
          </div>
        )}

        {steps.length > 0 && (
          <div>
            <GhostButton label={showRawSteps ? "Hide raw step trace" : `Show raw step trace (${steps.length})`} icon={showRawSteps ? "chevron-down" : "chevron-right"} isDark={isDark} onClick={() => setShowRawSteps(v => !v)} />
            {showRawSteps && (
              <pre style={{ marginTop: 8, padding: 10, borderRadius: 8, background: t.surfaceAlt, fontSize: 10.5, color: t.body, overflow: "auto", maxHeight: 320, border: `1px solid ${t.border}` }}>
                {JSON.stringify(steps, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
