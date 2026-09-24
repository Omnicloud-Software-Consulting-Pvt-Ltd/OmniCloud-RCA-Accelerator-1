"use client";

import { useState } from "react";
import { Ic, tokens, PageShell, type ErrorPanelData } from "@/components/data/quotes/shared";
import { ATTRIBUTE_FIELDS, ATTRIBUTE_IMPORT_TOOLKIT, type AttributeCanonicalField } from "@/lib/attributes/import/columnMapping";
import { suggestColumnMapping, toMappingRecord, type ColumnMappingSuggestion } from "@/lib/import/columnMapping";
import type { ValidateAttributeImportResult, AttributeProductGroup, ParsedRCAData } from "@/lib/attributes/import/validateRows";
import type { ImportParseResponse } from "@/app/api/import/parse/route";
import type { AttributeImportValidateResponse } from "@/app/api/sf/attributes/import/validate/route";
import { saveImportHistoryEntry } from "@/lib/import/history";
import ImportUploadStep from "@/components/import/ImportUploadStep";
import ImportUploadReview from "@/components/import/ImportUploadReview";
import ImportStepIndicator from "@/components/import/ImportStepIndicator";
import ImportFileStrip from "@/components/import/ImportFileStrip";
import ImportToolkit from "@/components/import/ImportToolkit";
import ImportMappingStep from "@/components/import/ImportMappingStep";
import ImportCreateStep, { type CreateQueueItem, type ExcludedQueueItem } from "@/components/import/ImportCreateStep";
import ImportHistoryPanel from "@/components/import/ImportHistoryPanel";
import AttributeImportPreviewStep from "./AttributeImportPreviewStep";

type Step = "upload" | "mapping" | "preview" | "create";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "mapping", label: "Map & Validate" },
  { id: "preview", label: "Preview" },
  { id: "create", label: "Create Attributes" },
];

/** A single execute-batch call's response shape — mirrors what /api/sf/attributes/execute-batch actually returns (§ confirmed against RCAAttributeStudio.tsx's own calling contract). */
interface ExecuteBatchResponse {
  success: boolean;
  error?: string;
  logs?: string[];
  context?: Record<string, unknown>;
  storageHealth?: unknown;
}

/**
 * Runs ONE product group's attributes through the SAME
 * POST /api/sf/attributes/execute-batch pipeline RCAAttributeStudio's
 * "Deploy All" already uses — batches 0-6 (schema discovery, picklist,
 * picklist values, AttributeDefinition, ProductClassification, Product2,
 * PCA→PAD linking). `context.productId` is pre-seeded with the already-
 * resolved Product Id, which execute-batch's own Batch 5 explicitly
 * supports (skips its own Product2 search/creation and reuses the given Id
 * as-is — the exact escape hatch RCAAttributeStudio's own Product Not Found
 * recovery flow uses). Batch 7 ("Commercial Enablement" — ProductCatalog/
 * Category/SellingModel/PricebookEntry) is deliberately never called: it's
 * unrelated to attaching an attribute to an already-commercially-enabled
 * existing product, and skipping it avoids N redundant Salesforce round
 * trips across N product groups for something Batches 0-6 never depend on.
 *
 * Each product group runs its OWN independent 7-call chain rather than
 * sharing `context` across groups — attributePicklistIds/attributeDefIds in
 * that context are keyed by attribute NAME, not product-scoped, so carrying
 * them from Product A's run into Product B's would incorrectly reuse
 * Product A's picklist/definition for an identically-named attribute on a
 * completely different product.
 */
async function createAttributeGroup(group: AttributeProductGroup): Promise<{ id?: string; error?: string; note?: string }> {
  if (!group.parsedRCAData || !group.resolvedProductId) return { error: "This product was excluded during validation." };
  const parsedData: ParsedRCAData = group.parsedRCAData;
  let context: Record<string, unknown> = { productId: group.resolvedProductId };

  for (let batchIndex = 0; batchIndex <= 6; batchIndex++) {
    let res: Response;
    try {
      res = await fetch("/api/sf/attributes/execute-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchIndex, parsedData, context }),
      });
    } catch {
      return { error: `Network error while creating attributes for "${group.productName}" (batch ${batchIndex}).` };
    }
    const data = (await res.json().catch(() => null)) as ExecuteBatchResponse | null;
    if (!res.ok || !data || data.success === false) {
      return { error: data?.error ?? `Batch ${batchIndex} failed for "${group.productName}" (HTTP ${res.status}).` };
    }
    if (data.context) context = data.context;
  }

  const attributeDefIds = (context.attributeDefIds as Record<string, string> | undefined) ?? {};
  const createdCount = Object.keys(attributeDefIds).length;
  const expectedCount = parsedData.attributes.length;
  if (createdCount === 0) {
    return { error: `No attributes were created for "${group.productName}" — the org may be missing required Attribute object permissions. Check server logs.` };
  }
  const note = createdCount < expectedCount
    ? `${createdCount} of ${expectedCount} attribute(s) created for "${group.productName}" — see server logs for the rest.`
    : undefined;
  return { id: group.resolvedProductId, note };
}

/**
 * Bulk Attribute importer — Upload → Map & Validate → Preview → Create
 * Attributes. Every attribute this wizard creates goes through the SAME
 * existing POST /api/sf/attributes/execute-batch pipeline the AI-prompt-
 * based Attribute Studio already uses — this component only orchestrates
 * file parsing, column mapping, row-grouping-by-Product-Name, and
 * Salesforce-side validation/preview. It never re-implements attribute
 * creation, and never touches RCAAttributeStudio.tsx or execute-batch's own
 * implementation.
 */
export default function AttributeImportWizard({ isDark, onBack, startWithHistory }: { isDark: boolean; onBack: () => void; startWithHistory?: boolean }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("upload");
  const [showHistory, setShowHistory] = useState(!!startWithHistory);

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ImportParseResponse | null>(null);
  const [suggestions, setSuggestions] = useState<ColumnMappingSuggestion<AttributeCanonicalField>[]>([]);
  const [mapping, setMapping] = useState<Record<AttributeCanonicalField, string | null>>(
    Object.fromEntries(ATTRIBUTE_FIELDS.map(f => [f.key, null])) as Record<AttributeCanonicalField, string | null>,
  );

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<ErrorPanelData | null>(null);
  const [validateResult, setValidateResult] = useState<ValidateAttributeImportResult | null>(null);

  const resetAll = () => {
    setFile(null); setParsed(null); setSuggestions([]);
    setMapping(Object.fromEntries(ATTRIBUTE_FIELDS.map(f => [f.key, null])) as Record<AttributeCanonicalField, string | null>);
    setValidateResult(null); setValidateError(null);
    setStep("upload");
  };

  const handleParsed = (uploadedFile: File, result: ImportParseResponse) => {
    setFile(uploadedFile);
    setParsed(result);
    const guesses = suggestColumnMapping(result.headers, ATTRIBUTE_FIELDS);
    setSuggestions(guesses);
    setMapping(toMappingRecord(guesses, ATTRIBUTE_FIELDS));
  };

  const handleChangeMapping = (header: string, field: AttributeCanonicalField | null) => {
    setMapping(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next) as AttributeCanonicalField[]) {
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
      const res = await fetch("/api/sf/attributes/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows, mapping }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setValidateError({ title: "Could not validate this import", message: data.error ?? "Unknown error" });
        return;
      }
      setValidateResult(data as AttributeImportValidateResponse);
      setStep("preview");
    } catch {
      setValidateError({ title: "Network error", message: "Could not reach the server to validate this import." });
    } finally {
      setValidating(false);
    }
  };

  const sampleRow = parsed?.rows[0] ?? null;
  const currentStepIndex = STEP_LABELS.findIndex(s => s.id === step);

  const createItems: CreateQueueItem[] = (validateResult?.groups ?? [])
    .filter(g => g.parsedRCAData)
    .map(g => ({ index: g.index, name: g.productName, create: () => createAttributeGroup(g) }));
  const excludedItems: ExcludedQueueItem[] = (validateResult?.groups ?? [])
    .filter(g => !g.parsedRCAData)
    .map(g => ({
      index: g.index, name: g.productName,
      reason: g.issues.find(i => i.level === "error")?.message ?? "No new attributes to create for this product — every row already exists or was invalid.",
    }));

  return (
    <PageShell>
      <div style={{ padding: "20px 24px 0" }}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>Import Attributes</h2>
            <p style={{ fontSize: 12, color: t.dim, marginTop: 4, maxWidth: 560 }}>
              Upload a CSV or Excel file to bulk-create attributes for existing Products.
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
              <ImportUploadStep isDark={isDark} parseEndpoint="/api/import/parse" dropLabel="Drag and drop your attribute file here" onParsed={handleParsed} />
            ) : (
              <ImportUploadReview
                isDark={isDark}
                fileName={parsed.fileName} fileSize={parsed.fileSize}
                headers={parsed.headers} rows={parsed.rows} rowCount={parsed.rowCount}
                totalRowsInFile={parsed.totalRowsInFile} truncated={parsed.truncated}
                fields={ATTRIBUTE_FIELDS} mapping={mapping}
                continueLabel="Continue to Column Mapping"
                onContinue={() => setStep("mapping")}
                onReplace={resetAll}
                onRemove={resetAll}
              />
            )}
            <div style={{ padding: "0 24px 24px", maxWidth: 900 }}>
              <ImportToolkit isDark={isDark} fields={ATTRIBUTE_FIELDS} config={ATTRIBUTE_IMPORT_TOOLKIT} />
            </div>
            {showHistory && (
              <div style={{ padding: "0 24px 24px", maxWidth: 720 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: t.dim, marginBottom: 10 }}>Import History</p>
                <ImportHistoryPanel isDark={isDark} module="attribute" emptyHint="Completed bulk attribute imports will show up here." />
              </div>
            )}
          </>
        )}

        {step === "mapping" && parsed && (
          <ImportMappingStep
            isDark={isDark}
            headers={parsed.headers}
            sampleRow={sampleRow}
            fields={ATTRIBUTE_FIELDS}
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
                Rows sharing the same mapped &quot;Product Name&quot; value are grouped into one product&apos;s attribute set.
              </p>
            )}
          />
        )}

        {step === "preview" && validateResult && (
          <AttributeImportPreviewStep
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
            warningsCount={validateResult.summary.warningProducts}
            nounSingular="Product's Attributes"
            nounPlural="Products' Attributes"
            objectApiName="Product2"
            onBack={onBack}
            onComplete={({ created, failed }) => saveImportHistoryEntry({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              module: "attribute",
              fileName: file.name,
              importedAt: new Date().toISOString(),
              total: validateResult.groups.length,
              created,
              failed,
              skipped: validateResult.groups.filter(g => !g.parsedRCAData).length,
            })}
          />
        )}
      </div>
    </PageShell>
  );
}
