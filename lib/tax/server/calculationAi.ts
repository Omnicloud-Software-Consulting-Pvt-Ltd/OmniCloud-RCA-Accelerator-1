import type { TaxQuery, TaxQueryKind } from "@/lib/tax/server/taxQuery";

/**
 * AI INTERPRETATION of tax CALCULATION requests (intent + references), kept apart from execution:
 *
 *   prompt → AI (structured JSON only) → GROUNDING (every value must literally appear in the prompt; anything else is dropped and
 *   reported) → merged with the deterministic parse → the deterministic services resolve real Salesforce records and execute.
 *
 * The AI never supplies a record Id, tax code, rate, legal entity or amount that the user didn't write, and never calculates tax.
 * Configuration requests (create / update / activate … tax records) are routed to the Tax Configuration Assistant instead.
 */

/** The AI call: returns the model's JSON (parsed object, or the raw text). */
export type CallAi = (system: string, prompt: string) => Promise<unknown>;
export interface AiCalcInterpretation {
  route: "calculation" | "configuration";
  query: TaxQuery | null;
  /** Values the AI returned that are not in the prompt (dropped). */
  dropped: string[];
  missing: string[];
}

const INTENTS: Record<string, { kind: TaxQueryKind; intent?: TaxQuery["intent"] }> = {
  "calculate-product": { kind: "salesforce-calculate" },
  "inspect-configuration": { kind: "salesforce-calculate", intent: "configure" },
  "order-result": { kind: "order-result" }, "order-explain": { kind: "order-explain" },
  "invoice-result": { kind: "invoice-result" }, "invoice-explain": { kind: "invoice-explain" },
  "readiness": { kind: "readiness" }, "decision-table": { kind: "decision-table" }, "explain-product": { kind: "explain" },
  "preview": { kind: "salesforce-preview" },
};

export const CALC_AI_SYSTEM = `You interpret requests about Salesforce Revenue Cloud TAX for an application. You ONLY extract what the user wrote; the application
resolves every record in Salesforce and Salesforce calculates the tax. Answer with ONE JSON object and nothing else:
{"route":"calculation"|"configuration",
 "intent":"calculate-product"|"inspect-configuration"|"order-result"|"order-explain"|"invoice-result"|"invoice-explain"|"readiness"|"decision-table"|"explain-product"|"preview",
 "product":string|null,"productCode":string|null,"productId":string|null,"orderNumber":string|null,"orderId":string|null,"invoiceNumber":string|null,
 "account":string|null,"country":string|null,"state":string|null,"taxCode":string|null,"rate":number|null,"basis":"Net"|"Gross"|null,
 "quantity":number|null,"unitPrice":number|null,"missing":string[]}
Rules:
- Copy every value EXACTLY as the user wrote it. If a value isn't written in the request, use null. Never infer, complete, translate or invent
  product names, accounts, order/invoice numbers, record Ids, tax codes, rates, jurisdictions or amounts.
- "product" is what is sold; "account" is the customer who buys. Never put a product (or words like "the existing product") into "account".
- "missing": the details the request lacks to calculate tax (e.g. "customer account", "country", "tax rate").
- route "configuration": the user asks to create, update, assign, activate, deactivate, delete or show tax records WITHOUT asking to calculate
  tax or to explain a tax result. Everything about calculating, verifying or explaining tax on a product, order or invoice is "calculation".
- intent: "inspect-configuration" = check what is configured/missing before calculating; "order-*"/"invoice-*" = an existing order/invoice
  ("-explain" when asking why tax was (not) applied); "decision-table" = whether a decision table is current / contains the latest rate.`;

const norm = (s: string) => s.toLowerCase().replace(/[“”‘’"']/g, "").replace(/\s+/g, " ").trim();
const numbersIn = (p: string) => [...p.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));

/** Pure: keep a value only when the user actually wrote it. */
export function groundValue(prompt: string, v: unknown): { ok: boolean; value: string | number | null } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v === "number") return Number.isFinite(v) && numbersIn(prompt).some(n => Math.abs(n - v) < 1e-9) ? { ok: true, value: v } : { ok: false, value: null };
  if (typeof v !== "string") return { ok: false, value: null };
  const s = v.trim();
  return s && norm(prompt).includes(norm(s)) ? { ok: true, value: s } : { ok: false, value: null };
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  const text = raw;
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ""));
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return o && typeof o === "object" ? o as Record<string, unknown> : null; } catch { return null; }
}

/**
 * Pure merge (tested): AI fields that pass grounding win over the deterministic parse; ungrounded AI values are dropped (reported);
 * the deterministic value is kept where the AI has none. Throws only on an unusable AI answer (caller falls back with a notice).
 */
export function mergeAiInterpretation(prompt: string, aiText: unknown, det: TaxQuery | null): AiCalcInterpretation {
  const o = parseJson(aiText);
  if (!o) throw new Error("The AI answer wasn't valid JSON.");
  const dropped: string[] = [];
  const g = (field: string) => { const r = groundValue(prompt, o[field]); if (!r.ok) dropped.push(`${field}: ${JSON.stringify(o[field])}`); return r.value; };
  const route = o.route === "configuration" ? "configuration" : "calculation";
  const missing = Array.isArray(o.missing) ? o.missing.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  if (route === "configuration" && !det) return { route, query: null, dropped, missing };
  const map = typeof o.intent === "string" ? INTENTS[o.intent] : undefined;
  const s = (field: string) => { const v = g(field); return typeof v === "string" ? v : null; };
  const n = (field: string) => { const v = g(field); return typeof v === "number" ? v : null; };
  const basisRaw = s("basis");
  const basis = basisRaw ? (/^net$/i.test(basisRaw) ? "Net" : /^gross$/i.test(basisRaw) ? "Gross" : null) : null;
  const productId = s("productId"), orderId = s("orderId");
  const kind: TaxQueryKind = map?.kind ?? det?.kind ?? "salesforce-calculate";
  const orderKind = kind === "order-result" || kind === "order-explain";
  const account = s("account");
  const product = s("product") ?? det?.product ?? null;
  const q: TaxQuery = {
    kind,
    product: orderKind ? null : product,
    productCode: orderKind ? null : s("productCode") ?? det?.productCode ?? null,
    productId: orderKind ? null : (productId && /^01t[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(productId) ? productId : null) ?? det?.productId ?? null,
    orderNumber: s("orderNumber") ?? det?.orderNumber ?? null,
    orderId: (orderId && /^801[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(orderId) ? orderId : null) ?? det?.orderId ?? null,
    invoiceNumber: s("invoiceNumber")?.toUpperCase() ?? det?.invoiceNumber ?? null,
    // A product name is never an account, whatever the AI returned.
    account: orderKind ? null : (account && account !== product ? account : null) ?? det?.account ?? null,
    country: s("country") ?? det?.country ?? null, state: s("state") ?? det?.state ?? null,
    taxCode: s("taxCode") ?? det?.taxCode ?? null, rate: n("rate") ?? det?.rate ?? null, basis: basis ?? det?.basis ?? null,
    quantity: n("quantity") ?? det?.quantity ?? null, unitPrice: n("unitPrice") ?? det?.unitPrice ?? null,
    intent: map?.intent ?? det?.intent ?? "calculate", test: det?.test ?? null, noMutation: det?.noMutation ?? false,
  };
  return { route: "calculation", query: q, dropped, missing };
}

export async function interpretCalculationWithAi(call: CallAi, prompt: string, det: TaxQuery | null): Promise<AiCalcInterpretation> {
  return mergeAiInterpretation(prompt, await call(CALC_AI_SYSTEM, prompt), det);
}

export interface InterpretationInfo {
  by: "ai" | "rules";
  /** The AI's status for this request: OK, NOT_CONFIGURED (no key), REJECTED (key refused), ERROR (other AI failure). */
  ai: { status: "OK" | "NOT_CONFIGURED" | "REJECTED" | "ERROR"; message: string | null };
  dropped: string[];
  missing: string[];
}

/**
 * Which calculation query to run, and how it was interpreted. `call` is null when no Anthropic key is configured; `classify` maps an AI
 * error to { status } (503 = key rejected). Returns query null when the request isn't a calculation (→ the configuration assistant) —
 * or `error` when nothing can interpret it (no key / rejected key and the built-in rules don't recognise it).
 */
export async function resolveCalculationQuery(a: { prompt: string; det: TaxQuery | null; call: CallAi | null; classify: (e: unknown) => { status: number; message: string } }):
  Promise<{ query: TaxQuery | null; info: InterpretationInfo; error?: { status: number; code: "NO_AI_KEY" | "AI_KEY_REJECTED" | "AI_ERROR"; message: string } }> {
  const rules = (ai: InterpretationInfo["ai"]): InterpretationInfo => ({ by: "rules", ai, dropped: [], missing: [] });
  if (!a.call) {
    const info = rules({ status: "NOT_CONFIGURED", message: "The Anthropic API key isn't configured (Setup) — this request was interpreted by the built-in rules, not by the AI." });
    return a.det ? { query: a.det, info } : { query: null, info, error: { status: 503, code: "NO_AI_KEY", message: "Anthropic API key not configured. Complete Setup to add your key." } };
  }
  try {
    const r = await interpretCalculationWithAi(a.call, a.prompt, a.det);
    if (r.route === "configuration" || !r.query) return { query: null, info: { by: "ai", ai: { status: "OK", message: null }, dropped: r.dropped, missing: r.missing } };
    return { query: r.query, info: { by: "ai", ai: { status: "OK", message: r.dropped.length ? `Ignored AI values that aren't in the request: ${r.dropped.join("; ")}.` : null }, dropped: r.dropped, missing: r.missing } };
  } catch (e) {
    const { status, message } = a.classify(e);
    if (status === 503) {
      const info = rules({ status: "REJECTED", message: "The Anthropic API key was rejected (invalid or expired) — this request was interpreted by the built-in rules, not by the AI. Update the key in Setup." });
      return a.det ? { query: a.det, info } : { query: null, info, error: { status: 503, code: "AI_KEY_REJECTED", message: "The Anthropic API key was rejected (invalid or expired). Update it in Setup." } };
    }
    const info = rules({ status: "ERROR", message: `The AI interpretation failed (${message}) — the built-in rules were used.` });
    return a.det ? { query: a.det, info } : { query: null, info };
  }
}
