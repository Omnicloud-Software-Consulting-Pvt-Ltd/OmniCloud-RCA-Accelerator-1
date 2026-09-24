import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { resolveAttributeSchema, fieldExists, isFieldUpdateable } from "./schema";

export interface AttributeFieldPatch {
  name?: string;
  label?: string;
  description?: string;
  isActive?: boolean;
  /** Only applied if the org's AttributeDefinition datatype field is actually updateable — see AttributeDetail.dataTypeEditable. */
  dataType?: string;
  /** AttributeDefinition.DefaultValue — the attribute's own configured value (Number/Text/Checkbox/…). "" clears it. */
  defaultValue?: string;
}

/** Product-level configuration on ProductAttributeDefinition — where a Number attribute's per-product value/range lives. */
export interface ProductAttributeConfigPatch {
  id: string;
  defaultValue?: string;
  minimumValue?: string;
  maximumValue?: string;
  stepValue?: string;
}

export interface AttributePatchResult {
  steps: Record<string, unknown>;
  errors: { step: string; error: string }[];
  skipped: { step: string; reason: string }[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Verification — nothing here reports success until Salesforce itself returns
 * the expected value on a fresh read of the SAME record Id.
 * ─────────────────────────────────────────────────────────────────────────── */

function sameValue(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === "") return actual === null || actual === undefined || actual === "";
  if (typeof expected === "number") return Number(actual) === expected;
  if (typeof expected === "boolean") return actual === expected;
  return String(actual ?? "") === String(expected);
}

/** Re-reads `id` and returns a description of every field that doesn't hold the value just written, or null if all match. */
export async function verifyRecordFields(
  client: SalesforceClient,
  sobject: string,
  id: string,
  expected: Record<string, unknown>,
): Promise<string | null> {
  const fields = Object.keys(expected);
  if (fields.length === 0) return null;
  const res = await client.query<Record<string, unknown>>(
    `SELECT ${fields.join(", ")} FROM ${sobject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`,
  );
  const row = res.records[0];
  if (!row) return `${sobject} ${id} could not be read back after saving.`;
  const mismatches = fields
    .filter(f => !sameValue(row[f], expected[f]))
    .map(f => `${f} is "${row[f] ?? ""}" (expected "${expected[f] ?? ""}")`);
  return mismatches.length ? `Salesforce did not keep the change on ${sobject} ${id}: ${mismatches.join("; ")}` : null;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Value validation by data type — run BEFORE any write so an invalid edit
 * never half-applies.
 * ─────────────────────────────────────────────────────────────────────────── */

export function validateTypedValue(dataType: string | null, label: string, value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const dt = (dataType ?? "").toLowerCase();
  if (["number", "currency", "percent"].includes(dt) && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return `${label} must be a number for a ${dataType} attribute — "${value}" is not.`;
  }
  if (dt === "checkbox" && !/^(true|false)$/i.test(value.trim())) {
    return `${label} must be "true" or "false" for a Checkbox attribute — "${value}" is not.`;
  }
  if (dt === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return `${label} must be a date (YYYY-MM-DD) — "${value}" is not.`;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * AttributeDefinition core fields
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Updates the EXISTING AttributeDefinition record — never creates a new
 * one. Only touches fields present in the patch, skips immutable ones, and
 * verifies every written field by reading the record back.
 */
export async function updateAttributeCoreFields(
  client: SalesforceClient,
  id: string,
  patch: AttributeFieldPatch,
): Promise<AttributePatchResult> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributeDefinitionDescribe;
  const steps: Record<string, unknown> = {};
  const errors: { step: string; error: string }[] = [];
  const skipped: { step: string; reason: string }[] = [];

  const coreFields: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    coreFields.Name = patch.name;
    // Label is what Revenue Cloud's own UI and the product configurator display. Creation sets it
    // equal to Name; keep it in step on rename (unless it was deliberately customised), otherwise a
    // "renamed" attribute keeps showing its old name everywhere outside this app.
    if (patch.label === undefined && isFieldUpdateable(d, "Label")) {
      try {
        const cur = await client.query<{ Name: string; Label: string | null }>(`SELECT Name, Label FROM AttributeDefinition WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
        const row = cur.records[0];
        if (row && (row.Label ?? "") === row.Name) coreFields.Label = patch.name;
      } catch { /* leave Label alone if it can't be read */ }
    }
  }
  if (patch.label !== undefined && fieldExists(d, "Label")) coreFields.Label = patch.label;
  if (patch.description !== undefined && fieldExists(d, "Description")) coreFields.Description = patch.description;
  if (patch.isActive !== undefined) coreFields.IsActive = patch.isActive;
  if (patch.defaultValue !== undefined) {
    if (isFieldUpdateable(d, "DefaultValue")) coreFields.DefaultValue = patch.defaultValue === "" ? null : patch.defaultValue;
    else skipped.push({ step: "defaultValue", reason: "This org does not allow editing AttributeDefinition.DefaultValue." });
  }

  if (patch.dataType !== undefined) {
    if (schema.attrDefDatatypeField && isFieldUpdateable(d, schema.attrDefDatatypeField)) {
      coreFields[schema.attrDefDatatypeField] = patch.dataType;
    } else {
      skipped.push({ step: "dataType", reason: "This org does not allow changing an existing Attribute's data type." });
    }
  }

  if (Object.keys(coreFields).length > 0) {
    try {
      await client.updateRecord("AttributeDefinition", id, coreFields);
      const mismatch = await verifyRecordFields(client, "AttributeDefinition", id, coreFields);
      if (mismatch) errors.push({ step: "attribute", error: mismatch });
      else steps.attribute = { id, updated: Object.keys(coreFields) };
    } catch (err) {
      errors.push({ step: "attribute", error: errMessage(err, "Failed to update attribute") });
    }
  }

  return { steps, errors, skipped };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * AttributePicklistValue — add / rename / reactivate / remove
 * ─────────────────────────────────────────────────────────────────────────── */

function codeSegment(s: string): string {
  return s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * AttributePicklistValue.Code is REQUIRED and UNIQUE org-wide (verified via
 * describe) — the missing Code is exactly why "Add Value" always failed with
 * "Required fields are missing: [Code]". Scoped to the owning picklist's own
 * Code so two attributes' identical values never collide, then probed for
 * uniqueness with a numeric suffix.
 */
async function uniquePicklistValueCode(client: SalesforceClient, picklistId: string, value: string, maxLen: number): Promise<string> {
  let prefix = picklistId;
  try {
    const pl = await client.query<{ Code: string | null; Name: string }>(`SELECT Code, Name FROM AttributePicklist WHERE Id = '${soqlEscape(picklistId)}' LIMIT 1`);
    const row = pl.records[0];
    if (row) prefix = row.Code || row.Name;
  } catch { /* fall back to the picklist Id as the scope */ }
  const base = `${codeSegment(prefix)}_${codeSegment(value) || "VALUE"}`.slice(0, maxLen);
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, maxLen - String(n).length - 1)}_${n}`;
    const taken = await client.query<{ Id: string }>(`SELECT Id FROM AttributePicklistValue WHERE Code = '${soqlEscape(candidate)}' LIMIT 1`);
    if (taken.records.length === 0) return candidate;
  }
  throw new Error(`Could not generate a unique Code for picklist value "${value}".`);
}

function fieldLength(d: DescribeResult | null, name: string, fallback: number): number {
  return d?.fields.find(f => f.name === name)?.length || fallback;
}

/** The label fields a picklist value's text lives in — ALL of them must change together on a rename. */
function valueTextFields(d: DescribeResult | null, text: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const f of ["Name", "Value", "DisplayValue"]) {
    if (fieldExists(d, f)) raw[f] = text;
  }
  return raw;
}

/** Add a new value to an existing attribute's picklist, then verify it by reading it back. */
export async function addPicklistValue(
  client: SalesforceClient,
  picklistId: string,
  value: string,
  sequence: number,
): Promise<{ id: string } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;
  const raw: Record<string, unknown> = { [schema.plValueFKField]: picklistId, ...valueTextFields(d, value) };
  if (fieldExists(d, "Sequence")) raw.Sequence = sequence;
  if (fieldExists(d, "Status")) raw.Status = "Active";
  if (fieldExists(d, "IsActive")) raw.IsActive = true;
  if (fieldExists(d, "IsDefault")) raw.IsDefault = false;

  try {
    if (fieldExists(d, "Code")) raw.Code = await uniquePicklistValueCode(client, picklistId, value, fieldLength(d, "Code", 255));
    const result = await client.createRecord("AttributePicklistValue", raw);
    if (!result.success) return { error: JSON.stringify(result.errors) };
    const check = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "Code"));
    const mismatch = await verifyRecordFields(client, "AttributePicklistValue", result.id, check);
    if (mismatch) return { error: mismatch };
    return { id: result.id };
  } catch (err) {
    return { error: errMessage(err, "Failed to add picklist value") };
  }
}

/**
 * Rename an existing picklist value by its record Id. Updates Name, Value
 * AND DisplayValue — previously only DisplayValue changed, so Salesforce kept
 * "Bluetooth 123" as the stored Value/Name (what the configurator and pricing
 * match on) while this app displayed "Bluetooth 456". Code is left as-is: it
 * is the record's stable unique identifier, not display text.
 */
export async function updatePicklistValue(
  client: SalesforceClient,
  valueId: string,
  newText: string,
): Promise<{ success: true } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;
  const raw = valueTextFields(d, newText);
  if (Object.keys(raw).length === 0) return { error: "This org exposes no editable text field on picklist values." };

  try {
    await client.updateRecord("AttributePicklistValue", valueId, raw);
    const mismatch = await verifyRecordFields(client, "AttributePicklistValue", valueId, raw);
    return mismatch ? { error: mismatch } : { success: true };
  } catch (err) {
    return { error: errMessage(err, "Failed to update picklist value") };
  }
}

/** Re-activate a previously removed (Inactive) value instead of creating a duplicate record for the same text. */
export async function reactivatePicklistValue(
  client: SalesforceClient,
  valueId: string,
  text: string,
): Promise<{ success: true } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;
  const raw: Record<string, unknown> = { ...valueTextFields(d, text) };
  if (fieldExists(d, "Status")) raw.Status = "Active";
  else if (fieldExists(d, "IsActive")) raw.IsActive = true;
  try {
    await client.updateRecord("AttributePicklistValue", valueId, raw);
    const mismatch = await verifyRecordFields(client, "AttributePicklistValue", valueId, raw);
    return mismatch ? { error: mismatch } : { success: true };
  } catch (err) {
    return { error: errMessage(err, "Failed to restore picklist value") };
  }
}

/** Remove a picklist value — deactivates (Status/IsActive) when the org supports it (preserving history for any existing runtime references), hard-deletes only as a last resort. Verified by read-back. */
export async function removePicklistValue(
  client: SalesforceClient,
  valueId: string,
): Promise<{ success: true; mode: "deactivated" | "deleted" } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;

  try {
    if (fieldExists(d, "Status")) {
      await client.updateRecord("AttributePicklistValue", valueId, { Status: "Inactive" });
      const mismatch = await verifyRecordFields(client, "AttributePicklistValue", valueId, { Status: "Inactive" });
      return mismatch ? { error: mismatch } : { success: true, mode: "deactivated" };
    }
    if (fieldExists(d, "IsActive")) {
      await client.updateRecord("AttributePicklistValue", valueId, { IsActive: false });
      const mismatch = await verifyRecordFields(client, "AttributePicklistValue", valueId, { IsActive: false });
      return mismatch ? { error: mismatch } : { success: true, mode: "deactivated" };
    }
    await client.deleteRecord("AttributePicklistValue", valueId);
    return { success: true, mode: "deleted" };
  } catch (err) {
    return { error: errMessage(err, "Failed to remove picklist value") };
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ProductAttributeDefinition — per-product configuration
 * ─────────────────────────────────────────────────────────────────────────── */

const PAD_FIELD_MAP: Record<Exclude<keyof ProductAttributeConfigPatch, "id">, string> = {
  defaultValue: "DefaultValue",
  minimumValue: "MinimumValue",
  maximumValue: "MaximumValue",
  stepValue: "StepValue",
};

/** Updates one ProductAttributeDefinition by Id (never by product/attribute name) and verifies it. */
export async function updateProductAttributeConfig(
  client: SalesforceClient,
  cfg: ProductAttributeConfigPatch,
): Promise<{ success: true; updated: string[] } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.productAttributeDefinitionDescribe;
  const raw: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(PAD_FIELD_MAP) as [keyof typeof PAD_FIELD_MAP, string][]) {
    const v = cfg[key];
    if (v === undefined) continue;
    if (!isFieldUpdateable(d, field)) return { error: `ProductAttributeDefinition.${field} is not editable in this org.` };
    raw[field] = v === "" ? null : v;
  }
  if (Object.keys(raw).length === 0) return { success: true, updated: [] };
  try {
    await client.updateRecord("ProductAttributeDefinition", cfg.id, raw);
    const mismatch = await verifyRecordFields(client, "ProductAttributeDefinition", cfg.id, raw);
    return mismatch ? { error: mismatch } : { success: true, updated: Object.keys(raw) };
  } catch (err) {
    return { error: errMessage(err, "Failed to update product attribute configuration") };
  }
}
