import { NextRequest, NextResponse } from "next/server";
import { soqlEscape } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveBundleObjectDiscovery, resolveQuoteLineRelationshipSchema } from "@/lib/quotes/metadata/relationshipFields";
import { createQuoteLineItems } from "@/lib/quotes/server/lineItemCreate";
import type { ExistingQuoteLineItem, QuoteLineItemDraft } from "@/lib/quotes/types";

type Params = { params: Promise<{ id: string }> };

// POST /api/quotes/[id]/line-items — the core bundle-hierarchy-aware creation endpoint (§5.8).
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: quoteId } = await params;

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
    const result = await createQuoteLineItems(client, quoteId, pricebookId, draftRoots);
    return NextResponse.json(result, { status: result.success ? 201 : 422 });
  } catch (err) {
    return sfErrorResponse(err, "Failed to create line items");
  }
}

// GET /api/quotes/[id]/line-items — existing QLIs, hierarchy reconstructed from whichever
// native mechanism the org actually supports (§4.8, §5.5); flat with hierarchySupported:false otherwise.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: quoteId } = await params;

  try {
    const qliSchema = await resolveQuoteLineItemFieldSchema(client);
    const discovery = await resolveBundleObjectDiscovery(client);
    const qlrSchema = await resolveQuoteLineRelationshipSchema(client, discovery);

    const selectFields = ["Id"];
    // Dot-walk the product relationship using Describe's own relationshipName
    // (e.g. "Product2" for Product2Id) — never guessed by stripping "Id".
    if (qliSchema.productField) {
      selectFields.push(qliSchema.productField.apiName);
      if (qliSchema.productField.relationshipName) selectFields.push(`${qliSchema.productField.relationshipName}.Name`);
    }
    if (qliSchema.quantityField) selectFields.push(qliSchema.quantityField.apiName);
    if (qliSchema.unitPriceField) selectFields.push(qliSchema.unitPriceField.apiName);
    if (qliSchema.listPriceField) selectFields.push(qliSchema.listPriceField.apiName);
    if (qliSchema.discountField) selectFields.push(qliSchema.discountField.apiName);
    if (qliSchema.totalPriceField) selectFields.push(qliSchema.totalPriceField.apiName);
    if (qliSchema.netUnitPriceField) selectFields.push(qliSchema.netUnitPriceField.apiName);
    if (qliSchema.netTotalPriceField) selectFields.push(qliSchema.netTotalPriceField.apiName);
    if (qliSchema.pricingStatusField) selectFields.push(qliSchema.pricingStatusField.apiName);
    if (qlrSchema.mechanism === "self-reference") {
      if (qlrSchema.mainQuoteLineField) selectFields.push(qlrSchema.mainQuoteLineField.apiName);
      if (qlrSchema.associatedQuoteLineField) selectFields.push(qlrSchema.associatedQuoteLineField.apiName);
    }

    const quoteFilterField = qliSchema.quoteField?.apiName ?? "QuoteId";
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM QuoteLineItem WHERE ${quoteFilterField} = '${soqlEscape(quoteId)}' LIMIT 2000`,
    );

    const nodeById = new Map<string, ExistingQuoteLineItem>();
    const productRelName = qliSchema.productField?.relationshipName ?? null;
    for (const row of res.records) {
      const productRel = productRelName ? (row[productRelName] as Record<string, unknown> | undefined) : undefined;
      // §$0.00 pricing bug: on reload, prefer Revenue Cloud's own
      // NetUnitPrice/NetTotalPrice over plain UnitPrice/TotalPrice whenever
      // this org exposes them — same rule as the just-created path
      // (lib/quotes/server/lineItemCreate.ts readBackLineItems), so a
      // reloaded Quote shows the same authoritative price it showed right
      // after creation, not $0.00.
      const rawUnitPrice = qliSchema.netUnitPriceField
        ? (row[qliSchema.netUnitPriceField.apiName] as number | null | undefined)
        : qliSchema.unitPriceField ? (row[qliSchema.unitPriceField.apiName] as number | null | undefined) : undefined;
      const rawTotalPrice = qliSchema.netTotalPriceField
        ? (row[qliSchema.netTotalPriceField.apiName] as number | null | undefined)
        : qliSchema.totalPriceField ? (row[qliSchema.totalPriceField.apiName] as number | null | undefined) : undefined;
      nodeById.set(row.Id as string, {
        id: row.Id as string,
        productId: qliSchema.productField ? ((row[qliSchema.productField.apiName] as string) ?? "") : "",
        productName: (productRel?.Name as string) ?? "Unknown product",
        quantity: qliSchema.quantityField ? ((row[qliSchema.quantityField.apiName] as number) ?? 1) : 1,
        unitPrice: rawUnitPrice ?? 0,
        listPrice: qliSchema.listPriceField ? ((row[qliSchema.listPriceField.apiName] as number) ?? 0) : 0,
        discount: qliSchema.discountField ? ((row[qliSchema.discountField.apiName] as number) ?? 0) : 0,
        totalPrice: rawTotalPrice ?? 0,
        pricingStatus: qliSchema.pricingStatusField ? ((row[qliSchema.pricingStatusField.apiName] as string) ?? null) : null,
        // Set below once bundle-relationship edges are resolved (relationship-object
        // mechanism) — a standalone/root line always stays false (it's never a bundle child).
        pricingInclusion: false,
        parentDraftId: null,
        rootItemId: qlrSchema.mechanism === "self-reference" && qlrSchema.mainQuoteLineField ? ((row[qlrSchema.mainQuoteLineField.apiName] as string) ?? null) : null,
        parentItemId: qlrSchema.mechanism === "self-reference" && qlrSchema.associatedQuoteLineField ? ((row[qlrSchema.associatedQuoteLineField.apiName] as string) ?? null) : null,
        children: [],
      });
    }

    let hierarchySupported = false;
    if (qlrSchema.mechanism === "relationship-object" && qlrSchema.objectName && qlrSchema.mainQuoteLineField && qlrSchema.associatedQuoteLineField) {
      hierarchySupported = true;
      const idList = [...nodeById.keys()].map(i => `'${soqlEscape(i)}'`).join(",");
      if (idList) {
        try {
          const edgeSelectFields = [qlrSchema.mainQuoteLineField.apiName, qlrSchema.associatedQuoteLineField.apiName];
          if (qlrSchema.pricingInclusionField) edgeSelectFields.push(qlrSchema.pricingInclusionField.apiName);
          const edgeRes = await client.query<Record<string, unknown>>(
            `SELECT ${[...new Set(edgeSelectFields)].join(", ")} FROM ${qlrSchema.objectName} WHERE ${qlrSchema.mainQuoteLineField.apiName} IN (${idList})`,
          );
          const childIds = new Set<string>();
          for (const edge of edgeRes.records) {
            const parentId = edge[qlrSchema.mainQuoteLineField.apiName] as string;
            const childId = edge[qlrSchema.associatedQuoteLineField.apiName] as string;
            const parent = nodeById.get(parentId);
            const child = nodeById.get(childId);
            if (parent && child) {
              parent.children.push(child);
              childIds.add(childId);
              // The relationship record already carries an explicit, real
              // AssociatedQuoteLinePricing/IsComponentPriceIncluded value
              // (resolved at creation time, §Bundle Pricing) — read it back
              // rather than re-guessing a default here.
              if (qlrSchema.pricingInclusionField) {
                const raw = edge[qlrSchema.pricingInclusionField.apiName];
                child.pricingInclusion = qlrSchema.pricingInclusionKind === "picklist"
                  ? raw === qlrSchema.pricingInclusionIncludedValue
                  : !!raw;
              }
            }
          }
          const roots = [...nodeById.values()].filter(n => !childIds.has(n.id));
          return NextResponse.json({ success: true, lineItems: roots, hierarchySupported });
        } catch {
          hierarchySupported = false;
        }
      }
    } else if (qlrSchema.mechanism === "self-reference") {
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

    // Unsupported mechanism, or hierarchy query failed — return a genuinely flat list (§3.9: never imply a false hierarchy).
    return NextResponse.json({ success: true, lineItems: [...nodeById.values()], hierarchySupported: false });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list existing line items");
  }
}
