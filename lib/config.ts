import type { NextRequest } from "next/server";

/**
 * App configuration the user enters in the Setup wizard (currently the Anthropic
 * API key). Stored in an httpOnly cookie so it's never exposed to client JS and
 * rides along automatically to API routes that call Claude.
 */

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
 * Resolve the Anthropic API key for a request: the user's BYO key from the
 * config cookie takes precedence, falling back to a server env var if present.
 * Returns null if neither is configured.
 */
export function resolveAnthropicKey(req: NextRequest): string | null {
  const fromCookie = getConfig(req)?.anthropicApiKey;
  if (fromCookie) return fromCookie;
  return process.env.ANTHROPIC_API_KEY ?? null;
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
