/**
 * Tax Admin handling is always resolved against the CURRENT connection: the org and user come from that connection's OAuth
 * userinfo, assignment targets only that user, and a user who can't assign permission sets gets an admin instruction.
 * Two simulated orgs prove nothing (user Ids, permission set Ids) leaks from one connection to another.
 *
 * Run with a TypeScript-aware runner: `npx tsx --test lib/tax/server/admin.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { assignTaxAdminToCurrentUser, categorize, getTaxAdminStatus, TAX_ADMIN_MISSING } from "./admin";
import { getTaxConnection } from "./records";

interface OrgFixture {
  instanceUrl: string; orgId: string; orgName: string; userId: string; username: string;
  permissionSetId: string | null; licenseId: string | null;
  hasPermissionSet: boolean; hasLicense: boolean; canAssign: boolean; refuseAssignment?: string;
}
type Call = { method: string; url: string; body: unknown };

function mockClient(org: OrgFixture): SalesforceClient & { calls: Call[] } {
  const calls: Call[] = [];
  const ok = (json: unknown, status = 200) => ({ status, statusText: "OK", json, rawText: JSON.stringify(json), headers: {} });
  const client = {
    instanceUrl: org.instanceUrl, cacheScope: org.instanceUrl, apiVersion: "v64.0", calls,
    async requestWithDiagnostics(url: string, init: { method?: string; body?: string } = {}) {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      assert.ok(url.startsWith(org.instanceUrl), `call left the connected org: ${url}`);
      if (url.endsWith("/services/oauth2/userinfo")) return ok({ user_id: org.userId, organization_id: org.orgId, preferred_username: org.username, name: org.username });
      if (method === "POST" && url.endsWith("/sobjects/PermissionSetLicenseAssign")) { org.hasLicense = true; return ok({ id: "2LA000000000001", success: true }, 201); }
      if (method === "POST" && url.endsWith("/sobjects/PermissionSetAssignment")) {
        if (org.refuseAssignment) return ok([{ message: org.refuseAssignment, errorCode: "INSUFFICIENT_ACCESS_OR_READONLY" }], 400);
        org.hasPermissionSet = true; return ok({ id: "0Pa000000000001", success: true }, 201);
      }
      const soql = decodeURIComponent(url.split("q=")[1] ?? "");
      const rows = (records: Record<string, unknown>[]) => ok({ totalSize: records.length, done: true, records });
      if (/FROM Organization/.test(soql)) return rows([{ Id: org.orgId, Name: org.orgName, OrganizationType: "Developer Edition", IsSandbox: false }]);
      if (/FROM PermissionSet WHERE Name/.test(soql)) return rows(org.permissionSetId ? [{ Id: org.permissionSetId, Name: "RevenueLifecycleManagementBillingTaxAdmin", Label: "Tax Admin", LicenseId: org.licenseId }] : []);
      if (/FROM UserPermissionAccess/.test(soql)) return rows([{ PermissionsAssignPermissionSets: org.canAssign, PermissionsManageUsers: false }]);
      if (/FROM PermissionSetLicense WHERE/.test(soql)) return rows([{ Id: org.licenseId, MasterLabel: "Billing" }]);
      if (/FROM PermissionSetAssignment/.test(soql)) { assert.ok(soql.includes(`'${org.userId}'`), "permission check must target the current user"); return rows(org.hasPermissionSet ? [{ Id: "0Pa" }] : []); }
      if (/FROM PermissionSetLicenseAssign/.test(soql)) { assert.ok(soql.includes(`'${org.userId}'`)); return rows(org.hasLicense ? [{ Id: "2LA" }] : []); }
      throw new Error(`unexpected call ${method} ${url}`);
    },
  };
  return client as unknown as SalesforceClient & { calls: Call[] };
}

const orgA = (): OrgFixture => ({ instanceUrl: "https://org-a.my.salesforce.com", orgId: "00DA00000000001", orgName: "Org A", userId: "005A00000000001", username: "alice@org-a.example", permissionSetId: "0PSA00000000001", licenseId: "0PLA00000000001", hasPermissionSet: false, hasLicense: false, canAssign: true });
const orgB = (): OrgFixture => ({ instanceUrl: "https://org-b.my.salesforce.com", orgId: "00DB00000000001", orgName: "Org B", userId: "005B00000000001", username: "bob@org-b.example", permissionSetId: "0PSB00000000001", licenseId: null, hasPermissionSet: false, hasLicense: false, canAssign: false });

test("connection and user come from the current connection", async () => {
  const a = await getTaxConnection(mockClient(orgA()));
  const b = await getTaxConnection(mockClient(orgB()));
  assert.equal(a.userId, "005A00000000001"); assert.equal(a.orgName, "Org A"); assert.equal(a.username, "alice@org-a.example");
  assert.equal(b.userId, "005B00000000001"); assert.equal(b.orgId, "00DB00000000001");
});

test("missing Tax Admin is reported with the exact message", async () => {
  const status = await getTaxAdminStatus(mockClient(orgA()));
  assert.equal(status.status, "missing");
  assert.equal(status.message, TAX_ADMIN_MISSING);
  assert.equal(status.canAssign, true);
  assert.equal(status.adminInstruction, null);
});

test("assignment targets only the current user of the connection (licence first, then permission set)", async () => {
  const fixture = orgA();
  const client = mockClient(fixture);
  const out = await assignTaxAdminToCurrentUser(client);
  assert.equal(out.ok, true);
  const posts = client.calls.filter(c => c.method === "POST");
  assert.deepEqual(posts.map(p => p.url.split("/sobjects/")[1]), ["PermissionSetLicenseAssign", "PermissionSetAssignment"]);
  for (const p of posts) assert.equal((p.body as { AssigneeId: string }).AssigneeId, "005A00000000001");
  assert.equal((posts[1].body as { PermissionSetId: string }).PermissionSetId, "0PSA00000000001");
  assert.equal(out.taxAdmin.status, "enabled");
});

test("a user who can't assign permission sets gets an admin instruction and nothing is written", async () => {
  const client = mockClient(orgB());
  const out = await assignTaxAdminToCurrentUser(client);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "CANNOT_ASSIGN_PERMISSION_SETS");
  assert.match(out.error, /does not have the Revenue Lifecycle Management Billing Tax Admin permission set/);
  assert.match(out.adminInstruction ?? "", /bob@org-b\.example/);
  assert.equal(client.calls.filter(c => c.method === "POST").length, 0);
});

test("a Salesforce refusal stops with Salesforce's message and an admin instruction", async () => {
  const fixture = { ...orgA(), licenseId: null, refuseAssignment: "insufficient access rights on cross-reference id" };
  const out = await assignTaxAdminToCurrentUser(mockClient(fixture));
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.error, /insufficient access rights/);
  assert.ok(out.adminInstruction);
});

test("already enabled is a no-op", async () => {
  const client = mockClient({ ...orgA(), hasPermissionSet: true, hasLicense: true });
  const out = await assignTaxAdminToCurrentUser(client);
  assert.equal(out.ok, true);
  assert.equal(client.calls.filter(c => c.method === "POST").length, 0);
});

test("permission problems and tax-engine problems are categorised apart", () => {
  assert.equal(categorize("TAX_INTERNAL_ERROR", "Exception while fetching matching records from Decision Table ID: 0lD…"), "tax-engine");
  assert.equal(categorize("SALESFORCE_ERROR", "Decision Table lookup failed for request at index 0"), "tax-engine");
  assert.equal(categorize("INSUFFICIENT_ACCESS_OR_READONLY", "insufficient access rights on TaxRate"), "permission");
  assert.equal(categorize("INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY", "tax engine record"), "permission");
  assert.equal(categorize(null, "This feature is not currently enabled for this user."), "permission");
  assert.equal(categorize("REQUIRED_FIELD_MISSING", "Required fields are missing: billToContact"), "salesforce");
});
