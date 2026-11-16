import type { NextRequest } from "next/server";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { readProviders } from "@/lib/tax/server/records";
import { taxRoute } from "@/lib/tax/server/route";

// GET /api/billing/tax/metadata — the tax objects' fields, required/createable flags, picklist values and relationships as the
// connected org describes them, plus the Tax Engine Providers and Named Credentials an external engine can use (read-only).
// The Manual form is built from this.
export async function GET(req: NextRequest) {
  return taxRoute(req, async client => {
    const meta = await discoverTaxMetadata(client);
    const [providers, credentials] = await Promise.all([
      readProviders(client, meta),
      queryAt(client, meta.apiVersion, "SELECT Id, DeveloperName, MasterLabel FROM NamedCredential ORDER BY MasterLabel LIMIT 200").catch(() => []),
    ]);
    return { success: true, ...meta, providers, namedCredentials: credentials.map(c => ({ id: c.Id as string, name: String(c.MasterLabel ?? c.DeveloperName) })) };
  }, "Failed to read the tax metadata");
}
