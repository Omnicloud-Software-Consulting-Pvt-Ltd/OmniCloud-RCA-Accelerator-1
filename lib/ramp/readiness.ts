/**
 * PRICING READINESS for ramp uplifts (pure — the definition XML and context mappings are read by server/readiness.ts).
 *
 * Verified in p12 (2026-11-09, read-only retrieve of Revenue_Management_Default_Pricing_Procedure_Cloned, active version 7):
 * Salesforce applies ramp uplifts in a PriceRevision step (<actionType>PriceRevision</actionType>) whose parameters map
 *   PolicyAdjustment        ← ItemUnitPriceUplift__std   (the segment's UnitPriceUplift %)
 *   UpliftMethod            ← ItemRampUpliftType__std    (Standard | Compound — from RampUpliftType)
 *   IsCompoundUpliftEnabled = true (Literal)             (compounding allowed)
 *   RampIdentifier          ← ItemRampIdentifier
 * and the context tags ItemRampUpliftType__std / ItemUnitPriceUplift__std / ItemRampIdentifier exist (ContextTag.Title), hydrated
 * through ContextAttributeMapping.ContextInputAttributeName (RampUpliftType, UnitPriceUplift, RampIdentifier).
 */

export interface ProcedureVersionInfo { fullName: string | null; status: string | null; versionNumber: number | null }
export interface PriceRevisionInfo { stepName: string | null; params: Record<string, { type: string | null; value: string | null }> }
export interface ProcedureInspection {
  procedure: string;
  activeVersion: ProcedureVersionInfo | null;
  versions: ProcedureVersionInfo[];
  priceRevision: PriceRevisionInfo | null;
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
const blocks = (xml: string, name: string) => xml.split(`<${name}>`).slice(1).map(b => b.split(`</${name}>`)[0]);

/** Parse an ExpressionSetDefinition file: its versions, the Active one, and its PriceRevision step parameters. */
export function inspectProcedureXml(procedure: string, xml: string): ProcedureInspection {
  const versionXml = blocks(xml, "versions");
  const versions = versionXml.map(v => ({ fullName: tag(v, "fullName"), status: (v.match(/<status>([^<]*)<\/status>/g) ?? []).map(s => s.replace(/<\/?status>/g, "")).find(s => /^(Active|Inactive|Draft)$/.test(s)) ?? null, versionNumber: Number(tag(v, "versionNumber")) || null }));
  const activeIdx = versions.findIndex(v => v.status === "Active");
  if (activeIdx < 0) return { procedure, activeVersion: null, versions, priceRevision: null };
  const step = blocks(versionXml[activeIdx], "steps").find(s => /<actionType>PriceRevision<\/actionType>/.test(s));
  let priceRevision: PriceRevisionInfo | null = null;
  if (step) {
    const params: PriceRevisionInfo["params"] = {};
    for (const p of blocks(step, "parameters")) { const n = tag(p, "name"); if (n) params[n] = { type: tag(p, "type"), value: tag(p, "value") }; }
    priceRevision = { stepName: tag(step.replace(/<customElement>[\s\S]*<\/customElement>/, ""), "name"), params };
  }
  return { procedure, activeVersion: versions[activeIdx], versions, priceRevision };
}

export interface ReadinessCheck { id: string; label: string; ok: boolean; detail: string; fix: string | null }
export interface UpliftReadiness { procedure: string; standardReady: boolean; compoundReady: boolean; checks: ReadinessCheck[] }

/** Context tags found in the org and what feeds them (ContextAttributeMapping.ContextInputAttributeName). */
export interface ContextTagFacts { title: string; mappedFrom: string[] }

export function evaluateUpliftReadiness(i: ProcedureInspection, tags: ContextTagFacts[] | null, caps: { compoundGroup: boolean; compoundLine: boolean }): UpliftReadiness {
  const checks: ReadinessCheck[] = [];
  const p = i.priceRevision?.params ?? {};
  const add = (id: string, label: string, ok: boolean, detail: string, fix: string | null) => checks.push({ id, label, ok, detail, fix: ok ? null : fix });
  add("active-version", "Pricing procedure has an Active version", !!i.activeVersion, i.activeVersion ? `${i.activeVersion.fullName ?? ""} (v${i.activeVersion.versionNumber ?? "?"})` : "No Active version.", "Activate a version of this pricing procedure in Salesforce (Expression Set Builder).");
  add("price-revision", "Active version has a Price Revision element", !!i.priceRevision, i.priceRevision ? `Step "${i.priceRevision.stepName}"` : "No PriceRevision step.", "Add a Price Revision element to the active pricing procedure version — without it Salesforce ignores segment uplifts.");
  const adj = p.PolicyAdjustment?.value ?? p.PreviousSegmentMultiplier?.value ?? null;
  add("uplift-input", "Uplift % feeds the Price Revision (PolicyAdjustment ← ItemUnitPriceUplift__std)", adj === "ItemUnitPriceUplift__std", `PolicyAdjustment ← ${adj ?? "not mapped"}`, "Map the Price Revision's PolicyAdjustment parameter to the context tag ItemUnitPriceUplift__std.");
  add("ramp-id", "Ramp identifier feeds the Price Revision", p.RampIdentifier?.value === "ItemRampIdentifier", `RampIdentifier ← ${p.RampIdentifier?.value ?? "not mapped"}`, "Map the Price Revision's RampIdentifier parameter to ItemRampIdentifier.");
  const method = p.UpliftMethod?.value ?? null;
  add("uplift-method", "Uplift method feeds the Price Revision (UpliftMethod ← ItemRampUpliftType__std)", method === "ItemRampUpliftType__std", `UpliftMethod ← ${method ?? "not mapped"}`, "Map the Price Revision's UpliftMethod parameter to the context tag ItemRampUpliftType__std.");
  const compoundFlag = p.IsCompoundUpliftEnabled;
  add("compound-enabled", "Compound uplift enabled on the Price Revision", compoundFlag?.value === "true", `IsCompoundUpliftEnabled = ${compoundFlag?.value ?? "not set"}`, "Set the Price Revision's IsCompoundUpliftEnabled parameter to true.");
  if (tags) {
    const has = (t: string) => tags.find(x => x.title === t);
    const typeTag = has("ItemRampUpliftType__std"), upliftTag = has("ItemUnitPriceUplift__std");
    add("tag-uplift", "Context tag ItemUnitPriceUplift__std exists and is mapped", !!upliftTag && upliftTag.mappedFrom.some(m => /UnitPriceUplift/i.test(m)), upliftTag ? `mapped from ${upliftTag.mappedFrom.join(", ") || "nothing"}` : "Tag not found.", "In the Sales Transaction context definition, map QuoteLineItem / QuoteLineGroup UnitPriceUplift to ItemUnitPriceUplift__std.");
    add("tag-type", "Context tag ItemRampUpliftType__std exists and is mapped", !!typeTag && typeTag.mappedFrom.some(m => /RampUpliftType/i.test(m)), typeTag ? `mapped from ${typeTag.mappedFrom.join(", ") || "nothing"}` : "Tag not found.", "In the Sales Transaction context definition, map RampUpliftType to ItemRampUpliftType__std.");
  }
  add("compound-writable", "RampUpliftType can be set from the app", caps.compoundGroup || caps.compoundLine, caps.compoundGroup ? (caps.compoundLine ? "On groups and lines." : "On group ramp segments (QuoteLineGroup.RampUpliftType); read-only on lines.") : "Not writable on QuoteLineGroup or QuoteLineItem.", "Enable Ramp Deals for Groups in Revenue Settings — QuoteLineGroup.RampUpliftType becomes writable.");
  const ok = (id: string) => checks.find(c => c.id === id)?.ok ?? true;
  const standardReady = ok("active-version") && ok("price-revision") && ok("uplift-input") && ok("ramp-id") && ok("tag-uplift");
  const compoundReady = standardReady && ok("uplift-method") && ok("compound-enabled") && ok("tag-type") && ok("compound-writable");
  return { procedure: i.procedure, standardReady, compoundReady, checks };
}
