import type { NextRequest } from "next/server";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { taxRoute } from "@/lib/tax/server/route";
import { planTaxCalculation } from "@/lib/tax/server/taxQuery";
import { parsePlanInput } from "@/lib/tax/server/planInput";
import { planVersion, remediate, type ApprovalGroup, type RemediationOutcome, type StepAction, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";
import { executeOperations, previewOperations } from "@/lib/tax/server/operations";
import { decisionTableRefresh, refreshToken } from "@/lib/tax/server/refreshApproval";
import { runtimeApiFor } from "@/lib/tax/server/runtime";
import { getTaxConnection, loadSnapshot } from "@/lib/tax/server/records";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { checkRecordAction, runRecordAction } from "@/lib/tax/server/recordWrites";
import { buildOrderDiagnostics, type OrderAddressInput } from "@/lib/tax/server/orderDiagnostics";
import { applyOrderBillingSetup, loadOrderBilling } from "@/lib/billing/server/orderBilling";
import { readSalesforceTax, sfTaxApiFor } from "@/lib/tax/server/salesforceTaxCalculation";
import { assignTaxAdminToCurrentUser, getTaxAdminStatus } from "@/lib/tax/server/admin";
import { describeAt, queryAt } from "@/lib/billing/server/billingDocuments";
import { BadInputError } from "@/lib/billing/server/payments";

// POST /api/taxes/calculation/remediate — { plan: <plan input> } | { order: { orderId, address? } }, plus
//   mode: "diagnose" → the context's ranked diagnostics (read-only)
//   diagnosticId + optionId (+ group) without approvalToken → PREVIEW (read-only): the itemized group, Salesforce's field-level
//     preview / pre-checks, and the approval token
//   … with approvalToken → EXECUTE: the context is re-read from Salesforce, the token recomputed (version + diagnostic + option + group +
//     exact steps) and a stale one refused; the group runs through the existing self-validating services (Tax Assistant, allowlisted
//     record writes, order billing setup, Tax Admin self-assignment) and every write is verified by re-reading; the context is
//     re-diagnosed and the issue is RESOLVED only if it no longer appears.
// A repeated approval (same token) returns the first outcome instead of writing again. Every execution is audit-logged without secrets.
const GROUPS: ApprovalGroup[] = ["config", "link", "activation", "refresh", "permission"];
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const done = new Map<string, { at: number; outcome: RemediationOutcome }>();
const running = new Set<string>();
const TTL = 15 * 60_000;
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

async function orderDiagnostics(client: SalesforceClient, orderId: string, address: OrderAddressInput | null): Promise<TaxDiagnosticItem[]> {
  const meta = await discoverTaxMetadata(client);
  const [billing, result, snap, states, od] = await Promise.all([
    loadOrderBilling(client, orderId),
    readSalesforceTax(await sfTaxApiFor(client), orderId),
    loadSnapshot(client, meta),
    queryAt(client, meta.apiVersion, "SELECT IsoCode, Name, GeoCountry.IsoCode FROM GeoState LIMIT 2000"),
    describeAt(client, meta.apiVersion, "Order"),
  ]);
  return buildOrderDiagnostics({
    billing, result, address,
    geo: { countries: snap.geoCountries.map(c => ({ iso: c.iso, name: c.name })), states: states.map(r => ({ iso: String(r.IsoCode ?? "").toUpperCase(), name: String(r.Name ?? ""), countryIso: s((r.GeoCountry as Record<string, unknown> | null)?.IsoCode)?.toUpperCase() ?? null })) },
    canUpdateOrder: (od as unknown as { updateable?: boolean } | null)?.updateable !== false,
  }).diagnostics;
}

async function checkAction(client: SalesforceClient, a: StepAction): Promise<string[]> {
  if (a.kind === "record") return checkRecordAction(client, a);
  if (a.kind === "tax-admin") {
    const t = await getTaxAdminStatus(client);
    return t.status === "enabled" ? ["Tax Admin is already assigned — nothing to do."] : t.status !== "missing" ? [t.message] : t.canAssign ? [] : [t.adminInstruction ?? "Your user can't assign permission sets."];
  }
  const st = await loadOrderBilling(client, a.orderId);
  if (st.order.status !== "Draft" || st.order.activated) return [`Order ${st.order.number} is ${st.order.status} — billing setup only runs on a Draft order.`];
  if (!a.operations.some(op => st.items.some(i => i.pendingActions.includes(op)))) return ["The order's billing setup is already complete."];
  return [];
}
async function runAction(client: SalesforceClient, a: StepAction): Promise<{ ok: boolean; message: string; recordId?: string | null; permission?: boolean }> {
  if (a.kind === "record") return runRecordAction(client, a);
  if (a.kind === "tax-admin") {
    const r = await assignTaxAdminToCurrentUser(client);
    return r.ok ? { ok: true, message: r.message } : { ok: false, message: `${r.error}${r.adminInstruction ? ` ${r.adminInstruction}` : ""}`, permission: r.status === 403 };
  }
  const r = await applyOrderBillingSetup(client, a.orderId, { operations: a.operations });
  if (!r.ok) return { ok: false, message: r.error, permission: r.status === 403 };
  const after = await loadOrderBilling(client, a.orderId);
  const left = after.items.filter(i => i.pendingActions.some(op => a.operations.includes(op)));
  return left.length ? { ok: false, message: `Salesforce accepted the setup, but re-reading the order still shows pending: ${left.map(i => `${i.product?.name ?? i.id} (${i.pendingActions.join(", ")})`).join("; ")} — not marked done.` } : { ok: true, message: r.message, recordId: a.orderId };
}

export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => {
    const orderCtx = body.order && typeof body.order === "object" ? body.order as { orderId?: unknown; address?: Record<string, unknown> } : null;
    const orderId = orderCtx ? s(orderCtx.orderId) : null;
    if (orderCtx && (!orderId || !SFID.test(orderId))) throw new BadInputError("order.orderId isn't a valid Salesforce Id.");
    const address: OrderAddressInput | null = orderCtx?.address ? { street: s(orderCtx.address.street), city: s(orderCtx.address.city), state: s(orderCtx.address.state), postalCode: s(orderCtx.address.postalCode), country: s(orderCtx.address.country) } : null;
    const input = orderCtx ? null : parsePlanInput((body.plan ?? {}) as Record<string, unknown>);
    const diagnose = async () => (orderId ? orderDiagnostics(client, orderId, address) : (await planTaxCalculation(client, input!)).plan.diagnostics);
    if (body.mode === "diagnose") { const diagnostics = await diagnose(); return { success: true, mode: "diagnose", diagnostics, version: planVersion(diagnostics) }; }

    const diagnosticId = typeof body.diagnosticId === "string" ? body.diagnosticId.slice(0, 200) : "";
    const optionId = typeof body.optionId === "string" ? body.optionId.slice(0, 200) : "";
    if (!diagnosticId || !optionId) throw new BadInputError("diagnosticId and optionId are required.");
    const group = GROUPS.includes(body.group as ApprovalGroup) ? body.group as ApprovalGroup : null;
    const approvalToken = typeof body.approvalToken === "string" && /^[a-f0-9]{64}$/.test(body.approvalToken) ? body.approvalToken : null;
    const conn = await getTaxConnection(client);
    const key = approvalToken ? `${client.cacheScope}:${approvalToken}` : null;
    for (const [k, v] of done) if (Date.now() - v.at > TTL) done.delete(k);
    if (key && done.has(key)) return { success: true, duplicate: true, ...done.get(key)!.outcome };
    if (key && running.has(key)) throw new BadInputError("This approved change is already running — wait for its result.");
    if (key) running.add(key);
    try {
      const outcome = await remediate({
        diagnose,
        preview: operations => previewOperations(client, { operations }),
        execute: (operations, token) => executeOperations(client, { operations }, token),
        refresh: async (engineId, decisionTableId) => {
          const r = await decisionTableRefresh(await runtimeApiFor(client), { engineId, confirm: decisionTableId ? refreshToken(decisionTableId) : null });
          return r.mode === "refresh" ? { ok: r.state === "Ready", message: r.message } : { ok: false, message: r.mode === "preview" ? r.message : "The decision table couldn't be refreshed." };
        },
        checkAction: a => checkAction(client, a),
        runAction: a => runAction(client, a),
      }, { diagnosticId, optionId, group, approvalToken });
      if (outcome.mode === "executed") {
        if (key) done.set(key, { at: Date.now(), outcome });
        // Audit: who approved what, on which records, and what Salesforce returned — never tokens or credentials.
        console.info("[tax-remediation]", JSON.stringify({ at: new Date().toISOString(), orgId: conn.orgId, user: conn.username, context: orderId ? { orderId } : { product: input!.product }, diagnosticId, optionId, group: outcome.group, ok: outcome.ok, verified: outcome.verified, resolved: outcome.resolved,
          failure: outcome.failure ? { code: outcome.failure.code, permission: outcome.failure.permission } : null,
          records: [...(outcome.result?.audit.map(a => ({ op: a.operation, object: a.object, id: a.recordId, result: a.result })) ?? []), ...(outcome.actions ?? []).map(a => ({ op: "action", object: null, id: a.recordId ?? null, result: a.ok ? "success" : "failed" }))], refresh: outcome.refresh?.ok ?? null }));
      }
      return { success: true, connection: { orgId: conn.orgId, orgName: conn.orgName, username: conn.username }, ...outcome };
    } finally { if (key) running.delete(key); }
  }, "Tax remediation failed", { mutates: true });
}
