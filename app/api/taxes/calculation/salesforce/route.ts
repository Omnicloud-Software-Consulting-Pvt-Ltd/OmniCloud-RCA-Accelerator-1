import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { calculateSalesforceTax, sfTaxApiFor, type SfTaxInput } from "@/lib/tax/server/salesforceTaxCalculation";

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const ACTIONS = new Set(["validate", "preview", "calculate"]);

// POST /api/taxes/calculation/salesforce — the Tax Calculation service (authoritative result = Salesforce InvoiceLineTax).
//  { action: "validate", product, accountId|accountName | country/state/city/postalCode, quantity, unitPrice?, effectiveDate?, treatmentId? }
//      → READY / NOT_READY with every check (read-only)
//  { action: "preview", … } → Salesforce's decision-table evaluation for the inputs → PREVIEW_MATCH / NOT_READY (read-only, never tax)
//  { product, accountId|accountName, contactId?, quantity, unitPrice? } → validation + AWAITING_CONFIRMATION("create-order");
//  { …, confirm: "create-order" } → creates the order; { orderId, confirm: "<next billable step>" } → performs exactly that step;
//  { orderId } → re-checks Salesforce (bounded wait for InvoiceLineTax); { invoiceId | invoiceNumber, readOnly? } → existing invoice.
export async function POST(req: NextRequest) {
  return taxRoute(req, async (client, body) => {
    const p = (body.product ?? {}) as { id?: unknown; name?: unknown };
    const action = s(body.action);
    const input: SfTaxInput = {
      action: action && ACTIONS.has(action) ? (action as SfTaxInput["action"]) : "calculate",
      mode: body.mode === "invoice" ? "invoice" : (body.invoiceId || body.invoiceNumber) && !body.orderId ? "invoice" : "billing",
      product: { id: s(p.id), name: s(p.name) }, accountId: s(body.accountId), accountName: s(body.accountName), contactId: s(body.contactId),
      quantity: n(body.quantity), unitPrice: n(body.unitPrice),
      country: s(body.country), state: s(body.state), city: s(body.city), postalCode: s(body.postalCode), effectiveDate: s(body.effectiveDate), treatmentId: s(body.treatmentId),
      orderId: s(body.orderId), invoiceId: s(body.invoiceId), invoiceNumber: s(body.invoiceNumber), readOnly: body.readOnly === true,
      confirm: s(body.confirm), runKey: s(body.runKey), waitMs: n(body.waitMs), retry: body.retry === true,
    };
    return calculateSalesforceTax(await sfTaxApiFor(client), input);
  }, "Salesforce tax calculation failed", { mutates: true });
}
