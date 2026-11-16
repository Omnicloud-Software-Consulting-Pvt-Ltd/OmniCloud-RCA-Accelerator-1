import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { compareInput, traceApiFor, traceInvoiceLineTax, type TraceApi } from "./invoiceTaxTrace";

const INV = "3ttg8000000PEfhAAG", LINE = "5TVg8000000Bik5GAC", OI = "802g800000DWKlhAAH", BS = "44bg8000001tTLlAAM";
const TT = "1ttg8000000P2Q1AAK", POL = "1Tpg8000000HUEbCAO", ENG = "4wAg80000002nW5EAI", DT = "0lDg8000000HC3BEAW", LE = "0fwg8000000FFefAAG";
const params = [
  ["Country", "Equals", true], ["State", "Equals"], ["City", "Equals"], ["ZipCode", "Equals"], ["ProductCode", "Equals"],
  ["StartDate", "GreaterOrEqual"], ["EndDate", "LessOrEqual"], ["RateUsageType", "Equals", true], ["LegalEntityId", "Equals"], ["TaxCode", "Equals"],
].map(([FieldName, Operator, IsRequired], i) => ({ FieldName, Operator, IsRequired: !!IsRequired, Usage: "INPUT", Sequence: i + 1 }))
  .concat(["ApplicationBasis", "Rate", "Priority", "FlatTaxAmount"].map(FieldName => ({ FieldName, Operator: null as unknown as string, IsRequired: false, Usage: "OUTPUT", Sequence: 0 })));

function org(o: { ilt?: boolean; lineTreatment?: string; engineTable?: string; rateCountry?: string; failIlt?: boolean } = {}) {
  const soql: string[] = [];
  const data: Record<string, Record<string, unknown>[]> = {
    Invoice: [{ Id: INV, DocumentNumber: "DOC-000000011", Status: "Draft", InvoiceDate: "2026-10-08", TotalAmount: 1149, TotalTaxAmount: 0, LegalEntityId: LE }],
    InvoiceLine: [{ Id: LINE, InvoiceId: INV, ReferenceEntityItemId: null, BillingScheduleId: BS, Product2Id: "01tg8000006f8uUAAQ", Product2: { ProductCode: "DS001" }, Quantity: 1, ChargeAmount: 1149, TaxAmount: 0, TaxProcessingStatus: "Estimated", TaxTreatmentId: o.lineTreatment ?? TT, LegalEntityId: LE, ShippingAddressId: "8zzg80000000ZqbAAE", InvoiceLineStartDate: "2026-10-08" }],
    BillingSchedule: [{ Id: BS, ReferenceEntityItemId: OI, TaxTreatmentId: TT }],
    OrderItem: [{ Id: OI, TaxTreatmentId: TT }],
    TaxTreatment: [{ Id: TT, Name: "Desktop Germany Tax Treatment", Status: "Active", IsTaxable: true, TaxPolicyId: POL, TaxEngineId: ENG, LegalEntityId: null, ShouldUseTaxTreatmentItems: true }],
    TaxTreatmentItem: [{ Id: "1tug8000000AQqrAAG", TaxCode: "DE_VAT_19", ProductCode: "DS001" }],
    TaxPolicy: [{ Id: POL, Status: "Active" }],
    TaxEngine: [{ Id: ENG, Status: "Active", Type: "RevenueStandardTax", DecisionTableId: o.engineTable ?? DT }],
    DecisionTable: [{ Id: o.engineTable ?? DT, DeveloperName: o.engineTable ? "StandardTax" : "RevenueStandardTaxWithTaxCode", Status: "Active", Type: "MediumVolume", UsageType: "RevenueStandardTax", SourceObject: "TaxRate", RefreshStatus: "Completed", LastSyncDate: "2026-10-08T05:51:49.000+0000" }],
    DecisionTableParameter: params,
    InvoiceAddressGroup: [{ Id: "8zzg80000000ZqbAAE", City: "München", State: "Bavaria", PostalCode: "80331", Country: "DE" }],
    InvoiceLineTax: o.ilt ? [{ Id: "1ltg000000000001", TaxAmount: 218.31, TaxRate: 19, TaxCode: "DE_VAT_19" }] : [],
    RevenueTransactionErrorLog: [],
    TaxRate: [{ Id: "0xqg80000000253AAA", Name: "TR-00000014", Country: o.rateCountry ?? "DE", State: null, City: null, ZipCode: null, ProductCode: "DS001", StartDate: "2026-10-08", EndDate: null, RateUsageType: "RevCloud", LegalEntityId: LE, TaxCode: "DE_VAT_19", ApplicationBasis: "Net", Rate: 19, Priority: 1, FlatTaxAmount: null }],
  };
  const api: TraceApi = {
    query: async s => {
      soql.push(s);
      const obj = /\bFROM\s+(\w+)/i.exec(s)![1];
      if (o.failIlt && obj === "InvoiceLineTax") throw new Error("INVALID_TYPE");
      return structuredClone(data[obj] ?? []);
    },
  };
  return { api, soql };
}
const run = (o?: Parameters<typeof org>[0], expected = DT) => { const f = org(o); return traceInvoiceLineTax(f.api, { invoiceId: INV, invoiceLineId: LINE, expectedDecisionTableId: expected }).then(r => ({ r, soql: f.soql })); };

test("connected chain + matching table + processed line without InvoiceLineTax → INVOICE_TIME_TAX_NOT_APPLIED", async () => {
  const { r } = await run();
  assert.equal(r.classification, "INVOICE_TIME_TAX_NOT_APPLIED");
  assert.deepEqual(r.checks.map(c => c.answer), ["YES", "YES", "YES", "YES", "YES"]);
  assert.equal(r.evaluation.matched[0].name, "TR-00000014");
  assert.equal(r.invoiceTime.invoiceLineTaxCount, 0);
  assert.match(r.nextStep, /Salesforce Support/);
  // the reference amount is labelled and never presented as actual tax
  assert.equal(r.reference?.label, "Expected/reference amount — NOT a Salesforce calculation.");
  assert.equal(r.reference?.amount, 218.31);
  assert.equal(r.records.invoiceLineTax, null);
  // a blank InvoiceLine → OrderItem field is reported, not treated as broken (order item reachable via the schedule)
  const direct = r.links.find(l => l.field === "InvoiceLine.ReferenceEntityItemId")!;
  assert.equal(direct.value, null);
  assert.match(direct.note!, /billing schedule/);
});

test("read-only: every Salesforce call is a SOQL SELECT", async () => {
  const { soql } = await run();
  assert.ok(soql.length > 10);
  for (const s of soql) assert.match(s, /^\s*SELECT\s/i);
});

test("Salesforce-produced InvoiceLineTax → CONFIGURATION_MATCH", async () => {
  assert.equal((await run({ ilt: true })).r.classification, "CONFIGURATION_MATCH");
});

test("line treatment ≠ order item treatment → MISSING_RELATIONSHIP", async () => {
  const { r } = await run({ lineTreatment: "1ttg8000000XXXXAAA" });
  assert.equal(r.classification, "MISSING_RELATIONSHIP");
  assert.equal(r.checks.find(c => c.id === "A")!.answer, "NO");
});

test("engine assigned to a different decision table than expected → MISSING_RELATIONSHIP", async () => {
  const { r } = await run({ engineTable: "0lDg8000000FR09EAG" });
  assert.equal(r.classification, "MISSING_RELATIONSHIP");
  assert.equal(r.checks.find(c => c.id === "C")!.answer, "NO");
});

test("no source row satisfies the table's conditions → DECISION_TABLE_MISMATCH", async () => {
  const { r } = await run({ rateCountry: "FR" });
  assert.equal(r.classification, "DECISION_TABLE_MISMATCH");
  assert.equal(r.reference, null);
  assert.equal(r.evaluation.rows[0].comparisons.find(c => c.input === "Country")!.matches, false);
});

test("an unreadable InvoiceLineTax query is not evidence of 'none' → INSUFFICIENT_EVIDENCE", async () => {
  const { r } = await run({ failIlt: true });
  assert.equal(r.classification, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.unreadable.length, 1);
});

test("input comparison semantics: blank wildcard, equals, date ranges", () => {
  assert.equal(compareInput("State", "Equals", "Bavaria", null).matches, true);
  assert.equal(compareInput("Country", "Equals", "DE", "DE").matches, true);
  assert.equal(compareInput("Country", "Equals", "Germany", "DE").matches, false);
  assert.equal(compareInput("StartDate", "GreaterOrEqual", "2026-10-08", "2026-10-08").matches, true);
  assert.equal(compareInput("StartDate", "GreaterOrEqual", "2026-10-07", "2026-10-08").matches, false);
  assert.equal(compareInput("EndDate", "LessOrEqual", "2026-10-08", "2026-12-31").matches, true);
});

test("the real adapter refuses anything but SELECT before calling Salesforce", async () => {
  const client = new Proxy({}, { get: () => { throw new Error("must not be called"); } }) as unknown as SalesforceClient;
  await assert.rejects(traceApiFor(client).query("DELETE FROM InvoiceLineTax"), /only SELECT/);
});
