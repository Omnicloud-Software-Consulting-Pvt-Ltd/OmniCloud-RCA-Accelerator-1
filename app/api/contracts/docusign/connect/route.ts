import type { NextRequest } from "next/server";
import { startConnect } from "@/lib/contracts/docusign/server/connection";

// POST /api/contracts/docusign/connect { environment, integrationKey, secretKey, accountId? } | { reuseSaved: true }
// Stores the setup in a short-lived encrypted cookie and returns DocuSign's consent URL. The secret never goes back to the browser.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return startConnect(req, body ?? {});
}
