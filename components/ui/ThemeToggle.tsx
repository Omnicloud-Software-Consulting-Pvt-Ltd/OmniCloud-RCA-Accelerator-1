"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function ThemeToggle({ className, size = "md" }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        className={cn(
          "rounded-full bg-white/5 border border-white/10",
          size === "sm" && "w-8 h-8",
          size === "md" && "w-10 h-10",
          size === "lg" && "w-12 h-12",
          className
        )}
      />
    );
  }

  const isDark = theme === "dark";

  return (
    <motion.button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "relative flex items-center justify-center rounded-full",
        "border transition-all duration-300",
        "cursor-pointer select-none overflow-hidden",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60",
        isDark
          ? "bg-white/5 border-white/10 hover:bg-white/10 hover:border-brand-500/40"
          : "bg-black/5 border-black/10 hover:bg-black/10 hover:border-brand-800/40",
        size === "sm" && "w-8 h-8",
        size === "md" && "w-10 h-10",
        size === "lg" && "w-12 h-12",
        className
      )}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <AnimatePresence mode="wait" initial={false}>
        {isDark ? (
          <motion.div
            key="sun"
            initial={{ rotate: -90, scale: 0, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: 90, scale: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <SunIcon size={size} />
          </motion.div>
        ) : (
          <motion.div
            key="moon"
            initial={{ rotate: 90, scale: 0, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: -90, scale: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <MoonIcon size={size} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

function SunIcon({ size }: { size: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? 14 : size === "md" ? 18 : 22;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#3AABFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
  );
}

function MoonIcon({ size }: { size: "sm" | "md" | "lg" }) {
  const s = size === "sm" ? 14 : size === "md" ? 18 : 22;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#1E90FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  );
}
