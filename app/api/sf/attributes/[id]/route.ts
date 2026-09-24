import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadAttributeDetail, loadPicklistValueRecords } from "@/lib/attributes/server/attributeDetail";
import {
  updateAttributeCoreFields, addPicklistValue, updatePicklistValue, removePicklistValue, reactivatePicklistValue,
  updateProductAttributeConfig, validateTypedValue,
  type AttributeFieldPatch, type ProductAttributeConfigPatch,
} from "@/lib/attributes/server/attributeUpdate";
import type { AttributeDetail } from "@/lib/attributes/types";

type Params = { params: Promise<{ id: string }> };

/** GET /api/sf/attributes/[id] — full current Salesforce state for Attribute Detail/Edit. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;

  try {
    const attribute = await loadAttributeDetail(auth.client, id);
    return NextResponse.json({ success: true, attribute });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load attribute");
  }
}

interface AttributePatchBody {
  patch?: AttributeFieldPatch;
  /** New picklist values to add, in display order. */
  addValues?: string[];
  /** Existing AttributePicklistValue Ids to remove (deactivated or deleted depending on org schema — see removePicklistValue). */
  removeValueIds?: string[];
  /** Rename an existing value (by its AttributePicklistValue Id) — updates Name, Value and DisplayValue. */
  updateValues?: { id: string; displayValue: string }[];
  /** Per-product configuration changes, by ProductAttributeDefinition Id. */
  productConfigs?: ProductAttributeConfigPatch[];
}

type Issue = { step: string; error: string };

const norm = (s: string) => s.trim().toLowerCase();

function isNumericType(dataType: string | null): boolean {
  return ["number", "currency", "percent"].includes((dataType ?? "").toLowerCase());
}

/**
 * PATCH /api/sf/attributes/[id] — updates the EXISTING AttributeDefinition,
 * its picklist values and its per-product configuration; never creates a
 * new attribute.
 *
 * 1. Validate EVERYTHING against the current Salesforce state first (Ids
 *    belong to this attribute, typed values, ranges, duplicate values). Any
 *    validation error → 422 with no write at all, so an invalid edit never
 *    half-applies.
 * 2. Apply writes by record Id; each write re-reads its record and fails if
 *    Salesforce didn't keep the value.
 * 3. success is true ONLY if every requested write was confirmed; the
 *    response always carries the fresh post-save Salesforce state.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let body: AttributePatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  let current: AttributeDetail;
  try {
    current = await loadAttributeDetail(client, id);
  } catch (err) {
    return sfErrorResponse(err, "Failed to load attribute");
  }

  const addValues = (body.addValues ?? []).map(v => v.trim()).filter(Boolean);
  const updateValues = (body.updateValues ?? []).map(u => ({ id: u.id, text: u.displayValue.trim() }));
  const removeValueIds = body.removeValueIds ?? [];
  const productConfigs = body.productConfigs ?? [];

  /* ── 1. Validation (no writes) ── */
  const invalid: Issue[] = [];

  if (body.patch?.name !== undefined && !body.patch.name.trim()) invalid.push({ step: "attribute", error: "Attribute Name can't be empty." });
  const dvError = validateTypedValue(current.dataType, "Default Value", body.patch?.defaultValue);
  if (dvError) invalid.push({ step: "defaultValue", error: dvError });

  const configById = new Map(current.productConfigs.map(c => [c.id, c]));
  for (const cfg of productConfigs) {
    const existing = configById.get(cfg.id);
    if (!existing) { invalid.push({ step: `productConfig:${cfg.id}`, error: `Product configuration ${cfg.id} does not belong to this attribute.` }); continue; }
    const label = existing.productName ?? cfg.id;
    for (const [key, lbl] of [["defaultValue", "Default Value"], ["minimumValue", "Minimum"], ["maximumValue", "Maximum"], ["stepValue", "Step"]] as const) {
      const e = key === "defaultValue"
        ? validateTypedValue(current.dataType, `${label} ${lbl}`, cfg[key])
        : (isNumericType(current.dataType) ? validateTypedValue("Number", `${label} ${lbl}`, cfg[key]) : null);
      if (e) invalid.push({ step: `productConfig:${cfg.id}`, error: e });
    }
    if (isNumericType(current.dataType)) {
      const pick = (k: "defaultValue" | "minimumValue" | "maximumValue") => {
        const v = cfg[k] !== undefined ? cfg[k] : existing[k];
        return v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v);
      };
      const [dv, min, max] = [pick("defaultValue"), pick("minimumValue"), pick("maximumValue")];
      if (min !== null && max !== null && min > max) invalid.push({ step: `productConfig:${cfg.id}`, error: `${label}: Minimum (${min}) can't be greater than Maximum (${max}).` });
      if (dv !== null && min !== null && dv < min) invalid.push({ step: `productConfig:${cfg.id}`, error: `${label}: Default Value (${dv}) is below the Minimum (${min}).` });
      if (dv !== null && max !== null && dv > max) invalid.push({ step: `productConfig:${cfg.id}`, error: `${label}: Default Value (${dv}) is above the Maximum (${max}).` });
    }
  }

  // Picklist: validate against ALL records on the picklist (active + inactive).
  const reactivations: { id: string; text: string }[] = [];
  const creations: string[] = [];
  let nextSequence = 1;
  if (addValues.length || updateValues.length || removeValueIds.length) {
    if (!current.picklistId) {
      invalid.push({ step: "picklistValues", error: "This attribute has no picklist, so its values can't be added, renamed or removed." });
    } else {
      let records: Awaited<ReturnType<typeof loadPicklistValueRecords>> = [];
      try {
        records = await loadPicklistValueRecords(client, current.picklistId);
      } catch (err) {
        return sfErrorResponse(err, "Could not read this attribute's picklist values");
      }
      nextSequence = records.reduce((m, r) => Math.max(m, r.sequence), 0) + 1;
      const byId = new Map(records.map(r => [r.id, r]));

      for (const rid of removeValueIds) {
        if (!byId.get(rid)?.isActive) invalid.push({ step: `removeValue:${rid}`, error: `Value ${rid} is not an active value of this attribute.` });
      }
      for (const u of updateValues) {
        if (!u.text) invalid.push({ step: `updateValue:${u.id}`, error: "A picklist value can't be renamed to an empty value." });
        if (!byId.get(u.id)?.isActive) invalid.push({ step: `updateValue:${u.id}`, error: `Value ${u.id} is not an active value of this attribute.` });
      }

      // The set of texts that will be ACTIVE after this save, for duplicate detection.
      const removed = new Set(removeValueIds);
      const renamedTo = new Map(updateValues.map(u => [u.id, u.text]));
      const finalActive = new Map<string, string>(); // norm(text) -> owner description
      for (const r of records) {
        if (!r.isActive || removed.has(r.id)) continue;
        const text = renamedTo.get(r.id) ?? r.texts[0] ?? "";
        const key = norm(text);
        if (finalActive.has(key)) invalid.push({ step: `updateValue:${r.id}`, error: `"${text}" already exists on this attribute — two values can't have the same text.` });
        finalActive.set(key, r.id);
      }
      for (const text of addValues) {
        const key = norm(text);
        if (finalActive.has(key)) { invalid.push({ step: `addValue:${text}`, error: `"${text}" already exists on this attribute — it was not added again.` }); continue; }
        finalActive.set(key, "new");
        // A previously removed (Inactive) record with this exact text is restored, not duplicated.
        const inactive = records.find(r => !r.isActive && !removed.has(r.id) && r.texts.some(t => norm(t) === key));
        if (inactive) reactivations.push({ id: inactive.id, text });
        else creations.push(text);
      }
    }
  }

  if (invalid.length > 0) {
    return NextResponse.json(
      { success: false, salesforceId: id, steps: {}, errors: invalid, skipped: [], attribute: current, validationFailed: true },
      { status: 422 },
    );
  }

  /* ── 2. Writes, each verified by read-back ── */
  const errors: Issue[] = [];
  const skipped: { step: string; reason: string }[] = [];
  const steps: Record<string, unknown> = {};

  if (body.patch && Object.keys(body.patch).length > 0) {
    const result = await updateAttributeCoreFields(client, id, body.patch);
    Object.assign(steps, result.steps);
    errors.push(...result.errors);
    skipped.push(...result.skipped);
  }

  let removedCount = 0;
  for (const valueId of removeValueIds) {
    const result = await removePicklistValue(client, valueId);
    if ("error" in result) errors.push({ step: `removeValue:${valueId}`, error: result.error });
    else removedCount++;
  }
  if (removedCount) steps.removedValues = { count: removedCount };

  let renamedCount = 0;
  for (const u of updateValues) {
    const result = await updatePicklistValue(client, u.id, u.text);
    if ("error" in result) errors.push({ step: `updateValue:${u.id}`, error: result.error });
    else renamedCount++;
  }
  if (renamedCount) steps.updatedValues = { count: renamedCount };

  let restoredCount = 0;
  for (const r of reactivations) {
    const result = await reactivatePicklistValue(client, r.id, r.text);
    if ("error" in result) errors.push({ step: `addValue:${r.text}`, error: result.error });
    else restoredCount++;
  }
  if (restoredCount) steps.restoredValues = { count: restoredCount };

  let addedCount = 0;
  for (const text of creations) {
    const result = await addPicklistValue(client, current.picklistId!, text, nextSequence++);
    if ("error" in result) errors.push({ step: `addValue:${text}`, error: result.error });
    else addedCount++;
  }
  if (addedCount) steps.addedValues = { count: addedCount };

  let configCount = 0;
  for (const cfg of productConfigs) {
    const result = await updateProductAttributeConfig(client, cfg);
    if ("error" in result) errors.push({ step: `productConfig:${cfg.id}`, error: result.error });
    else if (result.updated.length) configCount++;
  }
  if (configCount) steps.productConfigs = { count: configCount };

  // Decided BEFORE the post-save refresh, so a read-only refresh failure never
  // downgrades a verified success (or hides a real failure).
  const success = errors.length === 0;
  const partialSuccess = !success && Object.keys(steps).length > 0;

  let attribute: AttributeDetail | null = null;
  let refreshError: string | null = null;
  try {
    attribute = await loadAttributeDetail(client, id);
  } catch (err) {
    refreshError = err instanceof Error ? err.message : "Saved, but could not re-load the attribute afterward.";
  }

  return NextResponse.json(
    { success, salesforceId: id, steps, errors, skipped, attribute, refreshError },
    { status: success ? 200 : (partialSuccess ? 207 : 422) },
  );
}
