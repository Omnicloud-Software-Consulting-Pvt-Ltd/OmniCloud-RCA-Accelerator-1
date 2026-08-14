"use client";

import { Ic, tokens, Section, Spinner } from "./shared";
import type {
  ProcedureFormData,
  ProductAttributeData,
  SalesforceCreationResult,
  CreateProcedureFailure,
  VerifyExecutionResult,
} from "@/lib/pricing-rules/types";

export type DeployItemStatus = "pending" | "active" | "done" | "warning" | "failed" | "skipped";
export interface DeployItem {
  label: string;
  status: DeployItemStatus;
  detail?: string;
}

/** §Sequential Workflow — one entry per checklist row that has ever received a live NDJSON event from
 * the streaming create-procedure endpoint (see app/api/pricing-rules/create-procedure/route.ts and
 * lib/pricing-rules/types.ts's CreateProcedureStreamEvent), keyed by the row's own `label` below. A row
 * with no entry here has never started — it stays "pending" (or whatever its pre-deployment fallback
 * state is) regardless of what else has happened, which is exactly what makes "only ever one Running
 * row at a time" true in the UI: nothing here is inferred/animated, every transition is a real backend
 * event. */
export type LiveSteps = Record<string, { status: "running" | "done" | "failed"; detail?: string }>;

/** A row driven by `liveSteps` when an event for it has arrived; otherwise falls back to `computeFallback` — used for the pre-deployment "still pending" state and as a safety net if a network hiccup ever drops an event (the final `createResult` still resolves the correct end state in that case). */
function liveOrFallback(
  liveSteps: LiveSteps | undefined,
  label: string,
  computeFallback: () => { status: DeployItemStatus; detail?: string },
): { status: DeployItemStatus; detail?: string } {
  const live = liveSteps?.[label];
  if (!live) return computeFallback();
  if (live.status === "running") return { status: "active", detail: live.detail };
  if (live.status === "failed") return { status: "failed", detail: live.detail };
  // "done" — prefer the fallback's richer, final-result-derived detail (counts/Ids/Created vs. Reused)
  // once it's available; the plain live detail is only shown in the brief window before it is.
  const fallback = computeFallback();
  return { status: "done", detail: fallback.detail ?? live.detail };
}

/**
 * §3 — every checklist item here reflects real, already-known state or a
 * real server response; nothing is a simulated/fake animation. The first
 * four items are true the moment product discovery already completed
 * (before Create Procedure was even clicked); items 5-11 resolve the
 * instant the single create-procedure response arrives (this backend
 * doesn't stream incremental progress, so they collectively show a single
 * "active" spinner while the request is in flight, then resolve all at
 * once from the real returned steps/attrNative); item 12 is genuinely
 * live since verify-execution is a separate real network call the client
 * awaits after creation succeeds.
 */
const CANONICAL_FAILURE_ORDER = [
  "Product Lookup",
  "Fetch Selling Model",
  "Retrieve Template Expression Set",
  "Build Expression Set XML",
  "Validate XML",
  "Deploy Metadata",
  "Create Price Adjustment Schedule",
];

function classifyAgainstFailure(stageNames: string[], failureStep: string): "done" | "failed" | "pending" {
  if (stageNames.includes(failureStep)) return "failed";
  const failureIdx = CANONICAL_FAILURE_ORDER.indexOf(failureStep);
  const itemIdx = Math.min(...stageNames.map(s => CANONICAL_FAILURE_ORDER.indexOf(s)).filter(i => i >= 0));
  return itemIdx >= 0 && failureIdx >= 0 && itemIdx < failureIdx ? "done" : "pending";
}

function bulkStatus(stageNames: string[], failureStep: string | undefined, succeeded: boolean, creating: boolean): DeployItemStatus {
  if (failureStep) return classifyAgainstFailure(stageNames, failureStep);
  if (succeeded) return "done";
  if (creating) return "active";
  return "pending";
}

export function computeDeploymentSteps(args: {
  form: ProcedureFormData;
  attributeData: ProductAttributeData | null;
  creating: boolean;
  createResult: SalesforceCreationResult | null;
  createFailure: CreateProcedureFailure | null;
  verifying: boolean;
  verifyResult: VerifyExecutionResult | null;
  /** §Sequential Workflow — live per-row events from the streaming create-procedure response. Optional
   * so any other caller of this function keeps working exactly as before; omitting it just means every
   * row below 4 falls back to the old bulk/end-of-run classification. */
  liveSteps?: LiveSteps;
}): DeployItem[] {
  const { form, attributeData, creating, createResult, createFailure, verifying, verifyResult, liveSteps } = args;
  const failureStep = createFailure?.step;
  const succeeded = !!createResult?.success;
  const hasEntries = form.attributeEntries.some(e => e.pricingType && e.adjustmentValue.trim());
  const attrNative = createResult?.attrNative;

  const items: DeployItem[] = [];

  // §1-4 — already true from client-side discovery before Create Procedure was even clicked; a live
  // event only ever arrives here to report the backend's own defense-in-depth re-validation FAILING
  // (rare — e.g. the product was deleted mid-session), flipping an already-"done" row to "failed".
  const productLive = liveSteps?.["Product Found"];
  items.push({
    label: "Product Found",
    status: productLive?.status === "failed" ? "failed" : (form.productId ? "done" : "pending"),
    detail: productLive?.status === "failed" ? productLive.detail : (form.productId ? form.productName : undefined),
  });
  const sellingModelLive = liveSteps?.["Selling Model Retrieved"];
  items.push({
    label: "Selling Model Retrieved",
    status: sellingModelLive?.status === "failed" ? "failed" : (form.sellingModelId ? "done" : "pending"),
    detail: sellingModelLive?.status === "failed" ? sellingModelLive.detail : (form.sellingModelId ? form.sellingModel : undefined),
  });
  items.push({
    label: "Base Price Retrieved",
    status: form.basePrice ? "done" : attributeData ? "warning" : "pending",
    detail: form.basePrice ? `$${form.basePrice}` : attributeData ? "No Standard Price Book entry found" : undefined,
  });
  const attributesLive = liveSteps?.["Attributes Retrieved"];
  items.push({
    label: "Attributes Retrieved",
    status: attributesLive?.status === "failed" ? "failed" : (attributeData ? "done" : "pending"),
    detail: attributesLive?.status === "failed" ? attributesLive.detail : (attributeData ? `${attributeData.totalAttributes} found` : undefined),
  });

  // §6 — "✓ Created" vs "✓ Reused" per object, straight off the Final Execution Report
  // (nativeAttributeRecords.ts's CREATED/REUSED/SKIPPED/FAILED tracking) rather than a generic count —
  // a duplicate-business-key match is a successful reuse, never shown as if something failed.
  function outcomeLabel(status: "CREATED" | "REUSED" | "SKIPPED" | "FAILED" | undefined): string | undefined {
    return status === "REUSED" ? "Reused" : status === "CREATED" ? "Created" : undefined;
  }
  function withOutcomeLabel(label: string | undefined, detail: string): string {
    return label ? `${label} — ${detail}` : detail;
  }

  // §5-8 (real backend execution order: native records are created BEFORE the Expression Set is
  // generated/deployed — see create-procedure/route.ts's own comment on why that order is kept as-is).
  const pasFallback = () => ({
    status: (failureStep
      ? classifyAgainstFailure(["Create Price Adjustment Schedule"], failureStep)
      : succeeded
        ? (attrNative ? (attrNative.scheduleId ? "done" : "warning") : "skipped")
        : creating ? "active" : "pending") as DeployItemStatus,
    detail: attrNative?.scheduleId
      ? withOutcomeLabel(outcomeLabel(attrNative.executionReport?.priceAdjustmentSchedule.status), attrNative.scheduleId)
      : (succeeded && !attrNative ? "No attribute entries submitted" : undefined),
  });
  const pas = liveOrFallback(liveSteps, "Price Adjustment Schedule Created", pasFallback);
  items.push({ label: "Price Adjustment Schedule Created", status: pas.status, detail: pas.detail });

  function nativeCountStatus(count: number | undefined): DeployItemStatus {
    // Rules/Conditions/Adjustments only ever run after PAS creation succeeds — any failure
    // anywhere in the pipeline (including PAS itself) means these never started.
    if (failureStep) return "pending";
    if (!succeeded) return creating ? "active" : "pending";
    if (!attrNative) return "skipped";
    return (count ?? 0) > 0 ? "done" : hasEntries ? "warning" : "skipped";
  }

  // §9 — the actual Salesforce Id for every created record, not just a count, appended to each
  // item's detail so the end-of-run summary names exactly what was created.
  const idList = (ids: string[]) => (ids.length > 0 ? ` (${ids.join(", ")})` : "");
  const rules = liveOrFallback(liveSteps, "Attribute Rules Created", () => ({
    status: nativeCountStatus(attrNative?.rulesCreated),
    detail: attrNative ? withOutcomeLabel(outcomeLabel(attrNative.executionReport?.attributeBasedAdjRule.status), `${attrNative.rulesCreated} created, ${attrNative.rulesSkipped} skipped${idList(attrNative.ruleIds)}`) : undefined,
  }));
  items.push({ label: "Attribute Rules Created", status: rules.status, detail: rules.detail });

  const conditions = liveOrFallback(liveSteps, "Attribute Conditions Created", () => ({
    status: nativeCountStatus(attrNative?.conditionsCreated),
    detail: attrNative ? withOutcomeLabel(outcomeLabel(attrNative.executionReport?.attributeAdjustmentCondition.status), `${attrNative.conditionsCreated} created${idList(attrNative.conditionIds)}`) : undefined,
  }));
  items.push({ label: "Attribute Conditions Created", status: conditions.status, detail: conditions.detail });

  const adjustments = liveOrFallback(liveSteps, "Attribute Adjustments Created", () => ({
    status: nativeCountStatus(attrNative?.abasCreated),
    detail: attrNative ? withOutcomeLabel(outcomeLabel(attrNative.executionReport?.attributeBasedAdjustment.status), `${attrNative.abasCreated} created, ${attrNative.abasSkipped} skipped${idList(attrNative.abaIds)}`) : undefined,
  }));
  items.push({ label: "Attribute Adjustments Created", status: adjustments.status, detail: adjustments.detail });

  // §9-10. Expression Set Generation (Template Retrieved / XML Generated) + Metadata Deployed.
  const template = liveOrFallback(liveSteps, "Template Retrieved", () => ({
    status: bulkStatus(["Retrieve Template Expression Set"], failureStep, succeeded, creating),
  }));
  items.push({ label: "Template Retrieved", status: template.status, detail: template.detail });

  const xml = liveOrFallback(liveSteps, "XML Generated", () => ({
    status: bulkStatus(["Build Expression Set XML", "Validate XML"], failureStep, succeeded, creating),
  }));
  items.push({ label: "XML Generated", status: xml.status, detail: xml.detail });

  const deploy = liveOrFallback(liveSteps, "Metadata Deployed", () => ({
    status: bulkStatus(["Deploy Metadata"], failureStep, succeeded, creating),
  }));
  items.push({ label: "Metadata Deployed", status: deploy.status, detail: deploy.detail });

  // §12. Runtime Verification.
  const verify = liveOrFallback(liveSteps, "Runtime Verification Completed", () => {
    if (verifying) return { status: "active" as DeployItemStatus };
    if (verifyResult) {
      return {
        status: (verifyResult.success ? "done" : "warning") as DeployItemStatus,
        detail: verifyResult.executionReport.blocker?.reason ?? (verifyResult.success ? "Pricing engine confirmed a discount" : undefined),
      };
    }
    if (succeeded && (!hasEntries || !attrNative)) return { status: "skipped" as DeployItemStatus, detail: "No attribute pricing entries to simulate" };
    if (succeeded) return { status: "active" as DeployItemStatus };
    return { status: "pending" as DeployItemStatus };
  });
  items.push({ label: "Runtime Verification Completed", status: verify.status, detail: verify.detail });

  return items;
}

const DONE_COLOR = "#22C55E";

function StatusIcon({ status, isDark }: { status: DeployItemStatus; isDark: boolean }) {
  const t = tokens(isDark);
  if (status === "active") return <Spinner isDark={isDark} size={13} />;
  if (status === "done") return <span style={{ color: DONE_COLOR }}><Ic n="check-circle" s={15} /></span>;
  if (status === "failed") return <span style={{ color: t.error }}><Ic n="alert" s={15} /></span>;
  if (status === "warning") return <span style={{ color: t.warn }}><Ic n="alert" s={15} /></span>;
  if (status === "skipped") return <span style={{ color: t.dim }}><Ic n="x" s={13} /></span>;
  return <span style={{ color: t.dim, opacity: 0.4 }}><Ic n="clock" s={14} /></span>;
}

export default function DeploymentProgressPanel({ isDark, items }: { isDark: boolean; items: DeployItem[] }) {
  const t = tokens(isDark);
  return (
    <Section title="Deployment Progress" icon="activity" isDark={isDark} defaultOpen>
      <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              display: "flex", alignItems: "center", gap: 10, fontSize: 12.5,
              padding: item.status === "failed" ? "6px 8px" : undefined,
              borderRadius: item.status === "failed" ? 8 : undefined,
              background: item.status === "failed" ? (isDark ? "rgba(255,64,102,0.1)" : "rgba(255,64,102,0.08)") : undefined,
            }}
          >
            <StatusIcon status={item.status} isDark={isDark} />
            <span style={{ color: item.status === "pending" ? t.dim : t.heading, fontWeight: item.status === "failed" ? 700 : 500 }}>{item.label}</span>
            {item.detail && <span style={{ color: t.dim, fontSize: 11.5 }}>— {item.detail}</span>}
          </div>
        ))}
      </div>
    </Section>
  );
}
