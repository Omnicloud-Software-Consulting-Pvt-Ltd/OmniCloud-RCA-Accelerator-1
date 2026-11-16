"use client";

import { useMemo, useState } from "react";
import { tokens, GhostButton, PrimaryButton, EmptyState, Spinner } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { blankSchedule, contractEndFor, generateSchedule, validateSchedule } from "@/lib/ramp/schedule";
import type { HistoryEvent, PeriodUnit, RampSchedule } from "@/lib/ramp/types";
import { Field, Notice, Panel, SegmentTable, SelectIn, TextIn, useRampGet } from "./rampUi";
import RampAiAssist, { RampHelpPanel, uiConflicts, type AiApplyOutcome } from "./RampAiAssist";
import { mergeAiPatch } from "@/lib/ramp/aiSchema";
import { RAMP_FIELD_HELP as H } from "@/lib/ramp/help";
import type { RampAiFormResult } from "@/lib/ramp/server/aiForms";

type ScheduleBody = Omit<RampSchedule, "id" | "createdAt" | "updatedAt" | "createdBy" | "version">;
export const SCHEDULE_KEYS = ["name", "description", "period", "customMonths", "segments", "trialMonths", "priceChange", "defaultChange", "upliftMethod", "basePriceMultiplier", "overrides"] as const;
export const SCHEDULE_LABELS: Partial<Record<keyof ScheduleBody, string>> = { name: "Schedule name", description: "Description", period: "Period", customMonths: "Months per segment", segments: "Number of segments", trialMonths: "Free trial months", priceChange: "Price change", defaultChange: "Default uplift / change", upliftMethod: "Uplift method", basePriceMultiplier: "Base price multiplier", overrides: "Per-segment overrides" };
export function blankScheduleBody(): ScheduleBody { const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...b } = blankSchedule(); void _i; void _c; void _u; void _b; void _v; return b; }
/** The schedule part of an AI result (keys that are schedule fields), for the schedule form and the deal editor. */
export function schedulePatchOf(p: Record<string, unknown> | undefined): Partial<ScheduleBody> {
  return Object.fromEntries(Object.entries(p ?? {}).filter(([k, v]) => (SCHEDULE_KEYS as readonly string[]).includes(k) && v !== undefined)) as Partial<ScheduleBody>;
}
/** Did the user set the period / segments themselves (vs. the blank defaults)? */
export const scheduleTouched = (s: Pick<ScheduleBody, "period" | "segments">) => { const b = blankScheduleBody(); return s.period !== b.period || s.segments !== b.segments; };
const num = (v: string) => (v === "" ? null : Number(v));

/** The schedule fields (shared by the Schedules page and the deal editor). */
export function ScheduleEditor({ isDark, value, onChange, showName = true, groupRamp = false }: { isDark: boolean; value: ScheduleBody; onChange: (v: ScheduleBody) => void; showName?: boolean;
  /** Group ramp: only what Salesforce group ramps take per segment GROUP — uplift (UnitPriceUplift) and discount (Discount); no per-segment quantity. */
  groupRamp?: boolean }) {
  const t = tokens(isDark);
  const set = (p: Partial<ScheduleBody>) => onChange({ ...value, ...p });
  const segN = value.segments || 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {showName && <Field isDark={isDark} label="Schedule name" required help={H.scheduleName}><TextIn isDark={isDark} ariaLabel="Schedule name" value={value.name} onChange={v => set({ name: v })} /></Field>}
        <Field isDark={isDark} label="Period" required help={H.period} hint={value.period === "Yearly" ? "Yearly = Salesforce's anniversary segments (line and group ramps)." : "Monthly / quarterly / custom boundaries run as a Group Ramp."}>
          <SelectIn isDark={isDark} ariaLabel="Period" value={value.period} placeholder={null} onChange={v => set({ period: v as PeriodUnit })} options={["Yearly", "Quarterly", "Monthly", "Custom"].map(v => ({ value: v, label: v }))} />
        </Field>
        {value.period === "Custom" && <Field isDark={isDark} label="Months per segment" required width={140}><TextIn isDark={isDark} type="number" ariaLabel="Months per segment" value={value.customMonths} onChange={v => set({ customMonths: num(v) })} /></Field>}
        <Field isDark={isDark} label="Number of segments" required help={H.segments} width={140}><TextIn isDark={isDark} type="number" ariaLabel="Number of segments" value={value.segments} onChange={v => set({ segments: Number(v) || 0 })} /></Field>
        <Field isDark={isDark} label="Free trial (months)" help={H.trialMonths} width={140} hint="Optional segment before the paid ones."><TextIn isDark={isDark} type="number" ariaLabel="Free trial months" value={value.trialMonths} onChange={v => set({ trialMonths: num(v) })} /></Field>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field isDark={isDark} label="Uplift method" help={H.upliftMethod} hint={value.upliftMethod === "Compound" ? "Each segment on top of the previous one (QuoteLineGroup.RampUpliftType = Compound)." : "Each segment relative to the base price."}>
          <SelectIn isDark={isDark} ariaLabel="Uplift method" value={value.upliftMethod} placeholder={null} onChange={v => set({ upliftMethod: v as ScheduleBody["upliftMethod"] })} options={[{ value: "Standard", label: "Standard" }, { value: "Compound", label: "Compound" }]} />
        </Field>
        <Field isDark={isDark} label="Price change" help={H.priceChange} hint="Converted to the % uplift Salesforce takes (UnitPriceUplift).">
          <SelectIn isDark={isDark} ariaLabel="Price change" value={value.priceChange} placeholder={null} onChange={v => set({ priceChange: v as ScheduleBody["priceChange"] })} options={[{ value: "percent", label: "Percentage per segment" }, { value: "fixed", label: "Fixed amount per segment" }, { value: "price", label: "Price per segment (overrides)" }, { value: "none", label: "No change" }]} />
        </Field>
        {(value.priceChange === "percent" || value.priceChange === "fixed") && <Field isDark={isDark} label={value.priceChange === "percent" ? "Default uplift %" : "Default increase"} help={H.defaultChange} width={140}><TextIn isDark={isDark} type="number" step="0.01" ariaLabel="Default change" value={value.defaultChange} onChange={v => set({ defaultChange: num(v) })} /></Field>}
        <Field isDark={isDark} label="Base price multiplier" help={H.basePriceMultiplier} width={140} hint="Applied to the base before uplifts (preview + conversion)."><TextIn isDark={isDark} type="number" step="0.01" ariaLabel="Base price multiplier" value={value.basePriceMultiplier} onChange={v => set({ basePriceMultiplier: Number(v) || 0 })} /></Field>
      </div>
      {segN > 0 && segN <= 60 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: t.accent }}>{groupRamp ? "Per-segment overrides — uplift / price and group discount (QuoteLineGroup.UnitPriceUplift / Discount); line quantities stay as they are" : "Per-segment overrides (uplift / price, quantity, discount)"}</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {Array.from({ length: segN }, (_, i) => i + 1).map(n => {
              const o = value.overrides.find(x => x.segment === n) ?? { segment: n, value: null, quantity: null, discount: null };
              const put = (p: Partial<typeof o>) => set({ overrides: [...value.overrides.filter(x => x.segment !== n), { ...o, ...p }].filter(x => x.value !== null || x.quantity !== null || x.discount !== null).sort((a, b) => a.segment - b.segment) });
              return (
                <div key={n} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <span style={{ width: 80, fontSize: 12, color: t.body, paddingBottom: 8 }}>Segment {n}</span>
                  <Field isDark={isDark} label={value.priceChange === "price" ? "Unit price" : value.priceChange === "fixed" ? "Increase" : "Uplift %"} width={120}><TextIn isDark={isDark} type="number" step="0.01" ariaLabel={`Segment ${n} value`} value={o.value} onChange={v => put({ value: num(v) })} /></Field>
                  {!groupRamp && <Field isDark={isDark} label="Quantity" width={110}><TextIn isDark={isDark} type="number" ariaLabel={`Segment ${n} quantity`} value={o.quantity} onChange={v => put({ quantity: num(v) })} /></Field>}
                  {<Field isDark={isDark} label={groupRamp ? "Group discount %" : "Discount %"} width={110}><TextIn isDark={isDark} type="number" step="0.01" ariaLabel={`Segment ${n} discount`} value={o.discount} onChange={v => put({ discount: num(v) })} /></Field>}
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

/** Ramp Schedules page — application templates (Salesforce has no ramp schedule object), with preview + history. */
export default function RampSchedules({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const notify = useNotify();
  const list = useRampGet<{ rows: RampSchedule[]; history: HistoryEvent[] }>("Load ramp schedules", "/api/ramp/schedules");
  const [edit, setEdit] = useState<(ScheduleBody & { id?: string }) | null>(null);
  const [preview, setPreview] = useState({ start: new Date().toISOString().slice(0, 10), price: 100, qty: 1 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RampSchedule | null>(null);
  const end = edit ? contractEndFor(edit, preview.start) : null;
  const pv = useMemo(() => (edit && end ? generateSchedule(edit, { contractStart: preview.start, contractEnd: end, basePrice: preview.price, baseQuantity: preview.qty }) : null), [edit, end, preview]);
  const errors = edit ? validateSchedule(edit) : [];
  const onAi = (r: RampAiFormResult): AiApplyOutcome => {
    const current = edit ?? blankScheduleBody();
    const m = mergeAiPatch<ScheduleBody & { id?: string }>(current, schedulePatchOf(r.patch), { defaults: blankScheduleBody(), refs: [], replace: r.replace, labels: SCHEDULE_LABELS });
    setEdit(m.next);
    return { applied: m.applied, conflicts: uiConflicts(m.conflicts, p => setEdit(e => ({ ...(e ?? blankScheduleBody()), ...p }))) };
  };

  const save = async () => {
    if (!edit) return;
    setBusy(true); setErr(null);
    try { await quoteApiPost("Save ramp schedule", "/api/ramp/schedules", { schedule: edit }); notify.success("Ramp schedule saved", edit.name, { module: "RAMP" }); setEdit(null); list.reload(); }
    catch (e) { setErr(toErrorPanelData(e, "Couldn't save the schedule").message); }
    finally { setBusy(false); }
  };
  const remove = async (s: RampSchedule) => {
    try { const r = await fetch(`/api/ramp/schedules?id=${encodeURIComponent(s.id)}`, { method: "DELETE" }); const j = await r.json(); if (!r.ok || j.success === false) throw new Error(j.error ?? `HTTP ${r.status}`); notify.success("Schedule deleted", s.name, { module: "RAMP" }); list.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setConfirmDelete(null); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!edit && <RampHelpPanel isDark={isDark} helpKey="schedule" />}
      <Notice isDark={isDark} tone="info">Salesforce has <b>no ramp schedule object</b> — schedules here are reusable application templates. A schedule becomes Salesforce data only when a ramp deal applies it to a quote (segment lines, or ramped quote line groups).</Notice>
      {err && <Notice isDark={isDark} tone="error">{err}</Notice>}
      {edit ? (
        <Panel isDark={isDark} title={edit.id ? `Edit schedule — ${edit.name}` : "New ramp schedule"} icon="calendar" right={<div style={{ display: "flex", gap: 6 }}><GhostButton isDark={isDark} label="Cancel" onClick={() => setEdit(null)} /><PrimaryButton isDark={isDark} label={busy ? "Saving…" : "Save schedule"} icon="check" disabled={busy || errors.length > 0} onClick={() => void save()} /></div>}>
          <RampAiAssist isDark={isDark} form="schedule" helpKey="schedule" title={edit.id ? "Edit the schedule" : "Create a schedule"} context={{ name: edit.name || null, scheduleSet: scheduleTouched(edit) }} onResult={onAi} />
          <Field isDark={isDark} label="Description"><TextIn isDark={isDark} ariaLabel="Description" value={edit.description} onChange={v => setEdit({ ...edit, description: v || null })} /></Field>
          <ScheduleEditor isDark={isDark} value={edit} onChange={v => setEdit({ ...edit, ...v })} />
          {errors.length > 0 && <Notice isDark={isDark} tone="error">{errors.join(" ")}</Notice>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <Field isDark={isDark} label="Preview start" width={160}><TextIn isDark={isDark} type="date" ariaLabel="Preview start" value={preview.start} onChange={v => setPreview({ ...preview, start: v })} /></Field>
            <Field isDark={isDark} label="Preview base price" width={140}><TextIn isDark={isDark} type="number" ariaLabel="Preview base price" value={preview.price} onChange={v => setPreview({ ...preview, price: Number(v) || 0 })} /></Field>
            <Field isDark={isDark} label="Preview quantity" width={120}><TextIn isDark={isDark} type="number" ariaLabel="Preview quantity" value={preview.qty} onChange={v => setPreview({ ...preview, qty: Number(v) || 1 })} /></Field>
            <span style={{ fontSize: 12, color: t.dim, paddingBottom: 8 }}>Contract end: {end ?? "—"}</span>
          </div>
          {pv?.issues.map((i, k) => <Notice key={k} isDark={isDark} tone={i.severity === "error" ? "error" : "warn"}>{i.message}</Notice>)}
          {pv && <SegmentTable isDark={isDark} segments={pv.segments} total={pv.previewTotal} />}
        </Panel>
      ) : (
        <Panel isDark={isDark} title={`Ramp schedules${list.data ? ` (${list.data.rows.length})` : ""}`} icon="calendar" right={<PrimaryButton isDark={isDark} label="New schedule" icon="plus" onClick={() => { const { id: _id, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...b } = blankSchedule(); void _id; void _c; void _u; void _b; void _v; setEdit(b); }} />}>
          {list.loading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Loading…</div>
            : list.error ? <Notice isDark={isDark} tone="error">{list.error}</Notice>
            : !list.data?.rows.length ? <EmptyState isDark={isDark} icon="calendar" title="No schedules yet" hint="Create a reusable schedule (e.g. 3 yearly segments, +5% per year) to apply to ramp deals." />
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Name", "Period", "Segments", "Trial", "Change", "Method", "Version", "Updated", ""].map(h => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
                <tbody>{list.data.rows.map(s => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: 6 }}><b style={{ color: t.heading }}>{s.name}</b>{s.description && <div style={{ fontSize: 11, color: t.dim }}>{s.description}</div>}</td>
                    <td style={{ padding: 6 }}>{s.period}{s.period === "Custom" ? ` (${s.customMonths} mo)` : ""}</td><td style={{ padding: 6 }}>{s.segments}</td><td style={{ padding: 6 }}>{s.trialMonths ? `${s.trialMonths} mo` : "—"}</td>
                    <td style={{ padding: 6 }}>{s.priceChange === "percent" ? `${s.defaultChange ?? 0}%` : s.priceChange === "fixed" ? `+${s.defaultChange ?? 0}` : s.priceChange}</td><td style={{ padding: 6 }}>{s.upliftMethod}</td><td style={{ padding: 6 }}>v{s.version}</td>
                    <td style={{ padding: 6, color: t.dim }}>{s.updatedAt.slice(0, 16).replace("T", " ")}</td>
                    <td style={{ padding: 6, whiteSpace: "nowrap" }}><GhostButton isDark={isDark} label="Edit" icon="edit" onClick={() => { const { createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...b } = s; void _c; void _u; void _b; void _v; setEdit(b); }} /> <GhostButton isDark={isDark} label="Delete" icon="trash" danger onClick={() => setConfirmDelete(s)} /></td>
                  </tr>))}</tbody>
              </table>
            )}
        </Panel>
      )}
      {!!list.data?.history.length && (
        <Panel isDark={isDark} title="Schedule history" icon="clock">
          {list.data.history.slice(0, 15).map(h => <div key={h.id} style={{ fontSize: 12, color: t.body }}><span style={{ color: t.dim }}>{h.at.slice(0, 16).replace("T", " ")}</span> — {h.summary}</div>)}
        </Panel>
      )}
      {confirmDelete && <Modal isDark={isDark} title="Delete this schedule?" tone="warn" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirmDelete(null)} /><PrimaryButton isDark={isDark} label="Delete" icon="trash" onClick={() => void remove(confirmDelete)} /></>}><div>{confirmDelete.name} — deals that already used it keep their own copy. Nothing in Salesforce changes.</div></Modal>}
    </div>
  );
}
