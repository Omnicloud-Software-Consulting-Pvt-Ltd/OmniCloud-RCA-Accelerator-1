import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { seedDraftFields } from "@/lib/billing/client";
import { buildTaxRatePrefill } from "@/lib/taxLibrary/prefill";
import { SEED_RATES } from "@/lib/taxLibrary/seed";
import { RATE_LIBRARY_PATH, rateLibraryDataUrl } from "@/lib/taxLibrary/navigation";
import { moduleGuideKeyFor, taxesIntroKey, MODULE_GUIDES } from "@/lib/help/moduleGuides";
import type { BillingDraftRecord, BillingFieldMeta, BillingModuleSchema } from "@/lib/billing/types";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const walk = (dir: string): string[] => fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** TaxRate fields as Describe reports them in p10 (API 68): Name/Country/State are NOT createable. */
const field = (name: string, createable: boolean, type = "string"): BillingFieldMeta => ({ name, label: name, type, required: false, createable, updateable: createable, nillable: true, defaultedOnCreate: false, isNameField: name === "Name", length: null, precision: null, scale: null, helpText: null, picklistValues: [], restrictedPicklist: false, controllerName: null, referenceTo: [], relationshipName: null, referenceModules: {}, calculated: false, custom: false, system: false });
const TAX_RATE_SCHEMA = { moduleKey: "tax-rates", sobject: "TaxRate", fields: [
  field("Name", false), field("Country", false), field("State", false),
  field("TaxCode", true), field("Rate", true, "double"), field("GeoCountryId", true, "reference"), field("GeoStateId", true, "reference"),
  field("StartDate", true, "date"), field("EndDate", true, "date"), field("FlatTaxAmount", true, "double"), field("RateUsageType", true, "picklist"),
] } as unknown as BillingModuleSchema;
const emptyDraft: BillingDraftRecord = { key: "k", moduleKey: "tax-rates", fields: {}, references: {}, children: [] };

/* ── Use This Rate → existing create form ── */

test("prefill reaches the existing form through createable fields only; nothing Salesforce-specific is guessed", () => {
  const p = buildTaxRatePrefill(SEED_RATES.find(r => r.id === "seed-in-ap-gst-18")!, "2026-11-05");
  const d = seedDraftFields(emptyDraft, TAX_RATE_SCHEMA, { ...p.fields, Name: "should be dropped", State: "AP" });
  assert.deepEqual(d.fields, { TaxCode: "GST18", Rate: 18, StartDate: "2017-07-01" });
  assert.ok(!("RateUsageType" in d.fields));
  assert.equal(seedDraftFields(emptyDraft, TAX_RATE_SCHEMA, undefined), emptyDraft, "without prefill the existing form starts exactly as before");
});

test("the four primary fields are covered: Tax Code + Rate as fields, Geo Country + Geo State as org-resolved lookups", () => {
  const ws = read("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /initialReferences=\{view\.prefill\} initialFields=\{view\.fields\}/);
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /references\.GeoCountryId = \{ id: g\.country\.id/);
  assert.match(lib, /references\.GeoStateId = \{ id: g\.state\.id/);
  // A missing Geo record is never silently skipped or invented: the user is asked (setGeoFlow) and it's created only via the confirmed route.
  assert.match(lib, /if \(!g\.country \|\| \(stateCode && !g\.state\)\) \{\s*setGeoFlow\(/);
});


/** The library's single sanctioned write — confirmed Geo Country / Geo State creation (/api/taxes/rate-library/geo). Stripped before the no-write checks. */
const withoutGeoWrite = (src: string) => src
  .replace("import { quoteApiGet, quoteApiPost, toErrorPanelData } from \"@/lib/quotes/client/apiClient\";", "")
  .replace('quoteApiPost<EnsureGeoResponse>("Create Salesforce geography", "/api/taxes/rate-library/geo", { confirmed: true', "");

test("Tax Rate creation still requires the existing Validate → Create in the Salesforce form (the library only creates confirmed Geo records)", () => {
  const cw = read("components/data/billing/BillingCreateWorkspace.tsx");
  assert.match(cw, /initialFields\?: Record<string, unknown>/);
  assert.match(cw, /seedDraftFields\(emptyDraft\(s\), s, initialFields\)/);
  // The library never posts to a create endpoint.
  for (const f of [...walk("components/data/taxes/library"), ...walk("lib/taxLibrary")].filter(f => !f.endsWith(".test.ts"))) {
    const src = withoutGeoWrite(fs.readFileSync(f, "utf8"));
    assert.ok(!/quoteApiPost|method:\s*"(POST|PATCH|PUT|DELETE)"|\/api\/billing\/tax-rates|\/api\/taxes\/objects/.test(src), `${f} must not write to Salesforce`);
  }
});

/* ── No Salesforce writes from the library ── */

test("the library's only Salesforce route is read-only (GET, SOQL SELECT only)", () => {
  const route = read("app/api/taxes/rate-library/salesforce/route.ts");
  assert.ok(/export async function GET/.test(route));
  assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(route));
  assert.ok(!/updateRecord|createRecord|compositeAt|composite|method:\s*"(POST|PATCH|DELETE)"/.test(route));
  const soql = route.match(/`SELECT[^`]*`/g) ?? [];
  assert.ok(soql.length >= 3 && soql.every(q => q.startsWith("`SELECT")));
  // Library logic and storage have no Salesforce dependency at all (reference data is org-independent).
  for (const f of walk("lib/taxLibrary").filter(f => !f.endsWith(".test.ts"))) assert.ok(!/@\/lib\/salesforce|serverSession|requireSFClient/.test(fs.readFileSync(f, "utf8")), f);
});

/* ── Navigation / existing page preserved ── */

test("Tax Rates page: the Global Tax Rate Library card is added; existing cards stay", () => {
  const dash = read("components/data/billing/BillingModuleDashboard.tsx");
  assert.match(dash, /moduleKey === "tax-rates" && status\?\.available !== false\) actions\.push\(\{ id: "rate-library", title: "Global Tax Rate Library", desc: "Browse, maintain, and reuse tax rates across countries and jurisdictions\."/);
  assert.match(dash, /workflow === "rate-library"\) onNavigate\(\{ billing: \{ moduleKey, view: "rate-library" \} \}\)/);
  for (const id of ['id: "create"', 'id: "history"', 'id: "refresh"', 'id: "inspect"', 'id: "bulk-assign"']) assert.ok(dash.includes(id), `existing card ${id} kept`);
});

test("dedicated page: Taxes workspace view with URL restore, breadcrumb, redirect route and its own intro", () => {
  const ws = read("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /i\.view === RATE_LIBRARY_VIEW && i\.moduleKey === RATE_LIBRARY_MODULE\) return \{ kind: "rate-library"/);
  assert.match(ws, /case "rate-library": return \{ tv: RATE_LIBRARY_VIEW, tm: v\.moduleKey, tid: null \}/);
  assert.match(ws, /"rate-library": "Global Tax Rate Library"/);
  assert.equal(RATE_LIBRARY_PATH, "/data/tax-rate-library");
  assert.equal(rateLibraryDataUrl(), "/data?module=taxes-rates&tm=tax-rates&tv=rate-library");
  assert.match(read("app/data/tax-rate-library/page.tsx"), /redirect\(rateLibraryDataUrl\(\)\)/);
  assert.equal(moduleGuideKeyFor({ itemId: "taxes-rates", groupId: "taxes", taxesKey: taxesIntroKey({ tv: "rate-library", tm: "tax-rates", tid: null }) }), "tax-rate-library");
  assert.match(JSON.stringify(MODULE_GUIDES["tax-rate-library"]), /Partially verified/);
  assert.ok(!/import/i.test(JSON.stringify(MODULE_GUIDES["tax-rate-library"])), "the guide never asks users to import");
});

/* ── Existing tax functionality untouched ── */

test("existing AI Tax Rate creation path is intact (Tax Assistant analysis, PromptGuide, validation)", () => {
  const cw = read("components/data/billing/BillingCreateWorkspace.tsx");
  assert.match(cw, /const viaTaxAssistant = !!def\.aiViaTaxAssistant;/);
  assert.match(cw, /<BillingRecordForm isDark=\{isDark\} schema=\{schema\} draft=\{draft\}/);
  assert.ok(/aiViaTaxAssistant: true/.test(read("lib/taxes/modules.ts")));
});

test("library UI uses the theme tokens (light + dark) and has loading / empty states", () => {
  const lib = read("components/data/taxes/library/TaxRateLibrary.tsx");
  assert.match(lib, /const t = tokens\(isDark\)/);
  assert.match(lib, /Loading reference tax data…/);
  assert.match(lib, /title=\{`No source-backed tax rates for /);
  assert.match(lib, /title="No rates match these filters"/);
  assert.match(lib, /Reading the product&apos;s classification…/);
  assert.match(lib, /geo \? "All countries" : "Loading countries…"/);
  assert.ok(!/#ffffff|#000000|background: "white"/i.test(lib), "no hard-coded light/dark colours");
});
