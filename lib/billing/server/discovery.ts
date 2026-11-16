import type { NextRequest } from "next/server";
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { createTTLCache } from "@/lib/salesforce/cache";
import {
  BILLING_MODULES, getBillingModule, SYSTEM_FIELDS, displayFieldLabel,
  type BillingModuleDef,
} from "@/lib/billing/registry";
import type { BillingFieldMeta, BillingModuleSchema } from "@/lib/billing/types";
import { TAX_MODULES } from "@/lib/taxes/modules";

/**
 * Revenue Cloud Billing objects (UsageResourceBillingPolicy, RateAdjustmentByTier,
 * BillingScheduleGroup, ...) only exist on recent API versions — the app-wide
 * v60.0/v62.0 defaults predate several of them. Every billing route uses this
 * one version so Describe, SOQL and Composite calls all see the same schema.
 */
export const SF_API_VERSION_BILLING = "v64.0";

/**
 * Taxes section objects need a newer version than billing: the 2026-10-07 metadata audit found TaxTreatmentItem and
 * TaxEngine.DecisionTableId only on API 68.0 (TaxTreatmentItem isn't in the v64 global describe). Used ONLY for Taxes
 * requests, so every Revenue Cloud Billing request keeps SF_API_VERSION_BILLING.
 */
export const SF_API_VERSION_TAXES = "v68.0";
const TAX_MODULE_KEYS = new Set(TAX_MODULES.map(m => m.key));
/** SObjects of the Taxes section (for lookup searches that target them). */
export const TAX_SOBJECTS = new Set(TAX_MODULES.flatMap(m => m.candidates));

/** /api/taxes/*, or a generic /api/billing/<tax module>/* request made by the shared record components for a Taxes module. */
function isTaxesRequest(req: NextRequest): boolean {
  const seg = req.nextUrl.pathname.split("/").filter(Boolean);
  return seg[0] === "api" && (seg[1] === "taxes" || (seg[1] === "billing" && TAX_MODULE_KEYS.has(seg[2] ?? "")));
}

/** The existing shared auth guard (session cookie → SalesforceClient with transparent refresh), pinned to the billing API version (Taxes requests: the taxes version). */
export function requireBillingClient(req: NextRequest, opts: { taxes?: boolean } = {}) {
  return requireSFClient(req, opts.taxes || isTaxesRequest(req) ? SF_API_VERSION_TAXES : SF_API_VERSION_BILLING);
}

export class BillingModuleUnavailableError extends Error {
  moduleKey: string;
  candidatesTried: string[];
  constructor(moduleKey: string, candidatesTried: string[], message?: string) {
    super(message ?? `This Salesforce org has no object for "${getBillingModule(moduleKey)?.label ?? moduleKey}" (looked for: ${candidatesTried.join(", ") || "nothing"}).`);
    this.name = "BillingModuleUnavailableError";
    this.moduleKey = moduleKey;
    this.candidatesTried = candidatesTried;
  }
}

type GlobalEntry = { name: string; label: string; labelPlural: string; createable: boolean; queryable: boolean; updateable?: boolean; keyPrefix?: string | null };

// Keyed by instance URL AND api version — the shared describe caches are version-agnostic,
// and a v62 describe of the same object can legitimately be missing fields that v64 has.
const globalCache = createTTLCache<GlobalEntry[]>();
const objectCache = createTTLCache<DescribeResult>();

export async function billingDescribeGlobal(client: SalesforceClient): Promise<GlobalEntry[]> {
  return globalCache.getOrCompute(`${client.cacheScope}:${client.apiVersion}`, async () => (await client.describeSObjects()).sobjects);
}

export async function billingDescribe(client: SalesforceClient, sobject: string): Promise<DescribeResult> {
  return objectCache.getOrCompute(`${client.cacheScope}:${client.apiVersion}:${sobject}`, () => client.describeObject(sobject));
}

export interface ResolvedModuleObject {
  moduleKey: string;
  sobject: string;
  label: string;
  labelPlural: string;
  createable: boolean;
  queryable: boolean;
  updateable: boolean;
}

/** Resolve a module's candidate objects against the global Describe only (one cached call covers every module). */
export function resolveModuleFromGlobal(def: Pick<BillingModuleDef, "key" | "candidates" | "labelPattern">, global: GlobalEntry[]): ResolvedModuleObject | null {
  const byName = new Map(global.map(g => [g.name, g]));
  let hit: GlobalEntry | undefined;
  for (const candidate of def.candidates) {
    hit = byName.get(candidate);
    if (hit) break;
  }
  if (!hit && def.labelPattern) {
    hit = global.find(g => g.queryable && def.labelPattern!.test(g.label) && !/(History|Share|Feed|ChangeEvent)$/.test(g.name));
  }
  if (!hit) return null;
  return {
    moduleKey: def.key,
    sobject: hit.name,
    label: hit.label,
    labelPlural: hit.labelPlural,
    createable: hit.createable,
    queryable: hit.queryable,
    updateable: hit.updateable ?? false,
  };
}

/** Every registry module resolved against the org — `null` entries are modules this org doesn't have. */
export async function resolveAllModules(client: SalesforceClient): Promise<Map<string, ResolvedModuleObject | null>> {
  const global = await billingDescribeGlobal(client);
  return new Map(BILLING_MODULES.map(def => [def.key, resolveModuleFromGlobal(def, global)]));
}

/** SObject API name → billing module key, for every module this org actually has. */
export async function moduleKeyBySobject(client: SalesforceClient): Promise<Map<string, string>> {
  const resolved = await resolveAllModules(client);
  const map = new Map<string, string>();
  for (const [key, obj] of resolved) if (obj && !map.has(obj.sobject)) map.set(obj.sobject, key);
  return map;
}

export function toBillingFieldMeta(f: DescribeField, moduleBySobject: Map<string, string>): BillingFieldMeta {
  const referenceTo = f.referenceTo ?? [];
  const referenceModules: Record<string, string> = {};
  for (const target of referenceTo) {
    const key = moduleBySobject.get(target);
    if (key) referenceModules[target] = key;
  }
  const createable = !!f.createable;
  return {
    name: f.name,
    label: displayFieldLabel(f.label, f.type),
    type: f.type,
    required: createable && f.nillable === false && !f.defaultedOnCreate && f.type !== "boolean",
    createable,
    updateable: !!f.updateable,
    nillable: f.nillable !== false,
    defaultedOnCreate: !!f.defaultedOnCreate,
    isNameField: !!f.nameField,
    length: f.length ?? null,
    precision: f.precision ?? null,
    scale: f.scale ?? null,
    helpText: f.inlineHelpText ?? null,
    picklistValues: (f.picklistValues ?? []).filter(p => p.active).map(p => ({ value: p.value, label: p.label, isDefault: !!p.defaultValue, validFor: p.validFor })),
    restrictedPicklist: !!f.restrictedPicklist,
    controllerName: f.controllerName ?? null,
    referenceTo,
    relationshipName: f.relationshipName ?? null,
    referenceModules,
    calculated: !!f.calculated,
    custom: !!f.custom,
    system: SYSTEM_FIELDS.has(f.name),
  };
}

export function nameFieldOf(describe: DescribeResult): DescribeField | null {
  return describe.fields.find(f => f.nameField) ?? describe.fields.find(f => f.name === "Name") ?? null;
}

function firstPresentField(describe: DescribeResult, candidates: string[]): DescribeField | null {
  for (const name of candidates) {
    const f = describe.fields.find(x => x.name === name);
    if (f) return f;
  }
  return null;
}

const schemaCache = createTTLCache<BillingModuleSchema>();

/**
 * The full, org-specific schema of one billing module: fields straight from
 * Describe, registry columns resolved to fields that really exist, inline
 * child modules with the child's real reference field back to the parent,
 * and inbound links filtered to ones whose target field exists, is
 * updateable, and actually references the right object.
 */
export async function getModuleSchema(client: SalesforceClient, moduleKey: string): Promise<BillingModuleSchema> {
  const def = getBillingModule(moduleKey);
  if (!def) throw new BillingModuleUnavailableError(moduleKey, [], `Unknown billing module "${moduleKey}".`);

  return schemaCache.getOrCompute(`${client.cacheScope}:${client.apiVersion}:${moduleKey}`, async () => {
    const global = await billingDescribeGlobal(client);
    const resolved = resolveModuleFromGlobal(def, global);
    if (!resolved) throw new BillingModuleUnavailableError(moduleKey, def.candidates);

    const describe = await billingDescribe(client, resolved.sobject);
    const bySobject = await moduleKeyBySobject(client);
    const fields = describe.fields
      // Compound address/geolocation containers aren't writable/readable as one value — their component fields are listed individually.
      .filter(f => f.type !== "address" && f.type !== "location")
      .map(f => toBillingFieldMeta(f, bySobject));

    const nameField = nameFieldOf(describe);
    const statusField = firstPresentField(describe, def.statusFields);

    const columns: BillingModuleSchema["columns"] = [];
    for (const col of def.columns) {
      const f = firstPresentField(describe, col.fields);
      if (!f || f.name === nameField?.name) continue;
      columns.push({ id: col.id, label: col.label ?? displayFieldLabel(f.label, f.type), field: f.name, type: f.type, referenceTo: f.referenceTo ?? [] });
    }

    const children: BillingModuleSchema["children"] = [];
    for (const childKey of def.children ?? []) {
      const childDef = getBillingModule(childKey);
      const childObj = childDef ? resolveModuleFromGlobal(childDef, global) : null;
      if (!childDef || !childObj || !childObj.createable) continue;
      try {
        const childDescribe = await billingDescribe(client, childObj.sobject);
        const parentField = childDescribe.fields.find(f => f.type === "reference" && f.createable && f.referenceTo?.includes(resolved.sobject));
        if (parentField) children.push({ moduleKey: childKey, label: childDef.label, singular: childDef.singular, sobject: childObj.sobject, parentField: parentField.name });
      } catch {
        // A child object that can't be described is simply not offered inline — never guessed.
      }
    }

    const inboundLinks: BillingModuleSchema["inboundLinks"] = [];
    for (const link of def.inboundLinks ?? []) {
      if (!global.some(g => g.name === link.sobject)) continue;
      try {
        const targetDescribe = await billingDescribe(client, link.sobject);
        const targetField = targetDescribe.fields.find(f => f.name === link.field);
        if (!targetField || targetField.type !== "reference" || !targetField.updateable) continue;
        const expectedTarget = link.valueSource === "self"
          ? resolved.sobject
          : describe.fields.find(f => f.name === (link.valueSource as { field: string }).field)?.referenceTo?.[0];
        if (!expectedTarget || !targetField.referenceTo?.includes(expectedTarget)) continue;
        inboundLinks.push({
          sobject: link.sobject,
          field: link.field,
          fieldLabel: displayFieldLabel(targetField.label, targetField.type),
          valueSource: link.valueSource,
          label: link.label,
          appModule: link.appModule,
        });
      } catch {
        // Target object not describable for this user — skip the link rather than offer one that would fail.
      }
    }

    const childRelationships = (describe.childRelationships ?? [])
      .filter(c => !!c.relationshipName && (bySobject.has(c.childSObject) || c.childSObject === "Product2"))
      .map(c => ({ childSObject: c.childSObject, field: c.field, relationshipName: c.relationshipName, moduleKey: bySobject.get(c.childSObject) ?? null }));

    return {
      moduleKey,
      sobject: resolved.sobject,
      label: describe.label,
      labelPlural: describe.labelPlural,
      createable: resolved.createable,
      updateable: resolved.updateable,
      queryable: resolved.queryable,
      nameField: nameField?.name ?? null,
      statusField: statusField?.name ?? null,
      fields,
      childRelationships,
      columns,
      children,
      inboundLinks,
      apiVersion: client.apiVersion,
    };
  });
}

/** Clear every billing discovery cache for this org (e.g. the dashboard's "Refresh metadata" action). */
export function clearBillingDiscoveryCache(): void {
  globalCache.clear();
  objectCache.clear();
  schemaCache.clear();
}
