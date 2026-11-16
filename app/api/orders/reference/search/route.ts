import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { searchReferencesByName } from "@/lib/quotes/quote/reference";
import { searchBillToContacts } from "@/lib/orders/order/billToContact";
import type { ReferenceObjectType } from "@/lib/quotes/types";

const VALID_TYPES: ReferenceObjectType[] = ["Account", "Pricebook2", "Contract", "Quote"];

// POST /api/orders/reference/search — type-ahead "contains" search by name for the
// generic ReferenceLookup component, reusing the same object-agnostic search the
// Quote module resolves through — no second implementation. Contact (Bill To Contact) is the one
// exception: it is scoped to the order's Account, returns email/account for the dropdown, and lets
// Salesforce errors surface instead of looking like "no matches".
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;

  let objectType: ReferenceObjectType, term: string, accountId: unknown;
  try {
    ({ objectType, term, accountId } = await req.json());
    if (objectType !== "Contact" && !VALID_TYPES.includes(objectType)) return NextResponse.json({ error: "Unsupported reference object type" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (objectType === "Contact") {
    if (typeof accountId !== "string" || !accountId) return NextResponse.json({ error: "Select an Account first — Bill To Contact lists that Account's Contacts." }, { status: 400 });
    try {
      const matches = await searchBillToContacts(auth.client, accountId, term ?? "");
      return NextResponse.json({ success: true, matches });
    } catch (err) {
      return sfErrorResponse(err, "Failed to search Contacts");
    }
  }

  try {
    const matches = await searchReferencesByName(auth.client, objectType, term ?? "");
    return NextResponse.json({ success: true, matches });
  } catch (err) {
    return sfErrorResponse(err, "Failed to search reference");
  }
}
