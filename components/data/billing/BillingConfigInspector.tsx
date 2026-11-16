"use client";

import { useMemo, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, PageShell, ErrorPanel, CodeBlock } from "@/components/data/quotes/shared";
import { Panel, LoadingRow, useBillingData, ToolbarButton } from "@/components/data/billing/billingUi";
import { clearBillingSchemaCache } from "@/lib/billing/client";
import { BILLING_GROUPS, getBillingModule } from "@/lib/billing/registry";
import type { BillingModuleSchema } from "@/lib/billing/types";
import type { BillingMetadataResponse } from "@/app/api/billing/metadata/route";

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function Flag({ on, label, isDark }: { on: boolean; label: string; isDark: boolean }) {
  const t = tokens(isDark);
  return <span title={label} style={{ fontSize: 10, fontWeight: 800, padding: "1px 5px", borderRadius: 5, color: on ? "#00C875" : t.dim, background: on ? "rgba(0,200,117,0.12)" : "transparent", border: `1px solid ${on ? "rgba(0,200,117,0.35)" : t.border}`, opacity: on ? 1 : 0.55 }}>{label[0]}</span>;
}

/** Per-module view: everything the app discovered about this object in the connected org — the UI and API are built from exactly this. */
export function BillingModuleInspector({ isDark, moduleKey }: { isDark: boolean; moduleKey: string }) {
  const t = tokens(isDark);
  const def = getBillingModule(moduleKey)!;
  const { data, error, loading, reload } = useBillingData<{ schema: BillingModuleSchema }>(`Describe ${def.singular}`, `/api/billing/${moduleKey}/schema`);
  const [filter, setFilter] = useState("");
  const [onlyCreateable, setOnlyCreateable] = useState(false);
  const schema = data?.schema;
  const fields = useMemo(() => (schema?.fields ?? []).filter(f =>
    (!onlyCreateable || f.createable) && (!filter || `${f.name} ${f.label} ${f.type}`.toLowerCase().includes(filter.toLowerCase())),
  ), [schema, filter, onlyCreateable]);

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>Salesforce Configuration — {def.singular}</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>Live Describe of the connected org. Forms, validation, lookups and AI prompts for this module are generated from this metadata.</div>
          </div>
          <ToolbarButton isDark={isDark} label="Re-describe" icon="refresh" disabled={loading} onClick={() => { clearBillingSchemaCache(); reload(); }} />
        </div>
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {!schema && !error && <LoadingRow isDark={isDark} label="Describing object…" />}
        {schema && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <Panel isDark={isDark} title="Object" icon="database">
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", fontSize: 12 }}>
                  <span style={{ color: t.dim }}>API name</span><code style={{ fontFamily: mono, color: t.heading }}>{schema.sobject}</code>
                  <span style={{ color: t.dim }}>Label</span><span style={{ color: t.body }}>{schema.label} / {schema.labelPlural}</span>
                  <span style={{ color: t.dim }}>API version</span><span style={{ color: t.body }}>{schema.apiVersion}</span>
                  <span style={{ color: t.dim }}>Access</span>
                  <span style={{ display: "flex", gap: 4 }}><Flag on={schema.createable} label="Createable" isDark={isDark} /><Flag on={schema.queryable} label="Queryable" isDark={isDark} /><Flag on={schema.updateable} label="Updateable" isDark={isDark} /></span>
                  <span style={{ color: t.dim }}>Name field</span><code style={{ fontFamily: mono, color: t.body }}>{schema.nameField ?? "—"}</code>
                  <span style={{ color: t.dim }}>Status field</span><code style={{ fontFamily: mono, color: t.body }}>{schema.statusField ?? "—"}</code>
                  <span style={{ color: t.dim }}>Candidates</span><span style={{ color: t.body }}>{def.candidates.join(", ")}</span>
                </div>
              </Panel>
              <Panel isDark={isDark} title="Relationships" icon="git-branch">
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: t.body }}>
                  <div><strong style={{ color: t.heading }}>Inline children:</strong> {schema.children.map(c => `${c.sobject}.${c.parentField}`).join(", ") || "none"}</div>
                  <div><strong style={{ color: t.heading }}>Optional links:</strong> {schema.inboundLinks.map(l => `${l.sobject}.${l.field}`).join(", ") || "none"}</div>
                  <div><strong style={{ color: t.heading }}>Referenced by:</strong> {schema.childRelationships.map(c => `${c.childSObject}.${c.field}`).join(", ") || "none"}</div>
                  <div><strong style={{ color: t.heading }}>Looks up:</strong> {[...new Set(schema.fields.filter(f => f.type === "reference" && !f.system).flatMap(f => f.referenceTo))].join(", ") || "none"}</div>
                </div>
              </Panel>
            </div>

            <Panel isDark={isDark} title={`Fields (${fields.length} of ${schema.fields.length})`} icon="table" padding={0}
              right={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: t.body, cursor: "pointer" }}>
                    <input type="checkbox" checked={onlyCreateable} onChange={e => setOnlyCreateable(e.target.checked)} style={{ accentColor: t.accent }} /> Createable only
                  </label>
                  <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter fields…" style={{ ...inputStyle(t), width: 180, padding: "5px 9px", fontSize: 12 }} />
                </div>
              }>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>{["API Name", "Label", "Type", "Req", "C / U", "Picklist / Reference", "Relationship"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 10px", fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {fields.map(f => (
                      <tr key={f.name} style={{ borderBottom: `1px solid ${t.border}` }}>
                        <td style={{ padding: "7px 10px", fontFamily: mono, color: t.heading, whiteSpace: "nowrap" }}>{f.name}</td>
                        <td style={{ padding: "7px 10px", color: t.body }}>{f.label}</td>
                        <td style={{ padding: "7px 10px", color: t.body, whiteSpace: "nowrap" }}>{f.type}{f.length && (f.type === "string" || f.type === "textarea") ? `(${f.length})` : ""}{f.calculated ? " · formula" : ""}</td>
                        <td style={{ padding: "7px 10px", color: f.required ? t.error : t.dim, fontWeight: 700 }}>{f.required ? "Yes" : ""}</td>
                        <td style={{ padding: "7px 10px" }}><span style={{ display: "flex", gap: 3 }}><Flag on={f.createable} label="Createable" isDark={isDark} /><Flag on={f.updateable} label="Updateable" isDark={isDark} /></span></td>
                        <td style={{ padding: "7px 10px", color: t.body, maxWidth: 340 }}>
                          {f.type === "reference" ? `→ ${f.referenceTo.join(" / ")}` : f.picklistValues.length ? f.picklistValues.map(p => p.value).join(", ") : ""}
                          {f.controllerName && <div style={{ fontSize: 10.5, color: t.dim }}>controlled by {f.controllerName}</div>}
                        </td>
                        <td style={{ padding: "7px 10px", fontFamily: mono, color: t.dim, whiteSpace: "nowrap" }}>{f.relationshipName ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <CodeBlock isDark={isDark} data={schema} />
          </>
        )}
      </div>
    </PageShell>
  );
}

/** Org-wide compatibility report: which billing concepts map to which objects in THIS org, and which aren't available. */
export function BillingOrgDiscovery({ isDark, onOpenModule }: { isDark: boolean; onOpenModule: (moduleKey: string) => void }) {
  const t = tokens(isDark);
  const [refresh, setRefresh] = useState(0);
  // Each Refresh changes the path (?refresh=1&n=…), which both re-fetches and tells the server to drop its Describe caches.
  const { data, error, loading } = useBillingData<BillingMetadataResponse>("Discover billing metadata", `/api/billing/metadata${refresh ? `?refresh=1&n=${refresh}` : ""}`);

  return (
    <PageShell>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: t.heading }}>Revenue Cloud Billing — Metadata Discovery</div>
            <div style={{ fontSize: 11.5, color: t.dim }}>
              {data ? `${data.modules.filter(m => m.available).length} of ${data.modules.length} billing concepts available · ${data.instanceUrl.replace(/^https:\/\//, "")} · API ${data.apiVersion}` : "Inspecting the connected org…"}
            </div>
          </div>
          <ToolbarButton isDark={isDark} label="Refresh metadata" icon="refresh" disabled={loading} onClick={() => { clearBillingSchemaCache(); setRefresh(r => r + 1); }} />
        </div>
        {error && <ErrorPanel isDark={isDark} error={error} />}
        {!data && !error && <LoadingRow isDark={isDark} label="Describing every billing object in the org…" />}
        {data && BILLING_GROUPS.map(g => (
          <Panel key={g.id} isDark={isDark} title={g.label} icon={g.icon} padding={0}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>{["Concept", "Salesforce object", "Access", "Fields", "Required fields", "Relationships", ""].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {data.modules.filter(m => m.group === g.id).map(m => (
                    <tr key={m.moduleKey} style={{ borderBottom: `1px solid ${t.border}`, opacity: m.available ? 1 : 0.65 }}>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: t.heading, whiteSpace: "nowrap" }}>{m.label}</td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, color: m.available ? t.body : t.dim }}>
                        {m.available ? m.sobject : <span title={`Tried: ${m.candidatesTried.join(", ")}`}>Not available (tried {m.candidatesTried.join(", ")})</span>}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{m.available && <span style={{ display: "flex", gap: 3 }}><Flag on={m.createable} label="Createable" isDark={isDark} /><Flag on={m.queryable} label="Queryable" isDark={isDark} /><Flag on={m.updateable} label="Updateable" isDark={isDark} /></span>}</td>
                      <td style={{ padding: "8px 12px", color: t.body, whiteSpace: "nowrap" }}>{m.fieldCount !== null ? `${m.createableFieldCount} / ${m.fieldCount}` : ""}</td>
                      <td style={{ padding: "8px 12px", color: t.body, fontFamily: mono, fontSize: 11 }}>{m.requiredFields.join(", ")}</td>
                      <td style={{ padding: "8px 12px", color: t.dim, fontSize: 11 }}>{[...m.inlineChildren.map(c => `⤷ ${c}`), ...m.inboundLinks.map(l => `⇠ ${l}`)].join("  ")}{m.error && <span style={{ color: t.error }}>{m.error}</span>}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        {m.available && (
                          <button onClick={() => onOpenModule(m.moduleKey)} style={{ background: "transparent", border: "none", cursor: "pointer", color: t.accent, display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 700, fontSize: 11.5 }}>
                            Open <Ic n="arrow-right" s={11} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
        {data && <CodeBlock isDark={isDark} data={data} />}
      </div>
    </PageShell>
  );
}
