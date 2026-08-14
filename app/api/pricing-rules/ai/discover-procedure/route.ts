/**
 * POST /api/pricing-rules/ai/discover-procedure — Autopilot Steps 1-7: parse
 * the prompt, discover the product + every attribute/value assigned to it,
 * validate whatever the prompt explicitly priced, and split the result into
 * "mapped" (matched a real attribute/value) vs. left for the client to show
 * as "Not Yet Mapped". This endpoint NEVER writes to Salesforce — it is
 * read-only, full stop. The client renders a Product Summary, the full
 * attribute/value catalog, the extracted mappings, and a review/confirm
 * page from this response; only once the user explicitly confirms does the
 * client call the real /api/pricing-rules/create-procedure endpoint (the
 * same one the guided/manual flow uses) to actually create anything.
 *
 * This intentionally reuses none of create-procedure's native-record/
 * canvas/deploy logic — that machinery only ever runs from the guided flow
 * or from Autopilot's explicit post-review confirmation, never from here.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { resolveAnthropicKey } from "@/lib/config";
import { parsePricingPrompt } from "@/lib/pricing-rules/ai/parsePricingPrompt";
import { computeAttributeMappingSuggestions, type UnresolvedEntry } from "@/lib/pricing-rules/ai/attributeMappingSuggestions";
import { PRICING_RULES_API_VERSION, IMPLEMENTED_PRICING_TYPES, PRICING_TYPE_LABELS } from "@/lib/pricing-rules/types";
import type {
  ProcedureStep, DiscoverProcedureResult, AttributeDefinition, DiscoveredAttributeSummary,
  AttributeValueMappingPreview, AIAttributeEntry, AIGeneratedProcedure, PricingType,
} from "@/lib/pricing-rules/types";
import { discoverProductAttributes, ProductNotFoundError, ProductAttributeAuthError } from "@/lib/pricing-rules/salesforce/productAttributeDiscovery";
import { filterValidPricingRows, type NormalizedAttributeEntry } from "@/lib/pricing-rules/salesforce/nativeAttributeRecords";
import { findExistingScheduleForProduct } from "@/lib/pricing-rules/salesforce/existingAttributePricing";

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Canonicalizes every AI-extracted entry against what's REALLY on this product. Unmatched entries come back as `invalid` (with the matched attribute, if any) instead of failing outright — see computeAttributeMappingSuggestions for what happens to those. */
function validateAndCanonicalizeEntries(
  entries: AIAttributeEntry[],
  attributes: AttributeDefinition[],
): { valid: NormalizedAttributeEntry[]; invalid: UnresolvedEntry[] } {
  const invalid: UnresolvedEntry[] = [];
  const valid: NormalizedAttributeEntry[] = [];
  for (const e of entries) {
    const key = normalizeForMatch(e.attributeName);
    const attr = attributes.find(a => normalizeForMatch(a.name) === key || normalizeForMatch(a.label) === key);
    if (!attr) { invalid.push({ entry: e, matchedAttribute: null }); continue; }
    const vkey = normalizeForMatch(e.attributeValue);
    const val = attr.values.find(v => normalizeForMatch(v.value) === vkey || normalizeForMatch(v.label) === vkey);
    if (!val) { invalid.push({ entry: e, matchedAttribute: attr }); continue; }
    valid.push({ attributeName: attr.name, attributeValue: val.value, adjustmentType: e.adjustmentType, adjustmentValue: e.adjustmentValue });
  }
  return { valid, invalid };
}

function summarizeAttributes(attributes: AttributeDefinition[]): DiscoveredAttributeSummary[] {
  const priceImpacting = attributes.filter(a => a.isPriceImpacting === true);
  const list = priceImpacting.length > 0 ? priceImpacting : attributes;
  return list.map(a => ({ attributeName: a.name, attributeLabel: a.label || a.name, values: a.values.map(v => ({ value: v.value, label: v.label || v.value })) }));
}

/** Enriches canonical (name/value-only) entries with display labels for the "Pricing Mappings extracted from the prompt" section. */
function toMappingPreview(entries: NormalizedAttributeEntry[], attributes: AttributeDefinition[]): AttributeValueMappingPreview[] {
  return entries.map(e => {
    const attr = attributes.find(a => a.name === e.attributeName);
    const val = attr?.values.find(v => v.value === e.attributeValue);
    return {
      attributeName: e.attributeName,
      attributeLabel: attr?.label || e.attributeName,
      attributeValue: e.attributeValue,
      attributeValueLabel: val?.label || e.attributeValue,
      adjustmentType: e.adjustmentType,
      adjustmentValue: e.adjustmentValue,
    };
  });
}

function stopResponse(status: number, steps: ProcedureStep[], warnings: string[], friendlyError: string, extra?: Partial<DiscoverProcedureResult>) {
  return NextResponse.json({
    success: false, steps, warnings, error: friendlyError, friendlyError, ...extra,
  } satisfies DiscoverProcedureResult, { status });
}

export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let prompt = "";
  let debug = false;
  let override: { productName: string; procedureName: string; entries: AIAttributeEntry[] } | undefined;
  try {
    const body = await req.json();
    prompt = typeof body.prompt === "string" ? body.prompt : "";
    debug = body.debug === true;

    // "Use Suggested Mappings" (from the needsAttributeResolution panel) resubmits here with an
    // already-resolved product/procedure name and a caller-confirmed entry list, skipping AI
    // re-parsing — the entries still go through the exact same validation below, unconditionally.
    if (Array.isArray(body.overrideEntries) && body.overrideEntries.length > 0 && typeof body.overrideProductName === "string" && body.overrideProductName.trim()) {
      const entries = body.overrideEntries.filter((e: unknown): e is AIAttributeEntry =>
        !!e && typeof e === "object" &&
        typeof (e as Record<string, unknown>).attributeName === "string" &&
        typeof (e as Record<string, unknown>).attributeValue === "string" &&
        typeof (e as Record<string, unknown>).adjustmentType === "string" &&
        typeof (e as Record<string, unknown>).adjustmentValue === "number");
      if (entries.length > 0) {
        override = {
          productName: body.overrideProductName,
          procedureName: typeof body.overrideProcedureName === "string" && body.overrideProcedureName.trim()
            ? body.overrideProcedureName
            : `${body.overrideProductName} Attribute-Based Pricing Procedure`,
          entries,
        };
      }
    }

    if (!override && !prompt.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const apiKey = resolveAnthropicKey(req);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Anthropic API key not configured. Complete Setup to add your key.", code: "NO_AI_KEY" },
      { status: 503 },
    );
  }

  const steps: ProcedureStep[] = [];
  const warnings: string[] = [];

  try {
    return await runDiscoverPipeline(client, apiKey, { prompt, override }, steps, warnings, debug);
  } catch (err) {
    console.error("[discover-procedure] Unhandled error:", err);
    step(steps, "unhandled-error", "error", err instanceof Error ? err.message : String(err));
    return stopResponse(500, steps, warnings, "Autopilot ran into an unexpected problem while discovering this product. Nothing was created — try again, and if it keeps happening, check the server logs.");
  }
}

async function runDiscoverPipeline(
  client: SalesforceClient,
  apiKey: string,
  input: { prompt: string; override?: { productName: string; procedureName: string; entries: AIAttributeEntry[] } },
  steps: ProcedureStep[],
  warnings: string[],
  debug: boolean,
): Promise<NextResponse> {
  /* ── Step 1: Parse the prompt — skipped when resubmitting confirmed mappings ── */
  let parsed: AIGeneratedProcedure;
  if (input.override) {
    step(steps, "parse-prompt", "info", `Using confirmed product "${input.override.productName}" and ${input.override.entries.length} user-confirmed attribute mapping(s) — skipping AI re-parsing.`);
    parsed = { procedureName: input.override.procedureName, productName: input.override.productName, pricingType: "attribute-based", attributeEntries: input.override.entries };
  } else {
    step(steps, "parse-prompt", "start", "Parsing the prompt into a structured extraction.");
    try {
      parsed = await parsePricingPrompt(apiKey, input.prompt, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse the prompt.";
      step(steps, "parse-prompt", "error", message);
      return stopResponse(500, steps, warnings, "Autopilot couldn't understand that prompt. Try rephrasing it with the product name stated clearly, e.g. \"Create an Attribute-Based Pricing Procedure for Laptop.\"");
    }
  }

  const pricingType: PricingType = parsed.pricingType || "attribute-based";
  if (!IMPLEMENTED_PRICING_TYPES.includes(pricingType)) {
    const result: DiscoverProcedureResult = {
      success: false, notImplemented: true, steps, warnings,
      error: `${PRICING_TYPE_LABELS[pricingType]} pricing doesn't have a verified Salesforce deploy path yet — only Attribute-Based pricing is wired to a real Expression Set deploy in this build.`,
    };
    return NextResponse.json(result, { status: 501 });
  }

  const productName = parsed.productName?.trim();
  if (!productName) {
    step(steps, "parse-prompt", "error", "Could not determine which product this prompt refers to.");
    return stopResponse(400, steps, warnings, "Autopilot couldn't tell which product you meant. Restate the prompt with the product name included, e.g. \"Create an Attribute-Based Pricing Procedure for Laptop.\"");
  }
  const procedureName = parsed.procedureName?.trim() || `${productName} Attribute-Based Pricing Procedure`;
  step(steps, "parse-prompt", "success", `Extracted product "${productName}", procedure "${procedureName}", ${parsed.attributeEntries?.length ?? 0} explicit attribute pricing entr${(parsed.attributeEntries?.length ?? 0) === 1 ? "y" : "ies"}.`);

  /* ── Steps 2-3: Product Discovery + attribute/value discovery ── */
  step(steps, "product-discovery", "start", `Resolving product "${productName}" and every attribute/value assigned to it.`);
  let discovery: Awaited<ReturnType<typeof discoverProductAttributes>>;
  try {
    discovery = await discoverProductAttributes(client, productName);
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      const message = `Product '${productName}' does not exist.`;
      step(steps, "product-discovery", "error", message);
      const result: DiscoverProcedureResult = { success: false, productNotFound: true, productName, error: message, friendlyError: message, steps, warnings };
      return NextResponse.json(result, { status: 404 });
    }
    if (err instanceof ProductAttributeAuthError) {
      return NextResponse.json({ error: "Your Salesforce session has expired. Please reconnect and try again.", code: "TOKEN_EXPIRED" }, { status: 401 });
    }
    console.error("[discover-procedure] Product Discovery failed:", err);
    step(steps, "product-discovery", "error", err instanceof Error ? err.message : String(err));
    return stopResponse(500, steps, warnings, `Autopilot couldn't read this product's data from Salesforce. Verify Product2 (and its related attribute/selling-model configuration) is accessible to the connected user.`, { productName });
  }
  const { data } = discovery;
  steps.push(...discovery.steps);
  if (data.warning) warnings.push(data.warning);
  const { product, attributes } = data;
  step(steps, "product-discovery", "success", `Resolved ${product.name} (${product.id}) — ${attributes.length} attribute(s), Base Price ${product.basePrice ?? "unknown"}.`);

  if (!product.sellingModelId) {
    step(steps, "resolve-selling-model", "error", "No Product Selling Model is configured for this product.");
    return stopResponse(422, steps, warnings, `Autopilot couldn't determine a Selling Model for "${product.name}". Verify this product has a Selling Model configured under Revenue Cloud in Salesforce Setup, then try again.`, { productName, procedureName });
  }

  /* ── Step 4: Attribute Validation for whatever the prompt explicitly priced ── */
  let validEntries: NormalizedAttributeEntry[] = [];
  if (parsed.attributeEntries && parsed.attributeEntries.length > 0) {
    step(steps, "validate-attributes", "start", `Validating ${parsed.attributeEntries.length} attribute pricing entr${parsed.attributeEntries.length === 1 ? "y" : "ies"} against Salesforce.`);
    const { valid, invalid } = validateAndCanonicalizeEntries(parsed.attributeEntries, attributes);
    if (invalid.length > 0) {
      step(steps, "validate-attributes", "info", `${invalid.length} entr${invalid.length === 1 ? "y" : "ies"} didn't match a real attribute/value — computing suggested mappings instead of failing outright.`);
      let attributeIssues: Awaited<ReturnType<typeof computeAttributeMappingSuggestions>>;
      try {
        attributeIssues = await computeAttributeMappingSuggestions(apiKey, invalid, attributes);
      } catch (err) {
        warnings.push(`Suggested-mapping lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        attributeIssues = invalid.map(u => ({
          enteredAttributeName: u.entry.attributeName, enteredAttributeValue: u.entry.attributeValue,
          adjustmentType: u.entry.adjustmentType, adjustmentValue: u.entry.adjustmentValue,
        }));
      }
      step(steps, "validate-attributes", "error", `${invalid.length} attribute pricing entr${invalid.length === 1 ? "y" : "ies"} in the prompt didn't match a real Salesforce attribute/value.`);
      const result: DiscoverProcedureResult = {
        success: false, needsAttributeResolution: true,
        productName, procedureName, attributeIssues, resolvedEntries: valid,
        attributes: summarizeAttributes(attributes),
        error: `${invalid.length} attribute pricing entr${invalid.length === 1 ? "y" : "ies"} in the prompt didn't match a real Salesforce attribute/value — review the suggested mappings before continuing.`,
        steps, warnings,
      };
      return NextResponse.json(result, { status: 422 });
    }
    const filtered = filterValidPricingRows(valid);
    warnings.push(...filtered.warnings);
    validEntries = filtered.valid;
    step(steps, "validate-attributes", validEntries.length > 0 ? "success" : "info", `${validEntries.length} of ${parsed.attributeEntries.length} entries had a usable Adjustment Type + Amount.`);
  }

  /* ── Read-only reuse check — informs the Review page's Price Adjustment Schedule / Lookup Table row ── */
  let existingSchedule: Awaited<ReturnType<typeof findExistingScheduleForProduct>> = null;
  try {
    existingSchedule = await findExistingScheduleForProduct(client, product.id);
  } catch (err) {
    warnings.push(`Could not check for an existing Price Adjustment Schedule: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (existingSchedule && existingSchedule.ruleCount > 0) {
    step(steps, "check-existing-pricing", "info", `Found an existing PriceAdjustmentSchedule ${existingSchedule.scheduleId} with ${existingSchedule.ruleCount} rule(s) already configured for this product.`);
  } else {
    existingSchedule = null;
    step(steps, "check-existing-pricing", "info", "No existing attribute pricing found for this product yet.");
  }

  const result: DiscoverProcedureResult = {
    success: true,
    productName, procedureName,
    product: {
      id: product.id, name: product.name, productCode: product.productCode, status: product.status,
      currency: product.currency, sellingModelId: product.sellingModelId, sellingModelName: product.sellingModelName,
      effectiveFrom: product.effectiveFrom, effectiveTo: product.effectiveTo, basePrice: product.basePrice,
    },
    attributes: summarizeAttributes(attributes),
    mappedEntries: toMappingPreview(validEntries, attributes),
    existingSchedule,
    // §REQUEST_LIMIT_EXCEEDED remediation: the complete discovery result,
    // carried through unchanged so create-procedure's own Attribute
    // Discovery step can reuse it instead of re-running this same ~15-30-call
    // pipeline for the same product.
    fullAttributeData: data,
    steps, warnings,
    debugLog: debug ? client.debugLog : undefined,
  };
  return NextResponse.json(result);
}
