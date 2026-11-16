"use client";

import { createContext, useContext, useId, useLayoutEffect, useState } from "react";
import { Ic, tokens } from "@/components/data/quotes/shared";
import { getModuleGuide } from "@/lib/help/moduleGuides";

/**
 * The module currently shown (set by the /data page) and a way for a module header to say "I show the link" — while one does,
 * the page doesn't render the top-of-page fallback, so the link appears exactly once.
 */
export const ModuleIntroContext = createContext<{ guideKey: string | null; registerInline: () => () => void } | null>(null);

/**
 * "Learn about this module" for a module header (ObjectWorkspace): rendered directly under the module title and its badge.
 * Renders nothing outside the /data page or for a module without a guide.
 */
export function ModuleIntroInline({ isDark }: { isDark: boolean }) {
  const ctx = useContext(ModuleIntroContext);
  const guideKey = ctx?.guideKey ?? null;
  const show = !!ctx && !!getModuleGuide(guideKey);
  const register = ctx?.registerInline;
  // Layout effect: the page hides its fallback before the browser paints, so the link never shows twice.
  useLayoutEffect(() => (show && register ? register() : undefined), [show, register]);
  if (!show) return null;
  return <ModuleIntro key={guideKey} isDark={isDark} guideKey={guideKey} variant="inline" />;
}

/**
 * "Learn about this module" — a small link with a dropdown icon; the module's beginner introduction (content:
 * lib/help/moduleGuides.ts — why, where, how, prerequisites, what it connects to, key terms) opens only when it is clicked.
 * Static content: no Salesforce call, no AI key.
 */
export default function ModuleIntro({ isDark, guideKey, variant = "bar" }: { isDark: boolean; guideKey: string | null; variant?: "inline" | "bar" }) {
  const guide = getModuleGuide(guideKey);
  const t = tokens(isDark);
  const regionId = useId();
  const [open, setOpen] = useState(false);

  if (!guide || !guideKey) return null;

  const toggle = () => setOpen(v => !v);

  const sections: { title: string; icon: string; items: string[] }[] = [
    { title: "Why it's used", icon: "info", items: [guide.why] },
    { title: "Where it's used in Revenue Cloud", icon: "layers", items: [guide.where] },
    { title: "How it works", icon: "zap", items: guide.how },
    { title: "Before you start", icon: "check-circle", items: guide.prerequisites },
    { title: "Configure next", icon: "arrow-right", items: guide.next },
    { title: "Connects to", icon: "link", items: guide.connects },
  ].filter(s => s.items.some(i => i && i !== "—"));

  // inline: under a module header's title + badge (ObjectWorkspace). bar: the same link at the top of screens without that header.
  const wrapper = variant === "inline"
    ? { className: "mt-1", style: {} as React.CSSProperties }
    : { className: "shrink-0 px-4 sm:px-5 pt-2 pb-2", style: { borderBottom: `1px solid ${t.border}` } as React.CSSProperties };
  return (
    <div className={wrapper.className} style={wrapper.style}>
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls={regionId} title={guide.summary}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: 0, background: "none", border: "none", cursor: "pointer", color: t.accent, fontSize: 12, fontWeight: 700 }}>
        <Ic n="info" s={13} />
        {open ? "Hide module details" : "Learn about this module"}
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}><Ic n="chevron-down" s={12} /></span>
      </button>

      <div style={{ marginTop: open ? 8 : 0, borderRadius: 12, border: open ? `1px solid ${t.border}` : "none", background: t.surface, overflow: "hidden" }}>
        <div id={regionId} role="region" aria-label={`About ${guide.title}`} hidden={!open}
          style={{ padding: "10px 14px 12px", maxHeight: "42vh", overflowY: "auto", scrollbarWidth: "thin" }}>
          <p style={{ fontSize: 12.5, color: t.body, margin: "2px 0 10px", lineHeight: 1.5 }}>{guide.summary}</p>

          {guide.flow && guide.flow.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <SectionLabel t={t}>Implementation sequence</SectionLabel>
              <ol style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
                {guide.flow.map((step, i) => (
                  <li key={step} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: t.body, padding: "3px 9px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                    <span style={{ fontWeight: 800, color: t.accent }}>{i + 1}</span>{step}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="grid gap-x-5 gap-y-3 grid-cols-1 md:grid-cols-2">
            {sections.map(s => (
              <div key={s.title}>
                <SectionLabel t={t} icon={s.icon}>{s.title}</SectionLabel>
                {s.items.length === 1 ? (
                  <p style={{ fontSize: 12, color: t.body, margin: 0, lineHeight: 1.5 }}>{s.items[0]}</p>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                    {s.items.map((item, i) => (
                      <li key={i} style={{ display: "flex", gap: 7, fontSize: 12, color: t.body, lineHeight: 1.5 }}>
                        <span style={{ flexShrink: 0, marginTop: 7, width: 4, height: 4, borderRadius: "50%", background: t.accent }} />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          {guide.concepts && guide.concepts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <SectionLabel t={t} icon="book-open">Key terms</SectionLabel>
              <dl className="grid gap-x-5 gap-y-1.5 grid-cols-1 md:grid-cols-2" style={{ margin: 0 }}>
                {guide.concepts.map(c => (
                  <div key={c.term} style={{ fontSize: 12, lineHeight: 1.45 }}>
                    <dt style={{ display: "inline", fontWeight: 700, color: t.heading }}>{c.term}: </dt>
                    <dd style={{ display: "inline", margin: 0, color: t.body }}>{c.meaning}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ t, icon, children }: { t: ReturnType<typeof tokens>; icon?: string; children: React.ReactNode }) {
  return (
    <p style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 4px" }}>
      {icon && <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={icon} s={11} /></span>}{children}
    </p>
  );
}
