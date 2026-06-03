import { NextRequest, NextResponse } from "next/server";
import {
  SalesforceClient,
  SalesforceError,
  SESSION_COOKIE,
  decodeSession,
  type QueryResult,
} from "@/lib/salesforce/client";

/* ─────────────────────────────────────────────────────────────────────────────
 * Types
 * ─────────────────────────────────────────────────────────────────────────── */

interface ProductPayload {
  productName: string;
  productCode: string;
  family: string;
  category?: string;
  catalog?: string;
  description?: string;
  isActive?: boolean;
  sellingModel?: string;
  productOwner?: string;
  priceBook?: string;
  basePrice?: string;
}

interface SellingModel {
  Id: string;
  Name: string;
  SellingModelType: string;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ─────────────────────────────────────────────────────────────────────────── */

function soqlEscape(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toDeveloperName(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

function isUnsupportedSObject(e: Error): boolean {
  return /sObject type .+ is not supported/i.test(e.message) || /INVALID_TYPE/i.test(e.message);
}

function normalizeName(s: string) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function findOrCreate(
  client: SalesforceClient,
  sobject: string,
  fields: Record<string, unknown>,
  searchOn: string[],
): Promise<{ id: string; created: boolean }> {
  const whereClauses = searchOn
    .map((k) => `${k} = '${soqlEscape(String(fields[k] ?? ""))}'`)
    .join(" AND ");
  const soql = `SELECT Id FROM ${sobject} WHERE ${whereClauses} LIMIT 1`;

  try {
    const result = await client.query<{ Id: string }>(soql);
    if (result.records.length > 0) return { id: result.records[0].Id, created: false };
  } catch {
    // not found — fall through to create
  }

  const created = await client.createRecord(sobject, fields);
  if (!created.success) throw new Error(`Failed to create ${sobject}: ${JSON.stringify(created.errors)}`);
  return { id: created.id, created: true };
}

function parseSellingModelFallback(input: string) {
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

function scoreSellingModel(record: SellingModel, modelType: string | null, frequency: string | null): number {
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

async function findMatchingSellingModels(client: SalesforceClient, requestedType: string): Promise<SellingModel[]> {
  const all = (await client.query<SellingModel>(
    "SELECT Id, Name, SellingModelType FROM ProductSellingModel LIMIT 200",
  )) as QueryResult<SellingModel>;

  const normInput = normalizeName(requestedType);
  const exact = all.records.find((r) => normalizeName(r.Name) === normInput);
  if (exact) return [exact];

  const { modelType, frequency } = parseSellingModelFallback(requestedType);
  if (!modelType && !frequency) return [];

  const scored = all.records
    .map((r) => ({ model: r, score: scoreSellingModel(r, modelType, frequency) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.model.Name.localeCompare(b.model.Name));

  return scored.length > 0 ? [scored[0].model] : [];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Route handler — POST /api/sf/products/save
 * ─────────────────────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE);
  const session = cookie?.value ? decodeSession(cookie.value) : null;
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let payload: ProductPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Use v62.0 for EPC objects
  const client = new SalesforceClient(session.instanceUrl, session.accessToken, "v62.0");

  const steps: Record<string, unknown> = {};
  const errors: Array<{ step: string; error: string }> = [];
  const skipped: Array<{ step: string; reason: string }> = [];

  /* ── Step 1: Product2 ── */
  let productId: string;
  try {
    const product = await client.createRecord("Product2", {
      Name:        payload.productName,
      ProductCode: payload.productCode,
      Family:      payload.family,
      Description: payload.description || payload.productName,
      IsActive:    payload.isActive !== false,
    });
    if (!product.success) throw new Error(`Product2 creation failed: ${JSON.stringify(product.errors)}`);
    productId = product.id;
    steps.product = { id: productId, name: payload.productName };
  } catch (err) {
    const msg = err instanceof SalesforceError ? err.message : (err as Error).message;
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }

  /* ── Step 2: Catalog → Category → CategoryProduct ── */
  if (payload.catalog) {
    try {
      const catalog = await findOrCreate(client, "ProductCatalog", { Name: payload.catalog }, ["Name"]);
      steps.catalog = { id: catalog.id, name: payload.catalog, created: catalog.created };

      if (payload.category) {
        const category = await findOrCreate(
          client, "ProductCategory",
          { Name: payload.category, CatalogId: catalog.id },
          ["Name", "CatalogId"],
        );
        steps.category = { id: category.id, name: payload.category, created: category.created };

        const catProd = await client.createRecord("ProductCategoryProduct", {
          ProductId:         productId,
          ProductCategoryId: category.id,
        });
        if (catProd.success) {
          steps.categoryAssignment = { id: catProd.id };
        } else {
          errors.push({ step: "categoryAssignment", error: JSON.stringify(catProd.errors) });
        }
      }
    } catch (e) {
      errors.push({ step: "catalog/category", error: (e as Error).message });
    }
  }

  /* ── Step 3: Selling Model ── */
  if (payload.sellingModel) {
    try {
      const matchedModels = await findMatchingSellingModels(client, payload.sellingModel);
      if (matchedModels.length === 0) {
        skipped.push({ step: "sellingModel", reason: `No ProductSellingModel matching '${payload.sellingModel}'` });
      } else {
        const optionResults: unknown[] = [];
        for (const sm of matchedModels) {
          const opt = await client.createRecord("ProductSellingModelOption", {
            Product2Id:            productId,
            ProductSellingModelId: sm.Id,
          });
          if (opt.success) {
            optionResults.push({ optionId: opt.id, modelId: sm.Id, modelName: sm.Name });
          } else {
            errors.push({ step: `sellingModelOption:${sm.Name}`, error: JSON.stringify(opt.errors) });
          }
        }
        steps.sellingModel = {
          matched: matchedModels.map((m) => ({ id: m.Id, name: m.Name, type: m.SellingModelType })),
          options: optionResults,
        };
      }
    } catch (e) {
      if (isUnsupportedSObject(e as Error)) {
        skipped.push({ step: "sellingModel", reason: "ProductSellingModel not accessible in this org" });
      } else {
        errors.push({ step: "sellingModel", error: (e as Error).message });
      }
    }
  }

  /* ── Step 4: PricebookEntry ── */
  if (payload.priceBook && payload.basePrice !== undefined && payload.basePrice !== "") {
    try {
      const unitPrice = parseFloat(payload.basePrice);
      if (!isNaN(unitPrice)) {
        const pbResult = await client.query<{ Id: string }>(
          `SELECT Id FROM Pricebook2 WHERE Name = '${soqlEscape(payload.priceBook)}' LIMIT 1`,
        );
        if (pbResult.records.length > 0) {
          const pricebook2Id = pbResult.records[0].Id;
          const pbe = await client.createRecord("PricebookEntry", {
            Product2Id:   productId,
            Pricebook2Id: pricebook2Id,
            UnitPrice:    unitPrice,
            IsActive:     payload.isActive !== false,
          });
          if (pbe.success) {
            steps.pricebookEntry = { id: pbe.id, pricebook: payload.priceBook, unitPrice };
          } else {
            errors.push({ step: "pricebookEntry", error: JSON.stringify(pbe.errors) });
          }
        } else {
          skipped.push({ step: "pricebookEntry", reason: `Price Book '${payload.priceBook}' not found in org` });
        }
      }
    } catch (e) {
      if (isUnsupportedSObject(e as Error)) {
        skipped.push({ step: "pricebookEntry", reason: "PricebookEntry not accessible in this org" });
      } else {
        errors.push({ step: "pricebookEntry", error: (e as Error).message });
      }
    }
  }

  return NextResponse.json({ success: true, salesforceId: productId, steps, errors, skipped });
}
