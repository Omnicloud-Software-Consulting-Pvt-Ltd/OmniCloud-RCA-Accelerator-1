/**
 * Tax Configuration Assistant — pure tests: relationship choice from metadata (never guessed), field-key mapping and value
 * validation against describe, duplicate-prevention business keys, and normalization/grounding of the AI's operations.
 *
 * Run: `npx tsx --test lib/tax/server/operations.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DUPLICATE_RULES, chooseRelationship, coerceValue, mapFieldKeys } from "./operations";
import { assistantSystemPrompt, metadataBrief, operationsFromAi } from "./assistantAi";
import type { FieldMeta, ObjectMeta, TaxMetadata } from "@/lib/tax/types";

const f = (name: string, type = "string", o: Partial<FieldMeta> = {}): FieldMeta => ({ name, label: name.replace(/Id$/, " ID").replace(/([a-z])([A-Z])/g, "$1 $2"), type, required: false, createable: true, updateable: true, nillable: true, picklist: [], referenceTo: [], ...o });
const pick = (name: string, values: string[]) => f(name, "picklist", { picklist: values.map(v => ({ value: v, label: v })) });
const refF = (name: string, to: string, o: Partial<FieldMeta> = {}) => f(name, "reference", { referenceTo: [to], ...o });
const obj = (name: string, fields: FieldMeta[]): ObjectMeta => ({ name, label: name, exists: true, createable: true, updateable: true, queryable: true, deletable: true, fields: Object.fromEntries(fields.map(x => [x.name, x])) });

const meta: TaxMetadata = {
  apiVersion: "v68.0", availableTaxObjects: [], relationships: {}, problems: [],
  objects: {
    TaxPolicy: obj("TaxPolicy", [f("Name", "string", { nameField: true }), pick("Status", ["Draft", "Active", "Inactive"]), pick("TreatmentSelection", ["Default", "Manual", "LegalEntity"]), refF("DefaultTaxTreatmentId", "TaxTreatment"), f("Description"), refF("OwnerId", "User")]),
    TaxTreatment: obj("TaxTreatment", [f("Name", "string", { nameField: true }), refF("TaxPolicyId", "TaxPolicy"), refF("TaxEngineId", "TaxEngine"), refF("LegalEntityId", "LegalEntity"), f("IsTaxable", "boolean"), pick("Status", ["Draft", "Active", "Inactive"])]),
    TaxTreatmentItem: obj("TaxTreatmentItem", [f("Name", "string", { nameField: true }), refF("TaxTreatmentId", "TaxTreatment", { updateable: false }), refF("ProductId", "Product2")]),
    TaxRate: obj("TaxRate", [f("Name", "string", { nameField: true, createable: false, updateable: false }), f("TaxCode", "string", { updateable: false }), refF("GeoCountryId", "GeoCountry", { updateable: false }), f("Rate", "percent"), f("StartDate", "date"), f("EndDate", "date"), pick("RateUsageType", ["Commerce", "RevCloud"])]),
    TaxEngine: obj("TaxEngine", [f("TaxEngineName", "string", { nameField: true }), pick("Status", ["Active", "Inactive"])]),
    GeoCountry: obj("GeoCountry", [f("Name", "string", { nameField: true }), f("IsoCode", "string", { updateable: false })]),
    Product2: obj("Product2", [f("Name", "string", { nameField: true }), refF("TaxPolicyId", "TaxPolicy")]),
    LegalEntity: obj("LegalEntity", [f("Name", "string", { nameField: true })]),
    Account: obj("Account", [f("Name"), refF("PrimaryPolicyId", "TaxPolicy"), refF("SecondaryPolicyId", "TaxPolicy")]),
  },
};

test("ASSIGN: product → policy uses the field on the source that references the target (from metadata)", () => {
  assert.deepEqual(chooseRelationship(meta, "Product2", "TaxPolicy"), { status: "ok", field: "TaxPolicyId", label: "Tax Policy ID", on: "source" });
});

test("ASSIGN: treatment → policy prefers TaxTreatment.TaxPolicyId; the 'default' hint selects TaxPolicy.DefaultTaxTreatmentId", () => {
  assert.equal((chooseRelationship(meta, "TaxTreatment", "TaxPolicy") as { field: string }).field, "TaxPolicyId");
  const d = chooseRelationship(meta, "TaxTreatment", "TaxPolicy", "default");
  assert.equal(d.status, "ok");
  assert.deepEqual([(d as { field: string }).field, (d as { on: string }).on], ["DefaultTaxTreatmentId", "target"]);
});

test("ASSIGN: falls back to a field on the target (engine → treatment = TaxTreatment.TaxEngineId)", () => {
  const r = chooseRelationship(meta, "TaxEngine", "TaxTreatment");
  assert.deepEqual(r, { status: "ok", field: "TaxEngineId", label: "Tax Engine ID", on: "target" });
});

test("ASSIGN: more than one candidate field is never guessed — ambiguous; an explicit field must be a real candidate", () => {
  const r = chooseRelationship(meta, "Account", "TaxPolicy");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual((r as { options: { field: string }[] }).options.map(o => o.field), ["PrimaryPolicyId", "SecondaryPolicyId"]);
  assert.equal((chooseRelationship(meta, "Account", "TaxPolicy", null, "SecondaryPolicyId") as { field: string }).field, "SecondaryPolicyId");
  assert.equal(chooseRelationship(meta, "Account", "TaxPolicy", null, "MadeUpId").status, "none");
});

test("ASSIGN: objects with no reference between them are refused (OwnerId is never a candidate)", () => {
  assert.equal(chooseRelationship(meta, "GeoCountry", "TaxPolicy").status, "none");
  assert.equal(chooseRelationship(meta, "TaxPolicy", "User").status, "none");
});

test("fields: labels and API names map onto describe; unknown fields are reported, not invented", () => {
  const r = mapFieldKeys(meta, "TaxRate", { "Tax Code": "GST18", rate: 18, StartDate: "2026-11-01", Colour: "red" });
  assert.deepEqual(r.mapped, { TaxCode: "GST18", Rate: 18, StartDate: "2026-11-01" });
  assert.deepEqual(r.unknown, ["Colour"]);
  assert.deepEqual(mapFieldKeys(meta, "Product2", { "Tax Policy": "X" }).mapped, { TaxPolicyId: "X" });
});

test("values: picklists (value or label, exact Salesforce value), numbers, dates and booleans are validated", () => {
  assert.deepEqual(coerceValue(meta.objects.TaxRate.exists ? (meta.objects.TaxRate as ObjectMeta).fields.RateUsageType : f("x"), "revcloud"), { ok: true, value: "RevCloud" });
  assert.equal(coerceValue((meta.objects.TaxRate as ObjectMeta).fields.RateUsageType, "Nope").ok, false);
  assert.deepEqual(coerceValue((meta.objects.TaxRate as ObjectMeta).fields.Rate, "12%"), { ok: true, value: 12 });
  assert.equal(coerceValue((meta.objects.TaxRate as ObjectMeta).fields.Rate, "twelve").ok, false);
  assert.equal(coerceValue((meta.objects.TaxRate as ObjectMeta).fields.StartDate, "1 Nov").ok, false);
  assert.deepEqual(coerceValue((meta.objects.TaxTreatment as ObjectMeta).fields.IsTaxable, "yes"), { ok: true, value: true });
});

test("duplicate prevention: identifying dimensions per object (incl. Salesforce's own treatment and item rules)", () => {
  assert.deepEqual(DUPLICATE_RULES.TaxPolicy[0].keys, ["Name"]);
  assert.deepEqual(DUPLICATE_RULES.TaxEngine[0].keys, ["TaxEngineName"]);
  assert.deepEqual(DUPLICATE_RULES.TaxTreatment.map(r => r.keys), [["Name", "TaxPolicyId"], ["TaxCode", "TaxPolicyId", "TaxEngineId", "LegalEntityId", "ProductCode"]]);
  assert.deepEqual(DUPLICATE_RULES.TaxTreatmentItem[0].keys, ["TaxTreatmentId", "ProductId"]);
  assert.deepEqual(DUPLICATE_RULES.TaxRate[0].keys, ["TaxCode", "GeoCountryId", "GeoStateId", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis"]);
  assert.deepEqual(DUPLICATE_RULES.GeoCountry[0].keys, ["IsoCode"]);
});

test("AI: operations are normalized — Ids dropped, unknown ops/objects ignored, lookups reduced to names", () => {
  const { operations, warnings } = operationsFromAi({
    operations: [
      { op: "assign", object: "Product2", target: { name: "Laptop Basic", id: "01tg80000072GsfAAE" }, relation: { object: "TaxPolicy", target: { name: "India GST Policy" } } },
      { op: "update", object: "TaxRate", target: { taxCode: "GST18" }, fields: { Rate: 12, GeoCountryId: "0vfg80000001P9FAAU" }, date: "2026-11-01" },
      { op: "end_date", object: "TaxRate", target: "GST5", date: "2026-12-31" },
      { op: "explode", object: "TaxRate" },
      { op: "delete", object: "InvoiceLineTax", target: { name: "x" } },
    ],
  });
  assert.equal(operations.length, 3);
  assert.equal(operations[0].target?.id, undefined);
  assert.equal(operations[0].target?.name, "Laptop Basic");
  assert.equal(operations[0].relation?.object, "TaxPolicy");
  assert.deepEqual(operations[1].fields, { Rate: 12 });
  assert.equal(operations[1].date, "2026-11-01");
  assert.equal(operations[2].op, "end-date");
  assert.equal(operations[2].target?.name, "GST5");
  assert.ok(warnings.some(w => /Ids/.test(w)) && warnings.some(w => /explode/.test(w)) && warnings.some(w => /InvoiceLineTax/.test(w)));
});

test("AI: the system prompt is grounded in this org's metadata (fields, picklists, create-only flags)", () => {
  const brief = metadataBrief(meta);
  assert.match(brief, /TaxRate \(TaxRate\): .*TaxCode:string\(create-only\)/);
  assert.match(brief, /RateUsageType\[Commerce\|RevCloud\]/);
  assert.match(brief, /DefaultTaxTreatmentId→TaxTreatment/);
  assert.doesNotMatch(brief, /OwnerId/);
  assert.match(brief, /GeoState: \(not available in this org\)/);
  assert.match(assistantSystemPrompt(meta), /NEVER output Salesforce Ids/);
});
