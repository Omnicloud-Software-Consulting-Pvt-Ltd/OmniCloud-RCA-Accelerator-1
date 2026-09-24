/**
 * Generic TTL cache factory shared by every metadata/describe resolver, and
 * (§REQUEST_LIMIT_EXCEEDED remediation) every dashboard statistics endpoint.
 * Keyed by an arbitrary string (callers key by instance URL, or
 * `${instanceUrl}:${sobject}` for per-object caches) so results never leak
 * across orgs. Failed lookups are never cached — callers must only call
 * `set()` after a successful resolution, so a transient describe failure
 * is retried on the next call instead of poisoning the cache.
 *
 * §In-flight de-duplication: `getOrCompute` also coalesces CONCURRENT calls
 * for the same key into a single `compute()` invocation — this was
 * previously re-implemented ad hoc per call site wherever it mattered (e.g.
 * `configureCache`/`configureInFlight` in
 * app/api/quotes/products/configure/route.ts, a separate Map layered on top
 * of an earlier version of this same cache specifically because it lacked
 * this). Built into the primitive instead, every existing and future
 * consumer gets it for free: three dashboard widgets requesting identical
 * statistics while the first request is still in flight now share ONE
 * Salesforce round trip instead of firing three, without any caller having
 * to know or care.
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
  /** Debug Mode / diagnostics only — never used for correctness. `undefined` when this key has never been looked up. */
  peekStatus(key: string): "hit" | "miss-computed" | "miss-in-flight" | undefined;
}

export const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createTTLCache<T>(ttlMs: number = DEFAULT_TTL_MS): TTLCache<T> {
  const store = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();
  // Debug-only, last-observed outcome per key — deliberately not part of the
  // correctness path (nothing reads it to decide behavior), only surfaced
  // by callers that want to log a HIT/MISS/IN-FLIGHT line for Debug Mode.
  const lastStatus = new Map<string, "hit" | "miss-computed" | "miss-in-flight">();

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
    if (cached !== undefined) {
      lastStatus.set(key, "hit");
      return cached;
    }

    const existingInFlight = inFlight.get(key);
    if (existingInFlight) {
      lastStatus.set(key, "miss-in-flight");
      return existingInFlight;
    }

    lastStatus.set(key, "miss-computed");
    // Never cache a failed compute — let it throw straight through so the
    // next call retries instead of being poisoned by a transient failure.
    // The in-flight entry is removed in both the success and failure paths
    // so a rejected compute doesn't wedge every subsequent call for this key
    // behind a dead promise.
    const promise = compute()
      .then(value => {
        set(key, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  function clear(key?: string): void {
    if (key) {
      store.delete(key);
      inFlight.delete(key);
      lastStatus.delete(key);
    } else {
      store.clear();
      inFlight.clear();
      lastStatus.clear();
    }
  }

  function peekStatus(key: string): "hit" | "miss-computed" | "miss-in-flight" | undefined {
    return lastStatus.get(key);
  }

  return { get, set, getOrCompute, clear, peekStatus };
}
