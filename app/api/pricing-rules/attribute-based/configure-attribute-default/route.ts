import { NextRequest, NextResponse } from "next/server";
import { SalesforceError } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { setEffectiveAttributeDefaultValue } from "@/lib/pricing-rules/attribute-based/create/nativeRecords";

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * POST /api/pricing-rules/attribute-based/configure-attribute-default
 *
 * §Follow-on 42, extended (§Live-org fix) — the remediation endpoint for "a price-impacting attribute
 * has no resolvable base value" (see MissingAttributeConfigurationError / CreateFailure.missingAttributeConfig).
 * `productAttributeDefinitionId` is null for a purely Product-Classification-inherited attribute (no
 * product-level record exists at all) — this route now also accepts `productId`/`attributeDefinitionId`/
 * `productClassificationAttrId` (all present on `MissingAttributeConfigInfo`) so
 * `setEffectiveAttributeDefaultValue` can create a product-scoped override in that case, instead of the
 * "Save Default Value" button silently doing nothing. Never validates `value` against a candidate list
 * itself (the caller/UI is expected to have sourced it from `missingAttributeConfig[].candidateValues`,
 * the real Salesforce AttributePicklistValue rows for that attribute) — it only performs the write(s) +
 * verification, exactly like every other create/update in this pipeline.
 */
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let productAttributeDefinitionId: string | undefined;
  let productId: string | undefined;
  let attributeDefinitionId: string | undefined;
  let productClassificationAttrId: string | undefined;
  let value: string | undefined;
  try {
    const body = await req.json();
    productAttributeDefinitionId = nonEmptyString(body.productAttributeDefinitionId);
    productId = nonEmptyString(body.productId);
    attributeDefinitionId = nonEmptyString(body.attributeDefinitionId);
    productClassificationAttrId = nonEmptyString(body.productClassificationAttrId);
    value = nonEmptyString(body.value);
    if (!value || (!productAttributeDefinitionId && !(productId && attributeDefinitionId && productClassificationAttrId))) {
      return NextResponse.json(
        { error: "A value is required, along with either productAttributeDefinitionId, or productId + attributeDefinitionId + productClassificationAttrId for an inherited attribute." },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await setEffectiveAttributeDefaultValue(client, {
      productAttributeDefinitionId: productAttributeDefinitionId ?? null,
      productId: productId ?? null,
      attributeDefinitionId: attributeDefinitionId ?? null,
      productClassificationAttrId: productClassificationAttrId ?? null,
      value,
    });
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error ?? "Update could not be verified." }, { status: 502 });
    }
    return NextResponse.json({ success: true, verifiedValue: result.verifiedValue, productAttributeDefinitionId: result.productAttributeDefinitionId });
  } catch (err) {
    if (err instanceof SalesforceError) {
      const bodyStr = JSON.stringify(err.body ?? "");
      if (err.status === 401 || bodyStr.includes("INVALID_SESSION_ID")) {
        return NextResponse.json({ error: "Your Salesforce session has expired. Please reconnect and try again.", code: "TOKEN_EXPIRED" }, { status: 401 });
      }
      return NextResponse.json({ success: false, error: `Salesforce request failed: ${err.message}` }, { status: 502 });
    }
    console.error("[pricing-rules/attribute-based/configure-attribute-default] Unhandled error:", err);
    return NextResponse.json({ success: false, error: "An unexpected error occurred while saving this attribute's default value." }, { status: 500 });
  }
}
