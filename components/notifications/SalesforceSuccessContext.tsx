"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import type { CreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import SalesforceSuccessCard from "./SalesforceSuccessCard";

export interface FailedSalesforceRecord {
  recordName: string;
  error: string;
}

export interface SalesforceSuccessInput {
  /** e.g. "Product Created Successfully" / "10 Products Created Successfully" */
  title: string;
  /** e.g. "Laptop Pro 15 has been successfully created in Salesforce." */
  message: string;
  /** Every record actually confirmed created by Salesforce — never a record whose create call hasn't returned success yet. */
  records: CreatedSalesforceRecord[];
  /** Only for bulk operations that partially failed — shown as "Failed" rows, never mixed into `records`. */
  failedRecords?: FailedSalesforceRecord[];
  /** Label for the expand button when there's more than one record — defaults to "View Details". */
  detailsLabel?: string;
}

interface QueuedNotification extends SalesforceSuccessInput {
  id: string;
}

interface Ctx {
  notify: (input: SalesforceSuccessInput) => void;
}

const SalesforceSuccessCtx = createContext<Ctx | null>(null);

/**
 * Global "Salesforce creation succeeded" notification — the single
 * mechanism every creation flow in the app (Product, Attribute, Bundle,
 * Pricing Procedure, Quote, Contract, Order, Account, and every bulk
 * importer) calls into via `useSalesforceSuccess()` instead of building its
 * own popup. Only ever call `notify()` after a real Salesforce success
 * response with a real record Id — this component has no way to verify
 * that itself, so the caller is the enforcement point for "never fake
 * success."
 */
export function useSalesforceSuccess(): Ctx["notify"] {
  const ctx = useContext(SalesforceSuccessCtx);
  if (!ctx) throw new Error("useSalesforceSuccess must be used within a SalesforceSuccessProvider");
  return ctx.notify;
}

/**
 * Mounted once at the app root (app/layout.tsx, inside ThemeProvider) so
 * every page/module shares one notification stack without threading
 * `isDark` down through props — resolved here directly via next-themes,
 * defaulting to this app's own dark-by-default theme before hydration.
 */
export function SalesforceSuccessProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [queue, setQueue] = useState<QueuedNotification[]>([]);

  const notify = useCallback((input: SalesforceSuccessInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setQueue(q => [...q, { ...input, id }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setQueue(q => q.filter(item => item.id !== id));
  }, []);

  return (
    <SalesforceSuccessCtx.Provider value={{ notify }}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3" style={{ maxWidth: 380 }}>
        {queue.map(item => (
          <SalesforceSuccessCard key={item.id} isDark={isDark} notification={item} onClose={() => dismiss(item.id)} />
        ))}
      </div>
    </SalesforceSuccessCtx.Provider>
  );
}
