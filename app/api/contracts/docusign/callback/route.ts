import type { NextRequest } from "next/server";
import { completeCallback } from "@/lib/contracts/docusign/server/connection";

// GET /api/contracts/docusign/callback?code&state — DocuSign's OAuth redirect. Validates state + session, exchanges the code,
// verifies the account, stores the encrypted connection, then sends the user back to DocuSign Settings.
export async function GET(req: NextRequest) {
  return completeCallback(req);
}
