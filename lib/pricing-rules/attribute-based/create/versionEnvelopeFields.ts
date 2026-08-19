/**
 * §Part 17 regression coverage — the ExpressionSetVersion envelope's own `<versionNumber>`/`<rank>`
 * field injection, extracted as a standalone pure function so the exact reported bug ("donor has
 * <rank>1</rank>, resolved candidate is 3, but the outbound XML still carries 1") is directly
 * unit-testable without needing a full donor-XML/SalesforceClient mock. Called by `canvasBuilder.ts`'s
 * `buildAttributeCanvas` — never changes any OTHER envelope tag (label/description/fullName/
 * developerName/name/expressionSetDefinition remain regenerated inline in `canvasBuilder.ts`, untouched
 * by this extraction).
 *
 * The resolved candidate (`versionNumber`/`rank`) is the SINGLE source of truth — this never reads or
 * preserves the donor's own `<rank>`/`<versionNumber>` values; a donor value survives only when the
 * caller passes `undefined`/`null` for that field (meaning no resolution ran at all), never as a silent
 * fallback when a real resolved value exists.
 */

export interface VersionNumberAndRankCandidate {
  /** Undefined — never touch `<versionNumber>` at all (no resolution ran). */
  versionNumber?: number;
  /** Undefined/null — never touch `<rank>` at all (no Rank field on this org, or no resolution ran). */
  rank?: number | null;
}

export interface RegeneratedEnvelopeTag {
  tag: string;
  donorValue: string;
  newValue: string;
}

export interface VersionNumberAndRankInjectionResult {
  envelopeBefore: string;
  envelopeAfter: string;
  regeneratedIdentifiers: RegeneratedEnvelopeTag[];
  warnings: string[];
  /** Read back from the exact resulting envelope text (never the caller's own candidate) — the
   * authoritative "what did we actually put in the outbound XML" answer for these two fields. */
  outboundVersionNumber: string | null;
  outboundRank: string | null;
}

function replaceTag(
  text: string,
  tag: string,
  newValue: string,
  sink: RegeneratedEnvelopeTag[],
): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  return text.replace(pattern, (_match, donorValue: string) => {
    sink.push({ tag, donorValue, newValue });
    return `<${tag}>${newValue}</${tag}>`;
  });
}

/**
 * §Part 1/2 — `<rank>` is a real `ExpressionSetDefinitionVersion` field (Metadata API, v62.0+) the
 * donor may or may not already carry a tag for. A plain "replace if present" (like `<versionNumber>`,
 * which the Metadata API schema documents as required — every donor has one) is NOT sufficient for
 * `<rank>`, since it's optional: a donor with NO `<rank>` tag at all must still get the resolved value
 * INSERTED, immediately after `<versionNumber>` (present on every donor), never silently left absent.
 */
function ensureRankTag(
  envelopeBefore: string,
  envelopeAfter: string,
  rankValue: string,
  sink: RegeneratedEnvelopeTag[],
  warnings: string[],
): { envelopeBefore: string; envelopeAfter: string } {
  const existingPattern = /<rank>[\s\S]*?<\/rank>/;
  if (existingPattern.test(envelopeBefore) || existingPattern.test(envelopeAfter)) {
    return {
      envelopeBefore: replaceTag(envelopeBefore, "rank", rankValue, sink),
      envelopeAfter: replaceTag(envelopeAfter, "rank", rankValue, sink),
    };
  }
  const anchorPattern = /(<versionNumber>[\s\S]*?<\/versionNumber>)/;
  if (anchorPattern.test(envelopeBefore)) {
    sink.push({ tag: "rank", donorValue: "(not present in donor)", newValue: rankValue });
    return { envelopeBefore: envelopeBefore.replace(anchorPattern, `$1<rank>${rankValue}</rank>`), envelopeAfter };
  }
  if (anchorPattern.test(envelopeAfter)) {
    sink.push({ tag: "rank", donorValue: "(not present in donor)", newValue: rankValue });
    return { envelopeBefore, envelopeAfter: envelopeAfter.replace(anchorPattern, `$1<rank>${rankValue}</rank>`) };
  }
  warnings.push(`Could not insert <rank> — anchor tag <versionNumber> was not found in the generated envelope. Rank was NOT set; if this org requires it, Salesforce will reject deployment with "Assign a unique rank to expression set version ... and try again."`);
  return { envelopeBefore, envelopeAfter };
}

export function injectVersionNumberAndRank(
  envelopeBeforeIn: string,
  envelopeAfterIn: string,
  candidate: VersionNumberAndRankCandidate,
  deployApiVersionNumber: number,
): VersionNumberAndRankInjectionResult {
  let envelopeBefore = envelopeBeforeIn;
  let envelopeAfter = envelopeAfterIn;
  const regeneratedIdentifiers: RegeneratedEnvelopeTag[] = [];
  const warnings: string[] = [];

  if (candidate.versionNumber !== undefined) {
    const value = String(candidate.versionNumber);
    envelopeBefore = replaceTag(envelopeBefore, "versionNumber", value, regeneratedIdentifiers);
    envelopeAfter = replaceTag(envelopeAfter, "versionNumber", value, regeneratedIdentifiers);
  }

  if (candidate.rank !== undefined && candidate.rank !== null) {
    // API v62.0+ only (Metadata API Developer Guide) — sending <rank> to an older org's Metadata API
    // could be rejected as an unrecognized element, so this is gated on the actual deploy API version
    // rather than sent unconditionally.
    if (Number.isFinite(deployApiVersionNumber) && deployApiVersionNumber < 62) {
      warnings.push(`Resolved Rank ${candidate.rank} was NOT embedded in the deploy XML — this org's configured Metadata API version predates Rank's introduction (v62.0). If Salesforce still requires a unique Rank on this org, deployment will fail with "Assign a unique rank ...".`);
    } else {
      const result = ensureRankTag(envelopeBefore, envelopeAfter, String(candidate.rank), regeneratedIdentifiers, warnings);
      envelopeBefore = result.envelopeBefore;
      envelopeAfter = result.envelopeAfter;
    }
  }

  // §Part 1/9 — read back from the EXACT resulting envelope text, scoped to ONLY envelopeBefore/After
  // (never any step region, which this function never receives/touches at all) — the authoritative
  // answer to "what did we actually put in the outbound XML", never re-derived by a caller via its own
  // unscoped scan of the full assembled file (which could match an unrelated same-named tag inside a
  // step's own donor-cloned XML).
  const envelopeOnly = envelopeBefore + envelopeAfter;
  const extract = (tag: string): string | null => {
    const m = envelopeOnly.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? m[1] : null;
  };

  return {
    envelopeBefore, envelopeAfter, regeneratedIdentifiers, warnings,
    outboundVersionNumber: extract("versionNumber"),
    outboundRank: extract("rank"),
  };
}
