"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { useTheme } from "next-themes";
import { loadSession } from "@/lib/auth/session";
import { loadIdentity, isSetupComplete } from "@/lib/auth/identity";
import CreatePricingRuleFlow from "@/components/data/pricing-rules/CreatePricingRuleFlow";
import { Ic, tokens } from "@/components/data/pricing-rules/shared";
import { PRICING_TYPE_LABELS, type PricingType } from "@/lib/pricing-rules/types";

const VALID_TYPES = new Set(Object.keys(PRICING_TYPE_LABELS));

/**
 * Dedicated route per pricing type (/pricing-rules/create/tier-based,
 * .../volume-based, .../attribute-based, .../bundle-based) so the
 * dashboard's pricing-type cards can link to a real, bookmarkable URL
 * instead of only being reachable through in-app SPA state. Deliberately
 * a light standalone page (not the full app/data/page.tsx sidebar shell)
 * reusing the same auth-gate pattern that page uses, mirroring how
 * app/contracts/sign-complete/page.tsx is its own minimal page rather
 * than embedding into the shared dashboard shell.
 */
export default function CreatePricingRuleTypePage() {
  const params = useParams<{ type: string }>();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [mounted, setMounted] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  const rawType = Array.isArray(params.type) ? params.type[0] : params.type;
  const pricingType = (rawType && VALID_TYPES.has(rawType) ? rawType : null) as PricingType | null;

  useEffect(() => {
    setMounted(true);
    if (!loadIdentity()) { router.replace("/login"); return; }
    if (!isSetupComplete()) { router.replace("/setup"); return; }
    if (!loadSession()) { router.replace("/setup"); return; }
    setAuthorized(true);
  }, [router]);

  const goToDashboard = () => router.push("/data?module=pricing-rules");

  if (!mounted || !authorized) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000508" }}>
        <motion.div
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          style={{ color: "rgba(0,212,255,0.4)", fontSize: 12, fontFamily: "monospace" }}
        >
          LOADING…
        </motion.div>
      </div>
    );
  }

  const t = tokens(isDark);

  if (!pricingType) {
    return (
      <div
        style={{
          minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
          background: isDark ? "linear-gradient(160deg, #000508 0%, #010918 60%, #000305 100%)" : "linear-gradient(160deg, #D2DDEF 0%, #DCE8F6 60%, #CCDAEC 100%)",
        }}
      >
        <div style={{ color: t.heading, fontSize: 15, fontWeight: 700 }}>Unknown pricing type &quot;{rawType}&quot;</div>
        <button
          onClick={goToDashboard}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}
        >
          <Ic n="arrow-left" s={13} /> Back to Pricing Rules
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        height: "100vh",
        background: isDark
          ? "linear-gradient(160deg, #000508 0%, #010918 60%, #000305 100%)"
          : "linear-gradient(160deg, #D2DDEF 0%, #DCE8F6 60%, #CCDAEC 100%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <button
          onClick={goToDashboard}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9, border: `1px solid ${t.border}`, background: "transparent", color: t.body, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
        >
          <Ic n="arrow-left" s={13} /> Pricing Rules
        </button>
        <div style={{ width: 1, height: 18, background: t.border }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: t.heading, fontSize: 14, fontWeight: 700 }}>
          <Ic n="zap" s={15} /> Create {PRICING_TYPE_LABELS[pricingType]} Pricing Rule
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <CreatePricingRuleFlow isDark={isDark} lockedPricingType={pricingType} onBack={goToDashboard} onDone={goToDashboard} />
      </div>
    </div>
  );
}
