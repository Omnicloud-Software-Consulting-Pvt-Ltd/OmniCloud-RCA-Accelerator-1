import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MODULE_GUIDES, moduleGuideKeyFor, getModuleGuide } from "@/lib/help/moduleGuides";
import { getFieldHelp, normalizeFieldKey } from "@/lib/help/fieldHelp";
import { BILLING_MODULES } from "@/lib/billing/registry";
import { TAX_MODULES } from "@/lib/taxes/modules";
import { REVENUE_CORE_MODULES, REVENUE_CORE_KPIS, kpiValue } from "@/lib/revenueCore/modules";

const page = fs.readFileSync(path.join(process.cwd(), "app/data/page.tsx"), "utf8");

test("every /data sidebar item resolves to a module introduction", () => {
  // Full-form sidebar entries (id, label, icon, groupId). Billing/Taxes items are generated compactly and resolve through
  // the workspace's active module — covered by the next test.
  const ids = [...page.matchAll(/^\s+id: "([a-z-]+)",\n\s+label: "[^"]+",\n\s+icon: "[^"]+",\n\s+groupId: "([a-z]+)"/gm)];
  assert.ok(ids.length >= 15, `found sidebar items (${ids.length})`);
  for (const [, id, groupId] of ids) assert.ok(moduleGuideKeyFor({ itemId: id, groupId }), `no intro for sidebar item "${id}"`);
  // Compact (generated) Asset Lifecycle entries — Assets, Amendments, Renewals, Cancellations.
  const lifecycle = [...page.matchAll(/\{ id: "([a-z-]+)", label: "[^"]+", icon: "[^"]+", lifecycleSection: "[a-z]+" \}/g)].map(m => m[1]);
  assert.deepEqual(lifecycle, ["assets", "amendments", "renewals", "cancellations"]);
  for (const id of lifecycle) assert.ok(moduleGuideKeyFor({ itemId: id, groupId: "lifecycle" }), `no intro for sidebar item "${id}"`);
});

test("every Billing and Taxes module and view has an introduction", () => {
  for (const m of BILLING_MODULES) assert.ok(getModuleGuide(moduleGuideKeyFor({ itemId: "billing", groupId: "billing", billingModule: m.key })), `billing ${m.key}`);
  for (const k of [null, "payments", "credit-memos", "debit-memos", "tax"]) assert.ok(moduleGuideKeyFor({ itemId: "billing", groupId: "billing", billingModule: k }), `billing ${k}`);
  for (const v of ["assign", "product", "order"]) assert.equal(moduleGuideKeyFor({ itemId: "billing", groupId: "billing", billingView: v }), `billing-${v}`);
  for (const m of TAX_MODULES) assert.ok(moduleGuideKeyFor({ itemId: "taxes", groupId: "taxes", taxesKey: m.key }), `tax ${m.key}`);
  for (const v of ["dashboard", "configure", "calculation", "readiness"]) assert.ok(moduleGuideKeyFor({ itemId: "taxes", groupId: "taxes", taxesKey: v }), `taxes view ${v}`);
});

test("sub-views pick the matching introduction", () => {
  assert.equal(moduleGuideKeyFor({ itemId: "products", groupId: "core", subView: "choose-type" }), "product-create");
  assert.equal(moduleGuideKeyFor({ itemId: "products", groupId: "core", subView: "configuration" }), "product-configuration");
  assert.equal(moduleGuideKeyFor({ itemId: "bundles", groupId: "revenue", subView: "components" }), "bundle-components");
  assert.equal(moduleGuideKeyFor({ itemId: "attributes", groupId: "revenue", subView: "create" }), "attribute-create");
  assert.equal(moduleGuideKeyFor({ itemId: "revenue-core", groupId: "revenue" }), "revenue-core");
});

test("every guide answers all the beginner questions", () => {
  for (const [key, g] of Object.entries(MODULE_GUIDES)) {
    for (const f of ["title", "summary", "why", "where"] as const) assert.ok(g[f].trim(), `${key}.${f}`);
    for (const f of ["how", "prerequisites", "next", "connects"] as const) assert.ok(g[f].length > 0, `${key}.${f}`);
  }
});

test("field help resolves by object override, API name and label", () => {
  assert.equal(normalizeFieldKey("Base Price ($)"), "baseprice");
  assert.match(getFieldHelp({ apiName: "Rate", sobject: "TaxRate" })!.text, /tax percentage/);
  assert.match(getFieldHelp({ apiName: "Rate" })!.text, /rate/i);
  assert.ok(getFieldHelp({ label: "Tax Code *" }));
  assert.ok(getFieldHelp({ label: "Tax Policy (name)" }), "label → <label>Id fallback");
  assert.ok(getFieldHelp({ label: "Product Name *" }));
  assert.ok(getFieldHelp({ apiName: "DefaultBillingTreatmentId" }));
  assert.equal(getFieldHelp({ label: "Totally Unknown Field" }), null);
});

test("Revenue Cloud Core KPIs never fabricate numbers", () => {
  const keys = new Set(REVENUE_CORE_MODULES.map(m => m.key));
  for (const k of REVENUE_CORE_KPIS) assert.ok(keys.has(k.moduleKey), k.label);
  assert.equal(new Set(REVENUE_CORE_MODULES.map(m => m.key)).size, REVENUE_CORE_MODULES.length, "unique keys");
  assert.equal(kpiValue(undefined, "total"), null);
  assert.equal(kpiValue({ available: false, recordCount: 5, statusBreakdown: null }, "total"), null);
  assert.equal(kpiValue({ available: true, recordCount: null, statusBreakdown: null }, "total"), null, "failed count stays unavailable");
  const s = { available: true, recordCount: 7, statusBreakdown: [{ status: "Active", count: 5 }, { status: "Inactive", count: 2 }] };
  assert.equal(kpiValue(s, "total"), 7);
  assert.equal(kpiValue(s, "active"), 5);
  assert.equal(kpiValue(s, "inactive"), 2);
  assert.equal(kpiValue({ ...s, statusBreakdown: null }, "active"), null);
});

test("navigation: Revenue Cloud is renamed to Revenue Cloud Core and its dashboard is registered", () => {
  assert.ok(page.includes('label: "Revenue Cloud Core"'));
  assert.ok(!/label: "Revenue Cloud",/.test(page));
  assert.ok(page.includes('id: "revenue-core"') && page.includes("<RevenueCoreDashboard"));
  assert.ok(page.includes('id: "revenue",'), "group id (routes/URLs) unchanged");
});
