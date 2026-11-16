"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, GhostButton, PrimaryButton, Spinner, CodeBlock, EmptyState } from "@/components/data/quotes/shared";
import { StatusPill } from "@/components/data/billing/billingUi";
import AnchoredOverlay from "@/components/ui/AnchoredOverlay";
import FieldHelp from "@/components/help/FieldHelp";
import type { FieldHelpEntry } from "@/lib/help/fieldHelp";
import { overlayPanelStyle } from "@/lib/ui/overlay";
import { quoteApiGet, quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import type { RampCapabilities } from "@/lib/ramp/capabilities";
import type { GeneratedSegment, RampDealDraft, RampExecution } from "@/lib/ramp/types";

/** Shared RAMP UI pieces. All data comes from /api/ramp/* (server-side, per connected org). */

export interface RampEnv { capabilities: RampCapabilities | null; storage: { durable: boolean; warning: string | null; location: string } | null; instanceUrl: string | null; error: string | null; reload: () => void }

export function useRampEnv(): RampEnv {
  const [state, setState] = useState<Omit<RampEnv, "reload">>({ capabilities: null, storage: null, instanceUrl: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    quoteApiGet<{ capabilities: RampCapabilities; storage: RampEnv["storage"]; instanceUrl: string }>("Read RAMP capabilities", "/api/ramp/capabilities")
      .then(r => { if (live) setState({ capabilities: r.capabilities, storage: r.storage, instanceUrl: r.instanceUrl, error: null }); })
      .catch(e => { if (live) setState(s => ({ ...s, error: toErrorPanelData(e, "Couldn't read RAMP capabilities").message })); });
    return () => { live = false; };
  }, [n]);
  return { ...state, reload: () => setN(x => x + 1) };
}

/** GET with loading / error / reload — `url` null = don't load. */
export function useRampGet<T>(label: string, url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [st, setSt] = useState<{ url: string | null; data: T | null; error: string | null }>({ url: null, data: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    quoteApiGet<T>(label, url).then(d => { if (live) setSt({ url, data: d, error: null }); }).catch(e => { if (live) setSt({ url, data: null, error: toErrorPanelData(e, `${label} failed`).message }); });
    return () => { live = false; };
  }, [label, url, n]);
  return { data: st.url === url ? st.data : null, error: st.url === url ? st.error : null, loading: !!url && st.url !== url, reload: useCallback(() => setN(x => x + 1), []) };
}

export function sfLink(instanceUrl: string | null, id: string | null | undefined): string | null {
  return instanceUrl && id ? `${instanceUrl.replace(/\/+$/, "")}/${id}` : null;
}

export function SfId({ isDark, id, instanceUrl }: { isDark: boolean; id: string | null | undefined; instanceUrl: string | null }) {
  const t = tokens(isDark);
  if (!id) return <span style={{ color: t.dim }}>—</span>;
  const href = sfLink(instanceUrl, id);
  return href ? <a href={href} target="_blank" rel="noreferrer" style={{ color: t.accent, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5 }}>{id} ↗</a> : <code style={{ fontSize: 11.5 }}>{id}</code>;
}

export function Panel({ isDark, title, icon, right, children }: { isDark: boolean; title: string; icon?: string; right?: ReactNode; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <section style={{ border: `1px solid ${t.border}`, borderRadius: 14, background: t.surface, boxShadow: t.shadow }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 800, fontSize: 13, color: t.heading }}>{icon && <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={icon} s={14} /></span>}{title}</div>
        {right}
      </header>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

export function Field({ isDark, label, hint, error, children, width, help, required }: { isDark: boolean; label: string; hint?: string | null; error?: string | null; children: ReactNode; width?: number;
  /** ⓘ help (the app's shared FieldHelp / TaxInfoTip) — content from lib/ramp/help.ts RAMP_FIELD_HELP. */
  help?: FieldHelpEntry | null; required?: boolean }) {
  const t = tokens(isDark);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: width ?? 180, flex: `1 1 ${width ?? 180}px` }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}{required && <span aria-hidden="true" style={{ color: t.error }}>*</span>}
        {help && <FieldHelp isDark={isDark} label={label} entry={help} />}
      </span>
      {children}
      {error ? <span style={{ fontSize: 11, color: t.error }}>{error}</span> : hint ? <span style={{ fontSize: 11, color: t.dim }}>{hint}</span> : null}
    </label>
  );
}

export function TextIn({ isDark, value, onChange, type = "text", placeholder, disabled, ariaLabel, step, min }: { isDark: boolean; value: string | number | null | undefined; onChange: (v: string) => void; type?: string; placeholder?: string; disabled?: boolean; ariaLabel?: string; step?: string; min?: number }) {
  const t = tokens(isDark);
  return <input aria-label={ariaLabel} type={type} step={step} min={min} value={value ?? ""} placeholder={placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} style={{ ...inputStyle(t), opacity: disabled ? 0.6 : 1, colorScheme: isDark ? "dark" : "light" }} />;
}

export function SelectIn({ isDark, value, onChange, options, ariaLabel, disabled, placeholder = "— Select —" }: { isDark: boolean; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; ariaLabel?: string; disabled?: boolean; placeholder?: string | null }) {
  const t = tokens(isDark);
  return (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} style={{ ...inputStyle(t), opacity: disabled ? 0.6 : 1 }}>
      {placeholder !== null && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * Validate one /api/ramp/lookup page. A failed or malformed response THROWS (shown as an error) — it is never turned into an empty
 * list, so "nothing found" is only ever said when Salesforce really returned zero records.
 */
export function parseLookupPage<R>(r: unknown, requestedPage = 1): { rows: R[]; hasMore: boolean; page: number } {
  const o = (r && typeof r === "object" ? r : null) as { success?: unknown; error?: unknown; rows?: unknown; hasMore?: unknown; page?: unknown } | null;
  if (!o) throw new Error("The lookup returned no data.");
  if (o.success === false) throw new Error(typeof o.error === "string" && o.error ? o.error : "The Salesforce lookup failed.");
  if (!Array.isArray(o.rows)) throw new Error("The lookup response had no result list.");
  return { rows: o.rows as R[], hasMore: o.hasMore === true, page: typeof o.page === "number" ? o.page : requestedPage };
}

/** The lookup query for a picker — the key its results belong to (changing the search text or a filter = a new key). */
export function lookupQuery(type: string, q: string, params?: Record<string, string | null | undefined>): string {
  return new URLSearchParams({ type, q, ...Object.fromEntries(Object.entries(params ?? {}).filter((e): e is [string, string] => !!e[1])) }).toString();
}

/** Merge a further page into the rows already shown (dedupe by Id, keep order). */
export function appendPage<R extends { id: string }>(rows: R[], more: R[]): R[] {
  const seen = new Set(rows.map(r => r.id));
  return [...rows, ...more.filter(r => !seen.has(r.id))];
}

type PickerState<R> = { key: string | null; rows: R[]; page: number; hasMore: boolean; error: string | null; loadingMore: boolean };

/** Async search picker over /api/ramp/lookup (debounced, server-side search, paged). */
export function RecordPicker<R extends { id: string; name: string }>({ isDark, label, type, params, value, onPick, render, disabled, hint, emptyText = "No matches.", pageSize, help, required }: {
  isDark: boolean; label: string; type: string; params?: Record<string, string | null | undefined>; value: { id: string | null; name: string | null };
  onPick: (r: R | null) => void; render?: (r: R) => ReactNode; disabled?: boolean; hint?: string;
  /** Shown only when the lookup SUCCEEDED and returned zero records. */
  emptyText?: string; pageSize?: number; help?: FieldHelpEntry | null; required?: boolean;
}) {
  const t = tokens(isDark);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<PickerState<R>>({ key: null, rows: [], page: 1, hasMore: false, error: null, loadingMore: false });
  const [retry, setRetry] = useState(0);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const qs = lookupQuery(type, q, { ...params, ...(pageSize ? { pageSize: String(pageSize) } : {}) });
  const current = st.key === qs; // results on screen belong to THIS search + filters (never a previous account's / text's)
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      quoteApiGet<unknown>(`Search ${label}`, `/api/ramp/lookup?${qs}`)
        .then(r => { const p = parseLookupPage<R>(r); if (live) setSt({ key: qs, rows: p.rows, page: p.page, hasMore: p.hasMore, error: null, loadingMore: false }); })
        .catch(e => { if (live) setSt({ key: qs, rows: [], page: 1, hasMore: false, error: toErrorPanelData(e, "Search failed").message, loadingMore: false }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [open, qs, label, retry]);
  const loadMore = () => {
    if (!current || !st.hasMore || st.loadingMore) return;
    const next = st.page + 1;
    setSt(s => ({ ...s, loadingMore: true }));
    quoteApiGet<unknown>(`Search ${label}`, `/api/ramp/lookup?${qs}&page=${next}`)
      .then(r => { const p = parseLookupPage<R>(r, next); setSt(s => (s.key === qs ? { ...s, rows: appendPage(s.rows, p.rows), page: p.page, hasMore: p.hasMore, loadingMore: false } : s)); })
      .catch(e => setSt(s => (s.key === qs ? { ...s, loadingMore: false, error: toErrorPanelData(e, "Loading more failed").message } : s)));
  };
  const rows = current ? st.rows : null;
  const err = current ? st.error : null;
  return (
    <Field isDark={isDark} label={label} hint={hint} help={help} required={required}>
      <div>
        <button ref={anchor} type="button" disabled={disabled} onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
          style={{ ...inputStyle(t), textAlign: "left", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1, display: "flex", justifyContent: "space-between", gap: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: value.id ? t.heading : t.dim }}>{value.name ?? (value.id ? value.id : "Search…")}</span>
          <Ic n="chevron-down" s={12} />
        </button>
        <AnchoredOverlay anchorRef={anchor} open={open} onDismiss={() => setOpen(false)} maxHeight={320} minWidth={280} style={overlayPanelStyle(isDark, t.border)}>
          <div role="listbox" aria-label={label}>
            <div style={{ padding: 6, position: "sticky", top: 0, background: isDark ? "#06102a" : "#fff" }}>
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label}`} style={inputStyle(t)} />
            </div>
            {err && !rows?.length ? <div role="alert" style={{ padding: 10, fontSize: 12, color: t.error }}>Couldn&apos;t search Salesforce: {err} <button type="button" onClick={() => setRetry(n => n + 1)} style={{ marginLeft: 6, border: "none", background: "transparent", color: t.accent, cursor: "pointer", fontSize: 12, padding: 0 }}>Try again</button></div>
              : !rows ? <div style={{ padding: 10, display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Searching Salesforce…</div>
              : !rows.length ? <div style={{ padding: 10, fontSize: 12, color: t.dim }}>{emptyText}</div>
              : <>
                {rows.map(r => (
                  <button key={r.id} type="button" role="option" aria-selected={r.id === value.id} onClick={() => { onPick(r); setOpen(false); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", border: "none", borderTop: `1px solid ${t.border}`, background: r.id === value.id ? `${t.accent}14` : "transparent", color: t.body, cursor: "pointer", fontSize: 12.5 }}>
                    {render ? render(r) : r.name}
                  </button>
                ))}
                {err && <div role="alert" style={{ padding: "6px 10px", fontSize: 12, color: t.error }}>{err}</div>}
                {st.hasMore && <button type="button" onClick={loadMore} disabled={st.loadingMore} style={{ display: "block", width: "100%", textAlign: "center", padding: "7px 10px", border: "none", borderTop: `1px solid ${t.border}`, background: "transparent", color: t.accent, cursor: "pointer", fontSize: 12 }}>{st.loadingMore ? "Loading…" : "Load more"}</button>}
              </>}
            {value.id && <button type="button" onClick={() => { onPick(null); setOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", border: "none", borderTop: `1px solid ${t.border}`, background: "transparent", color: t.dim, cursor: "pointer", fontSize: 12 }}>Clear selection</button>}
          </div>
        </AnchoredOverlay>
      </div>
    </Field>
  );
}

export function Notice({ isDark, tone, children }: { isDark: boolean; tone: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const t = tokens(isDark);
  const c = tone === "error" ? t.error : tone === "warn" ? t.warn : tone === "ok" ? "#00C875" : t.accent;
  return <div role={tone === "error" ? "alert" : "status"} style={{ fontSize: 12.5, color: t.body, padding: "9px 12px", borderRadius: 10, border: `1px solid ${c}55`, background: `${c}10` }}>{children}</div>;
}

const UPLIFT_SOURCE: Record<string, string> = { override: "segment override", default: "schedule default", unset: "not configured — 0% sent", first: "first segment", trial: "free trial", none: "no change", price: "from price" };

export function SegmentTable({ isDark, segments, total, groupRamp = false }: { isDark: boolean; segments: GeneratedSegment[]; total?: number;
  /** Group ramp: no per-segment quantity (each line keeps its own); the discount is the segment group's (QuoteLineGroup.Discount). */
  groupRamp?: boolean }) {
  const t = tokens(isDark);
  if (!segments.length) return <EmptyState isDark={isDark} icon="calendar" title="No segments" hint="Set valid dates and a schedule to preview the segments." />;
  const cell = { padding: "6px 8px", borderTop: `1px solid ${t.border}` } as const;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 720 }}>
        <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["#", "Segment", "Start", "End", "Months", ...(groupRamp ? [] : ["Qty"]), groupRamp ? "Group discount" : "Discount", "Uplift → Salesforce", "Preview unit price"].map(h => <th key={h} style={{ padding: "6px 8px" }}>{h}</th>)}</tr></thead>
        <tbody>
          {segments.map(s => (
            <tr key={s.index}>
              <td style={cell}>{s.index + 1}</td>
              <td style={cell}><b style={{ color: t.heading }}>{s.name}</b>{s.kind !== "full" && <span style={{ marginLeft: 6, fontSize: 10.5, color: t.warn }}>{s.kind}</span>}</td>
              <td style={cell}>{s.startDate}</td><td style={cell}>{s.endDate}</td><td style={cell}>{s.months}</td>
              {!groupRamp && <td style={cell}>{s.quantity}</td>}<td style={cell}>{s.discount}%</td>
              <td style={{ ...cell, fontWeight: 700, color: s.upliftSource === "unset" ? t.warn : s.upliftPercent ? t.accent : t.body }} data-uplift-source={s.upliftSource}>{s.upliftPercent}%{s.upliftSource && <span style={{ display: "block", fontSize: 10, fontWeight: 400, color: s.upliftSource === "unset" ? t.warn : t.dim }}>{UPLIFT_SOURCE[s.upliftSource]}</span>}</td>
              <td style={cell}>{s.previewUnitPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: t.dim, marginTop: 6 }}>Preview only{typeof total === "number" ? ` (≈ ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} total)` : ""}. Salesforce receives the uplift % per segment; its pricing procedure computes the real prices, which the run reads back and verifies.</div>
    </div>
  );
}

const STEP_COLOR: Record<string, string> = { completed: "#00C875", skipped: "#94A3B8", failed: "#FF4066", running: "#3B82F6", waiting: "#F59E0B", pending: "#94A3B8" };

/**
 * Execution panel: drives the run one server-side step at a time (each request runs ONE step and saves a checkpoint), so closing the
 * page or a server restart never loses progress — reopening shows the saved state and "Resume" continues.
 */
export function ExecutionPanel({ isDark, executionId, instanceUrl, onChanged }: { isDark: boolean; executionId: string; instanceUrl: string | null; onChanged?: () => void }) {
  const t = tokens(isDark);
  const [ex, setEx] = useState<RampExecution | null>(null);
  const [deal, setDeal] = useState<RampDealDraft | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const load = useCallback(async () => {
    try { const r = await quoteApiGet<{ execution: RampExecution; deal: RampDealDraft | null }>("Read ramp execution", `/api/ramp/executions?id=${encodeURIComponent(executionId)}`); setEx(r.execution); setDeal(r.deal); setError(null); }
    catch (e) { setError(toErrorPanelData(e, "Couldn't read the execution").message); }
  }, [executionId]);
  useEffect(() => {
    let live = true;
    quoteApiGet<{ execution: RampExecution; deal: RampDealDraft | null }>("Read ramp execution", `/api/ramp/executions?id=${encodeURIComponent(executionId)}`)
      .then(r => { if (live) { setEx(r.execution); setDeal(r.deal); setError(null); } })
      .catch(e => { if (live) setError(toErrorPanelData(e, "Couldn't read the execution").message); });
    return () => { live = false; stop.current = true; };
  }, [executionId]);

  const drive = async () => {
    setRunning(true); setError(null); stop.current = false;
    try {
      let cur = ex;
      for (let i = 0; i < 200 && !stop.current; i++) {
        const r = await quoteApiPost<{ execution: RampExecution }>("Run ramp step", "/api/ramp/executions", { action: "step", id: executionId });
        cur = r.execution; setEx(cur);
        if (cur.status === "completed" || cur.status === "failed") break;
        if (cur.status === "waiting") await new Promise(res => setTimeout(res, 3000));
      }
    } catch (e) { setError(toErrorPanelData(e, "The step couldn't run").message); }
    finally { setRunning(false); onChanged?.(); }
  };
  const retry = async () => {
    try { const r = await quoteApiPost<{ execution: RampExecution }>("Retry ramp step", "/api/ramp/executions", { action: "retry", id: executionId }); setEx(r.execution); await drive(); }
    catch (e) { setError(toErrorPanelData(e, "Retry failed").message); }
  };

  if (!ex) return error ? <Notice isDark={isDark} tone="error">{error}</Notice> : <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Loading execution…</div>;
  const done = ex.status === "completed";
  return (
    <div data-testid="execution-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <StatusPill status={ex.status} isDark={isDark} />
        <span style={{ fontSize: 12, color: t.dim }}>{deal?.name ?? ex.dealId} · {ex.kind} ramp · run {ex.id}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {!done && ex.status !== "failed" && ex.status !== "interrupted" && <PrimaryButton isDark={isDark} label={running ? "Running…" : ex.status === "pending" ? "Run" : "Resume"} icon="zap" disabled={running} onClick={() => void drive()} />}
          {(ex.status === "failed" || ex.status === "interrupted") && <PrimaryButton isDark={isDark} label={running ? "Running…" : "Retry failed step"} icon="refresh" disabled={running} onClick={() => void retry()} />}
          {running && <GhostButton isDark={isDark} label="Pause" icon="x" onClick={() => { stop.current = true; }} />}
          <GhostButton isDark={isDark} label="Refresh" icon="refresh" onClick={() => void load()} />
        </div>
      </div>
      {error && <Notice isDark={isDark} tone="error">{error}</Notice>}
      {done && <Notice isDark={isDark} tone="ok"><b>Completed and verified in Salesforce.</b> Every check below was read back from Salesforce after pricing.</Notice>}
      <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
        {ex.steps.map((s, i) => (
          <li key={s.id} style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: "8px 10px", background: t.surfaceAlt }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 20, height: 20, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#fff", background: STEP_COLOR[s.status] }}>{i + 1}</span>
              <b style={{ fontSize: 12.5, color: t.heading }}>{s.label}</b>
              <span style={{ fontSize: 11, fontWeight: 700, color: STEP_COLOR[s.status] }}>{s.status}</span>
              {s.attempts > 1 && <span style={{ fontSize: 10.5, color: t.dim }}>attempt {s.attempts}</span>}
            </div>
            {s.message && <div style={{ fontSize: 12, color: s.status === "failed" ? t.error : t.body, marginTop: 4, marginLeft: 28 }}>{s.message}</div>}
            {s.calls.length > 0 && <div style={{ marginLeft: 28, marginTop: 4 }}><CodeBlock isDark={isDark} label={`Salesforce requests (${s.calls.length})`} data={s.calls} /></div>}
          </li>
        ))}
      </ol>
      {(ex.sf.rampIdentifier || ex.sf.segmentGroupIds.length > 0 || ex.sf.contextId) && (
        <div style={{ fontSize: 12, color: t.body, display: "flex", gap: 14, flexWrap: "wrap" }}>
          {ex.sf.contextId && <span>Context: <code>{ex.sf.contextId.slice(0, 16)}…</code></span>}
          {ex.sf.rampIdentifier && <span>RampIdentifier: <code>{ex.sf.rampIdentifier}</code></span>}
          {ex.sf.segmentGroupIds.length > 0 && <span>Segment groups: {ex.sf.segmentGroupIds.map(id => <SfId key={id} isDark={isDark} id={id} instanceUrl={instanceUrl} />)}</span>}
          {ex.quote && <span>Quote: {ex.quote.calculationStatus ?? "—"} · LastPricedDate {ex.quote.lastPricedDate ?? "never"}</span>}
        </div>
      )}
      {ex.segments.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 760 }}>
            <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Segment line", "Dates", "Qty", "Disc", "Uplift", "Applied", "Method", "Unit", "Net unit", "Net total"].map(h => <th key={h} style={{ padding: "5px 6px" }}>{h}</th>)}</tr></thead>
            <tbody>{ex.segments.map(s => (
              <tr key={s.id} style={{ borderTop: `1px solid ${t.border}` }}>
                <td style={{ padding: "5px 6px" }}><SfId isDark={isDark} id={s.id} instanceUrl={instanceUrl} /><div style={{ fontSize: 10.5, color: t.dim }}>{s.name}</div></td>
                <td style={{ padding: "5px 6px" }}>{s.startDate} → {s.endDate}</td><td style={{ padding: "5px 6px" }}>{s.quantity}</td><td style={{ padding: "5px 6px" }}>{s.discount ?? 0}%</td>
                <td style={{ padding: "5px 6px" }}>{s.unitPriceUplift ?? 0}%</td><td style={{ padding: "5px 6px" }}>{s.appliedUpliftPct ?? "—"}{s.appliedUpliftPct !== null ? "%" : ""}</td><td style={{ padding: "5px 6px" }}>{s.rampUpliftType ?? "—"}</td>
                <td style={{ padding: "5px 6px" }}>{s.unitPrice ?? "—"}</td><td style={{ padding: "5px 6px", fontWeight: 700 }}>{s.netUnitPrice ?? "—"}</td><td style={{ padding: "5px 6px" }}>{s.netTotalPrice ?? "—"}</td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}
      {ex.verification.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Verification ({ex.verification.filter(c => c.passed).length}/{ex.verification.length} passed)</div>
          <div style={{ display: "grid", gap: 3 }}>
            {ex.verification.map(c => <div key={c.id} style={{ fontSize: 12, color: c.passed ? t.body : c.severity === "info" ? t.warn : t.error }}>{c.passed ? "✓" : c.severity === "info" ? "ℹ" : "✗"} {c.label} — expected {c.expected ?? "—"}, Salesforce {c.actual ?? "—"}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

export function StorageBanner({ isDark, storage }: { isDark: boolean; storage: RampEnv["storage"] }) {
  if (!storage || storage.durable) return null;
  return <Notice isDark={isDark} tone="warn"><b>RAMP history isn&apos;t durable on this deployment.</b> {storage.warning}</Notice>;
}
