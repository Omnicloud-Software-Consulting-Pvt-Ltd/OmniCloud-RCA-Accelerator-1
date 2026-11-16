/**
 * Bundle-Based Pricing — structured diagnostic logging.
 *
 * Every entry is one JSON object (`{ scope, stage, ...data }`) written both to the client's own debug log
 * (so it lands in the sanitized audit log returned to the UI) and to the server console. Callers pass only
 * record Ids, names, counts, and Salesforce error text — never a session, token, or credential; the
 * `redact` pass below is a second line of defense in case a caller ever passes a whole object through.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";

const SECRET_KEY_PATTERN = /token|secret|password|authorization|apikey|api_key|sessionid|credential/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function bundleLog(client: SalesforceClient, stage: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ scope: "bundle-based-pricing", stage, ...(redact(data) as Record<string, unknown>) });
  client.logDebug("execution-trace", entry);
  console.info(`[bundle-based-pricing] ${entry}`);
}
