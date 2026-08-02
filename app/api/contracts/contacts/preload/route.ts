import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { listAccountContacts } from "@/lib/contracts/contract/contact";

// POST /api/contracts/contacts/preload — every Contact under the selected
// Account (§3.3 preload mode), so the UI can auto-select a single match or
// show "no contacts under this account".
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let accountId: string;
  try {
    ({ accountId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!accountId?.trim()) return NextResponse.json({ success: true, contacts: [] });

  try {
    const contacts = await listAccountContacts(auth.client, accountId);
    return NextResponse.json({ success: true, contacts });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load contacts for this account");
  }
}
