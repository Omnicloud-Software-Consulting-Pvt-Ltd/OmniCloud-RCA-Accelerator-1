import type { NextRequest } from "next/server";
import { taxRoute } from "@/lib/tax/server/route";
import { traceApiFor, traceInvoiceLineTax } from "@/lib/tax/server/invoiceTaxTrace";
import { previewApiFor, previewDecisionTable } from "@/lib/tax/server/calculationDiagnostics";
import type { TaxInputs } from "@/lib/tax/server/calculationResult";

type Params = { params: Promise<{ invoiceId: string }> };

// GET /api/taxes/invoices/[invoiceId]/trace?line=<InvoiceLineId>&table=<expected DecisionTableId> — READ-ONLY diagnostic:
// Invoice → InvoiceLine → OrderItem → TaxTreatment → TaxPolicy → TaxEngine → DecisionTable, the line's tax inputs against the
// table's source rows, and the invoice-time result. SOQL SELECT only; never refreshes or writes anything. With preview=1 it also
// asks Salesforce to EVALUATE the decision table for the line's inputs (read-only; labelled as a preview, never a tax result).
export async function GET(req: NextRequest, { params }: Params) {
  const { invoiceId } = await params;
  const sp = req.nextUrl.searchParams;
  return taxRoute(req, async client => {
    const trace = await traceInvoiceLineTax(traceApiFor(client), { invoiceId, invoiceLineId: sp.get("line"), expectedDecisionTableId: sp.get("table") });
    if (sp.get("preview") !== "1" || !trace.decisionTable?.id) return { ...trace, preview: null };
    const m = trace.evaluation.matched[0] ?? null;
    const row = m ? trace.evaluation.rows.find(x => x.id === m.id) : null;
    const preview = await previewDecisionTable(await previewApiFor(client), {
      decisionTableId: trace.decisionTable.id, decisionTableName: trace.decisionTable.name ?? null, inputs: trace.evaluation.inputs as unknown as TaxInputs,
      taxRate: m ? { id: m.id, name: m.name, taxCode: row?.comparisons.find(c => c.input === "TaxCode")?.rowValue ?? null, rate: typeof m.outputs.Rate === "number" ? m.outputs.Rate : null } : null,
    });
    return { ...trace, preview };
  }, "Failed to trace the invoice tax");
}
