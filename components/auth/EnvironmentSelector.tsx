"use client";

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { type Environment } from "@/lib/utils";

interface EnvironmentSelectorProps {
  value: Environment;
  onChange: (env: Environment) => void;
  className?: string;
}

const ENVIRONMENTS: { id: Environment; label: string; description: string; icon: string }[] = [
  {
    id: "sandbox",
    label: "Sandbox",
    description: "Safe testing environment",
    icon: "⬡",
  },
  {
    id: "production",
    label: "Production/Dev",
    description: "Production or Developer org",
    icon: "◈",
  },
];

// Sandbox = amber, Production/Dev = green
const AMBER = "#F5A623";
const GREEN = "#00C875";

export function EnvironmentSelector({ value, onChange, className }: EnvironmentSelectorProps) {
  const isSandbox = value === "sandbox";
  return (
    <div className={cn("w-full", className)}>
      <p className="text-[11px] font-medium tracking-widest uppercase mb-3"
         style={{ color: "var(--text-muted)" }}>
        Environment
      </p>

      <div
        className="relative flex rounded-xl p-1"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(30,144,255,0.15)",
        }}
      >
        {/* Sliding highlight */}
        <motion.div
          className="absolute inset-y-1 rounded-lg"
          style={{
            width: "calc(50% - 4px)",
            background: isSandbox
              ? "linear-gradient(135deg, rgba(245,166,35,0.24) 0%, rgba(255,193,7,0.14) 100%)"
              : "linear-gradient(135deg, rgba(0,200,117,0.22) 0%, rgba(0,212,255,0.12) 100%)",
            border: isSandbox
              ? "1px solid rgba(245,166,35,0.4)"
              : "1px solid rgba(0,200,117,0.4)",
            boxShadow: isSandbox
              ? "0 0 16px rgba(245,166,35,0.22), inset 0 1px 0 rgba(255,255,255,0.08)"
              : "0 0 16px rgba(0,200,117,0.2), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
          animate={{
            x: isSandbox ? 4 : "calc(100% + 0px)",
          }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
        />

        {ENVIRONMENTS.map((env) => {
          const isActive = value === env.id;
          const accent = env.id === "sandbox" ? AMBER : GREEN;
          return (
            <button
              key={env.id}
              onClick={() => onChange(env.id)}
              className="relative z-10 flex-1 flex flex-col items-center gap-0.5 py-2.5 px-3 rounded-lg cursor-pointer select-none transition-all duration-200"
              style={{
                color: isActive ? accent : "var(--text-muted)",
              }}
            >
              <div className="flex items-center gap-1.5">
                <AnimatePresence>
                  {isActive && (
                    <motion.span
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0, opacity: 0 }}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
                    />
                  )}
                </AnimatePresence>
                <span className="text-sm font-semibold">{env.label}</span>
              </div>
              <span className="text-[10px] opacity-60 font-normal">{env.description}</span>
            </button>
          );
        })}
      </div>

      {/* Environment indicator strip */}
      <AnimatePresence mode="wait">
        <motion.div
          key={value}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mt-2 flex items-center gap-2 px-1"
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: isSandbox ? AMBER : GREEN,
              boxShadow: `0 0 6px ${isSandbox ? "rgba(245,166,35,0.6)" : "rgba(0,200,117,0.6)"}`,
            }}
          />
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Connecting to{" "}
            <span className="font-medium" style={{ color: isSandbox ? AMBER : GREEN }}>
              {isSandbox ? "Sandbox" : "Production/Dev"}
            </span>{" "}
            Salesforce org
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
