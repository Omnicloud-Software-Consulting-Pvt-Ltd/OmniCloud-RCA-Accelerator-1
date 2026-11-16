"use client";

import { Ic } from "@/components/data/dashboardShell";
import { tokens, GhostButton } from "@/components/data/quotes/shared";
import BulkPolicyAssignment from "@/components/data/policy-assignment/BulkPolicyAssignment";
import { BULK_ASSIGNMENT_TITLE } from "@/lib/policyAssignment/navigation";
import { POLICY_KIND_LABELS, type PolicyKind } from "@/lib/policyAssignment/types";

/**
 * Dedicated Bulk Product Assignment page (Billing Policies / Tax Policies). Rendered as a view of the Billing or Taxes workspace,
 * which supplies breadcrumbs, Back and URL restore; the "About this module" intro above it comes from the /data page. The
 * workflow itself is the shared BulkPolicyAssignment component — nothing here re-implements assignment logic.
 */
export default function BulkAssignmentPage({ isDark, kind, onBackToPolicies, onAssigned, onSingleAssign }: {
  isDark: boolean;
  kind: PolicyKind;
  onBackToPolicies: () => void;
  onAssigned?: () => void;
  /** Billing only: the existing single-product assignment flow. */
  onSingleAssign?: () => void;
}) {
  const t = tokens(isDark);
  const L = POLICY_KIND_LABELS[kind];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 18 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${t.accent}1f`, border: `1px solid ${t.accent}40`, color: t.accent }}>
              <Ic n="layers" s={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: t.heading, letterSpacing: "-0.02em" }}>{BULK_ASSIGNMENT_TITLE[kind]}</h1>
              <p style={{ margin: "4px 0 0", fontSize: 12.5, color: t.dim, maxWidth: 760 }}>
                Assign one {L.policy} to many products. Only products without a {L.policy} are listed (their {kind === "billing" ? "Tax" : "Billing"} Policy is ignored),
                existing assignments are never overwritten, and each product&apos;s {kind === "tax" ? "Tax Treatment Item is created or reused" : "shared Billing Treatment Item is verified"} as part of the assignment.
              </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <GhostButton label={`Back to ${L.policies}`} icon="arrow-left" isDark={isDark} onClick={onBackToPolicies} />
            {onSingleAssign && <GhostButton label="Assign to One Product" icon="link" isDark={isDark} onClick={onSingleAssign} />}
          </div>
        </div>
        <BulkPolicyAssignment isDark={isDark} kind={kind} onAssigned={onAssigned} />
      </div>
    </div>
  );
}
