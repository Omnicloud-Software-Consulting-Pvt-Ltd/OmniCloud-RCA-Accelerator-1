/**
 * §Autopilot-only client-side translation of a create-procedure failure.
 * Deliberately imports ONLY the `CreateProcedureFailure` type (erased at
 * build time) — never `errorDiagnostics.ts`'s runtime helpers, which pull
 * in `SalesforceError` from lib/salesforce/client.ts and have no business
 * being bundled into client code.
 *
 * For a native-object failure, `failure.salesforceErrorMessage` is now a
 * real schema diagnosis (see nativeSchemaResolver.ts's `formatSchemaDiagnosis`
 * — every required field, whether it's a lookup, which target this create
 * call actually attempted to resolve for it, and exactly why the value
 * never landed in the payload), never a raw JSON payload or Salesforce
 * response body dump — those stay Debug-Mode-log-only (see
 * nativeAttributeRecords.ts's `guardedCreate`). Shown verbatim rather than
 * collapsed into a generic "a required field couldn't be resolved"
 * sentence, since the diagnosis IS the plain-language explanation, not an
 * internal implementation detail.
 *
 * §E — every failure is classified into one of a small set of DISTINCT
 * categories (Condition Creation Failed / Adjustment Creation Failed / XML
 * Generation Failed / XML Validation Failed / Metadata Uniqueness Failed /
 * Metadata Deployment Failed / Deployment Verification Failed / ...) using
 * `failure.step`/`failure.object`/`failure.operation` — never collapsed into
 * a single generic "This step didn't complete" sentence, which used to be
 * the message shown for every one of these except an actual native-object
 * create() rejection.
 */
import type { CreateProcedureFailure } from "@/lib/pricing-rules/types";

export interface FriendlyStopMessage {
  title: string;
  message: string;
  guidance: string;
}

const FRIENDLY_STEP_TITLES: Record<string, string> = {
  "Product Lookup": "Autopilot couldn't find the product",
  "Fetch Selling Model": "Autopilot couldn't determine the selling model",
  "Selling Model Lookup": "Autopilot couldn't determine the selling model",
  "Attribute Discovery": "Autopilot couldn't discover this product's attributes",
  "Lookup Table Creation": "Autopilot couldn't resolve the attribute lookup table",
  "Activate Pricing Procedure": "Autopilot deployed the procedure but couldn't activate it",
  "Runtime Verification": "Autopilot couldn't verify the deployed pricing procedure",
  "Row validation": "Autopilot couldn't find anything to create",
  "PriceAdjustmentSchedule": "Autopilot couldn't prepare the Price Adjustment Schedule",
  "AttributeBasedAdjRule": "Autopilot couldn't prepare the Attribute Rule",
};

/** §E — one of the DISTINCT failure categories the UI must never collapse together. */
export type FriendlyFailureCategory =
  | "condition" | "adjustment" | "xml-generation" | "xml-validation"
  | "uniqueness" | "deployment" | "deployment-verification" | "other";

/**
 * Classifies a `CreateProcedureFailure` into exactly one of §E's distinct categories, using
 * `object`/`operation`/`step` (never just `step` alone — several genuinely different failures share the
 * same outer step name, e.g. "Expression Set Generation" covers both Template Retrieval/XML Generation
 * AND XML Validation, and "Deploy Metadata" covers both the pre-flight uniqueness check, the actual
 * Metadata API deploy, and the post-deploy query-back verification).
 */
export function classifyFriendlyFailure(failure: CreateProcedureFailure): FriendlyFailureCategory {
  const step = failure.step ?? "";
  const object = failure.object ?? "";
  const operation = failure.operation ?? "";

  if (operation === "POST_DEPLOY_UNIQUENESS_CONFLICT") return "uniqueness";
  if (operation.startsWith("Uniqueness Validation")) return "uniqueness";
  if (step === "Deploy Metadata") {
    if (operation === "Verify (query-back)") return "deployment-verification";
    return "deployment";
  }
  if (object === "ExpressionSet" && operation === "Verify (query-back)") return "deployment-verification";
  if (step === "Expression Set Generation") {
    if (operation.startsWith("Validate XML")) return "xml-validation";
    return "xml-generation"; // "Retrieve Template Expression Set (...)" or "Build Expression Set XML (...)"
  }
  if (object === "AttributeAdjustmentCondition") return "condition";
  if (object === "AttributeBasedAdjustment") return "adjustment";
  return "other";
}

const CATEGORY_TITLES: Record<Exclude<FriendlyFailureCategory, "other">, string> = {
  condition: "Condition Creation Failed",
  adjustment: "Adjustment Creation Failed",
  "xml-generation": "XML Generation Failed",
  "xml-validation": "XML Validation Failed",
  uniqueness: "Metadata Uniqueness Failed",
  deployment: "Metadata Deployment Failed",
  "deployment-verification": "Deployment Verification Failed",
};

export function buildFriendlyStopMessage(failure: CreateProcedureFailure): FriendlyStopMessage {
  const category = classifyFriendlyFailure(failure);

  const nf = failure.nativeCreateFailure;
  if (nf) {
    return {
      title: category !== "other" ? CATEGORY_TITLES[category] : (FRIENDLY_STEP_TITLES[nf.objectName] ?? `Autopilot couldn't prepare the ${nf.objectName} step`),
      message: failure.salesforceErrorMessage ?? `A required field on ${nf.objectName} couldn't be resolved automatically from your Salesforce org, so nothing was created.`,
      guidance: `Verify ${nf.objectName}'s configuration in Salesforce Setup — its required fields, field-level security for the connected user, and its relationships to other objects may not match what Autopilot expects. Turn on Debug Mode for the complete Describe response.`,
    };
  }

  if (category !== "other") {
    return {
      title: CATEGORY_TITLES[category],
      // §E — the real reason, verbatim, never the generic "This step didn't complete" sentence. `reason`
      // is already plain-language for every one of these categories (a schema diagnosis, a structural
      // XML comparison summary, the combined pre-flight/deployment uniqueness diagnosis, or the raw
      // Salesforce deploy/verify error).
      message: failure.reason || "This step failed, but no further detail was captured — see Debug Mode.",
      guidance: failure.resolutionHint,
    };
  }

  const title = FRIENDLY_STEP_TITLES[failure.step] ?? `Autopilot couldn't complete "${failure.step}"`;
  return {
    title,
    message: failure.reason || "This step didn't complete, so nothing was created.",
    guidance: failure.resolutionHint,
  };
}
