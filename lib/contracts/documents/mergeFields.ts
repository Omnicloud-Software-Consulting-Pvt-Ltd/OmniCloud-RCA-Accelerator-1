import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached, findReferenceFieldByTargetObject, resolveField } from "@/lib/salesforce/describe";
import { resolveContractFieldSchema } from "@/lib/contracts/metadata/contractFields";
import { resolveQuoteListFieldSchema } from "@/lib/quotes/metadata/quoteFields";
import type { CompanySettings, MergeFieldValues } from "@/lib/contracts/types";

const TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const DASH = "—";

/**
 * Pure merge-field substitution (§4.1) — deliberately independent of any
 * template so it's unit-testable on its own. An unmatched token is left
 * visibly as `{{Token}}` in the output rather than silently blanked — a
 * visible bug is more useful than a silently-wrong document.
 */
export function substituteMergeFields(bodyHtml: string, values: MergeFieldValues): string {
  const dict = values as unknown as Record<string, string>;
  return bodyHtml.replace(TOKEN_PATTERN, (match, token) => (Object.prototype.hasOwnProperty.call(dict, token) ? dict[token] : match));
}

/** Build the merge-field dictionary from an already-loaded Contract detail (§4.1) — never a fresh query at merge time. */
export function buildMergeFieldValues(input: {
  accountName: string | null;
  contractNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  contractTerm: string | number | null;
  status: string | null;
  ownerName?: string | null;
  companySignedDate: string | null;
  customerSignedDate: string | null;
  description: string | null;
  companyName?: string | null;
  authorizedSigner?: string | null;
  quoteNumber?: string | null;
  products?: string | null;
  grandTotal?: string | null;
  billingFrequency?: string | null;
}): MergeFieldValues {
  return {
    AccountName: input.accountName ?? DASH,
    ContractNumber: input.contractNumber ?? DASH,
    ContractStartDate: input.startDate ?? DASH,
    ContractEndDate: input.endDate ?? DASH,
    ContractTerm: input.contractTerm != null && input.contractTerm !== "" ? String(input.contractTerm) : DASH,
    Status: input.status ?? DASH,
    Owner: input.ownerName ?? DASH,
    CompanySignedDate: input.companySignedDate ?? DASH,
    CustomerSignedDate: input.customerSignedDate ?? DASH,
    Description: input.description ?? DASH,
    CompanyName: input.companyName ?? DASH,
    CustomerName: input.accountName ?? DASH,
    StartDate: input.startDate ?? DASH,
    EndDate: input.endDate ?? DASH,
    AuthorizedSigner: input.authorizedSigner ?? DASH,
    QuoteNumber: input.quoteNumber ?? DASH,
    Products: input.products ?? DASH,
    GrandTotal: input.grandTotal ?? DASH,
    BillingFrequency: input.billingFrequency ?? DASH,
    PaymentTerms: DASH,
  };
}

/**
 * Best-effort {{QuoteNumber}}/{{GrandTotal}} via the most recently modified
 * Order linked to this Contract and, if this org's Order schema resolves a
 * Quote lookup, that Order's Source Quote — every step describe-driven,
 * never a hardcoded field name. Returns all dashes (never throws) if the
 * chain doesn't resolve in this org; {{Products}}/{{BillingFrequency}}
 * would need a further QuoteLineItem aggregation pass that's out of scope
 * here, so they stay dash rather than a partially-guessed value.
 */
async function resolveQuoteDerivedFields(client: SalesforceClient, contractId: string): Promise<{ quoteNumber: string; grandTotal: string }> {
  const none = { quoteNumber: DASH, grandTotal: DASH };
  try {
    const orders = await client.query<{ Id: string }>(
      `SELECT Id FROM Order WHERE ContractId = '${soqlEscape(contractId)}' ORDER BY LastModifiedDate DESC LIMIT 1`,
    );
    const orderId = orders.records[0]?.Id;
    if (!orderId) return none;

    const orderDescribe = await describeObjectCached(client, "Order");
    const quoteField = findReferenceFieldByTargetObject(orderDescribe, "Quote") ?? resolveField(orderDescribe, "QuoteId", /^quote$/i);
    if (!quoteField) return none;

    const orderRecord = await client.getRecord("Order", orderId, [quoteField.name]);
    const quoteId = orderRecord[quoteField.name] as string | null;
    if (!quoteId) return none;

    const quoteSchema = await resolveQuoteListFieldSchema(client);
    const selectFields = new Set(["Id"]);
    if (quoteSchema.quoteNumberField) selectFields.add(quoteSchema.quoteNumberField.apiName);
    if (quoteSchema.grandTotalField) selectFields.add(quoteSchema.grandTotalField.apiName);

    const quoteRecord = await client.getRecord("Quote", quoteId, [...selectFields]);
    const quoteNumber = quoteSchema.quoteNumberField ? ((quoteRecord[quoteSchema.quoteNumberField.apiName] as string) ?? DASH) : DASH;
    const grandTotalRaw = quoteSchema.grandTotalField ? (quoteRecord[quoteSchema.grandTotalField.apiName] as number | null) : null;
    const grandTotal = grandTotalRaw != null ? grandTotalRaw.toLocaleString(undefined, { style: "currency", currency: "USD" }) : DASH;

    return { quoteNumber, grandTotal };
  } catch {
    return none;
  }
}

/**
 * Fetch exactly the fields the merge vocabulary needs for one Contract and
 * build its MergeFieldValues — the single place both the generate route and
 * the preview route load merge data from, so they can never diverge.
 * `companySettings` (browser localStorage, read by the caller and passed
 * through in the request body) supplies {{CompanyName}} — never queried from
 * Salesforce since it isn't a Salesforce concept, and never fetched here
 * directly since this module has no database/localStorage access of its own.
 */
export async function loadMergeFieldValuesForContract(
  client: SalesforceClient,
  contractId: string,
  companySettings?: Partial<CompanySettings> | null,
): Promise<MergeFieldValues> {
  const schema = await resolveContractFieldSchema(client);
  const fields = new Set<string>(["Id", "Status", "Owner.Name"]);
  if (schema.contractNumberField) fields.add(schema.contractNumberField.apiName);
  if (schema.startDateField) fields.add(schema.startDateField.apiName);
  if (schema.endDateField) fields.add(schema.endDateField.apiName);
  if (schema.contractTermField) fields.add(schema.contractTermField.apiName);
  if (schema.companySignedDateField) fields.add(schema.companySignedDateField.apiName);
  if (schema.customerSignedDateField) fields.add(schema.customerSignedDateField.apiName);
  if (schema.descriptionField) fields.add(schema.descriptionField.apiName);
  if (schema.customerSignedTitleField) fields.add(schema.customerSignedTitleField.apiName);
  if (schema.accountField?.relationshipName) fields.add(`${schema.accountField.relationshipName}.Name`);
  if (schema.customerSignedByField?.relationshipName) fields.add(`${schema.customerSignedByField.relationshipName}.Name`);
  if (schema.companySignedByField?.relationshipName) fields.add(`${schema.companySignedByField.relationshipName}.Name`);

  const [record, quoteDerived] = await Promise.all([
    client.getRecord("Contract", contractId, [...fields]),
    resolveQuoteDerivedFields(client, contractId),
  ]);

  const accountRel = schema.accountField?.relationshipName ? (record[schema.accountField.relationshipName] as Record<string, unknown> | null) : null;
  const customerSignedByRel = schema.customerSignedByField?.relationshipName ? (record[schema.customerSignedByField.relationshipName] as Record<string, unknown> | null) : null;
  const companySignedByRel = schema.companySignedByField?.relationshipName ? (record[schema.companySignedByField.relationshipName] as Record<string, unknown> | null) : null;
  const authorizedSigner = (customerSignedByRel?.Name as string) ?? (companySignedByRel?.Name as string) ?? null;
  const ownerRel = record.Owner as Record<string, unknown> | null;

  return buildMergeFieldValues({
    accountName: (accountRel?.Name as string) ?? null,
    contractNumber: schema.contractNumberField ? ((record[schema.contractNumberField.apiName] as string) ?? null) : null,
    startDate: schema.startDateField ? ((record[schema.startDateField.apiName] as string) ?? null) : null,
    endDate: schema.endDateField ? ((record[schema.endDateField.apiName] as string) ?? null) : null,
    contractTerm: schema.contractTermField ? ((record[schema.contractTermField.apiName] as number) ?? null) : null,
    status: (record.Status as string) ?? null,
    ownerName: (ownerRel?.Name as string) ?? null,
    companySignedDate: schema.companySignedDateField ? ((record[schema.companySignedDateField.apiName] as string) ?? null) : null,
    customerSignedDate: schema.customerSignedDateField ? ((record[schema.customerSignedDateField.apiName] as string) ?? null) : null,
    description: schema.descriptionField ? ((record[schema.descriptionField.apiName] as string) ?? null) : null,
    companyName: companySettings?.companyName || null,
    authorizedSigner,
    quoteNumber: quoteDerived.quoteNumber,
    grandTotal: quoteDerived.grandTotal,
  });
}

/** Merge tokens actually referenced in a template body — for library display. */
export function extractMergeTokens(bodyHtml: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(TOKEN_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) found.add(m[1]);
  return [...found];
}
