"use client";

import { useState } from "react";
import { tokens, PageShell, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import BillingRecordsTable from "@/components/data/billing/BillingRecordsTable";
import { useBillingData, ToolbarButton } from "@/components/data/billing/billingUi";
import { navTargetForReference, type BillingNavTarget } from "@/lib/billing/client";
import { getBillingModule } from "@/lib/billing/registry";
import type { BillingListResponse } from "@/lib/billing/types";

/**
 * Full History for one billing module — Salesforce is the source of truth
 * (no local audit store): up to 200 most recently modified records, filter/
 * sort in the table, or press Enter to search the whole org by name.
 */
export default function BillingHistory({ isDark, moduleKey, onOpen, onEdit, onAssign, onNavigate, onCreate, canCreate }: {
  isDark: boolean;
  moduleKey: string;
  onOpen: (id: string) => void;
  onNavigate: (target: BillingNavTarget) => void;
  onCreate: () => void;
  onEdit?: (id: string) => void;
  onAssign?: (id: string) => void;
  canCreate: boolean;
}) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const [serverSearch, setServerSearch] = useState("");
  const [showSoql, setShowSoql] = useState(false);
  const path = `/api/billing/${moduleKey}?limit=200${serverSearch ? `&search=${encodeURIComponent(serverSearch)}` : ""}`;
  const { data, error, loading, reload } = useBillingData<BillingListResponse>(`${def.label} history`, path);

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>{def.singular} History</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>
              {data ? `${data.records.length} record${data.records.length === 1 ? "" : "s"} from Salesforce${serverSearch ? ` matching “${serverSearch}”` : ""}` : "Loading from Salesforce…"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {serverSearch && <ToolbarButton isDark={isDark} label="Clear search" icon="x" onClick={() => setServerSearch("")} />}
            {canCreate && <ToolbarButton isDark={isDark} label={`Create New ${def.singular}`} icon="plus" primary onClick={onCreate} />}
          </div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}

        <BillingRecordsTable
          isDark={isDark}
          data={data}
          loading={loading}
          singular={def.singular}
          icon={def.icon}
          onOpen={onOpen}
          onEdit={onEdit}
          onAssign={onAssign}
          onOpenLinked={l => onNavigate({ product: { id: l.id } })}
          onOpenReference={ref => { const target = navTargetForReference(ref); if (target) onNavigate(target); }}
          onRefresh={reload}
          onServerSearch={term => setServerSearch(term.trim())}
        />

        {data?.soql && (
          <div>
            <GhostButton label={showSoql ? "Hide generated SOQL" : "View generated SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />
            {showSoql && (
              <pre style={{ margin: "8px 0 0", padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto", whiteSpace: "pre-wrap" }}>{data.soql}</pre>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}
