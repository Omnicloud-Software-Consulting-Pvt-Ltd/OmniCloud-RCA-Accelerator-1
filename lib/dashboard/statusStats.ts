/**
 * Shared status-breakdown helpers for every DataOmnion tile dashboard
 * (Quotes/Orders/Contracts/...). Each object's picklist values are whatever
 * the connected org defines them as — never a hardcoded literal — so every
 * dashboard derives its stat-card counts and activity-row colors through
 * these same case-insensitive, org-status-agnostic rules instead of each
 * reimplementing its own guesswork.
 */

export interface StatusCount {
  status: string;
  count: number;
  totalValue: number | null;
}

/** Sum of counts across every status entry whose label matches `pattern`. */
export function sumStatusCount(breakdown: StatusCount[], pattern: RegExp): number {
  return breakdown.filter(b => pattern.test(b.status)).reduce((sum, b) => sum + b.count, 0);
}

/**
 * Best-effort "which status(es) mean X" pick for a stat card whose exact
 * label the org controls (e.g. Quote's Approved/Accepted, Contract's
 * Activated/Active). If one or more statuses match `pattern`, their real
 * labels are joined for the card label and their counts summed. Otherwise —
 * so the card never silently shows 0 when the org just phrases it
 * differently — falls back to the largest status not in `exclude`, using
 * that status's own real name as the label rather than a fabricated one.
 */
export function pickBestEffortStatus(
  breakdown: StatusCount[],
  pattern: RegExp,
  exclude: RegExp[] = [],
  fallbackLabel = "Other",
): { label: string; count: number } {
  const matches = breakdown.filter(b => pattern.test(b.status));
  if (matches.length > 0) {
    const label = Array.from(new Set(matches.map(m => m.status))).join(" / ");
    return { label, count: matches.reduce((sum, m) => sum + m.count, 0) };
  }
  const fallback = breakdown
    .filter(b => b.status !== "No Status" && !exclude.some(re => re.test(b.status)))
    .sort((a, b) => b.count - a.count)[0];
  return fallback ? { label: fallback.status, count: fallback.count } : { label: fallbackLabel, count: 0 };
}

const POSITIVE_STATUS = /approved|accepted|won|activ|complete|signed/i;
const NEGATIVE_STATUS = /cancel|reject|denied|lost|expired/i;
const NEUTRAL_STATUS = /draft/i;

/** Recent-activity dot/pill color derived from the record's real current status — never fabricated per-event history. */
export function activityColorFor(status: string | null, justCreated: boolean): string {
  const ACCENT = "#00D4FF";
  const ACCENT_BLUE = "#3AABFF";
  const ACCENT_SOFT = "#60B8FF";
  const ACCENT_POSITIVE = "#22C55E";
  const ACCENT_NEGATIVE = "#E84444";

  if (justCreated) return ACCENT;
  if (!status) return ACCENT_BLUE;
  if (POSITIVE_STATUS.test(status)) return ACCENT_POSITIVE;
  if (NEGATIVE_STATUS.test(status)) return ACCENT_NEGATIVE;
  if (NEUTRAL_STATUS.test(status)) return ACCENT_SOFT;
  return ACCENT_BLUE;
}
