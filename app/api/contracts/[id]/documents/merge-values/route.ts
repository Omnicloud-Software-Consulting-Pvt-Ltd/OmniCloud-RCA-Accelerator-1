import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { loadMergeFieldValuesForContract } from "@/lib/contracts/documents/mergeFields";
import type { CompanySettings } from "@/lib/contracts/types";

type Params = { params: Promise<{ id: string }> };

// POST /api/contracts/[id]/documents/merge-values — resolves this Contract's
// real {{MergeField}} values ONCE per Documents-tab visit. The client then
// renders the live HTML preview itself (renderBrandedHtml is a pure function,
// safe to run in the browser) on every keystroke/branding change with no
// further server round-trip — this is what makes the editor feel instant
// instead of debounced. `companySettings` comes from the caller's own
// localStorage, same as every other route in this module.
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id: contractId } = await params;

  let companySettings: Partial<CompanySettings> | undefined;
  try {
    ({ companySettings } = await req.json().catch(() => ({ companySettings: undefined })));
  } catch {
    companySettings = undefined;
  }

  try {
    const values = await loadMergeFieldValuesForContract(client, contractId, companySettings ?? null);
    return NextResponse.json({ success: true, values });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load this contract's merge field values");
  }
}
