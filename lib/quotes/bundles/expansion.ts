import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, resolveField } from "@/lib/salesforce/describe";
import { fetchCatalogProductsByIds } from "@/lib/quotes/catalog/search";
import { resolveSellingModelsBatch } from "@/lib/quotes/catalog/sellingModel";
import { resolveProductAttributesBatch } from "@/lib/quotes/catalog/attributes";
import { resolveBillingFrequency, resolveSubscriptionTerm, type LineItemObjectName } from "@/lib/quotes/billing/frequency";
import { validateBillingTreatment } from "@/lib/quotes/billing/treatment";
import type {
  BundleCandidateQueryDiagnostic,
  BundleComponent,
  BundleComponentGroupInfo,
  BundleExpansionDiagnostics,
  BundleExpansionResult,
  BundleObjectDiscovery,
  SkippedComponent,
} from "@/lib/quotes/types";

/**
 * §Inspect the actual API calls being made: one real, product-scoped query
 * per {object, field} pair from Product2's own relationship metadata,
 * treating each field in turn as the candidate "parent" role — run ONLY
 * when normal expansion found zero children (the exact case needing this
 * data), never on every product add. Logs SOQL, WHERE clause, row count,
 * relationship Ids, and any OTHER Product2-referencing field's values on
 * the same object (the candidate "child" ids) — empirical evidence for
 * which object+field actually holds this specific product's structure,
 * comparable directly against what Salesforce's own Product Structure page
 * displays for it.
 */
async function runCandidateRelationshipQueries(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  rootProductId: string,
): Promise<BundleCandidateQueryDiagnostic[]> {
  const fieldsByObject = new Map<string, string[]>();
  for (const rel of discovery.diagnostics.product2ChildRelationships) {
    const list = fieldsByObject.get(rel.childSObject) ?? [];
    list.push(rel.field);
    fieldsByObject.set(rel.childSObject, list);
  }

  const results: BundleCandidateQueryDiagnostic[] = [];
  for (const [object, fields] of fieldsByObject) {
    for (const field of fields) {
      const otherFields = fields.filter(f => f !== field);
      const whereClause = `${field} = '${soqlEscape(rootProductId)}'`;
      const soql = `SELECT Id${otherFields.length > 0 ? `, ${otherFields.join(", ")}` : ""} FROM ${object} WHERE ${whereClause}`;
      try {
        const res = await client.query<Record<string, unknown>>(soql);
        const relationshipIds = res.records.map(r => r.Id as string);
        const returnedProduct2Ids = [...new Set(
          res.records.flatMap(r => otherFields.map(f => r[f] as string | undefined).filter((v): v is string => !!v)),
        )];
        results.push({ object, fieldQueried: field, soql, whereClause, parentProductId: rootProductId, rowCount: res.records.length, relationshipIds, returnedProduct2Ids });
        console.log(`[bundle-candidate-query] ${soql} -> ${res.records.length} row(s). relationshipIds=[${relationshipIds.join(", ")}] product2Ids=[${returnedProduct2Ids.join(", ")}]`);
      } catch (err) {
        results.push({ object, fieldQueried: field, soql, whereClause, parentProductId: rootProductId, rowCount: -1, relationshipIds: [], returnedProduct2Ids: [] });
        console.error(`[bundle-candidate-query] FAILED: ${soql}`, err instanceof Error ? err.message : err);
      }
    }
  }
  return results;
}

/**
 * §Investigation Required: everything the ticket asked to be logged before
 * a Bundle is (or isn't) expanded. Every field is resolved honestly —
 * Product2.Type / an IsBundle-shaped field are read ONLY if this org
 * actually exposes them (via Describe), never fabricated or assumed.
 */
async function buildExpansionDiagnostics(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  rootProductId: string,
  components: BundleComponent[],
  isBundle: boolean,
  candidateQueries: BundleCandidateQueryDiagnostic[],
  queryErrors: string[],
): Promise<BundleExpansionDiagnostics> {
  let rootProductFamily: string | null = null;
  let rootProductType: string | null = null;
  let detectedIsBundleField: boolean | null = null;
  try {
    const productDescribe = await describeObjectCached(client, "Product2");
    const familyField = resolveField(productDescribe, "Family", /^(product )?family$/i);
    const typeField = resolveField(productDescribe, "Type", /^(product )?type$/i);
    const isBundleField = resolveField(productDescribe, "IsBundle", /^is bundle$/i);
    const selectFields = [familyField?.name, typeField?.name, isBundleField?.name].filter((f): f is string => !!f);
    if (selectFields.length > 0) {
      const row = await client.query<Record<string, unknown>>(
        `SELECT ${selectFields.join(", ")} FROM Product2 WHERE Id = '${soqlEscape(rootProductId)}' LIMIT 1`,
      );
      const record = row.records[0] ?? {};
      rootProductFamily = familyField ? ((record[familyField.name] as string) ?? null) : null;
      rootProductType = typeField ? ((record[typeField.name] as string) ?? null) : null;
      detectedIsBundleField = isBundleField ? !!record[isBundleField.name] : null;
    }
  } catch (err) {
    console.error(`[buildExpansionDiagnostics] Failed to read Product2 diagnostic fields for ${rootProductId}:`, err instanceof Error ? err.message : err);
  }

  const resolvedChildProductIds = components.map(c => c.productId);
  const relationshipFieldsMappingFailed =
    !!discovery.relationshipObject && (!discovery.relationshipFields?.parentProductField || !discovery.relationshipFields?.childProductField);
  const reasons: string[] = [];
  let classification: BundleExpansionDiagnostics["classification"];

  if (!discovery.relationshipObject && !discovery.groupObject) {
    classification = "SCHEMA_UNRESOLVED";
    reasons.push(`No bundle relationship/group object discovered in this org: ${discovery.diagnostics.reason}`);
  } else if (relationshipFieldsMappingFailed) {
    // §A relationship object EXISTS in this org's schema, but this app could
    // not resolve which of its fields point to the parent vs. the child
    // Product2 — queryRelationshipRows never even attempts a query in this
    // case (its own guard clause), so this must never be confused with
    // "queried and genuinely found 0 rows".
    classification = "RELATIONSHIP_MAPPING_FAILED";
    reasons.push(
      `Relationship object "${discovery.relationshipObject}" was discovered, but its parent/child Product2 reference fields could not be resolved ` +
      `(parentProductField=${discovery.relationshipFields?.parentProductField?.apiName ?? "unresolved"}, childProductField=${discovery.relationshipFields?.childProductField?.apiName ?? "unresolved"}) — NO query was ever attempted for this product as a result.`,
    );
  } else if (resolvedChildProductIds.length === 0 && queryErrors.length > 0) {
    // §Standalone Product mislabeling: a real query failure (permission/FLS/
    // malformed-field error) is a fundamentally different situation than
    // "genuinely 0 rows" — never let the two look the same in diagnostics.
    classification = "QUERY_FAILED";
    reasons.push(
      `Bundle detection could NOT be completed for this product — ${queryErrors.length} query failure(s) occurred while resolving relationship rows/component groups, NOT a genuine "0 components" result: ${queryErrors.join(" | ")}`,
    );
  } else if (resolvedChildProductIds.length === 0) {
    classification = "NOT_A_BUNDLE";
    reasons.push(
      discovery.relationshipObject
        ? `Relationship object "${discovery.relationshipObject}" was discovered, its parent/child fields resolved, and the query for Product2Id="${rootProductId}" ran successfully — but returned 0 rows. This product genuinely has no component rows via this mechanism in this org.`
        : `Only a group object ("${discovery.groupObject}") was discovered, no relationship object — component GROUPS may exist for this product without any linked child rows.`,
    );
  } else {
    classification = "BUNDLE_WITH_COMPONENTS";
    const ungroupedCount = components.filter(c => !c.groupId).length;
    reasons.push(
      `Resolved ${resolvedChildProductIds.length} direct child component(s) via "${discovery.relationshipObject}" ` +
      `(${ungroupedCount} ungrouped/fixed — always auto-included, ${resolvedChildProductIds.length - ungroupedCount} in a component group).`,
    );
  }

  // §Compare against what Salesforce Product Structure displays: if ANY
  // candidate {object, field} probe found rows for this exact product that
  // the app's own chosen relationship/field did NOT, name it explicitly —
  // that mismatch is the empirical answer to "which object does Structure
  // actually use", not a guess.
  const productiveQueries = candidateQueries.filter(q => q.rowCount > 0);
  if (productiveQueries.length > 0 && resolvedChildProductIds.length === 0) {
    for (const q of productiveQueries) {
      reasons.push(`Candidate probe FOUND DATA the chosen resolver missed: ${q.object}.${q.fieldQueried} = this product returned ${q.rowCount} row(s) (relationshipIds=[${q.relationshipIds.join(", ")}], product2Ids=[${q.returnedProduct2Ids.join(", ")}]) — this is very likely the real bundle-structure object/field for this org.`);
    }
  } else if (candidateQueries.length > 0 && resolvedChildProductIds.length === 0) {
    reasons.push(`Probed ${candidateQueries.length} candidate {object, field} pair(s) from Product2.childRelationships — NONE returned any rows for this product. Either this product genuinely has no structure defined via any object referencing Product2, or the Structure page reads from an object with no direct foreign key to Product2 at all (e.g. a junction one level removed).`);
  }

  const diagnostics: BundleExpansionDiagnostics = {
    rootProductId, rootProductFamily, rootProductType, detectedIsBundleField,
    bundleDetectionResult: isBundle,
    relationshipObjectUsed: discovery.relationshipObject,
    groupObjectUsed: discovery.groupObject,
    resolvedChildCount: resolvedChildProductIds.length,
    resolvedChildProductIds,
    expansionSucceeded: true,
    reasons,
    candidateQueries,
    queryErrors,
    classification,
  };
  console.log(
    `[expandBundle] product=${rootProductId} family=${rootProductFamily ?? "n/a"} type=${rootProductType ?? "n/a"} ` +
    `detectedIsBundleField=${detectedIsBundleField ?? "n/a"} isBundle=${isBundle} classification=${classification} relationshipObject=${discovery.relationshipObject ?? "none"} ` +
    `groupObject=${discovery.groupObject ?? "none"} childCount=${resolvedChildProductIds.length} childIds=[${resolvedChildProductIds.join(", ")}] ` +
    `queryErrors=${JSON.stringify(queryErrors)} reasons=${JSON.stringify(reasons)}`,
  );
  return diagnostics;
}

/**
 * §Bundle Pricing: a bundle component's price is included in the parent
 * bundle's price BY DEFAULT — that's how Salesforce Revenue Cloud bundle
 * pricing actually works. Only treat a component as separately priced when
 * Salesforce's own data EXPLICITLY says so via a resolved field — never the
 * reverse. A field that fails to resolve, or a picklist whose active value
 * can't be identified, means "no explicit signal", not "not included".
 */
function resolvePricingInclusion(
  fields: NonNullable<BundleObjectDiscovery["relationshipFields"]>,
  row: Record<string, unknown>,
): boolean {
  if (!fields.pricingInclusionField) return true;
  const raw = row[fields.pricingInclusionField.apiName];
  if (fields.pricingInclusionKind === "picklist") {
    if (raw == null) return true;
    if (fields.pricingInclusionNotIncludedValue != null) return raw !== fields.pricingInclusionNotIncludedValue;
    if (fields.pricingInclusionIncludedValue != null) return raw === fields.pricingInclusionIncludedValue;
    return true;
  }
  if (fields.pricingInclusionKind === "boolean") return raw == null ? true : !!raw;
  return true;
}

const MAX_BUNDLE_DEPTH = 5;

interface RelationshipRow {
  Id: string;
  ChildProductId: string;
  GroupId: string | null;
  RelationshipTypeId: string | null;
  PricingInclusion: boolean;
  Quantity: number;
  IsDefault: boolean;
  IsRequired: boolean;
}

/**
 * §Standalone Product mislabeling investigation: a query failure here
 * (permission/FLS error, or a malformed field from an ambiguous parent/
 * child mapping) used to be swallowed into a bare `[]` — indistinguishable
 * from "this product genuinely has zero components". That silent
 * degradation is a real, plausible cause of a genuine bundle showing as
 * "Standalone Product": the caller (expandNode) cannot tell the two cases
 * apart. Errors are now pushed onto `errors` (surfaced in
 * BundleExpansionDiagnostics.queryErrors) so a real query failure is
 * reported honestly instead of masquerading as "no bundle structure".
 */
async function queryRelationshipRows(client: SalesforceClient, discovery: BundleObjectDiscovery, parentProductId: string, errors: string[]): Promise<RelationshipRow[]> {
  const rel = discovery.relationshipObject;
  const fields = discovery.relationshipFields;
  if (!rel || !fields?.parentProductField || !fields.childProductField) return [];

  const selectFields = ["Id", fields.childProductField.apiName];
  if (fields.groupField) selectFields.push(fields.groupField.apiName);
  if (fields.relationshipTypeField) selectFields.push(fields.relationshipTypeField.apiName);
  if (fields.pricingInclusionField) selectFields.push(fields.pricingInclusionField.apiName);
  if (fields.quantityField) selectFields.push(fields.quantityField.apiName);
  if (fields.isDefaultField) selectFields.push(fields.isDefaultField.apiName);
  if (fields.isRequiredField) selectFields.push(fields.isRequiredField.apiName);

  const soql = `SELECT ${selectFields.join(", ")} FROM ${rel} WHERE ${fields.parentProductField.apiName} = '${soqlEscape(parentProductId)}'`;
  try {
    const res = await client.query<Record<string, unknown>>(soql);
    return res.records.map(r => ({
      Id: r.Id as string,
      ChildProductId: r[fields.childProductField!.apiName] as string,
      GroupId: fields.groupField ? ((r[fields.groupField.apiName] as string) ?? null) : null,
      RelationshipTypeId: fields.relationshipTypeField ? ((r[fields.relationshipTypeField.apiName] as string) ?? null) : null,
      PricingInclusion: resolvePricingInclusion(fields, r),
      Quantity: fields.quantityField ? ((r[fields.quantityField.apiName] as number) ?? 1) : 1,
      IsDefault: fields.isDefaultField ? !!r[fields.isDefaultField.apiName] : false,
      IsRequired: fields.isRequiredField ? !!r[fields.isRequiredField.apiName] : false,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Relationship-row query FAILED for product ${parentProductId} (${soql}): ${message}`);
    console.error(`[queryRelationshipRows] FAILED: ${soql}`, message);
    return [];
  }
}

/**
 * Resolve Product Component Groups for a bundle instance, applying any
 * per-bundle override's Min/Max on top of the base group's numbers (§5.2) —
 * a base group's minimum can legitimately read as 0 while a specific
 * bundle instance still enforces a real minimum via its override record.
 */
async function resolveComponentGroups(client: SalesforceClient, discovery: BundleObjectDiscovery, parentProductId: string, errors: string[] = []): Promise<BundleComponentGroupInfo[]> {
  const groupObject = discovery.groupObject;
  const groupFields = discovery.groupFields;
  if (!groupObject || !groupFields?.parentProductField) return [];

  const selectFields = ["Id"];
  if (groupFields.nameField) selectFields.push(groupFields.nameField.apiName);
  if (groupFields.minField) selectFields.push(groupFields.minField.apiName);
  if (groupFields.maxField) selectFields.push(groupFields.maxField.apiName);

  const soql = `SELECT ${selectFields.join(", ")} FROM ${groupObject} WHERE ${groupFields.parentProductField.apiName} = '${soqlEscape(parentProductId)}'`;
  let groupRows: Record<string, unknown>[];
  try {
    const res = await client.query<Record<string, unknown>>(soql);
    groupRows = res.records;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Component-group query FAILED for product ${parentProductId} (${soql}): ${message}`);
    console.error(`[resolveComponentGroups] FAILED: ${soql}`, message);
    return [];
  }
  if (groupRows.length === 0) return [];

  // Overrides: rows on the override object scoped to this specific bundle instance (productField) + a group (groupField).
  const overridesByGroup = new Map<string, { min: number | null; max: number | null }>();
  const overrideObject = discovery.groupOverrideObject;
  const overrideFields = discovery.groupOverrideFields;
  if (overrideObject && overrideFields?.productField && overrideFields.groupField) {
    try {
      const selectOverride = ["Id", overrideFields.groupField.apiName];
      if (overrideFields.minField) selectOverride.push(overrideFields.minField.apiName);
      if (overrideFields.maxField) selectOverride.push(overrideFields.maxField.apiName);
      const overrideRes = await client.query<Record<string, unknown>>(
        `SELECT ${selectOverride.join(", ")} FROM ${overrideObject} WHERE ${overrideFields.productField.apiName} = '${soqlEscape(parentProductId)}'`,
      );
      for (const row of overrideRes.records) {
        const groupId = row[overrideFields.groupField.apiName] as string;
        overridesByGroup.set(groupId, {
          min: overrideFields.minField ? ((row[overrideFields.minField.apiName] as number) ?? null) : null,
          max: overrideFields.maxField ? ((row[overrideFields.maxField.apiName] as number) ?? null) : null,
        });
      }
    } catch {
      /* overrides are optional — proceed with base group numbers only */
    }
  }

  return groupRows.map(row => {
    const id = row.Id as string;
    const baseMin = groupFields.minField ? ((row[groupFields.minField.apiName] as number) ?? null) : null;
    const baseMax = groupFields.maxField ? ((row[groupFields.maxField.apiName] as number) ?? null) : null;
    const override = overridesByGroup.get(id);
    const min = override?.min ?? baseMin;
    const max = override?.max ?? baseMax;
    return {
      id,
      name: groupFields.nameField ? ((row[groupFields.nameField.apiName] as string) ?? "Component Group") : "Component Group",
      min,
      max,
      minSource: override?.min != null ? "override" : baseMin != null ? "group" : "unresolved",
    };
  });
}

interface ExpandContext {
  client: SalesforceClient;
  discovery: BundleObjectDiscovery;
  pricebookId: string;
  maxDepth: number;
  visited: Set<string>;
  skipped: SkippedComponent[];
  /** Real SOQL query failures encountered anywhere in this expansion — never silently swallowed (§Standalone Product mislabeling). */
  errors: string[];
  path: string[];
  maxDepthReached: { value: number };
  /** Which line-item object a component's billing frequency/subscription term must ultimately be resolved/validated against — QuoteLineItem when expanding for a Quote, OrderItem when expanding for an Order (§Order billing frequency parity fix). */
  lineItemObject: LineItemObjectName;
}

/**
 * §Slow Add fix (Issue 2): every sibling row's billing-frequency/treatment/
 * term resolution, and its own recursive child-expansion, is fully
 * independent of every OTHER row's Salesforce calls — a multi-component
 * bundle previously resolved one component at a time (sequential awaits in
 * a for-loop), which is the dominant cost behind a slow "+ Add" on a
 * bundle product. Running every row concurrently via Promise.all is safe:
 * nothing here has Salesforce dependency ordering ACROSS siblings (each
 * recursive call gets its own cloned `visited` set, so there is no shared
 * mutable state whose correctness depends on ordering — only `ctx.skipped`/
 * `ctx.errors` are appended to concurrently, which is safe since JS array
 * push is synchronous and these are diagnostic/order-insensitive lists).
 */
async function expandNode(ctx: ExpandContext, parentProductId: string, depth: number): Promise<BundleComponent[]> {
  ctx.maxDepthReached.value = Math.max(ctx.maxDepthReached.value, depth);
  if (depth > ctx.maxDepth) return [];

  const [rows, groups] = await Promise.all([
    queryRelationshipRows(ctx.client, ctx.discovery, parentProductId, ctx.errors),
    resolveComponentGroups(ctx.client, ctx.discovery, parentProductId, ctx.errors),
  ]);
  if (rows.length === 0) return [];

  const groupsById = new Map(groups.map(g => [g.id, g]));
  const childIds = [...new Set(rows.map(r => r.ChildProductId))];
  const productMap = await fetchCatalogProductsByIds(ctx.client, ctx.pricebookId, childIds);

  const resolvedChildIds = childIds.filter(id => productMap.has(id));
  const pricebookEntryByProductId = new Map(resolvedChildIds.map(id => [id, productMap.get(id)!.pricebookEntryId]));
  const [sellingModels, attributes] = await Promise.all([
    resolveSellingModelsBatch(ctx.client, resolvedChildIds, pricebookEntryByProductId),
    resolveProductAttributesBatch(ctx.client, resolvedChildIds),
  ]);

  const components = await Promise.all(rows.map(async (row): Promise<BundleComponent> => {
    const product = productMap.get(row.ChildProductId) ?? null;
    const componentPath = [...ctx.path, product?.name ?? row.ChildProductId];

    if (!product) {
      // Structurally real but unresolvable (batch fetch failed / not in pricebook at all) —
      // still surface the row so nothing is silently dropped, but skip recursion+config resolution.
      ctx.skipped.push({ productId: row.ChildProductId, productName: null, reason: "Product record could not be resolved.", path: componentPath });
      return {
        productId: row.ChildProductId,
        product: null,
        relationshipId: row.Id,
        groupId: row.GroupId,
        group: row.GroupId ? (groupsById.get(row.GroupId) ?? null) : null,
        relationshipTypeId: row.RelationshipTypeId,
        isDefault: row.IsDefault,
        isRequired: row.IsRequired,
        quantity: row.Quantity,
        pricingInclusion: row.PricingInclusion,
        pricebookStatus: "missing",
        isBundle: false,
        children: [],
        childGroups: [],
        attributes: [],
        sellingModel: null,
        billingFrequency: null,
        subscriptionTerm: null,
        billingTreatment: null,
        skippedComponents: [],
      };
    }

    const sellingModel = sellingModels.get(row.ChildProductId) ?? null;
    const needsBillingFrequency = !!sellingModel?.chosen?.requiresBillingFrequency;
    const [billingFrequency, billingTreatment] = await Promise.all([
      needsBillingFrequency
        ? resolveBillingFrequency(ctx.client, row.ChildProductId, sellingModel!.chosen!.sellingModelId, sellingModel!.chosen!.name, ctx.lineItemObject)
        : Promise.resolve(null),
      needsBillingFrequency
        ? validateBillingTreatment(ctx.client, row.ChildProductId)
        : Promise.resolve(null),
    ]);
    const subscriptionTerm =
      sellingModel?.chosen?.type === "TermDefined"
        ? await resolveSubscriptionTerm(ctx.client, row.ChildProductId, sellingModel.chosen.sellingModelId, ctx.lineItemObject)
        : null;
    // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
    // failures are confirmed resolved): per-component resolution — proves
    // whether a bundle CHILD's own Billing Frequency was actually resolved
    // during expansion, independent of the parent's.
    console.log(`[BILLING FREQUENCY BUNDLE] childProductId=${row.ChildProductId} ("${product.name}") sellingModelType=${sellingModel?.chosen?.type ?? "null"} requiresBillingFrequency=${needsBillingFrequency} -> billingFrequency.value=${billingFrequency?.value ?? "null"} source=${billingFrequency?.source ?? "null"}.`);

    let children: BundleComponent[] = [];
    let childGroups: BundleComponentGroupInfo[] = [];
    let nestedSkipped: SkippedComponent[] = [];

    if (!ctx.visited.has(row.ChildProductId) && depth < ctx.maxDepth) {
      const childCtx: ExpandContext = { ...ctx, visited: new Set([...ctx.visited, row.ChildProductId]), path: componentPath, skipped: [] };
      [children, childGroups] = await Promise.all([
        expandNode(childCtx, row.ChildProductId, depth + 1),
        resolveComponentGroups(ctx.client, ctx.discovery, row.ChildProductId, ctx.errors),
      ]);
      nestedSkipped = childCtx.skipped;
      ctx.skipped.push(...nestedSkipped); // roll nested skips up to the top-level caller (§5.2 step 6)
    } else if (ctx.visited.has(row.ChildProductId)) {
      ctx.skipped.push({ productId: row.ChildProductId, productName: product.name, reason: "Circular bundle reference detected — stopped recursion.", path: componentPath });
    }

    return {
      productId: row.ChildProductId,
      product,
      relationshipId: row.Id,
      groupId: row.GroupId,
      group: row.GroupId ? (groupsById.get(row.GroupId) ?? null) : null,
      relationshipTypeId: row.RelationshipTypeId,
      isDefault: row.IsDefault,
      isRequired: row.IsRequired,
      quantity: row.Quantity,
      pricingInclusion: row.PricingInclusion,
      pricebookStatus: "resolved",
      isBundle: children.length > 0 || childGroups.length > 0,
      children,
      childGroups,
      attributes: attributes.get(row.ChildProductId) ?? [],
      sellingModel,
      billingFrequency,
      subscriptionTerm,
      billingTreatment,
      skippedComponents: nestedSkipped,
    };
  }));

  return components;
}

/**
 * Recursively expand a bundle's component structure (§5.2). Guarded by a
 * max-depth constant and a per-path `visited` set to hard-stop on a genuine
 * circular bundle reference. A product with no directly-attached component
 * rows can still be a bundle purely by virtue of having component groups.
 */
export async function expandBundle(
  client: SalesforceClient,
  discovery: BundleObjectDiscovery,
  rootProductId: string,
  pricebookId: string,
  lineItemObject: LineItemObjectName = "QuoteLineItem",
): Promise<BundleExpansionResult> {
  const maxDepthReached = { value: 0 };
  const skipped: SkippedComponent[] = [];
  const errors: string[] = [];
  const ctx: ExpandContext = {
    client, discovery, pricebookId,
    maxDepth: MAX_BUNDLE_DEPTH,
    visited: new Set([rootProductId]),
    skipped,
    errors,
    path: [],
    maxDepthReached,
    lineItemObject,
  };

  const [components, groups] = await Promise.all([
    expandNode(ctx, rootProductId, 0),
    resolveComponentGroups(client, discovery, rootProductId, errors),
  ]);
  const isBundle = components.length > 0 || groups.length > 0;
  // Only run the exhaustive per-candidate query sweep when normal expansion
  // found zero direct children — that's the one case needing this evidence;
  // paying for it on every successful add would be pure overhead.
  const candidateQueries = components.length === 0 ? await runCandidateRelationshipQueries(client, discovery, rootProductId) : [];
  const diagnostics = await buildExpansionDiagnostics(client, discovery, rootProductId, components, isBundle, candidateQueries, errors);

  return {
    rootProductId,
    isBundle,
    components,
    groups,
    skippedComponents: skipped,
    depthReached: maxDepthReached.value,
    diagnostics,
  };
}
