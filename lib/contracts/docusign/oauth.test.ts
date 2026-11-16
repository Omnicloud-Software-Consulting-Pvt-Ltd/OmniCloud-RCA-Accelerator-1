/** DocuSign OAuth (Authorization Code Grant + PKCE) against a fake DocuSign — MOCKED; nothing here contacts DocuSign. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DocuSignOAuthError, appOrigin, buildAuthorizeUrl, exchangeAuthorizationCode, getUserInfo, isDocuSignBaseUri, isGuid, redirectUriFor, refreshAccessToken, selectAccount,
} from "./oauth";

const IK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SK = "11111111-2222-3333-4444-555555555555";

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

test("authorize URL: demo vs production host, code flow with S256 PKCE, signature+extended scope, and never the secret", () => {
  const demo = new URL(buildAuthorizeUrl({ environment: "demo", integrationKey: IK, redirectUri: "https://app.example.com/api/contracts/docusign/callback", state: "STATE", codeChallenge: "CHAL" }));
  assert.equal(demo.origin, "https://account-d.docusign.com");
  assert.equal(demo.pathname, "/oauth/auth");
  assert.equal(demo.searchParams.get("response_type"), "code");
  assert.equal(demo.searchParams.get("scope"), "signature extended");
  assert.equal(demo.searchParams.get("client_id"), IK);
  assert.equal(demo.searchParams.get("state"), "STATE");
  assert.equal(demo.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!demo.toString().includes(SK));
  assert.equal(new URL(buildAuthorizeUrl({ environment: "production", integrationKey: IK, redirectUri: "x", state: "s", codeChallenge: "c" })).origin, "https://account.docusign.com");
});

test("code exchange: Basic client auth, code_verifier and redirect_uri sent; tokens parsed", async () => {
  const f = fakeFetch([{ status: 200, body: { access_token: "AT", refresh_token: "RT", expires_in: 28800, token_type: "Bearer" } }]);
  const t = await exchangeAuthorizationCode({ environment: "demo", integrationKey: IK, secretKey: SK, code: "CODE", codeVerifier: "VERIFIER", redirectUri: "https://app/cb" }, f.impl);
  assert.deepEqual(t, { accessToken: "AT", refreshToken: "RT", expiresInSeconds: 28800 });
  assert.equal(f.calls[0].url, "https://account-d.docusign.com/oauth/token");
  const headers = f.calls[0].init!.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from(`${IK}:${SK}`).toString("base64")}`);
  const form = new URLSearchParams(String(f.calls[0].init!.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "VERIFIER");
  assert.equal(form.get("redirect_uri"), "https://app/cb");
});

test("refresh: invalid_grant becomes a typed, plain-language error", async () => {
  const f = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  await assert.rejects(refreshAccessToken({ environment: "demo", integrationKey: IK, secretKey: SK, refreshToken: "old" }, f.impl), (e: unknown) => e instanceof DocuSignOAuthError && e.code === "invalid_grant" && /Reconnect/.test(e.message));
});

test("network failure is reported as such, not as a credential problem", async () => {
  await assert.rejects(refreshAccessToken({ environment: "demo", integrationKey: IK, secretKey: SK, refreshToken: "x" }, async () => { throw new Error("ECONNRESET"); }), (e: unknown) => e instanceof DocuSignOAuthError && e.code === "NETWORK_ERROR");
});

test("userinfo + account selection: default account, named account must belong to the user", async () => {
  const f = fakeFetch([{ status: 200, body: { sub: "U1", name: "Pat Lee", email: "pat@example.com", accounts: [
    { account_id: "acc-1", account_name: "Main", base_uri: "https://demo.docusign.net", is_default: false },
    { account_id: "acc-2", account_name: "Default Co", base_uri: "https://na3.docusign.net", is_default: true },
  ] } }]);
  const info = await getUserInfo("demo", "AT", f.impl);
  assert.equal((f.calls[0].init!.headers as Record<string, string>).Authorization, "Bearer AT");
  const def = selectAccount(info, null);
  assert.ok("account" in def && def.account.accountId === "acc-2");
  const named = selectAccount(info, "ACC-1");
  assert.ok("account" in named && named.account.accountId === "acc-1");
  const foreign = selectAccount(info, "acc-999");
  assert.ok("error" in foreign && foreign.code === "ACCOUNT_NOT_FOUND");
  assert.ok("error" in selectAccount({ ...info, accounts: [] }, null));
});

test("API calls can only target DocuSign hosts over https", () => {
  for (const ok of ["https://demo.docusign.net", "https://na3.docusign.net/", "https://eu.docusign.net", "https://www.docusign.com"]) assert.equal(isDocuSignBaseUri(ok), true, ok);
  for (const bad of ["http://demo.docusign.net", "https://docusign.net.evil.com", "https://evil.com/docusign.net", "https://user:pw@demo.docusign.net", "javascript:alert(1)", "not a url"]) assert.equal(isDocuSignBaseUri(bad), false, bad);
});

test("redirect URI comes from configuration or the request origin, never from input", () => {
  assert.equal(redirectUriFor(appOrigin("http://localhost:3000", undefined)), "http://localhost:3000/api/contracts/docusign/callback");
  assert.equal(redirectUriFor(appOrigin("http://internal:3000", "https://rca.omnicloudconsulting.com/")), "https://rca.omnicloudconsulting.com/api/contracts/docusign/callback");
  assert.equal(isGuid(IK), true);
  assert.equal(isGuid("not-a-guid"), false);
});
