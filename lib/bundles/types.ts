/**
 * Mirrors the ParsedBundle/ParsedProduct shape app/api/bundles/execute's
 * route already accepts (its own local interfaces — this file doesn't
 * import from there since the two only ever meet over the wire as JSON,
 * but the shape must stay identical). The Bundle Importer builds THIS
 * exact structure from CSV/Excel rows instead of inventing a separate,
 * simplified import JSON, per the requirement that import reuse the
 * existing Bundle Creation service rather than a second implementation.
 */
export interface BundleImportAttribute {
  name: string;
  type: "Picklist" | "Text" | "Number" | "Boolean";
  values?: string[];
  required?: boolean;
}

export interface ParsedProduct {
  name: string;
  price: number;
  isDependency: boolean;
  dependencyOf?: string | null;
  sellingModel?: string;
  category?: string;
  attributes?: BundleImportAttribute[];
  isRequired?: boolean;
}

export interface ParsedBundle {
  bundleName: string;
  /** Optional — checked for duplicates in addition to bundleName when the Bundle Importer has a real Bundle Code column mapped. */
  bundleCode?: string;
  description?: string;
  category?: string;
  catalog?: string;
  sellingModel?: string;
  bundleType?: string;
  products: ParsedProduct[];
  nestedBundles?: ParsedBundle[];
  dependencies?: { source: string; target: string; targetPrice: number; type?: string }[];
  attributes?: BundleImportAttribute[];
  totalPrice: number;
}
