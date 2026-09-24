"use client";

/**
 * Bundle-Based Pricing — AI-guided create flow. Mirrors AttributeBasedPricingCreate.tsx's exact structure
 * (prompt card + Prompt Guide + example prompts, stage-switch analysis result area, per-component
 * adjustment grid, live creation progress, failure/summary panels) adapted for a CLOSED-WORLD component
 * model — components can never be invented, only matched against (or excluded from) the bundle's real
 * Salesforce structure.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Ic, tokens, Section, Pill, PrimaryButton, GhostButton, EmptyState, Spinner, formatCurrency } from "./shared";
import BundleMappingConfigurator, { type BundleAdjustmentOverridesPayload } from "./BundleMappingConfigurator";
import { ExecutionLogPanel } from "./CreationAuditPanels";
import { loadSession } from "@/lib/auth/session";
import { buildBundlePricingSalesforceRecords, type SalesforceRecordLink } from "@/lib/pricing-rules/bundle-based/create/salesforceRecordLinks";
import type {
  BundleBasedAnalysisResult, BundleBasedMappingOverrides, BundleCandidate, BundleComponentPlanRow,
  DiscoveredBundle, ExtractedBundlePricingRequirement, ProcedureStepLite,
} from "@/lib/pricing-rules/bundle-based/types";
import type { CreateBundlePricingResult, CreateStreamEvent } from "@/lib/pricing-rules/bundle-based/create/types";

const PIPELINE_STEPS = ["Prompt", "Identify Bundle", "Verify Bundle exists in Salesforce", "Discover Bundle Components", "Validate Prompt Components", "Validate Component Adjustments", "Build Pricing Rules"];

const REQUIRED_GROUPS: { heading: string; points: string[] }[] = [
  { heading: "Required", points: [
    "The name of the existing bundle (parent product) — it must already exist in Salesforce.",
    "At least one component to price, and an adjustment for it (a fixed amount, a percentage, or an override).",
  ] },
];
const RECOMMENDED_GROUPS: { heading: string; points: string[] }[] = [
  { heading: "Recommended", points: [
    "Name every component you want priced explicitly, rather than relying on defaults.",
    "State whether an adjustment is a fixed dollar amount, a percentage, or a final override price.",
  ] },
];
const OPTIONAL_ITEMS = ["Effective date range", "Selling model", "Bundle-level conditions or combination rules"];

const EXAMPLE_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Component fixed-amount adjustments",
    prompt: "Create a bundle-based pricing procedure for the existing bundle \"Laptop Basic Bundle\". Apply the following bundle-based adjustments: if Laptop is included, add $500. If Wireless Mouse is included, add $100. If Keyboard is included, add $150. Do not modify Product2 or PricebookEntry base prices.",
  },
  {
    label: "Percentage adjustment",
    prompt: "For the \"Server Rack Bundle\", increase the price by 8% whenever the Redundant Power Supply component is included.",
  },
];

const PROMPT_PLACEHOLDER = "Describe the bundle and bundle-based pricing logic you need in plain English...";

function textareaStyle(t: ReturnType<typeof tokens>): CSSProperties {
  return { width: "100%", minHeight: 150, padding: "10px 12px", borderRadius: 12, border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.heading, fontSize: 13.5, fontFamily: "inherit", resize: "vertical" };
}

function formatAdjustment(type: "fixed" | "percentage" | "override", amount: number): string {
  if (type === "percentage") return `+${amount}%`;
  if (type === "override") return formatCurrency(amount);
  return `+${formatCurrency(amount)}`;
}

async function postAnalyze(body: unknown): Promise<{ ok: true; result: BundleBasedAnalysisResult } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/pricing-rules/bundle-based/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json?.stage) return { ok: false, error: json?.error ?? `Request failed (HTTP ${res.status})` };
    return { ok: true, result: json as BundleBasedAnalysisResult };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error — could not reach the server." };
  }
}

async function postCreateStream(body: unknown, onStep: (event: { step: string; status: string; detail?: string }) => void): Promise<CreateBundlePricingResult> {
  const res = await fetch("/api/pricing-rules/bundle-based/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error("The server returned a streaming response with no body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: CreateBundlePricingResult | null = null;

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

function collapseSteps(steps: ProcedureStepLite[]): ProcedureStepLite[] {
  const order: string[] = [];
  const byName = new Map<string, ProcedureStepLite>();
  for (const s of steps) {
    if (!byName.has(s.step)) order.push(s.step);
    byName.set(s.step, s);
  }
  return order.map(name => byName.get(name)!);
}

function GuideTier({ label, color, isDark, children }: { label: string; color: string; isDark: boolean; children: ReactNode }) {
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
      <div style={{ fontSize: 12.5, fontWeight: 600, color: t.heading, marginBottom: 4 }}>{heading}</div>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {points.map((p, i) => <li key={i} style={{ fontSize: 12.5, color: t.body, marginBottom: 2 }}>{p}</li>)}
      </ul>
    </div>
  );
}

function ExistingBundleComponentsTable({ isDark, components }: { isDark: boolean; components: DiscoveredBundle["components"] }) {
  const t = tokens(isDark);
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${t.border}`, borderRadius: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: t.surfaceAlt }}>
            <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Component</th>
            <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Quantity</th>
            <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Required</th>
          </tr>
        </thead>
        <tbody>
          {components.map(c => (
            <tr key={c.productId} style={{ borderTop: `1px solid ${t.border}` }}>
              <td style={{ padding: "8px 12px", color: t.heading }}>{c.productName}{c.productCode ? ` (${c.productCode})` : ""}</td>
              <td style={{ padding: "8px 12px", color: t.body }}>{c.quantity ?? "—"}</td>
              <td style={{ padding: "8px 12px", color: t.body }}>{c.isComponentRequired === null ? "—" : c.isComponentRequired ? "Yes" : "Optional"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IgnoredComponentsNote({ isDark, ignoredComponents }: { isDark: boolean; ignoredComponents: string[] }) {
  const t = tokens(isDark);
  if (ignoredComponents.length === 0) return null;
  return (
    <div style={{ background: t.surfaceAlt, borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.heading, marginBottom: 4 }}>Excluded from pricing</div>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {ignoredComponents.map((c, i) => <li key={i} style={{ fontSize: 12, color: t.body }}>{c}</li>)}
      </ul>
    </div>
  );
}

function SuggestionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 999, border: "none", background: "linear-gradient(90deg, #00D4FF, #1E90FF)", color: "#04101F", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
      <Ic n="check" s={13} /> {label}
    </button>
  );
}

function WarnPanel({ isDark, title, children }: { isDark: boolean; title: string; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: t.warn, marginBottom: 8 }}>
        <Ic n="alert" s={16} /> <span style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</span>
      </div>
      <div style={{ fontSize: 13, color: t.body }}>{children}</div>
    </div>
  );
}

interface AnalysisCallbacks {
  onSelectBundle: (candidate: BundleCandidate, extracted: ExtractedBundlePricingRequirement) => void;
  onAcceptComponentMapping: (enteredName: string, mappedName: string, extracted: ExtractedBundlePricingRequirement) => void;
  onIgnoreComponent: (enteredName: string, extracted: ExtractedBundlePricingRequirement) => void;
  onSubmitAdjustments: (overrides: BundleAdjustmentOverridesPayload, extracted: ExtractedBundlePricingRequirement) => void;
  onConfirmCreate: (bundle: DiscoveredBundle, rules: BundleComponentPlanRow[], ignoredComponents: string[]) => void;
}

function SummaryRow({ label, items, icon, color, t }: { label: string; items: string[]; icon: string; color: string; t: ReturnType<typeof tokens> }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10.5, textTransform: "uppercase", color: t.dim, letterSpacing: 0.4 }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((it, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 8, background: t.surfaceAlt, color, fontSize: 12 }}>
            <Ic n={icon} s={12} /> {it}
          </span>
        ))}
      </div>
    </div>
  );
}

function ComponentStatusLine({ label, deployed, verified, id, error }: { label: string; deployed: boolean; verified: boolean; id: string | null; error?: string }) {
  return (
    <div style={{ fontSize: 12 }}>
      {deployed ? "✓" : "✕"} {label} deployed — {verified ? "✓" : "⚠"} verified via read-back{id ? ` (${id})` : ""}{error ? ` — ${error}` : ""}
    </div>
  );
}

function CreationFailurePanel({ isDark, result }: { isDark: boolean; result: CreateBundlePricingResult }) {
  const t = tokens(isDark);
  return (
    <WarnPanel isDark={isDark} title="Creation Stopped">
      <div style={{ marginBottom: 8 }}>{result.error}</div>
      {result.failure?.resolutionHint && <div style={{ marginBottom: 8, color: t.dim }}>{result.failure.resolutionHint}</div>}
      {result.verification && (
        <div style={{ background: t.surfaceAlt, borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <ComponentStatusLine label="Expression Set" deployed={result.verification.expressionSet.deployed} verified={result.verification.expressionSet.verified} id={result.verification.expressionSet.id} error={result.verification.expressionSet.error} />
          <ComponentStatusLine label="Expression Set Version" deployed={result.verification.expressionSetVersion.deployed} verified={result.verification.expressionSetVersion.verified} id={result.verification.expressionSetVersion.id} error={result.verification.expressionSetVersion.error} />
          <ComponentStatusLine label="Pricing Procedure" deployed={result.verification.pricingProcedure.deployed} verified={result.verification.pricingProcedure.verified} id={result.verification.pricingProcedure.id} error={result.verification.pricingProcedure.error} />
        </div>
      )}
      {(result.priceAdjustmentScheduleId || (result.ruleIds?.length ?? 0) > 0) && (
        <div style={{ fontSize: 11.5, color: t.dim }}>
          Preserved for debugging — Schedule: {result.priceAdjustmentScheduleId ?? "(none)"}, Rules: {result.ruleIds?.length ?? 0}, Conditions: {result.conditionIds?.length ?? 0}, Adjustments: {result.adjustmentIds?.length ?? 0}.
        </div>
      )}
    </WarnPanel>
  );
}

function SalesforceRecordsSection({ isDark, records }: { isDark: boolean; records: SalesforceRecordLink[] }) {
  const t = tokens(isDark);
  return (
    <Section title="Salesforce Records" icon="external-link" isDark={isDark} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {records.map(r => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "6px 0" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ color: t.heading }}>{r.label}{typeof r.count === "number" ? ` (${r.count})` : ""}</span>
              {r.name && <span style={{ color: t.dim, fontSize: 11 }}>{r.name}</span>}
            </div>
            <GhostButton label={r.actionLabel} isDark={isDark} disabled={!r.url} onClick={() => r.url && window.open(r.url, "_blank")} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function CreationSummary({ isDark, result }: { isDark: boolean; result: CreateBundlePricingResult }) {
  const t = tokens(isDark);
  const session = loadSession();
  const records = buildBundlePricingSalesforceRecords(session?.instanceUrl ?? null, {
    expressionSetId: result.expressionSetId, expressionSetApiName: result.expressionSetApiName, expressionSetVersionId: result.expressionSetVersionId,
    versionStatus: result.versionStatus, priceAdjustmentScheduleId: result.priceAdjustmentScheduleId,
    ruleCount: result.ruleIds?.length, conditionCount: result.conditionIds?.length, adjustmentCount: result.adjustmentIds?.length,
    verification: result.verification,
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: result.status === "success" ? "#22c55e" : t.warn }}>
        <Ic n={result.status === "success" ? "check-circle" : "alert"} s={18} />
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{result.status === "success" ? "Bundle-Based Pricing Created" : "Bundle-Based Pricing Created (with Verification Warning)"}</span>
      </div>
      {result.verificationWarning && <div style={{ fontSize: 12.5, color: t.warn }}>{result.verificationWarning}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: t.body }}>
        <div>Bundle: {result.bundle?.name}</div>
        <div>Pricing Procedure: {result.expressionSetApiName}</div>
        <div>Expression Set: {result.expressionSetId ?? "—"}</div>
        <div>Expression Set Version: {result.expressionSetVersionId ?? "—"} ({result.versionStatus})</div>
        <div>Price Adjustment Schedule: {result.priceAdjustmentScheduleId ?? "—"}</div>
        <div>Rules Created: {result.ruleIds?.length ?? 0}</div>
      </div>
      {(result.warnings?.length ?? 0) > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {result.warnings.map((w, i) => <li key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</li>)}
        </ul>
      )}
      <SalesforceRecordsSection isDark={isDark} records={records} />
    </div>
  );
}

const PART_STEPS: { label: string; steps: string[] }[] = [
  { label: "Pre-Flight Validation", steps: ["preflight"] },
  { label: "Resolve/Create Price Adjustment Schedule", steps: ["create-schedule"] },
  { label: "Create/Reuse Bundle-Based Adjustment Rules", steps: ["create-rule"] },
  { label: "Create/Reuse Bundle Adjustment Conditions", steps: ["create-condition"] },
  { label: "Create/Reuse Bundle-Based Adjustments", steps: ["create-adjustment"] },
  { label: "Verify Adjustment Records + Runtime Lookup", steps: ["verify-adjustment-records"] },
  { label: "Refresh Bundle Discount Entries", steps: ["refresh-bundle-discount-entries"] },
  { label: "Build & Validate Expression Set", steps: ["build-expression-set", "validate-expression-set"] },
  { label: "Deploy Pricing Procedure", steps: ["deploy-pricing-procedure"] },
  { label: "Activate", steps: ["activate-version"] },
  { label: "Verify Salesforce", steps: ["verify-salesforce"] },
];

type RowStatus = "pending" | "running" | "done" | "warning" | "failed";
function statusFromEvents(events: { step: string; status: string }[], names: string[]): RowStatus {
  const relevant = events.filter(e => names.includes(e.step));
  if (relevant.length === 0) return "pending";
  const last = relevant[relevant.length - 1];
  return (last.status as RowStatus) ?? "pending";
}
const STATUS_GLYPH: Record<RowStatus, string> = { pending: "○", running: "⏳", done: "✓", warning: "⚠", failed: "✕" };

function CreationProgress({ isDark, createEvents, createResult, createRequestError }: {
  isDark: boolean; createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateBundlePricingResult | null; createRequestError: string | null;
}) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {createResult?.executionId && <div style={{ fontFamily: "monospace", fontSize: 11, color: t.dim }}>{createResult.executionId}</div>}
      <div style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 10 }}>
        {PART_STEPS.map((row, i) => {
          const status = statusFromEvents(createEvents, row.steps);
          const detail = [...createEvents].reverse().find(e => row.steps.includes(e.step))?.detail;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", padding: "5px 0", borderTop: i === 0 ? "none" : `1px solid ${t.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span>{STATUS_GLYPH[status]}</span>
                <span style={{ color: t.body }}>{row.label}</span>
              </div>
              {detail && <div style={{ fontSize: 11, color: t.dim, paddingLeft: 22 }}>{detail}</div>}
            </div>
          );
        })}
      </div>
      {createRequestError && <WarnPanel isDark={isDark} title="Creation Failed">{createRequestError}</WarnPanel>}
      {createResult && !createResult.success && <CreationFailurePanel isDark={isDark} result={createResult} />}
      {createResult?.success && <CreationSummary isDark={isDark} result={createResult} />}
      <ExecutionLogPanel isDark={isDark} analyzeSteps={[]} createSteps={createResult?.steps ?? []} />
    </div>
  );
}

function ResultStage({
  isDark, result, creating, createEvents, createResult, createRequestError, ...callbacks
}: {
  isDark: boolean; result: BundleBasedAnalysisResult;
  creating: boolean; createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateBundlePricingResult | null; createRequestError: string | null;
} & AnalysisCallbacks) {
  const t = tokens(isDark);
  const [reviewed, setReviewed] = useState(false);

  switch (result.stage) {
    case "ai-parse-failed":
    case "bundle-missing":
    case "salesforce-error":
      return <WarnPanel isDark={isDark} title={result.stage === "salesforce-error" ? "Salesforce Error" : "Couldn't Understand the Prompt"}>{result.error}</WarnPanel>;

    case "bundle-not-found":
      return (
        <WarnPanel isDark={isDark} title="Bundle Not Found">
          <div style={{ marginBottom: 8 }}>No bundle named &quot;{result.bundleName}&quot; was found.</div>
          {result.suggestions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {result.suggestions.map(c => <SuggestionButton key={c.id} label={c.name} onClick={() => callbacks.onSelectBundle(c, result.extracted)} />)}
            </div>
          )}
        </WarnPanel>
      );

    case "bundle-ambiguous":
      return (
        <WarnPanel isDark={isDark} title="Multiple Bundles Matched">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {result.matches.map(c => <SuggestionButton key={c.id} label={c.productCode ? `${c.name} (${c.productCode})` : c.name} onClick={() => callbacks.onSelectBundle(c, result.extracted)} />)}
          </div>
        </WarnPanel>
      );

    case "not-a-bundle":
      return (
        <WarnPanel isDark={isDark} title="Not a Configured Bundle">
          &quot;{result.bundle.name}&quot; was found, but no bundle components could be discovered for it in Salesforce (checked ProductRelatedComponent, ProductRelationship, ProductComponent, and ProductComponentGroup). Configure its component structure in Salesforce first.
        </WarnPanel>
      );

    case "component-mismatch":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <WarnPanel isDark={isDark} title="Component Mismatch">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {result.mismatch.missingComponents.map(name => {
                const suggestion = result.mismatch.suggestions.find(s => s.enteredName === name);
                return (
                  <div key={name}>
                    <div style={{ marginBottom: 6 }}>
                      &quot;{name}&quot; was requested by the pricing rule but was not found in the resolved Salesforce bundle structure for &quot;{result.bundle.name}&quot;.
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {suggestion?.suggestedName && (
                        <SuggestionButton label={`Map to ${suggestion.suggestedName}`} onClick={() => callbacks.onAcceptComponentMapping(name, suggestion.suggestedName!, result.extracted)} />
                      )}
                      {!suggestion?.suggestedName && (suggestion?.alternatives.length ?? 0) > 0 && suggestion!.alternatives.map(alt => (
                        <SuggestionButton key={alt} label={`Map to ${alt}`} onClick={() => callbacks.onAcceptComponentMapping(name, alt, result.extracted)} />
                      ))}
                      <GhostButton label="Ignore" isDark={isDark} onClick={() => callbacks.onIgnoreComponent(name, result.extracted)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </WarnPanel>
          <IgnoredComponentsNote isDark={isDark} ignoredComponents={result.ignoredComponents} />
          <ExistingBundleComponentsTable isDark={isDark} components={result.mismatch.availableComponents} />
        </div>
      );

    case "needs-adjustment-values":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#22c55e" }}>
            <Ic n="check-circle" s={16} /> <span style={{ fontSize: 13.5, fontWeight: 600 }}>Bundle Found — {result.bundle.name}</span>
          </div>
          <ExistingBundleComponentsTable isDark={isDark} components={result.bundle.components} />
          <IgnoredComponentsNote isDark={isDark} ignoredComponents={result.ignoredComponents} />
          <BundleMappingConfigurator isDark={isDark} rows={result.rows} submitting={false} onNext={overrides => callbacks.onSubmitAdjustments(overrides, result.extracted)} />
        </div>
      );

    case "components-awaiting-pricing":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#22c55e" }}>
            <Ic n="check-circle" s={16} /> <span style={{ fontSize: 13.5, fontWeight: 600 }}>Bundle Found — {result.bundle.name}</span>
          </div>
          <ExistingBundleComponentsTable isDark={isDark} components={result.bundle.components} />
          <div style={{ fontSize: 13, color: t.body }}>
            No components were named for pricing yet. Describe which component(s) should get a price adjustment and resubmit your prompt.
          </div>
        </div>
      );

    case "ready-for-review": {
      const currency = result.extracted.currency ?? "USD";
      const existingToReuse = result.rules.filter(r => r.stated);
      const componentNames = [...new Set(result.rules.map(r => r.componentName))];
      const confirmed = creating || !!createResult;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#22c55e" }}>
            <Ic n="check-circle" s={16} /> <span style={{ fontSize: 14, fontWeight: 700 }}>Pricing rules ready for review</span>
          </div>
          <div style={{ fontSize: 12.5, color: t.body }}>
            Bundle: {result.bundle.name} | Base Bundle Price: {result.bundle.basePrice !== null ? formatCurrency(result.bundle.basePrice) : "(configured pricing)"} | Currency: {currency}
            {result.extracted.effectiveFrom && ` | From: ${result.extracted.effectiveFrom}`}
            {result.extracted.effectiveTo && ` | To: ${result.extracted.effectiveTo}`}
          </div>
          <ExistingBundleComponentsTable isDark={isDark} components={result.bundle.components} />
          <div style={{ overflowX: "auto", border: `1px solid ${t.border}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: t.surfaceAlt }}>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Component</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Adjustment Type</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Adjustment</th>
                </tr>
              </thead>
              <tbody>
                {result.rules.map(r => (
                  <tr key={r.componentProductId} style={{ borderTop: `1px solid ${t.border}`, opacity: r.stated ? 1 : 0.55 }}>
                    <td style={{ padding: "8px 12px", color: t.heading }}>{r.componentName}{!r.stated && " (no adjustment stated — defaults to $0)"}</td>
                    <td style={{ padding: "8px 12px", color: t.body }}>{r.adjustmentType}</td>
                    <td style={{ padding: "8px 12px", color: t.body }}>{formatAdjustment(r.adjustmentType, r.adjustment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {result.warnings.map((w, i) => <li key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</li>)}
            </ul>
          )}
          {!reviewed && !confirmed && <PrimaryButton label="Next" icon="arrow-right" isDark={isDark} onClick={() => setReviewed(true)} />}
          {(reviewed || confirmed) && (
            <div style={{ background: t.surfaceAlt, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <SummaryRow label="Components" items={componentNames} icon="package" color={t.accent} t={t} />
              <SummaryRow label="Priced components" items={existingToReuse.map(r => `${r.componentName} ${formatAdjustment(r.adjustmentType, r.adjustment)}`)} icon="check-circle" color="#22c55e" t={t} />
              <SummaryRow label="Excluded" items={result.ignoredComponents} icon="x" color={t.dim} t={t} />
              <div style={{ fontSize: 12.5, color: t.body }}>Pricing Rules: {result.rules.length} row(s) ({existingToReuse.length} priced)</div>
              {!confirmed && (
                <PrimaryButton label="Create in Salesforce" icon="zap" isDark={isDark} onClick={() => callbacks.onConfirmCreate(result.bundle, result.rules, result.ignoredComponents)} />
              )}
              {confirmed && <CreationProgress isDark={isDark} createEvents={createEvents} createResult={createResult} createRequestError={createRequestError} />}
              {!confirmed && <div style={{ fontSize: 11, color: t.dim }}>Nothing has been created in Salesforce yet.</div>}
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

function StepChecklist({ isDark, steps }: { isDark: boolean; steps: ProcedureStepLite[] }) {
  const t = tokens(isDark);
  const collapsed = collapseSteps(steps);
  if (collapsed.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 10, marginBottom: 10, borderBottom: `1px solid ${t.border}` }}>
      {collapsed.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.body }}>
          <Ic n={s.status === "error" ? "alert" : s.status === "success" ? "check" : "info"} s={13} />
          {s.message}
        </div>
      ))}
    </div>
  );
}

function AnalysisResultArea({
  isDark, loading, result, requestError, ...rest
}: {
  isDark: boolean; loading: boolean; result: BundleBasedAnalysisResult | null; requestError: string | null;
  creating: boolean; createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateBundlePricingResult | null; createRequestError: string | null;
} & AnalysisCallbacks) {
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 20 }}>
        <Spinner isDark={isDark} /> <span style={{ fontSize: 13 }}>Analyzing pricing requirement…</span>
      </div>
    );
  }
  if (requestError) return <WarnPanel isDark={isDark} title="Something went wrong">{requestError}</WarnPanel>;
  if (!result) return <EmptyState isDark={isDark} icon="sparkles" title="Validation results will appear here" hint="Describe a bundle-based pricing requirement above and click Create Pricing Procedure." />;
  return (
    <div>
      <StepChecklist isDark={isDark} steps={result.steps} />
      <ResultStage isDark={isDark} result={result} {...rest} />
    </div>
  );
}

export default function BundleBasedPricingCreate({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BundleBasedAnalysisResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mappings, setMappings] = useState<BundleBasedMappingOverrides>({});

  const [creating, setCreating] = useState(false);
  const [createEvents, setCreateEvents] = useState<{ step: string; status: string; detail?: string }[]>([]);
  const [createResult, setCreateResult] = useState<CreateBundlePricingResult | null>(null);
  const [createRequestError, setCreateRequestError] = useState<string | null>(null);

  function resetAnalysis() {
    setResult(null); setRequestError(null); setMappings({});
    setCreating(false); setCreateEvents([]); setCreateResult(null); setCreateRequestError(null);
  }

  async function runAnalysis(body: unknown) {
    setLoading(true);
    setCreating(false); setCreateEvents([]); setCreateResult(null); setCreateRequestError(null);
    const res = await postAnalyze(body);
    setLoading(false);
    if (res.ok) { setResult(res.result); setRequestError(null); } else { setRequestError(res.error); setResult(null); }
  }

  function handleUseExample(example: { prompt: string }) { setPrompt(example.prompt); resetAnalysis(); }
  function handleClear() { setPrompt(""); resetAnalysis(); }
  function handleCreate() {
    if (!prompt.trim()) return;
    setMappings({});
    runAnalysis({ prompt });
  }
  function handleSelectBundle(candidate: BundleCandidate, extracted: ExtractedBundlePricingRequirement) {
    runAnalysis({ extracted, selectedBundleId: candidate.id, overrides: mappings });
  }
  function handleAcceptComponentMapping(enteredName: string, mappedName: string, extracted: ExtractedBundlePricingRequirement) {
    const next = { ...mappings, componentNameMappings: { ...mappings.componentNameMappings, [enteredName]: mappedName } };
    setMappings(next);
    runAnalysis({ extracted, overrides: next });
  }
  function handleIgnoreComponent(enteredName: string, extracted: ExtractedBundlePricingRequirement) {
    const next = { ...mappings, ignoredComponents: [...new Set([...(mappings.ignoredComponents ?? []), enteredName])] };
    setMappings(next);
    runAnalysis({ extracted, overrides: next });
  }
  function handleSubmitAdjustments(overrides: BundleAdjustmentOverridesPayload, extracted: ExtractedBundlePricingRequirement) {
    const next = { ...mappings, adjustmentOverrides: { ...mappings.adjustmentOverrides, ...overrides.adjustmentOverrides } };
    setMappings(next);
    runAnalysis({ extracted, overrides: next });
  }
  async function handleConfirmCreate(bundle: DiscoveredBundle, rules: BundleComponentPlanRow[], ignoredComponents: string[]) {
    setCreating(true);
    setCreateEvents([]);
    setCreateRequestError(null);
    const procedureName = `${bundle.name} Bundle-Based Pricing Procedure`;
    try {
      const finalResult = await postCreateStream(
        { bundle, rules, ignoredComponents, procedureName, activate: true },
        event => setCreateEvents(prev => [...prev, event]),
      );
      setCreateResult(finalResult);
    } catch (err) {
      setCreateRequestError(err instanceof Error ? err.message : "Network error while creating this pricing procedure.");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="cube" s={20} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: t.heading }}>Create Bundle-Based Pricing Procedure</span>
        </div>
        <div style={{ fontSize: 13, color: t.body, marginTop: 6 }}>
          Describe the bundle and bundle-based pricing logic you need in plain English. The system will identify the bundle, resolve its components, validate the bundle structure and pricing configuration against Salesforce, and create the required pricing procedure.
        </div>
      </div>

      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: t.heading }}>Describe this pricing procedure</div>
        <textarea
          value={prompt}
          onChange={e => { setPrompt(e.target.value); resetAnalysis(); }}
          placeholder={PROMPT_PLACEHOLDER}
          style={textareaStyle(t)}
        />

        <Section title="Prompt Guide" icon="info" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {PIPELINE_STEPS.map((s, i) => (
              <span key={i} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: t.surfaceAlt, color: t.dim }}>{i + 1}. {s}</span>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <GuideTier label="Required" color={t.accent} isDark={isDark}>
              {REQUIRED_GROUPS.map((g, i) => <GuideGroup key={i} heading={g.heading} points={g.points} t={t} />)}
            </GuideTier>
            <GuideTier label="Recommended" color={t.accentBlue} isDark={isDark}>
              {RECOMMENDED_GROUPS.map((g, i) => <GuideGroup key={i} heading={g.heading} points={g.points} t={t} />)}
            </GuideTier>
            <GuideTier label="Optional" color={t.dim} isDark={isDark}>
              <GuideGroup heading="Optional" points={OPTIONAL_ITEMS} t={t} />
            </GuideTier>
          </div>
        </Section>

        <div style={{ background: t.surfaceAlt, borderRadius: 10, padding: 12, fontSize: 12, color: t.body }}>
          <div>• You don&apos;t need to know any Salesforce Ids — just name the bundle and its components.</div>
          <div>• The bundle must already exist and have real components configured in Salesforce — components are never invented.</div>
        </div>

        <Section title="Example Prompts" icon="list" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <div key={i} style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: t.heading }}>{ex.label}</div>
                <div style={{ fontSize: 11.5, color: t.dim }}>{ex.prompt}</div>
                <GhostButton label="Use This Example" isDark={isDark} onClick={() => handleUseExample(ex)} />
              </div>
            ))}
          </div>
        </Section>

        <div style={{ display: "flex", gap: 8 }}>
          <PrimaryButton label={loading ? "Analyzing…" : "Create Pricing Procedure"} icon="zap" isDark={isDark} disabled={!prompt.trim() || loading} onClick={handleCreate} />
          <GhostButton label="Clear" isDark={isDark} disabled={!prompt || loading} onClick={handleClear} />
        </div>
      </div>

      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18, minHeight: 140 }}>
        <AnalysisResultArea
          isDark={isDark} loading={loading} result={result} requestError={requestError}
          creating={creating} createEvents={createEvents} createResult={createResult} createRequestError={createRequestError}
          onSelectBundle={handleSelectBundle} onAcceptComponentMapping={handleAcceptComponentMapping}
          onIgnoreComponent={handleIgnoreComponent} onSubmitAdjustments={handleSubmitAdjustments} onConfirmCreate={handleConfirmCreate}
        />
      </div>
    </div>
  );
}
