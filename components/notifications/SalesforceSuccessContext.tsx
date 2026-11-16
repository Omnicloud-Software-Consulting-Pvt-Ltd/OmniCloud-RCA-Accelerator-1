"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import type { CreatedSalesforceRecord } from "@/lib/salesforce/recordUrl";
import { loadSession } from "@/lib/auth/session";
import {
  addEntry, dedupeKey, isDuplicate, objectLabel, parseHistory, sanitizeText, storageKey, unreadCount,
  type NotificationEntry, type NotificationTone,
} from "@/lib/notifications/history";
import { isSalesforceId, resolveDestination, salesforceRecordUrl } from "@/lib/notifications/destinations";
import SalesforceSuccessCard from "./SalesforceSuccessCard";
import { Z } from "@/lib/ui/overlay";

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
  /** Module shown in the notification center — defaults to the first record's object label. */
  module?: string;
  /** Where an Order notification opens: "billing" = Order Billing, "tax" = that order's tax run (default: the Orders module). */
  context?: "billing" | "tax";
  /** For a multi-record operation: the one record the notification should open (e.g. the root bundle). Must be one of `records`. */
  primaryRecord?: CreatedSalesforceRecord;
}

export interface NotificationInput extends Omit<SalesforceSuccessInput, "records"> {
  tone: NotificationTone;
  records?: CreatedSalesforceRecord[];
}

export interface QueuedNotification extends NotificationInput {
  id: string;
  records: CreatedSalesforceRecord[];
}

type ToneNotify = (title: string, message: string, extra?: Partial<Omit<NotificationInput, "tone" | "title" | "message">>) => void;

export interface Notifier {
  notify: (input: NotificationInput) => void;
  success: ToneNotify;
  error: ToneNotify;
  warning: ToneNotify;
  info: ToneNotify;
}

export interface NotificationCenter {
  history: NotificationEntry[];
  unread: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

interface Ctx { notifier: Notifier; center: NotificationCenter }

const NotificationCtx = createContext<Ctx | null>(null);

function useCtx(hook: string): Ctx {
  const ctx = useContext(NotificationCtx);
  if (!ctx) throw new Error(`${hook} must be used within a SalesforceSuccessProvider`);
  return ctx;
}

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
export function useSalesforceSuccess(): (input: SalesforceSuccessInput) => void {
  const { notify } = useCtx("useSalesforceSuccess").notifier;
  return useCallback((input: SalesforceSuccessInput) => notify({ ...input, tone: "success" }), [notify]);
}

/** Same stack for any tone — errors and warnings land in the toast stack and the notification center too. */
export function useNotify(): Notifier {
  return useCtx("useNotify").notifier;
}

/** Notification history + unread count for the header bell. */
export function useNotificationCenter(): NotificationCenter {
  return useCtx("useNotificationCenter").center;
}

/**
 * Mounted once at the app root (app/layout.tsx, inside ThemeProvider) so
 * every page/module shares one notification stack without threading
 * `isDark` down through props — resolved here directly via next-themes,
 * defaulting to this app's own dark-by-default theme before hydration.
 *
 * Two lifecycles, deliberately separate: a toast leaves the stack after
 * TOAST_LIFETIME_MS (or on ×), while its history entry stays in the
 * notification center until "Clear All" or the retention policy removes it.
 * History persists in localStorage per connected user + org, and survives
 * page navigation because this provider lives in the root layout.
 */
export function SalesforceSuccessProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const pathname = usePathname();
  const [queue, setQueue] = useState<QueuedNotification[]>([]);
  const [history, setHistory] = useState<NotificationEntry[]>([]);
  const keyRef = useRef<string | null>(null);
  const recent = useRef(new Map<string, number>());

  const persist = useCallback((next: NotificationEntry[]) => {
    if (!keyRef.current) return;
    try { localStorage.setItem(keyRef.current, JSON.stringify(next)); } catch { /* storage full / blocked — history stays in memory */ }
  }, []);

  const updateHistory = useCallback((fn: (h: NotificationEntry[]) => NotificationEntry[]) => {
    setHistory(prev => { const next = fn(prev); persist(next); return next; });
  }, [persist]);

  // (Re)load history whenever the connected user/org may have changed — on mount and on every route change (login / sign-out navigate).
  useEffect(() => {
    const key = storageKey(loadSession());
    if (key === keyRef.current) return;
    keyRef.current = key;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* blocked storage */ }
    setHistory(parseHistory(raw, Date.now()));
  }, [pathname]);

  // Keep other tabs of the same user in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key === keyRef.current) setHistory(parseHistory(e.newValue, Date.now()));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const title = sanitizeText(input.title);
    const message = sanitizeText(input.message);
    const now = Date.now();
    if (isDuplicate(recent.current, dedupeKey(input.tone, title, message), now)) return;
    const records = input.records ?? [];
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    setQueue(q => [...q, { ...input, records, id }]);
    // Navigation targets come only from records the caller got back from Salesforce (real Ids), never from message text.
    const single = (input.primaryRecord && records.some(r => r.recordId === input.primaryRecord!.recordId) ? input.primaryRecord : null) ?? (records.length === 1 ? records[0] : null);
    const objectApiName = records[0]?.objectApiName ?? null;
    const moduleName = sanitizeText(input.module ?? objectLabel(objectApiName) ?? "") || null;
    const dest = objectApiName ? resolveDestination({ objectApiName, recordId: single?.recordId, module: moduleName, context: input.context }) : null;
    const sfUrl = single ? salesforceRecordUrl(loadSession()?.instanceUrl, single.objectApiName, single.recordId) : null;
    updateHistory(h => addEntry(h, {
      id, tone: input.tone, title, message, module: moduleName,
      recordCount: records.length, at: now, read: false,
      ...(single && isSalesforceId(single.recordId) ? { recordId: single.recordId } : {}),
      ...(single ? { recordName: sanitizeText(single.recordName) || undefined, objectApiName: single.objectApiName } : {}),
      ...(dest ? { destinationUrl: dest.href, destinationExact: dest.exact } : {}),
      ...(sfUrl ? { salesforceRecordUrl: sfUrl } : {}),
    }));
  }, [updateHistory]);

  const dismiss = useCallback((id: string) => {
    setQueue(q => q.filter(item => item.id !== id));
  }, []);

  const notifier = useMemo<Notifier>(() => {
    const tone = (t: NotificationTone): ToneNotify => (title, message, extra) => notify({ ...extra, tone: t, title, message });
    return { notify, success: tone("success"), error: tone("error"), warning: tone("warning"), info: tone("info") };
  }, [notify]);

  const center = useMemo<NotificationCenter>(() => ({
    history,
    unread: unreadCount(history),
    markRead: id => updateHistory(h => h.map(e => (e.id === id && !e.read ? { ...e, read: true } : e))),
    markAllRead: () => updateHistory(h => (h.some(e => !e.read) ? h.map(e => ({ ...e, read: true })) : h)),
    clearAll: () => updateHistory(() => []),
  }), [history, updateHistory]);

  const value = useMemo(() => ({ notifier, center }), [notifier, center]);

  return (
    <NotificationCtx.Provider value={value}>
      {children}
      {/* Below the 56–72px page headers so the stack never covers navigation controls. */}
      <div
        className="fixed right-4 left-4 sm:left-auto sm:w-[380px] flex flex-col gap-3"
        style={{ zIndex: Z.toast, top: 76, pointerEvents: "none" }}
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {queue.map(item => (
            <SalesforceSuccessCard key={item.id} isDark={isDark} notification={item} onClose={() => dismiss(item.id)} />
          ))}
        </AnimatePresence>
      </div>
    </NotificationCtx.Provider>
  );
}
