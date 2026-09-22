import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadAttributeDetail } from "@/lib/attributes/server/attributeDetail";
import {
  updateAttributeCoreFields, addPicklistValue, updatePicklistValue, removePicklistValue,
  type AttributeFieldPatch,
} from "@/lib/attributes/server/attributeUpdate";

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
  /** Rename an existing value's display text. */
  updateValues?: { id: string; displayValue: string }[];
}

/**
 * PATCH /api/sf/attributes/[id] — updates the EXISTING AttributeDefinition
 * and its picklist values; never creates a new attribute. Mirrors PATCH
 * /api/bundles/[id]'s "only touch what's in the patch" convention.
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

  const errors: { step: string; error: string }[] = [];
  const skipped: { step: string; reason: string }[] = [];
  const steps: Record<string, unknown> = {};

  if (body.patch) {
    const result = await updateAttributeCoreFields(client, id, body.patch);
    Object.assign(steps, result.steps);
    errors.push(...result.errors);
    skipped.push(...result.skipped);
  }

  // Picklist value changes require the attribute's current PicklistId.
  const needsPicklist = (body.addValues?.length ?? 0) > 0 || (body.updateValues?.length ?? 0) > 0;
  if (needsPicklist || (body.removeValueIds?.length ?? 0) > 0) {
    let picklistId: string | null = null;
    // Server-side duplicate guard (non-bypassable, unlike the UI's own
    // check) — `usedLower` tracks every display value currently considered
    // "taken" (lower-cased); `labelById` lets a rename exclude itself from
    // that check while still catching a rename that collides with a
    // DIFFERENT existing value. Both updated live as adds/renames succeed,
    // so within one request a second add/rename can't collide with the
    // first either.
    const usedLower = new Set<string>();
    const labelById = new Map<string, string>();
    let nextSequence = 1;
    if (needsPicklist) {
      try {
        const current = await loadAttributeDetail(client, id);
        picklistId = current.picklistId;
        for (const v of current.picklistValues) {
          const key = v.displayValue.trim().toLowerCase();
          usedLower.add(key);
          labelById.set(v.id, key);
        }
        nextSequence = current.picklistValues.reduce((m, v) => Math.max(m, v.sequence), 0) + 1;
      } catch (err) {
        errors.push({ step: "picklistValues", error: err instanceof Error ? err.message : "Could not resolve this attribute's picklist" });
      }
    }

    if (body.addValues?.length) {
      if (!picklistId) {
        skipped.push({ step: "addValues", reason: "This attribute has no picklist to add values to." });
      } else {
        let added = 0;
        for (const rawValue of body.addValues) {
          const key = rawValue.trim().toLowerCase();
          if (usedLower.has(key)) {
            skipped.push({ step: `addValue:${rawValue}`, reason: `"${rawValue}" already exists on this attribute — it was not added again.` });
            continue;
          }
          const result = await addPicklistValue(client, picklistId, rawValue, nextSequence++);
          if ("error" in result) errors.push({ step: `addValue:${rawValue}`, error: result.error });
          else { added++; usedLower.add(key); }
        }
        if (added > 0) steps.addedValues = { count: added };
      }
    }

    let updated = 0;
    for (const upd of body.updateValues ?? []) {
      const newKey = upd.displayValue.trim().toLowerCase();
      const oldKey = labelById.get(upd.id);
      if (newKey !== oldKey && usedLower.has(newKey)) {
        skipped.push({ step: `updateValue:${upd.id}`, reason: `"${upd.displayValue}" already exists on this attribute — this value was left unrenamed.` });
        continue;
      }
      const result = await updatePicklistValue(client, upd.id, upd.displayValue);
      if ("error" in result) { errors.push({ step: `updateValue:${upd.id}`, error: result.error }); continue; }
      updated++;
      if (oldKey) usedLower.delete(oldKey);
      usedLower.add(newKey);
      labelById.set(upd.id, newKey);
    }
    if (updated > 0) steps.updatedValues = { count: updated };

    let removed = 0;
    for (const valueId of body.removeValueIds ?? []) {
      const result = await removePicklistValue(client, valueId);
      if ("error" in result) errors.push({ step: `removeValue:${valueId}`, error: result.error });
      else removed++;
    }
    if (removed > 0) steps.removedValues = { count: removed };
  }

  // `errors` means a real Salesforce operation the user asked for actually
  // failed — that must never be reported as success (see removed
  // `success: true` — the entire reason edited/added/removed values could
  // silently fail to persist while the UI showed a green toast). This is
  // decided BEFORE the post-save refresh below, so a read-only refresh
  // failure (Salesforce is momentarily unreachable right after a fully
  // successful write) never downgrades a real success into a false failure.
  const success = errors.length === 0;
  const partialSuccess = !success && Object.keys(steps).length > 0;

  // Always return the canonical post-mutation state read straight back from
  // Salesforce — never the client's optimistic local diff — so the caller
  // can re-sync its form even after a partial failure.
  let attribute = null;
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
