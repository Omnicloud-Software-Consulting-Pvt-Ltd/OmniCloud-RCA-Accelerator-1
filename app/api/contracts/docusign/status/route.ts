import type { NextRequest } from "next/server";
import { connectionStatus } from "@/lib/contracts/docusign/server/connection";

// GET /api/contracts/docusign/status — connection status for THIS Salesforce session (no network call, never any credential).
export function GET(req: NextRequest) {
  return connectionStatus(req);
}
