/**
 * Global overlay layering + placement (lib/ui/overlay.ts) and the guarantee that every dropdown/lookup/menu in the app goes
 * through the shared foreground layer (components/ui/AnchoredOverlay.tsx) instead of an in-flow `absolute` list that a card's
 * `overflow: hidden` clips — the Tax Treatment "Legal Entity" lookup rendering behind the Relationships card.
 *
 * Run: `npx tsx --test lib/ui/overlay.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Z, computePlacement, isInsideOverlay, overlayPanelStyle, type AnchorRect } from "./overlay";

const VIEW = { width: 1280, height: 800 };
const field = (top: number, left = 100, width = 320, height = 34): AnchorRect => ({ top, bottom: top + height, left, right: left + width, width });

/* ── layering ── */

test("layer order: cards < headers < dialogs < nested dialogs < dropdowns/popovers < toasts", () => {
  const order = [Z.raised, Z.header, Z.dialog, Z.dialogNested, Z.popover, Z.toast];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(Z.popover > Z.dialogNested, "a lookup opened inside any dialog/drawer is above it");
  assert.ok(Z.toast > Z.popover, "notifications are never covered by an open dropdown");
});

/* ── placement ── */

test("opens below the field, field-width, when there's room", () => {
  const p = computePlacement(field(200), VIEW, { maxHeight: 280, matchWidth: true });
  assert.equal(p.side, "bottom");
  assert.equal(p.top, 238);
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 100);
  assert.equal(p.width, 320);
  assert.equal(p.maxHeight, 280);
});

test("near the bottom of the viewport it flips upward and grows away from the field", () => {
  const p = computePlacement(field(700), VIEW, { maxHeight: 280, matchWidth: true });
  assert.equal(p.side, "top");
  assert.equal(p.top, undefined);
  assert.equal(p.bottom, VIEW.height - 700 + 4);
  assert.equal(p.maxHeight, 280);
});

test("a long list is capped to the room on its side (never runs off-screen)", () => {
  const p = computePlacement(field(420), VIEW, { maxHeight: 600, matchWidth: true });
  // below: 800 - 454 - 4 - 8 = 334; above: 420 - 12 = 408 → opens up, capped at 408
  assert.equal(p.side, "top");
  assert.equal(p.maxHeight, 408);
  const down = computePlacement(field(100), VIEW, { maxHeight: 2000, matchWidth: true });
  assert.equal(down.side, "bottom");
  assert.equal(down.maxHeight, VIEW.height - 134 - 4 - 8);
});

test("when both sides are cramped it still opens at a usable height", () => {
  const p = computePlacement(field(30, 100, 320, 30), { width: 1280, height: 120 }, { maxHeight: 280, matchWidth: true });
  assert.ok(p.maxHeight >= 96);
});

test("responsive: never wider than the viewport, never past its edges", () => {
  const phone = { width: 360, height: 740 };
  const wide = computePlacement(field(200, 300, 320), phone, { maxHeight: 280, matchWidth: true, minWidth: 280 });
  assert.ok(wide.left >= 8 && wide.left + (wide.width ?? 0) <= phone.width - 8, JSON.stringify(wide));
  const narrowField = computePlacement(field(200, 20, 120), phone, { maxHeight: 280, matchWidth: true, minWidth: 280 });
  assert.equal(narrowField.width, 280, "minWidth widens a narrow field's list");
  const huge = computePlacement(field(200, 0, 2000), phone, { maxHeight: 280, matchWidth: true });
  assert.equal(huge.width, phone.width - 16);
});

test("content-sized menus align to the anchor's start or end edge", () => {
  const start = computePlacement(field(100, 600, 120), VIEW, { maxHeight: 260, matchWidth: false, minWidth: 200 });
  assert.equal(start.width, undefined);
  assert.equal(start.minWidth, 200);
  assert.equal(start.left, 600);
  const end = computePlacement(field(100, 600, 120), VIEW, { maxHeight: 260, matchWidth: false, minWidth: 200, align: "end" });
  assert.equal(end.left, 720 - 200);
  const nearRight = computePlacement(field(100, 1200, 60), VIEW, { maxHeight: 260, matchWidth: false, minWidth: 200 });
  assert.equal(nearRight.left, VIEW.width - 8 - 200);
});

test("outside-click detection treats the anchor and the portaled overlay as inside", () => {
  const node = {} as Node;
  const holds = (n: Node) => ({ contains: (x: Node) => x === n });
  assert.equal(isInsideOverlay(node, holds(node), null), true);
  assert.equal(isInsideOverlay(node, null, holds(node)), true);
  assert.equal(isInsideOverlay(node, holds({} as Node), holds({} as Node)), false);
  assert.equal(isInsideOverlay(null, holds(node)), false);
});

test("overlay panels are fully opaque in both themes (cards are translucent, a floating list must not be)", () => {
  for (const dark of [true, false]) assert.match(overlayPanelStyle(dark, "#000").background, /^#[0-9a-f]{6}$/i);
  assert.notEqual(overlayPanelStyle(true, "#000").background, overlayPanelStyle(false, "#000").background);
});

/* ── every dropdown uses the shared layer ── */

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx$/.test(name) ? [rel] : [];
  });
}

const DROPDOWNS = [
  "components/data/shared/ReferenceLookup.tsx",      // Billing/Tax record forms (Legal Entity, Tax Policy, Tax Engine…), Quotes, Orders, Contracts
  "components/data/taxes/SalesforceLookup.tsx",       // tax lookups (Account, Contact, Product, Invoice, Country, State)
  "components/data/pricing-rules/ProductLookup.tsx",  // Pricing Procedures
  "components/data/contracts/ContactLookup.tsx",      // Contracts
  "components/data/contracts/RichTextEditor.tsx",     // Merge Field menu
  "components/data/taxes/NativeTaxGuidance.tsx",      // info tips
];

for (const file of DROPDOWNS) {
  test(`${file} renders its list through the shared AnchoredOverlay`, () => {
    const code = src(file);
    assert.match(code, /import AnchoredOverlay from "@\/components\/ui\/AnchoredOverlay"/);
    assert.match(code, /<AnchoredOverlay\b[^>]*anchorRef=/);
    assert.doesNotMatch(code, /createPortal/, "no private portal/positioning logic");
  });
}

test("no component renders an in-flow absolute dropdown under its field (the clipping pattern)", () => {
  const offenders = [...walk("components"), ...walk("app")].filter(f => {
    const code = src(f);
    return /position:\s*"absolute"[^}]*top:\s*"(100%|calc\(100%)/.test(code) || /\babsolute\b[^"]*\btop-full\b/.test(code);
  });
  assert.deepEqual(offenders, []);
});

test("every fixed layer (dialog, toast, panel) takes its z-index from the shared scale, not a literal", () => {
  const offenders = [...walk("components"), ...walk("app")].flatMap(f =>
    src(f).split("\n").map((line, i) => ({ line, at: `${f}:${i + 1}` }))
      .filter(({ line }) => /position:\s*"fixed"|\bfixed\b/.test(line) && (/zIndex:\s*\d/.test(line) || /\bz-(?:\d+|\[\d+\])\b/.test(line)))
      .map(x => x.at));
  assert.deepEqual(offenders, []);
});

test("the shared layer portals to document.body, follows scroll/resize and never renders on the server", () => {
  const code = src("components/ui/AnchoredOverlay.tsx");
  assert.match(code, /createPortal\([\s\S]*document\.body/);
  assert.match(code, /zIndex: Z\.popover/);
  assert.match(code, /addEventListener\("scroll", schedule, true\)/, "capture phase: inner scroll containers too");
  assert.match(code, /addEventListener\("resize", schedule\)/);
  assert.match(code, /if \(!open \|\| !placement \|\| typeof document === "undefined"\) return null/);
});
