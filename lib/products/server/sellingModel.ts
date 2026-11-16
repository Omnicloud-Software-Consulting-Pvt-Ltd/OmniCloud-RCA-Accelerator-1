import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";

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
  /** ProductSellingModel.Status (Draft | Active | Inactive). Optional so callers with hand-built records keep working. */
  Status?: string | null;
}

/** Active first, then Draft (can be activated), then Inactive — the tie-break among equally good name matches. */
function statusRank(r: SellingModelRecord): number {
  return r.Status === "Inactive" ? 2 : r.Status === "Draft" ? 1 : 0;
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
  const all = await client.query<SellingModelRecord>("SELECT Id, Name, SellingModelType, Status FROM ProductSellingModel LIMIT 200");
  return all.records;
}

/** Best single match for `requestedType` among already-fetched `records`, or null if nothing resolves. */
export function matchSellingModel(records: SellingModelRecord[], requestedType: string): SellingModelRecord | null {
  const normInput = normalizeName(requestedType);
  const exact = records.filter(r => normalizeName(r.Name) === normInput).sort((a, b) => statusRank(a) - statusRank(b))[0];
  if (exact) return exact;

  const { modelType, frequency } = parseSellingModelFallback(requestedType);
  if (!modelType && !frequency) return null;

  const scored = records
    .map(r => ({ model: r, score: scoreSellingModel(r, modelType, frequency) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || statusRank(a.model) - statusRank(b.model) || a.model.Name.localeCompare(b.model.Name));

  return scored.length > 0 ? scored[0].model : null;
}

export async function findMatchingSellingModels(client: SalesforceClient, requestedType: string): Promise<SellingModelRecord[]> {
  const records = await fetchSellingModels(client);
  const match = matchSellingModel(records, requestedType);
  return match ? [match] : [];
}

/** Salesforce Ids compare by their case-sensitive 15-character prefix (15- and 18-char forms of one Id are equal). */
export function sameSalesforceId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.slice(0, 15) === b.slice(0, 15);
}

export interface SellingModelLink {
  modelId: string;
  modelName: string;
  optionId: string;
  /** true when the ProductSellingModelOption already existed (no duplicate is created). */
  alreadyLinked: boolean;
  /** true when the model was Draft and this call activated it. */
  activated: boolean;
}

/**
 * Makes a resolved ProductSellingModel sellable for a product — the Revenue Cloud prerequisite for a selling-model-specific
 * PricebookEntry:
 *  1. Status must be Active: a Draft model is activated (Status = 'Active'); an Inactive model is refused, never silently
 *     reactivated.
 *  2. ProductSellingModelOption (Product2Id + ProductSellingModelId) — the product ↔ selling model link. Reused when it
 *     already exists, so repeated saves never create duplicate options.
 * The PricebookEntry side (PricebookEntry.ProductSellingModelId) is written by persistProductPrice().
 */
export async function linkSellingModelToProduct(client: SalesforceClient, productId: string, model: SellingModelRecord): Promise<SellingModelLink> {
  let activated = false;
  if (model.Status === "Inactive") throw new Error(`Product Selling Model "${model.Name}" is Inactive in Salesforce — activate it (or choose another) before assigning it to a product.`);
  if (model.Status === "Draft") {
    await client.updateRecord("ProductSellingModel", model.Id, { Status: "Active" });
    activated = true;
  }
  const findOption = async () => (await client.query<{ Id: string }>(
    `SELECT Id FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(productId)}' AND ProductSellingModelId = '${soqlEscape(model.Id)}' LIMIT 1`,
  )).records[0] ?? null;
  const existing = await findOption();
  if (existing) return { modelId: model.Id, modelName: model.Name, optionId: existing.Id, alreadyLinked: true, activated };
  try {
    const opt = await client.createRecord("ProductSellingModelOption", { Product2Id: productId, ProductSellingModelId: model.Id });
    if (!opt.success) throw new Error(`ProductSellingModelOption creation failed: ${JSON.stringify(opt.errors)}`);
    return { modelId: model.Id, modelName: model.Name, optionId: opt.id, alreadyLinked: false, activated };
  } catch (err) {
    // Created concurrently by another request between the check and the create: reuse it rather than fail or duplicate.
    const raced = await findOption().catch(() => null);
    if (raced) return { modelId: model.Id, modelName: model.Name, optionId: raced.Id, alreadyLinked: true, activated };
    throw err;
  }
}

/** Every selling model the product is ALREADY linked to (ProductSellingModelOption), so callers can report the real associations. */
export async function productSellingModelLinks(client: SalesforceClient, productId: string): Promise<{ optionId: string; modelId: string; modelName: string | null }[]> {
  const res = await client.query<{ Id: string; ProductSellingModelId: string; ProductSellingModel: { Name: string } | null }>(
    `SELECT Id, ProductSellingModelId, ProductSellingModel.Name FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(productId)}'`,
  );
  return res.records.map(r => ({ optionId: r.Id, modelId: r.ProductSellingModelId, modelName: r.ProductSellingModel?.Name ?? null }));
}

export interface SellingModelMappingCheck {
  label: string;
  passed: boolean;
  expected: string;
  actual: string | null;
}

/**
 * Reads the mapping back from Salesforce and checks every part of it actually persisted: the selling model is Active, the
 * ProductSellingModelOption links it to the product, and each given PricebookEntry belongs to this product AND carries this
 * ProductSellingModelId. Nothing here trusts the write responses.
 */
export async function verifySellingModelMapping(
  client: SalesforceClient,
  input: { productId: string; modelId: string; entryIds: string[] },
): Promise<SellingModelMappingCheck[]> {
  const checks: SellingModelMappingCheck[] = [];
  const model = (await client.query<{ Id: string; Name: string; Status: string }>(
    `SELECT Id, Name, Status FROM ProductSellingModel WHERE Id = '${soqlEscape(input.modelId)}' LIMIT 1`,
  )).records[0];
  checks.push({ label: "Product Selling Model is Active", passed: model?.Status === "Active", expected: "Active", actual: model?.Status ?? null });

  const option = (await client.query<{ Id: string }>(
    `SELECT Id FROM ProductSellingModelOption WHERE Product2Id = '${soqlEscape(input.productId)}' AND ProductSellingModelId = '${soqlEscape(input.modelId)}' LIMIT 1`,
  )).records[0];
  checks.push({ label: "ProductSellingModelOption links the product to the selling model", passed: !!option, expected: input.modelId, actual: option?.Id ?? null });

  const ids = Array.from(new Set(input.entryIds.filter(Boolean)));
  if (ids.length) {
    const entries = (await client.query<{ Id: string; Product2Id: string; ProductSellingModelId: string | null; Pricebook2: { Name: string; IsStandard: boolean } | null }>(
      `SELECT Id, Product2Id, ProductSellingModelId, Pricebook2.Name, Pricebook2.IsStandard FROM PricebookEntry WHERE Id IN (${ids.map(i => `'${soqlEscape(i)}'`).join(",")})`,
    )).records;
    for (const id of ids) {
      const e = entries.find(r => sameSalesforceId(r.Id, id));
      const book = e?.Pricebook2 ? (e.Pricebook2.IsStandard ? "Standard Price Book" : e.Pricebook2.Name) : id;
      checks.push({
        label: `PricebookEntry (${book}) carries the Product Selling Model`,
        passed: !!e && sameSalesforceId(e.Product2Id, input.productId) && sameSalesforceId(e.ProductSellingModelId, input.modelId),
        expected: input.modelId,
        actual: e ? (e.ProductSellingModelId ?? null) : null,
      });
    }
  }
  return checks;
}
