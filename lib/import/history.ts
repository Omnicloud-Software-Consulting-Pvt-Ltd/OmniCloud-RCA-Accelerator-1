/**
 * Bulk Import History — localStorage only, no Postgres/backend, shared
 * across every bulk importer (Products, Quotes, Contracts, Orders).
 * Originally Product-only (components/data/products/import/importHistory.ts,
 * which now delegates here), generalized with a `module` tag so every
 * importer's runs live in one store, filterable per module.
 */
export type ImportModule = "product" | "quote" | "contract" | "order" | "bundle" | "attribute";

export interface ImportHistoryEntry {
  id: string;
  module: ImportModule;
  fileName: string;
  importedAt: string; // ISO
  total: number;
  created: number;
  failed: number;
  skipped: number;
}

const STORAGE_KEY = "do_bulk_import_history";
const LEGACY_PRODUCT_KEY = "do_product_import_history"; // pre-existing Product-only store, migrated in once so earlier runs aren't lost
const MAX_ENTRIES = 100;

function migrateLegacyProductHistory(): void {
  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_PRODUCT_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const existingRaw = window.localStorage.getItem(STORAGE_KEY);
    const existing: ImportHistoryEntry[] = existingRaw ? (JSON.parse(existingRaw) ?? []) : [];
    const migrated: ImportHistoryEntry[] = legacy.map((e: Omit<ImportHistoryEntry, "module">) => ({ ...e, module: "product" as const }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...migrated, ...existing].slice(0, MAX_ENTRIES)));
    window.localStorage.removeItem(LEGACY_PRODUCT_KEY);
  } catch {
    // Best-effort migration — if it fails, old Product history is simply not carried forward.
  }
}

export function loadImportHistory(module?: ImportModule): ImportHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    migrateLegacyProductHistory();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const all: ImportHistoryEntry[] = Array.isArray(parsed) ? parsed : [];
    return module ? all.filter(e => e.module === module) : all;
  } catch {
    return [];
  }
}

export function saveImportHistoryEntry(entry: ImportHistoryEntry): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const existing: ImportHistoryEntry[] = raw ? (JSON.parse(raw) ?? []) : [];
    const next = [entry, ...(Array.isArray(existing) ? existing : [])].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded) — history simply won't persist this run.
  }
}
