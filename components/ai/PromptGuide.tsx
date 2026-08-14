"use client";

import { useState } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";
import type { PromptGuideConfig, PromptGuideField } from "@/lib/ai/promptGuideConfig";

type Tab = "overview" | "required" | "optional" | "example";

/**
 * Shared "what can I say here?" help panel for every AI-driven Create
 * prompt (Product, Multi-Product, Attribute, Bundle, Quote, Order,
 * Contract, Pricing Rule). One component, configured per module via
 * `lib/ai/promptGuideConfig.ts` — never a one-off hardcoded block per page.
 * Purely informational: it never touches the prompt textarea's own state
 * except through the optional `onUseExample` callback the caller wires to
 * its own `setPrompt`.
 */
export default function PromptGuide({
  isDark, config, onUseExample, defaultOpen = false,
}: {
  isDark: boolean;
  config: PromptGuideConfig;
  onUseExample?: (prompt: string) => void;
  defaultOpen?: boolean;
}) {
  const t = tokens(isDark);
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "required", label: `Required (${config.requiredFields.length})` },
    { id: "optional", label: `Optional (${config.optionalFields.length})` },
    { id: "example", label: "Example" },
  ];

  return (
    <div style={{ borderRadius: 14, border: `1px solid ${t.border}`, background: t.surface, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: `${t.accent}18`, border: `1px solid ${t.accent}30`, color: t.accent, flexShrink: 0 }}>
          <Ic n="info" s={14} />
        </div>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: t.heading, letterSpacing: "-0.01em", flex: 1 }}>{open ? config.title : "Prompt Guide — what can I say here?"}</span>
        <span style={{ color: t.dim, flexShrink: 0 }}><Ic n={open ? "chevron-down" : "chevron-right"} s={14} /></span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 14px" }}>
          <div className="flex items-center gap-1 flex-wrap" style={{ marginBottom: 10 }}>
            {tabs.map(tb => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                style={{
                  fontSize: 11, fontWeight: 700, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${tab === tb.id ? t.accent : t.border}`,
                  color: tab === tb.id ? t.accent : t.dim, background: tab === tb.id ? `${t.accent}14` : "transparent",
                }}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ fontSize: 12, color: t.body, margin: 0 }}>{config.whatItCreates}</p>
              <FieldList heading="What can I describe?" items={config.capabilities} t={t} />
              <FieldList heading="How this is interpreted" items={config.interpretationNotes} t={t} />
              {config.notes && config.notes.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {config.notes.map((n, i) => (
                    <div key={i} className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.warn }}>
                      <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="alert" s={12} /></span>
                      <span>{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "required" && <FieldTable fields={config.requiredFields} tone="required" t={t} />}
          {tab === "optional" && <FieldTable fields={config.optionalFields} tone="optional" t={t} />}

          {tab === "example" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <ExampleBlock example={config.example} isDark={isDark} t={t} onUseExample={onUseExample} />
              {config.multipleExample && (
                <ExampleBlock example={config.multipleExample} isDark={isDark} t={t} onUseExample={onUseExample} />
              )}
              {config.multipleNote && (
                <div className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.accentBlue }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="info" s={12} /></span>
                  <span>{config.multipleNote}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex items-start gap-2" style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.border}`, fontSize: 11, color: t.dim }}>
            <span style={{ flexShrink: 0, marginTop: 1, color: t.accent }}><Ic n="check-circle" s={12} /></span>
            <span>{config.reviewNote}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldList({ heading, items, t }: { heading: string; items: string[]; t: ReturnType<typeof tokens> }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 5 }}>{heading}</p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.accent }} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FieldTable({ fields, tone, t }: { fields: PromptGuideField[]; tone: "required" | "optional"; t: ReturnType<typeof tokens> }) {
  const color = tone === "required" ? "#22C55E" : t.accentBlue;
  if (fields.length === 0) {
    return <p style={{ fontSize: 12, color: t.dim, padding: "8px 2px" }}>No {tone} fields for this workflow.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {fields.map((f, i) => (
        <div key={i} className="flex items-start gap-2">
          <span style={{ flexShrink: 0, marginTop: 2, color }}><Ic n={tone === "required" ? "check" : "circle-dot"} s={12} /></span>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{f.label}</div>
            {f.hint && <div style={{ fontSize: 11.5, color: t.dim, marginTop: 1 }}>{f.hint}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ExampleBlock({ example, isDark, t, onUseExample }: {
  example: { label?: string; prompt: string };
  isDark: boolean;
  t: ReturnType<typeof tokens>;
  onUseExample?: (prompt: string) => void;
}) {
  return (
    <div>
      {example.label && <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, marginBottom: 5 }}>{example.label}</p>}
      <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px" }}>
        <p style={{ fontSize: 12, color: t.body, margin: 0, whiteSpace: "pre-wrap", fontStyle: "italic" }}>&ldquo;{example.prompt}&rdquo;</p>
        {onUseExample && (
          <button
            onClick={() => onUseExample(example.prompt)}
            style={{
              marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700,
              padding: "5px 11px", borderRadius: 8, color: isDark ? "#04101F" : "#04101F", border: "none", cursor: "pointer",
              background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
            }}
          >
            <Ic n="edit" s={11} /> Use This Example
          </button>
        )}
      </div>
    </div>
  );
}
