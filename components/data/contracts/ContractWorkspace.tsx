"use client";

import { useEffect, useState } from "react";
import { Section, Ic, tokens, PrimaryButton, GhostButton, PageShell, Tabs, Spinner, ErrorPanel, Pill } from "@/components/data/quotes/shared";
import ContractDocuments from "@/components/data/contracts/ContractDocuments";
import ContractPreviewPanel from "@/components/data/contracts/ContractPreviewPanel";
import ContractOverview from "@/components/data/contracts/ContractOverview";
import SendForSignature from "@/components/data/contracts/docusign/SendForSignature";
import SignatureTracking, { CompletedDocuments } from "@/components/data/contracts/docusign/SignatureTracking";
import { quoteApiGet, quoteApiPost, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { updateResponseSummary } from "@/lib/quotes/client/responseSummary";
import type { ContractActivationAction, ContractActivationResult, ContractDetail } from "@/lib/contracts/types";

type Tab = "overview" | "documents" | "send" | "tracking" | "completed" | "diagnostics";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "file-text" },
  { id: "documents", label: "Documents & Templates", icon: "file-contract" },
  { id: "send", label: "Send for Signature", icon: "send" },
  { id: "tracking", label: "Signature Tracking", icon: "activity" },
  { id: "completed", label: "Completed Documents", icon: "check-circle" },
  { id: "diagnostics", label: "Session Diagnostics", icon: "terminal" },
];

export default function ContractWorkspace({
  isDark,
  contractId,
  onBack,
  initialTab,
  onTabChange,
  onOpenDocuSignSettings,
}: {
  isDark: boolean;
  contractId: string;
  onBack: () => void;
  initialTab?: string;
  /** Bubbles tab changes up to ContractsModule (and from there to the page's URL) so a refresh reopens the same tab. */
  onTabChange?: (tab: Tab) => void;
  onOpenDocuSignSettings?: () => void;
}) {
  const t = tokens(isDark);
  const [tab, setTabState] = useState<Tab>(() => (TABS.some(t => t.id === initialTab) ? (initialTab as Tab) : "overview"));
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<ErrorPanelDataLike | null>(null);
  // Set when a send completes, so Signature Tracking opens on the envelope just sent.
  const [focusEnvelopeId, setFocusEnvelopeId] = useState<string | null>(null);

  function setTab(next: Tab) {
    setTabState(next);
    onTabChange?.(next);
  }

  // Reasserts the resolved initial tab once on mount so the URL reflects it
  // even though ContractsModule clears its own ctab param on every view change.
  useEffect(() => {
    onTabChange?.(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await quoteApiGet<{ contract: ContractDetail }>("Load contract", `/api/contracts/${contractId}`);
    setDetail(res.contract);
  }

  useEffect(() => {
    refresh().catch(err => setError(toErrorPanelData(err, "Could not load this contract")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  const mutable = detail?.mutability.status !== "blocked";

  async function handleActivate(action: ContractActivationAction) {
    setActivating(true);
    setError(null);
    try {
      // A rejected activation returns HTTP 422 (see the route), which
      // quoteApiPost throws on — so a resolved `res` here is always success:true.
      // The real Salesforce rejection reason surfaces via the catch below.
      const res = await quoteApiPost<ContractActivationResult>(`${action} Contract`, `/api/contracts/${contractId}/activate`, { action });
      updateResponseSummary({ contractActivation: res });
      await refresh();
    } catch (err) {
      setError(toErrorPanelData(err, "Could not update this contract's activation status"));
    } finally {
      setActivating(false);
    }
  }

  const header = (
    <div style={{ padding: "16px 20px 0", flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: t.heading }}>
          <Ic n="file-contract" s={17} /> {detail?.contractNumber ?? "Loading…"}
          {detail?.status && <Pill label={detail.status} color={mutable ? t.accent : t.warn} isDark={isDark} />}
        </div>
        <GhostButton label="Back to History" icon="arrow-left" isDark={isDark} onClick={onBack} />
      </div>
      <div style={{ borderBottom: `1px solid ${t.border}`, paddingBottom: 10 }}>
        <Tabs isDark={isDark} tabs={TABS} active={tab} onChange={id => setTab(id as Tab)} />
      </div>
    </div>
  );

  if (!detail) {
    return (
      <PageShell header={header}>
        <div style={{ padding: 20 }}>
          {error ? <ErrorPanel isDark={isDark} error={error} /> : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: t.dim }}><Spinner isDark={isDark} /> Loading contract…</div>
          )}
        </div>
      </PageShell>
    );
  }

  // Documents is a full height-bounded app (template picker + live editor +
  // generated-documents table), not another stack of Sections — it needs its
  // own container rather than PageShell's padded, page-scrolls-as-a-whole
  // body every other tab here uses.
  if (tab === "documents") {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {header}
        <div className="flex-1 min-h-0 overflow-hidden">
          <ContractDocuments isDark={isDark} contractId={contractId} />
        </div>
      </div>
    );
  }

  return (
    <PageShell header={header}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 20 }}>
        {error && <ErrorPanel isDark={isDark} error={error} />}

        {tab === "overview" && (
          <>
            <Section title="Activation" icon="zap" isDark={isDark}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div style={{ fontSize: 12.5, color: t.body }}>
                  Status: <strong style={{ color: t.heading }}>{detail.status ?? "—"}</strong>
                  <div style={{ fontSize: 11.5, color: t.dim, marginTop: 3 }}>{detail.mutability.reason}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {mutable ? (
                    <PrimaryButton label={activating ? "Activating…" : "Activate Contract"} icon="check-circle" isDark={isDark} disabled={activating} onClick={() => handleActivate("activate")} />
                  ) : (
                    <>
                      <GhostButton label={activating ? "Working…" : "Back to Draft"} icon="refresh" isDark={isDark} onClick={() => handleActivate("draft")} />
                      <GhostButton label={activating ? "Working…" : "Expire Contract"} icon="x" isDark={isDark} danger onClick={() => handleActivate("expire")} />
                    </>
                  )}
                </div>
              </div>
            </Section>

            <ContractOverview isDark={isDark} detail={detail} />
          </>
        )}

        {tab === "send" && (
          <SendForSignature
            isDark={isDark}
            contractId={contractId}
            contractName={typeof detail.record.Name === "string" && detail.record.Name ? detail.record.Name : `Contract ${detail.contractNumber ?? contractId}`}
            contractNumber={detail.contractNumber}
            accountName={detail.references?.AccountId?.name ?? null}
            onOpenSettings={onOpenDocuSignSettings}
            onSent={envelopeId => { setFocusEnvelopeId(envelopeId); setTab("tracking"); }}
          />
        )}

        {tab === "tracking" && (
          <SignatureTracking isDark={isDark} contractId={contractId} focusEnvelopeId={focusEnvelopeId} onOpenSettings={onOpenDocuSignSettings} onSendNew={() => setTab("send")} />
        )}

        {tab === "completed" && <CompletedDocuments isDark={isDark} contractId={contractId} onOpenSettings={onOpenDocuSignSettings} />}

        {tab === "diagnostics" && (
          <Section title="This Session Only" icon="activity" isDark={isDark} defaultOpen>
            <div style={{ fontSize: 11.5, color: t.dim, marginBottom: 8 }}>
              Logs and responses reflect only actions taken in this browser session — not the contract&apos;s full history.
            </div>
            <ContractPreviewPanel isDark={isDark} requestJson={{ contractId }} />
          </Section>
        )}
      </div>
    </PageShell>
  );
}
