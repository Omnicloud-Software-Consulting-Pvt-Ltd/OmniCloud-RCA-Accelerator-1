import type { SalesforceClient } from "@/lib/salesforce/client";
import { fetchSellingModels, matchSellingModel, type SellingModelRecord } from "@/lib/products/server/sellingModel";
import { fetchCatalogNames, fetchCategoryNames } from "@/lib/products/server/catalogLookup";
import type { ProductPayload } from "@/lib/products/types";
import type { CanonicalField } from "./columnMapping";

export type RowStatus = "ready" | "warning" | "error" | "skipped";
export interface RowIssue { level: "error" | "warning" | "info"; field?: string; message: string }

export interface ImportRowInput {
  name: string; productCode: string; description: string; family: string; type: string;
  category: string; catalog: string; sellingModel: string; price: string; currency: string; isActive: string;
}

export interface ImportRowResult {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  /** Normalized raw strings, for display — the resolved (possibly auto-generated) Product Code, not the raw cell. */
  input: ImportRowInput;
  resolvedSellingModelId: string | null;
  resolvedSellingModelName: string | null;
  /** null = no catalog/category given for this row; true/false = whether it already exists in Salesforce. */
  catalogResolved: boolean | null;
  categoryResolved: boolean | null;
  /** The exact shape POSTed to /api/sf/products/save — null for rows excluded from creation (error/skipped). */
  payload: ProductPayload | null;
}

export interface ValidateRowsResult {
  rows: ImportRowResult[];
  summary: { total: number; ready: number; warnings: number; errors: number; skipped: number; sellingModels: number };
}

/** Mirrors RCProductWorkspace's own `autoCode()` — duplicated deliberately (a 2-line pure helper) rather than importing from that client component into a server module. */
function autoCode(name: string): string {
  return name.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").slice(0, 40);
}

function parseActiveFlag(raw: string, fallback: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (["true", "yes", "1", "active", "y"].includes(v)) return true;
  if (["false", "no", "0", "inactive", "draft", "n"].includes(v)) return false;
  return fallback;
}

function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Validates + resolves every parsed import row against the connected
 * Salesforce org and builds the exact ProductPayload each creatable row
 * will later POST to /api/sf/products/save — so the "Create N Products"
 * step never has to re-derive anything, only replay what was already shown
 * on the preview screen.
 */
export async function validateImportRows(
  client: SalesforceClient,
  rawRows: Record<string, string>[],
  mapping: Record<CanonicalField, string | null>,
): Promise<ValidateRowsResult> {
  const get = (row: Record<string, string>, field: CanonicalField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const inputs: ImportRowInput[] = rawRows.map(row => ({
    name: get(row, "name"),
    productCode: get(row, "productCode"),
    description: get(row, "description"),
    family: get(row, "family"),
    type: get(row, "type"),
    category: get(row, "category"),
    catalog: get(row, "catalog"),
    sellingModel: get(row, "sellingModel"),
    price: get(row, "price"),
    currency: get(row, "currency"),
    isActive: get(row, "isActive"),
  }));

  // Product Code: use what was given, else auto-generate from Name (same
  // fallback the manual Create Product form uses) — tracked separately so
  // duplicate-code detection and the payload both use the resolved value.
  const resolvedCodes = inputs.map((input, i) => input.productCode || autoCode(input.name || `PRODUCT_${i + 1}`));
  const codeRowIndices = new Map<string, number[]>();
  resolvedCodes.forEach((code, i) => {
    const key = code.toLowerCase();
    const list = codeRowIndices.get(key) ?? [];
    list.push(i);
    codeRowIndices.set(key, list);
  });

  // Reference data fetched ONCE for the whole file, not per row.
  let sellingModels: SellingModelRecord[] = [];
  try { sellingModels = await fetchSellingModels(client); } catch { /* org may not expose ProductSellingModel — every row's lookup below reports unresolved instead of failing the whole import */ }
  let catalogMap = new Map<string, string>();
  try { catalogMap = await fetchCatalogNames(client); } catch { /* ProductCatalog inaccessible — catalogs are just reported unresolved (warning), not a hard failure */ }
  let categoryMap = new Map<string, string>();
  try { categoryMap = await fetchCategoryNames(client); } catch { /* same as above */ }

  // Existing-in-Salesforce duplicate check (by ProductCode or Name), one batched query.
  const existingByKey = new Map<string, { id: string }>();
  const codesToCheck = Array.from(new Set(resolvedCodes.map(c => c.toLowerCase()))).filter(Boolean).slice(0, 200);
  const namesToCheck = Array.from(new Set(inputs.map(i => i.name.toLowerCase()))).filter(Boolean).slice(0, 200);
  if (codesToCheck.length > 0 || namesToCheck.length > 0) {
    try {
      const clauses: string[] = [];
      if (codesToCheck.length) clauses.push(`ProductCode IN (${codesToCheck.map(c => `'${soqlEscape(c)}'`).join(",")})`);
      if (namesToCheck.length) clauses.push(`Name IN (${namesToCheck.map(n => `'${soqlEscape(n)}'`).join(",")})`);
      const soql = `SELECT Id, Name, ProductCode FROM Product2 WHERE ${clauses.join(" OR ")} LIMIT 400`;
      const result = await client.query<{ Id: string; Name: string; ProductCode: string | null }>(soql);
      for (const r of result.records) {
        if (r.ProductCode) existingByKey.set(`code:${r.ProductCode.toLowerCase()}`, { id: r.Id });
        existingByKey.set(`name:${r.Name.toLowerCase()}`, { id: r.Id });
      }
    } catch {
      // Best-effort — a failed duplicate-check query just means rows aren't flagged as pre-existing, not a blocked import.
    }
  }

  const rows: ImportRowResult[] = inputs.map((input, i) => {
    const issues: RowIssue[] = [];
    const productCode = resolvedCodes[i];

    if (!input.name) issues.push({ level: "error", field: "name", message: "Product Name is required." });
    if (!input.family) issues.push({ level: "error", field: "family", message: "Product Family is required." });
    if (!input.productCode && input.name) {
      issues.push({ level: "info", field: "productCode", message: `Product Code auto-generated from name: "${productCode}".` });
    }

    const dupeRows = codeRowIndices.get(productCode.toLowerCase()) ?? [];
    if (dupeRows.length > 1 && dupeRows[0] !== i) {
      issues.push({ level: "error", field: "productCode", message: `Product Code "${productCode}" is duplicated in the uploaded file (also used by row #${dupeRows[0] + 1}).` });
    }

    let price: number | undefined;
    if (input.price) {
      const parsed = Number(input.price.replace(/[^0-9.-]/g, ""));
      if (Number.isNaN(parsed)) issues.push({ level: "error", field: "price", message: `Price "${input.price}" is not a valid number.` });
      else price = parsed;
    }

    if (input.currency && !/^[A-Za-z]{3}$/.test(input.currency.trim())) {
      issues.push({ level: "warning", field: "currency", message: `Currency "${input.currency}" doesn't look like a 3-letter ISO code (e.g. USD) — it will still be sent as given.` });
    }

    let resolvedSellingModelId: string | null = null;
    let resolvedSellingModelName: string | null = null;
    if (input.sellingModel) {
      const match = matchSellingModel(sellingModels, input.sellingModel);
      if (match) {
        resolvedSellingModelId = match.Id;
        resolvedSellingModelName = match.Name;
      } else {
        issues.push({ level: "error", field: "sellingModel", message: `Selling Model "${input.sellingModel}" could not be resolved to an existing Product Selling Model in Salesforce.` });
      }
    }

    let catalogResolved: boolean | null = null;
    if (input.catalog) {
      catalogResolved = catalogMap.has(input.catalog.toLowerCase());
      if (!catalogResolved) issues.push({ level: "warning", field: "catalog", message: `Catalog "${input.catalog}" could not be resolved in Salesforce — it will be created automatically when this product is created.` });
    }

    let categoryResolved: boolean | null = null;
    if (input.category) {
      categoryResolved = categoryMap.has(input.category.toLowerCase());
      if (!categoryResolved) issues.push({ level: "warning", field: "category", message: `Category "${input.category}" could not be resolved in Salesforce — it will be created automatically when this product is created.` });
    }

    const dupExisting = existingByKey.get(`code:${productCode.toLowerCase()}`)
      ?? (input.name ? existingByKey.get(`name:${input.name.toLowerCase()}`) : undefined);

    // Duplicate Prevention (§14): an existing match is always excluded from
    // creation — there is no "create anyway" override (§5). This is a
    // pre-check only; POST /api/sf/products/save re-runs the same
    // duplicate check server-side as the final, race-condition-safe
    // authority (§21).
    let status: RowStatus = "ready";
    if (dupExisting) {
      issues.push({ level: "warning", field: "duplicate", message: `Duplicate — already exists in Salesforce (Id ${dupExisting.id}). This row will not be created.` });
      status = "skipped";
    }

    if (status !== "skipped") {
      const hasError = issues.some(iss => iss.level === "error");
      const hasWarning = issues.some(iss => iss.level === "warning");
      status = hasError ? "error" : hasWarning ? "warning" : "ready";
    }

    const payload: ProductPayload | null = status === "error" || status === "skipped" ? null : {
      productName: input.name,
      productCode,
      family: input.family,
      category: input.category || undefined,
      catalog: input.catalog || undefined,
      description: input.description || undefined,
      isActive: parseActiveFlag(input.isActive, true),
      sellingModel: input.sellingModel || undefined,
      priceBook: "Standard Price Book",
      basePrice: price !== undefined ? String(price) : undefined,
      productType: input.type || undefined,
      currencyIsoCode: input.currency || undefined,
    };

    return {
      index: i,
      status,
      issues,
      input: { ...input, productCode },
      resolvedSellingModelId,
      resolvedSellingModelName,
      catalogResolved,
      categoryResolved,
      payload,
    };
  });

  const summary = {
    total: rows.length,
    ready: rows.filter(r => r.status === "ready").length,
    warnings: rows.filter(r => r.status === "warning").length,
    errors: rows.filter(r => r.status === "error").length,
    skipped: rows.filter(r => r.status === "skipped").length,
    sellingModels: new Set(inputs.map(inp => inp.sellingModel.trim().toLowerCase()).filter(Boolean)).size,
  };

  return { rows, summary };
}
