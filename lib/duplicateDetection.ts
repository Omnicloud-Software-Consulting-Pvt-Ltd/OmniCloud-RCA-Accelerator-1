/**
 * Shared shapes for the Duplicate Detection system — used by both the
 * Product (lib/products/server/duplicateCheck.ts) and Bundle
 * (lib/bundles/server/duplicateCheck.ts) duplicate services, and by every
 * frontend call site that needs to render the same "already exists" /
 * "similar records" UI (RCProductWorkspace, MultiProductWorkspace,
 * BundleOrchestrationWorkspace, Product/Bundle Import, the Attribute
 * workflow's Product Validation). One response shape everywhere means the
 * duplicate modal never has to special-case where the check came from.
 */

export interface DuplicateSimilarRecord {
  recordId: string;
  recordName: string;
  recordCode: string | null;
}

/** Everything about the record that actually caused the conflict — enough to render "Existing Product/Bundle" without a second round-trip. */
export interface DuplicateExistingRecord extends DuplicateSimilarRecord {
  isActive: boolean;
  family: string | null;
  /** Bundle-only fields — null for Products, and for a Bundle-name conflict against a plain (non-bundle) Product2. */
  componentCount: number | null;
  sellingModel: string | null;
  catalog: string | null;
  category: string | null;
  lastModifiedDate: string | null;
}

export type DuplicateCheckResult =
  | {
      isDuplicate: true;
      matchType: "exact-name" | "exact-code";
      objectApiName: "Product2";
      recordId: string;
      recordName: string;
      recordCode: string | null;
      salesforceUrl: string;
      existing: DuplicateExistingRecord;
      similarRecords: DuplicateSimilarRecord[];
    }
  | {
      isDuplicate: false;
      similarRecords: DuplicateSimilarRecord[];
    };

/** Trim + case-fold — the app's uniqueness policy treats "Laptop Pro 15" and "laptop pro 15 " as the same name, never two different products. */
export function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
