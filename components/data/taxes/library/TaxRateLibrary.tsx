"use client";

import { useEffect, useMemo, useState } from "react";
import { Ic } from "@/components/data/dashboardShell";
import { tokens, inputStyle, GhostButton, PrimaryButton, EmptyState, Spinner } from "@/components/data/quotes/shared";
import { Modal, StatusPill } from "@/components/data/billing/billingUi";
import FieldHelp from "@/components/help/FieldHelp";
import { Z } from "@/lib/ui/overlay";
import { useConnectionKey } from "@/components/data/billing/tax/taxUi";
import { geoFlowQuestion, geoFlowWrites, planGeoFlow, type FreshGeo, type GeoFlow, type OrgGeo } from "@/lib/taxLibrary/geoSync";
import { PRIORITY_TIER_LABEL, TAX_USAGE_EVENT, browserUsageStorage, countryPriority, currentAppUser, emptyUsage, loadUsage, trackUsage, usageScope, type ConfiguredCountry, type SalesforceCountryActivity, type UsageEvent, type UsageState } from "@/lib/taxLibrary/usage";
import type { EnsureGeoResult } from "@/lib/taxLibrary/server/geoEnsure";
import SalesforceLookup from "@/components/data/taxes/SalesforceLookup";
import RateEditor, { blankInput, toInput, type EditorMode } from "@/components/data/taxes/library/RateEditor";
import SearchableSelect, { type SelectOption } from "@/components/data/taxes/library/SearchableSelect";
import { computeCoverage, type CountryCoverage } from "@/lib/taxLibrary/datasets";
import CoverageDashboard, { LAYER_LABEL } from "@/components/data/taxes/library/CoverageDashboard";
import TaxMappingView from "@/components/data/taxes/library/TaxMappingView";
import { buildMapping, type MappingRow } from "@/lib/taxLibrary/mapping";
import { loadReferenceData, type CountryProfile, type ReferenceData } from "@/lib/taxLibrary/reference";
import { exportRecords } from "@/lib/taxLibrary/importExport";
import { quoteApiGet, quoteApiPost, toErrorPanelData } from "@/lib/quotes/client/apiClient";
import { useNotify } from "@/components/notifications/SalesforceSuccessContext";
import {
  COUNTRY_LEVEL, DEFAULT_PAGE_SIZE, NO_COMPONENT, PAGE_SIZES, REGION_SPECIFIC, classificationLabel, createRecord, duplicateRecord, facets, lineageOf, newVersion, queryLibrary, setArchived, splitByClassification, updateRecord, upsertAll,
  type Issue, type LibraryQuery,
} from "@/lib/taxLibrary/library";
import { buildTaxRatePrefill, type TaxRatePrefill } from "@/lib/taxLibrary/prefill";
import { TaxLibraryStore, TAX_LIBRARY_EVENT } from "@/lib/taxLibrary/store";
import { RATE_LIBRARY_DESCRIPTION, RATE_LIBRARY_TITLE, type RateLibraryPrefill } from "@/lib/taxLibrary/navigation";
import { rateLabel, statusOf, type EffectiveStatus, type TaxRateInput, type TaxRateReference, type VerificationStatus } from "@/lib/taxLibrary/types";
import type { LookupOption } from "@/lib/tax/types";
import type * as Geo from "@/lib/taxLibrary/jurisdictions";

type SortBy = NonNullable<LibraryQuery["sort"]>["by"];
const STATUS_FILTERS: EffectiveStatus[] = ["Active", "Upcoming", "Expired", "Draft", "Archived"];
/** Default view (also what "Clear filters" restores): everything except archived records, 15 per page, sorted by country. */
const DEFAULT_QUERY: LibraryQuery = { sort: { by: "country", dir: "asc" }, page: 1, pageSize: 15, statuses: ["Active", "Upcoming", "Expired", "Draft"] };
const VERIFY_LABEL: Record<VerificationStatus, string> = { verified: "Verified", "partially-verified": "Partially verified", unverified: "Unverified", "needs-review": "Needs review" };

interface GeoLookup { success: boolean; country: { id: string; name: string } | null; state: { id: string; name: string } | null; available: { geoCountry: boolean; geoState: boolean } }
type EnsureGeoResponse = EnsureGeoResult & { success: boolean };
interface ProductInfo { success: boolean; product?: { id: string; name: string }; classification: { name: string | null; code: string | null } | null; classificationFieldAvailable?: boolean; error?: string }

/**
 * GLOBAL TAX RATE LIBRARY — reference tax rates for every country (ISO 3166) and subdivision (ISO 3166-2): browse, search,
 * filter, maintain (create / edit / new version / duplicate / archive), export, and "Create Tax Rate in Salesforce" to prefill the EXISTING
 * Salesforce Tax Rate create form. The only Salesforce writes from this page are Geo Country / Geo State records the user explicitly
 * confirms ("Yes, Create Automatically" → /api/taxes/rate-library/geo); everything else here is read-only lookups
 * (Geo Country / Geo State records for the prefill, and a product's classification for the product context).
 */
export default function TaxRateLibrary({ isDark, onUseRate, onOpenSalesforceRates, initialCountry }: {
  isDark: boolean;
  /** Preselected country (e.g. from the Taxes dashboard's Tax Library widget). */
  initialCountry?: string | null;
  /** "Create Tax Rate in Salesforce" — opens the EXISTING create form pre-filled (nothing is created until the user confirms there). */
  onUseRate: (p: RateLibraryPrefill) => void;
  /** Existing Salesforce Tax Rate records (their own edit workflow) — separate from library edits. */
  onOpenSalesforceRates?: () => void;
}) {
  const t = tokens(isDark);
  const notify = useNotify();
  // Source-backed reference data ships with the app (never imported by users); browser storage only keeps the user's own changes.
  const [ref, setRef] = useState<ReferenceData | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const store = useMemo(() => new TaxLibraryStore(undefined, ref?.records ?? []), [ref]);
  const [state, setState] = useState<{ records: TaxRateReference[]; revision: number; userRecords: number }>({ records: [], revision: 0, userRecords: 0 });
  const records = state.records;
  const [geo, setGeo] = useState<typeof Geo | null>(null);
  const [query, setQuery] = useState<LibraryQuery>(() => ({ ...DEFAULT_QUERY, countryCode: initialCountry && /^[A-Z]{2}$/.test(initialCountry) ? initialCountry : null }));
  const [editor, setEditor] = useState<{ mode: EditorMode; id: string | null; initial: TaxRateInput; errors: Issue[]; warnings: Issue[] } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showCoverage, setShowCoverage] = useState(false);
  const [confirmUse, setConfirmUse] = useState<{ record: TaxRateReference; prefill: TaxRatePrefill; ack: boolean; state?: { code: string; name: string } } | null>(null);
  const [using, setUsing] = useState<string | null>(null);
  // Country → Geo State → tax mapping (default) or the rate records themselves (maintenance).
  const [view, setView] = useState<"mapping" | "records">("mapping");
  // The connected org's Geo Country / Geo State records (read once, re-read after a Geo record is created).
  const [orgGeo, setOrgGeo] = useState<OrgGeo | "loading" | null>(null);
  const [geoVersion, setGeoVersion] = useState(0);
  // Automatic Geo creation: what's missing for the row, the user's confirmation, and (for Create Tax Rate) the rate to continue with.
  const [geoFlow, setGeoFlow] = useState<GeoFlow | null>(null);
  // Per app user + Salesforce connection usage; nothing is recorded or read without both.
  const connectionKey = useConnectionKey();
  const usageScopeKey = useMemo(() => usageScope(currentAppUser(browserUsageStorage()), connectionKey), [connectionKey]);
  const track = (ev: UsageEvent) => trackUsage(browserUsageStorage(), usageScopeKey, ev);
  const [usage, setUsage] = useState<UsageState>(emptyUsage);
  useEffect(() => {
    const read = () => setUsage(loadUsage(browserUsageStorage(), usageScopeKey));
    read();
    window.addEventListener(TAX_USAGE_EVENT, read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener(TAX_USAGE_EVENT, read); window.removeEventListener("storage", read); };
  }, [usageScopeKey]);
  // This Salesforce user's Tax Rates / Geo records per country and the org's Tax Rates per country (read-only) — for the default order.
  const [activity, setActivity] = useState<{ myTaxRates: SalesforceCountryActivity[] | null; myGeo: SalesforceCountryActivity[] | null; configured: ConfiguredCountry[] } | null>(null);
  useEffect(() => {
    if (connectionKey === "server" || connectionKey === "none") return;
    let live = true;
    quoteApiGet<{ myTaxRates?: SalesforceCountryActivity[] | null; myGeo?: SalesforceCountryActivity[] | null; configured?: ConfiguredCountry[] }>("Read your tax activity", `/api/taxes/rate-library/salesforce?mode=dashboard&n=${geoVersion}`)
      .then(r => { if (live) setActivity({ myTaxRates: r.myTaxRates ?? null, myGeo: r.myGeo ?? null, configured: r.configured ?? [] }); })
      .catch(() => { if (live) setActivity(a => a ?? { myTaxRates: null, myGeo: null, configured: [] }); });
    return () => { live = false; };
  }, [connectionKey, geoVersion]);
  useEffect(() => {
    let live = true;
    setOrgGeo(g => (g && g !== "loading" ? g : "loading"));
    quoteApiGet<OrgGeo>("Read Salesforce Geo records", `/api/taxes/rate-library/salesforce?mode=geo-all&n=${geoVersion}`)
      .then(r => { if (live) setOrgGeo(r); })
      .catch(err => { if (live) setOrgGeo({ success: false, countries: [], states: [], available: { geoCountry: false, geoState: false }, error: toErrorPanelData(err, "Couldn't read Geo records").message }); });
    return () => { live = false; };
  }, [geoVersion]);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [product, setProduct] = useState<LookupOption | null>(null);
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);

  // ISO 3166 data is loaded lazily so it isn't part of the main bundle.
  useEffect(() => { let live = true; import("@/lib/taxLibrary/jurisdictions").then(m => { if (live) setGeo(m); }); return () => { live = false; }; }, []);
  useEffect(() => {
    let live = true;
    loadReferenceData().then(d => { if (live) setRef(d); }).catch(err => { if (live) setRefError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (ref) setState(store.load()); }, [ref, store]);
  // Another tab changed the library → re-read it.
  useEffect(() => {
    const on = () => setState(store.load());
    window.addEventListener(TAX_LIBRARY_EVENT, on);
    window.addEventListener("storage", on);
    return () => { window.removeEventListener(TAX_LIBRARY_EVENT, on); window.removeEventListener("storage", on); };
  }, [store]);

  const commit = (next: TaxRateReference[], ok: string): boolean => {
    const res = store.save(next, state.revision);
    if (!res.ok) { setMessage({ tone: "error", text: res.error }); return false; }
    setState(store.load());
    setMessage(null);
    notify.success("Tax Rate Library updated", ok, { module: "Taxes" });
    return true;
  };
  const refresh = () => { setState(store.load()); setMessage({ tone: "info", text: "Library reloaded." }); };

  const result = useMemo(() => queryLibrary(records, query), [records, query]);
  // Built once per data change (all countries, every ISO subdivision, applicable rates) — country / filter changes only re-filter it.
  const mapping = useMemo(() => (geo && ref ? buildMapping({ countries: geo.COUNTRIES, subdivisionsOf: geo.subdivisionsOf, records, profiles: ref.profiles }) : null), [geo, ref, records]);
  const f = useMemo(() => facets(records), [records]);
  // Country / subdivision options come from the ISO geographic catalog — never from tax-rate records — so a country or state with no
  // rates is still selectable. The hint only reports how many rates exist.
  const ratesByCountry = useMemo(() => { const m = new Map<string, number>(); for (const r of records) if (r.lifecycle !== "archived") m.set(r.jurisdiction.countryCode, (m.get(r.jurisdiction.countryCode) ?? 0) + 1); return m; }, [records]);
  // DEFAULT ORDER of every country (sorting, never filtering): recent activity → your Tax Rates → your Geo records → frequent →
  // Tax Rates in this org → official tax data → other. Re-computed as activity changes (no reload needed).
  const priority = useMemo(() => (geo ? countryPriority({ countries: geo.COUNTRIES, usage, myTaxRates: activity?.myTaxRates ?? null, myGeo: activity?.myGeo ?? null, configured: activity?.configured ?? [], dataCountries: ratesByCountry }) : null), [geo, usage, activity, ratesByCountry]);
  const countryOptions = useMemo<SelectOption[]>(() => (geo?.COUNTRIES ?? []).map(c => ({ value: c.code, label: `${c.name} (${c.code})`, hint: `${c.alpha3}${ratesByCountry.get(c.code) ? ` · ${ratesByCountry.get(c.code)} rates` : " · no rates"}${priority && priority.get(c.code)!.tier <= 5 ? ` · ${PRIORITY_TIER_LABEL[priority.get(c.code)!.tier]}` : ""}` }))
    .sort((a, b) => (priority?.get(a.value)?.rank ?? 0) - (priority?.get(b.value)?.rank ?? 0)), [geo, ratesByCountry, priority]);
  const manifests = useMemo(() => ref?.manifests ?? [], [ref]);
  const countryCov = useMemo(() => (query.countryCode ? computeCoverage(records, [query.countryCode], manifests).byCountry.get(query.countryCode) ?? null : null), [records, query.countryCode, manifests]);
  const profile: CountryProfile | null = (query.countryCode && ref?.profiles.get(query.countryCode)) || null;
  const subdivisionMap = useMemo(() => new Map((geo?.COUNTRIES ?? []).map(c => [c.code, geo!.subdivisionsOf(c.code).map(s => s.code)])), [geo]);
  const download = () => {
    const blob = new Blob([exportRecords(queryLibrary(records, { ...query, page: 1, pageSize: 100000 }).rows, "csv")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tax-rate-library.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  const countrySources = useMemo(() => [...new Set(records.filter(r => r.jurisdiction.countryCode === query.countryCode && r.lifecycle !== "archived").map(r => r.source.sourceName).filter((x): x is string => !!x))], [records, query.countryCode]);
  // Tax codes offered for the selected country (all countries otherwise) — the list stays usable with hundreds of codes.
  const codeOptions = useMemo(() => [...new Set(records.filter(r => !query.countryCode || r.jurisdiction.countryCode === query.countryCode).map(r => r.tax.taxCode))].sort(), [records, query.countryCode]);
  const subs = useMemo(() => (geo && query.countryCode ? geo.subdivisionsOf(query.countryCode) : []), [geo, query.countryCode]);
  const subdivisionOptions = useMemo<SelectOption[]>(() => query.countryCode ? [
    { value: COUNTRY_LEVEL, label: "Country Level — national rates only" },
    ...(records.some(r => r.jurisdiction.countryCode === query.countryCode && !r.jurisdiction.subdivisionCode && r.jurisdiction.locality) ? [{ value: REGION_SPECIFIC, label: "Region-specific rates (no ISO subdivision)" }] : []),
    ...subs.map(s => ({ value: s.code, label: `${s.level === 2 ? "— " : ""}${s.name}`, hint: `${s.code}${s.level === 2 ? ` · in ${s.parent}` : ""}` })),
  ] : [], [query.countryCode, subs, records]);
  const setQ = (patch: Partial<LibraryQuery>) => setQuery(q => ({ ...q, ...patch, page: patch.page ?? 1 }));
  // A country the user picks counts as recently used (its tax mappings are opened) — never just opening the dropdown.
  useEffect(() => {
    if (!query.countryCode || !geo) return;
    const c = geo.getCountry(query.countryCode);
    if (c) trackUsage(browserUsageStorage(), usageScopeKey, { kind: "country-selected", countryCode: c.code, countryName: c.name });
  }, [query.countryCode, geo, usageScopeKey]);

  /**
   * AUTOMATIC GEO CREATION for a mapping row (Create Geo Country / Create Geo State, or a Create Tax Rate whose geography is missing):
   *  1. fresh read of the org's Geo Country (ISO code) and its Geo States (ISO suffix UNDER that country's Id) — never a stale cache;
   *  2. nothing missing → no write (Create Tax Rate continues with the real Ids);
   *  3. otherwise ask once ("…create it automatically…?"), and only on "Yes, Create Automatically" call the server, which re-checks,
   *     creates the Geo Country first (if missing), then the Geo State with GeoCountryId = the parent's real Id, and reads both back;
   *  4. refresh the geography, activity and default order in place; Create Tax Rate then opens the form with BOTH real Ids.
   */
  const startGeoFlow = async (target: { country: { iso: string; name: string }; state: { code: string; name: string } | null; continueRate: GeoFlow["continueRate"] }, busyKey: string) => {
    if (using) return; // one flow at a time — repeated clicks are ignored
    setUsing(busyKey);
    try {
      const fresh = await quoteApiGet<FreshGeo>("Check Salesforce Geo records", `/api/taxes/rate-library/salesforce?mode=geo-states&country=${encodeURIComponent(target.country.iso)}`);
      const plan = planGeoFlow(fresh, target);
      if (plan.kind === "unavailable") { setMessage({ tone: "error", text: plan.message }); return; }
      if (plan.kind === "ready") {
        if (target.continueRate) { setUsing(null); await applyReferenceRate(target.continueRate.record, true, target.continueRate.state, target.continueRate.usingKey, plan.resolved); }
        else { setMessage({ tone: "info", text: plan.message }); setGeoVersion(n => n + 1); }
        return;
      }
      setGeoFlow({ ...target, needCountry: plan.needCountry, needState: plan.needState, existingCountry: plan.existingCountry, busy: false, error: null, partial: null });
    } catch (err) {
      setMessage({ tone: "error", text: `Couldn't check the Salesforce Geo records: ${toErrorPanelData(err, "lookup failed").message}. Nothing was created.` });
    } finally { setUsing(u => (u === busyKey ? null : u)); }
  };
  const runGeoFlow = async () => {
    const flow = geoFlow;
    if (!flow || flow.busy) return; // a second click while creating does nothing
    setGeoFlow({ ...flow, busy: true, error: null });
    let res: EnsureGeoResponse;
    try {
      res = await quoteApiPost<EnsureGeoResponse>("Create Salesforce geography", "/api/taxes/rate-library/geo", { confirmed: true, country: flow.country, state: flow.state });
    } catch (err) {
      setGeoFlow({ ...flow, busy: false, error: toErrorPanelData(err, "Salesforce rejected the request").message, partial: null });
      setGeoVersion(n => n + 1);
      return;
    }
    setGeoVersion(n => n + 1); // refresh geography, activity and the default order — also after a partial result
    if (res.country?.created) track({ kind: "geo-country-created", countryCode: flow.country.iso, countryName: flow.country.name });
    if (res.state?.created) track({ kind: "geo-state-created", countryCode: flow.country.iso, countryName: flow.country.name });
    if (!res.success || !res.country || (flow.state && !res.state)) {
      setGeoFlow({ ...flow, busy: false, error: res.error ?? "Salesforce didn't confirm the geography.", partial: res.partial ?? null });
      return;
    }
    setGeoFlow(null);
    const made = [res.country.created && `Geo Country ${res.country.name} (${res.country.isoCode}, ${res.country.id})`, res.state?.created && `Geo State ${res.state.name} (${res.state.isoCode}, ${res.state.id}) under ${res.country.name}`].filter(Boolean).join(" and ");
    notify.success(made ? "Salesforce geography created" : "Salesforce geography already existed", made ? `Created ${made} — read back from Salesforce.` : "The existing records are used; nothing was created.", { module: "Taxes" });
    if (flow.continueRate) {
      await applyReferenceRate(flow.continueRate.record, true, flow.continueRate.state, flow.continueRate.usingKey, {
        country: { id: res.country.id, name: res.country.name },
        state: res.state ? { id: res.state.id, name: res.state.name } : null,
      });
    }
  };
  const toggleIn = <T,>(list: T[] | undefined, v: T) => (list ?? []).includes(v) ? (list ?? []).filter(x => x !== v) : [...(list ?? []), v];
  const sortBy = (by: SortBy) => setQuery(q => ({ ...q, sort: { by, dir: q.sort?.by === by && q.sort.dir === "asc" ? "desc" : "asc" } }));

  // Product context — classification metadata only (never Product Code / name).
  useEffect(() => {
    if (!product) return;
    let live = true;
    quoteApiGet<ProductInfo>("Read product classification", `/api/taxes/rate-library/salesforce?mode=product&id=${encodeURIComponent(product.id)}`)
      .then(r => { if (live) setProductInfo(r); })
      .catch(err => { if (live) setProductInfo({ success: false, classification: null, error: toErrorPanelData(err, "Could not read the product").message }); });
    return () => { live = false; };
  }, [product]);
  const split = useMemo(() => (product && productInfo?.success ? splitByClassification(result.rows, productInfo.classification ? { classificationCode: productInfo.classification.code, classificationName: productInfo.classification.name } : null) : null), [product, productInfo, result.rows]);
  const fit = (r: TaxRateReference) => (!split ? null : split.matching.includes(r) ? "match" : split.general.includes(r) ? "general" : "other");

  /* ── actions ── */
  const save = (v: TaxRateInput) => {
    if (!editor) return;
    if (editor.mode === "create") {
      const r = createRecord(records, v);
      if (!r.ok) { setEditor({ ...editor, initial: v, errors: r.errors, warnings: r.warnings }); return; }
      if (commit([...records, r.value], `Added ${r.value.tax.taxName}.`)) setEditor(null);
    } else if (editor.mode === "edit" && editor.id) {
      const r = updateRecord(records, editor.id, v);
      if (!r.ok) { setEditor({ ...editor, initial: v, errors: r.errors, warnings: r.warnings }); return; }
      if (commit(upsertAll(records, [r.value]), `Saved ${r.value.tax.taxName}. Salesforce Tax Rates are not changed by library edits.`)) setEditor(null);
    } else if (editor.mode === "version" && editor.id) {
      const r = newVersion(records, editor.id, { rate: v.rate, tax: v.tax, classification: v.classification, source: v.source, jurisdiction: v.jurisdiction, effective: { effectiveFrom: v.effective.effectiveFrom, effectiveTo: v.effective.effectiveTo } });
      if (!r.ok) { setEditor({ ...editor, initial: v, errors: r.errors, warnings: r.warnings }); return; }
      if (commit(upsertAll(records, [r.value.closed, r.value.created]), `Version ${r.value.created.version} added; version ${r.value.closed.version} closed on ${r.value.closed.effective.effectiveTo}.`)) setEditor(null);
    }
  };
  const duplicate = (id: string) => { const r = duplicateRecord(records, id); if (r.ok && commit([...records, r.value], "Duplicated as a draft — edit it, then publish.")) setEditor({ mode: "edit", id: r.value.id, initial: toInput(r.value), errors: [], warnings: [] }); };
  const archive = (id: string, on: boolean) => { const r = setArchived(records, id, on); if (!r.ok) { setMessage({ tone: "error", text: r.errors[0].message }); return; } commit(upsertAll(records, [r.value]), on ? "Archived — kept as history." : "Restored."); };

  /** `state` = the Geo State of an "Inherited national rate" mapping row (the national record carries no state of its own). */
  const applyReferenceRate = async (record: TaxRateReference, confirmed = false, state?: { code: string; name: string }, usingKey = record.id, resolved?: { country: { id: string; name: string }; state: { id: string; name: string } | null }) => {
    const prefill = buildTaxRatePrefill(record, undefined, { state });
    if (prefill.blocked) { setMessage({ tone: "error", text: prefill.blocked }); return; }
    if (prefill.requiresConfirmation && !confirmed) { setConfirmUse({ record, prefill, ack: false, state }); return; }
    setConfirmUse(null);
    const notices = [...prefill.notices];
    const references: RateLibraryPrefill["references"] = {};
    const stateCode = prefill.geo.stateIso ? `${prefill.geo.countryIso}-${prefill.geo.stateIso}` : null;
    if (resolved) {
      // Ids just created / confirmed and read back by the server (runGeoFlow) — used as-is.
      if (stateCode && !resolved.state) { setMessage({ tone: "error", text: `Geo State ${prefill.geo.stateName ?? stateCode} wasn't confirmed by Salesforce, so the Tax Rate form wasn't opened.` }); return; }
      references.GeoCountryId = { id: resolved.country.id, name: resolved.country.name, sobject: "GeoCountry", moduleKey: "geo-countries" };
      if (resolved.state && stateCode) references.GeoStateId = { id: resolved.state.id, name: resolved.state.name, sobject: "GeoState", moduleKey: "geo-states" };
    } else {
      setUsing(usingKey);
      try {
        // READ-ONLY and fresh: the org's Geo Country (ISO code) and Geo State (ISO suffix under that Geo Country). The Tax Rate form
        // only ever gets REAL Ids — missing geography is offered for automatic creation first, never an empty or invented lookup.
        const p = new URLSearchParams({ mode: "geo", country: prefill.geo.countryIso, ...(prefill.geo.stateIso ? { state: prefill.geo.stateIso } : {}) });
        const g = await quoteApiGet<GeoLookup>("Find Geo records", `/api/taxes/rate-library/salesforce?${p}`);
        if (!g.country || (stateCode && !g.state)) {
          setGeoFlow({
            country: { iso: prefill.geo.countryIso, name: prefill.geo.countryName }, state: stateCode ? { code: stateCode, name: prefill.geo.stateName ?? stateCode } : null,
            needCountry: !g.country, needState: !!stateCode && !g.state, existingCountry: g.country ? { id: g.country.id, name: g.country.name } : null,
            continueRate: { record, state, usingKey }, busy: false, error: null, partial: null,
          });
          return;
        }
        references.GeoCountryId = { id: g.country.id, name: g.country.name, sobject: "GeoCountry", moduleKey: "geo-countries" };
        if (stateCode && g.state) references.GeoStateId = { id: g.state.id, name: g.state.name, sobject: "GeoState", moduleKey: "geo-states" };
      } catch (err) {
        setMessage({ tone: "error", text: `Couldn't read the Salesforce Geo records (${toErrorPanelData(err, "lookup failed").message}). The Tax Rate form wasn't opened, so it never gets a missing Geo Country or Geo State. Try again.` });
        return;
      } finally { setUsing(null); }
    }
    notices.push(`Salesforce relationships: GeoCountryId = ${references.GeoCountryId.id} (${references.GeoCountryId.name})${references.GeoStateId ? `, GeoStateId = ${references.GeoStateId.id} (${references.GeoStateId.name})` : ""}. They're read back after you create the Tax Rate.`);
    track({
      kind: "tax-rate-started", countryCode: record.jurisdiction.countryCode, countryName: record.jurisdiction.countryName,
      rate: { key: `${record.id}|${state?.code ?? record.jurisdiction.subdivisionCode ?? ""}`, taxCode: record.tax.taxCode, countryCode: record.jurisdiction.countryCode, countryName: record.jurisdiction.countryName, geoStateCode: state?.code ?? record.jurisdiction.subdivisionCode, geoStateName: state?.name ?? record.jurisdiction.subdivisionName, taxCategory: record.tax.taxCategory, ratePercent: record.rate.ratePercent },
    });
    onUseRate({ fields: prefill.fields, references, notices, warnings: prefill.warnings, summary: prefill.summary });
  };

  const detail = detailId ? records.find(r => r.id === detailId) ?? null : null;
  const cell = { padding: "7px 8px", verticalAlign: "top" as const };
  const th = (label: string, by?: SortBy) => (
    <th style={{ padding: "8px", whiteSpace: "nowrap", cursor: by ? "pointer" : undefined }} onClick={by ? () => sortBy(by) : undefined} aria-sort={by && query.sort?.by === by ? (query.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}{by && query.sort?.by === by ? (query.sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button key={label} onClick={onClick} aria-pressed={active} style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, cursor: "pointer", border: `1px solid ${active ? t.accent : t.border}`, color: active ? t.accent : t.dim, background: active ? `${t.accent}14` : "transparent" }}>{label}</button>
  );
  const select = (label: string, value: string, opts: { v: string; l: string }[], on: (v: string) => void, all = "All") => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 150, flex: "1 1 150px" }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <select value={value} onChange={e => on(e.target.value)} style={inputStyle(t)}><option value="">{all}</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </label>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 18 }}>
      <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: `${t.accent}1f`, border: `1px solid ${t.accent}40`, color: t.accent }}><Ic n="globe" s={20} /></div>
            <div>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: t.heading }}>{RATE_LIBRARY_TITLE}</h1>
              <p style={{ margin: "4px 0 0", fontSize: 12.5, color: t.dim }}>{RATE_LIBRARY_DESCRIPTION}</p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label="New Reference Rate" icon="plus" isDark={isDark} onClick={() => setEditor({ mode: "create", id: null, initial: blankInput(), errors: [], warnings: [] })} />
            <GhostButton label="Coverage" icon="pie-chart" isDark={isDark} onClick={() => setShowCoverage(v => !v)} />
            <GhostButton label="Export CSV" icon="download" isDark={isDark} disabled={!records.length} onClick={download} />
            <GhostButton label="Refresh" icon="refresh" isDark={isDark} onClick={refresh} />
          </div>
        </div>

        {/* Data honesty banner */}
        <div style={{ fontSize: 12, color: t.body, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.warn}55`, background: `${t.warn}0d`, display: "flex", gap: 8 }}>
          <span style={{ color: t.warn, display: "inline-flex", marginTop: 1 }}><Ic n="alert" s={13} /></span>
          <span>
            <b>Reference data, not a tax determination.</b> Every ISO 3166 country{geo ? ` (${geo.DATASET_INFO.countries})` : ""} and subdivision{geo ? ` (${geo.DATASET_INFO.subdivisions.toLocaleString()})` : ""} is listed.
            Tax rates come from official sources — the European Commission&apos;s TEDB for EU VAT, and national tax authorities and legislation elsewhere — each with its source, date and verification status.
            National rates apply in every state/province of the country; state and local taxes are shown only where a source covers them. Where no official source could be confirmed, the gap is stated — see <b>Coverage</b>.
            Your own edits are saved in this browser. Nothing here writes to Salesforce.
          </span>
        </div>

        {message && <div role="status" style={{ fontSize: 12.5, color: message.tone === "error" ? t.error : t.accent }}>{message.text}</div>}
        {!store.available && <div style={{ fontSize: 12.5, color: t.warn }}>Browser storage isn&apos;t available — your own edits can&apos;t be saved in this session (reference data is unaffected).</div>}
        {refError && <div role="alert" style={{ fontSize: 12.5, color: t.error }}>Couldn&apos;t load the reference tax data: {refError}</div>}
        {showCoverage && geo && ref && <CoverageDashboard isDark={isDark} records={records} manifests={manifests} profiles={ref.profiles} countries={geo.COUNTRIES} subdivisions={subdivisionMap} subdivisionsTotal={geo.DATASET_INFO.subdivisions} countriesWithSubdivisions={geo.DATASET_INFO.countriesWithSubdivisions} onPickCountry={cc => { setQ({ countryCode: cc, subdivisionCode: null }); setShowCoverage(false); }} onClose={() => setShowCoverage(false)} />}

        {/* View switch */}
        <div role="tablist" aria-label="Library view" style={{ display: "flex", gap: 6 }}>
          {([["mapping", "Country & State Mapping"], ["records", "Rate Records"]] as const).map(([v, l]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 9, cursor: "pointer", border: `1px solid ${view === v ? t.accent : t.border}`, color: view === v ? t.accent : t.body, background: view === v ? `${t.accent}14` : "transparent" }}>{l}</button>
          ))}
        </div>

        {view === "mapping" && (!mapping ? (
          refError ? null : <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim, padding: 16 }}><Spinner isDark={isDark} size={14} /> Loading countries, Geo States and tax rates…</div>
        ) : <>
          {query.countryCode && geo && countryCov && (
            <CountryStatus isDark={isDark} country={geo.getCountry(query.countryCode)} subdivisions={subs.length} cov={countryCov} sources={countrySources} profile={profile} subdivision={null}
              onAdd={() => setEditor({ mode: "create", id: null, initial: { ...blankInput(), jurisdiction: { ...blankInput().jurisdiction, countryCode: query.countryCode! } }, errors: [], warnings: [] })} />
          )}
          <TaxMappingView isDark={isDark} rows={mapping.rows} totals={mapping.totals} countryCode={query.countryCode ?? null} countryOptions={countryOptions} creatingKey={using}
            orgGeo={orgGeo} onRetryGeo={() => setGeoVersion(n => n + 1)} priority={priority}
            onCreateGeo={(kind, row) => void startGeoFlow({ country: { iso: row.countryCode, name: row.countryName }, state: kind === "state" && row.geoStateCode ? { code: row.geoStateCode, name: row.geoStateName ?? row.geoStateCode } : null, continueRate: null }, `geo:${kind === "country" ? row.countryCode : row.geoStateCode}`)}
            onCountry={cc => setQ({ countryCode: cc, subdivisionCode: null })}
            onCreate={(row: MappingRow) => { if (row.record) void applyReferenceRate(row.record, false, row.status === "inherited-national" && row.geoStateCode ? { code: row.geoStateCode, name: row.geoStateName ?? row.geoStateCode } : undefined, row.key); }} />
        </>)}

        {view === "records" && <>
        {/* Search + cascading filters */}
        <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10, background: t.surface }}>
          <div style={{ position: "relative" }}>
            <input value={query.q ?? ""} onChange={e => setQ({ q: e.target.value })} placeholder="Search country, state, ISO code, tax name, tax code, type, component, structure, classification or source…" aria-label="Search tax rates" style={{ ...inputStyle(t), paddingLeft: 30 }} />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: t.dim, display: "inline-flex" }}><Ic n="search" s={13} /></span>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <SearchableSelect isDark={isDark} label="1 · Country" value={query.countryCode ?? ""} allLabel="All countries" placeholder={geo ? "All countries" : "Loading countries…"} disabled={!geo}
              options={countryOptions} onChange={v => setQ({ countryCode: v || null, subdivisionCode: null })} emptyText="No country matches." />
            <SearchableSelect isDark={isDark} label="2 · State / province / territory" value={query.subdivisionCode ?? ""} disabled={!query.countryCode}
              allLabel={query.countryCode ? "All (national + every subdivision)" : undefined}
              placeholder={query.countryCode ? (subs.length ? "All (national + every subdivision)" : "No ISO subdivisions — national only") : "Select a country first"}
              options={subdivisionOptions} onChange={v => setQ({ subdivisionCode: v || null })} emptyText="No subdivision matches." />
            {select("3 · Tax structure", query.taxStructure ?? "", f.taxStructures.map(v => ({ v, l: v })), v => setQ({ taxStructure: v || null }))}
            {select("Tax type", query.taxType ?? "", f.taxTypes.map(v => ({ v, l: v })), v => setQ({ taxType: v || null }))}
            {select("Tax code", query.taxCode ?? "", codeOptions.map(v => ({ v, l: v })), v => setQ({ taxCode: v || null }))}
            {select("Tax component", query.taxComponent ?? "", [{ v: NO_COMPONENT, l: "Not a component (single / combined rate)" }, ...f.taxComponents.map(v => ({ v, l: v }))], v => setQ({ taxComponent: v || null }))}
            <label style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 150, flex: "1 1 150px" }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", letterSpacing: 0.3 }}>Effective on date</span>
              <input type="date" value={query.asOf ?? ""} onChange={e => setQ({ asOf: e.target.value || null })} aria-label="Effective on date" style={inputStyle(t)} />
            </label>
            {select("4 · Product classification", query.classification ?? "", f.classifications.map(v => ({ v, l: v })), v => setQ({ classification: v || null }))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase" }}>Status</span>
            {STATUS_FILTERS.map(s => chip(!!query.statuses?.includes(s), s, () => setQ({ statuses: toggleIn(query.statuses, s) })))}
            <span style={{ fontSize: 10.5, fontWeight: 700, color: t.dim, textTransform: "uppercase", marginLeft: 8 }}>Verification</span>
            {(Object.keys(VERIFY_LABEL) as VerificationStatus[]).map(v => chip(!!query.verification?.includes(v), VERIFY_LABEL[v], () => setQ({ verification: toggleIn(query.verification, v) })))}
            <GhostButton label="Clear filters" icon="x" isDark={isDark} onClick={() => setQuery({ ...DEFAULT_QUERY, sort: query.sort, pageSize: query.pageSize })} />
          </div>
          {/* Product context (optional) */}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 280px", minWidth: 0 }}>
              <SalesforceLookup isDark={isDark} object="Product2" value={product} onChange={v => { setProduct(v); setProductInfo(null); }} label="Product context (optional)" placeholder="Pick a product to compare its classification…" />
            </div>
            <FieldHelp isDark={isDark} label="Product context" entry={{ text: "Compares rates with the product's actual classification metadata (its Revenue Cloud Product Classification). Product Code and product name are never used as a tax classification, and no rate is selected for you.", impact: "Rows are marked Matches / General / Other classification. Nothing is assigned to the product." }} />
          </div>
          {product && (
            <div style={{ fontSize: 12, color: t.body }}>
              {!productInfo ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Spinner isDark={isDark} size={12} /> Reading the product&apos;s classification…</span>
                : !productInfo.success ? <span style={{ color: t.warn }}>{productInfo.error}</span>
                : productInfo.classification ? <>Product classification: <b>{[productInfo.classification.code, productInfo.classification.name].filter(Boolean).join(" · ")}</b> — {split?.matching.length ?? 0} matching, {split?.general.length ?? 0} general, {split?.other.length ?? 0} other on this page. Choose the rate yourself.</>
                : <>This product has no classification{productInfo.classificationFieldAvailable === false ? " field in this org" : ""} — all candidate rates are shown; choose the appropriate one.</>}
            </div>
          )}
        </div>

        {query.subdivisionCode && query.subdivisionCode !== COUNTRY_LEVEL && query.subdivisionCode !== REGION_SPECIFIC && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.body }}>
            <input type="checkbox" checked={query.includeCountryLevel !== false} onChange={e => setQ({ includeCountryLevel: e.target.checked })} />
            Include national (country-level) rates that apply in {subs.find(s => s.code === query.subdivisionCode)?.name ?? query.subdivisionCode}
          </label>
        )}

        {query.countryCode && geo && countryCov && (
          <CountryStatus isDark={isDark} country={geo.getCountry(query.countryCode)} subdivisions={subs.length} cov={countryCov} sources={countrySources} profile={profile}
            subdivision={query.subdivisionCode && query.subdivisionCode.includes("-") ? (() => { const sd = subs.find(x => x.code === query.subdivisionCode); return sd ? { code: sd.code, name: sd.name, own: records.filter(r => r.lifecycle !== "archived" && r.jurisdiction.subdivisionCode === sd.code).length } : null; })() : null}
            onAdd={() => setEditor({ mode: "create", id: null, initial: { ...blankInput(), jurisdiction: { ...blankInput().jurisdiction, countryCode: query.countryCode!, subdivisionCode: query.subdivisionCode && query.subdivisionCode.includes("-") ? query.subdivisionCode : null } }, errors: [], warnings: [] })} />
        )}

        {/* Table */}
        {!ref && !refError ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: t.dim, padding: 16 }}><Spinner isDark={isDark} size={14} /> Loading reference tax data…</div>
        ) : records.length === 0 ? (
          <EmptyState isDark={isDark} icon="globe" title="No reference tax data is available" hint={refError ? "The bundled reference data couldn't be loaded — reload the page." : "No reference datasets are bundled with this build."} />
        ) : result.total === 0 ? (
          query.countryCode && countryCov && countryCov.records === 0
            ? <EmptyState isDark={isDark} icon="globe" title={`No source-backed tax rates for ${geo?.getCountry(query.countryCode)?.name ?? query.countryCode} yet`} hint={`${profile?.status === "no-consumption-tax" ? "The official source states there is no general consumption tax. " : ""}${profile?.note ? `${profile.note} ` : "No official source for this country's consumption-tax rates has been confirmed. "}Missing: ${profile?.missingScope.join("; ") || "national consumption-tax rates"}. No rate is shown rather than an unconfirmed one.`} />
            : <EmptyState isDark={isDark} icon="search" title="No rates match these filters" hint={query.countryCode && countryCov ? `${countryCov.records} rate(s) exist for this country — clear or change the other filters.` : "Clear or change the filters."} />
        ) : (
          <div style={{ border: `1px solid ${t.border}`, borderRadius: 12, overflow: "hidden", background: t.surface }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 1180 }}>
                <thead style={{ background: t.surfaceAlt }}>
                  <tr style={{ textAlign: "left", color: t.dim, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3 }}>
                    {th("Country", "country")}{th("State / Province", "subdivision")}{th("Tax Code", "taxCode")}{th("Tax Name", "taxName")}{th("Tax Type", "taxType")}{th("Structure")}{th("Rate Category")}{th("Classification")}{th("Rate", "rate")}{th("From", "effectiveFrom")}{th("To", "effectiveTo")}{th("Status", "status")}{th("Verification")}{th("Actions")}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map(r => {
                    const st = statusOf(r);
                    const fitness = fit(r);
                    return (
                      <tr key={r.id} style={{ borderTop: `1px solid ${t.border}`, opacity: st === "Archived" ? 0.6 : 1 }}>
                        <td style={cell}><b style={{ color: t.heading }}>{r.jurisdiction.countryName}</b> <span style={{ color: t.dim }}>{r.jurisdiction.countryCode}</span></td>
                        <td style={cell}>{r.jurisdiction.subdivisionName ? <>{r.jurisdiction.subdivisionName} <span style={{ color: t.dim }}>{r.jurisdiction.subdivisionCode}</span></> : (r.jurisdiction.locality ? <span title={r.jurisdiction.locality}><span style={{ color: t.warn, fontWeight: 700 }}>Region-specific</span><div style={{ fontSize: 11, color: t.dim }}>{r.jurisdiction.locality.slice(0, 48)}</div></span> : <span style={{ color: t.dim, fontWeight: 600 }}>Country Level</span>)}</td>
                        <td style={{ ...cell, fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: t.accent }}>{r.tax.taxCode}{r.tax.officialTaxCode && r.tax.officialTaxCode !== r.tax.taxCode ? <div style={{ fontSize: 10.5, color: t.dim }}>official: {r.tax.officialTaxCode}</div> : r.tax.taxCodeGenerated ? <div style={{ fontSize: 10.5, color: t.dim, fontFamily: "inherit" }} title="The source publishes no tax code; this code was generated by the library.">generated</div> : null}</td>
                        <td style={cell}>{r.tax.taxName}{r.tax.taxComponent ? <div style={{ fontSize: 11, color: t.dim }}>Component: {r.tax.taxComponent}{r.rate.componentOrder ? ` (#${r.rate.componentOrder})` : ""}</div> : null}</td>
                        <td style={cell}>{r.tax.taxType}</td>
                        <td style={cell}>{r.tax.taxStructure}</td>
                        <td style={cell}>{r.tax.taxCategory ?? "—"}</td>
                        <td style={cell}>{classificationLabel(r) ?? <span style={{ color: t.dim }}>General</span>}
                          {fitness && <div style={{ fontSize: 10.5, fontWeight: 700, color: fitness === "match" ? "#00C875" : fitness === "general" ? t.dim : t.warn }}>{fitness === "match" ? "Matches product classification" : fitness === "general" ? "General (no classification)" : "Other classification"}</div>}</td>
                        <td style={{ ...cell, fontWeight: 700, color: t.heading, whiteSpace: "nowrap" }}>{rateLabel(r.rate)}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.effective.effectiveFrom}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.effective.effectiveTo ?? "—"}</td>
                        <td style={cell}><StatusPill status={st} isDark={isDark} />{r.version > 1 && <div style={{ fontSize: 10.5, color: t.dim }}>v{r.version}</div>}</td>
                        <td style={{ ...cell, color: r.source.verification === "verified" ? "#00C875" : t.warn, fontWeight: 700, whiteSpace: "nowrap" }}>{VERIFY_LABEL[r.source.verification] ?? r.source.verification}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <RowBtn isDark={isDark} icon="eye" label="View" onClick={() => setDetailId(r.id)} />
                            {st !== "Archived" && <RowBtn isDark={isDark} icon="edit" label="Edit" onClick={() => setEditor({ mode: "edit", id: r.id, initial: toInput(r), errors: [], warnings: [] })} />}
                            {r.lifecycle === "published" && !records.some(x => x.supersedesId === r.id && x.lifecycle !== "archived") && <RowBtn isDark={isDark} icon="refresh" label="New Version" onClick={() => setEditor({ mode: "version", id: r.id, initial: { ...toInput(r), effective: { effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: null } }, errors: [], warnings: [] })} />}
                            <RowBtn isDark={isDark} icon="copy" label="Duplicate" onClick={() => duplicate(r.id)} />
                            <RowBtn isDark={isDark} icon="arrow-right" label="Select" primary onClick={() => setDetailId(r.id)} />
                            <RowBtn isDark={isDark} icon={st === "Archived" ? "refresh" : "archive"} label={st === "Archived" ? "Restore" : "Archive"} onClick={() => archive(r.id, st !== "Archived")} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", borderTop: `1px solid ${t.border}`, fontSize: 12, color: t.dim, flexWrap: "wrap" }}>
              <span data-testid="page-summary">Showing {result.from}–{result.to} of {result.total} tax rate{result.total === 1 ? "" : "s"} · page {result.page} of {result.pageCount}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select value={query.pageSize ?? DEFAULT_PAGE_SIZE} onChange={e => setQ({ pageSize: Number(e.target.value) })} aria-label="Rows per page" style={{ ...inputStyle(t), width: 100, padding: "5px 8px" }}>{PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}</select>
                <GhostButton label="First" icon="chevron-left" isDark={isDark} disabled={result.page <= 1} onClick={() => setQuery(q => ({ ...q, page: 1 }))} />
                <GhostButton label="Previous" icon="chevron-left" isDark={isDark} disabled={result.page <= 1} onClick={() => setQuery(q => ({ ...q, page: result.page - 1 }))} />
                <GhostButton label="Next" icon="chevron-right" isDark={isDark} disabled={result.page >= result.pageCount} onClick={() => setQuery(q => ({ ...q, page: result.page + 1 }))} />
                <GhostButton label="Last" icon="chevron-right" isDark={isDark} disabled={result.page >= result.pageCount} onClick={() => setQuery(q => ({ ...q, page: result.pageCount }))} />
              </div>
            </div>
          </div>
        )}
        </>}
      </div>

      {editor && <RateEditor key={`${editor.mode}:${editor.id}`} isDark={isDark} geo={geo} mode={editor.mode} initial={editor.initial} current={editor.id ? records.find(r => r.id === editor.id) ?? null : null}
        errors={editor.errors} warnings={editor.warnings} onCancel={() => setEditor(null)} onSave={save} />}

      {detail && <RateDetail isDark={isDark} record={detail} lineage={lineageOf(records, detail.id)} onClose={() => setDetailId(null)} onOpen={id => setDetailId(id)}
        creating={using === detail.id} onCreateInSalesforce={() => applyReferenceRate(detail)} onOpenSalesforceRates={onOpenSalesforceRates} />}

      {geoFlow && <GeoFlowDialog isDark={isDark} flow={geoFlow} onConfirm={() => void runGeoFlow()} onCancel={() => setGeoFlow(null)} />}

      {confirmUse && (
        <Modal isDark={isDark} title="Use this reference rate?" tone="warn" actions={<>
          <GhostButton label="Cancel" isDark={isDark} onClick={() => setConfirmUse(null)} />
          <PrimaryButton label="Continue to Tax Rate Form" icon="arrow-right" isDark={isDark} disabled={!confirmUse.ack} onClick={() => applyReferenceRate(confirmUse.record, true, confirmUse.state)} />
        </>}>
          <div><b>{confirmUse.record.tax.taxName}</b> — {confirmUse.prefill.summary}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{confirmUse.prefill.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          <div style={{ fontSize: 12, color: t.dim }}>The Salesforce Tax Rate form opens pre-filled; nothing is created until you validate and click Create there.</div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={confirmUse.ack} onChange={e => setConfirmUse({ ...confirmUse, ack: e.target.checked })} /> I understand ({confirmUse.prefill.confirmationReasons.join(" ")})
          </label>
        </Modal>
      )}
    </div>
  );
}

/** The selected country's (and subdivision's) facts: geography (ISO) and tax data kept separate, with coverage gaps stated explicitly. */
function CountryStatus({ isDark, country, subdivisions, cov, sources, profile, subdivision, onAdd }: {
  isDark: boolean; country: { code: string; name: string; alpha3: string; numeric: string } | null; subdivisions: number; cov: CountryCoverage; sources: string[];
  profile: CountryProfile | null; subdivision: { code: string; name: string; own: number } | null; onAdd: () => void;
}) {
  const t = tokens(isDark);
  const level = cov.level === "covered" ? "Covered for dataset scope" : cov.level === "partial" ? "Partial" : profile?.status === "no-consumption-tax" ? "No general consumption tax (per official source)" : "No source-backed tax data";
  const color = cov.level === "covered" ? "#00C875" : cov.level === "partial" ? t.warn : t.dim;
  const flag = (label: string, on: boolean) => <span style={{ color: on ? "#00C875" : t.dim }}>{on ? "✓" : "—"} {label}</span>;
  const missing = profile?.missingScope.length ? profile.missingScope : cov.records ? [] : ["National consumption-tax rates"];
  return (
    <div data-testid="country-status" style={{ border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 12px", background: t.surface, display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: t.body }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div><b style={{ color: t.heading, fontSize: 13 }}>{country?.name ?? cov.countryCode}</b> <span style={{ color: t.dim }}>{country ? `ISO ${country.code} · ${country.alpha3} · ${country.numeric}` : ""}</span></div>
        <div><span style={{ color: t.dim }}>Geography:</span> {subdivisions} subdivision{subdivisions === 1 ? "" : "s"}</div>
        <div><span style={{ color: t.dim }}>Tax data:</span> <b style={{ color }}>{level}</b> · {cov.records} rate{cov.records === 1 ? "" : "s"} ({cov.verified} verified, {cov.partiallyVerified} partially verified, {cov.unverified} unverified)</div>
        <div style={{ marginLeft: "auto" }}><GhostButton label="Add reference rate" icon="plus" isDark={isDark} onClick={onAdd} /></div>
      </div>
      {subdivision && (
        <div data-testid="subdivision-status" style={{ color: t.body }}>
          <b style={{ color: t.heading }}>{subdivision.name}</b> <span style={{ color: t.dim }}>{subdivision.code} · in {country?.name ?? cov.countryCode}</span> — {cov.countryLevelRates > 0 ? `national rules apply here (${cov.countryLevelRates} country-level rate${cov.countryLevelRates === 1 ? "" : "s"})` : "no national rates in the library"}; {subdivision.own ? `${subdivision.own} state/provincial rate${subdivision.own === 1 ? "" : "s"}` : profile?.subnational === "none" ? "no state/provincial tax layer" : "no state/provincial rates in the library"}{profile ? ` · local taxes: ${LAYER_LABEL[profile.local]}` : ""}.
        </div>
      )}
      {cov.records > 0 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {flag("Standard rate", cov.hasStandard)}{flag("Reduced rates", cov.hasReduced)}{flag("Zero rate", cov.hasZero)}{flag("Exempt categories", cov.hasExempt)}
          <span><span style={{ color: t.dim }}>Tax types:</span> {cov.taxTypes.join(", ")}</span>
          {cov.components.length > 0 && <span><span style={{ color: t.dim }}>Components:</span> {cov.components.join(", ")}</span>}
          {cov.classifications > 0 && <span><span style={{ color: t.dim }}>Classifications:</span> {cov.classifications}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span><span style={{ color: t.dim }}>State / provincial taxes:</span> {profile ? LAYER_LABEL[profile.subnational] : "Not assessed"}</span>
        <span><span style={{ color: t.dim }}>Local taxes:</span> {profile ? LAYER_LABEL[profile.local] : "Not assessed"}</span>
        {missing.length > 0 && <span data-testid="missing-scope" style={{ color: t.warn }}><b>Missing:</b> {missing.join("; ")}</span>}
      </div>
      {profile?.note && <div style={{ color: t.dim }}>{profile.note}</div>}
      {sources.length > 0 && <div style={{ color: t.dim }}>Sources: {sources.join(" · ")}</div>}
    </div>
  );
}

function RowBtn({ isDark, icon, label, onClick, primary, disabled }: { isDark: boolean; icon: string; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  const t = tokens(isDark);
  return (
    <button onClick={onClick} disabled={disabled} title={label} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 7, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
      border: primary ? "none" : `1px solid ${t.border}`, color: primary ? "#04101F" : t.body, background: primary ? `linear-gradient(135deg, ${t.accent}, ${t.accentBlue})` : "transparent" }}>
      <Ic n={icon} s={11} />{label}
    </button>
  );
}

function RateDetail({ isDark, record: r, lineage, onClose, onOpen, creating, onCreateInSalesforce, onOpenSalesforceRates }: {
  isDark: boolean; record: TaxRateReference; lineage: TaxRateReference[]; onClose: () => void; onOpen: (id: string) => void;
  creating: boolean; onCreateInSalesforce: () => void; onOpenSalesforceRates?: () => void;
}) {
  const archived = statusOf(r) === "Archived";
  const t = tokens(isDark);
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 10, fontSize: 12.5, padding: "3px 0" }}><span style={{ color: t.dim }}>{label}</span><span style={{ color: t.heading }}>{value ?? "—"}</span></div>
  );
  return (
    <div role="dialog" aria-modal="true" aria-label="Reference rate details" style={{ position: "fixed", inset: 0, zIndex: Z.dialog, background: "rgba(0,5,15,0.5)", display: "flex", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(620px, 100vw)", height: "100%", background: t.surface, borderLeft: `1px solid ${t.border}`, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 800, color: t.heading }}>{r.tax.taxName} <span style={{ color: t.dim, fontWeight: 600 }}>v{r.version}</span></div>
          <StatusPill status={statusOf(r)} isDark={isDark} />
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: t.dim, cursor: "pointer" }}><Ic n="x" s={16} /></button>
        </div>
        <div style={{ border: `1px solid ${t.accent}55`, background: `${t.accent}0d`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <PrimaryButton label={creating ? "Opening the Salesforce form…" : "Create Tax Rate in Salesforce"} icon="arrow-right" isDark={isDark} disabled={creating || archived} onClick={onCreateInSalesforce} />
          <div style={{ fontSize: 11.5, color: t.dim }}>
            {archived ? "Archived rates can't be used — restore it first." : "Opens the existing Salesforce Create Tax Rate form pre-filled from this reference rate. Nothing is created until you review, validate and click Create there; cancelling creates nothing. The new Salesforce rate is not activated or assigned to products."}
          </div>
          {onOpenSalesforceRates && <div><GhostButton label="Edit existing Salesforce Tax Rates" icon="external-link" isDark={isDark} onClick={onOpenSalesforceRates} /></div>}
        </div>
        <div>
          {row("Jurisdiction", `${r.jurisdiction.subdivisionName ? `${r.jurisdiction.subdivisionName} (${r.jurisdiction.subdivisionCode}), ` : "Country level, "}${r.jurisdiction.countryName} (${r.jurisdiction.countryCode})${r.jurisdiction.locality ? ` · ${r.jurisdiction.locality}` : ""}`)}
          {row("Tax Code", <><code style={{ color: t.accent }}>{r.tax.taxCode}</code>{r.tax.taxCodeGenerated ? <span style={{ color: t.dim }}> · generated by the library (the source publishes no code)</span> : null}</>)}
          {row("Official tax code", r.tax.officialTaxCode ?? null)}
          {row("Type / Structure", `${r.tax.taxType} · ${r.tax.taxStructure}`)}
          {row("Component", r.tax.taxComponent ? `${r.tax.taxComponent}${r.rate.componentOrder ? ` (order ${r.rate.componentOrder})` : ""}` : null)}
          {row("Authority / Category", [r.tax.taxAuthority, r.tax.taxCategory].filter(Boolean).join(" · ") || null)}
          {row("Rate", `${rateLabel(r.rate)} · ${r.rate.calculation}${r.rate.compound ? " · compound" : ""}${r.rate.minRatePercent !== null || r.rate.maxRatePercent !== null ? ` · min ${r.rate.minRatePercent ?? "—"} / max ${r.rate.maxRatePercent ?? "—"}` : ""}`)}
          {row("Classification", classificationLabel(r))}
          {row("Categories", [r.classification.productCategory, r.classification.serviceCategory].filter(Boolean).join(" · ") || null)}
          {row("Conditions", [r.classification.transactionType, r.classification.placeOfSupply, r.classification.conditions, r.classification.description].filter(Boolean).join(" · ") || null)}
          {row("Effective", `${r.effective.effectiveFrom} → ${r.effective.effectiveTo ?? "open"}`)}
          {row("Source organization", r.source.sourceOrganization ?? r.tax.taxAuthority)}
          {row("Source", r.source.sourceUrl ? <a href={r.source.sourceUrl} target="_blank" rel="noreferrer" style={{ color: t.accent }}>{r.source.sourceName ?? r.source.sourceUrl}</a> : r.source.sourceName)}
          {row("Source reference", r.source.sourceReference)}
          {row("Verification", `${VERIFY_LABEL[r.source.verification] ?? r.source.verification}${r.source.lastVerifiedAt ? ` (${r.source.lastVerifiedAt})` : ""}`)}
          {row("Notes", r.source.notes)}
          {row("Origin", r.origin)}
          {row("Created / Updated", `${r.createdAt.slice(0, 10)} / ${r.updatedAt.slice(0, 10)}`)}
        </div>
        {lineage.length > 1 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Versions</div>
            {lineage.map(v => (
              <button key={v.id} onClick={() => onOpen(v.id)} style={{ display: "flex", gap: 8, width: "100%", textAlign: "left", fontSize: 12, padding: "5px 8px", borderRadius: 8, border: `1px solid ${v.id === r.id ? t.accent : t.border}`, background: "transparent", color: t.body, cursor: "pointer", marginBottom: 4 }}>
                <b>v{v.version}</b> {rateLabel(v.rate)} · {v.effective.effectiveFrom} → {v.effective.effectiveTo ?? "open"} · {statusOf(v)}
              </button>
            ))}
          </div>
        )}
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.dim, textTransform: "uppercase", marginBottom: 6 }}>Audit trail</div>
          {r.history.slice().reverse().map((h, i) => <div key={i} style={{ fontSize: 12, color: t.body, padding: "2px 0" }}><span style={{ color: t.dim }}>{h.at.slice(0, 16).replace("T", " ")}</span> · <b>{h.action}</b> — {h.detail}</div>)}
        </div>
      </div>
    </div>
  );
}

/** "…create it automatically…?" — the explicit confirmation before any Geo write; shows exactly what will be written. */
function GeoFlowDialog({ isDark, flow, onConfirm, onCancel }: { isDark: boolean; flow: GeoFlow; onConfirm: () => void; onCancel: () => void }) {
  const t = tokens(isDark);
  const writes = geoFlowWrites(flow);
  return (
    <Modal isDark={isDark} title={flow.continueRate ? "Create the Salesforce geography for this Tax Rate?" : "Create Salesforce geography?"} tone="warn" actions={<>
      <GhostButton label="Cancel" isDark={isDark} disabled={flow.busy} onClick={onCancel} />
      <PrimaryButton label={flow.busy ? "Creating…" : flow.error ? "Try Again" : "Yes, Create Automatically"} icon="check" isDark={isDark} disabled={flow.busy} onClick={onConfirm} />
    </>}>
      <div data-testid="geo-flow-question" style={{ fontWeight: 700 }}>{geoFlowQuestion(flow)}</div>
      <div style={{ fontSize: 12, color: t.body, display: "flex", flexDirection: "column", gap: 4 }}>
        {writes.map((w, i) => (
          <div key={w.object}><b>{i + 1}. Create {w.object === "GeoCountry" ? "Geo Country" : "Geo State"}</b> — {Object.entries(w.fields).map(([k, v]) => <span key={k}><code>{k}</code> = {v}; </span>)}</div>
        ))}
        {!flow.needCountry && flow.existingCountry && <div style={{ color: t.dim }}>Uses the existing Geo Country {flow.existingCountry.name} ({flow.existingCountry.id}).</div>}
        {flow.continueRate && <div style={{ color: t.dim }}>Then the Tax Rate form opens with the real Geo Country{flow.state ? " and Geo State" : ""} Ids — you review and create the Tax Rate there.</div>}
        <div style={{ color: t.dim }}>Salesforce is checked again right before each write; an existing record is reused, never duplicated.</div>
      </div>
      {flow.busy && <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: t.dim }}><Spinner isDark={isDark} size={12} /> Creating in Salesforce…</div>}
      {flow.error && <div role="alert" style={{ fontSize: 12.5, color: t.error }}>{flow.error}</div>}
      {flow.partial && <div role="alert" style={{ fontSize: 12.5, color: t.warn }}>{flow.partial} The Tax Rate was not created.</div>}
    </Modal>
  );
}
