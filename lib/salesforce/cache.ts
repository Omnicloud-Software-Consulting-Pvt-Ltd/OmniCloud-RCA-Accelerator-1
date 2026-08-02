/**
 * Generic TTL cache factory shared by every metadata/describe resolver.
 * Keyed by an arbitrary string (callers key by instance URL, or
 * `${instanceUrl}:${sobject}` for per-object caches) so results never leak
 * across orgs. Failed lookups are never cached — callers must only call
 * `set()` after a successful resolution, so a transient describe failure
 * is retried on the next call instead of poisoning the cache.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TTLCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  getOrCompute(key: string, compute: () => Promise<T>): Promise<T>;
  clear(key?: string): void;
}

export const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createTTLCache<T>(ttlMs: number = DEFAULT_TTL_MS): TTLCache<T> {
  const store = new Map<string, CacheEntry<T>>();

  function get(key: string): T | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: T): void {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async function getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = get(key);
    if (cached !== undefined) return cached;
    // Never cache a failed compute — let it throw straight through so the
    // next call retries instead of being poisoned by a transient failure.
    const value = await compute();
    set(key, value);
    return value;
  }

  function clear(key?: string): void {
    if (key) store.delete(key);
    else store.clear();
  }

  return { get, set, getOrCompute, clear };
}
