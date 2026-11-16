"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Z, computePlacement, isInsideOverlay, type Placement, type PlacementOptions } from "@/lib/ui/overlay";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface AnchoredOverlayProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "style">, Partial<PlacementOptions> {
  /** The field/button the overlay belongs to — it's positioned against this element and clicks on it never count as "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Called on a pointer-down outside the anchor and the overlay, and on Escape. Omit to manage closing yourself. */
  onDismiss?: () => void;
  /** Escape closes the overlay (and is not passed on to an enclosing dialog). Default true when `onDismiss` is set. */
  closeOnEscape?: boolean;
  /** The overlay root scrolls itself (default). Pass false when the content has its own scroller + footer; it receives the placement. */
  scroll?: boolean;
  style?: CSSProperties;
  /** Exposes the overlay root (e.g. for scroll-into-view of the highlighted option). */
  overlayRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode | ((placement: Placement) => ReactNode);
}

/**
 * The shared foreground layer for every dropdown, lookup list, combobox, menu, popover and tooltip (see lib/ui/overlay.ts):
 *  - rendered through a portal into document.body, so no card `overflow: hidden`, scroll container, accordion or transformed
 *    ancestor can clip or cover it;
 *  - `position: fixed` at the anchor, re-measured on any scroll (capture — inner scroll containers too), resize, or anchor
 *    resize, so it stays aligned while the page moves; flips upward when there's more room above; height capped to the room;
 *  - layered at Z.popover — above cards and dialogs, below toasts;
 *  - pointer-down inside it doesn't steal focus from the field (blur-to-close lookups keep working, scrollbars are usable),
 *    except on form fields inside it (e.g. a search box in the menu);
 *  - outside pointer-down / Escape → `onDismiss`.
 * Nothing renders on the server or before the first measurement, so opening never shifts layout or flashes at 0,0.
 */
export default function AnchoredOverlay({
  anchorRef, open, onDismiss, closeOnEscape, scroll = true, style, overlayRef, children,
  maxHeight = 280, gap, margin, matchWidth = true, minWidth, align, onMouseDown, ...rest
}: AnchoredOverlayProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const rootRef = overlayRef ?? ownRef;
  const [placement, setPlacement] = useState<Placement | null>(null);
  const opts = useRef<PlacementOptions>({ maxHeight });
  opts.current = { maxHeight, gap, margin, matchWidth, minWidth, align };
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useIsoLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    let frame = 0;
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPlacement(computePlacement(r, { width: window.innerWidth, height: window.innerHeight }, opts.current));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (ro && anchorRef.current) ro.observe(anchorRef.current);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); ro?.disconnect(); };
  }, [open, anchorRef, maxHeight, gap, margin, matchWidth, minWidth, align]);

  const escapes = closeOnEscape ?? !!onDismiss;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!isInsideOverlay(e.target, anchorRef.current, rootRef.current)) dismiss.current?.(); };
    // On document (bubble), so the field's own key handling runs first and an enclosing dialog's window-level Escape doesn't also fire.
    const onKey = (e: KeyboardEvent) => { if (escapes && e.key === "Escape" && dismiss.current) { e.stopPropagation(); dismiss.current(); } };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer, true); document.removeEventListener("keydown", onKey); };
  }, [open, anchorRef, rootRef, escapes]);

  if (!open || !placement || typeof document === "undefined") return null;
  const box: CSSProperties = {
    position: "fixed", zIndex: Z.popover, boxSizing: "border-box",
    left: placement.left, top: placement.top, bottom: placement.bottom, width: placement.width, minWidth: placement.minWidth,
    maxWidth: `calc(100vw - ${2 * (margin ?? 8)}px)`, maxHeight: placement.maxHeight,
    ...(scroll ? { overflowY: "auto" } : { display: "flex", flexDirection: "column" }),
    ...style,
  };
  return createPortal(
    <div
      {...rest}
      ref={rootRef}
      data-overlay=""
      data-side={placement.side}
      style={box}
      onMouseDown={e => {
        if (!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) e.preventDefault();
        onMouseDown?.(e);
      }}
    >
      {typeof children === "function" ? children(placement) : children}
    </div>,
    document.body,
  );
}
