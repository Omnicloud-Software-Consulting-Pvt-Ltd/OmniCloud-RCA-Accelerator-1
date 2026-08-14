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
