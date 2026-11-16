"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ErrorPanel, Field, GhostButton, Ic, PageShell, PrimaryButton, Section, Spinner, inputStyle, tokens } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { ENVIRONMENT_LABEL, SERVER_SECURITY_TEXT, serverSecurityMessage, type ConnectionStatusResponse, type DocuSignEnvironment, type PublicConnection, type VerificationCheck } from "@/lib/contracts/docusign/types";
import { ConnectionBadge, CopyField, Note, fmtDateTime, useDocuSignStatus } from "@/components/data/contracts/docusign/shared";

/**
 * DocuSign Settings, in three plain sections:
 *  1. Connect DocuSign   — environment, Integration Key, Secret Key, the auto-generated Redirect URI, "Connect to DocuSign".
 *  2. Connection Status  — account, Account ID, environment, last verified; Test Connection / Reconnect / Disconnect.
 *  3. Help & Troubleshooting.
 * Server encryption is the deployment administrator’s job (docs/DOCUSIGN_SERVER_SETUP.md). If the server can’t store credentials
 * securely, the form stays visible but Connect is disabled with one short note — the backend refuses the connection regardless.
 * Credentials typed here are sent once to the server (OAuth Authorization Code Grant), stored encrypted there, and never shown again.
 */

const LINKS = {
  developerAccount: "https://developers.docusign.com/",
  appsAndKeys: { demo: "https://admindemo.docusign.com/apps-and-keys", production: "https://admin.docusign.com/apps-and-keys" } as Record<DocuSignEnvironment, string>,
  authCodeGrant: "https://developers.docusign.com/platform/auth/authcode/",
  configureApp: "https://developers.docusign.com/platform/configure-app/",
  goLive: "https://developers.docusign.com/platform/go-live/",
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALLBACK_ERRORS: Record<string, string> = {
  DOCUSIGN_ENCRYPTION_KEY_MISSING: SERVER_SECURITY_TEXT.missing,
  DOCUSIGN_ENCRYPTION_KEY_INVALID: SERVER_SECURITY_TEXT.invalid,
  SALESFORCE_SESSION_MISSING: "Your Salesforce session ended while you were on DocuSign. Sign in again, then connect.",
  CONNECT_EXPIRED: "The connection attempt took longer than 10 minutes or was started in another browser. Click Connect to DocuSign again.",
  STATE_MISMATCH: "The DocuSign response did not match this connection attempt, so it was rejected to protect your account. Click Connect to DocuSign again.",
  SESSION_MISMATCH: "The DocuSign sign-in finished under a different Salesforce session than the one that started it. Click Connect to DocuSign again.",
  NO_CODE: "DocuSign did not return an authorization code. Try again.",
  NO_REFRESH_TOKEN: "DocuSign did not issue a long-lived sign-in. Make sure Authorization Code Grant is enabled on the Integration Key.",
  NO_ACCOUNT: "The DocuSign user who signed in has no eSignature account.",
  ACCOUNT_NOT_FOUND: "The API Account ID you entered does not belong to the DocuSign user who signed in. Leave it blank to use their default account.",
  INVALID_BASE_URI: "DocuSign returned an unexpected API address, so the connection was not saved.",
  ESIGNATURE_ACCESS_FAILED: "You signed in, but this account does not allow eSignature API access. Check the plan and your user permissions in DocuSign.",
  CREDENTIALS_TOO_LARGE: "DocuSign returned a sign-in credential too large to store securely in this browser, so the connection was not saved. Try again; contact support if it repeats.",
  access_denied: "The DocuSign sign-in was cancelled, or you chose not to allow access.",
  consent_required: "DocuSign needs you to allow OmniCloud to access your account. Click Connect to DocuSign and choose Allow.",
  invalid_client: "DocuSign did not accept the Integration Key and Secret Key. Check both, and that they belong to the environment you chose (Demo or Production).",
  invalid_grant: "DocuSign rejected the sign-in code. Start again with Connect to DocuSign.",
  unauthorized_client: "This Integration Key is not allowed to use Authorization Code Grant. Enable it in DocuSign Apps and Keys.",
  invalid_request: "DocuSign rejected the request — usually the Redirect URI on the Integration Key does not exactly match the one shown here.",
};

function readCallbackResult(): { kind: "connected" } | { kind: "error"; message: string } | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  if (p.get("ds") === "connected") return { kind: "connected" };
  const code = p.get("ds_error");
  return code ? { kind: "error", message: CALLBACK_ERRORS[code] ?? `DocuSign connection failed (${code}).` } : null;
}

export default function DocuSignSettings({ isDark, onBack }: { isDark: boolean; onBack?: () => void }) {
  const t = tokens(isDark);
  const { data, error: loadError, reload, setData } = useDocuSignStatus();
  const [callback] = useState(readCallbackResult);
  const [checks, setChecks] = useState<VerificationCheck[] | null>(null);
  const [verifying, setVerifying] = useState(callback?.kind === "connected");
  const [verifyError, setVerifyError] = useState<ErrorPanelDataLike | null>(null);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<"reconnect" | "disconnect" | null>(null);
  const [actionError, setActionError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Remove the one-time ?ds / ?ds_error result from the address bar (it was read once above).
  useEffect(() => {
    if (!callback) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("ds");
    url.searchParams.delete("ds_error");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [callback]);

  // Every state update happens in the promise callbacks (after DocuSign answers), so this can also run from the mount effect below.
  const runVerify = useCallback(() => quoteApiPost<{ checks: VerificationCheck[]; connection: PublicConnection }>("Test DocuSign connection", "/api/contracts/docusign/verify")
    .then(r => {
      setChecks(r.checks);
      setVerifyError(null);
      setData(d => (d ? { ...d, status: "connected", connection: r.connection } : d));
    })
    .catch(e => {
      const raw = (e as { raw?: { checks?: VerificationCheck[]; status?: string } }).raw;
      setChecks(raw?.checks ?? null);
      if (raw?.status === "expired") setData(d => (d ? { ...d, status: "expired" } : d));
      setVerifyError(toErrorPanelData(e, "Connection check failed"));
    })
    .finally(() => setVerifying(false)), [setData]);

  // Step 5 of connecting: right after DocuSign sends the user back, verify everything automatically.
  useEffect(() => {
    if (callback?.kind === "connected") void runVerify();
  }, [callback, runVerify]);

  async function reconnect() {
    setBusy("reconnect"); setActionError(null);
    try {
      const r = await quoteApiPost<{ authorizeUrl: string }>("Reconnect DocuSign", "/api/contracts/docusign/connect", { reuseSaved: true });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setBusy(null);
      if ((e as { code?: string }).code === "NO_SAVED_CONNECTION") { setEditingCredentials(true); setNotice("Enter your Integration Key and Secret Key below to reconnect."); return; }
      setActionError(toErrorPanelData(e, "Couldn't start reconnecting"));
    }
  }

  async function doDisconnect() {
    setConfirmDisconnect(false); setBusy("disconnect"); setActionError(null);
    try {
      await quoteApiPost("Disconnect DocuSign", "/api/contracts/docusign/disconnect");
      setChecks(null); setVerifyError(null); setEditingCredentials(false);
      setNotice("DocuSign was disconnected and the saved credentials were deleted.");
      reload();
    } catch (e) { setActionError(toErrorPanelData(e, "Couldn't disconnect")); }
    finally { setBusy(null); }
  }

  const status = data?.status ?? null;
  const conn = data?.connection ?? null;
  const keyReady = !!data?.encryptionReady;

  const header = (
    <div style={{ padding: "16px 20px", borderBottom: `1px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: t.heading }}>
        <Ic n="send" s={17} /> DocuSign Settings
        {status && status !== "setup_required" && <ConnectionBadge isDark={isDark} status={status} />}
      </div>
      {onBack && <GhostButton label="Back to Contracts" icon="arrow-left" isDark={isDark} onClick={onBack} />}
    </div>
  );

  return (
    <PageShell header={header}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 20, maxWidth: 940 }}>
        {callback?.kind === "error" && <Note isDark={isDark} tone="bad"><strong>DocuSign was not connected.</strong> {callback.message}</Note>}
        {notice && <Note isDark={isDark} tone="ok">{notice}</Note>}
        {loadError && <Note isDark={isDark} tone="bad">{loadError}</Note>}
        {actionError && <ErrorPanel isDark={isDark} error={actionError} />}
        {!data && !loadError && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: t.dim }}><Spinner isDark={isDark} /> Checking your DocuSign setup…</div>}

        {data && (
          <>
            <ConnectSection isDark={isDark} data={data} keyReady={keyReady} connected={!!conn && status === "connected"} editing={editingCredentials} onEdit={setEditingCredentials} />
            <StatusSection isDark={isDark} status={status!} conn={conn} keyReady={keyReady} message={data.message} checks={checks} verifying={verifying} verifyError={verifyError} busy={busy}
              onTest={() => { setVerifying(true); setVerifyError(null); setChecks(null); void runVerify(); }}
              onReconnect={reconnect} onDisconnect={() => setConfirmDisconnect(true)} />
          </>
        )}

        <HelpGuide isDark={isDark} redirectUri={data?.redirectUri ?? null} />
      </div>

      {confirmDisconnect && (
        <Modal isDark={isDark} title="Disconnect DocuSign?" tone="warn" actions={<>
          <GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirmDisconnect(false)} />
          <PrimaryButton isDark={isDark} label="Disconnect" icon="x" onClick={doDisconnect} />
        </>}>
          OmniCloud will delete the saved DocuSign credentials for your session. Envelopes you already sent are not affected — they stay in DocuSign.
          You can connect again at any time.
        </Modal>
      )}
    </PageShell>
  );
}

/* ── 1. Connect DocuSign ── */

function ConnectSection({ isDark, data, keyReady, connected, editing, onEdit }: { isDark: boolean; data: ConnectionStatusResponse; keyReady: boolean; connected: boolean; editing: boolean; onEdit: (v: boolean) => void }) {
  const t = tokens(isDark);
  const [environment, setEnvironment] = useState<DocuSignEnvironment>(data.connection?.environment ?? "demo");
  const [integrationKey, setIntegrationKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [showHowTo, setShowHowTo] = useState(!connected);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);

  const keyOk = GUID.test(integrationKey.trim());
  const secretOk = GUID.test(secretKey.trim());
  const acctOk = !accountId.trim() || GUID.test(accountId.trim());
  const ready = keyReady && keyOk && secretOk && acctOk && !connecting;
  const blockedReason = !keyReady ? null : !integrationKey.trim() || !secretKey.trim() ? "Enter the Integration Key and Secret Key." : !keyOk || !secretOk || !acctOk ? "Check the highlighted values." : null;

  async function connect() {
    setConnecting(true); setError(null);
    try {
      const r = await quoteApiPost<{ authorizeUrl: string }>("Start DocuSign connection", "/api/contracts/docusign/connect", { environment, integrationKey: integrationKey.trim(), secretKey: secretKey.trim(), accountId: accountId.trim() || undefined });
      setSecretKey("");
      window.location.assign(r.authorizeUrl);
    } catch (e) { setError(toErrorPanelData(e, "Couldn't start the DocuSign connection")); setConnecting(false); }
  }

  if (connected && !editing) {
    return (
      <Section title="1. Connect DocuSign" icon="link" isDark={isDark} right={<span style={{ fontSize: 11.5, fontWeight: 700, color: "#22C55E" }}>Done</span>}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12.5, color: t.body }}>Your Integration Key (<strong>{data.connection?.integrationKeyHint}</strong>) and Secret Key are saved securely on the server and are not shown again.</div>
          <GhostButton isDark={isDark} label="Change credentials" icon="edit" onClick={() => onEdit(true)} />
        </div>
      </Section>
    );
  }

  const envButton = (env: DocuSignEnvironment, title: string, text: string) => {
    const active = environment === env;
    return (
      <button type="button" onClick={() => setEnvironment(env)} style={{ flex: "1 1 240px", textAlign: "left", padding: 12, borderRadius: 12, cursor: "pointer", border: `1.5px solid ${active ? t.accent : t.border}`, background: active ? `${t.accent}12` : "transparent", color: t.body }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: active ? t.accent : t.heading, fontSize: 13 }}>{active ? <Ic n="check-circle" s={14} /> : <Ic n="circle-dot" s={14} />} {title}</div>
        <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{text}</div>
      </button>
    );
  };
  const borderFor = (value: string, ok: boolean) => (value && !ok ? t.error : undefined);

  return (
    <Section title="1. Connect DocuSign" icon="link" isDark={isDark}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: t.dim, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 6 }}>Environment</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {envButton("demo", "Demo / Sandbox", "For testing with a free DocuSign developer account. Signatures are not legally binding.")}
            {envButton("production", "Production", "For real customers and legally executed signatures. Needs an Integration Key approved through DocuSign Go-Live.")}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <Field label="Integration Key (Client ID)" isDark={isDark} hint="Looks like 1a2b3c4d-1234-5678-9abc-1234567890ab" help={null}>
            <input value={integrationKey} onChange={e => setIntegrationKey(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={{ ...inputStyle(t), borderColor: borderFor(integrationKey, keyOk) }} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Secret Key (Client Secret)" isDark={isDark} hint="Sent once to the server, stored encrypted, never shown again." help={null}>
            <input type="password" value={secretKey} onChange={e => setSecretKey(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={{ ...inputStyle(t), borderColor: borderFor(secretKey, secretOk) }} autoComplete="new-password" spellCheck={false} />
          </Field>
          <Field label="API Account ID (optional)" isDark={isDark} hint="Leave blank to use your default DocuSign account." help={null}>
            <input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="Leave blank for your default account" style={{ ...inputStyle(t), borderColor: borderFor(accountId, acctOk) }} autoComplete="off" spellCheck={false} />
          </Field>
        </div>

        <CopyField isDark={isDark} label="Redirect URI — add this to your Integration Key in DocuSign" value={data.redirectUri} hint="Generated from this app's address. It must be added to the Integration Key exactly as shown." />

        <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: "10px 12px" }}>
          <button type="button" onClick={() => setShowHowTo(v => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", color: t.heading, fontSize: 13, fontWeight: 700 }}>
            <Ic n={showHowTo ? "chevron-down" : "chevron-right"} s={13} /> Where do I find these values?
          </button>
          {showHowTo && (
            <ol style={{ margin: "8px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: t.body, lineHeight: 1.6 }}>
              {environment === "demo" && <li>No DocuSign developer account yet? <ExternalLink isDark={isDark} href={LINKS.developerAccount}>Create a free one</ExternalLink>.</li>}
              <li>Open <ExternalLink isDark={isDark} href={LINKS.appsAndKeys[environment]}>DocuSign Apps and Keys ({ENVIRONMENT_LABEL[environment]})</ExternalLink> and sign in.</li>
              <li>Click <strong>Add App and Integration Key</strong> and give it a name (for example &quot;OmniCloud&quot;). Copy the <strong>Integration Key</strong> into the field above.</li>
              <li>Under <strong>Authentication</strong>, choose <strong>Authorization Code Grant</strong>, click <strong>Add Secret Key</strong>, and copy it right away — DocuSign shows it only once.</li>
              <li>Under <strong>Redirect URIs</strong>, click <strong>Add URI</strong>, paste the Redirect URI shown above, and <strong>Save</strong>.</li>
              <li>Optional: the <strong>API Account ID</strong> on the same page is only needed if your DocuSign user belongs to several accounts. You never need to copy the &quot;Account Base URI&quot; — OmniCloud gets it from DocuSign.</li>
            </ol>
          )}
        </div>

        {error && <ErrorPanel isDark={isDark} error={error} />}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <PrimaryButton isDark={isDark} label={connecting ? "Opening DocuSign…" : "Connect to DocuSign"} icon="external-link" disabled={!ready} onClick={connect} />
          {editing && <GhostButton isDark={isDark} label="Cancel" onClick={() => onEdit(false)} />}
          {blockedReason && <span style={{ fontSize: 11.5, color: t.dim }}>{blockedReason}</span>}
        </div>
        {!keyReady && <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.warn }}><Ic n="info" s={13} /> {serverSecurityMessage(data.serverSetup.reason)}</div>}
        <div style={{ fontSize: 11.5, color: t.dim }}>DocuSign will ask you to sign in and click <strong>Allow</strong>, then bring you back here and check the connection automatically.</div>
      </div>
    </Section>
  );
}

/* ── 2. Connection Status ── */

function StatusSection({ isDark, status, conn, keyReady, message, checks, verifying, verifyError, busy, onTest, onReconnect, onDisconnect }: {
  isDark: boolean; status: ConnectionStatusResponse["status"]; conn: PublicConnection | null; keyReady: boolean; message: string | null; checks: VerificationCheck[] | null;
  verifying: boolean; verifyError: ErrorPanelDataLike | null; busy: string | null; onTest: () => void; onReconnect: () => void; onDisconnect: () => void;
}) {
  const t = tokens(isDark);
  const allOk = !!checks?.length && checks.every(c => c.ok);
  const hasConnection = !!conn && keyReady;
  const row = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "5px 0", borderBottom: `1px dashed ${t.border}` }}>
      <span style={{ width: 170, color: t.dim, flexShrink: 0 }}>{label}</span><span style={{ color: t.heading, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
  const disabledHint = !conn || !keyReady ? "Available after you connect DocuSign." : null;
  return (
    <Section title="2. Connection Status" icon="activity" isDark={isDark} right={status !== "setup_required" ? <ConnectionBadge isDark={isDark} status={status} /> : undefined}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {allOk && conn && <Note isDark={isDark} tone="ok"><strong>DocuSign connected successfully.</strong> {conn.accountName ?? "Your account"} · {ENVIRONMENT_LABEL[conn.environment]}</Note>}
        {status === "expired" && <Note isDark={isDark} tone="warn">The DocuSign connection has expired (DocuSign sign-ins end after 30 days without use). Click <strong>Reconnect</strong> and sign in to DocuSign again.</Note>}
        {(status === "reauthorization_required" || (status === "not_connected" && message)) && <Note isDark={isDark} tone="warn">{message}</Note>}
        {!conn && <div style={{ fontSize: 12.5, color: t.body }}>Not connected yet. Fill in <strong>1. Connect DocuSign</strong> and click <strong>Connect to DocuSign</strong>.</div>}
        {conn && (
          <div>
            {row("Connection status", <ConnectionBadge isDark={isDark} status={status} />)}
            {row("DocuSign account", conn.accountName ?? "—")}
            {row("DocuSign account ID", conn.accountId)}
            {row("Environment", `${ENVIRONMENT_LABEL[conn.environment]}${conn.environment === "demo" ? " — for testing; not legally binding" : " — real, legally binding signatures"}`)}
            {row("Signed in as", `${conn.userName ?? "—"}${conn.userEmail ? ` · ${conn.userEmail}` : ""}`)}
            {row("API address", conn.baseUri)}
            {row("Connected", fmtDateTime(conn.connectedAt))}
            {row("Last verified", fmtDateTime(conn.lastVerifiedAt))}
          </div>
        )}
        {verifying && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} size={13} /> Checking the connection with DocuSign…</div>}
        {checks && !verifying && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {checks.map(c => (
              <div key={c.id} style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "flex-start" }}>
                <span style={{ color: c.ok ? "#22C55E" : t.error, marginTop: 1 }}><Ic n={c.ok ? "check-circle" : "alert"} s={14} /></span>
                <span style={{ color: t.heading, width: 170, flexShrink: 0, fontWeight: 600 }}>{c.label}</span>
                <span style={{ color: t.body }}>{c.detail}</span>
              </div>
            ))}
          </div>
        )}
        {verifyError && !verifying && <ErrorPanel isDark={isDark} error={verifyError} />}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <PrimaryButton isDark={isDark} label={verifying ? "Testing…" : "Test Connection"} icon="activity" disabled={!hasConnection || verifying || !!busy} onClick={onTest} />
          <GhostButton isDark={isDark} label={busy === "reconnect" ? "Opening DocuSign…" : "Reconnect"} icon="refresh" disabled={!hasConnection || !!busy} onClick={onReconnect} />
          <GhostButton isDark={isDark} label={busy === "disconnect" ? "Disconnecting…" : "Disconnect"} icon="x" danger disabled={!hasConnection || !!busy} onClick={onDisconnect} />
          {disabledHint && <span style={{ fontSize: 11.5, color: t.dim }}>{disabledHint}</span>}
        </div>
      </div>
    </Section>
  );
}

/* ── 3. Help & Troubleshooting ── */

function ExternalLink({ isDark, href, children }: { isDark: boolean; href: string; children: ReactNode }) {
  const t = tokens(isDark);
  return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: t.accent, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>{children} <Ic n="external-link" s={12} /></a>;
}

function HelpGuide({ isDark, redirectUri }: { isDark: boolean; redirectUri: string | null }) {
  const t = tokens(isDark);
  const h = (text: string) => <div style={{ fontSize: 13, fontWeight: 700, color: t.heading, marginTop: 12 }}>{text}</div>;
  const p = (children: ReactNode) => <div style={{ fontSize: 12.5, color: t.body, lineHeight: 1.6, marginTop: 4 }}>{children}</div>;
  return (
    <Section title="3. Help and Troubleshooting" icon="book-open" isDark={isDark} defaultOpen={false}>
      {h("What is DocuSign?")}
      {p("DocuSign lets people sign documents online. OmniCloud sends your contract documents through YOUR DocuSign account, emails each recipient a secure link, and shows you who has signed.")}
      {h("What are the Integration Key and Secret Key?")}
      {p("DocuSign gives each app that connects to an account an Integration Key (its ID) and a Secret Key (its password). Together they let DocuSign know the request really comes from OmniCloud. Never share them in email or chat.")}
      {h("How do I create them?")}
      {p(<>Open DocuSign <strong>Apps and Keys</strong> (<ExternalLink isDark={isDark} href={LINKS.appsAndKeys.demo}>Demo</ExternalLink> · <ExternalLink isDark={isDark} href={LINKS.appsAndKeys.production}>Production</ExternalLink>), click <strong>Add App and Integration Key</strong>, choose <strong>Authorization Code Grant</strong>, add a <strong>Secret Key</strong>, and add the Redirect URI. DocuSign&apos;s guide: <ExternalLink isDark={isDark} href={LINKS.configureApp}>Configure your app</ExternalLink>.</>)}
      {h("What is the Redirect URI?")}
      {p(<>The address DocuSign sends you back to after you sign in. For this server it is <code>{redirectUri ?? "shown in Connect DocuSign"}</code>. Add it to the Integration Key exactly as shown.</>)}
      {h("Why does DocuSign ask me to Allow access?")}
      {p("This is consent: DocuSign never lets an app use your account without your permission. Click Allow once; OmniCloud keeps the connection alive while you use it.")}
      {h("How do I switch from Demo to Production?")}
      {p(<>Production needs an Integration Key that passed DocuSign&apos;s <ExternalLink isDark={isDark} href={LINKS.goLive}>Go-Live review</ExternalLink>. Click <strong>Change credentials</strong>, choose Production, and enter the production Integration Key and Secret Key. Demo and Production keys are different.</>)}
      {h("Troubleshooting")}
      <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: 12.5, color: t.body, lineHeight: 1.7 }}>
        <li><strong>&quot;DocuSign connection is temporarily unavailable&quot;:</strong> the OmniCloud server isn’t ready to store DocuSign credentials securely yet. Please contact your OmniCloud administrator — there is nothing to set up on your computer.</li>
        <li><strong>Redirect URI / invalid_request:</strong> the Redirect URI on the Integration Key does not exactly match the one on this page.</li>
        <li><strong>invalid_client:</strong> the Integration Key or Secret Key is wrong, or belongs to the other environment (Demo vs Production).</li>
        <li><strong>unauthorized_client:</strong> Authorization Code Grant is not enabled on the Integration Key.</li>
        <li><strong>Consent required / access denied:</strong> click Connect again and choose Allow on the DocuSign page.</li>
        <li><strong>Connection expired:</strong> DocuSign sign-ins end after 30 days without use. Click Reconnect.</li>
        <li><strong>Reauthorization required:</strong> you signed in to Salesforce again (or as someone else). Click Reconnect.</li>
        <li><strong>Saved connection can no longer be read:</strong> the server&apos;s encryption key changed. Connect again.</li>
        <li><strong>Account not found:</strong> the API Account ID does not belong to the DocuSign user who signed in. Leave it blank.</li>
      </ul>
      {p(<>More from DocuSign: <ExternalLink isDark={isDark} href={LINKS.authCodeGrant}>How Authorization Code Grant works</ExternalLink>.</>)}
    </Section>
  );
}
