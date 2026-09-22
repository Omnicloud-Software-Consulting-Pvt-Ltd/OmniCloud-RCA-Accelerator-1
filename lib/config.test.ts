/**
 * §Corrected architecture — this app is multi-tenant: each user connects their OWN Salesforce org and
 * provides their OWN Anthropic API key via the Setup flow (stored in THEIR browser's `omnicloud_config`
 * cookie). A server-wide `ANTHROPIC_API_KEY` environment-variable fallback was briefly introduced and has
 * been REMOVED — it would have silently become a SHARED key for every user who hasn't configured their
 * own, breaking the per-user isolation this app promises. `resolveAnthropicKey` now has exactly ONE
 * source of truth: the requesting user's own config cookie. These tests prove that precedence directly
 * (no env fallback, ever), that the non-secret status diagnostic matches it exactly, and that two
 * different users' configurations never leak into each other.
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { resolveAnthropicKey, resolveAnthropicKeyStatus, encodeConfig, CONFIG_COOKIE } from "./config";

function mockRequest(cookieValue: string | undefined): NextRequest {
  return {
    cookies: { get: (name: string) => (name === CONFIG_COOKIE && cookieValue !== undefined ? { value: cookieValue } : undefined) },
  } as unknown as NextRequest;
}

const ORIGINAL_ENV_KEY = process.env.ANTHROPIC_API_KEY;

/** Proves the env var genuinely has no effect, by setting one to a value that would trivially pass any
 * test relying on it — if any test below started passing BECAUSE of this, that would itself be the bug
 * this whole turn exists to prevent. Restored after each use so this file never leaks state to others. */
function withPoisonedEnvKey<T>(fn: () => T): T {
  process.env.ANTHROPIC_API_KEY = "sk-ant-this-must-never-be-used-as-a-fallback";
  try {
    return fn();
  } finally {
    if (ORIGINAL_ENV_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV_KEY;
  }
}

/* ── Part 9, Test 1 ── */
test("Test 1 — a request whose OWN config cookie has a key: resolveAnthropicKey returns exactly that key", () => {
  const req = mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-user-a-own-key" }));
  assert.equal(resolveAnthropicKey(req), "sk-ant-user-a-own-key");
});

/* ── Part 9, Test 2 ── */
test("Test 2 — a request with no config cookie at all: resolveAnthropicKey returns null (no key), never a fallback", () => {
  const req = mockRequest(undefined);
  assert.equal(resolveAnthropicKey(req), null);
});

test("Test 2b — a request whose config cookie exists but has no anthropicApiKey field: resolveAnthropicKey returns null", () => {
  const req = mockRequest(encodeConfig({ sfClientId: "id", sfClientSecret: "secret" }));
  assert.equal(resolveAnthropicKey(req), null);
});

/* ── Part 9, Test 3/4 — no env key is required, and it is NEVER used as a fallback ── */
test("Test 3/4 — an ANTHROPIC_API_KEY environment variable is NEVER used as a fallback, even when set, whether or not a cookie is present", () => {
  withPoisonedEnvKey(() => {
    const reqNoCookie = mockRequest(undefined);
    assert.equal(resolveAnthropicKey(reqNoCookie), null, "no cookie + env var set must still resolve to null — no fallback exists");

    const reqWithCookie = mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-the-real-user-key" }));
    assert.equal(resolveAnthropicKey(reqWithCookie), "sk-ant-the-real-user-key", "the cookie's own key must be returned, never the poisoned env value");
  });
});

test("Test 3/4b — resolveAnthropicKeyStatus never reports source:'environment' — that value does not exist in this architecture's type at all", () => {
  withPoisonedEnvKey(() => {
    const status = resolveAnthropicKeyStatus(mockRequest(undefined));
    assert.deepEqual(status, { configured: false, source: "none", looksValid: false });
  });
});

/* ── Part 9, Test 5 ── */
test("Test 5 — GET-style status resolution correctly reflects THIS request's own configured key (via resolveAnthropicKeyStatus, the function GET /api/config uses)", () => {
  const configured = resolveAnthropicKeyStatus(mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-abc123" })));
  assert.deepEqual(configured, { configured: true, source: "user-config", looksValid: true });

  const unconfigured = resolveAnthropicKeyStatus(mockRequest(undefined));
  assert.deepEqual(unconfigured, { configured: false, source: "none", looksValid: false });
});

/* ── Part 9, Test 6 — multi-user isolation ── */
test("Test 6 — User A's configuration cannot be used to resolve User B's key: two independent requests (independent cookies) never see each other's key", () => {
  const userA = mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-user-a-key" }));
  const userB = mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-user-b-key" }));
  assert.equal(resolveAnthropicKey(userA), "sk-ant-user-a-key");
  assert.equal(resolveAnthropicKey(userB), "sk-ant-user-b-key");
  assert.notEqual(resolveAnthropicKey(userA), resolveAnthropicKey(userB));

  // User B has none configured at all — must never fall back to User A's, a shared default, or the env.
  const userBUnconfigured = mockRequest(undefined);
  assert.equal(resolveAnthropicKey(userBUnconfigured), null);
});

/* ── Part 9, Test 7 — diagnostics never return the actual key ── */
test("Test 7 — resolveAnthropicKeyStatus never returns the actual key value anywhere on the object, and exposes no cookie content beyond the boolean/source/format signal", () => {
  const req = mockRequest(encodeConfig({ anthropicApiKey: "sk-ant-must-not-leak-this-value" }));
  const status = resolveAnthropicKeyStatus(req);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("sk-ant-must-not-leak-this-value"), `the status object must never contain the actual key; got: ${serialized}`);
  assert.deepEqual(Object.keys(status).sort(), ["configured", "looksValid", "source"]);
});

test("resolveAnthropicKeyStatus reports looksValid:false for a malformed stored key (does not start with sk-ant-) without treating it as unconfigured", () => {
  const req = mockRequest(encodeConfig({ anthropicApiKey: "not-a-real-key-shape" }));
  const status = resolveAnthropicKeyStatus(req);
  assert.equal(status.configured, true);
  assert.equal(status.source, "user-config");
  assert.equal(status.looksValid, false);
});
