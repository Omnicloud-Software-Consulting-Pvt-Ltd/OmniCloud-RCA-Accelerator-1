"use client";

import { useEffect, useMemo, useState } from "react";
import { tokens, GhostButton, PrimaryButton, EmptyState, Spinner } from "@/components/data/quotes/shared";
import { Modal, StatusPill } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { applySavedSchedule, blankSchedule, contractEndFor, generateSchedule } from "@/lib/ramp/schedule";
import type { RampCapabilities } from "@/lib/ramp/capabilities";
import type { LineFacts, Reason } from "@/lib/ramp/eligibility";
import type { DealKind, RampDealDraft, RampExecution, RampSchedule } from "@/lib/ramp/types";
import { SCHEDULE_LABELS, ScheduleEditor, schedulePatchOf, scheduleTouched } from "./RampSchedules";
import RampAiAssist, { RampHelpPanel, uiConflicts, type AiApplyOutcome } from "./RampAiAssist";
import { mergeAiPatch } from "@/lib/ramp/aiSchema";
import { RAMP_FIELD_HELP as H } from "@/lib/ramp/help";
import type { RampAiFormResult } from "@/lib/ramp/server/aiForms";
import { QuoteOption, quoteLabel } from "./RampQuoteOption";
import type { QuoteSearchRow } from "@/lib/ramp/server/reads";
import GroupRampBuilder, { type GroupDiag, type QuoteLinesData } from "./GroupRampBuilder";
import { ExecutionPanel, Field, Notice, Panel, RecordPicker, SegmentTable, SelectIn, SfId, TextIn, useRampGet } from "./rampUi";

type Draft = Partial<RampDealDraft> & { kind: DealKind; schedule: RampDealDraft["schedule"] };
type LineRow = LineFacts & { productName: string | null; segmentName: string | null; eligible: boolean; reasons: Reason[] };

type DealRow = RampDealDraft & { execution: (Omit<RampExecution, "steps"> & { step: string | null }) | null };

function emptySchedule(): RampDealDraft["schedule"] {
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...s } = blankSchedule();
  void _i; void _c; void _u; void _b; void _v;
  return s;
}
export function blankDeal(kind: DealKind): Draft {
  const today = new Date().toISOString().slice(0, 10);
  const schedule = { ...emptySchedule(), name: "Deal schedule" };
  return { kind, name: "", schedule, contractStart: today, contractEnd: contractEndFor(schedule, today) ?? today, basePrice: 0, baseQuantity: 1, periodBoundary: "Anniversary", accountId: null, accountName: null, quoteId: null, quoteName: null, lineId: null, groupId: null, groupName: null, productId: null, productName: null, sellingModelId: null, scheduleId: null };
}

function Reasons({ isDark, reasons }: { isDark: boolean; reasons: Reason[] }) {
  const t = tokens(isDark);
  if (!reasons.length) return null;
  return <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>{reasons.map((r, i) => <li key={i} style={{ color: r.severity === "error" ? t.error : t.warn }}>{r.message}</li>)}</ul>;
}

/** Editor for one line or group ramp deal: pick Salesforce records, check eligibility, apply a schedule, preview, save, execute. */
function DealEditor({ isDark, caps, instanceUrl, initial, onClose }: { isDark: boolean; caps: RampCapabilities | null; instanceUrl: string | null; initial: Draft; onClose: (changed: boolean) => void }) {
  const t = tokens(isDark);
  const notify = useNotify();
  const [raw, setD] = useState<Draft>(initial);
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [execId, setExecId] = useState<string | null>(initial.executionId ?? null);
  const schedules = useRampGet<{ rows: RampSchedule[] }>("Load ramp schedules", "/api/ramp/schedules");
  const qLines = useRampGet<{ rows: LineRow[] } & QuoteLinesData>("Read quote lines", raw.quoteId ? `/api/ramp/lookup?type=quote-lines&quoteId=${encodeURIComponent(raw.quoteId)}` : null);
  const gElig = useRampGet<GroupDiag>("Check group eligibility", raw.kind === "group" && raw.quoteId && raw.groupId ? `/api/ramp/lookup?type=group-eligibility&quoteId=${encodeURIComponent(raw.quoteId)}&groupId=${encodeURIComponent(raw.groupId)}` : null);
  const line = qLines.data?.rows.find(l => l.id === raw.lineId) ?? null;
  const locked = !!execId;

  // Line ramp: Salesforce splits THAT line's term, so the line's own dates + product always win (derived, never edited).
  const d: Draft = raw.kind === "line" && line && !locked
    ? { ...raw, productId: line.productId, productName: line.productName, sellingModelId: line.sellingModelId, contractStart: line.startDate ?? raw.contractStart, contractEnd: line.endDate ?? raw.contractEnd }
    : raw;

  // AI: merge the validated, Salesforce-resolved result into THIS form. Records the user already picked are never replaced silently;
  // a different AI quote carries its line / group along in one confirmation.
  const onAi = (r: RampAiFormResult): AiApplyOutcome => {
    const top = Object.fromEntries(Object.entries(r.patch).filter(([k]) => k !== "schedule")) as Partial<Draft>;
    const base = blankDeal(raw.kind);
    const m = mergeAiPatch<Draft>(raw, top, {
      defaults: base, replace: r.replace,
      labels: { name: "Deal name", accountId: "Account", quoteId: "Quote", lineId: "Quote line", groupId: "Quote line group", scheduleId: "Saved schedule", contractStart: "Contract start", contractEnd: "Contract end", periodBoundary: "Period boundary", baseQuantity: "Base quantity", basePrice: "Base unit price" },
      refs: [
        { key: "accountId", with: ["accountName"], resets: ["quoteId", "quoteName", "lineId", "groupId", "groupName"] },
        { key: "quoteId", with: ["quoteName"], resets: ["lineId", "groupId", "groupName"] },
        { key: "lineId", with: ["productId", "productName", "sellingModelId", "basePrice", "baseQuantity", "contractStart", "contractEnd"] },
        { key: "groupId", with: ["groupName"] },
        { key: "scheduleId" },
      ],
    });
    const sm = mergeAiPatch<Draft["schedule"]>(m.next.schedule, schedulePatchOf(r.patch.schedule as Record<string, unknown> | undefined), { defaults: base.schedule, refs: [], replace: r.replace || (m.applied.includes("scheduleId")), labels: SCHEDULE_LABELS });
    setD({ ...m.next, schedule: sm.next });
    return { applied: [...m.applied, ...sm.applied.map(k => `schedule.${k}`)], conflicts: [...uiConflicts(m.conflicts, p => setD(x => ({ ...x, ...p }))), ...uiConflicts(sm.conflicts, p => setD(x => ({ ...x, schedule: { ...x.schedule, ...p } })), "schedule.")] };
  };

  const pv = useMemo(() => generateSchedule(d.schedule, { contractStart: d.contractStart ?? "", contractEnd: d.contractEnd ?? "", basePrice: d.basePrice ?? 0, baseQuantity: d.baseQuantity ?? 1, ignoreQuantityOverrides: d.kind === "group" }), [d.schedule, d.contractStart, d.contractEnd, d.basePrice, d.baseQuantity, d.kind]);
  const blocked: string[] = [];
  if (d.kind === "group" && caps && !caps.groupRamp.available) blocked.push(caps.groupRamp.reason ?? "Group ramps aren't supported in this org.");
  if (d.kind === "line" && caps && !caps.lineRamp.available) blocked.push(caps.lineRamp.reason ?? "Line ramps aren't supported in this org.");
  if (d.kind === "line" && d.schedule.period !== "Yearly") blocked.push("Line ramps use Salesforce's Yearly segments only — use a Group Ramp for monthly / quarterly / custom periods.");
  if (d.kind === "line" && d.schedule.upliftMethod === "Compound" && caps && !caps.compound.line) blocked.push(caps.compound.reason ?? "Compound uplift isn't writable on quote lines in this org — use a Group Ramp.");
  if (d.kind === "line" && line && !line.eligible) blocked.push("The selected line isn't eligible (see below).");
  if (d.kind === "group" && gElig.data && !gElig.data.eligible) blocked.push("The selected group isn't eligible (see below).");
  if (pv.issues.some(i => i.severity === "error")) blocked.push("Fix the schedule errors first.");

  const save = async (): Promise<RampDealDraft | null> => {
    setBusy(true); setErr(null);
    try {
      const r = await quoteApiPost<{ deal: RampDealDraft }>("Save ramp deal", "/api/ramp/deals", { deal: { ...d, schedule: { ...d.schedule, name: d.schedule.name || d.name } } });
      setD(x => ({ ...x, ...r.deal }));
      notify.success("Ramp deal saved", `${r.deal.name} — nothing was written to Salesforce yet.`, { module: "RAMP" });
      return r.deal;
    } catch (e) { setErr(toErrorPanelData(e, "Couldn't save the deal").message); return null; }
    finally { setBusy(false); }
  };
  const execute = async () => {
    setConfirmRun(false);
    const saved = d.id && locked ? d as RampDealDraft : await save();
    if (!saved) return;
    try { const r = await quoteApiPost<{ execution: RampExecution }>("Start ramp execution", "/api/ramp/executions", { action: "start", dealId: saved.id, confirmed: true }); setExecId(r.execution.id); }
    catch (e) { setErr(toErrorPanelData(e, "Couldn't start the execution").message); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!locked && <RampAiAssist isDark={isDark} form={raw.kind === "group" ? "group-deal" : "deal"} helpKey={raw.kind === "group" ? "groupDeal" : "deal"} title={raw.kind === "group" ? "Configure a Group Ramp Deal" : "Configure a Ramp Deal"}
        context={{ name: raw.name || null, accountId: raw.accountId ?? null, accountName: raw.accountName ?? null, quoteId: raw.quoteId ?? null, quoteName: raw.quoteName ?? null, lineId: raw.lineId ?? null, groupId: raw.groupId ?? null, groupName: raw.groupName ?? null, productName: line?.productName ?? null, scheduleSet: scheduleTouched(raw.schedule) }} onResult={onAi} />}
      <Panel isDark={isDark} title={d.id ? `${d.kind === "group" ? "Group ramp" : "Ramp deal"} — ${d.name}` : d.kind === "group" ? "New group ramp deal" : "New ramp deal"} icon={d.kind === "group" ? "layers" : "trending-up"}
        right={<div style={{ display: "flex", gap: 6 }}><GhostButton isDark={isDark} label="Back to list" onClick={() => onClose(!!d.id)} />{!locked && <GhostButton isDark={isDark} label={busy ? "Saving…" : "Save draft"} icon="check" disabled={busy} onClick={() => void save()} />}{!locked && <PrimaryButton isDark={isDark} label="Execute in Salesforce…" icon="zap" disabled={busy || blocked.length > 0} onClick={() => setConfirmRun(true)} />}</div>}>
        {err && <Notice isDark={isDark} tone="error">{err}</Notice>}
        {locked && <Notice isDark={isDark} tone="info">This deal has an execution — its Salesforce inputs are locked. Resume or retry it below.</Notice>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field isDark={isDark} label="Deal name" required help={H.dealName}><TextIn isDark={isDark} ariaLabel="Deal name" disabled={locked} value={d.name} onChange={v => set({ name: v })} /></Field>
          {d.kind === "line" && <>
          <RecordPicker<{ id: string; name: string }> isDark={isDark} label="Account" help={H.account} type="accounts" disabled={locked} value={{ id: d.accountId ?? null, name: d.accountName ?? null }} onPick={r => set({ accountId: r?.id ?? null, accountName: r?.name ?? null, quoteId: null, quoteName: null, lineId: null, groupId: null, groupName: null })} />
          <RecordPicker<QuoteSearchRow> key={d.accountId ?? "any"} isDark={isDark} label="Quote (Draft)" required help={H.quote} type="quotes" params={{ accountId: d.accountId }} disabled={locked} value={{ id: d.quoteId ?? null, name: d.quoteName ?? null }}
            emptyText={d.accountId ? `No Draft Quotes found for ${d.accountName ?? "this Account"}.` : "No Draft Quotes found."}
            render={r => <QuoteOption isDark={isDark} r={r} showAccount={!d.accountId} />} onPick={r => set({ quoteId: r?.id ?? null, quoteName: r ? quoteLabel(r) : null, lineId: null, groupId: null, groupName: null })}
            hint={d.accountId ? "Draft quotes of the selected account (Quote Account or Account)." : "Only Draft quotes can be ramped — pick an account to narrow the list."} />
          </>}
        </div>
        {d.kind === "group" && (
          <GroupRampBuilder isDark={isDark} instanceUrl={instanceUrl} locked={locked}
            d={{ accountId: d.accountId ?? null, accountName: d.accountName ?? null, quoteId: d.quoteId ?? null, quoteName: d.quoteName ?? null, groupId: d.groupId ?? null, groupName: d.groupName ?? null, contractStart: d.contractStart ?? null, contractEnd: d.contractEnd ?? null }}
            set={p => set(p)} quoteData={qLines.data} quoteLoading={qLines.loading} quoteError={qLines.error} reloadQuote={qLines.reload}
            diag={gElig.data} diagLoading={gElig.loading} diagError={gElig.error} reloadDiag={gElig.reload} />
        )}
        {d.kind === "line" && d.quoteId && (qLines.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Reading quote lines…</div>
          : qLines.error ? <Notice isDark={isDark} tone="error">{qLines.error}</Notice>
          : (
            <Field isDark={isDark} label="Quote line to ramp" required help={H.quoteLine} hint="Salesforce splits this line's term into segment lines sharing a RampIdentifier.">
              <SelectIn isDark={isDark} ariaLabel="Quote line" disabled={locked} value={d.lineId ?? ""} onChange={v => { const l = qLines.data?.rows.find(x => x.id === v); set({ lineId: v || null, ...(l ? { basePrice: l.unitPrice ?? 0, baseQuantity: l.quantity ?? 1 } : {}) }); }}
                options={(qLines.data?.rows ?? []).filter(l => !l.rampIdentifier || l.id === d.lineId).map(l => ({ value: l.id, label: `${l.productName ?? l.productId} · ${l.startDate ?? "?"} → ${l.endDate ?? "?"} · qty ${l.quantity ?? "?"}${l.eligible ? "" : " (not eligible)"}` }))} />
            </Field>
          ))}
        {d.kind === "line" && line && <><Reasons isDark={isDark} reasons={line.reasons} />{line.eligible && <Notice isDark={isDark} tone="ok">Line <SfId isDark={isDark} id={line.id} instanceUrl={instanceUrl} /> is eligible ({line.productName}).</Notice>}</>}
      </Panel>

      <Panel isDark={isDark} title="Schedule" icon="calendar" right={
        <SelectIn isDark={isDark} ariaLabel="Apply saved schedule" disabled={locked} value={d.scheduleId ?? ""} placeholder="— Apply a saved schedule —"
          options={(schedules.data?.rows ?? []).map(s => ({ value: s.id, label: `${s.name} (v${s.version})` }))}
          onChange={v => { const p = applySavedSchedule(d, schedules.data?.rows.find(x => x.id === v) ?? null); set(p as Partial<Draft>); }} />}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field isDark={isDark} label="Contract start" required help={H.contractDates} width={160} hint={d.kind === "line" ? "From the quote line." : null}><TextIn isDark={isDark} type="date" ariaLabel="Contract start" disabled={locked || d.kind === "line"} value={d.contractStart} onChange={v => set({ contractStart: v })} /></Field>
          <Field isDark={isDark} label="Contract end" required help={H.contractDates} width={160} hint={d.kind === "line" ? "From the quote line." : null}><TextIn isDark={isDark} type="date" ariaLabel="Contract end" disabled={locked || d.kind === "line"} value={d.contractEnd} onChange={v => set({ contractEnd: v })} /></Field>
          <Field isDark={isDark} label="Base unit price" width={140} hint="Preview only — Salesforce prices it."><TextIn isDark={isDark} type="number" ariaLabel="Base unit price" disabled={locked} value={d.basePrice} onChange={v => set({ basePrice: Number(v) || 0 })} /></Field>
          {d.kind === "line" && <Field isDark={isDark} label="Base quantity" width={120}><TextIn isDark={isDark} type="number" ariaLabel="Base quantity" disabled={locked} value={d.baseQuantity} onChange={v => set({ baseQuantity: Number(v) || 1 })} /></Field>}
          {d.kind === "line" && <Field isDark={isDark} label="Period boundary" help={H.periodBoundary} width={160}><SelectIn isDark={isDark} ariaLabel="Period boundary" disabled={locked} placeholder={null} value={d.periodBoundary ?? "Anniversary"} onChange={v => set({ periodBoundary: v as RampDealDraft["periodBoundary"] })} options={["Anniversary", "AlignToCalendar", "DayOfPeriod", "LastDayOfPeriod"].map(v => ({ value: v, label: v }))} /></Field>}
        </div>
        {!locked && <ScheduleEditor isDark={isDark} value={d.schedule} showName={false} groupRamp={d.kind === "group"} onChange={v => set({ schedule: v })} />}
        {pv.issues.map((i, k) => <Notice key={k} isDark={isDark} tone={i.severity === "error" ? "error" : "warn"}>{i.message}</Notice>)}
        {blocked.length > 0 && !locked && <Notice isDark={isDark} tone="warn"><b>Can&apos;t execute yet:</b><ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>{blocked.map((b, i) => <li key={i}>{b}</li>)}</ul></Notice>}
        <SegmentTable isDark={isDark} segments={pv.segments} total={pv.previewTotal} groupRamp={d.kind === "group"} />
      </Panel>

      {execId && <Panel isDark={isDark} title="Execution" icon="activity"><ExecutionPanel isDark={isDark} executionId={execId} instanceUrl={instanceUrl} /></Panel>}

      {confirmRun && (
        <Modal isDark={isDark} title="Write this ramp to Salesforce?" tone="warn" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirmRun(false)} /><PrimaryButton isDark={isDark} label="Yes, execute" icon="zap" onClick={() => void execute()} /></>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <div>This modifies quote <b>{d.quoteName}</b> ({d.quoteId}) in Salesforce:</div>
            {d.kind === "line"
              ? <ul style={{ margin: 0, paddingLeft: 18 }}><li>Ramp Deal API splits line {d.lineId} into {pv.segments.length} segment lines (Place Sales Transaction commits them).</li><li>Segment quantity / discount / uplift are updated where they differ.</li><li>The quote is re-priced (pricingPref Force) and every value is read back and verified.</li></ul>
              : <ul style={{ margin: 0, paddingLeft: 18 }}><li>Group {d.groupName} becomes ramp segment 1 (groupRampAction EditGroup — used only for this conversion).</li><li>Salesforce clones it {pv.segments.length - 1} time(s) for the next segments, then dates and uplifts ({d.schedule.upliftMethod}) are set per segment.</li><li>The quote is re-priced (Force) and every value is read back and verified.</li></ul>}
            <div style={{ color: t.dim }}>Each step is checkpointed — if anything stops, Resume continues without repeating completed writes.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Ramp Deals (line) and Group Ramp Deals pages. */
export default function RampDeals({ isDark, kind, caps, instanceUrl, draft, onDraftUsed }: { isDark: boolean; kind: DealKind; caps: RampCapabilities | null; instanceUrl: string | null; draft?: Partial<RampDealDraft> | null; onDraftUsed?: () => void }) {
  const t = tokens(isDark);
  const notify = useNotify();
  const list = useRampGet<{ rows: DealRow[] }>("Load ramp deals", `/api/ramp/deals?kind=${kind}`);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState<DealRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // An AI Builder draft opens straight in the editor (the workspace remounts this page per view, so the initializer sees it).
  const [edit, setEdit] = useState<Draft | null>(() => { if (!draft) return null; const base = blankDeal(kind); return { ...base, ...draft, kind, schedule: { ...base.schedule, ...(draft.schedule ?? {}) } } as Draft; });
  useEffect(() => { if (draft) onDraftUsed?.(); }, [draft, onDraftUsed]);

  const rows = (list.data?.rows ?? []).filter(r => (!q || `${r.name} ${r.quoteName ?? ""} ${r.accountName ?? ""} ${r.productName ?? ""} ${r.groupName ?? ""}`.toLowerCase().includes(q.toLowerCase())) && (!status || (r.execution?.status ?? "draft") === status));
  const PAGE = 15, pages = Math.max(1, Math.ceil(rows.length / PAGE)), cur = Math.min(page, pages);

  const remove = async (r: DealRow) => {
    try { const res = await fetch(`/api/ramp/deals?id=${encodeURIComponent(r.id)}`, { method: "DELETE" }); const j = await res.json(); if (!res.ok || j.success === false) throw new Error(j.error ?? `HTTP ${res.status}`); notify.success("Ramp deal deleted", r.name, { module: "RAMP" }); list.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setConfirmDelete(null); }
  };

  if (edit) return <DealEditor key={edit.id ?? "new"} isDark={isDark} caps={caps} instanceUrl={instanceUrl} initial={edit} onClose={() => { setEdit(null); list.reload(); }} />;

  const unsupported = kind === "group" ? caps && !caps.groupRamp.available ? caps.groupRamp.reason : null : caps && !caps.lineRamp.available ? caps.lineRamp.reason : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <RampHelpPanel isDark={isDark} helpKey={kind === "group" ? "groupDeal" : "deal"} />
      {kind === "group"
        ? <Notice isDark={isDark} tone="info">A <b>Group Ramp</b> ramps every line of a quote line group together using Salesforce&apos;s group ramp APIs: the group becomes ramp segment 1 (ramped QuoteLineGroup), and Salesforce clones it for each next segment. Supports monthly / quarterly / yearly / custom segments and Standard or Compound uplift.</Notice>
        : <Notice isDark={isDark} tone="info">A <b>Ramp Deal</b> splits one quote line into yearly segment lines with Salesforce&apos;s Ramp Deal API, then sets each segment&apos;s quantity, discount and uplift and re-prices the quote.</Notice>}
      {unsupported && <Notice isDark={isDark} tone="warn"><b>Not supported in this org:</b> {unsupported}</Notice>}
      {err && <Notice isDark={isDark} tone="error">{err}</Notice>}
      <Panel isDark={isDark} title={`${kind === "group" ? "Group ramp deals" : "Ramp deals"}${list.data ? ` (${rows.length})` : ""}`} icon={kind === "group" ? "layers" : "trending-up"}
        right={<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input aria-label="Search deals" placeholder="Search…" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} style={{ padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.inputBg, color: t.heading, fontSize: 12 }} />
          <SelectIn isDark={isDark} ariaLabel="Filter by status" value={status} placeholder="All statuses" onChange={v => { setStatus(v); setPage(1); }} options={["draft", "pending", "in-progress", "waiting", "completed", "failed", "interrupted"].map(v => ({ value: v, label: v }))} />
          <PrimaryButton isDark={isDark} label={kind === "group" ? "New group ramp" : "New ramp deal"} icon="plus" onClick={() => setEdit(blankDeal(kind))} />
        </div>}>
        {list.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Loading…</div>
          : list.error ? <Notice isDark={isDark} tone="error">{list.error}</Notice>
          : !rows.length ? <EmptyState isDark={isDark} icon={kind === "group" ? "layers" : "trending-up"} title={q || status ? "No deals match" : "No deals yet"} hint={q || status ? "Clear the search or filter." : "Create one, or describe it to the AI Ramp Builder."} />
          : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 760 }}>
                <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Deal", "Account / Quote", kind === "group" ? "Group" : "Product", "Schedule", "Dates", "Status", ""].map(h => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
                <tbody>{rows.slice((cur - 1) * PAGE, cur * PAGE).map(r => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: 6 }}><b style={{ color: t.heading }}>{r.name}</b></td>
                    <td style={{ padding: 6 }}>{r.accountName ?? "—"}<div><SfId isDark={isDark} id={r.quoteId} instanceUrl={instanceUrl} /></div></td>
                    <td style={{ padding: 6 }}>{kind === "group" ? r.groupName ?? r.groupId : r.productName ?? "—"}</td>
                    <td style={{ padding: 6 }}>{r.schedule.segments} × {r.schedule.period} · {r.schedule.upliftMethod}</td>
                    <td style={{ padding: 6 }}>{r.contractStart} → {r.contractEnd}</td>
                    <td style={{ padding: 6 }}>{r.execution ? <><StatusPill status={r.execution.status} isDark={isDark} />{r.execution.step && r.execution.status !== "completed" && <div style={{ fontSize: 10.5, color: t.dim }}>at: {r.execution.step}</div>}</> : <span style={{ color: t.dim }}>draft</span>}</td>
                    <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                      <GhostButton isDark={isDark} label={r.execution ? "Open" : "Edit"} icon="edit" onClick={() => setEdit({ ...r })} />{" "}
                      {!r.execution && <GhostButton isDark={isDark} label="Delete" icon="trash" danger onClick={() => setConfirmDelete(r)} />}
                    </td>
                  </tr>))}</tbody>
              </table>
              {pages > 1 && <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", marginTop: 8, fontSize: 12, color: t.dim }}><GhostButton isDark={isDark} label="Prev" disabled={cur <= 1} onClick={() => setPage(cur - 1)} />Page {cur} / {pages}<GhostButton isDark={isDark} label="Next" disabled={cur >= pages} onClick={() => setPage(cur + 1)} /></div>}
            </div>
          )}
      </Panel>
      {confirmDelete && <Modal isDark={isDark} title="Delete this ramp deal?" tone="warn" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirmDelete(null)} /><PrimaryButton isDark={isDark} label="Delete" icon="trash" onClick={() => void remove(confirmDelete)} /></>}><div>{confirmDelete.name} — the app draft is removed (and recorded in history). Nothing in Salesforce changes.</div></Modal>}
    </div>
  );
}
