"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PrimaryButton, GhostButton, PageShell, FooterBar, Spinner, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import { BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { Panel, StatusPill, Modal, Row } from "@/components/data/billing/billingUi";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { quoteApiPost, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { toBillingErrorPanel } from "@/lib/billing/client";
import type { AssignmentAiResult, AssignmentCheck, AssignmentPolicyChain, AssignmentProduct } from "@/lib/billing/server/assignment";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure } from "@/components/ui/Disclosure";
import PromptGuide from "@/components/ai/PromptGuide";
import { billingPromptGuides } from "@/lib/ai/promptGuides/billing";

type Ref = { id: string; name: string };
interface AssignResult { success: true; product: AssignmentProduct; policy: AssignmentPolicyChain; previousPolicy: { id: string; name: string } | null; productUrl: string; policyUrl: string }

const keyOf = (p: Ref | null, b: Ref | null, replace: boolean) => `${p?.id ?? ""}|${b?.id ?? ""}|${replace ? "r" : ""}`;

/**
 * Assign an EXISTING Billing Policy to an EXISTING Product (Product2.<discovered field>).
 *
 *   AI prompt (optional) ─┐
 *   manual lookups ───────┴→ checkAssignment (server) → existing-policy check → chain validation
 *     → NONE: preview → Assign        EXISTS: blocking conflict → Keep / Choose another / Replace
 *                                        → Replace needs a second explicit confirmation
 *
 * Both paths call the same server endpoints; nothing is written until the user presses Assign, and
 * an existing policy is never overwritten without the explicit two-step confirmation.
 */
export default function BillingAssignWorkspace({ isDark, initialProductId, initialPolicyId, onCancel, onViewProduct, onViewPolicy, onAssigned }: {
  isDark: boolean;
  initialProductId?: string | null;
  initialPolicyId?: string | null;
  onCancel: () => void;
  onViewProduct: (id: string) => void;
  onViewPolicy: (id: string) => void;
  onAssigned?: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const selectionRef = useRef<HTMLDivElement>(null);
  const [product, setProduct] = useState<Ref | null>(null);
  const [policy, setPolicy] = useState<Ref | null>(null);
  const [prefillDone, setPrefillDone] = useState(!initialProductId && !initialPolicyId);
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<AssignmentAiResult | null>(null);
  const [check, setCheck] = useState<{ key: string; data: AssignmentCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [replace, setReplace] = useState<{ key: string; expectedCurrentPolicyId: string } | null>(null);
  const [modal, setModal] = useState<null | "conflict" | "confirm">(null);
  const [busy, setBusy] = useState<null | "ai" | "assign">(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<AssignResult | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);

  const replacing = !!replace && replace.key === keyOf(product, policy, false);
  const currentKey = keyOf(product, policy, replacing);

  async function runCheck(p: Ref | null, b: Ref | null, allowReplace: boolean) {
    const key = keyOf(p, b, allowReplace);
    setChecking(true);
    setError(null);
    try {
      const data = await quoteApiPost<AssignmentCheck>("Validate Billing Policy assignment", "/api/billing/assignments/check", { productId: p?.id ?? null, policyId: b?.id ?? null, allowReplace });
      setCheck({ key, data });
      if (data.status === "conflict") setModal("conflict");
      return data;
    } catch (err) {
      setError(toBillingErrorPanel(err, "Could not validate the assignment"));
      return null;
    } finally {
      setChecking(false);
    }
  }

  // Deep link (from a Product or a Billing Policy): resolve the preselected record(s) through the same check.
  useEffect(() => {
    if (prefillDone) return;
    let cancelled = false;
    quoteApiPost<AssignmentCheck>("Load assignment", "/api/billing/assignments/check", { productId: initialProductId ?? null, policyId: initialPolicyId ?? null })
      .then(d => {
        if (cancelled) return;
        if (d.product) setProduct({ id: d.product.id, name: d.product.name });
        if (d.policy) setPolicy({ id: d.policy.id, name: d.policy.name });
        setCheck({ key: keyOf(d.product ? { id: d.product.id, name: d.product.name } : null, d.policy ? { id: d.policy.id, name: d.policy.name } : null, false), data: d });
      })
      .catch(err => { if (!cancelled) setError(toBillingErrorPanel(err, "Could not load the selected records")); })
      .finally(() => { if (!cancelled) setPrefillDone(true); });
    return () => { cancelled = true; };
  }, [prefillDone, initialProductId, initialPolicyId]);

  // Every change of Product / Billing Policy re-checks Salesforce immediately (existing policy + chain).
  useEffect(() => {
    if (!prefillDone || (!product && !policy) || check?.key === currentKey) return;
    const handle = setTimeout(() => { void runCheck(product, policy, replacing); }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, prefillDone]);

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy("ai");
    setError(null);
    setNotice(null);
    try {
      const res = await quoteApiPost<AssignmentAiResult>("AI assign Billing Policy", "/api/billing/assignments/ai", { prompt });
      setAi(res);
      setReplace(null);
      const p = res.product.match ? { id: res.product.match.id, name: res.product.match.name } : null;
      const b = res.policy.match ? { id: res.policy.match.id, name: res.policy.match.name } : null;
      setProduct(p);
      setPolicy(b);
      if (res.check) {
        setCheck({ key: keyOf(p, b, false), data: res.check });
        if (res.check.status === "conflict") setModal("conflict");
      }
    } catch (err) {
      setError(toBillingErrorPanel(err, "AI analysis failed"));
    } finally {
      setBusy(null);
    }
  }

  async function assign() {
    const c = check?.data;
    if (!product || !policy || !c || c.status !== "ready" || check?.key !== currentKey) return;
    setBusy("assign");
    setError(null);
    try {
      const res = await quoteApiPost<AssignResult>("Assign Billing Policy", "/api/billing/assignments", {
        productId: product.id, policyId: policy.id,
        confirmReplace: replacing, expectedCurrentPolicyId: c.product?.currentPolicy?.id ?? null,
      });
      setResult(res);
      onAssigned?.();
      notifySalesforceSuccess({
        title: "Billing Policy Assigned",
        message: `${res.product.name} → ${res.policy.name}${res.previousPolicy ? ` (was ${res.previousPolicy.name})` : ""}`,
        records: [{ objectApiName: "Product2", recordId: res.product.id, recordName: res.product.name, salesforceUrl: res.productUrl }],
      });
    } catch (err) {
      const panel = toBillingErrorPanel(err, "Salesforce didn't assign the Billing Policy");
      setError(panel);
      const raw = panel.raw as { check?: AssignmentCheck } | undefined;
      if (raw?.check) { setCheck({ key: currentKey, data: raw.check }); if (raw.check.status === "conflict") setModal("conflict"); }
    } finally {
      setBusy(null);
    }
  }

  /* ── Success ── */
  if (result) {
    return (
      <PageShell>
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ borderRadius: 16, padding: 20, border: "1px solid rgba(0,200,117,0.35)", background: isDark ? "rgba(0,200,117,0.07)" : "rgba(0,200,117,0.06)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 36, height: 36, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", color: "#00C875", background: "rgba(0,200,117,0.14)", border: "1px solid rgba(0,200,117,0.35)" }}><Ic n="check-circle" s={18} /></span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>✓ Billing Policy Assigned</div>
              <div style={{ fontSize: 12, color: t.dim }}>Confirmed by re-reading the product from Salesforce{result.previousPolicy ? ` — replaced "${result.previousPolicy.name}"` : ""}.</div>
            </div>
          </div>
          <Panel isDark={isDark} title="Salesforce relationship" icon="link">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Row isDark={isDark} label="Product">{result.product.name}{result.product.code ? ` (${result.product.code})` : ""}</Row>
              <Row isDark={isDark} label="Billing Policy">{result.policy.name} <StatusPill status={result.policy.status} isDark={isDark} /></Row>
              <Row isDark={isDark} label="Default Treatment">{result.policy.defaultTreatment?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Treatment Item">{result.policy.items.map(i => i.name).join(", ") || "—"}</Row>
              <Row isDark={isDark} label="Salesforce Product ID"><code>{result.product.id}</code></Row>
              <Row isDark={isDark} label="Billing Policy ID"><code>{result.policy.id}</code></Row>
            </div>
          </Panel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label="View Product" icon="package" isDark={isDark} onClick={() => onViewProduct(result.product.id)} />
            <GhostButton label="View Billing Policy" icon="eye" isDark={isDark} onClick={() => onViewPolicy(result.policy.id)} />
            <GhostButton label="Assign another" icon="plus" isDark={isDark} onClick={() => { setResult(null); setProduct(null); setPolicy(null); setCheck(null); setReplace(null); setAi(null); setPrompt(""); }} />
          </div>
        </motion.div>
      </PageShell>
    );
  }

  const c = check?.key === currentKey ? check.data : null;
  const current = c?.product?.currentPolicy ?? null;
  const canAssign = !!c && c.status === "ready" && !!product && !!policy && !busy && !checking && (!c.replace || replacing);
  const checkColor = (s: string) => (s === "passed" ? "#00C875" : s === "warning" ? t.warn : t.error);

  const footer = (
    <FooterBar isDark={isDark}>
      <GhostButton label="Cancel" icon="x" isDark={isDark} onClick={onCancel} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {checking && <span style={{ fontSize: 12, color: t.accent, display: "inline-flex", gap: 6, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Checking Salesforce…</span>}
        <GhostButton label="Edit" icon="edit" isDark={isDark} onClick={() => selectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
        <GhostButton label="Validate" icon="check-circle" isDark={isDark} disabled={!product || !policy || checking || !!busy} onClick={() => void runCheck(product, policy, replacing)} />
        <PrimaryButton label={busy === "assign" ? "Assigning…" : replacing ? "Change Billing Policy" : "Assign Billing Policy"} icon="link" isDark={isDark} disabled={!canAssign} onClick={assign} />
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Assign Billing Policy to Product</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>
            Links an existing Product to an existing Billing Policy {c?.field ? <>via <code>Product2.{c.field.name}</code> (discovered from Salesforce metadata)</> : "using the relationship discovered from Salesforce metadata"}. Nothing is created — only the Product&apos;s Billing Policy is updated.
          </div>
        </div>

        {/* ── AI (optional) ── */}
        <div style={{ borderRadius: 16, padding: 16, border: `1px solid ${t.accent}45`, background: isDark ? "linear-gradient(135deg, rgba(0,212,255,0.08), rgba(30,144,255,0.04))" : "linear-gradient(135deg, rgba(0,152,204,0.07), rgba(9,104,211,0.03))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 800, color: t.heading }}>
            <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sparkles" s={15} /></span> Assign Billing Policy with AI
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 999, padding: "1px 8px" }}>OPTIONAL</span>
          </div>
          <div style={{ fontSize: 12, color: t.dim, margin: "4px 0 10px" }}>Describe what you want to assign. Both records are looked up in Salesforce and the product&apos;s existing Billing Policy is checked — the AI never overwrites an assignment.</div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void analyze(); }} rows={2}
              placeholder='e.g. "Assign the Keyboard Monthly Billing Policy to the Keyboard product."' style={{ ...inputStyle(t), flex: "1 1 380px", resize: "vertical", fontSize: 13.5 }} />
            <PrimaryButton label={busy === "ai" ? "Analyzing…" : "Analyze & Verify"} icon="sparkles" isDark={isDark} disabled={!prompt.trim() || !!busy} onClick={analyze} />
          </div>
          {busy === "ai" && <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={13} /> Extracting the product and policy, looking both up in Salesforce, checking the existing assignment…</div>}
          {ai && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Actionable: a product/policy that wasn't found must be fixed before assigning — always visible. */}
              {[ai.product.message, ai.policy.message].filter(Boolean).map((m, i) => (
                <div key={i} style={{ fontSize: 12, color: t.error, fontWeight: 600 }}>✗ {m}</div>
              ))}
              <Disclosure isDark={isDark} label={DISCLOSURE_LABELS.ai} icon="cpu">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
              {([["Intent", ai.intent === "assign" ? "Assign Billing Policy to Product" : "Unsupported request", ai.intent === "assign" ? "ok" : "bad"],
                ["Product", ai.product.match ? `${ai.product.match.name} ✓ found` : ai.extraction.productName ?? "—", ai.product.match ? "ok" : "bad"],
                ["Billing Policy", ai.policy.match ? `${ai.policy.match.name} ✓ found` : ai.extraction.billingPolicyName ?? "—", ai.policy.match ? "ok" : "bad"]] as const).map(([k, v, s]) => (
                <div key={k} style={{ padding: "8px 10px", borderRadius: 10, border: `1px solid ${s === "ok" ? "rgba(0,200,117,0.4)" : t.error + "50"}`, background: t.surface, fontSize: 12 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase" }}>{k}</div>
                  <div style={{ fontWeight: 700, color: s === "ok" ? t.heading : t.error }}>{v}</div>
                </div>
              ))}
            </div>
              </Disclosure>
              <WarningsDisclosure isDark={isDark} warnings={ai.warnings.filter(Boolean)} />
            </div>
          )}
          <div style={{ marginTop: 10 }}><PromptGuide isDark={isDark} config={billingPromptGuides.assignPolicy} onUseExample={setPrompt} /></div>
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        {notice && <div style={{ fontSize: 12.5, color: t.body, padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.accent}40`, background: `${t.accent}0c` }}>{notice}</div>}

        {/* ── Manual selection (the same request the AI produces) ── */}
        <div ref={selectionRef} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, scrollMarginTop: 12 }}>
          <Panel isDark={isDark} title="Product" icon="package">
            <ReferenceLookup isDark={isDark} objectType="Product2" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={product}
              onChange={v => { setProduct(v); setNotice(null); }} placeholder="Search Products by name or product code…" noMatchHint="No matching Product found in Salesforce." />
            {c?.product && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                <Row isDark={isDark} label="Selected">{c.product.name}</Row>
                {c.product.code && <Row isDark={isDark} label="Product Code">{c.product.code}</Row>}
                {c.product.active !== null && <Row isDark={isDark} label="Active">{c.product.active ? "Yes" : "No"}</Row>}
                <Row isDark={isDark} label="Current Billing Policy">{c.product.currentPolicy ? <>{c.product.currentPolicy.name} <StatusPill status={c.product.currentPolicy.status} isDark={isDark} /></> : <span style={{ color: "#00C875" }}>None</span>}</Row>
                <Row isDark={isDark} label="Salesforce ID"><code style={{ fontWeight: 500 }}>{c.product.id}</code></Row>
              </div>
            )}
          </Panel>
          <Panel isDark={isDark} title="Billing Policy" icon="shield">
            <ReferenceLookup isDark={isDark} objectType="BillingPolicy" searchEndpoint={BILLING_SEARCH_ENDPOINT} value={policy}
              onChange={v => { setPolicy(v); setNotice(null); }} placeholder="Search Billing Policies…" noMatchHint="No matching Billing Policy found in Salesforce." />
            {c?.policy && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                <Row isDark={isDark} label="Status"><StatusPill status={c.policy.status} isDark={isDark} /></Row>
                <Row isDark={isDark} label="Treatment Selection">{c.policy.selection ?? "—"}</Row>
                <Row isDark={isDark} label="Default Treatment">{c.policy.defaultTreatment ? <>{c.policy.defaultTreatment.name} <StatusPill status={c.policy.defaultTreatment.status} isDark={isDark} /></> : <span style={{ color: t.error }}>None</span>}</Row>
                <Row isDark={isDark} label="Treatment Items">{c.policy.items.length ? c.policy.items.map(i => `${i.name} (${i.status ?? "—"})`).join(", ") : <span style={{ color: t.error }}>None</span>}</Row>
                <Row isDark={isDark} label="Assigned to">{c.policy.products.length ? c.policy.products.map(p => p.name).join(", ") : "No products yet"}</Row>
              </div>
            )}
          </Panel>
        </div>

        {/* ── Preview + validation ── */}
        {c && product && policy && (
          <Panel isDark={isDark} title="Assignment Preview" icon="link" right={
            <span style={{ fontSize: 11.5, fontWeight: 700, color: c.status === "ready" ? "#00C875" : c.status === "already-assigned" ? t.accent : t.error }}>
              {c.status === "ready" ? (c.replace ? "Ready to change (confirmed)" : "✓ Ready to assign") : c.status === "already-assigned" ? "Already assigned" : c.status === "conflict" ? "⚠ Billing Policy Already Assigned" : "✗ Blocked"}
            </span>}>
            {c.status === "ready" && !c.replace && <div style={{ fontSize: 12.5, color: "#00C875", fontWeight: 700, marginBottom: 10 }}>✓ Product does not currently have a Billing Policy.</div>}
            {c.status === "already-assigned" && <div style={{ fontSize: 12.5, color: t.accent, fontWeight: 700, marginBottom: 10 }}>{c.product?.name} is already assigned to {c.policy?.name} — nothing to change.</div>}
            {c.status === "conflict" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ fontSize: 12.5, color: t.warn, fontWeight: 700 }}>⚠ {c.product?.name} already has &ldquo;{current?.name}&rdquo;. It will not be overwritten without explicit confirmation.</span>
                <GhostButton label="Review options" icon="alert" isDark={isDark} onClick={() => setModal("conflict")} />
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <Row isDark={isDark} label="Product">{c.product?.name}</Row>
              <Row isDark={isDark} label="Current Billing Policy">{current?.name ?? "None"}</Row>
              <Row isDark={isDark} label="New Billing Policy">{c.policy?.name}</Row>
              <Row isDark={isDark} label="Default Treatment">{c.policy?.defaultTreatment?.name ?? "—"}</Row>
              <Row isDark={isDark} label="Treatment Item">{c.policy?.items.map(i => i.name).join(", ") || "—"}</Row>
              {c.replace && replacing && <Row isDark={isDark} label="Change"><span style={{ color: t.warn }}>{c.product?.name}: {current?.name} → {c.policy?.name}</span></Row>}
            </div>
            <div style={{ marginTop: 14, fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Salesforce Relationship</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              {[["Product", c.product?.name], [`Billing Policy (Product2.${c.field?.name ?? "?"})`, c.policy?.name], ["Default Treatment", c.policy?.defaultTreatment?.name], ["Treatment Item", c.policy?.items[0]?.name]].map(([k, v], i) => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {i > 0 && <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="arrow-right" s={12} /></span>}
                  <span style={{ display: "flex", flexDirection: "column", padding: "6px 10px", borderRadius: 10, border: `1px solid ${v ? "rgba(0,200,117,0.45)" : t.error + "60"}`, background: v ? "rgba(0,200,117,0.07)" : `${t.error}0c` }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: t.dim }}>{k}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: v ? t.heading : t.error }}>{v ?? "missing"}</span>
                  </span>
                </span>
              ))}
            </div>
            <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 6 }}>
              {c.checks.map(ch => (
                <div key={ch.id} title={ch.detail} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: t.body, padding: "6px 9px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
                  <span style={{ color: checkColor(ch.status), display: "inline-flex" }}><Ic n={ch.status === "passed" ? "check-circle" : "alert"} s={13} /></span>
                  <span style={{ flex: 1 }}>{ch.label}</span>
                </div>
              ))}
            </div>
            {c.blockers.map((b, i) => <div key={i} style={{ marginTop: 8, fontSize: 12.5, color: t.error, fontWeight: 600 }}>✗ {b}</div>)}
            {c.warnings.length > 0 && <div style={{ marginTop: 8 }}><WarningsDisclosure isDark={isDark} warnings={c.warnings} /></div>}
            <div style={{ marginTop: 12 }}>
              <GhostButton label={showTechnical ? "Hide technical details" : "Show technical details"} icon="terminal" isDark={isDark} onClick={() => setShowTechnical(v => !v)} />
              {showTechnical && <div style={{ marginTop: 8 }}><CodeBlock open isDark={isDark} data={{ check: c, ai: ai?.rawAi ?? null }} /></div>}
            </div>
          </Panel>
        )}
      </div>

      <AnimatePresence>
        {modal === "conflict" && c?.conflict && (
          <Modal isDark={isDark} title="Billing Policy Already Assigned" tone="warn" actions={<>
            <GhostButton label="Keep Existing Policy" isDark={isDark} onClick={() => { setModal(null); setPolicy(null); setReplace(null); setNotice(`Kept "${c.conflict!.existingBillingPolicy}" on ${c.conflict!.product}. Nothing was changed in Salesforce.`); }} />
            <GhostButton label="Choose Another Product" icon="package" isDark={isDark} onClick={() => { setModal(null); setProduct(null); setReplace(null); setTimeout(() => selectionRef.current?.querySelector("input")?.focus(), 50); }} />
            <PrimaryButton label="Change Existing Billing Policy" icon="edit" isDark={isDark} onClick={() => setModal("confirm")} />
          </>}>
            <div>The product <strong>{c.conflict.product}</strong> already has the following Billing Policy:</div>
            <div style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}10` }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase" }}>Existing Billing Policy</div>
              <div style={{ fontWeight: 800, color: t.heading }}>{c.conflict.existingBillingPolicy}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginTop: 6 }}>Requested Billing Policy</div>
              <div style={{ fontWeight: 800, color: t.heading }}>{c.conflict.requestedBillingPolicy}</div>
            </div>
            <div>You cannot assign another Billing Policy to this product without changing the existing assignment. What would you like to do?</div>
          </Modal>
        )}
        {modal === "confirm" && c?.conflict && (
          <Modal isDark={isDark} title="Confirm Billing Policy Change" tone="accent" actions={<>
            <GhostButton label="Cancel" isDark={isDark} onClick={() => setModal("conflict")} />
            <PrimaryButton label="Confirm Change" icon="check" isDark={isDark} onClick={() => {
              setModal(null);
              setReplace({ key: keyOf(product, policy, false), expectedCurrentPolicyId: c.conflict!.existingBillingPolicyId });
              void runCheck(product, policy, true);
            }} />
          </>}>
            <Row isDark={isDark} label="Current Billing Policy">{c.conflict.existingBillingPolicy}</Row>
            <Row isDark={isDark} label="New Billing Policy">{c.conflict.requestedBillingPolicy}</Row>
            <Row isDark={isDark} label="Change"><span style={{ color: t.warn }}>{c.conflict.product}: {c.conflict.existingBillingPolicy} → {c.conflict.requestedBillingPolicy}</span></Row>
            <div style={{ fontSize: 12, color: t.dim }}>Confirming re-validates the new policy&apos;s billing chain. Salesforce is only updated when you then press <strong>Change Billing Policy</strong>.</div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
