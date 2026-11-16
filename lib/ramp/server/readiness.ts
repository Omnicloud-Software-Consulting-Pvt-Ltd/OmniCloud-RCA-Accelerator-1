import type { SalesforceClient } from "@/lib/salesforce/client";
import { retrieveExpressionSetDefinitionFiles } from "@/lib/pricing-rules/attribute-based/create/templateExpressionSet";
import { evaluateUpliftReadiness, inspectProcedureXml, type ContextTagFacts, type UpliftReadiness } from "@/lib/ramp/readiness";
import type { RampCapabilities } from "@/lib/ramp/capabilities";
import { soql, type RampApi } from "./api";

/**
 * Pricing readiness for ramp uplifts — READ-ONLY: the org's pricing procedures (ExpressionSet, UsageType DefaultPricing), the chosen
 * one's definition (metadata retrieve, the app's shared retrieval — nothing is deployed), and the ramp context tags + what feeds them.
 */
export async function pricingProcedures(api: RampApi) {
  const sets = await api.query<{ Id: string; ApiName: string; Name: string }>("SELECT Id, ApiName, Name FROM ExpressionSet WHERE UsageType = 'DefaultPricing' ORDER BY Name LIMIT 50");
  const active = sets.length ? await api.query<{ ExpressionSetId: string; VersionNumber: number; ApiName: string }>(`SELECT ExpressionSetId, VersionNumber, ApiName FROM ExpressionSetVersion WHERE IsActive = true AND ExpressionSetId IN (${sets.map(s => soql(s.Id)).join(",")})`).catch(() => []) : [];
  return sets.map(s => ({ id: s.Id, apiName: s.ApiName, name: s.Name, activeVersion: active.find(a => a.ExpressionSetId === s.Id)?.VersionNumber ?? null }));
}

export async function contextTags(api: RampApi): Promise<ContextTagFacts[] | null> {
  try {
    const titles = ["ItemRampUpliftType__std", "ItemUnitPriceUplift__std", "ItemRampIdentifier"];
    const tags = await api.query<{ Title: string; ContextAttributeId: string | null }>(`SELECT Title, ContextAttributeId FROM ContextTag WHERE Title IN (${titles.map(soql).join(",")}) LIMIT 50`);
    const attrIds = tags.map(t => t.ContextAttributeId).filter((x): x is string => !!x);
    const maps = attrIds.length ? await api.query<{ ContextAttributeId: string; ContextInputAttributeName: string | null }>(`SELECT ContextAttributeId, ContextInputAttributeName FROM ContextAttributeMapping WHERE ContextAttributeId IN (${attrIds.map(soql).join(",")}) LIMIT 200`) : [];
    return titles.map(title => ({ title, mappedFrom: [...new Set(tags.filter(t => t.Title === title).flatMap(t => maps.filter(m => m.ContextAttributeId === t.ContextAttributeId).map(m => m.ContextInputAttributeName).filter((x): x is string => !!x)))] })).filter(t => tags.some(x => x.Title === t.title));
  } catch {
    return null; // the user can't read context metadata — the definition checks still run
  }
}

export async function upliftReadiness(client: SalesforceClient, api: RampApi, procedureApiName: string, caps: RampCapabilities): Promise<UpliftReadiness & { retrieveWarning: string | null }> {
  const { files, warning } = await retrieveExpressionSetDefinitionFiles(client, [procedureApiName]);
  const file = files.find(f => f.fileName.includes(procedureApiName)) ?? files[0];
  const inspection = inspectProcedureXml(procedureApiName, file?.content ?? "");
  const tags = await contextTags(api);
  return { ...evaluateUpliftReadiness(inspection, tags, { compoundGroup: caps.compound.group, compoundLine: caps.compound.line }), retrieveWarning: file ? null : warning ?? "The pricing procedure definition couldn't be retrieved." };
}
