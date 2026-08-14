/**
 * Bulk-import size limits — split out of fileParsing.ts so client components
 * (upload UI copy, file-preview pagination) can read these two numbers
 * without pulling in fileParsing.ts's `papaparse`/`xlsx`/`Buffer` usage,
 * which is server-only (Buffer isn't available in the browser).
 * fileParsing.ts re-exports both for existing/backward-compatible imports.
 */
export const IMPORT_MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — generous for a bulk import CSV/Excel, small enough to parse synchronously.
export const IMPORT_MAX_ROWS = 1000;
