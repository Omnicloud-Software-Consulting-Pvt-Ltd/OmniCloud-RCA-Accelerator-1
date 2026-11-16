import { NextResponse, type NextRequest } from "next/server";
import { TAX_DASHBOARD_MODULES, TAX_MODULES } from "@/lib/taxes/modules";

/** Modules reachable through /api/taxes/objects/* — the Taxes section's own objects plus the shared Legal Entities module. */
const ALLOWED = new Set([...TAX_MODULES.map(m => m.key), ...TAX_DASHBOARD_MODULES]);

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<NextResponse | Response>;

/**
 * Delegates a /api/taxes/objects/[module]/* request to the app's generic, describe-driven record handler (the same one
 * /api/billing/[module]/* uses), refusing any module that isn't part of the Taxes section. No record logic is duplicated.
 */
export function taxesOnly<P extends { module: string }>(handler: Handler<P>): Handler<P> {
  return async (req, ctx) => {
    const { module } = await ctx.params;
    if (!ALLOWED.has(module)) return NextResponse.json({ error: `"${module}" isn't a Taxes object.`, code: "NOT_A_TAX_MODULE" }, { status: 404 });
    return handler(req, ctx);
  };
}
