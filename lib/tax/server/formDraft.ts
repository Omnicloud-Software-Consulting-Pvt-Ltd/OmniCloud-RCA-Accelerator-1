import { objectMeta } from "@/lib/tax/server/metadata";
import { coerceValue, foldCreateReferences, mapFieldKeys, resolveLookupValue, type TaxOrgApi } from "@/lib/tax/server/operations";
import { ITEMS_NOT_ENABLED_MESSAGE } from "@/lib/billing/server/rules";
import type { TaxFormDraft } from "@/lib/taxes/formDraft";
import type { AssistantOperation, RecordSelector, TaxMetadata } from "@/lib/tax/types";

/**
 * AI create operation (+ the prompt's own "Field: value" lines) → the values of ONE record for the create form of `object`.
 * Fields come only from the org's describe: unknown and non-createable keys are reported, never sent. Every value the user gave
 * is kept even when a lookup fails; each lookup is resolved on its own (Id, else exact name) and is never auto-selected — several
 * matches or none leave it for the user. Nothing is written.
 */

// "- TaxCode: AU_GST_10", "Name = X", "1. Tax Treatment: Y" — one field per line.
const LINE = /^\s*(?:[-*•]|\d+[.)])?\s*([A-Za-z][A-Za-z0-9 _./]{0,60}?)\s*[:=]\s*(.+?)\s*$/;
// "ProductCode: Leave blank unless required or explicitly provided." → the user wants it empty.
const BLANK = /^(?:leave(?:\s+it)?\s+(?:blank|empty)|blank|empty|none|null|n\/?a|-+|not\s+(?:provided|applicable|required)|omit(?:ted)?)\b/i;
const unquote = (s: string) => s.replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();

/** Values the prompt states explicitly as "Field: value" lines, keyed by field API name (matched by API name or label). */
export function explicitPromptFields(meta: TaxMetadata, object: string, prompt: string): { values: Record<string, string>; blank: Set<string> } {
  const values: Record<string, string> = {};
  const blank = new Set<string>();
  const o = objectMeta(meta, object);
  if (!o) return { values, blank };
  for (const line of prompt.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const name = Object.keys(mapFieldKeys(meta, object, { [m[1].trim()]: true }).mapped)[0];
    if (!name) continue;
    const raw = unquote(m[2]);
    if (!raw) continue;
    if (BLANK.test(raw)) { blank.add(name); delete values[name]; continue; }
    // A sentence-ending period belongs to long text (Description), not to a name or code.
    values[name] = o.fields[name].type === "textarea" ? raw : raw.replace(/\.$/, "").trim();
  }
  return { values, blank };
}

const selectorText = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  const s = (v ?? {}) as RecordSelector;
  return (s.name ?? s.treatmentName ?? s.productName ?? s.policyName ?? s.taxCode ?? "").trim();
};

export async function buildFormDraft(api: TaxOrgApi, object: string, op: AssistantOperation | null, prompt: string): Promise<TaxFormDraft> {
  const meta = api.meta;
  const draft: TaxFormDraft = { object, fields: {}, references: {}, unresolved: {}, prerequisites: [], notices: [] };
  const o = objectMeta(meta, object);
  if (!o) { draft.notices.push(`${object} isn't available in this org.`); return draft; }

  const { mapped, unknown } = mapFieldKeys(meta, object, op ? foldCreateReferences(meta, { ...op, object }) : {});
  for (const k of unknown) draft.notices.push(`Ignored "${k}" — ${o.label} has no such field in this org.`);
  const explicit = explicitPromptFields(meta, object, prompt);
  const values: Record<string, unknown> = { ...mapped, ...explicit.values }; // the user's own words win over the AI's reading
  for (const k of explicit.blank) delete values[k];

  const promptText = prompt.toLowerCase();
  for (const [name, v] of Object.entries(values)) {
    const f = o.fields[name];
    if (!f || f.type === "id") continue;
    const empty = v === null || v === undefined || v === "";
    if (!f.createable) { if (!empty) draft.notices.push(`Ignored ${f.label} — it can't be set when creating a ${o.label}.`); continue; }
    if (empty) continue;

    if (f.type === "reference") {
      const target = f.referenceTo.find(t => objectMeta(meta, t)) ?? f.referenceTo[0];
      const searched = selectorText(v);
      if (!target || !searched) continue;
      // Only a record the user actually named is looked up — a name the AI supplied on its own is never selected.
      if (!promptText.includes(searched.toLowerCase())) { draft.notices.push(`Ignored ${f.label} "${searched}" — it isn't named in your request.`); continue; }
      const r = await resolveLookupValue(api, target, v);
      if (r.status === "found") {
        draft.references[name] = { id: r.id, name: r.name, sobject: target };
        if (object === "TaxTreatmentItem" && target === "TaxTreatment" && objectMeta(meta, "TaxTreatment")?.fields.ShouldUseTaxTreatmentItems) {
          const ok = r.row.ShouldUseTaxTreatmentItems === true;
          draft.prerequisites.push({ field: name, recordId: r.id, ok, message: ok ? null : ITEMS_NOT_ENABLED_MESSAGE });
        }
      } else if (r.status === "multiple") {
        draft.unresolved[name] = { searchedName: searched, sobject: target, candidates: r.options.map(x => ({ id: x.id, name: x.name, sobject: target })) };
      } else {
        draft.unresolved[name] = { searchedName: searched, sobject: target, candidates: [] };
        if (r.options.length) draft.notices.push(`${f.label} "${searched}" was not found. Similar records: ${r.options.map(x => x.name).join(", ")}.`);
      }
      continue;
    }

    const c = coerceValue(f, v);
    if (!c.ok) { draft.notices.push(`${f.label}: ${c.message} — left empty.`); continue; }
    if (c.value !== null) draft.fields[name] = c.value;
  }
  return draft;
}
