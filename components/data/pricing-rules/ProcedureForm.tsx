"use client";

import { Ic, tokens, Field, inputStyle, Section, Spinner } from "./shared";
import ProductInfoStrip from "./ProductInfoStrip";
import ProductLookup, { type ProductLookupMatch } from "./ProductLookup";
import AttributeEntriesSection from "./AttributeEntriesSection";
import DeploymentValidationSummary from "./DeploymentValidationSummary";
import type { AttributePricingEntry, ProcedureFormData, ProductAttributeData } from "@/lib/pricing-rules/types";

export default function ProcedureForm({
  isDark,
  form,
  errors,
  onChange,
  attributeData,
  isFetchingAttributes,
  attributeError,
  onProductNameChange,
  onProductNameBlur,
  onSelectProduct,
  onFetchAttributes,
  onEntryChange,
}: {
  isDark: boolean;
  form: ProcedureFormData;
  errors: Partial<Record<keyof ProcedureFormData, string>>;
  onChange: (field: keyof ProcedureFormData, value: string) => void;
  attributeData?: ProductAttributeData | null;
  isFetchingAttributes?: boolean;
  attributeError?: string | null;
  /** Fires on every keystroke — drives the debounced auto-discovery cascade (§4). Falls back to the generic onChange when omitted. */
  onProductNameChange?: (value: string) => void;
  onProductNameBlur?: (name: string) => void;
  /** Fires immediately when a product is picked from the lookup dropdown — no extra button click needed to kick off discovery. */
  onSelectProduct?: (match: ProductLookupMatch) => void;
  onFetchAttributes?: () => void;
  onEntryChange?: (entryId: string, field: keyof AttributePricingEntry, value: string) => void;
}) {
  const t = tokens(isDark);
  const isAttributeBased = form.pricingType === "attribute-based";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Procedure Details" icon="sliders" isDark={isDark} defaultOpen>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <Field label="Procedure Name" isDark={isDark} required>
              <input value={form.procedureName} onChange={e => onChange("procedureName", e.target.value)} style={inputStyle(t)} placeholder="e.g. Widget Pro Attribute Pricing" />
              {errors.procedureName && <span style={{ color: t.error, fontSize: 11 }}>{errors.procedureName}</span>}
            </Field>
            <Field label="API Name" isDark={isDark} hint="Optional — auto-generated from the Procedure Name if left blank.">
              <input value={form.apiName} onChange={e => onChange("apiName", e.target.value)} style={inputStyle(t)} placeholder="e.g. Widget_Pro_Attribute_Pricing" />
            </Field>
            <Field label="Product Name" isDark={isDark} required>
              <ProductLookup
                isDark={isDark}
                value={form.productName}
                onChange={value => (onProductNameChange ? onProductNameChange(value) : onChange("productName", value))}
                onSelect={match => onSelectProduct?.(match)}
                onBlur={name => isAttributeBased && onProductNameBlur?.(name)}
                placeholder="Search for a product…"
              />
              {errors.productName && <span style={{ color: t.error, fontSize: 11 }}>{errors.productName}</span>}
              {isAttributeBased && isFetchingAttributes && (
                <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: t.dim }}><Spinner isDark={isDark} size={11} /> Looking up in Salesforce…</span>
              )}
            </Field>
          </div>
          <Field label="Description" isDark={isDark}>
            <textarea value={form.description} onChange={e => onChange("description", e.target.value)} style={{ ...inputStyle(t), minHeight: 60, resize: "vertical" as const }} />
          </Field>
        </div>
      </Section>

      {isAttributeBased ? (
        <>
          <Section title="Product Information" icon="cube" isDark={isDark} defaultOpen>
            <div style={{ paddingTop: 10 }}>
              <ProductInfoStrip isDark={isDark} form={form} onChange={onChange} />
            </div>
          </Section>

          <Section title="Base Price" icon="zap" isDark={isDark} defaultOpen>
            <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: t.heading }}>
                  {form.basePrice ? `$${Number(form.basePrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                </span>
                {!form.basePrice && attributeData && (
                  <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: t.warn }}>
                    <Ic n="alert" s={13} /> No Standard Price Book entry found for this product.
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11, color: t.dim }}>
                Automatically retrieved from the Standard Price Book&apos;s active PricebookEntry — read-only.
              </span>
            </div>
          </Section>

          <Section title="Attribute Pricing" icon="table" isDark={isDark} defaultOpen>
            <div style={{ paddingTop: 10 }}>
              <AttributeEntriesSection
                isDark={isDark}
                entries={form.attributeEntries}
                attributeData={attributeData}
                isFetchingAttributes={isFetchingAttributes}
                attributeError={attributeError}
                onFetchAttributes={onFetchAttributes}
                onEntryChange={onEntryChange}
              />
              {errors.attributeEntries && <div style={{ color: t.error, fontSize: 11, marginTop: 8 }}>{errors.attributeEntries}</div>}
            </div>
          </Section>

          <DeploymentValidationSummary isDark={isDark} form={form} attributeData={attributeData} />
        </>
      ) : (
        <Section title="Pricing Configuration" icon="info" isDark={isDark} defaultOpen>
          <div style={{ paddingTop: 10, fontSize: 12.5, color: t.dim }}>
            This pricing type&apos;s configuration builder isn&apos;t available yet in this build — only Attribute-Based pricing deploys a real Salesforce Expression Set today.
          </div>
        </Section>
      )}
    </div>
  );
}
