import { NextRequest, NextResponse } from "next/server";
import { BILLING_MODULES } from "@/lib/billing/registry";
import {
  requireBillingClient, resolveAllModules, getModuleSchema, clearBillingDiscoveryCache,
} from "@/lib/billing/server/discovery";
import { clearBillingStatsCache } from "@/lib/billing/server/stats";
import { billingErrorResponse } from "@/lib/billing/server/errors";

export interface BillingMetadataModuleSummary {
  moduleKey: string;
  label: string;
  group: string;
  available: boolean;
  candidatesTried: string[];
  sobject: string | null;
  createable: boolean;
  queryable: boolean;
  updateable: boolean;
  fieldCount: number | null;
  createableFieldCount: number | null;
  requiredFields: string[];
  referenceTargets: string[];
  inlineChildren: string[];
  inboundLinks: string[];
  error: string | null;
}

export interface BillingMetadataResponse {
  success: true;
  apiVersion: string;
  instanceUrl: string;
  modules: BillingMetadataModuleSummary[];
}

// GET /api/billing/metadata — the org-compatibility report behind "Inspect Salesforce
// Configuration": for every billing concept, which object API names were tried, which one
// (if any) exists, its CRUD capability, required fields and discovered relationships.
// `?refresh=1` clears the billing Describe caches first (after an admin changes the schema).
export async function GET(req: NextRequest) {
  const auth = requireBillingClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  if (req.nextUrl.searchParams.get("refresh") === "1") {
    clearBillingDiscoveryCache();
    clearBillingStatsCache();
  }

  try {
    const resolved = await resolveAllModules(client);
    const modules = await Promise.all(BILLING_MODULES.map(async (def): Promise<BillingMetadataModuleSummary> => {
      const obj = resolved.get(def.key) ?? null;
      const summary: BillingMetadataModuleSummary = {
        moduleKey: def.key, label: def.label, group: def.group, available: !!obj, candidatesTried: def.candidates,
        sobject: obj?.sobject ?? null, createable: obj?.createable ?? false, queryable: obj?.queryable ?? false, updateable: obj?.updateable ?? false,
        fieldCount: null, createableFieldCount: null, requiredFields: [], referenceTargets: [], inlineChildren: [], inboundLinks: [], error: null,
      };
      if (!obj) return summary;
      try {
        const schema = await getModuleSchema(client, def.key);
        summary.fieldCount = schema.fields.length;
        summary.createableFieldCount = schema.fields.filter(f => f.createable).length;
        summary.requiredFields = schema.fields.filter(f => f.required && !f.system).map(f => f.name);
        summary.referenceTargets = [...new Set(schema.fields.filter(f => f.type === "reference" && !f.system).flatMap(f => f.referenceTo))];
        summary.inlineChildren = schema.children.map(c => `${c.sobject}.${c.parentField}`);
        summary.inboundLinks = schema.inboundLinks.map(l => `${l.sobject}.${l.field}`);
      } catch (err) {
        summary.error = err instanceof Error ? err.message : "Describe failed";
      }
      return summary;
    }));

    const body: BillingMetadataResponse = { success: true, apiVersion: client.apiVersion, instanceUrl: client.instanceUrl, modules };
    return NextResponse.json(body);
  } catch (err) {
    return billingErrorResponse(err, "Failed to discover Revenue Cloud Billing metadata");
  }
}
