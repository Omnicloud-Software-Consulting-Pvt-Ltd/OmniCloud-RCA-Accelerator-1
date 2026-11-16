import { addDays, isIsoDate } from "./eligibility";
import type { LifecycleKind, SwapKind, PostalAddress } from "./types";

/**
 * Asset Lifecycle prompt extraction — PURE (client + server). A natural-language request ("Increase Laptop from 2 to 5 for ABC with a
 * 10% discount effective today") becomes a structured extraction. The AI's raw JSON is never trusted: every value is normalized and
 * validated here, Salesforce Ids are never accepted (names only — the server resolves them against the org), and anything unclear is
 * reported. A deterministic rules parser produces the same shape when no AI key is configured. Nothing here writes anything.
 */

export interface PromptItem {
  /** Asset or product name as the user wrote it. */
  name: string;
  fromQuantity: number | null; toQuantity: number | null; quantityChange: number | null;
  unitPrice: number | null; discount: number | null; billingFrequency: string | null; endDate: string | null;
  swap: { kind: SwapKind; productName: string; quantity: number | null } | null;
}
export interface PromptExtraction {
  kind: LifecycleKind | null;
  name: string | null;
  accountName: string | null;
  contractName: string | null;
  items: PromptItem[];
  /** "apply a 10% discount" with no item named → every item. */
  discount: number | null;
  unitPrice: number | null;
  effectiveDate: string | null;
  renewal: { startDate: string | null; termMonths: number | null; endDate: string | null };
  cancelReason: string | null;
  /** Bill-To Contact name and the addresses as written ("bill to Jane Doe", "billing address 1 Main St, Pune, India"). */
  billTo: string | null; billingAddress: string | null; shippingAddress: string | null;
  /** "ship to the same address" — the shipping address is the billing address. */
  shippingSameAsBilling: boolean;
  notes: string[];
  /** Values dropped by validation (e.g. an Id-shaped string, an out-of-range percentage). */
  rejected: string[];
}

export const LIFECYCLE_AI_SYSTEM = `You extract ONE Salesforce Revenue Cloud asset lifecycle request: an amendment, a renewal or a cancellation of existing customer assets.
Output ONLY one JSON object, no markdown:
{
  "kind": "amend" | "renew" | "cancel" | null,     // amend = change quantity / price / discount / billing / end date, upgrade, downgrade or swap
  "name": string | null,                           // the transaction name if the user gives one ("named X", "called X")
  "accountName": string | null,
  "contractName": string | null,                   // contract number or name if mentioned
  "items": [{
    "name": string,                                // the asset or product name exactly as written
    "fromQuantity": integer | null,                // "from 2 to 5" → 2
    "toQuantity": integer | null,                  // "to 5" → 5
    "quantityChange": integer | null,              // "add 3" → 3, "reduce by 2" → -2
    "unitPrice": number | null, "discount": number | null,   // discount in percent (10% → 10)
    "billingFrequency": "Monthly" | "Quarterly" | "Semi-Annual" | "Annual" | null,
    "endDate": "YYYY-MM-DD" | null,
    "swap": { "kind": "upgrade" | "downgrade" | "swap", "productName": string, "quantity": integer | null } | null
  }],
  "discount": number | null,                       // a discount that applies to every item
  "unitPrice": number | null,
  "effectiveDate": "YYYY-MM-DD" | null,            // "effective today" → today's date
  "renewal": { "startDate": "YYYY-MM-DD" | null, "termMonths": integer | null, "endDate": "YYYY-MM-DD" | null },  // "another 12 months" → 12, "2 years" → 24
  "cancelReason": string | null,
  "billTo": string | null,                         // the Bill-To contact's name ("bill to Jane Doe")
  "billingAddress": string | null,                 // as written, comma-separated: street, city, state, postal code, country
  "shippingAddress": string | null,
  "shippingSameAsBilling": boolean,                // "ship to the same address"
  "notes": string[]                                // anything you couldn't map
}
RULES: extract only what is stated; null otherwise. Never invent names, record Ids, quantities, prices or dates. Resolve relative dates with the given today.`;

/** Where a previewed value came from — the user's words, Salesforce, or derived from both. */
export type ValueSource = "prompt" | "salesforce" | "derived";
export interface AiField { label: string; value: string; source: ValueSource }
export interface AiIssue {
  field: string; status: "missing" | "ambiguous" | "not-found" | "invalid" | "unsupported" | "warning"; message: string;
  /** Real Salesforce records to choose from (ambiguous / suggestions). */
  candidates?: { id: string; name: string; detail?: string }[];
}
/** The server's answer to a prompt: an editable prefill for the existing wizard + what to review. Nothing is saved or sent. */
export interface AiLifecycleResult<Row = unknown, Change = unknown> {
  engine: "ai" | "rules";
  kind: LifecycleKind | null;
  /** The prompt asks for a different lifecycle than the wizard it was typed into. */
  kindMismatch: boolean;
  prefill: {
    name: string | null; account: { id: string; name: string } | null; contractId: string | null; contractNumber: string | null;
    assets: Row[]; changes: Change[]; effectiveDate: string | null;
    renewal: { endDate: string | null; termMonths: number | null } | null; cancelReason: string | null;
    /** Bill-To Contact (resolved to a real contact of the account) and addresses (parsed from the prompt) — editable on the form. */
    billing?: { billToContactId: string | null; billToContactName: string | null; billingAddress: PostalAddress | null; shippingAddress: PostalAddress | null } | null;
  };
  fields: AiField[];
  issues: AiIssue[];
  extraction: PromptExtraction;
}

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const KINDS: LifecycleKind[] = ["amend", "renew", "cancel"];
const FREQS = ["Monthly", "Quarterly", "Semi-Annual", "Annual"];
const str = (v: unknown, max = 255) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[%$,\s]/g, ""))) ? Number(v.replace(/[%$,\s]/g, "")) : null);
const int = (v: unknown) => { const n = num(v); return n !== null && Number.isInteger(n) ? n : null; };

/** Validate + normalize raw extraction JSON (from the AI or the rules parser). */
export function normalizeExtraction(raw: Record<string, unknown>): PromptExtraction {
  const rejected: string[] = [];
  const name = (v: unknown, label: string) => { const s = str(v); if (s && SFID.test(s) && /\d/.test(s)) { rejected.push(`${label} "${s}" looks like a record Id — Ids are never taken from a prompt; use the name.`); return null; } return s; };
  const date = (v: unknown, label: string) => { if (v === null || v === undefined || v === "") return null; if (isIsoDate(v)) return v; rejected.push(`${label} "${String(v)}" isn't a valid date.`); return null; };
  const pct = (v: unknown, label: string) => { const n = num(v); if (n === null) return null; if (n < 0 || n > 100) { rejected.push(`${label} ${n}% is outside 0–100%.`); return null; } return n; };
  const money = (v: unknown, label: string) => { const n = num(v); if (n === null) return null; if (n < 0) { rejected.push(`${label} ${n} is negative.`); return null; } return n; };
  const qty = (v: unknown, label: string, allowNegative = false) => { const n = num(v); if (n === null) return null; if (!Number.isInteger(n) || (!allowNegative && n < 0)) { rejected.push(`${label} ${n} isn't a valid whole quantity.`); return null; } return n; };
  const items: PromptItem[] = (Array.isArray(raw.items) ? raw.items : []).slice(0, 50).flatMap((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const n = name(o.name, `Item ${i + 1}`);
    if (!n) return [];
    const sw = o.swap && typeof o.swap === "object" ? (o.swap as Record<string, unknown>) : null;
    const swapKind = sw && ["upgrade", "downgrade", "swap"].includes(sw.kind as string) ? (sw.kind as SwapKind) : null;
    const swapProduct = sw ? name(sw.productName, "Replacement product") : null;
    if (sw && (!swapKind || !swapProduct)) rejected.push(`${n}: the ${String(sw.kind ?? "replacement")} needs a replacement product name.`);
    const freq = str(o.billingFrequency);
    if (freq && !FREQS.includes(freq)) rejected.push(`${n}: billing frequency "${freq}" isn't one of ${FREQS.join(", ")}.`);
    return [{
      name: n, fromQuantity: qty(o.fromQuantity, `${n}: from-quantity`), toQuantity: qty(o.toQuantity, `${n}: target quantity`), quantityChange: qty(o.quantityChange, `${n}: quantity change`, true),
      unitPrice: money(o.unitPrice, `${n}: unit price`), discount: pct(o.discount, `${n}: discount`), billingFrequency: freq && FREQS.includes(freq) ? freq : null, endDate: date(o.endDate, `${n}: end date`),
      swap: swapKind && swapProduct ? { kind: swapKind, productName: swapProduct, quantity: qty(sw!.quantity, `${n}: replacement quantity`) } : null,
    }];
  });
  const r = (raw.renewal && typeof raw.renewal === "object" ? raw.renewal : {}) as Record<string, unknown>;
  const term = int(r.termMonths);
  if (term !== null && (term < 1 || term > 600)) rejected.push(`Renewal term ${term} months is out of range.`);
  return {
    kind: KINDS.includes(raw.kind as LifecycleKind) ? (raw.kind as LifecycleKind) : null,
    name: str(raw.name, 120), accountName: name(raw.accountName, "Account"), contractName: name(raw.contractName, "Contract"),
    items, discount: pct(raw.discount, "Discount"), unitPrice: money(raw.unitPrice, "Unit price"),
    effectiveDate: date(raw.effectiveDate, "Effective date"),
    renewal: { startDate: date(r.startDate, "Renewal start"), termMonths: term !== null && term >= 1 && term <= 600 ? term : null, endDate: date(r.endDate, "Renewal end") },
    cancelReason: str(raw.cancelReason, 255),
    billTo: name(raw.billTo, "Bill-To Contact"), billingAddress: str(raw.billingAddress, 400), shippingAddress: str(raw.shippingAddress, 400),
    shippingSameAsBilling: raw.shippingSameAsBilling === true,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
    rejected,
  };
}

/* ───────────────────────── rules parser (no AI key) ───────────────────────── */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => { const s = `${y}-${pad(m)}-${pad(d)}`; return isIsoDate(s) && new Date(`${s}T00:00:00Z`).getUTCDate() === d ? s : null; };

/** A date phrase → YYYY-MM-DD ("today", "tomorrow", "December 1, 2026", "1 Dec 2026", "2026-12-01", "12/01/2026"). */
export function parseDatePhrase(s: string, today: string): string | null {
  const t = s.trim().toLowerCase();
  if (/^today\b/.test(t)) return today;
  if (/^tomorrow\b/.test(t)) return addDays(today, 1);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t); if (m) return ymd(+m[3], +m[1], +m[2]);
  const mi = (w: string) => MONTHS.findIndex(x => x.startsWith(w.slice(0, 3)));
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t); if (m && mi(m[1]) >= 0) return ymd(+m[3], mi(m[1]) + 1, +m[2]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})/.exec(t); if (m && mi(m[2]) >= 0) return ymd(+m[3], mi(m[2]) + 1, +m[1]);
  return null;
}
const DATE_RX = String.raw`(today|tomorrow|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4})`;

/**
 * Deterministic extraction for the common phrasings (no AI). Asset / product names can't be found reliably by grammar alone, so the
 * rules parser returns `candidateText` spans; the server matches the account's REAL asset names that occur in the prompt.
 */
export function ruleExtract(prompt: string, today: string): Record<string, unknown> {
  const p = prompt.replace(/\s+/g, " ").trim();
  const low = p.toLowerCase();
  const kind = /\b(cancel|terminate|termination|end the subscription)\b/.test(low) ? "cancel" : /\brenew(al)?\b/.test(low) ? "renew" : /\b(amend|amendment|increase|decrease|reduce|add|upgrade|downgrade|swap|change|discount|price)\b/.test(low) ? "amend" : null;
  // "named "Q4 deal"" → as quoted. Unquoted → up to the sentence end, cut before a following clause ("for …", "effective …", or a verb that
  // starts one: "increase Printer by 2"). A trailing verb with nothing after it is part of the name ("named Printer Increase.").
  const nm = /\b(?:named|called|titled)\s+(?:["“]([^"”]+)["”]|([^.,]+))/i.exec(p);
  const name = nm?.[1]?.trim()
    || nm?.[2]?.replace(/\s+(?:for|with|effective|starting)\b.*$/i, "").replace(/\s+(?:increase|decrease|reduce|renew|cancel|upgrade|downgrade|swap|apply|add)\s+\S+\s+\S+.*$/i, "").trim()
    || null;
  const account = /\bfor\s+(?:the\s+)?(?:account\s+)?([A-Z0-9][^,.]*?)(?=\s+(?:named|called|for another|for|effective|starting|from|with|to|on)\b|[,.]|$)/.exec(p)?.[1] ?? null;
  const eff = new RegExp(String.raw`\b(?:effective|starting|start(?:ing)? on|beginning|from|as of|on)\s+${DATE_RX}`, "i").exec(p)?.[1] ?? null;
  const effectiveDate = eff ? parseDatePhrase(eff, today) : null;
  const disc = /(\d+(?:\.\d+)?)\s*%\s*(?:discount|off)\b|\bdiscount of\s*(\d+(?:\.\d+)?)\s*%/i.exec(p);
  const price = /\b(?:price|unit price)\s*(?:to|of|at|=)?\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(p);
  const fromTo = /\bfrom\s+(\d+)\s+to\s+(\d+)\b/i.exec(p);
  const to = fromTo ? null : /\b(?:quantity\s+)?to\s+(\d+)\b(?!\s*(?:%|months?|years?))/i.exec(p);
  const by = /\b(increase|add|decrease|reduce|remove)\s+(?:[A-Za-z][\w\s-]*?\s+)?by\s+(\d+)\b/i.exec(p) ?? /\b(add|remove)\s+(\d+)\b/i.exec(p);
  const term = /\b(?:for\s+)?(?:another|an additional|a further)?\s*(\d+)\s*(month|year)s?\b/i.exec(p);
  // One sentence only, so a transaction NAME containing "Upgrade" isn't read as an upgrade.
  const swap = /\b([Uu]pgrade|[Dd]owngrade|[Ss]wap)\b[^.]*?\bto\s+(?:the\s+)?([A-Z][\w -]*?)(?=\s+(?:for|effective|starting|with|on)\b|[,.]|$)/.exec(p.replace(/\b(?:named|called|titled)\s+[^.]+\./gi, ". "));
  const fm = /\b(monthly|quarterly|semi-annual(?:ly)?|annual(?:ly)?)\s+billing\b|\bbill(?:ed|ing)?\s+(monthly|quarterly|semi-annually|annually)\b/i.exec(p);
  const fw = (fm?.[1] ?? fm?.[2] ?? "").toLowerCase();
  const freq = fw.startsWith("month") ? "Monthly" : fw.startsWith("quarter") ? "Quarterly" : fw.startsWith("semi") ? "Semi-Annual" : fw.startsWith("annual") ? "Annual" : null;
  const reason = /\b(?:reason|because|due to)\s*:?\s*([^.]+)/i.exec(p)?.[1] ?? null;
  const qChange = by ? (/(decrease|reduce|remove)/i.test(by[1]) ? -Number(by[2]) : Number(by[2])) : null;
  const item = {
    name: "__MATCH_ACCOUNT_ASSETS__", fromQuantity: fromTo ? Number(fromTo[1]) : null, toQuantity: fromTo ? Number(fromTo[2]) : to ? Number(to[1]) : null, quantityChange: qChange,
    unitPrice: price ? Number(price[1]) : null, discount: null, billingFrequency: freq, endDate: null,
    swap: swap && kind === "amend" ? { kind: swap[1].toLowerCase(), productName: swap[2].trim(), quantity: null } : null,
  };
  const months = term ? Number(term[1]) * (/year/i.test(term[2]) ? 12 : 1) : null;
  return {
    kind, name, accountName: account?.trim() ?? null, contractName: /\bcontract\s+(?:number\s+)?([A-Z0-9-]{3,})/i.exec(p)?.[1] ?? null,
    items: [item], discount: disc ? Number(disc[1] ?? disc[2]) : null, unitPrice: null,
    effectiveDate: kind === "renew" ? null : effectiveDate,
    renewal: { startDate: kind === "renew" ? effectiveDate : null, termMonths: kind === "renew" ? months : null, endDate: null },
    cancelReason: kind === "cancel" ? reason?.trim() ?? null : null,
    ...billingPhrases(p),
    notes: ["Parsed with the built-in rules (no AI key configured) — review every field."],
  };
}

/** Bill-To / address phrases (rules parser): "bill to Jane Doe", "billing address: 1 Main St, Pune, MH 411001, India", "ship to …". */
export function billingPhrases(p: string): { billTo: string | null; billingAddress: string | null; shippingAddress: string | null; shippingSameAsBilling: boolean } {
  const stop = String.raw`(?=;|\.\s|\.$|$|\s+and\s+(?:ship|bill)|\s+(?:shipping|billing)\s+address)`;
  const billTo = /\bbill(?:ed)?[- ]to(?:\s+contact)?\s+(?!address)([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,4})/.exec(p)?.[1] ?? null;
  const billingAddress = new RegExp(String.raw`\bbilling address(?:\s+is|:)?\s+(.+?)${stop}`, "i").exec(p)?.[1]?.trim() ?? null;
  const same = /\bship(?:ping)?(?:\s+address)?\s+(?:to\s+)?(?:is\s+)?(?:the\s+)?same(?:\s+address)?(?:\s+as\s+billing)?\b/i.test(p);
  const shippingAddress = same ? null : new RegExp(String.raw`\b(?:shipping address(?:\s+is|:)?|ship to(?:\s+address)?)\s+(.+?)${stop}`, "i").exec(p)?.[1]?.trim() ?? null;
  return { billTo, billingAddress, shippingAddress, shippingSameAsBilling: same };
}

/** "street, city, state postal, country" → address parts (last part = country; a trailing number = postal code). Review on the form. */
export function parseAddressText(text: string | null): PostalAddress | null {
  if (!text) return null;
  const parts = text.split(",").map(x => x.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const a: PostalAddress = { street: null, city: null, state: null, postalCode: null, country: parts.pop()! };
  const last = parts[parts.length - 1];
  const sp = /^([A-Za-z][A-Za-z .'-]*?)\s+(\d[\d -]{2,9})$/.exec(last);
  if (sp && parts.length >= 2) { a.state = sp[1]; a.postalCode = sp[2]; parts.pop(); }
  else if (/^(?=.*\d)[A-Z0-9][A-Z0-9 -]{2,9}$/i.test(last)) a.postalCode = parts.pop()!;
  if (!a.state && parts.length >= 3) a.state = parts.pop()!;
  a.city = parts.pop() ?? null;
  a.street = parts.join(", ") || null;
  return a.street && a.city ? a : null;
}
