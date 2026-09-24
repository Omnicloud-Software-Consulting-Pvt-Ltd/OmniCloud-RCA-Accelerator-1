"use client";

import { useEffect, useState } from "react";
import { Ic, tokens, PageShell, EmptyState, Spinner, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { BundleListItem } from "@/app/api/bundles/list/route";

/**
 * Bundle Dependencies — this org's ProductRelatedComponent rows carry only
 * one dependency-style signal that actually persists: IsComponentRequired
 * (Required vs Optional) on each component. The AI Bundle Creator's
 * REQUIRES/DEPENDS_ON/EXCLUDES rules are a pre-creation planning concept —
 * they get flattened into plain components the moment a bundle deploys,
 * and Salesforce keeps no distinct "X requires Y" edge afterward. This
 * view is honest about that: it shows every bundle's real Required/
 * Optional components (editable from Edit Bundle) rather than fabricating
 * a persisted cross-product dependency graph that doesn't exist here.
 */
export default function BundleDependenciesView({ isDark, onOpenBundle, onBack }: { isDark: boolean; onOpenBundle: (id: string) => void; onBack: () => void }) {
  const t = tokens(isDark);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  useEffect(() => {
    quoteApiGet<{ success: true; bundles: BundleListItem[] }>("List bundles", "/api/bundles/list")
      .then(res => setBundles(res.bundles))
      .catch(err => setError(toErrorPanelData(err, "Could not load bundle dependencies")))
      .finally(() => setLoading(false));
  }, []);

  const bundlesWithComponents = bundles.filter(b => b.children.length > 0);

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0 }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Bundle Dependencies</h2>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 640 }}>
            Required vs. Optional status for every bundle&apos;s components — the one dependency signal this org&apos;s Product2/ProductRelatedComponent schema actually persists. Cross-product &quot;X requires Y&quot; rules from the AI Bundle Creator are a planning-time concept only and aren&apos;t stored once a bundle is deployed.
          </p>
        </div>
        <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} />
      </div>
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ padding: "16px 20px 20px" }}>
        {loading && <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: t.dim, padding: "20px 0" }}><Spinner isDark={isDark} /> Loading dependencies…</div>}
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {!loading && !error && bundlesWithComponents.length === 0 && <EmptyState isDark={isDark} icon="package" title="No bundle components yet" hint="Bundles with components will show their Required/Optional status here." />}

        <div className="flex flex-col gap-4">
          {bundlesWithComponents.map(b => {
            const required = b.children.filter(c => c.isRequired);
            const optional = b.children.filter(c => !c.isRequired);
            return (
              <div key={b.id} style={{ borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, padding: 14 }}>
                <button onClick={() => onOpenBundle(b.id)} className="flex items-center gap-2" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, marginBottom: 8 }}>
                  <Ic n="package" s={14} />
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: t.accent }}>{b.name}</span>
                </button>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.accentBlue, marginBottom: 6 }}>Required ({required.length})</p>
                    {required.length === 0 ? <p style={{ fontSize: 11.5, color: t.dim }}>None</p> : required.map(c => (
                      <div key={c.id} style={{ fontSize: 12, color: t.body, marginBottom: 3 }}>• {c.name}</div>
                    ))}
                  </div>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 6 }}>Optional ({optional.length})</p>
                    {optional.length === 0 ? <p style={{ fontSize: 11.5, color: t.dim }}>None</p> : optional.map(c => (
                      <div key={c.id} style={{ fontSize: 12, color: t.body, marginBottom: 3 }}>• {c.name}</div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
