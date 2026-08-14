/**
 * §AutoCreate reuse-detection — for the fully-automated pipeline
 * (/api/pricing-rules/ai/auto-create), decides whether real attribute
 * pricing already exists for a product BEFORE requiring the prompt to
 * state any dollar amounts. If a PriceAdjustmentSchedule already exists
 * for this product AND has at least one real AttributeBasedAdjRule under
 * it, that existing data is the Lookup/Decision Table the automation
 * reuses — no new native records are created, and no adjustment amount
 * ever needs to be invented. Every field lookup here is resolved from the
 * object's own Describe, mirroring nativeAttributeRecords.ts's convention,
 * since which lookup field actually exists on PriceAdjustmentSchedule/
 * AttributeBasedAdjRule varies by org.
 */
import type { SalesforceClient } from "@/lib/salesforce/client";
import { findAllReferenceFieldsToTarget } from "@/lib/salesforce/describe";
import type { AttributeDefinition } from "@/lib/pricing-rules/types";

export interface ExistingScheduleForProduct {
  scheduleId: string;
  ruleCount: number;
}

/** Null when this org's PriceAdjustmentSchedule schema has no Product2 lookup at all (can't detect reuse), or when no schedule with at least one rule exists for this product yet. */
export async function findExistingScheduleForProduct(
  client: SalesforceClient,
  productId: string,
): Promise<ExistingScheduleForProduct | null> {
  const [pasDescribe, ruleDescribe] = await Promise.all([
    client.describeObject("PriceAdjustmentSchedule"),
    client.describeObject("AttributeBasedAdjRule"),
  ]);

  const pasProduct2Field = findAllReferenceFieldsToTarget(pasDescribe, "Product2")[0] ?? null;
  if (!pasProduct2Field) return null;

  const scheduleRes = await client.query<{ Id: string }>(
    `SELECT Id FROM PriceAdjustmentSchedule WHERE ${pasProduct2Field.name} = '${productId}' ORDER BY CreatedDate DESC LIMIT 1`,
  );
  const scheduleId = scheduleRes.records[0]?.Id;
  if (!scheduleId) return null;

  const ruleScheduleField =
    findAllReferenceFieldsToTarget(ruleDescribe, "PriceAdjustmentSchedule")[0] ??
    ruleDescribe.fields.find(f => f.type === "reference" && /schedule/i.test(f.name)) ??
    null;
  if (!ruleScheduleField) return { scheduleId, ruleCount: 0 };

  const ruleRes = await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjRule WHERE ${ruleScheduleField.name} = '${scheduleId}'`);
  return { scheduleId, ruleCount: ruleRes.records.length };
}

export interface SampleVerificationEntry {
  attributeName: string;
  attributeValue: string;
}

/**
 * Best-effort only — Runtime Verification (§12) is informational everywhere
 * else in this module (see verifyAttributeExecution's callers), so a
 * reused schedule with no cleanly-resolvable sample condition just skips
 * verification with a warning rather than blocking the run. Picks the
 * first rule under this schedule, then the first of its conditions whose
 * resolved AttributeDefinition/ProductAttributeDefinition matches one of
 * the product's already-discovered attributes.
 */
export async function pickSampleVerificationEntry(
  client: SalesforceClient,
  scheduleId: string,
  attributes: AttributeDefinition[],
): Promise<SampleVerificationEntry | null> {
  const [ruleDescribe, conditionDescribe] = await Promise.all([
    client.describeObject("AttributeBasedAdjRule"),
    client.describeObject("AttributeAdjustmentCondition"),
  ]);

  const ruleScheduleField =
    findAllReferenceFieldsToTarget(ruleDescribe, "PriceAdjustmentSchedule")[0] ??
    ruleDescribe.fields.find(f => f.type === "reference" && /schedule/i.test(f.name)) ??
    null;
  if (!ruleScheduleField) return null;

  const ruleRes = await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjRule WHERE ${ruleScheduleField.name} = '${scheduleId}' LIMIT 20`);
  if (ruleRes.records.length === 0) return null;

  const conditionRuleField = findAllReferenceFieldsToTarget(conditionDescribe, "AttributeBasedAdjRule")[0] ?? null;
  const conditionAttrDefField = findAllReferenceFieldsToTarget(conditionDescribe, "AttributeDefinition")[0] ?? null;
  const conditionPadField = findAllReferenceFieldsToTarget(conditionDescribe, "ProductAttributeDefinition")[0] ?? null;
  const conditionValueField = conditionDescribe.fields.find(f => /^(AttributeValue|Value)$/i.test(f.name)) ?? null;
  if (!conditionRuleField || !conditionValueField) return null;

  const attrDefIds = new Set(attributes.map(a => a.id));
  const padFieldName = conditionPadField?.name;
  const fieldsToSelect = [
    "Id", conditionValueField.name,
    conditionAttrDefField?.name, padFieldName,
  ].filter(Boolean).join(", ");

  for (const rule of ruleRes.records) {
    let conditions: Record<string, unknown>[];
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT ${fieldsToSelect} FROM AttributeAdjustmentCondition WHERE ${conditionRuleField.name} = '${rule.Id}'`,
      );
      conditions = res.records;
    } catch {
      continue;
    }
    for (const cond of conditions) {
      const value = cond[conditionValueField.name];
      if (typeof value !== "string" || !value) continue;
      const attrDefId = conditionAttrDefField ? (cond[conditionAttrDefField.name] as string | undefined) : undefined;
      if (attrDefId && attrDefIds.has(attrDefId)) {
        const match = attributes.find(a => a.id === attrDefId);
        if (match) return { attributeName: match.name, attributeValue: value };
      }
      // Fall back to matching the raw value string against any discovered attribute's values —
      // covers orgs where the condition only carries a ProductAttributeDefinition, not the
      // AttributeDefinition itself.
      const byValue = attributes.find(a => a.values.some(v => v.value === value));
      if (byValue) return { attributeName: byValue.name, attributeValue: value };
    }
  }
  return null;
}
