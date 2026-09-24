"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, type ErrorPanelData } from "@/components/data/quotes/shared";
import { ORDER_FIELDS, ORDER_IMPORT_TOOLKIT, suggestColumnMapping, toMappingRecord, type OrderField, type ColumnMappingSuggestion } from "@/lib/orders/import/columnMapping";
import type { ValidateOrderRowsResult, OrderGroupResult } from "@/lib/orders/import/validateRows";
import type { ImportParseResponse } from "@/app/api/import/parse/route";
import type { OrderImportValidateResponse } from "@/app/api/orders/import/validate/route";
import { saveImportHistoryEntry } from "@/lib/import/history";
import ImportUploadStep from "@/components/import/ImportUploadStep";
import ImportUploadReview from "@/components/import/ImportUploadReview";
import ImportStepIndicator from "@/components/import/ImportStepIndicator";
import ImportFileStrip from "@/components/import/ImportFileStrip";
import ImportToolkit from "@/components/import/ImportToolkit";
import ImportMappingStep from "@/components/import/ImportMappingStep";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import ImportHistoryPanel from "@/components/import/ImportHistoryPanel";
import OrderPreviewStep from "./OrderPreviewStep";

type Step = "upload" | "mapping" | "preview" | "create";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map & Validate" },
  { id: "preview", label: "Preview" },
  { id: "create", label: "Create Orders" },
];

/** Creates one Order group: header via the existing POST /api/orders, then any resolved line items via the existing POST /api/orders/[id]/line-items. A line-item failure after a successful header still counts as "created", surfaced as a note rather than hidden or treated as a hard failure. */
async function createOrderGroup(group: OrderGroupResult): Promise<{ id?: string; error?: string; note?: string }> {
  if (!group.formData) return { error: "This order was excluded during validation." };
  try {
    const headerRes = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formData: group.formData }),
    });
    const headerData = await headerRes.json();
    if (!headerRes.ok || !headerData.success) return { error: headerData.error ?? "Salesforce rejected this order." };
    const orderId = headerData.id as string;

    const drafts = group.lineItems.filter(li => li.draft).map(li => li.draft!);
    const unresolvedCount = group.lineItems.length - drafts.length;

    if (drafts.length === 0) {
      return unresolvedCount > 0 ? { id: orderId, note: `Order created, but ${unresolvedCount} line item(s) could not be resolved and were skipped.` } : { id: orderId };
    }
    if (!group.resolvedPricebookId) {
      return { id: orderId, note: `Order created, but its Price Book could not be resolved — ${drafts.length} line item(s) were not added.` };
    }

    const lineRes = await fetch(`/api/orders/${orderId}/line-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pricebookId: group.resolvedPricebookId, draftRoots: drafts }),
    });
    const lineData = await lineRes.json();
    if (!lineRes.ok || !lineData.success) {
      const reason = lineData.failureDetail?.reason ?? lineData.errors?.[0]?.message ?? "Failed to create line items.";
      return { id: orderId, note: `Order created, but line items failed: ${reason}` };
    }
    return unresolvedCount > 0 ? { id: orderId, note: `Order created; ${unresolvedCount} line item(s) could not be resolved and were skipped.` } : { id: orderId };
  } catch {
    return { error: "Network error — could not reach Salesforce." };
  }
}

/**
 * Bulk Order importer — Upload → Map & Validate → Preview → Create Orders.
 * Every order this wizard creates goes through the SAME two existing
 * endpoints the manual Order flow already uses: POST /api/orders (header)
 * and POST /api/orders/[id]/line-items (line items, via the same
 * searchCatalogProducts/rankProductNameMatches product resolution the
 * manual Add Line Items UI uses). This component only orchestrates file
 * parsing, column mapping, row-grouping-by-Order-Number, and Salesforce-side
 * validation/preview — it never re-implements Order or OrderItem creation.
 */
export default function OrderImportWizard({ isDark, onBack, startWithHistory }: { isDark: boolean; onBack: () => void; startWithHistory?: boolean }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("upload");
  const [showHistory, setShowHistory] = useState(!!startWithHistory);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ImportParseResponse | null>(null);
  const [suggestions, setSuggestions] = useState<ColumnMappingSuggestion[]>([]);
  const [mapping, setMapping] = useState<Record<OrderField, string | null>>(
    Object.fromEntries(ORDER_FIELDS.map(f => [f.key, null])) as Record<OrderField, string | null>,
  );

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<ErrorPanelData | null>(null);
  const [validateResult, setValidateResult] = useState<ValidateOrderRowsResult | null>(null);

  const resetAll = () => {
    setFile(null); setParsed(null); setSuggestions([]);
    setMapping(Object.fromEntries(ORDER_FIELDS.map(f => [f.key, null])) as Record<OrderField, string | null>);
    setValidateResult(null); setValidateError(null);
    setStep("upload");
  };

  const handleParsed = (uploadedFile: File, result: ImportParseResponse) => {
    setFile(uploadedFile);
    setParsed(result);
    const guesses = suggestColumnMapping(result.headers);
    setSuggestions(guesses);
    setMapping(toMappingRecord(guesses));
  };

  const handleChangeMapping = (header: string, field: OrderField | null) => {
    setMapping(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next) as OrderField[]) {
        if (next[key] === header) next[key] = null;
      }
      if (field) next[field] = header;
      return next;
    });
  };

  const runValidate = async () => {
    if (!parsed) return;
    setValidating(true);
    setValidateError(null);
    try {
      const res = await fetch("/api/orders/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows, mapping }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setValidateError({ title: "Could not validate this import", message: data.error ?? "Unknown error" });
        return;
      }
      setValidateResult(data as OrderImportValidateResponse);
      setStep("preview");
    } catch {
      setValidateError({ title: "Network error", message: "Could not reach the server to validate this import." });
    } finally {
      setValidating(false);
    }
  };

  const sampleRow = parsed?.rows[0] ?? null;
  const currentStepIndex = STEP_LABELS.findIndex(s => s.id === step);

  const groupLabel = (g: OrderGroupResult) => g.input.orderKey || g.input.accountName || `Order #${g.index + 1}`;
  const createItems: CreateQueueItem[] = (validateResult?.groups ?? [])
    .filter(g => g.formData)
    .map(g => ({ index: g.index, name: groupLabel(g), create: () => createOrderGroup(g) }));
  const excludedItems: ExcludedQueueItem[] = (validateResult?.groups ?? [])
    .filter(g => !g.formData)
    .map(g => ({ index: g.index, name: groupLabel(g), reason: g.issues.find(i => i.level === "error")?.message ?? "excluded during validation" }));

  return (
    <PageShell>
      <div style={{ padding: "20px 24px 0" }}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Import Orders</h2>
            <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 560 }}>
              Upload a CSV or Excel file to create multiple Orders (and their line items) at once.
            </p>
          </div>
          {step === "upload" && (
            <button
              onClick={() => setShowHistory(v => !v)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: t.accent, background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}
            >
              <Ic n="list" s={13} /> {showHistory ? "Hide Import History" : "View Import History"}
            </button>
          )}
        </div>

        <ImportStepIndicator isDark={isDark} steps={STEP_LABELS} currentIndex={currentStepIndex} />

        {file && parsed && step !== "upload" && (
          <ImportFileStrip
            isDark={isDark} fileName={parsed.fileName} fileSize={parsed.fileSize}
            rowCount={parsed.rowCount} totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
            onReplace={resetAll}
          />
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {step === "upload" && (
          <>
            {!parsed ? (
              <ImportUploadStep isDark={isDark} parseEndpoint="/api/import/parse" dropLabel="Drag and drop your order file here" onParsed={handleParsed} />
            ) : (
              <ImportUploadReview
                isDark={isDark}
                fileName={parsed.fileName} fileSize={parsed.fileSize}
                headers={parsed.headers} rows={parsed.rows} rowCount={parsed.rowCount}
                totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
                fields={ORDER_FIELDS} mapping={mapping}
                continueLabel="Continue to Column Mapping"
                onContinue={() => setStep("mapping")}
                onReplace={resetAll}
                onRemove={resetAll}
              />
            )}
            <div style={{ padding: "0 24px 24px", maxWidth: 900 }}>
              <ImportToolkit isDark={isDark} fields={ORDER_FIELDS} config={ORDER_IMPORT_TOOLKIT} />
            </div>
            {showHistory && (
              <div style={{ padding: "0 24px 24px", maxWidth: 720 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import History</p>
                <ImportHistoryPanel isDark={isDark} module="order" emptyHint="Completed bulk order imports will show up here." />
              </div>
            )}
          </>
        )}

        {step === "mapping" && parsed && (
          <ImportMappingStep
            isDark={isDark}
            headers={parsed.headers}
            sampleRow={sampleRow}
            fields={ORDER_FIELDS}
            mapping={mapping}
            suggestions={suggestions}
            validating={validating}
            error={validateError}
            onChangeMapping={handleChangeMapping}
            onContinue={runValidate}
            onBack={() => setStep("upload")}
            continueLabel="Validate & Preview"
            extraOptions={(
              <p style={{ fontSize: 11.5, color: t.dim }}>
                Rows sharing the same mapped &quot;Order Number&quot; value are grouped into one Order with multiple line items.
              </p>
            )}
          />
        )}

        {step === "preview" && validateResult && (
          <OrderPreviewStep
            isDark={isDark}
            groups={validateResult.groups}
            summary={validateResult.summary}
            onBack={() => setStep("mapping")}
            onCreate={() => setStep("create")}
          />
        )}

        {step === "create" && validateResult && file && (
          <ImportCreateStep
            isDark={isDark}
            items={createItems}
            excluded={excludedItems}
            totalCount={validateResult.groups.length}
            warningsCount={validateResult.summary.warnings}
            nounSingular="Order"
            nounPlural="Orders"
            objectApiName="Order"
            onBack={onBack}
            onComplete={({ created, failed }) => saveImportHistoryEntry({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              module: "order",
              fileName: file.name,
              importedAt: new Date().toISOString(),
              total: validateResult.groups.length,
              created,
              failed,
              skipped: validateResult.groups.filter(g => g.status === "error").length,
            })}
          />
        )}
      </div>
    </PageShell>
  );
}
