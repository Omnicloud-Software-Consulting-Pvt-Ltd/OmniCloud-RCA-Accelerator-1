import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import type { BillingDraftRecord, BillingModuleSchema } from "@/lib/billing/types";
import { evaluateTaxRateRules, overlappingRates } from "@/lib/tax/server/rateRules";
import { findDuplicates } from "@/lib/tax/server/operations";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";

/**
 * Revenue Cloud Billing PLATFORM rules — enforced by Salesforce at save time but invisible in
 * Describe. Every rule here was verified against a live org (the quoted text is the exact message
 * Salesforce returns when it's violated). Checking them before the save lets the UI say "Cannot
 * activate — here's why" instead of claiming a configuration is valid and letting Salesforce reject
 * it. Used by BOTH create validation and update validation, so the two can never disagree.
 *
 *  R1 "A billable billing treatment must have at least one Active billing treatment item."
 *  R2 "Can't create or update a billing treatment item when the billing treatment is Active or Inactive."
 *  R3 "A billing treatment must have only one billing treatment item."            (non-milestone)
 *  R4 BillingTreatmentItem.BillingTreatmentId is createable but NOT updateable — an item can't be moved.
 *  R5 "Can't change status to Active when the default billing treatment is null." /
 *     "…unless the default billing treatment … has a status of [Active]."
 *  R6 A policy's default treatment may belong to another policy (accepted) — flagged as a warning.
 *  R7 "Can't change status from Active to Draft." / "…from Inactive to Draft."
 *  R8 "Can't edit Billing Treatment Selection when status is Active."
 *  R9 "Can't change status to Active because the default billing treatment … doesn't have a billing policy."
 */

export type RuleCheck = "rules" | "status" | "dependencies";
export interface RuleIssue { check: RuleCheck; severity: "error" | "warning" | "info"; field: string | null; message: string }

export interface RuleContext {
  client: SalesforceClient;
  moduleKey: string;
  schema: BillingModuleSchema;
  mode: "create" | "update";
  recordId: string | null;
  /** Values the record will have after the save (current merged with changes; reference fields as Ids). */
  effective: Record<string, unknown>;
  /** Current Salesforce values (update only). */
  current: Record<string, unknown> | null;
  /** Create only: children being created in the same request, and lookups pointing at them. */
  draftChildren?: BillingDraftRecord[];
  childReferenceFields?: string[];
}

export interface RuleResult {
  issues: RuleIssue[];
  transition: { field: string; from: string | null; to: string | null; ready: boolean; blockers: string[] } | null;
}

const RCB_STATUS_MODULES = new Set(["billing-policies", "billing-treatments", "billing-treatment-items"]);

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const q = (client: SalesforceClient, soql: string) => client.query<Record<string, unknown>>(soql).then(r => r.records);

export async function evaluateBillingRules(ctx: RuleContext): Promise<RuleResult> {
  const issues: RuleIssue[] = [];
  const statusField = ctx.schema.statusField;
  const from = statusField && ctx.current ? str(ctx.current[statusField]) : null;
  const to = statusField ? str(ctx.effective[statusField]) : null;
  const activating = to === "Active" && from !== "Active";

  if (ctx.moduleKey === "tax-rates") { await taxRateRules(ctx, issues); return { issues, transition: null }; }
  if (ctx.moduleKey === "geo-countries" || ctx.moduleKey === "geo-states") { await geoRules(ctx, issues); return { issues, transition: null }; }
  if (ctx.moduleKey === "tax-treatment-items") { if (ctx.mode === "create") await taxTreatmentItemRules(ctx, issues); return { issues, transition: null }; }
  if (ctx.moduleKey === "tax-treatments" || ctx.moduleKey === "tax-policies") {
    if (ctx.moduleKey === "tax-treatments") await taxTreatmentRules(ctx, issues, from, to);
    else await taxPolicyRules(ctx, issues, activating);
    const blockers = issues.filter(i => i.severity === "error").map(i => i.message);
    return { issues, transition: statusField && (ctx.mode === "create" ? !!to : from !== to) ? { field: statusField, from, to, ready: blockers.length === 0, blockers } : null };
  }
  if (!RCB_STATUS_MODULES.has(ctx.moduleKey)) return { issues, transition: null };

  // R7 — nothing can go back to Draft once it has been Active or Inactive.
  if (ctx.mode === "update" && statusField && to === "Draft" && from && from !== "Draft") {
    issues.push({ check: "status", severity: "error", field: statusField, message: `Salesforce doesn't allow changing Status from ${from} back to Draft. Use Inactive to retire this record.` });
  }

  if (ctx.moduleKey === "billing-treatments") await treatmentRules(ctx, issues, activating, to);
  if (ctx.moduleKey === "billing-treatment-items") await itemRules(ctx, issues);
  if (ctx.moduleKey === "billing-policies") await policyRules(ctx, issues, activating);

  const blockers = issues.filter(i => i.severity === "error" && (i.check === "status" || i.check === "rules")).map(i => i.message);
  const transition = statusField && (ctx.mode === "create" ? !!to : from !== to)
    ? { field: statusField, from, to, ready: blockers.length === 0, blockers }
    : null;
  return { issues, transition };
}

async function treatmentRules(ctx: RuleContext, issues: RuleIssue[], activating: boolean, to: string | null) {
  const nonMilestone = ctx.effective.IsMilestoneBilling !== true;
  const billable = ctx.effective.ExcludeFromBilling !== "Yes";

  if (ctx.mode === "create") {
    const items = (ctx.draftChildren ?? []).filter(c => c.moduleKey === "billing-treatment-items");
    if (nonMilestone && items.length > 1) issues.push({ check: "rules", severity: "error", field: null, message: "Salesforce allows only one Treatment Item on a non-milestone Billing Treatment — remove the extra items." });
    if (activating && billable) issues.push({ check: "status", severity: "error", field: "Status", message: "Create the Billing Treatment as Draft: Salesforce requires an Active Treatment Item before a treatment can be Active, and items are added after the treatment exists. Activate it from Edit afterwards." });
    return;
  }

  const items = await q(ctx.client, `SELECT Id, Name, Status FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(ctx.recordId!)}' ORDER BY ProcessingOrder`);
  const active = items.filter(i => i.Status === "Active");
  if (nonMilestone && items.length > 1) {
    issues.push({ check: "rules", severity: "error", field: null, message: `Invalid configuration: this non-milestone Billing Treatment has ${items.length} Treatment Items; Salesforce requires exactly one.` });
  }
  if (activating && billable && active.length === 0) {
    issues.push({
      check: "status", severity: "error", field: "Status",
      message: items.length
        ? `Cannot activate: Salesforce requires at least one Active Treatment Item. Activate "${String(items[0].Name)}" first (Edit the item → Status Active).`
        : "Cannot activate: Salesforce requires at least one Active Treatment Item, and this treatment has none. Create a Treatment Item first.",
    });
  }
  if (!activating && nonMilestone && items.length === 0) {
    issues.push({ check: "dependencies", severity: "warning", field: null, message: "This non-milestone Billing Treatment requires one Treatment Item." });
  }
  if (activating) {
    issues.push({ check: "dependencies", severity: "info", field: null, message: "Once Active, Salesforce no longer allows this treatment's Treatment Item to be edited, and the treatment can't return to Draft." });
  }
  if (to === "Inactive" && ctx.current?.Status !== "Inactive") {
    const policies = await q(ctx.client, `SELECT Name FROM BillingPolicy WHERE DefaultBillingTreatmentId = '${soqlEscape(ctx.recordId!)}' AND Status = 'Active'`).catch(() => []);
    if (policies.length) issues.push({ check: "dependencies", severity: "warning", field: "Status", message: `Active Billing Polic${policies.length > 1 ? "ies" : "y"} ${policies.map(p => `"${String(p.Name)}"`).join(", ")} use${policies.length > 1 ? "" : "s"} this as the default treatment — products on ${policies.length > 1 ? "them" : "it"} would bill with an inactive treatment.` });
  }
}

async function itemRules(ctx: RuleContext, issues: RuleIssue[]) {
  const parentId = str(ctx.effective.BillingTreatmentId);
  // R4 — the parent reference can't be changed after creation.
  if (ctx.mode === "update" && ctx.current && str(ctx.current.BillingTreatmentId) && parentId && str(ctx.current.BillingTreatmentId)!.slice(0, 15) !== parentId.slice(0, 15)) {
    const [target] = await q(ctx.client, `SELECT Name, IsMilestoneBilling FROM BillingTreatment WHERE Id = '${soqlEscape(parentId)}' LIMIT 1`).catch(() => []);
    const targetItems = await q(ctx.client, `SELECT Name FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(parentId)}' LIMIT 1`).catch(() => []);
    const occupied = target && target.IsMilestoneBilling !== true && targetItems.length > 0
      ? ` "${String(target.Name)}" also already has a Treatment Item ("${String(targetItems[0].Name)}"), and Salesforce allows only one Treatment Item for this non-milestone Treatment.`
      : "";
    issues.push({ check: "rules", severity: "error", field: "BillingTreatmentId", message: `Cannot move this Treatment Item${target ? ` to "${String(target.Name)}"` : ""}: Salesforce doesn't allow changing a Treatment Item's Billing Treatment after it is created.${occupied}` });
    return;
  }
  if (!parentId) return;
  const [parent] = await q(ctx.client, `SELECT Id, Name, Status, IsMilestoneBilling FROM BillingTreatment WHERE Id = '${soqlEscape(parentId)}' LIMIT 1`).catch(() => []);
  if (!parent) return;
  const parentName = String(parent.Name);
  if (parent.Status !== "Draft") {
    issues.push({ check: "rules", severity: "error", field: "BillingTreatmentId", message: `Salesforce doesn't allow ${ctx.mode === "create" ? "adding" : "editing"} a Treatment Item while its Billing Treatment "${parentName}" is ${String(parent.Status)}.` });
  }
  if (ctx.mode === "create" && parent.IsMilestoneBilling !== true) {
    const existing = await q(ctx.client, `SELECT Id, Name FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(parentId)}' LIMIT 2`).catch(() => []);
    if (existing.length > 0) {
      issues.push({ check: "rules", severity: "error", field: "BillingTreatmentId", message: `"${parentName}" already has a Treatment Item ("${String(existing[0].Name)}"). Salesforce allows only one Treatment Item for this non-milestone Treatment.` });
    }
  }
}

async function policyRules(ctx: RuleContext, issues: RuleIssue[], activating: boolean) {
  const defaultId = str(ctx.effective.DefaultBillingTreatmentId);
  const defaultIsNew = !!ctx.childReferenceFields?.includes("DefaultBillingTreatmentId");

  // R8 — treatment selection is frozen while Active.
  if (ctx.mode === "update" && ctx.current?.Status === "Active" && ctx.current.BillingTreatmentSelection !== ctx.effective.BillingTreatmentSelection) {
    issues.push({ check: "rules", severity: "error", field: "BillingTreatmentSelection", message: "Salesforce doesn't allow changing Billing Treatment Selection while the policy is Active." });
  }

  if (activating) {
    if (defaultIsNew) {
      issues.push({ check: "status", severity: "error", field: "Status", message: "Create the policy as Draft: its new default treatment starts as Draft, and Salesforce only activates a policy whose default treatment is Active." });
    } else if (!defaultId) {
      issues.push({ check: "status", severity: "error", field: "DefaultBillingTreatmentId", message: "Cannot activate: Salesforce requires a Default Billing Treatment before a Billing Policy can be Active." });
    }
  }
  if (!defaultId) return;

  const [t] = await q(ctx.client, `SELECT Id, Name, Status, BillingPolicyId, BillingPolicy.Name FROM BillingTreatment WHERE Id = '${soqlEscape(defaultId)}' LIMIT 1`).catch(() => []);
  if (!t) return;
  const tName = String(t.Name);
  if (activating && !str(t.BillingPolicyId)) {
    issues.push({ check: "status", severity: "error", field: "DefaultBillingTreatmentId", message: `Cannot activate: the default treatment "${tName}" isn't associated with any Billing Policy. Salesforce requires the default treatment to have a Billing Policy — edit "${tName}" and set its Billing Policy first.` });
  }
  if (activating && t.Status !== "Active") {
    issues.push({ check: "status", severity: "error", field: "DefaultBillingTreatmentId", message: `Cannot activate: the default treatment "${tName}" is ${String(t.Status)}. Salesforce requires the default billing treatment to be Active — activate it first.` });
  } else if (!activating && ctx.effective.Status === "Active" && t.Status !== "Active") {
    issues.push({ check: "dependencies", severity: "warning", field: "DefaultBillingTreatmentId", message: `The default treatment "${tName}" is ${String(t.Status)} while this policy is Active.` });
  }
  const owner = str(t.BillingPolicyId);
  if (owner && ctx.recordId && owner.slice(0, 15) !== ctx.recordId.slice(0, 15)) {
    const ownerName = (t.BillingPolicy as { Name?: string } | null)?.Name ?? "another policy";
    issues.push({ check: "dependencies", severity: "warning", field: "DefaultBillingTreatmentId", message: `"${tName}" belongs to Billing Policy "${ownerName}". Salesforce accepts it as this policy's default, but consider a treatment that belongs to this policy.` });
  }
}

/**
 * Tax Rates (Taxes record pages, create AND edit): the shared tax-rate rules — RevCloud usage enforced, explicit basis, required
 * dimensions (tax code, country, legal entity, start date), dates, and the API version exposing the v68 fields — plus overlaps
 * with existing rates that one invoice lookup could match together.
 */
/** Pure: an error for each existing Tax Rate the record would duplicate (the assistant's DUPLICATE_RULES for TaxRate). */
export function exactDuplicateRates(meta: Parameters<typeof findDuplicates>[0], values: Record<string, unknown>, rows: Record<string, unknown>[], selfId: string | null): RuleIssue[] {
  const others = rows.filter(r => !selfId || String(r.Id ?? "").slice(0, 15) !== selfId.slice(0, 15));
  return findDuplicates(meta, "TaxRate", values, others).map(({ row }) => ({ check: "rules" as const, severity: "error" as const, field: null,
    message: `An identical Tax Rate already exists: ${String(row.Name ?? row.Id)} (${String(row.Id)}) — the same tax code, geography, product code, legal entity, usage type and application basis, with overlapping effective dates. Reuse it, or end-date it first.` }));
}

/**
 * Tax Treatment rules Salesforce enforces or the org's evidence requires (verified in p10):
 *  · Active → Draft and Inactive → Draft are refused; Active ⇄ Inactive is allowed.
 *  · While Active, ShouldUseTaxTreatmentItems and ProductCode can't be edited; LegalEntityId can't be edited once the treatment has
 *    left Draft ("Can't edit Legal Entity while status is Active/Inactive").
 *  · Activating a TAXABLE treatment without a Legal Entity, tax engine or tax code (when it doesn't use items) is blocked: every taxable
 *    treatment without a Legal Entity produced no InvoiceLineTax (DOC-000000011/12/15/16 vs DOC-000000013/17).
 *  · An inactive engine, or one without a decision table, is a warning (the treatment saves, but tax won't be calculated).
 */
export function taxTreatmentIssues(a: { mode: "create" | "update"; from: string | null; to: string | null; effective: Record<string, unknown>; current: Record<string, unknown> | null; engine: { name: string; status: string | null; decisionTableId: string | null } | null }): RuleIssue[] {
  const out: RuleIssue[] = [];
  const e = a.effective, c = a.current;
  const changed = (f: string) => !!c && f in e && (e[f] ?? null) !== (c[f] ?? null) && String(e[f] ?? "").slice(0, 15) !== String(c[f] ?? "").slice(0, 15);
  if (a.mode === "update" && a.to === "Draft" && a.from && a.from !== "Draft") out.push({ check: "status", severity: "error", field: "Status", message: `Salesforce doesn't allow changing a Tax Treatment from ${a.from} back to Draft (Active ⇄ Inactive is allowed).` });
  if (a.mode === "update" && a.from === "Active") for (const f of ["ShouldUseTaxTreatmentItems", "ProductCode"]) if (changed(f)) out.push({ check: "rules", severity: "error", field: f, message: `${f} can't be edited while the Tax Treatment is Active.` });
  if (a.mode === "update" && a.from && a.from !== "Draft" && changed("LegalEntityId")) out.push({ check: "rules", severity: "error", field: "LegalEntityId", message: `The Legal Entity can't be edited while the Tax Treatment is ${a.from} — Salesforce locks it once the treatment leaves Draft (a new treatment is needed).` });
  const activating = a.to === "Active" && a.from !== "Active";
  if (activating && e.IsTaxable === true) {
    if (!e.LegalEntityId) out.push({ check: "rules", severity: "error", field: "LegalEntityId", message: "A taxable Tax Treatment needs a Legal Entity before activation — in this org taxable treatments without one produced no InvoiceLineTax, and it can't be added after activation." });
    if (!e.TaxEngineId) out.push({ check: "rules", severity: "error", field: "TaxEngineId", message: "A taxable Tax Treatment needs a Tax Engine before activation." });
    if (!e.TaxCode && e.ShouldUseTaxTreatmentItems !== true) out.push({ check: "rules", severity: "error", field: "TaxCode", message: "A taxable Tax Treatment needs a Tax Code (or Tax Treatment Items carrying the codes) — the decision table matches rates by tax code." });
    if (a.engine && a.engine.status !== "Active") out.push({ check: "dependencies", severity: "warning", field: "TaxEngineId", message: `Tax Engine "${a.engine.name}" is ${a.engine.status ?? "not Active"} — Salesforce won't calculate tax with it.` });
    else if (a.engine && !a.engine.decisionTableId) out.push({ check: "dependencies", severity: "warning", field: "TaxEngineId", message: `Tax Engine "${a.engine.name}" has no decision table — Salesforce falls back to the system table, which may not match by tax code.` });
  }
  return out;
}

async function taxTreatmentRules(ctx: RuleContext, issues: RuleIssue[], from: string | null, to: string | null) {
  const engineId = str(ctx.effective.TaxEngineId);
  let engine: { name: string; status: string | null; decisionTableId: string | null } | null = null;
  if (engineId && to === "Active") {
    try {
      const [r] = await q(ctx.client, `SELECT Id, TaxEngineName, Status, DecisionTableId FROM TaxEngine WHERE Id = '${soqlEscape(engineId)}'`);
      engine = r ? { name: String(r.TaxEngineName ?? r.Id), status: str(r.Status), decisionTableId: str(r.DecisionTableId) } : null;
    } catch (e) { issues.push({ check: "dependencies", severity: "warning", field: "TaxEngineId", message: `The Tax Engine couldn't be read (${e instanceof Error ? e.message : String(e)}) — its status and decision table weren't checked.` }); }
  }
  issues.push(...taxTreatmentIssues({ mode: ctx.mode, from, to, effective: ctx.effective, current: ctx.current, engine }));
}

export const ITEMS_NOT_ENABLED_MESSAGE = "Selected Tax Treatment does not support Tax Treatment Items. Enable Tax Treatment Items on the parent Tax Treatment before creating this record.";

/**
 * Tax Treatment Item create: the ONLY configuration prerequisite is the parent's "Use Tax Treatment Items" (Salesforce: "Specify a
 * tax treatment that has Use Tax Treatment Items selected"). Tax engine, tax rate, legal entity and decision table belong to the
 * treatment / rate validation — never checked here.
 */
export function taxTreatmentItemIssues(a: { treatment: { shouldUseItems: boolean | null } | null }): RuleIssue[] {
  if (!a.treatment || a.treatment.shouldUseItems !== false) return [];
  return [{ check: "rules", severity: "error", field: "TaxTreatmentId", message: ITEMS_NOT_ENABLED_MESSAGE }];
}

async function taxTreatmentItemRules(ctx: RuleContext, issues: RuleIssue[]) {
  const treatmentId = str(ctx.effective.TaxTreatmentId);
  if (!treatmentId) return;
  let row: Record<string, unknown> | undefined;
  try {
    [row] = await q(ctx.client, `SELECT Id, ShouldUseTaxTreatmentItems FROM TaxTreatment WHERE Id = '${soqlEscape(treatmentId)}'`);
  } catch (e) {
    // Fail closed: an unconfirmed prerequisite never lets the item be created.
    issues.push({ check: "rules", severity: "error", field: "TaxTreatmentId", message: `Couldn't confirm that the selected Tax Treatment allows Tax Treatment Items (${e instanceof Error ? e.message : String(e)}) — validate again before creating.` });
    return;
  }
  const flag = row?.ShouldUseTaxTreatmentItems;
  issues.push(...taxTreatmentItemIssues({ treatment: row ? { shouldUseItems: typeof flag === "boolean" ? flag : null } : null }));
}

/** Tax Policy activation (verified in p10): a Default-selection policy needs a default treatment that is already Active. */
export function taxPolicyIssues(a: { activating: boolean; selection: string | null; defaultTreatment: { id: string; name: string; status: string | null } | null; defaultTreatmentId: string | null }): RuleIssue[] {
  if (!a.activating || a.selection !== "Default") return [];
  if (!a.defaultTreatmentId) return [{ check: "rules", severity: "error", field: "DefaultTaxTreatmentId", message: "A Tax Policy with Default selection needs a Default Tax Treatment before it can be activated." }];
  if (a.defaultTreatment && a.defaultTreatment.status !== "Active") return [{ check: "status", severity: "error", field: "DefaultTaxTreatmentId", message: `Activate the default Tax Treatment "${a.defaultTreatment.name}" first — Salesforce refuses a policy whose default treatment isn't Active (it's ${a.defaultTreatment.status ?? "not Active"}).` }];
  return [];
}

async function taxPolicyRules(ctx: RuleContext, issues: RuleIssue[], activating: boolean) {
  const id = str(ctx.effective.DefaultTaxTreatmentId);
  let t: { id: string; name: string; status: string | null } | null = null;
  if (activating && id) {
    const [r] = await q(ctx.client, `SELECT Id, Name, Status FROM TaxTreatment WHERE Id = '${soqlEscape(id)}'`);
    t = r ? { id: String(r.Id), name: String(r.Name), status: str(r.Status) } : null;
  }
  issues.push(...taxPolicyIssues({ activating, selection: str(ctx.effective.TreatmentSelection), defaultTreatment: t, defaultTreatmentId: id }));
}

async function taxRateRules(ctx: RuleContext, issues: RuleIssue[]) {
  const sameish = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || String(a ?? "").slice(0, 15) === String(b ?? "").slice(0, 15) && !!a && !!b;
  const changed = ctx.current ? Object.keys(ctx.effective).filter(k => !sameish(ctx.effective[k], ctx.current![k])) : null;
  const today = new Date().toISOString().slice(0, 10);
  for (const r of evaluateTaxRateRules({ mode: ctx.mode, values: ctx.effective, changed, availableFields: ctx.schema.fields.map(f => f.name), today })) {
    issues.push({ check: "rules", severity: r.severity, field: r.field, message: r.message });
  }
  // The Geo State must belong to the rate's Geo Country (GeoState.GeoCountryId) — a Tax Rate is never saved with a state of another
  // country (GeoState ISO codes aren't unique across countries).
  const stateId = str(ctx.effective.GeoStateId);
  if (stateId) {
    try {
      const [gs] = await q(ctx.client, `SELECT Id, Name, GeoCountryId FROM GeoState WHERE Id = '${soqlEscape(stateId)}' LIMIT 1`);
      const issue = geoStateParentIssue(str(ctx.effective.GeoCountryId), gs ? { id: String(gs.Id), name: str(gs.Name), geoCountryId: str(gs.GeoCountryId) } : null);
      if (issue) issues.push(issue);
    } catch (e) {
      issues.push({ check: "rules", severity: "warning", field: "GeoStateId", message: `The Geo State's Geo Country couldn't be checked (${e instanceof Error ? e.message : String(e)}).` });
    }
  }
  const code = str(ctx.effective.TaxCode);
  if (!code) return;
  const cols = ["Id", "Name", "Rate", "TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis", "StartDate", "EndDate"].filter(c => c === "Id" || ctx.schema.fields.some(f => f.name === c));
  try {
    const rows = await q(ctx.client, `SELECT ${cols.join(", ")} FROM TaxRate WHERE TaxCode = '${soqlEscape(code)}' LIMIT 200`);
    for (const o of overlappingRates(ctx.effective, rows, ctx.recordId)) issues.push({ check: "rules", severity: o.severity, field: o.field, message: o.message });
    // Exact duplicates — every matching dimension equal and overlapping dates. overlappingRates leaves these to the duplicate rules,
    // so they are checked here too (the same rules the Tax Assistant applies), not only through the assistant.
    for (const d of exactDuplicateRates(await discoverTaxMetadata(ctx.client), ctx.effective, rows, ctx.recordId)) issues.push(d);
  } catch (e) {
    issues.push({ check: "rules", severity: "warning", field: null, message: `Overlapping rates couldn't be checked (${e instanceof Error ? e.message : String(e)}).` });
  }
}

/** Pure: a Tax Rate's Geo State must exist and belong to the rate's Geo Country. */
export function geoStateParentIssue(geoCountryId: string | null, state: { id: string; name: string | null; geoCountryId: string | null } | null): RuleIssue | null {
  if (!state) return { check: "rules", severity: "error", field: "GeoStateId", message: "The selected Geo State doesn't exist in this org — re-select it." };
  if (!geoCountryId) return { check: "rules", severity: "error", field: "GeoCountryId", message: `Geo State ${state.name ?? state.id} needs its Geo Country on the Tax Rate.` };
  if ((state.geoCountryId ?? "").slice(0, 15) !== geoCountryId.slice(0, 15)) return { check: "rules", severity: "error", field: "GeoStateId", message: `Geo State ${state.name ?? state.id} belongs to another Geo Country (${state.geoCountryId}) than this Tax Rate's (${geoCountryId}) — select a Geo State of the rate's Geo Country.` };
  return null;
}

/* ── Geo Country / Geo State: no duplicates by ISO code (fresh check at validate AND create time) ── */

/**
 * Pure: duplicate / parent issues for a Geo Country (unique IsoCode) or a Geo State (unique IsoCode under its GeoCountryId — the
 * parent lookup, never the name). `existing` = the rows Salesforce returned for that ISO code (and parent), read just now.
 */
export function geoIssues(a: { moduleKey: "geo-countries" | "geo-states"; isoCode: string | null; parentId: string | null; selfId: string | null; existing: { Id: string; Name?: string | null }[] }): RuleIssue[] {
  const out: RuleIssue[] = [];
  const kind = a.moduleKey === "geo-countries" ? "Geo Country" : "Geo State";
  if (a.moduleKey === "geo-states" && !a.parentId) out.push({ check: "dependencies", severity: "error", field: "GeoCountryId", message: "A Geo State needs its parent Geo Country (GeoCountryId) — create or select the Geo Country first." });
  if (!a.isoCode) { out.push({ check: "rules", severity: "error", field: "IsoCode", message: `${kind} ISO Code is required — Tax Rates and addresses are matched by it.` }); return out; }
  const dupes = a.existing.filter(r => r.Id !== a.selfId);
  if (dupes.length) out.push({ check: "rules", severity: "error", field: "IsoCode", message: `${kind} ${dupes.map(d => `${d.Name ?? ""} (${d.Id})`.trim()).join(", ")} already has ISO code ${a.isoCode}${a.moduleKey === "geo-states" ? " under this Geo Country" : ""} — no duplicate is created; use the existing record.` });
  return out;
}

async function geoRules(ctx: RuleContext, issues: RuleIssue[]) {
  const moduleKey = ctx.moduleKey as "geo-countries" | "geo-states";
  const iso = str(ctx.effective.IsoCode)?.trim().toUpperCase() ?? null;
  const parentId = moduleKey === "geo-states" ? str(ctx.effective.GeoCountryId) : null;
  const object = moduleKey === "geo-countries" ? "GeoCountry" : "GeoState";
  const where = iso ? `IsoCode = '${soqlEscape(iso)}'${moduleKey === "geo-states" ? (parentId ? ` AND GeoCountryId = '${soqlEscape(parentId)}'` : " AND Id = null") : ""}` : null;
  const existing = where ? await q(ctx.client, `SELECT Id, Name FROM ${object} WHERE ${where} LIMIT 5`) as { Id: string; Name?: string | null }[] : [];
  issues.push(...geoIssues({ moduleKey, isoCode: iso, parentId, selfId: ctx.recordId, existing }));
}
