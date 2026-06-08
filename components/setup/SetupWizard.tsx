"use client";

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { OmnionMascot } from "@/components/auth/OmnionMascot";
import { EnvironmentSelector } from "@/components/auth/EnvironmentSelector";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { BrandLockup } from "@/components/brand/BrandLockup";
import Fireflies from "@/components/Fireflies";
import { type Environment } from "@/lib/utils";
import { saveSession, clearSession } from "@/lib/auth/session";
import { loadIdentity, markSetupComplete, clearIdentity, clearSetup } from "@/lib/auth/identity";

/* ── Eye toggle for secret fields ── */
function EyeButton({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="cursor-pointer"
      style={{ color: "rgba(120,150,185,0.6)" }}
      aria-label={show ? "Hide" : "Show"}
    >
      {show ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}

/* ── Labeled input ── */
function Field({
  label, value, onChange, type = "text", placeholder, isDark, mono = false, rightNode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  isDark: boolean;
  mono?: boolean;
  rightNode?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] font-medium tracking-widest uppercase"
        style={{ color: isDark ? "rgba(155,185,220,0.92)" : "rgba(0,31,91,0.72)" }}>
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`w-full rounded-xl py-2.5 pl-3.5 text-sm outline-none ${rightNode ? "pr-10" : "pr-3.5"} ${mono ? "font-mono text-[12px]" : ""}`}
          style={{
            background: isDark ? "rgba(0,0,0,0.22)" : "rgba(0,31,91,0.04)",
            border: focused
              ? "1px solid rgba(30,144,255,0.45)"
              : isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.12)",
            color: isDark ? "rgba(200,215,230,0.95)" : "#001F5B",
            boxShadow: focused ? "0 0 0 3px rgba(30,144,255,0.08)" : "none",
            transition: "border 0.2s, box-shadow 0.2s",
          }}
        />
        {rightNode && <div className="absolute right-3">{rightNode}</div>}
      </div>
    </div>
  );
}

/* ── Primary action button ── */
function PrimaryButton({
  label, loading, disabled, onClick,
}: {
  label: string; loading: boolean; disabled: boolean; onClick: () => void;
}) {
  const blocked = disabled || loading;
  return (
    <motion.button
      onClick={onClick}
      disabled={blocked}
      className="w-full rounded-xl py-3 px-5 text-sm font-semibold flex items-center justify-center gap-2.5 mt-1 text-white"
      style={{
        background: blocked
          ? "rgba(30,144,255,0.18)"
          : "linear-gradient(135deg, #1E90FF 0%, #0047AB 100%)",
        border: "1px solid rgba(30,144,255,0.4)",
        boxShadow: blocked ? "none" : "0 4px 20px rgba(30,144,255,0.28)",
        cursor: blocked ? "not-allowed" : "pointer",
        opacity: blocked ? 0.7 : 1,
      }}
      whileHover={blocked ? {} : { y: -1 }}
      whileTap={blocked ? {} : { scale: 0.99 }}
    >
      {loading ? "Working…" : label}
    </motion.button>
  );
}

/* ── Salesforce OAuth (SSO) button ── */
function SalesforceOAuthButton({
  env, loading, onClick,
}: {
  env: Environment; loading: boolean; onClick: () => void;
}) {
  const isProd = env === "production";
  return (
    <motion.button
      onClick={onClick}
      disabled={loading}
      className="w-full rounded-xl py-3 px-5 text-sm font-semibold flex items-center justify-center gap-2.5 text-white"
      style={{
        background: isProd
          ? "linear-gradient(135deg, #0070D6 0%, #00C875 125%)"
          : "linear-gradient(135deg, #1E90FF 0%, #F5A623 130%)",
        border: isProd ? "1px solid rgba(0,200,117,0.45)" : "1px solid rgba(245,166,35,0.5)",
        boxShadow: isProd ? "0 4px 20px rgba(0,200,117,0.28)" : "0 4px 20px rgba(245,166,35,0.3)",
        cursor: loading ? "wait" : "pointer",
        opacity: loading ? 0.8 : 1,
      }}
      whileHover={loading ? {} : { y: -1 }}
      whileTap={loading ? {} : { scale: 0.99 }}
    >
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none" aria-hidden>
        <path d="M20 36a8 8 0 0 1-2.83-15.47A10 10 0 0 1 36 18.4a6 6 0 0 1 .5 11.6H20z" fill="white" opacity="0.95" />
      </svg>
      {loading ? "Opening Salesforce…" : `Log in with Salesforce ${isProd ? "Production/Dev" : "Sandbox"}`}
    </motion.button>
  );
}

/* ── Step indicator ── */
function Steps({ step, isDark }: { step: number; isDark: boolean }) {
  const items = ["Connected App", "Salesforce", "AI Key"];
  return (
    <div className="flex items-center gap-2 mb-6">
      {items.map((label, i) => {
        const n = i + 1;
        const active = step === n;
        const done = step > n;
        return (
          <div key={label} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold"
                style={{
                  background: done || active ? "linear-gradient(135deg, #1E90FF, #0047AB)" : "transparent",
                  border: done || active ? "none" : "1px solid rgba(120,150,185,0.4)",
                  color: done || active ? "white" : "rgba(155,185,220,0.9)",
                }}
              >
                {done ? "✓" : n}
              </div>
              <span className="text-[12px] font-medium"
                style={{ color: active ? (isDark ? "white" : "#001F5B") : "rgba(155,185,220,0.9)" }}>
                {label}
              </span>
            </div>
            {i < items.length - 1 && (
              <div className="w-6 h-px" style={{ background: "rgba(120,150,185,0.3)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SETUP WIZARD — mandatory first-run setup
══════════════════════════════════════════════════════════ */
export function SetupWizard() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Step 1 — Salesforce
  const [env, setEnv] = useState<Environment>("sandbox");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showTokenFallback, setShowTokenFallback] = useState(false);
  const [sfUser, setSfUser] = useState("");

  // Step 1 — Connected App
  const [sfClientId, setSfClientId] = useState("");
  const [sfClientSecret, setSfClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [copied, setCopied] = useState(false);

  // Step 3 — Anthropic
  const [anthropicKey, setAnthropicKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [identityEmail, setIdentityEmail] = useState("");

  /* Require an app identity (signed-in team member) to be here. */
  useEffect(() => {
    const id = loadIdentity();
    if (!id) {
      router.replace("/login");
      return;
    }
    setIdentityEmail(id.email);
    // Skip the Connected App step if it's already configured for this browser.
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => { if (d.hasConnectedApp) setStep(2); })
      .catch(() => {});
  }, [router]);

  const saveConnectedApp = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sfClientId: sfClientId.trim(), sfClientSecret: sfClientSecret.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not save the Connected App credentials.");
        return;
      }
      setStep(2);
    } catch {
      setError("Network error. Could not save the Connected App credentials.");
    } finally {
      setLoading(false);
    }
  };

  const callbackUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/auth/callback/salesforce`
      : "/api/auth/callback/salesforce";

  const copyCallback = () => {
    try {
      navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const handleSignOut = () => {
    clearSession();
    clearIdentity();
    clearSetup();
    router.replace("/login");
  };

  const connectSalesforce = async () => {
    setError("");
    setLoading(true);
    const normalizedUrl = instanceUrl.trim().startsWith("http")
      ? instanceUrl.trim().replace(/\/$/, "")
      : `https://${instanceUrl.trim().replace(/\/$/, "")}`;

    try {
      const res = await fetch("/api/sf/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceUrl: normalizedUrl, accessToken: accessToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Connection failed. Verify your Instance URL and Access Token.");
        return;
      }
      const { user } = data;
      // Real token is in the httpOnly cookie; only metadata goes to localStorage.
      saveSession({
        accessToken: "[server-secured]",
        instanceUrl: user.instanceUrl,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        environment: user.environment,
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      });
      setSfUser(user.displayName ?? user.username);
      setStep(3);
    } catch {
      setError("Network error. Unable to reach the authentication server.");
    } finally {
      setLoading(false);
    }
  };

  /* Primary path — OAuth SSO via the Connected App. Opens a popup; the callback
     page posts the token back, which we hand to /api/sf/auth to set the cookie. */
  const connectWithOAuth = async () => {
    setError("");
    setLoading(true);
    let authUrl = "";
    try {
      const res = await fetch(`/api/auth/salesforce/url?environment=${env}`);
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Salesforce OAuth isn't configured yet. Add a Connected App, or use an access token below.");
        setLoading(false);
        return;
      }
      authUrl = data.url;
    } catch {
      setError("Network error. Could not start Salesforce sign-in.");
      setLoading(false);
      return;
    }

    const popup = window.open(authUrl, "sf-oauth", "width=600,height=720");
    let settled = false;
    let timer: ReturnType<typeof setInterval>;

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const msg = e.data;
      if (msg?.type === "SF_AUTH_SUCCESS" && msg.session) {
        settled = true;
        window.removeEventListener("message", onMessage);
        clearInterval(timer);
        try {
          const r = await fetch("/api/sf/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instanceUrl: msg.session.instanceUrl,
              accessToken: msg.session.accessToken,
              refreshToken: msg.session.refreshToken,
              environment: msg.session.environment,
            }),
          });
          const d = await r.json();
          if (!r.ok || !d.success) {
            setError(d.error ?? "Could not establish the Salesforce session.");
            setLoading(false);
            return;
          }
          saveSession({
            accessToken: "[server-secured]",
            instanceUrl: d.user.instanceUrl,
            userId: d.user.userId,
            username: d.user.username,
            displayName: d.user.displayName,
            email: d.user.email,
            environment: d.user.environment,
            expiresAt: Date.now() + 8 * 60 * 60 * 1000,
          });
          setSfUser(d.user.displayName ?? d.user.username);
          setLoading(false);
          setStep(3);
        } catch {
          setError("Network error completing Salesforce sign-in.");
          setLoading(false);
        }
      } else if (msg?.type === "SF_AUTH_ERROR") {
        settled = true;
        window.removeEventListener("message", onMessage);
        clearInterval(timer);
        setError(msg.error ?? "Salesforce sign-in failed.");
        setLoading(false);
      }
    };

    window.addEventListener("message", onMessage);
    timer = setInterval(() => {
      if (popup?.closed && !settled) {
        settled = true;
        clearInterval(timer);
        window.removeEventListener("message", onMessage);
        setLoading(false);
      }
    }, 600);
  };

  const saveKeyAndFinish = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anthropicApiKey: anthropicKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not save the API key.");
        return;
      }
      markSetupComplete();
      router.push("/dashboard");
    } catch {
      setError("Network error. Could not save the API key.");
    } finally {
      setLoading(false);
    }
  };

  const canConnect = instanceUrl.trim().length > 5 && accessToken.trim().length > 5;
  const canFinish = anthropicKey.trim().startsWith("sk-ant-");
  const canSaveApp = sfClientId.trim().length > 10 && sfClientSecret.trim().length > 10;

  return (
    <div
      className="relative min-h-screen w-full flex overflow-hidden"
      style={{
        background: isDark
          ? "linear-gradient(135deg, #000508 0%, #010918 50%, #000305 100%)"
          : "linear-gradient(135deg, #EEF3FF 0%, #F5F8FF 50%, #E4EDFF 100%)",
      }}
    >
      <div className="absolute top-5 right-5 z-50">
        <ThemeToggle size="md" />
      </div>

      {/* ══ LEFT PANEL — Brand ══ */}
      <div
        className="hidden lg:flex lg:w-1/2 lg:h-screen relative flex-col items-center justify-center overflow-hidden"
        style={{
          background: isDark
            ? "linear-gradient(160deg, #010B1E 0%, #000508 40%, #010B1E 100%)"
            : "linear-gradient(160deg, #1E4A88 0%, #0047AB 50%, #001F5B 100%)",
        }}
      >
        <div
          className="absolute right-0 top-0 bottom-0 w-px"
          style={{
            background: isDark
              ? "linear-gradient(180deg, transparent, rgba(30,144,255,0.3) 30%, rgba(30,144,255,0.3) 70%, transparent)"
              : "linear-gradient(180deg, transparent, rgba(255,255,255,0.2) 30%, rgba(255,255,255,0.2) 70%, transparent)",
          }}
        />
        <div className="relative z-10 flex flex-col items-center text-center px-10 max-w-lg">
          {/* Left panel is always dark — force the on-dark lockup */}
          <BrandLockup isDark height={72} className="mb-8" />
          <OmnionMascot size={240} mood="float" particleColor={isDark ? undefined : "#010B1E"} />
          <div className="text-[11px] font-medium tracking-widest uppercase mb-3 mt-2"
            style={{ color: "rgba(30,144,255,0.7)" }}>
            Almost there
          </div>
          <h1 className="text-4xl font-black mb-3"
            style={{ color: "white", letterSpacing: "-0.04em", lineHeight: 1.08 }}>
            Let&apos;s get you set up
          </h1>
          <p className="text-sm leading-relaxed"
            style={{ color: "rgba(160,184,216,0.7)" }}>
            Connect your Salesforce org and add your AI key. We&apos;ll remember these
            so every OmniVerse accelerator just works.
          </p>
        </div>
      </div>

      {/* ══ RIGHT PANEL — Wizard ══ */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-12 relative z-10 overflow-hidden">
        {/* Ambient fireflies behind the card */}
        <Fireflies
          className="z-0"
          color={isDark ? "#00D4FF" : "#84E04A"}
          glow={isDark ? "rgba(0, 181, 226, 0.55)" : "rgba(124, 224, 74, 0.7)"}
        />
        <motion.div
          className="w-full max-w-md relative z-10"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* OmniVerse brand header — fills the free space above the card */}
          <div className="text-center mb-6">
            <h1 className="text-4xl xl:text-5xl font-black"
              style={{
                letterSpacing: "-0.04em", lineHeight: 1.05,
                backgroundImage: isDark
                  ? "linear-gradient(100deg, #6FB8FF 0%, #34BEE6 34%, #19C7B6 64%, #5CEAC9 100%)"
                  : "linear-gradient(100deg, #16367E 0%, #1C56B8 26%, #1789B0 52%, #1CC3B0 76%, #3BDDAE 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                filter: "drop-shadow(0 6px 28px rgba(28,195,176,0.35))",
              }}>
              OmniVerse
            </h1>
            <div className="text-base xl:text-lg font-black mt-1"
              style={{
                letterSpacing: "-0.02em",
                backgroundImage: isDark
                  ? "linear-gradient(135deg, #1E90FF 0%, #00D4FF 60%, #3AABFF 100%)"
                  : "linear-gradient(135deg, #0052CC 0%, #0098C4 60%, #1789B0 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}>
              From Complexity. Into Clarity.
            </div>
          </div>

          {/* Identity row + sign out (escape back to login) */}
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-[11px] truncate" style={{ color: isDark ? "rgba(170,195,225,0.9)" : "rgba(0,31,91,0.7)" }}>
              {identityEmail ? `Signed in as ${identityEmail}` : ""}
            </span>
            <button
              onClick={handleSignOut}
              className="text-[11px] font-medium cursor-pointer hover:opacity-75 shrink-0 ml-3"
              style={{ color: "#3AABFF", textDecoration: "underline", textUnderlineOffset: "2px" }}
            >
              Sign out
            </button>
          </div>

          <div
            className="relative rounded-2xl overflow-hidden"
            style={{
              background: isDark ? "rgba(5,12,25,0.7)" : "rgba(255,255,255,0.9)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: isDark ? "1px solid rgba(30,144,255,0.18)" : "1px solid rgba(0,71,171,0.12)",
              boxShadow: isDark
                ? "0 24px 80px rgba(0,0,0,0.6)"
                : "0 24px 80px rgba(0,31,91,0.12)",
            }}
          >
            <div className="relative p-8 sm:p-10">
              <div className="lg:hidden">
                <BrandLockup isDark={isDark} height={44} />
                <div className="h-px my-6" style={{
                  background: isDark
                    ? "linear-gradient(90deg, transparent, rgba(30,144,255,0.15), transparent)"
                    : "linear-gradient(90deg, transparent, rgba(0,71,171,0.1), transparent)",
                }} />
              </div>
              <h2 className="text-2xl font-bold mb-1"
                style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                Setup
              </h2>
              <p className="text-sm mb-6" style={{ color: isDark ? "rgba(185,208,235,0.85)" : "rgba(0,31,91,0.62)" }}>
                Complete these to continue to the platform.
              </p>

              <Steps step={step} isDark={isDark} />

              <AnimatePresence mode="wait">
                {step === 1 ? (
                  <motion.div
                    key="step1"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col gap-4"
                  >
                    <p className="text-[12px] leading-relaxed" style={{ color: isDark ? "rgba(185,208,235,0.82)" : "rgba(0,31,91,0.62)" }}>
                      OmniVerse signs you into Salesforce through your own Connected App. Create one (~2 min) and paste its credentials below.
                    </p>

                    {/* Collapsible guide */}
                    <div className="rounded-xl overflow-hidden" style={{ border: isDark ? "1px solid rgba(30,144,255,0.14)" : "1px solid rgba(0,71,171,0.12)" }}>
                      <button
                        type="button"
                        onClick={() => setShowGuide((v) => !v)}
                        className="w-full flex items-center justify-between px-3.5 py-2.5 text-[12px] font-medium cursor-pointer"
                        style={{ color: isDark ? "rgba(170,195,225,0.9)" : "rgba(0,31,91,0.8)", background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.04)" }}
                      >
                        <span>How to create a Connected App</span>
                        <span style={{ transform: showGuide ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>⌄</span>
                      </button>
                      {showGuide && (
                        <div className="px-4 py-3 text-[12px] leading-relaxed flex flex-col gap-2" style={{ color: isDark ? "rgba(160,188,220,0.85)" : "rgba(0,31,91,0.72)" }}>
                          <ol className="list-decimal pl-4 flex flex-col gap-1.5">
                            <li>Salesforce → <b>Setup</b> → <b>App Manager</b> → <b>New Connected App</b>.</li>
                            <li>Enable <b>OAuth Settings</b>.</li>
                            <li>Set the <b>Callback URL</b> to the value below.</li>
                            <li>Add OAuth scopes: <b>api</b>, <b>refresh_token</b>, <b>openid</b>, <b>profile</b>, <b>email</b>.</li>
                            <li>Save, then copy the <b>Consumer Key</b> (Client ID) and <b>Consumer Secret</b>.</li>
                          </ol>
                          <div className="flex items-center gap-2 mt-1">
                            <code className="flex-1 truncate rounded-md px-2 py-1.5 text-[11px] font-mono" style={{ background: isDark ? "rgba(0,0,0,0.3)" : "rgba(0,31,91,0.06)", color: isDark ? "rgba(200,215,230,0.95)" : "#001F5B" }}>
                              {callbackUrl}
                            </code>
                            <button type="button" onClick={copyCallback} className="text-[11px] font-medium px-2.5 py-1.5 rounded-md cursor-pointer shrink-0" style={{ color: "#3AABFF", border: "1px solid rgba(30,144,255,0.3)" }}>
                              {copied ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <Field
                      label="Client ID (Consumer Key)"
                      value={sfClientId}
                      onChange={setSfClientId}
                      placeholder="3MVG…"
                      isDark={isDark}
                      mono
                    />
                    <Field
                      label="Client Secret (Consumer Secret)"
                      value={sfClientSecret}
                      onChange={setSfClientSecret}
                      type={showSecret ? "text" : "password"}
                      placeholder="••••••••"
                      isDark={isDark}
                      mono
                      rightNode={<EyeButton show={showSecret} onToggle={() => setShowSecret(!showSecret)} />}
                    />
                    <p className="text-[11px]" style={{ color: isDark ? "rgba(160,188,220,0.8)" : "rgba(0,31,91,0.6)" }}>
                      Stored securely server-side (httpOnly), never exposed to the browser.
                    </p>
                    {error && <p className="text-[12px]" style={{ color: "#FF7575" }}>{error}</p>}
                    <PrimaryButton
                      label="Save & Continue"
                      loading={loading}
                      disabled={!canSaveApp}
                      onClick={saveConnectedApp}
                    />
                    <button
                      type="button"
                      onClick={() => { setError(""); setShowTokenFallback(true); setStep(2); }}
                      className="text-[11px] cursor-pointer hover:opacity-75 self-center"
                      style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(74,106,160,0.6)", textDecoration: "underline", textUnderlineOffset: "2px" }}
                    >
                      Skip — connect with an access token instead
                    </button>
                  </motion.div>
                ) : step === 2 ? (
                  <motion.div
                    key="step2"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col gap-4"
                  >
                    <EnvironmentSelector value={env} onChange={setEnv} />

                    <SalesforceOAuthButton env={env} loading={loading} onClick={connectWithOAuth} />

                    {error && <p className="text-[12px]" style={{ color: "#FF7575" }}>{error}</p>}

                    <button
                      type="button"
                      onClick={() => { setError(""); setShowTokenFallback((v) => !v); }}
                      className="text-[12px] self-center cursor-pointer hover:opacity-80"
                      style={{ color: isDark ? "rgba(155,185,220,0.85)" : "rgba(0,71,171,0.7)", textDecoration: "underline", textUnderlineOffset: "2px" }}
                    >
                      {showTokenFallback ? "Hide access-token option" : "Use an access token instead"}
                    </button>

                    {showTokenFallback && (
                      <div className="flex flex-col gap-4 pt-1">
                        <Field
                          label="Instance URL"
                          value={instanceUrl}
                          onChange={setInstanceUrl}
                          placeholder="https://yourorg.my.salesforce.com"
                          isDark={isDark}
                        />
                        <Field
                          label="Access Token"
                          value={accessToken}
                          onChange={setAccessToken}
                          type={showToken ? "text" : "password"}
                          placeholder="00D…"
                          isDark={isDark}
                          mono
                          rightNode={<EyeButton show={showToken} onToggle={() => setShowToken(!showToken)} />}
                        />
                        <PrimaryButton
                          label="Validate & Connect"
                          loading={loading}
                          disabled={!canConnect}
                          onClick={connectSalesforce}
                        />
                      </div>
                    )}
                    <button
                      onClick={() => { setError(""); setStep(1); }}
                      className="text-[11px] cursor-pointer hover:opacity-75 self-center"
                      style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.55)", textDecoration: "underline", textUnderlineOffset: "2px" }}
                    >
                      Back to Connected App
                    </button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="step3"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.25 }}
                    className="flex flex-col gap-4"
                  >
                    <div
                      className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-[12px]"
                      style={{
                        background: "rgba(0,200,117,0.08)",
                        border: "1px solid rgba(0,200,117,0.25)",
                        color: "#00C875",
                      }}
                    >
                      <span>✓</span>
                      <span>Salesforce connected{sfUser ? ` — ${sfUser}` : ""}</span>
                    </div>
                    <Field
                      label="Anthropic API Key"
                      value={anthropicKey}
                      onChange={setAnthropicKey}
                      type={showKey ? "text" : "password"}
                      placeholder="sk-ant-…"
                      isDark={isDark}
                      mono
                      rightNode={<EyeButton show={showKey} onToggle={() => setShowKey(!showKey)} />}
                    />
                    <p className="text-[11px]" style={{ color: isDark ? "rgba(160,188,220,0.82)" : "rgba(0,31,91,0.6)" }}>
                      Used for AI generation. Stored securely server-side, never exposed to the browser.
                    </p>
                    {error && <p className="text-[12px]" style={{ color: "#FF7575" }}>{error}</p>}
                    <PrimaryButton
                      label="Save & Continue"
                      loading={loading}
                      disabled={!canFinish}
                      onClick={saveKeyAndFinish}
                    />
                    <button
                      onClick={() => { setError(""); setStep(2); }}
                      className="text-[11px] cursor-pointer hover:opacity-75 self-center"
                      style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.55)", textDecoration: "underline", textUnderlineOffset: "2px" }}
                    >
                      Back to Salesforce
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
