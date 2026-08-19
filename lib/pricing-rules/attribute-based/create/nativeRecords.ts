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
import { resolveAttributePicklistId, createMissingAttributeValue } from "./valueCreation";
import { resolveProductClassificationInheritance } from "../productClassificationInheritance";
import type { PricingRulePlanRow, ProcedureStepLite } from "../types";
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

/** `${attributeName}_${value}_Rule`, sanitized to `[a-zA-Z0-9_]`, collapsed, truncated to 80 chars — the deterministic reuse/dedupe key. */
function sanitizeRuleName(attributeName: string, value: string): string {
  const raw = `${attributeName}_${value}_Rule`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80);
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
): Promise<string[]> {
  const padDescribe = await new SchemaCache(client).get("ProductAttributeDefinition");
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
): Promise<{ fields: ProductAttributeDefinitionOverrideFields; missing: [] } | { fields: null; missing: string[] }> {
  const padDescribe = await new SchemaCache(client).get("ProductAttributeDefinition");
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
): Promise<Map<string, AttributeContext>> {
  const uniqueNames = [...new Set(requestedAttributeNames)];
  step(steps, "configure-price-impacting", "start", `Verifying ${uniqueNames.length} requested pricing attribute(s) are marked price-impacting for this product.`);

  const contexts = await resolveAttributeContexts(client, productId, uniqueNames);
  const padDescribe = await client.describeObject("ProductAttributeDefinition");
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
    const overrideFields = await resolveProductAttributeDefinitionOverrideFields(client);
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
): Promise<{ compatibleId: string | null; existingNames: Set<string> }> {
  const selectFields = ["Id", "Name", ...new Set(compareFields)];
  const soql = productFieldName
    ? `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule WHERE ${productFieldName} = '${soqlEscape(productId)}'`
    : `SELECT ${selectFields.join(", ")} FROM PriceAdjustmentSchedule LIMIT 200`;
  client.logDebug("native-create-request", `Decision Table discovery — querying every existing PriceAdjustmentSchedule ${productFieldName ? `for Product ${productId}` : "(no Product2 lookup discovered on this org's schema — querying broadly instead)"} (never a guessed name filter): ${soql}`);

  let records: (Record<string, unknown> & { Id: string; Name: string })[] = [];
  try {
    records = (await client.query<Record<string, unknown> & { Id: string; Name: string }>(soql)).records;
  } catch (err) {
    client.logDebug("native-create-request", `Decision Table discovery query failed (falling back to "no compatible table found"): ${err instanceof Error ? err.message : String(err)}`);
    return { compatibleId: null, existingNames: new Set() };
  }

  client.logDebug("native-create-request", [
    `Decision Table discovery — ${records.length} existing record(s) found for Product ${productId}.`,
    "Payload about to be created:",
    JSON.stringify(proposedPayload, null, 2),
  ].join("\n"));

  let compatibleId: string | null = null;
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
    client.logDebug("native-create-request", [`Decision Table compatibility check — record ${rec.Id} ("${rec.Name}"):`, ...rows].join("\n"));
    if (allMatch && !compatibleId) compatibleId = rec.Id;
  }

  if (compatibleId) {
    client.logDebug("native-create-request", `Decision Table compatibility check — record ${compatibleId} matches on every comparable field and will be reused.`);
  } else if (records.length > 0) {
    client.logDebug("native-create-request", `Decision Table compatibility check — none of ${records.length} existing record(s) are structurally compatible; a new one will be created with a verified-unique name.`);
  }

  return { compatibleId, existingNames: new Set(records.map(r => r.Name)) };
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

  const scheduleCompareFields = [productField.field?.name, sellingModelField.field?.name, scheduleTypeField?.name, adjustmentMethodField?.name]
    .filter((n): n is string => !!n);
  const { compatibleId, existingNames } = await findCompatiblePriceAdjustmentSchedule(
    client, args.product.id, productField.field?.name ?? null, payload, scheduleCompareFields,
  );

  let scheduleId: string;
  if (compatibleId) {
    scheduleId = compatibleId;
    step(steps, "create-schedule", "success", `Reusing existing, structurally compatible PriceAdjustmentSchedule (${scheduleId}).`);
    onProgress?.(`✓ Reusing existing PriceAdjustmentSchedule (${scheduleId}).`);
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
  const ruleIds: string[] = [];
  const plans: AttributeBasedRulePlan[] = [];
  // §Part 11 fix — every resolved ruleId is now tracked (previously a rule that already existed by
  // name but had no Adjustment yet — the exact shape of a partially-completed prior run — was never
  // pushed into `ruleIds` at all, which is why "22 requested" reported as only "4 confirmed": only
  // brand-new rules and fully-reused ones (with an Adjustment already) were counted.
  let newlyCreated = 0;
  let reusedWithAdjustment = 0;
  let reusedWithoutAdjustment = 0;

  for (const row of args.rules) {
    const ctx = contexts.get(row.attributeName);
    if (!ctx) throw new Error(`Could not re-resolve attribute "${row.attributeName}" in Salesforce during rule creation.`);
    if (ctx.isPriceImpacting === false) {
      throw new Error(`Attribute "${row.attributeName}" is not marked price-impacting on this product — Salesforce will reject any pricing rule for it. Mark it price-impacting in Setup and try again.`);
    }

    const ruleName = sanitizeRuleName(row.attributeName, row.value);
    let ruleId: string;
    let reusedExisting = false;
    let existingAdjustmentId: string | undefined;
    let ruleProductId: string | null = null;

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
      // §Root-cause fix (Follow-on 43) — an AttributeBasedAdjustment already attached to this Rule was
      // previously trusted blindly, with NO verification that its OWN Product/Schedule actually match
      // THIS run's — the exact gap that let a stale Adjustment from an org state predating this run's
      // resolved PriceAdjustmentSchedule get silently "reused" (surfacing later, too late to fix, as
      // verifyAttributeBasedAdjustmentConfigurations's "Price Adjustment Schedule does not match").
      // Never deletes/overwrites the stale record (per "do not trust existing bad data, but do not
      // destroy it either") — a mismatch simply means treat this Rule as if it has NO Adjustment yet,
      // so the pipeline builds a genuinely correct one instead of skipping straight past it.
      const abaSelect = ["Id",
        ...(schema.abaProductField.field ? [schema.abaProductField.field.name] : []),
        ...(schema.abaScheduleField.field ? [schema.abaScheduleField.field.name] : []),
        ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
        ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
        ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
      ];
      const existingAba = await client.query<Record<string, unknown> & { Id: string }>(
        `SELECT ${[...new Set(abaSelect)].join(", ")} FROM AttributeBasedAdjustment WHERE ${schema.abaRuleField.field!.name} = '${soqlEscape(ruleId)}' LIMIT 1`,
      ).catch(() => ({ records: [] as (Record<string, unknown> & { Id: string })[] }));
      const existingAdjustmentRecord = existingAba.records[0];
      const productMatches = !schema.abaProductField.field || existingAdjustmentRecord?.[schema.abaProductField.field.name] === args.product.id;
      const scheduleMatches = !schema.abaScheduleField.field || existingAdjustmentRecord?.[schema.abaScheduleField.field.name] === scheduleId;
      // §Section 8/9 of this turn's fix — Salesforce's own uniqueness key (confirmed via its own
      // FIELD_INTEGRITY_EXCEPTION text) also includes Product Selling Model and Effective From/To; a
      // Rule's already-attached Adjustment is only trustworthy here if ALL of these agree with this
      // run's resolved values, not just Product+Schedule.
      const sellingModelMatches = !schema.abaSellingModelField.field
        || ((existingAdjustmentRecord?.[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) === (args.sellingModelId ?? null);
      const effFromMatches = !schema.abaEffFromField || normalizeDateValue(existingAdjustmentRecord?.[schema.abaEffFromField.name]) === normalizeDateValue(effectiveFrom);
      const effToMatches = !schema.abaEffToField || normalizeDateValue(existingAdjustmentRecord?.[schema.abaEffToField.name]) === normalizeDateValue(effectiveTo);
      if (existingAdjustmentRecord && productMatches && scheduleMatches && sellingModelMatches && effFromMatches && effToMatches) {
        reusedExisting = true;
        existingAdjustmentId = existingAdjustmentRecord.Id;
        reusedWithAdjustment++;
        onProgress?.(`✓ Reused existing AttributeBasedAdjRule "${ruleName}" (already has a verified Adjustment for this exact Product+SellingModel+Schedule+EffectiveFrom/To).`);
      } else if (existingAdjustmentRecord) {
        client.logDebug(
          "execution-trace",
          `Rule "${ruleName}" (${ruleId}) already has an AttributeBasedAdjustment (${existingAdjustmentRecord.Id}), but it does NOT match this run's identity ` +
          `(Product match=${productMatches}, Schedule match=${scheduleMatches}, SellingModel match=${sellingModelMatches}, EffectiveFrom match=${effFromMatches}, EffectiveTo match=${effToMatches}` +
          `${schema.abaScheduleField.field ? `; existing Schedule=${existingAdjustmentRecord[schema.abaScheduleField.field.name] ?? "(none)"}, requested Schedule=${scheduleId}` : ""}) — ` +
          `treating as if no Adjustment exists yet; a fresh, correct one will be built. The stale record is left untouched, never deleted or overwritten.`,
        );
        reusedWithoutAdjustment++;
        onProgress?.(`Found existing AttributeBasedAdjRule "${ruleName}" with a stale/mismatched Adjustment — will build a correct Condition/Adjustment instead of reusing it.`);
      } else {
        reusedWithoutAdjustment++;
        onProgress?.(`Found existing AttributeBasedAdjRule "${ruleName}" without an Adjustment yet — will create its Condition/Adjustment.`);
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
function buildAttributeIdentityReverseMap(contexts: Map<string, AttributeContext>): Map<string, string> {
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
      if (v !== null && v !== undefined && v !== "") { valueToken = String(v).toLowerCase(); break; }
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

async function findExistingAttributeBasedAdjustment(
  client: SalesforceClient,
  schema: AttributeBasedPricingSchema,
  attributeIdentityById: Map<string, string>,
  requested: AttributeBasedAdjustmentIdentity,
): Promise<{ id: string | null; candidateCount: number }> {
  // Broad candidate scan by Product + Schedule ONLY (never Rule-scoped) — Salesforce's own uniqueness
  // key has no Rule component, so filtering candidates by Rule would (and did) miss a legitimate match
  // attached to a DIFFERENT Rule whose complete condition set happens to be identical.
  const selectFields = ["Id",
    ...(schema.abaSellingModelField.field ? [schema.abaSellingModelField.field.name] : []),
    ...(schema.abaRuleField.field ? [schema.abaRuleField.field.name] : []),
    ...(schema.abaEffFromField ? [schema.abaEffFromField.name] : []),
    ...(schema.abaEffToField ? [schema.abaEffToField.name] : []),
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
    return { id: null, candidateCount: 0 };
  }

  let chosen: string | null = null;
  for (const rec of candidateRecords) {
    const candidateSellingModel = schema.abaSellingModelField.field ? ((rec[schema.abaSellingModelField.field.name] as string | null | undefined) ?? null) : null;
    const candidateEffFrom = schema.abaEffFromField ? rec[schema.abaEffFromField.name] : undefined;
    const candidateEffTo = schema.abaEffToField ? rec[schema.abaEffToField.name] : undefined;
    const candidateRuleId = schema.abaRuleField.field ? (rec[schema.abaRuleField.field.name] as string | undefined) : undefined;

    // Cheap field comparisons first (no extra query) — only candidates that pass ALL of these are worth
    // the cost of resolving their Rule's actual condition signature.
    const cheapMismatches: string[] = [];
    if ((requested.productSellingModelId ?? null) !== candidateSellingModel) cheapMismatches.push(`ProductSellingModel: requested=${requested.productSellingModelId ?? "(none)"} vs candidate=${candidateSellingModel ?? "(none)"}`);
    if (schema.abaEffFromField && normalizeDateValue(requested.effectiveFrom) !== normalizeDateValue(candidateEffFrom)) cheapMismatches.push(`EffectiveFrom: requested=${normalizeDateValue(requested.effectiveFrom)} vs candidate=${normalizeDateValue(candidateEffFrom)}`);
    if (schema.abaEffToField && normalizeDateValue(requested.effectiveTo) !== normalizeDateValue(candidateEffTo)) cheapMismatches.push(`EffectiveTo: requested=${normalizeDateValue(requested.effectiveTo)} vs candidate=${normalizeDateValue(candidateEffTo)}`);
    if (!candidateRuleId) cheapMismatches.push("no AttributeBasedAdjRule reference — cannot resolve its condition signature");

    if (cheapMismatches.length > 0) {
      client.logDebug("execution-trace", `AttributeBasedAdjustment preflight — CANDIDATE ${rec.Id} ruled out without a condition-signature query: ${cheapMismatches.join("; ")}.`);
      continue;
    }

    const candidateSignatureResult = await computeRuleConditionSignature(client, schema, attributeIdentityById, candidateRuleId!);
    // §Live-org fix (Monitor, Product-consistency) — a candidate whose OWN conditions belong to more than
    // one product is never trustworthy, regardless of whether its (now product-prefixed) signature string
    // happens to equal the requested one — treated identically to `queryFailed`, never matched.
    const isExactMatch = !candidateSignatureResult.queryFailed && candidateSignatureResult.distinctConditionProductIds.length <= 1
      && !!candidateSignatureResult.signature && candidateSignatureResult.signature === requested.conditionSignature;

    client.logDebug("execution-trace", [
      `AttributeBasedAdjustment preflight — CANDIDATE ${rec.Id} (Rule ${candidateRuleId})`,
      `Condition signature: ${candidateSignatureResult.queryFailed ? "(query FAILED)" : candidateSignatureResult.signature || "(empty)"}`,
      candidateSignatureResult.distinctConditionProductIds.length > 1
        ? `✕ Product-inconsistent: this candidate's Rule has conditions across ${candidateSignatureResult.distinctConditionProductIds.length} different products (${candidateSignatureResult.distinctConditionProductIds.map(p => p ?? "(none)").join(", ")}) — never matched.`
        : "",
      `MATCH: ${isExactMatch}`,
      isExactMatch ? "" : `Requested signature: "${requested.conditionSignature}"`,
    ].filter(Boolean).join("\n"));

    if (isExactMatch) { chosen = rec.Id; break; }
  }

  client.logDebug("execution-trace", chosen
    ? `AttributeBasedAdjustment preflight — exact identity match found: ${chosen}.`
    : `AttributeBasedAdjustment preflight — no existing AttributeBasedAdjustment exactly matches this requested identity (checked ${candidateRecords.length} candidate(s)); will create.`);
  return { id: chosen, candidateCount: candidateRecords.length };
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
  decision: "CREATE" | "REUSE";
  adjustmentId: string;
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
): Promise<{ adjustmentIds: string[]; reusedAdjustmentIds: string[]; decisions: AdjustmentDecision[] }> {
  step(steps, "create-adjustment", "start", "Creating (or reusing) Attribute-Based Adjustments.");
  const adjustmentIds: string[] = [];
  const reusedAdjustmentIds: string[] = [];
  const decisions: AdjustmentDecision[] = [];
  const attributeIdentityById = buildAttributeIdentityReverseMap(contexts);
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
  const identityCache = new Map<string, string>();

  function resolveAdjustmentTypeValue(field: DescribeField, kind: "fixed" | "percentage" | "override"): string | null {
    const active = (field.picklistValues ?? []).filter(v => v.active);
    const keyword = kind === "fixed" ? /fixed|amount/i : kind === "percentage" ? /percent/i : /override/i;
    return active.find(v => keyword.test(v.value) || keyword.test(v.label))?.value ?? active[0]?.value ?? null;
  }

  for (const plan of plans) {
    if (plan.reusedExisting) {
      // §Part 6/11 — this rule's Adjustment was already found (with its Id captured) while resolving
      // the Rule itself; account for it here too so the final adjustment count reflects ALL 22
      // requested rules, not just the ones this run's Adjustment phase actually attempted.
      if (plan.existingAdjustmentId) reusedAdjustmentIds.push(plan.existingAdjustmentId);
      continue;
    }
    const { row, ruleId, conditionIds: thisRuleConditionIds } = plan;

    const requestedResult = await computeRuleConditionSignature(client, schema, attributeIdentityById, ruleId);
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

    let existingId = identityCache.get(cacheKey) ?? null;
    let candidateCount = 0;
    const viaCache = !!existingId;
    if (!existingId) {
      const found = await findExistingAttributeBasedAdjustment(client, schema, attributeIdentityById, requested);
      existingId = found.id;
      candidateCount = found.candidateCount;
    }

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
      `Decision: ${existingId ? "REUSE" : "CREATE"}`,
    ].filter(line => line !== "").join("\n"));

    if (existingId) {
      if (!viaCache) identityCache.set(cacheKey, existingId);
      reusedAdjustmentIds.push(existingId);
      decisions.push({
        step: "attribute-based-adjustment", ruleId, requestedConfiguration, conditionSignature: requestedResult.signature,
        candidateAdjustmentId: existingId, candidateCount, conditionMatch: true, decision: "REUSE", adjustmentId: existingId,
      });
      onProgress?.(`✓ Reusing existing AttributeBasedAdjustment for ${row.attributeLabel} = ${row.valueLabel} (${existingId}).`);
      step(steps, "create-adjustment", "info", `✓ Existing Attribute-Based Adjustment found for ${row.attributeLabel} = ${row.valueLabel} — reusing ${existingId}.`);
      continue;
    }

    step(steps, "create-adjustment", "info", `No matching Attribute-Based Adjustment found for ${row.attributeLabel} = ${row.valueLabel} — creating a new one.`);
    const abaTypeValue = schema.abaTypeField ? resolveAdjustmentTypeValue(schema.abaTypeField, row.adjustmentType) : null;
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
    try {
      adjustmentId = await guardedCreate(client, "AttributeBasedAdjustment", schema.abaDescribe, payload, lookups, "create-adjustment");
      client.logDebug("execution-trace", [
        `✓ Salesforce accepted AttributeBasedAdjustment`,
        `  ID = ${adjustmentId}`,
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
        `AttributeBasedAdjustment create for Rule ${ruleId} (${row.attributeLabel} = ${row.valueLabel}) was rejected by Salesforce as a duplicate ` +
        `(${err instanceof Error ? err.message : String(err)}) — re-querying for the exact existing match instead of failing immediately.`,
      );
      const reconciled = await findExistingAttributeBasedAdjustment(client, schema, attributeIdentityById, requested);
      if (!reconciled.id) {
        throw new Error(
          `Salesforce rejected AttributeBasedAdjustment creation for ${row.attributeLabel} = ${row.valueLabel} as a duplicate of an already-existing record, ` +
          `but a re-query for the exact requested identity (${formatAdjustmentIdentityForLog(requested)}) found no exact match. This is a genuine configuration ` +
          `conflict, not a safe reuse case — refusing to guess. Original Salesforce error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      client.logDebug("execution-trace", `AttributeBasedAdjustment duplicate-error reconciliation — exact match found: ${reconciled.id}. Reusing it instead of creating a duplicate.`);
      adjustmentId = reconciled.id;
      candidateCount = reconciled.candidateCount;
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

    identityCache.set(cacheKey, adjustmentId);
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
    `Distinct AttributeBasedAdjustment records in play: ${distinctAdjustmentRecords} (may legitimately be FEWER than ${plans.length} rules — see below)`,
    `Unique condition signatures this run attempted: ${uniqueSignatures} of ${decisions.length}`,
    sharedSignatures.length > 0
      ? `${sharedSignatures.length} condition signature(s) are shared by more than one rule (expected whenever a rule's varying attribute sits at that attribute's own baseline value): ${sharedSignatures.map(([sig, n]) => `"${sig}" (${n}x)`).join(", ")} — Salesforce's own uniqueness constraint requires these to share exactly ONE AttributeBasedAdjustment (matched on Product+SellingModel+conditions+Schedule+EffectiveFrom/To).`
      : "No condition signatures shared across rules this run.",
  ].join("\n"));
  step(steps, "create-adjustment", "success", `${adjustmentIds.length} adjustment(s) created, ${reusedAdjustmentIds.length} reused.`);
  return { adjustmentIds, reusedAdjustmentIds, decisions };
}

/** §Verify Adjustment Records (Part 9 step 9) — a dedicated read-back re-query of every Id this run
 * just created/reused, run immediately after creation and before anything downstream depends on them. */
export async function verifyAdjustmentRecordsReadBack(
  client: SalesforceClient,
  result: NativeCreationResult,
): Promise<{ scheduleVerified: boolean; ruleCount: number; conditionCount: number; adjustmentCount: number }> {
  const idList = (ids: string[]) => ids.map(id => `'${soqlEscape(id)}'`).join(",");

  const scheduleRes = await client.query<{ Id: string }>(`SELECT Id FROM PriceAdjustmentSchedule WHERE Id = '${soqlEscape(result.scheduleId)}' LIMIT 1`).catch(() => ({ records: [] as { Id: string }[] }));
  const ruleRes = result.ruleIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjRule WHERE Id IN (${idList(result.ruleIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };
  const conditionRes = result.conditionIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeAdjustmentCondition WHERE Id IN (${idList(result.conditionIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };
  const adjustmentRes = result.adjustmentIds.length
    ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjustment WHERE Id IN (${idList(result.adjustmentIds)})`).catch(() => ({ records: [] as { Id: string }[] }))
    : { records: [] as { Id: string }[] };

  return {
    scheduleVerified: scheduleRes.records.length === 1,
    ruleCount: ruleRes.records.length,
    conditionCount: conditionRes.records.length,
    adjustmentCount: adjustmentRes.records.length,
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

function normalizeAttrName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
