"use client";

import { useState } from "react";
import { tokens, inputStyle, PrimaryButton, ErrorPanel, Field } from "@/components/data/quotes/shared";
import { Panel, LoadingRow } from "@/components/data/billing/billingUi";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { ProductTaxReadiness } from "@/lib/tax/server/pipeline";
import { ReadinessAreas } from "@/components/data/taxes/TaxCalcViews";

/**
 * Taxes → Engine Readiness: the read-only product tax readiness panel. (The former direct-API "Calculate Tax" form was removed:
 * Salesforce's POST /commerce/taxes/actions/calculate returns 404 for Revenue Standard Tax engines — tax is calculated through the
 * billing workflow in SalesforceTaxPanel, /api/taxes/calculation/salesforce.)
 */

export function ProductReadinessPanel({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [f, setF] = useState({ product: "", country: "", state: "" });
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<ProductTaxReadiness | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  async function check() {
    setBusy(true); setError(null);
    try { setR(await quoteApiPost<ProductTaxReadiness>("Check product tax readiness", "/api/taxes/readiness/product", { product: { name: f.product }, country: f.country || null, state: f.state || null })); }
    catch (err) { setError(toBillingErrorPanel(err, "Readiness check failed")); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel isDark={isDark} title="Product tax readiness" icon="activity">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, alignItems: "end" }}>
          <Field label="Product (name or code)" isDark={isDark}><input value={f.product} onChange={e => setF({ ...f, product: e.target.value })} placeholder="exact name or ProductCode" style={inputStyle(t)} /></Field>
          <Field label="Country" isDark={isDark}><input value={f.country} onChange={e => setF({ ...f, country: e.target.value })} placeholder="e.g. Germany / DE" style={inputStyle(t)} /></Field>
          <Field label="State" isDark={isDark}><input value={f.state} onChange={e => setF({ ...f, state: e.target.value })} placeholder="optional" style={inputStyle(t)} /></Field>
          <PrimaryButton label={busy ? "Checking…" : "Check readiness"} icon="check-circle" isDark={isDark} disabled={!f.product.trim() || busy} onClick={() => void check()} />
        </div>
        <div style={{ fontSize: 11.5, color: t.dim, marginTop: 6 }}>Read-only. Engine, policy, treatment, item, rate, geography, decision table, configuration, calculation and billing readiness for one product. A stale decision table (a tax rate changed after its last refresh) blocks invoicing until it is refreshed — an explicit, approved step; it is never refreshed automatically.</div>
      </Panel>
      {busy && <LoadingRow isDark={isDark} label="Resolving the product's tax configuration in Salesforce…" />}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {r && <ReadinessAreas isDark={isDark} r={r} />}
    </div>
  );
}
