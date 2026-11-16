import { NextRequest, NextResponse } from "next/server";
import {
  SalesforceError,
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
} from "@/lib/salesforce/client";
import type { ProductPayload } from "@/lib/products/types";
import { findMatchingSellingModels, linkSellingModelToProduct, verifySellingModelMapping, type SellingModelLink } from "@/lib/products/server/sellingModel";
import { isUnsupportedSObject, findOrCreate } from "@/lib/products/server/salesforceWrites";
import { persistProductPrice, type PersistedPrice } from "@/lib/products/server/pricebookEntry";
import { resolveProductFields } from "@/lib/products/server/productFieldResolution";
import { parseProductPrice } from "@/lib/products/price";
import { checkProductDuplicate } from "@/lib/products/server/duplicateCheck";
import { configApiFor, readProductConfiguration, relationsOf, resolveRevenueConfig, verifyRequestedConfiguration, type ConfigApi } from "@/lib/products/server/revenueConfig";
import type { ProductConfiguration, RevenueConfigResolution } from "@/lib/products/revenueConfig";

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
   * record existed still can't both succeed. Only an EXACT full-name
   * match counts (see checkProductDuplicate). `allowDuplicateName` is the
   * user's explicit "Continue Anyway" after seeing that warning: it skips
   * this gate only — every validation below and Salesforce's own rules
   * still apply, and the override is reported back in `warnings`. */
  const steps: Record<string, unknown> = {};
  const errors: Array<{ step: string; error: string }> = [];
  const skipped: Array<{ step: string; reason: string }> = [];
  const warnings: string[] = [];

  try {
    const duplicate = await checkProductDuplicate(client, { name: payload.productName });
    if (duplicate.isDuplicate) {
      if (payload.allowDuplicateName !== true) {
        return NextResponse.json({
          success: false,
          duplicateWarning: true,
          error: `A product with the exact name "${duplicate.recordName}" already exists in Salesforce.`,
          duplicate,
        }, { status: 409 });
      }
      steps.duplicateOverride = { existingId: duplicate.recordId, existingName: duplicate.recordName };
      warnings.push(`Created with Continue Anyway — a product with the exact name "${duplicate.recordName}" (${duplicate.recordId}) already exists.`);
    }
  } catch (err) {
    // A failed duplicate check must never silently allow a create through — fail closed.
    return NextResponse.json({ success: false, error: `Could not verify this product doesn't already exist: ${(err as Error).message}` }, { status: 500 });
  }

  /* ── Validate the price BEFORE anything is created, so a bad value is
   * reported instead of silently producing a product with no price. ── */
  const price = parseProductPrice(payload.basePrice);
  if (price && !price.ok) {
    return NextResponse.json({ success: false, error: price.error }, { status: 400 });
  }

  /* ── Revenue Cloud tax/billing configuration — resolved BEFORE anything is created. A referenced Tax/Billing Policy (or
   * treatment/item/engine) that doesn't exist, is ambiguous or doesn't belong to the chain stops the create here with the
   * resolution, so a product is never created with its requested configuration silently missing. ── */
  const wanted = relationsOf(payload);
  let configApi: ConfigApi | null = null;
  let resolution: RevenueConfigResolution | null = null;
  if (wanted.requested) {
    try {
      configApi = await configApiFor(client);
      resolution = await resolveRevenueConfig(configApi, wanted, null);
    } catch (err) {
      return NextResponse.json({ success: false, error: `Could not resolve the requested tax/billing configuration: ${(err as Error).message}` }, { status: 500 });
    }
    if (resolution.blockers.length) {
      return NextResponse.json({ success: false, error: `Nothing was created — the requested configuration can't be applied: ${resolution.blockers.join(" · ")}`, resolution }, { status: 422 });
    }
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

  /* ── Step 3: Selling Model — resolve an EXISTING ProductSellingModel (never
   * creates one, so no duplicate models), activate it if it's Draft, and link
   * it to the product via ProductSellingModelOption. The PricebookEntry side
   * of the mapping (PricebookEntry.ProductSellingModelId) is written in Step 4. ── */
  let sellingModelLink: SellingModelLink | null = null;
  if (payload.sellingModel) {
    try {
      const matchedModels = await findMatchingSellingModels(client, payload.sellingModel);
      if (matchedModels.length === 0) {
        skipped.push({ step: "sellingModel", reason: `No ProductSellingModel matching '${payload.sellingModel}'` });
      } else {
        const sm = matchedModels[0];
        try {
          sellingModelLink = await linkSellingModelToProduct(client, productId, sm);
          if (sellingModelLink.activated) warnings.push(`Product Selling Model "${sm.Name}" was Draft and has been activated.`);
        } catch (e) {
          errors.push({ step: `sellingModelOption:${sm.Name}`, error: e instanceof SalesforceError ? e.message : (e as Error).message });
        }
        steps.sellingModel = {
          matched: matchedModels.map((m) => ({ id: m.Id, name: m.Name, type: m.SellingModelType, status: m.Status ?? null })),
          options: sellingModelLink ? [{ optionId: sellingModelLink.optionId, modelId: sm.Id, modelName: sm.Name, alreadyLinked: sellingModelLink.alreadyLinked }] : [],
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
   * as fully created while its price is missing. When a selling model was
   * linked in Step 3, the Standard entry AND any custom entry are created
   * for that model (PricebookEntry.ProductSellingModelId). */
  let priceError: string | undefined;
  if (price?.ok) {
    try {
      const outcome = await persistProductPrice(client, {
        productId,
        unitPrice: price.value,
        priceBook: payload.priceBook,
        currencyIsoCode: payload.currencyIsoCode,
        isActive: payload.isActive !== false,
        productSellingModelId: sellingModelLink?.modelId,
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

  /* ── Selling model mapping — read back from Salesforce: model Active, option linked, and every written PricebookEntry
   * (Standard + custom) carrying ProductSellingModelId. A failed check is an error, never a silent success. ── */
  if (sellingModelLink) {
    const entry = steps.pricebookEntry as PersistedPrice | undefined;
    try {
      const checks = await verifySellingModelMapping(client, {
        productId,
        modelId: sellingModelLink.modelId,
        entryIds: entry ? [entry.standardEntry?.id ?? "", entry.id] : [],
      });
      steps.sellingModelMapping = { productSellingModelId: sellingModelLink.modelId, productSellingModelOptionId: sellingModelLink.optionId, checks, verified: checks.every(c => c.passed) };
      for (const c of checks.filter(x => !x.passed)) errors.push({ step: "verify:sellingModelMapping", error: `${c.label}: expected ${c.expected}, Salesforce has ${c.actual ?? "nothing"}` });
    } catch (e) {
      errors.push({ step: "verify:sellingModelMapping", error: `The selling model mapping couldn't be read back: ${(e as Error).message}` });
    }
  }

  /* ── Step 5: Tax Policy / Billing Policy (the only tax/billing Product2 fields) — after the product, selling model,
   * catalog/category and price book exist; treatments, items and the engine are related records, verified below. ── */
  if (resolution && Object.keys(resolution.product2).length) {
    try {
      await client.updateRecord("Product2", productId, resolution.product2);
      if (resolution.product2.TaxPolicyId) steps.taxPolicy = { id: resolution.product2.TaxPolicyId, name: resolution.resolutions.find(r => r.key === "taxPolicy")?.record?.name };
      if (resolution.product2.BillingPolicyId) steps.billingPolicy = { id: resolution.product2.BillingPolicyId, name: resolution.resolutions.find(r => r.key === "billingPolicy")?.record?.name };
    } catch (e) {
      errors.push({ step: "taxBillingPolicy", error: e instanceof SalesforceError ? e.message : (e as Error).message });
    }
  }
  if (resolution) warnings.push(...resolution.warnings);

  /* ── Re-read the complete configuration from Salesforce and verify every requested relationship ── */
  let configuration: ProductConfiguration | null = null;
  let verification: ReturnType<typeof verifyRequestedConfiguration> = [];
  try {
    configuration = await readProductConfiguration(configApi ?? await configApiFor(client), productId);
    verification = verifyRequestedConfiguration(configuration, resolution, payload.taxCode);
    for (const v of verification.filter(x => !x.passed)) errors.push({ step: `verify:${v.label}`, error: `${v.label}: expected ${v.expected ?? "—"}, Salesforce has ${v.actual ?? "nothing"}` });
  } catch (e) {
    warnings.push(`The product was created, but its configuration couldn't be re-read: ${(e as Error).message}`);
  }

  return NextResponse.json({ success: true, salesforceId: productId, steps, errors, skipped, warnings, resolution, configuration, verification, ...(priceError ? { priceError } : {}) });
}
