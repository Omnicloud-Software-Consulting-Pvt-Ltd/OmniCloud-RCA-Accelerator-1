import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { isValidForControllingIndex } from "@/lib/salesforce/describe";
import { getBillingModule, type BillingModuleDef } from "@/lib/billing/registry";
import { billingDescribe, getModuleSchema } from "@/lib/billing/server/discovery";
import { SALESFORCE_ID } from "@/lib/billing/server/lookup";
import { coerceFieldValue, isEmptyValue } from "@/lib/billing/server/values";
import { evaluateBillingRules } from "@/lib/billing/server/rules";
import type {
  BillingDraftLink, BillingDraftRecord, BillingFieldMeta, BillingModuleSchema,
  BillingResolvedReference, BillingValidationIssue, BillingValidationResult,
} from "@/lib/billing/types";

export type CheckId = "object" | "fields" | "required" | "picklists" | "references" | "rules" | "status" | "dependencies" | "dates" | "types" | "structure" | "links";

export const CHECK_LABELS: Record<CheckId, string> = {
  object: "Salesforce object createable",
  fields: "Field availability",
  required: "Required fields",
  picklists: "Picklist values",
  references: "Lookup records exist",
  rules: "Billing-specific requirements",
  status: "Status transition",
  dependencies: "Dependent configuration",
  dates: "Date validity",
  types: "Value types & lengths",
  structure: "Parent / child relationships",
  links: "Product / record links",
};

/** Salesforce's Composite API caps one all-or-nothing request at 25 subrequests. */
export const MAX_COMPOSITE_SUBREQUESTS = 25;

interface IssueWithCheck extends BillingValidationIssue { check: CheckId }

interface RefCheck { sobject: string; id: string; path: string; moduleKey: string; field: string | null; label: string; name: string }

/** A draft node flattened with its resolved schema — shared by validation and the create pipeline. */
export interface PreparedNode {
  path: string;
  key: string;
  moduleKey: string;
  schema: BillingModuleSchema;
  /** Only createable fields, coerced to Salesforce types, reference Ids included. Parent reference is NOT included (filled at create time). */
  payload: Record<string, unknown>;
  parentPath: string | null;
  parentField: string | null;
  displayName: string | null;
  /** Lookups on this record that point at one of its own new children — back-filled right after insert. */
  childReferences: { field: string; childPath: string }[];
}

/** Start/end field pairs by the org's own naming — StartDate/EndDate, EffectiveFrom/EffectiveTo, ...Start.../...End... */
function datePairs(schema: BillingModuleSchema): [BillingFieldMeta, BillingFieldMeta][] {
  const dateFields = schema.fields.filter(f => f.type === "date" || f.type === "datetime");
  const pairs: [BillingFieldMeta, BillingFieldMeta][] = [];
  for (const start of dateFields) {
    const counterpartName = start.name.includes("Start") ? start.name.replace("Start", "End") : start.name.endsWith("From") ? start.name.replace(/From$/, "To") : null;
    const end = counterpartName ? dateFields.find(f => f.name === counterpartName) : undefined;
    if (end) pairs.push([start, end]);
  }
  return pairs;
}

/**
 * The value of `defaultsCondition.parentFlag` on this node's parent: from the parent draft when the
 * parent is created in the same request, otherwise from the Salesforce record the node references.
 * null = unknown (no parent selected yet, or it couldn't be read).
 */
export async function parentFlagFor(
  client: SalesforceClient, def: BillingModuleDef, schema: BillingModuleSchema, payload: Record<string, unknown>,
  parent: { node: { moduleKey: string; payload: Record<string, unknown> } } | null,
): Promise<boolean | null> {
  const cond = def.defaultsCondition;
  if (!cond) return null;
  if (parent && parent.node.moduleKey === cond.parentModule) return parent.node.payload[cond.parentFlag] === true;
  const parentSchema = await getModuleSchema(client, cond.parentModule).catch(() => null);
  if (!parentSchema || !parentSchema.fields.some(f => f.name === cond.parentFlag)) return null;
  const refField = schema.fields.find(f => f.type === "reference" && f.referenceTo.includes(parentSchema.sobject));
  const parentId = refField ? payload[refField.name] : null;
  if (typeof parentId !== "string") return null;
  try {
    const res = await client.query<Record<string, unknown>>(`SELECT ${cond.parentFlag} FROM ${parentSchema.sobject} WHERE Id = '${soqlEscape(parentId)}' LIMIT 1`);
    const v = res.records[0]?.[cond.parentFlag];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Server-side validation of a draft tree (never trusting the client's own checks) against the
 * connected org's live metadata AND data: createability, fields, required values, picklists incl.
 * dependent values, lookup existence/status, Revenue Cloud Billing platform rules, dependencies,
 * dates, types, structure and links. Also returns the prepared payload used by the create pipeline,
 * so what was validated is exactly what gets sent.
 */
export async function prepareAndValidate(
  client: SalesforceClient,
  root: BillingDraftRecord,
  links: BillingDraftLink[] = [],
): Promise<{ result: BillingValidationResult; nodes: PreparedNode[] }> {
  const issues: IssueWithCheck[] = [];
  const refChecks: RefCheck[] = [];
  const nodes: PreparedNode[] = [];
  const references: BillingResolvedReference[] = [];
  const add = (check: CheckId, severity: IssueWithCheck["severity"], path: string, moduleKey: string, field: string | null, message: string) =>
    issues.push({ check, severity, path, moduleKey, field, message });

  async function walk(draft: BillingDraftRecord, path: string, parent: { node: PreparedNode; parentField: string } | null, depth: number) {
    const def = getBillingModule(draft.moduleKey);
    let schema: BillingModuleSchema;
    try {
      schema = await getModuleSchema(client, draft.moduleKey);
    } catch (err) {
      add("object", "error", path, draft.moduleKey, null, err instanceof Error ? err.message : `${def?.singular ?? draft.moduleKey} isn't available in this org.`);
      return;
    }
    const singular = def?.singular ?? schema.label;
    if (!schema.createable) {
      add("object", "error", path, draft.moduleKey, null, def?.readOnlyNote ?? `${singular} records can't be created through the API in this org.`);
      return;
    }

    const payload: Record<string, unknown> = {};
    const fieldByName = new Map(schema.fields.map(f => [f.name, f]));

    for (const [name, raw] of Object.entries(draft.fields ?? {})) {
      const field = fieldByName.get(name);
      if (!field) { add("fields", "warning", path, draft.moduleKey, name, `${name} doesn't exist on ${schema.label} in this org — it will be ignored.`); continue; }
      if (!field.createable) { if (!isEmptyValue(raw)) add("fields", "warning", path, draft.moduleKey, name, `${field.label} is read-only in this org — it will be ignored.`); continue; }
      if (field.type === "reference") continue;
      const coerced = coerceFieldValue(field, raw);
      if (!coerced.ok) { add(field.type === "picklist" || field.type === "multipicklist" ? "picklists" : "types", "error", path, draft.moduleKey, name, coerced.reason); continue; }
      if (coerced.value !== null) payload[name] = coerced.value;
    }

    for (const [name, ref] of Object.entries(draft.references ?? {})) {
      const field = fieldByName.get(name);
      if (!ref) continue;
      if (!field || field.type !== "reference") { add("fields", "warning", path, draft.moduleKey, name, `${name} isn't a lookup field on ${schema.label} — ignored.`); continue; }
      if (!field.createable) { add("fields", "warning", path, draft.moduleKey, name, `${field.label} is read-only in this org — ignored.`); continue; }
      if (parent && name === parent.parentField) continue;
      if (!SALESFORCE_ID.test(ref.id)) { add("references", "error", path, draft.moduleKey, name, `${field.label} has an invalid record reference — re-select it with the lookup.`); continue; }
      const target = field.referenceTo.includes(ref.sobject) ? ref.sobject : field.referenceTo[0];
      if (!target) continue;
      payload[name] = ref.id;
      refChecks.push({ sobject: target, id: ref.id, path, moduleKey: draft.moduleKey, field: name, label: field.label, name: ref.name });
    }

    // Lookups satisfied by a child created in the same request (e.g. a new policy's default treatment).
    const childReferences: PreparedNode["childReferences"] = [];
    for (const [name, childKey] of Object.entries(draft.childReferences ?? {})) {
      const field = fieldByName.get(name);
      const childIdx = draft.children.findIndex(c => c.key === childKey);
      const child = draft.children[childIdx];
      const childSchema = child ? await getModuleSchema(client, child.moduleKey).catch(() => null) : null;
      if (!field || field.type !== "reference") { add("structure", "error", path, draft.moduleKey, name, `${name} isn't a lookup on ${schema.label}.`); continue; }
      if (!child || !childSchema) { add("structure", "error", path, draft.moduleKey, name, `${field.label} points at a new record that was removed — select an existing record or add it again.`); continue; }
      if (!field.referenceTo.includes(childSchema.sobject)) { add("structure", "error", path, draft.moduleKey, name, `${field.label} can't point at a ${childSchema.label}.`); continue; }
      if (field.required || !field.updateable) { add("structure", "error", path, draft.moduleKey, name, `${field.label} must reference an existing record — Salesforce can't set it after the new ${childSchema.label} is created.`); continue; }
      const childPath = path ? `${path}.${childIdx}` : String(childIdx);
      childReferences.push({ field: name, childPath });
      const childName = childSchema.nameField ? child.fields[childSchema.nameField] : null;
      references.push({ path, field: name, label: field.label, name: typeof childName === "string" && childName ? childName : `new ${childSchema.label}`, sobject: childSchema.sobject, status: "new", detail: "Created in this request" });
    }

    for (const [name, u] of Object.entries(draft.unresolved ?? {})) {
      if (payload[name] || draft.childReferences?.[name]) continue;
      const field = fieldByName.get(name);
      const label = field?.label ?? name;
      const message = u.candidates.length > 1
        ? `${label} "${u.searchedName}" matched ${u.candidates.length} records in Salesforce — choose one.`
        : `${label} "${u.searchedName}" was not found in Salesforce.${field?.required ? " Required Salesforce value could not be resolved." : ""}`;
      add("references", field?.required ? "error" : "warning", path, draft.moduleKey, name, message);
      references.push({ path, field: name, label, name: u.searchedName, sobject: u.sobject, status: "unresolved", detail: u.candidates.length > 1 ? `${u.candidates.length} matches` : "Not found" });
    }

    for (const f of schema.fields) {
      if (!f.required || f.system) continue;
      if (parent && f.name === parent.parentField) continue;
      const alreadyReported = issues.some(i => i.path === path && i.field === f.name && i.severity === "error");
      if (isEmptyValue(payload[f.name]) && !draft.unresolved?.[f.name] && !alreadyReported) {
        add("required", "error", path, draft.moduleKey, f.name, f.type === "reference" ? `${singular} requires a ${f.label}.` : `${f.label} is required for a ${singular}.`);
      }
    }

    // Dependent picklists: the value must be valid for the controlling field's value (Describe's validFor bitmask).
    for (const f of schema.fields) {
      if (!f.controllerName || isEmptyValue(payload[f.name]) || (f.type !== "picklist" && f.type !== "multipicklist")) continue;
      const controller = fieldByName.get(f.controllerName);
      const controlling = payload[f.controllerName];
      if (!controller || isEmptyValue(controlling)) continue;
      const idx = controller.type === "boolean" ? (controlling ? 1 : 0) : controller.picklistValues.findIndex(p => p.value === controlling);
      const option = f.picklistValues.find(p => p.value === payload[f.name]);
      if (option?.validFor && idx >= 0 && !isValidForControllingIndex(option.validFor, idx)) {
        add("picklists", "error", path, draft.moduleKey, f.name, `${f.label} "${String(payload[f.name])}" isn't allowed when ${controller.label} is "${String(controlling)}".`);
      }
    }

    for (const [start, end] of datePairs(schema)) {
      const s = payload[start.name], e = payload[end.name];
      if (typeof s === "string" && typeof e === "string" && new Date(e).getTime() < new Date(s).getTime()) {
        add("dates", "error", path, draft.moduleKey, end.name, `${end.label} must be on or after ${start.label}.`);
      }
    }

    const nameValue = schema.nameField ? payload[schema.nameField] : null;
    const node: PreparedNode = {
      path, key: draft.key, moduleKey: draft.moduleKey, schema, payload,
      parentPath: parent?.node.path ?? null, parentField: parent?.parentField ?? null,
      displayName: typeof nameValue === "string" ? nameValue : null,
      childReferences,
    };
    nodes.push(node);

    // Revenue Cloud Billing platform rules Describe can't express (registry `defaults`, only where they apply).
    if (def?.defaults && def.defaultsCondition) {
      const flag = await parentFlagFor(client, def, schema, payload, parent);
      if (flag === def.defaultsCondition.applyWhen) {
        for (const [name, required] of Object.entries(def.defaults)) {
          const field = fieldByName.get(name);
          if (!field || !field.createable || payload[name] === required) continue;
          const valueLabel = field.picklistValues.find(p => p.value === required)?.label ?? String(required);
          add("rules", "error", path, draft.moduleKey, name, `${field.label} must be "${valueLabel}" — ${def.defaultsReason ?? "required by Salesforce for this configuration."}`);
        }
      }
    }

    // Org-verified platform rules (one item per treatment, activation prerequisites, parent status…).
    const ruleResult = await evaluateBillingRules({
      client, moduleKey: draft.moduleKey, schema, mode: "create", recordId: null,
      effective: payload, current: null, draftChildren: draft.children, childReferenceFields: Object.keys(draft.childReferences ?? {}),
    });
    for (const ri of ruleResult.issues) if (ri.severity !== "info") add(ri.check, ri.severity, path, draft.moduleKey, ri.field, ri.message);

    // Dependencies that don't block creation but leave the configuration incomplete.
    for (const rec of def?.recommendedReferences ?? []) {
      if (!fieldByName.has(rec.field)) continue;
      if (isEmptyValue(payload[rec.field]) && !draft.childReferences?.[rec.field] && !draft.unresolved?.[rec.field]) add("dependencies", "warning", path, draft.moduleKey, rec.field, rec.message);
    }
    const children = draft.children ?? [];
    if (def?.recommendedChild && schema.children.some(c => c.moduleKey === def.recommendedChild!.moduleKey) && !children.some(c => c.moduleKey === def.recommendedChild!.moduleKey)) {
      add("dependencies", "warning", path, draft.moduleKey, null, def.recommendedChild.message);
    }

    if (children.length > 0 && depth >= 2) {
      add("structure", "error", path, draft.moduleKey, null, "Records can only be nested two levels deep in one request.");
      return;
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childPath = path ? `${path}.${i}` : String(i);
      const rel = schema.children.find(c => c.moduleKey === child.moduleKey);
      if (!rel) {
        add("structure", "error", childPath, child.moduleKey, null, `${getBillingModule(child.moduleKey)?.singular ?? child.moduleKey} can't be created under a ${singular} in this org.`);
        continue;
      }
      await walk(child, childPath, { node, parentField: rel.parentField }, depth + 1);
    }
  }

  await walk(root, "", null, 0);
  const rootNode = nodes.find(n => n.path === "");

  // Opt-in links to existing records (e.g. assign the new Billing Policy to products).
  for (const link of links.filter(l => l.enabled)) {
    const def = rootNode?.schema.inboundLinks.find(l => l.sobject === link.sobject && l.field === link.field);
    if (!rootNode || !def) { add("links", "error", "", root.moduleKey, null, `Linking ${link.sobject}.${link.field} isn't supported for this record in this org.`); continue; }
    if (link.targets.length === 0) { add("links", "warning", "", root.moduleKey, null, `"${def.label}" is enabled but no records were selected — it will be skipped.`); continue; }
    if (typeof def.valueSource === "object") {
      const sourceField = def.valueSource.field;
      if (isEmptyValue(rootNode.payload[sourceField])) {
        const label = rootNode.schema.fields.find(f => f.name === sourceField)?.label ?? sourceField;
        add("links", "error", "", root.moduleKey, sourceField, `"${def.label}" needs ${label} to be selected first.`);
      }
    }
    for (const t of link.targets) {
      if (!SALESFORCE_ID.test(t.id)) { add("links", "error", "", root.moduleKey, null, `"${t.name}" has an invalid record reference.`); continue; }
      refChecks.push({ sobject: link.sobject, id: t.id, path: "", moduleKey: root.moduleKey, field: null, label: link.sobject === "Product2" ? "Product" : link.sobject, name: t.name });
    }
  }

  const subrequests = nodes.length + nodes.reduce((n, x) => n + (x.childReferences.length ? 1 : 0), 0) + links.filter(l => l.enabled).reduce((n, l) => n + l.targets.length, 0);
  if (subrequests > MAX_COMPOSITE_SUBREQUESTS) {
    add("structure", "error", "", root.moduleKey, null, `This configuration needs ${subrequests} Salesforce operations; one all-or-nothing request allows ${MAX_COMPOSITE_SUBREQUESTS}. Remove some child records or links.`);
  }

  // Lookup existence + "is the referenced record usable" (inactive status) — one query per target object.
  const byObject = new Map<string, RefCheck[]>();
  for (const rc of refChecks) {
    if (!byObject.has(rc.sobject)) byObject.set(rc.sobject, []);
    byObject.get(rc.sobject)!.push(rc);
  }
  await Promise.all([...byObject.entries()].map(async ([sobject, checks]) => {
    try {
      const d = await billingDescribe(client, sobject);
      const statusField = d.fields.find(f => f.name === "Status")?.name ?? d.fields.find(f => f.name === "IsActive")?.name ?? null;
      const ids = [...new Set(checks.map(c => c.id))];
      const res = await client.query<Record<string, unknown>>(`SELECT Id${statusField ? `, ${statusField}` : ""} FROM ${sobject} WHERE Id IN (${ids.map(id => `'${soqlEscape(id)}'`).join(",")})`);
      const found = new Map(res.records.map(r => [(r.Id as string).slice(0, 15), r]));
      for (const c of checks) {
        const row = found.get(c.id.slice(0, 15));
        const check: CheckId = c.field ? "references" : "links";
        if (!row) {
          add(check, "error", c.path, c.moduleKey, c.field, `The ${c.label} "${c.name}" no longer exists in Salesforce or isn't visible to your user.`);
          references.push({ path: c.path, field: c.field, label: c.label, name: c.name, sobject, status: "missing" });
          continue;
        }
        const st = statusField ? row[statusField] : null;
        if (st === false || (typeof st === "string" && /^(inactive|cancel|void)/i.test(st))) {
          add(check, "warning", c.path, c.moduleKey, c.field, `The ${c.label} "${c.name}" is ${typeof st === "string" ? st : "inactive"} — Salesforce may reject or ignore it.`);
          references.push({ path: c.path, field: c.field, label: c.label, name: c.name, sobject, status: "inactive", detail: typeof st === "string" ? st : "Inactive" });
        } else {
          references.push({ path: c.path, field: c.field, label: c.label, name: c.name, sobject, status: "found", detail: typeof st === "string" ? st : undefined });
        }
      }
    } catch {
      add("references", "warning", "", root.moduleKey, null, `Couldn't verify ${sobject} references (no read access?) — Salesforce will validate them on create.`);
    }
  }));

  const checks = (Object.keys(CHECK_LABELS) as CheckId[]).map(id => {
    const mine = issues.filter(i => i.check === id);
    const status = mine.some(i => i.severity === "error") ? "failed" as const : mine.some(i => i.severity === "warning") ? "warning" as const : "passed" as const;
    return { id, label: CHECK_LABELS[id], status, detail: mine.length ? `${mine.length} issue${mine.length > 1 ? "s" : ""}` : undefined };
  });

  references.sort((a, b) => a.path.localeCompare(b.path));
  return {
    result: {
      valid: !issues.some(i => i.severity === "error"),
      issues: issues.map(i => ({ severity: i.severity, path: i.path, moduleKey: i.moduleKey, field: i.field, message: i.message })),
      checks,
      references,
    },
    nodes,
  };
}
