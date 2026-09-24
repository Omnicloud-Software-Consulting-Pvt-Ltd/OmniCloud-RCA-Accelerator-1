import { NextRequest, NextResponse } from "next/server";
import {
  SalesforceError,
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
} from "@/lib/salesforce/client";
import type { ProductPayload } from "@/lib/products/types";
import { findMatchingSellingModels } from "@/lib/products/server/sellingModel";
import { isUnsupportedSObject, findOrCreate } from "@/lib/products/server/salesforceWrites";
import { persistProductPrice } from "@/lib/products/server/pricebookEntry";
import { resolveProductFields } from "@/lib/products/server/productFieldResolution";
import { parseProductPrice } from "@/lib/products/price";
import { checkProductDuplicate } from "@/lib/products/server/duplicateCheck";

/* ─────────────────────────────────────────────────────────────────────────────
 * Route handler — POST /api/sf/products/save
 * ─────────────────────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let payload: ProductPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Use v62.0 for EPC objects
  const client = clientFromSession(session, { apiVersion: "v62.0" });

  /* ── Duplicate Prevention — the final, race-condition-safe gate (§21).
   * A frontend pre-check (POST /api/sf/products/check-duplicate) already
   * ran before the user got here; this is the authority that actually
   * decides whether Salesforce gets a create call, so two concurrent
   * requests that both passed their own frontend check before either
   * record existed still can't both succeed. Never bypassable — this
   * route has no "create anyway" override. */
  try {
    const duplicate = await checkProductDuplicate(client, { name: payload.productName, code: payload.productCode });
    if (duplicate.isDuplicate) {
      return NextResponse.json({
        success: false,
        error: duplicate.matchType === "exact-code"
          ? `Product Code "${duplicate.recordCode}" is already used by ${duplicate.recordName}.`
          : `A product named "${duplicate.recordName}" already exists in Salesforce.`,
        duplicate,
      }, { status: 409 });
    }
  } catch (err) {
    // A failed duplicate check must never silently allow a create through — fail closed.
    return NextResponse.json({ success: false, error: `Could not verify this product doesn't already exist: ${(err as Error).message}` }, { status: 500 });
  }

  const steps: Record<string, unknown> = {};
  const errors: Array<{ step: string; error: string }> = [];
  const skipped: Array<{ step: string; reason: string }> = [];
  const warnings: string[] = [];

  /* ── Validate the price BEFORE anything is created, so a bad value is
   * reported instead of silently producing a product with no price. ── */
  const price = parseProductPrice(payload.basePrice);
  if (price && !price.ok) {
    return NextResponse.json({ success: false, error: price.error }, { status: 400 });
  }

  /* ── Unit of Measure / Product Classification → real Product2 fields,
   * resolved against this org's own describe + records (never created). ── */
  const extra = await resolveProductFields(client, {
    unitOfMeasure: payload.unitOfMeasure,
    classification: payload.classification,
  });
  skipped.push(...extra.skipped);

  /* ── Step 1: Product2 ── */
  let productId: string;
  try {
    const product = await client.createRecord("Product2", {
      Name:        payload.productName,
      ProductCode: payload.productCode,
      Family:      payload.family,
      Description: payload.description || payload.productName,
      IsActive:    payload.isActive !== false,
      // Product2.Type is a restricted picklist whose only reliably-real
      // value across orgs is "Bundle" (see app/api/bundles/list/route.ts's
      // own `WHERE Type = 'Bundle'` filter) — everything else (the
      // create-form's internal "simple"/"bundle" distinction, e.g.) is a
      // client-side concept, not a real picklist value, and must never be
      // forwarded verbatim or Salesforce rejects the whole create.
      ...(payload.productType?.toLowerCase() === "bundle" ? { Type: "Bundle" } : {}),
      ...extra.fields,
    });
    if (!product.success) throw new Error(`Product2 creation failed: ${JSON.stringify(product.errors)}`);
    productId = product.id;
    steps.product = { id: productId, name: payload.productName };
    if (extra.resolved.unitOfMeasure) steps.unitOfMeasure = extra.resolved.unitOfMeasure;
    if (extra.resolved.classification) steps.classification = extra.resolved.classification;
  } catch (err) {
    const msg = err instanceof SalesforceError ? err.message : (err as Error).message;
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  /* ── Step 2: Catalog → Category → CategoryProduct ── */
  if (payload.catalog) {
    try {
      const catalog = await findOrCreate(client, "ProductCatalog", { Name: payload.catalog }, ["Name"]);
      steps.catalog = { id: catalog.id, name: payload.catalog, created: catalog.created };

      if (payload.category) {
        const category = await findOrCreate(
          client, "ProductCategory",
          { Name: payload.category, CatalogId: catalog.id },
          ["Name", "CatalogId"],
        );
        steps.category = { id: category.id, name: payload.category, created: category.created };

        const catProd = await client.createRecord("ProductCategoryProduct", {
          ProductId:         productId,
          ProductCategoryId: category.id,
        });
        if (catProd.success) {
          steps.categoryAssignment = { id: catProd.id };
        } else {
          errors.push({ step: "categoryAssignment", error: JSON.stringify(catProd.errors) });
        }
      }
    } catch (e) {
      errors.push({ step: "catalog/category", error: (e as Error).message });
    }
  }

  /* ── Step 3: Selling Model ── */
  if (payload.sellingModel) {
    try {
      const matchedModels = await findMatchingSellingModels(client, payload.sellingModel);
      if (matchedModels.length === 0) {
        skipped.push({ step: "sellingModel", reason: `No ProductSellingModel matching '${payload.sellingModel}'` });
      } else {
        const optionResults: unknown[] = [];
        for (const sm of matchedModels) {
          const opt = await client.createRecord("ProductSellingModelOption", {
            Product2Id:            productId,
            ProductSellingModelId: sm.Id,
          });
          if (opt.success) {
            optionResults.push({ optionId: opt.id, modelId: sm.Id, modelName: sm.Name });
          } else {
            errors.push({ step: `sellingModelOption:${sm.Name}`, error: JSON.stringify(opt.errors) });
          }
        }
        steps.sellingModel = {
          matched: matchedModels.map((m) => ({ id: m.Id, name: m.Name, type: m.SellingModelType })),
          options: optionResults,
        };
      }
    } catch (e) {
      if (isUnsupportedSObject(e as Error)) {
        skipped.push({ step: "sellingModel", reason: "ProductSellingModel not accessible in this org" });
      } else {
        errors.push({ step: "sellingModel", error: (e as Error).message });
      }
    }
  }

  /* ── Step 4: PricebookEntry ──
   * A price given in the prompt/form is always written (Standard Price Book
   * when no Price Book was named), via the shared persistProductPrice()
   * which handles the standard-entry prerequisite, single- vs multi-currency
   * orgs, and reads back what Salesforce actually stored. A failure here is
   * returned in `errors` + `priceError` so no caller can report the product
   * as fully created while its price is missing. */
  let priceError: string | undefined;
  if (price?.ok) {
    try {
      const outcome = await persistProductPrice(client, {
        productId,
        unitPrice: price.value,
        priceBook: payload.priceBook,
        currencyIsoCode: payload.currencyIsoCode,
        isActive: payload.isActive !== false,
      });
      warnings.push(...outcome.warnings);
      if (outcome.entry) steps.pricebookEntry = outcome.entry;
      else priceError = outcome.error;
    } catch (e) {
      priceError = isUnsupportedSObject(e as Error)
        ? "PricebookEntry is not accessible in this org"
        : (e instanceof SalesforceError ? e.message : (e as Error).message);
    }
    if (priceError) errors.push({ step: "pricebookEntry", error: priceError });
  }

  return NextResponse.json({ success: true, salesforceId: productId, steps, errors, skipped, warnings, ...(priceError ? { priceError } : {}) });
}
