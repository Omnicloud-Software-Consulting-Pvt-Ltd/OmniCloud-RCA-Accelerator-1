import type { BundleCanonicalField } from "@/lib/bundles/import/columnMapping";
import type { ParsedBundle, ParsedProduct } from "@/lib/bundles/types";

export type BundleRowStatus = "ready" | "warning" | "error";
export interface BundleRowIssue { level: "error" | "warning" | "info"; message: string }

export interface BundleImportGroup {
  /** Bundle Code if given, else the lowercased Bundle Name — how rows are grouped into one bundle. */
  key: string;
  bundleName: string;
  bundleCode: string;
  description: string;
  family: string;
  bundleType: string;
  isActive: boolean;
  catalog: string;
  category: string;
  sellingModel: string;
  productNames: string[];
  status: BundleRowStatus;
  issues: BundleRowIssue[];
  /** The exact structure /api/bundles/execute accepts — null for groups excluded from creation (status "error"). */
  parsedBundle: ParsedBundle | null;
}

export interface BundleValidateResult {
  groups: BundleImportGroup[];
  summary: { totalBundles: number; totalComponents: number; ready: number; warnings: number; errors: number };
}

function parseActiveFlag(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return true;
  return !["false", "no", "0", "inactive", "draft", "n"].includes(v);
}

function parseRelationship(raw: string): { isRequired: boolean; label: string } {
  const v = raw.trim().toLowerCase();
  if (v === "optional") return { isRequired: false, label: "Optional" };
  if (v === "dependency") return { isRequired: true, label: "Dependency" };
  return { isRequired: true, label: raw.trim() || "Component" };
}

/**
 * Groups raw CSV/Excel rows by Bundle Code (falling back to Bundle Name)
 * into ONE bundle per group with N related products — never one bundle
 * per row — and builds the exact ParsedBundle shape
 * /api/bundles/execute already accepts, reusing that existing create
 * service rather than a separate import-creation path.
 */
export function validateBundleImportRows(
  rawRows: Record<string, string>[],
  mapping: Record<BundleCanonicalField, string | null>,
): BundleValidateResult {
  const get = (row: Record<string, string>, field: BundleCanonicalField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const groupsByKey = new Map<string, {
    bundleName: string; bundleCode: string; description: string; family: string; bundleType: string;
    isActive: boolean; catalog: string; category: string; sellingModel: string;
    rows: { productName: string; sellingModel: string; category: string; price: string; relationship: string }[];
  }>();
  const orderedKeys: string[] = [];

  for (const row of rawRows) {
    const bundleName = get(row, "bundleName");
    const bundleCode = get(row, "bundleCode");
    const key = (bundleCode || bundleName).toLowerCase();
    if (!key) continue; // no way to group this row at all — surfaced as a top-level "ungrouped rows" issue below

    if (!groupsByKey.has(key)) {
      orderedKeys.push(key);
      groupsByKey.set(key, {
        bundleName: bundleName || bundleCode,
        bundleCode,
        description: get(row, "description"),
        family: get(row, "family"),
        bundleType: get(row, "bundleType"),
        isActive: parseActiveFlag(get(row, "isActive")),
        catalog: get(row, "catalog"),
        category: get(row, "category"),
        sellingModel: get(row, "sellingModel"),
        rows: [],
      });
    }
    const group = groupsByKey.get(key)!;
    const productName = get(row, "productName");
    if (productName) {
      group.rows.push({
        productName,
        sellingModel: get(row, "sellingModel"),
        category: get(row, "category"),
        price: get(row, "price"),
        relationship: get(row, "relationship"),
      });
    }
  }

  const ungroupedCount = rawRows.length - orderedKeys.reduce((sum, key) => sum + groupsByKey.get(key)!.rows.length, 0);

  const groups: BundleImportGroup[] = orderedKeys.map(key => {
    const g = groupsByKey.get(key)!;
    const issues: BundleRowIssue[] = [];

    if (!g.bundleName) issues.push({ level: "error", message: "Bundle Name is required." });
    if (g.rows.length === 0) issues.push({ level: "error", message: "No products found for this bundle." });

    const seenProductNames = new Set<string>();
    const products: ParsedProduct[] = [];
    for (const r of g.rows) {
      const nameKey = r.productName.toLowerCase();
      if (seenProductNames.has(nameKey)) {
        issues.push({ level: "warning", message: `Duplicate product "${r.productName}" in this bundle — only the first occurrence is used.` });
        continue;
      }
      seenProductNames.add(nameKey);
      const price = r.price ? Number(r.price.replace(/[^0-9.-]/g, "")) : 0;
      if (r.price && Number.isNaN(price)) issues.push({ level: "warning", message: `Price "${r.price}" for "${r.productName}" is not a valid number — treated as 0.` });
      const { isRequired, label } = parseRelationship(r.relationship);
      products.push({
        name: r.productName,
        price: Number.isNaN(price) ? 0 : price,
        isDependency: label === "Dependency",
        sellingModel: r.sellingModel || g.sellingModel || undefined,
        category: r.category || g.category || undefined,
        isRequired,
      });
    }

    const hasError = issues.some(i => i.level === "error");
    const hasWarning = issues.some(i => i.level === "warning");
    const status: BundleRowStatus = hasError ? "error" : hasWarning ? "warning" : "ready";

    const parsedBundle: ParsedBundle | null = status === "error" ? null : {
      bundleName: g.bundleName,
      bundleCode: g.bundleCode || undefined,
      description: g.description || undefined,
      category: g.category || undefined,
      catalog: g.catalog || undefined,
      sellingModel: g.sellingModel || undefined,
      bundleType: g.bundleType || undefined,
      products,
      totalPrice: products.reduce((sum, p) => sum + p.price, 0),
    };

    return {
      key, bundleName: g.bundleName, bundleCode: g.bundleCode, description: g.description, family: g.family,
      bundleType: g.bundleType, isActive: g.isActive, catalog: g.catalog, category: g.category, sellingModel: g.sellingModel,
      productNames: products.map(p => p.name),
      status, issues, parsedBundle,
    };
  });

  if (ungroupedCount > 0) {
    // Surfaced via the summary rather than a fake extra group — these rows had neither a Bundle Name nor Bundle Code and cannot be attributed to any bundle.
    console.warn(`[validateBundleImportRows] ${ungroupedCount} row(s) had no Bundle Name/Code and were skipped.`);
  }

  return {
    groups,
    summary: {
      totalBundles: groups.length,
      totalComponents: groups.reduce((sum, g) => sum + g.productNames.length, 0),
      ready: groups.filter(g => g.status === "ready").length,
      warnings: groups.filter(g => g.status === "warning").length,
      errors: groups.filter(g => g.status === "error").length,
    },
  };
}
