/**
 * The DocuSign connection flow end to end through the real route logic (NextRequest in, NextResponse out) against a FAKE DocuSign —
 * MOCKED; nothing here contacts DocuSign or Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest, type NextResponse } from "next/server";
import { encodeSession, type SalesforceClient } from "@/lib/salesforce/client";
import { pkceChallenge } from "@/lib/contracts/docusign/crypto";
import { completeCallback, connectionStatus, disconnect, startConnect, verifyConnection } from "./connection";
import { docuSignRoute } from "./context";
import { listSignableDocuments, loadDocumentsForSending } from "./contractFiles";
import { DS_COOKIE } from "./session";
import { signedFileDescription } from "@/lib/contracts/docusign/signedDocuments";

process.env.DOCUSIGN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const IK = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SK = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "http://localhost:3000";
const sfA = encodeSession({ instanceUrl: "https://acme.my.salesforce.com", accessToken: "sfA", refreshToken: "refreshA" });
const sfB = encodeSession({ instanceUrl: "https://acme.my.salesforce.com", accessToken: "sfB", refreshToken: "refreshB" });

function req(path: string, cookies: Record<string, string>, init: { method?: string; body?: unknown } = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
}
const cookieOf = (res: NextResponse, name: string) => res.cookies.get(name)?.value ?? "";

/** A fake DocuSign: token endpoint, userinfo and the account endpoint. */
function fakeDocuSign(o: { refresh?: "ok" | "invalid_grant" } = {}) {
  const calls: { url: string; body: string }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/oauth/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token" && o.refresh === "invalid_grant") return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "ACCESS-TOKEN-SECRET", refresh_token: "REFRESH-TOKEN-SECRET", expires_in: 28800 });
    }
    if (url.endsWith("/oauth/userinfo")) return json(200, { sub: "u1", name: "Pat Lee", email: "pat@example.com", accounts: [{ account_id: "acc-1", account_name: "Acme Demo", base_uri: "https://demo.docusign.net", is_default: true }] });
    if (url === "https://demo.docusign.net/restapi/v2.1/accounts/acc-1") return json(200, { accountName: "Acme Demo", planName: "Developer" });
    return json(404, { errorCode: "NOT_FOUND" });
  };
  return { impl, calls };
}

async function connectAs(sf: string, ds = fakeDocuSign()) {
  const start = await startConnect(req("/api/contracts/docusign/connect", { sf_session: sf }, { method: "POST" }), { environment: "demo", integrationKey: IK, secretKey: SK });
  const body = await start.json();
  const pending = cookieOf(start, DS_COOKIE.pending);
  const state = new URL(body.authorizeUrl).searchParams.get("state")!;
  const cb = await completeCallback(req(`/api/contracts/docusign/callback?code=CODE&state=${state}`, { sf_session: sf, [DS_COOKIE.pending]: pending }), ds.impl);
  return { start, body, pending, cb, ds, conn: { [DS_COOKIE.connection]: cookieOf(cb, DS_COOKIE.connection), [DS_COOKIE.refresh]: cookieOf(cb, DS_COOKIE.refresh) }, token: cookieOf(cb, DS_COOKIE.token) };
}

test("connect: validates the setup, returns DocuSign's consent URL, keeps the secret server-side (encrypted cookie only)", async () => {
  const bad = await startConnect(req("/x", { sf_session: sfA }, { method: "POST" }), { environment: "demo", integrationKey: "nope", secretKey: SK });
  assert.equal(bad.status, 400);
  const noEnv = await startConnect(req("/x", { sf_session: sfA }, { method: "POST" }), { integrationKey: IK, secretKey: SK });
  assert.equal(noEnv.status, 400);
  const { start, body, pending } = await connectAs(sfA);
  assert.equal(start.status, 200);
  const url = new URL(body.authorizeUrl);
  assert.equal(url.origin, "https://account-d.docusign.com");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/api/contracts/docusign/callback`);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(SK), "secret key is never in the response");
  assert.ok(pending && !pending.includes(SK) && !pending.includes(IK), "the pending cookie is ciphertext");
  const setCookie = start.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Path=\/api\/contracts/);
});

test("connect requires a Salesforce session", async () => {
  const res = await startConnect(req("/x", {}, { method: "POST" }), { environment: "demo", integrationKey: IK, secretKey: SK });
  assert.equal(res.status, 401);
});

test("callback: exchanges the code with the PKCE verifier, verifies the account, stores encrypted credentials", async () => {
  const { cb, ds, conn, token, body } = await connectAs(sfA);
  assert.equal(cb.status, 307);
  assert.match(cb.headers.get("location")!, /cv=docusign-settings&ds=connected$/);
  const tokenCall = ds.calls.find(c => c.url.endsWith("/oauth/token"))!;
  const verifier = new URLSearchParams(tokenCall.body).get("code_verifier")!;
  assert.equal(pkceChallenge(verifier), new URL(body.authorizeUrl).searchParams.get("code_challenge"), "the verifier matches the challenge sent to DocuSign");
  assert.ok(conn[DS_COOKIE.connection] && conn[DS_COOKIE.refresh] && token, "connection details, refresh token and access token each get their own cookie");
  for (const secret of ["ACCESS-TOKEN-SECRET", "REFRESH-TOKEN-SECRET", SK, IK]) for (const v of [...Object.values(conn), token]) assert.ok(!v.includes(secret), `${secret} not readable in cookies`);
  assert.equal(cookieOf(cb, DS_COOKIE.pending), "", "the one-time state cookie is cleared");
});

test("callback rejects a wrong state, an expired/missing attempt, another Salesforce session, and DocuSign errors", async () => {
  const start = await startConnect(req("/x", { sf_session: sfA }, { method: "POST" }), { environment: "demo", integrationKey: IK, secretKey: SK });
  const pending = cookieOf(start, DS_COOKIE.pending);
  const state = new URL((await start.json()).authorizeUrl).searchParams.get("state")!;
  const ds = fakeDocuSign();
  const loc = async (path: string, cookies: Record<string, string>) => (await completeCallback(req(path, cookies), ds.impl)).headers.get("location")!;
  assert.match(await loc(`/cb?code=C&state=WRONG`, { sf_session: sfA, [DS_COOKIE.pending]: pending }), /ds_error=STATE_MISMATCH/);
  assert.match(await loc(`/cb?code=C&state=${state}`, { sf_session: sfA }), /ds_error=CONNECT_EXPIRED/);
  assert.match(await loc(`/cb?code=C&state=${state}`, { sf_session: sfB, [DS_COOKIE.pending]: pending }), /ds_error=SESSION_MISMATCH/);
  assert.match(await loc(`/cb?code=C&state=${state}`, { [DS_COOKIE.pending]: pending }), /ds_error=SALESFORCE_SESSION_MISSING/);
  assert.match(await loc(`/cb?error=access_denied&state=${state}`, { sf_session: sfA, [DS_COOKIE.pending]: pending }), /ds_error=access_denied/);
  assert.equal(ds.calls.length, 0, "no code is ever exchanged for a rejected callback");
});

test("status: connected for the session that connected, reauthorization required for another session, never any credential", async () => {
  const { conn } = await connectAs(sfA);
  const mine = await (connectionStatus(req("/s", { sf_session: sfA, ...conn }))).json();
  assert.equal(mine.status, "connected");
  assert.equal(mine.connection.accountName, "Acme Demo");
  assert.equal(mine.connection.integrationKeyHint, "…eeee");
  const text = JSON.stringify(mine);
  for (const secret of [SK, IK, "REFRESH-TOKEN-SECRET", "ACCESS-TOKEN-SECRET"]) assert.ok(!text.includes(secret));
  assert.equal((await connectionStatus(req("/s", { sf_session: sfB, ...conn })).json()).status, "reauthorization_required");
  assert.equal((await connectionStatus(req("/s", { sf_session: sfA })).json()).status, "not_connected");
});

test("route gate: no connection → 409; another session's connection → 409; expired refresh → 401 and the token cookie is cleared", async () => {
  const run = async () => ({ ok: true });
  assert.equal((await docuSignRoute(req("/r", { sf_session: sfA }), {}, run)).status, 409);
  const { conn } = await connectAs(sfA);
  const other = await docuSignRoute(req("/r", { sf_session: sfB, ...conn }), {}, run);
  assert.equal((await other.json()).code, "DOCUSIGN_REAUTHORIZATION_REQUIRED");
  const expired = await docuSignRoute(req("/r", { sf_session: sfA, ...conn }), { fetchImpl: fakeDocuSign({ refresh: "invalid_grant" }).impl }, async ({ api }) => { await api.json("GET", "/envelopes/x"); return {}; });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).code, "DOCUSIGN_CONNECTION_EXPIRED");
  assert.equal(cookieOf(expired, DS_COOKIE.token), "");
  assert.equal((await docuSignRoute(req("/r", {}), {}, run)).status, 401, "no Salesforce session → 401");
});

test("route gate: a valid cached token is used without refreshing", async () => {
  const { conn, token } = await connectAs(sfA);
  const ds = fakeDocuSign();
  const res = await docuSignRoute(req("/r", { sf_session: sfA, ...conn, [DS_COOKIE.token]: token }), { fetchImpl: ds.impl }, async ({ api }) => ({ account: await api.json("GET", "") }));
  assert.equal(res.status, 200);
  assert.equal(ds.calls.filter(c => c.url.endsWith("/oauth/token")).length, 0);
});

test("Test Connection reports each check; an expired connection says so", async () => {
  const { conn } = await connectAs(sfA);
  const ok = await (await verifyConnection(req("/v", { sf_session: sfA, ...conn }, { method: "POST" }), fakeDocuSign().impl)).json();
  assert.equal(ok.success, true);
  assert.deepEqual(ok.checks.map((c: { id: string; ok: boolean }) => [c.id, c.ok]), [["oauth", true], ["token", true], ["identity", true], ["account", true], ["baseUri", true], ["esignature", true]]);
  const bad = await verifyConnection(req("/v", { sf_session: sfA, ...conn }, { method: "POST" }), fakeDocuSign({ refresh: "invalid_grant" }).impl);
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).status, "expired");
});

test("disconnect deletes every DocuSign cookie", async () => {
  const res = disconnect(req("/d", { sf_session: sfA }, { method: "POST" }));
  for (const name of Object.values(DS_COOKIE)) assert.equal(cookieOf(res, name), "");
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/i);
});

test("documents: only files linked to THIS contract can be sent; signed copies aren't offered again", async () => {
  const CONTRACT = "800A0000000001AAA";
  const sf = {
    query: async (soql: string) => {
      if (soql.includes("FROM ContentDocumentLink")) return { records: soql.includes(CONTRACT) ? [{ ContentDocumentId: "069A" }, { ContentDocumentId: "069B" }] : [] };
      return { records: [
        { Id: "068000000000001AAA", ContentDocumentId: "069A", Title: "MSA", FileExtension: "pdf", ContentSize: 1000, CreatedDate: "2026-11-01", VersionNumber: "1", IsLatest: true, Description: "Generated from template: MSA" },
        { Id: "068000000000002AAA", ContentDocumentId: "069B", Title: "MSA - Signed", FileExtension: "pdf", ContentSize: 900, CreatedDate: "2026-11-02", VersionNumber: "1", IsLatest: true, Description: signedFileDescription({ kind: "signed", envelopeId: "11111111-aaaa-bbbb-cccc-000000000001", documentId: "1" }) },
      ] };
    },
    getBinary: async () => ({ buffer: Buffer.from("%PDF-1.7"), contentType: "application/pdf" }),
  } as unknown as SalesforceClient;
  assert.deepEqual((await listSignableDocuments(sf, CONTRACT)).map(d => d.title), ["MSA"]);
  const docs = await loadDocumentsForSending(sf, CONTRACT, ["068000000000001AAA"]);
  assert.equal(docs[0].base64, Buffer.from("%PDF-1.7").toString("base64"));
  await assert.rejects(loadDocumentsForSending(sf, CONTRACT, ["068000000000099AAA"]), /isn't attached to this contract/);
  await assert.rejects(loadDocumentsForSending(sf, "800A0000000009AAA", ["068000000000001AAA"]), /isn't attached to this contract/, "another contract's file is refused");
});
