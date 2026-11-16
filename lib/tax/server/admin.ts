import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, currentIdentity, queryAt } from "@/lib/billing/server/billingDocuments";
import { getTaxConnection, str } from "@/lib/tax/server/records";
import type { TaxConnection } from "@/lib/tax/types";

/**
 * Tax Admin permission for the CURRENT connection's user. Salesforce requires the Tax Admin permission set to create tax
 * configuration (Help: Create a Tax Engine / Configure Tax Rates / Create Tax Policies and Treatments). The app only ever assigns
 * it to the user of this connection — never to a user named in a request — and only when that user may assign permission sets.
 */

export const TAX_ADMIN_PERMISSION_SET = "RevenueLifecycleManagementBillingTaxAdmin";
export const TAX_ADMIN_MISSING = "The current Salesforce user does not have the Revenue Lifecycle Management Billing Tax Admin permission set in this org.";

export interface TaxAdminStatus {
  status: "enabled" | "missing" | "not-available";
  permissionSet: { id: string; name: string; label: string } | null;
  license: { id: string; name: string | null; assigned: boolean } | null;
  canAssign: boolean;
  message: string;
  adminInstruction: string | null;
}

const adminInstructionFor = (who: string, ps: { label: string; name: string } | null, licenseName: string | null) =>
  `Ask a Salesforce admin of this org to assign the "${ps?.label ?? "Tax Admin"}" permission set (${ps?.name ?? TAX_ADMIN_PERMISSION_SET})${licenseName ? ` and its "${licenseName}" permission set licence` : ""} to ${who}: Setup → Users → ${who} → Permission Set Assignments → Edit Assignments.`;

export async function getTaxAdminStatus(client: SalesforceClient): Promise<TaxAdminStatus> {
  const v = client.apiVersion;
  const id = await currentIdentity(client);
  const who = id.username ?? id.userId ?? "the current user";
  const [ps] = await queryAt(client, v, `SELECT Id, Name, Label, LicenseId FROM PermissionSet WHERE Name = '${TAX_ADMIN_PERMISSION_SET}' LIMIT 1`).catch(() => []);
  const [access] = await queryAt(client, v, "SELECT PermissionsAssignPermissionSets, PermissionsManageUsers FROM UserPermissionAccess LIMIT 1").catch(() => []);
  const canAssign = access?.PermissionsAssignPermissionSets === true || access?.PermissionsManageUsers === true;
  if (!ps) return { status: "not-available", permissionSet: null, license: null, canAssign, message: `This org has no "${TAX_ADMIN_PERMISSION_SET}" (Tax Admin) permission set — Revenue Cloud Billing tax may not be licensed here.`, adminInstruction: null };
  const permissionSet = { id: ps.Id as string, name: String(ps.Name), label: String(ps.Label) };
  const assigned = id.userId ? (await queryAt(client, v, `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${soqlEscape(id.userId)}' AND PermissionSetId = '${soqlEscape(permissionSet.id)}' LIMIT 1`).catch(() => [])).length > 0 : false;
  // A permission set licence (0PL…) must be assigned first; a user licence (100…) is part of the user's profile.
  let license: TaxAdminStatus["license"] = null;
  if (typeof ps.LicenseId === "string" && ps.LicenseId.startsWith("0PL")) {
    const [psl] = await queryAt(client, v, `SELECT Id, MasterLabel FROM PermissionSetLicense WHERE Id = '${soqlEscape(ps.LicenseId)}'`).catch(() => []);
    const has = id.userId ? (await queryAt(client, v, `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId = '${soqlEscape(id.userId)}' AND PermissionSetLicenseId = '${soqlEscape(ps.LicenseId)}' LIMIT 1`).catch(() => [])).length > 0 : false;
    license = { id: ps.LicenseId, name: str(psl?.MasterLabel), assigned: has };
  }
  if (assigned) return { status: "enabled", permissionSet, license, canAssign, message: `${who} has the ${permissionSet.label} permission set in this org.`, adminInstruction: null };
  return { status: "missing", permissionSet, license, canAssign, message: TAX_ADMIN_MISSING, adminInstruction: canAssign ? null : adminInstructionFor(who, permissionSet, license && !license.assigned ? license.name : null) };
}

export type AssignOutcome = { ok: true; status: 200 | 201; message: string; taxAdmin: TaxAdminStatus; connection: TaxConnection } | { ok: false; status: number; code: string; error: string; adminInstruction: string | null; taxAdmin: TaxAdminStatus; connection: TaxConnection; technical?: unknown };

/** Assign Tax Admin to the CURRENT authenticated user only, when that user may assign permission sets; otherwise an admin instruction. */
export async function assignTaxAdminToCurrentUser(client: SalesforceClient): Promise<AssignOutcome> {
  const connection = await getTaxConnection(client);
  const before = await getTaxAdminStatus(client);
  const who = connection.username ?? connection.userId ?? "the current user";
  const instruction = adminInstructionFor(who, before.permissionSet, before.license && !before.license.assigned ? before.license.name : null);
  if (before.status === "enabled") return { ok: true, status: 200, message: before.message, taxAdmin: before, connection };
  if (!connection.userId) return { ok: false, status: 409, code: "NO_CURRENT_USER", error: "Salesforce didn't return the current user for this connection — reconnect and try again.", adminInstruction: null, taxAdmin: before, connection };
  if (before.status === "not-available") return { ok: false, status: 422, code: "TAX_ADMIN_NOT_AVAILABLE", error: before.message, adminInstruction: null, taxAdmin: before, connection };
  if (!before.canAssign) return { ok: false, status: 403, code: "CANNOT_ASSIGN_PERMISSION_SETS", error: `${TAX_ADMIN_MISSING} Your Salesforce user isn't allowed to assign permission sets.`, adminInstruction: instruction, taxAdmin: before, connection };
  const post = async (sobject: string, body: Record<string, unknown>) => client.requestWithDiagnostics(apiUrl(client, client.apiVersion, `/sobjects/${sobject}`), { method: "POST", body: JSON.stringify(body) });
  const refused = (res: { status: number; json: unknown; rawText?: string | null }, what: string): AssignOutcome => {
    const errs = Array.isArray(res.json) ? (res.json as { message?: string; errorCode?: string }[]) : [];
    return { ok: false, status: res.status === 403 ? 403 : 422, code: errs[0]?.errorCode ?? "SALESFORCE_ERROR", error: `Salesforce refused to assign ${what}: ${errs.map(e => e.message).join("; ") || res.rawText || res.status}`, adminInstruction: instruction, taxAdmin: before, connection, technical: res.json };
  };
  if (before.license && !before.license.assigned) {
    const res = await post("PermissionSetLicenseAssign", { AssigneeId: connection.userId, PermissionSetLicenseId: before.license.id });
    if (res.status >= 400) return refused(res, `the "${before.license.name ?? "required"}" permission set licence`);
  }
  const res = await post("PermissionSetAssignment", { AssigneeId: connection.userId, PermissionSetId: before.permissionSet!.id });
  if (res.status >= 400) return refused(res, `the ${before.permissionSet!.label} permission set`);
  const after = await getTaxAdminStatus(client);
  if (after.status !== "enabled") return { ok: false, status: 500, code: "ASSIGNMENT_NOT_CONFIRMED", error: "Salesforce accepted the assignment but it doesn't show for the current user.", adminInstruction: instruction, taxAdmin: after, connection };
  return { ok: true, status: 201, message: `Assigned ${after.permissionSet!.label} to ${who} in ${connection.orgName ?? connection.instanceUrl}.`, taxAdmin: after, connection };
}

/** Problem categories the UI keeps apart: a missing permission is never reported as a tax-engine failure, or vice versa. */
export type IssueCategory = "permission" | "tax-engine" | "configuration" | "salesforce";
export function categorize(code: string | null | undefined, message: string | null | undefined): IssueCategory {
  const c = String(code ?? ""), m = String(message ?? "");
  if (/INSUFFICIENT_ACCESS|NOT_ENABLED|PERMISSION|CANNOT_ASSIGN/.test(c)) return "permission";
  if (/^TAX_|DECISION_TABLE/.test(c) || /decision table|tax engine/i.test(m)) return "tax-engine";
  if (/not currently enabled|insufficient access|permission set|don't have access|not allowed/i.test(m)) return "permission";
  return "salesforce";
}
