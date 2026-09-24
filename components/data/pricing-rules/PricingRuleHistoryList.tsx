"use client";

import { useEffect, useState } from "react";
import { Ic, tokens, Spinner, ErrorPanel, EmptyState } from "./shared";

// Whatever /api/pricing-rules/list's Describe-driven field selection
// resolved for this org (§ schema-driven, no assumed fields beyond Id).
type ExpressionSetRecord = Record<string, unknown> & { Id: string };

function firstDateField(r: ExpressionSetRecord): string | null {
  const v = r.CreatedDate ?? r.LastModifiedDate;
  return typeof v === "string" ? v : null;
}

function subtitleFor(r: ExpressionSetRecord): string | null {
  const parts: string[] = [];
  if (typeof r.Status === "string" && r.Status) parts.push(r.Status);
  if (r.VersionNumber !== undefined && r.VersionNumber !== null) parts.push(`v${r.VersionNumber}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Deliberately no fixed-height shell here (no PageShell/h-full) — this
 * component is embedded both inside a full-height flex region (the
 * module's History tab) and inside an already-scrolling dashboard page,
 * and a `h-full` div collapses to 0 height in the latter context. Callers
 * that need their own scroll region wrap this themselves.
 *
 * Renders only whatever fields the backend's Describe-driven query
 * actually returned (never assumes DeveloperName or any other field
 * beyond Id/Name exists) — see /api/pricing-rules/list.
 */
export default function PricingRuleHistoryList({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [records, setRecords] = useState<ExpressionSetRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function fetchList() {
    fetch("/api/pricing-rules/list")
      .then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
        return json;
      })
      .then(json => setRecords(json.records ?? []))
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load pricing procedures."))
      .finally(() => setLoading(false));
  }

  function retry() {
    setLoading(true);
    setError(null);
    fetchList();
  }

  useEffect(() => { fetchList(); }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ padding: 32 }}>
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: t.dim }}><Spinner isDark={isDark} /> Loading pricing procedures…</div>
      </div>
    );
  }

  // The backend never surfaces a SOQL exception here (it degrades to an
  // empty list instead) — this branch only handles a genuine network/auth
  // failure reaching the endpoint at all.
  if (error) {
    return <div style={{ padding: 20 }}><ErrorPanel isDark={isDark} error={{ title: "Could not load pricing procedures", message: error }} onRetry={retry} /></div>;
  }

  if (!records || records.length === 0) {
    return <EmptyState isDark={isDark} icon="zap" title="No pricing procedures yet" hint="Create one to see it listed here." />;
  }

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8 }}>
      {records.map(r => {
        const dateValue = firstDateField(r);
        const subtitle = subtitleFor(r);
        return (
          <div key={r.Id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface }}>
            <Ic n="zap" s={15} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: t.heading }}>{typeof r.Name === "string" ? r.Name : r.Id}</div>
              {subtitle && <div style={{ fontSize: 11, color: t.dim }}>{subtitle}</div>}
            </div>
            {dateValue && <div style={{ fontSize: 11, color: t.dim }}>{new Date(dateValue).toLocaleDateString()}</div>}
          </div>
        );
      })}
    </div>
  );
}
