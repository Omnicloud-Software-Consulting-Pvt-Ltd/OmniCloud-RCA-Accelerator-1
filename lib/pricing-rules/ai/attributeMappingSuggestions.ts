/**
 * §Attribute Validation UX — turns "these entries didn't match" into "here
 * is the closest REAL Salesforce value for each one, if one exists".
 * Two-pass: (1) deterministic fuzzy matching (fuzzyMatch.ts) against the
 * relevant candidate list — fast, explainable, no AI call; (2) for
 * whatever pass 1 couldn't confidently resolve, one batched AI-assisted
 * call (suggestAttributeMappings.ts) constrained to the same real
 * candidate list. Every suggestion — from either pass — is re-verified
 * against the real discovered attribute/value list before being attached,
 * so nothing invented can ever reach the caller.
 */
import { bestFuzzyMatch, type FuzzyCandidate } from "./fuzzyMatch";
import { suggestClosestMatches, type MatchRequest } from "./suggestAttributeMappings";
import type { AIAttributeEntry, AttributeDefinition, AttributeValidationIssue, AttributeValidationSuggestion } from "@/lib/pricing-rules/types";

export interface UnresolvedEntry {
  entry: AIAttributeEntry;
  /** Set only when the attribute NAME itself matched a real attribute but the VALUE didn't — narrows the suggestion search to that attribute's own values instead of the whole product. */
  matchedAttribute: AttributeDefinition | null;
}

function toCandidates(values: { value: string; label: string }[]): FuzzyCandidate[] {
  return values.map(v => ({ value: v.value, label: v.label || v.value }));
}

export async function computeAttributeMappingSuggestions(
  apiKey: string,
  unresolved: UnresolvedEntry[],
  attributes: AttributeDefinition[],
): Promise<AttributeValidationIssue[]> {
  const issues: AttributeValidationIssue[] = unresolved.map(u => ({
    enteredAttributeName: u.entry.attributeName,
    enteredAttributeValue: u.entry.attributeValue,
    adjustmentType: u.entry.adjustmentType,
    adjustmentValue: u.entry.adjustmentValue,
  }));

  interface PendingAiLookup {
    issueIndex: number;
    input: string;
    candidates: { attr: AttributeDefinition; value: { value: string; label: string } }[];
  }
  const pendingAiLookups: PendingAiLookup[] = [];

  unresolved.forEach((u, i) => {
    let targetAttribute = u.matchedAttribute;

    // The attribute name itself didn't match anything — try to fuzzy-resolve WHICH attribute the
    // user meant before attempting to resolve the value within it.
    if (!targetAttribute) {
      const attrMatch = bestFuzzyMatch(u.entry.attributeName, attributes.map(a => ({ value: a.name, label: a.label })));
      if (attrMatch) targetAttribute = attributes.find(a => a.name === attrMatch.candidate.value) ?? null;
    }

    if (!targetAttribute) {
      // Can't even guess the attribute deterministically — defer to the AI fallback against every
      // discovered attribute value on the product (rare: only when the attribute name itself is
      // unrecognizable, not just misspelled).
      pendingAiLookups.push({
        issueIndex: i,
        input: `${u.entry.attributeName}: ${u.entry.attributeValue}`,
        candidates: attributes.flatMap(a => a.values.map(v => ({ attr: a, value: v }))),
      });
      return;
    }

    const valueMatch = bestFuzzyMatch(u.entry.attributeValue, toCandidates(targetAttribute.values));
    if (valueMatch) {
      issues[i].suggestion = {
        attributeName: targetAttribute.name,
        attributeLabel: targetAttribute.label || targetAttribute.name,
        attributeValue: valueMatch.candidate.value,
        attributeValueLabel: valueMatch.candidate.label,
        confidence: valueMatch.confidence,
        method: "fuzzy-match",
      };
    } else {
      pendingAiLookups.push({
        issueIndex: i,
        input: u.entry.attributeValue,
        candidates: targetAttribute.values.map(v => ({ attr: targetAttribute!, value: v })),
      });
    }
  });

  if (pendingAiLookups.length > 0) {
    try {
      const requests: MatchRequest[] = pendingAiLookups.map((p, i) => ({
        id: String(i),
        input: p.input,
        candidates: p.candidates.map(c => c.value.label || c.value.value),
      }));
      const matches = await suggestClosestMatches(apiKey, requests);
      pendingAiLookups.forEach((p, i) => {
        const chosenLabel = matches.get(String(i));
        if (!chosenLabel) return;
        // §Defense against hallucination — accept the AI's answer only if it's an EXACT member of
        // the real candidate list this specific lookup was given; anything else (reworded, invented,
        // or belonging to a different attribute) is discarded rather than shown as a suggestion.
        const matchedCandidate = p.candidates.find(c => (c.value.label || c.value.value) === chosenLabel);
        if (!matchedCandidate) return;
        const suggestion: AttributeValidationSuggestion = {
          attributeName: matchedCandidate.attr.name,
          attributeLabel: matchedCandidate.attr.label || matchedCandidate.attr.name,
          attributeValue: matchedCandidate.value.value,
          attributeValueLabel: matchedCandidate.value.label || matchedCandidate.value.value,
          confidence: "medium",
          method: "ai-suggested",
        };
        issues[p.issueIndex].suggestion = suggestion;
      });
    } catch {
      // AI fallback is best-effort — the affected issues simply have no suggestion rather than
      // failing the whole validation summary.
    }
  }

  return issues;
}
