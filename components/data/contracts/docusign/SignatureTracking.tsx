"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorPanel, Field, GhostButton, Ic, PrimaryButton, Section, Spinner, inputStyle, tokens } from "@/components/data/quotes/shared";
import { Modal } from "@/components/data/billing/billingUi";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { RECIPIENT_TYPE_LABEL, type EnvelopeAuditEvent, type EnvelopeView, type RecipientStatusView, type StoredSignedFile } from "@/lib/contracts/docusign/types";
import type { GeneratedDocument } from "@/lib/contracts/types";
import { ConnectGate, EnvelopeStatusPill, Note, fmtDateTime, useDocuSignStatus } from "@/components/data/contracts/docusign/shared";

/**
 * Signature Tracking and Completed Documents. Everything is read live from DocuSign (the system of record for envelopes); actions
 * are offered only in states where DocuSign allows them, and the server re-checks before acting.
 */

function useContractEnvelopes(contractId: string, enabled: boolean) {
  const [envelopes, setEnvelopes] = useState<EnvelopeView[] | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    quoteApiGet<{ envelopes: EnvelopeView[] }>("Load signature requests", `/api/contracts/${contractId}/signature/envelopes`)
      .then(r => { if (live) { setEnvelopes(r.envelopes); setError(null); } })
      .catch(e => { if (live) setError(toErrorPanelData(e, "Couldn't load signature requests from DocuSign")); });
    return () => { live = false; };
  }, [contractId, enabled, nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { envelopes, error, reload };
}

const base = (contractId: string, envelopeId: string) => `/api/contracts/${contractId}/signature/envelopes/${envelopeId}`;

export default function SignatureTracking({ isDark, contractId, focusEnvelopeId, onOpenSettings, onSendNew }: {
  isDark: boolean; contractId: string; focusEnvelopeId?: string | null; onOpenSettings?: () => void; onSendNew?: () => void;
}) {
  const t = tokens(isDark);
  const { data: status } = useDocuSignStatus();
  const connected = status?.status === "connected";
  const { envelopes, error, reload } = useContractEnvelopes(contractId, connected);
  const [openId, setOpenId] = useState<string | null>(focusEnvelopeId ?? null);

  if (!connected) return <ConnectGate isDark={isDark} status={status} onOpenSettings={onOpenSettings} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 12.5, color: t.body }}>Every signature request sent for this contract, straight from DocuSign. Click one to see who has signed.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <GhostButton isDark={isDark} label="Refresh" icon="refresh" onClick={reload} />
          {onSendNew && <PrimaryButton isDark={isDark} label="Send for signature" icon="send" onClick={onSendNew} />}
        </div>
      </div>
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {!envelopes && !error && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} size={13} /> Loading from DocuSign…</div>}
      {envelopes && envelopes.length === 0 && <EmptyState isDark={isDark} icon="send" title="Nothing sent for signature yet" hint="Use Send for Signature to email this contract's documents to the people who need to sign." />}
      {envelopes?.map(e => (
        <EnvelopeCard key={e.envelopeId} isDark={isDark} contractId={contractId} envelope={e} open={openId === e.envelopeId} onToggle={() => setOpenId(id => (id === e.envelopeId ? null : e.envelopeId))} onChanged={reload} />
      ))}
    </div>
  );
}

function ProgressBar({ isDark, done, total }: { isDark: boolean; done: number; total: number }) {
  const t = tokens(isDark);
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: t.border, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#22C55E" : t.accent }} /></div>
      <span style={{ fontSize: 11.5, color: t.dim, whiteSpace: "nowrap" }}>{done} of {total} signed</span>
    </div>
  );
}

function EnvelopeCard({ isDark, contractId, envelope: e, open, onToggle, onChanged }: { isDark: boolean; contractId: string; envelope: EnvelopeView; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const t = tokens(isDark);
  return (
    <div style={{ border: `1px solid ${open ? t.borderBright : t.border}`, borderRadius: 14, background: t.surface, overflow: "hidden" }}>
      <button type="button" onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", flexWrap: "wrap" }}>
        <span style={{ color: t.dim }}><Ic n={open ? "chevron-down" : "chevron-right"} s={14} /></span>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{e.emailSubject ?? "Signature request"}</div>
          <div style={{ fontSize: 11.5, color: t.dim }}>{e.recipients.map(r => r.name).join(", ") || "No recipients"} · sent {fmtDateTime(e.sentDateTime)} · updated {fmtDateTime(e.lastModifiedDateTime)}</div>
        </div>
        <ProgressBar isDark={isDark} done={e.signedCount} total={e.signerCount} />
        <EnvelopeStatusPill isDark={isDark} envelope={e} />
      </button>
      {open && <EnvelopeDetails isDark={isDark} contractId={contractId} envelope={e} onChanged={onChanged} />}
    </div>
  );
}

function EnvelopeDetails({ isDark, contractId, envelope: e, onChanged }: { isDark: boolean; contractId: string; envelope: EnvelopeView; onChanged: () => void }) {
  const t = tokens(isDark);
  const [history, setHistory] = useState<EnvelopeAuditEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"resend" | "void" | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [correcting, setCorrecting] = useState<RecipientStatusView | null>(null);

  useEffect(() => {
    let live = true;
    quoteApiGet<{ history: EnvelopeAuditEvent[] | null }>("Load envelope history", base(contractId, e.envelopeId))
      .then(r => { if (live) setHistory(r.history ?? []); })
      .catch(() => { if (live) setHistory([]); });
    return () => { live = false; };
  }, [contractId, e.envelopeId]);

  async function act(action: "resend" | "void" | "correct", body: Record<string, unknown>) {
    setBusy(action); setError(null); setNotice(null); setConfirm(null); setCorrecting(null);
    try {
      const r = await quoteApiPost<{ message: string }>(`${action} envelope`, `${base(contractId, e.envelopeId)}/${action}`, { confirmed: true, ...body });
      setNotice(r.message); onChanged();
    } catch (err) { setError(toErrorPanelData(err, "DocuSign didn't accept the change")); }
    finally { setBusy(null); }
  }

  const can = (a: EnvelopeView["allowedActions"][number]) => e.allowedActions.includes(a);
  return (
    <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 11.5, color: t.dim }}>Envelope ID <code style={{ color: t.body }}>{e.envelopeId}</code>{e.voidedReason ? ` · reason: ${e.voidedReason}` : ""}{e.completedDateTime ? ` · completed ${fmtDateTime(e.completedDateTime)}` : ""}</div>
      {notice && <Note isDark={isDark} tone="ok">{notice}</Note>}
      {error && <ErrorPanel isDark={isDark} error={error} />}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr style={{ color: t.dim, textAlign: "left" }}>{["Order", "Recipient", "Role", "Status", "Signed / viewed", ""].map(h => <th key={h} style={{ padding: "6px 8px", borderBottom: `1px solid ${t.border}`, fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {e.recipients.map(r => (
              <tr key={r.recipientId} style={{ color: t.body }}>
                <td style={{ padding: "6px 8px" }}>{r.routingOrder}</td>
                <td style={{ padding: "6px 8px" }}><div style={{ color: t.heading, fontWeight: 600 }}>{r.name}</div><div style={{ fontSize: 11.5, color: t.dim }}>{r.email}</div></td>
                <td style={{ padding: "6px 8px" }}>{RECIPIENT_TYPE_LABEL[r.type]}</td>
                <td style={{ padding: "6px 8px" }}>{r.statusLabel}{r.declinedReason ? ` — "${r.declinedReason}"` : ""}</td>
                <td style={{ padding: "6px 8px" }}>{fmtDateTime(r.signedDateTime ?? r.deliveredDateTime)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{r.canCorrect && <button type="button" onClick={() => setCorrecting(r)} style={{ fontSize: 11.5, background: "none", border: "none", color: t.accent, cursor: "pointer" }}>Correct</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12, color: t.body }}><strong>Documents:</strong> {e.documents.map(d => d.name).join(", ") || "—"}</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {can("resend") && <GhostButton isDark={isDark} label={busy === "resend" ? "Resending…" : "Resend email"} icon="send" disabled={!!busy} onClick={() => setConfirm("resend")} />}
        {can("void") && <GhostButton isDark={isDark} label={busy === "void" ? "Voiding…" : "Void envelope"} icon="x" danger disabled={!!busy} onClick={() => setConfirm("void")} />}
        {can("download-signed") && <a href={`${base(contractId, e.envelopeId)}/signed`} style={linkBtn(isDark)}><Ic n="download" s={13} /> Signed document</a>}
        {can("download-certificate") && <a href={`${base(contractId, e.envelopeId)}/certificate`} style={linkBtn(isDark)}><Ic n="download" s={13} /> Certificate of completion</a>}
        {!e.allowedActions.length && <span style={{ fontSize: 11.5, color: t.dim }}>No actions are available while the envelope is &quot;{e.statusLabel}&quot;.</span>}
      </div>

      <Section title="History (from DocuSign)" icon="clock" isDark={isDark} defaultOpen={false}>
        {!history ? <div style={{ fontSize: 12, color: t.dim }}>Loading…</div> : history.length === 0 ? <div style={{ fontSize: 12, color: t.dim }}>No history available.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {history.map((h, i) => <div key={i} style={{ fontSize: 12, color: t.body }}><span style={{ color: t.dim }}>{fmtDateTime(h.at)}</span> · <strong>{h.action}</strong>{h.user ? ` · ${h.user}` : ""}{h.detail ? ` — ${h.detail}` : ""}</div>)}
          </div>
        )}
      </Section>

      {confirm === "resend" && (
        <Modal isDark={isDark} title="Resend the signing email?" tone="accent" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirm(null)} /><PrimaryButton isDark={isDark} label="Resend" icon="send" onClick={() => act("resend", {})} /></>}>
          DocuSign will email everyone who still needs to act a fresh link.
        </Modal>
      )}
      {confirm === "void" && (
        <Modal isDark={isDark} title="Void this envelope?" tone="warn" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={() => setConfirm(null)} /><PrimaryButton isDark={isDark} label="Void envelope" icon="x" disabled={!voidReason.trim()} onClick={() => act("void", { reason: voidReason })} /></>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>Nobody will be able to sign it anymore. This cannot be undone — you would send a new envelope instead.</div>
            <Field label="Reason (recipients see this)" isDark={isDark} help={null}><input value={voidReason} maxLength={200} onChange={ev => setVoidReason(ev.target.value)} style={inputStyle(t)} placeholder="Terms changed — a new version will follow" /></Field>
          </div>
        </Modal>
      )}
      {correcting && <CorrectRecipient isDark={isDark} recipient={correcting} onCancel={() => setCorrecting(null)} onSave={(name, email) => act("correct", { recipientId: correcting.recipientId, name, email })} />}
    </div>
  );
}

function CorrectRecipient({ isDark, recipient, onCancel, onSave }: { isDark: boolean; recipient: RecipientStatusView; onCancel: () => void; onSave: (name: string, email: string) => void }) {
  const t = tokens(isDark);
  const [name, setName] = useState(recipient.name);
  const [email, setEmail] = useState(recipient.email);
  return (
    <Modal isDark={isDark} title={`Correct ${recipient.name}`} tone="accent" actions={<><GhostButton isDark={isDark} label="Cancel" onClick={onCancel} /><PrimaryButton isDark={isDark} label="Save and resend" icon="check" disabled={!name.trim() || !email.trim()} onClick={() => onSave(name, email)} /></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>Fix a typo in the name or email. DocuSign sends the signing email to the corrected address.</div>
        <Field label="Full name" isDark={isDark} help={null}><input value={name} onChange={e => setName(e.target.value)} style={inputStyle(t)} /></Field>
        <Field label="Email" isDark={isDark} help={null}><input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle(t)} /></Field>
      </div>
    </Modal>
  );
}

function linkBtn(isDark: boolean) {
  const t = tokens(isDark);
  return { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: `1px solid ${t.border}`, fontSize: 12.5, fontWeight: 600, color: t.body, textDecoration: "none" } as const;
}

/* ── Completed Documents ── */

export function CompletedDocuments({ isDark, contractId, onOpenSettings }: { isDark: boolean; contractId: string; onOpenSettings?: () => void }) {
  const t = tokens(isDark);
  const { data: status } = useDocuSignStatus();
  const connected = status?.status === "connected";
  const { envelopes, error, reload } = useContractEnvelopes(contractId, connected);
  const [files, setFiles] = useState<GeneratedDocument[] | null>(null);
  const [filesNonce, setFilesNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorPanelDataLike | null>(null);

  // Signed copies already saved to the Contract in Salesforce (readable even without DocuSign).
  useEffect(() => {
    let live = true;
    quoteApiGet<{ documents: GeneratedDocument[] }>("Load contract documents", `/api/contracts/${contractId}/documents`)
      .then(r => { if (live) setFiles(r.documents.filter(d => d.signature && d.isLatest)); })
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [contractId, filesNonce]);

  async function store(envelopeId: string) {
    setBusy(envelopeId); setNotice(null); setActionError(null);
    try {
      const r = await quoteApiPost<{ message: string; files: StoredSignedFile[] }>("Save signed copies to Salesforce", `${base(contractId, envelopeId)}/store`, {});
      setNotice(r.message); setFilesNonce(n => n + 1);
    } catch (e) { setActionError(toErrorPanelData(e, "Couldn't save the signed copies")); }
    finally { setBusy(null); }
  }

  const completed = envelopes?.filter(e => e.allowedActions.includes("store")) ?? null;
  const savedFor = (envelopeId: string) => (files ?? []).filter(f => f.signature?.envelopeId === envelopeId.toLowerCase());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12.5, color: t.body }}>When everyone has signed, save the signed copy and DocuSign&apos;s certificate of completion to this contract in Salesforce. The original document is never changed.</div>
      {notice && <Note isDark={isDark} tone="ok">{notice}</Note>}
      {actionError && <ErrorPanel isDark={isDark} error={actionError} />}

      <Section title="Completed in DocuSign" icon="check-circle" isDark={isDark}>
        {!connected ? <ConnectGate isDark={isDark} status={status} onOpenSettings={onOpenSettings} /> : (
          <>
            {error && <ErrorPanel isDark={isDark} error={error} />}
            {!completed && !error && <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim }}><Spinner isDark={isDark} size={13} /> Loading from DocuSign…</div>}
            {completed && completed.length === 0 && <EmptyState isDark={isDark} icon="check-circle" title="No completed signatures yet" hint="Envelopes appear here once every signer has signed." />}
            {completed?.map(e => {
              const saved = savedFor(e.envelopeId);
              return (
                <div key={e.envelopeId} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 0", borderBottom: `1px dashed ${t.border}` }}>
                  <div style={{ flex: "1 1 260px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: t.heading }}>{e.emailSubject ?? "Signature request"}</div>
                    <div style={{ fontSize: 11.5, color: t.dim }}>Completed {fmtDateTime(e.completedDateTime)} · {e.documents.map(d => d.name).join(", ")}{saved.length ? ` · saved to Salesforce (${saved.length} file${saved.length === 1 ? "" : "s"})` : ""}</div>
                  </div>
                  <a href={`${base(contractId, e.envelopeId)}/signed`} style={linkBtn(isDark)}><Ic n="download" s={13} /> Signed</a>
                  <a href={`${base(contractId, e.envelopeId)}/certificate`} style={linkBtn(isDark)}><Ic n="download" s={13} /> Certificate</a>
                  <PrimaryButton isDark={isDark} label={busy === e.envelopeId ? "Saving…" : saved.length ? "Saved — check again" : "Save to Salesforce"} icon="upload" disabled={!!busy} onClick={() => store(e.envelopeId)} />
                </div>
              );
            })}
            <div style={{ marginTop: 8 }}><GhostButton isDark={isDark} label="Refresh" icon="refresh" onClick={() => { reload(); setFilesNonce(n => n + 1); }} /></div>
          </>
        )}
      </Section>

      <Section title="Signed files saved on this contract" icon="file-contract" isDark={isDark}>
        {!files ? <div style={{ fontSize: 12, color: t.dim }}>Loading…</div> : files.length === 0 ? <EmptyState isDark={isDark} icon="file-text" title="No signed files saved yet" hint="Use Save to Salesforce on a completed envelope above." /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {files.map(f => (
              <div key={f.contentVersionId} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                <span style={{ color: "#22C55E" }}><Ic n={f.signature?.kind === "certificate" ? "shield" : "check-circle"} s={14} /></span>
                <span style={{ flex: 1, color: t.heading }}>{f.title} <span style={{ color: t.dim }}>· {f.signature?.kind === "certificate" ? "Certificate of completion" : "Signed copy"} · {fmtDateTime(f.createdDate)}</span></span>
                <a href={`/api/contracts/${contractId}/documents/${f.contentVersionId}/download`} style={{ color: t.accent, fontWeight: 600, textDecoration: "none", display: "inline-flex", gap: 4, alignItems: "center" }}><Ic n="download" s={12} /> Download</a>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
