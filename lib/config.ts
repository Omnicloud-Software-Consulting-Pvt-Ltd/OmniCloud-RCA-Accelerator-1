import type { NextRequest } from "next/server";

/**
 * App configuration the user enters in the Setup wizard (currently the Anthropic
 * API key). Stored in an httpOnly cookie so it's never exposed to client JS and
 * rides along automatically to API routes that call Claude.
 */

// Same Claude model id used by the existing AI routes (bundles/parse, sf/attributes/parse,
// sf/products/generate-payload) — hoisted here so new AI routes don't re-hardcode it.
export const CLAUDE_MODEL = "claude-sonnet-4-6";

export const CONFIG_COOKIE = "omnicloud_config";
export const CONFIG_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export interface AppConfig {
  anthropicApiKey?: string;
  /** Salesforce Connected App credentials (entered in the Setup wizard). */
  sfClientId?: string;
  sfClientSecret?: string;
}

export function encodeConfig(config: AppConfig): string {
  return Buffer.from(JSON.stringify(config)).toString("base64url");
}

export function decodeConfig(encoded: string | undefined): AppConfig | null {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AppConfig;
  } catch {
    return null;
  }
}

/** Read the saved config from a request's cookies. */
export function getConfig(req: NextRequest): AppConfig | null {
  return decodeConfig(req.cookies.get(CONFIG_COOKIE)?.value);
}

/**
 * §Corrected architecture — this app is multi-tenant: each user connects their OWN Salesforce org and
 * provides their OWN Anthropic API key through the Setup flow (stored in THEIR browser's `omnicloud_config`
 * cookie, per `getConfig` above). An env-var fallback was briefly introduced here and has been REMOVED —
 * a server-wide `ANTHROPIC_API_KEY` would silently become a SHARED key for every user who hasn't configured
 * their own, which breaks the fundamental per-user isolation this app promises (User A's usage/billing must
 * never be attributable to User B's absent configuration). There is exactly ONE source of truth for this
 * key: the requesting user's own config cookie. Returns null if THIS user hasn't configured one — that is
 * the correct, expected result for a fresh/unconfigured session, never a bug to route around with a
 * shared fallback. (Salesforce Connected App credentials, resolved below, are a DIFFERENT case — a
 * Connected App is typically ONE OAuth registration shared by a deployment, not a personal, billed-per-use
 * credential like an Anthropic key, so keeping an env fallback there is not the same architectural error.)
 */
export function resolveAnthropicKey(req: NextRequest): string | null {
  return getConfig(req)?.anthropicApiKey ?? null;
}

export interface AnthropicKeyStatus {
  /** Whether THIS request's own user/session configuration has a key — never the value itself. */
  configured: boolean;
  /** Always "user-config" when configured (the one and only supported source) or "none" — no environment
   * fallback exists in this architecture, so no other value is possible. Named to match this file's own
   * existing terminology for the Setup-wizard-entered, per-user config cookie (see `AppConfig`/`getConfig`). */
  source: "user-config" | "none";
  /** A light, format-only sanity check (Anthropic keys start with "sk-ant-") — NOT a live API call. The
   * config cookie is already validated to this exact shape at write time (`POST /api/config`), so this
   * should normally always be `true` when `configured` is `true`; it exists as a defense-in-depth signal,
   * not because the write path is expected to ever produce an invalid stored value. */
  looksValid: boolean;
}

/**
 * §Non-secret diagnostic — reports ONLY whether THIS request's user/session has their own Anthropic key
 * configured. Never returns the key itself, any other cookie content, or any request header. Exists so
 * "why did /analyze return NO_AI_KEY for this session" has a one-call, safe-to-share answer — the answer
 * for a session that never went through Setup is simply `{configured:false, source:"none"}`, which is
 * CORRECT multi-tenant behavior, not a defect.
 */
export function resolveAnthropicKeyStatus(req: NextRequest): AnthropicKeyStatus {
  const key = getConfig(req)?.anthropicApiKey;
  if (key) return { configured: true, source: "user-config", looksValid: key.startsWith("sk-ant-") };
  return { configured: false, source: "none", looksValid: false };
}

/**
 * Resolve the Salesforce Connected App credentials for a request: the user's
 * in-app values (config cookie) take precedence, falling back to env vars.
 * Returns null if neither client id nor secret is available.
 */
export function resolveConnectedApp(
  req: NextRequest,
): { clientId: string; clientSecret: string } | null {
  const cfg = getConfig(req);
  const clientId = cfg?.sfClientId || process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = cfg?.sfClientSecret || process.env.SALESFORCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Just the client id (for the /url route, which doesn't need the secret). */
export function resolveClientId(req: NextRequest): string | null {
  return getConfig(req)?.sfClientId || process.env.SALESFORCE_CLIENT_ID || null;
}
