import type { NextRequest } from "next/server";
import { soql } from "@/lib/ramp/server/api";
import { lifecycleRoute } from "@/lib/assetLifecycle/server/context";
import { fieldsOf } from "@/lib/assetLifecycle/server/reads";
import { LifecycleInputError } from "@/lib/assetLifecycle/server/service";

// POST /api/assets/reference/search { objectType: "Account", term, all? } — the shared ReferenceLookup's search for the asset
// lifecycle pages. Accounts that own lifecycle assets are listed (browse on focus allowed); `all` searches every account. READ-ONLY.
export async function POST(req: NextRequest) {
  return lifecycleRoute(req, async ({ api }, body) => {
    if (body.objectType !== "Account") throw new LifecycleInputError("Unsupported reference object type.");
    const term = typeof body.term === "string" ? body.term.trim().slice(0, 80).replace(/[%_]/g, "") : "";
    const asset = await fieldsOf(api, "Asset");
    const scoped = body.all !== true && body.all !== "1" && asset?.has("HasLifecycleManagement");
    const where = [scoped ? "Id IN (SELECT AccountId FROM Asset WHERE HasLifecycleManagement = true)" : null, term ? `Name LIKE ${soql(`%${term}%`)}` : null].filter(Boolean);
    const rows = await api.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM Account${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY Name LIMIT 25`);
    return { success: true, matches: rows.map(r => ({ id: r.Id, name: r.Name })) };
  }, "Account search failed");
}
