/**
 * Tax Treatment Item create page — AI extraction into the form, lookup resolution, and validation scope. Runs the real form
 * extraction (interpretForForm → buildFormDraft), the client form helpers and the server-side billing rule against an in-memory
 * org. Nothing is written to Salesforce (the fake org throws on any write).
 *
 * Run: `npx tsx --test lib/tax/server/treatmentItemForm.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretForForm } from "./assistantAi";
import { buildFormDraft, explicitPromptFields } from "./formDraft";
import { fakeTaxOrg, FAKE_META, type Row } from "./fakeTaxOrg";
import { evaluateBillingRules, ITEMS_NOT_ENABLED_MESSAGE } from "@/lib/billing/server/rules";
import { draftFromTaxForm, formCreateBlockers, type TaxFormDraft } from "@/lib/taxes/formDraft";
import type { SalesforceClient } from "@/lib/salesforce/client";
import type { BillingDraftRecord, BillingFieldMeta, BillingModuleSchema } from "@/lib/billing/types";

const TREAT_AU = "1tt000000000AU1", TREAT_NOITEMS = "1tt000000000AU2", DUP1 = "1tt000000000DU1", DUP2 = "1tt000000000DU2", PRODUCT = "01t000000000PR1";
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const seed = (): Record<string, Row[]> => ({
  // No Tax Engine, no Tax Rate and no decision table anywhere: none of them may matter for an item.
  TaxTreatment: [
    { Id: TREAT_AU, Name: "Australia GST E2E Treatment", Status: "Draft", IsTaxable: true, ShouldUseTaxTreatmentItems: true, TaxEngineId: null },
    { Id: TREAT_NOITEMS, Name: "Australia GST Plain Treatment", Status: "Draft", IsTaxable: true, ShouldUseTaxTreatmentItems: false },
    { Id: DUP1, Name: "Duplicate Treatment", Status: "Draft", ShouldUseTaxTreatmentItems: true },
    { Id: DUP2, Name: "Duplicate Treatment", Status: "Active", ShouldUseTaxTreatmentItems: true },
  ],
  Product2: [{ Id: PRODUCT, Name: "Cloud Storage Pro", ProductCode: "CSP-001", IsActive: true }],
});

const ACCEPTANCE = `Create a Tax Treatment Item:
- Name: Australia GST Taxable Item
- Description: Tax Treatment Item for taxable Australian GST transactions.
- TaxCode: AU_GST_10
- TaxTreatment: Australia GST E2E Treatment
- ProductCode: Leave blank unless required or explicitly provided.`;

/** What the model returns for the acceptance prompt (including notes and an extra operation that must NOT surface). */
const aiOut = (fields: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
  isTaxRequest: true,
  operations: [{ op: "create", object: "TaxTreatmentItem", fields }, ...extra],
  notes: ["The treatment has no Tax Engine; refresh the decision table after adding Tax Rates."],
});
const ACCEPT_FIELDS = { Name: "Australia GST Taxable Item", Description: "Tax Treatment Item for taxable Australian GST transactions.", TaxCode: "AU_GST_10", TaxTreatmentId: "Australia GST E2E Treatment" };

async function formFor(prompt: string, fields: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  const org = fakeTaxOrg(seed());
  const r = await interpretForForm(org.api, "TaxTreatmentItem", aiOut(fields, extra), prompt);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.success && r.mode === "form");
  assert.equal(org.writes.length, 0, "nothing is written while extracting");
  return { org, draft: (r as { draft: TaxFormDraft }).draft };
}

/* Client form helpers work on the schema the form renders (describe-derived). */
const fm = (name: string, type: string, o: Partial<BillingFieldMeta> = {}): BillingFieldMeta => ({ name, label: name, type, required: false, createable: true, updateable: true, nillable: true, defaultedOnCreate: false, isNameField: false, length: null, precision: null, scale: null, helpText: null, picklistValues: [], restrictedPicklist: false, controllerName: null, referenceTo: [], relationshipName: null, referenceModules: {}, calculated: false, custom: false, system: false, ...o });
const SCHEMA = { moduleKey: "tax-treatment-items", sobject: "TaxTreatmentItem", fields: [
  fm("Name", "string", { required: true, isNameField: true }), fm("TaxTreatmentId", "reference", { label: "Tax Treatment ID", required: true, referenceTo: ["TaxTreatment"] }),
  fm("ProductId", "reference", { label: "Product ID", required: true, referenceTo: ["Product2"] }), fm("TaxCode", "string"), fm("ProductCode", "string"), fm("Description", "textarea"),
] } as unknown as BillingModuleSchema;
const base = (): BillingDraftRecord => ({ key: "d1", moduleKey: "tax-treatment-items", fields: {}, references: {}, children: [] });

/* The server-side rule, through a client stub over the same fake org. */
async function ruleIssues(treatmentId: string | null) {
  const org = fakeTaxOrg(seed());
  const client = { query: async (soql: string) => ({ records: await org.query(soql) }) } as unknown as SalesforceClient;
  const r = await evaluateBillingRules({ client, moduleKey: "tax-treatment-items", schema: SCHEMA, mode: "create", recordId: null, effective: { Name: "X", TaxTreatmentId: treatmentId, ProductId: PRODUCT }, current: null });
  return r.issues;
}
const OFF_SCOPE = /tax engine|decision table|tax rate|legal entity|invoice/i;

test("1. AI extraction populates Name", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.equal(draft.fields.Name, "Australia GST Taxable Item");
});

test("2. AI extraction populates Description (long text keeps its sentence)", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.equal(draft.fields.Description, "Tax Treatment Item for taxable Australian GST transactions.");
});

test("3. AI extraction populates TaxCode — and the prompt's own value is kept when the AI drops it", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.equal(draft.fields.TaxCode, "AU_GST_10");
  const { draft: d2 } = await formFor(ACCEPTANCE, { Name: "Australia GST Taxable Item" });
  assert.equal(d2.fields.TaxCode, "AU_GST_10", "explicit 'TaxCode:' line is never discarded");
  assert.equal(d2.references.TaxTreatmentId?.id, TREAT_AU, "explicit 'TaxTreatment:' line resolved too");
});

test("4. ProductCode: populated when given, blank when the user says to leave it blank", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.equal(draft.fields.ProductCode, undefined, "intentionally omitted — stays blank, never taken from a product");
  const given = ACCEPTANCE.replace(/- ProductCode:.*$/m, "- ProductCode: AU-PC-1");
  const { draft: d2 } = await formFor(given, { ...ACCEPT_FIELDS, ProductCode: "AU-PC-1" });
  assert.equal(d2.fields.ProductCode, "AU-PC-1");
  const { draft: d3 } = await formFor(ACCEPTANCE, { ...ACCEPT_FIELDS, ProductCode: "INVENTED" });
  assert.equal(d3.fields.ProductCode, undefined, "the user's 'leave blank' wins over an AI value");
  assert.deepEqual([...explicitPromptFields(FAKE_META, "TaxTreatmentItem", ACCEPTANCE).blank], ["ProductCode"]);
});

test("5. Tax Treatment name resolves to its Salesforce TaxTreatmentId", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.equal(draft.references.TaxTreatmentId?.id, TREAT_AU);
  assert.equal(draft.unresolved.TaxTreatmentId, undefined);
});

test("6. the resolved lookup carries the record name for display and the Id for Salesforce", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  const d = draftFromTaxForm(base(), draft);
  assert.deepEqual(d.references.TaxTreatmentId, { id: TREAT_AU, name: "Australia GST E2E Treatment", sobject: "TaxTreatment" });
});

test("7. a missing Tax Treatment gives a clear lookup error and keeps every other extracted value", async () => {
  const prompt = ACCEPTANCE.replace("Australia GST E2E Treatment", "Nonexistent Treatment");
  const { draft } = await formFor(prompt, { ...ACCEPT_FIELDS, TaxTreatmentId: "Nonexistent Treatment" });
  assert.equal(draft.references.TaxTreatmentId, undefined);
  assert.equal(draft.unresolved.TaxTreatmentId?.searchedName, "Nonexistent Treatment");
  assert.equal(draft.fields.Name, "Australia GST Taxable Item");
  assert.equal(draft.fields.TaxCode, "AU_GST_10");
  assert.equal(draft.fields.Description, "Tax Treatment Item for taxable Australian GST transactions.");
  const blockers = formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), draft.prerequisites);
  assert.ok(blockers.some(b => /Tax Treatment ID "Nonexistent Treatment" was not found in Salesforce/.test(b)), blockers.join(" | "));
});

test("8. several Tax Treatments with the name require an explicit selection — none is picked", async () => {
  const prompt = ACCEPTANCE.replace("Australia GST E2E Treatment", "Duplicate Treatment");
  const { draft } = await formFor(prompt, { ...ACCEPT_FIELDS, TaxTreatmentId: "Duplicate Treatment" });
  assert.equal(draft.references.TaxTreatmentId, undefined, "never auto-selected");
  assert.deepEqual(draft.unresolved.TaxTreatmentId?.candidates.map(c => c.id).sort(), [DUP1, DUP2]);
  assert.ok(formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), []).some(b => /matches 2 records — choose one/.test(b)));
});

test("9. fields that don't exist on (or can't be set for) TaxTreatmentItem are excluded, not sent", async () => {
  const { draft } = await formFor(ACCEPTANCE, { ...ACCEPT_FIELDS, Status: "Active", IsTaxable: true, Rate: 10, "Tax Component": "GST", CreatedDate: "2026-01-01" });
  for (const k of ["Status", "IsTaxable", "Rate", "Tax Component", "CreatedDate"]) assert.equal(k in draft.fields, false, `${k} must not reach the form`);
  assert.ok(draft.notices.some(n => /Ignored "Status"/.test(n)) && draft.notices.some(n => /Ignored Created Date/.test(n)), draft.notices.join(" | "));
});

test("10. a parent Tax Treatment without 'Use Tax Treatment Items' blocks creation (client and server)", async () => {
  const prompt = ACCEPTANCE.replace("Australia GST E2E Treatment", "Australia GST Plain Treatment");
  const { draft } = await formFor(prompt, { ...ACCEPT_FIELDS, TaxTreatmentId: "Australia GST Plain Treatment" });
  assert.equal(draft.references.TaxTreatmentId?.id, TREAT_NOITEMS);
  assert.deepEqual(draft.prerequisites, [{ field: "TaxTreatmentId", recordId: TREAT_NOITEMS, ok: false, message: ITEMS_NOT_ENABLED_MESSAGE }]);
  assert.ok(formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), draft.prerequisites).includes(ITEMS_NOT_ENABLED_MESSAGE));
  const issues = await ruleIssues(TREAT_NOITEMS);
  assert.deepEqual(issues.map(i => [i.severity, i.field, i.message]), [["error", "TaxTreatmentId", ITEMS_NOT_ENABLED_MESSAGE]]);
  assert.equal(ITEMS_NOT_ENABLED_MESSAGE, "Selected Tax Treatment does not support Tax Treatment Items. Enable Tax Treatment Items on the parent Tax Treatment before creating this record.");
});

test("11. a treatment with no Tax Engine does not block Tax Treatment Item creation", async () => {
  assert.deepEqual(await ruleIssues(TREAT_AU), []);
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.deepEqual(draft.prerequisites, [{ field: "TaxTreatmentId", recordId: TREAT_AU, ok: true, message: null }]);
});

test("12. no Tax Rate in the org does not block Tax Treatment Item creation", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  const blockers = formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), draft.prerequisites);
  assert.deepEqual(blockers, ["Product ID is required by Salesforce — select an existing record."], "only the genuinely required Product remains");
});

test("13. no decision-table, tax engine or tax rate message reaches the item form (AI notes and extra operations included)", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS, [{ op: "create", object: "TaxRate", fields: { TaxCode: "AU_GST_10", Rate: 10 } }]);
  for (const n of draft.notices) assert.doesNotMatch(n.replace(/create TaxRate/, ""), OFF_SCOPE, n);
  assert.ok(draft.notices.some(n => /not applied: create TaxRate/.test(n)), "the extra operation is reported, not applied");
  for (const i of [...await ruleIssues(TREAT_AU), ...await ruleIssues(TREAT_NOITEMS)]) assert.doesNotMatch(i.message, OFF_SCOPE);
});

test("14. the form draft keeps every extracted value (Analyze & Verify doesn't reset it)", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  const d = draftFromTaxForm({ ...base(), fields: { Name: null } }, draft);
  assert.deepEqual({ Name: d.fields.Name, Description: d.fields.Description, TaxCode: d.fields.TaxCode }, { Name: ACCEPT_FIELDS.Name, Description: ACCEPT_FIELDS.Description, TaxCode: ACCEPT_FIELDS.TaxCode });
  const again = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  assert.deepEqual(again.draft.fields, draft.fields, "re-analysis of the same request gives the same values");
});

test("15. checks use the CURRENT form state: selecting the product clears its blocker", async () => {
  const { draft } = await formFor(ACCEPTANCE, ACCEPT_FIELDS);
  const d = draftFromTaxForm(base(), draft);
  assert.equal(formCreateBlockers(SCHEMA, d, draft.prerequisites).length, 1);
  const edited = { ...d, references: { ...d.references, ProductId: { id: PRODUCT, name: "Cloud Storage Pro", sobject: "Product2" } } };
  assert.deepEqual(formCreateBlockers(SCHEMA, edited, draft.prerequisites), []);
  const switched = { ...edited, references: { ...edited.references, TaxTreatmentId: { id: TREAT_NOITEMS, name: "Australia GST Plain Treatment", sobject: "TaxTreatment" } } };
  assert.deepEqual(formCreateBlockers(SCHEMA, switched, [{ field: "TaxTreatmentId", recordId: TREAT_NOITEMS, ok: false, message: ITEMS_NOT_ENABLED_MESSAGE }]), [ITEMS_NOT_ENABLED_MESSAGE]);
});

test("16. lookups carry Salesforce Ids, never names, and no lookup value sits in the plain fields", async () => {
  const prompt = `${ACCEPTANCE}\n- Product: Cloud Storage Pro`;
  const { draft } = await formFor(prompt, { ...ACCEPT_FIELDS, ProductId: "Cloud Storage Pro" });
  assert.match(draft.references.TaxTreatmentId!.id, SFID);
  assert.equal(draft.references.ProductId?.id, PRODUCT);
  for (const k of ["TaxTreatmentId", "ProductId"]) assert.equal(k in draft.fields, false);
  assert.deepEqual(formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), draft.prerequisites), [], "all required lookups resolved");
});

test("17. a failed lookup (or the missing required ProductId) prevents creation; a product is never picked silently", async () => {
  const { draft } = await formFor(ACCEPTANCE, { ...ACCEPT_FIELDS, ProductId: "Cloud Storage Pro" });
  assert.equal(draft.references.ProductId, undefined, "a product the user didn't name is never selected");
  assert.ok(draft.notices.some(n => /Ignored Product ID "Cloud Storage Pro" — it isn't named in your request/.test(n)));
  assert.ok(formCreateBlockers(SCHEMA, draftFromTaxForm(base(), draft), draft.prerequisites).some(b => /Product ID is required/.test(b)));
  const unresolved = await formFor(ACCEPTANCE.replace("Australia GST E2E Treatment", "Nope"), { ...ACCEPT_FIELDS, TaxTreatmentId: "Nope" });
  assert.ok(formCreateBlockers(SCHEMA, draftFromTaxForm(base(), unresolved.draft), []).length >= 2);
});

test("18. a new analysis starts from a blank draft: nothing from the previous configuration remains", async () => {
  const org = fakeTaxOrg(seed());
  const first = await buildFormDraft(org.api, "TaxTreatmentItem", null, "- Name: Old Item\n- TaxTreatment: Australia GST Plain Treatment\n- TaxCode: OLD");
  const old = draftFromTaxForm(base(), first);
  assert.equal(old.references.TaxTreatmentId?.id, TREAT_NOITEMS);
  const second = await buildFormDraft(org.api, "TaxTreatmentItem", null, "- Name: New Item\n- TaxTreatment: Nonexistent Treatment");
  const fresh = draftFromTaxForm(base(), second);
  assert.equal(fresh.fields.TaxCode, undefined, "the old Tax Code is gone");
  assert.equal(fresh.references.TaxTreatmentId, undefined, "the old treatment is not kept for an unresolved one");
  assert.ok(!formCreateBlockers(SCHEMA, fresh, second.prerequisites).includes(ITEMS_NOT_ENABLED_MESSAGE), "the old prerequisite error is gone");
  const fromPage = draftFromTaxForm(base(), second, { TaxTreatmentId: { id: TREAT_AU, name: "Australia GST E2E Treatment", sobject: "TaxTreatment" } });
  assert.equal(fromPage.references.TaxTreatmentId, undefined, "a lookup the prompt named but couldn't resolve is left for the user, not pre-filled");
  assert.equal(org.writes.length, 0);
});
