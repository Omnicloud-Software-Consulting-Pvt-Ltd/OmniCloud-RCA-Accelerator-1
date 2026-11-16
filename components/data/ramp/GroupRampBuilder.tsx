"use client";

import { Fragment, useState, type ReactNode } from "react";
import { tokens, GhostButton, PrimaryButton, Spinner, CodeBlock } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { RAMP_FIELD_HELP as H } from "@/lib/ramp/help";
import type { Reason, QuoteFacts, ProductFacts } from "@/lib/ramp/eligibility";
import type { GroupState, RampChain } from "@/lib/ramp/groupDiagnostics";
import type { RampCapabilities } from "@/lib/ramp/capabilities";
import type { SalesforceCall } from "@/lib/ramp/types";
import type { QuoteSearchRow } from "@/lib/ramp/server/reads";
import type { CatalogOption, CatalogProduct } from "@/lib/ramp/server/catalog";
import type { AddedLine } from "@/lib/ramp/server/quoteBuilder";
import { QuoteOption, quoteLabel } from "./RampQuoteOption";
import { Field, Notice, Panel, RecordPicker, SelectIn, SfId, TextIn, useRampGet } from "./rampUi";

/**
 * GROUP RAMP BUILDER — the record side of a Group Ramp Deal, in order: Account → Draft Quote (existing or NEW) → Quote Line Group
 * (existing or NEW) → Quote Line Items (existing, or ADD products) → live eligibility diagnostics. Everything shown is read from
 * Salesforce; the three writes (create quote / group / lines) each need a confirmation and are read back (POST /api/ramp/quote-builder).
 */

export interface GroupRow { id: string; name: string; quoteId: string; isRamped: boolean | null; segmentType: string | null; startDate: string | null; endDate: string | null; parentId: string | null; parentName: string | null; sortOrder: number | null; state: GroupState; lineCount: number; rampKey: string | null }
export interface QuoteLinesData { quote: QuoteFacts | null; groups: GroupRow[]; ramps: RampChain[] }
type LineRow = { id: string; productId: string | null; productName?: string | null; quantity: number | null; sellingModelId: string | null; sellingModelType: string | null; rampIdentifier: string | null; startDate: string | null; endDate: string | null; product: ProductFacts | null; eligible: boolean; reasons: Reason[] };
export interface GroupDiag {
  quote: QuoteFacts | null; eligible: boolean; reasons: Reason[]; quoteReasons: Reason[]; groupState: GroupState | null; chain: RampChain | null; otherRamps: RampChain[]; lines: LineRow[];
  pricing: { groupRamp: RampCapabilities["groupRamp"]; compound: RampCapabilities["compound"]; activeProcedures: { apiName: string; name: string; activeVersion: number | null }[] | null };
}
type BuilderResp<T> = { success: boolean; ok: boolean; message: string; record: T | null; calls: SalesforceCall[]; warnings: string[] };
export interface BuilderDraft { accountId: string | null; accountName: string | null; quoteId: string | null; quoteName: string | null; groupId: string | null; groupName: string | null; contractStart: string | null; contractEnd: string | null }

/** What the builder sets on the deal: the Salesforce record selections only (contract dates stay with the schedule). */
export type BuilderPatch = Partial<Record<"accountId" | "accountName" | "quoteId" | "quoteName" | "groupId" | "groupName", string | null>>;

export const STATE_LABEL: Record<GroupState, string> = { unramped: "Not ramped", "ramp-segment": "Ramp segment (IsRamped)", "ramp-container": "Holds a ramp schedule" };

function Step({ isDark, n, title, done, children, right }: { isDark: boolean; n: number; title: string; done?: boolean; children: ReactNode; right?: ReactNode }) {
  const t = tokens(isDark);
  return (
    <section style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10, background: t.surfaceAlt }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ width: 22, height: 22, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#fff", background: done ? "#00C875" : t.accent }}>{done ? "✓" : n}</span>
        <b style={{ fontSize: 13, color: t.heading }}>{title}</b>
        <span style={{ marginLeft: "auto" }}>{right}</span>
      </header>
      {children}
    </section>
  );
}

function ModeToggle({ isDark, value, onChange, options, disabled, label }: { isDark: boolean; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean; label: string }) {
  const t = tokens(isDark);
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", gap: 4, padding: 3, borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface }}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}
          style={{ fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 8, border: "none", cursor: disabled ? "not-allowed" : "pointer", background: value === o.value ? `${t.accent}22` : "transparent", color: value === o.value ? t.accent : t.dim }}>{o.label}</button>
      ))}
    </div>
  );
}

function ResultNotice<T>({ isDark, r, instanceUrl, id }: { isDark: boolean; r: BuilderResp<T>; instanceUrl: string | null; id?: string | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Notice isDark={isDark} tone={r.ok ? "ok" : "error"}>{r.message}{id && <> — <SfId isDark={isDark} id={id} instanceUrl={instanceUrl} /></>}</Notice>
      {r.warnings.map((w, i) => <Notice key={i} isDark={isDark} tone="warn">{w}</Notice>)}
      {r.calls.length > 0 && <CodeBlock isDark={isDark} label={`Salesforce requests (${r.calls.length})`} data={r.calls} />}
    </div>
  );
}

const Reasons = ({ isDark, reasons }: { isDark: boolean; reasons: Reason[] }) => {
  const t = tokens(isDark);
  return reasons.length ? <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>{reasons.map((r, i) => <li key={i} style={{ color: r.severity === "error" ? t.error : t.warn }}>{r.message}</li>)}</ul> : null;
};

export function RampChainView({ isDark, chain, instanceUrl }: { isDark: boolean; chain: RampChain; instanceUrl: string | null }) {
  const t = tokens(isDark);
  return (
    <div data-testid="existing-ramp" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: t.body }}>
      <div>{chain.shape === "parent" ? <>Parent group <b>{chain.parent?.name}</b> <SfId isDark={isDark} id={chain.parent?.id} instanceUrl={instanceUrl} /> holds {chain.segments.length} ramped segment group(s).</> : <>{chain.segments.length} ramped segment group(s) linked by their lines&apos; RampIdentifier.</>}
        {" "}RampIdentifier: {chain.rampIdentifiers.length ? chain.rampIdentifiers.map(r => <code key={r} style={{ marginRight: 6 }}>{r}</code>) : "— (no lines)"}</div>
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
        <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["#", "Segment group", "SegmentType", "Dates", "Uplift", "Method"].map(h => <th key={h} style={{ padding: 4 }}>{h}</th>)}</tr></thead>
        <tbody>{chain.segments.map((s, i) => <tr key={s.id} style={{ borderTop: `1px solid ${t.border}` }}><td style={{ padding: 4 }}>{i + 1}</td><td style={{ padding: 4 }}>{s.name} <SfId isDark={isDark} id={s.id} instanceUrl={instanceUrl} /></td><td style={{ padding: 4 }}>{s.segmentType ?? "—"}</td><td style={{ padding: 4 }}>{s.startDate ?? "?"} → {s.endDate ?? "?"}</td><td style={{ padding: 4 }}>{s.unitPriceUplift ?? 0}%</td><td style={{ padding: 4 }}>{s.rampUpliftType ?? "—"}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

type PickState = { productId: string | null; productName: string | null; pricebookEntryId: string; quantity: string; billingFrequency: string };
const EMPTY_PICK: PickState = { productId: null, productName: null, pricebookEntryId: "", quantity: "1", billingFrequency: "" };
interface PendingLine { productId: string; productName: string; pricebookEntryId: string; sellingModelLabel: string; billingFrequency: string | null; billingFrequencySource: "user" | "selling-model" | null; quantity: number; groupRamp: boolean }

export const SELLING_MODEL_TYPE_LABEL: Record<string, string> = { OneTime: "One-Time", TermDefined: "Term-Defined", Evergreen: "Evergreen" };
export function optionLabel(o: CatalogOption): string {
  const type = o.sellingModelType ? SELLING_MODEL_TYPE_LABEL[o.sellingModelType] ?? o.sellingModelType : "no selling model";
  const bf = o.billingFrequencyRequired ? (o.billingFrequency ? ` · billed ${o.billingFrequency}` : " · billing frequency: choose") : "";
  return `${o.sellingModelName ?? "No selling model"} (${type})${bf} · ${o.unitPrice ?? "?"}${o.rampable ? "" : " · quote line only"}`;
}
export function pendingFrom(p: CatalogProduct, o: CatalogOption, quantity: number, chosenBillingFrequency: string | null): PendingLine {
  return { productId: p.id, productName: p.name, pricebookEntryId: o.pricebookEntryId, sellingModelLabel: `${o.sellingModelName ?? "No selling model"} (${o.sellingModelType ? SELLING_MODEL_TYPE_LABEL[o.sellingModelType] ?? o.sellingModelType : "—"})`, billingFrequency: chosenBillingFrequency ?? o.billingFrequency, billingFrequencySource: chosenBillingFrequency ? "user" : o.billingFrequency ? "selling-model" : null, quantity, groupRamp: o.rampable };
}

/** One catalog product in the picker: name, code, and the three-way verdict. */
export function CatalogRow({ isDark, r }: { isDark: boolean; r: CatalogProduct }) {
  const t = tokens(isDark);
  const tag = !r.quoteLine.ok ? { text: "Can't add to the quote", color: t.error } : r.groupRamp.ok ? { text: "Quote line + Group Ramp", color: "#00C875" } : { text: "Quote line only", color: t.warn };
  const types = [...new Set(r.options.filter(o => o.usable).map(o => (o.sellingModelType ? SELLING_MODEL_TYPE_LABEL[o.sellingModelType] ?? o.sellingModelType : "no selling model")))];
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span><b style={{ color: t.heading }}>{r.name}</b>{r.productCode && <span style={{ color: t.dim, fontSize: 11 }}> · {r.productCode}</span>} <span style={{ color: tag.color, fontSize: 11, fontWeight: 700 }}>· {tag.text}</span></span>
      <span style={{ color: t.dim, fontSize: 11 }}>{r.quoteLine.ok ? `${types.join(" / ")}${r.groupRamp.reason ? ` — ${r.groupRamp.reason}` : ""}` : r.quoteLine.reason}</span>
    </span>
  );
}

/** Why the selected product can / can't be added, and whether it can join the group ramp — Quote Line and Group Ramp kept separate. */
export function ProductVerdict({ isDark, product, option }: { isDark: boolean; product: CatalogProduct; option: CatalogOption | null }) {
  const unusable = product.options.filter(o => !o.usable);
  return (
    <div data-testid="product-verdict" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {!product.quoteLine.ok
        ? <Notice isDark={isDark} tone="error"><b>Not eligible for Quote Line creation:</b> {product.quoteLine.reason}</Notice>
        : option
          ? (option.rampable
            ? <Notice isDark={isDark} tone="ok"><b>Eligible for Quote Line creation and the Group Ramp.</b>{product.groupRamp.reason ? ` ${product.groupRamp.reason}` : ""}</Notice>
            : <Notice isDark={isDark} tone="warn"><b>Eligible for Quote Line creation, not for the Group Ramp:</b> {option.sellingModelType === "TermDefined" ? product.groupRamp.reason : `${SELLING_MODEL_TYPE_LABEL[option.sellingModelType ?? ""] ?? "lines without a selling model"} lines don't ramp (term-defined only)`}. It can still be added to the group.</Notice>)
          : <Notice isDark={isDark} tone="info">Choose the selling model — {product.options.filter(o => o.usable).length} option(s) in this price book.</Notice>}
      {unusable.map(o => <Notice key={o.pricebookEntryId} isDark={isDark} tone="warn">{o.sellingModelName ?? "Entry"}: {o.reason}</Notice>)}
    </div>
  );
}

/** The lines Salesforce saved, with the field-by-field read-back and group-ramp participation. */
export function AddedLinesTable({ isDark, lines, instanceUrl }: { isDark: boolean; lines: AddedLine[]; instanceUrl: string | null }) {
  const t = tokens(isDark);
  return (
    <div data-testid="added-lines" style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 720 }}>
      <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Line", "Product", "Qty", "Selling model", "Billing frequency", "Read-back", "Group ramp"].map(h => <th key={h} style={{ padding: 5 }}>{h}</th>)}</tr></thead>
      <tbody>{lines.map(l => (
        <tr key={l.id} style={{ borderTop: `1px solid ${t.border}` }}>
          <td style={{ padding: 5 }}><SfId isDark={isDark} id={l.id} instanceUrl={instanceUrl} /></td><td style={{ padding: 5 }}>{l.productName}</td><td style={{ padding: 5 }}>{l.quantity ?? "—"}</td>
          <td style={{ padding: 5 }}>{l.sellingModelType ? SELLING_MODEL_TYPE_LABEL[l.sellingModelType] ?? l.sellingModelType : "—"}</td><td style={{ padding: 5 }}>{l.billingFrequency ?? "—"}</td>
          <td style={{ padding: 5, color: l.verified ? "#00C875" : t.error }} title={l.checks.map(c => `${c.field}: ${c.expected} / ${c.actual}`).join("\n")}>{l.verified ? `✓ ${l.checks.length} fields match` : `✗ ${l.checks.filter(c => !c.passed).map(c => c.field).join(", ")}`}</td>
          <td style={{ padding: 5, color: l.groupRampEligible ? "#00C875" : t.warn }}>{l.groupRampEligible ? "Can participate" : l.groupRampReason ?? "Quote line only"}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

export default function GroupRampBuilder({ isDark, instanceUrl, locked, d, set, quoteData, quoteLoading, quoteError, reloadQuote, diag, diagLoading, diagError, reloadDiag }: {
  isDark: boolean; instanceUrl: string | null; locked: boolean; d: BuilderDraft; set: (p: BuilderPatch) => void;
  quoteData: QuoteLinesData | null; quoteLoading: boolean; quoteError: string | null; reloadQuote: () => void;
  diag: GroupDiag | null; diagLoading: boolean; diagError: string | null; reloadDiag: () => void;
}) {
  const t = tokens(isDark);
  const notify = useNotify();
  const [quoteMode, setQuoteMode] = useState<"existing" | "create">("existing");
  const [groupMode, setGroupMode] = useState<"existing" | "create">("existing");
  const [nq, setNq] = useState({ name: "", opportunityId: "", pricebookId: "", expirationDate: "", startDate: "" });
  const [ng, setNg] = useState({ name: "", description: "", parentId: "" });
  const [pick, setPick] = useState<PickState>(EMPTY_PICK);
  const [pending, setPending] = useState<PendingLine[]>([]);
  const [inPricebookOnly, setInPricebookOnly] = useState(false);
  const [confirm, setConfirm] = useState<null | "quote" | "group" | "lines">(null);
  const [busy, setBusy] = useState(false);
  const [quoteRes, setQuoteRes] = useState<BuilderResp<QuoteSearchRow> | null>(null);
  const [groupRes, setGroupRes] = useState<BuilderResp<{ id: string; name: string }> | null>(null);
  const [linesRes, setLinesRes] = useState<BuilderResp<AddedLine[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewRamp, setViewRamp] = useState<string | null>(null);

  const pricebooks = useRampGet<{ rows: { id: string; name: string; isStandard: boolean }[] }>("Load price books", quoteMode === "create" && !locked ? "/api/ramp/lookup?type=pricebooks" : null);
  const opps = useRampGet<{ rows: { id: string; name: string; stage: string | null }[] }>("Load opportunities", quoteMode === "create" && d.accountId && !locked ? `/api/ramp/lookup?type=opportunities&accountId=${encodeURIComponent(d.accountId)}` : null);
  const quotePricebook = diag?.quote?.pricebookId ?? quoteData?.quote?.pricebookId ?? null;
  const lineOpts = useRampGet<{ product: CatalogProduct | null; billingFrequencyOptions: { value: string; label: string }[] }>("Load selling models", pick.productId ? `/api/ramp/lookup?type=line-options&productId=${encodeURIComponent(pick.productId)}${quotePricebook ? `&pricebookId=${encodeURIComponent(quotePricebook)}` : ""}` : null);
  const defaultPricebook = nq.pricebookId || pricebooks.data?.rows.find(p => p.isStandard)?.id || "";

  const post = async <T,>(label: string, body: Record<string, unknown>): Promise<BuilderResp<T> | null> => {
    setBusy(true); setError(null); setConfirm(null);
    try { return await quoteApiPost<BuilderResp<T>>(label, "/api/ramp/quote-builder", { ...body, confirmed: true }); }
    catch (e) { setError(toErrorPanelData(e, `${label} failed`).message); return null; }
    finally { setBusy(false); }
  };
  const createQuote = async () => {
    const r = await post<QuoteSearchRow>("Create quote", { action: "create-quote", name: nq.name, accountId: d.accountId, opportunityId: nq.opportunityId || null, pricebookId: defaultPricebook || null, expirationDate: nq.expirationDate || null, startDate: nq.startDate || null });
    if (!r) return;
    setQuoteRes(r);
    if (r.ok && r.record) { set({ quoteId: r.record.id, quoteName: quoteLabel(r.record), groupId: null, groupName: null }); setQuoteMode("existing"); setGroupMode("create"); notify.success("Quote created", r.message, { module: "RAMP" }); }
  };
  const createGroup = async () => {
    if (!d.quoteId) return;
    const r = await post<{ id: string; name: string }>("Create quote line group", { action: "create-group", quoteId: d.quoteId, name: ng.name, description: ng.description || null, parentId: ng.parentId || null });
    if (!r) return;
    setGroupRes(r);
    if (r.ok && r.record) { set({ groupId: r.record.id, groupName: r.record.name }); setGroupMode("existing"); setNg({ name: "", description: "", parentId: "" }); reloadQuote(); notify.success("Quote line group created", r.message, { module: "RAMP" }); }
  };
  const addLines = async () => {
    if (!d.quoteId || !d.groupId) return;
    const r = await post<AddedLine[]>("Add products", { action: "add-lines", quoteId: d.quoteId, groupId: d.groupId, items: pending.map(p => ({ productId: p.productId, pricebookEntryId: p.pricebookEntryId, quantity: p.quantity, billingFrequency: p.billingFrequencySource === "user" ? p.billingFrequency : null })), startDate: d.contractStart, endDate: d.contractEnd });
    if (!r) return;
    setLinesRes(r);
    if (r.ok) { setPending([]); notify.success("Products added", r.message, { module: "RAMP" }); }
    reloadQuote(); reloadDiag();
  };

  const groups = quoteData?.groups ?? [];
  const product = lineOpts.data?.product ?? null;
  const option = product?.options.find(o => o.pricebookEntryId === pick.pricebookEntryId) ?? null;
  const qty = Number(pick.quantity);
  const bfNeeded = !!option?.billingFrequencyRequired && !option.billingFrequency;
  const canAdd = !!product && !!option && option.usable && qty > 0 && (!bfNeeded || !!pick.billingFrequency);

  return (
    <div data-testid="group-ramp-builder" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <Notice isDark={isDark} tone="error">{error}</Notice>}

      <Step isDark={isDark} n={1} title="Account" done={!!d.accountId}>
        <RecordPicker<{ id: string; name: string }> isDark={isDark} label="Account" required help={H.account} type="accounts" disabled={locked} value={{ id: d.accountId, name: d.accountName }}
          onPick={r => { set({ accountId: r?.id ?? null, accountName: r?.name ?? null, quoteId: null, quoteName: null, groupId: null, groupName: null }); setQuoteRes(null); setGroupRes(null); setLinesRes(null); setPending([]); }}
          hint="Required to create a quote; filters the existing Draft quotes." />
      </Step>

      <Step isDark={isDark} n={2} title="Quote" done={!!d.quoteId} right={!locked && <ModeToggle isDark={isDark} label="Quote source" value={quoteMode} onChange={v => setQuoteMode(v as "existing" | "create")} options={[{ value: "existing", label: "Use Existing Draft Quote" }, { value: "create", label: "Create New Quote" }]} />}>
        {quoteMode === "existing" || locked ? (
          <RecordPicker<QuoteSearchRow> key={d.accountId ?? "any"} isDark={isDark} label="Quote (Draft)" required help={H.quote} type="quotes" params={{ accountId: d.accountId }} disabled={locked} value={{ id: d.quoteId, name: d.quoteName }}
            emptyText={d.accountId ? `No Draft Quotes found for ${d.accountName ?? "this Account"} — create one with "Create New Quote".` : "No Draft Quotes found."}
            render={r => <QuoteOption isDark={isDark} r={r} showAccount={!d.accountId} />}
            onPick={r => { set({ quoteId: r?.id ?? null, quoteName: r ? quoteLabel(r) : null, groupId: null, groupName: null }); setGroupRes(null); setLinesRes(null); setPending([]); }} />
        ) : (
          <div data-testid="create-quote-form" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!d.accountId && <Notice isDark={isDark} tone="warn">Pick the account first — the new quote is created for it (Quote Account).</Notice>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Field isDark={isDark} label="Quote Name" required><TextIn isDark={isDark} ariaLabel="New quote name" value={nq.name} onChange={v => setNq({ ...nq, name: v })} placeholder={d.accountName ? `${d.accountName} — Group Ramp` : "Quote name"} /></Field>
              <Field isDark={isDark} label="Price Book" required hint="Needed to add products (Price Book Entries)."><SelectIn isDark={isDark} ariaLabel="Price book" value={defaultPricebook} onChange={v => setNq({ ...nq, pricebookId: v })} options={(pricebooks.data?.rows ?? []).map(p => ({ value: p.id, label: `${p.name}${p.isStandard ? " (standard)" : ""}` }))} /></Field>
              <Field isDark={isDark} label="Opportunity" hint="Optional in this org (Quote.OpportunityId isn't required)."><SelectIn isDark={isDark} ariaLabel="Opportunity" value={nq.opportunityId} placeholder="— None —" onChange={v => setNq({ ...nq, opportunityId: v })} options={(opps.data?.rows ?? []).map(o => ({ value: o.id, label: `${o.name}${o.stage ? ` · ${o.stage}` : ""}` }))} /></Field>
              <Field isDark={isDark} label="Expiration Date" width={160}><TextIn isDark={isDark} type="date" ariaLabel="Expiration date" value={nq.expirationDate} onChange={v => setNq({ ...nq, expirationDate: v })} /></Field>
              <Field isDark={isDark} label="Start Date" width={160}><TextIn isDark={isDark} type="date" ariaLabel="Quote start date" value={nq.startDate} onChange={v => setNq({ ...nq, startDate: v })} /></Field>
            </div>
            {(pricebooks.error || opps.error) && <Notice isDark={isDark} tone="error">{pricebooks.error ?? opps.error}</Notice>}
            <div><PrimaryButton isDark={isDark} label={busy ? "Creating…" : "Create Quote in Salesforce…"} icon="plus" disabled={busy || !nq.name.trim() || !d.accountId || !defaultPricebook} onClick={() => setConfirm("quote")} /></div>
          </div>
        )}
        {quoteRes && <ResultNotice isDark={isDark} r={quoteRes} instanceUrl={instanceUrl} id={quoteRes.record?.id} />}
        {d.quoteId && <div style={{ fontSize: 12, color: t.dim }}>Selected quote <SfId isDark={isDark} id={d.quoteId} instanceUrl={instanceUrl} />{quoteData?.quote ? ` · ${quoteData.quote.status ?? "?"}${quoteData.quote.pricebookId ? "" : " · no price book"}` : ""}</div>}
      </Step>

      {d.quoteId && (
        <Step isDark={isDark} n={3} title="Quote Line Group" done={!!d.groupId} right={!locked && <ModeToggle isDark={isDark} label="Group source" value={groupMode} onChange={v => setGroupMode(v as "existing" | "create")} options={[{ value: "existing", label: "Select Existing Group" }, { value: "create", label: "Create New Group" }]} />}>
          {quoteLoading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Reading the quote&apos;s groups from Salesforce…</div>
            : quoteError ? <Notice isDark={isDark} tone="error">Couldn&apos;t read the quote line groups: {quoteError}</Notice>
            : groupMode === "existing" || locked ? (
              !groups.length ? (
                <Notice isDark={isDark} tone="info"><b>This quote has no Quote Line Groups yet.</b> A group ramp starts from a group — {locked ? "none to show." : <button type="button" onClick={() => setGroupMode("create")} style={{ border: "none", background: "transparent", color: t.accent, cursor: "pointer", padding: 0, fontSize: 12.5, fontWeight: 700 }}>create one now</button>}.</Notice>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table data-testid="group-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 820 }}>
                    <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Group", "Salesforce Id", "IsRamped", "SegmentType", "Start", "End", "Parent", "Lines", "State", ""].map(h => <th key={h} style={{ padding: 5 }}>{h}</th>)}</tr></thead>
                    <tbody>{groups.map(g => {
                      const sel = g.id === d.groupId;
                      const chain = g.rampKey ? quoteData?.ramps.find(c => c.key === g.rampKey) ?? null : null;
                      return (<Fragment key={g.id}>
                        <tr style={{ borderTop: `1px solid ${t.border}`, background: sel ? `${t.accent}12` : undefined }}>
                          <td style={{ padding: 5 }}><b style={{ color: t.heading }}>{g.name}</b></td>
                          <td style={{ padding: 5 }}><SfId isDark={isDark} id={g.id} instanceUrl={instanceUrl} /></td>
                          <td style={{ padding: 5 }}>{String(g.isRamped ?? "—")}</td><td style={{ padding: 5 }}>{g.segmentType ?? "—"}</td>
                          <td style={{ padding: 5 }}>{g.startDate ?? "—"}</td><td style={{ padding: 5 }}>{g.endDate ?? "—"}</td>
                          <td style={{ padding: 5 }}>{g.parentName ?? (g.parentId ? <SfId isDark={isDark} id={g.parentId} instanceUrl={instanceUrl} /> : "—")}</td>
                          <td style={{ padding: 5 }}>{g.lineCount}</td>
                          <td style={{ padding: 5, color: g.state === "unramped" ? "#00C875" : t.warn, fontWeight: 700 }}>{STATE_LABEL[g.state]}</td>
                          <td style={{ padding: 5, whiteSpace: "nowrap" }}>
                            {g.state === "unramped"
                              ? <GhostButton isDark={isDark} label={sel ? "Selected" : "Select"} disabled={locked || sel} onClick={() => { set({ groupId: g.id, groupName: g.name }); setLinesRes(null); setPending([]); }} />
                              : chain && <GhostButton isDark={isDark} label={viewRamp === g.id ? "Hide ramp" : "View Existing Ramp"} onClick={() => setViewRamp(v => (v === g.id ? null : g.id))} />}
                          </td>
                        </tr>
                        {viewRamp === g.id && chain && <tr><td colSpan={10} style={{ padding: 8 }}><RampChainView isDark={isDark} chain={chain} instanceUrl={instanceUrl} /></td></tr>}
                      </Fragment>);
                    })}</tbody>
                  </table>
                  <div style={{ fontSize: 11, color: t.dim, marginTop: 4 }}>Groups that are already a ramp segment, or hold one, can&apos;t start a new ramp — open them with View Existing Ramp.</div>
                </div>
              )
            ) : (
              <div data-testid="create-group-form" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Field isDark={isDark} label="Group Name" required help={H.quoteLineGroup}><TextIn isDark={isDark} ariaLabel="New group name" value={ng.name} onChange={v => setNg({ ...ng, name: v })} placeholder="e.g. Platform Ramp" /></Field>
                  <Field isDark={isDark} label="Description"><TextIn isDark={isDark} ariaLabel="New group description" value={ng.description} onChange={v => setNg({ ...ng, description: v })} /></Field>
                  <Field isDark={isDark} label="Parent Group" hint="Optional — an un-ramped group on this quote."><SelectIn isDark={isDark} ariaLabel="Parent group" value={ng.parentId} placeholder="— None —" onChange={v => setNg({ ...ng, parentId: v })} options={groups.filter(g => g.state === "unramped").map(g => ({ value: g.id, label: g.name }))} /></Field>
                </div>
                <div><PrimaryButton isDark={isDark} label={busy ? "Creating…" : "Create Group in Salesforce…"} icon="plus" disabled={busy || !ng.name.trim()} onClick={() => setConfirm("group")} /></div>
              </div>
            )}
          {groupRes && <ResultNotice isDark={isDark} r={groupRes} instanceUrl={instanceUrl} id={groupRes.record?.id} />}
        </Step>
      )}

      {d.quoteId && d.groupId && (
        <Step isDark={isDark} n={4} title={`Quote Line Items in ${d.groupName ?? "the group"}`} done={!!diag?.lines.length && diag.lines.every(l => l.eligible)}>
          {diagLoading ? <div style={{ display: "flex", gap: 6, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Reading the group&apos;s lines…</div>
            : diagError ? <Notice isDark={isDark} tone="error">{diagError}</Notice>
            : !diag?.lines.length ? <Notice isDark={isDark} tone="info">No quote lines in this group yet — add the products to ramp below.</Notice>
            : (
              <div style={{ overflowX: "auto" }}><table data-testid="group-lines" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 680 }}>
                <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>{["Product", "Quantity", "Selling model", "Salesforce Id", "Dates", "Group ramp"].map(h => <th key={h} style={{ padding: 5 }}>{h}</th>)}</tr></thead>
                <tbody>{diag.lines.map(l => (
                  <tr key={l.id} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: 5 }}>{l.product?.name ?? l.productName ?? l.productId}</td><td style={{ padding: 5 }}>{l.quantity ?? "—"}</td><td style={{ padding: 5 }}>{l.sellingModelType ?? "—"}</td>
                    <td style={{ padding: 5 }}><SfId isDark={isDark} id={l.id} instanceUrl={instanceUrl} /></td><td style={{ padding: 5 }}>{l.startDate ?? "?"} → {l.endDate ?? "?"}</td>
                    <td style={{ padding: 5 }}>{l.eligible ? <span style={{ color: "#00C875", fontWeight: 700 }}>Can participate</span> : <Reasons isDark={isDark} reasons={l.reasons.filter(r => r.severity === "error")} />}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
          {!locked && diag?.groupState === "unramped" && (
            <div data-testid="add-products" style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px dashed ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase" }}>Add products to the group</div>
              {!quotePricebook && <Notice isDark={isDark} tone="warn">The quote has no price book — products can&apos;t be added until it has one.</Notice>}
              <label style={{ fontSize: 12, color: t.body, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={inPricebookOnly} onChange={e => setInPricebookOnly(e.target.checked)} /> Only products priced in the quote&apos;s price book</label>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <RecordPicker<CatalogProduct> key={`${quotePricebook ?? "none"}-${inPricebookOnly}`} isDark={isDark} label="Product" type="catalog" params={{ pricebookId: quotePricebook, inPricebook: inPricebookOnly ? "1" : null }} disabled={!quotePricebook} value={{ id: pick.productId, name: pick.productName }}
                  hint="Every active Salesforce product — search by name, product code, SKU or Id." emptyText="No active products match." render={r => <CatalogRow isDark={isDark} r={r} />}
                  onPick={r => setPick({ ...EMPTY_PICK, productId: r?.id ?? null, productName: r?.name ?? null, quantity: pick.quantity })} />
                <Field isDark={isDark} label="Selling Model (Price Book Entry)" required hint={lineOpts.loading ? "Loading…" : product && !product.options.some(o => o.usable) ? product.quoteLine.reason : null}>
                  <SelectIn isDark={isDark} ariaLabel="Selling model for the new line" disabled={!product} value={pick.pricebookEntryId} onChange={v => setPick({ ...pick, pricebookEntryId: v, billingFrequency: "" })}
                    options={(product?.options ?? []).filter(o => o.usable).map(o => ({ value: o.pricebookEntryId, label: optionLabel(o) }))} />
                </Field>
                {bfNeeded && (
                  <Field isDark={isDark} label="Billing Frequency" required hint="The selling model's pricing term doesn't map to an active value — choose one.">
                    <SelectIn isDark={isDark} ariaLabel="Billing frequency for the new line" value={pick.billingFrequency} onChange={v => setPick({ ...pick, billingFrequency: v })} options={(lineOpts.data?.billingFrequencyOptions ?? []).map(o => ({ value: o.value, label: o.label }))} />
                  </Field>
                )}
                <Field isDark={isDark} label="Quantity" required width={110}><TextIn isDark={isDark} type="number" ariaLabel="Quantity for the new line" value={pick.quantity} onChange={v => setPick({ ...pick, quantity: v })} /></Field>
                <GhostButton isDark={isDark} label="Add to list" icon="plus" disabled={!canAdd}
                  onClick={() => { setPending(p => [...p, pendingFrom(product!, option!, qty, bfNeeded ? pick.billingFrequency : null)]); setPick(EMPTY_PICK); }} />
              </div>
              {product && <ProductVerdict isDark={isDark} product={product} option={option} />}
              {lineOpts.error && <Notice isDark={isDark} tone="error">{lineOpts.error}</Notice>}
              {pending.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {pending.map((p, i) => <div key={i} style={{ fontSize: 12, color: t.body, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>• {p.productName} · {p.sellingModelLabel} · qty {p.quantity}{p.billingFrequency ? ` · billed ${p.billingFrequency}` : ""} <span style={{ color: p.groupRamp ? "#00C875" : t.warn, fontSize: 11 }}>{p.groupRamp ? "can join the group ramp" : "quote line only"}</span> <GhostButton isDark={isDark} label="Remove" onClick={() => setPending(x => x.filter((_, j) => j !== i))} /></div>)}
                  <div><PrimaryButton isDark={isDark} label={busy ? "Adding…" : `Add ${pending.length} product(s) to ${d.groupName ?? "the group"}…`} icon="plus" disabled={busy} onClick={() => setConfirm("lines")} /></div>
                </div>
              )}
            </div>
          )}
          {linesRes?.record?.length ? <AddedLinesTable isDark={isDark} lines={linesRes.record} instanceUrl={instanceUrl} /> : null}
          {linesRes && <ResultNotice isDark={isDark} r={linesRes} instanceUrl={instanceUrl} />}
        </Step>
      )}

      {d.quoteId && d.groupId && diag && (
        <Panel isDark={isDark} title="Group ramp eligibility (read from Salesforce)" icon="check-circle" right={<GhostButton isDark={isDark} label="Re-check" icon="refresh" onClick={() => { reloadQuote(); reloadDiag(); }} />}>
          <div data-testid="group-diagnostics" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: t.body }}>
            <div>Quote: <b style={{ color: diag.quoteReasons.length ? t.error : "#00C875" }}>{diag.quoteReasons.length ? "not eligible" : `eligible (${diag.quote?.status ?? "?"})`}</b> · Group: <b>{diag.groupState ? STATE_LABEL[diag.groupState] : "—"}</b> · Lines: <b>{diag.lines.filter(l => l.eligible).length}/{diag.lines.length}</b> can participate</div>
            {diag.eligible ? <Notice isDark={isDark} tone="ok">This group can be ramped. Configure the schedule below, preview it, then Execute.</Notice> : <Reasons isDark={isDark} reasons={diag.reasons.filter(r => r.severity === "error")} />}
            <Reasons isDark={isDark} reasons={diag.reasons.filter(r => r.severity === "warning")} />
            {diag.chain && <div><div style={{ fontWeight: 700, marginBottom: 4 }}>Existing ramp on this group</div><RampChainView isDark={isDark} chain={diag.chain} instanceUrl={instanceUrl} /></div>}
            {diag.otherRamps.length > 0 && <div style={{ color: t.dim }}>Other ramp schedules on the quote: {diag.otherRamps.map(c => `${c.parent?.name ?? c.segments[0]?.name} (${c.segments.length} segment${c.segments.length === 1 ? "" : "s"}${c.rampIdentifiers.length ? `, ${c.rampIdentifiers.join(", ")}` : ""})`).join("; ")}.</div>}
            <div style={{ display: "grid", gap: 2 }}>
              <div>{diag.pricing.groupRamp.available ? "✓" : "✗"} Group ramps in this org (QuoteLineGroup.IsRamped / SegmentType writable){diag.pricing.groupRamp.reason ? ` — ${diag.pricing.groupRamp.reason}` : ""}</div>
              <div>{diag.pricing.compound.group ? "✓" : "–"} Compound uplift for group ramps (RampUpliftType)</div>
              <div>{diag.pricing.activeProcedures === null ? "? Pricing procedures couldn't be read" : diag.pricing.activeProcedures.length ? `✓ Active default pricing procedure: ${diag.pricing.activeProcedures.map(p => `${p.name} v${p.activeVersion}`).join(", ")}` : "✗ No active default pricing procedure — Salesforce can't price the segments"}</div>
            </div>
          </div>
        </Panel>
      )}

      {confirm && (
        <Modal isDark={isDark} tone="warn" title={confirm === "quote" ? "Create this quote in Salesforce?" : confirm === "group" ? "Create this quote line group in Salesforce?" : "Add these products to the quote?"}
          actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirm(null)} /><PrimaryButton isDark={isDark} label="Yes, create" icon="plus" onClick={() => void (confirm === "quote" ? createQuote() : confirm === "group" ? createGroup() : addLines())} /></>}>
          <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            {confirm === "quote" && <><div>Inserts one Draft <code>Quote</code> “{nq.name}” for {d.accountName} (Quote Account), price book {pricebooks.data?.rows.find(p => p.id === defaultPricebook)?.name ?? defaultPricebook}{nq.opportunityId ? ", linked to the chosen opportunity" : ""}.</div><div style={{ color: t.dim }}>The app reads it back and shows its Salesforce Id and Quote Number.</div></>}
            {confirm === "group" && <><div>Inserts one <code>QuoteLineGroup</code> “{ng.name}” on {d.quoteName}{ng.parentId ? ` under ${groups.find(g => g.id === ng.parentId)?.name}` : ""}.</div><div style={{ color: t.dim }}>The group starts un-ramped; the ramp itself happens only when you Execute.</div></>}
            {confirm === "lines" && <><div>Inserts {pending.length} <code>QuoteLineItem</code>(s) into {d.groupName}, each on the chosen Price Book Entry (which sets its selling model). Term-Defined lines get {d.contractStart} → {d.contractEnd}; Evergreen lines start {d.contractStart}; One-Time lines get no dates or billing frequency:</div><ul style={{ margin: 0, paddingLeft: 18 }}>{pending.map((p, i) => <li key={i}>{p.productName} · {p.sellingModelLabel} · qty {p.quantity}{p.billingFrequency ? ` · BillingFrequency ${p.billingFrequency}` : ""}</li>)}</ul><div style={{ color: t.dim }}>Every line is read back and compared field by field.</div></>}
          </div>
        </Modal>
      )}
    </div>
  );
}
