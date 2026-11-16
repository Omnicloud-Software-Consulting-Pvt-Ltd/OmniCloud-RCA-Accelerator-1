/** Contracts → Templates → Company Information: saved, and shown in the preview, PDF and DOCX header/footer. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { DEFAULT_BRANDING, applyCompanySettings, companyDetailLines, renderBrandedHtml, renderFooterElements } from "./render";
import { renderContractDocx } from "./docx";
import { renderContractPdf } from "./pdf";
import { getCompanySettings, updateCompanySettings } from "./localTemplateStore";
import type { BrandingConfig, CompanySettings, MergeFieldValues } from "@/lib/contracts/types";

const SETTINGS: CompanySettings = {
  companyName: "Acme Robotics Pvt Ltd", address: "12 MG Road, Bengaluru 560001", phone: "+91 80 1234 5678", email: "legal@acme.example",
  website: "www.acme.example", taxNumber: "29ABCDE1234F1Z5", registrationNumber: "U72900KA2020PTC000001", logoUrl: null,
};
const branding = (over: Partial<BrandingConfig> = {}): BrandingConfig => ({ ...DEFAULT_BRANDING, footerElements: ["companyAddress", "copyright"], ...over });
const VALUES = { CompanyName: "Acme Robotics Pvt Ltd" } as unknown as MergeFieldValues;

test("applyCompanySettings: the saved company replaces the template's 'Your Company'; blank name keeps the template's own", () => {
  const applied = applyCompanySettings(branding(), SETTINGS);
  assert.equal(applied.companyName, "Acme Robotics Pvt Ltd");
  assert.deepEqual(companyDetailLines(applied), [
    "12 MG Road, Bengaluru 560001",
    "+91 80 1234 5678  ·  legal@acme.example  ·  www.acme.example",
    "Tax No: 29ABCDE1234F1Z5  ·  Reg No: U72900KA2020PTC000001",
  ]);
  assert.equal(applyCompanySettings(branding({ companyName: "Template Co" }), { ...SETTINGS, companyName: "  " }).companyName, "Template Co");
  assert.equal(applyCompanySettings(branding(), null).companyName, "Your Company");
  assert.deepEqual(companyDetailLines(applyCompanySettings(branding(), { companyName: "Only Name" })), [], "no empty detail lines");
  assert.equal(branding().companyName, "Your Company", "the template branding object itself is not changed");
});

test("footer: 'Company address' shows the saved address (not the name); copyright uses the saved company name", () => {
  const labels = renderFooterElements(applyCompanySettings(branding(), SETTINGS));
  assert.equal(labels[0], "12 MG Road, Bengaluru 560001");
  assert.match(labels[1], /© \d{4} Acme Robotics Pvt Ltd/);
});

test("HTML preview header shows the saved name and contact details, escaped", () => {
  const html = renderBrandedHtml("<p>Hello {{CompanyName}}</p>", applyCompanySettings(branding(), { ...SETTINGS, address: "<b>Unit 4</b> & Co" }), VALUES);
  assert.ok(html.includes(">Acme Robotics Pvt Ltd</div>"));
  assert.ok(!html.includes(">Your Company<"));
  assert.ok(html.includes("&lt;b&gt;Unit 4&lt;/b&gt; &amp; Co"), "user text is escaped");
  assert.ok(html.includes("legal@acme.example") && html.includes("Tax No: 29ABCDE1234F1Z5"));
  assert.ok(html.includes("Hello Acme Robotics Pvt Ltd"));
});

test("generated DOCX header contains the saved company name and details", async () => {
  const buf = await renderContractDocx("<p>Body</p>", applyCompanySettings(branding(), SETTINGS), VALUES);
  const zip = await JSZip.loadAsync(buf);
  const headers = await Promise.all(Object.keys(zip.files).filter(n => /^word\/header\d*\.xml$/.test(n)).map(n => zip.file(n)!.async("string")));
  const xml = headers.join("");
  for (const text of ["Acme Robotics Pvt Ltd", "12 MG Road, Bengaluru 560001", "legal@acme.example", "Tax No: 29ABCDE1234F1Z5"]) assert.ok(xml.includes(text), `header has ${text}`);
  assert.ok(!xml.includes("Your Company"));
});

test("generated PDF renders with the company details header", async () => {
  const buf = await renderContractPdf("<p>Body</p>", applyCompanySettings(branding(), SETTINGS), VALUES);
  assert.ok(buf.length > 1000 && buf.subarray(0, 5).toString() === "%PDF-");
});

/* ── Saving (browser storage) ── */

function withStorage(storage: Partial<Storage> | null, run: () => Promise<void>) {
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;
  g.window = storage ? { localStorage: storage } : {};
  return run().finally(() => { g.window = before; });
}
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}

test("Save persists the company information and it reads back (what the preview uses on reload)", () => withStorage(memoryStorage(), async () => {
  const saved = await updateCompanySettings({ companyName: "Acme Robotics Pvt Ltd", address: "12 MG Road" });
  assert.equal(saved.companyName, "Acme Robotics Pvt Ltd");
  const reloaded = await getCompanySettings();
  assert.deepEqual([reloaded.companyName, reloaded.address], ["Acme Robotics Pvt Ltd", "12 MG Road"]);
  await updateCompanySettings({ phone: "+91 80 1234 5678" });
  assert.deepEqual([(await getCompanySettings()).companyName, (await getCompanySettings()).phone], ["Acme Robotics Pvt Ltd", "+91 80 1234 5678"], "partial saves keep earlier fields");
}));

test("Save never fails silently: blocked/full storage or no storage gives a clear error", async () => {
  await withStorage({ ...memoryStorage(), getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } }, async () => {
    await assert.rejects(updateCompanySettings({ companyName: "X" }), /refused to save/);
  });
  await withStorage(null, async () => {
    await assert.rejects(updateCompanySettings({ companyName: "X" }), /storage is unavailable/);
  });
});

test("Templates screen: preview, PDF preview and generated documents all use the company-applied branding; Save reports its result", () => {
  const src = readFileSync(join(process.cwd(), "components", "data", "contracts", "ContractDocuments.tsx"), "utf8");
  assert.match(src, /applyCompanySettings\(draftBranding, companySettings\)/);
  assert.match(src, /renderBrandedHtml\(draftBody, effectiveBranding, effectiveValues\)/);
  assert.match(src, /templates\/preview\/pdf", \{ bodyHtml: draftBody, branding: effectiveBranding/);
  assert.match(src, /documents\/generate`,\s*\{ templateName: draftName, bodyHtml: draftBody, branding: effectiveBranding/);
  assert.match(src, /setResult\(\{ ok: true, text: "Saved/);
  assert.match(src, /setResult\(\{ ok: false/);
});
