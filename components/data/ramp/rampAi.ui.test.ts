/**
 * RAMP AI prompt fields + contextual help — components rendered with react-dom/server (no browser harness in this repo: effects and
 * fetches don't run), plus source assertions that each form's AI result is merged into the REAL form state and that the help uses the
 * app's shared PromptGuide / FieldHelp components. Nothing here talks to Salesforce or an AI provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PromptGuide from "@/components/ai/PromptGuide";
import RampAiAssist, { RampHelpPanel, showValue, uiConflicts } from "./RampAiAssist";
import { Field } from "./rampUi";
import { RAMP_FIELD_HELP, RAMP_HELP, rampGuide, type RampHelpKey } from "@/lib/ramp/help";
import { mergeAiPatch } from "@/lib/ramp/aiSchema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const KEYS = Object.keys(RAMP_HELP) as RampHelpKey[];

test("AI prompt field renders: textarea, Generate Configuration, example, and the shared prompt guide", () => {
  const html = renderToStaticMarkup(h(RampAiAssist, { isDark: false, form: "schedule", helpKey: "schedule", title: "Create a schedule", context: {}, onResult: () => ({ applied: [], conflicts: [] }) }));
  assert.match(html, /data-testid="ramp-ai-schedule"/);
  assert.match(html, /<textarea[^>]*aria-label="Create a schedule AI prompt"/);
  assert.match(html, /Generate Configuration/);
  assert.match(html, /Example: Create a 3-year yearly schedule/);
  assert.match(html, /Prompt Guide — what can I say here\?/);
  assert.match(html, /nothing is saved, created or executed/);
  assert.doesNotMatch(html, /Regenerate|Clear/, "regenerate / clear appear only once there is a prompt or result");
});

test("every RAMP creation form embeds the AI field and merges the result into its own state", () => {
  const prs = src("components/data/ramp/ProductRampSetup.tsx"), sch = src("components/data/ramp/RampSchedules.tsx"), deals = src("components/data/ramp/RampDeals.tsx");
  assert.match(prs, /<RampAiAssist[^>]*form="product-segment"[^>]*helpKey="productSetup"/);
  assert.match(prs, /mergeAiPatch<PrsForm>\(current, patch/); assert.match(prs, /setProduct\(p\.productId/); assert.match(prs, /setForm\(f =>/);
  assert.match(sch, /<RampAiAssist[^>]*form="schedule"[^>]*helpKey="schedule"/);
  assert.match(sch, /setEdit\(m\.next\)/);
  assert.match(deals, /form=\{raw\.kind === "group" \? "group-deal" : "deal"\}/);
  assert.match(deals, /setD\(\{ \.\.\.m\.next, schedule: sm\.next \}\)/);
  assert.match(deals, /\{!locked && <RampAiAssist/, "no AI changes to a deal that already has an execution");
  // manual forms are still there
  assert.match(sch, /<ScheduleEditor isDark=\{isDark\} value=\{edit\}/);
  assert.match(deals, /label="Quote line to ramp"/);
  assert.match(prs, /label="Segment type"/);
});

test("AI generation is read-only: the route + resolver never write to Salesforce or the RAMP store", () => {
  const route = src("app/api/ramp/ai/form/route.ts"), resolver = src("lib/ramp/server/aiForms.ts"), ui = src("components/data/ramp/RampAiAssist.tsx");
  assert.doesNotMatch(resolver, /\.call\(|createProductRampSegment|saveDeal|saveSchedule|startExecution|stepExecution|store\.update/);
  assert.doesNotMatch(route, /saveDeal|saveSchedule|startExecution|store\.update|recordEvent/);
  assert.match(route, /store\.load/);
  assert.match(ui, /"\/api\/ramp\/ai\/form"/);
  assert.doesNotMatch(ui, /\/api\/ramp\/(deals|schedules|product-segments|executions)/);
  assert.match(route, /resolveAnthropicKey\(req\)/, "the user's own key, resolved server-side");
  assert.doesNotMatch(ui, /apiKey|@anthropic-ai|x-api-key/i, "no key or provider SDK in the browser component");
});

test("conflicts keep the user's value until 'Use AI value' applies the AI's patch through the form setter", () => {
  const m = mergeAiPatch<{ quoteId: string | null; quoteName: string | null; name: string }>({ quoteId: "0Q0MINE", quoteName: "Mine", name: "x" }, { quoteId: "0Q0AI", quoteName: "AI quote", name: "y" }, { defaults: { quoteId: null, quoteName: null, name: "" }, refs: [{ key: "quoteId", with: ["quoteName"] }], replace: false });
  const applied: unknown[] = [];
  const ui = uiConflicts(m.conflicts, p => applied.push(p));
  assert.deepEqual(ui.map(c => [c.label, c.current, c.proposed, c.reference]), [["quoteId", "Mine", "AI quote", true], ["name", "x", "y", false]]);
  ui[0].apply();
  assert.deepEqual(applied, [{ quoteId: "0Q0AI", quoteName: "AI quote" }]);
  assert.equal(showValue([{ segment: 2, value: 5, quantity: null }]), "segment 2 value 5");
  assert.equal(showValue(null), "—");
});

test("help content: every RAMP page has Overview, Required, Optional, Prerequisites and Examples in the shared guide shape", () => {
  for (const k of KEYS) {
    const g = rampGuide(k), help = RAMP_HELP[k];
    assert.ok(g.whatItCreates.length > 40, `${k} overview`);
    assert.ok(g.prerequisites && g.prerequisites.length > 0, `${k} prerequisites`);
    assert.ok(g.example.prompt, `${k} example`);
    assert.ok(Array.isArray(g.requiredFields) && Array.isArray(g.optionalFields));
    assert.ok(help.commonErrors.length > 0 && help.nextSteps.length > 0, `${k} errors / next steps`);
  }
  assert.deepEqual(RAMP_HELP.productSetup.required.map(f => f.label).slice(0, 3), ["Product", "Selling Model", "Segment Type"]);
  assert.ok(RAMP_HELP.deal.required.some(f => f.label === "Quote Line"));
  assert.ok(RAMP_HELP.groupDeal.required.some(f => f.label === "Quote Line Group"));
  assert.ok(RAMP_HELP.groupDeal.prerequisites.some(p => /Revenue Settings/.test(p)));
  assert.ok(RAMP_HELP.executions.examples[0].details!.some(d => /Calculated prices are not necessarily persisted/.test(d)));
});

test("schedule help example shows the boundaries generated by the app's own schedule engine", () => {
  const d = RAMP_HELP.schedule.examples[0].details!;
  assert.ok(d.includes("Year 1: 2027-01-01 → 2027-12-31 · uplift 0% (preview 100 on a base of 100)"));
  assert.ok(d.some(x => x.startsWith("Year 3: 2029-01-01 → 2029-12-31 · uplift 5%")));
});

test("help panel renders with the shared PromptGuide design; open guide shows the Required/Optional/Prerequisites/Examples tabs", () => {
  for (const k of KEYS) {
    const html = renderToStaticMarkup(h(RampHelpPanel, { isDark: k === "history", helpKey: k }));
    assert.match(html, new RegExp(`data-testid="ramp-help-${k}"`));
    assert.match(html, /Help — /);
    assert.match(html, /aria-expanded="false"/);
  }
  const open = renderToStaticMarkup(h(PromptGuide, { isDark: false, config: rampGuide("deal"), defaultOpen: true }));
  for (const tab of [`Required (${RAMP_HELP.deal.required.length})`, `Optional (${RAMP_HELP.deal.optional.length})`, "Prerequisites", "Example", "Errors &amp; next steps"]) assert.ok(open.includes(tab), tab);
  assert.match(open, /Ramp Deals — Help/);
  assert.match(open, /splits ONE quote line/);
});

test("existing prompt guides are unchanged (no extra tabs unless configured)", () => {
  const html = renderToStaticMarkup(h(PromptGuide, { isDark: false, defaultOpen: true, config: { title: "X", whatItCreates: "w", requiredFields: [], optionalFields: [], capabilities: [], interpretationNotes: [], example: { prompt: "p" }, reviewNote: "r" } }));
  assert.doesNotMatch(html, /Prerequisites|Errors &amp; next steps|Examples/);
  assert.match(html, /Prompt Guide|X/);
});

test("field ⓘ tips use the shared FieldHelp (accessible tooltip) with text, format and example; required fields are marked", () => {
  const html = renderToStaticMarkup(h(Field, { isDark: false, label: "Segment type", required: true, help: RAMP_FIELD_HELP.segmentType, children: h("input") }));
  assert.match(html, /aria-label="Help: Segment type"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /Yearly · Custom · FreeTrial · Prorated/);
  assert.match(html, /Example: /);
  assert.match(html, /aria-hidden="true"[^>]*>\*</);
  const plain = renderToStaticMarkup(h(Field, { isDark: true, label: "Plain", children: h("input") }));
  assert.doesNotMatch(plain, /Help: |role="tooltip"/);
});

test("help is wired into every RAMP page", () => {
  const files = { productSetup: "ProductRampSetup", schedule: "RampSchedules", deal: "RampDeals", groupDeal: "RampDeals", executions: "RampActivity", history: "RampActivity" } as const;
  for (const [k, f] of Object.entries(files)) assert.ok(src(`components/data/ramp/${f}.tsx`).includes(`"${k}"`), `${k} help on ${f}`);
  assert.match(src("components/data/ramp/RampDeals.tsx"), /required help=\{H\.quote\}/);
  assert.match(src("components/data/ramp/RampSchedules.tsx"), /label="Period" required help=\{H\.period\}/);
});
