"use client";

import { Ic, tokens, GhostButton } from "./shared";
import type { CreateProcedureFailure, AttrNativeResult } from "@/lib/pricing-rules/types";
import { classifyFriendlyFailure } from "@/lib/pricing-rules/ui/friendlyCreateFailure";

/** §E — the exact distinct category label per failure type, shown prominently so this panel never reads
 * as a generic "something broke" regardless of which of the very different underlying failures fired. */
const CATEGORY_LABELS: Record<ReturnType<typeof classifyFriendlyFailure>, string | null> = {
  condition: "Condition Creation Failed",
  adjustment: "Adjustment Creation Failed",
  "xml-generation": "XML Generation Failed",
  "xml-validation": "XML Validation Failed",
  uniqueness: "Metadata Uniqueness Failed",
  deployment: "Metadata Deployment Failed",
  "deployment-verification": "Deployment Verification Failed",
  other: null,
};

function jsonBlock(isDark: boolean, t: ReturnType<typeof tokens>, value: unknown) {
  return (
    <pre style={{
      margin: 0, maxHeight: 280, overflow: "auto", fontSize: 11, lineHeight: 1.5,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
      border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
    }}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
  );
}

/** §5 — "save the failed deployment package for inspection": decodes the base64 ZIP the Metadata API was (or would have been) sent and triggers a browser download — no server-side file storage needed. */
function downloadDeployZip(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "failed-deploy-package.zip";
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * §3 — detailed Create Procedure failure diagnostics: which step broke,
 * the Salesforce API surface involved, HTTP status, Salesforce error
 * code/message, the complete failure reason, and a suggested resolution.
 * Replaces the old plain "generic API failure" string. Never renders a
 * stack trace — that only ever goes to the server console (see
 * lib/pricing-rules/salesforce/errorDiagnostics.ts).
 *
 * §Native record creation diagnostics — when `failure.nativeCreateFailure`
 * is present, `failure.step` names the ACTUAL Salesforce object whose
 * create call failed (PriceAdjustmentSchedule/AttributeBasedAdjRule/
 * AttributeAdjustmentCondition/AttributeBasedAdjustment), not a generic
 * stage name, and this renders the exact payload sent, any missing
 * required fields, and the complete Salesforce response — answering
 * "which object / which payload / which field / which rule / which
 * response" directly instead of a generic deployment-failure message.
 */
export default function CreateProcedureFailurePanel({
  isDark,
  failure,
  fallbackMessage,
  attrNative,
}: {
  isDark: boolean;
  failure: CreateProcedureFailure | null;
  fallbackMessage?: string | null;
  /** Present when the failure happened during (or near) native attribute-pricing record creation — carries the expected-record-count preview even on failure. */
  attrNative?: AttrNativeResult | null;
}) {
  const t = tokens(isDark);
  if (!failure && !fallbackMessage) return null;
  const nf = failure?.nativeCreateFailure;
  const categoryLabel = failure ? CATEGORY_LABELS[classifyFriendlyFailure(failure)] : null;

  return (
    <div style={{
      borderRadius: 14, border: `1px solid ${t.error}55`,
      background: isDark ? "rgba(255,64,102,0.08)" : "rgba(255,64,102,0.06)",
      padding: 16, display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.error, fontWeight: 700, fontSize: 14 }}>
        <Ic n="alert" s={17} /> {categoryLabel ?? `Create Procedure failed${failure ? ` at "${failure.step}"` : ""}`}
      </div>
      {categoryLabel && failure && (
        <div style={{ fontSize: 11, color: t.dim, marginTop: -4 }}>Step: {failure.step}</div>
      )}

      {!failure && fallbackMessage && <div style={{ fontSize: 12.5, color: t.body }}>{fallbackMessage}</div>}

      {failure && (
        <>
          <div style={{ fontSize: 12.5, color: t.body }}>{failure.reason}</div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: 11.5 }}>
            <div><strong style={{ color: t.heading }}>Step:</strong> <span style={{ color: t.body }}>{failure.step}</span></div>
            {failure.object && (
              <div><strong style={{ color: t.heading }}>Object:</strong> <span style={{ color: t.body }}>{failure.object}</span></div>
            )}
            {failure.operation && (
              <div><strong style={{ color: t.heading }}>Operation:</strong> <span style={{ color: t.body }}>{failure.operation}</span></div>
            )}
            {failure.salesforceId && (
              <div><strong style={{ color: t.heading }}>Salesforce Id:</strong> <span style={{ color: t.body }}>{failure.salesforceId}</span></div>
            )}
            {failure.lastSuccessfulStep !== undefined && (
              <div><strong style={{ color: t.heading }}>Last Successful Step:</strong> <span style={{ color: t.body }}>{failure.lastSuccessfulStep ?? "(none — this was the first step)"}</span></div>
            )}
            {failure.endpoint && (
              <div><strong style={{ color: t.heading }}>Endpoint:</strong> <span style={{ color: t.body }}>{failure.endpoint}</span></div>
            )}
            {failure.httpStatus != null && (
              <div><strong style={{ color: t.heading }}>HTTP Status:</strong> <span style={{ color: t.body }}>{failure.httpStatus}</span></div>
            )}
            {failure.salesforceErrorCode && (
              <div><strong style={{ color: t.heading }}>Salesforce Error Code:</strong> <span style={{ color: t.body }}>{failure.salesforceErrorCode}</span></div>
            )}
            {failure.salesforceErrorMessage && (
              <div style={{ gridColumn: "1 / -1" }}>
                <strong style={{ color: t.heading }}>Salesforce Error Message:</strong>{" "}
                <span style={{ color: t.body, whiteSpace: "pre-wrap" }}>{failure.salesforceErrorMessage}</span>
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: t.dim, borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}><Ic n="zap" s={13} /></span>
            <span><strong style={{ color: t.body }}>Suggested resolution: </strong>{failure.resolutionHint}</span>
          </div>

          {attrNative?.recordCountPreview && attrNative.recordCountPreview.length > 0 && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>Expected Record Counts (computed before the first create call)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
                {attrNative.recordCountPreview.map((p, i) => (
                  <div key={i}>
                    <strong style={{ color: t.heading }}>{p.objectName}:</strong> <span style={{ color: t.body }}>{p.expectedCount}</span>
                    {p.reason && <span style={{ color: t.warn }}> — {p.reason}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {nf && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading }}>Native Record Creation Failure — {nf.objectName}</div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: 11.5 }}>
                <div><strong style={{ color: t.heading }}>REST Endpoint:</strong> <span style={{ color: t.body }}>{nf.restEndpoint}</span></div>
                <div><strong style={{ color: t.heading }}>Required Fields:</strong> <span style={{ color: t.body }}>{nf.requiredFields.join(", ") || "—"}</span></div>
                <div><strong style={{ color: t.heading }}>Optional Fields:</strong> <span style={{ color: t.body }}>{nf.optionalFields.join(", ") || "—"}</span></div>
              </div>

              {nf.missingFields.length > 0 && (
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: t.error, marginBottom: 4 }}>Required Fields Missing (Salesforce was never called)</div>
                  <div style={{ fontSize: 11.5, color: t.body }}>{nf.missingFields.map(f => `- ${f}`).join("\n")}</div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, marginBottom: 4 }}>Payload Sent</div>
                {jsonBlock(isDark, t, nf.payload)}
              </div>

              {nf.responseBody != null && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: t.dim, marginBottom: 4 }}>Salesforce Response Body</div>
                  {jsonBlock(isDark, t, nf.responseBody)}
                </div>
              )}
            </div>
          )}

          {failure.schemaReport && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>Structural Schema Comparison (donor vs. generated)</div>
              <pre style={{
                margin: 0, maxHeight: 360, overflow: "auto", fontSize: 11, lineHeight: 1.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
              }}>{failure.schemaReport}</pre>
            </div>
          )}

          {failure.packagingReport && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>Deployment ZIP Packaging Report</div>
              <pre style={{
                margin: 0, maxHeight: 360, overflow: "auto", fontSize: 11, lineHeight: 1.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
              }}>{failure.packagingReport}</pre>
            </div>
          )}

          {/* §Deployment Diagnostics — every componentFailures[] entry Salesforce actually returned,
              rendered directly and itemized, never collapsed into the generic "this step didn't
              complete" message (§6). */}
          {failure.deployComponentFailures && failure.deployComponentFailures.length > 0 && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>
                Component Failures ({failure.deployComponentFailures.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {failure.deployComponentFailures.map((cf, i) => (
                  <div key={i} style={{
                    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6, fontSize: 11.5,
                    border: `1px solid ${t.border}`, borderRadius: 8, padding: 10,
                    background: isDark ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.02)",
                  }}>
                    <div><strong style={{ color: t.heading }}>Component Name:</strong> <span style={{ color: t.body }}>{cf.fullName ?? "—"}</span></div>
                    <div><strong style={{ color: t.heading }}>Component Type:</strong> <span style={{ color: t.body }}>{cf.componentType ?? "—"}</span></div>
                    <div><strong style={{ color: t.heading }}>File Name:</strong> <span style={{ color: t.body }}>{cf.fileName ?? "—"}</span></div>
                    <div><strong style={{ color: t.heading }}>Problem Type:</strong> <span style={{ color: t.body }}>{cf.problemType ?? "—"}</span></div>
                    <div><strong style={{ color: t.heading }}>Line:</strong> <span style={{ color: t.body }}>{cf.lineNumber ?? "—"}</span></div>
                    <div><strong style={{ color: t.heading }}>Column:</strong> <span style={{ color: t.body }}>{cf.columnNumber ?? "—"}</span></div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <strong style={{ color: t.heading }}>Problem Message:</strong>{" "}
                      <span style={{ color: t.body, whiteSpace: "pre-wrap" }}>{cf.problem ?? "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* §6 — componentFailures came back empty (e.g. a top-level SOAP fault, or a shape
              parseDeployStatus's targeted regexes don't recognize) — fall back to the complete raw
              SOAP response instead of leaving the reader with only the generic message above. */}
          {(!failure.deployComponentFailures || failure.deployComponentFailures.length === 0) && failure.rawDeployStatusXml && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.error, marginBottom: 6 }}>
                No componentFailures were returned — raw SOAP checkDeployStatus response
              </div>
              <pre style={{
                margin: 0, maxHeight: 360, overflow: "auto", fontSize: 11, lineHeight: 1.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
              }}>{failure.rawDeployStatusXml}</pre>
            </div>
          )}

          {failure.deployFullStatus && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>Full Deploy Status</div>
              {jsonBlock(isDark, t, failure.deployFullStatus)}
            </div>
          )}

          {failure.generatedFileXml && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: t.heading, marginBottom: 6 }}>Generated Metadata File (exact XML sent to Salesforce)</div>
              <pre style={{
                margin: 0, maxHeight: 360, overflow: "auto", fontSize: 11, lineHeight: 1.5,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                background: isDark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.04)",
                border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, color: t.body, whiteSpace: "pre-wrap",
              }}>{failure.generatedFileXml}</pre>
            </div>
          )}

          {failure.deployZipBase64 && (
            <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11.5, color: t.dim }}>Save the failed deployment package (package.xml + generated metadata file) for offline inspection.</span>
              <GhostButton label="Download .zip" icon="package" isDark={isDark} onClick={() => downloadDeployZip(failure.deployZipBase64!)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
