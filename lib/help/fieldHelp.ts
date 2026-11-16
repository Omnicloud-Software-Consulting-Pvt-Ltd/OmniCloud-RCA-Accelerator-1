/**
 * Field-level help for <FieldHelp> (components/help/FieldHelp.tsx) — the info icon next to form labels app-wide.
 * One glossary, looked up by Salesforce API name or by visible label, so every form that renders labels through the
 * shared label components (quotes/shared Field, product FieldWrap, billing/tax FieldRow, the generic
 * /data create form) gets consistent help without a per-form tooltip implementation.
 *
 * Lookup order: "<SObject>.<Field>" override → API name → label. Salesforce's own inline help text (Describe
 * `inlineHelpText`) always wins on describe-driven forms; this glossary fills the gaps.
 */

export interface FieldHelpEntry {
  /** What the field is, why it matters, and what to enter — one or two short sentences. */
  text: string;
  /** Format / supported values. */
  format?: string;
  example?: string;
  /** Downstream effect in Salesforce. */
  impact?: string;
}

/** "Tax Code *", "TaxCode", "Base Price ($)", "Source Quote (optional)" → "taxcode", "baseprice", "sourcequote". */
export function normalizeFieldKey(s: string): string {
  return s.replace(/\([^)]*\)/g, "").replace(/[^A-Za-z0-9.]/g, "").toLowerCase();
}

type E = FieldHelpEntry;
const e = (text: string, opts: Omit<E, "text"> = {}): E => ({ text, ...opts });

// Reused entries
const NAME = e("The record's display name, shown in Salesforce lists, lookups and on related records. Make it unique and descriptive.", { example: "Enterprise Annual Billing" });
const DESCRIPTION = e("Free-text notes for admins and users. Not used in any calculation.");
const STATUS = e("Lifecycle state of the record. Most Revenue Cloud configuration records must be Active before Salesforce uses them; new records usually start as Draft.", { format: "Picklist from your org (e.g. Draft, Active, Inactive)" });
const CURRENCY = e("ISO currency code. Prices and amounts on the record are in this currency and must match the price book entry's currency.", { format: "3-letter ISO code", example: "USD" });
const START = e("The first day this record applies.", { format: "Date (YYYY-MM-DD)" });
const END = e("The last day this record applies. Leave it blank for open-ended records where Salesforce allows that.", { format: "Date (YYYY-MM-DD), on or after the start date" });
const ACCOUNT = e("The customer account. It determines bill-to and ship-to defaults and, for tax, the address used to find rates.", { example: "Acme Corporation" });
const PRODUCT = e("The Product2 record this applies to. Search by name or product code; the product must already exist in Salesforce.", { example: "Laptop Pro 15 (LAP-001)" });
const PRICE_BOOK = e("The price book whose entries price the lines. Every product line needs an active price book entry in this price book for its selling model and currency.", { example: "Standard Price Book" });
const QUANTITY = e("How many units. Pricing procedures, tiers and usage grants all read the quantity.", { format: "Positive number", example: "10" });
const LEGAL_ENTITY = e("The selling legal entity. Billing uses it on invoices; tax uses it to choose treatments and rates.", { example: "Acme Inc. (US)" });
const STREET = e("Street line of the address.", { example: "1 Market St" });
const CITY = e("City of the address.", { example: "San Francisco" });
const STATE = e("State or province. Used with Country to find state-level tax rates. The ISO subdivision code or full name is accepted where the form says so.", { example: "CA or California" });
const POSTAL = e("Postal / ZIP code.", { example: "94105" });
const COUNTRY = e("Country. Tax rates are matched by country (ISO-2 code) — the address country decides which rates apply.", { example: "US or United States" });
const TAX_CODE = e("The code Salesforce matches between a Tax Treatment (or Treatment Item) and Tax Rates. Rates only apply to lines whose treatment carries the same code.", { example: "GST18", impact: "No rate with this code for the address → no Invoice Line Tax." });
const SELLING_MODEL = e("How the product is sold: One Time, Evergreen (renews until cancelled) or Term Defined (fixed term).", { impact: "Each selling model needs its own price book entry; term-based models drive subscription billing." });

const ENTRIES: Record<string, E> = {
  // ── Generic ──
  name: NAME, description: DESCRIPTION, notes: DESCRIPTION, status: STATUS,
  currency: CURRENCY, currencyisocode: CURRENCY,
  startdate: START, effectivedate: START, effectivefrom: START, effectivestartdate: START,
  enddate: END, effectiveto: END,
  account: ACCOUNT, accountid: ACCOUNT, accountname: e("The account (company) this record belongs to. Search for an existing account.", { example: "Acme Corporation" }),
  customeraccount: ACCOUNT,
  product: PRODUCT, productid: PRODUCT, salesforceproduct: PRODUCT, productnameorcode: PRODUCT, productnamecodeorid: PRODUCT,
  pricebook: PRICE_BOOK, pricebookid: PRICE_BOOK, pricebook2id: PRICE_BOOK,
  quantity: QUANTITY, testquantity: e("A sample quantity used only to preview which tier applies — nothing is saved.", { example: "25" }),
  legalentity: LEGAL_ENTITY, legalentityid: LEGAL_ENTITY,
  street: STREET, billingstreet: STREET, mailingstreet: STREET,
  city: CITY, billingcity: CITY, mailingcity: CITY,
  state: STATE, billingstate: STATE, mailingstate: STATE, statenoaccount: STATE,
  postalcode: POSTAL, zip: POSTAL, billingzip: POSTAL, mailingzip: POSTAL,
  country: COUNTRY, billingcountry: COUNTRY, mailingcountry: COUNTRY, countrynoaccount: COUNTRY, taxcountry: COUNTRY,
  type: e("The record's type/category. Allowed values come from your org's picklist."),
  phone: e("Main phone number.", { example: "(555) 000-0000" }),
  email: e("Email address.", { example: "billing@acme.com" }),
  website: e("Company website.", { format: "URL", example: "https://acme.com" }),
  owner: e("The Salesforce user who owns the record."),

  // ── Accounts / contacts / opportunities (generic create form) ──
  accountnumber: e("Your own reference number for the account (e.g. from an ERP).", { example: "ACC-0001" }),
  industry: e("The account's industry. Used for reporting and segmentation."),
  annualrevenue: e("Estimated yearly revenue of the account, for reporting.", { format: "Number" }),
  employees: e("Number of employees, for reporting.", { format: "Whole number" }),
  tickersymbol: e("Stock ticker, if public.", { example: "ACME" }),
  ownership: e("Public, Private, Subsidiary or Other."),
  parentaccount: e("The parent company, for account hierarchies."),
  accountowner: e("The user responsible for the account."),
  accountsource: e("Where the account came from (Web, Partner Referral…)."),
  rating: e("Hot / Warm / Cold — sales priority."),
  firstname: e("Contact's first name.", { example: "Jane" }),
  lastname: e("Contact's last name — required by Salesforce.", { example: "Doe" }),
  title: e("Job title.", { example: "VP of Finance" }),
  mobile: e("Mobile number."),
  department: e("Department within the account."),
  reportsto: e("The contact's manager."),
  opportunityname: e("A short name for the deal.", { example: "Acme — 2026 Platform Renewal" }),
  closedate: e("When the deal is expected to close — required by Salesforce.", { format: "Date" }),
  stage: e("Sales stage; drives probability and forecast category."),
  amount: e("Expected deal value.", { format: "Currency" }),
  probability: e("Likelihood of closing, 0–100%.", { format: "Number 0–100" }),
  leadsource: e("How the opportunity was sourced."),
  campaignsource: e("The marketing campaign that influenced the deal."),
  forecastcategory: e("Pipeline / Best Case / Commit / Closed — used by forecasting."),
  nextstep: e("The next action to move the deal forward."),
  ordername: e("A name for the order.", { example: "Acme — Q1 Hardware" }),
  contract: e("The contract this order belongs to (optional)."),
  orderdate: e("The order's effective date. Billing schedules and subscription terms start from here.", { format: "Date" }),
  discount: e("A header-level discount percentage.", { format: "Number 0–100" }),
  billingfrequency: e("How often recurring charges are billed (Monthly, Quarterly, Annual…). In Revenue Cloud this comes from the product's selling model and billing treatment."),

  // ── Products ──
  productname: e("The product's name as sales users will see it in the catalog, on quotes, orders and invoices.", { example: "Laptop Pro 15" }),
  productcode: e("A unique short code (SKU) for the product. Tax rates can be matched by product code, and integrations use it to identify the product.", { format: "Letters, numbers, dashes", example: "LAP-001", impact: "Auto-generated from the name if left blank." }),
  productstatus: STATUS,
  producttype: e("Leave blank for a standard product. Choose Bundle to make this product a bundle that contains component products.", { impact: "Only Type = Bundle changes how Salesforce treats the product." }),
  unitofmeasure: e("The unit the product is sold in (Each, Hours, GB…).", { example: "Each" }),
  isactive: e("Active products can be added to quotes and orders. Inactive products are kept as drafts.", { format: "Yes / No" }),
  productclassification: e("A classification template. The product inherits that classification's attributes.", { example: "Laptops" }),
  productfamily: e("A grouping used for reporting and filtering (Product2.Family). This app requires it.", { example: "Computers" }),
  family: e("A grouping used for reporting and filtering (Product2.Family).", { example: "Computers" }),
  productcategory: e("The catalog category the product is placed in, so sales users can browse to it. Requires a catalog.", { example: "Laptops" }),
  productcatalog: e("The catalog that contains the category. It's found or created by name.", { example: "Hardware Catalog" }),
  catalog: e("The product catalog this belongs to.", { example: "Hardware Catalog" }),
  category: e("The catalog category.", { example: "Laptops" }),
  sellingmodel: SELLING_MODEL, productsellingmodel: SELLING_MODEL, productsellingmodelid: SELLING_MODEL,
  baseprice: e("The list price for one unit, saved as the price book entry's Unit Price.", { format: "Number", example: "1200" }),
  unitprice: e("Price per unit before discounts.", { format: "Number", example: "40" }),
  unitpricestandardpricebook: e("The standard price book list price for one unit.", { format: "Number" }),
  pricebookentry: e("The product's price in the chosen price book, for one selling model and currency."),

  // ── Bundles (generic form) ──
  bundlename: e("The bundle product's name.", { example: "Remote Worker Kit" }),
  bundletype: e("Static (fixed contents), Dynamic or Configurable (customer chooses components)."),
  minquantity: e("The minimum quantity allowed for the component in the bundle.", { format: "Whole number" }),
  maxquantity: e("The maximum quantity allowed for the component.", { format: "Whole number" }),
  listprice: e("Price before discounts.", { format: "Currency" }),
  pricingmethod: e("How the price is derived (List, Cost Plus, Custom)."),
  discounttype: e("Flat amount, Percentage or None."),

  // ── Quotes / orders / contracts ──
  billtocontact: e("The contact who receives invoices. Revenue Cloud Billing needs it on the order to create billing schedules.", { example: "Jane Doe" }),
  billtocontactid: e("The contact who receives invoices. Revenue Cloud Billing needs it on the order to create billing schedules."),
  sourcequote: e("Optional: the quote this order was converted from. Lines and pricing are copied from it."),
  contact: e("The person at the account this record is for."),
  contractlabel: e("A label for the generated contract document."),

  // ── Quotes, subscriptions & billing periods ──
  opportunity: e("The opportunity this record belongs to (optional)."),
  quote: e("Use an existing quote, or create a new one."),
  subscriptionterm: e("Length of the subscription term on the selling model.", { format: "Number of term units" }),
  subscriptiontermmonths: e("Length of the subscription term.", { format: "Months" }),
  periodboundary: e("How billing periods align: to the order start date, or to a fixed day of the month / start month (annual billing).", { impact: "Annual lines need Period Boundary + Start Month for correct schedules." }),
  periodboundaryday: e("The day of the month billing periods align to.", { format: "1–31" }),
  periodboundarystartmonth: e("The month annual billing periods start in.", { format: "1–12" }),

  // ── Pricing rules ──
  procedurename: e("The name of the pricing procedure (expression set) to create.", { example: "Volume Pricing — Accessories" }),
  priceadjustmentscheduleid: e("The Id of an existing Price Adjustment Schedule to verify. You can find it on the schedule record in Salesforce."),

  // ── Billing (describe-driven, API names) ──
  defaultbillingtreatmentid: e("The Billing Treatment this policy uses. It must be Active before the policy can be activated.", { impact: "Decides how every product with this policy is billed." }),
  billingtreatmentselection: e("How the policy picks a treatment: Default (always the default treatment) or by rule."),
  billingtreatmentid: e("The parent Billing Treatment."),
  billingpolicyid: e("The Billing Policy assigned to the product. Without one, no billing schedule is created when the product is ordered.", { impact: "Required for Revenue Cloud Billing." }),
  billingtype: e("When the charge is billed: Advance (at the start of each period) or Arrears (at the end)."),
  billingmethod: e("How the amount is split across the item(s)."),
  percentage: e("The share of the charge billed by this item. Items in a treatment should add up to 100% (or use a remainder item).", { format: "0–100" }),
  flatamount: e("A fixed amount billed by this item instead of a percentage.", { format: "Currency" }),
  processingorder: e("The order in which treatment items are applied.", { format: "1, 2, 3…" }),
  ismilestonebilling: e("Bill when milestones are accomplished rather than on a schedule. Requires a Billing Milestone Plan."),
  billingmilestoneplanid: e("The milestone plan that releases this treatment's charges."),
  paymenttermid: e("When invoices fall due (e.g. Net 30)."),
  billingaccountid: e("The account's billing profile."),
  primarybilladdrcity: CITY, primarybilladdrcountry: COUNTRY,
  usageresourceid: e("The measurable thing consumed (GB, API calls…)."),
  unitofmeasureid: e("The unit usage is measured in."),
  unitofmeasureclassid: e("The class of convertible units this unit belongs to (e.g. Data Storage)."),
  baseunitofmeasureid: e("The unit all others in the class convert to."),
  defaultunitofmeasureid: e("The unit used when none is specified."),
  conversionfactor: e("How many base units one of this unit equals.", { example: "1024 (GB → MB)" }),
  unitcode: e("Short code for the unit.", { example: "GB" }),
  usageaccumulationmethod: e("How usage is accumulated before rating: Sum or Peak."),
  usageaccumulationperiod: e("The period usage is accumulated over (Daily, Monthly)."),
  ratingperiod: e("How often usage is rated."),
  ratingdelayduration: e("How long to wait for late usage before rating."),
  ratecardid: e("The rate card that prices this usage."),
  ratecardentryid: e("The per-unit rate being adjusted."),
  rate: e("The rate. On a Tax Rate it's the tax percentage; on a Rate Card Entry it's the price per unit.", { format: "Number", example: "18 (means 18%)" }),
  rateunitofmeasureid: e("The unit the rate is expressed per."),
  lowerbound: e("Start of the tier (inclusive).", { format: "Number" }),
  upperbound: e("End of the tier. Leave it blank for the top tier.", { format: "Number" }),
  adjustmenttype: e("How the tier changes the rate: Override, Amount or Percentage."),
  adjustmentvalue: e("The tier's override price, amount or percentage.", { format: "Number" }),
  code: e("A short unique code for the record."),

  // ── Taxes (API names + TaxCreate labels) ──
  taxcode: TAX_CODE, newtaxcode: TAX_CODE,
  taxpolicyid: e("The Tax Policy assigned to the product (Product2.TaxPolicyId). Without one, invoice lines for the product get no tax.", { impact: "Required for tax calculation." }),
  taxpolicyname: e("The Tax Policy, matched by name against your org.", { example: "India GST Policy" }),
  defaulttaxtreatmentid: e("The Tax Treatment this policy applies by default. It must be Active before the policy can be activated."),
  treatmentselection: e("How the policy picks a treatment: Default (always the default), Manual, or by Legal Entity."),
  taxtreatmentid: e("The parent Tax Treatment."),
  taxengineid: e("The engine that calculates tax for this treatment: native Revenue Standard Tax or an external provider."),
  taxenginename: e("A name for the engine.", { example: "Native Tax Engine" }),
  taxenginetype: e("Native (rates from your Tax Rate records via a decision table) or external (a provider such as Avalara)."),
  taxengineprovider: e("For external engines only: the provider adapter. Native engines don't use one."),
  taxengineproviderid: e("For external engines only: the provider adapter."),
  namedcredential: e("For external engines: the Salesforce Named Credential holding the provider's endpoint and credentials."),
  sellercode: e("Your seller/company code at the tax provider (external engines)."),
  istaxable: e("Whether products with this treatment are taxed. Untick for exempt treatments."),
  taxability: e("Whether products with this treatment are taxed (taxable vs exempt)."),
  taxableproduct: e("The product the tax treatment item applies to."),
  geocountryid: e("The country this rate applies in. Fixed once created; changing it creates a replacement rate."),
  geostateid: e("Optional state/province for state-level rates. Leave it blank for country-wide rates."),
  newgeocountry: e("Create the Geo Country if it doesn't exist (ISO-2 code)."),
  newgeostate: e("Create the Geo State if it doesn't exist (ISO subdivision code)."),
  isocode: e("The ISO code. Fixed once created.", { example: "US / IN-KA" }),
  newrate: e("The new tax percentage. Saving creates a replacement rate.", { example: "18" }),
  taxname: e("A display name for the tax.", { example: "GST 18%" }),
  taxnumber: e("The legal entity's tax registration number.", { example: "GSTIN 29ABCDE1234F1Z5" }),
  registrationnumber: e("Company registration number."),
  companyname: e("The legal name printed on invoices."),
  invoice: e("The invoice to check or recalculate tax on."),
  effectivefromtax: START,
};

/** Object-specific overrides ("<sobject>.<field>", normalized). */
const OVERRIDES: Record<string, E> = {
  "taxrate.rate": e("The tax percentage applied to matching invoice lines (line amount × rate ÷ 100).", { format: "Number", example: "18 (means 18%)" }),
  "taxrate.productcode": e("Optional: limit this rate to one product, matched against the product's Product Code.", { example: "LAP-001" }),
  "taxrate.taxcode": e("Matched against the Tax Code on the line's Tax Treatment (or Treatment Item). Fixed once created.", { example: "GST18", impact: "Lines whose treatment has a different code ignore this rate." }),
  "taxrate.effectivefrom": e("The first date this rate applies. Invoices dated before it don't use it.", { format: "Date" }),
  "taxrate.effectiveto": e("The last date this rate applies. Leave it blank for open-ended.", { format: "Date" }),
  "taxrate.legalentityid": e("Optional: only apply for this selling entity."),
  "ratecardentry.rate": e("The price charged per unit of usage.", { format: "Number", example: "0.05" }),
  "taxtreatment.legalentityid": e("The selling entity. Required for invoice tax in this org setup — treatments without it can fail to produce Invoice Line Tax."),
};

export function getFieldHelp({ label, apiName, sobject }: { label?: string; apiName?: string; sobject?: string | null }): FieldHelpEntry | null {
  const candidates: string[] = [];
  if (sobject && apiName) candidates.push(`${sobject}.${apiName}`.toLowerCase().replace(/[^a-z0-9.]/g, ""));
  if (apiName) {
    const k = normalizeFieldKey(apiName);
    candidates.push(k);
    if (k.endsWith("__c")) candidates.push(k.slice(0, -3));
  }
  if (label) {
    const k = normalizeFieldKey(label);
    candidates.push(k, k.replace(/name$/, ""), `${k}id`);
  }
  for (const c of candidates) {
    if (!c) continue;
    if (OVERRIDES[c]) return OVERRIDES[c];
    if (ENTRIES[c]) return ENTRIES[c];
  }
  return null;
}
