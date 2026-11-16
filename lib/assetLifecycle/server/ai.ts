import type Anthropic from "@anthropic-ai/sdk";
import { callClaude } from "@/lib/billing/server/ai";
import type { RampApi } from "@/lib/ramp/server/api";
import { soql } from "@/lib/ramp/server/api";
import { searchCatalog } from "@/lib/ramp/server/catalog";
import { LIFECYCLE_AI_SYSTEM, normalizeExtraction, parseAddressText, ruleExtract, type AiField, type AiIssue, type AiLifecycleResult, type PromptExtraction, type PromptItem } from "../ai";
import { snapshotOf, validateTransaction } from "../plan";
import { KIND_LABEL, type AssetChange, type AssetRow, type LifecycleKind, type PostalAddress } from "../types";
import { addressText } from "../billing";
import { accountContracts, billingOptions, listAssets } from "./reads";

/**
 * Prompt → editable lifecycle draft. The AI (or the rules parser) only EXTRACTS what the user said; every account, contract, asset and
 * product is resolved by querying the connected org by NAME — an Id from a prompt is never used — and every value is validated with
 * the module's own eligibility / plan rules. Missing, ambiguous, invalid and unsupported items are reported. Nothing is saved or sent.
 */
export type LifecycleAiResult = AiLifecycleResult<AssetRow, AssetChange>;

export async function extractPrompt(prompt: string, today: string, anthropic: Anthropic | null): Promise<{ engine: "ai" | "rules"; raw: Record<string, unknown>; warning: string | null }> {
  if (!anthropic) return { engine: "rules", raw: ruleExtract(prompt, today), warning: null };
  try {
    return { engine: "ai", raw: await callClaude(anthropic, LIFECYCLE_AI_SYSTEM, `Today is ${today}.\n\n${prompt}`, 1200), warning: null };
  } catch (e) {
    // The AI call failed (key, network, quota): fall back to the rules parser and SAY so — never a silent substitute.
    return { engine: "rules", raw: ruleExtract(prompt, today), warning: `The AI request failed (${e instanceof Error ? e.message : String(e)}); the built-in rules parser was used instead.` };
  }
}

export async function aiLifecycleDraft(api: RampApi, prompt: string, kindHint: LifecycleKind | null, today: string, anthropic: Anthropic | null): Promise<LifecycleAiResult> {
  const { engine, raw, warning } = await extractPrompt(prompt, today, anthropic);
  const result = await resolvePrompt(api, normalizeExtraction(raw), { prompt, kindHint, today, engine });
  if (warning) result.issues.unshift({ field: "AI", status: "warning", message: warning });
  return result;
}

const lc = (s: string) => s.trim().toLowerCase();
const RULES_MARKER = "__MATCH_ACCOUNT_ASSETS__";

/** Resolution against Salesforce (exported for tests — no AI involved). */
export async function resolvePrompt(api: RampApi, x: PromptExtraction, o: { prompt: string; kindHint: LifecycleKind | null; today: string; engine: "ai" | "rules" }): Promise<LifecycleAiResult> {
  const issues: AiIssue[] = x.rejected.map(m => ({ field: "Prompt", status: "invalid" as const, message: m }));
  const fields: AiField[] = [];
  const kind = x.kind ?? o.kindHint;
  const kindMismatch = !!(x.kind && o.kindHint && x.kind !== o.kindHint);
  if (!kind) issues.push({ field: "Type", status: "missing", message: "The prompt doesn't say whether to amend, renew or cancel." });
  if (kindMismatch) issues.push({ field: "Type", status: "warning", message: `The prompt asks for a ${KIND_LABEL[x.kind!].toLowerCase()}, not a ${KIND_LABEL[o.kindHint!].toLowerCase()} — open it as a ${KIND_LABEL[x.kind!].toLowerCase()}.` });
  if (kind) fields.push({ label: "Transaction type", value: KIND_LABEL[kind], source: x.kind ? "prompt" : "derived" });
  if (x.name) fields.push({ label: "Name", value: x.name, source: "prompt" });
  for (const n of x.notes) issues.push({ field: "Note", status: "warning", message: n });

  const result: LifecycleAiResult = {
    engine: o.engine, kind, kindMismatch, fields, issues, extraction: x,
    prefill: { name: x.name, account: null, contractId: null, contractNumber: null, assets: [], changes: [], effectiveDate: null, renewal: null, cancelReason: x.cancelReason },
  };

  // Account — by name, preferring accounts that own lifecycle assets. Never an Id from the prompt.
  if (!x.accountName) { issues.push({ field: "Account", status: "missing", message: "No account named — choose it in step 1." }); return finish(result, kind, o.today); }
  const term = x.accountName.replace(/[%_]/g, "").slice(0, 80);
  const accts = await api.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Account WHERE Name LIKE ${soql(`%${term}%`)} ORDER BY Name LIMIT 25`);
  const withAssets = accts.length ? new Set((await api.query<{ AccountId: string }>(`SELECT AccountId FROM Asset WHERE HasLifecycleManagement = true AND AccountId IN (${accts.map(a => soql(a.Id)).join(",")}) LIMIT 2000`).catch(() => [])).map(r => r.AccountId)) : new Set<string>();
  const exact = accts.filter(a => lc(a.Name) === lc(x.accountName!));
  const pool = exact.length ? exact : accts;
  const pref = pool.filter(a => withAssets.has(a.Id));
  const account = pool.length === 1 ? pool[0] : pref.length === 1 ? pref[0] : null;
  if (!account) {
    issues.push({ field: "Account", status: accts.length ? "ambiguous" : "not-found", message: accts.length ? `"${x.accountName}" matches ${accts.length} accounts — choose one.` : `No account named "${x.accountName}" in this org.`, candidates: accts.slice(0, 8).map(a => ({ id: a.Id, name: a.Name, detail: withAssets.has(a.Id) ? "has lifecycle assets" : "no lifecycle assets" })) });
    return finish(result, kind, o.today);
  }
  result.prefill.account = { id: account.Id, name: account.Name };
  fields.push({ label: "Account", value: account.Name, source: "salesforce" });
  if (!withAssets.has(account.Id)) issues.push({ field: "Account", status: "warning", message: `${account.Name} owns no lifecycle-managed assets.` });

  if (x.contractName) {
    const cs = await accountContracts(api, account.Id);
    const c = cs.filter(k => lc(k.contractNumber ?? "") === lc(x.contractName!) || lc(k.name).includes(lc(x.contractName!)));
    if (c.length === 1) { result.prefill.contractId = c[0].id; result.prefill.contractNumber = c[0].contractNumber; fields.push({ label: "Contract", value: c[0].name, source: "salesforce" }); }
    else issues.push({ field: "Contract", status: c.length ? "ambiguous" : "not-found", message: c.length ? `"${x.contractName}" matches ${c.length} contracts of ${account.Name}.` : `${account.Name} has no contract "${x.contractName}".`, candidates: (c.length ? c : cs).slice(0, 8).map(k => ({ id: k.id, name: k.name })) });
  }

  // Assets — the account's REAL assets, matched by asset or product name.
  // Bill-To Contact → a REAL contact of this account (never invented); addresses parsed from the prompt (reviewed / edited on the form).
  if (x.billTo || x.billingAddress || x.shippingAddress || x.shippingSameAsBilling) {
    const billing: { billToContactId: string | null; billToContactName: string | null; billingAddress: PostalAddress | null; shippingAddress: PostalAddress | null } = { billToContactId: null, billToContactName: null, billingAddress: parseAddressText(x.billingAddress), shippingAddress: null };
    billing.shippingAddress = x.shippingSameAsBilling ? billing.billingAddress : parseAddressText(x.shippingAddress);
    if (x.billTo) {
      const contacts = (await billingOptions(api, account.Id)).contacts;
      const n = lc(x.billTo);
      let m = contacts.filter(c => lc(c.name) === n);
      if (!m.length) m = contacts.filter(c => lc(c.name).includes(n) || n.includes(lc(c.name)));
      if (m.length === 1) { billing.billToContactId = m[0].id; billing.billToContactName = m[0].name; fields.push({ label: "Bill-To Contact", value: m[0].name, source: "salesforce" }); }
      else issues.push({ field: "Bill-To Contact", status: m.length ? "ambiguous" : "not-found", message: m.length ? `"${x.billTo}" matches ${m.length} contacts of ${account.Name} — choose one.` : `${account.Name} has no contact named "${x.billTo}".`, candidates: (m.length ? m : contacts).slice(0, 8).map(c => ({ id: c.id, name: c.name, detail: c.email ?? undefined })) });
    }
    for (const [label, raw, parsed] of [["Billing address", x.billingAddress, billing.billingAddress], ["Shipping address", x.shippingAddress, x.shippingSameAsBilling ? null : billing.shippingAddress]] as const) {
      if (!raw) continue;
      if (parsed) fields.push({ label, value: addressText(parsed), source: "prompt" });
      else issues.push({ field: label, status: "invalid", message: `Couldn't split "${raw}" into street, city and country — enter it on the form.` });
    }
    if (x.shippingSameAsBilling && billing.shippingAddress) fields.push({ label: "Shipping address", value: "Same as billing address", source: "prompt" });
    if (billing.billToContactId || billing.billingAddress || billing.shippingAddress) result.prefill.billing = billing;
  }
  const rows = (await listAssets(api, { accountId: account.Id, pageSize: 100, contractId: result.prefill.contractId }, o.today)).rows;
  const items: PromptItem[] = x.items.flatMap(it => {
    if (it.name !== RULES_MARKER) return [it];
    // Rules parser: the account's asset / product names that occur in the prompt (longest first, each once).
    const text = lc(o.prompt);
    const names = [...new Set(rows.flatMap(r => [r.name, r.productName ?? ""]).filter(Boolean))].sort((a, b) => b.length - a.length);
    const found: string[] = [];
    let rest = text;
    for (const n of names) { if (rest.includes(lc(n))) { found.push(n); rest = rest.split(lc(n)).join(" "); } }
    return found.map(n => ({ ...it, name: n }));
  });
  if (!items.length) issues.push({ field: "Assets", status: "missing", message: `No asset of ${account.Name} is named in the prompt — select the assets in step 2.`, candidates: rows.slice(0, 12).map(r => ({ id: r.id, name: r.name, detail: `qty ${r.quantity ?? "?"}` })) });

  const eff = kind === "renew" ? x.renewal.startDate ?? x.effectiveDate : x.effectiveDate;
  if (eff) { result.prefill.effectiveDate = eff; fields.push({ label: kind === "renew" ? "Renewal start" : kind === "cancel" ? "Cancellation date" : "Effective date", value: eff, source: "prompt" }); }
  else if (kind && kind !== "renew") issues.push({ field: "Effective date", status: "missing", message: `No ${kind === "cancel" ? "cancellation" : "effective"} date in the prompt — set it in step 4.` });
  if (kind === "renew") {
    result.prefill.renewal = { endDate: x.renewal.endDate, termMonths: x.renewal.termMonths };
    if (x.renewal.termMonths) fields.push({ label: "Renewal term", value: `${x.renewal.termMonths} month(s)`, source: "prompt" });
    if (x.renewal.endDate) fields.push({ label: "Renewal end", value: x.renewal.endDate, source: "prompt" });
  }
  if (kind === "cancel" && x.cancelReason) fields.push({ label: "Cancellation reason", value: x.cancelReason, source: "prompt" });

  for (const it of items) {
    const n = lc(it.name);
    let matches = rows.filter(r => lc(r.name) === n || lc(r.productName ?? "") === n);
    if (!matches.length) matches = rows.filter(r => lc(r.name).includes(n) || lc(r.productName ?? "").includes(n));
    // Several assets of the same product: the stated current quantity, then this lifecycle's eligibility, narrow it down.
    if (matches.length > 1 && it.fromQuantity !== null) { const q = matches.filter(r => r.quantity === it.fromQuantity); if (q.length) matches = q; }
    if (matches.length > 1 && kind) { const ok = matches.filter(r => !r.eligibility[kind].some(e => e.severity === "error")); if (ok.length) matches = ok; }
    if (matches.length !== 1) {
      issues.push({ field: `Asset "${it.name}"`, status: matches.length ? "ambiguous" : "not-found", message: matches.length ? `"${it.name}" matches ${matches.length} assets of ${account.Name} — choose one.` : `${account.Name} has no lifecycle asset named "${it.name}".`, candidates: (matches.length ? matches : rows).slice(0, 8).map(r => ({ id: r.id, name: r.name, detail: `qty ${r.quantity ?? "?"} · ${r.sellingModel?.type ?? "no selling model"}${r.originOrder?.number ? ` · order ${r.originOrder.number}` : ""}` })) });
      continue;
    }
    const a = matches[0];
    if (result.prefill.assets.some(r => r.id === a.id)) continue;
    result.prefill.assets.push(a);
    fields.push({ label: `Asset`, value: `${a.name} (Salesforce quantity ${a.quantity ?? "?"}, ${a.sellingModel?.name ?? "no selling model"})`, source: "salesforce" });
    if (kind) for (const e of a.eligibility[kind]) issues.push({ field: a.name, status: e.severity === "error" ? "unsupported" : "warning", message: e.message });
    const change: AssetChange = { assetId: a.id, quantityChange: 0 };
    if (kind === "amend") {
      if (it.fromQuantity !== null && a.quantity !== null && it.fromQuantity !== a.quantity) issues.push({ field: a.name, status: "invalid", message: `The prompt says ${a.name} is at ${it.fromQuantity}, but Salesforce shows ${a.quantity}. The change is computed from Salesforce's quantity — check it.` });
      if (it.toQuantity !== null && a.quantity !== null) { change.quantityChange = it.toQuantity - a.quantity; fields.push({ label: `${a.name} quantity`, value: `${a.quantity} → ${it.toQuantity} (change ${change.quantityChange >= 0 ? "+" : ""}${change.quantityChange})`, source: "derived" }); }
      else if (it.quantityChange !== null) { change.quantityChange = it.quantityChange; fields.push({ label: `${a.name} quantity change`, value: `${it.quantityChange >= 0 ? "+" : ""}${it.quantityChange}`, source: "prompt" }); }
      if (it.billingFrequency) { change.billingFrequency = it.billingFrequency; fields.push({ label: `${a.name} billing frequency`, value: it.billingFrequency, source: "prompt" }); }
      if (it.endDate) { change.endDate = it.endDate; fields.push({ label: `${a.name} end date`, value: it.endDate, source: "prompt" }); }
      if (it.swap) {
        const cat = await searchCatalog(api, { q: it.swap.productName, pricebookId: a.pricebookId, inPricebookOnly: !!a.pricebookId, pageSize: 20 }).catch(() => ({ rows: [] }));
        const exactP = cat.rows.filter(r => lc(r.name) === lc(it.swap!.productName));
        const prods = exactP.length ? exactP : cat.rows;
        const prod = prods.length === 1 ? prods[0] : null;
        const opts = prod ? prod.options.filter(op => op.usable) : [];
        if (!prod || opts.length !== 1) issues.push({ field: `${it.swap.kind} product`, status: prod ? "ambiguous" : prods.length ? "ambiguous" : "not-found", message: !prods.length ? `No active product "${it.swap.productName}" in ${a.name}'s price book.` : !prod ? `"${it.swap.productName}" matches ${prods.length} products — choose it in step 3.` : `${prod.name} has ${opts.length} usable price book entries (selling models) — choose one in step 3.`, candidates: prods.slice(0, 8).map(r => ({ id: r.id, name: r.name })) });
        else {
          change.swap = { kind: it.swap.kind, productId: prod.id, productName: prod.name, pricebookEntryId: opts[0].pricebookEntryId, quantity: it.swap.quantity ?? a.quantity ?? 1, billingFrequency: opts[0].billingFrequency };
          fields.push({ label: `${a.name} ${it.swap.kind}`, value: `→ ${prod.name} (${opts[0].sellingModelName ?? "no selling model"}) × ${change.swap.quantity}`, source: "salesforce" });
        }
      }
    }
    if (kind === "amend" || kind === "renew") {
      const price = it.unitPrice ?? x.unitPrice, disc = it.discount ?? x.discount;
      if (price !== null) { change.unitPrice = price; fields.push({ label: `${a.name} unit price`, value: `${a.unitPrice ?? "—"} → ${price}`, source: "prompt" }); }
      if (disc !== null) { change.discount = disc; fields.push({ label: `${a.name} discount`, value: `${disc}%`, source: "prompt" }); }
    }
    if (kind === "cancel" && (it.toQuantity !== null || it.quantityChange !== null)) issues.push({ field: a.name, status: "unsupported", message: `initiateCancellation cancels the whole asset — a partial reduction of ${a.name} is an amendment. Use Amendments to reduce the quantity.` });
    if (kind !== "cancel") result.prefill.changes.push(change);
  }
  return finish(result, kind, o.today);
}

/** Final check: the module's own plan validation over the prefill (eligibility errors were reported per asset above). */
function finish(r: LifecycleAiResult, kind: LifecycleKind | null, today: string): LifecycleAiResult {
  if (!kind || !r.prefill.account || !r.prefill.assets.length) return r;
  const problems = validateTransaction({
    kind, accountId: r.prefill.account.id, contractId: r.prefill.contractId, effectiveDate: r.prefill.effectiveDate ?? "", amendSubtype: null,
    assets: r.prefill.assets.map(a => snapshotOf(a)), changes: r.prefill.changes, adds: [],
    renewal: kind === "renew" ? { endDate: r.prefill.renewal?.endDate ?? null, termMonths: r.prefill.renewal?.termMonths ?? null, ramp: null } : null,
    cancel: kind === "cancel" ? { reason: r.prefill.cancelReason, reasonField: null } : null,
  }, null, today);
  const known = new Set(r.issues.map(i => i.message));
  for (const p of problems) if (!known.has(p)) r.issues.push({ field: "Plan", status: "invalid", message: p });
  return r;
}
