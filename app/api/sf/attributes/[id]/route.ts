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
    if (needsPicklist) {
      try {
        const current = await loadAttributeDetail(client, id);
        picklistId = current.picklistId;
      } catch (err) {
        errors.push({ step: "picklistValues", error: err instanceof Error ? err.message : "Could not resolve this attribute's picklist" });
      }
    }

    if (body.addValues?.length) {
      if (!picklistId) {
        skipped.push({ step: "addValues", reason: "This attribute has no picklist to add values to." });
      } else {
        let added = 0;
        for (let i = 0; i < body.addValues.length; i++) {
          const result = await addPicklistValue(client, picklistId, body.addValues[i], i + 1);
          if ("error" in result) errors.push({ step: `addValue:${body.addValues[i]}`, error: result.error });
          else added++;
        }
        if (added > 0) steps.addedValues = { count: added };
      }
    }

    for (const upd of body.updateValues ?? []) {
      const result = await updatePicklistValue(client, upd.id, upd.displayValue);
      if ("error" in result) errors.push({ step: `updateValue:${upd.id}`, error: result.error });
    }
    if (body.updateValues?.length) steps.updatedValues = { count: body.updateValues.length - errors.filter(e => e.step.startsWith("updateValue:")).length };

    let removed = 0;
    for (const valueId of body.removeValueIds ?? []) {
      const result = await removePicklistValue(client, valueId);
      if ("error" in result) errors.push({ step: `removeValue:${valueId}`, error: result.error });
      else removed++;
    }
    if (removed > 0) steps.removedValues = { count: removed };
  }

  return NextResponse.json({ success: true, salesforceId: id, steps, errors, skipped });
}
