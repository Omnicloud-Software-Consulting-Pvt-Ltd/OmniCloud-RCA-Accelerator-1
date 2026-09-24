"use client";

import { Ic, tokens, PageShell } from "@/components/data/quotes/shared";

/**
 * "Choose Product Creation Type" — the new intermediate step between the
 * Products dashboard's "Create Product" card and the two actual creation
 * workspaces. Purely a navigation fork: it renders no fields, calls no
 * APIs, and creates nothing — clicking a card just tells the caller which
 * mode to switch to (app/data/page.tsx renders the existing
 * RCProductWorkspace for "single" and the new MultiProductWorkspace for
 * "multiple", unchanged otherwise).
 */
export default function ProductCreationChooser({
  isDark, onChooseSingle, onChooseMultiple,
}: {
  isDark: boolean;
  onChooseSingle: () => void;
  onChooseMultiple: () => void;
}) {
  const t = tokens(isDark);

  return (
    <PageShell>
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Choose Product Creation Type</h2>
        <p style={{ fontSize: 12, color: t.dim, marginTop: 4, marginBottom: 22, maxWidth: 620 }}>
          Create one product with the full AI-assisted workspace, or describe several products in a single prompt and create them all at once.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, maxWidth: 800 }}>
          <ChoiceCard
            isDark={isDark}
            icon="package"
            title="Single Product"
            description="Create one product using the AI-assisted product creation workspace."
            buttonLabel="Create Single Product"
            accent="#00D4FF"
            onClick={onChooseSingle}
          />
          <ChoiceCard
            isDark={isDark}
            icon="layers"
            title="Multiple Products"
            description="Create multiple products from a single natural-language prompt."
            buttonLabel="Create Multiple Products"
            accent="#3AABFF"
            onClick={onChooseMultiple}
          />
        </div>
      </div>
    </PageShell>
  );
}

function ChoiceCard({ isDark, icon, title, description, buttonLabel, accent, onClick }: {
  isDark: boolean; icon: string; title: string; description: string; buttonLabel: string; accent: string; onClick: () => void;
}) {
  const t = tokens(isDark);
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, textAlign: "left",
        padding: 20, borderRadius: 16, border: `1px solid ${t.border}`, background: t.surface, cursor: "pointer",
        transition: "border-color .15s ease",
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = `${accent}60`)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = t.border)}
    >
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center"
        style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}30` }}
      >
        <Ic n={icon} s={20} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: t.heading }}>{title}</div>
      <p style={{ fontSize: 12, color: t.dim, lineHeight: 1.5, flex: 1 }}>{description}</p>
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10,
          fontSize: 12.5, fontWeight: 700, color: "#04101F", background: `linear-gradient(135deg, ${accent}, ${t.accentBlue})`,
        }}
      >
        {buttonLabel} <Ic n="arrow-right" s={13} />
      </span>
    </button>
  );
}
