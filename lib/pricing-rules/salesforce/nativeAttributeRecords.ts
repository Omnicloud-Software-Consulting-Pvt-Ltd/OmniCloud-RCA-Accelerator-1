/**
 * §8.10 — native record creation for attribute-based pricing:
 * PriceAdjustmentSchedule (reuse-or-create), then per submitted entry an
 * AttributeBasedAdjRule + its AttributeAdjustmentCondition(s) (the
 * entry's own value plus an "anchor" condition per every OTHER
 * price-impacting attribute, so the rule only fires for this exact value
 * combination) + AttributeBasedAdjustment.
 *
 * §Schema-driven lookup resolution — every lookup field (Product2,
 * ProductSellingModel, Pricebook2, PriceAdjustmentSchedule,
 * AttributeBasedAdjRule, AttributeDefinition, ProductAttributeDefinition)
 * on every one of these 4 objects is resolved through the SAME generic
 * `resolveReferenceField` (see nativeSchemaResolver.ts) — never an
 * object-specific resolver, never a hardcoded API name. A lookup that
 * doesn't exist on a given object's schema is not an error; only
 * Salesforce's own required-field list (read fresh from that object's
 * Describe, also in nativeSchemaResolver.ts) can ever fail a create.
 *
 * §Stop immediately: the very first create failure — PriceAdjustmentSchedule,
 * AttributeBasedAdjRule, AttributeAdjustmentCondition, or
 * AttributeBasedAdjustment — aborts the whole run immediately and is
 * captured verbatim (object, payload, required/missing fields, HTTP
 * status, Salesforce error code/message, full response body) on
 * `AttrNativeResult.firstFailure`, so the caller can report exactly which
 * object failed instead of a generic "Create Price Adjustment Schedule
 * failed" no matter what actually broke.
 *
 * Every createRecord() call goes through `guardedCreate()`: before the
 * call, it logs the resolved lookups + payload + required/missing fields
 * (via `logObjectCreation`) and verifies every Salesforce-required field
 * is populated — never calls Salesforce on a payload missing one; after
 * the call, it logs the exact response.
 */
import { SalesforceError, type SalesforceClient, type DescribeResult, type DescribeField } from "@/lib/salesforce/client";
import {
  SchemaCache, resolveReferenceField, getOptionalFields, getRequiredFields, getMissingFields, logObjectCreation,
  buildSchemaDiagnosis, formatSchemaDiagnosis, logSchemaDiagnosis, type ResolvedLookup,
  classifyAttributeDataType, resolveTypedValueField, resolveDataTypeField, convertValueForField,
  fillRequiredPicklistDefaults, extractSalesforceFields, diagnoseCreateRejection, formatCreateRejectionDiagnosis,
  resolvePriceImpactingField, resolveAttributeDataTypeSourceField,
  type ValueKind,
} from "@/lib/pricing-rules/salesforce/nativeSchemaResolver";
import { verifyRecordExists } from "@/lib/pricing-rules/salesforce/workflowRunner";
import type { AttrNativeResult, ProcedureStep, NativeCreateFailureDetail, NativeRecordCountPreview, DeploymentContext, NativeExecutionReport, AttributePreviewEntry } from "@/lib/pricing-rules/types";

function step(steps: ProcedureStep[], name: string, status: ProcedureStep["status"], message: string, detail?: unknown) {
  steps.push({ step: name, status, message, detail, timestamp: Date.now() });
}

/**
 * §Execution trace (Step 1/2/3/4) — logs an event plus the REAL enclosing
 * function name and source file:line:col, read off the live call stack at
 * the moment this is called (never a hardcoded/guessed location). Note
 * honestly: PriceAdjustmentSchedule/AttributeBasedAdjRule/AttributeBasedAdjustment
 * creation are inline blocks inside `createNativeAttributePricing`, not
 * separate functions — so their trace entries correctly show `function:
 * "createNativeAttributePricing"` rather than a name like
 * "createAttributeBasedAdjRule" that doesn't exist in this file. Only
 * AttributeAdjustmentCondition creation (`tryCreateCondition`) is its own
 * real function, and its trace entries reflect that accurately.
 */
function trace(client: SalesforceClient, event: string, detail?: Record<string, unknown>): void {
  const stack = new Error().stack ?? "";
  const lines = stack.split("\n");
  // lines[0] = "Error", lines[1] = this `trace` frame itself, lines[2] = the real call site.
  const callerRaw = (lines[2] ?? lines[1] ?? "(unknown location)").trim();
  const fnMatch = callerRaw.match(/at\s+([^\s(]+)\s*\(/);
  const locMatch = callerRaw.match(/\(([^)]+)\)/) ?? callerRaw.match(/at\s+(.+)/);
  client.logDebug("execution-trace", JSON.stringify({
    event,
    function: fnMatch ? fnMatch[1] : "(anonymous)",
    location: locMatch ? locMatch[1].trim() : callerRaw,
    ...detail,
  }, null, 2));
}

/** Logs a caught exception's type/message/stage without ever silently continuing unlogged (§Step 3). The full stack goes to the server console only — never the client — matching this app's existing convention (see errorDiagnostics.ts). */
function traceException(client: SalesforceClient, stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const type = err instanceof Error ? err.constructor.name : typeof err;
  console.error(`[nativeAttributeRecords:${stage}] caught exception:`, err);
  trace(client, "EXCEPTION_CAUGHT", { stage, exceptionType: type, message, note: "Full stack trace logged to server console only." });
}

/**
 * §1-§6 — Describe-driven schema discovery for AttributeBasedAdjustment: every lookup (reference)
 * field this object actually exposes (API Name/Label/ReferenceTo/Createable/Updateable), whether it
 * has a relationship to AttributeAdjustmentCondition/AttributeBasedAdjRule/AttributeDefinition/
 * ProductAttributeDefinition, and which of those Describe-exposed lookups are missing from the
 * payload about to be sent. Never guesses a field name — reads only what this run's own SchemaCache
 * already fetched.
 */
function logAdjustmentSchemaDiscovery(client: SalesforceClient, adjustmentDescribe: DescribeResult, payload: Record<string, unknown>): void {
  const refFields = adjustmentDescribe.fields.filter(f => f.type === "reference");
  const relationshipTargets = ["AttributeAdjustmentCondition", "AttributeBasedAdjRule", "AttributeDefinition", "ProductAttributeDefinition"];
  const lines: string[] = ["AttributeBasedAdjustment — Describe schema discovery", "", "Every lookup (reference) field:"];
  lines.push(...(refFields.length > 0
    ? refFields.flatMap(f => [
        `  - API Name: ${f.name}`,
        `    Label: ${f.label}`,
        `    ReferenceTo: [${(f.referenceTo ?? []).join(", ")}]`,
        `    Createable: ${f.createable}`,
        `    Updateable: ${f.updateable}`,
      ])
    : ["  (none)"]));
  lines.push("", "Relationship existence check:");
  for (const target of relationshipTargets) {
    const matches = refFields.filter(f => (f.referenceTo ?? []).some(r => r.toLowerCase() === target.toLowerCase()));
    lines.push(`  - ${target}: ${matches.length > 0 ? `YES (${matches.map(f => f.name).join(", ")})` : "NO"}`);
  }
  lines.push("", "Lookup fields present in Describe but MISSING from the payload currently being sent:");
  const missing = refFields.filter(f => !(f.name in payload));
  lines.push(...(missing.length > 0 ? missing.map(f => `  - ${f.name} (referenceTo: [${(f.referenceTo ?? []).join(", ")}])`) : ["  (none — every Describe-exposed lookup is present in the payload)"]));
  client.logDebug("native-create-request", lines.join("\n"));
}

/** §10 — the complete Product -> Rule -> Conditions -> Adjustment(s) relationship graph, every Salesforce Id, logged once per entry after all of this entry's AttributeBasedAdjustment record(s) are resolved (created or reused). */
function logRelationshipGraph(client: SalesforceClient, productId: string, ruleId: string, conditionIds: string[], adjustmentIds: string[]): void {
  client.logDebug("native-create-request", [
    "AttributeBasedAdjustment — relationship graph",
    "Product",
    `  ↓ ${productId}`,
    "Rule",
    `  ↓ ${ruleId}`,
    "Conditions",
    `  ↓ [${conditionIds.join(", ") || "(none)"}]`,
    "Adjustment(s)",
    `  ↓ [${adjustmentIds.join(", ") || "(none)"}]`,
  ].join("\n"));
}

/* ── §8.10.1 payload normalization ── */
export interface NormalizedAttributeEntry {
  attributeName: string;
  attributeValue: string;
  adjustmentType: string;
  adjustmentValue: number;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}
function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

export function normalizeAttributeEntries(raw: unknown): NormalizedAttributeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedAttributeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const attributeName = firstString(r.attributeName, r.attribute, r.name, r.field, r.dimension);
    const attributeValue = firstString(r.attributeValue, r.selectedValue, r.picklistValue, r.option, r.value);
    if (!attributeName || !attributeValue) continue;
    // No default here (a prior version defaulted to "AmountAdjustment") — a row the user never
    // assigned a real adjustment type to must stay untyped so §Row validation below can correctly
    // treat it as "not configured" rather than silently passing it through as valid.
    const adjustmentType = firstString(r.adjustmentType, r.type, r.pricingType, r.adjustmentKind) ?? "";
    const adjustmentValue = firstNumber(r.adjustmentValue, r.amount, r.valueAmount, r.price, r.delta, r.value) ?? 0;
    out.push({ attributeName, attributeValue, adjustmentType, adjustmentValue });
  }
  return out;
}

/**
 * §Row validation — a pricing row is only eligible for native record creation
 * (and, transitively, for a PriceAdjustmentSchedule to be created at all) when
 * it has a real Attribute Value, a selected Adjustment Type, and an Adjustment
 * Amount that's meaningful for that type (>0 for a discount/fixed amount; >=0
 * for an Override Price, since overriding to 0 is a legitimate configuration).
 * A row with none of these set is just an unused table row and is ignored
 * silently; a row with SOME of these set but not all is flagged as a warning,
 * since that's more likely a half-finished/typo'd row than an intentional no-op.
 */
export interface PricingRowValidation {
  entry: NormalizedAttributeEntry;
  valid: boolean;
  /** Reason the row failed — omitted for a completely blank/untouched row, which is ignored without comment. */
  reason?: string;
}

export function evaluateAttributePricingRow(entry: NormalizedAttributeEntry): PricingRowValidation {
  const touched = !!entry.attributeValue || !!entry.adjustmentType || entry.adjustmentValue !== 0;
  if (!entry.attributeValue) return { entry, valid: false, reason: touched ? "no Attribute Value is set" : undefined };
  if (!entry.adjustmentType) return { entry, valid: false, reason: "no Adjustment Type is selected" };
  const isOverride = /override/i.test(entry.adjustmentType);
  const amountValid = isOverride ? entry.adjustmentValue >= 0 : entry.adjustmentValue > 0;
  if (!amountValid) {
    return { entry, valid: false, reason: `Adjustment Amount (${entry.adjustmentValue}) is not valid for "${entry.adjustmentType}" — it must be ${isOverride ? "0 or greater" : "greater than 0"}` };
  }
  return { entry, valid: true };
}

/** Splits normalized entries into the ones actually eligible for native record creation, plus one warning per row that had SOME configuration but failed validation (never for a fully blank row). */
export function filterValidPricingRows(entries: NormalizedAttributeEntry[]): { valid: NormalizedAttributeEntry[]; warnings: string[] } {
  const valid: NormalizedAttributeEntry[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    const check = evaluateAttributePricingRow(entry);
    if (check.valid) {
      valid.push(entry);
    } else if (check.reason) {
      warnings.push(`Ignored attribute pricing row for "${entry.attributeName}" = "${entry.attributeValue}" — ${check.reason}.`);
    }
  }
  return { valid, warnings };
}

/* ── helpers ── */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}
function resolveAdjustmentType(validValues: string[], input: string): string {
  if (validValues.length === 0) return input;
  if (validValues.includes(input)) return input;
  const byNorm = validValues.find(v => normalizeForCompare(v) === normalizeForCompare(input));
  if (byNorm) return byNorm;
  return validValues.find(v => /amount/i.test(v)) ?? validValues.find(v => /percent/i.test(v)) ?? validValues[0];
}
function activePicklistValues(field: DescribeField | undefined | null): string[] {
  return (field?.picklistValues ?? []).filter(v => v.active).map(v => v.value);
}
function findFieldByNamePattern(describe: DescribeResult, pattern: RegExp): DescribeField | null {
  return describe.fields.find(f => pattern.test(f.name)) ?? null;
}
function sanitizeRuleName(attributeName: string, attributeValue: string): string {
  const raw = `${attributeName}_${attributeValue}_Rule`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 80);
}
function addYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * §Standard Price Book resolution — the same source of truth this module
 * already uses elsewhere for a product's Base Price (see productLookup.ts's
 * resolveStandardPricebookEntry's `Pricebook2.IsStandard = true`), reused
 * here only when PriceAdjustmentSchedule's own Describe actually exposes a
 * Pricebook2 lookup. Never a hardcoded Id.
 */
async function resolveStandardPricebookId(client: SalesforceClient): Promise<string | null> {
  try {
    const res = await client.query<{ Id: string }>(`SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1`);
    return res.records[0]?.Id ?? null;
  } catch (err) {
    traceException(client, "resolveStandardPricebookId", err);
    return null;
  }
}

function logCreateResponse(
  client: SalesforceClient,
  sobject: string,
  outcome: { success: true; id: string }
    | { success: false; httpStatus: number | null; errorCode: string | null; message: string; responseBody: unknown; payload: Record<string, unknown> },
): void {
  if (!outcome.success) {
    // §5/§7 — the complete Salesforce error response, made explicit rather than left buried inside a
    // generic JSON dump: status code, errorCode, message, the exact `fields` array Salesforce names as
    // the cause (when present — REST create failures return an array of `{message, errorCode, fields}`),
    // and the payload actually sent.
    const fields = extractSalesforceFields(outcome.responseBody);
    client.logDebug("native-create-response", [
      `${sobject} — create failed`,
      `HTTP Status: ${outcome.httpStatus ?? "(none)"}`,
      `Salesforce Error Code: ${outcome.errorCode ?? "(none)"}`,
      `Salesforce Error Message: ${outcome.message}`,
      `Salesforce Fields: ${fields.length > 0 ? JSON.stringify(fields) : "(none reported)"}`,
      `Payload Sent: ${JSON.stringify(outcome.payload, null, 2)}`,
      `Complete Response Body: ${JSON.stringify(outcome.responseBody, null, 2)}`,
    ].join("\n"));
    return;
  }
  client.logDebug("native-create-response", JSON.stringify({ "Object Name": sobject, ...outcome }, null, 2));
}

export type GuardedCreateOutcome = { ok: true; id: string } | { ok: false; failure: NativeCreateFailureDetail };

/**
 * Every native-record createRecord() call in this file goes through here.
 * (1) Logs Object Name / Resolved Lookups (Target Object, Resolved Field,
 *     Resolved Value, PASS/FAIL) / Payload / Required Fields / Missing
 *     Fields via `logObjectCreation` — the ONE shared implementation every
 *     object uses, never call-site-specific. (2) Refuses to call Salesforce
 *     at all if a required field (per that object's own Describe) is
 *     missing. (3) Refuses to call Salesforce if a lookup this object's
 *     schema DOES expose, and that had a real value to set, never actually
 *     made it into the payload (a caller bug, not a schema gap — a lookup
 *     this object's schema simply doesn't have is never treated as an
 *     error). (4) Logs the complete response after the call, success or not.
 * Every failure path produces the SAME `NativeCreateFailureDetail` shape,
 * so the caller never has to special-case which kind of failure it was.
 */
async function guardedCreate(
  client: SalesforceClient,
  sobject: string,
  describe: DescribeResult,
  payload: Record<string, unknown>,
  resolvedLookups: ResolvedLookup[],
): Promise<GuardedCreateOutcome> {
  const restEndpoint = `POST ${client.dataApiBase}/sobjects/${sobject}`;
  const optionalFields = getOptionalFields(describe);
  const { requiredFields, missingFields } = logObjectCreation(client, sobject, { describe, payload, resolvedLookups });

  // §Schema diagnosis — built from the Describe already fetched for this call (SchemaCache; zero
  // extra Salesforce round-trips), whenever a create is ABOUT TO FAIL. Never the generic "a required
  // field couldn't be resolved": for every missing required field, this names whether it's a lookup
  // at all, which target (if any) this create call actually attempted to resolve for it, and exactly
  // why the value never landed in the payload. Logged to Debug Mode (including the complete raw
  // Describe response) AND used as the failure's own message, so the real diagnosis reaches the
  // caller through the normal failure path — no Workbench, no manual Describe call, nothing hidden
  // behind a checkbox the caller has to know to enable.
  if (missingFields.length > 0) {
    const diagnosis = buildSchemaDiagnosis(sobject, describe, payload, resolvedLookups);
    logSchemaDiagnosis(client, describe, diagnosis);
    return {
      ok: false,
      failure: {
        objectName: sobject, restEndpoint, payload, requiredFields, optionalFields, missingFields,
        httpStatus: null, salesforceErrorCode: null, salesforceErrorMessage: formatSchemaDiagnosis(diagnosis), responseBody: null,
      },
    };
  }

  const droppedLookups = resolvedLookups.filter(l => l.field && l.value != null && payload[l.field.name] !== l.value);
  if (droppedLookups.length > 0) {
    const diagnosis = buildSchemaDiagnosis(sobject, describe, payload, resolvedLookups);
    logSchemaDiagnosis(client, describe, diagnosis);
    const droppedSummary = droppedLookups
      .map(l => `${l.targetObject} lookup (${l.field!.name}) resolved to ${l.value} but never made it into the ${sobject} payload.`)
      .join(" ");
    const salesforceErrorMessage = `${droppedSummary}\n\n${formatSchemaDiagnosis(diagnosis)}`;
    client.logDebug("native-create-request", `Cannot create ${sobject} — a resolved lookup value never made it into the payload.\n${droppedSummary}\n\nAttempted payload: ${JSON.stringify(payload, null, 2)}`);
    return {
      ok: false,
      failure: {
        objectName: sobject, restEndpoint, payload, requiredFields, optionalFields,
        missingFields: droppedLookups.map(l => l.field!.name),
        httpStatus: null, salesforceErrorCode: null, salesforceErrorMessage, responseBody: null,
      },
    };
  }

  try {
    const created = await client.createRecord(sobject, payload);
    // §Sequential Workflow — every creation step verifies the record was actually created by querying
    // it back, never trusting the REST create response's returned Id alone.
    const verifiedExists = await verifyRecordExists(client, sobject, created.id);
    if (!verifiedExists) {
      client.logDebug("native-create-response", `${sobject} — createRecord() returned Id ${created.id}, but querying it back (SELECT Id FROM ${sobject} WHERE Id = '${created.id}') found no matching record.`);
      return {
        ok: false,
        failure: {
          objectName: sobject, restEndpoint, payload, requiredFields, optionalFields, missingFields: [],
          httpStatus: null, salesforceErrorCode: null,
          salesforceErrorMessage: `${sobject} ${created.id} was reported as created, but querying it back found no matching record — treating this as a failed create rather than trusting the REST response alone.`,
          responseBody: null,
        },
      };
    }
    logCreateResponse(client, sobject, { success: true, id: created.id });
    return { ok: true, id: created.id };
  } catch (err) {
    if (err instanceof SalesforceError) {
      const responseBody = err.body ?? err.rawText;
      logCreateResponse(client, sobject, { success: false, httpStatus: err.status, errorCode: err.errorCode ?? null, message: err.message, responseBody, payload });
      // §6 — Salesforce REJECTED this record (as opposed to our own pre-flight missing-field check
      // above never even calling createRecord): name exactly which field and why, by cross-referencing
      // whatever field(s) Salesforce's own `fields` array names against THIS object's own Describe —
      // never a generic "create failed" message.
      const offendingFieldNames = extractSalesforceFields(responseBody);
      const rejectionDiagnosis = diagnoseCreateRejection(sobject, describe, payload, err.errorCode ?? null, err.message, offendingFieldNames);
      const salesforceErrorMessage = formatCreateRejectionDiagnosis(rejectionDiagnosis);
      client.logDebug("native-create-response", salesforceErrorMessage);
      return {
        ok: false,
        failure: {
          objectName: sobject, restEndpoint, payload, requiredFields, optionalFields, missingFields: [],
          httpStatus: err.status, salesforceErrorCode: err.errorCode ?? null, salesforceErrorMessage, responseBody,
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    logCreateResponse(client, sobject, { success: false, httpStatus: null, errorCode: null, message, responseBody: null, payload });
    return {
      ok: false,
      failure: {
        objectName: sobject, restEndpoint, payload, requiredFields, optionalFields, missingFields: [],
        httpStatus: null, salesforceErrorCode: null, salesforceErrorMessage: message, responseBody: null,
      },
    };
  }
}

/**
 * §Price-impacting eligibility — whether an attribute is eligible for AttributeAdjustmentCondition /
 * AttributeBasedAdjRule creation, and which real Salesforce record/field controls that. `priceImpacting:
 * null` means "could not be determined" (no matching field discovered via Describe anywhere) — this is
 * deliberately distinct from `false`, since the two require different handling (§ensurePriceImpacting).
 */
interface PriceImpactingStatus {
  priceImpacting: boolean | null;
  controllingObject: "ProductAttributeDefinition" | "AttributeDefinition" | null;
  controllingField: string | null;
  controllingRecordId: string | null;
}

/** §Live progress — one event per native object as its outcome actually becomes known, so a caller
 * streaming this to a UI can show genuinely sequential Running/Completed states instead of a single
 * bulk resolve at the end. `status: "running"` and its resolving `"done"`/`"failed"` are always
 * emitted as a pair for a given `object` — an object never reported "running" here is never reported
 * resolved either (it stayed untouched this run, e.g. skipped after an earlier object failed). */
export interface NativeProgressEvent {
  object: "PriceAdjustmentSchedule" | "AttributeBasedAdjRule" | "AttributeAdjustmentCondition" | "AttributeBasedAdjustment";
  status: "running" | "done" | "failed";
  detail?: string;
}

export interface CreateNativeAttributePricingArgs {
  /** §DeploymentContext — resolved once during Product Discovery and passed in unchanged; every
   * create site in this file reads ProductId/SellingModelId from here, never re-derives its own. */
  context: DeploymentContext;
  procedureName: string;
  entries: NormalizedAttributeEntry[];
  /** §Auto-Fix — when true and the org allows it, a `priceImpacting: false` attribute is updated to
   * true (and the update verified by re-querying) instead of hard-stopping. Defaults to false: flipping
   * this flag can affect every OTHER product/procedure that shares the same attribute/PAD record, so
   * it's opt-in, never silently applied. */
  autoFixPriceImpacting?: boolean;
  /** §Live progress — optional; when omitted this function's behavior is completely unchanged. */
  onProgress?: (event: NativeProgressEvent) => void;
  /** §B — called exactly once, right before Step A (PAS create/reuse) begins, with the complete
   * Attribute JSON Preview for every attribute this run will touch. Optional; when omitted this
   * function's behavior is completely unchanged. */
  onAttributePreview?: (preview: AttributePreviewEntry[]) => void;
}

export async function createNativeAttributePricing(
  client: SalesforceClient,
  args: CreateNativeAttributePricingArgs,
): Promise<{ result: AttrNativeResult; steps: ProcedureStep[] }> {
  trace(client, "ENTER createNativeAttributePricing", { entryCount: args.entries.length });
  args.onProgress?.({ object: "PriceAdjustmentSchedule", status: "running" });
  const steps: ProcedureStep[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // §Step 5 — Final Execution Report: CREATED/REUSED/SKIPPED/FAILED per object. Starts at SKIPPED
  // ("not yet reached this run") and is updated the moment something definitive actually happens to
  // that object — a successful create (CREATED), an existing record adopted via the duplicate check
  // (REUSED — a success outcome, never a failure), a deliberate non-create decision (SKIPPED — e.g.
  // §D4's coverage check), or an attempted-and-rejected createRecord() call (FAILED). For a multi-entry
  // run this reflects the most recent entry's outcome per object — every early return in this function
  // updates it before attaching it to the result, so a never-created object always says exactly why.
  const executionReport: NativeExecutionReport = {
    priceAdjustmentSchedule: { status: "SKIPPED", reason: "Not yet reached this run." },
    attributeBasedAdjRule: { status: "SKIPPED", reason: "Not yet reached this run." },
    attributeAdjustmentCondition: { status: "SKIPPED", reason: "Not yet reached this run." },
    attributeBasedAdjustment: { status: "SKIPPED", reason: "Not yet reached this run." },
  };
  /** §Live progress for Rule/Condition/Adjustment — unlike PriceAdjustmentSchedule (a single clean
   * phase before the entries loop even starts), these three interleave per submitted entry, so there's
   * no single earlier point where "Rule creation" as a whole is known to have started/finished
   * independently of Condition/Adjustment. Reporting them here, once, at the function's single common
   * exit point (`finish` — every one of the dozen+ return paths in the entries loop goes through it)
   * means each object is reported exactly once, with its REAL final outcome, and only if it was
   * actually reached this run (gated on `scheduleId`, which is only ever set once the entries loop is
   * about to begin — an object left "SKIPPED" because an earlier one in the same entry failed is never
   * reported as if it ran at all, matching "never show a step as Running/Completed if it was never
   * executed"). */
  function reportNativeOutcome(object: NativeProgressEvent["object"], entry: { status: string; reason: string }) {
    if (entry.status === "SKIPPED") return;
    args.onProgress?.({ object, status: "running" });
    args.onProgress?.({ object, status: entry.status === "FAILED" ? "failed" : "done", detail: entry.reason });
  }
  /** Every return path in this function goes through here so `executionReport` is never forgotten on one branch and present on another. */
  function finish(overrides: Partial<AttrNativeResult>): { result: AttrNativeResult; steps: ProcedureStep[] } {
    const finalResult: AttrNativeResult = { ...result, ...overrides, executionReport };
    if (finalResult.scheduleId) {
      reportNativeOutcome("AttributeBasedAdjRule", finalResult.executionReport!.attributeBasedAdjRule);
      reportNativeOutcome("AttributeAdjustmentCondition", finalResult.executionReport!.attributeAdjustmentCondition);
      reportNativeOutcome("AttributeBasedAdjustment", finalResult.executionReport!.attributeBasedAdjustment);
    }
    trace(client, "EXIT createNativeAttributePricing", {
      returnValue: {
        success: !overrides.error && !overrides.firstFailure,
        scheduleId: finalResult.scheduleId ?? null,
        ruleIds: finalResult.ruleIds,
        conditionIds: finalResult.conditionIds,
        abaIds: finalResult.abaIds,
        error: finalResult.error ?? null,
      },
    });
    return { result: finalResult, steps };
  }

  // §2 — SchemaCache: each of these 4 objects' Describe is requested exactly once for this run.
  const schemaCache = new SchemaCache(client);
  const [ruleDescribe, conditionDescribe, adjustmentDescribe, pasDescribe] = await Promise.all([
    schemaCache.get("AttributeBasedAdjRule"),
    schemaCache.get("AttributeAdjustmentCondition"),
    schemaCache.get("AttributeBasedAdjustment"),
    schemaCache.get("PriceAdjustmentSchedule"),
  ]);

  // §1/§6 — every lookup field below comes from the ONE generic `resolveReferenceField` (see
  // nativeSchemaResolver.ts), driven purely by each object's own Describe — never an object-specific
  // resolver function, never a hardcoded API name. Non-lookup fields (picklists, dates, flags) are
  // unrelated to lookup resolution and keep using the existing name-pattern helper below.
  const conditionAttrDefField = resolveReferenceField(conditionDescribe, "AttributeDefinition").field;
  const conditionPadField = resolveReferenceField(conditionDescribe, "ProductAttributeDefinition").field;
  // §1/§2 — there is no single "Value" field anymore: AttributeAdjustmentCondition's value column is
  // polymorphic (StringValue/IntegerValue/DoubleValue/BooleanValue/DateValue/DateTimeValue-style), so
  // it's resolved per-attribute from that attribute's own DataType via `resolveConditionValueAssignment`
  // (below), never a single hardcoded field name.
  const conditionOperatorField = findFieldByNamePattern(conditionDescribe, /^Operator$/i);
  const conditionRuleField = resolveReferenceField(conditionDescribe, "AttributeBasedAdjRule").field;
  const conditionProduct2Field = resolveReferenceField(conditionDescribe, "Product2").field;
  // §7 — read-only, for `verifyConditionCoverage` below (never written to a Condition create payload —
  // this org's actual Condition creation logic is unchanged): whether this object exposes a Selling
  // Model lookup at all, discovered the same schema-driven way as every other lookup in this file.
  const conditionPsmField = resolveReferenceField(conditionDescribe, "ProductSellingModel").field;

  const operatorValues = activePicklistValues(conditionOperatorField);
  const wildcardOperator = operatorValues.find(v => /^(any|isanyvalue|anyvalue|all|allvalues|wildcard|\*)$/i.test(v)) ?? null;
  const equalOperator = operatorValues.find(v => /^equal$/i.test(v)) ?? operatorValues[0] ?? null;

  const adjustmentTypeField = findFieldByNamePattern(adjustmentDescribe, /^(AdjustmentType|PriceAdjustmentType)$/i);
  const adjustmentValueField = findFieldByNamePattern(adjustmentDescribe, /^(AdjustmentValue|Amount)$/i);
  const adjustmentValidTypes = activePicklistValues(adjustmentTypeField);
  const adjustmentProduct2Field = resolveReferenceField(adjustmentDescribe, "Product2").field;
  const adjustmentPsmField = resolveReferenceField(adjustmentDescribe, "ProductSellingModel").field;
  const adjustmentRuleField = resolveReferenceField(adjustmentDescribe, "AttributeBasedAdjRule").field;
  const adjustmentScheduleField = resolveReferenceField(adjustmentDescribe, "PriceAdjustmentSchedule").field;
  const adjustmentFromField = findFieldByNamePattern(adjustmentDescribe, /^(EffectiveFrom|StartDate)$/i);
  const adjustmentToField = findFieldByNamePattern(adjustmentDescribe, /^(EffectiveTo|EndDate)$/i);
  // §Duplicate detection (D5) — Salesforce's own FIELD_INTEGRITY_EXCEPTION names "Attribute Conditions"
  // as part of AttributeBasedAdjustment's real business key, NOT the Rule lookup. Resolved the proper
  // schema-driven way first (a reference field whose referenceTo is AttributeAdjustmentCondition);
  // falls back to a label/name keyword match for an org where this isn't a plain reference-type field
  // Salesforce's own relationship metadata would surface — never a hardcoded API name either way.
  const adjustmentConditionField =
    resolveReferenceField(adjustmentDescribe, "AttributeAdjustmentCondition").field ??
    adjustmentDescribe.fields.find(f => /attribute.?condition/i.test(f.label) || /attribute.?condition/i.test(f.name)) ??
    null;

  const ruleProduct2Field = resolveReferenceField(ruleDescribe, "Product2").field;
  const ruleScheduleField = resolveReferenceField(ruleDescribe, "PriceAdjustmentSchedule").field;
  const ruleFromField = findFieldByNamePattern(ruleDescribe, /^(EffectiveFrom|StartDate)$/i);
  const ruleToField = findFieldByNamePattern(ruleDescribe, /^(EffectiveTo|EndDate)$/i);
  const ruleIsActiveField = findFieldByNamePattern(ruleDescribe, /^IsActive$/i);

  const pasScheduleTypeField = findFieldByNamePattern(pasDescribe, /^ScheduleType$/i);
  const pasAdjustmentMethodField = findFieldByNamePattern(pasDescribe, /^AdjustmentMethod$/i);
  const pasProduct2Field = resolveReferenceField(pasDescribe, "Product2").field;
  const pasPsmField = resolveReferenceField(pasDescribe, "ProductSellingModel").field;
  const pasPricebookField = resolveReferenceField(pasDescribe, "Pricebook2").field;
  const pasFromField = findFieldByNamePattern(pasDescribe, /^(EffectiveFrom|StartDate)$/i);
  const pasToField = findFieldByNamePattern(pasDescribe, /^(EffectiveTo|EndDate)$/i);

  const pasName = `${args.procedureName} Attr Schedule`.slice(0, 80);

  // ── Price-impacting field discovery — Salesforce enforces FIELD_INTEGRITY_EXCEPTION ("Ensure that
  // your attribute is price impacting") independently of which lookup mode Condition ends up using, so
  // this is resolved once, up front, from real Describe metadata — never a hardcoded "IsPriceImpacting"
  // API name. Revenue Cloud's own data model puts this flag on ProductAttributeDefinition (the
  // per-product association); AttributeDefinition (the global attribute) is checked as a fallback for
  // orgs that modeled it differently. Neither being found is not itself an error — it just means this
  // pipeline can't verify eligibility ahead of time (§ensurePriceImpacting below treats that as "cannot
  // verify," never as "assume impacting").
  const [padDescribeForPricing, attrDefDescribeForPricing] = await Promise.all([
    schemaCache.get("ProductAttributeDefinition"),
    schemaCache.get("AttributeDefinition"),
  ]);
  const padPriceImpactingField = resolvePriceImpactingField(padDescribeForPricing);
  const attrDefPriceImpactingField = resolvePriceImpactingField(attrDefDescribeForPricing);
  client.logDebug("native-create-request", [
    "Price-impacting field discovery",
    `ProductAttributeDefinition: ${padPriceImpactingField ? `${padPriceImpactingField.name} (updateable: ${padPriceImpactingField.updateable})` : "(no matching field found)"}`,
    `AttributeDefinition: ${attrDefPriceImpactingField ? `${attrDefPriceImpactingField.name} (updateable: ${attrDefPriceImpactingField.updateable})` : "(no matching field found)"}`,
  ].join("\n"));

  // ── §Attribute data-type SOURCE field discovery — §1 (this turn): no label/name heuristics
  // ("Input Type"/"Display Type"/"Attribute Type"/generic "Type") anymore. Discovered from each object's
  // own Describe (already fetched above for price-impacting discovery, so this is zero extra Salesforce
  // calls): AttributeDefinition is checked first (the global attribute), with ProductAttributeDefinition
  // as the fallback source for an org that models data type per-product instead — see
  // `resolveAttributeDataType` below for the actual AttributeDefinition-then-PAD fallback applied per
  // attribute, and `resolveAttributeDataTypeSourceField` (nativeSchemaResolver.ts) for the strict,
  // exact-name-only "DataType" match itself.
  const attrDefDataTypeSourceResolution = resolveAttributeDataTypeSourceField(attrDefDescribeForPricing);
  const padDataTypeSourceResolution = resolveAttributeDataTypeSourceField(padDescribeForPricing);
  const attrDefDataTypeField = attrDefDataTypeSourceResolution.field;
  const padDataTypeField = padDataTypeSourceResolution.field;
  // §4 — every candidate considered (there is at most one per object now — Salesforce disallows
  // duplicate API names, and this resolver only ever looks for the one exact "DataType" name), with
  // why it won or why nothing did.
  function formatDataTypeSourceCandidates(objectName: string, resolution: { field: DescribeField | null; candidates: DescribeField[] }): string {
    if (resolution.candidates.length === 0) return `${objectName}: (no field named exactly "DataType"/"Data Type" found on this object — see §3, no heuristic fallback is attempted)`;
    return [
      `${objectName}:`,
      ...resolution.candidates.map(f => `  - ${f.name} (label: "${f.label}", type: ${f.type}) — WON, exact "DataType" name match`),
    ].join("\n");
  }
  client.logDebug("native-create-request", [
    "Attribute data-type source field discovery — exact-name match only, every candidate shown",
    formatDataTypeSourceCandidates("AttributeDefinition", attrDefDataTypeSourceResolution),
    formatDataTypeSourceCandidates("ProductAttributeDefinition", padDataTypeSourceResolution),
  ].join("\n"));

  // ── Step B: AttributeDefinition per unique attribute name ── (moved ahead of Step A: it's a pure
  // read with no dependency on a schedule existing, and the record-count preview below needs it.)
  // §1 — the data-type source field discovered above is fetched here too (not a separate call): every
  // AttributeAdjustmentCondition value written later is typed off of THIS, never assumed, and never the
  // literal "DataType" name. The price-impacting field (if discovered above on AttributeDefinition
  // rather than ProductAttributeDefinition) is fetched here too, for the same reason.
  const uniqueAttrNames = [...new Set(args.entries.map(e => e.attributeName))];
  const attrDefByName = new Map<string, string>();
  const attrDataTypeByName = new Map<string, string | null>();
  const attrDefPriceImpactingById = new Map<string, boolean | null>();
  if (uniqueAttrNames.length > 0) {
    const selectFields = [
      "Id", "Name",
      ...(attrDefDataTypeField ? [attrDefDataTypeField.name] : []),
      ...(attrDefPriceImpactingField ? [attrDefPriceImpactingField.name] : []),
    ];
    try {
      const res = await client.query<Record<string, unknown> & { Id: string; Name: string }>(
        `SELECT ${selectFields.join(", ")} FROM AttributeDefinition WHERE Name IN (${uniqueAttrNames.map(n => `'${n.replace(/'/g, "\\'")}'`).join(",")})`,
      );
      for (const rec of res.records) {
        attrDefByName.set(rec.Name, rec.Id);
        const rawDataType = attrDefDataTypeField ? (rec[attrDefDataTypeField.name] as string | null | undefined) ?? null : null;
        attrDataTypeByName.set(rec.Name, rawDataType);
        // §3 — one log entry per attribute, exactly the fields requested: Attribute Name/Id, Resolved
        // Datatype Field, Datatype Value, Readable (the SOQL query for this field just succeeded, so it
        // is provably readable in practice — not merely Describe-accessible), Accessible (Describe's own
        // FLS flag), SOQL Value (the literal value this attribute's record returned, pre-classification).
        client.logDebug("native-create-request", [
          "AttributeDefinition data-type resolution",
          `Attribute Name: ${rec.Name}`,
          `Attribute Id: ${rec.Id}`,
          `Resolved Datatype Field: ${attrDefDataTypeField?.name ?? "(none discovered on AttributeDefinition — see field discovery log above)"}`,
          `Datatype Value: ${rawDataType ?? "(not set)"}`,
          `Readable: ${attrDefDataTypeField ? "true (SOQL query succeeded)" : "n/a (no field discovered)"}`,
          `Accessible: ${attrDefDataTypeField ? String(attrDefDataTypeField.accessible ?? "unknown") : "n/a (no field discovered)"}`,
          `SOQL Value: ${rawDataType === null ? "null" : JSON.stringify(rawDataType)}`,
        ].join("\n"));
        if (attrDefPriceImpactingField) {
          const raw = rec[attrDefPriceImpactingField.name];
          attrDefPriceImpactingById.set(rec.Id, typeof raw === "boolean" ? raw : null);
        }
      }
    } catch (err) {
      // Some orgs may not expose the discovered data-type/price-impacting field under the names queried
      // (e.g. it's a formula field with row-level security quirks) — fall back to the bare minimum
      // rather than losing attribute resolution entirely; downstream consumers already treat a missing
      // data type/price-impacting status as "cannot be determined" and stop cleanly with a detailed
      // reason, never a silent guess.
      traceException(client, "Step B AttributeDefinition query (with data-type/price-impacting)", err);
      client.logDebug("native-create-request", `AttributeDefinition query with data-type field "${attrDefDataTypeField?.name ?? "(none)"}" failed — falling back to a minimal Id/Name-only query. This attribute's data type will be looked up on ProductAttributeDefinition instead (§ProductAttributeDefinition fallback). Error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const res = await client.query<{ Id: string; Name: string }>(
          `SELECT Id, Name FROM AttributeDefinition WHERE Name IN (${uniqueAttrNames.map(n => `'${n.replace(/'/g, "\\'")}'`).join(",")})`,
        );
        for (const rec of res.records) attrDefByName.set(rec.Name, rec.Id);
      } catch (err2) {
        traceException(client, "Step B AttributeDefinition query (fallback, minimal)", err2);
        step(steps, "attrdef-resolve", "error", "Failed to resolve AttributeDefinition records by name.", err2 instanceof Error ? err2.message : String(err2));
      }
    }
  }

  // ── Step C: ProductAttributeDefinition (PAD) map + price-impacting eligibility ── (also moved ahead
  // of Step A, same reason.) `priceImpacting: null` means "could not be determined" — this is NEVER
  // treated as true by default (the old `!== false` fallback did exactly that, which is how a genuinely
  // non-price-impacting attribute's Condition create reached Salesforce undetected and came back
  // FIELD_INTEGRITY_EXCEPTION). §4 — the same discovered-datatype-field pattern is queried here too, so
  // an attribute whose AttributeDefinition record didn't expose a usable data type has a real,
  // Describe-driven fallback source (never a second guess at the same field name).
  const padByAttrDefId = new Map<string, { padId: string; status: PriceImpactingStatus }>();
  const padDataTypeByAttrDefId = new Map<string, string | null>();
  const allPriceImpactingAttrDefIds = new Set<string>();
  try {
    const padFields = [
      "Id", "AttributeDefinitionId",
      ...(padDataTypeField ? [padDataTypeField.name] : []),
      ...(padPriceImpactingField ? [padPriceImpactingField.name] : []),
    ];
    const padRes = await client.query<Record<string, unknown> & { Id: string; AttributeDefinitionId: string }>(
      `SELECT ${padFields.join(", ")} FROM ProductAttributeDefinition WHERE Product2Id = '${args.context.productId}' LIMIT 100`,
    );
    for (const rec of padRes.records) {
      const padRaw = padPriceImpactingField ? rec[padPriceImpactingField.name] : undefined;
      let status: PriceImpactingStatus;
      if (padPriceImpactingField && typeof padRaw === "boolean") {
        status = { priceImpacting: padRaw, controllingObject: "ProductAttributeDefinition", controllingField: padPriceImpactingField.name, controllingRecordId: rec.Id };
      } else if (attrDefPriceImpactingField && attrDefPriceImpactingById.has(rec.AttributeDefinitionId)) {
        status = {
          priceImpacting: attrDefPriceImpactingById.get(rec.AttributeDefinitionId) ?? null,
          controllingObject: "AttributeDefinition", controllingField: attrDefPriceImpactingField.name, controllingRecordId: rec.AttributeDefinitionId,
        };
      } else {
        status = {
          priceImpacting: null,
          controllingObject: padPriceImpactingField ? "ProductAttributeDefinition" : null,
          controllingField: padPriceImpactingField?.name ?? null,
          controllingRecordId: padPriceImpactingField ? rec.Id : null,
        };
      }
      padByAttrDefId.set(rec.AttributeDefinitionId, { padId: rec.Id, status });
      if (status.priceImpacting === true) allPriceImpactingAttrDefIds.add(rec.AttributeDefinitionId);

      const padRawDataType = padDataTypeField ? (rec[padDataTypeField.name] as string | null | undefined) ?? null : null;
      padDataTypeByAttrDefId.set(rec.AttributeDefinitionId, padRawDataType);
      // §4 — logged for every PAD record regardless of whether AttributeDefinition already resolved a
      // usable data type, so the fallback attempt is always visible, not only when it's actually used.
      client.logDebug("native-create-request", [
        "ProductAttributeDefinition data-type resolution (fallback source)",
        `Attribute Definition Id: ${rec.AttributeDefinitionId}`,
        `ProductAttributeDefinition Id: ${rec.Id}`,
        `Resolved Datatype Field: ${padDataTypeField?.name ?? "(none discovered on ProductAttributeDefinition — see field discovery log above)"}`,
        `Datatype Value: ${padRawDataType ?? "(not set)"}`,
        `Readable: ${padDataTypeField ? "true (SOQL query succeeded)" : "n/a (no field discovered)"}`,
        `Accessible: ${padDataTypeField ? String(padDataTypeField.accessible ?? "unknown") : "n/a (no field discovered)"}`,
        `SOQL Value: ${padRawDataType === null ? "null" : JSON.stringify(padRawDataType)}`,
      ].join("\n"));
    }
  } catch (err) {
    traceException(client, "Step C PAD query", err);
    step(steps, "pad-resolve", "error", "Failed to resolve ProductAttributeDefinition map for this product.", err instanceof Error ? err.message : String(err));
  }

  /** §2/§4/§6 — the ONE place that decides an attribute's data type: AttributeDefinition first, falling
   * back to ProductAttributeDefinition ONLY when AttributeDefinition didn't expose a usable value (no
   * field discovered at all, or the field exists but this record's value is null/blank) — never both
   * silently merged, never a default. `attrDefId` is optional because the anchor-condition loop (D3)
   * sometimes only has the AttributeDefinition Id (not yet looked up by name) at its call site. */
  function resolveAttributeDataType(attributeName: string, attrDefId: string | null): AttributeDataTypeResolution {
    const fromAttrDef = attrDataTypeByName.get(attributeName);
    const fromPad = attrDefId ? padDataTypeByAttrDefId.get(attrDefId) : undefined;
    // §5 — both sources are already in hand at this point (both were queried unconditionally in Step
    // B/C above, regardless of which one ultimately wins) — whenever BOTH have a real, non-blank value
    // AND they disagree, that disagreement is logged explicitly, together with the precedence decision,
    // instead of silently picking AttributeDefinition and discarding the fact that PAD said something
    // different.
    if (attrDefDataTypeField && fromAttrDef && padDataTypeField && fromPad && fromPad !== fromAttrDef) {
      client.logDebug("native-create-request", [
        "§Datatype source disagreement — AttributeDefinition vs. ProductAttributeDefinition",
        `Attribute Name: ${attributeName}`,
        `AttributeDefinition.${attrDefDataTypeField.name} = "${fromAttrDef}"`,
        `ProductAttributeDefinition.${padDataTypeField.name} = "${fromPad}"`,
        `Precedence decision: AttributeDefinition wins (checked first, per §2/§6) — using "${fromAttrDef}".`,
      ].join("\n"));
    }
    if (attrDefDataTypeField && fromAttrDef) {
      return { rawDataType: fromAttrDef, checkedObject: "AttributeDefinition", checkedField: attrDefDataTypeField.name };
    }
    if (padDataTypeField && fromPad) {
      return { rawDataType: fromPad, checkedObject: "ProductAttributeDefinition", checkedField: padDataTypeField.name };
    }
    // Neither source had a usable value — still report whichever field WAS discovered via Describe (even
    // though its value came back empty/null), so the eventual failure names the exact field that was
    // actually checked instead of just saying "not found" with nothing to point at (§5).
    // AttributeDefinition is reported first since it's always checked first.
    if (attrDefDataTypeField) return { rawDataType: null, checkedObject: "AttributeDefinition", checkedField: attrDefDataTypeField.name };
    if (padDataTypeField) return { rawDataType: null, checkedObject: "ProductAttributeDefinition", checkedField: padDataTypeField.name };
    return { rawDataType: null, checkedObject: null, checkedField: null };
  }

  // ── §Payload Preview (record counts) — computed BEFORE Step A's create/reuse call, i.e. before
  // any REST create request at all. One AttributeBasedAdjRule + one AttributeBasedAdjustment per
  // valid entry; one AttributeAdjustmentCondition per entry PLUS one "anchor" condition per every
  // OTHER price-impacting attribute on the product (§D3) — exactly mirroring the real per-entry
  // logic below, not an approximation.
  let expectedConditionCount = 0;
  for (const e of args.entries) {
    const ownId = attrDefByName.get(e.attributeName) ?? null;
    const ownIsPriceImpacting = ownId ? allPriceImpactingAttrDefIds.has(ownId) : false;
    const otherCount = Math.max(0, allPriceImpactingAttrDefIds.size - (ownIsPriceImpacting ? 1 : 0));
    expectedConditionCount += conditionRuleField ? 1 + otherCount : 0;
  }
  const recordCountPreview: NativeRecordCountPreview[] = [
    { objectName: "PriceAdjustmentSchedule", expectedCount: 1 },
    {
      objectName: "AttributeBasedAdjRule", expectedCount: args.entries.length,
      reason: args.entries.length === 0 ? "No valid attribute pricing rows were submitted (§Row validation filtered all of them out)." : undefined,
    },
    {
      objectName: "AttributeAdjustmentCondition", expectedCount: expectedConditionCount,
      reason: !conditionRuleField
        ? "AttributeAdjustmentCondition has no lookup field back to AttributeBasedAdjRule on this org's schema — no condition can be scoped to a rule at all."
        : (expectedConditionCount === 0 ? "No valid attribute pricing rows were submitted." : undefined),
    },
    {
      objectName: "AttributeBasedAdjustment", expectedCount: args.entries.length,
      reason: args.entries.length === 0 ? "No valid attribute pricing rows were submitted (§Row validation filtered all of them out)." : undefined,
    },
  ];
  client.logDebug("native-create-request", JSON.stringify({ "Record Count Preview": recordCountPreview }, null, 2));

  // ── §B Attribute JSON Preview — EVERY attribute this run will touch (every submitted entry's own
  // attribute, PLUS every other price-impacting attribute that will need an anchor Condition), not just
  // the first (or first failing) one. Computed entirely from data already resolved above (Steps B/C) —
  // zero additional Salesforce calls — and BEFORE any create call (PAS/Rule/Condition/Adjustment) is
  // ever attempted. Replaces the old "first submitted row only" payload-shape preview.
  const previewFirstValueForAttribute = new Map<string, string>();
  for (const e of args.entries) if (!previewFirstValueForAttribute.has(e.attributeName)) previewFirstValueForAttribute.set(e.attributeName, e.attributeValue);

  function buildAttributePreviewEntry(
    attributeName: string,
    attributeValue: string,
    ownEntry: NormalizedAttributeEntry | null,
  ): AttributePreviewEntry {
    const attrDefId = attrDefByName.get(attributeName) ?? null;
    const pad = attrDefId ? padByAttrDefId.get(attrDefId) : undefined;
    const dataType = resolveAttributeDataType(attributeName, attrDefId);
    const isPriceImpacting = pad?.status.priceImpacting ?? (attrDefId ? attrDefPriceImpactingById.get(attrDefId) ?? null : null);

    const conditionPayload: Record<string, unknown> = { [conditionRuleField?.name ?? "(no lookup field to AttributeBasedAdjRule found)"]: "<resolved after AttributeBasedAdjRule create>" };
    if (conditionPadField) conditionPayload[conditionPadField.name] = pad?.padId ?? "(no ProductAttributeDefinition resolved for this attribute)";
    else if (conditionAttrDefField) conditionPayload[conditionAttrDefField.name] = attrDefId ?? "(no AttributeDefinition resolved for this attribute)";
    if (conditionProduct2Field) conditionPayload[conditionProduct2Field.name] = args.context.productId;

    const assignment = resolveConditionValueAssignment(conditionDescribe, attributeName, attrDefId, dataType, attributeValue);
    let conditionValueField: string | null = null;
    let status: "READY" | "BLOCKED" = "BLOCKED";
    let reason: string | null = null;
    if (assignment.ok) {
      conditionValueField = assignment.field.name;
      conditionPayload[assignment.field.name] = assignment.value;
      if (assignment.dataTypeField && assignment.dataTypeValue) conditionPayload[assignment.dataTypeField.name] = assignment.dataTypeValue;
      status = "READY";
    } else {
      reason = formatValueAssignmentFailure(assignment);
    }
    if (conditionOperatorField && equalOperator) conditionPayload[conditionOperatorField.name] = equalOperator;

    const rulePayload: Record<string, unknown> = {};
    const adjustmentPayload: Record<string, unknown> = {};
    if (ownEntry) {
      rulePayload.Name = sanitizeRuleName(attributeName, attributeValue);
      if (ruleProduct2Field) rulePayload[ruleProduct2Field.name] = args.context.productId;
      if (ruleScheduleField) rulePayload[ruleScheduleField.name] = args.context.priceAdjustmentScheduleId ?? "<resolved after PriceAdjustmentSchedule create/reuse>";
      if (ruleFromField) rulePayload[ruleFromField.name] = today;
      if (ruleToField) rulePayload[ruleToField.name] = addYears(today, 1);
      if (ruleIsActiveField) rulePayload[ruleIsActiveField.name] = true;

      if (adjustmentProduct2Field) adjustmentPayload[adjustmentProduct2Field.name] = args.context.productId;
      if (adjustmentPsmField) adjustmentPayload[adjustmentPsmField.name] = args.context.sellingModelId;
      if (adjustmentRuleField) adjustmentPayload[adjustmentRuleField.name] = "<resolved after AttributeBasedAdjRule create>";
      if (adjustmentScheduleField) adjustmentPayload[adjustmentScheduleField.name] = args.context.priceAdjustmentScheduleId ?? "<resolved after PriceAdjustmentSchedule create/reuse>";
      if (adjustmentConditionField) adjustmentPayload[adjustmentConditionField.name] = "<resolved after AttributeAdjustmentCondition create>";
      if (adjustmentTypeField) adjustmentPayload[adjustmentTypeField.name] = resolveAdjustmentType(adjustmentValidTypes, ownEntry.adjustmentType);
      if (adjustmentValueField) adjustmentPayload[adjustmentValueField.name] = ownEntry.adjustmentValue;
      if (adjustmentFromField) adjustmentPayload[adjustmentFromField.name] = today;
      if (adjustmentToField) adjustmentPayload[adjustmentToField.name] = addYears(today, 1);
    }

    return {
      attributeName,
      attributeDefinitionId: attrDefId,
      productAttributeDefinitionId: pad?.padId ?? null,
      dataType: dataType.rawDataType,
      dataTypeSource: dataType.checkedObject && dataType.checkedField ? `${dataType.checkedObject}.${dataType.checkedField}` : null,
      attributeValue,
      isPriceImpacting,
      conditionValueField,
      operator: "equals",
      conditionPayload,
      rulePayload,
      adjustmentPayload,
      status,
      reason,
    };
  }

  const attributePreview: AttributePreviewEntry[] = [];
  const previewSeenNames = new Set<string>();
  for (const e of args.entries) {
    attributePreview.push(buildAttributePreviewEntry(e.attributeName, e.attributeValue, e));
    previewSeenNames.add(e.attributeName);
  }
  for (const otherId of allPriceImpactingAttrDefIds) {
    const otherName = [...attrDefByName.entries()].find(([, id]) => id === otherId)?.[0];
    if (!otherName || previewSeenNames.has(otherName)) continue;
    attributePreview.push(buildAttributePreviewEntry(otherName, previewFirstValueForAttribute.get(otherName) || "N/A", null));
    previewSeenNames.add(otherName);
  }
  client.logDebug("native-create-request", JSON.stringify({
    "§B Attribute JSON Preview": "Every attribute this run will touch, computed before any create call. Values in angle-brackets are not yet knowable (a dependent record hasn't been created yet) — never a guess.",
    product2Id: args.context.productId,
    sellingModelId: args.context.sellingModelId,
    priceAdjustmentScheduleId: args.context.priceAdjustmentScheduleId ?? null,
    attributes: attributePreview,
  }, null, 2));
  args.onAttributePreview?.(attributePreview);

  const result: AttrNativeResult = {
    scheduleCreated: false,
    rulesCreated: 0,
    rulesSkipped: 0,
    conditionsCreated: 0,
    abasCreated: 0,
    abasSkipped: 0,
    ruleIds: [],
    conditionIds: [],
    abaIds: [],
    recordCountPreview,
    attributePreview,
  };

  /* ── Step A: PriceAdjustmentSchedule (reuse or create) ── */
  trace(client, "ENTER Step A (PriceAdjustmentSchedule reuse-or-create)", { pasName });

  let scheduleId: string | null = null;
  try {
    const existing = await client.query<{ Id: string }>(`SELECT Id FROM PriceAdjustmentSchedule WHERE Name = '${pasName.replace(/'/g, "\\'")}' LIMIT 1`);
    scheduleId = existing.records[0]?.Id ?? null;
  } catch (err) {
    // §Step 3 — this used to swallow the exception completely silently (bare `catch {}`) and just
    // fall through to "create a new one" as if the lookup had simply found nothing. Now logged, but
    // behavior is unchanged: a failed existence-check still falls through to attempting a create.
    traceException(client, "Step A existence-check query", err);
    scheduleId = null;
  }

  if (!scheduleId) {
    const scheduleTypeValues = activePicklistValues(pasScheduleTypeField);
    const adjustmentMethodValues = activePicklistValues(pasAdjustmentMethodField);

    // §4 — resolve the actual Price Book only when this object's own schema has somewhere to put it.
    const pricebookId = pasPricebookField ? await resolveStandardPricebookId(client) : null;

    const pasPayload: Record<string, unknown> = { Name: pasName };
    if (pasScheduleTypeField) {
      pasPayload[pasScheduleTypeField.name] = scheduleTypeValues.find(v => /attribute/i.test(v)) ?? scheduleTypeValues[0];
    }
    if (pasAdjustmentMethodField) {
      pasPayload[pasAdjustmentMethodField.name] =
        adjustmentMethodValues.find(v => /attribute/i.test(v)) ??
        adjustmentMethodValues.find(v => !/range|slab|tier|volume/i.test(v)) ??
        adjustmentMethodValues[0];
    }
    if (pasProduct2Field) pasPayload[pasProduct2Field.name] = args.context.productId;
    if (pasPsmField) pasPayload[pasPsmField.name] = args.context.sellingModelId;
    if (pasPricebookField && pricebookId) pasPayload[pasPricebookField.name] = pricebookId;
    if (pasFromField) pasPayload[pasFromField.name] = today;
    if (pasToField) pasPayload[pasToField.name] = addYears(today, 1);
    // Deliberately never set IsActive: true here — attribute-type PAS records in this
    // org spuriously fail validation ("no price adjustment tier") when active on create.

    // §3 — every lookup this create depends on, built via the ONE generic resolver: field === null
    // simply means this object's schema doesn't expose that lookup (not an error, see module header).
    const pasResolvedLookups: ResolvedLookup[] = [
      { targetObject: "Product2", field: pasProduct2Field, value: pasProduct2Field ? args.context.productId : null },
      { targetObject: "ProductSellingModel", field: pasPsmField, value: pasPsmField ? (args.context.sellingModelId ?? null) : null },
      { targetObject: "Pricebook2", field: pasPricebookField, value: pasPricebookField ? pricebookId : null },
    ];

    // §Step 4 — immediately before the createRecord() call inside guardedCreate.
    trace(client, "Creating object: PriceAdjustmentSchedule");
    const outcome = await guardedCreate(client, "PriceAdjustmentSchedule", pasDescribe, pasPayload, pasResolvedLookups);
    trace(client, "EXIT Step A (PriceAdjustmentSchedule reuse-or-create)", { returnValue: outcome.ok ? { ok: true, id: outcome.id } : { ok: false, failure: outcome.failure } });
    if (!outcome.ok) {
      // §Schema diagnosis — guardedCreate now always populates a real, object-specific message (a
      // full schema diagnosis for a missing-fields failure, never the generic "missing fields" list).
      const message = outcome.failure.salesforceErrorMessage ?? "Unknown error.";
      step(steps, "pas-create", "error", "Failed to create PriceAdjustmentSchedule — native records cannot be created without one.", message);
      executionReport.priceAdjustmentSchedule = { status: "FAILED", reason: message };
      args.onProgress?.({ object: "PriceAdjustmentSchedule", status: "failed", detail: message });
      // §Step 2 early exit: return — createRecord() for PriceAdjustmentSchedule FAILED (not skipped).
      return finish({ error: message, firstFailure: outcome.failure });
    }
    scheduleId = outcome.id;
    result.scheduleCreated = true;
    executionReport.priceAdjustmentSchedule = { status: "CREATED", reason: "Created successfully this run." };
    step(steps, "pas-create", "success", `Created PriceAdjustmentSchedule ${scheduleId}.`);
  } else {
    executionReport.priceAdjustmentSchedule = { status: "REUSED", reason: `Existing PriceAdjustmentSchedule matched by Name ("${pasName}").` };
    step(steps, "pas-reuse", "info", `Reusing existing PriceAdjustmentSchedule ${scheduleId}.`);
  }
  result.scheduleId = scheduleId ?? undefined;
  // Enrich the shared context now that this pipeline stage has resolved it — same object reference
  // the caller passed in, so this is visible to route.ts too (§DeploymentContext).
  args.context.priceAdjustmentScheduleId = scheduleId ?? undefined;
  args.onProgress?.({ object: "PriceAdjustmentSchedule", status: "done", detail: scheduleId ?? undefined });

  // First-seen value per attribute across all submitted entries — used for the Equal-operator anchor fallback.
  const firstValueForAttribute = new Map<string, string>();
  for (const e of args.entries) if (!firstValueForAttribute.has(e.attributeName)) firstValueForAttribute.set(e.attributeName, e.attributeValue);

  /**
   * §AttributeBasedAdjustment duplicate detection — fully data-driven, per explicit instruction not to
   * guess a WHERE-clause key. Queries EVERY existing AttributeBasedAdjustment for this Product (never
   * pre-filtered by an assumed business key), resolves each candidate's linked Rule NAME — a stable,
   * deterministic function of (attributeName, attributeValue) this pipeline itself computes, see
   * `sanitizeRuleName` — and compares EVERY field against the payload about to be sent, side-by-side,
   * before deciding whether to reuse.
   *
   * This replaces prior versions of this function, which pre-filtered the SOQL WHERE clause by a
   * specific guessed field set (including the literal AttributeAdjustmentCondition Id). That was
   * empirically proven to produce false negatives: Salesforce rejected a create as a duplicate, but
   * the lookup found zero rows — because the EXISTING record's Condition/Rule Id (from an earlier run)
   * differs from THIS run's freshly-resolved/created Condition/Rule Id, even though both represent the
   * identical (Product, Selling Model, Price Adjustment Schedule, date range, attribute, value)
   * combination. Rule Id is not stable across re-runs; Rule NAME is (it's derived from the same
   * attribute/value every time), so it's used here instead — orthogonal to whatever Salesforce's own
   * internal uniqueness key actually is, never assumed.
   *
   * Match tiers, in order: (1) every comparable field matches exactly, including Condition/Rule Id —
   * an unambiguous duplicate. (2) Product/Selling Model/Price Adjustment Schedule/Effective From/
   * Effective To all match AND the candidate's Rule Name equals this entry's — the fields Salesforce's
   * own FIELD_INTEGRITY_EXCEPTION has named in every occurrence of this error, plus this pipeline's own
   * stable attribute/value identity — still treated as the same logical record even though its
   * Condition/Rule Id differs, since Salesforce would reject the create as a duplicate regardless.
   * Neither tier matching means it's safe to create.
   */
  async function findExistingAdjustment(payload: Record<string, unknown>, ruleName: string, context: "pre-check" | "recovery"): Promise<string | null> {
    if (!adjustmentProduct2Field) {
      client.logDebug("native-create-request", "AttributeBasedAdjustment duplicate lookup — no Product2 lookup discovered on this object's Describe; cannot scope a broad duplicate query.");
      return null;
    }

    // §1/§8/§9 — every field this pipeline can compare, whether or not it turns out to be part of
    // Salesforce's real key — printed and compared below, never assumed in advance.
    const compareFields: { label: string; field: DescribeField | null }[] = [
      { label: "Product", field: adjustmentProduct2Field },
      { label: "Product Selling Model", field: adjustmentPsmField },
      { label: "Price Adjustment Schedule", field: adjustmentScheduleField },
      { label: "AttributeBasedAdjRule", field: adjustmentRuleField },
      { label: "Attribute Adjustment Condition", field: adjustmentConditionField },
      { label: "Effective From", field: adjustmentFromField },
      { label: "Effective To", field: adjustmentToField },
      { label: "Adjustment Type", field: adjustmentTypeField },
      { label: "Adjustment Value", field: adjustmentValueField },
    ];
    const selectFields = ["Id", ...new Set(compareFields.filter((c): c is { label: string; field: DescribeField } => !!c.field).map(c => c.field.name))];
    const soql = `SELECT ${selectFields.join(", ")} FROM AttributeBasedAdjustment WHERE ${adjustmentProduct2Field.name} = '${args.context.productId}'`;
    client.logDebug("native-create-request", `AttributeBasedAdjustment duplicate lookup (${context}) — broad SOQL (Product only; the real duplicate is identified by comparing every field below, never a guessed WHERE clause): ${soql}`);

    let records: (Record<string, unknown> & { Id: string })[] = [];
    try {
      records = (await client.query<Record<string, unknown> & { Id: string }>(soql)).records;
    } catch (err) {
      traceException(client, "findExistingAdjustment", err);
      client.logDebug("native-create-request", `AttributeBasedAdjustment duplicate lookup (${context}) — query failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    // Resolve each candidate's Rule NAME via a batch lookup — never guessed, read straight from
    // Salesforce, and independent of whatever literal Rule Id each candidate happens to carry.
    const ruleIdToName = new Map<string, string>();
    if (adjustmentRuleField) {
      const ruleIds = [...new Set(records.map(r => r[adjustmentRuleField.name] as string | undefined).filter((v): v is string => !!v))];
      if (ruleIds.length > 0) {
        try {
          const ruleRes = await client.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM AttributeBasedAdjRule WHERE Id IN (${ruleIds.map(id => `'${id}'`).join(",")})`);
          for (const rec of ruleRes.records) ruleIdToName.set(rec.Id, rec.Name);
        } catch (err) {
          traceException(client, "findExistingAdjustment (Rule name resolution)", err);
        }
      }
    }

    // §2/§3 — every existing record found, and the payload about to be sent, printed before any
    // per-record comparison.
    client.logDebug("native-create-request", [
      `AttributeBasedAdjustment duplicate lookup (${context}) — ${records.length} existing record(s) found for Product ${args.context.productId}.`,
      "Payload about to be sent:",
      JSON.stringify(payload, null, 2),
    ].join("\n"));

    let bestCandidate: { id: string; diffLabels: string[]; matchCount: number; total: number } | null = null;

    for (const rec of records) {
      // §4 — side-by-side comparison, every field.
      const rows: string[] = [];
      const diffLabels: string[] = [];
      let matchCount = 0;
      let total = 0;
      for (const c of compareFields) {
        if (!c.field) continue;
        total++;
        const candidateValue = rec[c.field.name] != null ? String(rec[c.field.name]) : null;
        const payloadValue = payload[c.field.name] != null ? String(payload[c.field.name]) : null;
        const isMatch = candidateValue === payloadValue;
        if (isMatch) matchCount++; else diffLabels.push(`${c.label} (existing="${candidateValue ?? "(null)"}" vs payload="${payloadValue ?? "(null)"}")`);
        rows.push(`  ${c.label} (${c.field.name}): existing="${candidateValue ?? "(null)"}" vs payload="${payloadValue ?? "(null)"}" -> ${isMatch ? "MATCH" : "DIFFERENT"}`);
      }
      const candidateRuleId = adjustmentRuleField ? (rec[adjustmentRuleField.name] as string | undefined) : undefined;
      const candidateRuleName = candidateRuleId ? ruleIdToName.get(candidateRuleId) ?? null : null;
      rows.push(`  Rule Name (resolved): existing="${candidateRuleName ?? "(unresolved)"}" vs this entry="${ruleName}" -> ${candidateRuleName === ruleName ? "MATCH" : "DIFFERENT"}`);
      client.logDebug("native-create-request", [`AttributeBasedAdjustment duplicate lookup (${context}) — comparing existing record ${rec.Id}:`, ...rows].join("\n"));

      // Tier 1 — exact match on every comparable field.
      if (diffLabels.length === 0) {
        client.logDebug("native-create-request", `AttributeBasedAdjustment duplicate lookup (${context}) — record ${rec.Id} is an EXACT match on every comparable field (including Rule/Condition). Reusing it.`);
        return rec.Id;
      }

      // §5/§7/§9 — Tier 2: Product/Selling Model/Price Adjustment Schedule/Effective From/Effective To
      // are the fields Salesforce's own FIELD_INTEGRITY_EXCEPTION has consistently named; matching by
      // the literal Condition/Rule Id has proven unreliable across re-runs, so Rule NAME substitutes
      // for it here.
      const safeFieldsMatch = [adjustmentProduct2Field, adjustmentPsmField, adjustmentScheduleField, adjustmentFromField, adjustmentToField]
        .every(f => !f || String(rec[f.name] ?? "") === String(payload[f.name] ?? ""));
      const ruleNameMatches = !adjustmentRuleField || candidateRuleName === ruleName;
      if (safeFieldsMatch && ruleNameMatches) {
        client.logDebug("native-create-request", [
          `AttributeBasedAdjustment duplicate lookup (${context}) — record ${rec.Id} matches on Product/Selling Model/Price Adjustment Schedule/Effective From/Effective To${adjustmentRuleField ? " and Rule Name" : ""}, but differs on: ${diffLabels.join("; ")}.`,
          `Treating this as the SAME logical AttributeBasedAdjustment despite the difference (Condition/Rule Ids are known to change across re-runs for the identical attribute/value) — reusing ${rec.Id} rather than attempting a create Salesforce would reject as a duplicate.`,
        ].join(" "));
        return rec.Id;
      }

      if (!bestCandidate || diffLabels.length < bestCandidate.diffLabels.length) {
        bestCandidate = { id: rec.Id, diffLabels, matchCount, total };
      }
    }

    if (records.length > 0) {
      client.logDebug("native-create-request", [
        `AttributeBasedAdjustment duplicate lookup (${context}) — no record among ${records.length} matched closely enough to reuse.`,
        bestCandidate ? `Closest candidate: ${bestCandidate.id} (${bestCandidate.matchCount}/${bestCandidate.total} fields match; differs on: ${bestCandidate.diffLabels.join("; ")}).` : "",
      ].filter(Boolean).join(" "));
    } else {
      client.logDebug("native-create-request", `AttributeBasedAdjustment duplicate lookup (${context}) — zero existing records found for Product ${args.context.productId} at all.`);
    }
    return null;
  }

  /** One AttributeAdjustmentCondition actually queried back for a Rule, with its attribute resolved
   * the same way the rest of this file resolves it (PAD lookup preferred, AttributeDefinition lookup
   * fallback) — kept as an array (not folded straight into a Set) specifically so more than one
   * Condition mapping to the SAME attribute is still visible as a duplicate, not silently absorbed. */
  interface QueriedConditionEntry {
    conditionId: string;
    attrDefId: string | null;
    attributeName: string | null;
  }

  function attrNameForId(attrDefId: string): string {
    return [...attrDefByName.entries()].find(([, id]) => id === attrDefId)?.[0] ?? attrDefId;
  }

  /** §4/§7 — the complete validation report/matrix, built and logged unconditionally (pass or fail) —
   * never only on failure — in the exact shape requested: Product / Rule / Schedule / Price-impacting
   * attributes / Conditions created / Missing conditions / Extra conditions / Duplicate conditions. */
  function formatConditionCoverageReport(args2: {
    ruleId: string; ruleName: string;
    priceImpacting: { attrDefId: string; name: string }[];
    conditions: QueriedConditionEntry[];
    missing: { attrDefId: string; name: string }[];
    extra: QueriedConditionEntry[];
    duplicates: { attrDefId: string; name: string; conditionIds: string[] }[];
  }): string {
    return [
      "==================================================",
      "ATTRIBUTE-BASED ADJUSTMENT — CONDITION COVERAGE VALIDATION",
      "==================================================",
      `Product: ${args.context.productId}`,
      `Rule: ${args2.ruleName} (${args2.ruleId})`,
      `Schedule: ${scheduleId ?? "(none)"}`,
      "",
      "Price-impacting Attributes:",
      ...(args2.priceImpacting.length > 0
        ? args2.priceImpacting.map(a => `  - ${a.name} (${a.attrDefId})`)
        : ["  (none)"]),
      "",
      "Conditions Created (for this Rule):",
      ...(args2.conditions.length > 0
        ? args2.conditions.map(c => `  - ${c.conditionId} -> ${c.attributeName ?? "(attribute could not be resolved)"} (${c.attrDefId ?? "n/a"})`)
        : ["  (none)"]),
      "",
      "Missing Conditions (price-impacting attribute with NO Condition):",
      ...(args2.missing.length > 0 ? args2.missing.map(a => `  - ${a.name} (${a.attrDefId})`) : ["  (none)"]),
      "",
      "Extra Conditions (Condition not tied to a price-impacting attribute on this product):",
      ...(args2.extra.length > 0
        ? args2.extra.map(c => `  - ${c.conditionId} -> ${c.attributeName ?? "(attribute could not be resolved)"} (${c.attrDefId ?? "n/a"})`)
        : ["  (none)"]),
      "",
      "Duplicate Conditions (more than one Condition for the same attribute):",
      ...(args2.duplicates.length > 0
        ? args2.duplicates.map(d => `  - ${d.name} (${d.attrDefId}): ${d.conditionIds.join(", ")}`)
        : ["  (none)"]),
      "==================================================",
    ].join("\n");
  }

  /**
   * §1-§7 — complete, Describe-driven condition-coverage validation, run before EVERY
   * AttributeBasedAdjustment create attempt for a Rule — never just a record count. (1) Re-queries
   * every price-impacting attribute for the product (already resolved in `allPriceImpactingAttrDefIds`
   * — no new lookup logic, no change to how price-impacting itself is determined). (2) Re-queries every
   * AttributeAdjustmentCondition actually linked to this Rule (never trusts this run's own in-memory
   * bookkeeping — a fresh read-back, same principle as `verifyRecordExists`). (3) Compares the two sets.
   * (4) Always logs the full matrix to Debug Mode, whether it passes or fails. (5)/(6) A price-impacting
   * attribute with zero matching Conditions, OR more than one Condition for the same attribute (an
   * ambiguous "duplicate" — "exactly one," not "at least one"), fails validation — createRecord() for
   * AttributeBasedAdjustment is never attempted in that case; the caller stops immediately for this
   * entry, before any REST call, with the full report as its diagnostic. Also confirms every Condition
   * belongs to the same Product/Selling Model (checked only when this org's own Condition schema
   * exposes those lookups). This is exactly what Salesforce's own FIELD_INTEGRITY_EXCEPTION ("Associate
   * all price impacting attributes with the relevant Attribute Adjustment Condition") asks for —
   * catching the gap before ever calling createRecord() rather than letting Salesforce reject it.
   *
   * Explicitly unchanged by this validation: XML/Expression Set generation, Metadata deployment, how an
   * attribute's data type is discovered, and how every lookup field above (`conditionProduct2Field` etc.)
   * is resolved — this function only READS those already-resolved fields, never re-derives them.
   */
  async function verifyConditionCoverage(ruleId: string, ruleName: string): Promise<{ ok: boolean; conditionIds: string[]; issues: string[]; report: string }> {
    const priceImpacting = [...allPriceImpactingAttrDefIds].map(id => ({ attrDefId: id, name: attrNameForId(id) }));

    if (!conditionRuleField) {
      // Unreachable in practice — the D-loop above already hard-stops the whole run if
      // AttributeAdjustmentCondition has no lookup back to AttributeBasedAdjRule at all, long before
      // D4 is ever reached. Guarded here anyway so this function has no unchecked non-null access.
      const issues = ["AttributeAdjustmentCondition has no lookup field back to AttributeBasedAdjRule — cannot verify coverage."];
      const report = formatConditionCoverageReport({ ruleId, ruleName, priceImpacting, conditions: [], missing: priceImpacting, extra: [], duplicates: [] });
      client.logDebug("native-create-request", report);
      return { ok: false, conditionIds: [], issues, report };
    }
    const selectFields = [
      "Id",
      ...(conditionProduct2Field ? [conditionProduct2Field.name] : []),
      ...(conditionPsmField ? [conditionPsmField.name] : []),
      ...(conditionPadField ? [conditionPadField.name] : []),
      ...(conditionAttrDefField ? [conditionAttrDefField.name] : []),
    ];
    const issues: string[] = [];
    let records: (Record<string, unknown> & { Id: string })[] = [];
    try {
      // §2 — collect every AttributeAdjustmentCondition actually created for the current Rule (a fresh
      // query-back, never this run's own in-memory Condition Ids alone).
      const res = await client.query<Record<string, unknown> & { Id: string }>(
        `SELECT ${selectFields.join(", ")} FROM AttributeAdjustmentCondition WHERE ${conditionRuleField.name} = '${ruleId}'`,
      );
      records = res.records;
    } catch (err) {
      traceException(client, "verifyConditionCoverage", err);
      const issue = `Could not query AttributeAdjustmentCondition for Rule ${ruleId}: ${err instanceof Error ? err.message : String(err)}`;
      const report = formatConditionCoverageReport({ ruleId, ruleName, priceImpacting, conditions: [], missing: priceImpacting, extra: [], duplicates: [] });
      client.logDebug("native-create-request", report);
      return { ok: false, conditionIds: [], issues: [issue], report };
    }

    const conditionIds = records.map(r => r.Id);
    const conditionEntries: QueriedConditionEntry[] = records.map(rec => {
      if (conditionProduct2Field) {
        const productId = rec[conditionProduct2Field.name] as string | undefined;
        if (productId && productId !== args.context.productId) {
          issues.push(`Condition ${rec.Id} belongs to Product ${productId}, expected ${args.context.productId}.`);
        }
      }
      if (conditionPsmField && args.context.sellingModelId) {
        const smId = rec[conditionPsmField.name] as string | undefined;
        if (smId && smId !== args.context.sellingModelId) {
          issues.push(`Condition ${rec.Id} belongs to Selling Model ${smId}, expected ${args.context.sellingModelId}.`);
        }
      }
      let attrDefId: string | null = null;
      if (conditionAttrDefField) {
        attrDefId = (rec[conditionAttrDefField.name] as string) ?? null;
      } else if (conditionPadField) {
        const padId = rec[conditionPadField.name] as string | undefined;
        attrDefId = padId ? [...padByAttrDefId.entries()].find(([, v]) => v.padId === padId)?.[0] ?? null : null;
      }
      return { conditionId: rec.Id, attrDefId, attributeName: attrDefId ? attrNameForId(attrDefId) : null };
    });

    // §3 — compare: group this Rule's Conditions by the attribute they cover.
    const entriesByAttrDefId = new Map<string, QueriedConditionEntry[]>();
    for (const e of conditionEntries) {
      if (!e.attrDefId) continue;
      const list = entriesByAttrDefId.get(e.attrDefId) ?? [];
      list.push(e);
      entriesByAttrDefId.set(e.attrDefId, list);
    }

    const missing = priceImpacting.filter(a => !entriesByAttrDefId.has(a.attrDefId));
    const duplicates = [...entriesByAttrDefId.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([attrDefId, list]) => ({ attrDefId, name: attrNameForId(attrDefId), conditionIds: list.map(e => e.conditionId) }));
    // "Extra" = a Condition under this Rule that either couldn't be resolved to any attribute at all, or
    // resolved to an attribute that isn't (currently) price-impacting for this product — informational,
    // never itself a reason to block (§6 only requires every PRICE-IMPACTING attribute to have exactly
    // one Condition; it doesn't forbid an additional one existing for another reason).
    const extra = conditionEntries.filter(e => !e.attrDefId || !allPriceImpactingAttrDefIds.has(e.attrDefId));

    for (const m of missing) {
      issues.push(
        `Price-impacting attribute "${m.name}" has no matching AttributeAdjustmentCondition under Rule ${ruleId} — Salesforce rejects AttributeBasedAdjustment with FIELD_INTEGRITY_EXCEPTION ("Associate all price impacting attributes with the relevant Attribute Adjustment Condition") until every price-impacting attribute has one.`,
      );
    }
    for (const d of duplicates) {
      issues.push(
        `Price-impacting attribute "${d.name}" has ${d.conditionIds.length} AttributeAdjustmentCondition records under Rule ${ruleId} (${d.conditionIds.join(", ")}) — exactly one is required per price-impacting attribute; ambiguous which one AttributeBasedAdjustment should associate with.`,
      );
    }

    const report = formatConditionCoverageReport({ ruleId, ruleName, priceImpacting, conditions: conditionEntries, missing, extra, duplicates });
    // §7 — always logged, pass or fail, never only on a failure.
    client.logDebug("native-create-request", report);

    return { ok: issues.length === 0, conditionIds, issues, report };
  }

  /* ── Step D: per submitted entry — §Stop immediately: the first failed create anywhere in this
     loop (Rule, own Condition, an anchor Condition, or Adjustment) aborts the ENTIRE run right there
     and returns with `firstFailure` populated, rather than skipping to the next entry. */
  for (const [entryIndex, entry] of args.entries.entries()) {
    const ruleName = sanitizeRuleName(entry.attributeName, entry.attributeValue);
    trace(client, "ENTER Step D loop iteration", { entryIndex, attributeName: entry.attributeName, attributeValue: entry.attributeValue, ruleName });

    // Duplicate check — detection itself is unchanged (Name match for Rule, Rule-Id match for
    // Adjustment, both still LIMIT 1 existence checks). What changed is what happens on a match:
    // §Required Fix — an existing Rule (+ linked Adjustment) is a reusable resource, not an absence.
    // Its Id, and every linked Condition/Adjustment Id, are fetched and folded into this run's result
    // exactly as if they had just been created, instead of being skipped and left uncaptured.
    try {
      const existingRule = await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjRule WHERE Name = '${ruleName}' LIMIT 1`);
      if (existingRule.records[0]) {
        const existingRuleId = existingRule.records[0].Id;
        const existingAba = adjustmentRuleField
          ? await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjustment WHERE ${adjustmentRuleField.name} = '${existingRuleId}' LIMIT 1`)
          : { records: [] as { Id: string }[] };
        if (existingAba.records[0]) {
          // 1. Existing Rule Id already in hand (`existingRuleId`). 2/3. Retrieve every linked
          // Condition/Adjustment (no LIMIT — the detection check above only needed to know "at least
          // one exists"; reuse needs all of them).
          let existingConditionIds: string[] = [];
          let existingAbaIds: string[] = [existingAba.records[0].Id];
          try {
            if (conditionRuleField) {
              const existingConditions = await client.query<{ Id: string }>(`SELECT Id FROM AttributeAdjustmentCondition WHERE ${conditionRuleField.name} = '${existingRuleId}'`);
              existingConditionIds = existingConditions.records.map(r => r.Id);
            }
            if (adjustmentRuleField) {
              const allExistingAbas = await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjustment WHERE ${adjustmentRuleField.name} = '${existingRuleId}'`);
              existingAbaIds = allExistingAbas.records.map(r => r.Id);
            }
          } catch (err) {
            traceException(client, `Step D duplicate-reuse linked-record fetch (entry #${entryIndex})`, err);
          }

          // 4. Populate ruleIds/conditionIds/abaIds using the existing records.
          result.ruleIds.push(existingRuleId);
          result.conditionIds.push(...existingConditionIds);
          result.abaIds.push(...existingAbaIds);
          // 5. Continue the pipeline exactly as if these had just been created this run.
          result.rulesCreated++;
          result.conditionsCreated += existingConditionIds.length;
          result.abasCreated += existingAbaIds.length;

          const decision = "Reusing existing native records.";
          trace(client, "Duplicate Rule Found", {
            entryIndex, ruleName, ruleId: existingRuleId, conditionIds: existingConditionIds, abaIds: existingAbaIds, decision,
          });
          step(steps, "entry-reuse-duplicate", "info", `${ruleName} already exists — reusing its existing Rule/Condition/Adjustment records instead of creating new ones.`, {
            ruleId: existingRuleId, conditionIds: existingConditionIds, abaIds: existingAbaIds,
          });

          executionReport.attributeBasedAdjRule = { status: "REUSED", reason: `Existing rule matched by Name ("${ruleName}").` };
          executionReport.attributeAdjustmentCondition = { status: "REUSED", reason: `${existingConditionIds.length} existing condition(s) linked to reused rule ${existingRuleId}.` };
          executionReport.attributeBasedAdjustment = { status: "REUSED", reason: `${existingAbaIds.length} existing adjustment(s) linked to reused rule ${existingRuleId}.` };

          continue;
        }
      }
    } catch (err) {
      // §Step 3 — previously a bare `catch { /* best-effort */ }`: fully silent. Logged now; behavior
      // is unchanged (still falls through to attempting a fresh create for this entry).
      traceException(client, `Step D duplicate-check query (entry #${entryIndex})`, err);
    }

    // D1 — create rule.
    const rulePayload: Record<string, unknown> = { Name: ruleName };
    if (ruleProduct2Field) rulePayload[ruleProduct2Field.name] = args.context.productId;
    if (ruleScheduleField) rulePayload[ruleScheduleField.name] = scheduleId;
    if (ruleFromField) rulePayload[ruleFromField.name] = today;
    if (ruleToField) rulePayload[ruleToField.name] = addYears(today, 1);
    if (ruleIsActiveField) rulePayload[ruleIsActiveField.name] = true;

    // §3/§6 — Product2/PriceAdjustmentSchedule are populated only when AttributeBasedAdjRule's own
    // Describe actually exposes them; a field this org's Rule object doesn't have is simply not part
    // of this payload, and Salesforce's own required-field list (checked in guardedCreate) is the
    // only thing that can still fail this create.
    const ruleResolvedLookups: ResolvedLookup[] = [
      { targetObject: "Product2", field: ruleProduct2Field, value: ruleProduct2Field ? args.context.productId : null },
      { targetObject: "PriceAdjustmentSchedule", field: ruleScheduleField, value: ruleScheduleField ? scheduleId : null },
    ];

    trace(client, "Creating object: AttributeBasedAdjRule", { entryIndex, ruleName });
    const ruleOutcome = await guardedCreate(client, "AttributeBasedAdjRule", ruleDescribe, rulePayload, ruleResolvedLookups);
    trace(client, "EXIT Step D1 (AttributeBasedAdjRule create)", { entryIndex, returnValue: ruleOutcome.ok ? { ok: true, id: ruleOutcome.id } : { ok: false, failure: ruleOutcome.failure } });
    if (!ruleOutcome.ok) {
      result.rulesSkipped++;
      const message = ruleOutcome.failure.salesforceErrorMessage ?? "Unknown error.";
      step(steps, "rule-create", "error", `[ATTR][RULE][STOP] Failed to create rule for ${entry.attributeName}=${entry.attributeValue} — stopping (§Stop immediately).`, message);
      // §Step 2 early exit: return — createRecord() for AttributeBasedAdjRule was attempted and FAILED.
      // §Failure Criteria: this is only a real failure because no existing rule was found (the
      // duplicate check above ran first, found nothing) AND creating a new one also failed.
      executionReport.attributeBasedAdjRule = { status: "FAILED", reason: message };
      executionReport.attributeAdjustmentCondition = { status: "SKIPPED", reason: "AttributeBasedAdjRule create failed on this entry — the run stopped before Condition could be attempted (§Stop immediately)." };
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "AttributeBasedAdjRule create failed on this entry — the run stopped before Adjustment could be attempted (§Stop immediately)." };
      return finish({ error: message, firstFailure: ruleOutcome.failure });
    }
    const ruleId = ruleOutcome.id;
    result.rulesCreated++;
    result.ruleIds.push(ruleId);
    executionReport.attributeBasedAdjRule = { status: "CREATED", reason: "Created successfully this run." };
    step(steps, "rule-create", "success", `Created rule ${ruleName} (${ruleId}).`);

    if (!conditionRuleField) {
      const message = "AttributeAdjustmentCondition has no lookup field back to AttributeBasedAdjRule — cannot scope this rule.";
      step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] ${message}`);
      trace(client, "RETURN Step D (no conditionRuleField)", { entryIndex, reason: message });
      executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — Condition has no lookup field to Rule, so the run stopped before Condition/Adjustment could be attempted." };
      return finish({ error: message });
    }

    // D2 — the entry's own priced condition.
    const ownAttrDefId = attrDefByName.get(entry.attributeName) ?? null;
    const ownPad = ownAttrDefId ? padByAttrDefId.get(ownAttrDefId) : undefined;
    // §2/§4/§6 — AttributeDefinition first, ProductAttributeDefinition as a real Describe-driven
    // fallback (never a hardcoded field name, never both silently merged) — see `resolveAttributeDataType`.
    const ownDataType = resolveAttributeDataType(entry.attributeName, ownAttrDefId);

    // §Price-impacting gate — enforced BEFORE any create for this attribute, regardless of which
    // lookup mode Condition ends up using below: Salesforce's FIELD_INTEGRITY_EXCEPTION ("Ensure that
    // your attribute is price impacting") is tied to the underlying PAD/AttributeDefinition flag, not
    // to which FK happens to be on the Condition payload.
    let ownPriceImpactingStatus: PriceImpactingStatus | null = null;
    if (ownAttrDefId) {
      ownPriceImpactingStatus = ownPad?.status ?? (
        attrDefPriceImpactingField
          ? { priceImpacting: attrDefPriceImpactingById.get(ownAttrDefId) ?? null, controllingObject: "AttributeDefinition", controllingField: attrDefPriceImpactingField.name, controllingRecordId: ownAttrDefId }
          : { priceImpacting: null, controllingObject: null, controllingField: null, controllingRecordId: null }
      );
      const priceImpactingCheck = await ensurePriceImpacting(
        client, entry.attributeName, ownPriceImpactingStatus, padPriceImpactingField, attrDefPriceImpactingField, !!args.autoFixPriceImpacting, steps,
      );
      if (!priceImpactingCheck.ok) {
        step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] "${entry.attributeName}" is not eligible for pricing — refusing to create AttributeAdjustmentCondition.`, priceImpactingCheck.message);
        trace(client, "RETURN Step D2 (attribute not price impacting)", { entryIndex, reason: priceImpactingCheck.message });
        executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: priceImpactingCheck.message };
        executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — the attribute's price-impacting eligibility could not be confirmed before any create was attempted." };
        return finish({ error: priceImpactingCheck.message });
      }
      if (priceImpactingCheck.warning) step(steps, "price-impacting-check", "info", priceImpactingCheck.warning);
    }

    // §1/§2/§4 — resolved ONCE per entry, shared by every mode below: which typed value column this
    // attribute's value belongs in, and (if this object has one) which "data type" declarator value
    // must accompany it. A failure here stops the whole run BEFORE any createRecord() call — never a
    // fallback to a generic string field, never a guess.
    const ownValueAssignment = resolveConditionValueAssignment(conditionDescribe, entry.attributeName, ownAttrDefId, ownDataType, entry.attributeValue);
    logAttributeDataTypeTrace(client, {
      productName: args.context.productName ?? null,
      product2Id: args.context.productId,
      attributeName: entry.attributeName,
      attributeDefinitionId: ownAttrDefId,
      productAttributeDefinitionId: ownPad?.padId ?? null,
      dataType: ownDataType,
      incomingAttributeValue: entry.attributeValue,
      isPriceImpacting: ownPriceImpactingStatus?.priceImpacting ?? null,
      chosenConditionField: ownValueAssignment.ok ? ownValueAssignment.field.name : null,
      operator: equalOperator ?? null,
      attributeBasedAdjRuleId: ruleId,
    });
    if (!ownValueAssignment.ok) {
      const message = formatValueAssignmentFailure(ownValueAssignment);
      step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] Could not determine the value field for "${entry.attributeName}" — refusing to create AttributeAdjustmentCondition.`, message);
      trace(client, "RETURN Step D2 (value field could not be determined)", { entryIndex, reason: message });
      executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — the condition's value field could not be determined before any create was attempted." };
      return finish({ error: message });
    }

    let ownConditionOutcome: { id: string } | { failure: NativeCreateFailureDetail } | null = null;
    if (conditionPadField) {
      // Mode 1: PAD lookup required. (Price-impacting eligibility was already enforced above — this
      // only guards PAD existence, which this mode structurally needs regardless of eligibility.)
      if (!ownPad) {
        const message = `No ProductAttributeDefinition found for "${entry.attributeName}" on this product — cannot populate the required PAD lookup.`;
        step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] ${message}`);
        trace(client, "RETURN Step D2 (no PAD found)", { entryIndex, reason: message });
        executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
        executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — Condition creation was refused (no price-impacting ProductAttributeDefinition) before Adjustment could be attempted." };
        return finish({ error: message });
      }
      const ownConditionPayload: Record<string, unknown> = {
        [conditionRuleField.name]: ruleId,
        [conditionPadField.name]: ownPad.padId,
        ...(conditionProduct2Field ? { [conditionProduct2Field.name]: args.context.productId } : {}),
        [ownValueAssignment.field.name]: ownValueAssignment.value,
        ...(ownValueAssignment.dataTypeField && ownValueAssignment.dataTypeValue ? { [ownValueAssignment.dataTypeField.name]: ownValueAssignment.dataTypeValue } : {}),
        ...(conditionOperatorField && equalOperator ? { [conditionOperatorField.name]: equalOperator } : {}),
      };
      fillRequiredPicklistDefaults(conditionDescribe, ownConditionPayload);
      const ownResolvedLookups: ResolvedLookup[] = [
        { targetObject: "AttributeBasedAdjRule", field: conditionRuleField, value: ruleId },
        { targetObject: "ProductAttributeDefinition", field: conditionPadField, value: ownPad.padId },
        { targetObject: "Product2", field: conditionProduct2Field, value: conditionProduct2Field ? args.context.productId : null },
      ];
      logConditionValueResolution(client, conditionDescribe, entry.attributeName, entry.attributeValue, ownAttrDefId, ownPad?.padId ?? null, ownValueAssignment, ownResolvedLookups, ownConditionPayload);
      trace(client, "Creating object: AttributeAdjustmentCondition (own value, PAD mode)", { entryIndex });
      ownConditionOutcome = await tryCreateCondition(client, conditionDescribe, ownConditionPayload, entry.attributeValue, steps, ownResolvedLookups);
    } else if (conditionAttrDefField) {
      // Mode 2: AttributeDefinition lookup + typed value (no PAD requirement on this org's schema).
      if (!ownAttrDefId) {
        const message = `Could not resolve AttributeDefinition for "${entry.attributeName}".`;
        step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] ${message}`);
        trace(client, "RETURN Step D2 (no AttributeDefinition resolved)", { entryIndex, reason: message });
        executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
        executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — Condition creation was refused (no AttributeDefinition resolved) before Adjustment could be attempted." };
        return finish({ error: message });
      }
      const ownConditionPayload: Record<string, unknown> = {
        [conditionRuleField.name]: ruleId,
        [conditionAttrDefField.name]: ownAttrDefId,
        ...(conditionProduct2Field ? { [conditionProduct2Field.name]: args.context.productId } : {}),
        [ownValueAssignment.field.name]: ownValueAssignment.value,
        ...(ownValueAssignment.dataTypeField && ownValueAssignment.dataTypeValue ? { [ownValueAssignment.dataTypeField.name]: ownValueAssignment.dataTypeValue } : {}),
        ...(conditionOperatorField && equalOperator ? { [conditionOperatorField.name]: equalOperator } : {}),
      };
      fillRequiredPicklistDefaults(conditionDescribe, ownConditionPayload);
      const ownResolvedLookups: ResolvedLookup[] = [
        { targetObject: "AttributeBasedAdjRule", field: conditionRuleField, value: ruleId },
        { targetObject: "AttributeDefinition", field: conditionAttrDefField, value: ownAttrDefId },
        { targetObject: "Product2", field: conditionProduct2Field, value: conditionProduct2Field ? args.context.productId : null },
      ];
      logConditionValueResolution(client, conditionDescribe, entry.attributeName, entry.attributeValue, ownAttrDefId, ownPad?.padId ?? null, ownValueAssignment, ownResolvedLookups, ownConditionPayload);
      trace(client, "Creating object: AttributeAdjustmentCondition (own value, AttributeDefinition mode)", { entryIndex });
      ownConditionOutcome = await tryCreateCondition(client, conditionDescribe, ownConditionPayload, entry.attributeValue, steps, ownResolvedLookups);
    } else {
      // Mode 3 fallback: neither a PAD nor an AttributeDefinition lookup exists on this org's schema —
      // the typed value field (already resolved above) is still populated correctly; there is simply no
      // separate lookup identifying WHICH attribute this condition is for beyond the Rule linkage.
      const ownConditionPayload: Record<string, unknown> = {
        [conditionRuleField.name]: ruleId,
        ...(conditionProduct2Field ? { [conditionProduct2Field.name]: args.context.productId } : {}),
        [ownValueAssignment.field.name]: ownValueAssignment.value,
        ...(ownValueAssignment.dataTypeField && ownValueAssignment.dataTypeValue ? { [ownValueAssignment.dataTypeField.name]: ownValueAssignment.dataTypeValue } : {}),
        ...(conditionOperatorField && equalOperator ? { [conditionOperatorField.name]: equalOperator } : {}),
      };
      fillRequiredPicklistDefaults(conditionDescribe, ownConditionPayload);
      const ownResolvedLookups: ResolvedLookup[] = [
        { targetObject: "AttributeBasedAdjRule", field: conditionRuleField, value: ruleId },
        { targetObject: "Product2", field: conditionProduct2Field, value: conditionProduct2Field ? args.context.productId : null },
      ];
      logConditionValueResolution(client, conditionDescribe, entry.attributeName, entry.attributeValue, ownAttrDefId, ownPad?.padId ?? null, ownValueAssignment, ownResolvedLookups, ownConditionPayload);
      trace(client, "Creating object: AttributeAdjustmentCondition (own value, raw-value fallback mode)", { entryIndex });
      ownConditionOutcome = await tryCreateCondition(client, conditionDescribe, ownConditionPayload, entry.attributeValue, steps, ownResolvedLookups);
    }
    trace(client, "EXIT Step D2 (own condition create)", { entryIndex, returnValue: ownConditionOutcome });

    if (!ownConditionOutcome) {
      const message = `Could not create the priced condition for ${entry.attributeName}=${entry.attributeValue} in any supported mode.`;
      step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] ${message}`);
      trace(client, "RETURN Step D2 (no condition mode matched)", { entryIndex, reason: message });
      executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — no supported Condition creation mode existed on this org's schema." };
      return finish({ error: message });
    }
    if ("failure" in ownConditionOutcome) {
      step(steps, "cond-fatal", "error", `[ATTR][COND][STOP] Failed to create the priced condition for ${entry.attributeName}=${entry.attributeValue} — stopping (§Stop immediately).`, ownConditionOutcome.failure.salesforceErrorMessage);
      trace(client, "RETURN Step D2 (condition create failed)", { entryIndex, reason: ownConditionOutcome.failure.salesforceErrorMessage });
      executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: ownConditionOutcome.failure.salesforceErrorMessage ?? "Condition create failed." };
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "AttributeAdjustmentCondition create failed on this entry — the run stopped before Adjustment could be attempted (§Stop immediately)." };
      return finish({ error: ownConditionOutcome.failure.salesforceErrorMessage ?? "Condition create failed.", firstFailure: ownConditionOutcome.failure });
    }
    const ownConditionId = ownConditionOutcome.id;
    result.conditionsCreated++;
    result.conditionIds.push(ownConditionId);
    executionReport.attributeAdjustmentCondition = { status: "CREATED", reason: "Created successfully this run." };
    // §8/§9/§10 — every Condition Id belonging to THIS entry's Rule specifically (own + every anchor
    // below), as opposed to `result.conditionIds`, which accumulates across the WHOLE run. D5 needs
    // exactly this entry's set to create one AttributeBasedAdjustment per Condition when this org's
    // schema calls for it, and to log the full relationship graph.
    const thisEntryConditionIds: string[] = [ownConditionId];

    // D3 — anchor conditions for every OTHER price-impacting attribute on the product.
    const otherAttrDefIds = [...allPriceImpactingAttrDefIds].filter(id => id !== ownAttrDefId);
    for (const otherId of otherAttrDefIds) {
      const otherPad = padByAttrDefId.get(otherId);
      const otherName = [...attrDefByName.entries()].find(([, id]) => id === otherId)?.[0];
      const anchorPayload: Record<string, unknown> = { [conditionRuleField.name]: ruleId };
      if (conditionPadField && otherPad) anchorPayload[conditionPadField.name] = otherPad.padId;
      else if (conditionAttrDefField) anchorPayload[conditionAttrDefField.name] = otherId;
      if (conditionProduct2Field) anchorPayload[conditionProduct2Field.name] = args.context.productId;

      let anchorRawValue = "";
      let anchorValueAssignment: ConditionValueAssignment | null = null;
      const otherDataType = resolveAttributeDataType(otherName ?? `(attribute ${otherId})`, otherId);
      if (wildcardOperator && conditionOperatorField) {
        anchorPayload[conditionOperatorField.name] = wildcardOperator;
        // "Any value" — deliberately no typed value field set for a wildcard anchor.
      } else if (conditionOperatorField && equalOperator) {
        anchorPayload[conditionOperatorField.name] = equalOperator;
        const fallbackValue = (otherName && firstValueForAttribute.get(otherName)) || "N/A";
        anchorRawValue = fallbackValue;
        const assignment = resolveConditionValueAssignment(conditionDescribe, otherName ?? `(attribute ${otherId})`, otherId, otherDataType, fallbackValue);
        logAttributeDataTypeTrace(client, {
          productName: args.context.productName ?? null,
          product2Id: args.context.productId,
          attributeName: otherName ?? `(attribute ${otherId})`,
          attributeDefinitionId: otherId,
          productAttributeDefinitionId: otherPad?.padId ?? null,
          dataType: otherDataType,
          incomingAttributeValue: fallbackValue,
          isPriceImpacting: otherPad?.status.priceImpacting ?? true,
          chosenConditionField: assignment.ok ? assignment.field.name : null,
          operator: equalOperator ?? null,
          attributeBasedAdjRuleId: ruleId,
        });
        if (!assignment.ok) {
          const message = formatValueAssignmentFailure(assignment);
          step(steps, "cond-fatal", "error", `[ATTR][COND][FATAL] Could not determine the value field for anchor attribute "${otherName ?? otherId}" — refusing to create AttributeAdjustmentCondition.`, message);
          trace(client, "RETURN Step D3 (anchor value field could not be determined)", { entryIndex, otherId, reason: message });
          executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: message };
          executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "Never reached — an anchor condition's value field could not be determined before any create was attempted." };
          return finish({ error: message });
        }
        anchorValueAssignment = assignment;
        anchorPayload[assignment.field.name] = assignment.value;
        if (assignment.dataTypeField && assignment.dataTypeValue) anchorPayload[assignment.dataTypeField.name] = assignment.dataTypeValue;
      }
      fillRequiredPicklistDefaults(conditionDescribe, anchorPayload);
      const anchorResolvedLookups: ResolvedLookup[] = [
        { targetObject: "AttributeBasedAdjRule", field: conditionRuleField, value: ruleId },
        conditionPadField && otherPad
          ? { targetObject: "ProductAttributeDefinition", field: conditionPadField, value: otherPad.padId }
          : { targetObject: "AttributeDefinition", field: conditionAttrDefField, value: conditionAttrDefField ? otherId : null },
        { targetObject: "Product2", field: conditionProduct2Field, value: conditionProduct2Field ? args.context.productId : null },
      ];
      if (anchorValueAssignment) {
        // Only the equal-operator branch chose a value/data-type assignment above — logged here after
        // fillRequiredPicklistDefaults, so the logged payload is the exact final one sent.
        logConditionValueResolution(client, conditionDescribe, otherName ?? `(attribute ${otherId})`, anchorRawValue, otherId, otherPad?.padId ?? null, anchorValueAssignment, anchorResolvedLookups, anchorPayload);
      }
      trace(client, "Creating object: AttributeAdjustmentCondition (anchor)", { entryIndex, otherId });
      const anchorOutcome = await tryCreateCondition(client, conditionDescribe, anchorPayload, anchorRawValue, steps, anchorResolvedLookups);
      trace(client, "EXIT Step D3 (anchor condition create)", { entryIndex, otherId, returnValue: anchorOutcome });
      if (anchorOutcome && "failure" in anchorOutcome) {
        step(steps, "cond-fatal", "error", `[ATTR][COND][STOP] Failed to create an anchor condition for rule ${ruleName} — stopping (§Stop immediately).`, anchorOutcome.failure.salesforceErrorMessage);
        executionReport.attributeAdjustmentCondition = { status: "FAILED", reason: anchorOutcome.failure.salesforceErrorMessage ?? "Anchor condition create failed." };
        executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason: "An anchor AttributeAdjustmentCondition create failed on this entry — the run stopped before Adjustment could be attempted (§Stop immediately)." };
        return finish({ error: anchorOutcome.failure.salesforceErrorMessage ?? "Anchor condition create failed.", firstFailure: anchorOutcome.failure });
      }
      if (anchorOutcome) { result.conditionsCreated++; result.conditionIds.push(anchorOutcome.id); thisEntryConditionIds.push(anchorOutcome.id); }
    }

    // D4 — complete, Describe-driven condition-coverage validation (§1-§7) — a local read-only check,
    // never itself a create call; run before ANY AttributeBasedAdjustment createRecord() for this Rule.
    // A failure here skips just this entry's Adjustment (never calls createRecord() for it), consistent
    // with §Stop immediately only governing actual create requests.
    const coverage = await verifyConditionCoverage(ruleId, ruleName);
    if (!coverage.ok) {
      result.abasSkipped++;
      step(steps, "coverage-fatal", "error", `[ATTR][COND][VERIFY][FATAL] Rule ${ruleName}'s conditions failed condition-coverage validation — refusing to create its AttributeBasedAdjustment(s) to avoid FIELD_INTEGRITY_EXCEPTION.`, { issues: coverage.issues, report: coverage.report });
      const reason = `Entry #${entryIndex} (${entry.attributeName}=${entry.attributeValue}): ${coverage.issues.join(" ")}`;
      trace(client, "CONTINUE Step D loop (condition-coverage validation failed)", { entryIndex, ruleName, issues: coverage.issues });
      executionReport.attributeBasedAdjustment = { status: "SKIPPED", reason };
      continue;
    }

    // D5 — create the AttributeBasedAdjustment(s), or reuse existing ones matching the same business
    // key. §1-§6 — schema discovery is logged once per entry against the payload about to be sent.
    // §8/§9 — when this org's Describe exposes a direct lookup from AttributeBasedAdjustment to
    // AttributeAdjustmentCondition, ONE Adjustment is created PER Condition (own + every anchor) so
    // every price-impacting attribute's Condition ends up associated with an Adjustment, exactly as
    // Salesforce's FIELD_INTEGRITY_EXCEPTION ("Associate all price impacting attributes with the
    // relevant Attribute Adjustment Condition") requires. When this org has no such lookup, this falls
    // back to the original one-Adjustment-per-Rule shape, unchanged from before.
    const abaSchemaPreview: Record<string, unknown> = {};
    if (adjustmentProduct2Field) abaSchemaPreview[adjustmentProduct2Field.name] = args.context.productId;
    if (adjustmentPsmField) abaSchemaPreview[adjustmentPsmField.name] = args.context.sellingModelId;
    if (adjustmentRuleField) abaSchemaPreview[adjustmentRuleField.name] = ruleId;
    if (adjustmentScheduleField) abaSchemaPreview[adjustmentScheduleField.name] = scheduleId;
    if (adjustmentConditionField) abaSchemaPreview[adjustmentConditionField.name] = ownConditionId;
    logAdjustmentSchemaDiscovery(client, adjustmentDescribe, abaSchemaPreview);

    const conditionIdsToLink: (string | null)[] = adjustmentConditionField ? thisEntryConditionIds : [null];
    const abaIdsForEntry: string[] = [];
    let abaFreshlyCreated = 0;
    let abaReused = 0;

    for (const linkedConditionId of conditionIdsToLink) {
      const abaPayload: Record<string, unknown> = {};
      if (adjustmentProduct2Field) abaPayload[adjustmentProduct2Field.name] = args.context.productId;
      if (adjustmentPsmField) abaPayload[adjustmentPsmField.name] = args.context.sellingModelId;
      if (adjustmentRuleField) abaPayload[adjustmentRuleField.name] = ruleId;
      if (adjustmentScheduleField) abaPayload[adjustmentScheduleField.name] = scheduleId;
      if (adjustmentTypeField) abaPayload[adjustmentTypeField.name] = resolveAdjustmentType(adjustmentValidTypes, entry.adjustmentType);
      if (adjustmentValueField) abaPayload[adjustmentValueField.name] = entry.adjustmentValue;
      if (adjustmentFromField) abaPayload[adjustmentFromField.name] = today;
      if (adjustmentToField) abaPayload[adjustmentToField.name] = addYears(today, 1);
      if (adjustmentConditionField && linkedConditionId) abaPayload[adjustmentConditionField.name] = linkedConditionId;

      const linkSuffix = linkedConditionId ? ` (Condition ${linkedConditionId})` : "";

      // §Duplicate detection — before ever calling createRecord(), broadly query every existing
      // AttributeBasedAdjustment for this Product and compare it field-by-field against `abaPayload`
      // (never a guessed WHERE-clause key) — reuse a match instead of attempting a create Salesforce
      // would reject as a duplicate.
      const preExistingAbaId = await findExistingAdjustment(abaPayload, ruleName, "pre-check");
      if (preExistingAbaId) {
        const reason = `Existing AttributeBasedAdjustment ${preExistingAbaId} matched by business key (Product/Product Selling Model/Attribute Conditions/Price Adjustment Schedule/Effective From/Effective To).`;
        result.abasCreated++;
        result.abaIds.push(preExistingAbaId);
        abaIdsForEntry.push(preExistingAbaId);
        abaReused++;
        client.logDebug("native-create-request", `AttributeBasedAdjustment — Reason for reuse: ${reason}`);
        step(steps, "aba-reuse", "info", `Reusing existing AttributeBasedAdjustment ${preExistingAbaId} for ${entry.attributeName}=${entry.attributeValue}${linkSuffix} — already exists for this business key.`);
        trace(client, "CONTINUE Step D5 (AttributeBasedAdjustment reused — pre-check match)", { entryIndex, abaId: preExistingAbaId, linkedConditionId });
        continue;
      }

      // §3/§6/§8 — AttributeAdjustmentCondition is listed here too now (never asserted as "relevant"
      // when this object's own Describe doesn't expose the lookup at all — only what Describe
      // actually has is checked).
      const abaResolvedLookups: ResolvedLookup[] = [
        { targetObject: "Product2", field: adjustmentProduct2Field, value: adjustmentProduct2Field ? args.context.productId : null },
        { targetObject: "ProductSellingModel", field: adjustmentPsmField, value: adjustmentPsmField ? (args.context.sellingModelId ?? null) : null },
        { targetObject: "AttributeBasedAdjRule", field: adjustmentRuleField, value: adjustmentRuleField ? ruleId : null },
        { targetObject: "PriceAdjustmentSchedule", field: adjustmentScheduleField, value: adjustmentScheduleField ? scheduleId : null },
        { targetObject: "AttributeAdjustmentCondition", field: adjustmentConditionField, value: adjustmentConditionField && linkedConditionId ? linkedConditionId : null },
      ];

      trace(client, "Creating object: AttributeBasedAdjustment", { entryIndex, linkedConditionId });
      const abaOutcome = await guardedCreate(client, "AttributeBasedAdjustment", adjustmentDescribe, abaPayload, abaResolvedLookups);
      trace(client, "EXIT Step D5 (AttributeBasedAdjustment create)", { entryIndex, linkedConditionId, returnValue: abaOutcome.ok ? { ok: true, id: abaOutcome.id } : { ok: false, failure: abaOutcome.failure } });
      if (!abaOutcome.ok) {
        // §Duplicate recovery — do NOT attempt another createRecord() here. Salesforce rejected the
        // create as a duplicate business key even though the pre-check above found nothing; immediately
        // re-run the SAME business-key lookup and reuse the match instead of failing — the workflow
        // only actually fails when NEITHER the create NOR this recovery query can produce a record.
        if (abaOutcome.failure.salesforceErrorCode === "FIELD_INTEGRITY_EXCEPTION") {
          client.logDebug("native-create-request", `AttributeBasedAdjustment create for ${entry.attributeName}=${entry.attributeValue}${linkSuffix} was rejected as FIELD_INTEGRITY_EXCEPTION — running duplicate recovery lookup instead of retrying the insert.`);
          const recoveredAbaId = await findExistingAdjustment(abaPayload, ruleName, "recovery");
          if (recoveredAbaId) {
            const reason = `Salesforce rejected the create as a duplicate (FIELD_INTEGRITY_EXCEPTION); found and reused existing AttributeBasedAdjustment ${recoveredAbaId} matching Product/Product Selling Model/Attribute Conditions/Price Adjustment Schedule/Effective From/Effective To.`;
            result.abasCreated++;
            result.abaIds.push(recoveredAbaId);
            abaIdsForEntry.push(recoveredAbaId);
            abaReused++;
            client.logDebug("native-create-request", `AttributeBasedAdjustment — Reason for reuse: ${reason}`);
            step(steps, "aba-reuse", "info", `AttributeBasedAdjustment create for ${entry.attributeName}=${entry.attributeValue}${linkSuffix} hit a duplicate business key — reusing existing record ${recoveredAbaId} instead of failing.`);
            trace(client, "CONTINUE Step D5 (AttributeBasedAdjustment reused — post-failure recovery)", { entryIndex, abaId: recoveredAbaId, linkedConditionId });
            continue;
          }
          client.logDebug("native-create-request", `AttributeBasedAdjustment duplicate recovery lookup found no matching record for ${entry.attributeName}=${entry.attributeValue}${linkSuffix} — treating this as a genuine failure, not a duplicate.`);
        }
        result.abasSkipped++;
        const message = abaOutcome.failure.salesforceErrorMessage ?? "Unknown error.";
        step(steps, "aba-create", "error", `Failed to create AttributeBasedAdjustment for ${entry.attributeName}=${entry.attributeValue}${linkSuffix} — stopping (§Stop immediately).`, message);
        executionReport.attributeBasedAdjustment = { status: "FAILED", reason: message };
        return finish({ error: message, firstFailure: abaOutcome.failure });
      }
      result.abasCreated++;
      result.abaIds.push(abaOutcome.id);
      abaIdsForEntry.push(abaOutcome.id);
      abaFreshlyCreated++;
      step(steps, "aba-create", "success", `Created AttributeBasedAdjustment ${abaOutcome.id} for ${entry.attributeName}=${entry.attributeValue}${linkSuffix}.`);
    }

    // D5b — Verify Adjustments: the explicit "Verify Adjustments" stage of the sequential pipeline
    // (Adjustments -> Verify Adjustments -> Template), mirroring D4's "never trust in-memory bookkeeping
    // alone" philosophy — a fresh query-back against the Rule, not just counting `abaIdsForEntry` in
    // memory. XML/Expression Set generation (the very next stage) must never begin for this run unless
    // this passes.
    if (adjustmentRuleField) {
      let actualAdjustmentCount = -1;
      let verifyIssue: string | null = null;
      try {
        const res = await client.query<{ Id: string }>(`SELECT Id FROM AttributeBasedAdjustment WHERE ${adjustmentRuleField.name} = '${ruleId}'`);
        actualAdjustmentCount = res.records.length;
        if (actualAdjustmentCount < conditionIdsToLink.length) {
          verifyIssue = `Expected at least ${conditionIdsToLink.length} AttributeBasedAdjustment record(s) linked to Rule ${ruleId} (one per Condition), but a fresh query-back found only ${actualAdjustmentCount}.`;
        }
      } catch (err) {
        traceException(client, "verifyAdjustmentCoverage", err);
        verifyIssue = `Could not query AttributeBasedAdjustment for Rule ${ruleId} to verify coverage: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (verifyIssue) {
        step(steps, "adjustment-coverage-fatal", "error", `[ATTR][ADJ][VERIFY][FATAL] ${verifyIssue}`);
        trace(client, "RETURN Step D5b (adjustment coverage verification failed)", { entryIndex, ruleName, expected: conditionIdsToLink.length, actual: actualAdjustmentCount });
        executionReport.attributeBasedAdjustment = { status: "FAILED", reason: verifyIssue };
        return finish({ error: verifyIssue });
      }
    }

    executionReport.attributeBasedAdjustment = {
      status: "CREATED",
      reason: `${abaFreshlyCreated} created, ${abaReused} reused this run (${abaIdsForEntry.length} AttributeBasedAdjustment record(s) total for this entry — ${adjustmentConditionField ? "one per Condition" : "one for the Rule"}).`,
    };
    // §10 — the complete relationship graph, every Salesforce Id, for this entry.
    logRelationshipGraph(client, args.context.productId, ruleId, thisEntryConditionIds, abaIdsForEntry);
  }

  trace(client, "Loop complete — all entries processed", { entryCount: args.entries.length });
  return finish({});
}

/** §2/§4/§5/§6 — one attribute's resolved data type, always paired with exactly which object/field it
 * came from (or, on a failure, WOULD have come from) — see `resolveAttributeDataType` above. Never a
 * bare string: every consumer downstream needs to be able to name the checked object+field, not just
 * the value, for both the pre-create build log (§8) and the failure diagnostic (§5). */
interface AttributeDataTypeResolution {
  rawDataType: string | null;
  /** The object `rawDataType` actually came from — null only when `rawDataType` is also null. */
  checkedObject: "AttributeDefinition" | "ProductAttributeDefinition" | null;
  /** The exact field name checked on `checkedObject` — set whenever a matching field was discovered via
   * Describe on either object, even when its value came back empty (in which case `rawDataType` is null
   * but this still names the field that was actually queried, per §5's "Describe-discovered datatype
   * field"). AttributeDefinition is reported here when both objects exposed a field but neither had a
   * value, since AttributeDefinition is always checked first. */
  checkedField: string | null;
}

interface ConditionValueAssignment {
  ok: true;
  field: DescribeField;
  kind: ValueKind;
  value: unknown;
  dataTypeField: DescribeField | null;
  dataTypeValue: string | null;
  dataType: AttributeDataTypeResolution;
}
interface ConditionValueAssignmentFailure {
  ok: false;
  attributeName: string;
  attributeDefinitionId: string | null;
  dataType: AttributeDataTypeResolution;
  expectedFieldDescription: string;
  reason: string;
}

/**
 * §1/§2/§4/§6/§7 — AttributeAdjustmentCondition's value is polymorphic: which column actually holds it
 * depends on the attribute's OWN Salesforce data type — discovered dynamically (see
 * `resolveAttributeDataType` above: AttributeDefinition first, ProductAttributeDefinition as a real
 * fallback, never a hardcoded "DataType" API name and never both silently merged) — and never a single
 * hardcoded "Value"/"AttributeValue" field either; that hardcoded-name approach is exactly what produced
 * Salesforce's "Select a data type" validation error, since no "which column is active" declarator field
 * was ever populated. Returns a detailed failure (never throws, never guesses a fallback, never defaults
 * to Text) when the datatype can't be classified, when this object's schema has no matching typed value
 * column, or when a required "data type" picklist has no active value matching this attribute's kind —
 * in every one of those cases the caller stops BEFORE any createRecord() is attempted (§4/§6/§9):
 * AttributeBasedAdjustment must never run after this returns a failure, and every call site honors that.
 */
function resolveConditionValueAssignment(
  conditionDescribe: DescribeResult,
  attributeName: string,
  attributeDefinitionId: string | null,
  dataType: AttributeDataTypeResolution,
  rawValue: string,
): ConditionValueAssignment | ConditionValueAssignmentFailure {
  const kind = classifyAttributeDataType(dataType.rawDataType);
  if (kind === "unknown") {
    return {
      ok: false, attributeName, attributeDefinitionId, dataType,
      expectedFieldDescription: "a value field on AttributeAdjustmentCondition matching this attribute's Salesforce data type",
      reason: dataType.rawDataType
        ? `"${dataType.rawDataType}" (from ${dataType.checkedObject}.${dataType.checkedField}) for "${attributeName}" doesn't map to any known value kind (string/integer/double/boolean/date/datetime/picklist/multipicklist).`
        : dataType.checkedField
          ? `${dataType.checkedObject}.${dataType.checkedField} is not set (or could not be read) for "${attributeName}".`
          : `No datatype field could be discovered via Describe on AttributeDefinition or ProductAttributeDefinition for "${attributeName}".`,
    };
  }
  const valueFieldRes = resolveTypedValueField(conditionDescribe, kind);
  if (!valueFieldRes.field) {
    return {
      ok: false, attributeName, attributeDefinitionId, dataType,
      expectedFieldDescription: `the explicit "${kind}" target field on AttributeAdjustmentCondition (see the ValueKind -> field mapping in nativeSchemaResolver.ts)`,
      reason: valueFieldRes.candidates.length > 0
        ? `AttributeAdjustmentCondition has a matching field [${valueFieldRes.candidates.map(c => c.field.name).join(", ")}], but it isn't createable.`
        : `AttributeAdjustmentCondition has no field matching the explicit "${kind}" target name on this org — never falling back to a different field.`,
    };
  }
  // §6/§7/§9 — the LAST line of defense: even though `resolveTypedValueField` only ever returns
  // `BooleanValue` when `kind === "boolean"` (an explicit name match, never inferred from Describe
  // `type` or a field label), this asserts directly on the field actually chosen — if it's the boolean
  // target and the raw incoming value isn't unambiguously "true"/"false", refuse outright rather than
  // silently coercing it (the old `/^(true|yes|1)$/` coercion would have turned "RAM 32GB" into a
  // "valid" `false` and let it through). `createRecord()` is never reached when this fires — the D2/D3
  // callers `return`/`continue` immediately on any `ok:false` result, exactly as for every other failure
  // here.
  if (kind === "boolean" && !/^(true|false)$/i.test(rawValue)) {
    return {
      ok: false, attributeName, attributeDefinitionId, dataType,
      expectedFieldDescription: `${valueFieldRes.field.name} requires a literal "true" or "false" value`,
      reason: `Invalid payload: attempted to send a non-boolean value to BooleanValue. Incoming value "${rawValue}" for "${attributeName}" is not "true"/"false".`,
    };
  }
  const dataTypeFieldRes = resolveDataTypeField(conditionDescribe, kind);
  if (dataTypeFieldRes.field && !dataTypeFieldRes.value && getRequiredFields(conditionDescribe).includes(dataTypeFieldRes.field.name)) {
    return {
      ok: false, attributeName, attributeDefinitionId, dataType,
      expectedFieldDescription: `an active picklist value on ${dataTypeFieldRes.field.name} matching "${kind}"`,
      reason: `${dataTypeFieldRes.field.name} is required but no active picklist value on it matches this attribute's data type ("${kind}").`,
    };
  }
  return {
    ok: true, field: valueFieldRes.field, kind, value: convertValueForField(rawValue, kind, valueFieldRes.field),
    dataTypeField: dataTypeFieldRes.field, dataTypeValue: dataTypeFieldRes.value, dataType,
  };
}

/** §5 — the exact structured diagnostic requested: Attribute Name / Attribute Id / Describe-discovered
 * datatype field / Returned value / Expected Condition value field / Reason for failure. Stops ONLY this
 * attribute — the caller (D2/D3) always returns immediately after this, before any createRecord() call
 * for Condition OR Adjustment (§9). */
function formatValueAssignmentFailure(f: ConditionValueAssignmentFailure): string {
  return [
    `Attribute Name: ${f.attributeName}`,
    `Attribute Id: ${f.attributeDefinitionId ?? "(not resolved)"}`,
    `Describe-discovered datatype field: ${f.dataType.checkedField ? `${f.dataType.checkedObject}.${f.dataType.checkedField}` : "(no datatype-shaped field discovered via Describe on AttributeDefinition or ProductAttributeDefinition)"}`,
    `Returned value: ${f.dataType.rawDataType ?? "(not set)"}`,
    `Expected Condition value field: ${f.expectedFieldDescription}`,
    `Reason for failure: ${f.reason}`,
  ].join("\n");
}

/**
 * §1 — the complete datatype-resolution trace, in the exact 8-field shape requested, logged for EVERY
 * attribute this pipeline resolves a Condition value for (the entry's own attribute, and every anchor
 * attribute) — on BOTH the success and failure path, so tracing "where does attribute X's datatype come
 * from and what did it become" never requires cross-referencing multiple separate log entries. Never
 * called from anywhere that could still call createRecord() before this has run.
 */
function logAttributeDataTypeTrace(
  client: SalesforceClient,
  args: {
    productName: string | null;
    product2Id: string;
    attributeName: string;
    attributeDefinitionId: string | null;
    productAttributeDefinitionId: string | null;
    dataType: AttributeDataTypeResolution;
    incomingAttributeValue: string;
    isPriceImpacting: boolean | null;
    chosenConditionField: string | null;
    operator: string | null;
    attributeBasedAdjRuleId: string | null;
  },
): void {
  // §A — one complete, deterministic JSON object per attribute, logged before every
  // AttributeAdjustmentCondition create attempt (own + every anchor), in the exact field set requested.
  // Never called from anywhere that could still call createRecord() before this has run.
  client.logDebug("native-create-request", JSON.stringify({
    "§log": "AttributeAdjustmentCondition — pre-create datatype resolution",
    productName: args.productName,
    product2Id: args.product2Id,
    attributeName: args.attributeName,
    attributeDefinitionId: args.attributeDefinitionId,
    productAttributeDefinitionId: args.productAttributeDefinitionId,
    dataTypeSourceObject: args.dataType.checkedObject,
    dataTypeSourceField: args.dataType.checkedField,
    resolvedDataType: args.dataType.rawDataType,
    incomingAttributeValue: args.incomingAttributeValue,
    isPriceImpacting: args.isPriceImpacting,
    selectedConditionValueField: args.chosenConditionField,
    operator: args.operator,
    attributeBasedAdjRuleId: args.attributeBasedAdjRuleId,
  }, null, 2));
}

/**
 * §8 — logged before every single AttributeAdjustmentCondition create (own condition and every
 * anchor), in the exact template requested.
 */
function logConditionValueResolution(
  client: SalesforceClient,
  conditionDescribe: DescribeResult,
  attributeName: string,
  attributeValue: string,
  attributeDefinitionId: string | null,
  productAttributeDefinitionId: string | null,
  assignment: ConditionValueAssignment,
  resolvedLookups: ResolvedLookup[],
  payload: Record<string, unknown>,
): void {
  client.logDebug("native-create-request", [
    "------------------------------------------------",
    "ATTRIBUTE CONDITION BUILD",
    "------------------------------------------------",
    `Attribute Name: ${attributeName}`,
    `Attribute Id: ${attributeDefinitionId ?? "(not resolved)"}`,
    `Datatype Field: ${assignment.dataType.checkedField ? `${assignment.dataType.checkedObject}.${assignment.dataType.checkedField}` : "(none discovered)"}`,
    `Datatype: ${assignment.dataType.rawDataType ?? "(not set)"} -> ${assignment.kind}`,
    `Resolved Value Field: ${assignment.field.name}`,
    `Condition Value: ${attributeValue}`,
    `ProductAttributeDefinition Id: ${productAttributeDefinitionId ?? "(none)"}`,
    `AttributeDefinition Id: ${attributeDefinitionId ?? "(none)"}`,
    `Payload: ${JSON.stringify(payload, null, 2)}`,
    "------------------------------------------------",
  ].join("\n"));

  // Supplementary detail (not part of the required template above, kept for the same debugging depth
  // this file already relies on elsewhere): the data-type DECLARATOR field/value on Condition itself
  // (distinct from the SOURCE datatype field on AttributeDefinition/PAD logged above), every lookup this
  // create attempted, and any required field still missing from the final payload.
  const missing = getMissingFields(conditionDescribe, payload);
  client.logDebug("native-create-request", [
    "AttributeAdjustmentCondition — additional pre-create detail",
    assignment.dataTypeField ? `Chosen Condition Data Type Field: ${assignment.dataTypeField.name} = ${assignment.dataTypeValue ?? "(not set)"}` : "Condition Data Type Field: (this object has none)",
    "Chosen Lookup Fields:",
    ...(resolvedLookups.length > 0
      ? resolvedLookups.map(l => `  - ${l.targetObject}: ${l.field?.name ?? "(not found on this object)"} = ${l.value ?? "(none)"}`)
      : ["  (none)"]),
    `Missing Required Fields: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
  ].join("\n"));
}

interface PriceImpactingCheckFailure {
  attributeName: string;
  currentStatus: boolean | null;
  reason: string;
  controllingField: string | null;
  suggestedFix: string;
}

/** §4 — the exact structured error requested: Attribute Name / Current Status / Reason / Controlling Field / Suggested Fix. */
function formatPriceImpactingFailure(f: PriceImpactingCheckFailure): string {
  return [
    `Attribute Name: ${f.attributeName}`,
    `Current Price Impacting Status: ${f.currentStatus === null ? "(could not be determined)" : String(f.currentStatus)}`,
    `Reason: ${f.reason}`,
    `Exact Salesforce Field: ${f.controllingField ?? "(not discovered via Describe)"}`,
    `Suggested Fix: ${f.suggestedFix}`,
  ].join("\n");
}

/**
 * §Price-impacting gate — Salesforce rejects AttributeAdjustmentCondition/AttributeBasedAdjRule
 * creation with FIELD_INTEGRITY_EXCEPTION ("Ensure that your attribute is price impacting") when the
 * underlying flag is false, independent of which lookup mode Condition ends up using. Called once per
 * attribute BEFORE any create is attempted for it:
 *   - `priceImpacting === true` -> proceed.
 *   - `priceImpacting === null` (no matching field discovered anywhere) -> proceed, but with a warning
 *     — this pipeline genuinely can't verify eligibility on this org, and always refusing here would
 *     block orgs that don't enforce this rule at all. Never silently treated as "impacting" though —
 *     the caller surfaces the warning rather than swallowing it.
 *   - `priceImpacting === false` -> refuse, UNLESS `autoFix` is on and the controlling field is
 *     updateable, in which case it's flipped to true and the update is verified by re-querying before
 *     continuing — never assumed to have landed just because the update call didn't throw.
 */
async function ensurePriceImpacting(
  client: SalesforceClient,
  attributeName: string,
  status: PriceImpactingStatus,
  padPriceImpactingField: DescribeField | null,
  attrDefPriceImpactingField: DescribeField | null,
  autoFix: boolean,
  steps: ProcedureStep[],
): Promise<{ ok: true; warning?: string } | { ok: false; message: string }> {
  if (status.priceImpacting === true) return { ok: true };

  const controllingFieldLabel = status.controllingObject && status.controllingField ? `${status.controllingObject}.${status.controllingField}` : null;

  if (status.priceImpacting === null) {
    return {
      ok: true,
      warning: `Could not determine whether "${attributeName}" is price impacting — no boolean field matching "price impacting" (or an equivalent pricing-eligibility flag) was discovered via Describe on ProductAttributeDefinition or AttributeDefinition for this org. Proceeding, but Salesforce may still reject this create with FIELD_INTEGRITY_EXCEPTION if this attribute genuinely isn't price impacting.`,
    };
  }

  // priceImpacting === false from here on.
  if (autoFix && status.controllingObject && status.controllingField && status.controllingRecordId) {
    const field = status.controllingObject === "ProductAttributeDefinition" ? padPriceImpactingField : attrDefPriceImpactingField;
    if (field?.updateable) {
      client.logDebug("native-create-request", `Auto-fixing price-impacting eligibility for "${attributeName}" — updating ${controllingFieldLabel} on ${status.controllingRecordId} to true.`);
      try {
        await client.updateRecord(status.controllingObject, status.controllingRecordId, { [status.controllingField]: true });
        const verifyRes = await client.query<Record<string, unknown>>(`SELECT ${status.controllingField} FROM ${status.controllingObject} WHERE Id = '${status.controllingRecordId}'`);
        const verified = verifyRes.records[0]?.[status.controllingField] === true;
        if (verified) {
          status.priceImpacting = true; // Mutates the shared map entry so subsequent reads (anchor attributes sharing this PAD/AttributeDefinition) see the fix too.
          step(steps, "price-impacting-autofix", "success", `Auto-fixed: "${attributeName}" is now marked Price Impacting (${controllingFieldLabel}).`);
          return { ok: true };
        }
        step(steps, "price-impacting-autofix", "error", `Auto-fix update for "${attributeName}" (${controllingFieldLabel}) did not verify as true after re-querying.`);
      } catch (err) {
        traceException(client, `Auto-fix price-impacting for "${attributeName}"`, err);
        step(steps, "price-impacting-autofix", "error", `Auto-fix update for "${attributeName}" (${controllingFieldLabel}) failed.`, err instanceof Error ? err.message : String(err));
      }
      // Falls through to the failure below — auto-fix was attempted but didn't succeed/verify.
    } else {
      step(steps, "price-impacting-autofix", "error", `Auto-Fix is enabled, but ${controllingFieldLabel ?? "the controlling field"} is not updateable via the API for this org's field-level security/permissions — cannot auto-fix.`);
    }
  }

  const updateableNote = controllingFieldLabel
    ? ` (updateable via API: ${(status.controllingObject === "ProductAttributeDefinition" ? padPriceImpactingField : attrDefPriceImpactingField)?.updateable ?? "unknown"})`
    : "";
  return {
    ok: false,
    message: formatPriceImpactingFailure({
      attributeName,
      currentStatus: false,
      reason: `Salesforce rejects AttributeAdjustmentCondition/AttributeBasedAdjRule for this attribute with FIELD_INTEGRITY_EXCEPTION ("Ensure that your attribute is price impacting") until ${controllingFieldLabel ?? "the controlling field"} is true.`,
      controllingField: controllingFieldLabel ? `${controllingFieldLabel}${updateableNote}` : null,
      suggestedFix: controllingFieldLabel
        ? `In Salesforce Setup, edit the ${status.controllingObject} record (${status.controllingRecordId}) and set ${status.controllingField} to true — or enable the Auto-Fix option and re-run (requires the field to be API-updateable).`
        : "Locate and enable this attribute's pricing-eligibility flag in Salesforce Setup, then re-run.",
    }),
  };
}

/** Returns the created record's Id, or the failure detail if every attempt (including retries) failed — the caller decides whether to hard-stop. */
async function tryCreateCondition(
  client: SalesforceClient,
  conditionDescribe: DescribeResult,
  payload: Record<string, unknown>,
  rawValue: string,
  steps: ProcedureStep[],
  resolvedLookups: ResolvedLookup[],
): Promise<{ id: string } | { failure: NativeCreateFailureDetail } | null> {
  trace(client, "ENTER tryCreateCondition");
  const first = await guardedCreate(client, "AttributeAdjustmentCondition", conditionDescribe, payload, resolvedLookups);
  if (first.ok) {
    trace(client, "EXIT tryCreateCondition", { returnValue: { id: first.id } });
    return { id: first.id };
  }

  if (first.failure.missingFields.length > 0) {
    step(steps, "cond-create-error", "error", first.failure.salesforceErrorMessage ?? "Unknown error.");
    trace(client, "EXIT tryCreateCondition", { returnValue: { failure: "missing required fields", missingFields: first.failure.missingFields } });
    return { failure: first.failure };
  }

  const message = first.failure.salesforceErrorMessage ?? "";
  if (!/FIELD_INTEGRITY_EXCEPTION/i.test(message)) {
    step(steps, "cond-create-error", "error", "AttributeAdjustmentCondition create failed.", message);
    trace(client, "EXIT tryCreateCondition", { returnValue: { failure: message } });
    return { failure: first.failure };
  }

  // Retry 1: swap the raw string value for a resolved picklist-value FK, if this object has one. This
  // is a blind, name-pattern-based retry heuristic (there's no known target OBJECT name to resolve —
  // just "does some field's API name suggest a picklist-value FK"), not a lookup-to-a-known-object
  // resolution, so it stays a direct name-pattern search rather than going through resolveReferenceField.
  const picklistValueField = conditionDescribe.fields.find(f => f.type === "reference" && /picklistvalue/i.test(f.name));
  if (picklistValueField && !(picklistValueField.name in payload) && rawValue) {
    client.logDebug("retry", `AttributeAdjustmentCondition FIELD_INTEGRITY_EXCEPTION — retrying with ${picklistValueField.name} instead of the raw value.`);
    const retry1 = await guardedCreate(client, "AttributeAdjustmentCondition", conditionDescribe, { ...payload, [picklistValueField.name]: rawValue }, resolvedLookups);
    if (retry1.ok) {
      trace(client, "EXIT tryCreateCondition", { returnValue: { id: retry1.id }, note: "succeeded on retry 1 (picklist-value FK)" });
      return { id: retry1.id };
    }
  }

  // Retry 2: inject the missing PAD FK if one was resolved for this attribute and isn't already on the
  // payload — via the SAME generic resolver the main path uses, so this never disagrees with it.
  const padField = resolveReferenceField(conditionDescribe, "ProductAttributeDefinition").field;
  const padValue = resolvedLookups.find(l => l.targetObject === "ProductAttributeDefinition")?.value ?? null;
  if (padField && padValue && !(padField.name in payload)) {
    client.logDebug("retry", `AttributeAdjustmentCondition FIELD_INTEGRITY_EXCEPTION — retrying with ${padField.name} = ${padValue} (ProductAttributeDefinition FK).`);
    const retry2 = await guardedCreate(client, "AttributeAdjustmentCondition", conditionDescribe, { ...payload, [padField.name]: padValue }, resolvedLookups);
    if (retry2.ok) {
      trace(client, "EXIT tryCreateCondition", { returnValue: { id: retry2.id }, note: "succeeded on retry 2 (PAD FK)" });
      return { id: retry2.id };
    }
  }
  step(steps, "cond-create-error", "error", "AttributeAdjustmentCondition create failed after retries.", message);
  trace(client, "EXIT tryCreateCondition", { returnValue: { failure: message }, note: "all retries exhausted" });
  return { failure: first.failure };
}
