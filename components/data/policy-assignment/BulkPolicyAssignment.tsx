"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, Spinner, ErrorPanel, EmptyState } from "@/components/data/quotes/shared";
import { Modal, Panel, StatusPill } from "@/components/data/billing/billingUi";
import FieldHelp from "@/components/help/FieldHelp";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { applyResults, currentFor, listKeyFor, deselectMany, emptySelection, mergePage, pageState, selectMany, toggle, type Selection } from "@/lib/policyAssignment/selection";
import {
  MAX_BULK_PRODUCTS, POLICY_KIND_LABELS, TREATMENT_ITEM_COMPLETE, needsRetry,
  type BulkAssignResponse, type BulkOutcome, type EligibleProduct, type EligibleProductsResponse, type PoliciesResponse, type PolicyCheckResult, type PolicyKind, type TreatmentItemStatus, type TreatmentItemSummary, TAX_CODE_SOURCE_LABEL,
} from "@/lib/policyAssignment/types";

const OUTCOME_LABEL: Record<BulkOutcome, string> = { assigned: "Assigned", "already-assigned": "Already Assigned", "assigned-incomplete": "Assigned — Item Incomplete", ineligible: "Not Eligible", failed: "Failed" };
const ITEM_LABEL: Record<TreatmentItemStatus, string> = { created: "Item created", reused: "Item reused", updated: "Tax Code added", conflict: "Tax Code conflict", shared: "Shared item", "not-required": "Not required", "missing-tax-code": "Missing Tax Code", failed: "Item failed", "not-verified": "Not verified" };
const MODE_LABEL: Record<TreatmentItemSummary["mode"], string> = { "tax-per-product": "One Tax Treatment Item per product", "tax-treatment-code": "Treatment Tax Code (no items)", "billing-shared": "Shared Billing Treatment Item", none: "No default treatment" };

interface ListState { key: string; products: EligibleProduct[]; nextCursor: string | null; total: number | null; policy: PolicyCheckResult | null; error: ErrorPanelDataLike | null }

/**
 * Bulk Product Assignment — assign ONE existing Billing Policy or Tax Policy to many products at once. Shared by both policy
 * workspaces, configured by `kind`; the server keeps each kind's field and validation separate (lib/policyAssignment).
 * Only products with no policy of THIS kind are listed (filtered in SOQL) and the server re-checks each one before writing,
 * so an existing assignment is never overwritten — even one made by someone else after this list loaded.
 */
export default function BulkPolicyAssignment({ isDark, kind, onAssigned, onClose }: {
  isDark: boolean;
  kind: PolicyKind;
  /** Called after any successful write (refresh counts / records tables). */
  onAssigned?: () => void;
  onClose?: () => void;
}) {
  const t = tokens(isDark);
  const L = POLICY_KIND_LABELS[kind];
  const notify = useNotify();
  const base = `/api/policy-assignment/${kind}`;

  // Policies
  const [policies, setPolicies] = useState<PoliciesResponse | null>(null);
  const [policiesError, setPoliciesError] = useState<ErrorPanelDataLike | null>(null);
  const [policyFilter, setPolicyFilter] = useState("");
  const [policyId, setPolicyId] = useState("");

  // Eligible products
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [list, setList] = useState<ListState | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Selection + assignment
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [result, setResult] = useState<BulkAssignResponse | null>(null);
  const [submitError, setSubmitError] = useState<ErrorPanelDataLike | null>(null);

  useEffect(() => {
    let live = true;
    quoteApiGet<PoliciesResponse>(`Load ${L.policies}`, `${base}/policies`)
      .then(r => { if (live) setPolicies(r); })
      .catch(err => { if (live) setPoliciesError(toErrorPanelData(err, `Could not load ${L.policies}`)); });
    return () => { live = false; };
  }, [base, L.policies]);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);

  const listKey = listKeyFor(policyId, debouncedQ, reloadToken);
  useEffect(() => {
    if (!policyId) return;
    let live = true;
    const params = new URLSearchParams({ policyId, ...(debouncedQ ? { q: debouncedQ } : {}) });
    quoteApiGet<EligibleProductsResponse>("Load eligible products", `${base}/eligible-products?${params}`)
      .then(r => { if (live) setList({ key: listKey, products: r.products, nextCursor: r.nextCursor, total: r.totalEligible, policy: r.policy, error: null }); })
      .catch(err => { if (live) setList({ key: listKey, products: [], nextCursor: null, total: null, policy: null, error: toErrorPanelData(err, "Could not load eligible products") }); });
    return () => { live = false; };
  }, [base, policyId, debouncedQ, listKey]);

  const current = currentFor(list, listKey);
  const loadingList = !!policyId && !current;
  const products = current?.products ?? [];
  const policyCheck = current?.policy ?? null;
  const itemSummary = policyCheck?.treatmentItems ?? null;
  const blocked = !!policyCheck?.blockers.length;
  const selectedPolicy = policies?.policies.find(p => p.id === policyId) ?? null;

  const visiblePolicies = useMemo(() => {
    const f = policyFilter.trim().toLowerCase();
    const all = policies?.policies ?? [];
    return f ? all.filter(p => p.name.toLowerCase().includes(f) || p.id === policyId) : all;
  }, [policies, policyFilter, policyId]);

  const choosePolicy = (id: string) => {
    setPolicyId(id);
    setSelection(emptySelection());
    setResult(null);
    setSubmitError(null);
    setNotice(null);
  };

  const loadMore = async () => {
    if (!current?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ cursor: current.nextCursor, ...(debouncedQ ? { q: debouncedQ } : {}) });
      const r = await quoteApiGet<EligibleProductsResponse>("Load more eligible products", `${base}/eligible-products?${params}`);
      setList(prev => prev && prev.key === listKey ? { ...prev, products: mergePage(prev.products, r.products), nextCursor: r.nextCursor } : prev);
    } catch (err) {
      setNotice(toErrorPanelData(err, "Could not load more products").message ?? "Could not load more products.");
    } finally { setLoadingMore(false); }
  };

  const selectAllEligible = async () => {
    setSelectingAll(true);
    setNotice(null);
    try {
      const params = new URLSearchParams({ all: "1", ...(debouncedQ ? { q: debouncedQ } : {}) });
      const r = await quoteApiGet<EligibleProductsResponse>("Select all eligible products", `${base}/eligible-products?${params}`);
      setSelection(s => selectMany(s, r.products));
      if (r.truncated) setNotice(`Selected the first ${MAX_BULK_PRODUCTS} eligible products (the per-assignment limit). Assign them, then select the rest.`);
    } catch (err) {
      setNotice(toErrorPanelData(err, "Could not select all eligible products").message ?? "Could not select all eligible products.");
    } finally { setSelectingAll(false); }
  };

  const assign = async () => {
    if (submittingRef.current || !policyId || selection.size === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await quoteApiPost<BulkAssignResponse>(`Assign ${L.policy}`, `${base}/assign`, { policyId, productIds: [...selection.keys()] });
      setResult(r);
      setConfirming(false);
      const applied = applyResults(products, selection, r.results);
      setSelection(applied.selection);
      setList(prev => prev && prev.key === listKey ? { ...prev, products: applied.list, total: prev.total !== null ? Math.max(0, prev.total - r.assigned) : null } : prev);
      const msg = `${r.assigned} assigned · ${r.skipped} skipped${r.incomplete ? ` · ${r.incomplete} incomplete` : ""} · ${r.failed} failed`;
      if (r.failed > 0 || r.incomplete > 0) notify.warning(`${L.policy} partially assigned`, `${r.policy.name}: ${msg}`, { module: L.module });
      else notify.success(`${L.policy} assigned`, `${r.policy.name}: ${msg}`, { module: L.module });
      if (r.assigned > 0) onAssigned?.();
      setReloadToken(n => n + 1); // re-read the eligible list from Salesforce
    } catch (err) {
      setSubmitError(toErrorPanelData(err, `Could not assign the ${L.policy}`));
      setConfirming(false);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const retryFailed = () => {
    if (!result) return;
    const retry = result.results.filter(needsRetry);
    setSelection(new Map(retry.map(r => [r.productId, { id: r.productId, name: r.productName, code: r.productCode, family: null, active: null }])));
    setConfirming(true);
  };

  const pageSel = pageState(selection, products);
  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headerBox.current) headerBox.current.indeterminate = pageSel === "some"; }, [pageSel]);

  const sectionLabel = (n: number, text: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim }}>
      <span style={{ width: 18, height: 18, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", background: `${t.accent}20`, color: t.accent, fontSize: 10.5 }}>{n}</span>{text}
    </div>
  );

  return (
    <Panel isDark={isDark} title="Bulk Product Assignment" icon="layers"
      right={onClose ? <GhostButton label="Close" icon="x" isDark={isDark} onClick={onClose} /> : undefined}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: t.body }}>
          Assign one existing {L.policy} to many products at once. Only products with <b>no {L.policy}</b> are listed — their{" "}
          {kind === "billing" ? "Tax" : "Billing"} Policy doesn&apos;t matter. Existing assignments are never overwritten; every product is re-checked in Salesforce right before it&apos;s updated.
        </p>

        {/* Step 1 — policy */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sectionLabel(1, `Select ${L.policy}`)}
          {policiesError && <ErrorPanel isDark={isDark} error={policiesError} />}
          {!policies && !policiesError && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading {L.policies} from Salesforce…</div>}
          {policies && policies.policies.length === 0 && (
            <EmptyState isDark={isDark} icon="shield" title={`No ${L.policies} in this org yet`} hint={`Create a ${L.policy} first (Create New ${L.policy}), then come back to assign it.`} />
          )}
          {policies && policies.policies.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              {policies.policies.length > 8 && (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 180px", minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: t.dim }}>Search policies</span>
                  <input value={policyFilter} onChange={e => setPolicyFilter(e.target.value)} placeholder="Filter by name…" style={inputStyle(t)} />
                </label>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "2 1 260px", minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: t.dim, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  Select {L.policy}
                  <FieldHelp isDark={isDark} label={`Select ${L.policy}`} entry={{ text: `The existing ${L.policy} to assign. Its status and how many products already use it are shown. ${kind === "billing" ? "Its Billing Treatment chain is validated before anything is written." : "Inactive policies can't be assigned; Draft policies can, but Salesforce won't calculate tax with them until they're Active."}` }} />
                </span>
                <select value={policyId} onChange={e => choosePolicy(e.target.value)} style={{ ...inputStyle(t), cursor: "pointer" }} aria-label={`Select ${L.policy}`}>
                  <option value="">Choose a {L.policy}…</option>
                  {visiblePolicies.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.status ? ` — ${p.status}` : ""}{p.productCount !== null ? ` · ${p.productCount} product${p.productCount === 1 ? "" : "s"}` : ""}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {policyCheck && (policyCheck.blockers.length > 0 || policyCheck.warnings.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {policyCheck.blockers.map((b, i) => <div key={`b${i}`} role="alert" style={{ fontSize: 12, color: t.error, display: "flex", gap: 6 }}><Ic n="alert" s={13} />{b}</div>)}
              {policyCheck.warnings.map((w, i) => <div key={`w${i}`} style={{ fontSize: 12, color: t.warn, display: "flex", gap: 6 }}><Ic n="alert" s={13} />{w}</div>)}
            </div>
          )}
        </div>

        {itemSummary && <TreatmentItemPanel key={policyId} isDark={isDark} kind={kind} summary={itemSummary} />}

        {/* Steps 2–3 — eligible products + selection */}
        {policyId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sectionLabel(2, `Products without a ${L.policy}`)}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ flex: "1 1 220px", position: "relative", minWidth: 0 }}>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by product name or code…" aria-label="Search eligible products" style={{ ...inputStyle(t), paddingLeft: 30 }} />
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.dim, display: "inline-flex" }}><Ic n="search" s={13} /></span>
              </div>
              <GhostButton label={selectingAll ? "Selecting…" : "Select All Eligible"} icon="check-circle" isDark={isDark} disabled={selectingAll || loadingList || !current?.total || blocked} onClick={selectAllEligible} />
              <GhostButton label="Clear Selection" icon="x" isDark={isDark} disabled={selection.size === 0} onClick={() => setSelection(emptySelection())} />
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: t.dim }}>
              <span>Eligible{debouncedQ ? " (matching search)" : ""}: <b style={{ color: t.heading }}>{current?.total ?? "—"}</b></span>
              <span>Showing: <b style={{ color: t.heading }}>{products.length}</b></span>
              <span>Selected: <b style={{ color: t.accent }}>{selection.size}</b>{selection.size >= MAX_BULK_PRODUCTS ? ` (limit ${MAX_BULK_PRODUCTS})` : ""}</span>
            </div>
            {notice && <div style={{ fontSize: 12, color: t.warn }}>{notice}</div>}
            {current?.error && <ErrorPanel isDark={isDark} error={current.error} />}

            {loadingList ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim, padding: "8px 0" }}><Spinner isDark={isDark} /> Reading products without a {L.policy} from Salesforce…</div>
            ) : !current?.error && products.length === 0 ? (
              <EmptyState isDark={isDark} icon="check-circle" title={debouncedQ ? "No eligible products match your search" : `Every product already has a ${L.policy}`}
                hint={debouncedQ ? "Clear or change the search." : `There's nothing to assign — products that already have a ${L.policy} are never changed here. Use the single-product assignment to review a specific product.`} />
            ) : products.length > 0 && (
              <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ maxHeight: 360, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead style={{ position: "sticky", top: 0, background: t.surfaceAlt, zIndex: 1 }}>
                      <tr style={{ textAlign: "left", color: t.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
                        <th style={{ padding: "8px 10px", width: 36 }}>
                          <input ref={headerBox} type="checkbox" aria-label="Select all products shown" checked={pageSel === "all"} disabled={blocked}
                            onChange={() => setSelection(s => (pageSel === "all" ? deselectMany(s, products) : selectMany(s, products)))} />
                        </th>
                        <th style={{ padding: "8px 6px" }}>Product</th>
                        <th style={{ padding: "8px 6px" }}>Code</th>
                        <th className="hidden md:table-cell" style={{ padding: "8px 6px" }}>Family</th>
                        <th style={{ padding: "8px 6px" }}>Status</th>
                        <th className="hidden lg:table-cell" style={{ padding: "8px 6px" }}>Product Id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map(p => {
                        const checked = selection.has(p.id);
                        return (
                          <tr key={p.id} style={{ borderTop: `1px solid ${t.border}`, background: checked ? `${t.accent}0d` : "transparent" }}>
                            <td style={{ padding: "7px 10px" }}>
                              <input id={`bpa-${kind}-${p.id}`} type="checkbox" checked={checked} disabled={blocked || (!checked && selection.size >= MAX_BULK_PRODUCTS)} onChange={() => setSelection(s => toggle(s, p))} />
                            </td>
                            <td style={{ padding: "7px 6px", color: t.heading, fontWeight: 600 }}><label htmlFor={`bpa-${kind}-${p.id}`} style={{ cursor: "pointer" }}>{p.name}</label></td>
                            <td style={{ padding: "7px 6px", color: t.body }}>{p.code ?? "—"}</td>
                            <td className="hidden md:table-cell" style={{ padding: "7px 6px", color: t.body }}>{p.family ?? "—"}</td>
                            <td style={{ padding: "7px 6px" }}>{p.active === null ? "—" : <StatusPill status={p.active ? "Active" : "Inactive"} isDark={isDark} />}</td>
                            <td className="hidden lg:table-cell" style={{ padding: "7px 6px", color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 11 }}>{p.id}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {current?.nextCursor && (
                  <div style={{ padding: 8, borderTop: `1px solid ${t.border}`, display: "flex", justifyContent: "center" }}>
                    <GhostButton label={loadingMore ? "Loading…" : "Load more products"} icon="chevron-down" isDark={isDark} disabled={loadingMore} onClick={loadMore} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 4 — assign */}
        {policyId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sectionLabel(3, "Assign")}
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <PrimaryButton label={submitting ? "Assigning…" : `Assign ${L.policy}${selection.size ? ` to ${selection.size} Product${selection.size === 1 ? "" : "s"}` : ""}`} icon="link" isDark={isDark}
                disabled={!policyId || selection.size === 0 || submitting || blocked || loadingList} onClick={() => setConfirming(true)} />
              {selectedPolicy && <span style={{ fontSize: 12, color: t.dim }}>Selected {L.policy}: <b style={{ color: t.heading }}>{selectedPolicy.name}</b></span>}
            </div>
            {submitError && <ErrorPanel isDark={isDark} error={submitError} />}
          </div>
        )}

        {result && <ResultSummary isDark={isDark} result={result} kindLabel={L.policy} onRetry={retryFailed} />}
      </div>

      {confirming && (
        <Modal isDark={isDark} title={`Assign ${L.policy} to ${selection.size} product${selection.size === 1 ? "" : "s"}?`} tone="warn"
          actions={<>
            <GhostButton label="Cancel" isDark={isDark} disabled={submitting} onClick={() => setConfirming(false)} />
            <PrimaryButton label={submitting ? "Assigning…" : "Confirm Assignment"} icon="check" isDark={isDark} disabled={submitting} onClick={assign} />
          </>}>
          <div><b>{L.policy}:</b> {selectedPolicy?.name ?? policyCheck?.name}{selectedPolicy?.status ? ` (${selectedPolicy.status})` : ""}</div>
          <div><b>Products:</b> {selection.size}</div>
          <div>
            Salesforce will set <code>Product2.{policies?.field}</code> to this policy on each selected product. Each product is re-checked first:
            any that already has a {L.policy} — including one assigned by someone else since this list loaded — is skipped and reported, never overwritten.
          </div>
          {itemSummary?.mode === "tax-per-product" && <div style={{ fontSize: 12 }}>Before each product is linked, its Tax Treatment Item under &ldquo;{itemSummary.treatmentName}&rdquo; is reused or created with Tax Code {itemSummary.resolvedTaxCode ? <b>{itemSummary.resolvedTaxCode}</b> : <b>not configured (left empty)</b>} — resolved from the policy&apos;s {itemSummary.taxCodeSource === "tax-engine" ? "Tax Engine" : "Tax Treatment"}. Existing items keep their Tax Code. A product whose item can&apos;t be configured is not linked.</div>}
          {itemSummary?.mode === "billing-shared" && <div style={{ fontSize: 12 }}>Billing Treatment Items are shared by every product on this policy — none are created; the shared item is verified for each product.</div>}
          {policyCheck?.warnings.map((w, i) => <div key={i} style={{ color: t.warn, fontSize: 12 }}>{w}</div>)}
          <div style={{ maxHeight: 140, overflowY: "auto", fontSize: 12, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 10px" }}>
            {[...selection.values()].slice(0, 50).map(p => <div key={p.id}>{p.name}{p.code ? ` — ${p.code}` : ""}</div>)}
            {selection.size > 50 && <div>…and {selection.size - 50} more</div>}
          </div>
        </Modal>
      )}
    </Panel>
  );
}

function TreatmentItemPanel({ isDark, kind, summary }: { isDark: boolean; kind: PolicyKind; summary: TreatmentItemSummary }) {
  const t = tokens(isDark);
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, background: t.surfaceAlt }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
        <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="list" s={13} /></span>
        <b style={{ color: t.heading }}>{kind === "tax" ? "Tax" : "Billing"} Treatment Items</b>
        <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, border: `1px solid ${t.border}`, color: t.dim }}>{MODE_LABEL[summary.mode]}</span>
        {summary.treatmentName && <span style={{ color: t.dim }}>Treatment: <b style={{ color: t.body }}>{summary.treatmentName}</b>{summary.treatmentStatus ? ` (${summary.treatmentStatus})` : ""}</span>}
      </div>
      <div style={{ fontSize: 12, color: t.body, lineHeight: 1.5 }}>{summary.detail}</div>
      {summary.mode === "billing-shared" && summary.sharedItems.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{summary.sharedItems.map(i => <StatusPill key={i.id} isDark={isDark} status={`${i.name} · ${i.status ?? "—"}`} />)}</div>
      )}
      {kind === "tax" && summary.mode !== "none" && <ResolvedTaxCode isDark={isDark} summary={summary} />}
    </div>
  );
}

/**
 * Read-only: the Tax Code resolved from the selected policy's configuration (Tax Treatment → Tax Engine → not configured).
 * There is deliberately no input — the Tax Code can't be entered or overridden here.
 */
function ResolvedTaxCode({ isDark, summary }: { isDark: boolean; summary: TreatmentItemSummary }) {
  const t = tokens(isDark);
  const source = summary.taxCodeSource ?? "not-configured";
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 12 }}><span style={{ color: t.dim, minWidth: 92 }}>{label}</span><span style={{ color: t.heading, fontWeight: 600 }}>{value}</span></div>
  );
  return (
    <div data-testid="resolved-tax-code" style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", borderRadius: 8, border: `1px dashed ${t.border}` }}>
      {row("Tax Treatment", summary.treatmentName ?? "—")}
      {row("Tax Engine", summary.engineName ?? "—")}
      {row("Tax Code", summary.resolvedTaxCode ? <code style={{ color: t.accent }}>{summary.resolvedTaxCode}</code> : <span style={{ color: t.dim, fontWeight: 600 }}>Not configured</span>)}
      {row("Source", <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{TAX_CODE_SOURCE_LABEL[source]}
        <FieldHelp isDark={isDark} label="Tax Code source" entry={{
          text: "Resolved automatically from Salesforce: the default Tax Treatment's Tax Code; if that's empty, the Tax Engine's Tax Code (only when this org's Tax Engine has a Tax Code field); otherwise not configured. It can't be entered or overridden here.",
          impact: summary.mode === "tax-per-product" ? "New Tax Treatment Items get exactly this value (left empty when not configured). Existing items keep their own Tax Code — a different one is reported as a conflict." : "The treatment applies it to every product; no per-product item is created.",
        }} />
      </span>)}
      {source === "not-configured" && summary.mode === "tax-per-product" && (
        <div style={{ fontSize: 11.5, color: t.dim, marginTop: 2 }}>No Tax Code is configured on the Tax Treatment{summary.engineTaxCodeField ? " or Tax Engine" : " (this org's Tax Engine has no Tax Code field)"} — items are created without one.</div>
      )}
    </div>
  );
}

function ResultSummary({ isDark, result, kindLabel, onRetry }: { isDark: boolean; result: BulkAssignResponse; kindLabel: string; onRetry: () => void }) {
  const t = tokens(isDark);
  const retryable = result.results.filter(needsRetry).length;
  const color: Record<BulkOutcome, string> = { assigned: "#00C875", "already-assigned": t.accentBlue, "assigned-incomplete": t.warn, ineligible: t.warn, failed: t.error };
  const hasItems = result.results.some(r => r.treatmentItem);
  return (
    <div role="status" style={{ border: `1px solid ${result.failed || result.incomplete ? t.warn : t.accent}50`, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 10, background: t.surfaceAlt }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: t.heading }}>Bulk {kindLabel} Assignment {result.failed || result.incomplete ? "Completed with Issues" : "Completed"} — {result.policy.name}</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
        <span>Requested: <b style={{ color: t.heading }}>{result.requested}</b></span>
        <span>Successful: <b style={{ color: color.assigned }}>{result.assigned}</b></span>
        <span>Already Assigned / Ineligible: <b style={{ color: t.warn }}>{result.skipped}</b></span>
        {result.incomplete > 0 && <span>Assigned, Item Incomplete: <b style={{ color: t.warn }}>{result.incomplete}</b></span>}
        {result.conflicts > 0 && <span>Tax Code conflicts (kept, not overwritten): <b style={{ color: t.warn }}>{result.conflicts}</b></span>}
        <span>Failed: <b style={{ color: t.error }}>{result.failed}</b></span>
      </div>
      {result.warnings.map((w, i) => <div key={i} style={{ fontSize: 12, color: t.warn }}>{w}</div>)}
      <div style={{ maxHeight: 300, overflowY: "auto", border: `1px solid ${t.border}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>
            <th style={{ padding: "6px 8px" }}>Product</th><th style={{ padding: "6px 8px" }}>Result</th>
            {hasItems && <th style={{ padding: "6px 8px" }}>Treatment Item</th>}
            <th style={{ padding: "6px 8px" }}>Details</th>
          </tr></thead>
          <tbody>
            {result.results.map(r => {
              const it = r.treatmentItem;
              const itOk = it ? TREATMENT_ITEM_COMPLETE.has(it.status) && it.status !== "conflict" : true;
              return (
                <tr key={r.productId} style={{ borderTop: `1px solid ${t.border}`, verticalAlign: "top" }}>
                  <td style={{ padding: "6px 8px", color: t.heading, fontWeight: 600 }}>{r.productName}{r.productCode ? <span style={{ color: t.dim, fontWeight: 400 }}> · {r.productCode}</span> : null}</td>
                  <td style={{ padding: "6px 8px", color: color[r.outcome], fontWeight: 700, whiteSpace: "nowrap" }}>{OUTCOME_LABEL[r.outcome]}</td>
                  {hasItems && (
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                      {it ? <span style={{ color: itOk ? "#00C875" : t.warn, fontWeight: 700 }}>{ITEM_LABEL[it.status]}{it.taxCode ? <span style={{ color: t.dim, fontWeight: 400 }}> · {it.taxCode}</span> : null}</span> : <span style={{ color: t.dim }}>—</span>}
                    </td>
                  )}
                  <td style={{ padding: "6px 8px", color: t.body }}>
                    {r.reason ?? (it?.detail ?? "—")}
                    {r.reason && it?.detail && r.outcome !== "failed" && <div style={{ color: t.dim, marginTop: 2 }}>{it.detail}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {retryable > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <GhostButton label={`Retry ${retryable} Product${retryable === 1 ? "" : "s"}`} icon="refresh" isDark={isDark} onClick={onRetry} />
          <span style={{ fontSize: 11.5, color: t.dim }}>Retries failed products and completes Treatment Items for products assigned without one. Products are re-checked first — a policy is never written twice and no duplicate item is created.</span>
        </div>
      )}
    </div>
  );
}
