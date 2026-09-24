"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";

/**
 * DocuSign's `returnUrl` landing target for the "Open Email & Send Signing
 * Link" test flow (see lib/contracts/docusign/envelope.ts's
 * resolveEmbeddedSigningRedirect) — DocuSign appends `?event=...` when it
 * sends the recipient's browser back here after the embedded signing
 * session ends. Deliberately its own minimal page rather than reusing
 * app/data/page.tsx (the shared Quotes/Orders/Contracts dashboard) — the
 * person landing here is an external recipient with no Salesforce session
 * and no reason to see that dashboard.
 */
const EVENT_COPY: Record<string, { headline: string; sub: string }> = {
  signing_complete: { headline: "Thank you — signing complete.", sub: "The sender has been notified. You can close this window." },
  viewing_complete: { headline: "Document viewed.", sub: "You can close this window." },
  decline: { headline: "You declined to sign.", sub: "The sender has been notified. You can close this window." },
  exception: { headline: "Something went wrong.", sub: "Please contact the sender for a new signing link." },
  session_timeout: { headline: "This signing session timed out.", sub: "Please ask the sender for a new signing link." },
  ttl_expired: { headline: "This signing link has expired.", sub: "Please ask the sender for a new signing link." },
  cannot_edit_envelope: { headline: "This document can no longer be signed.", sub: "Please contact the sender." },
};

function SignCompleteContent() {
  const searchParams = useSearchParams();
  const event = searchParams.get("event") ?? "";
  const copy = useMemo(() => EVENT_COPY[event] ?? { headline: "You're done here.", sub: "You can close this window." }, [event]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #000508 0%, #010918 50%, #000305 100%)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "white",
        padding: "2rem",
        gap: "1.25rem",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "1.15rem", fontWeight: 700, letterSpacing: "-0.03em" }}>Omnicloud</div>
      <div
        style={{
          width: 52, height: 52, borderRadius: "50%",
          background: "rgba(0,212,255,0.1)", border: "1.5px solid rgba(0,212,255,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
          <path d="M6 13l5 5 9-11" stroke="#00D4FF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div style={{ maxWidth: 320 }}>
        <p style={{ fontWeight: 600, fontSize: "0.95rem", color: "rgba(200,215,230,0.95)" }}>{copy.headline}</p>
        <p style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "rgba(120,150,185,0.75)", lineHeight: 1.5 }}>{copy.sub}</p>
      </div>
    </div>
  );
}

export default function SignCompletePage() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000508", color: "rgba(30,144,255,0.6)", fontSize: 13 }}>
          Loading…
        </div>
      }
    >
      <SignCompleteContent />
    </Suspense>
  );
}
