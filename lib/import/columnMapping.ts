/**
 * Generic header-name → field matching engine shared by every bulk importer
 * (Products, Quotes, Contracts, Orders). Deliberately alias-list based
 * rather than fuzzy/embedding-based or an LLM call — every field set here is
 * small and well-known, so a short alias list matches real-world header
 * variations (ProductName/Product Name/Name, Qty/Quantity, PSM/Selling
 * Model, …) deterministically, without the latency/cost/unpredictability of
 * an AI call, and without ever guessing on a genuinely ambiguous header.
 * Originally built for Products (lib/products/import/columnMapping.ts,
 * which now delegates here) and generalized so each module just supplies
 * its own field list.
 */

/**
 * Human-facing documentation for a field — read by the Import Toolkit
 * (components/import/ImportToolkit.tsx) and the template generator
 * (lib/import/templateGenerator.ts). Deliberately optional and additive:
 * every existing `ImportFieldDef` literal across every module keeps working
 * unchanged whether or not it carries `toolkit` metadata, and the mapping
 * engine (suggestColumnMapping/toMappingRecord) never reads this field —
 * only `key`/`label`/`required`/`aliases` do. This is what keeps the
 * Toolkit, the Template, and the real mapping/validation in one source of
 * truth: they all read the SAME field-def array, never a separate list.
 */
export interface ImportFieldToolkitInfo {
  /** e.g. "Text", "Number", "Date (YYYY-MM-DD)", "Boolean", "Picklist" */
  format: string;
  example: string;
  description: string;
  /** Set ONLY when the real validator enforces this conditionally (e.g. "required when a Product is given for this row") — `required` on the field itself stays the mapping engine's literal required/optional flag. */
  conditional?: string;
  /** Set when the importer resolves this value against an existing Salesforce record by name. */
  relationship?: { object: string; note: string };
  /** Fixed values genuinely enforced by the importer's own code — never an org-dependent picklist guess. */
  expectedValues?: string[];
  /** True for a field used only to group rows client-side and never sent to Salesforce. */
  groupingKey?: boolean;
  /** True for a field that is parsed/displayed but never included in the Salesforce create payload. */
  notSentToSalesforce?: string;
}

export interface ImportFieldDef<K extends string = string> {
  key: K;
  label: string;
  required: boolean;
  aliases: string[];
  toolkit?: ImportFieldToolkitInfo;
}

/** Per-module Toolkit copy that doesn't belong to any one field — title, grouping behavior, sample rows. */
export interface ImportToolkitConfig<K extends string = string> {
  moduleLabel: string;
  /** e.g. "Multiple rows with the same Bundle Code are treated as components of the same Bundle." — omitted for one-row-per-record modules. */
  groupingNote?: string;
  /** Header row for the example table, in display order — a subset of `fields` by label. */
  exampleColumns: K[];
  exampleRows: Partial<Record<K, string>>[];
}

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface ColumnMappingSuggestion<K extends string = string> {
  header: string;
  field: K | null;
  /** "exact" — an alias matched verbatim; "fuzzy" — a weaker containment match the user should double-check; null when unmapped. */
  confidence: "exact" | "fuzzy" | null;
  /** True when this header matched more than one field equally well — left unmapped, needs a manual choice. */
  ambiguous: boolean;
}

/**
 * Best-guess mapping for every uploaded header against `fields`. Exact alias
 * matches win outright; otherwise a header that *contains* (or is contained
 * by) exactly one field's alias is mapped with lower confidence. A header
 * that matches more than one field this way is left unmapped and flagged
 * ambiguous rather than guessed.
 */
export function suggestColumnMapping<K extends string>(headers: string[], fields: ImportFieldDef<K>[]): ColumnMappingSuggestion<K>[] {
  return headers.map(header => {
    const norm = normalizeHeader(header);
    if (!norm) return { header, field: null, confidence: null, ambiguous: false };

    for (const def of fields) {
      if (def.aliases.some(a => normalizeHeader(a) === norm)) {
        return { header, field: def.key, confidence: "exact" as const, ambiguous: false };
      }
    }

    const fuzzyMatches = fields.filter(def =>
      def.aliases.some(a => {
        const na = normalizeHeader(a);
        return na.length > 2 && (norm.includes(na) || na.includes(norm));
      }),
    );

    if (fuzzyMatches.length === 1) {
      return { header, field: fuzzyMatches[0].key, confidence: "fuzzy" as const, ambiguous: false };
    }
    if (fuzzyMatches.length > 1) {
      return { header, field: null, confidence: null, ambiguous: true };
    }
    return { header, field: null, confidence: null, ambiguous: false };
  });
}

/** `{ fieldKey: originalHeader | null }` derived from suggestions — the shape mapping-review/validate steps pass around. */
export function toMappingRecord<K extends string>(suggestions: ColumnMappingSuggestion<K>[], fields: ImportFieldDef<K>[]): Record<K, string | null> {
  const record = Object.fromEntries(fields.map(f => [f.key, null])) as Record<K, string | null>;
  for (const s of suggestions) {
    if (s.field && !s.ambiguous) record[s.field] = s.header;
  }
  return record;
}

/** Empty `{ fieldKey: null }` mapping for `fields` — used to initialize wizard state before a file is parsed. */
export function emptyMappingRecord<K extends string>(fields: ImportFieldDef<K>[]): Record<K, string | null> {
  return Object.fromEntries(fields.map(f => [f.key, null])) as Record<K, string | null>;
}
