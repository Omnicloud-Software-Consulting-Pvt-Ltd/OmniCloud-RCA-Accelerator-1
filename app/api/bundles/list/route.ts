import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
} from "@/lib/salesforce/client";

interface ChildProduct {
  id: string;
  name: string;
  isBundle: boolean;
  price: number;
}

interface BundleListItem {
  id: string;
  name: string;
  bundleType: string;
  isActive: boolean;
  productCount: number;
  nestedBundleCount: number;
  totalPrice: number;
  children: ChildProduct[];
  sellingModel?: string;
  commercializationStatus: string;
}

function soqlEscape(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function GET(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const client = clientFromSession(session, { apiVersion: "v62.0" });

  try {
    /* ── Query bundle products — filter by Type = 'Bundle' (not ProductClass) ── */
    const bundleResult = await client.query<{
      Id: string;
      Name: string;
      IsActive: boolean;
      Type: string;
      Description: string;
    }>(
      "SELECT Id, Name, IsActive, Type, Description FROM Product2 WHERE Type = 'Bundle' ORDER BY Name LIMIT 100",
    );

    const bundles = bundleResult.records;
    if (bundles.length === 0) {
      return NextResponse.json({ success: true, bundles: [] });
    }

    const bundleIds = bundles.map(b => `'${soqlEscape(b.Id)}'`).join(",");

    /* ── Query components — use Type on ChildProduct ── */
    let componentMap: Record<string, { Id: string; Name: string; Type: string }[]> = {};
    try {
      const componentResult = await client.query<{
        Id: string;
        ParentProductId: string;
        ChildProductId: string;
        "ChildProduct.Id": string;
        "ChildProduct.Name": string;
        "ChildProduct.Type": string;
      }>(
        `SELECT Id, ParentProductId, ChildProduct.Id, ChildProduct.Name, ChildProduct.Type FROM ProductRelatedComponent WHERE ParentProductId IN (${bundleIds}) ORDER BY Sequence LIMIT 500`,
      );

      for (const comp of componentResult.records) {
        const parentId = comp.ParentProductId;
        if (!componentMap[parentId]) componentMap[parentId] = [];
        componentMap[parentId].push({
          Id:   comp["ChildProduct.Id"]   ?? (comp as unknown as Record<string, Record<string, string>>).ChildProduct?.Id   ?? "",
          Name: comp["ChildProduct.Name"] ?? (comp as unknown as Record<string, Record<string, string>>).ChildProduct?.Name ?? "Unknown",
          Type: comp["ChildProduct.Type"] ?? (comp as unknown as Record<string, Record<string, string>>).ChildProduct?.Type ?? "",
        });
      }
    } catch {
      /* ProductRelatedComponent may not be accessible — use empty map */
    }

    /* ── Query pricebook entries ── */
    const priceMap: Record<string, number> = {};
    try {
      const childIds = Object.values(componentMap)
        .flat()
        .map(c => `'${soqlEscape(c.Id)}'`);
      const allIds    = [...bundles.map(b => `'${soqlEscape(b.Id)}'`), ...childIds];
      const uniqueIds = [...new Set(allIds)].slice(0, 200);

      if (uniqueIds.length > 0) {
        const pbeResult = await client.query<{ Product2Id: string; UnitPrice: number }>(
          `SELECT Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${uniqueIds.join(",")}) AND Pricebook2.IsStandard = true LIMIT 500`,
        );
        for (const pbe of pbeResult.records) {
          priceMap[pbe.Product2Id] = pbe.UnitPrice;
        }
      }
    } catch {
      /* Pricebook may not be accessible */
    }

    /* ── Query selling models ── */
    const sellingModelMap: Record<string, string> = {};
    try {
      const psmResult = await client.query<{ Product2Id: string; "ProductSellingModel.Name": string }>(
        `SELECT Product2Id, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id IN (${bundleIds}) LIMIT 200`,
      );
      for (const psm of psmResult.records) {
        const name = (psm as unknown as Record<string, Record<string, string>>).ProductSellingModel?.Name ?? psm["ProductSellingModel.Name"] ?? "";
        sellingModelMap[psm.Product2Id] = name;
      }
    } catch {
      /* Selling models may not be accessible */
    }

    /* ── Build response ── */
    const result: BundleListItem[] = bundles.map(b => {
      const children = (componentMap[b.Id] ?? []).map(c => ({
        id:       c.Id,
        name:     c.Name,
        isBundle: c.Type === "Bundle",   // Type field — not ProductClass
        price:    priceMap[c.Id] ?? 0,
      }));

      const childTotal       = children.reduce((sum, c) => sum + c.price, 0);
      const bundlePrice      = priceMap[b.Id] ?? childTotal;
      const nestedBundleCount = children.filter(c => c.isBundle).length;

      const hasPrice         = bundlePrice > 0;
      const hasRelationships = children.length > 0;
      const hasSellingModel  = !!sellingModelMap[b.Id];
      const commercializationStatus =
        hasPrice && hasRelationships && hasSellingModel ? "Commercialized"
        : hasPrice || hasRelationships                  ? "Partial"
        :                                                "Draft";

      return {
        id:                   b.Id,
        name:                 b.Name,
        bundleType:           b.Type ?? "Bundle",
        isActive:             b.IsActive,
        productCount:         children.filter(c => !c.isBundle).length,
        nestedBundleCount,
        totalPrice:           bundlePrice,
        children,
        sellingModel:         sellingModelMap[b.Id],
        commercializationStatus,
      };
    });

    return NextResponse.json({ success: true, bundles: result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
