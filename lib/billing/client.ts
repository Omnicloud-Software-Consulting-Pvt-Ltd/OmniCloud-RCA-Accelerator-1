"use client";

import { quoteApiGet, toErrorPanelData, type ErrorPanelDataLike } from "@/lib/quotes/client/apiClient";
import { applicableDefaults, getBillingModule, type AppModuleLink } from "@/lib/billing/registry";
import type { BillingDraftLink, BillingDraftRecord, BillingFieldMeta, BillingModuleSchema, BillingReferenceValue } from "@/lib/billing/types";

/**
 * Error-panel data for billing calls. The billing API already returns a
 * translated `error` + `possibleCause` (lib/billing/server/errors.ts) — prefer
 * that over the generic code-based cause, and keep the raw Salesforce errors
 * in `raw` for the panel's "Expand Details" technical view.
 */
export function toBillingErrorPanel(err: unknown, title: string): ErrorPanelDataLike {
  const base = toErrorPanelData(err, title);
  const raw = base.raw as { possibleCause?: string | null } | null | undefined;
  return raw?.possibleCause ? { ...base, possibleCause: raw.possibleCause } : base;
}

/* ── Schema cache: one fetch per module per page session (child forms reuse the parent's fetch). ── */
const schemaPromises = new Map<string, Promise<BillingModuleSchema>>();

export function fetchBillingSchema(moduleKey: string, opts: { fresh?: boolean } = {}): Promise<BillingModuleSchema> {
  if (opts.fresh) schemaPromises.delete(moduleKey);
  let p = schemaPromises.get(moduleKey);
  if (!p) {
    p = quoteApiGet<{ schema: BillingModuleSchema }>(`Describe ${moduleKey}`, `/api/billing/${moduleKey}/schema`).then(r => r.schema);
    p.catch(() => schemaPromises.delete(moduleKey));
    schemaPromises.set(moduleKey, p);
  }
  return p;
}

export function clearBillingSchemaCache() {
  schemaPromises.clear();
}

let keySeq = 0;
export const newDraftKey = () => `d${Date.now().toString(36)}${(keySeq++).toString(36)}`;

/** A blank draft pre-filled only with the org's OWN picklist defaults (Describe `defaultValue`) — never app-invented values. */
export function emptyDraft(schema: BillingModuleSchema, parent?: BillingDraftRecord | null): BillingDraftRecord {
  const fields: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (!f.createable || f.system) continue;
    if ((f.type === "picklist") && f.picklistValues.some(p => p.isDefault)) fields[f.name] = f.picklistValues.find(p => p.isDefault)!.value;
  }
  // Platform-enforced values Describe can't express (see BillingModuleDef.defaults) — only where valid
  // in this org, and only when the rule holds for the parent (e.g. items of a NON-milestone treatment).
  const cond = getBillingModule(schema.moduleKey)?.defaultsCondition;
  const parentFlag = cond && parent?.moduleKey === cond.parentModule ? parent.fields[cond.parentFlag] === true : null;
  Object.assign(fields, applicableDefaults(schema.moduleKey, schema.fields, parentFlag));
  return { key: newDraftKey(), moduleKey: schema.moduleKey, fields, references: {}, children: [] };
}

/**
 * A new draft seeded with values handed to the create form (e.g. "Use This Rate"): only fields this org's Describe marks
 * createable (and not system) are applied — anything else is dropped, never guessed. With no values, the draft is unchanged.
 */
export function seedDraftFields(draft: BillingDraftRecord, schema: BillingModuleSchema, values: Record<string, unknown> | undefined): BillingDraftRecord {
  if (!values) return draft;
  const createable = new Set(schema.fields.filter(f => f.createable && !f.system).map(f => f.name));
  const seeded = Object.fromEntries(Object.entries(values).filter(([k, v]) => createable.has(k) && v !== undefined && v !== null && v !== ""));
  return { ...draft, fields: { ...draft.fields, ...seeded } };
}

/** Fields pre-filled from Salesforce-required rules for this module (so the form can explain them). */
export function defaultsInfo(moduleKey: string): { values: Record<string, unknown>; reason: string | null } {
  const def = getBillingModule(moduleKey);
  return { values: def?.defaults ?? {}, reason: def?.defaultsReason ?? null };
}

/**
 * Identity of "what would be sent to Salesforce" — the draft plus ENABLED links, without UI-only keys.
 * Create is only allowed when this equals the fingerprint of the draft that last passed validation.
 */
export function draftFingerprint(draft: BillingDraftRecord | null, links: BillingDraftLink[]): string {
  const strip = (d: BillingDraftRecord): unknown => ({ m: d.moduleKey, f: d.fields, r: d.references, u: d.unresolved ?? null, c: d.childReferences ?? null, ch: d.children.map(strip) });
  return JSON.stringify({ d: draft ? strip(draft) : null, l: links.filter(l => l.enabled).map(l => ({ s: l.sobject, f: l.field, t: l.targets.map(t => t.id) })) });
}

/** Fields shown in a create form — createable, non-system, never the auto-filled parent reference. */
export function formFields(schema: BillingModuleSchema, parentField?: string | null, mode: "create" | "edit" = "create"): BillingFieldMeta[] {
  // Edit shows the same fields plus anything updateable-only; non-updateable ones render read-only.
  return schema.fields.filter(f => (mode === "edit" ? (f.createable || f.updateable) && !f.calculated : f.createable) && !f.system && f.name !== parentField && f.type !== "base64");
}

/** Edit mode: the record as loaded from Salesforce, and what can't be changed (with Salesforce's reason). */
export interface BillingEditFormState {
  original: BillingDraftRecord;
  locks: Record<string, string>;
  /** Whole-record lock (e.g. item under a non-Draft treatment). */
  readOnly: string | null;
}

/** Has this field changed from the value loaded from Salesforce? */
export function fieldChanged(field: BillingFieldMeta, draft: BillingDraftRecord, original: BillingDraftRecord): boolean {
  if (field.type === "reference") return (draft.references[field.name]?.id ?? null)?.slice(0, 15) !== (original.references[field.name]?.id ?? null)?.slice(0, 15);
  const a = draft.fields[field.name], b = original.fields[field.name];
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(a) && empty(b)) return false;
  if (["int", "long", "double", "currency", "percent"].includes(field.type)) return Number(a) !== Number(b);
  if (field.type === "datetime") return new Date(String(a)).getTime() !== new Date(String(b)).getTime();
  return String(a) !== String(b);
}

export function formatBillingValue(value: unknown, type: string): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (type) {
    case "boolean": return value ? "Yes" : "No";
    case "date": {
      const d = new Date(`${String(value)}T00:00:00`);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
    }
    case "datetime": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    }
    case "currency": {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
    }
    case "percent": return `${value}%`;
    case "multipicklist": return String(value).split(";").join(", ");
    default: return String(value);
  }
}

/** Existing app modules a referenced object belongs to — so a billing record's Order/Product/Contract links open those modules instead of a duplicate. */
export function appModuleForSobject(sobject: string): AppModuleLink | null {
  switch (sobject) {
    case "Product2": return "products";
    case "Order": return "orders";
    case "Contract": return "contracts";
    case "Quote": return "quotes";
    default: return null;
  }
}

export interface BillingNavTarget {
  /** Open a Product's Revenue Cloud Billing view (Product → Billing Policy chain). */
  product?: { id: string };
  /** Open the Assign Billing Policy to Product workflow, optionally preselected. */
  assign?: { productId?: string | null; policyId?: string | null };
  /** Open the Revenue Cloud Billing — Order Setup workspace for an Order. */
  order?: { id: string };
  /** Debit Memos: dashboard (prompt + create) or one Debit Memo's details. */
  debitMemo?: { mode: "dashboard" } | { mode: "detail"; id: string };
  /** Tax: dashboard / create / verification / readiness, or one end-to-end verification run (by Order). */
  tax?: { mode: "dashboard"; tab?: "dashboard" | "create" | "verification" | "readiness" } | { mode: "run"; orderId: string };
  /** Credit Memos: dashboard, Create Credit Memo (optionally for an invoice) or one Credit Memo's details. */
  creditMemo?: { mode: "dashboard" } | { mode: "create"; invoiceId?: string | null } | { mode: "detail"; id: string };
  /** Payments: dashboard, Record Payment (optionally for an invoice) or one Payment's details. */
  payment?: { mode: "dashboard" } | { mode: "record"; invoiceId?: string | null } | { mode: "settle"; invoiceId?: string | null; paymentId?: string | null } | { mode: "detail"; id: string };
  /** Navigate within the billing workspace. */
  billing?: { moduleKey: string; view: "module" | "history" | "create" | "detail" | "edit" | "bulk-assignment" | "rate-library"; id?: string };
  /** Open an existing app module (optionally a specific record). */
  app?: { module: AppModuleLink; recordId?: string };
}

export function navTargetForReference(ref: BillingReferenceValue): BillingNavTarget | null {
  if (ref.moduleKey) return { billing: { moduleKey: ref.moduleKey, view: "detail", id: ref.id } };
  if (ref.sobject === "Product2") return { product: { id: ref.id } };
  const app = appModuleForSobject(ref.sobject);
  return app ? { app: { module: app, recordId: ref.id } } : null;
}

/** Status → accent color, shared by pills/badges. */
export function statusColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (/^(active|posted|processed|completely ?billed|readyforinvoicing|ready for invoicing|invoiced|settled)/.test(s)) return "#00C875";
  if (/^(draft|pending|processing|waiting)/.test(s)) return "#F59E0B";
  if (/^(inactive|cancel|void|error|failed)/.test(s)) return "#FF4066";
  return "#3AABFF";
}

