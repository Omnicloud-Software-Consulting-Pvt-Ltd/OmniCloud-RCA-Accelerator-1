"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, formatCurrency,
  PageShell, FooterBar, EmptyState, Spinner, ErrorPanel,
} from "@/components/data/quotes/shared";
import ReferenceLookup, { type ReferenceLookupHandle, type ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import LineItemsEditor from "@/components/data/orders/LineItemsEditor";
import OrderPreviewPanel from "@/components/data/orders/OrderPreviewPanel";
import OrderLineItemFailureView from "@/components/data/orders/OrderLineItemFailureView";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { replayServerSteps } from "@/lib/quotes/client/executionLog";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { sumDraftTreeTotal, flattenDraftTree } from "@/lib/quotes/pricing/calc";
import type { BundleHierarchyStep, QuoteLineItemDraft } from "@/lib/quotes/types";
import type { OrderCreateResult, OrderFieldSchema, OrderFormData, OrderLineItemCreationResult, OrderLineItemFailureDetail } from "@/lib/orders/types";

type Step = "details" | "lines" | "preview" | "success";

const EMPTY_FORM: OrderFormData = {
  accountName: "", pricebookName: "", effectiveDate: "", status: "", contractName: "",
  type: "", poNumber: "", poDate: "", description: "", sourceQuoteName: "",
};

const DRAFT_KEY = "omnicloud_order_draft_v1";

interface DraftShape {
  savedAt: number;
  formData: OrderFormData;
  accountValue: ReferenceLookupValue | null;
  contractValue: ReferenceLookupValue | null;
  pricebookValue: ReferenceLookupValue | null;
  sourceQuoteValue: ReferenceLookupValue | null;
  aiPrompt: string;
  step: Step;
  orderResult: OrderCreateResult | null;
  lineRoots: QuoteLineItemDraft[];
}

function saveDraftToStorage(draft: Omit<DraftShape, "savedAt">) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch { /* localStorage unavailable — draft save is a convenience, not required */ }
}
function loadDraftFromStorage(): DraftShape | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as DraftShape) : null;
  } catch { return null; }
}
function clearDraftFromStorage() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* noop */ }
}

const STEPS: { id: Step; label: string; icon: string }[] = [
  { id: "details", label: "Order Details", icon: "file-text" },
  { id: "lines", label: "Order Items", icon: "list" },
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

export default function CreateOrderFlow({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const [step, setStep] = useState<Step>("details");
  const [schema, setSchema] = useState<OrderFieldSchema | null>(null);
  const [formData, setFormData] = useState<OrderFormData>(EMPTY_FORM);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ErrorPanelDataLike | null>(null);
  const [orderResult, setOrderResult] = useState<OrderCreateResult | null>(null);
  const [lineRoots, setLineRoots] = useState<QuoteLineItemDraft[]>([]);
  const [linesValid, setLinesValid] = useState(false);
  const [submittingLines, setSubmittingLines] = useState(false);
  const [lineItemResult, setLineItemResult] = useState<OrderLineItemCreationResult | null>(null);
  const [lineItemError, setLineItemError] = useState<ErrorPanelDataLike | null>(null);
  const [restoreBanner, setRestoreBanner] = useState<DraftShape | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [highlightLogId, setHighlightLogId] = useState<string | null>(null);
  const [orderWarnings, setOrderWarnings] = useState<string[]>([]);

  const [accountValue, setAccountValue] = useState<ReferenceLookupValue | null>(null);
  const accountLookupRef = useRef<ReferenceLookupHandle>(null);
  const [contractValue, setContractValue] = useState<ReferenceLookupValue | null>(null);
  const contractLookupRef = useRef<ReferenceLookupHandle>(null);
  const [pricebookValue, setPricebookValue] = useState<ReferenceLookupValue | null>(null);
  const pricebookLookupRef = useRef<ReferenceLookupHandle>(null);
  const [sourceQuoteValue, setSourceQuoteValue] = useState<ReferenceLookupValue | null>(null);
  const sourceQuoteLookupRef = useRef<ReferenceLookupHandle>(null);

  function handleAccountChange(next: ReferenceLookupValue | null) {
    setAccountValue(next);
    setFormData(f => ({ ...f, accountName: next?.name ?? "" }));
  }

  function handleContractChange(next: ReferenceLookupValue | null) {
    setContractValue(next);
    setFormData(f => ({ ...f, contractName: next?.name ?? "" }));
  }

  function handlePricebookChange(next: ReferenceLookupValue | null) {
    setPricebookValue(next);
    setFormData(f => ({ ...f, pricebookName: next?.name ?? "" }));
  }

  function handleSourceQuoteChange(next: ReferenceLookupValue | null) {
    setSourceQuoteValue(next);
    setFormData(f => ({ ...f, sourceQuoteName: next?.name ?? "" }));
  }

  useEffect(() => {
    quoteApiGet<{ schema: OrderFieldSchema }>("Resolve Order schema", "/api/orders/schema")
      .then(res => setSchema(res.schema))
      .catch(() => setSchema(null));
    const draft = loadDraftFromStorage();
    if (draft) setRestoreBanner(draft);
  }, []);

  const requestPreview = useMemo(() => ({ orderId: orderResult?.id, pricebookId: pricebookValue?.id, draftRoots: lineRoots }), [orderResult, pricebookValue, lineRoots]);
  const total = useMemo(() => sumDraftTreeTotal(lineRoots), [lineRoots]);
  const flatLines = useMemo(() => flattenDraftTree(lineRoots), [lineRoots]);
  const contractLooksRequired = !!(schema?.contractRequiredForContractedType && /contract/i.test(formData.type ?? ""));

  function handleRestoreDraft() {
    if (!restoreBanner) return;
    setFormData(restoreBanner.formData);
    setAccountValue(restoreBanner.accountValue ?? null);
    setContractValue(restoreBanner.contractValue ?? null);
    setPricebookValue(restoreBanner.pricebookValue ?? null);
    setSourceQuoteValue(restoreBanner.sourceQuoteValue ?? null);
    setAiPrompt(restoreBanner.aiPrompt);
    setOrderResult(restoreBanner.orderResult);
    setLineRoots(restoreBanner.lineRoots);
    setStep(restoreBanner.orderResult ? "lines" : "details");
    setDraftSavedAt(restoreBanner.savedAt);
    setRestoreBanner(null);
  }
  function handleDiscardDraft() {
    clearDraftFromStorage();
    setRestoreBanner(null);
  }
  function handleSaveDraft() {
    saveDraftToStorage({ formData, accountValue, contractValue, pricebookValue, sourceQuoteValue, aiPrompt, step, orderResult, lineRoots });
    setDraftSavedAt(Date.now());
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const res = await quoteApiPost<{ fields: OrderFormData }>("AI parse order", "/api/orders/ai/parse-order", { prompt: aiPrompt });
      setFormData(prev => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(res.fields)) {
          // accountName/contractName/pricebookName/sourceQuoteName are resolved against Salesforce via their lookups below, never trusted as raw text.
          if (key === "accountName" || key === "contractName" || key === "pricebookName" || key === "sourceQuoteName") continue;
          if (value) (next as Record<string, string>)[key] = value as string;
        }
        return next;
      });
      // §AI Prompt Matching: the AI only extracts names — never populate a
      // lookup field with unresolved text. Exactly one Salesforce match
      // auto-selects; multiple opens the lookup for the user to pick; zero
      // leaves it empty with a "no match" message.
      if (res.fields.accountName?.trim()) {
        await accountLookupRef.current?.searchAndResolve(res.fields.accountName);
      }
      if (res.fields.contractName?.trim()) {
        await contractLookupRef.current?.searchAndResolve(res.fields.contractName);
      }
      if (res.fields.pricebookName?.trim()) {
        await pricebookLookupRef.current?.searchAndResolve(res.fields.pricebookName);
      }
      if (res.fields.sourceQuoteName?.trim()) {
        await sourceQuoteLookupRef.current?.searchAndResolve(res.fields.sourceQuoteName);
      }
    } catch {
      // AI parsing failure is non-fatal — the form remains manually editable.
    } finally {
      setAiLoading(false);
    }
  }

  async function handleCreateOrder() {
    setCreating(true);
    setCreateError(null);
    setOrderWarnings([]);
    try {
      const res = await quoteApiPost<OrderCreateResult & { success: true }>("Create Order", "/api/orders", { formData });
      replayServerSteps("Create Order", res.steps);
      setOrderWarnings(res.warnings ?? []);
      setOrderResult(res);
      updateResponseSummary({ order: { id: res.id, orderNumber: res.orderNumber, status: formData.status || null } });
      setStep("lines");
    } catch (err) {
      const data = toErrorPanelData(err, "Could not create this Order");
      setCreateError(data);
      const rawSteps = (data.raw as { steps?: BundleHierarchyStep[] } | undefined)?.steps;
      if (rawSteps) replayServerSteps("Create Order", rawSteps);
      setHighlightLogId(data.logEntryId ?? null);
    } finally {
      setCreating(false);
    }
  }

  async function handleSubmitLines() {
    if (!orderResult || !pricebookValue?.id) return;
    setSubmittingLines(true);
    setLineItemError(null);
    try {
      const res = await quoteApiPost<OrderLineItemCreationResult & { success: true }>(
        "Create order line items", `/api/orders/${orderResult.id}/line-items`, { pricebookId: pricebookValue.id, draftRoots: lineRoots },
      );
      replayServerSteps("Create Order Line Items", res.steps);
      setLineItemResult(res);
      updateResponseSummary({ orderLineItems: { count: res.createdCount, ids: res.createdIds }, orderBundleResult: res, repricing: res.repricing });
      clearDraftFromStorage();
      setStep("success");
    } catch (err) {
      const data = toErrorPanelData(err, "Order line item creation failed validation");
      setLineItemError(data);
      setHighlightLogId(data.logEntryId ?? null);
      const rawResult = data.raw as OrderLineItemCreationResult | undefined;
      if (rawResult?.steps) replayServerSteps("Create Order Line Items", rawResult.steps);
      if (rawResult) {
        updateResponseSummary({ orderBundleResult: rawResult });
        setLineItemResult(rawResult);
      }
    } finally {
      setSubmittingLines(false);
    }
  }

  function handleStartOver() {
    clearDraftFromStorage();
    setStep("details"); setFormData(EMPTY_FORM); setAccountValue(null); setContractValue(null); setPricebookValue(null); setSourceQuoteValue(null); setAiPrompt(""); setOrderResult(null);
    setLineRoots([]); setLinesValid(false); setLineItemResult(null); setLineItemError(null); setCreateError(null);
  }

  const footer = (
    <FooterBar isDark={isDark}>
      <div style={{ display: "flex", gap: 8 }}>
        {step !== "details" && step !== "success" && (
          <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={() => setStep(step === "lines" ? "details" : step === "preview" ? "lines" : "details")} />
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {draftSavedAt && step !== "success" && <span style={{ fontSize: 10.5, color: t.dim }}>Draft saved {new Date(draftSavedAt).toLocaleTimeString()}</span>}
        {step !== "success" && <GhostButton label="Save Draft" icon="save" isDark={isDark} onClick={handleSaveDraft} />}
        {step === "details" && (
          <PrimaryButton
            label={creating ? "Creating…" : "Next: Add Order Items"} icon="arrow-right" isDark={isDark}
            disabled={creating || !accountValue || !pricebookValue?.id}
            onClick={handleCreateOrder}
          />
        )}
        {step === "lines" && (
          <PrimaryButton label="Next: Preview" icon="arrow-right" isDark={isDark} disabled={!linesValid || lineRoots.length === 0} onClick={() => setStep("preview")} />
        )}
        {step === "preview" && (
          <PrimaryButton label={submittingLines ? "Creating…" : "Create Order"} icon="check" isDark={isDark} disabled={submittingLines} onClick={handleSubmitLines} />
        )}
        {step === "success" && (
          <PrimaryButton label="Create Another Order" icon="plus" isDark={isDark} onClick={handleStartOver} />
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
            <Section title="Describe this order (AI)" icon="sparkles" isDark={isDark}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <textarea
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  placeholder='e.g. "Create an order for Acme Corp using the Standard price book, effective next Monday, type New"'
                  rows={2}
                  style={{ ...inputStyle(t), flex: "1 1 320px", resize: "vertical" }}
                />
                <PrimaryButton label={aiLoading ? "Generating…" : "Generate"} icon="sparkles" isDark={isDark} disabled={aiLoading} onClick={handleAiGenerate} />
              </div>
              {aiLoading && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim }}><Spinner isDark={isDark} size={12} /> Parsing with Claude…</div>}
            </Section>

            <Section title="Order Details" icon="file-text" isDark={isDark}>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <FieldGroup title="Customer & Commercial" icon="briefcase" isDark={isDark}>
                  <Field label={schema?.accountField?.label ?? "Account"} isDark={isDark}>
                    <ReferenceLookup
                      ref={accountLookupRef}
                      isDark={isDark}
                      objectType="Account"
                      searchEndpoint="/api/orders/reference/search"
                      value={accountValue}
                      onChange={handleAccountChange}
                      placeholder="Search accounts…"
                      noMatchHint="No matching Account found. Please select an existing Account."
                    />
                    {!accountValue && <div style={{ marginTop: 4, fontSize: 11, color: t.error }}>Please select a valid Salesforce Account.</div>}
                  </Field>
                  <Field label="Price Book" isDark={isDark} hint="Required — used to search the product catalog for order items">
                    <ReferenceLookup
                      ref={pricebookLookupRef}
                      isDark={isDark}
                      objectType="Pricebook2"
                      searchEndpoint="/api/orders/reference/search"
                      value={pricebookValue}
                      onChange={handlePricebookChange}
                      placeholder="Search price books…"
                      noMatchHint="No matching Price Book found. Please select an existing Price Book."
                    />
                  </Field>
                  {schema?.contractField && (
                    <Field label={schema.contractField.label} isDark={isDark} hint={contractLooksRequired ? "This org's Type value looks like it requires a Contract" : undefined}>
                      <ReferenceLookup
                        ref={contractLookupRef}
                        isDark={isDark}
                        objectType="Contract"
                        searchEndpoint="/api/orders/reference/search"
                        value={contractValue}
                        onChange={handleContractChange}
                        placeholder="Search by Contract Number or Name…"
                        noMatchHint="No matching Contract found. Please select an existing Contract."
                      />
                    </Field>
                  )}
                  {schema?.sourceQuoteField && (
                    <Field label="Source Quote (optional)" isDark={isDark} hint="Only shown because this org has a Quote lookup on Order">
                      <ReferenceLookup
                        ref={sourceQuoteLookupRef}
                        isDark={isDark}
                        objectType="Quote"
                        searchEndpoint="/api/orders/reference/search"
                        value={sourceQuoteValue}
                        onChange={handleSourceQuoteChange}
                        placeholder="Search quotes…"
                        noMatchHint="No matching Quote found. Please select an existing Quote."
                      />
                    </Field>
                  )}
                </FieldGroup>

                {(schema?.effectiveDateField || schema?.statusField || schema?.typeField) && (
                  <FieldGroup title="Schedule & Status" icon="calendar" isDark={isDark}>
                    {schema?.effectiveDateField && (
                      <Field label={schema.effectiveDateField.label} isDark={isDark}>
                        <input type="date" value={formData.effectiveDate} onChange={e => setFormData(f => ({ ...f, effectiveDate: e.target.value }))} style={inputStyle(t)} />
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
                    {schema?.typeField && (
                      <Field label={schema.typeField.label} isDark={isDark}>
                        <select value={formData.type || ""} onChange={e => setFormData(f => ({ ...f, type: e.target.value }))} style={inputStyle(t)}>
                          <option value="">Select…</option>
                          {schema.typeField.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </Field>
                    )}
                  </FieldGroup>
                )}

                {(schema?.poNumberField || schema?.poDateField) && (
                  <FieldGroup title="Purchase Order" icon="file-text" isDark={isDark}>
                    {schema?.poNumberField && (
                      <Field label={schema.poNumberField.label} isDark={isDark}>
                        <input value={formData.poNumber} onChange={e => setFormData(f => ({ ...f, poNumber: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                    {schema?.poDateField && (
                      <Field label={schema.poDateField.label} isDark={isDark}>
                        <input type="date" value={formData.poDate} onChange={e => setFormData(f => ({ ...f, poDate: e.target.value }))} style={inputStyle(t)} />
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
                    <Spinner isDark={isDark} size={13} /> Resolving Order field schema from Salesforce…
                  </div>
                )}
              </div>
            </Section>

            {createError && <ErrorPanel isDark={isDark} error={createError} onViewLogs={() => setHighlightLogId(createError.logEntryId ?? null)} />}
          </>
        )}

        {step === "lines" && orderResult && pricebookValue?.id && (
          <>
            {orderWarnings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.warn}50`, background: `${t.warn}10` }}>
                {orderWarnings.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: t.body }}>
                    <span style={{ flexShrink: 0, color: t.warn }}><Ic n="info" s={13} /></span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
            <LineItemsEditor isDark={isDark} pricebookId={pricebookValue.id} onChange={(roots, valid) => { setLineRoots(roots); setLinesValid(valid); }} initialRoots={lineRoots} />
          </>
        )}

        {step === "preview" && (
          <>
            <Section title="Order Summary" icon="file-text" isDark={isDark}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <SummaryField t={t} label="Customer" value={formData.accountName || "—"} />
                <SummaryField t={t} label="Price Book" value={formData.pricebookName || "—"} />
                <SummaryField t={t} label="Contract" value={formData.contractName || "—"} />
                <SummaryField t={t} label="Effective Date" value={formData.effectiveDate || "—"} />
                <SummaryField t={t} label="Type" value={formData.type || "—"} />
                <SummaryField t={t} label="Status" value={formData.status || "—"} />
              </div>
            </Section>

            <Section title={`Order Items & Bundle Hierarchy (${flatLines.length})`} icon="layers" isDark={isDark}>
              <PreviewLineTree isDark={isDark} roots={lineRoots} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.border}`, fontSize: 14, fontWeight: 700, color: t.heading }}>
                <span>Total (pricing & discounts applied)</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </Section>

            <Section title="Request, Logs & Response" icon="terminal" isDark={isDark}>
              <OrderPreviewPanel isDark={isDark} requestJson={requestPreview} highlightLogId={highlightLogId} />
            </Section>

            {lineItemError && (
              <Section title="Why did this fail?" icon="alert" isDark={isDark}>
                {lineItemError.failureDetail ? (
                  <OrderLineItemFailureView isDark={isDark} detail={lineItemError.failureDetail as OrderLineItemFailureDetail} />
                ) : (
                  <ErrorPanel isDark={isDark} error={lineItemError} onViewLogs={() => setHighlightLogId(lineItemError.logEntryId ?? null)} />
                )}
              </Section>
            )}
          </>
        )}

        {step === "success" && lineItemResult && orderResult && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 700, color: t.accent, padding: "6px 0" }}>
              <Ic n="check-circle" s={20} /> Order {orderResult.orderNumber ?? orderResult.id} created with {lineItemResult.createdCount} line item(s)
            </div>
            {salesforceRecordUrl(orderResult.id) && (
              <a
                href={salesforceRecordUrl(orderResult.id)!} target="_blank" rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: t.accent, textDecoration: "none", marginTop: -6 }}
              >
                <Ic n="external-link" s={13} /> View in Salesforce
              </a>
            )}
            <Section title="Refreshed Order Items (authoritative, re-queried from Salesforce)" icon="list" isDark={isDark}>
              <RefreshedTable isDark={isDark} items={lineItemResult.refreshedLineItems} />
            </Section>
            <Section title="Full Details — Logs, JSON & Response" icon="terminal" isDark={isDark} defaultOpen={false}>
              <OrderPreviewPanel isDark={isDark} requestJson={requestPreview} highlightLogId={highlightLogId} />
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

function PreviewLineTree({ isDark, roots }: { isDark: boolean; roots: QuoteLineItemDraft[] }) {
  const t = tokens(isDark);
  if (roots.length === 0) return <EmptyState isDark={isDark} icon="layers" title="No order items staged" />;

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
          <MetaBadge t={t} label={depth === 0 ? (node.isBundleParent ? "Bundle Parent" : "Standalone Product") : (node.isBundleParent ? "Nested Bundle Component" : "Bundle Child")} />
        </div>
      </div>,
      ...renderRows(node.children, depth + 1),
    ]);
  }
  return <div>{renderRows(roots, 0)}</div>;
}

function RefreshedTable({ isDark, items }: { isDark: boolean; items: OrderLineItemCreationResult["refreshedLineItems"] }) {
  const t = tokens(isDark);
  function renderRows(nodes: typeof items, depth: number): ReactNode[] {
    return nodes.flatMap(node => [
      <div key={node.id} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "6px 0", marginLeft: depth * 16, borderBottom: `1px solid ${t.border}` }}>
        <span style={{ flex: 1, color: t.heading }}>{node.productName}</span>
        <span style={{ width: 50, color: t.dim }}>{node.quantity}×</span>
        <span style={{ width: 90, color: t.dim }}>{formatCurrency(node.unitPrice)}</span>
        <span style={{ width: 90, fontWeight: 600, color: t.heading }}>{formatCurrency(node.totalPrice)}</span>
      </div>,
      ...renderRows(node.children, depth + 1),
    ]);
  }
  if (items.length === 0) return <EmptyState isDark={isDark} icon="list" title="No order items returned" />;
  return <div>{renderRows(items, 0)}</div>;
}
