"use client";

import { useMemo, useState } from "react";
import { Ic, tokens, inputStyle, PrimaryButton, GhostButton, formatCurrency } from "@/components/data/quotes/shared";
import { autoSelectComponents, createRootDraft, buildDraftChildrenFromSelection } from "@/lib/quotes/bundles/autoSelect";
import { flattenDraftTree } from "@/lib/quotes/pricing/calc";
import { quoteApiPost } from "@/lib/quotes/client/apiClient";
import type { BundleComponent, QuoteLineItemDraft } from "@/lib/quotes/types";
import type { OrderProductConfigurationResult } from "@/lib/orders/types";

/** Flatten a BundleComponent tree (all depths) — used to look up each draft node's originating component for its resolved billing-frequency active options. */
function flattenComponents(components: BundleComponent[]): BundleComponent[] {
  return components.flatMap(c => [c, ...flattenComponents(c.children)]);
}

function needsManualBillingFrequency(node: QuoteLineItemDraft): boolean {
  return (node.sellingModelType === "Evergreen" || node.sellingModelType === "TermDefined") && !node.billingFrequency;
}

/** Recursively apply user-chosen billing-frequency overrides (keyed by the originating relationship row) onto a built draft subtree — mirrors the Quote module's BundleConfiguratorDialog. */
function applyChildBillingFrequencyOverrides(nodes: QuoteLineItemDraft[], overrides: Record<string, string>): void {
  for (const node of nodes) {
    const override = node.relatedComponentId ? overrides[node.relatedComponentId] : undefined;
    if (override) {
      node.billingFrequency = override;
      node.billingFrequencySource = "manual-entry";
    }
    applyChildBillingFrequencyOverrides(node.children, overrides);
  }
}

/** Order-side bundle configurator dialog — same UI/behavior as the Quote module's
 * BundleConfiguratorDialog, reusing the identical object-agnostic bundle auto-select
 * service; only the Billing Policy recovery call is routed to the Order-side endpoint. */
export default function BundleConfiguratorDialog({ isDark, configuration, onConfirm, onCancel }: {
  isDark: boolean;
  configuration: OrderProductConfigurationResult;
  onConfirm: (draft: QuoteLineItemDraft) => void;
  onCancel: () => void;
}) {
  const t = tokens(isDark);
  const bundle = configuration.bundle;

  const initialSelected = useMemo(() => {
    if (!bundle) return new Set<string>();
    return new Set(autoSelectComponents(bundle.components, bundle.groups).map(c => c.productId));
  }, [bundle]);

  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [attributeValues, setAttributeValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const attr of configuration.attributes) if (attr.defaultValue != null) init[attr.attributeId] = attr.defaultValue;
    return init;
  });
  const [billingFrequency, setBillingFrequency] = useState<string | null>(configuration.billingFrequency?.value ?? null);
  // Real, currently-active Salesforce picklist values only — never a
  // free-text field a user could submit an arbitrary/invalid value through
  // (mirrors the Quote module's BundleConfiguratorDialog).
  const billingFrequencyOptions = configuration.billingFrequency?.activeOptions ?? [];
  const [childBillingFrequencies, setChildBillingFrequencies] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [billingBlocked, setBillingBlocked] = useState(configuration.billingTreatment?.blocks && configuration.billingTreatment.outcome !== "no-billing-policy");

  const missingRequiredAttrs = configuration.attributes.filter(a => a.required && !attributeValues[a.attributeId]);
  const needsBillingFrequency = !!configuration.sellingModel.chosen?.requiresBillingFrequency && !billingFrequency;

  // Bundle children whose own auto-resolution also failed — resolved against
  // the SAME final draft tree buildDraftChildrenFromSelection() will produce,
  // so this can never disagree with what's actually about to be submitted.
  const componentByRelationshipId = useMemo(() => {
    const map = new Map<string, BundleComponent>();
    if (bundle) for (const c of flattenComponents(bundle.components)) map.set(c.relationshipId, c);
    return map;
  }, [bundle]);
  const previewChildren = useMemo(
    () => (bundle ? buildDraftChildrenFromSelection(bundle.components, selected, "preview") : []),
    [bundle, selected],
  );
  const childNodesNeedingBillingFrequency = useMemo(
    () => flattenDraftTree(previewChildren).filter(needsManualBillingFrequency),
    [previewChildren],
  );
  const missingChildBillingFrequencies = childNodesNeedingBillingFrequency.filter(
    n => !n.relatedComponentId || !childBillingFrequencies[n.relatedComponentId],
  );

  const canConfirm = missingRequiredAttrs.length === 0 && !needsBillingFrequency && !billingBlocked && missingChildBillingFrequencies.length === 0;

  const categorized = useMemo(() => {
    const map = new Map<string, typeof configuration.attributes>();
    for (const attr of configuration.attributes) {
      const key = attr.category ?? "General";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(attr);
    }
    return [...map.entries()];
  }, [configuration.attributes]);

  const byGroup = useMemo(() => {
    if (!bundle) return [];
    const map = new Map<string, typeof bundle.components>();
    for (const c of bundle.components) {
      if (!c.groupId) continue;
      if (!map.has(c.groupId)) map.set(c.groupId, []);
      map.get(c.groupId)!.push(c);
    }
    return bundle.groups.map(g => ({ group: g, candidates: map.get(g.id) ?? [] })).filter(g => g.candidates.length > 0);
  }, [bundle]);

  // Components with no ProductComponentGroupId are a fixed part of the
  // bundle's structure, not a choice (see autoSelectComponents) — always
  // included and rendered here so the bundle's real composition is visible,
  // even though there's nothing for the user to toggle.
  const ungroupedComponents = useMemo(() => (bundle ? bundle.components.filter(c => !c.groupId) : []), [bundle]);

  async function handleRecover() {
    setRecovering(true);
    try {
      const res = await quoteApiPost<{ success: boolean; message: string }>(
        "Recover billing policy", "/api/orders/billing-policy/recover", { productId: configuration.product.id },
      );
      setRecoveryMessage(res.message);
      if (res.success) setBillingBlocked(false);
    } catch (err) {
      setRecoveryMessage(err instanceof Error ? err.message : "Recovery failed.");
    } finally {
      setRecovering(false);
    }
  }

  function toggle(productId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  function handleConfirm() {
    const root = createRootDraft(configuration.product, !!bundle?.isBundle);
    root.attributeValues = attributeValues;
    root.billingFrequency = billingFrequency;
    root.billingFrequencySource = configuration.billingFrequency?.source ?? (billingFrequency ? "manual-entry" : null);
    root.sellingModelOptionId = configuration.sellingModel.chosen?.id ?? null;
    root.sellingModelName = configuration.sellingModel.chosen?.name ?? null;
    root.sellingModelType = configuration.sellingModel.chosen?.type ?? null;
    root.billingTreatmentOutcome = configuration.billingTreatment?.outcome ?? null;
    if (bundle) {
      root.children = buildDraftChildrenFromSelection(bundle.components, selected, root.draftId);
      applyChildBillingFrequencyOverrides(root.children, childBillingFrequencies);
    }
    onConfirm(root);
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,8,24,0.6)", backdropFilter: "blur(4px)" }}>
      <div style={{ width: 560, maxHeight: "85vh", overflowY: "auto", borderRadius: 16, background: t.surface, border: `1px solid ${t.borderBright}`, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: t.heading }}>
            <Ic n="layers" s={16} /> Configure {configuration.product.name}
          </div>
          <button onClick={onCancel} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.dim }}>
            <Ic n="x" s={16} />
          </button>
        </div>

        {configuration.requiresConfigurationReasons.length > 0 && (
          <div style={{ fontSize: 12, color: t.dim, marginBottom: 14, display: "flex", flexDirection: "column", gap: 3 }}>
            {configuration.requiresConfigurationReasons.map((r, i) => <div key={i}>• {r}</div>)}
          </div>
        )}

        {needsBillingFrequency && (
          <div style={{ marginBottom: 14, padding: 10, borderRadius: 10, border: `1px solid ${t.warn}50`, fontSize: 12.5, color: t.body }}>
            This product requires a billing frequency, which could not be automatically resolved. Select one of the active Salesforce values to continue.
            <select
              value={billingFrequency ?? ""}
              onChange={e => setBillingFrequency(e.target.value || null)}
              style={{ ...inputStyle(t), marginTop: 8 }}
            >
              <option value="">Select…</option>
              {billingFrequencyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}

        {missingChildBillingFrequencies.length > 0 && (
          <div style={{ marginBottom: 14, padding: 10, borderRadius: 10, border: `1px solid ${t.warn}50`, fontSize: 12.5, color: t.body }}>
            The following bundle components require a billing frequency, which could not be automatically resolved. Select one of the active Salesforce values for each to continue.
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {missingChildBillingFrequencies.map(node => {
                const options = node.relatedComponentId
                  ? componentByRelationshipId.get(node.relatedComponentId)?.billingFrequency?.activeOptions ?? []
                  : [];
                return (
                  <label key={node.draftId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ color: t.body }}>{node.product.name}</span>
                    <select
                      value={(node.relatedComponentId && childBillingFrequencies[node.relatedComponentId]) || ""}
                      onChange={e => {
                        const key = node.relatedComponentId;
                        const value = e.target.value;
                        if (!key) return;
                        setChildBillingFrequencies(v => {
                          if (!value) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
                          return { ...v, [key]: value };
                        });
                      }}
                      style={inputStyle(t)}
                    >
                      <option value="">Select…</option>
                      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {configuration.billingTreatment?.outcome === "no-billing-policy" && (
          <div style={{ marginBottom: 14, padding: 10, borderRadius: 10, border: `1px solid ${t.warn}50`, fontSize: 12.5, color: t.body }}>
            {configuration.billingTreatment.message}
            <div style={{ marginTop: 8 }}>
              <GhostButton label={recovering ? "Recovering…" : "Recover Billing Policy"} icon="refresh" isDark={isDark} onClick={handleRecover} />
            </div>
            {recoveryMessage && <div style={{ marginTop: 6, color: t.dim }}>{recoveryMessage}</div>}
          </div>
        )}

        {billingBlocked && (
          <div style={{ marginBottom: 14, padding: 10, borderRadius: 10, border: `1px solid ${t.error}50`, fontSize: 12.5, color: t.error }}>
            {configuration.billingTreatment?.message} — this is a Revenue Cloud configuration issue in the connected org.
          </div>
        )}

        {categorized.map(([category, attrs]) => (
          <div key={category} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 8 }}>{category}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {attrs.map(attr => (
                <label key={attr.id} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
                  <span style={{ color: t.body }}>{attr.name}{attr.required && <span style={{ color: t.error }}> *</span>}</span>
                  {attr.dataType === "Picklist" && attr.options ? (
                    <select
                      value={attributeValues[attr.attributeId] ?? ""}
                      onChange={e => setAttributeValues(v => ({ ...v, [attr.attributeId]: e.target.value }))}
                      style={inputStyle(t)}
                    >
                      <option value="">Select…</option>
                      {attr.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : attr.dataType === "Checkbox" ? (
                    <input
                      type="checkbox"
                      checked={attributeValues[attr.attributeId] === "true"}
                      onChange={e => setAttributeValues(v => ({ ...v, [attr.attributeId]: String(e.target.checked) }))}
                    />
                  ) : (
                    <input
                      type={attr.dataType === "Number" || attr.dataType === "Currency" || attr.dataType === "Percent" ? "number" : attr.dataType === "Date" ? "date" : "text"}
                      value={attributeValues[attr.attributeId] ?? ""}
                      onChange={e => setAttributeValues(v => ({ ...v, [attr.attributeId]: e.target.value }))}
                      style={inputStyle(t)}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}

        {ungroupedComponents.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>
              Included in this bundle
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ungroupedComponents.map(c => (
                <div key={c.productId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}` }}>
                  <Ic n="check" s={13} />
                  <span style={{ flex: 1, color: t.body }}>{c.product?.name ?? c.productId}{c.quantity > 1 ? ` × ${c.quantity}` : ""}</span>
                  {c.pricebookStatus === "missing" && <span style={{ color: t.error, fontSize: 11 }}>No PricebookEntry</span>}
                  {c.product && <span style={{ color: t.dim, fontSize: 11.5 }}>{c.pricingInclusion ? "Included in bundle price" : formatCurrency(c.product.listPrice)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {byGroup.map(({ group, candidates }) => (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>
              {group.name}
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: t.dim }}>
                {candidates.filter(c => selected.has(c.productId)).length} selected{group.min != null ? ` · min ${group.min}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {candidates.map(c => (
                <label key={c.productId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}` }}>
                  <input type="checkbox" checked={selected.has(c.productId)} onChange={() => toggle(c.productId)} disabled={c.pricebookStatus !== "resolved"} />
                  <span style={{ flex: 1, color: t.body }}>{c.product?.name ?? c.productId}</span>
                  {c.pricebookStatus === "missing" && <span style={{ color: t.error, fontSize: 11 }}>No PricebookEntry</span>}
                  {c.product && <span style={{ color: t.dim, fontSize: 11.5 }}>{formatCurrency(c.product.listPrice)}</span>}
                </label>
              ))}
            </div>
          </div>
        ))}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <GhostButton label="Cancel" isDark={isDark} onClick={onCancel} />
          <PrimaryButton label="Add to Order" icon="check" isDark={isDark} disabled={!canConfirm} onClick={handleConfirm} />
        </div>
      </div>
    </div>
  );
}
