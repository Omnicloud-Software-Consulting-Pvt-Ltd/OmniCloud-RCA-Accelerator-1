"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, type ErrorPanelData } from "@/components/data/quotes/shared";
import { CANONICAL_FIELDS, PRODUCT_IMPORT_TOOLKIT, suggestColumnMapping, toMappingRecord, type CanonicalField, type ColumnMappingSuggestion } from "@/lib/products/import/columnMapping";
import ImportToolkit from "@/components/import/ImportToolkit";
import type { ValidateRowsResult, ImportRowResult } from "@/lib/products/import/validateRows";
import type { ProductImportParseResponse } from "@/app/api/sf/products/import/parse/route";
import type { ProductImportValidateResponse } from "@/app/api/sf/products/import/validate/route";
import type { ProductDeployResult } from "@/lib/products/types";
import { saveImportHistoryEntry } from "@/lib/import/history";
import ImportUploadStep from "@/components/import/ImportUploadStep";
import ImportUploadReview from "@/components/import/ImportUploadReview";
import ImportStepIndicator from "@/components/import/ImportStepIndicator";
import ImportFileStrip from "@/components/import/ImportFileStrip";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import ImportHistoryPanel from "@/components/import/ImportHistoryPanel";
import ImportMappingStep from "@/components/import/ImportMappingStep";
import ImportPreviewStep from "./ImportPreviewStep";

type Step = "upload" | "mapping" | "preview" | "create";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map & Validate" },
  { id: "preview", label: "Preview" },
  { id: "create", label: "Create Products" },
];

async function createProductRow(row: ImportRowResult): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch("/api/sf/products/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row.payload),
    });
    const data = await res.json() as ProductDeployResult;
    if (!res.ok || !data.success) return { error: data.error ?? "Salesforce rejected this product." };
    return { id: data.salesforceId };
  } catch {
    return { error: "Network error — could not reach Salesforce." };
  }
}

/**
 * Bulk Product importer — Upload → Map & Validate → Preview → Create
 * Products. Every product this wizard creates goes through the SAME
 * /api/sf/products/save endpoint the AI single-product flow
 * (RCProductWorkspace) already uses, so both paths produce identical
 * Product2/PricebookEntry/ProductSellingModelOption records. This component
 * only orchestrates file parsing, column mapping, and Salesforce-side
 * validation/preview (via /api/sf/products/import/parse and
 * .../import/validate) — it never re-implements product creation itself.
 * Upload/Create-progress UI is shared with Quotes/Contracts/Orders via
 * components/import/*; the mapping/preview steps stay Product-specific.
 */
export default function ProductImportWizard({ isDark, onBack, startWithHistory }: { isDark: boolean; onBack: () => void; startWithHistory?: boolean }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("upload");
  const [showHistory, setShowHistory] = useState(!!startWithHistory);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ProductImportParseResponse | null>(null);
  const [suggestions, setSuggestions] = useState<ColumnMappingSuggestion[]>([]);
  const [mapping, setMapping] = useState<Record<CanonicalField, string | null>>(
    Object.fromEntries(CANONICAL_FIELDS.map(f => [f.key, null])) as Record<CanonicalField, string | null>,
  );

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<ErrorPanelData | null>(null);
  const [validateResult, setValidateResult] = useState<ValidateRowsResult | null>(null);

  const resetAll = () => {
    setFile(null); setParsed(null); setSuggestions([]);
    setMapping(Object.fromEntries(CANONICAL_FIELDS.map(f => [f.key, null])) as Record<CanonicalField, string | null>);
    setValidateResult(null); setValidateError(null);
    setStep("upload");
  };

  const handleParsed = (uploadedFile: File, result: ProductImportParseResponse) => {
    setFile(uploadedFile);
    setParsed(result);
    const guesses = suggestColumnMapping(result.headers);
    setSuggestions(guesses);
    setMapping(toMappingRecord(guesses));
  };

  const handleChangeMapping = (header: string, field: CanonicalField | null) => {
    setMapping(prev => {
      const next = { ...prev };
      // A header can only map to one field; a field can only come from one header.
      for (const key of Object.keys(next) as CanonicalField[]) {
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
      const res = await fetch("/api/sf/products/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows, mapping }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setValidateError({ title: "Could not validate this import", message: data.error ?? "Unknown error" });
        return;
      }
      setValidateResult(data as ProductImportValidateResponse);
      setStep("preview");
    } catch {
      setValidateError({ title: "Network error", message: "Could not reach the server to validate this import." });
    } finally {
      setValidating(false);
    }
  };

  const sampleRow = parsed?.rows[0] ?? null;
  const currentStepIndex = STEP_LABELS.findIndex(s => s.id === step);

  const createItems: CreateQueueItem[] = (validateResult?.rows ?? [])
    .filter(r => r.payload)
    .map(r => ({ index: r.index, name: r.input.name || `Row #${r.index + 1}`, create: () => createProductRow(r) }));
  const excludedItems: ExcludedQueueItem[] = (validateResult?.rows ?? [])
    .filter(r => !r.payload)
    .map(r => ({ index: r.index, name: r.input.name || `Row #${r.index + 1}`, reason: r.issues.find(i => i.level === "error" || i.level === "info")?.message ?? "excluded during validation" }));

  return (
    <PageShell>
      <div style={{ padding: "20px 24px 0" }}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Import Products</h2>
            </div>
            <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 560 }}>
              Upload a CSV or Excel file to create multiple Revenue Cloud products at once.
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

        {/* Stepper */}
        <ImportStepIndicator isDark={isDark} steps={STEP_LABELS} currentIndex={currentStepIndex} />

        {/* Current file strip — the Upload step shows its own richer file summary instead (below). */}
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
              <ImportUploadStep isDark={isDark} parseEndpoint="/api/sf/products/import/parse" dropLabel="Drag and drop your product file here" onParsed={handleParsed} />
            ) : (
              <ImportUploadReview
                isDark={isDark}
                fileName={parsed.fileName} fileSize={parsed.fileSize}
                headers={parsed.headers} rows={parsed.rows} rowCount={parsed.rowCount}
                totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
                fields={CANONICAL_FIELDS} mapping={mapping}
                continueLabel="Continue to Column Mapping"
                onContinue={() => setStep("mapping")}
                onReplace={resetAll}
                onRemove={resetAll}
              />
            )}
            <div style={{ padding: "0 24px 24px", maxWidth: 900 }}>
              <ImportToolkit isDark={isDark} fields={CANONICAL_FIELDS} config={PRODUCT_IMPORT_TOOLKIT} />
            </div>
            {showHistory && (
              <div style={{ padding: "0 24px 24px", maxWidth: 720 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import History</p>
                <ImportHistoryPanel isDark={isDark} module="product" emptyHint="Completed bulk product imports will show up here." />
              </div>
            )}
          </>
        )}

        {step === "mapping" && parsed && (
          <ImportMappingStep
            isDark={isDark}
            headers={parsed.headers}
            sampleRow={sampleRow}
            fields={CANONICAL_FIELDS}
            mapping={mapping}
            suggestions={suggestions}
            validating={validating}
            error={validateError}
            onChangeMapping={handleChangeMapping}
            onContinue={runValidate}
            onBack={() => setStep("upload")}
            extraOptions={(
              <p style={{ fontSize: 11.5, color: t.dim }}>
                Products that already exist in Salesforce (matched by Product Code or Name) are automatically excluded from creation — see the Preview step.
              </p>
            )}
          />
        )}

        {step === "preview" && validateResult && (
          <ImportPreviewStep
            isDark={isDark}
            rows={validateResult.rows}
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
            totalCount={validateResult.rows.length}
            warningsCount={validateResult.summary.warnings}
            nounSingular="Product"
            nounPlural="Products"
            objectApiName="Product2"
            onBack={onBack}
            onComplete={({ created, failed }) => saveImportHistoryEntry({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              module: "product",
              fileName: file.name,
              importedAt: new Date().toISOString(),
              total: validateResult.rows.length,
              created,
              failed,
              skipped: validateResult.rows.filter(r => r.status === "skipped" || r.status === "error").length,
            })}
          />
        )}
      </div>
    </PageShell>
  );
}
