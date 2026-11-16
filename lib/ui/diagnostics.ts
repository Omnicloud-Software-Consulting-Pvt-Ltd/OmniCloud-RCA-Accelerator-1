/**
 * Which "warnings" may be hidden behind "View Warnings & Diagnostics", and which must stay on screen.
 *
 * Many workflows report outcome problems through their warnings list rather than as errors — e.g. a Pricing Procedure that was
 * created but "Could not activate the Expression Set Version … It remains in Draft", "Schedule activation failed", or an
 * activation "read-back did not confirm". Those tell the user the record is NOT in the state they asked for, so they are never
 * hidden. Everything else (discovery/preflight diagnostics, explanatory notes, "diagnostic-only" messages) is secondary.
 */

/** A failure / non-confirmation wording… */
const FAILURE = /\b(could not|couldn't|cannot|can't|failed|failure|did not confirm|not confirmed|was not|were not|NOT|remains? in draft|rejected|may reject)\b/i;
/** …about the record's creation, saving, activation or deployment. */
const OUTCOME = /(activat|creat|\bsav(e|ed|ing)\b|deploy|\bdraft\b|reject)/i;
/** Explicitly self-described as diagnostic-only — safe to hide even when it mentions a failure. */
const DIAGNOSTIC_ONLY = /diagnostic/i;

/** True when a warning reports that creation/save/activation/deployment did not (or may not) happen — keep it visible. */
export function isBlockingWarning(text: string): boolean {
  return FAILURE.test(text) && OUTCOME.test(text) && !DIAGNOSTIC_ONLY.test(text);
}

export function splitWarnings<T>(warnings: ReadonlyArray<T>): { visible: T[]; hidden: T[] } {
  const visible: T[] = [], hidden: T[] = [];
  for (const w of warnings) (typeof w === "string" && isBlockingWarning(w) ? visible : hidden).push(w);
  return { visible, hidden };
}
