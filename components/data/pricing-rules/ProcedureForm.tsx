"use client";

import { tokens, Field, inputStyle, Section } from "./shared";
import ProductLookup, { type ProductLookupMatch } from "./ProductLookup";
import type { ProcedureFormData } from "@/lib/pricing-rules/types";

/**
 * §Reset — the Attribute-Based-only sections (Product Information / Base Price / Attribute Pricing
 * table / Deployment Validation Summary) have been removed along with the rest of that implementation.
 * This is now a plain shared shell — Procedure Details + a "not implemented yet" notice — used
 * identically by all four pricing types until a new implementation is built for one of them.
 */
export default function ProcedureForm({
  isDark,
  form,
  errors,
  onChange,
  onSelectProduct,
}: {
  isDark: boolean;
  form: ProcedureFormData;
  errors: Partial<Record<keyof ProcedureFormData, string>>;
  onChange: (field: keyof ProcedureFormData, value: string) => void;
  onSelectProduct?: (match: ProductLookupMatch) => void;
}) {
  const t = tokens(isDark);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Procedure Details" icon="sliders" isDark={isDark} defaultOpen>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <Field label="Procedure Name" isDark={isDark} required>
              <input value={form.procedureName} onChange={e => onChange("procedureName", e.target.value)} style={inputStyle(t)} placeholder="e.g. Widget Pro Pricing" />
              {errors.procedureName && <span style={{ color: t.error, fontSize: 11 }}>{errors.procedureName}</span>}
            </Field>
            <Field label="API Name" isDark={isDark} hint="Optional — auto-generated from the Procedure Name if left blank.">
              <input value={form.apiName} onChange={e => onChange("apiName", e.target.value)} style={inputStyle(t)} placeholder="e.g. Widget_Pro_Pricing" />
            </Field>
            <Field label="Product Name" isDark={isDark} required>
              <ProductLookup
                isDark={isDark}
                value={form.productName}
                onChange={value => onChange("productName", value)}
                onSelect={match => onSelectProduct?.(match)}
                placeholder="Search for a product…"
              />
              {errors.productName && <span style={{ color: t.error, fontSize: 11 }}>{errors.productName}</span>}
            </Field>
          </div>
          <Field label="Description" isDark={isDark}>
            <textarea value={form.description} onChange={e => onChange("description", e.target.value)} style={{ ...inputStyle(t), minHeight: 60, resize: "vertical" as const }} />
          </Field>
        </div>
      </Section>

      <Section title="Pricing Configuration" icon="info" isDark={isDark} defaultOpen>
        <div style={{ paddingTop: 10, fontSize: 12.5, color: t.dim }}>
          This pricing type&apos;s configuration builder isn&apos;t available yet in this build.
        </div>
      </Section>
    </div>
  );
}
