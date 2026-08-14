"use client";

import { Ic, tokens, Section } from "./shared";
import type { ProcedureFormData, ProductAttributeData } from "@/lib/pricing-rules/types";

type CheckStatus = "ok" | "warning" | "error";
interface CheckItem {
  label: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Pre-flight readiness checklist shown just above the "Create Procedure"
 * action — a quick professional-configuration-page-style summary of
 * whether everything the deploy engine needs is actually in place, so the
 * user isn't surprised by a validation error only after clicking Create.
 * Purely derived from existing form/discovery state — no new fetches.
 */
export default function DeploymentValidationSummary({
  isDark,
  form,
  attributeData,
}: {
  isDark: boolean;
  form: ProcedureFormData;
  attributeData?: ProductAttributeData | null;
}) {
  const t = tokens(isDark);
  const populatedCount = form.attributeEntries.filter(e => e.pricingType && e.adjustmentValue.trim()).length;

  const checks: CheckItem[] = [
    { label: "Procedure Name", status: form.procedureName.trim() ? "ok" : "error", detail: form.procedureName.trim() || "Not entered" },
    { label: "Product resolved in Salesforce", status: form.productId ? "ok" : "error", detail: form.productId ? form.productName : "Not found yet" },
    { label: "Selling Model resolved", status: form.sellingModelId ? "ok" : "error", detail: form.sellingModelId ? form.sellingModel : "Not resolved" },
    { label: "Standard Price retrieved", status: form.basePrice ? "ok" : "warning", detail: form.basePrice ? `$${form.basePrice}` : "No Standard Price Book entry found — optional" },
    { label: "Price-impacting attributes discovered", status: (attributeData?.totalAttributes ?? 0) > 0 ? "ok" : "warning", detail: attributeData ? `${attributeData.totalAttributes} found` : "Not discovered yet" },
    { label: "Attribute pricing configured", status: populatedCount > 0 ? "ok" : "error", detail: `${populatedCount} of ${form.attributeEntries.length} value(s) priced` },
  ];

  const colorFor = (status: CheckStatus) => (status === "ok" ? "#22C55E" : status === "warning" ? t.warn : t.error);

  return (
    <Section title="Deployment / Validation" icon="check-circle" isDark={isDark} defaultOpen>
      <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {checks.map((c, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
            <span style={{ color: colorFor(c.status), flexShrink: 0 }}><Ic n={c.status === "ok" ? "check-circle" : "alert"} s={14} /></span>
            <span style={{ color: t.heading, fontWeight: 600, minWidth: 260 }}>{c.label}</span>
            <span style={{ color: t.dim }}>{c.detail}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
