/**
 * Shared describe/field-resolution toolbox (§2.1, §6.3 of the Quote/QLI spec).
 *
 * Every Salesforce field the Quote module ever reads or writes is resolved
 * dynamically at runtime through these helpers — never assumed by literal
 * API name beyond a "try this well-known name first" fast path. This file
 * is the ONE place that logic lives; resolvers in lib/quotes/metadata/*
 * compose these primitives instead of re-implementing field lookup.
 */

import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { createTTLCache } from "@/lib/salesforce/cache";

/** A resolved field, carrying enough of Describe's metadata for both display and SOQL relationship traversal. */
export interface FieldRef {
  apiName: string;
  label: string;
  /** The field's real Describe `relationshipName` (e.g. "Account" for `AccountId`) — null if none exists. Never guess this. */
  relationshipName?: string | null;
}

/**
 * Convert a resolved DescribeField into the app-wide FieldRef shape,
 * carrying the field's real `relationshipName` (e.g. "Account" for
 * `AccountId`, "Owner__r" for a custom `Owner__c` lookup) so callers can
 * dot-walk parent relationships in SOQL correctly. NEVER derive a
 * relationship name by string-guessing (e.g. stripping "Id") — a field
 * with no `relationshipName` in Describe means relationship traversal
 * genuinely isn't available for it, and callers must degrade accordingly
 * rather than fabricate one.
 */
export function toFieldRef(f: DescribeField | null): FieldRef | null {
  return f ? { apiName: f.name, label: f.label, relationshipName: f.relationshipName ?? null } : null;
}

/* ── Describe caching (10-min TTL, keyed by instance URL; never caches a failure) ── */

const describeObjectCache = createTTLCache<DescribeResult>();
const describeGlobalCache = createTTLCache<{ name: string; label: string; labelPlural: string; createable: boolean; queryable: boolean }[]>();

export async function describeObjectCached(client: SalesforceClient, sobject: string): Promise<DescribeResult> {
  const key = `${client.instanceUrl}:${sobject}`;
  return describeObjectCache.getOrCompute(key, () => client.describeObject(sobject));
}

export async function describeGlobalCached(client: SalesforceClient) {
  const key = client.instanceUrl;
  return describeGlobalCache.getOrCompute(key, async () => (await client.describeSObjects()).sobjects);
}

/** Clear cached describe results for an instance (e.g. after a schema-changing action). */
export function clearDescribeCache(instanceUrl: string) {
  describeGlobalCache.clear(instanceUrl);
  // Per-object entries are keyed `${instanceUrl}:${sobject}` — clear the whole
  // cache since we don't track which objects were cached for this instance.
  describeObjectCache.clear();
}

/* ── Field-lookup toolbox ── */

/** Exact API name match, optionally requiring createable (for write targets). */
export function findFieldByExactName(
  describe: DescribeResult,
  apiName: string,
  opts: { requireCreateable?: boolean } = {},
): DescribeField | null {
  const field = describe.fields.find(f => f.name === apiName);
  if (!field) return null;
  if (opts.requireCreateable && !field.createable) return null;
  return field;
}

/** Case-insensitive label match against a fixed string or regex pattern. */
export function findFieldByLabel(
  describe: DescribeResult,
  pattern: string | RegExp,
  opts: { requireCreateable?: boolean } = {},
): DescribeField | null {
  const re = typeof pattern === "string" ? new RegExp(`^${escapeRegExp(pattern)}$`, "i") : pattern;
  const field = describe.fields.find(f => re.test(f.label));
  if (!field) return null;
  if (opts.requireCreateable && !field.createable) return null;
  return field;
}

/**
 * Resolve a field by exact name first, falling back to a label pattern.
 * The single entry point most resolvers should use — implements §2.1's
 * "try well-known name, fall back to label, else null (absent)" strategy.
 */
export function resolveField(
  describe: DescribeResult,
  wellKnownName: string,
  labelPattern: string | RegExp,
  opts: { requireCreateable?: boolean } = {},
): DescribeField | null {
  return (
    findFieldByExactName(describe, wellKnownName, opts) ??
    findFieldByLabel(describe, labelPattern, opts)
  );
}

/**
 * Find an "accessible" field by name-or-label. Prefer this only when the
 * `accessible` flag is known-reliable for the object in question — several
 * RCA junction objects (ProductSellingModelOption, billing objects) have
 * been observed to report `accessible: false` on fields that are in fact
 * queryable, so query-only lookups should use `findReferenceFieldInfo`
 * (below) instead, which does not gate on `accessible`.
 */
export function findAccessibleFieldByNameOrLabel(
  describe: DescribeResult,
  wellKnownName: string,
  labelPattern: string | RegExp,
): DescribeField | null {
  const field = resolveField(describe, wellKnownName, labelPattern);
  if (!field) return null;
  return field.accessible === false ? null : field;
}

/**
 * Every reference field on this object whose referenceTo includes the
 * target object. Pass `requireCreateable: true` for any field this app
 * intends to WRITE — without it, a field that is present but read-only
 * (e.g. system-managed / derived-from-another-object) will still be
 * returned, and Salesforce will reject the create/update call with
 * "Unable to create/update fields: <name>" once we try to send it.
 */
export function findAllReferenceFieldsToTarget(
  describe: DescribeResult,
  targetObject: string,
  opts: { requireCreateable?: boolean } = {},
): DescribeField[] {
  return describe.fields.filter(
    f => f.type === "reference" && f.referenceTo?.includes(targetObject) && (!opts.requireCreateable || f.createable),
  );
}

/** The first reference field on this object pointing at the target object (well-known-first is up to the caller). */
export function findReferenceFieldByTargetObject(
  describe: DescribeResult,
  targetObject: string,
  opts: { requireCreateable?: boolean } = {},
): DescribeField | null {
  return findAllReferenceFieldsToTarget(describe, targetObject, opts)[0] ?? null;
}

/** A reference field resolved purely by label pattern, without requiring `referenceTo` to match anything specific. */
export function findReferenceFieldByLabel(describe: DescribeResult, labelPattern: string | RegExp): DescribeField | null {
  const re = typeof labelPattern === "string" ? new RegExp(`^${escapeRegExp(labelPattern)}$`, "i") : labelPattern;
  return describe.fields.find(f => f.type === "reference" && re.test(f.label)) ?? null;
}

/**
 * Reference-field lookup that never gates on `accessible` — for
 * query-only relationship fields on junction/component objects where that
 * flag has been empirically unreliable (§2.1 point 3, §4.2). Existence in
 * the describe result is sufficient.
 */
export function findReferenceFieldInfo(
  describe: DescribeResult,
  wellKnownName: string,
  targetObject?: string,
): DescribeField | null {
  const byName = describe.fields.find(f => f.name === wellKnownName && f.type === "reference");
  if (byName) return byName;
  if (targetObject) return findReferenceFieldByTargetObject(describe, targetObject);
  return null;
}

/** Active picklist options + the org-marked default (or null if none marked default). */
export interface PicklistResolution {
  field: DescribeField;
  activeOptions: { value: string; label: string }[];
  defaultValue: string | null;
}

export function findPicklistFieldByLabel(
  describe: DescribeResult,
  wellKnownName: string,
  labelPattern: string | RegExp,
  opts: { requireCreateable?: boolean } = {},
): PicklistResolution | null {
  const field = resolveField(describe, wellKnownName, labelPattern, opts);
  if (!field || !field.picklistValues) return null;
  const activeOptions = field.picklistValues
    .filter(v => v.active)
    .map(v => ({ value: v.value, label: v.label }));
  const defaultValue = field.picklistValues.find(v => v.active && v.defaultValue)?.value ?? null;
  return { field, activeOptions, defaultValue };
}

/**
 * Audit every field on an object that is createable, non-nillable, and not
 * defaulted-on-create — i.e. every field Salesforce will reject a create
 * call for if it's left out. Used to discover "what does this junction
 * object actually require" (§5.5) without hardcoding field names.
 */
export function findRequiredCreateableFields(describe: DescribeResult): DescribeField[] {
  return describe.fields.filter(f => f.createable && !f.nillable && !f.defaultedOnCreate);
}

/**
 * Classify candidate objects for the bundle relationship/group/override
 * discovery (§2.4, §5.1) by how many reference fields they carry to a
 * given target object (e.g. Product2).
 */
export function countReferencesToTarget(describe: DescribeResult, targetObject: string): number {
  return findAllReferenceFieldsToTarget(describe, targetObject).length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decode Salesforce Describe's base64 `validFor` bitmask for a dependent
 * picklist value: is this value valid when the controlling field's option
 * at `controllingIndex` (its position within the controller's OWN
 * `picklistValues` array, or 0/1 for a checkbox controller) is selected?
 * This is Salesforce's real, documented dependent-picklist encoding —
 * never approximate or guess it.
 */
export function isValidForControllingIndex(validFor: string | undefined, controllingIndex: number): boolean {
  if (!validFor || controllingIndex < 0) return false;
  const bytes = Buffer.from(validFor, "base64");
  const byteIndex = Math.floor(controllingIndex / 8);
  const bitIndex = 7 - (controllingIndex % 8);
  if (byteIndex >= bytes.length) return false;
  return (bytes[byteIndex] & (1 << bitIndex)) !== 0;
}

/**
 * Resolve which of a dependent picklist's ACTIVE values are valid given the
 * controlling field's real, already-known value on this record — decoded
 * from Describe's own `validFor` bitmask, never guessed. Pass the
 * controller's DescribeField so the controlling value's index (its
 * position in the controller's own picklist, or 0/1 for a checkbox
 * controller) can be computed correctly.
 */
export function filterDependentPicklistValues(
  field: DescribeField,
  controllerField: DescribeField,
  controllingValue: string | boolean,
): NonNullable<DescribeField["picklistValues"]> {
  const activeValues = field.picklistValues?.filter(v => v.active) ?? [];
  let controllingIndex: number;
  if (typeof controllingValue === "boolean") {
    controllingIndex = controllingValue ? 1 : 0; // Salesforce checkbox controllers: index 0 = unchecked, 1 = checked.
  } else {
    controllingIndex = controllerField.picklistValues?.findIndex(v => v.value === controllingValue) ?? -1;
  }
  if (controllingIndex < 0) return activeValues; // Can't determine the index — degrade to "all active", never fabricate a filter.
  return activeValues.filter(v => isValidForControllingIndex(v.validFor, controllingIndex));
}
