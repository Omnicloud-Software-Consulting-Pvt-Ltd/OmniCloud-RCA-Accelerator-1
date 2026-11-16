/**
 * Asset Lifecycle UI — the four interconnected sections, sidebar wiring, the shared asset discovery component, the wizards and the
 * confirmation before every Salesforce write. Rendered with react-dom/server (no browser harness: effects / fetches don't run) and
 * asserted against source like the repo's other component tests. Nothing talks to Salesforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesforceSuccessProvider } from "@/components/notifications/SalesforceSuccessContext";
import AssetLifecycleWorkspace, { isLifecycleView } from "./AssetLifecycleWorkspace";
import LifecycleWizard, { ChangeEditor, FORM_SECTIONS, SALESFORCE_STEPS } from "./LifecycleWizard";
import { writeDetail } from "./TransactionDetail";
import { PromptResultPanel } from "./LifecyclePromptBox";
import { normalizeExtraction } from "@/lib/assetLifecycle/ai";
import type { AssetRow, LifecycleKind } from "@/lib/assetLifecycle/types";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const wrap = (el: ReturnType<typeof h>) => renderToStaticMarkup(h(SalesforceSuccessProvider, null, el));
const KINDS: LifecycleKind[] = ["amend", "renew", "cancel"];

const asset: AssetRow = {
  id: "02iA00000000001AAA", name: "Support", accountId: "001A00000000001AAA", accountName: "Acme", productId: "01tA00000000001AAA", productName: "Support", productCode: "SUP",
  hasLifecycle: true, lifecycleActions: 1, lastAction: { type: "Generate", category: "Initial Sale", subtype: null, date: "2026-01-01" }, quantity: 2, mrr: 100, currentAmount: 1200, totalAmount: 2400,
  lifecycleStart: "2026-01-01T00:00:00.000+0000", lifecycleEnd: "2027-12-31T23:59:59.000+0000", status: null, parentId: null, rootId: null, childIds: [],
  sellingModel: { id: "0jPA00000000001AAA", name: "Term Annual", type: "TermDefined", pricingTerm: 1, pricingTermUnit: "Annual" }, unitPrice: 50, discount: null, billingFrequency: "Annual",
  startDate: "2026-01-01", endDate: "2027-12-31", pricebookEntryId: "01uA00000000001AAA", pricebookId: "01sA00000000001AAA", originOrder: { id: "801A00000000001AAA", number: "00000001", contractId: null },
  contracts: [], usage: { usageBased: false, reason: null }, renewal: { term: 12, termUnit: "Months", autoRenew: false, pricingSource: null, uplift: null }, open: [], state: "active",
  eligibility: { amend: [], renew: [], cancel: [] },
};

/** The <button> whose text contains `label` — its opening tag says whether it's disabled. */
const buttonTag = (html: string, label: string) => html.split("<button").find(seg => seg.slice(0, seg.indexOf("</button>")).includes(label))?.split(">")[0] ?? null;
const isDisabled = (html: string, label: string) => { const tag = buttonTag(html, label); assert.ok(tag !== null, `button "${label}" rendered`); return / disabled=""/.test(tag!); };
const ADDR = { street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" };
const BILLING = { billToContactId: "003A00000000001AAA", billToContactName: "Pat Payer", billingAddress: ADDR, shippingAddress: { ...ADDR, street: "9 Dock Rd" } };
const aiOf = (kind: LifecycleKind, p: Partial<{ name: string; changes: { assetId: string; quantityChange: number; discount?: number | null; unitPrice?: number | null }[]; effectiveDate: string; renewal: { endDate: string | null; termMonths: number | null }; cancelReason: string }>) => ({
  engine: "rules" as const, kind, kindMismatch: false, extraction: normalizeExtraction({}),
  prefill: { name: p.name ?? null, account: { id: asset.accountId!, name: "Acme" }, contractId: null, contractNumber: null, assets: [asset], changes: p.changes ?? [], effectiveDate: p.effectiveDate ?? null, renewal: p.renewal ? { ...p.renewal, ramp: null } : null, cancelReason: p.cancelReason ?? null, billing: BILLING },
  fields: [], issues: [],
});

test("no redundant navigation: the sidebar is the only section navigation; dashboards keep Create / History / Browse; light + dark", () => {
  for (const dark of [false, true]) {
    for (const s of ["assets", "amend", "renew", "cancel"]) {
      const html = wrap(h(AssetLifecycleWorkspace, { isDark: dark, initialSection: s }));
      assert.match(html, /data-testid="asset-lifecycle-workspace"/);
      for (const label of ["Assets", "Amendments", "Renewals", "Cancellations"]) assert.ok(!html.includes(`</svg> ${label}</button>`), `${s}: no ${label} tab`);
      assert.doesNotMatch(html, /aria-pressed="true"/, `${s}: no section tab row`);
    }
  }
  const ws = src("components/data/assetLifecycle/AssetLifecycleWorkspace.tsx");
  assert.doesNotMatch(ws, /ToolbarButton|SECTIONS\.map|label="Dashboard"|label=\{meta\.create\}/, "no tab row and no Dashboard / History / Create header");
  assert.match(ws, /onSectionChange\?\.\(s\)/, "moving to another section re-highlights the sidebar");
  const dash = src("components/data/assetLifecycle/LifecycleDashboard.tsx");
  for (const w of ['workflow: "create"', 'workflow: "history"', 'workflow: "assets"', 'workflow: "amend"', 'workflow: "renew"', 'workflow: "cancel"']) assert.ok(dash.includes(w), `dashboard keeps ${w}`);
  assert.equal(isLifecycleView("renew"), true);
  assert.equal(isLifecycleView("nope"), false);
});

test("each lifecycle is ONE page: every section visible together, no step indicators or Next / Back, prompt at the top", () => {
  for (const kind of KINDS) {
    const html = wrap(h(LifecycleWizard, { isDark: false, kind, onSaved: () => {}, onCancel: () => {} }));
    assert.match(html, /data-form="single-page"/);
    for (const s of FORM_SECTIONS[kind]) assert.ok(html.includes(s), `${kind}: section ${s}`);
    assert.doesNotMatch(html, /Step \d|>Next<|>Back<|\d\. Account/, `${kind}: no steps`);
    assert.ok(html.indexOf('data-testid="lifecycle-prompt"') < html.indexOf(FORM_SECTIONS[kind][0]), `${kind}: prompt above the form`);
    for (const l of ["Contract", "Opportunity", "Name", "Effective date"]) assert.match(html, new RegExp(`aria-label="${l}"`), `${kind}: ${l}`);
    assert.ok(SALESFORCE_STEPS.every(s => html.includes(s.replace("&", "&amp;"))), `${kind}: what happens in Salesforce afterwards`);
    assert.ok(isDisabled(html, "Save &amp; create in Salesforce…"), `${kind}: nothing to send yet`);
    assert.match(html, /Choose an account and at least one asset/);
  }
  assert.match(wrap(h(LifecycleWizard, { isDark: false, kind: "renew", onSaved: () => {}, onCancel: () => {} })), /aria-label="Term months"/);
  assert.match(wrap(h(LifecycleWizard, { isDark: false, kind: "cancel", onSaved: () => {}, onCancel: () => {} })), /aria-label="Cancellation reason"/);
});

test("prompt → fields: a parsed prompt fills the SAME form fields manual entry uses, and the preview shows the whole request", () => {
  const amend = wrap(h(LifecycleWizard, { isDark: false, kind: "amend", onSaved: () => {}, onCancel: () => {}, prefill: { account: null, assets: [], ai: aiOf("amend", { name: "Support increase", changes: [{ assetId: asset.id, quantityChange: 2, discount: 10 }], effectiveDate: "2026-12-01" }) } }));
  for (const re of [/aria-label="Name"[^>]*value="Support increase"/, /aria-label="Quantity change for Support"[^>]*value="2"/, /aria-label="Discount for Support"[^>]*value="10"/, /aria-label="Effective date"[^>]*value="2026-12-01"/]) assert.match(amend, re);
  assert.match(amend, /data-testid="selected-assets"/);
  assert.match(amend, /Add or change assets/, "asset search folds away once the prompt chose the assets");
  assert.match(amend, /Result: 4/);
  for (const s of ["Acme", "2026-12-01", "+2", "−10%", "The plan is valid", "Show the exact Salesforce request"]) assert.ok(amend.includes(s), `amend preview: ${s}`);
  assert.equal(isDisabled(amend, "Save &amp; create in Salesforce…"), false, "valid plan can be sent (after its confirmation)");

  const renew = wrap(h(LifecycleWizard, { isDark: false, kind: "renew", onSaved: () => {}, onCancel: () => {}, prefill: { account: null, assets: [], ai: aiOf("renew", { effectiveDate: "2028-01-01", renewal: { endDate: null, termMonths: 12 } }) } }));
  assert.match(renew, /aria-label="Term months"[^>]*value="12"/);
  assert.match(renew, /aria-label="Effective date"[^>]*value="2028-01-01"/);
  assert.match(renew, /Renewal window/);
  assert.match(renew, /2028-01-01 → 2028-12-31/, "preview shows the computed renewal window");

  const cancel = wrap(h(LifecycleWizard, { isDark: false, kind: "cancel", onSaved: () => {}, onCancel: () => {}, prefill: { account: null, assets: [], ai: aiOf("cancel", { effectiveDate: "2026-12-01", cancelReason: "Budget" }) } }));
  assert.match(cancel, /aria-label="Cancellation reason"[^>]*value="Budget"/);
  assert.match(cancel, /aria-label="Effective date"[^>]*value="2026-12-01"/);
  for (const s of ["Cancellation date", "Budget", "The plan is valid"]) assert.ok(cancel.includes(s), `cancel preview: ${s}`);

  // Manual entry (e.g. "Amend" on an asset page) lands on the same fields with nothing parsed.
  const manual = wrap(h(LifecycleWizard, { isDark: false, kind: "amend", onSaved: () => {}, onCancel: () => {}, prefill: { account: { id: asset.accountId!, name: "Acme" }, assets: [asset] } }));
  assert.match(manual, /aria-label="Quantity change for Support"[^>]*value="0"/);
  assert.match(manual, /data-testid="selected-assets"/);
  const ws = src("components/data/assetLifecycle/LifecycleWizard.tsx");
  assert.doesNotMatch(ws, /setStep|useState\(\s*locked \? 2/, "no step state left");
  assert.match(ws, /function applyAi[\s\S]*setChanges[\s\S]*setEffectiveDate/, "the prompt writes the shared form state");
});

test("validation on the single page: an asset held by a Draft order blocks sending; Save & create opens the one execution confirmation", () => {
  const held: AssetRow = { ...asset, eligibility: { amend: [{ code: "OPEN_TRANSACTION", severity: "error", message: "Support already has an open Amend quote 00000099 (order 00000123 Draft, not activated)." }], renew: [], cancel: [] } };
  const html = wrap(h(LifecycleWizard, { isDark: false, kind: "amend", onSaved: () => {}, onCancel: () => {}, prefill: { account: { id: asset.accountId!, name: "Acme" }, assets: [held] } }));
  assert.match(html, /Fix before sending to Salesforce/);
  assert.match(html, /order 00000123 Draft, not activated/);
  assert.ok(isDisabled(html, "Save &amp; create in Salesforce…"));
  assert.match(html, /Blocked · open transaction/, "the selected asset shows why");
  // Partial cancellation is redirected to an amendment, never sent as initiateCancellation.
  assert.match(src("components/data/assetLifecycle/LifecycleWizard.tsx"), /cancelMode === "partial" \? \["A partial cancellation is an amendment/);
  // Execution: the form only saves; the transaction page opens its confirmation (nothing runs unconfirmed).
  assert.match(src("components/data/assetLifecycle/LifecycleWizard.tsx"), /onSaved\(res\.transaction\.id, \{ execute \}\)/);
  assert.match(src("components/data/assetLifecycle/AssetLifecycleWorkspace.tsx"), /autoExecute: !!o\?\.execute/);
  assert.match(src("components/data/assetLifecycle/TransactionDetail.tsx"), /useState\(!!autoExecute\)/);
});

test("the amendment change editor offers quantity, price, discount, billing frequency, end date and upgrade / downgrade / swap (where available)", () => {
  const html = wrap(h(ChangeEditor, { isDark: false, asset, change: { assetId: asset.id, quantityChange: 3 }, onChange: () => {}, billingFrequencies: [{ value: "Monthly", label: "Monthly" }], features: { rampedRenewal: true, startDateAdjustment: true, lineDiscount: true, attributeChanges: false, upgrade: true, downgrade: true, swap: true } }));
  for (const l of ["Quantity change for Support", "Unit price for Support", "Discount for Support", "Billing frequency for Support", "End date for Support"]) assert.ok(html.includes(`aria-label="${l}"`), l);
  assert.match(html, /Result: 5/);
  for (const m of ["Change", "Upgrade", "Downgrade", "Swap"]) assert.ok(html.includes(`>${m}</button>`), m);
  const noSwap = wrap(h(ChangeEditor, { isDark: false, asset, change: { assetId: asset.id, quantityChange: 0 }, onChange: () => {}, billingFrequencies: [], features: { rampedRenewal: true, startDateAdjustment: true, lineDiscount: true, attributeChanges: false, upgrade: true, downgrade: false, swap: false } }));
  assert.ok(noSwap.includes(">Upgrade</button>") && !noSwap.includes(">Downgrade</button>") && !noSwap.includes(">Swap</button>"), "replacement modes only where the org has the API");
});

test("sidebar: an Asset Lifecycle group opens the workspace at each section; the old Amendments module and placeholder tiles are gone", () => {
  const page = src("app/data/page.tsx");
  assert.match(page, /id: "lifecycle",\s*\n\s*label: "Asset Lifecycle"/);
  for (const [id, s] of [["assets", "assets"], ["amendments", "amend"], ["renewals", "renew"], ["cancellations", "cancel"]]) assert.ok(page.includes(`{ id: "${id}", label: `) && page.includes(`lifecycleSection: "${s}"`), id);
  assert.match(page, /selectedObj\.groupId === "lifecycle" \? \(\s*<AssetLifecycleWorkspace key=\{lifecycleNav\}[^>]*onSectionChange=\{handleLifecycleSectionChange\}/, "sidebar remounts on click; in-module section moves only re-highlight");
  assert.doesNotMatch(page, /AmendmentsWorkspace|amendmentView|groupId: "amendments"/);
  assert.doesNotMatch(page, /badge: "198"|"renewal-forecast"|"process-renewal"/, "illustrative Assets / Renewals tiles replaced by the live module");
  for (const p of ["components/data/amendments", "lib/amendments", "app/api/amendments"]) assert.equal(existsSync(join(process.cwd(), p)), false, `${p} removed`);
});

test("one shared asset discovery component; the UI is wired to server routes only (no mock data, browser storage or hard-coded Ids)", () => {
  const ws = src("components/data/assetLifecycle/AssetLifecycleWorkspace.tsx");
  const wiz = src("components/data/assetLifecycle/LifecycleWizard.tsx");
  assert.match(ws, /<AssetExplorer /, "Assets section uses AssetExplorer");
  assert.match(wiz, /<AssetExplorer isDark=\{isDark\} kind=\{kind\}/, "every lifecycle wizard selects through the same AssetExplorer");
  for (const f of ["app/api/assets/route.ts", "app/api/assets/[id]/route.ts", "app/api/assets/lookup/route.ts", "app/api/assets/reference/search/route.ts", "app/api/asset-lifecycle/route.ts", "app/api/asset-lifecycle/[id]/route.ts", "app/api/asset-lifecycle/[id]/step/route.ts"]) assert.ok(existsSync(join(process.cwd(), f)), f);
  for (const file of ["AssetExplorer", "AssetDetail", "LifecycleWizard", "TransactionDetail", "LifecycleDashboard", "AssetLifecycleWorkspace"]) {
    const s = src(`components/data/assetLifecycle/${file}.tsx`);
    assert.doesNotMatch(s, /fakeLifecycleOrg|localStorage|\b0[0-9A-Za-z]{2}[A-Za-z0-9]{12}AAA\b|my\.salesforce\.com/, `${file}: no fake org, browser storage, hard-coded Ids or org URLs`);
  }
});

test("prompt entry sits in every lifecycle wizard (and the Assets section); its result shows sources, issues and real candidates", () => {
  for (const kind of KINDS) {
    const html = wrap(h(LifecycleWizard, { isDark: false, kind, onSaved: () => {}, onCancel: () => {} }));
    assert.match(html, /data-testid="lifecycle-prompt"/, kind);
    assert.match(html, /aria-label="Lifecycle request prompt"/);
    assert.match(html, /Parse &amp; preview/);
  }
  const result = {
    engine: "rules" as const, kind: "amend" as const, kindMismatch: false, extraction: normalizeExtraction({}),
    prefill: { name: null, account: null, contractId: null, contractNumber: null, assets: [], changes: [], effectiveDate: null, renewal: null, cancelReason: null },
    fields: [{ label: "Account", value: "Acme", source: "salesforce" as const }, { label: "Discount", value: "10%", source: "prompt" as const }],
    issues: [{ field: "Asset \"Laptop\"", status: "ambiguous" as const, message: "matches 2 assets", candidates: [{ id: "02iA00000000001AAA", name: "Laptop", detail: "qty 6" }] }],
  };
  const panel = wrap(h(PromptResultPanel, { isDark: false, result, onCandidate: () => {}, onDismiss: () => {} }));
  for (const s of ["from Salesforce", "from your prompt", "Built-in rules (no AI key)", "1 to resolve", "Laptop · qty 6"]) assert.ok(panel.includes(s), s);
  assert.match(src("components/data/assetLifecycle/AssetLifecycleWorkspace.tsx"), /<AssetsPrompt /);
  assert.match(src("components/data/assetLifecycle/LifecycleWizard.tsx"), /label="Save & create in Salesforce…"/);
});

test("one-click execution: one primary control (no per-step Run buttons), confirmed once; activation has its own dialog + server flag", () => {
  const ui = src("components/data/assetLifecycle/TransactionDetail.tsx");
  assert.doesNotMatch(ui, /"Run…"|label=\{running === s\.id/, "per-step Run buttons are gone");
  assert.match(ui, /"Execute lifecycle…"/);
  assert.match(ui, /"Resume execution…"/);
  assert.match(ui, /Retry from "\$\{next\.label\}"…/);
  assert.match(ui, /label="Confirm and send to Salesforce" icon="send" onClick=\{\(\) => void execute\(target\)\}/, "nothing runs until the execution dialog is confirmed");
  assert.match(ui, /label="Activate order \(irreversible\)"/);
  assert.match(ui, /activation\.resolve\(false\)/);
  assert.match(ui, /\{ step, \.\.\.o \}/, "sends confirmed + activationConfirmed exactly as the executor decided");
  assert.match(src("lib/assetLifecycle/server/lifecycle.ts"), /next\.id === "activate" && !opts\.activationConfirmed\) throw/);
  assert.match(src("app/api/asset-lifecycle/[id]/step/route.ts"), /activationConfirmed: body\.activationConfirmed === true/);
  for (const kind of KINDS) for (const step of ["initiate", "apply-changes", "price", "create-order", "activate"] as const) assert.ok(writeDetail(kind, step).length > 40, `${kind}/${step} confirmation text`);
  assert.match(writeDetail("cancel", "initiate"), /initiateCancellation/);
  assert.match(writeDetail("renew", "activate"), /can't be undone/);
  assert.match(src("lib/assetLifecycle/server/lifecycle.ts"), /if \(next\.writes && !confirmed\) throw/);
  assert.match(src("app/api/asset-lifecycle/[id]/step/route.ts"), /body\.confirmed === true/);
});

test("billing contact and addresses: a section of every form, filled from the prompt, required before Save & create, shown in the preview", () => {
  for (const kind of KINDS) {
    const html = wrap(h(LifecycleWizard, { isDark: false, kind, onSaved: () => {}, onCancel: () => {}, prefill: { account: { id: asset.accountId!, name: "Acme" }, assets: [asset] } }));
    assert.match(html, /data-testid="billing-details"/, kind);
    for (const l of ["Search contacts", "Bill-To Contact", "Billing address from Salesforce", "Billing street", "Billing city", "Billing country", "Shipping street"]) assert.ok(html.includes(`aria-label="${l}"`), `${kind}: ${l}`);
    assert.match(html, /Choose the Bill-To Contact \(a contact of the account\)/, `${kind}: required before sending`);
    assert.ok(isDisabled(html, "Save &amp; create in Salesforce…"), `${kind}: blocked without billing details`);
  }
  const filled = wrap(h(LifecycleWizard, { isDark: false, kind: "cancel", onSaved: () => {}, onCancel: () => {}, prefill: { account: null, assets: [], ai: aiOf("cancel", { effectiveDate: "2026-12-01", cancelReason: "Budget" }) } }));
  for (const re of [/aria-label="Billing street"[^>]*>1 Main St</, /aria-label="Billing city"[^>]*value="Springfield"/, /aria-label="Shipping street"[^>]*>9 Dock Rd</]) assert.match(filled, re);
  for (const t of ["Bill-To Contact", "Pat Payer", "1 Main St, Springfield, IL, 62701, US", "From your prompt"]) assert.ok(filled.includes(t), `preview / source: ${t}`);
  assert.equal(isDisabled(filled, "Save &amp; create in Salesforce…"), false);
  const wiz = src("components/data/assetLifecycle/LifecycleWizard.tsx");
  assert.match(wiz, /billing,\n\s*\}\);/, "the billing details are saved with the plan");
  assert.match(wiz, /type=billing-details&accountId=/, "contacts and addresses are loaded for the selected account");
});

test("billing readiness on the transaction page: popup with real records + an explicit review of the Salesforce updates; activation stays separate", () => {
  const ui = src("components/data/assetLifecycle/TransactionDetail.tsx");
  assert.match(ui, /resolveNeeds: current => new Promise/, "the executor opens the popup and resumes after the decision");
  assert.match(ui, /<BillingNeedsDialog /);
  assert.match(ui, /data-testid="billing-readiness"/);
  assert.match(ui, /Billing readiness \(read back from Salesforce\)/, "the activation dialog shows what billing readiness confirmed");
  assert.match(ui, /label="Activate order \(irreversible\)"/);
  const dlg = src("components/data/assetLifecycle/BillingNeedsDialog.tsx");
  for (const t of ["Review updates…", "Confirm updates & continue", "This is a PRODUCT setting", "Only this order product changes", "not eligible", "confirmed: true"]) assert.ok(dlg.includes(t), t);
  assert.match(src("app/api/asset-lifecycle/[id]/billing/route.ts"), /if \(body\.confirmed !== true\) throw/);
  assert.match(writeDetail("amend", "prepare-billing"), /Never activates/);
  assert.match(writeDetail("renew", "prepare-billing"), /pricingPref Force/);
});
