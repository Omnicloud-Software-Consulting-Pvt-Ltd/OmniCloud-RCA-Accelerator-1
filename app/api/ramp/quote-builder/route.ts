import type { NextRequest } from "next/server";
import { RampInputError, optionalId, rampRoute, requireId } from "@/lib/ramp/server/context";
import { addGroupLines, createDraftQuote, createQuoteLineGroup } from "@/lib/ramp/server/quoteBuilder";
import { recordEvent } from "@/lib/ramp/server/service";

/**
 * POST /api/ramp/quote-builder — the Group Ramp page's Salesforce writes BEFORE a ramp runs, each only with confirmed: true and each
 * read back from Salesforce (lib/ramp/server/quoteBuilder.ts). Every attempt (success or failure) goes to RAMP history.
 *  { action: "create-quote", confirmed, name, accountId, opportunityId?, pricebookId, expirationDate?, startDate? }
 *  { action: "create-group", confirmed, quoteId, name, description?, parentId? }
 *  { action: "add-lines",    confirmed, quoteId, groupId, items: [{ productId, pricebookEntryId | sellingModelId, quantity, billingFrequency? }], startDate?, endDate? }
 */
export const maxDuration = 60;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown, label: string) => { const s = str(v); if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RampInputError(`${label} must be YYYY-MM-DD.`); return s; };

export async function POST(req: NextRequest) {
  return rampRoute(req, async (ctx, b) => {
    if (b.confirmed !== true) throw new RampInputError("This writes to Salesforce — confirm it first (confirmed: true).");
    switch (b.action) {
      case "create-quote": {
        const accountId = optionalId(b.accountId, "accountId", "001");
        const r = await createDraftQuote(ctx.api, { name: str(b.name) ?? "", accountId, opportunityId: optionalId(b.opportunityId, "opportunityId", "006"), pricebookId: optionalId(b.pricebookId, "pricebookId", "01s"), expirationDate: date(b.expirationDate, "expirationDate"), startDate: date(b.startDate, "startDate") });
        await recordEvent(ctx, { kind: "group-deal", action: "create-quote", status: r.ok ? "success" : "failed", summary: r.message, refs: { quoteId: r.record?.id ?? null, accountId, salesforceId: r.record?.id ?? null }, detail: { calls: r.calls, warnings: r.warnings } });
        return { success: r.ok, ...r };
      }
      case "create-group": {
        const quoteId = requireId(b.quoteId, "quoteId", "0Q0");
        const r = await createQuoteLineGroup(ctx.api, { quoteId, name: str(b.name) ?? "", description: str(b.description), parentId: optionalId(b.parentId, "parentId") });
        await recordEvent(ctx, { kind: "group-deal", action: "create-group", status: r.ok ? "success" : "failed", summary: r.message, refs: { quoteId, groupId: r.record?.id ?? null, salesforceId: r.record?.id ?? null }, detail: { calls: r.calls, warnings: r.warnings } });
        return { success: r.ok, ...r };
      }
      case "add-lines": {
        const quoteId = requireId(b.quoteId, "quoteId", "0Q0"), groupId = requireId(b.groupId, "groupId");
        const items = Array.isArray(b.items) ? b.items.map((x, i) => { const o = (x ?? {}) as Record<string, unknown>; return { productId: requireId(o.productId, `items[${i}].productId`, "01t"), pricebookEntryId: optionalId(o.pricebookEntryId, `items[${i}].pricebookEntryId`, "01u"), sellingModelId: optionalId(o.sellingModelId, `items[${i}].sellingModelId`, "0jP"), quantity: Number(o.quantity), billingFrequency: str(o.billingFrequency) }; }) : [];
        const r = await addGroupLines(ctx.api, { quoteId, groupId, items, startDate: date(b.startDate, "startDate"), endDate: date(b.endDate, "endDate") });
        await recordEvent(ctx, { kind: "group-deal", action: "add-lines", status: r.ok ? "success" : "failed", summary: r.message, refs: { quoteId, groupId }, detail: { calls: r.calls, warnings: r.warnings, lines: r.record } });
        return { success: r.ok, ...r };
      }
      default: throw new RampInputError("action must be create-quote, create-group or add-lines.");
    }
  }, "The Salesforce write failed");
}
