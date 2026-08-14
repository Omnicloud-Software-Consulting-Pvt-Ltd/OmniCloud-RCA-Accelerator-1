"use client";

import { Ic, tokens, GhostButton } from "@/components/data/quotes/shared";
import type { DuplicateCheckResult } from "@/lib/duplicateDetection";

/**
 * The one Duplicate Prevention modal shared by every Product/Bundle
 * creation surface (RCProductWorkspace, MultiProductWorkspace,
 * BundleOrchestrationWorkspace) — centered overlay, existing app styling
 * (tokens/Ic from components/data/quotes/shared, the same primitives every
 * other modal built this session uses). Two modes driven by
 * `result.isDuplicate`:
 *  - true  → BLOCKING: "X Already Exists", no dismiss-and-proceed action,
 *            no "Create Anyway" (§5, §10) — only View/Use Existing/Edit
 *            Existing/Choose Another Name.
 *  - false (but similarRecords.length > 0) → ADVISORY: a dismissible
 *            "Similar X Found" nudge — creation is NOT blocked, since there
 *            is no exact match; the user can continue or rename.
 */
export default function DuplicateRecordModal({
  isDark, kind, requestedName, result, onClose, onChooseAnotherName, onUseExisting, onEditExisting, useExistingLabel,
}: {
  isDark: boolean;
  kind: "product" | "bundle";
  requestedName: string;
  result: DuplicateCheckResult;
  /** Dismiss without action — for the advisory case this means "continue creating as originally requested." */
  onClose: () => void;
  onChooseAnotherName: () => void;
  onUseExisting?: () => void;
  onEditExisting?: () => void;
  useExistingLabel?: string;
}) {
  const t = tokens(isDark);
  const nounCap = kind === "product" ? "Product" : "Bundle";
  const blocking = result.isDuplicate;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)" }}
      onClick={blocking ? undefined : onClose}
    >
      <div
        style={{ width: 460, maxWidth: "100%", borderRadius: 16, background: t.surface, border: `1px solid ${t.border}`, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
          <span style={{ color: blocking ? "#F59E0B" : t.accentBlue }}><Ic n="alert" s={18} /></span>
          <h3 style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>
            {blocking ? `${nounCap} Already Exists` : `Similar ${nounCap}s Found`}
          </h3>
        </div>
        <p style={{ fontSize: 12.5, color: t.dim, marginBottom: 16 }}>
          {blocking && result.isDuplicate
            ? `"${result.recordName}" already exists in your Salesforce organization.`
            : `We found ${nounCap.toLowerCase()}s with names similar to "${requestedName}" — double-check this isn't a duplicate before continuing.`}
        </p>

        {blocking && result.isDuplicate && (
          <div style={{ borderRadius: 12, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: 14, marginBottom: 14 }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: t.dim, marginBottom: 8 }}>Existing {nounCap}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: t.heading }}>{result.existing.recordName}</span>
              <span style={{ fontSize: 11.5, color: t.dim }}>
                {result.existing.recordCode ?? "No code"} · {result.existing.isActive ? "Active" : "Inactive"}
                {result.existing.family ? ` · ${result.existing.family}` : ""}
              </span>
              {kind === "bundle" && result.existing.componentCount != null && (
                <span style={{ fontSize: 11.5, color: t.dim }}>
                  {result.existing.componentCount} component{result.existing.componentCount === 1 ? "" : "s"}
                  {result.existing.sellingModel ? ` · ${result.existing.sellingModel}` : ""}
                  {result.existing.catalog ? ` · ${result.existing.catalog}` : ""}
                  {result.existing.category ? ` · ${result.existing.category}` : ""}
                </span>
              )}
              {result.existing.lastModifiedDate && (
                <span style={{ fontSize: 10.5, color: t.dim }}>Last modified {new Date(result.existing.lastModifiedDate).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        )}

        {result.similarRecords.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: t.dim, marginBottom: 8 }}>Similar {nounCap}s</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {result.similarRecords.map(r => (
                <div key={r.recordId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.body }}>
                  <span style={{ color: t.dim }}>○</span> {r.recordName}
                  {r.recordCode ? <span style={{ color: t.dim, fontSize: 11 }}>({r.recordCode})</span> : null}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {blocking && result.isDuplicate && (
            <button
              onClick={() => window.open(result.salesforceUrl, "_blank", "noopener,noreferrer")}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 700, color: "#04101F", cursor: "pointer", background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` }}
            >
              <Ic n="external-link" s={13} /> View in Salesforce
            </button>
          )}
          {onUseExisting && (
            <button
              onClick={onUseExisting}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px 16px", borderRadius: 10, border: `1px solid ${t.accent}55`, fontSize: 12.5, fontWeight: 700, color: t.accent, cursor: "pointer", background: "transparent" }}
            >
              {useExistingLabel ?? `Use Existing ${nounCap}`}
            </button>
          )}
          {kind === "bundle" && onEditExisting && (
            <button
              onClick={onEditExisting}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px 16px", borderRadius: 10, border: `1px solid ${t.accentBlue}55`, fontSize: 12.5, fontWeight: 700, color: t.accentBlue, cursor: "pointer", background: "transparent" }}
            >
              <Ic n="edit" s={13} /> Edit Existing Bundle
            </button>
          )}
          <GhostButton label="Choose Another Name" icon="edit" isDark={isDark} onClick={onChooseAnotherName} />
          {!blocking && <GhostButton label="Continue Anyway" isDark={isDark} onClick={onClose} />}
        </div>
      </div>
    </div>
  );
}
