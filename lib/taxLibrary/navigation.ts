/**
 * Global Tax Rate Library page — a view of the Taxes workspace (like every /data screen), addressed by URL parameters so the app
 * shell, sidebar, breadcrumbs and refresh/deep-link restore work:  /data?module=taxes-rates&tm=tax-rates&tv=rate-library.
 * The friendly path /data/tax-rate-library redirects there.
 */
export const RATE_LIBRARY_VIEW = "rate-library";
export const RATE_LIBRARY_MODULE = "tax-rates";
export const RATE_LIBRARY_PATH = "/data/tax-rate-library";
export const RATE_LIBRARY_TITLE = "Global Tax Rate Library";
export const RATE_LIBRARY_DESCRIPTION = "Browse, maintain, and reuse tax rates across countries and jurisdictions.";

export function rateLibraryDataUrl(): string {
  return `/data?${new URLSearchParams({ module: "taxes-rates", tm: RATE_LIBRARY_MODULE, tv: RATE_LIBRARY_VIEW }).toString()}`;
}

/** What "Use This Rate" hands to the existing Create Tax Rate form (plain data — the workspace renders the notice). */
export interface RateLibraryPrefill {
  fields: Record<string, string | number>;
  references: Record<string, { id: string; name: string; sobject: string; moduleKey?: string | null }>;
  notices: string[];
  warnings: string[];
  summary: string;
}
