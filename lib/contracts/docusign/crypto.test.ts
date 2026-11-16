/** DocuSign credential encryption + PKCE — pure, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadEncryptionKey, pkceChallenge, safeEqual, seal, sessionBinding, unseal } from "./crypto";

const key = randomBytes(32);

test("encryption key: accepts 32-byte base64 / base64url / hex, rejects everything else (no fallback key)", () => {
  assert.equal(loadEncryptionKey(key.toString("base64"))?.equals(key), true);
  assert.equal(loadEncryptionKey(key.toString("base64url"))?.equals(key), true);
  assert.equal(loadEncryptionKey(key.toString("hex"))?.equals(key), true);
  assert.equal(loadEncryptionKey(undefined), null);
  assert.equal(loadEncryptionKey(""), null);
  assert.equal(loadEncryptionKey(randomBytes(16).toString("base64")), null);
  assert.equal(loadEncryptionKey("not a key!!"), null);
});

test("seal/unseal round-trips and the ciphertext doesn't contain the secret", () => {
  const secret = { refreshToken: "eyJ0eXAiOiJNVCIsImFsZyI6IlJTMjU2In0.SECRET-REFRESH", secretKey: "11111111-2222-3333-4444-555555555555" };
  const sealed = seal(secret, key, "p");
  assert.ok(!sealed.includes("SECRET-REFRESH") && !sealed.includes("11111111-2222"));
  assert.deepEqual(unseal(sealed, key, "p"), secret);
});

test("unseal rejects tampering, another purpose, another key and garbage", () => {
  const sealed = seal({ a: 1 }, key, "connection");
  const parts = sealed.split(".");
  const flipped = parts[3][0] === "A" ? "B" : "A";
  assert.equal(unseal([parts[0], parts[1], parts[2], flipped + parts[3].slice(1)].join("."), key, "connection"), null);
  assert.equal(unseal(sealed, key, "token"), null, "a value sealed for one cookie can't be replayed as another");
  assert.equal(unseal(sealed, randomBytes(32), "connection"), null);
  assert.equal(unseal("v1.x.y.z", key, "connection"), null);
  assert.equal(unseal(undefined, key, "connection"), null);
});

test("PKCE S256 matches the RFC 7636 example", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("safeEqual and session binding", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(sessionBinding("https://a.my.salesforce.com#1"), sessionBinding("https://a.my.salesforce.com#1"));
  assert.notEqual(sessionBinding("https://a.my.salesforce.com#1"), sessionBinding("https://a.my.salesforce.com#2"));
});

test("key normalization: surrounding quotes and whitespace/newlines are ignored; anything else is still rejected", () => {
  const b64 = key.toString("base64");
  for (const v of [`"${b64}"`, `'${b64}'`, `  ${b64}\r\n`, `"${key.toString("hex")}"`]) assert.equal(loadEncryptionKey(v)?.equals(key), true, JSON.stringify(v.slice(0, 3)));
  for (const v of [`"${b64}'`, `${b64.slice(0, 20)} ${b64.slice(20)}`, '""', "''"]) assert.equal(loadEncryptionKey(v), null);
});
