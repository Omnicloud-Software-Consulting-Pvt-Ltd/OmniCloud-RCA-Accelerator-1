import { normalizeApiVersionNumber, soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { isValidForControllingIndex } from "@/lib/salesforce/describe";
import { getBillingModule } from "@/lib/billing/registry";
import { billingDescribe, getModuleSchema, nameFieldOf } from "@/lib/billing/server/discovery";
import { resolveNamesById, SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { coerceFieldValue, isEmptyValue } from "@/lib/billing/server/values";
import { evaluateBillingRules } from "@/lib/billing/server/rules";
import { parentFlagFor, CHECK_LABELS, type CheckId } from "@/lib/billing/server/validate";
import { summarizeSalesforceErrors, type SalesforceErrorItem } from "@/lib/billing/server/errors";
import type {
  BillingChange, BillingDraftLink, BillingDraftRecord, BillingEditContext, BillingFieldMeta, BillingModuleSchema,
  BillingReferenceValue, BillingResolvedReference, BillingUpdateResponse, BillingValidationResult,
} from "@/lib/billing/types";

const same15 = (a: unknown, b: unknown) => (typeof a === "string" ? a.slice(0, 15) : null) === (typeof b === "string" ? b.slice(0, 15) : null);
const statusOf = (v: unknown) => (typeof v === "boolean" ? (v ? "Active" : "Inactive") : typeof v === "string" ? v : null);

/** Fields shown on the edit form: the same set the create form uses (createable or updateable, non-system). */
function editFields(schema: BillingModuleSchema): BillingFieldMeta[] {
  return schema.fields.filter(f => (f.createable || f.updateable) && !f.system && f.type !== "base64" && !f.calculated);
}

/** Display text for a value in the change summary. */
function display(field: BillingFieldMeta | undefined, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (field?.type === "picklist") return field.picklistValues.find(p => p.value === v)?.label ?? String(v);
  return String(v);
}

/** Equality the way Salesforce stores it (numbers numerically, datetimes by instant, empty = null). */
function sameValue(field: BillingFieldMeta, a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (isEmptyValue(a) || isEmptyValue(b)) return false;
  if (["int", "long", "double", "currency", "percent"].includes(field.type)) return Number(a) === Number(b);
  if (field.type === "datetime") return new Date(String(a)).getTime() === new Date(String(b)).getTime();
  if (field.type === "boolean") return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

/* ─────────────────────────── Edit context ─────────────────────────── */

async function queryRelated(client: SalesforceClient, soql: string): Promise<Record<string, unknown>[]> {
  try { return (await client.query<Record<string, unknown>>(soql)).records; } catch { return []; }
}

/**
 * Load one existing record for editing — current values in the SAME draft shape the create form
 * uses, lookups resolved to names, locks with Salesforce's reasons, related records (a treatment's
 * items, an item's treatment, a policy's treatments) and "set"-mode links (products on a policy).
 * Everything comes from Salesforce; nothing is cached locally between edits.
 */
export async function loadEditContext(client: SalesforceClient, moduleKey: string, id: string): Promise<BillingEditContext> {
  if (!SALESFORCE_ID.test(id)) throw new Error("Invalid record Id.");
  const schema = await getModuleSchema(client, moduleKey);
  const record = await client.getRecord(schema.sobject, id);
  const fields = editFields(schema);

  const refIds = fields.filter(f => f.type === "reference" && typeof record[f.name] === "string").map(f => ({ id: record[f.name] as string, referenceTo: f.referenceTo }));
  const names = await resolveNamesById(client, refIds);

  const draft: BillingDraftRecord = { key: `edit-${id}`, moduleKey, recordId: id, fields: {}, references: {}, children: [] };
  for (const f of fields) {
    if (f.type === "reference") {
      const v = record[f.name];
      draft.references[f.name] = typeof v === "string" ? (names.get(v) ?? { id: v, name: "Linked record", sobject: f.referenceTo[0] ?? "" }) : null;
    } else {
      draft.fields[f.name] = record[f.name] ?? null;
    }
  }

  const locks: Record<string, string> = {};
  for (const f of fields) if (!f.updateable) locks[f.name] = `Salesforce doesn't allow changing ${f.label} after the record is created.`;
  let recordLock: string | null = null;
  const related: BillingEditContext["related"] = [];
  const health: BillingEditContext["health"] = [];
  const status = schema.statusField ? statusOf(record[schema.statusField]) : null;
  if (status && status !== "Draft" && schema.statusField) {
    health.push({ status: "ok", message: `Status is ${status}. Salesforce won't allow it to return to Draft.` });
  }

  if (moduleKey === "billing-policies") {
    if (status === "Active") locks.BillingTreatmentSelection = "Salesforce doesn't allow changing Billing Treatment Selection while the policy is Active.";
    const treatments = await queryRelated(client, `SELECT Id, Name, Status, IsMilestoneBilling FROM BillingTreatment WHERE BillingPolicyId = '${soqlEscape(id)}' ORDER BY Name LIMIT 50`);
    related.push({
      title: "Billing Treatments on this policy", relation: "BillingTreatment.BillingPolicyId", moduleKey: "billing-treatments",
      records: treatments.map(t => ({ id: t.Id as string, name: String(t.Name), moduleKey: "billing-treatments", sobject: "BillingTreatment", status: statusOf(t.Status), summary: [{ label: "Milestone billing", value: t.IsMilestoneBilling ? "Yes" : "No" }] })),
    });
    const def = draft.references.DefaultBillingTreatmentId;
    if (!def) health.push({ status: status === "Active" ? "error" : "warning", message: "No Default Billing Treatment selected — Salesforce requires one (and it must be Active) before this policy can be Active." });
    else {
      const [t] = await queryRelated(client, `SELECT Status, BillingPolicyId FROM BillingTreatment WHERE Id = '${soqlEscape(def.id)}'`);
      health.push(t?.Status === "Active"
        ? { status: "ok", message: `Default treatment "${def.name}" is Active.` }
        : { status: "warning", message: `Default treatment "${def.name}" is ${String(t?.Status ?? "unknown")} — it must be Active before this policy can be activated.` });
      if (t && !t.BillingPolicyId) health.push({ status: "warning", message: `Default treatment "${def.name}" has no Billing Policy — Salesforce requires one before this policy can be activated.` });
    }
  }

  if (moduleKey === "billing-treatments") {
    const items = await queryRelated(client, `SELECT Id, Name, Status, Type, BillingType, ProcessingOrder, Percentage, FlatAmount FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(id)}' ORDER BY ProcessingOrder`);
    const nonMilestone = record.IsMilestoneBilling !== true;
    related.push({
      title: "Billing Treatment Items", relation: "BillingTreatmentItem.BillingTreatmentId", moduleKey: "billing-treatment-items",
      note: status && status !== "Draft" ? `Salesforce doesn't allow creating or editing Treatment Items while this treatment is ${status}.` : undefined,
      records: items.map(i => ({
        id: i.Id as string, name: String(i.Name), moduleKey: "billing-treatment-items", sobject: "BillingTreatmentItem", status: statusOf(i.Status),
        summary: [
          { label: "Type", value: String(i.Type ?? "—") }, { label: "Billing Type", value: String(i.BillingType ?? "—") },
          { label: "Processing Order", value: String(i.ProcessingOrder ?? "—") },
          ...(i.Percentage !== null && i.Percentage !== undefined ? [{ label: "Percentage", value: `${i.Percentage}%` }] : []),
        ],
      })),
    });
    if (nonMilestone) {
      if (items.length === 0) health.push({ status: "warning", message: "This non-milestone Billing Treatment requires one Treatment Item." });
      else if (items.length === 1) health.push({ status: items[0].Status === "Active" ? "ok" : "warning", message: items[0].Status === "Active" ? "Treatment Item configured and Active." : `Treatment Item configured ("${String(items[0].Name)}") but ${String(items[0].Status)} — it must be Active before this treatment can be activated.` });
      else health.push({ status: "error", message: `Invalid configuration: ${items.length} Treatment Items. Salesforce requires exactly one Treatment Item for this non-milestone Treatment.` });
    }
    const policies = await queryRelated(client, `SELECT Id, Name, Status FROM BillingPolicy WHERE DefaultBillingTreatmentId = '${soqlEscape(id)}' ORDER BY Name LIMIT 50`);
    related.push({
      title: "Default treatment of", relation: "BillingPolicy.DefaultBillingTreatmentId", moduleKey: "billing-policies",
      note: "Change a policy's default treatment from that policy's Edit page.",
      records: policies.map(p => ({ id: p.Id as string, name: String(p.Name), moduleKey: "billing-policies", sobject: "BillingPolicy", status: statusOf(p.Status), summary: [] })),
    });
  }

  if (moduleKey === "billing-treatment-items") {
    const parentId = record.BillingTreatmentId as string | null;
    if (parentId) {
      const [t] = await queryRelated(client, `SELECT Id, Name, Status, IsMilestoneBilling, BillingPolicy.Name FROM BillingTreatment WHERE Id = '${soqlEscape(parentId)}'`);
      const siblings = await queryRelated(client, `SELECT Id FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(parentId)}'`);
      if (t) {
        related.push({
          title: "Billing Treatment", relation: "BillingTreatmentItem.BillingTreatmentId", moduleKey: "billing-treatments",
          note: "Salesforce doesn't allow moving a Treatment Item to another treatment — the Billing Treatment field isn't updateable.",
          records: [{ id: t.Id as string, name: String(t.Name), moduleKey: "billing-treatments", sobject: "BillingTreatment", status: statusOf(t.Status),
            summary: [{ label: "Milestone billing", value: t.IsMilestoneBilling ? "Yes" : "No" }, { label: "Billing Policy", value: (t.BillingPolicy as { Name?: string } | null)?.Name ?? "—" }, { label: "Items on treatment", value: String(siblings.length) }] }],
        });
        if (t.Status !== "Draft") recordLock = `Salesforce doesn't allow editing a Treatment Item while its Billing Treatment "${String(t.Name)}" is ${String(t.Status)}.`;
        else health.push({ status: "ok", message: `Parent treatment "${String(t.Name)}" is Draft — this item can be edited.` });
      }
    }
  }

  // Editable "set"-mode links: records that point at THIS one (e.g. Product2.BillingPolicyId).
  const links: BillingDraftLink[] = [];
  for (const l of schema.inboundLinks) {
    if (l.valueSource !== "self" || (l.sobject === "BillingPolicy" && l.field === "DefaultBillingTreatmentId")) continue;
    const target = await billingDescribe(client, l.sobject).catch(() => null);
    const targetField = target?.fields.find(f => f.name === l.field);
    if (!target || !targetField?.updateable) continue;
    const nameField = nameFieldOf(target)?.name ?? "Name";
    const rows = await queryRelated(client, `SELECT Id, ${nameField} FROM ${l.sobject} WHERE ${l.field} = '${soqlEscape(id)}' ORDER BY ${nameField} LIMIT 200`);
    const current: BillingReferenceValue[] = rows.map(r => ({ id: r.Id as string, name: String(r[nameField] ?? r.Id), sobject: l.sobject }));
    links.push({ key: `link-${l.sobject}-${l.field}`, sobject: l.sobject, field: l.field, label: l.label, valueSource: "self", targets: [...current], originalTargets: current, enabled: true });
    if (moduleKey === "billing-policies" && l.sobject === "Product2") {
      health.push(current.length
        ? { status: "ok", message: `Linked to ${current.length} product${current.length > 1 ? "s" : ""}: ${current.slice(0, 3).map(p => p.name).join(", ")}${current.length > 3 ? "…" : ""}.` }
        : { status: "warning", message: "No product is currently linked to this Billing Policy (Product2.BillingPolicyId)." });
    }
  }

  return {
    success: true, moduleKey, recordId: id,
    name: schema.nameField ? String(record[schema.nameField] ?? id) : id,
    status, draft, links, locks, recordLock, related, health,
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, schema.sobject, id),
    lastModifiedDate: (record.LastModifiedDate as string) ?? null,
  };
}

/* ─────────────────────────── Update validation ─────────────────────────── */

export interface PreparedUpdate {
  schema: BillingModuleSchema;
  payload: Record<string, unknown>;
  linkOps: { sobject: string; field: string; recordId: string; recordName: string; value: string | null }[];
  result: BillingValidationResult;
  name: string;
}

/**
 * Validate an edit against the LIVE record: only real changes to updateable fields are sent,
 * every lookup is re-checked in Salesforce, platform rules (activation prerequisites, one item per
 * treatment, no moving items, no return to Draft…) are enforced on the post-save values, and link
 * changes are computed against the records that point at this one right now.
 */
export async function prepareUpdate(client: SalesforceClient, moduleKey: string, id: string, draft: BillingDraftRecord, links: BillingDraftLink[] = []): Promise<PreparedUpdate> {
  const schema = await getModuleSchema(client, moduleKey);
  const current = await client.getRecord(schema.sobject, id);
  const def = getBillingModule(moduleKey);
  const singular = def?.singular ?? schema.label;
  const issues: { check: CheckId; severity: "error" | "warning" | "info"; field: string | null; message: string }[] = [];
  const add = (check: CheckId, severity: "error" | "warning" | "info", field: string | null, message: string) => issues.push({ check, severity, field, message });
  const byName = new Map(schema.fields.map(f => [f.name, f]));
  const payload: Record<string, unknown> = {};
  const changes: BillingChange[] = [];
  const references: BillingResolvedReference[] = [];

  if (draft.recordId !== id) add("object", "error", null, "The edit doesn't belong to the record that was opened — reload the record and try again.");
  if (!schema.updateable) add("object", "error", null, `${singular} records can't be updated through the API in this org.`);

  for (const [name, raw] of Object.entries(draft.fields ?? {})) {
    const f = byName.get(name);
    if (!f) { add("fields", "warning", name, `${name} doesn't exist on ${schema.label} in this org — ignored.`); continue; }
    if (f.system || f.type === "reference") continue;
    const coerced = coerceFieldValue(f, raw);
    if (!coerced.ok) { add(f.type === "picklist" ? "picklists" : "types", "error", name, coerced.reason); continue; }
    if (sameValue(f, coerced.value, current[name])) continue;
    if (!f.updateable) { add("fields", "error", name, `Salesforce doesn't allow changing ${f.label} after the record is created.`); continue; }
    if (coerced.value === null && !f.nillable && f.type !== "boolean") { add("required", "error", name, `${f.label} is required for a ${singular}.`); continue; }
    payload[name] = coerced.value;
    changes.push({ kind: "field", field: name, label: f.label, from: display(f, current[name]), to: display(f, coerced.value) });
  }

  const currentRefIds = schema.fields.filter(f => f.type === "reference" && typeof current[f.name] === "string").map(f => ({ id: current[f.name] as string, referenceTo: f.referenceTo }));
  const currentNames = await resolveNamesById(client, currentRefIds);
  const refChecks: { sobject: string; id: string; field: string | null; label: string; name: string }[] = [];
  // Changes the user asked for on NON-updateable fields: not sent, but shown to the platform rules so they can explain the refusal.
  const attemptedLocked: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(draft.references ?? {})) {
    const f = byName.get(name);
    if (!f || f.type !== "reference" || f.system) continue;
    const newId = ref?.id ?? null;
    if (same15(newId, current[name]) || (!newId && !current[name])) {
      if (newId) refChecks.push({ sobject: f.referenceTo.includes(ref!.sobject) ? ref!.sobject : f.referenceTo[0], id: newId, field: name, label: f.label, name: ref!.name });
      continue;
    }
    // Non-updateable lookups are reported by the platform rules (e.g. moving a Treatment Item), which explain WHY.
    if (!f.updateable) { attemptedLocked[name] = newId; if (!(moduleKey === "billing-treatment-items" && name === "BillingTreatmentId")) add("rules", "error", name, `Salesforce doesn't allow changing ${f.label} after the record is created.`); continue; }
    if (newId && !SALESFORCE_ID.test(newId)) { add("references", "error", name, `${f.label} has an invalid record reference — re-select it with the lookup.`); continue; }
    if (!newId && !f.nillable) { add("required", "error", name, `${singular} requires a ${f.label}.`); continue; }
    payload[name] = newId;
    const oldName = typeof current[name] === "string" ? currentNames.get(current[name] as string)?.name ?? "Linked record" : null;
    changes.push({ kind: "reference", field: name, label: f.label, from: oldName, to: ref?.name ?? null });
    if (newId) refChecks.push({ sobject: f.referenceTo.includes(ref!.sobject) ? ref!.sobject : f.referenceTo[0], id: newId, field: name, label: f.label, name: ref!.name });
  }
  for (const [name, u] of Object.entries(draft.unresolved ?? {})) {
    if (draft.references[name]) continue;
    const f = byName.get(name);
    add("references", "error", name, u.candidates.length > 1 ? `${f?.label ?? name} "${u.searchedName}" matched ${u.candidates.length} records — choose one.` : `${f?.label ?? name} "${u.searchedName}" was not found in Salesforce.`);
    references.push({ path: "", field: name, label: f?.label ?? name, name: u.searchedName, sobject: u.sobject, status: "unresolved" });
  }

  const effective: Record<string, unknown> = { ...current, ...payload };

  // Required values on the post-save record.
  for (const f of editFields(schema)) {
    if (!f.nillable && f.type !== "boolean" && isEmptyValue(effective[f.name]) && !issues.some(i => i.field === f.name && i.severity === "error")) {
      add("required", "error", f.name, f.type === "reference" ? `${singular} requires a ${f.label}.` : `${f.label} is required for a ${singular}.`);
    }
  }
  // Dependent picklists on the post-save record.
  for (const f of schema.fields) {
    if (!f.controllerName || isEmptyValue(effective[f.name]) || f.type !== "picklist") continue;
    const ctl = byName.get(f.controllerName);
    const cv = effective[f.controllerName];
    if (!ctl || isEmptyValue(cv)) continue;
    const idx = ctl.type === "boolean" ? (cv ? 1 : 0) : ctl.picklistValues.findIndex(p => p.value === cv);
    const opt = f.picklistValues.find(p => p.value === effective[f.name]);
    if (opt?.validFor && idx >= 0 && !isValidForControllingIndex(opt.validFor, idx)) add("picklists", "error", f.name, `${f.label} "${String(effective[f.name])}" isn't allowed when ${ctl.label} is "${String(cv)}".`);
  }
  // Registry platform values (e.g. item Sequencing/Controller/Zero Amount Behavior) on the post-save record.
  if (def?.defaults && def.defaultsCondition) {
    const flag = await parentFlagFor(client, def, schema, effective, null);
    if (flag === def.defaultsCondition.applyWhen) {
      for (const [name, required] of Object.entries(def.defaults)) {
        const f = byName.get(name);
        if (f && effective[name] !== required) add("rules", "error", name, `${f.label} must be "${f.picklistValues.find(p => p.value === required)?.label ?? required}" — ${def.defaultsReason ?? "required by Salesforce."}`);
      }
    }
  }

  const rules = await evaluateBillingRules({ client, moduleKey, schema, mode: "update", recordId: id, effective: { ...effective, ...attemptedLocked }, current });
  for (const r of rules.issues) add(r.check, r.severity, r.field, r.message);

  // "Set"-mode links: diff desired targets against what points at this record in Salesforce now.
  const linkOps: PreparedUpdate["linkOps"] = [];
  for (const link of links) {
    if (!link.originalTargets) continue;
    const def2 = schema.inboundLinks.find(l => l.sobject === link.sobject && l.field === link.field && l.valueSource === "self");
    if (!def2) { add("links", "error", null, `Linking ${link.sobject}.${link.field} isn't supported for this record.`); continue; }
    const target = await billingDescribe(client, link.sobject);
    const tf = target.fields.find(f => f.name === link.field);
    const nameField = nameFieldOf(target)?.name ?? "Name";
    const live = await client.query<Record<string, unknown>>(`SELECT Id, ${nameField} FROM ${link.sobject} WHERE ${link.field} = '${soqlEscape(id)}' LIMIT 200`);
    const liveIds = new Set(live.records.map(r => (r.Id as string).slice(0, 15)));
    const wanted = new Set(link.targets.map(t => t.id.slice(0, 15)));
    const noun = link.sobject === "Product2" ? "Product" : link.sobject;
    for (const t of link.targets) {
      if (liveIds.has(t.id.slice(0, 15))) continue;
      if (!SALESFORCE_ID.test(t.id)) { add("links", "error", null, `"${t.name}" has an invalid record reference.`); continue; }
      linkOps.push({ sobject: link.sobject, field: link.field, recordId: t.id, recordName: t.name, value: id });
      changes.push({ kind: "link", field: `${link.sobject}.${link.field}`, label: noun, from: "Not linked", to: t.name });
      refChecks.push({ sobject: link.sobject, id: t.id, field: null, label: noun, name: t.name });
    }
    for (const r of live.records) {
      if (wanted.has((r.Id as string).slice(0, 15))) continue;
      if (tf && !tf.nillable) { add("links", "error", null, `${noun} "${String(r[nameField])}" can't be unlinked — ${link.field} is required on ${link.sobject}.`); continue; }
      linkOps.push({ sobject: link.sobject, field: link.field, recordId: r.Id as string, recordName: String(r[nameField]), value: null });
      changes.push({ kind: "unlink", field: `${link.sobject}.${link.field}`, label: noun, from: String(r[nameField]), to: "Not linked" });
    }
  }

  // Existence (and status) of every lookup / link target, one query per object.
  const byObject = new Map<string, typeof refChecks>();
  for (const rc of refChecks) { if (!byObject.has(rc.sobject)) byObject.set(rc.sobject, []); byObject.get(rc.sobject)!.push(rc); }
  await Promise.all([...byObject.entries()].map(async ([sobject, checks]) => {
    try {
      const d = await billingDescribe(client, sobject);
      const sf = d.fields.find(f => f.name === "Status")?.name ?? d.fields.find(f => f.name === "IsActive")?.name ?? null;
      const res = await client.query<Record<string, unknown>>(`SELECT Id${sf ? `, ${sf}` : ""} FROM ${sobject} WHERE Id IN (${[...new Set(checks.map(c => c.id))].map(x => `'${soqlEscape(x)}'`).join(",")})`);
      const found = new Map(res.records.map(r => [(r.Id as string).slice(0, 15), r]));
      for (const c of checks) {
        const row = found.get(c.id.slice(0, 15));
        if (!row) { add(c.field ? "references" : "links", "error", c.field, `The ${c.label} "${c.name}" no longer exists in Salesforce or isn't visible to your user.`); references.push({ path: "", field: c.field, label: c.label, name: c.name, sobject, status: "missing" }); continue; }
        const st = sf ? statusOf(row[sf]) : null;
        references.push({ path: "", field: c.field, label: c.label, name: c.name, sobject, status: st && /^(inactive|cancel)/i.test(st) ? "inactive" : "found", detail: st ?? undefined });
      }
    } catch {
      add("references", "warning", null, `Couldn't verify ${sobject} records — Salesforce will validate them on save.`);
    }
  }));

  if (changes.length === 0 && !issues.some(i => i.severity === "error")) add("fields", "info", null, "No changes to save yet.");

  const checks = (Object.keys(CHECK_LABELS) as CheckId[]).filter(c => c !== "structure").map(cid => {
    const mine = issues.filter(i => i.check === cid && i.severity !== "info");
    return { id: cid, label: CHECK_LABELS[cid], status: mine.some(i => i.severity === "error") ? "failed" as const : mine.some(i => i.severity === "warning") ? "warning" as const : "passed" as const, detail: mine.length ? `${mine.length} issue${mine.length > 1 ? "s" : ""}` : undefined };
  });

  return {
    schema, payload, linkOps,
    name: schema.nameField ? String(effective[schema.nameField] ?? id) : id,
    result: {
      valid: !issues.some(i => i.severity === "error"),
      issues: issues.map(i => ({ severity: i.severity, path: "", moduleKey, field: i.field, message: i.message })),
      checks, references, changes, transition: rules.transition,
    },
  };
}

/* ─────────────────────────── Save ─────────────────────────── */

export type BillingUpdateOutcome =
  | { ok: true; response: BillingUpdateResponse }
  | { ok: false; status: number; error: string; code: string | null; possibleCause: string | null; validation: BillingValidationResult; technical: unknown };

/**
 * Save an edit: re-validate server-side against the live record, then ONE all-or-nothing Composite
 * request — PATCH the record's changed fields, then PATCH each linked/unlinked record's reference
 * field. This is an UPDATE of the existing Id; nothing is ever re-created.
 */
export async function updateBillingRecord(client: SalesforceClient, moduleKey: string, id: string, draft: BillingDraftRecord, links: BillingDraftLink[] = []): Promise<BillingUpdateOutcome> {
  const prep = await prepareUpdate(client, moduleKey, id, draft, links);
  const singular = getBillingModule(moduleKey)?.singular ?? prep.schema.label;
  if (!prep.result.valid) {
    const first = prep.result.issues.find(i => i.severity === "error");
    return { ok: false, status: 422, code: "BILLING_VALIDATION_FAILED", error: first?.message ?? `The ${singular} changes aren't valid.`, possibleCause: "Fix the highlighted issues and validate again.", validation: prep.result, technical: { issues: prep.result.issues } };
  }
  if (Object.keys(prep.payload).length === 0 && prep.linkOps.length === 0) {
    return { ok: false, status: 400, code: "NO_CHANGES", error: "There are no changes to save.", possibleCause: null, validation: prep.result, technical: null };
  }

  const base = `/services/data/v${normalizeApiVersionNumber(client.apiVersion)}`;
  const requests: { method: "PATCH"; url: string; referenceId: string; body: Record<string, unknown> }[] = [];
  if (Object.keys(prep.payload).length) requests.push({ method: "PATCH", url: `${base}/sobjects/${prep.schema.sobject}/${id}`, referenceId: "record", body: prep.payload });
  prep.linkOps.forEach((op, i) => requests.push({ method: "PATCH", url: `${base}/sobjects/${op.sobject}/${op.recordId}`, referenceId: `link_${i}`, body: { [op.field]: op.value } }));

  const res = await client.request<{ compositeResponse: { body: unknown; httpStatusCode: number; referenceId: string }[] }>("/composite", {
    method: "POST", body: JSON.stringify({ allOrNone: true, compositeRequest: requests }),
  });
  const failures = res.compositeResponse.filter(r => r.httpStatusCode >= 400);
  if (failures.length) {
    const items: SalesforceErrorItem[] = failures.flatMap(f => (Array.isArray(f.body) ? (f.body as SalesforceErrorItem[]) : [{ message: String(f.body) }]));
    const summary = summarizeSalesforceErrors(items, { objectLabel: singular, fieldLabel: n => prep.schema.fields.find(f => f.name === n)?.label ?? n });
    return { ok: false, status: 400, code: summary.code, error: `Nothing was saved. ${summary.message}`, possibleCause: summary.possibleCause, validation: prep.result, technical: { compositeRequest: requests, compositeResponse: res.compositeResponse } };
  }
  return {
    ok: true,
    response: { success: true, id, name: prep.name, changes: prep.result.changes ?? [], salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, prep.schema.sobject, id), validation: prep.result },
  };
}
