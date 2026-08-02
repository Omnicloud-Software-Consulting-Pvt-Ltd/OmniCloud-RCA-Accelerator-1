import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type { AttributeDataType, AttributeOption, ProductAttribute } from "@/lib/quotes/types";

interface AttrFieldSchema {
  sequenceField: string;
  requiredField: string;
  defaultValueField: string;
  priceImpactingField: string | null;
  picklistIdField: string | null;
}

const attrFieldCache = createTTLCache<AttrFieldSchema | null>();

async function resolveAttrFieldSchema(client: SalesforceClient): Promise<AttrFieldSchema | null> {
  return attrFieldCache.getOrCompute(client.instanceUrl, async () => {
    let junctionDescribe: DescribeResult;
    let defDescribe: DescribeResult;
    try {
      [junctionDescribe, defDescribe] = await Promise.all([
        describeObjectCached(client, "ProductAttributeDefinition"),
        describeObjectCached(client, "AttributeDefinition"),
      ]);
    } catch {
      return null; // Product-attribute-management feature not enabled in this org.
    }
    return {
      sequenceField: resolveField(junctionDescribe, "Sequence", /^sequence$/i)?.name ?? "Sequence",
      requiredField: resolveField(junctionDescribe, "IsRequired", /^required$/i)?.name ?? "IsRequired",
      defaultValueField: resolveField(junctionDescribe, "DefaultValue", /^default value$/i)?.name ?? "DefaultValue",
      priceImpactingField:
        resolveField(junctionDescribe, "IsPriceImpacting", /price impact/i)?.name ??
        resolveField(defDescribe, "IsPriceImpacting", /price impact/i)?.name ??
        null,
      picklistIdField: resolveField(defDescribe, "PicklistId", /^picklist$/i)?.name ?? null,
    };
  });
}

function mapDataType(raw: string | undefined): AttributeDataType {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("multipicklist")) return "Multipicklist";
  if (t.includes("picklist")) return "Picklist";
  if (t.includes("checkbox") || t.includes("boolean")) return "Checkbox";
  if (t.includes("currency")) return "Currency";
  if (t.includes("percent")) return "Percent";
  if (t.includes("datetime")) return "Datetime";
  if (t.includes("date")) return "Date";
  if (t.includes("number") || t.includes("int") || t.includes("double")) return "Number";
  return "Text";
}

/**
 * Resolve custom attribute definitions attached to a product (§4.5).
 * Degrades to an empty array — never throws — if the org doesn't have the
 * product-attribute-management feature enabled, or if any query fails.
 */
export async function resolveProductAttributes(client: SalesforceClient, productId: string): Promise<ProductAttribute[]> {
  const schema = await resolveAttrFieldSchema(client);
  if (!schema) return [];

  try {
    const soql = `SELECT Id, ${schema.sequenceField}, ${schema.requiredField}, ${schema.defaultValueField},
      AttributeDefinitionId, AttributeDefinition.Label, AttributeDefinition.DataType,
      AttributeDefinition.AttributeCategoryId, AttributeDefinition.AttributeCategory.Label
      ${schema.picklistIdField ? `, AttributeDefinition.${schema.picklistIdField}` : ""}
      ${schema.priceImpactingField ? `, ${schema.priceImpactingField}` : ""}
      FROM ProductAttributeDefinition WHERE Product2Id = '${soqlEscape(productId)}' ORDER BY ${schema.sequenceField}`;

    const res = await client.query<Record<string, unknown>>(soql);
    const attributes: ProductAttribute[] = [];

    for (const row of res.records) {
      const def = (row.AttributeDefinition ?? {}) as Record<string, unknown>;
      const dataType = mapDataType(def.DataType as string | undefined);
      let options: AttributeOption[] | null = null;

      if ((dataType === "Picklist" || dataType === "Multipicklist") && schema.picklistIdField) {
        const picklistId = def[schema.picklistIdField] as string | undefined;
        if (picklistId) {
          try {
            const valuesRes = await client.query<{ Value: string; Label: string }>(
              `SELECT Value, Label FROM AttributePicklistValue WHERE AttributePicklistId = '${soqlEscape(picklistId)}' AND IsActive = true ORDER BY Sequence`,
            );
            options = valuesRes.records.map(v => ({ value: v.Value, label: v.Label }));
          } catch {
            options = [];
          }
        }
      }

      attributes.push({
        id: row.Id as string,
        attributeId: row.AttributeDefinitionId as string,
        name: (def.Label as string) ?? "Attribute",
        category: ((def.AttributeCategory as Record<string, unknown>)?.Label as string) ?? null,
        dataType,
        required: !!row[schema.requiredField],
        defaultValue: (row[schema.defaultValueField] as string) ?? null,
        priceImpacting: schema.priceImpactingField ? !!row[schema.priceImpactingField] : false,
        sequence: (row[schema.sequenceField] as number) ?? 0,
        options,
      });
    }
    return attributes;
  } catch {
    return [];
  }
}

export async function resolveProductAttributesBatch(client: SalesforceClient, productIds: string[]): Promise<Map<string, ProductAttribute[]>> {
  const result = new Map<string, ProductAttribute[]>();
  await Promise.all(
    productIds.map(async id => {
      result.set(id, await resolveProductAttributes(client, id));
    }),
  );
  return result;
}
