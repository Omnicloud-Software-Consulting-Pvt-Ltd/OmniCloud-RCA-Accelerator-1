"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Ic, tokens, Tabs, CodeBlock, EmptyState } from "@/components/data/quotes/shared";
import { subscribeExecutionLog, getExecutionLogSnapshot } from "@/lib/quotes/client/executionLog";
import { subscribeResponseSummary, getResponseSummarySnapshot } from "@/lib/quotes/client/responseSummary";
import BundleDiagnosticsView from "@/components/data/quotes/BundleDiagnosticsView";

type Tab = "json" | "logs" | "response" | "diagnostics";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "json", label: "Generated JSON", icon: "terminal" },
  { id: "logs", label: "Execution Log", icon: "activity" },
  { id: "response", label: "Salesforce Response", icon: "eye" },
  { id: "diagnostics", label: "Bundle Diagnostics", icon: "layers" },
];

export default function PreviewPanel({ isDark, requestJson, initialTab = "json", highlightLogId }: {
  isDark: boolean; requestJson: unknown; initialTab?: Tab; highlightLogId?: string | null;
}) {
  const t = tokens(isDark);
  const [tab, setTab] = useState<Tab>(highlightLogId ? "logs" : initialTab);
  const log = useSyncExternalStore(subscribeExecutionLog, getExecutionLogSnapshot, getExecutionLogSnapshot);
  const summary = useSyncExternalStore(subscribeResponseSummary, getResponseSummarySnapshot, getResponseSummarySnapshot);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightLogId) {
      setTab("logs");
      highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightLogId]);

  const tabsWithBadges = TABS.map(tb => ({
    ...tb,
    badge: tb.id === "logs" ? log.length : tb.id === "response" ? (summary.lineItems ? summary.lineItems.count : undefined) : undefined,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Tabs isDark={isDark} tabs={tabsWithBadges} active={tab} onChange={id => setTab(id as Tab)} />

      {tab === "json" && <CodeBlock isDark={isDark} data={requestJson} defaultExpanded />}

      {tab === "logs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 460, overflowY: "auto" }}>
          {log.length === 0 && (
            <EmptyState isDark={isDark} icon="activity" title="No calls logged yet" hint="Every API call this module makes — AI parsing, metadata resolution, product lookups, Quote and line item creation — is logged here in real time as it happens." />
          )}
          {[...log].reverse().map(entry => {
            const isHighlighted = entry.id === highlightLogId;
            return (
              <div
                key={entry.id}
                ref={isHighlighted ? highlightRef : undefined}
                style={{
                  padding: "9px 11px", borderRadius: 9, fontSize: 11.5,
                  border: `1px solid ${isHighlighted ? t.error : t.border}`,
                  background: isHighlighted ? `${t.error}12` : "transparent",
                  transition: "background .3s ease",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", color: t.heading, fontWeight: 600 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Ic n={entry.status === "error" ? "alert" : entry.status === "pending" ? "clock" : "check-circle"} s={12} />
                    {entry.method} {entry.label}
                  </span>
                  <span style={{ color: entry.status === "error" ? t.error : entry.status === "success" ? t.accent : t.dim }}>
                    {entry.status}{entry.durationMs != null ? ` · ${entry.durationMs}ms` : ""}
                  </span>
                </div>
                <div style={{ color: t.dim, marginTop: 2 }}>{entry.path}</div>
                {entry.errorSummary && (
                  <div style={{ color: t.error, marginTop: 4 }}>
                    {entry.errorSummary.message}
                    {entry.errorSummary.possibleCause && <div style={{ color: t.dim }}>{entry.errorSummary.possibleCause}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "response" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!summary.quote && !summary.lineItems && (
            <EmptyState isDark={isDark} icon="eye" title="Nothing created yet this session" hint="Once a Quote or line items are created, the request, response, created record Ids, timing, and status will appear here." />
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {summary.quote && <SummaryCard t={t} icon="file-text" label="Quote" value={summary.quote.name} sub={summary.quote.id} />}
            {summary.lineItems && <SummaryCard t={t} icon="list" label="Line Items Created" value={String(summary.lineItems.count)} sub={`${summary.lineItems.ids.length} record id(s)`} />}
            {summary.bundleResult && (
              <SummaryCard t={t} icon={summary.bundleResult.bundleHierarchyValid ? "check-circle" : "alert"} label="Bundle Hierarchy" value={summary.bundleResult.bundleHierarchyValid ? "Verified" : "Issues found"} sub={`${summary.bundleResult.steps.length} step(s) traced`} />
            )}
            {summary.repricing && <SummaryCard t={t} icon="dollar-sign" label="Repricing" value={summary.repricing.succeeded ? "Succeeded" : "Not run"} sub={summary.repricing.message ?? undefined} />}
          </div>

          {summary.lineItems && summary.lineItems.ids.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Created Record Ids</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {summary.lineItems.ids.map(id => (
                  <span key={id} style={{ fontSize: 10.5, fontFamily: "ui-monospace, monospace", padding: "3px 8px", borderRadius: 6, background: t.surfaceAlt, border: `1px solid ${t.border}`, color: t.body }}>{id}</span>
                ))}
              </div>
            </div>
          )}

          {summary.bundleResult && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Raw Response</div>
              <CodeBlock isDark={isDark} data={summary.bundleResult} />
            </div>
          )}
        </div>
      )}

      {tab === "diagnostics" && <BundleDiagnosticsView isDark={isDark} result={summary.bundleResult} />}
    </div>
  );
}

function SummaryCard({ t, icon, label, value, sub }: { t: ReturnType<typeof tokens>; icon: string; label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>
        <Ic n={icon} s={11} /> {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: t.dim, marginTop: 1, fontFamily: "ui-monospace, monospace" }}>{sub}</div>}
    </div>
  );
}
