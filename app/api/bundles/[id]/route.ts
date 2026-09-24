import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { soqlEscape } from "@/lib/salesforce/client";
import { loadBundleDetail } from "@/lib/bundles/server/bundleDetail";
import {
  addBundleComponent, removeBundleComponent, updateBundleComponentRequired,
  resolveRelationshipTypeId,
} from "@/lib/bundles/server/relationships";
import { findMatchingSellingModels } from "@/lib/products/server/sellingModel";
import { findOrCreate } from "@/lib/products/server/salesforceWrites";
import { checkBundleDuplicate } from "@/lib/bundles/server/duplicateCheck";

type Params = { params: Promise<{ id: string }> };

/** GET /api/bundles/[id] — full current Salesforce structure for Bundle Detail/Edit. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const bundle = await loadBundleDetail(client, id);
    return NextResponse.json({ success: true, bundle });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load bundle");
  }
}

interface BundleFieldPatch {
  name?: string;
  productCode?: string;
  description?: string;
  family?: string;
  isActive?: boolean;
  catalog?: string;
  category?: string;
  sellingModel?: string;
  priceBook?: string;
  basePrice?: string;
  currencyIsoCode?: string;
}

interface BundlePatchBody {
  patch?: BundleFieldPatch;
  /** New Product2 Ids to add as components. */
  addProductIds?: string[];
  /** ProductRelatedComponent Ids to remove. */
  removeRelationshipIds?: string[];
  /** Required/Optional toggles for existing components — the one dependency-style signal this org persists (see Bundle Edit's Dependencies section). */
  requiredUpdates?: { relationshipId: string; isRequired: boolean }[];
  /** "Replace Product" — expanded server-side into remove(old) + add(new), same as the app's own documented Remove→Add fallback. */
  replacements?: { removeRelationshipId: string; addProductId: string }[];
}

/**
 * PATCH /api/bundles/[id] — updates the EXISTING bundle Product2 and its
 * ProductRelatedComponent structure; never creates a new bundle. Reuses
 * the exact same helpers Create Bundle's execute route uses
 * (findMatchingSellingModels, findOrCreate for Catalog/Category,
 * addBundleComponent/removeBundleComponent for ProductRelatedComponent) so
 * an edited bundle resolves against Salesforce identically to a
 * newly-created one.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let body: BundlePatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const patch = body.patch ?? {};

  // Duplicate Prevention — editing must never flag the bundle's own
  // unchanged name/code, but renaming it to a DIFFERENT existing Bundle's
  // name/code is exactly the case §25 requires blocking. Only runs when
  // the patch actually touches Name/ProductCode.
  if (patch.name !== undefined || patch.productCode !== undefined) {
    try {
      const duplicate = await checkBundleDuplicate(client, { name: patch.name ?? "", code: patch.productCode, excludeId: id });
      if (duplicate.isDuplicate) {
        return NextResponse.json({
          success: false,
          error: duplicate.matchType === "exact-code"
            ? `Bundle Code "${duplicate.recordCode}" is already used by ${duplicate.recordName}.`
            : `A different bundle named "${duplicate.recordName}" already exists in Salesforce.`,
          duplicate,
        }, { status: 409 });
      }
    } catch (err) {
      return NextResponse.json({ success: false, error: `Could not verify this name/code isn't already used: ${(err as Error).message}` }, { status: 500 });
    }
  }

  const steps: Record<string, unknown> = {};
  const errors: Array<{ step: string; error: string }> = [];
  const skipped: Array<{ step: string; reason: string }> = [];

  /* ── Core Product2 fields ── */
  const coreFields: Record<string, unknown> = {};
  if (patch.name !== undefined) coreFields.Name = patch.name;
  if (patch.productCode !== undefined) coreFields.ProductCode = patch.productCode;
  if (patch.description !== undefined) coreFields.Description = patch.description || patch.name;
  if (patch.family !== undefined) coreFields.Family = patch.family;
  if (patch.isActive !== undefined) coreFields.IsActive = patch.isActive;
  // Type is intentionally never touched here — this route only ever operates on a record that is
  // already Type=Bundle (loadBundleDetail throws otherwise), and Bundle status can't be un-set safely.

  if (Object.keys(coreFields).length > 0) {
    try {
      await client.updateRecord("Product2", id, coreFields);
      steps.product = { id, updated: Object.keys(coreFields) };
    } catch (err) {
      return sfErrorResponse(err, "Failed to update bundle");
    }
  }

  /* ── Catalog → Category → CategoryProduct (ensure, don't duplicate) ── */
  if (patch.catalog) {
    try {
      const catalogRec = await findOrCreate(client, "ProductCatalog", { Name: patch.catalog }, ["Name"]);
      steps.catalog = { id: catalogRec.id, name: patch.catalog, created: catalogRec.created };

      if (patch.category) {
        const categoryRec = await findOrCreate(client, "ProductCategory", { Name: patch.category, CatalogId: catalogRec.id }, ["Name", "CatalogId"]);
        steps.category = { id: categoryRec.id, name: patch.category, created: categoryRec.created };

        const existingLink = await client.query<{ Id: string }>(
          `SELECT Id FROM ProductCategoryProduct WHERE ProductId = '${soqlEscape(id)}' AND ProductCategoryId = '${soqlEscape(categoryRec.id)}' LIMIT 1`,
        );
        if (existingLink.records.length === 0) {
          const link = await client.createRecord("ProductCategoryProduct", { ProductId: id, ProductCategoryId: categoryRec.id });
          if (!link.success) errors.push({ step: "categoryAssignment", error: JSON.stringify(link.errors) });
        }
      }
    } catch (e) {
      errors.push({ step: "catalog/category", error: (e as Error).message });
    }
  }

  /* ── Selling Model ── */
  if (patch.sellingModel) {
    try {
      const matchedModels = await findMatchingSellingModels(client, patch.sellingModel);
      if (matchedModels.length === 0) {
        skipped.push({ step: "sellingModel", reason: `No ProductSellingModel matching '${patch.sellingModel}'` });
      } else {
        for (const sm of matchedModels) {
          const existing = await client.query<{ Id: string }>(
            `SELECT Id FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(id)}' AND ProductSellingModelId = '${soqlEscape(sm.Id)}' LIMIT 1`,
          );
          if (existing.records.length > 0) continue;
          const opt = await client.createRecord("ProductSellingModelOption", { Product2Id: id, ProductSellingModelId: sm.Id });
          if (!opt.success) errors.push({ step: `sellingModelOption:${sm.Name}`, error: JSON.stringify(opt.errors) });
        }
        steps.sellingModel = { matched: matchedModels.map(m => ({ id: m.Id, name: m.Name })) };
      }
    } catch (e) {
      errors.push({ step: "sellingModel", error: (e as Error).message });
    }
  }

  /* ── PricebookEntry (price / currency) ── */
  if (patch.basePrice !== undefined) {
    try {
      const unitPrice = parseFloat(patch.basePrice);
      if (!isNaN(unitPrice)) {
        const existingEntries = await client.query<{ Id: string }>(
          `SELECT Id FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' LIMIT 5`,
        );
        if (existingEntries.records.length > 0) {
          await client.updateRecord("PricebookEntry", existingEntries.records[0].Id, { UnitPrice: unitPrice });
          steps.pricebookEntry = { id: existingEntries.records[0].Id, unitPrice, updated: true };
        } else {
          const priceBookName = patch.priceBook || "Standard Price Book";
          const pbResult = await client.query<{ Id: string }>(`SELECT Id FROM Pricebook2 WHERE Name = '${soqlEscape(priceBookName)}' LIMIT 1`);
          if (pbResult.records.length > 0) {
            const pbe = await client.createRecord("PricebookEntry", {
              Product2Id: id, Pricebook2Id: pbResult.records[0].Id, UnitPrice: unitPrice, IsActive: true,
              ...(patch.currencyIsoCode ? { CurrencyIsoCode: patch.currencyIsoCode } : {}),
            });
            if (pbe.success) steps.pricebookEntry = { id: pbe.id, pricebook: priceBookName, unitPrice };
            else errors.push({ step: "pricebookEntry", error: JSON.stringify(pbe.errors) });
          } else {
            skipped.push({ step: "pricebookEntry", reason: `Price Book '${priceBookName}' not found in org` });
          }
        }
      }
    } catch (e) {
      errors.push({ step: "pricebookEntry", error: (e as Error).message });
    }
  }

  /* ── Component changes: remove, add, replace, required/optional ── */
  const removeIds = [...(body.removeRelationshipIds ?? []), ...(body.replacements ?? []).map(r => r.removeRelationshipId)];
  let removedCount = 0;
  for (const relId of removeIds) {
    const result = await removeBundleComponent(client, relId);
    if (result.success) removedCount++;
    else errors.push({ step: `removeComponent:${relId}`, error: result.error ?? "Failed to remove component" });
  }

  const addProductIds = [...(body.addProductIds ?? []), ...(body.replacements ?? []).map(r => r.addProductId)];
  let addedCount = 0;
  if (addProductIds.length > 0) {
    const relationshipTypeId = await resolveRelationshipTypeId(client);
    // Sequence continues after whatever's already there — good enough for display ordering, never relied on for correctness.
    const existingSeqResult = await client.query<{ Sequence: number | null }>(
      `SELECT Sequence FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(id)}' ORDER BY Sequence DESC LIMIT 1`,
    ).catch(() => ({ records: [] as { Sequence: number | null }[] }));
    let nextSeq = (existingSeqResult.records[0]?.Sequence ?? 0) + 1;

    for (const productId of addProductIds) {
      const result = await addBundleComponent(client, id, productId, { sequence: nextSeq++, relationshipTypeId });
      if ("error" in result) errors.push({ step: `addComponent:${productId}`, error: result.error });
      else addedCount++;
    }
  }

  let requiredUpdateCount = 0;
  for (const upd of body.requiredUpdates ?? []) {
    const result = await updateBundleComponentRequired(client, upd.relationshipId, upd.isRequired);
    if (result.success) requiredUpdateCount++;
    else errors.push({ step: `requiredUpdate:${upd.relationshipId}`, error: result.error ?? "Failed to update component" });
  }

  if (removedCount > 0 || addedCount > 0) steps.components = { added: addedCount, removed: removedCount };
  if (requiredUpdateCount > 0) steps.requiredFlags = { updated: requiredUpdateCount };

  return NextResponse.json({ success: true, salesforceId: id, steps, errors, skipped });
}
