import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

/**
 * Product-level bundle relationship helpers — extracted from
 * app/api/bundles/execute/route.ts's own `createRelationship()` (the
 * existing Create Bundle flow, untouched) so the new Bundle Edit/Detail
 * routes write/read the EXACT SAME ProductRelatedComponent shape instead of
 * a second implementation. Create Bundle already commits to
 * ProductRelatedComponent directly (not the dynamically-discovered object
 * lib/quotes/bundles/expansion.ts uses for Quote line-item expansion, a
 * different concern) — Bundle Edit mirrors that same, already-shipped
 * convention rather than introducing a second bundle-relationship engine.
 */

export interface BundleComponentRow {
  relationshipId: string;
  childProductId: string;
  childName: string;
  childProductCode: string | null;
  childType: string | null;
  /** Standard-pricebook UnitPrice for this child, if a PricebookEntry exists. Never fabricated — null when none. */
  childPrice: number | null;
  /** This child's own ProductSellingModelOption name, if any. Never fabricated — null when none. */
  childSellingModel: string | null;
  sequence: number;
  isDefaultComponent: boolean;
  isComponentRequired: boolean;
  relationshipTypeId: string | null;
}

/** Same lookup Create Bundle's Batch 3 performs — reused so Edit resolves the identical relationship type. */
export async function resolveRelationshipTypeId(client: SalesforceClient): Promise<string | null> {
  try {
    const rtRes = await client.query<{ Id: string }>(
      "SELECT Id FROM ProductRelationshipType WHERE Name = 'Bundle to Bundle Component Relationship' LIMIT 1",
    );
    if (rtRes.records.length > 0) return rtRes.records[0].Id;
    const fallback = await client.query<{ Id: string }>("SELECT Id FROM ProductRelationshipType LIMIT 1");
    return fallback.records[0]?.Id ?? null;
  } catch {
    return null;
  }
}

export async function resolveStandardPricebookId(client: SalesforceClient): Promise<string | null> {
  try {
    const res = await client.query<{ Id: string }>("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
    return res.records[0]?.Id ?? null;
  } catch {
    return null;
  }
}

/** All direct ProductRelatedComponent rows for a bundle, with the child's own core fields resolved — the read side Bundle History/Detail/Edit share. */
export async function loadBundleComponents(client: SalesforceClient, parentProductId: string): Promise<BundleComponentRow[]> {
  const relResult = await client.query<{
    Id: string; ChildProductId: string; Sequence: number | null;
    IsDefaultComponent: boolean | null; IsComponentRequired: boolean | null; ProductRelationshipTypeId: string | null;
  }>(
    `SELECT Id, ChildProductId, Sequence, IsDefaultComponent, IsComponentRequired, ProductRelationshipTypeId ` +
    `FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(parentProductId)}' ORDER BY Sequence`,
  );
  if (relResult.records.length === 0) return [];

  const childIdList = relResult.records.map(r => `'${soqlEscape(r.ChildProductId)}'`).join(",");
  const childResult = await client.query<{ Id: string; Name: string; ProductCode: string | null; Type: string | null }>(
    `SELECT Id, Name, ProductCode, Type FROM Product2 WHERE Id IN (${childIdList})`,
  );
  const childById = new Map(childResult.records.map(c => [c.Id, c]));

  const priceByChildId = new Map<string, number>();
  try {
    const pbeResult = await client.query<{ Product2Id: string; UnitPrice: number }>(
      `SELECT Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${childIdList}) AND Pricebook2.IsStandard = true LIMIT 500`,
    );
    for (const pbe of pbeResult.records) priceByChildId.set(pbe.Product2Id, pbe.UnitPrice);
  } catch { /* PricebookEntry may not be accessible — leave prices null rather than guessing */ }

  const sellingModelByChildId = new Map<string, string>();
  try {
    const psmResult = await client.query<{ Product2Id: string; ProductSellingModel: { Name: string } | null }>(
      `SELECT Product2Id, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id IN (${childIdList}) LIMIT 500`,
    );
    for (const psm of psmResult.records) {
      const name = psm.ProductSellingModel?.Name;
      if (name) sellingModelByChildId.set(psm.Product2Id, name);
    }
  } catch { /* ProductSellingModelOption may not be accessible — leave selling models null rather than guessing */ }

  return relResult.records.map(r => {
    const child = childById.get(r.ChildProductId);
    return {
      relationshipId: r.Id,
      childProductId: r.ChildProductId,
      childName: child?.Name ?? "Unknown Product",
      childProductCode: child?.ProductCode ?? null,
      childType: child?.Type ?? null,
      childPrice: priceByChildId.get(r.ChildProductId) ?? null,
      childSellingModel: sellingModelByChildId.get(r.ChildProductId) ?? null,
      sequence: r.Sequence ?? 0,
      isDefaultComponent: r.IsDefaultComponent !== false,
      isComponentRequired: r.IsComponentRequired !== false,
      relationshipTypeId: r.ProductRelationshipTypeId ?? null,
    };
  });
}

/** Create one ProductRelatedComponent row if it doesn't already exist — same check-then-create shape as Create Bundle's own createRelationship(). */
export async function addBundleComponent(
  client: SalesforceClient,
  parentProductId: string,
  childProductId: string,
  opts: { sequence: number; isDefaultComponent?: boolean; isComponentRequired?: boolean; relationshipTypeId?: string | null },
): Promise<{ id: string; action: "created" | "reused" } | { error: string }> {
  const existing = await client.query<{ Id: string }>(
    `SELECT Id FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(parentProductId)}' AND ChildProductId = '${soqlEscape(childProductId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as { Id: string }[] }));
  if (existing.records.length > 0) return { id: existing.records[0].Id, action: "reused" };

  const fields: Record<string, unknown> = {
    ParentProductId: parentProductId,
    ChildProductId: childProductId,
    Sequence: opts.sequence,
    IsDefaultComponent: opts.isDefaultComponent ?? true,
    IsComponentRequired: opts.isComponentRequired ?? true,
  };
  if (opts.relationshipTypeId) fields.ProductRelationshipTypeId = opts.relationshipTypeId;

  const result = await client.createRecord("ProductRelatedComponent", fields);
  if (result.success) return { id: result.id, action: "created" };
  return { error: JSON.stringify(result.errors) };
}

/** Delete a ProductRelatedComponent row by its own Id — the "Remove Product" / half of "Replace Product" operation. */
export async function removeBundleComponent(client: SalesforceClient, relationshipId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await client.deleteRecord("ProductRelatedComponent", relationshipId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to remove component" };
  }
}

/** Update the Required/Optional (IsComponentRequired) flag on an existing component — the one dependency-style signal this org actually persists per component (see Bundle Edit's Dependencies section). */
export async function updateBundleComponentRequired(client: SalesforceClient, relationshipId: string, isRequired: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    await client.updateRecord("ProductRelatedComponent", relationshipId, { IsComponentRequired: isRequired });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to update component" };
  }
}
