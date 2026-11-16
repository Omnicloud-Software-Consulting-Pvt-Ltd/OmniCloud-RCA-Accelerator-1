import type { SalesforceClient } from "@/lib/salesforce/client";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { getProductTaxReadiness, latestInvoiceForProduct, verifyInvoiceLineTax, type InvoiceLineTaxVerification, type ProductTaxReadiness } from "@/lib/tax/server/pipeline";
import { runEndToEndTaxValidation, type E2EResult } from "@/lib/tax/server/e2e";
import { calculateSalesforceTax, sfTaxApiFor, type SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";
import { loadCalculationPlan, type CalculationPlan } from "@/lib/tax/server/calculationPlan";
import { BadInputError } from "@/lib/billing/server/payments";
import { readSalesforceTax } from "@/lib/tax/server/salesforceTaxCalculation";
import { decisionTableRefresh, type RefreshTableView } from "@/lib/tax/server/refreshApproval";
import { soqlEscape } from "@/lib/salesforce/client";

/**
 * Natural-language CALCULATION / VERIFICATION commands for the Tax Configuration Assistant — kept apart from CONFIGURATION
 * commands (create/update/assign…), which go to the operations planner. A calculation or verification request is never turned
 * into a CREATE and never creates configuration; the billing-lifecycle validation is only previewed here (creating its order
 * needs a separate confirmation).
 *
 *   "Calculate tax for Desktop for OmniCloud Tax Test DE GmbH."            → salesforce-calculate (validate → confirm create-order)
 *   "Calculate German VAT for Desktop quantity 1."                          → salesforce-calculate (no account → validate + preview)
 *   "Preview tax for Desktop DS001 at 1149 for Germany."                    → salesforce-preview (Salesforce decision-table evaluation)
 *   "Show me the Salesforce tax result for invoice DOC-000000012."          → invoice-result (read-only)
 *   "Explain why tax was not calculated for invoice DOC-000000012."         → invoice-explain (read-only trace + preview)
 *   "Check whether Desktop is ready for tax calculation."                   → readiness
 *   "Run the complete tax validation for Desktop."                          → e2e (preview)
 *   "Show me why tax is not being calculated for Desktop."                  → explain
 *   "Show me the tax configuration used for the latest Desktop invoice."    → latest-invoice-config
 *   "Verify the InvoiceLineTax generated for Desktop."                      → verify-invoice-tax
 */

export type TaxQueryKind = "salesforce-calculate" | "salesforce-preview" | "invoice-result" | "invoice-explain" | "order-result" | "order-explain" | "decision-table" | "readiness" | "e2e" | "explain" | "latest-invoice-config" | "verify-invoice-tax";
export interface TaxQuery {
  kind: TaxQueryKind; product: string | null; productCode: string | null; quantity: number | null; unitPrice: number | null; country: string | null; state: string | null; account: string | null; invoiceNumber: string | null; noMutation: boolean;
  /** A Product2 Id given in the prompt. */
  productId?: string | null;
  /** An existing order the request is about (OrderNumber or Order Id from the prompt). */
  orderNumber?: string | null; orderId?: string | null;
  /** Tax details the user stated (never invented): tax code, rate %, application basis. */
  taxCode?: string | null; rate?: number | null; basis?: "Net" | "Gross" | null;
  /** configure = configuration only; calculate = calculate with what exists; both = complete the configuration, then calculate. */
  intent?: "configure" | "calculate" | "both";
  /** true = the user called it a test, false = a real business transaction, null = not said. */
  test?: boolean | null;
}

const CONFIG_VERB = /^\s*(please\s+)?(create|add|apply|configure|set ?up|assign|map|link|update|change|edit|rename|delete|remove|activate|deactivate|enable|disable|turn on|turn off|replace|end-?date)\b/i;
const STOP = /^(quantity|qty|tax|the|a|an|tax calculation|calculation|it|this|that|me)$/i;
const QUOTED = /["'“”‘’]([^"'“”‘’]{1,120})["'“”‘’]/;
const INVOICE_NO = /\b(DOC-\d{3,})\b|\binvoice (?:number |no\.? |#)?([A-Z]{2,5}-?\d{3,})\b/i;
/** "order 00000141" / "order number 141" / "order #00000141" / an Order Id. */
const ORDER_REF = /\border\s*(?:number\s*|no\.?\s*|#\s*)?(\d{3,10})\b|\border\s+(801[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\b/i;
const ORDER_ID = /\b(801[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\b/;
const COUNTRIES = /^(germany|india|united states|usa|us|united kingdom|uk|great britain|france|canada|australia|japan|spain|italy|netherlands|singapore|ireland|switzerland|austria|belgium|sweden|norway|denmark|mexico|brazil|new zealand)$/i;
const ADJECTIVE_COUNTRY: Record<string, string> = { german: "Germany", indian: "India", french: "France", british: "United Kingdom", american: "United States", canadian: "Canada", australian: "Australia", japanese: "Japan", spanish: "Spain", italian: "Italy", dutch: "Netherlands", irish: "Ireland", swiss: "Switzerland" };
const CODE_TOKEN = /^(.+?)\s+([A-Z]{1,6}-?\d{1,6})$/;

/** Canadian provinces/territories by name (a sale "in Ontario" is Ontario, Canada). */
const CA_PROVINCE = /^(ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland(?: and labrador)?|prince edward island|northwest territories|nunavut|yukon)$/i;
const PRODUCT_ID = /\b(01t[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\b/;
/** "the existing Mouse product" → "Mouse". */
const cleanProduct = (c: string | null) => { const x = c?.replace(/^(?:the\s+)?(?:existing\s+|current\s+)?(?:product\s+)?(?:code\s+)?/i, "").replace(/\s+product$/i, "").trim(); return x ? x : null; };
/** A combined request ("configure … and calculate the tax … invoice") is a calculation request whose plan includes the configuration. */
const COMBINED = /\bcalculat\w*\b[^.]*\btax\b|\btax\b[^.]*\bcalculat/i;

export function parseTaxQuery(prompt: string): TaxQuery | null {
  const p = prompt.trim();
  if (!p) return null;
  const combined = CONFIG_VERB.test(p) && COMBINED.test(p) && /\b(invoice|billing|salesforce)\b/i.test(p);
  if (CONFIG_VERB.test(p) && !combined) return null;
  const low = p.toLowerCase();
  let kind: TaxQueryKind | null = null;
  const inv = INVOICE_NO.exec(p);
  const invoiceNumber = inv ? (inv[1] ?? inv[2]).toUpperCase() : null;
  const ord = ORDER_REF.exec(p);
  const orderNumber = ord?.[1] ?? null, orderId = ord?.[2] ?? ORDER_ID.exec(p)?.[1] ?? null;
  const why = /\b(why|explain|reason|diagnos|not applied|no tax|zero tax)/.test(low);
  // "this order" / "this invoice" without a number: still an order/invoice request — the answer asks which one (never guessed).
  const thisOrder = !orderNumber && !orderId && /\b(this|that|the|my) order\b/.test(low) && !/\b(create|new)\b[^.]*\border\b/.test(low);
  const thisInvoice = !invoiceNumber && /\b(this|that|the|my) invoice\b/.test(low) && !/\bgenerate\b[^.]*\binvoice\b/.test(low);
  // An order by number / Id: the Salesforce state of its tax (read-only) or why it has no tax.
  if ((orderNumber || orderId || thisOrder) && why) kind = "order-explain";
  else if ((orderNumber || orderId || thisOrder) && /\b(tax|calculat|show|result|check|verify)/.test(low)) kind = "order-result";
  // An invoice by number: its Salesforce result (read-only) or why it has no tax (read-only trace + preview).
  else if ((invoiceNumber || thisInvoice) && why) kind = "invoice-explain";
  else if (thisInvoice && /\b(tax|calculat|show|result|check|verify)/.test(low)) kind = "invoice-result";
  else if (/\bdecision ?tables?\b/.test(low) && /\b(latest|current|fresh|stale|contain|up to date|up-to-date|refresh|newest)\b/.test(low)) kind = "decision-table";
  else if (/\bwhat(?:'s| is| are) missing\b|\bmissing before\b|\bbefore calculating\b/.test(low)) kind = "salesforce-calculate";
  else if (invoiceNumber && /\b(why|explain|reason|diagnos)/.test(low)) kind = "invoice-explain";
  else if (invoiceNumber && /\b(tax|result|show|what|check)\b/.test(low)) kind = "invoice-result";
  else if (/\bpreview\b[^.]*\b(tax|vat|gst)\b/.test(low)) kind = "salesforce-preview";
  // REAL Salesforce calculation (order → invoice → InvoiceLineTax) — checked first so it never becomes local arithmetic.
  else if (/\b(actual|real)\b[^.]*\b(salesforce\s+)?tax\b|\btax\b[^.]*\busing salesforce\b|\bsalesforce tax calculation\b|\bbilling tax calculation\b/.test(low)) kind = "salesforce-calculate";
  else   if (/\b(complete|full|end[- ]to[- ]end)\b[^.]*\b(validation|flow|test|run|pipeline|check)\b|\bbilling lifecycle\b/.test(low)) kind = "e2e";
  else if (/\bwhy\b[^.]*\b(tax\b[^.]*\bnot\b|no tax\b|zero tax\b)/.test(low)) kind = "explain";
  else if (/\btax configuration used\b|\bconfiguration used for\b[^.]*\binvoice\b|\blatest\b[^.]*\binvoice\b[^.]*\btax\b/.test(low)) kind = "latest-invoice-config";
  else if (/\binvoice ?line ?tax\b/.test(low) && /\b(verify|check|show|validate)\b/.test(low)) kind = "verify-invoice-tax";
  else if (/\bready for (tax|calculation)|\btax readiness\b|\bready to calculate\b|\bready to be taxed\b/.test(low)) kind = "readiness";
  // Every other calculation request goes to the deterministic Tax Calculation service as well (never local arithmetic).
  else if (/\bcalculate\b[^.]*\b(tax|vat|gst)\b|\btax calculation for\b/.test(low)) kind = "salesforce-calculate";
  if (combined) kind = "salesforce-calculate";
  if (!kind) return null;
  let product: string | null = QUOTED.exec(p)?.[1]?.trim() ?? null;
  const notStop = (m: string | undefined) => { const c = m?.trim(); return c && !STOP.test(c) ? c : null; };
  if (!product) product = notStop(/\b(?:whether|is|are) (?:the )?(?:product )?(.+?) (?:is |are )?ready\b/i.exec(p)?.[1]);
  if (!product) product = notStop(/\bwhy (?:the )?(?:product )?(.+?) (?:has|have|gets|get|is|isn't|doesn't|does not|shows)\b/i.exec(p)?.[1]);
  if (!product) { const m = /\blatest (?:the )?(.+?) invoice\b/i.exec(p)?.[1]?.trim(); product = m && !/^(tax|the|an?)$/i.test(m) ? m : null; }
  if (!product) {
    for (const m of p.matchAll(/\bfor (?:the )?(?:product )?([A-Za-z0-9][\w\-' ]*?)(?=\s+(?:for|in|with|using|through|at|to|on|and|quantity|qty)\b|[.,;!?]|$)/g)) {
      const cand = m[1].trim();
      if (cand && !STOP.test(cand) && !/^(quantity|invoice)\b/i.test(cand) && !COUNTRIES.test(cand)) { product = cand; break; }
    }
  }
  product = cleanProduct(product);
  // "Desktop DS001" → product Desktop, product code DS001.
  let productCode: string | null = null;
  const code = product ? CODE_TOKEN.exec(product) : null;
  if (code) { product = code[1].trim(); productCode = code[2]; }
  const productId = PRODUCT_ID.exec(p)?.[1] ?? null;
  const explicitCode = /\bproduct ?code[:\s]+["'“]?([A-Za-z0-9][\w-]*)/i.exec(p)?.[1] ?? null;
  if (explicitCode) productCode = explicitCode;
  if (product && productId && product.includes(productId)) product = null;
  // A later "for X": a country ("for Germany") or the customer account ("for OmniCloud Tax Test DE GmbH").
  let forCountry: string | null = null, forAccount: string | null = null;
  for (const m of p.matchAll(/\bfor (?:the )?(?:account |customer )?([A-Za-z0-9][\w\-'&. ]*?)(?=\s+(?:for|in|with|using|through|at|on|and|quantity|qty)\b|[,;!?]|\.(?:\s|$)|$)/g)) {
    const cand = m[1].trim().replace(/\.$/, "");
    const asProduct = cleanProduct(cand);
    if (PRODUCT_ID.test(cand)) continue;
    if (!cand || STOP.test(cand) || /^(quantity|qty|invoice)\b/i.test(cand) || (product && (cand === product || asProduct === product || cand.startsWith(product + " ") || (asProduct ?? "").startsWith(product + " ")))) continue;
    if (COUNTRIES.test(cand)) forCountry ??= cand;
    else if (!/^(account|customer)$/i.test(cand)) forAccount ??= cand;
  }
  const adjective = /\b(german|indian|french|british|american|canadian|australian|japanese|spanish|italian|dutch|irish|swiss)\s+(?:vat|gst|sales tax|tax)\b/i.exec(p);
  const qty = /\bquantity (?:of )?(\d+(?:\.\d+)?)\b|\bqty:? ?(\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?) (?:units?|pcs|pieces)\b/i.exec(p);
  // "at 1149" is a price; "at 13%" is a rate.
  const price = /\bat (?:₹|\$|€|£|rs\.? ?|inr ?|usd ?|eur ?)?([\d,]+(?:\.\d+)?)(?![\d.,]|\s*%)/i.exec(p);
  const loc = /\bin ([A-Z][A-Za-z .'-]*?)(?:,\s*([A-Z][A-Za-z .'-]*?))?(?=\s+(?:for|using|with|at|through|and)\b|[.;!?]|$)/.exec(p);
  const account = /\b(?:to|[Ff]or [Aa]ccount|[Ff]or [Cc]ustomer)\s+(?:the )?(?:account |customer )?([A-Z0-9][\w &.'-]+?)(?=[.;!?]|$|\s+(?:for|in|at|using|with)\b)/.exec(p);
  const explicitAccount = account && account[1].trim() !== product ? account[1].trim() : null;
  // "in Ontario" → Ontario, Canada (a province alone is never read as a country).
  let country: string | null = loc ? (loc[2] ?? loc[1]).trim() : forCountry ?? (adjective ? ADJECTIVE_COUNTRY[adjective[1].toLowerCase()] : null);
  let state: string | null = loc && loc[2] ? loc[1].trim() : null;
  if (country && CA_PROVINCE.test(country) && !state) { state = country; country = "Canada"; }
  const rate = /\b(\d{1,2}(?:\.\d{1,4})?)\s*%/.exec(p);
  const taxCode = /\btax ?code[:\s]+["'“]?([A-Za-z0-9][\w-]*)/i.exec(p)?.[1] ?? null;
  const basis = /\b(net|gross)(?:\s+(?:application\s+)?basis)\b|\b(?:application\s+)?basis[:\s]+(net|gross)\b/i.exec(p);
  const configOnly = /\b(configuration|configure) only\b|\b(do not|don't|without) calculat|\bwhat(?:'s| is| are) missing\b|\bmissing before\b|\bbefore calculating\b/i.test(p);
  const orderKind = kind === "order-result" || kind === "order-explain";
  const wantsConfig = combined || /\b(missing configuration|reuse|configure|configuration)\b/i.test(p);
  return {
    kind, product: orderKind || kind === "decision-table" ? null : product, productCode: orderKind ? null : productCode, productId: orderKind ? null : productId, orderNumber, orderId,
    taxCode, rate: rate ? Number(rate[1]) : null, basis: basis ? ((basis[1] ?? basis[2]).toLowerCase() === "net" ? "Net" : "Gross") : null,
    intent: configOnly ? "configure" : wantsConfig ? "both" : "calculate",
    test: /\b(real|production|live) (business )?(transaction|sale|order)\b/i.test(p) ? false : /\b(as an?|for an?|this is an?|run an?) (test|trial)\b|\btest (run|transaction|sale|order|invoice)\b/i.test(p) ? true : null,
    quantity: qty ? Number(qty[1] ?? qty[2] ?? qty[3]) : null,
    unitPrice: price ? Number(price[1].replace(/,/g, "")) : null,
    country, state,
    account: invoiceNumber || orderKind || kind === "decision-table" ? null : explicitAccount ?? forAccount,
    invoiceNumber,
    noMutation: /\b(do not|don't|without) (create|creating|modify|modifying|change|changing)\b/i.test(p),
  };
}

export type TaxQueryAnswer =
  | { kind: "readiness" | "explain"; query: TaxQuery; readiness: ProductTaxReadiness; invoiceTax: InvoiceLineTaxVerification | null; message: string; plan?: CalculationPlan | null; planError?: string | null }
  | { kind: "e2e"; query: TaxQuery; e2e: E2EResult; message: string; plan?: CalculationPlan | null; planError?: string | null }
  | { kind: "salesforce-calculate" | "salesforce-preview" | "invoice-result" | "invoice-explain" | "order-result" | "order-explain"; query: TaxQuery; salesforce: SfTaxResult; message: string; plan?: CalculationPlan | null }
  | { kind: "decision-table"; query: TaxQuery; tables: RefreshTableView[]; message: string }
  /** The request names "this order" / "this invoice" (or a record that doesn't exist): which one is asked — never guessed. */
  | { kind: "needs-input"; query: TaxQuery; field: "order" | "invoice" | "product"; message: string }
  | { kind: "latest-invoice-config" | "verify-invoice-tax"; query: TaxQuery; readiness: ProductTaxReadiness | null; invoiceTax: InvoiceLineTaxVerification | null; message: string; plan?: CalculationPlan | null; planError?: string | null };

/**
 * Is this product-scoped answer blocked by something the plan can diagnose? Then the resolution plan is prepared automatically
 * (read-only) and attached — the user never has to ask for it separately.
 */
export function answerNeedsPlan(a: TaxQueryAnswer): boolean {
  if (!a.query.product && !a.query.productId && !a.query.productCode) return false;
  if ("plan" in a && a.plan) return false;
  switch (a.kind) {
    case "readiness": case "explain": return a.readiness.status !== "READY" || a.invoiceTax?.status === "FAILED";
    case "latest-invoice-config": case "verify-invoice-tax": return !!a.readiness && a.readiness.status !== "READY";
    case "e2e": return a.e2e.status === "BLOCKED" || a.e2e.status === "FAILED";
    case "salesforce-preview": case "salesforce-calculate": return a.salesforce.status === "NOT_READY" || (a.salesforce.status === "CALCULATION_FAILED" && !a.salesforce.run?.invoice);
    default: return false;
  }
}

/** Answer a calculation / verification command. Read-only, except asking Salesforce to calculate (no records are created). */
export async function answerTaxQuery(client: SalesforceClient, q: TaxQuery): Promise<TaxQueryAnswer> {
  const a = await answerTaxQueryCore(client, q);
  if (!answerNeedsPlan(a)) return a;
  // Recoverable blocker → prepare the resolution plan now (read-only). A planning failure is reported beside the answer, never hidden.
  try {
    const { plan } = await planTaxCalculation(client, { product: q.productId ? { id: q.productId } : { name: q.product ?? q.productCode }, account: q.account, quantity: q.quantity, unitPrice: q.unitPrice, country: q.country, state: q.state, taxCode: q.taxCode ?? null, rate: q.rate ?? null, basis: q.basis ?? null });
    return { ...a, plan } as TaxQueryAnswer;
  } catch (e) { return { ...a, planError: `The resolution plan couldn't be prepared: ${e instanceof Error ? e.message : String(e)}` } as TaxQueryAnswer; }
}

async function answerTaxQueryCore(client: SalesforceClient, q: TaxQuery): Promise<TaxQueryAnswer> {
  // "Show the latest invoice tax" / "Verify InvoiceLineTax" without a product: the org's most recent invoice line with a tax treatment.
  if (!q.product && (q.kind === "latest-invoice-config" || q.kind === "verify-invoice-tax")) {
    const api = await runtimeApiFor(client);
    const [l] = await api.query("SELECT InvoiceId FROM InvoiceLine WHERE TaxTreatmentId != null ORDER BY CreatedDate DESC LIMIT 1");
    const invoiceTax = l ? await verifyInvoiceLineTax(api, String(l.InvoiceId)) : null;
    return { kind: q.kind, query: q, readiness: null, invoiceTax, message: invoiceTax ? `Latest invoice with taxed lines: ${invoiceTax.message}` : "No invoice line in this org has a tax treatment yet — there is no InvoiceLineTax to verify." };
  }
  // Decision-table freshness question: the engines' tables, their last full / incremental refresh and the newest rate change (read-only).
  if (q.kind === "decision-table") {
    const r = await decisionTableRefresh(await runtimeApiFor(client), {});
    const tables = r.mode === "list" ? r.tables : [];
    const message = !tables.length ? "No Active tax engine has a decision table." : tables.map(t => `${t.decisionTable.name} (engine ${t.engine?.name ?? "—"}${t.sharedWith.length ? `, shared with ${t.sharedWith.map(e => e.name).join(", ")}` : ""}): ${t.stale ? `STALE — a Tax Rate changed at ${t.newestRateChange} after its last successful refresh (${t.lastSuccessfulRefresh ?? "never"}); it needs an approved refresh before it contains the latest rate` : `current — last successful refresh ${t.lastSuccessfulRefresh ?? "—"} is after the newest Tax Rate change ${t.newestRateChange ?? "—"}`}.`).join(" ");
    return { kind: "decision-table", query: q, tables, message };
  }
  // Existing order (by number or Id): Salesforce's current tax state for it (read-only; the next billable step still needs its own
  // confirmation in the UI — that is also how an interrupted run is resumed).
  if (q.kind === "order-result" || q.kind === "order-explain") {
    if (!q.orderNumber && !q.orderId) return { kind: "needs-input", query: q, field: "order", message: "Which order? Give its order number (e.g. \"order 00000141\")." };
    const api = await runtimeApiFor(client);
    const numbers = q.orderNumber ? [...new Set([q.orderNumber, q.orderNumber.padStart(8, "0")])] : [];
    const rows = q.orderId ? await api.query(`SELECT Id, OrderNumber FROM Order WHERE Id = '${soqlEscape(q.orderId)}'`) : await api.query(`SELECT Id, OrderNumber FROM Order WHERE OrderNumber IN (${numbers.map(n => `'${soqlEscape(n)}'`).join(",")}) LIMIT 2`);
    if (!rows.length) return { kind: "needs-input", query: q, field: "order", message: `Order ${q.orderNumber ?? q.orderId} doesn't exist in the connected org — check the order number.` };
    const salesforce = await readSalesforceTax(await sfTaxApiFor(client), String(rows[0].Id));
    return { kind: q.kind, query: q, salesforce, message: q.kind === "order-explain" ? explainOrder(salesforce) : salesforce.message };
  }
  // Invoice by number: read-only (never asks Salesforce to calculate; no record is created or changed).
  if (q.kind === "invoice-result" || q.kind === "invoice-explain") {
    if (!q.invoiceNumber) return { kind: "needs-input", query: q, field: "invoice", message: "Which invoice? Give its document number (e.g. \"DOC-000000021\")." };
    const salesforce = await calculateSalesforceTax(await sfTaxApiFor(client), { mode: "invoice", invoiceNumber: q.invoiceNumber, readOnly: true, waitMs: 0 });
    return { kind: q.kind, query: q, salesforce, message: q.kind === "invoice-explain" ? explainInvoice(salesforce) : salesforce.message };
  }
  if (!q.product && !q.productId && !q.productCode) return { kind: "readiness", query: q, readiness: { success: true, status: "BLOCKED", product: null, areas: [], decisionTable: { state: "Not Ready", reason: "—" }, resolution: null, diagnostics: [], message: "Which product? e.g. \"Check whether Desktop is ready for tax calculation.\"" }, invoiceTax: null, message: "Which product? e.g. \"Check whether Desktop is ready for tax calculation.\"" };
  const api = await runtimeApiFor(client);
  const product = q.productId ? { id: q.productId, name: null } : { name: q.product ?? q.productCode };
  const ctx = { country: q.country, state: q.state };
  switch (q.kind) {
    case "salesforce-calculate": case "salesforce-preview": {
      // Deterministic Tax Calculation service. With an account: validation → "confirm create-order" (nothing is created until the
      // user confirms in the UI). Without one, or for a preview: validation + Salesforce's decision-table evaluation (read-only).
      if (q.kind === "salesforce-preview") {
        const salesforce = await calculateSalesforceTax(await sfTaxApiFor(client), { mode: "billing", action: "preview", product, quantity: q.quantity, unitPrice: q.unitPrice, country: q.country, state: q.state });
        return { kind: q.kind, query: q, salesforce, message: salesforce.message };
      }
      const { salesforce, plan } = await planTaxCalculation(client, { product, account: q.account, quantity: q.quantity, unitPrice: q.unitPrice, country: q.country, state: q.state, taxCode: q.taxCode ?? null, rate: q.rate ?? null, basis: q.basis ?? null });
      return { kind: q.kind, query: q, salesforce, plan, message: planMessage(plan, salesforce) };
    }
    case "e2e": {
      const e2e = await runEndToEndTaxValidation(client, { mode: "preview", product, accountName: q.account, quantity: q.quantity, unitPrice: q.unitPrice, country: q.country, state: q.state });
      return { kind: "e2e", query: q, e2e, message: e2e.message };
    }
    case "readiness": case "explain": {
      const readiness = await getProductTaxReadiness(api, product, ctx);
      const latest = q.kind === "explain" && readiness.product ? await latestInvoiceForProduct(api, readiness.product.id) : null;
      const invoiceTax = latest ? await verifyInvoiceLineTax(api, latest.invoiceId) : null;
      const why = q.kind === "explain" ? `${readiness.message}${invoiceTax ? ` Latest invoice: ${invoiceTax.message}` : readiness.product ? ` ${readiness.product.name} has no invoice yet, so Salesforce hasn't had a chance to calculate tax on it.` : ""}` : readiness.message;
      return { kind: q.kind, query: q, readiness, invoiceTax, message: why };
    }
    default: {
      const readiness = await getProductTaxReadiness(api, product, ctx);
      const latest = readiness.product ? await latestInvoiceForProduct(api, readiness.product.id) : null;
      const invoiceTax = latest ? await verifyInvoiceLineTax(api, latest.invoiceId) : null;
      return { kind: q.kind, query: q, readiness, invoiceTax, message: invoiceTax ? invoiceTax.message : `${readiness.product?.name ?? q.product} has no invoice in this org yet — there is no InvoiceLineTax to verify.` };
    }
  }
}

export interface PlanInput {
  product: { id?: string | null; name?: string | null };
  /** `accountId` (a record picked in the lookup) wins over the `account` name. */
  account?: string | null; accountId?: string | null; quantity?: number | null; unitPrice?: number | null; country?: string | null; state?: string | null;
  taxCode?: string | null; rate?: number | null; basis?: string | null; treatmentId?: string | null; engineId?: string | null; legalEntityId?: string | null; sellingModelId?: string | null;
}

/**
 * Read-only: the Salesforce validation of the requested calculation (with an account: up to "confirm create-order" — nothing is
 * created) plus the configuration plan (what to reuse, create, update, activate, refresh; what to ask). A named account that doesn't
 * exist becomes a question in the plan, never an invented customer.
 */
export async function planTaxCalculation(client: SalesforceClient, input: PlanInput): Promise<{ salesforce: SfTaxResult; plan: CalculationPlan }> {
  const sf = await sfTaxApiFor(client);
  const base = { mode: "billing" as const, product: input.product, quantity: input.quantity ?? null, unitPrice: input.unitPrice ?? null, country: input.country ?? null, state: input.state ?? null };
  let accountNotFound: string | null = null;
  let salesforce: SfTaxResult;
  if (input.accountId || input.account) {
    try { salesforce = await calculateSalesforceTax(sf, { ...base, action: "calculate", ...(input.accountId ? { accountId: input.accountId } : { accountName: input.account }) }); }
    catch (e) {
      if (!(e instanceof BadInputError) || !/doesn't exist/.test(e.message)) throw e;
      accountNotFound = input.account ?? input.accountId!;
      salesforce = await calculateSalesforceTax(sf, { ...base, action: "preview" });
    }
  } else salesforce = await calculateSalesforceTax(sf, { ...base, action: "preview" });
  const acc = salesforce.validation?.account ?? null;
  const plan = await loadCalculationPlan(client, input.product, {
    country: input.country ?? null, state: input.state ?? null, taxCode: input.taxCode ?? null, rate: input.rate ?? null, basis: input.basis ?? null,
    account: acc ? { id: acc.id, name: acc.name, country: acc.country, state: acc.state } : null, accountNotFound,
    quantity: input.quantity ?? null, unitPrice: input.unitPrice ?? null, treatmentId: input.treatmentId ?? null, engineId: input.engineId ?? null, legalEntityId: input.legalEntityId ?? null, sellingModelId: input.sellingModelId ?? null,
  });
  // Nothing left to configure, but Salesforce's validation still fails (e.g. no Bill To contact): those checks are the blockers.
  const v = salesforce.validation;
  if (plan.status === "READY_TO_CALCULATE" && v && v.status !== "READY" && !(v.reason === "ACCOUNT_REQUIRED" && !input.account && !input.accountId)) {
    plan.blocked.push(...v.checks.filter(c => c.status === "FAIL").map(c => `${c.label}: ${c.detail}`));
    if (plan.blocked.length) { plan.status = "BLOCKED"; plan.summary = `Blocked: ${plan.blocked[0]}`; }
  }
  return { salesforce, plan };
}

export function planMessage(plan: CalculationPlan, sf: SfTaxResult): string {
  if (plan.status === "READY_TO_CALCULATE") return sf.awaiting?.step === "create-order" ? `${plan.summary} Confirm "Create Order" to start — nothing has been created yet.` : `${plan.summary} ${sf.message}`;
  return plan.summary;
}

/** Why an order has (no) tax: the Salesforce result when invoiced, else where the run stands and what blocks it. */
export function explainOrder(r: SfTaxResult): string {
  const run = r.run;
  if (r.status === "CALCULATED") return explainInvoice(r);
  if (run?.invoice) return explainInvoice(r);
  const parts = [`Order ${run?.order.number ?? r.orderId} is ${run?.order.status ?? "—"} and has no invoice yet, so Salesforce hasn't calculated its tax.`];
  if (r.status === "CALCULATION_FAILED") parts.push(r.message);
  const failed = (run?.checks ?? []).filter(c => c.passed === false).map(c => `${c.label}: ${c.detail}`);
  if (failed.length) parts.push(`Blocking checks — ${failed.join("; ")}.`);
  for (const i of run?.items ?? []) if (!i.treatment) parts.push(`${i.product?.name ?? "An order product"} has no Tax Treatment on the order product — Salesforce would bill it with the legal entity's default treatment.`);
  if (r.awaiting) parts.push(`Next step (needs your confirmation): ${r.awaiting.detail}`);
  return parts.join(" ");
}

/** A plain explanation of an invoice's Salesforce tax result from its read-only evidence. */
export function explainInvoice(r: SfTaxResult): string {
  const e = r.evidence;
  if (r.status === "CALCULATED") return `Salesforce calculated the tax: ${r.actual.map(a => `${a.taxCode ?? "—"} ${a.taxRate ?? "?"}% = ${a.taxAmount} (InvoiceLineTax ${a.invoiceLineTaxId})`).join(" · ")}.`;
  if (!e) return r.message;
  const parts = [
    r.message,
    `Trace: ${e.traceClassification ?? "—"}.`,
    `Invoice tax ${e.invoiceTaxAmount ?? "—"}, line tax ${e.invoiceLineTaxAmount ?? "—"} (${e.taxProcessingStatus ?? "—"}), InvoiceLineTax ${e.invoiceLineTaxCount}, error logs ${e.errorLogCount}.`,
    e.preview ? (e.preview.error ? `Decision-table preview failed: ${e.preview.error.message}.` : `Decision-table preview (not a tax result): ${e.preview.outcomeType ?? "—"}${e.preview.matched ? ` — Rate ${e.preview.rate}% ${e.preview.applicationBasis ?? ""}` : ""}.`) : "",
    e.configurationChangedAfterInvoice ? `The rate that matches today (${e.configurationChangedAfterInvoice.rate}) was created or changed at ${e.configurationChangedAfterInvoice.rateChangedAt}, after this invoice (${e.configurationChangedAfterInvoice.invoiceCreatedAt}) — today's match doesn't show the configuration Salesforce used for it. A new order and invoice test the current configuration.`
      : r.reason === "INVOICE_TIME_TAX_NOT_APPLIED" ? "The configuration matches, but Salesforce's invoice-time processing did not apply it — a Salesforce Support investigation, not another configuration change." : "",
  ];
  return parts.filter(Boolean).join(" ");
}
