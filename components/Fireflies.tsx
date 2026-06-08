"use client";

import { motion } from "framer-motion";

// Subtle ambient "fireflies" — slow-drifting, twinkling cyan dots.
// Ported from the OmniCloud website. Positions are fixed (no randomness) to
// avoid SSR hydration mismatches. Reusable across heroes/sections; pass a
// z-index via `className` and an accent via `color`.
const FIREFLIES = [
  // Row 1 (top edge)
  { left: "8%",  top: "9%",  size: 6, delay: 0.0, dur: 5,   dx: 28,  dy: -30, max: 0.58 },
  { left: "24%", top: "6%",  size: 4, delay: 1.2, dur: 6,   dx: -22, dy: 26,  max: 0.44 },
  { left: "40%", top: "12%", size: 5, delay: 0.6, dur: 4.5, dx: 30,  dy: 24,  max: 0.55 },
  { left: "56%", top: "8%",  size: 7, delay: 2.0, dur: 5.5, dx: -26, dy: -28, max: 0.64 },
  { left: "72%", top: "10%", size: 4, delay: 1.5, dur: 6.5, dx: 24,  dy: 30,  max: 0.42 },
  { left: "88%", top: "6%",  size: 6, delay: 0.3, dur: 4.5, dx: -30, dy: 22,  max: 0.58 },
  // Row 2
  { left: "4%",  top: "30%", size: 5, delay: 0.9, dur: 5,   dx: 26,  dy: -32, max: 0.52 },
  { left: "22%", top: "33%", size: 4, delay: 2.2, dur: 6,   dx: -24, dy: 28,  max: 0.44 },
  { left: "38%", top: "27%", size: 6, delay: 0.7, dur: 4,   dx: 32,  dy: 26,  max: 0.60 },
  { left: "57%", top: "31%", size: 4, delay: 2.6, dur: 5.5, dx: -28, dy: -24, max: 0.45 },
  { left: "74%", top: "28%", size: 7, delay: 0.4, dur: 4.5, dx: 26,  dy: 30,  max: 0.64 },
  { left: "92%", top: "32%", size: 4, delay: 1.6, dur: 6,   dx: -22, dy: -30, max: 0.42 },
  // Row 3 (middle)
  { left: "9%",  top: "50%", size: 5, delay: 1.0, dur: 5,   dx: 30,  dy: 24,  max: 0.54 },
  { left: "26%", top: "47%", size: 4, delay: 2.8, dur: 4.5, dx: -26, dy: -28, max: 0.46 },
  { left: "43%", top: "53%", size: 6, delay: 0.5, dur: 4,   dx: 28,  dy: 30,  max: 0.58 },
  { left: "58%", top: "48%", size: 4, delay: 1.9, dur: 6,   dx: -30, dy: 22,  max: 0.44 },
  { left: "75%", top: "52%", size: 5, delay: 0.8, dur: 5,   dx: 24,  dy: 28,  max: 0.52 },
  { left: "90%", top: "46%", size: 6, delay: 2.4, dur: 4.5, dx: -28, dy: -26, max: 0.56 },
  // Row 4
  { left: "5%",  top: "70%", size: 4, delay: 1.3, dur: 5.5, dx: 26,  dy: 30,  max: 0.46 },
  { left: "23%", top: "73%", size: 6, delay: 3.0, dur: 4.5, dx: -24, dy: -28, max: 0.56 },
  { left: "41%", top: "67%", size: 5, delay: 0.2, dur: 5,   dx: 30,  dy: 24,  max: 0.54 },
  { left: "56%", top: "71%", size: 4, delay: 2.1, dur: 6,   dx: -26, dy: 28,  max: 0.44 },
  { left: "73%", top: "69%", size: 6, delay: 1.4, dur: 4.5, dx: 28,  dy: -30, max: 0.58 },
  { left: "91%", top: "72%", size: 4, delay: 0.6, dur: 5.5, dx: -22, dy: 26,  max: 0.45 },
  // Row 5 (bottom edge)
  { left: "11%", top: "90%", size: 5, delay: 1.7, dur: 5,   dx: 28,  dy: -26, max: 0.52 },
  { left: "27%", top: "94%", size: 4, delay: 2.5, dur: 4.5, dx: -30, dy: 24,  max: 0.44 },
  { left: "42%", top: "88%", size: 6, delay: 0.9, dur: 4,   dx: 26,  dy: 30,  max: 0.58 },
  { left: "58%", top: "92%", size: 4, delay: 3.2, dur: 6,   dx: -24, dy: -28, max: 0.42 },
  { left: "74%", top: "90%", size: 5, delay: 1.1, dur: 5,   dx: 30,  dy: 26,  max: 0.54 },
  { left: "89%", top: "95%", size: 6, delay: 0.4, dur: 4.5, dx: -28, dy: -24, max: 0.56 },
];

// Second, mirrored pass for extra density (deterministic — no randomness).
const DENSE_FIREFLIES = [
  ...FIREFLIES,
  ...FIREFLIES.map((f) => ({
    ...f,
    left: `${100 - parseFloat(f.left)}%`,
    top: `${(parseFloat(f.top) + 13) % 100}%`,
    dx: -f.dx,
    delay: f.delay + 0.8,
    dur: f.dur + 0.6,
  })),
];

export default function Fireflies({
  className = "z-10",
  color = "#00D4FF",
  glow = "rgba(0, 181, 226, 0.55)",
}: {
  className?: string;
  color?: string;
  glow?: string;
}) {
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {DENSE_FIREFLIES.map((f, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full"
          style={{
            left: f.left,
            top: f.top,
            width: f.size,
            height: f.size,
            background: color,
            boxShadow: `0 0 8px 2px ${glow}`,
          }}
          animate={{ x: [0, f.dx, 0], y: [0, f.dy, 0], opacity: [0, f.max, 0] }}
          transition={{ duration: f.dur, delay: f.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
