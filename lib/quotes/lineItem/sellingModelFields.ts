import { cadenceToActiveBillingFrequency } from "@/lib/quotes/billing/frequency";

/**
 * SELLING-MODEL FIELDS FOR A NEW QUOTE LINE ITEM — one shared, metadata-driven rule set (no product names, no Ids, no fixed
 * frequencies). Verified against p12 (2026-11-10, read-only):
 *  · QuoteLineItem.SellingModelType / ProductSellingModelId are NOT createable — Salesforce derives them from the PricebookEntry's
 *    ProductSellingModelId. So the PricebookEntry choice IS the selling-model choice.
 *  · TermDefined + Evergreen lines MUST carry BillingFrequency (Salesforce: "When the SellingModelType is Evergreen or Term-Defined,
 *    BillingFrequency can't be null"). Every existing p12 line's value equals its selling model's PricingTermUnit cadence
 *    (Annual → Annual, Months → Monthly, Quarterly → Quarterly) — resolved here through the Quote module's cadence matcher against
 *    QuoteLineItem.BillingFrequency's ACTIVE picklist values, never a literal table.
 *  · TermDefined lines carry StartDate + EndDate; Evergreen lines carry StartDate and no EndDate; OneTime lines carry neither and no
 *    BillingFrequency (p12: 5 OneTime lines, all BillingFrequency null, no dates).
 */

export type SellingModelType = "OneTime" | "TermDefined" | "Evergreen";
export interface SellingModelDetail { id: string; name: string; type: string | null; status: string | null; pricingTermUnit: string | null; pricingTerm: number | null }
export interface LineItemFieldCaps {
  /** Is this QuoteLineItem field createable for the user (Describe)? */
  createable: (field: string) => boolean;
  /** QuoteLineItem.BillingFrequency active picklist values (Describe). */
  billingFrequencyOptions: { value: string; label: string }[];
  /** QuoteLineItem.PeriodBoundary active picklist values (Describe); empty = unknown. */
  periodBoundaryOptions: string[];
}
export type BillingFrequencySource = "user" | "selling-model-term" | "selling-model-name";
export interface SellingModelFieldPlan {
  fields: Record<string, unknown>;
  billingFrequency: { value: string | null; source: BillingFrequencySource | null; required: boolean };
  /** Blocking problems — the write must not be sent. */
  errors: string[];
  notes: string[];
}

export const isSubscription = (type: string | null | undefined) => type === "TermDefined" || type === "Evergreen";

/** Billing Frequency a subscription selling model implies: its pricing-term unit first, then its name — both mapped to ACTIVE values. */
export function billingFrequencyFor(sm: Pick<SellingModelDetail, "pricingTermUnit" | "name">, options: { value: string; label: string }[]): { value: string; source: BillingFrequencySource } | null {
  const byTerm = cadenceToActiveBillingFrequency(sm.pricingTermUnit, options);
  if (byTerm) return { value: byTerm, source: "selling-model-term" };
  const byName = cadenceToActiveBillingFrequency(sm.name, options);
  return byName ? { value: byName, source: "selling-model-name" } : null;
}

export function planSellingModelFields(sm: SellingModelDetail | null, caps: LineItemFieldCaps, input: { startDate?: string | null; endDate?: string | null; billingFrequency?: string | null }): SellingModelFieldPlan {
  const plan: SellingModelFieldPlan = { fields: {}, billingFrequency: { value: null, source: null, required: false }, errors: [], notes: [] };
  if (!sm) {
    plan.notes.push("The Price Book Entry has no selling model — the line is created without subscription fields.");
    if (input.billingFrequency) plan.notes.push("Billing Frequency ignored: the line has no selling model.");
    return plan;
  }
  if (sm.status && sm.status !== "Active") plan.errors.push(`Selling model ${sm.name} is ${sm.status}, not Active.`);
  if (!isSubscription(sm.type)) {
    if (sm.type !== "OneTime") plan.notes.push(`Selling model ${sm.name} has type ${sm.type ?? "unknown"} — no subscription fields are sent.`);
    if (input.billingFrequency) plan.notes.push(`Billing Frequency ignored: ${sm.name} is One-Time.`);
    return plan;
  }

  // Subscription: Billing Frequency is required by Salesforce.
  plan.billingFrequency.required = true;
  const active = caps.billingFrequencyOptions;
  if (!caps.createable("BillingFrequency")) plan.errors.push("QuoteLineItem.BillingFrequency isn't createable for your user, but Salesforce requires it for Term-Defined / Evergreen lines.");
  else if (input.billingFrequency) {
    const hit = active.find(o => o.value === input.billingFrequency || o.label === input.billingFrequency);
    if (hit) plan.billingFrequency = { value: hit.value, source: "user", required: true };
    else plan.errors.push(`Billing Frequency "${input.billingFrequency}" isn't an active QuoteLineItem.BillingFrequency value (${active.map(o => o.value).join(", ") || "none"}).`);
  } else {
    const r = billingFrequencyFor(sm, active);
    if (r) plan.billingFrequency = { value: r.value, source: r.source, required: true };
    else plan.errors.push(`Billing Frequency can't be resolved from selling model ${sm.name} (pricing term unit ${sm.pricingTermUnit ?? "blank"}) — choose one of ${active.map(o => o.value).join(", ") || "the active values"}.`);
  }
  if (plan.billingFrequency.value) plan.fields.BillingFrequency = plan.billingFrequency.value;

  // Dates: Term-Defined has a start and an end; Evergreen is open-ended.
  if (!input.startDate) plan.errors.push(`${sm.type === "TermDefined" ? "Term-Defined" : "Evergreen"} lines need a start date.`);
  else if (caps.createable("StartDate")) plan.fields.StartDate = input.startDate;
  if (sm.type === "TermDefined") {
    if (!input.endDate) plan.errors.push("Term-Defined lines need an end date.");
    else if (caps.createable("EndDate")) plan.fields.EndDate = input.endDate;
  } else if (input.endDate) plan.notes.push("End date not sent: Evergreen lines are open-ended.");

  const pb = caps.periodBoundaryOptions;
  if (caps.createable("PeriodBoundary") && (!pb.length || pb.includes("Anniversary"))) plan.fields.PeriodBoundary = "Anniversary"; // every p12 subscription line
  return plan;
}
