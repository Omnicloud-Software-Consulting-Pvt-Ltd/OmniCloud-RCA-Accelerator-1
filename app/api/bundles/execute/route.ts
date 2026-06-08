import { NextRequest } from "next/server";
import { SalesforceClient, SESSION_COOKIE, decodeSession, clientFromSession } from "@/lib/salesforce/client";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */

interface AttributeDefinition {
  name: string;
  type: "Picklist" | "Text" | "Number" | "Boolean";
  values?: string[];
  required?: boolean;
}

interface ParsedProduct {
  name: string;
  price: number;
  isDependency: boolean;
  dependencyOf?: string | null;
  sellingModel?: string;
  category?: string;
  attributes?: AttributeDefinition[];
}

interface ParsedBundle {
  bundleName: string;
  description?: string;
  category?: string;
  catalog?: string;
  sellingModel?: string;
  bundleType?: string;
  products: ParsedProduct[];
  nestedBundles?: ParsedBundle[];
  dependencies?: { source: string; target: string; targetPrice: number; type?: string }[];
  attributes?: AttributeDefinition[];
  totalPrice: number;
}

interface DepRule {
  id: string;
  type: "AUTO_ADD" | "DEPENDS_ON" | "REQUIRES" | "EXCLUDES";
  source: string;
  target: string;
  active: boolean;
  validationStatus: string;
}

interface HierarchyState {
  leafProductIds:         Record<string, string>;
  bundleIds:              Record<string, string>;
  depProductIds:          Record<string, string>;
  productSellingModelIds: Record<string, string>;
  pricebookId:            string;
}

interface DepProductEntry extends ParsedProduct {
  ownerBundleName: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Hierarchy helpers
 * ─────────────────────────────────────────────────────────────────────────── */

interface BundleEntry { bundle: ParsedBundle; parentName: string | null; depth: number; }
interface LeafEntry   { product: ParsedProduct; ownerBundleName: string; }

function flattenHierarchy(root: ParsedBundle): { bundles: BundleEntry[]; leaves: LeafEntry[] } {
  const bundles: BundleEntry[] = [];
  const leaves:  LeafEntry[]   = [];
  const seen = new Set<string>();

  function walk(b: ParsedBundle, parent: string | null, depth: number) {
    bundles.push({ bundle: b, parentName: parent, depth });
    for (const p of b.products ?? []) {
      const key = p.name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); leaves.push({ product: p, ownerBundleName: b.bundleName }); }
    }
    for (const child of b.nestedBundles ?? []) walk(child, b.bundleName, depth + 1);
  }
  walk(root, null, 0);
  return { bundles, leaves };
}

function buildMap<T>(root: ParsedBundle, getBundleVal: (b: ParsedBundle) => T, getProductVal: (p: ParsedProduct, b: ParsedBundle) => T): Record<string, T> {
  const map: Record<string, T> = {};
  function walk(b: ParsedBundle) {
    map[b.bundleName] = getBundleVal(b);
    for (const p of b.products ?? []) map[p.name] = getProductVal(p, b);
    for (const child of b.nestedBundles ?? []) walk(child);
  }
  walk(root);
  return map;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Utilities
 * ─────────────────────────────────────────────────────────────────────────── */

function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function generateCode(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function sseEvent(ctrl: ReadableStreamDefaultController, enc: TextEncoder, data: object) {
  ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Selling model intelligent matcher
 * ─────────────────────────────────────────────────────────────────────────── */

function matchSellingModel(desired: string | undefined, models: { Id: string; Name: string }[]): { Id: string; Name: string } | null {
  if (models.length === 0) return null;
  const d = (desired ?? "").trim().toLowerCase();
  if (!d) return models.find(m => /one.?time/i.test(m.Name)) ?? models[0];

  const exact = models.find(m => m.Name.toLowerCase() === d);
  if (exact) return exact;

  const contains = models.find(m => m.Name.toLowerCase().includes(d) || d.includes(m.Name.toLowerCase()));
  if (contains) return contains;

  const patterns: [RegExp, RegExp][] = [
    [/one.?time|perpetual|purchase|upfront/i,             /one.?time|perpetual/i],
    [/evergreen.*month|monthly.*recurring|monthly.*sub/i,  /evergreen.*month/i],
    [/evergreen.*quarter|quarterly.*sub/i,                 /evergreen.*quarter/i],
    [/evergreen.*year|annual.*evergreen|yearly.*sub/i,     /evergreen.*year/i],
    [/term.*month|monthly.*contract/i,                     /term.*month/i],
    [/term.*quarter|quarterly.*contract/i,                 /term.*quarter/i],
    [/term.*year|annual.*contract|yearly.*contract/i,      /term.*year/i],
    [/term.*defined|subscription/i,                        /term/i],
  ];
  for (const [inp, mod] of patterns) {
    if (inp.test(d)) {
      const sm = models.find(m => mod.test(m.Name));
      if (sm) return sm;
    }
  }
  return models.find(m => /one.?time/i.test(m.Name)) ?? models[0];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Product helpers — CORRECT RCA types:
 *   Leaf product  → Type omitted (null/empty) — NEVER Base/Component/Set
 *   Bundle        → Type = "Bundle"
 * ─────────────────────────────────────────────────────────────────────────── */

async function resolveLeafProduct(
  client: SalesforceClient, name: string,
  extraFields: Record<string, unknown>,
  onLog: (level: string, msg: string) => void,
): Promise<{ id: string; action: "created" | "reused" } | null> {
  try {
    // Leaf products must NOT have Type=Base/Set/Component — look for compatible existing records
    const res = await client.query<{ Id: string; Type: string | null }>(
      `SELECT Id, Type FROM Product2 WHERE Name = '${soqlEscape(name)}' ORDER BY CreatedDate DESC LIMIT 10`,
    );
    if (res.records.length > 0) {
      const INCOMPATIBLE = new Set(["Base", "Set", "Component"]);
      const compatible = res.records.find(r => !r.Type || !INCOMPATIBLE.has(r.Type));
      if (compatible) {
        onLog("warning", `⚠ Reused: ${name} → ${compatible.Id}`);
        return { id: compatible.Id, action: "reused" };
      }
      onLog("warning", `All existing '${name}' records have incompatible Type — creating new compatible record`);
    }
  } catch { /* fall through */ }

  const result = await client.createRecord("Product2", {
    Name: name,
    ProductCode: generateCode(name),
    IsActive: true,
    ...extraFields,
    // No Type field set — leaf products have null/empty Type in RCA
  });

  if (result.success) {
    onLog("success", `✓ Created: ${name} → ${result.id}`);
    return { id: result.id, action: "created" };
  }
  onLog("error", `✗ Failed: ${name}: ${JSON.stringify(result.errors)}`);
  return null;
}

async function resolveBundleProduct(
  client: SalesforceClient, name: string,
  extraFields: Record<string, unknown>,
  onLog: (level: string, msg: string) => void,
): Promise<{ id: string; action: "created" | "reused" | "updated" } | null> {
  try {
    const res = await client.query<{ Id: string; Type: string | null }>(
      `SELECT Id, Type FROM Product2 WHERE Name = '${soqlEscape(name)}' LIMIT 1`,
    );
    if (res.records.length > 0) {
      const rec = res.records[0];
      if (rec.Type === "Bundle") {
        onLog("warning", `⚠ Reused bundle: ${name} → ${rec.Id}`);
        return { id: rec.Id, action: "reused" };
      }
      try {
        await client.updateRecord("Product2", rec.Id, { Type: "Bundle" });
        onLog("warning", `⚠ Updated to Type=Bundle: ${name} → ${rec.Id}`);
        return { id: rec.Id, action: "updated" };
      } catch {
        onLog("warning", `Could not update Type on '${name}' — using as-is`);
        return { id: rec.Id, action: "reused" };
      }
    }
  } catch { /* fall through */ }

  const result = await client.createRecord("Product2", {
    Name: name,
    ProductCode: generateCode(name),
    IsActive: true,
    Type: "Bundle",
    ...extraFields,
  });

  if (result.success) {
    onLog("success", `✓ Created bundle: ${name} → ${result.id}`);
    return { id: result.id, action: "created" };
  }
  onLog("error", `✗ Failed bundle: ${name}: ${JSON.stringify(result.errors)}`);
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Relationship helper — ProductRelatedComponent
 * ─────────────────────────────────────────────────────────────────────────── */

async function createRelationship(
  client: SalesforceClient,
  parentId: string, childId: string,
  parentName: string, childName: string,
  seq: number, batchNum: number,
  relationshipTypeId: string | null,
  send: (data: object) => void,
): Promise<boolean> {
  try {
    const existing = await client.query<{ Id: string }>(
      `SELECT Id FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(parentId)}' AND ChildProductId = '${soqlEscape(childId)}' LIMIT 1`,
    ).catch(() => ({ records: [] as { Id: string }[] }));

    if (existing.records.length > 0) {
      send({ type: "log", batch: batchNum, level: "warning", message: `⚠ Relationship exists: ${parentName} → ${childName}` });
      return true;
    }

    const fields: Record<string, unknown> = {
      ParentProductId: parentId,
      ChildProductId:  childId,
      Sequence:         seq,
      IsDefaultComponent: true,
      IsComponentRequired: true,
    };
    if (relationshipTypeId) fields.ProductRelationshipTypeId = relationshipTypeId;

    const result = await client.createRecord("ProductRelatedComponent", fields);
    if (result.success) {
      send({ type: "record_created", batch: batchNum, sobject: "ProductRelatedComponent", id: result.id, name: `${parentName} → ${childName}` });
      send({ type: "log", batch: batchNum, level: "success", message: `✓ ${parentName} → ${childName} (${result.id})` });
      return true;
    }
    send({ type: "log", batch: batchNum, level: "error", message: `Relationship failed: ${parentName} → ${childName}: ${JSON.stringify(result.errors)}` });
    return false;
  } catch (err) {
    send({ type: "log", batch: batchNum, level: "error", message: `Relationship error: ${parentName} → ${childName}: ${(err as Error).message}` });
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Attribute helper — ProductAttributeDefinition
 * Valid attributes: anything except Price, PricebookEntry, Category, Catalog, SKU-like fields
 * ─────────────────────────────────────────────────────────────────────────── */

const SKIP_ATTR_NAMES = /price|pricebook|catalog|category|sku|product_?code|upc|ean/i;

async function createAttribute(
  client: SalesforceClient,
  productId: string,
  attr: AttributeDefinition,
  batchNum: number,
  send: (data: object) => void,
): Promise<boolean> {
  if (SKIP_ATTR_NAMES.test(attr.name)) {
    send({ type: "log", batch: batchNum, level: "warning", message: `Skipping reserved attribute: ${attr.name}` });
    return false;
  }

  try {
    // Check if ProductAttributeDefinition is accessible
    const existing = await client.query<{ Id: string }>(
      `SELECT Id FROM ProductAttribute WHERE ProductId = '${soqlEscape(productId)}' AND Name = '${soqlEscape(attr.name)}' LIMIT 1`,
    ).catch(() => ({ records: [] as { Id: string }[] }));

    if (existing.records.length > 0) {
      send({ type: "log", batch: batchNum, level: "warning", message: `⚠ Attribute exists: ${attr.name}` });
      return true;
    }

    const result = await client.createRecord("ProductAttribute", {
      Name: attr.name,
      ProductId: productId,
      IsRequired: attr.required ?? false,
    });

    if (result.success) {
      send({ type: "record_created", batch: batchNum, sobject: "ProductAttribute", id: result.id, name: attr.name });
      send({ type: "log", batch: batchNum, level: "success", message: `✓ Attribute: ${attr.name} → ${result.id}` });
      return true;
    }
    send({ type: "log", batch: batchNum, level: "warning", message: `Attribute not supported: ${attr.name}: ${JSON.stringify(result.errors)}` });
  } catch {
    send({ type: "log", batch: batchNum, level: "warning", message: `ProductAttribute not accessible in org — skipping attributes` });
  }
  return false;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Route
 * ─────────────────────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const cookie  = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "Not authenticated" })}\n\n`,
      { status: 401, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  let bundle: ParsedBundle;
  let depRules: DepRule[] = [];
  try {
    const body = await req.json();
    bundle = body.bundle;
    if (!bundle?.bundleName) throw new Error("bundle.bundleName is required");
    if (Array.isArray(body.depRules)) depRules = body.depRules;
  } catch (err) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`,
      { status: 400, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const sfClient = clientFromSession(session, { apiVersion: "v62.0" });
  const encoder  = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => sseEvent(controller, encoder, data);

      /* ── Pre-flight: flatten hierarchy ── */
      const { bundles: allBundleEntries, leaves: allLeaves } = flattenHierarchy(bundle);
      const childBundleEntries = allBundleEntries.filter(e => e.depth > 0);

      const priceMap        = buildMap(bundle, b => b.totalPrice, (p) => p.price);
      const sellingModelMap = buildMap(bundle, b => b.sellingModel, (p, b) => p.sellingModel ?? b.sellingModel);
      const categoryMap     = buildMap(bundle, b => b.category, (p, b) => p.category ?? b.category);
      const attributeMap    = buildMap(bundle, b => b.attributes ?? [], (p) => p.attributes ?? []);

      const ownerMap: Record<string, string> = {};
      for (const { product, ownerBundleName } of allLeaves) {
        ownerMap[product.name.toLowerCase()] = ownerBundleName;
      }

      const hs: HierarchyState = {
        leafProductIds: {}, bundleIds: {}, depProductIds: {},
        productSellingModelIds: {}, pricebookId: "",
      };

      /* ── Collect dependency products to create ── */
      const activeDepRules = depRules.filter(r => r.active && r.type !== "EXCLUDES");
      const aiDeps: Array<{ source: string; target: string; targetPrice: number }> = [];
      const collectDeps = (b: ParsedBundle) => {
        for (const d of b.dependencies ?? []) aiDeps.push(d);
        for (const child of b.nestedBundles ?? []) collectDeps(child);
      };
      collectDeps(bundle);
      for (const d of aiDeps) { if (d.targetPrice) priceMap[d.target] = d.targetPrice; }

      const depProductsToCreate: DepProductEntry[] = [];
      const seenDepTargets = new Set<string>();
      const maybeAddDep = (name: string, price: number, source: string, owner: string) => {
        const key = name.toLowerCase();
        if (allLeaves.some(l => l.product.name.toLowerCase() === key)) return;
        if (seenDepTargets.has(key)) return;
        seenDepTargets.add(key);
        depProductsToCreate.push({
          name, price, isDependency: true, dependencyOf: source,
          sellingModel: sellingModelMap[name] ?? bundle.sellingModel,
          category: categoryMap[name] ?? bundle.category,
          ownerBundleName: owner,
        });
      };
      for (const rule of activeDepRules) {
        maybeAddDep(rule.target, 0, rule.source, ownerMap[rule.source.toLowerCase()] ?? bundle.bundleName);
      }
      for (const d of aiDeps) {
        maybeAddDep(d.target, d.targetPrice ?? 0, d.source, ownerMap[d.source.toLowerCase()] ?? bundle.bundleName);
      }

      send({ type: "log", batch: 1, level: "info",
        message: `Hierarchy: ${allBundleEntries.length} bundle(s) · ${allLeaves.length} leaf product(s) · ${depProductsToCreate.length} dep product(s)` });

      try {
        /* ══════════════════════════════════════════════════════
         * BATCH 1 — Create Products (leaf products, Type=null)
         * ══════════════════════════════════════════════════════ */
        const b1Start = Date.now();
        send({ type: "batch_start", batch: 1, name: "Create Products", total: allLeaves.length });

        for (const { product, ownerBundleName } of allLeaves) {
          send({ type: "log", batch: 1, level: "info", message: `› ${product.name} [owner: ${ownerBundleName}]${product.sellingModel ? ` · ${product.sellingModel}` : ""}` });
          const resolved = await resolveLeafProduct(
            sfClient, product.name,
            { Description: product.name, Family: product.category || bundle.category || "Products" },
            (level, msg) => send({ type: "log", batch: 1, level, message: msg }),
          );
          if (resolved) {
            hs.leafProductIds[product.name] = resolved.id;
            send({ type: "record_created", batch: 1, sobject: "Product2", id: resolved.id, name: product.name, action: resolved.action });
          }
        }

        send({ type: "batch_complete", batch: 1, name: "Create Products", count: Object.keys(hs.leafProductIds).length, duration: Date.now() - b1Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 2 — Create Bundles (Type=Bundle for all bundles)
         * ══════════════════════════════════════════════════════ */
        const b2Start = Date.now();
        const totalBundlesToCreate = childBundleEntries.length + 1; // children + root
        send({ type: "batch_start", batch: 2, name: "Create Bundles", total: totalBundlesToCreate });

        // Child bundles first (bottom-up)
        for (const { bundle: childBundle, depth } of childBundleEntries) {
          send({ type: "log", batch: 2, level: "info", message: `› [depth ${depth}] ${childBundle.bundleName} (Type=Bundle)` });
          const resolved = await resolveBundleProduct(
            sfClient, childBundle.bundleName,
            { Description: childBundle.description || childBundle.bundleName, Family: "Bundles" },
            (level, msg) => send({ type: "log", batch: 2, level, message: msg }),
          );
          if (resolved) {
            hs.bundleIds[childBundle.bundleName] = resolved.id;
            send({ type: "record_created", batch: 2, sobject: "Product2", id: resolved.id, name: childBundle.bundleName, action: resolved.action });
          }
        }

        // Root bundle
        send({ type: "log", batch: 2, level: "info", message: `› ROOT ${bundle.bundleName} (Type=Bundle)` });
        const resolvedRoot = await resolveBundleProduct(
          sfClient, bundle.bundleName,
          { Description: bundle.description || bundle.bundleName, Family: "Bundles" },
          (level, msg) => send({ type: "log", batch: 2, level, message: msg }),
        );
        if (!resolvedRoot) {
          send({ type: "batch_error", batch: 2, name: "Create Bundles", error: "Root bundle creation failed" });
          send({ type: "error", message: "Root bundle creation failed — aborting" });
          controller.close();
          return;
        }
        hs.bundleIds[bundle.bundleName] = resolvedRoot.id;
        send({ type: "record_created", batch: 2, sobject: "Product2", id: resolvedRoot.id, name: bundle.bundleName, action: resolvedRoot.action });
        send({ type: "batch_complete", batch: 2, name: "Create Bundles", count: Object.keys(hs.bundleIds).length, duration: Date.now() - b2Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 3 — Create Relationships (ProductRelatedComponent)
         * ══════════════════════════════════════════════════════ */
        const b3Start = Date.now();
        let totalRels = 0;
        for (const { bundle: b } of allBundleEntries) {
          totalRels += (b.products?.length ?? 0) + (b.nestedBundles?.length ?? 0);
        }
        send({ type: "batch_start", batch: 3, name: "Create Relationships", total: totalRels });

        // Resolve relationship type
        let relationshipTypeId: string | null = null;
        try {
          const rtRes = await sfClient.query<{ Id: string; Name: string }>(
            "SELECT Id, Name FROM ProductRelationshipType WHERE Name = 'Bundle to Bundle Component Relationship' LIMIT 1",
          );
          if (rtRes.records.length > 0) {
            relationshipTypeId = rtRes.records[0].Id;
            send({ type: "log", batch: 3, level: "info", message: `Relationship type: ${rtRes.records[0].Name}` });
          } else {
            const fallback = await sfClient.query<{ Id: string; Name: string }>("SELECT Id, Name FROM ProductRelationshipType LIMIT 1");
            if (fallback.records.length > 0) {
              relationshipTypeId = fallback.records[0].Id;
              send({ type: "log", batch: 3, level: "warning", message: `Using fallback relationship type: ${fallback.records[0].Name}` });
            }
          }
        } catch {
          send({ type: "log", batch: 3, level: "warning", message: "ProductRelationshipType not found — creating without type" });
        }

        let relCount = 0, seq = 1;
        for (const { bundle: b } of allBundleEntries) {
          const parentId = hs.bundleIds[b.bundleName];
          if (!parentId) { send({ type: "log", batch: 3, level: "warning", message: `No Id for bundle ${b.bundleName}` }); continue; }

          for (const product of b.products ?? []) {
            const childId = hs.leafProductIds[product.name];
            if (!childId) { send({ type: "log", batch: 3, level: "warning", message: `No Id for product ${product.name}` }); continue; }
            if (await createRelationship(sfClient, parentId, childId, b.bundleName, product.name, seq++, 3, relationshipTypeId, send)) relCount++;
          }

          for (const child of b.nestedBundles ?? []) {
            const childId = hs.bundleIds[child.bundleName];
            if (!childId) { send({ type: "log", batch: 3, level: "warning", message: `No Id for child bundle ${child.bundleName}` }); continue; }
            if (await createRelationship(sfClient, parentId, childId, b.bundleName, child.bundleName, seq++, 3, relationshipTypeId, send)) relCount++;
          }
        }
        send({ type: "batch_complete", batch: 3, name: "Create Relationships", count: relCount, duration: Date.now() - b3Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 4 — Create Dependencies (dep products + relationships)
         * ══════════════════════════════════════════════════════ */
        const b4Start = Date.now();
        send({ type: "batch_start", batch: 4, name: "Create Dependencies", total: depProductsToCreate.length });

        if (depProductsToCreate.length === 0) {
          send({ type: "log", batch: 4, level: "info", message: "No dependency products to create" });
        } else {
          send({ type: "log", batch: 4, level: "info", message: `Processing ${depProductsToCreate.length} dependency product(s)` });
          for (const dep of depProductsToCreate) {
            send({ type: "log", batch: 4, level: "info", message: `[DEP] "${dep.name}" (dep of "${dep.dependencyOf}")` });
            const resolved = await resolveLeafProduct(
              sfClient, dep.name,
              { Description: `Dependency of ${dep.dependencyOf}`, Family: dep.category || bundle.category || "Products" },
              (level, msg) => send({ type: "log", batch: 4, level, message: msg }),
            );
            if (resolved) {
              hs.depProductIds[dep.name] = resolved.id;
              send({ type: "log", batch: 4, level: "success", message: `[DEP CREATED] "${dep.name}" → ${resolved.id}` });

              // Link dependency to its owner bundle
              const ownerBundleId = hs.bundleIds[dep.ownerBundleName] ?? hs.bundleIds[bundle.bundleName];
              if (ownerBundleId) {
                await createRelationship(sfClient, ownerBundleId, resolved.id, dep.ownerBundleName, dep.name, seq++, 4, relationshipTypeId, send);
              }
            }
          }
        }
        send({ type: "batch_complete", batch: 4, name: "Create Dependencies", count: Object.keys(hs.depProductIds).length, duration: Date.now() - b4Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 5 — Create Attributes (ProductAttribute)
         * Only valid attributes — skip price/category/catalog/SKU
         * ══════════════════════════════════════════════════════ */
        const b5Start = Date.now();
        const allProductIds: Record<string, string> = {
          ...hs.leafProductIds, ...hs.bundleIds, ...hs.depProductIds,
        };

        let attrTotal = 0;
        for (const [name] of Object.entries(allProductIds)) {
          const attrs = attributeMap[name] ?? [];
          attrTotal += attrs.filter(a => !SKIP_ATTR_NAMES.test(a.name)).length;
        }
        send({ type: "batch_start", batch: 5, name: "Create Attributes", total: attrTotal });

        let attrCount = 0;
        if (attrTotal === 0) {
          send({ type: "log", batch: 5, level: "info", message: "No attributes detected for this bundle" });
        } else {
          for (const [name, id] of Object.entries(allProductIds)) {
            const attrs = (attributeMap[name] ?? []).filter(a => !SKIP_ATTR_NAMES.test(a.name));
            if (attrs.length === 0) continue;
            send({ type: "log", batch: 5, level: "info", message: `› "${name}" — ${attrs.length} attribute(s)` });
            for (const attr of attrs) {
              if (await createAttribute(sfClient, id, attr, 5, send)) attrCount++;
            }
          }
        }
        send({ type: "batch_complete", batch: 5, name: "Create Attributes", count: attrCount, duration: Date.now() - b5Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 6 — Commercialization (Catalog → Category → ProductCategoryProduct)
         * ══════════════════════════════════════════════════════ */
        const b6Start = Date.now();
        const allProductEntries = Object.entries(allProductIds);
        send({ type: "batch_start", batch: 6, name: "Commercialization", total: allProductEntries.length });

        try {
          const desiredCatalogName = bundle.catalog || "Enterprise Catalog";
          let resolvedCatalog: { id: string; name: string; action: "reused" | "reused_fallback" | "created" } | null = null;

          // Tier 1: exact match
          try {
            const res = await sfClient.query<{ Id: string; Name: string }>(
              `SELECT Id, Name FROM ProductCatalog WHERE Name = '${soqlEscape(desiredCatalogName)}' LIMIT 1`,
            );
            if (res.records.length > 0) resolvedCatalog = { id: res.records[0].Id, name: res.records[0].Name, action: "reused" };
          } catch { /* */ }

          // Tier 2: any existing
          if (!resolvedCatalog) {
            try {
              const res = await sfClient.query<{ Id: string; Name: string }>("SELECT Id, Name FROM ProductCatalog ORDER BY CreatedDate DESC LIMIT 1");
              if (res.records.length > 0) {
                resolvedCatalog = { id: res.records[0].Id, name: res.records[0].Name, action: "reused_fallback" };
                send({ type: "log", batch: 6, level: "warning", message: `Catalog "${desiredCatalogName}" not found — using: "${resolvedCatalog.name}"` });
              }
            } catch { /* */ }
          }

          // Tier 3: create
          if (!resolvedCatalog) {
            try {
              const createRes = await sfClient.createRecord("ProductCatalog", { Name: desiredCatalogName });
              if (createRes.success) {
                resolvedCatalog = { id: createRes.id, name: desiredCatalogName, action: "created" };
                send({ type: "log", batch: 6, level: "success", message: `✓ Created catalog: "${desiredCatalogName}" → ${createRes.id}` });
              }
            } catch { /* */ }
          }

          let catMappingCount = 0;

          if (!resolvedCatalog) {
            send({ type: "log", batch: 6, level: "error", message: "No ProductCatalog available — skipping commercialization" });
          } else {
            send({ type: "log", batch: 6, level: "info", message: `Catalog: "${resolvedCatalog.name}" (${resolvedCatalog.id})` });

            type CatEntry = { id: string; name: string; action: "reused" | "created" };
            const catCache: Record<string, CatEntry> = {};

            const resolveCategory = async (catName: string): Promise<CatEntry | null> => {
              if (catCache[catName]) return catCache[catName];
              try {
                const res = await sfClient.query<{ Id: string; Name: string }>(
                  `SELECT Id, Name FROM ProductCategory WHERE Name = '${soqlEscape(catName)}' AND CatalogId = '${soqlEscape(resolvedCatalog!.id)}' LIMIT 1`,
                );
                if (res.records.length > 0) {
                  const entry: CatEntry = { id: res.records[0].Id, name: res.records[0].Name, action: "reused" };
                  catCache[catName] = entry;
                  return entry;
                }
              } catch { /* */ }
              try {
                const createRes = await sfClient.createRecord("ProductCategory", { Name: catName, CatalogId: resolvedCatalog!.id });
                if (createRes.success) {
                  const entry: CatEntry = { id: createRes.id, name: catName, action: "created" };
                  catCache[catName] = entry;
                  send({ type: "log", batch: 6, level: "success", message: `✓ Created category: "${catName}" → ${createRes.id}` });
                  return entry;
                }
              } catch { /* */ }
              return null;
            };

            for (const [name, id] of allProductEntries) {
              const category = categoryMap[name] ?? bundle.category ?? "Products";
              send({ type: "log", batch: 6, level: "info", message: `› "${name}" → catalog: "${resolvedCatalog.name}" · category: "${category}"` });

              const catEntry = await resolveCategory(category);
              if (!catEntry) {
                send({ type: "log", batch: 6, level: "error", message: `Cannot resolve category "${category}" for "${name}"` });
                continue;
              }

              const existing = await sfClient.query<{ Id: string }>(
                `SELECT Id FROM ProductCategoryProduct WHERE ProductCategoryId = '${soqlEscape(catEntry.id)}' AND ProductId = '${soqlEscape(id)}' LIMIT 1`,
              ).catch(() => ({ records: [] as { Id: string }[] }));

              if (existing.records.length > 0) {
                catMappingCount++;
                send({ type: "commercialization_update", product: name, catalog: resolvedCatalog.name, catalogAction: resolvedCatalog.action, category: catEntry.name, categoryAction: "reused" });
                continue;
              }

              const mapResult = await sfClient.createRecord("ProductCategoryProduct", { ProductCategoryId: catEntry.id, ProductId: id });
              if (mapResult.success) {
                catMappingCount++;
                send({ type: "record_created", batch: 6, sobject: "ProductCategoryProduct", id: mapResult.id, name: `${name} → ${category}` });
                send({ type: "commercialization_update", product: name, catalog: resolvedCatalog.name, catalogAction: resolvedCatalog.action, category: catEntry.name, categoryAction: catEntry.action });
              } else {
                send({ type: "log", batch: 6, level: "error", message: `Mapping failed for "${name}": ${JSON.stringify(mapResult.errors)}` });
              }
            }
          }
          send({ type: "batch_complete", batch: 6, name: "Commercialization", count: catMappingCount, duration: Date.now() - b6Start });
        } catch (err) {
          send({ type: "log", batch: 6, level: "error", message: `Commercialization batch error: ${(err as Error).message}` });
          send({ type: "batch_complete", batch: 6, name: "Commercialization", count: 0, duration: Date.now() - b6Start });
        }

        /* ══════════════════════════════════════════════════════
         * BATCH 7 — Selling Models (ProductSellingModelOption)
         * Dynamic — never hardcodes "One Time"
         * ══════════════════════════════════════════════════════ */
        const b7Start = Date.now();
        send({ type: "batch_start", batch: 7, name: "Selling Models", total: allProductEntries.length });

        let allSellingModels: { Id: string; Name: string }[] = [];
        try {
          const smRes = await sfClient.query<{ Id: string; Name: string }>("SELECT Id, Name FROM ProductSellingModel ORDER BY Name LIMIT 50");
          allSellingModels = smRes.records;
          send({ type: "log", batch: 7, level: "info", message: `Org selling models (${allSellingModels.length}): ${allSellingModels.map(m => m.Name).join(" · ")}` });
        } catch {
          send({ type: "log", batch: 7, level: "warning", message: "Could not load ProductSellingModel — skipping" });
        }

        let psmCount = 0;
        if (allSellingModels.length === 0) {
          send({ type: "log", batch: 7, level: "error", message: "No ProductSellingModel records in org" });
        } else {
          for (const [name, id] of allProductEntries) {
            const desired = sellingModelMap[name] ?? bundle.sellingModel;
            const matched = matchSellingModel(desired, allSellingModels);
            if (!matched) continue;

            send({ type: "log", batch: 7, level: "info", message: `› "${name}" — desired: "${desired}" → matched: "${matched.Name}"` });

            const existing = await sfClient.query<{ Id: string }>(
              `SELECT Id FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(id)}' AND ProductSellingModelId = '${soqlEscape(matched.Id)}' LIMIT 1`,
            ).catch(() => ({ records: [] as { Id: string }[] }));

            if (existing.records.length > 0) {
              psmCount++;
              hs.productSellingModelIds[name] = matched.Id;
              send({ type: "commercialization_update", product: name, sellingModel: matched.Name, sellingModelAction: "reused" });
              continue;
            }

            const result = await sfClient.createRecord("ProductSellingModelOption", { Product2Id: id, ProductSellingModelId: matched.Id });
            if (result.success) {
              psmCount++;
              hs.productSellingModelIds[name] = matched.Id;
              send({ type: "record_created", batch: 7, sobject: "ProductSellingModelOption", id: result.id, name });
              send({ type: "commercialization_update", product: name, sellingModel: matched.Name, sellingModelAction: "created" });
            } else {
              send({ type: "log", batch: 7, level: "error", message: `PSMO failed for "${name}": ${JSON.stringify(result.errors)}` });
            }
          }
        }
        send({ type: "batch_complete", batch: 7, name: "Selling Models", count: psmCount, duration: Date.now() - b7Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 8 — Pricebook Entries
         * ══════════════════════════════════════════════════════ */
        const b8Start = Date.now();
        send({ type: "batch_start", batch: 8, name: "Pricebook Entries", total: allProductEntries.length });

        let pbeCount = 0;
        try {
          const pbRes = await sfClient.query<{ Id: string }>("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
          if (pbRes.records.length === 0) {
            send({ type: "log", batch: 8, level: "warning", message: "Standard pricebook not found — skipping" });
          } else {
            hs.pricebookId = pbRes.records[0].Id;
            send({ type: "log", batch: 8, level: "info", message: `Standard pricebook: ${hs.pricebookId}` });

            for (const [name, id] of allProductEntries) {
              const unitPrice = priceMap[name] ?? 0;
              const existing = await sfClient.query<{ Id: string }>(
                `SELECT Id FROM PricebookEntry WHERE Product2Id = '${soqlEscape(id)}' AND Pricebook2Id = '${soqlEscape(hs.pricebookId)}' LIMIT 1`,
              ).catch(() => ({ records: [] as { Id: string }[] }));

              if (existing.records.length > 0) {
                pbeCount++;
                send({ type: "log", batch: 8, level: "warning", message: `⚠ PBE exists: ${name} — reused` });
                continue;
              }

              const pbeFields: Record<string, unknown> = {
                Product2Id: id, Pricebook2Id: hs.pricebookId, UnitPrice: unitPrice, IsActive: true,
              };
              const smId = hs.productSellingModelIds[name];
              if (smId) pbeFields.ProductSellingModelId = smId;

              const pbeResult = await sfClient.createRecord("PricebookEntry", pbeFields);
              if (pbeResult.success) {
                pbeCount++;
                send({ type: "record_created", batch: 8, sobject: "PricebookEntry", id: pbeResult.id, name });
                send({ type: "log", batch: 8, level: "success", message: `✓ PBE: ${name} @ $${unitPrice}` });
              } else {
                send({ type: "log", batch: 8, level: "error", message: `PBE failed for ${name}: ${JSON.stringify(pbeResult.errors)}` });
              }
            }
          }
        } catch (err) {
          send({ type: "log", batch: 8, level: "error", message: `Pricebook batch error: ${(err as Error).message}` });
        }
        send({ type: "batch_complete", batch: 8, name: "Pricebook Entries", count: pbeCount, duration: Date.now() - b8Start });

        /* ══════════════════════════════════════════════════════
         * BATCH 9 — Validation + Deployment
         * Verify root bundle exists and is queryable
         * ══════════════════════════════════════════════════════ */
        const b9Start = Date.now();
        send({ type: "batch_start", batch: 9, name: "Validation + Deploy", total: 1 });

        const rootBundleId = hs.bundleIds[bundle.bundleName];
        let validationCount = 0;

        if (!rootBundleId) {
          send({ type: "log", batch: 9, level: "error", message: "Root bundle ID not found in state — validation failed" });
          send({ type: "batch_error", batch: 9, name: "Validation + Deploy", error: "Root bundle ID missing" });
        } else {
          try {
            const verify = await sfClient.query<{ Id: string; Name: string; Type: string }>(
              `SELECT Id, Name, Type FROM Product2 WHERE Id = '${soqlEscape(rootBundleId)}' LIMIT 1`,
            );
            if (verify.records.length > 0) {
              const rec = verify.records[0];
              send({ type: "log", batch: 9, level: "success", message: `✓ Root bundle verified: ${rec.Name} (Type=${rec.Type ?? "null"}) → ${rec.Id}` });
              validationCount++;
            }

            // Verify relationship count
            const relCount = await sfClient.query<{ Id: string }>(
              `SELECT Id FROM ProductRelatedComponent WHERE ParentProductId = '${soqlEscape(rootBundleId)}' LIMIT 100`,
            ).catch(() => ({ records: [] as { Id: string }[] }));
            send({ type: "log", batch: 9, level: "info", message: `Root bundle has ${relCount.records.length} direct component relationship(s)` });

            const totalLeafs = Object.keys(hs.leafProductIds).length;
            const totalDeps  = Object.keys(hs.depProductIds).length;
            const totalBundles = Object.keys(hs.bundleIds).length;

            send({ type: "log", batch: 9, level: "success", message: `Deployment summary: ${totalBundles} bundle(s) · ${totalLeafs} product(s) · ${totalDeps} dep(s)` });
            validationCount++;

            send({ type: "batch_complete", batch: 9, name: "Validation + Deploy", count: validationCount, duration: Date.now() - b9Start });
          } catch (err) {
            send({ type: "log", batch: 9, level: "error", message: `Validation error: ${(err as Error).message}` });
            send({ type: "batch_complete", batch: 9, name: "Validation + Deploy", count: 0, duration: Date.now() - b9Start });
          }
        }

        /* ══════════════════════════════════════════════════════
         * Done
         * ══════════════════════════════════════════════════════ */
        send({
          type: "complete",
          bundleId: rootBundleId,
          bundleIds: hs.bundleIds,
          leafProductIds: hs.leafProductIds,
          totalBundles: Object.keys(hs.bundleIds).length,
          totalProducts: Object.keys(hs.leafProductIds).length + Object.keys(hs.depProductIds).length,
        });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
