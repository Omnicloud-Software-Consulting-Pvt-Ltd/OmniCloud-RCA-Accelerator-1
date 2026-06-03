"use client";

import { motion } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";
import Image from "next/image";
import type { MascotMood } from "@/lib/auth/types";

interface OmnionMascotProps {
  className?: string;
  size?: number;
  mood?: MascotMood;
}

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

export function OmnionMascot({
  className = "",
  size = 320,
  mood = "float",
}: OmnionMascotProps) {
  const { animate, transition } = moodConfig[mood];
  const glowColor = glowColors[mood];

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

      {/* Actual Omnion mascot image — unmodified */}
      <Image
        src="/omnion.png"
        alt="Omnion — Omnicloud AI assistant"
        width={size}
        height={size * 1.22}
        style={{ objectFit: "contain", width: "100%", height: "100%" }}
        priority
        draggable={false}
      />

      {/* Accent particles */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 7,
          height: 7,
          background: "#00D4FF",
          top: "38%",
          left: "8%",
          boxShadow: "0 0 8px #00D4FF",
        }}
        animate={{ y: [0, -10, 0], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 3.2, repeat: Infinity, delay: 0.4 }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 6,
          height: 6,
          background: "#3AABFF",
          top: "28%",
          right: "8%",
          boxShadow: "0 0 8px #3AABFF",
        }}
        animate={{ y: [0, -12, 0], opacity: [0.65, 0.95, 0.65] }}
        transition={{ duration: 4.1, repeat: Infinity, delay: 1.1 }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 5,
          height: 5,
          background: "#1E90FF",
          top: "58%",
          right: "5%",
          boxShadow: "0 0 6px #1E90FF",
        }}
        animate={{ y: [0, -8, 0], opacity: [0.55, 0.85, 0.55] }}
        transition={{ duration: 3.6, repeat: Infinity, delay: 1.8 }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 5,
          height: 5,
          background: "#00D4FF",
          top: "62%",
          left: "6%",
          boxShadow: "0 0 6px #00D4FF",
        }}
        animate={{ y: [0, -10, 0], opacity: [0.55, 0.85, 0.55] }}
        transition={{ duration: 5.0, repeat: Infinity, delay: 2.3 }}
      />
    </motion.div>
  );
}
