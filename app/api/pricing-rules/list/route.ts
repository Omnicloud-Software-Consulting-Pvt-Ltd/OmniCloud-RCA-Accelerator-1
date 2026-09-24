import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { PRICING_RULES_API_VERSION } from "@/lib/pricing-rules/types";
import { describeObjectCached } from "@/lib/salesforce/describe";

/**
 * GET /api/pricing-rules/list — recent Pricing Procedures (Expression
 * Sets) for the dashboard's "Recent Pricing Procedures" widget.
 *
 * Schema-driven exactly like the attribute discovery API
 * (lib/pricing-rules/salesforce/productAttributeDiscovery.ts): Describe
 * ExpressionSet first, then only SELECT fields that Describe actually
 * confirms exist on this org — never assume `DeveloperName` (or any other
 * field) is present. This widget must never surface a SOQL exception to
 * the dashboard, so every failure mode (describe fails, query fails,
 * object isn't queryable at all) degrades to an empty `records: []`
 * response instead of a non-2xx error.
 */
const PREFERRED_FIELDS = ["Id", "Name", "CreatedDate", "LastModifiedDate", "Status", "VersionNumber"];

export async function GET(req: NextRequest) {
  const auth = requireSFClient(req, PRICING_RULES_API_VERSION);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  let fields: string[] = ["Id", "Name"]; // safe fallback if Describe itself fails
  try {
    const describe = await describeObjectCached(client, "ExpressionSet");
    const available = new Set(describe.fields.map(f => f.name));
    const resolved = PREFERRED_FIELDS.filter(f => available.has(f));
    if (resolved.length > 0) fields = resolved;
  } catch {
    // ExpressionSet isn't describable on this org (unlikely, but never fatal for a dashboard widget) — fall back to Id, Name.
  }
  if (!fields.includes("Id")) fields = ["Id", ...fields];

  const orderField = fields.includes("CreatedDate") ? "CreatedDate" : fields.includes("LastModifiedDate") ? "LastModifiedDate" : null;
  const soql = `SELECT ${fields.join(", ")} FROM ExpressionSet${orderField ? ` ORDER BY ${orderField} DESC` : ""} LIMIT 20`;

  try {
    const res = await client.query<Record<string, unknown>>(soql);
    return NextResponse.json({ records: res.records, fields });
  } catch {
    // Never surface a SOQL exception to this widget — an empty list renders the dashboard's empty state instead.
    return NextResponse.json({ records: [], fields });
  }
}
