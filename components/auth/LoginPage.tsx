"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { OmnionMascot } from "./OmnionMascot";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { SalesforceButton } from "./SalesforceButton";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { type Environment } from "@/lib/utils";
import type { AuthStage, MascotMood, SessionData } from "@/lib/auth/types";
import { saveSession, loadSession } from "@/lib/auth/session";

/* ── TYPEWRITER HOOK ── */
function useTypewriter(words: string[], speed = 80, pause = 2200) {
  const [text, setText] = useState("");
  const [wordIndex, setWordIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const word = words[wordIndex];
    const timeout = setTimeout(() => {
      if (!deleting) {
        if (charIndex < word.length) {
          setText(word.slice(0, charIndex + 1));
          setCharIndex((c) => c + 1);
        } else {
          setTimeout(() => setDeleting(true), pause);
        }
      } else {
        if (charIndex > 0) {
          setText(word.slice(0, charIndex - 1));
          setCharIndex((c) => c - 1);
        } else {
          setDeleting(false);
          setWordIndex((i) => (i + 1) % words.length);
        }
      }
    }, deleting ? speed / 2 : speed);
    return () => clearTimeout(timeout);
  }, [charIndex, deleting, wordIndex, words, speed, pause]);

  return text;
}

/* ── GRID BACKGROUND ── */
function GridBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(30,144,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(30,144,255,0.06) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(rgba(30,144,255,0.14) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          backgroundPosition: "-1px -1px",
        }}
      />
      <motion.div
        className="absolute left-0 right-0 h-px pointer-events-none"
        style={{ background: "linear-gradient(90deg, transparent, rgba(30,144,255,0.5), transparent)" }}
        animate={{ top: ["-4px", "100%"] }}
        transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(30,144,255,0.18) 0%, transparent 60%), " +
            "radial-gradient(ellipse 50% 40% at 0% 100%, rgba(0,212,255,0.08) 0%, transparent 50%), " +
            "radial-gradient(ellipse 50% 40% at 100% 0%, rgba(0,71,171,0.07) 0%, transparent 50%)",
        }}
      />
    </div>
  );
}

/* ── ORBIT PARTICLE ── */
function OrbitParticle({ radius, duration, delay, color, size = 3 }: {
  radius: number; duration: number; delay: number; color: string; size?: number;
}) {
  return (
    <motion.div
      className="absolute rounded-full top-1/2 left-1/2"
      style={{
        width: size, height: size,
        background: color,
        boxShadow: `0 0 ${size * 3}px ${color}`,
        x: radius, y: 0,
        transformOrigin: `-${radius}px 0px`,
      }}
      animate={{ rotate: 360 }}
      transition={{ duration, repeat: Infinity, ease: "linear", delay }}
    />
  );
}

/* ── FEATURE PILL ── */
function FeaturePill({ icon, label, delay = 0 }: { icon: string; label: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
      style={{
        background: "rgba(30,144,255,0.08)",
        border: "1px solid rgba(30,144,255,0.2)",
        color: "rgba(160,184,216,0.9)",
        backdropFilter: "blur(8px)",
      }}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </motion.div>
  );
}

/* ── OMNICLOUD LOGO ── */
function OmnicloudLogo({ dark = true }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <svg width="36" height="30" viewBox="0 0 36 30" fill="none">
        <defs>
          <linearGradient id="login-lg" x1="0" y1="0" x2="36" y2="30" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3AABFF" />
            <stop offset="60%" stopColor="#1E90FF" />
            <stop offset="100%" stopColor="#0047AB" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="16" r="8" fill="url(#login-lg)" />
        <circle cx="22" cy="13" r="9" fill="url(#login-lg)" />
        <circle cx="30" cy="17" r="7" fill="url(#login-lg)" />
        <ellipse cx="21" cy="21" rx="15" ry="6" fill="url(#login-lg)" />
        <circle cx="22" cy="7" r="3" fill="white" opacity="0.9" />
        <circle cx="22" cy="7" r="1.5" fill="#0047AB" />
      </svg>
      <div className="flex flex-col leading-none">
        <span
          className="text-xl font-bold tracking-tight"
          style={{ color: dark ? "white" : "#001F5B", letterSpacing: "-0.03em" }}
        >
          Omnicloud
        </span>
        <span
          className="text-[10px] font-medium tracking-widest uppercase"
          style={{ color: dark ? "rgba(30,144,255,0.8)" : "#0047AB", letterSpacing: "0.12em" }}
        >
          AI Platform
        </span>
      </div>
    </div>
  );
}

/* ── SYSTEM STATUS ── */
function SystemStatus() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 1.8, duration: 0.4 }}
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px]"
      style={{
        background: "rgba(0,200,117,0.08)",
        border: "1px solid rgba(0,200,117,0.2)",
        color: "rgba(0,200,117,0.8)",
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: "#00C875", boxShadow: "0 0 6px rgba(0,200,117,0.8)", animation: "pulse 2s infinite" }}
      />
      All systems operational
    </motion.div>
  );
}

/* ── SCANLINE HEX STREAM ── */
function ScanlineStream({ color }: { color: string }) {
  const HEX = "0123456789ABCDEF";
  const [chars, setChars] = useState<string[]>([]);

  useEffect(() => {
    setChars(Array.from({ length: 28 }, () => HEX[Math.floor(Math.random() * 16)]));
    const t = setInterval(() => {
      setChars((prev) =>
        prev.map((c) => (Math.random() > 0.72 ? HEX[Math.floor(Math.random() * 16)] : c))
      );
    }, 90);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="font-mono text-[9px] tracking-wider select-none" style={{ color, opacity: 0.25 }}>
      {chars.join(" ")}
    </div>
  );
}

/* ── TERMINAL LOG LINE ── */
function TerminalLine({ text, delay, color, isDark }: {
  text: string; delay: number; color: string; isDark: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.22, ease: "easeOut" }}
      className="flex items-center gap-2"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
        <path d="M1 4.5l2.5 2.5 4.5-5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="font-mono text-[10px]" style={{ color: isDark ? "rgba(140,170,200,0.7)" : "rgba(0,31,91,0.55)" }}>
        {text}
      </span>
    </motion.div>
  );
}

/* ── DUMMY AUTH FLOW ── */
function DummyAuthFlow({
  phase,
  environment,
  isDark,
  onCancel,
}: {
  phase: "connecting" | "authenticating";
  environment: Environment;
  isDark: boolean;
  onCancel: () => void;
}) {
  const isProduction = environment === "production";
  const accentColor  = isProduction ? "#0070D6" : "#1E90FF";
  const accentColor2 = isProduction ? "#00C875" : "#00D4FF";

  const connectingLines  = ["INIT_OAUTH_2_FLOW", "TLS_1_3_HANDSHAKE_OK", "RESOLVE_IDP_ENDPOINT", "ENDPOINT_DISCOVERED"];
  const authLines        = ["VERIFY_CLIENT_CREDENTIALS", "SCOPE_GRANTED [api refresh_token]", "ESTABLISH_ENCRYPTED_SESSION", "SESSION_ACTIVE"];
  const lines            = phase === "connecting" ? connectingLines : authLines;
  const progressStart    = phase === "connecting" ? 0 : 46;
  const progressTarget   = phase === "connecting" ? 46 : 90;
  const headline         = phase === "connecting" ? "Connecting to Salesforce…" : "Authenticating…";
  const subline          = phase === "connecting"
    ? `Establishing secure channel to ${isProduction ? "Production" : "Sandbox"}`
    : "Verifying identity and establishing session";

  return (
    <motion.div
      key={phase}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center gap-4 py-2"
    >
      {/* SF icon — rotating dashed ring + pulsing rings + breathing glow */}
      <div className="relative flex items-center justify-center" style={{ width: 80, height: 80 }}>
        <motion.div
          className="absolute"
          style={{ width: 76, height: 76, borderRadius: "50%", border: `1px dashed ${accentColor}45` }}
          animate={{ rotate: 360 }}
          transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
        />
        {[0, 1].map((i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{ width: 58 + i * 14, height: 58 + i * 14, border: `1px solid ${accentColor}` }}
            animate={{ scale: [1, 1.38 + i * 0.14], opacity: [0.45, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.5, ease: "easeOut" }}
          />
        ))}
        <motion.div
          className="relative z-10 w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: `${accentColor}15`, border: `1px solid ${accentColor}32`, backdropFilter: "blur(8px)" }}
          animate={{ boxShadow: [`0 0 12px ${accentColor}20`, `0 0 28px ${accentColor}50`, `0 0 12px ${accentColor}20`] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
            <path d="M20 36a8 8 0 0 1-2.83-15.47A10 10 0 0 1 36 18.4a6 6 0 0 1 .5 11.6H20z" fill={accentColor} opacity="0.9" />
          </svg>
        </motion.div>
      </div>

      {/* Status */}
      <div className="text-center">
        <p className="text-sm font-semibold" style={{ color: isDark ? "rgba(200,215,230,0.95)" : "#001F5B" }}>
          {headline}
        </p>
        <motion.p
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
          className="text-xs mt-0.5"
          style={{ color: isDark ? "rgba(90,122,154,0.65)" : "rgba(0,31,91,0.45)" }}
        >
          {subline}
        </motion.p>
      </div>

      {/* Terminal log */}
      <div
        className="w-full rounded-xl p-3 flex flex-col gap-2"
        style={{ background: isDark ? "rgba(0,0,0,0.28)" : "rgba(0,31,91,0.04)", border: `1px solid ${accentColor}18` }}
      >
        <ScanlineStream color={accentColor} />
        <div className="flex flex-col gap-1.5 mt-1">
          {lines.map((line, i) => (
            <TerminalLine key={line} text={line} delay={0.12 + i * 0.42} color={accentColor} isDark={isDark} />
          ))}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-mono" style={{ color: isDark ? "rgba(90,122,154,0.55)" : "rgba(0,31,91,0.38)" }}>
            {phase === "connecting" ? "ESTABLISHING CONNECTION" : "VERIFYING IDENTITY"}
          </span>
          <motion.span
            className="text-[10px] font-mono font-semibold"
            style={{ color: accentColor }}
            animate={{ opacity: [1, 0.45, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          >
            {progressTarget}%
          </motion.span>
        </div>
        <div className="w-full h-1 rounded-full overflow-hidden"
          style={{ background: isDark ? "rgba(30,144,255,0.08)" : "rgba(0,71,171,0.07)" }}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor2})`, boxShadow: `0 0 8px ${accentColor}55` }}
            initial={{ width: `${progressStart}%` }}
            animate={{ width: `${progressTarget}%` }}
            transition={{ duration: 1.7, ease: "easeInOut" }}
          />
        </div>
      </div>

      <button
        onClick={onCancel}
        className="text-[11px] cursor-pointer transition-opacity hover:opacity-75"
        style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)", textDecoration: "underline", textUnderlineOffset: "2px" }}
      >
        Cancel
      </button>
    </motion.div>
  );
}

/* ── SUCCESS STATE ── */
function AuthSuccess({ username, isDark }: { username: string; isDark: boolean }) {
  return (
    <motion.div
      key="success"
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center text-center gap-3 py-3"
    >
      <motion.div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{
          background: "rgba(0,200,117,0.1)",
          border: "1.5px solid rgba(0,200,117,0.35)",
          boxShadow: "0 0 20px rgba(0,200,117,0.15)",
        }}
        initial={{ scale: 0, rotate: -20 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.05 }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <motion.path
            d="M5 12l5 5 9-11"
            stroke="#00C875"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, delay: 0.2, ease: "easeOut" }}
          />
        </svg>
      </motion.div>

      <div>
        <p className="font-semibold text-sm" style={{ color: isDark ? "white" : "#001F5B" }}>
          Signed in successfully
        </p>
        <p className="text-xs mt-0.5" style={{ color: isDark ? "rgba(0,200,117,0.85)" : "#007A54" }}>
          {username}
        </p>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="text-[10px] font-mono"
        style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.35)" }}
      >
        Redirecting to Omnicloud…
      </motion.p>
    </motion.div>
  );
}

/* ── ERROR BANNER ── */
function AuthError({ error, isDark }: { error: string; isDark: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-xl px-4 py-3 flex items-start gap-2.5"
      style={{ background: "rgba(232,68,68,0.08)", border: "1px solid rgba(232,68,68,0.2)" }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="#E84444" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span className="text-xs" style={{ color: isDark ? "#FF7575" : "#C2392B" }}>{error}</span>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════
   DEVELOPER CONNECTION — TYPES & DATA
══════════════════════════════════════════════════════════ */
type DevTab = "cli" | "token" | "password";

interface CliOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  environment: "sandbox" | "production";
  isDefault: boolean;
}

const MOCK_CLI_ORGS: CliOrg[] = [
  {
    alias: "omnicloud-dev",
    username: "admin@omnicloud.io.dev",
    instanceUrl: "https://omnicloud--dev.sandbox.my.salesforce.com",
    environment: "sandbox",
    isDefault: true,
  },
  {
    alias: "omnicloud-staging",
    username: "admin@omnicloud.io.staging",
    instanceUrl: "https://omnicloud--staging.sandbox.my.salesforce.com",
    environment: "sandbox",
    isDefault: false,
  },
  {
    alias: "omnicloud-prod",
    username: "admin@omnicloud.io",
    instanceUrl: "https://omnicloud.my.salesforce.com",
    environment: "production",
    isDefault: false,
  },
];

/* ── DEV FIELD INPUT ── */
function DevField({
  label, value, onChange, type = "text", placeholder, isDark, icon, rightNode, mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  isDark: boolean;
  icon?: React.ReactNode;
  rightNode?: React.ReactNode;
  mono?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <label
        className="text-[10px] font-medium tracking-widest uppercase"
        style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(74,106,160,0.6)" }}
      >
        {label}
      </label>
      <div className="relative flex items-center">
        {icon && (
          <div
            className="absolute left-3 pointer-events-none"
            style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)" }}
          >
            {icon}
          </div>
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`w-full rounded-xl py-2.5 text-sm outline-none ${icon ? "pl-9" : "pl-3.5"} ${rightNode ? "pr-10" : "pr-3.5"} ${mono ? "font-mono text-[12px]" : ""}`}
          style={{
            background: isDark ? "rgba(0,0,0,0.22)" : "rgba(0,31,91,0.04)",
            border: focused
              ? "1px solid rgba(30,144,255,0.45)"
              : isDark
              ? "1px solid rgba(30,144,255,0.12)"
              : "1px solid rgba(0,71,171,0.12)",
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

/* ── EYE TOGGLE ── */
function EyeButton({ show, onToggle, isDark }: { show: boolean; onToggle: () => void; isDark: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="cursor-pointer"
      style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.5)" }}
    >
      {show ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}

/* ── DEV CONNECT BUTTON ── */
function DevConnectBtn({
  label, disabled, onClick, accentColor = "#1E90FF", accentColor2 = "#0047AB",
}: {
  label: string; disabled: boolean; onClick: () => void;
  accentColor?: string; accentColor2?: string;
}) {
  return (
    <motion.button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl py-3 px-5 text-sm font-semibold flex items-center justify-center gap-2.5 mt-1"
      style={{
        background: disabled
          ? "rgba(30,144,255,0.06)"
          : `linear-gradient(135deg, ${accentColor} 0%, ${accentColor2} 100%)`,
        border: disabled
          ? "1px solid rgba(30,144,255,0.1)"
          : `1px solid ${accentColor}55`,
        color: disabled ? "rgba(90,122,154,0.4)" : "white",
        boxShadow: disabled ? "none" : `0 4px 20px ${accentColor}28, inset 0 1px 0 rgba(255,255,255,0.08)`,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.22s",
      }}
      whileHover={disabled ? {} : { y: -1, boxShadow: `0 6px 28px ${accentColor}40, inset 0 1px 0 rgba(255,255,255,0.1)` }}
      whileTap={disabled ? {} : { y: 0, scale: 0.99 }}
    >
      {label}
      {!disabled && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      )}
    </motion.button>
  );
}

/* ── DEV TAB STRIP ── */
function DevTabStrip({ active, onChange, isDark }: {
  active: DevTab; onChange: (t: DevTab) => void; isDark: boolean;
}) {
  const tabs: { id: DevTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "cli",
      label: "SF CLI",
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ),
    },
    {
      id: "token",
      label: "Access Token",
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
    },
    {
      id: "password",
      label: "Username",
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
      ),
    },
  ];

  return (
    <div
      className="flex rounded-xl p-1 gap-1"
      style={{
        background: isDark ? "rgba(0,0,0,0.28)" : "rgba(0,31,91,0.04)",
        border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.1)",
      }}
    >
      {tabs.map((tab) => (
        <motion.button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className="relative flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-medium cursor-pointer"
          style={{
            color: active === tab.id
              ? isDark ? "white" : "#001F5B"
              : isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.5)",
          }}
          whileTap={{ scale: 0.97 }}
        >
          {active === tab.id && (
            <motion.div
              layoutId="dev-tab-indicator"
              className="absolute inset-0 rounded-lg"
              style={{
                background: isDark ? "rgba(30,144,255,0.12)" : "rgba(0,71,171,0.08)",
                border: isDark ? "1px solid rgba(30,144,255,0.22)" : "1px solid rgba(0,71,171,0.14)",
              }}
              transition={{ type: "spring", stiffness: 500, damping: 35 }}
            />
          )}
          <span className="relative z-10 flex items-center gap-1.5">
            {tab.icon}
            {tab.label}
          </span>
        </motion.button>
      ))}
    </div>
  );
}

/* ── CLI TAB CONTENT ── */
function CLITabContent({
  orgs, selected, onSelect, scanning, onScan, onConnect, isDark,
}: {
  orgs: CliOrg[]; selected: string; onSelect: (a: string) => void;
  scanning: boolean; onScan: () => void; onConnect: () => void; isDark: boolean;
}) {
  return (
    <motion.div
      key="cli"
      initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-medium"
            style={{ color: isDark ? "rgba(160,184,216,0.75)" : "rgba(0,31,91,0.65)" }}>
            Authenticated CLI Orgs
          </p>
          <p className="text-[10px] font-mono mt-0.5"
            style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.4)" }}>
            sf auth list · {orgs.length} detected
          </p>
        </div>
        <motion.button
          onClick={onScan}
          disabled={scanning}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer"
          style={{
            color: isDark ? "rgba(30,144,255,0.8)" : "#0047AB",
            border: isDark ? "1px solid rgba(30,144,255,0.2)" : "1px solid rgba(0,71,171,0.15)",
            background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.04)",
          }}
          whileHover={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.07)" }}
          whileTap={{ scale: 0.95 }}
        >
          <motion.svg
            width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
            animate={scanning ? { rotate: 360 } : { rotate: 0 }}
            transition={scanning ? { duration: 0.8, repeat: Infinity, ease: "linear" } : { duration: 0 }}
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </motion.svg>
          {scanning ? "Scanning…" : "Refresh"}
        </motion.button>
      </div>

      <div className="flex flex-col gap-1.5">
        {orgs.map((org) => (
          <motion.button
            key={org.alias}
            onClick={() => onSelect(org.alias)}
            className="flex items-center gap-3 p-3 rounded-xl text-left w-full cursor-pointer"
            style={{
              background: selected === org.alias
                ? isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.06)"
                : isDark ? "rgba(0,0,0,0.18)" : "rgba(0,31,91,0.03)",
              border: selected === org.alias
                ? isDark ? "1px solid rgba(30,144,255,0.28)" : "1px solid rgba(0,71,171,0.22)"
                : isDark ? "1px solid rgba(30,144,255,0.07)" : "1px solid rgba(0,71,171,0.07)",
              transition: "background 0.18s, border 0.18s",
            }}
            whileHover={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.05)" }}
          >
            <div
              className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center"
              style={{
                border: selected === org.alias
                  ? "1.5px solid #1E90FF"
                  : isDark ? "1.5px solid rgba(90,122,154,0.4)" : "1.5px solid rgba(74,106,160,0.3)",
              }}
            >
              {selected === org.alias && (
                <div className="w-2 h-2 rounded-full" style={{ background: "#1E90FF" }} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] font-semibold font-mono"
                  style={{ color: isDark ? "rgba(200,215,230,0.9)" : "#001F5B" }}>
                  {org.alias}
                </span>
                {org.isDefault && (
                  <span className="text-[8px] px-1.5 py-0.5 rounded font-medium"
                    style={{
                      background: "rgba(30,144,255,0.1)", color: "rgba(30,144,255,0.8)",
                      border: "1px solid rgba(30,144,255,0.18)",
                    }}>
                    DEFAULT
                  </span>
                )}
                <span className="text-[8px] px-1.5 py-0.5 rounded font-medium ml-auto"
                  style={{
                    background: org.environment === "production" ? "rgba(0,200,117,0.1)" : "rgba(30,144,255,0.08)",
                    color: org.environment === "production" ? "#00C875" : "#3AABFF",
                    border: org.environment === "production" ? "1px solid rgba(0,200,117,0.2)" : "1px solid rgba(30,144,255,0.15)",
                  }}>
                  {org.environment}
                </span>
              </div>
              <p className="text-[9px] mt-0.5 font-mono truncate"
                style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)" }}>
                {org.username}
              </p>
            </div>
          </motion.button>
        ))}
      </div>

      <DevConnectBtn
        label="Connect via Salesforce CLI"
        disabled={!selected}
        onClick={onConnect}
        accentColor="#1E90FF"
        accentColor2="#0047AB"
      />
    </motion.div>
  );
}

/* ── ACCESS TOKEN TAB CONTENT ── */
function TokenTabContent({
  instanceUrl, setInstanceUrl, token, setToken,
  showToken, setShowToken, onConnect, error, isDark,
}: {
  instanceUrl: string; setInstanceUrl: (v: string) => void;
  token: string; setToken: (v: string) => void;
  showToken: boolean; setShowToken: (v: boolean) => void;
  onConnect: () => void; error: string; isDark: boolean;
}) {
  const canConnect = instanceUrl.trim().length > 5 && token.trim().length > 5;
  return (
    <motion.div
      key="token"
      initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-3"
    >
      <p className="text-[11px]"
        style={{ color: isDark ? "rgba(160,184,216,0.6)" : "rgba(0,31,91,0.5)" }}>
        Connect using an existing Salesforce session token. Tokens expire after the org session timeout.
      </p>
      <DevField
        label="Instance URL"
        value={instanceUrl} onChange={setInstanceUrl}
        placeholder="https://yourorg.my.salesforce.com"
        isDark={isDark}
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        }
      />
      <DevField
        label="Access Token"
        value={token} onChange={setToken}
        type={showToken ? "text" : "password"}
        placeholder="00D…"
        isDark={isDark} mono
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        }
        rightNode={<EyeButton show={showToken} onToggle={() => setShowToken(!showToken)} isDark={isDark} />}
      />
      {error && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="text-[11px]" style={{ color: "#FF7575" }}>
          {error}
        </motion.p>
      )}
      <DevConnectBtn
        label="Validate & Connect"
        disabled={!canConnect}
        onClick={onConnect}
        accentColor="#0052CC"
        accentColor2="#0070D6"
      />
    </motion.div>
  );
}

/* ── USERNAME & PASSWORD TAB CONTENT ── */
function PasswordTabContent({
  username, setUsername, password, setPassword, showPassword, setShowPassword,
  securityToken, setSecurityToken, sfEnv, setSfEnv, onConnect, error, isDark,
}: {
  username: string; setUsername: (v: string) => void;
  password: string; setPassword: (v: string) => void;
  showPassword: boolean; setShowPassword: (v: boolean) => void;
  securityToken: string; setSecurityToken: (v: string) => void;
  sfEnv: "sandbox" | "production"; setSfEnv: (e: "sandbox" | "production") => void;
  onConnect: () => void; error: string; isDark: boolean;
}) {
  const canConnect = username.trim().length > 3 && password.trim().length > 3;
  return (
    <motion.div
      key="password"
      initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-3"
    >
      <DevField
        label="Username"
        value={username} onChange={setUsername}
        placeholder="admin@yourorg.io"
        isDark={isDark}
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        }
      />
      <DevField
        label="Password"
        value={password} onChange={setPassword}
        type={showPassword ? "text" : "password"}
        placeholder="••••••••••••"
        isDark={isDark}
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        }
        rightNode={<EyeButton show={showPassword} onToggle={() => setShowPassword(!showPassword)} isDark={isDark} />}
      />
      <DevField
        label="Security Token (optional)"
        value={securityToken} onChange={setSecurityToken}
        placeholder="ABC123XYZ"
        isDark={isDark} mono
        icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        }
      />
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-medium tracking-widest uppercase"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(74,106,160,0.6)" }}>
          Environment
        </label>
        <div className="flex gap-2">
          {(["sandbox", "production"] as const).map((env) => (
            <button
              key={env}
              onClick={() => setSfEnv(env)}
              className="flex-1 py-2 rounded-xl text-[11px] font-medium capitalize cursor-pointer"
              style={{
                background: sfEnv === env
                  ? env === "production" ? "rgba(0,200,117,0.12)" : "rgba(30,144,255,0.1)"
                  : isDark ? "rgba(0,0,0,0.2)" : "rgba(0,31,91,0.03)",
                border: sfEnv === env
                  ? env === "production" ? "1px solid rgba(0,200,117,0.3)" : "1px solid rgba(30,144,255,0.28)"
                  : isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.08)",
                color: sfEnv === env
                  ? env === "production" ? "#00C875" : "#3AABFF"
                  : isDark ? "rgba(90,122,154,0.55)" : "rgba(74,106,160,0.5)",
                transition: "all 0.18s",
              }}
            >
              {env}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="text-[11px]" style={{ color: "#FF7575" }}>
          {error}
        </motion.p>
      )}
      <DevConnectBtn
        label={`Connect to ${sfEnv === "production" ? "Production" : "Sandbox"}`}
        disabled={!canConnect}
        onClick={onConnect}
        accentColor={sfEnv === "production" ? "#0070D6" : "#0052CC"}
        accentColor2={sfEnv === "production" ? "#00C875" : "#0070D6"}
      />
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN LOGIN PAGE
══════════════════════════════════════════════════════════ */
export function LoginPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [environment, setEnvironment] = useState<Environment>("sandbox");
  const [authStage, setAuthStage] = useState<AuthStage>("idle");
  const [authError, setAuthError] = useState("");
  const [successUser, setSuccessUser] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  // Dev connection state
  const [connectEnv, setConnectEnv] = useState<"sandbox" | "production">("sandbox");
  const [devTab, setDevTab] = useState<DevTab>("cli");
  const [selectedCliOrg, setSelectedCliOrg] = useState("omnicloud-dev");
  const [cliScanning, setCliScanning] = useState(false);
  const [tokenInstanceUrl, setTokenInstanceUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [sfUsername, setSfUsername] = useState("");
  const [sfPassword, setSfPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [sfSecurityToken, setSfSecurityToken] = useState("");
  const [sfEnv, setSfEnv] = useState<"sandbox" | "production">("sandbox");
  const [devError, setDevError] = useState("");

  const cancelRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dynamicWords = ["Revenue Cloud", "Enterprise AI", "Omnicloud OS", "Intelligent CRM", "Next-Gen CPQ"];
  const typeText = useTypewriter(dynamicWords, 75, 2000);

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rotateX = useTransform(mouseY, [-300, 300], [4, -4]);
  const rotateY = useTransform(mouseX, [-300, 300], [-4, 4]);

  /* Restore existing session on mount */
  useEffect(() => {
    const s = loadSession();
    if (s) router.replace("/dashboard");
  }, [router]);

  /* Cleanup timers on unmount */
  useEffect(() => {
    return () => cancelRef.current.forEach(clearTimeout);
  }, []);

  const clearDummyTimers = () => {
    cancelRef.current.forEach(clearTimeout);
    cancelRef.current = [];
  };

  /* Dummy flow — simulates OAuth visually without a real network call */
  const handleSFLogin = () => {
    clearDummyTimers();
    setAuthError("");
    setConnectEnv(environment);
    setIsFetchingUrl(true);

    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(setTimeout(() => {
      setIsFetchingUrl(false);
      setAuthStage("popup"); // "popup" = connecting phase
    }, 380));

    timers.push(setTimeout(() => {
      setAuthStage("loading"); // "loading" = authenticating phase
    }, 380 + 2100));

    timers.push(setTimeout(() => {
      const displayName = environment === "production" ? "Omnicloud Admin" : "Omnicloud Dev";
      saveSession({
        accessToken:  `demo_${environment}_${Date.now()}`,
        instanceUrl:  environment === "production"
          ? "https://omnicloud.my.salesforce.com"
          : "https://omnicloud--dev.sandbox.my.salesforce.com",
        userId:       `005DEMO${Date.now()}`,
        username:     environment === "production" ? "admin@omnicloud.io" : "admin@omnicloud.io.sandbox",
        displayName,
        email:        "admin@omnicloud.io",
        environment,
        expiresAt:    Date.now() + 24 * 60 * 60 * 1000,
      });
      setSuccessUser(displayName);
      setAuthStage("success");
    }, 380 + 2100 + 2300));

    timers.push(setTimeout(() => {
      router.push("/dashboard");
    }, 380 + 2100 + 2300 + 1900));

    cancelRef.current = timers;
  };

  const handleCancelDummy = () => {
    clearDummyTimers();
    setIsFetchingUrl(false);
    setAuthStage("idle");
  };

  const handleCliScan = () => {
    setCliScanning(true);
    setTimeout(() => setCliScanning(false), 1400);
  };

  /* Real Salesforce auth — calls /api/sf/auth, sets HTTP-only session cookie */
  const handleTokenConnect = async () => {
    setDevError("");
    setIsFetchingUrl(true);

    const normalizedUrl = tokenInstanceUrl.trim().startsWith("http")
      ? tokenInstanceUrl.trim().replace(/\/$/, "")
      : `https://${tokenInstanceUrl.trim().replace(/\/$/, "")}`;

    const env: "sandbox" | "production" =
      normalizedUrl.toLowerCase().includes("sandbox") ||
      normalizedUrl.toLowerCase().includes("test.")
        ? "sandbox"
        : "production";

    setConnectEnv(env);
    setAuthStage("popup");
    setIsFetchingUrl(false);

    try {
      const res = await fetch("/api/sf/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceUrl: normalizedUrl, accessToken: accessToken.trim() }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setAuthStage("idle");
        setDevError(data.error ?? "Connection failed. Verify your Instance URL and Access Token.");
        return;
      }

      const { user } = data;
      setConnectEnv(user.environment);
      setAuthStage("loading");

      // Real token lives in the HTTP-only cookie set by the API.
      // Only non-sensitive metadata goes to localStorage.
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

      setSuccessUser(user.displayName ?? user.username);
      await new Promise((r) => setTimeout(r, 1200));
      setAuthStage("success");
      await new Promise((r) => setTimeout(r, 1800));
      router.push("/dashboard");
    } catch {
      setAuthStage("idle");
      setDevError("Network error. Unable to reach the authentication server.");
    }
  };

  /* CLI & Password tabs remain mock (CLI requires native bridge; Password auth disallowed by security policy) */
  const handleDevConnectMock = (method: "cli" | "password") => {
    setDevError("");
    clearDummyTimers();
    setIsFetchingUrl(true);

    const capturedCliOrg = MOCK_CLI_ORGS.find((o) => o.alias === selectedCliOrg) ?? MOCK_CLI_ORGS[0];
    const capturedUsername = sfUsername;
    const capturedSfEnv = sfEnv;

    const env: "sandbox" | "production" =
      method === "cli" ? capturedCliOrg.environment : capturedSfEnv;
    setConnectEnv(env);

    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => { setIsFetchingUrl(false); setAuthStage("popup"); }, 300));
    timers.push(setTimeout(() => { setAuthStage("loading"); }, 300 + 2100));
    timers.push(setTimeout(() => {
      const session: Parameters<typeof saveSession>[0] =
        method === "cli"
          ? {
              accessToken: `cli_demo_${Date.now()}`,
              instanceUrl: capturedCliOrg.instanceUrl,
              userId: `005CLI${Date.now()}`,
              username: capturedCliOrg.username,
              displayName: capturedCliOrg.alias,
              email: capturedCliOrg.username,
              environment: capturedCliOrg.environment,
              expiresAt: Date.now() + 8 * 60 * 60 * 1000,
            }
          : {
              accessToken: `pwd_demo_${Date.now()}`,
              instanceUrl: capturedSfEnv === "production"
                ? "https://login.salesforce.com"
                : "https://test.salesforce.com",
              userId: `005USR${Date.now()}`,
              username: capturedUsername,
              displayName: capturedUsername.split("@")[0],
              email: capturedUsername,
              environment: capturedSfEnv,
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            };
      saveSession(session);
      setSuccessUser(session.displayName ?? session.username);
      setAuthStage("success");
    }, 300 + 2100 + 2300));
    timers.push(setTimeout(() => { router.push("/dashboard"); }, 300 + 2100 + 2300 + 1900));
    cancelRef.current = timers;
  };

  const handleDevConnect = (method: DevTab) => {
    if (method === "token") {
      handleTokenConnect();
    } else {
      handleDevConnectMock(method);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left - rect.width / 2);
    mouseY.set(e.clientY - rect.top - rect.height / 2);
  };

  const mascotMood: MascotMood =
    authStage === "popup" || authStage === "loading"
      ? "thinking"
      : authStage === "success"
      ? "success"
      : authStage === "error"
      ? "error"
      : "float";

  const showSSOSection = authStage === "idle" || authStage === "error";

  return (
    <div
      className="relative min-h-screen w-full flex overflow-hidden"
      style={{
        background: isDark
          ? "linear-gradient(135deg, #000508 0%, #010918 50%, #000305 100%)"
          : "linear-gradient(135deg, #EEF3FF 0%, #F5F8FF 50%, #E4EDFF 100%)",
      }}
    >
      {/* THEME TOGGLE */}
      <motion.div
        className="absolute top-5 right-5 z-50"
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <ThemeToggle size="md" />
      </motion.div>

      {/* ══ LEFT PANEL — Brand / Mascot ══ */}
      <motion.div
        className="hidden lg:flex lg:w-[52%] xl:w-[55%] relative flex-col items-center justify-center overflow-hidden"
        onMouseMove={handleMouseMove}
        style={{
          background: isDark
            ? "linear-gradient(160deg, #010B1E 0%, #000508 40%, #010B1E 100%)"
            : "linear-gradient(160deg, #1E4A88 0%, #0047AB 50%, #001F5B 100%)",
        }}
        initial={{ x: -40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      >
        <GridBackground />

        <div
          className="absolute right-0 top-0 bottom-0 w-px"
          style={{
            background: isDark
              ? "linear-gradient(180deg, transparent, rgba(30,144,255,0.3) 30%, rgba(30,144,255,0.3) 70%, transparent)"
              : "linear-gradient(180deg, transparent, rgba(255,255,255,0.2) 30%, rgba(255,255,255,0.2) 70%, transparent)",
          }}
        />

        <motion.div
          className="absolute top-6 left-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
        >
          <div
            className="text-[11px] font-mono px-2.5 py-1 rounded-md"
            style={{
              background: "rgba(30,144,255,0.1)",
              border: "1px solid rgba(30,144,255,0.2)",
              color: "rgba(30,144,255,0.7)",
            }}
          >
            OMNION AI v3.0 · ENTERPRISE
          </div>
        </motion.div>

        <div className="absolute top-6 right-8">
          <SystemStatus />
        </div>

        <div className="relative z-10 flex flex-col items-center text-center px-10 max-w-xl">
          {/* Orbiting rings + mascot */}
          <div className="relative mb-4">
            <div className="relative flex items-center justify-center" style={{ width: 340, height: 340 }}>
              {[130, 160, 190].map((r, i) => (
                <div
                  key={r}
                  className="absolute rounded-full border"
                  style={{
                    width: r * 2, height: r * 2,
                    top: "50%", left: "50%",
                    transform: "translate(-50%, -50%)",
                    borderColor: `rgba(30,144,255,${0.06 - i * 0.015})`,
                  }}
                />
              ))}

              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative" style={{ width: 260, height: 260 }}>
                  <OrbitParticle radius={130} duration={12} delay={0}   color="#1E90FF" size={4}   />
                  <OrbitParticle radius={130} duration={12} delay={-6}  color="#00D4FF" size={3}   />
                  <OrbitParticle radius={160} duration={18} delay={-4}  color="#3AABFF" size={3.5} />
                  <OrbitParticle radius={160} duration={18} delay={-12} color="#60B8FF" size={2.5} />
                  <OrbitParticle radius={190} duration={25} delay={-8}  color="#1E90FF" size={2.5} />
                </div>
              </div>

              <motion.div style={{ rotateX, rotateY, perspective: 800 }} className="relative z-10">
                <OmnionMascot size={280} mood={mascotMood} />
              </motion.div>
            </div>
          </div>

          {/* Headline */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="text-[11px] font-medium tracking-widest uppercase mb-3"
              style={{ color: "rgba(30,144,255,0.7)" }}>
              Powered by Omnion AI
            </div>
            <h1 className="text-4xl xl:text-5xl font-black mb-2"
              style={{ color: "white", letterSpacing: "-0.04em", lineHeight: 1.08, textShadow: "0 0 40px rgba(30,144,255,0.2)" }}>
              The AI OS for
            </h1>
            <div
              className="text-4xl xl:text-5xl font-black mb-5"
              style={{
                letterSpacing: "-0.04em", lineHeight: 1.08,
                background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 60%, #3AABFF 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text", minHeight: "1.2em",
              }}
            >
              {typeText}
              <span
                className="inline-block w-0.5 ml-1 align-middle"
                style={{
                  height: "0.85em", background: "#1E90FF",
                  animation: "cursor-blink 1.2s ease-in-out infinite",
                  boxShadow: "0 0 8px rgba(30,144,255,0.8)",
                }}
              />
            </div>
            <p className="text-sm leading-relaxed max-w-sm mx-auto mb-8"
              style={{ color: "rgba(160,184,216,0.7)" }}>
              Enterprise-grade intelligence woven into every workflow.
              Automate, optimize, and scale your Salesforce ecosystem.
            </p>
          </motion.div>

          <motion.div className="flex flex-wrap justify-center gap-2"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1, duration: 0.6 }}>
            <FeaturePill icon="⚡" label="AI-Powered CPQ"       delay={1.0} />
            <FeaturePill icon="☁"  label="Revenue Cloud"        delay={1.1} />
            <FeaturePill icon="◈" label="Salesforce Native"     delay={1.2} />
            <FeaturePill icon="⬡" label="Real-time Analytics"   delay={1.3} />
            <FeaturePill icon="◎" label="Enterprise Security"   delay={1.4} />
          </motion.div>
        </div>

        <div className="absolute bottom-6 left-6 text-[10px] font-mono"
          style={{ color: "rgba(30,144,255,0.35)" }}>
          OMNICLOUD PLATFORM © 2026 · BUILD 3.0.0
        </div>
        <div className="absolute bottom-6 right-6 text-[10px]"
          style={{ color: "rgba(160,184,216,0.35)" }}>
          Salesforce ISV Partner
        </div>
      </motion.div>

      {/* ══ RIGHT PANEL — Login Card ══ */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-12 relative z-10"
        style={{ background: isDark ? "transparent" : "rgba(245,248,255,0.95)" }}
      >
        <motion.div className="lg:hidden absolute top-5 left-5"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <OmnicloudLogo dark={isDark} />
        </motion.div>

        <motion.div
          className="w-full max-w-md"
          initial={{ opacity: 0, y: 32, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        >
          {/* Glass card */}
          <motion.div
            layout
            className="relative rounded-2xl overflow-hidden"
            style={{
              background: isDark ? "rgba(5,12,25,0.7)" : "rgba(255,255,255,0.85)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: isDark ? "1px solid rgba(30,144,255,0.18)" : "1px solid rgba(0,71,171,0.12)",
              boxShadow: isDark
                ? "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(30,144,255,0.08), inset 0 1px 0 rgba(255,255,255,0.06)"
                : "0 24px 80px rgba(0,31,91,0.12), 0 0 0 1px rgba(0,71,171,0.08), inset 0 1px 0 rgba(255,255,255,0.9)",
            }}
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ borderRadius: "inherit", background: "linear-gradient(135deg, rgba(30,144,255,0.06) 0%, transparent 50%)" }}
            />
            <div
              className="absolute top-0 left-8 right-8 h-px"
              style={{
                background: isDark
                  ? "linear-gradient(90deg, transparent, rgba(30,144,255,0.4), transparent)"
                  : "linear-gradient(90deg, transparent, rgba(0,71,171,0.2), transparent)",
              }}
            />

            <div className="relative p-8 sm:p-10">
              {/* Logo + header */}
              <motion.div
                className="mb-8"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              >
                <OmnicloudLogo dark={isDark} />
                <div className="mt-6">
                  <h2 className="text-2xl font-bold mb-1"
                    style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                    Sign in to Omnicloud
                  </h2>
                  <p className="text-sm" style={{ color: isDark ? "rgba(160,184,216,0.65)" : "rgba(0,31,91,0.5)" }}>
                    Access your AI-powered enterprise platform
                  </p>
                </div>
              </motion.div>

              <div className="h-px mb-7" style={{
                background: isDark
                  ? "linear-gradient(90deg, transparent, rgba(30,144,255,0.15), transparent)"
                  : "linear-gradient(90deg, transparent, rgba(0,71,171,0.1), transparent)",
              }} />

              {/* Environment selector */}
              <motion.div className="mb-6"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}>
                <EnvironmentSelector
                  value={environment}
                  onChange={(env) => {
                    if (authStage === "idle" || authStage === "error") setEnvironment(env);
                  }}
                />
              </motion.div>

              {/* Auth area */}
              <AnimatePresence mode="wait">
                {authStage === "idle" && (
                  <motion.div
                    key="sfbutton"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
                    transition={{ delay: 0.5, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <SalesforceButton
                      environment={environment}
                      onClick={handleSFLogin}
                      loading={isFetchingUrl}
                    />
                  </motion.div>
                )}

                {authStage === "popup" && (
                  <DummyAuthFlow
                    key="connecting"
                    phase="connecting"
                    environment={connectEnv}
                    isDark={isDark}
                    onCancel={handleCancelDummy}
                  />
                )}

                {authStage === "loading" && (
                  <DummyAuthFlow
                    key="authenticating"
                    phase="authenticating"
                    environment={connectEnv}
                    isDark={isDark}
                    onCancel={handleCancelDummy}
                  />
                )}

                {authStage === "success" && (
                  <AuthSuccess key="success" username={successUser} isDark={isDark} />
                )}

                {authStage === "error" && (
                  <motion.div
                    key="error-state"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex flex-col gap-3"
                  >
                    <AuthError error={authError} isDark={isDark} />
                    <SalesforceButton
                      environment={environment}
                      onClick={handleSFLogin}
                      loading={isFetchingUrl}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* SSO section */}
              <AnimatePresence>
                {showSSOSection && (
                  <motion.div
                    key="sso"
                    initial={false}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0, overflow: "hidden" }}
                    transition={{ duration: 0.3 }}
                  >
                    <div className="relative flex items-center gap-4 my-6">
                      <div className="flex-1 h-px" style={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.08)" }} />
                      <span className="text-[11px] font-medium" style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.5)" }}>
                        ENTERPRISE SSO
                      </span>
                      <div className="flex-1 h-px" style={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.08)" }} />
                    </div>

                    <motion.button
                      className="w-full rounded-xl py-3 px-5 text-sm font-medium flex items-center justify-center gap-2.5 cursor-pointer"
                      style={{
                        background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.05)",
                        border: isDark ? "1px solid rgba(30,144,255,0.18)" : "1px solid rgba(0,71,171,0.15)",
                        color: isDark ? "rgba(160,184,216,0.8)" : "rgba(0,31,91,0.65)",
                      }}
                      whileHover={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.08)", y: -1 }}
                      whileTap={{ y: 0 }}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.65, duration: 0.5 }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke={isDark ? "rgba(30,144,255,0.8)" : "#0047AB"}
                        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      Continue with Enterprise SSO
                    </motion.button>

                    {/* ── DEVELOPER CONNECTION METHODS ── */}
                    <div className="relative flex items-center gap-3 mt-6 mb-1">
                      <div className="flex-1 h-px"
                        style={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.08)" }} />
                      <div className="flex items-center gap-1.5">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                          stroke={isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)"}
                          strokeWidth="2" strokeLinecap="round">
                          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                        <span className="text-[10px] font-medium tracking-widest"
                          style={{ color: isDark ? "rgba(90,122,154,0.55)" : "rgba(74,106,160,0.48)" }}>
                          DEVELOPER CONNECTIONS
                        </span>
                      </div>
                      <div className="flex-1 h-px"
                        style={{ background: isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.08)" }} />
                    </div>

                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.75, duration: 0.5 }}
                      className="rounded-2xl overflow-hidden"
                      style={{
                        background: isDark ? "rgba(0,0,0,0.18)" : "rgba(0,31,91,0.025)",
                        border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.09)",
                      }}
                    >
                      {/* Panel header */}
                      <div className="flex items-center gap-2 px-4 pt-4 pb-3"
                        style={{
                          borderBottom: isDark ? "1px solid rgba(30,144,255,0.07)" : "1px solid rgba(0,71,171,0.07)",
                        }}
                      >
                        <div className="flex gap-1">
                          {["#FF5F57", "#FFBD2E", "#28C840"].map((c) => (
                            <div key={c} className="w-2 h-2 rounded-full" style={{ background: c, opacity: 0.7 }} />
                          ))}
                        </div>
                        <span className="text-[10px] font-mono ml-1"
                          style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)" }}>
                          developer · connection · methods
                        </span>
                      </div>

                      {/* Tab strip + content */}
                      <div className="p-4 flex flex-col gap-4">
                        <DevTabStrip active={devTab} onChange={setDevTab} isDark={isDark} />

                        <AnimatePresence mode="wait">
                          {devTab === "cli" && (
                            <CLITabContent
                              orgs={MOCK_CLI_ORGS}
                              selected={selectedCliOrg}
                              onSelect={setSelectedCliOrg}
                              scanning={cliScanning}
                              onScan={handleCliScan}
                              onConnect={() => handleDevConnect("cli")}
                              isDark={isDark}
                            />
                          )}
                          {devTab === "token" && (
                            <TokenTabContent
                              instanceUrl={tokenInstanceUrl}
                              setInstanceUrl={setTokenInstanceUrl}
                              token={accessToken}
                              setToken={setAccessToken}
                              showToken={showToken}
                              setShowToken={setShowToken}
                              onConnect={() => handleDevConnect("token")}
                              error={devError}
                              isDark={isDark}
                            />
                          )}
                          {devTab === "password" && (
                            <PasswordTabContent
                              username={sfUsername}
                              setUsername={setSfUsername}
                              password={sfPassword}
                              setPassword={setSfPassword}
                              showPassword={showPassword}
                              setShowPassword={setShowPassword}
                              securityToken={sfSecurityToken}
                              setSecurityToken={setSfSecurityToken}
                              sfEnv={sfEnv}
                              setSfEnv={setSfEnv}
                              onConnect={() => handleDevConnect("password")}
                              error={devError}
                              isDark={isDark}
                            />
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Footer */}
              <motion.div className="mt-8 flex flex-col gap-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.75, duration: 0.5 }}>
                <div className="flex items-center justify-center gap-2 text-[11px]"
                  style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.5)" }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  256-bit encrypted · SOC 2 Type II · GDPR compliant
                </div>
                <div className="flex items-center justify-center gap-4 text-[11px]"
                  style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(74,106,160,0.45)" }}>
                  {["Privacy Policy", "Terms of Service", "Support"].map((l) => (
                    <button key={l} className="hover:underline cursor-pointer transition-opacity hover:opacity-80">{l}</button>
                  ))}
                </div>
              </motion.div>
            </div>
          </motion.div>

          <motion.div
            className="text-center mt-5 text-[11px] font-mono"
            style={{ color: isDark ? "rgba(30,144,255,0.2)" : "rgba(0,71,171,0.25)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1, duration: 0.6 }}
          >
            OMNICLOUD · ENTERPRISE PLATFORM · v3.0.0
          </motion.div>
        </motion.div>
      </div>

      {/* PARTICLE FIELD */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {Array.from({ length: 18 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              width: Math.random() * 2 + 1,
              height: Math.random() * 2 + 1,
              left: `${Math.random() * 55}%`,
              top: `${Math.random() * 100}%`,
              background: ["#1E90FF", "#00D4FF", "#3AABFF"][i % 3],
              opacity: 0.3,
            }}
            animate={{ y: [0, -(60 + Math.random() * 80), 0], opacity: [0, 0.5, 0] }}
            transition={{
              duration: 8 + Math.random() * 10,
              delay: Math.random() * 12,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
    </div>
  );
}
