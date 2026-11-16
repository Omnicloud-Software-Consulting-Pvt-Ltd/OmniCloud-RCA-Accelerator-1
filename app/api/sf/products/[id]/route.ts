import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadProductDetail } from "@/lib/products/server/productDetail";
import { findOrCreate, isUnsupportedSObject, soqlEscape } from "@/lib/products/server/salesforceWrites";
import { findMatchingSellingModels, linkSellingModelToProduct } from "@/lib/products/server/sellingModel";
import { checkProductDuplicate } from "@/lib/products/server/duplicateCheck";
import { persistProductPrice } from "@/lib/products/server/pricebookEntry";
import { resolveProductFields } from "@/lib/products/server/productFieldResolution";
import { parseProductPrice } from "@/lib/products/price";
import type { ProductPayload } from "@/lib/products/types";
import { configApiFor, executeProductUpdate, relationsOf, resolveRevenueConfig } from "@/lib/products/server/revenueConfig";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/sf/products/[id] — single-record read for the Edit workspace:
 * Product2 core fields plus its resolved Catalog/Category/Selling
 * Model/PricebookEntry, in the exact same ProductPayload shape
 * RCProductWorkspace already knows how to render, so "Edit Product" can
 * reuse the create workspace directly instead of a separate edit UI.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const product = await loadProductDetail(client, id);
    return NextResponse.json({ success: true, product });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load product");
  }
}

interface UpdateBody {
  patch?: Partial<ProductPayload>;
}

/**
 * PATCH /api/sf/products/[id] — updates the EXISTING Product2 (and its
 * linked Catalog/Category/Selling Model/PricebookEntry), never creates a
 * new one. Only fields present in `patch` are touched — the caller (the
 * Edit workspace) is expected to send just what the user actually changed,
 * mirroring /api/contracts/[id]'s PATCH convention. Catalog/Category/
 * Selling Model resolution reuses the exact same helpers
 * /api/sf/products/save uses for create, so an edited product resolves
 * against Salesforce identically to a newly-created one.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let patch: Partial<ProductPayload> | undefined;
  try {
    ({ patch } = (await req.json()) as UpdateBody);
    if (!patch || typeof patch !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Duplicate Prevention — editing must never flag the record's own
  // unchanged name/code, but changing it to a name/code belonging to a
  // DIFFERENT existing Product is exactly the case §25 requires blocking.
  // Only runs when the patch actually touches Name — the duplicate policy is
  // the complete Product2.Name (exact, case-insensitive), never ProductCode.
  if (patch.productName !== undefined) {
    try {
      const duplicate = await checkProductDuplicate(client, { name: patch.productName, excludeId: id });
      if (duplicate.isDuplicate) {
        return NextResponse.json({
          success: false,
          duplicateWarning: true,
          error: `A different product with the exact name "${duplicate.recordName}" already exists in Salesforce.`,
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
  const warnings: string[] = [];

  // Tax/Billing configuration in the patch: validated BEFORE anything is written, so an unknown/ambiguous/inconsistent
  // policy never leaves a half-applied edit.
  const wanted = relationsOf(patch);
  if (wanted.requested) {
    try {
      const pre = await resolveRevenueConfig(await configApiFor(client), wanted, id);
      if (pre.blockers.length) return NextResponse.json({ success: false, error: `Nothing was changed — ${pre.blockers.join(" · ")}`, resolution: pre }, { status: 422 });
    } catch (err) {
      return sfErrorResponse(err, "Failed to resolve the requested tax/billing configuration");
    }
  }

  const price = patch.basePrice !== undefined ? parseProductPrice(patch.basePrice) : null;
  if (price && !price.ok) return NextResponse.json({ success: false, error: price.error }, { status: 400 });

  /* ── Core Product2 fields — only what changed ── */
  const coreFields: Record<string, unknown> = {};
  if (patch.productName !== undefined) coreFields.Name = patch.productName;
  if (patch.productCode !== undefined) coreFields.ProductCode = patch.productCode;
  if (patch.family !== undefined) coreFields.Family = patch.family;
  if (patch.description !== undefined) coreFields.Description = patch.description || patch.productName;
  if (patch.isActive !== undefined) coreFields.IsActive = patch.isActive;
  // Same restricted-picklist gating as /save: only ever forward "Bundle" — never attempt to
  // clear Type on an update, since blank may not be a valid value once a record already has one.
  if (patch.productType?.toLowerCase() === "bundle") coreFields.Type = "Bundle";
  // Unit of Measure / Classification — same org-describe-driven resolution as /save.
  if (patch.unitOfMeasure || patch.classification) {
    const extra = await resolveProductFields(client, { unitOfMeasure: patch.unitOfMeasure, classification: patch.classification }, { forUpdate: true });
    Object.assign(coreFields, extra.fields);
    skipped.push(...extra.skipped);
  }

  if (Object.keys(coreFields).length > 0) {
    try {
      await client.updateRecord("Product2", id, coreFields);
      steps.product = { id, updated: Object.keys(coreFields) };
    } catch (err) {
      return sfErrorResponse(err, "Failed to update product");
    }
  }

  /* ── Catalog → Category → CategoryProduct link (ensure, don't duplicate) ── */
  if (patch.catalog) {
    try {
      const catalogRec = await findOrCreate(client, "ProductCatalog", { Name: patch.catalog }, ["Name"]);
      steps.catalog = { id: catalogRec.id, name: patch.catalog, created: catalogRec.created };

      if (patch.category) {
        const categoryRec = await findOrCreate(
          client, "ProductCategory",
          { Name: patch.category, CatalogId: catalogRec.id },
          ["Name", "CatalogId"],
        );
        steps.category = { id: categoryRec.id, name: patch.category, created: categoryRec.created };

        const existingLink = await client.query<{ Id: string }>(
          `SELECT Id FROM ProductCategoryProduct WHERE ProductId = '${soqlEscape(id)}' AND ProductCategoryId = '${soqlEscape(categoryRec.id)}' LIMIT 1`,
        );
        if (existingLink.records.length === 0) {
          const link = await client.createRecord("ProductCategoryProduct", { ProductId: id, ProductCategoryId: categoryRec.id });
          if (link.success) steps.categoryAssignment = { id: link.id };
          else errors.push({ step: "categoryAssignment", error: JSON.stringify(link.errors) });
        }
      }
    } catch (e) {
      errors.push({ step: "catalog/category", error: (e as Error).message });
    }
  }

  /* ── Selling Model (activate if Draft, ensure option exists, don't duplicate) ── */
  let linkedModelId: string | undefined;
  if (patch.sellingModel) {
    try {
      const matchedModels = await findMatchingSellingModels(client, patch.sellingModel);
      if (matchedModels.length === 0) {
        skipped.push({ step: "sellingModel", reason: `No ProductSellingModel matching '${patch.sellingModel}'` });
      } else {
        const optionResults: unknown[] = [];
        for (const sm of matchedModels) {
          try {
            const link = await linkSellingModelToProduct(client, id, sm);
            if (link.activated) warnings.push(`Product Selling Model "${sm.Name}" was Draft and has been activated.`);
            optionResults.push({ optionId: link.optionId, modelId: sm.Id, modelName: sm.Name, ...(link.alreadyLinked ? { alreadyLinked: true } : {}) });
            linkedModelId = sm.Id;
          } catch (e) {
            errors.push({ step: `sellingModelOption:${sm.Name}`, error: (e as Error).message });
          }
        }
        steps.sellingModel = { matched: matchedModels.map((m) => ({ id: m.Id, name: m.Name })), options: optionResults };
      }
    } catch (e) {
      if (isUnsupportedSObject(e as Error)) skipped.push({ step: "sellingModel", reason: "ProductSellingModel not accessible in this org" });
      else errors.push({ step: "sellingModel", error: (e as Error).message });
    }
  }

  /* ── PricebookEntry — update the existing entry if there is one, else create one ── */
  if (patch.basePrice !== undefined || patch.isActive !== undefined) {
    try {
      const existingEntries = await client.query<{ Id: string; Pricebook2Id: string; IsActive: boolean }>(
        `SELECT Id, Pricebook2Id, IsActive FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' LIMIT 5`,
      );
      const existing = existingEntries.records[0];

      if (patch.basePrice !== undefined) {
        if (price?.ok) {
          // The price belongs to a selling model: the one just linked, else the product's only linked one. With several
          // (or none) linked and none named, entries are matched by Product + Price Book as before.
          let productSellingModelId = linkedModelId;
          if (!productSellingModelId) {
            try {
              const opts = await client.query<{ ProductSellingModelId: string }>(
                `SELECT ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(id)}' LIMIT 2`,
              );
              if (opts.records.length === 1) productSellingModelId = opts.records[0].ProductSellingModelId;
            } catch { /* ProductSellingModelOption not accessible — selling-model-agnostic price write */ }
          }
          // Shared with /save: standard-entry prerequisite, currency handling, selling model, read-back.
          const outcome = await persistProductPrice(client, {
            productSellingModelId,
            productId: id,
            unitPrice: price.value,
            priceBook: patch.priceBook,
            currencyIsoCode: patch.currencyIsoCode,
            isActive: patch.isActive ?? existing?.IsActive ?? true,
          });
          warnings.push(...outcome.warnings);
          if (outcome.entry) steps.pricebookEntry = outcome.entry;
          else errors.push({ step: "pricebookEntry", error: outcome.error ?? "Price could not be saved" });
        }
      } else if (existing && patch.isActive !== undefined) {
        // Price unchanged, but Active toggled — keep the existing price entry consistent with the product.
        await client.updateRecord("PricebookEntry", existing.Id, { IsActive: patch.isActive });
        steps.pricebookEntry = { id: existing.Id, updated: true };
      }
    } catch (e) {
      if (isUnsupportedSObject(e as Error)) skipped.push({ step: "pricebookEntry", reason: "PricebookEntry not accessible in this org" });
      else errors.push({ step: "pricebookEntry", error: (e as Error).message });
    }
  }

  /* ── Tax Policy / Billing Policy (Product2) + verification of the related treatments/items — only when requested ── */
  let configuration = null, verification: unknown[] = [];
  if (wanted.requested) {
    try {
      const out = await executeProductUpdate(client, await configApiFor(client), id, { relations: wanted.relations, ids: wanted.ids });
      steps.revenueConfig = { changes: out.plan.changes };
      errors.push(...out.errors.map(e => ({ step: "revenueConfig", error: e })));
      for (const v of out.verification.filter(x => !x.passed)) errors.push({ step: `verify:${v.label}`, error: `${v.label}: expected ${v.expected ?? "—"}, Salesforce has ${v.actual ?? "nothing"}` });
      warnings.push(...out.plan.warnings);
      configuration = out.after; verification = out.verification;
    } catch (e) {
      errors.push({ step: "revenueConfig", error: (e as Error).message });
    }
  }

  return NextResponse.json({ success: true, salesforceId: id, steps, errors, skipped, warnings, configuration, verification });
}
