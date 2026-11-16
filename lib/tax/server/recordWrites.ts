import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, describeAt, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import type { StepAction } from "@/lib/tax/server/remediation";

/**
 * ALLOWLISTED record writes for remediation outside the Tax Assistant's objects — only these objects, operations and fields, checked
 * against the org's describe (createable / updateable) and current state before the write, and verified by re-reading after it:
 *  · Product2        update  TaxPolicyId, BillingPolicyId                      (link an existing policy to the product)
 *  · PricebookEntry  create  Pricebook2Id, Product2Id, UnitPrice, IsActive, ProductSellingModelId   (a missing price / selling-model price)
 *  · Order           update  Billing* / Shipping* address fields — Draft orders only (a missing or name-based address)
 * Anything else is refused. Nothing is deleted; nothing is retried with other targets.
 */
type RecordAction = Extract<StepAction, { kind: "record" }>;
export const RECORD_ALLOWLIST: Record<RecordAction["object"], { create?: string[]; update?: string[] }> = {
  Product2: { update: ["TaxPolicyId", "BillingPolicyId"] },
  PricebookEntry: { create: ["Pricebook2Id", "Product2Id", "UnitPrice", "IsActive", "ProductSellingModelId"] },
  Order: { update: ["BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry", "ShippingStreet", "ShippingCity", "ShippingState", "ShippingPostalCode", "ShippingCountry"] },
};
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const PERMISSION = /INSUFFICIENT_ACCESS|insufficient access|FORBIDDEN|not authorized/i;

/** Pure: is the action inside the allowlist with well-formed values? */
export function allowlistIssues(a: RecordAction): string[] {
  const allowed = RECORD_ALLOWLIST[a.object]?.[a.op];
  if (!allowed) return [`${a.op} on ${a.object} isn't an operation this workflow performs.`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(a.fields)) {
    if (!allowed.includes(k)) out.push(`${a.object}.${k} isn't a field this workflow writes.`);
    else if (/Id$/.test(k) && v !== null && (typeof v !== "string" || !SFID.test(v))) out.push(`${a.object}.${k} must be a Salesforce Id.`);
    else if (k === "UnitPrice" && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) out.push("UnitPrice must be a number ≥ 0.");
  }
  if (a.op === "update" && (!a.recordId || !SFID.test(a.recordId))) out.push(`The ${a.object} to update isn't identified.`);
  return out;
}
const sameVal = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" && SFID.test(a) && SFID.test(b) ? a.slice(0, 15) === b.slice(0, 15) : (a ?? null) === (b ?? null));

/** Read-only pre-check: allowlist, describe access, record state and duplicates. [] = executable. */
export async function checkRecordAction(client: SalesforceClient, a: RecordAction): Promise<string[]> {
  const issues = allowlistIssues(a);
  if (issues.length) return issues;
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const d = await describeAt(client, v, a.object);
  if (!d) return [`${a.object} isn't available to your user.`];
  const obj = d as unknown as { createable?: boolean; updateable?: boolean };
  if (a.op === "create" && obj.createable === false) return [`Your user can't create ${a.object} records.`];
  if (a.op === "update" && obj.updateable === false) return [`Your user can't edit ${a.object} records.`];
  for (const k of Object.keys(a.fields)) {
    const f = d.fields.find(x => x.name === k);
    if (!f) issues.push(`${a.object}.${k} doesn't exist in this org.`);
    else if (a.op === "create" ? !f.createable : !f.updateable) issues.push(`Your user can't ${a.op === "create" ? "set" : "edit"} ${a.object}.${k}.`);
  }
  if (issues.length) return issues;
  if (a.op === "update") {
    const extra = a.object === "Order" ? ", Status" : "";
    const [row] = await queryAt(client, v, `SELECT Id${extra} FROM ${a.object} WHERE Id = '${soqlEscape(a.recordId!)}' LIMIT 1`);
    if (!row) return [`${a.object} ${a.recordId} doesn't exist (or isn't visible).`];
    if (a.object === "Order" && row.Status !== "Draft") return [`Order ${a.recordId} is ${String(row.Status)} — only a Draft order's address is changed here.`];
  }
  if (a.object === "PricebookEntry") {
    const f = a.fields;
    const psm = f.ProductSellingModelId ? `= '${soqlEscape(String(f.ProductSellingModelId))}'` : "= null";
    const [dup] = await queryAt(client, v, `SELECT Id FROM PricebookEntry WHERE Pricebook2Id = '${soqlEscape(String(f.Pricebook2Id))}' AND Product2Id = '${soqlEscape(String(f.Product2Id))}' AND ProductSellingModelId ${psm} LIMIT 1`);
    if (dup) return [`A price book entry for this product, price book and selling model already exists (${String(dup.Id)}) — it is reused, not duplicated.`];
  }
  return [];
}

/** Write, then re-read: ok only when Salesforce holds exactly the intended values. */
export async function runRecordAction(client: SalesforceClient, a: RecordAction): Promise<{ ok: boolean; message: string; recordId?: string | null; permission?: boolean }> {
  const pre = await checkRecordAction(client, a);
  if (pre.length) return { ok: false, message: pre.join(" ") };
  const v = (await discoverTaxMetadata(client)).apiVersion;
  const path = a.op === "create" ? `/sobjects/${a.object}` : `/sobjects/${a.object}/${a.recordId}`;
  const res = await client.requestWithDiagnostics(apiUrl(client, v, path), { method: a.op === "create" ? "POST" : "PATCH", body: JSON.stringify(a.fields) });
  if (res.status >= 400) {
    const errs = Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : [];
    const msg = errs.map(e => `${e.errorCode ?? ""} ${e.message ?? ""}`.trim()).join("; ") || res.rawText || `HTTP ${res.status}`;
    return { ok: false, message: `Salesforce refused the ${a.object} ${a.op}: ${msg}`, permission: res.status === 403 || PERMISSION.test(msg) };
  }
  const id = a.op === "create" ? String((res.json as { id?: string } | null)?.id ?? "") : a.recordId!;
  if (!id) return { ok: false, message: `Salesforce didn't return the new ${a.object} Id.` };
  const fields = Object.keys(a.fields);
  const [row] = await queryAt(client, v, `SELECT Id, ${fields.join(", ")} FROM ${a.object} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  const wrong = row ? fields.filter(k => !sameVal(row[k], a.fields[k])) : fields;
  if (wrong.length) return { ok: false, recordId: id, message: `Salesforce accepted the ${a.object} ${a.op}, but re-reading ${id} doesn't show ${wrong.join(", ")} as intended — not marked done.` };
  return { ok: true, recordId: id, message: `${a.object} ${id} ${a.op === "create" ? "created" : "updated"} and verified.` };
}
