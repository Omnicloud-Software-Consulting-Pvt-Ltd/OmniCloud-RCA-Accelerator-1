import type { SalesforceClient } from "@/lib/salesforce/client";

/**
 * Product Selling Model name/frequency matching — extracted from
 * app/api/sf/products/save/route.ts so the bulk CSV/Excel importer's
 * pre-flight validation (does this row's Selling Model column resolve to a
 * real Salesforce record?) uses the EXACT SAME matching logic the actual
 * create call uses, instead of a second, potentially-diverging
 * implementation. Both save/route.ts and the importer's validate route
 * import from here.
 */
export interface SellingModelRecord {
  Id: string;
  Name: string;
  SellingModelType: string;
}

export function normalizeName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseSellingModelFallback(input: string): { modelType: string | null; frequency: string | null } {
  const s = (input || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
  let modelType: string | null = null;
  if (/\bone ?time\b|onetime/.test(s)) modelType = "onetime";
  else if (/\bevergreen\b|\brecurring\b|\bsubscription\b/.test(s)) modelType = "evergreen";
  else if (/\bterm ?based\b|\btermed\b|\bterm\b|\bcontract\b/.test(s)) modelType = "termbased";

  let frequency: string | null = null;
  if (/\bsemi ?annual\b|\bbiannual\b|\bhalf ?year\b/.test(s)) frequency = "semiannual";
  else if (/\bmonth/.test(s)) frequency = "monthly";
  else if (/\bquarter/.test(s)) frequency = "quarterly";
  else if (/\byear\b|\bannual\b/.test(s)) frequency = "yearly";

  return { modelType, frequency };
}

export function scoreSellingModel(record: SellingModelRecord, modelType: string | null, frequency: string | null): number {
  const n = normalizeName(record.Name);
  let recordType: string | null = null;
  if (/onetime/.test(n)) recordType = "onetime";
  else if (/evergreen/.test(n)) recordType = "evergreen";
  else if (/termbased|termd/.test(n)) recordType = "termbased";

  if (modelType && recordType !== modelType) return 0;

  let score = 10;
  let recordFreq: string | null = null;
  if (/semiannual/.test(n)) recordFreq = "semiannual";
  else if (/monthly/.test(n)) recordFreq = "monthly";
  else if (/quarterly/.test(n)) recordFreq = "quarterly";
  else if (/yearly/.test(n)) recordFreq = "yearly";

  if (frequency) {
    if (recordFreq === frequency) score += 5;
    else return 0;
  }
  return score;
}

export async function fetchSellingModels(client: SalesforceClient): Promise<SellingModelRecord[]> {
  const all = await client.query<SellingModelRecord>("SELECT Id, Name, SellingModelType FROM ProductSellingModel LIMIT 200");
  return all.records;
}

/** Best single match for `requestedType` among already-fetched `records`, or null if nothing resolves. */
export function matchSellingModel(records: SellingModelRecord[], requestedType: string): SellingModelRecord | null {
  const normInput = normalizeName(requestedType);
  const exact = records.find(r => normalizeName(r.Name) === normInput);
  if (exact) return exact;

  const { modelType, frequency } = parseSellingModelFallback(requestedType);
  if (!modelType && !frequency) return null;

  const scored = records
    .map(r => ({ model: r, score: scoreSellingModel(r, modelType, frequency) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.model.Name.localeCompare(b.model.Name));

  return scored.length > 0 ? scored[0].model : null;
}

export async function findMatchingSellingModels(client: SalesforceClient, requestedType: string): Promise<SellingModelRecord[]> {
  const records = await fetchSellingModels(client);
  const match = matchSellingModel(records, requestedType);
  return match ? [match] : [];
}
