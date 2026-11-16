/**
 * Global overlay layering + anchored placement — the one place the app decides what sits above what, and where a dropdown
 * opens. Pure (no DOM), so the placement rules are unit-tested; components/ui/AnchoredOverlay.tsx applies them.
 *
 * Why dropdowns are portaled: cards (`Section`, panels) use `overflow: hidden` for their rounded corners, and animated
 * containers (framer-motion transforms, backdrop-filter) create stacking/containing blocks. An `absolute` list rendered inside
 * them is clipped at the card edge no matter its z-index, and a `fixed` one is positioned against the transformed ancestor. So
 * every dropdown, lookup list, menu, popover and tooltip renders into document.body (outside every card) at `Z.popover`.
 *
 * Layering, bottom → top:
 *   raised   10    in-flow elevation inside a card (sticky table cells, overlapping badges)
 *   header   20    app/page headers
 *   dialog   60    full-screen modals, drawers and their backdrops
 *   dialogNested 100  a dialog opened from inside another dialog
 *   popover  1000  dropdowns, lookups, comboboxes, menus, popovers, tooltips — portaled, transient, so they sit above every
 *                  dialog: a lookup inside a modal is always visible
 *   toast    1100  toasts and notifications — always on top
 * Use these tokens instead of literal z-index numbers.
 */
export const Z = {
  raised: 10,
  header: 20,
  dialog: 60,
  dialogNested: 100,
  popover: 1000,
  toast: 1100,
} as const;

/**
 * The shared look of a floating list/menu/tip in both themes. Fully opaque — card surfaces are slightly translucent, which is
 * fine inside a card but lets whatever is underneath bleed through a portaled overlay.
 */
export function overlayPanelStyle(isDark: boolean, border: string): { background: string; border: string; borderRadius: number; boxShadow: string } {
  return {
    background: isDark ? "#06102a" : "#ffffff",
    border: `1px solid ${border}`,
    borderRadius: 9,
    boxShadow: isDark ? "0 12px 32px rgba(0,0,0,0.55)" : "0 10px 28px rgba(15,35,80,0.22)",
  };
}

export interface AnchorRect { top: number; bottom: number; left: number; right: number; width: number }
export interface Viewport { width: number; height: number }

export interface PlacementOptions {
  /** Preferred maximum height of the overlay; it shrinks to the space available on the side it opens. */
  maxHeight: number;
  /** Gap between anchor and overlay (px). */
  gap?: number;
  /** Minimum distance kept from the viewport edges (px). */
  margin?: number;
  /** Match the anchor's width (lookups/selects) — otherwise the overlay sizes to its content (menus, tips). */
  matchWidth?: boolean;
  /** Lower bound for the width; also used as the assumed width of content-sized overlays when aligning. */
  minWidth?: number;
  /** Align the overlay's start (left) or end (right) edge with the anchor. */
  align?: "start" | "end";
}

export interface Placement {
  side: "bottom" | "top";
  /** CSS `top` when opening down, CSS `bottom` when opening up (so the list grows away from the field). */
  top?: number;
  bottom?: number;
  left: number;
  width?: number;
  minWidth?: number;
  maxHeight: number;
}

/** Smallest list height worth opening into, even when both sides are cramped. */
const MIN_USABLE_HEIGHT = 96;

/**
 * Where an anchored overlay goes: below the anchor when its preferred height fits, otherwise on whichever side has more room
 * (opens upward near the bottom of the viewport); height capped to that room; horizontally kept inside the viewport.
 */
export function computePlacement(anchor: AnchorRect, viewport: Viewport, o: PlacementOptions): Placement {
  const gap = o.gap ?? 4, margin = o.margin ?? 8;
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const side: Placement["side"] = below >= o.maxHeight || below >= above ? "bottom" : "top";
  const room = side === "bottom" ? below : above;
  const maxHeight = Math.max(Math.min(o.maxHeight, room), Math.min(o.maxHeight, MIN_USABLE_HEIGHT));

  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const width = o.matchWidth ? Math.min(Math.max(anchor.width, o.minWidth ?? 0), maxWidth) : undefined;
  const assumed = width ?? Math.min(o.minWidth ?? 0, maxWidth);
  const rawLeft = o.align === "end" ? anchor.right - assumed : anchor.left;
  const left = Math.round(Math.max(margin, Math.min(rawLeft, viewport.width - margin - assumed)));

  return {
    side,
    ...(side === "bottom" ? { top: Math.round(anchor.bottom + gap) } : { bottom: Math.round(viewport.height - anchor.top + gap) }),
    left,
    ...(width !== undefined ? { width: Math.round(width) } : {}),
    ...(o.minWidth && width === undefined ? { minWidth: Math.min(o.minWidth, maxWidth) } : {}),
    maxHeight: Math.round(maxHeight),
  };
}

/** True when a pointer target is inside the anchor or inside any portaled overlay — i.e. NOT an outside click. */
export function isInsideOverlay(target: EventTarget | null, ...roots: Array<{ contains(n: Node): boolean } | null | undefined>): boolean {
  const node = target as Node | null;
  if (!node) return false;
  return roots.some(r => !!r && r.contains(node));
}
