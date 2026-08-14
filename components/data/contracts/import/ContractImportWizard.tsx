"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, type ErrorPanelData } from "@/components/data/quotes/shared";
import { CONTRACT_FIELDS, CONTRACT_IMPORT_TOOLKIT, suggestColumnMapping, toMappingRecord, type ContractField, type ColumnMappingSuggestion } from "@/lib/contracts/import/columnMapping";
import type { ValidateContractRowsResult, ContractImportRowResult } from "@/lib/contracts/import/validateRows";
import type { ImportParseResponse } from "@/app/api/import/parse/route";
import type { ContractImportValidateResponse } from "@/app/api/contracts/import/validate/route";
import type { ContractFormData } from "@/lib/contracts/types";
import { saveImportHistoryEntry } from "@/lib/import/history";
import ImportUploadStep from "@/components/import/ImportUploadStep";
import ImportUploadReview from "@/components/import/ImportUploadReview";
import ImportStepIndicator from "@/components/import/ImportStepIndicator";
import ImportFileStrip from "@/components/import/ImportFileStrip";
import ImportToolkit from "@/components/import/ImportToolkit";
import ImportMappingStep from "@/components/import/ImportMappingStep";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import ImportHistoryPanel from "@/components/import/ImportHistoryPanel";
import ContractPreviewStep from "./ContractPreviewStep";

type Step = "upload" | "mapping" | "preview" | "create";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map & Validate" },
  { id: "preview", label: "Preview" },
  { id: "create", label: "Create Contracts" },
];

async function createContractRow(formData: ContractFormData): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formData }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return { error: data.error ?? "Salesforce rejected this contract." };
    return { id: data.id as string };
  } catch {
    return { error: "Network error — could not reach Salesforce." };
  }
}

/**
 * Bulk Contract importer — Upload → Map & Validate → Preview → Create
 * Contracts. Every contract this wizard creates goes through the SAME
 * POST /api/contracts endpoint the manual Contract Creation flow already
 * uses (resolveContractFieldSchema → resolveReferencesByName →
 * buildContractPayload → client.createRecord("Contract", ...)), so both
 * paths produce identical records. This component only orchestrates file
 * parsing, column mapping, and Salesforce-side validation/preview.
 */
export default function ContractImportWizard({ isDark, onBack, startWithHistory }: { isDark: boolean; onBack: () => void; startWithHistory?: boolean }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("upload");
  const [showHistory, setShowHistory] = useState(!!startWithHistory);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ImportParseResponse | null>(null);
  const [suggestions, setSuggestions] = useState<ColumnMappingSuggestion[]>([]);
  const [mapping, setMapping] = useState<Record<ContractField, string | null>>(
    Object.fromEntries(CONTRACT_FIELDS.map(f => [f.key, null])) as Record<ContractField, string | null>,
  );

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<ErrorPanelData | null>(null);
  const [validateResult, setValidateResult] = useState<ValidateContractRowsResult | null>(null);

  const resetAll = () => {
    setFile(null); setParsed(null); setSuggestions([]);
    setMapping(Object.fromEntries(CONTRACT_FIELDS.map(f => [f.key, null])) as Record<ContractField, string | null>);
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

  const handleChangeMapping = (header: string, field: ContractField | null) => {
    setMapping(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next) as ContractField[]) {
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
      const res = await fetch("/api/contracts/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows, mapping }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setValidateError({ title: "Could not validate this import", message: data.error ?? "Unknown error" });
        return;
      }
      setValidateResult(data as ContractImportValidateResponse);
      setStep("preview");
    } catch {
      setValidateError({ title: "Network error", message: "Could not reach the server to validate this import." });
    } finally {
      setValidating(false);
    }
  };

  const sampleRow = parsed?.rows[0] ?? null;
  const currentStepIndex = STEP_LABELS.findIndex(s => s.id === step);

  const rowLabel = (r: ContractImportRowResult) => r.input.displayName || r.input.accountName || `Row #${r.index + 1}`;
  const createItems: CreateQueueItem[] = (validateResult?.rows ?? [])
    .filter(r => r.formData)
    .map(r => ({ index: r.index, name: rowLabel(r), create: () => createContractRow(r.formData as ContractFormData) }));
  const excludedItems: ExcludedQueueItem[] = (validateResult?.rows ?? [])
    .filter(r => !r.formData)
    .map(r => ({ index: r.index, name: rowLabel(r), reason: r.issues.find(i => i.level === "error")?.message ?? "excluded during validation" }));

  return (
    <PageShell>
      <div style={{ padding: "20px 24px 0" }}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Import Contracts</h2>
            <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 560 }}>
              Upload a CSV or Excel file to create multiple Contracts at once.
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
              <ImportUploadStep isDark={isDark} parseEndpoint="/api/import/parse" dropLabel="Drag and drop your contract file here" onParsed={handleParsed} />
            ) : (
              <ImportUploadReview
                isDark={isDark}
                fileName={parsed.fileName} fileSize={parsed.fileSize}
                headers={parsed.headers} rows={parsed.rows} rowCount={parsed.rowCount}
                totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
                fields={CONTRACT_FIELDS} mapping={mapping}
                continueLabel="Continue to Column Mapping"
                onContinue={() => setStep("mapping")}
                onReplace={resetAll}
                onRemove={resetAll}
              />
            )}
            <div style={{ padding: "0 24px 24px", maxWidth: 900 }}>
              <ImportToolkit isDark={isDark} fields={CONTRACT_FIELDS} config={CONTRACT_IMPORT_TOOLKIT} />
            </div>
            {showHistory && (
              <div style={{ padding: "0 24px 24px", maxWidth: 720 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import History</p>
                <ImportHistoryPanel isDark={isDark} module="contract" emptyHint="Completed bulk contract imports will show up here." />
              </div>
            )}
          </>
        )}

        {step === "mapping" && parsed && (
          <ImportMappingStep
            isDark={isDark}
            headers={parsed.headers}
            sampleRow={sampleRow}
            fields={CONTRACT_FIELDS}
            mapping={mapping}
            suggestions={suggestions}
            validating={validating}
            error={validateError}
            onChangeMapping={handleChangeMapping}
            onContinue={runValidate}
            onBack={() => setStep("upload")}
            continueLabel="Validate & Preview"
          />
        )}

        {step === "preview" && validateResult && (
          <ContractPreviewStep
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
            nounSingular="Contract"
            nounPlural="Contracts"
            objectApiName="Contract"
            onBack={onBack}
            onComplete={({ created, failed }) => saveImportHistoryEntry({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              module: "contract",
              fileName: file.name,
              importedAt: new Date().toISOString(),
              total: validateResult.rows.length,
              created,
              failed,
              skipped: validateResult.rows.filter(r => r.status === "error").length,
            })}
          />
        )}
      </div>
    </PageShell>
  );
}
