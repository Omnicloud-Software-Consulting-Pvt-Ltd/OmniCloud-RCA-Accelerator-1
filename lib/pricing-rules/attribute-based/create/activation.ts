/**
 * Part P — activates a deployed ExpressionSetVersion. Never fatal: an
 * activation failure (or a read-back that doesn't confirm it) leaves the
 * version in Draft and is surfaced as a warning, not a pipeline failure —
 * the metadata has already deployed successfully by the time this runs.
 *
 * §Final Fix — a live run proved `ExpressionSetVersion` has no string "Status" field
 * ("HTTP 400 INVALID_FIELD: No such column 'Status' on sobject of type ExpressionSetVersion"). The
 * real, documented Salesforce field is `IsActive` (Boolean) — confirmed via Salesforce's own Industries
 * Reference (developer.salesforce.com ExpressionSetVersion SObject reference); there is no separate
 * activation Action/endpoint for this object (confirmed via the same reference's Expression Set Actions
 * page — the only documented action is `runExpressionSet`, for INVOKING an already-active version, not
 * activating one). Activation is therefore a normal SObject field update — but the field name is still
 * Describe-verified live here (`pickActiveField`/`describeExpressionSetVersionSchema`), never hardcoded,
 * so a real-world field name is used as the PRIORITY CANDIDATE, not asserted blindly.
 */
import { SalesforceError, type SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import type { ProcedureStepLite } from "../types";
import { buildFailureDiagnostics } from "./errorDiagnostics";
import { describeExpressionSetVersionSchema, fetchExpressionSetViaConnectRest } from "./verifySalesforceState";

function step(steps: ProcedureStepLite[], name: string, status: ProcedureStepLite["status"], message: string) {
  steps.push({ step: name, status, message, timestamp: Date.now() });
}

/** §"Do not report success merely because the request returned HTTP 200/201" — every field this pipeline
 * (and the UI's audit panel) needs to answer "was activation genuinely attempted, and what actually
 * happened" without re-deriving it from a bare "Draft"/"Active" string. */
export interface ActivationAttemptDetail {
  attempted: boolean;
  endpoint: string;
  field: string | null;
  fieldType: "boolean" | "string" | null;
  httpStatus: number | null;
  salesforceErrorCode: string | null;
  salesforceErrorMessage: string | null;
  /** True only once a POST-activation read-back independently confirmed the Active/enabled state — an
   * HTTP success on the update request alone is never sufficient. */
  readBackConfirmed: boolean;
  /** Best-effort cross-check against the SAME Business Rules Connect REST resource already used for
   * resolution — non-blocking; a failure here never overrides the direct SOQL read-back above. */
  connectRestCrossCheck?: { attempted: boolean; confirmedActive: boolean | null; note: string };
}

/** §"activation success without post-readback must still be treated as unverified" — pure, directly
 * testable: an HTTP-successful update alone never counts. `rawValue` is whatever the read-back query
 * actually returned for the activation field (possibly `undefined`, if the query somehow returned no
 * row or the field wasn't selected) — only an exact, correctly-typed match counts as confirmed. */
export function isActivationConfirmed(fieldType: "boolean" | "string", rawValue: unknown): boolean {
  return fieldType === "boolean" ? rawValue === true : rawValue === "Active";
}

function detail(overrides: Partial<ActivationAttemptDetail>): ActivationAttemptDetail {
  return {
    attempted: false, endpoint: "none", field: null, fieldType: null,
    httpStatus: null, salesforceErrorCode: null, salesforceErrorMessage: null,
    readBackConfirmed: false,
    ...overrides,
  };
}

export async function activateExpressionSetVersion(
  client: SalesforceClient,
  versionId: string | undefined,
  steps: ProcedureStepLite[],
  warnings: string[],
  expressionSetId?: string,
): Promise<{ status: "Draft" | "Active"; detail: ActivationAttemptDetail }> {
  if (!versionId) {
    warnings.push("Could not activate the Expression Set Version — its Id wasn't resolved after deploy. It remains in Draft status.");
    return { status: "Draft", detail: detail({}) };
  }
  step(steps, "activate-version", "start", `Activating ExpressionSetVersion ${versionId}.`);

  const schema = await describeExpressionSetVersionSchema(client);

  // §"Do not treat Describe absence as permission failure" — a genuine describe() error (e.g. this user
  // lacks access to describe the object at all) is reported distinctly from "Describe succeeded, but
  // this org genuinely has no plausible activation field."
  if (schema.error) {
    const message = `Could not Describe ExpressionSetVersion to determine the activation field: ${schema.error}. Activation was not attempted — the version remains in Draft and can be activated manually in Setup.`;
    step(steps, "activate-version", "error", `✕ ${message}`);
    warnings.push(message);
    return { status: "Draft", detail: detail({ attempted: false, salesforceErrorMessage: schema.error }) };
  }
  if (!schema.activeField) {
    const message =
      `Deployment succeeded. Expression Set Version was created and verified, but this Salesforce org/API does not expose a supported programmatic activation operation. ` +
      `The version remains Draft and must be activated from Expression Sets in Salesforce.`;
    step(steps, "activate-version", "error", `✕ ${message}\n  Describe-confirmed fields on ExpressionSetVersion: ${schema.allFields.join(", ") || "(none)"}`);
    warnings.push(message);
    return { status: "Draft", detail: detail({ attempted: false }) };
  }

  const field = schema.activeField;
  const fieldType = schema.activeFieldType ?? "boolean";
  const activeValue: boolean | string = fieldType === "boolean" ? true : "Active";
  const endpoint = `PATCH /sobjects/ExpressionSetVersion/${versionId}`;
  step(steps, "activate-version", "info", `→ ExpressionSetVersion lifecycle inspection.`);
  step(steps, "activate-version", "info", `→ Activation field discovered via describe: ${field} (${fieldType}).`);

  // §"Do NOT perform an update/delete against an already-enabled immutable version" — live evidence
  // (HTTP 403 INVALID_INPUT: "An enabled Expression Set Version cannot be updated/deleted") proved
  // Salesforce genuinely rejects a redundant activation attempt once a version is already active. Read
  // the CURRENT state first; if it's already active, there is nothing to do — this is success, not a
  // no-op error, and no write is ever attempted against an already-enabled version.
  try {
    const currentRes = await client.query<Record<string, unknown>>(`SELECT ${field} FROM ExpressionSetVersion WHERE Id = '${soqlEscape(versionId)}' LIMIT 1`);
    const currentRawValue = currentRes.records[0]?.[field];
    step(steps, "activate-version", "success", `✓ Version Id: ${versionId}`);
    step(steps, "activate-version", "success", `✓ Current ${field}: ${JSON.stringify(currentRawValue)}`);
    if (isActivationConfirmed(fieldType, currentRawValue)) {
      step(steps, "activate-version", "success", `✓ ExpressionSetVersion is already active — no update attempted (Salesforce rejects redundant updates to an already-enabled version).`);
      step(steps, "activate-version", "success", "✓ Expression Set Version status: Active.");
      return {
        status: "Active",
        detail: detail({ attempted: false, endpoint: "none (already active)", field, fieldType, readBackConfirmed: true }),
      };
    }
  } catch (err) {
    // A failed PRE-READ is non-fatal — fall through and attempt activation as before; the read-back
    // after the actual update attempt is still the authoritative confirmation either way.
    step(steps, "activate-version", "info", `→ Could not pre-read current state (${err instanceof Error ? err.message : String(err)}) — proceeding to attempt activation.`);
  }

  step(steps, "activate-version", "info", `→ Determining supported activation operation.`);
  step(steps, "activate-version", "info", `→ Activation operation: PATCH ExpressionSetVersion.${field} (Describe-confirmed, writable).`);

  try {
    await client.updateRecord("ExpressionSetVersion", versionId, { [field]: activeValue });
    const res = await client.query<Record<string, unknown>>(`SELECT ${field} FROM ExpressionSetVersion WHERE Id = '${soqlEscape(versionId)}' LIMIT 1`);
    const rawValue = res.records[0]?.[field];
    const confirmed = isActivationConfirmed(fieldType, rawValue);

    // §"Read the version through the supported Business Rules / Expression Set API" — a best-effort,
    // non-blocking cross-check via the SAME Connect REST resource already used for resolution. Never
    // overrides the direct SOQL read-back above; only adds a second independent confirmation to the log.
    let connectRestCrossCheck: ActivationAttemptDetail["connectRestCrossCheck"];
    if (expressionSetId) {
      try {
        const fetched = await fetchExpressionSetViaConnectRest(client, expressionSetId);
        const matchingVersion = (fetched.response.versions ?? []).find(v => v.id === versionId);
        const enabledFlag = matchingVersion ? (matchingVersion.enabled ?? matchingVersion.isEnabled ?? matchingVersion.isActive) : undefined;
        connectRestCrossCheck = {
          attempted: true,
          confirmedActive: matchingVersion ? (typeof enabledFlag === "boolean" ? enabledFlag : null) : null,
          note: matchingVersion
            ? `Connect REST re-fetch found version ${versionId}${typeof enabledFlag === "boolean" ? ` (enabled=${enabledFlag})` : " (no enabled-like field on this response)"}.`
            : `Connect REST re-fetch did not return a version matching ${versionId}.`,
        };
        step(steps, "activate-version", "info", `→ Cross-checked via Connect REST business-rules/expression-set: ${connectRestCrossCheck.note}`);
      } catch (err) {
        connectRestCrossCheck = { attempted: true, confirmedActive: null, note: `Connect REST cross-check failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    if (!confirmed) {
      warnings.push(`Activation was requested, but Salesforce read-back did not confirm an active ${field} — the procedure remains in Draft and can be activated manually in Setup.`);
      step(steps, "activate-version", "error", `Read-back did not confirm ${field} = ${JSON.stringify(activeValue)} (actual: ${JSON.stringify(rawValue)}).`);
      return {
        status: "Draft",
        detail: detail({ attempted: true, endpoint, field, fieldType, httpStatus: 200, readBackConfirmed: false, connectRestCrossCheck }),
      };
    }
    step(steps, "activate-version", "success", `✓ Expression Set Version activation request succeeded.`);
    step(steps, "activate-version", "success", `✓ Expression Set Version status: Active (confirmed via direct Id read-back on ${field}).`);
    return {
      status: "Active",
      detail: detail({ attempted: true, endpoint, field, fieldType, httpStatus: 200, readBackConfirmed: true, connectRestCrossCheck }),
    };
  } catch (err) {
    const failure = buildFailureDiagnostics("Activate Expression Set Version", err, "Salesforce REST sObject Update (ExpressionSetVersion)");
    step(steps, "activate-version", "error", failure.reason);
    const httpStatus = err instanceof SalesforceError ? err.status : null;
    const errorCode = err instanceof SalesforceError ? err.errorCode ?? null : null;
    const isNotFound = err instanceof SalesforceError && (err.status === 404 || err.errorCode === "NOT_FOUND");
    // §"An enabled Expression Set Version cannot be updated/deleted" (live HTTP 403 INVALID_INPUT) — this
    // rejection is itself strong evidence the version is ALREADY active (the pre-read above should have
    // caught this; this is the defensive fallback for a race/pre-read failure). Re-read rather than
    // assume: only report Active if the read-back actually confirms it.
    const isImmutableAlreadyEnabled = err instanceof SalesforceError && err.status === 403 && /enabled|cannot be updated|cannot be deleted/i.test(err.message);
    if (isImmutableAlreadyEnabled) {
      step(steps, "activate-version", "info", `→ HTTP 403 suggests this version is already enabled — re-reading to confirm rather than assuming.`);
      try {
        const recheck = await client.query<Record<string, unknown>>(`SELECT ${field} FROM ExpressionSetVersion WHERE Id = '${soqlEscape(versionId)}' LIMIT 1`);
        const recheckValue = recheck.records[0]?.[field];
        if (isActivationConfirmed(fieldType, recheckValue)) {
          step(steps, "activate-version", "success", `✓ Confirmed via read-back: ${field} = ${JSON.stringify(recheckValue)} — already Active.`);
          step(steps, "activate-version", "success", "✓ Expression Set Version status: Active.");
          return {
            status: "Active",
            detail: detail({ attempted: true, endpoint, field, fieldType, httpStatus, salesforceErrorCode: errorCode, salesforceErrorMessage: failure.salesforceErrorMessage ?? failure.reason, readBackConfirmed: true }),
          };
        }
        step(steps, "activate-version", "error", `✕ HTTP 403 said this version can't be updated, but read-back shows ${field} = ${JSON.stringify(recheckValue)} (not active) — a genuine, unresolved discrepancy, not a timing issue.`);
      } catch {
        // fall through to the generic failure report below
      }
    }
    // §"Do NOT accept HTTP 404 as a timing warning" — a 404/NOT_FOUND on the update itself means the Id
    // sent was rejected as this resource's identity, not that the record is merely not-yet-visible; that
    // is a materially different, harder failure than every other activation error this function treats
    // as a soft/retriable-later warning, and must say so explicitly rather than using the same generic
    // "remains in Draft" wording.
    if (isNotFound) {
      step(steps, "activate-version", "error", `✕ Activation failed:\n  HTTP 404 NOT_FOUND\n  ExpressionSetVersionId=${versionId}`);
    }
    const warningMessage = isNotFound
      ? `Expression Set Version activation failed because the resolved ID (${versionId}) was not accepted as an Expression Set Version resource by Salesforce (HTTP 404, NOT_FOUND) — this is not a timing/propagation issue; the Id itself was rejected. ${failure.reason}`
      : isImmutableAlreadyEnabled
        ? `Activation returned HTTP 403 (Salesforce reports this version cannot be updated because it's already enabled), but a fresh read-back could not confirm an active state — this is a genuine, unresolved discrepancy and requires manual investigation in Setup. ${failure.reason}`
        : `${failure.reason} — the procedure remains in Draft status and can still be activated manually in Setup.`;
    warnings.push(warningMessage);
    return {
      status: "Draft",
      detail: detail({
        attempted: true, endpoint, field, fieldType, httpStatus,
        salesforceErrorCode: errorCode, salesforceErrorMessage: failure.salesforceErrorMessage ?? failure.reason,
        readBackConfirmed: false,
      }),
    };
  }
}
