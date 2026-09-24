import type { SalesforceClient, DescribeField } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";
import { describeObjectCached } from "@/lib/salesforce/describe";
import { resolveField, findReferenceFieldByTargetObject, findPicklistFieldByLabel, type PicklistResolution } from "@/lib/salesforce/describe";
import type { BillingFrequencyResolution, SubscriptionTermResolution } from "@/lib/quotes/types";

/** Which line-item object this resolution is ultimately for — QuoteLineItem and OrderItem each have their own BillingFrequency/SubscriptionTerm field and their own active picklist values; resolving/validating against the wrong one silently produces null or an incorrect value for whichever module didn't match. */
export type LineItemObjectName = "QuoteLineItem" | "OrderItem";

// §Cadence parsing: ORDER IS SIGNIFICANT — more specific patterns MUST be
// listed before the more general patterns they overlap with. "semi-annual"
// is listed before "annual" because the string "Semi-Annual" also satisfies
// a naive /annual/i test (it literally contains the substring "annual") —
// classifyCadence() below stops at the FIRST match, so semi-annual is never
// reachable by the annual pattern once semi-annual itself already claimed
// it. Every entry also anchors on the cadence WORD, not the year math, so
// "Year"/"Years"/"Yearly"/"Annual"/"Annually" all mean the same thing.
const CADENCE_MAP: [string, RegExp][] = [
  ["milestone", /milestone/i],
  ["semi-annual", /semi[- ]?annual(ly)?|semiannual(ly)?|half[- ]?year(ly)?/i],
  ["monthly", /\bmonth(ly)?\b/i],
  ["quarterly", /\bquarter(ly)?\b/i],
  ["annual", /\b(annual(ly)?|years?|yearly)\b/i],
  ["weekly", /\bweek(ly)?\b/i],
  ["daily", /\bdaily\b|\bday\b/i],
];

/**
 * Classify free text (a Selling Model's Name, a raw field value, a pricing-
 * term string) into AT MOST ONE cadence key — the FIRST entry in
 * CADENCE_MAP (in priority order) whose pattern matches. Classifying into a
 * single, mutually-exclusive key — rather than testing each candidate cadence
 * independently and letting an ambiguous later match win — is what
 * guarantees "Semi-Annual" is never misclassified as "annual" just because
 * it happens to contain that substring.
 */
function classifyCadence(text: string): string | null {
  for (const [key, pattern] of CADENCE_MAP) {
    if (pattern.test(text)) return key;
  }
  return null;
}

/**
 * §Fetch ANY billing-frequency-equivalent field: used ONLY for the two
 * READ-only source lookups (Product2, ProductSellingModel) — never for the
 * QuoteLineItem/OrderItem field being written to, which must stay an exact
 * match. Those two are ad-hoc custom fields an org admin names however they
 * like ("Renewal Frequency", "Subscription Cadence", "Payment Frequency",
 * plain "Frequency", etc.) — an anchored `^billing frequency$` label match
 * silently skips a real, populated field just because it wasn't named that
 * one exact way, which is indistinguishable from "this org has no such
 * field at all" to every downstream fallback. Loosening this is safe: the
 * raw value found is never used as-is — it still has to pass
 * mapToActiveBillingFrequency()/matchCadenceToActiveOption() against the
 * target's real active picklist options before being accepted, so an
 * accidental match against an unrelated "frequency"-labeled field just
 * fails to map and falls through to the next source, same as today.
 */
const BILLING_FREQUENCY_LABEL_PATTERN = /\b(frequency|cadence)\b/i;

/**
 * §Billing Frequency VALUE MAPPING: a raw value read from Product2 or
 * ProductSellingModel's OWN "Billing Frequency"-labeled field must NEVER be
 * assumed to already be one of QuoteLineItem.BillingFrequency's real active
 * picklist values — they can be entirely different picklist definitions
 * (e.g. a Product2 catalog convention using short internal codes like "A"
 * while QuoteLineItem.BillingFrequency's real active values are full words
 * like "Annual"). Cross-checks the raw value against the target picklist's
 * CURRENT active values before ever accepting it, with NO hardcoded
 * code->word table:
 *   1. Exact match (value or label, case/space-insensitive) against the
 *      target's active options — the common case when both fields share
 *      the same picklist definition.
 *   2. Otherwise, look up the raw value's own LABEL on the SOURCE field's
 *      Describe metadata (Salesforce always knows a picklist value's real
 *      label, even for an internal-looking code) and cadence-classify
 *      THAT label against the target's active option labels/values, reusing
 *      the same single-cadence-key classification used for the Selling
 *      Model Name and pricing-term sources below — never a fabricated
 *      literal mapping.
 * Returns null (never the raw value) when neither yields a confident match —
 * the caller must treat that as "this source didn't yield a usable value"
 * and keep trying the next fallback source, not use the raw value as-is.
 */
function mapToActiveBillingFrequency(rawValue: string, sourceField: DescribeField, qliPicklist: PicklistResolution): string | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const exact = qliPicklist.activeOptions.find(o => norm(o.value) === norm(rawValue) || norm(o.label) === norm(rawValue));
  if (exact) return exact.value;

  const sourceLabel = sourceField.picklistValues?.find(v => norm(v.value) === norm(rawValue))?.label ?? rawValue;
  return matchCadenceToActiveOption(sourceLabel, qliPicklist)?.value ?? null;
}

/**
 * Cadence-word match (reused for the Selling Model's Name and its own
 * pricing-term/cadence field) against the target picklist's real active
 * values — never a fabricated literal mapping. Classifies BOTH the source
 * text and every candidate target option into a single cadence key
 * (`classifyCadence`) and matches by key EQUALITY, not by re-testing the
 * source's pattern against the target (which is what let "Semi-Annual"
 * satisfy the "annual" pattern purely by substring containment — §CRITICAL
 * FIX: Selling Model Name -> Billing Frequency Mapping).
 */
function matchCadenceToActiveOption(text: string, qliPicklist: PicklistResolution): { value: string; matchedCadence: string } | null {
  const cadenceKey = classifyCadence(text);
  if (!cadenceKey) return null;
  const match = qliPicklist.activeOptions.find(o => classifyCadence(o.label) === cadenceKey || classifyCadence(o.value) === cadenceKey);
  return match ? { value: match.value, matchedCadence: cadenceKey } : null;
}

/**
 * Resolve the Billing Frequency to apply to a new line item (§4.3), trying
 * each source in order and stopping at the first that yields a value.
 * Never falls back to guessing from the product's name.
 *
 * §Automatically select the Selling Model's own cadence: sources are
 * ordered MOST-SPECIFIC-TO-THIS-LINE first. A Selling Model named e.g.
 * "Term Based - Monthly" or with its own pricing-term field IS this line's
 * real cadence — that beats a blunt Product2-level default or a value from
 * some unrelated existing QuoteLineItem, which say nothing about which
 * specific Selling Model THIS line is using (a product can have several).
 * Getting this order wrong is exactly how a line using a Monthly Selling
 * Model can end up with an unrelated "Annual" default that Salesforce's own
 * Billing Treatment validation then rejects.
 */
export async function resolveBillingFrequency(
  client: SalesforceClient,
  productId: string,
  sellingModelId: string | null,
  sellingModelName: string | null = null,
  lineItemObject: LineItemObjectName = "QuoteLineItem",
): Promise<BillingFrequencyResolution> {
  const attempts: { step: string; outcome: string }[] = [];
  // §TEMP DIAGNOSTIC (remove once Antivirus-class Billing Frequency
  // failures are confirmed resolved): logs the exact resolution outcome —
  // which of the 6 sources matched (or none), the raw Salesforce value,
  // and the normalized value actually returned. Never logs credentials/tokens.
  console.log(`[BILLING FREQUENCY SOURCE] productId=${productId} sellingModelId=${sellingModelId ?? "null"} sellingModelName=${sellingModelName ?? "null"} lineItemObject=${lineItemObject} — resolution starting.`);
  function logAndReturn(result: BillingFrequencyResolution): BillingFrequencyResolution {
    console.log(`[BILLING FREQUENCY SOURCE] productId=${productId} sellingModelId=${sellingModelId ?? "null"} -> source=${result.source ?? "none"} value=${result.value ?? "null"} fieldApiName=${result.fieldApiName ?? "null"}. attempts=${JSON.stringify(result.attempts)}`);
    return result;
  }
  // Resolve directly against whichever object THIS call is actually for —
  // QuoteLineItem.BillingFrequency and OrderItem.BillingFrequency are
  // different fields with potentially different active picklist values, so
  // this must never be hardcoded to one when serving the other (§Order
  // billing frequency parity fix).
  const lineItemDescribe = await describeObjectCached(client, lineItemObject);
  const qliFrequencyField = resolveField(lineItemDescribe, "BillingFrequency", /^billing frequency$/i)?.name ?? null;
  if (!qliFrequencyField) {
    attempts.push({ step: "resolve-metadata", outcome: `No BillingFrequency field resolved on ${lineItemObject} in this org — cannot resolve or write a value at all.` });
    return logAndReturn({ value: null, source: null, fieldApiName: null, attempts, activeOptions: [] });
  }

  // Resolve this object's own BillingFrequency real active picklist values
  // ONCE — this is the ONLY source of truth every candidate below is checked
  // against before being accepted (§Billing Frequency VALUE MAPPING). A raw
  // value read from a DIFFERENT object's own "Billing Frequency"-labeled
  // field must never be assumed to already be one of these.
  const qliPicklist = findPicklistFieldByLabel(lineItemDescribe, "BillingFrequency", /^billing frequency$/i);
  if (!qliPicklist) {
    attempts.push({ step: "resolve-metadata", outcome: `${lineItemObject}.BillingFrequency is not describable as a picklist in this org — cannot validate candidate values against active options.` });
    return logAndReturn({ value: null, source: null, fieldApiName: qliFrequencyField, attempts, activeOptions: [] });
  }

  // 1. The resolved ProductSellingModel's own dedicated BillingFrequency
  // field, if this org has one — the most authoritative signal, scoped
  // exactly to the selling model THIS line is using.
  if (sellingModelId) {
    try {
      const psmDescribe = await describeObjectCached(client, "ProductSellingModel");
      const psmField = resolveField(psmDescribe, "BillingFrequency", BILLING_FREQUENCY_LABEL_PATTERN);
      if (psmField) {
        const row = await client.query<Record<string, unknown>>(
          `SELECT ${psmField.name} FROM ProductSellingModel WHERE Id = '${soqlEscape(sellingModelId)}' LIMIT 1`,
        );
        const raw = row.records[0]?.[psmField.name] as string | undefined;
        if (raw) {
          const mapped = mapToActiveBillingFrequency(raw, psmField, qliPicklist);
          if (mapped) {
            attempts.push({ step: "selling-model", outcome: mapped === raw ? `Found on ProductSellingModel.${psmField.name} = "${raw}".` : `Found on ProductSellingModel.${psmField.name} = "${raw}" — mapped to active ${lineItemObject}.BillingFrequency value "${mapped}".` });
            return logAndReturn({ value: mapped, source: "selling-model", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
          }
          attempts.push({ step: "selling-model", outcome: `ProductSellingModel.${psmField.name} = "${raw}", but this could not be confidently mapped to any of ${lineItemObject}.BillingFrequency's currently active values (${qliPicklist.activeOptions.map(o => o.value).join(", ")}) — not used.` });
        } else {
          attempts.push({ step: "selling-model", outcome: `ProductSellingModel.${psmField.name} exists but is blank.` });
        }
      } else {
        attempts.push({ step: "selling-model", outcome: "No BillingFrequency-shaped field found on ProductSellingModel." });
      }
    } catch (err) {
      attempts.push({ step: "selling-model", outcome: `Query failed: ${err instanceof Error ? err.message : "unknown error"}.` });
    }
  } else {
    attempts.push({ step: "selling-model", outcome: "Skipped — no Selling Model resolved for this product." });
  }

  // 2. The Selling Model's own NAME (e.g. "Term Based - Monthly") — real
  // orgs commonly name selling models by cadence; this is still scoped
  // exactly to THIS line's selling model, unlike Product2/existing-QLI below.
  if (sellingModelName) {
    const matched = matchCadenceToActiveOption(sellingModelName, qliPicklist);
    if (matched) {
      attempts.push({ step: "selling-model-name", outcome: `Selling Model name "${sellingModelName}" -> matched cadence token "${matched.matchedCadence}" -> active ${lineItemObject}.BillingFrequency value "${matched.value}".` });
      return logAndReturn({ value: matched.value, source: "selling-model-name", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
    }
    attempts.push({ step: "selling-model-name", outcome: `Selling Model name "${sellingModelName}" did not match a recognized cadence word, or no active BillingFrequency option corresponds to it.` });
  } else {
    attempts.push({ step: "selling-model-name", outcome: "Skipped — no Selling Model name available." });
  }

  // 3. Selling model's pricing term/cadence field, mapped onto a real active picklist option.
  if (sellingModelId) {
    try {
      const psmDescribe = await describeObjectCached(client, "ProductSellingModel");
      const cadenceField =
        resolveField(psmDescribe, "PricingTerm", /^pricing term$/i) ??
        resolveField(psmDescribe, "PricingTermUnit", /^pricing term unit$/i);
      if (cadenceField) {
        const row = await client.query<Record<string, unknown>>(
          `SELECT ${cadenceField.name} FROM ProductSellingModel WHERE Id = '${soqlEscape(sellingModelId)}' LIMIT 1`,
        );
        const cadenceRaw = (row.records[0]?.[cadenceField.name] as string | undefined) ?? "";
        const matched = matchCadenceToActiveOption(cadenceRaw, qliPicklist);
        if (matched) {
          attempts.push({ step: "cadence-mapping", outcome: `Cadence "${cadenceRaw}" -> matched cadence token "${matched.matchedCadence}" -> picklist value "${matched.value}".` });
          return logAndReturn({ value: matched.value, source: "cadence-mapping", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
        }
        attempts.push({ step: "cadence-mapping", outcome: `ProductSellingModel cadence value "${cadenceRaw}" did not map to any active BillingFrequency option.` });
      } else {
        attempts.push({ step: "cadence-mapping", outcome: "No pricing-term field on ProductSellingModel." });
      }
    } catch (err) {
      attempts.push({ step: "cadence-mapping", outcome: `Query failed: ${err instanceof Error ? err.message : "unknown error"}.` });
    }
  } else {
    attempts.push({ step: "cadence-mapping", outcome: "Skipped — no Selling Model resolved for this product." });
  }

  // 4. Directly on the Product record — a BLUNT, per-product (not
  // per-selling-model) default; only trusted once nothing selling-model-
  // specific above resolved, since a product can have multiple selling
  // models with different cadences and this field can't distinguish them.
  try {
    const productDescribe = await describeObjectCached(client, "Product2");
    const productField = resolveField(productDescribe, "BillingFrequency", BILLING_FREQUENCY_LABEL_PATTERN);
    if (productField) {
      const row = await client.query<Record<string, unknown>>(
        `SELECT ${productField.name} FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`,
      );
      const raw = row.records[0]?.[productField.name] as string | undefined;
      if (raw) {
        const mapped = mapToActiveBillingFrequency(raw, productField, qliPicklist);
        if (mapped) {
          attempts.push({ step: "product", outcome: mapped === raw ? `Found on Product.${productField.name} = "${raw}".` : `Found on Product.${productField.name} = "${raw}" — mapped to active ${lineItemObject}.BillingFrequency value "${mapped}".` });
          return logAndReturn({ value: mapped, source: "product", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
        }
        attempts.push({ step: "product", outcome: `Product.${productField.name} = "${raw}", but this could not be confidently mapped to any of ${lineItemObject}.BillingFrequency's currently active values (${qliPicklist.activeOptions.map(o => o.value).join(", ")}) — not used.` });
      } else {
        attempts.push({ step: "product", outcome: `Product.${productField.name} exists but is blank for this product.` });
      }
    } else {
      attempts.push({ step: "product", outcome: "No BillingFrequency-shaped field found on Product2." });
    }
  } catch (err) {
    attempts.push({ step: "product", outcome: `Query failed: ${err instanceof Error ? err.message : "unknown error"}.` });
  }

  // 5. An existing line item elsewhere in the org (on the SAME object this
  // resolution is for) already using this product — also blunt (not
  // necessarily the same selling model as this line), so ranked alongside
  // Product2 rather than above the selling-model-specific sources. Read
  // from the SAME field being written to, so it's a real active value
  // unless it's since been deactivated — re-checked, never assumed.
  try {
    const productFieldRef = findReferenceFieldByTargetObject(lineItemDescribe, "Product2", { requireCreateable: true })
      ?? resolveField(lineItemDescribe, "Product2Id", /^product$/i, { requireCreateable: true });
    const productField = productFieldRef?.name;
    if (productField) {
      const row = await client.query<Record<string, unknown>>(
        `SELECT ${qliFrequencyField} FROM ${lineItemObject} WHERE ${productField} = '${soqlEscape(productId)}' AND ${qliFrequencyField} != null LIMIT 1`,
      );
      const raw = row.records[0]?.[qliFrequencyField] as string | undefined;
      if (raw) {
        const stillActive = qliPicklist.activeOptions.some(o => o.value === raw);
        if (stillActive) {
          attempts.push({ step: "existing-qli", outcome: `Found on an existing ${lineItemObject} = "${raw}".` });
          return logAndReturn({ value: raw, source: "existing-qli", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
        }
        attempts.push({ step: "existing-qli", outcome: `Found on an existing ${lineItemObject} = "${raw}", but that value is no longer among ${lineItemObject}.BillingFrequency's active options (${qliPicklist.activeOptions.map(o => o.value).join(", ")}) — not used.` });
      } else {
        attempts.push({ step: "existing-qli", outcome: `No existing ${lineItemObject} on this product has a BillingFrequency set.` });
      }
    } else {
      attempts.push({ step: "existing-qli", outcome: `No Product reference field resolved on ${lineItemObject} — cannot search existing lines.` });
    }
  } catch (err) {
    attempts.push({ step: "existing-qli", outcome: `Query failed: ${err instanceof Error ? err.message : "unknown error"}.` });
  }

  // 6. Org-level default or sole active picklist value.
  try {
    const picklist = qliPicklist;
    if (picklist) {
      const value = picklist.defaultValue ?? (picklist.activeOptions.length === 1 ? picklist.activeOptions[0].value : null);
      if (value) {
        const via = picklist.defaultValue ? "org-marked default" : "sole active picklist value";
        attempts.push({ step: "org-default", outcome: `Resolved via ${via}: "${value}".` });
        return logAndReturn({ value, source: "org-default", fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
      }
      attempts.push({ step: "org-default", outcome: `No org-marked default and ${picklist.activeOptions.length} active option(s) exist (need exactly 1 for an unambiguous auto-pick).` });
    } else {
      attempts.push({ step: "org-default", outcome: `No BillingFrequency picklist field resolved on ${lineItemObject}.` });
    }
  } catch (err) {
    attempts.push({ step: "org-default", outcome: `Query failed: ${err instanceof Error ? err.message : "unknown error"}.` });
  }

  return logAndReturn({ value: null, source: null, fieldApiName: qliFrequencyField, attempts, activeOptions: qliPicklist.activeOptions });
}

/**
 * Resolve Subscription Term for a Term-Defined selling model — same
 * philosophy as billing frequency (§AUTO CONFIGURATION): Product record ->
 * ProductSellingModel's own term field -> an existing QuoteLineItem on this
 * product. Unlike billing frequency, this is not currently enforced as a
 * hard blocker (no confirmed Salesforce validation rule for it has been
 * observed in this org), so a null result degrades to "omit from payload"
 * rather than failing the create — but it IS proactively resolved and
 * surfaced in Preview so a real requirement is never silently missed.
 */
export async function resolveSubscriptionTerm(
  client: SalesforceClient,
  productId: string,
  sellingModelId: string | null,
  lineItemObject: LineItemObjectName = "QuoteLineItem",
): Promise<SubscriptionTermResolution> {
  const lineItemDescribe = await describeObjectCached(client, lineItemObject);
  const qliTermField = resolveField(lineItemDescribe, "SubscriptionTerm", /^subscription term$/i)?.name ?? null;
  if (!qliTermField) return { value: null, source: null };

  try {
    const productDescribe = await describeObjectCached(client, "Product2");
    const productField = resolveField(productDescribe, "SubscriptionTerm", /^subscription term$/i);
    if (productField) {
      const row = await client.query<Record<string, unknown>>(
        `SELECT ${productField.name} FROM Product2 WHERE Id = '${soqlEscape(productId)}' LIMIT 1`,
      );
      const value = row.records[0]?.[productField.name] as number | undefined;
      if (value != null) return { value, source: "product" };
    }
  } catch {
    /* inconclusive — try the next source */
  }

  if (sellingModelId) {
    try {
      const psmDescribe = await describeObjectCached(client, "ProductSellingModel");
      const psmField =
        resolveField(psmDescribe, "SubscriptionTerm", /^subscription term$/i) ??
        resolveField(psmDescribe, "PricingTerm", /^pricing term$/i);
      if (psmField) {
        const row = await client.query<Record<string, unknown>>(
          `SELECT ${psmField.name} FROM ProductSellingModel WHERE Id = '${soqlEscape(sellingModelId)}' LIMIT 1`,
        );
        const value = row.records[0]?.[psmField.name] as number | undefined;
        if (value != null) return { value, source: "selling-model" };
      }
    } catch {
      /* inconclusive — try the next source */
    }
  }

  try {
    const productFieldRef = findReferenceFieldByTargetObject(lineItemDescribe, "Product2", { requireCreateable: true })
      ?? resolveField(lineItemDescribe, "Product2Id", /^product$/i, { requireCreateable: true });
    const productField = productFieldRef?.name;
    if (productField) {
      const row = await client.query<Record<string, unknown>>(
        `SELECT ${qliTermField} FROM ${lineItemObject} WHERE ${productField} = '${soqlEscape(productId)}' AND ${qliTermField} != null LIMIT 1`,
      );
      const value = row.records[0]?.[qliTermField] as number | undefined;
      if (value != null) return { value, source: "existing-qli" };
    }
  } catch {
    /* inconclusive */
  }

  return { value: null, source: null };
}
