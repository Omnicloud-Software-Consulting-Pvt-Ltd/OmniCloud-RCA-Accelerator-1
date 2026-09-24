import type { SalesforceClient, DescribeField } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/products/server/salesforceWrites";

/**
 * Resolves the Product Creation UI's Unit of Measure and Product
 * Classification into real Product2 fields, driven by the org's own
 * describe instead of assuming a schema:
 *
 *   Unit of Measure       → Product2.UnitOfMeasureId (lookup to an existing
 *                            UnitOfMeasure matched by Name or UnitCode) and/or
 *                            Product2.QuantityUnitOfMeasure (only when the
 *                            value is an active value of that picklist)
 *   Product Classification → Product2.BasedOnId (lookup to an existing,
 *                            Active ProductClassification matched by Name or Code)
 *
 * Nothing is ever created here — a value that doesn't resolve to a real
 * record/picklist value is reported as skipped with the reason, never
 * fabricated, and never allowed to fail the Product2 create itself.
 */

export interface ResolvedProductFields {
  fields: Record<string, unknown>;
  resolved: Record<string, { id?: string; value: string; field: string }>;
  skipped: Array<{ step: string; reason: string }>;
}

function fieldOf(fields: DescribeField[], name: string, forUpdate: boolean): DescribeField | undefined {
  const f = fields.find(x => x.name === name);
  if (!f) return undefined;
  return (forUpdate ? f.updateable : f.createable) ? f : undefined;
}

export async function resolveProductFields(
  client: SalesforceClient,
  input: { unitOfMeasure?: string; classification?: string },
  opts: { forUpdate?: boolean } = {},
): Promise<ResolvedProductFields> {
  const out: ResolvedProductFields = { fields: {}, resolved: {}, skipped: [] };
  const uom = input.unitOfMeasure?.trim();
  const classification = input.classification?.trim();
  if (!uom && !classification) return out;

  let describe: DescribeField[];
  try {
    describe = (await client.describeObject("Product2")).fields;
  } catch (e) {
    const reason = `Could not describe Product2: ${(e as Error).message}`;
    if (uom) out.skipped.push({ step: "unitOfMeasure", reason });
    if (classification) out.skipped.push({ step: "classification", reason });
    return out;
  }
  const forUpdate = !!opts.forUpdate;

  /* ── Unit of Measure ── */
  if (uom) {
    let applied = false;
    const lookup = fieldOf(describe, "UnitOfMeasureId", forUpdate);
    if (lookup) {
      try {
        const res = await client.query<{ Id: string; Name: string }>(
          `SELECT Id, Name FROM UnitOfMeasure WHERE Name = '${soqlEscape(uom)}' OR UnitCode = '${soqlEscape(uom)}' LIMIT 1`,
        );
        const rec = res.records[0];
        if (rec) {
          out.fields.UnitOfMeasureId = rec.Id;
          out.resolved.unitOfMeasure = { id: rec.Id, value: rec.Name, field: "UnitOfMeasureId" };
          applied = true;
        }
      } catch { /* UnitOfMeasure not queryable — fall through to the picklist */ }
    }
    const picklist = fieldOf(describe, "QuantityUnitOfMeasure", forUpdate);
    const pickValue = picklist?.picklistValues?.find(p => p.active && p.value.toLowerCase() === uom.toLowerCase())?.value;
    if (pickValue) {
      out.fields.QuantityUnitOfMeasure = pickValue;
      if (!applied) out.resolved.unitOfMeasure = { value: pickValue, field: "QuantityUnitOfMeasure" };
      applied = true;
    }
    if (!applied) {
      out.skipped.push({ step: "unitOfMeasure", reason: `Unit of Measure "${uom}" doesn't match any UnitOfMeasure record or Quantity Unit Of Measure value in this org` });
    }
  }

  /* ── Product Classification ── */
  if (classification) {
    if (!fieldOf(describe, "BasedOnId", forUpdate)) {
      out.skipped.push({ step: "classification", reason: "Product2.BasedOnId (Product Classification) is not available in this org" });
    } else {
      try {
        const res = await client.query<{ Id: string; Name: string; Status?: string }>(
          `SELECT Id, Name, Status FROM ProductClassification WHERE Name = '${soqlEscape(classification)}' OR Code = '${soqlEscape(classification)}' ORDER BY Status ASC LIMIT 5`,
        );
        const active = res.records.find(r => r.Status === "Active");
        if (active) {
          out.fields.BasedOnId = active.Id;
          out.resolved.classification = { id: active.Id, value: active.Name, field: "BasedOnId" };
        } else if (res.records.length > 0) {
          out.skipped.push({ step: "classification", reason: `Product Classification "${classification}" exists but is not Active` });
        } else {
          out.skipped.push({ step: "classification", reason: `Product Classification "${classification}" was not found in this org (not auto-created)` });
        }
      } catch (e) {
        out.skipped.push({ step: "classification", reason: `ProductClassification not accessible: ${(e as Error).message}` });
      }
    }
  }

  return out;
}
