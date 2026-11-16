// Pure helpers over Salesforce payment applications, shared by the payment service and the UI.
import type { PaymentApplication } from "@/lib/billing/server/payments";

const cents = (n: number) => Math.round(n * 100);

/** Applications that currently count (Applied and not later unapplied). */
export const activeApplications = (apps: PaymentApplication[]) => apps.filter(a => /^applied$/i.test(a.type ?? "") && !/^yes$/i.test(a.hasBeenUnapplied ?? ""));

/** Amount each payment has applied to one invoice — line-level applications when present, else invoice-level (never both). */
export function appliedByPayment(apps: PaymentApplication[]): { paymentId: string; paymentNumber: string | null; amount: number; appliedDate: string | null }[] {
  const by = new Map<string, { paymentNumber: string | null; line: number; inv: number; hasLine: boolean; date: string | null }>();
  for (const a of activeApplications(apps)) {
    if (!a.payment) continue;
    const e = by.get(a.payment.id) ?? { paymentNumber: a.payment.number, line: 0, inv: 0, hasLine: false, date: null };
    if (a.level === "line") { e.line += cents(a.amount ?? 0); e.hasLine = true; } else e.inv += cents(a.amount ?? 0);
    if (a.appliedDate && (!e.date || a.appliedDate > e.date)) e.date = a.appliedDate;
    by.set(a.payment.id, e);
  }
  return [...by.entries()].map(([paymentId, e]) => ({ paymentId, paymentNumber: e.paymentNumber, amount: (e.hasLine ? e.line : e.inv) / 100, appliedDate: e.date }));
}
