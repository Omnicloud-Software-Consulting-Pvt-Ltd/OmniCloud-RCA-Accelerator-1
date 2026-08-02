import { NextRequest, NextResponse } from "next/server";
import { requireSFClient } from "@/lib/salesforce/serverSession";
import { downloadContentVersion } from "@/lib/contracts/documents/contentVersion";

type Params = { params: Promise<{ id: string; contentVersionId: string }> };

// GET /api/contracts/[id]/documents/[contentVersionId]/download — proxy
// download through the app's own server (§4.4) — no browser-level Salesforce
// session cookie exists to hit a direct Salesforce file URL. Also backs the
// Document History "Reopen" action for any past version (§4.5).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { contentVersionId } = await params;

  try {
    const { buffer, filename, contentType } = await downloadContentVersion(auth.client, contentVersionId);
    const inline = req.nextUrl.searchParams.get("disposition") === "inline";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to download document" }, { status: 500 });
  }
}
