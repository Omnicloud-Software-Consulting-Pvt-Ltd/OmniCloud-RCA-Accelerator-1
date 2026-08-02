"use client";

import { Ic, tokens } from "@/components/data/quotes/shared";
import type { SignatureStage } from "@/lib/contracts/types";

// Deliberately only the 3 stages the app can actually back today — Viewed/
// Customer Signed/Company Signed/Completed require a real DocuSign
// connection (webhook-driven progression) and are not implemented yet. The
// underlying SignatureStage type still has all 7 (lib/contracts/types.ts)
// so this only needs its array extended, not a redesign, once that lands.
const STAGES: SignatureStage[] = ["Draft", "Ready to Send", "Sent"];

/** Simple 3-stage signature status stepper — every stage at-or-below the current one renders as "reached". */
export default function SignatureStatusStepper({ isDark, current }: { isDark: boolean; current: SignatureStage }) {
  const t = tokens(isDark);
  const idx = STAGES.indexOf(current);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {STAGES.map((s, i) => (
        <div
          key={s}
          style={{
            flex: "1 1 100px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            padding: "8px 8px", borderRadius: 9, fontSize: 11, fontWeight: 600, textAlign: "center",
            background: i <= idx ? `${t.accent}18` : "transparent", color: i <= idx ? t.accent : t.dim,
            border: `1px solid ${i <= idx ? t.accent + "40" : t.border}`,
          }}
        >
          <Ic n={i < idx ? "check" : i === idx ? "zap" : "clock"} s={12} />
          <span>{s}</span>
        </div>
      ))}
    </div>
  );
}
