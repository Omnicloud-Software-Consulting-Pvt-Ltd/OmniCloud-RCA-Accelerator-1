/**
 * Single authoritative resolver for the PUBLIC base URL used to build the
 * recipient-facing signing link in the "Send Signing Email" manual-delivery
 * flow (see envelope.ts's sendEmbeddedSigningTestEnvelope). Every place that
 * needs it must call this, never reconstruct its own — mirrors
 * redirectUri.ts's resolveDocuSignRedirectUri, same rationale.
 *
 * WHY THIS EXISTS: without an explicit override, this app has always used
 * the incoming request's own origin (`req.nextUrl.origin`) to build links —
 * fine for the DocuSign OAuth redirect_uri (DocuSign redirects the SAME
 * browser back to wherever it came from) but wrong here: the link in this
 * flow is emailed to a DIFFERENT person, on a DIFFERENT machine, at some
 * later time. In local dev, the request origin is `http://localhost:3000` —
 * a value that is only ever reachable from the machine running the dev
 * server, never from a recipient's own computer. Silently emailing that
 * value produces a signing link that looks legitimate but can never work
 * for anyone else. `NEXT_PUBLIC_APP_URL` lets an operator declare the real,
 * externally-reachable base URL once (a deployed domain, or a tunnel URL
 * for local testing) instead of trusting whatever the current request
 * happened to arrive on.
 */
export interface ResolvedPublicAppUrl {
  baseUrl: string;
  source: "env" | "request-origin";
  /** True when the resolved base URL is a loopback address — the UI must warn the sender rather than silently emailing an unreachable link. */
  isLocalhost: boolean;
}

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function resolvePublicAppUrl(requestOrigin: string): ResolvedPublicAppUrl {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const baseUrl = fromEnv || requestOrigin;
  return {
    baseUrl,
    source: fromEnv ? "env" : "request-origin",
    isLocalhost: LOCALHOST_PATTERN.test(baseUrl),
  };
}
