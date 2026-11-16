import { groupRampDiagnostics, type GroupFacts } from "./groupDiagnostics";
/**
 * Ramp eligibility (pure; the facts are read from Salesforce by server/sf.ts). Every rule is a fact verified in a live org:
 *  · Product2.CanRamp = false → Salesforce refuses ramp-deal-create ("You can't ramp products that aren't rampable"; p12).
 *    CanRamp isn't API-writable (createable/updateable false in p10 and p12); Salesforce sets it when the product gets a
 *    ProductRampSegment — so the fix is a Product Ramp Segment, never a Product2 update.
 *  · Usage-based products (Product2.UsageModelType set) → Place Sales Transaction refuses the commit ("Select a product that isn't
 *    usage-based to ramp that product"; p12, API Access Premium = Anchor).
 *  · Only TermDefined selling models ramp; the line's ProductSellingModel must have a ProductRampSegment.
 *  · Only Draft quotes; a line already carrying a RampIdentifier is already ramped.
 *  · A line without PeriodBoundary makes Salesforce pricing fail (INVALID_PERIOD_BOUNDARY, p12) — set on the segments before pricing.
 * A fact that couldn't be read (null) is a warning, never an "ineligible" verdict.
 */
export interface ProductFacts { id: string; name: string; isActive: boolean | null; canRamp: boolean | null; usageModelType: string | null; type: string | null; productCode: string | null }
export interface SellingModelFacts { id: string; name: string; type: string | null; status: string | null }
export interface RampSegmentFacts { id: string; sellingModelId: string; segmentType: string | null; name: string | null }
export interface LineFacts { id: string; quoteId: string; productId: string | null; sellingModelId: string | null; sellingModelType: string | null; rampIdentifier: string | null; groupId: string | null; startDate: string | null; endDate: string | null; quantity: number | null; unitPrice: number | null; periodBoundary: string | null; subscriptionTerm: number | null }
export interface QuoteFacts { id: string; name: string; status: string | null; accountId: string | null; pricebookId: string | null }

export interface Reason { code: string; message: string; severity: "error" | "warning" }

export function productEligibility(p: ProductFacts | null, models: SellingModelFacts[], segments: RampSegmentFacts[]): { eligible: boolean; reasons: Reason[]; termModels: SellingModelFacts[] } {
  const reasons: Reason[] = [];
  if (!p) return { eligible: false, reasons: [{ code: "product-missing", severity: "error", message: "The product wasn't found (or your Salesforce user can't read it)." }], termModels: [] };
  if (p.isActive === false) reasons.push({ code: "inactive", severity: "error", message: `${p.name} is inactive.` });
  if (p.usageModelType) reasons.push({ code: "usage-based", severity: "error", message: `${p.name} is usage-based (UsageModelType = ${p.usageModelType}); Salesforce refuses to ramp usage-based products.` });
  if (p.type && /bundle/i.test(p.type)) reasons.push({ code: "bundle", severity: "warning", message: `${p.name} is a bundle (Type = ${p.type}); Salesforce may refuse ramp segments for products that aren't simple products.` });
  const termModels = models.filter(m => m.type === "TermDefined" && (m.status === null || m.status === "Active"));
  if (!termModels.length) reasons.push({ code: "no-term-model", severity: "error", message: `${p.name} has no active term-based (TermDefined) selling model — only those can be ramped.` });
  if (p.canRamp === false && !segments.length) reasons.push({ code: "no-ramp-segment", severity: "warning", message: `${p.name} isn't rampable yet (CanRamp = false). Create a Product Ramp Segment first — Salesforce sets CanRamp when one exists.` });
  else if (p.canRamp === false) reasons.push({ code: "not-rampable", severity: "error", message: `${p.name} has Product Ramp Segments but Salesforce still reports CanRamp = false.` });
  if (p.canRamp === null) reasons.push({ code: "canramp-unknown", severity: "warning", message: "CanRamp couldn't be read for this product." });
  return { eligible: !reasons.some(r => r.severity === "error"), reasons, termModels };
}

export function lineEligibility(line: LineFacts | null, quote: QuoteFacts | null, product: ProductFacts | null, segments: RampSegmentFacts[]): { eligible: boolean; reasons: Reason[] } {
  const r: Reason[] = [];
  if (!quote) return { eligible: false, reasons: [{ code: "quote-missing", severity: "error", message: "The quote wasn't found." }] };
  if (quote.status !== "Draft") r.push({ code: "quote-not-draft", severity: "error", message: `Quote ${quote.name} is ${quote.status ?? "not Draft"}; ramps are added to Draft quotes only.` });
  if (!line) return { eligible: false, reasons: [...r, { code: "line-missing", severity: "error", message: "The quote line wasn't found on this quote." }] };
  if (line.quoteId !== quote.id) r.push({ code: "line-other-quote", severity: "error", message: "The line belongs to another quote." });
  if (line.rampIdentifier) r.push({ code: "already-ramped", severity: "error", message: `The line is already ramped (RampIdentifier ${line.rampIdentifier}).` });
  if (line.sellingModelType && line.sellingModelType !== "TermDefined") r.push({ code: "not-term", severity: "error", message: `The line's selling model is ${line.sellingModelType}; only TermDefined lines ramp.` });
  if (!line.startDate || !line.endDate) r.push({ code: "no-dates", severity: "error", message: "The line needs a start and end date." });
  if (product) {
    const pe = productEligibility(product, [], segments);
    for (const x of pe.reasons) if (x.code !== "no-term-model") r.push(x);
    if (line.sellingModelId && segments.length && !segments.some(s => s.sellingModelId === line.sellingModelId)) r.push({ code: "no-segment-for-model", severity: "error", message: "The product's Product Ramp Segments are for another selling model than this line's — create one for the line's selling model." });
    if (!segments.length && product.canRamp !== true) r.push({ code: "no-segments", severity: "error", message: `${product.name} has no Product Ramp Segment — create one in Product Ramp Setup.` });
  } else r.push({ code: "product-missing", severity: "error", message: "The line's product couldn't be read." });
  if (!line.periodBoundary) r.push({ code: "no-period-boundary", severity: "warning", message: "The line has no Period Boundary — the run sets one on every segment before pricing (Salesforce pricing fails without it)." });
  return { eligible: !r.some(x => x.severity === "error"), reasons: r };
}

/** Group ramp eligibility — same rules as the UI diagnostics (lib/ramp/groupDiagnostics.ts). */
export function groupEligibility(a: { quote: QuoteFacts | null; groupId: string | null; groups: GroupFacts[]; lines: LineFacts[]; products: Map<string, ProductFacts>; segmentsByProduct: Map<string, RampSegmentFacts[]> }): { eligible: boolean; reasons: Reason[] } {
  const d = groupRampDiagnostics(a);
  return { eligible: d.eligible, reasons: d.reasons };
}
