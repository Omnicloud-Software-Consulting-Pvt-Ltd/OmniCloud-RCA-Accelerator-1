import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import {
  getConnection, saveOAuthTokens, markReauthorizationRequired,
  markConnectionError, toPublicConfig,
} from "@/lib/contracts/docusign/connectionStore";
import { refreshAccessToken, getUserInfo, DocuSignError } from "@/lib/contracts/docusign/client";

// POST /api/contracts/docusign/refresh — "Refresh Connection": forces an
// access-token refresh right now (rather than waiting for the proactive
// skew-window refresh in oauth.ts's getActiveDocuSignSession) and re-reads
// the connected account/user from a real DocuSign identity call, so the UI's
// Connected Account/Connected User/Connection Status reflect what's true
// right now, not stale data from the original connect.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const orgId = auth.client.instanceUrl;

  const record = await getConnection(orgId);
  if (!record) {
    return NextResponse.json({ error: "DocuSign is not configured for this organization." }, { status: 400 });
  }
  if (!record.refreshToken) {
    return NextResponse.json({ error: "DocuSign is not connected — connect it first." }, { status: 400 });
  }

  try {
    const refreshed = await refreshAccessToken(record.environment, record.clientId, record.clientSecret, record.refreshToken);
    const userInfo = await getUserInfo(record.environment, refreshed.accessToken);
    const account = userInfo.accounts.find(a => a.is_default) ?? userInfo.accounts[0];
    if (!account) throw new Error("DocuSign account info did not include any accounts.");

    await saveOAuthTokens(orgId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresInSeconds: refreshed.expiresIn,
      docusignAccountId: account.account_id,
      docusignAccountName: account.account_name,
      baseUri: account.base_uri,
      connectedUserName: userInfo.name,
      connectedUserEmail: userInfo.email,
      connectedUserId: userInfo.sub,
    });

    const updated = await getConnection(orgId);
    return NextResponse.json({ success: true, config: toPublicConfig(updated, orgId) });
  } catch (err) {
    const invalidGrant = err instanceof DocuSignError && !!(err.body as { invalidGrant?: boolean } | null)?.invalidGrant;
    const message = err instanceof Error ? err.message : "Failed to refresh the DocuSign connection.";
    if (invalidGrant) {
      await markReauthorizationRequired(orgId, "DocuSign refresh token is no longer valid — reconnect DocuSign for this organization.");
    } else {
      await markConnectionError(orgId, message);
    }
    const updated = await getConnection(orgId);
    return NextResponse.json({ success: false, error: message, config: toPublicConfig(updated, orgId) }, { status: 502 });
  }
}
