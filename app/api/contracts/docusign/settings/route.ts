import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { getConnection, toPublicConfig, upsertConnectionSettings } from "@/lib/contracts/docusign/connectionStore";
import { resolveDocuSignRedirectUri, validateDocuSignRedirectUri } from "@/lib/contracts/docusign/redirectUri";
import { maskDocuSignClientId as maskClientId, type DocuSignEnvironment } from "@/lib/contracts/docusign/client";

// GET /api/contracts/docusign/settings — this org's DocuSign connection
// config (§5.1). Never returns the encrypted secrets themselves, only
// whether they're set. Also returns non-sensitive OAuth diagnostics (the
// redirect_uri that would actually be used right now, and which tier of
// resolveDocuSignRedirectUri() produced it) so the UI can show it without
// a separate round-trip.
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  try {
    const row = await getConnection(orgId);
    console.log(`[DOCUSIGN SETTINGS READ]\norgId = ${orgId}\nstoredClientIdMasked = ${row?.clientId ? maskClientId(row.clientId) : null}`);
    const resolved = resolveDocuSignRedirectUri(row?.callbackUrl, req.nextUrl.origin);
    return NextResponse.json({
      success: true,
      config: toPublicConfig(row, orgId),
      diagnostics: {
        environment: row?.environment ?? "demo",
        maskedClientId: row?.clientId ? maskClientId(row.clientId) : null,
        resolvedRedirectUri: resolved.redirectUri,
        redirectUriSource: resolved.source,
      },
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load DocuSign settings");
  }
}

// POST /api/contracts/docusign/settings — configure this org's OWN DocuSign
// OAuth app (Client ID/Secret/environment/callback URL) + webhook HMAC
// secret (§5.1). Encrypted before persisting; clears any prior tokens since
// the app identity changed.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  let environment: DocuSignEnvironment, clientId: string, clientSecret: string, webhookSecret: string | undefined, callbackUrl: string | undefined;
  try {
    ({ environment, clientId, clientSecret, webhookSecret, callbackUrl } = await req.json());
    // Webhook secret is optional in this phase — it's only needed for DocuSign
    // Connect webhook HMAC verification, which isn't implemented yet (see
    // lib/contracts/docusign/connectionStore.ts's module doc comment).
    if (!clientId?.trim() || !clientSecret?.trim()) {
      return NextResponse.json({ error: "Client ID and Client Secret are required." }, { status: 400 });
    }
    // Callback URL is optional (blank = fall back to DOCUSIGN_REDIRECT_URI /
    // request origin — see resolveDocuSignRedirectUri()), but if the user
    // entered one, it must be valid. Never silently rewritten — reject and
    // ask the user to fix it instead.
    if (callbackUrl?.trim()) {
      const validationError = validateDocuSignRedirectUri(callbackUrl.trim());
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const existing = await getConnection(orgId);
    const incomingClientIdMasked = maskClientId(clientId.trim());
    const existingStoredClientIdMasked = existing?.clientId ? maskClientId(existing.clientId) : null;

    await upsertConnectionSettings(orgId, {
      environment: environment === "production" ? "production" : "demo",
      clientId, clientSecret, webhookSecret, callbackUrl,
    });
    const row = await getConnection(orgId);
    const resultingStoredClientIdMasked = row?.clientId ? maskClientId(row.clientId) : null;
    console.log(
      `[DOCUSIGN SETTINGS API]\norgId = ${orgId}\nincomingClientIdMasked = ${incomingClientIdMasked}\nexistingStoredClientIdMasked = ${existingStoredClientIdMasked}\nresultingStoredClientIdMasked = ${resultingStoredClientIdMasked}`,
    );
    const resolved = resolveDocuSignRedirectUri(row?.callbackUrl, req.nextUrl.origin);
    return NextResponse.json({
      success: true,
      config: toPublicConfig(row, orgId),
      diagnostics: {
        environment: row?.environment ?? "demo",
        maskedClientId: row?.clientId ? maskClientId(row.clientId) : null,
        resolvedRedirectUri: resolved.redirectUri,
        redirectUriSource: resolved.source,
      },
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to save DocuSign settings");
  }
}
