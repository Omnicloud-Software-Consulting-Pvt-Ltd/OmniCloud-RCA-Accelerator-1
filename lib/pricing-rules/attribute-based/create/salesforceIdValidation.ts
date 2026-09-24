/**
 * §TBP-20260923-210132-FAD5 — Part 4: fail-closed pre-deployment validation for fabricated/invalid
 * Salesforce reference Ids. Live failure: "We couldn't find a record with the ID: U#190f.3fffffff
 * (ExpressionSetDefinitionVersion)." — Salesforce rejected a reference embedded in the deployed metadata
 * because it isn't a real, resolvable record Id.
 *
 * §Investigated, not guessed — an Explore-agent sweep of this entire repository (deploy.ts, activation.ts,
 * verifySalesforceState.ts, soapEnvelope.ts, canvasBuilder.ts, versionEnvelopeFields.ts, every hash/random-
 * id generator in lib/) found the literal string "U#190f.3fffffff" nowhere in source, and confirmed every
 * Id-resolution path in this codebase already fails closed with `null` rather than fabricating a
 * placeholder. The most likely origin is the donor's OWN internal ExpressionSetVersion/definition-version
 * reference surviving verbatim into a newly-generated version — the ENVELOPE region (`<versions>`, outside
 * `<steps>`) was never Id-stripped by any pass before this fix (see canvasBuilder.ts's new
 * `envelopeBeforeIdFree`/`envelopeAfterIdFree`), so a donor-specific reference that isn't a plain
 * 15/18-char Salesforce Id (and therefore didn't match that narrow stripping pattern either) could reach
 * deployment untouched. This module is the LAST LINE OF DEFENSE regardless of exact origin: it never tries
 * to guess which single tag is "the" offending one — it scans every field whose NAME indicates it is a
 * Salesforce reference (ends in "Id", or is exactly "id") and asserts its value is either absent, a real
 * Salesforce Id, or one of this pipeline's own known-safe non-Id runtime binding literals.
 *
 * §Field-aware, not string-blind — per the explicit instruction "Use field-aware validation rather than
 * blindly rejecting every occurrence of 'U#'": a bare "#" or "U#" appearing in, say, a product NAME or a
 * label would never be flagged — only values inside a tag whose name is itself an identifier/reference
 * field are ever inspected.
 */

/** A real Salesforce record Id — exactly 15 or 18 alphanumeric characters, nothing else. */
const REAL_SALESFORCE_ID = /^[0-9A-Za-z]{15,18}$/;

/**
 * Runtime-binding literal values this pipeline itself deliberately writes into an "...Id"-named
 * `<parameters>` field as a `type="Parameter"` binding NAME (not a raw Salesforce Id) — e.g.
 * `PriceAdjustmentScheduleId`'s value is forced to the literal string "PriceAdjustmentSchedule" (the
 * runtime context variable this pipeline binds the freshly-created Schedule to), never a hardcoded Id. Any
 * value in this allowlist is legitimate non-Id content in an Id-named field, evidenced directly from
 * canvasBuilder.ts's own patch logic — never an arbitrary exemption.
 */
const KNOWN_SAFE_NON_ID_BINDING_VALUES = new Set(["PriceAdjustmentSchedule"]);

/** Tag names this scan treats as "Salesforce reference fields" — ends in "Id" (case-sensitive, matching
 * this codebase's own naming convention: LookUpId, PriceAdjustmentScheduleId, expressionSetId, ...) or is
 * exactly "id" (the generic record-Id tag every cloned metadata element may carry). */
function isReferenceFieldTagName(tagName: string): boolean {
  return tagName === "id" || /Id$/.test(tagName);
}

export interface InvalidSalesforceReferenceViolation {
  field: string;
  value: string;
  /** The full open+close tag text this value was found in — enough context to locate it in the source XML without re-scanning. */
  xmlFragment: string;
  /** Nearest enclosing `<name>...</name>` sibling value, when findable — helps identify WHICH parameter/step this reference belongs to. */
  nearbyName: string | null;
}

export interface InvalidSalesforceReferenceScanResult {
  ok: boolean;
  violations: InvalidSalesforceReferenceViolation[];
  reportText: string;
}

const REFERENCE_TAG_RE = /<([A-Za-z][\w]*(?:Id|id))>([^<]*)<\/\1>/g;

/**
 * Scans the FINAL, fully-assembled Expression Set XML for any Salesforce-reference-shaped field whose
 * value is neither empty, a real Salesforce Id, nor a known-safe non-Id binding literal. Never mutates the
 * XML — read-only, pre-deployment gate only. `errorCode` on a violation is always
 * `INVALID_SALESFORCE_REFERENCE_ID` (surfaced by the caller, not embedded here, so callers can format it
 * however their own failure-reporting convention requires).
 */
export function scanForInvalidSalesforceReferenceIds(finalXml: string): InvalidSalesforceReferenceScanResult {
  const violations: InvalidSalesforceReferenceViolation[] = [];
  let match: RegExpExecArray | null;
  REFERENCE_TAG_RE.lastIndex = 0;
  while ((match = REFERENCE_TAG_RE.exec(finalXml))) {
    const [xmlFragment, tagName, rawValue] = match;
    const value = rawValue.trim();
    if (!isReferenceFieldTagName(tagName)) continue;
    if (value === "") continue;
    if (REAL_SALESFORCE_ID.test(value)) continue;
    if (KNOWN_SAFE_NON_ID_BINDING_VALUES.has(value)) continue;

    const precedingText = finalXml.slice(Math.max(0, match.index - 400), match.index);
    const nameMatch = [...precedingText.matchAll(/<name>([^<]*)<\/name>/g)].pop();
    violations.push({ field: tagName, value, xmlFragment, nearbyName: nameMatch ? nameMatch[1] : null });
  }

  const reportText = violations.length === 0
    ? "Salesforce Reference Validation: PASS — every *Id/id field in the final metadata is either empty, a real Salesforce Id, or a known-safe runtime binding literal."
    : [
      "Salesforce Reference Validation: FAIL",
      `${violations.length} invalid Salesforce reference value(s) found:`,
      ...violations.flatMap(v => [
        `  Field: ${v.field}`,
        `  Value: "${v.value}"`,
        `  Nearby <name>: ${v.nearbyName ?? "(not found within 400 chars preceding)"}`,
        `  XML fragment: ${v.xmlFragment}`,
        "",
      ]),
    ].join("\n");

  return { ok: violations.length === 0, violations, reportText };
}
