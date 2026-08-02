import type { SalesforceClient, DescribeResult } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField, findRequiredCreateableFields } from "@/lib/salesforce/describe";
import { resolveRealDefaultForField } from "@/lib/quotes/util/realDefaults";
import type { BillingPolicyAssignResult, BillingPolicyOption, BillingPolicyOptionsResult, BillingPolicyRecoveryResult, BillingTreatmentValidation } from "@/lib/quotes/types";

const INCONCLUSIVE: BillingTreatmentValidation = {
  outcome: "inconclusive",
  blocks: false,
  message: null,
  billingPolicyId: null,
  billingPolicyName: null,
  billingTreatmentId: null,
  billingTreatmentName: null,
  canChangeBillingFrequency: null,
  recoverable: false,
};

/**
 * Walk Product -> Billing Policy -> default Billing Treatment (§4.3) and
 * classify the result as either positively-confirmed-missing (blocks the
 * add, with a specific message) or inconclusive (a query failed, or the
 * concept doesn't exist as a resolvable field in this org — never blocks).
 */
export async function validateBillingTreatment(client: SalesforceClient, productId: string): Promise<BillingTreatmentValidation> {
  let productDescribe: DescribeResult;
  try {
    productDescribe = await describeObjectCached(client, "Product2");
  } catch {
    return INCONCLUSIVE;
  }

  const billingPolicyField = resolveField(productDescribe, "BillingPolicyId", /^billing policy$/i);
  if (!billingPolicyField) return INCONCLUSIVE; // Concept not present in this org's schema — can't positively confirm anything.

  let productRow: Record<string, unknown>;
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${billingPolicyField.name} FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`,
    );
    productRow = res.records[0] ?? {};
  } catch {
    return INCONCLUSIVE;
  }

  const billingPolicyId = productRow[billingPolicyField.name] as string | undefined;
  if (!billingPolicyId) {
    return {
      outcome: "no-billing-policy",
      blocks: true,
      message: "This product has no Billing Policy configured. Use the recovery flow to attach one before adding it to a quote.",
      billingPolicyId: null,
      billingPolicyName: null,
      billingTreatmentId: null,
      billingTreatmentName: null,
      canChangeBillingFrequency: null,
      recoverable: true,
    };
  }

  let policyDescribe: DescribeResult;
  try {
    policyDescribe = await describeObjectCached(client, "BillingPolicy");
  } catch {
    return INCONCLUSIVE;
  }
  const policyNameField = resolveField(policyDescribe, "Name", /^(billing policy )?name$/i)?.name ?? "Name";
  const policyActiveField = resolveField(policyDescribe, "IsActive", /^active$/i) ?? resolveField(policyDescribe, "Status", /^status$/i);
  const defaultTreatmentField = resolveField(policyDescribe, "DefaultBillingTreatmentId", /^default billing treatment$/i);
  if (!policyActiveField || !defaultTreatmentField) return INCONCLUSIVE;

  let policyRow: Record<string, unknown>;
  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${policyNameField}, ${policyActiveField.name}, ${defaultTreatmentField.name} FROM BillingPolicy WHERE Id = '${soqlEscape(billingPolicyId)}' LIMIT 1`,
    );
    policyRow = res.records[0] ?? {};
  } catch {
    return INCONCLUSIVE;
  }

  const billingPolicyName = (policyRow[policyNameField] as string) ?? null;
  const policyActiveRaw = policyRow[policyActiveField.name];
  const policyActive = typeof policyActiveRaw === "boolean" ? policyActiveRaw : /active/i.test(String(policyActiveRaw ?? ""));
  if (!policyActive) {
    return {
      outcome: "billing-policy-inactive",
      blocks: true,
      message: "The Billing Policy attached to this product is inactive in Salesforce. This is an org configuration issue, not an app defect.",
      billingPolicyId, billingPolicyName,
      billingTreatmentId: null, billingTreatmentName: null, canChangeBillingFrequency: null,
      recoverable: false,
    };
  }

  const billingTreatmentId = policyRow[defaultTreatmentField.name] as string | undefined;
  if (!billingTreatmentId) {
    return {
      outcome: "no-default-treatment",
      blocks: true,
      message: "The Billing Policy for this product has no default Billing Treatment set. This is an org configuration issue.",
      billingPolicyId, billingPolicyName,
      billingTreatmentId: null, billingTreatmentName: null, canChangeBillingFrequency: null,
      recoverable: false,
    };
  }

  let treatmentDescribe: DescribeResult;
  try {
    treatmentDescribe = await describeObjectCached(client, "BillingTreatment");
  } catch {
    return INCONCLUSIVE;
  }
  const treatmentNameField = resolveField(treatmentDescribe, "Name", /^(billing treatment )?name$/i)?.name ?? "Name";
  const treatmentActiveField = resolveField(treatmentDescribe, "IsActive", /^active$/i) ?? resolveField(treatmentDescribe, "Status", /^status$/i);
  // §CanChangeBillingFrequency resolution: the PREVIOUS fallback here
  // (`findReferenceFieldByLabel(treatmentDescribe, /frequency/i)`) searched
  // for a REFERENCE-typed field matching "frequency" — nonsensical for what
  // is a boolean/checkbox concept, and would either match nothing or (worse)
  // silently match an unrelated reference field. Broadened the label
  // patterns instead and gated on the field actually being boolean-typed —
  // never trust a same-ish-labeled field of the wrong type.
  const canChangeFrequencyFieldCandidate =
    resolveField(treatmentDescribe, "CanChangeBillingFrequency", /can (the )?billing frequency (be )?chang|allow.*(billing )?frequency (change|override)|frequency.*(change|override)\s*allowed/i);
  const canChangeFrequencyField = canChangeFrequencyFieldCandidate?.type === "boolean" ? canChangeFrequencyFieldCandidate : null;
  if (!treatmentActiveField) return INCONCLUSIVE;

  let treatmentRow: Record<string, unknown>;
  try {
    const selectFields = [treatmentNameField, treatmentActiveField.name, ...(canChangeFrequencyField ? [canChangeFrequencyField.name] : [])];
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM BillingTreatment WHERE Id = '${soqlEscape(billingTreatmentId)}' LIMIT 1`,
    );
    treatmentRow = res.records[0] ?? {};
  } catch {
    return INCONCLUSIVE;
  }

  const billingTreatmentName = (treatmentRow[treatmentNameField] as string) ?? null;
  const canChangeBillingFrequency = canChangeFrequencyField ? (treatmentRow[canChangeFrequencyField.name] as boolean) : null;

  const treatmentActiveRaw = treatmentRow[treatmentActiveField.name];
  const treatmentActive = typeof treatmentActiveRaw === "boolean" ? treatmentActiveRaw : /active/i.test(String(treatmentActiveRaw ?? ""));
  if (!treatmentActive) {
    return {
      outcome: "billing-treatment-inactive",
      blocks: true,
      message: "The default Billing Treatment for this product's Billing Policy is inactive. This is an org configuration issue.",
      billingPolicyId, billingPolicyName, billingTreatmentId, billingTreatmentName, canChangeBillingFrequency,
      recoverable: false,
    };
  }

  // §CanChangeBillingFrequency = false is NOT itself a reason to block —
  // it only matters if the line item's billing frequency actually needs to
  // differ from the Selling Model's own naturally-resolved cadence (which is
  // exactly what the add flow defaults it to). A fixed-cadence Term product
  // (e.g. a 12-month license) legitimately has this set intentionally, not
  // as misconfiguration — blocking it outright here previously made every
  // such product unaddable. The real, narrower check (does the value being
  // SENT actually mismatch the natural cadence?) happens later, immediately
  // before create, in lineItemCreate.ts/orderItemCreate.ts's own "Verify
  // Billing Treatment" step — this function just carries the flag through.
  return {
    outcome: "ok", blocks: false, message: null,
    billingPolicyId, billingPolicyName, billingTreatmentId, billingTreatmentName, canChangeBillingFrequency,
    recoverable: false,
  };
}

/**
 * Automatic recovery for the single positively-fixable outcome
 * ("no-billing-policy"): reuse an existing active Billing Policy +
 * Treatment if one fits, else create new records using only real
 * org-derived defaults — never a fabricated value (§2.3, §4.3).
 */
export async function recoverBillingPolicy(client: SalesforceClient, productId: string): Promise<BillingPolicyRecoveryResult> {
  let policyDescribe: DescribeResult, treatmentDescribe: DescribeResult, productDescribe: DescribeResult;
  try {
    [policyDescribe, treatmentDescribe, productDescribe] = await Promise.all([
      describeObjectCached(client, "BillingPolicy"),
      describeObjectCached(client, "BillingTreatment"),
      describeObjectCached(client, "Product2"),
    ]);
  } catch {
    return { success: false, billingPolicyId: null, billingTreatmentId: null, createdNew: false, unresolvedField: "BillingPolicy/BillingTreatment", message: "Billing Policy/Treatment objects are not available in this org." };
  }

  const billingPolicyField = resolveField(productDescribe, "BillingPolicyId", /^billing policy$/i);
  if (!billingPolicyField) {
    return { success: false, billingPolicyId: null, billingTreatmentId: null, createdNew: false, unresolvedField: "Product2.BillingPolicyId", message: "Product2 has no resolvable Billing Policy field." };
  }

  const policyActiveField = resolveField(policyDescribe, "IsActive", /^active$/i);
  const defaultTreatmentField = resolveField(policyDescribe, "DefaultBillingTreatmentId", /^default billing treatment$/i);
  const treatmentActiveField = resolveField(treatmentDescribe, "IsActive", /^active$/i);

  // 1. Reuse an existing active Billing Policy that already has an active default treatment.
  if (policyActiveField && defaultTreatmentField && treatmentActiveField) {
    try {
      const existing = await client.query<Record<string, unknown>>(
        `SELECT Id, ${defaultTreatmentField.name} FROM BillingPolicy WHERE ${policyActiveField.name} = true AND ${defaultTreatmentField.name} != null LIMIT 1`,
      );
      if (existing.records[0]) {
        const policyId = existing.records[0].Id as string;
        const treatmentId = existing.records[0][defaultTreatmentField.name] as string;
        await client.updateRecord("Product2", productId, { [billingPolicyField.name]: policyId });
        return { success: true, billingPolicyId: policyId, billingTreatmentId: treatmentId, createdNew: false, unresolvedField: null, message: "Reused an existing active Billing Policy and attached it to the product." };
      }
    } catch {
      /* fall through to creation */
    }
  }

  // 2. Create new Billing Policy + Treatment from real org-derived defaults only.
  const requiredPolicyFields = findRequiredCreateableFields(policyDescribe).filter(f => f.name !== "Name");
  const requiredTreatmentFields = findRequiredCreateableFields(treatmentDescribe).filter(f => f.name !== "Name");

  const policyPayload: Record<string, unknown> = { Name: "Auto-Recovered Billing Policy" };
  for (const field of requiredPolicyFields) {
    const value = await resolveRealDefaultForField(client, "BillingPolicy", field.name, field.type, field.picklistValues);
    if (value === undefined) {
      return { success: false, billingPolicyId: null, billingTreatmentId: null, createdNew: false, unresolvedField: `BillingPolicy.${field.name}`, message: `Could not resolve a real value for required field BillingPolicy.${field.name} — refusing to fabricate one.` };
    }
    policyPayload[field.name] = value;
  }

  const treatmentPayload: Record<string, unknown> = { Name: "Auto-Recovered Billing Treatment" };
  for (const field of requiredTreatmentFields) {
    const value = await resolveRealDefaultForField(client, "BillingTreatment", field.name, field.type, field.picklistValues);
    if (value === undefined) {
      return { success: false, billingPolicyId: null, billingTreatmentId: null, createdNew: false, unresolvedField: `BillingTreatment.${field.name}`, message: `Could not resolve a real value for required field BillingTreatment.${field.name} — refusing to fabricate one.` };
    }
    treatmentPayload[field.name] = value;
  }
  if (treatmentActiveField) treatmentPayload[treatmentActiveField.name] = true;

  try {
    const treatmentResult = await client.createRecord("BillingTreatment", treatmentPayload);
    if (policyActiveField) policyPayload[policyActiveField.name] = true;
    if (defaultTreatmentField) policyPayload[defaultTreatmentField.name] = treatmentResult.id;
    const policyResult = await client.createRecord("BillingPolicy", policyPayload);
    await client.updateRecord("Product2", productId, { [billingPolicyField.name]: policyResult.id });
    return { success: true, billingPolicyId: policyResult.id, billingTreatmentId: treatmentResult.id, createdNew: true, unresolvedField: null, message: "Created a new Billing Policy and Treatment from org-derived defaults and attached them to the product." };
  } catch (err) {
    return { success: false, billingPolicyId: null, billingTreatmentId: null, createdNew: false, unresolvedField: null, message: err instanceof Error ? err.message : "Billing policy recovery failed." };
  }
}

/**
 * §Fix Billing Policy / Billing Treatment Recovery: list the org's own real
 * Billing Policies so the user can pick one explicitly, instead of the app
 * silently reusing or fabricating one (§2.3 — never guess which policy is
 * "right" for a product; that's a business decision only a real admin-
 * configured association or an explicit user choice can make).
 */
export async function listAvailableBillingPolicies(client: SalesforceClient): Promise<BillingPolicyOptionsResult> {
  let policyDescribe: DescribeResult;
  try {
    policyDescribe = await describeObjectCached(client, "BillingPolicy");
  } catch {
    return { policies: [], orgSetupUrl: `${client.instanceUrl}/lightning/o/BillingPolicy/home` };
  }

  const nameField = resolveField(policyDescribe, "Name", /^(billing policy )?name$/i)?.name ?? "Name";
  const policyActiveField = resolveField(policyDescribe, "IsActive", /^active$/i);
  const defaultTreatmentField = resolveField(policyDescribe, "DefaultBillingTreatmentId", /^default billing treatment$/i);

  const selectFields = ["Id", nameField, ...(defaultTreatmentField ? [defaultTreatmentField.name] : [])];
  const whereActive = policyActiveField ? `WHERE ${policyActiveField.name} = true` : "";

  try {
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${selectFields.join(", ")} FROM BillingPolicy ${whereActive} ORDER BY ${nameField} LIMIT 200`,
    );
    const policies: BillingPolicyOption[] = res.records.map(r => ({
      id: r.Id as string,
      name: (r[nameField] as string) ?? (r.Id as string),
      hasDefaultTreatment: defaultTreatmentField ? !!r[defaultTreatmentField.name] : false,
    }));
    return { policies, orgSetupUrl: `${client.instanceUrl}/lightning/o/BillingPolicy/home` };
  } catch {
    return { policies: [], orgSetupUrl: `${client.instanceUrl}/lightning/o/BillingPolicy/home` };
  }
}

/**
 * Assign a user-chosen Billing Policy to a product, then immediately
 * re-resolve Billing Treatment for it (§Re-resolve Billing Treatment) so the
 * caller learns right away whether that choice actually clears the block —
 * never assumed to have worked just because the write succeeded. Re-verifies
 * the given Id is a real, currently-active BillingPolicy before writing it —
 * never trusts a client-supplied Id blindly.
 */
export async function assignBillingPolicyToProduct(client: SalesforceClient, productId: string, billingPolicyId: string): Promise<BillingPolicyAssignResult> {
  let productDescribe: DescribeResult, policyDescribe: DescribeResult;
  try {
    [productDescribe, policyDescribe] = await Promise.all([
      describeObjectCached(client, "Product2"),
      describeObjectCached(client, "BillingPolicy"),
    ]);
  } catch {
    return { success: false, message: "Product2/BillingPolicy objects are not available in this org.", billingTreatment: INCONCLUSIVE };
  }

  const billingPolicyField = resolveField(productDescribe, "BillingPolicyId", /^billing policy$/i);
  if (!billingPolicyField) {
    return { success: false, message: "Product2 has no resolvable Billing Policy field.", billingTreatment: INCONCLUSIVE };
  }

  const policyActiveField = resolveField(policyDescribe, "IsActive", /^active$/i);
  try {
    const check = await client.query<Record<string, unknown>>(
      `SELECT Id${policyActiveField ? `, ${policyActiveField.name}` : ""} FROM BillingPolicy WHERE Id = '${soqlEscape(billingPolicyId)}' LIMIT 1`,
    );
    const row = check.records[0];
    if (!row) return { success: false, message: `Billing Policy ${billingPolicyId} does not exist.`, billingTreatment: INCONCLUSIVE };
    if (policyActiveField) {
      const activeRaw = row[policyActiveField.name];
      const active = typeof activeRaw === "boolean" ? activeRaw : /active/i.test(String(activeRaw ?? ""));
      if (!active) return { success: false, message: "That Billing Policy is not active in Salesforce.", billingTreatment: INCONCLUSIVE };
    }
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Failed to verify the selected Billing Policy.", billingTreatment: INCONCLUSIVE };
  }

  try {
    await client.updateRecord("Product2", productId, { [billingPolicyField.name]: billingPolicyId });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Failed to assign the Billing Policy to this product.", billingTreatment: INCONCLUSIVE };
  }

  const billingTreatment = await validateBillingTreatment(client, productId);
  return {
    success: !billingTreatment.blocks,
    message: billingTreatment.blocks
      ? `Billing Policy assigned, but Billing Treatment still can't be resolved: ${billingTreatment.message ?? billingTreatment.outcome}.`
      : "Billing Policy assigned and Billing Treatment resolved successfully.",
    billingTreatment,
  };
}
