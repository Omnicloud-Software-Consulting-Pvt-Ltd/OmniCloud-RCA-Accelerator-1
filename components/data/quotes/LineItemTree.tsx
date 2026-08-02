"use client";

import { useState } from "react";
import { Ic, tokens, inputStyle, formatCurrency, Pill, Spinner, CodeBlock } from "@/components/data/quotes/shared";
import { displayLineTotal, netUnitPrice } from "@/lib/quotes/pricing/calc";
import type { BundleExpansionDiagnostics, PricingModel, QuoteLineItemDraft } from "@/lib/quotes/types";

interface LineItemTreeProps {
  isDark: boolean;
  roots: QuoteLineItemDraft[];
  pricingModel: PricingModel;
  onUpdate: (draftId: string, patch: Partial<QuoteLineItemDraft>) => void;
  onRemove: (draftId: string) => void;
  /** Root productIds whose /products/configure call hasn't resolved yet — shows "Loading bundle components…" under the row instead of freezing the whole screen (§Slow Add fix, Issue 2B). */
  pendingProductIds?: Set<string>;
  /** Root productId -> the FULL bundle-expansion diagnostics from its /products/configure call — including this org's actual classification (BUNDLE_WITH_COMPONENTS/NOT_A_BUNDLE/QUERY_FAILED/SCHEMA_UNRESOLVED/RELATIONSHIP_MAPPING_FAILED), never just the boolean isBundle. Shown per-row via an expandable disclosure so a genuine bundle that resolved to 0 components is never indistinguishable from a real standalone product. */
  bundleDiagnosticsByProductId?: Map<string, BundleExpansionDiagnostics>;
}

const CLASSIFICATION_COLOR: Record<BundleExpansionDiagnostics["classification"], "ok" | "warn" | "error"> = {
  BUNDLE_WITH_COMPONENTS: "ok",
  NOT_A_BUNDLE: "ok",
  QUERY_FAILED: "error",
  SCHEMA_UNRESOLVED: "error",
  RELATIONSHIP_MAPPING_FAILED: "error",
};

function BundleDiagnosticsDisclosure({ isDark, diagnostics }: { isDark: boolean; diagnostics: BundleExpansionDiagnostics }) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(false);
  const kind = CLASSIFICATION_COLOR[diagnostics.classification];
  const color = kind === "ok" ? t.accent : kind === "warn" ? t.warn : t.error;
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", cursor: "pointer", padding: 0, fontSize: 10.5, color }}
      >
        <Ic n={open ? "chevron-down" : "chevron-right"} s={10} />
        Bundle detection: {diagnostics.classification} ({diagnostics.resolvedChildCount} component{diagnostics.resolvedChildCount === 1 ? "" : "s"})
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: 10, borderRadius: 8, border: `1px solid ${color}40`, background: t.surfaceAlt }}>
          <div style={{ fontSize: 11, color: t.body, marginBottom: 6 }}>
            {diagnostics.reasons.map((r, i) => <div key={i}>• {r}</div>)}
          </div>
          {diagnostics.queryErrors.length > 0 && (
            <div style={{ fontSize: 11, color: t.error, marginBottom: 6 }}>
              {diagnostics.queryErrors.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
          <CodeBlock isDark={isDark} data={diagnostics} />
        </div>
      )}
    </div>
  );
}

function LineItemRow({ isDark, node, depth, pricingModel, onUpdate, onRemove, pending, bundleDiagnostics }: {
  isDark: boolean; node: QuoteLineItemDraft; depth: number; pricingModel: PricingModel;
  onUpdate: LineItemTreeProps["onUpdate"]; onRemove: LineItemTreeProps["onRemove"]; pending?: boolean;
  bundleDiagnostics?: BundleExpansionDiagnostics;
}) {
  const t = tokens(isDark);
  const total = displayLineTotal(node);
  const manualPricing = pricingModel === "ManualPricing";

  return (
    <div>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10,
          border: `1px solid ${t.border}`, background: depth === 0 ? t.surfaceAlt : "transparent",
          marginLeft: depth * 20, marginBottom: 6,
        }}
      >
        <span style={{ color: t.accent, flexShrink: 0 }}><Ic n={node.isBundleParent ? "layers" : "cube"} s={14} /></span>
        <div style={{ minWidth: 160, flex: "1 1 auto" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, display: "flex", alignItems: "center", gap: 6 }}>
            {node.product.name}
            {node.pricingInclusion && <Pill label="Included in bundle" color={t.accentCyan} isDark={isDark} />}
            {node.pricebookStatus === "missing" && <Pill label="No PricebookEntry" color={t.error} isDark={isDark} />}
            {node.sellingModelType === "Evergreen" || node.sellingModelType === "TermDefined" ? (
              node.billingFrequency
                ? <Pill label={`Billing: ${node.billingFrequency}`} color={t.accent} isDark={isDark} />
                : <Pill label="Billing Frequency unresolved" color={t.error} isDark={isDark} />
            ) : null}
          </div>
          {node.componentGroupId && <div style={{ fontSize: 11, color: t.dim }}>Bundle component</div>}
          {pending && (
            <div style={{ fontSize: 11, color: t.dim, display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
              <Spinner isDark={isDark} size={10} /> Loading bundle components…
            </div>
          )}
          {depth === 0 && bundleDiagnostics && <BundleDiagnosticsDisclosure isDark={isDark} diagnostics={bundleDiagnostics} />}
        </div>

        {depth === 0 ? (
          <>
            <NumberField label="Qty" value={node.quantity} width={56} onChange={v => onUpdate(node.draftId, { quantity: v })} t={t} />
            <NumberField label="Disc %" value={node.discountPercent} width={60} onChange={v => onUpdate(node.draftId, { discountPercent: v })} t={t} />
            {manualPricing && (
              <NumberField label="Unit $" value={node.unitPrice} width={78} onChange={v => onUpdate(node.draftId, { unitPrice: v })} t={t} />
            )}
          </>
        ) : (
          // §Bundle children: Quantity/Discount are inherited from the bundle
          // relationship's own configuration, not independently editable here —
          // shown read-only rather than as an editable NumberField.
          <div style={{ display: "flex", flexDirection: "column", gap: 2, width: 56 }}>
            <span style={{ fontSize: 9.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Qty</span>
            <span style={{ fontSize: 12, color: t.dim, padding: "5px 0" }}>{node.quantity}</span>
          </div>
        )}

        <div style={{ minWidth: 90, textAlign: "right", fontSize: 13, fontWeight: 700, color: node.pricingInclusion ? t.dim : t.heading }}>
          {node.pricingInclusion ? "—" : formatCurrency(total)}
        </div>

        <button
          onClick={() => onRemove(node.draftId)}
          style={{ background: "transparent", border: "none", cursor: "pointer", color: t.error, flexShrink: 0 }}
          title="Remove"
        >
          <Ic n="trash" s={14} />
        </button>
      </div>

      {!manualPricing && (
        <div style={{ marginLeft: depth * 20 + 34, marginTop: -4, marginBottom: 6, fontSize: 10.5, color: t.dim }}>
          Net unit price: {formatCurrency(netUnitPrice(node.unitPrice, node.discountPercent))} (computed by Salesforce repricing after save)
        </div>
      )}

      {node.children.map(child => (
        <LineItemRow key={child.draftId} isDark={isDark} node={child} depth={depth + 1} pricingModel={pricingModel} onUpdate={onUpdate} onRemove={onRemove} />
      ))}
    </div>
  );
}

function NumberField({ label, value, width, onChange, t }: { label: string; value: number; width: number; onChange: (v: number) => void; t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ...inputStyle(t), width, padding: "5px 8px", fontSize: 12 }}
      />
    </div>
  );
}

export default function LineItemTree({ isDark, roots, pricingModel, onUpdate, onRemove, pendingProductIds, bundleDiagnosticsByProductId }: LineItemTreeProps) {
  const t = tokens(isDark);
  if (roots.length === 0) {
    return <div style={{ fontSize: 12.5, color: t.dim, padding: "16px 4px" }}>No line items yet — add a product from the catalog above.</div>;
  }
  return (
    <div>
      {roots.map(node => (
        <LineItemRow
          key={node.draftId} isDark={isDark} node={node} depth={0} pricingModel={pricingModel}
          onUpdate={onUpdate} onRemove={onRemove} pending={pendingProductIds?.has(node.productId)}
          bundleDiagnostics={bundleDiagnosticsByProductId?.get(node.productId)}
        />
      ))}
    </div>
  );
}
