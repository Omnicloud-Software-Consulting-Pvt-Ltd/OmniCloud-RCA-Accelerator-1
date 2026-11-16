"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, GhostButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, Modal } from "@/components/data/billing/billingUi";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import { BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { RateReplacementPreview, RateReplacementResult } from "@/lib/tax/server/rateReplace";
import { IssueList, Notice, Table } from "@/components/data/billing/tax/taxUi";

type Ref = { id: string; name: string } | null;

/**
 * Replace a Tax Rate. TaxCode, Geo Country and Geo State are create-only in Salesforce, so changing them creates a new rate from
 * an effective date and end-dates this one the day before — previewed, confirmed, done in one all-or-nothing request, verified.
 * Rate, Priority and dates can instead be edited in place with "Edit Tax Rate".
 */
export default function RateReplacePanel({ isDark, rateId, onReplaced }: { isDark: boolean; rateId: string; onReplaced: (newRateId: string) => void }) {
  const t = tokens(isDark);
  const notify = useSalesforceSuccess();
  const [open, setOpen] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [taxCode, setTaxCode] = useState("");
  const [country, setCountry] = useState<Ref>(null);
  const [state, setState] = useState<Ref>(null);
  const [rate, setRate] = useState("");
  const [preview, setPreview] = useState<RateReplacementPreview | null>(null);
  const [result, setResult] = useState<RateReplacementResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const changes = () => ({ ...(taxCode.trim() ? { TaxCode: taxCode.trim() } : {}), ...(country ? { GeoCountryId: country.id } : {}), ...(state ? { GeoStateId: state.id } : {}), ...(rate.trim() ? { Rate: rate.trim() } : {}) });
  async function doPreview() {
    setBusy(true); setError(null); setResult(null);
    try { setPreview(await quoteApiPost<RateReplacementPreview>("Preview tax rate replacement", `/api/taxes/rates/${rateId}/replace`, { effectiveDate, changes: changes(), preview: true })); }
    catch (err) { setError(toBillingErrorPanel(err, "Preview failed")); } finally { setBusy(false); }
  }
  async function execute() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const r = await quoteApiPost<RateReplacementResult>("Replace tax rate", `/api/taxes/rates/${rateId}/replace`, { effectiveDate, changes: changes(), token: preview.token, confirm: true });
      setResult(r); setPreview(r.preview);
      if (r.success && r.newRateId) { notify({ title: "Tax Rate Replaced", message: r.message, records: [{ objectApiName: "TaxRate", recordId: r.newRateId, recordName: String(r.preview.newRate.TaxCode ?? "Tax Rate"), salesforceUrl: "" }] }); onReplaced(r.newRateId); }
    } catch (err) { setError(toBillingErrorPanel(err, "The tax rate wasn't replaced")); } finally { setBusy(false); setConfirm(false); }
  }
  const input = { ...inputStyle(t), padding: "7px 10px" };
  if (!open) return (
    <Panel isDark={isDark} title="Change tax code or geography" icon="refresh">
      <div style={{ fontSize: 12.5, color: t.body, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span>Tax Code, Geo Country and Geo State can&apos;t be edited once a Tax Rate exists (create-only in Salesforce). Change them by creating a replacement rate.</span>
        <GhostButton label="Replace this rate…" icon="refresh" isDark={isDark} onClick={() => setOpen(true)} />
      </div>
    </Panel>
  );
  const keys = preview ? [...new Set([...Object.keys(preview.oldRate).filter(k => k !== "Id" && k !== "Name"), ...Object.keys(preview.newRate)])] : [];
  return (
    <Panel isDark={isDark} title="Replace Tax Rate" icon="refresh" right={<GhostButton label="Close" isDark={isDark} onClick={() => setOpen(false)} />}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <Field label="Effective from" isDark={isDark} hint="The current rate ends the day before."><input type="date" value={effectiveDate} onChange={e => { setEffectiveDate(e.target.value); setPreview(null); }} style={input} /></Field>
        <Field label="New Tax Code" isDark={isDark} hint="Blank keeps the current code."><input value={taxCode} onChange={e => { setTaxCode(e.target.value); setPreview(null); }} style={input} /></Field>
        <Field label="New Geo Country" isDark={isDark}><ReferenceLookup isDark={isDark} objectType="GeoCountry" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={country} onChange={v => { setCountry(v ? { id: v.id, name: v.name } : null); setPreview(null); }} placeholder="Search Geo Country…" /></Field>
        <Field label="New Geo State" isDark={isDark}><ReferenceLookup isDark={isDark} objectType="GeoState" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={state} onChange={v => { setState(v ? { id: v.id, name: v.name } : null); setPreview(null); }} placeholder="Search Geo State…" /></Field>
        <Field label="New Rate %" isDark={isDark} hint="Blank keeps the current rate."><input value={rate} onChange={e => { setRate(e.target.value); setPreview(null); }} style={input} /></Field>
      </div>
      <div style={{ marginTop: 10 }}><PrimaryButton label={busy && !preview ? "Previewing…" : "Preview replacement"} icon="eye" isDark={isDark} disabled={busy} onClick={() => void doPreview()} /></div>
      {error && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={error} /></div>}
      {preview && (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <IssueList isDark={isDark} issues={preview.issues} />
          <Table isDark={isDark} head={["Field", "Current rate", "Replacement rate"]} empty="—"
            rows={keys.map(k => [<code key="k">{k}</code>, String(preview.oldRate[k] ?? "—"), <b key="v" style={{ color: preview.changed.includes(k) ? t.accent : t.body }}>{String(preview.newRate[k] ?? "—")}</b>])} />
          <div style={{ fontSize: 12.5, color: t.body }}>The current rate gets <b>End Date {preview.oldRatePatch.EndDate}</b>. Both changes happen in one all-or-nothing Salesforce request.</div>
          <div><PrimaryButton label="Replace rate in Salesforce" icon="check" isDark={isDark} disabled={!preview.ok || busy} onClick={() => setConfirm(true)} /></div>
        </div>
      )}
      {result && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <Notice isDark={isDark} tone={result.success ? "ok" : "error"}>{result.message}{result.failure ? <> <b>Recommended:</b> {result.failure.recommendation}</> : null}</Notice>
          {result.verification.length > 0 && <Table isDark={isDark} head={["Check", "Result", "Detail"]} empty="—" rows={result.verification.map(v => [v.label, <b key="r" style={{ color: v.passed ? "#00C875" : "#E2445C" }}>{v.passed ? "PASS" : "FAIL"}</b>, v.detail])} />}
        </div>
      )}
      {confirm && preview && (
        <Modal isDark={isDark} title="Replace this Tax Rate?" tone="accent" actions={<>
          <GhostButton label="Back" isDark={isDark} onClick={() => setConfirm(false)} />
          <PrimaryButton label={busy ? "Working…" : "Confirm"} icon="check" isDark={isDark} disabled={busy} onClick={() => void execute()} />
        </>}>
          <div style={{ fontSize: 12.5, color: t.body, display: "grid", gap: 6 }}>
            <div>Creates a new Tax Rate ({String(preview.newRate.TaxCode ?? "")} {String(preview.newRate.Rate ?? "")}%) from <b>{effectiveDate}</b> and sets this rate&apos;s End Date to <b>{preview.oldRatePatch.EndDate}</b>.</div>
            <div style={{ color: t.dim }}>Afterwards, refresh the tax engine&apos;s decision table in Salesforce Setup so the engine uses the change.</div>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
