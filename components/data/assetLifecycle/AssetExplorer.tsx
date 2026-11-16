"use client";

import { useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, EmptyState, ErrorPanel, GhostButton } from "@/components/data/quotes/shared";
import { LoadingRow, useBillingData } from "@/components/data/billing/billingUi";
import ReferenceLookup, { type ReferenceLookupValue } from "@/components/data/shared/ReferenceLookup";
import type { AssetRow, AssetState, LifecycleKind } from "@/lib/assetLifecycle/types";
import { Badge, EligibilityBadge, SECTION_META, SortTh, StateBadge, TableFrame, fmtDate, fmtMoney, fmtNum, td, th, typeLabel } from "./lifecycleUi";
import FieldHelp from "@/components/help/FieldHelp";
import { LIFECYCLE_HELP as LH } from "@/lib/help/lifecycleHelp";

interface AssetPageResponse { rows: AssetRow[]; total: number; page: number; pageSize: number; hasMore: boolean; soql: string }
interface ContractOption { id: string; name: string }

const STATES: { value: AssetState | "all"; label: string }[] = [
  { value: "all", label: "All states" }, { value: "active", label: "Active" }, { value: "expiring", label: "Expiring (90 days)" }, { value: "expired", label: "Expired" },
  { value: "future", label: "Starts in future" }, { value: "cancelled", label: "Cancelled" }, { value: "unmanaged", label: "Not lifecycle-managed" },
];

/**
 * THE asset discovery + selection component — used by the Assets page (browse), and by the Amendment, Renewal and Cancellation wizards
 * (select, with that lifecycle's eligibility). Server-side search / filters / sort / pagination (GET /api/assets); every row carries
 * Salesforce values and the eligibility reasons computed from them.
 */
export default function AssetExplorer({ isDark, kind, account, contractId, onAccountChange, selected, onToggle, onOpen, initialState = "all", pageSize = 25 }: {
  isDark: boolean;
  /** Selection mode: rows show this lifecycle's eligibility and only eligible rows can be selected. */
  kind?: LifecycleKind;
  /** Fixed account (wizard) — when omitted the explorer shows its own account filter. */
  account?: ReferenceLookupValue | null;
  contractId?: string | null;
  onAccountChange?: (a: ReferenceLookupValue | null) => void;
  selected?: Map<string, AssetRow>;
  onToggle?: (row: AssetRow, on: boolean) => void;
  onOpen?: (assetId: string) => void;
  initialState?: AssetState | "all";
  pageSize?: number;
}) {
  const t = tokens(isDark);
  const fixedAccount = account !== undefined;
  const [ownAccount, setOwnAccount] = useState<ReferenceLookupValue | null>(null);
  const acct = fixedAccount ? account : ownAccount;
  const [ownContract, setOwnContract] = useState<string>("");
  const contract = contractId !== undefined ? contractId ?? "" : ownContract;
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<AssetState | "all">(initialState);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lifecycleOnly, setLifecycleOnly] = useState(true);
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [showSoql, setShowSoql] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, dir, state, lifecycleOnly: lifecycleOnly ? "1" : "0" });
  if (acct?.id) params.set("accountId", acct.id);
  if (contract) params.set("contractId", contract);
  if (query) params.set("q", query);
  if (from) params.set("expiresFrom", from);
  if (to) params.set("expiresTo", to);
  const { data, error, loading, reload } = useBillingData<AssetPageResponse>("Load assets", `/api/assets?${params.toString()}`);
  const contracts = useBillingData<{ rows: ContractOption[] }>("Load contracts", acct?.id && contractId === undefined ? `/api/assets/lookup?type=contracts&accountId=${acct.id}` : null);

  const reset = (fn: () => void) => { fn(); setPage(1); };
  const onSort = (col: string) => reset(() => { if (col === sort) setDir(d => (d === "asc" ? "desc" : "asc")); else { setSort(col); setDir("asc"); } });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selectable = !!kind && !!onToggle;
  const eligibleOnPage = kind ? rows.filter(r => !r.eligibility[kind].some(x => x.severity === "error")) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="asset-explorer">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8, alignItems: "end" }}>
        {!fixedAccount && (
          <div style={{ gridColumn: "span 2", minWidth: 0 }}>
            <ReferenceLookup isDark={isDark} objectType="Account" searchEndpoint="/api/assets/reference/search" value={ownAccount} browseOnFocus placeholder="Account (accounts with lifecycle assets)…"
              onChange={v => reset(() => { setOwnAccount(v); setOwnContract(""); onAccountChange?.(v); })} />
          </div>
        )}
        {contractId === undefined && (
          <select aria-label="Contract filter" value={ownContract} disabled={!acct} onChange={e => reset(() => setOwnContract(e.target.value))} style={inputStyle(t)} title={acct ? "Optional — filters to assets related to the contract" : "Choose an account to filter by its contracts"}>
            <option value="">{acct ? "Any contract (optional)" : "Contract — choose an account"}</option>
            {(contracts.data?.rows ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <form onSubmit={e => { e.preventDefault(); reset(() => setQuery(q.trim())); }} style={{ display: "flex", gap: 6, gridColumn: "span 2", minWidth: 0 }}>
          <input aria-label="Search assets" value={q} onChange={e => setQ(e.target.value)} placeholder="Search asset, product, code or account…" style={{ ...inputStyle(t), flex: 1 }} />
          <GhostButton label="Search" icon="search" isDark={isDark} onClick={() => reset(() => setQuery(q.trim()))} />
          <span style={{ alignSelf: "center" }}><FieldHelp isDark={isDark} label="Search assets" entry={LH.assetSearch} /></span>
        </form>
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}><select aria-label="Lifecycle state" value={state} onChange={e => reset(() => setState(e.target.value as AssetState | "all"))} style={inputStyle(t)}>
          {STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select><FieldHelp isDark={isDark} label="Lifecycle state" entry={LH.assetState} /></span>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: t.dim, fontWeight: 700 }}><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>EXPIRES FROM <FieldHelp isDark={isDark} label="Expires from" entry={LH.expiresFrom} /></span><input type="date" aria-label="Expires from" value={from} onChange={e => reset(() => setFrom(e.target.value))} style={inputStyle(t)} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: t.dim, fontWeight: 700 }}><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>EXPIRES TO <FieldHelp isDark={isDark} label="Expires to" entry={LH.expiresTo} /></span><input type="date" aria-label="Expires to" value={to} onChange={e => reset(() => setTo(e.target.value))} style={inputStyle(t)} /></label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: t.body }}>
          <input type="checkbox" checked={lifecycleOnly} onChange={e => reset(() => setLifecycleOnly(e.target.checked))} /> Lifecycle-managed only <FieldHelp isDark={isDark} label="Lifecycle-managed only" entry={LH.lifecycleOnly} />
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12, color: t.dim }}>
        <span>
          {loading ? "Loading…" : `${total} asset(s)${acct ? ` · ${acct.name}` : " · all accounts"}${contract ? " · contract filter" : ""}`}
          {selectable && selected ? ` · ${selected.size} selected` : ""}
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          {selectable && eligibleOnPage.length > 0 && <GhostButton label="Select eligible on page" icon="check" isDark={isDark} onClick={() => eligibleOnPage.forEach(r => onToggle!(r, true))} />}
          <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={reload} />
          {data?.soql && <GhostButton label={showSoql ? "Hide SOQL" : "SOQL"} icon="terminal" isDark={isDark} onClick={() => setShowSoql(v => !v)} />}
        </span>
      </div>
      {showSoql && data?.soql && <pre style={{ margin: 0, padding: 10, borderRadius: 8, background: t.surfaceAlt, border: `1px solid ${t.border}`, fontSize: 11, color: t.body, overflowX: "auto", whiteSpace: "pre-wrap" }}>{data.soql}</pre>}
      {error && <ErrorPanel isDark={isDark} error={error} />}
      {loading && !data && <LoadingRow isDark={isDark} label="Reading assets from Salesforce…" />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState isDark={isDark} icon="archive" title="No assets found" hint={contract ? "No asset is related to this contract (Asset Contract Relationship, origin order or pricing contract). Clear the contract to see all of the account's assets." : "Try another account, search or filter. Only assets created through Revenue Cloud's order-to-asset lifecycle can be amended, renewed or cancelled."} />
      )}
      {rows.length > 0 && (
        <TableFrame isDark={isDark}>
          <thead>
            <tr>
              {selectable && <th style={th(t)} aria-label="Select" />}
              <SortTh t={t} label="Asset" col="name" sort={sort} dir={dir} onSort={onSort} />
              <SortTh t={t} label="Product" col="product" sort={sort} dir={dir} onSort={onSort} />
              {!fixedAccount && <SortTh t={t} label="Account" col="account" sort={sort} dir={dir} onSort={onSort} />}
              <SortTh t={t} label="Qty" col="quantity" sort={sort} dir={dir} onSort={onSort} />
              <th style={th(t)}>Selling model</th>
              <th style={th(t)}>Unit price</th>
              <th style={th(t)}>Billing</th>
              <SortTh t={t} label="Start" col="start" sort={sort} dir={dir} onSort={onSort} />
              <SortTh t={t} label="End" col="end" sort={sort} dir={dir} onSort={onSort} />
              <th style={th(t)}>Origin / contract</th>
              <th style={th(t)}>State</th>
              {kind && <th style={th(t)}>{SECTION_META[kind].verb} eligibility</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const reasons = kind ? r.eligibility[kind] : [];
              const blocked = reasons.some(x => x.severity === "error");
              const on = !!selected?.has(r.id);
              return (
                <tr key={r.id} style={{ background: on ? `${t.accent}10` : undefined }}>
                  {selectable && (
                    <td style={td(t)}>
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={on} disabled={blocked && !on} onChange={e => onToggle!(r, e.target.checked)} title={blocked ? reasons.filter(x => x.severity === "error").map(x => x.message).join("\n") : undefined} />
                    </td>
                  )}
                  <td style={td(t)}>
                    <button onClick={() => onOpen?.(r.id)} disabled={!onOpen} style={{ background: "none", border: "none", padding: 0, cursor: onOpen ? "pointer" : "default", color: t.heading, fontWeight: 700, fontSize: 12.5, textAlign: "left", paddingLeft: r.parentId ? 14 : 0 }}>
                      {r.parentId ? "↳ " : ""}{r.name}
                    </button>
                    <div style={{ fontSize: 10.5, color: t.dim }}>{r.id}{r.childIds.length ? ` · bundle (${r.childIds.length})` : ""}{r.usage.usageBased ? " · usage" : ""}</div>
                  </td>
                  <td style={td(t)}>{r.productName ?? "—"}{r.productCode ? <div style={{ fontSize: 10.5, color: t.dim }}>{r.productCode}</div> : null}</td>
                  {!fixedAccount && <td style={td(t)}>{r.accountName ?? "—"}</td>}
                  <td style={td(t)}>{fmtNum(r.quantity)}</td>
                  <td style={td(t)}>{typeLabel(r.sellingModel?.type)}<div style={{ fontSize: 10.5, color: t.dim }}>{r.sellingModel?.name ?? ""}</div></td>
                  <td style={td(t)}>{fmtMoney(r.unitPrice)}{r.discount ? <div style={{ fontSize: 10.5, color: t.dim }}>−{r.discount}%</div> : null}</td>
                  <td style={td(t)}>{r.billingFrequency ?? "—"}</td>
                  <td style={td(t)}>{fmtDate(r.lifecycleStart)}</td>
                  <td style={td(t)}>{fmtDate(r.lifecycleEnd)}</td>
                  <td style={td(t)}>{r.originOrder?.number ? `Order ${r.originOrder.number}` : "—"}<div style={{ fontSize: 10.5, color: t.dim }}>{r.contracts.map(c => c.number ?? c.id).join(", ")}</div></td>
                  <td style={td(t)}><StateBadge state={r.state} isDark={isDark} />{r.open.length > 0 && <div style={{ marginTop: 4 }}><Badge label={`Open ${r.open[0].type ?? ""} quote`} color="#F59E0B" isDark={isDark} title={r.open.map(o => `${o.type} ${o.quoteNumber ?? o.quoteId} (${o.status})`).join("\n")} /></div>}</td>
                  {kind && <td style={td(t)}><EligibilityBadge reasons={reasons} isDark={isDark} /></td>}
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}
      {total > pageSize && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, fontSize: 12, color: t.dim }}>
          <GhostButton label="Previous" icon="chevron-left" isDark={isDark} disabled={page <= 1 || loading} onClick={() => setPage(p => Math.max(1, p - 1))} />
          <span>Page {page} of {pages}</span>
          <GhostButton label="Next" icon="chevron-right" isDark={isDark} disabled={!data?.hasMore || loading} onClick={() => setPage(p => p + 1)} />
        </div>
      )}
      {selectable && selected && selected.size > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12, color: t.body }}>
          <Ic n="check-circle" s={13} /> Selected:
          {[...selected.values()].map(r => (
            <button key={r.id} onClick={() => onToggle!(r, false)} title="Remove from selection" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.heading, fontSize: 11.5, cursor: "pointer" }}>
              {r.name} <Ic n="x" s={11} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
