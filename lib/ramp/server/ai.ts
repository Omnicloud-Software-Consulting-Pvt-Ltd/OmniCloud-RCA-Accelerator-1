import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "@/lib/billing/server/ai";
import { addDays, addMonths, isIsoDate, periodMonths } from "@/lib/ramp/schedule";
import type { DealKind, PeriodUnit, RampDealDraft, UpliftMethod } from "@/lib/ramp/types";
import { quoteGroups, quoteLines, searchAccounts, searchQuotes } from "./reads";
import type { RampApi } from "./api";

/**
 * AI RAMP BUILDER — natural language → a structured, EDITABLE ramp deal draft. The AI only extracts what the user said; every
 * Salesforce record is resolved by querying the org by name (an AI-supplied Id is never used), anything ambiguous or missing is
 * reported, and NOTHING is written — the draft goes to the normal deal editor, where executing needs its own confirmation.
 */
export const RAMP_AI_SYSTEM = `You extract a Salesforce Revenue Cloud RAMP DEAL request. Output ONLY one JSON object, no markdown:
{
  "intent": "line" | "group" | null,          // "group" when the user talks about a quote line group / several products ramped together; "line" for one quote line / product
  "dealName": string | null,
  "accountName": string | null,
  "quoteName": string | null,
  "productName": string | null,                // line ramp: the product on the quote line
  "groupName": string | null,                  // group ramp: the quote line group
  "period": "Monthly" | "Quarterly" | "Yearly" | "Custom" | null,
  "customMonths": integer | null,
  "segments": integer | null,
  "trialMonths": integer | null,
  "upliftMethod": "Standard" | "Compound" | null,   // "compounding" / "on top of the previous year" → Compound
  "upliftPercent": number | null,              // the same uplift for every segment after the first
  "segmentUplifts": number[] | null,           // per-segment uplifts when the user lists them (first segment usually 0)
  "basePriceMultiplier": number | null,
  "contractStart": "YYYY-MM-DD" | null,
  "contractEnd": "YYYY-MM-DD" | null,
  "contractMonths": integer | null,
  "notes": string[]
}
RULES: extract only what is stated; null otherwise. Never invent names, Ids, dates or percentages. "3-year ramp" → period Yearly, segments 3, contractMonths 36.`;

export interface AiRampResult {
  draft: Partial<RampDealDraft>;
  resolved: { field: string; status: "resolved" | "ambiguous" | "not-found" | "missing"; message: string; candidates?: { id: string; name: string }[] }[];
  missing: string[];
  notes: string[];
  extraction: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

export async function aiRampDraft(api: RampApi, anthropic: Anthropic, prompt: string, today = new Date().toISOString().slice(0, 10)): Promise<AiRampResult> {
  const x = await callClaude(anthropic, RAMP_AI_SYSTEM, `Today is ${today}.\n\n${prompt}`, 1200);
  return resolveExtraction(api, x, today);
}

/** Pure-ish resolution step (exported for tests): extraction → draft, resolving names through Salesforce reads only. */
export async function resolveExtraction(api: RampApi, x: Record<string, unknown>, today: string): Promise<AiRampResult> {
  const resolved: AiRampResult["resolved"] = [];
  const notes = Array.isArray(x.notes) ? x.notes.filter((n): n is string => typeof n === "string") : [];
  const kind: DealKind = x.intent === "group" || (!!str(x.groupName) && !str(x.productName)) ? "group" : "line";
  const period = (["Monthly", "Quarterly", "Yearly", "Custom"].includes(x.period as string) ? x.period : "Yearly") as PeriodUnit;
  const upliftMethod = (x.upliftMethod === "Compound" ? "Compound" : "Standard") as UpliftMethod;
  const segUps = Array.isArray(x.segmentUplifts) ? (x.segmentUplifts as unknown[]).map(num) : null;
  const segments = int(x.segments) ?? (segUps?.length || null);
  const draft: Partial<RampDealDraft> = {
    kind, name: str(x.dealName) ?? undefined,
    schedule: {
      name: str(x.dealName) ?? "AI schedule", description: null, period, customMonths: period === "Custom" ? int(x.customMonths) : null, segments: segments ?? 3, trialMonths: int(x.trialMonths),
      priceChange: "percent", defaultChange: num(x.upliftPercent) ?? (segUps ? null : 0), upliftMethod, basePriceMultiplier: num(x.basePriceMultiplier) ?? 1,
      overrides: segUps ? segUps.map((v, i) => ({ segment: i + 1, value: v })).filter(o => o.value !== null) : [],
    },
    periodBoundary: "Anniversary", basePrice: 0, baseQuantity: 1,
  };
  const start = isIsoDate(x.contractStart) ? (x.contractStart as string) : null;
  let end = isIsoDate(x.contractEnd) ? (x.contractEnd as string) : null;
  if (start && !end) { const months = int(x.contractMonths) ?? (segments && periodMonths(period, draft.schedule!.customMonths) ? segments * periodMonths(period, draft.schedule!.customMonths)! : null); if (months) end = addDays(addMonths(start, months), -1); }
  if (start) draft.contractStart = start;
  if (end) draft.contractEnd = end;
  if (start && start < today) notes.push(`The start date ${start} is in the past.`);

  // Account → quote → line / group, each resolved by name in Salesforce.
  const pick = <T extends { id: string; name: string }>(field: string, input: string | null, rows: T[]): T | null => {
    if (!input) { resolved.push({ field, status: "missing", message: `No ${field} mentioned — select it.` }); return null; }
    const exact = rows.filter(r => r.name.trim().toLowerCase() === input.toLowerCase());
    const hit = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
    if (hit) { resolved.push({ field, status: "resolved", message: `${field} "${hit.name}"` }); return hit; }
    resolved.push({ field, status: rows.length ? "ambiguous" : "not-found", message: rows.length ? `"${input}" matches ${rows.length} ${field} records — choose one.` : `No ${field} named "${input}" in this org.`, candidates: rows.slice(0, 8).map(r => ({ id: r.id, name: r.name })) });
    return null;
  };
  const acctName = str(x.accountName);
  const account = acctName ? pick("Account", acctName, await searchAccounts(api, acctName)) : (resolved.push({ field: "Account", status: "missing", message: "No account mentioned (optional)." }), null);
  if (account) { draft.accountId = account.id; draft.accountName = account.name; }
  const qName = str(x.quoteName);
  const quote = pick("Quote", qName, qName ? (await searchQuotes(api, { accountId: account?.id ?? null, q: qName })).rows : []);
  if (quote) {
    draft.quoteId = quote.id; draft.quoteName = quote.name;
    if (kind === "line") {
      const lines = (await quoteLines(api, quote.id)).filter(l => !l.rampIdentifier);
      const pName = str(x.productName);
      const rows = lines.map(l => ({ id: l.id, name: l.productName ?? l.id, l })).filter(r => !pName || r.name.toLowerCase().includes(pName.toLowerCase()));
      const line = pick("Quote line", pName ?? (rows.length === 1 ? rows[0].name : null), rows);
      if (line) {
        draft.lineId = line.id; draft.productId = line.l.productId; draft.productName = line.l.productName; draft.sellingModelId = line.l.sellingModelId;
        draft.basePrice = line.l.unitPrice ?? 0; draft.baseQuantity = line.l.quantity ?? 1;
        if (!draft.contractStart && line.l.startDate) draft.contractStart = line.l.startDate;
        if (!draft.contractEnd && line.l.endDate) draft.contractEnd = line.l.endDate;
        if (draft.contractStart !== line.l.startDate || draft.contractEnd !== line.l.endDate) notes.push(`The line runs ${line.l.startDate} → ${line.l.endDate}; a line ramp uses the line's own dates.`);
      }
    } else {
      const groups = (await quoteGroups(api, quote.id)).filter(g => !g.isRamped);
      const g = pick("Quote line group", str(x.groupName) ?? (groups.length === 1 ? groups[0].name : null), groups.filter(gr => !str(x.groupName) || gr.name.toLowerCase().includes(str(x.groupName)!.toLowerCase())));
      if (g) { draft.groupId = g.id; draft.groupName = g.name; }
    }
  }
  const missing = [!draft.name && "deal name", !draft.quoteId && "quote", kind === "line" && !draft.lineId && "quote line", kind === "group" && !draft.groupId && "quote line group", !draft.contractStart && "start date", !draft.contractEnd && "end date"].filter((m): m is string => !!m);
  return { draft, resolved, missing, notes, extraction: x };
}
