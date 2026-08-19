"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Ic, tokens, Section, Pill, PrimaryButton, GhostButton, EmptyState, Spinner, formatCurrency } from "./shared";
import AttributeMappingConfigurator, { type AttributeMappingOverridesPayload } from "./AttributeMappingConfigurator";
import { ExecutionLogPanel, ApiJsonDetailsPanel } from "./CreationAuditPanels";
import { loadSession } from "@/lib/auth/session";
import { buildAttributePricingSalesforceRecords, type SalesforceRecordLink } from "@/lib/pricing-rules/attribute-based/create/salesforceRecordLinks";
import type {
  AttributeBasedAnalysisResult,
  AttributeBasedMappingOverrides,
  DiscoveredAttribute,
  DiscoveredProduct,
  ExtractedPricingRequirement,
  PricingRulePlanRow,
  ProcedureStepLite,
  ProductCandidate,
} from "@/lib/pricing-rules/attribute-based/types";
import type { CreateAttributePricingResult, CreateStreamEvent } from "@/lib/pricing-rules/attribute-based/create/types";
import type { MissingAttributeConfigInfo } from "@/lib/pricing-rules/attribute-based/create/nativeRecords";

/**
 * §Attribute-Based Pricing — Steps 1-3 (AI prompt, extraction, Salesforce
 * validation, rule preview) plus Parts A-T (attribute/value mapping with
 * Ignore/Create, the Part F confirmation screen, and the Part G-Q
 * Salesforce-write creation pipeline with live Part T progress).
 *
 * Salesforce is always the source of truth; the AI only ever interprets
 * intent and never invents a product/attribute/value. Nothing is written to
 * Salesforce until the user explicitly clicks "Create in Salesforce" on the
 * confirmation screen — every step before that is read-only analysis.
 */

const PIPELINE_STEPS = [
  "Prompt",
  "Identify Product",
  "Verify Product exists in Salesforce",
  "Discover Product Attributes",
  "Validate Prompt Attributes",
  "Validate Attribute Values",
  "Build Pricing Rules",
];

const REQUIRED_GROUPS: { heading: string; points: string[] }[] = [
  {
    heading: "Product",
    points: [
      "Product Name is the most important input.",
      "Provide the product name exactly as it exists in Salesforce.",
      "A Salesforce Product ID is NOT required.",
    ],
  },
  {
    heading: "Pricing Requirement",
    points: [
      "Describe that you want attribute-based pricing.",
      "Explain how attribute values should affect the price.",
    ],
  },
];

const RECOMMENDED_GROUPS: { heading: string; points: string[] }[] = [
  {
    heading: "Attributes",
    points: [
      "Attribute names such as RAM, Storage, Processor, Color, Warranty, etc.",
      "If you don't provide attributes, the system will later discover the attributes associated with the product from Salesforce.",
    ],
  },
  {
    heading: "Attribute Values",
    points: [
      "Values such as 8GB, 16GB, 32GB, 512GB, 1TB, i5, i7, etc.",
      "You can provide the specific values you want to use for pricing.",
    ],
  },
  {
    heading: "Pricing Adjustments",
    points: [
      "Fixed amount adjustment",
      "Percentage adjustment",
      "Increase / decrease",
      "Different adjustments for different attribute values",
    ],
  },
];

const OPTIONAL_ITEMS = [
  "Base price",
  "Multiple attributes",
  "Multiple attribute values",
  "Attribute combinations",
  "Minimum/maximum conditions, if supported",
  "Pricing rule description",
  "Currency",
  "Effective dates, if supported by the existing application",
];

const EXAMPLE_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Example 1 — Basic attribute pricing",
    prompt: "Create an attribute-based pricing procedure for Laptop Pro 15. Base price is $1,200. Add $150 for 16GB RAM and $300 for 32GB RAM.",
  },
  {
    label: "Example 2 — Multiple attributes",
    prompt: "Create attribute-based pricing for Laptop Pro 15. Use RAM, Storage, and Processor as pricing attributes. Add $150 for 16GB RAM, $300 for 32GB RAM, $100 for 512GB storage, $200 for 1TB storage, and $250 for Intel Core i7.",
  },
  {
    label: "Example 3 — Percentage adjustment",
    prompt: "Create an attribute-based pricing procedure for Office Monitor 27. Increase the price by 10% when the Display Type is OLED and by 5% when the Display Type is 4K.",
  },
  {
    label: "Example 4 — Multiple attribute values",
    prompt: "Create attribute-based pricing for Business Laptop. RAM values should be 8GB, 16GB, and 32GB. Apply no adjustment to 8GB, $150 to 16GB, and $300 to 32GB.",
  },
  {
    label: "Example 5 — Product only (auto-discover attributes)",
    prompt: "Create an attribute-based pricing procedure for Laptop Pro 15 using the attributes available for this product.",
  },
];

const PROMPT_PLACEHOLDER =
  "Example: Create an attribute-based pricing procedure for Laptop Pro 15. Use RAM, Storage, and Processor as pricing attributes. Add $150 for 16GB RAM, $300 for 32GB RAM, $100 for 512GB storage, $200 for 1TB storage, and $250 for Intel Core i7.";

function textareaStyle(t: ReturnType<typeof tokens>): CSSProperties {
  return {
    width: "100%", minHeight: 150, padding: "12px 14px", borderRadius: 12, fontSize: 13.5, lineHeight: 1.55,
    background: t.inputBg, border: `1px solid ${t.inputBorder}`, color: t.heading, outline: "none",
    resize: "vertical" as const, fontFamily: "inherit",
  };
}

function formatAdjustment(type: "fixed" | "percentage" | "override", amount: number): string {
  if (type === "percentage") return amount === 0 ? "0%" : `${amount > 0 ? "+" : ""}${amount}%`;
  if (type === "override") return formatCurrency(amount);
  if (amount === 0) return "$0";
  return amount > 0 ? `+${formatCurrency(amount)}` : formatCurrency(amount);
}

async function postAnalyze(body: unknown): Promise<{ ok: true; result: AttributeBasedAnalysisResult } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/pricing-rules/attribute-based/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json?.stage) {
      return { ok: false, error: json?.error ?? `Request failed (HTTP ${res.status})` };
    }
    return { ok: true, result: json as AttributeBasedAnalysisResult };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error — could not reach the server." };
  }
}

/** NDJSON reader for the Salesforce-write create endpoint — one JSON object per line, ending with exactly one terminal "result" line. A connection that ends without one is treated as a failure, never a silent success (Part R). */
async function postCreateStream(
  body: unknown,
  onStep: (event: { step: string; status: string; detail?: string }) => void,
): Promise<CreateAttributePricingResult> {
  const res = await fetch("/api/pricing-rules/attribute-based/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error("The server returned a streaming response with no body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: CreateAttributePricingResult | null = null;

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = JSON.parse(trimmed) as CreateStreamEvent;
    if (event.type === "step") onStep({ step: event.step, status: event.status, detail: event.detail });
    else finalResult = event.result;
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!finalResult) throw new Error("The streaming response ended without a final result.");
  return finalResult;
}

/* ═══════════════════════ Part T — the full conceptual step list, mapped onto real backend steps ═══════════════════════
 * "Create Pricing Element" / "Create Expression Set" / "Bind Inputs" all complete together as ONE
 * build-expression-set operation, and "Create Expression Set Version" / "Create Pricing Procedure"
 * both complete together as ONE Metadata API deploy — this reflects how Salesforce's Metadata API
 * actually works for Expression Sets (one deploy call creates the Definition/Version/steps
 * atomically), never fabricated as separate round-trips that don't exist. */
const PART_T_STEPS: { label: string; analyzeSteps?: string[]; createSteps?: string[] }[] = [
  { label: "Analyze Prompt", analyzeSteps: ["parse-prompt"] },
  { label: "Product Found", analyzeSteps: ["verify-product"] },
  { label: "Existing Attributes & Values", analyzeSteps: ["discover-attributes"] },
  { label: "Validate / Map Attributes", analyzeSteps: ["validate-attributes"] },
  { label: "Validate / Map Values", analyzeSteps: ["validate-values"] },
  { label: "Review Pricing Rules", analyzeSteps: ["generate-rules"] },
  { label: "Confirm Salesforce Creation" },
  { label: "Pre-Flight Validation (Schema + Expression Set Donor)", createSteps: ["preflight"] },
  { label: "Configure Price-Impacting Attributes", createSteps: ["configure-price-impacting"] },
  { label: "Create Attribute Values", createSteps: ["create-values"] },
  { label: "Resolve Attribute-Based Pricing Schema", createSteps: ["create-schema"] },
  { label: "Create / Reuse Price Adjustment Schedule", createSteps: ["create-schedule"] },
  { label: "Create / Reuse Attribute-Based Adjustment Rules", createSteps: ["create-rule"] },
  { label: "Create / Reuse Attribute Adjustment Conditions", createSteps: ["create-condition"] },
  { label: "Create / Reuse Attribute-Based Adjustment", createSteps: ["create-adjustment"] },
  { label: "Verify Adjustment Records", createSteps: ["verify-adjustment-records"] },
  { label: "Refresh / Resolve Attribute Discount Entries", createSteps: ["refresh-attribute-discount-entries"] },
  { label: "Create Pricing Element", createSteps: ["build-expression-set"] },
  { label: "Create Expression Set", createSteps: ["build-expression-set"] },
  { label: "Bind Inputs", createSteps: ["build-expression-set"] },
  { label: "Create Expression Set Version", createSteps: ["deploy-pricing-procedure"] },
  { label: "Create Pricing Procedure", createSteps: ["deploy-pricing-procedure"] },
  { label: "Activate", createSteps: ["activate-version"] },
  { label: "Verify Salesforce", createSteps: ["verify-salesforce"] },
];

type RowStatus = "not-started" | "in-progress" | "completed" | "warning" | "failed";

function statusFromAnalyze(steps: ProcedureStepLite[], names: string[]): RowStatus {
  const relevant = steps.filter(s => names.includes(s.step));
  if (relevant.length === 0) return "not-started";
  const last = relevant[relevant.length - 1];
  if (last.status === "error") return "failed";
  return "completed";
}

function statusFromCreate(events: { step: string; status: string }[], names: string[]): RowStatus {
  const relevant = events.filter(e => names.includes(e.step));
  if (relevant.length === 0) return "not-started";
  const last = relevant[relevant.length - 1];
  if (last.status === "failed") return "failed";
  if (last.status === "done") return "completed";
  if (last.status === "warning") return "warning";
  return "in-progress";
}

const STATUS_GLYPH: Record<RowStatus, string> = { completed: "✓", "in-progress": "⏳", warning: "⚠", failed: "✕", "not-started": "○" };

export default function AttributeBasedPricingCreate({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AttributeBasedAnalysisResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<AttributeBasedMappingOverrides>({});

  const [creating, setCreating] = useState(false);
  const [createEvents, setCreateEvents] = useState<{ step: string; status: string; detail?: string }[]>([]);
  const [createResult, setCreateResult] = useState<CreateAttributePricingResult | null>(null);
  const [createRequestError, setCreateRequestError] = useState<string | null>(null);

  function resetAnalysis() {
    setResult(null);
    setRequestError(null);
    setMappings({});
    setCreating(false);
    setCreateEvents([]);
    setCreateResult(null);
    setCreateRequestError(null);
  }

  function handleUseExample(example: string) {
    setPrompt(example);
    resetAnalysis();
  }

  function handleClear() {
    setPrompt("");
    resetAnalysis();
  }

  async function runAnalysis(body: { prompt?: string; extracted?: ExtractedPricingRequirement; selectedProductId?: string; overrides?: AttributeBasedMappingOverrides }) {
    setLoading(true);
    setRequestError(null);
    setCreating(false);
    setCreateEvents([]);
    setCreateResult(null);
    setCreateRequestError(null);
    const res = await postAnalyze(body);
    setLoading(false);
    if (res.ok) setResult(res.result);
    else setRequestError(res.error);
  }

  function handleCreate() {
    if (!prompt.trim()) return;
    setMappings({});
    void runAnalysis({ prompt });
  }

  function handleSelectProduct(candidate: ProductCandidate, extracted: ExtractedPricingRequirement) {
    void runAnalysis({ extracted, selectedProductId: candidate.id, overrides: mappings });
  }

  function handleAcceptAttributeMapping(enteredName: string, mappedName: string, extracted: ExtractedPricingRequirement) {
    const next: AttributeBasedMappingOverrides = { ...mappings, attributeNameMappings: { ...mappings.attributeNameMappings, [enteredName]: mappedName } };
    setMappings(next);
    void runAnalysis({ extracted, overrides: next });
  }

  function handleIgnoreAttribute(enteredName: string, extracted: ExtractedPricingRequirement) {
    const next: AttributeBasedMappingOverrides = { ...mappings, ignoredAttributes: [...(mappings.ignoredAttributes ?? []), enteredName] };
    setMappings(next);
    void runAnalysis({ extracted, overrides: next });
  }

  /** Part 6 — "Next" on the Attribute Mapping & Pricing Configuration screen: batches every dropdown
   * selection and adjustment type/value the user configured into one overrides submission (still a
   * read-only re-validation call, never a Salesforce write) instead of resubmitting per click. */
  function handleSubmitMapping(overrides: AttributeMappingOverridesPayload, extracted: ExtractedPricingRequirement) {
    const next: AttributeBasedMappingOverrides = {
      ...mappings,
      attributeValueMappings: { ...mappings.attributeValueMappings, ...overrides.attributeValueMappings },
      valuesToCreate: [...new Set([...(mappings.valuesToCreate ?? []), ...overrides.valuesToCreate])],
      adjustmentOverrides: { ...mappings.adjustmentOverrides, ...overrides.adjustmentOverrides },
    };
    setMappings(next);
    void runAnalysis({ extracted, overrides: next });
  }

  async function handleConfirmCreate(product: DiscoveredProduct, discoveredAttributes: DiscoveredAttribute[], rules: PricingRulePlanRow[], excludedAttributes: string[]) {
    setCreating(true);
    setCreateRequestError(null);
    setCreateEvents([]);
    setCreateResult(null);
    try {
      const procedureName = `${product.name} Attribute-Based Pricing Procedure`;
      const res = await postCreateStream(
        { product, discoveredAttributes, rules, excludedAttributes, procedureName, activate: true },
        event => setCreateEvents(prev => [...prev, event]),
      );
      setCreateResult(res);
    } catch (err) {
      setCreateRequestError(err instanceof Error ? err.message : "Network error — could not reach the server.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="sliders" s={18} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, color: t.heading }}>Attribute-Based Pricing</span>
        </div>
        <p style={{ fontSize: 12.5, color: t.dim, marginTop: 6, maxWidth: 760 }}>
          Describe the product and the pricing logic you need in plain English. The system will identify the product,
          resolve its attributes and attribute values, and validate everything against Salesforce before any pricing
          procedure is built — you never need to know the underlying record Ids.
        </p>
      </div>

      {/* ── Prompt card ── */}
      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.heading }}>Create Attribute-Based Pricing Procedure</div>
          <p style={{ fontSize: 12, color: t.dim, marginTop: 4, marginBottom: 0 }}>
            Describe the product and attribute-based pricing rules you want to create. The system will identify the
            product and its available attributes and validate the information against Salesforce.
          </p>
        </div>

        <textarea
          value={prompt}
          onChange={e => { setPrompt(e.target.value); resetAnalysis(); }}
          placeholder={PROMPT_PLACEHOLDER}
          style={textareaStyle(t)}
        />

        {/* ── Prompt Guide ── */}
        <Section title="Prompt Guide" icon="info" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: t.dim }}>How this works:</div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {PIPELINE_STEPS.map((step, i) => (
                  <div key={step} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 999,
                      border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.body,
                    }}>
                      {step}
                    </span>
                    {i < PIPELINE_STEPS.length - 1 && <span style={{ color: t.dim }}><Ic n="arrow-right" s={12} /></span>}
                  </div>
                ))}
              </div>
            </div>

            <GuideTier tone="required" label="Required" color="#22C55E" isDark={isDark}>
              {REQUIRED_GROUPS.map(g => <GuideGroup key={g.heading} heading={g.heading} points={g.points} t={t} />)}
              <GuideNote t={t} color="#22C55E">
                The product is the primary reference. The system will first verify that the product exists in
                Salesforce before resolving its attributes and attribute values.
              </GuideNote>
            </GuideTier>

            <GuideTier tone="recommended" label="Recommended" color={t.accentBlue} isDark={isDark}>
              {RECOMMENDED_GROUPS.map(g => <GuideGroup key={g.heading} heading={g.heading} points={g.points} t={t} />)}
            </GuideTier>

            <GuideTier tone="optional" label="Optional" color="#94A3B8" isDark={isDark}>
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 5 }}>
                {OPTIONAL_ITEMS.map(item => (
                  <li key={item} className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
                    <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.dim }} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </GuideTier>
          </div>
        </Section>

        {/* ── Important guidance ── */}
        <div style={{ borderRadius: 12, border: `1px solid ${t.accent}40`, background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,212,255,0.05)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 1, color: t.accent }}><Ic n="info" s={13} /></span>
            <span>
              <strong style={{ color: t.heading }}>You do not need to provide Salesforce IDs.</strong> Use names for
              products, attributes, and attribute values. The system will resolve and validate the corresponding
              Salesforce records automatically.
            </span>
          </div>
          <div className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 1, color: t.accent }}><Ic n="info" s={13} /></span>
            <span>
              <strong style={{ color: t.heading }}>The Product is required</strong> because the system will use it to
              determine which attributes and attribute values are valid.
            </span>
          </div>
        </div>

        {/* ── Example Prompts ── */}
        <Section title="Example Prompts" icon="list" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
            {EXAMPLE_PROMPTS.map(ex => (
              <div key={ex.label} style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px" }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 5px" }}>{ex.label}</p>
                <p style={{ fontSize: 12, color: t.body, margin: 0, fontStyle: "italic" }}>&ldquo;{ex.prompt}&rdquo;</p>
                <div style={{ marginTop: 8 }}>
                  <GhostButton label="Use This Example" icon="sparkles" isDark={isDark} onClick={() => handleUseExample(ex.prompt)} />
                </div>
              </div>
            ))}
            <div className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.dim }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="info" s={12} /></span>
              <span>Example 5 provides only a product on purpose — it demonstrates that the system will eventually discover that product&apos;s attributes automatically from Salesforce, without you listing any.</span>
            </div>
          </div>
        </Section>

        {/* ── Actions ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 2 }}>
          <PrimaryButton
            label={loading ? "Analyzing…" : "Create Pricing Procedure"}
            icon="zap"
            isDark={isDark}
            disabled={!prompt.trim() || loading}
            onClick={handleCreate}
          />
          <GhostButton label="Clear" icon="x" isDark={isDark} disabled={!prompt || loading} onClick={handleClear} />
        </div>
      </div>

      {/* ── Analysis result area ── */}
      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, minHeight: 140 }}>
        <AnalysisResultArea
          isDark={isDark}
          loading={loading}
          result={result}
          requestError={requestError}
          creating={creating}
          createEvents={createEvents}
          createResult={createResult}
          createRequestError={createRequestError}
          onSelectProduct={handleSelectProduct}
          onAcceptAttributeMapping={handleAcceptAttributeMapping}
          onIgnoreAttribute={handleIgnoreAttribute}
          onSubmitMapping={handleSubmitMapping}
          onConfirmCreate={handleConfirmCreate}
        />
      </div>
    </div>
  );
}

function GuideTier({ label, color, isDark, children }: { tone: "required" | "recommended" | "optional"; label: string; color: string; isDark: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Pill label={label} color={color} isDark={isDark} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function GuideGroup({ heading, points, t }: { heading: string; points: string[]; t: ReturnType<typeof tokens> }) {
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: t.heading, marginBottom: 4 }}>{heading}</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {points.map((p, i) => (
          <li key={i} className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.accent }} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GuideNote({ children, t, color }: { children: ReactNode; t: ReturnType<typeof tokens>; color: string }) {
  return (
    <div className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.body, background: t.surfaceAlt, border: `1px solid ${t.border}`, borderRadius: 10, padding: "8px 10px" }}>
      <span style={{ flexShrink: 0, marginTop: 1, color }}><Ic n="check-circle" s={12} /></span>
      <span>{children}</span>
    </div>
  );
}

/* ═══════════════════════ Analysis result rendering (Step 11 / Parts A-Q) ═══════════════════════ */

function collapseSteps(steps: ProcedureStepLite[]): ProcedureStepLite[] {
  const order: string[] = [];
  const byStep = new Map<string, ProcedureStepLite>();
  for (const s of steps) {
    if (!byStep.has(s.step)) order.push(s.step);
    byStep.set(s.step, s); // last write wins — final status for that step
  }
  return order.map(step => byStep.get(step)!);
}

function StepChecklist({ isDark, steps }: { isDark: boolean; steps: ProcedureStepLite[] }) {
  const t = tokens(isDark);
  const collapsed = collapseSteps(steps);
  if (collapsed.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "14px 16px", borderBottom: `1px solid ${t.border}` }}>
      {collapsed.map(s => {
        const color = s.status === "success" ? "#22C55E" : s.status === "error" ? t.warn : t.dim;
        const icon = s.status === "success" ? "check" : s.status === "error" ? "alert" : "info";
        return (
          <div key={s.step} className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 1, color }}><Ic n={icon} s={13} /></span>
            <span>{s.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Part A — always shown alongside a mismatch/preview: the actual attributes+values discovered from Salesforce, never just the missing ones. */
function ExistingAttributesTable({ isDark, attributes }: { isDark: boolean; attributes: DiscoveredAttribute[] }) {
  const t = tokens(isDark);
  return (
    <div>
      <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: "0 0 8px" }}>Existing Product Attributes</p>
      <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${t.border}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: t.surfaceAlt }}>
              <th style={{ textAlign: "left", padding: "7px 12px", color: t.dim, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}` }}>Attribute</th>
              <th style={{ textAlign: "left", padding: "7px 12px", color: t.dim, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}` }}>Existing Values</th>
            </tr>
          </thead>
          <tbody>
            {attributes.map((a, i) => (
              <tr key={a.name} style={{ borderBottom: i < attributes.length - 1 ? `1px solid ${t.border}` : undefined }}>
                <td style={{ padding: "7px 12px", color: t.heading, fontWeight: 600, verticalAlign: "top" }}>{a.label}</td>
                <td style={{ padding: "7px 12px", color: t.body }}>{a.values.length > 0 ? a.values.map(v => v.label).join(", ") : "(no values configured)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExcludedAttributesNote({ isDark, excludedAttributes }: { isDark: boolean; excludedAttributes: string[] }) {
  const t = tokens(isDark);
  if (excludedAttributes.length === 0) return null;
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px" }}>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 6px" }}>Excluded from pricing</p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
        {excludedAttributes.map(name => (
          <li key={name} className="flex items-start gap-2" style={{ fontSize: 12, color: t.body }}>
            <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.dim }} />
            <span>{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SuggestionButton({ isDark, label, onClick }: { isDark: boolean; label: string; onClick: () => void }) {
  const t = tokens(isDark);
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700,
        padding: "5px 12px", borderRadius: 8, color: "#04101F", border: "none", cursor: "pointer",
        background: `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})`,
      }}
    >
      <Ic n="check" s={11} /> {label}
    </button>
  );
}

function WarnPanel({ isDark, title, children }: { isDark: boolean; title: string; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="flex items-center gap-2" style={{ color: t.warn, fontWeight: 700, fontSize: 13 }}>
        <Ic n="alert" s={16} /> {title}
      </div>
      {children}
    </div>
  );
}

interface AnalysisCallbacks {
  onSelectProduct: (candidate: ProductCandidate, extracted: ExtractedPricingRequirement) => void;
  onAcceptAttributeMapping: (enteredName: string, mappedName: string, extracted: ExtractedPricingRequirement) => void;
  onIgnoreAttribute: (enteredName: string, extracted: ExtractedPricingRequirement) => void;
  onSubmitMapping: (overrides: AttributeMappingOverridesPayload, extracted: ExtractedPricingRequirement) => void;
  onConfirmCreate: (product: DiscoveredProduct, discoveredAttributes: DiscoveredAttribute[], rules: PricingRulePlanRow[], excludedAttributes: string[]) => void;
}

function AnalysisResultArea({
  isDark, loading, result, requestError, creating, createEvents, createResult, createRequestError, ...callbacks
}: AnalysisCallbacks & {
  isDark: boolean;
  loading: boolean;
  result: AttributeBasedAnalysisResult | null;
  requestError: string | null;
  creating: boolean;
  createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateAttributePricingResult | null;
  createRequestError: string | null;
}) {
  const t = tokens(isDark);

  if (loading) {
    return (
      <div style={{ padding: 32, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <Spinner isDark={isDark} />
        <span style={{ fontSize: 12.5, color: t.body }}>Analyzing pricing requirement…</span>
      </div>
    );
  }

  if (requestError) {
    return (
      <WarnPanel isDark={isDark} title="Something went wrong">
        <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>{requestError}</p>
      </WarnPanel>
    );
  }

  if (!result) {
    return (
      <EmptyState
        isDark={isDark}
        icon="sparkles"
        title="Validation results will appear here"
        hint="Submit a prompt above and this area will show whether the product and its attributes were found in Salesforce."
      />
    );
  }

  return (
    <div>
      <StepChecklist isDark={isDark} steps={result.steps} />
      <ResultStage
        isDark={isDark}
        result={result}
        creating={creating}
        createEvents={createEvents}
        createResult={createResult}
        createRequestError={createRequestError}
        {...callbacks}
      />
    </div>
  );
}

function ResultStage({
  isDark, result, creating, createEvents, createResult, createRequestError,
  onSelectProduct, onAcceptAttributeMapping, onIgnoreAttribute, onSubmitMapping, onConfirmCreate,
}: AnalysisCallbacks & {
  isDark: boolean;
  result: AttributeBasedAnalysisResult;
  creating: boolean;
  createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateAttributePricingResult | null;
  createRequestError: string | null;
}) {
  const t = tokens(isDark);
  /** Part 6 — the preview/mapping screen and the final confirmation screen are two distinct steps;
   * clicking "Next" here only reveals the confirmation panel below, it never touches Salesforce. */
  const [reviewed, setReviewed] = useState(false);

  switch (result.stage) {
    case "ai-parse-failed":
    case "product-missing":
    case "salesforce-error":
      return (
        <WarnPanel isDark={isDark} title={result.stage === "salesforce-error" ? "Salesforce Error" : "Couldn't Understand the Prompt"}>
          <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>{result.error}</p>
        </WarnPanel>
      );

    case "product-not-found":
      return (
        <WarnPanel isDark={isDark} title="Product Not Found">
          <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>
            The product &ldquo;{result.productName}&rdquo; could not be found in the connected Salesforce org.
          </p>
          <p style={{ fontSize: 12.5, color: t.dim, margin: 0 }}>Please verify the product name and try again.</p>
          {result.suggestions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <p style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, margin: 0 }}>Did you mean?</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {result.suggestions.map(c => (
                  <SuggestionButton key={c.id} isDark={isDark} label={c.name} onClick={() => onSelectProduct(c, result.extracted)} />
                ))}
              </div>
            </div>
          )}
        </WarnPanel>
      );

    case "product-ambiguous":
      return (
        <WarnPanel isDark={isDark} title="Multiple Products Matched">
          <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>
            More than one product matched &ldquo;{result.productName}&rdquo;. Which one did you mean?
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {result.matches.map(c => (
              <SuggestionButton key={c.id} isDark={isDark} label={`${c.name}${c.productCode ? ` (${c.productCode})` : ""}`} onClick={() => onSelectProduct(c, result.extracted)} />
            ))}
          </div>
        </WarnPanel>
      );

    case "no-attributes-found":
      return (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="flex items-center gap-2" style={{ color: "#22C55E", fontWeight: 700, fontSize: 13 }}>
            <Ic n="check-circle" s={16} /> Product found
          </div>
          <div style={{ fontSize: 13, color: t.heading, fontWeight: 600 }}>{result.product.name}</div>
          <div className="flex items-center gap-2" style={{ color: t.warn, fontWeight: 700, fontSize: 12.5, marginTop: 6 }}>
            <Ic n="alert" s={14} /> No attributes are configured for this product in Salesforce yet.
          </div>
        </div>
      );

    case "attribute-mismatch":
      return (
        <WarnPanel isDark={isDark} title="Attribute Mismatch">
          <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>
            The following attributes from your prompt are not available for {result.product.name}:
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            {result.mismatch.missingAttributes.map(name => {
              const suggestion = result.mismatch.suggestions.find(s => s.enteredName === name);
              return (
                <li key={name} style={{ fontSize: 12.5, color: t.warn }}>
                  <div className="flex items-start gap-2">
                    <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.warn }} />
                    <span>{name}</span>
                  </div>
                  <div style={{ marginLeft: 12, marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {suggestion?.suggestedName && (
                      <>
                        <span style={{ fontSize: 11.5, color: t.dim }}>Did you mean &ldquo;{suggestion.suggestedName}&rdquo;?</span>
                        <SuggestionButton isDark={isDark} label={`Map to "${suggestion.suggestedName}"`} onClick={() => onAcceptAttributeMapping(name, suggestion.suggestedName!, result.extracted)} />
                      </>
                    )}
                    {!suggestion?.suggestedName && suggestion && suggestion.alternatives.length > 0 && (
                      <>
                        <span style={{ fontSize: 11.5, color: t.dim }}>Multiple possible matches:</span>
                        {suggestion.alternatives.map(alt => (
                          <SuggestionButton key={alt} isDark={isDark} label={alt} onClick={() => onAcceptAttributeMapping(name, alt, result.extracted)} />
                        ))}
                      </>
                    )}
                    <GhostButton label="Ignore" icon="x" isDark={isDark} onClick={() => onIgnoreAttribute(name, result.extracted)} />
                  </div>
                </li>
              );
            })}
          </ul>
          <ExcludedAttributesNote isDark={isDark} excludedAttributes={result.excludedAttributes} />
          <ExistingAttributesTable isDark={isDark} attributes={result.mismatch.availableAttributes} />
        </WarnPanel>
      );

    case "needs-mapping":
      return (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="flex items-center gap-2" style={{ color: "#22C55E", fontWeight: 700, fontSize: 13 }}>
              <Ic n="check-circle" s={16} /> Product Found
            </div>
            <div style={{ fontSize: 13, color: t.heading, fontWeight: 600, marginTop: 2 }}>{result.product.name}</div>
          </div>
          <ExistingAttributesTable isDark={isDark} attributes={result.discoveredAttributes} />
          <ExcludedAttributesNote isDark={isDark} excludedAttributes={result.excludedAttributes} />
          <AttributeMappingConfigurator
            isDark={isDark}
            rows={result.rows}
            submitting={false}
            onNext={overrides => onSubmitMapping(overrides, result.extracted)}
          />
        </div>
      );

    case "attributes-awaiting-pricing":
      return (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="flex items-center gap-2" style={{ color: "#22C55E", fontWeight: 700, fontSize: 13 }}>
              <Ic n="check-circle" s={16} /> Product Found
            </div>
            <div style={{ fontSize: 13, color: t.heading, fontWeight: 600, marginTop: 2 }}>{result.product.name}</div>
          </div>
          <ExistingAttributesTable isDark={isDark} attributes={result.discoveredAttributes} />
          <p style={{ fontSize: 12, color: t.dim, margin: 0 }}>
            Tell us which of these attributes to price and by how much (e.g. &ldquo;Add $150 for 16GB RAM&rdquo;), then submit again.
          </p>
        </div>
      );

    case "ready-for-review": {
      const currency = result.product.currency || result.extracted.currency || "USD";
      const existingToReuse = result.rules.filter(r => r.stated && !r.isNewValue);
      const newToCreate = result.rules.filter(r => r.isNewValue);
      const attributeNames = [...new Set(result.rules.map(r => r.attributeName))];
      const confirmed = creating || !!createResult;

      return (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="flex items-center gap-2" style={{ color: "#22C55E", fontWeight: 700, fontSize: 13 }}>
            <Ic n="check-circle" s={16} /> Pricing rules ready for review
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12.5, color: t.body }}>
            <span><strong style={{ color: t.heading }}>Product:</strong> {result.product.name}</span>
            {(result.product.basePrice ?? result.extracted.basePrice) != null && (
              <span><strong style={{ color: t.heading }}>Base Price:</strong> {formatCurrency((result.product.basePrice ?? result.extracted.basePrice)!)}</span>
            )}
            <span><strong style={{ color: t.heading }}>Currency:</strong> {currency}</span>
            {result.extracted.effectiveFrom && <span><strong style={{ color: t.heading }}>Effective From:</strong> {result.extracted.effectiveFrom}</span>}
            {result.extracted.effectiveTo && <span><strong style={{ color: t.heading }}>Effective To:</strong> {result.extracted.effectiveTo}</span>}
          </div>

          <ExistingAttributesTable isDark={isDark} attributes={result.discoveredAttributes} />

          <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${t.border}` }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: t.surfaceAlt }}>
                  {["Attribute", "Attribute Value", "Adjustment Type", "Adjustment"].map(h => (
                    <th key={h} style={{ textAlign: h === "Adjustment" ? "right" : "left", padding: "8px 12px", color: t.dim, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rules.map((r, i) => (
                  <tr key={`${r.attributeName}-${r.value}-${i}`} style={{ borderBottom: i < result.rules.length - 1 ? `1px solid ${t.border}` : undefined }}>
                    <td style={{ padding: "8px 12px", color: t.body }}>{r.attributeLabel}</td>
                    <td style={{ padding: "8px 12px", color: t.body }}>{r.valueLabel}{r.isNewValue && <span style={{ marginLeft: 6, fontSize: 10, color: t.accent, fontWeight: 700 }}>NEW</span>}</td>
                    <td style={{ padding: "8px 12px", color: t.dim }}>{r.adjustmentType === "fixed" ? "Fixed" : r.adjustmentType === "percentage" ? "Percentage" : "Override Price"}</td>
                    <td style={{ padding: "8px 12px", color: r.stated ? t.heading : t.dim, textAlign: "right", fontWeight: r.stated ? 700 : 400 }}>
                      {formatAdjustment(r.adjustmentType, r.adjustment)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(result.extracted.conditions.length > 0 || result.extracted.combinations.length > 0 || result.extracted.otherNotes.length > 0) && (
            <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: 0 }}>Noted for later — not yet applied</p>
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                {[...result.extracted.conditions, ...result.extracted.combinations, ...result.extracted.otherNotes].map((n, i) => (
                  <li key={i} className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.body }}>
                    <span style={{ flexShrink: 0, marginTop: 5, width: 4, height: 4, borderRadius: "50%", background: t.accent }} />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.warn }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="alert" s={12} /></span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* ── Part 6 — Next: moves from the preview into the separate Final Confirmation step ── */}
          {!reviewed && !confirmed && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <PrimaryButton label="Next" icon="arrow-right" isDark={isDark} onClick={() => setReviewed(true)} />
            </div>
          )}

          {/* ── Part F — Final Confirmation screen ── */}
          {(reviewed || confirmed) && (
            <div style={{ borderRadius: 12, border: `1px solid ${t.accent}40`, background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,212,255,0.04)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>Ready to create Attribute-Based Pricing</div>

              <SummaryRow label="Attributes" t={t} items={attributeNames} icon="check-circle" color="#22C55E" />
              {existingToReuse.length > 0 && <SummaryRow label="Existing values to reuse" t={t} items={existingToReuse.map(r => r.valueLabel)} icon="check-circle" color="#22C55E" />}
              {newToCreate.length > 0 && <SummaryRow label="New values to create" t={t} items={newToCreate.map(r => r.valueLabel)} icon="plus" color={t.accent} />}
              {result.excludedAttributes.length > 0 && <SummaryRow label="Excluded" t={t} items={result.excludedAttributes} icon="x" color={t.dim} />}
              <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Pricing Rules:</strong> {result.rules.length} rule{result.rules.length === 1 ? "" : "s"}</div>

              {!confirmed && (
                <div style={{ paddingTop: 4 }}>
                  <PrimaryButton
                    label="Create in Salesforce"
                    icon="zap"
                    isDark={isDark}
                    onClick={() => onConfirmCreate(result.product, result.discoveredAttributes, result.rules, result.excludedAttributes)}
                  />
                </div>
              )}
            </div>
          )}

          {confirmed && (
            <CreationProgress
              isDark={isDark} analyzeSteps={result.steps} createEvents={createEvents} createResult={createResult} createRequestError={createRequestError}
              onRetry={() => onConfirmCreate(result.product, result.discoveredAttributes, result.rules, result.excludedAttributes)}
            />
          )}

          {!confirmed && (
            <div className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.dim, paddingTop: 4, borderTop: `1px solid ${t.border}` }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="info" s={12} /></span>
              <span>Nothing has been created in Salesforce yet — Salesforce writes only begin after you click &ldquo;Create in Salesforce&rdquo; above.</span>
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

function SummaryRow({ label, items, icon, color, t }: { label: string; items: string[]; icon: string; color: string; t: ReturnType<typeof tokens> }) {
  return (
    <div>
      <p style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: t.dim, margin: "0 0 5px" }}>{label}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className="flex items-center gap-1" style={{ fontSize: 11.5, padding: "3px 9px", borderRadius: 999, border: `1px solid ${color}40`, background: `${color}14`, color }}>
            <Ic n={icon} s={11} /> {item}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════ Part T — live 16-step creation progress + Part Q summary/Part R failure ═══════════════════════ */

function CreationProgress({
  isDark, analyzeSteps, createEvents, createResult, createRequestError, onRetry,
}: {
  isDark: boolean;
  analyzeSteps: ProcedureStepLite[];
  createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateAttributePricingResult | null;
  createRequestError: string | null;
  /** §Follow-on 42 — re-runs the exact same create call (idempotent — every phase reuses whatever
   * already exists) after the user has configured a missing attribute default. */
  onRetry: () => void;
}) {
  const t = tokens(isDark);
  const confirmed = true; // this component only ever renders once the user has confirmed

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* §Part 21 — the execution ID, shown near the status once the create call has returned. */}
      {createResult?.executionId && (
        <div style={{ fontSize: 11, color: t.dim, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
          Execution ID: {createResult.executionId}
        </div>
      )}
      <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, overflow: "hidden" }}>
        {PART_T_STEPS.map((row, i) => {
          const rowStatus: RowStatus = row.analyzeSteps
            ? statusFromAnalyze(analyzeSteps, row.analyzeSteps)
            : row.createSteps
              ? statusFromCreate(createEvents, row.createSteps)
              : confirmed ? "completed" : "not-started";
          const color = rowStatus === "completed" ? "#22C55E" : rowStatus === "failed" ? t.error : rowStatus === "warning" ? t.warn : rowStatus === "in-progress" ? t.accent : t.dim;
          const relevantEvents = row.createSteps ? createEvents.filter(e => row.createSteps!.includes(e.step) && e.detail) : [];
          const latestDetail = relevantEvents.length > 0 ? relevantEvents[relevantEvents.length - 1].detail : undefined;
          return (
            <div key={row.label} style={{ padding: "8px 14px", borderBottom: i < PART_T_STEPS.length - 1 ? `1px solid ${t.border}` : undefined, background: t.surface }}>
              <div className="flex items-center gap-3">
                <span style={{ width: 18, textAlign: "center", color, fontSize: 13 }}>{STATUS_GLYPH[rowStatus]}</span>
                <span style={{ fontSize: 12.5, color: rowStatus === "not-started" ? t.dim : t.body }}>{row.label}</span>
              </div>
              {latestDetail && <div style={{ marginLeft: 30, marginTop: 2, fontSize: 11, color: t.dim }}>{latestDetail}</div>}
            </div>
          );
        })}
      </div>

      {createRequestError && (
        <WarnPanel isDark={isDark} title="Creation Failed">
          <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>{createRequestError}</p>
        </WarnPanel>
      )}

      {createResult && !createResult.success && <CreationFailurePanel isDark={isDark} result={createResult} onRetry={onRetry} />}
      {createResult?.success && <CreationSummary isDark={isDark} result={createResult} />}

      {/* §Parts 17-22 — collapsed by default, never cleared on failure (both driven entirely by
       * already-known props, not by any state that gets reset). */}
      <ExecutionLogPanel isDark={isDark} analyzeSteps={analyzeSteps} createSteps={createResult?.steps ?? []} />
      <ApiJsonDetailsPanel
        isDark={isDark}
        auditLog={createResult?.auditLog ?? []}
        procedureSnapshot={createResult?.procedureSnapshot ?? null}
        adjustmentDecisions={createResult?.adjustmentDecisions}
        expressionSetValidation={createResult?.expressionSetValidation}
        parentStepValidation={createResult?.parentStepValidation}
        duplicateStepNames={createResult?.duplicateStepNames}
        deployPayloadFingerprint={createResult?.deployPayloadFingerprint}
        listPriceOutputValidation={createResult?.listPriceOutputValidation}
        attributeDiscountInputBinding={createResult?.attributeDiscountInputBinding}
        hierarchyComparison={createResult?.hierarchyComparison}
        donorExtractionDeterministic={createResult?.donorExtractionDeterministic}
        identityFieldDrift={createResult?.identityFieldDrift}
        unrelatedBranchIntegrity={createResult?.unrelatedBranchIntegrity}
        attributeDiscountBranchSelection={createResult?.attributeDiscountBranchSelection}
        status={createResult?.status}
        deploymentSummary={createResult?.deploymentSummary}
        verificationWarning={createResult?.verificationWarning}
        verification={createResult?.verification}
        lifecycleStatus={createResult?.lifecycleStatus}
        expressionSetVersionResolution={createResult?.expressionSetVersionResolution}
        activationAudit={createResult?.activationAudit}
        expressionSetDonorInspection={createResult?.expressionSetDonorInspection}
      />
    </div>
  );
}

/** One deploy-vs-read-back component's status line — Part 8's exact "✓ deployed / ⚠ read-back could
 * not confirm" breakdown, shown wherever a `ComponentVerificationResult` is available (success panel's
 * warning state, or the failure panel when the ExpressionSet layer itself is implicated). */
function ComponentStatusLine({
  label, c,
}: {
  label: string;
  c?: { deployed: boolean; verified: boolean; verificationMethod: string; id: string | null; error?: string };
}) {
  if (!c) return null;
  return (
    <span>
      {c.deployed ? "✓" : "✕"} {label} deployed{c.verified ? " — ✓ verified via read-back" : " — ⚠ read-back could not confirm"}
      {c.id ? ` (${c.id})` : ""}
      {!c.verified && c.error ? ` — ${c.error}` : ""}
    </span>
  );
}

/** Part R — never say "created" unless read-back confirms it; always name exactly which stage failed and preserve every Id created so far for debugging. */
function CreationFailurePanel({ isDark, result, onRetry }: { isDark: boolean; result: CreateAttributePricingResult; onRetry: () => void }) {
  const t = tokens(isDark);
  const missing = result.failure?.missingAttributeConfig;
  if (missing && missing.length > 0) {
    return <MissingAttributeConfigPanel isDark={isDark} missing={missing} resolved={result.failure?.resolvedAttributeConfig ?? []} onRetry={onRetry} />;
  }
  return (
    <WarnPanel isDark={isDark} title="Creation Stopped">
      <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>{result.error}</p>
      {result.failure?.resolutionHint && <p style={{ fontSize: 12, color: t.dim, margin: 0 }}>{result.failure.resolutionHint}</p>}
      {result.verification && (
        <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px", fontSize: 11.5, color: t.dim, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontWeight: 700, color: t.heading, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>Read-back detail</span>
          <ComponentStatusLine label="Expression Set" c={result.verification.expressionSet} />
          <ComponentStatusLine label="Expression Set Version" c={result.verification.expressionSetVersion} />
          <ComponentStatusLine label="Pricing Procedure" c={result.verification.pricingProcedure} />
        </div>
      )}
      {(result.priceAdjustmentScheduleId || (result.ruleIds && result.ruleIds.length > 0)) && (
        <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surfaceAlt, padding: "10px 12px", fontSize: 11.5, color: t.dim, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontWeight: 700, color: t.heading, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>Preserved for debugging (nothing was rolled back)</span>
          {result.priceAdjustmentScheduleId && <span>Price Adjustment Schedule: {result.priceAdjustmentScheduleId}</span>}
          {result.ruleIds && result.ruleIds.length > 0 && <span>Rules created: {result.ruleIds.length}</span>}
          {result.conditionIds && result.conditionIds.length > 0 && <span>Conditions created: {result.conditionIds.length}</span>}
          {result.adjustmentIds && result.adjustmentIds.length > 0 && <span>Adjustments created: {result.adjustmentIds.length}</span>}
          {result.expressionSetId && <span>Expression Set: {result.expressionSetId}</span>}
        </div>
      )}
    </WarnPanel>
  );
}

/**
 * §Follow-on 42 — "ATTRIBUTE CONFIGURATION REQUIRED" remediation panel. Renders exactly the ✓/⚠
 * checklist requested: every price-impacting attribute that DID resolve a base value (from
 * `resolvedAttributeConfig`) shows ✓; every one that didn't (`missingAttributeConfig`) shows ⚠ with a
 * dropdown of the REAL Salesforce AttributePicklistValue rows Salesforce reported for it — never an
 * invented value, and never a value borrowed from another attribute. Saving calls the dedicated
 * configure-attribute-default endpoint (which itself writes + reads back before ever reporting
 * success); only once every missing attribute has been saved does "Retry Creation" become available,
 * which re-runs the exact same (idempotent) create call.
 */
function MissingAttributeConfigPanel({
  isDark, missing, resolved, onRetry,
}: {
  isDark: boolean;
  missing: NonNullable<CreateAttributePricingResult["failure"]>["missingAttributeConfig"];
  resolved: NonNullable<CreateAttributePricingResult["failure"]>["resolvedAttributeConfig"];
  onRetry: () => void;
}) {
  const t = tokens(isDark);
  const items = missing ?? [];
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<Record<string, string | null>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});

  async function handleSave(item: MissingAttributeConfigInfo) {
    const attributeName = item.attributeName;
    const value = selected[attributeName];
    if (!value) return;
    // §Live-org fix — `productAttributeDefinitionId` is null for a purely Product-Classification-inherited
    // attribute (no product-level record exists at all, e.g. Desktop's Graphics/Storage/Screen Size).
    // Previously this silently returned here, so the button appeared clickable but did nothing. The API
    // route now also accepts productId/attributeDefinitionId/productClassificationAttrId and creates a
    // product-scoped override in that case — only genuinely stop (with a visible error) when NEITHER path
    // is possible.
    if (!item.productAttributeDefinitionId && !(item.productId && item.attributeDefinitionId && item.productClassificationAttrId)) {
      setSaveError(prev => ({ ...prev, [attributeName]: "This attribute has no Product Attribute Definition record and is not resolvable as a Product Classification-inherited attribute — nothing can be saved automatically. Configure it directly in Salesforce Setup." }));
      return;
    }
    setSaving(prev => ({ ...prev, [attributeName]: true }));
    setSaveError(prev => ({ ...prev, [attributeName]: null }));
    try {
      const res = await fetch("/api/pricing-rules/attribute-based/configure-attribute-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productAttributeDefinitionId: item.productAttributeDefinitionId,
          productId: item.productId,
          attributeDefinitionId: item.attributeDefinitionId,
          productClassificationAttrId: item.productClassificationAttrId,
          value,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success !== true) {
        setSaveError(prev => ({ ...prev, [attributeName]: body.error ?? `Save failed (HTTP ${res.status}).` }));
        return;
      }
      setSaved(prev => ({ ...prev, [attributeName]: body.verifiedValue ?? value }));
    } catch (err) {
      setSaveError(prev => ({ ...prev, [attributeName]: err instanceof Error ? err.message : "Network error — could not reach the server." }));
    } finally {
      setSaving(prev => ({ ...prev, [attributeName]: false }));
    }
  }

  const allConfigured = items.every(m => !!saved[m.attributeName]);

  return (
    <WarnPanel isDark={isDark} title="Attribute Configuration Required">
      <p style={{ fontSize: 12.5, color: t.body, margin: 0 }}>
        Salesforce&rsquo;s Attribute-Based Adjustment model requires every price-impacting attribute to have a
        base value before pricing conditions can be built. The attribute(s) below have no product-level or
        classification-level Default Value on this org.
      </p>

      <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, overflow: "hidden" }}>
        {(resolved ?? []).map(r => (
          <div key={r.attributeName} className="flex items-center gap-3" style={{ padding: "8px 14px", borderBottom: `1px solid ${t.border}`, background: t.surface }}>
            <span style={{ width: 18, textAlign: "center", color: "#22C55E", fontSize: 13 }}>✓</span>
            <span style={{ fontSize: 12.5, color: t.body }}>{r.attributeName} — {r.value}</span>
            <span style={{ fontSize: 10.5, color: t.dim, marginLeft: "auto" }}>{r.source}</span>
          </div>
        ))}
        {items.map(m => {
          const isSaved = !!saved[m.attributeName];
          return (
            <div key={m.attributeName} style={{ padding: "10px 14px", borderBottom: `1px solid ${t.border}`, background: t.surface, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="flex items-center gap-3">
                <span style={{ width: 18, textAlign: "center", color: isSaved ? "#22C55E" : t.warn, fontSize: 13 }}>{isSaved ? "✓" : "⚠"}</span>
                <span style={{ fontSize: 12.5, color: t.body }}>
                  {m.attributeName} — {isSaved ? saved[m.attributeName] : "Default Value Required"}
                </span>
                {isSaved && <span style={{ fontSize: 10.5, color: t.dim, marginLeft: "auto" }}>PRODUCT_OVERRIDE</span>}
              </div>
              {!isSaved && (
                <div className="flex items-center gap-2" style={{ marginLeft: 30, flexWrap: "wrap" }}>
                  {m.candidateValues.length === 0 ? (
                    <span style={{ fontSize: 12, color: t.dim }}>
                      No AttributePicklistValue records exist for this attribute on Salesforce — create at least one
                      value for &ldquo;{m.attributeName}&rdquo; in Setup, then come back and retry.
                    </span>
                  ) : (
                    <>
                      <select
                        value={selected[m.attributeName] ?? ""}
                        onChange={e => setSelected(prev => ({ ...prev, [m.attributeName]: e.target.value }))}
                        style={{
                          fontSize: 12.5, padding: "6px 10px", borderRadius: 8, border: `1px solid ${t.border}`,
                          background: t.surfaceAlt, color: t.body, minWidth: 220,
                        }}
                      >
                        <option value="">Select a Salesforce Attribute Value…</option>
                        {m.candidateValues.map(c => <option key={c.id} value={c.value}>{c.value}</option>)}
                      </select>
                      <GhostButton
                        label={saving[m.attributeName] ? "Saving…" : "Save Default Value"}
                        icon="check"
                        isDark={isDark}
                        disabled={!selected[m.attributeName] || !!saving[m.attributeName]}
                        onClick={() => void handleSave(m)}
                      />
                    </>
                  )}
                </div>
              )}
              {saveError[m.attributeName] && (
                <p style={{ fontSize: 11.5, color: t.error, margin: "0 0 0 30px" }}>{saveError[m.attributeName]}</p>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <PrimaryButton label="Retry Creation" icon="refresh" isDark={isDark} disabled={!allConfigured} onClick={onRetry} />
      </div>
    </WarnPanel>
  );
}

const RECORD_STATUS_LABEL: Record<SalesforceRecordLink["status"], string> = {
  verified: "Verified", active: "Active", draft: "Draft", not_verified: "Not verified", unknown: "Unknown",
};

/** §"Salesforce Records" section — every navigation entry is built from `buildAttributePricingSalesforceRecords`
 * (lib/pricing-rules/attribute-based/create/salesforceRecordLinks.ts), which only ever accepts
 * already-verified identities (expressionSetId/expressionSetVersionId/priceAdjustmentScheduleId) — a
 * Metadata API deployment component's own Id has no parameter to flow through here at all. */
function SalesforceRecordsSection({ isDark, result }: { isDark: boolean; result: CreateAttributePricingResult }) {
  const t = tokens(isDark);
  const instanceUrl = typeof window !== "undefined" ? loadSession()?.instanceUrl ?? null : null;
  const records = buildAttributePricingSalesforceRecords(instanceUrl, {
    expressionSetId: result.expressionSetId,
    expressionSetApiName: result.expressionSetApiName,
    expressionSetVersionId: result.expressionSetVersionId,
    versionStatus: result.versionStatus,
    priceAdjustmentScheduleId: result.priceAdjustmentScheduleId,
    ruleCount: result.ruleIds?.length ?? 0,
    conditionCount: result.conditionIds?.length ?? 0,
    adjustmentCount: result.adjustmentIds?.length ?? 0,
    verification: result.verification,
    allVersions: result.expressionSetVersionResolution?.candidates?.map(v => ({
      id: (v.id as string | null | undefined) ?? null,
      versionNumber: (v.versionNumber as string | number | null | undefined) ?? (v.version as string | number | null | undefined) ?? null,
      enabled: (v.enabled as boolean | null | undefined) ?? (v.isEnabled as boolean | null | undefined) ?? null,
    })),
  });
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      <span style={{ fontWeight: 700, color: t.heading, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4 }}>Salesforce Records</span>
      {records.map(r => (
        <div key={r.key} className="flex items-center justify-between gap-2" style={{ fontSize: 12, color: t.body, flexWrap: "wrap" }}>
          <span style={{ minWidth: 0 }}>
            <strong style={{ color: t.heading }}>{r.label}</strong>
            {r.name && <>: {r.name}</>}
            {r.id && <span style={{ color: t.dim }}> ({r.id})</span>}
            {r.count !== undefined && <span style={{ color: t.dim }}> — {r.count}</span>}
            <span style={{ color: r.status === "verified" || r.status === "active" ? "#22C55E" : r.status === "draft" ? t.warn : t.dim }}> · {RECORD_STATUS_LABEL[r.status]}</span>
          </span>
          <GhostButton
            label={r.actionLabel}
            icon="external-link"
            isDark={isDark}
            disabled={!r.url}
            onClick={() => { if (r.url) window.open(r.url, "_blank", "noopener,noreferrer"); }}
          />
        </div>
      ))}
    </div>
  );
}

function CreationSummary({ isDark, result }: { isDark: boolean; result: CreateAttributePricingResult }) {
  const t = tokens(isDark);
  const hasWarning = result.status === "deployed_with_verification_warning";
  return (
    <div style={{ padding: 16, borderRadius: 12, border: `1px solid ${hasWarning ? t.warn : t.border}`, background: t.surfaceAlt, display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="flex items-center gap-2" style={{ color: hasWarning ? t.warn : "#22C55E", fontWeight: 700, fontSize: 13.5 }}>
        <Ic n={hasWarning ? "alert" : "check-circle"} s={17} /> {hasWarning ? "Deployment Completed with Verification Warning" : "Attribute-Based Pricing Created"}
      </div>
      {hasWarning && (
        <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, padding: "10px 12px", fontSize: 11.5, color: t.body, display: "flex", flexDirection: "column", gap: 3 }}>
          {/* §Part 11 — the exact granular per-stage state, instead of the previous single vague
           * "Deployment Completed with Verification Warning" line: a pending/failed ACTIVATION reads as
           * its own distinct state here, never folded into an undifferentiated verification gap. */}
          {result.lifecycleStatus ? (
            <>
              <span>Expression Set deployment: {result.lifecycleStatus.expressionSetDeployment.toUpperCase()}</span>
              <span>Expression Set Version deployment: {result.lifecycleStatus.expressionSetVersionDeployment.toUpperCase()}</span>
              <span>Expression Set Version resolution: {result.lifecycleStatus.expressionSetVersionResolution.toUpperCase()}</span>
              <span>Activation: {result.lifecycleStatus.activation.replace("_", " ").toUpperCase()}</span>
              <span>Pricing Procedure: {result.lifecycleStatus.pricingProcedure.toUpperCase()}</span>
            </>
          ) : (
            <>
              <span>✓ Expression Set deployment accepted</span>
              <span>✓ Expression Set Version deployment accepted</span>
              <span>✓ Pricing Procedure deployment accepted</span>
            </>
          )}
          {result.verification && (
            <>
              <ComponentStatusLine label="Expression Set" c={result.verification.expressionSet} />
              <ComponentStatusLine label="Expression Set Version" c={result.verification.expressionSetVersion} />
              <ComponentStatusLine label="Pricing Procedure" c={result.verification.pricingProcedure} />
            </>
          )}
          {result.verificationWarning && <span style={{ color: t.warn }}>⚠ {result.verificationWarning}</span>}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Product:</strong> {result.product?.name}</div>
      {result.expressionSetApiName && <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Pricing Procedure:</strong> {result.expressionSetApiName}</div>}
      {result.expressionSetId && <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Expression Set:</strong> {result.expressionSetId}</div>}
      {result.expressionSetVersionId && <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Expression Set Version:</strong> {result.expressionSetVersionId} ({result.versionStatus})</div>}
      {result.priceAdjustmentScheduleId && (
        <div style={{ fontSize: 12.5, color: t.body }}>
          <strong style={{ color: t.heading }}>Price Adjustment Schedule:</strong> Existing Price Adjustment Schedule reused ({result.priceAdjustmentScheduleId}) — type Attribute.
        </div>
      )}
      <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Rules Created:</strong> {result.ruleIds?.length ?? 0}</div>
      <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Existing Values Reused:</strong> {result.existingValuesReused?.length ?? 0}</div>
      <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>New Values Created:</strong> {result.createdValues?.length ?? 0}</div>
      <div style={{ fontSize: 12.5, color: t.body }}><strong style={{ color: t.heading }}>Excluded Attributes:</strong> {result.excludedAttributes?.length ?? 0}</div>
      {result.warnings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2" style={{ fontSize: 11.5, color: t.warn }}>
              <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="alert" s={12} /></span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
      <SalesforceRecordsSection isDark={isDark} result={result} />
    </div>
  );
}
