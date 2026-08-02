"use client";

import { useState } from "react";
import { Section, Ic, tokens, Field, PrimaryButton, GhostButton, Pill, inputStyle, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import { quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";

interface FieldDiffEntry {
  label: string;
  apiName: string | null;
  role: "identity" | "shared-reference" | "value";
  nativeValue: unknown;
  appValue: unknown;
  match: boolean | null;
  note: string;
}

interface RowComparison {
  matchKey: string;
  matchNote: string;
  nativeRow: Record<string, unknown> | null;
  appRow: Record<string, unknown> | null;
  diffs: FieldDiffEntry[];
  firstDifferingField: FieldDiffEntry | null;
}

interface ConfigurationFieldFinding {
  apiName: string;
  existsInOrgSchema: boolean;
  label: string | null;
  type: string | null;
  nativeRowCount: number;
  populatedInNativeCount: number;
  appRowCount: number;
  populatedInAppCount: number;
  note: string;
}

interface RepricingSummaryLike {
  attempted: boolean;
  succeeded: boolean;
  isConfigurationIssue: boolean;
  message: string | null;
  attemptedRequests: { path: string; body: unknown }[];
  attemptErrors: unknown[];
}

interface ParityCheckResult {
  success: boolean;
  nativeQuoteId: string;
  appQuoteId: string;
  relationshipObjectName: string | null;
  summary: {
    lineItemsCompared: number;
    lineItemsMissingInApp: number;
    lineItemsMissingInNative: number;
    relationshipsCompared: number;
    firstDifferingField: (FieldDiffEntry & { scope: string; matchKey: string | null }) | null;
  };
  lineItemComparisons: RowComparison[];
  relationshipComparisons: RowComparison[];
  configurationFieldInvestigation: ConfigurationFieldFinding[];
  repricingComparison: { native: RepricingSummaryLike; app: RepricingSummaryLike } | null;
}

function matchColor(t: ReturnType<typeof tokens>, match: boolean | null): string {
  if (match === true) return t.accentCyan;
  if (match === false) return t.error;
  return t.dim;
}

function matchLabel(match: boolean | null): string {
  if (match === true) return "match";
  if (match === false) return "DIFFERS";
  return "n/a";
}

function DiffTable({ isDark, diffs }: { isDark: boolean; diffs: FieldDiffEntry[] }) {
  const t = tokens(isDark);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
        <thead>
          <tr style={{ textAlign: "left", color: t.dim }}>
            <th style={{ padding: "4px 8px" }}>Field</th>
            <th style={{ padding: "4px 8px" }}>Role</th>
            <th style={{ padding: "4px 8px" }}>Native</th>
            <th style={{ padding: "4px 8px" }}>App</th>
            <th style={{ padding: "4px 8px" }}>Result</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map((d, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${t.border}`, background: d.match === false ? (isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)") : "transparent" }}>
              <td style={{ padding: "4px 8px", color: t.heading, fontWeight: 600 }}>{d.label}{d.apiName && d.apiName !== d.label ? <span style={{ color: t.dim, fontWeight: 400 }}> ({d.apiName})</span> : null}</td>
              <td style={{ padding: "4px 8px", color: t.dim }}>{d.role}</td>
              <td style={{ padding: "4px 8px", color: t.body, maxWidth: 220, wordBreak: "break-all" }}>{d.nativeValue === undefined ? "—" : String(d.nativeValue ?? "null")}</td>
              <td style={{ padding: "4px 8px", color: t.body, maxWidth: 220, wordBreak: "break-all" }}>{d.appValue === undefined ? "—" : String(d.appValue ?? "null")}</td>
              <td style={{ padding: "4px 8px" }} title={d.note}><Pill label={matchLabel(d.match)} color={matchColor(t, d.match)} isDark={isDark} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowComparisonCard({ isDark, title, comparison }: { isDark: boolean; title: string; comparison: RowComparison }) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(!!comparison.firstDifferingField);
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(v => !v)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "transparent", border: "none", cursor: "pointer" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.heading, display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          {!comparison.nativeRow && <Pill label="missing in native" color={t.warn} isDark={isDark} />}
          {!comparison.appRow && <Pill label="missing in app" color={t.warn} isDark={isDark} />}
          {comparison.firstDifferingField && <Pill label={`first diff: ${comparison.firstDifferingField.label}`} color={t.error} isDark={isDark} />}
        </span>
        <Ic n={open ? "chevron-down" : "chevron-right"} s={13} />
      </button>
      {open && (
        <div style={{ padding: "0 12px 12px" }}>
          <div style={{ fontSize: 11, color: t.dim, marginBottom: 6 }}>{comparison.matchNote}</div>
          {comparison.diffs.length > 0 && <DiffTable isDark={isDark} diffs={comparison.diffs} />}
        </div>
      )}
    </div>
  );
}

function ConfigurationFieldRow({ isDark, finding }: { isDark: boolean; finding: ConfigurationFieldFinding }) {
  const t = tokens(isDark);
  const color = !finding.existsInOrgSchema
    ? t.dim
    : finding.populatedInNativeCount > 0 && finding.populatedInAppCount === 0
      ? t.error
      : finding.populatedInNativeCount === 0
        ? t.dim
        : t.accentCyan;
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{finding.apiName}</span>
        <Pill label={finding.existsInOrgSchema ? `exists (${finding.type})` : "not in this org's schema"} color={color} isDark={isDark} />
        {finding.existsInOrgSchema && (
          <Pill label={`native ${finding.populatedInNativeCount}/${finding.nativeRowCount} · app ${finding.populatedInAppCount}/${finding.appRowCount}`} color={t.dim} isDark={isDark} />
        )}
      </div>
      <div style={{ fontSize: 11.5, color: t.body }}>{finding.note}</div>
    </div>
  );
}

function RepricingComparisonPanel({ isDark, comparison }: { isDark: boolean; comparison: { native: RepricingSummaryLike; app: RepricingSummaryLike } }) {
  const t = tokens(isDark);
  function Side({ label, summary }: { label: string; summary: RepricingSummaryLike }) {
    return (
      <div style={{ flex: 1, minWidth: 260, border: `1px solid ${t.border}`, borderRadius: 10, padding: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{label}</span>
          <Pill label={summary.succeeded ? "succeeded" : "failed"} color={summary.succeeded ? t.accentCyan : t.error} isDark={isDark} />
          {summary.isConfigurationIssue && <Pill label="configuration issue" color={t.warn} isDark={isDark} />}
        </div>
        {summary.message && <div style={{ fontSize: 11.5, color: t.body, marginBottom: 8 }}>{summary.message}</div>}
        <div style={{ fontSize: 11, color: t.dim, marginBottom: 4 }}>Requests sent:</div>
        <CodeBlock isDark={isDark} data={summary.attemptedRequests} />
        {summary.attemptErrors.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: t.dim, margin: "8px 0 4px" }}>Complete errors (untruncated):</div>
            <CodeBlock isDark={isDark} data={summary.attemptErrors} />
          </>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Side label="Native Quote" summary={comparison.native} />
      <Side label="App Quote" summary={comparison.app} />
    </div>
  );
}

/**
 * §Structural Parity Comparison tool (repricing-failure ticket) — fully
 * automated: takes the native Quote Id (created manually in Salesforce) and
 * this app's own already-authenticated session does everything else via
 * SOQL/Describe. No export, no paste, no CSV — the developer only ever
 * types one Id.
 */
export default function BundleParityCheck({ isDark, quoteId }: { isDark: boolean; quoteId: string }) {
  const t = tokens(isDark);
  const [nativeQuoteId, setNativeQuoteId] = useState("");
  const [compareReprice, setCompareReprice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [result, setResult] = useState<ParityCheckResult | null>(null);

  async function runComparison() {
    if (!nativeQuoteId.trim()) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await quoteApiPost<ParityCheckResult>(
        "Bundle parity comparison", `/api/quotes/${quoteId}/parity-check`,
        { nativeQuoteId: nativeQuoteId.trim(), compareReprice },
      );
      setResult(res);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not run the parity comparison"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 11.5, color: t.dim }}>
        Create the equivalent bundle natively in Salesforce (a separate Quote), then enter its Quote Id below. This app fetches both quotes&apos; QuoteLineItem/QuoteLineRelationship records directly via SOQL — every readable field, discovered from Describe — and reports only what differs. Nothing is exported or pasted.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Native Quote Id" isDark={isDark} hint="The bundle created manually in Salesforce">
          <input value={nativeQuoteId} onChange={e => setNativeQuoteId(e.target.value)} placeholder="0Q0..." style={{ ...inputStyle(t), width: 220 }} />
        </Field>
        <PrimaryButton label={busy ? "Comparing…" : "Run Automated Parity Check"} icon="activity" isDark={isDark} disabled={busy || !nativeQuoteId.trim()} onClick={runComparison} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: t.dim }}>
        <input type="checkbox" checked={compareReprice} onChange={e => setCompareReprice(e.target.checked)} />
        Also compare live reprice requests — <strong style={{ color: t.warn }}>this triggers Salesforce&apos;s actual repricing action on BOTH the native quote and the app quote</strong> (a real write), so both sides&apos; outgoing request and complete response can be compared directly.
      </label>

      {error && <ErrorPanel isDark={isDark} error={error} />}

      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: t.dim }}>
            <span>{result.summary.lineItemsCompared} line(s) compared</span>
            {result.summary.lineItemsMissingInApp > 0 && <span style={{ color: t.error }}>{result.summary.lineItemsMissingInApp} product(s) in native bundle missing from app bundle</span>}
            {result.summary.lineItemsMissingInNative > 0 && <span style={{ color: t.warn }}>{result.summary.lineItemsMissingInNative} product(s) in app bundle not in native</span>}
            <span>{result.summary.relationshipsCompared} relationship edge(s) compared</span>
          </div>

          {result.summary.firstDifferingField ? (
            <div style={{ border: `1px solid ${t.error}60`, background: isDark ? "rgba(255,64,102,0.1)" : "rgba(255,64,102,0.06)", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: t.error, display: "flex", alignItems: "center", gap: 6 }}>
                <Ic n="alert" s={14} /> First differing field: {result.summary.firstDifferingField.label} ({result.summary.firstDifferingField.scope})
              </div>
              <div style={{ fontSize: 11.5, color: t.body, marginTop: 4 }}>{result.summary.firstDifferingField.note}</div>
            </div>
          ) : (
            <div style={{ border: `1px solid ${t.accentCyan}50`, borderRadius: 10, padding: 12, fontSize: 12.5, color: t.heading, display: "flex", alignItems: "center", gap: 6 }}>
              <Ic n="check" s={14} /> No field differences found across every compared line and relationship edge.
            </div>
          )}

          <Section title="Configuration Field Investigation (ConfigurationId, ConfigurationSessionId, ProductConfigurationId, PriceAdjustmentSchedule, PricingProcedure)" icon="search" isDark={isDark} defaultOpen>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.configurationFieldInvestigation.map(f => <ConfigurationFieldRow key={f.apiName} isDark={isDark} finding={f} />)}
            </div>
          </Section>

          {result.repricingComparison && (
            <Section title="Reprice Request Comparison (native vs. app)" icon="zap" isDark={isDark} defaultOpen>
              <RepricingComparisonPanel isDark={isDark} comparison={result.repricingComparison} />
            </Section>
          )}

          <Section title={`Line Items (${result.lineItemComparisons.length})`} icon="list" isDark={isDark} defaultOpen>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.lineItemComparisons.map((c, i) => (
                <RowComparisonCard key={i} isDark={isDark} title={`Product2Id ${c.matchKey}`} comparison={c} />
              ))}
            </div>
          </Section>

          {result.relationshipComparisons.length > 0 && (
            <Section title={`${result.relationshipObjectName ?? "Relationship"} Edges (${result.relationshipComparisons.length})`} icon="layers" isDark={isDark} defaultOpen={false}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {result.relationshipComparisons.map((c, i) => (
                  <RowComparisonCard key={i} isDark={isDark} title={`Parent::Child ${c.matchKey}`} comparison={c} />
                ))}
              </div>
            </Section>
          )}

          <GhostButton label="Clear results" icon="trash" isDark={isDark} onClick={() => setResult(null)} />
        </div>
      )}
    </div>
  );
}
