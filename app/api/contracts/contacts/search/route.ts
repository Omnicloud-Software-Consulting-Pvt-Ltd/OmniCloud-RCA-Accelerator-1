import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { searchAccountContacts } from "@/lib/contracts/contract/contact";

// POST /api/contracts/contacts/search — dedicated Account-scoped Contact
// search for "Customer Signed By" (§3.3). Never searches without an accountId.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let accountId: string, term: string;
  try {
    ({ accountId, term } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!accountId?.trim()) return NextResponse.json({ success: true, contacts: [] });

  try {
    const contacts = await searchAccountContacts(auth.client, accountId, term ?? "");
    return NextResponse.json({ success: true, contacts });
  } catch (err) {
    return sfErrorResponse(err, "Failed to search contacts");
  }
}
