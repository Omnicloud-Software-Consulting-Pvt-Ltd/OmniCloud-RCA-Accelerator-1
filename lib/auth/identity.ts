import type { IdentityData } from "./types";

/**
 * App-level identity (the signed-in Omnicloud team member) and first-run
 * setup state. Both are stored client-side for Phase A routing gates.
 *
 * - Identity answers "is someone signed in?" (Phase A: dev stub; Phase B: Entra).
 * - The setup flag answers "has the mandatory first-run setup wizard been
 *   completed?" The actual secrets (Anthropic key, Salesforce token) live in
 *   httpOnly cookies; this flag is only a synchronous hint for route gating.
 */

const IDENTITY_KEY = "omnicloud_identity";
const SETUP_KEY = "omnicloud_setup_complete";

export function saveIdentity(data: IdentityData): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(data));
  } catch {}
}

export function loadIdentity(): IdentityData | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IdentityData;
  } catch {
    return null;
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {}
}

export function markSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_KEY, "1");
  } catch {}
}

export function isSetupComplete(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSetup(): void {
  try {
    localStorage.removeItem(SETUP_KEY);
  } catch {}
}
