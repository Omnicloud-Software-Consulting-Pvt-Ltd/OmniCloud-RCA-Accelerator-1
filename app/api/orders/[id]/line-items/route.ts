import { NextRequest, NextResponse } from "next/server";
import { soqlEscape } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderItemFieldSchema } from "@/lib/orders/metadata/lineItemFields";
import { resolveOrderItemRelationshipSchema } from "@/lib/orders/metadata/relationshipFields";
import { resolveBundleObjectDiscovery } from "@/lib/quotes/metadata/relationshipFields";
import { createOrderItems } from "@/lib/orders/server/orderItemCreate";
import type { QuoteLineItemDraft } from "@/lib/quotes/types";
import type { ExistingOrderItem } from "@/lib/orders/types";

type Params = { params: Promise<{ id: string }> };

// POST /api/orders/[id]/line-items — the core bundle-hierarchy-aware creation endpoint (§5.2).
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: orderId } = await params;

  let pricebookId: string, draftRoots: QuoteLineItemDraft[];
  try {
    ({ pricebookId, draftRoots } = await req.json());
    if (!pricebookId || !Array.isArray(draftRoots) || draftRoots.length === 0) {
      return NextResponse.json({ error: "pricebookId and a non-empty draftRoots array are required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await createOrderItems(client, orderId, pricebookId, draftRoots);
    return NextResponse.json(result, { status: result.success ? 201 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Failed to create order line items");
  }
}

// GET /api/orders/[id]/line-items — existing OrderItems, hierarchy reconstructed from
// whichever native mechanism this org actually supports (§4.8, §5.1); flat with
// hierarchySupported:false otherwise — never implies a false hierarchy.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: orderId } = await params;

  try {
    const oiSchema = await resolveOrderItemFieldSchema(client);
    const discovery = await resolveBundleObjectDiscovery(client);
    const oirSchema = await resolveOrderItemRelationshipSchema(client, discovery);

    const selectFields = ["Id"];
    if (oiSchema.productField) {
      selectFields.push(oiSchema.productField.apiName);
      if (oiSchema.productField.relationshipName) selectFields.push(`${oiSchema.productField.relationshipName}.Name`);
    }
    if (oiSchema.quantityField) selectFields.push(oiSchema.quantityField.apiName);
    if (oiSchema.unitPriceField) selectFields.push(oiSchema.unitPriceField.apiName);
    if (oiSchema.listPriceField) selectFields.push(oiSchema.listPriceField.apiName);
    if (oiSchema.discountField) selectFields.push(oiSchema.discountField.apiName);
    if (oiSchema.totalPriceField) selectFields.push(oiSchema.totalPriceField.apiName);
    if (oirSchema.mechanism === "self-reference") {
      if (oirSchema.mainOrderItemField) selectFields.push(oirSchema.mainOrderItemField.apiName);
      if (oirSchema.associatedOrderItemField) selectFields.push(oirSchema.associatedOrderItemField.apiName);
    }

    const orderFilterField = oiSchema.orderField?.apiName ?? "OrderId";
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM OrderItem WHERE ${orderFilterField} = '${soqlEscape(orderId)}' LIMIT 2000`,
    );

    const nodeById = new Map<string, ExistingOrderItem>();
    const productRelName = oiSchema.productField?.relationshipName ?? null;
    for (const row of res.records) {
      const productRel = productRelName ? (row[productRelName] as Record<string, unknown> | undefined) : undefined;
      nodeById.set(row.Id as string, {
        id: row.Id as string,
        productId: oiSchema.productField ? ((row[oiSchema.productField.apiName] as string) ?? "") : "",
        productName: (productRel?.Name as string) ?? "Unknown product",
        quantity: oiSchema.quantityField ? ((row[oiSchema.quantityField.apiName] as number) ?? 1) : 1,
        unitPrice: oiSchema.unitPriceField ? ((row[oiSchema.unitPriceField.apiName] as number) ?? 0) : 0,
        listPrice: oiSchema.listPriceField ? ((row[oiSchema.listPriceField.apiName] as number) ?? 0) : 0,
        discount: oiSchema.discountField ? ((row[oiSchema.discountField.apiName] as number) ?? 0) : 0,
        totalPrice: oiSchema.totalPriceField ? ((row[oiSchema.totalPriceField.apiName] as number) ?? 0) : 0,
        parentDraftId: null,
        rootItemId: oirSchema.mechanism === "self-reference" && oirSchema.mainOrderItemField ? ((row[oirSchema.mainOrderItemField.apiName] as string) ?? null) : null,
        parentItemId: oirSchema.mechanism === "self-reference" && oirSchema.associatedOrderItemField ? ((row[oirSchema.associatedOrderItemField.apiName] as string) ?? null) : null,
        children: [],
      });
    }

    let hierarchySupported = false;
    if (oirSchema.mechanism === "relationship-object" && oirSchema.objectName && oirSchema.mainOrderItemField && oirSchema.associatedOrderItemField) {
      hierarchySupported = true;
      const idList = [...nodeById.keys()].map(i => `'${soqlEscape(i)}'`).join(",");
      if (idList) {
        try {
          const edgeRes = await client.query<Record<string, unknown>>(
            `SELECT ${oirSchema.mainOrderItemField.apiName}, ${oirSchema.associatedOrderItemField.apiName} FROM ${oirSchema.objectName} WHERE ${oirSchema.mainOrderItemField.apiName} IN (${idList})`,
          );
          const childIds = new Set<string>();
          for (const edge of edgeRes.records) {
            const parentId = edge[oirSchema.mainOrderItemField.apiName] as string;
            const childId = edge[oirSchema.associatedOrderItemField.apiName] as string;
            const parent = nodeById.get(parentId);
            const child = nodeById.get(childId);
            if (parent && child) {
              parent.children.push(child);
              childIds.add(childId);
            }
          }
          const roots = [...nodeById.values()].filter(n => !childIds.has(n.id));
          return NextResponse.json({ success: true, lineItems: roots, hierarchySupported });
        } catch {
          hierarchySupported = false;
        }
      }
    } else if (oirSchema.mechanism === "self-reference") {
      hierarchySupported = true;
      const childIds = new Set<string>();
      for (const node of nodeById.values()) {
        if (node.parentItemId && nodeById.has(node.parentItemId)) {
          nodeById.get(node.parentItemId)!.children.push(node);
          childIds.add(node.id);
        }
      }
      const roots = [...nodeById.values()].filter(n => !childIds.has(n.id));
      return NextResponse.json({ success: true, lineItems: roots, hierarchySupported });
    }

    return NextResponse.json({ success: true, lineItems: [...nodeById.values()], hierarchySupported: false });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list existing order line items");
  }
}
