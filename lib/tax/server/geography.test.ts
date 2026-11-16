/**
 * Address Country/State → ISO codes for the tax decision table. Fixtures are p10's GeoCountry / GeoState records (2026-11-02:
 * Canada CA / Ontario ON, India IN / Andhra Pradesh AP); order 00000160 was saved with "canada"/"ontario" and its readiness
 * reported Invalid Geography on both addresses.
 *
 * Run: `npx tsx --test lib/tax/server/geography.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { geographyLabel, normalizeCountry, normalizeGeography, normalizeState, type TaxGeoFacts } from "./geography";
import { evaluateTaxGeography, taxAddress } from "./orderItemTax";
import { billingDetailsPayload, withGeographyCodes } from "@/lib/orders/order/billingDetails";
import type { OrderAddressFieldRefs, OrderFieldSchema } from "@/lib/orders/types";

const GEO: TaxGeoFacts = {
  countries: [{ name: "Canada", iso: "CA" }, { name: "India", iso: "IN" }, { name: "United States", iso: "US" }],
  states: [
    { name: "Ontario", iso: "ON", countryIso: "CA" }, { name: "Andhra Pradesh", iso: "AP", countryIso: "IN" },
    { name: "Karnataka", iso: "KA", countryIso: "IN" }, { name: "California", iso: "CA", countryIso: "US" }, { name: "Texas", iso: "TX", countryIso: "US" },
  ],
};

const CASES: [string, string, string, string][] = [
  // country input, state input, expected country, expected state
  ["canada", "ontario", "CA", "ON"],
  ["Canada", "Ontario", "CA", "ON"],
  ["CA", "ON", "CA", "ON"],
  ["  CANADA ", " ON ", "CA", "ON"],
  ["india", "andhra pradesh", "IN", "AP"],
  ["India", "Andhra Pradesh", "IN", "AP"],
  ["IN", "AP", "IN", "AP"],
  ["united states", "texas", "US", "TX"],
  ["United States", "California", "US", "CA"],
];

for (const [country, state, isoC, isoS] of CASES) {
  test(`normalizeGeography: "${country}" / "${state}" → ${isoC} / ${isoS}`, () => {
    const g = normalizeGeography({ country, state }, GEO);
    assert.equal(g.country, isoC);
    assert.equal(g.state, isoS);
    assert.ok(g.countryKnown && g.stateKnown);
  });
}

test("readable labels are kept alongside the codes", () => {
  const g = normalizeGeography({ country: "canada", state: "ontario" }, GEO);
  assert.equal(g.countryName, "Canada");
  assert.equal(g.stateName, "Ontario");
  assert.equal(geographyLabel(g.countryName, g.country), "Canada (CA)");
  assert.equal(geographyLabel(g.stateName, g.state), "Ontario (ON)");
  assert.equal(geographyLabel("AP", "AP"), "AP");
});

test("a state is resolved within its country — \"CA\" is California only in the US, and Ontario is not a US state", () => {
  assert.equal(normalizeState("ca", "US", GEO)?.name, "California");
  assert.equal(normalizeState("ontario", "US", GEO), null);
  assert.equal(normalizeState("Ontario", null, GEO)?.iso, "ON");
});

test("unresolvable values are kept as entered, short codes upper-cased, so readiness still reports them", () => {
  assert.deepEqual(normalizeGeography({ country: "Atlantis", state: "Lost Province" }, GEO), { country: "Atlantis", state: "Lost Province", countryName: "Atlantis", stateName: "Lost Province", countryKnown: false, stateKnown: false });
  assert.equal(normalizeState("qc", "CA", GEO)?.iso, "QC");
  assert.equal(normalizeState("qc", "CA", GEO)?.known, false);
  assert.deepEqual(normalizeGeography({ country: null, state: "" }, GEO), { country: null, state: null, countryName: null, stateName: null, countryKnown: false, stateKnown: false });
});

test("without the org's Geo records, countries still resolve by ISO name and alias", () => {
  assert.equal(normalizeCountry("canada", null)?.iso, "CA");
  assert.equal(normalizeCountry("USA", null)?.iso, "US");
  assert.equal(normalizeCountry("canada", null)?.known, false);
});

test("readiness: \"canada\"/\"ontario\" are Invalid Geography with the exact codes; CA/ON pass", () => {
  for (const label of ["Billing Address", "Shipping Address"]) {
    const bad = evaluateTaxGeography(label, { country: "canada", state: "ontario" }, GEO);
    assert.deepEqual(bad.map(x => x.code), ["TAX_GEOGRAPHY_NOT_CODE", "TAX_GEOGRAPHY_NOT_CODE"]);
    assert.match(bad[0].message, new RegExp(`${label} Country is "canada" — set it to the ISO code "CA"`));
    assert.match(bad[1].message, new RegExp(`${label} State is "ontario" — set it to the code "ON"`));
    assert.deepEqual(evaluateTaxGeography(label, { country: "CA", state: "ON" }, GEO), []);
  }
  // The stored value from the normaliser always passes — for every configured country, not only Canada.
  for (const [country, state] of CASES) assert.deepEqual(evaluateTaxGeography("Billing Address", normalizeGeography({ country, state }, GEO), GEO), [], `${country}/${state}`);
});

test("taxAddress resolves names and lower-case input to the decision table's codes", () => {
  assert.deepEqual(taxAddress("Billing Address", { country: "canada", state: "ontario" }, GEO), { label: "Billing Address", countryIso: "CA", stateIso: "ON", city: null, zipCode: null });
  assert.deepEqual(taxAddress("Billing Address", { country: "India", state: "Andhra Pradesh" }, GEO), { label: "Billing Address", countryIso: "IN", stateIso: "AP", city: null, zipCode: null });
});

const addr = (prefix: string): OrderAddressFieldRefs => ({
  street: { apiName: `${prefix}Street`, label: "Street", maxLength: 255 }, city: { apiName: `${prefix}City`, label: "City", maxLength: 40 },
  state: { apiName: `${prefix}State`, label: "State", maxLength: 80 }, postalCode: { apiName: `${prefix}PostalCode`, label: "Zip", maxLength: 20 },
  country: { apiName: `${prefix}Country`, label: "Country", maxLength: 80 },
});
const SCHEMA: Pick<OrderFieldSchema, "billToContactField" | "billingAddressFields" | "shippingAddressFields"> = { billToContactField: null, billingAddressFields: addr("Billing"), shippingAddressFields: addr("Shipping") };

test("Orders create/edit: the Order payload carries ISO codes on both addresses", () => {
  const form = {
    billToContactId: "", billingAddress: { street: "1 King St W", city: "Toronto", state: "ontario", postalCode: "M5H 1A1", country: "canada" },
    shippingAddress: { street: "1 King St W", city: "Toronto", state: "Ontario", postalCode: "M5H 1A1", country: "Canada" },
  };
  const payload = billingDetailsPayload(SCHEMA, withGeographyCodes(form, GEO), { forUpdate: true });
  assert.equal(payload.BillingCountry, "CA");
  assert.equal(payload.BillingState, "ON");
  assert.equal(payload.ShippingCountry, "CA");
  assert.equal(payload.ShippingState, "ON");
  assert.equal(payload.BillingCity, "Toronto");
  // An address without a state stays without one.
  const noState = billingDetailsPayload(SCHEMA, withGeographyCodes({ ...form, shippingAddress: { ...form.shippingAddress, state: "" } }, GEO), { forUpdate: true });
  assert.equal(noState.ShippingState, null);
});
