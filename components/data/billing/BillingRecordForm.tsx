"use client";

import { useEffect, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, Section, GhostButton } from "@/components/data/quotes/shared";
import ReferenceLookup from "@/components/data/shared/ReferenceLookup";
import BillingFieldInput, { BillingLookupInput, BILLING_SEARCH_ENDPOINT } from "@/components/data/billing/BillingFieldInput";
import { LoadingRow } from "@/components/data/billing/billingUi";
import { TaxInfoTip } from "@/components/data/taxes/NativeTaxGuidance";
import FieldHelp from "@/components/help/FieldHelp";
import { DISCLOSURE_LABELS } from "@/components/ui/Disclosure";
import { defaultsInfo, emptyDraft, fetchBillingSchema, fieldChanged, formFields, formatBillingValue, type BillingEditFormState } from "@/lib/billing/client";
import { billingFieldSection, getBillingModule } from "@/lib/billing/registry";
import type { BillingDraftLink, BillingDraftRecord, BillingFieldMeta, BillingModuleSchema, BillingValidationIssue } from "@/lib/billing/types";

const SECTION_META = {
  basic: { title: "Basic Information", icon: "info" },
  configuration: { title: "Billing Configuration", icon: "sliders" },
  relationships: { title: "Relationships", icon: "link" },
} as const;

/**
 * Add a new child record (e.g. a Billing Treatment under a new Billing Policy) named after the
 * lookup value that couldn't be found, and point the lookup at it. Nothing is created until the
 * user presses Create — the new child is shown in the form for review like any other record.
 */
export async function createLookupAsChild(draft: BillingDraftRecord, field: string, childModuleKey: string, name: string): Promise<BillingDraftRecord> {
  const childSchema = await fetchBillingSchema(childModuleKey);
  const child = emptyDraft(childSchema, draft);
  if (childSchema.nameField && childSchema.fields.some(f => f.name === childSchema.nameField && f.createable)) child.fields[childSchema.nameField] = name;
  const unresolved = { ...(draft.unresolved ?? {}) };
  delete unresolved[field];
  return {
    ...draft,
    unresolved,
    references: { ...draft.references, [field]: null },
    childReferences: { ...(draft.childReferences ?? {}), [field]: child.key },
    children: [...draft.children, child],
  };
}

function FieldRow({ isDark, field, schema, draft, onChange, fields, issue, edit }: {
  isDark: boolean; field: BillingFieldMeta; schema: BillingModuleSchema; draft: BillingDraftRecord; onChange: (d: BillingDraftRecord) => void; fields: BillingFieldMeta[]; issue?: BillingValidationIssue;
  edit?: BillingEditFormState;
}) {
  const lockReason = edit ? (edit.readOnly ?? edit.locks[field.name] ?? (!field.updateable ? `Salesforce doesn't allow changing ${field.label} after the record is created.` : null)) : null;
  const changed = edit ? fieldChanged(field, draft, edit.original) : false;
  const originalDisplay = edit ? (field.type === "reference" ? edit.original.references[field.name]?.name ?? "—" : formatBillingValue(edit.original.fields[field.name], field.type)) : null;
  const t = tokens(isDark);
  const [creating, setCreating] = useState(false);
  const wide = field.type === "textarea" || field.type === "multipicklist" || (field.type === "reference" && field.referenceTo.length > 1);
  const controller = field.controllerName ? fields.find(f => f.name === field.controllerName) : undefined;
  const controllingValue = field.controllerName ? draft.fields[field.controllerName] : undefined;
  const defaults = defaultsInfo(schema.moduleKey);
  const isRuleValue = field.name in defaults.values && draft.fields[field.name] === defaults.values[field.name];

  // A lookup that can be satisfied by creating the record inline as one of this record's children.
  const childForLookup = !edit && field.type === "reference" && !field.required && field.updateable ? schema.children.find(c => field.referenceTo.includes(c.sobject)) : undefined;
  const childRefKey = draft.childReferences?.[field.name];
  const childRef = childRefKey ? draft.children.find(c => c.key === childRefKey) : undefined;
  const unresolved = draft.unresolved?.[field.name];

  return (
    <div style={{ gridColumn: wide ? "1 / -1" : undefined, display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: t.dim, letterSpacing: 0.3, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
        {field.label}{field.required && <span style={{ color: t.error }} title="Required by Salesforce">*</span>}
        <FieldHelp isDark={isDark} label={field.label} apiName={field.name} sobject={schema.sobject} salesforceHelp={field.helpText} />
        {changed && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: t.warn, border: `1px solid ${t.warn}60`, borderRadius: 999, padding: "0 6px" }}>CHANGED</span>}
        {lockReason && <span title={lockReason} style={{ display: "inline-flex", color: t.dim }}><Ic n="lock" s={10} /></span>}
        <span style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 600, textTransform: "none", letterSpacing: 0, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace", opacity: 0.8 }}>{field.name}</span>
      </span>

      {lockReason ? (
        <div title={lockReason} style={{ padding: "9px 12px", borderRadius: 9, border: `1px dashed ${t.border}`, background: t.surfaceAlt, fontSize: 13, color: t.body, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: t.dim, display: "inline-flex" }}><Ic n="lock" s={12} /></span>
          <span style={{ fontWeight: 600, color: t.heading }}>{field.type === "reference" ? draft.references[field.name]?.name ?? "—" : formatBillingValue(draft.fields[field.name], field.type)}</span>
        </div>
      ) : field.type === "reference" && childRef ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", borderRadius: 9, border: `1px dashed ${t.accent}70`, background: `${t.accent}0c`, fontSize: 12.5 }}>
          <span style={{ color: t.accent, display: "inline-flex" }}><Ic n="plus" s={13} /></span>
          <span style={{ color: t.heading, fontWeight: 700 }}>New: {String((childRef.fields.Name as string) || getBillingModule(childRef.moduleKey)?.singular)}</span>
          <span style={{ color: t.dim, fontSize: 11.5 }}>created with this record (see {getBillingModule(childRef.moduleKey)?.label} below)</span>
          <button
            type="button"
            onClick={() => {
              const cr = { ...(draft.childReferences ?? {}) };
              delete cr[field.name];
              onChange({ ...draft, childReferences: cr, children: draft.children.filter(c => c.key !== childRefKey) });
            }}
            style={{ marginLeft: "auto", background: "transparent", border: "none", color: t.accent, cursor: "pointer", fontSize: 11.5, fontWeight: 700 }}
          >
            Use an existing record instead
          </button>
        </div>
      ) : field.type === "reference" ? (
        <>
          <BillingLookupInput
            isDark={isDark}
            field={field}
            value={draft.references[field.name] ?? null}
            unresolved={unresolved}
            onChange={v => {
              const next = { ...(draft.unresolved ?? {}) };
              if (v) delete next[field.name];
              onChange({ ...draft, references: { ...draft.references, [field.name]: v }, unresolved: next });
            }}
          />
          {unresolved && !draft.references[field.name] && childForLookup && unresolved.candidates.length <= 1 && (
            <div>
              <GhostButton
                label={creating ? "Adding…" : `Create "${unresolved.searchedName}" as a new ${childForLookup.singular} with this ${getBillingModule(schema.moduleKey)?.singular}`}
                icon="plus"
                isDark={isDark}
                disabled={creating}
                onClick={async () => {
                  setCreating(true);
                  try { onChange(await createLookupAsChild(draft, field.name, childForLookup.moduleKey, unresolved.searchedName)); } finally { setCreating(false); }
                }}
              />
            </div>
          )}
        </>
      ) : (
        <BillingFieldInput
          isDark={isDark}
          field={field}
          value={draft.fields[field.name]}
          controller={controller}
          controllingValue={controllingValue}
          error={issue?.severity === "error" ? issue.message : null}
          onChange={v => onChange({ ...draft, fields: { ...draft.fields, [field.name]: v } })}
        />
      )}
      {lockReason && <span style={{ fontSize: 10.5, color: t.dim }}>{lockReason}</span>}
      {changed && !lockReason && <span style={{ fontSize: 10.5, color: t.warn }}>Was: {originalDisplay}</span>}
      {issue && <span style={{ fontSize: 11, color: issue.severity === "error" ? t.error : t.warn }}>{issue.message}</span>}
      {/* Why Salesforce set this value — a configuration note, available on demand (hover/focus/tap) instead of a line under every field. */}
      {!issue && isRuleValue && defaults.reason && (
        <span style={{ display: "inline-flex" }}><TaxInfoTip isDark={isDark} label={`${DISCLOSURE_LABELS.config}: ${field.label}`}>Salesforce-required: {defaults.reason}</TaxInfoTip></span>
      )}
      {!issue && !isRuleValue && field.controllerName && controller && <span style={{ fontSize: 10.5, color: t.dim }}>Depends on {controller.label}</span>}
    </div>
  );
}

/**
 * The Salesforce-backed creation form, built entirely from the module's live Describe: every
 * createable, non-system field that exists in the org (and nothing else), grouped into Basic
 * Information / Billing Configuration / Relationships by the same classifier the detail view uses.
 * AI analysis fills THIS form's draft — there is no separate AI schema. Child modules (e.g.
 * Treatment Items) are edited inline, recursively up to two levels.
 */
export default function BillingRecordForm({ isDark, schema, draft, onChange, parentField, issues, path, depth = 0, edit }: {
  isDark: boolean;
  schema: BillingModuleSchema;
  draft: BillingDraftRecord;
  onChange: (d: BillingDraftRecord) => void;
  parentField?: string | null;
  issues: BillingValidationIssue[];
  path: string;
  depth?: number;
  /** Edit mode: an existing Salesforce record. Same schema, same form — plus locks and change markers; children are managed on their own records. */
  edit?: BillingEditFormState;
}) {
  const t = tokens(isDark);
  const fields = formFields(schema, parentField, edit ? "edit" : "create");
  const issueFor = (name: string) => issues.find(i => i.path === path && i.field === name);
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 } as const;
  // Required first within each section, then Describe order.
  const bySection = (id: keyof typeof SECTION_META) => fields
    .filter(f => billingFieldSection(f, schema) === id)
    .sort((a, b) => Number(b.required) - Number(a.required));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(Object.keys(SECTION_META) as (keyof typeof SECTION_META)[]).map(id => {
        const sectionFields = bySection(id);
        if (sectionFields.length === 0) return null;
        const req = sectionFields.filter(f => f.required).length;
        return (
          <Section key={id} title={`${SECTION_META[id].title}${req ? ` · ${req} required` : ""}`} icon={SECTION_META[id].icon} isDark={isDark}>
            <div style={grid}>
              {sectionFields.map(f => <FieldRow key={f.name} isDark={isDark} field={f} schema={schema} draft={draft} onChange={onChange} fields={fields} issue={issueFor(f.name)} edit={edit} />)}
            </div>
          </Section>
        );
      })}

      {!edit && depth < 2 && schema.children.map(child => (
        <ChildRecordsEditor
          key={child.moduleKey}
          isDark={isDark}
          child={child}
          parent={draft}
          parentLabel={getBillingModule(schema.moduleKey)?.singular ?? schema.label}
          onChange={onChange}
          issues={issues}
          path={path}
          depth={depth}
        />
      ))}
      {depth === 0 && schema.children.length === 0 && fields.length === 0 && (
        <div style={{ fontSize: 12, color: t.dim }}>This object has no fields your user can set.</div>
      )}
    </div>
  );
}

function ChildRecordsEditor({ isDark, child, parent, parentLabel, onChange, issues, path, depth }: {
  isDark: boolean;
  child: BillingModuleSchema["children"][number];
  parent: BillingDraftRecord;
  parentLabel: string;
  onChange: (d: BillingDraftRecord) => void;
  issues: BillingValidationIssue[];
  path: string;
  depth: number;
}) {
  const t = tokens(isDark);
  const [schema, setSchema] = useState<BillingModuleSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetchBillingSchema(child.moduleKey)
      .then(s => { if (!cancelled) setSchema(s); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load child object metadata"); });
    return () => { cancelled = true; };
  }, [child.moduleKey]);

  // Indices are positions in parent.children (what validation paths refer to); other child modules stay untouched.
  const indexed = parent.children.map((c, i) => ({ c, i })).filter(x => x.c.moduleKey === child.moduleKey);
  const rows = indexed.map(x => x.c);
  const replaceChild = (key: string, next: BillingDraftRecord | null) => {
    const children = next ? parent.children.map(c => (c.key === key ? next : c)) : parent.children.filter(c => c.key !== key);
    const childReferences = { ...(parent.childReferences ?? {}) };
    if (!next) for (const [f, k] of Object.entries(childReferences)) if (k === key) delete childReferences[f];
    onChange({ ...parent, children, childReferences });
  };

  const addRow = () => {
    if (!schema) return;
    const d = emptyDraft(schema, parent);
    // Processing-order style integer fields get the next sequence number — the org requires them and users expect 1, 2, 3.
    const seq = schema.fields.find(f => f.createable && f.type === "int" && /order|sequence/i.test(f.name));
    if (seq) d.fields[seq.name] = rows.length + 1;
    setOpen(o => ({ ...o, [d.key]: true }));
    onChange({ ...parent, children: [...parent.children, d] });
  };

  return (
    <Section title={`${child.label} (${rows.length})`} icon="list" isDark={isDark}>
      {error && <div style={{ fontSize: 12, color: t.error }}>{error}</div>}
      {!schema && !error && <LoadingRow isDark={isDark} label={`Loading ${child.singular} fields from Salesforce…`} />}
      {schema && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, color: t.dim }}>
            {rows.length === 0
              ? <>No {child.label.toLowerCase()} yet. They&apos;ll be created in the same request as the {parentLabel} and linked to it automatically.</>
              : <>Created together with the {parentLabel} and linked via {child.parentField} automatically.</>}
          </div>
          <GhostButton label={`Add ${child.singular}`} icon="plus" isDark={isDark} onClick={addRow} />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {schema && indexed.map(({ c, i }, rowIdx) => {
          const childPath = path ? `${path}.${i}` : String(i);
          const rowIssues = issues.filter(x => x.path === childPath || x.path.startsWith(`${childPath}.`));
          const hasError = rowIssues.some(x => x.severity === "error");
          const isOpen = open[c.key] ?? (rowIssues.length > 0 || rows.length === 1);
          const isReferenced = Object.values(parent.childReferences ?? {}).includes(c.key);
          const title = (schema.nameField && typeof c.fields[schema.nameField] === "string" && (c.fields[schema.nameField] as string)) || `${child.singular} ${rowIdx + 1}`;
          const summary = ["BillingType", "Type", "Percentage", "FlatAmount", "Rate", "LowerBound", "UpperBound", "AdjustmentValue"]
            .filter(n => c.fields[n] !== undefined && c.fields[n] !== null && c.fields[n] !== "")
            .map(n => `${schema.fields.find(f => f.name === n)?.label ?? n}: ${String(c.fields[n])}${n === "Percentage" ? "%" : ""}`)
            .join(" · ");
          return (
            <div key={c.key} style={{ borderRadius: 12, border: `1px solid ${hasError ? t.error + "70" : t.border}`, background: t.surfaceAlt }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer" }} onClick={() => setOpen(o => ({ ...o, [c.key]: !isOpen }))}>
                <span style={{ color: t.dim, display: "inline-flex" }}><Ic n={isOpen ? "chevron-down" : "chevron-right"} s={13} /></span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: t.heading }}>{title}</span>
                {isReferenced && <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, border: `1px solid ${t.accent}50`, borderRadius: 999, padding: "1px 7px" }}>NEW · LINKED ABOVE</span>}
                {summary && <span style={{ fontSize: 11, color: t.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>}
                {hasError && <span style={{ fontSize: 10.5, color: t.error, fontWeight: 700 }}>needs attention</span>}
                <span style={{ marginLeft: "auto" }} onClick={e => e.stopPropagation()}>
                  <GhostButton label="Remove" icon="trash" danger isDark={isDark} onClick={() => replaceChild(c.key, null)} />
                </span>
              </div>
              {isOpen && (
                <div style={{ padding: "0 12px 12px" }}>
                  <BillingRecordForm
                    isDark={isDark}
                    schema={schema}
                    draft={c}
                    parentField={child.parentField}
                    issues={issues}
                    path={childPath}
                    depth={depth + 1}
                    onChange={next => replaceChild(c.key, next)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function LinkCard({ isDark, link, schema, rootDraft, update }: {
  isDark: boolean; link: BillingDraftLink; schema: BillingModuleSchema; rootDraft: BillingDraftRecord; update: (key: string, patch: Partial<BillingDraftLink>) => void;
}) {
  const t = tokens(isDark);
  const noun = link.sobject === "Product2" ? "product" : link.sobject;

  // Edit ("set") mode: originalTargets = what points at this record in Salesforce now; targets = desired set.
  if (link.originalTargets) {
    const orig = link.originalTargets;
    const inTargets = (id: string) => link.targets.some(x => x.id.slice(0, 15) === id.slice(0, 15));
    const inOrig = (id: string) => orig.some(x => x.id.slice(0, 15) === id.slice(0, 15));
    const rows = [...orig, ...link.targets.filter(x => !inOrig(x.id))];
    const Noun = link.sobject === "Product2" ? "Product" : link.sobject;
    const recordName = String(rootDraft.fields.Name ?? `this ${getBillingModule(schema.moduleKey)?.singular ?? "record"}`);
    return (
      <div style={{ borderRadius: 10, border: `1px solid ${t.border}`, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: t.heading }}>
          {link.label}
          <span style={{ fontSize: 10.5, fontWeight: 600, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{link.sobject}.{link.field}</span>
        </div>
        {rows.length === 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: t.warn, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic n="alert" s={12} /> {Noun} is not currently linked to this {getBillingModule(schema.moduleKey)?.singular ?? "record"}.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "10px 0" }}>
          {rows.map(r => {
            const state = inOrig(r.id) ? (inTargets(r.id) ? "linked" : "unlink") : "link";
            const color = state === "linked" ? "#00C875" : state === "unlink" ? t.error : t.accent;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 9, border: `1px solid ${color}45`, background: `${color}0c`, fontSize: 12.5 }}>
                <span style={{ color, display: "inline-flex" }}><Ic n={state === "linked" ? "check-circle" : state === "unlink" ? "x" : "plus"} s={13} /></span>
                <span style={{ color: t.heading, fontWeight: 700, textDecoration: state === "unlink" ? "line-through" : undefined }}>{Noun}: {r.name}</span>
                <span style={{ color: t.dim }}>→ {getBillingModule(schema.moduleKey)?.singular ?? "Record"}: {recordName}</span>
                <span style={{ color, fontWeight: 700, fontSize: 11 }}>{state === "linked" ? "✓ Linked" : state === "unlink" ? "Will be unlinked on save" : "Will be linked on save"}</span>
                <span style={{ marginLeft: "auto" }}>
                  {state === "unlink"
                    ? <GhostButton label="Undo" isDark={isDark} onClick={() => update(link.key, { targets: [...link.targets, r] })} />
                    : <GhostButton label={state === "linked" ? "Unlink" : "Remove"} icon="x" isDark={isDark} onClick={() => update(link.key, { targets: link.targets.filter(x => x.id !== r.id) })} />}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Link {Noun}</div>
          <ReferenceLookup
            isDark={isDark}
            objectType={link.sobject}
            searchEndpoint={BILLING_SEARCH_ENDPOINT}
            value={null}
            onChange={v => { if (v && !inTargets(v.id)) update(link.key, { targets: [...link.targets, { id: v.id, name: v.name, sobject: link.sobject }] }); }}
            placeholder={`Search ${link.sobject === "Product2" ? "Products" : link.sobject}…`}
          />
        </div>
      </div>
    );
  }

  const sourceField = typeof link.valueSource === "object" ? schema.fields.find(f => f.name === (link.valueSource as { field: string }).field) : null;
  const sourceValue = sourceField ? rootDraft.references[sourceField.name] : null;
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${link.enabled ? t.accent + "55" : t.border}`, padding: 12, background: link.enabled ? `${t.accent}0a` : "transparent" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: t.heading, cursor: "pointer" }}>
        <input type="checkbox" checked={link.enabled} onChange={e => update(link.key, { enabled: e.target.checked })} style={{ accentColor: t.accent }} />
        {link.label}
        <span style={{ fontSize: 10.5, fontWeight: 600, color: t.dim, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{link.sobject}.{link.field}</span>
      </label>
      <div style={{ fontSize: 11.5, color: t.dim, margin: "4px 0 8px 24px" }}>
        {link.valueSource === "self"
          ? `Sets ${link.field} on the selected ${noun} records to the new record, in the same transaction.`
          : sourceField
            ? `Sets ${link.field} on the selected ${noun} records to this record's ${sourceField.label}${sourceValue ? ` (${sourceValue.name})` : " — select it above first"}.`
            : null}
      </div>
      {link.targets.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginLeft: 24, marginBottom: 8 }}>
          {link.targets.map(tg => (
            <span key={tg.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, padding: "3px 6px 3px 10px", borderRadius: 999, border: `1px solid ${t.accent}50`, color: t.accent, background: `${t.accent}12`, opacity: link.enabled ? 1 : 0.6 }}>
              <Ic n="check-circle" s={11} /> {tg.name}
              <button onClick={() => update(link.key, { targets: link.targets.filter(x => x.id !== tg.id) })} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.accent, display: "inline-flex" }} title="Remove"><Ic n="x" s={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div style={{ marginLeft: 24, maxWidth: 420 }}>
        <ReferenceLookup
          isDark={isDark}
          objectType={link.sobject}
          searchEndpoint={BILLING_SEARCH_ENDPOINT}
          value={null}
          onChange={v => { if (v && !link.targets.some(x => x.id === v.id)) update(link.key, { targets: [...link.targets, { id: v.id, name: v.name, sobject: link.sobject }], enabled: true }); }}
          placeholder={`Search ${link.sobject === "Product2" ? "Products" : link.sobject}…`}
        />
      </div>
    </div>
  );
}

/**
 * Opt-in updates to EXISTING records, each explicitly enabled and target-picked by the user.
 * Product links get their own "Product Association" section: in Revenue Cloud Billing a product
 * reaches billing through Product2.BillingPolicyId, so that's the relationship offered here.
 */
export function BillingLinksEditor({ isDark, links, onChange, rootDraft, schema }: {
  isDark: boolean; links: BillingDraftLink[]; onChange: (l: BillingDraftLink[]) => void; rootDraft: BillingDraftRecord; schema: BillingModuleSchema;
}) {
  if (links.length === 0) return null;
  const update = (key: string, patch: Partial<BillingDraftLink>) => onChange(links.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const product = links.filter(l => l.sobject === "Product2");
  const other = links.filter(l => l.sobject !== "Product2");

  return (
    <>
      {product.length > 0 && (
        <Section title="Product Association" icon="package" isDark={isDark}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {product.map(l => <LinkCard key={l.key} isDark={isDark} link={l} schema={schema} rootDraft={rootDraft} update={update} />)}
          </div>
        </Section>
      )}
      {other.length > 0 && (
        <Section title="Link to existing records (optional)" icon="link" isDark={isDark} defaultOpen={other.some(l => l.enabled || l.targets.length > 0)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {other.map(l => <LinkCard key={l.key} isDark={isDark} link={l} schema={schema} rootDraft={rootDraft} update={update} />)}
          </div>
        </Section>
      )}
    </>
  );
}
