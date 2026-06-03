import type { SessionData } from "./types";

const SESSION_KEY = "omnicloud_sf_session";

export function saveSession(data: SessionData): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {}
}

export function loadSession(): SessionData | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data: SessionData = JSON.parse(raw);
    if (Date.now() > data.expiresAt) {
      clearSession();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}
