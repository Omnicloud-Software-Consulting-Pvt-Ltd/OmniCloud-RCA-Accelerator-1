"use client";

import { useEffect, useState } from "react";
import {
  Section, Ic, tokens, formatCurrency, PrimaryButton, GhostButton, inputStyle,
  PageShell, Tabs, EmptyState, Spinner, ErrorPanel, Pill,
} from "@/components/data/quotes/shared";
import LineItemsEditor from "@/components/data/quotes/LineItemsEditor";
import PreviewPanel from "@/components/data/quotes/PreviewPanel";
import HarImportTool from "@/components/data/quotes/HarImportTool";
import BundleParityCheck from "@/components/data/quotes/BundleParityCheck";
import LineItemFailureView from "@/components/data/quotes/LineItemFailureView";
import { quoteApiGet, quoteApiPost, quoteApiPatch, quoteApiDelete, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { replayServerSteps } from "@/lib/quotes/client/executionLog";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import type { ExistingQuoteLineItem, LineItemCreationResult, LineItemFailureDetail, QuoteDetail, QuoteLineItemDraft } from "@/lib/quotes/types";

type Tab = "overview" | "lines" | "bundle-tree" | "diagnostics";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "file-text" },
  { id: "lines", label: "Line Items", icon: "list" },
  { id: "bundle-tree", label: "Bundle Tree", icon: "layers" },
  { id: "diagnostics", label: "Session Diagnostics", icon: "activity" },
];

export default function QuoteWorkspace({
  isDark,
  quoteId,
  onBack,
  initialTab,
  onTabChange,
}: {
  isDark: boolean;
  quoteId: string;
  onBack: () => void;
  initialTab?: string;
  /** Bubbles tab changes up to QuotesModule (and from there to the page's URL) so a refresh reopens the same tab. */
  onTabChange?: (tab: Tab) => void;
}) {
  const t = tokens(isDark);
  const [tab, setTabState] = useState<Tab>(() => (TABS.some(t => t.id === initialTab) ? (initialTab as Tab) : "overview"));
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [lineItems, setLineItems] = useState<ExistingQuoteLineItem[]>([]);
  const [hierarchySupported, setHierarchySupported] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addingMore, setAddingMore] = useState(false);
  const [pendingRoots, setPendingRoots] = useState<QuoteLineItemDraft[]>([]);
  const [pendingValid, setPendingValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  function setTab(next: Tab) {
    setTabState(next);
    onTabChange?.(next);
  }

  // Reasserts the resolved initial tab once on mount so the URL reflects it
  // even though QuotesModule clears its own qtab param on every view change.
  useEffect(() => {
    onTabChange?.(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const [detailRes, linesRes] = await Promise.all([
      quoteApiGet<{ quote: QuoteDetail }>("Load quote", `/api/quotes/${quoteId}`),
      quoteApiGet<{ lineItems: ExistingQuoteLineItem[]; hierarchySupported: boolean }>("List line items", `/api/quotes/${quoteId}/line-items`),
    ]);
    setDetail(detailRes.quote);
    setLineItems(linesRes.lineItems);
    setHierarchySupported(linesRes.hierarchySupported);
  }

  useEffect(() => {
    refresh().catch(err => setError(toErrorPanelData(err, "Could not load this quote")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteId]);

  async function handleUpdateLine(id: string, patch: { quantity?: number; discountPercent?: number; unitPrice?: number }) {
    try {
      await quoteApiPatch(`Update line item ${id}`, `/api/quotes/line-items/${id}`, { ...patch, quoteId });
      await refresh();
    } catch (err) {
      setError(toErrorPanelData(err, "Could not update this line item"));
    }
  }

  /** Increment/decrement an already-persisted line item's quantity from the product catalog's "Added" controls — a decrement to 0 deletes the line item outright (Salesforce QuoteLineItem requires a positive quantity), which also reverts the catalog row back to "Add". */
  async function handleAdjustExistingQuantity(lineItemId: string, currentQuantity: number, delta: number) {
    const newQuantity = currentQuantity + delta;
    setError(null);
    try {
      if (newQuantity <= 0) {
        await quoteApiDelete("Delete line item", "/api/quotes/line-items", { ids: [lineItemId] });
      } else {
        await quoteApiPatch(`Update line item ${lineItemId}`, `/api/quotes/line-items/${lineItemId}`, { quantity: newQuantity, quoteId });
      }
      await refresh();
    } catch (err) {
      setError(toErrorPanelData(err, "Could not update this line item's quantity"));
    }
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await quoteApiDelete("Delete line items", "/api/quotes/line-items", { ids: [...selected] });
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(toErrorPanelData(err, "Could not delete the selected line items"));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveNewLines() {
    if (!detail?.pricebookId || pendingRoots.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // A 422 response causes quoteApiPost to throw (non-2xx) — the success
      // path below only ever runs for a genuine 2xx create.
      const res = await quoteApiPost<LineItemCreationResult & { success: true }>(
        "Add line items", `/api/quotes/${quoteId}/line-items`, { pricebookId: detail.pricebookId, draftRoots: pendingRoots },
      );
      replayServerSteps("Add Line Items", res.steps);
      updateResponseSummary({ lineItems: { count: res.createdCount, ids: res.createdIds }, bundleResult: res, repricing: res.repricing });
      setAddingMore(false);
      setPendingRoots([]);
      await refresh();
    } catch (err) {
      const data = toErrorPanelData(err, "Could not add these line items");
      setError(data);
      const rawResult = data.raw as LineItemCreationResult | undefined;
      if (rawResult?.steps) replayServerSteps("Add Line Items", rawResult.steps);
      if (rawResult) updateResponseSummary({ bundleResult: rawResult });
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: t.heading }}>
          <Ic n="file-text" s={17} /> {detail?.name ?? "Loading…"}
        </div>
        <GhostButton label="Back to History" icon="arrow-left" isDark={isDark} onClick={onBack} />
      </div>
      <div style={{ borderBottom: `1px solid ${t.border}`, paddingBottom: 10 }}>
        <Tabs isDark={isDark} tabs={TABS} active={tab} onChange={id => setTab(id as Tab)} />
      </div>
    </div>
  );

  if (!detail) {
    return (
      <PageShell header={header}>
        <div style={{ padding: 20 }}>
          {error ? <ErrorPanel isDark={isDark} error={error} /> : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: t.dim }}><Spinner isDark={isDark} /> Loading quote…</div>
          )}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell header={header}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 20 }}>
        {error && (
          error.failureDetail
            ? <Section title="Why did this fail?" icon="alert" isDark={isDark}><LineItemFailureView isDark={isDark} detail={error.failureDetail as LineItemFailureDetail} /></Section>
            : <ErrorPanel isDark={isDark} error={error} />
        )}

        {tab === "overview" && (
          <Section title="Quote Fields" icon="file-text" isDark={isDark}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
              {Object.entries(detail.record)
                .filter(([, v]) => typeof v !== "object")
                .map(([k, v]) => (
                  <div key={k} style={{ fontSize: 12, display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${t.border}`, padding: "4px 0" }}>
                    <span style={{ color: t.dim }}>{k}</span>
                    <span style={{ color: t.heading }}>{String(v ?? "—")}</span>
                  </div>
                ))}
            </div>
          </Section>
        )}

        {tab === "lines" && (
          <>
            <Section title="Existing Line Items" icon="list" isDark={isDark}>
              <ExistingLineItemTree isDark={isDark} items={lineItems} selected={selected} onToggleSelect={id => setSelected(s => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id); else n.add(id);
                return n;
              })} onUpdate={handleUpdateLine} />
              {selected.size > 0 && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <GhostButton label={busy ? "Deleting…" : `Delete Selected (${selected.size})`} icon="trash" isDark={isDark} danger onClick={handleDeleteSelected} />
                </div>
              )}
            </Section>

            <Section title="Add More Products" icon="plus" isDark={isDark} defaultOpen={false}>
              {!addingMore ? (
                <PrimaryButton label="Add More Products" icon="plus" isDark={isDark} onClick={() => setAddingMore(true)} />
              ) : detail.pricebookId ? (
                <>
                  <LineItemsEditor
                    isDark={isDark}
                    pricebookId={detail.pricebookId}
                    onChange={(roots, valid) => { setPendingRoots(roots); setPendingValid(valid); }}
                    existingLineItems={lineItems}
                    onAdjustExistingQuantity={handleAdjustExistingQuantity}
                  />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                    <GhostButton label="Cancel" isDark={isDark} onClick={() => { setAddingMore(false); setPendingRoots([]); }} />
                    <PrimaryButton label={busy ? "Saving…" : "Save New Line Items"} icon="check" isDark={isDark} disabled={!pendingValid || pendingRoots.length === 0 || busy} onClick={handleSaveNewLines} />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: t.dim }}>This quote has no resolvable Price Book — cannot add line items.</div>
              )}
            </Section>
          </>
        )}

        {tab === "bundle-tree" && (
          <Section title="Bundle Hierarchy (read-only)" icon="layers" isDark={isDark}>
            {!hierarchySupported && (
              <div style={{ fontSize: 12, color: t.dim, marginBottom: 10, display: "flex", gap: 6 }}>
                <Ic n="info" s={13} /> This org has no bundle hierarchy mechanism resolvable for QuoteLineItem — the list below is genuinely flat, not a collapsed hierarchy.
              </div>
            )}
            <ExistingLineItemTree isDark={isDark} items={lineItems} readOnly />
          </Section>
        )}

        {tab === "diagnostics" && (
          <>
            <Section title="This Session Only" icon="activity" isDark={isDark} defaultOpen>
              <div style={{ fontSize: 11.5, color: t.dim, marginBottom: 8 }}>
                Logs and responses reflect only actions taken in this browser session — not the quote&apos;s full history.
              </div>
              <PreviewPanel isDark={isDark} requestJson={{ quoteId, lineItemCount: lineItems.length }} />
            </Section>
            <Section title="Bundle Parity Comparison (native Salesforce vs. this app)" icon="layers" isDark={isDark} defaultOpen={false}>
              <BundleParityCheck isDark={isDark} quoteId={quoteId} />
            </Section>
            <Section title="HAR Import (ground-truth verification)" icon="upload" isDark={isDark} defaultOpen={false}>
              <HarImportTool isDark={isDark} />
            </Section>
          </>
        )}
      </div>
    </PageShell>
  );
}

function ExistingLineItemTree({ isDark, items, selected, onToggleSelect, onUpdate, readOnly }: {
  isDark: boolean; items: ExistingQuoteLineItem[]; selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onUpdate?: (id: string, patch: { quantity?: number; discountPercent?: number; unitPrice?: number }) => void;
  readOnly?: boolean;
}) {
  const t = tokens(isDark);
  function renderRows(nodes: ExistingQuoteLineItem[], depth: number) {
    return nodes.map(node => (
      <div key={node.id}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", marginLeft: depth * 18, borderBottom: `1px solid ${t.border}` }}>
          {!readOnly && onToggleSelect && (
            <input type="checkbox" checked={selected?.has(node.id) ?? false} onChange={() => onToggleSelect(node.id)} />
          )}
          <span style={{ flex: 1, fontSize: 12.5, color: t.heading, display: "flex", alignItems: "center", gap: 6 }}>
            {node.productName}
            {node.pricingInclusion && <Pill label="Included in bundle" color={t.accentCyan} isDark={isDark} />}
          </span>
          {readOnly ? (
            <>
              <span style={{ fontSize: 11.5, color: t.dim, width: 50 }}>{node.quantity}×</span>
              <span style={{ fontSize: 11.5, color: t.dim, width: 90 }}>{formatCurrency(node.unitPrice)}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: node.pricingInclusion ? t.dim : t.heading, width: 90 }}>
                {node.pricingInclusion ? "—" : formatCurrency(node.totalPrice)}
              </span>
            </>
          ) : (
            <>
              <input type="number" defaultValue={node.quantity} onBlur={e => onUpdate?.(node.id, { quantity: Number(e.target.value) })} style={{ ...inputStyle(t), width: 56, padding: "4px 6px", fontSize: 11.5 }} />
              <input type="number" defaultValue={node.discount} onBlur={e => onUpdate?.(node.id, { discountPercent: Number(e.target.value) })} style={{ ...inputStyle(t), width: 56, padding: "4px 6px", fontSize: 11.5 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: node.pricingInclusion ? t.dim : t.heading, width: 90, textAlign: "right" }}>
                {node.pricingInclusion ? "—" : formatCurrency(node.totalPrice)}
              </span>
            </>
          )}
        </div>
        {renderRows(node.children, depth + 1)}
      </div>
    ));
  }
  if (items.length === 0) return <EmptyState isDark={isDark} icon="list" title="No line items on this quote yet" />;
  return <div>{renderRows(items, 0)}</div>;
}
