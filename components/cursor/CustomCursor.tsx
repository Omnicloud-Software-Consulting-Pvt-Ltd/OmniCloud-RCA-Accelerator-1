"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";

type CursorVariant = "default" | "hover" | "text";

interface Burst {
  id: number;
  x: number;
  y: number;
  particles: { dx: number; dy: number }[];
}

const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], select, summary, label, [data-cursor="pointer"], .cursor-pointer, [tabindex]:not([tabindex="-1"]), input[type="checkbox"], input[type="radio"], input[type="submit"], input[type="button"]';

const TEXT_SELECTOR =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea, [contenteditable="true"]';

const IDLE_DELAY_MS = 1300;
const BURST_LIFETIME_MS = 500;

// Magnetic pull: nudge the cursor's target position a fraction of the way
// toward the hovered element's center, capped so it reads as attraction
// rather than a jump/snap onto the element.
const MAGNETIC_PULL = 0.25;
const MAGNETIC_MAX_PX = 9;

export default function CustomCursor() {
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [variant, setVariant] = useState<CursorVariant>("default");
  const [idle, setIdle] = useState(false);
  const [bursts, setBursts] = useState<Burst[]>([]);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstIdRef = useRef(0);
  const magneticRectRef = useRef<DOMRect | null>(null);

  const x = useMotionValue(-100);
  const y = useMotionValue(-100);

  // Core: fast, high-stiffness spring — glides, never snaps, minimal lag.
  const coreX = useSpring(x, { damping: 30, stiffness: 700, mass: 0.35 });
  const coreY = useSpring(y, { damping: 30, stiffness: 700, mass: 0.35 });

  // Aura: a touch softer — small, natural trailing float behind the core.
  const glowX = useSpring(x, { damping: 24, stiffness: 260, mass: 0.55 });
  const glowY = useSpring(y, { damping: 24, stiffness: 260, mass: 0.55 });

  // Energy trail: at most two progressively softer layers, chained off the
  // aura (not the raw pointer) so they stay close and read as one dissolving
  // streak rather than separate beads strung out behind the cursor.
  const trail1X = useSpring(glowX, { damping: 22, stiffness: 190, mass: 0.6 });
  const trail1Y = useSpring(glowY, { damping: 22, stiffness: 190, mass: 0.6 });
  const trail2X = useSpring(trail1X, { damping: 22, stiffness: 150, mass: 0.7 });
  const trail2Y = useSpring(trail1Y, { damping: 22, stiffness: 150, mass: 0.7 });

  // Detect device/motion capability, and keep it in sync if it changes.
  useEffect(() => {
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

    const evaluate = () => {
      setEnabled(!reducedMotionQuery.matches && !coarsePointerQuery.matches);
    };
    evaluate();

    const handleTouch = () => setEnabled(false);

    reducedMotionQuery.addEventListener("change", evaluate);
    coarsePointerQuery.addEventListener("change", evaluate);
    window.addEventListener("touchstart", handleTouch, { passive: true });

    return () => {
      reducedMotionQuery.removeEventListener("change", evaluate);
      coarsePointerQuery.removeEventListener("change", evaluate);
      window.removeEventListener("touchstart", handleTouch);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("custom-cursor-active", enabled);
    return () => document.documentElement.classList.remove("custom-cursor-active");
  }, [enabled]);

  const resetIdleTimer = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_DELAY_MS);
  }, []);

  const spawnBurst = useCallback((clientX: number, clientY: number) => {
    const id = ++burstIdRef.current;
    const count = 3;
    const particles = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const distance = 10 + Math.random() * 6;
      return { dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance };
    });
    setBursts((prev) => [...prev, { id, x: clientX, y: clientY, particles }]);
    setTimeout(() => {
      setBursts((prev) => prev.filter((b) => b.id !== id));
    }, BURST_LIFETIME_MS);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleMove = (e: PointerEvent) => {
      let targetX = e.clientX;
      let targetY = e.clientY;

      const rect = magneticRectRef.current;
      if (rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = (cx - e.clientX) * MAGNETIC_PULL;
        let dy = (cy - e.clientY) * MAGNETIC_PULL;
        const dist = Math.hypot(dx, dy);
        if (dist > MAGNETIC_MAX_PX) {
          const scale = MAGNETIC_MAX_PX / dist;
          dx *= scale;
          dy *= scale;
        }
        targetX += dx;
        targetY += dy;
      }

      x.set(targetX);
      y.set(targetY);
      setVisible(true);
      resetIdleTimer();
    };
    const handleOver = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest) return;
      const textEl = target.closest(TEXT_SELECTOR);
      const interactiveEl = target.closest(INTERACTIVE_SELECTOR);
      if (textEl) {
        setVariant("text");
        magneticRectRef.current = null;
      } else if (interactiveEl) {
        setVariant("hover");
        magneticRectRef.current = interactiveEl.getBoundingClientRect();
      } else {
        setVariant("default");
        magneticRectRef.current = null;
      }
    };
    const handleDown = (e: PointerEvent) => spawnBurst(e.clientX, e.clientY);
    const handleLeaveWindow = () => setVisible(false);
    const handleEnterWindow = () => setVisible(true);
    const handleVisibility = () => {
      if (document.hidden) setVisible(false);
    };

    window.addEventListener("pointermove", handleMove, { passive: true });
    window.addEventListener("pointerover", handleOver, { passive: true });
    window.addEventListener("pointerdown", handleDown, { passive: true });
    window.addEventListener("mouseleave", handleLeaveWindow);
    window.addEventListener("mouseenter", handleEnterWindow);
    document.addEventListener("visibilitychange", handleVisibility);

    idleTimer.current = setTimeout(() => setIdle(true), IDLE_DELAY_MS);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerover", handleOver);
      window.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("mouseleave", handleLeaveWindow);
      window.removeEventListener("mouseenter", handleEnterWindow);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [enabled, resetIdleTimer, spawnBurst, x, y]);

  if (!enabled) return null;

  return (
    <div className={`omni-cursor ${visible ? "" : "is-hidden"}`} aria-hidden="true">
      <motion.div className="omni-cursor__trail" style={{ x: trail2X, y: trail2Y }} />
      <motion.div className="omni-cursor__trail" style={{ x: trail1X, y: trail1Y }} />

      <motion.div
        className={`omni-cursor__glow ${idle ? "is-idle" : ""}`}
        data-variant={variant}
        style={{ x: glowX, y: glowY }}
      />

      <motion.div className="omni-cursor__core" data-variant={variant} style={{ x: coreX, y: coreY }}>
        <span className="omni-cursor__core-dot" />
        <span className="omni-cursor__hover-ring" />
      </motion.div>

      <AnimatePresence>
        {bursts.map((burst) => (
          <div key={burst.id} className="omni-cursor__burst">
            <motion.span
              className="omni-cursor__flash"
              style={{ left: burst.x, top: burst.y }}
              initial={{ opacity: 1, scale: 0.2 }}
              animate={{ opacity: 0, scale: 1.3 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            />
            <motion.span
              className="omni-cursor__ripple"
              style={{ left: burst.x, top: burst.y }}
              initial={{ opacity: 0.6, scale: 0.4 }}
              animate={{ opacity: 0, scale: 1.9 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            />
            {burst.particles.map((p, i) => (
              <motion.span
                key={i}
                className="omni-cursor__particle"
                style={{ left: burst.x, top: burst.y }}
                initial={{ opacity: 0.8, x: 0, y: 0, scale: 1 }}
                animate={{ opacity: 0, x: p.dx, y: p.dy, scale: 0.3 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            ))}
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
