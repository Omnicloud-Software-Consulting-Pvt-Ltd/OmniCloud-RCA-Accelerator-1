import { productEligibility } from "@/lib/ramp/eligibility";
import { capabilities, productFacts, productRampSegments, sellingModels } from "./reads";
import { sfMessage, type RampApi } from "./api";
import type { SalesforceCall } from "@/lib/ramp/types";

/**
 * Product Ramp Segment creation — POST /sobjects/ProductRampSegment, the ONLY Salesforce write of Product Ramp Setup.
 * Before writing: the org exposes the object (Describe), the product + selling model exist, the selling model is one of the product's
 * TermDefined options, the segment type is one of the org's picklist values, and NO segment with the same product + selling model +
 * segment type exists (re-read right before the insert). After writing: the record is read back and the product's CanRamp is
 * reported exactly as Salesforce shows it (Product2.CanRamp isn't API-writable; Salesforce sets it from the segment — p10/p12).
 */
export interface CreateSegmentInput { productId: string; sellingModelId: string; segmentType: string; trialDuration?: number | null; durationType?: string | null }
export interface CreateSegmentResult { ok: boolean; message: string; segmentId: string | null; reused: boolean; canRamp: boolean | null; calls: SalesforceCall[] }

export async function createProductRampSegment(api: RampApi, input: CreateSegmentInput, now = () => new Date().toISOString()): Promise<CreateSegmentResult> {
  const calls: SalesforceCall[] = [];
  const fail = (message: string): CreateSegmentResult => ({ ok: false, message, segmentId: null, reused: false, canRamp: null, calls });
  const caps = await capabilities(api);
  if (!caps.productRampSegment.available) return fail(caps.productRampSegment.reason ?? "Product Ramp Segments aren't available.");
  if (!caps.productRampSegment.segmentTypes.includes(input.segmentType)) return fail(`Segment type "${input.segmentType}" isn't one of this org's values (${caps.productRampSegment.segmentTypes.join(", ")}).`);
  const trial = input.segmentType === "FreeTrial";
  if (trial && !(input.trialDuration && Number.isInteger(input.trialDuration) && input.trialDuration > 0)) return fail("A FreeTrial segment needs a whole-number Trial Duration of at least 1.");
  if (trial && (!input.durationType || !caps.productRampSegment.durationTypes.includes(input.durationType))) return fail(`Choose a Duration Type (${caps.productRampSegment.durationTypes.join(", ")}).`);
  const product = (await productFacts(api, [input.productId])).get(input.productId) ?? null;
  const models = product ? await sellingModels(api, input.productId) : [];
  const existing = product ? await productRampSegments(api, [input.productId]) : [];
  const elig = productEligibility(product, models, existing);
  const blocking = elig.reasons.filter(r => r.severity === "error" && r.code !== "not-rampable");
  if (blocking.length) return fail(blocking.map(r => r.message).join(" "));
  if (!elig.termModels.some(m => m.id === input.sellingModelId)) return fail("That selling model isn't one of this product's active term-based (TermDefined) selling models.");

  const dupe = existing.find(e => e.sellingModelId === input.sellingModelId && e.segmentType === input.segmentType);
  if (dupe) return { ok: true, reused: true, segmentId: dupe.id, canRamp: product!.canRamp, calls, message: `${product!.name} already has a ${input.segmentType} Product Ramp Segment for this selling model (${dupe.name ?? dupe.id}) — nothing new was created.` };

  const body: Record<string, unknown> = { ProductId: input.productId, ProductSellingModelId: input.sellingModelId, SegmentType: input.segmentType, ...(trial ? { TrialDuration: input.trialDuration, DurationType: input.durationType } : {}) };
  const r = await api.call("POST", "/sobjects/ProductRampSegment", body);
  calls.push({ at: now(), method: "POST", path: "/sobjects/ProductRampSegment", request: body, status: r.status, response: r.body });
  const id = r.status < 300 ? ((r.body as { id?: string } | null)?.id ?? null) : null;
  if (!id) return fail(`Salesforce didn't create the Product Ramp Segment: ${sfMessage(r.body, `HTTP ${r.status}`)}`);

  const readBack = (await productRampSegments(api, [input.productId])).find(x => x.id === id);
  const after = (await productFacts(api, [input.productId])).get(input.productId);
  if (!readBack || readBack.sellingModelId !== input.sellingModelId || readBack.segmentType !== input.segmentType) {
    return { ok: false, reused: false, segmentId: id, canRamp: after?.canRamp ?? null, calls, message: `Salesforce returned ${id}, but reading it back didn't show the requested product / selling model / segment type.` };
  }
  return { ok: true, reused: false, segmentId: id, canRamp: after?.canRamp ?? null, calls, message: `Created ${readBack.name ?? id} (${input.segmentType}) for ${product!.name} — read back from Salesforce. CanRamp is now ${after?.canRamp === null || after?.canRamp === undefined ? "unknown" : String(after.canRamp)}.` };
}
