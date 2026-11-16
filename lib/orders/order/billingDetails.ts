import type { OrderAddress, OrderAddressFieldRefs, OrderAddressKey, OrderFieldSchema, OrderFormData } from "@/lib/orders/types";
import { normalizeGeography, type TaxGeoFacts } from "@/lib/tax/server/geography";

/**
 * Order Details → Bill To Contact + Billing / Shipping Address. Pure and shared by the Create Order
 * form (field-level messages before submit) and the server (the same rules re-checked before any
 * Salesforce write), so the two can never disagree about what is valid.
 */

export const ADDRESS_KEYS: OrderAddressKey[] = ["street", "city", "state", "postalCode", "country"];
export const ADDRESS_LABELS: Record<OrderAddressKey, string> = { street: "Street", city: "City", state: "State/Province", postalCode: "ZIP/Postal Code", country: "Country" };
/** State/Province stays optional — many countries have none. */
export const REQUIRED_ADDRESS_KEYS: OrderAddressKey[] = ["street", "city", "postalCode", "country"];

export type AddressKind = "billingAddress" | "shippingAddress";
export const ADDRESS_KIND_LABEL: Record<AddressKind, string> = { billingAddress: "Billing Address", shippingAddress: "Shipping Address" };

/** Field-level errors keyed "billToContact" or "<billingAddress|shippingAddress>.<key>". */
export type BillingFieldErrors = Partial<Record<string, string>>;

export const emptyAddress = (): OrderAddress => ({ street: "", city: "", state: "", postalCode: "", country: "" });

export function normalizeAddress(a: Partial<OrderAddress> | null | undefined): OrderAddress {
  const out = emptyAddress();
  for (const k of ADDRESS_KEYS) out[k] = typeof a?.[k] === "string" ? a[k]!.trim() : "";
  return out;
}

export const addressHasAny = (a: Partial<OrderAddress> | null | undefined) => ADDRESS_KEYS.some(k => !!a?.[k]?.trim());

export function formatAddress(a: Partial<OrderAddress> | null | undefined): string {
  const n = normalizeAddress(a);
  const cityLine = [n.city, [n.state, n.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [n.street, cityLine, n.country].filter(Boolean).join(", ");
}

const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
export const isSalesforceId = (v: unknown): v is string => typeof v === "string" && SF_ID.test(v);

/** The Bill To Contact / addresses that this org's Order can actually store — nothing is required that can't be saved. */
export function billingCapabilities(schema: Pick<OrderFieldSchema, "billToContactField" | "billingAddressFields" | "shippingAddressFields"> | null) {
  return {
    billToContact: !!schema?.billToContactField,
    billingAddress: !!schema?.billingAddressFields,
    shippingAddress: !!schema?.shippingAddressFields,
  };
}

/**
 * Field-level validation. `required` = the Create Order form (every supported part must be filled);
 * otherwise (bulk import, which never sends these) only what was provided is checked.
 */
export function validateBillingDetails(
  formData: Pick<OrderFormData, "billToContactId" | "billingAddress" | "shippingAddress">,
  schema: Pick<OrderFieldSchema, "billToContactField" | "billingAddressFields" | "shippingAddressFields"> | null,
  opts: { required: boolean },
): BillingFieldErrors {
  const errors: BillingFieldErrors = {};
  const can = billingCapabilities(schema);

  const contactId = formData.billToContactId?.trim() ?? "";
  if (contactId && !isSalesforceId(contactId)) errors.billToContact = "Select a Contact from the list — the Bill To Contact must be an existing Salesforce Contact.";
  else if (!contactId && opts.required && can.billToContact) errors.billToContact = "Bill To Contact is required. Search and select a Contact.";

  for (const kind of ["billingAddress", "shippingAddress"] as AddressKind[]) {
    const fields: OrderAddressFieldRefs | null = kind === "billingAddress" ? schema?.billingAddressFields ?? null : schema?.shippingAddressFields ?? null;
    const value = formData[kind];
    if (!fields) continue;
    const a = normalizeAddress(value);
    if (!opts.required && !addressHasAny(a)) continue;
    for (const k of REQUIRED_ADDRESS_KEYS) {
      if (!a[k]) errors[`${kind}.${k}`] = `${ADDRESS_KIND_LABEL[kind]}: ${ADDRESS_LABELS[k]} is required.`;
    }
    for (const k of ADDRESS_KEYS) {
      const max = fields[k].maxLength;
      if (max && a[k].length > max) errors[`${kind}.${k}`] = `${ADDRESS_KIND_LABEL[kind]}: ${ADDRESS_LABELS[k]} must be ${max} characters or fewer.`;
    }
  }
  return errors;
}

/**
 * Order field values for the bill-to + addresses — only fields this org's Order has. On create, empty components
 * are omitted; on update (`forUpdate`) an entered address writes all five components, so a cleared one becomes null.
 */
export function billingDetailsPayload(
  schema: Pick<OrderFieldSchema, "billToContactField" | "billingAddressFields" | "shippingAddressFields">,
  formData: Pick<OrderFormData, "billToContactId" | "billingAddress" | "shippingAddress">,
  opts: { forUpdate?: boolean } = {},
): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  if (schema.billToContactField && isSalesforceId(formData.billToContactId)) payload[schema.billToContactField.apiName] = formData.billToContactId;
  for (const [fields, value] of [[schema.billingAddressFields, formData.billingAddress], [schema.shippingAddressFields, formData.shippingAddress]] as const) {
    if (!fields || !addressHasAny(value)) continue;
    const a = normalizeAddress(value);
    for (const k of ADDRESS_KEYS) {
      if (a[k]) payload[fields[k].apiName] = a[k];
      else if (opts.forUpdate) payload[fields[k].apiName] = null;
    }
  }
  return payload;
}

/**
 * The addresses with Country/State as the org's ISO codes ("canada"/"ontario" → CA/ON) — Salesforce's tax decision table
 * matches Order.BillingCountry / BillingState exactly. Unresolved values are kept as entered.
 */
export function withGeographyCodes<T extends Pick<OrderFormData, "billingAddress" | "shippingAddress">>(formData: T, geo: TaxGeoFacts | null): T {
  const codes = (a: OrderAddress | undefined) => {
    if (!a) return a;
    const g = normalizeGeography(a, geo);
    return { ...a, country: g.country ?? "", state: g.state ?? "" };
  };
  return { ...formData, billingAddress: codes(formData.billingAddress), shippingAddress: codes(formData.shippingAddress) };
}

/** True when the two forms differ only in their billing details (contact / addresses) — the Order header can then be updated in place. */
const BILLING_KEYS = new Set<string>(["billToContactId", "billToContactName", "billingAddress", "shippingAddress"]);
export function onlyBillingDetailsChanged(a: OrderFormData, b: OrderFormData): boolean {
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)].filter(k => !BILLING_KEYS.has(k)));
  return [...keys].every(k => (ra[k] ?? "") === (rb[k] ?? ""));
}
