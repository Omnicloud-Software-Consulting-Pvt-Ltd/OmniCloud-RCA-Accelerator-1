import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { apiUrl, orgCurrency, queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata, objectMeta, selectable } from "@/lib/tax/server/metadata";
import { getTaxConnection, loadSnapshot, num, resolveProductRef, str } from "@/lib/tax/server/records";
import { readStandardTax, type DecisionTableState } from "@/lib/tax/server/engine";
import type { ResolutionData, RRRate } from "@/lib/tax/server/resolution";
import type { TaxConnection } from "@/lib/tax/types";
import { generateOrderInvoices, loadOrderBilling, type MutationOutcome, type OrderBillingState } from "@/lib/billing/server/orderBilling";
import { idList } from "@/lib/tax/server/records";
import { readInvoice, type TaxRunState } from "@/lib/tax/server/verification";
import { errorLogUnavailable, type ErrorLogRead } from "@/lib/tax/server/invoiceTax";

/**
 * Salesforce access for the tax CALCULATION layer (readiness, calculation, order/billing/invoice verification), behind one
 * interface so the services are unit-tested against an in-memory org. `runtimeApiFor` binds it to the session's client at the
 * tax metadata's API version. Every field read here exists in the connected org (selected through describe). Salesforce errors
 * are NOT swallowed: a failed query throws SalesforceCallError (HTTP status + Salesforce's errors), which the route returns with
 * its code and recommendation — a permission problem must never look like "no rate" or "no invoice". Only optional enrichment
 * (the tax error log, the currency probe) falls back quietly.
 */
export interface TaxRuntimeApi {
  apiVersion: string;
  /** Records needed to resolve a product's tax configuration (+ the product lookup outcome and its standard price). */
  loadData(product: { id?: string | null; name?: string | null }): Promise<LoadedData>;
  /** The decision table Salesforce uses for Revenue Standard Tax: the given engine's DecisionTableId, else the system StandardTax
   *  table. Transaction paths pass the treatment's engine; without one, the org's first engine with a table (dashboards only). */
  decisionTable(engineId?: string | null): Promise<DecisionTableState | null>;
  /** Salesforce's standard invocable action "refreshDecisionTable" (verified in p10: input DecisionTableApiName). */
  refreshDecisionTable(apiName: string): Promise<{ ok: boolean; status: number; message: string | null }>;
  /** POST /commerce/taxes/actions/calculate (Salesforce Tax Calculation API). */
  commerceCalculate(body: Record<string, unknown>): Promise<{ status: number; json: unknown }>;
  currencyIsoCode(): Promise<string | null>;
  query(soql: string): Promise<Record<string, unknown>[]>;
  connection(): Promise<TaxConnection>;
  /** The existing order-billing state (order, items, billing schedules, invoices, async jobs). */
  orderBilling(orderId: string): Promise<OrderBillingState>;
  /** Salesforce invoice generation from the order's billing schedules (existing order-billing service). */
  generateInvoices(orderId: string): Promise<MutationOutcome>;
  /** Invoice with its lines and InvoiceLineTax records. */
  invoice(invoiceId: string): Promise<NonNullable<TaxRunState["invoice"]>>;
  /** Tax treatment on each billing schedule. */
  scheduleTreatments(scheduleIds: string[]): Promise<{ id: string; treatmentId: string | null; treatmentName: string | null }[]>;
  /** Latest Salesforce RevenueTransactionErrorLog for any of the records. */
  errorLog(recordIds: string[]): Promise<ErrorLogRead | null>;
}

export interface LoadedData {
  data: ResolutionData;
  productLookup: { status: "found" | "not-found" | "inactive" | "ambiguous"; message: string | null; candidates: { id: string; name: string; code: string | null }[] };
  listPrice: number | null;
  /** Salesforce's system Revenue Standard Tax table (StandardTax) — used by engines without their own DecisionTableId. */
  dt: DecisionTableState | null;
  /** Engine-assigned decision tables (TaxEngine.DecisionTableId), by engine Id. Salesforce uses the table of the treatment's engine. */
  engineTables?: Record<string, DecisionTableState | null>;
}

export async function runtimeApiFor(client: SalesforceClient): Promise<TaxRuntimeApi> {
  const meta = await discoverTaxMetadata(client);
  const v = meta.apiVersion;
  const query = (soql: string) => queryAt(client, v, soql);
  let snapCache: Awaited<ReturnType<typeof loadSnapshot>> | null = null;
  const snapshot = async () => (snapCache ??= await loadSnapshot(client, meta));
  return {
    apiVersion: v,
    query,
    connection: () => getTaxConnection(client),
    decisionTable: async engineId => readStandardTax(client, v, await snapshot(), engineId ?? null),
    loadData: async product => {
      const snap = await snapshot();
      const pr = await resolveProductRef(client, meta, product);
      const p = pr.status === "found" ? pr.product : pr.status === "inactive" && pr.candidates[0] ? pr.candidates[0] : null;
      const rateCols = selectable(meta, "TaxRate", ["Name", "TaxCode", "Rate", "GeoCountry.IsoCode", "GeoState.IsoCode", "City", "ZipCode", "ProductCode", "LegalEntityId", "RateUsageType", "ApplicationBasis", "StartDate", "EndDate", "Priority"]);
      const [rateRows, stateRows, dt, price] = await Promise.all([
        query(`SELECT Id, ${rateCols.join(", ")} FROM TaxRate ORDER BY CreatedDate`),
        objectMeta(meta, "GeoState") ? query(`SELECT Id, ${selectable(meta, "GeoState", ["Name", "IsoCode", "GeoCountry.IsoCode"]).join(", ")} FROM GeoState ORDER BY Name`) : Promise.resolve([]),
        readStandardTax(client, v, { ...snap, engines: snap.engines.filter(e => !e.decisionTableId) }),
        p ? query(`SELECT UnitPrice FROM PricebookEntry WHERE Product2Id = '${soqlEscape(p.id)}' AND Pricebook2.IsStandard = true AND IsActive = true ORDER BY CreatedDate LIMIT 1`) : Promise.resolve([]),
      ]);
      const withTable = snap.engines.filter(e => e.native && e.decisionTableId);
      const engineTables = Object.fromEntries(await Promise.all(withTable.map(async e => [e.id, await readStandardTax(client, v, { ...snap, engines: [{ ...e, status: "Active" }] })] as const)));
      const rel = (r: Record<string, unknown>, k: string, f = "IsoCode") => str((r[k] as Record<string, unknown> | null)?.[f]);
      const rates: RRRate[] = rateRows.map(r => ({
        id: r.Id as string, name: String(r.Name ?? r.Id), taxCode: str(r.TaxCode), rate: num(r.Rate), countryIso: rel(r, "GeoCountry")?.toUpperCase() ?? null, stateIso: rel(r, "GeoState")?.toUpperCase() ?? null,
        city: str(r.City), zipCode: str(r.ZipCode), productCode: str(r.ProductCode), legalEntityId: str(r.LegalEntityId), usage: str(r.RateUsageType), basis: str(r.ApplicationBasis),
        start: str(r.StartDate), end: str(r.EndDate), priority: num(r.Priority),
      }));
      return {
        data: {
          product: p ? { id: p.id, name: p.name, code: p.code, active: p.active, taxPolicyId: p.taxPolicyId } : null,
          policies: snap.policies.map(x => ({ id: x.id, name: x.name, status: x.status, selection: x.selection, defaultTreatmentId: x.defaultTreatmentId })),
          treatments: snap.treatments, items: snap.items.map(i => ({ id: i.id, name: i.name, treatmentId: i.treatmentId, productId: i.productId, taxCode: i.taxCode, productCode: i.productCode })),
          engines: snap.engines.map(e => ({ id: e.id, name: e.name, type: e.type, status: e.status, native: e.native, decisionTableId: e.decisionTableId, providerId: e.provider?.id ?? null })),
          rates,
          geo: { countries: snap.geoCountries, states: stateRows.map(s => ({ id: s.Id as string, name: String(s.Name), iso: String(s.IsoCode ?? "").toUpperCase(), countryIso: rel(s, "GeoCountry")?.toUpperCase() ?? null })) },
          legalEntities: snap.legalEntities.map(l => ({ id: l.id, name: l.name, status: l.status, country: l.country })),
          tableInputs: dt?.inputs.length ? dt.inputs.map(i => i.field) : null,
          engineTableInputs: Object.fromEntries(Object.entries(engineTables).filter(([, t]) => t?.inputs.length).map(([id, t]) => [id, t!.inputs.map(i => i.field)])),
        },
        productLookup: { status: pr.status, message: pr.status === "found" ? null : pr.message, candidates: pr.status === "found" ? [] : pr.candidates.map(c => ({ id: c.id, name: c.name, code: c.code })) },
        listPrice: num(price[0]?.UnitPrice),
        dt, engineTables,
      };
    },
    refreshDecisionTable: async apiName => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, "/actions/standard/refreshDecisionTable"), { method: "POST", body: JSON.stringify({ inputs: [{ DecisionTableApiName: apiName, isDecisionTableIncremental: false }] }) });
      const out = Array.isArray(res.json) ? (res.json[0] as { isSuccess?: boolean; errors?: { message?: string }[] } | undefined) : undefined;
      const ok = res.status < 300 && out?.isSuccess !== false;
      return { ok, status: res.status, message: ok ? null : out?.errors?.map(e => e.message).filter(Boolean).join("; ") || res.statusText || `HTTP ${res.status}` };
    },
    commerceCalculate: async body => {
      const res = await client.requestWithDiagnostics(apiUrl(client, v, "/commerce/taxes/actions/calculate"), { method: "POST", body: JSON.stringify(body) });
      return { status: res.status, json: res.json ?? res.rawText };
    },
    orderBilling: orderId => loadOrderBilling(client, orderId),
    generateInvoices: orderId => generateOrderInvoices(client, orderId),
    invoice: invoiceId => readInvoice(client, v, invoiceId),
    scheduleTreatments: async ids => (ids.length ? await query(`SELECT Id, TaxTreatmentId, TaxTreatment.Name FROM BillingSchedule WHERE Id IN (${idList(ids)})`) : [])
      .map(r => ({ id: r.Id as string, treatmentId: str(r.TaxTreatmentId), treatmentName: str((r.TaxTreatment as Record<string, unknown> | null)?.Name) })),
    errorLog: async ids => {
      if (!ids.length) return null;
      let l: Record<string, unknown> | undefined;
      try { [l] = await query(`SELECT ErrorLogNumber, ErrorCode, ErrorMessage, Category, CreatedDate FROM RevenueTransactionErrorLog WHERE PrimaryRecordId IN (${idList(ids)}) OR RelatedRecordId IN (${idList(ids)}) ORDER BY CreatedDate DESC LIMIT 1`); }
      catch (e) { return errorLogUnavailable(e); }
      return l ? { number: str(l.ErrorLogNumber), code: str(l.ErrorCode), message: str(l.ErrorMessage), category: str(l.Category), at: str(l.CreatedDate) } : null;
    },
    currencyIsoCode: async () => {
      const [org] = await query("SELECT DefaultCurrencyIsoCode FROM Organization LIMIT 1").catch(() => []);
      return str(org?.DefaultCurrencyIsoCode) ?? (await orgCurrency(client)).code;
    },
  };
}

/** The decision table Salesforce uses for a treatment's engine: the engine's own DecisionTableId, else the system StandardTax table. */
export function tableForEngine(loaded: Pick<LoadedData, "dt" | "engineTables">, engineId: string | null | undefined): DecisionTableState | null {
  return (engineId && loaded.engineTables && engineId in loaded.engineTables ? loaded.engineTables[engineId] : null) ?? loaded.dt;
}
