"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Ic, tokens, GhostButton } from "@/components/data/quotes/shared";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";

type CreationStatus = "pending" | "creating" | "created" | "failed";

export interface CreateQueueItem {
  index: number;
  name: string;
  /**
   * Performs the actual Salesforce write for this item via the module's
   * existing creation API(s) — never re-implemented here. `note` is for a
   * non-fatal follow-up problem after the primary record WAS created (e.g.
   * an Order/Quote header succeeded but a line item failed) — shown next to
   * the item instead of being silently dropped, without marking the whole
   * item as failed.
   */
  create: () => Promise<{ id?: string; error?: string; note?: string }>;
}

export interface ExcludedQueueItem {
  index: number;
  name: string;
  reason: string;
}

interface CreationItem {
  index: number;
  name: string;
  create: () => Promise<{ id?: string; error?: string; note?: string }>;
  status: CreationStatus;
  salesforceId?: string;
  error?: string;
  note?: string;
}

/**
 * Shared bulk-import Create/Progress/Result step — originally built for
 * Products (components/data/products/import/ImportCreateStep.tsx, which now
 * delegates here), generalized so Quotes/Contracts/Orders reuse the same
 * sequential-queue progress UI and result table. The actual Salesforce
 * write for each item is supplied by the caller via `item.create()` — this
 * component only orchestrates the queue, progress bar, and result display;
 * it never talks to Salesforce itself, so every module's existing creation
 * API is what actually runs.
 */
export default function ImportCreateStep({
  isDark, items: initialItems, excluded, totalCount, warningsCount, nounSingular, nounPlural, objectApiName, onBack, onComplete, stopOnFailure,
}: {
  isDark: boolean;
  items: CreateQueueItem[];
  excluded: ExcludedQueueItem[];
  totalCount: number;
  warningsCount: number;
  /** e.g. "Product" — used for the global success notification's title/message. */
  nounSingular: string;
  nounPlural: string;
  /** The Salesforce object every successfully-created item belongs to (e.g. "Product2", "Quote") — used to build each item's "View in Salesforce" link via the global notification. */
  objectApiName: string;
  onBack: () => void;
  onComplete?: (summary: { created: number; failed: number }) => void;
  /**
   * When true, the queue stops at the first failed item instead of
   * continuing to the rest — remaining items stay "pending" ("Not
   * Started") rather than being silently skipped-and-attempted. Defaults
   * to false (continue past failures), which is what every existing CSV
   * bulk-import caller relies on, since spreadsheet rows are independent
   * and a user wants to see every row's outcome in one pass.
   */
  stopOnFailure?: boolean;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const [items, setItems] = useState<CreationItem[]>(() => initialItems.map(it => ({ ...it, status: "pending" as CreationStatus })));
  const [running, setRunning] = useState(true);
  const startedRef = useRef(false);
  const completedRef = useRef(false);

  const runQueue = async (indices: number[]) => {
    setRunning(true);
    for (const idx of indices) {
      setItems(prev => prev.map(it => (it.index === idx ? { ...it, status: "creating", error: undefined } : it)));
      const target = initialItems.find(it => it.index === idx);
      if (!target) continue;
      const result = await target.create();
      setItems(prev => prev.map(it => it.index === idx
        ? (result.id ? { ...it, status: "created", salesforceId: result.id, note: result.note } : { ...it, status: "failed", error: result.error })
        : it));
      if (!result.id && stopOnFailure) break;
    }
    setRunning(false);
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runQueue(items.map(it => it.index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (running || completedRef.current) return;
    const createdItems = items.filter(it => it.status === "created");
    const failedItems = items.filter(it => it.status === "failed");
    if (createdItems.length + failedItems.length === 0) return;
    completedRef.current = true;

    const instanceUrl = loadSession()?.instanceUrl;
    if (instanceUrl && createdItems.length > 0) {
      const records = createdItems
        .filter((it): it is CreationItem & { salesforceId: string } => !!it.salesforceId)
        .map(it => toCreatedSalesforceRecord(instanceUrl, objectApiName, it.salesforceId, it.name));
      const single = records.length === 1;
      notifySalesforceSuccess({
        title: single ? `${nounSingular} Created Successfully` : `${records.length} ${nounPlural} Created Successfully`,
        message: single
          ? `${records[0].recordName} has been successfully created in Salesforce.`
          : `${records.length} ${nounPlural.toLowerCase()} were successfully created in Salesforce.`,
        records,
        failedRecords: failedItems.map(it => ({ recordName: it.name, error: it.error ?? "Unknown error" })),
        detailsLabel: `View Created ${nounPlural}`,
      });
    }

    onComplete?.({ created: createdItems.length, failed: failedItems.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const total = items.length;
  const done = items.filter(it => it.status === "created" || it.status === "failed").length;
  const createdCount = items.filter(it => it.status === "created").length;
  const failedCount = items.filter(it => it.status === "failed").length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);

  const retryFailed = () => {
    const failedIdx = items.filter(it => it.status === "failed").map(it => it.index);
    if (failedIdx.length > 0) { completedRef.current = false; runQueue(failedIdx); }
  };

  return (
    <div style={{ padding: 24, maxWidth: 880 }}>
      {running ? (
        <>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Creating {nounPlural}</p>
          <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginBottom: 10 }}>{done} / {total} {nounPlural.toLowerCase()} created</div>
          <div style={{ height: 8, borderRadius: 6, background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.10)", overflow: "hidden", marginBottom: 18 }}>
            <motion.div
              initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ ease: "easeOut", duration: 0.3 }}
              style={{ height: "100%", background: `linear-gradient(90deg, ${t.accent}, ${t.accentBlue})` }}
            />
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import Complete</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
            <ResultStat label={`Total ${nounPlural}`} value={totalCount} color={t.accent} t={t} />
            <ResultStat label="Successfully Created" value={createdCount} color="#22C55E" t={t} />
            <ResultStat label="Failed" value={failedCount} color="#FF4066" t={t} />
            <ResultStat label="Warnings" value={warningsCount} color="#F59E0B" t={t} />
          </div>
          {stopOnFailure && failedCount > 0 && items.some(it => it.status === "pending") && (
            <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderRadius: 10, border: "1px solid rgba(255,64,102,0.25)", background: "rgba(255,64,102,0.06)", color: "#FF4066", fontSize: 12, marginBottom: 16 }}>
              <Ic n="alert" s={14} />
              <span>Deployment stopped after the failure below — the remaining {nounPlural.toLowerCase()} were not attempted and are marked &quot;Not Started&quot;. Retry the failed {nounSingular.toLowerCase()} to continue, or go back to review.</span>
            </div>
          )}
        </>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map(it => (
          <div key={it.index} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface }}>
            <StatusGlyph status={it.status} t={t} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.heading, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {it.status === "created" ? `${nounSingular} "${it.name}" successfully created.` : it.status === "pending" && !running ? `${it.name} — Not Started` : it.name}
            </span>
            {it.status === "created" && it.note && (
              <span style={{ fontSize: 11, color: "#F59E0B", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={it.note}>{it.note}</span>
            )}
            {it.status === "created" && it.salesforceId && (
              <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: t.dim }}>{it.salesforceId}</span>
            )}
            {it.status === "failed" && (
              <span style={{ fontSize: 11, color: "#FF4066", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }} title={it.error}>{it.error}</span>
            )}
          </div>
        ))}
        {excluded.map(row => (
          <div key={`excluded-${row.index}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.border}`, background: isDark ? "rgba(90,120,160,0.05)" : "rgba(90,120,160,0.04)" }}>
            <span style={{ color: t.dim }}><Ic n="x" s={13} /></span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.dim, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</span>
            <span style={{ fontSize: 11, color: t.dim, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>Not attempted — {row.reason}</span>
          </div>
        ))}
      </div>

      {!running && (
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          {failedCount > 0 && <GhostButton label={`Retry Failed ${nounPlural}`} icon="refresh" isDark={isDark} onClick={retryFailed} />}
          <GhostButton label="Back to Dashboard" icon="arrow-left" isDark={isDark} onClick={onBack} />
        </div>
      )}
    </div>
  );
}

function ResultStat({ label, value, color, t }: { label: string; value: number; color: string; t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ flex: 1, minWidth: 96, padding: "10px 14px", borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface }}>
      <div style={{ fontSize: 20, fontWeight: 800, color, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 11, color: t.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function StatusGlyph({ status, t }: { status: CreationStatus; t: ReturnType<typeof tokens> }) {
  if (status === "created") return <span style={{ color: "#22C55E" }}><Ic n="check-circle" s={15} /></span>;
  if (status === "failed") return <span style={{ color: "#FF4066" }}><Ic n="alert" s={15} /></span>;
  if (status === "creating") return (
    <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} style={{ color: t.accent, display: "inline-flex" }}>
      <Ic n="refresh" s={15} />
    </motion.span>
  );
  return <span style={{ color: t.dim, opacity: 0.5 }}><Ic n="clock" s={15} /></span>;
}
