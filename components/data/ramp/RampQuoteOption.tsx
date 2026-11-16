"use client";

import { tokens } from "@/components/data/quotes/shared";
import type { QuoteSearchRow } from "@/lib/ramp/server/reads";

/** "Quote Name · #00000071" — what the picker shows once a quote is selected. */
export function quoteLabel(r: Pick<QuoteSearchRow, "name" | "quoteNumber">): string {
  return r.quoteNumber ? `${r.name} · #${r.quoteNumber}` : r.name;
}

/** One quote option: name + number, then status / account / expiry / total. */
export function QuoteOption({ isDark, r, showAccount }: { isDark: boolean; r: QuoteSearchRow; showAccount?: boolean }) {
  const t = tokens(isDark);
  const meta = [r.status, showAccount ? r.accountName : null, r.expirationDate ? `expires ${r.expirationDate}` : null, r.grandTotal !== null ? r.grandTotal.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null].filter(Boolean).join(" · ");
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span><b style={{ color: t.heading }}>{r.name}</b>{r.quoteNumber && <span style={{ color: t.dim, fontSize: 11.5 }}> · #{r.quoteNumber}</span>}</span>
      {meta && <span style={{ color: t.dim, fontSize: 11 }}>{meta}</span>}
    </span>
  );
}
