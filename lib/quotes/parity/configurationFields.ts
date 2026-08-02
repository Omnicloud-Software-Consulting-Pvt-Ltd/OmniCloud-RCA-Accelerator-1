import type { SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";

/**
 * §Next Investigation (repricing-failure ticket): this codebase has never
 * once referenced these five fields (confirmed by a full-repo grep) — they
 * are exactly the kind of Revenue Cloud Product-Configurator/pricing-
 * context fields the native "Get Products and Prices"/"Product Discovery"
 * rejection text points at, but that is a hypothesis, not a finding. This
 * module answers the ticket's three explicit questions from real Describe
 * metadata and real native-quote data — never fabricated: (1) does the
 * field exist in THIS org's QuoteLineItem schema at all, (2) is it actually
 * populated on the NATIVE quote's line items, (3) is it populated only on
 * SOME lines (which would narrow "required by repricing" further). Never
 * writes anything — investigation only.
 */
const NAMED_CONFIGURATION_FIELDS = [
  "ConfigurationId",
  "ConfigurationSessionId",
  "ProductConfigurationId",
  "PriceAdjustmentSchedule",
  "PricingProcedure",
];

export interface ConfigurationFieldFinding {
  apiName: string;
  existsInOrgSchema: boolean;
  label: string | null;
  type: string | null;
  referenceTo: string[] | null;
  nativeRowCount: number;
  populatedInNativeCount: number;
  appRowCount: number;
  populatedInAppCount: number;
  note: string;
}

function isPopulated(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

export async function investigateConfigurationFields(
  client: SalesforceClient,
  nativeRows: Record<string, unknown>[],
  appRows: Record<string, unknown>[],
): Promise<ConfigurationFieldFinding[]> {
  const describe = await describeObjectCached(client, "QuoteLineItem");

  return NAMED_CONFIGURATION_FIELDS.map(apiName => {
    const field = describe.fields.find(f => f.name.toLowerCase() === apiName.toLowerCase());
    if (!field) {
      return {
        apiName, existsInOrgSchema: false, label: null, type: null, referenceTo: null,
        nativeRowCount: nativeRows.length, populatedInNativeCount: 0,
        appRowCount: appRows.length, populatedInAppCount: 0,
        note: `This org's QuoteLineItem Describe has no field named "${apiName}" at all. It does not exist in this schema — this app cannot read, write, or compare it, and it cannot be the repricing blocker in THIS org (a missing field can't be silently required; if repricing genuinely depends on configuration data here, it lives under a different field name or a different object — check Describe's full field list manually, never guess a replacement name).`,
      };
    }

    const populatedNative = nativeRows.filter(r => isPopulated(r[field.name])).length;
    const populatedApp = appRows.filter(r => isPopulated(r[field.name])).length;

    let note: string;
    if (nativeRows.length === 0) {
      note = `Field exists (label "${field.label}", type ${field.type}) but no native QuoteLineItem rows were available to check population against.`;
    } else if (populatedNative === 0) {
      note = `Field exists but is NULL on all ${nativeRows.length} native QuoteLineItem row(s) too — native Salesforce itself does not populate this field for this bundle, so it is very unlikely to be the repricing blocker here. Per the ticket: if native leaves it null, this app should also leave it null (no action needed).`;
    } else if (populatedNative === nativeRows.length && populatedApp === 0) {
      note = `Populated on ALL ${populatedNative}/${nativeRows.length} native row(s), but on ZERO of this app's ${appRows.length} created row(s) — native Salesforce always populates this field and this app never does. Strong, evidence-backed candidate for the repricing gap; the next step is determining WHERE Salesforce sources this value from (a Product Configurator/Cart session, a formula, a trigger/flow) before writing any code — do not fabricate a value.`;
    } else if (populatedNative > 0 && populatedNative < nativeRows.length) {
      note = `Populated on only ${populatedNative}/${nativeRows.length} native row(s) (not all) — this field is conditional on something (e.g. only bundle children, or only certain selling models), not universally required. ${populatedApp}/${appRows.length} app row(s) populated. Narrow which native rows have it before assuming it's required everywhere.`;
    } else {
      note = `Populated on ${populatedNative}/${nativeRows.length} native row(s) and ${populatedApp}/${appRows.length} app row(s) — no clear native-vs-app population gap for this field.`;
    }

    return {
      apiName, existsInOrgSchema: true, label: field.label, type: field.type, referenceTo: field.referenceTo ?? null,
      nativeRowCount: nativeRows.length, populatedInNativeCount: populatedNative,
      appRowCount: appRows.length, populatedInAppCount: populatedApp,
      note,
    };
  });
}
