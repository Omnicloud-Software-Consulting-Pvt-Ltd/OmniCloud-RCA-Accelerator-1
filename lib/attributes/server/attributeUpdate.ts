import type { SalesforceClient } from "@/lib/salesforce/client";
import { resolveAttributeSchema, fieldExists, isFieldUpdateable } from "./schema";

export interface AttributeFieldPatch {
  name?: string;
  label?: string;
  description?: string;
  isActive?: boolean;
  /** Only applied if the org's AttributeDefinition datatype field is actually updateable — see AttributeDetail.dataTypeEditable. */
  dataType?: string;
}

export interface AttributePatchResult {
  steps: Record<string, unknown>;
  errors: { step: string; error: string }[];
  skipped: { step: string; reason: string }[];
}

/**
 * Updates the EXISTING AttributeDefinition record — never creates a new
 * one. Mirrors PATCH /api/bundles/[id]'s "only touch fields present in the
 * patch, skip immutable ones" convention. Reuses the same field-existence
 * discovery (lib/attributes/server/schema.ts) the read side already uses so
 * Edit Attribute never guesses a field name independently from Detail.
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
  if (patch.name !== undefined) coreFields.Name = patch.name;
  if (patch.label !== undefined && fieldExists(d, "Label")) coreFields.Label = patch.label;
  if (patch.description !== undefined && fieldExists(d, "Description")) coreFields.Description = patch.description;
  if (patch.isActive !== undefined) coreFields.IsActive = patch.isActive;

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
      steps.attribute = { id, updated: Object.keys(coreFields) };
    } catch (err) {
      errors.push({ step: "attribute", error: err instanceof Error ? err.message : "Failed to update attribute" });
    }
  }

  return { steps, errors, skipped };
}

/** Add a new value to an existing attribute's picklist. Requires the attribute to already have a PicklistId — Edit Attribute only offers this for picklist-type attributes. */
export async function addPicklistValue(
  client: SalesforceClient,
  picklistId: string,
  value: string,
  sequence: number,
): Promise<{ id: string } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;
  const raw: Record<string, unknown> = { [schema.plValueFKField]: picklistId };
  if (fieldExists(d, "Name")) raw.Name = value;
  if (fieldExists(d, "Value")) raw.Value = value;
  if (fieldExists(d, "DisplayValue")) raw.DisplayValue = value;
  if (fieldExists(d, "Sequence")) raw.Sequence = sequence;
  if (fieldExists(d, "Status")) raw.Status = "Active";

  try {
    const result = await client.createRecord("AttributePicklistValue", raw);
    if (!result.success) return { error: JSON.stringify(result.errors) };
    return { id: result.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to add picklist value" };
  }
}

/** Rename an existing picklist value's display text. */
export async function updatePicklistValue(
  client: SalesforceClient,
  valueId: string,
  displayValue: string,
): Promise<{ success: true } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;
  const raw: Record<string, unknown> = {};
  if (fieldExists(d, "DisplayValue")) raw.DisplayValue = displayValue;
  else if (fieldExists(d, "Name")) raw.Name = displayValue;
  if (Object.keys(raw).length === 0) return { error: "This org exposes no editable label field on picklist values." };

  try {
    await client.updateRecord("AttributePicklistValue", valueId, raw);
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to update picklist value" };
  }
}

/** Remove a picklist value — deactivates (Status/IsActive) when the org supports it (preserving history for any existing runtime references), hard-deletes only as a last resort. */
export async function removePicklistValue(
  client: SalesforceClient,
  valueId: string,
): Promise<{ success: true; mode: "deactivated" | "deleted" } | { error: string }> {
  const schema = await resolveAttributeSchema(client);
  const d = schema.attributePicklistValueDescribe;

  try {
    if (fieldExists(d, "Status")) {
      await client.updateRecord("AttributePicklistValue", valueId, { Status: "Inactive" });
      return { success: true, mode: "deactivated" };
    }
    if (fieldExists(d, "IsActive")) {
      await client.updateRecord("AttributePicklistValue", valueId, { IsActive: false });
      return { success: true, mode: "deactivated" };
    }
    await client.deleteRecord("AttributePicklistValue", valueId);
    return { success: true, mode: "deleted" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to remove picklist value" };
  }
}
