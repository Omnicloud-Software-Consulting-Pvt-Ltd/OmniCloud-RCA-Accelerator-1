"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Ic, tokens } from "@/components/data/quotes/shared";
import { formatRelative, type NotificationEntry } from "@/lib/notifications/history";
import { isSafeInternalHref, isSafeSalesforceUrl, openAppDestination } from "@/lib/notifications/destinations";
import { loadSession } from "@/lib/auth/session";
import { useNotificationCenter } from "./SalesforceSuccessContext";
import { TONE_STYLE } from "./SalesforceSuccessCard";
import { Z } from "@/lib/ui/overlay";

const PANEL_WIDTH = 360;
const noopSubscribe = () => () => {};

function BellIcon({ s = 14 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

const TONE_LABEL = { success: "Success", error: "Error", warning: "Warning", info: "Info" } as const;

/**
 * One history row. The row itself is the primary action: it marks the notification read and opens
 * its destination (the record's details view, else its module). The chevron only expands details,
 * and the expanded actions stop propagation — so inspecting never navigates by accident.
 * A row without a destination just expands.
 */
function NotificationItem({ n, isDark, now, instanceUrl, expanded, onToggle, onOpen, markRead }: {
  n: NotificationEntry; isDark: boolean; now: number; instanceUrl: string | null; expanded: boolean;
  onToggle: () => void; onOpen: (href: string) => void; markRead: (id: string) => void;
}) {
  const t = tokens(isDark);
  const tone = TONE_STYLE[n.tone];
  const dest = isSafeInternalHref(n.destinationUrl) ? n.destinationUrl : null;
  // Opened only on the org the user is connected to now — a link for another org is hidden, not followed.
  const sfUrl = isSafeSalesforceUrl(n.salesforceRecordUrl, instanceUrl) ? n.salesforceRecordUrl : null;
  const viewLabel = n.destinationExact ? "View Record" : `Open ${n.module ?? "Module"}`;
  const rowBorder = `1px solid ${isDark ? "rgba(0,112,214,0.12)" : "rgba(0,71,171,0.10)"}`;

  const activate = () => {
    markRead(n.id);
    if (dest) onOpen(dest);
    else onToggle();
  };

  const detailRow = (label: string, value: string | null | undefined) => value ? (
    <div className="flex gap-2 text-[11px] leading-snug">
      <span className="shrink-0" style={{ color: t.dim, width: 74 }}>{label}</span>
      <span className="min-w-0" style={{ color: t.body, wordBreak: "break-word" }}>{value}</span>
    </div>
  ) : null;

  return (
    <li style={{ borderBottom: rowBorder, background: n.read ? "transparent" : isDark ? "rgba(0,212,255,0.05)" : "rgba(0,112,214,0.06)" }}>
      <div className="flex items-start">
        <button
          onClick={activate}
          title={dest ? viewLabel : undefined}
          className="flex-1 min-w-0 text-left flex items-start gap-3 pl-4 pr-1 py-3 cursor-pointer"
          style={{ background: "transparent", border: "none" }}
        >
          <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${tone.color}18`, color: tone.color, border: `1px solid ${tone.color}30` }}>
            <Ic n={tone.icon} s={14} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-[12.5px] truncate" style={{ color: t.heading, fontWeight: n.read ? 600 : 700 }}>{n.title}</span>
              {!n.read && <span aria-label="Unread" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: t.accent }} />}
            </span>
            {n.message && <span className={`block text-[11.5px] mt-0.5 leading-snug ${expanded ? "" : "line-clamp-2"}`} style={{ color: t.body, wordBreak: "break-word" }}>{n.message}</span>}
            <span className="flex items-center gap-1.5 mt-1 text-[10.5px] flex-wrap" style={{ color: t.dim }}>
              <span>{formatRelative(n.at, now)}</span>
              {n.module && <><span>·</span><span>{n.module}</span></>}
              {n.recordCount > 1 && <><span>·</span><span>{n.recordCount} records</span></>}
              {dest && <><span>·</span><span className="inline-flex items-center gap-0.5 font-semibold" style={{ color: t.accent }}>{viewLabel}<Ic n="chevron-right" s={10} /></span></>}
            </span>
          </span>
        </button>
        <button
          onClick={e => { e.stopPropagation(); onToggle(); }}
          aria-expanded={expanded}
          aria-label={expanded ? "Hide details" : "Show details"}
          className="shrink-0 w-8 h-8 mt-2.5 mr-2 rounded-md flex items-center justify-center cursor-pointer"
          style={{ color: t.dim, background: "transparent", border: "none" }}
        >
          <Ic n={expanded ? "chevron-down" : "chevron-right"} s={13} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} style={{ overflow: "hidden" }}>
            <div className="flex flex-col gap-1 pb-3" style={{ paddingLeft: 56, paddingRight: 16 }}>
              {detailRow("Operation", n.title)}
              {detailRow("Status", TONE_LABEL[n.tone])}
              {detailRow("Module", n.module)}
              {detailRow("Record", n.recordName)}
              {detailRow("Record ID", n.recordId)}
              {detailRow("Time", new Date(n.at).toLocaleString())}
              {(dest || sfUrl) && (
                <div className="flex items-center gap-2 flex-wrap mt-1.5">
                  {dest && (
                    <button
                      onClick={e => { e.stopPropagation(); markRead(n.id); onOpen(dest); }}
                      className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-md cursor-pointer"
                      style={{ background: `${t.accent}1F`, color: t.accent, border: `1px solid ${t.accent}40` }}
                    >
                      {viewLabel} <Ic n="arrow-right" s={11} />
                    </button>
                  )}
                  {sfUrl && (
                    <a
                      href={sfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => { e.stopPropagation(); markRead(n.id); }}
                      className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-md"
                      style={{ color: "#00C875", border: "1px solid #00C87550", textDecoration: "none" }}
                    >
                      Open in Salesforce <Ic n="external-link" s={11} />
                    </a>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * Header bell + notification center. Reads the shared history from SalesforceSuccessProvider, so
 * every page header shows the same list and unread count. The panel is portaled to <body> (the
 * headers use backdrop-filter, which would otherwise trap a fixed/absolute panel under page content).
 */
export default function NotificationBell({ isDark }: { isDark: boolean }) {
  const t = tokens(isDark);
  const { history, unread, markRead, markAllRead, clearAll } = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; mobile: boolean }>({ top: 64, right: 16, mobile: false });
  const [now, setNow] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [instanceUrl, setInstanceUrl] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Client-only: the badge and the portal target don't exist during SSR.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right), mobile: window.innerWidth < PANEL_WIDTH + 32 });
  }, []);

  const toggle = () => {
    if (!open) { place(); setNow(Date.now()); setInstanceUrl(loadSession()?.instanceUrl ?? null); }
    setOpen(o => !o);
  };

  // Outside click / Escape / resize — registered only while open, always removed on close or unmount.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.clearInterval(tick);
    };
  }, [open, place]);

  const border = isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)";
  const badge = unread > 99 ? "99+" : String(unread);

  const panel = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="fixed flex flex-col"
          style={{
            zIndex: Z.popover,
            top: pos.top,
            ...(pos.mobile ? { left: 12, right: 12 } : { right: pos.right, width: PANEL_WIDTH }),
            maxHeight: `min(520px, calc(100dvh - ${pos.top + 16}px))`,
            background: isDark ? "rgba(1,9,24,0.97)" : "rgba(255,255,255,0.98)",
            border: `1px solid ${t.border}`,
            borderRadius: 14,
            boxShadow: isDark ? "0 16px 48px rgba(0,0,0,0.55)" : "0 16px 40px rgba(15,35,80,0.18)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            overflow: "hidden",
          }}
        >
          <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${t.border}` }}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold" style={{ color: t.heading }}>Notifications</span>
              {unread > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}1F`, color: t.accent }}>{unread} unread</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <button onClick={markAllRead} className="text-[11px] font-semibold px-2 py-1 rounded-md cursor-pointer" style={{ color: t.accent, background: "transparent", border: "none" }}>
                  Mark all read
                </button>
              )}
              <button
                onClick={clearAll}
                disabled={history.length === 0}
                className="text-[11px] font-semibold px-2 py-1 rounded-md"
                style={{ color: history.length ? t.error : t.dim, background: "transparent", border: "none", cursor: history.length ? "pointer" : "default", opacity: history.length ? 1 : 0.6 }}
              >
                Clear All
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: "contain" }}>
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <span style={{ color: t.dim }}><BellIcon s={22} /></span>
                <span className="text-[12.5px] font-medium" style={{ color: t.body }}>No notifications yet.</span>
                <span className="text-[11px]" style={{ color: t.dim }}>Successful operations and important alerts will appear here.</span>
              </div>
            ) : (
              <ul className="flex flex-col">
                {history.map(n => (
                  <NotificationItem
                    key={n.id}
                    n={n}
                    isDark={isDark}
                    now={now}
                    instanceUrl={instanceUrl}
                    expanded={expandedId === n.id}
                    onToggle={() => setExpandedId(id => (id === n.id ? null : n.id))}
                    onOpen={href => { if (openAppDestination(href)) setOpen(false); }}
                    markRead={markRead}
                  />
                ))}
              </ul>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <motion.button
        ref={buttonRef}
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
        style={{
          color: open ? t.accent : isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)",
          border,
          background: open ? (isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.10)") : "transparent",
        }}
        whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)" }}
        whileTap={{ scale: 0.93 }}
      >
        <BellIcon s={13} />
        {mounted && unread > 0 && (
          <span
            className="absolute flex items-center justify-center rounded-full text-[9px] font-bold leading-none"
            style={{ top: -6, right: -6, minWidth: 16, height: 16, padding: "0 4px", background: "#FF4066", color: "white", boxShadow: `0 0 0 2px ${isDark ? "#010918" : "#E4EEFF"}` }}
          >
            {badge}
          </span>
        )}
      </motion.button>
      {mounted && createPortal(panel, document.body)}
    </>
  );
}
