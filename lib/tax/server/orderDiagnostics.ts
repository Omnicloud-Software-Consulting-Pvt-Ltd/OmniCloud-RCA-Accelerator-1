import type { OrderBillingState } from "@/lib/billing/server/orderBilling";
import type { SfTaxResult } from "@/lib/tax/server/salesforceTaxCalculation";
import { normalizeCountry, normalizeGeography, normalizeState } from "@/lib/tax/server/geography";
import { planVersion, rankDiagnostics, type ResolutionOption, type TaxDiagnosticItem } from "@/lib/tax/server/remediation";

/**
 * EXISTING ORDER → structured diagnostics with resolutions (pure; facts read by the remediation route):
 *  · Draft order with pending billing setup  → the order billing-setup service (order action, billing treatment, tax treatment stamp)
 *  · Draft order with a missing / name-based address → an allowlisted Order address update (ISO codes, values the user confirms)
 *  · order-product tax errors (no rate, ambiguous rate, inactive treatment…) → plan the PRODUCT's tax configuration in place
 *  · activated without a tax treatment / invoice without InvoiceLineTax → not repairable in place: explained, with a replacement
 *    transaction as the next valid step (activated orders and generated invoices can't be re-taxed by changing configuration)
 *  · a failed run (incl. permission) → reported with Salesforce's reason
 */
export interface OrderAddressInput { street?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null }
export interface OrderDiagnosticFacts {
  billing: Pick<OrderBillingState, "order" | "items" | "readiness">;
  result: SfTaxResult | null;
  geo: { countries: { iso: string; name: string }[]; states: { iso: string; name: string; countryIso: string | null }[] };
  address?: OrderAddressInput | null;
  canUpdateOrder?: boolean;
}

const unsupported = (id: string, label: string, reason: string, prompt: string | null = null): ResolutionOption => ({ id, kind: "unsupported", label, rationale: reason, supported: false, unsupportedReason: reason, steps: [], records: [], reversible: true, prompt });
const planPrompt = (product: string, account: string | null) => `Calculate tax for ${product}${account ? ` for ${account}` : ""} and show the actual tax calculated by Salesforce.`;

export function buildOrderDiagnostics(f: OrderDiagnosticFacts): { diagnostics: TaxDiagnosticItem[]; version: string } {
  const o = f.billing.order, items = f.billing.items;
  const out: TaxDiagnosticItem[] = [];
  const push = (d: Omit<TaxDiagnosticItem, "recommendation" | "recommendedOptionId" | "dependsOn" | "expected" | "evidence"> & Partial<Pick<TaxDiagnosticItem, "recommendedOptionId" | "dependsOn" | "expected" | "evidence">>) => {
    const rec = d.recommendedOptionId !== undefined ? d.recommendedOptionId : d.options.find(x => x.supported)?.id ?? null;
    const r = d.options.find(x => x.id === rec);
    out.push({ evidence: [], dependsOn: [], expected: "The issue no longer appears when the order is re-read.", ...d, recommendedOptionId: rec, recommendation: r ? `${r.label} — ${r.rationale}` : d.options.some(x => x.supported) ? "Several valid options — choose one." : d.options[0] ? d.options[0].rationale : "Informational." });
  };
  const draft = o.status === "Draft" && !o.activated;
  const account = o.account?.name ?? null;

  /* 1 · address (the billing schedule action requires billing + shipping addresses; the tax lookup compares ISO codes) */
  const iso = (country: string | null | undefined) => { const c = normalizeCountry(country, f.geo); return c?.known ? c.iso : null; };
  const stIso = (state: string | null | undefined, cIso: string | null) => normalizeState(state, cIso, f.geo)?.iso ?? null;
  // A name ("India", "ontario") or a lower-case code ("ca") where the stored value must be the exact ISO code.
  const notCode = (a: NonNullable<typeof o.billingAddress>) => { const g = normalizeGeography(a, f.geo); return a.country!.trim().length > 2 || a.country!.trim() !== g.country || (a.state ?? "").trim().length > 3 || ((a.state ?? "").trim() || null) !== g.state; };
  const bill = o.billingAddress, ship = o.shippingAddress;
  const missing = !bill?.country || !ship?.country;
  const named = !missing && (notCode(bill!) || notCode(ship!));
  if (missing || named) {
    const a = f.address ?? {};
    const country = iso(a.country ?? (missing ? null : bill!.country)), state = stIso(a.state ?? (missing ? null : bill!.state), country);
    const street = a.street ?? bill?.street ?? null, city = a.city ?? bill?.city ?? null, postal = a.postalCode ?? bill?.postalCode ?? null;
    const inputs = [
      ...(!country ? [{ field: "addressCountry", question: "Country (ISO code, e.g. IN, DE, CA)" }] : []),
      ...(missing && !street ? [{ field: "addressStreet", question: "Street" }] : []),
      ...(missing && !city ? [{ field: "addressCity", question: "City" }] : []),
      ...(!state && (missing || (bill?.state ?? "").trim()) ? [{ field: "addressState", question: "State / province ISO code (blank if none)" }] : []),
      ...(missing && !postal ? [{ field: "addressPostalCode", question: "Postal code" }] : []),
    ];
    const fields: Record<string, string | null> = { BillingCountry: country, ShippingCountry: country, BillingState: state, ShippingState: state, ...(missing ? { BillingStreet: street, ShippingStreet: street, BillingCity: city, ShippingCity: city, BillingPostalCode: postal, ShippingPostalCode: postal } : {}) };
    const option: ResolutionOption = !draft
      ? unsupported("replacement", "Create a replacement order", `Order ${o.number} is ${o.status} — its address isn't changed after activation. Fix the account's address and create a new order.`, o.account && items[0]?.product ? planPrompt(items[0].product.name, account) : null)
      : f.canUpdateOrder === false ? unsupported("order-address", "Update the order address", "Your user can't edit the Order's address fields.")
      : { id: "order-address", kind: "update", label: `Set order ${o.number}'s billing and shipping address (ISO codes)`, rationale: missing ? "Salesforce's billing schedule action requires both addresses." : "The decision table compares ISO codes — the names on the order never match a rate.",
          supported: true, inputs: inputs.length ? inputs : undefined,
          steps: inputs.length ? [] : [{ id: "order-address", group: "config", title: `Update Order ${o.number} address`, object: "Order", recordId: o.id, operation: null, action: { kind: "record", object: "Order", op: "update", recordId: o.id, fields }, changes: Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => ({ field: k, value: String(v) })) }],
          records: [{ role: "update", object: "Order", id: o.id, name: o.number ?? o.id }], consequences: ["Only this Draft order changes — the account keeps its address."], reversible: true };
    push({ id: `ORDER_ADDRESS:${o.id}`, code: missing ? "ORDER_ADDRESS_MISSING" : "ORDER_ADDRESS_NOT_ISO", severity: "blocker", stage: 7, title: missing ? `Order ${o.number} has no complete billing/shipping address` : `Order ${o.number}'s address uses names, not ISO codes`, object: "Order", record: { id: o.id, name: o.number ?? o.id },
      cause: missing ? "Billing and shipping addresses (with a country) are required to create billing schedules and to look up the tax rate." : `Billing ${bill?.country ?? "—"}/${bill?.state ?? "—"} · shipping ${ship?.country ?? "—"}/${ship?.state ?? "—"} — the tax lookup needs ISO codes.`,
      evidence: [`BillingAddress: ${[bill?.street, bill?.city, bill?.state, bill?.postalCode, bill?.country].filter(Boolean).join(", ") || "none"}`, `ShippingAddress: ${[ship?.street, ship?.city, ship?.state, ship?.postalCode, ship?.country].filter(Boolean).join(", ") || "none"}`],
      blocksCalculation: true, options: [option] });
  }

  /* 2 · billing setup on a Draft order (existing self-validating service) */
  const pending = [...new Set(items.flatMap(i => i.pendingActions))];
  if (draft && pending.length) push({ id: `ORDER_BILLING_SETUP:${o.id}`, code: "ORDER_BILLING_SETUP_PENDING", severity: "blocker", stage: 7, title: `Order ${o.number} isn't set up for billing`, object: "OrderItem", record: { id: o.id, name: o.number ?? o.id },
    cause: `Order products need: ${pending.join(", ")} (Order Action, Billing Treatment and the policy's Tax Treatment are required before activation).`,
    evidence: items.filter(i => i.pendingActions.length).map(i => `${i.product?.name ?? i.id}: ${i.pendingActions.join(", ")}`), blocksCalculation: true,
    options: [{ id: "order-setup", kind: "update", label: "Run the billing setup on the Draft order", rationale: "The existing billing setup service — it re-reads the order, reuses an existing Order Action, and refuses an activated or changed order.", supported: true,
      steps: [{ id: "order-setup", group: "config", title: `Billing setup: ${pending.join(", ")}`, object: "OrderItem", recordId: o.id, operation: null, action: { kind: "order-setup", orderId: o.id, operations: pending }, changes: pending.map(x => ({ field: "Setup", value: x })) }],
      records: items.filter(i => i.pendingActions.length).map(i => ({ role: "update" as const, object: "OrderItem", id: i.id, name: i.product?.name ?? i.id })), reversible: false }] });

  /* 3 · order-product tax problems → the product's tax plan (in place) */
  for (const i of items) {
    if (i.tax.state === "unavailable") { push({ id: `ORDER_ITEM_TAX_UNREADABLE:${i.id}`, code: "ORDER_ITEM_TAX_UNREADABLE", severity: "blocker", stage: 3, title: `${i.product?.name ?? "Order product"}: tax configuration couldn't be read`, object: "OrderItem", record: { id: i.id, name: i.product?.name ?? i.id }, cause: i.issues.find(x => x.code === "TAX_RECORDS_UNREADABLE")?.message ?? "The tax records couldn't be read.", blocksCalculation: true, options: [unsupported("access", "Check access", "Nothing is concluded from an unreadable record — check your user's access to the tax objects (Tax Admin).")] }); continue; }
    const errors = i.tax.issues.filter(x => x.severity === "error");
    const notSet = !draft && !i.tax.current && i.tax.expected && i.tax.effective?.taxable;
    if (notSet) push({ id: `ORDER_ACTIVATED_WITHOUT_TREATMENT:${i.id}`, code: "ORDER_ACTIVATED_WITHOUT_TREATMENT", severity: "blocker", stage: 7, title: `${i.product?.name ?? "Order product"} was activated without its Tax Treatment`, object: "OrderItem", record: { id: i.id, name: i.product?.name ?? i.id },
      cause: `Salesforce bills it with the legal entity's fallback treatment instead of "${i.tax.expected!.name}" — an activated order product can't be changed.`, blocksCalculation: true,
      options: [unsupported("replacement", "Create a replacement transaction", "Not repairable in place. Calculate on a new order — its Order Product gets the treatment stamped before activation.", i.product ? planPrompt(i.product.name, account) : null)] });
    else if (errors.length) push({ id: `ORDER_ITEM_TAX:${i.id}`, code: `ORDER_ITEM_${errors[0].code}`, severity: "blocker", stage: 3, title: `${i.product?.name ?? "Order product"}: tax isn't ready`, object: "OrderItem", record: { id: i.id, name: i.product?.name ?? i.id },
      cause: errors.map(e => e.message).join(" "), evidence: errors.map(e => `${e.code}: ${e.message}`), blocksCalculation: true,
      options: [{ id: "plan-product", kind: "ask", label: `Plan ${i.product?.name ?? "the product"}'s tax configuration here`, rationale: "The fixes are configuration records (policy, treatment, rate…) — the product's plan lists each with its own approval, then this order is re-checked.", supported: !!i.product, steps: [], records: [], reversible: true, prompt: i.product ? planPrompt(i.product.name, account) : null }] });
  }

  /* 4 · invoice / run results */
  const r = f.result;
  if (r?.run?.invoice && r.status === "CALCULATION_FAILED") {
    const changed = r.evidence?.configurationChangedAfterInvoice ?? null;
    const product = r.run.items[0]?.product?.name ?? null;
    push({ id: `INVOICE_TAX_NOT_APPLIED:${r.run.invoice.id}`, code: r.reason ?? "INVOICE_TAX_NOT_APPLIED", severity: "blocker", stage: 8, title: `Invoice ${r.run.invoice.number} has no Salesforce tax`, object: "Invoice", record: { id: r.run.invoice.id, name: r.run.invoice.number ?? r.run.invoice.id },
      cause: r.message, evidence: r.evidence ? [`Trace: ${r.evidence.traceClassification ?? "—"}`, `InvoiceLineTax ${r.evidence.invoiceLineTaxCount}, error logs ${r.evidence.errorLogCount}`, ...(changed ? [`The matching rate ${changed.rate} was created/changed at ${changed.rateChangedAt}, after the invoice (${changed.invoiceCreatedAt})`] : [])] : [],
      blocksCalculation: true,
      options: [unsupported("replacement", changed ? "Calculate on a new transaction (configuration changed since)" : "Investigate, then calculate on a new transaction",
        changed ? "A generated invoice isn't re-taxed by later configuration changes — a new order and invoice use the current configuration." : "The configuration resolves a rate but Salesforce didn't apply it at invoice time — a Salesforce Support investigation; recalculating this invoice in place isn't supported here.",
        product ? planPrompt(product, account) : null)], recommendedOptionId: "replacement" });
  }
  if (r?.run && r.status === "CALCULATION_FAILED" && !r.run.invoice) push({ id: `RUN_FAILED:${o.id}`, code: "RUN_FAILED", severity: "blocker", stage: 7, title: "The billing run stopped", object: "Order", record: { id: o.id, name: o.number ?? o.id },
    cause: r.message, evidence: r.diagnostics.map(d => `${d.code}: ${d.explanation}`), blocksCalculation: true,
    options: [unsupported("explain", /permission|insufficient|not authorized/i.test(r.message) ? "Ask a Salesforce administrator" : "Fix the cause, then re-check", /permission|insufficient|not authorized/i.test(r.message) ? `Salesforce denied the step: ${r.message} — the required permission must be granted; nothing is retried.` : "The run resumes from this order once the cause is fixed (re-check the order).")] });

  const diagnostics = rankDiagnostics(out);
  return { diagnostics, version: planVersion(diagnostics) };
}
