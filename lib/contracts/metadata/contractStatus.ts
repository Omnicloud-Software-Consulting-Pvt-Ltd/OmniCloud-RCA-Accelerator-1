import type { SalesforceClient } from "@/lib/salesforce/client";
import { SalesforceError } from "@/lib/salesforce/client";
import { describeObjectCached, findPicklistFieldByLabel } from "@/lib/salesforce/describe";
import { createTTLCache } from "@/lib/salesforce/cache";
import type {
  ContractActivationAction,
  ContractActivationResult,
  ContractMutabilityCheck,
  ContractStatusResolution,
} from "@/lib/contracts/types";
import type { PicklistFieldRef } from "@/lib/quotes/types";

const contractStatusCache = createTTLCache<ContractStatusResolution>();

/**
 * §3.6 Option B (decided with the user): a real Draft → Activated → Expired
 * lifecycle mirroring the Order module's activation pattern
 * (lib/orders/metadata/orderStatus.ts) — resolve the org's own Contract.Status
 * active values and which represents "not yet activated" / "activated" /
 * "expired" via semantic/label match, NEVER the hardcoded literals
 * "Draft"/"Activated"/"Expired", since orgs customize this picklist's label
 * text freely.
 */
export async function resolveContractStatusResolution(client: SalesforceClient): Promise<ContractStatusResolution> {
  return contractStatusCache.getOrCompute(client.instanceUrl, async () => {
    const describe = await describeObjectCached(client, "Contract");
    const picklist = findPicklistFieldByLabel(describe, "Status", /^status$/i);
    if (!picklist) {
      return { statusField: null, draftValue: null, activatedValue: null, expiredValue: null };
    }

    const statusField: PicklistFieldRef = {
      apiName: picklist.field.name, label: picklist.field.label,
      options: picklist.activeOptions, defaultValue: picklist.defaultValue,
    };

    const findBy = (pattern: RegExp) => statusField.options.find(o => pattern.test(o.label) || pattern.test(o.value))?.value ?? null;

    const activatedValue = findBy(/^activated$/i) ?? findBy(/activat/i);
    const expiredValue = findBy(/^expired$/i) ?? findBy(/expir/i);
    const draftValue = (statusField.defaultValue && statusField.defaultValue !== activatedValue && statusField.defaultValue !== expiredValue)
      ? statusField.defaultValue
      : (statusField.options.find(o => o.value !== activatedValue && o.value !== expiredValue)?.value ?? null);

    return { statusField, draftValue, activatedValue, expiredValue };
  });
}

/**
 * Read Contract.Status live and classify whether general field edits are
 * currently allowed (§3.6) — a "degrade to attempt, then react to whatever
 * Salesforce actually enforces" case, exactly like Order's
 * checkOrderMutability: only classified "blocked" when Status positively
 * equals the resolved "activated" value; anything else the org might
 * separately enforce is left "inconclusive" so the org's real error surfaces
 * instead of a guess.
 */
export async function checkContractMutability(client: SalesforceClient, contractId: string): Promise<ContractMutabilityCheck> {
  const resolution = await resolveContractStatusResolution(client);
  if (!resolution.statusField) {
    return { status: "inconclusive", currentStatus: null, reason: "Could not resolve a Contract Status field in this org." };
  }

  let currentStatus: string | null = null;
  try {
    const record = await client.getRecord("Contract", contractId, [resolution.statusField.apiName]);
    currentStatus = (record[resolution.statusField.apiName] as string) ?? null;
  } catch {
    return { status: "inconclusive", currentStatus: null, reason: "Could not read this Contract's current Status." };
  }

  if (!resolution.activatedValue) {
    return { status: "inconclusive", currentStatus, reason: "Could not determine this org's 'Activated' Status value — attempting edits and surfacing Salesforce's own error if this Contract is actually locked." };
  }

  if (currentStatus === resolution.activatedValue) {
    return { status: "blocked", currentStatus, reason: `This Contract's Status is "${currentStatus}" — Salesforce orgs typically lock most field edits once a Contract is Activated.` };
  }

  return { status: "mutable", currentStatus, reason: `Status is "${currentStatus ?? "unset"}", not the org's Activated value ("${resolution.activatedValue}") — edits should be allowed.` };
}

/**
 * Transition Contract.Status via a direct field update (§3.6) — the standard
 * mechanism most orgs use. If Salesforce rejects it (e.g. this org actually
 * exposes a dedicated Activate Apex action or Flow instead of a raw Status
 * write), the org's own rejection text is surfaced verbatim rather than
 * silently retrying a guessed alternative.
 */
export async function activateContract(client: SalesforceClient, contractId: string, action: ContractActivationAction): Promise<ContractActivationResult> {
  const resolution = await resolveContractStatusResolution(client);
  if (!resolution.statusField) {
    return { success: false, attemptedTransition: null, message: "Could not resolve a Contract Status field in this org — cannot activate.", salesforceError: null };
  }

  const targetValue = action === "activate" ? resolution.activatedValue : action === "expire" ? resolution.expiredValue : resolution.draftValue;
  if (!targetValue) {
    return {
      success: false, attemptedTransition: null,
      message: `Could not resolve this org's "${action}" Status value from its active Contract.Status picklist options.`,
      salesforceError: null,
    };
  }

  let currentStatus: string | null = null;
  try {
    const record = await client.getRecord("Contract", contractId, [resolution.statusField.apiName]);
    currentStatus = (record[resolution.statusField.apiName] as string) ?? null;
  } catch {
    /* proceed without a "from" value — not fatal to the transition itself */
  }

  try {
    await client.updateRecord("Contract", contractId, { [resolution.statusField.apiName]: targetValue });
    return { success: true, attemptedTransition: { from: currentStatus, to: targetValue }, message: `Contract Status updated to "${targetValue}".`, salesforceError: null };
  } catch (err) {
    const message = err instanceof SalesforceError ? err.message : (err instanceof Error ? err.message : "Failed to update Contract Status.");
    return { success: false, attemptedTransition: { from: currentStatus, to: targetValue }, message: `Salesforce rejected the Status transition to "${targetValue}".`, salesforceError: message };
  }
}

/**
 * Contract-side required-field gating on activation (§3.6 Option B): which
 * of the resolved schema's fields the org's active Status suggests should be
 * present before activating — a best-effort, describe-derived signal only
 * (a validation rule's real conditional requirement can't be introspected),
 * mirroring Order's contractRequiredForContractedType heuristic.
 */
export function activationReadiness(record: Record<string, unknown>, schema: { startDateField: { apiName: string } | null; companySignedByField: { apiName: string } | null }): string[] {
  const missing: string[] = [];
  if (schema.startDateField && !record[schema.startDateField.apiName]) missing.push("Start Date");
  if (schema.companySignedByField && !record[schema.companySignedByField.apiName]) missing.push("Company Signed By");
  return missing;
}
