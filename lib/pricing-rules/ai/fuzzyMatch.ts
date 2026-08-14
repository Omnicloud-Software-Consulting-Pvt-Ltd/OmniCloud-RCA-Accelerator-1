/**
 * §Attribute Validation UX — deterministic "closest real value" matching.
 * Used BEFORE ever falling back to an AI guess: a shared model-number-style
 * token (e.g. "i5", "i7", "rtx4060") between the user's typed value and a
 * real Salesforce value is a much stronger signal than raw string
 * similarity, since spec strings like "Intel i5" vs "i5-CPU 4.4 GHz" share
 * almost no characters in sequence but obviously mean the same part.
 * Never returns a candidate that wasn't passed in — the caller is always
 * choosing from a real, already-discovered Salesforce list.
 */

export interface FuzzyCandidate {
  value: string;
  label: string;
}

export interface FuzzyMatchResult {
  candidate: FuzzyCandidate;
  score: number;
  confidence: "high" | "medium";
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9.]+/i).filter(Boolean);
}

/** A token that mixes letters and digits — "i5", "i7", "rtx4060", "4.4ghz" — the kind of distinctive model/spec code that, if shared, is strong evidence of a match even when the surrounding text is completely different. */
function isDistinctiveToken(tok: string): boolean {
  return /[a-z]/i.test(tok) && /[0-9]/.test(tok);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function scorePair(input: string, candidate: string): number {
  const inputNorm = normalizeForMatch(input);
  const candNorm = normalizeForMatch(candidate);
  if (!inputNorm || !candNorm) return 0;
  if (inputNorm === candNorm) return 1;

  const inputTokens = tokenize(input);
  const candTokens = tokenize(candidate);
  const sharesDistinctiveToken = inputTokens.some(tok => isDistinctiveToken(tok) && candTokens.includes(tok));

  const tokenScore = jaccard(inputTokens, candTokens);
  const editScore = similarityRatio(inputNorm, candNorm) * 0.7; // edit-distance alone is weaker evidence than shared tokens — discounted
  let score = Math.max(tokenScore, editScore);
  if (sharesDistinctiveToken) score = Math.max(score, 0.8);
  return score;
}

const MATCH_THRESHOLD = 0.55;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Best deterministic match for `input` among `candidates` (matched against
 * both each candidate's raw value and its display label). Returns null
 * below MATCH_THRESHOLD rather than a low-confidence guess — the caller
 * should treat null as "defer to the AI-assisted fallback", not "no
 * suggestion at all".
 */
export function bestFuzzyMatch(input: string, candidates: FuzzyCandidate[]): FuzzyMatchResult | null {
  let best: FuzzyMatchResult | null = null;
  for (const candidate of candidates) {
    const score = Math.max(scorePair(input, candidate.value), scorePair(input, candidate.label));
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { candidate, score, confidence: score >= HIGH_CONFIDENCE_THRESHOLD ? "high" : "medium" };
    }
  }
  return best;
}
