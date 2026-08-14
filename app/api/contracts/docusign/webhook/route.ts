import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getTrackedEnvelope } from "@/lib/contracts/docusign/signatureStatusStore";
import { getConnection } from "@/lib/contracts/docusign/connectionStore";
import { syncEnvelopeStatus } from "@/lib/contracts/docusign/statusSync";

/**
 * POST /api/contracts/docusign/webhook — DocuSign Connect webhook receiver
 * (§Phase 6). Previously NOT IMPLEMENTED (confirmed by repo-wide search —
 * only a display-only URL string existed in DocuSignSettings.tsx). Every
 * Contract's signature status progression past "Sent" now flows through
 * here (or through the manual "Refresh DocuSign Status" fallback below,
 * which shares the exact same status-mapping logic).
 *
 * Design choice — this handler does NOT branch on DocuSign's `event` name
 * or attempt to parse `envelopeSummary`/recipient fields out of the webhook
 * body itself. DocuSign Connect's exact JSON shape varies by account
 * configuration (classic aggregate XML-derived JSON vs. the newer Connect
 * JSON SIM format), and guessing at undocumented field paths risks silently
 * mis-mapping a real event. Instead: extract ONLY the envelopeId from the
 * payload (checked against a few known field paths), verify the HMAC, then
 * re-pull the envelope's canonical state directly from DocuSign
 * (getEnvelopeDiagnostics, via the shared syncEnvelopeStatus — the exact
 * same function "Refresh DocuSign Status" calls) and apply the same
 * forward-only, deduplicated stage update. DocuSign is the source of truth
 * either way (§Phase 7) — this just makes the webhook a reliable "something
 * changed, go re-check" trigger rather than a payload parser that could get
 * the schema wrong.
 *
 * Does NOT touch Salesforce. DocuSign calls this route directly — there is
 * no Salesforce session cookie on this request (requireSFClient has nothing
 * to authenticate), so Contract field writeback and signed-document upload
 * can only happen from the manual refresh/retrieve routes, which run with
 * a real browser-authenticated SalesforceClient. This is a disclosed
 * limitation of this app's per-user-session Salesforce auth model, not an
 * oversight — see the manual refresh route's own comment.
 */

function extractEnvelopeId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const data = p.data as Record<string, unknown> | undefined;
  const envelopeSummary = data?.envelopeSummary as Record<string, unknown> | undefined;
  const legacyEnvelopeStatus = p.EnvelopeStatus as Record<string, unknown> | undefined;

  const candidates = [
    data?.envelopeId,
    p.envelopeId,
    envelopeSummary?.envelopeId,
    legacyEnvelopeStatus?.EnvelopeID,
  ];
  const found = candidates.find(c => typeof c === "string" && c.length > 0);
  return (found as string) ?? null;
}

function verifyHmac(rawBody: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  // Constant-time compare — but only once lengths already match (timingSafeEqual
  // throws, rather than returning false, on a length mismatch).
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function POST(req: NextRequest) {
  // Raw text FIRST — HMAC verification needs the exact bytes DocuSign signed,
  // not a re-serialized JSON.parse() round-trip (which can reorder keys/
  // normalize whitespace and silently break the signature check).
  const rawBody = await req.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.log("[DOCUSIGN WEBHOOK] Body was not valid JSON — rejecting.");
    return NextResponse.json({ error: "Invalid webhook payload", code: "DOCUSIGN_WEBHOOK_INVALID_PAYLOAD" }, { status: 400 });
  }

  const eventName = (payload as { event?: string } | null)?.event ?? "(unknown)";
  const envelopeId = extractEnvelopeId(payload);
  if (!envelopeId) {
    console.log(`[DOCUSIGN WEBHOOK] event=${eventName} — no envelopeId found in payload, ignoring (acknowledged so DocuSign does not retry).`);
    return NextResponse.json({ received: true, ignored: true }, { status: 200 });
  }

  // Read-only lookups only, before signature verification — no state is
  // mutated and nothing sensitive is returned based on an unverified
  // request. This is required to even know WHICH org's webhook secret to
  // check against.
  const tracked = await getTrackedEnvelope(envelopeId);
  if (!tracked) {
    console.log(`[DOCUSIGN WEBHOOK] envelopeId=${envelopeId} event=${eventName} — not tracked by this server instance (unknown envelope, or a stale process from before a restart), ignoring.`);
    return NextResponse.json({ received: true, ignored: true }, { status: 200 });
  }

  const connection = await getConnection(tracked.orgId);
  const signatureHeader = req.headers.get("x-docusign-signature-1");
  if (connection?.webhookSecret) {
    if (!verifyHmac(rawBody, connection.webhookSecret, signatureHeader)) {
      console.log(`[DOCUSIGN WEBHOOK] envelopeId=${envelopeId} event=${eventName} — HMAC signature verification FAILED, rejecting. A forged/unsigned request is never treated as valid.`);
      return NextResponse.json({ error: "Invalid webhook signature", code: "DOCUSIGN_WEBHOOK_SIGNATURE_INVALID" }, { status: 401 });
    }
  } else {
    console.log(`[DOCUSIGN WEBHOOK] envelopeId=${envelopeId} event=${eventName} — no webhook HMAC secret configured for this organization; skipping signature verification (demo-only fallback — configure a Webhook HMAC Secret in DocuSign Settings for real verification).`);
  }

  try {
    await syncEnvelopeStatus(tracked.orgId, envelopeId, "docusign-webhook");
    console.log(`[DOCUSIGN WEBHOOK] envelopeId=${envelopeId} event=${eventName} — synced successfully.`);
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    // Still 200 — most failures here (e.g. this org's DocuSign token needing
    // reauthorization) won't be fixed by DocuSign retrying the same webhook
    // delivery, and DocuSign Connect will disable a subscription after too
    // many non-2xx responses. The manual "Refresh DocuSign Status" fallback
    // covers this case once reauthorized.
    console.log(`[DOCUSIGN WEBHOOK] envelopeId=${envelopeId} event=${eventName} — sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ received: true, syncFailed: true }, { status: 200 });
  }
}
