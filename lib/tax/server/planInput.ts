import { BadInputError } from "@/lib/billing/server/payments";
import type { PlanInput } from "@/lib/tax/server/taxQuery";

/** Validated plan input from a request body (shared by the plan and remediation routes). Never trusts AI or client-built Ids blindly. */
const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export function parsePlanInput(body: Record<string, unknown>): PlanInput {
  const p = (body.product ?? {}) as { id?: unknown; name?: unknown };
  const product = str(p.id) && SFID.test(str(p.id)!) ? { id: str(p.id) } : str(p.name) ? { name: str(p.name) } : null;
  if (!product) throw new BadInputError("Which product? Give its exact name, ProductCode or Product2 Id.");
  for (const k of ["accountId", "treatmentId", "engineId", "legalEntityId", "sellingModelId"] as const) if (str(body[k]) && !SFID.test(str(body[k])!)) throw new BadInputError(`${k} isn't a valid Salesforce Id.`);
  const basis = str(body.basis);
  if (basis && basis !== "Net" && basis !== "Gross") throw new BadInputError("basis must be Net or Gross.");
  return { product, account: str(body.account), accountId: str(body.accountId), quantity: num(body.quantity), unitPrice: num(body.unitPrice), country: str(body.country), state: str(body.state),
    taxCode: str(body.taxCode), rate: num(body.rate), basis, treatmentId: str(body.treatmentId), engineId: str(body.engineId), legalEntityId: str(body.legalEntityId), sellingModelId: str(body.sellingModelId) };
}
