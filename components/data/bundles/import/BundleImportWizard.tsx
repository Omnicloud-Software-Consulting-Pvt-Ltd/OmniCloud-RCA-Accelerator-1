"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, type ErrorPanelData } from "@/components/data/quotes/shared";
import { BUNDLE_CANONICAL_FIELDS, BUNDLE_IMPORT_TOOLKIT, suggestBundleColumnMapping, toBundleMappingRecord, type BundleCanonicalField, type BundleColumnMappingSuggestion } from "@/lib/bundles/import/columnMapping";
import { validateBundleImportRows, type BundleValidateResult } from "@/lib/bundles/import/validateRows";
import type { DuplicateCheckResult } from "@/lib/duplicateDetection";
import type { BundleImportParseResponse } from "@/app/api/bundles/import/parse/route";
import type { ParsedBundle } from "@/lib/bundles/types";
import ImportUploadStep from "@/components/import/ImportUploadStep";
import ImportUploadReview from "@/components/import/ImportUploadReview";
import ImportStepIndicator from "@/components/import/ImportStepIndicator";
import ImportFileStrip from "@/components/import/ImportFileStrip";
import ImportToolkit from "@/components/import/ImportToolkit";
import ImportMappingStep from "@/components/import/ImportMappingStep";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import ImportHistoryPanel from "@/components/import/ImportHistoryPanel";
import { saveImportHistoryEntry } from "@/lib/import/history";
import BundleImportPreviewStep from "./BundleImportPreviewStep";

type Step = "upload" | "mapping" | "preview" | "create";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map & Validate" },
  { id: "preview", label: "Preview" },
  { id: "create", label: "Create Bundles" },
];

/** Consumes /api/bundles/execute's SSE stream and resolves once the bundle finishes — same create service the AI Bundle Studio uses, just without its live per-batch console (matching every other bulk importer's simpler sequential-progress UI). */
async function executeBundleImport(parsedBundle: ParsedBundle): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch("/api/bundles/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle: parsedBundle, depRules: [] }),
    });
    if (!res.ok || !res.body) return { error: "Failed to connect to the bundle creation service." };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "complete") return { id: ev.bundleId };
          if (ev.type === "error") return { error: ev.message };
        } catch { /* malformed SSE line — ignore and keep reading */ }
      }
    }
    return { error: "Bundle creation stream ended without a result." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Network error — could not reach Salesforce." };
  }
}

/**
 * Bundle Importer — Upload → Map & Validate → Preview → Create Bundles.
 * Multiple CSV/Excel rows sharing the same Bundle Code/Name are grouped
 * into ONE bundle with N related products (lib/bundles/import/
 * validateRows.ts), and every creatable bundle is built into the EXACT
 * ParsedBundle structure /api/bundles/execute — the existing AI Bundle
 * Creation service — already accepts, so import never duplicates bundle
 * creation logic. Upload/Create-progress UI is shared with Products/
 * Quotes/Contracts/Orders via components/import/*.
 */
export default function BundleImportWizard({ isDark, onBack }: { isDark: boolean; onBack: () => void }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("upload");
  const [showHistory, setShowHistory] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<BundleImportParseResponse | null>(null);
  const [suggestions, setSuggestions] = useState<BundleColumnMappingSuggestion[]>([]);
  const [mapping, setMapping] = useState<Record<BundleCanonicalField, string | null>>(
    Object.fromEntries(BUNDLE_CANONICAL_FIELDS.map(f => [f.key, null])) as Record<BundleCanonicalField, string | null>,
  );

  const [validateError, setValidateError] = useState<ErrorPanelData | null>(null);
  const [validateResult, setValidateResult] = useState<BundleValidateResult | null>(null);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);

  const resetAll = () => {
    setFile(null); setParsed(null); setSuggestions([]);
    setMapping(Object.fromEntries(BUNDLE_CANONICAL_FIELDS.map(f => [f.key, null])) as Record<BundleCanonicalField, string | null>);
    setValidateResult(null); setValidateError(null);
    setStep("upload");
  };

  const handleParsed = (uploadedFile: File, result: BundleImportParseResponse) => {
    setFile(uploadedFile);
    setParsed(result);
    const guesses = suggestBundleColumnMapping(result.headers);
    setSuggestions(guesses);
    setMapping(toBundleMappingRecord(guesses));
  };

  const handleChangeMapping = (header: string, field: BundleCanonicalField | null) => {
    setMapping(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next) as BundleCanonicalField[]) {
        if (next[key] === header) next[key] = null;
      }
      if (field) next[field] = header;
      return next;
    });
  };

  const runValidate = async () => {
    if (!parsed) return;
    setValidateError(null);
    if (!mapping.bundleName) {
      setValidateError({ title: "Bundle Name must be mapped", message: "Map a column to Bundle Name before continuing." });
      return;
    }
    if (!mapping.productName) {
      setValidateError({ title: "Product must be mapped", message: "Map a column to Product before continuing." });
      return;
    }
    const result = validateBundleImportRows(parsed.rows, mapping);

    // Duplicate Prevention (§15) — ONE check per parent Bundle group, never
    // once per component row: rows are already grouped by Bundle Code/Name
    // above, so this batches exactly one /api/bundles/check-duplicate call
    // covering every group that survived field validation. Advisory only —
    // /api/bundles/execute re-runs the same check per bundle as the final
    // authority when each one is actually created (§21).
    const creatable = result.groups.filter(g => g.parsedBundle);
    if (creatable.length > 0) {
      setCheckingDuplicates(true);
      try {
        const res = await fetch("/api/bundles/check-duplicate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: creatable.map(g => ({ key: g.key, name: g.bundleName, code: g.bundleCode || undefined })) }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
          const results: Record<string, DuplicateCheckResult> = data.results;
          for (const g of result.groups) {
            const dup = results[g.key];
            if (dup?.isDuplicate) {
              g.issues.push({ level: "error", message: `Duplicate — "${dup.recordName}" already exists in Salesforce. This bundle will not be created.` });
              g.status = "error";
              g.parsedBundle = null;
            }
          }
          result.summary = {
            totalBundles: result.groups.length,
            totalComponents: result.groups.reduce((sum, g) => sum + g.productNames.length, 0),
            ready: result.groups.filter(g => g.status === "ready").length,
            warnings: result.groups.filter(g => g.status === "warning").length,
            errors: result.groups.filter(g => g.status === "error").length,
          };
        }
      } catch { /* pre-check failed — /api/bundles/execute's own final gate still protects each bundle at create time */ }
      setCheckingDuplicates(false);
    }

    setValidateResult(result);
    setStep("preview");
  };

  const sampleRow = parsed?.rows[0] ?? null;
  const currentStepIndex = STEP_LABELS.findIndex(s => s.id === step);

  const creatableGroups = (validateResult?.groups ?? []).filter(g => g.parsedBundle);
  const excludedGroups = (validateResult?.groups ?? []).filter(g => !g.parsedBundle);
  const createItems: CreateQueueItem[] = creatableGroups.map((g, i) => ({
    index: i,
    name: g.bundleName || `Bundle #${i + 1}`,
    create: () => executeBundleImport(g.parsedBundle!),
  }));
  const excludedItems: ExcludedQueueItem[] = excludedGroups.map((g, i) => ({
    index: creatableGroups.length + i,
    name: g.bundleName || `Bundle #${i + 1}`,
    reason: g.issues.find(iss => iss.level === "error")?.message ?? "excluded during validation",
  }));

  return (
    <PageShell>
      <div style={{ padding: "20px 24px 0" }}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Import Bundles</h2>
            <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 560 }}>
              Upload a CSV or Excel file to create multiple Revenue Cloud bundles at once — rows sharing the same Bundle Code become one bundle with all its products.
            </p>
          </div>
          {step === "upload" && (
            <button onClick={() => setShowHistory(v => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: t.accent, background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}>
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
              <ImportUploadStep isDark={isDark} parseEndpoint="/api/bundles/import/parse" dropLabel="Drag and drop your bundle file here" onParsed={handleParsed} />
            ) : (
              <ImportUploadReview
                isDark={isDark}
                fileName={parsed.fileName} fileSize={parsed.fileSize}
                headers={parsed.headers} rows={parsed.rows} rowCount={parsed.rowCount}
                totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
                fields={BUNDLE_CANONICAL_FIELDS} mapping={mapping}
                continueLabel="Continue to Column Mapping"
                onContinue={() => setStep("mapping")}
                onReplace={resetAll}
                onRemove={resetAll}
              />
            )}
            <div style={{ padding: "0 24px 24px", maxWidth: 900 }}>
              <ImportToolkit isDark={isDark} fields={BUNDLE_CANONICAL_FIELDS} config={BUNDLE_IMPORT_TOOLKIT} />
            </div>
            {showHistory && (
              <div style={{ padding: "0 24px 24px", maxWidth: 720 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import History</p>
                <ImportHistoryPanel isDark={isDark} module="bundle" emptyHint="Completed bulk bundle imports will show up here." />
              </div>
            )}
          </>
        )}

        {step === "mapping" && parsed && (
          <ImportMappingStep
            isDark={isDark}
            headers={parsed.headers}
            sampleRow={sampleRow}
            fields={BUNDLE_CANONICAL_FIELDS}
            mapping={mapping}
            suggestions={suggestions}
            validating={checkingDuplicates}
            error={validateError}
            onChangeMapping={handleChangeMapping}
            onContinue={runValidate}
            onBack={() => setStep("upload")}
          />
        )}

        {step === "preview" && validateResult && (
          <BundleImportPreviewStep isDark={isDark} result={validateResult} onBack={() => setStep("mapping")} onCreate={() => setStep("create")} />
        )}

        {step === "create" && validateResult && file && (
          <ImportCreateStep
            isDark={isDark}
            items={createItems}
            excluded={excludedItems}
            totalCount={validateResult.groups.length}
            warningsCount={validateResult.summary.warnings}
            nounSingular="Bundle"
            nounPlural="Bundles"
            objectApiName="Product2"
            onBack={onBack}
            onComplete={({ created, failed }) => saveImportHistoryEntry({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              module: "bundle",
              fileName: file.name,
              importedAt: new Date().toISOString(),
              total: validateResult.groups.length,
              created,
              failed,
              skipped: excludedGroups.length,
            })}
          />
        )}
      </div>
    </PageShell>
  );
}
