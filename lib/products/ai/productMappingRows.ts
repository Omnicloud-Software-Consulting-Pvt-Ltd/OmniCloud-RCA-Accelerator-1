import type { FieldMapping, FieldProvenance, ProductIntentMap } from "./productIntent";
import type { MappingRow } from "@/components/metadata/shared/FieldMappingTable";
import { formatProductPrice } from "@/lib/products/price";

/**
 * Builds the "Field → Value → Source" rows both RCProductWorkspace (Single
 * Product) and MultiProductWorkspace's per-product review card render via
 * the shared FieldMappingTable — one implementation instead of two
 * near-identical ones, per the requirement that field-mapping logic live
 * in a single centralized place rather than per-screen conditionals.
 */
export interface MappableProductFields {
  productName: string;
  productCode: string;
  family: string;
  category: string;
  catalog: string;
  /** Verbatim "product type" text from the prompt — separate from any simple/bundle toggle. */
  productTypeRaw: string;
  sellingModel: string;
  priceBook: string;
  basePrice: string;
  currencyIsoCode: string;
  taxIncluded: boolean | null;
  isActive: boolean;
  productOwner: string;
  description: string;
  unitOfMeasure: string;
  classification: string;
}

/**
 * `intent` reflects what the LAST AI generate call actually extracted for
 * this field; once the user edits a field away from what generate
 * produced (or there was no AI call at all — pure manual entry), the
 * form's current value is treated as "explicit" (the user is looking
 * right at the field they're editing).
 */
export function fieldProvenance<T>(current: T, mapped: FieldMapping<T> | undefined, isEmpty: (v: T) => boolean): FieldProvenance {
  if (mapped && current === mapped.value) return mapped.provenance;
  return isEmpty(current) ? "unspecified" : "explicit";
}

export function buildProductMappingRows(fields: MappableProductFields, intent: ProductIntentMap | null, codeIsManual: boolean): MappingRow[] {
  const emptyStr = (v: string) => !v.trim();
  return [
    { label: "Product Name", value: fields.productName, provenance: fieldProvenance(fields.productName, intent?.productName, emptyStr) },
    {
      label: "Product Code",
      value: fields.productCode,
      provenance: !fields.productCode ? "unspecified" : codeIsManual ? "explicit" : "default",
      note: !codeIsManual && fields.productCode ? "Auto-generated from Product Name." : undefined,
    },
    { label: "Product Family", value: fields.family, provenance: fieldProvenance(fields.family, intent?.family, emptyStr) },
    { label: "Category", value: fields.category, provenance: fieldProvenance(fields.category, intent?.category, emptyStr) },
    { label: "Catalog", value: fields.catalog, provenance: fieldProvenance(fields.catalog, intent?.catalog, emptyStr) },
    {
      label: "Product Type",
      value: fields.productTypeRaw,
      provenance: fieldProvenance(fields.productTypeRaw, intent?.productType, emptyStr),
      note: fields.productTypeRaw && fields.productTypeRaw.toLowerCase() !== "bundle"
        ? "Only sent to Salesforce when this is \"Bundle\" — Type is a restricted picklist."
        : undefined,
    },
    { label: "Selling Model", value: fields.sellingModel, provenance: fieldProvenance(fields.sellingModel, intent?.sellingModel, emptyStr) },
    { label: "Price Book", value: fields.priceBook, provenance: fieldProvenance(fields.priceBook, intent?.priceBook, emptyStr) },
    {
      label: "Base Price",
      value: formatProductPrice(fields.basePrice, fields.currencyIsoCode),
      provenance: fieldProvenance(fields.basePrice, intent?.basePrice, emptyStr),
      note: fields.basePrice ? `Saved as PricebookEntry.UnitPrice in "${fields.priceBook || "Standard Price Book"}".` : undefined,
    },
    { label: "Currency", value: fields.currencyIsoCode, provenance: fieldProvenance(fields.currencyIsoCode, intent?.currencyIsoCode, emptyStr) },
    {
      label: "Tax Included",
      value: fields.taxIncluded === null ? "" : fields.taxIncluded ? "Yes" : "No",
      provenance: fields.taxIncluded === null ? "unspecified" : (intent?.taxIncluded.value === fields.taxIncluded ? intent.taxIncluded.provenance : "explicit"),
      note: fields.taxIncluded !== null ? "Not sent to Salesforce — no standard field exists for this." : undefined,
    },
    {
      label: "Unit of Measure",
      value: fields.unitOfMeasure,
      provenance: fieldProvenance(fields.unitOfMeasure, intent?.unitOfMeasure, emptyStr),
      note: fields.unitOfMeasure ? "Matched to an existing UnitOfMeasure / Quantity Unit Of Measure value — skipped (not created) if none matches." : undefined,
    },
    {
      label: "Classification",
      value: fields.classification,
      provenance: fieldProvenance(fields.classification, intent?.classification, emptyStr),
      note: fields.classification ? "Sets Product2.BasedOnId to an existing Active Product Classification — skipped (not created) if none matches." : undefined,
    },
    { label: "Active", value: fields.isActive ? "Yes" : "No", provenance: intent && fields.isActive === intent.isActive.value ? intent.isActive.provenance : "explicit" },
    { label: "Product Owner", value: fields.productOwner, provenance: fieldProvenance(fields.productOwner, intent?.productOwner, emptyStr) },
    { label: "Description", value: fields.description, provenance: fieldProvenance(fields.description, intent?.description, emptyStr) },
  ];
}
