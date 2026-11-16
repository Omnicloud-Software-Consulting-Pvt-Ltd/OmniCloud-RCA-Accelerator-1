/**
 * Secondary/diagnostic content hidden by default (AI analysis, Salesforce configuration notes, non-blocking warnings, resolved-record
 * detail, technical payloads) — while blocking/actionable errors and outcome failures stay visible. Components render through
 * react-dom/server (this repo has no JSDOM harness), interaction state through the pure helpers, and screen wiring is asserted
 * against source like the repo's other component tests.
 *
 * Run: `npx tsx --test components/ui/Disclosure.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure, DISCLOSURE_LABELS, WarningsDisclosure, ConfigNotesDisclosure } from "./Disclosure";
import { CodeBlock, Section } from "@/components/data/quotes/shared";
import { isBlockingWarning, splitWarnings } from "@/lib/ui/diagnostics";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const regionOf = (html: string) => /<div id="([^"]+)" role="region"[^>]*hidden=""[^>]*>([\s\S]*?)<\/div><\/div>$/.exec(html);

/* ── which warnings may be hidden ── */

test("outcome failures (create/save/activate/deploy not done or not confirmed) are never hidden", () => {
  for (const w of [
    "Could not activate the Expression Set Version — its Id wasn't resolved after deploy. It remains in Draft state.",
    "Schedule activation failed: INVALID_FIELD.",
    "Activation was requested, but Salesforce read-back did not confirm an active IsActive — the procedure remains inactive.",
    "PriceAdjustmentSchedule has no IsActive field on this org — the schedule could not be activated programmatically.",
    "Generated BundleDiscount step has no output parameter — Salesforce may reject a step that publishes nothing.",
    "Price NOT saved: STANDARD_PRICE_NOT_DEFINED",
  ]) assert.equal(isBlockingWarning(w), true, w);
});

test("diagnostics, preflight and explanatory notes are hideable", () => {
  for (const w of [
    "Could not discover category-inherited product attributes: timeout",
    "Donor inventory (diagnostic-only) failed: 500 — this does not affect the actual build below.",
    "Org-wide uniqueness pre-flight could not complete: timeout — proceeding.",
    "No tier is open-ended (upperBound: null) — the last band should normally have no upper limit.",
    "The tax code was inferred from the treatment.",
  ]) assert.equal(isBlockingWarning(w), false, w);
  const { visible, hidden } = splitWarnings(["Schedule activation failed: X", "Just a note", 42]);
  assert.deepEqual(visible, ["Schedule activation failed: X"]);
  assert.deepEqual(hidden, ["Just a note", 42]);
});

/* ── shared components: hidden by default, accessible, discoverable ── */

test("inline Disclosure: collapsed by default, labelled toggle with aria-expanded/aria-controls, content kept in a hidden region", () => {
  const html = render(h(Disclosure, { isDark: false, label: DISCLOSURE_LABELS.ai, count: 3, children: "Secret analysis" }));
  assert.match(html, /<button type="button" aria-expanded="false" aria-controls="([^"]+)"/);
  const id = /aria-controls="([^"]+)"/.exec(html)![1];
  assert.match(html, new RegExp(`<div id="${id}" role="region" aria-label="View AI Analysis Details" hidden=""`));
  assert.match(html, /View AI Analysis Details/);
  assert.match(html, />3</, "count shown so hidden content is discoverable");
});

test("card Disclosure uses the app's accordion (Section) collapsed: label + toggle only, no content", () => {
  const html = render(h(Disclosure, { isDark: true, variant: "card", label: DISCLOSURE_LABELS.config, children: "Assumption text" }));
  assert.match(html, /View Salesforce Configuration Notes/);
  assert.match(html, /<button type="button" aria-expanded="false" aria-controls="[^"]+"/);
  assert.doesNotMatch(html, /Assumption text/);
});

test("Section is now accessible (type=button, aria-expanded, aria-controls → region) and still opens by default where it did", () => {
  const html = render(h(Section, { isDark: false, title: "Details", icon: "info", children: "Body" }));
  const id = /aria-expanded="true" aria-controls="([^"]+)"/.exec(html)?.[1];
  assert.ok(id, html.slice(0, 300));
  assert.match(html, new RegExp(`<div id="${id}" role="region" aria-label="Details"`));
  assert.match(html, /Body/);
});

test("WarningsDisclosure: blocking warning stays visible; the rest are hidden behind 'View Warnings & Diagnostics (n)'", () => {
  const html = render(h(WarningsDisclosure, { isDark: false, warnings: ["Schedule activation failed: X", "Discovery note A", "Discovery note B"] }));
  const visiblePart = html.split("<button")[0];
  assert.match(visiblePart, /role="alert"[\s\S]*Schedule activation failed: X/);
  assert.doesNotMatch(visiblePart, /Discovery note/);
  assert.match(html, /View Warnings &amp; Diagnostics/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /hidden=""[^>]*>[\s\S]*Discovery note A[\s\S]*Discovery note B/);
  assert.match(html, />2</, "badge counts only the hidden ones");
  assert.equal(render(h(WarningsDisclosure, { isDark: false, warnings: [] })), "");
});

test("ConfigNotesDisclosure hides assumptions behind 'View Salesforce Configuration Notes (n)'", () => {
  const html = render(h(ConfigNotesDisclosure, { isDark: true, notes: ["Billing Treatment Item is required by Salesforce"] }));
  assert.match(html, /View Salesforce Configuration Notes/);
  assert.match(html, /hidden=""[^>]*>[\s\S]*required by Salesforce/);
  assert.equal(render(h(ConfigNotesDisclosure, { isDark: true, notes: [] })), "");
  assert.ok(regionOf(html) || /hidden=""/.test(html));
});

test("CodeBlock (technical payloads) is hidden by default app-wide; explicit toggles/tabs pass `open`/`defaultExpanded`", () => {
  const hidden = render(h(CodeBlock, { isDark: false, data: { secretPayloadKey: 1 } }));
  assert.doesNotMatch(hidden, /secretPayloadKey/);
  assert.doesNotMatch(hidden, /<pre/);
  assert.match(hidden, /Show payload &amp; technical details/);
  assert.match(hidden, /aria-expanded="false"/);
  assert.match(render(h(CodeBlock, { isDark: false, data: { k: 1 }, open: true })), /<pre[\s\S]*&quot;k&quot;|<pre[\s\S]*k/);
  assert.match(render(h(CodeBlock, { isDark: false, data: { k: 1 }, defaultExpanded: true })), /<pre/);
});

/* ── screens: wiring ── */

const BILLING_CREATE = "components/data/billing/BillingCreateWorkspace.tsx";

test("no screen renders the always-open 'AI Analysis Complete' panel any more", () => {
  for (const f of [BILLING_CREATE, "components/data/billing/BillingEditWorkspace.tsx"]) assert.doesNotMatch(src(f), /title="AI Analysis Complete"/, f);
});

test("Billing/Tax record create (Policy, Treatment, Treatment Item, Tax Rate…): AI analysis, assumptions, warnings and resolved records collapsed; actionable errors visible", () => {
  const code = src(BILLING_CREATE);
  assert.match(code, /<Disclosure isDark=\{isDark\} variant="card" icon="cpu" label=\{DISCLOSURE_LABELS\.ai\}>/);
  assert.match(code, /<ConfigNotesDisclosure isDark=\{isDark\} notes=\{analysis\.assumptions\} \/>/);
  assert.match(code, /<WarningsDisclosure isDark=\{isDark\} warnings=\{analysis\.warnings\} \/>/);
  assert.match(code, /label=\{DISCLOSURE_LABELS\.records\}/);
  // unresolved lookups ("X was not found … pick one / create it") are rendered BEFORE (outside) the AI-details disclosure
  assert.ok(code.indexOf("was not found.") < code.indexOf("label={DISCLOSURE_LABELS.ai}"), "unresolved-reference errors must stay visible");
  // blocking validation errors visible, warnings collapsed
  assert.match(code, /<IssueList isDark=\{isDark\} issues=\{validation\.issues\.filter\(i => i\.severity === "error"\)\}/);
  assert.match(code, /formBlockers\.map/, "form blockers still shown");
  // Analyze & Verify never opens it: no defaultOpen / forced-open state on the disclosure
  assert.doesNotMatch(code, /<Disclosure[^>]*defaultOpen/);
  // the existing payload toggle is preserved
  assert.match(code, /Show payload & technical details/);
});

test("Billing Edit / Assign, Payments, Credit & Debit Memos, Tax assistant + create: warnings and AI detail behind disclosures, ✗ errors untouched", () => {
  const files = [
    "components/data/billing/BillingEditWorkspace.tsx", "components/data/billing/BillingAssignWorkspace.tsx",
    "components/data/billing/BillingPaymentsWorkspace.tsx", "components/data/billing/BillingCreditMemosWorkspace.tsx",
    "components/data/billing/BillingDebitMemosWorkspace.tsx", "components/data/billing/tax/TaxAssistant.tsx", "components/data/billing/tax/TaxCreate.tsx",
  ];
  for (const f of files) {
    const code = src(f);
    assert.match(code, /<WarningsDisclosure /, f);
    assert.doesNotMatch(code, /warnings\.map\(\(w, i\) => <(span|div) key=\{i\} style=\{\{ color: t\.warn \}\}>⚠/, f);
  }
  assert.match(src("components/data/billing/BillingPaymentsWorkspace.tsx"), /pv\.errors\.map\(\(e, i\) => <div key=\{i\} style=\{\{ color: t\.error, fontWeight: 600 \}\}>✗/);
  assert.match(src("components/data/billing/BillingAssignWorkspace.tsx"), /\[ai\.product\.message, ai\.policy\.message\][\s\S]*✗ \{m\}/);
  assert.match(src("components/data/billing/tax/TaxCreate.tsx"), /interp\.missing\.length > 0 && <Notice isDark=\{isDark\} tone="warn">Missing:/);
  assert.match(src("components/data/billing/BillingDebitMemosWorkspace.tsx"), /can&apos;t be undone/, "irreversible-action notice stays visible");
});

test("Pricing Procedures, Products, Orders, Quotes, Contracts: warnings/notes/field mapping collapsed", () => {
  for (const k of ["Attribute", "Bundle", "Tier", "Volume"]) {
    const code = src(`components/data/pricing-rules/${k}BasedPricingCreate.tsx`);
    assert.doesNotMatch(code, /result\.warnings\.map/, k);
    assert.equal((code.match(/<WarningsDisclosure isDark=\{isDark\} warnings=\{result\.warnings \?\? \[\]\} \/>/g) ?? []).length, 2, k);
  }
  for (const f of ["components/metadata/RCProductWorkspace.tsx", "components/metadata/multi/MultiProductWorkspace.tsx"]) {
    assert.match(src(f), /<Disclosure isDark=\{isDark\} label=\{`\$\{DISCLOSURE_LABELS\.ai\} — field mapping`\} icon="cpu">\s*<FieldMappingTable/, f);
  }
  for (const [f, v] of [["components/data/orders/CreateOrderFlow.tsx", "orderWarnings"], ["components/data/quotes/CreateQuoteFlow.tsx", "quoteWarnings"], ["components/data/contracts/CreateContractFlow.tsx", "contractWarnings"]]) {
    assert.match(src(f), new RegExp(`<WarningsDisclosure isDark=\\{isDark\\} warnings=\\{${v}\\} />`), f);
  }
});

test("no component maps warnings/assumptions straight onto the screen (everything goes through the shared disclosures)", () => {
  const files = [
    BILLING_CREATE, "components/data/billing/BillingEditWorkspace.tsx", "components/data/billing/BillingAssignWorkspace.tsx",
    "components/data/billing/BillingPaymentsWorkspace.tsx", "components/data/billing/BillingCreditMemosWorkspace.tsx",
    "components/data/billing/BillingDebitMemosWorkspace.tsx", "components/data/billing/tax/TaxAssistant.tsx", "components/data/billing/tax/TaxCreate.tsx",
    "components/data/products/ProductConfigViews.tsx", "components/data/taxes/CalculationPlanView.tsx",
    "components/data/orders/CreateOrderFlow.tsx", "components/data/quotes/CreateQuoteFlow.tsx", "components/data/contracts/CreateContractFlow.tsx",
  ];
  for (const f of files) assert.doesNotMatch(src(f), /(warnings|assumptions|Warnings|notes)\??\.map\(/, f);
});

test("payloads already behind an explicit toggle open without a second click", () => {
  const gated = src("components/data/billing/BillingCreateWorkspace.tsx");
  assert.match(gated, /\{showTechnical && \([\s\S]*<CodeBlock open isDark=\{isDark\} data=\{\{ draft/);
  for (const f of ["components/data/billing/BillingOrderSetup.tsx", "components/data/billing/BillingRecordDetail.tsx", "components/data/billing/BillingEditWorkspace.tsx"]) {
    assert.match(src(f), /<CodeBlock open /, f);
  }
});
