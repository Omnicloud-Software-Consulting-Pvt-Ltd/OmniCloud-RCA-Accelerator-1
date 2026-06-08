"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";
import Image from "next/image";
import type { MascotMood } from "@/lib/auth/types";

interface OmnionMascotProps {
  className?: string;
  size?: number;
  mood?: MascotMood;
  /** Override accent-particle color (e.g. dark-navy on light theme). */
  particleColor?: string;
}

/* Clean, transparent Omnion poses that crossfade in the same spot. */
const MASCOT_IMAGES = [
  "/omnion.png",
  "/omnion-v3-t.png",
  "/omnion-v5.png",
  "/omnion-v6.png",
];

/* How long each image is shown before crossfading to the next. */
const ROTATE_INTERVAL_MS = 5000;

const moodConfig: Record<
  MascotMood,
  { animate: TargetAndTransition; transition: Transition }
> = {
  float: {
    animate: { y: [0, -14, -6, 0], rotate: [0, 0.4, -0.4, 0], x: 0, scale: 1 },
    transition: {
      duration: 6,
      repeat: Infinity,
      ease: "easeInOut",
      times: [0, 0.33, 0.66, 1],
    },
  },
  thinking: {
    animate: { y: [0, -7, -3, 0], rotate: [0, 3, -2, 0], x: 0, scale: 1 },
    transition: {
      duration: 3.6,
      repeat: Infinity,
      ease: "easeInOut",
      times: [0, 0.33, 0.66, 1],
    },
  },
  success: {
    animate: {
      y: [0, -28, 0, -14, 0],
      scale: [1, 1.07, 0.97, 1.03, 1],
      rotate: [0, -1.5, 1.5, -0.5, 0],
      x: 0,
    },
    transition: {
      duration: 0.75,
      repeat: 2,
      ease: "easeOut",
      times: [0, 0.25, 0.5, 0.75, 1],
    },
  },
  error: {
    animate: {
      x: [0, -12, 12, -10, 10, -5, 5, 0],
      rotate: [0, -2.5, 2.5, -2, 2, -1, 1, 0],
      y: 0,
      scale: 1,
    },
    transition: { duration: 0.55, repeat: 0, ease: "easeInOut" },
  },
};

const glowColors: Record<MascotMood, string> = {
  float: "rgba(30,144,255,0.55)",
  thinking: "rgba(30,144,255,0.5)",
  success: "rgba(0,200,117,0.6)",
  error: "rgba(232,68,68,0.5)",
};

/* Floating accent particles around the mascot (fixed values — deterministic). */
const ACCENT_PARTICLES = [
  { size: 7, top: "38%", side: "left",  pos: "8%",  dy: -10, dur: 3.2, delay: 0.4, glow: 8, color: "#00D4FF", op: 1.0 },
  { size: 6, top: "28%", side: "right", pos: "8%",  dy: -12, dur: 4.1, delay: 1.1, glow: 8, color: "#3AABFF", op: 0.95 },
  { size: 5, top: "58%", side: "right", pos: "5%",  dy: -8,  dur: 3.6, delay: 1.8, glow: 6, color: "#1E90FF", op: 0.85 },
  { size: 5, top: "62%", side: "left",  pos: "6%",  dy: -10, dur: 5.0, delay: 2.3, glow: 6, color: "#00D4FF", op: 0.85 },
  { size: 4, top: "18%", side: "left",  pos: "20%", dy: -9,  dur: 4.6, delay: 0.9, glow: 6, color: "#60B8FF", op: 0.80 },
  { size: 4, top: "48%", side: "right", pos: "16%", dy: -11, dur: 5.4, delay: 2.7, glow: 6, color: "#00D4FF", op: 0.80 },
  { size: 5, top: "72%", side: "left",  pos: "18%", dy: -9,  dur: 4.2, delay: 1.5, glow: 6, color: "#3AABFF", op: 0.82 },
] as const;

export function OmnionMascot({
  className = "",
  size = 320,
  mood = "float",
  particleColor,
}: OmnionMascotProps) {
  const { animate, transition } = moodConfig[mood];
  const glowColor = glowColors[mood];

  /* Cycle through the mascot poses every ROTATE_INTERVAL_MS. */
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setActiveIndex((i) => (i + 1) % MASCOT_IMAGES.length);
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      key={mood === "error" || mood === "success" ? mood : "persistent"}
      className={`relative select-none ${className}`}
      style={{ width: size, height: size * 1.22 }}
      animate={animate}
      transition={transition}
    >
      {/* Ambient glow shadow below mascot */}
      <motion.div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full"
        style={{
          width: size * 0.62,
          height: size * 0.06,
          background: `radial-gradient(ellipse, ${glowColor} 0%, transparent 70%)`,
          filter: "blur(10px)",
        }}
        animate={{ opacity: [0.45, 0.9, 0.45], scaleX: [0.85, 1.12, 0.85] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Omnion mascot images — all stacked, crossfading between poses.
          Rendering them all keeps every image preloaded so swaps never flicker. */}
      <div className="absolute inset-0">
        {MASCOT_IMAGES.map((src, i) => (
          <motion.div
            key={src}
            className="absolute inset-0"
            initial={false}
            animate={{ opacity: i === activeIndex ? 1 : 0 }}
            transition={{ duration: 0.9, ease: "easeInOut" }}
          >
            <Image
              src={src}
              alt="Omnion — Omnicloud AI assistant"
              width={size}
              height={size * 1.22}
              style={{ objectFit: "contain", width: "100%", height: "100%" }}
              priority={i === 0}
              draggable={false}
            />
          </motion.div>
        ))}
      </div>

      {/* Accent particles */}
      {ACCENT_PARTICLES.map((p, i) => {
        const c = particleColor ?? p.color;
        return (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              width: p.size,
              height: p.size,
              background: c,
              top: p.top,
              left: p.side === "left" ? p.pos : undefined,
              right: p.side === "right" ? p.pos : undefined,
              boxShadow: `0 0 ${p.glow}px ${c}`,
            }}
            animate={{ y: [0, p.dy, 0], opacity: [Math.max(0, p.op - 0.3), p.op, Math.max(0, p.op - 0.3)] }}
            transition={{ duration: p.dur, repeat: Infinity, delay: p.delay }}
          />
        );
      })}
    </motion.div>
  );
}
