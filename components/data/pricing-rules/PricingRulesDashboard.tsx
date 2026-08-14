"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Ic, tokens, PrimaryButton, PageShell } from "./shared";
import PricingRuleHistoryList from "./PricingRuleHistoryList";
import { PRICING_TYPE_LABELS, IMPLEMENTED_PRICING_TYPES, type PricingType } from "@/lib/pricing-rules/types";

type ModuleTarget = { mode: "history" | "create" };

const PRICING_TYPE_ICONS: Record<PricingType, string> = {
  "tier-based": "layers",
  "volume-based": "package",
  "attribute-based": "sliders",
  "bundle-based": "cube",
};

/**
 * "Pricing Rules" tile landing page — mirrors QuotesDashboard/OrdersDashboard's
 * pattern (header + primary action + a real recent-records list), but kept
 * intentionally lighter: only Attribute-Based pricing has a real deploy
 * engine behind it in this build (see the plan's scope note), so this
 * dashboard doesn't pretend to have rich stats for pricing types that
 * aren't deployable yet.
 *
 * Each pricing-type card is a real navigable link to its own route
 * (/pricing-rules/create/<type>) — clicking a card never requires going
 * through the "Create Pricing Rule" button first.
 */
export default function PricingRulesDashboard({ isDark, onNavigate }: { isDark: boolean; onNavigate: (target: ModuleTarget) => void }) {
  const t = tokens(isDark);
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<PricingType | null>(null);

  function goToType(pt: PricingType) {
    setSelectedType(pt);
    router.push(`/pricing-rules/create/${pt}`);
  }

  return (
    <PageShell>
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: t.heading, display: "flex", alignItems: "center", gap: 8 }}>
              <Ic n="zap" s={20} /> Pricing Rules
            </div>
            <div style={{ fontSize: 12.5, color: t.dim, marginTop: 4 }}>Attribute-based, tier-based, volume-based, and bundle-based Pricing Procedures.</div>
          </div>
          <PrimaryButton label="Create Pricing Rule" icon="plus" isDark={isDark} onClick={() => onNavigate({ mode: "create" })} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {(Object.keys(PRICING_TYPE_LABELS) as PricingType[]).map(pt => {
            const implemented = IMPLEMENTED_PRICING_TYPES.includes(pt);
            const active = selectedType === pt;
            return (
              <motion.button
                key={pt}
                type="button"
                onClick={() => goToType(pt)}
                whileHover={{ scale: 1.03, y: -2 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 22 }}
                style={{
                  padding: 14, borderRadius: 12, cursor: "pointer", textAlign: "left",
                  border: `1px solid ${active ? t.accent : t.border}`,
                  boxShadow: active ? `0 0 0 3px ${t.accent}22` : "none",
                  background: t.surface, display: "flex", flexDirection: "column", gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: t.accent }}>
                  <Ic n={PRICING_TYPE_ICONS[pt]} s={15} /><span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{PRICING_TYPE_LABELS[pt]}</span>
                </div>
                <span style={{ fontSize: 10.5, color: implemented ? "#22C55E" : t.warn, fontWeight: 600 }}>{implemented ? "Live" : "Coming Soon"}</span>
              </motion.button>
            );
          })}
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.heading, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic n="list" s={14} /> Recent Pricing Procedures
          </div>
          <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden" }}>
            <PricingRuleHistoryList isDark={isDark} />
          </div>
        </div>
      </div>
    </PageShell>
  );
}
