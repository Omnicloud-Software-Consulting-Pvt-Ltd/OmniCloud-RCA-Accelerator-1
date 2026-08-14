"use client";

import { Ic, tokens, Section, PrimaryButton, GhostButton, Pill, Spinner, inputStyle } from "./shared";
import { PRICING_TYPE_LABELS, type AIConfidence, type PricingType } from "@/lib/pricing-rules/types";
import AiAttributeMatchSummary, { type AiMatchSummary, type AiMatchDiagnostic } from "./AiAttributeMatchSummary";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";

export interface AIExtractedSummary {
  procedureName?: string;
  productName?: string;
  pricingType?: PricingType | "";
  description?: string;
  basePrice?: string;
  attributeEntryCount?: number;
}

const CONFIDENCE_COLOR: Record<AIConfidence, string> = {
  high: "#22C55E",
  medium: "#F59E0B",
  low: "#FF4066",
};

/**
 * "AI Pricing Assistant" — the primary entry point for Attribute-Based
 * Pricing: describe the procedure in plain English, Generate populates
 * the form below (Procedure Details, Product Information, Attribute
 * Pricing table), and the user reviews/edits everything before Create
 * Procedure. Generate never creates anything by itself. Styling mirrors
 * the "Describe this quote (AI)" section in CreateQuoteFlow.tsx (same
 * Section/PrimaryButton/Spinner primitives) so it matches the rest of
 * Data Omnion's AI-assisted modules.
 */
export default function AIPricingAssistant({
  isDark,
  prompt,
  onPromptChange,
  generating,
  error,
  confidence,
  summary,
  validationMessages,
  matchSummary,
  matchDiagnostics,
  onGenerate,
  onClear,
}: {
  isDark: boolean;
  prompt: string;
  onPromptChange: (value: string) => void;
  generating: boolean;
  error: string | null;
  confidence: AIConfidence | null;
  summary: AIExtractedSummary | null;
  validationMessages: string[];
  /** Populated once AI-extracted entries have been matched against the Salesforce-discovered attribute values (after Generate's attribute-discovery cascade completes) — §AI Prompt Integration matching diagnostics. */
  matchSummary?: AiMatchSummary | null;
  matchDiagnostics?: AiMatchDiagnostic[];
  onGenerate: () => void;
  onClear: () => void;
}) {
  const t = tokens(isDark);

  return (
    <Section title="AI Pricing Assistant" icon="sparkles" isDark={isDark} defaultOpen>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}>
        <textarea
          value={prompt}
          onChange={e => onPromptChange(e.target.value)}
          placeholder='e.g. "Create attribute-based pricing for Widget Pro — base price $999, 10% off Display=1080p, $50 off Storage=256GB"'
          rows={3}
          disabled={generating}
          style={{ ...inputStyle(t), resize: "vertical" as const }}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <PrimaryButton
            label={generating ? "Generating…" : "Generate"}
            icon="sparkles"
            isDark={isDark}
            disabled={generating || !prompt.trim()}
            onClick={onGenerate}
            title="Populates the form below — does not create the procedure."
          />
          <GhostButton label="Clear" icon="x" isDark={isDark} disabled={generating || (!prompt.trim() && !summary && !error)} onClick={onClear} />

          {generating && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim }}>
              <Spinner isDark={isDark} size={12} /> Parsing with Claude…
            </span>
          )}
          {!generating && confidence && (
            <Pill label={`${confidence} confidence`} color={CONFIDENCE_COLOR[confidence]} isDark={isDark} />
          )}
        </div>

        <PromptGuide isDark={isDark} config={promptGuideConfig.pricingRule} onUseExample={onPromptChange} />

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.error }}>
            <Ic n="alert" s={13} /> {error}
          </div>
        )}

        {summary && !generating && (
          <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 12, background: t.surfaceAlt, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Extracted</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12, color: t.body }}>
              {summary.procedureName && <div><strong style={{ color: t.heading }}>Procedure:</strong> {summary.procedureName}</div>}
              {summary.productName && <div><strong style={{ color: t.heading }}>Product:</strong> {summary.productName}</div>}
              {summary.pricingType && <div><strong style={{ color: t.heading }}>Type:</strong> {PRICING_TYPE_LABELS[summary.pricingType]}</div>}
              {summary.basePrice && <div><strong style={{ color: t.heading }}>Base Price:</strong> ${summary.basePrice}</div>}
              {summary.description && <div style={{ gridColumn: "1 / -1" }}><strong style={{ color: t.heading }}>Description:</strong> {summary.description}</div>}
              {!!summary.attributeEntryCount && (
                <div style={{ gridColumn: "1 / -1" }}><strong style={{ color: t.heading }}>Attribute Entries:</strong> {summary.attributeEntryCount} found</div>
              )}
            </div>
          </div>
        )}

        {validationMessages.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {validationMessages.map((m, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11.5, color: t.warn }}>
                <Ic n="alert" s={12} /> <span>{m}</span>
              </div>
            ))}
          </div>
        )}

        {matchSummary && !generating && (
          <AiAttributeMatchSummary isDark={isDark} summary={matchSummary} diagnostics={matchDiagnostics ?? []} />
        )}
      </div>
    </Section>
  );
}
