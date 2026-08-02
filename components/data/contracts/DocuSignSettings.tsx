"use client";

import { useEffect, useState } from "react";
import { Section, Ic, tokens, inputStyle, Field, PrimaryButton, GhostButton, PageShell, Pill, Spinner, ErrorPanel } from "@/components/data/quotes/shared";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import type { DocuSignConnectionConfig } from "@/lib/contracts/types";

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
                <Ic n="info" s={12} /> Not wired up to a receiver yet — Sent is the only real, DocuSign-confirmed status today. Configuring this URL now is still useful groundwork, but Delivered/Viewed/Signed/Completed status updates require the receiver to be built.
              </div>
            </Section>
          </>
        )}
      </div>
    </PageShell>
  );
}
