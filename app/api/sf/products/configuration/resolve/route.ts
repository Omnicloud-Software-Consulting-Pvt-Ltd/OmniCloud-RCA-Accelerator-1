import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { configApiFor, resolveRevenueConfig } from "@/lib/products/server/revenueConfig";
import { RELATION_KEYS } from "@/lib/products/revenueConfig";

// POST /api/sf/products/configuration/resolve — { relations, ids?, productId? } → each tax/billing relationship resolved to a real
// Salesforce record (exact / partial / ambiguous with candidates / not found) and checked for chain consistency. Read-only.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: { relations?: Record<string, unknown>; ids?: Record<string, unknown>; productId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const pickMap = (m: Record<string, unknown> | undefined) => Object.fromEntries(RELATION_KEYS.map(k => [k, s(m?.[k])]).filter(([, v]) => v));
  try {
    const resolution = await resolveRevenueConfig(await configApiFor(auth.client), { relations: pickMap(body.relations), ids: pickMap(body.ids) }, s(body.productId));
    return NextResponse.json({ success: true, resolution });
  } catch (err) { return sfErrorResponse(err, "Failed to resolve the product configuration"); }
}
