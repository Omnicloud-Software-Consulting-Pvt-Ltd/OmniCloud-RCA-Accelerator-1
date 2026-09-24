/**
 * Shapes shared between the Attribute Workspace's read/update server layer
 * (lib/attributes/server/*) and its client components (Dashboard, History,
 * Detail, Edit). Kept separate from RCAAttributeStudio's own local
 * ParsedRCAData/BatchContext types (app/api/sf/attributes/{parse,
 * execute-batch}/route.ts) — those describe the AI-generation pipeline;
 * these describe attributes that already exist in Salesforce.
 */

export interface AttributePicklistValueRow {
  id: string;
  value: string;
  displayValue: string;
  sequence: number;
  isActive: boolean;
}

/** One ProductAttributeDefinition — this attribute's configuration on a specific product (per-product value/range). */
export interface AttributeProductConfig {
  id: string;
  productId: string | null;
  productName: string | null;
  defaultValue: string | null;
  minimumValue: string | null;
  maximumValue: string | null;
  stepValue: string | null;
}

export interface AttributeRelatedProduct {
  id: string;
  name: string;
}

export interface AttributeListItem {
  id: string;
  name: string;
  /** AttributeDefinition.DeveloperName — the closest analog to an "API Name" this object exposes. */
  apiName: string | null;
  dataType: string | null;
  isActive: boolean;
  description: string | null;
  isPicklist: boolean;
  picklistValueCount: number;
  relatedProducts: AttributeRelatedProduct[];
  createdDate: string;
  lastModifiedDate: string;
  lastModifiedByName: string | null;
}

export interface AttributeDetail extends AttributeListItem {
  label: string | null;
  picklistId: string | null;
  picklistValues: AttributePicklistValueRow[];
  /** Whether this org's schema allows changing DataType on an existing AttributeDefinition — never assumed true. */
  dataTypeEditable: boolean;
  /** Valid DataType picklist values for this org, for the Edit form's dropdown — empty means unrestricted/unknown. */
  validDataTypes: string[];
  /** AttributeDefinition.DefaultValue — the attribute's own configured value. */
  defaultValue: string | null;
  defaultValueEditable: boolean;
  /** Per-product configuration (ProductAttributeDefinition rows) for this attribute. */
  productConfigs: AttributeProductConfig[];
  /** Which ProductAttributeDefinition config fields are editable in this org (subset of DefaultValue/MinimumValue/MaximumValue/StepValue). */
  productConfigFields: string[];
  /** How many AttributeDefinitions use this same AttributePicklist — editing a value affects all of them. */
  picklistSharedCount: number;
}

/* ── Product existence validation (RCAAttributeStudio's new gate) ── */

export interface ProductValidationCandidate {
  id: string;
  name: string;
  productCode: string | null;
  confidence: number;
  matchType: "exact" | "substring" | "fuzzy";
}

export type ProductValidationResult =
  | { status: "found"; product: { id: string; name: string; productCode: string | null } }
  | { status: "not_found"; candidates: ProductValidationCandidate[] };
