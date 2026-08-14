import { NextRequest, NextResponse } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION, IMPLEMENTED_PRICING_TYPES, PRICING_TYPE_LABELS } from "@/lib/pricing-rules/types";
import type { ProcedurePayload, ProcedureStep, SalesforceCreationResult, CreateProcedureFailure, DeploymentContext, ProductAttributeData, CreateProcedureStreamEvent } from "@/lib/pricing-rules/types";
import { buildAttributeCanvas, type CanvasBuildResult } from "@/lib/pricing-rules/metadata/canvasBuilder";
import { deployExpressionSetDefinition, type DeployExpressionSetResult } from "@/lib/pricing-rules/metadata/deploy";
import { refreshListPriceDecisionTable } from "@/lib/pricing-rules/metadata/decisionTableRefresh";
import { createNativeAttributePricing, normalizeAttributeEntries, filterValidPricingRows, type NormalizedAttributeEntry } from "@/lib/pricing-rules/salesforce/nativeAttributeRecords";
import { resolveProduct2ByName, resolveSellingModelForProduct } from "@/lib/pricing-rules/salesforce/productLookup";
import { discoverProductAttributes, ProductAttributeAuthError, ProductNotFoundError } from "@/lib/pricing-rules/salesforce/productAttributeDiscovery";
import { buildFailureDiagnostics, buildLogicalFailure, classifyCanvasFailureStep } from "@/lib/pricing-rules/salesforce/errorDiagnostics";
import { findExistingScheduleForProduct } from "@/lib/pricing-rules/salesforce/existingAttributePricing";
import { verifyAttributeExecution } from "@/lib/pricing-rules/salesforce/verifyExecution";
import {
  validateExpressionSetUniquenessAgainstOrg, OrgUniquenessConflictError, diagnosePostDeployFailure,
  type OrgUniquenessResult,
} from "@/lib/pricing-rules/salesforce/orgUniquenessValidation";
import {
  runWorkflow, verifyRecordExists, extractSalesforceError,
  type WorkflowStepDefinition, type WorkflowStepFailure, type VerifyOutcome,
} from "@/lib/pricing-rules/salesforce/workflowRunner";

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

function toApiName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withLetterStart = /^[A-Za-z]/.test(cleaned) ? cleaned : `Procedure_${cleaned}`;
  return withLetterStart.slice(0, 80) || `Procedure_${Date.now()}`;
}

function buildFailureResult(
  steps: ProcedureStep[], warnings: string[], failure: CreateProcedureFailure, client: SalesforceClient, debug: boolean,
  extra?: Partial<SalesforceCreationResult>,
): SalesforceCreationResult {
  return {
    success: false, steps, warnings, error: failure.reason, failure,
    debugLog: debug ? client.debugLog : undefined,
    ...extra,
  } satisfies SalesforceCreationResult;
}

/** Translates the generic runner's `WorkflowStepFailure` into this endpoint's existing `CreateProcedureFailure` shape — the new object/operation/salesforceId/lastSuccessfulStep fields flow straight through; `reason`/`resolutionHint`/`httpStatus`/`salesforceErrorCode`/`salesforceErrorMessage` reuse the same vocabulary every other failure on this endpoint already uses. */
function workflowFailureToCreateProcedureFailure(f: WorkflowStepFailure, extra?: Partial<CreateProcedureFailure>): CreateProcedureFailure {
  return {
    ...buildLogicalFailure(
      f.step,
      f.reason,
      `Salesforce ${f.operation} (${f.object})`,
      {
        httpStatus: f.salesforceError?.httpStatus,
        salesforceErrorCode: f.salesforceError?.errorCode,
        salesforceErrorMessage: f.salesforceError?.message,
      },
    ),
    object: f.object,
    operation: f.operation,
    salesforceId: f.salesforceId,
    lastSuccessfulStep: f.lastSuccessfulStep,
    ...extra,
  };
}

// POST /api/pricing-rules/create-procedure — dispatches on pricingType.
// Only "attribute-based" has a real, spec-verified deploy engine (§8) —
// every other type returns a structured "not implemented" response rather
// than deploying guessed Salesforce metadata (see the plan's scope note).
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let payload: ProcedurePayload;
  let debug = false;
  try {
    ({ payload, debug } = await req.json());
    debug = debug === true;
    if (!payload?.procedureName?.trim() || !payload?.pricingType) {
      return NextResponse.json({ error: "procedureName and pricingType are required" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!IMPLEMENTED_PRICING_TYPES.includes(payload.pricingType)) {
    const result: SalesforceCreationResult = {
      success: false,
      notImplemented: true,
      steps: [],
      warnings: [],
      error: `${PRICING_TYPE_LABELS[payload.pricingType]} pricing doesn't have a verified Salesforce deploy path yet — only Attribute-Based pricing is wired to a real Expression Set deploy in this build.`,
    };
    return NextResponse.json(result, { status: 501 });
  }

  const steps: ProcedureStep[] = [];
  const warnings: string[] = [];

  if (!payload.productName?.trim()) return NextResponse.json({ error: "productName is required" }, { status: 400 });

  // ── §Row validation — the very first gate, before ANY Salesforce call (not even Product Lookup):
  // attribute-based pricing must have at least one VALID pricing row (real Attribute Value + selected
  // Adjustment Type + a meaningful Adjustment Amount) before this request is allowed to touch
  // Salesforce at all. This is a local data-validation failure, not a deployment failure — it gets its
  // own response shape (`validationError: true`) so callers never confuse the two.
  if (payload.pricingType === "attribute-based" && !payload.allowReuseExistingSchedule) {
    const { valid } = filterValidPricingRows(normalizeAttributeEntries(payload.attributeEntries ?? []));
    if (valid.length === 0) {
      const result: SalesforceCreationResult = {
        success: false,
        validationError: true,
        steps: [],
        warnings: [],
        error: "No valid attribute pricing rules have been configured. Configure at least one priced attribute value before creating the pricing procedure.",
      };
      return NextResponse.json(result, { status: 400 });
    }
  }

  // ── §Sequential Workflow — from here on, the pipeline genuinely runs one step at a time and this
  // streams that truthfully to the client as NDJSON: one "step" line per checklist row the instant it
  // actually starts/finishes/fails (see workflowRunner.ts's runWorkflow hooks and the onProgress
  // callbacks threaded into createNativeAttributePricing/buildAttributeCanvas), followed by exactly one
  // "result" line carrying the same SalesforceCreationResult shape this endpoint used to return as a
  // single JSON response. Everything before this point (auth/body/not-implemented/row-validation) is a
  // fast synchronous rejection with no pipeline work done yet, so it stays a plain, immediately-resolved
  // JSON response with its own real HTTP status — only the actual pipeline execution streams.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (evt: CreateProcedureStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(evt)}\n`));
      let result: SalesforceCreationResult;
      try {
        result = await runCreateProcedurePipeline(client, payload, steps, warnings, debug, emit);
      } catch (err) {
        // Last-resort net: every expected failure mode inside the pipeline already reports its own
        // precisely-attributed diagnostics — this only catches a genuine bug, so it can't name a
        // specific step with confidence.
        const failure = buildFailureDiagnostics("Unhandled", err);
        step(steps, "unhandled-error", "error", failure.reason);
        result = buildFailureResult(steps, warnings, failure, client, debug);
      }
      emit({ type: "result", result });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

/**
 * §Sequential Workflow — the 12-stage Attribute-Based Pricing Autopilot state machine
 * (see lib/pricing-rules/salesforce/workflowRunner.ts). Every stage below is one
 * `WorkflowStepDefinition` with an explicit Execute -> Verify -> Commit Context phase; `runWorkflow`
 * runs them strictly in array order, one at a time, and stops at the very first failure — there is no
 * Promise.all/parallel execution anywhere in this pipeline. `ctx` is the single shared, mutable
 * pipeline context every step reads from and writes to; nothing is re-derived independently by a later
 * step once an earlier one has already resolved it.
 *
 * Steps 5-8 (Price Adjustment Schedule / AttributeBasedAdjRule / AttributeAdjustmentCondition /
 * AttributeBasedAdjustment) are represented as ONE step definition whose single Execute call is
 * `createNativeAttributePricing` — that function is ALREADY its own fully sequential,
 * query-back-verified, stop-on-first-failure state machine internally (built up over several prior
 * hardening passes: typed value-field resolution, price-impacting eligibility, schema diagnosis).
 * Decomposing it into 4 independently re-invokable functions would require a much larger, riskier
 * rewrite of that already-battle-tested logic for no behavioral gain — it already satisfies "never
 * start object N+1 until object N is verified." This step's Verify phase inspects its result and maps
 * a failure to the EXACT sub-object that broke (via `firstFailure`/`executionReport`), including which
 * of the 4 sub-stages was the actual `lastSuccessfulStep` — so failure reporting stays exactly as
 * granular as if they were 4 separate outer steps.
 */
interface AttrWorkflowContext {
  product?: { id: string; name: string };
  sellingModelId?: string;
  deploymentContext?: DeploymentContext;
  discoveredAttributes?: ProductAttributeData;
  native?: Awaited<ReturnType<typeof createNativeAttributePricing>>;
  reusedScheduleId?: string;
  canvas?: CanvasBuildResult;
  /** §Pre-flight, never authoritative — captured for comparison against a real deploy failure below, never treated as a guarantee that deployment will succeed. */
  orgUniquenessPreflight?: OrgUniquenessResult;
  deployResult?: DeployExpressionSetResult;
  procedureId?: string;
  versionId?: string;
  versionStatus?: "Draft" | "Active";
  verifyResult?: Awaited<ReturnType<typeof verifyAttributeExecution>>;
}

const NATIVE_OBJECT_STEP_NAME: Record<string, string> = {
  PriceAdjustmentSchedule: "Price Adjustment Schedule",
  AttributeBasedAdjRule: "AttributeBasedAdjRule",
  AttributeAdjustmentCondition: "AttributeAdjustmentCondition",
  AttributeBasedAdjustment: "AttributeBasedAdjustment",
};
/** The step immediately BEFORE each native object in the 5-6-7-8 sequence — used to name the exact `lastSuccessfulStep` when the combined native-records step fails partway through. */
const NATIVE_OBJECT_PRECEDING_STEP: Record<string, string | undefined> = {
  AttributeBasedAdjRule: "Price Adjustment Schedule",
  AttributeAdjustmentCondition: "AttributeBasedAdjRule",
  AttributeBasedAdjustment: "AttributeAdjustmentCondition",
};

/** §Sequential Workflow — maps a native-object name (as reported by createNativeAttributePricing's
 * own onProgress) onto the checklist row it lives under (DeploymentProgressPanel.tsx). */
const NATIVE_OBJECT_UI_ROW: Record<string, string> = {
  PriceAdjustmentSchedule: "Price Adjustment Schedule Created",
  AttributeBasedAdjRule: "Attribute Rules Created",
  AttributeAdjustmentCondition: "Attribute Conditions Created",
  AttributeBasedAdjustment: "Attribute Adjustments Created",
};

async function runCreateProcedurePipeline(
  client: SalesforceClient,
  payload: ProcedurePayload,
  steps: ProcedureStep[],
  warnings: string[],
  debug: boolean,
  emit: (evt: CreateProcedureStreamEvent) => void,
): Promise<SalesforceCreationResult> {
  const apiName = payload.apiName?.trim() || toApiName(payload.procedureName);
  const { valid: validEntries, warnings: rowWarnings } = filterValidPricingRows(normalizeAttributeEntries(payload.attributeEntries ?? []));
  warnings.push(...rowWarnings);

  const ctx: AttrWorkflowContext = {};
  const defs: WorkflowStepDefinition<AttrWorkflowContext, unknown>[] = [];
  // Infers TResult from each step definition's own literal shape (execute's real return type) before
  // erasing it to `unknown` for storage — pushing a typed literal directly into a
  // `WorkflowStepDefinition<Ctx, unknown>[]` would otherwise force every step's execute/verify/commit
  // callback parameters to widen to `unknown` via contextual typing, defeating type-checking entirely.
  function pushStep<TResult>(d: WorkflowStepDefinition<AttrWorkflowContext, TResult>): void {
    defs.push(d as unknown as WorkflowStepDefinition<AttrWorkflowContext, unknown>);
  }

  // ── 1. Product Lookup ──
  pushStep({
    name: "Product Lookup",
    execute: async () => (
      payload.productId
        ? { id: payload.productId, name: payload.productName, productCode: payload.productCode ?? "", isActive: true, currencyIsoCode: payload.currency ?? null }
        : await resolveProduct2ByName(client, payload.productName)
    ),
    verify: async (_ctx, result): Promise<VerifyOutcome> => {
      if (!result) {
        return { ok: false, failure: { object: "Product2", operation: "Query", salesforceId: null, reason: `Product "${payload.productName}" was not found in Salesforce.` } };
      }
      const exists = await verifyRecordExists(client, "Product2", result.id);
      if (!exists) {
        return { ok: false, failure: { object: "Product2", operation: "Verify (query-back)", salesforceId: result.id, reason: `Product2 ${result.id} was resolved, but querying it back found no matching record.` } };
      }
      return { ok: true };
    },
    commit: (c, result) => { c.product = { id: result!.id, name: result!.name }; },
    classifyExecuteError: () => ({ object: "Product2", operation: "Query" }),
  });

  // ── 2. Selling Model Lookup ──
  pushStep({
    name: "Selling Model Lookup",
    execute: async (c) => (
      payload.sellingModelId ? { id: payload.sellingModelId, name: "" } : await resolveSellingModelForProduct(client, c.product!.id)
    ),
    verify: async (_c, result): Promise<VerifyOutcome> => {
      if (!result?.id) {
        return { ok: false, failure: { object: "ProductSellingModel", operation: "Query", salesforceId: null, reason: "No Product Selling Model is configured for this product." } };
      }
      const exists = await verifyRecordExists(client, "ProductSellingModel", result.id);
      if (!exists) {
        return { ok: false, failure: { object: "ProductSellingModel", operation: "Verify (query-back)", salesforceId: result.id, reason: `ProductSellingModel ${result.id} was resolved, but querying it back found no matching record.` } };
      }
      return { ok: true };
    },
    commit: (c, result) => {
      c.sellingModelId = result!.id;
      // §DeploymentContext — resolved exactly once, right after Product Discovery (Steps 1-2) succeed.
      // Every native record creation function downstream receives this SAME object and reads
      // ProductId/SellingModelId from it — none of them re-resolves or re-derives ProductId independently.
      c.deploymentContext = {
        productId: c.product!.id,
        productName: c.product!.name,
        productCode: payload.productCode,
        sellingModelId: result!.id,
        currency: payload.currency,
        effectiveFrom: payload.effectiveFrom,
        effectiveTo: payload.effectiveTo,
        basePrice: payload.basePrice,
      };
    },
    classifyExecuteError: () => ({ object: "ProductSellingModel", operation: "Query" }),
  });

  // ── 3. Attribute Discovery ──
  pushStep({
    name: "Attribute Discovery",
    execute: async (c) => {
      // §REQUEST_LIMIT_EXCEEDED remediation: both the guided flow and
      // Autopilot's discovery pass already ran this exact ~15-30-call
      // pipeline for this exact product before the user ever reached the
      // confirm step — reuse that result instead of re-running it.
      // Correctness is unaffected: verify() below validates attributeEntries
      // against `data.attributes` identically either way, and a caller with
      // no (or a distrusted) discovery result simply omits this, falling
      // straight back through to a fresh discovery exactly as before.
      if (payload.discoveredAttributes && payload.discoveredAttributes.product.id === c.product!.id) {
        console.log(`[sf-debug] endpoint=/api/pricing-rules/create-procedure caller=discoverProductAttributes status=REUSED (attribute discovery already provided by caller for product ${c.product!.id}) — Salesforce round trip skipped.`);
        return payload.discoveredAttributes;
      }
      const { data } = await discoverProductAttributes(client, c.product!.name, c.product!.id);
      return data;
    },
    verify: async (_c, data): Promise<VerifyOutcome> => {
      // Nothing new to validate against when there are zero new pricing rows (the reuse-existing-schedule
      // path) — Attribute Discovery still runs (Retrieve ProductAttributeDefinitions/AttributeDefinitions/
      // List Price), but there's no prompt-referenced attribute list to check here.
      for (const entry of validEntries) {
        const attr = data.attributes.find(a => a.name === entry.attributeName);
        if (!attr) {
          return {
            ok: false,
            failure: {
              object: "AttributeDefinition", operation: "Validate", salesforceId: null,
              reason: `"${entry.attributeName}" does not match any AttributeDefinition discovered for this product. Known attributes: [${data.attributes.map(a => a.name).join(", ") || "(none discovered)"}].`,
            },
          };
        }
        if (!attr.values.some(v => v.value === entry.attributeValue)) {
          return {
            ok: false,
            failure: {
              object: "AttributeDefinition", operation: "Validate", salesforceId: attr.id,
              reason: `"${entry.attributeValue}" is not a known value for attribute "${entry.attributeName}". Known values: [${attr.values.map(v => v.value).join(", ") || "(none discovered)"}].`,
            },
          };
        }
      }
      return { ok: true };
    },
    commit: (c, data) => { c.discoveredAttributes = data; },
    classifyExecuteError: (err) => ({
      object: err instanceof ProductNotFoundError ? "Product2" : "AttributeDefinition",
      operation: err instanceof ProductAttributeAuthError ? "Query (session expired)" : "Query",
    }),
  });

  // ── 4. Lookup Table Creation (or reuse) ── — there is no separate Salesforce object for this in this
  // build (confirmed via schema investigation in an earlier hardening pass): the deployed
  // AttributeDiscount step binds to a PriceAdjustmentSchedule GENERICALLY via a runtime context
  // variable, resolved by whatever caller executes the procedure passing the real Schedule Id (see
  // simulationContext below). This step verifies that architecture decision rather than fabricating a
  // Lookup Table object that doesn't exist on this org.
  pushStep({
    name: "Lookup Table Creation",
    execute: async () => null,
    verify: async (): Promise<VerifyOutcome> => ({ ok: true }),
    commit: () => {},
  });

  // ── 5-8. Price Adjustment Schedule / AttributeBasedAdjRule / AttributeAdjustmentCondition /
  // AttributeBasedAdjustment (or reuse an existing schedule when there are no new pricing rows) ──
  if (validEntries.length > 0) {
    pushStep({
      name: "Native Attribute Records (Price Adjustment Schedule / AttributeBasedAdjRule / AttributeAdjustmentCondition / AttributeBasedAdjustment)",
      execute: async (c) => createNativeAttributePricing(client, {
        context: c.deploymentContext!,
        procedureName: payload.procedureName,
        entries: validEntries,
        autoFixPriceImpacting: payload.autoFixPriceImpacting === true,
        onProgress: e => emit({ type: "step", step: NATIVE_OBJECT_UI_ROW[e.object], status: e.status, detail: e.detail }),
        // §B — streamed the instant it's computed (before Step A/PAS even begins), so the UI can render
        // the complete Attribute JSON Preview as its own live stage, ahead of any native record create.
        onAttributePreview: attributes => emit({
          type: "attributePreview", product2Id: c.deploymentContext!.productId, sellingModelId: c.deploymentContext!.sellingModelId,
          priceAdjustmentScheduleId: c.deploymentContext!.priceAdjustmentScheduleId ?? null, attributes,
        }),
      }),
      verify: async (c, native): Promise<VerifyOutcome> => {
        // Stored here (not just in `commit`) so `native.result.firstFailure` is still reachable for the
        // failure response below even when this step itself is the one that fails.
        c.native = native;
        steps.push(...native.steps);
        if (native.result.firstFailure) {
          const ff = native.result.firstFailure;
          const reason = ff.missingFields.length > 0
            ? ff.salesforceErrorMessage ?? "Unknown error."
            : `${ff.objectName} create failed (HTTP ${ff.httpStatus ?? "n/a"}${ff.salesforceErrorCode ? `, ${ff.salesforceErrorCode}` : ""}): ${ff.salesforceErrorMessage ?? "Unknown error."}`;
          return {
            ok: false,
            failure: {
              object: ff.objectName, operation: "Create", salesforceId: null, reason,
              salesforceError: { httpStatus: ff.httpStatus ?? undefined, errorCode: ff.salesforceErrorCode ?? undefined, message: ff.salesforceErrorMessage ?? undefined },
              lastSuccessfulStep: NATIVE_OBJECT_PRECEDING_STEP[ff.objectName],
            },
          };
        }
        const missingObject =
          !native.result.scheduleId ? "PriceAdjustmentSchedule" :
          native.result.ruleIds.length === 0 ? "AttributeBasedAdjRule" :
          native.result.conditionIds.length === 0 ? "AttributeAdjustmentCondition" :
          native.result.abaIds.length === 0 ? "AttributeBasedAdjustment" : null;
        if (missingObject) {
          const executionKey = ({
            PriceAdjustmentSchedule: "priceAdjustmentSchedule",
            AttributeBasedAdjRule: "attributeBasedAdjRule",
            AttributeAdjustmentCondition: "attributeAdjustmentCondition",
            AttributeBasedAdjustment: "attributeBasedAdjustment",
          } as const)[missingObject];
          const executionStep = native.result.executionReport?.[executionKey];
          return {
            ok: false,
            failure: {
              object: missingObject, operation: "Create", salesforceId: null,
              reason: `${missingObject} was never created for this run.${executionStep ? ` ${executionStep.reason}` : " No specific create failure was captured."} ${native.result.error ?? ""}`.trim(),
              lastSuccessfulStep: NATIVE_OBJECT_PRECEDING_STEP[missingObject],
            },
          };
        }
        step(steps, "verify-native-objects", "success", `Confirmed: PriceAdjustmentSchedule ${native.result.scheduleId}, ${native.result.ruleIds.length} rule(s), ${native.result.conditionIds.length} condition(s), ${native.result.abaIds.length} adjustment(s).`);
        return { ok: true };
      },
      commit: (c, native) => {
        c.native = native;
        c.deploymentContext!.priceAdjustmentScheduleId = native.result.scheduleId;
      },
      classifyExecuteError: () => ({ object: "PriceAdjustmentSchedule", operation: "Create" }),
    });
  } else if (payload.allowReuseExistingSchedule) {
    // Only ever reachable when the caller explicitly opted in — the guided/manual flow's own
    // client-side validation never submits zero valid entries, and the pre-flight §Row validation
    // gate in POST() still 400s otherwise. Autopilot uses this after the user reviewed and confirmed
    // reusing an already-configured Price Adjustment Schedule instead of adding new attribute pricing.
    pushStep({
      name: "Price Adjustment Schedule",
      execute: async (c) => findExistingScheduleForProduct(client, c.product!.id),
      verify: async (_c, existing): Promise<VerifyOutcome> => {
        if (!existing || existing.ruleCount === 0) {
          return {
            ok: false,
            failure: {
              object: "PriceAdjustmentSchedule", operation: "Query", salesforceId: null,
              reason: "No valid attribute pricing rules have been configured, and no existing Price Adjustment Schedule with at least one rule was found in Salesforce for this product.",
            },
          };
        }
        const exists = await verifyRecordExists(client, "PriceAdjustmentSchedule", existing.scheduleId);
        if (!exists) {
          return { ok: false, failure: { object: "PriceAdjustmentSchedule", operation: "Verify (query-back)", salesforceId: existing.scheduleId, reason: `PriceAdjustmentSchedule ${existing.scheduleId} was resolved, but querying it back found no matching record.` } };
        }
        return { ok: true };
      },
      commit: (c, existing) => {
        c.reusedScheduleId = existing!.scheduleId;
        c.deploymentContext!.priceAdjustmentScheduleId = existing!.scheduleId;
      },
      classifyExecuteError: () => ({ object: "PriceAdjustmentSchedule", operation: "Query" }),
    });
  } else {
    // Defensive parity only — the pre-flight §Row validation gate in POST() already 400s this exact
    // combination before this function is ever entered.
    warnings.push("No attribute pricing entries were submitted — skipping Attribute Decision Table creation; the deployed procedure will have no native adjustment records yet.");
  }

  // ── 9. Expression Set Generation ──
  pushStep({
    name: "Expression Set Generation",
    execute: async () => {
      emit({ type: "step", step: "Template Retrieved", status: "running" });
      return buildAttributeCanvas(client, {
        procedureName: payload.procedureName, apiName, description: payload.description,
        onProgress: () => {
          emit({ type: "step", step: "Template Retrieved", status: "done" });
          emit({ type: "step", step: "XML Generated", status: "running" });
        },
      });
    },
    verify: async (c, canvas): Promise<VerifyOutcome> => {
      // Stored here (not just in `commit`) so `canvas.schemaReport` is still reachable for the failure
      // response below even when this step itself is the one that fails.
      c.canvas = canvas;
      warnings.push(...canvas.warnings);
      if (!canvas.success || !canvas.finalFileXml) {
        // §classifyCanvasFailureStep — canvas failures aren't exceptions (buildAttributeCanvas reports
        // them as structured `fatalErrors` strings), so the exact sub-stage (template retrieval vs. XML
        // generation vs. structural validation) is folded into `operation` rather than lost.
        return {
          ok: false,
          failure: {
            object: "ExpressionSetDefinition", operation: `${classifyCanvasFailureStep(canvas.fatalErrors)} (Metadata API)`, salesforceId: null,
            reason: canvas.fatalErrors.join(" ") || "Canvas build failed for an unknown reason.",
          },
        };
      }
      step(steps, "build-canvas", "success", "Canvas built and validated.", { observedActionTypes: canvas.observedActionTypes, stepStats: canvas.stepStats, variableCount: canvas.variableCount });
      return { ok: true };
    },
    commit: (c, canvas) => { c.canvas = canvas; },
    classifyExecuteError: () => ({ object: "ExpressionSetDefinition", operation: "Retrieve (Metadata API)" }),
  });

  // ── 10. Deploy Metadata ──
  pushStep({
    name: "Deploy Metadata",
    execute: async (c) => {
      // §Org-wide uniqueness — canvasBuilder.ts already confirmed no regenerated identifier still
      // equals the DONOR's value, but the donor is only one existing metadata file; the org may contain
      // many other Expression Sets. This re-checks every generated identifier against the ORG itself,
      // immediately before the actual Metadata Deploy call — never modifies XML generation or the
      // deploy call itself, purely a pre-flight read/compare gate.
      const generatedFullNames = (c.canvas?.generatedIdentifiers ?? [])
        .filter(i => i.tag === "fullName" || i.tag === "expressionSetDefinition")
        .map(i => i.value);
      const generatedLabel = (c.canvas?.generatedIdentifiers ?? []).find(i => i.tag === "label")?.value ?? null;
      const uniqueness = await validateExpressionSetUniquenessAgainstOrg(client, { apiName, generatedFullNames, generatedLabel });
      // §Pre-flight, never authoritative — captured on `c` regardless of outcome so a REAL deploy
      // failure below can be compared against it; a clean pre-flight result never skips or weakens the
      // actual Metadata Deploy call, and a failed one still stops here exactly as before.
      c.orgUniquenessPreflight = uniqueness;
      if (!uniqueness.ok) throw new OrgUniquenessConflictError(uniqueness);
      return deployExpressionSetDefinition(client, apiName, c.canvas!.finalFileXml!, c.canvas!.donorFileName);
    },
    verify: async (c, deployResult): Promise<VerifyOutcome> => {
      // Stored here (not just in `commit`) so `deployResult.packagingReport` is still reachable for the
      // failure response below even when this step itself is the one that fails.
      c.deployResult = deployResult;
      if (!deployResult.success) {
        // §Post-deploy diagnosis — deployExpressionSetDefinition() itself is completely unmodified and
        // never retried; this only reclassifies + explains a failure it already returned. A clean
        // pre-flight result never suppresses or excuses a real Salesforce rejection — both are always
        // reported together so it's obvious whether the pre-flight validator missed something or
        // Salesforce enforced a constraint that isn't queryable ahead of time.
        const rawReason = deployResult.error ?? "Metadata deploy failed.";
        const diagnosis = diagnosePostDeployFailure(rawReason, c.orgUniquenessPreflight ?? null);
        client.logDebug("xml-diagnostic", [
          "==================================================",
          "POST-DEPLOY FAILURE DIAGNOSIS",
          "==================================================",
          diagnosis.diagnosis,
          "==================================================",
        ].join("\n"));
        return {
          ok: false,
          failure: {
            object: "ExpressionSetDefinition",
            operation: diagnosis.classification ?? (deployResult.localPackagingFailure ? "Local ZIP Packaging (pre-deploy)" : "Metadata Deploy"),
            salesforceId: null,
            reason: diagnosis.isUniquenessConflict ? diagnosis.diagnosis : rawReason,
          },
        };
      }
      // §Verify by querying back — a successful deploy result is confirmed by re-reading the actual
      // ExpressionSet/ExpressionSetVersion it should have created, never trusted on the deploy status
      // alone.
      let procedureId: string | undefined;
      let versionId: string | undefined;
      try {
        const esRes = await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSet WHERE DeveloperName = '${apiName}' LIMIT 1`);
        procedureId = esRes.records[0]?.Id;
        if (procedureId) {
          const verRes = await client.query<{ Id: string }>(`SELECT Id FROM ExpressionSetVersion WHERE ExpressionSetId = '${procedureId}' ORDER BY CreatedDate DESC LIMIT 1`);
          versionId = verRes.records[0]?.Id;
        }
      } catch (err) {
        return {
          ok: false,
          failure: {
            object: "ExpressionSet", operation: "Verify (query-back)", salesforceId: null,
            reason: `Metadata deployed successfully, but could not resolve the ExpressionSet/Version Id afterward: ${err instanceof Error ? err.message : String(err)}`,
            salesforceError: extractSalesforceError(err),
          },
        };
      }
      if (!procedureId) {
        return { ok: false, failure: { object: "ExpressionSet", operation: "Verify (query-back)", salesforceId: null, reason: `Metadata deployed successfully, but no ExpressionSet with DeveloperName "${apiName}" was found afterward.` } };
      }
      c.procedureId = procedureId;
      c.versionId = versionId;
      step(steps, "deploy", "success", "Metadata deployed successfully.", deployResult.status);
      return { ok: true };
    },
    commit: (c, deployResult) => {
      c.deployResult = deployResult;
      c.deploymentContext!.expressionSetId = c.procedureId;
      c.deploymentContext!.expressionSetVersionId = c.versionId;
    },
    classifyExecuteError: (err) => (
      err instanceof OrgUniquenessConflictError
        ? { object: "ExpressionSetDefinition", operation: "Uniqueness Validation (pre-deploy, org-wide)" }
        : { object: "ExpressionSetDefinition", operation: "Metadata Deploy" }
    ),
  });

  // ── 11. Activate Pricing Procedure ──
  pushStep({
    name: "Activate Pricing Procedure",
    execute: async (c) => {
      if (payload.procedureStatus !== "Active") return "Draft" as const;
      if (!c.versionId) return "Draft" as const;
      await client.updateRecord("ExpressionSetVersion", c.versionId, { Status: "Active" });
      return "Active" as const;
    },
    verify: async (c, requestedResult): Promise<VerifyOutcome> => {
      if (payload.procedureStatus !== "Active") return { ok: true }; // Draft was requested — nothing to activate/verify.
      if (!c.versionId) {
        return { ok: false, failure: { object: "ExpressionSetVersion", operation: "Activate", salesforceId: null, reason: "Could not activate — the ExpressionSetVersion Id wasn't resolved after deploy." } };
      }
      if (requestedResult !== "Active") {
        return { ok: false, failure: { object: "ExpressionSetVersion", operation: "Activate", salesforceId: c.versionId, reason: "Activation was requested but did not complete." } };
      }
      // §Verify by querying back — never trust the update call's lack of a thrown error alone.
      const verifyRes = await client.query<{ Id: string; Status?: string }>(`SELECT Id, Status FROM ExpressionSetVersion WHERE Id = '${c.versionId}' LIMIT 1`);
      if (verifyRes.records[0]?.Status !== "Active") {
        return { ok: false, failure: { object: "ExpressionSetVersion", operation: "Verify (query-back)", salesforceId: c.versionId, reason: `ExpressionSetVersion ${c.versionId} was updated to Active, but querying it back shows Status = "${verifyRes.records[0]?.Status ?? "(not found)"}".` } };
      }
      return { ok: true };
    },
    commit: (c, result) => { c.versionStatus = result; },
    classifyExecuteError: (err) => ({ object: "ExpressionSetVersion", operation: extractSalesforceError(err)?.errorCode ? "Activate" : "Activate" }),
  });

  // ── 12. Runtime Verification ── — only meaningful when there's a newly-priced attribute entry to
  // simulate against; the reuse-existing-schedule path has no NEW entry to verify pricing for (the
  // existing rule/condition/adjustment records were already verified when they were originally
  // created), so it's skipped, not failed.
  const verificationEntry: NormalizedAttributeEntry | undefined = validEntries[0];
  if (verificationEntry) {
    pushStep({
      name: "Runtime Verification",
      execute: async (c) => verifyAttributeExecution(client, {
        procedureApiName: apiName,
        procedureId: c.procedureId,
        versionId: c.versionId,
        productId: c.product!.id,
        productName: c.product!.name,
        sellingModelId: c.sellingModelId,
        attributeValue: verificationEntry.attributeValue,
        attributeName: verificationEntry.attributeName,
        pasId: c.deploymentContext?.priceAdjustmentScheduleId,
        quantity: 1,
        currency: payload.currency,
      }),
      verify: async (_c, result): Promise<VerifyOutcome> => {
        steps.push(...result.steps);
        if (!result.success) {
          return {
            ok: false,
            failure: {
              object: "ExpressionSetVersion", operation: "Simulate (Pricing Engine)", salesforceId: null,
              reason: result.executionReport.blocker?.reason ?? "Runtime pricing simulation did not return the expected result.",
            },
          };
        }
        return { ok: true };
      },
      commit: (c, result) => { c.verifyResult = result; },
      classifyExecuteError: () => ({ object: "ExpressionSetVersion", operation: "Simulate (Pricing Engine)" }),
    });
  }

  // ── §Sequential Workflow — live checklist mapping for the steps whose OWN start/success boundary is
  // exactly one checklist row (no internal sub-phases to report): "Price Adjustment Schedule" only
  // exists as its own WorkflowStepDefinition on the reuse-existing-schedule path (validEntries.length
  // === 0); "Native Attribute Records..." and "Expression Set Generation" report their own sub-phases
  // via the onProgress callbacks wired above instead, so they're deliberately absent here — emitting a
  // generic event for them too would just be a second, redundant signal for the same row. "Product
  // Lookup"/"Selling Model Lookup"/"Attribute Discovery"/"Lookup Table Creation"/"Activate Pricing
  // Procedure" have no live checklist row at all (§1-4 are already known true from client-side
  // discovery before this request was even sent; Activate/Lookup Table aren't numbered rows in the
  // spec) — a failure in one of those still reaches the client via the terminal "result" line's
  // `failure` object, just without its own live Running/Failed row.
  const STEP_START_UI_ROW: Record<string, string> = {
    "Price Adjustment Schedule": "Price Adjustment Schedule Created",
    "Deploy Metadata": "Metadata Deployed",
    "Runtime Verification": "Runtime Verification Completed",
  };
  const outcome = await runWorkflow(ctx, defs, {
    onStepStart: name => {
      step(steps, name, "start", `Starting "${name}".`);
      const uiRow = STEP_START_UI_ROW[name];
      if (uiRow) emit({ type: "step", step: uiRow, status: "running" });
    },
    onStepSuccess: name => {
      step(steps, name, "success", `"${name}" completed and was verified.`);
      const uiRow = STEP_START_UI_ROW[name];
      if (uiRow) emit({ type: "step", step: uiRow, status: "done" });
    },
  });

  if (!outcome.success) {
    // §Sequential Workflow — a failed native object's "failed" event is normally already emitted live
    // from inside createNativeAttributePricing's onProgress callback; re-emitting it here too (from the
    // one place that always runs, unlike onProgress, which never fires for a genuinely unexpected
    // exception thrown before that function's own resolution logic gets a chance to run) is a harmless,
    // idempotent duplicate on the normal path and the only signal at all on that rarer exception path —
    // never leaving a checklist row stuck spinning with no resolution is worth the redundancy.
    const nativeObjectUiRow = NATIVE_OBJECT_UI_ROW[outcome.failure.object];
    if (nativeObjectUiRow) {
      emit({ type: "step", step: nativeObjectUiRow, status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Product Lookup") {
      emit({ type: "step", step: "Product Found", status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Selling Model Lookup") {
      emit({ type: "step", step: "Selling Model Retrieved", status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Attribute Discovery") {
      emit({ type: "step", step: "Attributes Retrieved", status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Price Adjustment Schedule") {
      emit({ type: "step", step: "Price Adjustment Schedule Created", status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Expression Set Generation") {
      const uiRow = classifyCanvasFailureStep(ctx.canvas?.fatalErrors ?? []) === "Retrieve Template Expression Set" ? "Template Retrieved" : "XML Generated";
      emit({ type: "step", step: uiRow, status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Deploy Metadata") {
      emit({ type: "step", step: "Metadata Deployed", status: "failed", detail: outcome.failure.reason });
    } else if (outcome.failure.step === "Runtime Verification") {
      emit({ type: "step", step: "Runtime Verification Completed", status: "failed", detail: outcome.failure.reason });
    }
    // "Lookup Table Creation"/"Activate Pricing Procedure" have no checklist row — no event to emit;
    // the terminal "result" line's `failure` object still carries full diagnostics for those.
    // §Diagnostics preserved from the pre-refactor pipeline — a structural XML comparison for an
    // "Expression Set Generation" failure, the full ZIP packaging report for a "Deploy Metadata"
    // failure, and the exact native-object create failure for any of the 4 native objects. None of
    // these are part of the generic WorkflowStepFailure shape (they're pricing-rules-specific), so
    // they're attached here from whatever the relevant step already stored on `ctx`.
    const isNativeObjectFailure = outcome.failure.object in NATIVE_OBJECT_STEP_NAME;
    const isDeployFailure = outcome.failure.step === "Deploy Metadata";
    // §Deployment Diagnostics — every componentFailures[] entry Salesforce returned (never collapsed
    // into one string), the complete raw deploy status, the exact generated XML, and the deployed ZIP
    // package (for offline inspection) — all already captured on `ctx.deployResult` by the Deploy
    // Metadata step's own `verify()`, attached here only for a "Deploy Metadata" failure.
    const failure = workflowFailureToCreateProcedureFailure(outcome.failure, {
      schemaReport: ctx.canvas?.schemaReport,
      packagingReport: ctx.deployResult?.packagingReport?.reportText,
      nativeCreateFailure: isNativeObjectFailure ? ctx.native?.result.firstFailure : undefined,
      deployComponentFailures: isDeployFailure ? ctx.deployResult?.status?.componentFailures : undefined,
      deployFullStatus: isDeployFailure ? (ctx.deployResult?.status ?? null) : undefined,
      generatedFileXml: isDeployFailure ? ctx.deployResult?.generatedFileXml : undefined,
      deployZipBase64: isDeployFailure ? ctx.deployResult?.deployZipBase64 : undefined,
      rawDeployStatusXml: isDeployFailure ? ctx.deployResult?.rawDeployStatusXml : undefined,
    });
    step(steps, outcome.failure.step, "error", failure.reason, outcome.failure);
    return buildFailureResult(steps, warnings, failure, client, debug, {
      attrNative: ctx.native?.result,
      procedureId: ctx.procedureId,
      versionId: ctx.versionId,
      verifyResult: ctx.verifyResult,
    });
  }

  // ── ListPrice Decision Table dataset refresh — the ListPrice step's OWN decision table (its
  // base-price lookup, inherited from the donor), a different lookup from the Attribute Decision Table
  // (PriceAdjustmentSchedule) created above. Not itself one of the 12 workflow stages (it can only be
  // resolved once `canvas` exists, and a failure here has never blocked a successful deploy) — kept as
  // a best-effort warning, exactly as before.
  let dtRefreshWarning: string | undefined;
  if (ctx.canvas?.lpLookup?.lookUpId) {
    const refresh = await refreshListPriceDecisionTable(client, ctx.canvas.lpLookup.lookUpId, ctx.canvas.lpLookup.lookUpApiName);
    if (refresh.warning) dtRefreshWarning = refresh.warning;
  }
  if (dtRefreshWarning) warnings.push(dtRefreshWarning);

  const result: SalesforceCreationResult = {
    success: true,
    procedureId: ctx.procedureId,
    versionId: ctx.versionId,
    apiName,
    versionStatus: ctx.versionStatus,
    canvasSteps: ctx.canvas?.finalSteps?.map((s, i) => ({ seq: i + 1, actionType: s.actionType, label: s.actionType, description: "" })),
    observedActionTypes: ctx.canvas?.observedActionTypes,
    stepParameterCounts: ctx.canvas?.stepStats,
    variableCount: ctx.canvas?.variableCount,
    deployStatus: ctx.deployResult?.status
      ? { numberComponentsDeployed: ctx.deployResult.status.numberComponentsDeployed, numberComponentErrors: ctx.deployResult.status.numberComponentErrors, status: ctx.deployResult.status.status }
      : undefined,
    attrNative: ctx.native?.result,
    simulationContext: ctx.deploymentContext?.priceAdjustmentScheduleId
      ? { ItemContractAttributePasId: ctx.deploymentContext.priceAdjustmentScheduleId, note: "Pass this field in your executeExpressionSet input context so AttributeDiscount can resolve the PriceAdjustmentSchedule." }
      : undefined,
    verifyResult: ctx.verifyResult,
    steps,
    warnings,
    debugLog: debug ? client.debugLog : undefined,
  };
  return result;
}
