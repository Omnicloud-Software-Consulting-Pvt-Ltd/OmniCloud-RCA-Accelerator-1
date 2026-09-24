/**
 * Parts G/H/I — the native Salesforce record layer for Attribute-Based
 * Pricing: PriceAdjustmentSchedule (the "lookup table"), AttributeBasedAdjRule,
 * AttributeAdjustmentCondition, and AttributeBasedAdjustment. Every lookup
 * field is discovered per-org via Describe (nativeSchemaResolver.ts) — never
 * a hardcoded API name. Datatype resolution never guesses: a value that
 * can't be confidently typed blocks before any createRecord() call, never
 * coerced (see resolveConditionValueAssignment).
 *
 * Part G is re-validated fresh here, independent of whatever Steps 2-9
 * already discovered: before creating anything, this module re-queries
 * Product2/AttributeDefinition/ProductAttributeDefinition/AttributePicklistValue
 * so a value created by another process between analysis and creation is
 * reused, never duplicated (TOCTOU-safe).
 */
import { createHash, randomUUID } from "node:crypto";
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";
import { soqlEscape, SalesforceError } from "@/lib/salesforce/client";
import {
  SchemaCache, resolveReferenceField,
  resolveAttributeDataTypeSourceField, classifyAttributeDataType, resolveTypedValueField, resolveDataTypeField,
  convertValueForField, resolveDefaultPicklistValue, fillRequiredPicklistDefaults, resolvePriceImpactingField,
  resolveClassificationAttrLinkField,
  extractSalesforceFields, diagnoseCreateRejection, formatCreateRejectionDiagnosis,
  buildSchemaDiagnosis, logSchemaDiagnosis, logObjectCreation,
  type ResolvedLookup, type ValueKind, type ReferenceFieldResolution,
} from "./nativeSchemaResolver";
import { verifyRecordExists } from "./workflowRunner";
import { beginRunSnapshot, recordRuleCreatedDuringRun, getRuleIdsCreatedDuringRun } from "./runBoundaryStore";
import { resolveAttributePicklistId, createMissingAttributeValue } from "./valueCreation";
import { resolveProductClassificationInheritance } from "../productClassificationInheritance";
import type { CombinationRulePlanRow, PricingRulePlanRow, ProcedureStepLite } from "../types";
import type { CreatedValueRecord } from "./types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function oneYearFromTodayISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/** Salesforce's standard `Name` field caps out at 80 characters. */
const RULE_NAME_MAX_LENGTH = 80;

/**
 * §Root-cause fix (offline forensic analysis, post-combinatorial-closure live run) — a live run of
 * `expandAttributeCombinationRules` against the real org produced this EXACT, real collision, captured
 * verbatim from that run's own log: the naive `raw.slice(0, 80)` this function used to do collapsed FIVE
 * genuinely different combinations —
 *   Processor=i7-CPU 4.7GHz AND Display=2k Built-in Display AND Screen Size=15 Inch AND Storage=<any of
 *   SSD 512GB / Cloud Storage Enterprise 6TB / SSD 1TB / SSD 2TB / Cloud Storage Enterprise 2TB>
 * — onto the byte-identical 80-character string
 *   "Processor_Display_Screen_Size_Storage_i7_CPU_4_7GHz_2k_Built_in_Display_15_Inch_"
 * because every one of those 5 Storage values sits entirely PAST the 80th character, so truncation never
 * even reaches the token that distinguishes them. `resolveProductConsistentRuleCandidate` (an exact-Name
 * lookup) then genuinely could not tell these apart, silently merging 4 of the 5 combinations' pricing
 * onto the FIRST one's Rule/Adjustment (a real, silent pricing-correctness bug, not just the eventual
 * `FIELD_INTEGRITY_EXCEPTION` that halted the run) — reproduced byte-for-byte offline in
 * `nativeRecords.combinationExpansion.test.ts` using this exact real data, no live org needed.
 *
 * Fixed the only way that's actually collision-safe regardless of how long/similar two inputs are: once
 * the sanitized name would exceed the length budget, the untruncated FULL string (which is where any two
 * distinct inputs are still guaranteed to differ) is hashed and a short, deterministic digest is appended
 * — so two different inputs can only ever collide via an actual SHA-256 collision on their full sanitized
 * form, not merely by sharing a long common prefix. Short names (the entire existing single-attribute
 * pipeline's own rule names, which are always well under the 80-char budget) are completely unaffected —
 * same output as before, byte for byte — so nothing about the already-proven single-attribute path
 * changes here.
 */
function sanitizeRuleName(attributeName: string, value: string): string {
  const raw = `${attributeName}_${value}_Rule`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  if (cleaned.length <= RULE_NAME_MAX_LENGTH) return cleaned;
  const digest = createHash("sha256").update(cleaned).digest("hex").slice(0, 10);
  const prefixBudget = RULE_NAME_MAX_LENGTH - 1 - digest.length; // reserve "_" + digest
  return `${cleaned.slice(0, prefixBudget)}_${digest}`;
}

/* ── Part G — attribute/product-attribute context, re-resolved fresh ── */
export interface AttributeContext {
  attributeDefinitionId: string | null;
  dataType: string | null;
  dataTypeSource: string | null;
  productAttributeDefinitionId: string | null;
  isPriceImpacting: boolean | null;
  /** §Live-org fix (Desktop) — the ProductClassificationAttr.Id this attribute inherits from, when it has
   * no direct ProductAttributeDefinition record on this product at all (a purely inherited attribute).
   * `null` for a DIRECT/OVERRIDE attribute (which already has its own `productAttributeDefinitionId`) or
   * when this org has no Product Classification inheritance configured. Threaded through so
   * `resolveBaseProductConfiguration` can still resolve a real, Salesforce-configured baseline value for
   * an attribute that has no product-level record to read a value from. */
  productClassificationAttrId: string | null;
  /** §Live-org fix (Desktop) — how this attribute became applicable to the product, mirroring the SAME
   * classification exposed by `discoverAttributes.ts`'s `DiscoveredAttribute.source`: DIRECT (a
   * product-level record with no classification-attr link), OVERRIDE (a product-level record that DOES
   * link back to a ProductClassificationAttr it supersedes), INHERITED (no product-level record at all —
   * applicable purely via Product Classification), or UNKNOWN (neither a product-level record nor a
   * resolvable classification source — e.g. this org has neither capability, or the attribute genuinely
   * isn't configured for this product at all). Downstream logic (price-impacting configuration) branches
   * on this instead of assuming every attribute always has a `productAttributeDefinitionId`. */
  source: "DIRECT" | "OVERRIDE" | "INHERITED" | "UNKNOWN";
}

export async function resolveAttributeContexts(
  client: SalesforceClient,
  productId: string,
  attributeNames: string[],
): Promise<Map<string, AttributeContext>> {
  const result = new Map<string, AttributeContext>();
  const uniqueNames = [...new Set(attributeNames)];
  if (uniqueNames.length === 0) return result;

  const adDescribe = await client.describeObject("AttributeDefinition");
  const adDataTypeField = resolveAttributeDataTypeSourceField(adDescribe).field;
  const adSelect = ["Id", "Name", ...(adDataTypeField ? [adDataTypeField.name] : [])];
  const adRes = await client.query<Record<string, unknown> & { Id: string; Name: string }>(
    `SELECT ${adSelect.join(", ")} FROM AttributeDefinition WHERE Name IN (${uniqueNames.map(n => `'${soqlEscape(n)}'`).join(",")})`,
  );
  const byName = new Map<string, { id: string; dataType: string | null }>();
  for (const rec of adRes.records) {
    byName.set(rec.Name, { id: rec.Id, dataType: adDataTypeField ? (rec[adDataTypeField.name] as string | undefined) ?? null : null });
  }

  const padDescribe = await client.describeObject("ProductAttributeDefinition");
  const padProductField = resolveReferenceField(padDescribe, "Product2").field;
  const padAttrDefField = resolveReferenceField(padDescribe, "AttributeDefinition").field;
  const padPriceImpactingField = resolvePriceImpactingField(padDescribe);
  const padDataTypeField = resolveAttributeDataTypeSourceField(padDescribe).field;
  // §Live-org fix (Desktop) — Salesforce's own OVERRIDE signal: a product-level record that references a
  // ProductClassificationAttr is an OVERRIDE of that inherited attribute; one with no such reference is a
  // genuinely DIRECT, product-specific attribute. Mirrors `discoverAttributes.ts`'s identical detection.
  const padClassificationLinkField = resolveClassificationAttrLinkField(padDescribe);

  const padByAttrDefId = new Map<string, { id: string; isPriceImpacting: boolean | null; dataType: string | null; isOverride: boolean }>();
  if (padProductField) {
    const padSelect = [
      "Id", ...(padAttrDefField ? [padAttrDefField.name] : []), ...(padPriceImpactingField ? [padPriceImpactingField.name] : []),
      ...(padDataTypeField ? [padDataTypeField.name] : []), ...(padClassificationLinkField ? [padClassificationLinkField.name] : []),
    ];
    const padRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${[...new Set(padSelect)].join(", ")} FROM ProductAttributeDefinition WHERE ${padProductField.name} = '${soqlEscape(productId)}' LIMIT 200`,
    );
    for (const rec of padRes.records) {
      const attrDefId = padAttrDefField ? (rec[padAttrDefField.name] as string | undefined) : undefined;
      if (!attrDefId) continue;
      const isOverride = padClassificationLinkField ? !!(rec[padClassificationLinkField.name] as string | undefined) : false;
      padByAttrDefId.set(attrDefId, {
        id: rec.Id,
        isPriceImpacting: padPriceImpactingField ? ((rec[padPriceImpactingField.name] as boolean | undefined) ?? null) : null,
        dataType: padDataTypeField ? (rec[padDataTypeField.name] as string | undefined) ?? null : null,
        isOverride,
      });
    }
  }

  // §Live-org fix (Desktop) — an attribute with NO direct ProductAttributeDefinition record can still be
  // genuinely applicable to this product purely via its Product Classification (Salesforce's own
  // "Inherited Attributes" — reachable even with zero "Overridden Inherited Attributes"). Resolved via the
  // SAME shared resolver `discoverAttributes.ts` uses, so the analyze-time and create-time attribute sets
  // can never disagree with each other.
  let classification: Awaited<ReturnType<typeof resolveProductClassificationInheritance>> = { supported: false, classificationId: null, rowsByAttributeDefinitionId: new Map() };
  try {
    classification = await resolveProductClassificationInheritance(client, productId);
  } catch (err) {
    client.logDebug("execution-trace", `resolveAttributeContexts — classification-inherited resolution failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const name of uniqueNames) {
    const ad = byName.get(name);
    const pad = ad ? padByAttrDefId.get(ad.id) : undefined;
    const classificationRow = ad ? classification.rowsByAttributeDefinitionId.get(ad.id) ?? null : null;
    // AttributeDefinition.DataType wins on precedence; ProductAttributeDefinition.DataType is the fallback — never silently merged.
    const dataType = ad?.dataType ?? pad?.dataType ?? null;
    const dataTypeSource = ad?.dataType ? "AttributeDefinition.DataType" : pad?.dataType ? "ProductAttributeDefinition.DataType" : null;
    // Direct/overridden price-impacting (this product's own record) takes precedence; a purely inherited
    // attribute (no PAD row at all) falls back to its classification-level price-impacting flag.
    const isPriceImpacting = pad ? pad.isPriceImpacting : classificationRow?.isPriceImpacting ?? null;
    const source: AttributeContext["source"] = pad
      ? (pad.isOverride ? "OVERRIDE" : "DIRECT")
      : (classificationRow ? "INHERITED" : "UNKNOWN");
    result.set(name, {
      attributeDefinitionId: ad?.id ?? null,
      dataType,
      dataTypeSource,
      productAttributeDefinitionId: pad?.id ?? null,
      isPriceImpacting,
      productClassificationAttrId: pad ? null : classificationRow?.id ?? null,
      source,
    });
  }
  return result;
}

/**
 * §Root-cause fix — Salesforce's own FIELD_INTEGRITY_EXCEPTION ("Associate all price impacting
 * attributes with the relevant Attribute Adjustment Condition and try again") means ALL price-impacting
 * attributes CONFIGURED ON THE PRODUCT, not merely the ones the current prompt/rules happen to mention.
 * A prior version of this pipeline scoped `contexts` (and therefore every condition/adjustment built from
 * it) to only the attributes referenced by `input.rules` — correct when a prompt happens to touch every
 * price-impacting attribute, but silently incomplete whenever it doesn't (e.g. a Product with 6
 * price-impacting attributes but a prompt that only varies 3 of them). This queries Salesforce directly
 * for the complete, authoritative set — never inferred from the prompt, never hardcoded — so the caller
 * can union it with the requested names before resolving contexts. Returns attribute NAMES (not a Map)
 * so the existing, already-tested `resolveAttributeContexts` remains the single place that builds
 * `AttributeContext` — this function only widens ITS input, it doesn't duplicate its resolution logic.
 */
export async function resolveAllPriceImpactingAttributeNames(
  client: SalesforceClient,
  productId: string,
  // §Request-efficiency fix — same rationale as `ensurePriceImpactingAttributes`'s `preDescribedPad`:
  // this function and that one both run unconditionally, back to back, in the SAME createPipeline.ts
  // execution, and both need a ProductAttributeDefinition Describe — sharing one fetch between them
  // instead of each independently re-describing the same object.
  preDescribedPad?: DescribeResult,
): Promise<string[]> {
  const padDescribe = preDescribedPad ?? await new SchemaCache(client).get("ProductAttributeDefinition");
  const padProductField = resolveReferenceField(padDescribe, "Product2").field;
  const padAttrDefField = resolveReferenceField(padDescribe, "AttributeDefinition").field;
  const padPriceImpactingField = resolvePriceImpactingField(padDescribe);

  const directAttrDefIds = new Set<string>();
  if (!padProductField || !padAttrDefField || !padPriceImpactingField) {
    client.logDebug(
      "execution-trace",
      `resolveAllPriceImpactingAttributeNames — cannot discover the DIRECT price-impacting attribute set for this org's schema ` +
      `(missing: ${[!padProductField && "Product2 lookup", !padAttrDefField && "AttributeDefinition lookup", !padPriceImpactingField && "price-impacting field"].filter(Boolean).join(", ")} on ProductAttributeDefinition) — falling back to classification-inherited attributes only.`,
    );
  } else {
    const padRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${padAttrDefField.name} FROM ProductAttributeDefinition WHERE ${padProductField.name} = '${soqlEscape(productId)}' AND ${padPriceImpactingField.name} = true`,
    );
    for (const r of padRes.records) {
      const id = r[padAttrDefField.name] as string | undefined;
      if (id) directAttrDefIds.add(id);
    }
  }

  // §Live-org fix (Desktop) — a product can have price-impacting attributes that are applicable PURELY
  // via its Product Classification, with zero direct ProductAttributeDefinition rows at all (Salesforce's
  // own "Inherited Attributes" reachable even with "Overridden Inherited Attributes = 0"). The direct-PAD
  // query above can never see these; unioned in here so the complete price-impacting set this product
  // actually has in Salesforce is never understated to only the directly-overridden subset.
  const classificationAttrDefIds = new Set<string>();
  try {
    const classification = await resolveProductClassificationInheritance(client, productId);
    for (const row of classification.rowsByAttributeDefinitionId.values()) {
      if (row.isPriceImpacting === true) classificationAttrDefIds.add(row.attributeDefinitionId);
    }
  } catch (err) {
    client.logDebug("execution-trace", `resolveAllPriceImpactingAttributeNames — classification-inherited resolution failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const attrDefIds = [...new Set([...directAttrDefIds, ...classificationAttrDefIds])];
  if (attrDefIds.length === 0) return [];

  const adRes = await client.query<{ Id: string; Name: string }>(
    `SELECT Id, Name FROM AttributeDefinition WHERE Id IN (${attrDefIds.map(id => `'${soqlEscape(id)}'`).join(",")})`,
  );
  const names = adRes.records.map(r => r.Name);
  client.logDebug(
    "execution-trace",
    `resolveAllPriceImpactingAttributeNames — this product has ${names.length} price-impacting attribute(s) configured in Salesforce (${directAttrDefIds.size} direct, ${classificationAttrDefIds.size} classification-inherited): [${names.join(", ")}]. Every Attribute-Based Adjustment built for this product must carry a condition for ALL of these, regardless of which ones the current request explicitly varies.`,
  );
  return names;
}

/**
 * §Live-org fix (Desktop) — the relationship fields a NEW product-scoped ProductAttributeDefinition
 * OVERRIDE record needs, resolved once via Describe and shared by every caller that might need to create
 * one (price-impacting configuration, default-value remediation) — so there is exactly one place that
 * decides whether this org's schema even supports creating an override, never a per-caller re-guess.
 */
export interface ProductAttributeDefinitionOverrideFields {
  padDescribe: DescribeResult;
  padProductField: DescribeField;
  padAttrDefField: DescribeField;
  padClassificationLinkField: DescribeField;
}

export async function resolveProductAttributeDefinitionOverrideFields(
  client: SalesforceClient,
  // §Request-efficiency fix — a caller that already has a fresh ProductAttributeDefinition Describe in
  // scope (e.g. `ensurePriceImpactingAttributes`'s per-attribute loop, which previously re-Described this
  // object once per attribute needing an override) passes it here instead of triggering another one.
  // Omitted entirely by callers with no Describe already in hand (unchanged behavior for them).
  preDescribed?: DescribeResult,
): Promise<{ fields: ProductAttributeDefinitionOverrideFields; missing: [] } | { fields: null; missing: string[] }> {
  const padDescribe = preDescribed ?? await new SchemaCache(client).get("ProductAttributeDefinition");
  const padProductField = resolveReferenceField(padDescribe, "Product2").field;
  const padAttrDefField = resolveReferenceField(padDescribe, "AttributeDefinition").field;
  const padClassificationLinkField = resolveClassificationAttrLinkField(padDescribe);
  const missing = [
    !padProductField && "a Product2 reference field", !padAttrDefField && "an AttributeDefinition reference field",
    !padClassificationLinkField && "a ProductClassificationAttr override-link reference field",
  ].filter((v): v is string => !!v);
  if (missing.length > 0) return { fields: null, missing };
  return { fields: { padDescribe, padProductField: padProductField!, padAttrDefField: padAttrDefField!, padClassificationLinkField: padClassificationLinkField! }, missing: [] };
}

/**
 * §Live-org fix (Desktop) — creates a NEW, product-SCOPED ProductAttributeDefinition override for a
 * purely classification-inherited attribute (no existing product-level record) — never a write to the
 * shared ProductClassificationAttr, which every other product using that classification also reads.
 * `extraFields` supplies whatever THIS caller specifically wants to set on the new record (e.g.
 * `{ [priceImpactingField.name]: true }` or `{ [defaultValueField.name]: value }`); the Product2/
 * AttributeDefinition/ProductClassificationAttr link fields are always included automatically. Shared by
 * `ensurePriceImpactingAttributes` and `setEffectiveAttributeDefaultValue` so both call sites build an
 * identically-shaped override record.
 */
export async function createProductAttributeDefinitionOverride(
  client: SalesforceClient,
  fields: ProductAttributeDefinitionOverrideFields,
  args: { productId: string; attributeDefinitionId: string; productClassificationAttrId: string; extraFields: Record<string, unknown>; stepName: string },
): Promise<string> {
  const payload: Record<string, unknown> = {
    [fields.padProductField.name]: args.productId,
    [fields.padAttrDefField.name]: args.attributeDefinitionId,
    [fields.padClassificationLinkField.name]: args.productClassificationAttrId,
    ...args.extraFields,
  };

  // §Live-org fix — Name is a genuinely common Salesforce-required field on this object; never
  // hardcoded, never sourced from prompt/UI text. Resolved fresh from the AttributeDefinition's OWN
  // authoritative Name (the exact record `args.attributeDefinitionId` already verifiably points to) —
  // only queried when this org's PAD schema actually exposes a createable "Name" field at all, and only
  // when the caller's own `extraFields` didn't already supply one.
  const padNameField = fields.padDescribe.fields.find(f => f.name === "Name" && f.createable);
  if (padNameField && payload[padNameField.name] === undefined) {
    const nameRes = await client.query<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM AttributeDefinition WHERE Id = '${soqlEscape(args.attributeDefinitionId)}' LIMIT 1`,
    ).catch(() => ({ records: [] as { Id: string; Name: string }[] }));
    const resolvedName = nameRes.records[0]?.Name;
    if (resolvedName) payload[padNameField.name] = resolvedName;
  }

  const resolvedLookups: ResolvedLookup[] = [
    { targetObject: "Product2", field: fields.padProductField, value: args.productId },
    { targetObject: "AttributeDefinition", field: fields.padAttrDefField, value: args.attributeDefinitionId },
    { targetObject: "ProductClassificationAttr", field: fields.padClassificationLinkField, value: args.productClassificationAttrId },
  ];
  return guardedCreate(client, "ProductAttributeDefinition", fields.padDescribe, payload, resolvedLookups, args.stepName);
}

/**
 * §Price-Impacting prerequisite — Salesforce rejects any Attribute-Based
 * Pricing rule for an attribute whose effective product-level association isn't
 * marked IsPriceImpacting. Runs BEFORE the Lookup Table (PriceAdjustmentSchedule)
 * stage, checking only the attributes actually referenced by `rules`
 * (never every discovered attribute) for this specific Product, and
 * automatically fixes+read-back-verifies a `false` value rather than just
 * detecting and failing.
 *
 * §Live-org fix (Desktop) — the effective price-impacting state's OWNING record depends on `ctx.source`
 * (resolved by `resolveAttributeContexts`, which already computed this exact "DIRECT / OVERRIDE /
 * INHERITED / UNKNOWN" read of the effective state):
 *   - DIRECT/OVERRIDE: a real ProductAttributeDefinition already exists on this product — UPDATE it
 *     in place (unchanged from before this fix; this is the Laptop/Monitor path).
 *   - INHERITED: NO product-level record exists at all — the attribute is only price-impacting-or-not at
 *     the shared ProductClassificationAttr level, which is NEVER written here (it is shared by every
 *     product using that classification; flipping it would silently change pricing behavior for every
 *     other product in that classification too). Instead, Salesforce's own supported mechanism — a NEW,
 *     product-SCOPED ProductAttributeDefinition OVERRIDE record, referencing both this product and the
 *     ProductClassificationAttr it overrides — is created, gated strictly on every required relationship
 *     field being Describe-resolved first (never a hardcoded field name, never a malformed record).
 *   - UNKNOWN: no product-level record AND no resolvable classification source — nothing safe to create;
 *     stops with a precise, actionable diagnostic (Part 7's "stop" branch), exactly as before this fix.
 * `client.updateRecord`/`createRecord`/read-back failures abort the whole run — the caller never proceeds
 * to lookup-table creation on a value that wasn't actually confirmed true in Salesforce.
 */
export async function ensurePriceImpactingAttributes(
  client: SalesforceClient,
  productId: string,
  requestedAttributeNames: string[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
  // §Request-efficiency fix — a caller running this in the same pipeline execution as
  // `resolveAllPriceImpactingAttributeNames` (which also needs a ProductAttributeDefinition Describe)
  // passes the ALREADY-FETCHED result here so this object is described at most once per pipeline run,
  // never twice for the same execution. Omitted entirely by standalone callers (unchanged behavior).
  preDescribedPad?: DescribeResult,
): Promise<Map<string, AttributeContext>> {
  const uniqueNames = [...new Set(requestedAttributeNames)];
  step(steps, "configure-price-impacting", "start", `Verifying ${uniqueNames.length} requested pricing attribute(s) are marked price-impacting for this product.`);

  const contexts = await resolveAttributeContexts(client, productId, uniqueNames);
  const padDescribe = preDescribedPad ?? await client.describeObject("ProductAttributeDefinition");
  const padPriceImpactingField = resolvePriceImpactingField(padDescribe);

  for (const attributeName of uniqueNames) {
    const ctx = contexts.get(attributeName);
    if (!ctx) {
      throw new Error(`Could not resolve attribute "${attributeName}" for this product while checking its price-impacting status.`);
    }

    step(steps, "configure-price-impacting", "info", [
      `→ Checking price-impacting state for ${attributeName}`,
      `  Effective source: ${ctx.source}`,
      `  Current IsPriceImpacting = ${ctx.isPriceImpacting === null ? "(unknown)" : ctx.isPriceImpacting}`,
      `  ${ctx.productAttributeDefinitionId ? `Product-level record: ${ctx.productAttributeDefinitionId}` : ctx.productClassificationAttrId ? `Classification-level record: ${ctx.productClassificationAttrId} (no product-level record)` : "No product-level or classification-level record resolved"}`,
    ].join("\n"));

    if (ctx.isPriceImpacting === true) {
      step(steps, "configure-price-impacting", "success", `✓ ${attributeName} is already price impacting.`);
      onProgress?.(`✓ ${attributeName} is already price impacting.`);
      continue;
    }

    if (ctx.isPriceImpacting === null) {
      // No product-level record, no classification source, or no recognizable price-impacting field on
      // this org's schema — nothing to check or fix; Salesforce itself will be the final arbiter at create time.
      step(steps, "configure-price-impacting", "info", `Could not determine "${attributeName}"'s price-impacting status on this product — proceeding without changing it.`);
      onProgress?.(`Could not determine "${attributeName}"'s price-impacting status — proceeding without changing it.`);
      continue;
    }

    // ctx.isPriceImpacting === false
    if (ctx.productAttributeDefinitionId) {
      // DIRECT or OVERRIDE — a real product-level record already exists; update it in place (unchanged path).
      if (!padPriceImpactingField) {
        throw new Error(
          `Attribute "${attributeName}" is not marked price-impacting on this product, and it could not be automatically corrected ` +
          `(no price-impacting field discovered on ProductAttributeDefinition for this org). Mark it price-impacting in Setup and try again.`,
        );
      }
      step(steps, "configure-price-impacting", "start", `Marking "${attributeName}" as price impacting (currently false, source=${ctx.source}, record=${ctx.productAttributeDefinitionId}).`);
      onProgress?.(`Marking "${attributeName}" as price impacting…`);
      try {
        await client.updateRecord("ProductAttributeDefinition", ctx.productAttributeDefinitionId, { [padPriceImpactingField.name]: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step(steps, "configure-price-impacting", "error", `Failed to mark "${attributeName}" as price impacting: ${message}`);
        throw new Error(`Could not mark "${attributeName}" as price impacting: ${message}`);
      }
      step(steps, "configure-price-impacting", "success", `✓ Marked ${attributeName} as price impacting.`);
      onProgress?.(`✓ Marked ${attributeName} as price impacting.`);

      const verifyRes = await client.query<Record<string, unknown> & { Id: string }>(
        `SELECT Id, ${padPriceImpactingField.name} FROM ProductAttributeDefinition WHERE Id = '${soqlEscape(ctx.productAttributeDefinitionId)}' LIMIT 1`,
      );
      const verifiedValue = verifyRes.records[0]?.[padPriceImpactingField.name];
      if (verifiedValue !== true) {
        step(steps, "configure-price-impacting", "error", `Salesforce read-back for "${attributeName}" did not confirm price-impacting = true (got ${JSON.stringify(verifiedValue)}).`);
        throw new Error(`Salesforce read-back could not confirm "${attributeName}" was marked price impacting — refusing to continue to lookup-table creation.`);
      }
      step(steps, "configure-price-impacting", "success", `✓ Verified ${attributeName} price impacting via Salesforce read-back.`);
      onProgress?.(`✓ Verified ${attributeName} price impacting via Salesforce read-back.`);
      ctx.isPriceImpacting = true; // keep the in-memory context consistent for any later re-check this same run.
      continue;
    }

    // No product-level record at all. If there's also no resolvable Product Classification source, there
    // is genuinely nothing to correct — never guessed, never fabricated.
    if (!ctx.productClassificationAttrId) {
      throw new Error(
        `Attribute "${attributeName}" is not marked price-impacting on this product, and it could not be automatically corrected ` +
        `(no Product Attribute Definition record exists for this product, and it is not resolvable as a Product Classification-inherited attribute either). ` +
        `Mark it price-impacting in Setup and try again.`,
      );
    }

    // §Live-org fix (Desktop) — INHERITED and not price-impacting at the classification level. Salesforce's
    // supported, non-shared mechanism is a product-SCOPED override record — never a write to the shared
    // ProductClassificationAttr itself, which every other product using that classification also reads.
    // Only attempted when every required relationship field is Describe-confirmed to exist on this org's
    // ProductAttributeDefinition schema; otherwise this stops with a precise diagnostic (Part 7's "stop"
    // branch) rather than creating a malformed or ambiguous record.
    if (!padPriceImpactingField || !ctx.attributeDefinitionId) {
      throw new Error(
        `Attribute "${attributeName}" is inherited from this product's Product Classification and is not price-impacting there. ` +
        `This org's ProductAttributeDefinition schema does not expose ${[!padPriceImpactingField && "a price-impacting field", !ctx.attributeDefinitionId && "a resolved AttributeDefinition Id"].filter(Boolean).join(", ")}, so a product-scoped override cannot be safely created. ` +
        `In Salesforce Setup, either create a Product Attribute Definition override for this product with Is Price Impacting checked, ` +
        `or mark this attribute price-impacting on the Product Classification directly (note: that affects every product sharing that classification).`,
      );
    }
    const overrideFields = await resolveProductAttributeDefinitionOverrideFields(client, padDescribe);
    if (!overrideFields.fields) {
      throw new Error(
        `Attribute "${attributeName}" is inherited from this product's Product Classification and is not price-impacting there. ` +
        `This org's ProductAttributeDefinition schema does not expose ${overrideFields.missing.join(", ")}, so a product-scoped override cannot be safely created. ` +
        `In Salesforce Setup, either create a Product Attribute Definition override for this product with Is Price Impacting checked, ` +
        `or mark this attribute price-impacting on the Product Classification directly (note: that affects every product sharing that classification).`,
      );
    }

    step(steps, "configure-price-impacting", "info", [
      `→ ${attributeName} is inherited and not price-impacting at the classification level`,
      `→ Salesforce requires product-level override`,
      `→ Creating/resolving supported override dynamically`,
    ].join("\n"));
    onProgress?.(`Creating a price-impacting override for "${attributeName}" (inherited attribute)…`);

    let overrideId: string;
    try {
      overrideId = await createProductAttributeDefinitionOverride(client, overrideFields.fields, {
        productId, attributeDefinitionId: ctx.attributeDefinitionId, productClassificationAttrId: ctx.productClassificationAttrId,
        extraFields: { [padPriceImpactingField.name]: true }, stepName: "configure-price-impacting",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      step(steps, "configure-price-impacting", "error", `Failed to create a price-impacting override for "${attributeName}": ${message}`);
      throw new Error(
        `Attribute "${attributeName}" is inherited and not price-impacting, and creating a Product Attribute Definition override for it failed: ${message}. ` +
        `Never modified the shared Product Classification — only a new, product-scoped override was attempted.`,
      );
    }
    step(steps, "configure-price-impacting", "success", `✓ Override created/resolved: ${overrideId}.`);

    const verifyRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT Id, ${padPriceImpactingField!.name} FROM ProductAttributeDefinition WHERE Id = '${soqlEscape(overrideId)}' LIMIT 1`,
    );
    const verifiedValue = verifyRes.records[0]?.[padPriceImpactingField!.name];
    if (verifiedValue !== true) {
      step(steps, "configure-price-impacting", "error", `Salesforce read-back for "${attributeName}"'s new override (${overrideId}) did not confirm price-impacting = true (got ${JSON.stringify(verifiedValue)}).`);
      throw new Error(`Salesforce read-back could not confirm the new override for "${attributeName}" was price impacting — refusing to continue to lookup-table creation.`);
    }
    step(steps, "configure-price-impacting", "success", `✓ Effective IsPriceImpacting = true for ${attributeName} (via override ${overrideId}).`);
    onProgress?.(`✓ Created a price-impacting override for "${attributeName}".`);
    // Keep the in-memory context consistent for any later re-check this same run — this attribute now has
    // a real product-level record (the override just created), so it is no longer purely INHERITED.
    ctx.isPriceImpacting = true;
    ctx.productAttributeDefinitionId = overrideId;
    ctx.source = "OVERRIDE";
  }

  step(steps, "configure-price-impacting", "success", "All requested pricing attributes are confirmed price impacting.");
  return contexts;
}

/* ── Part G — create any genuinely-missing attribute values first ── */
/**
 * §Issue 2 — reports every attribute value this run actually processed, not just the ones on the
 * "create new value" path. A row already known to exist (`isNewValue === false`) still counts as
 * `reused`, with its real AttributePicklistValue Id re-confirmed via Salesforce (never fabricated) —
 * the old version only ever populated `reused` as a side effect of the create-new loop, so an
 * all-existing-values run always reported "0 created, 0 reused" despite genuinely resolving every
 * value. Deduplicated by actual attribute-value identity first: the SAME (attribute, value) pair
 * referenced by more than one pricing rule is still exactly one Salesforce record, counted once.
 */
export async function createMissingValues(
  client: SalesforceClient,
  productId: string,
  rules: PricingRulePlanRow[],
  steps: ProcedureStepLite[],
): Promise<{ created: CreatedValueRecord[]; reused: CreatedValueRecord[] }> {
  const created: CreatedValueRecord[] = [];
  const reused: CreatedValueRecord[] = [];

  const seen = new Set<string>();
  const dedupedRows: PricingRulePlanRow[] = [];
  for (const row of rules) {
    const key = `${row.attributeName}::${row.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedRows.push(row);
  }
  if (dedupedRows.length === 0) {
    step(steps, "create-values", "info", "No attribute values to process.");
    return { created, reused };
  }

  const newRows = dedupedRows.filter(r => r.isNewValue);
  const existingRows = dedupedRows.filter(r => !r.isNewValue);
  step(steps, "create-values", "start", `Resolving ${dedupedRows.length} unique attribute value(s) — ${newRows.length} new, ${existingRows.length} already existing.`);

  const attrNames = [...new Set(dedupedRows.map(r => r.attributeName))];
  const contexts = await resolveAttributeContexts(client, productId, attrNames);

  // Resolve each attribute's real picklist ONCE and read back its actual existing values — never
  // assumed from the analysis-time label alone — so every already-existing row gets its real,
  // read-back-confirmed AttributePicklistValue Id (needed by the later Salesforce verification step).
  const picklistIdByAttr = new Map<string, string | null>();
  const existingValuesByAttr = new Map<string, { id: string; value: string; label: string }[]>();
  for (const attrName of attrNames) {
    const ctx = contexts.get(attrName);
    const picklistId = ctx ? await resolveAttributePicklistId(client, ctx.attributeDefinitionId, ctx.productAttributeDefinitionId) : null;
    picklistIdByAttr.set(attrName, picklistId);
    if (!picklistId) continue;
    const res = await client.query<{ Id: string; Value?: string; DisplayValue?: string; Name?: string }>(
      `SELECT Id, Value, DisplayValue, Name FROM AttributePicklistValue WHERE PicklistId = '${soqlEscape(picklistId)}'`,
    ).catch(() => ({ records: [] as { Id: string; Value?: string; DisplayValue?: string; Name?: string }[] }));
    existingValuesByAttr.set(attrName, res.records.map(r => ({ id: r.Id, value: r.Value ?? r.DisplayValue ?? r.Name ?? r.Id, label: r.DisplayValue ?? r.Value ?? r.Name ?? r.Id })));
  }

  for (const row of existingRows) {
    const candidates = existingValuesByAttr.get(row.attributeName) ?? [];
    const norm = row.value.toLowerCase();
    const match = candidates.find(c => c.value.toLowerCase() === norm || c.label.toLowerCase() === norm);
    if (match) {
      reused.push({ attributeName: row.attributeName, value: row.value, id: match.id });
    } else {
      client.logDebug(
        "execution-trace",
        `Attribute value "${row.attributeName}" = "${row.value}" was determined to already exist during analysis, but its real AttributePicklistValue Id could not be re-confirmed on this org (non-standard value source) — excluded from the reused count rather than reporting a fabricated Id.`,
      );
    }
  }

  for (const row of newRows) {
    const ctx = contexts.get(row.attributeName);
    if (!ctx) throw new Error(`Could not re-resolve attribute "${row.attributeName}" in Salesforce — it may have been renamed or removed since validation.`);
    const picklistId = picklistIdByAttr.get(row.attributeName) ?? null;
    if (!picklistId) {
      throw new Error(
        `Cannot create the new value "${row.value}" for attribute "${row.attributeName}" — this attribute's values don't come from the standard AttributePicklistValue object on this org, and creating a value on an unknown custom object would require guessing its fields. Create this value manually in Salesforce Setup, then try again.`,
      );
    }
    const outcome = await createMissingAttributeValue(client, picklistId, row.value);
    if (outcome.status === "unsupported") throw new Error(outcome.reason);
    if (outcome.status === "created") created.push({ attributeName: row.attributeName, value: row.value, id: outcome.id });
    else reused.push({ attributeName: row.attributeName, value: row.value, id: outcome.id });
  }

  step(steps, "create-values", "success", `${created.length} value(s) created, ${reused.length} already existed and were reused.`);
  return { created, reused };
}

/* ── Part H/I — datatype-safe Condition value assignment ── */
interface ConditionValueAssignment {
  fieldName: string;
  value: unknown;
  dataTypeField?: { name: string; value: string };
}

function resolveConditionValueAssignment(
  conditionDescribe: DescribeResult,
  attributeName: string,
  dataType: string | null,
  dataTypeSource: string | null,
  rawValue: string,
): ConditionValueAssignment {
  const kind: ValueKind = classifyAttributeDataType(dataType);
  if (kind === "unknown") {
    throw new Error(
      `Cannot determine a confident data type for attribute "${attributeName}" (raw value: ${JSON.stringify(dataType)}${dataTypeSource ? `, source: ${dataTypeSource}` : ", no DataType field found on AttributeDefinition or ProductAttributeDefinition"}) — refusing to guess which AttributeAdjustmentCondition field to populate.`,
    );
  }
  const resolved = resolveTypedValueField(conditionDescribe, kind);
  if (!resolved.field) {
    throw new Error(`AttributeAdjustmentCondition has no field matching data type "${kind}" for attribute "${attributeName}" — cannot populate a typed value without guessing a field name.`);
  }
  if (kind === "boolean" && !/^(true|false)$/i.test(rawValue)) {
    throw new Error(`Attribute "${attributeName}" resolved to Boolean, but its value "${rawValue}" isn't literally "True" or "False" — refusing to send a non-boolean string into ${resolved.field.name}.`);
  }
  const value = convertValueForField(rawValue, kind, resolved.field);
  const dtField = resolveDataTypeField(conditionDescribe, kind);
  return {
    fieldName: resolved.field.name,
    value,
    dataTypeField: dtField.field && dtField.value ? { name: dtField.field.name, value: dtField.value } : undefined,
  };
}

/* ── guarded create: never trust a create response's Id alone ── */
async function guardedCreate(
  client: SalesforceClient,
  objectName: string,
  describe: DescribeResult,
  payload: Record<string, unknown>,
  resolvedLookups: ResolvedLookup[],
  stepName: string,
): Promise<string> {
  fillRequiredPicklistDefaults(describe, payload);
  const { missingFields } = logObjectCreation(client, objectName, { describe, payload, resolvedLookups });
  if (missingFields.length > 0) {
    const diagnosis = buildSchemaDiagnosis(objectName, describe, payload, resolvedLookups);
    logSchemaDiagnosis(client, describe, diagnosis);
    throw new Error(`${objectName} is missing required field(s): ${missingFields.join(", ")}. See server logs for the full schema diagnosis.`);
  }

  let created: { id: string };
  try {
    created = await client.createRecord(objectName, payload);
  } catch (err) {
    if (err instanceof SalesforceError) {
      const fields = extractSalesforceFields(err.body);
      const diagnosis = diagnoseCreateRejection(objectName, describe, payload, err.errorCode ?? null, err.message, fields);
      client.logDebug("native-create-response", formatCreateRejectionDiagnosis(diagnosis));
    }
    throw err;
  }

  const verified = await verifyRecordExists(client, objectName, created.id);
  if (!verified) {
    throw new Error(`${objectName} ${created.id} was reported as created, but querying it back found no matching record — treating this as a failed create rather than trusting the REST response alone (step: ${stepName}).`);
  }
  client.logDebug("native-create-response", `${objectName} ${created.id} created and verified via read-back.`);
  return created.id;
}

/**
 * Parts 9-10 — broadly discover every existing PriceAdjustmentSchedule for
 * this Product (never filtered by a guessed name/WHERE key) and log a
 * field-by-field comparison against the payload this run is about to
 * create, exactly like the AttributeBasedAdjustment duplicate-detection
 * fix. A record only counts as reusable when every one of `compareFields`
 * (Product/Selling Model/Schedule Type/Adjustment Method — the fields that
 * actually determine whether it's the *same logical* Decision Table, not
 * incidental ones like dates) matches; sharing a Name is never sufficient
 * on its own (Part 10).
 */
async function findCompatiblePriceAdjustmentSchedule(
  client: SalesforceClient,
  productId: string,
  productFieldName: string | null,
  proposedPayload: Record<string, unknown>,
  compareFields: string[],
  isActiveFieldName: string | null,
): Promise<{ compatibleId: string | null; compatibleIsActive: boolean | null; existingNames: Set<string> }> {
  const selectFields = ["Id", "Name", ...new Set(compareFields), ...(isActiveFieldName ? [isActiveFieldName] : [])];
  const soql = productFieldName
    ? `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule WHERE ${productFieldName} = '${soqlEscape(productId)}'`
    : `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule LIMIT 200`;
  client.logDebug("native-create-request", `Decision Table discovery — querying every existing PriceAdjustmentSchedule ${productFieldName ? `for Product ${productId}` : "(no Product2 lookup discovered on this org's schema — querying broadly instead)"} (never a guessed name filter): ${soql}`);

  let records: (Record<string, unknown> & { Id: string; Name: string })[] = [];
  try {
    records = (await client.query<Record<string, unknown> & { Id: string; Name: string }>(soql)).records;
  } catch (err) {
    client.logDebug("native-create-request", `Decision Table discovery query failed (falling back to "no compatible table found"): ${err instanceof Error ? err.message : String(err)}`);
    return { compatibleId: null, compatibleIsActive: null, existingNames: new Set() };
  }

  client.logDebug("native-create-request", [
    `Decision Table discovery — ${records.length} existing record(s) found for Product ${productId}.`,
    "Payload about to be created:",
    JSON.stringify(proposedPayload, null, 2),
  ].join("\n"));

  let compatibleId: string | null = null;
  let compatibleIsActive: boolean | null = null;
  for (const rec of records) {
    const rows: string[] = [];
    let allMatch = true;
    for (const fieldName of compareFields) {
      const existingValue = rec[fieldName] != null ? String(rec[fieldName]) : null;
      const proposedValue = proposedPayload[fieldName] != null ? String(proposedPayload[fieldName]) : null;
      const isMatch = existingValue === proposedValue;
      if (!isMatch) allMatch = false;
      rows.push(`  ${fieldName}: existing="${existingValue ?? "(null)"}" vs proposed="${proposedValue ?? "(null)"}" -> ${isMatch ? "MATCH" : "DIFFERENT"}`);
    }
    if (isActiveFieldName) rows.push(`  ${isActiveFieldName}: ${rec[isActiveFieldName] === true ? "true" : rec[isActiveFieldName] === false ? "false" : "(unknown)"}`);
    client.logDebug("native-create-request", [`Decision Table compatibility check — record ${rec.Id} ("${rec.Name}"):`, ...rows].join("\n"));
    if (allMatch && !compatibleId) {
      compatibleId = rec.Id;
      compatibleIsActive = isActiveFieldName ? rec[isActiveFieldName] === true : null;
    }
  }

  if (compatibleId) {
    client.logDebug("native-create-request", `Decision Table compatibility check — record ${compatibleId} matches on every comparable field and will be reused.` +
      (isActiveFieldName ? ` IsActive=${compatibleIsActive}.` : ""));
  } else if (records.length > 0) {
    client.logDebug("native-create-request", `Decision Table compatibility check — none of ${records.length} existing record(s) are structurally compatible; a new one will be created with a verified-unique name.`);
  }

  return { compatibleId, compatibleIsActive, existingNames: new Set(records.map(r => r.Name)) };
}

/**
 * Part 11 — `baseName` if it doesn't already exist, otherwise `baseName (2)`,
 * `baseName (3)`, etc. against the org's own real existing names (never a
 * guessed suffix scheme), truncated to Salesforce's 80-char Name limit.
 */
function generateUniqueScheduleName(baseName: string, existingNames: Set<string>, maxLength = 80): string {
  if (!existingNames.has(baseName)) return baseName;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const tag = ` (${suffix})`;
    const candidate = `${baseName.slice(0, Math.max(0, maxLength - tag.length))}${tag}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  throw new Error(`Could not generate a unique Decision Table name from base "${baseName}" — over 1000 colliding names already exist for this product.`);
}

/* ── Part I — the native Attribute-Based Pricing records, split into 4 sequential phases so each
 * gets its own progress row / failure attribution instead of one monolithic "create-lookup-table"
 * step. Every relationship between these 4 objects is discovered fresh via Describe every run —
 * NEVER assumed from the object names or from what a previous org happened to expose. ── */
export interface NativeCreationResult {
  scheduleId: string;
  ruleIds: string[];
  conditionIds: string[];
  adjustmentIds: string[];
}

export interface AttributeBasedPricingSchema {
  ruleDescribe: DescribeResult;
  conditionDescribe: DescribeResult;
  abaDescribe: DescribeResult;
  ruleProductField: ReferenceFieldResolution;
  ruleScheduleField: ReferenceFieldResolution;
  ruleActiveField: DescribeField | null;
  ruleEffFromField: DescribeField | null;
  ruleEffToField: DescribeField | null;
  conditionRuleField: ReferenceFieldResolution;
  conditionPadField: ReferenceFieldResolution;
  conditionAttrDefField: ReferenceFieldResolution;
  conditionProductField: ReferenceFieldResolution;
  conditionOperatorField: DescribeField | null;
  abaProductField: ReferenceFieldResolution;
  abaSellingModelField: ReferenceFieldResolution;
  abaRuleField: ReferenceFieldResolution;
  abaScheduleField: ReferenceFieldResolution;
  abaConditionField: DescribeField | null;
  abaTypeField: DescribeField | null;
  abaValueField: DescribeField | null;
  abaEffFromField: DescribeField | null;
  abaEffToField: DescribeField | null;
}

function refDesc(res: ReferenceFieldResolution): string {
  return res.field ? res.field.name : "NOT FOUND";
}

/** §Diagnostics (Part 13) — the actual discovered relationship graph, never inferred from object names. */
function logAttributeBasedPricingSchemaGraph(client: SalesforceClient, s: AttributeBasedPricingSchema): void {
  client.logDebug("native-create-request", [
    "Salesforce Attribute-Based Pricing schema — relationships discovered via Describe (never assumed from object names):",
    "",
    "AttributeBasedAdjRule",
    `  --> Product2: ${refDesc(s.ruleProductField)}`,
    `  --> PriceAdjustmentSchedule: ${refDesc(s.ruleScheduleField)}`,
    "",
    "AttributeAdjustmentCondition",
    `  --> AttributeBasedAdjRule: ${refDesc(s.conditionRuleField)}`,
    `  --> ProductAttributeDefinition: ${refDesc(s.conditionPadField)}`,
    `  --> AttributeDefinition: ${refDesc(s.conditionAttrDefField)}`,
    `  --> Product2: ${refDesc(s.conditionProductField)}`,
    "",
    "AttributeBasedAdjustment",
    `  --> Product2: ${refDesc(s.abaProductField)}`,
    `  --> ProductSellingModel: ${refDesc(s.abaSellingModelField)}`,
    `  --> AttributeBasedAdjRule: ${refDesc(s.abaRuleField)}`,
    `  --> PriceAdjustmentSchedule: ${refDesc(s.abaScheduleField)}`,
    `  --> AttributeAdjustmentCondition: ${s.abaConditionField ? s.abaConditionField.name : "NOT FOUND"}`,
    "",
    "Resolved connection model: " + (s.ruleScheduleField.field
      ? "AttributeBasedAdjRule references PriceAdjustmentSchedule directly on this org."
      : "AttributeBasedAdjRule has NO direct reference to PriceAdjustmentSchedule on this org — the Schedule/Rule/Condition relationship is established entirely through AttributeBasedAdjustment's own Rule + Schedule + Condition lookups instead. This is expected and handled, not an error."),
  ].join("\n"));
}

/** §Read-only investigation (Part 3) — inspect existing records for this product before creating anything; never modified here. */
async function inspectExistingAttributeBasedPricingRecords(client: SalesforceClient, productId: string, s: AttributeBasedPricingSchema): Promise<void> {
  try {
    const ruleSelect = ["Id", "Name", ...(s.ruleScheduleField.field ? [s.ruleScheduleField.field.name] : [])];
    const ruleWhere = s.ruleProductField.field ? ` WHERE ${s.ruleProductField.field.name} = '${soqlEscape(productId)}'` : "";
    const rules = await client.query<Record<string, unknown> & { Id: string; Name: string }>(
      `SELECT ${ruleSelect.join(", ")} FROM AttributeBasedAdjRule${ruleWhere} LIMIT 5`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string; Name: string })[] }));

    const abaSelect = ["Id",
      ...(s.abaScheduleField.field ? [s.abaScheduleField.field.name] : []),
      ...(s.abaRuleField.field ? [s.abaRuleField.field.name] : []),
      ...(s.abaConditionField ? [s.abaConditionField.name] : []),
    ];
    const abaWhere = s.abaProductField.field ? ` WHERE ${s.abaProductField.field.name} = '${soqlEscape(productId)}'` : "";
    const adjustments = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${abaSelect.join(", ")} FROM AttributeBasedAdjustment${abaWhere} LIMIT 5`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));

    client.logDebug("native-create-request", [
      `Existing Attribute-Based Pricing records for this Product (read-only — nothing modified or cloned): ${rules.records.length} AttributeBasedAdjRule, ${adjustments.records.length} AttributeBasedAdjustment found.`,
      rules.records.length > 0
        ? `Rules:\n${rules.records.map(r => `  ${r.Id} "${r.Name}"${s.ruleScheduleField.field ? ` Schedule=${r[s.ruleScheduleField.field.name] ?? "(none)"}` : ""}`).join("\n")}`
        : "",
      adjustments.records.length > 0
        ? `Adjustments:\n${adjustments.records.map(a => `  ${a.Id}` +
            (s.abaScheduleField.field ? ` Schedule=${a[s.abaScheduleField.field.name] ?? "(none)"}` : "") +
            (s.abaRuleField.field ? ` Rule=${a[s.abaRuleField.field.name] ?? "(none)"}` : "") +
            (s.abaConditionField ? ` Condition=${a[s.abaConditionField.name] ?? "(none)"}` : "")).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n"));
  } catch (err) {
    client.logDebug("native-create-request", `Existing Attribute-Based Pricing record inspection failed (non-fatal, read-only step): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolves every AttributeBasedAdjRule/AttributeAdjustmentCondition/AttributeBasedAdjustment
 * relationship fresh via Describe, logs the full discovered graph plus a read-only sample of
 * existing records for this product (Parts 3/13), then hard-fails with the actual discovered
 * metadata (never a guessed field) if a truly required relationship is missing.
 */
export async function prepareAttributeBasedAdjustmentSchema(
  client: SalesforceClient,
  productId: string,
): Promise<AttributeBasedPricingSchema> {
  const schemaCache = new SchemaCache(client);
  const [ruleDescribe, conditionDescribe, abaDescribe] = await Promise.all([
    schemaCache.get("AttributeBasedAdjRule"),
    schemaCache.get("AttributeAdjustmentCondition"),
    schemaCache.get("AttributeBasedAdjustment"),
  ]);

  let abaConditionField = resolveReferenceField(abaDescribe, "AttributeAdjustmentCondition").field;
  if (!abaConditionField) abaConditionField = abaDescribe.fields.find(f => f.type === "reference" && /attribute.?condition/i.test(f.name)) ?? null;

  const schema: AttributeBasedPricingSchema = {
    ruleDescribe, conditionDescribe, abaDescribe,
    ruleProductField: resolveReferenceField(ruleDescribe, "Product2"),
    ruleScheduleField: resolveReferenceField(ruleDescribe, "PriceAdjustmentSchedule"),
    ruleActiveField: ruleDescribe.fields.find(f => /^IsActive$/i.test(f.name)) ?? null,
    ruleEffFromField: ruleDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name)) ?? null,
    ruleEffToField: ruleDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name)) ?? null,
    conditionRuleField: resolveReferenceField(conditionDescribe, "AttributeBasedAdjRule"),
    conditionPadField: resolveReferenceField(conditionDescribe, "ProductAttributeDefinition"),
    conditionAttrDefField: resolveReferenceField(conditionDescribe, "AttributeDefinition"),
    conditionProductField: resolveReferenceField(conditionDescribe, "Product2"),
    conditionOperatorField: conditionDescribe.fields.find(f => /^Operator$/i.test(f.name) && f.type === "picklist") ?? null,
    abaProductField: resolveReferenceField(abaDescribe, "Product2"),
    abaSellingModelField: resolveReferenceField(abaDescribe, "ProductSellingModel"),
    abaRuleField: resolveReferenceField(abaDescribe, "AttributeBasedAdjRule"),
    abaScheduleField: resolveReferenceField(abaDescribe, "PriceAdjustmentSchedule"),
    abaConditionField,
    abaTypeField: abaDescribe.fields.find(f => /^(AdjustmentType|PriceAdjustmentType)$/i.test(f.name) && f.type === "picklist") ?? null,
    abaValueField: abaDescribe.fields.find(f => /^(AdjustmentValue|Amount)$/i.test(f.name)) ?? null,
    abaEffFromField: abaDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name)) ?? null,
    abaEffToField: abaDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name)) ?? null,
  };

  logAttributeBasedPricingSchemaGraph(client, schema);
  await inspectExistingAttributeBasedPricingRecords(client, productId, schema);

  if (!schema.conditionRuleField.field) {
    throw new Error(
      "Salesforce schema does not expose the required relationship for Attribute-Based Pricing in this org.\n\n" +
      "Expected relationship: AttributeAdjustmentCondition must have a lookup field to AttributeBasedAdjRule.\n\n" +
      "Discovered metadata: AttributeAdjustmentCondition has no reference field pointing to AttributeBasedAdjRule. See the schema graph logged above.",
    );
  }
  if (!schema.abaRuleField.field) {
    throw new Error(
      "Salesforce schema does not expose the required relationship for Attribute-Based Pricing in this org.\n\n" +
      "Expected relationship: AttributeBasedAdjustment must have a lookup field to AttributeBasedAdjRule.\n\n" +
      "Discovered metadata: AttributeBasedAdjustment has no reference field pointing to AttributeBasedAdjRule. See the schema graph logged above.",
    );
  }
  if (!schema.abaScheduleField.field && !schema.ruleScheduleField.field) {
    throw new Error(
      "Salesforce schema does not expose the required relationship for Attribute-Based Pricing in this org.\n\n" +
      "Expected relationship: either AttributeBasedAdjRule or AttributeBasedAdjustment must have a lookup field to PriceAdjustmentSchedule.\n\n" +
      "Discovered metadata: neither object has a reference field pointing to PriceAdjustmentSchedule. See the schema graph logged above.",
    );
  }

  return schema;
}

/* ── Phase: Price Adjustment Schedule (Parts 9-14 Decision Table discovery/compatibility/unique-name creation — unchanged from the prior fix). ── */
export async function resolveOrCreatePriceAdjustmentSchedule(
  client: SalesforceClient,
  args: { product: { id: string; name: string }; sellingModelId: string | null; procedureName: string },
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<string> {
  step(steps, "create-schedule", "start", "Resolving or creating the Price Adjustment Schedule.");
  const pasDescribe = await new SchemaCache(client).get("PriceAdjustmentSchedule");

  const scheduleBaseName = `${args.procedureName} Attr Schedule`.slice(0, 80);
  const productField = resolveReferenceField(pasDescribe, "Product2");
  const sellingModelField = resolveReferenceField(pasDescribe, "ProductSellingModel");
  const pricebookField = resolveReferenceField(pasDescribe, "Pricebook2");
  const scheduleTypeField = pasDescribe.fields.find(f => /^ScheduleType$/i.test(f.name) && f.type === "picklist");
  const adjustmentMethodField = pasDescribe.fields.find(f => /^AdjustmentMethod$/i.test(f.name) && f.type === "picklist");
  const effFromField = pasDescribe.fields.find(f => /^(EffectiveFrom|StartDate)$/i.test(f.name));
  const effToField = pasDescribe.fields.find(f => /^(EffectiveTo|EndDate)$/i.test(f.name));

  const payload: Record<string, unknown> = { Name: scheduleBaseName };
  const resolvedLookups: ResolvedLookup[] = [];
  if (productField.field) { payload[productField.field.name] = args.product.id; resolvedLookups.push({ targetObject: "Product2", field: productField.field, value: args.product.id }); }
  if (sellingModelField.field && args.sellingModelId) { payload[sellingModelField.field.name] = args.sellingModelId; resolvedLookups.push({ targetObject: "ProductSellingModel", field: sellingModelField.field, value: args.sellingModelId }); }
  if (pricebookField.field) {
    const pb = await client.query<{ Id: string }>(`SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1`);
    if (pb.records[0]) { payload[pricebookField.field.name] = pb.records[0].Id; resolvedLookups.push({ targetObject: "Pricebook2", field: pricebookField.field, value: pb.records[0].Id }); }
  }
  if (scheduleTypeField) {
    const active = (scheduleTypeField.picklistValues ?? []).filter(v => v.active);
    const value = active.find(v => /attribute/i.test(v.value) || /attribute/i.test(v.label))?.value ?? active[0]?.value ?? resolveDefaultPicklistValue(scheduleTypeField);
    if (value) payload[scheduleTypeField.name] = value;
  }
  if (adjustmentMethodField) {
    const active = (adjustmentMethodField.picklistValues ?? []).filter(v => v.active);
    const value = active.find(v => /attribute/i.test(v.value) || /attribute/i.test(v.label))?.value
      ?? active.find(v => !/range|slab|tier|volume/i.test(v.value) && !/range|slab|tier|volume/i.test(v.label))?.value
      ?? active[0]?.value ?? resolveDefaultPicklistValue(adjustmentMethodField);
    if (value) payload[adjustmentMethodField.name] = value;
  }
  if (effFromField) payload[effFromField.name] = todayISO();
  if (effToField) payload[effToField.name] = oneYearFromTodayISO();
  // Deliberately never sets IsActive on create — attribute-type PAS records on some orgs spuriously
  // fail validation ("no price adjustment tier") when active on create.
  const isActiveField = pasDescribe.fields.find(f => /^IsActive$/i.test(f.name) && f.type === "boolean") ?? null;

  const scheduleCompareFields = [productField.field?.name, sellingModelField.field?.name, scheduleTypeField?.name, adjustmentMethodField?.name]
    .filter((n): n is string => !!n);
  const { compatibleId, compatibleIsActive, existingNames } = await findCompatiblePriceAdjustmentSchedule(
    client, args.product.id, productField.field?.name ?? null, payload, scheduleCompareFields, isActiveField?.name ?? null,
  );

  let scheduleId: string;
  if (compatibleId) {
    scheduleId = compatibleId;
    step(steps, "create-schedule", "success", `Reusing existing, structurally compatible PriceAdjustmentSchedule (${scheduleId}).`);
    onProgress?.(`✓ Reusing existing PriceAdjustmentSchedule (${scheduleId}).`);

    // §Root-cause fix (live evidence) — a reused PriceAdjustmentSchedule with IsActive=false makes every
    // AttributeBasedAdjustment attached to it invisible to Salesforce's real pricing engine at runtime,
    // regardless of how correct the Rule/Condition/Adjustment data underneath it is (confirmed live: the
    // application-side resolver found a fully valid, unambiguous adjustment for two different attributes,
    // yet the actual AttributeDiscount step returned `adjustments: []` — the schedule governing both was
    // IsActive=false). `findCompatiblePriceAdjustmentSchedule`'s compatibility check never considered
    // IsActive at all (Product/SellingModel/ScheduleType/AdjustmentMethod only), so an inactive schedule
    // was silently reused with no diagnostic. Since a REUSED schedule (unlike a freshly created, still-empty
    // one) already has real content by construction — it was only found because it's linked to this exact
    // Product — the "no price adjustment tier" validation the create-path comment above warns about should
    // not apply; still attempted defensively (never fatal) since a genuinely empty reused schedule is
    // structurally possible (e.g. an admin pre-created it with no rows yet on a brand-new product).
    if (isActiveField && compatibleIsActive === false) {
      client.logDebug("native-create-request", `PriceAdjustmentSchedule ${scheduleId} is reused but IsActive=false — its adjustments cannot be applied by Salesforce's real pricing engine until it is active. Attempting to activate it.`);
      try {
        await client.updateRecord("PriceAdjustmentSchedule", scheduleId, { [isActiveField.name]: true });
        client.logDebug("native-create-response", `✓ PriceAdjustmentSchedule ${scheduleId} activated (IsActive=true).`);
        step(steps, "create-schedule", "success", `✓ Activated reused PriceAdjustmentSchedule (${scheduleId}) — it was inactive, which would have silently prevented every one of its adjustments from applying at runtime.`);
        onProgress?.(`✓ Activated PriceAdjustmentSchedule (${scheduleId}).`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        client.logDebug("native-create-request", `✕ Could not activate PriceAdjustmentSchedule ${scheduleId} (non-fatal — proceeding with the schedule still inactive; Salesforce will not apply its adjustments until this is resolved): ${reason}`);
        step(steps, "create-schedule", "info", `⚠ PriceAdjustmentSchedule ${scheduleId} is still inactive (activation attempt failed: ${reason}) — its adjustments will not apply at runtime until an admin activates it.`);
      }
    }
  } else {
    const uniqueName = generateUniqueScheduleName(scheduleBaseName, existingNames);
    payload.Name = uniqueName;
    if (uniqueName !== scheduleBaseName) {
      client.logDebug("native-create-request", `Decision Table name "${scheduleBaseName}" already exists on an incompatible record — using "${uniqueName}" instead.`);
    }
    scheduleId = await guardedCreate(client, "PriceAdjustmentSchedule", pasDescribe, payload, resolvedLookups, "create-schedule");
    client.logDebug("native-create-response", `PriceAdjustmentSchedule ${scheduleId} created and read-back verified as "${uniqueName}".`);
    step(steps, "create-schedule", "success", `Created PriceAdjustmentSchedule "${uniqueName}" (${scheduleId}).`);
    onProgress?.(`✓ Created PriceAdjustmentSchedule "${uniqueName}".`);
  }

  return scheduleId;
}

/* ── Phase: AttributeBasedAdjRule ── */
export interface AttributeBasedRulePlan {
  row: PricingRulePlanRow;
  ctx: AttributeContext;
  ruleId: string;
  reusedExisting: boolean;
  conditionIds: string[];
  /** Populated only when `reusedExisting` is true — the Adjustment already found while resolving the
   * Rule (Part 6/11: every rule's Adjustment must be accounted for in the final counts, not just the
   * ones this run's Adjustment phase actually attempted). */
  existingAdjustmentId?: string;
  /** §Root-cause fix (Product consistency) — this Rule's OWN resolved Product2 value, read directly from
   * Salesforce (never inferred from the current attribute/value/array position) — `null` when this org's
   * AttributeBasedAdjRule exposes no Product2 lookup at all (a genuine schema limitation, not an error).
   * This is the single source of truth every Condition/Adjustment built for this rule must agree with. */
  ruleProductId: string | null;
}

/**
 * §Live-org fix (Org A — "Laptop works repeatedly in one org, an identically-run Monitor/Laptop prompt
 * fails in another") — Salesforce does NOT enforce Name uniqueness on AttributeBasedAdjRule, so
 * `Name = '<ruleName>'` can legitimately return MULTIPLE rows across different products (or, on an org
 * whose schema has no Product2 lookup on Rule at all, rows this application can never distinguish by name
 * alone). A prior version of this lookup fetched only the FIRST matching row (`LIMIT 1`) and either used
 * it or hard-failed if its product disagreed — meaning one contaminated/wrong-product row made that rule
 * name permanently unusable in that org, even when a valid, product-consistent row already existed or
 * could simply be created. This scans EVERY row sharing the name, resolves each one's own Product2 AND
 * every one of ITS existing conditions' Product2 (a read-only investigation — nothing is ever mutated),
 * and returns the first row that is fully product-consistent: its own Product2 matches the request AND
 * every existing condition already attached to it agrees with that same Product2. A candidate that fails
 * either check is logged and skipped — never repaired, never attached to, never deleted. `null` means
 * every same-named candidate is contaminated (or none exist at all), signaling the caller to create a
 * brand-new, correctly product-scoped Rule instead of guessing or attaching to a wrong-product record.
 */
async function resolveProductConsistentRuleCandidate(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  ruleName: string,
  productId: string,
): Promise<{ ruleId: string; ruleProductId: string | null } | null> {
  const ruleSelectFields = [...new Set(["Id", ...(schema.ruleProductField.field ? [schema.ruleProductField.field.name] : [])])];
  const soql = `SELECT ${ruleSelectFields.join(", ")} FROM AttributeBasedAdjRule WHERE Name = '${soqlEscape(ruleName)}' LIMIT 200`;
  client.logDebug("execution-trace", `Rule candidate scan — Name is not a Salesforce-enforced-unique key on AttributeBasedAdjRule, so every same-named row is evaluated (never just the first, never trusted by Name alone): ${soql}`);
  const candidateRows = await client.query<Record<string, unknown> & { Id: string }>(soql).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  if (candidateRows.records.length === 0) return null;

  // Batch-resolve every candidate's OWN existing conditions' Product2 in one query — read-only,
  // never mutated. Absent entirely when this org's schema exposes no Condition->Product2 field
  // (nothing to check; product-consistency then relies on the Rule's own Product2 field alone).
  const candidateIds = candidateRows.records.map(r => r.Id);
  const conditionProductsByRule = new Map<string, (string | null)[]>();
  if (schema.conditionRuleField.field && schema.conditionProductField.field) {
    const condRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${schema.conditionRuleField.field.name}, ${schema.conditionProductField.field.name} FROM AttributeAdjustmentCondition WHERE ${schema.conditionRuleField.field.name} IN (${candidateIds.map(id => `'${soqlEscape(id)}'`).join(",")})`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
    for (const rec of condRes.records) {
      const rId = rec[schema.conditionRuleField.field!.name] as string;
      const pId = (rec[schema.conditionProductField.field!.name] as string | null | undefined) ?? null;
      if (!conditionProductsByRule.has(rId)) conditionProductsByRule.set(rId, []);
      conditionProductsByRule.get(rId)!.push(pId);
    }
  }

  for (const rec of candidateRows.records) {
    const ruleProductId = schema.ruleProductField.field ? ((rec[schema.ruleProductField.field.name] as string | undefined) ?? null) : null;
    const productMatch = !schema.ruleProductField.field || ruleProductId === productId;
    const effectiveProductId = ruleProductId ?? productId;
    const conditionProductIds = conditionProductsByRule.get(rec.Id) ?? [];
    const conditionsConsistent = conditionProductIds.every(pid => pid === null || pid === effectiveProductId);
    const status: "VALID" | "REJECTED" = productMatch && conditionsConsistent ? "VALID" : "REJECTED";
    client.logDebug("execution-trace", [
      `RuleId: ${rec.Id}`,
      `ResolvedProductId: ${ruleProductId ?? "(not exposed on this org's schema)"}`,
      `RequestedProductId: ${productId}`,
      `ProductMatch: ${productMatch}`,
      `ConditionProductIds: [${conditionProductIds.map(p => p ?? "(none)").join(", ")}]`,
      `ConditionCompleteness: ${conditionsConsistent ? "CONSISTENT" : "INCONSISTENT"}`,
      `CandidateStatus: ${status}`,
    ].join("\n"));
    if (status === "VALID") {
      return { ruleId: rec.Id, ruleProductId: schema.ruleProductField.field ? ruleProductId : null };
    }
  }
  client.logDebug(
    "execution-trace",
    `Rule candidate scan — all ${candidateRows.records.length} row(s) named "${ruleName}" were rejected as product-inconsistent for Product ${productId}; a new, correctly product-scoped Rule will be created instead. No existing record was mutated, repaired, or attached to.`,
  );
  return null;
}

/**
 * §Phase-A content-identity fix — shared by both the Name-based candidate path (pre-existing behavior)
 * and the complete-signature-based path in `createOrReuseAttributeBasedAdjRules` below: given a Rule this
 * run found by SOME lookup mechanism, checks whether it already has an AttributeBasedAdjustment matching
 * this run's own identity (Product + ProductSellingModel + Schedule + EffectiveFrom/To) AND whether that
 * Adjustment's stored type/value agrees with what THIS row is requesting. Returns the existing Adjustment
 * Id only when BOTH the identity and the requested value agree — a Rule with a matching identity but a
 * DIFFERENT stored value deliberately comes back `undefined` ("no safely-reusable Adjustment") so the
 * caller falls through to the normal per-plan path in `createAttributeBasedAdjustments`, which already has
 * the full `classifyAdjustmentMatch`/`AdjustmentConflict` machinery — never silently keeps the old value,
 * never silently overwrites it either.
 */
async function resolveExistingAdjustmentForRule(
  client: SalesforceClient, schema: AttributeBasedPricingSchema, ruleId: string,
  args: { productId: string; scheduleId: string; sellingModelId: string | null },
  effectiveFrom: string, effectiveTo: string,
  requestedType: string | null, requestedValue: number, hasValueTracking: boolean,
): Promise<string | undefined> {
  const abaSelect = ["Id",
    ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
    ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
    ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
    ...(schema.abaValueField ? [schema.abaValueField.name] : []),
  ];
  const existingAba = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${[...new Set(abaSelect)].join(", ")} FROM AttributeBasedAdjustment WHERE ${schema.abaRuleField.field!.name} = '${soqlEscape(ruleId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  const rec = existingAba.records[0];
  if (!rec) return undefined;

  // §Section 8/9 (Salesforce's own uniqueness key, confirmed via its own FIELD_INTEGRITY_EXCEPTION text)
  // also includes Product Selling Model and Effective From/To; a Rule's already-attached Adjustment is
  // only trustworthy here if ALL of these agree with this run's resolved values, not just Product+Schedule.
  const productMatches = !schema.abaProductField.field || rec[schema.abaProductField.field.name] === args.productId;
  const scheduleMatches = !schema.abaScheduleField.field || rec[schema.abaScheduleField.field.name] === args.scheduleId;
  const sellingModelMatches = !schema.abaSellingModelField.field
    || ((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) === (args.sellingModelId ?? null);
  const effFromMatches = !schema.abaEffFromField || normalizeDateValue(rec[schema.abaEffFromField.name]) === normalizeDateValue(effectiveFrom);
  const effToMatches = !schema.abaEffToField || normalizeDateValue(rec[schema.abaEffToField.name]) === normalizeDateValue(effectiveTo);
  if (!(productMatches && scheduleMatches && sellingModelMatches && effFromMatches && effToMatches)) {
    client.logDebug(
      "execution-trace",
      `Rule ${ruleId} already has an AttributeBasedAdjustment (${rec.Id}), but it does NOT match this run's identity ` +
      `(Product match=${productMatches}, Schedule match=${scheduleMatches}, SellingModel match=${sellingModelMatches}, EffectiveFrom match=${effFromMatches}, EffectiveTo match=${effToMatches}) — ` +
      `treating as if no Adjustment exists yet; a fresh, correct one will be built. The stale record is left untouched, never deleted or overwritten.`,
    );
    return undefined;
  }

  // §Combination-expansion architecture fix (Phase-A duplicate logical-state fix) — an identity match
  // alone is NOT sufficient: this Rule's existing Adjustment might belong to a DIFFERENT row's request
  // (e.g. this Rule is "Display=1080p"'s Rule, already carrying Display's own $35 Adjustment, and THIS
  // call is resolving "ScreenSize=24Inch"'s row, which collapsed onto the identical complete state but
  // may have requested a DIFFERENT value). Never silently keep the old value nor silently overwrite it —
  // report "no safely-reusable Adjustment" so the caller's normal per-plan path runs the real
  // `classifyAdjustmentMatch`/`AdjustmentConflict` comparison instead.
  if (hasValueTracking) {
    const existingType = schema.abaTypeField ? ((rec[schema.abaTypeField.name] as string | null | undefined) ?? null) : null;
    const existingValue = schema.abaValueField ? ((rec[schema.abaValueField.name] as number | null | undefined) ?? null) : null;
    if (existingType !== requestedType || !adjustmentValuesEqual(existingValue, requestedValue)) {
      client.logDebug(
        "execution-trace",
        `Rule ${ruleId}'s existing AttributeBasedAdjustment (${rec.Id}) matches this run's identity but NOT its requested value ` +
        `(existing ${existingType}/${existingValue} vs requested ${requestedType}/${requestedValue}) — never silently kept; deferring to the normal create/conflict-detection path so this is reported, never swallowed.`,
      );
      return undefined;
    }
  }

  return rec.Id;
}

export async function createOrReuseAttributeBasedAdjRules(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string }; sellingModelId: string | null; rules: PricingRulePlanRow[] },
  contexts: Map<string, AttributeContext>,
  scheduleId: string,
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ plans: AttributeBasedRulePlan[]; ruleIds: string[] }> {
  step(steps, "create-rule", "start", `Creating (or reusing) ${args.rules.length} AttributeBasedAdjRule record(s).`);
  // §Root-cause fix (this turn, Section 8/9) — Salesforce's own uniqueness key includes Product Selling
  // Model and Effective From/To, not just Product+Schedule; computed once per run so this shortcut check
  // and the authoritative one in createAttributeBasedAdjustments never disagree.
  const effectiveFrom = todayISO();
  const effectiveTo = oneYearFromTodayISO();
  const hasValueTracking = !!(schema.abaTypeField || schema.abaValueField);
  const ruleIds: string[] = [];
  const plans: AttributeBasedRulePlan[] = [];
  // §Part 11 fix — every resolved ruleId is now tracked (previously a rule that already existed by
  // name but had no Adjustment yet — the exact shape of a partially-completed prior run — was never
  // pushed into `ruleIds` at all, which is why "22 requested" reported as only "4 confirmed": only
  // brand-new rules and fully-reused ones (with an Adjustment already) were counted.
  let newlyCreated = 0;
  let reusedWithAdjustment = 0;
  let reusedWithoutAdjustment = 0;

  /**
   * §Phase-A duplicate logical-state fix — the confirmed root cause of a real live failure: Phase-A Rule
   * creation used to happen entirely by Name, before any Condition existed to content-match against, so
   * two DIFFERENT rows (e.g. "Display=1080p" and "Screen Size=24 Inch") that both happen to sit at every
   * OTHER price-impacting attribute's baseline collapse onto the IDENTICAL complete condition state —
   * yet each got its own separate Rule, one holding the real Adjustment and the other a permanently
   * Adjustment-less "shadow" Rule (verified live: `Screen_Size_24_Inch_Rule`, 2/2 conditions, 0
   * Adjustments). This block makes Rule resolution CONTENT-aware — using the exact same canonical
   * signature machinery the combinatorial-closure phase already relies on
   * (`computeIntendedCombinationSignature`/`discoverExistingRuleContentIdentities`/
   * `matchExistingRulesToCombinations`), never a second, parallel implementation — before falling back to
   * the pre-existing Name-based path. Skipped entirely (falls straight through to the unchanged Name-based
   * path for every row) whenever there are fewer than 2 price-impacting attributes, since a single
   * price-impacting attribute can never produce two different complete-state collisions — this keeps every
   * single-price-impacting-attribute product (the common case) on the exact, unmodified pre-existing path.
   */
  const priceImpactingEntries = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true);
  let signatureDedup: {
    priceImpactingAttributeNames: string[];
    defaultValueByAttr: Map<string, string | null>;
    existingMatches: Map<number, CombinationRuleMatch>;
    thisRunSignatureToRuleId: Map<string, string>;
  } | null = null;
  if (priceImpactingEntries.length >= 2) {
    const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
    const priceImpactingAttributeNames = priceImpactingEntries.map(([name]) => name);
    const baseConfig = await resolveBaseProductConfiguration(client, args.product.id, priceImpactingEntries);
    const defaultValueByAttr = new Map<string, string | null>(priceImpactingEntries.map(([name]) => [name, baseConfig.attributes[name]?.value ?? null]));
    // A price-impacting attribute with no resolvable baseline can't have its complete state computed —
    // rather than duplicate `createAttributeAdjustmentConditions`'s own hard-failure gate for this here
    // too, simply skip the new content-aware optimization for this run (every row falls through to the
    // unchanged Name-based path below; the real hard failure still happens, unchanged, later).
    const baselineFullyResolved = priceImpactingEntries.every(([name]) => !!defaultValueByAttr.get(name));
    if (baselineFullyResolved) {
      const existingRuleIdentities = await discoverExistingRuleContentIdentities(
        client, schema, attributeIdentityById, args.product.id, priceImpactingAttributeNames, defaultValueByAttr,
      );
      const rowCombos: AttributeCombinationMember[][] = args.rules.map(row => [
        { attributeName: row.attributeName, attributeLabel: row.attributeLabel, value: row.value, valueLabel: row.valueLabel },
      ]);
      const existingMatches = matchExistingRulesToCombinations(rowCombos, existingRuleIdentities, args.product.id, priceImpactingAttributeNames, defaultValueByAttr);
      signatureDedup = { priceImpactingAttributeNames, defaultValueByAttr, existingMatches, thisRunSignatureToRuleId: new Map() };
    }
  }

  for (const [rowIndex, row] of args.rules.entries()) {
    const ctx = contexts.get(row.attributeName);
    if (!ctx) throw new Error(`Could not re-resolve attribute "${row.attributeName}" in Salesforce during rule creation.`);
    if (ctx.isPriceImpacting === false) {
      throw new Error(`Attribute "${row.attributeName}" is not marked price-impacting on this product — Salesforce will reject any pricing rule for it. Mark it price-impacting in Setup and try again.`);
    }

    const ruleName = sanitizeRuleName(row.attributeName, row.value);
    let ruleId: string | undefined;
    let reusedExisting = false;
    let existingAdjustmentId: string | undefined;
    let ruleProductId: string | null = null;
    const abaTypeValue = schema.abaTypeField ? resolveAdjustmentTypeValue(schema.abaTypeField, row.adjustmentType) : null;

    // §Phase-A duplicate logical-state fix — content-identity resolution, tried BEFORE the Name-based
    // path (RULE IDENTITY comes from the complete pricing configuration, never from a generated Name —
    // Name is preserved only for genuinely new Rules, for collision-safe display purposes).
    let rowSignature: string | null = null;
    if (signatureDedup) {
      rowSignature = computeIntendedCombinationSignature(
        args.product.id, [{ attributeName: row.attributeName, value: row.value }],
        signatureDedup.priceImpactingAttributeNames, signatureDedup.defaultValueByAttr,
      );
      const existingMatch = signatureDedup.existingMatches.get(rowIndex);
      if (rowSignature && existingMatch && (existingMatch.status === "KEEP" || existingMatch.status === "COMPLETE") && existingMatch.ruleId) {
        // EXISTING-ORG dedup — this row's complete pricing state already exists as a real Salesforce
        // Rule, found by CONTENT (never by Name, and never assuming the newest record is correct).
        ruleId = existingMatch.ruleId;
        ruleProductId = args.product.id; // discoverExistingRuleContentIdentities is already product-scoped
        existingAdjustmentId = await resolveExistingAdjustmentForRule(
          client, schema, ruleId, { productId: args.product.id, scheduleId, sellingModelId: args.sellingModelId },
          effectiveFrom, effectiveTo, abaTypeValue, row.adjustment, hasValueTracking,
        );
        reusedExisting = !!existingAdjustmentId;
        if (reusedExisting) reusedWithAdjustment++; else reusedWithoutAdjustment++;
        onProgress?.(
          `✓ ${row.attributeLabel} = ${row.valueLabel} resolves to the SAME complete pricing state as an already-existing Rule (matched by content, not name) — reusing it instead of creating a duplicate.`,
        );
      } else if (rowSignature && signatureDedup.thisRunSignatureToRuleId.has(rowSignature)) {
        // CURRENT-RUN dedup — an earlier row in THIS SAME batch already resolved/created a Rule for the
        // identical complete state (e.g. "Display=1080p" processed first, then "Screen Size=24 Inch"
        // recognizes the state already exists this run). Deliberately NOT marked `reusedExisting` — it
        // must still flow through condition creation (safely idempotent — reuses the same rows the
        // earlier row already created/will create) and adjustment creation (so a genuinely conflicting
        // requested value is still caught, never silently dropped).
        ruleId = signatureDedup.thisRunSignatureToRuleId.get(rowSignature)!;
        ruleProductId = args.product.id;
        onProgress?.(
          `✓ ${row.attributeLabel} = ${row.valueLabel} resolves to the SAME complete pricing state already established earlier in this run — reusing that Rule instead of creating a duplicate ("shadow") Rule.`,
        );
      }
      // AMBIGUOUS or CREATE (no existing/current-run match at all): fall through to the unchanged
      // Name-based path below — never guessed.
    }

    if (ruleId === undefined) {
      // §Live-org fix (Org A) — Name is NOT a Salesforce-enforced-unique key on AttributeBasedAdjRule, so a
      // same-named rule can legitimately exist for a COMPLETELY DIFFERENT product (e.g. two unrelated
      // products both having a "Memory" attribute with a "RAM 16GB" value produce the identical sanitized
      // rule name). Rather than trusting a single `LIMIT 1` lookup (and either reusing a wrong-product row
      // or hard-failing the whole run when it disagrees), every same-named row is scanned and evaluated for
      // full product consistency — its own Product2 AND every one of its existing conditions' Product2 —
      // by `resolveProductConsistentRuleCandidate`; a contaminated candidate is skipped (never mutated,
      // never attached to) in favor of another valid one, or a brand-new Rule if none qualifies.
      if (!schema.ruleProductField.field) {
        client.logDebug("execution-trace", `WARNING — this org's AttributeBasedAdjRule has no Product2 lookup field; rule candidate evaluation for "${ruleName}" relies entirely on Condition-level Product2 verification (and downstream Adjustment-level verification).`);
      }
      const candidate = await resolveProductConsistentRuleCandidate(client, schema, ruleName, args.product.id);
      if (candidate) {
        ruleId = candidate.ruleId;
        ruleProductId = candidate.ruleProductId;
        client.logDebug("execution-trace", `Rule ${ruleId}\nExpected Product ${args.product.id}\nRule's own resolved Product: ${ruleProductId ?? "(not exposed on this org's schema)"}`);
        existingAdjustmentId = await resolveExistingAdjustmentForRule(
          client, schema, ruleId, { productId: args.product.id, scheduleId, sellingModelId: args.sellingModelId },
          effectiveFrom, effectiveTo, abaTypeValue, row.adjustment, hasValueTracking,
        );
        if (existingAdjustmentId) {
          reusedExisting = true;
          reusedWithAdjustment++;
          onProgress?.(`✓ Reused existing AttributeBasedAdjRule "${ruleName}" (already has a verified Adjustment for this exact Product+SellingModel+Schedule+EffectiveFrom/To+value).`);
        } else {
          reusedWithoutAdjustment++;
          onProgress?.(`Found existing AttributeBasedAdjRule "${ruleName}" without a safely-reusable Adjustment yet — will build a correct Condition/Adjustment instead.`);
        }
      } else {
        // Only set the direct Schedule lookup on Rule when this org's schema actually has one (see
        // prepareAttributeBasedAdjustmentSchema's diagnostics) — the Schedule/Rule connection is
        // always also established via AttributeBasedAdjustment below, which is the org-agnostic path.
        const payload: Record<string, unknown> = { Name: ruleName };
        const resolvedLookups: ResolvedLookup[] = [];
        if (schema.ruleProductField.field) { payload[schema.ruleProductField.field.name] = args.product.id; resolvedLookups.push({ targetObject: "Product2", field: schema.ruleProductField.field, value: args.product.id }); }
        if (schema.ruleScheduleField.field) {
          payload[schema.ruleScheduleField.field.name] = scheduleId;
          resolvedLookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.ruleScheduleField.field, value: scheduleId });
        }
        if (schema.ruleEffFromField) payload[schema.ruleEffFromField.name] = todayISO();
        if (schema.ruleEffToField) payload[schema.ruleEffToField.name] = oneYearFromTodayISO();
        if (schema.ruleActiveField) payload[schema.ruleActiveField.name] = true;
        ruleId = await guardedCreate(client, "AttributeBasedAdjRule", schema.ruleDescribe, payload, resolvedLookups, "create-rule");
        ruleProductId = schema.ruleProductField.field ? args.product.id : null;
        newlyCreated++;
        onProgress?.(`✓ Created AttributeBasedAdjRule "${ruleName}"${schema.ruleScheduleField.field ? "" : " (linked to the Schedule via AttributeBasedAdjustment — this org has no direct Rule→Schedule lookup)"}.`);
      }
      if (signatureDedup && rowSignature) signatureDedup.thisRunSignatureToRuleId.set(rowSignature, ruleId);
    }

    ruleIds.push(ruleId);
    plans.push({ row, ctx, ruleId, reusedExisting, conditionIds: [], existingAdjustmentId, ruleProductId });
  }

  client.logDebug("execution-trace", [
    "AttributeBasedAdjRule summary",
    `Requested rules: ${args.rules.length}`,
    `New rules created: ${newlyCreated}`,
    `Existing rules reused (with Adjustment already): ${reusedWithAdjustment}`,
    `Existing rules reused (Adjustment still pending): ${reusedWithoutAdjustment}`,
    `Final rules confirmed: ${ruleIds.length} (must equal ${newlyCreated} + ${reusedWithAdjustment} + ${reusedWithoutAdjustment})`,
  ].join("\n"));
  step(
    steps, "create-rule", "success",
    `${ruleIds.length} rule(s) confirmed (${newlyCreated} created, ${reusedWithAdjustment + reusedWithoutAdjustment} reused).`,
  );
  return { plans, ruleIds };
}

/* ── §REVERSED this turn — a prior fix ("Part 1-9 fix") removed one Condition per OTHER
 * price-impacting attribute per Rule, reasoning that 22 rules × 6 attributes = 132 conditions observed
 * live was excessive/wrong. That reasoning was incorrect: a fresh org's live FIELD_INTEGRITY_EXCEPTION
 * ("Associate all price impacting attributes with the relevant Attribute Adjustment Condition and try
 * again") proved 132 is exactly what Salesforce's own documented Attribute-Based Adjustment model
 * requires — confirmed via Salesforce's own Help/Trailhead walkthroughs: "you need to define values
 * for all price-impacting attributes in every adjustment record — even if only one attribute drives
 * the price." Reinstated below, corrected: the OTHER (non-varying) attributes' condition value is never
 * invented — it comes from the real, documented `ProductAttributeDefinition.DefaultValue` field; an
 * attribute with no Default Value set is a hard failure naming that attribute, never a guessed value.
 * This module's `PricingRulePlanRow` is still single-attribute-per-row for the VARYING attribute
 * (multi-attribute combination rules like "Memory=16GB AND Graphics=RTX3060" as the intentionally
 * varying pair are not modeled anywhere in this pipeline's rule-plan shape yet — out of scope here) —
 * every row still has exactly ONE varying attribute, but now also carries one baseline-default
 * condition per every OTHER price-impacting attribute on the product, per Salesforce's real
 * requirement. ── */

type ConditionIdentity = { kind: "pad" | "attrDef"; fieldName: string; value: string };

function resolveConditionIdentity(schema: AttributeBasedPricingSchema, ctx: AttributeContext): ConditionIdentity | null {
  if (schema.conditionPadField.field && ctx.productAttributeDefinitionId) {
    return { kind: "pad", fieldName: schema.conditionPadField.field.name, value: ctx.productAttributeDefinitionId };
  }
  if (schema.conditionAttrDefField.field && ctx.attributeDefinitionId) {
    return { kind: "attrDef", fieldName: schema.conditionAttrDefField.field.name, value: ctx.attributeDefinitionId };
  }
  return null;
}

/**
 * §Part 6, extended by §Root-cause fix (Product consistency) — the org's real uniqueness key (Product +
 * AttributeDefinition/ProductAttributeDefinition + AttributeBasedAdjRule) queried directly via
 * already-Describe-resolved fields, never guessed. At most one condition can legitimately exist per
 * (identity, Rule) pair — Salesforce's own FIELD_INTEGRITY_EXCEPTION enforces that — so a match found here
 * is reused regardless of whether its stored value happens to differ (logged either way, since a real
 * mismatch would indicate a genuine data problem worth seeing, but reuse is still the only safe move:
 * creating a second one would just be rejected by Salesforce).
 *
 * §Live-org fix (Laptop) — this query used to filter ONLY by Rule + identity, never verifying Product2Id
 * at all. Salesforce itself proved this insufficient: "For the given Attribute Based Adjustment Rule,
 * select the same product record for all Attribute Adjustment Conditions." A condition matching by
 * Rule+identity but belonging to a DIFFERENT product (reachable if this org's data already has one, e.g.
 * from a prior partial/differently-scoped run) must NEVER be reused — attaching it to a rule for the
 * CURRENT product would only reproduce that exact rejection. `expectedProductId` is scoped into the WHERE
 * clause whenever this org's AttributeAdjustmentCondition exposes a Product2 lookup at all, and the
 * returned record's own product is verified again defensively after the query returns.
 */
async function findExistingAttributeAdjustmentCondition(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  ruleId: string,
  identity: ConditionIdentity,
  expectedValueField: { fieldName: string; value: unknown },
  expectedProductId: string | null,
): Promise<string | null> {
  const whereClauses = [`${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`, `${identity.fieldName} = '${soqlEscape(identity.value)}'`];
  if (schema.conditionProductField.field && expectedProductId) whereClauses.push(`${schema.conditionProductField.field.name} = '${soqlEscape(expectedProductId)}'`);
  const selectFields = [...new Set(["Id", identity.fieldName, expectedValueField.fieldName,
    ...(schema.conditionOperatorField ? [schema.conditionOperatorField.name] : []),
    ...(schema.conditionProductField.field ? [schema.conditionProductField.field.name] : []),
  ])];
  const soql = `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${whereClauses.join(" AND ")} LIMIT 1`;
  client.logDebug("execution-trace", `AttributeAdjustmentCondition preflight — querying by the org's real uniqueness key (Rule + ${identity.fieldName}${schema.conditionProductField.field && expectedProductId ? " + Product2" : ""}): ${soql}`);

  const res = await client.query<Record<string, unknown> & { Id: string }>(soql).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  const rec = res.records[0];
  if (!rec) return null;

  // §Defense in depth — verified again even though the WHERE clause above already scopes by product
  // whenever possible: covers the case where this org's schema has no Product2 field on Condition at all
  // (nothing to scope by) while still refusing to trust a record whose product genuinely differs if the
  // field IS present but somehow wasn't included above.
  if (schema.conditionProductField.field && expectedProductId) {
    const actualProductId = (rec[schema.conditionProductField.field.name] as string | undefined) ?? null;
    if (actualProductId !== expectedProductId) {
      client.logDebug(
        "execution-trace",
        `AttributeAdjustmentCondition preflight — REJECTED candidate ${rec.Id}: belongs to Product ${actualProductId ?? "(none)"}, expected ${expectedProductId}. Never reused across products — treating as if no existing condition was found.`,
      );
      return null;
    }
  }

  const existingValue = rec[expectedValueField.fieldName];
  const matches = existingValue !== undefined && String(existingValue) === String(expectedValueField.value);
  client.logDebug(
    "execution-trace",
    `AttributeAdjustmentCondition preflight — found existing condition ${rec.Id} for this Rule + ${identity.fieldName}. ` +
    `Existing value: ${JSON.stringify(existingValue)}, expected: ${JSON.stringify(expectedValueField.value)} -> ${matches ? "MATCH" : "DIFFERENT — reusing anyway (Salesforce's own uniqueness constraint permits only one condition per Product+AttributeDefinition+Rule, so a second create would only be rejected)."}`,
  );
  return rec.Id;
}

/**
 * §Root-cause fix (Follow-on 40, restructured Follow-on 41 into a single named resolver per the user's
 * exact request) — `ProductAttributeDefinition.DefaultValue` alone is too strict: a live org proved an
 * attribute ("Graphics") can be genuinely price-impacting with no product-level Default Value set, yet
 * still have a real, Salesforce-configured effective value one level up. This IS the canonical "base
 * product configuration" — the single source of truth every Attribute Adjustment Condition (for every
 * NON-varying attribute, on every Rule) reads from; nothing downstream resolves a baseline value any
 * other way. Resolution priority, every step Describe-gated and never guessed:
 *   1. PRODUCT_DEFAULT       — ProductAttributeDefinition.DefaultValue (product-specific override).
 *   2. CLASSIFICATION_DEFAULT — ProductAttributeDefinition.ProductClassificationAttributeId ->
 *      ProductClassificationAttr.DefaultValue (the real, documented field: "The default value of the
 *      attribute for a product based on the product classification"). Confirmed via Salesforce's own
 *      Revenue Cloud Developer Guide. Skipped entirely (never a fatal error) if this org's
 *      ProductAttributeDefinition has no such relationship field, or ProductClassificationAttr isn't
 *      usable on this org.
 *   3. "The pricing rule itself explicitly specifies the value" — investigated twice (Follow-on 40 and
 *      again this turn) and deliberately NOT implemented as a real source: `PricingRulePlanRow` (this
 *      pipeline's actual data model, confirmed by reading `lib/pricing-rules/attribute-based/types.ts`)
 *      carries a value ONLY for its own single varying attribute, never for any other attribute on the
 *      same rule — there is no real per-attribute "intended baseline" data anywhere in this pipeline
 *      (not in `PricingRulePlanRow`, not in the earlier analyze/discovery phase) to read for the OTHER
 *      attributes. Faking this by picking one of an attribute's OWN pricing-rule rows would be exactly
 *      the "choose a random existing value" this fix must never do — confirmed still true this turn.
 *      Also investigated: `ProductAttributeDefinition.OverriddenProductAttributeDefinitionId` (a real
 *      field — "the Id of the overridden product attribute definition") — confirmed via Salesforce
 *      documentation to be a BUNDLE-context override mechanism (`OverrideContextId` = "the root product
 *      record in a bundle"), not a general-purpose parent/base-default relationship for a standalone
 *      product — nothing in this entire session's evidence shows Laptop is part of a bundle, so using
 *      this field here would be applying an untested, likely-inapplicable mechanism. Not implemented.
 *   4. SINGLE_CONFIGURED_VALUE — used ONLY when Salesforce's own data proves there is no ambiguity: the
 *      attribute's real AttributePicklistValue set (resolved via the same `resolveAttributePicklistId`
 *      already used for value creation elsewhere in this pipeline) contains EXACTLY ONE row. Two or
 *      more values means genuine ambiguity — never resolved by picking the first one.
 *   Otherwise: NONE — the caller stops before any Salesforce write, naming the exact attribute.
 */
export interface BaseProductConfigurationAttribute {
  attributeDefinitionId: string | null;
  productAttributeDefinitionId: string | null;
  /** Best-effort AttributePicklistValue.Id matching `value` — resolved AFTER `value`/`source`, purely
   * for traceability; never blocks resolution if it can't be found (Condition creation itself stores
   * the raw typed value, not this Id — AttributeAdjustmentCondition has no AttributeValueId lookup
   * field on Salesforce's own documented schema). */
  attributeValueId: string | null;
  productValue: string | null;
  classificationValue: string | null;
  singleConfiguredValue: string | null;
  value: string | null;
  source: "PRODUCT_DEFAULT" | "CLASSIFICATION_DEFAULT" | "SINGLE_CONFIGURED_VALUE" | "NONE";
  /** §Follow-on 42 — the REAL AttributePicklistValue rows Salesforce reports for this attribute,
   * captured whenever they were queried (i.e. whenever neither a product-specific nor a
   * classification-level default existed) — regardless of whether that count resolved the value
   * (exactly 1) or not (0, or 2+ — genuine ambiguity). Populated so a caller that needs to let a human
   * pick a real value (never inventing one) has the actual candidate set on hand without a second
   * query. Empty when `source` is PRODUCT_DEFAULT/CLASSIFICATION_DEFAULT (never queried, not needed). */
  candidateValues: { id: string; value: string }[];
}

export interface BaseProductConfiguration {
  productId: string;
  attributes: Record<string, BaseProductConfigurationAttribute>;
}

export async function resolveBaseProductConfiguration(
  client: SalesforceClient,
  productId: string,
  priceImpactingEntries: [string, AttributeContext][],
): Promise<BaseProductConfiguration> {
  const attributes: Record<string, BaseProductConfigurationAttribute> = {};
  const padDescribe = await new SchemaCache(client).get("ProductAttributeDefinition");
  const defaultValueField = padDescribe.fields.find(f => /^DefaultValue$/i.test(f.name)) ?? null;
  const classificationAttrField = padDescribe.fields.find(f => /^ProductClassificationAttributeId$/i.test(f.name)) ?? null;

  const padIds = priceImpactingEntries.map(([, ctx]) => ctx.productAttributeDefinitionId).filter((id): id is string => !!id);
  const byPadId = new Map<string, { defaultValue: string | null; classificationAttrId: string | null }>();
  if (padIds.length > 0 && (defaultValueField || classificationAttrField)) {
    const selectFields = ["Id", ...(defaultValueField ? [defaultValueField.name] : []), ...(classificationAttrField ? [classificationAttrField.name] : [])];
    const res = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${selectFields.join(", ")} FROM ProductAttributeDefinition WHERE Id IN (${padIds.map(id => `'${soqlEscape(id)}'`).join(",")})`,
    );
    for (const rec of res.records) {
      byPadId.set(rec.Id, {
        defaultValue: defaultValueField ? (rec[defaultValueField.name] as string | undefined) ?? null : null,
        classificationAttrId: classificationAttrField ? (rec[classificationAttrField.name] as string | undefined) ?? null : null,
      });
    }
  }

  // §Priority 2 — batch-resolve ProductClassificationAttr.DefaultValue for every PAD that references one
  // AND (§Live-org fix, Desktop) for every attribute that has NO ProductAttributeDefinition record at all
  // but IS classification-inherited (`ctx.productClassificationAttrId`, resolved by `resolveAttributeContexts`
  // via the same shared `resolveProductClassificationInheritance`) — a purely inherited attribute must
  // still resolve a real baseline value from its classification, never fall through to NONE just because
  // there's no product-level record to read a value from. Never fatal: an org where this object/
  // relationship isn't usable simply yields no classification-level values, falling through to Priority 4
  // or NONE.
  const classificationAttrIdsNeeded = [...new Set([
    ...[...byPadId.values()].map(v => v.classificationAttrId).filter((id): id is string => !!id),
    ...priceImpactingEntries.map(([, ctx]) => ctx.productClassificationAttrId).filter((id): id is string => !!id),
  ])];
  const classificationDefaultById = new Map<string, string | null>();
  if (classificationAttrIdsNeeded.length > 0) {
    try {
      const pcaDescribe = await client.describeObject("ProductClassificationAttr");
      const pcaDefaultField = pcaDescribe.fields.find(f => /^DefaultValue$/i.test(f.name)) ?? null;
      if (pcaDefaultField) {
        const res = await client.query<Record<string, unknown> & { Id: string }>(
          `SELECT Id, ${pcaDefaultField.name} FROM ProductClassificationAttr WHERE Id IN (${classificationAttrIdsNeeded.map(id => `'${soqlEscape(id)}'`).join(",")})`,
        );
        for (const rec of res.records) classificationDefaultById.set(rec.Id, (rec[pcaDefaultField.name] as string | undefined) ?? null);
      }
    } catch {
      // ProductClassificationAttr not usable on this org — never fatal for this optional enrichment.
    }
  }

  for (const [name, ctx] of priceImpactingEntries) {
    const padInfo = ctx.productAttributeDefinitionId ? byPadId.get(ctx.productAttributeDefinitionId) : undefined;
    const productValue = padInfo?.defaultValue ?? null;
    // §Live-org fix (Desktop) — classification default resolves via the PAD's own link when a
    // product-level record exists (unchanged), OR directly via `ctx.productClassificationAttrId` when the
    // attribute is purely inherited (no PAD record on this product at all).
    const classificationAttrIdForThisAttr = padInfo?.classificationAttrId ?? ctx.productClassificationAttrId ?? null;
    const classificationValue = classificationAttrIdForThisAttr ? (classificationDefaultById.get(classificationAttrIdForThisAttr) ?? null) : null;

    let value: string | null = null;
    let source: BaseProductConfigurationAttribute["source"] = "NONE";
    let singleConfiguredValue: string | null = null;
    let picklistIdForEnrichment: string | null = null;
    let candidateValues: { id: string; value: string }[] = [];
    if (productValue) {
      value = productValue; source = "PRODUCT_DEFAULT";
    } else if (classificationValue) {
      value = classificationValue; source = "CLASSIFICATION_DEFAULT";
    } else {
      // §Priority 4 — ONLY when Salesforce's own data proves there is exactly one possible value.
      const picklistId = await resolveAttributePicklistId(client, ctx.attributeDefinitionId, ctx.productAttributeDefinitionId);
      picklistIdForEnrichment = picklistId;
      if (picklistId) {
        const res = await client.query<{ Id: string; Value?: string; DisplayValue?: string; Name?: string }>(
          `SELECT Id, Value, DisplayValue, Name FROM AttributePicklistValue WHERE PicklistId = '${soqlEscape(picklistId)}'`,
        ).catch(() => ({ records: [] as { Id: string; Value?: string; DisplayValue?: string; Name?: string }[] }));
        candidateValues = res.records
          .map(r => ({ id: r.Id, value: r.Value ?? r.DisplayValue ?? r.Name ?? "" }))
          .filter(c => c.value !== "");
        if (res.records.length === 1) {
          singleConfiguredValue = res.records[0].Value ?? res.records[0].DisplayValue ?? res.records[0].Name ?? null;
          if (singleConfiguredValue) { value = singleConfiguredValue; source = "SINGLE_CONFIGURED_VALUE"; }
        }
      }
    }

    // §Best-effort AttributeValueId enrichment — never blocks, never re-derives `value`/`source`.
    let attributeValueId: string | null = null;
    if (value) {
      try {
        const picklistId = picklistIdForEnrichment ?? await resolveAttributePicklistId(client, ctx.attributeDefinitionId, ctx.productAttributeDefinitionId);
        if (picklistId) {
          const res = await client.query<{ Id: string; Value?: string; DisplayValue?: string; Name?: string }>(
            `SELECT Id, Value, DisplayValue, Name FROM AttributePicklistValue WHERE PicklistId = '${soqlEscape(picklistId)}'`,
          ).catch(() => ({ records: [] as { Id: string; Value?: string; DisplayValue?: string; Name?: string }[] }));
          const norm = value.toLowerCase();
          attributeValueId = res.records.find(r => (r.Value ?? r.DisplayValue ?? r.Name ?? "").toLowerCase() === norm)?.Id ?? null;
        }
      } catch {
        // Enrichment only — never fatal, never affects the resolved value/source.
      }
    }

    attributes[name] = {
      attributeDefinitionId: ctx.attributeDefinitionId, productAttributeDefinitionId: ctx.productAttributeDefinitionId,
      attributeValueId, productValue, classificationValue, singleConfiguredValue, value, source, candidateValues,
    };
  }
  return { productId, attributes };
}

/**
 * §Follow-on 42 — thrown by `createAttributeAdjustmentConditions` INSTEAD OF a plain `Error` when one or
 * more price-impacting attributes have no resolvable base value, so the caller (`createPipeline.ts`) can
 * surface a structured, actionable remediation state to the UI (real candidate Salesforce values to pick
 * from — never an invented one) instead of only a text message. A plain `Error` is still what every
 * OTHER failure in this module throws; this is a narrowly-scoped exception used for exactly one
 * situation.
 */
export interface MissingAttributeConfigInfo {
  attributeName: string;
  productId: string;
  productAttributeDefinitionId: string | null;
  attributeDefinitionId: string | null;
  /** §Live-org fix — populated ONLY when `productAttributeDefinitionId` is null (a purely
   * Product-Classification-inherited attribute with no product-level record at all) — the remediation UI
   * must use this (via `setEffectiveAttributeDefaultValue`, which creates a product-scoped override)
   * instead of silently doing nothing just because there's no existing record to update. */
  productClassificationAttrId: string | null;
  /** The REAL AttributePicklistValue rows Salesforce reports for this attribute — the ONLY values a
   * remediation UI may ever offer; never invented, never a value from an unrelated attribute. */
  candidateValues: { id: string; value: string }[];
}

export interface ResolvedAttributeConfigInfo {
  attributeName: string;
  value: string;
  source: BaseProductConfigurationAttribute["source"];
}

export class MissingAttributeConfigurationError extends Error {
  readonly missingAttributes: MissingAttributeConfigInfo[];
  readonly resolvedAttributes: ResolvedAttributeConfigInfo[];
  constructor(message: string, missingAttributes: MissingAttributeConfigInfo[], resolvedAttributes: ResolvedAttributeConfigInfo[]) {
    super(message);
    this.name = "MissingAttributeConfigurationError";
    this.missingAttributes = missingAttributes;
    this.resolvedAttributes = resolvedAttributes;
  }
}

/**
 * §Follow-on 42 — updates the ONE real, documented field this whole resolution chain reads
 * (`ProductAttributeDefinition.DefaultValue`) with a value the caller must have already sourced from
 * `MissingAttributeConfigInfo.candidateValues` (a REAL Salesforce AttributePicklistValue) — this
 * function does not validate that itself (the API route layer does, against the same candidate list),
 * it only performs the write and the mandatory read-back. Never assumes the update succeeded: the
 * record is re-queried immediately after and the persisted value is compared against what was sent.
 */
export async function setProductAttributeDefinitionDefaultValue(
  client: SalesforceClient,
  productAttributeDefinitionId: string,
  value: string,
): Promise<{ success: boolean; verifiedValue: string | null; error?: string }> {
  const padDescribe = await new SchemaCache(client).get("ProductAttributeDefinition");
  const defaultValueField = padDescribe.fields.find(f => /^DefaultValue$/i.test(f.name)) ?? null;
  if (!defaultValueField) {
    return { success: false, verifiedValue: null, error: "This org's ProductAttributeDefinition has no DefaultValue field — cannot save a product-level default here." };
  }
  try {
    await client.updateRecord("ProductAttributeDefinition", productAttributeDefinitionId, { [defaultValueField.name]: value });
  } catch (err) {
    return { success: false, verifiedValue: null, error: err instanceof Error ? err.message : String(err) };
  }
  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT Id, ${defaultValueField.name} FROM ProductAttributeDefinition WHERE Id = '${soqlEscape(productAttributeDefinitionId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  const verifiedValue = (res.records[0]?.[defaultValueField.name] as string | undefined) ?? null;
  if (verifiedValue !== value) {
    return {
      success: false, verifiedValue,
      error: `Salesforce read-back did not confirm the update — expected "${value}", found "${verifiedValue ?? "(null)"}". Refusing to treat this as saved.`,
    };
  }
  return { success: true, verifiedValue };
}

/**
 * §Live-org fix — the remediation-UI entry point `setProductAttributeDefinitionDefaultValue` alone
 * cannot serve: it only ever knows how to UPDATE an existing ProductAttributeDefinition, but
 * `MissingAttributeConfigInfo.productAttributeDefinitionId` is `null` for a purely
 * Product-Classification-inherited attribute (no product-level record exists at all — e.g. Desktop's
 * "Graphics"/"Storage"/"Screen Size"). Calling the UPDATE path with no Id to update against is exactly
 * why the "Save Default Value" button previously did nothing for these attributes. This resolves which
 * path is actually valid from the SAME fields `MissingAttributeConfigInfo` already carries:
 *   - `productAttributeDefinitionId` present -> UPDATE that record's DefaultValue (unchanged, delegates
 *     to `setProductAttributeDefinitionDefaultValue`).
 *   - absent but `productClassificationAttrId` + `attributeDefinitionId` + `productId` present -> CREATE
 *     a new, product-SCOPED ProductAttributeDefinition override with DefaultValue set (via the same
 *     `createProductAttributeDefinitionOverride` helper `ensurePriceImpactingAttributes` uses) — never a
 *     write to the shared ProductClassificationAttr record.
 *   - neither -> a precise error, never a silent no-op.
 */
export async function setEffectiveAttributeDefaultValue(
  client: SalesforceClient,
  args: {
    productAttributeDefinitionId: string | null;
    productId: string | null;
    attributeDefinitionId: string | null;
    productClassificationAttrId: string | null;
    value: string;
  },
): Promise<{ success: boolean; verifiedValue: string | null; productAttributeDefinitionId?: string; error?: string }> {
  if (args.productAttributeDefinitionId) {
    const result = await setProductAttributeDefinitionDefaultValue(client, args.productAttributeDefinitionId, args.value);
    return { ...result, productAttributeDefinitionId: args.productAttributeDefinitionId };
  }

  if (!args.productId || !args.attributeDefinitionId || !args.productClassificationAttrId) {
    return {
      success: false, verifiedValue: null,
      error: "This attribute has no existing Product Attribute Definition record and is not resolvable as a Product Classification-inherited attribute either — nothing safe to create.",
    };
  }

  const overrideFields = await resolveProductAttributeDefinitionOverrideFields(client);
  if (!overrideFields.fields) {
    return {
      success: false, verifiedValue: null,
      error: `This org's ProductAttributeDefinition schema does not expose ${overrideFields.missing.join(", ")}, so a product-scoped override cannot be safely created. Set a Default Value on the Product Classification directly in Setup instead (note: that affects every product sharing that classification).`,
    };
  }
  const defaultValueField = overrideFields.fields.padDescribe.fields.find(f => /^DefaultValue$/i.test(f.name)) ?? null;
  if (!defaultValueField) {
    return { success: false, verifiedValue: null, error: "This org's ProductAttributeDefinition has no DefaultValue field — cannot save a default value here." };
  }

  // §Live-org fix — IDEMPOTENCY: a product-scoped record for this exact Product2 + AttributeDefinition
  // pair may already exist (a prior click, a retried run, or `ensurePriceImpactingAttributes` having
  // already created one for a DIFFERENT reason earlier in the SAME pipeline run) — never blind-create a
  // second one. Resolved by the real Product2/AttributeDefinition reference fields, never by Name.
  const existingRes = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT Id FROM ProductAttributeDefinition WHERE ${overrideFields.fields.padProductField.name} = '${soqlEscape(args.productId)}' AND ${overrideFields.fields.padAttrDefField.name} = '${soqlEscape(args.attributeDefinitionId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  const existingId = existingRes.records[0]?.Id;
  if (existingId) {
    const result = await setProductAttributeDefinitionDefaultValue(client, existingId, args.value);
    return { ...result, productAttributeDefinitionId: existingId };
  }

  // §Live-org fix — every attribute reaching this remediation flow is ALREADY confirmed price-impacting
  // (that's exactly why Salesforce demands a baseline value for it) — the new override must carry that
  // same effective state forward explicitly, or Salesforce's own default for a brand-new record (not
  // necessarily true) would silently regress an attribute that was already correctly price-impacting via
  // its Product Classification.
  const priceImpactingField = resolvePriceImpactingField(overrideFields.fields.padDescribe);

  let overrideId: string;
  try {
    overrideId = await createProductAttributeDefinitionOverride(client, overrideFields.fields, {
      productId: args.productId, attributeDefinitionId: args.attributeDefinitionId, productClassificationAttrId: args.productClassificationAttrId,
      extraFields: { [defaultValueField.name]: args.value, ...(priceImpactingField ? { [priceImpactingField.name]: true } : {}) },
      stepName: "configure-attribute-default",
    });
  } catch (err) {
    return { success: false, verifiedValue: null, error: err instanceof Error ? err.message : String(err) };
  }

  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT Id, ${defaultValueField.name} FROM ProductAttributeDefinition WHERE Id = '${soqlEscape(overrideId)}' LIMIT 1`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
  const verifiedValue = (res.records[0]?.[defaultValueField.name] as string | undefined) ?? null;
  if (verifiedValue !== args.value) {
    return {
      success: false, verifiedValue, productAttributeDefinitionId: overrideId,
      error: `Salesforce read-back did not confirm the new override's Default Value — expected "${args.value}", found "${verifiedValue ?? "(null)"}". Refusing to treat this as saved.`,
    };
  }
  return { success: true, verifiedValue, productAttributeDefinitionId: overrideId };
}

function formatBaseProductConfigurationReport(productLabel: string, config: BaseProductConfiguration): string {
  return [
    "=== BASE PRODUCT CONFIGURATION ===",
    "",
    `Product: ${productLabel}`,
    "",
    ...Object.entries(config.attributes).flatMap(([name, r]) => [
      `${name}:`,
      `  ProductAttributeDefinition = ${r.productAttributeDefinitionId ?? "(none)"}`,
      `  Product-specific value = ${r.productValue ?? "(null)"}`,
      `  Classification value = ${r.classificationValue ?? "(null)"}`,
      `  Pricing-rule value = (not applicable — never a real source; see the resolver's own doc comment for why)`,
      `  Value = ${r.value ?? "(NONE — no authoritative value exists)"}`,
      `  Source = ${r.source}`,
      "",
    ]),
  ].join("\n");
}

/* ── Phase: AttributeAdjustmentCondition — idempotent (Part 6/7): every create is preceded by a
 * preflight against the org's real uniqueness key, so a retry after a partial failure reuses whatever
 * already exists instead of duplicating it. No Salesforce delete is ever issued. ── */
export async function createAttributeAdjustmentConditions(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string } },
  contexts: Map<string, AttributeContext>,
  plans: AttributeBasedRulePlan[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
): Promise<{ conditionIds: string[]; reusedConditionIds: string[] }> {
  step(steps, "create-condition", "start", "Creating (or reusing) Attribute Adjustment Conditions.");
  const conditionIds: string[] = [];
  const reusedConditionIds: string[] = [];

  const equalValue = schema.conditionOperatorField
    ? (schema.conditionOperatorField.picklistValues ?? []).filter(v => v.active).find(v => /^equal$/i.test(v.value))?.value ?? (schema.conditionOperatorField.picklistValues ?? []).find(v => v.active)?.value
    : undefined;

  // §Part 9 — NO PARTIAL CREATION: resolve + validate the effective value for EVERY price-impacting
  // attribute BEFORE any Salesforce write happens in this function (not just before each rule's own
  // create — the exact bug that left 22 Rules created but only 1 Condition before hard-failing on
  // Graphics). `contexts` is the SAME map `createOrReuseAttributeBasedAdjRules` and the Adjustment
  // signature machinery below already use — never a separately/differently scoped attribute set that
  // could disagree with them.
  const priceImpactingEntries = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true);
  const baseConfig = await resolveBaseProductConfiguration(client, args.product.id, priceImpactingEntries);
  const resolutionReport = formatBaseProductConfigurationReport(`${args.product.name} (${args.product.id})`, baseConfig);
  client.logDebug("execution-trace", resolutionReport);

  const unresolved = priceImpactingEntries.filter(([name]) => !baseConfig.attributes[name]?.value);
  if (unresolved.length > 0) {
    // §Follow-on 42 — structured, actionable failure instead of a plain Error: carries the REAL
    // candidate Salesforce values for each unresolved attribute (never invented) so the caller can offer
    // a remediation UI ("pick a real value, save it, retry") rather than only a text message naming the
    // problem. `resolvedAttributes` is included too so that UI can show the full ✓/⚠ checklist, not just
    // the failing row.
    const missingAttributes: MissingAttributeConfigInfo[] = unresolved.map(([name, ctx]) => ({
      attributeName: name, productId: args.product.id,
      productAttributeDefinitionId: ctx.productAttributeDefinitionId, attributeDefinitionId: ctx.attributeDefinitionId,
      productClassificationAttrId: ctx.productClassificationAttrId,
      candidateValues: baseConfig.attributes[name]?.candidateValues ?? [],
    }));
    const resolvedAttributes: ResolvedAttributeConfigInfo[] = priceImpactingEntries
      .filter(([name]) => !!baseConfig.attributes[name]?.value)
      .map(([name]) => ({ attributeName: name, value: baseConfig.attributes[name].value!, source: baseConfig.attributes[name].source }));
    throw new MissingAttributeConfigurationError(
      `${unresolved.length} price-impacting attribute(s) have no authoritative base configuration value and no Salesforce data proves one — refusing to create any Attribute Adjustment Condition (this would leave the org partially populated, exactly the failure mode this check prevents).\n\n` +
      unresolved.map(([name]) => `Attribute: ${name}\nProduct: ${args.product.name}\nReason: No effective value exists for a required price-impacting attribute (checked: product-specific Default Value, product-classification-inherited Default Value, and whether exactly one configured picklist value exists — none resolved). A baseline value is required by the Salesforce Attribute-Based Adjustment model.`).join("\n\n") +
      `\n\nSet a Default Value (directly on this product, or on its Product Classification) for the attribute(s) above in Setup, then try again. Full resolution report:\n\n${resolutionReport}`,
      missingAttributes, resolvedAttributes,
    );
  }
  const defaultValueByAttr = new Map<string, string | null>(priceImpactingEntries.map(([name]) => [name, baseConfig.attributes[name].value]));

  // §Part 5 — sanity check: does this PRODUCT actually have MORE price-impacting attributes than what
  // `contexts` (scoped to the attributes referenced by the requested pricing rules) covers? Never
  // silently assumed complete — a real discrepancy here means some price-impacting attribute has no
  // pricing rule at all, which Salesforce's own requirement would still demand a condition for; logged
  // loudly as a warning (not a hard fail — building rules for un-requested attributes is out of scope
  // for this run) so it's visible rather than silently wrong.
  try {
    const padDescribe = await new SchemaCache(client).get("ProductAttributeDefinition");
    const padProductField = resolveReferenceField(padDescribe, "Product2").field;
    const padPriceImpactingField = resolvePriceImpactingField(padDescribe);
    if (padProductField && padPriceImpactingField) {
      const allRes = await client.query<{ Id: string }>(
        `SELECT Id FROM ProductAttributeDefinition WHERE ${padProductField.name} = '${soqlEscape(args.product.id)}' AND ${padPriceImpactingField.name} = true`,
      );
      if (allRes.records.length > priceImpactingEntries.length) {
        client.logDebug(
          "execution-trace",
          `WARNING — this product has ${allRes.records.length} price-impacting attribute(s) on ProductAttributeDefinition, but only ${priceImpactingEntries.length} are covered by the requested pricing rules' own attribute contexts. Any price-impacting attribute NOT covered here will be missing from every rule's condition set — Salesforce may still reject adjustments on a fresh/stricter org for that reason. This run only builds conditions for the attributes its rules actually reference.`,
        );
      }
    }
  } catch (err) {
    client.logDebug("execution-trace", `Price-impacting attribute completeness check failed (non-fatal, informational only): ${err instanceof Error ? err.message : String(err)}`);
  }

  // §Part 8 — the internal condition plan, generated and logged BEFORE any Salesforce write. Shows
  // BOTH the rule's own varying condition AND every OTHER price-impacting attribute's baseline-default
  // condition — the complete set Salesforce's own documented model requires per rule, not just the one
  // attribute each pricing rule is nominally "about."
  const pendingPlans = plans.filter(p => !p.reusedExisting);
  const conditionPlan = pendingPlans.map(p => ({
    rule: sanitizeRuleName(p.row.attributeName, p.row.value),
    conditions: [
      { attribute: p.row.attributeName, value: p.row.value, operator: "Equal", role: "varying" },
      ...priceImpactingEntries
        .filter(([name]) => normalizeAttrName(name) !== normalizeAttrName(p.row.attributeName))
        .map(([name]) => ({ attribute: name, value: defaultValueByAttr.get(name) ?? null, operator: "Equal", role: "baseline-default" })),
    ],
  }));
  client.logDebug(
    "execution-trace",
    `AttributeAdjustmentCondition plan — ${conditionPlan.reduce((n, r) => n + r.conditions.length, 0)} condition(s) across ${conditionPlan.length} rule(s): 1 varying + ${Math.max(0, priceImpactingEntries.length - 1)} baseline-default condition(s) per rule (every price-impacting attribute represented, per Salesforce's own documented requirement — see the reversed fix above):\n${JSON.stringify(conditionPlan, null, 2)}`,
  );

  // §Part 9 — the complete condition matrix, resolved and validated ENTIRELY in memory before any
  // Salesforce write in this loop begins. Every association's value already traces to either the
  // rule's own row.value (varying) or `baseConfig` (baseline-default, already proven non-null by the
  // hard gate above) — there is nothing left to invent or discover once this block runs.
  const expectedAssociations = pendingPlans.length * priceImpactingEntries.length;
  const actualAssociations = conditionPlan.reduce((n, r) => n + r.conditions.length, 0);
  client.logDebug("execution-trace", [
    "=== CONDITION MATRIX ===",
    "",
    `Rules: ${pendingPlans.length}`,
    `Price-impacting attributes: ${priceImpactingEntries.length}`,
    `Expected associations: ${expectedAssociations}`,
    "",
    `${actualAssociations === expectedAssociations ? "✓" : "✕"} ${actualAssociations}/${expectedAssociations} condition associations resolved`,
    "✓ All Salesforce IDs resolved (AttributeDefinitionId/ProductAttributeDefinitionId per attribute, confirmed above; RuleId per rule, confirmed at Rule creation/reuse — the Condition record's own Id is assigned by Salesforce at create time, never resolved in advance)",
    "✓ No invented values (every association's value traces to either the rule's own row value or the validated Base Product Configuration above)",
    "✓ No missing baseline values (the hard gate above already refused to reach this point otherwise)",
  ].join("\n"));

  /** One condition create-or-reuse, parametrized by identity/value — shared by the rule's own varying
   * condition and every other attribute's baseline-default condition (identical mechanics, only the
   * identity/value source differs). `expectedProductId` (Part 2/3 of the Product-consistency fix) is the
   * rule's OWN resolved product — the single source of truth passed down from the caller, never derived
   * here from the attribute/value/array position. */
  async function createOrReuseOneCondition(
    ruleId: string, attributeName: string, valueLabel: string, ctx: AttributeContext, rawValue: string, expectedProductId: string | null,
  ): Promise<{ id: string; wasReused: boolean }> {
    const identity = resolveConditionIdentity(schema, ctx);
    if (!identity) {
      throw new Error(`AttributeAdjustmentCondition requires a ProductAttributeDefinition or AttributeDefinition reference, but none was resolved for attribute "${attributeName}" on this product.`);
    }
    const assignment = resolveConditionValueAssignment(schema.conditionDescribe, attributeName, ctx.dataType, ctx.dataTypeSource, rawValue);
    const existingId = await findExistingAttributeAdjustmentCondition(client, schema, ruleId, identity, { fieldName: assignment.fieldName, value: assignment.value }, expectedProductId);
    if (existingId) {
      client.logDebug("execution-trace", `Condition ${existingId}\nAttribute ${attributeName}\nValue ${valueLabel}\nProduct ${expectedProductId ?? "(not tracked on this org's schema)"}\nCompatibility: MATCH\nSource: REUSED`);
      onProgress?.(`✓ Reusing existing AttributeAdjustmentCondition for ${attributeName} = ${valueLabel}.`);
      return { id: existingId, wasReused: true };
    }

    const payload: Record<string, unknown> = {
      [schema.conditionRuleField.field!.name]: ruleId,
      [identity.fieldName]: identity.value,
      [assignment.fieldName]: assignment.value,
    };
    if (equalValue) payload[schema.conditionOperatorField!.name] = equalValue;
    if (assignment.dataTypeField) payload[assignment.dataTypeField.name] = assignment.dataTypeField.value;
    if (schema.conditionProductField.field) payload[schema.conditionProductField.field.name] = args.product.id;

    const resolvedLookups: ResolvedLookup[] = [{ targetObject: "AttributeBasedAdjRule", field: schema.conditionRuleField.field!, value: ruleId }];
    if (identity.kind === "pad") resolvedLookups.push({ targetObject: "ProductAttributeDefinition", field: schema.conditionPadField.field!, value: identity.value });
    else resolvedLookups.push({ targetObject: "AttributeDefinition", field: schema.conditionAttrDefField.field!, value: identity.value });
    if (schema.conditionProductField.field) resolvedLookups.push({ targetObject: "Product2", field: schema.conditionProductField.field, value: args.product.id });

    let conditionId: string;
    try {
      conditionId = await guardedCreate(client, "AttributeAdjustmentCondition", schema.conditionDescribe, payload, resolvedLookups, "create-condition");
    } catch (err) {
      if (isProductConsistencyError(err)) {
        // §Live-org fix (Laptop) — Salesforce itself just proved this Rule already has at least one
        // condition for a DIFFERENT product. Never silently corrected/retried — the Rule-level
        // product-scoped lookup above should make this unreachable for a NEWLY-resolved rule, so
        // reaching here means either this org exposes no Product2 field on Rule (can't be scoped) or the
        // Rule pre-dates this fix with already-mixed-product conditions attached. Surface the exact
        // conflict rather than guessing a fix.
        throw new Error(
          `Salesforce rejected AttributeAdjustmentCondition creation for ${attributeName} = ${valueLabel} on Rule ${ruleId}: "${err instanceof Error ? err.message : String(err)}". ` +
          `This means Rule ${ruleId} already has at least one AttributeAdjustmentCondition for a DIFFERENT product than ${expectedProductId ?? args.product.id}. ` +
          `Never auto-corrected — a Salesforce admin must resolve which product this Rule legitimately belongs to (Setup > AttributeBasedAdjRule ${ruleId}), or this pipeline's Rule-lookup must find/create a separate, correctly product-scoped Rule instead.`,
        );
      }
      throw err;
    }
    client.logDebug("execution-trace", `Condition ${conditionId}\nAttribute ${attributeName}\nValue ${valueLabel}\nProduct ${schema.conditionProductField.field ? args.product.id : "(not tracked on this org's schema)"}\nCompatibility: MATCH\nSource: CREATED`);
    onProgress?.(`✓ Created AttributeAdjustmentCondition for ${attributeName} = ${valueLabel}.`);
    return { id: conditionId, wasReused: false };
  }

  for (const plan of pendingPlans) {
    const { row, ctx, ruleId, ruleProductId } = plan;

    // §Part 2 (Product-consistency fix) — the Rule's OWN resolved product (established once, when the
    // Rule itself was created/reused — see `createOrReuseAttributeBasedAdjRules`) is the single source of
    // truth for every condition built here. Never derived from the current attribute/value/array
    // position. A mismatch here means the Rule this plan resolved to does not actually belong to the
    // product this run is processing — stop before creating anything for it, per Part 2's explicit
    // "do not POST; do not silently correct; produce a detailed diagnostic."
    if (ruleProductId !== null && ruleProductId !== args.product.id) {
      throw new Error(
        `Rule ${ruleId} (for ${row.attributeLabel} = ${row.valueLabel}) resolved to Product ${ruleProductId}, but this run is processing Product ${args.product.id} — refusing to create Attribute Adjustment Conditions for a Rule that Salesforce already associates with a different product.`,
      );
    }
    client.logDebug("execution-trace", `Rule ${ruleId}\nExpected Product ${args.product.id}`);

    // §Invariant preserved — the OWN (varying) condition is always pushed FIRST into plan.conditionIds;
    // createAttributeBasedAdjustments reads `thisRuleConditionIds[0]` as "this rule's own priced
    // condition," never an arbitrary baseline-default one.
    const own = await createOrReuseOneCondition(ruleId, row.attributeName, row.valueLabel, ctx, row.value, ruleProductId ?? args.product.id);
    (own.wasReused ? reusedConditionIds : conditionIds).push(own.id);
    plan.conditionIds.push(own.id);

    // Every OTHER price-impacting attribute on this product needs its own baseline-default condition
    // on this SAME rule — Salesforce's own documented requirement, never skipped, never invented.
    const otherResults: { attribute: string; value: string; id: string; wasReused: boolean }[] = [];
    for (const [otherName, otherCtx] of priceImpactingEntries) {
      if (normalizeAttrName(otherName) === normalizeAttrName(row.attributeName)) continue;
      const defaultValue = defaultValueByAttr.get(otherName);
      if (!defaultValue) {
        // §Defensive backstop — should be unreachable: the upfront `resolveEffectiveAttributeValues`
        // gate above already refuses to reach this loop at all if any price-impacting attribute has no
        // resolvable effective value. Kept in case `defaultValueByAttr` is ever populated differently.
        throw new Error(
          `Attribute "${otherName}" is price-impacting on this product but has no resolvable effective value (checked product-specific Default Value, classification-inherited Default Value, and single-configured-value fallback). Salesforce requires every price-impacting attribute to be represented on every Attribute-Based Adjustment's condition set ("Associate all price impacting attributes with the relevant Attribute Adjustment Condition and try again") — this application never invents a value for a missing one.`,
        );
      }
      const other = await createOrReuseOneCondition(ruleId, otherName, defaultValue, otherCtx, defaultValue, ruleProductId ?? args.product.id);
      (other.wasReused ? reusedConditionIds : conditionIds).push(other.id);
      plan.conditionIds.push(other.id);
      otherResults.push({ attribute: otherName, value: defaultValue, id: other.id, wasReused: other.wasReused });
    }

    // §Part 12/14 — per-rule condition diagnostic, logged regardless of outcome, showing every
    // relationship Id involved (never a vague "creating condition" message).
    client.logDebug("execution-trace", [
      `Rule: ${sanitizeRuleName(row.attributeName, row.value)} (${ruleId})`,
      `Varying: ${row.attributeName} = ${row.value} -> Condition ${own.id} (${own.wasReused ? "reused" : "created"})`,
      otherResults.length > 0
        ? `Baseline-default: ${otherResults.map(o => `${o.attribute}=${o.value} -> Condition ${o.id} (${o.wasReused ? "reused" : "created"})`).join(", ")}`
        : "Baseline-default: (none — only one price-impacting attribute on this product)",
      `Total conditions for this rule: ${plan.conditionIds.length}`,
    ].join(" | "));
  }

  client.logDebug("execution-trace", [
    "AttributeAdjustmentCondition summary",
    `Requested rules needing conditions: ${pendingPlans.length}`,
    `Conditions reused: ${reusedConditionIds.length}`,
    `Conditions created: ${conditionIds.length}`,
    `Total conditions accounted for: ${reusedConditionIds.length + conditionIds.length} (expect up to ${pendingPlans.length} × ${priceImpactingEntries.length} = ${pendingPlans.length * priceImpactingEntries.length} if every attribute needed a brand-new condition on every rule)`,
  ].join("\n"));
  step(steps, "create-condition", "success", `${conditionIds.length} condition(s) created, ${reusedConditionIds.length} reused.`);
  return { conditionIds, reusedConditionIds };
}

/* ── §Issue 3 — Attribute-Based Adjustment idempotency helpers.
 *
 * Schema investigation (Issue 6) done via the SAME already-resolved `AttributeBasedPricingSchema` —
 * no new field names invented: Product/SellingModel/Schedule/EffectiveFrom/EffectiveTo are exactly
 * `schema.abaProductField`/`abaSellingModelField`/`abaScheduleField`/`abaEffFromField`/`abaEffToField`
 * (already resolved via Describe when the schema was prepared), and AttributeBasedAdjustment connects
 * to its conditions via its Rule (`schema.abaRuleField`) — a Condition's own Rule lookup
 * (`schema.conditionRuleField`) is what ties a whole SET of conditions to one Rule, which is what the
 * real live Salesforce error ("attribute condition*s*", plural) is actually keyed on: not the single
 * `abaConditionField` value one particular Adjustment record happens to point at, but the FULL set of
 * conditions belonging to that Adjustment's Rule. That's why, empirically, every attempt after the
 * first one for the SAME Rule (looping over `thisRuleConditionIds`) hit the identical
 * FIELD_INTEGRITY_EXCEPTION — they all share the same Rule, hence the same condition set, hence the
 * same uniqueness key. ── */

const CONDITION_VALUE_KINDS: ValueKind[] = ["string", "integer", "double", "boolean", "date", "datetime", "picklist", "multipicklist"];

/** Every distinct typed-value field name this org's AttributeAdjustmentCondition actually has (across
 * every possible data-type kind) — read generically so a condition's real, whatever's-non-null stored
 * value can be recovered without needing to already know that specific condition's data type. */
function collectConditionValueFieldNames(conditionDescribe: DescribeResult): string[] {
  const names = new Set<string>();
  for (const kind of CONDITION_VALUE_KINDS) {
    const resolved = resolveTypedValueField(conditionDescribe, kind);
    if (resolved.field) names.add(resolved.field.name);
  }
  return [...names];
}

/** Every resolved ProductAttributeDefinition/AttributeDefinition Id (for the attributes THIS run
 * cares about) mapped back to that attribute's own name — Issue 3D's "use stable Salesforce IDs
 * where possible instead of comparing display names," applied to identifying WHICH attribute an
 * existing Salesforce condition record is actually about. */
export function buildAttributeIdentityReverseMap(contexts: Map<string, AttributeContext>): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [name, ctx] of contexts) {
    if (ctx.productAttributeDefinitionId) reverse.set(ctx.productAttributeDefinitionId, name);
    if (ctx.attributeDefinitionId) reverse.set(ctx.attributeDefinitionId, name);
  }
  return reverse;
}

export interface RuleConditionSignatureResult {
  /** `""` ONLY when the rule genuinely has zero resolvable conditions AND the query itself succeeded
   * — never when the query failed (see `queryFailed`) or a condition's attribute couldn't be resolved
   * (see `unresolvedConditionIds`). Callers must treat `""` as "unknown," NEVER as a value that can
   * equal another `""` (§Critical fix below). */
  signature: string;
  tokens: string[];
  /** True when the underlying SOQL call itself threw — the previous version silently swallowed this
   * and returned an empty signature indistinguishable from "genuinely no conditions," which is the
   * root cause of the false-reuse bug: two DIFFERENT rules whose signature queries both failed would
   * both produce `""`, and `"" === ""` was being treated as an exact match. */
  queryFailed: boolean;
  /** Condition records found for this rule whose identity field didn't resolve to a known attribute —
   * excluded from the signature rather than guessed; a non-empty list here means the signature is
   * incomplete and should not be trusted as a full representation of this rule. */
  unresolvedConditionIds: string[];
  /** §Live-org fix (Monitor, Product-consistency) — every DISTINCT Product2Id value found among this
   * rule's own conditions (via `schema.conditionProductField`, when this org exposes it). Normally
   * exactly one element; zero means this org's AttributeAdjustmentCondition has no Product2 field at all
   * (nothing to check). MORE than one element means this rule's conditions genuinely belong to different
   * products — the exact "logical signature matches, but the real Product2 relationship doesn't" gap that
   * let a Monitor-style false match through: two DIFFERENT products' rules can produce a byte-identical
   * `attribute=value` token signature (e.g. both happen to have "Display=1080p..."/"ScreenSize=13 Inch"),
   * but they are never the SAME configuration. Callers MUST treat a signature with >1 distinct product as
   * untrustworthy — never matched against anything, exactly like `queryFailed`. */
  distinctConditionProductIds: (string | null)[];
}

/**
 * One normalized `attributeName=value` token per condition belonging to `ruleId`, sorted — so two
 * Rules asserting the exact same attribute/value set produce an IDENTICAL signature regardless of
 * condition creation order or the specific Condition record Ids involved (Issue 3D/Part 3). A condition
 * about an attribute outside this run's scope (shouldn't happen, but never assumed) is skipped rather
 * than guessed. Computed fresh from Salesforce every time — this is the SAME function for both "this
 * request's Rule" and "an existing candidate's Rule," so the comparison is symmetric by construction.
 *
 * §Critical fix — never silently treats a query failure as "no conditions." A prior version caught
 * any query error and returned an empty-records result, producing an empty signature indistinguishable
 * from a rule that genuinely has none — and since two empty signatures compared equal, ANY rule whose
 * signature query failed for any reason would falsely "exact match" the first candidate examined
 * whose signature also happened to be empty (query failure or otherwise). This is almost certainly
 * what produced the reported bug (5 unrelated attribute/value rules all reusing the same Adjustment).
 */
async function computeRuleConditionSignature(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  ruleId: string,
): Promise<RuleConditionSignatureResult> {
  const valueFieldNames = collectConditionValueFieldNames(schema.conditionDescribe);
  const identityFieldNames = [schema.conditionPadField.field?.name, schema.conditionAttrDefField.field?.name].filter((n): n is string => !!n);
  const productFieldName = schema.conditionProductField.field?.name ?? null;
  const selectFields = [...new Set(["Id", ...identityFieldNames, ...valueFieldNames, ...(productFieldName ? [productFieldName] : [])])];
  const soql = `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`;

  let records: (Record<string, unknown> & { Id: string })[];
  try {
    records = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
  } catch (err) {
    client.logDebug(
      "execution-trace",
      `computeRuleConditionSignature — query FAILED for Rule ${ruleId}: ${err instanceof Error ? err.message : String(err)}. SOQL: ${soql}. Signature is UNAVAILABLE and will never be treated as matching anything.`,
    );
    return { signature: "", tokens: [], queryFailed: true, unresolvedConditionIds: [], distinctConditionProductIds: [] };
  }

  const tokens: string[] = [];
  const unresolvedConditionIds: string[] = [];
  for (const rec of records) {
    let identityId: string | null = null;
    for (const f of identityFieldNames) {
      const v = rec[f];
      if (typeof v === "string" && v) { identityId = v; break; }
    }
    const attributeName = identityId ? attributeIdentityById.get(identityId) : undefined;
    if (!attributeName) {
      unresolvedConditionIds.push(rec.Id);
      continue;
    }

    let valueToken = "*";
    for (const f of valueFieldNames) {
      const v = rec[f];
      // §Step 5 fix — trim + collapse-whitespace + lowercase (not lowercase alone): a value differing
      // from the requested one only by incidental whitespace (a trailing space, a double space) must
      // still compare as identical, or a genuine duplicate can look different to this app alone even
      // though Salesforce itself treats the two as the same configuration.
      if (v !== null && v !== undefined && v !== "") { valueToken = normalizeConditionText(v); break; }
    }
    tokens.push(`${normalizeAttrName(attributeName)}=${valueToken}`);
  }
  if (unresolvedConditionIds.length > 0) {
    client.logDebug(
      "execution-trace",
      `computeRuleConditionSignature — Rule ${ruleId}: ${unresolvedConditionIds.length} condition record(s) could not be mapped back to a known attribute (${unresolvedConditionIds.join(", ")}) — excluded from the signature rather than guessed.`,
    );
  }

  // §Live-org fix (Monitor, Product-consistency) — fold the rule's own Product2 relationship INTO the
  // signature itself, so two different products' rules can never produce an identical signature merely
  // because their attribute=value tokens happen to coincide. When this org's schema doesn't expose the
  // field at all (`productFieldName === null`), every record's "value" is uniformly `null`, so this adds
  // no discriminating power but also introduces no false distinction — a graceful no-op, not a guess.
  const distinctConditionProductIds = [...new Set(records.map(r => productFieldName ? ((r[productFieldName] as string | null | undefined) ?? null) : null))];
  if (distinctConditionProductIds.length > 1) {
    client.logDebug(
      "execution-trace",
      `computeRuleConditionSignature — Rule ${ruleId}: conditions belong to ${distinctConditionProductIds.length} DIFFERENT products (${distinctConditionProductIds.map(p => p ?? "(none)").join(", ")}) — this rule's conditions are genuinely Product-inconsistent. Signature is UNTRUSTWORTHY and will never be treated as matching anything.`,
    );
  }
  const productPrefix = `product=${distinctConditionProductIds.length === 1 ? (distinctConditionProductIds[0] ?? "(none)") : "(mixed-or-unknown)"}`;
  return { signature: `${productPrefix}|${tokens.sort().join("|")}`, tokens, queryFailed: false, unresolvedConditionIds, distinctConditionProductIds };
}

/**
 * §Root-cause fix (this turn) — the ONE canonical identity Salesforce itself enforces, taken directly
 * from its own FIELD_INTEGRITY_EXCEPTION text: "An attribute based adjustment with the selected
 * Product, Product Selling Model, attribute conditions, Price Adjustment Schedule, effective from date,
 * and effective to date already exists." That is: Product + ProductSellingModel + the COMPLETE
 * condition set + PriceAdjustmentSchedule + EffectiveFrom + EffectiveTo. Notably NOT
 * AttributeBasedAdjRule — Follow-on 43's "match by Product+Schedule+RuleId" fix, while it correctly
 * solved a real bug (two rules whose signature-matching query had silently failed were falsely treated
 * as identical), was built on an incorrect assumption about what Salesforce's own uniqueness key
 * actually is. That is exactly why the very next live run hit this native duplicate-adjustment error:
 * two different Rules (e.g. Memory-at-its-own-baseline and Graphics-at-its-own-baseline) can
 * legitimately produce a byte-identical complete condition set — every Rule carries a full 6-attribute
 * condition set (Follow-on 39-42), so any Rule whose own varying value sits at that attribute's own
 * baseline is indistinguishable, by configuration, from every other "at baseline" Rule — and Salesforce
 * enforces that only ONE AttributeBasedAdjustment may ever exist for one exact configuration,
 * regardless of which Rule asked for it. Every part of this module now builds and compares this SAME
 * identity shape (find, create, post-create verify, duplicate-error reconciliation) so there is exactly
 * one place that could disagree with itself.
 */
export interface AttributeBasedAdjustmentIdentity {
  productId: string;
  productSellingModelId: string | null;
  priceAdjustmentScheduleId: string;
  effectiveFrom: string;
  effectiveTo: string;
  conditionSignature: string;
}

/** Salesforce may report a Date field as `"2026-08-18"` and a DateTime field as
 * `"2026-08-18T00:00:00.000+0000"` — both start with the same 10-char calendar date, which is all this
 * pipeline ever sends or needs to compare (never a full timestamp match that would spuriously fail
 * against a Date-typed field just because of a time-of-day/offset suffix Salesforce added). */
function normalizeDateValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v).slice(0, 10);
}

function formatAdjustmentIdentityForLog(id: AttributeBasedAdjustmentIdentity): string {
  return `Product=${id.productId} | ProductSellingModel=${id.productSellingModelId ?? "(none)"} | Schedule=${id.priceAdjustmentScheduleId} | EffectiveFrom=${normalizeDateValue(id.effectiveFrom)} | EffectiveTo=${normalizeDateValue(id.effectiveTo)} | Conditions=${id.conditionSignature}`;
}

/** Deterministic string for the in-memory reuse cache (Part 11) — every component of the real
 * Salesforce uniqueness key, never a partial key like attribute name/value/Rule Id alone. */
function serializeAdjustmentIdentity(id: AttributeBasedAdjustmentIdentity): string {
  return [id.productId, id.productSellingModelId ?? "(none)", id.priceAdjustmentScheduleId, normalizeDateValue(id.effectiveFrom) ?? "(none)", normalizeDateValue(id.effectiveTo) ?? "(none)", id.conditionSignature].join("::");
}

/** §Phase 1/2 fix (this turn) — three distinct concepts a caller must never conflate: this is the shape
 * for BOTH the narrow and broad candidate lookups, so both surface the matched candidate's OWN stored
 * AdjustmentType/AdjustmentValue alongside its identity match. A matching Product+SellingModel+Schedule+
 * EffectiveFrom/To+condition set (ADJUSTMENT IDENTITY) does NOT by itself mean the requested ADJUSTMENT
 * VALUE also agrees — the caller compares `existingAdjustmentType`/`existingAdjustmentValue` against what
 * this run requests and classifies accordingly (same value → auto-reuse; different value → a genuine
 * conflict requiring a user decision, never silently reused or silently overwritten). */
interface AdjustmentMatchResult {
  id: string | null;
  candidateCount: number;
  existingAdjustmentType: string | null;
  existingAdjustmentValue: number | null;
}

async function findExistingAttributeBasedAdjustment(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  requested: AttributeBasedAdjustmentIdentity,
): Promise<AdjustmentMatchResult> {
  // Broad candidate scan by Product + Schedule ONLY (never Rule-scoped) — Salesforce's own uniqueness
  // key has no Rule component, so filtering candidates by Rule would (and did) miss a legitimate match
  // attached to a DIFFERENT Rule whose complete condition set happens to be identical.
  const selectFields = ["Id",
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
    ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
    ...(schema.abaValueField ? [schema.abaValueField.name] : []),
  ];
  const whereClauses: string[] = [];
  if (schema.abaProductField.field) whereClauses.push(`${schema.abaProductField.field.name} = '${soqlEscape(requested.productId)}'`);
  if (schema.abaScheduleField.field) whereClauses.push(`${schema.abaScheduleField.field.name} = '${soqlEscape(requested.priceAdjustmentScheduleId)}'`);
  const soql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM AttributeBasedAdjustment${whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""}`;
  client.logDebug("execution-trace", [
    "AttributeBasedAdjustment preflight — broad candidate scan by Product + Schedule (never Rule-scoped; Salesforce's own uniqueness key has no Rule component):",
    soql,
    `REQUESTED IDENTITY: ${formatAdjustmentIdentityForLog(requested)}`,
  ].join("\n"));

  let candidateRecords: (Record<string, unknown> & { Id: string })[];
  try {
    candidateRecords = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
  } catch (err) {
    client.logDebug("execution-trace", `AttributeBasedAdjustment preflight — candidate query FAILED: ${err instanceof Error ? err.message : String(err)}. Treating as "no candidates found" (safe: will attempt CREATE, never falsely reuse).`);
    return { id: null, candidateCount: 0, existingAdjustmentType: null, existingAdjustmentValue: null };
  }

  let chosen: string | null = null;
  let chosenType: string | null = null;
  let chosenValue: number | null = null;
  for (const rec of candidateRecords) {
    const candidateSellingModel = schema.abaSellingModelField.field ? ((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) : null;
    const candidateEffFrom = schema.abaEffFromField ? rec[schema.abaEffFromField.name] : undefined;
    const candidateEffTo = schema.abaEffToField ? rec[schema.abaEffToField.name] : undefined;
    const candidateRuleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;
    const candidateType = schema.abaTypeField ? ((rec[schema.abaTypeField.name] as string | null | undefined) ?? null) : null;
    const candidateValue = schema.abaValueField ? ((rec[schema.abaValueField.name] as number | null | undefined) ?? null) : null;

    // §Phase 11 fix — every candidate now gets a field-by-field MATCH/DIFFERENT breakdown (never a bare
    // pass/fail), so a "no match" outcome is explainable from the log alone instead of another guess.
    const productSellingModelMatch = (requested.productSellingModelId ?? null) === candidateSellingModel;
    const effFromMatch = !schema.abaEffFromField || normalizeDateValue(requested.effectiveFrom) === normalizeDateValue(candidateEffFrom);
    const effToMatch = !schema.abaEffToField || normalizeDateValue(requested.effectiveTo) === normalizeDateValue(candidateEffTo);

    // Cheap field comparisons first (no extra query) — only candidates that pass ALL of these are worth
    // the cost of resolving their Rule's actual condition signature.
    const cheapMismatches: string[] = [];
    if (!productSellingModelMatch) cheapMismatches.push(`ProductSellingModel: requested=${requested.productSellingModelId ?? "(none)"} vs candidate=${candidateSellingModel ?? "(none)"}`);
    if (!effFromMatch) cheapMismatches.push(`EffectiveFrom: requested=${normalizeDateValue(requested.effectiveFrom)} vs candidate=${normalizeDateValue(candidateEffFrom)}`);
    if (!effToMatch) cheapMismatches.push(`EffectiveTo: requested=${normalizeDateValue(requested.effectiveTo)} vs candidate=${normalizeDateValue(candidateEffTo)}`);
    if (!candidateRuleId) cheapMismatches.push("no AttributeBasedAdjRule reference — cannot resolve its condition signature");

    if (cheapMismatches.length > 0) {
      client.logDebug("execution-trace", [
        `AttributeBasedAdjustment preflight — CANDIDATE ${rec.Id}`,
        `  Product: MATCH (scoped by SOQL WHERE)`,
        `  ProductSellingModel: ${productSellingModelMatch ? "MATCH" : "DIFFERENT"}`,
        `  Schedule: MATCH (scoped by SOQL WHERE)`,
        `  EffectiveFrom: ${effFromMatch ? "MATCH" : "DIFFERENT"}`,
        `  EffectiveTo: ${effToMatch ? "MATCH" : "DIFFERENT"}`,
        `  Conditions: (not evaluated — ruled out above)`,
        `  Ruled out without a condition-signature query: ${cheapMismatches.join("; ")}`,
      ].join("\n"));
      continue;
    }

    const candidateSignatureResult = await computeRuleConditionSignature(client, schema, attributeIdentityById, candidateRuleId!);
    // §Live-org fix (Monitor, Product-consistency) — a candidate whose OWN conditions belong to more than
    // one product is never trustworthy, regardless of whether its (now product-prefixed) signature string
    // happens to equal the requested one — treated identically to `queryFailed`, never matched.
    const conditionsMatch = !candidateSignatureResult.queryFailed && candidateSignatureResult.distinctConditionProductIds.length <= 1
      && !!candidateSignatureResult.signature && candidateSignatureResult.signature === requested.conditionSignature;
    const isExactMatch = conditionsMatch;

    client.logDebug("execution-trace", [
      `AttributeBasedAdjustment preflight — CANDIDATE ${rec.Id} (Rule ${candidateRuleId})`,
      `  Product: MATCH (scoped by SOQL WHERE)`,
      `  ProductSellingModel: MATCH`,
      `  Schedule: MATCH (scoped by SOQL WHERE)`,
      `  EffectiveFrom: MATCH`,
      `  EffectiveTo: MATCH`,
      `  Conditions: ${conditionsMatch ? "MATCH" : "DIFFERENT"}`,
      conditionsMatch ? "" : `    Requested: ${requested.conditionSignature}`,
      conditionsMatch ? "" : `    Candidate: ${candidateSignatureResult.queryFailed ? "(query FAILED — could not reconstruct)" : candidateSignatureResult.signature || "(empty)"}`,
      candidateSignatureResult.distinctConditionProductIds.length > 1
        ? `  ✕ Product-inconsistent: this candidate's Rule has conditions across ${candidateSignatureResult.distinctConditionProductIds.length} different products (${candidateSignatureResult.distinctConditionProductIds.map(p => p ?? "(none)").join(", ")}) — never matched.`
        : "",
      `  Adjustment: ${schema.abaTypeField || schema.abaValueField ? `type=${candidateType ?? "(none)"}, value=${candidateValue ?? "(none)"}` : "(not tracked on this org's schema)"}`,
      `  MATCH: ${isExactMatch}`,
    ].filter(Boolean).join("\n"));

    if (isExactMatch) { chosen = rec.Id; chosenType = candidateType; chosenValue = candidateValue; break; }
  }

  client.logDebug("execution-trace", chosen
    ? `AttributeBasedAdjustment preflight — exact identity match found: ${chosen} (existing adjustment: type=${chosenType ?? "(none)"}, value=${chosenValue ?? "(none)"}).`
    : `AttributeBasedAdjustment preflight — no existing AttributeBasedAdjustment exactly matches this requested identity (checked ${candidateRecords.length} candidate(s)); will create.`);
  return { id: chosen, candidateCount: candidateRecords.length, existingAdjustmentType: chosenType, existingAdjustmentValue: chosenValue };
}

/* ── §Broad duplicate-reconciliation fallback (this turn) ──
 *
 * Root cause of "Salesforce rejected ... as a duplicate ... but a re-query ... found no exact match":
 * `findExistingAttributeBasedAdjustment` above (used for BOTH the normal preflight and, until this fix,
 * the ONLY reconciliation attempt after a Salesforce duplicate rejection) requires every candidate's
 * condition set to be resolved through `computeRuleConditionSignature`, which in turn requires every
 * Condition's identity Id (ProductAttributeDefinitionId/AttributeDefinitionId) to reverse-map to a known
 * attribute NAME via `attributeIdentityById` (built from THIS run's own `contexts`). Salesforce's own
 * duplicate check has no such requirement — it compares the real stored records directly. So whenever
 * this run's `contexts` cannot name-resolve one of the real duplicate's identity Ids (e.g. a
 * ProductAttributeDefinition override row resolved differently across two runs, or an attribute this
 * run's contexts map doesn't carry for some other reason), `computeRuleConditionSignature` silently
 * excludes that condition, produces a signature that can never equal the requested one, and the genuinely
 * matching candidate gets excluded as a "queryFailed"/mismatched candidate — even though Salesforce just
 * proved a byte-for-byte duplicate exists. It's also possible for a real candidate to be excluded outright
 * by the strict pass's cheap-mismatch pre-filter (SellingModel/EffectiveFrom/EffectiveTo/no Rule
 * reference) before its conditions are ever compared.
 *
 * Per Step 6 of the fix spec, this is invoked ONLY after Salesforce's own duplicate rejection AND the
 * strict re-query above already failed — never as a replacement for it, never used for the normal
 * preflight (so the already-working preflight path is untouched). It widens the search along exactly two
 * axes, both grounded in real Salesforce data:
 *   1. No cheap-field pre-exclusion — every Product+Schedule candidate is evaluated and logged.
 *   2. Condition-set comparison by RAW identity Id + normalized value (`fetchRawConditionSet`), never by
 *      attribute name — immune to a name-reverse-map gap that would make an objectively identical
 *      condition set look different to this app alone.
 * Still requires Product + SellingModel + Schedule + EffectiveFrom/To + the COMPLETE condition set to all
 * agree (Step 8 — never a match on Storage, or any single field, alone) and never on an empty/unresolved
 * condition set (Step 12 — never a guess). Returns `id: null` when even this broader pass finds nothing —
 * the caller then reports a genuine conflict, exactly as before.
 */
interface RawConditionEntry { identityId: string; value: string }

/** Step 5's canonical normalization — order/case/whitespace-insensitive, but never collapses genuinely
 * different values (e.g. "256GB" vs "512GB", "I5" vs "I7") into each other. */
function normalizeConditionText(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The real Salesforce condition set for one Rule, keyed by the RAW identity Id Salesforce itself stores
 * (ProductAttributeDefinitionId or AttributeDefinitionId) — never resolved back to a human attribute name,
 * so this cannot be defeated by a name-reverse-map gap the way `computeRuleConditionSignature` can. */
async function fetchRawConditionSet(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  ruleId: string,
): Promise<{ entries: RawConditionEntry[]; queryFailed: boolean }> {
  const valueFieldNames = collectConditionValueFieldNames(schema.conditionDescribe);
  const identityFieldNames = [schema.conditionPadField.field?.name, schema.conditionAttrDefField.field?.name].filter((n): n is string => !!n);
  const selectFields = [...new Set(["Id", ...identityFieldNames, ...valueFieldNames])];
  const soql = `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`;

  let records: (Record<string, unknown> & { Id: string })[];
  try {
    records = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
  } catch (err) {
    client.logDebug("execution-trace", `fetchRawConditionSet — query FAILED for Rule ${ruleId}: ${err instanceof Error ? err.message : String(err)}. SOQL: ${soql}`);
    return { entries: [], queryFailed: true };
  }

  const entries: RawConditionEntry[] = [];
  for (const rec of records) {
    let identityId: string | null = null;
    for (const f of identityFieldNames) {
      const v = rec[f];
      if (typeof v === "string" && v) { identityId = v; break; }
    }
    if (!identityId) continue; // no identity at all — never guessed, simply excluded from the raw set.
    let valueToken = "";
    for (const f of valueFieldNames) {
      const v = rec[f];
      if (v !== null && v !== undefined && v !== "") { valueToken = normalizeConditionText(v); break; }
    }
    entries.push({ identityId, value: valueToken });
  }
  return { entries, queryFailed: false };
}

/** Deterministic, order-insensitive string for one raw condition set — sorted by identity Id so two sets
 * containing the exact same (identityId, value) pairs always produce an identical key regardless of the
 * order Salesforce happened to return them in. */
function rawConditionSetKey(entries: RawConditionEntry[]): string {
  return [...entries]
    .sort((a, b) => a.identityId.localeCompare(b.identityId) || a.value.localeCompare(b.value))
    .map(e => `${e.identityId}=${e.value}`)
    .join("|");
}

/** Never treats two EMPTY/unresolved sets as equivalent (Step 12 — never a guess); otherwise a full,
 * order/case/whitespace-insensitive set comparison (Step 5) that still requires every real value to match
 * exactly (Step 5's Storage-256GB-vs-512GB, Processor-i5-vs-i7 examples — never collapsed). */
function rawConditionSetsEquivalent(a: RawConditionEntry[], b: RawConditionEntry[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return rawConditionSetKey(a) === rawConditionSetKey(b);
}

async function broadFindExistingAttributeBasedAdjustment(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  requested: AttributeBasedAdjustmentIdentity,
  requestedRuleId: string,
): Promise<AdjustmentMatchResult> {
  const log = (msg: string) => client.logDebug("execution-trace", `[ABP] ${msg}`);

  const selectFields = ["Id",
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
    ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
    ...(schema.abaValueField ? [schema.abaValueField.name] : []),
  ];
  const whereClauses: string[] = [];
  if (schema.abaProductField.field) whereClauses.push(`${schema.abaProductField.field.name} = '${soqlEscape(requested.productId)}'`);
  if (schema.abaScheduleField.field) whereClauses.push(`${schema.abaScheduleField.field.name} = '${soqlEscape(requested.priceAdjustmentScheduleId)}'`);
  const soql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM AttributeBasedAdjustment${whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""}`;
  log(`Broad lookup — re-scanning by Product + Schedule ONLY, no cheap-field pre-exclusion this time: ${soql}`);

  let candidateRecords: (Record<string, unknown> & { Id: string })[];
  try {
    candidateRecords = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
  } catch (err) {
    log(`Broad lookup — candidate query FAILED: ${err instanceof Error ? err.message : String(err)}. Treating as "no candidates found."`);
    return { id: null, candidateCount: 0, existingAdjustmentType: null, existingAdjustmentValue: null };
  }
  log(`Broad lookup returned ${candidateRecords.length} candidate(s): ${candidateRecords.map(r => r.Id).join(", ") || "(none)"}`);

  const requestedRaw = await fetchRawConditionSet(client, schema, requestedRuleId);
  log(`Requested Rule ${requestedRuleId} raw condition set: ${requestedRaw.queryFailed ? "(query FAILED)" : rawConditionSetKey(requestedRaw.entries) || "(empty)"}`);
  if (requestedRaw.queryFailed || requestedRaw.entries.length === 0) {
    log("Requested rule's own condition set could not be resolved — refusing to match anything against an unknown set.");
    return { id: null, candidateCount: candidateRecords.length, existingAdjustmentType: null, existingAdjustmentValue: null };
  }

  // §Root-cause investigation (this turn) — every candidate's full comparison is computed ONCE and kept,
  // so a failed exact-date match can fall through to an overlap-date re-check without re-querying
  // conditions a second time, and so the final "genuine conflict" diagnostic (if it comes to that) can
  // dump every candidate's complete picture rather than only the one that happened to be inspected last.
  interface CandidateEvaluation {
    id: string; ruleId: string | undefined;
    sellingModelMatch: boolean; effFromExact: boolean; effToExact: boolean; datesOverlap: boolean;
    conditionsMatch: boolean; conditionsQueryFailed: boolean; candidateConditionKey: string;
    type: string | null; value: number | null;
    rawRecord: Record<string, unknown> & { Id: string };
  }
  const evaluations: CandidateEvaluation[] = [];
  for (const rec of candidateRecords) {
    const candidateSellingModel = schema.abaSellingModelField.field ? ((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) : null;
    const candidateEffFrom = schema.abaEffFromField ? rec[schema.abaEffFromField.name] : undefined;
    const candidateEffTo = schema.abaEffToField ? rec[schema.abaEffToField.name] : undefined;
    const candidateRuleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;
    const candidateType = schema.abaTypeField ? ((rec[schema.abaTypeField.name] as string | null | undefined) ?? null) : null;
    const candidateValue = schema.abaValueField ? ((rec[schema.abaValueField.name] as number | null | undefined) ?? null) : null;

    const sellingModelMatch = (requested.productSellingModelId ?? null) === candidateSellingModel;
    const effFromExact = !schema.abaEffFromField || normalizeDateValue(requested.effectiveFrom) === normalizeDateValue(candidateEffFrom);
    const effToExact = !schema.abaEffToField || normalizeDateValue(requested.effectiveTo) === normalizeDateValue(candidateEffTo);
    const datesOverlap = (!schema.abaEffFromField && !schema.abaEffToField) || dateRangesOverlap(
      normalizeDateValue(requested.effectiveFrom), normalizeDateValue(requested.effectiveTo),
      schema.abaEffFromField ? normalizeDateValue(candidateEffFrom) : null, schema.abaEffToField ? normalizeDateValue(candidateEffTo) : null,
    );

    if (!candidateRuleId) {
      log(`CANDIDATE ${rec.Id} — Product: MATCH | ProductSellingModel: ${sellingModelMatch ? "MATCH" : "DIFFERENT"} | Schedule: MATCH | EffectiveFrom/To: exact=${effFromExact && effToExact}, overlap=${datesOverlap} | Conditions: (not evaluated — no AttributeBasedAdjRule reference to compare conditions against). Excluded (never guessed).`);
      continue;
    }
    const candidateRaw = await fetchRawConditionSet(client, schema, candidateRuleId);
    const conditionsMatch = !candidateRaw.queryFailed && rawConditionSetsEquivalent(requestedRaw.entries, candidateRaw.entries);
    evaluations.push({
      id: rec.Id, ruleId: candidateRuleId, sellingModelMatch, effFromExact, effToExact, datesOverlap,
      conditionsMatch, conditionsQueryFailed: candidateRaw.queryFailed,
      candidateConditionKey: candidateRaw.queryFailed ? "(query FAILED)" : rawConditionSetKey(candidateRaw.entries) || "(empty)",
      type: candidateType, value: candidateValue, rawRecord: rec,
    });
  }

  for (const e of evaluations) {
    log([
      `CANDIDATE ${e.id} (Rule ${e.ruleId})`,
      `  Product: MATCH (scoped by SOQL WHERE)`,
      `  ProductSellingModel: ${e.sellingModelMatch ? "MATCH" : "DIFFERENT"}`,
      `  Schedule: MATCH (scoped by SOQL WHERE)`,
      `  EffectiveFrom/EffectiveTo: exact-match=${e.effFromExact && e.effToExact}, date-ranges-overlap=${e.datesOverlap}`,
      `  Conditions: ${e.conditionsMatch ? "MATCH" : "DIFFERENT"}`,
      e.conditionsMatch ? "" : `    Requested: ${rawConditionSetKey(requestedRaw.entries)}`,
      e.conditionsMatch ? "" : `    Candidate: ${e.candidateConditionKey}`,
      `  Adjustment: ${schema.abaTypeField || schema.abaValueField ? `type=${e.type ?? "(none)"}, value=${e.value ?? "(none)"}` : "(not tracked on this org's schema)"}`,
    ].filter(Boolean).join("\n"));
  }

  // §Root-cause investigation — Tier 1: exact date match (the strict, previously-only criterion).
  const exactMatch = evaluations.find(e => e.sellingModelMatch && e.effFromExact && e.effToExact && e.conditionsMatch);
  if (exactMatch) {
    log(`Logically equivalent candidate found (exact date match): ${exactMatch.id} (existing adjustment: type=${exactMatch.type ?? "(none)"}, value=${exactMatch.value ?? "(none)"}). Reusing it.`);
    return { id: exactMatch.id, candidateCount: candidateRecords.length, existingAdjustmentType: exactMatch.type, existingAdjustmentValue: exactMatch.value };
  }

  // §Root-cause investigation — Tier 2: this pass ONLY runs because Salesforce itself already rejected
  // the create as a duplicate, so SOME record IS proven to conflict; if nothing agrees on the EXACT
  // EffectiveFrom/To, the most likely explanation this app has not yet tried is that Salesforce's real
  // uniqueness check for this org treats effective-date ranges as an OVERLAP constraint (a common pattern
  // for time-bound pricing/discount records — "no two records with the same configuration may have
  // overlapping active windows"), not exact equality — e.g. an adjustment created weeks ago
  // (EffectiveFrom=2026-08-19) whose one-year window still overlaps today's request
  // (EffectiveFrom=2026-09-18) would be silently invisible to an exact-date filter while still being a
  // real Salesforce-side conflict. This is a hypothesis, not an assumption: logged distinctly from an
  // exact match so the next live run's output confirms or refutes it directly, and it is NEVER used by
  // the normal (non-duplicate-triggered) preflight — only here, after Salesforce has already proven a
  // conflict exists and exact matching failed to locate it.
  const overlapMatch = evaluations.find(e => e.sellingModelMatch && e.datesOverlap && e.conditionsMatch);
  if (overlapMatch) {
    log(
      `[ROOT-CAUSE HYPOTHESIS] No candidate matched on EXACT EffectiveFrom/EffectiveTo, but ${overlapMatch.id} matches on Product+SellingModel+Schedule+conditions ` +
      `AND its effective date range OVERLAPS the requested one — Salesforce's real uniqueness check for effective dates may be OVERLAP-based, not exact-equality-based, on this org. ` +
      `Reusing ${overlapMatch.id} (existing adjustment: type=${overlapMatch.type ?? "(none)"}, value=${overlapMatch.value ?? "(none)"}). ` +
      `If this is wrong, the next log's "Genuine configuration conflict" diagnostics (if this guess is ever disabled) will show the raw date values for direct inspection.`,
    );
    return { id: overlapMatch.id, candidateCount: candidateRecords.length, existingAdjustmentType: overlapMatch.type, existingAdjustmentValue: overlapMatch.value };
  }

  log(`No logical equivalent candidate found among ${candidateRecords.length} candidate(s) — neither exact-date nor date-overlap matching found a Product+SellingModel+Schedule+condition match. Genuine configuration conflict.`);
  return { id: null, candidateCount: candidateRecords.length, existingAdjustmentType: null, existingAdjustmentValue: null };
}

/** True when two [from, to] date ranges (YYYY-MM-DD strings, either end possibly unknown/open) overlap at
 * all — the standard interval-overlap test (`aFrom <= bTo && bFrom <= aTo`), each missing bound treated as
 * open-ended rather than excluding the candidate outright (a null bound is "unknown," never "definitely
 * doesn't overlap"). Used ONLY as a post-duplicate-rejection reconciliation signal (see call site) — never
 * for the initial preflight, which stays on exact-date matching. */
function dateRangesOverlap(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null): boolean {
  if (aFrom && bTo && aFrom > bTo) return false;
  if (bFrom && aTo && bFrom > aTo) return false;
  return true;
}

/**
 * §Root-cause investigation (this turn) — fires ONLY once every reconciliation tier (exact-date, then
 * date-overlap) has already failed to find a match, i.e. only on the path to a genuine-conflict error.
 * This does not attempt yet another comparison heuristic — comparison heuristics are exactly what the
 * user's own report says have already been exhausted. Instead it gathers the raw evidence needed to
 * answer Steps 1/4-8 of that report directly from THIS org, and returns it as one block embedded in the
 * thrown error (never buried in debug-only logs the user might not think to paste back):
 *   - every field this app resolved for AttributeBasedAdjustment, its raw stored value on the FIRST
 *     Product-scoped candidate (if any), and whether that field is `accessible` per Describe (Step 8 —
 *     a record that exists but is FLS-hidden must never be silently treated as absent);
 *   - a Product-ONLY re-scan (Schedule dropped entirely) — proves whether the true conflicting record
 *     might carry a DIFFERENT Schedule than this run resolved (Step 7-I);
 *   - a zero-filter sanity query — proves whether this session can read ANY AttributeBasedAdjustment
 *     record at all, ruling out a wrong-object/no-access explanation (Step 7-A/K) independent of Product;
 *   - every RAW field on the FIRST Product-scoped candidate found (not just the ones this app's schema
 *     resolution chose to track) — the field this org's real duplicate validation actually keys on could
 *     be one `resolveReferenceField`'s heuristic scoring never picked (Step 1, Step 7-D/F/H).
 * Every step here is read-only. A failure at any point is reported as evidence in itself, never silently
 * swallowed — "the sanity query itself failed" IS an answer to Step 7.
 */
async function buildGenuineConflictDiagnostics(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  requested: AttributeBasedAdjustmentIdentity,
): Promise<string> {
  const lines: string[] = ["=== GENUINE CONFLICT — RAW SALESFORCE DIAGNOSTICS ==="];

  // Step 1 — the exact field this app resolved for each concept, plus its FLS accessibility, straight
  // from this org's own Describe of AttributeBasedAdjustment — so it can be checked directly against
  // Setup > Object Manager > Attribute Based Adjustment for a wrong-field-resolution mismatch.
  lines.push("", "Resolved schema (Describe-driven — compare against Setup > Object Manager > Attribute Based Adjustment):");
  const describeField = (label: string, f: { field: DescribeField | null } | DescribeField | null) => {
    const df = f && "field" in f ? f.field : (f as DescribeField | null);
    lines.push(`  ${label}: ${df ? `${df.name} (accessible=${df.accessible ?? "(unknown)"}, createable=${df.createable ?? "(unknown)"})` : "NOT RESOLVED on this org's schema"}`);
  };
  describeField("Product", schema.abaProductField);
  describeField("ProductSellingModel", schema.abaSellingModelField);
  describeField("PriceAdjustmentSchedule", schema.abaScheduleField);
  describeField("EffectiveFrom", schema.abaEffFromField);
  describeField("EffectiveTo", schema.abaEffToField);
  describeField("AdjustmentType", schema.abaTypeField);
  describeField("AdjustmentValue", schema.abaValueField);
  describeField("AttributeBasedAdjRule", schema.abaRuleField);
  describeField("AttributeAdjustmentCondition (direct)", schema.abaConditionField);
  lines.push(`  REQUESTED IDENTITY: ${formatAdjustmentIdentityForLog(requested)}`);

  // Step 7-A/K — can this session read the object AT ALL, independent of any filter?
  try {
    const sanity = await client.query<{ Id: string }>("SELECT Id FROM AttributeBasedAdjustment LIMIT 5");
    lines.push("", `Zero-filter sanity query (proves object-level read access, independent of Product/Schedule): ${sanity.records.length} record(s) visible org-wide (capped at 5).`);
    if (sanity.records.length === 0) {
      lines.push("  ⚠ Zero AttributeBasedAdjustment records are visible to this session AT ALL — if Salesforce is nonetheless rejecting a create as a duplicate, this session's permission set/profile likely lacks READ access on AttributeBasedAdjustment (Step 8), even though it has CREATE access. Check Object/Field-Level Security for the integration user.");
    }
  } catch (err) {
    lines.push("", `Zero-filter sanity query FAILED: ${err instanceof Error ? err.message : String(err)} — this itself is evidence: either the object API name is wrong for this org, or this session cannot query AttributeBasedAdjustment at all (Step 7-A/K).`);
  }

  // Step 7-I — re-scan by Product ONLY (Schedule dropped) — reveals whether the true conflicting record
  // carries a DIFFERENT Schedule than this run resolved, or is simply outside the Product+Schedule scope
  // every prior tier searched within.
  if (schema.abaProductField.field) {
    try {
      const allFieldNames = schema.abaDescribe.fields.filter(f => f.accessible !== false).map(f => f.name);
      const soql = `SELECT ${[...new Set(["Id", ...allFieldNames])].join(", ")} FROM AttributeBasedAdjustment WHERE ${schema.abaProductField.field.name} = '${soqlEscape(requested.productId)}'`;
      const res = await client.query<Record<string, unknown> & { Id: string }>(soql);
      lines.push("", `Product-ONLY re-scan (Schedule dropped entirely) — ${res.records.length} record(s) exist for Product ${requested.productId}, across ANY schedule:`);
      for (const rec of res.records) {
        lines.push(`  --- Candidate ${rec.Id} — every field this org's Describe reports as accessible ---`);
        for (const [k, v] of Object.entries(rec)) {
          if (k === "attributes") continue;
          lines.push(`    ${k} = ${JSON.stringify(v)}`);
        }
      }
      if (res.records.length === 0) {
        lines.push("  ⚠ Zero AttributeBasedAdjustment records exist for this Product at all, even with NO Schedule filter — if Salesforce is still rejecting the create as a duplicate, the conflicting record either belongs to a DIFFERENT Product than resolved here, or the Product field this app resolved/wrote to is not the field Salesforce's own duplicate validation actually reads (Step 1/7-D/F/H) — Setup > Object Manager > Attribute Based Adjustment > Fields should be checked directly for a second Product-shaped reference field.");
      }
    } catch (err) {
      lines.push("", `Product-ONLY re-scan FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    lines.push("", "Product-ONLY re-scan skipped — this org's schema has no resolved Product field on AttributeBasedAdjustment at all.");
  }

  lines.push(
    "",
    "This dump is the actual evidence needed to determine the true cause — please paste it back verbatim. " +
    "In particular: does the Product-ONLY re-scan show a record whose EffectiveFrom/EffectiveTo genuinely don't overlap today's window at all, or a DIFFERENT Schedule/SellingModel value than requested, " +
    "or does the zero-filter sanity query itself come back empty (a permissions issue, not a data issue)?",
  );
  return lines.join("\n");
}

/** §Part 10/11 — read the just-created record back and verify its COMPLETE identity (never trust the
 * create response's Id alone) before it is allowed into the reuse cache or counted as this rule's
 * Adjustment. Reuses the exact same comparison `verifyAttributeBasedAdjustmentConfigurations` performs
 * at the end of the whole run — this is that same check, run immediately, so a genuine mismatch is
 * caught here rather than surfacing much later as an unexplained verification failure. */
async function verifyCreatedAdjustmentIdentity(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  adjustmentId: string,
  requested: AttributeBasedAdjustmentIdentity,
): Promise<{ matches: boolean; mismatches: string[] }> {
  const selectFields = [...new Set(["Id",
    ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
  ])];
  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${selectFields.join(", ")} FROM AttributeBasedAdjustment WHERE Id = '${soqlEscape(adjustmentId)}' LIMIT 1`,
  );
  const rec = res.records[0];
  if (!rec) return { matches: false, mismatches: ["record not found on read-back"] };

  const mismatches: string[] = [];
  if (schema.abaProductField.field && rec[schema.abaProductField.field.name] !== requested.productId) mismatches.push("Product does not match");
  if (schema.abaSellingModelField.field) {
    const v = (rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null;
    if (v !== (requested.productSellingModelId ?? null)) mismatches.push("Product Selling Model does not match");
  }
  if (schema.abaScheduleField.field && rec[schema.abaScheduleField.field.name] !== requested.priceAdjustmentScheduleId) mismatches.push("Price Adjustment Schedule does not match");
  if (schema.abaEffFromField && normalizeDateValue(rec[schema.abaEffFromField.name]) !== normalizeDateValue(requested.effectiveFrom)) mismatches.push("Effective From does not match");
  if (schema.abaEffToField && normalizeDateValue(rec[schema.abaEffToField.name]) !== normalizeDateValue(requested.effectiveTo)) mismatches.push("Effective To does not match");

  const actualRuleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;
  if (!actualRuleId) {
    mismatches.push("no AttributeBasedAdjRule reference on read-back");
  } else {
    const actualSignature = await computeRuleConditionSignature(client, schema, attributeIdentityById, actualRuleId);
    if (actualSignature.queryFailed || !actualSignature.signature) mismatches.push("could not reconstruct its condition signature on read-back");
    else if (actualSignature.distinctConditionProductIds.length > 1) {
      mismatches.push(
        `this Rule's conditions belong to ${actualSignature.distinctConditionProductIds.length} different products (${actualSignature.distinctConditionProductIds.map(p => p ?? "(none)").join(", ")}) — never trusted regardless of signature match`,
      );
    } else if (actualSignature.signature !== requested.conditionSignature) mismatches.push(`condition signature mismatch (expected "${requested.conditionSignature}", found "${actualSignature.signature}")`);
  }

  return { matches: mismatches.length === 0, mismatches };
}

/**
 * §Live-org fix (Laptop/Monitor, Product-consistency) — Salesforce's THIRD distinct FIELD_INTEGRITY_EXCEPTION
 * for this object family: a genuine Product2 relationship inconsistency somewhere in the Rule →
 * Condition(s) → Adjustment chain. Two real, observed wordings, both matched: "For the given Attribute
 * Based Adjustment Rule, select the same product record for all Attribute Adjustment Conditions" (seen
 * during condition creation) and "Associate the same product with both the attribute based adjustment and
 * Attribute Adjustment Condition records" (seen during adjustment creation). MUST be checked BEFORE
 * `isAttributeBasedAdjustmentDuplicateError` in every catch block that could see either — that classifier's
 * broad `/attribute based adjustment/i` regex would otherwise ALSO match this message, routing it into the
 * wrong handler (duplicate-record reconciliation — there is no existing record to reconcile TO here, this
 * is a genuine data inconsistency). Per Part 6's explicit "never guess": this is NEVER treated as a safe
 * reuse/reconciliation opportunity — the caller must surface the exact Product mismatch and stop.
 */
function isProductConsistencyError(err: unknown): boolean {
  if (!(err instanceof SalesforceError)) return false;
  const msg = err.message ?? "";
  return /select the same product record/i.test(msg)
    || /associate the same product/i.test(msg)
    || (/same product/i.test(msg) && /(attribute adjustment condition|attribute based adjustment)/i.test(msg));
}

/** §Part 5 — Salesforce's specific "an attribute based adjustment ... already exists" duplicate error,
 * distinguished from every other possible creation failure so only THIS one is treated as a safe
 * reconciliation opportunity; anything else still fails the run immediately. Explicitly excludes
 * `isProductConsistencyError` messages — see that function's doc comment for why the two must never be
 * conflated despite both containing the phrase "attribute based adjustment". */
function isAttributeBasedAdjustmentDuplicateError(err: unknown): boolean {
  if (!(err instanceof SalesforceError)) return false;
  if (isProductConsistencyError(err)) return false;
  if (err.errorCode === "FIELD_INTEGRITY_EXCEPTION" && /attribute based adjustment/i.test(err.message ?? "")) return true;
  return /attribute based adjustment with the selected product/i.test(err.message ?? "");
}

/** §Root-cause fix — Salesforce's OTHER FIELD_INTEGRITY_EXCEPTION for this object: "Associate all price
 * impacting attributes with the relevant Attribute Adjustment Condition and try again." Distinguished
 * from the duplicate-record error above (`isAttributeBasedAdjustmentDuplicateError`) because it demands
 * an entirely different response — there is no "existing record" to reconcile to here; re-querying for a
 * duplicate would find nothing and this must instead surface exactly which attribute(s) are missing a
 * condition (see `resolveAdjustmentConditions`), never be silently caught/ignored. */
function isMissingPriceImpactingAssociationError(err: unknown): boolean {
  if (!(err instanceof SalesforceError)) return false;
  return /price.?impact/i.test(err.message ?? "") && /attribute adjustment condition/i.test(err.message ?? "");
}

/**
 * §Section NINTH (this turn) — the single, reusable resolver for "the exact Salesforce condition
 * records required for one AttributeBasedAdjustment." Re-queries `AttributeAdjustmentCondition` for the
 * given Rule (the same real relationship `computeRuleConditionSignature` already reads — never a
 * separate/different query that could disagree with it) and returns a rich, per-condition breakdown
 * (Salesforce Id, attribute identity Id, attribute name, best-effort AttributeValueId, the actual stored
 * value) plus a completeness verdict against `expectedAttributeNames` — the complete set of
 * price-impacting attributes THIS product actually has (see `resolveAllPriceImpactingAttributeNames`),
 * never a hardcoded count or a guessed subset. `missingAttributes`/`unexpectedAttributes` are computed by
 * NAME (normalized), never by array length alone — so "27 conditions exist" can never be mistaken for
 * "the right 27 conditions exist."
 */
export interface ResolvedAdjustmentCondition {
  conditionId: string;
  attributeId: string;
  attributeName: string;
  /** Best-effort AttributePicklistValue.Id match for `attributeValue` — null when it can't be resolved (never fatal; the Condition's own stored value is still authoritative). */
  attributeValueId: string | null;
  attributeValue: string;
  /** §Product-consistency fix — this condition's OWN resolved Product2 value (via `schema.conditionProductField`), read directly — `null` when this org's Condition object exposes no Product2 field at all. */
  productId: string | null;
  source: "reused" | "created" | "existing";
}

export interface ResolvedAdjustmentConditionSet {
  adjustmentKey: string;
  conditions: ResolvedAdjustmentCondition[];
  /** Every expected price-impacting attribute name with NO condition found under this rule. Empty means complete. */
  missingAttributes: string[];
  /** Every condition found under this rule whose attribute is NOT in the expected price-impacting set — should always be empty; a non-empty result flags an unrelated/incorrect association without guessing why. */
  unexpectedAttributes: string[];
  /** §Product-consistency fix — the Rule's OWN resolved Product2 value (via `schema.ruleProductField`),
   * read directly from Salesforce — never inferred. `null` when this org exposes no Product2 field on
   * AttributeBasedAdjRule at all (a genuine schema limitation, not an error). */
  ruleProductId: string | null;
  /** §Product-consistency fix — every condition whose OWN Product2Id does not equal `ruleProductId` (only
   * populated when both the rule's and the condition's product fields are actually resolvable) — the
   * exact "which condition is inconsistent" diagnostic Part 5's acceptance criteria require. Empty means
   * every resolved condition agrees with the rule's own product. */
  productMismatches: ResolvedAdjustmentCondition[];
  valid: boolean;
}

export async function resolveAdjustmentConditions(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  contexts: Map<string, AttributeContext>,
  ruleId: string,
  expectedAttributeNames: string[],
): Promise<ResolvedAdjustmentConditionSet> {
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
  const valueFieldNames = collectConditionValueFieldNames(schema.conditionDescribe);
  const identityFieldNames = [schema.conditionPadField.field?.name, schema.conditionAttrDefField.field?.name].filter((n): n is string => !!n);
  const productFieldName = schema.conditionProductField.field?.name ?? null;
  const selectFields = [...new Set(["Id", ...identityFieldNames, ...valueFieldNames, ...(productFieldName ? [productFieldName] : [])])];
  const soql = `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`;

  const records = (await client.query<Record<string, unknown> & { Id: string }>(soql).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }))).records;

  const conditions: ResolvedAdjustmentCondition[] = [];
  for (const rec of records) {
    let identityId: string | null = null;
    for (const f of identityFieldNames) {
      const v = rec[f];
      if (typeof v === "string" && v) { identityId = v; break; }
    }
    const attributeName = identityId ? attributeIdentityById.get(identityId) : undefined;
    if (!identityId || !attributeName) continue; // unresolvable to a known attribute — never guessed; simply not counted toward completeness either way.

    let value: string | null = null;
    for (const f of valueFieldNames) {
      const v = rec[f];
      if (v !== null && v !== undefined && v !== "") { value = String(v); break; }
    }
    const productId = productFieldName ? ((rec[productFieldName] as string | undefined) ?? null) : null;
    conditions.push({ conditionId: rec.Id, attributeId: identityId, attributeName, attributeValueId: null, attributeValue: value ?? "", productId, source: "existing" });
  }

  // Best-effort AttributeValueId enrichment — never blocks, never affects validity; mirrors the same
  // enrichment pattern `resolveBaseProductConfiguration` already uses.
  for (const c of conditions) {
    const ctx = contexts.get(c.attributeName);
    if (!ctx || !c.attributeValue) continue;
    try {
      const picklistId = await resolveAttributePicklistId(client, ctx.attributeDefinitionId, ctx.productAttributeDefinitionId);
      if (!picklistId) continue;
      const res = await client.query<{ Id: string; Value?: string; DisplayValue?: string; Name?: string }>(
        `SELECT Id, Value, DisplayValue, Name FROM AttributePicklistValue WHERE PicklistId = '${soqlEscape(picklistId)}'`,
      ).catch(() => ({ records: [] as { Id: string; Value?: string; DisplayValue?: string; Name?: string }[] }));
      const norm = c.attributeValue.toLowerCase();
      c.attributeValueId = res.records.find(r => (r.Value ?? r.DisplayValue ?? r.Name ?? "").toLowerCase() === norm)?.Id ?? null;
    } catch {
      // Enrichment only — never fatal.
    }
  }

  const foundNormNames = new Set(conditions.map(c => normalizeAttrName(c.attributeName)));
  const expected = expectedAttributeNames.map(n => ({ raw: n, norm: normalizeAttrName(n) }));
  const missingAttributes = expected.filter(e => !foundNormNames.has(e.norm)).map(e => e.raw);
  const expectedNormSet = new Set(expected.map(e => e.norm));
  const unexpectedAttributes = [...new Set(conditions.filter(c => !expectedNormSet.has(normalizeAttrName(c.attributeName))).map(c => c.attributeName))];

  // §Product-consistency fix — resolve the Rule's OWN product (the single source of truth every
  // condition must agree with) and flag every condition that disagrees with it, by name/value/Id, never
  // by count alone.
  let ruleProductId: string | null = null;
  if (schema.ruleProductField.field) {
    const ruleRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${schema.ruleProductField.field.name} FROM AttributeBasedAdjRule WHERE Id = '${soqlEscape(ruleId)}' LIMIT 1`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
    ruleProductId = (ruleRes.records[0]?.[schema.ruleProductField.field.name] as string | undefined) ?? null;
  }
  const productMismatches = (productFieldName && ruleProductId)
    ? conditions.filter(c => c.productId !== null && c.productId !== ruleProductId)
    : [];

  return {
    adjustmentKey: ruleId, conditions, missingAttributes, unexpectedAttributes, ruleProductId, productMismatches,
    valid: missingAttributes.length === 0 && productMismatches.length === 0,
  };
}

function formatResolvedConditionSet(set: ResolvedAdjustmentConditionSet): string {
  return set.conditions.length > 0
    ? set.conditions.map(c => `${c.conditionId} (${c.attributeName} = ${c.attributeValue}${c.attributeValueId ? `, AttributeValueId=${c.attributeValueId}` : ""}, Product=${c.productId ?? "(not tracked)"})`).join(", ")
    : "(none)";
}

/**
 * §Part 9 — the reusable Product-consistency validator requested for the Rule → Conditions → Adjustment
 * chain. Built on top of `resolveAdjustmentConditions` (the single source of truth for a rule's actual
 * condition set) rather than re-querying independently, so there is exactly one place that could disagree
 * with itself about what a rule's conditions actually are. Returns structured diagnostics — never a bare
 * boolean — following this module's own established `Resolved*`/mismatch-list conventions rather than
 * inventing a new shape.
 */
export interface ProductConsistencyMismatch {
  conditionId: string;
  actualProductId: string | null;
  expectedProductId: string;
  attribute: string;
  value: string;
  source: ResolvedAdjustmentCondition["source"];
}

export interface ProductConsistencyResult {
  valid: boolean;
  expectedProductId: string;
  ruleId: string;
  ruleProductId: string | null;
  mismatches: ProductConsistencyMismatch[];
  conditions: ResolvedAdjustmentCondition[];
  missingAttributes: string[];
  unexpectedAttributes: string[];
}

export async function validateAttributePricingProductConsistency(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  contexts: Map<string, AttributeContext>,
  ruleId: string,
  expectedProductId: string,
  expectedAttributeNames: string[],
): Promise<ProductConsistencyResult> {
  const resolved = await resolveAdjustmentConditions(client, schema, contexts, ruleId, expectedAttributeNames);

  const mismatches: ProductConsistencyMismatch[] = [];
  // The Rule's OWN product disagreeing with the expected product is itself a mismatch — surfaced as a
  // synthetic entry keyed by the Rule rather than any one condition, so a caller never has to special-case
  // "the rule itself is wrong" versus "one of its conditions is wrong."
  if (resolved.ruleProductId !== null && resolved.ruleProductId !== expectedProductId) {
    mismatches.push({
      conditionId: `(rule ${ruleId})`, actualProductId: resolved.ruleProductId, expectedProductId,
      attribute: "(rule-level)", value: "(n/a)", source: "existing",
    });
  }
  for (const c of resolved.productMismatches) {
    mismatches.push({
      conditionId: c.conditionId, actualProductId: c.productId, expectedProductId,
      attribute: c.attributeName, value: c.attributeValue, source: c.source,
    });
  }
  // A condition's product agreeing with the RULE's own product isn't sufficient if the Rule itself
  // disagrees with the expected product — every condition is also checked directly against
  // `expectedProductId`, not just against `ruleProductId`, so a rule/condition pair that's internally
  // consistent but collectively wrong for THIS run is still caught.
  for (const c of resolved.conditions) {
    if (c.productId !== null && c.productId !== expectedProductId && !mismatches.some(m => m.conditionId === c.conditionId)) {
      mismatches.push({ conditionId: c.conditionId, actualProductId: c.productId, expectedProductId, attribute: c.attributeName, value: c.attributeValue, source: c.source });
    }
  }

  return {
    valid: mismatches.length === 0 && resolved.missingAttributes.length === 0,
    expectedProductId, ruleId, ruleProductId: resolved.ruleProductId, mismatches,
    conditions: resolved.conditions, missingAttributes: resolved.missingAttributes, unexpectedAttributes: resolved.unexpectedAttributes,
  };
}

function formatProductConsistencyResult(result: ProductConsistencyResult): string {
  const lines = [
    `Rule ${result.ruleId}`,
    `Expected Product ${result.expectedProductId}`,
    `Rule's own resolved Product: ${result.ruleProductId ?? "(not tracked on this org's schema)"}`,
  ];
  if (result.mismatches.length === 0) {
    lines.push("✓ Product consistency verified");
  } else {
    lines.push("✕ Product consistency failed");
    for (const m of result.mismatches) {
      lines.push(`  Condition ${m.conditionId} — Attribute ${m.attribute} = ${m.value} — actual Product ${m.actualProductId ?? "(none)"}, expected ${m.expectedProductId} — Source: ${m.source.toUpperCase()}`);
    }
  }
  return lines.join("\n");
}

/* ── Phase: AttributeBasedAdjustment — the junction record that actually ties Schedule + Rule +
 * Condition + Product + Selling Model + adjustment type/value together (Part 2's real relationship,
 * as opposed to the diagram's implied direct Rule→Schedule edge). Idempotent per Issue 3: every
 * create is preceded by a preflight match against the org's real uniqueness key, never a blind
 * create; no Salesforce delete is ever issued (Issue 3F) — partial records from a prior failed run
 * are reused, never removed. ── */
export interface AdjustmentDecision {
  step: "attribute-based-adjustment";
  ruleId: string;
  requestedConfiguration: {
    productId: string;
    productSellingModelId: string | null;
    scheduleId: string;
    conditions: { attribute: string; value: string }[];
    effectiveFrom: string;
    effectiveTo: string;
  };
  conditionSignature: string;
  candidateAdjustmentId: string | null;
  candidateCount: number;
  conditionMatch: boolean;
  decision: "CREATE" | "REUSE" | "UPDATE";
  adjustmentId: string;
}

/**
 * §Phase 1/2/8/9/10 fix (this turn) — the three concepts the spec explicitly requires never be
 * conflated: CONDITION IDENTITY (`AttributeBasedAdjustmentIdentity.conditionSignature`), ADJUSTMENT
 * IDENTITY (the full `AttributeBasedAdjustmentIdentity` — Product+SellingModel+Schedule+EffFrom/To+
 * conditions, which is the ONLY thing Salesforce's own uniqueness constraint cares about), and
 * ADJUSTMENT VALUE (AdjustmentType/AdjustmentValue — NOT part of Salesforce's uniqueness key, so two
 * requests with the IDENTICAL identity but a DIFFERENT requested value can never coexist as two
 * records; the only Salesforce-supported way to honor a new value is to UPDATE the existing record).
 * Previously, ANY identity match was treated as a blind auto-reuse — the existing record's own
 * AdjustmentType/AdjustmentValue was never even read, so a live prompt asking for a genuinely
 * different price on an already-configured attribute/value would silently keep the OLD price with no
 * indication anything was ignored. `AdjustmentConflict` is the structured, never-auto-resolved outcome
 * for that case — the caller (createPipeline.ts) surfaces it and requires an explicit
 * `AdjustmentDecisionOverride` before this rule's Adjustment can be resolved on a later resubmit.
 */
export type AdjustmentDecisionOverride = "USE_EXISTING" | "USE_NEW";

export interface AdjustmentConflict {
  ruleId: string;
  attributeName: string;
  attributeLabel: string;
  /** The raw Salesforce value — this, not `valueLabel`, is what `adjustmentDecisionKey` requires (it
   * must match the exact key `createAttributeBasedAdjustments` looks decisions up by on a resubmit). */
  value: string;
  valueLabel: string;
  productId: string;
  productName: string;
  existingAdjustmentId: string;
  existingAdjustmentType: string | null;
  existingAdjustmentValue: number | null;
  requestedAdjustmentType: string | null;
  requestedAdjustmentValue: number;
}

/** The stable, human-facing key a caller uses to supply a decision for one conflict — matches the
 * `${attributeName}::${value}` convention `analyze.ts`'s own mapping/adjustment overrides already use,
 * so the two modules never need two different key conventions for the same underlying concept. */
export function adjustmentDecisionKey(attributeName: string, value: string): string {
  return `${attributeName}::${value}`;
}

/** Tolerant of Salesforce returning a Decimal with harmless float noise (e.g. 12000 vs
 * 12000.00000001) — never treats a genuinely different magnitude (12000 vs 15000) as equal. */
function adjustmentValuesEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.0005;
}

/**
 * §Phase 8 — classifies an identity-matching candidate's ADJUSTMENT VALUE against what this request
 * wants, applying any user-supplied decision. Never silently reuses a different value (would silently
 * discard the user's real request) and never silently overwrites (would silently discard Salesforce's
 * existing configuration) — an unresolved difference is always `"CONFLICT"`, requiring an explicit
 * decision on a resubmit. When this org's schema exposes neither AdjustmentType nor AdjustmentValue at
 * all, there's nothing to compare — always `"AUTO_REUSE"` (matches this module's pre-existing behavior
 * for such an org, never a regression).
 */
function classifyAdjustmentMatch(
  candidate: { existingAdjustmentType: string | null; existingAdjustmentValue: number | null },
  requested: { type: string | null; value: number },
  hasValueTracking: boolean,
  override: AdjustmentDecisionOverride | undefined,
): "AUTO_REUSE" | "USE_EXISTING" | "USE_NEW" | "CONFLICT" {
  if (!hasValueTracking) return "AUTO_REUSE";
  const typeMatches = (requested.type ?? null) === (candidate.existingAdjustmentType ?? null);
  const valueMatches = adjustmentValuesEqual(requested.value, candidate.existingAdjustmentValue);
  if (typeMatches && valueMatches) return "AUTO_REUSE";
  if (override === "USE_EXISTING") return "USE_EXISTING";
  if (override === "USE_NEW") return "USE_NEW";
  return "CONFLICT";
}

/**
 * §Phase 9 — the Salesforce-NATIVE mechanism for "use my new value" on an identity that already
 * exists: Salesforce's own uniqueness constraint has no AdjustmentType/AdjustmentValue component, so a
 * second CREATE for the same identity is impossible regardless of value — the only supported path is
 * `updateRecord` on the EXISTING record, never a second create. Never trusts the update call alone: an
 * explicit read-back confirms both the identity is still intact and the new value is actually what's
 * now stored, exactly mirroring `verifyCreatedAdjustmentIdentity`'s own "never trust a write response
 * alone" convention used for CREATE.
 */
/**
 * §Root-cause fix (this turn) — the PRIOR version of this function verified the post-update record
 * against `requested.effectiveFrom`/`requested.effectiveTo` (today's freshly-computed dates), even though
 * USE_NEW's own update payload NEVER includes EffectiveFrom/EffectiveTo at all (by design — USE_NEW is
 * scoped to the ADJUSTMENT VALUE only, per Phase 8 Case B; changing effective-dating is a different,
 * unimplemented business decision, never silently bundled in). For a record found via the date-OVERLAP
 * reconciliation tier (see `broadFindExistingAttributeBasedAdjustment`), its real EffectiveFrom/To are
 * from whenever it was ORIGINALLY created — that is exactly WHY the overlap tier was needed to find it,
 * and those dates were never expected to equal today's. Verifying them against `requested` was therefore
 * guaranteed to report a false "Effective From/To does not match" on every single USE_NEW applied to an
 * overlap-reconciled record, misreporting a clean, fully-successful update (Salesforce actually WAS never
 * asked to touch those two fields, and did not) as a dangerous partial failure.
 *
 * The correct check: read the record's OWN state BEFORE the update (Task 2/9's requested pre-update
 * snapshot), then after the update, confirm (a) AdjustmentType/AdjustmentValue now equal the newly
 * requested ones, and (b) every field this call never asked to change — Product, ProductSellingModel,
 * PriceAdjustmentSchedule, EffectiveFrom, EffectiveTo — is BYTE-IDENTICAL to its own pre-update value.
 * This catches a genuine problem (Salesforce silently touching a field nobody asked it to) while never
 * flagging the expected, harmless case (a date that simply doesn't match today, because it was never
 * supposed to).
 */
interface UseNewPreUpdateSnapshot {
  productId: string | null; productSellingModelId: string | null; scheduleId: string | null;
  effectiveFrom: string | null; effectiveTo: string | null;
  adjustmentType: string | null; adjustmentValue: number | null;
}

async function readAdjustmentSnapshot(client: SalesforceClient, schema: AttributeBasedPricingSchema, adjustmentId: string): Promise<UseNewPreUpdateSnapshot | null> {
  const selectFields = [...new Set(["Id",
    ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
    ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
    ...(schema.abaValueField ? [schema.abaValueField.name] : []),
  ])];
  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${selectFields.join(", ")} FROM AttributeBasedAdjustment WHERE Id = '${soqlEscape(adjustmentId)}' LIMIT 1`,
  );
  const rec = res.records[0];
  if (!rec) return null;
  return {
    productId: schema.abaProductField.field ? ((rec[schema.abaProductField.field.name] as string | undefined) ?? null) : null,
    productSellingModelId: schema.abaSellingModelField.field ? ((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) : null,
    scheduleId: schema.abaScheduleField.field ? ((rec[schema.abaScheduleField.field.name] as string | undefined) ?? null) : null,
    effectiveFrom: schema.abaEffFromField ? normalizeDateValue(rec[schema.abaEffFromField.name]) : null,
    effectiveTo: schema.abaEffToField ? normalizeDateValue(rec[schema.abaEffToField.name]) : null,
    adjustmentType: schema.abaTypeField ? ((rec[schema.abaTypeField.name] as string | null | undefined) ?? null) : null,
    adjustmentValue: schema.abaValueField ? ((rec[schema.abaValueField.name] as number | null | undefined) ?? null) : null,
  };
}

async function applyUseNewAdjustmentValue(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  existingId: string,
  abaTypeValue: string | null,
  requestedValue: number,
): Promise<void> {
  // §Step 9 fix (root-cause investigation, prior turn) — `createable` and `updateable` are DISTINCT
  // Salesforce Describe flags; a field being writable on CREATE says nothing about whether Salesforce
  // allows it to be changed afterward. Checked explicitly, from the same Describe response schema
  // resolution already trusts elsewhere, before ever attempting the update.
  const typeNotUpdateable = schema.abaTypeField && abaTypeValue && schema.abaTypeField.updateable === false;
  const valueNotUpdateable = schema.abaValueField && schema.abaValueField.updateable === false;
  if (typeNotUpdateable || valueNotUpdateable) {
    throw new Error(
      `Cannot apply the USE_NEW decision for AttributeBasedAdjustment ${existingId} — this org's Describe metadata reports ` +
      `${[typeNotUpdateable ? `${schema.abaTypeField!.name} (AdjustmentType) as NOT updateable` : null, valueNotUpdateable ? `${schema.abaValueField!.name} (AdjustmentValue) as NOT updateable` : null].filter(Boolean).join(" and ")} ` +
      `once created. Salesforce's Attribute-Based Adjustment model may require the value to be changed through a related object (e.g. re-pointing the Price Adjustment Schedule to a new tier/version), ` +
      `not a direct field update on this record — this must be confirmed in Setup before proceeding. Never attempted the update blindly.`,
    );
  }

  // §Task 2/9 — read the record's OWN current state BEFORE any write. This (not `requested`'s
  // freshly-computed today's-date identity) is the correct baseline for what USE_NEW must preserve.
  const before = await readAdjustmentSnapshot(client, schema, existingId);
  if (!before) {
    throw new Error(`Cannot apply the USE_NEW decision — AttributeBasedAdjustment ${existingId} could not be read before attempting the update (it may have been deleted since it was found).`);
  }
  client.logDebug("execution-trace", [
    "[ABP] USE_NEW pre-update safety check",
    JSON.stringify({
      recordId: existingId,
      requested: { adjustmentType: abaTypeValue, adjustmentValue: requestedValue },
      existing: { effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo, adjustmentType: before.adjustmentType, adjustmentValue: before.adjustmentValue },
      fieldCapabilities: {
        effectiveFrom: { updateable: schema.abaEffFromField?.updateable ?? null },
        effectiveTo: { updateable: schema.abaEffToField?.updateable ?? null },
        adjustmentType: { updateable: schema.abaTypeField?.updateable ?? null },
        adjustmentValue: { updateable: schema.abaValueField?.updateable ?? null },
      },
      scope: "USE_NEW only ever writes AdjustmentType/AdjustmentValue — EffectiveFrom/EffectiveTo/Product/ProductSellingModel/Schedule are never included in the update payload and are expected to remain exactly as they are now.",
    }, null, 2),
  ].join("\n"));

  const updatePayload: Record<string, unknown> = {};
  if (schema.abaTypeField && abaTypeValue) updatePayload[schema.abaTypeField.name] = abaTypeValue;
  if (schema.abaValueField) updatePayload[schema.abaValueField.name] = requestedValue;
  client.logDebug("execution-trace", `[ABP] USE_NEW decision — updating existing AttributeBasedAdjustment ${existingId} in place (Salesforce's native update mechanism; never a duplicate create): ${JSON.stringify(updatePayload)}`);
  await client.updateRecord("AttributeBasedAdjustment", existingId, updatePayload);

  const after = await readAdjustmentSnapshot(client, schema, existingId);
  const mismatches: string[] = [];
  if (!after) {
    mismatches.push("record could not be read back after the update");
  } else {
    // Fields USE_NEW never asked to change must remain byte-identical to their OWN pre-update value —
    // never compared against `requested`'s today's-date identity, which an overlap-reconciled record is
    // never expected to match.
    if (schema.abaProductField.field && after.productId !== before.productId) mismatches.push(`Product changed unexpectedly (was ${before.productId}, now ${after.productId})`);
    if (schema.abaSellingModelField.field && after.productSellingModelId !== before.productSellingModelId) mismatches.push(`Product Selling Model changed unexpectedly (was ${before.productSellingModelId ?? "(none)"}, now ${after.productSellingModelId ?? "(none)"})`);
    if (schema.abaScheduleField.field && after.scheduleId !== before.scheduleId) mismatches.push(`Price Adjustment Schedule changed unexpectedly (was ${before.scheduleId}, now ${after.scheduleId})`);
    if (schema.abaEffFromField && after.effectiveFrom !== before.effectiveFrom) mismatches.push(`Effective From changed unexpectedly (was ${before.effectiveFrom}, now ${after.effectiveFrom}) — USE_NEW never requested this field to change`);
    if (schema.abaEffToField && after.effectiveTo !== before.effectiveTo) mismatches.push(`Effective To changed unexpectedly (was ${before.effectiveTo}, now ${after.effectiveTo}) — USE_NEW never requested this field to change`);
    if (schema.abaTypeField && abaTypeValue && after.adjustmentType !== abaTypeValue) mismatches.push(`AdjustmentType was not updated to the requested value (expected ${abaTypeValue}, found ${after.adjustmentType ?? "(none)"})`);
    if (schema.abaValueField && !adjustmentValuesEqual(after.adjustmentValue, requestedValue)) mismatches.push(`AdjustmentValue was not updated to the requested value (expected ${requestedValue}, found ${after.adjustmentValue ?? "(none)"})`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Updated AttributeBasedAdjustment ${existingId} per the USE_NEW decision, but Salesforce's read-back did not confirm a clean update: ${mismatches.join("; ")}. Refusing to trust this record.`,
    );
  }
  client.logDebug("execution-trace", `[ABP] USE_NEW applied and verified — AttributeBasedAdjustment ${existingId} now stores type=${abaTypeValue ?? "(n/a)"}, value=${requestedValue}; every other field confirmed unchanged from its own pre-update state.`);
}

/** Extracted from inside `createAttributeBasedAdjustments` (pure, stateless) so `expandAttributeCombinationRules`
 * can resolve the same real, Describe-confirmed picklist value for a given adjustment kind — never a second,
 * independently-invented mapping. */
function resolveAdjustmentTypeValue(field: DescribeField, kind: "fixed" | "percentage" | "override"): string | null {
  const active = (field.picklistValues ?? []).filter(v => v.active);
  const keyword = kind === "fixed" ? /fixed|amount/i : kind === "percentage" ? /percent/i : /override/i;
  return active.find(v => keyword.test(v.value) || keyword.test(v.label))?.value ?? active[0]?.value ?? null;
}

export async function createAttributeBasedAdjustments(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string }; sellingModelId: string | null },
  contexts: Map<string, AttributeContext>,
  scheduleId: string,
  plans: AttributeBasedRulePlan[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
  /** §Phase 9/24 — decisions the user already made for previously-reported `AdjustmentConflict`s, keyed
   * by `adjustmentDecisionKey(attributeName, value)`. Stateless-resubmit, matching the SAME convention
   * `analyze.ts`'s `AttributeBasedMappingOverrides` already uses — no new server-side pending-operation
   * store is introduced; the caller re-sends the full request with this map once the user has decided. */
  decisionOverrides?: Map<string, AdjustmentDecisionOverride>,
): Promise<{ adjustmentIds: string[]; reusedAdjustmentIds: string[]; updatedAdjustmentIds: string[]; decisions: AdjustmentDecision[]; pendingConflicts: AdjustmentConflict[] }> {
  step(steps, "create-adjustment", "start", "Creating (or reusing) Attribute-Based Adjustments.");
  const adjustmentIds: string[] = [];
  const reusedAdjustmentIds: string[] = [];
  const updatedAdjustmentIds: string[] = [];
  const pendingConflicts: AdjustmentConflict[] = [];
  const decisions: AdjustmentDecision[] = [];
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
  const hasValueTracking = !!(schema.abaTypeField || schema.abaValueField);
  // Computed once per call (not per create) so the preflight comparison and the create payload
  // always agree on exactly the same Effective From/To this run is using.
  const effectiveFrom = todayISO();
  const effectiveTo = oneYearFromTodayISO();
  // §Part 11 — populated ONLY after a Salesforce-confirmed exact match or a freshly created + read-back
  // -verified record; checked first purely as a within-run optimization (e.g. a second rule with the
  // same baseline-collision signature immediately reuses the first rule's just-created Adjustment
  // without re-querying), but a cache MISS always still falls through to a live Salesforce query below
  // — this cache is never the sole source of truth. Keyed by the full canonical identity, never by
  // attribute name/value/Rule Id alone.
  // §Phase-A duplicate logical-state fix — the cache now also carries the cached Adjustment's own
  // type/value, not just its Id: a cache HIT used to be treated as an unconditional AUTO_REUSE,
  // bypassing `classifyAdjustmentMatch` entirely — meaning two of this run's OWN rows sharing an
  // identical complete-state signature but requesting DIFFERENT adjustment values would silently keep
  // whichever one was processed first, never reporting the conflict. A cache hit now runs through the
  // exact same conflict classification as a fresh Salesforce lookup.
  const identityCache = new Map<string, { id: string; type: string | null; value: number | null }>();

  // §Step 9 fix — a diagnostic table of every pending rule's resolved identity, computed BEFORE any
  // AttributeBasedAdjustment create/reuse call below — never after the fact. Signatures are cached here
  // (keyed by ruleId) so the real per-rule loop below reuses them instead of re-querying. This is also
  // what lets an in-request duplicate (two of THIS run's own rules resolving to the byte-identical
  // Product+SellingModel+Schedule+EffectiveFrom/To+condition-set identity — expected whenever more than
  // one rule's own varying value happens to sit at that attribute's baseline) be seen up front, rather than
  // discovered only after two separate create attempts collide inside the loop.
  const signatureByRuleId = new Map<string, RuleConditionSignatureResult>();
  const pendingForAdjustment = plans.filter(p => !p.reusedExisting);
  const diagnosticKeyCounts = new Map<string, number>();
  const diagnosticRows: string[] = [];
  for (const plan of pendingForAdjustment) {
    const sig = await computeRuleConditionSignature(client, schema, attributeIdentityById, plan.ruleId);
    signatureByRuleId.set(plan.ruleId, sig);
    const identityKey = serializeAdjustmentIdentity({
      productId: args.product.id, productSellingModelId: args.sellingModelId ?? null,
      priceAdjustmentScheduleId: scheduleId, effectiveFrom, effectiveTo, conditionSignature: sig.signature,
    });
    diagnosticKeyCounts.set(identityKey, (diagnosticKeyCounts.get(identityKey) ?? 0) + 1);
    diagnosticRows.push(
      `Rule ${plan.ruleId} | ${plan.row.attributeLabel} = ${plan.row.valueLabel} | Product=${args.product.id} | ` +
      `ProductSellingModel=${args.sellingModelId ?? "(none)"} | Schedule=${scheduleId} | EffectiveFrom=${effectiveFrom} | EffectiveTo=${effectiveTo} | ` +
      `AdjustmentType=${plan.row.adjustmentType} | AdjustmentValue=${plan.row.adjustment} | ` +
      `ConditionSet=${sig.queryFailed ? "(query FAILED)" : sig.signature || "(empty)"} | NormalizedIdentityKey=${identityKey}`,
    );
  }
  const duplicateIdentityKeys = [...diagnosticKeyCounts.entries()].filter(([, n]) => n > 1);
  client.logDebug("execution-trace", [
    `[ABP] Rule identity diagnostic table — ${pendingForAdjustment.length} rule(s) pending, computed before any create/reuse call`,
    ...diagnosticRows.map((r, i) => `[ABP] Rule ${i + 1}/${diagnosticRows.length} — ${r}`),
    duplicateIdentityKeys.length > 0
      ? `[ABP] ${duplicateIdentityKeys.length} identity key(s) shared by more than one of this run's own rules — these will collapse to a SINGLE AttributeBasedAdjustment (Salesforce's own uniqueness constraint has no Rule component, so this is expected, not a defect): ${duplicateIdentityKeys.map(([k, n]) => `"${k}" (${n}x)`).join(", ")}`
      : "[ABP] No duplicate identity keys among this run's own pending rules.",
  ].join("\n"));

  for (const plan of plans) {
    if (plan.reusedExisting) {
      // §Part 6/11 — this rule's Adjustment was already found (with its Id captured) while resolving
      // the Rule itself; account for it here too so the final adjustment count reflects ALL 22
      // requested rules, not just the ones this run's Adjustment phase actually attempted.
      if (plan.existingAdjustmentId) reusedAdjustmentIds.push(plan.existingAdjustmentId);
      continue;
    }
    const { row, ruleId, conditionIds: thisRuleConditionIds } = plan;

    const requestedResult = signatureByRuleId.get(ruleId) ?? await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId);
    if (requestedResult.queryFailed || !requestedResult.signature) {
      // §Part 15 — never hide a real problem behind a blind create: this run's OWN rule (which
      // createAttributeAdjustmentConditions just created/confirmed a condition for) must always
      // resolve to a non-empty signature. If it doesn't, something upstream is broken and continuing
      // would create yet another unidentifiable Adjustment that could itself cause future false
      // reuse — stop and surface exactly what failed instead.
      throw new Error(
        `Could not compute a condition signature for AttributeBasedAdjRule ${ruleId} (${row.attributeLabel} = ${row.valueLabel}) — ` +
        `${requestedResult.queryFailed ? "the condition query itself failed" : "no condition on this rule could be mapped back to a known attribute"}. ` +
        `Refusing to create or reuse an AttributeBasedAdjustment for an unidentifiable configuration. See server logs for the exact query/records involved.`,
      );
    }
    // §Live-org fix (Laptop, Product-consistency) — this run's OWN rule already has conditions spanning
    // more than one product BEFORE any Adjustment is even attempted. Never silently proceeds: Salesforce
    // would reject the Adjustment create anyway ("Associate the same product with both the attribute
    // based adjustment and Attribute Adjustment Condition records"), and this diagnostic names exactly
    // which products are mixed instead of surfacing only Salesforce's generic rejection.
    if (requestedResult.distinctConditionProductIds.length > 1) {
      throw new Error(
        `AttributeBasedAdjRule ${ruleId} (${row.attributeLabel} = ${row.valueLabel}) has Attribute Adjustment Conditions belonging to ${requestedResult.distinctConditionProductIds.length} DIFFERENT products ` +
        `(${requestedResult.distinctConditionProductIds.map(p => p ?? "(none)").join(", ")}), but this run expects Product ${args.product.id}. ` +
        `Refusing to create an AttributeBasedAdjustment on a Rule whose own conditions are Product-inconsistent — Salesforce would reject it. ` +
        `A Salesforce admin must resolve which product this Rule's existing conditions actually belong to before this pipeline can safely proceed.`,
      );
    }

    const requested: AttributeBasedAdjustmentIdentity = {
      productId: args.product.id, productSellingModelId: args.sellingModelId ?? null,
      priceAdjustmentScheduleId: scheduleId, effectiveFrom, effectiveTo,
      conditionSignature: requestedResult.signature,
    };
    const cacheKey = serializeAdjustmentIdentity(requested);
    const requestedConfiguration: AdjustmentDecision["requestedConfiguration"] = {
      productId: args.product.id,
      productSellingModelId: args.sellingModelId,
      scheduleId,
      conditions: requestedResult.tokens.map(t => {
        const idx = t.lastIndexOf("=");
        return { attribute: t.slice(0, idx), value: t.slice(idx + 1) };
      }),
      effectiveFrom,
      effectiveTo,
    };

    const abaTypeValue = schema.abaTypeField ? resolveAdjustmentTypeValue(schema.abaTypeField, row.adjustmentType) : null;
    const overrideKey = adjustmentDecisionKey(row.attributeName, row.value);
    const override = decisionOverrides?.get(overrideKey);

    const cached = identityCache.get(cacheKey);
    let existingId = cached?.id ?? null;
    let candidateCount = 0;
    let existingType: string | null = cached?.type ?? null;
    let existingValue: number | null = cached?.value ?? null;
    const viaCache = !!cached;
    if (!existingId) {
      const found = await findExistingAttributeBasedAdjustment(client, schema, attributeIdentityById, requested);
      existingId = found.id;
      candidateCount = found.candidateCount;
      existingType = found.existingAdjustmentType;
      existingValue = found.existingAdjustmentValue;
    }

    // §Phase 8 — a matching identity does NOT by itself mean the requested ADJUSTMENT VALUE also
    // agrees; classified separately (never conflated with condition-identity matching).
    // §Phase-A duplicate logical-state fix — a cache hit is NO LONGER an automatic AUTO_REUSE: two of
    // this run's OWN rows can share an identical complete-state identity (e.g. "Display=1080p" and
    // "Screen Size=24 Inch" both pinning the other to baseline) while requesting DIFFERENT adjustment
    // values — that must be classified (and, if genuinely conflicting, reported) exactly like a
    // fresh-Salesforce-lookup match, never silently treated as "already resolved, nothing to check."
    const outcome: "AUTO_REUSE" | "USE_EXISTING" | "USE_NEW" | "CONFLICT" | "NONE" = !existingId
      ? "NONE"
      : classifyAdjustmentMatch({ existingAdjustmentType: existingType, existingAdjustmentValue: existingValue }, { type: abaTypeValue, value: row.adjustment }, hasValueTracking, override);

    // §Part 13 — the pre-creation diagnostic block, logged for every rule before any create is attempted.
    client.logDebug("execution-trace", [
      "Attribute-Based Adjustment Preflight",
      "",
      `Rule: ${ruleId} (${row.attributeLabel} = ${row.valueLabel})`,
      `Requested conditions: ${thisRuleConditionIds.length}`,
      `REQUESTED IDENTITY: ${formatAdjustmentIdentityForLog(requested)}`,
      viaCache ? "Resolved via this run's in-memory identity cache (populated only after a prior Salesforce-verified reuse/create this run)." : `Existing AttributeBasedAdjustment candidates (Product+Schedule scoped): ${candidateCount}`,
      `Exact matching AttributeBasedAdjustment: ${existingId ? "YES" : "NO"}`,
      existingId ? `Existing Adjustment ID: ${existingId}` : "",
      existingId && hasValueTracking ? `Existing adjustment value: type=${existingType ?? "(none)"}, value=${existingValue ?? "(none)"} | Requested: type=${abaTypeValue ?? "(none)"}, value=${row.adjustment}` : "",
      `Decision: ${outcome === "NONE" ? "CREATE" : outcome}`,
      "",
      `[ABP] Rule: ${ruleId} (${row.attributeLabel} = ${row.valueLabel})`,
      `[ABP] Product: ${args.product.id}`,
      `[ABP] ProductSellingModel: ${args.sellingModelId ?? "(none)"}`,
      `[ABP] Schedule: ${scheduleId}`,
      `[ABP] EffectiveFrom: ${effectiveFrom}`,
      `[ABP] EffectiveTo: ${effectiveTo}`,
      `[ABP] Requested conditions: ${requestedResult.tokens.join(", ") || "(none)"}`,
      `[ABP] Normalized condition key: ${requestedResult.signature || "(empty)"}`,
      `[ABP] Candidate adjustment Ids checked: ${candidateCount} candidate(s)${viaCache ? " (skipped — resolved via in-memory cache)" : ""}`,
      `[ABP] Match result: ${existingId ? `TRUE (${existingId})` : "FALSE"}`,
      `[ABP] Adjustment value comparison: ${hasValueTracking ? `existing(type=${existingType ?? "(none)"}, value=${existingValue ?? "(none)"}) vs requested(type=${abaTypeValue ?? "(none)"}, value=${row.adjustment})` : "(not tracked on this org's schema)"}`,
      `[ABP] Decision: ${outcome === "NONE" ? "CREATE" : outcome}`,
    ].filter(line => line !== "").join("\n"));

    if (outcome === "CONFLICT") {
      // §Phase 8 Case B / Phase 10 — never auto-reused, never auto-overwritten, never a fatal error:
      // this run's OTHER rules still proceed normally (a batch of conflicts is reported together, per
      // the SAME "resubmit once" convention `analyze.ts`'s `needs-mapping` stage already uses — never a
      // resubmit-per-conflict cycle).
      pendingConflicts.push({
        ruleId, attributeName: row.attributeName, attributeLabel: row.attributeLabel, value: row.value, valueLabel: row.valueLabel,
        productId: args.product.id, productName: args.product.name,
        existingAdjustmentId: existingId!, existingAdjustmentType: existingType, existingAdjustmentValue: existingValue,
        requestedAdjustmentType: abaTypeValue, requestedAdjustmentValue: row.adjustment,
      });
      onProgress?.(`⚠ An Attribute-Based Adjustment already exists for ${row.attributeLabel} = ${row.valueLabel} with a different value (existing=${existingValue ?? "(none)"}, requested=${row.adjustment}) — awaiting your decision.`);
      step(steps, "create-adjustment", "info", `⚠ ${row.attributeLabel} = ${row.valueLabel} — existing adjustment value ${existingValue ?? "(none)"} differs from requested ${row.adjustment}. Choose USE_EXISTING or USE_NEW and resubmit.`);
      continue;
    }

    if (outcome === "USE_NEW") {
      await applyUseNewAdjustmentValue(client, schema, existingId!, abaTypeValue, row.adjustment);
      identityCache.set(cacheKey, { id: existingId!, type: abaTypeValue, value: row.adjustment });
      updatedAdjustmentIds.push(existingId!);
      decisions.push({
        step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
        candidateAdjustmentId: existingId!, candidateCount, conditionMatch: true, decision: "UPDATE", adjustmentId: existingId!,
      });
      onProgress?.(`✓ Updated existing AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} to the requested value (per your USE_NEW decision).`);
      step(steps, "create-adjustment", "info", `✓ Updated AttributeBasedAdjustment ${existingId} for ${row.attributeLabel} = ${row.valueLabel} — Salesforce's native update mechanism, never a duplicate create.`);
      continue;
    }

    if (outcome === "AUTO_REUSE" || outcome === "USE_EXISTING") {
      if (!viaCache) identityCache.set(cacheKey, { id: existingId!, type: existingType, value: existingValue });
      reusedAdjustmentIds.push(existingId!);
      decisions.push({
        step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
        candidateAdjustmentId: existingId!, candidateCount, conditionMatch: true, decision: "REUSE", adjustmentId: existingId!,
      });
      onProgress?.(
        outcome === "USE_EXISTING"
          ? `✓ Keeping existing AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} (per your USE_EXISTING decision).`
          : `✓ Reusing existing AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} (${existingId}).`,
      );
      step(steps, "create-adjustment", "info", `✓ Existing Attribute-Based Adjustment found for ${row.attributeLabel} = ${row.valueLabel} — reusing ${existingId}.`);
      continue;
    }

    step(steps, "create-adjustment", "info", `No matching Attribute-Based Adjustment found for ${row.attributeLabel} = ${row.valueLabel} — creating a new one.`);
    // The FIRST condition is always this rule's own (priced) condition — see createAttributeAdjustmentConditions,
    // which pushes it before any anchor conditions — so this is the semantically correct one to reference
    // directly, never an arbitrary anchor.
    const conditionId = schema.abaConditionField ? thisRuleConditionIds[0] ?? null : null;

    // §Section TENTH/NINTH, extended by the Product-consistency fix — resolve the EXACT condition set
    // this rule actually has in Salesforce right now (never assumed from `thisRuleConditionIds`'s
    // in-memory length), validate it covers every price-impacting attribute THIS PRODUCT has (not just the
    // ones this run's own rules vary), AND validate every one of those conditions — plus the Rule itself —
    // actually belongs to `args.product.id`. `expectedAttributeNames` is derived from `contexts`, which the
    // caller (createPipeline.ts) populates with the product's COMPLETE price-impacting set. Neither gate
    // is a substitute for the other: a rule can have a complete attribute set that's product-inconsistent
    // (Laptop) or a product-consistent set that's incomplete — both must be caught before any POST.
    const expectedAttributeNames = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true).map(([name]) => name);
    const consistency = await validateAttributePricingProductConsistency(client, schema, contexts, ruleId, args.product.id, expectedAttributeNames);

    client.logDebug("execution-trace", [
      "Creating Attribute-Based Adjustment",
      "",
      `  Attribute/value: ${row.attributeLabel} = ${row.valueLabel}`,
      `  Product: ${args.product.id}`,
      `  Product Selling Model: ${args.sellingModelId ?? "(none)"}`,
      `  Price Adjustment Schedule: ${scheduleId}`,
      `  Adjustment Type: ${abaTypeValue ?? "(none)"}`,
      `  Adjustment Value: ${row.adjustment}`,
      `  Effective From: ${effectiveFrom}`,
      `  Effective To: ${effectiveTo}`,
      `  Required price-impacting attributes (${expectedAttributeNames.length}): ${expectedAttributeNames.join(", ") || "(none)"}`,
      `  Associated Attribute Adjustment Conditions: ${consistency.conditions.map(c => `${c.conditionId} (${c.attributeName}=${c.attributeValue}, Product=${c.productId ?? "(not tracked)"})`).join(", ") || "(none)"}`,
      "",
      `  Adjustment Product: ${args.product.id}`,
      `  Rule Product: ${consistency.ruleProductId ?? "(not tracked on this org's schema)"}`,
      `  Condition Products: [${consistency.conditions.map(c => c.productId ?? "(none)").join(", ")}]`,
      "",
      formatProductConsistencyResult(consistency),
    ].join("\n"));

    if (consistency.missingAttributes.length > 0) {
      // §Section TENTH — never send an incomplete POST: Salesforce is guaranteed to reject it with the
      // exact same FIELD_INTEGRITY_EXCEPTION this fix targets, and doing so anyway would just waste a
      // round-trip and produce a less specific error than this diagnostic already has in hand.
      throw new Error(
        `Cannot create AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} — Rule ${ruleId} is missing a condition for ` +
        `${consistency.missingAttributes.length} required price-impacting attribute(s): ${consistency.missingAttributes.join(", ")}. ` +
        `Salesforce requires every price-impacting attribute configured on this product to be represented in every Attribute-Based Adjustment's condition set.`,
      );
    }
    if (consistency.mismatches.length > 0) {
      // §Part 2/5/6 (Product-consistency fix, Laptop/Monitor) — never auto-corrected, never silently
      // POSTed anyway: Salesforce would reject this exact configuration ("select the same product record
      // for all Attribute Adjustment Conditions" / "Associate the same product with both the attribute
      // based adjustment and Attribute Adjustment Condition records"), and this diagnostic already names
      // precisely which record(s) disagree, so the caller never has to re-derive it from a generic error.
      throw new Error(
        `Cannot create AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} — Product consistency check FAILED for Rule ${ruleId}. ` +
        `Expected Product ${args.product.id}; Rule's own resolved Product: ${consistency.ruleProductId ?? "(not tracked)"}. ` +
        `Inconsistent record(s): ${consistency.mismatches.map(m => `${m.conditionId} (${m.attribute}=${m.value}, actual Product=${m.actualProductId ?? "(none)"}, source=${m.source})`).join("; ")}.`,
      );
    }
    if (consistency.unexpectedAttributes.length > 0) {
      client.logDebug(
        "execution-trace",
        `WARNING — Rule ${ruleId} has condition(s) for attribute(s) outside the expected price-impacting set: ${consistency.unexpectedAttributes.join(", ")}. Not blocking creation, but worth investigating — no unrelated condition should ever be attached.`,
      );
    }

    const payload: Record<string, unknown> = {};
    const lookups: ResolvedLookup[] = [];
    if (schema.abaProductField.field) { payload[schema.abaProductField.field.name] = args.product.id; lookups.push({ targetObject: "Product2", field: schema.abaProductField.field, value: args.product.id }); }
    if (schema.abaSellingModelField.field && args.sellingModelId) { payload[schema.abaSellingModelField.field.name] = args.sellingModelId; lookups.push({ targetObject: "ProductSellingModel", field: schema.abaSellingModelField.field, value: args.sellingModelId }); }
    if (schema.abaRuleField.field) { payload[schema.abaRuleField.field.name] = ruleId; lookups.push({ targetObject: "AttributeBasedAdjRule", field: schema.abaRuleField.field, value: ruleId }); }
    if (schema.abaScheduleField.field) { payload[schema.abaScheduleField.field.name] = scheduleId; lookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.abaScheduleField.field, value: scheduleId }); }
    if (schema.abaConditionField && conditionId) { payload[schema.abaConditionField.name] = conditionId; lookups.push({ targetObject: "AttributeAdjustmentCondition", field: schema.abaConditionField, value: conditionId }); }
    if (schema.abaTypeField && abaTypeValue) payload[schema.abaTypeField.name] = abaTypeValue;
    if (schema.abaValueField) payload[schema.abaValueField.name] = row.adjustment;
    if (schema.abaEffFromField) payload[schema.abaEffFromField.name] = effectiveFrom;
    if (schema.abaEffToField) payload[schema.abaEffToField.name] = effectiveTo;

    let adjustmentId: string;
    let reconciledFromDuplicateError = false;
    let reconciledAdjustmentType: string | null = null;
    let reconciledAdjustmentValue: number | null = null;
    try {
      adjustmentId = await guardedCreate(client, "AttributeBasedAdjustment", schema.abaDescribe, payload, lookups, "create-adjustment");
      client.logDebug("execution-trace", [
        `✓ Salesforce accepted AttributeBasedAdjustment`,
        `  ID = ${adjustmentId}`,
        `[ABP] Salesforce create result: SUCCESS (${adjustmentId})`,
      ].join("\n"));
    } catch (err) {
      if (isProductConsistencyError(err)) {
        // §Part 6 (Laptop/Monitor, Product-consistency fix) — checked FIRST: this must never fall through
        // to `isAttributeBasedAdjustmentDuplicateError` below (whose broad regex would also match this
        // message) and attempt a "duplicate reconciliation" — there is no existing record to reconcile TO
        // here, only a genuine Product2 relationship inconsistency. Re-resolve (Salesforce's rejection is
        // authoritative; this run's own pre-flight view could be stale on an org where the Rule/Condition
        // product fields couldn't be scoped ahead of time) and report exactly which record(s) disagree.
        const reResolved = await validateAttributePricingProductConsistency(client, schema, contexts, ruleId, args.product.id, expectedAttributeNames);
        client.logDebug("execution-trace", [
          "✕ Salesforce rejected AttributeBasedAdjustment",
          "",
          "  HTTP 400",
          "  FIELD_INTEGRITY_EXCEPTION (Product consistency)",
          "",
          formatProductConsistencyResult(reResolved),
          "",
          `  Raw Salesforce message: ${err instanceof Error ? err.message : String(err)}`,
        ].join("\n"));
        throw new Error(
          `Salesforce rejected AttributeBasedAdjustment creation for ${row.attributeLabel} = ${row.valueLabel}: "${err instanceof Error ? err.message : String(err)}". ` +
          `Expected Product ${args.product.id}; Rule's own resolved Product: ${reResolved.ruleProductId ?? "(not tracked)"}. ` +
          `Inconsistent record(s) found on re-query: ${reResolved.mismatches.map(m => `${m.conditionId} (${m.attribute}=${m.value}, actual Product=${m.actualProductId ?? "(none)"})`).join("; ") || "(none — see server logs for the full diagnostic)"}. ` +
          `Never auto-corrected — this is a genuine Salesforce configuration conflict, not a safe reuse case.`,
        );
      }
      if (isMissingPriceImpactingAssociationError(err)) {
        // §Section ELEVENTH — re-resolve (Salesforce's rejection is authoritative; this run's own
        // in-memory view could be stale) and report exactly what was required/supplied/missing, never a
        // bare rethrow of Salesforce's generic message.
        const reResolved = await resolveAdjustmentConditions(client, schema, contexts, ruleId, expectedAttributeNames);
        client.logDebug("execution-trace", [
          "✕ Salesforce rejected AttributeBasedAdjustment",
          "",
          "  HTTP 400",
          "  FIELD_INTEGRITY_EXCEPTION",
          "",
          `  Required condition association: all ${expectedAttributeNames.length} price-impacting attribute(s) — ${expectedAttributeNames.join(", ")}`,
          `  Conditions supplied: ${formatResolvedConditionSet(reResolved)}`,
          `  Conditions missing: ${reResolved.missingAttributes.join(", ") || "(none detected on re-query — see the raw Salesforce message below for the actual reason)"}`,
          `  Conditions incorrectly associated: ${reResolved.unexpectedAttributes.join(", ") || "(none)"}`,
          "",
          `  Raw Salesforce message: ${err instanceof Error ? err.message : String(err)}`,
        ].join("\n"));
        throw new Error(
          `Salesforce rejected AttributeBasedAdjustment creation for ${row.attributeLabel} = ${row.valueLabel}: "Associate all price impacting attributes with the relevant Attribute Adjustment Condition." ` +
          `Required: ${expectedAttributeNames.join(", ")}. Missing on re-query: ${reResolved.missingAttributes.join(", ") || "(none — see server logs for the full diagnostic)"}.`,
        );
      }
      if (!isAttributeBasedAdjustmentDuplicateError(err)) throw err;
      // §Part 5 — Salesforce itself just reported that a record matching this EXACT
      // Product+SellingModel+conditions+Schedule+EffectiveFrom/To already exists. Never treated as
      // fatal on its own: re-query for the exact match and reuse it if found; only a genuine mismatch
      // (which should be unreachable given Salesforce is the one that just proved a match exists) is a
      // hard failure.
      client.logDebug(
        "execution-trace",
        `[ABP] Salesforce duplicate detected for Rule ${ruleId} (${row.attributeLabel} = ${row.valueLabel}): ${err instanceof Error ? err.message : String(err)}. ` +
        `Re-querying for the exact existing match instead of failing immediately.`,
      );
      // §Step 6 — narrow re-query first (same logic as the original preflight): a genuine exact match is
      // almost always found here (this is the common case — a race, or a leftover from a prior partial
      // run). Never falls straight to "genuine conflict" without trying the broader pass below first.
      let reconciled = await findExistingAttributeBasedAdjustment(client, schema, attributeIdentityById, requested);
      if (!reconciled.id) {
        client.logDebug(
          "execution-trace",
          `[ABP] Narrow re-query found no exact match for ${row.attributeLabel} = ${row.valueLabel}. Salesforce just proved a matching record exists, so this app's own ` +
          `name-resolved comparison has a gap, not that no record exists — attempting one broader diagnostic re-query (raw identity Id + normalized value comparison, ` +
          `no cheap-field pre-exclusion) before declaring a genuine conflict.`,
        );
        reconciled = await broadFindExistingAttributeBasedAdjustment(client, schema, requested, ruleId);
      }
      if (!reconciled.id) {
        client.logDebug("execution-trace", `[ABP] Genuine configuration conflict for ${row.attributeLabel} = ${row.valueLabel} — no logically equivalent AttributeBasedAdjustment found even after the broader re-query (exact-date and date-overlap tiers both failed). Gathering raw Salesforce diagnostics before failing.`);
        const rawDiagnostics = await buildGenuineConflictDiagnostics(client, schema, requested).catch(
          diagErr => `(raw diagnostic gathering itself failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)})`,
        );
        client.logDebug("execution-trace", rawDiagnostics);
        throw new Error(
          `Salesforce rejected AttributeBasedAdjustment creation for ${row.attributeLabel} = ${row.valueLabel} as a duplicate of an already-existing record, ` +
          `but neither the exact-identity re-query, a date-overlap re-query, nor a broader raw-condition re-query (${formatAdjustmentIdentityForLog(requested)}) found a logically equivalent match. ` +
          `This is a genuine configuration conflict, not a safe reuse case — refusing to guess. Original Salesforce error: ${err instanceof Error ? err.message : String(err)}\n\n${rawDiagnostics}`,
        );
      }

      // §Phase 8/10 — Salesforce's OWN duplicate rejection just proved this identity already exists; the
      // reconciled candidate's adjustment VALUE still needs the same classification as the preflight
      // path (never conflate "the identity matches" with "the value also matches").
      const reconciledOutcome = classifyAdjustmentMatch(
        { existingAdjustmentType: reconciled.existingAdjustmentType, existingAdjustmentValue: reconciled.existingAdjustmentValue },
        { type: abaTypeValue, value: row.adjustment }, hasValueTracking, override,
      );
      client.logDebug("execution-trace", `[ABP] Duplicate-error reconciliation — adjustment value comparison: existing(type=${reconciled.existingAdjustmentType ?? "(none)"}, value=${reconciled.existingAdjustmentValue ?? "(none)"}) vs requested(type=${abaTypeValue ?? "(none)"}, value=${row.adjustment}) → ${reconciledOutcome}.`);

      if (reconciledOutcome === "CONFLICT") {
        pendingConflicts.push({
          ruleId, attributeName: row.attributeName, attributeLabel: row.attributeLabel, value: row.value, valueLabel: row.valueLabel,
          productId: args.product.id, productName: args.product.name,
          existingAdjustmentId: reconciled.id, existingAdjustmentType: reconciled.existingAdjustmentType, existingAdjustmentValue: reconciled.existingAdjustmentValue,
          requestedAdjustmentType: abaTypeValue, requestedAdjustmentValue: row.adjustment,
        });
        onProgress?.(`⚠ Salesforce reported a duplicate for ${row.attributeLabel} = ${row.valueLabel} with a different existing value (existing=${reconciled.existingAdjustmentValue ?? "(none)"}, requested=${row.adjustment}) — awaiting your decision.`);
        step(steps, "create-adjustment", "info", `⚠ ${row.attributeLabel} = ${row.valueLabel} — Salesforce's existing record has adjustment value ${reconciled.existingAdjustmentValue ?? "(none)"}, this run requested ${row.adjustment}. Choose USE_EXISTING or USE_NEW and resubmit.`);
        continue;
      }
      if (reconciledOutcome === "USE_NEW") {
        await applyUseNewAdjustmentValue(client, schema, reconciled.id, abaTypeValue, row.adjustment);
        identityCache.set(cacheKey, { id: reconciled.id, type: abaTypeValue, value: row.adjustment });
        updatedAdjustmentIds.push(reconciled.id);
        decisions.push({
          step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
          candidateAdjustmentId: reconciled.id, candidateCount: reconciled.candidateCount, conditionMatch: true, decision: "UPDATE", adjustmentId: reconciled.id,
        });
        onProgress?.(`✓ Salesforce reported a duplicate for ${row.attributeLabel} = ${row.valueLabel} — updated it to the requested value (per your USE_NEW decision).`);
        step(steps, "create-adjustment", "info", `✓ Updated AttributeBasedAdjustment ${reconciled.id} for ${row.attributeLabel} = ${row.valueLabel} — Salesforce's native update mechanism, never a duplicate create.`);
        continue;
      }

      client.logDebug("execution-trace", `[ABP] Reuse result — duplicate-error reconciliation found a logically equivalent match: ${reconciled.id}. Reusing it instead of creating a duplicate.`);
      adjustmentId = reconciled.id;
      candidateCount = reconciled.candidateCount;
      reconciledAdjustmentType = reconciled.existingAdjustmentType;
      reconciledAdjustmentValue = reconciled.existingAdjustmentValue;
      reconciledFromDuplicateError = true;
    }

    if (!reconciledFromDuplicateError) {
      // §Part 10/11 — never trust the create response's Id alone: read the new record back and verify
      // its COMPLETE identity before it is allowed into the reuse cache or counted as this rule's Adjustment.
      const verification = await verifyCreatedAdjustmentIdentity(client, schema, attributeIdentityById, adjustmentId, requested);
      if (!verification.matches) {
        throw new Error(
          `AttributeBasedAdjustment ${adjustmentId} was created for ${row.attributeLabel} = ${row.valueLabel}, but its read-back identity does not match ` +
          `what was requested (${verification.mismatches.join("; ")}) — refusing to cache or trust this record.`,
        );
      }
      client.logDebug("execution-trace", [
        "✓ Adjustment read-back verified",
        `  ID = ${adjustmentId}`,
        `  Conditions = ${consistency.conditions.map(c => `${c.conditionId} (${c.attributeName}=${c.attributeValue}, Product=${c.productId ?? "(not tracked)"})`).join(", ") || "(none)"}`,
      ].join("\n"));
    }

    identityCache.set(
      cacheKey,
      reconciledFromDuplicateError
        ? { id: adjustmentId, type: reconciledAdjustmentType, value: reconciledAdjustmentValue }
        : { id: adjustmentId, type: abaTypeValue, value: row.adjustment },
    );
    if (reconciledFromDuplicateError) {
      reusedAdjustmentIds.push(adjustmentId);
      decisions.push({
        step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
        candidateAdjustmentId: adjustmentId, candidateCount, conditionMatch: true, decision: "REUSE", adjustmentId,
      });
      onProgress?.(`✓ Salesforce reported a duplicate for ${row.attributeLabel} = ${row.valueLabel} — reconciled to existing Adjustment ${adjustmentId}.`);
      step(steps, "create-adjustment", "info", `✓ Salesforce duplicate-error reconciliation — reusing existing Adjustment ${adjustmentId} for ${row.attributeLabel} = ${row.valueLabel}.`);
    } else {
      adjustmentIds.push(adjustmentId);
      decisions.push({
        step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
        candidateAdjustmentId: null, candidateCount, conditionMatch: false, decision: "CREATE", adjustmentId,
      });
      onProgress?.(`✓ Created AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel}.`);
      step(steps, "create-adjustment", "info", `✓ Created AttributeBasedAdjustment ${adjustmentId} for ${row.attributeLabel} = ${row.valueLabel}.`);
    }
  }

  // §Root-cause fix (this turn) — Salesforce's OWN FIELD_INTEGRITY_EXCEPTION proved the org's real
  // uniqueness key for AttributeBasedAdjustment is Product + Selling Model + complete condition set +
  // Schedule + Effective From/To — NOT Rule. So "N rules -> up to N distinct Adjustments" is not
  // universally true: whenever two or more Rules' full condition sets are byte-identical (any Rule
  // whose own varying attribute sits at that attribute's own baseline value — expected once every Rule
  // carries a complete condition set), they MUST share exactly ONE AttributeBasedAdjustment; Salesforce
  // itself rejects a second create attempt for the same complete configuration. A shared condition
  // signature across different Rules is therefore expected and correct, never a defect.
  const signatureCounts = new Map<string, number>();
  for (const d of decisions) signatureCounts.set(d.conditionSignature, (signatureCounts.get(d.conditionSignature) ?? 0) + 1);
  const sharedSignatures = [...signatureCounts.entries()].filter(([, count]) => count > 1);
  const uniqueSignatures = signatureCounts.size;
  const distinctAdjustmentRecords = new Set([...adjustmentIds, ...reusedAdjustmentIds]).size;

  client.logDebug("execution-trace", [
    "Attribute-Based Adjustment summary",
    `Requested pricing rules: ${plans.length}`,
    `AttributeBasedAdjustments requested (rules without one already found via createOrReuseAttributeBasedAdjRules): ${decisions.length}`,
    `Existing matching AttributeBasedAdjustments reused (including Salesforce-duplicate-error reconciliations): ${reusedAdjustmentIds.length}`,
    `New AttributeBasedAdjustments created: ${adjustmentIds.length}`,
    `Existing AttributeBasedAdjustments updated to a new value (USE_NEW decisions): ${updatedAdjustmentIds.length}`,
    `Adjustment-value conflicts awaiting a user decision: ${pendingConflicts.length}${pendingConflicts.length > 0 ? ` (${pendingConflicts.map(c => `${c.attributeLabel}=${c.valueLabel}`).join(", ")})` : ""}`,
    `Distinct AttributeBasedAdjustment records in play: ${distinctAdjustmentRecords} (may legitimately be FEWER than ${plans.length} rules — see below)`,
    `Unique condition signatures this run attempted: ${uniqueSignatures} of ${decisions.length}`,
    sharedSignatures.length > 0
      ? `${sharedSignatures.length} condition signature(s) are shared by more than one rule (expected whenever a rule's varying attribute sits at that attribute's own baseline value): ${sharedSignatures.map(([sig, n]) => `"${sig}" (${n}x)`).join(", ")} — Salesforce's own uniqueness constraint requires these to share exactly ONE AttributeBasedAdjustment (matched on Product+SellingModel+conditions+Schedule+EffectiveFrom/To).`
      : "No condition signatures shared across rules this run.",
  ].join("\n"));
  step(
    steps, "create-adjustment", pendingConflicts.length > 0 ? "info" : "success",
    `${adjustmentIds.length} adjustment(s) created, ${reusedAdjustmentIds.length} reused, ${updatedAdjustmentIds.length} updated${pendingConflicts.length > 0 ? `, ${pendingConflicts.length} awaiting a value-conflict decision` : ""}.`,
  );
  return { adjustmentIds, reusedAdjustmentIds, updatedAdjustmentIds, decisions, pendingConflicts };
}

/* ── Phase: Multi-Attribute Combination Rules ──
 *
 * §Root-cause architecture fix (live evidence) — real Salesforce `DecisionTableParameter` metadata proved
 * the AttributeDiscount Decision Table matches on ONE complete-combination `AttributeAdjConditionsHash`
 * per row (see `project_attribute_based_decision_table_lookup_verified`); every stored
 * `AttributeBasedAdjustment` created by `createOrReuseAttributeBasedAdjRules`/`createAttributeAdjustmentConditions`
 * above represents exactly ONE varying attribute with every OTHER price-impacting attribute pinned to its
 * baseline default (confirmed by this file's own prior comment: "multi-attribute combination rules... are
 * not modeled anywhere in this pipeline's rule-plan shape yet — out of scope here"). Selecting two
 * price-impacting attributes away from their defaults at once therefore produces a combined-state hash that
 * matches NO existing row — real Quote evidence showed the second attribute's own adjustment applying
 * instead of accumulating on top of the first, never "resetting" as such: each single-attribute selection
 * genuinely is a complete, independent, correctly-priced state on its own.
 *
 * True cumulative pricing requires a Decision Table row (Rule + complete condition set + Adjustment) for
 * every COMBINATION of attributes the org has priced, not just each attribute in isolation. This phase
 * discovers every existing "pure" single-attribute Adjustment already on this Product+Schedule (an
 * attribute's own priced options), computes the combinatorial closure of 2+-simultaneously-varying
 * combinations, and creates whichever combination rows don't already exist — using the exact same
 * identity/idempotency machinery (`computeRuleConditionSignature`, `findExistingAttributeBasedAdjustment`,
 * `guardedCreate`) the single-attribute path above already relies on, so a combination row is exactly as
 * safe to create/reuse repeatedly as a single-attribute one.
 *
 * §Combination arithmetic (deliberately conservative — never guessed per-combination) — same-type
 * adjustments combine by SUMMING their values (documented assumption: additive stacking, the most common
 * and intuitive interpretation for "Amount"-type deltas, and applied identically to "Percentage"-type as an
 * additive percentage-of-base — e.g. +10% and +5% combine to +15%, never compounded/multiplicative, since
 * this codebase has no evidence either way and additive is the simpler, more predictable default). A
 * combination that mixes adjustment TYPES (e.g. one Amount-type member with one Percentage-type member), or
 * that includes any "override"-type member at all, has no well-defined combined value — override
 * semantically means "replace the price outright," which cannot be summed with anything — so it is SKIPPED
 * (reported via `skippedReason`, never silently dropped, never guessed) rather than faked.
 *
 * §Scale guardrail — `computeAttributeCombinations`'s `maxCombinations` caps the closure (default 500) so a
 * product with many attributes × many priced values per attribute cannot silently trigger thousands of
 * Salesforce writes in one call; hitting the cap is reported, never silently truncated without a trace.
 */

export interface AttributePricedOption {
  attributeName: string;
  attributeLabel: string;
  value: string;
  valueLabel: string;
  ruleId: string;
  adjustmentId: string;
  /** The raw Salesforce picklist value on `abaTypeField` (e.g. "Amount"/"Percentage"/"Override") — never
   * the internal `"fixed" | "percentage" | "override"` kind, since combinations compare/sum this directly
   * against what's actually stored. */
  adjustmentType: string | null;
  adjustmentValue: number | null;
}

export interface AttributeCombinationMember {
  attributeName: string;
  attributeLabel: string;
  value: string;
  valueLabel: string;
}

export interface AttributeCombinationPlan {
  members: AttributeCombinationMember[];
  ruleId: string | null;
  reusedExisting: boolean;
  adjustmentId: string | null;
  combinedAdjustmentType: string | null;
  combinedAdjustmentValue: number | null;
  /** Non-null (and every other field null/false) when this combination could not be safely combined —
   * mixed adjustment types or an override involved. Never silently dropped; always reported. */
  skippedReason: string | null;
}

export interface CombinationExpansionResult {
  discoveredOptions: AttributePricedOption[];
  plans: AttributeCombinationPlan[];
  createdCount: number;
  reusedCount: number;
  skippedCount: number;
}

/** Every existing "pure" single-attribute Adjustment for this Product+Schedule+SellingModel — a Rule whose
 * complete condition set (every price-impacting attribute represented, per the same invariant
 * `createAttributeAdjustmentConditions` already enforces) has EXACTLY ONE condition away from that
 * attribute's own baseline default. Read-only; never mutates anything. */
export async function discoverSingleAttributePricedOptions(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string }; sellingModelId: string | null; scheduleId: string },
  contexts: Map<string, AttributeContext>,
): Promise<AttributePricedOption[]> {
  const priceImpactingEntries = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true);
  const conditionProductFieldName = schema.conditionProductField.field?.name ?? null;
  // §Live-org fix — this org's real `AttributeBasedAdjRule` (confirmed via `prepareAttributeBasedAdjustmentSchema`'s
  // own Describe) has NO Product2 lookup field at all, exactly the shape this file's OWN existing
  // `resolveProductConsistentRuleCandidate` was already built to handle ("this org's AttributeBasedAdjRule has
  // no Product2 lookup field; rule candidate evaluation relies entirely on Condition-level Product2
  // verification"). A discovery gate that required `ruleProductField.field` unconditionally silently found
  // zero rules on exactly this shape — fixed by scoping via the CONDITION's own Product2 field instead
  // whenever the Rule has none (never both required, never neither: at least one real, safe way to scope by
  // product must exist, or this function refuses to guess and returns nothing).
  if (priceImpactingEntries.length < 2 || !schema.abaRuleField.field || !schema.abaScheduleField.field || (!schema.ruleProductField.field && !conditionProductFieldName)) return [];

  const baseConfig = await resolveBaseProductConfiguration(client, args.product.id, priceImpactingEntries);
  // §Normalized-key map — `resolveBaseProductConfiguration`'s baseline is a real, un-normalized value, but
  // it must be compared against condition values using the SAME normalization (trim/collapse-whitespace/
  // lowercase) `computeRuleConditionSignature`/Salesforce's own duplicate-detection already treat as
  // equivalent (§Step 5 fix, `normalizeConditionText`) — never a case/whitespace-sensitive string compare
  // that could miss a baseline match over incidental formatting differences.
  const defaultValueByNormalizedAttr = new Map<string, string | null>(
    priceImpactingEntries.map(([name]) => [normalizeAttrName(name), baseConfig.attributes[name]?.value != null ? normalizeConditionText(baseConfig.attributes[name].value) : null]),
  );
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);

  const identityFieldNames = [schema.conditionPadField.field?.name, schema.conditionAttrDefField.field?.name].filter((n): n is string => !!n);
  const valueFieldNames = collectConditionValueFieldNames(schema.conditionDescribe);
  const conditionSelectFields = [...new Set(["Id", schema.conditionRuleField.field!.name, ...identityFieldNames, ...valueFieldNames, ...(conditionProductFieldName ? [conditionProductFieldName] : [])])];

  // §Deliberately a direct query here, not `computeRuleConditionSignature` — that function's tokens are
  // normalized (lowercased, whitespace-collapsed) for EQUALITY comparison purposes and cannot be reversed
  // back into the real, original-cased attribute name/value this function needs to store and later
  // re-query by. Mirrors that function's own query shape exactly, just keeping the raw records.
  let ruleIds: string[];
  let conditionsByRule: Map<string, (Record<string, unknown> & { Id: string })[]> | null = null;
  if (schema.ruleProductField.field) {
    const ruleRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT Id FROM AttributeBasedAdjRule WHERE ${schema.ruleProductField.field.name} = '${soqlEscape(args.product.id)}' LIMIT 500`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
    ruleIds = ruleRes.records.map(r => r.Id);
  } else {
    // `conditionProductFieldName` is guaranteed non-null here — checked by the early-return gate above.
    const condRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${conditionSelectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${conditionProductFieldName} = '${soqlEscape(args.product.id)}' LIMIT 5000`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
    conditionsByRule = new Map();
    for (const condRec of condRes.records) {
      const rId = condRec[schema.conditionRuleField.field!.name] as string | undefined;
      if (!rId) continue;
      if (!conditionsByRule.has(rId)) conditionsByRule.set(rId, []);
      conditionsByRule.get(rId)!.push(condRec);
    }
    ruleIds = [...conditionsByRule.keys()];
  }

  const options: AttributePricedOption[] = [];
  for (const ruleId of ruleIds) {
    const conditionRecords = conditionsByRule
      ? (conditionsByRule.get(ruleId) ?? [])
      : (await client.query<Record<string, unknown> & { Id: string }>(
          `SELECT ${conditionSelectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${schema.conditionRuleField.field!.name} = '${soqlEscape(ruleId)}'`,
        ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }))).records;

    const distinctConditionProductIds = [...new Set(conditionRecords.map(r => conditionProductFieldName ? ((r[conditionProductFieldName] as string | null | undefined) ?? null) : null))];
    if (distinctConditionProductIds.length > 1) continue;

    const nonBaseline: { attributeName: string; value: string }[] = [];
    let anyUnresolved = false;
    for (const condRec of conditionRecords) {
      let identityId: string | null = null;
      for (const f of identityFieldNames) {
        const v = condRec[f];
        if (typeof v === "string" && v) { identityId = v; break; }
      }
      const attributeName = identityId ? attributeIdentityById.get(identityId) : undefined;
      if (!attributeName) { anyUnresolved = true; continue; }

      let rawValue: string | null = null;
      for (const f of valueFieldNames) {
        const v = condRec[f];
        if (v !== null && v !== undefined && v !== "") { rawValue = String(v); break; }
      }
      if (rawValue === null) continue;

      const normalizedDefault = defaultValueByNormalizedAttr.get(normalizeAttrName(attributeName));
      if (normalizedDefault !== undefined && normalizeConditionText(rawValue) !== normalizedDefault) {
        nonBaseline.push({ attributeName, value: rawValue });
      }
    }
    // Only a "pure" single-attribute rule (every price-impacting attribute resolvable, exactly one away
    // from baseline) is a combination atom — a rule with an unresolved condition, or 0 or 2+ non-baseline
    // conditions, is either meaningless (all-baseline), untrustworthy, or already a combination itself
    // (never re-combined with itself; its own future combinations are covered by treating its ATOMS as
    // options instead).
    if (anyUnresolved || nonBaseline.length !== 1) continue;
    const [{ attributeName, value }] = nonBaseline;
    if (!contexts.has(attributeName)) continue;

    const abaSelect = [...new Set(["Id", schema.abaScheduleField.field.name,
      ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
      ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
      ...(schema.abaValueField ? [schema.abaValueField.name] : []),
    ])];
    const abaRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${abaSelect.join(", ")} FROM AttributeBasedAdjustment WHERE ${schema.abaRuleField.field.name} = '${soqlEscape(ruleId)}' AND ${schema.abaScheduleField.field.name} = '${soqlEscape(args.scheduleId)}' LIMIT 5`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
    const match = abaRes.records.find(a => {
      const sellingModelMatches = !schema.abaSellingModelField.field
        || ((a[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) === (args.sellingModelId ?? null);
      return sellingModelMatches;
    });
    if (!match) continue;

    options.push({
      attributeName, attributeLabel: attributeName, value, valueLabel: value, ruleId,
      adjustmentId: match.Id,
      adjustmentType: schema.abaTypeField ? ((match[schema.abaTypeField.name] as string | null | undefined) ?? null) : null,
      adjustmentValue: schema.abaValueField ? ((match[schema.abaValueField.name] as number | null | undefined) ?? null) : null,
    });
  }
  return options;
}

/** Every combination of 2+ simultaneously-varying attributes (never two values of the SAME attribute
 * together — a product can only hold one value per attribute at a time), computed as the cartesian product
 * of "each attribute contributes either its own baseline or exactly one of its priced options," filtered to
 * combinations with 2+ non-baseline picks. Capped at `maxCombinations` (reported, never silently truncated
 * — the caller sees `combinations.length` directly). */
export function computeAttributeCombinations(options: AttributePricedOption[], maxCombinations = 500): AttributePricedOption[][] {
  const byAttribute = new Map<string, AttributePricedOption[]>();
  for (const opt of options) {
    const list = byAttribute.get(opt.attributeName) ?? [];
    list.push(opt);
    byAttribute.set(opt.attributeName, list);
  }
  // §Determinism fix (found via a dynamic-shape test proving the planner's genericity) — attribute AND
  // value order used to follow `options`' own incidental arrival order, i.e. whatever order a Salesforce
  // SOQL query without ORDER BY happened to return rows in on a given call — never guaranteed stable
  // across calls. Left unfixed, the exact same logical combination could get assigned a DIFFERENT member
  // order (and therefore a DIFFERENT `sanitizeRuleName` output) on two separate runs, breaking
  // reuse-by-name and risking duplicate Rules for what should be recognized as the identical combination;
  // and whenever the true space exceeds `maxCombinations`, WHICH subset got capped would silently vary run
  // to run instead of being reproducible. Sorting both levels alphabetically makes every combo's member
  // order — and therefore its generated name/identity — a pure function of the DATA (attribute/value
  // names), never of incidental query-result ordering.
  const attributeNames = [...byAttribute.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of attributeNames) {
    byAttribute.get(name)!.sort((a, b) => a.value.localeCompare(b.value));
  }
  if (attributeNames.length < 2) return [];

  const choiceLists: (AttributePricedOption | null)[][] = attributeNames.map(name => [null, ...byAttribute.get(name)!]);
  const combinations: AttributePricedOption[][] = [];

  function recurse(index: number, current: AttributePricedOption[]): void {
    if (combinations.length >= maxCombinations) return;
    if (index === choiceLists.length) {
      if (current.length >= 2) combinations.push([...current]);
      return;
    }
    for (const choice of choiceLists[index]) {
      if (combinations.length >= maxCombinations) return;
      if (choice === null) recurse(index + 1, current);
      else {
        current.push(choice);
        recurse(index + 1, current);
        current.pop();
      }
    }
  }
  recurse(0, []);
  return combinations;
}

/** See this section's file-level doc comment for the exact, deliberately-conservative arithmetic rules. */
export function combineAdjustmentValues(
  members: AttributePricedOption[], overrideTypeValue: string | null,
): { type: string | null; value: number | null; skippedReason: string | null } {
  const types = new Set(members.map(m => m.adjustmentType));
  if (types.size !== 1 || [...types][0] === null) {
    return {
      type: null, value: null,
      skippedReason: `mixed or unresolved adjustment types across [${members.map(m => `${m.attributeName}=${m.adjustmentType ?? "(unknown)"}`).join(", ")}] — cannot combine into a single Decision Table row without an unambiguous, non-guessed rule.`,
    };
  }
  const type = [...types][0];
  if (overrideTypeValue && type === overrideTypeValue) {
    return {
      type: null, value: null,
      skippedReason: `adjustment type "${type}" (override) has no well-defined combination semantics — an override replaces the applicable price outright, so combining it with another attribute's adjustment is refused rather than guessed.`,
    };
  }
  const value = members.reduce((sum, m) => sum + (m.adjustmentValue ?? 0), 0);
  return { type, value, skippedReason: null };
}

/** One rule name that 2+ DIFFERENT member-sets (combinations) would sanitize to — see `sanitizeRuleName`'s
 * doc comment for the real, live-captured collision this offline analysis found and this type now guards
 * against. `members` always has length >= 2 when this appears in a `collisions` array. */
export interface CombinationNameCollisionGroup {
  ruleName: string;
  members: AttributeCombinationMember[][];
}

/** Offline, deterministic — every combination's rule name is computed via the SAME `sanitizeRuleName` the
 * real creation path uses, then grouped by name. A non-empty result means 2+ genuinely different
 * combinations would be silently merged onto one Rule (exactly the live-captured bug this fix closes) if
 * creation proceeded. Never calls Salesforce. */
export function detectCombinationNameCollisions(combinations: AttributeCombinationMember[][]): CombinationNameCollisionGroup[] {
  const byName = new Map<string, AttributeCombinationMember[][]>();
  for (const combo of combinations) {
    const members: AttributeCombinationMember[] = combo.map(o => ({ attributeName: o.attributeName, attributeLabel: o.attributeLabel, value: o.value, valueLabel: o.valueLabel }));
    const ruleName = sanitizeRuleName(members.map(m => m.attributeName).join("_"), members.map(m => m.value).join("_"));
    if (!byName.has(ruleName)) byName.set(ruleName, []);
    byName.get(ruleName)!.push(members);
  }
  const collisions: CombinationNameCollisionGroup[] = [];
  for (const [ruleName, memberSets] of byName) {
    if (memberSets.length > 1) collisions.push({ ruleName, members: memberSets });
  }
  return collisions;
}

export interface CombinationApiCostEstimate {
  totalCombinations: number;
  priceImpactingAttributeCount: number;
  estimatedApiCallsLowBound: number;
  estimatedApiCallsHighBound: number;
  formula: string;
}

/**
 * A deliberately approximate, offline estimate of Salesforce API calls `expandAttributeCombinationRules`
 * will spend — never a live measurement. Modeled directly on this file's own real request shapes (one call
 * = one `client.query`/`createRecord` round trip):
 *   - 1 one-time `AttributeBasedAdjustment` cache-seed query for the whole run (not per combination — the
 *     fix this file now applies instead of the old per-combination broad rescan).
 *   - per combination: a Rule-candidate-by-Name lookup (~2 calls with this org's schema), a condition
 *     existence check per price-impacting attribute (1 call each, +2 more — create, then a mandatory
 *     read-back verify — for every one that's genuinely new), one condition-signature query (always
 *     required), and an Adjustment create+verify (2 calls) only when nothing in the seeded cache matches.
 * Low bound assumes every attribute/adjustment is already reused; high bound assumes everything in the
 * combination is brand new. The real run's actual cost sits somewhere between these two bounds.
 */
export function estimateCombinationApiCost(totalCombinations: number, priceImpactingAttributeCount: number): CombinationApiCostEstimate {
  const perComboLow = 2 + priceImpactingAttributeCount + 1;
  const perComboHigh = 2 + 2 + priceImpactingAttributeCount * 3 + 1 + 2;
  return {
    totalCombinations,
    priceImpactingAttributeCount,
    estimatedApiCallsLowBound: 1 + totalCombinations * perComboLow,
    estimatedApiCallsHighBound: 1 + totalCombinations * perComboHigh,
    formula: `1 (one-time cache seed) + combinations × [ruleLookup(2) + attributes(${priceImpactingAttributeCount})×(1 reused..3 new) + signature(1) + ruleCreate(0..2) + adjustment(0..2)]`,
  };
}

export interface AttributeCombinationExpansionPlan {
  totalCombinations: number;
  ruleNames: string[];
  collisions: CombinationNameCollisionGroup[];
  apiCostEstimate: CombinationApiCostEstimate;
  /** `false` iff any name collision was detected — the hard "stop before creating anything" gate the
   * live-run forensic analysis asked for. `expandAttributeCombinationRules` refuses to proceed when this
   * is `false`, before making a single Salesforce write. */
  valid: boolean;
  invalidReason: string | null;
}

/** The full offline, no-Salesforce-calls pre-flight report: combination count, every planned Rule name,
 * any name collisions (which must never happen after the `sanitizeRuleName` fix, but are checked as a
 * hard safety net rather than assumed away), and an approximate API-call cost estimate. Callers MUST treat
 * `valid: false` as a hard stop — never create any record from a plan that failed this check. */
export function planAttributeCombinationExpansion(
  options: AttributePricedOption[], priceImpactingAttributeCount: number, maxCombinations = 500,
): AttributeCombinationExpansionPlan {
  const combinations = computeAttributeCombinations(options, maxCombinations);
  const collisions = detectCombinationNameCollisions(combinations);
  const ruleNames = combinations.map(combo => sanitizeRuleName(
    combo.map(o => o.attributeName).join("_"), combo.map(o => o.value).join("_"),
  ));
  return {
    totalCombinations: combinations.length,
    ruleNames,
    collisions,
    apiCostEstimate: estimateCombinationApiCost(combinations.length, priceImpactingAttributeCount),
    valid: collisions.length === 0,
    invalidReason: collisions.length > 0
      ? `${collisions.length} rule-name collision(s) detected among ${combinations.length} planned combination(s) — refusing to create any records until resolved.`
      : null,
  };
}

/**
 * §Root-cause fix (Rule-level identity decoupled from generated Name) — the deterministic-naming fix in
 * `computeAttributeCombinations` (sorting attributes/values so a Rule's generated Name no longer depends on
 * incidental Salesforce query order) exposed a real, separate defect: `resolveProductConsistentRuleCandidate`
 * — the combinatorial engine's ONLY way to recognize an already-existing Rule — looks it up by exact Name.
 * Any change to the naming convention (this fix, a future one, or simply a different org's attribute
 * ordering) makes EVERY pre-existing combination Rule "unrecognized," and a resume would create redundant,
 * orphaned Rules for combinations that already have a complete, correct one under the old name.
 *
 * The fix: identity comes from the Rule's own CONTENT — the same canonical, order-independent signature
 * `computeRuleConditionSignature` already computes for the Adjustment-reuse cache (`product=<id>|<sorted
 * attr=value tokens>`) — never from its Name. This function computes what that signature WOULD be for a
 * combination that doesn't have a Rule yet: every price-impacting attribute's combo-or-baseline value,
 * normalized and sorted the identical way, so it is directly comparable to a REAL existing Rule's own
 * signature (computed by `discoverExistingRuleContentIdentities` below the same way). `null` only when an
 * attribute has no resolvable value at all — never a guessed/partial signature.
 */
export function computeIntendedCombinationSignature(
  productId: string,
  members: { attributeName: string; value: string }[],
  priceImpactingAttributeNames: string[],
  defaultValueByAttr: Map<string, string | null>,
): string | null {
  const memberValueByAttr = new Map(members.map(m => [m.attributeName, m.value]));
  const tokens: string[] = [];
  for (const attrName of priceImpactingAttributeNames) {
    const value = memberValueByAttr.get(attrName) ?? defaultValueByAttr.get(attrName);
    if (value == null) return null;
    tokens.push(`${normalizeAttrName(attrName)}=${normalizeConditionText(value)}`);
  }
  return `product=${productId}|${tokens.sort().join("|")}`;
}

export interface ExistingRuleContentIdentity {
  ruleId: string;
  /** Display-only — read for logging, never compared for identity. */
  name: string;
  /** Every condition this Rule ACTUALLY has whose value differs from that attribute's baseline default —
   * real, observed evidence of "which attributes does this Rule vary," independent of Name, used to
   * recognize a genuinely INCOMPLETE Rule by its own content. */
  presentNonBaselineMembers: { attributeName: string; value: string }[];
  /** True only when this Rule has a resolvable condition for EVERY price-impacting attribute — the
   * invariant every fully-created combination Rule must satisfy. */
  isComplete: boolean;
  /** This Rule's own real, full condition-set signature (every price-impacting attribute, baseline and
   * non-baseline alike) — `null` when incomplete, or when any condition's identity Id couldn't be resolved
   * to a known attribute name (never guessed). Directly comparable to
   * `computeIntendedCombinationSignature`'s output. */
  signature: string | null;
  conditionCount: number;
}

/**
 * ONE bulk, product-scoped query (never one per combination, matching the same "one scoped query -> local
 * index" pattern `seedAdjustmentSignatureCache` already established) that computes EVERY existing
 * `AttributeBasedAdjRule`'s real content identity directly from its own `AttributeAdjustmentCondition`
 * rows — never from its Name. Read-only; mutates nothing.
 */
export async function discoverExistingRuleContentIdentities(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  productId: string,
  priceImpactingAttributeNames: string[],
  defaultValueByAttr: Map<string, string | null>,
): Promise<ExistingRuleContentIdentity[]> {
  const conditionProductFieldName = schema.conditionProductField.field?.name ?? null;
  if (!conditionProductFieldName) return [];
  const identityFieldNames = [schema.conditionPadField.field?.name, schema.conditionAttrDefField.field?.name].filter((n): n is string => !!n);
  const valueFieldNames = collectConditionValueFieldNames(schema.conditionDescribe);
  const selectFields = [...new Set(["Id", schema.conditionRuleField.field!.name, ...identityFieldNames, ...valueFieldNames, conditionProductFieldName])];

  const res = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${conditionProductFieldName} = '${soqlEscape(productId)}' LIMIT 50000`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));

  const byRule = new Map<string, (Record<string, unknown> & { Id: string })[]>();
  for (const rec of res.records) {
    const ruleId = rec[schema.conditionRuleField.field!.name] as string | undefined;
    if (!ruleId) continue;
    if (!byRule.has(ruleId)) byRule.set(ruleId, []);
    byRule.get(ruleId)!.push(rec);
  }
  if (byRule.size === 0) return [];

  const ruleIds = [...byRule.keys()];
  const ruleRecords = await client.query<Record<string, unknown> & { Id: string; Name?: string }>(
    `SELECT Id, Name FROM AttributeBasedAdjRule WHERE Id IN (${ruleIds.map(id => `'${soqlEscape(id)}'`).join(",")})`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string; Name?: string })[] }));
  const nameByRuleId = new Map(ruleRecords.records.map(r => [r.Id, (r.Name as string | undefined) ?? "(unnamed)"]));

  const requiredAttrs = new Set(priceImpactingAttributeNames);
  const results: ExistingRuleContentIdentity[] = [];
  for (const [ruleId, records] of byRule) {
    const resolvedByAttr = new Map<string, string>();
    let anyUnresolved = false;
    for (const rec of records) {
      let identityId: string | null = null;
      for (const f of identityFieldNames) {
        const v = rec[f];
        if (typeof v === "string" && v) { identityId = v; break; }
      }
      const attrName = identityId ? attributeIdentityById.get(identityId) : undefined;
      if (!attrName) { anyUnresolved = true; continue; }
      let rawValue: string | null = null;
      for (const f of valueFieldNames) {
        const v = rec[f];
        if (v !== null && v !== undefined && v !== "") { rawValue = String(v); break; }
      }
      if (rawValue === null) continue;
      resolvedByAttr.set(attrName, rawValue);
    }

    const presentNonBaselineMembers: { attributeName: string; value: string }[] = [];
    for (const [attrName, value] of resolvedByAttr) {
      const baseline = defaultValueByAttr.get(attrName);
      if (baseline == null || normalizeConditionText(value) !== normalizeConditionText(baseline)) {
        presentNonBaselineMembers.push({ attributeName: attrName, value });
      }
    }

    const isComplete = !anyUnresolved && [...requiredAttrs].every(a => resolvedByAttr.has(a));
    let signature: string | null = null;
    if (isComplete) {
      const tokens = [...resolvedByAttr.entries()].map(([attrName, value]) => `${normalizeAttrName(attrName)}=${normalizeConditionText(value)}`);
      signature = `product=${productId}|${tokens.sort().join("|")}`;
    }

    results.push({ ruleId, name: nameByRuleId.get(ruleId) ?? "(unknown)", presentNonBaselineMembers, isComplete, signature, conditionCount: records.length });
  }
  return results;
}

export interface CombinationRuleMatch {
  status: "KEEP" | "COMPLETE" | "CREATE" | "AMBIGUOUS";
  ruleId: string | null;
  reason: string;
}

/**
 * Matches every planned combination against the discovered existing Rules, PURELY by content:
 *   1. KEEP — exactly one existing, COMPLETE Rule shares this combination's intended signature.
 *   2. COMPLETE — no complete match, but exactly one existing INCOMPLETE Rule's own real, present
 *      non-baseline conditions are a subset of this combination's members, AND that incomplete Rule is not
 *      ALSO a plausible subset-match for any other combination (true cross-combination ambiguity is
 *      detected, never guessed away independently per combination).
 *   3. CREATE — no existing Rule (complete or incomplete) matches this combination's content at all.
 *   4. AMBIGUOUS — 2+ complete Rules share a signature (a real data anomaly), or an incomplete Rule's
 *      content is consistent with 2+ different planned combinations, or the intended signature itself
 *      couldn't be computed. Never resolved by guessing — the caller must skip/report, never create.
 * Rule Name is never read or compared here — see this section's file-level doc comment for why.
 *
 * §Root-cause fix (deterministic run-boundary provenance) — `currentRunEligibleRuleIds` is OPTIONAL and,
 * when provided (real production calls pass `runBoundaryStore.getRuleIdsCreatedDuringRun(executionId)`),
 * restricts INCOMPLETE-Rule candidates to only those THIS run itself created — never Name, never
 * CreatedDate, never attribute/condition count alone (a live forensic investigation proved content-count
 * alone cannot distinguish a genuinely-partial current Rule from a complete historical artifact of an
 * earlier, smaller product-attribute configuration). A historical incomplete Rule outside that set is
 * simply excluded from candidacy — it can never become a false COMPLETE match, and it can no longer make
 * an unrelated combination falsely AMBIGUOUS either (see `candidatesPerIncompleteRule` below). Omitting
 * this parameter (`undefined`) preserves the exact prior, fully-conservative, content-only behavior —
 * used by offline/forensic tooling that has no run context at all, never by the real creation path.
 */
export function matchExistingRulesToCombinations(
  combinations: AttributeCombinationMember[][],
  existingRules: ExistingRuleContentIdentity[],
  productId: string,
  priceImpactingAttributeNames: string[],
  defaultValueByAttr: Map<string, string | null>,
  currentRunEligibleRuleIds?: ReadonlySet<string>,
): Map<number, CombinationRuleMatch> {
  const results = new Map<number, CombinationRuleMatch>();

  const completeBySignature = new Map<string, ExistingRuleContentIdentity[]>();
  for (const r of existingRules) {
    if (r.isComplete && r.signature) {
      if (!completeBySignature.has(r.signature)) completeBySignature.set(r.signature, []);
      completeBySignature.get(r.signature)!.push(r);
    }
  }
  const incompleteRules = existingRules.filter(r =>
    !r.isComplete && r.presentNonBaselineMembers.length > 0
    && (currentRunEligibleRuleIds === undefined || currentRunEligibleRuleIds.has(r.ruleId)),
  );
  const memberKey = (attributeName: string, value: string) => `${normalizeAttrName(attributeName)}=${normalizeConditionText(value)}`;

  const candidatesPerIncompleteRule = incompleteRules.map(rule => {
    const matchingComboIndexes: number[] = [];
    combinations.forEach((combo, i) => {
      const comboKeySet = new Set(combo.map(o => memberKey(o.attributeName, o.value)));
      const isSubset = rule.presentNonBaselineMembers.every(m => comboKeySet.has(memberKey(m.attributeName, m.value)));
      if (isSubset) matchingComboIndexes.push(i);
    });
    return { rule, matchingComboIndexes };
  });

  combinations.forEach((combo, i) => {
    const members = combo.map(o => ({ attributeName: o.attributeName, value: o.value }));
    const intendedSignature = computeIntendedCombinationSignature(productId, members, priceImpactingAttributeNames, defaultValueByAttr);
    if (!intendedSignature) {
      results.set(i, { status: "AMBIGUOUS", ruleId: null, reason: "Could not compute a complete intended signature — an attribute has no resolvable combo or baseline value." });
      return;
    }

    const completeMatches = completeBySignature.get(intendedSignature) ?? [];
    if (completeMatches.length === 1) {
      results.set(i, { status: "KEEP", ruleId: completeMatches[0].ruleId, reason: `Existing Rule ${completeMatches[0].ruleId} has the identical complete condition-set signature.` });
      return;
    }
    if (completeMatches.length > 1) {
      results.set(i, { status: "AMBIGUOUS", ruleId: null, reason: `${completeMatches.length} existing Rules share the identical complete signature — a real data anomaly, never resolved by guessing.` });
      return;
    }

    const uniqueIncompleteMatches = candidatesPerIncompleteRule.filter(c => c.matchingComboIndexes.length === 1 && c.matchingComboIndexes[0] === i);
    if (uniqueIncompleteMatches.length === 1) {
      results.set(i, { status: "COMPLETE", ruleId: uniqueIncompleteMatches[0].rule.ruleId, reason: `Existing incomplete Rule ${uniqueIncompleteMatches[0].rule.ruleId}'s own present condition(s) uniquely match only this combination.` });
      return;
    }
    if (uniqueIncompleteMatches.length > 1) {
      results.set(i, { status: "AMBIGUOUS", ruleId: null, reason: `${uniqueIncompleteMatches.length} incomplete existing Rules could each uniquely complete this combination — never resolved by guessing.` });
      return;
    }
    const crossAmbiguous = candidatesPerIncompleteRule.some(c => c.matchingComboIndexes.length > 1 && c.matchingComboIndexes.includes(i));
    if (crossAmbiguous) {
      results.set(i, { status: "AMBIGUOUS", ruleId: null, reason: "An incomplete existing Rule's present conditions are consistent with multiple different planned combinations — never resolved by guessing." });
      return;
    }

    results.set(i, { status: "CREATE", ruleId: null, reason: "No existing Rule (complete or incomplete) matches this combination's content." });
  });
  return results;
}

/**
 * §API-efficiency fix (offline forensic analysis) — the live run's own captured log, cross-referenced
 * against `findExistingAttributeBasedAdjustment`'s source, proved an O(N²) cost: that function does a
 * BROAD (never Rule-scoped, by design — see its own doc comment) Product+Schedule candidate scan and then
 * computes a fresh `computeRuleConditionSignature` for every not-yet-eliminated candidate, called ONCE PER
 * COMBINATION. Since every combination in one run shares the identical Product/Schedule/SellingModel/
 * EffectiveFrom/EffectiveTo, that "cheap filter" eliminates nothing across combinations in the same run —
 * so by combination #71 (where the real run's daily API budget was exhausted), the cumulative extra cost
 * from this one function alone was already on the order of 1+2+...+71 ≈ 2,500 signature-recompute queries,
 * on top of every other per-combination cost. This seeds the exact same candidate set ONCE, computes each
 * DISTINCT existing Rule's signature at most once, and returns a plain signature->adjustment cache that
 * `expandAttributeCombinationRules` can look up in O(1) per combination — turning that one function's cost
 * from O(N²) into O(N) for a full run. Never mutates anything; a query failure returns an empty cache and
 * the caller degrades to always attempting a create (never a silent false-negative reuse).
 */
async function seedAdjustmentSignatureCache(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  args: { productId: string; sellingModelId: string | null; scheduleId: string; effectiveFrom: string; effectiveTo: string },
): Promise<Map<string, { id: string; type: string | null; value: number | null }>> {
  const cache = new Map<string, { id: string; type: string | null; value: number | null }>();
  const selectFields = ["Id",
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
    ...(schema.abaTypeField ? [schema.abaTypeField.name] : []),
    ...(schema.abaValueField ? [schema.abaValueField.name] : []),
  ];
  const whereClauses: string[] = [];
  if (schema.abaProductField.field) whereClauses.push(`${schema.abaProductField.field.name} = '${soqlEscape(args.productId)}'`);
  if (schema.abaScheduleField.field) whereClauses.push(`${schema.abaScheduleField.field.name} = '${soqlEscape(args.scheduleId)}'`);
  const soql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM AttributeBasedAdjustment${whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""}`;
  client.logDebug("execution-trace", `Combinatorial Adjustment cache seed — ONE broad scan for this whole run (replaces the old per-combination rescan): ${soql}`);

  let records: (Record<string, unknown> & { Id: string })[];
  try {
    records = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
  } catch (err) {
    client.logDebug("execution-trace", `Combinatorial Adjustment cache seed — query FAILED, starting with an empty cache (safe: every combination will attempt its own create, never a false-negative reuse): ${err instanceof Error ? err.message : String(err)}`);
    return cache;
  }

  const signatureByRuleId = new Map<string, RuleConditionSignatureResult>();
  for (const rec of records) {
    const sellingModelMatches = !schema.abaSellingModelField.field || (((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) === (args.sellingModelId ?? null));
    const effFromMatches = !schema.abaEffFromField || normalizeDateValue(rec[schema.abaEffFromField.name]) === normalizeDateValue(args.effectiveFrom);
    const effToMatches = !schema.abaEffToField || normalizeDateValue(rec[schema.abaEffToField.name]) === normalizeDateValue(args.effectiveTo);
    const ruleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;
    if (!sellingModelMatches || !effFromMatches || !effToMatches || !ruleId) continue;

    if (!signatureByRuleId.has(ruleId)) {
      signatureByRuleId.set(ruleId, await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId));
    }
    const sig = signatureByRuleId.get(ruleId)!;
    if (sig.queryFailed || !sig.signature || sig.distinctConditionProductIds.length > 1) continue;
    if (!cache.has(sig.signature)) {
      cache.set(sig.signature, {
        id: rec.Id,
        type: schema.abaTypeField ? ((rec[schema.abaTypeField.name] as string | null | undefined) ?? null) : null,
        value: schema.abaValueField ? ((rec[schema.abaValueField.name] as number | null | undefined) ?? null) : null,
      });
    }
  }
  client.logDebug("execution-trace", `Combinatorial Adjustment cache seed — ${cache.size} distinct, reusable (Product/Schedule/SellingModel/EffectiveFrom/EffectiveTo-matching) condition signature(s) cached from ${records.length} candidate record(s) and ${signatureByRuleId.size} distinct Rule(s) signed.`);
  return cache;
}

/**
 * §Combination-expansion architecture fix — a forensic investigation (real `DecisionTableParameter`
 * metadata + Salesforce's own `FIELD_INTEGRITY_EXCEPTION`) proved every Rule needs a condition for EVERY
 * price-impacting attribute, and confirmed no native mechanism exists for an arbitrary, unplanned
 * combination of independently-priced attributes to accumulate at runtime without a materialized Rule for
 * that exact combination. That does NOT mean every possible combination should be pre-generated, though:
 * this function now materializes ONLY the combinations `requestedCombinations` explicitly names — already
 * resolved against real Salesforce data by `analyze.ts`'s Step 8.5 — never rediscovering every historical
 * single-attribute option for this product and cross-producting them. An empty array (the default when the
 * prompt never used combination language) means this function does nothing at all: zero discovery queries,
 * zero Cartesian product, zero writes.
 *
 * Each requested combination's adjustment (`type`/`value`) is exactly what the prompt stated for THAT
 * combination — never summed from the individual members' own per-attribute adjustments (that would be a
 * different, automatic-closure concept this explicit path deliberately doesn't use, since summing was never
 * asked for and would silently invent a price the user never actually stated for this exact combination).
 */
export async function expandAttributeCombinationRules(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { product: { id: string; name: string }; sellingModelId: string | null; scheduleId: string },
  contexts: Map<string, AttributeContext>,
  requestedCombinations: CombinationRulePlanRow[],
  steps: ProcedureStepLite[],
  onProgress?: (message: string) => void,
  // §Root-cause fix (deterministic run-boundary provenance) — the SAME Id `createPipeline.ts` already
  // generates once per pipeline invocation (`generateExecutionId()`), reused here as the run-boundary
  // store's scoping key so a genuine resume (a retry presenting the same executionId, within the same
  // server process) correctly recognizes which Rules IT already created — never Name, never CreatedDate,
  // never condition count alone. Optional and self-generating (a fresh, unique id) for callers/tests that
  // don't have or care about pipeline-level run identity — every call still gets a correct, isolated run
  // scope, it just can't be resumed by a later call unless that later call passes the SAME id back.
  executionId: string = randomUUID(),
): Promise<CombinationExpansionResult> {
  if (requestedCombinations.length === 0) {
    step(steps, "create-combination-rules", "info", "No explicit combination pricing was requested — skipping combinatorial expansion entirely (default behavior: only individual attribute/value pricing is created).");
    return { discoveredOptions: [], plans: [], createdCount: 0, reusedCount: 0, skippedCount: 0 };
  }

  step(steps, "create-combination-rules", "start", `Materializing ${requestedCombinations.length} explicitly requested combination(s) — no automatic discovery, no Cartesian product.`);

  const combinations: AttributeCombinationMember[][] = requestedCombinations.map(r => r.members);

  // §Hard safety gate (offline forensic analysis) — a live run proved that without this check, 5
  // genuinely different combinations could sanitize to the identical 80-character Rule name and be
  // silently merged. `sanitizeRuleName` is now collision-safe (a content-hash suffix once truncation would
  // occur), so this should always find zero collisions — but per the explicit requirement that a collision
  // hard-stops the WHOLE run before any Salesforce write happens, it is checked for real rather than
  // assumed away.
  const nameCollisions = detectCombinationNameCollisions(combinations);
  if (nameCollisions.length > 0) {
    const detail = nameCollisions.map(c => `"${c.ruleName}" <- ${c.members.length} combinations: ${c.members.map(m => m.map(x => `${x.attributeName}=${x.value}`).join("+")).join(" | ")}`).join("; ");
    throw new Error(`Refusing to create any combination records: ${nameCollisions.length} Rule-name collision(s) detected among ${combinations.length} requested combination(s) — ${detail}`);
  }

  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
  const priceImpactingEntries = [...contexts.entries()].filter(([, ctx]) => ctx.isPriceImpacting === true);
  const baseConfig = await resolveBaseProductConfiguration(client, args.product.id, priceImpactingEntries);
  const defaultValueByAttr = new Map<string, string | null>(priceImpactingEntries.map(([name]) => [name, baseConfig.attributes[name]?.value ?? null]));
  const effectiveFrom = todayISO();
  const effectiveTo = oneYearFromTodayISO();

  // §API-efficiency fix — ONE broad scan + signature pass for the whole run, replacing the old
  // per-combination `findExistingAttributeBasedAdjustment` rescan (see `seedAdjustmentSignatureCache`'s
  // own doc comment for the real ~O(N²) cost this closes). `conditionCache` similarly avoids re-querying
  // Salesforce for a (Rule, attribute) pair this run has already resolved once — most valuable when a
  // combination legitimately resumes/reuses a Rule from a prior run.
  const adjustmentCache = await seedAdjustmentSignatureCache(client, schema, attributeIdentityById, {
    productId: args.product.id, sellingModelId: args.sellingModelId, scheduleId: args.scheduleId, effectiveFrom, effectiveTo,
  });
  const conditionCache = new Map<string, string>();

  // §Root-cause fix (Rule-level identity decoupled from generated Name) — ONE bulk, product-scoped
  // discovery of every existing Rule's real CONTENT identity, then a pure, offline match against every
  // planned combination — see `discoverExistingRuleContentIdentities`/`matchExistingRulesToCombinations`'s
  // own doc comments. Replaces the old per-combination `resolveProductConsistentRuleCandidate` Name lookup
  // for this combinatorial path (the single-attribute pipeline's own use of that function is untouched).
  const priceImpactingAttributeNames = priceImpactingEntries.map(([name]) => name);
  const existingRuleIdentities = await discoverExistingRuleContentIdentities(
    client, schema, attributeIdentityById, args.product.id, priceImpactingAttributeNames, defaultValueByAttr,
  );

  // §Root-cause fix (deterministic run-boundary provenance) — records which Rules already existed when
  // this run began (diagnostic only), then reads back exactly which Rule Ids THIS SAME `executionId` has
  // created so far (possibly across an earlier call, on a genuine resume) — the only set an incomplete
  // existing Rule can belong to before it's eligible for "COMPLETE." See runBoundaryStore.ts's own doc
  // comment for why this replaces CreatedDate-gap heuristics as the PRODUCTION mechanism (CreatedDate
  // clustering stays available separately as a read-only forensic tool, never wired in here).
  beginRunSnapshot(executionId, args.product.id, new Set(existingRuleIdentities.map(r => r.ruleId)));
  const currentRunEligibleRuleIds = getRuleIdsCreatedDuringRun(executionId);
  const ruleMatches = matchExistingRulesToCombinations(combinations, existingRuleIdentities, args.product.id, priceImpactingAttributeNames, defaultValueByAttr, currentRunEligibleRuleIds);

  const plans: AttributeCombinationPlan[] = [];
  let createdCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;

  for (const [comboIndex, requested] of requestedCombinations.entries()) {
    const members = requested.members;
    const label = members.map(m => `${m.attributeName}=${m.valueLabel}`).join(" AND ");

    // The combination's adjustment is exactly what the prompt stated for it — never summed from the
    // members' own individual per-attribute adjustments.
    const resolvedType = schema.abaTypeField ? resolveAdjustmentTypeValue(schema.abaTypeField, requested.adjustmentType) : null;
    if (schema.abaTypeField && !resolvedType) {
      const skippedReason = `Could not resolve adjustment type "${requested.adjustmentType}" against this org's real AttributeBasedAdjustment picklist values.`;
      plans.push({ members, ruleId: null, reusedExisting: false, adjustmentId: null, combinedAdjustmentType: null, combinedAdjustmentValue: null, skippedReason });
      skippedCount++;
      client.logDebug("execution-trace", `Combination [${label}] skipped: ${skippedReason}`);
      continue;
    }
    const combined = { type: resolvedType, value: requested.adjustment };

    const ruleName = sanitizeRuleName(members.map(m => m.attributeName).join("_"), members.map(m => m.value).join("_"));
    const match = ruleMatches.get(comboIndex)!;
    if (match.status === "AMBIGUOUS") {
      plans.push({ members, ruleId: null, reusedExisting: false, adjustmentId: null, combinedAdjustmentType: null, combinedAdjustmentValue: null, skippedReason: `Ambiguous existing-Rule match — refusing to guess: ${match.reason}` });
      skippedCount++;
      client.logDebug("execution-trace", `Combination [${label}] skipped (ambiguous Rule identity): ${match.reason}`);
      continue;
    }
    let ruleId: string;
    if (match.status === "KEEP" || match.status === "COMPLETE") {
      ruleId = match.ruleId!;
      if (match.status === "KEEP") onProgress?.(`✓ Reused existing combination AttributeBasedAdjRule (matched by content, not name) for ${label}.`);
      else onProgress?.(`✓ Completing existing incomplete combination AttributeBasedAdjRule (matched by content, not name) for ${label}.`);
    } else {
      const payload: Record<string, unknown> = { Name: ruleName };
      const resolvedLookups: ResolvedLookup[] = [];
      if (schema.ruleProductField.field) { payload[schema.ruleProductField.field.name] = args.product.id; resolvedLookups.push({ targetObject: "Product2", field: schema.ruleProductField.field, value: args.product.id }); }
      if (schema.ruleScheduleField.field) { payload[schema.ruleScheduleField.field.name] = args.scheduleId; resolvedLookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.ruleScheduleField.field, value: args.scheduleId }); }
      if (schema.ruleEffFromField) payload[schema.ruleEffFromField.name] = todayISO();
      if (schema.ruleEffToField) payload[schema.ruleEffToField.name] = oneYearFromTodayISO();
      if (schema.ruleActiveField) payload[schema.ruleActiveField.name] = true;
      ruleId = await guardedCreate(client, "AttributeBasedAdjRule", schema.ruleDescribe, payload, resolvedLookups, "create-combination-rules");
      recordRuleCreatedDuringRun(executionId, ruleId);
      onProgress?.(`✓ Created combination AttributeBasedAdjRule "${ruleName}" for ${label}.`);
    }

    // Every price-impacting attribute needs its own condition on this rule — combo members get their
    // combo value, every other attribute gets its baseline default (identical invariant to the
    // single-attribute path above, never skipped, never invented).
    const comboValueByAttr = new Map(members.map(m => [m.attributeName, m.value]));
    for (const [attrName, ctx] of priceImpactingEntries) {
      const value = comboValueByAttr.get(attrName) ?? defaultValueByAttr.get(attrName);
      if (value == null) {
        throw new Error(`Attribute "${attrName}" has no resolvable value (combination value or baseline default) while building combination rule "${ruleName}" (${label}) — refusing to create an incomplete condition set.`);
      }
      const identity = resolveConditionIdentity(schema, ctx);
      if (!identity) continue;
      const conditionCacheKey = `${ruleId}::${identity.value}`;
      if (conditionCache.has(conditionCacheKey)) continue;
      const assignment = resolveConditionValueAssignment(schema.conditionDescribe, attrName, ctx.dataType, ctx.dataTypeSource, value);
      const existingId = await findExistingAttributeAdjustmentCondition(client, schema, ruleId, identity, { fieldName: assignment.fieldName, value: assignment.value }, args.product.id);
      if (existingId) { conditionCache.set(conditionCacheKey, existingId); continue; }
      const conditionPayload: Record<string, unknown> = {
        [schema.conditionRuleField.field!.name]: ruleId,
        [identity.fieldName]: identity.value,
        [assignment.fieldName]: assignment.value,
      };
      if (assignment.dataTypeField) conditionPayload[assignment.dataTypeField.name] = assignment.dataTypeField.value;
      if (schema.conditionProductField.field) conditionPayload[schema.conditionProductField.field.name] = args.product.id;
      const conditionLookups: ResolvedLookup[] = [{ targetObject: "AttributeBasedAdjRule", field: schema.conditionRuleField.field!, value: ruleId }];
      if (identity.kind === "pad") conditionLookups.push({ targetObject: "ProductAttributeDefinition", field: schema.conditionPadField.field!, value: identity.value });
      else conditionLookups.push({ targetObject: "AttributeDefinition", field: schema.conditionAttrDefField.field!, value: identity.value });
      if (schema.conditionProductField.field) conditionLookups.push({ targetObject: "Product2", field: schema.conditionProductField.field, value: args.product.id });
      const newConditionId = await guardedCreate(client, "AttributeAdjustmentCondition", schema.conditionDescribe, conditionPayload, conditionLookups, "create-combination-rules");
      conditionCache.set(conditionCacheKey, newConditionId);
    }

    const sig = await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId);
    if (sig.queryFailed || !sig.signature) {
      throw new Error(`Could not compute a condition signature for combination Rule ${ruleId} (${ruleName}, ${label}) after creating its conditions — refusing to create an unidentifiable Adjustment.`);
    }
    // §API-efficiency fix — O(1) lookup against the run-scoped cache seeded once up front, instead of
    // calling `findExistingAttributeBasedAdjustment` (a broad rescan + per-candidate signature query) on
    // every single combination. See `seedAdjustmentSignatureCache`'s doc comment for the proven O(N²) cost
    // this replaces.
    const found = adjustmentCache.get(sig.signature) ?? null;
    let adjustmentId: string;
    let reusedExisting = false;
    if (found) {
      adjustmentId = found.id;
      reusedExisting = true;
      reusedCount++;
      onProgress?.(`✓ Reused existing combination AttributeBasedAdjustment for ${label}.`);
    } else {
      const adjustmentPayload: Record<string, unknown> = {};
      if (schema.abaProductField.field) adjustmentPayload[schema.abaProductField.field.name] = args.product.id;
      if (schema.abaSellingModelField.field && args.sellingModelId) adjustmentPayload[schema.abaSellingModelField.field.name] = args.sellingModelId;
      if (schema.abaScheduleField.field) adjustmentPayload[schema.abaScheduleField.field.name] = args.scheduleId;
      if (schema.abaRuleField.field) adjustmentPayload[schema.abaRuleField.field.name] = ruleId;
      if (schema.abaEffFromField) adjustmentPayload[schema.abaEffFromField.name] = effectiveFrom;
      if (schema.abaEffToField) adjustmentPayload[schema.abaEffToField.name] = effectiveTo;
      if (schema.abaTypeField) adjustmentPayload[schema.abaTypeField.name] = combined.type;
      if (schema.abaValueField) adjustmentPayload[schema.abaValueField.name] = combined.value;
      const adjustmentLookups: ResolvedLookup[] = [];
      if (schema.abaRuleField.field) adjustmentLookups.push({ targetObject: "AttributeBasedAdjRule", field: schema.abaRuleField.field, value: ruleId });
      if (schema.abaProductField.field) adjustmentLookups.push({ targetObject: "Product2", field: schema.abaProductField.field, value: args.product.id });
      if (schema.abaScheduleField.field) adjustmentLookups.push({ targetObject: "PriceAdjustmentSchedule", field: schema.abaScheduleField.field, value: args.scheduleId });
      adjustmentId = await guardedCreate(client, "AttributeBasedAdjustment", schema.abaDescribe, adjustmentPayload, adjustmentLookups, "create-combination-rules");
      adjustmentCache.set(sig.signature, { id: adjustmentId, type: combined.type, value: combined.value });
      createdCount++;
      onProgress?.(`✓ Created combination AttributeBasedAdjustment for ${label}: ${combined.type}=${combined.value}.`);
    }

    plans.push({ members, ruleId, reusedExisting, adjustmentId, combinedAdjustmentType: combined.type, combinedAdjustmentValue: combined.value, skippedReason: null });
  }

  step(
    steps, "create-combination-rules", "success",
    `${createdCount} explicit combination adjustment(s) created, ${reusedCount} reused, ${skippedCount} skipped, of ${requestedCombinations.length} explicitly requested combination(s).`,
  );
  return { discoveredOptions: [], plans, createdCount, reusedCount, skippedCount };
}

/**
 * §Verify Adjustment Records (Part 9 step 9) — a dedicated read-back re-query of every Id this run just
 * created/reused, run immediately after creation and before anything downstream depends on them.
 *
 * §Verification hardening (defensive only — the PRIMARY fix is preventing a duplicate/shadow Rule from
 * ever being created in the first place, in `createOrReuseAttributeBasedAdjRules`) — a raw
 * `records.length` vs `result.ruleIds.length` comparison is fragile against a duplicate VALUE in
 * `ruleIds` (e.g. two Phase-A rows that legitimately share one real Rule after the content-identity fix
 * both push that same ruleId): `WHERE Id IN (...)` naturally collapses a repeated Id to one returned row,
 * so a raw length compare would report a false "N/M" shortfall even though every referenced record
 * genuinely exists. `expectedRuleCount`/`expectedConditionCount`/`expectedAdjustmentCount` are computed
 * from the DISTINCT input ids, so the caller compares distinct-vs-distinct, never distinct-vs-raw.
 */
export async function verifyAdjustmentRecordsReadBack(
  client: SalesforceClient,
  result: NativeCreationResult,
): Promise<{
  scheduleVerified: boolean;
  ruleCount: number; expectedRuleCount: number;
  conditionCount: number; expectedConditionCount: number;
  adjustmentCount: number; expectedAdjustmentCount: number;
}> {
  const idList = (ids: string[]) => ids.map(id => `'${soqlEscape(id)}'`).join(",");
  const uniqueRuleIds = [...new Set(result.ruleIds)];
  const uniqueConditionIds = [...new Set(result.conditionIds)];
  const uniqueAdjustmentIds = [...new Set(result.adjustmentIds)];

  const scheduleRes = await client.query<{ Id: string }>(`SELECT Id FROM PriceAdjustmentSchedule WHERE Id = '${soqlEscape(result.scheduleId)}' LIMIT 1`).catch(() => ({ records: [] as { Id: string }[] }));
  const ruleRes = uniqueRuleIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjRule WHERE Id IN (${idList(uniqueRuleIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };
  const conditionRes = uniqueConditionIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeAdjustmentCondition WHERE Id IN (${idList(uniqueConditionIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };
  const adjustmentRes = uniqueAdjustmentIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjustment WHERE Id IN (${idList(uniqueAdjustmentIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };

  return {
    scheduleVerified: scheduleRes.records.length === 1,
    ruleCount: new Set(ruleRes.records.map(r => r.Id)).size, expectedRuleCount: uniqueRuleIds.length,
    conditionCount: new Set(conditionRes.records.map(r => r.Id)).size, expectedConditionCount: uniqueConditionIds.length,
    adjustmentCount: new Set(adjustmentRes.records.map(r => r.Id)).size, expectedAdjustmentCount: uniqueAdjustmentIds.length,
  };
}

export interface AdjustmentConfigVerification {
  attributeLabel: string;
  valueLabel: string;
  adjustmentId: string | null;
  expectedSignature: string;
  actualSignature: string;
  verified: boolean;
  reason?: string;
}

/**
 * §Parts 12/13/19 — replaces "adjustments N/M" (a unique-Id COUNT, which the reported bug proves is
 * not sufficient — 5 different rules sharing one Id would still have satisfied a naive count check)
 * with a genuine PER-RULE verification: for every requested pricing configuration, re-resolve its
 * expected condition signature, read back its actual AttributeBasedAdjustment + Rule + Conditions from
 * Salesforce, reconstruct the ACTUAL signature the same way, and require Product/SellingModel/Schedule
 * AND an exact signature match before marking that one configuration verified. A shared Adjustment Id
 * across multiple configurations is only ever "verified" if EVERY one of those configurations
 * independently reconstructs the exact same real Salesforce condition set — never assumed from a
 * count alone.
 */
export async function verifyAttributeBasedAdjustmentConfigurations(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  contexts: Map<string, AttributeContext>,
  args: { productId: string; sellingModelId: string | null; scheduleId: string },
  plans: AttributeBasedRulePlan[],
  adjustmentIdByRuleId: Map<string, string>,
): Promise<{ entries: AdjustmentConfigVerification[]; allVerified: boolean }> {
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
  const entries: AdjustmentConfigVerification[] = [];

  const adjustmentSelectFields = [...new Set(["Id",
    ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
  ])];

  for (const plan of plans) {
    const { row, ruleId } = plan;
    const adjustmentId = adjustmentIdByRuleId.get(ruleId) ?? plan.existingAdjustmentId ?? null;
    const expected = await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId);
    const expectedSignature = expected.signature;

    if (expected.queryFailed || !expectedSignature) {
      entries.push({
        attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId, expectedSignature, actualSignature: "",
        verified: false, reason: "Could not resolve this rule's own expected condition signature.",
      });
      continue;
    }
    if (!adjustmentId) {
      entries.push({
        attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId: null, expectedSignature, actualSignature: "",
        verified: false, reason: "No AttributeBasedAdjustment Id was recorded for this configuration.",
      });
      continue;
    }

    let rec: (Record<string, unknown> & { Id: string }) | undefined;
    try {
      const res = await client.query<Record<string, unknown> & { Id: string }>(
        `SELECT ${adjustmentSelectFields.join(", ")} FROM AttributeBasedAdjustment WHERE Id = '${soqlEscape(adjustmentId)}' LIMIT 1`,
      );
      rec = res.records[0];
    } catch (err) {
      entries.push({
        attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId, expectedSignature, actualSignature: "",
        verified: false, reason: `Read-back query failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!rec) {
      entries.push({
        attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId, expectedSignature, actualSignature: "",
        verified: false, reason: "AttributeBasedAdjustment record was not found on read-back.",
      });
      continue;
    }

    const problems: string[] = [];
    if (schema.abaProductField.field && rec[schema.abaProductField.field.name] !== args.productId) problems.push("Product does not match");
    if (schema.abaSellingModelField.field) {
      const v = (rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null;
      if (v !== (args.sellingModelId ?? null)) problems.push("Product Selling Model does not match");
    }
    if (schema.abaScheduleField.field && rec[schema.abaScheduleField.field.name] !== args.scheduleId) problems.push("Price Adjustment Schedule does not match");

    const actualRuleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;
    let actualSignature = "";
    if (!actualRuleId) {
      problems.push("Adjustment record has no AttributeBasedAdjRule reference");
    } else {
      const actual = await computeRuleConditionSignature(client, schema, attributeIdentityById, actualRuleId);
      actualSignature = actual.signature;
      if (actual.queryFailed || !actual.signature) problems.push("Could not reconstruct the Adjustment's actual condition signature");
      else if (actual.signature !== expectedSignature) problems.push(`Condition signature mismatch (expected "${expectedSignature}", found "${actual.signature}")`);
    }

    const verified = problems.length === 0;
    entries.push({
      attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId, expectedSignature, actualSignature,
      verified, reason: problems.length > 0 ? problems.join("; ") : undefined,
    });
  }

  return { entries, allVerified: entries.length > 0 && entries.every(e => e.verified) };
}

/**
 * §Root-cause finding (this turn) — this function's lookup key is ONE isolated attribute/value pair
 * (e.g. "Storage = SSD Hard Drive 256GB"). That is NOT how this pipeline's own data is structured to be
 * looked up: every price-impacting attribute is REQUIRED to have a condition on EVERY Rule (Salesforce's
 * own FIELD_INTEGRITY_EXCEPTION — "Associate all price impacting attributes..." — already proved this,
 * confirmed live), which means a value that happens to be one attribute's BASELINE default (e.g. Storage's
 * own default of 256GB) will legitimately appear as a condition on MANY DIFFERENT Rules — the "Storage"
 * rule that varies Storage itself, AND every OTHER rule (Processor/Display/etc.) that keeps Storage at its
 * baseline while varying something else. A single-attribute lookup like this one is therefore
 * MATHEMATICALLY GUARANTEED to be ambiguous whenever it's asked about a baseline value shared across
 * several Rules — that ambiguity reflects a correctly-built dataset, not a broken one. Live evidence: 12
 * rules sharing the Storage=256GB baseline value all matched this lookup, correctly reported as
 * "ambiguous," and correctly refused to guess.
 *
 * This function is kept (its own tests still cover a genuinely useful, narrower question — "does ANY
 * condition/adjustment exist anywhere for this one attribute/value" — and callers relying on that are
 * unaffected), but it must NEVER be used as the pass/fail gate for "is this rule's complete pricing
 * configuration correct." `verifyRuntimeAdjustmentResolution` below (which matches on the COMPLETE
 * condition set a Rule actually represents, the same mechanism `findExistingAttributeBasedAdjustment`
 * already uses at create time) is the correct check for that, and is what `createPipeline.ts` now uses as
 * the gate — see that function's own doc comment for why the complete-set match is the right model.
 *
 * §Live-org fix (runtime evaluation) — the end-to-end lookup Salesforce's OWN AttributeDiscount pricing
 * action performs at runtime, replicated here as a read-only, POST-CREATE verification: given an
 * arbitrary Product + arbitrary selected Attribute/AttributeValue (exactly the shape a real
 * SalesTransactionItemAttribute row carries), dynamically resolve
 *
 *   Product2 -> AttributeAdjustmentCondition (by real identity: ProductAttributeDefinition/
 *   AttributeDefinition + the condition's own typed value field, never by Name) -> its
 *   AttributeBasedAdjRule -> that Rule's AttributeBasedAdjustment (matched against the SAME
 *   Product/ProductSellingModel/PriceAdjustmentSchedule identity the create pipeline itself already
 *   uses) -> AdjustmentType/AdjustmentValue
 *
 * Never uses a prompt-supplied adjustment value as the "expected" answer — the only source of truth is
 * whatever is actually stored in Salesforce right now. Returns `resolved: false` (never throws) when the
 * selected attribute/value genuinely has no matching rule — that is a normal, valid outcome ("no
 * adjustment applies"), not an error. Throws only when a REQUIRED relationship this org's schema is
 * supposed to expose cannot be resolved at all (a genuine configuration problem, never guessed past).
 */
export interface RuntimeAttributeAdjustmentTrace {
  productId: string;
  productSellingModelId: string | null;
  priceAdjustmentScheduleId: string;
  attributeName: string;
  attributeValue: string;
  priceImpactingAttribute: boolean | null;
  ruleId: string | null;
  conditionId: string | null;
  adjustmentId: string | null;
  adjustmentType: string | null;
  adjustmentValue: unknown;
  resolved: boolean;
  reason: string;
}

export async function resolveRuntimeAttributeAdjustment(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  args: { productId: string; sellingModelId: string | null; scheduleId: string; attributeName: string; attributeValue: string },
): Promise<RuntimeAttributeAdjustmentTrace> {
  const base = {
    productId: args.productId, productSellingModelId: args.sellingModelId, priceAdjustmentScheduleId: args.scheduleId,
    attributeName: args.attributeName, attributeValue: args.attributeValue,
  };
  const fail = (reason: string, extra: Partial<RuntimeAttributeAdjustmentTrace> = {}): RuntimeAttributeAdjustmentTrace => {
    client.logDebug("execution-trace", `✕ resolveRuntimeAttributeAdjustment — ${reason}`);
    return {
      ...base, priceImpactingAttribute: null, ruleId: null, conditionId: null, adjustmentId: null,
      adjustmentType: null, adjustmentValue: null, resolved: false, reason, ...extra,
    };
  };

  client.logDebug("execution-trace", [
    "→ Resolving runtime Attribute-Based Adjustment",
    `  Product: ${args.productId}`,
    `  ProductSellingModel: ${args.sellingModelId ?? "(none)"}`,
    `  PriceAdjustmentScheduleId: ${args.scheduleId}`,
    `  Attribute: ${args.attributeName}`,
    `  AttributeValue: ${args.attributeValue}`,
  ].join("\n"));

  const contexts = await resolveAttributeContexts(client, args.productId, [args.attributeName]);
  const ctx = contexts.get(args.attributeName);
  if (!ctx) return fail(`Attribute "${args.attributeName}" could not be resolved for Product ${args.productId} at all.`);
  client.logDebug("execution-trace", `  PriceImpactingAttribute: ${ctx.isPriceImpacting ?? "(unknown)"}`);

  const identity = resolveConditionIdentity(schema, ctx);
  if (!identity) {
    return fail(
      `Attribute "${args.attributeName}" has no resolvable ProductAttributeDefinition/AttributeDefinition identity on this org's AttributeAdjustmentCondition schema.`,
      { priceImpactingAttribute: ctx.isPriceImpacting },
    );
  }

  let assignment: ConditionValueAssignment;
  try {
    assignment = resolveConditionValueAssignment(schema.conditionDescribe, args.attributeName, ctx.dataType, ctx.dataTypeSource, args.attributeValue);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), { priceImpactingAttribute: ctx.isPriceImpacting });
  }

  const conditionSelect = [...new Set([
    "Id", schema.conditionRuleField.field!.name, identity.fieldName, assignment.fieldName,
    ...(schema.conditionProductField.field ? [schema.conditionProductField.field.name] : []),
  ])];
  const conditionWhere = [`${identity.fieldName} = '${soqlEscape(identity.value)}'`, `${assignment.fieldName} = '${soqlEscape(String(assignment.value))}'`];
  if (schema.conditionProductField.field) conditionWhere.push(`${schema.conditionProductField.field.name} = '${soqlEscape(args.productId)}'`);
  const conditionRes = await client.query<Record<string, unknown> & { Id: string }>(
    `SELECT ${conditionSelect.join(", ")} FROM AttributeAdjustmentCondition WHERE ${conditionWhere.join(" AND ")}`,
  ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));

  if (conditionRes.records.length === 0) {
    return fail(
      `No AttributeAdjustmentCondition matches Attribute "${args.attributeName}" = "${args.attributeValue}" for Product ${args.productId} — this selected value has no configured pricing rule; no adjustment applies (this is a valid outcome, not an error).`,
      { priceImpactingAttribute: ctx.isPriceImpacting },
    );
  }
  const conditionCount = conditionRes.records.length;

  const resolvedAdjustments: { ruleId: string; conditionId: string; adjustmentId: string; adjustmentType: string | null; adjustmentValue: unknown }[] = [];
  for (const condRec of conditionRes.records) {
    const ruleId = condRec[schema.conditionRuleField.field!.name] as string | undefined;
    if (!ruleId) continue;

    const abaSelect = [...new Set([
      "Id", ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
      ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
      ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
      ...(schema.abaTypeField ? [schema.abaTypeField.name] : []), ...(schema.abaValueField ? [schema.abaValueField.name] : []),
    ])];
    const abaRes = await client.query<Record<string, unknown> & { Id: string }>(
      `SELECT ${abaSelect.join(", ")} FROM AttributeBasedAdjustment WHERE ${schema.abaRuleField.field!.name} = '${soqlEscape(ruleId)}' LIMIT 5`,
    ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));

    for (const abaRec of abaRes.records) {
      const productMatches = !schema.abaProductField.field || abaRec[schema.abaProductField.field.name] === args.productId;
      const sellingModelMatches = !schema.abaSellingModelField.field || ((abaRec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) === (args.sellingModelId ?? null);
      const scheduleMatches = !schema.abaScheduleField.field || abaRec[schema.abaScheduleField.field.name] === args.scheduleId;
      if (!productMatches || !sellingModelMatches || !scheduleMatches) continue;
      resolvedAdjustments.push({
        ruleId, conditionId: condRec.Id, adjustmentId: abaRec.Id,
        adjustmentType: schema.abaTypeField ? ((abaRec[schema.abaTypeField.name] as string | undefined) ?? null) : null,
        adjustmentValue: schema.abaValueField ? (abaRec[schema.abaValueField.name] ?? null) : null,
      });
    }
  }

  const distinctAdjustmentIds = new Set(resolvedAdjustments.map(r => r.adjustmentId));
  if (distinctAdjustmentIds.size === 0) {
    return fail(
      `Attribute "${args.attributeName}" = "${args.attributeValue}" resolved ${conditionCount} condition(s) for Product ${args.productId}, but none of their Rules has an AttributeBasedAdjustment matching this Product+ProductSellingModel+PriceAdjustmentSchedule ${args.scheduleId} — no adjustment applies at runtime with this schedule.`,
      { priceImpactingAttribute: ctx.isPriceImpacting },
    );
  }
  if (distinctAdjustmentIds.size > 1) {
    return fail(
      `Ambiguous: Attribute "${args.attributeName}" = "${args.attributeValue}" resolves to ${distinctAdjustmentIds.size} DIFFERENT AttributeBasedAdjustment records for Product ${args.productId} + Schedule ${args.scheduleId} — refusing to guess which one Salesforce would apply at runtime. Candidates: ${[...distinctAdjustmentIds].join(", ")}.`,
      { priceImpactingAttribute: ctx.isPriceImpacting },
    );
  }

  const winner = resolvedAdjustments[0];
  client.logDebug("execution-trace", [
    `✓ resolved AttributeBasedAdjRule: ${winner.ruleId}`,
    `✓ resolved AttributeAdjustmentCondition: ${winner.conditionId}`,
    `✓ resolved AttributeBasedAdjustment: ${winner.adjustmentId}`,
    `✓ AdjustmentType: ${winner.adjustmentType ?? "(none)"}`,
    `✓ AdjustmentValue: ${winner.adjustmentValue ?? "(none)"}`,
  ].join("\n"));
  return {
    ...base, priceImpactingAttribute: ctx.isPriceImpacting,
    ruleId: winner.ruleId, conditionId: winner.conditionId, adjustmentId: winner.adjustmentId,
    adjustmentType: winner.adjustmentType, adjustmentValue: winner.adjustmentValue,
    resolved: true, reason: "Exactly one applicable AttributeBasedAdjustment resolved.",
  };
}

/**
 * §Root-cause fix (this turn) — TASK 2/8's answer, evidenced from this app's OWN already-established
 * facts (never a new guess): Salesforce's own validation ("Associate all price impacting attributes with
 * the relevant Attribute Adjustment Condition") REQUIRES every Rule's condition set to be COMPLETE (one
 * condition per price-impacting attribute, not just the one it varies) — the only reason to require that
 * is if Salesforce's own matching key for AttributeBasedAdjustment (already independently confirmed by
 * its "already exists" duplicate-check, which lists Product+SellingModel+conditions+Schedule+dates as ONE
 * identity) is the COMPLETE condition set, not any single attribute in isolation. This is precisely
 * `AttributeBasedAdjustmentIdentity` — the SAME identity `findExistingAttributeBasedAdjustment` already
 * uses to find/reuse an Adjustment during CREATE. Verifying "does this configuration correctly resolve at
 * runtime" is therefore the SAME operation as "does this configuration already have an Adjustment" — this
 * function reuses that exact, already-tested machinery for verification instead of the single-attribute
 * lookup above (which is architecturally guaranteed to be ambiguous whenever a value is shared as another
 * Rule's baseline default — see that function's own doc comment).
 *
 * For each rule this run created/reused/updated: read the Adjustment's OWN current stored identity
 * (Product/SellingModel/Schedule/EffectiveFrom/EffectiveTo — via `readAdjustmentSnapshot`, never
 * `todayISO()` freshly recomputed, since a date-overlap-reconciled Adjustment's real dates may not match
 * today), recompute the Rule's own complete condition signature, then run a FRESH candidate search using
 * that exact identity. `resolved: true` only when that fresh search converges on EXACTLY the same
 * Adjustment Id already recorded for this rule — never a different one (a real cross-wiring problem) and
 * never zero (this rule's own Adjustment should always be independently re-discoverable from its own
 * stored data).
 */
export interface RuntimeConfigurationVerification {
  ruleId: string;
  attributeLabel: string;
  valueLabel: string;
  adjustmentId: string | null;
  resolvedAdjustmentId: string | null;
  candidateCount: number;
  resolved: boolean;
  reason: string;
}

export async function verifyRuntimeAdjustmentResolution(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  contexts: Map<string, AttributeContext>,
  plans: AttributeBasedRulePlan[],
  adjustmentIdByRuleId: Map<string, string>,
): Promise<{ entries: RuntimeConfigurationVerification[]; allResolved: boolean }> {
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
  const entries: RuntimeConfigurationVerification[] = [];

  for (const plan of plans) {
    const { row, ruleId } = plan;
    const adjustmentId = adjustmentIdByRuleId.get(ruleId) ?? plan.existingAdjustmentId ?? null;
    if (!adjustmentId) {
      entries.push({
        ruleId, attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId: null,
        resolvedAdjustmentId: null, candidateCount: 0, resolved: false,
        reason: "No AttributeBasedAdjustment Id was recorded for this configuration.",
      });
      continue;
    }

    const snapshot = await readAdjustmentSnapshot(client, schema, adjustmentId);
    if (!snapshot) {
      entries.push({
        ruleId, attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId,
        resolvedAdjustmentId: null, candidateCount: 0, resolved: false,
        reason: `AttributeBasedAdjustment ${adjustmentId} could not be read back.`,
      });
      continue;
    }
    if (!snapshot.productId || !snapshot.scheduleId || !snapshot.effectiveFrom || !snapshot.effectiveTo) {
      entries.push({
        ruleId, attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId,
        resolvedAdjustmentId: null, candidateCount: 0, resolved: false,
        reason: `AttributeBasedAdjustment ${adjustmentId}'s own stored identity is incomplete on this org's schema (Product/Schedule/EffectiveFrom/EffectiveTo) — cannot re-derive a search identity from it.`,
      });
      continue;
    }

    const signatureResult = await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId);
    if (signatureResult.queryFailed || !signatureResult.signature) {
      entries.push({
        ruleId, attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId,
        resolvedAdjustmentId: null, candidateCount: 0, resolved: false,
        reason: "Could not resolve this rule's own complete condition signature.",
      });
      continue;
    }

    const identity: AttributeBasedAdjustmentIdentity = {
      productId: snapshot.productId, productSellingModelId: snapshot.productSellingModelId,
      priceAdjustmentScheduleId: snapshot.scheduleId, effectiveFrom: snapshot.effectiveFrom, effectiveTo: snapshot.effectiveTo,
      conditionSignature: signatureResult.signature,
    };
    const found = await findExistingAttributeBasedAdjustment(client, schema, attributeIdentityById, identity);
    const resolved = found.id === adjustmentId;
    entries.push({
      ruleId, attributeLabel: row.attributeLabel, valueLabel: row.valueLabel, adjustmentId,
      resolvedAdjustmentId: found.id, candidateCount: found.candidateCount, resolved,
      reason: resolved
        ? "The complete attribute configuration (every price-impacting attribute, not just this one) uniquely resolves to this rule's own Adjustment."
        : found.id
          ? `The complete configuration resolved to a DIFFERENT AttributeBasedAdjustment (${found.id}) than the one recorded for this rule (${adjustmentId}) — a genuine cross-wiring problem, never guessed past.`
          : `The complete configuration did not resolve to any AttributeBasedAdjustment via a fresh search (checked ${found.candidateCount} candidate(s) scoped to this Product+Schedule) — this rule's own Adjustment is not independently re-discoverable from its own stored conditions.`,
    });
  }

  return { entries, allResolved: entries.length > 0 && entries.every(e => e.resolved) };
}

function normalizeAttrName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
