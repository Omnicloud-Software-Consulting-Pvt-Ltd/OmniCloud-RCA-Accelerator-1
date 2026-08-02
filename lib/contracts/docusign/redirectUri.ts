const CALLBACK_PATH = "/api/contracts/docusign/callback";

export type DocuSignRedirectUriSource = "saved-config" | "environment" | "request-origin";

export interface ResolvedDocuSignRedirectUri {
  redirectUri: string;
  source: DocuSignRedirectUriSource;
}

/**
 * Single authoritative resolver for the DocuSign OAuth redirect_uri — every
 * place that needs one (the /connect authorize URL, the diagnostics panel)
 * must call this, never reconstruct its own. Priority:
 *   1. this org's saved DocuSign integration callback URL (Settings UI)
 *   2. DOCUSIGN_REDIRECT_URI env var (deploy-wide default) — same pattern
 *      as NEXTAUTH_URL for the Salesforce OAuth flow (see
 *      app/api/auth/salesforce/url/route.ts's appBaseUrl())
 *   3. this request's own origin + the fixed callback path
 * The actual value used for a given OAuth attempt is then carried through
 * the flow via the state cookie (see connect/route.ts, callback/route.ts)
 * so callback's token exchange never has to re-resolve and risk drifting
 * from what /connect actually sent DocuSign.
 */
export function resolveDocuSignRedirectUri(savedCallbackUrl: string | null | undefined, requestOrigin: string): ResolvedDocuSignRedirectUri {
  const saved = savedCallbackUrl?.trim();
  if (saved) return { redirectUri: saved, source: "saved-config" };

  const fromEnv = process.env.DOCUSIGN_REDIRECT_URI?.trim();
  if (fromEnv) return { redirectUri: fromEnv, source: "environment" };

  return { redirectUri: new URL(CALLBACK_PATH, requestOrigin).toString(), source: "request-origin" };
}

/**
 * Validate a user-supplied callback URL before it's saved or used to start
 * an OAuth attempt. Returns an error message, or null if valid. Never
 * rewrites/normalizes the value itself — an invalid URL is rejected, not
 * silently corrected.
 */
export function validateDocuSignRedirectUri(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Callback URL must be a valid absolute URL, e.g. https://example.com/api/contracts/docusign/callback.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Callback URL must use http:// or https://.";
  }

  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && !isLocalhost) {
    return "HTTPS is required for a non-localhost callback URL.";
  }

  if (parsed.pathname !== CALLBACK_PATH) {
    return `Callback URL path must be exactly "${CALLBACK_PATH}" (got "${parsed.pathname}").`;
  }

  return null;
}
