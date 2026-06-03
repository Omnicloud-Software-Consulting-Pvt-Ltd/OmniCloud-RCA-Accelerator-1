"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import Image from "next/image";
import { loadSession, clearSession } from "@/lib/auth/session";
import type { SessionData } from "@/lib/auth/types";

// ── ORBIT PARTICLE ────────────────────────────────────────────────────────────
function OrbitParticle({ radius, duration, delay, color, size = 3 }: {
  radius: number; duration: number; delay: number; color: string; size?: number;
}) {
  return (
    <motion.div
      className="absolute rounded-full top-1/2 left-1/2"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 ${size * 3}px ${color}`,
        x: radius,
        y: 0,
        transformOrigin: `-${radius}px 0px`,
      }}
      animate={{ rotate: 360 }}
      transition={{ duration, repeat: Infinity, ease: "linear", delay }}
    />
  );
}

// ── TILE MASCOT ───────────────────────────────────────────────────────────────
function TileMascot({ color1, color2, flipped = false, hovering = false }: {
  color1: string; color2: string; flipped?: boolean; hovering?: boolean;
}) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 220, height: 220 }}>
      {/* Radial ambient glow */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at 50% 55%, ${color1}1E 0%, transparent 65%)`,
        }}
      />

      {/* Orbit rings */}
      {[72, 96].map((r, i) => (
        <div
          key={r}
          className="absolute rounded-full"
          style={{
            width: r * 2,
            height: r * 2,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            border: `1px solid ${color1}${i === 0 ? "22" : "14"}`,
          }}
        />
      ))}

      {/* Particles */}
      <OrbitParticle radius={72} duration={10} delay={0} color={color1} size={4} />
      <OrbitParticle radius={72} duration={10} delay={-5} color={color2} size={3} />
      <OrbitParticle radius={96} duration={16} delay={-3} color={color1} size={3} />
      <OrbitParticle radius={96} duration={16} delay={-10} color={color2} size={2.5} />

      {/* Mascot image */}
      <motion.div
        className="relative z-10"
        animate={{ y: hovering ? [0, -14, 0] : [0, -8, 0] }}
        transition={{ duration: hovering ? 1.8 : 3.6, repeat: Infinity, ease: "easeInOut" }}
        style={{ scaleX: flipped ? -1 : 1 }}
      >
        <Image
          src="/omnion.png"
          alt="Omnion"
          width={130}
          height={130}
          style={{
            objectFit: "contain",
            filter: `drop-shadow(0 10px 24px ${color1}55)`,
          }}
          priority
        />
      </motion.div>

      {/* Ground shadow */}
      <div
        className="absolute"
        style={{
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          width: 90,
          height: 14,
          background: `radial-gradient(ellipse at center, ${color1}2E 0%, transparent 70%)`,
          filter: "blur(5px)",
        }}
      />
    </div>
  );
}

// ── CAPABILITY CHIP ───────────────────────────────────────────────────────────
function CapChip({ label, color, delay }: { label: string; color: string; delay: number }) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.8, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium"
      style={{
        background: `${color}14`,
        border: `1px solid ${color}28`,
        color: `${color}CC`,
      }}
    >
      {label}
    </motion.span>
  );
}

// ── AGENT DATA ────────────────────────────────────────────────────────────────
interface Agent {
  id: string;
  name: string;
  code: string;
  tagline: string;
  description: string;
  color1: string;
  color2: string;
  flipped: boolean;
  capabilities: string[];
  route: string;
}

const AGENTS: Agent[] = [
  {
    id: "metadata",
    name: "Metadata Omnion",
    code: "OMNI-META",
    tagline: "Salesforce Metadata Intelligence",
    description:
      "AI-powered product builder that designs bundles, generates attributes, configures catalog pricing, and deploys Salesforce metadata — in seconds.",
    color1: "#1E90FF",
    color2: "#0070D6",
    flipped: false,
    capabilities: [
      "Product Creation",
      "Bundle Config",
      "Attribute Generation",
      "Catalog Setup",
      "Pricing Rules",
      "SF Metadata",
    ],
    route: "/metadata",
  },
  {
    id: "data",
    name: "Data Omnion",
    code: "OMNI-DATA",
    tagline: "CRM Data Intelligence",
    description:
      "Intelligent CRM agent that manages accounts, contacts, orders, assets, and contracts — automating complex data operations across your Salesforce org.",
    color1: "#00D4FF",
    color2: "#3AABFF",
    flipped: true,
    capabilities: [
      "Accounts & Contacts",
      "Orders & Assets",
      "Contracts",
      "CRM Operations",
      "Data Records",
      "AI Analytics",
    ],
    route: "/data",
  },
];

// ── AGENT TILE ────────────────────────────────────────────────────────────────
function AgentTile({ agent, isDark, delay }: { agent: Agent; isDark: boolean; delay: number }) {
  const router = useRouter();
  const [hovering, setHovering] = useState(false);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rotateX = useTransform(mouseY, [-160, 160], [5, -5]);
  const rotateY = useTransform(mouseX, [-160, 160], [-5, 5]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left - rect.width / 2);
    mouseY.set(e.clientY - rect.top - rect.height / 2);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
    setHovering(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 40, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
      className="flex-1 min-w-[300px] max-w-[480px]"
      style={{ perspective: "1000px" }}
    >
      <motion.div
        style={{ rotateX, rotateY }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseEnter={() => setHovering(true)}
        className="relative rounded-2xl overflow-hidden cursor-pointer h-full"
        whileHover={{ scale: 1.02 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
      >
        {/* Card base */}
        <div
          className="absolute inset-0 rounded-2xl"
          style={{
            background: isDark
              ? "linear-gradient(160deg, rgba(8,16,32,0.92) 0%, rgba(4,8,18,0.96) 100%)"
              : "linear-gradient(160deg, rgba(224,235,255,0.94) 0%, rgba(210,228,255,0.97) 100%)",
            border: `1px solid ${agent.color1}28`,
            boxShadow: hovering
              ? `0 32px 80px ${agent.color1}22, 0 0 0 1px ${agent.color1}18, inset 0 1px 0 rgba(255,255,255,0.06)`
              : `0 16px 48px rgba(0,0,0,0.38), 0 0 0 1px ${agent.color1}10, inset 0 1px 0 rgba(255,255,255,0.04)`,
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            transition: "box-shadow 0.4s ease",
          }}
        />

        {/* Color wash overlay */}
        <div
          className="absolute inset-0 pointer-events-none rounded-2xl"
          style={{
            background: `linear-gradient(160deg, ${agent.color1}0A 0%, transparent 50%, ${agent.color2}07 100%)`,
          }}
        />

        {/* Top glow line */}
        <div
          className="absolute top-0 left-8 right-8 h-px pointer-events-none"
          style={{
            background: `linear-gradient(90deg, transparent, ${agent.color1}50, transparent)`,
          }}
        />

        {/* Hover radial burst */}
        <AnimatePresence>
          {hovering && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 pointer-events-none rounded-2xl"
              style={{
                background: `radial-gradient(ellipse at 50% 0%, ${agent.color1}10 0%, transparent 55%)`,
              }}
            />
          )}
        </AnimatePresence>

        {/* Content */}
        <div className="relative p-7 flex flex-col gap-5">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md"
                  style={{
                    background: `${agent.color1}18`,
                    border: `1px solid ${agent.color1}30`,
                    color: `${agent.color1}CC`,
                  }}
                >
                  {agent.code}
                </span>
                <span className="flex items-center gap-1.5">
                  <motion.span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: "#00D4FF" }}
                    animate={{ opacity: [1, 0.35, 1] }}
                    transition={{ duration: 1.8, repeat: Infinity }}
                  />
                  <span className="text-[10px] font-medium" style={{ color: "#00D4FF" }}>
                    READY
                  </span>
                </span>
              </div>
              <h3
                className="text-2xl font-black leading-none"
                style={{
                  background: `linear-gradient(135deg, ${agent.color1} 0%, ${agent.color2} 100%)`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  letterSpacing: "-0.03em",
                }}
              >
                {agent.name}
              </h3>
              <p
                className="text-[11px] mt-1"
                style={{ color: isDark ? "rgba(120,150,185,0.55)" : "rgba(0,15,55,0.65)" }}
              >
                {agent.tagline}
              </p>
            </div>
          </div>

          {/* Description */}
          <p
            className="text-sm leading-relaxed"
            style={{ color: isDark ? "rgba(160,184,216,0.68)" : "rgba(0,15,55,0.80)" }}
          >
            {agent.description}
          </p>

          {/* Mascot */}
          <div className="flex justify-center py-1">
            <TileMascot
              color1={agent.color1}
              color2={agent.color2}
              flipped={agent.flipped}
              hovering={hovering}
            />
          </div>

          {/* Divider */}
          <div
            className="h-px"
            style={{
              background: `linear-gradient(90deg, transparent, ${agent.color1}25, transparent)`,
            }}
          />

          {/* Capabilities */}
          <div>
            <p
              className="text-[10px] font-medium tracking-widest uppercase mb-3"
              style={{ color: isDark ? "rgba(90,120,160,0.55)" : "rgba(0,15,55,0.62)" }}
            >
              Capabilities
            </p>
            <div className="flex flex-wrap gap-2">
              {agent.capabilities.map((cap, i) => (
                <CapChip
                  key={cap}
                  label={cap}
                  color={agent.color1}
                  delay={delay + 0.4 + i * 0.05}
                />
              ))}
            </div>
          </div>

          {/* Launch button */}
          <motion.button
            onClick={() => router.push(agent.route)}
            className="relative w-full rounded-xl py-3.5 px-6 text-sm font-bold text-white overflow-hidden cursor-pointer flex items-center justify-center gap-2.5"
            style={{
              background: `linear-gradient(135deg, ${agent.color1} 0%, ${agent.color2} 100%)`,
              boxShadow: `0 4px 20px ${agent.color1}38, inset 0 1px 0 rgba(255,255,255,0.12)`,
            }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
          >
            {/* Shimmer sweep */}
            <motion.div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.14) 50%, transparent 100%)",
              }}
              initial={{ x: "-100%" }}
              whileHover={{ x: "100%" }}
              transition={{ duration: 0.55, ease: "easeInOut" }}
            />
            <span>Launch {agent.name}</span>
            <motion.svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              animate={{ x: hovering ? 3 : 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <path
                d="M3 8h10M9 4l4 4-4 4"
                stroke="white"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </motion.svg>
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── THEME TOGGLE ──────────────────────────────────────────────────────────────
function ThemeToggle({ isDark }: { isDark: boolean }) {
  const { setTheme } = useTheme();
  return (
    <motion.button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative rounded-full cursor-pointer flex-shrink-0"
      style={{
        width: 44,
        height: 24,
        background: isDark
          ? "linear-gradient(135deg, #0A1628 0%, #070F1E 100%)"
          : "linear-gradient(135deg, #C8E5FF 0%, #E4EDFF 100%)",
        border: isDark ? "1px solid rgba(30,144,255,0.22)" : "1px solid rgba(0,71,171,0.18)",
        boxShadow: isDark ? "inset 0 1px 4px rgba(0,0,0,0.5)" : "inset 0 1px 4px rgba(0,71,171,0.1)",
      }}
      whileTap={{ scale: 0.93 }}
      aria-label="Toggle theme"
    >
      {/* Track stars (dark mode) */}
      {isDark && (
        <>
          <span style={{ position: "absolute", left: 7, top: 5, width: 2, height: 2, borderRadius: "50%", background: "rgba(255,255,255,0.5)" }} />
          <span style={{ position: "absolute", left: 11, top: 9, width: 1.5, height: 1.5, borderRadius: "50%", background: "rgba(255,255,255,0.35)" }} />
          <span style={{ position: "absolute", left: 8, top: 13, width: 1.5, height: 1.5, borderRadius: "50%", background: "rgba(255,255,255,0.3)" }} />
        </>
      )}
      {/* Thumb */}
      <motion.div
        animate={{ x: isDark ? 22 : 2 }}
        transition={{ type: "spring", stiffness: 480, damping: 30 }}
        style={{
          position: "absolute",
          top: 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: isDark
            ? "linear-gradient(135deg, #C8E5FF 0%, #9ACFFF 100%)"
            : "linear-gradient(135deg, #FFD966 0%, #FFA500 100%)",
          boxShadow: isDark
            ? "0 0 6px rgba(200,229,255,0.6)"
            : "0 0 8px rgba(255,165,0,0.55)",
        }}
      >
        {/* Moon crater (dark mode) */}
        {isDark && (
          <span style={{ position: "absolute", top: 3, left: 3, width: 4, height: 4, borderRadius: "50%", background: "rgba(0,71,171,0.25)" }} />
        )}
        {/* Sun rays (light mode) */}
        {!isDark && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
            style={{ position: "absolute", inset: -4, borderRadius: "50%" }}
          >
            {[0,45,90,135].map(deg => (
              <span key={deg} style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: 2,
                height: 3,
                marginLeft: -1,
                marginTop: -1,
                background: "rgba(255,165,0,0.6)",
                borderRadius: 1,
                transformOrigin: "50% 50%",
                transform: `rotate(${deg}deg) translateY(-12px)`,
              }} />
            ))}
          </motion.div>
        )}
      </motion.div>
    </motion.button>
  );
}

// ── NAV BAR ───────────────────────────────────────────────────────────────────
function NavBar({
  session,
  isDark,
  onSignOut,
}: {
  session: SessionData;
  isDark: boolean;
  onSignOut: () => void;
}) {
  const isProduction = session.environment === "production";
  const displayName =
    session.displayName?.split(" ")[0] ?? session.username?.split("@")[0] ?? "User";

  return (
    <motion.nav
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-20 flex items-center justify-between px-6 sm:px-8 py-4"
      style={{
        background: isDark ? "rgba(1,9,24,0.75)" : "rgba(226,237,255,0.90)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderBottom: isDark
          ? "1px solid rgba(30,144,255,0.12)"
          : "1px solid rgba(0,71,171,0.1)",
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3">
        <svg width="28" height="24" viewBox="0 0 36 30" fill="none">
          <defs>
            <linearGradient id="nav-logo-lg" x1="0" y1="0" x2="36" y2="30" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3AABFF" />
              <stop offset="100%" stopColor="#0047AB" />
            </linearGradient>
          </defs>
          <circle cx="12" cy="16" r="8" fill="url(#nav-logo-lg)" />
          <circle cx="22" cy="13" r="9" fill="url(#nav-logo-lg)" />
          <circle cx="30" cy="17" r="7" fill="url(#nav-logo-lg)" />
          <ellipse cx="21" cy="21" rx="15" ry="6" fill="url(#nav-logo-lg)" />
          <circle cx="22" cy="7" r="3" fill="white" opacity="0.9" />
          <circle cx="22" cy="7" r="1.5" fill="#0047AB" />
        </svg>
        <div>
          <div
            className="text-base font-bold leading-none"
            style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}
          >
            Omnicloud
          </div>
          <div
            className="text-[9px] font-medium tracking-widest uppercase mt-0.5"
            style={{ color: isDark ? "rgba(30,144,255,0.7)" : "#0047AB" }}
          >
            AI Platform
          </div>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-3">
        {/* Env badge */}
        <div
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
          style={{
            background: isProduction ? "rgba(0,200,117,0.10)" : "rgba(30,144,255,0.10)",
            border: `1px solid ${isProduction ? "rgba(0,200,117,0.25)" : "rgba(30,144,255,0.25)"}`,
            color: isProduction ? "#00C875" : "#3AABFF",
          }}
        >
          <motion.span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: isProduction ? "#00C875" : "#3AABFF",
              boxShadow: `0 0 5px ${isProduction ? "rgba(0,200,117,0.8)" : "rgba(58,171,255,0.8)"}`,
            }}
            animate={{ opacity: [1, 0.4, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          {isProduction ? "Production" : "Sandbox"}
        </div>

        {/* User avatar + name */}
        <div className="hidden sm:flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{
              background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)",
              color: "white",
            }}
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
          <span
            className="text-[12px] font-medium"
            style={{ color: isDark ? "rgba(160,184,216,0.8)" : "rgba(0,31,91,0.7)" }}
          >
            {displayName}
          </span>
        </div>

        {/* Theme toggle */}
        <ThemeToggle isDark={isDark} />

        <div
          className="h-4 w-px"
          style={{
            background: isDark ? "rgba(30,144,255,0.15)" : "rgba(0,71,171,0.1)",
          }}
        />

        {/* Sign out */}
        <motion.button
          onClick={onSignOut}
          className="text-[11px] font-medium px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5"
          style={{
            color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)",
            border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.1)",
            background: "transparent",
          }}
          whileHover={{
            background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.10)",
            color: isDark ? "rgba(160,184,216,0.9)" : "rgba(0,31,91,0.8)",
          }}
          whileTap={{ scale: 0.97 }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </motion.button>
      </div>
    </motion.nav>
  );
}

// ── GRID BACKGROUND ───────────────────────────────────────────────────────────
function GridBackground({ isDark }: { isDark: boolean }) {
  const lineColor = isDark ? "rgba(30,144,255,0.04)" : "rgba(0,71,171,0.09)";
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(${lineColor} 1px, transparent 1px), linear-gradient(90deg, ${lineColor} 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: isDark
            ? "radial-gradient(ellipse 70% 45% at 20% 30%, rgba(30,144,255,0.06) 0%, transparent 60%), radial-gradient(ellipse 60% 45% at 80% 75%, rgba(0,212,255,0.04) 0%, transparent 60%)"
            : "radial-gradient(ellipse 70% 45% at 20% 30%, rgba(0,71,171,0.10) 0%, transparent 60%), radial-gradient(ellipse 60% 45% at 80% 75%, rgba(0,71,171,0.09) 0%, transparent 60%)",
        }}
      />
    </div>
  );
}

// ── PAGE ──────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [session, setSession] = useState<SessionData | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const s = loadSession();
    if (!s) {
      router.replace("/login");
      return;
    }
    setSession(s);
  }, [router]);

  const handleSignOut = () => {
    clearSession();
    router.replace("/login");
  };

  if (!mounted || !session) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000508",
        }}
      >
        <motion.div
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          style={{ color: "rgba(30,144,255,0.4)", fontSize: "12px", fontFamily: "monospace" }}
        >
          LOADING…
        </motion.div>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-screen flex flex-col overflow-hidden"
      style={{
        background: isDark
          ? "linear-gradient(160deg, #000508 0%, #010918 60%, #000305 100%)"
          : "linear-gradient(160deg, #EEF3FF 0%, #F5F8FF 60%, #E4EDFF 100%)",
      }}
    >
      <GridBackground isDark={isDark} />
      <NavBar session={session} isDark={isDark} onSignOut={handleSignOut} />

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-12">
        {/* Hero */}
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <div
            className="text-[11px] font-medium tracking-widest uppercase mb-3"
            style={{ color: "rgba(30,144,255,0.7)" }}
          >
            OMNION AI · ENTERPRISE PLATFORM
          </div>
          <h1
            className="text-4xl sm:text-5xl font-black mb-4"
            style={{
              color: isDark ? "white" : "#001F5B",
              letterSpacing: "-0.04em",
              lineHeight: 1.08,
            }}
          >
            Choose your{" "}
            <span
              style={{
                background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 60%, #00D4FF 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              AI Agent
            </span>
          </h1>
          <p
            className="text-sm max-w-xs mx-auto"
            style={{
              color: isDark ? "rgba(120,150,185,0.62)" : "rgba(0,15,55,0.74)",
              lineHeight: 1.65,
            }}
          >
            Select the intelligent agent that powers your workflow.
            Each Omnion is specialized for your mission.
          </p>
        </motion.div>

        {/* Tiles */}
        <div className="flex flex-col lg:flex-row gap-6 w-full max-w-3xl xl:max-w-4xl">
          {AGENTS.map((agent, i) => (
            <AgentTile key={agent.id} agent={agent} isDark={isDark} delay={0.3 + i * 0.15} />
          ))}
        </div>

        {/* Footer tag */}
        <motion.div
          className="mt-10 text-[10px] font-mono"
          style={{ color: isDark ? "rgba(30,144,255,0.18)" : "rgba(0,71,171,0.2)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          OMNICLOUD · v3.0.0 · ENTERPRISE PLATFORM
        </motion.div>
      </div>

      {/* Ambient float particles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {Array.from({ length: 12 }).map((_, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              width: 2,
              height: 2,
              left: `${10 + ((i * 7.5) % 80)}%`,
              top: `${15 + ((i * 11) % 70)}%`,
              background: ["#1E90FF", "#00D4FF", "#3AABFF", "#60B8FF"][i % 4],
              opacity: 0.22,
            }}
            animate={{ y: [0, -(40 + ((i * 7) % 50)), 0], opacity: [0, 0.38, 0] }}
            transition={{
              duration: 7 + ((i * 1.3) % 8),
              delay: (i * 0.9) % 10,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
    </div>
  );
}
