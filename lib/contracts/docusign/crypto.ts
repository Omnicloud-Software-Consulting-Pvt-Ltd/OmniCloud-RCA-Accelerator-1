import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encryption for DocuSign credentials at rest (AES-256-GCM). The key comes ONLY from the server environment
 * (DOCUSIGN_ENCRYPTION_KEY: 32 bytes as base64 or 64 hex chars). There is no fallback key: without it the integration is
 * disabled rather than storing secrets unencrypted.
 *
 * Every sealed value is bound to a `purpose` (authenticated as AAD), so a value sealed for one cookie can't be replayed as another.
 */

export const ENCRYPTION_KEY_ENV = "DOCUSIGN_ENCRYPTION_KEY";

/** Trims whitespace/newlines and one pair of matching surrounding quotes (hosting portals sometimes keep them literally). */
export function normalizeKeyText(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  return /^(["'])(.*)\1$/.test(s) ? s.slice(1, -1).trim() : s;
}

export function loadEncryptionKey(raw: string | undefined = process.env[ENCRYPTION_KEY_ENV]): Buffer | null {
  const s = normalizeKeyText(raw);
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf : null;
}

export type EncryptionKeyState = "ok" | "missing" | "invalid";

/** Whether the server's key is usable — never the key itself. The app never generates or persists a key on its own. */
export function encryptionKeyState(raw: string | undefined = process.env[ENCRYPTION_KEY_ENV]): EncryptionKeyState {
  if (!normalizeKeyText(raw)) return "missing";
  return loadEncryptionKey(raw) ? "ok" : "invalid";
}

export const KEY_GENERATION_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

export function seal(value: unknown, key: Buffer, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Null for anything missing, malformed, tampered with, sealed for another purpose, or sealed with another key. */
export function unseal<T>(token: string | undefined | null, key: Buffer, purpose: string): T | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const pt = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Constant-time string comparison (false on any length difference). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** RFC 7636 S256 code challenge. */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** One-way digest of the Salesforce session scope (org instance + session digest) a DocuSign connection is bound to. */
export const sessionBinding = (salesforceCacheScope: string) => createHash("sha256").update(`docusign-binding:${salesforceCacheScope}`).digest("base64url");
