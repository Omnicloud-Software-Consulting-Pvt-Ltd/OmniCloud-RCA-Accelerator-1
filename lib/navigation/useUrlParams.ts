"use client";

import { useCallback, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";

/**
 * Shared query-string state sync for the single-route /data app shell.
 * `read` looks at the most recent params this hook itself wrote (falling
 * back to the live URL) so several patches issued in the same event handler
 * compose instead of racing a browser/router URL update that hasn't
 * committed yet. `update` merges a patch into the current params and does
 * one router.replace — callers should batch related key changes into a
 * single update() call rather than calling it repeatedly.
 */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const paramsRef = useRef<URLSearchParams | null>(null);

  const current = useCallback((): URLSearchParams => {
    if (paramsRef.current) return paramsRef.current;
    if (typeof window === "undefined") return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  const read = useCallback((key: string): string | null => current().get(key), [current]);

  const update = useCallback((patch: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(current());
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    paramsRef.current = params;
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [current, pathname, router]);

  return { read, update };
}
