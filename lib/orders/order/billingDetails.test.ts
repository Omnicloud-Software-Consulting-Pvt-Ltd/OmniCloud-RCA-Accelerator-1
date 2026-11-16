import { test } from "node:test";
import assert from "node:assert/strict";
import { billingDetailsPayload, formatAddress, onlyBillingDetailsChanged, validateBillingDetails } from "@/lib/orders/order/billingDetails";
import { buildOrderPayload } from "@/lib/orders/order/payload";
import type { OrderAddressFieldRefs, OrderFieldSchema, OrderFormData } from "@/lib/orders/types";

const addr = (prefix: string, lengths: Partial<Record<keyof OrderAddressFieldRefs, number>> = {}): OrderAddressFieldRefs => ({
  street: { apiName: `${prefix}Street`, label: "Street", maxLength: lengths.street ?? 255 },
  city: { apiName: `${prefix}City`, label: "City", maxLength: lengths.city ?? 40 },
  state: { apiName: `${prefix}State`, label: "State", maxLength: 80 },
  postalCode: { apiName: `${prefix}PostalCode`, label: "Zip", maxLength: 20 },
  country: { apiName: `${prefix}Country`, label: "Country", maxLength: 80 },
});

// p10's Order: BillToContactId (Contact lookup) + createable Billing*/Shipping* components (lengths from its describe).
const SCHEMA: OrderFieldSchema = {
  accountField: { apiName: "AccountId", label: "Account" }, pricebookField: { apiName: "Pricebook2Id", label: "Price Book" },
  contractField: null, effectiveDateField: { apiName: "EffectiveDate", label: "Order Start Date" }, statusField: null, typeField: null,
  poNumberField: null, poDateField: null, descriptionField: null, sourceQuoteField: null, contractRequiredForContractedType: false,
  billToContactField: { apiName: "BillToContactId", label: "Bill To Contact" },
  billingAddressFields: addr("Billing"), shippingAddressFields: addr("Shipping"),
};

const CONTACT = "003g800000AbCdEFGH";
const BILL = { street: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001", country: "India" };
const SHIP = { street: "7 Park St", city: "Kolkata", state: "", postalCode: "700016", country: "India" };
const FORM: OrderFormData = {
  accountName: "Acme", pricebookName: "Standard", effectiveDate: "2026-10-30", status: "", contractName: "", type: "",
  poNumber: "", poDate: "", description: "", sourceQuoteName: "",
  billToContactId: CONTACT, billToContactName: "Asha Rao", billingAddress: BILL, shippingAddress: SHIP,
};

test("Order create payload carries the selected Contact Id and both addresses on the real Order fields", () => {
  const payload = buildOrderPayload(SCHEMA, FORM, { accountId: "001g8000018AU1JAAW", pricebookId: "01sg8000000AbCdAAA", contractId: null, sourceQuoteId: null });
  assert.deepEqual(payload, {
    AccountId: "001g8000018AU1JAAW", Pricebook2Id: "01sg8000000AbCdAAA", EffectiveDate: "2026-10-30",
    BillToContactId: CONTACT,
    BillingStreet: "12 MG Road", BillingCity: "Bengaluru", BillingState: "Karnataka", BillingPostalCode: "560001", BillingCountry: "India",
    ShippingStreet: "7 Park St", ShippingCity: "Kolkata", ShippingPostalCode: "700016", ShippingCountry: "India",
  });
});

test("Billing details — nothing is written that this org's Order can't store, and import orders without them are unchanged", () => {
  const bare = { ...SCHEMA, billToContactField: null, billingAddressFields: null, shippingAddressFields: null };
  assert.deepEqual(billingDetailsPayload(bare, FORM), {});
  const importForm = { ...FORM, billToContactId: undefined, billToContactName: undefined, billingAddress: undefined, shippingAddress: undefined };
  assert.deepEqual(billingDetailsPayload(SCHEMA, importForm), {});
  assert.deepEqual(validateBillingDetails(importForm, SCHEMA, { required: false }), {}, "bulk import (not required) stays valid");
});

test("Billing details — update writes every component so a cleared one becomes null", () => {
  const p = billingDetailsPayload(SCHEMA, { ...FORM, shippingAddress: { ...SHIP, state: "" } }, { forUpdate: true });
  assert.equal(p.ShippingState, null);
  assert.equal(p.BillingState, "Karnataka");
});

test("Validation — required contact and address parts get field-level messages", () => {
  const errors = validateBillingDetails({ billToContactId: "", billingAddress: { ...BILL, city: "" }, shippingAddress: undefined }, SCHEMA, { required: true });
  assert.match(errors.billToContact!, /Bill To Contact is required/);
  assert.match(errors["billingAddress.city"]!, /Billing Address: City is required/);
  for (const k of ["street", "city", "postalCode", "country"]) assert.ok(errors[`shippingAddress.${k}`], k);
  assert.equal(errors["shippingAddress.state"], undefined, "State/Province is optional");
  assert.deepEqual(validateBillingDetails(FORM, SCHEMA, { required: true }), {});
});

test("Validation — typed text is never accepted as a Contact Id, and Salesforce field lengths are enforced", () => {
  assert.match(validateBillingDetails({ ...FORM, billToContactId: "Asha Rao" }, SCHEMA, { required: true }).billToContact!, /Select a Contact/);
  const long = validateBillingDetails({ ...FORM, billingAddress: { ...BILL, city: "x".repeat(41) } }, { ...SCHEMA, billingAddressFields: addr("Billing", { city: 40 }) }, { required: true });
  assert.match(long["billingAddress.city"]!, /40 characters or fewer/);
  assert.deepEqual(validateBillingDetails({ ...FORM, billToContactId: "" }, { ...SCHEMA, billToContactField: null }, { required: true }), {}, "not required when the org can't store it");
});

test("Back from Preview — only billing details changed means update in place; any other header change does not", () => {
  assert.equal(onlyBillingDetailsChanged(FORM, { ...FORM, shippingAddress: { ...SHIP, city: "Howrah" }, billToContactId: "003g800000ZZZZZZZZ" }), true);
  assert.equal(onlyBillingDetailsChanged(FORM, { ...FORM, effectiveDate: "2026-11-01" }), false);
  assert.equal(formatAddress(BILL), "12 MG Road, Bengaluru, Karnataka 560001, India");
  assert.equal(formatAddress(undefined), "");
});
