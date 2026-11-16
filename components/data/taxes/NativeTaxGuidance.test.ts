/**
 * Native Salesforce Tax guidance — provider-aware display, dismissal/reopen, keyboard-accessible tips, and placement on the Tax Dashboard,
 * tax configuration screens and transaction screens. Components are rendered with react-dom/server (this repo has no browser/JSDOM
 * harness), interaction logic is tested through its pure helpers, and screen wiring is asserted against source like the repo's other
 * component tests. Nothing here talks to Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeTaxConfigurationNotice, TaxConfigHelp, TaxInfoTip, TransactionTaxHelp } from "./NativeTaxGuidance";
import RecordFields, { withSlotHelp } from "@/components/data/shared/RecordFields";
import {
  CONFIG_TIPS, NATIVE_STEPS, NATIVE_TITLE, RATE_REFRESH_TIP, TRANSACTION_NATIVE, UNKNOWN_PROVIDER, UNKNOWN_TITLE,
  classifyTaxProvider, configTipText, dismissKey, readDismissed, tipKeyAction, transactionTaxText, writeDismissed, type EngineLike,
} from "@/lib/taxes/provider";

const engine = (o: Partial<EngineLike>): EngineLike => ({ name: "Engine", type: "RevenueStandardTax", status: "Active", native: true, provider: null, ...o });
const NATIVE = classifyTaxProvider([engine({ name: "Revenue Standard Tax Engine" })]);
const EXTERNAL = classifyTaxProvider([engine({ name: "AvaTax", type: "Avalara", native: false, provider: { name: "Avalara Provider" } })]);
const MIXED = classifyTaxProvider([engine({ name: "RST" }), engine({ name: "AvaTax", type: "Avalara", native: false, provider: { name: "Avalara Provider" } })]);
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const banner = (provider: Parameters<typeof NativeTaxConfigurationNotice>[0]["provider"], o: Record<string, unknown> = {}) =>
  render(h(NativeTaxConfigurationNotice, { isDark: false, provider, connectionKey: "org|user", defaultDismissed: false, ...o }));
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/* ── provider detection (reuses the engine `native` flag; never assumes native) ── */

test("provider: only active Revenue Standard Tax engines make an org native; inactive engines are ignored", () => {
  assert.equal(NATIVE.kind, "native");
  assert.equal(classifyTaxProvider([engine({ status: "Inactive" })]).kind, "unknown");
  assert.equal(EXTERNAL.kind, "external");
  assert.equal(MIXED.kind, "mixed");
  assert.equal(classifyTaxProvider([]).kind, "unknown");
  assert.equal(classifyTaxProvider(null).kind, "unknown");
});

/* 1 ── Native org → dashboard banner */

test("1. a Native Salesforce Tax org shows the dashboard banner with title, message, provider and expandable steps", () => {
  const html = banner(NATIVE);
  assert.match(html, new RegExp(NATIVE_TITLE));
  assert.match(html, /Provider: Native Salesforce Tax/);
  assert.match(html, /not automatically updated by an external tax provider/);
  assert.match(html, /Learn how to configure tax/);
  assert.match(html, /aria-expanded="false"/, "steps start collapsed");
  for (const s of NATIVE_STEPS) assert.ok(html.includes(s), `step present: ${s}`);
  assert.match(html, /Outdated or incomplete tax configuration can result in incorrect tax amounts\./);
  assert.match(html, /aria-label="Dismiss tax configuration notice"/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal/, "never a blocking modal");
  const open = banner(NATIVE, { defaultExpanded: true });
  assert.match(open, /aria-expanded="true"/);
});

test("1b. the banner links to Engine Readiness only when the existing readiness check reports a block", () => {
  assert.doesNotMatch(banner(NATIVE, { readiness: { blocked: false, detail: "ok" }, onOpenReadiness: () => {} }), /Engine Readiness reports/);
  const blocked = banner(NATIVE, { readiness: { blocked: true, detail: "Decision table is stale." }, onOpenReadiness: () => {} });
  assert.match(blocked, /Engine Readiness reports a problem:<\/b> Decision table is stale\./);
  assert.match(blocked, /Open Engine Readiness/);
});

test("1c. nothing renders while the provider is still loading (no provider is assumed)", () => {
  assert.equal(banner(null), "");
});

/* 2 ── Native config screens → contextual guidance */

test("2. Native configuration screens get a compact tip for Rate, Treatment, Item, Policy and Engine", () => {
  for (const key of ["tax-rates", "tax-treatments", "tax-treatment-items", "tax-policies", "tax-engines"]) {
    const html = render(h(TaxConfigHelp, { isDark: false, moduleKey: key, provider: NATIVE }));
    assert.match(html, /aria-label="How this tax configuration is used"/, key);
    assert.ok(html.includes(CONFIG_TIPS[key].replace(/"/g, "&quot;").replace(/'/g, "&#x27;")), key);
  }
  assert.equal(configTipText("tax-rates", NATIVE), RATE_REFRESH_TIP);
  assert.equal(render(h(TaxConfigHelp, { isDark: false, moduleKey: "geo-countries", provider: NATIVE })), "", "no tip on unrelated modules");
  const ws = src("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /<TaxConfigHelp isDark=\{isDark\} moduleKey=\{def\.key\} provider=\{provider\} \/>/);
});

/* 3 ── Transaction screens → compact icon */

test("3. transaction screens show the compact tax icon next to the tax amount", () => {
  const tip = render(h(TransactionTaxHelp, { isDark: false, provider: NATIVE }));
  assert.match(tip, /aria-label="How tax is calculated"/);
  assert.ok(tip.includes(TRANSACTION_NATIVE));

  const data = { record: { TotalTaxAmount: 180, TotalAmount: 1000 }, fields: { TotalTaxAmount: { label: "Total Tax Amount", type: "currency" }, TotalAmount: { label: "Total Amount", type: "currency" } }, references: {}, formattedCurrency: {}, currencyIsoCode: null };
  const sections = withSlotHelp([{ title: "Commercial", icon: "dollar-sign", slots: [{ label: "Total Amount", names: ["TotalAmount"] }, { label: "Total Tax Amount", names: ["TotalTaxAmount"] }] }], ["TotalTaxAmount"], h(TransactionTaxHelp, { isDark: false, provider: NATIVE }));
  const html = render(h(RecordFields, { isDark: false, data: data as never, sections }));
  assert.equal((html.match(/How tax is calculated/g) ?? []).length, 1, "exactly one icon, on the tax field only");
  assert.ok(html.indexOf("Total Tax Amount") < html.indexOf("How tax is calculated"));
  assert.ok(!html.includes(NATIVE_TITLE), "no full banner on transaction screens");

  assert.match(src("components/data/orders/OrderOverview.tsx"), /withSlotHelp\(SECTIONS, \["TotalTaxAmount"\], <TransactionTaxHelp/);
  assert.match(src("components/data/quotes/QuoteOverview.tsx"), /withSlotHelp\(SECTIONS, \["TotalTaxAmount", "Tax"\], <TransactionTaxHelp/);
  const detail = src("components/data/billing/BillingRecordDetail.tsx");
  assert.match(detail, /TAX_HELP_MODULES = new Set\(\["invoices", "billing-schedules"\]\)/);
  assert.match(detail, /TAX_HELP_MODULES\.has\(moduleKey\) && TAX_HELP_FIELD\.test\(f\.name\) && <TransactionTaxHelp/);
});

/* 4 ── External provider → no Native Tax instructions */

test("4. an external-provider org gets a provider note, not Native Tax setup instructions", () => {
  const html = banner(EXTERNAL);
  assert.match(html, /Tax provider: external/);
  assert.match(html, /AvaTax \(Avalara Provider\)/);
  assert.doesNotMatch(html, new RegExp(NATIVE_TITLE));
  for (const s of NATIVE_STEPS) assert.ok(!html.includes(s), `no native step: ${s}`);
  assert.ok(!configTipText("tax-rates", EXTERNAL)!.includes("Revenue Standard Tax Entries"));
  assert.match(transactionTaxText(EXTERNAL), /external tax engine .*AvaTax/);
});

test("4b. a mixed org shows Native guidance scoped to its native engines", () => {
  const html = banner(MIXED);
  assert.match(html, new RegExp(NATIVE_TITLE));
  assert.match(html, /these steps apply only to the native engine \(RST\)/);
});

/* 5 ── Unknown provider → neutral notice */

test("5. an unknown provider shows the neutral 'not verified' notice and never Native Tax instructions", () => {
  const html = banner(UNKNOWN_PROVIDER, { onOpenReadiness: () => {} });
  assert.match(html, new RegExp(UNKNOWN_TITLE.replace("/", "\\/")));
  assert.doesNotMatch(html, new RegExp(NATIVE_TITLE));
  assert.doesNotMatch(html, /Native Salesforce Tax/);
  assert.match(transactionTaxText(UNKNOWN_PROVIDER), /hasn't been verified/);
  assert.match(configTipText("tax-rates", UNKNOWN_PROVIDER)!, /hasn't been verified/);
  const ws = src("components/data/taxes/TaxesWorkspace.tsx");
  assert.match(ws, /summary\.data \? classifyTaxProvider\(summary\.data\.engines\) : summary\.error \? UNKNOWN_PROVIDER : null/, "a failed read is unknown, not native");
});

/* 6 ── Dismiss / reopen */

test("6. dismissal collapses the banner to a reopen control, keeps blocking diagnostics visible, and is stored per org", () => {
  const dismissed = banner(NATIVE, { defaultDismissed: true, readiness: { blocked: true, detail: "No TaxCode input." }, onOpenReadiness: () => {} });
  assert.match(dismissed, /aria-label="Show tax configuration help"/);
  assert.match(dismissed, /Tax provider: <b[^>]*>Native Salesforce Tax<\/b>/);
  assert.doesNotMatch(dismissed, /Learn how to configure tax/);
  assert.match(dismissed, /Engine Readiness reports a problem/, "a verified block is never suppressed by dismissal");

  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  assert.equal(readDismissed(storage, "orgA|u1"), false);
  writeDismissed(storage, "orgA|u1", true);
  assert.equal(readDismissed(storage, "orgA|u1"), true);
  assert.equal(readDismissed(storage, "orgB|u1"), false, "dismissal in one org doesn't hide it in another");
  writeDismissed(storage, "orgA|u1", false);
  assert.equal(readDismissed(storage, "orgA|u1"), false, "reopening clears the stored dismissal");
  assert.notEqual(dismissKey("a"), dismissKey("b"));
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(readDismissed(throwing, "x"), false);
  assert.doesNotThrow(() => writeDismissed(throwing, "x", true));
});

/* 7 ── Keyboard accessibility */

test("7. the info tip is a focusable button that opens on focus/tap, closes on Escape, and is linked for screen readers", () => {
  const closed = render(h(TaxInfoTip, { isDark: false, label: "Help", children: "Tip text" }));
  assert.match(closed, /<button type="button" aria-label="Help" aria-expanded="false" aria-describedby="([^"]+)"/);
  const id = /aria-describedby="([^"]+)"/.exec(closed)![1];
  assert.match(closed, new RegExp(`<span id="${id}" role="tooltip" hidden=""`), "text stays in the DOM (announced via aria-describedby) while hidden");
  const open = render(h(TaxInfoTip, { isDark: false, label: "Help", children: "Tip text", defaultOpen: true }));
  assert.match(open, /aria-expanded="true"/);
  assert.doesNotMatch(open, /hidden=""/);
  assert.equal(tipKeyAction("Escape", true), "close");
  assert.equal(tipKeyAction("Escape", false), null);
  assert.equal(tipKeyAction("Tab", true), null);
  const code = src("components/data/taxes/NativeTaxGuidance.tsx");
  assert.match(code, /onFocus=\{\(\) => setOpen\(true\)\}/, "opens on keyboard focus, not hover only");
  assert.match(code, /onClick=\{\(\) => setOpen\(true\)\}/, "opens on tap/click for touch");
  assert.match(code, /pointerdown/, "tapping elsewhere closes it");
});

/* 8 ── No tax behaviour changes; read-only */

test("8. the provider route is read-only and reuses the existing engine reader", () => {
  const route = src("app/api/taxes/provider/route.ts");
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|PUT|DELETE)/);
  assert.doesNotMatch(route, /mutates/);
  assert.match(route, /readEngines\(client, meta\)/);
  assert.match(route, /classifyTaxProvider/);
  const guidance = src("components/data/taxes/NativeTaxGuidance.tsx") + src("lib/taxes/provider.ts");
  assert.doesNotMatch(guidance, /quoteApi(Post|Patch|Delete)|method: "(POST|PATCH|DELETE)"/, "guidance never writes");
});
