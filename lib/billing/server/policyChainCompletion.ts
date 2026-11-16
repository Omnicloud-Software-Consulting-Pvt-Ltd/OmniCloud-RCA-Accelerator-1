import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { billingDescribe } from "@/lib/billing/server/discovery";
import { createBillingRecords } from "@/lib/billing/server/create";
import { updateBillingRecord } from "@/lib/billing/server/edit";
import type { OrderBillingState } from "@/lib/billing/server/orderBilling";

/**
 * Completes ONE existing Billing Policy → Billing Treatment → Billing Treatment Item chain so the
 * policy can be Active — one confirmed stage per request, in Salesforce's documented activation order
 * (item → treatment → policy default → policy). Billing configuration only:
 *  - writes go to BillingTreatmentItem / BillingTreatment / BillingPolicy and nothing else (no Order,
 *    Order Product, Billing Schedule, Invoice or any tax object), through the existing validated
 *    create/update services, so the platform rules (R1–R9 in rules.ts) are enforced on every write;
 *  - never creates a policy or treatment, never repoints a product, never overwrites an existing
 *    default treatment;
 *  - every stage is previewed and runs only when `confirm` names it; Salesforce is re-read after the
 *    write and the stage's postcondition verified before it is reported done.
 */

export type ChainStage = "create-item" | "activate-item" | "activate-treatment" | "set-default" | "activate-policy";
export const CHAIN_STAGES: readonly ChainStage[] = ["create-item", "activate-item", "activate-treatment", "set-default", "activate-policy"];
/** The only objects this workflow may write. */
export const CHAIN_WRITE_OBJECTS: ReadonlySet<string> = new Set(["BillingTreatmentItem", "BillingTreatment", "BillingPolicy"]);
/** Fields copied from the working reference item (the pattern — never its Ids). */
export const ITEM_PATTERN_FIELDS = ["ProcessingOrder", "Type", "BillingType", "Sequencing", "Controller", "Handling0Amount"] as const;

export interface ChainItem { id: string; name: string; status: string | null; treatmentId: string; fields: Record<string, unknown> }
export interface ChainSnapshot {
  policy: { id: string; name: string; status: string | null; selection: string | null; defaultTreatmentId: string | null } | null;
  treatment: { id: string; name: string; status: string | null; policyId: string | null; legalEntityId: string | null; milestone: boolean; billable: boolean } | null;
  items: ChainItem[];
  products: { id: string; name: string }[];
}
export interface ReferenceItem { id: string; name: string; treatmentName: string; policyName: string | null; fields: Record<string, unknown> }
export type WriteResult = { ok: true; id: string } | { ok: false; status: number; code: string | null; error: string; technical?: unknown };

export interface ChainApi {
  snapshot(policyId: string, treatmentId: string): Promise<ChainSnapshot>;
  /** The working Advance/Remainder item on an Active non-milestone treatment, used as the structural model. */
  referenceItem(): Promise<{ item: ReferenceItem | null; candidates: { id: string; name: string }[] }>;
  /** BillingTreatmentItem fields Salesforce requires on create in THIS org (createable, not nillable, not defaulted). */
  itemRequiredFields(): Promise<string[]>;
  createItem(treatment: { id: string; name: string }, fields: Record<string, unknown>): Promise<WriteResult>;
  update(sobject: "BillingTreatmentItem" | "BillingTreatment" | "BillingPolicy", id: string, change: { fields?: Record<string, unknown>; references?: Record<string, { id: string; name: string; sobject: string }> }): Promise<WriteResult>;
}

export interface StagePlan {
  stage: ChainStage;
  label: string;
  state: "done" | "ready" | "blocked" | "waiting";
  object: string;
  operation: "create" | "update";
  recordId: string | null;
  fields: { field: string; from: unknown; to: unknown }[];
  lookups: { field: string; sobject: string; id: string; name: string }[];
  lifecycle: string[];
  blockers: { object: string; field: string | null; current: unknown; required: string; message: string }[];
}

export type ChainStatus = "BILLING_CONFIGURATION_READY" | "BILLING_CONFIGURATION_BLOCKED" | "AWAITING_CONFIRMATION" | "STAGE_FAILED";
export interface ChainResult {
  success: true;
  status: ChainStatus;
  message: string;
  snapshot: ChainSnapshot;
  reference: ReferenceItem | null;
  stages: StagePlan[];
  next: StagePlan | null;
  /** The stage performed by this request (if any), with its Salesforce outcome and re-read verification. */
  performed: { stage: ChainStage; object: string; recordId: string | null; ok: boolean; verified: boolean; detail: string; salesforce?: { status: number; code: string | null; error: string } } | null;
  writes: { object: string; id: string | null }[];
}

const LABEL: Record<ChainStage, string> = {
  "create-item": "Create Billing Treatment Item",
  "activate-item": "Activate Billing Treatment Item",
  "activate-treatment": "Activate Billing Treatment",
  "set-default": "Set policy default treatment",
  "activate-policy": "Activate Billing Policy",
};
const same15 = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.slice(0, 15) === b.slice(0, 15);

export function proposedItemFields(treatmentName: string, ref: ReferenceItem): Record<string, unknown> {
  const out: Record<string, unknown> = { Name: `${treatmentName} Item`, Status: "Draft" };
  for (const f of ITEM_PATTERN_FIELDS) if (ref.fields[f] !== undefined && ref.fields[f] !== null) out[f] = ref.fields[f];
  return out;
}

/** Pure: what each stage needs, given the live snapshot. The first unfinished stage is ready/blocked; later ones wait. */
export function planChain(s: ChainSnapshot, ref: { item: ReferenceItem | null; candidates: { id: string; name: string }[] }, required: string[], opts: { productId?: string | null } = {}): StagePlan[] {
  const { policy: p, treatment: t, items } = s;
  const activeItem = items.find(i => i.status === "Active") ?? null;
  const item = activeItem ?? items[0] ?? null;
  const B = (object: string, field: string | null, current: unknown, requiredValue: string, message: string) => ({ object, field, current: current ?? null, required: requiredValue, message });
  const stages: StagePlan[] = [];
  const mk = (stage: ChainStage, object: string, operation: "create" | "update", recordId: string | null, done: boolean, blockers: StagePlan["blockers"], extra: Partial<StagePlan> = {}): StagePlan =>
    ({ stage, label: LABEL[stage], state: done ? "done" : blockers.length ? "blocked" : "ready", object, operation, recordId, fields: [], lookups: [], lifecycle: [], blockers, ...extra });

  const base: StagePlan["blockers"] = [];
  if (!p) base.push(B("BillingPolicy", null, null, "existing record", "The Billing Policy doesn't exist or isn't visible to your user."));
  if (!t) base.push(B("BillingTreatment", null, null, "existing record", "The Billing Treatment doesn't exist or isn't visible to your user."));
  if (p && t && !same15(t.policyId, p.id)) base.push(B("BillingTreatment", "BillingPolicyId", t.policyId, p.id, `"${t.name}" doesn't belong to Billing Policy "${p.name}".`));
  if (t?.milestone) base.push(B("BillingTreatment", "IsMilestoneBilling", true, "false", `"${t.name}" is a milestone treatment — this workflow only completes non-milestone treatments.`));
  if (base.length || !p || !t) return CHAIN_STAGES.map((st, i) => mk(st, "—", "update", null, false, i === 0 ? base : [], { state: i === 0 ? "blocked" : "waiting" }));

  // 1. Create the item (Salesforce R2: only while the treatment is Draft; R3: one item on a non-milestone treatment).
  {
    const b: StagePlan["blockers"] = [];
    const done = items.length > 0;
    let fields: StagePlan["fields"] = [];
    if (!done) {
      if (t.status !== "Draft") b.push(B("BillingTreatment", "Status", t.status, "Draft", `Salesforce only allows adding a Treatment Item while "${t.name}" is Draft.`));
      if (!ref.item) b.push(B("BillingTreatmentItem", null, null, "one Active Advance/Remainder item to use as the model", ref.candidates.length > 1 ? `${ref.candidates.length} working Advance items match (${ref.candidates.map(c => c.name).join(", ")}) — the model is ambiguous.` : "No working Advance Billing Treatment Item exists to use as the model."));
      else {
        const v = proposedItemFields(t.name, ref.item);
        fields = Object.entries(v).map(([field, to]) => ({ field, from: null, to }));
        const provided = new Set([...Object.keys(v), "BillingTreatmentId"]);
        for (const r of required.filter(r => !provided.has(r))) b.push(B("BillingTreatmentItem", r, null, "a value", `Salesforce requires ${r} on a Billing Treatment Item in this org, and the model item doesn't provide it.`));
      }
    }
    stages.push(mk("create-item", "BillingTreatmentItem", "create", item?.id ?? null, done, b, {
      fields, lookups: [{ field: "BillingTreatmentId", sobject: "BillingTreatment", id: t.id, name: t.name }],
      lifecycle: ["Created as Draft — activation is a separate confirmed stage.", "Salesforce doesn't allow moving the item to another treatment after creation.", `Model: "${ref.item?.name ?? "—"}" on "${ref.item?.treatmentName ?? "—"}" (pattern fields only; no Ids copied).`],
    }));
  }
  // 2. Activate the item (still requires the treatment to be Draft — R2).
  {
    const b: StagePlan["blockers"] = [];
    const done = !!activeItem;
    if (!done) {
      if (!item) b.push(B("BillingTreatmentItem", null, null, "one item", `"${t.name}" has no Treatment Item yet.`));
      if (items.length > 1) b.push(B("BillingTreatmentItem", null, items.length, "1", `"${t.name}" has ${items.length} Treatment Items; Salesforce allows exactly one on a non-milestone treatment.`));
      if (t.status !== "Draft") b.push(B("BillingTreatment", "Status", t.status, "Draft", `Salesforce doesn't allow updating a Treatment Item while "${t.name}" is ${t.status}.`));
    }
    stages.push(mk("activate-item", "BillingTreatmentItem", "update", item?.id ?? null, done, b, { fields: item && !done ? [{ field: "Status", from: item.status, to: "Active" }] : [], lifecycle: ["An Active item can't return to Draft.", "The parent treatment is NOT activated by this stage."] }));
  }
  // 3. Activate the treatment (R1: needs an Active item; Legal Entity only when the policy selects treatments by Legal Entity).
  {
    const b: StagePlan["blockers"] = [];
    const done = t.status === "Active";
    if (!done) {
      if (t.billable && !activeItem) b.push(B("BillingTreatmentItem", "Status", item?.status ?? null, "Active", `Salesforce requires an Active Treatment Item before "${t.name}" can be Active.`));
      if (p.selection === "LegalEntity" && !t.legalEntityId) b.push(B("BillingTreatment", "LegalEntityId", null, "a Legal Entity", `Billing Policy "${p.name}" selects treatments by Legal Entity, so "${t.name}" needs one. Not invented — set it in Salesforce first.`));
      if (t.status === "Inactive") b.push(B("BillingTreatment", "Status", t.status, "Draft or Active", `"${t.name}" is Inactive.`));
    }
    stages.push(mk("activate-treatment", "BillingTreatment", "update", t.id, done, b, {
      fields: done ? [] : [{ field: "Status", from: t.status, to: "Active" }],
      lifecycle: [`Legal Entity ${p.selection === "LegalEntity" ? "required" : `not required (policy selection = ${p.selection ?? "—"})`}.`, "Once Active, its Treatment Item can no longer be edited and the treatment can't return to Draft."],
    }));
  }
  // 4. Default treatment (only after the treatment is Active; never overwrites another default).
  {
    const b: StagePlan["blockers"] = [];
    const done = same15(p.defaultTreatmentId, t.id);
    if (!done) {
      if (t.status !== "Active") b.push(B("BillingTreatment", "Status", t.status, "Active", `"${t.name}" must be Active before it becomes the policy default.`));
      if (p.defaultTreatmentId) b.push(B("BillingPolicy", "DefaultBillingTreatmentId", p.defaultTreatmentId, t.id, `"${p.name}" already defaults to another treatment — not overwritten.`));
      if (p.status === "Inactive") b.push(B("BillingPolicy", "Status", p.status, "Draft", `"${p.name}" is Inactive.`));
    }
    stages.push(mk("set-default", "BillingPolicy", "update", p.id, done, b, { lookups: [{ field: "DefaultBillingTreatmentId", sobject: "BillingTreatment", id: t.id, name: t.name }], fields: done ? [] : [{ field: "DefaultBillingTreatmentId", from: p.defaultTreatmentId, to: t.id }], lifecycle: [`Selection stays "${p.selection ?? "—"}".`] }));
  }
  // 5. Activate the policy (R5/R9: default set, Active, belongs to a policy).
  {
    const b: StagePlan["blockers"] = [];
    const done = p.status === "Active";
    if (!done) {
      if (p.status !== "Draft") b.push(B("BillingPolicy", "Status", p.status, "Draft", `"${p.name}" is ${p.status}.`));
      if (!p.defaultTreatmentId) b.push(B("BillingPolicy", "DefaultBillingTreatmentId", null, t.id, `Salesforce requires a Default Billing Treatment before "${p.name}" can be Active.`));
      else if (!same15(p.defaultTreatmentId, t.id)) b.push(B("BillingPolicy", "DefaultBillingTreatmentId", p.defaultTreatmentId, t.id, `The default treatment isn't "${t.name}".`));
      if (t.status !== "Active") b.push(B("BillingTreatment", "Status", t.status, "Active", `Salesforce requires the default treatment "${t.name}" to be Active.`));
      if (t.billable && !activeItem) b.push(B("BillingTreatmentItem", "Status", item?.status ?? null, "Active", `"${t.name}" has no Active Treatment Item.`));
      if (opts.productId && !s.products.some(x => same15(x.id, opts.productId))) b.push(B("Product2", "BillingPolicyId", null, p.id, "The product isn't associated with this Billing Policy."));
    }
    stages.push(mk("activate-policy", "BillingPolicy", "update", p.id, done, b, { fields: done ? [] : [{ field: "Status", from: p.status, to: "Active" }], lifecycle: [`Products on it: ${s.products.map(x => x.name).join(", ") || "none"}.`, "An Active policy can't return to Draft, and its treatment selection is locked."] }));
  }
  // Only the first unfinished stage is actionable.
  let seen = false;
  for (const st of stages) { if (st.state === "done") continue; if (seen) st.state = "waiting"; seen = true; }
  return stages;
}

/** The chain is READY only when every link is Active and connected — the policy status alone is never enough. */
export function chainComplete(s: ChainSnapshot): boolean {
  const { policy: p, treatment: t } = s;
  return !!p && !!t && p.status === "Active" && same15(p.defaultTreatmentId, t.id) && t.status === "Active" && same15(t.policyId, p.id) && (!t.billable || s.items.some(i => i.status === "Active"));
}

function postcondition(stage: ChainStage, s: ChainSnapshot): boolean {
  switch (stage) {
    case "create-item": return s.items.length === 1 && s.items.every(i => same15(i.treatmentId, s.treatment?.id));
    case "activate-item": return s.items.some(i => i.status === "Active");
    case "activate-treatment": return s.treatment?.status === "Active";
    case "set-default": return same15(s.policy?.defaultTreatmentId, s.treatment?.id);
    case "activate-policy": return s.policy?.status === "Active" && chainComplete(s);
  }
}

export interface ChainInput { policyId: string; treatmentId: string; productId?: string | null; confirm?: string | null }

export async function completePolicyChain(api: ChainApi, input: ChainInput): Promise<ChainResult> {
  const load = async () => {
    const [snapshot, ref, required] = await Promise.all([api.snapshot(input.policyId, input.treatmentId), api.referenceItem(), api.itemRequiredFields()]);
    return { snapshot, ref, stages: planChain(snapshot, ref, required, { productId: input.productId }) };
  };
  const writes: ChainResult["writes"] = [];
  const result = (st: Awaited<ReturnType<typeof load>>, performed: ChainResult["performed"]): ChainResult => {
    const next = st.stages.find(x => x.state !== "done") ?? null;
    const ready = !next && chainComplete(st.snapshot);
    const status: ChainStatus = performed && !performed.ok ? "STAGE_FAILED" : ready ? "BILLING_CONFIGURATION_READY" : next?.state === "ready" ? "AWAITING_CONFIRMATION" : "BILLING_CONFIGURATION_BLOCKED";
    const message = status === "BILLING_CONFIGURATION_READY" ? `Billing Policy "${st.snapshot.policy?.name}" is Active with an Active default treatment and an Active Treatment Item.`
      : status === "STAGE_FAILED" ? `${performed!.stage} failed: ${performed!.detail}`
      : status === "AWAITING_CONFIRMATION" ? `Next: ${next!.label} — confirm "${next!.stage}" to perform it. Nothing else is changed.`
      : `Blocked at "${next?.label ?? "chain"}": ${next?.blockers[0]?.message ?? "the chain is incomplete."}`;
    return { success: true, status, message, snapshot: st.snapshot, reference: st.ref.item, stages: st.stages, next, performed, writes };
  };

  const before = await load();
  if (!input.confirm) return result(before, null);
  const next = before.stages.find(x => x.state !== "done") ?? null;
  if (!next || next.state !== "ready" || next.stage !== input.confirm) {
    const r = result(before, null);
    return { ...r, message: `Nothing was changed: "${input.confirm}" isn't the next ready stage (${next ? `${next.stage}: ${next.state}` : "all stages done"}). ${r.message}` };
  }

  const s = before.snapshot, t = s.treatment!, p = s.policy!;
  const item = s.items.find(i => i.status === "Active") ?? s.items[0] ?? null;
  let w: WriteResult;
  switch (next.stage) {
    case "create-item": w = await api.createItem({ id: t.id, name: t.name }, proposedItemFields(t.name, before.ref.item!)); break;
    case "activate-item": w = await api.update("BillingTreatmentItem", item!.id, { fields: { Status: "Active" } }); break;
    case "activate-treatment": w = await api.update("BillingTreatment", t.id, { fields: { Status: "Active" } }); break;
    case "set-default": w = await api.update("BillingPolicy", p.id, { references: { DefaultBillingTreatmentId: { id: t.id, name: t.name, sobject: "BillingTreatment" } } }); break;
    case "activate-policy": w = await api.update("BillingPolicy", p.id, { fields: { Status: "Active" } }); break;
  }
  writes.push({ object: next.object, id: w.ok ? w.id : null });
  const after = await load();
  if (!w.ok) return result(after, { stage: next.stage, object: next.object, recordId: next.recordId, ok: false, verified: false, detail: w.error, salesforce: { status: w.status, code: w.code, error: w.error } });
  const verified = postcondition(next.stage, after.snapshot);
  return result(after, {
    stage: next.stage, object: next.object, recordId: w.id, ok: verified, verified,
    detail: verified ? `${LABEL[next.stage]} — verified in Salesforce after re-read.` : `Salesforce accepted the write but the re-read doesn't show the expected state for "${next.stage}".`,
  });
}

/* ───────────── Order billing prerequisite (read-only) ───────────── */

export interface OrderPrerequisite {
  orderId: string; orderNumber: string | null; status: string | null; activated: boolean;
  /** The product's policy → treatment → item chain passes for every order product. */
  chainPassed: boolean;
  /** Remaining non-billable app setup (e.g. stamping the default treatment on the order product) — performed by the run before activation. */
  pendingSetup: { itemId: string; product: string | null; actions: string[] }[];
  blockers: string[];
  eligibleForActivation: boolean;
}

/** Pure, read-only: does the order now pass the billing-policy/treatment prerequisite? */
export function orderBillingPrerequisite(o: OrderBillingState): OrderPrerequisite {
  const chainIssues = o.items.flatMap(i => i.issues.filter(x => x.severity === "error").map(x => x.message));
  const pendingSetup = o.items.filter(i => i.pendingActions.length).map(i => ({ itemId: i.id, product: i.product?.name ?? null, actions: [...i.pendingActions] }));
  const blockers = [...new Set([...chainIssues, ...o.readiness.blockers])];
  return {
    orderId: o.order.id, orderNumber: o.order.number, status: o.order.status, activated: o.order.activated,
    chainPassed: chainIssues.length === 0, pendingSetup, blockers,
    eligibleForActivation: !o.order.activated && blockers.length === 0,
  };
}

/**
 * Pure: the structural model among the working Advance/Remainder items (oldest first). Several candidates are only ambiguous
 * when their pattern fields DIFFER — identical patterns give the same item, so the oldest one is used as the model.
 */
export function pickReferenceItem<T extends { fields: Record<string, unknown> }>(rows: T[]): T | null {
  if (!rows.length) return null;
  const sig = (r: T) => JSON.stringify(ITEM_PATTERN_FIELDS.map(f => r.fields[f] ?? null));
  return rows.every(r => sig(r) === sig(rows[0])) ? rows[0] : null;
}

/* ───────────── Real Salesforce implementation ───────────── */

export function chainApiFor(client: SalesforceClient): ChainApi {
  const q = (s: string) => client.query<Record<string, unknown>>(s).then(r => r.records);
  const guard = (sobject: string) => { if (!CHAIN_WRITE_OBJECTS.has(sobject)) throw new Error(`Refusing to write ${sobject}: only billing configuration objects are allowed.`); };
  const MODULE = { BillingTreatmentItem: "billing-treatment-items", BillingTreatment: "billing-treatments", BillingPolicy: "billing-policies" } as const;
  const itemSelect = `Id, Name, Status, BillingTreatmentId, ${ITEM_PATTERN_FIELDS.join(", ")}`;
  const toItem = (r: Record<string, unknown>): ChainItem => ({ id: r.Id as string, name: String(r.Name), status: (r.Status as string) ?? null, treatmentId: r.BillingTreatmentId as string, fields: Object.fromEntries(ITEM_PATTERN_FIELDS.map(f => [f, r[f] ?? null])) });
  return {
    async snapshot(policyId, treatmentId) {
      const [p] = await q(`SELECT Id, Name, Status, BillingTreatmentSelection, DefaultBillingTreatmentId FROM BillingPolicy WHERE Id = '${soqlEscape(policyId)}' LIMIT 1`);
      const [t] = await q(`SELECT Id, Name, Status, BillingPolicyId, LegalEntityId, IsMilestoneBilling, ExcludeFromBilling FROM BillingTreatment WHERE Id = '${soqlEscape(treatmentId)}' LIMIT 1`);
      const items = t ? (await q(`SELECT ${itemSelect} FROM BillingTreatmentItem WHERE BillingTreatmentId = '${soqlEscape(treatmentId)}' ORDER BY ProcessingOrder, CreatedDate`)).map(toItem) : [];
      const products = p ? (await q(`SELECT Id, Name FROM Product2 WHERE BillingPolicyId = '${soqlEscape(policyId)}' ORDER BY Name LIMIT 200`)).map(r => ({ id: r.Id as string, name: String(r.Name) })) : [];
      return {
        policy: p ? { id: p.Id as string, name: String(p.Name), status: (p.Status as string) ?? null, selection: (p.BillingTreatmentSelection as string) ?? null, defaultTreatmentId: (p.DefaultBillingTreatmentId as string) ?? null } : null,
        treatment: t ? { id: t.Id as string, name: String(t.Name), status: (t.Status as string) ?? null, policyId: (t.BillingPolicyId as string) ?? null, legalEntityId: (t.LegalEntityId as string) ?? null, milestone: t.IsMilestoneBilling === true, billable: t.ExcludeFromBilling !== "Yes" } : null,
        items, products,
      };
    },
    async referenceItem() {
      const rows = await q(`SELECT ${itemSelect}, BillingTreatment.Name, BillingTreatment.BillingPolicy.Name FROM BillingTreatmentItem WHERE Status = 'Active' AND BillingType = 'Advance' AND Type = 'Remainder' AND BillingTreatment.Status = 'Active' AND BillingTreatment.IsMilestoneBilling = false ORDER BY CreatedDate LIMIT 10`);
      const candidates = rows.map(r => ({ id: r.Id as string, name: String(r.Name) }));
      const items = rows.map(r => { const bt = r.BillingTreatment as { Name?: string; BillingPolicy?: { Name?: string } | null } | null; return { ...toItem(r), treatmentName: bt?.Name ?? "—", policyName: bt?.BillingPolicy?.Name ?? null }; });
      return { item: pickReferenceItem(items), candidates };
    },
    async itemRequiredFields() {
      const d = await billingDescribe(client, "BillingTreatmentItem");
      return d.fields.filter(f => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== "boolean").map(f => f.name);
    },
    async createItem(treatment, fields) {
      guard("BillingTreatmentItem");
      const out = await createBillingRecords(client, { key: "chain-item", moduleKey: MODULE.BillingTreatmentItem, fields, children: [], references: { BillingTreatmentId: { id: treatment.id, name: treatment.name, sobject: "BillingTreatment", moduleKey: MODULE.BillingTreatment } } });
      return out.ok ? { ok: true, id: out.response.root.id } : { ok: false, status: out.status, code: out.code, error: out.error, technical: out.technical };
    },
    async update(sobject, id, change) {
      guard(sobject);
      const references = Object.fromEntries(Object.entries(change.references ?? {}).map(([k, v]) => [k, { ...v }]));
      const out = await updateBillingRecord(client, MODULE[sobject], id, { key: `chain-${sobject}`, moduleKey: MODULE[sobject], recordId: id, fields: change.fields ?? {}, references, children: [] });
      return out.ok ? { ok: true, id } : { ok: false, status: out.status, code: out.code, error: out.error, technical: out.technical };
    },
  };
}
