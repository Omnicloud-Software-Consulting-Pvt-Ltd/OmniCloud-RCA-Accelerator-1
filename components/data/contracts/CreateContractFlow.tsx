"use client";

import { useEffect, useRef, useState } from "react";
import {
  Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton,
  PageShell, FooterBar, Spinner, ErrorPanel,
} from "@/components/data/quotes/shared";
import ReferenceLookup, { type ReferenceLookupHandle, type ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import ContactLookup from "@/components/data/contracts/ContactLookup";
import ContractPreviewPanel from "@/components/data/contracts/ContractPreviewPanel";
import PromptGuide from "@/components/ai/PromptGuide";
import { promptGuideConfig } from "@/lib/ai/promptGuideConfig";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { replayServerSteps } from "@/lib/quotes/client/executionLog";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import { salesforceRecordUrl } from "@/lib/salesforce/client/recordLink";
import { loadSession } from "@/lib/auth/session";
import { toCreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { useSalesforceSuccess } from "@/components/notifications/SalesforceSuccessContext";
import type { BundleHierarchyStep } from "@/lib/quotes/types";
import type { ContractCreateResult, ContractFieldSchema, ContractFormData } from "@/lib/contracts/types";

type Step = "details" | "success";

const EMPTY_FORM: ContractFormData = {
  accountName: "", pricebookName: "", status: "", contractType: "", startDate: "",
  contractTerm: "", companySignedByName: "", companySignedDate: "",
  customerSignedById: "", customerSignedByName: "", customerSignedTitle: "", customerSignedDate: "", description: "",
};

const DRAFT_KEY = "omnicloud_contract_draft_v1";

interface DraftShape {
  savedAt: number;
  formData: ContractFormData;
  accountValue: ReferenceLookupValue | null;
  pricebookValue: ReferenceLookupValue | null;
  companySignedByValue: ReferenceLookupValue | null;
  aiPrompt: string;
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

export default function CreateContractFlow({ isDark, onViewContract }: {
  isDark: boolean;
  /** Jumps straight to this Contract's Documents tab — wired by ContractsModule so "Next Step" can open the newly created Contract to generate + send a document, instead of just resetting the create form. */
  onViewContract?: (contractId: string) => void;
}) {
  const t = tokens(isDark);
  const notifySalesforceSuccess = useSalesforceSuccess();
  const [step, setStep] = useState<Step>("details");
  const [schema, setSchema] = useState<ContractFieldSchema | null>(null);
  const [formData, setFormData] = useState<ContractFormData>(EMPTY_FORM);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ErrorPanelDataLike | null>(null);
  const [contractResult, setContractResult] = useState<ContractCreateResult | null>(null);
  const [restoreBanner, setRestoreBanner] = useState<DraftShape | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [highlightLogId, setHighlightLogId] = useState<string | null>(null);
  const [contractWarnings, setContractWarnings] = useState<string[]>([]);
  const [customerContact, setCustomerContact] = useState<{ id: string; name: string } | null>(null);

  const [accountValue, setAccountValue] = useState<ReferenceLookupValue | null>(null);
  const accountLookupRef = useRef<ReferenceLookupHandle>(null);
  const [pricebookValue, setPricebookValue] = useState<ReferenceLookupValue | null>(null);
  const pricebookLookupRef = useRef<ReferenceLookupHandle>(null);
  const [companySignedByValue, setCompanySignedByValue] = useState<ReferenceLookupValue | null>(null);
  const companySignedByLookupRef = useRef<ReferenceLookupHandle>(null);

  function handleAccountChange(next: ReferenceLookupValue | null) {
    setAccountValue(next);
    setFormData(f => ({ ...f, accountName: next?.name ?? "" }));
    // ContactLookup itself clears the selected Customer Signed By Contact whenever accountId changes.
  }

  function handlePricebookChange(next: ReferenceLookupValue | null) {
    setPricebookValue(next);
    setFormData(f => ({ ...f, pricebookName: next?.name ?? "" }));
  }

  function handleCompanySignedByChange(next: ReferenceLookupValue | null) {
    setCompanySignedByValue(next);
    setFormData(f => ({ ...f, companySignedByName: next?.name ?? "" }));
  }

  useEffect(() => {
    quoteApiGet<{ schema: ContractFieldSchema }>("Resolve Contract schema", "/api/contracts/schema")
      .then(res => setSchema(res.schema))
      .catch(() => setSchema(null));
    const draft = loadDraftFromStorage();
    if (draft) setRestoreBanner(draft);
  }, []);

  function handleRestoreDraft() {
    if (!restoreBanner) return;
    setFormData(restoreBanner.formData);
    setAccountValue(restoreBanner.accountValue ?? null);
    setPricebookValue(restoreBanner.pricebookValue ?? null);
    setCompanySignedByValue(restoreBanner.companySignedByValue ?? null);
    setAiPrompt(restoreBanner.aiPrompt);
    setDraftSavedAt(restoreBanner.savedAt);
    setRestoreBanner(null);
  }
  function handleDiscardDraft() {
    clearDraftFromStorage();
    setRestoreBanner(null);
  }
  function handleSaveDraft() {
    saveDraftToStorage({ formData, accountValue, pricebookValue, companySignedByValue, aiPrompt });
    setDraftSavedAt(Date.now());
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    try {
      const res = await quoteApiPost<{ fields: ContractFormData & { endDate?: string } }>("AI parse contract", "/api/contracts/ai/parse-contract", { prompt: aiPrompt });
      setFormData(prev => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(res.fields)) {
          // endDate is informational-only (§2.1: EndDate is a read-only formula field) — no form slot consumes it.
          // accountName/pricebookName/companySignedByName are resolved against Salesforce via their lookups below, never trusted as raw text.
          if (key === "endDate" || key === "customerSignedById" || key === "accountName" || key === "pricebookName" || key === "companySignedByName") continue;
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
      if (res.fields.pricebookName?.trim()) {
        await pricebookLookupRef.current?.searchAndResolve(res.fields.pricebookName);
      }
      if (res.fields.companySignedByName?.trim()) {
        await companySignedByLookupRef.current?.searchAndResolve(res.fields.companySignedByName);
      }
    } catch {
      // AI parsing failure is non-fatal — the form remains manually editable.
    } finally {
      setAiLoading(false);
    }
  }

  async function handleCreateContract() {
    setCreating(true);
    setCreateError(null);
    setContractWarnings([]);
    try {
      const res = await quoteApiPost<ContractCreateResult & { success: true }>("Create Contract", "/api/contracts", { formData });
      replayServerSteps("Create Contract", res.steps);
      setContractWarnings(res.warnings ?? []);
      setContractResult(res);
      updateResponseSummary({ contract: { id: res.id, contractNumber: res.contractNumber, status: formData.status || null } });
      clearDraftFromStorage();
      setStep("success");

      const instanceUrl = loadSession()?.instanceUrl;
      if (instanceUrl) {
        const record = toCreatedSalesforceRecord(instanceUrl, "Contract", res.id, res.contractNumber ?? res.id);
        notifySalesforceSuccess({
          title: "Contract Created Successfully",
          message: `${record.recordName} has been successfully created in Salesforce.`,
          records: [record],
        });
      }
    } catch (err) {
      const data = toErrorPanelData(err, "Could not create this Contract");
      setCreateError(data);
      const rawSteps = (data.raw as { steps?: BundleHierarchyStep[] } | undefined)?.steps;
      if (rawSteps) replayServerSteps("Create Contract", rawSteps);
      setHighlightLogId(data.logEntryId ?? null);
    } finally {
      setCreating(false);
    }
  }

  const requestPreview = { formData, customerContact };

  const footer = (
    <FooterBar isDark={isDark}>
      <div style={{ display: "flex", gap: 8 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {draftSavedAt && step !== "success" && <span style={{ fontSize: 10.5, color: t.dim }}>Draft saved {new Date(draftSavedAt).toLocaleTimeString()}</span>}
        {step !== "success" && <GhostButton label="Save Draft" icon="save" isDark={isDark} onClick={handleSaveDraft} />}
        {step === "details" && (
          <PrimaryButton
            label={creating ? "Creating…" : "Create Contract"} icon="check" isDark={isDark}
            disabled={creating || !accountValue}
            onClick={handleCreateContract}
          />
        )}
        {step === "success" && contractResult && (
          <PrimaryButton label="Next Step" icon="arrow-right" isDark={isDark} onClick={() => onViewContract?.(contractResult.id)} />
        )}
      </div>
    </FooterBar>
  );

  return (
    <PageShell footer={footer}>
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
            <Section title="Describe this contract (AI)" icon="sparkles" isDark={isDark}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <textarea
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  placeholder='e.g. "Create a 12-month Master Service Agreement for Acme Corp starting next Monday"'
                  rows={2}
                  style={{ ...inputStyle(t), flex: "1 1 320px", resize: "vertical" }}
                />
                <PrimaryButton label={aiLoading ? "Generating…" : "Generate"} icon="sparkles" isDark={isDark} disabled={aiLoading} onClick={handleAiGenerate} />
              </div>
              {aiLoading && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.dim }}><Spinner isDark={isDark} size={12} /> Parsing with Claude…</div>}
              <div style={{ marginTop: 10 }}>
                <PromptGuide isDark={isDark} config={promptGuideConfig.contract} onUseExample={setAiPrompt} />
              </div>
            </Section>

            <Section title="Contract Details" icon="file-contract" isDark={isDark}>
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                  <Field label={schema?.accountField?.label ?? "Account"} isDark={isDark}>
                    <ReferenceLookup
                      ref={accountLookupRef}
                      isDark={isDark}
                      objectType="Account"
                      searchEndpoint="/api/contracts/reference/search"
                      value={accountValue}
                      onChange={handleAccountChange}
                      placeholder="Search accounts…"
                      noMatchHint="No matching Account found. Please select an existing Account."
                    />
                    {!accountValue && <div style={{ marginTop: 4, fontSize: 11, color: t.error }}>Please select a valid Salesforce Account.</div>}
                  </Field>
                  {schema?.pricebookField && (
                    <Field label={schema.pricebookField.label} isDark={isDark}>
                      <ReferenceLookup
                        ref={pricebookLookupRef}
                        isDark={isDark}
                        objectType="Pricebook2"
                        searchEndpoint="/api/contracts/reference/search"
                        value={pricebookValue}
                        onChange={handlePricebookChange}
                        placeholder="Search price books…"
                        noMatchHint="No matching Price Book found. Please select an existing Price Book."
                      />
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
                  {schema?.contractTypeField && (
                    <Field label={schema.contractTypeField.label} isDark={isDark}>
                      <select value={formData.contractType || ""} onChange={e => setFormData(f => ({ ...f, contractType: e.target.value }))} style={inputStyle(t)}>
                        <option value="">Select…</option>
                        {schema.contractTypeField.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </Field>
                  )}
                  {schema?.startDateField && (
                    <Field label={schema.startDateField.label} isDark={isDark}>
                      <input type="date" value={formData.startDate} onChange={e => setFormData(f => ({ ...f, startDate: e.target.value }))} style={inputStyle(t)} />
                    </Field>
                  )}
                  {schema?.endDateField && (
                    <Field label={schema.endDateField.label} isDark={isDark} hint="Formula field — computed by Salesforce, never editable here.">
                      <div style={{ ...inputStyle(t), color: t.dim, display: "flex", alignItems: "center", gap: 6 }}>
                        <Ic n="lock" s={12} /> Calculated by Salesforce
                      </div>
                    </Field>
                  )}
                  {schema?.contractTermField && (
                    <Field label={schema.contractTermField.label} isDark={isDark}>
                      <input type="number" min={0} value={formData.contractTerm} onChange={e => setFormData(f => ({ ...f, contractTerm: e.target.value }))} style={inputStyle(t)} />
                    </Field>
                  )}
                </div>

                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 10 }}>
                    <Ic n="user" s={12} /> Signatories
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                    {schema?.companySignedByField && (
                      <Field label={schema.companySignedByField.label} isDark={isDark}>
                        <ReferenceLookup
                          ref={companySignedByLookupRef}
                          isDark={isDark}
                          objectType="User"
                          searchEndpoint="/api/contracts/reference/search"
                          value={companySignedByValue}
                          onChange={handleCompanySignedByChange}
                          placeholder="Search users…"
                          noMatchHint="No matching User found. Please select an existing User."
                        />
                      </Field>
                    )}
                    {schema?.companySignedDateField && (
                      <Field label={schema.companySignedDateField.label} isDark={isDark} hint="Not required at creation — populated by the e-signature completion flow.">
                        <input type="date" value={formData.companySignedDate} onChange={e => setFormData(f => ({ ...f, companySignedDate: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                    {schema?.customerSignedByField && (
                      <Field label={schema.customerSignedByField.label} isDark={isDark}>
                        <ContactLookup
                          isDark={isDark}
                          accountId={accountValue?.id ?? null}
                          value={customerContact}
                          onChange={c => {
                            setCustomerContact(c);
                            setFormData(f => ({ ...f, customerSignedById: c?.id ?? "", customerSignedByName: c?.name ?? "" }));
                          }}
                        />
                      </Field>
                    )}
                    {schema?.customerSignedTitleField && (
                      <Field label={schema.customerSignedTitleField.label} isDark={isDark}>
                        <input value={formData.customerSignedTitle} onChange={e => setFormData(f => ({ ...f, customerSignedTitle: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                    {schema?.customerSignedDateField && (
                      <Field label={schema.customerSignedDateField.label} isDark={isDark} hint="Not required at creation — populated by the e-signature completion flow.">
                        <input type="date" value={formData.customerSignedDate} onChange={e => setFormData(f => ({ ...f, customerSignedDate: e.target.value }))} style={inputStyle(t)} />
                      </Field>
                    )}
                  </div>
                </div>

                {schema?.descriptionField && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Field label={schema.descriptionField.label} isDark={isDark}>
                      <textarea value={formData.description} onChange={e => setFormData(f => ({ ...f, description: e.target.value }))} rows={3} style={{ ...inputStyle(t), resize: "vertical" }} />
                    </Field>
                  </div>
                )}

                {!schema && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: t.dim }}>
                    <Spinner isDark={isDark} size={13} /> Resolving Contract field schema from Salesforce…
                  </div>
                )}
              </div>
            </Section>

            <Section title="Request, Logs & Response" icon="terminal" isDark={isDark} defaultOpen={false}>
              <ContractPreviewPanel isDark={isDark} requestJson={requestPreview} highlightLogId={highlightLogId} />
            </Section>

            {createError && <ErrorPanel isDark={isDark} error={createError} onViewLogs={() => setHighlightLogId(createError.logEntryId ?? null)} />}
          </>
        )}

        {step === "success" && contractResult && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, padding: "6px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 700, color: t.accent }}>
                <Ic n="check-circle" s={20} /> Contract {contractResult.contractNumber ?? contractResult.id} created
              </div>
              {salesforceRecordUrl(contractResult.id) && (
                <a
                  href={salesforceRecordUrl(contractResult.id)!} target="_blank" rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: t.accent, textDecoration: "none" }}
                >
                  <Ic n="external-link" s={13} /> View in Salesforce
                </a>
              )}
            </div>

            {contractWarnings.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.warn}50`, background: `${t.warn}10` }}>
                {contractWarnings.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: t.body }}>
                    <span style={{ flexShrink: 0, color: t.warn }}><Ic n="info" s={13} /></span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            <Section title="What's next" icon="arrow-right" isDark={isDark}>
              <div style={{ fontSize: 12.5, color: t.body }}>
                Click <strong>Next Step</strong> below to open this Contract's Documents tab — pick a template, generate a branded document, and send it for e-signature via DocuSign.
              </div>
            </Section>

            <Section title="Full Details — Logs, JSON & Response" icon="terminal" isDark={isDark} defaultOpen={false}>
              <ContractPreviewPanel isDark={isDark} requestJson={{ ...requestPreview, result: contractResult }} highlightLogId={highlightLogId} />
            </Section>
          </>
        )}
      </div>
    </PageShell>
  );
}
