import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "@/lib/billing/server/ai";
import { productEligibility } from "@/lib/ramp/eligibility";
import { RAMP_AI_REQUIRED, aiSchemaDescription, optionalNotSupplied, validateAiExtraction, type AiSource, type AiValue, type RampAiForm } from "@/lib/ramp/aiSchema";
import type { RampSchedule } from "@/lib/ramp/types";
import { capabilities, productFacts, productRampSegments, quoteGroups, quoteLines, searchAccounts, searchProducts, searchQuotes, sellingModels } from "./reads";
import type { RampApi } from "./api";

/**
 * AI-ASSISTED RAMP FORMS — prompt → validated, Salesforce-resolved values for ONE existing RAMP form (Product Ramp Segment, Ramp
 * Schedule, Ramp Deal, Group Ramp Deal). READ-ONLY: Claude extracts names/values, lib/ramp/aiSchema.ts validates them, and every
 * Salesforce reference is resolved here by querying the connected org — an Id is only ever one Salesforce returned. Ambiguous or
 * unknown references are reported with candidates and never auto-selected. Nothing is saved, created or executed: the client merges
 * the result into the form for review; the form's own Save / Create / Execute (each confirmed) does any writing.
 */

/** What the form currently holds (names for the AI; Ids so "the selected quote" means the user's own selection). */
export interface RampAiContext {
  name?: string | null;
  accountId?: string | null; accountName?: string | null;
  quoteId?: string | null; quoteName?: string | null;
  lineId?: string | null; groupId?: string | null; groupName?: string | null;
  productId?: string | null; productName?: string | null;
  /** The deal / schedule form's period + segments were set by the user (not just the blank defaults). */
  scheduleSet?: boolean;
}

export type RefStatus = "resolved" | "selected" | "ambiguous" | "not-found" | "missing" | "not-mentioned";
export interface RefResolution { field: string; status: RefStatus; message: string; id?: string | null; candidates?: { id: string; name: string; detail?: string | null }[] }

export interface RampAiFormResult {
  form: RampAiForm;
  /** Values for the form (Ids only from Salesforce). Deal forms carry schedule values under `schedule`. */
  patch: Record<string, unknown>;
  /** Where each patch key came from: the prompt (explicit), derived (inferred), or a Salesforce lookup (salesforce). */
  sources: Record<string, AiSource | "salesforce">;
  fields: Record<string, AiValue>;
  references: RefResolution[];
  missingRequired: string[];
  optionalNotSupplied: string[];
  rejected: { key: string; reason: string }[];
  errors: string[];
  warnings: string[];
  notes: string[];
  replace: boolean;
}

const FORM_LABEL: Record<RampAiForm, string> = { "product-segment": "PRODUCT RAMP SEGMENT", schedule: "RAMP SCHEDULE", deal: "RAMP DEAL (line ramp on one quote line)", "group-deal": "GROUP RAMP DEAL (a quote line group ramped together)" };
const FORM_HINTS: Record<RampAiForm, string> = {
  "product-segment": `"yearly ramp segments" → segmentType "Yearly"; "free trial of 30 days" → segmentType "FreeTrial", trialDuration 30, durationType "Days". A product code like "API-PREM" → productCode. "term-based yearly" names a selling model → sellingModelName.`,
  schedule: `"3-year yearly schedule" → period "Yearly", contractMonths 36, segments 3 (segments inferred). "5% standard uplift per year" → defaultChange 5, upliftMethod "Standard", priceChange "percent". "compounding" / "on top of the previous year" → "Compound". "no free trial" → freeTrial false. "equal 12-month periods" → period "Yearly". Invent a name only if asked; otherwise omit "name".`,
  deal: `"on the selected quote" → useSelectedQuote true; "the selected line" → useSelectedLine true. The product named is the quote line's product → productName. "3-year … yearly segments" → period "Yearly", segments 3. A saved schedule referred to by name → scheduleName.`,
  "group-deal": `"the selected quote" → useSelectedQuote true; "the selected quote line group" → useSelectedGroup true. "3-year group ramp, yearly segments" → period "Yearly", segments 3, contractMonths 36. Per-segment uplifts → overrides [{segment, value}].`,
};

export function rampAiSystemPrompt(form: RampAiForm): string {
  return `You extract a Salesforce Revenue Cloud ${FORM_LABEL[form]} configuration from the user's request. Output ONLY one JSON object, no markdown:
{ "fields": { "<key>": { "value": <value>, "source": "explicit" | "inferred" } }, "replace": boolean, "notes": string[] }
Allowed keys — omit every key the request doesn't mention:
${aiSchemaDescription(form)}
RULES:
- "explicit" = the user stated it; "inferred" = you derived it from what they said. Never fill a value the request doesn't support.
- Never invent record names, Salesforce Ids, dates or percentages. Salesforce records are given by NAME (or quote number) only.
- Percentages in percent units (5% → 5). Dates as YYYY-MM-DD.
- "replace": true only when the user explicitly asks to change / replace values already in the form.
- notes: short remarks about anything you could not map.
HINTS: ${FORM_HINTS[form]}`;
}

function contextText(c: RampAiContext): string {
  const parts = [c.name && `deal/schedule name "${c.name}"`, c.accountName && `account "${c.accountName}"`, c.quoteName && `quote "${c.quoteName}"`, c.groupName && `quote line group "${c.groupName}"`, c.productName && `product "${c.productName}"`].filter(Boolean);
  return parts.length ? `The form currently has: ${parts.join(", ")}.` : "The form is empty.";
}

export async function aiRampForm(api: RampApi, anthropic: Anthropic, form: RampAiForm, prompt: string, context: RampAiContext, schedules: RampSchedule[], today = new Date().toISOString().slice(0, 10)): Promise<RampAiFormResult> {
  const raw = await callClaude(anthropic, rampAiSystemPrompt(form), `Today is ${today}. ${contextText(context)}\n\nRequest: ${prompt}`, 1500);
  return resolveRampAiForm(api, form, raw, context, schedules, today);
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** Pick one record by name: exact match → that one; a single partial match → it; several → ambiguous (never auto-picked). */
function pick<T extends { id: string; name: string }>(field: string, input: string, rows: T[], alt?: (r: T) => string | null): { hit: T | null; ref: RefResolution } {
  const exact = rows.filter(r => lc(r.name) === lc(input) || (alt && lc(alt(r)) === lc(input)));
  const hit = exact.length === 1 ? exact[0] : exact.length === 0 && rows.length === 1 ? rows[0] : null;
  if (hit) return { hit, ref: { field, status: "resolved", id: hit.id, message: `${field}: "${hit.name}"${exact.length ? "" : ` (closest match for "${input}")`}` } };
  const many = exact.length > 1 ? exact : rows;
  return { hit: null, ref: { field, status: many.length ? "ambiguous" : "not-found", id: null, message: many.length ? `"${input}" matches ${many.length} ${field} records — choose one.` : `No ${field} matching "${input}" was found in this org.`, candidates: many.slice(0, 8).map(r => ({ id: r.id, name: r.name, detail: alt ? alt(r) : null })) } };
}

/** Resolution step (exported for tests): validated extraction → form patch + Salesforce references. Reads only. */
export async function resolveRampAiForm(api: RampApi, form: RampAiForm, raw: unknown, ctx: RampAiContext, schedules: RampSchedule[], today: string): Promise<RampAiFormResult> {
  const x = validateAiExtraction(form, raw, today);
  const f = x.fields;
  const val = <T,>(k: string) => f[k]?.value as T | undefined;
  const patch: Record<string, unknown> = {};
  const sources: RampAiFormResult["sources"] = {};
  const set = (k: string, v: unknown, src: AiSource | "salesforce") => { patch[k] = v; sources[k] = src; };
  const fromField = (k: string, target = k) => { if (f[k]) set(target, f[k].value, f[k].source); };
  const refs: RefResolution[] = [];
  const res: RampAiFormResult = { form, patch, sources, fields: f, references: refs, missingRequired: [], optionalNotSupplied: optionalNotSupplied(form, f), rejected: x.rejected, errors: x.errors, warnings: x.warnings, notes: x.notes, replace: x.replace };

  if (form === "product-segment") {
    const code = val<string>("productCode"), name = val<string>("productName");
    let productId: string | null = null;
    if (code || name) {
      const rows = await searchProducts(api, (code ?? name)!, { eligibleOnly: true, limit: 25 });
      const p = pick("Product", (code ?? name)!, rows, r => r.productCode);
      refs.push(p.ref);
      if (!p.hit && !rows.length) {
        const any = await searchProducts(api, (code ?? name)!, { eligibleOnly: false, limit: 5 });
        if (any.length) p.ref.message += ` "${any[0].name}" exists but has no active term-defined selling model, so it can't be ramped.`;
      }
      if (p.hit) { productId = p.hit.id; set("productId", p.hit.id, "salesforce"); set("productName", p.hit.name, "salesforce"); }
    } else if (ctx.productId) { productId = ctx.productId; refs.push({ field: "Product", status: "selected", id: ctx.productId, message: `Using the selected product "${ctx.productName ?? ctx.productId}".` }); }
    else refs.push({ field: "Product", status: "missing", message: "No product named — name it in the prompt or pick it." });
    if (productId) {
      const [product, models, segments] = await Promise.all([productFacts(api, [productId]).then(m => m.get(productId!) ?? null), sellingModels(api, productId), productRampSegments(api, [productId])]);
      const elig = productEligibility(product, models, segments);
      for (const r of elig.reasons) (r.severity === "error" ? x.errors : x.warnings).push(r.message);
      const smName = val<string>("sellingModelName");
      if (smName) {
        const m = pick("Selling model", smName, elig.termModels);
        refs.push(m.ref);
        if (!m.hit && models.some(mm => lc(mm.name) === lc(smName))) m.ref.message = `"${smName}" is not a term-defined selling model of this product — Product Ramp Segments need one (${elig.termModels.map(t => t.name).join(", ") || "none available"}).`;
        if (m.hit) set("sellingModelId", m.hit.id, "salesforce");
      } else if (elig.termModels.length === 1) { set("sellingModelId", elig.termModels[0].id, "salesforce"); refs.push({ field: "Selling model", status: "resolved", id: elig.termModels[0].id, message: `Selling model: "${elig.termModels[0].name}" — the product's only term-defined selling model.` }); }
      else refs.push({ field: "Selling model", status: elig.termModels.length ? "ambiguous" : "not-found", message: elig.termModels.length ? `The product has ${elig.termModels.length} term-defined selling models — choose one.` : "The product has no active term-defined selling model.", candidates: elig.termModels.map(t => ({ id: t.id, name: t.name })) });
      const st = val<string>("segmentType");
      if (st) {
        const caps = await capabilities(api);
        if (!caps.productRampSegment.segmentTypes.includes(st)) { x.errors.push(`Segment type "${st}" isn't one of this org's values (${caps.productRampSegment.segmentTypes.join(", ")}).`); delete f.segmentType; }
        else if (segments.some(s => s.sellingModelId === patch.sellingModelId && s.segmentType === st)) x.warnings.push(`This product already has a ${st} segment for that selling model — creating it again will reuse the existing record.`);
      }
    }
    fromField("segmentType"); fromField("trialDuration"); fromField("durationType");
    if (!patch.productId && !ctx.productId) res.missingRequired.push("Product");
    if (!patch.sellingModelId) res.missingRequired.push("Selling model");
    if (!patch.segmentType) res.missingRequired.push("Segment type");
    if (patch.segmentType === "FreeTrial" && !patch.trialDuration) res.missingRequired.push("Trial duration");
    return res;
  }

  // Schedule values (schedule form, and the schedule inside deal forms)
  const sched: Record<string, unknown> = {};
  const schedSrc: Record<string, AiSource> = {};
  const setS = (k: string, from = k) => { if (f[from]) { sched[k] = f[from].value; schedSrc[k] = f[from].source; } };
  let template: RampSchedule | null = null;
  const sName = val<string>("scheduleName");
  if (sName && form !== "schedule") {
    const m = pick("Ramp schedule", sName, schedules.map(s => ({ ...s, id: s.id, name: s.name })));
    refs.push({ ...m.ref, message: m.hit ? `Saved schedule "${m.hit.name}" (v${m.hit.version}) applied; values stated in the prompt override it.` : m.ref.message });
    if (m.hit) { template = m.hit; const { id, createdAt: _c, updatedAt: _u, createdBy: _b, version: _v, ...body } = m.hit; void _c; void _u; void _b; void _v; Object.assign(sched, body); for (const k of Object.keys(body)) schedSrc[k] = "inferred"; set("scheduleId", id, "salesforce"); }
  }
  for (const k of ["period", "customMonths", "segments", "trialMonths", "priceChange", "defaultChange", "upliftMethod", "basePriceMultiplier", "overrides"]) setS(k);
  if (f.freeTrial?.value === false) { sched.trialMonths = null; schedSrc.trialMonths = f.freeTrial.source; }
  if (template && f.contractMonths && !f.segments) x.warnings.push("The saved schedule's segment count was kept; check it against the contract length.");

  if (form === "schedule") {
    fromField("name"); fromField("description");
    for (const [k, v] of Object.entries(sched)) set(k, v, schedSrc[k]);
    if (!patch.name && !ctx.name) res.missingRequired.push("Schedule name");
    if (!patch.period && !ctx.scheduleSet) res.missingRequired.push("Period");
    if (!patch.segments && !ctx.scheduleSet) res.missingRequired.push("Number of segments");
    if (patch.period === "Custom" && !patch.customMonths) res.missingRequired.push("Segment duration (months)");
    return res;
  }

  // Deal + group deal
  if (Object.keys(sched).length) { patch.schedule = sched; sources.schedule = Object.values(schedSrc).includes("explicit") ? "explicit" : "inferred"; }
  fromField("dealName", "name"); fromField("contractStart"); fromField("contractEnd"); fromField("periodBoundary"); fromField("baseQuantity");

  // Account
  let accountId = ctx.accountId ?? null;
  const acctName = val<string>("accountName");
  if (acctName) {
    const a = pick("Account", acctName, await searchAccounts(api, acctName));
    refs.push(a.ref);
    if (a.hit) { accountId = a.hit.id; set("accountId", a.hit.id, "salesforce"); set("accountName", a.hit.name, "salesforce"); }
  } else refs.push(ctx.accountId ? { field: "Account", status: "selected", id: ctx.accountId, message: `Using the selected account "${ctx.accountName ?? ctx.accountId}".` } : { field: "Account", status: "not-mentioned", message: "No account mentioned (optional — it narrows the quote search)." });

  // Quote (Draft only)
  let quoteId: string | null = null;
  const qName = val<string>("quoteName");
  if (qName) {
    const rows = (await searchQuotes(api, { accountId, q: qName, pageSize: 25 })).rows;
    const q = pick("Quote", qName, rows, r => r.quoteNumber);
    refs.push(q.ref);
    if (q.hit) { quoteId = q.hit.id; set("quoteId", q.hit.id, "salesforce"); set("quoteName", q.hit.quoteNumber ? `${q.hit.name} · #${q.hit.quoteNumber}` : q.hit.name, "salesforce"); }
  } else if (ctx.quoteId) { quoteId = ctx.quoteId; refs.push({ field: "Quote", status: "selected", id: ctx.quoteId, message: `Using the selected quote "${ctx.quoteName ?? ctx.quoteId}".` }); }
  else refs.push({ field: "Quote", status: "missing", message: f.useSelectedQuote ? "The prompt refers to the selected quote, but no quote is selected yet — pick one." : "No quote named — name it (or its number) or pick it." });

  if (form === "deal" && quoteId) {
    const lines = (await quoteLines(api, quoteId)).filter(l => !l.rampIdentifier);
    const pName = val<string>("productName");
    const sameQuote = quoteId === ctx.quoteId;
    let line: (typeof lines)[number] | null = null;
    if (pName) {
      const rows = lines.map(l => ({ id: l.id, name: l.productName ?? l.id, l })).filter(r => lc(r.name).includes(lc(pName)) || lc(pName).includes(lc(r.name)));
      const m = pick("Quote line", pName, rows, r => `${r.l.startDate ?? "?"} → ${r.l.endDate ?? "?"} · qty ${r.l.quantity ?? "?"}`);
      if (!rows.length) m.ref.message = `No un-ramped line for "${pName}" on this quote.`;
      refs.push(m.ref); line = m.hit?.l ?? null;
    } else if (sameQuote && ctx.lineId) { refs.push({ field: "Quote line", status: "selected", id: ctx.lineId, message: "Using the selected quote line." }); }
    else if (lines.length === 1) { line = lines[0]; refs.push({ field: "Quote line", status: "resolved", id: line.id, message: `Quote line: "${line.productName}" — the quote's only un-ramped line.` }); }
    else refs.push({ field: "Quote line", status: lines.length ? "ambiguous" : "not-found", message: lines.length ? `The quote has ${lines.length} un-ramped lines — name the product or pick the line.` : "The quote has no un-ramped lines.", candidates: lines.slice(0, 8).map(l => ({ id: l.id, name: l.productName ?? l.id, detail: `${l.startDate ?? "?"} → ${l.endDate ?? "?"}` })) });
    if (line) {
      set("lineId", line.id, "salesforce"); set("productId", line.productId, "salesforce"); set("productName", line.productName, "salesforce"); set("sellingModelId", line.sellingModelId, "salesforce");
      if (line.unitPrice !== null) set("basePrice", line.unitPrice, "salesforce");
      if (!f.baseQuantity && line.quantity !== null) set("baseQuantity", line.quantity, "salesforce");
      if ((f.contractStart && f.contractStart.value !== line.startDate) || (f.contractEnd && f.contractEnd.value !== line.endDate)) x.warnings.push(`A line ramp uses the quote line's own dates (${line.startDate} → ${line.endDate}); the dates in the prompt were not applied.`);
      if (line.startDate) set("contractStart", line.startDate, "salesforce");
      if (line.endDate) set("contractEnd", line.endDate, "salesforce");
      const smName = val<string>("sellingModelName");
      if (smName && line.productId) {
        const models = await sellingModels(api, line.productId);
        const lm = models.find(m => m.id === line!.sellingModelId);
        if (lm && !lc(lm.name).includes(lc(smName)) && !lc(smName).includes(lc(lm.name))) x.warnings.push(`The line's selling model is "${lm.name}", not "${smName}" — a ramp keeps the line's selling model.`);
      }
    }
  }
  if (form === "group-deal" && quoteId) {
    const groups = (await quoteGroups(api, quoteId)).filter(g => !g.isRamped);
    const gName = val<string>("groupName");
    if (gName) {
      const m = pick("Quote line group", gName, groups.filter(g => lc(g.name).includes(lc(gName)) || lc(gName).includes(lc(g.name))));
      refs.push(m.ref);
      if (m.hit) { set("groupId", m.hit.id, "salesforce"); set("groupName", m.hit.name, "salesforce"); }
    } else if (quoteId === ctx.quoteId && ctx.groupId) refs.push({ field: "Quote line group", status: "selected", id: ctx.groupId, message: `Using the selected group "${ctx.groupName ?? ctx.groupId}".` });
    else if (groups.length === 1) { set("groupId", groups[0].id, "salesforce"); set("groupName", groups[0].name, "salesforce"); refs.push({ field: "Quote line group", status: "resolved", id: groups[0].id, message: `Quote line group: "${groups[0].name}" — the quote's only un-ramped group.` }); }
    else refs.push({ field: "Quote line group", status: groups.length ? "ambiguous" : "not-found", message: groups.length ? `The quote has ${groups.length} un-ramped groups — name one or pick it.` : "The quote has no un-ramped quote line groups.", candidates: groups.slice(0, 8).map(g => ({ id: g.id, name: g.name })) });
  }

  const has = (k: string, c?: unknown) => patch[k] !== undefined && patch[k] !== null ? true : !!c;
  if (!has("name", ctx.name)) res.missingRequired.push("Deal name");
  if (!has("quoteId", ctx.quoteId)) res.missingRequired.push("Quote");
  if (form === "deal" && !has("lineId", quoteId === ctx.quoteId ? ctx.lineId : null)) res.missingRequired.push("Quote line");
  if (form === "group-deal" && !has("groupId", quoteId === ctx.quoteId ? ctx.groupId : null)) res.missingRequired.push("Quote line group");
  if (form === "group-deal" && !has("contractStart")) res.missingRequired.push("Contract start");
  if (form === "group-deal" && !has("contractEnd")) res.missingRequired.push("Contract end");
  if (!sched.period && !ctx.scheduleSet) res.missingRequired.push("Period");
  if (!sched.segments && !ctx.scheduleSet) res.missingRequired.push("Number of segments");
  res.missingRequired = res.missingRequired.filter(m => RAMP_AI_REQUIRED[form].includes(m) || m === "Segment duration (months)");
  return res;
}
