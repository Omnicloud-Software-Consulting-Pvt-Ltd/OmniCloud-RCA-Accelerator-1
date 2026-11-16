/**
 * DocuSign Settings server behavior: encryption-key setup states, credential cookie sizing/splitting, unreadable or mixed-up
 * connection cookies, and secret exposure — through the real route logic against a FAKE DocuSign (MOCKED; no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";
import { encodeSession } from "@/lib/salesforce/client";
import { ENCRYPTION_KEY_ENV, encryptionKeyState } from "@/lib/contracts/docusign/crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { completeCallback, connectionStatus, disconnect, serverSetupView, startConnect, verifyConnection } from "./connection";
import { docuSignRoute } from "./context";
import { CookieJar, CredentialTooLargeError, DS_COOKIE, MAX_COOKIE_BYTES, cookieBytes, readConnection } from "./session";
import { SERVER_SECURITY_TEXT, type StoredConnection } from "@/lib/contracts/docusign/types";

const KEY = randomBytes(32).toString("base64");
const IK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SK = "11111111-2222-3333-4444-555555555555";
const sfA = encodeSession({ instanceUrl: "https://acme.my.salesforce.com", accessToken: "sfA", refreshToken: "refreshA" });
const sfB = encodeSession({ instanceUrl: "https://acme.my.salesforce.com", accessToken: "sfB", refreshToken: "refreshB" });

function withKey<T>(value: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const before = process.env[ENCRYPTION_KEY_ENV];
  if (value === undefined) delete process.env[ENCRYPTION_KEY_ENV]; else process.env[ENCRYPTION_KEY_ENV] = value;
  return Promise.resolve(run()).finally(() => { if (before === undefined) delete process.env[ENCRYPTION_KEY_ENV]; else process.env[ENCRYPTION_KEY_ENV] = before; });
}

function req(path: string, cookies: Record<string, string>, method = "GET") {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
}
const cookiesOf = (res: NextResponse) => Object.fromEntries(Object.values(DS_COOKIE).map(n => [n, res.cookies.get(n)?.value ?? ""]).filter(([, v]) => v));

function fakeDocuSign(o: { tokenLength?: number } = {}) {
  const big = (s: string) => (o.tokenLength ? s + "x".repeat(Math.max(0, o.tokenLength - s.length)) : s);
  return async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/oauth/token")) return json(200, { access_token: big("ACCESS-TOKEN-SECRET"), refresh_token: big("REFRESH-TOKEN-SECRET"), expires_in: 28800 });
    if (url.endsWith("/oauth/userinfo")) return json(200, { sub: "u1", name: "Pat Lee", email: "pat@example.com", accounts: [{ account_id: "acc-1", account_name: "Acme", base_uri: "https://na4.docusign.net", is_default: true }] });
    if (url === "https://na4.docusign.net/restapi/v2.1/accounts/acc-1") return json(200, { accountName: "Acme" });
    return json(404, {});
  };
}

async function connect(sf: string, fake = fakeDocuSign()) {
  const start = await startConnect(req("/c", { sf_session: sf }, "POST"), { environment: "production", integrationKey: IK, secretKey: SK });
  const state = new URL((await start.json()).authorizeUrl).searchParams.get("state")!;
  const cb = await completeCallback(req(`/cb?code=C&state=${state}`, { sf_session: sf, [DS_COOKIE.pending]: start.cookies.get(DS_COOKIE.pending)!.value }), fake);
  return { cb, cookies: cookiesOf(cb) };
}

test("missing key: status is setup_required with ONLY the friendly message — no command, variable name or file for users; every action is refused", () => withKey(undefined, async () => {
  const s = await connectionStatus(req("/s", { sf_session: sfA })).json();
  assert.equal(s.status, "setup_required");
  assert.equal(s.encryptionReady, false);
  assert.deepEqual(s.serverSetup, { configured: false, reason: "missing" }, "the browser learns the reason, never the key");
  assert.equal(s.message, SERVER_SECURITY_TEXT.missing, "the actual reason (key not configured), not a generic error");
  assert.equal(s.status === "setup_required" && s.connection, null);
  assert.match(s.redirectUri, /\/api\/contracts\/docusign\/callback$/, "the Redirect URI is still shown so the admin can prepare DocuSign");
  const c = await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK });
  assert.equal(c.status, 503);
  assert.equal((await c.json()).code, "DOCUSIGN_ENCRYPTION_KEY_MISSING");
  assert.equal((await verifyConnection(req("/v", { sf_session: sfA }, "POST"))).status, 503);
  assert.equal((await docuSignRoute(req("/r", { sf_session: sfA }), {}, async () => ({}))).status, 503);
  assert.match((await completeCallback(req("/cb?code=x&state=y", { sf_session: sfA }))).headers.get("location")!, /ds_error=DOCUSIGN_ENCRYPTION_KEY_MISSING/);
}));

test("invalid key: reported as invalid, never used, never echoed", () => withKey("too-short-not-a-real-key", async () => {
  assert.equal(encryptionKeyState(), "invalid");
  const res = connectionStatus(req("/s", { sf_session: sfA }));
  const text = await res.text();
  assert.deepEqual(JSON.parse(text).serverSetup, { configured: false, reason: "invalid" });
  assert.equal(JSON.parse(text).message, SERVER_SECURITY_TEXT.invalid, "the actual reason: configured but not valid");
  assert.ok(!text.includes("too-short-not-a-real-key"), "the configured value is never shown");
  assert.equal((await (await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK })).json()).code, "DOCUSIGN_ENCRYPTION_KEY_INVALID");
}));

test("a configured key is never included in any response", () => withKey(KEY, async () => {
  const { cookies } = await connect(sfA);
  const bodies = [
    await connectionStatus(req("/s", { sf_session: sfA, ...cookies })).text(),
    await (await verifyConnection(req("/v", { sf_session: sfA, ...cookies }, "POST"), fakeDocuSign())).text(),
  ];
  for (const b of bodies) for (const secret of [KEY, SK, IK, "REFRESH-TOKEN-SECRET", "ACCESS-TOKEN-SECRET"]) assert.ok(!b.includes(secret), `${secret.slice(0, 12)}… leaked`);
}));

test("connection = details cookie + refresh-token cookie; neither works alone, and one user's refresh cookie can't complete another's", () => withKey(KEY, async () => {
  const a = await connect(sfA);
  const b = await connect(sfB);
  assert.equal((await connectionStatus(req("/s", { sf_session: sfA, ...a.cookies })).json()).status, "connected");
  assert.equal((await connectionStatus(req("/s", { sf_session: sfA, [DS_COOKIE.connection]: a.cookies[DS_COOKIE.connection] })).json()).status, "not_connected");
  assert.equal((await connectionStatus(req("/s", { sf_session: sfA, [DS_COOKIE.refresh]: a.cookies[DS_COOKIE.refresh] })).json()).status, "not_connected");
  const mixed = await connectionStatus(req("/s", { sf_session: sfA, [DS_COOKIE.connection]: a.cookies[DS_COOKIE.connection], [DS_COOKIE.refresh]: b.cookies[DS_COOKIE.refresh] })).json();
  assert.equal(mixed.status, "not_connected", "a refresh token bound to another session is rejected");
  assert.equal((await connectionStatus(req("/s", { sf_session: sfB, ...a.cookies })).json()).status, "reauthorization_required", "user B can't use user A's connection");
  assert.equal((await docuSignRoute(req("/r", { sf_session: sfB, ...a.cookies }), {}, async () => ({}))).status, 409);
}));

test("credentials survive a restart with the same key, and are unreadable (connect again) after the key changes", () => withKey(KEY, async () => {
  const { cookies } = await connect(sfA);
  assert.equal((await connectionStatus(req("/s", { sf_session: sfA, ...cookies })).json()).status, "connected", "same key → same cookies still readable (stateless, restart-safe)");
  await withKey(randomBytes(32).toString("base64"), async () => {
    const s = await connectionStatus(req("/s", { sf_session: sfA, ...cookies })).json();
    assert.equal(s.status, "not_connected");
    assert.match(s.message, /can no longer be read/);
  });
}));

test("cookie sizes: realistic DocuSign tokens fit; an oversized credential fails loudly instead of being silently dropped", () => withKey(KEY, async () => {
  const realistic = await connect(sfA, fakeDocuSign({ tokenLength: 2000 }));
  assert.match(realistic.cb.headers.get("location")!, /ds=connected/);
  for (const name of [DS_COOKIE.connection, DS_COOKIE.refresh, DS_COOKIE.token]) {
    const v = realistic.cookies[name];
    assert.ok(v && cookieBytes(name, v, 2592000) <= MAX_COOKIE_BYTES, `${name} within ${MAX_COOKIE_BYTES} bytes`);
  }
  const huge = await connect(sfA, fakeDocuSign({ tokenLength: 3500 }));
  assert.match(huge.cb.headers.get("location")!, /ds_error=CREDENTIALS_TOO_LARGE/);
  assert.equal(huge.cookies[DS_COOKIE.connection], undefined, "no half-saved connection");
  assert.equal(huge.cookies[DS_COOKIE.refresh], undefined);
}));

test("CookieJar: an oversized refresh token throws; an oversized access token is just not cached", () => {
  const jar = new CookieJar(randomBytes(32));
  const conn: StoredConnection = { v: 1, environment: "demo", integrationKey: IK, secretKey: SK, refreshToken: "x".repeat(3500), accountId: "acc", accountName: null, baseUri: "https://demo.docusign.net", userId: null, userName: null, userEmail: null, binding: "b", connectedAt: "", lastVerifiedAt: null };
  assert.throws(() => jar.setConnection(conn), CredentialTooLargeError);
  assert.equal(jar.setAccessToken({ v: 1, token: "x".repeat(3500), expiresAt: Date.now() + 3600_000, binding: "b" }), false);
  assert.equal(jar.setAccessToken({ v: 1, token: "x".repeat(1500), expiresAt: Date.now() + 3600_000, binding: "b" }), true);
});

test("disconnect removes all four DocuSign cookies; the connection is then gone", () => withKey(KEY, async () => {
  const { cookies } = await connect(sfA);
  const res = disconnect(req("/d", { sf_session: sfA, ...cookies }, "POST"));
  for (const name of Object.values(DS_COOKIE)) assert.equal(res.cookies.get(name)?.value, "", `${name} cleared`);
  const key = Buffer.from(KEY, "base64");
  assert.equal(readConnection(req("/s", { sf_session: sfA }), key), null);
}));

test("disconnect and status still require a Salesforce session", () => withKey(KEY, async () => {
  assert.equal(disconnect(req("/d", {}, "POST")).status, 401);
  assert.equal(connectionStatus(req("/s", {})).status, 401);
}));

const TERMINAL_OR_ENV_HINTS = ["node -e", "randomBytes", ".env.local", ".env", "terminal", "environment variable", ENCRYPTION_KEY_ENV];

test("hosted UX: with the key missing, nothing a user receives asks them to run commands or edit server settings", () => withKey(undefined, async () => {
  const bodies: Record<string, unknown>[] = [
    await connectionStatus(req("/s", { sf_session: sfA })).json(),
    await (await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK })).json(),
    await (await verifyConnection(req("/v", { sf_session: sfA }, "POST"))).json(),
    await (await docuSignRoute(req("/r", { sf_session: sfA }), {}, async () => ({}))).json(),
  ];
  for (const b of bodies) {
    const userText = JSON.stringify({ message: b.message, error: b.error, serverSetup: b.serverSetup });
    for (const hint of TERMINAL_OR_ENV_HINTS) assert.ok(!userText.includes(hint), `user-facing text mentions "${hint}": ${userText}`);
    assert.ok([b.message, b.error].includes(SERVER_SECURITY_TEXT.missing), "the actual reason is shown, with who to contact");
  }
}));

test("configured key: users are told security is configured and can connect — automatically, no per-computer step", () => withKey(KEY, async () => {
  const s = await connectionStatus(req("/s", { sf_session: sfA })).json();
  assert.equal(s.encryptionReady, true);
  assert.equal(s.serverSetup.configured, true);
  assert.equal(s.status, "not_connected");
  const c = await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK });
  assert.equal(c.status, 200, "Connect works as soon as the server has the key");
}));

test("the status response carries only a configured flag — no key, variable name, command or developer block, in any environment", () => {
  assert.deepEqual(serverSetupView("missing"), { configured: false, reason: "missing" });
  assert.deepEqual(serverSetupView("invalid"), { configured: false, reason: "invalid" });
  assert.deepEqual(serverSetupView("ok"), { configured: true, reason: null });
});

test("Settings page: Connect DocuSign comes first and is never hidden behind server setup; no Server Setup / Check again / developer panel", () => {
  const src = readFileSync(join(process.cwd(), "components", "data", "contracts", "docusign", "DocuSignSettings.tsx"), "utf8");
  for (const gone of ["Server Setup", "Check again", "Developer setup", "Server administrator action required", "fieldset disabled", "<ServerSetup"]) assert.ok(!src.includes(gone), `still contains "${gone}"`);
  const order = ['"1. Connect DocuSign"', '"2. Connection Status"', '"3. Help and Troubleshooting"'].map(t => src.indexOf(t));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], "sections are 1. Connect, 2. Status, 3. Help");
  assert.match(src, /<ConnectSection [^>]*\/>/, "the connect form is rendered once status has loaded, whatever the server state");
  assert.match(src, /disabled=\{!ready\}/, "only the Connect button is gated");
  assert.match(src, /const ready = keyReady && /, "Connect is disabled while the server can't store credentials securely");
});

test("frontend code contains no key material, generation command or env-file instructions, and never imports server crypto", () => {
  const dir = join(process.cwd(), "components", "data", "contracts", "docusign");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".tsx") || f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const banned of ["node -e", "randomBytes", ".env.local", "loadEncryptionKey", "KEY_GENERATION_COMMAND", "docusign/crypto", KEY]) assert.ok(!src.includes(banned), `${file} contains "${banned}"`);
  }
});

test("the server never creates a key on its own: status/connect calls leave a missing key missing", () => withKey(undefined, async () => {
  for (let i = 0; i < 3; i++) {
    await connectionStatus(req("/s", { sf_session: sfA })).json();
    await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK });
  }
  assert.equal(process.env[ENCRYPTION_KEY_ENV], undefined);
  assert.equal(encryptionKeyState(), "missing");
}));

test("a valid key pasted with quotes or a trailing newline is accepted; status becomes ready and Connect starts OAuth", () => withKey(`"${KEY}"\n`, async () => {
  assert.equal(encryptionKeyState(), "ok");
  const s = await connectionStatus(req("/s", { sf_session: sfA })).json();
  assert.deepEqual([s.encryptionReady, s.serverSetup.configured, s.serverSetup.reason], [true, true, null]);
  const c = await startConnect(req("/c", { sf_session: sfA }, "POST"), { environment: "demo", integrationKey: IK, secretKey: SK });
  assert.equal(c.status, 200);
  assert.match((await c.json()).authorizeUrl, /^https:\/\/account-d\.docusign\.com\/oauth\/auth\?/);
}));

test("route gate reports the actual reason: missing vs invalid", async () => {
  await withKey(undefined, async () => {
    const b = await (await docuSignRoute(req("/r", { sf_session: sfA }), {}, async () => ({}))).json();
    assert.deepEqual([b.code, b.error], ["DOCUSIGN_ENCRYPTION_KEY_MISSING", SERVER_SECURITY_TEXT.missing]);
  });
  await withKey("nope", async () => {
    const b = await (await docuSignRoute(req("/r", { sf_session: sfA }), {}, async () => ({}))).json();
    assert.deepEqual([b.code, b.error], ["DOCUSIGN_ENCRYPTION_KEY_INVALID", SERVER_SECURITY_TEXT.invalid]);
  });
});
