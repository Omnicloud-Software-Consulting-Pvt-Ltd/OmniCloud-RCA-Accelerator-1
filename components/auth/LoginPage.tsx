"use client";

import React, { useState, useEffect } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { OmnionMascot } from "./OmnionMascot";
import { BrandLockup } from "@/components/brand/BrandLockup";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import Fireflies from "@/components/Fireflies";
import type { MascotMood } from "@/lib/auth/types";
import { saveIdentity, loadIdentity, isSetupComplete } from "@/lib/auth/identity";

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

/* ── MICROSOFT LOGO (4 squares) ── */
function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN LOGIN PAGE
══════════════════════════════════════════════════════════ */
export function LoginPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";

  const [signingIn, setSigningIn] = useState(false);

  const dynamicWords = ["Revenue Cloud", "Product Bundles", "RCA Attributes", "Agentic Workflows", "Metadata Deploys"];
  const typeText = useTypewriter(dynamicWords, 75, 2000);

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const rotateX = useTransform(mouseY, [-300, 300], [4, -4]);
  const rotateY = useTransform(mouseX, [-300, 300], [-4, 4]);

  /* If already signed in, skip the login screen. */
  useEffect(() => {
    if (loadIdentity()) {
      router.replace(isSetupComplete() ? "/dashboard" : "/setup");
    }
  }, [router]);

  /* Phase A stub: stand in for Microsoft Entra sign-in until the Entra app
     registration exists. Establishes an app identity and routes onward. */
  const handleMicrosoftSignIn = () => {
    setSigningIn(true);
    saveIdentity({
      email: "team.member@omnicloudconsulting.com",
      name: "Omnicloud Team Member",
      provider: "stub",
      signedInAt: Date.now(),
    });
    setTimeout(() => {
      router.push(isSetupComplete() ? "/dashboard" : "/setup");
    }, 700);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left - rect.width / 2);
    mouseY.set(e.clientY - rect.top - rect.height / 2);
  };

  const mascotMood: MascotMood = signingIn ? "thinking" : "float";

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
        className="hidden lg:flex lg:w-1/2 lg:h-screen relative flex-col items-center justify-center overflow-hidden"
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
OMNIVERSE · BY OMNICLOUD
          </div>
        </motion.div>

        <div className="absolute top-6 right-8">
          <SystemStatus />
        </div>

        <div className="relative z-10 flex flex-col items-center text-center px-10 max-w-xl">
          {/* Title block — above mascot */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <h1 className="text-5xl xl:text-6xl font-black mb-2"
              style={{
                letterSpacing: "-0.04em", lineHeight: 1.05,
                backgroundImage: isDark
                  ? "linear-gradient(100deg, #16367E 0%, #1C56B8 26%, #1789B0 52%, #1CC3B0 76%, #3BDDAE 100%)"
                  : "linear-gradient(100deg, #6FB8FF 0%, #34BEE6 34%, #19C7B6 64%, #5CEAC9 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                filter: "drop-shadow(0 6px 28px rgba(28,195,176,0.38))",
              }}>
              OmniVerse
            </h1>
            <div
              className="text-xl xl:text-2xl font-black"
              style={{
                letterSpacing: "-0.02em", lineHeight: 1.15,
                backgroundImage: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 60%, #3AABFF 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              From Complexity. Into Clarity.
            </div>
          </motion.div>

          {/* Orbiting rings + mascot — center */}
          <div className="relative my-1">
            <div className="relative flex items-center justify-center" style={{ width: 280, height: 280 }}>
              {[100, 125, 150, 175].map((r, i) => (
                <div
                  key={r}
                  className="absolute rounded-full border"
                  style={{
                    width: r * 2, height: r * 2,
                    top: "50%", left: "50%",
                    transform: "translate(-50%, -50%)",
                    borderColor: isDark
                      ? `rgba(30,144,255,${0.07 - i * 0.012})`
                      : `rgba(1,11,30,${0.18 - i * 0.03})`,
                  }}
                />
              ))}

              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative" style={{ width: 220, height: 220 }}>
                  <OrbitParticle radius={110} duration={12} delay={0}   color={isDark ? "#1E90FF" : "#010B1E"} size={4}   />
                  <OrbitParticle radius={110} duration={12} delay={-6}  color={isDark ? "#00D4FF" : "#010B1E"} size={3}   />
                  <OrbitParticle radius={135} duration={18} delay={-4}  color={isDark ? "#3AABFF" : "#001F5B"} size={3.5} />
                  <OrbitParticle radius={135} duration={18} delay={-12} color={isDark ? "#60B8FF" : "#001F5B"} size={2.5} />
                  <OrbitParticle radius={160} duration={25} delay={-8}  color={isDark ? "#1E90FF" : "#010B1E"} size={2.5} />
                </div>
              </div>

              <motion.div style={{ rotateX, rotateY, perspective: 800 }} className="relative z-10">
                <OmnionMascot size={230} mood={mascotMood} particleColor={isDark ? undefined : "#010B1E"} />
              </motion.div>
            </div>
          </div>

          {/* Below mascot — animated line + description + pills */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="text-[11px] font-medium tracking-widest uppercase mb-4"
              style={{ color: "rgba(30,144,255,0.7)" }}>
              An Agentic Accelerator Platform by OmniCloud
            </div>
            <div className="text-lg xl:text-xl font-semibold mb-4 flex items-center justify-center gap-2"
              style={{ minHeight: "1.6em" }}>
              <span style={{ color: "rgba(160,184,216,0.7)" }}>Accelerating</span>
              <span
                style={{
                  backgroundImage: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 60%, #3AABFF 100%)",
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                {typeText}
              </span>
              <span
                className="inline-block w-0.5 align-middle"
                style={{
                  height: "1em", background: "#1E90FF",
                  animation: "cursor-blink 1.2s ease-in-out infinite",
                  boxShadow: "0 0 8px rgba(30,144,255,0.8)",
                }}
              />
            </div>
            <p className="text-sm leading-relaxed max-w-sm mx-auto mb-6"
              style={{ color: "rgba(160,184,216,0.7)" }}>
              Enterprise-grade agentic intelligence woven into every workflow.
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
OMNICLOUD © 2026 · OMNIVERSE
        </div>
        <div className="absolute bottom-6 right-6 text-[10px]"
          style={{ color: "rgba(160,184,216,0.35)" }}>
          Salesforce ISV Partner
        </div>
      </motion.div>

      {/* ══ RIGHT PANEL — Sign-in Card ══ */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-6 sm:px-10 py-12 relative z-10 overflow-hidden"
        style={{ background: isDark ? "transparent" : "rgba(245,248,255,0.95)" }}
      >
        {/* Ambient fireflies behind the card */}
        <Fireflies
          className="z-0"
          color={isDark ? "#00D4FF" : "#84E04A"}
          glow={isDark ? "rgba(0, 181, 226, 0.55)" : "rgba(124, 224, 74, 0.7)"}
        />

        <motion.div
          className="w-full max-w-lg relative z-10"
          initial={{ opacity: 0, y: 32, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        >
          {/* Glass card */}
          <div
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
                <BrandLockup isDark={isDark} height={72} />
                <div className="mt-7 text-center">
                  <h2 className="text-2xl font-bold mb-1"
                    style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                    Sign in to OmniVerse
                  </h2>
                  <p className="text-sm" style={{ color: isDark ? "rgba(160,184,216,0.65)" : "rgba(0,31,91,0.5)" }}>
                    Restricted to Omnicloud team members
                  </p>
                </div>
              </motion.div>

              <div className="h-px mb-7" style={{
                background: isDark
                  ? "linear-gradient(90deg, transparent, rgba(30,144,255,0.15), transparent)"
                  : "linear-gradient(90deg, transparent, rgba(0,71,171,0.1), transparent)",
              }} />

              {/* Microsoft sign-in */}
              <motion.button
                onClick={handleMicrosoftSignIn}
                disabled={signingIn}
                className="w-full rounded-xl py-3.5 px-5 text-sm font-semibold flex items-center justify-center gap-3 cursor-pointer"
                style={{
                  background: isDark ? "rgba(255,255,255,0.95)" : "#FFFFFF",
                  border: "1px solid rgba(0,0,0,0.12)",
                  color: "#1F1F1F",
                  boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
                  cursor: signingIn ? "wait" : "pointer",
                  opacity: signingIn ? 0.75 : 1,
                }}
                whileHover={signingIn ? {} : { y: -1, boxShadow: "0 6px 20px rgba(0,0,0,0.22)" }}
                whileTap={signingIn ? {} : { y: 0, scale: 0.99 }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.4 }}
              >
                <MicrosoftLogo />
                {signingIn ? "Signing in…" : "Sign in with Microsoft"}
              </motion.button>

              {/* Dev stub notice — Phase A */}
              <p className="mt-3 text-center text-[11px]"
                style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(74,106,160,0.55)" }}>
                Development sign-in · Microsoft Entra wiring pending
              </p>

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
              </motion.div>
            </div>
          </div>

          <motion.div
            className="text-center mt-5 text-[11px] font-mono tracking-widest"
            style={{ color: isDark ? "rgba(120,180,255,0.7)" : "rgba(0,71,171,0.6)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1, duration: 0.6 }}
          >
OMNIVERSE · BY OMNICLOUD
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
              width: ((i * 37) % 2) + 1,
              height: ((i * 53) % 2) + 1,
              left: `${(i * 53) % 55}%`,
              top: `${(i * 29) % 100}%`,
              background: ["#1E90FF", "#00D4FF", "#3AABFF"][i % 3],
              opacity: 0.3,
            }}
            animate={{ y: [0, -(60 + ((i * 17) % 80)), 0], opacity: [0, 0.5, 0] }}
            transition={{
              duration: 8 + ((i * 13) % 10),
              delay: (i * 7) % 12,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>

    </div>
  );
}
