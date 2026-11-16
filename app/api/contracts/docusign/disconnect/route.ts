import type { NextRequest } from "next/server";
import { disconnect } from "@/lib/contracts/docusign/server/connection";

// POST /api/contracts/docusign/disconnect — deletes the stored DocuSign credentials for this session.
export async function POST(req: NextRequest) {
  return disconnect(req);
}
