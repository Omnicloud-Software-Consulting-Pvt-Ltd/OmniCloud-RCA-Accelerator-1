import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { fetchFullQuoteLineItemDump, fetchFullRelationshipDump } from "@/lib/quotes/parity/fullFieldReadback";
import { matchQuoteLineItemRows, matchRelationshipRows, findKey } from "@/lib/quotes/parity/diff";
import { investigateConfigurationFields } from "@/lib/quotes/parity/configurationFields";
import { repriceQuote } from "@/lib/quotes/pricing/reprice";

type Params = { params: Promise<{ id: string }> };

/**
 * §Structural Parity Comparison (repricing-failure ticket) — FULLY
 * AUTOMATED: the app already holds an authenticated Salesforce session
 * (§serverSession), so this never asks the developer to export/paste
 * anything. Given a native Quote Id (created manually in Salesforce) and
 * this app's own created Quote Id (`[id]`), it fetches BOTH sides'
 * QuoteLineItem/QuoteLineRelationship records directly via SOQL — using
 * Describe to discover every readable field, never a curated subset — and
 * reports only the differences, naming the FIRST one.
 *
 * `compareReprice` (opt-in, default false): also calls this app's own
 * `repriceQuote()` against BOTH quotes and returns both summaries side by
 * side, including the COMPLETE outgoing request (path + body) and the
 * COMPLETE response/error for each attempt. Opt-in and off by default
 * because — unlike the read-only comparison above — this triggers
 * Salesforce's actual repricing action against the NATIVE reference quote
 * too (a real write), which the caller should only do deliberately.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: appQuoteId } = await params;

  let nativeQuoteId: string;
  let compareReprice: boolean;
  try {
    const body = await req.json();
    nativeQuoteId = typeof body.nativeQuoteId === "string" ? body.nativeQuoteId.trim() : "";
    compareReprice = body.compareReprice === true;
    if (!nativeQuoteId) {
      return NextResponse.json({ error: "nativeQuoteId is required — the Id of the bundle created manually/natively in Salesforce to compare against." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const [nativeQliDump, appQliDump] = await Promise.all([
      fetchFullQuoteLineItemDump(client, nativeQuoteId),
      fetchFullQuoteLineItemDump(client, appQuoteId),
    ]);
    const nativeLineItems = [...nativeQliDump.rowsById.values()];
    const appLineItems = [...appQliDump.rowsById.values()];

    if (nativeLineItems.length === 0) {
      return NextResponse.json({ error: `No QuoteLineItem records found for native Quote Id ${nativeQuoteId} — check the Id and that it has line items.` }, { status: 404 });
    }
    if (appLineItems.length === 0) {
      return NextResponse.json({ error: `No QuoteLineItem records found for this app's Quote Id ${appQuoteId} — check that the bundle was actually created.` }, { status: 404 });
    }

    const lineItemComparisons = matchQuoteLineItemRows(nativeLineItems, appLineItems);

    // Each side's own QuoteLineItem-Id -> Product2Id map, needed to pair
    // relationship edges by the (parent product, child product) they
    // ultimately point at, since the edges' own Ids are per-record and
    // never equal across the two independently-created bundles.
    const appProductField = appQliDump.productIdField ?? "Product2Id";
    const nativeProductField = nativeQliDump.productIdField ?? "Product2Id";
    const appQliProductById = new Map<string, string>();
    for (const row of appLineItems) {
      const id = row.Id as string;
      const key = findKey(row, [appProductField, "Product2Id"]);
      if (id && key) appQliProductById.set(id, row[key] as string);
    }
    const nativeQliProductById = new Map<string, string>();
    for (const row of nativeLineItems) {
      const id = row.Id as string;
      const key = findKey(row, [nativeProductField, "Product2Id"]);
      if (id && key) nativeQliProductById.set(id, row[key] as string);
    }

    const [nativeQlrDump, appQlrDump] = await Promise.all([
      fetchFullRelationshipDump(client, [...nativeQliProductById.keys()]),
      fetchFullRelationshipDump(client, [...appQliProductById.keys()]),
    ]);
    const relationshipComparisons = matchRelationshipRows(
      [...nativeQlrDump.rowsById.values()], nativeQliProductById, nativeQlrDump.mainQuoteLineApiName, nativeQlrDump.associatedQuoteLineApiName,
      [...appQlrDump.rowsById.values()], appQliProductById, appQlrDump.mainQuoteLineApiName, appQlrDump.associatedQuoteLineApiName,
    );

    const configurationFieldInvestigation = await investigateConfigurationFields(client, nativeLineItems, appLineItems);

    let repricingComparison: { native: Awaited<ReturnType<typeof repriceQuote>>; app: Awaited<ReturnType<typeof repriceQuote>> } | null = null;
    if (compareReprice) {
      const [native, app] = await Promise.all([repriceQuote(client, nativeQuoteId), repriceQuote(client, appQuoteId)]);
      repricingComparison = { native, app };
    }

    const firstDifferingLineItemRow = lineItemComparisons.find(c => c.firstDifferingField);
    const firstDifferingRelationshipRow = relationshipComparisons.find(c => c.firstDifferingField);
    const missingInApp = lineItemComparisons.filter(c => c.nativeRow && !c.appRow).length;
    const missingInNative = lineItemComparisons.filter(c => c.appRow && !c.nativeRow).length;

    return NextResponse.json({
      success: true,
      nativeQuoteId,
      appQuoteId,
      relationshipObjectName: appQlrDump.objectName ?? nativeQlrDump.objectName,
      summary: {
        lineItemsCompared: lineItemComparisons.filter(c => c.nativeRow && c.appRow).length,
        lineItemsMissingInApp: missingInApp,
        lineItemsMissingInNative: missingInNative,
        relationshipsCompared: relationshipComparisons.filter(c => c.nativeRow && c.appRow).length,
        // The single most useful answer this endpoint exists to produce —
        // prefer a line-item-level difference (repricing/Product Discovery
        // reads QuoteLineItem fields first) over a relationship-level one.
        firstDifferingField: firstDifferingLineItemRow?.firstDifferingField
          ? { scope: "QuoteLineItem", matchKey: firstDifferingLineItemRow.matchKey, ...firstDifferingLineItemRow.firstDifferingField }
          : firstDifferingRelationshipRow?.firstDifferingField
            ? { scope: appQlrDump.objectName ?? "QuoteLineRelationship", matchKey: firstDifferingRelationshipRow.matchKey, ...firstDifferingRelationshipRow.firstDifferingField }
            : null,
      },
      lineItemComparisons,
      relationshipComparisons,
      configurationFieldInvestigation,
      repricingComparison,
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to run the automated bundle parity comparison");
  }
}
