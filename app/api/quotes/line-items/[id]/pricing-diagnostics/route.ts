import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { soqlEscape } from "@/lib/salesforce/client";
import { resolveQuoteLineItemFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveQuoteLineAdjustmentDiscovery } from "@/lib/quotes/metadata/adjustmentFields";
import { capturePricingFieldDiagnostics } from "@/lib/quotes/server/lineItemCreate";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/quotes/line-items/[id]/pricing-diagnostics — read-only evidence
 * gathering for the discount-pricing investigation (Phases 1-3): given ANY
 * real QuoteLineItem Id (one this app created, or one discounted manually
 * in the Salesforce UI), returns:
 *   1. This QLI's own core fields (Product2Id, PricebookEntryId, Discount,
 *      Quantity) plus every pricing-shaped field on QuoteLineItem with full
 *      Describe evidence (createable/updateable/calculated) and its live
 *      value — see capturePricingFieldDiagnostics.
 *   2. Whether a DISTINCT Revenue Cloud manual-adjustment object was
 *      discovered for this org (never a guessed name — see
 *      lib/quotes/metadata/adjustmentFields.ts) and, if so, every related
 *      record on that object for THIS QLI, with its own full field values.
 *
 * Never writes anything. Intended use: call this once with a QuoteLineItem
 * Id that was manually given a "Percentage-Based (Line-Level)" adjustment
 * in the Salesforce UI, and once with an Id this app created with the same
 * discount — diff the two JSON responses directly to see exactly what
 * differs (§Phase 3).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: quoteLineItemId } = await params;

  try {
    const qliSchema = await resolveQuoteLineItemFieldSchema(client);

    const selectFields = ["Id"];
    if (qliSchema.quoteField) selectFields.push(qliSchema.quoteField.apiName);
    if (qliSchema.productField) selectFields.push(qliSchema.productField.apiName);
    if (qliSchema.pricebookEntryField) selectFields.push(qliSchema.pricebookEntryField.apiName);
    if (qliSchema.quantityField) selectFields.push(qliSchema.quantityField.apiName);
    if (qliSchema.discountField) selectFields.push(qliSchema.discountField.apiName);
    const coreRes = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM QuoteLineItem WHERE Id = '${soqlEscape(quoteLineItemId)}' LIMIT 1`,
    );
    const coreRecord = coreRes.records[0] ?? null;
    if (!coreRecord) {
      return NextResponse.json({ error: `No QuoteLineItem found with Id ${quoteLineItemId}.` }, { status: 404 });
    }

    const pricingFieldDiagnostics = (await capturePricingFieldDiagnostics(client, [quoteLineItemId]))[quoteLineItemId] ?? [];

    const adjustmentDiscovery = await resolveQuoteLineAdjustmentDiscovery(client);
    let relatedAdjustmentRecords: Record<string, unknown>[] = [];
    let relatedAdjustmentQuerySoql: string | null = null;
    if (adjustmentDiscovery.objectName && adjustmentDiscovery.quoteLineItemField) {
      const allFieldNames = adjustmentDiscovery.diagnostics.fieldEvidence.map(f => f.apiName);
      relatedAdjustmentQuerySoql =
        `SELECT ${[...new Set(["Id", ...allFieldNames])].join(", ")} FROM ${adjustmentDiscovery.objectName} ` +
        `WHERE ${adjustmentDiscovery.quoteLineItemField.apiName} = '${soqlEscape(quoteLineItemId)}'`;
      try {
        const adjRes = await client.query<Record<string, unknown>>(relatedAdjustmentQuerySoql);
        relatedAdjustmentRecords = adjRes.records;
      } catch (err) {
        console.error(`[pricing-diagnostics] Failed to query discovered adjustment object "${adjustmentDiscovery.objectName}":`, err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      success: true,
      quoteLineItemId,
      core: coreRecord,
      pricingFieldDiagnostics,
      adjustmentDiscovery,
      relatedAdjustmentRecords,
      relatedAdjustmentQuerySoql,
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to gather pricing diagnostics for this line item");
  }
}
