import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEntry, dedupeKey, formatRelative, HISTORY_LIMIT, HISTORY_MAX_AGE_MS, isDuplicate, objectLabel, parseHistory,
  prune, sanitizeText, storageKey, TOAST_LIFETIME_MS, unreadCount, type NotificationEntry,
} from "@/lib/notifications/history";

const entry = (id: string, at: number, extra: Partial<NotificationEntry> = {}): NotificationEntry =>
  ({ id, tone: "success", title: "Product Created Successfully", message: "Laptop", module: "Product", recordCount: 1, at, read: false, ...extra });

test("Toast lifetime is a fixed 10 seconds", () => {
  assert.equal(TOAST_LIFETIME_MS, 10_000);
});

test("Duplicate guard — one operation reported twice is one notification; later repeats are new ones", () => {
  const recent = new Map<string, number>();
  const k = dedupeKey("success", "Order Activated", "Order 00000149 activated");
  assert.equal(isDuplicate(recent, k, 1_000), false);
  assert.equal(isDuplicate(recent, k, 1_800), true);
  assert.equal(isDuplicate(recent, dedupeKey("error", "Order Activated", "Order 00000149 activated"), 1_900), false, "different tone is distinct");
  assert.equal(isDuplicate(recent, k, 10_000), false, "same text much later is a new operation");
});

test("History — newest first, capped, expired entries dropped, Clear All is an empty list", () => {
  const now = Date.now();
  let h: NotificationEntry[] = [];
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = addEntry(h, entry(`n${i}`, now - (HISTORY_LIMIT + 5 - i)));
  assert.equal(h.length, HISTORY_LIMIT);
  assert.equal(h[0].id, `n${HISTORY_LIMIT + 4}`);
  assert.deepEqual(prune([entry("old", now - HISTORY_MAX_AGE_MS - 1), entry("new", now)], now).map(e => e.id), ["new"]);
  assert.equal(unreadCount([entry("a", now), entry("b", now, { read: true }), entry("c", now)]), 2);
  assert.equal(unreadCount([]), 0);
});

test("Sanitising — tokens, session ids and JWTs never reach stored history", () => {
  const s = sanitizeText("Failed: Bearer abc.def-123 access_token=xyz sid 00D5g000004XyZq!AQ0AQ.secret eyJhbGciOi.eyJzdWIiOi.sig");
  assert.doesNotMatch(s, /abc\.def|xyz|AQ0AQ|eyJhbGciOi/);
  assert.match(s, /\[redacted\]/);
  assert.equal(sanitizeText("x".repeat(1000)).length, 400);
  assert.equal(sanitizeText(undefined), "");
});

test("Storage key — scoped per connected user and org", () => {
  assert.equal(storageKey({ userId: "005A", instanceUrl: "https://acme.my.salesforce.com" }), "omni.notifications.v1:005A@acme.my.salesforce.com");
  assert.notEqual(storageKey({ userId: "005A", instanceUrl: "https://a.my.salesforce.com" }), storageKey({ userId: "005B", instanceUrl: "https://a.my.salesforce.com" }));
  assert.equal(storageKey(null), "omni.notifications.v1:anonymous");
});

test("Parsing stored history — malformed data is dropped, never thrown", () => {
  const now = Date.now();
  assert.deepEqual(parseHistory(null, now), []);
  assert.deepEqual(parseHistory("{not json", now), []);
  assert.deepEqual(parseHistory(JSON.stringify({ a: 1 }), now), []);
  const parsed = parseHistory(JSON.stringify([entry("ok", now), { id: "bad", tone: "loud", at: now }, null, { id: 3 }]), now);
  assert.deepEqual(parsed.map(e => e.id), ["ok"]);
});

test("Module labels and relative time", () => {
  assert.equal(objectLabel("Product2"), "Product");
  assert.equal(objectLabel("BillingSchedule"), "Billing Schedule");
  assert.equal(objectLabel("Ramp_Deal__c"), "Ramp Deal");
  assert.equal(objectLabel(undefined), null);
  const now = Date.now();
  assert.equal(formatRelative(now - 5_000, now), "Just now");
  assert.equal(formatRelative(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelative(now - 3 * 3_600_000, now), "3h ago");
});
