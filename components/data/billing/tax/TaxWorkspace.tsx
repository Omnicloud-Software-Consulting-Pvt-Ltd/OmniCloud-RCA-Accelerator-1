"use client";

import { ErrorPanel, Tabs } from "@/components/data/quotes/shared";
import { LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import type { TaxDashboard as Dashboard } from "@/lib/tax/types";
import type { TaxAdminStatus } from "@/lib/tax/server/admin";
import TaxDashboard from "@/components/data/billing/tax/TaxDashboard";
import TaxCreate from "@/components/data/billing/tax/TaxCreate";
import TaxReadiness from "@/components/data/billing/tax/TaxReadiness";
import { VerificationHome, VerificationRun } from "@/components/data/billing/tax/TaxVerification";
import { useConnectionKey, withConnection } from "@/components/data/billing/tax/taxUi";

/**
 * TAX MANAGEMENT — Revenue Cloud Billing tax, end to end, against the connected org only:
 *   Dashboard     · live engines, policies, treatments, items, rates, taxable products, configuration vs calculation status
 *   Create        · AI Prompt or Manual Configuration → metadata-validated preview → dependency-ordered creation → verification
 *   Verification  · a real order → invoice → InvoiceLineTax run that proves Salesforce calculates the tax
 *   Readiness     · read-only Salesforce tax engine diagnostics (StandardTax decision table, permissions)
 */
export type TaxTab = "dashboard" | "create" | "verification" | "readiness";
export type TaxView = { mode: "dashboard"; tab?: TaxTab } | { mode: "run"; orderId: string };

const TABS: { id: TaxTab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "grid" }, { id: "create", label: "Create Tax", icon: "plus-circle" },
  { id: "verification", label: "Verification", icon: "check-circle" }, { id: "readiness", label: "Engine Readiness", icon: "activity" },
];

export default function TaxWorkspace({ isDark, view, onNavigate, onOpenInvoice }: { isDark: boolean; view: TaxView; onNavigate: (view: TaxView) => void; onOpenInvoice: (invoiceId: string) => void }) {
  const conn = useConnectionKey();
  const ready = conn !== "server";
  const dash = useBillingData<Dashboard>("Load tax configuration", ready ? withConnection("/api/billing/tax", conn) : null);
  const admin = useBillingData<{ taxAdmin: TaxAdminStatus }>("Read the Tax Admin permission", ready ? withConnection("/api/billing/tax/permissions/tax-admin", conn) : null);
  const nav = { onOpenRun: (orderId: string) => onNavigate({ mode: "run", orderId }), onOpenInvoice, onBack: () => onNavigate({ mode: "dashboard", tab: "verification" }) };
  if (view.mode === "run") return <VerificationRun key={conn} isDark={isDark} orderId={view.orderId} conn={conn} nav={nav} />;
  const tab = view.tab ?? "dashboard";
  const needsDash = tab === "dashboard" || tab === "verification";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Tabs isDark={isDark} tabs={TABS} active={tab} onChange={id => onNavigate({ mode: "dashboard", tab: id as TaxTab })} />
      {tab === "create" ? <TaxCreate isDark={isDark} conn={conn} onDone={dash.reload} nav={{ onOpenRun: nav.onOpenRun, calculationBlocked: dash.data && dash.data.status.calculation !== "READY" ? dash.data.status.calculationDetail : null }} />
        : tab === "readiness" ? <TaxReadiness key={conn} isDark={isDark} conn={conn} />
          : needsDash && !dash.data ? (dash.error ? <ErrorPanel isDark={isDark} error={dash.error} /> : <LoadingRow isDark={isDark} label="Reading tax configuration from Salesforce…" />)
            : tab === "verification" ? <VerificationHome key={conn} isDark={isDark} conn={conn} dashboard={dash.data!} nav={nav} />
              : <TaxDashboard isDark={isDark} data={dash.data!} taxAdmin={admin.data?.taxAdmin ?? null} reload={() => { dash.reload(); admin.reload(); }} />}
    </div>
  );
}
