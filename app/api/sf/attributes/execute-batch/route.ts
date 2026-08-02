import { NextRequest, NextResponse } from "next/server";
import {
  SalesforceClient,
  SESSION_COOKIE,
  decodeSession,
  clientFromSession,
  type DescribeResult,
  type DescribeField,
} from "@/lib/salesforce/client";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */
interface ParsedAttribute {
  name: string;
  dataType: string;
  configurable: boolean;
  required: boolean;
  active: boolean;
  description: string;
  values: string[];
  defaultValue: string | null;
}

interface ParsedRCAData {
  productName: string;
  productCode: string;
  productFamily: string;
  productType: string;
  description: string;
  isActive: boolean;
  unitOfMeasure: string;
  sellingModel: string;
  classificationName: string;
  categoryName: string;
  attributes: ParsedAttribute[];
}

interface SchemaInfo {
  padDatatypeField:       string | null;
  attrDefDatatypeField:   string | null;
  attrDefPicklistFKField: string | null;
  validDatatypes:         string[];
  product2ValidTypes:     string[];
  padProduct2FKField:     string | null;
  padPCAFKField:          string | null;
  smoProductFKField:      string | null;
  discoveredAt:           string;
}

interface BatchContext {
  productId?:                 string;
  classificationId?:          string;
  catalogId?:                 string;
  categoryId?:                string;
  sellingModelId?:            string;
  attributePicklistIds?:      Record<string, string>;
  attributePicklistValueIds?: Record<string, string[]>;
  attributeDefIds?:           Record<string, string>;
  attributeCategoryId?:       string;
  attributeCatAttrIds?:       Record<string, string>;
  pcaIds?:                    Record<string, string>;
  padIds?:                    Record<string, string>;
  runtimeValueIds?:           Record<string, string>;
  normalizedTypes?:           Record<string, string>;
  schemaInfo?:                SchemaInfo;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Storage health tracking
 * ─────────────────────────────────────────────────────────────────────────── */
interface StorageHealth {
  reuseCount:    number;
  createCount:   number;
  storageErrors: number;
  storageWarning: boolean;
  reusedObjects: Record<string, number>;
  failedObjects: Record<string, number>;
}

function makeHealth(): StorageHealth {
  return { reuseCount: 0, createCount: 0, storageErrors: 0, storageWarning: false, reusedObjects: {}, failedObjects: {} };
}

function trackReuse(h: StorageHealth, sobject: string) {
  h.reuseCount++;
  h.reusedObjects[sobject] = (h.reusedObjects[sobject] ?? 0) + 1;
}

function trackCreate(h: StorageHealth) {
  h.createCount++;
}

function trackStorageError(h: StorageHealth, sobject: string) {
  h.storageErrors++;
  h.storageWarning = true;
  h.failedObjects[sobject] = (h.failedObjects[sobject] ?? 0) + 1;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Datatype normalisation — AI semantic type → valid RCA DataType
 * ─────────────────────────────────────────────────────────────────────────── */
const DATATYPE_ALIASES: Record<string, string> = {
  boolean: "Checkbox", bool: "Checkbox",
  integer: "Number",   int: "Number", float: "Number", decimal: "Number",
  string:  "Text",     str: "Text",
  enum:    "Picklist", select: "Picklist",
  picklist: "Picklist", text: "Text", number: "Number",
  date: "Date", datetime: "DateTime", checkbox: "Checkbox",
  currency: "Currency", percent: "Percent",
};

function normalizeDatatype(aiType: string, validDatatypes: string[]): string {
  const lower  = (aiType ?? "Text").toLowerCase().trim();
  const mapped = DATATYPE_ALIASES[lower] ?? aiType;
  if (!validDatatypes.length) return mapped;
  const exact = validDatatypes.find(v => v === mapped);
  if (exact) return exact;
  const ci = validDatatypes.find(v => v.toLowerCase() === mapped.toLowerCase());
  if (ci) return ci;
  const fuzzy = validDatatypes.find(v => v.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;
  return validDatatypes.find(v => /^text$/i.test(v)) ?? validDatatypes[0] ?? mapped;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Pure utilities
 * ─────────────────────────────────────────────────────────────────────────── */
function soqlEscape(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toDeveloperName(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

function isPicklistAttr(attr: ParsedAttribute): boolean {
  const lower = (attr.dataType ?? "").toLowerCase();
  return lower === "picklist" || lower === "enum" || lower === "select" || attr.values.length > 0;
}

function sellingModelType(sm: string): string {
  if (sm.startsWith("Evergreen")) return "Evergreen";
  if (sm.startsWith("Term"))      return "TermDefined";
  return "OneTime";
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Salesforce describe / create helpers
 * ─────────────────────────────────────────────────────────────────────────── */
async function safeDescribe(client: SalesforceClient, sobject: string): Promise<DescribeResult | null> {
  try { return await client.describeObject(sobject); } catch { return null; }
}

function filterCreatable(payload: Record<string, unknown>, d: DescribeResult | null): Record<string, unknown> {
  if (!d) return payload;
  const ok = new Set(d.fields.filter((f: DescribeField) => f.createable).map((f: DescribeField) => f.name));
  return Object.fromEntries(Object.entries(payload).filter(([k]) => ok.has(k)));
}

function fieldExists(d: DescribeResult | null, name: string): boolean {
  return d?.fields.some((f: DescribeField) => f.name === name) ?? false;
}

function firstExistingField(d: DescribeResult | null, candidates: string[]): string | null {
  if (!d) return null;
  return candidates.find(c => d.fields.some((f: DescribeField) => f.name === c)) ?? null;
}

function picklistValues(d: DescribeResult | null, fieldName: string): string[] {
  const field = d?.fields.find((f: DescribeField) => f.name === fieldName);
  return (field?.picklistValues ?? []).filter(v => v.active).map(v => v.value);
}

function detectDatatypeField(d: DescribeResult | null): string | null {
  if (!d) return null;
  for (const c of ["DataType", "ValueType", "AttributeDataType"]) {
    if (d.fields.some((f: DescribeField) => f.name === c)) return c;
  }
  return d.fields.find((f: DescribeField) => f.createable && /datatype|valuetype/i.test(f.name))?.name ?? null;
}

function buildDebugSummary(sobject: string, d: DescribeResult | null, log: (m: string) => void) {
  if (!d) { log(`  [SCHEMA] ${sobject}: not accessible in this org`); return; }
  const cf = d.fields.filter((f: DescribeField) => f.createable).map((f: DescribeField) => f.name);
  const pl = d.fields
    .filter((f: DescribeField) => f.createable && (f.picklistValues ?? []).length > 0)
    .map((f: DescribeField) => `${f.name}(${(f.picklistValues ?? []).filter(v => v.active).map(v => v.value).join("|")})`);
  log(`  [SCHEMA] ${sobject}: ${cf.length} createable → [${cf.join(", ")}]`);
  if (pl.length) log(`  [SCHEMA] ${sobject} picklists: ${pl.join("  ")}`);
}

async function findOrCreate(
  client: SalesforceClient,
  sobject: string,
  fields: Record<string, unknown>,
  searchOn: string[],
  describe: DescribeResult | null = null,
  log: (m: string) => void = () => {},
): Promise<{ id: string; created: boolean }> {
  // Strategy 1: Combined AND query
  const clauses = searchOn
    .filter(k => fields[k] != null)
    .map(k => `${k} = '${soqlEscape(String(fields[k]))}'`)
    .join(" AND ");
  if (clauses) {
    try {
      const r = await client.query<{ Id: string }>(`SELECT Id FROM ${sobject} WHERE ${clauses} LIMIT 1`);
      if (r.records[0]?.Id) {
        log(`  [REUSE] Existing ${sobject} by [${searchOn.join("+")}] → ${r.records[0].Id}`);
        return { id: r.records[0].Id, created: false };
      }
    } catch { /* try individual fields */ }
  }
  // Strategy 2: Each field individually
  for (const key of searchOn) {
    if (fields[key] == null) continue;
    try {
      const r = await client.query<{ Id: string }>(
        `SELECT Id FROM ${sobject} WHERE ${key} = '${soqlEscape(String(fields[key]))}' LIMIT 1`,
      );
      if (r.records[0]?.Id) {
        log(`  [REUSE] Existing ${sobject} by ${key} → ${r.records[0].Id}`);
        return { id: r.records[0].Id, created: false };
      }
    } catch { /* next */ }
  }
  // Strategy 3: Name fallback
  if (!searchOn.includes("Name") && fields["Name"] != null) {
    try {
      const r = await client.query<{ Id: string }>(
        `SELECT Id FROM ${sobject} WHERE Name = '${soqlEscape(String(fields["Name"]))}' LIMIT 1`,
      );
      if (r.records[0]?.Id) {
        log(`  [REUSE] Existing ${sobject} by Name fallback → ${r.records[0].Id}`);
        return { id: r.records[0].Id, created: false };
      }
    } catch { /* fall through to create */ }
  }
  // Strategy 4: DeveloperName / Code alternative lookup (catches records with same code but different Name)
  for (const extra of ["DeveloperName", "Code"]) {
    if (searchOn.includes(extra)) continue;
    if (fields[extra] == null) continue;
    try {
      const r = await client.query<{ Id: string }>(
        `SELECT Id FROM ${sobject} WHERE ${extra} = '${soqlEscape(String(fields[extra]))}' LIMIT 1`,
      );
      if (r.records[0]?.Id) {
        log(`  [REUSE] Existing ${sobject} by ${extra} → ${r.records[0].Id}`);
        return { id: r.records[0].Id, created: false };
      }
    } catch { /* continue */ }
  }
  const payload = describe ? filterCreatable(fields, describe) : fields;
  const result  = await client.createRecord(sobject, payload);
  if (!result.success) throw new Error(`Failed to create ${sobject}: ${JSON.stringify(result.errors)}`);
  return { id: result.id, created: true };
}

function validateDeps(
  deps: Array<{ label: string; value: unknown }>,
  log: (m: string) => void,
): boolean {
  const missing = deps.filter(d => !d.value);
  missing.forEach(m => log(`  ✗ Missing prerequisite: ${m.label} — run required batch first`));
  return missing.length === 0;
}

function isStorageLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /storage limit|governor limit|limit exceeded|too many soql|entity quota|record count|data limit/i.test(msg);
}

function isPicklistDatatypeCompatible(existingType: string | undefined, targetDT: string): boolean {
  if (!existingType) return true; // no DataType on this org's schema — assume compatible
  const e = existingType.toLowerCase().replace(/[^a-z]/g, "");
  const t = targetDT.toLowerCase().replace(/[^a-z]/g, "");
  if (e === t) return true;
  // Picklist/Enum/Select family and Text containers are equivalent for text enumerations
  // Boolean containers are strictly for boolean-semantic attrs — not for text enumerations
  const picklistFamily = new Set(["picklist", "enum", "select", "multipicklist"]);
  if ((picklistFamily.has(e) || e === "text") && (picklistFamily.has(t) || t === "text")) return true;
  return false;
}

const BOOLEAN_VALUE_PAIRS: Array<[string, string]> = [
  ["true", "false"], ["yes", "no"], ["enabled", "disabled"],
  ["on", "off"], ["active", "inactive"], ["1", "0"],
];

function isBooleanValueSet(values: string[]): boolean {
  if (values.length !== 2) return false;
  const n = values.map(v => v.toLowerCase().trim()).sort();
  return BOOLEAN_VALUE_PAIRS.some(([a, b]) => {
    const s = [a, b].sort();
    return s[0] === n[0] && s[1] === n[1];
  });
}

// Determines the correct AttributePicklist.DataType for a given attribute.
// Uses "Boolean" only for true boolean-semantic 2-value sets (True/False, Yes/No, etc.)
// Everything else — Low/Medium/High, 3/5/Unlimited, etc. — gets "Text".
// Never omits DataType: omission causes Salesforce to auto-infer Boolean, producing
// "Select up to 2 values for boolean data type" errors on 3+ value picklists.
function inferPicklistContainerDT(attr: ParsedAttribute, plDTValues: string[]): string {
  const useBool = attr.dataType?.toLowerCase() === "boolean" || isBooleanValueSet(attr.values);
  if (useBool) return plDTValues.find(v => /^boolean$/i.test(v)) ?? "Boolean";
  return plDTValues.find(v => /^text$/i.test(v)) ?? "Text";
}

// Product-scoped naming helpers — ensures every deployment gets isolated, collision-free picklists
function toProductScope(name: string): string {
  return (name || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function toPicklistName(productName: string, attrName: string): string {
  return `${toProductScope(productName)}_${toProductScope(attrName)}`;
}

function toPicklistValueCode(productName: string, attrName: string, value: string): string {
  const p = toProductScope(productName).toUpperCase();
  const a = toProductScope(attrName).toUpperCase();
  const v = toProductScope(value).toUpperCase();
  return `${p}_${a}_${v}`.slice(0, 200);
}

function getDisplayType(attr: ParsedAttribute): string {
  const lower = (attr.dataType ?? "").toLowerCase();
  if (lower === "picklist" || lower === "enum" || lower === "select") return "ComboBox";
  if (lower === "boolean" || lower === "checkbox")                     return "Checkbox";
  if (lower === "number"  || lower === "integer" || lower === "float") return "Number";
  return "Text";
}

async function ensureSchemaInfo(
  ctx: BatchContext,
  client: SalesforceClient,
  log: (m: string) => void,
): Promise<SchemaInfo> {
  if (ctx.schemaInfo) return ctx.schemaInfo;
  log("  [SCHEMA] Discovering org schema on-demand…");
  const [padD, attrDefD, p2D, smoD] = await Promise.all([
    safeDescribe(client, "ProductAttributeDefinition"),
    safeDescribe(client, "AttributeDefinition"),
    safeDescribe(client, "Product2"),
    safeDescribe(client, "ProductSellingModelOption"),
  ]);
  const attrDefDatatypeField = detectDatatypeField(attrDefD);
  return {
    padDatatypeField:       detectDatatypeField(padD),
    attrDefDatatypeField,
    attrDefPicklistFKField: firstExistingField(attrDefD, ["PicklistId", "AttributePicklistId"]),
    validDatatypes:         attrDefDatatypeField ? picklistValues(attrDefD, attrDefDatatypeField) : [],
    product2ValidTypes:     picklistValues(p2D, "Type"),
    padProduct2FKField:     firstExistingField(padD, ["Product2Id", "ProductId"]),
    padPCAFKField:          firstExistingField(padD, ["ProductClassificationAttributeId", "ProductClassificationAttrId"]),
    smoProductFKField:      firstExistingField(smoD, ["Product2Id", "ProductId"]),
    discoveredAt:           new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Batch executor — 8-batch RCA deployment
 *
 *  0 → Datatype Detection         (schema discovery + type normalisation)
 *  1 → AttributePicklist          (one per picklist attr; bulk-prefetch reuse first)
 *  2 → AttributePicklistValue     (individual values; reuse existing)
 *  3 → AttributeDefinition        (DataType=Picklist for picklist attrs + PicklistId link)
 *      + AttributeCategory + AttributeCategoryAttribute
 *  4 → ProductClassification      (business classification container)
 *  5 → Product2                   (simple create; no BasedOnId)
 *  6 → ProductClassificationAttr  (PCA: Classification + AttrDef junction)
 *      + ProductAttributeDefinition (PAD: Product2 + AttrDef + PCA — hybrid model)
 *  7 → Commercial Enablement      (SellingModel + PricebookEntry + CategoryProduct)
 * ─────────────────────────────────────────────────────────────────────────── */
async function executeBatch(
  batchIndex: number,
  data: ParsedRCAData,
  ctx: BatchContext,
  client: SalesforceClient,
): Promise<{ logs: string[]; ctx: BatchContext; health: StorageHealth }> {
  const logs: string[] = [];
  const newCtx: BatchContext = { ...ctx };
  const health = makeHealth();
  const log = (msg: string) => logs.push(`[${new Date().toISOString()}] ${msg}`);

  switch (batchIndex) {

    /* ── Batch 0: Datatype Detection + Internal Schema Discovery ─────────── */
    case 0: {
      log("BATCH 1: Datatype Detection");

      const objects = [
        "AttributeDefinition", "AttributePicklist", "AttributePicklistValue",
        "AttributeCategory", "AttributeCategoryAttribute",
        "ProductClassificationAttr", "ProductAttributeDefinition", "Product2",
        "ProductCatalog", "ProductCategory", "ProductClassification",
        "ProductSellingModel", "ProductSellingModelOption", "ProductCategoryProduct",
      ];

      log("  Discovering org schema for all RCA objects…");
      const describes = await Promise.all(objects.map(o => safeDescribe(client, o)));
      const map = Object.fromEntries(objects.map((o, i) => [o, describes[i]]));

      const attrDefD = map["AttributeDefinition"];
      const padD     = map["ProductAttributeDefinition"];
      const p2D      = map["Product2"];
      const smoD     = map["ProductSellingModelOption"];

      const attrDefDatatypeField = detectDatatypeField(attrDefD);
      const validDatatypes       = attrDefDatatypeField ? picklistValues(attrDefD, attrDefDatatypeField) : [];

      const pcaD_b0 = map["ProductClassificationAttr"];
      const info: SchemaInfo = {
        padDatatypeField:       detectDatatypeField(padD),
        attrDefDatatypeField,
        attrDefPicklistFKField: firstExistingField(attrDefD, ["PicklistId", "AttributePicklistId"]),
        validDatatypes,
        product2ValidTypes:     picklistValues(p2D, "Type"),
        padProduct2FKField:     firstExistingField(padD, ["Product2Id", "ProductId"]),
        padPCAFKField:          firstExistingField(padD, ["ProductClassificationAttributeId", "ProductClassificationAttrId"]),
        smoProductFKField:      firstExistingField(smoD, ["Product2Id", "ProductId"]),
        discoveredAt:           new Date().toISOString(),
      };
      void pcaD_b0; // referenced for schema discovery; FK detection happens at batch runtime
      newCtx.schemaInfo = info;

      log(`  attrDefDatatypeField   = ${info.attrDefDatatypeField   ?? "NOT FOUND"}`);
      log(`  attrDefPicklistFKField = ${info.attrDefPicklistFKField ?? "NOT FOUND"}`);
      log(`  validDatatypes         = [${info.validDatatypes.join(", ") || "all types allowed"}]`);
      log(`  padProduct2FKField     = ${info.padProduct2FKField     ?? "NOT FOUND"}`);
      log(`  padPCAFKField          = ${info.padPCAFKField          ?? "NOT FOUND — will be discovered at Batch 7 runtime"}`);

      // Normalise datatypes — picklist attrs will be stored as "Picklist" in context
      // but Batch 4 will create AttributeDefinition with DataType=Picklist + PicklistId
      const normalizedTypes: Record<string, string> = {};
      const byType: Record<string, string[]> = {};
      log("  Normalizing attribute datatypes:");
      for (const attr of data.attributes) {
        const normalized = normalizeDatatype(attr.dataType, validDatatypes);
        normalizedTypes[attr.name] = normalized;
        (byType[normalized] ??= []).push(attr.name);
        log(`    "${attr.name}": "${attr.dataType}" → "${normalized}"`);
      }
      newCtx.normalizedTypes = normalizedTypes;

      log("  [DATATYPE SUMMARY]");
      for (const [type, names] of Object.entries(byType)) {
        log(`    ${type.padEnd(10)} — ${names.length} attr(s): ${names.map(n => `"${n}"`).join(", ")}`);
      }

      const picklistCount = data.attributes.filter(a => isPicklistAttr(a)).length;
      log(picklistCount > 0
        ? `  [INFO] ${picklistCount} picklist attr(s) — will use DataType=Picklist + PicklistId (correct RCA pattern)`
        : "  [INFO] No picklist attributes detected");

      log("  [OBJECT ACCESS]");
      for (const obj of objects) {
        log(`    ${obj}: ${map[obj] ? "✓ accessible" : "✗ not accessible"}`);
      }

      log("Batch 1 complete — datatypes normalized, schema cached");
      break;
    }

    /* ── Batch 1: AttributePicklist ──────────────────────────────────────── */
    case 1: {
      log("BATCH 2: Dynamic Picklist Creation");

      const schemaInfo  = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const picklistAttrs = data.attributes.filter(a => isPicklistAttr(a));

      if (picklistAttrs.length === 0) {
        log("  No picklist-type attributes — batch skipped");
        break;
      }

      const d = await safeDescribe(client, "AttributePicklist");
      buildDebugSummary("AttributePicklist", d, log);

      const attributePicklistIds: Record<string, string> = { ...(newCtx.attributePicklistIds ?? {}) };

      const hasDatatypeField = fieldExists(d, "DataType");
      const plDTValues       = picklistValues(d, "DataType");
      const plSel            = hasDatatypeField ? "Id, DataType" : "Id";
      log(`  [SCHEMA] AttributePicklist valid DataTypes: [${plDTValues.join(", ") || "none"}]`);
      log(`  [INFO] Product-scoped naming: <PRODUCT>_<ATTR> — no cross-product reuse, no Code collisions`);

      for (const attr of picklistAttrs) {
        if (attributePicklistIds[attr.name]) {
          trackReuse(health, "AttributePicklist");
          log(`  [CACHE] "${attr.name}" already in context → ${attributePicklistIds[attr.name]}`);
          continue;
        }

        const inferredDT = inferPicklistContainerDT(attr, plDTValues);
        const scopedName = toPicklistName(data.productName, attr.name);
        const scopedCode = scopedName.toUpperCase().slice(0, 80);
        log(`  [PICKLIST_DEBUG] "${attr.name}": scopedName="${scopedName}" | inferredDT="${inferredDT}"`);

        // Look up by product-scoped name — idempotent for re-runs of the same product
        let foundId: string | null = null;
        let foundDT: string | undefined;
        try {
          const r = await client.query<{ Id: string; DataType?: string }>(
            `SELECT ${plSel} FROM AttributePicklist WHERE Name = '${soqlEscape(scopedName)}' LIMIT 1`,
          );
          if (r.records[0]?.Id) { foundId = r.records[0].Id; foundDT = r.records[0].DataType; }
        } catch { /* proceed to create */ }

        if (foundId) {
          const compatible = isPicklistDatatypeCompatible(foundDT, inferredDT);
          log(`  [PICKLIST_DEBUG] Found "${scopedName}" | DataType="${foundDT ?? "none"}" | compatible=${compatible}`);
          attributePicklistIds[attr.name] = foundId;
          trackReuse(health, "AttributePicklist");
          log(`  [REUSE] ↩ Product-scoped AttributePicklist: "${scopedName}"${compatible ? "" : " ⚠ DataType mismatch — Batch 3 pre-check will repair"} → ${foundId}`);
          continue;
        }

        // Create new product-scoped AttributePicklist
        try {
          const raw: Record<string, unknown> = { Name: scopedName };
          if (fieldExists(d, "Code"))        raw.Code        = scopedCode;
          if (fieldExists(d, "Status"))      raw.Status      = "Active";
          if (fieldExists(d, "IsActive"))    raw.IsActive    = true;
          if (fieldExists(d, "Description")) raw.Description = `${attr.name} options for ${data.productName}`;
          if (hasDatatypeField)              raw.DataType    = inferredDT;

          const payload = filterCreatable(raw, d);
          const result  = await client.createRecord("AttributePicklist", payload);
          if (!result.success) throw new Error(JSON.stringify(result.errors));
          attributePicklistIds[attr.name] = result.id;
          trackCreate(health);
          log(`  ✓ Created product-scoped AttributePicklist: "${scopedName}" (DataType=${inferredDT}) → ${result.id}`);

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (isStorageLimitError(err)) {
            trackStorageError(health, "AttributePicklist");
            log(`  ✗ [ORG STORAGE] "${scopedName}": storage exhausted — clean old RCA test records or use a fresh org`);
          } else {
            log(`  ✗ "${scopedName}": ${errMsg}`);
          }
          // Last-resort: fall back to any existing compatible picklist for this attr name
          try {
            const r = await client.query<{ Id: string; DataType?: string }>(
              `SELECT ${plSel} FROM AttributePicklist WHERE Name = '${soqlEscape(attr.name)}' LIMIT 1`,
            );
            if (r.records[0]?.Id && (!hasDatatypeField || isPicklistDatatypeCompatible(r.records[0].DataType, inferredDT))) {
              attributePicklistIds[attr.name] = r.records[0].Id;
              trackReuse(health, "AttributePicklist");
              log(`  [RECOVERY] ↩ Generic fallback AttributePicklist: "${attr.name}" → ${r.records[0].Id}`);
            }
          } catch { /* no recovery */ }
        }
      }

      newCtx.attributePicklistIds = attributePicklistIds;
      log(`  [SUMMARY] AttributePicklist IDs: ${Object.keys(attributePicklistIds).length}/${picklistAttrs.length}`);
      log("Batch 2 complete");
      break;
    }

    /* ── Batch 2: AttributePicklistValue ─────────────────────────────────── */
    case 2: {
      log("BATCH 3: Picklist Values");

      const schemaInfo  = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const picklistAttrs = data.attributes.filter(
        a => isPicklistAttr(a) && a.values.length > 0,
      );

      if (picklistAttrs.length === 0) {
        log("  No picklist values to create — batch skipped");
        break;
      }

      const d    = await safeDescribe(client, "AttributePicklistValue");
      const plD  = await safeDescribe(client, "AttributePicklist");
      buildDebugSummary("AttributePicklistValue", d, log);
      const hasPicklistDTField = fieldExists(plD, "DataType");
      // plDTValues fed into inferPicklistContainerDT per-attribute (Text vs Boolean derived from values)
      const plDTValues = picklistValues(plD, "DataType");
      // Discover FK field name for AttributePicklistValue → AttributePicklist
      const plValueFKField = firstExistingField(d, ["AttributePicklistId", "PicklistId"]) ?? "AttributePicklistId";
      log(`  [SCHEMA] AttributePicklist valid DataTypes: [${plDTValues.join(", ") || "none"}] | plValueFKField="${plValueFKField}"`);

      // Track repaired picklist IDs within this batch (attr.name → new compatible id)
      const repairedPicklistIds: Record<string, string> = {};

      // Carry forward picklist IDs in a mutable copy so repairs are reflected immediately
      const activePicklistIds: Record<string, string> = { ...(newCtx.attributePicklistIds ?? {}) };

      const attributePicklistValueIds: Record<string, string[]> = { ...(newCtx.attributePicklistValueIds ?? {}) };

      for (const attr of picklistAttrs) {
        if (attributePicklistValueIds[attr.name]?.length) {
          log(`  [CACHE] "${attr.name}" values already in context (${attributePicklistValueIds[attr.name].length})`);
          continue;
        }

        // Deterministic DataType for this attr's picklist container ("Text" or "Boolean")
        const inferredDT = inferPicklistContainerDT(attr, plDTValues);

        let picklistId = activePicklistIds[attr.name];
        if (!picklistId) {
          log(`  ↩ Skipping "${attr.name}" — no AttributePicklist ID (run Batch 2 first)`);
          continue;
        }

        // ── Pre-validate DataType before inserting values ──────────────────────
        if (hasPicklistDTField) {
          try {
            const plRec = await client.query<{ Id: string; Name: string; DataType?: string }>(
              `SELECT Id, Name, DataType FROM AttributePicklist WHERE Id = '${soqlEscape(picklistId)}' LIMIT 1`,
            );
            const existingDT = plRec.records[0]?.DataType;
            const compatible = isPicklistDatatypeCompatible(existingDT, inferredDT);
            log(`  [PICKLIST_COMPAT] Batch 3 pre-check "${attr.name}": picklistId=${picklistId} | DataType="${existingDT ?? "none"}" | inferredDT="${inferredDT}" | compatible=${compatible}`);

            if (!compatible) {
              log(`  ✗ [PICKLIST_MISMATCH] "${attr.name}": picklist DataType="${existingDT}" incompatible with "${inferredDT}" — attempting inline repair`);
              // Repair: create a fresh product-scoped picklist with the correct DataType
              let repairedId: string | null = null;
              const repairSel  = "Id, DataType";
              const scopedBase = toPicklistName(data.productName, attr.name);
              for (const candidate of [`${scopedBase}_v2`, `${scopedBase}_v3`, `${scopedBase}_repair`]) {
                try {
                  const r = await client.query<{ Id: string; DataType?: string }>(
                    `SELECT ${repairSel} FROM AttributePicklist WHERE Name = '${soqlEscape(candidate)}' LIMIT 1`,
                  );
                  if (r.records.length === 0) {
                    const newRaw: Record<string, unknown> = { Name: candidate };
                    if (hasPicklistDTField) newRaw.DataType = inferredDT;
                    if (fieldExists(plD, "Code"))     newRaw.Code     = candidate.toUpperCase().slice(0, 80);
                    if (fieldExists(plD, "Status"))   newRaw.Status   = "Active";
                    if (fieldExists(plD, "IsActive")) newRaw.IsActive = true;
                    const newResult = await client.createRecord("AttributePicklist", filterCreatable(newRaw, plD));
                    if (newResult.success) {
                      repairedId = newResult.id;
                      trackCreate(health);
                      log(`  [PICKLIST_COMPAT] ✓ Repaired: created "${candidate}" (DataType=${inferredDT}) → ${repairedId}`);
                    }
                    break;
                  } else if (isPicklistDatatypeCompatible(r.records[0].DataType, inferredDT)) {
                    repairedId = r.records[0].Id;
                    trackReuse(health, "AttributePicklist");
                    log(`  [PICKLIST_COMPAT] [REUSE] ↩ Repaired via "${candidate}" (DataType="${r.records[0].DataType}") → ${repairedId}`);
                    break;
                  }
                } catch { break; }
              }
              if (repairedId) {
                activePicklistIds[attr.name] = repairedId;
                repairedPicklistIds[attr.name] = repairedId;
                picklistId = repairedId;
              } else {
                log(`  ↩ Skipping "${attr.name}" — inline repair failed; re-run Batch 2 to fix the picklist DataType`);
                continue;
              }
            }
          } catch {
            // Query failed — proceed, Salesforce will report any errors
          }
        }

        const valueIds: string[] = [];
        log(`  Creating ${attr.values.length} value(s) for "${attr.name}"`);

        for (let i = 0; i < attr.values.length; i++) {
          const val = attr.values[i];
          try {
            let existingId: string | null = null;
            try {
              const ex = await client.query<{ Id: string }>(
                `SELECT Id FROM AttributePicklistValue WHERE ${plValueFKField} = '${soqlEscape(picklistId)}' AND Name = '${soqlEscape(val)}' LIMIT 1`,
              );
              existingId = ex.records[0]?.Id ?? null;
            } catch { /* create */ }

            if (existingId) {
              valueIds.push(existingId);
              log(`    [REUSE] ↩ "${val}" → ${existingId}`);
              continue;
            }

            const raw: Record<string, unknown> = { [plValueFKField]: picklistId };
            if (fieldExists(d, "DisplayValue")) raw.DisplayValue = val;
            if (fieldExists(d, "Value"))        raw.Value        = val;
            if (fieldExists(d, "Name"))         raw.Name         = val;
            if (fieldExists(d, "Sequence"))     raw.Sequence     = i + 1;
            if (fieldExists(d, "Status"))       raw.Status       = "Active";
            if (fieldExists(d, "IsActive"))     raw.IsActive     = true;
            if (fieldExists(d, "Code"))         raw.Code         = toPicklistValueCode(data.productName, attr.name, val);
            if (fieldExists(d, "IsDefault"))    raw.IsDefault    = attr.defaultValue === val;

            const payload = filterCreatable(raw, d);
            const result  = await client.createRecord("AttributePicklistValue", payload);
            if (!result.success) throw new Error(JSON.stringify(result.errors));
            valueIds.push(result.id);
            log(`    ✓ "${val}" → ${result.id}`);
          } catch (err) {
            log(`    ✗ "${val}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        attributePicklistValueIds[attr.name] = valueIds;
      }

      newCtx.attributePicklistValueIds = attributePicklistValueIds;
      // Persist any inline-repaired picklist IDs so Batch 4 uses the correct ones
      if (Object.keys(repairedPicklistIds).length > 0) {
        newCtx.attributePicklistIds = { ...(newCtx.attributePicklistIds ?? {}), ...repairedPicklistIds };
        log(`  [PICKLIST_COMPAT] ${Object.keys(repairedPicklistIds).length} picklist(s) repaired and persisted to context: ${Object.keys(repairedPicklistIds).map(k => `"${k}"`).join(", ")}`);
      }
      log("Batch 3 complete");
      break;
    }

    /* ── Batch 3: AttributeDefinition + AttributeCategory ────────────────── */
    case 3: {
      log(`BATCH 4: Attribute Definition + Category — ${data.attributes.length} attribute(s)`);

      const schemaInfo = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const attrDefD     = await safeDescribe(client, "AttributeDefinition");
      const attrCatD     = await safeDescribe(client, "AttributeCategory");
      const attrCatAttrD = await safeDescribe(client, "AttributeCategoryAttribute");
      buildDebugSummary("AttributeDefinition", attrDefD, log);

      log(`  attrDefDatatypeField   = ${schemaInfo.attrDefDatatypeField   ?? "NONE"}`);
      log(`  attrDefPicklistFKField = ${schemaInfo.attrDefPicklistFKField ?? "NONE"}`);
      log(`  validDatatypes         = [${schemaInfo.validDatatypes.join(", ") || "none"}]`);

      // Derive Picklist DataType value as used by this org — AttributeDefinition needs this for picklist attrs
      const picklistAttrDT = schemaInfo.validDatatypes.find(v => /^picklist$/i.test(v))
        ?? schemaInfo.validDatatypes.find(v => /^enum/i.test(v))
        ?? normalizeDatatype("Picklist", schemaInfo.validDatatypes);
      log(`  picklistAttrDT (for picklist attrs) = "${picklistAttrDT}"`);

      // Effective PicklistId FK field — extended candidates beyond what schema discovery found
      // This field on AttributeDefinition is the critical link: without it, dropdown values are invisible in the UI
      const plFKField = schemaInfo.attrDefPicklistFKField
        ?? firstExistingField(attrDefD, ["PicklistId", "AttributePicklistId", "AttributePicklistFK", "PicklistFK"]);
      log(`  plFKField (effective)  = ${plFKField ?? "NOT FOUND ← PicklistId chain will be broken"}`);

      // ── Pre-fetch existing AttributeDefinitions (prevents storage-limit duplicates) ──
      const attributeDefIds: Record<string, string> = { ...(newCtx.attributeDefIds ?? {}) };
      const prefetchByName:    Record<string, string> = {};
      const prefetchByPlId:    Record<string, string> = {}; // attrName → stored PicklistId (for reuse validation)
      const prefetchByDevName: Record<string, string> = {};

      const quotedNames    = data.attributes.map(a => `'${soqlEscape(a.name)}'`).join(", ");
      const quotedDevNames = data.attributes.map(a => `'${soqlEscape(toDeveloperName(a.name))}'`).join(", ");

      try {
        // Include PicklistId field so we know if reused records already have the link
        const prefetchSelect = plFKField ? `Id, Name, ${plFKField}` : "Id, Name";
        const nr = await client.query<Record<string, unknown>>(
          `SELECT ${prefetchSelect} FROM AttributeDefinition WHERE Name IN (${quotedNames}) LIMIT 200`,
        );
        for (const r of nr.records) {
          prefetchByName[r.Name as string] = r.Id as string;
          if (plFKField && r[plFKField]) prefetchByPlId[r.Name as string] = r[plFKField] as string;
        }
        log(`  [PREFETCH] ${nr.records.length} existing AttributeDefinition(s) by Name`);
      } catch (e) {
        log(`  [PREFETCH] Name query failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      try {
        const dr = await client.query<{ Id: string; DeveloperName: string }>(
          `SELECT Id, DeveloperName FROM AttributeDefinition WHERE DeveloperName IN (${quotedDevNames}) LIMIT 200`,
        );
        for (const r of dr.records) prefetchByDevName[r.DeveloperName] = r.Id;
        log(`  [PREFETCH] ${dr.records.length} existing AttributeDefinition(s) by DeveloperName`);
      } catch (e) {
        log(`  [PREFETCH] DeveloperName query failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      let storageLimitHit = false;
      let reuseCount = 0;
      let createCount = 0;

      for (const attr of data.attributes) {
        if (attributeDefIds[attr.name]) {
          log(`  [CACHE] "${attr.name}" already in context → ${attributeDefIds[attr.name]}`);
          continue;
        }

        const devName    = toDeveloperName(attr.name);
        const picklistId = newCtx.attributePicklistIds?.[attr.name];
        const attrIsPicklist = isPicklistAttr(attr);

        // Picklist attrs must use DataType=Picklist on AttributeDefinition + PicklistId link
        const datatypeToUse = attrIsPicklist ? picklistAttrDT
          : (newCtx.normalizedTypes?.[attr.name] ?? normalizeDatatype(attr.dataType, schemaInfo.validDatatypes));

        log(`  [ATTR_DEBUG] "${attr.name}": dataType="${datatypeToUse}"` +
            (attrIsPicklist ? ` (picklist→Picklist pattern)` : "") +
            (attrIsPicklist && picklistId ? ` | PicklistId=${picklistId}` : attrIsPicklist ? " | PicklistId=MISSING (will create without)" : ""));

        // Pre-fetch cache hit — zero extra SOQL
        const prefetchedId = prefetchByName[attr.name] ?? prefetchByDevName[devName] ?? null;
        if (prefetchedId) {
          attributeDefIds[attr.name] = prefetchedId;
          reuseCount++;
          log(`  [REUSE] ↩ Existing AttributeDefinition: "${attr.name}" → ${prefetchedId}`);
          // Ensure PicklistId is linked — without it, dropdown values won't render in the product UI
          if (attrIsPicklist && picklistId && plFKField) {
            const existingPlId = prefetchByPlId[attr.name];
            if (!existingPlId) {
              log(`  ⚠ [VALIDATION] "${attr.name}": reused record missing PicklistId — patching`);
              try {
                await client.updateRecord("AttributeDefinition", prefetchedId, { [plFKField]: picklistId });
                log(`  ✓ [VALIDATION] "${attr.name}": PicklistId patched → ${picklistId}`);
              } catch (ue) {
                log(`  ✗ [VALIDATION] "${attr.name}": PicklistId patch failed: ${ue instanceof Error ? ue.message : String(ue)}`);
              }
            } else {
              log(`  ✓ [VALIDATION] "${attr.name}": PicklistId confirmed (existing) = ${existingPlId}`);
            }
          }
          continue;
        }

        if (storageLimitHit) {
          log(`  ↩ Skipping "${attr.name}" — storage limit reached this session`);
          continue;
        }

        try {
          const raw: Record<string, unknown> = {
            Name: attr.name,
            DeveloperName: devName,
            IsActive: attr.active,
          };
          if (fieldExists(attrDefD, "Label"))        raw.Label       = attr.name;
          if (fieldExists(attrDefD, "Description"))  raw.Description = attr.description;
          if (schemaInfo.attrDefDatatypeField)        raw[schemaInfo.attrDefDatatypeField] = datatypeToUse;

          // Always attach PicklistId for picklist attrs when available
          if (attrIsPicklist && picklistId && schemaInfo.attrDefPicklistFKField) {
            raw[schemaInfo.attrDefPicklistFKField] = picklistId;
          }

          const payload = filterCreatable(raw, attrDefD);
          log(`  [CREATE] "${attr.name}" payload: [${Object.keys(payload).join(", ")}]`);

          const result = await client.createRecord("AttributeDefinition", payload);
          if (!result.success) throw new Error(JSON.stringify(result.errors));

          attributeDefIds[attr.name] = result.id;
          createCount++;
          log(`  ✓ Created AttributeDefinition: "${attr.name}" (${devName}) → ${result.id}`);

          // Verify PicklistId was persisted — filterCreatable may strip it if not createable on this org
          if (attrIsPicklist && picklistId && plFKField) {
            try {
              const chk = await client.query<Record<string, unknown>>(
                `SELECT Id, ${plFKField} FROM AttributeDefinition WHERE Id = '${soqlEscape(result.id)}' LIMIT 1`,
              );
              const storedPL = chk.records[0]?.[plFKField];
              if (!storedPL) {
                log(`  ⚠ [VALIDATION] "${attr.name}": PicklistId not persisted on create — attempting updateRecord`);
                try {
                  await client.updateRecord("AttributeDefinition", result.id, { [plFKField]: picklistId });
                  log(`  ✓ [VALIDATION] "${attr.name}": PicklistId set via update → ${picklistId}`);
                } catch (ue) {
                  log(`  ✗ [VALIDATION] "${attr.name}": PicklistId update failed — dropdown values will not appear: ${ue instanceof Error ? ue.message : String(ue)}`);
                }
              } else {
                log(`  ✓ [VALIDATION] "${attr.name}": PicklistId confirmed on create → ${storedPL}`);
              }
            } catch { /* verification query failed — non-critical */ }
          }

        } catch (createErr) {
          if (isStorageLimitError(createErr)) {
            storageLimitHit = true;
            log(`  ⚠ [STORAGE LIMIT] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
            log(`  ✗ [ORG STORAGE] Org storage exhausted — unable to create AttributeDefinition. Clean old RCA test records or use a fresh org.`);
            continue;
          }
          // Recovery: final Name lookup
          log(`  ✗ Create failed: ${createErr instanceof Error ? createErr.message : String(createErr)} — attempting recovery`);
          try {
            const r = await client.query<{ Id: string }>(
              `SELECT Id FROM AttributeDefinition WHERE Name = '${soqlEscape(attr.name)}' LIMIT 1`,
            );
            if (r.records[0]?.Id) {
              attributeDefIds[attr.name] = r.records[0].Id;
              reuseCount++;
              log(`  [RECOVERY] Found "${attr.name}" → ${r.records[0].Id}`);
              if (attrIsPicklist && picklistId && plFKField) {
                try {
                  await client.updateRecord("AttributeDefinition", r.records[0].Id, { [plFKField]: picklistId });
                  log(`  ✓ [RECOVERY] PicklistId patched on recovered "${attr.name}" → ${picklistId}`);
                } catch { /* non-critical — proceed */ }
              }
            } else {
              log(`  ✗ "${attr.name}": no recovery record found — Batch 7 will skip this attribute`);
            }
          } catch {
            log(`  ✗ "${attr.name}": recovery lookup failed`);
          }
        }
      }

      newCtx.attributeDefIds = attributeDefIds;
      const resolvedCount = Object.keys(attributeDefIds).length;
      log(`  [SUMMARY] Reused: ${reuseCount} | Created: ${createCount} | Total: ${resolvedCount}/${data.attributes.length}`);

      // ── Post-batch: verify PicklistId chain for all picklist attrs ──────────
      if (plFKField) {
        const toCheck = data.attributes.filter(a => isPicklistAttr(a) && attributeDefIds[a.name]);
        if (toCheck.length > 0) {
          const idList = toCheck.map(a => `'${soqlEscape(attributeDefIds[a.name])}'`).join(", ");
          try {
            const v = await client.query<Record<string, unknown>>(
              `SELECT Id, Name, ${plFKField} FROM AttributeDefinition WHERE Id IN (${idList}) LIMIT 200`,
            );
            log("  [VALIDATION] AttributeDefinition.PicklistId chain:");
            for (const r of v.records) {
              const pl = r[plFKField];
              log(`    ${pl ? "✓" : "✗ MISSING"} "${r.Name as string}": PicklistId=${pl ?? "NULL ← dropdown values WILL NOT appear in product UI"}`);
            }
          } catch (ve) {
            log(`  [VALIDATION] PicklistId verification query failed: ${ve instanceof Error ? ve.message : String(ve)}`);
          }
        }
      }
      health.reuseCount  += reuseCount;
      health.createCount += createCount;
      if (reuseCount  > 0) health.reusedObjects["AttributeDefinition"] = (health.reusedObjects["AttributeDefinition"] ?? 0) + reuseCount;
      if (storageLimitHit) trackStorageError(health, "AttributeDefinition");

      const unresolved = data.attributes.filter(a => !attributeDefIds[a.name]);
      if (unresolved.length > 0) {
        log(`  ⚠ [VALIDATION] ${unresolved.length} attribute(s) missing IDs — Batch 7 will skip: ${unresolved.map(a => `"${a.name}"`).join(", ")}`);
      } else {
        log(`  ✓ [VALIDATION] All ${data.attributes.length} AttributeDefinition IDs confirmed`);
      }

      // ── AttributeCategory (optional — org-dependent) ─────────────────────
      const catName = data.classificationName || `${data.productFamily} Attributes`;
      if (attrCatD) {
        try {
          const { id: attrCatId, created } = await findOrCreate(
            client, "AttributeCategory",
            filterCreatable({
              Name: catName,
              ...(fieldExists(attrCatD, "Code")     ? { Code:     toDeveloperName(catName) } : {}),
              ...(fieldExists(attrCatD, "Status")   ? { Status:   "Active"                } : {}),
              ...(fieldExists(attrCatD, "IsActive") ? { IsActive: true                    } : {}),
            }, attrCatD),
            ["Name"], attrCatD, log,
          );
          newCtx.attributeCategoryId = attrCatId;
          log(`  ${created ? "✓ Created" : "[REUSE] ↩ Existing"} AttributeCategory: "${catName}" → ${attrCatId}`);

          if (attrCatAttrD) {
            const catFKField = firstExistingField(attrCatAttrD, ["AttributeCategoryId", "CategoryId"]);
            const defFKField = firstExistingField(attrCatAttrD, ["AttributeDefinitionId", "DefinitionId"]);

            if (catFKField && defFKField) {
              const attributeCatAttrIds: Record<string, string> = { ...(newCtx.attributeCatAttrIds ?? {}) };
              for (let i = 0; i < data.attributes.length; i++) {
                const attr      = data.attributes[i];
                const attrDefId = attributeDefIds[attr.name];
                if (!attrDefId || attributeCatAttrIds[attr.name]) continue;
                try {
                  const raw: Record<string, unknown> = {
                    [catFKField]: attrCatId,
                    [defFKField]: attrDefId,
                  };
                  if (fieldExists(attrCatAttrD, "Sequence")) raw.Sequence = i + 1;
                  if (fieldExists(attrCatAttrD, "Status"))   raw.Status   = "Active";

                  const { id, created: c } = await findOrCreate(
                    client, "AttributeCategoryAttribute",
                    filterCreatable(raw, attrCatAttrD),
                    [catFKField, defFKField], attrCatAttrD, log,
                  );
                  attributeCatAttrIds[attr.name] = id;
                  log(`    ${c ? "✓ Mapped" : "[REUSE] ↩ Existing"} AttributeCategoryAttribute: "${attr.name}" → ${id}`);
                } catch (err) {
                  log(`    ✗ CategoryAttribute "${attr.name}": ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              newCtx.attributeCatAttrIds = attributeCatAttrIds;
            } else {
              log(`  ↩ AttributeCategoryAttribute skipped — FK fields not detected`);
            }
          } else {
            log("  ↩ AttributeCategoryAttribute not accessible in this org");
          }
        } catch (err) {
          log(`  ↩ AttributeCategory skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log("  ↩ AttributeCategory not accessible in this org");
      }

      log("Batch 4 complete");
      break;
    }

    /* ── Batch 4: ProductClassification ──────────────────────────────────── */
    case 4: {
      log(`BATCH 5: Product Classification — "${data.classificationName}"`);

      const schemaInfo  = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const d           = await safeDescribe(client, "ProductClassification");
      buildDebugSummary("ProductClassification", d, log);

      const hasStatus   = fieldExists(d, "Status");
      const hasIsActive = fieldExists(d, "IsActive");
      let classificationId: string | null = null;
      let inactiveId: string | null = null;

      try {
        // Query active first
        if (hasStatus) {
          try {
            const r = await client.query<{ Id: string }>(
              `SELECT Id FROM ProductClassification WHERE Name = '${soqlEscape(data.classificationName)}' AND Status = 'Active' LIMIT 1`,
            );
            if (r.records[0]?.Id) { classificationId = r.records[0].Id; log(`  [REUSE] ↩ Active (Status) → ${classificationId}`); }
          } catch { /* try next */ }
        }
        if (!classificationId && hasIsActive) {
          try {
            const r = await client.query<{ Id: string }>(
              `SELECT Id FROM ProductClassification WHERE Name = '${soqlEscape(data.classificationName)}' AND IsActive = true LIMIT 1`,
            );
            if (r.records[0]?.Id) { classificationId = r.records[0].Id; log(`  [REUSE] ↩ Active (IsActive) → ${classificationId}`); }
          } catch { /* try without filter */ }
        }
        if (!classificationId) {
          const statusFields = ["Id", ...(hasIsActive ? ["IsActive"] : []), ...(hasStatus ? ["Status"] : [])].join(", ");
          try {
            const r = await client.query<{ Id: string; IsActive?: boolean; Status?: string }>(
              `SELECT ${statusFields} FROM ProductClassification WHERE Name = '${soqlEscape(data.classificationName)}' LIMIT 1`,
            );
            if (r.records[0]?.Id) {
              const rec    = r.records[0];
              const active = hasIsActive ? rec.IsActive === true : hasStatus ? rec.Status === "Active" : true;
              if (active) {
                classificationId = rec.Id;
                log(`  [REUSE] ↩ Existing ProductClassification → ${classificationId}`);
              } else {
                inactiveId = rec.Id;
                log(`  ⚠ Found "${data.classificationName}" but INACTIVE — attempting activation`);
                try {
                  const activateFields: Record<string, unknown> = {};
                  if (hasIsActive) activateFields.IsActive = true;
                  if (hasStatus)   activateFields.Status   = "Active";
                  await client.updateRecord("ProductClassification", rec.Id, activateFields);
                  classificationId = rec.Id;
                  log(`  ✓ Activated ProductClassification → ${classificationId}`);
                } catch (ae) {
                  log(`  ✗ Activation failed: ${ae instanceof Error ? ae.message : String(ae)} — creating new`);
                }
              }
            }
          } catch { /* proceed to create */ }
        }

        // Code-based fallback (finds records created with same Code but different Name)
        if (!classificationId && fieldExists(d, "Code")) {
          const codeVal = data.classificationName.replace(/\s+/g, "_").toUpperCase();
          try {
            const r = await client.query<{ Id: string }>(
              `SELECT Id FROM ProductClassification WHERE Code = '${soqlEscape(codeVal)}' LIMIT 1`,
            );
            if (r.records[0]?.Id) {
              classificationId = r.records[0].Id;
              trackReuse(health, "ProductClassification");
              log(`  [REUSE] ↩ Existing ProductClassification by Code → ${classificationId}`);
            }
          } catch { /* continue to create */ }
        }

        if (!classificationId) {
          const name = inactiveId ? `${data.classificationName} Active` : data.classificationName;
          const raw: Record<string, unknown> = { Name: name, Code: name.replace(/\s+/g, "_").toUpperCase() };
          if (hasIsActive) raw.IsActive = true;
          if (hasStatus)   raw.Status   = "Active";
          const payload = filterCreatable(raw, d);
          log(`  Creating ProductClassification: "${name}" — payload: [${Object.keys(payload).join(", ")}]`);
          try {
            const result = await client.createRecord("ProductClassification", payload);
            if (!result.success) throw new Error(JSON.stringify(result.errors));
            classificationId = result.id;
            trackCreate(health);
            log(`  ✓ Created: ${classificationId}`);
          } catch (createErr) {
            if (isStorageLimitError(createErr)) {
              trackStorageError(health, "ProductClassification");
              log(`  ✗ [ORG STORAGE] Org storage exhausted — trying to reuse any existing ProductClassification. Clean old RCA test records or use a fresh org.`);
              try {
                const anyQ = hasStatus
                  ? `SELECT Id FROM ProductClassification WHERE Status = 'Active' LIMIT 1`
                  : hasIsActive
                  ? `SELECT Id FROM ProductClassification WHERE IsActive = true LIMIT 1`
                  : `SELECT Id FROM ProductClassification LIMIT 1`;
                const rf = await client.query<{ Id: string }>(anyQ);
                if (rf.records[0]?.Id) {
                  classificationId = rf.records[0].Id;
                  trackReuse(health, "ProductClassification");
                  log(`  [RECOVERY] ↩ Reusing existing ProductClassification → ${classificationId}`);
                }
              } catch { /* no recovery available */ }
            } else {
              throw createErr;
            }
          }
        }

        if (classificationId) newCtx.classificationId = classificationId;
      } catch (err) {
        log(`  ✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      log("Batch 5 complete");
      break;
    }

    /* ── Batch 5: Product2 ───────────────────────────────────────────────── */
    case 5: {
      log(`BATCH 6: Product Creation — "${data.productName}" (${data.productCode})`);

      const schemaInfo  = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const d = await safeDescribe(client, "Product2");
      buildDebugSummary("Product2", d, log);

      let resolvedType: string | null = null;
      if (fieldExists(d, "Type")) {
        const validTypes = schemaInfo.product2ValidTypes.length > 0
          ? schemaInfo.product2ValidTypes
          : picklistValues(d, "Type");
        const req = (data.productType ?? "").toLowerCase();
        resolvedType =
          validTypes.find(v => v.toLowerCase() === req) ??
          validTypes.find(v => /product/i.test(v)) ??
          validTypes[0] ?? null;
        log(`  Product2.Type: "${data.productType}" → "${resolvedType ?? "omitted"}"`);
      }

      const hasBasedOnId      = fieldExists(d, "BasedOnId");
      const classificationId  = newCtx.classificationId ?? null;
      log(`  Product2.BasedOnId: field=${hasBasedOnId} | classificationId=${classificationId ?? "NOT SET — run Batch 5 first"}`);

      try {
        const existing = await client.query<{ Id: string }>(
          `SELECT Id FROM Product2 WHERE ProductCode = '${soqlEscape(data.productCode)}' LIMIT 1`,
        );
        let reuseProductId: string | null = existing.records[0]?.Id ?? null;
        let reuseMethod = "ProductCode";

        // Name fallback — covers cases where ProductCode changed between runs
        if (!reuseProductId && data.productName) {
          try {
            const byName = await client.query<{ Id: string }>(
              `SELECT Id FROM Product2 WHERE Name = '${soqlEscape(data.productName)}' LIMIT 1`,
            );
            if (byName.records[0]?.Id) { reuseProductId = byName.records[0].Id; reuseMethod = "Name"; }
          } catch { /* ignore */ }
        }

        if (reuseProductId) {
          newCtx.productId = reuseProductId;
          trackReuse(health, "Product2");
          log(`  [REUSE] ↩ Existing Product2 by ${reuseMethod}: ${newCtx.productId}`);
          // Update BasedOnId on the reused product so PAD mapping succeeds
          // PAD requires: Product2.BasedOnId == ProductClassificationAttr.ProductClassificationId
          if (hasBasedOnId && classificationId) {
            try {
              await client.updateRecord("Product2", reuseProductId, { BasedOnId: classificationId });
              log(`  ✓ Updated Product2.BasedOnId = ${classificationId}`);
            } catch (ue) {
              log(`  ⚠ Could not update BasedOnId on reused Product2: ${ue instanceof Error ? ue.message : String(ue)}`);
              log(`  ⚠ PAD mapping (Batch 7) may fail — verify Product2.BasedOnId manually in Salesforce`);
            }
          } else if (!classificationId) {
            log(`  ⚠ classificationId not in context — BasedOnId not set on reused Product2; run Batch 5 before Batch 6`);
          }
        } else {
          const raw: Record<string, unknown> = {
            Name: data.productName,
            ProductCode: data.productCode,
            Family: data.productFamily,
            IsActive: data.isActive,
            Description: data.description,
            QuantityUnitOfMeasure: data.unitOfMeasure,
          };
          if (resolvedType)                    raw.Type      = resolvedType;
          // BasedOnId links Product2 to ProductClassification — required for PCA → PAD hierarchy
          if (hasBasedOnId && classificationId) raw.BasedOnId = classificationId;

          const payload = filterCreatable(raw, d);
          log(`  Payload fields: [${Object.keys(payload).join(", ")}]`);
          try {
            const result = await client.createRecord("Product2", payload);
            if (!result.success) throw new Error(JSON.stringify(result.errors));
            newCtx.productId = result.id;
            trackCreate(health);
            log(`  ✓ Created Product2: ${result.id}`);
          } catch (createErr) {
            if (isStorageLimitError(createErr)) {
              trackStorageError(health, "Product2");
              log(`  ✗ [ORG STORAGE] Org storage exhausted — running full Product2 recovery sequence. Clean old RCA test records or use a fresh org.`);
              const recoveries: Array<{ label: string; soql: string }> = [
                { label: "ProductCode",      soql: `SELECT Id FROM Product2 WHERE ProductCode = '${soqlEscape(data.productCode)}' LIMIT 1` },
                { label: "Name (active)",    soql: `SELECT Id FROM Product2 WHERE Name = '${soqlEscape(data.productName)}' AND IsActive = true LIMIT 1` },
                { label: "Name (inactive)",  soql: `SELECT Id FROM Product2 WHERE Name = '${soqlEscape(data.productName)}' AND IsActive = false LIMIT 1` },
                { label: "Name (any)",       soql: `SELECT Id FROM Product2 WHERE Name = '${soqlEscape(data.productName)}' LIMIT 1` },
                { label: "any active",       soql: `SELECT Id FROM Product2 WHERE IsActive = true LIMIT 1` },
              ];
              for (const { label, soql } of recoveries) {
                if (newCtx.productId) break;
                try {
                  const r = await client.query<{ Id: string }>(soql);
                  if (r.records[0]?.Id) {
                    newCtx.productId = r.records[0].Id;
                    trackReuse(health, "Product2");
                    log(`  [RECOVERY] ↩ Reused Product2 by ${label} → ${newCtx.productId}`);
                  }
                } catch { /* try next strategy */ }
              }
              if (!newCtx.productId) {
                log(`  ✗ All Product2 recovery strategies exhausted — Batch 7 (PAD mapping) will not execute`);
              }
            } else {
              throw createErr;
            }
          }
        }
      } catch (err) {
        log(`  ✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      log("Batch 6 complete");
      break;
    }

    /* ── Batch 6: ProductClassificationAttr → ProductAttributeDefinition ── */
    case 6: {
      log("BATCH 7: Hybrid PCA → PAD Mapping");
      log("  Step 1 — ProductClassificationAttr: links Classification + AttributeDefinition");
      log("  Step 2 — ProductAttributeDefinition: Product2 + AttrDef + PCAId (required by this org)");

      if (!validateDeps([
        { label: "productId (run Batch 6 first)",          value: newCtx.productId        },
        { label: "classificationId (run Batch 5 first)",   value: newCtx.classificationId },
        { label: "attributeDefIds (run Batch 4 first)",    value: newCtx.attributeDefIds  },
      ], log)) break;

      const schemaInfo = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const pcaD = await safeDescribe(client, "ProductClassificationAttr");
      const padD = await safeDescribe(client, "ProductAttributeDefinition");
      buildDebugSummary("ProductClassificationAttr", pcaD, log);
      buildDebugSummary("ProductAttributeDefinition", padD, log);

      // PCA FK field discovery
      const pcaClassFKField  = firstExistingField(pcaD, ["ProductClassificationId", "ClassificationId"]);
      const pcaAttrDefFKField = firstExistingField(pcaD, ["AttributeDefinitionId", "DefinitionId"]);

      // PAD FK field discovery — runtime fallback if Batch 1 didn't cache it
      const padPCAFKField = schemaInfo.padPCAFKField
        ?? firstExistingField(padD, ["ProductClassificationAttributeId", "ProductClassificationAttrId"]);

      log(`  [PCA_DEBUG] PCA fields — classFK="${pcaClassFKField ?? "NONE"}" | attrDefFK="${pcaAttrDefFKField ?? "NONE"}"`);
      log(`  [PCA_DEBUG] PAD fields — product2FK="${schemaInfo.padProduct2FKField ?? "NONE"}" | pcaFK="${padPCAFKField ?? "NONE"}"`);
      log(`  [PCA_DEBUG] Context — classificationId="${newCtx.classificationId}" | productId="${newCtx.productId}"`);

      // Update schemaInfo cache with discovered padPCAFKField
      if (!schemaInfo.padPCAFKField && padPCAFKField) {
        newCtx.schemaInfo = { ...schemaInfo, padPCAFKField };
      }

      const pcaIds: Record<string, string> = { ...(newCtx.pcaIds ?? {}) };
      const padIds: Record<string, string> = { ...(newCtx.padIds ?? {}) };

      for (const attr of data.attributes) {
        const attrDefId = newCtx.attributeDefIds?.[attr.name];
        if (!attrDefId) {
          log(`  ↩ Skipping "${attr.name}" — no AttributeDefinition ID`);
          continue;
        }

        /* ── Step 1: ProductClassificationAttr ──────────────────────────── */
        // IMPORTANT: never use findOrCreate here — its individual-field fallback queries
        // "WHERE ProductClassificationId = X" which returns the *first* PCA for the
        // classification regardless of attribute, collapsing all attrs onto one PCA.
        // Always require BOTH AttributeDefinitionId AND ProductClassificationId.
        let pcaId = pcaIds[attr.name];
        if (pcaId) {
          log(`  [CACHE] PCA "${attr.name}" → ${pcaId}`);
        } else {
          try {
            // Lookup 1: exact match on both FK fields (required for correctness)
            if (pcaAttrDefFKField && pcaClassFKField && newCtx.classificationId) {
              try {
                const r = await client.query<{ Id: string }>(
                  `SELECT Id FROM ProductClassificationAttr WHERE ${pcaAttrDefFKField} = '${soqlEscape(attrDefId)}' AND ${pcaClassFKField} = '${soqlEscape(newCtx.classificationId)}' LIMIT 1`,
                );
                if (r.records[0]?.Id) {
                  pcaId = r.records[0].Id;
                  log(`  [REUSE] ↩ PCA "${attr.name}" by AttrDefId+ClassificationId → ${pcaId}`);
                }
              } catch { /* try Name fallback */ }
            }
            // Lookup 2: attr-specific Name fallback (safe — names are unique per attribute)
            if (!pcaId) {
              try {
                const r = await client.query<{ Id: string }>(
                  `SELECT Id FROM ProductClassificationAttr WHERE Name = '${soqlEscape(`${attr.name} Classification`)}' LIMIT 1`,
                );
                if (r.records[0]?.Id) {
                  pcaId = r.records[0].Id;
                  log(`  [REUSE] ↩ PCA "${attr.name}" by Name → ${pcaId}`);
                }
              } catch { /* fall through to create */ }
            }

            if (pcaId) {
              pcaIds[attr.name] = pcaId;
              trackReuse(health, "ProductClassificationAttr");
              log(`  [PCA_DEBUG] "${attr.name}": [REUSE] ↩ Existing PCA=${pcaId} | classId=${newCtx.classificationId} | attrDefId=${attrDefId}`);
            } else {
              const pcaRaw: Record<string, unknown> = { Name: `${attr.name} Classification` };
              if (pcaClassFKField  && newCtx.classificationId) pcaRaw[pcaClassFKField]  = newCtx.classificationId;
              if (pcaAttrDefFKField)                           pcaRaw[pcaAttrDefFKField] = attrDefId;
              if (fieldExists(pcaD, "Status"))   pcaRaw.Status   = "Active";
              if (fieldExists(pcaD, "IsActive")) pcaRaw.IsActive = true;

              const result = await client.createRecord("ProductClassificationAttr", filterCreatable(pcaRaw, pcaD));
              if (!result.success) throw new Error(JSON.stringify(result.errors));
              pcaId = result.id;
              pcaIds[attr.name] = result.id;
              trackCreate(health);
              log(`  [PCA_DEBUG] "${attr.name}": ✓ Created PCA=${result.id} | classId=${newCtx.classificationId} | attrDefId=${attrDefId}`);
            }
          } catch (pcaErr) {
            log(`  ✗ PCA "${attr.name}": ${pcaErr instanceof Error ? pcaErr.message : String(pcaErr)}`);
          }
        }

        if (!pcaId) {
          log(`  ↩ Skipping PAD for "${attr.name}" — PCA step failed`);
          continue;
        }

        /* ── Step 2: ProductAttributeDefinition ─────────────────────────── */
        // Same issue as PCA: findOrCreate's individual-field fallback on Product2Id would
        // return the first PAD for the product regardless of which attribute it maps to.
        // Always require BOTH AttributeDefinitionId AND Product2Id.
        if (padIds[attr.name]) {
          log(`  [CACHE] PAD "${attr.name}" → ${padIds[attr.name]}`);
          continue;
        }

        try {
          let padId: string | null = null;

          // Lookup 1: exact match on AttrDefId + Product2Id
          if (schemaInfo.padProduct2FKField && newCtx.productId) {
            try {
              const r = await client.query<{ Id: string }>(
                `SELECT Id FROM ProductAttributeDefinition WHERE AttributeDefinitionId = '${soqlEscape(attrDefId)}' AND ${schemaInfo.padProduct2FKField} = '${soqlEscape(newCtx.productId)}' LIMIT 1`,
              );
              if (r.records[0]?.Id) {
                padId = r.records[0].Id;
                log(`  [REUSE] ↩ PAD "${attr.name}" by AttrDefId+Product2Id → ${padId}`);
              }
            } catch { /* try Name fallback */ }
          }
          // Lookup 2: AttrDefId alone (safe — each AttrDef maps to one PAD per product)
          if (!padId) {
            try {
              const r = await client.query<{ Id: string }>(
                `SELECT Id FROM ProductAttributeDefinition WHERE AttributeDefinitionId = '${soqlEscape(attrDefId)}' LIMIT 1`,
              );
              if (r.records[0]?.Id) {
                padId = r.records[0].Id;
                log(`  [REUSE] ↩ PAD "${attr.name}" by AttributeDefinitionId → ${padId}`);
              }
            } catch { /* fall through to create */ }
          }

          if (padId) {
            padIds[attr.name] = padId;
            trackReuse(health, "ProductAttributeDefinition");
            log(`  [REUSE] ↩ Existing ProductAttributeDefinition: "${attr.name}" → ${padId}`);
            log(`  [PCA_DEBUG] PAD linked: padId=${padId} | pcaId=${pcaId} | product2Id=${newCtx.productId}`);
          } else {
            const padRaw: Record<string, unknown> = {
              Name: attr.name,
              AttributeDefinitionId: attrDefId,
            };
            if (schemaInfo.padProduct2FKField && newCtx.productId) padRaw[schemaInfo.padProduct2FKField] = newCtx.productId;
            if (padPCAFKField)                                       padRaw[padPCAFKField]                = pcaId;
            if (fieldExists(padD, "IsActive"))    padRaw.IsActive    = attr.active;
            if (fieldExists(padD, "DisplayType")) padRaw.DisplayType = getDisplayType(attr);
            if (fieldExists(padD, "Sequence"))    padRaw.Sequence    = data.attributes.indexOf(attr) + 1;
            if (fieldExists(padD, "IsRequired"))  padRaw.IsRequired  = attr.required;
            if (fieldExists(padD, "Description")) padRaw.Description = attr.description;

            const result = await client.createRecord("ProductAttributeDefinition", filterCreatable(padRaw, padD));
            if (!result.success) throw new Error(JSON.stringify(result.errors));
            padIds[attr.name] = result.id;
            trackCreate(health);
            log(`  ✓ Created ProductAttributeDefinition: "${attr.name}" → ${result.id}`);
            log(`  [PCA_DEBUG] PAD linked: padId=${result.id} | pcaId=${pcaId} | product2Id=${newCtx.productId}`);
          }
        } catch (err) {
          log(`  ✗ PAD "${attr.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      newCtx.pcaIds = pcaIds;
      newCtx.padIds = padIds;
      const pcaCount = Object.keys(pcaIds).length;
      const padCount = Object.keys(padIds).length;
      log(`  [SUMMARY] PCA: ${pcaCount}/${data.attributes.length} | PAD: ${padCount}/${data.attributes.length}`);
      if (padCount > 0) {
        log(`  ✓ ${padCount} attribute(s) mapped — navigate to Product → Related → Attributes in Salesforce to verify`);
      } else {
        log("  ⚠ No PAD records created — verify PCA creation succeeded and ProductClassificationAttributeId FK is present");
      }
      log("Batch 7 complete");
      break;
    }

    /* ── Batch 7: Runtime Value Persistence ──────────────────────────────── */
    case 7: {
      log("BATCH 8: Runtime Value Persistence");
      log("  Persists configured default values for each attribute on the deployed product");

      if (!validateDeps([
        { label: "productId (run Batch 6 first)",       value: newCtx.productId       },
        { label: "padIds (run Batch 7 first)",          value: newCtx.padIds          },
        { label: "attributeDefIds (run Batch 4 first)", value: newCtx.attributeDefIds },
      ], log)) break;

      const schemaInfo = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      // Discover which runtime-value object is accessible in this org
      const candidateObjects = [
        "ProductAttributeDefinitionValue",
        "AttributeDefinitionValue",
        "ProductAttributeDefinitionOverride",
      ];
      let runtimeObject: string | null = null;
      let runtimeD: DescribeResult | null = null;
      for (const obj of candidateObjects) {
        const d = await safeDescribe(client, obj);
        if (d) { runtimeObject = obj; runtimeD = d; break; }
      }

      if (!runtimeObject || !runtimeD) {
        log("  ↩ No runtime value persistence object accessible in this org — batch skipped");
        log(`  ↩ Checked: ${candidateObjects.join(", ")}`);
        log("  ↩ This is non-blocking — the product and its attribute mappings are still fully deployed");
        log("Batch 8 complete");
        break;
      }

      log(`  [SCHEMA] Runtime value object: ${runtimeObject}`);
      buildDebugSummary(runtimeObject, runtimeD, log);

      const padFKField   = firstExistingField(runtimeD, ["ProductAttributeDefinitionId", "PADId", "AttributeDefinitionId"]);
      const valueFKField = firstExistingField(runtimeD, ["Value", "DefaultValue", "AttributeValue", "TextValue", "StringValue"]);
      log(`  [SCHEMA] padFK="${padFKField ?? "NONE"}" | valueField="${valueFKField ?? "NONE"}"`);

      const runtimeValueIds: Record<string, string> = { ...(newCtx.runtimeValueIds ?? {}) };

      for (const attr of data.attributes) {
        const padId     = newCtx.padIds?.[attr.name];
        const attrDefId = newCtx.attributeDefIds?.[attr.name];
        if (!padId && !attrDefId) {
          log(`  ↩ Skipping "${attr.name}" — no PAD or AttrDef ID`);
          continue;
        }
        if (runtimeValueIds[attr.name]) {
          log(`  [CACHE] "${attr.name}" runtime value already in context → ${runtimeValueIds[attr.name]}`);
          continue;
        }

        // Determine the runtime value to persist
        let runtimeValue: string | null = null;
        if (attr.values.length > 0) {
          runtimeValue = attr.defaultValue ?? attr.values[0];
        } else if (attr.dataType === "Boolean" || attr.dataType === "Checkbox") {
          runtimeValue = "false";
        } else if (attr.dataType === "Number") {
          runtimeValue = "0";
        } else {
          runtimeValue = attr.description ? attr.description.slice(0, 255) : attr.name;
        }
        if (!runtimeValue) { log(`  ↩ "${attr.name}": no value to persist`); continue; }

        try {
          const raw: Record<string, unknown> = { Name: `${attr.name} Value` };
          if (padFKField)   raw[padFKField]   = padId ?? attrDefId;
          if (valueFKField) raw[valueFKField] = runtimeValue;
          if (fieldExists(runtimeD, "IsActive")) raw.IsActive = true;
          if (fieldExists(runtimeD, "Status"))   raw.Status   = "Active";

          const payload    = filterCreatable(raw, runtimeD);
          const searchKeys = padFKField ? [padFKField] : ["Name"];
          log(`  [CREATE] "${attr.name}" → value="${runtimeValue}" | payload: [${Object.keys(payload).join(", ")}]`);

          const { id, created } = await findOrCreate(client, runtimeObject, payload, searchKeys, runtimeD, log);
          runtimeValueIds[attr.name] = id;
          if (created) trackCreate(health); else trackReuse(health, runtimeObject);
          log(`  ${created ? "✓ Created" : "[REUSE] ↩ Existing"} ${runtimeObject}: "${attr.name}" = "${runtimeValue}" → ${id}`);
        } catch (err) {
          if (isStorageLimitError(err)) {
            trackStorageError(health, runtimeObject);
            log(`  ✗ [ORG STORAGE] Storage exhausted for runtime value "${attr.name}". Clean old RCA test records.`);
          } else {
            log(`  ✗ Runtime value "${attr.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      newCtx.runtimeValueIds = runtimeValueIds;
      log(`  [SUMMARY] Runtime values persisted: ${Object.keys(runtimeValueIds).length}/${data.attributes.length}`);
      log("Batch 8 complete");
      break;
    }

    /* ── Batch 8: Commercial RCA Enablement ──────────────────────────────── */
    case 8: {
      log("BATCH 9: Commercial RCA Enablement");

      if (!validateDeps([
        { label: "productId (run Batch 6 first)", value: newCtx.productId },
      ], log)) break;

      const schemaInfo = await ensureSchemaInfo(newCtx, client, log);
      newCtx.schemaInfo = schemaInfo;

      const catD  = await safeDescribe(client, "ProductCatalog");
      const pcatD = await safeDescribe(client, "ProductCategory");
      const pcpD  = await safeDescribe(client, "ProductCategoryProduct");
      const smD   = await safeDescribe(client, "ProductSellingModel");
      const smoD  = await safeDescribe(client, "ProductSellingModelOption");

      const catalogName = data.productFamily
        ? `${data.productFamily} Catalog`
        : `${data.classificationName} Catalog`;

      try {
        const { id: catalogId, created: catCreated } = await findOrCreate(
          client, "ProductCatalog", filterCreatable({ Name: catalogName }, catD),
          ["Name"], catD, log,
        );
        newCtx.catalogId = catalogId;
        if (catCreated) trackCreate(health); else trackReuse(health, "ProductCatalog");
        log(`  ${catCreated ? "✓ Created" : "[REUSE] ↩ Existing"} ProductCatalog: "${catalogName}" → ${catalogId}`);
      } catch (err) {
        const catalogMsg = err instanceof Error ? err.message : String(err);
        log(`  ✗ ProductCatalog create/find failed: ${catalogMsg} — attempting aggressive catalog recovery`);
        if (isStorageLimitError(err)) {
          trackStorageError(health, "ProductCatalog");
          log(`  ✗ [ORG STORAGE] Storage exhausted — trying to reuse any existing ProductCatalog. Clean old RCA test records or use a fresh org.`);
        }
        // Aggressive fallback: try any active catalog, then any catalog
        const catalogRecoveries = [
          { label: "active by Status",  soql: `SELECT Id FROM ProductCatalog WHERE Status = 'Active' LIMIT 1` },
          { label: "any",               soql: `SELECT Id FROM ProductCatalog LIMIT 1` },
        ];
        for (const { label, soql } of catalogRecoveries) {
          if (newCtx.catalogId) break;
          try {
            const r = await client.query<{ Id: string }>(soql);
            if (r.records[0]?.Id) {
              newCtx.catalogId = r.records[0].Id;
              trackReuse(health, "ProductCatalog");
              log(`  [RECOVERY] ↩ Reused ProductCatalog (${label}) → ${newCtx.catalogId}`);
            }
          } catch { /* try next */ }
        }
        if (!newCtx.catalogId) {
          log(`  ⚠ ProductCatalog unavailable — ProductCategory will be created without CatalogId`);
        }
      }

      try {
        const catPayload: Record<string, unknown> = { Name: data.categoryName };
        // Use catalogId from context (either found above or recovered) if the field exists
        const effectiveCatalogId = newCtx.catalogId;
        if (fieldExists(pcatD, "CatalogId") && effectiveCatalogId) {
          catPayload.CatalogId = effectiveCatalogId;
        }
        const { id: categoryId, created: pcatCreated } = await findOrCreate(
          client, "ProductCategory", filterCreatable(catPayload, pcatD),
          ["Name"], pcatD, log,
        );
        newCtx.categoryId = categoryId;
        if (pcatCreated) trackCreate(health); else trackReuse(health, "ProductCategory");
        log(`  ${pcatCreated ? "✓ Created" : "[REUSE] ↩ Existing"} ProductCategory: "${data.categoryName}" → ${categoryId}`);
      } catch (err) {
        const catMsg = err instanceof Error ? err.message : String(err);
        log(`  ✗ ProductCategory failed: ${catMsg} — attempting category recovery`);
        if (isStorageLimitError(err)) {
          trackStorageError(health, "ProductCategory");
          log(`  ✗ [ORG STORAGE] Storage exhausted — trying to reuse any existing ProductCategory.`);
        }
        // Aggressive fallback: try any category linked to our catalog, then any category
        const categoryRecoveries: Array<{ label: string; soql: string }> = [];
        if (newCtx.catalogId) {
          categoryRecoveries.push({
            label: "by CatalogId",
            soql: `SELECT Id FROM ProductCategory WHERE CatalogId = '${soqlEscape(newCtx.catalogId)}' LIMIT 1`,
          });
        }
        categoryRecoveries.push({ label: "any", soql: `SELECT Id FROM ProductCategory LIMIT 1` });
        for (const { label, soql } of categoryRecoveries) {
          if (newCtx.categoryId) break;
          try {
            const r = await client.query<{ Id: string }>(soql);
            if (r.records[0]?.Id) {
              newCtx.categoryId = r.records[0].Id;
              trackReuse(health, "ProductCategory");
              log(`  [RECOVERY] ↩ Reused ProductCategory (${label}) → ${newCtx.categoryId}`);
            }
          } catch { /* try next */ }
        }
        if (!newCtx.categoryId) {
          log(`  ⚠ ProductCategory unavailable — ProductCategoryProduct will be skipped`);
        }
      }

      if (newCtx.productId && newCtx.categoryId) {
        try {
          const productFK = firstExistingField(pcpD, ["Product2Id", "ProductId"]) ?? "ProductId";
          const ex = await client.query<{ Id: string }>(
            `SELECT Id FROM ProductCategoryProduct WHERE ProductCategoryId = '${soqlEscape(newCtx.categoryId)}' AND ${productFK} = '${soqlEscape(newCtx.productId)}' LIMIT 1`,
          ).catch(() => ({ records: [] as { Id: string }[] }));
          if (ex.records[0]?.Id) {
            log(`  [REUSE] ↩ Existing ProductCategoryProduct → ${ex.records[0].Id}`);
          } else {
            const raw: Record<string, unknown> = { ProductCategoryId: newCtx.categoryId };
            raw[productFK] = newCtx.productId;
            const result = await client.createRecord("ProductCategoryProduct", filterCreatable(raw, pcpD));
            if (result.success) {
              trackCreate(health);
              log(`  ✓ ProductCategoryProduct linked → ${result.id}`);
            } else if (isStorageLimitError(new Error(JSON.stringify(result.errors)))) {
              trackStorageError(health, "ProductCategoryProduct");
              log(`  ✗ [ORG STORAGE] Storage exhausted — ProductCategoryProduct skipped. Clean old RCA test records or use a fresh org.`);
            } else {
              log(`  ✗ ProductCategoryProduct: ${JSON.stringify(result.errors)}`);
            }
          }
        } catch (err) {
          log(`  ✗ ProductCategoryProduct: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log("  ↩ ProductCategoryProduct skipped — missing productId or categoryId");
      }

      log(`  ProductSellingModel: "${data.sellingModel}"`);
      try {
        const { id: smId, created: smCreated } = await findOrCreate(
          client, "ProductSellingModel",
          filterCreatable({ Name: data.sellingModel, SellingModelType: sellingModelType(data.sellingModel), Status: "Active" }, smD),
          ["Name"], smD, log,
        );
        newCtx.sellingModelId = smId;
        if (smCreated) trackCreate(health); else trackReuse(health, "ProductSellingModel");
        log(`  ${smCreated ? "✓ Created" : "[REUSE] ↩ Existing"} ProductSellingModel → ${smId}`);
      } catch (err) {
        log(`  ✗ ProductSellingModel: ${err instanceof Error ? err.message : String(err)}`);
      }

      const smoFK = schemaInfo.smoProductFKField ?? firstExistingField(smoD, ["Product2Id", "ProductId"]);
      if (newCtx.productId && newCtx.sellingModelId && smoFK) {
        try {
          const ex = await client.query<{ Id: string }>(
            `SELECT Id FROM ProductSellingModelOption WHERE ProductSellingModelId = '${soqlEscape(newCtx.sellingModelId)}' AND ${smoFK} = '${soqlEscape(newCtx.productId)}' LIMIT 1`,
          ).catch(() => ({ records: [] as { Id: string }[] }));
          if (ex.records[0]?.Id) {
            log(`  [REUSE] ↩ Existing ProductSellingModelOption → ${ex.records[0].Id}`);
          } else {
            const raw: Record<string, unknown> = { ProductSellingModelId: newCtx.sellingModelId };
            raw[smoFK] = newCtx.productId;
            const result = await client.createRecord("ProductSellingModelOption", filterCreatable(raw, smoD));
            if (result.success) {
              trackCreate(health);
              log(`  ✓ ProductSellingModelOption linked → ${result.id}`);
            } else if (isStorageLimitError(new Error(JSON.stringify(result.errors)))) {
              trackStorageError(health, "ProductSellingModelOption");
              log(`  ✗ [ORG STORAGE] Storage exhausted — SellingModelOption skipped. Clean old RCA test records or use a fresh org.`);
            } else {
              log(`  ✗ ProductSellingModelOption: ${JSON.stringify(result.errors)}`);
            }
          }
        } catch (err) {
          log(`  ✗ ProductSellingModelOption: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log(`  ↩ SellingModelOption skipped — productId=${!!newCtx.productId}, sellingModelId=${!!newCtx.sellingModelId}, FK=${smoFK ?? "NONE"}`);
      }

      if (newCtx.productId) {
        try {
          const pbResult = await client.query<{ Id: string }>("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
          const pbId     = pbResult.records[0]?.Id as string | undefined;
          if (pbId) {
            const ex = await client.query<{ Id: string }>(
              `SELECT Id FROM PricebookEntry WHERE Product2Id = '${soqlEscape(newCtx.productId)}' AND Pricebook2Id = '${soqlEscape(pbId)}' LIMIT 1`,
            ).catch(() => ({ records: [] as { Id: string }[] }));
            if (ex.records[0]?.Id) {
              log(`  [REUSE] ↩ Existing PricebookEntry → ${ex.records[0].Id}`);
            } else {
              const pbe = await client.createRecord("PricebookEntry", {
                Product2Id: newCtx.productId, Pricebook2Id: pbId,
                UnitPrice: 0, IsActive: data.isActive,
              });
              if (pbe.success) {
                trackCreate(health);
                log(`  ✓ PricebookEntry created (Standard Pricebook, $0) → ${pbe.id}`);
              } else if (isStorageLimitError(new Error(JSON.stringify(pbe.errors)))) {
                trackStorageError(health, "PricebookEntry");
                log(`  ✗ [ORG STORAGE] Storage exhausted — PricebookEntry skipped. Clean old RCA test records or use a fresh org.`);
              } else {
                log(`  ✗ PricebookEntry: ${JSON.stringify(pbe.errors)}`);
              }
            }
          } else {
            log("  ↩ PricebookEntry skipped — Standard Pricebook not found in org");
          }
        } catch (err) {
          log(`  ✗ PricebookEntry: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      log("Batch 9 complete — RCA deployment orchestration finished");
      break;
    }

    default:
      logs.push(`Unknown batch index: ${batchIndex}`);
  }

  return { logs, ctx: newCtx, health };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Route handler
 * ─────────────────────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  const cookie  = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { batchIndex: number; parsedData: ParsedRCAData; context: BatchContext };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }); }

  const { batchIndex, parsedData, context = {} } = body;

  if (typeof batchIndex !== "number" || batchIndex < 0 || batchIndex > 8)
    return NextResponse.json({ error: "Invalid batchIndex — must be 0–8" }, { status: 400 });

  if (!parsedData?.productName)
    return NextResponse.json({ error: "parsedData is required" }, { status: 400 });

  const client = clientFromSession(session);

  try {
    const { logs, ctx, health } = await executeBatch(batchIndex, parsedData, context, client);
    return NextResponse.json({ success: true, logs, context: ctx, storageHealth: health });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Batch execution failed";
    return NextResponse.json({ success: false, error: msg, logs: [`[ERROR] ${msg}`], context, storageHealth: makeHealth() }, { status: 500 });
  }
}
