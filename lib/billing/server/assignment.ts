import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { billingDescribe, billingDescribeGlobal, getModuleSchema, nameFieldOf } from "@/lib/billing/server/discovery";
import { resolveReferenceByName, SALESFORCE_ID, type ReferenceResolution } from "@/lib/billing/server/lookup";
import type { BillingReferenceValue } from "@/lib/billing/types";

/**
 * Product → Billing Policy ASSIGNMENT service — the one code path both the AI prompt and the manual
 * form go through (lookup → existing-policy check → billing-chain validation → confirmation →
 * Salesforce update). The relationship field is discovered from Product2's Describe (the reference
 * field that points at BillingPolicy), never assumed. Nothing is stored locally: the "current
 * policy" is always read from Salesforce at check time AND re-read at save time.
 */

export interface AssignmentCheckItem { id: string; label: string; status: "passed" | "warning" | "failed"; detail?: string }

export interface AssignmentProduct {
  id: string;
  name: string;
  code: string | null;
  active: boolean | null;
  currentPolicy: { id: string; name: string; status: string | null } | null;
}

export interface AssignmentPolicyChain {
  id: string;
  name: string;
  status: string | null;
  selection: string | null;
  defaultTreatment: { id: string; name: string; status: string | null; milestone: boolean; billable: boolean; policyName: string | null } | null;
  items: { id: string; name: string; status: string | null; type: string | null; billingType: string | null }[];
  /** Products this policy is assigned to right now (Product2.<field> = policy). */
  products: { id: string; name: string }[];
}

export interface AssignmentCheck {
  success: true;
  /** ready = can assign; conflict = product has a DIFFERENT policy (needs explicit replace); already-assigned = no-op; blocked = invalid. */
  status: "ready" | "conflict" | "already-assigned" | "blocked";
  requiresConfirmation: boolean;
  replace: boolean;
  field: { name: string; label: string; sobject: "Product2" } | null;
  product: AssignmentProduct | null;
  policy: AssignmentPolicyChain | null;
  checks: AssignmentCheckItem[];
  blockers: string[];
  warnings: string[];
  conflict: { product: string; existingBillingPolicy: string; existingBillingPolicyId: string; requestedBillingPolicy: string; requiresConfirmation: true } | null;
}

const statusText = (v: unknown) => (typeof v === "boolean" ? (v ? "Active" : "Inactive") : typeof v === "string" ? v : null);

/** Product2's reference field to BillingPolicy, from Describe (prefers BillingPolicyId if several exist). */
export async function discoverAssignmentField(client: SalesforceClient): Promise<{ name: string; label: string; updateable: boolean; productUpdateable: boolean; codeField: string | null; activeField: string | null } | null> {
  const policySchema = await getModuleSchema(client, "billing-policies").catch(() => null);
  if (!policySchema) return null;
  const d = await billingDescribe(client, "Product2");
  const candidates = d.fields.filter(f => f.type === "reference" && f.referenceTo?.includes(policySchema.sobject));
  const f = candidates.find(x => x.name === "BillingPolicyId") ?? candidates[0];
  if (!f) return null;
  const global = await billingDescribeGlobal(client);
  return {
    name: f.name,
    label: f.label.replace(/\s+ID$/i, ""),
    updateable: !!f.updateable,
    productUpdateable: global.find(g => g.name === "Product2")?.updateable !== false,
    codeField: d.fields.some(x => x.name === "ProductCode") ? "ProductCode" : null,
    activeField: d.fields.some(x => x.name === "IsActive") ? "IsActive" : null,
  };
}

async function loadProduct(client: SalesforceClient, id: string, field: NonNullable<Awaited<ReturnType<typeof discoverAssignmentField>>>): Promise<AssignmentProduct | null> {
  const rel = (await billingDescribe(client, "Product2")).fields.find(f => f.name === field.name)?.relationshipName;
  const select = ["Id", "Name", field.name, field.codeField, field.activeField, rel && `${rel}.Name`, rel && `${rel}.Status`].filter(Boolean).join(", ");
  const res = await client.query<Record<string, unknown>>(`SELECT ${select} FROM Product2 WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  const r = res.records[0];
  if (!r) return null;
  const pid = r[field.name] as string | null;
  const pol = rel ? (r[rel] as Record<string, unknown> | null) : null;
  return {
    id: r.Id as string,
    name: String(r.Name),
    code: field.codeField ? ((r[field.codeField] as string) ?? null) : null,
    active: field.activeField ? (r[field.activeField] as boolean) : null,
    currentPolicy: pid ? { id: pid, name: String(pol?.Name ?? "Billing Policy"), status: statusText(pol?.Status) } : null,
  };
}

/** The policy's full billing chain as it is in Salesforce now: Policy → Default Treatment → Items (+ products using it). */
export async function loadPolicyChain(client: SalesforceClient, policyId: string, productField: string | null): Promise<AssignmentPolicyChain | null> {
  const [p] = (await client.query<Record<string, unknown>>(`SELECT Id, Name, Status, BillingTreatmentSelection, DefaultBillingTreatmentId FROM BillingPolicy WHERE Id = '${soqlEscape(policyId)}' LIMIT 1`)).records;
  if (!p) return null;
  let defaultTreatment: AssignmentPolicyChain["defaultTreatment"] = null;
  let items: AssignmentPolicyChain["items"] = [];
  const tId = p.DefaultBillingTreatmentId as string | null;
  if (tId) {
    const [t] = (await client.query<Record<string, unknown>>(`SELECT Id, Name, Status, IsMilestoneBilling, ExcludeFromBilling, BillingPolicy.Name FROM BillingTreatment WHERE Id = '${soqlEscape(tId)}' LIMIT 1`)).records;
    if (t) {
      defaultTreatment = { id: t.Id as string, name: String(t.Name), status: statusText(t.Status), milestone: t.IsMilestoneBilling === true, billable: t.ExcludeFromBilling !== "Yes", policyName: ((t.BillingPolicy as { Name?: string } | null)?.Name) ?? null };
      items = (await client.query<Record<string, unknown>>(`SELECT Id, Name, Status, Type, BillingType FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(tId)}' ORDER BY ProcessingOrder`)).records
        .map(i => ({ id: i.Id as string, name: String(i.Name), status: statusText(i.Status), type: (i.Type as string) ?? null, billingType: (i.BillingType as string) ?? null }));
    }
  }
  const products = productField
    ? (await client.query<Record<string, unknown>>(`SELECT Id, Name FROM Product2 WHERE ${productField} = '${soqlEscape(policyId)}' ORDER BY Name LIMIT 200`)).records.map(r => ({ id: r.Id as string, name: String(r.Name) }))
    : [];
  return { id: p.Id as string, name: String(p.Name), status: statusText(p.Status), selection: (p.BillingTreatmentSelection as string) ?? null, defaultTreatment, items, products };
}

/**
 * The ONE Policy → Default Treatment → Treatment Item validation, shared by the Product assignment
 * workflow ("assign") and Order billing setup ("bill"). Billing an order is stricter: every link in
 * the chain must be Active, because Salesforce only generates billing schedules from an active
 * configuration; assigning a policy to a product only warns about Draft records.
 */
export function evaluatePolicyChain(policy: AssignmentPolicyChain, mode: "assign" | "bill"): AssignmentCheckItem[] {
  const out: AssignmentCheckItem[] = [];
  const draftSeverity = mode === "bill" ? "failed" as const : "warning" as const;
  const noTreatment = mode === "bill" ? `Billing Policy "${policy.name}" exists, but no Default Billing Treatment is configured.` : "Cannot assign this Billing Policy because it does not have a valid Billing Treatment.";
  const noItem = mode === "bill" ? `Billing Treatment "${policy.defaultTreatment?.name}" exists, but no valid Billing Treatment Item is configured.` : "Cannot assign this Billing Policy because its Billing Treatment does not have the required Billing Treatment Item.";

  if (policy.status === "Inactive") out.push({ id: "policyValid", label: "Billing Policy is valid", status: "failed", detail: `Billing Policy "${policy.name}" is Inactive.` });
  else if (policy.status !== "Active") out.push({ id: "policyValid", label: "Billing Policy is valid", status: draftSeverity, detail: `Billing Policy "${policy.name}" is ${policy.status ?? "not Active"}${mode === "bill" ? " — activate it before billing this order." : " — products won't bill with it until it's Active."}` });
  else out.push({ id: "policyValid", label: "Billing Policy is valid", status: "passed", detail: "Active" });

  const t = policy.defaultTreatment;
  if (!t) { out.push({ id: "treatment", label: "Billing Policy has a Billing Treatment", status: "failed", detail: noTreatment }); return out; }
  if (t.status === "Inactive") { out.push({ id: "treatment", label: "Billing Treatment configuration is valid", status: "failed", detail: mode === "bill" ? `Default Billing Treatment "${t.name}" is Inactive.` : `Cannot assign this Billing Policy because it does not have a valid Billing Treatment ("${t.name}" is Inactive).` }); return out; }
  out.push({ id: "treatment", label: "Billing Treatment exists", status: "passed", detail: t.name });
  if (t.status !== "Active") out.push({ id: "treatmentValid", label: "Billing Treatment configuration is valid", status: draftSeverity, detail: `Default treatment "${t.name}" is ${t.status ?? "not Active"}.` });
  else out.push({ id: "treatmentValid", label: "Billing Treatment configuration is valid", status: "passed", detail: "Active" });
  if (!t.policyName) out.push({ id: "treatmentPolicy", label: "Billing Treatment belongs to a policy", status: "warning", detail: `"${t.name}" has no Billing Policy — Salesforce won't activate a policy whose default treatment has none.` });

  const items = policy.items;
  if (items.length === 0) out.push({ id: "items", label: "Billing Treatment Item configuration is valid", status: "failed", detail: noItem });
  else if (!t.milestone && items.length > 1) out.push({ id: "items", label: "Billing Treatment Item configuration is valid", status: "failed", detail: `Billing Treatment "${t.name}" has ${items.length} Treatment Items; Salesforce requires exactly one for a non-milestone treatment.` });
  else if (t.billable && !items.some(i => i.status === "Active") && (t.status === "Active" || mode === "bill")) out.push({ id: "items", label: "Billing Treatment Item configuration is valid", status: "failed", detail: mode === "bill" ? noItem : "Cannot assign this Billing Policy because its Billing Treatment does not have an Active Billing Treatment Item." });
  else if (!items.some(i => i.status === "Active")) out.push({ id: "items", label: "Billing Treatment Item configuration is valid", status: "warning", detail: `Treatment Item "${items[0].name}" is ${items[0].status ?? "not Active"}.` });
  else out.push({ id: "items", label: "Billing Treatment Item configuration is valid", status: "passed", detail: items.map(i => i.name).join(", ") });
  return out;
}

/**
 * Validate a proposed assignment against LIVE Salesforce data. With `allowReplace` false (the
 * default) a product that already has a different policy returns `conflict` — it is never
 * overwritten without an explicit, separate confirmation.
 */
export async function checkAssignment(client: SalesforceClient, input: { productId: string | null; policyId: string | null; allowReplace?: boolean }): Promise<AssignmentCheck> {
  const checks: AssignmentCheckItem[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const pass = (id: string, label: string, detail?: string) => checks.push({ id, label, status: "passed", detail });
  const warn = (id: string, label: string, detail: string) => { checks.push({ id, label, status: "warning", detail }); warnings.push(detail); };
  const fail = (id: string, label: string, detail: string) => { checks.push({ id, label, status: "failed", detail }); blockers.push(detail); };
  const out = (status: AssignmentCheck["status"], rest: Partial<AssignmentCheck> = {}): AssignmentCheck => ({
    success: true, status, requiresConfirmation: status === "conflict", replace: false, field: null, product: null, policy: null, conflict: null, ...rest, checks, blockers, warnings,
  });

  const field = await discoverAssignmentField(client);
  if (!field) { fail("relationship", "Product ↔ Billing Policy relationship supported", "This org has no Product field that references Billing Policy, so policies can't be assigned to products."); return out("blocked"); }
  pass("relationship", "Product ↔ Billing Policy relationship supported", `Product2.${field.name}`);
  if (!field.productUpdateable || !field.updateable) fail("updateable", "Product can be updated", `Your user can't update Product2.${field.name} (field-level security or object permissions).`);
  else pass("updateable", "Product can be updated", `Product2.${field.name} is updateable`);

  let product: AssignmentProduct | null = null;
  if (input.productId) {
    if (!SALESFORCE_ID.test(input.productId)) fail("product", "Product exists", "Invalid Product reference — select it with the lookup.");
    else {
      product = await loadProduct(client, input.productId, field).catch(() => null);
      if (!product) fail("product", "Product exists and is accessible", "The selected Product no longer exists in Salesforce or isn't visible to your user.");
      else {
        pass("product", "Product exists and is accessible", product.name);
        if (product.active === false) warn("productActive", "Product is active", `${product.name} is inactive in Salesforce.`);
      }
    }
  }

  let policy: AssignmentPolicyChain | null = null;
  if (input.policyId) {
    if (!SALESFORCE_ID.test(input.policyId)) fail("policy", "Billing Policy exists", "Invalid Billing Policy reference — select it with the lookup.");
    else {
      policy = await loadPolicyChain(client, input.policyId, field.name).catch(() => null);
      if (!policy) fail("policy", "Billing Policy exists and is accessible", "The selected Billing Policy no longer exists in Salesforce or isn't visible to your user.");
    }
  }

  // Billing chain: Policy → Default Treatment → Treatment Item (never a partially configured relationship).
  if (policy) {
    pass("policy", "Billing Policy exists and is accessible", policy.name);
    for (const item of evaluatePolicyChain(policy, "assign")) {
      if (item.status === "failed") fail(item.id, item.label, item.detail!);
      else if (item.status === "warning") warn(item.id, item.label, item.detail!);
      else pass(item.id, item.label, item.detail);
    }
  }

  const base = { field: { name: field.name, label: field.label, sobject: "Product2" as const }, product, policy };
  if (!product || !policy || blockers.length) return out(blockers.length ? "blocked" : "ready", base);

  // Existing assignment — read live, never assumed.
  const current = product.currentPolicy;
  if (current && current.id.slice(0, 15) === policy.id.slice(0, 15)) {
    pass("duplicate", "No duplicate assignment", `${product.name} is already assigned to ${policy.name}.`);
    return out("already-assigned", base);
  }
  if (current && !input.allowReplace) {
    checks.push({ id: "conflict", label: "Product has no conflicting Billing Policy", status: "failed", detail: `${product.name} already has Billing Policy "${current.name}".` });
    return out("conflict", { ...base, conflict: { product: product.name, existingBillingPolicy: current.name, existingBillingPolicyId: current.id, requestedBillingPolicy: policy.name, requiresConfirmation: true } });
  }
  if (current) warn("conflict", "Replace existing Billing Policy", `${product.name}: "${current.name}" → "${policy.name}" (explicitly confirmed).`);
  else pass("conflict", "Product has no conflicting Billing Policy", `${product.name} does not currently have a Billing Policy.`);
  return out("ready", { ...base, replace: !!current });
}

export type AssignOutcome =
  | { ok: true; product: AssignmentProduct; policy: AssignmentPolicyChain; previousPolicy: { id: string; name: string } | null; productUrl: string; policyUrl: string }
  | { ok: false; status: number; code: string; error: string; check: AssignmentCheck | null };

/**
 * Save an assignment. Re-runs the full check server-side. A product that already has a different
 * policy is only changed when `confirmReplace` is true AND `expectedCurrentPolicyId` still matches
 * what Salesforce has now (so a policy someone else changed in the meantime is never overwritten).
 * Success is only reported after re-reading the product from Salesforce.
 */
export async function assignBillingPolicy(client: SalesforceClient, input: { productId: string; policyId: string; confirmReplace?: boolean; expectedCurrentPolicyId?: string | null }): Promise<AssignOutcome> {
  const check = await checkAssignment(client, { productId: input.productId, policyId: input.policyId, allowReplace: !!input.confirmReplace });
  if (check.status === "blocked" || !check.product || !check.policy || !check.field) return { ok: false, status: 422, code: "ASSIGNMENT_BLOCKED", error: check.blockers[0] ?? "This assignment isn't valid.", check };
  if (check.status === "already-assigned") return { ok: false, status: 409, code: "ALREADY_ASSIGNED", error: `${check.product.name} is already assigned to ${check.policy.name}.`, check };
  if (check.status === "conflict") return { ok: false, status: 409, code: "BILLING_POLICY_CONFLICT", error: `${check.product.name} already has Billing Policy "${check.product.currentPolicy?.name}". Confirm the change explicitly to replace it.`, check };
  const live = check.product.currentPolicy?.id ?? null;
  const expected = input.expectedCurrentPolicyId ?? null;
  if ((live?.slice(0, 15) ?? null) !== (expected?.slice(0, 15) ?? null)) {
    return { ok: false, status: 409, code: "ASSIGNMENT_CHANGED", error: `${check.product.name}'s Billing Policy changed in Salesforce since you reviewed it (now: ${check.product.currentPolicy?.name ?? "none"}). Review again before assigning.`, check };
  }

  await client.updateRecord("Product2", check.product.id, { [check.field.name]: check.policy.id });

  const field = await discoverAssignmentField(client);
  const after = field ? await loadProduct(client, check.product.id, field) : null;
  if (!after?.currentPolicy || after.currentPolicy.id.slice(0, 15) !== check.policy.id.slice(0, 15)) {
    return { ok: false, status: 500, code: "ASSIGNMENT_NOT_CONFIRMED", error: "Salesforce accepted the update but the product doesn't show the new Billing Policy — check automation on Product2.", check };
  }
  const policy = (await loadPolicyChain(client, check.policy.id, check.field.name)) ?? check.policy;
  return {
    ok: true, product: after, policy,
    previousPolicy: check.product.currentPolicy ? { id: check.product.currentPolicy.id, name: check.product.currentPolicy.name } : null,
    productUrl: buildSalesforceRecordUrl(client.instanceUrl, "Product2", after.id),
    policyUrl: buildSalesforceRecordUrl(client.instanceUrl, "BillingPolicy", policy.id),
  };
}

/** Product details + its billing chain, for the Product → Revenue Cloud Billing section. */
export async function loadProductBilling(client: SalesforceClient, productId: string) {
  if (!SALESFORCE_ID.test(productId)) throw new Error("Invalid Product Id.");
  const field = await discoverAssignmentField(client);
  const d = await billingDescribe(client, "Product2");
  const shown = ["Name", "ProductCode", "Family", "IsActive", "Description", "Type"].filter(n => d.fields.some(f => f.name === n));
  const [r] = (await client.query<Record<string, unknown>>(`SELECT Id, ${shown.join(", ")} FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`)).records;
  if (!r) throw new Error("Product not found in Salesforce.");
  const product = field ? await loadProduct(client, productId, field) : null;
  const chain = product?.currentPolicy ? await loadPolicyChain(client, product.currentPolicy.id, field?.name ?? null) : null;
  return {
    success: true as const,
    product: { id: r.Id as string, name: String(r[nameFieldOf(d)?.name ?? "Name"] ?? r.Name), fields: shown.map(n => ({ name: n, label: d.fields.find(f => f.name === n)!.label, value: r[n] ?? null })) },
    field: field ? { name: field.name, label: field.label } : null,
    policy: chain,
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, "Product2", productId),
  };
}

/* ─────────────────────────── AI extraction ─────────────────────────── */

const AI_PROMPT = `You extract a Salesforce Revenue Cloud Billing "assign billing policy to product" request.
Output ONLY JSON: {"intent": "assign" | "unsupported", "productName": "product name or code exactly as the user said it, or null", "billingPolicyName": "billing policy name exactly as the user said it, or null", "warnings": []}
Rules: never output Salesforce Ids; never invent names the user didn't say; the application looks both records up in Salesforce and checks any existing assignment itself. Never decide to overwrite anything.`;

export interface AssignmentAiResult {
  success: true;
  intent: "assign" | "unsupported";
  extraction: { productName: string | null; billingPolicyName: string | null };
  product: { outcome: ReferenceResolution["outcome"] | "missing"; match: BillingReferenceValue | null; candidates: BillingReferenceValue[]; message: string | null };
  policy: { outcome: ReferenceResolution["outcome"] | "missing"; match: BillingReferenceValue | null; candidates: BillingReferenceValue[]; message: string | null };
  check: AssignmentCheck | null;
  warnings: string[];
  rawAi: unknown;
}

async function resolve(client: SalesforceClient, sobject: string, name: string | null, label: string): Promise<AssignmentAiResult["product"]> {
  if (!name) return { outcome: "missing", match: null, candidates: [], message: `The prompt doesn't name a ${label}.` };
  if (SALESFORCE_ID.test(name) && /0{2,}/.test(name)) return { outcome: "missing", match: null, candidates: [], message: `The AI returned a raw Id for the ${label}; Ids are never trusted from AI output — select it with the lookup.` };
  const r = await resolveReferenceByName(client, sobject, name).catch(() => ({ outcome: "not-found" as const, candidates: [] }));
  if (r.outcome === "resolved") return { outcome: "resolved", match: r.match, candidates: [], message: r.matchType === "partial" ? `"${name}" matched "${r.match.name}" — confirm this is the right ${label}.` : null };
  if (r.outcome === "ambiguous") return { outcome: "ambiguous", match: null, candidates: r.candidates, message: `${label[0].toUpperCase()}${label.slice(1)} "${name}" matched ${r.candidates.length} records — choose one.` };
  return { outcome: "not-found", match: null, candidates: [], message: `${label === "product" ? "Product" : "Billing Policy"} ${name} could not be found in Salesforce.` };
}

/** Natural language → names (AI) → real records (SOQL) → the SAME checkAssignment the manual form uses. Never writes. */
export async function analyzeAssignmentPrompt(
  client: SalesforceClient,
  callModel: (system: string, prompt: string) => Promise<Record<string, unknown>>,
  prompt: string,
): Promise<AssignmentAiResult> {
  const ai = await callModel(AI_PROMPT, prompt);
  const warnings = (Array.isArray(ai.warnings) ? ai.warnings : []).filter((w): w is string => typeof w === "string");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const extraction = { productName: str(ai.productName), billingPolicyName: str(ai.billingPolicyName) };
  const policySobject = (await getModuleSchema(client, "billing-policies")).sobject;
  const [product, policy] = await Promise.all([
    resolve(client, "Product2", extraction.productName, "product"),
    resolve(client, policySobject, extraction.billingPolicyName, "billing policy"),
  ]);
  const check = product.match && policy.match ? await checkAssignment(client, { productId: product.match.id, policyId: policy.match.id }) : null;
  return { success: true, intent: ai.intent === "unsupported" ? "unsupported" : "assign", extraction, product, policy, check, warnings, rawAi: ai };
}

