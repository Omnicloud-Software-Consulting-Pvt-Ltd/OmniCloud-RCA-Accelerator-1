import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadBundleDetail } from "@/lib/bundles/server/bundleDetail";
import { addBundleComponent, resolveRelationshipTypeId } from "@/lib/bundles/server/relationships";
import { findMatchingSellingModels } from "@/lib/products/server/sellingModel";
import { findOrCreate } from "@/lib/products/server/salesforceWrites";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/bundles/[id]/duplicate — Bundle History's "Duplicate" action.
 * Reuses loadBundleDetail (read) and the same component/catalog/selling-
 * model/pricebook helpers Create Bundle and Edit Bundle already use for
 * writes — never a second bundle-creation implementation. Copies the
 * bundle's own fields and re-links its EXISTING child products (does not
 * duplicate the children themselves).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const source = await loadBundleDetail(client, id);

    const created = await client.createRecord("Product2", {
      Name: `${source.name} (Copy)`,
      ProductCode: source.productCode ? `${source.productCode}-COPY` : undefined,
      Description: source.description || `${source.name} (Copy)`,
      Family: source.family || undefined,
      Type: "Bundle",
      IsActive: false, // a duplicate starts as a draft — never silently activated
    });
    if (!created.success) {
      return NextResponse.json({ success: false, error: `Failed to create duplicate bundle: ${JSON.stringify(created.errors)}` }, { status: 500 });
    }
    const newId = created.id;

    const relationshipTypeId = await resolveRelationshipTypeId(client);
    let componentsCopied = 0;
    for (const c of source.components) {
      const result = await addBundleComponent(client, newId, c.childProductId, {
        sequence: c.sequence, isDefaultComponent: c.isDefaultComponent, isComponentRequired: c.isComponentRequired, relationshipTypeId,
      });
      if (!("error" in result)) componentsCopied++;
    }

    if (source.catalog) {
      try {
        const catalogRec = await findOrCreate(client, "ProductCatalog", { Name: source.catalog }, ["Name"]);
        if (source.category) {
          const categoryRec = await findOrCreate(client, "ProductCategory", { Name: source.category, CatalogId: catalogRec.id }, ["Name", "CatalogId"]);
          await client.createRecord("ProductCategoryProduct", { ProductId: newId, ProductCategoryId: categoryRec.id });
        }
      } catch { /* best-effort — the duplicate is still usable without commercialization copied */ }
    }

    if (source.sellingModel) {
      try {
        const matched = await findMatchingSellingModels(client, source.sellingModel);
        for (const sm of matched) {
          await client.createRecord("ProductSellingModelOption", { Product2Id: newId, ProductSellingModelId: sm.Id });
        }
      } catch { /* best-effort */ }
    }

    if (source.priceBook && source.basePrice) {
      try {
        const pbResult = await client.query<{ Id: string }>(`SELECT Id FROM Pricebook2 WHERE Name = '${source.priceBook.replace(/'/g, "\\'")}' LIMIT 1`);
        if (pbResult.records.length > 0) {
          await client.createRecord("PricebookEntry", {
            Product2Id: newId, Pricebook2Id: pbResult.records[0].Id, UnitPrice: parseFloat(source.basePrice), IsActive: true,
          });
        }
      } catch { /* best-effort */ }
    }

    return NextResponse.json({ success: true, salesforceId: newId, componentsCopied });
  } catch (err) {
    return sfErrorResponse(err, "Failed to duplicate bundle");
  }
}
