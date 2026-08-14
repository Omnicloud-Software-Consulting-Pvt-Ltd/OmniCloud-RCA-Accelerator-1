"use client";

import { useEffect, useState } from "react";
import { Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, PageShell, Pill, Spinner, ErrorPanel } from "@/components/data/quotes/shared";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { DocuSignConnectionConfig } from "@/lib/contracts/types";

/**
 * Mirrors POST /api/contracts/docusign/diagnostics/test-send's response
 * (lib/contracts/docusign/envelope.ts's sendDocuSignControlTestEnvelope →
 * getEnvelopeDiagnostics) — same local-mirror rationale as the other
 * diagnostic response types below.
 */
interface ControlTestResult {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  recipients: {
    name: string; maskedEmail: string; status: string | null; deliveryMethod: string | null;
    clientUserIdPresent: boolean; sentDateTime: string | null; deliveredDateTime: string | null;
    recipientSuppliesTabs: string | null; totalTabCount: number | null;
  }[];
}

/**
 * Mirrors GET /api/contracts/docusign/envelopes/[envelopeId]/inspect-email-delivery's
 * response shape (lib/contracts/docusign/emailDeliveryInspection.ts) — defined
 * locally rather than imported, same pattern SignaturePanel.tsx already uses
 * for its own EnvelopeStatusCheck mirror: that lib module transitively pulls
 * in server-only DocuSign/Salesforce code (OAuth, PDF rendering, in-memory
 * stores) that has no business in this client bundle.
 */
type EmailDeliveryVerdict =
  | "APP_DID_NOT_REQUEST_EMAIL"
  | "DOCUSIGN_DID_NOT_GENERATE_INVITATION"
  | "DOCUSIGN_GENERATED_INVITATION_BUT_DELIVERY_FAILED"
  | "DOCUSIGN_REPORTS_DELIVERED_CHECK_MAILBOX_FILTERING"
  | "INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS";

const EMAIL_DELIVERY_VERDICT_LABEL: Record<EmailDeliveryVerdict, string> = {
  APP_DID_NOT_REQUEST_EMAIL: "A — Our app did not request email delivery",
  DOCUSIGN_DID_NOT_GENERATE_INVITATION: "B — DocuSign did not generate an invitation",
  DOCUSIGN_GENERATED_INVITATION_BUT_DELIVERY_FAILED: "C — DocuSign generated the invitation but delivery failed/suppressed",
  DOCUSIGN_REPORTS_DELIVERED_CHECK_MAILBOX_FILTERING: "D — DocuSign reports successful delivery; check downstream mailbox filtering",
  INSUFFICIENT_API_DATA_CHECK_ACCOUNT_LOGS: "E — DocuSign's API does not expose enough information; account/admin logs must be checked",
};

interface EmailDeliveryInspection {
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  statusChangedDateTime: string | null;
  recipients: {
    recipientId: string; maskedEmail: string; name: string; status: string | null; deliveryMethod: string | null;
    clientUserIdPresent: boolean; sentDateTime: string | null; deliveredDateTime: string | null; signedDateTime: string | null;
    declinedDateTime: string | null; declinedReason: string | null; autoRespondedReason: string | null;
  }[];
  auditEvents: { eventName: string | null; eventDateTime: string | null }[] | null;
  auditEventsAvailable: boolean;
  verdict: EmailDeliveryVerdict;
  verdictReason: string;
}

/** Mirrors POST /api/contracts/docusign/diagnostics/compare's response (lib/contracts/docusign/envelope.ts's compareDocuSignEnvelopes / envelopeDiff.ts) — same local-mirror rationale as EmailDeliveryInspection above. */
type EnvelopeDiffClassification = "strong-delivery-candidate" | "possibly-delivery-relevant" | "expected-or-irrelevant";
interface EnvelopeDiffEntry { path: string; apiValue: unknown; manualValue: unknown; classification: EnvelopeDiffClassification }
interface SenderIdentityComparison {
  apiSenderUserId: string | null; apiSenderAccountId: string | null; apiSenderEmailMasked: string | null;
  manualSenderUserId: string | null; manualSenderAccountId: string | null; manualSenderEmailMasked: string | null;
  sameSenderUserId: boolean; sameSenderAccountId: boolean;
  activeSession: { environment: string; accountId: string; baseUri: string } | null;
}
interface EnvelopeSideBySideSummary {
  accountId: string | null; senderUserId: string | null; status: string | null;
  emailSubject: string | null; emailBlurbPresent: boolean; documentCount: number | null; documentExtension: string | null;
  recipientId: string | null; routingOrder: string | null; deliveryMethod: string | null; clientUserIdPresent: boolean;
  emailNotificationPresent: boolean; recipientSuppliesTabs: string | null; totalTabCount: number | null; signHereTabCount: number | null;
  recipientStatus: string | null; sentDateTime: string | null; deliveredDateTime: string | null; auditEventNames: string[];
}
interface EnvelopeComparisonResult {
  apiEnvelopeId: string; manualEnvelopeId: string;
  envelopeDiffs: EnvelopeDiffEntry[]; recipientDiffs: EnvelopeDiffEntry[]; notificationDiffs: EnvelopeDiffEntry[]; auditDiffs: EnvelopeDiffEntry[];
  strongestCandidate: EnvelopeDiffEntry | null;
  senderIdentityComparison: SenderIdentityComparison;
  apiSummary: EnvelopeSideBySideSummary;
  manualSummary: EnvelopeSideBySideSummary;
}

const SUMMARY_ROWS: { label: string; get: (s: EnvelopeSideBySideSummary) => string }[] = [
  { label: "accountId", get: s => s.accountId ?? "—" },
  { label: "senderUserId", get: s => s.senderUserId ?? "—" },
  { label: "status", get: s => s.status ?? "—" },
  { label: "emailSubject", get: s => s.emailSubject ?? "—" },
  { label: "emailBlurbPresent", get: s => String(s.emailBlurbPresent) },
  { label: "documentCount", get: s => String(s.documentCount ?? "—") },
  { label: "documentExtension", get: s => s.documentExtension ?? "—" },
  { label: "recipientId", get: s => s.recipientId ?? "—" },
  { label: "routingOrder", get: s => s.routingOrder ?? "—" },
  { label: "deliveryMethod", get: s => s.deliveryMethod ?? "—" },
  { label: "clientUserIdPresent", get: s => String(s.clientUserIdPresent) },
  { label: "emailNotificationPresent", get: s => String(s.emailNotificationPresent) },
  { label: "recipientSuppliesTabs", get: s => s.recipientSuppliesTabs ?? "—" },
  { label: "totalTabCount", get: s => String(s.totalTabCount ?? "—") },
  { label: "signHereTabCount", get: s => String(s.signHereTabCount ?? "—") },
  { label: "recipientStatus", get: s => s.recipientStatus ?? "—" },
  { label: "sentDateTime", get: s => s.sentDateTime ?? "—" },
  { label: "deliveredDateTime", get: s => s.deliveredDateTime ?? "—" },
  { label: "auditEventNames", get: s => (s.auditEventNames.length ? s.auditEventNames.join(" → ") : "—") },
];

const DIFF_CLASSIFICATION_LABEL: Record<EnvelopeDiffClassification, string> = {
  "strong-delivery-candidate": "Strong delivery candidate",
  "possibly-delivery-relevant": "Possibly related to email generation/delivery",
  "expected-or-irrelevant": "Clearly unrelated",
};
const DIFF_CLASSIFICATION_COLOR: Record<EnvelopeDiffClassification, string> = {
  "strong-delivery-candidate": "#FF4066",
  "possibly-delivery-relevant": "#F59E0B",
  "expected-or-irrelevant": "#5A7AA0",
};

/** Mirrors POST /api/contracts/docusign/diagnostics/production-parity-test's response ("Test C" — lib/contracts/docusign/envelope.ts's sendProductionParityTestEnvelope). */
interface ProductionParityTestResponse {
  success: boolean;
  /** The pre-flight SOQL verification result (§Phase 3) — proves the ContentVersion actually resolves in this org BEFORE any download/send is attempted. */
  verified: { Id: string; ContentDocumentId: string; Title: string; FileExtension: string; ContentSize: number; IsLatest: boolean };
  send: {
    envelopeId: string; envelopeStatus: string; sentDateTime: string | null;
    contentVersionId: string; fileExtension: string; pdfHeaderCheck: "ok" | "mismatch" | "not-applicable";
  };
  diagnostics: {
    envelopeId: string; envelopeStatus: string; sentDateTime: string | null;
    recipients: {
      name: string; maskedEmail: string; status: string | null; deliveryMethod: string | null;
      clientUserIdPresent: boolean; sentDateTime: string | null; deliveredDateTime: string | null;
      recipientSuppliesTabs: string | null; totalTabCount: number | null;
    }[];
  };
}

/** Mirrors POST /api/contracts/docusign/diagnostics/email-isolation-test's response (lib/contracts/docusign/envelope.ts's sendEmailIsolationTestEnvelope). */
interface IsolationTestResponse {
  caseNumber: 1 | 2 | 3 | 4;
  envelopeId: string;
  envelopeStatus: string;
  sentDateTime: string | null;
  documentSource: "control-test-pdf" | "salesforce-content-version";
  emailContentSource: "test-a-fixed" | "production-template";
  contentVersionId: string | null;
  documentTitle: string;
  diagnostics: {
    envelopeStatus: string;
    recipients: {
      name: string; maskedEmail: string; status: string | null; deliveryMethod: string | null;
      clientUserIdPresent: boolean; sentDateTime: string | null; deliveredDateTime: string | null;
      autoRespondedReason: string | null;
    }[];
    auditEvents: { eventName: string | null; eventDateTime: string | null }[] | null;
  };
}

const ISOLATION_CASES: { caseNumber: 1 | 2 | 3 | 4; title: string; description: string; requiresContentVersion: boolean }[] = [
  { caseNumber: 1, title: "Case 1 — Baseline", description: "Test A's own fixed PDF + fixed subject/body. Exactly what Test A already sends.", requiresContentVersion: false },
  { caseNumber: 2, title: "Case 2 — + Contract email content", description: "Test A's PDF, but the production email template (subject \"Review and Sign Contract …\").", requiresContentVersion: false },
  { caseNumber: 3, title: "Case 3 — + Salesforce PDF", description: "The real Salesforce ContentVersion below, but Test A's fixed subject/body.", requiresContentVersion: true },
  { caseNumber: 4, title: "Case 4 — Full production inputs", description: "The real Salesforce ContentVersion AND the production email template — everything production sends, through Test A's transport.", requiresContentVersion: true },
];

const STATUS_COLOR: Record<DocuSignConnectionConfig["status"], string> = {
  connected: "#00D4FF",
  disconnected: "#5A7AA0",
  reauthorization_required: "#F59E0B",
  error: "#FF4066",
};

/** GET/POST /api/contracts/docusign/settings' non-sensitive OAuth diagnostics — computed on demand server-side, never persisted client-side. */
interface OAuthDiagnostics {
  environment: "demo" | "production";
  maskedClientId: string | null;
  resolvedRedirectUri: string;
  redirectUriSource: "saved-config" | "environment" | "request-origin";
}

const REDIRECT_SOURCE_LABEL: Record<OAuthDiagnostics["redirectUriSource"], string> = {
  "saved-config": "Saved callback URL (Settings)",
  environment: "DOCUSIGN_REDIRECT_URI environment variable",
  "request-origin": "Derived from request origin (no override configured)",
};

/** Per-organization DocuSign OAuth app + connection settings screen (§5.1, §5.7). */
export default function DocuSignSettings({ isDark, onBack }: { isDark: boolean; onBack: () => void }) {
  const t = tokens(isDark);
  const [config, setConfig] = useState<DocuSignConnectionConfig | null>(null);
  const [diagnostics, setDiagnostics] = useState<OAuthDiagnostics | null>(null);
  const [environment, setEnvironment] = useState<"demo" | "production">("demo");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [callbackUrlError, setCallbackUrlError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [redirectNotice, setRedirectNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [controlTestName, setControlTestName] = useState("");
  const [controlTestEmail, setControlTestEmail] = useState("");
  const [runningControlTest, setRunningControlTest] = useState<"A" | "B" | null>(null);
  const [controlTestResult, setControlTestResult] = useState<{ variant: "A" | "B"; data: ControlTestResult } | null>(null);
  const [controlTestError, setControlTestError] = useState<ErrorPanelDataLike | null>(null);
  const [inspectEnvelopeId, setInspectEnvelopeId] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<EmailDeliveryInspection | null>(null);
  const [inspectError, setInspectError] = useState<ErrorPanelDataLike | null>(null);
  const [compareApiEnvelopeId, setCompareApiEnvelopeId] = useState("");
  const [compareManualEnvelopeId, setCompareManualEnvelopeId] = useState("");
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<EnvelopeComparisonResult | null>(null);
  const [compareError, setCompareError] = useState<ErrorPanelDataLike | null>(null);
  const [parityContentVersionId, setParityContentVersionId] = useState("");
  const [parityContractLabel, setParityContractLabel] = useState("");
  const [parityRecipientName, setParityRecipientName] = useState("");
  const [parityRecipientEmail, setParityRecipientEmail] = useState("");
  const [sendingParityTest, setSendingParityTest] = useState(false);
  const [parityResult, setParityResult] = useState<ProductionParityTestResponse | null>(null);
  const [parityError, setParityError] = useState<ErrorPanelDataLike | null>(null);
  const [isolationRecipientName, setIsolationRecipientName] = useState("");
  const [isolationRecipientEmail, setIsolationRecipientEmail] = useState("");
  const [isolationContentVersionId, setIsolationContentVersionId] = useState("");
  const [isolationContractLabel, setIsolationContractLabel] = useState("");
  const [runningIsolationCase, setRunningIsolationCase] = useState<1 | 2 | 3 | 4 | null>(null);
  const [isolationResults, setIsolationResults] = useState<IsolationTestResponse[]>([]);
  const [isolationError, setIsolationError] = useState<ErrorPanelDataLike | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setWebhookUrl(`${window.location.origin}/api/contracts/docusign/webhook`);
    const params = new URLSearchParams(window.location.search);
    if (params.get("docusignConnected")) {
      setRedirectNotice({ type: "success", message: "DocuSign connected successfully." });
      params.delete("docusignConnected");
      window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
    } else if (params.get("docusignError")) {
      setRedirectNotice({ type: "error", message: params.get("docusignError") ?? "DocuSign connection failed." });
      params.delete("docusignError");
      window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
    }
  }, []);

  function load() {
    setLoading(true);
    quoteApiGet<{ config: DocuSignConnectionConfig; diagnostics: OAuthDiagnostics }>("Load DocuSign settings", "/api/contracts/docusign/settings")
      .then(res => {
        setConfig(res.config);
        setDiagnostics(res.diagnostics);
        setEnvironment(res.config.environment);
        setClientId(res.config.clientId);
        setCallbackUrl(res.config.callbackUrl ?? "");
      })
      .catch(err => setError(toErrorPanelData(err, "Could not load DocuSign settings")))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setCallbackUrlError(null);
    try {
      // Log exactly what this form is about to submit — proves the request
      // payload actually carries the value currently shown in the Client ID
      // field, rather than assuming the UI and the outgoing request agree.
      // orgId is intentionally absent here: it's never sent by the browser,
      // only derived server-side from the authenticated Salesforce session.
      const trimmed = clientId.trim();
      const incomingClientIdMasked = trimmed.length <= 8 ? "*".repeat(trimmed.length) : `${trimmed.slice(0, 4)}${"*".repeat(trimmed.length - 6)}${trimmed.slice(-2)}`;
      console.log(
        `[DOCUSIGN SETTINGS SAVE]\nincomingClientIdMasked = ${incomingClientIdMasked}\nclientIdLength = ${trimmed.length}\nenvironment = ${environment}\ncallbackUrl = ${callbackUrl || "(blank — falls back to env/request origin)"}`,
      );
      const res = await quoteApiPost<{ config: DocuSignConnectionConfig; diagnostics: OAuthDiagnostics }>("Save DocuSign settings", "/api/contracts/docusign/settings", {
        environment, clientId, clientSecret, webhookSecret, callbackUrl,
      });
      setConfig(res.config);
      setDiagnostics(res.diagnostics);
      setClientSecret("");
      setWebhookSecret("");
    } catch (err) {
      const data = toErrorPanelData(err, "Could not save DocuSign settings");
      // Surface a callback-URL-specific validation error inline, next to the field, rather than only in the generic error panel.
      if (data.message?.toLowerCase().includes("callback url")) setCallbackUrlError(data.message);
      setError(data);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await quoteApiPost<{
        success: boolean; error?: string;
        userInfo?: { name: string; email: string }; account?: { id: string; name: string } | null; environment?: "demo" | "production";
      }>("Test DocuSign connection", "/api/contracts/docusign/test", {});
      if (res.success) {
        setTestResult({
          ok: true,
          message:
            `OAuth Configuration     Valid\n` +
            `DocuSign Connection     Connected\n` +
            `Environment             ${res.environment === "production" ? "Production" : "Demo"}\n` +
            `Account                 ${res.account?.name ?? res.account?.id ?? "—"}\n` +
            `User                    ${res.userInfo?.name} (${res.userInfo?.email})\n\n` +
            `This confirms OAuth connectivity only — it does not verify recipient signing-email delivery.`,
        });
      } else {
        setTestResult({ ok: false, message: res.error ?? "Connection test failed." });
      }
    } catch (err) {
      setError(toErrorPanelData(err, "Connection test failed"));
    } finally {
      setTesting(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await quoteApiPost<{ success: boolean; error?: string; config: DocuSignConnectionConfig }>("Refresh DocuSign connection", "/api/contracts/docusign/refresh", {});
      setConfig(res.config);
      if (!res.success) setError({ title: "Could not refresh the connection", message: res.error ?? "Refresh failed." });
    } catch (err) {
      setError(toErrorPanelData(err, "Could not refresh the DocuSign connection"));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      const res = await quoteApiPost<{ config: DocuSignConnectionConfig }>("Disconnect DocuSign", "/api/contracts/docusign/disconnect", {});
      setConfig(res.config);
      setConfirmDisconnect(false);
      setTestResult(null);
    } catch (err) {
      setError(toErrorPanelData(err, "Could not disconnect DocuSign"));
    } finally {
      setDisconnecting(false);
    }
  }

  function handleConnect() {
    window.location.href = "/api/contracts/docusign/connect";
  }

  /**
   * Email Delivery Control Test — calls the EXISTING, untouched
   * /api/contracts/docusign/diagnostics/test-send route (backed by
   * sendDocuSignControlTestEnvelope, which itself calls the same
   * createAndSendEnvelope() production uses). Not tied to any Contract —
   * uses a trivial synthetic PDF. Test A: explicit deliveryMethod, SignHere
   * tab present (never omitted). Test B: same, but tabs omitted — never
   * run automatically, only on its own explicit button click.
   */
  async function handleRunControlTest(variant: "A" | "B") {
    const recipientName = controlTestName.trim();
    const recipientEmail = controlTestEmail.trim();
    if (!recipientName || !recipientEmail) return;
    setRunningControlTest(variant);
    setControlTestError(null);
    setControlTestResult(null);
    try {
      const res = await quoteApiPost<ControlTestResult>("Send DocuSign control test", "/api/contracts/docusign/diagnostics/test-send", {
        recipientName, recipientEmail, explicitDeliveryMethod: true, omitTabs: variant === "B",
      });
      setControlTestResult({ variant, data: res });
    } catch (err) {
      setControlTestError(toErrorPanelData(err, `Could not send Control Test ${variant}`));
    } finally {
      setRunningControlTest(null);
    }
  }

  /** Read-only — never creates/modifies anything. Diagnoses email delivery AFTER DocuSign already accepted the envelope (§Phase 5). */
  async function handleInspectEmailDelivery() {
    const envelopeId = inspectEnvelopeId.trim();
    if (!envelopeId) return;
    setInspecting(true);
    setInspectError(null);
    setInspection(null);
    try {
      const res = await quoteApiGet<EmailDeliveryInspection>("Inspect email delivery", `/api/contracts/docusign/envelopes/${encodeURIComponent(envelopeId)}/inspect-email-delivery`);
      setInspection(res);
    } catch (err) {
      setInspectError(toErrorPanelData(err, "Could not inspect email delivery for this envelope"));
    } finally {
      setInspecting(false);
    }
  }

  /** Read-only — never creates/modifies anything. Fetches both envelopes' raw DocuSign responses and returns a classified, field-by-field diff (§ Compare Envelopes). */
  async function handleCompareEnvelopes() {
    const apiEnvelopeId = compareApiEnvelopeId.trim();
    const manualEnvelopeId = compareManualEnvelopeId.trim();
    if (!apiEnvelopeId || !manualEnvelopeId) return;
    setComparing(true);
    setCompareError(null);
    setComparison(null);
    try {
      const res = await quoteApiPost<EnvelopeComparisonResult>("Compare DocuSign envelopes", "/api/contracts/docusign/diagnostics/compare", { apiEnvelopeId, manualEnvelopeId });
      setComparison(res);
    } catch (err) {
      setCompareError(toErrorPanelData(err, "Could not compare these two envelopes"));
    } finally {
      setComparing(false);
    }
  }

  /**
   * "Production Parity Email Test" (Test C) — sends through the exact same
   * createAndSendEnvelope() production uses, with a REAL Salesforce
   * ContentVersion instead of the synthetic control-test PDF. Does NOT
   * create, lock, or advance any real signature request — this is diagnostic
   * only, isolated from localSignatureStore/signatureStatusStore/Contract.
   */
  async function handleSendParityTest() {
    const contentVersionId = parityContentVersionId.trim();
    const recipientName = parityRecipientName.trim();
    const recipientEmail = parityRecipientEmail.trim();
    if (!contentVersionId || !recipientName || !recipientEmail) return;
    setSendingParityTest(true);
    setParityError(null);
    setParityResult(null);
    try {
      const res = await quoteApiPost<ProductionParityTestResponse>("Send production parity test", "/api/contracts/docusign/diagnostics/production-parity-test", {
        contentVersionId, recipientName, recipientEmail, contractLabel: parityContractLabel.trim() || undefined,
      });
      setParityResult(res);
    } catch (err) {
      setParityError(toErrorPanelData(err, "Could not send the production parity test envelope"));
    } finally {
      setSendingParityTest(false);
    }
  }

  /**
   * Email-delivery isolation test (Cases 1-4) — one explicit button per
   * case, never auto-run, never chained. Each case adds exactly one more
   * production-shaped input on top of Test A's own known-working
   * document/subject/body, through the same canonical sender. Results
   * accumulate in a table rather than replacing each other, so all four can
   * be compared side by side once run.
   */
  async function handleRunIsolationCase(caseNumber: 1 | 2 | 3 | 4) {
    const recipientName = isolationRecipientName.trim();
    const recipientEmail = isolationRecipientEmail.trim();
    if (!recipientName || !recipientEmail) return;
    if ((caseNumber === 3 || caseNumber === 4) && !isolationContentVersionId.trim()) return;
    setRunningIsolationCase(caseNumber);
    setIsolationError(null);
    try {
      const res = await quoteApiPost<IsolationTestResponse>("Send email isolation test", "/api/contracts/docusign/diagnostics/email-isolation-test", {
        caseNumber, recipientName, recipientEmail,
        contentVersionId: isolationContentVersionId.trim() || undefined,
        contractLabel: isolationContractLabel.trim() || undefined,
      });
      setIsolationResults(prev => [...prev.filter(r => r.caseNumber !== caseNumber), res]);
    } catch (err) {
      setIsolationError(toErrorPanelData(err, `Could not send Case ${caseNumber}`));
    } finally {
      setRunningIsolationCase(null);
    }
  }

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, color: t.heading }}>
        <Ic n="plug" s={16} /> DocuSign Settings
      </div>
      <GhostButton label="Back" icon="arrow-left" isDark={isDark} onClick={onBack} />
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 20 }}>
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderRadius: 10, fontSize: 11.5, color: t.dim, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
          <Ic n="info" s={13} /> Development mode: this connection is held in server memory for the current session only and will be lost on a server restart. Production deployments will need a persistent, tenant-scoped secret store before this is durable.
        </div>
        {redirectNotice && (
          <div style={{
            display: "flex", gap: 8, padding: "10px 14px", borderRadius: 10, fontSize: 12.5, color: t.body,
            border: `1px solid ${redirectNotice.type === "success" ? t.accent : t.error}50`,
            background: `${redirectNotice.type === "success" ? t.accent : t.error}10`,
          }}>
            <Ic n={redirectNotice.type === "success" ? "check-circle" : "alert"} s={14} /> {redirectNotice.message}
          </div>
        )}
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {loading && <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} /> Loading…</div>}

        {!loading && config && (
          <>
            <Section title="Connection Status" icon="zap" isDark={isDark}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <Pill label={config.status.replace(/_/g, " ")} color={STATUS_COLOR[config.status]} isDark={isDark} />
                  {config.lastError && <div style={{ fontSize: 11.5, color: t.error, marginTop: 6 }}>{config.lastError}</div>}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <GhostButton label={testing ? "Testing…" : "Test Connection"} icon="check-circle" isDark={isDark} disabled={testing || config.status === "disconnected"} onClick={handleTest} />
                  <GhostButton label={refreshing ? "Refreshing…" : "Refresh Connection"} icon="refresh" isDark={isDark} disabled={refreshing || config.status === "disconnected"} onClick={handleRefresh} />
                  <PrimaryButton label={config.status === "connected" || config.status === "reauthorization_required" ? "Reconnect" : "Connect to DocuSign"} icon="plug" isDark={isDark} disabled={!config.hasClientSecret} onClick={handleConnect} />
                </div>
              </div>

              {(config.docusignAccountId || config.connectedUserName || config.connectedAt) && (
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                  <div style={{ fontSize: 11.5, color: t.body }}>
                    <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Connected Account</div>
                    {config.docusignAccountName ?? "—"}{config.docusignAccountId ? <span style={{ color: t.dim }}> ({config.docusignAccountId})</span> : null}
                  </div>
                  <div style={{ fontSize: 11.5, color: t.body }}>
                    <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Connected User</div>
                    {config.connectedUserName ? `${config.connectedUserName} (${config.connectedUserEmail})` : "—"}
                  </div>
                  <div style={{ fontSize: 11.5, color: t.body }}>
                    <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Connected Date</div>
                    {config.connectedAt ? new Date(config.connectedAt).toLocaleString() : "—"}
                  </div>
                </div>
              )}

              {testResult && (
                <div style={{ fontSize: 11.5, color: testResult.ok ? t.body : t.error, marginTop: 10, whiteSpace: "pre-wrap", padding: 10, borderRadius: 8, border: `1px solid ${testResult.ok ? t.border : t.error + "50"}`, background: testResult.ok ? t.surfaceAlt : `${t.error}10` }}>
                  {testResult.message}
                </div>
              )}

              {config.status !== "disconnected" && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
                  {!confirmDisconnect ? (
                    <GhostButton label="Disconnect" icon="x" isDark={isDark} danger onClick={() => setConfirmDisconnect(true)} />
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: t.body }}>
                      Disconnect DocuSign? Your Client ID/Secret/webhook configuration will be kept.
                      <GhostButton label={disconnecting ? "Disconnecting…" : "Confirm Disconnect"} icon="x" isDark={isDark} danger disabled={disconnecting} onClick={handleDisconnect} />
                      <GhostButton label="Cancel" isDark={isDark} onClick={() => setConfirmDisconnect(false)} />
                    </div>
                  )}
                </div>
              )}
            </Section>

            <Section title="OAuth App (per-organization)" icon="key" isDark={isDark}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <Field label="Environment" isDark={isDark}>
                  <select value={environment} onChange={e => setEnvironment(e.target.value as "demo" | "production")} style={inputStyle(t)}>
                    <option value="demo">Demo (sandbox)</option>
                    <option value="production">Production</option>
                  </select>
                </Field>
                <Field label="Client ID (Integration Key) *" isDark={isDark}>
                  <input value={clientId} onChange={e => setClientId(e.target.value)} style={inputStyle(t)} />
                </Field>
                <Field label="Client Secret *" isDark={isDark} hint={config.hasClientSecret ? "Already set — leave blank to keep it." : "Required"}>
                  <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} style={inputStyle(t)} placeholder={config.hasClientSecret ? "••••••••" : ""} />
                </Field>
                <Field label="Webhook HMAC Secret (Optional)" isDark={isDark} hint={config.hasWebhookSecret ? "Already set — leave blank to keep it." : "Optional — only required when DocuSign Connect webhook verification is enabled."}>
                  <input type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} style={inputStyle(t)} placeholder={config.hasWebhookSecret ? "••••••••" : ""} />
                </Field>
                <Field label="Callback / Redirect URL (Optional)" isDark={isDark} hint="Blank uses DOCUSIGN_REDIRECT_URI (if set) or this request's own origin.">
                  <input
                    value={callbackUrl}
                    onChange={e => { setCallbackUrl(e.target.value); setCallbackUrlError(null); }}
                    style={{ ...inputStyle(t), ...(callbackUrlError ? { borderColor: t.error } : {}) }}
                    placeholder="http://localhost:3000/api/contracts/docusign/callback"
                  />
                </Field>
              </div>
              {callbackUrlError && (
                <div style={{ fontSize: 11, color: t.error, marginTop: 6, display: "flex", gap: 6 }}>
                  <Ic n="alert" s={12} /> {callbackUrlError}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: t.dim, marginTop: 6, display: "flex", gap: 6 }}>
                <Ic n="info" s={11} /> This URL must also be registered as a Redirect URI for this Integration Key in your DocuSign application configuration.
              </div>
              <div style={{ marginTop: 12 }}>
                <PrimaryButton label={saving ? "Saving…" : "Save Settings"} icon="check" isDark={isDark} disabled={saving || !clientId.trim()} onClick={handleSave} />
              </div>

              {diagnostics && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>OAuth Diagnostics</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, fontSize: 11.5 }}>
                    <div>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Environment</div>
                      {diagnostics.environment === "production" ? "Production" : "Demo (sandbox)"}
                    </div>
                    <div>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Integration Key</div>
                      {diagnostics.maskedClientId ?? "—"}
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Resolved Redirect URI</div>
                      <code style={{ wordBreak: "break-all" }}>{diagnostics.resolvedRedirectUri}</code>
                    </div>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Redirect URI Source</div>
                      {REDIRECT_SOURCE_LABEL[diagnostics.redirectUriSource]}
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <Section title="DocuSign Connect Webhook" icon="send" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 8 }}>
                Configure a Connect (webhook) subscription in your DocuSign account pointing at this URL, using the same webhook HMAC secret entered above:
              </div>
              <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11.5, color: t.body, overflowX: "auto" }}>{webhookUrl}</pre>
              <div style={{ fontSize: 11, color: t.dim, marginTop: 8, display: "flex", gap: 6 }}>
                <Ic n="info" s={12} /> This receiver is live — DocuSign Connect events advance a Contract's signature status (Viewed/Signed/Completed) automatically once configured here. If the Webhook HMAC Secret above is set, every incoming event's signature is verified before it's trusted. On localhost (no public HTTPS endpoint DocuSign can reach), use the Signatures tab's "Refresh DocuSign Status" button instead — it calls the exact same status logic on demand.
              </div>
            </Section>

            <Section title="Email Delivery Control Test" icon="send" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 10 }}>
                Sends ONE standalone diagnostic envelope (a trivial synthetic PDF, not tied to any Contract) through the exact same createAndSendEnvelope() production uses. Test A: explicit deliveryMethod, SignHere tab present. Test B: same, but tabs omitted — use only to compare against Test A, never run automatically.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="Recipient Name *" isDark={isDark}>
                  <input value={controlTestName} onChange={e => setControlTestName(e.target.value)} style={inputStyle(t)} />
                </Field>
                <Field label="Recipient Email *" isDark={isDark}>
                  <input type="email" value={controlTestEmail} onChange={e => setControlTestEmail(e.target.value)} style={inputStyle(t)} placeholder="name@example.com" />
                </Field>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <PrimaryButton
                  label={runningControlTest === "A" ? "Sending…" : "Send Control Test A (explicit deliveryMethod, keep SignHere tab)"}
                  icon="send" isDark={isDark}
                  disabled={runningControlTest !== null || !controlTestName.trim() || !controlTestEmail.trim()}
                  onClick={() => handleRunControlTest("A")}
                />
                <GhostButton
                  label={runningControlTest === "B" ? "Sending…" : "Send Control Test B (no tabs)"}
                  icon="send" isDark={isDark}
                  disabled={runningControlTest !== null || !controlTestName.trim() || !controlTestEmail.trim()}
                  onClick={() => handleRunControlTest("B")}
                />
              </div>

              {controlTestError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={controlTestError} /></div>}

              {controlTestResult && (
                <div style={{ marginTop: 14, padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                  <div style={{ fontWeight: 700, color: t.heading, marginBottom: 6 }}>
                    Test {controlTestResult.variant} — envelopeId {controlTestResult.data.envelopeId} · status {controlTestResult.data.envelopeStatus}
                  </div>
                  {controlTestResult.data.recipients.map((r, i) => (
                    <div key={i} style={{ color: t.body }}>
                      recipientStatus: <strong>{r.status ?? "—"}</strong> · deliveryMethod: <strong>{r.deliveryMethod ?? "—"}</strong> · clientUserIdPresent: <strong>{String(r.clientUserIdPresent)}</strong>
                      <div style={{ color: t.dim, marginTop: 2 }}>
                        sentDateTime: {r.sentDateTime ?? "—"} · deliveredDateTime: {r.deliveredDateTime ?? "—"} · recipientSuppliesTabs: {r.recipientSuppliesTabs ?? "—"} · totalTabCount: {r.totalTabCount ?? "—"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Inspect Email Delivery" icon="search" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 10 }}>
                Read-only. DocuSign returning HTTP 201 and its audit trail saying "Sent Invitations" only proves DocuSign <em>accepted</em> the envelope and generated an invitation — neither is proof the recipient's mail server received it. Paste an envelope ID to pull DocuSign's own recipient/delivery/audit data directly and get an evidence-based verdict.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div style={{ flex: "1 1 320px", minWidth: 240 }}>
                  <Field label="Envelope ID" isDark={isDark}>
                    <input value={inspectEnvelopeId} onChange={e => setInspectEnvelopeId(e.target.value)} style={inputStyle(t)} placeholder="e.g. 20a12b80-a955-87e1-815f-b8a4948e0411" />
                  </Field>
                </div>
                <PrimaryButton label={inspecting ? "Inspecting…" : "Inspect"} icon="search" isDark={isDark} disabled={inspecting || !inspectEnvelopeId.trim()} onClick={handleInspectEmailDelivery} />
              </div>

              {inspectError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={inspectError} /></div>}

              {inspection && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{
                    padding: 10, borderRadius: 9, fontSize: 12.5, fontWeight: 700, color: t.heading,
                    border: `1px solid ${t.accent}50`, background: `${t.accent}12`,
                  }}>
                    Verdict: {EMAIL_DELIVERY_VERDICT_LABEL[inspection.verdict]}
                    <div style={{ marginTop: 6, fontSize: 11.5, fontWeight: 400, color: t.body }}>{inspection.verdictReason}</div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, fontSize: 11.5 }}>
                    <div>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Envelope Status</div>
                      {inspection.envelopeStatus}
                    </div>
                    <div>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Sent</div>
                      {inspection.sentDateTime ? new Date(inspection.sentDateTime).toLocaleString() : "—"}
                    </div>
                    <div>
                      <div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>Status Changed</div>
                      {inspection.statusChangedDateTime ? new Date(inspection.statusChangedDateTime).toLocaleString() : "—"}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Recipients (as reported by DocuSign)</div>
                    {inspection.recipients.map((r, i) => (
                      <div key={i} style={{ padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5, marginBottom: 6 }}>
                        <div style={{ fontWeight: 700, color: t.heading }}>{r.name || r.maskedEmail} <span style={{ fontWeight: 400, color: t.dim }}>({r.maskedEmail})</span></div>
                        <div style={{ color: t.body, marginTop: 4 }}>
                          status: <strong>{r.status ?? "—"}</strong> · deliveryMethod: <strong>{r.deliveryMethod ?? "—"}</strong> · clientUserId present: <strong>{String(r.clientUserIdPresent)}</strong>
                        </div>
                        <div style={{ color: t.dim, marginTop: 4 }}>
                          sent: {r.sentDateTime ? new Date(r.sentDateTime).toLocaleString() : "—"}
                          {" · "}delivered: {r.deliveredDateTime ? new Date(r.deliveredDateTime).toLocaleString() : "—"}
                          {" · "}signed: {r.signedDateTime ? new Date(r.signedDateTime).toLocaleString() : "—"}
                          {r.declinedDateTime && <> · declined: {new Date(r.declinedDateTime).toLocaleString()}</>}
                        </div>
                        {(r.declinedReason || r.autoRespondedReason) && (
                          <div style={{ color: t.error, marginTop: 4 }}>
                            {r.declinedReason && <>declinedReason: {r.declinedReason} </>}
                            {r.autoRespondedReason && <>autoRespondedReason: {r.autoRespondedReason}</>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Audit Timeline</div>
                    {!inspection.auditEventsAvailable ? (
                      <div style={{ fontSize: 11.5, color: t.dim }}>Not available — this DocuSign account/plan does not expose the audit_events endpoint (this is itself evidence relevant to verdict E, not an error).</div>
                    ) : inspection.auditEvents && inspection.auditEvents.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {inspection.auditEvents.map((e, i) => (
                          <div key={i} style={{ fontSize: 11, color: t.body, display: "flex", gap: 8 }}>
                            <span style={{ color: t.dim, flexShrink: 0 }}>{e.eventDateTime ? new Date(e.eventDateTime).toLocaleString() : "—"}</span>
                            <span>{e.eventName ?? "(unnamed event)"}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: t.dim }}>No audit events returned.</div>
                    )}
                  </div>
                </div>
              )}
            </Section>

            <Section title="Compare Envelopes" icon="layers" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 10 }}>
                Read-only. Compares an API-created envelope against a manually-created one field-by-field, straight from DocuSign's own raw responses. Generated IDs, timestamps, and IP addresses are normalized out — every remaining difference is still shown, classified as a starting point for triage (not a verdict).
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="API-created (failing) Envelope ID" isDark={isDark}>
                  <input value={compareApiEnvelopeId} onChange={e => setCompareApiEnvelopeId(e.target.value)} style={inputStyle(t)} placeholder="e.g. 08fe2d60-c8b7-8e4e-81ae-400be5860435" />
                </Field>
                <Field label="Manually-created (working) Envelope ID" isDark={isDark}>
                  <input value={compareManualEnvelopeId} onChange={e => setCompareManualEnvelopeId(e.target.value)} style={inputStyle(t)} placeholder="Paste the manual envelope ID" />
                </Field>
              </div>
              <div style={{ marginTop: 10 }}>
                <PrimaryButton label={comparing ? "Comparing…" : "Compare"} icon="layers" isDark={isDark} disabled={comparing || !compareApiEnvelopeId.trim() || !compareManualEnvelopeId.trim()} onClick={handleCompareEnvelopes} />
              </div>

              {compareError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={compareError} /></div>}

              {comparison && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Sender / Account Identity</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div>
                        <div style={{ color: t.dim, fontSize: 10.5 }}>API envelope sender</div>
                        <div style={{ color: t.body }}>userId: {comparison.senderIdentityComparison.apiSenderUserId ?? "—"}</div>
                        <div style={{ color: t.body }}>accountId: {comparison.senderIdentityComparison.apiSenderAccountId ?? "—"}</div>
                        <div style={{ color: t.body }}>email: {comparison.senderIdentityComparison.apiSenderEmailMasked ?? "—"}</div>
                      </div>
                      <div>
                        <div style={{ color: t.dim, fontSize: 10.5 }}>Manual envelope sender</div>
                        <div style={{ color: t.body }}>userId: {comparison.senderIdentityComparison.manualSenderUserId ?? "—"}</div>
                        <div style={{ color: t.body }}>accountId: {comparison.senderIdentityComparison.manualSenderAccountId ?? "—"}</div>
                        <div style={{ color: t.body }}>email: {comparison.senderIdentityComparison.manualSenderEmailMasked ?? "—"}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${t.border}`, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <Pill label={comparison.senderIdentityComparison.sameSenderUserId ? "Same sender user" : "DIFFERENT sender user"} color={comparison.senderIdentityComparison.sameSenderUserId ? t.accent : t.error} isDark={isDark} />
                      <Pill label={comparison.senderIdentityComparison.sameSenderAccountId ? "Same DocuSign account" : "DIFFERENT DocuSign account"} color={comparison.senderIdentityComparison.sameSenderAccountId ? t.accent : t.error} isDark={isDark} />
                    </div>
                    {comparison.senderIdentityComparison.activeSession && (
                      <div style={{ marginTop: 8, color: t.dim, fontSize: 10.5 }}>
                        This org's active session used to fetch both: {comparison.senderIdentityComparison.activeSession.environment} · accountId {comparison.senderIdentityComparison.activeSession.accountId} · {comparison.senderIdentityComparison.activeSession.baseUri}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
                      Side-by-side confirmation (not a diff — every field shown for BOTH, whether same or different)
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead>
                          <tr style={{ textAlign: "left", color: t.dim, fontSize: 10, textTransform: "uppercase" }}>
                            <th style={{ padding: "4px 6px" }}>Field</th>
                            <th style={{ padding: "4px 6px" }}>API-created</th>
                            <th style={{ padding: "4px 6px" }}>Manual</th>
                            <th style={{ padding: "4px 6px" }}>Same?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {SUMMARY_ROWS.map(row => {
                            const apiVal = row.get(comparison.apiSummary);
                            const manualVal = row.get(comparison.manualSummary);
                            const same = apiVal === manualVal;
                            return (
                              <tr key={row.label} style={{ borderTop: `1px solid ${t.border}` }}>
                                <td style={{ padding: "4px 6px", color: t.dim, fontFamily: "ui-monospace, monospace" }}>{row.label}</td>
                                <td style={{ padding: "4px 6px", color: t.body }}>{apiVal}</td>
                                <td style={{ padding: "4px 6px", color: t.body }}>{manualVal}</td>
                                <td style={{ padding: "4px 6px" }}>
                                  <Pill label={same ? "Same" : "DIFFERENT"} color={same ? t.accent : t.error} isDark={isDark} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {comparison.strongestCandidate ? (
                    <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.warn}50`, background: `${t.warn}10`, fontSize: 11.5 }}>
                      <div style={{ fontWeight: 700, color: t.heading }}>
                        {comparison.strongestCandidate.classification === "strong-delivery-candidate" ? "Strongest candidate" : "Only notable structural difference"}: {comparison.strongestCandidate.path}
                      </div>
                      <div style={{ color: t.body, marginTop: 4 }}>API: {JSON.stringify(comparison.strongestCandidate.apiValue)} — Manual: {JSON.stringify(comparison.strongestCandidate.manualValue)}</div>
                      <div style={{ color: t.dim, marginTop: 6, fontStyle: "italic" }}>
                        Not proven causal by classification alone — this is a triage starting point, not a verdict. Rule it out (or in) with a controlled test before treating it as the root cause. (E.g. a prior control test successfully delivered email with an explicit SignHere tab present, which by itself disproves "a SignHere tab prevents delivery.")
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5, color: t.body }}>
                      No "strong" or "possibly" delivery-relevant field differences found. Envelope payload is no longer the likely cause — investigation should move to DocuSign account/API email-delivery behavior.
                    </div>
                  )}

                  {([
                    ["Envelope", comparison.envelopeDiffs],
                    ["Recipients", comparison.recipientDiffs],
                    ["Notification", comparison.notificationDiffs],
                    ["Audit", comparison.auditDiffs],
                  ] as [string, EnvelopeDiffEntry[]][]).map(([label, diffs]) => (
                    <div key={label}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>{label} differences ({diffs.length})</div>
                      {diffs.length === 0 ? (
                        <div style={{ fontSize: 11.5, color: t.dim }}>No differences.</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {diffs.map((d, i) => (
                            <div key={i} style={{ padding: "6px 8px", borderRadius: 6, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <code style={{ color: t.heading }}>{d.path}</code>
                                <Pill label={DIFF_CLASSIFICATION_LABEL[d.classification]} color={DIFF_CLASSIFICATION_COLOR[d.classification]} isDark={isDark} />
                              </div>
                              <div style={{ color: t.dim, marginTop: 3 }}>API: {JSON.stringify(d.apiValue)} — Manual: {JSON.stringify(d.manualValue)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Production Parity Email Test" icon="send" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 10 }}>
                Sends ONE envelope through the exact same production envelope-creation function, using a REAL Salesforce Contract ContentVersion (real bytes/FileExtension) instead of the synthetic control-test PDF — same deliveryMethod default, same SignHere tab, same status "sent". Does not create, lock, or advance any real signature request or touch any Contract field. Find a ContentVersion ID on a Contract's Documents or Signatures tab.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="Salesforce ContentVersion ID *" isDark={isDark}>
                  <input value={parityContentVersionId} onChange={e => setParityContentVersionId(e.target.value)} style={inputStyle(t)} placeholder="068..." />
                </Field>
                <Field label="Contract Label (optional)" isDark={isDark} hint="Used for the email subject/body and document name — blank falls back to 'Production Parity Test'.">
                  <input value={parityContractLabel} onChange={e => setParityContractLabel(e.target.value)} style={inputStyle(t)} placeholder="e.g. C-00001234" />
                </Field>
                <Field label="Recipient Name *" isDark={isDark}>
                  <input value={parityRecipientName} onChange={e => setParityRecipientName(e.target.value)} style={inputStyle(t)} />
                </Field>
                <Field label="Recipient Email *" isDark={isDark}>
                  <input type="email" value={parityRecipientEmail} onChange={e => setParityRecipientEmail(e.target.value)} style={inputStyle(t)} placeholder="name@gmail.com" />
                </Field>
              </div>
              <div style={{ marginTop: 10 }}>
                <PrimaryButton
                  label={sendingParityTest ? "Sending…" : "Send Test C"}
                  icon="send" isDark={isDark}
                  disabled={sendingParityTest || !parityContentVersionId.trim() || !parityRecipientName.trim() || !parityRecipientEmail.trim()}
                  onClick={handleSendParityTest}
                />
              </div>

              {parityError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={parityError} /></div>}

              {parityResult && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Verified in Salesforce before sending</div>
                    <div style={{ color: t.body }}>Title: {parityResult.verified.Title} · FileExtension: {parityResult.verified.FileExtension} · Size: {parityResult.verified.ContentSize} bytes · IsLatest: {String(parityResult.verified.IsLatest)}</div>
                    <div style={{ color: t.dim, marginTop: 3 }}>ContentDocumentId: {parityResult.verified.ContentDocumentId}</div>
                  </div>
                  <div style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.accent}50`, background: `${t.accent}12`, fontSize: 12.5, fontWeight: 700, color: t.heading }}>
                    Envelope accepted by DocuSign (HTTP 201) — envelopeId {parityResult.send.envelopeId}
                    <div style={{ marginTop: 6, fontSize: 11.5, fontWeight: 400, color: t.error }}>
                      Whether the email actually arrives: USER CONFIRMATION REQUIRED — check the recipient inbox now.
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, fontSize: 11.5 }}>
                    <div><div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>ContentVersion Id</div>{parityResult.send.contentVersionId}</div>
                    <div><div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>File Extension</div>{parityResult.send.fileExtension}</div>
                    <div><div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>PDF Header Check</div>{parityResult.send.pdfHeaderCheck}</div>
                    <div><div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>Envelope Status</div>{parityResult.diagnostics.envelopeStatus}</div>
                    <div><div style={{ color: t.dim, fontSize: 10.5, textTransform: "uppercase" }}>Sent</div>{parityResult.diagnostics.sentDateTime ? new Date(parityResult.diagnostics.sentDateTime).toLocaleString() : "—"}</div>
                  </div>
                  {parityResult.diagnostics.recipients.map((r, i) => (
                    <div key={i} style={{ padding: 10, borderRadius: 8, border: `1px solid ${t.border}`, background: t.surfaceAlt, fontSize: 11.5 }}>
                      <div style={{ fontWeight: 700, color: t.heading }}>{r.name} <span style={{ fontWeight: 400, color: t.dim }}>({r.maskedEmail})</span></div>
                      <div style={{ color: t.body, marginTop: 4 }}>
                        status: <strong>{r.status ?? "—"}</strong> · deliveryMethod: <strong>{r.deliveryMethod ?? "—"}</strong> · clientUserId present: <strong>{String(r.clientUserIdPresent)}</strong>
                      </div>
                      <div style={{ color: t.body, marginTop: 4 }}>
                        recipientSuppliesTabs: <strong>{r.recipientSuppliesTabs ?? "—"}</strong> · totalTabCount: <strong>{r.totalTabCount ?? "—"}</strong>
                      </div>
                      <div style={{ color: t.dim, marginTop: 4 }}>
                        sent: {r.sentDateTime ? new Date(r.sentDateTime).toLocaleString() : "—"}
                        {" · "}delivered: {r.deliveredDateTime ? new Date(r.deliveredDateTime).toLocaleString() : "—"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Email Delivery Isolation Test (Cases 1–4)" icon="sliders" isDark={isDark}>
              <div style={{ fontSize: 12, color: t.body, marginBottom: 10 }}>
                Isolates which single input differs between the working Test A send and a production Contract send. Every case sends through the SAME canonical function Test A/production/Test C all share — only the document and/or email content change, one variable at a time. Each button click creates ONE new envelope; nothing runs automatically. Envelope status "sent" is never proof the email arrived — check the recipient inbox directly for each case, then record YES/NO below.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Field label="Recipient Name *" isDark={isDark}>
                  <input value={isolationRecipientName} onChange={e => setIsolationRecipientName(e.target.value)} style={inputStyle(t)} />
                </Field>
                <Field label="Recipient Email *" isDark={isDark}>
                  <input type="email" value={isolationRecipientEmail} onChange={e => setIsolationRecipientEmail(e.target.value)} style={inputStyle(t)} placeholder="name@gmail.com" />
                </Field>
                <Field label="Salesforce ContentVersion ID" isDark={isDark} hint="Required for Case 3 and Case 4 only.">
                  <input value={isolationContentVersionId} onChange={e => setIsolationContentVersionId(e.target.value)} style={inputStyle(t)} placeholder="068... (Case 3/4 only)" />
                </Field>
                <Field label="Contract Label (optional)" isDark={isDark} hint="Used to build the production-style subject/body for Case 2/4 — blank falls back to 'Isolation Test'.">
                  <input value={isolationContractLabel} onChange={e => setIsolationContractLabel(e.target.value)} style={inputStyle(t)} placeholder="e.g. 00000110" />
                </Field>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 12 }}>
                {ISOLATION_CASES.map(c => {
                  const disabled =
                    runningIsolationCase !== null ||
                    !isolationRecipientName.trim() || !isolationRecipientEmail.trim() ||
                    (c.requiresContentVersion && !isolationContentVersionId.trim());
                  const already = isolationResults.find(r => r.caseNumber === c.caseNumber);
                  return (
                    <div key={c.caseNumber} style={{ padding: 10, borderRadius: 9, border: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: t.heading }}>{c.title}</div>
                      <div style={{ fontSize: 10.5, color: t.dim, marginTop: 4, marginBottom: 8 }}>{c.description}</div>
                      <PrimaryButton
                        label={runningIsolationCase === c.caseNumber ? "Sending…" : already ? "Run Again (new envelope)" : "Run Case"}
                        icon="send" isDark={isDark}
                        disabled={disabled}
                        onClick={() => handleRunIsolationCase(c.caseNumber)}
                      />
                    </div>
                  );
                })}
              </div>

              {isolationError && <div style={{ marginTop: 10 }}><ErrorPanel isDark={isDark} error={isolationError} /></div>}

              {isolationResults.length > 0 && (
                <div style={{ marginTop: 14, overflowX: "auto" }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                    Results — check each inbox, then compare which arrived
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: t.dim, borderBottom: `1px solid ${t.border}` }}>
                        <th style={{ padding: "6px 8px" }}>Case</th>
                        <th style={{ padding: "6px 8px" }}>Envelope ID</th>
                        <th style={{ padding: "6px 8px" }}>Document</th>
                        <th style={{ padding: "6px 8px" }}>Email Content</th>
                        <th style={{ padding: "6px 8px" }}>DocuSign Status</th>
                        <th style={{ padding: "6px 8px" }}>Recipient Status</th>
                        <th style={{ padding: "6px 8px" }}>Audit Trail</th>
                        <th style={{ padding: "6px 8px" }}>Arrived in inbox?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...isolationResults].sort((a, b) => a.caseNumber - b.caseNumber).map(r => {
                        const recipient = r.diagnostics.recipients[0];
                        return (
                          <tr key={r.caseNumber} style={{ borderBottom: `1px solid ${t.border}` }}>
                            <td style={{ padding: "6px 8px", fontWeight: 700, color: t.heading }}>Case {r.caseNumber}</td>
                            <td style={{ padding: "6px 8px", color: t.body, fontFamily: "monospace", fontSize: 10.5 }}>{r.envelopeId}</td>
                            <td style={{ padding: "6px 8px", color: t.body }}>{r.documentSource === "salesforce-content-version" ? `Salesforce (${r.documentTitle})` : "Test A control PDF"}</td>
                            <td style={{ padding: "6px 8px", color: t.body }}>{r.emailContentSource === "production-template" ? "Production template" : "Test A fixed"}</td>
                            <td style={{ padding: "6px 8px", color: t.body }}>{r.diagnostics.envelopeStatus}</td>
                            <td style={{ padding: "6px 8px", color: t.body }}>
                              {recipient?.status ?? "—"}
                              {recipient?.autoRespondedReason && <span style={{ color: t.error }}> ({recipient.autoRespondedReason})</span>}
                            </td>
                            <td style={{ padding: "6px 8px", color: t.dim, fontSize: 10.5 }}>
                              {r.diagnostics.auditEvents?.length ? r.diagnostics.auditEvents.map(e => e.eventName).join(" → ") : "—"}
                            </td>
                            <td style={{ padding: "6px 8px", color: t.dim, fontStyle: "italic" }}>Check inbox — not inferable from the API</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </PageShell>
  );
}
