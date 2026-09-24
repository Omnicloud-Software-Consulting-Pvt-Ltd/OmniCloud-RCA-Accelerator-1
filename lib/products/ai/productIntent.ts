import type { ProductPayload } from "@/lib/products/types";
import { parseProductPrice } from "@/lib/products/price";

/**
 * Centralized Prompt → Product Field mapping layer.
 *
 * Both AI extraction routes (generate-payload for Single Product,
 * generate-payload-multi for Multiple Product) parse a prompt into a
 * `RawFieldInput` — `null`/absent means "the prompt did not mention this
 * field", never "empty string as a value" — and hand it to
 * `buildProductIntent()` here. This is the ONE place that decides, per
 * field, whether the final value is:
 *   - "explicit"    — the user said so in the prompt (or typed it manually)
 *   - "default"     — the pipeline needs *something* here and Salesforce
 *                      (or this app's own established convention, e.g.
 *                      Standard Price Book) already defines what that is
 *   - "unspecified" — the user never said, and nothing was invented
 *
 * This function must be the ONLY place that decides a field's fallback
 * value — no other file should special-case "if family is missing, use
 * X". Adding a new field-specific default belongs here, not in the AI
 * route or the review UI.
 */

export type FieldProvenance = "explicit" | "default" | "unspecified";

export interface FieldMapping<T> {
  value: T;
  provenance: FieldProvenance;
}

/**
 * What an AI extraction step (or a manual-entry form) produced for one
 * product, BEFORE defaults are applied. `null`/undefined/"" all mean
 * "not mentioned" — extraction code must not substitute a guessed value
 * here; that's this module's job, and only for the handful of fields
 * where a default is legitimate.
 */
export interface RawFieldInput {
  productName?: string | null;
  productCode?: string | null;
  family?: string | null;
  category?: string | null;
  catalog?: string | null;
  description?: string | null;
  /** null = the prompt did not say active/inactive at all. */
  isActive?: boolean | null;
  sellingModel?: string | null;
  productOwner?: string | null;
  basePrice?: string | null;
  priceBook?: string | null;
  productType?: string | null;
  currencyIsoCode?: string | null;
  /** Unit of Measure as stated ("unit of measure Hour", "priced per GB"). */
  unitOfMeasure?: string | null;
  /** Product Classification name/code as stated ("classification Computer"). */
  classification?: string | null;
  /**
   * true = "including tax"/"tax included"; false = "before tax"/"tax
   * excluded"; null = the prompt said nothing about tax. There is no
   * Product2/PricebookEntry field for this in the standard Salesforce
   * Revenue Cloud schema, so it is never written to Salesforce — it is
   * carried through the intent/review layer only, so the meaning the
   * user gave is never silently dropped, and shown to the user with an
   * explicit note that it isn't persisted server-side.
   */
  taxIncluded?: boolean | null;
}

export interface ProductIntentMap {
  productName: FieldMapping<string>;
  productCode: FieldMapping<string>;
  family: FieldMapping<string>;
  category: FieldMapping<string>;
  catalog: FieldMapping<string>;
  description: FieldMapping<string>;
  isActive: FieldMapping<boolean>;
  sellingModel: FieldMapping<string>;
  productOwner: FieldMapping<string>;
  priceBook: FieldMapping<string>;
  basePrice: FieldMapping<string>;
  productType: FieldMapping<string>;
  currencyIsoCode: FieldMapping<string>;
  unitOfMeasure: FieldMapping<string>;
  classification: FieldMapping<string>;
  taxIncluded: FieldMapping<boolean | null>;
}

export interface ProductIntentResult {
  intent: ProductIntentMap;
  /** The exact body /api/sf/products/save (or the [id] PATCH route) accepts — folds defaults in, omits unspecified optional fields. */
  payload: ProductPayload;
}

function explicitString(v: string | null | undefined): FieldMapping<string> | null {
  const s = (v ?? "").trim();
  return s ? { value: s, provenance: "explicit" } : null;
}

export function buildProductIntent(raw: RawFieldInput): ProductIntentResult {
  const productName = explicitString(raw.productName) ?? { value: "", provenance: "unspecified" };
  // Product Code is NOT auto-derived here — deriving it from the name is a
  // client-side UI convenience (RCProductWorkspace's existing autoCode()
  // effect) applied uniformly whether the name came from AI or manual
  // typing, not something this mapping layer should fabricate on its own.
  const productCode = explicitString(raw.productCode) ?? { value: "", provenance: "unspecified" };
  const family = explicitString(raw.family) ?? { value: "", provenance: "unspecified" };
  const category = explicitString(raw.category) ?? { value: "", provenance: "unspecified" };
  const catalog = explicitString(raw.catalog) ?? { value: "", provenance: "unspecified" };
  const description = explicitString(raw.description) ?? { value: "", provenance: "unspecified" };
  // IsActive: Salesforce's own platform default for Product2.IsActive is
  // true when omitted — preserving that is not "inventing a value", it's
  // what Salesforce already does.
  const isActive: FieldMapping<boolean> =
    raw.isActive === null || raw.isActive === undefined
      ? { value: true, provenance: "default" }
      : { value: raw.isActive, provenance: "explicit" };
  const sellingModel = explicitString(raw.sellingModel) ?? { value: "", provenance: "unspecified" };
  const productOwner = explicitString(raw.productOwner) ?? { value: "", provenance: "unspecified" };
  // Normalized ("₹50,000" / "50,000" → "50000") so the review UI shows exactly the number
  // /save will write. An unparseable value is kept verbatim (still "explicit") so the user
  // sees it and /save rejects it loudly — never silently turned into "no price".
  const rawPrice = explicitString(raw.basePrice);
  const parsedPrice = rawPrice ? parseProductPrice(rawPrice.value) : null;
  const basePrice: FieldMapping<string> = rawPrice
    ? { value: parsedPrice?.ok ? parsedPrice.normalized : rawPrice.value, provenance: "explicit" }
    : { value: "", provenance: "unspecified" };
  // Price Book: only defaulted when a price was actually given — without a
  // price book name, /api/sf/products/save can't resolve a Pricebook2 to
  // attach the price to at all, so "Standard Price Book" (this app's own
  // pre-existing convention, used everywhere else a price book is needed)
  // is a required fallback for the price to take effect, not a fabricated
  // field value.
  const priceBook =
    explicitString(raw.priceBook) ??
    (basePrice.provenance === "explicit" ? { value: "Standard Price Book", provenance: "default" as const } : { value: "", provenance: "unspecified" as const });
  const productType = explicitString(raw.productType) ?? { value: "", provenance: "unspecified" };
  const currencyIsoCode = explicitString(raw.currencyIsoCode?.toUpperCase()) ?? { value: "", provenance: "unspecified" };
  const unitOfMeasure = explicitString(raw.unitOfMeasure) ?? { value: "", provenance: "unspecified" };
  const classification = explicitString(raw.classification) ?? { value: "", provenance: "unspecified" };
  const taxIncluded: FieldMapping<boolean | null> =
    raw.taxIncluded === null || raw.taxIncluded === undefined
      ? { value: null, provenance: "unspecified" }
      : { value: raw.taxIncluded, provenance: "explicit" };

  const intent: ProductIntentMap = {
    productName, productCode, family, category, catalog, description, isActive,
    sellingModel, productOwner, priceBook, basePrice, productType, currencyIsoCode,
    unitOfMeasure, classification, taxIncluded,
  };

  const payload: ProductPayload = {
    productName: productName.value,
    productCode: productCode.value,
    family: family.value,
    category: category.value || undefined,
    catalog: catalog.value || undefined,
    description: description.value || undefined,
    isActive: isActive.value,
    sellingModel: sellingModel.value || undefined,
    productOwner: productOwner.value || undefined,
    priceBook: priceBook.value || undefined,
    basePrice: basePrice.value || undefined,
    // Product2.Type is a restricted picklist whose only reliably-real
    // cross-org value is "Bundle" (see /api/sf/products/save's own gating,
    // unchanged here) — an explicit-but-non-"bundle" productType is still
    // shown verbatim in the review mapping (the user did say it), it just
    // isn't forwarded to a picklist that would likely reject it.
    productType: productType.value.toLowerCase() === "bundle" ? "bundle" : undefined,
    currencyIsoCode: currencyIsoCode.value || undefined,
    unitOfMeasure: unitOfMeasure.value || undefined,
    classification: classification.value || undefined,
  };

  return { intent, payload };
}
