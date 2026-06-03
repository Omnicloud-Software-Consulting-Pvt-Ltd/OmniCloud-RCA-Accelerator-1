"use client";

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { type Environment } from "@/lib/utils";

interface SalesforceButtonProps {
  environment: Environment;
  onClick: () => void;
  loading?: boolean;
  className?: string;
}

function SalesforceIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <path
        d="M20 36a8 8 0 0 1-2.83-15.47A10 10 0 0 1 36 18.4a6 6 0 0 1 .5 11.6H20z"
        fill="white"
        opacity="0.95"
      />
      <path d="M25 22l-4 6h4l-3.5 6 8-8h-4.5l4-4z" fill="#0070D6" />
    </svg>
  );
}

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="7" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
      <path d="M9 2a7 7 0 0 1 7 7" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SalesforceButton({
  environment,
  onClick,
  loading = false,
  className,
}: SalesforceButtonProps) {
  const isProduction = environment === "production";

  return (
    <motion.button
      onClick={onClick}
      disabled={loading}
      className={cn(
        "relative w-full overflow-hidden rounded-xl",
        "flex items-center justify-center gap-3",
        "py-3.5 px-6 font-semibold text-white text-sm",
        "cursor-pointer select-none",
        "disabled:cursor-wait",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        className
      )}
      style={{
        background: isProduction
          ? "linear-gradient(135deg, #0047AB 0%, #0070D6 50%, #1E90FF 100%)"
          : "linear-gradient(135deg, #0052CC 0%, #0070D6 50%, #0040A8 100%)",
        boxShadow: isProduction
          ? "0 4px 20px rgba(0,112,214,0.4), inset 0 1px 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(0,0,0,0.2)"
          : "0 4px 20px rgba(0,112,214,0.4), inset 0 1px 0 rgba(255,255,255,0.15), inset 0 -1px 0 rgba(0,0,0,0.2)",
        opacity: loading ? 0.85 : 1,
      }}
      whileHover={!loading ? { scale: 1.015, y: -1 } : {}}
      whileTap={!loading ? { scale: 0.985, y: 0 } : {}}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
    >
      {/* Shimmer overlay */}
      <motion.div
        className="absolute inset-0 opacity-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 50%, transparent 100%)",
        }}
        whileHover={!loading ? { opacity: 1 } : {}}
      />

      {/* Scanline texture */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.018) 2px, rgba(0,0,0,0.018) 4px)",
        }}
      />

      {/* Content — swaps between normal and loading */}
      <AnimatePresence mode="wait" initial={false}>
        {loading ? (
          <motion.span
            key="loading"
            className="flex items-center gap-2.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <MiniSpinner />
            <span className="text-sm font-medium">Connecting to Salesforce…</span>
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            className="flex items-center gap-3 w-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <SalesforceIcon size={20} />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-[11px] opacity-70 font-normal -mb-0.5">Continue with</span>
              <span className="text-[15px] font-bold tracking-tight">
                Salesforce {isProduction ? "Production" : "Sandbox"}
              </span>
            </span>
            {/* External link / popup indicator */}
            <svg
              width="11"
              height="11"
              viewBox="0 0 11 11"
              fill="none"
              className="ml-auto opacity-55"
            >
              <path
                d="M2 9L9 2M9 2H5.5M9 2V5.5"
                stroke="white"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>

      {/* Bottom edge highlight */}
      <div
        className="absolute inset-x-0 bottom-0 h-px opacity-30 pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
        }}
      />
    </motion.button>
  );
}
