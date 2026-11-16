import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { configApiFor, executeProductUpdate, planProductUpdate, readProductConfiguration, type ProductConfigChange } from "@/lib/products/server/revenueConfig";
import { RELATION_KEYS } from "@/lib/products/revenueConfig";

type Params = { params: Promise<{ id: string }> };

// GET /api/sf/products/[id]/configuration — the product's COMPLETE Revenue Cloud configuration, every relationship resolved
// from Salesforce (Product2 · selling model · catalog/category · price book · tax chain · billing chain) + readiness. Read-only.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;
  try { return NextResponse.json({ success: true, configuration: await readProductConfiguration(await configApiFor(auth.client), id) }); }
  catch (err) { return sfErrorResponse(err, "Failed to read the product configuration"); }
}

// POST /api/sf/products/[id]/configuration — { action: "preview" | "execute", change }. Preview shows before → after for ONLY the
// requested configuration; execute re-plans server-side, writes just those changes, re-reads Salesforce and verifies each.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { id } = await params;
  let body: { action?: unknown; change?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }
  const c = body.change ?? {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const pickMap = (m: unknown) => Object.fromEntries(RELATION_KEYS.map(k => [k, s((m as Record<string, unknown> | undefined)?.[k])]).filter(([, v]) => v));
  const change: ProductConfigChange = {
    relations: pickMap(c.relations), ids: pickMap(c.ids), unitOfMeasure: s(c.unitOfMeasure),
    unitPrice: s(c.unitPrice) ?? (typeof c.unitPrice === "number" ? String(c.unitPrice) : null), priceBook: s(c.priceBook),
  };
  try {
    const api = await configApiFor(auth.client);
    if (body.action === "execute") {
      const out = await executeProductUpdate(auth.client, api, id, change);
      return NextResponse.json({ success: out.ok, ...out }, { status: out.ok || out.after ? 200 : 422 });
    }
    return NextResponse.json({ success: true, plan: await planProductUpdate(api, id, change) });
  } catch (err) { return sfErrorResponse(err, "Failed to update the product configuration"); }
}
