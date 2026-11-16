import type { NextRequest } from "next/server";
import { RampInputError, rampRoute, requireId, optionalId } from "@/lib/ramp/server/context";
import { productFacts, productRampSegments, quoteFacts, quoteGroups, quoteLines, searchAccounts, searchProducts, searchQuotes, sellingModels } from "@/lib/ramp/server/reads";
import { lineEligibility, productEligibility } from "@/lib/ramp/eligibility";
import { existingRamps, groupRampDiagnostics, groupState } from "@/lib/ramp/groupDiagnostics";
import { searchCatalog } from "@/lib/ramp/server/catalog";
import { accountOpportunities, activePricebooks, productLineOptions } from "@/lib/ramp/server/quoteBuilder";
import { capabilities } from "@/lib/ramp/server/reads";
import { pricingProcedures } from "@/lib/ramp/server/readiness";

// GET /api/ramp/lookup?type=… — READ-ONLY record pickers and eligibility for the RAMP pages.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  return rampRoute(req, async ({ api }) => {
    const q = (p.get("q") ?? "").slice(0, 80);
    switch (p.get("type")) {
      case "accounts": return { success: true, rows: await searchAccounts(api, q) };
      case "quotes": return { success: true, ...(await searchQuotes(api, { accountId: optionalId(p.get("accountId"), "accountId", "001"), q, draftOnly: p.get("all") !== "1", page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 25) || 25 })) };
      case "quote-lines": {
        const quoteId = requireId(p.get("quoteId"), "quoteId", "0Q0");
        const [quote, lines, groups] = await Promise.all([quoteFacts(api, quoteId), quoteLines(api, quoteId), quoteGroups(api, quoteId)]);
        const products = await productFacts(api, lines.map(l => l.productId!).filter(Boolean));
        const segs = await productRampSegments(api, [...products.keys()]);
        const ramps = existingRamps(groups, lines);
        return {
          success: true, quote, ramps,
          groups: groups.map(g => ({ ...g, state: groupState(g, groups), parentName: g.parentId ? groups.find(x => x.id === g.parentId)?.name ?? null : null, lineCount: lines.filter(l => l.groupId === g.id).length, rampKey: ramps.find(c => c.parent?.id === g.id || c.segments.some(x => x.id === g.id))?.key ?? null })),
          rows: lines.map(l => {
            const pr = l.productId ? products.get(l.productId) ?? null : null;
            const e = lineEligibility(l, quote, pr, segs.filter(s => s.productId === l.productId));
            return { ...l, product: pr, eligible: e.eligible, reasons: e.reasons };
          }),
        };
      }
      case "group-eligibility": {
        // Full diagnostics for one group (read-only): quote, group state, existing ramps, every line, org capability + pricing readiness.
        const quoteId = requireId(p.get("quoteId"), "quoteId", "0Q0"), groupId = requireId(p.get("groupId"), "groupId");
        const [quote, groups, lines, caps, procedures] = await Promise.all([quoteFacts(api, quoteId), quoteGroups(api, quoteId), quoteLines(api, quoteId), capabilities(api), pricingProcedures(api).catch(() => null)]);
        const glines = lines.filter(l => l.groupId === groupId);
        const products = await productFacts(api, glines.map(l => l.productId!).filter(Boolean));
        const segs = await productRampSegments(api, [...products.keys()]);
        const byProduct = new Map<string, typeof segs>();
        for (const s of segs) byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
        const d = groupRampDiagnostics({ quote, groupId, groups, lines, products, segmentsByProduct: byProduct });
        const pricing = {
          groupRamp: caps.groupRamp, compound: caps.compound,
          activeProcedures: procedures ? procedures.filter(x => x.activeVersion !== null).map(x => ({ apiName: x.apiName, name: x.name, activeVersion: x.activeVersion })) : null,
        };
        return { success: true, quote, ...d, lines: d.lines.map(x => ({ ...x.line, product: x.line.productId ? products.get(x.line.productId) ?? null : null, eligible: x.eligible, reasons: x.reasons })), groups, pricing };
      }
      case "catalog": return { success: true, ...(await searchCatalog(api, { q, pricebookId: optionalId(p.get("pricebookId"), "pricebookId", "01s"), page: Number(p.get("page") ?? 1) || 1, pageSize: Number(p.get("pageSize") ?? 25) || 25, inPricebookOnly: p.get("inPricebook") === "1" })) };
      case "pricebooks": return { success: true, rows: await activePricebooks(api) };
      case "opportunities": return { success: true, rows: await accountOpportunities(api, requireId(p.get("accountId"), "accountId", "001")) };
      case "line-options": return { success: true, ...(await productLineOptions(api, requireId(p.get("productId"), "productId", "01t"), optionalId(p.get("pricebookId"), "pricebookId", "01s"))) };
      case "products": return { success: true, rows: await searchProducts(api, q, { rampableOnly: p.get("rampable") === "1", eligibleOnly: p.get("eligible") !== "0", limit: 50 }) };
      case "product": {
        const id = requireId(p.get("productId"), "productId", "01t");
        const product = (await productFacts(api, [id])).get(id) ?? null;
        const [models, segments] = await Promise.all([product ? sellingModels(api, id) : [], product ? productRampSegments(api, [id]) : []]);
        return { success: true, product, sellingModels: models, segments, eligibility: productEligibility(product, models, segments) };
      }
      default: throw new RampInputError("type must be accounts, quotes, quote-lines, group-eligibility, products, product, catalog, pricebooks, opportunities or line-options.");
    }
  }, "Failed to read Salesforce records for RAMP");
}
