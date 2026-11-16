import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  OAUTH_TX_MAX_AGE,
  buildAuthorizeUrl,
  decodeTransaction,
  encodeTransaction,
  loginBaseFor,
  newTransaction,
  parseEnvironment,
  pkceChallenge,
  stateMatches,
} from "./oauth";
import { authorizeErrorMessage, tokenErrorMessage } from "./oauthMessages";

test("production and Developer Edition use login.salesforce.com; sandbox uses test.salesforce.com", () => {
  assert.equal(loginBaseFor("production"), "https://login.salesforce.com");
  assert.equal(loginBaseFor("sandbox"), "https://test.salesforce.com");
  assert.equal(parseEnvironment("production"), "production");
  assert.equal(parseEnvironment("sandbox"), "sandbox");
  assert.equal(parseEnvironment("anything-else"), "sandbox");
  assert.equal(parseEnvironment(null), "sandbox");
});

test("PKCE challenge is the base64url SHA-256 of the verifier (RFC 7636 S256)", () => {
  const tx = newTransaction("sandbox");
  assert.equal(tx.challenge, createHash("sha256").update(tx.verifier).digest("base64url"));
  assert.equal(pkceChallenge(tx.verifier), tx.challenge);
  assert.ok(tx.verifier.length >= 43 && tx.verifier.length <= 128, "verifier length must be 43–128 chars");
  assert.match(tx.verifier, /^[A-Za-z0-9_-]+$/);
});

test("every sign-in attempt gets a fresh state and verifier", () => {
  const a = newTransaction("production");
  const b = newTransaction("production");
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.verifier, b.verifier);
});

test("transaction round-trips through the cookie and keeps the chosen environment", () => {
  const tx = newTransaction("production", 1_000);
  const back = decodeTransaction(encodeTransaction(tx), 2_000);
  assert.deepEqual(back, { state: tx.state, verifier: tx.verifier, environment: "production", createdAt: 1_000 });
  const stored = JSON.parse(Buffer.from(encodeTransaction(tx), "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "environment", "state", "verifier"]);
});

test("expired, missing or tampered transactions are refused", () => {
  const tx = newTransaction("sandbox", 0);
  assert.equal(decodeTransaction(encodeTransaction(tx), OAUTH_TX_MAX_AGE * 1000 + 1), null);
  assert.equal(decodeTransaction(undefined), null);
  assert.equal(decodeTransaction("not-base64-json"), null);
  assert.equal(decodeTransaction(Buffer.from(JSON.stringify({ state: 1 })).toString("base64url")), null);
});

test("state comparison only accepts the exact state this browser started", () => {
  assert.equal(stateMatches("abc123", "abc123"), true);
  assert.equal(stateMatches("abc123", "abc124"), false);
  assert.equal(stateMatches("abc123", "abc1234"), false);
  assert.equal(stateMatches("abc123", ""), false);
});

test("authorize URL targets the chosen environment with PKCE and a forced login screen", () => {
  const url = new URL(buildAuthorizeUrl({ environment: "sandbox", clientId: "3MVGclient", redirectUri: "https://rca.example.com/api/auth/callback/salesforce", state: "st", challenge: "ch" }));
  assert.equal(url.origin, "https://test.salesforce.com");
  assert.equal(url.pathname, "/services/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "3MVGclient");
  assert.equal(url.searchParams.get("redirect_uri"), "https://rca.example.com/api/auth/callback/salesforce");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "login");
  const prod = new URL(buildAuthorizeUrl({ environment: "production", clientId: "c", redirectUri: "r", state: "s", challenge: "c" }));
  assert.equal(prod.origin, "https://login.salesforce.com");
});

test("Salesforce errors become actionable messages that keep Salesforce's own text", () => {
  assert.match(authorizeErrorMessage("access_denied", "end-user denied authorization"), /cancelled/);
  assert.match(authorizeErrorMessage("OAUTH_APP_BLOCKED", "this app is blocked by admin"), /admin/);
  assert.match(authorizeErrorMessage("server_error", "something odd"), /something odd/);
  assert.match(tokenErrorMessage("invalid_client_id", "client identifier invalid", "x"), /Client ID/);
  assert.match(tokenErrorMessage("invalid_client", "invalid client credentials", "x"), /Client Secret/);
  assert.match(tokenErrorMessage("redirect_uri_mismatch", "redirect_uri must match configuration", "https://app/cb"), /https:\/\/app\/cb/);
  assert.match(tokenErrorMessage("invalid_grant", "expired authorization code", "x"), /expired or was already used/);
  assert.match(tokenErrorMessage("invalid_grant", "authentication failure", "x"), /authentication failure/);
});
