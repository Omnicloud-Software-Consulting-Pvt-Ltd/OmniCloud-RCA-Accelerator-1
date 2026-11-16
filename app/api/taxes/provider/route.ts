import type { NextRequest } from "next/server";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { readEngines } from "@/lib/tax/server/records";
import { taxRoute } from "@/lib/tax/server/route";
import { classifyTaxProvider } from "@/lib/taxes/provider";

// GET /api/taxes/provider — which tax engine the CURRENT org calculates with (native Revenue Standard Tax, external, mixed or unknown),
// from the same TaxEngine read as the Tax Dashboard. Lightweight (metadata is cached) so transaction screens can label their tax. Read-only.
export async function GET(req: NextRequest) {
  return taxRoute(req, async client => {
    const meta = await discoverTaxMetadata(client);
    const engines = meta.objects.TaxEngine && "exists" in meta.objects.TaxEngine && meta.objects.TaxEngine.exists ? await readEngines(client, meta) : null;
    return { success: true, provider: classifyTaxProvider(engines) };
  }, "Failed to read the tax provider");
}
