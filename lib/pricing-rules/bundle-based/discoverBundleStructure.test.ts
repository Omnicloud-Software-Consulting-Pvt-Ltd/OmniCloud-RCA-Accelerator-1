/**
 * Bundle structure discovery coverage — verifies the Describe-driven, priority-ordered relationship-object
 * search (never hardcoded to a single object): ProductRelatedComponent first (this codebase's own
 * already-proven bundle object), falling back to another relationship object when the org's schema
 * doesn't expose the first one, and reporting "no components found anywhere" (never inventing a
 * component) when nothing matches.
 *
 * Same caveat as every other *.test.ts in this repo: no test framework/runner is installed — this file
 * type-checks under `tsc --noEmit` but needs a TypeScript-aware runner (e.g. `npx tsx --test`) to execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { discoverBundleStructure } from "./discoverBundleStructure";
import type { EnrichedBundleProduct } from "./bundleLookup";

const BUNDLE: EnrichedBundleProduct = { id: "01t000000000001AAA", name: "Laptop Basic Bundle", productCode: "BUNDLE-1", status: "Active", currency: "USD", basePrice: 999 };

function describeWithFields(fields: { name: string; type: string; referenceTo?: string[]; label?: string }[]): DescribeResult {
  return { name: "x", label: "x", labelPlural: "x", fields: fields.map(f => ({ name: f.name, label: f.label ?? f.name, type: f.type, referenceTo: f.referenceTo })), recordTypeInfos: [], urls: {} };
}

let mockClientCounter = 0;

/** §Test-isolation note — `discoverBundleStructure.ts` resolves fields through `describeObjectCached`
 * (lib/salesforce/describe.ts), which caches per `${client.instanceUrl}:${sobject}`. Each mock client here
 * gets its own distinct `instanceUrl` so two tests' mocks never collide on the same cache key (a shared,
 * undefined `instanceUrl` across mocks would let one test's successful Describe leak into another test
 * whose org genuinely doesn't have that object). */
function buildClient(opts: {
  describeByObject: Record<string, DescribeResult | null>;
  queryByObject: Record<string, Record<string, unknown>[]>;
}): SalesforceClient {
  return {
    instanceUrl: `https://mock-org-${mockClientCounter++}.example.com`,
    async describeObject(sobject: string) {
      const d = opts.describeByObject[sobject];
      if (!d) throw new Error(`${sobject} does not exist on this org`);
      return d;
    },
    async query<T>(soql: string) {
      for (const [obj, rows] of Object.entries(opts.queryByObject)) {
        if (soql.includes(`FROM ${obj}`)) return { totalSize: rows.length, done: true, records: rows as T[] };
      }
      return { totalSize: 0, done: true, records: [] as T[] };
    },
    logDebug() { /* no-op */ },
  } as unknown as SalesforceClient;
}

test("discoverBundleStructure resolves components via ProductRelatedComponent when it's the first object that has rows", async () => {
  const client = buildClient({
    describeByObject: {
      ProductRelatedComponent: describeWithFields([
        { name: "ParentProductId", type: "reference", referenceTo: ["Product2"], label: "Parent Product" },
        { name: "ChildProductId", type: "reference", referenceTo: ["Product2"], label: "Child Product" },
        { name: "Sequence", type: "double" }, { name: "IsDefaultComponent", type: "boolean" }, { name: "IsComponentRequired", type: "boolean" },
      ]),
    },
    queryByObject: {
      ProductRelatedComponent: [{ Id: "a01000000000001AAA", ChildProductId: "01t000000000002AAA", Sequence: 1, IsDefaultComponent: true, IsComponentRequired: true }],
      Product2: [{ Id: "01t000000000002AAA", Name: "Laptop", ProductCode: "LAPTOP-1" }],
    },
  });

  const result = await discoverBundleStructure(client, BUNDLE);

  assert.ok(result.bundle, "a bundle with a real component row must resolve");
  assert.equal(result.bundle!.relationshipSource, "ProductRelatedComponent");
  assert.equal(result.bundle!.components.length, 1);
  assert.equal(result.bundle!.components[0].productName, "Laptop");
});

test("discoverBundleStructure falls back to a second relationship object when the first doesn't exist on this org", async () => {
  const client = buildClient({
    describeByObject: {
      // ProductRelatedComponent absent entirely (describeObject throws) — falls through to ProductRelationship.
      ProductRelationship: describeWithFields([
        { name: "ParentProductId", type: "reference", referenceTo: ["Product2"], label: "Parent Product" },
        { name: "ChildProductId", type: "reference", referenceTo: ["Product2"], label: "Child Product" },
      ]),
    },
    queryByObject: {
      ProductRelationship: [{ Id: "a02000000000001AAA", ChildProductId: "01t000000000003AAA" }],
      Product2: [{ Id: "01t000000000003AAA", Name: "Wireless Mouse", ProductCode: "MOUSE-1" }],
    },
  });

  const result = await discoverBundleStructure(client, BUNDLE);

  assert.ok(result.bundle, "must fall back to the next candidate relationship object");
  assert.equal(result.bundle!.relationshipSource, "ProductRelationship");
  assert.ok(result.attempts.some(a => a.objectName === "ProductRelatedComponent" && !a.fieldsResolved), "must record that the first candidate was checked and found unusable");
});

test("discoverBundleStructure reports zero components (never invents one) when no relationship object has any row for this bundle", async () => {
  const client = buildClient({
    describeByObject: {
      ProductRelatedComponent: describeWithFields([
        { name: "ParentProductId", type: "reference", referenceTo: ["Product2"] },
        { name: "ChildProductId", type: "reference", referenceTo: ["Product2"] },
      ]),
    },
    queryByObject: {}, // no rows anywhere
  });

  const result = await discoverBundleStructure(client, BUNDLE);

  assert.equal(result.bundle, null, "a bundle with zero discoverable components must resolve to null, never a fabricated component");
  assert.ok(result.attempts.length > 0, "every checked candidate object must be reported for diagnostics");
});
