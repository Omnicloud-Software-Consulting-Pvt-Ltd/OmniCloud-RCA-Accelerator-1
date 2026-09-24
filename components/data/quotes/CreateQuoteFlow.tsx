"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, formatCurrency,
  PageShell, FooterBar, EmptyState, Spinner, ErrorPanel, Pill, CodeBlock,
} from "@/components/data/quotes/shared";
import ReferenceLookup, { type ReferenceLookupHandle, type ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import LineItemsEditor from "@/components/data/quotes/LineItemsEditor";
import PreviewPanel from "@/components/data/quotes/PreviewPanel";
import LineItemFailureView from "@/components/data/quotes/LineItemFailureView";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { replayServerSteps } from "@/lib/quotes/client/executionLog";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import { sumDraftTreeTotal, flattenDraftTree } from "@/lib/quotes/pricing/calc";
import type {
  BundleHierarchyStep, LineItemCreationResult, LineItemFailureDetail, QuoteCreateResult, QuoteFieldSchema, QuoteFormData, QuoteLineItemDraft,
} from "@/lib/quotes/types";

type Step = "details" | "lines" | "preview" | "success";

const EMPTY_FORM: QuoteFormData = {
  name: "", accountName: "", pricebookName: "", opportunityName: "",
  startDate: "", expirationDate: "", status: "", description: "",
};

const DRAFT_KEY = "omnicloud_quote_draft_v1";

interface DraftShape {
  savedAt: number;
  formData: QuoteFormData;
  accountValue: ReferenceLookupValue | null;
  pricebookValue: ReferenceLookupValue | null;
  opportunityValue: ReferenceLookupValue | null;
  aiPrompt: string;
  step: Step;
  quoteResult: QuoteCreateResult | null;
  lineRoots: QuoteLineItemDraft[];
}

function saveDraftToStorage(draft: Omit<DraftShape, "savedAt">) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    /* localStorage unavailable — draft save is a convenience, not required */
  }
}

function loadDraftFromStorage(): DraftShape | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as DraftShape) : null;
  } catch {
    return null;
  }
}

function clearDraftFromStorage() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
}

const STEPS: { id: Step; label: string; icon: string }[] = [
  { id: "details", label: "Quote Details", icon: "file-text" },
  { id: "lines", label: "Quote Line Items", icon: "list" },
  { id: "preview", label: "Preview", icon: "eye" },
  { id: "success", label: "Done", icon: "check-circle" },
];

function StepHeader({ step, isDark }: { step: Step; isDark: boolean }) {
  const t = tokens(isDark);
  const idx = STEPS.findIndex(s => s.id === step);
  return (
    <div style={{ padding: "16px 20px 0", flexShrink: 0 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {STEPS.map((s, i) => (
          <div key={s.id} style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            padding: "9px 10px", borderRadius: 9, fontSize: 11.5, fontWeight: 600,
            background: i <= idx ? `${t.accent}18` : "transparent", color: i <= idx ? t.accent : t.dim,
            border: `1px solid ${i <= idx ? t.accent + "40" : t.border}`,
          }}>
            <Ic n={i < idx ? "check" : s.icon} s={13} />
            <span>{i + 1}. {s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldGroup({ title, icon, isDark, children }: { title: string; icon: string; isDark: boolean; children: ReactNode }) {
  const t = tokens(isDark);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 10 }}>
        <Ic n={icon} s={12} /> {title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>{children}</div>
    </div>
  );
}

export default function CreateQuoteFlow({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const [step, setStep] = useState<Step>("details");
  const [schema, setSchema] = useState<QuoteFieldSchema | null>(null);
  const [formData, setFormData] = useState<QuoteFormData>(EMPTY_FORM);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ErrorPanelDataLike | null>(null);
  const [quoteResult, setQuoteResult] = useState<QuoteCreateResult | null>(null);
  const [lineRoots, setLineRoots] = useState<QuoteLineItemDraft[]>([]);
  const [linesValid, setLinesValid] = useState(false);
  // §Race-condition fix (Antivirus-class failure): true while any product's
  // /products/configure call is still in flight — blocks "Next: Preview" so
  // a line can never advance to submission before its Selling Model/Billing
  // Frequency resolution has actually completed.
  const [linesConfiguring, setLinesConfiguring] = useState(false);
  const [submittingLines, setSubmittingLines] = useState(false);
  const [lineItemResult, setLineItemResult] = useState<LineItemCreationResult | null>(null);
  const [lineItemError, setLineItemError] = useState<ErrorPanelDataLike | null>(null);
  const [restoreBanner, setRestoreBanner] = useState<DraftShape | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [highlightLogId, setHighlightLogId] = useState<string | null>(null);
  const [quoteWarnings, setQuoteWarnings] = useState<string[]>([]);

  const [accountValue, setAccountValue] = useState<ReferenceLookupValue | null>(null);
  const accountLookupRef = useRef<ReferenceLookupHandle>(null);
  const [pricebookValue, setPricebookValue] = useState<ReferenceLookupValue | null>(null);
  const pricebookLookupRef = useRef<ReferenceLookupHandle>(null);
  const [opportunityValue, setOpportunityValue] = useState<ReferenceLookupValue | null>(null);
  const opportunityLookupRef = useRef<ReferenceLookupHandle>(null);

  function handleAccountChange(next: ReferenceLookupValue | null) {
    setAccountValue(next);
    setFormData(f => ({ ...f, accountName: next?.name ?? "" }));
  }

  function handlePricebookChange(next: ReferenceLookupValue | null) {
    setPricebookValue(next);
    setFormData(f => ({ ...f, pricebookName: next?.name ?? "" }));
  }

  function handleOpportunityChange(next: ReferenceLookupValue | null) {
    setOpportunityValue(next);
    setFormData(f => ({ ...f, opportunityName: next?.name ?? "" }));
  }

  useEffect(() => {
    quoteApiGet<{ schema: QuoteFieldSchema }>("Resolve Quote schema", "/api/quotes/schema")
      .then(res => setSchema(res.schema))
      .catch(() => setSchema(null));
    const draft = loadDraftFromStorage();
    if (draft) setRestoreBanner(draft);
  }, []);

  const requestPreview = useMemo(() => ({ quoteId: quoteResult?.id, pricebookId: pricebookValue?.id, draftRoots: lineRoots }), [quoteResult, pricebookValue, lineRoots]);
  const total = useMemo(() => sumDraftTreeTotal(lineRoots), [lineRoots]);
  const flatLines = useMemo(() => flattenDraftTree(lineRoots), [lineRoots]);

  function handleRestoreDraft() {
    if (!restoreBanner) return;
    setFormData(restoreBanner.formData);
    setAccountValue(restoreBanner.accountValue ?? null);
    setPricebookValue(restoreBanner.pricebookValue ?? null);
    setOpportunityValue(restoreBanner.opportunityValue ?? null);
    setAiPrompt(restoreBanner.aiPrompt);
    setQuoteResult(restoreBanner.quoteResult);
    setLineRoots(restoreBanner.lineRoots);
    setStep(restoreBanner.quoteResult ? "lines" : "details");
    setDraftSavedAt(restoreBanner.savedAt);
    setRestoreBanner(null);
  }

  function handleDiscardDraft() {
    clearDraftFromStorage();
    setRestoreBanner(null);
  }

  function handleSaveDraft() {
    saveDraftToStorage({ formData, accountValue, pricebookValue, opportunityValue, aiPrompt, step, quoteResult, lineRoots });
    setDraftSavedAt(Date.now());
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const res = await quoteApiPost<{ fields: QuoteFormData }>("AI parse quote", "/api/quotes/ai/parse-quote", { prompt: aiPrompt });
      setFormData(prev => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(res.fields)) {
          if (key === "accountName" || key === "pricebookName" || key === "opportunityName") continue; // resolved against Salesforce via their lookups below, never trusted as raw text
          if (value) (next as Record<string, string>)[key] = value as string;
        }
        return next;
      });
      // §AI Prompt Matching: the AI only extracts a name — never populate a
      // lookup field with unresolved text. Exactly one Salesforce match
      // auto-selects; multiple opens the lookup for the user to pick; zero
      // leaves it empty with a "no match" message.
      if (res.fields.accountName?.trim()) {
        await accountLookupRef.current?.searchAndResolve(res.fields.accountName);
      }
      if (res.fields.pricebookName?.trim()) {
        await pricebookLookupRef.current?.searchAndResolve(res.fields.pricebookName);
      }
      if (res.fields.opportunityName?.trim()) {
        await opportunityLookupRef.current?.searchAndResolve(res.fields.opportunityName);
      }
    } catch {
      // AI parsing failure is non-fatal — the form remains manually editable.
    } finally {
      setAiLoading(false);
    }
  }

  async function handleCreateQuote() {
    setCreating(true);
    setCreateError(null);
    setQuoteWarnings([]);
    try {
      const res = await quoteApiPost<QuoteCreateResult & { success: true }>("Create Quote", "/api/quotes", { formData });
      replayServerSteps("Create Quote", res.steps);
      setQuoteWarnings(res.warnings ?? []);
      setQuoteResult(res);
      updateResponseSummary({ quote: { id: res.id, name: res.finalName } });
      setStep("lines");
    } catch (err) {
      const data = toErrorPanelData(err, "Could not create this Quote");
      setCreateError(data);
      const rawSteps = (data.raw as { steps?: BundleHierarchyStep[] } | undefined)?.steps;
      if (rawSteps) replayServerSteps("Create Quote", rawSteps);
      setHighlightLogId(data.logEntryId ?? null);
    } finally {
      setCreating(false);
    }
  }

  async function handleSubmitLines() {
    if (!quoteResult || !pricebookValue?.id) return;
    setSubmittingLines(true);
    setLineItemError(null);
    try {
      // A 422 response causes quoteApiPost to throw (non-2xx) — the success
      // path below only ever runs for a genuine 2xx create.
      const res = await quoteApiPost<LineItemCreationResult & { success: true }>(
        "Create line items", `/api/quotes/${quoteResult.id}/line-items`, { pricebookId: pricebookValue.id, draftRoots: lineRoots },
      );
      replayServerSteps("Create Line Items", res.steps);
      setLineItemResult(res);
      updateResponseSummary({ lineItems: { count: res.createdCount, ids: res.createdIds }, bundleResult: res, repricing: res.repricing });
      clearDraftFromStorage();
      setStep("success");

      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Quote", quoteResult.id, quoteResult.finalName);
        notifySalesforceSuccess({
          title: "Quote Created Successfully",
          message: res.createdCount > 0
            ? `${record.recordName} and ${res.createdCount} Quote Line Item${res.createdCount === 1 ? "" : "s"} were successfully created in Salesforce.`
            : `${record.recordName} has been successfully created in Salesforce.`,
          records: [record],
        });
      }
    } catch (err) {
      const data = toErrorPanelData(err, "Line item creation failed validation");
      setLineItemError(data);
      setHighlightLogId(data.logEntryId ?? null);
      const rawResult = data.raw as LineItemCreationResult | undefined;
      if (rawResult?.steps) replayServerSteps("Create Line Items", rawResult.steps);
      if (rawResult) {
        updateResponseSummary({ bundleResult: rawResult });
        setLineItemResult(rawResult);
      }
    } finally {
      setSubmittingLines(false);
    }
  }

  function handleStartOver() {
    clearDraftFromStorage();
    setStep("details"); setFormData(EMPTY_FORM); setAccountValue(null); setPricebookValue(null); setOpportunityValue(null); setAiPrompt(""); setQuoteResult(null);
    setLineRoots([]); setLinesValid(false); setLineItemResult(null); setLineItemError(null); setCreateError(null);
  }

  const footer = (
    <FooterBar isDark={isDark}>
      <div style={{ display: "flex", gap: 8 }}>
        {step !== "details" && step !== "success" && (
          <GhostButton
            label="Back" icon="arrow-left" isDark={isDark}
            onClick={() => setStep(step === "lines" ? "details" : step === "preview" ? "lines" : "details")}
          />
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {draftSavedAt && step !== "success" && <span style={{ fontSize: 10.5, color: t.dim }}>Draft saved {new Date(draftSavedAt).toLocaleTimeString()}</span>}
        {step !== "success" && <GhostButton label="Save Draft" icon="save" isDark={isDark} onClick={handleSaveDraft} />}
        {step === "details" && (
          <PrimaryButton
            label={creating ? "Creating…" : "Next: Add Line Items"} icon="arrow-right" isDark={isDark}
            disabled={creating || !formData.name.trim() || !pricebookValue?.id}
            onClick={handleCreateQuote}
          />
        )}
        {step === "lines" && (
          <PrimaryButton
            label={linesConfiguring ? "Resolving product configuration…" : "Next: Preview"}
            icon="arrow-right" isDark={isDark}
            disabled={!linesValid || lineRoots.length === 0 || linesConfiguring}
            onClick={() => setStep("preview")}
          />
        )}
        {step === "preview" && (
          <PrimaryButton label={submittingLines ? "Creating…" : "Create Quote"} icon="check" isDark={isDark} disabled={submittingLines} onClick={handleSubmitLines} />
        )}
        {step === "success" && (
          <PrimaryButton label="Create Another Quote" icon="plus" isDark={isDark} onClick={handleStartOver} />
        )}
      </div>
    </FooterBar>
  );

  return (
    <PageShell header={<StepHeader step={step} isDark={isDark} />} footer={footer}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20 }}>
        {restoreBanner && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.accent}50`, background: `${t.accent}10` }}>
            <div style={{ fontSize: 12.5, color: t.body, display: "flex", alignItems: "center", gap: 8 }}>
              <Ic n="save" s={14} /> You have an unsaved draft from {new Date(restoreBanner.savedAt).toLocaleString()}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <GhostButton label="Discard" isDark={isDark} onClick={handleDiscardDraft} />
              <PrimaryButton label="Restore Draft" icon="refresh" isDark={isDark} onClick={handleRestoreDraft} />
            </div>
          </div>
        )}

        {step === "details" && (
          <>
            <Section title="Describe this quote (AI)" icon="sparkles" isDark={isDark}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <textarea
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  placeholder='e.g. "Create a quote for Acme Corp using the Standard price book, starting next Monday, status Draft"'
                  rows={2}
                  style={{ ...inputStyle(t), flex: "1 1 320px", resize: "vertical" }}
                />
                <PrimaryButton label={aiLoading ? "Generating…" : "Generate"} icon="sparkles" isDark={isDark} disabled={aiLoading} onClick={handleAiGenerate} />
              </div>
              {aiLoading && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim }}><Spinner isDark={isDark} size={12} /> Parsing with Claude…</div>}
              <div style={{ marginTop: 10 }}>
                <PromptGuide isDark={isDark} config={promptGuideConfig.quote} onUseExample={setAiPrompt} />
              </div>
            </Section>

            <Section title="Quote Details" icon="file-text" isDark={isDark}>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <FieldGroup title="Customer & Commercial" icon="briefcase" isDark={isDark}>
                  {schema?.nameField && (
                    <Field label={schema.nameField.label} isDark={isDark}>
                      <input value={formData.name} onChange={e => setFormData(f => ({ ...f, name: e.target.value }))} style={inputStyle(t)} />
                    </Field>
                  )}
                  <Field label={schema?.accountField?.label ?? "Account"} isDark={isDark}>
                    <ReferenceLookup
                      ref={accountLookupRef}
                      isDark={isDark}
                      objectType="Account"
                      searchEndpoint="/api/quotes/reference/search"
                      value={accountValue}
                      onChange={handleAccountChange}
                      placeholder="Search accounts…"
                      noMatchHint="No matching Account found. Please select an existing Account."
                    />
                  </Field>
                  <Field label="Price Book" isDark={isDark} hint="Required — used to search the product catalog for line items">
                    <ReferenceLookup
                      ref={pricebookLookupRef}
                      isDark={isDark}
                      objectType="Pricebook2"
                      searchEndpoint="/api/quotes/reference/search"
                      value={pricebookValue}
                      onChange={handlePricebookChange}
                      placeholder="Search price books…"
                      noMatchHint="No matching Price Book found. Please select an existing Price Book."
                    />
                  </Field>
                  {schema?.opportunityField && (
                    <Field label={schema.opportunityField.label} isDark={isDark}>
                      <ReferenceLookup
                        ref={opportunityLookupRef}
                        isDark={isDark}
                        objectType="Opportunity"
                        searchEndpoint="/api/quotes/reference/search"
                        value={opportunityValue}
                        onChange={handleOpportunityChange}
                        placeholder="Search opportunities…"
                        noMatchHint="No matching Opportunity found. Please select an existing Opportunity."
                      />
                    </Field>
                  )}
                </FieldGroup>

                {(schema?.startDateField || schema?.expirationDateField || schema?.statusField) && (
                  <FieldGroup title="Schedule & Status" icon="calendar" isDark={isDark}>
                    {schema?.startDateField && (
                      <Field label={schema.startDateField.label} isDark={isDark}>
                        <input type="date" value={formData.startDate} onChange={e => setFormData(f => ({ ...f, startDate: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                    {schema?.expirationDateField && (
                      <Field label={schema.expirationDateField.label} isDark={isDark}>
                        <input type="date" value={formData.expirationDate} onChange={e => setFormData(f => ({ ...f, expirationDate: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                    {schema?.statusField && (
                      <Field label={schema.statusField.label} isDark={isDark}>
                        <select value={formData.status || schema.statusField.defaultValue || ""} onChange={e => setFormData(f => ({ ...f, status: e.target.value }))} style={inputStyle(t)}>
                          <option value="">Select…</option>
                          {schema.statusField.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </Field>
                    )}
                  </FieldGroup>
                )}

                {schema?.descriptionField && (
                  <FieldGroup title="Description" icon="edit" isDark={isDark}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <Field label={schema.descriptionField.label} isDark={isDark}>
                        <textarea value={formData.description} onChange={e => setFormData(f => ({ ...f, description: e.target.value }))} rows={3} style={{ ...inputStyle(t), resize: "vertical" }} />
                      </Field>
                    </div>
                  </FieldGroup>
                )}

                {!schema && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}>
                    <Spinner isDark={isDark} size={13} /> Resolving Quote field schema from Salesforce…
                  </div>
                )}
              </div>
            </Section>

            {createError && <ErrorPanel isDark={isDark} error={createError} onViewLogs={() => setHighlightLogId(createError.logEntryId ?? null)} />}
          </>
        )}

        {step === "lines" && quoteResult && pricebookValue?.id && (
          <>
            {quoteWarnings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.warn}50`, background: `${t.warn}10` }}>
                {quoteWarnings.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: t.body }}>
                    <span style={{ flexShrink: 0, color: t.warn }}><Ic n="info" s={13} /></span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
            <LineItemsEditor isDark={isDark} pricebookId={pricebookValue.id} onChange={(roots, valid, isConfiguring) => { setLineRoots(roots); setLinesValid(valid); setLinesConfiguring(isConfiguring); }} initialRoots={lineRoots} />
          </>
        )}

        {step === "preview" && (
          <>
            <Section title="Quote Summary" icon="file-text" isDark={isDark}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <SummaryField t={t} label="Customer" value={formData.accountName || "—"} />
                <SummaryField t={t} label="Opportunity" value={formData.opportunityName || "—"} />
                <SummaryField t={t} label="Price Book" value={formData.pricebookName || "—"} />
                <SummaryField t={t} label="Start Date" value={formData.startDate || "—"} />
                <SummaryField t={t} label="Expiration Date" value={formData.expirationDate || "—"} />
                <SummaryField t={t} label="Status" value={formData.status || "—"} />
              </div>
            </Section>

            <Section title={`Quote Line Items & Bundle Hierarchy (${flatLines.length})`} icon="layers" isDark={isDark}>
              <PreviewLineTree isDark={isDark} roots={lineRoots} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.border}`, fontSize: 14, fontWeight: 700, color: t.heading }}>
                <span>Total (pricing & discounts applied)</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </Section>

            <Section title="Request, Logs & Response" icon="terminal" isDark={isDark}>
              <PreviewPanel isDark={isDark} requestJson={requestPreview} highlightLogId={highlightLogId} />
            </Section>

            {lineItemError && (
              <Section title="Why did this fail?" icon="alert" isDark={isDark}>
                {lineItemError.failureDetail ? (
                  <LineItemFailureView isDark={isDark} detail={lineItemError.failureDetail as LineItemFailureDetail} />
                ) : (
                  <ErrorPanel isDark={isDark} error={lineItemError} onViewLogs={() => setHighlightLogId(lineItemError.logEntryId ?? null)} />
                )}
              </Section>
            )}
          </>
        )}

        {step === "success" && lineItemResult && quoteResult && (
          <>
            {lineItemResult.pricingVerified ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 700, color: t.accent, padding: "6px 0" }}>
                <Ic n="check-circle" s={20} /> Quote {quoteResult.finalName} created with {lineItemResult.createdCount} line item(s)
              </div>
            ) : (
              // §$0.00 pricing bug: a $0.00 authoritative price on a line
              // that should have priced non-zero must NEVER read as a clean
              // success — this banner is the explicit "Pricing verification
              // failed" signal instead of "Quote successfully created".
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 700, color: t.error, padding: "6px 0" }}>
                <Ic n="alert" s={20} /> Pricing verification failed — Quote {quoteResult.finalName} was created with {lineItemResult.createdCount} line item(s), but Salesforce returned $0.00 for one or more lines expected to price non-zero
              </div>
            )}

            {salesforceRecordUrl(quoteResult.id) && (
              <a
                href={salesforceRecordUrl(quoteResult.id)!} target="_blank" rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: t.accent, textDecoration: "none", marginTop: -6 }}
              >
                <Ic n="external-link" s={13} /> View in Salesforce
              </a>
            )}
            {lineItemResult.issues.length > 0 && (
              <div style={{ marginTop: -4, marginBottom: 10, padding: 10, borderRadius: 10, border: `1px solid ${(lineItemResult.pricingVerified ? t.warn : t.error)}50`, fontSize: 12 }}>
                {lineItemResult.issues.map((issue, i) => <div key={i} style={{ color: t.body }}>• {issue}</div>)}
              </div>
            )}
            {lineItemResult.repricing && !lineItemResult.repricing.succeeded && (
              // §Do not hide Salesforce errors: the exact endpoint, request,
              // and every per-record error entry (errorCode/message/fields/
              // extra) Salesforce returned — never collapsed to the single
              // summary message shown above. Open by default specifically
              // because repricing failed; nothing about a $0.00 quote
              // should require digging into a collapsed panel to see why.
              <Section title="Repricing Trace — why Salesforce rejected pricing" icon="alert" isDark={isDark} defaultOpen={true}>
                <div style={{ fontSize: 12, color: t.body, marginBottom: 8 }}>{lineItemResult.repricing.message}</div>
                {lineItemResult.repricing.transcript && (
                  // §Never bury the raw HTTP evidence inside a collapsed JSON
                  // tree — status/statusText/content-type/raw response text
                  // are the exact fields repeatedly needed to diagnose this,
                  // shown as plain readable text before the full JSON dump.
                  <div style={{ marginBottom: 10, padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 11.5, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                    <div>HTTP Status: {lineItemResult.repricing.transcript.status} {lineItemResult.repricing.transcript.statusText}</div>
                    <div>Content-Type: {lineItemResult.repricing.transcript.contentType ?? "(none)"}</div>
                    <div>JSON parse error: {lineItemResult.repricing.transcript.jsonParseError ?? "(none — parsed successfully)"}</div>
                    <div style={{ marginTop: 6 }}>Raw response text:</div>
                    <div style={{ marginTop: 2, color: t.dim }}>{lineItemResult.repricing.transcript.rawText || "(empty body)"}</div>
                  </div>
                )}
                <CodeBlock isDark={isDark} data={lineItemResult.repricing} defaultExpanded />
              </Section>
            )}
            {lineItemResult.pricingTrace.length > 0 && (
              // §Price Pipeline Trace: every checkpoint for every
              // non-included line — PBE price, create payload, price
              // immediately after insert, List Price applied, final
              // re-query. Starts collapsed even on a verification failure —
              // the red "Pricing verification failed" banner above already
              // surfaces that loudly; this stays a quiet one-click-away
              // detail view rather than forcing itself open.
              <Section title="Price Pipeline Trace" icon="dollar-sign" isDark={isDark} defaultOpen={false}>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {lineItemResult.pricingTrace.map((line, i) => (
                    <div key={i} style={{ padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 12 }}>
                      <div style={{ fontWeight: 700, color: t.heading, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                        {line.productName}
                        {line.pricingInclusion && <Pill label="Included in bundle" color={t.accentCyan} isDark={isDark} />}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 2, fontFamily: "monospace", color: t.body }}>
                        <span style={{ color: t.dim }}>PBE Price:</span><span>{formatCurrency(line.pricebookEntryPrice)}</span>
                        <span style={{ color: t.dim }}>Create Payload:</span>
                        <span>{line.createPayloadPrice != null ? `${formatCurrency(line.createPayloadPrice)} (${line.createPayloadFieldUsed})` : "OMITTED (no createable, non-calculated price field found on this org's QuoteLineItem)"}</span>
                        <span style={{ color: t.dim }}>After Insert:</span><span>{formatCurrency(line.priceAfterInsert)} <span style={{ color: t.dim }}>(source: {line.afterInsertSourceField ?? "none"})</span></span>
                        <span style={{ color: t.dim }}>List Price Write:</span>
                        <span>
                          {line.pricingInclusion
                            ? "N/A — included in parent"
                            : !line.listPriceWrite.attempted
                              ? "NOT attempted (no writable price field)"
                              : `attempted → ${formatCurrency(line.listPriceWrite.value ?? 0)} via ${line.listPriceWrite.field ?? "?"}; update ${line.listPriceWrite.updateSucceeded ? "succeeded" : "REJECTED"}; read-back ${line.listPriceWrite.readBackValue != null ? formatCurrency(line.listPriceWrite.readBackValue) : "(none)"}; confirmed: ${line.listPriceWrite.confirmed ? "yes" : "NO"}`}
                        </span>
                        <span style={{ color: t.dim }}>Final Salesforce:</span>
                        <span>
                          <span style={{ fontWeight: 700, color: !line.pricingInclusion && line.finalPrice === 0 && line.pricebookEntryPrice > 0 ? t.error : t.heading }}>{formatCurrency(line.finalPrice)}</span>
                          {" "}<span style={{ color: t.dim, fontWeight: 400 }}>(source: {line.finalPriceSourceField ?? "none"})</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            <Section title="Refreshed Line Items (authoritative, re-queried from Salesforce)" icon="list" isDark={isDark}>
              <RefreshedTable isDark={isDark} items={lineItemResult.refreshedLineItems} />
            </Section>
            <Section title="Full Details — Logs, JSON & Response" icon="terminal" isDark={isDark} defaultOpen={false}>
              <PreviewPanel isDark={isDark} requestJson={requestPreview} highlightLogId={highlightLogId} />
            </Section>
          </>
        )}
      </div>
    </PageShell>
  );
}

function SummaryField({ t, label, value }: { t: ReturnType<typeof tokens>; label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.heading, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function MetaBadge({ t, label }: { t: ReturnType<typeof tokens>; label: string }) {
  return <span style={{ fontSize: 10.5, color: t.dim, border: `1px solid ${t.border}`, borderRadius: 6, padding: "1px 6px" }}>{label}</span>;
}

/** Full per-line detail for Preview (§Preview) — Selling Model, Type, Billing Frequency, Billing Treatment, Subscription Term, PricebookEntry, bundle role. */
function PreviewLineTree({ isDark, roots }: { isDark: boolean; roots: QuoteLineItemDraft[] }) {
  const t = tokens(isDark);
  if (roots.length === 0) return <EmptyState isDark={isDark} icon="layers" title="No line items staged" />;

  function renderRows(nodes: QuoteLineItemDraft[], depth: number): ReactNode[] {
    return nodes.flatMap(node => [
      <div key={node.draftId} style={{ padding: "8px 0", marginLeft: depth * 18, borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
          <Ic n={node.isBundleParent ? "layers" : "cube"} s={13} />
          <span style={{ flex: 1, color: t.heading, fontWeight: depth === 0 ? 600 : 400 }}>{node.product.name}</span>
          <span style={{ color: t.dim, width: 50 }}>{node.quantity}×</span>
          <span style={{ color: t.dim, width: 60 }}>{node.discountPercent}% off</span>
          <span style={{ fontWeight: 700, color: t.heading, width: 90, textAlign: "right" }}>{formatCurrency(node.pricingInclusion ? 0 : node.quantity * node.unitPrice * (1 - node.discountPercent / 100))}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5, marginLeft: 23 }}>
          <MetaBadge t={t} label={`PricebookEntry: ${node.product.pricebookEntryId.slice(0, 12)}…`} />
          {node.sellingModelName && <MetaBadge t={t} label={`Selling Model: ${node.sellingModelName}`} />}
          {node.sellingModelType && <MetaBadge t={t} label={`Type: ${node.sellingModelType}`} />}
          <MetaBadge t={t} label={`Billing Frequency: ${node.billingFrequency ?? "—"}${node.billingFrequencySource ? ` (${node.billingFrequencySource})` : ""}`} />
          {node.billingTreatmentOutcome && <MetaBadge t={t} label={`Billing Treatment: ${node.billingTreatmentOutcome}`} />}
          {node.subscriptionTerm != null && <MetaBadge t={t} label={`Term: ${node.subscriptionTerm}`} />}
          <MetaBadge
            t={t}
            label={
              depth === 0
                ? (node.isBundleParent ? `Bundle (${node.children.length} component${node.children.length === 1 ? "" : "s"})` : "Standalone Product")
                : (node.isBundleParent ? `Nested Bundle (${node.children.length} component${node.children.length === 1 ? "" : "s"})` : "Bundle Child")
            }
          />
        </div>
      </div>,
      ...renderRows(node.children, depth + 1),
    ]);
  }
  return <div>{renderRows(roots, 0)}</div>;
}

function RefreshedTable({ isDark, items }: { isDark: boolean; items: LineItemCreationResult["refreshedLineItems"] }) {
  const t = tokens(isDark);
  function renderRows(nodes: typeof items, depth: number): ReactNode[] {
    return nodes.flatMap(node => [
      <div key={node.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, padding: "6px 0", marginLeft: depth * 16, borderBottom: `1px solid ${t.border}` }}>
        <span style={{ flex: 1, color: t.heading, display: "flex", alignItems: "center", gap: 6 }}>
          {node.productName}
          {node.pricingInclusion && <Pill label="Included" color={t.accentCyan} isDark={isDark} />}
        </span>
        <span style={{ width: 50, color: t.dim }}>{node.quantity}×</span>
        <span style={{ width: 90, color: t.dim }}>{formatCurrency(node.unitPrice)}</span>
        <span style={{ width: 90, fontWeight: 600, color: node.pricingInclusion ? t.dim : t.heading }}>
          {node.pricingInclusion ? "—" : formatCurrency(node.totalPrice)}
        </span>
      </div>,
      ...renderRows(node.children, depth + 1),
    ]);
  }
  if (items.length === 0) return <EmptyState isDark={isDark} icon="list" title="No line items returned" />;
  return <div>{renderRows(items, 0)}</div>;
}
