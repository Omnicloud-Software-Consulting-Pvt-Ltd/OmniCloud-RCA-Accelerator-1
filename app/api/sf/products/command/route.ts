import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { configApiFor, findProduct, planProductUpdate, readProductConfiguration } from "@/lib/products/server/revenueConfig";
import { parseProductCommand } from "@/lib/products/productCommand";

// POST /api/sf/products/command — { prompt, productId? }. "Show me the configuration of X" → the complete configuration;
// "Update X and assign …" / "Change the Unit of Measure to Each" → a before → after PREVIEW (nothing is written here — execute
// goes through /api/sf/products/[id]/configuration). Any other prompt → { kind: "create" } for the existing create flow.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  let body: { prompt?: unknown; productId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  const cmd = parseProductCommand(prompt);
  if (cmd.kind === "create") return NextResponse.json({ success: true, command: cmd });
  try {
    const api = await configApiFor(auth.client);
    const ref = cmd.product ?? (typeof body.productId === "string" ? body.productId : null);
    if (!ref) return NextResponse.json({ success: false, command: cmd, error: "Which product? Name it in the prompt or open the product first." }, { status: 400 });
    const found = await findProduct(api, ref);
    if (found.status !== "found") {
      return NextResponse.json({ success: false, command: cmd, error: found.status === "ambiguous" ? `${found.candidates.length} products match "${ref}" — choose one.` : `Product "${ref}" doesn't exist in this org.`, candidates: found.candidates }, { status: found.status === "ambiguous" ? 409 : 404 });
    }
    const productId = found.product!.id;
    if (cmd.kind === "show") return NextResponse.json({ success: true, command: cmd, productId, configuration: await readProductConfiguration(api, productId) });
    const plan = await planProductUpdate(api, productId, { relations: cmd.change.relations, unitOfMeasure: cmd.change.unitOfMeasure, unitPrice: cmd.change.unitPrice, priceBook: cmd.change.priceBook });
    if (cmd.unnamed.length) plan.blockers.push(...cmd.unnamed.map(u => `${u} was mentioned without a name — say which ${u} to assign.`));
    return NextResponse.json({ success: true, command: cmd, productId, plan });
  } catch (err) { return sfErrorResponse(err, "Product command failed"); }
}
