/**
 * Tier-Based (Slab) Pricing — native Salesforce record CRUD: one `PriceAdjustmentSchedule` (Slab
 * AdjustmentMethod, except for the Override-tier fork below) + N `PriceAdjustmentTier` child records (one
 * per UI-defined `VolumeTier` row), which the deployed VolumeTierDiscount canvas step reads at runtime via
 * a Decision Table. Mirrors lib/pricing-rules/volume-based/create/nativeRecords.ts almost verbatim — the
 * ONLY behavioral fork is `resolveAdjustmentMethodValue` below.
 *
 * §AdjustmentMethod ordering — `AdjustmentMethod` becomes IMMUTABLE once any `PriceAdjustmentTier` child
 * exists on some orgs, so it is PATCHed explicitly right after the schedule is created (before any tier
 * exists) even though it is also set on the initial create payload — some orgs silently ignore the field
 * on insert. It is PATCHed again after every tier is created (belt and suspenders — NOT load-bearing; the
 * pre-tier PATCH + its immediate read-back verification is what's actually depended on), then the
 * schedule is activated as a separate, final PATCH.
 */
import { SalesforceError, type SalesforceClient, type DescribeResult, type DescribeField, soqlEscape } from "@/lib/salesforce/client";
import {
  SchemaCache, resolveReferenceField, resolveDefaultPicklistValue, fillRequiredPicklistDefaults,
  extractSalesforceFields, diagnoseCreateRejection, formatCreateRejectionDiagnosis,
  buildSchemaDiagnosis, logSchemaDiagnosis, logObjectCreation,
  type ResolvedLookup,
} from "@/lib/pricing-rules/attribute-based/create/nativeSchemaResolver";
import { verifyRecordExists } from "@/lib/pricing-rules/attribute-based/create/workflowRunner";
import type { ProcedureStepLite, TierType, VolumeTier } from "../types";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Far-future sentinel, not literally "+1 year" — the RCA BKM filter requires
 * PriceAdjustmentTier.EffectiveTo >= simulation.EffectiveTo, and the framework's own computed
 * simulation.EffectiveTo is an EXCLUSIVE end date (start + 1 year + 1 day), so a literal 1-year window
 * falls one day short. A distant date means a newly created schedule/tier never expires. */
function farFutureISO(): string {
  return "2099-12-31";
}

function pickField(describe: DescribeResult, candidates: string[]): DescribeField | null {
  for (const c of candidates) {
    const found = describe.fields.find(f => f.name.toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

async function guardedCreate(
  client: SalesforceClient, objectName: string, describe: DescribeResult,
  payload: Record<string, unknown>, resolvedLookups: ResolvedLookup[], stepName: string,
): Promise<string> {
  fillRequiredPicklistDefaults(describe, payload);
  const { missingFields } = logObjectCreation(client, objectName, { describe, payload, resolvedLookups });
  if (missingFields.length > 0) {
    const diagnosis = buildSchemaDiagnosis(objectName, describe, payload, resolvedLookups);
    logSchemaDiagnosis(client, describe, diagnosis);
    throw new Error(`${objectName} is missing required field(s): ${missingFields.join(", ")}. See server logs for the full schema diagnosis (${stepName}).`);
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
  if (!verified) throw new Error(`${objectName} ${created.id} was reported as created, but querying it back found no matching record — refusing to trust this Id.`);
  client.logDebug("native-create-response", `${objectName} ${created.id} created and verified via read-back.`);
  return created.id;
}

/* ── Product / Selling Model / Currency resolution ── */

export interface ResolvedProductContext {
  productId: string;
  sellingModelId: string | null;
  currencyIsoCode: string | null;
  basePriceListPrice: number | null;
}

export async function resolveProductContext(client: SalesforceClient, productId: string): Promise<ResolvedProductContext> {
  let sellingModelId: string | null = null;
  try {
    const res = await client.query<{ ProductSellingModelId: string }>(
      `SELECT ProductSellingModelId FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(productId)}' LIMIT 1`,
    );
    sellingModelId = res.records[0]?.ProductSellingModelId ?? null;
  } catch { /* non-fatal */ }

  let currencyIsoCode: string | null = null;
  let basePriceListPrice: number | null = null;
  try {
    const res = await client.query<{ UnitPrice?: number; CurrencyIsoCode?: string }>(
      `SELECT UnitPrice, CurrencyIsoCode FROM PricebookEntry WHERE Product2Id = '${soqlEscape(productId)}' AND IsActive = true LIMIT 1`,
    );
    currencyIsoCode = res.records[0]?.CurrencyIsoCode ?? null;
    basePriceListPrice = typeof res.records[0]?.UnitPrice === "number" ? res.records[0].UnitPrice : null;
  } catch {
    try {
      const res = await client.query<{ UnitPrice?: number }>(
        `SELECT UnitPrice FROM PricebookEntry WHERE Product2Id = '${soqlEscape(productId)}' AND IsActive = true LIMIT 1`,
      );
      basePriceListPrice = typeof res.records[0]?.UnitPrice === "number" ? res.records[0].UnitPrice : null;
    } catch { /* non-fatal — diagnostics only, never the authoritative runtime price */ }
  }

  return { productId, sellingModelId, currencyIsoCode, basePriceListPrice };
}

/* ── PriceAdjustmentSchedule ── */

export interface TierSchema {
  scheduleDescribe: DescribeResult;
  tierDescribe: DescribeResult;
  schedProductField: ReturnType<typeof resolveReferenceField>;
  schedSellingModelField: ReturnType<typeof resolveReferenceField>;
  adjMethField: DescribeField | null;
  schedEffFromField: DescribeField | null;
  schedEffToField: DescribeField | null;
  schedCurrField: DescribeField | null;
  schedActiveField: DescribeField | null;
  tierLowerField: DescribeField | null;
  tierUpperField: DescribeField | null;
  tierTypeField: DescribeField | null;
  tierValueField: DescribeField | null;
  tierScheduleField: ReturnType<typeof resolveReferenceField>;
  tierEffFromField: DescribeField | null;
  tierEffToField: DescribeField | null;
  tierProductField: DescribeField | null;
  tierSellingModelField: DescribeField | null;
  tierCurrField: DescribeField | null;
  tierActiveField: DescribeField | null;
}

export async function prepareTierSchema(client: SalesforceClient): Promise<TierSchema> {
  const cache = new SchemaCache(client);
  const scheduleDescribe = await cache.get("PriceAdjustmentSchedule");
  const tierDescribe = await cache.get("PriceAdjustmentTier");

  return {
    scheduleDescribe, tierDescribe,
    schedProductField: resolveReferenceField(scheduleDescribe, "Product2"),
    schedSellingModelField: resolveReferenceField(scheduleDescribe, "ProductSellingModel"),
    adjMethField: pickField(scheduleDescribe, ["AdjustmentMethod"]),
    schedEffFromField: pickField(scheduleDescribe, ["EffectiveFrom", "EffectiveDate", "StartDate"]),
    schedEffToField: pickField(scheduleDescribe, ["EffectiveTo", "EndDate"]),
    schedCurrField: pickField(scheduleDescribe, ["CurrencyIsoCode"]),
    schedActiveField: pickField(scheduleDescribe, ["IsActive"]),
    tierLowerField: pickField(tierDescribe, ["LowerBound", "MinQuantity", "FromQuantity"]),
    tierUpperField: pickField(tierDescribe, ["UpperBound", "MaxQuantity", "ToQuantity"]),
    tierTypeField: pickField(tierDescribe, ["TierType", "AdjustmentType", "Type"]),
    tierValueField: pickField(tierDescribe, ["TierValue", "AdjustmentValue", "Value", "Percent"]),
    tierScheduleField: resolveReferenceField(tierDescribe, "PriceAdjustmentSchedule"),
    tierEffFromField: pickField(tierDescribe, ["EffectiveFrom", "EffectiveDate", "StartDate", "ValidFrom"]),
    tierEffToField: pickField(tierDescribe, ["EffectiveTo", "EndDate", "ValidTo"]),
    tierProductField: pickField(tierDescribe, ["Product2Id", "ProductId"]),
    tierSellingModelField: pickField(tierDescribe, ["ProductSellingModelId", "SellingModelId"]),
    tierCurrField: pickField(tierDescribe, ["CurrencyIsoCode"]),
    tierActiveField: pickField(tierDescribe, ["IsActive"]),
  };
}

/**
 * §The one business rule in this whole module — deliberately DIFFERENT from volume-based's
 * `resolveAdjustmentMethodValue`, which always forces Range regardless of tier type. For tier-based:
 *   - Percentage/Amount tiers -> Slab (each band prices only the units inside it — true Slab semantics).
 *   - Override tiers -> Range-equivalent, even though this is a "tier-based" procedure. When tiers hold
 *     absolute override unit prices, "all units in the matching band get that band's override price"
 *     (Range semantics) is correct; "spread units across every band at each band's override price" (true
 *     Slab semantics) would double-count/misprice an override-priced schedule. Do NOT simplify this to
 *     "tier-based always -> Slab" — that would silently break every Override-tier procedure.
 */
function resolveAdjustmentMethodValue(schema: TierSchema, hasOverrideTiers: boolean): string {
  const rangeWords = ["range", "volume", "threshold", "uniform", "flat"];
  const slabWords = ["slab", "tiered", "tier", "progressive", "incremental", "band"];
  const matchWords = hasOverrideTiers ? rangeWords : slabWords;
  const active = (schema.adjMethField?.picklistValues ?? []).filter(v => v.active);
  return active.find(v => matchWords.some(w => v.value.toLowerCase().includes(w)))?.value
    ?? (schema.adjMethField ? resolveDefaultPicklistValue(schema.adjMethField) : null)
    ?? (hasOverrideTiers ? "Range" : "Slab");
}

export interface CreateScheduleResult { scheduleId: string; resolvedAdjustmentMethod: string; }

export async function createPriceAdjustmentSchedule(
  client: SalesforceClient, schema: TierSchema,
  args: { procedureName: string; product: ResolvedProductContext; hasOverrideTiers: boolean },
  steps: ProcedureStepLite[],
): Promise<CreateScheduleResult> {
  step(steps, "create-schedule", "start", "Creating the Price Adjustment Schedule.");
  const resolvedAdjustmentMethod = resolveAdjustmentMethodValue(schema, args.hasOverrideTiers);

  const payload: Record<string, unknown> = { Name: `${args.procedureName} Schedule`.slice(0, 80), IsActive: false };
  const resolvedLookups: ResolvedLookup[] = [];
  if (schema.adjMethField) payload[schema.adjMethField.name] = resolvedAdjustmentMethod;
  if (schema.schedEffFromField) payload[schema.schedEffFromField.name] = todayISO();
  if (schema.schedEffToField) payload[schema.schedEffToField.name] = farFutureISO();
  if (schema.schedProductField.field) { payload[schema.schedProductField.field.name] = args.product.productId; resolvedLookups.push({ targetObject: "Product2", field: schema.schedProductField.field, value: args.product.productId }); }
  if (schema.schedSellingModelField.field && args.product.sellingModelId) { payload[schema.schedSellingModelField.field.name] = args.product.sellingModelId; resolvedLookups.push({ targetObject: "ProductSellingModel", field: schema.schedSellingModelField.field, value: args.product.sellingModelId }); }
  if (schema.schedCurrField && args.product.currencyIsoCode) payload[schema.schedCurrField.name] = args.product.currencyIsoCode;

  let scheduleId: string;
  try {
    scheduleId = await guardedCreate(client, "PriceAdjustmentSchedule", schema.scheduleDescribe, payload, resolvedLookups, "create-schedule");
  } catch (err) {
    // Retry once with only the required subset — keep the product linkage even in the retry (dropping it
    // breaks runtime discovery).
    step(steps, "create-schedule", "info", `→ First create attempt failed (${err instanceof Error ? err.message : String(err)}) — retrying with the minimal required field subset.`);
    const minimalPayload: Record<string, unknown> = { Name: payload.Name, IsActive: false };
    if (schema.adjMethField) minimalPayload[schema.adjMethField.name] = resolvedAdjustmentMethod;
    if (schema.schedProductField.field) minimalPayload[schema.schedProductField.field.name] = args.product.productId;
    if (schema.schedSellingModelField.field && args.product.sellingModelId) minimalPayload[schema.schedSellingModelField.field.name] = args.product.sellingModelId;
    scheduleId = await guardedCreate(client, "PriceAdjustmentSchedule", schema.scheduleDescribe, minimalPayload, resolvedLookups, "create-schedule");
  }
  step(steps, "create-schedule", "success", `Created PriceAdjustmentSchedule ${scheduleId} (AdjustmentMethod=${resolvedAdjustmentMethod}).`);
  return { scheduleId, resolvedAdjustmentMethod };
}

export interface AdjustmentMethodPatchResult { attempted: boolean; verifiedValue: string | null; matches: boolean; }

/** PATCHes AdjustmentMethod directly, then re-queries it back — some orgs silently ignore the field on
 * insert, so this is called once BEFORE any tier exists (the phase this pipeline actually depends on —
 * its read-back verification below is what create-tiers' preflight checks) and again AFTER every tier is
 * created (defense-in-depth only; a mismatch there is never treated as more authoritative than the
 * pre-tier result). Once any tier exists, AdjustmentMethod can become immutable on some orgs — a verified
 * mismatch is logged as a CRITICAL warning (never fatal — the schedule and tiers are still real, usable
 * records). */
export async function patchAdjustmentMethod(
  client: SalesforceClient, schema: TierSchema, scheduleId: string, resolvedAdjustmentMethod: string,
  steps: ProcedureStepLite[], warnings: string[], phase: "pre-tier" | "post-tier",
): Promise<AdjustmentMethodPatchResult> {
  if (!schema.adjMethField) return { attempted: false, verifiedValue: null, matches: true };
  try {
    await client.updateRecord("PriceAdjustmentSchedule", scheduleId, { [schema.adjMethField.name]: resolvedAdjustmentMethod });
  } catch (err) {
    warnings.push(`AdjustmentMethod PATCH (${phase}) failed: ${err instanceof Error ? err.message : String(err)}.`);
    return { attempted: true, verifiedValue: null, matches: false };
  }
  let verifiedValue: string | null = null;
  try {
    const res = await client.query<Record<string, unknown>>(`SELECT ${schema.adjMethField.name} FROM PriceAdjustmentSchedule WHERE Id = '${soqlEscape(scheduleId)}' LIMIT 1`);
    verifiedValue = (res.records[0]?.[schema.adjMethField.name] as string | undefined) ?? null;
  } catch { /* non-fatal — verification failure is reported below */ }
  const matches = verifiedValue === resolvedAdjustmentMethod;
  if (!matches) {
    const message = `${phase === "pre-tier" ? "CRITICAL" : "info"}: PriceAdjustmentSchedule ${scheduleId}'s AdjustmentMethod is "${verifiedValue}" after the ${phase} PATCH, expected "${resolvedAdjustmentMethod}". ` +
      `This field can become immutable once a PriceAdjustmentTier exists on some orgs — fix it manually in Setup if this persists.`;
    if (phase === "pre-tier") warnings.push(message);
    step(steps, "create-schedule", phase === "pre-tier" ? "error" : "info", message);
  } else {
    step(steps, "create-schedule", "success", `✓ AdjustmentMethod verified as "${verifiedValue}" (${phase}).`);
  }
  return { attempted: true, verifiedValue, matches };
}

/* ── PriceAdjustmentTier ── */

/** Maps a UI TierType to whatever this org's real PriceAdjustmentTier.TierType picklist actually exposes
 * — never hardcoded, since Salesforce releases have used different API values over time (Winter '25+:
 * AdjustmentPercentage/AdjustmentAmount/OverrideAmount; pre-Winter '25: Percent/Discount/OverridePrice). */
export function resolveTierType(requested: TierType | string, validValues: string[]): string {
  if (!validValues.length || validValues.includes(requested)) return requested;
  const fallbacks: Record<string, string[]> = {
    Override: ["OverrideAmount", "OverridePrice", "Price", "Amount", "Discount"],
    Percentage: ["AdjustmentPercentage", "Percent", "PercentDiscount"],
    Amount: ["AdjustmentAmount", "Discount", "FixedAmount", "Price"],
  };
  for (const alt of (fallbacks[requested] ?? [])) {
    if (validValues.includes(alt)) return alt;
  }
  return validValues[0] ?? requested;
}

export interface CreateTiersResult { tierIds: string[]; }

export async function createPriceAdjustmentTiers(
  client: SalesforceClient, schema: TierSchema,
  args: { scheduleId: string; tiers: VolumeTier[]; product: ResolvedProductContext; effectiveFrom: string; effectiveTo: string },
  steps: ProcedureStepLite[],
): Promise<CreateTiersResult> {
  step(steps, "create-tiers", "start", `Creating ${args.tiers.length} Price Adjustment Tier record(s).`);
  const validTierTypes = (schema.tierTypeField?.picklistValues ?? []).filter(v => v.active).map(v => v.value);
  const tierIds: string[] = [];

  for (const tier of args.tiers) {
    const resolvedTierType = resolveTierType(tier.tierType, validTierTypes);
    const payload: Record<string, unknown> = {};
    if (schema.tierScheduleField.field) payload[schema.tierScheduleField.field.name] = args.scheduleId;
    if (schema.tierLowerField) payload[schema.tierLowerField.name] = tier.lowerBound;
    if (schema.tierTypeField) payload[schema.tierTypeField.name] = resolvedTierType;
    if (schema.tierValueField) payload[schema.tierValueField.name] = tier.tierValue;
    // Explicit high sentinel for the open-ended last tier — a null UpperBound is not reliably matched by
    // the VolumeTierDiscount BKM filter on every Salesforce RCA version.
    if (schema.tierUpperField) payload[schema.tierUpperField.name] = tier.upperBound !== null && tier.upperBound !== undefined ? tier.upperBound : 999999999;
    if (schema.tierEffFromField) payload[schema.tierEffFromField.name] = args.effectiveFrom;
    if (schema.tierEffToField) payload[schema.tierEffToField.name] = args.effectiveTo;
    if (schema.tierProductField) payload[schema.tierProductField.name] = args.product.productId;
    if (schema.tierSellingModelField && args.product.sellingModelId) payload[schema.tierSellingModelField.name] = args.product.sellingModelId;
    if (schema.tierCurrField && args.product.currencyIsoCode) payload[schema.tierCurrField.name] = args.product.currencyIsoCode;
    if (schema.tierActiveField) payload[schema.tierActiveField.name] = true;

    const resolvedLookups: ResolvedLookup[] = schema.tierScheduleField.field
      ? [{ targetObject: "PriceAdjustmentSchedule", field: schema.tierScheduleField.field, value: args.scheduleId }]
      : [];
    const tierId = await guardedCreate(client, "PriceAdjustmentTier", schema.tierDescribe, payload, resolvedLookups, "create-tiers");
    tierIds.push(tierId);
    step(steps, "create-tiers", "success", `Tier [${tier.lowerBound}–${tier.upperBound ?? "∞"}] -> ${tier.tierType} ${tier.tierValue}: ${tierId}.`);
  }

  step(steps, "create-tiers", "success", `${tierIds.length} PriceAdjustmentTier record(s) created.`);
  return { tierIds };
}

/** Non-fatal post-create read-back — flags any tier row whose Product2Id/ProductSellingModelId/
 * EffectiveFrom/EffectiveTo came back null. */
export async function validateCreatedTierFields(client: SalesforceClient, scheduleId: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT Id, Product2Id, ProductSellingModelId, EffectiveFrom, EffectiveTo FROM PriceAdjustmentTier WHERE PriceAdjustmentScheduleId = '${soqlEscape(scheduleId)}' LIMIT 50`,
    );
    for (const rec of res.records) {
      const nulls = ["Product2Id", "ProductSellingModelId", "EffectiveFrom", "EffectiveTo"].filter(f => rec[f] === null || rec[f] === undefined);
      if (nulls.length > 0) warnings.push(`PriceAdjustmentTier ${rec.Id} has null field(s): ${nulls.join(", ")}.`);
    }
  } catch {
    // Fields may not exist on this org's PriceAdjustmentTier at all — non-fatal, this check is diagnostic-only.
  }
  return warnings;
}

export async function activateSchedule(client: SalesforceClient, schema: TierSchema, scheduleId: string, steps: ProcedureStepLite[], warnings: string[]): Promise<boolean> {
  if (!schema.schedActiveField) {
    warnings.push("PriceAdjustmentSchedule has no IsActive field on this org — the schedule could not be activated programmatically.");
    return false;
  }
  try {
    await client.updateRecord("PriceAdjustmentSchedule", scheduleId, { [schema.schedActiveField.name]: true });
    const res = await client.query<Record<string, unknown>>(`SELECT ${schema.schedActiveField.name} FROM PriceAdjustmentSchedule WHERE Id = '${soqlEscape(scheduleId)}' LIMIT 1`);
    const activeNow = res.records[0]?.[schema.schedActiveField.name] === true;
    if (!activeNow) warnings.push(`PriceAdjustmentSchedule ${scheduleId} activation PATCH succeeded but read-back did not confirm IsActive=true.`);
    step(steps, "activate-schedule", activeNow ? "success" : "error", activeNow ? `✓ Schedule ${scheduleId} activated.` : `Activation PATCH succeeded but read-back did not confirm.`);
    return activeNow;
  } catch (err) {
    warnings.push(`Schedule activation failed: ${err instanceof Error ? err.message : String(err)}.`);
    step(steps, "activate-schedule", "error", `Activation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
