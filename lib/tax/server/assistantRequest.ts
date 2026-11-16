import { BadInputError } from "@/lib/billing/server/payments";
import type { AssistantRequest } from "@/lib/tax/types";

/** Validate the shape of an assistant request body (values are validated against metadata by the operations service). */
export function parseAssistantRequest(body: Record<string, unknown>): AssistantRequest {
  if (!Array.isArray(body.operations) || !body.operations.length) throw new BadInputError("operations must be a non-empty array.");
  if (body.operations.length > 15) throw new BadInputError("At most 15 operations per request.");
  const operations = (body.operations as Record<string, unknown>[]).map((o, i) => {
    if (!o || typeof o !== "object" || typeof o.op !== "string" || typeof o.object !== "string") throw new BadInputError(`operations[${i}] needs "op" and "object".`);
    return { ...o, key: typeof o.key === "string" && /^[\w-]{1,20}$/.test(o.key) ? o.key : `op${i + 1}` } as unknown as AssistantRequest["operations"][number];
  });
  const selections: Record<string, string> = {};
  if (body.selections && typeof body.selections === "object") for (const [k, v] of Object.entries(body.selections as Record<string, unknown>)) if (typeof v === "string" && /^[A-Za-z0-9]{1,40}$/.test(v)) selections[k] = v;
  return { operations, selections };
}
