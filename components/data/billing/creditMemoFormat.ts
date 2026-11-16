/** Currency display for the Credit Memo workspace: null/undefined/non-finite → "—" (unavailable); a genuine 0 stays "0.00". */
export const money = (n: number | null | undefined, currency?: string | null) =>
  (typeof n !== "number" || !Number.isFinite(n) ? "—" : `${currency ? `${currency} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
