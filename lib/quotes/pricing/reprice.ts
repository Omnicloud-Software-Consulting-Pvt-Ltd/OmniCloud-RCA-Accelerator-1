import { soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { describeObjectCached, resolveField } from "@/lib/salesforce/describe";
import { resolveQuoteLineItemFieldSchema, resolveQuoteLineItemAttributeFieldSchema } from "@/lib/quotes/metadata/lineItemFields";
import { resolveQuoteFieldSchema } from "@/lib/quotes/metadata/quoteFields";
import type {
  RepricingAttemptError,
  RepricingAttemptRequest,
  RepricingErrorEntry,
  RepricingHttpTranscript,
  RepricingLineResult,
  RepricingSummary,
} from "@/lib/quotes/types";

/**
 * Salesforce Revenue Cloud's documented, supported external repricing
 * resource ("Instant Pricing API" — Transaction Management Business APIs,
 * available since API v60.0): https://developer.salesforce.com/docs/atlas.en-us.revenue_lifecycle_management_dev_guide.meta/revenue_lifecycle_management_dev_guide/connect_resources_cpq_instant_pricing.htm
 *
 * §Phase 3 (verify the endpoint, don't assume): re-checked this against the
 * app's own API-version wiring — every Quote/QLI route (`requireSFClient`,
 * lib/salesforce/serverSession.ts) already pins its SalesforceClient to
 * SF_API_VERSION_RCA ("v62.0"), specifically because Quote/QuoteLineItem/
 * ProductRelatedComponent/ProductSellingModelOption are RCA-era objects
 * needing that newer surface. This call reuses that SAME client instance
 * (never constructs its own), so it is NOT pinned to the older v60.0
 * default — ruled out as a cause of the empty-error symptom, not assumed.
 * The path itself is unchanged from Salesforce's own current developer
 * docs (not guessed) — this fix targets response PARSING, not the endpoint.
 *
 * NOT under `/connect` — deliberately called directly rather than via
 * `client.connectPost()`, which always prefixes `/connect`.
 */
const INSTANT_PRICING_PATH = "/industries/cpq/quotes/actions/get-instant-price";

interface InstantPricingRecord {
  Id?: string;
  NetUnitPrice?: number;
  NetTotalPrice?: number;
  ListPrice?: number;
  Discount?: number;
  attributes?: { type?: string };
  [key: string]: unknown;
}

interface InstantPricingRecordResult {
  referenceId?: string;
  record?: InstantPricingRecord;
  /**
   * §Do not assume the error envelope shape: Salesforce's own REST/Connect
   * APIs are NOT consistent about this — some return a singular `error`
   * object, others (Composite API, Bulk API, most `SaveResult`-style
   * responses) return a PLURAL `errors` ARRAY, Invocable-Action-style
   * "actions" resources use `isSuccess`/`errors`/`outputValues`, and the
   * message/code key itself varies (`message` vs `errorMessage` vs a bare
   * string). Typed as `unknown` here deliberately — `normalizeRecordErrors`
   * below inspects the REAL shape at runtime instead of assuming one.
   */
  error?: unknown;
  errors?: unknown;
  isSuccess?: boolean;
  outputValues?: unknown;
  [key: string]: unknown;
}

/**
 * §Phase 3 — do not assume the top-level envelope shape either: this app
 * previously assumed `{ records: [...] }` (a composite-sobjects-style
 * shape). Salesforce's generic "Actions" REST resources (anything under
 * `.../actions/...`, which this path is) commonly return a bare TOP-LEVEL
 * ARRAY of `{ isSuccess, errors, outputValues }` instead. Both shapes are
 * handled by `extractRecordResults` below without assuming either is
 * correct — whichever one this org's endpoint actually uses is detected
 * from the real parsed JSON.
 */
type InstantPricingResponse = { records?: InstantPricingRecordResult[] } | InstantPricingRecordResult[];

function extractRecordResults(json: unknown): InstantPricingRecordResult[] {
  if (Array.isArray(json)) return json as InstantPricingRecordResult[];
  if (json != null && typeof json === "object" && Array.isArray((json as { records?: unknown }).records)) {
    return (json as { records: InstantPricingRecordResult[] }).records;
  }
  return [];
}

/**
 * §Do not hide Salesforce errors: normalize ONE record-result's error data
 * into RepricingErrorEntry objects without assuming which of Salesforce's
 * several conventional error shapes this org's Instant Pricing endpoint
 * actually uses. Tries, in order: a plural `errors` array, a singular
 * `error` object, then a handful of common key aliases for the message/
 * code within whichever object(s) were found. The complete, untouched raw
 * entry is ALWAYS attached as `extra` — if every known alias comes back
 * empty, `message` is a JSON dump of the raw entry (never null), so the
 * real Salesforce content is never silently discarded just because its
 * exact key names differ from what was expected, and a genuinely-empty
 * Salesforce error object (`{}`) is visibly distinguishable from "we
 * couldn't find a message" by inspecting `extra` in the UI.
 */
function normalizeRecordErrors(rec: InstantPricingRecordResult): RepricingErrorEntry[] {
  const raw = rec.errors ?? rec.error;
  if (raw == null) return [];
  const rawEntries: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (rawEntries.length === 0) return [];

  return rawEntries.map(entry => {
    const obj = (entry != null && typeof entry === "object") ? (entry as Record<string, unknown>) : null;
    const pick = (keys: string[]): string | null => {
      if (!obj) return null;
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return null;
    };
    const message = pick(["message", "errorMessage", "Message", "detail", "description"])
      ?? (obj ? null : (typeof entry === "string" ? entry : null));
    const errorCode = pick(["errorCode", "statusCode", "code", "ErrorCode"]);
    const fieldsRaw = obj?.fields;
    const fields = Array.isArray(fieldsRaw) ? (fieldsRaw as string[]) : null;
    return {
      errorCode,
      message: message ?? `Salesforce returned an error entry with no recognizable message/errorCode field: ${JSON.stringify(entry)}`,
      fields,
      extra: obj ?? { rawEntry: entry },
    };
  });
}

/**
 * §Do not assume Product Discovery is the problem — this only decides
 * whether to LABEL the failure as a configuration issue for the message
 * text; the full raw error (see `transcript`/`attemptErrors`) is always
 * attached regardless, so the actual cause can be diagnosed from the raw
 * data rather than this label.
 */
function looksLikeConfigurationIssue(message: string): boolean {
  return /pricing.?context|pricing procedure|pricing engine|no active price|catalog not published|couldn.?t refresh the prices|couldn.?t retrieve the product and price|product discovery|validate the configuration/i.test(message);
}

/**
 * Trigger Salesforce's own repricing for a RevenueCloudPricing-model org
 * (§4.9, §6.4) after line items have been created/discount-edited, via the
 * documented Instant Pricing API. Never lets local pricing math silently
 * fight the pricing engine's numbers — this is the only path that writes
 * NetUnitPrice/TotalPrice back for such orgs.
 *
 * The request is Salesforce's own composite-record shape: every record to
 * be priced (the Quote itself, plus every one of its current
 * QuoteLineItems — the API requires both, not just the Quote) is passed
 * with `attributes.method: "PUT"`, which is what tells Salesforce to price
 * AND persist the result onto the existing record, not just preview it.
 *
 * §Phase 2 (never lose the real Salesforce response): uses
 * `client.requestWithDiagnostics()` rather than `client.request()` — the
 * complete raw HTTP transcript (status, statusText, content-type, the
 * exact response text read exactly once, and the JSON-parsed body) is
 * captured into `transcript` and returned UNCONDITIONALLY, whether the
 * call "succeeds" or not, so a response this app's parsing doesn't fully
 * understand is still fully visible instead of collapsing to `{}`.
 */
export async function repriceQuote(client: SalesforceClient, quoteId: string): Promise<RepricingSummary> {
  const attemptErrors: RepricingAttemptError[] = [];
  const attemptedRequests: RepricingAttemptRequest[] = [];

  // §Phase 3/6 evidence (Salesforce's own Instant Pricing documentation,
  // fetched directly rather than assumed): each "record" in the request's
  // `records` array must carry the ACTUAL FIELD VALUES the pricing
  // calculation needs — for QuoteLineItem: QuoteId, PricebookEntryId,
  // Product2Id, Quantity, UnitPrice; for Quote: Name, Pricebook2Id,
  // OpportunityId — not merely a bare `{Id}` reference. The prior
  // implementation sent only `{Id}` per record, which is very likely why
  // Salesforce's pricing procedure had nothing to calculate from and
  // returned a genuinely empty per-record error. Every field name below is
  // resolved via the SAME Describe-driven schema resolvers already used to
  // build the QLI create payload — never hardcoded.
  const [qliSchema, quoteSchema] = await Promise.all([
    resolveQuoteLineItemFieldSchema(client),
    resolveQuoteFieldSchema(client),
  ]);

  interface LineItemPricingRow {
    Id: string;
    quoteId: string | null;
    product2Id: string | null;
    pricebookEntryId: string | null;
    quantity: number | null;
    /** The PricebookEntry's own (list) UnitPrice, dot-walked via the resolved relationship — the pricing calculation's INPUT, distinct from the QuoteLineItem's own (possibly still-null/calculated) UnitPrice. */
    pricebookEntryUnitPrice: number | null;
    /**
     * §Discount pricing fix — the persisted, already-correct line-level
     * discount percentage. Runtime evidence (Salesforce's own Calculation
     * Details panel: "Percentage-Based (Line-Level): 60.00%") shows Revenue
     * Cloud's pricing procedure computing NetUnitPrice FROM this exact
     * standard field, not from a separate adjustment object. Previously
     * this row (and the request body below) never included Discount at
     * all — even if this endpoint were called, Salesforce would reprice
     * every line back to its undiscounted list price. This is the concrete
     * fix: send the line's real, already-persisted Discount so Salesforce's
     * OWN engine computes the SAME adjustment it would from a manual UI
     * edit, instead of silently discarding it.
     */
    discount: number | null;
  }

  let lineItems: LineItemPricingRow[];
  try {
    const selectFields = ["Id"];
    if (qliSchema.quoteField) selectFields.push(qliSchema.quoteField.apiName);
    if (qliSchema.productField) selectFields.push(qliSchema.productField.apiName);
    if (qliSchema.pricebookEntryField) selectFields.push(qliSchema.pricebookEntryField.apiName);
    if (qliSchema.quantityField) selectFields.push(qliSchema.quantityField.apiName);
    if (qliSchema.discountField) selectFields.push(qliSchema.discountField.apiName);
    if (qliSchema.pricebookEntryField?.relationshipName) selectFields.push(`${qliSchema.pricebookEntryField.relationshipName}.UnitPrice`);
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(selectFields)].join(", ")} FROM QuoteLineItem WHERE QuoteId = '${soqlEscape(quoteId)}'`,
    );
    lineItems = result.records.map(r => {
      const pbeRel = qliSchema.pricebookEntryField?.relationshipName ? (r[qliSchema.pricebookEntryField.relationshipName] as Record<string, unknown> | undefined) : undefined;
      return {
        Id: r.Id as string,
        quoteId: qliSchema.quoteField ? ((r[qliSchema.quoteField.apiName] as string) ?? null) : null,
        product2Id: qliSchema.productField ? ((r[qliSchema.productField.apiName] as string) ?? null) : null,
        pricebookEntryId: qliSchema.pricebookEntryField ? ((r[qliSchema.pricebookEntryField.apiName] as string) ?? null) : null,
        quantity: qliSchema.quantityField ? ((r[qliSchema.quantityField.apiName] as number) ?? null) : null,
        pricebookEntryUnitPrice: (pbeRel?.UnitPrice as number | undefined) ?? null,
        discount: qliSchema.discountField ? ((r[qliSchema.discountField.apiName] as number) ?? null) : null,
      };
    });
  } catch (err) {
    return {
      attempted: false, succeeded: false, isConfigurationIssue: false,
      message: `Could not query this Quote's line items before repricing: ${err instanceof Error ? err.message : String(err)}`,
      lines: [], attemptErrors, attemptedRequests, transcript: null,
    };
  }

  if (lineItems.length === 0) {
    return {
      attempted: false, succeeded: false, isConfigurationIssue: false,
      message: "No QuoteLineItems exist on this Quote to reprice.",
      lines: [], attemptErrors, attemptedRequests, transcript: null,
    };
  }
  const lineItemIds = lineItems.map(l => l.Id);

  let quoteRecord: Record<string, unknown> = {};
  try {
    const quoteSelectFields = ["Id"];
    if (quoteSchema.nameField) quoteSelectFields.push(quoteSchema.nameField.apiName);
    if (quoteSchema.pricebookField) quoteSelectFields.push(quoteSchema.pricebookField.apiName);
    if (quoteSchema.opportunityField) quoteSelectFields.push(quoteSchema.opportunityField.apiName);
    const res = await client.query<Record<string, unknown>>(
      `SELECT ${[...new Set(quoteSelectFields)].join(", ")} FROM Quote WHERE Id = '${soqlEscape(quoteId)}' LIMIT 1`,
    );
    quoteRecord = res.records[0] ?? {};
  } catch (err) {
    console.error(`[repriceQuote] Could not query the Quote's own field values before repricing (continuing with Id only):`, err instanceof Error ? err.message : String(err));
  }

  const quoteFieldValues: Record<string, unknown> = {};
  if (quoteSchema.nameField && quoteRecord[quoteSchema.nameField.apiName] != null) quoteFieldValues[quoteSchema.nameField.apiName] = quoteRecord[quoteSchema.nameField.apiName];
  if (quoteSchema.pricebookField && quoteRecord[quoteSchema.pricebookField.apiName] != null) quoteFieldValues[quoteSchema.pricebookField.apiName] = quoteRecord[quoteSchema.pricebookField.apiName];
  if (quoteSchema.opportunityField && quoteRecord[quoteSchema.opportunityField.apiName] != null) quoteFieldValues[quoteSchema.opportunityField.apiName] = quoteRecord[quoteSchema.opportunityField.apiName];

  // §Phase 21/22 fix — read-only diagnostic, never sent to Salesforce: this request body (below) carries
  // no per-line attribute selections at all — this app's own Instant Pricing docs comment (top of this
  // file) and every attempt to verify Salesforce's real request schema for this endpoint were blocked
  // (developer.salesforce.com returned HTTP 403 to every fetch attempt this session), so this does NOT
  // assume that omission is a bug — Salesforce's declarative pricing procedures typically evaluate
  // Attribute-Based Pricing by reading a QuoteLineItem's own already-persisted QuoteLineItemAttribute
  // child records server-side (by the QuoteLineItem Id this request already includes), the same
  // relational-lookup model this app's own `resolveRuntimeAttributeAdjustment` (Attribute-Based Pricing
  // module) already replicates read-only for verification. What CAN be checked here, without guessing at
  // an unverified request-schema field: whether those child records actually exist and are populated at
  // the moment this reprice call fires — if a live run's calculated price never reflects the selected
  // attribute values, this log is the first place to check (a genuinely empty/missing set here would mean
  // the attribute-selection UI never persisted them, or persisted them too late — a real, checkable bug;
  // a populated set here that STILL doesn't affect the price would instead point at the org's own Pricing
  // Procedure/AttributeDiscount configuration, not at this request payload).
  try {
    const qliAttrSchema = await resolveQuoteLineItemAttributeFieldSchema(client);
    if (qliAttrSchema.objectName && qliAttrSchema.quoteLineItemField && qliAttrSchema.attributeField && qliAttrSchema.valueField) {
      const attrSelectFields = ["Id", qliAttrSchema.quoteLineItemField.apiName, qliAttrSchema.attributeField.apiName, qliAttrSchema.valueField.apiName];
      const attrRes = await client.query<Record<string, unknown>>(
        `SELECT ${[...new Set(attrSelectFields)].join(", ")} FROM ${qliAttrSchema.objectName} WHERE ${qliAttrSchema.quoteLineItemField.apiName} IN (${lineItemIds.map(id => `'${soqlEscape(id)}'`).join(",")})`,
      );
      const byLine = new Map<string, { attributeId: unknown; value: unknown }[]>();
      for (const rec of attrRes.records) {
        const lineId = rec[qliAttrSchema.quoteLineItemField.apiName] as string;
        if (!byLine.has(lineId)) byLine.set(lineId, []);
        byLine.get(lineId)!.push({ attributeId: rec[qliAttrSchema.attributeField!.apiName], value: rec[qliAttrSchema.valueField!.apiName] });
      }
      for (const li of lineItems) {
        const attrs = byLine.get(li.Id) ?? [];
        console.log(
          `[QLI ATTRIBUTES] QuoteLineItem ${li.Id} — ${attrs.length} ${qliAttrSchema.objectName} record(s) at repricing time` +
          (attrs.length > 0 ? `: ${attrs.map(a => `${a.attributeId}=${a.value}`).join(", ")}` : " (none — if this line's price was expected to reflect a configured attribute selection, this is the reason it can't)."),
        );
      }
    } else {
      console.log(`[QLI ATTRIBUTES] This org's schema does not expose a resolvable QuoteLineItemAttribute object/field set — skipping the diagnostic (never fatal).`);
    }
  } catch (err) {
    console.log(`[QLI ATTRIBUTES] Diagnostic query failed (non-fatal, informational only): ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = {
    correlationId: `reprice-${quoteId}-${Date.now()}`,
    records: [
      { referenceId: quoteId, record: { attributes: { type: "Quote", method: "PUT" }, Id: quoteId, ...quoteFieldValues } },
      ...lineItems.map(li => {
        const fieldValues: Record<string, unknown> = {};
        if (qliSchema.quoteField) fieldValues[qliSchema.quoteField.apiName] = li.quoteId ?? quoteId;
        if (qliSchema.productField && li.product2Id) fieldValues[qliSchema.productField.apiName] = li.product2Id;
        if (qliSchema.pricebookEntryField && li.pricebookEntryId) fieldValues[qliSchema.pricebookEntryField.apiName] = li.pricebookEntryId;
        if (qliSchema.quantityField && li.quantity != null) fieldValues[qliSchema.quantityField.apiName] = li.quantity;
        // §The pricing calculation's INPUT price — the PricebookEntry's own
        // list UnitPrice, never a UI/catalog estimate captured earlier in
        // the session and never the QuoteLineItem's own (possibly still-
        // null/calculated) UnitPrice. Only sent when this org's schema has
        // a UnitPrice field to seed at all.
        if (qliSchema.unitPriceField && li.pricebookEntryUnitPrice != null) fieldValues[qliSchema.unitPriceField.apiName] = li.pricebookEntryUnitPrice;
        // §Discount pricing fix — the persisted, real line-level discount
        // percentage. Previously omitted entirely, which meant even a
        // successful repricing call would silently reprice every line back
        // to 0% discount (its raw list price) — Salesforce's pricing
        // procedure has no other input telling it a manual "Percentage-
        // Based (Line-Level)" adjustment applies to this line.
        if (qliSchema.discountField && li.discount != null) fieldValues[qliSchema.discountField.apiName] = li.discount;
        return { referenceId: li.Id, record: { attributes: { type: "QuoteLineItem", method: "PUT" }, Id: li.Id, ...fieldValues } };
      }),
    ],
  };
  attemptedRequests.push({ path: INSTANT_PRICING_PATH, method: "POST", body });
  console.log(`[PRICING REQUEST] endpoint=${INSTANT_PRICING_PATH} method=POST quoteId=${quoteId} lineItemCount=${lineItemIds.length} lineItemIds=${JSON.stringify(lineItemIds)} payload=${JSON.stringify(body)}`);

  let http: Awaited<ReturnType<SalesforceClient["requestWithDiagnostics"]>>;
  try {
    http = await client.requestWithDiagnostics(INSTANT_PRICING_PATH, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    // §Never JSON.stringify an Error — read name/message/cause directly.
    // This is a genuine network-level failure (fetch itself rejected),
    // distinct from an HTTP-level error response (handled below).
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause) : null;
    console.error(`[PRICING RESPONSE] Network-level failure calling ${INSTANT_PRICING_PATH}: name=${name} message=${message} cause=${cause ?? "n/a"}`, err instanceof Error ? err.stack : "");
    attemptErrors.push({
      path: INSTANT_PRICING_PATH, status: null, errorCode: null,
      message: `Network-level failure calling ${INSTANT_PRICING_PATH}: ${name}: ${message}${cause ? ` (cause: ${cause})` : ""}`,
      fields: null, entries: [], rawBody: null, rawText: null,
    });
    return {
      attempted: true, succeeded: false, isConfigurationIssue: false,
      message: `Repricing request failed before Salesforce responded: ${name}: ${message}`,
      lines: [], attemptErrors, attemptedRequests, transcript: null,
    };
  }

  const transcript: RepricingHttpTranscript = {
    url: http.url, method: "POST", status: http.status, statusText: http.statusText,
    contentType: http.contentType, rawText: http.rawText, json: http.json, jsonParseError: http.jsonParseError,
  };
  console.log(
    `[PRICING RESPONSE] status=${http.status} statusText="${http.statusText}" contentType=${http.contentType ?? "n/a"} ` +
    `jsonParseError=${http.jsonParseError ?? "none"} rawText(first 2000 chars)=${http.rawText.slice(0, 2000)}`,
  );

  const httpOk = http.status >= 200 && http.status < 300;

  if (!httpOk) {
    // §The HTTP call itself was rejected (4xx/5xx) — the previous code path
    // only handled this via a thrown SalesforceError from client.request(),
    // whose message-derivation could still land on something unhelpful for
    // an unusual error body shape. Report the FULL transcript directly.
    const bodyMessage = extractHttpLevelMessage(http.json, http.jsonParseError, http.rawText);
    const message = `HTTP ${http.status} ${http.statusText}: ${bodyMessage}`;
    const isConfigurationIssue = looksLikeConfigurationIssue(message);
    attemptErrors.push({
      path: INSTANT_PRICING_PATH, status: http.status, errorCode: null,
      message, fields: null, entries: [], rawBody: http.json, rawText: http.jsonParseError ? http.rawText : null,
    });
    return {
      attempted: true, succeeded: false, isConfigurationIssue,
      message: isConfigurationIssue
        ? `Repricing failed due to a Revenue Cloud pricing configuration issue in this org: ${message}`
        : `Repricing unavailable: ${message}`,
      lines: [], attemptErrors, attemptedRequests, transcript,
    };
  }

  if (http.jsonParseError) {
    // 2xx but not valid JSON — never silently treat as success.
    const message = `Salesforce returned HTTP ${http.status} with a non-JSON body (${http.jsonParseError}): ${http.rawText.slice(0, 2000)}`;
    attemptErrors.push({ path: INSTANT_PRICING_PATH, status: http.status, errorCode: null, message, fields: null, entries: [], rawBody: null, rawText: http.rawText });
    return {
      attempted: true, succeeded: false, isConfigurationIssue: false,
      message: `Repricing unavailable: ${message}`,
      lines: [], attemptErrors, attemptedRequests, transcript,
    };
  }

  const records = extractRecordResults(http.json);
  const lineItemIdSet = new Set(lineItemIds);
  const lines: RepricingLineResult[] = [];
  const lineErrors: RepricingErrorEntry[] = [];
  const quoteErrors: RepricingErrorEntry[] = [];
  const unmatchedRecords: unknown[] = [];

  for (const rec of records) {
    // §Do not require Salesforce to echo record.attributes.type: a FAILED
    // record commonly comes back with `record` null/omitted entirely, so
    // gating on `record.attributes.type` silently dropped every rejected
    // line before its error was ever even inspected. Match by
    // `referenceId` instead — WE chose every referenceId when building the
    // request, so this is authoritative regardless of what `record`
    // Salesforce returns.
    const id = rec.referenceId ?? rec.record?.Id;
    // §isSuccess === false with an empty/absent errors array (an Invocable-
    // Action-style envelope) is ALSO a rejection, even with nothing else to
    // report — never treat a missing error body as "no error".
    const explicitFailure = rec.isSuccess === false;
    let errors = normalizeRecordErrors(rec);
    if (explicitFailure && errors.length === 0) {
      errors = [{ errorCode: null, message: `Salesforce reported isSuccess:false for this record with no error detail attached. Full record: ${JSON.stringify(rec)}`, fields: null, extra: { rawRecord: rec } }];
    }

    if (id === quoteId) {
      // A rejected Quote record itself would explain "every line item
      // rejected" just as well as a per-line issue — never discard this.
      quoteErrors.push(...errors.map(e => ({ ...e, extra: { ...(e.extra ?? {}), recordKind: "Quote", quoteId } })));
      continue;
    }
    if (id && lineItemIdSet.has(id)) {
      if (errors.length > 0) {
        lineErrors.push(...errors.map(e => ({ ...e, extra: { ...(e.extra ?? {}), quoteLineItemId: id } })));
      } else if (rec.record) {
        lines.push({
          quoteLineItemId: id,
          netUnitPrice: rec.record.NetUnitPrice ?? null,
          netTotalPrice: rec.record.NetTotalPrice ?? null,
          listPrice: rec.record.ListPrice ?? null,
          discount: rec.record.Discount ?? null,
          // The API's own `method: "PUT"` on the request record is what asks
          // Salesforce to persist the computed price onto the existing
          // record (not just preview it) — no separate updateRecord() call
          // needed.
          written: true,
        });
      } else if (rec.outputValues && typeof rec.outputValues === "object") {
        // Invocable-Action-style envelope: pricing fields may live under
        // outputValues instead of record.
        const ov = rec.outputValues as InstantPricingRecord;
        lines.push({
          quoteLineItemId: id,
          netUnitPrice: (ov.NetUnitPrice as number | undefined) ?? null,
          netTotalPrice: (ov.NetTotalPrice as number | undefined) ?? null,
          listPrice: (ov.ListPrice as number | undefined) ?? null,
          discount: (ov.Discount as number | undefined) ?? null,
          written: true,
        });
      } else {
        // Neither an error NOR usable pricing data came back for this
        // QuoteLineItem — genuinely unexpected; never silently treat as
        // "succeeded".
        unmatchedRecords.push(rec);
      }
      continue;
    }
    // A record we can't attribute to the Quote or any of its line items —
    // surfaced rather than silently ignored.
    unmatchedRecords.push(rec);
  }

  if (quoteErrors.length > 0) console.error(`[repriceQuote] Quote record itself was rejected:`, JSON.stringify(quoteErrors));
  if (unmatchedRecords.length > 0) console.error(`[repriceQuote] ${unmatchedRecords.length} response record(s) could not be matched to the Quote or any requested QuoteLineItem:`, JSON.stringify(unmatchedRecords));
  if (lineErrors.length > 0) console.error(`[repriceQuote] ${lineErrors.length} line(s) returned a per-record error:`, JSON.stringify(lineErrors));

  const allErrors = [...quoteErrors, ...lineErrors];
  if (allErrors.length > 0 || unmatchedRecords.length > 0 || (lines.length === 0 && lineItemIds.length > 0)) {
    const first = allErrors[0];
    const message = first?.message
      ?? (unmatchedRecords.length > 0
        ? `Salesforce returned ${unmatchedRecords.length} response record(s) that could not be matched to the Quote or any of its line items, and none of them carried an error — full records: ${JSON.stringify(unmatchedRecords).slice(0, 4000)}`
        : records.length === 0
          ? `Salesforce's Instant Pricing response contained zero result records for ${lineItemIds.length} line item(s) submitted. Raw response: ${http.rawText.slice(0, 2000)}`
          : `Salesforce's Instant Pricing response contained no records and no errors for ${lineItemIds.length} line item(s) submitted.`);
    const isConfigurationIssue = looksLikeConfigurationIssue(message);
    attemptErrors.push({
      path: INSTANT_PRICING_PATH, status: http.status, errorCode: first?.errorCode ?? null,
      message, fields: first?.fields ?? null,
      entries: [...quoteErrors, ...lineErrors, ...unmatchedRecords.map((r): RepricingErrorEntry => ({
        errorCode: null, message: "Unmatched response record.", fields: null, extra: { rawRecord: r },
      }))],
      rawBody: http.json, rawText: null,
    });
    return {
      attempted: true, succeeded: false, isConfigurationIssue,
      message: isConfigurationIssue
        ? `Repricing failed due to a Revenue Cloud pricing configuration issue in this org: ${message}`
        : `Repricing unavailable: ${message}`,
      lines, attemptErrors, attemptedRequests, transcript,
    };
  }

  // §Do not assume Salesforce automatically persists the priced result: the
  // request's `attributes.method: "PUT"` is Salesforce's documented signal
  // to persist rather than merely preview, but this app has no independent
  // proof that persistence actually happened for THIS org/endpoint — the
  // exact assumption the user asked not to make. This codebase's own Order-
  // side equivalent (lib/orders/pricing/reprice.ts) does NOT trust this
  // either — it explicitly re-writes the computed price via updateRecord(),
  // gated on Describe confirming the target field is genuinely updateable.
  // Mirrored here: an explicit, Describe-gated write-back of the exact
  // values Salesforce's OWN pricing response just returned (never a UI/
  // catalog price) — skipped entirely for any field Describe reports as
  // NOT updateable (never force-write a calculated/read-only field).
  if (lines.length > 0) {
    try {
      const qliDescribe = await describeObjectCached(client, "QuoteLineItem");
      const netUnitPriceField = resolveField(qliDescribe, "NetUnitPrice", /^net unit price$/i);
      const netTotalPriceField = resolveField(qliDescribe, "NetTotalPrice", /^net total price$/i);
      const writableNetUnit = netUnitPriceField?.updateable ? netUnitPriceField.name : null;
      const writableNetTotal = netTotalPriceField?.updateable ? netTotalPriceField.name : null;

      if (writableNetUnit || writableNetTotal) {
        const updates = lines
          .filter(l => l.netUnitPrice != null || l.netTotalPrice != null)
          .map(l => {
            const record: Record<string, unknown> = { Id: l.quoteLineItemId };
            if (writableNetUnit && l.netUnitPrice != null) record[writableNetUnit] = l.netUnitPrice;
            if (writableNetTotal && l.netTotalPrice != null) record[writableNetTotal] = l.netTotalPrice;
            return record as { Id: string; [key: string]: unknown };
          });
        console.log(`[repriceQuote] Explicit write-back: NetUnitPrice field "${writableNetUnit ?? "not updateable"}", NetTotalPrice field "${writableNetTotal ?? "not updateable"}" — writing ${updates.length} record(s).`);
        const results = await client.compositeUpdate("QuoteLineItem", updates, false);
        const writtenIds = new Set(updates.map((u, i) => (results[i]?.success ? u.Id : null)).filter((id): id is string => !!id));
        for (const line of lines) line.written = writtenIds.has(line.quoteLineItemId);
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) {
          console.error(`[repriceQuote] Explicit write-back rejected for ${failed.length} record(s):`, JSON.stringify(failed.map(r => r.errors)));
        }
      } else {
        console.log(`[repriceQuote] NetUnitPrice/NetTotalPrice are not updateable on this org's QuoteLineItem — relying solely on the request's method:"PUT" to have persisted the price; final read-back will confirm.`);
        for (const line of lines) line.written = false;
      }
    } catch (err) {
      console.error(`[repriceQuote] Explicit write-back attempt failed:`, err instanceof Error ? err.message : String(err));
      for (const line of lines) line.written = false;
    }
  }

  return { attempted: true, succeeded: true, isConfigurationIssue: false, message: null, lines, attemptErrors, attemptedRequests, transcript };
}

/** Best-effort human-readable message for an HTTP-level (4xx/5xx) failure, from whatever shape the body actually has — never assumes a specific key exists. */
function extractHttpLevelMessage(json: unknown, jsonParseError: string | null, rawText: string): string {
  if (jsonParseError) return `Non-JSON response body: ${rawText.slice(0, 2000)}`;
  if (Array.isArray(json) && json.length > 0) {
    const first = json[0] as Record<string, unknown>;
    const msg = typeof first?.message === "string" ? first.message : null;
    return msg ?? JSON.stringify(json).slice(0, 2000);
  }
  if (json != null && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const msg = (typeof obj.message === "string" && obj.message)
      || (typeof obj.error_description === "string" && obj.error_description)
      || (typeof obj.error === "string" && obj.error);
    return msg || JSON.stringify(json).slice(0, 2000);
  }
  return rawText.slice(0, 2000) || "(empty response body)";
}
