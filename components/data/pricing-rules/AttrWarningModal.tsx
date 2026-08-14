"use client";

import { Ic, tokens, PrimaryButton } from "./shared";

export interface AttrWarningModalState {
  show: boolean;
  invalidAttributes: string[];
  invalidValues: { attributeName: string; attributeValue: string }[];
  appliedCount: number;
}

/** Blocking modal shown when AI-extracted entries don't map onto the Salesforce-fetched rows. */
export default function AttrWarningModal({ isDark, state, onClose }: { isDark: boolean; state: AttrWarningModalState; onClose: () => void }) {
  const t = tokens(isDark);
  if (!state.show) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ width: 480, maxHeight: "70vh", overflowY: "auto", borderRadius: 14, background: t.surface, border: `1px solid ${t.border}`, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.warn, fontWeight: 700, fontSize: 14 }}>
          <Ic n="alert" s={17} /> Some AI-extracted entries didn&apos;t match
        </div>
        <div style={{ fontSize: 12.5, color: t.body }}>
          {state.appliedCount} entr{state.appliedCount === 1 ? "y" : "ies"} applied successfully. The rest couldn&apos;t be matched against this product&apos;s actual Salesforce attributes/values:
        </div>
        {state.invalidAttributes.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, marginBottom: 4 }}>Unrecognized attribute names</div>
            <div style={{ fontSize: 12.5, color: t.body }}>{state.invalidAttributes.join(", ")}</div>
          </div>
        )}
        {state.invalidValues.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, marginBottom: 4 }}>Unrecognized values</div>
            <div style={{ fontSize: 12.5, color: t.body }}>
              {state.invalidValues.map((v, i) => <div key={i}>{v.attributeName}: {v.attributeValue}</div>)}
            </div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <PrimaryButton label="Got it" isDark={isDark} onClick={onClose} />
        </div>
      </div>
    </div>
  );
}
