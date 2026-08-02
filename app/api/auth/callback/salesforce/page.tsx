"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function Spinner() {
  return (
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: "50%",
        border: "2.5px solid rgba(30,144,255,0.15)",
        borderTopColor: "#1E90FF",
        animation: "spin 0.75s linear infinite",
      }}
    />
  );
}

function CheckIcon() {
  return (
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: "50%",
        background: "rgba(0,212,255,0.1)",
        border: "1.5px solid rgba(0,212,255,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <path d="M6 13l5 5 9-11" stroke="#00D4FF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ErrorIcon() {
  return (
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: "50%",
        background: "rgba(232,68,68,0.1)",
        border: "1.5px solid rgba(232,68,68,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#E84444" strokeWidth="2" />
        <line x1="12" y1="8" x2="12" y2="12" stroke="#E84444" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="16.5" r="1.2" fill="#E84444" />
      </svg>
    </div>
  );
}

function CallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [headline, setHeadline] = useState("Completing authentication…");
  const [sub, setSub] = useState("Exchanging credentials with Salesforce.");

  useEffect(() => {
    const code        = searchParams.get("code");
    const state       = searchParams.get("state") ?? "";
    const sfError     = searchParams.get("error");
    const sfErrorDesc = searchParams.get("error_description");

    const postToParent = (msg: Record<string, unknown>) => {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(msg, window.location.origin);
        }
      } catch {}
    };

    const fail = (msg: string) => {
      setStatus("error");
      setHeadline("Authentication failed");
      setSub(msg);
      postToParent({ type: "SF_AUTH_ERROR", error: msg });
      setTimeout(() => { try { window.close(); } catch {} }, 3500);
    };

    if (sfError) { fail(sfErrorDesc ?? sfError); return; }
    if (!code || !state) { fail("No authorization code received from Salesforce."); return; }

    fetch("/api/auth/salesforce/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) { fail(data.error); return; }
        setStatus("success");
        setHeadline("Signed in successfully");
        setSub(data.displayName || data.username || "");
        postToParent({
          type: "SF_AUTH_SUCCESS",
          state,
          session: {
            accessToken:  data.accessToken,
            refreshToken: data.refreshToken,
            instanceUrl:  data.instanceUrl,
            tokenType:    data.tokenType,
            userId:       data.userId,
            username:     data.username,
            displayName:  data.displayName,
            email:        data.email,
            orgId:        data.orgId,
            environment:  data.environment,
          },
        });
        setTimeout(() => { try { window.close(); } catch {} }, 1400);
      })
      .catch(() => fail("Network error. Please close this window and try again."));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        gap: "1.5rem",
        textAlign: "center",
      }}
    >
      <div style={{ marginBottom: "0.5rem" }}>
        <div style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.03em" }}>
          Omnicloud
        </div>
        <div style={{ fontSize: "9px", color: "rgba(30,144,255,0.7)", letterSpacing: "0.18em", textTransform: "uppercase", marginTop: "2px" }}>
          AI Platform
        </div>
      </div>

      {status === "loading" && <Spinner />}
      {status === "success" && <CheckIcon />}
      {status === "error"   && <ErrorIcon />}

      <div style={{ maxWidth: "260px" }}>
        <p style={{
          fontWeight: 600,
          fontSize: "0.9rem",
          color: status === "error" ? "#FF7575" : status === "success" ? "#00D4FF" : "rgba(200,215,230,0.9)",
        }}>
          {headline}
        </p>
        {sub && (
          <p style={{ marginTop: "0.4rem", fontSize: "0.78rem", color: "rgba(120,150,185,0.75)", lineHeight: 1.5 }}>
            {sub}
          </p>
        )}
        <p style={{ marginTop: "1rem", fontSize: "10px", color: "rgba(80,110,145,0.55)" }}>
          {status === "success"
            ? "Closing this window…"
            : status === "error"
            ? "This window will close automatically."
            : "Please wait…"}
        </p>
      </div>
    </div>
  );
}

export default function SalesforceCallbackPage() {
  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>
      <Suspense
        fallback={
          <div style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#000508",
            color: "rgba(30,144,255,0.6)",
            fontSize: "13px",
          }}>
            Loading…
          </div>
        }
      >
        <CallbackContent />
      </Suspense>
    </>
  );
}
