import type { BillingDraftRecord, BillingModuleSchema, BillingReferenceValue } from "@/lib/billing/types";

/**
 * AI prompt → the Taxes create FORM (Tax Treatment Item page). The server (lib/tax/server/formDraft.ts) extracts the values and
 * resolves each lookup against Salesforce; this module turns that into the draft the Salesforce-backed form edits and decides,
 * client-side, what still blocks "Create in Salesforce". The server-side validation (lib/billing/server/rules.ts) enforces the same
 * rules on every Validate and on create, so the two can't disagree.
 */

/** A parent prerequisite of a resolved lookup (Tax Treatment Item: the treatment must have "Use Tax Treatment Items"). */
export interface TaxFormPrerequisite { field: string; recordId: string; ok: boolean; message: string | null }

export interface TaxFormDraft {
  object: string;
  /** Writable, non-lookup field values (API name → value), already coerced to the field type. */
  fields: Record<string, unknown>;
  /** Lookups resolved to exactly one Salesforce record (name shown, Id sent). */
  references: Record<string, BillingReferenceValue>;
  /** Lookups the user named that did not resolve to exactly one record — the user picks or corrects them; never auto-selected. */
  unresolved: Record<string, { searchedName: string; sobject: string; candidates: BillingReferenceValue[] }>;
  prerequisites: TaxFormPrerequisite[];
  /** Fields or requests that were not applied to the form (unknown/read-only fields, other operations). */
  notices: string[];
}

/**
 * The form draft for a fresh analysis: built on `base` (a blank draft for the schema), never on the previous draft, so nothing
 * from an earlier configuration survives. Lookups pre-selected by the page (e.g. opened from a treatment) apply unless the
 * prompt named that lookup — a named-but-unresolved lookup stays empty for the user to choose.
 */
export function draftFromTaxForm(base: BillingDraftRecord, form: TaxFormDraft, initialReferences?: Record<string, BillingReferenceValue>): BillingDraftRecord {
  const references: Record<string, BillingReferenceValue | null> = { ...(initialReferences ?? {}) };
  for (const k of Object.keys(form.unresolved)) delete references[k];
  Object.assign(references, form.references);
  return { ...base, fields: { ...base.fields, ...form.fields }, references, unresolved: { ...form.unresolved }, children: [] };
}

/**
 * Why "Create in Salesforce" must stay disabled for this draft, whatever the last validation said: a failed parent prerequisite
 * for the CURRENTLY selected record, a required lookup with no record (e.g. ProductId), or a named lookup still unresolved.
 */
export function formCreateBlockers(schema: BillingModuleSchema, draft: BillingDraftRecord, prerequisites: TaxFormPrerequisite[]): string[] {
  const out: string[] = [];
  for (const p of prerequisites) if (!p.ok && draft.references[p.field]?.id === p.recordId) out.push(p.message ?? "The selected parent record doesn't allow this record.");
  for (const f of schema.fields) {
    if (f.type !== "reference" || !f.createable || draft.references[f.name] || draft.childReferences?.[f.name]) continue;
    const u = draft.unresolved?.[f.name];
    if (u) out.push(u.candidates.length > 1 ? `${f.label} "${u.searchedName}" matches ${u.candidates.length} records — choose one.` : `${f.label} "${u.searchedName}" was not found in Salesforce — select an existing record.`);
    else if (f.required && !f.system) out.push(`${f.label} is required by Salesforce — select an existing record.`);
  }
  return out;
}
