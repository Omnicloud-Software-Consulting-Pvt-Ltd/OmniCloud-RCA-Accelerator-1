import { rowToInput, type FlatRow } from "@/lib/taxLibrary/importExport";
import { normalizeInput } from "@/lib/taxLibrary/library";
import type { DatasetManifest } from "@/lib/taxLibrary/datasets";
import { identityKey, type TaxRateReference } from "@/lib/taxLibrary/types";

/**
 * REFERENCE DATA — the library's source-backed tax content, shipped with the app as versioned, read-only datasets.
 *
 * Reference records are NOT copied into browser storage and are never imported by users: they are built from the bundled
 * datasets on every load with STABLE ids (a hash of the rate's identity), so a dataset update replaces them in place and clearing
 * the browser never loses reference data. Browser storage only holds the user's own changes (see store.ts overlay).
 *
 * Datasets are produced by internal scripts (scripts/tax-datasets/*) from official sources; each row carries its source URL,
 * publishing organisation and verification status. Nothing is invented: a country an official source couldn't be confirmed
 * for has a PROFILE that says so (status + missing scope) and no rates.
 */

/** Whether a tax layer exists below national level and whether the library has it. */
export type LayerCoverage = "none" | "included" | "partial" | "not-included" | "not-assessed";

export interface CountryProfile {
  countryCode: string;
  /** found = official rates in the library; not-found = no official source could be confirmed; no-consumption-tax = official source says none. */
  status: "found" | "not-found" | "no-consumption-tax";
  note: string | null;
  /** State / province taxes (e.g. US state sales tax, Canadian PST/QST, Brazilian ICMS). */
  subnational: LayerCoverage;
  /** County / city / district taxes (e.g. US local sales taxes). */
  local: LayerCoverage;
  /** Scope explicitly NOT covered (shown to users as "Missing"). */
  missingScope: string[];
}

export interface ReferenceDataset { manifest: DatasetManifest; rows: FlatRow[]; profiles?: CountryProfile[] }

export interface ReferenceData {
  records: TaxRateReference[];
  manifests: DatasetManifest[];
  profiles: Map<string, CountryProfile>;
}

/** Bundled reference datasets (lazy-loaded so they aren't in the main bundle). Order = precedence for country profiles. */
export const REFERENCE_DATASETS: { id: string; name: string; load: () => Promise<ReferenceDataset> }[] = [
  { id: "eu-tedb-vat", name: "EU VAT rates — European Commission TEDB", load: async () => (await import("@/lib/taxLibrary/datasets/eu-tedb-vat.json")).default as unknown as ReferenceDataset },
  { id: "official-national", name: "National & subnational consumption taxes — official tax-authority sources", load: async () => (await import("@/lib/taxLibrary/datasets/official-sources.json")).default as unknown as ReferenceDataset },
];

/** 32-bit FNV-1a → base36; deterministic across runs and platforms. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** Converts one dataset into reference records with stable ids (same row → same id in every browser and every release). */
export function recordsFromDataset(ds: ReferenceDataset): TaxRateReference[] {
  const m = ds.manifest;
  const at = `${m.retrievedAt}T00:00:00.000Z`;
  const origin = `dataset:${m.id}@${m.version}`;
  const seen = new Map<string, number>();
  return ds.rows.map(row => {
    const n = normalizeInput(rowToInput(row));
    const key = [identityKey(n), n.effective.effectiveFrom, n.rate.ratePercent ?? "", n.classification.productCategory ?? "", n.classification.serviceCategory ?? ""].join("|");
    const base = `ref-${m.id}-${fnv(key)}`;
    const dup = seen.get(base) ?? 0;
    seen.set(base, dup + 1);
    const id = dup ? `${base}-${dup}` : base;
    return {
      ...n, id, lineageId: id, version: 1, supersedesId: null, origin, createdAt: at, updatedAt: at,
      history: [{ at, action: "seeded", detail: `Reference data — ${m.name} (version ${m.version}).` }],
    } satisfies TaxRateReference;
  });
}

export function buildReferenceData(datasets: ReferenceDataset[]): ReferenceData {
  const profiles = new Map<string, CountryProfile>();
  for (const d of datasets) for (const p of d.profiles ?? []) if (!profiles.has(p.countryCode)) profiles.set(p.countryCode, p);
  return { records: datasets.flatMap(recordsFromDataset), manifests: datasets.map(d => d.manifest), profiles };
}

export async function loadReferenceData(): Promise<ReferenceData> {
  return buildReferenceData(await Promise.all(REFERENCE_DATASETS.map(d => d.load())));
}
