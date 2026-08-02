/**
 * §Structural Parity Comparison (repricing-failure ticket): compare every
 * persisted field of an app-created bundle against a native-Salesforce-
 * created bundle, field by field, and name the FIRST differing field —
 * rather than guessing which Revenue Cloud field the repricing/"Product
 * Discovery" engine actually needs. Three field roles, because literal
 * value equality means different things per field:
 *   - "identity": a per-record Id that is NEVER equal across two different
 *     orgs/records by nature (Id, QuoteId, RootId, ParentItemId,
 *     ConfigurationId, ConfigurationSessionId, ProductConfigurationId,
 *     Main/Associated Quote Line) — compared by PRESENCE (populated vs
 *     null) on both sides, not literal value.
 *   - "shared-reference": a lookup to catalog/org-shared data that SHOULD
 *     be the literal same value on both sides when comparing within the
 *     same org (Product2Id, PricebookEntryId, ProductSellingModelId,
 *     Pricebook2Id, RecordTypeId, ProductRelatedComponentId, ...) —
 *     compared by exact value.
 *   - "value": a scalar the org's business data determines (BillingFrequency,
 *     SellingModelType, Quantity, ListPrice, NetUnitPrice, Status, Currency,
 *     Pricing Inclusion, Relationship Type, ...) — compared by exact value
 *     (numeric fields with a small tolerance).
 * Never fabricates a field's real API name: candidates are tried against
 * whichever keys the pasted native export and the app's own Describe-driven
 * dump actually contain; anything on neither side is silently skipped,
 * anything on only one side is flagged as "cannot compare" (not a false
 * "match"), and any field present in the native export but never named
 * here (a custom Revenue Cloud field) still gets compared via the generic
 * sweep — nothing this app doesn't know about is silently dropped either.
 */

export type FieldRole = "identity" | "shared-reference" | "value";

export interface ParityFieldSpec {
  label: string;
  apiNameCandidates: string[];
  role: FieldRole;
}

export const QLI_PARITY_FIELDS: ParityFieldSpec[] = [
  { label: "Id", apiNameCandidates: ["Id"], role: "identity" },
  { label: "Product2Id", apiNameCandidates: ["Product2Id"], role: "shared-reference" },
  { label: "PricebookEntryId", apiNameCandidates: ["PricebookEntryId"], role: "shared-reference" },
  { label: "QuoteId", apiNameCandidates: ["QuoteId"], role: "identity" },
  { label: "Quantity", apiNameCandidates: ["Quantity"], role: "value" },
  { label: "RootId", apiNameCandidates: ["RootId"], role: "identity" },
  { label: "ParentItemId", apiNameCandidates: ["ParentItemId"], role: "identity" },
  { label: "ProductSellingModelId", apiNameCandidates: ["ProductSellingModelId"], role: "shared-reference" },
  { label: "SellingModelType", apiNameCandidates: ["SellingModelType"], role: "value" },
  { label: "BillingPolicy", apiNameCandidates: ["BillingPolicyId", "BillingPolicy"], role: "shared-reference" },
  { label: "BillingTreatment", apiNameCandidates: ["BillingTreatmentId", "BillingTreatment"], role: "shared-reference" },
  { label: "BillingFrequency", apiNameCandidates: ["BillingFrequency"], role: "value" },
  { label: "Pricebook2Id", apiNameCandidates: ["Pricebook2Id"], role: "shared-reference" },
  { label: "ConfigurationId", apiNameCandidates: ["ConfigurationId"], role: "identity" },
  { label: "ConfigurationSessionId", apiNameCandidates: ["ConfigurationSessionId"], role: "identity" },
  { label: "ProductConfigurationId", apiNameCandidates: ["ProductConfigurationId"], role: "identity" },
  { label: "PriceAdjustmentSchedule", apiNameCandidates: ["PriceAdjustmentSchedule", "PriceAdjustmentScheduleId"], role: "shared-reference" },
  { label: "PricingProcedure", apiNameCandidates: ["PricingProcedure", "PricingProcedureId"], role: "shared-reference" },
  { label: "Currency", apiNameCandidates: ["CurrencyIsoCode", "Currency"], role: "value" },
  { label: "NetUnitPrice", apiNameCandidates: ["NetUnitPrice"], role: "value" },
  { label: "ListPrice", apiNameCandidates: ["ListPrice"], role: "value" },
  { label: "Status", apiNameCandidates: ["Status"], role: "value" },
  { label: "RecordType", apiNameCandidates: ["RecordTypeId", "RecordType"], role: "shared-reference" },
];

export const QLR_PARITY_FIELDS: ParityFieldSpec[] = [
  { label: "Relationship Type", apiNameCandidates: ["ProductRelationshipTypeId", "RelationshipTypeId", "RelationshipType"], role: "shared-reference" },
  { label: "Pricing Inclusion", apiNameCandidates: ["AssociatedQuoteLinePricing", "IsComponentPriceIncluded", "PricingInclusion"], role: "value" },
  { label: "Main Quote Line", apiNameCandidates: ["MainQuoteLineId", "QuoteLineItemId", "MainQuoteLine"], role: "identity" },
  { label: "Associated Quote Line", apiNameCandidates: ["AssociatedQuoteLineId", "AssociatedQuoteLine"], role: "identity" },
  { label: "Product Related Component", apiNameCandidates: ["ProductRelatedComponentId", "ProductRelatedComponent"], role: "shared-reference" },
];

export interface FieldDiffEntry {
  label: string;
  apiName: string | null;
  role: FieldRole;
  nativeValue: unknown;
  appValue: unknown;
  /** true = both sides had the field and agreed per its role's comparison rule; false = both sides had it and disagreed; null = at least one side never had this field at all, so no comparison could be made. */
  match: boolean | null;
  note: string;
}

export function normalizeKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findKey(row: Record<string, unknown>, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const norm = normalizeKey(candidate);
    const found = keys.find(k => normalizeKey(k) === norm);
    if (found) return found;
  }
  return null;
}

function isPopulated(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isPopulated(a) && !isPopulated(b)) return true;
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 1e-6;
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function classify(label: string, apiName: string | null, role: FieldRole, nativeValue: unknown, appValue: unknown, nativeHasField: boolean, appHasField: boolean): FieldDiffEntry {
  if (!nativeHasField || !appHasField) {
    return {
      label, apiName, role, nativeValue: nativeHasField ? nativeValue : undefined, appValue: appHasField ? appValue : undefined,
      match: null,
      note: !nativeHasField && !appHasField
        ? "Present in neither dataset."
        : !nativeHasField
          ? "Not present in the pasted native Salesforce export — cannot compare."
          : "Not present in this app's own Describe-driven read-back (this org's Describe may not expose it, or the read-back query for it failed) — cannot compare.",
    };
  }
  const match = role === "identity" ? isPopulated(nativeValue) === isPopulated(appValue) : valuesEqual(nativeValue, appValue);
  const note = role === "identity"
    ? (match ? `Both sides ${isPopulated(nativeValue) ? "populate" : "leave null"} this field (identity fields are compared by presence, not literal value).` : `Native ${isPopulated(nativeValue) ? "populates" : "leaves null"} this field; this app's created record ${isPopulated(appValue) ? "populates" : "leaves null"} it.`)
    : (match ? "Values match." : `Native = ${JSON.stringify(nativeValue)}; app = ${JSON.stringify(appValue)}.`);
  return { label, apiName, role, nativeValue, appValue, match, note };
}

/** Diff one native row against one matched app row — named fields first (ticket order), then every other field present in either row (custom/Revenue Cloud fields), alphabetically. */
export function diffRow(nativeRow: Record<string, unknown>, appRow: Record<string, unknown>, namedFields: ParityFieldSpec[]): FieldDiffEntry[] {
  const diffs: FieldDiffEntry[] = [];
  const usedNormalizedKeys = new Set<string>();

  for (const spec of namedFields) {
    const nativeKey = findKey(nativeRow, spec.apiNameCandidates);
    const appKey = findKey(appRow, spec.apiNameCandidates);
    if (!nativeKey && !appKey) continue; // neither side has ever heard of this field — nothing to say
    if (nativeKey) usedNormalizedKeys.add(normalizeKey(nativeKey));
    if (appKey) usedNormalizedKeys.add(normalizeKey(appKey));
    diffs.push(classify(
      spec.label, appKey ?? nativeKey, spec.role,
      nativeKey ? nativeRow[nativeKey] : undefined,
      appKey ? appRow[appKey] : undefined,
      !!nativeKey, !!appKey,
    ));
  }

  const remainingKeys = new Set<string>();
  for (const k of Object.keys(nativeRow)) if (k !== "attributes" && !usedNormalizedKeys.has(normalizeKey(k))) remainingKeys.add(k);
  for (const k of Object.keys(appRow)) if (k !== "attributes" && !usedNormalizedKeys.has(normalizeKey(k))) remainingKeys.add(k);

  for (const k of [...remainingKeys].sort((a, b) => a.localeCompare(b))) {
    const nativeKey = findKey(nativeRow, [k]);
    const appKey = findKey(appRow, [k]);
    diffs.push(classify(k, appKey ?? nativeKey, "value", nativeKey ? nativeRow[nativeKey] : undefined, appKey ? appRow[appKey] : undefined, !!nativeKey, !!appKey));
  }

  return diffs;
}

export interface RowComparison {
  matchKey: string;
  matchNote: string;
  nativeRow: Record<string, unknown> | null;
  appRow: Record<string, unknown> | null;
  diffs: FieldDiffEntry[];
  firstDifferingField: FieldDiffEntry | null;
}

/** Best-effort label for one row in the comparison output — prefers a product/name-shaped column, falls back to Id. */
function rowLabel(row: Record<string, unknown>, nameFieldCandidates: string[]): string {
  const key = findKey(row, nameFieldCandidates);
  if (key && isPopulated(row[key])) return String(row[key]);
  return (row.Id as string) ?? "(unknown row)";
}

/**
 * Pair native QuoteLineItem rows to app QuoteLineItem rows by Product2Id
 * (a standard field with a fixed API name in every org, and the one
 * identifier guaranteed to mean the same real catalog product on both
 * sides) — never by Id, which is meaningless across two different created
 * records. Falls back to positional pairing (documented, not silent) only
 * when Product2Id is missing from a row or a product appears more than
 * once on one side.
 */
export function matchQuoteLineItemRows(
  nativeRows: Record<string, unknown>[],
  appRows: Record<string, unknown>[],
): RowComparison[] {
  const appByProduct = new Map<string, Record<string, unknown>[]>();
  for (const row of appRows) {
    const key = findKey(row, ["Product2Id"]);
    const productId = key ? (row[key] as string) : null;
    if (!productId) continue;
    const list = appByProduct.get(productId) ?? [];
    list.push(row);
    appByProduct.set(productId, list);
  }

  const results: RowComparison[] = [];
  const consumedAppRows = new Set<Record<string, unknown>>();

  for (const nativeRow of nativeRows) {
    const productKey = findKey(nativeRow, ["Product2Id"]);
    const productId = productKey ? (nativeRow[productKey] as string) : null;
    const candidates = productId ? (appByProduct.get(productId) ?? []) : [];
    const unconsumed = candidates.filter(c => !consumedAppRows.has(c));
    const appRow = unconsumed[0] ?? null;
    if (appRow) consumedAppRows.add(appRow);

    const label = rowLabel(nativeRow, ["Name", "Product2.Name", "ProductName"]);
    const matchNote = !productId
      ? "Native row has no Product2Id — could not match to an app-created line at all."
      : !appRow
        ? `No app-created line found for Product2Id ${productId} — this product from the native bundle is MISSING from the app-created bundle entirely.`
        : unconsumed.length > 1
          ? `${unconsumed.length} app-created lines share Product2Id ${productId} — paired with the first unmatched one; ambiguous if this product legitimately appears more than once in the bundle.`
          : "Matched by Product2Id.";

    const diffs = appRow ? diffRow(nativeRow, appRow, QLI_PARITY_FIELDS) : [];
    results.push({
      matchKey: productId ?? label,
      matchNote,
      nativeRow,
      appRow,
      diffs,
      firstDifferingField: diffs.find(d => d.match === false) ?? null,
    });
  }

  // App-created lines with no native counterpart at all — surfaced explicitly, never silently dropped.
  for (const row of appRows) {
    if (consumedAppRows.has(row)) continue;
    const key = findKey(row, ["Product2Id"]);
    const productId = key ? (row[key] as string) : null;
    results.push({
      matchKey: productId ?? rowLabel(row, ["Name", "Product2.Name", "ProductName"]),
      matchNote: `This app created a line for Product2Id ${productId ?? "(unknown)"} that has no counterpart in the pasted native export.`,
      nativeRow: null,
      appRow: row,
      diffs: [],
      firstDifferingField: null,
    });
  }

  return results;
}

/**
 * Pair native QuoteLineRelationship rows to app relationship rows by the
 * (parent Product2Id, child Product2Id) pair — resolved by joining each
 * side's own relationship row back to its own QuoteLineItem Product2Id map,
 * since the relationship's own Main/Associated Quote Line Ids are
 * per-dataset identities (never equal across native vs. app) but the
 * PRODUCTS they ultimately point at are the same real catalog data on both
 * sides.
 */
export function matchRelationshipRows(
  nativeEdges: Record<string, unknown>[],
  nativeQliProductById: Map<string, string>,
  nativeMainField: string | null,
  nativeAssociatedField: string | null,
  appEdges: Record<string, unknown>[],
  appQliProductById: Map<string, string>,
  appMainField: string | null,
  appAssociatedField: string | null,
): RowComparison[] {
  function pairKey(row: Record<string, unknown>, productById: Map<string, string>, mainField: string | null, associatedField: string | null): string | null {
    const mainKey = mainField ? findKey(row, [mainField, "MainQuoteLineId", "QuoteLineItemId"]) : findKey(row, ["MainQuoteLineId", "QuoteLineItemId"]);
    const assocKey = associatedField ? findKey(row, [associatedField, "AssociatedQuoteLineId"]) : findKey(row, ["AssociatedQuoteLineId"]);
    const mainId = mainKey ? (row[mainKey] as string) : null;
    const assocId = assocKey ? (row[assocKey] as string) : null;
    const parentProduct = mainId ? productById.get(mainId) : null;
    const childProduct = assocId ? productById.get(assocId) : null;
    if (!parentProduct || !childProduct) return null;
    return `${parentProduct}::${childProduct}`;
  }

  const appByKey = new Map<string, Record<string, unknown>[]>();
  for (const row of appEdges) {
    const key = pairKey(row, appQliProductById, appMainField, appAssociatedField);
    if (!key) continue;
    const list = appByKey.get(key) ?? [];
    list.push(row);
    appByKey.set(key, list);
  }

  const results: RowComparison[] = [];
  const consumed = new Set<Record<string, unknown>>();
  for (const nativeRow of nativeEdges) {
    const key = pairKey(nativeRow, nativeQliProductById, nativeMainField, nativeAssociatedField);
    const candidates = key ? (appByKey.get(key) ?? []) : [];
    const unconsumed = candidates.filter(c => !consumed.has(c));
    const appRow = unconsumed[0] ?? null;
    if (appRow) consumed.add(appRow);

    const matchNote = !key
      ? "Could not resolve this native relationship edge's parent/child product pair — one of its QuoteLineItem references wasn't found in the pasted native QuoteLineItem export."
      : !appRow
        ? `No app-created relationship found for parent/child product pair (${key}) — this edge from the native bundle is MISSING in the app-created bundle.`
        : "Matched by (parent product, child product) pair.";

    const diffs = appRow ? diffRow(nativeRow, appRow, QLR_PARITY_FIELDS) : [];
    results.push({
      matchKey: key ?? "(unresolved)",
      matchNote,
      nativeRow,
      appRow,
      diffs,
      firstDifferingField: diffs.find(d => d.match === false) ?? null,
    });
  }

  for (const row of appEdges) {
    if (consumed.has(row)) continue;
    const key = pairKey(row, appQliProductById, appMainField, appAssociatedField);
    results.push({
      matchKey: key ?? "(unresolved)",
      matchNote: `This app created a relationship edge (${key ?? "unresolved pair"}) with no counterpart in the pasted native export.`,
      nativeRow: null,
      appRow: row,
      diffs: [],
      firstDifferingField: null,
    });
  }

  return results;
}
