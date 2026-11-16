import type { TaxRateReference } from "@/lib/taxLibrary/types";

/**
 * Global Tax Rate Library persistence — REFERENCE DATA + USER OVERLAY.
 *
 *  · Reference data (bundled official datasets, see reference.ts) is passed in as `base` and is never written to storage, so it
 *    can't exceed the browser quota, can't be lost by clearing site data, and a dataset release updates every browser at once.
 *  · Browser localStorage holds only the user's own work: records they created, and reference records they edited, versioned,
 *    duplicated or archived (stored under the same stable id, so the user's copy wins over the reference copy).
 *  · Writes are revision-checked: a save from a stale tab is refused (reload, then retry) instead of silently overwriting.
 *  · Not scoped to a Salesforce org; holds no Salesforce Ids and no credentials. A server store (shared across users) can replace
 *    this class behind the same interface — see the architecture notes in the coverage panel.
 */
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const TAX_LIBRARY_KEY = "omnicloud_tax_rate_library_v2";
/** v1 stored full copies of every record (incl. bundled data). Only user-authored records are migrated from it; it is left untouched. */
export const LEGACY_TAX_LIBRARY_KEY = "omnicloud_tax_rate_library_v1";
export const TAX_LIBRARY_EVENT = "omnicloud:tax-rate-library-changed";

interface Persisted { v: 2; revision: number; records: TaxRateReference[] }

function defaultStorage(): KeyValueStorage | null {
  try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

const same = (a: TaxRateReference, b: TaxRateReference) => JSON.stringify(a) === JSON.stringify(b);

export class TaxLibraryStore {
  private readonly baseById: Map<string, TaxRateReference>;
  constructor(private readonly storage: KeyValueStorage | null = defaultStorage(), private readonly base: TaxRateReference[] = []) {
    this.baseById = new Map(base.map(r => [r.id, r]));
  }

  get available(): boolean { return !!this.storage; }

  private read(): Persisted {
    const empty: Persisted = { v: 2, revision: 0, records: [] };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(TAX_LIBRARY_KEY);
      if (raw) { const p = JSON.parse(raw) as Persisted; return Array.isArray(p.records) ? { v: 2, revision: p.revision ?? 0, records: p.records } : empty; }
      // One-time migration: keep what the user authored in v1 (bundled/seeded copies are now served from the reference data).
      const legacy = this.storage.getItem(LEGACY_TAX_LIBRARY_KEY);
      if (!legacy) return empty;
      const old = JSON.parse(legacy) as { records?: TaxRateReference[] };
      const mine = (old.records ?? []).filter(r => r.origin === "user" || r.origin?.startsWith("import:"));
      return { v: 2, revision: 0, records: mine };
    } catch { return empty; }
  }

  /** Reference records merged with the user's overlay (the user's copy of a reference record replaces it). */
  load(): { records: TaxRateReference[]; revision: number; userRecords: number } {
    const p = this.read();
    const overlay = new Map(p.records.map(r => [r.id, r]));
    const merged = [...this.base.map(r => overlay.get(r.id) ?? r), ...p.records.filter(r => !this.baseById.has(r.id))];
    return { records: merged, revision: p.revision, userRecords: p.records.length };
  }

  /** Persists only records that differ from the reference data (new, edited, versioned, archived). */
  save(records: TaxRateReference[], expectedRevision: number): { ok: true; revision: number } | { ok: false; error: string } {
    if (!this.storage) return { ok: false, error: "Browser storage isn't available here, so your changes can't be saved." };
    const cur = this.read();
    if (cur.revision !== expectedRevision) return { ok: false, error: "The library changed in another tab or window. Refresh, then repeat your change." };
    const overlay = records.filter(r => { const b = this.baseById.get(r.id); return !b || !same(b, r); });
    const next: Persisted = { v: 2, revision: cur.revision + 1, records: overlay };
    try {
      // Defence in depth: strip anything token-like, whatever a caller put on a record.
      this.storage.setItem(TAX_LIBRARY_KEY, JSON.stringify(next, (k, v) => (/^(accessToken|refreshToken|sessionId|authorization|clientSecret)$/i.test(k) ? undefined : v)));
      if (typeof window !== "undefined") window.dispatchEvent(new Event(TAX_LIBRARY_EVENT));
      return { ok: true, revision: next.revision };
    } catch (e) {
      return { ok: false, error: `Couldn't save your changes (${e instanceof Error ? e.message : "storage full or blocked"}).` };
    }
  }
}
