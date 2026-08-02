"use client";

import { Ic, tokens, CodeBlock, Pill } from "@/components/data/quotes/shared";
import type { LineItemFailureDetail } from "@/lib/quotes/types";

function Row({ t, label, value }: { t: ReturnType<typeof tokens>; label: string; value: string | null }) {
  if (value == null) return null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "5px 0", borderBottom: `1px solid ${t.border}` }}>
      <span style={{ color: t.dim, flexShrink: 0 }}>{label}</span>
      <span style={{ color: t.heading, fontFamily: "ui-monospace, monospace", textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

/**
 * Full diagnostic view for a failed Quote Line Item creation (§Issue 3/5) —
 * exactly what failed, where, and with what data, so the failure is
 * diagnosable from the UI alone without opening the source code.
 */
export default function LineItemFailureView({ isDark, detail }: { isDark: boolean; detail: LineItemFailureDetail }) {
  const t = tokens(isDark);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Pill label={`Failed at: ${detail.currentStep}`} color={t.error} isDark={isDark} />
        {detail.lastSuccessfulStep && <Pill label={`Last success: ${detail.lastSuccessfulStep}`} color={t.accent} isDark={isDark} />}
        {detail.salesforceObject && <Pill label={detail.salesforceObject} color={t.accentCyan} isDark={isDark} />}
      </div>

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Validation Rule</div>
        <div style={{ fontSize: 13, color: t.body }}>{detail.validationRule}</div>
      </div>

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Reason</div>
        <div style={{ fontSize: 13, color: t.error, fontWeight: 600 }}>{detail.reason}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <Row t={t} label="Quote Id" value={detail.quoteId} />
        <Row t={t} label="Product Id" value={detail.productId} />
        <Row t={t} label="Product Name" value={detail.productName} />
        <Row t={t} label="PricebookEntry Id" value={detail.pricebookEntryId} />
        <Row t={t} label="Missing Field" value={detail.missingField} />
        <Row t={t} label="Invalid Value" value={detail.invalidValue != null ? String(detail.invalidValue) : null} />
      </div>

      {detail.validationErrors.length > 1 && (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>All Validation Errors</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {detail.validationErrors.map((e, i) => (
              <div key={i} style={{ fontSize: 12, color: t.error, display: "flex", gap: 6 }}><Ic n="alert" s={12} /> {e}</div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Rollback</div>
        {detail.rollback.attempted ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {detail.rollback.records.map((r, i) => (
              <div key={i} style={{ fontSize: 12, color: t.body, display: "flex", gap: 6 }}>
                <Ic n="refresh" s={12} /> Rolled back {r.ids.length} {r.sobject} record(s).
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: t.dim }}>Nothing had been created yet — no rollback was necessary.</div>
        )}
      </div>

      {detail.generatedPayload != null && (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Generated Payload</div>
          <CodeBlock isDark={isDark} data={detail.generatedPayload} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {detail.sellingModel != null && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Selling Model</div>
            <CodeBlock isDark={isDark} data={detail.sellingModel} collapsedHeight={140} />
          </div>
        )}
        {detail.billingFrequency != null && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Billing Frequency</div>
            <CodeBlock isDark={isDark} data={detail.billingFrequency} collapsedHeight={140} />
          </div>
        )}
        {detail.bundle != null && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Bundle</div>
            <CodeBlock isDark={isDark} data={detail.bundle} collapsedHeight={140} />
          </div>
        )}
        {detail.attributes != null && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Attributes</div>
            <CodeBlock isDark={isDark} data={detail.attributes} collapsedHeight={140} />
          </div>
        )}
        {detail.relationshipFields != null && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginBottom: 4 }}>Relationship Fields</div>
            <CodeBlock isDark={isDark} data={detail.relationshipFields} collapsedHeight={140} />
          </div>
        )}
      </div>
    </div>
  );
}
