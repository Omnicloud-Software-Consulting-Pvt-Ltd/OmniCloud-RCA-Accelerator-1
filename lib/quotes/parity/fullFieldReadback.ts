import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveBundleObjectDiscovery, resolveQuoteLineRelationshipSchema } from "@/lib/quotes/metadata/relationshipFields";

const ID_CHUNK_SIZE = 150;
const FIELD_CHUNK_SIZE = 40; // keeps each generated SOQL string well under any org's query-length limit

/**
 * §Structural Parity Comparison: read back EVERY field this org's Describe
 * says is accessible on a record — not a curated subset — so a real
 * native-vs-app comparison can name a field this app never even considered
 * (e.g. ConfigurationId/ProductConfigurationId, a custom Revenue Cloud
 * field) instead of silently omitting it. Field list comes from Describe,
 * never hardcoded; chunked across both fields and Ids so this can't run
 * into a SOQL query-length limit on an object with many custom fields.
 */
async function fetchAllFieldsForIds(
  client: SalesforceClient,
  sobject: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const rowsById = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return rowsById;

  const describe = await describeObjectCached(client, sobject);
  const fieldNames = describe.fields
    .filter(f => f.accessible !== false && f.type !== "address" && f.type !== "location")
    .map(f => f.name);
  // Id is always included so rows can be keyed, even if a field chunk fails.
  const selectable = [...new Set(["Id", ...fieldNames])];

  for (let idOffset = 0; idOffset < ids.length; idOffset += ID_CHUNK_SIZE) {
    const idChunk = ids.slice(idOffset, idOffset + ID_CHUNK_SIZE);
    const idList = idChunk.map(id => `'${soqlEscape(id)}'`).join(",");
    for (const id of idChunk) if (!rowsById.has(id)) rowsById.set(id, { Id: id });

    for (let fieldOffset = 0; fieldOffset < selectable.length; fieldOffset += FIELD_CHUNK_SIZE) {
      const fieldChunk = ["Id", ...selectable.slice(fieldOffset, fieldOffset + FIELD_CHUNK_SIZE)];
      try {
        const res = await client.query<Record<string, unknown>>(
          `SELECT ${[...new Set(fieldChunk)].join(", ")} FROM ${sobject} WHERE Id IN (${idList})`,
        );
        for (const row of res.records) {
          const id = row.Id as string;
          const existing = rowsById.get(id) ?? { Id: id };
          rowsById.set(id, { ...existing, ...row });
        }
      } catch (err) {
        // A bad field in this chunk (e.g. a type SOQL rejects in a WHERE/SELECT
        // combination this app hasn't seen) must not lose every OTHER field —
        // log and continue with the next chunk rather than aborting the dump.
        console.error(`[fetchAllFieldsForIds] field chunk failed for ${sobject} (fields: ${fieldChunk.join(", ")}):`, err instanceof Error ? err.message : err);
      }
    }
  }
  return rowsById;
}

export interface FullFieldQuoteLineItemDump {
  rowsById: Map<string, Record<string, unknown>>;
  productIdField: string | null;
}

/** Full-field dump of every QuoteLineItem on a quote — the app's own side of a native-vs-app parity comparison. */
export async function fetchFullQuoteLineItemDump(client: SalesforceClient, quoteId: string): Promise<FullFieldQuoteLineItemDump> {
  const qliSchema = await resolveQuoteLineItemFieldSchema(client);
  const quoteFilterField = qliSchema.quoteField?.apiName ?? "QuoteId";
  const idRes = await client.query<{ Id: string }>(
    `SELECT Id FROM QuoteLineItem WHERE ${quoteFilterField} = '${soqlEscape(quoteId)}' LIMIT 2000`,
  );
  const ids = idRes.records.map(r => r.Id);
  const rowsById = await fetchAllFieldsForIds(client, "QuoteLineItem", ids);
  return { rowsById, productIdField: qliSchema.productField?.apiName ?? null };
}

export interface FullFieldRelationshipDump {
  rowsById: Map<string, Record<string, unknown>>;
  objectName: string | null;
  mainQuoteLineApiName: string | null;
  associatedQuoteLineApiName: string | null;
}

/** Full-field dump of every QuoteLineRelationship edge touching the given QuoteLineItem Ids. */
export async function fetchFullRelationshipDump(
  client: SalesforceClient,
  quoteLineItemIds: string[],
): Promise<FullFieldRelationshipDump> {
  const discovery = await resolveBundleObjectDiscovery(client);
  const qlrSchema = await resolveQuoteLineRelationshipSchema(client, discovery);
  if (qlrSchema.mechanism !== "relationship-object" || !qlrSchema.objectName || !qlrSchema.mainQuoteLineField || !qlrSchema.associatedQuoteLineField || quoteLineItemIds.length === 0) {
    return { rowsById: new Map(), objectName: qlrSchema.objectName, mainQuoteLineApiName: qlrSchema.mainQuoteLineField?.apiName ?? null, associatedQuoteLineApiName: qlrSchema.associatedQuoteLineField?.apiName ?? null };
  }

  const mainField = qlrSchema.mainQuoteLineField.apiName;
  const associatedField = qlrSchema.associatedQuoteLineField.apiName;
  const edgeIds = new Set<string>();
  for (let offset = 0; offset < quoteLineItemIds.length; offset += ID_CHUNK_SIZE) {
    const chunk = quoteLineItemIds.slice(offset, offset + ID_CHUNK_SIZE);
    const idList = chunk.map(id => `'${soqlEscape(id)}'`).join(",");
    try {
      const res = await client.query<{ Id: string }>(
        `SELECT Id FROM ${qlrSchema.objectName} WHERE ${mainField} IN (${idList}) OR ${associatedField} IN (${idList})`,
      );
      for (const r of res.records) edgeIds.add(r.Id);
    } catch (err) {
      console.error(`[fetchFullRelationshipDump] edge-id lookup failed for ${qlrSchema.objectName}:`, err instanceof Error ? err.message : err);
    }
  }

  const rowsById = await fetchAllFieldsForIds(client, qlrSchema.objectName, [...edgeIds]);
  return { rowsById, objectName: qlrSchema.objectName, mainQuoteLineApiName: mainField, associatedQuoteLineApiName: associatedField };
}
