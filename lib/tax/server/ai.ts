import type { SalesforceClient } from "@/lib/salesforce/client";
import { normalizeSpec } from "@/lib/tax/server/spec";
import { planTaxConfiguration } from "@/lib/tax/server/plan";
import type { TaxConfigSpec, TaxPlan } from "@/lib/tax/types";

/**
 * AI PROMPT → TaxConfigSpec. The model only extracts intent (names, taxability, rates, tax codes, products) — it never produces
 * Salesforce Ids, API names or picklist values that reach Salesforce directly. The spec then goes through the same planner as the
 * Manual form: every record, field, picklist value and relationship is resolved against the connected org before anything is
 * created, and nothing is created until the user confirms the preview.
 */
export const TAX_CONFIG_AI_SYSTEM = `You convert a request to CONFIGURE TAX in Salesforce Revenue Cloud Billing into JSON.
Return ONLY one JSON object:
{"isTaxConfiguration": boolean,
 "engine": {"type": "RevenueStandardTax" | string | null, "name": string | null},
 "legalEntityName": string | null,
 "country": string | null,
 "policy": {"name": string | null, "suggestedName": string | null, "treatmentSelection": "Default" | "Manual" | "LegalEntity" | null, "description": string | null},
 "treatments": [{"key": "t1", "name": string | null, "suggestedName": string | null, "taxable": boolean, "taxCode": string | null, "taxName": string | null, "rate": number | null, "useItems": boolean, "isDefault": boolean}],
 "items": [{"treatmentKey": "t1", "productName": string, "taxCode": string | null, "taxName": string | null, "rate": number | null}],
 "products": [{"productName": string}],
 "rateProductCode": "product" | "blank",
 "testTransaction": {"productName": string | null, "quantity": number | null, "unitPrice": number | null, "accountName": string | null} | null,
 "notes": string[]}
Rules:
- NEVER output Salesforce Ids. Copy product, policy, treatment and legal entity names exactly as the user wrote them.
- "name" fields only when the user explicitly named that record; otherwise null and put a short descriptive name in "suggestedName" (e.g. "India GST Policy", "GST 18% Taxable").
- legalEntityName ONLY when the user names a legal entity ("for Acme India Pvt Ltd"). A country or tax regime ("India GST") is NOT a legal entity — put the country in "country".
- country: the country the tax applies to, as written ("India", "US"), else null.
- rate: a percentage number (18% → 18, 5% → 5, zero-rated → 0). taxName: the tax's name ("GST", "VAT", "Sales Tax"), else null.
- taxCode ONLY when the user gives a literal tax code (e.g. "tax code ABC10", "use code VAT20"); never invent one — the system resolves codes in Salesforce.
- taxable=false for tax-exempt / non-taxable / exempt products. Zero-rated means taxable=true with rate 0 (not exempt).
- engine.type: "RevenueStandardTax" when the user asks for the standard / native / Revenue Standard tax engine or doesn't mention one; another type only if the user names it.
- treatmentSelection: "Default" unless the user asks for manual selection or selection by legal entity.
- Use ONE treatment with "useItems": true and one item per product when products need DIFFERENT tax codes/rates under one policy (e.g. "18% on Laptop and Software, 5% on Book"), or when the user asks for product-specific tax treatment items/mapping. Otherwise one treatment per distinct taxability/rate, with useItems false and products listed in "products".
- Every product the user mentions appears in "products" or "items" (not both needed). Use "isDefault": true on the treatment that applies by default.
- testTransaction ONLY when the user asks to calculate/test/verify the tax on a sale (e.g. "and calculate the tax when it is sold at ₹10,000 to Acme"): the product, quantity (null if not stated), unit price as a plain number (₹10,000 → 10000; null if not stated) and the customer account name exactly as written (null if not stated). Otherwise null. Never invent a price or account.
- rateProductCode: "product" (default) — tax rates are created per product (Salesforce matches the rate's Product Code against the product's own code). "blank" ONLY when the user explicitly asks for one rate that applies to all products with this tax code / not tied to a product (e.g. "a single GST rate for every product", "blank product code"). Never choose "blank" just because no product is named — leave "product" and the system will ask which products.
- isTaxConfiguration=false if the request isn't about configuring tax. Put anything you couldn't map into "notes".`;

/** The sale the user wants Salesforce to calculate tax on after configuring (names and numbers only — resolved in Salesforce). */
export interface TestTransaction { productName: string | null; quantity: number | null; unitPrice: number | null; accountName: string | null }

/** The requested test sale, if any. Numbers are validated; names are copied as written. */
export function transactionFromAi(out: Record<string, unknown>): TestTransaction | null {
  const t = out.testTransaction;
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 255) : null);
  const n = (v: unknown) => { const x = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[,\s₹$]/g, "")) : NaN; return Number.isFinite(x) && x > 0 ? x : null; };
  const tx = { productName: s(o.productName), quantity: n(o.quantity), unitPrice: n(o.unitPrice), accountName: s(o.accountName) };
  return tx.productName || tx.unitPrice || tx.accountName ? tx : null;
}

export type Extract = (system: string, prompt: string) => Promise<Record<string, unknown>>;

/** Map the model's JSON onto the spec shape (names only — Ids the model may have produced are dropped). */
export function specFromAi(out: Record<string, unknown>): { spec: TaxConfigSpec; warnings: string[] } {
  const warnings: string[] = Array.isArray(out.notes) ? out.notes.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/(^id$|Id$)/.test(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  const hadIds = JSON.stringify(out).match(/"[A-Za-z]*Id"\s*:\s*"[a-zA-Z0-9]{15,18}"/);
  if (hadIds) warnings.push("Ignored Salesforce Ids in the AI output — records are resolved by name in Salesforce.");
  const o = strip(out) as Record<string, unknown>;
  const engine = (o.engine ?? {}) as Record<string, unknown>;
  const spec = normalizeSpec({
    engine: { type: engine.type ?? null, name: engine.name ?? null },
    legalEntity: o.legalEntityName ? { name: o.legalEntityName } : null,
    country: o.country ?? null,
    policy: o.policy ?? {},
    treatments: o.treatments ?? [],
    items: Array.isArray(o.items) ? (o.items as Record<string, unknown>[]).map(i => ({ ...i, product: { name: i.productName } })) : [],
    products: Array.isArray(o.products) ? (o.products as Record<string, unknown>[]).map(p => ({ product: { name: p.productName ?? p.name } })) : [],
    rateDefaults: o.rateProductCode === "blank" ? { productCodeMode: "blank" } : null,
  });
  return { spec, warnings };
}

export type Interpretation =
  | { success: false; requiresInput: boolean; message: string; extraction: Record<string, unknown> }
  | { success: true; spec: TaxConfigSpec; warnings: string[]; extraction: Record<string, unknown>; plan: TaxPlan; transaction: TestTransaction | null };

export async function interpretTaxConfigPrompt(client: SalesforceClient, extract: Extract, prompt: string): Promise<Interpretation> {
  const out = await extract(TAX_CONFIG_AI_SYSTEM, prompt);
  if (out.isTaxConfiguration === false) return { success: false, requiresInput: false, message: "This doesn't look like a tax configuration request. Describe the tax (e.g. \"18% GST for Laptop, taxable, using the standard tax engine\").", extraction: out };
  const { spec, warnings } = specFromAi(out);
  if (!spec.treatments.length) return { success: false, requiresInput: true, message: "Say what tax applies — a rate (e.g. 18% GST), a tax code, or that the products are tax exempt.", extraction: out };
  const plan = await planTaxConfiguration(client, spec);
  return { success: true, spec, warnings, extraction: out, plan, transaction: transactionFromAi(out) };
}
