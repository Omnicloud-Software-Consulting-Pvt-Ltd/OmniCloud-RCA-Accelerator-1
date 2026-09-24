/**
 * Schema-driven discovery of a bundle's real child components from Salesforce.
 *
 * Per the governing spec: never assume one bundle-relationship object exists. This module Describe-checks
 * a priority-ordered list of candidate relationship objects and uses the FIRST one that (a) genuinely
 * exists on this org, (b) exposes two distinct reference fields to Product2 (a "parent" one and a "child"
 * one — the only reliable way to distinguish them when both point at the same target object), and (c)
 * actually has at least one row for the requested bundle. `ProductRelatedComponent` is tried first because
 * it is this codebase's own already-proven, already-working bundle-structure object (see
 * lib/bundles/server/relationships.ts) — but nothing here hardcodes it as the ONLY possibility.
 *
 * Never invents a component, a relationship, or a quantity. A field that doesn't exist on this org's
 * schema is simply left null on every discovered component — never guessed.
 */
import type { SalesforceClient, DescribeField } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, findAllReferenceFieldsToTarget } from "@/lib/salesforce/describe";
import type { BundleRelationshipSource, DiscoveredBundle, DiscoveredBundleComponent } from "./types";
import type { EnrichedBundleProduct } from "./bundleLookup";

/** Priority order — proven-in-this-codebase object first, then the newer Revenue Cloud Advanced /
 * legacy CPQ relationship objects a differently-configured org might use instead. */
const CANDIDATE_RELATIONSHIP_OBJECTS: BundleRelationshipSource[] = [
  "ProductRelatedComponent",
  "ProductRelationship",
  "ProductComponent",
  "ProductComponentGroup",
  // Legacy CPQ package object — included for orgs that never migrated to the newer Revenue Cloud
  // Advanced relationship objects above. Its two Product2-reference fields
  // (SBQQ__ConfiguredSKU__c/SBQQ__OptionalSKU__c) don't match the parent/child naming heuristic below, so
  // `pickParentChild`'s "exactly 2 candidates, first-and-remaining" fallback is what actually resolves it.
  "SBQQ__ProductOption__c" as BundleRelationshipSource,
];

interface RelationshipFieldMap {
  objectName: BundleRelationshipSource;
  parentField: string;
  childField: string;
  sequenceField: string | null;
  quantityField: string | null;
  requiredField: string | null;
  defaultField: string | null;
  groupField: string | null;
}

function pickParentChild(refs: DescribeField[]): { parent: DescribeField; child: DescribeField } | null {
  if (refs.length < 2) return null;
  const parent = refs.find(f => /parent/i.test(f.name) || /parent/i.test(f.label)) ?? refs[0];
  const child = refs.find(f => f.name !== parent.name && (/child/i.test(f.name) || /child/i.test(f.label)))
    ?? refs.find(f => f.name !== parent.name);
  if (!child) return null;
  return { parent, child };
}

async function resolveRelationshipFieldMap(client: SalesforceClient, objectName: BundleRelationshipSource): Promise<RelationshipFieldMap | null> {
  let describe;
  try {
    describe = await describeObjectCached(client, objectName);
  } catch {
    return null; // object doesn't exist / not accessible on this org — not a hard failure, just try the next candidate
  }
  if (!describe || describe.fields.length === 0) return null;

  const product2Refs = findAllReferenceFieldsToTarget(describe, "Product2");
  const picked = pickParentChild(product2Refs);
  if (!picked) return null;

  const sequenceField = describe.fields.find(f => /^sequence$/i.test(f.name))?.name ?? null;
  const quantityField = describe.fields.find(f => /^(quantity|minquantity|defaultquantity|min_?quantity__c)$/i.test(f.name))?.name ?? null;
  const requiredField = describe.fields.find(f => /^iscomponentrequired$/i.test(f.name) || /required/i.test(f.label))?.name ?? null;
  const defaultField = describe.fields.find(f => /^isdefaultcomponent$/i.test(f.name) || /default/i.test(f.label))?.name ?? null;
  const groupField = describe.fields.find(f => /componentgroup/i.test(f.name))?.name ?? null;

  return {
    objectName,
    parentField: picked.parent.name,
    childField: picked.child.name,
    sequenceField, quantityField, requiredField, defaultField, groupField,
  };
}

export interface BundleStructureAttempt {
  objectName: BundleRelationshipSource;
  fieldsResolved: boolean;
  rowCount: number;
}

export interface BundleStructureResolution {
  bundle: DiscoveredBundle | null;
  /** Every relationship object actually checked, and what was found — for diagnostics when a bundle has zero components. */
  attempts: BundleStructureAttempt[];
}

/** Given an already-resolved parent Product2 (the bundle), discover its real child components. */
export async function discoverBundleStructure(
  client: SalesforceClient,
  bundleProduct: EnrichedBundleProduct,
): Promise<BundleStructureResolution> {
  const attempts: BundleStructureAttempt[] = [];

  for (const objectName of CANDIDATE_RELATIONSHIP_OBJECTS) {
    const map = await resolveRelationshipFieldMap(client, objectName);
    if (!map) {
      attempts.push({ objectName, fieldsResolved: false, rowCount: 0 });
      continue;
    }

    const selectFields = [
      "Id", map.childField,
      ...(map.sequenceField ? [map.sequenceField] : []),
      ...(map.quantityField ? [map.quantityField] : []),
      ...(map.requiredField ? [map.requiredField] : []),
      ...(map.defaultField ? [map.defaultField] : []),
      ...(map.groupField ? [map.groupField] : []),
    ];
    let rows: Record<string, unknown>[] = [];
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT ${[...new Set(selectFields)].join(", ")} FROM ${objectName} WHERE ${map.parentField} = '${soqlEscape(bundleProduct.id)}' ORDER BY ${map.sequenceField ?? "Id"}`,
      );
      rows = res.records;
    } catch {
      attempts.push({ objectName, fieldsResolved: true, rowCount: 0 });
      continue;
    }

    attempts.push({ objectName, fieldsResolved: true, rowCount: rows.length });
    if (rows.length === 0) continue;

    const components = await buildComponents(client, objectName, map, rows);
    return {
      bundle: {
        id: bundleProduct.id, name: bundleProduct.name, productCode: bundleProduct.productCode,
        status: bundleProduct.status, currency: bundleProduct.currency, basePrice: bundleProduct.basePrice,
        components, relationshipSource: objectName,
      },
      attempts,
    };
  }

  return { bundle: null, attempts };
}

async function buildComponents(
  client: SalesforceClient,
  objectName: BundleRelationshipSource,
  map: RelationshipFieldMap,
  rows: Record<string, unknown>[],
): Promise<DiscoveredBundleComponent[]> {
  const childIds = [...new Set(rows.map(r => String(r[map.childField])).filter(Boolean))];
  if (childIds.length === 0) return [];
  const idList = childIds.map(id => `'${soqlEscape(id)}'`).join(",");

  const childRes = await client.query<{ Id: string; Name: string; ProductCode: string | null }>(
    `SELECT Id, Name, ProductCode FROM Product2 WHERE Id IN (${idList})`,
  );
  const childById = new Map(childRes.records.map(c => [c.Id, c]));

  const priceByChildId = new Map<string, number>();
  try {
    const pbeRes = await client.query<{ Product2Id: string; UnitPrice: number }>(
      `SELECT Product2Id, UnitPrice FROM PricebookEntry WHERE Product2Id IN (${idList}) AND Pricebook2.IsStandard = true AND IsActive = true LIMIT 500`,
    );
    for (const pbe of pbeRes.records) priceByChildId.set(pbe.Product2Id, pbe.UnitPrice);
  } catch { /* PricebookEntry may not be accessible — leave prices null rather than guessing */ }

  const sellingModelByChildId = new Map<string, string>();
  try {
    const psmRes = await client.query<{ Product2Id: string; ProductSellingModel: { Name: string } | null }>(
      `SELECT Product2Id, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id IN (${idList}) LIMIT 500`,
    );
    for (const psm of psmRes.records) {
      const name = psm.ProductSellingModel?.Name;
      if (name) sellingModelByChildId.set(psm.Product2Id, name);
    }
  } catch { /* ProductSellingModelOption may not be accessible — leave selling models null rather than guessing */ }

  return rows.map(r => {
    const childId = String(r[map.childField]);
    const child = childById.get(childId);
    const quantityRaw = map.quantityField ? r[map.quantityField] : null;
    const sequenceRaw = map.sequenceField ? r[map.sequenceField] : null;
    return {
      productId: childId,
      productName: child?.Name ?? "Unknown Product",
      productCode: child?.ProductCode ?? null,
      sequence: typeof sequenceRaw === "number" ? sequenceRaw : sequenceRaw != null ? Number(sequenceRaw) : null,
      quantity: typeof quantityRaw === "number" ? quantityRaw : quantityRaw != null && Number.isFinite(Number(quantityRaw)) ? Number(quantityRaw) : null,
      isDefaultComponent: map.defaultField ? (r[map.defaultField] as boolean | null) ?? null : null,
      isComponentRequired: map.requiredField ? (r[map.requiredField] as boolean | null) ?? null : null,
      componentGroup: map.groupField ? ((r[map.groupField] as string | null) ?? null) : null,
      relationshipId: String(r.Id),
      basePrice: priceByChildId.get(childId) ?? null,
      sellingModel: sellingModelByChildId.get(childId) ?? null,
    };
  });
}
