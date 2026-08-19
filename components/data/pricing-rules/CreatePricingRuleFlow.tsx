"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, FooterBar, PrimaryButton, GhostButton } from "./shared";
import ProcedureForm from "./ProcedureForm";
import AttributeBasedPricingCreate from "./AttributeBasedPricingCreate";
import type { ProductLookupMatch } from "./ProductLookup";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import {
  emptyProcedureForm,
  PRICING_TYPE_LABELS,
  IMPLEMENTED_PRICING_TYPES,
  type ProcedureFormData,
  type PricingType,
  type SalesforceCreationResult,
} from "@/lib/pricing-rules/types";

const PRICING_TYPE_ICONS: Record<PricingType, string> = {
  "tier-based": "layers",
  "volume-based": "package",
  "attribute-based": "sliders",
  "bundle-based": "cube",
};

async function postJson<T>(url: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error ?? `Request failed (HTTP ${res.status})`) as Error & { status?: number; payload?: unknown };
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * §Reset — the Attribute-Based Pricing implementation (Pricing Autopilot, AI prompt parsing, product
 * attribute discovery, native PriceAdjustmentSchedule/Rule/Condition/Adjustment creation, Expression Set
 * XML generation, Metadata API deploy, live deployment progress, Attribute JSON Preview, runtime
 * verification) has been completely removed to make way for a new implementation. This is now a
 * generic shell shared by all four pricing types — `create-procedure` currently returns
 * `notImplemented: true` for every `pricingType`, so nothing here is pricing-type-specific anymore.
 */
export default function CreatePricingRuleFlow({
  isDark,
  onDone,
  lockedPricingType,
  onBack,
}: {
  isDark: boolean;
  onDone?: () => void;
  /** When set, the type-selector step is skipped entirely and the form starts pre-locked to this type — used by the dedicated /pricing-rules/create/[type] routes. */
  lockedPricingType?: PricingType;
  /** Where the form step's "Back" button goes when `lockedPricingType` is set (there's no select-type step to fall back to). */
  onBack?: () => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();

  const [step, setStep] = useState<"select-type" | "form" | "success">(lockedPricingType ? "form" : "select-type");
  const [form, setForm] = useState<ProcedureFormData>(() =>
    lockedPricingType ? { ...emptyProcedureForm(), pricingType: lockedPricingType } : emptyProcedureForm(),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof ProcedureFormData, string>>>({});

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<SalesforceCreationResult | null>(null);

  function updateForm(field: keyof ProcedureFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function selectPricingType(pricingType: PricingType) {
    setForm(prev => ({ ...emptyProcedureForm(), procedureName: prev.procedureName, productName: prev.productName, pricingType }));
    setErrors({});
    setStep("form");
  }

  function handleProductSelect(match: ProductLookupMatch) {
    setForm(prev => ({ ...prev, productName: match.name, productId: match.id, productCode: match.productCode ?? "" }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof ProcedureFormData, string>> = {};
    if (!form.procedureName.trim()) next.procedureName = "Procedure name is required";
    if (!form.productName.trim()) next.productName = "Product name is required";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleCreate() {
    if (!validate()) return;

    setCreating(true);
    setCreateError(null);
    try {
      const payload = {
        procedureName: form.procedureName,
        apiName: form.apiName,
        description: form.description,
        productName: form.productName,
        pricingType: form.pricingType,
        productId: form.productId,
        productCode: form.productCode,
      };
      const result = await postJson<SalesforceCreationResult>("/api/pricing-rules/create-procedure", { payload });
      if (result.success) {
        setCreateResult(result);
        setStep("success");

        const instanceUrl = loadSession()?.instanceUrl;
        if (instanceUrl && result.procedureId) {
          const record = toCreatedSalesforceRecord(instanceUrl, "ExpressionSet", result.procedureId, result.apiName ?? result.procedureId);
          notifySalesforceSuccess({
            title: "Pricing Procedure Created Successfully",
            message: `${record.recordName} has been successfully created in Salesforce.`,
            records: [record],
          });
        }
      } else {
        setCreateError(result.error || "Failed to create pricing procedure.");
      }
    } catch (err) {
      const e = err as Error & { payload?: SalesforceCreationResult };
      setCreateError(e.payload?.error || e.message || "Failed to create pricing procedure.");
    } finally {
      setCreating(false);
    }
  }

  function handleReset() {
    setForm(lockedPricingType ? { ...emptyProcedureForm(), pricingType: lockedPricingType } : emptyProcedureForm());
    setErrors({});
    setCreateResult(null);
    setCreateError(null);
    setStep(lockedPricingType ? "form" : "select-type");
  }

  /* ── Render ── */
  if (step === "select-type") {
    return (
      <PageShell>
        <div style={{ padding: "28px clamp(16px, 4vw, 56px)", maxWidth: 1560, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: t.heading }}>Create Pricing Rule</div>
            <div style={{ fontSize: 12.5, color: t.dim, marginTop: 4 }}>Choose a pricing type to get started.</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {(Object.keys(PRICING_TYPE_LABELS) as PricingType[]).map(pt => {
              const implemented = IMPLEMENTED_PRICING_TYPES.includes(pt);
              const isAttributeBased = pt === "attribute-based";
              return (
                <button
                  key={pt}
                  onClick={() => selectPricingType(pt)}
                  style={{
                    textAlign: "left", padding: 16, borderRadius: 14, cursor: "pointer",
                    background: t.surface, border: `1px solid ${t.border}`, color: t.heading,
                    display: "flex", flexDirection: "column", gap: 8, position: "relative",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.accent }}>
                    <Ic n={PRICING_TYPE_ICONS[pt]} s={18} />
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{PRICING_TYPE_LABELS[pt]}</span>
                  </div>
                  <span style={{ fontSize: 11.5, color: t.dim }}>
                    {isAttributeBased
                      ? "Describe your pricing in plain English — Salesforce automation is coming in the next phase."
                      : implemented
                        ? "Deploys a real Salesforce Expression Set."
                        : "Coming soon — form only, not yet deployable."}
                  </span>
                  {isAttributeBased ? (
                    <span style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 700, color: t.accent, background: isDark ? "rgba(0,212,255,0.12)" : "rgba(0,212,255,0.1)", border: `1px solid ${t.accent}50`, borderRadius: 999, padding: "2px 8px" }}>
                      AI-Guided
                    </span>
                  ) : !implemented && (
                    <span style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 700, color: t.warn, background: isDark ? "rgba(245,158,11,0.12)" : "rgba(245,158,11,0.1)", border: `1px solid ${t.warn}50`, borderRadius: 999, padding: "2px 8px" }}>
                      Coming Soon
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PageShell>
    );
  }

  if (step === "success" && createResult) {
    return (
      <PageShell footer={<FooterBar isDark={isDark}><GhostButton label="Create Another" icon="plus" isDark={isDark} onClick={handleReset} /><PrimaryButton label="Done" isDark={isDark} onClick={() => onDone?.()} /></FooterBar>}>
        <div style={{ padding: "28px clamp(16px, 4vw, 56px)", display: "flex", flexDirection: "column", gap: 14, maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#22C55E", fontSize: 16, fontWeight: 700 }}>
              <Ic n="check-circle" s={20} /> Pricing procedure created
            </div>
            {createResult.procedureId && salesforceRecordUrl(createResult.procedureId) && (
              <a
                href={salesforceRecordUrl(createResult.procedureId)!}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1px solid ${t.border}`, color: t.body, fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}
              >
                <Ic n="external-link" s={13} /> Open in Salesforce
              </a>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: t.body }}>
            <strong style={{ color: t.heading }}>Procedure Name:</strong> {form.procedureName}
          </div>
        </div>
      </PageShell>
    );
  }

  const isAttributeBasedForm = form.pricingType === "attribute-based";
  const backButton = <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={() => (lockedPricingType ? onBack?.() : setStep("select-type"))} />;

  // §Attribute-Based Pricing — its own AI-prompt-driven creation surface (see
  // AttributeBasedPricingCreate.tsx) rather than the generic name/product form
  // the other (still unimplemented) pricing types use. It owns its own inline
  // "Create Pricing Procedure"/"Clear" actions, so the shared footer here only
  // needs Back.
  if (isAttributeBasedForm) {
    return (
      <PageShell footer={<FooterBar isDark={isDark}>{backButton}</FooterBar>}>
        <div style={{ padding: "28px clamp(16px, 4vw, 56px)", maxWidth: 1000, margin: "0 auto", width: "100%" }}>
          <AttributeBasedPricingCreate isDark={isDark} />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      footer={
        <FooterBar isDark={isDark}>
          {backButton}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {createError && <span style={{ color: t.error, fontSize: 11.5 }}>{createError}</span>}
            <PrimaryButton label={creating ? "Creating…" : "Create Procedure"} icon="check" isDark={isDark} disabled={creating} onClick={handleCreate} />
          </div>
        </FooterBar>
      }
    >
      <div style={{ padding: "28px clamp(16px, 4vw, 56px)", maxWidth: 1560, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n={PRICING_TYPE_ICONS[form.pricingType as PricingType]} s={18} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, color: t.heading }}>{PRICING_TYPE_LABELS[form.pricingType as PricingType]} Pricing</span>
        </div>

        <ProcedureForm isDark={isDark} form={form} errors={errors} onChange={updateForm} onSelectProduct={handleProductSelect} />
      </div>
    </PageShell>
  );
}
