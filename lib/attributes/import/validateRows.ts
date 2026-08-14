import type { SalesforceClient } from "@/lib/salesforce/client";
import { validateProductExists } from "@/lib/attributes/server/productValidation";
import { loadAttributeList } from "@/lib/attributes/server/attributeDetail";
import type { AttributeCanonicalField } from "./columnMapping";

export type AttributeRowStatus = "ready" | "warning" | "error";
export interface AttributeRowIssue { level: "error" | "warning" | "info"; message: string }

/**
 * The exact request shape POST /api/sf/attributes/execute-batch already
 * accepts (mirrors the local, unexported `ParsedAttribute`/`ParsedRCAData`
 * interfaces in that route and in POST /api/sf/attributes/parse — never
 * imported, since neither file exports them, but kept byte-for-byte
 * identical in field names so this app's ONE existing Attribute Creation
 * backend accepts this payload with zero changes on its side).
 */
export interface ParsedAttribute {
  name: string;
  dataType: string;
  configurable: boolean;
  required: boolean;
  active: boolean;
  description: string;
  values: string[];
  defaultValue: string | null;
}

export interface ParsedRCAData {
  productName: string;
  productCode: string;
  productFamily: string;
  productType: string;
  description: string;
  isActive: boolean;
  unitOfMeasure: string;
  sellingModel: string;
  classificationName: string;
  categoryName: string;
  attributes: ParsedAttribute[];
}

export type AttributeDataTypeKind = "Picklist" | "Checkbox" | "Text" | "Number" | "Decimal" | "Currency" | "Date" | "DateTime" | "Unknown";

/**
 * Client-side (validation-only) classification of the raw Data Type cell —
 * used ONLY to decide whether Values is required/ignored and how to shape
 * the ParsedAttribute below. This never overrides what actually gets
 * created: the raw `dataType` string is passed through to execute-batch
 * unchanged, and THAT route's own Batch 0 (`normalizeDatatype`, checked
 * against this org's real AttributeDefinition.DataType picklist values) is
 * the one and only source of truth for the Salesforce field value, exactly
 * per §16's "use the existing Attribute Creation implementation as the
 * source of truth for the exact API field/type mappings."
 */
export function classifyDataType(raw: string): AttributeDataTypeKind {
  const v = raw.trim().toLowerCase();
  if (["picklist", "enum", "select"].includes(v)) return "Picklist";
  if (["checkbox", "boolean", "bool"].includes(v)) return "Checkbox";
  if (["text", "string", "str"].includes(v)) return "Text";
  if (["number", "num", "integer", "int", "float"].includes(v)) return "Number";
  if (v === "decimal") return "Decimal";
  if (["currency", "curr"].includes(v)) return "Currency";
  if (v === "date") return "Date";
  if (["datetime", "date time"].includes(v)) return "DateTime";
  return "Unknown";
}

const BOOLEAN_VALUE_WORDS = new Set(["true", "false", "yes", "no", "1", "0", "enabled", "disabled", "on", "off", "active", "inactive"]);

/** Splits "8GB, 16GB,32GB" into ["8GB","16GB","32GB"] — normalizes whitespace around each value, per §4. */
export function splitValues(raw: string): string[] {
  return raw.split(",").map(v => v.trim()).filter(Boolean);
}

export interface AttributeRowInput { productName: string; attributeName: string; dataType: string; values: string }

export interface AttributeRowResult {
  rowIndex: number;
  input: AttributeRowInput;
  status: AttributeRowStatus;
  issues: AttributeRowIssue[];
  dataTypeKind: AttributeDataTypeKind;
  parsedValues: string[];
  /** True when this exact Product already has an attribute with this exact name — this row is skipped (never duplicated), not treated as invalid. */
  alreadyExists: boolean;
}

export interface AttributeProductGroup {
  index: number;
  productName: string;
  status: AttributeRowStatus;
  issues: AttributeRowIssue[];
  resolvedProductId: string | null;
  resolvedProductCode: string | null;
  /** Real Salesforce Products whose name is similar (not exact) — shown so the user can spot a likely typo, never auto-selected. */
  similarProducts: { id: string; name: string; productCode: string | null }[];
  rows: AttributeRowResult[];
  /** The exact payload POST /api/sf/attributes/execute-batch's batches 0-6 accept — null when there's nothing new to create (Product unresolved, or every row already exists/is invalid). */
  parsedRCAData: ParsedRCAData | null;
}

export interface ValidateAttributeImportResult {
  groups: AttributeProductGroup[];
  summary: {
    totalProducts: number;
    totalAttributes: number;
    readyProducts: number;
    warningProducts: number;
    errorProducts: number;
    byType: Record<string, number>;
  };
}

/**
 * Validates + resolves every parsed Attribute import row against the
 * connected Salesforce org. Rows sharing the same Product Name are grouped
 * into ONE product's attribute set (§10) — never one product per row. Every
 * resolved, non-duplicate row is converted into the EXACT ParsedRCAData
 * shape POST /api/sf/attributes/execute-batch's batches 0-6 already accept
 * (§12) — this module never talks to Salesforce for anything execute-batch
 * itself will do; it only resolves the Product (§1) and pre-filters
 * duplicate/invalid rows (§9/§13) so the create step never hands
 * execute-batch anything it shouldn't act on.
 */
export async function validateAttributeImportRows(
  client: SalesforceClient,
  rawRows: Record<string, string>[],
  mapping: Record<AttributeCanonicalField, string | null>,
): Promise<ValidateAttributeImportResult> {
  const get = (row: Record<string, string>, field: AttributeCanonicalField): string => {
    const header = mapping[field];
    if (!header) return "";
    return (row[header] ?? "").toString().trim();
  };

  const rowInputs: AttributeRowInput[] = rawRows.map(row => ({
    productName: get(row, "productName"),
    attributeName: get(row, "attributeName"),
    dataType: get(row, "dataType"),
    values: get(row, "values"),
  }));

  // Group by Product Name (case-insensitive) — a row with no Product Name becomes its own single-row group, reported as an error (Product Name is required, §9).
  const groupIndices: number[][] = [];
  const keyToGroup = new Map<string, number>();
  rowInputs.forEach((input, i) => {
    const key = input.productName.toLowerCase();
    if (key) {
      const existing = keyToGroup.get(key);
      if (existing !== undefined) { groupIndices[existing].push(i); return; }
      keyToGroup.set(key, groupIndices.length);
      groupIndices.push([i]);
    } else {
      groupIndices.push([i]);
    }
  });

  // Resolve every DISTINCT Product Name exactly once (§1) — never once per row, even when 10 rows name the same product.
  const distinctProductNames = [...new Set(groupIndices.map(indices => rowInputs[indices[0]].productName).filter(Boolean))];
  const productResolutions = new Map<string, Awaited<ReturnType<typeof validateProductExists>>>();
  await Promise.all(distinctProductNames.map(async name => {
    productResolutions.set(name, await validateProductExists(client, name));
  }));

  // Existing attributes org-wide, fetched ONCE and reused for every row's duplicate check (§13) — never one query per row.
  const existingAttributes = await loadAttributeList(client);
  const existsForProduct = (attributeName: string, productId: string): boolean => {
    const norm = attributeName.trim().toLowerCase();
    return existingAttributes.some(a => a.name.trim().toLowerCase() === norm && a.relatedProducts.some(p => p.id === productId));
  };

  const groups: AttributeProductGroup[] = groupIndices.map((indices, g) => {
    const productName = rowInputs[indices[0]].productName;
    const issues: AttributeRowIssue[] = [];

    if (!productName) {
      issues.push({ level: "error", message: "Product Name is required." });
      return {
        index: g, productName: productName || "(blank)", status: "error", issues,
        resolvedProductId: null, resolvedProductCode: null, similarProducts: [], rows: [], parsedRCAData: null,
      };
    }

    const resolution = productResolutions.get(productName)!;
    const resolvedProductId = resolution.status === "found" ? resolution.product.id : null;
    const resolvedProductCode = resolution.status === "found" ? resolution.product.productCode : null;
    const similarProducts = resolution.status === "not_found"
      ? resolution.candidates.map(c => ({ id: c.id, name: c.name, productCode: c.productCode }))
      : [];

    if (!resolvedProductId) {
      issues.push({
        level: "error",
        message: similarProducts.length > 0
          ? `Product "${productName}" was not found in Salesforce — this entire group is skipped. Similar products: ${similarProducts.map(p => p.name).join(", ")}.`
          : `Product "${productName}" was not found in Salesforce — this entire group is skipped.`,
      });
    }

    const rows: AttributeRowResult[] = indices.map(rowIndex => {
      const input = rowInputs[rowIndex];
      const rowIssues: AttributeRowIssue[] = [];
      const dataTypeKind = classifyDataType(input.dataType);
      const parsedValues = splitValues(input.values);
      let alreadyExists = false;

      if (!input.attributeName) rowIssues.push({ level: "error", message: `Row ${rowIndex + 1}: Attribute Name is required.` });
      if (!input.dataType) rowIssues.push({ level: "error", message: `Row ${rowIndex + 1}: Data Type is required.` });
      else if (dataTypeKind === "Unknown") rowIssues.push({ level: "error", message: `Row ${rowIndex + 1}: "${input.dataType}" is not a supported Data Type. Use Picklist, Checkbox, Text, Number, Decimal, Currency, or Date.` });

      if (dataTypeKind === "Picklist" && parsedValues.length === 0) {
        rowIssues.push({ level: "error", message: `Row ${rowIndex + 1}: "${input.attributeName}" attribute for "${productName}" is Picklist but no Values were provided.` });
      }
      if (dataTypeKind === "Checkbox" && parsedValues.length > 0) {
        const allBooleanish = parsedValues.every(v => BOOLEAN_VALUE_WORDS.has(v.toLowerCase()));
        if (!allBooleanish) {
          rowIssues.push({ level: "warning", message: `Row ${rowIndex + 1}: "${input.attributeName}" is Checkbox — Values "${input.values}" doesn't look like True/False. This is only a hint; Checkbox is created as a Boolean regardless.` });
        }
      }

      if (resolvedProductId && input.attributeName && existsForProduct(input.attributeName, resolvedProductId)) {
        alreadyExists = true;
        rowIssues.push({ level: "warning", message: `Row ${rowIndex + 1}: "${input.attributeName}" already exists for "${productName}" — skipped, not duplicated.` });
      }

      const status: AttributeRowStatus = rowIssues.some(i => i.level === "error") ? "error" : rowIssues.some(i => i.level === "warning") ? "warning" : "ready";
      return { rowIndex, input, status, issues: rowIssues, dataTypeKind, parsedValues, alreadyExists };
    });

    issues.push(...rows.flatMap(r => r.issues));

    const creatableRows = rows.filter(r => r.status !== "error" && !r.alreadyExists && r.input.attributeName);
    const parsedRCAData: ParsedRCAData | null = (resolvedProductId && creatableRows.length > 0) ? {
      productName,
      productCode: resolvedProductCode || productName.replace(/\s+/g, "").toUpperCase().slice(0, 6) + "001",
      productFamily: "General",
      productType: "Goods",
      description: `Attributes imported for ${productName}`,
      isActive: true,
      unitOfMeasure: "Each",
      sellingModel: "One Time",
      classificationName: `${productName} Attributes`,
      categoryName: `${productName} Specifications`,
      attributes: creatableRows.map(r => {
        const isPicklist = r.dataTypeKind === "Picklist";
        return {
          name: r.input.attributeName,
          dataType: r.input.dataType.trim(),
          configurable: isPicklist,
          required: isPicklist,
          active: true,
          description: `${r.input.attributeName} attribute`,
          values: isPicklist ? r.parsedValues : [],
          defaultValue: null,
        };
      }),
    } : null;

    const hasError = issues.some(i => i.level === "error") || !resolvedProductId;
    const hasWarning = issues.some(i => i.level === "warning");
    const status: AttributeRowStatus = hasError ? "error" : hasWarning ? "warning" : "ready";

    return { index: g, productName, status, issues, resolvedProductId, resolvedProductCode, similarProducts, rows, parsedRCAData };
  });

  const byType: Record<string, number> = {};
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.status === "error" || r.alreadyExists) continue;
      byType[r.dataTypeKind] = (byType[r.dataTypeKind] ?? 0) + 1;
    }
  }

  return {
    groups,
    summary: {
      totalProducts: groups.length,
      totalAttributes: groups.reduce((sum, g) => sum + g.rows.filter(r => r.status !== "error" && !r.alreadyExists).length, 0),
      readyProducts: groups.filter(g => g.status === "ready").length,
      warningProducts: groups.filter(g => g.status === "warning").length,
      errorProducts: groups.filter(g => g.status === "error").length,
      byType,
    },
  };
}
