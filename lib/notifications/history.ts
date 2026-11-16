/**
 * Notification history — the pure, storage-agnostic half of the app's notification system
 * (components/notifications/SalesforceSuccessContext.tsx owns the React state, toasts and timers).
 *
 * A history entry is deliberately thin: tone, title, the user-facing message, the module it came
 * from, a timestamp, a record count and — for a single confirmed record — that record's Id, name,
 * object and where to open it (an in-app deep link and/or its Lightning URL on the connected org).
 * Raw API responses, tokens and credentials are never stored; text is scrubbed of anything that
 * looks like a secret, and navigation fields are re-validated whenever stored history is read back.
 */
import { isSafeInternalHref, isSalesforceId } from "@/lib/notifications/destinations";

export type NotificationTone = "success" | "error" | "warning" | "info";

export interface NotificationEntry {
  id: string;
  tone: NotificationTone;
  title: string;
  message: string;
  module: string | null;
  recordCount: number;
  /** epoch ms */
  at: number;
  read: boolean;
  /** Only for a single record Salesforce confirmed — the Id from the API response, never parsed from text. */
  recordId?: string;
  recordName?: string;
  objectApiName?: string;
  /** In-app deep link (an existing /data route); `destinationExact` = the record's own details view. */
  destinationUrl?: string;
  destinationExact?: boolean;
  salesforceRecordUrl?: string;
}

/** Every toast lives exactly this long, then slides out (no timer resets). */
export const TOAST_LIFETIME_MS = 10_000;
/** Same tone + title + message inside this window is one operation reported twice — keep the first. */
export const DUPLICATE_WINDOW_MS = 1_500;
/** Retention: newest N entries, none older than this. */
export const HISTORY_LIMIT = 100;
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_TEXT = 400;
const STORAGE_PREFIX = "omni.notifications.v1";

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=!-]+/gi,
  /\b(access_token|refresh_token|client_secret|password|sessionId|session_id|token)\s*[=:]\s*["']?[^\s"',&]+/gi,
  /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]+/g, // Salesforce session id
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
];

/** User-facing text only: secrets redacted, whitespace collapsed, length capped. */
export function sanitizeText(value: unknown): string {
  let s = typeof value === "string" ? value : value == null ? "" : String(value);
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

/** "Product2" → "Product", "BillingSchedule" → "Billing Schedule", "Ramp_Deal__c" → "Ramp Deal". */
export function objectLabel(apiName: string | null | undefined): string | null {
  if (!apiName) return null;
  const s = apiName
    .replace(/__c$|__mdt$/i, "")
    .replace(/2$/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s || null;
}

export function dedupeKey(tone: NotificationTone, title: string, message: string): string {
  return `${tone}|${title}|${message}`;
}

/** True when the same notification was already raised within the duplicate window (and records `now` otherwise). */
export function isDuplicate(recent: Map<string, number>, key: string, now: number): boolean {
  for (const [k, t] of recent) if (now - t > DUPLICATE_WINDOW_MS) recent.delete(k);
  const last = recent.get(key);
  if (last !== undefined && now - last <= DUPLICATE_WINDOW_MS) return true;
  recent.set(key, now);
  return false;
}

/** Retention policy: drop expired entries, keep the newest HISTORY_LIMIT (newest first). */
export function prune(entries: NotificationEntry[], now: number): NotificationEntry[] {
  return entries
    .filter(e => now - e.at <= HISTORY_MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT);
}

export function addEntry(entries: NotificationEntry[], entry: NotificationEntry): NotificationEntry[] {
  return prune([entry, ...entries.filter(e => e.id !== entry.id)], entry.at);
}

export const unreadCount = (entries: NotificationEntry[]) => entries.reduce((n, e) => n + (e.read ? 0 : 1), 0);

/** History is per connected user + org, so a shared browser never shows one user another's notifications. */
export function storageKey(session: { userId?: string | null; instanceUrl?: string | null } | null): string {
  if (!session?.userId) return `${STORAGE_PREFIX}:anonymous`;
  let host = session.instanceUrl ?? "";
  try { host = new URL(host).host; } catch { /* keep raw */ }
  return `${STORAGE_PREFIX}:${session.userId}@${host}`;
}

const TONES: NotificationTone[] = ["success", "error", "warning", "info"];

/** Parse stored JSON defensively — anything malformed is dropped, never thrown. */
export function parseHistory(raw: string | null, now: number): NotificationEntry[] {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: NotificationEntry[] = [];
  for (const d of data) {
    if (!d || typeof d !== "object") continue;
    const e = d as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.at !== "number" || !TONES.includes(e.tone as NotificationTone)) continue;
    const entry: NotificationEntry = {
      id: e.id,
      tone: e.tone as NotificationTone,
      title: sanitizeText(e.title),
      message: sanitizeText(e.message),
      module: typeof e.module === "string" ? sanitizeText(e.module) : null,
      recordCount: typeof e.recordCount === "number" ? e.recordCount : 0,
      at: e.at,
      read: e.read === true,
    };
    if (isSalesforceId(e.recordId)) entry.recordId = e.recordId;
    if (typeof e.recordName === "string" && e.recordName) entry.recordName = sanitizeText(e.recordName);
    if (typeof e.objectApiName === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(e.objectApiName)) entry.objectApiName = e.objectApiName;
    if (isSafeInternalHref(e.destinationUrl)) { entry.destinationUrl = e.destinationUrl; entry.destinationExact = e.destinationExact === true; }
    if (typeof e.salesforceRecordUrl === "string" && e.salesforceRecordUrl.startsWith("https://")) entry.salesforceRecordUrl = e.salesforceRecordUrl;
    out.push(entry);
  }
  return prune(out, now);
}

export function formatRelative(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
