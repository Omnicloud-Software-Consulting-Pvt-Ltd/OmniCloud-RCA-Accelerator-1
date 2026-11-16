import type { NextRequest } from "next/server";
import { verifyConnection } from "@/lib/contracts/docusign/server/connection";

// POST /api/contracts/docusign/verify — "Test Connection": authorization, token, identity, account, base URI, eSignature access.
export async function POST(req: NextRequest) {
  return verifyConnection(req);
}
