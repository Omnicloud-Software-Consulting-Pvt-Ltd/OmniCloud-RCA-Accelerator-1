import { test } from "node:test";
import assert from "node:assert/strict";
import { SalesforceClient } from "./client";
import { createTTLCache } from "./cache";

const ORG_A = "https://org-a.my.salesforce.com";
const ORG_B = "https://org-b.my.salesforce.com";

test("two orgs never share a cache scope", () => {
  const a = new SalesforceClient(ORG_A, "token-1");
  const b = new SalesforceClient(ORG_B, "token-1");
  assert.notEqual(a.cacheScope, b.cacheScope);
  assert.ok(a.cacheScope.startsWith(ORG_A + "#"));
});

test("two users (sessions) of the same org get different scopes", () => {
  const u1 = new SalesforceClient(ORG_A, "access-user-1");
  const u2 = new SalesforceClient(ORG_A, "access-user-2");
  assert.notEqual(u1.cacheScope, u2.cacheScope);
});

test("the same session keeps its scope across access-token refreshes (keyed by refresh token)", () => {
  const refresh = { refreshToken: "refresh-1", clientId: "cid", clientSecret: "", loginBase: "https://login.salesforce.com" };
  const before = new SalesforceClient(ORG_A, "access-old", undefined, refresh);
  const after = new SalesforceClient(ORG_A, "access-new", undefined, refresh);
  assert.equal(before.cacheScope, after.cacheScope);
});

test("the scope never contains a token", () => {
  const c = new SalesforceClient(ORG_A, "SECRET-ACCESS", undefined, { refreshToken: "SECRET-REFRESH", clientId: "cid", clientSecret: "", loginBase: "https://login.salesforce.com" });
  assert.ok(!c.cacheScope.includes("SECRET"));
});

test("a TTL cache keyed by cacheScope isolates orgs and users", async () => {
  const cache = createTTLCache<string>(60_000);
  const a1 = new SalesforceClient(ORG_A, "user-1");
  const a2 = new SalesforceClient(ORG_A, "user-2");
  const b1 = new SalesforceClient(ORG_B, "user-1");
  assert.equal(await cache.getOrCompute(a1.cacheScope, async () => "A/user-1"), "A/user-1");
  assert.equal(await cache.getOrCompute(a2.cacheScope, async () => "A/user-2"), "A/user-2");
  assert.equal(await cache.getOrCompute(b1.cacheScope, async () => "B/user-1"), "B/user-1");
  assert.equal(cache.get(a1.cacheScope), "A/user-1");
  cache.clear();
  assert.equal(cache.get(a1.cacheScope), undefined);
});
