"use client";

/**
 * Volume-Based Pricing — AI-guided create flow. Mirrors BundleBasedPricingCreate.tsx's exact structure
 * (prompt card + Prompt Guide + example prompts, stage-switch analysis result area, editable tier-rows
 * table, live creation progress, failure/summary panels), plus two pieces this pricing type has that its
 * siblings don't:
 *   - A tiered-rows form (add/remove/edit) backed by VolumeTier[] — the user can start from an AI
 *     extraction OR just edit tiers directly with no prompt at all.
 *   - A manual runtime-verification panel: this pricing type has NO automated backend simulation call
 *     (Salesforce's own Simulate UI is the only way to execute a VolumeDiscount BKM), so after deploy this
 *     shows exact manual steps, plus a paste-and-analyze static RCA panel (analyzeSimulation.ts) for the
 *     JSON that Simulate returns.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Ic, tokens, Section, Pill, PrimaryButton, GhostButton, EmptyState, Spinner, Field, inputStyle, formatCurrency } from "./shared";
import { ExecutionLogPanel } from "./CreationAuditPanels";
import { loadSession } from "@/lib/auth/session";
import { buildVolumePricingSalesforceRecords, type SalesforceRecordLink } from "@/lib/pricing-rules/volume-based/create/salesforceRecordLinks";
import { analyzeSimulation, type RcaFinding } from "@/lib/pricing-rules/volume-based/rca/analyzeSimulation";
import type {
  VolumeBasedAnalysisResult, ExtractedVolumePricingRequirement, ProcedureStepLite, ProductCandidate,
  VolumeTier, TierType, DiscoveredProduct,
} from "@/lib/pricing-rules/volume-based/types";
import type { CreateVolumePricingResult, CreateStreamEvent } from "@/lib/pricing-rules/volume-based/create/types";

const PIPELINE_STEPS = ["Prompt", "Identify Product", "Verify Product exists in Salesforce", "Validate Tiers", "Build Pricing Procedure"];

const REQUIRED_GROUPS: { heading: string; points: string[] }[] = [
  { heading: "Required", points: [
    "The name of the existing product being priced — it must already exist in Salesforce.",
    "At least one quantity tier (From Qty / To Qty / Discount Type / Value) — every unit gets the rate of the band the total quantity falls in.",
  ] },
];
const RECOMMENDED_GROUPS: { heading: string; points: string[] }[] = [
  { heading: "Recommended", points: [
    "State the quantity bands explicitly (e.g. \"1-99: no discount, 100-499: 10% off, 500+: 20% off\").",
    "State whether a tier's value is a percentage off, a fixed dollar amount off, or a final override price.",
  ] },
];
const OPTIONAL_ITEMS = ["Base price", "Effective date range", "Currency"];

const EXAMPLE_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Percentage volume discount",
    prompt: "Create a volume-based pricing procedure for \"Enterprise Widget\". 1-99 units: no discount. 100-499 units: 10% off. 500+ units: 20% off — every unit gets the rate for the band the total quantity falls in.",
  },
  {
    label: "Override price tiers",
    prompt: "For \"Bulk Cable Spool\", set the unit price to $45 for orders of 50-199, $38 for 200-499, and $30 for 500 or more.",
  },
];

const PROMPT_PLACEHOLDER = "Describe the product and volume/quantity discount bands you need in plain English...";

const TIER_TYPES: { value: TierType; label: string }[] = [
  { value: "Percentage", label: "Percentage (%)" },
  { value: "Amount", label: "Fixed Amount ($)" },
  { value: "Override", label: "Price Override" },
];

function tierValueSuffix(type: TierType): string {
  return type === "Percentage" ? "%" : type === "Amount" ? "$" : "=$";
}

function textareaStyle(t: ReturnType<typeof tokens>): CSSProperties {
  return { width: "100%", minHeight: 150, padding: "10px 12px", borderRadius: 12, border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.heading, fontSize: 13.5, fontFamily: "inherit", resize: "vertical" };
}

function defaultTiers(): VolumeTier[] {
  return [
    { lowerBound: 1, upperBound: 99, tierType: "Percentage", tierValue: 0 },
    { lowerBound: 100, upperBound: null, tierType: "Percentage", tierValue: 10 },
  ];
}

async function postAnalyze(body: unknown): Promise<{ ok: true; result: VolumeBasedAnalysisResult } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/pricing-rules/volume-based/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !json?.stage) return { ok: false, error: json?.error ?? `Request failed (HTTP ${res.status})` };
    return { ok: true, result: json as VolumeBasedAnalysisResult };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error — could not reach the server." };
  }
}

async function postCreateStream(body: unknown, onStep: (event: { step: string; status: string; detail?: string }) => void): Promise<CreateVolumePricingResult> {
  const res = await fetch("/api/pricing-rules/volume-based/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json?.error ?? `Request failed (HTTP ${res.status})`);
  }
  if (!res.body) throw new Error("The server returned a streaming response with no body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: CreateVolumePricingResult | null = null;

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

/* ── Tier editor ── */

function TierEditor({
  isDark, tiers, onTierChange, onAddTier, onRemoveTier,
}: {
  isDark: boolean; tiers: VolumeTier[];
  onTierChange: (index: number, field: keyof VolumeTier, value: string | number | null) => void;
  onAddTier: () => void;
  onRemoveTier: (index: number) => void;
}) {
  const t = tokens(isDark);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12, color: t.dim }}>Range method — discount applies to all units when threshold is met.</div>
      {tiers.length === 0 ? (
        <EmptyState isDark={isDark} icon="layers" title="No tiers defined yet" hint="Add a tier or use the AI prompt to generate them automatically." />
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${t.border}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: t.surfaceAlt }}>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>From Qty</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>To Qty</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Discount Type</th>
                <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, textTransform: "uppercase", color: t.dim }}>Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                  <td style={{ padding: "6px 8px" }}>
                    <input type="number" min={1} value={tier.lowerBound} onChange={e => onTierChange(i, "lowerBound", Number(e.target.value))} style={{ ...inputStyle(t), width: 90 }} />
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <input
                      type="number" min={1} value={tier.upperBound ?? ""} placeholder="Unlimited"
                      onChange={e => onTierChange(i, "upperBound", e.target.value === "" ? null : Number(e.target.value))}
                      style={{ ...inputStyle(t), width: 100 }}
                    />
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <select value={tier.tierType} onChange={e => onTierChange(i, "tierType", e.target.value)} style={{ ...inputStyle(t), width: 160 }}>
                      {TIER_TYPES.map(tt => <option key={tt.value} value={tt.value}>{tt.label}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="number" value={tier.tierValue} onChange={e => onTierChange(i, "tierValue", Number(e.target.value))} style={{ ...inputStyle(t), width: 90 }} />
                      <span style={{ fontSize: 12, color: t.dim }}>{tierValueSuffix(tier.tierType)}</span>
                    </div>
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <GhostButton label="Remove" icon="x" isDark={isDark} onClick={() => onRemoveTier(i)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <GhostButton label="Add Tier" icon="plus" isDark={isDark} onClick={onAddTier} />
        <span style={{ fontSize: 11.5, color: t.dim }}>{tiers.length} tier(s) defined. Maps to {tiers.length} PriceAdjustmentTier record(s) in Salesforce.</span>
      </div>
    </div>
  );
}

/* ── RCA panel ── */

const SEVERITY_COLOR: Record<RcaFinding["severity"], string> = { critical: "#FF4066", warning: "#F59E0B", info: "#3AABFF" };

function RcaAnalyzerPanel({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [raw, setRaw] = useState("");
  const [findings, setFindings] = useState<RcaFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    try {
      const parsed = JSON.parse(raw);
      setFindings(analyzeSimulation(parsed));
    } catch (err) {
      setFindings(null);
      setError(err instanceof Error ? `Invalid JSON — ${err.message}` : "Invalid JSON.");
    }
  }

  return (
    <Section title="Runtime Verification — Paste Simulation JSON" icon="activity" isDark={isDark} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
        <div style={{ fontSize: 12, color: t.dim }}>
          This pricing type has no automated backend simulation call — run Salesforce&apos;s own Simulate action for this
          procedure (Revenue Cloud → Pricing Procedures → select the procedure → Simulate) and paste its full JSON
          response below for a static root-cause analysis.
        </div>
        <textarea value={raw} onChange={e => setRaw(e.target.value)} placeholder="Paste the full Simulate response JSON here…" style={{ ...textareaStyle(t), minHeight: 120, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 }} />
        <div>
          <PrimaryButton label="Analyze" icon="zap" isDark={isDark} disabled={!raw.trim()} onClick={run} />
        </div>
        {error && <div style={{ color: t.error, fontSize: 12.5 }}>{error}</div>}
        {findings && (
          findings.length === 0 ? (
            <div style={{ color: "#22c55e", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}><Ic n="check-circle" s={14} /> No issues found.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {findings.map((f, i) => (
                <div key={i} style={{ border: `1px solid ${SEVERITY_COLOR[f.severity]}50`, background: isDark ? `${SEVERITY_COLOR[f.severity]}12` : `${SEVERITY_COLOR[f.severity]}0c`, borderRadius: 10, padding: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <Pill label={f.severity.toUpperCase()} color={SEVERITY_COLOR[f.severity]} isDark={isDark} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: t.heading }}>{f.title}</span>
                    <span style={{ fontSize: 11, color: t.dim }}>({f.step})</span>
                  </div>
                  <div style={{ fontSize: 12, color: t.body, marginBottom: 4 }}>{f.detail}</div>
                  <div style={{ fontSize: 11.5, color: t.dim }}><strong style={{ color: t.body }}>Recommendation: </strong>{f.recommendation}</div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </Section>
  );
}

/* ── Post-deploy manual verification instructions ── */

function ManualVerificationSteps({ isDark, result }: { isDark: boolean; result: CreateVolumePricingResult }) {
  const t = tokens(isDark);
  if (!result.priceAdjustmentScheduleId) return null;
  return (
    <Section title="Manual Runtime Verification (Required)" icon="alert" isDark={isDark} defaultOpen>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8, fontSize: 12.5, color: t.body }}>
        <div>
          <strong style={{ color: t.heading }}>Step 1 — Refresh the Decision Table.</strong> Go to Salesforce Setup → Decision
          Tables → find &quot;Volume Discount Entries&quot; → click Refresh (or Refresh Dataset). Without this the BKM reads
          stale data and always returns <code>adjustments: []</code>.
        </div>
        <div>
          <strong style={{ color: t.heading }}>Step 2 — Run the simulation with the right context.</strong> Open Revenue Cloud
          → Pricing Procedures → select &quot;{result.expressionSetApiName}&quot; → Simulate. In the SalesTransaction context
          variable, find PriceAdjustmentSchedule and paste ONLY:
          <div style={{ fontFamily: "monospace", fontSize: 12, background: t.surfaceAlt, borderRadius: 6, padding: "4px 8px", margin: "4px 0", display: "inline-block" }}>{result.priceAdjustmentScheduleId}</div>
          (copied from the Price Adjustment Schedule Id above). Do NOT paste the procedure name or any other text.
        </div>
        <div>
          <strong style={{ color: t.heading }}>Step 3 — Set a matching quantity and run.</strong> Set LineItemQuantity to a
          value inside one of the configured tier ranges, then click Simulate. The <code>adjustments</code> array should
          now be non-empty and NetUnitPrice should change.
        </div>
        <div style={{ fontSize: 11.5, color: t.dim }}>{result.tiersCreated ?? 0} PriceAdjustmentTier record(s) created.</div>
      </div>
    </Section>
  );
}

/* ── Creation summary/progress (mirrors bundle-based's own) ── */

function ComponentStatusLine({ label, deployed, verified, id, error }: { label: string; deployed: boolean; verified: boolean; id: string | null; error?: string }) {
  return (
    <div style={{ fontSize: 12 }}>
      {deployed ? "✓" : "✕"} {label} deployed — {verified ? "✓" : "⚠"} verified via read-back{id ? ` (${id})` : ""}{error ? ` — ${error}` : ""}
    </div>
  );
}

function CreationFailurePanel({ isDark, result }: { isDark: boolean; result: CreateVolumePricingResult }) {
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
      {(result.priceAdjustmentScheduleId || (result.tierIds?.length ?? 0) > 0) && (
        <div style={{ fontSize: 11.5, color: t.dim }}>
          Preserved for debugging — Schedule: {result.priceAdjustmentScheduleId ?? "(none)"}, Tiers: {result.tierIds?.length ?? 0}.
        </div>
      )}
    </WarnPanel>
  );
}

function SalesforceRecordsSection({ isDark, records }: { isDark: boolean; records: SalesforceRecordLink[] }) {
  return (
    <Section title="Salesforce Records" icon="external-link" isDark={isDark} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {records.map(r => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "6px 0" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span>{r.label}{typeof r.count === "number" ? ` (${r.count})` : ""}</span>
              {r.name && <span style={{ fontSize: 11 }}>{r.name}</span>}
            </div>
            <GhostButton label={r.actionLabel} isDark={isDark} disabled={!r.url} onClick={() => r.url && window.open(r.url, "_blank")} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function CreationSummary({ isDark, result }: { isDark: boolean; result: CreateVolumePricingResult }) {
  const t = tokens(isDark);
  const session = loadSession();
  const records = buildVolumePricingSalesforceRecords(session?.instanceUrl ?? null, {
    expressionSetId: result.expressionSetId, expressionSetApiName: result.expressionSetApiName, expressionSetVersionId: result.expressionSetVersionId,
    versionStatus: result.versionStatus, priceAdjustmentScheduleId: result.priceAdjustmentScheduleId,
    tierCount: result.tierIds?.length, verification: result.verification,
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: result.status === "success" ? "#22c55e" : t.warn }}>
        <Ic n={result.status === "success" ? "check-circle" : "alert"} s={18} />
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{result.status === "success" ? "Volume-Based Pricing Created" : "Volume-Based Pricing Created (with Verification Warning)"}</span>
      </div>
      {result.verificationWarning && <div style={{ fontSize: 12.5, color: t.warn }}>{result.verificationWarning}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: t.body }}>
        <div>Product: {result.product?.name}</div>
        <div>Pricing Procedure: {result.expressionSetApiName}</div>
        <div>Expression Set: {result.expressionSetId ?? "—"}</div>
        <div>Expression Set Version: {result.expressionSetVersionId ?? "—"} ({result.versionStatus})</div>
        <div>Price Adjustment Schedule: {result.priceAdjustmentScheduleId ?? "—"} (AdjustmentMethod: {result.resolvedAdjustmentMethod ?? "—"}, Active: {result.scheduleActivated ? "Yes" : "No"})</div>
        <div>Tiers Created: {result.tierIds?.length ?? 0}</div>
      </div>
      {(result.canvasSteps?.length ?? 0) > 0 && (
        <Section title="Canvas Step Mapping" icon="layers" isDark={isDark} defaultOpen={false}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {result.canvasSteps!.map(s => (
              <div key={s.seq} style={{ fontSize: 12, color: t.body }}>
                <strong style={{ color: t.heading }}>{s.seq}. {s.label}</strong> ({s.actionType}) — {s.description}
              </div>
            ))}
          </div>
        </Section>
      )}
      {(result.warnings?.length ?? 0) > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {result.warnings.map((w, i) => <li key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</li>)}
        </ul>
      )}
      <ManualVerificationSteps isDark={isDark} result={result} />
      <SalesforceRecordsSection isDark={isDark} records={records} />
    </div>
  );
}

const PART_STEPS: { label: string; steps: string[] }[] = [
  { label: "Pre-Flight Validation", steps: ["preflight"] },
  { label: "Create Price Adjustment Schedule", steps: ["create-schedule"] },
  { label: "Create Price Adjustment Tiers", steps: ["create-tiers"] },
  { label: "Verify Native Records", steps: ["verify-native-records"] },
  { label: "Refresh Tier Decision Table Entries", steps: ["refresh-tier-entries"] },
  { label: "Build & Validate Expression Set", steps: ["build-expression-set", "validate-expression-set"] },
  { label: "Deploy Pricing Procedure", steps: ["deploy-pricing-procedure"] },
  { label: "Activate Version", steps: ["activate-version"] },
  { label: "Activate Schedule", steps: ["activate-schedule"] },
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
  createResult: CreateVolumePricingResult | null; createRequestError: string | null;
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

/* ── Analysis result stages ── */

interface AnalysisCallbacks {
  onSelectProduct: (candidate: ProductCandidate, extracted: ExtractedVolumePricingRequirement) => void;
  onConfirmCreate: (product: DiscoveredProduct, tiers: VolumeTier[], basePrice: number) => void;
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

function ResultStage({
  isDark, result, creating, createEvents, createResult, createRequestError,
  tiers, basePriceInput, onTierChange, onAddTier, onRemoveTier, onBasePriceChange, ...callbacks
}: {
  isDark: boolean; result: VolumeBasedAnalysisResult;
  creating: boolean; createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateVolumePricingResult | null; createRequestError: string | null;
  tiers: VolumeTier[]; basePriceInput: string;
  onTierChange: (index: number, field: keyof VolumeTier, value: string | number | null) => void;
  onAddTier: () => void; onRemoveTier: (index: number) => void; onBasePriceChange: (v: string) => void;
} & AnalysisCallbacks) {
  const t = tokens(isDark);
  const [reviewed, setReviewed] = useState(false);

  switch (result.stage) {
    case "ai-parse-failed":
    case "product-missing":
    case "salesforce-error":
      return <WarnPanel isDark={isDark} title={result.stage === "salesforce-error" ? "Salesforce Error" : "Couldn't Understand the Prompt"}>{result.error}</WarnPanel>;

    case "product-not-found":
      return (
        <WarnPanel isDark={isDark} title="Product Not Found">
          <div style={{ marginBottom: 8 }}>No product named &quot;{result.productName}&quot; was found.</div>
          {result.suggestions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {result.suggestions.map(c => <SuggestionButton key={c.id} label={c.name} onClick={() => callbacks.onSelectProduct(c, result.extracted)} />)}
            </div>
          )}
        </WarnPanel>
      );

    case "product-ambiguous":
      return (
        <WarnPanel isDark={isDark} title="Multiple Products Matched">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {result.matches.map(c => <SuggestionButton key={c.id} label={c.productCode ? `${c.name} (${c.productCode})` : c.name} onClick={() => callbacks.onSelectProduct(c, result.extracted)} />)}
          </div>
        </WarnPanel>
      );

    case "needs-tiers":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#22c55e" }}>
            <Ic n="check-circle" s={16} /> <span style={{ fontSize: 13.5, fontWeight: 600 }}>Product Found — {result.product.name}</span>
          </div>
          <div style={{ fontSize: 13, color: t.body }}>No volume tiers were extracted yet. Define them below or describe the quantity bands and resubmit your prompt.</div>
          <TierEditor isDark={isDark} tiers={tiers} onTierChange={onTierChange} onAddTier={onAddTier} onRemoveTier={onRemoveTier} />
          <Field label="Base Price ($)" isDark={isDark} required>
            <input type="number" value={basePriceInput} onChange={e => onBasePriceChange(e.target.value)} style={{ ...inputStyle(t), maxWidth: 200 }} />
          </Field>
          {tiers.length > 0 && (
            <PrimaryButton label="Review Pricing" icon="arrow-right" isDark={isDark} onClick={() => callbacks.onConfirmCreate(result.product, tiers, Number(basePriceInput) || 0)} />
          )}
        </div>
      );

    case "ready-for-review": {
      const confirmed = creating || !!createResult;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#22c55e" }}>
            <Ic n="check-circle" s={16} /> <span style={{ fontSize: 14, fontWeight: 700 }}>Volume tiers ready for review</span>
          </div>
          <div style={{ fontSize: 12.5, color: t.body }}>
            Product: {result.product.name} | Base Price: {formatCurrency(basePriceInput ? Number(basePriceInput) : result.basePrice)} | Currency: {result.extracted.currency ?? result.product.currency ?? "USD"}
          </div>
          <TierEditor isDark={isDark} tiers={tiers} onTierChange={onTierChange} onAddTier={onAddTier} onRemoveTier={onRemoveTier} />
          <Field label="Base Price ($)" isDark={isDark} required>
            <input type="number" value={basePriceInput} onChange={e => onBasePriceChange(e.target.value)} style={{ ...inputStyle(t), maxWidth: 200 }} />
          </Field>
          {result.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {result.warnings.map((w, i) => <li key={i} style={{ fontSize: 11.5, color: t.warn }}>{w}</li>)}
            </ul>
          )}
          {!reviewed && !confirmed && <PrimaryButton label="Next" icon="arrow-right" isDark={isDark} onClick={() => setReviewed(true)} disabled={tiers.length === 0} />}
          {(reviewed || confirmed) && (
            <div style={{ background: t.surfaceAlt, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12.5, color: t.body }}>{tiers.length} tier(s) will be created as PriceAdjustmentTier records under a new PriceAdjustmentSchedule (AdjustmentMethod=Range).</div>
              {!confirmed && (
                <PrimaryButton label="Create in Salesforce" icon="zap" isDark={isDark} onClick={() => callbacks.onConfirmCreate(result.product, tiers, Number(basePriceInput) || result.basePrice)} />
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

function AnalysisResultArea({
  isDark, loading, result, requestError, ...rest
}: {
  isDark: boolean; loading: boolean; result: VolumeBasedAnalysisResult | null; requestError: string | null;
  creating: boolean; createEvents: { step: string; status: string; detail?: string }[];
  createResult: CreateVolumePricingResult | null; createRequestError: string | null;
  tiers: VolumeTier[]; basePriceInput: string;
  onTierChange: (index: number, field: keyof VolumeTier, value: string | number | null) => void;
  onAddTier: () => void; onRemoveTier: (index: number) => void; onBasePriceChange: (v: string) => void;
} & AnalysisCallbacks) {
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 20 }}>
        <Spinner isDark={isDark} /> <span style={{ fontSize: 13 }}>Analyzing pricing requirement…</span>
      </div>
    );
  }
  if (requestError) return <WarnPanel isDark={isDark} title="Something went wrong">{requestError}</WarnPanel>;
  if (!result) return <EmptyState isDark={isDark} icon="sparkles" title="Validation results will appear here" hint="Describe a volume-based pricing requirement above and click Create Pricing Procedure." />;
  return (
    <div>
      <StepChecklist isDark={isDark} steps={result.steps} />
      <ResultStage isDark={isDark} result={result} {...rest} />
    </div>
  );
}

export default function VolumeBasedPricingCreate({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VolumeBasedAnalysisResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const [tiers, setTiers] = useState<VolumeTier[]>(defaultTiers());
  const [basePriceInput, setBasePriceInput] = useState("");

  const [creating, setCreating] = useState(false);
  const [createEvents, setCreateEvents] = useState<{ step: string; status: string; detail?: string }[]>([]);
  const [createResult, setCreateResult] = useState<CreateVolumePricingResult | null>(null);
  const [createRequestError, setCreateRequestError] = useState<string | null>(null);

  function resetAnalysis() {
    setResult(null); setRequestError(null);
    setCreating(false); setCreateEvents([]); setCreateResult(null); setCreateRequestError(null);
  }

  async function runAnalysis(body: unknown) {
    setLoading(true);
    setCreating(false); setCreateEvents([]); setCreateResult(null); setCreateRequestError(null);
    const res = await postAnalyze(body);
    setLoading(false);
    if (res.ok) {
      setResult(res.result);
      setRequestError(null);
      if (res.result.stage === "ready-for-review") {
        setTiers(res.result.tiers.length > 0 ? res.result.tiers : defaultTiers());
        setBasePriceInput(String(res.result.basePrice ?? ""));
      } else if (res.result.stage === "needs-tiers" && res.result.extracted.volumeTiers.length > 0) {
        setTiers(res.result.extracted.volumeTiers);
      }
    } else {
      setRequestError(res.error);
      setResult(null);
    }
  }

  function handleUseExample(example: { prompt: string }) { setPrompt(example.prompt); resetAnalysis(); }
  function handleClear() { setPrompt(""); setTiers(defaultTiers()); setBasePriceInput(""); resetAnalysis(); }
  function handleCreate() {
    if (!prompt.trim()) return;
    runAnalysis({ prompt });
  }
  function handleSelectProduct(candidate: ProductCandidate, extracted: ExtractedVolumePricingRequirement) {
    runAnalysis({ extracted, selectedProductId: candidate.id, tierOverrides: tiers });
  }

  function handleTierChange(index: number, field: keyof VolumeTier, value: string | number | null) {
    setTiers(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value } as VolumeTier;
      return next;
    });
  }
  function handleAddTier() {
    setTiers(prev => {
      const last = prev[prev.length - 1];
      const newLower = last ? (last.upperBound !== null ? last.upperBound + 1 : 1) : 1;
      const newTier: VolumeTier = { lowerBound: newLower, upperBound: null, tierType: "Percentage", tierValue: 0 };
      const updated = prev.map((tr, i) => (i === prev.length - 1 && tr.upperBound === null ? { ...tr, upperBound: newLower - 1 } : tr));
      return [...updated, newTier];
    });
  }
  function handleRemoveTier(index: number) {
    setTiers(prev => prev.filter((_, i) => i !== index));
  }

  async function handleConfirmCreate(product: DiscoveredProduct, confirmedTiers: VolumeTier[], basePrice: number) {
    setCreating(true);
    setCreateEvents([]);
    setCreateRequestError(null);
    const procedureName = `${product.name} Volume-Based Pricing Procedure`;
    try {
      const finalResult = await postCreateStream(
        { product: { id: product.id, name: product.name }, tiers: confirmedTiers, basePrice, procedureName, activate: true },
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
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="package" s={20} /></span>
          <span style={{ fontSize: 17, fontWeight: 700, color: t.heading }}>Create Volume-Based Pricing Procedure</span>
        </div>
        <div style={{ fontSize: 13, color: t.body, marginTop: 6 }}>
          Describe the product and quantity discount bands you need in plain English, or edit the tier rows directly.
          Every unit on the line gets the rate of the band the total quantity falls in (Range method) — the system will
          resolve the product, validate the tiers, and create the required pricing procedure.
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
          <div>• You don&apos;t need to know any Salesforce Ids — just name the product and the quantity bands.</div>
          <div>• The product must already exist in Salesforce — it is never invented.</div>
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
          tiers={tiers} basePriceInput={basePriceInput}
          onTierChange={handleTierChange} onAddTier={handleAddTier} onRemoveTier={handleRemoveTier} onBasePriceChange={setBasePriceInput}
          onSelectProduct={handleSelectProduct} onConfirmCreate={handleConfirmCreate}
        />
      </div>

      <RcaAnalyzerPanel isDark={isDark} />
    </div>
  );
}
