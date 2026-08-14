"use client";

import { useState, type ReactNode } from "react";
import { Ic, tokens, Section, Pill, PrimaryButton, GhostButton, Spinner, ErrorPanel, inputStyle, formatCurrency } from "./shared";
import DeploymentProgressPanel, { computeDeploymentSteps, type LiveSteps } from "./DeploymentProgressPanel";
import AttributePreviewPanel from "./AttributePreviewPanel";
import CreateProcedureFailurePanel from "./CreateProcedureFailurePanel";
import { buildFriendlyStopMessage } from "@/lib/pricing-rules/ui/friendlyCreateFailure";
import { streamCreateProcedure } from "@/lib/pricing-rules/ui/streamCreateProcedure";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { emptyProcedureForm } from "@/lib/pricing-rules/types";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";
import type {
  DiscoverProcedureResult, DiscoveredAttributeSummary, AttributeValueMappingPreview, ExistingScheduleSummary,
  ResolvedAttributeEntryLike, SalesforceCreationResult, CreateProcedureFailure, VerifyExecutionResult,
  ProcedureFormData, ProductAttributeData, AttributePricingType, AttributePreviewEntry,
} from "@/lib/pricing-rules/types";

/**
 * "Autopilot" — Steps 1-7 (discover, extract, resolve mappings) live
 * entirely client-side against /api/pricing-rules/ai/discover-procedure,
 * which never writes to Salesforce. Steps 8-12 (Review -> Confirm ->
 * Create -> Verify) only begin once the user explicitly clicks "Confirm &
 * Create" on the final Review page, at which point this calls the exact
 * same /api/pricing-rules/create-procedure the guided/manual flow uses —
 * so Autopilot's creation progress is the real manual workflow, not a
 * reimplementation of it. Mounted alongside (not replacing) the guided
 * flow on the pricing-type select screen — see CreatePricingRuleFlow.
 */

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

interface UnmappedValue {
  attributeName: string;
  attributeLabel: string;
  value: string;
  valueLabel: string;
}

/** Derived, never stored — the moment a value is added to `mappedEntries` it disappears from here automatically. */
function computeUnmapped(attributes: DiscoveredAttributeSummary[], mapped: AttributeValueMappingPreview[]): UnmappedValue[] {
  const mappedKeys = new Set(mapped.map(m => `${m.attributeName}::${m.attributeValue}`));
  const out: UnmappedValue[] = [];
  for (const attr of attributes) {
    for (const v of attr.values) {
      if (!mappedKeys.has(`${attr.attributeName}::${v.value}`)) {
        out.push({ attributeName: attr.attributeName, attributeLabel: attr.attributeLabel, value: v.value, valueLabel: v.label });
      }
    }
  }
  return out;
}

const ADJUSTMENT_TYPES: AttributePricingType[] = ["Percentage Discount", "Fixed Amount", "Override Price"];

interface ReviewState {
  product: NonNullable<DiscoverProcedureResult["product"]>;
  procedureName: string;
  attributes: DiscoveredAttributeSummary[];
  existingSchedule: ExistingScheduleSummary | null;
  mappedEntries: AttributeValueMappingPreview[];
  subPhase: "mapping" | "review";
  /** §REQUEST_LIMIT_EXCEEDED remediation — carried straight through to create-procedure's `discoveredAttributes`, so it can reuse this discovery pass instead of repeating it. Absent only if the discover-procedure response predates this field (never expected in practice, but never assumed). */
  fullAttributeData: DiscoverProcedureResult["fullAttributeData"];
}

interface OverridePayload {
  entries: ResolvedAttributeEntryLike[];
  productName: string;
  procedureName: string;
}

export default function AutoCreatePanel({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const [prompt, setPrompt] = useState("");
  const [debugMode, setDebugMode] = useState(false);
  // §Auto-Fix Price Impacting — opt-in, off by default (see ProcedurePayload.autoFixPriceImpacting):
  // flipping this flag can affect every OTHER product/procedure sharing the same attribute/PAD record.
  const [autoFixPriceImpacting, setAutoFixPriceImpacting] = useState(false);

  const [discovering, setDiscovering] = useState(false);
  const [discoverNetworkError, setDiscoverNetworkError] = useState<string | null>(null);
  const [discoverResult, setDiscoverResult] = useState<DiscoverProcedureResult | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);

  const [creating, setCreating] = useState(false);
  const [createNetworkError, setCreateNetworkError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<SalesforceCreationResult | null>(null);
  const [createFailure, setCreateFailure] = useState<CreateProcedureFailure | null>(null);
  // §Sequential Workflow — Runtime Verification (Step 12) now runs server-side as part of the same
  // create-procedure request/response (no separate async follow-up call), so there's no longer a
  // distinct "verifying" gap to show a spinner for. Kept as a stable `false` so
  // computeDeploymentSteps's existing verify-status logic (which already handles a null verifyResult
  // correctly for the "nothing to simulate" case) needs no changes.
  const verifying = false;
  const [verifyResult, setVerifyResult] = useState<VerifyExecutionResult | null>(null);
  // §Sequential Workflow — live per-checklist-row state streamed from create-procedure as it actually
  // runs (see streamCreateProcedure.ts/DeploymentProgressPanel.tsx's LiveSteps).
  const [liveSteps, setLiveSteps] = useState<LiveSteps>({});
  // §B — the complete Attribute JSON Preview, streamed live before any native record create begins.
  const [attributePreview, setAttributePreview] = useState<{
    product2Id: string; sellingModelId: string; priceAdjustmentScheduleId: string | null; attributes: AttributePreviewEntry[];
  } | null>(null);

  async function runDiscover(override?: OverridePayload) {
    if (discovering) return;
    if (!override && !prompt.trim()) return;
    setDiscovering(true);
    setDiscoverNetworkError(null);
    setDiscoverResult(null);
    try {
      const res = await fetch("/api/pricing-rules/ai/discover-procedure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          debug: debugMode,
          ...(override ? { overrideEntries: override.entries, overrideProductName: override.productName, overrideProcedureName: override.procedureName } : {}),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`Autopilot request failed (HTTP ${res.status}).`);
      const result = json as DiscoverProcedureResult;
      setDiscoverResult(result);
      if (result.success && result.product) {
        setReview({
          product: result.product,
          procedureName: result.procedureName || `${result.product.name} Attribute-Based Pricing Procedure`,
          attributes: result.attributes ?? [],
          existingSchedule: result.existingSchedule ?? null,
          mappedEntries: result.mappedEntries ?? [],
          subPhase: "mapping",
          fullAttributeData: result.fullAttributeData,
        });
      }
    } catch (err) {
      setDiscoverNetworkError(err instanceof Error ? err.message : "Autopilot failed.");
    } finally {
      setDiscovering(false);
    }
  }

  function resetAll() {
    setPrompt("");
    setDiscoverNetworkError(null);
    setDiscoverResult(null);
    setReview(null);
    setCreating(false);
    setCreateNetworkError(null);
    setCreateResult(null);
    setCreateFailure(null);
    setVerifyResult(null);
    setLiveSteps({});
    setAttributePreview(null);
  }

  async function handleConfirmCreate(r: ReviewState) {
    setCreating(true);
    setCreateNetworkError(null);
    setCreateResult(null);
    setCreateFailure(null);
    setLiveSteps({});
    setAttributePreview(null);
    try {
      const payload = {
        procedureName: r.procedureName,
        apiName: "",
        description: "",
        productName: r.product.name,
        pricingType: "attribute-based" as const,
        productId: r.product.id,
        productCode: r.product.productCode,
        productStatus: r.product.status,
        currency: r.product.currency,
        sellingModel: r.product.sellingModelName,
        sellingModelId: r.product.sellingModelId,
        effectiveFrom: r.product.effectiveFrom,
        effectiveTo: r.product.effectiveTo,
        procedureStatus: "Active" as const,
        basePrice: r.product.basePrice != null ? String(r.product.basePrice) : "",
        attributeEntries: r.mappedEntries.map(m => ({
          id: generateId(), attributeName: m.attributeName, attributeLabel: m.attributeLabel,
          attributeValue: m.attributeValue, attributeValueLabel: m.attributeValueLabel,
          pricingType: m.adjustmentType as AttributePricingType, adjustmentValue: String(m.adjustmentValue),
        })),
        allowReuseExistingSchedule: true,
        autoFixPriceImpacting,
        // §REQUEST_LIMIT_EXCEEDED remediation — reuse the discovery pass
        // already run above instead of making create-procedure repeat it.
        ...(r.fullAttributeData ? { discoveredAttributes: r.fullAttributeData } : {}),
      };
      const result = await streamCreateProcedure(
        { payload, debug: debugMode },
        evt => {
          if (evt.type === "attributePreview") {
            setAttributePreview({ product2Id: evt.product2Id, sellingModelId: evt.sellingModelId, priceAdjustmentScheduleId: evt.priceAdjustmentScheduleId, attributes: evt.attributes });
            return;
          }
          setLiveSteps(prev => ({ ...prev, [evt.step]: { status: evt.status, detail: evt.detail } }));
        },
      );
      setCreateResult(result);
      setCreateFailure(result.failure ?? null);
      // §Sequential Workflow — Runtime Verification (Step 12) now runs server-side, synchronously, as
      // the workflow's own last step, so its result already arrives embedded in this same response —
      // no separate follow-up call to /api/pricing-rules/verify-execution needed anymore. Populated on
      // a Step-12 failure too (every earlier step already succeeded by then).
      setVerifyResult(result.verifyResult ?? null);

      if (result.success && result.procedureId) {
        const instanceUrl = loadSession()?.instanceUrl;
        if (instanceUrl) {
          const record = toCreatedSalesforceRecord(instanceUrl, "ExpressionSet", result.procedureId, result.apiName ?? result.procedureId);
          notifySalesforceSuccess({
            title: "Pricing Procedure Created Successfully",
            message: `${record.recordName} has been successfully created in Salesforce.`,
            records: [record],
          });
        }
      }
    } catch (err) {
      setCreateNetworkError(err instanceof Error ? err.message : "Autopilot couldn't reach Salesforce to create the pricing procedure.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ background: t.surface, border: `1px solid ${t.borderBright}`, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="zap" s={17} /></span>
        <span style={{ fontSize: 14, fontWeight: 700, color: t.heading }}>Autopilot</span>
        <Pill label="Attribute-Based · review before creating" color={t.accent} isDark={isDark} />
      </div>

      {!review && (
        <>
          <div style={{ fontSize: 11.5, color: t.dim, lineHeight: 1.5 }}>
            Describe what to create — Autopilot discovers the product, its attributes, and every real
            value, shows you exactly what it found and how it read your prompt, and lets you fill in
            anything it couldn&apos;t map before you review and confirm. Nothing is created in Salesforce
            until you explicitly confirm the final Review page.
          </div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder='e.g. "Create an Attribute-Based Pricing Procedure for Laptop — Storage 512GB +150, Processor Intel i7 +250, Graphics RTX 4060 +450."'
            rows={3}
            style={{ ...inputStyle(t), resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim, cursor: "pointer" }} title="Includes every SOQL query and REST endpoint in the result.">
              <input type="checkbox" checked={debugMode} onChange={e => setDebugMode(e.target.checked)} />
              Debug Mode
            </label>
            <PrimaryButton label={discovering ? "Discovering…" : "Discover & Review"} icon="zap" isDark={isDark} disabled={discovering || !prompt.trim()} onClick={() => runDiscover()} />
          </div>

          <PromptGuide isDark={isDark} config={promptGuideConfig.pricingRule} onUseExample={setPrompt} />

          {discovering && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.dim, fontSize: 12.5 }}>
              <Spinner isDark={isDark} /> Discovering the product and its attributes in Salesforce…
            </div>
          )}

          {discoverNetworkError && <ErrorPanel isDark={isDark} error={{ title: "Autopilot request failed", message: discoverNetworkError }} onRetry={() => runDiscover()} />}

          {discoverResult && !discoverResult.success && (
            <DiscoveryStopView result={discoverResult} isDark={isDark} onUseSuggestedMappings={o => runDiscover(o)} />
          )}
        </>
      )}

      {review && review.subPhase === "mapping" && !creating && !createResult && (
        <MappingResolutionView
          isDark={isDark}
          review={review}
          onChangeMappedEntries={entries => setReview(prev => (prev ? { ...prev, mappedEntries: entries } : prev))}
          onContinue={() => setReview(prev => (prev ? { ...prev, subPhase: "review" } : prev))}
          onStartOver={resetAll}
        />
      )}

      {review && review.subPhase === "review" && !creating && !createResult && (
        <FinalReviewView
          isDark={isDark}
          review={review}
          onBack={() => setReview(prev => (prev ? { ...prev, subPhase: "mapping" } : prev))}
          onConfirm={() => handleConfirmCreate(review)}
          onStartOver={resetAll}
          autoFixPriceImpacting={autoFixPriceImpacting}
          onToggleAutoFixPriceImpacting={setAutoFixPriceImpacting}
        />
      )}

      {(creating || createResult || createNetworkError) && review && (
        <CreationView
          isDark={isDark}
          review={review}
          creating={creating}
          createResult={createResult}
          createFailure={createFailure}
          createNetworkError={createNetworkError}
          verifying={verifying}
          verifyResult={verifyResult}
          liveSteps={liveSteps}
          attributePreview={attributePreview}
          onBackToReview={() => { setCreateResult(null); setCreateFailure(null); setCreateNetworkError(null); setLiveSteps({}); setAttributePreview(null); setReview(prev => (prev ? { ...prev, subPhase: "review" } : prev)); }}
          onStartOver={resetAll}
        />
      )}
    </div>
  );
}

/* ── "Not Yet Mapped" / needsAttributeResolution / productNotFound / notImplemented ── */
function DiscoveryStopView({ isDark, result, onUseSuggestedMappings }: {
  isDark: boolean;
  result: DiscoverProcedureResult;
  onUseSuggestedMappings: (override: OverridePayload) => void;
}) {
  if (result.productNotFound) {
    return <ErrorPanel isDark={isDark} error={{ title: "Product not found", message: result.error ?? `Product '${result.productName}' does not exist.` }} />;
  }
  if (result.notImplemented) {
    return <ErrorPanel isDark={isDark} error={{ title: "Pricing type not supported", message: result.error ?? "Only Attribute-Based pricing has a real deploy path." }} />;
  }
  if (result.needsAttributeResolution) {
    return <AttributeValidationSummary isDark={isDark} result={result} onUseSuggestedMappings={onUseSuggestedMappings} />;
  }
  return <ErrorPanel isDark={isDark} error={{ title: "Autopilot stopped", message: result.friendlyError ?? result.error ?? "Something prevented Autopilot from continuing." }} />;
}

const CONFIDENCE_COLOR: Record<"high" | "medium", string> = { high: "#22C55E", medium: "#F59E0B" };
const CONFIDENCE_LABEL: Record<"high" | "medium", string> = { high: "High confidence", medium: "Medium confidence" };
const METHOD_LABEL: Record<"fuzzy-match" | "ai-suggested", string> = { "fuzzy-match": "matched by name/spec similarity", "ai-suggested": "matched by AI (semantic)" };

/** §Attribute Validation UX — an intelligent-assistant summary, not an error message, for prompt-stated attribute/value pairs that don't exist on this product. Never fabricates a suggestion — see attributeMappingSuggestions.ts. */
function AttributeValidationSummary({ isDark, result, onUseSuggestedMappings }: {
  isDark: boolean;
  result: DiscoverProcedureResult;
  onUseSuggestedMappings: (override: OverridePayload) => void;
}) {
  const t = tokens(isDark);
  const issues = result.attributeIssues ?? [];
  const withSuggestion = issues.filter(i => i.suggestion);
  const withoutSuggestion = issues.filter(i => !i.suggestion);

  function handleUseSuggested() {
    if (!result.productName || withSuggestion.length === 0) return;
    const fromSuggestions: ResolvedAttributeEntryLike[] = withSuggestion.map(i => ({
      attributeName: i.suggestion!.attributeName, attributeValue: i.suggestion!.attributeValue,
      adjustmentType: i.adjustmentType, adjustmentValue: i.adjustmentValue,
    }));
    onUseSuggestedMappings({
      entries: [...(result.resolvedEntries ?? []), ...fromSuggestions],
      productName: result.productName,
      procedureName: result.procedureName || `${result.productName} Attribute-Based Pricing Procedure`,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.accent, fontWeight: 700, fontSize: 13.5 }}>
        <Ic n="sparkles" s={16} /> A few attribute values need a closer look
      </div>
      <div style={{ fontSize: 12, color: t.dim }}>Nothing has been created in Salesforce yet — Autopilot found real attributes on this product, but couldn&apos;t match the value(s) below exactly as typed.</div>

      <Section title="Missing Attributes / Values" icon="alert" isDark={isDark} defaultOpen>
        <div style={{ paddingTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: t.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
                <th style={{ padding: "4px 10px 8px 0" }}>Attribute</th>
                <th style={{ padding: "4px 10px 8px 0" }}>User-entered value</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: "8px 10px 8px 0", color: t.heading, fontWeight: 600 }}>{issue.enteredAttributeName}</td>
                  <td style={{ padding: "8px 10px 8px 0", color: t.body }}>{issue.enteredAttributeValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Available Salesforce Attributes" icon="table" isDark={isDark} defaultOpen={false}>
        <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {(result.attributes ?? []).map(a => (
            <div key={a.attributeName} style={{ fontSize: 12, color: t.body }}>
              <strong style={{ color: t.heading }}>{a.attributeLabel}</strong>: {a.values.map(v => v.label).join(", ") || "(no values found)"}
            </div>
          ))}
          {(!result.attributes || result.attributes.length === 0) && <div style={{ fontSize: 12, color: t.dim }}>No attributes were discovered on this product.</div>}
        </div>
      </Section>

      <Section title="Suggested Mappings" icon="sparkles" isDark={isDark} defaultOpen>
        <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {withSuggestion.map((issue, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, padding: "8px 10px", borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
              <span style={{ color: t.body }}>{issue.enteredAttributeName} <strong>{issue.enteredAttributeValue}</strong></span>
              <Ic n="arrow-right" s={13} />
              <span style={{ color: t.heading, fontWeight: 700 }}>{issue.suggestion!.attributeLabel} {issue.suggestion!.attributeValueLabel}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: CONFIDENCE_COLOR[issue.suggestion!.confidence], background: `${CONFIDENCE_COLOR[issue.suggestion!.confidence]}1c`, border: `1px solid ${CONFIDENCE_COLOR[issue.suggestion!.confidence]}40`, borderRadius: 999, padding: "2px 8px" }}>
                {CONFIDENCE_LABEL[issue.suggestion!.confidence]}
              </span>
              <span style={{ fontSize: 10.5, color: t.dim }}>({METHOD_LABEL[issue.suggestion!.method]})</span>
            </div>
          ))}
          {withoutSuggestion.map((issue, i) => (
            <div key={i} style={{ fontSize: 12, color: t.dim, padding: "8px 10px", borderRadius: 8, border: `1px dashed ${t.border}` }}>
              {issue.enteredAttributeName} <strong style={{ color: t.body }}>{issue.enteredAttributeValue}</strong> — no confidently matching Salesforce value was found. Edit the prompt to use one of the real values listed above.
            </div>
          ))}
        </div>
      </Section>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", paddingTop: 4 }}>
        <PrimaryButton
          label={`Use Suggested Mappings${withSuggestion.length > 0 ? ` (${withSuggestion.length})` : ""}`}
          icon="check" isDark={isDark} disabled={withSuggestion.length === 0} onClick={handleUseSuggested}
        />
      </div>
    </div>
  );
}

/* ── Steps 4-7: Product Summary, Attributes & Values, Pricing Mappings, Not Yet Mapped ── */
function MappingResolutionView({ isDark, review, onChangeMappedEntries, onContinue, onStartOver }: {
  isDark: boolean;
  review: ReviewState;
  onChangeMappedEntries: (entries: AttributeValueMappingPreview[]) => void;
  onContinue: () => void;
  onStartOver: () => void;
}) {
  const t = tokens(isDark);
  const { product, attributes, mappedEntries } = review;
  const unmapped = computeUnmapped(attributes, mappedEntries);
  const unmappedByAttribute = new Map<string, UnmappedValue[]>();
  for (const u of unmapped) {
    const list = unmappedByAttribute.get(u.attributeName) ?? [];
    list.push(u);
    unmappedByAttribute.set(u.attributeName, list);
  }

  const [showAddForm, setShowAddForm] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { adjustmentType: AttributePricingType; adjustmentValue: string }>>({});

  function draftKey(u: UnmappedValue): string { return `${u.attributeName}::${u.value}`; }

  function applyDrafts() {
    const additions: AttributeValueMappingPreview[] = [];
    for (const u of unmapped) {
      const draft = drafts[draftKey(u)];
      if (!draft || !draft.adjustmentValue.trim()) continue;
      const amount = Number(draft.adjustmentValue);
      if (!Number.isFinite(amount)) continue;
      const isOverride = /override/i.test(draft.adjustmentType);
      if (!(isOverride ? amount >= 0 : amount > 0)) continue;
      additions.push({ attributeName: u.attributeName, attributeLabel: u.attributeLabel, attributeValue: u.value, attributeValueLabel: u.valueLabel, adjustmentType: draft.adjustmentType, adjustmentValue: amount });
    }
    if (additions.length > 0) {
      onChangeMappedEntries([...mappedEntries, ...additions]);
      setDrafts({});
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Product Summary */}
      <Section title="Product Summary" icon="zap" isDark={isDark} defaultOpen>
        <div style={{ paddingTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, fontSize: 12 }}>
          <div><strong style={{ color: t.heading }}>Product:</strong> <span style={{ color: t.body }}>{product.name}</span></div>
          <div><strong style={{ color: t.heading }}>Product Id:</strong> <span style={{ color: t.body }}>{product.id}</span></div>
          <div><strong style={{ color: t.heading }}>Product Code:</strong> <span style={{ color: t.body }}>{product.productCode || "—"}</span></div>
          <div><strong style={{ color: t.heading }}>Status:</strong> <span style={{ color: t.body }}>{product.status}</span></div>
          <div><strong style={{ color: t.heading }}>Currency:</strong> <span style={{ color: t.body }}>{product.currency}</span></div>
          <div><strong style={{ color: t.heading }}>List Price:</strong> <span style={{ color: t.body }}>{product.basePrice != null ? formatCurrency(product.basePrice) : "Not found"}</span></div>
          <div><strong style={{ color: t.heading }}>Selling Model:</strong> <span style={{ color: t.body }}>{product.sellingModelName || "—"}</span></div>
          <div><strong style={{ color: t.heading }}>Selling Model Id:</strong> <span style={{ color: t.body }}>{product.sellingModelId}</span></div>
        </div>
      </Section>

      {/* Attributes & Values */}
      <Section title="Discovered Attributes & Values" icon="table" isDark={isDark} defaultOpen={false}>
        <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {attributes.map(a => (
            <div key={a.attributeName} style={{ fontSize: 12, color: t.body }}>
              <strong style={{ color: t.heading }}>{a.attributeLabel}</strong>: {a.values.map(v => v.label).join(", ") || "(no values found)"}
            </div>
          ))}
          {attributes.length === 0 && <div style={{ fontSize: 12, color: t.dim }}>No attributes were discovered on this product.</div>}
        </div>
      </Section>

      {/* Pricing Mappings extracted from the prompt */}
      <Section title="Pricing Mappings (from your prompt)" icon="sparkles" isDark={isDark} defaultOpen>
        <div style={{ paddingTop: 10, overflowX: "auto" }}>
          {mappedEntries.length === 0 ? (
            <div style={{ fontSize: 12, color: t.dim }}>No attribute pricing was extracted from the prompt yet — add mappings below, or continue and reuse existing pricing if this product already has some.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: t.dim, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>
                  <th style={{ padding: "4px 10px 8px 0" }}>Attribute</th>
                  <th style={{ padding: "4px 10px 8px 0" }}>Value</th>
                  <th style={{ padding: "4px 10px 8px 0" }}>Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {mappedEntries.map((m, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: "8px 10px 8px 0", color: t.heading, fontWeight: 600 }}>{m.attributeLabel}</td>
                    <td style={{ padding: "8px 10px 8px 0", color: t.body }}>{m.attributeValueLabel}</td>
                    <td style={{ padding: "8px 10px 8px 0", color: t.body }}>{m.adjustmentType} {m.adjustmentValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      {/* Not Yet Mapped */}
      {unmapped.length > 0 && (
        <Section title={`Not Yet Mapped (${unmapped.length})`} icon="alert" isDark={isDark} defaultOpen>
          <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: t.dim }}>These discovered attribute values weren&apos;t assigned an adjustment in your prompt. They won&apos;t be priced unless you add a mapping below.</div>
            {[...unmappedByAttribute.entries()].map(([attrName, values]) => (
              <div key={attrName} style={{ fontSize: 12, color: t.body }}>
                <strong style={{ color: t.heading }}>{values[0].attributeLabel}</strong>: {values.map(v => v.valueLabel).join(", ")}
              </div>
            ))}

            {showAddForm && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${t.border}`, paddingTop: 10 }}>
                {unmapped.map(u => {
                  const key = draftKey(u);
                  const draft = drafts[key] ?? { adjustmentType: "Fixed Amount" as AttributePricingType, adjustmentValue: "" };
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, color: t.body, minWidth: 180 }}>{u.attributeLabel} — <strong>{u.valueLabel}</strong></span>
                      <select
                        value={draft.adjustmentType}
                        onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...draft, adjustmentType: e.target.value as AttributePricingType } }))}
                        style={{ ...inputStyle(t), width: 170, padding: "6px 8px" }}
                      >
                        {ADJUSTMENT_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                      <input
                        type="number"
                        value={draft.adjustmentValue}
                        onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...draft, adjustmentValue: e.target.value } }))}
                        placeholder="Amount"
                        style={{ ...inputStyle(t), width: 110, padding: "6px 8px" }}
                      />
                    </div>
                  );
                })}
                <div>
                  <PrimaryButton label="Apply Mappings" icon="check" isDark={isDark} onClick={applyDrafts} />
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <GhostButton label="Add Mappings for Remaining Values" icon="plus" isDark={isDark} onClick={() => setShowAddForm(v => !v)} />
              <GhostButton label="Ignore Remaining Values" icon="x" isDark={isDark} onClick={() => { setShowAddForm(false); setDrafts({}); onContinue(); }} />
              <PrimaryButton label="Continue with Mapped Values Only" icon="arrow-right" isDark={isDark} onClick={onContinue} />
            </div>
          </div>
        </Section>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, paddingTop: 4 }}>
        <GhostButton label="Start Over" icon="arrow-left" isDark={isDark} onClick={onStartOver} />
        {unmapped.length === 0 && <PrimaryButton label="Continue to Review" icon="arrow-right" isDark={isDark} onClick={onContinue} />}
      </div>
    </div>
  );
}

/* ── Step 8: final Review page ── */
function FinalReviewView({ isDark, review, onBack, onConfirm, onStartOver, autoFixPriceImpacting, onToggleAutoFixPriceImpacting }: {
  isDark: boolean;
  review: ReviewState;
  onBack: () => void;
  onConfirm: () => void;
  onStartOver: () => void;
  autoFixPriceImpacting: boolean;
  onToggleAutoFixPriceImpacting: (value: boolean) => void;
}) {
  const t = tokens(isDark);
  const { product, procedureName, attributes, existingSchedule, mappedEntries } = review;
  const priceImpactingCount = Math.max(attributes.length, 1);
  const conditionsEstimate = mappedEntries.length * priceImpactingCount;
  const canConfirm = mappedEntries.length > 0 || !!existingSchedule;

  function row(label: string, value: ReactNode) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${t.border}`, fontSize: 12.5 }}>
        <span style={{ color: t.dim, fontWeight: 600 }}>{label}</span>
        <span style={{ color: t.heading, textAlign: "right" }}>{value}</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.accent, fontWeight: 700, fontSize: 13.5 }}>
        <Ic n="list" s={16} /> Review before creating anything
      </div>
      <div style={{ fontSize: 12, color: t.dim }}>Nothing has been created in Salesforce yet. Confirm below to run the exact same creation workflow as the guided flow.</div>

      <div style={{ background: t.surfaceAlt, border: `1px solid ${t.border}`, borderRadius: 12, padding: "4px 14px" }}>
        {row("Product", product.name)}
        {row("List Price", product.basePrice != null ? formatCurrency(product.basePrice) : "Not found")}
        {row("Selling Model", product.sellingModelName || "—")}
        {row("Currency", product.currency)}
        {row("Lookup Table", "Bound at runtime via the Price Adjustment Schedule below — this org has no separate Lookup Table object for attribute pricing.")}
        {row("Price Adjustment Schedule", existingSchedule
          ? `Will reuse existing schedule (${existingSchedule.ruleCount} rule(s) already configured)`
          : mappedEntries.length > 0 ? "Will be created" : "Nothing to create — add at least one mapping or go back")}
        {row("Rules", existingSchedule && mappedEntries.length === 0 ? "Reusing existing — no new rules" : `${mappedEntries.length} (created or reused automatically)`)}
        {row("Conditions", existingSchedule && mappedEntries.length === 0 ? "Reusing existing" : `~${conditionsEstimate} (estimated; created or reused automatically)`)}
        {row("Adjustments", existingSchedule && mappedEntries.length === 0 ? "Reusing existing" : `${mappedEntries.length} (created or reused automatically)`)}
        {row("Pricing Procedure", procedureName)}
        {row("Expression Set", "Will be deployed and activated")}
      </div>

      {!canConfirm && (
        <div style={{ fontSize: 12, color: t.warn }}>Nothing is mapped and no existing pricing was found for this product — go back and add at least one mapping before confirming.</div>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim, cursor: "pointer" }} title="If an attribute isn't marked Price Impacting in Salesforce, automatically enable it (and verify the update) instead of stopping. Off by default — this can affect every other product/procedure sharing the same attribute.">
        <input type="checkbox" checked={autoFixPriceImpacting} onChange={e => onToggleAutoFixPriceImpacting(e.target.checked)} />
        Auto-Fix Price Impacting
      </label>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <GhostButton label="Start Over" icon="arrow-left" isDark={isDark} onClick={onStartOver} />
          <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} />
        </div>
        <PrimaryButton label="Confirm & Create" icon="check" isDark={isDark} disabled={!canConfirm} onClick={onConfirm} />
      </div>
    </div>
  );
}

/* ── Steps 9-12: creation progress (identical to the guided flow) + Runtime Verification ── */
function CreationView({ isDark, review, creating, createResult, createFailure, createNetworkError, verifying, verifyResult, liveSteps, attributePreview, onBackToReview, onStartOver }: {
  isDark: boolean;
  review: ReviewState;
  creating: boolean;
  createResult: SalesforceCreationResult | null;
  createFailure: CreateProcedureFailure | null;
  createNetworkError: string | null;
  verifying: boolean;
  verifyResult: VerifyExecutionResult | null;
  liveSteps: LiveSteps;
  attributePreview: { product2Id: string; sellingModelId: string; priceAdjustmentScheduleId: string | null; attributes: AttributePreviewEntry[] } | null;
  onBackToReview: () => void;
  onStartOver: () => void;
}) {
  const t = tokens(isDark);

  // Reuses the guided flow's own progress computation/rendering for "exactly matching" parity —
  // built from a synthetic form/attributeData shaped the same way the guided flow's would be.
  const syntheticForm: ProcedureFormData = {
    ...emptyProcedureForm(),
    productId: review.product.id,
    sellingModelId: review.product.sellingModelId,
    basePrice: review.product.basePrice != null ? String(review.product.basePrice) : "",
    attributeEntries: review.mappedEntries.map(m => ({
      id: `${m.attributeName}-${m.attributeValue}`, attributeName: m.attributeName, attributeLabel: m.attributeLabel,
      attributeValue: m.attributeValue, attributeValueLabel: m.attributeValueLabel,
      pricingType: m.adjustmentType as AttributePricingType, adjustmentValue: String(m.adjustmentValue),
    })),
  };
  const syntheticAttributeData: ProductAttributeData = {
    product: { ...review.product },
    attributes: [],
    totalAttributes: review.attributes.length,
  };

  if (createNetworkError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ErrorPanel isDark={isDark} error={{ title: "Autopilot couldn't reach Salesforce", message: createNetworkError }} />
        <div style={{ display: "flex", gap: 8 }}>
          <GhostButton label="Back to Review" icon="arrow-left" isDark={isDark} onClick={onBackToReview} />
          <GhostButton label="Start Over" icon="x" isDark={isDark} onClick={onStartOver} />
        </div>
      </div>
    );
  }

  const failed = createResult && !createResult.success;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {attributePreview && (
        <AttributePreviewPanel
          isDark={isDark}
          product2Id={attributePreview.product2Id}
          sellingModelId={attributePreview.sellingModelId}
          priceAdjustmentScheduleId={attributePreview.priceAdjustmentScheduleId}
          attributes={attributePreview.attributes}
        />
      )}

      <DeploymentProgressPanel
        isDark={isDark}
        items={computeDeploymentSteps({ form: syntheticForm, attributeData: syntheticAttributeData, creating, createResult, createFailure, verifying, verifyResult, liveSteps })}
      />

      {failed && <FriendlyFailurePanel isDark={isDark} createResult={createResult} createFailure={createFailure} />}

      {/* §5 — Autopilot previously showed ONLY the friendly one-line translation above, which has no
          rendering branch for Deploy Metadata's rich diagnostics (componentFailures/full deploy status/
          generated XML/downloadable ZIP) — they were captured correctly server-side but never reached
          this screen. Reusing the exact same panel the guided flow already renders, so every diagnostic
          field (schema report, packaging report, native create failure, deploy component failures, raw
          deploy status, generated XML, ZIP download) shows up here too, not just the friendly summary. */}
      {failed && <CreateProcedureFailurePanel isDark={isDark} failure={createFailure} fallbackMessage={!createFailure ? createResult.error ?? null : null} attrNative={createResult.attrNative ?? null} />}

      {createResult?.success && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#22C55E", fontSize: 13.5, fontWeight: 700 }}>
              <Ic n="check-circle" s={18} /> Deployed and activated
            </div>
            {createResult.procedureId && salesforceRecordUrl(createResult.procedureId) && (
              <a href={salesforceRecordUrl(createResult.procedureId)!} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: `1px solid ${t.border}`, color: t.body, fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
                <Ic n="check" s={12} /> Open in Salesforce
              </a>
            )}
          </div>

          {createResult.warnings.length > 0 && (
            <Section title="Warnings" icon="alert" isDark={isDark} defaultOpen={false}>
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {createResult.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</div>)}
              </div>
            </Section>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        {failed && <GhostButton label="Back to Review" icon="arrow-left" isDark={isDark} onClick={onBackToReview} />}
        {(createResult?.success || failed) && <GhostButton label="Start Over" icon="x" isDark={isDark} onClick={onStartOver} />}
      </div>
    </div>
  );
}

/** §Never expose internal payload errors — a friendly translation of the create-procedure failure, not the raw diagnostic. */
function FriendlyFailurePanel({ isDark, createResult, createFailure }: { isDark: boolean; createResult: SalesforceCreationResult; createFailure: CreateProcedureFailure | null }) {
  const t = tokens(isDark);
  if (createResult.validationError) {
    return <ErrorPanel isDark={isDark} error={{ title: "Nothing to create yet", message: createResult.error ?? "No pricing was configured, and none already existed for this product." }} />;
  }
  if (!createFailure) {
    return <ErrorPanel isDark={isDark} error={{ title: "Autopilot stopped", message: "Something prevented Autopilot from finishing. Nothing was created." }} />;
  }
  const friendly = buildFriendlyStopMessage(createFailure);
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${t.error}55`, background: isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.error, fontWeight: 700, fontSize: 13.5 }}>
        <Ic n="alert" s={16} /> {friendly.title}
      </div>
      <div style={{ fontSize: 12.5, color: t.body, whiteSpace: "pre-wrap" }}>{friendly.message}</div>
      <div style={{ fontSize: 12, color: t.dim, borderTop: `1px solid ${t.border}`, paddingTop: 8 }}><strong style={{ color: t.body }}>What to check: </strong>{friendly.guidance}</div>
    </div>
  );
}
