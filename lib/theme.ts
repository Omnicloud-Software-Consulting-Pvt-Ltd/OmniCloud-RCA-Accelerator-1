/**
 * Omnicloud Platform — Unified Blue AI Design System
 * Single source of truth for all design tokens.
 * Import T (dark) or TL (light) helpers for mode-aware values.
 */

// ─── CORE PALETTE ────────────────────────────────────────────────────────────

export const palette = {
  // Electric blue scale — primary brand
  blue50:  "#E8F4FF",
  blue100: "#C8E5FF",
  blue200: "#9ACFFF",
  blue300: "#60B8FF",
  blue400: "#3AABFF",
  blue500: "#1E90FF",  // Primary
  blue600: "#0070D6",
  blue700: "#0054AB",
  blue800: "#0047AB",
  blue900: "#003380",
  blue950: "#001F5B",

  // Cyan accent scale
  cyan300: "#7DE8FF",
  cyan400: "#29CFEE",
  cyan500: "#00D4FF",  // Accent cyan
  cyan600: "#00B8E0",
  cyan700: "#0096BC",

  // Dark void backgrounds
  void600: "#000508",
  void500: "#01060D",
  void400: "#020810",
  void300: "#030A14",
  void200: "#050C18",
  void100: "#070F1E",
  void50:  "#0A1628",

  // Light cloud backgrounds
  cloud50:  "#F5F8FF",
  cloud100: "#EEF3FF",
  cloud200: "#E4EDFF",
  cloud300: "#D0E2FF",
  cloud400: "#B3CCFF",

  // Semantic — used ONLY for status indicators
  success: "#00C875",   // blue-tinted green
  warning: "#F59E0B",   // amber
  error:   "#FF4066",   // red
} as const;

// ─── DARK MODE TOKENS ────────────────────────────────────────────────────────

export const dark = {
  // Backgrounds
  bgPage:     "linear-gradient(160deg, #000508 0%, #010918 60%, #000305 100%)",
  bgSurface:  "rgba(5,12,24,0.65)",
  bgElevated: "rgba(7,15,30,0.75)",
  bgCard:     "rgba(3,9,20,0.55)",
  bgInput:    "rgba(0,212,255,0.04)",
  bgHover:    "rgba(30,144,255,0.07)",
  bgSelected: "rgba(30,144,255,0.14)",
  bgActive:   "rgba(30,144,255,0.18)",

  // Borders
  borderSubtle:  "rgba(30,144,255,0.10)",
  borderDefault: "rgba(30,144,255,0.18)",
  borderStrong:  "rgba(30,144,255,0.30)",
  borderFocus:   "rgba(0,212,255,0.50)",

  // Glows
  glowPrimary: "rgba(30,144,255,0.40)",
  glowCyan:    "rgba(0,212,255,0.35)",
  glowSoft:    "rgba(30,144,255,0.20)",

  // Text
  textPrimary:   "rgba(255,255,255,0.95)",
  textSecondary: "rgba(160,200,240,0.80)",
  textMuted:     "rgba(100,145,195,0.65)",
  textDisabled:  "rgba(50,90,140,0.45)",
  textAccent:    "#00D4FF",
  textBrand:     "#3AABFF",

  // Nav / sidebar
  navBg:     "rgba(1,9,24,0.85)",
  sidebarBg: "rgba(0,5,14,0.70)",

  // Ambient grid
  gridLine: "rgba(0,212,255,0.025)",
  dotColor: "rgba(30,144,255,0.15)",
} as const;

// ─── LIGHT MODE TOKENS ───────────────────────────────────────────────────────

export const light = {
  // Backgrounds
  bgPage:     "linear-gradient(160deg, #EEF3FF 0%, #F5F8FF 60%, #E4EDFF 100%)",
  bgSurface:  "rgba(255,255,255,0.80)",
  bgElevated: "rgba(240,247,255,0.92)",
  bgCard:     "rgba(255,255,255,0.90)",
  bgInput:    "rgba(0,71,171,0.04)",
  bgHover:    "rgba(0,71,171,0.05)",
  bgSelected: "rgba(30,144,255,0.10)",
  bgActive:   "rgba(30,144,255,0.15)",

  // Borders
  borderSubtle:  "rgba(0,71,171,0.12)",
  borderDefault: "rgba(0,71,171,0.20)",
  borderStrong:  "rgba(0,71,171,0.35)",
  borderFocus:   "rgba(0,112,214,0.55)",

  // Glows
  glowPrimary: "rgba(16,112,204,0.20)",
  glowCyan:    "rgba(0,152,204,0.18)",
  glowSoft:    "rgba(0,71,171,0.12)",

  // Text — high contrast, accessible
  textPrimary:   "rgba(0,16,51,0.95)",
  textSecondary: "rgba(0,52,128,0.80)",
  textMuted:     "rgba(0,71,171,0.60)",
  textDisabled:  "rgba(80,130,200,0.45)",
  textAccent:    "#0070D6",
  textBrand:     "#003380",

  // Nav / sidebar
  navBg:     "rgba(248,251,255,0.92)",
  sidebarBg: "rgba(240,247,255,0.94)",

  // Ambient grid
  gridLine: "rgba(0,71,171,0.025)",
  dotColor: "rgba(0,71,171,0.12)",
} as const;

// ─── CATEGORY COLOR MAPS — all blue tones ────────────────────────────────────

/** Attribute category → blue-family color */
export const attrCatColors: Record<string, string> = {
  Identity:     "#1E90FF",
  Display:      "#00D4FF",
  Performance:  "#3AABFF",
  Connectivity: "#0070D6",
  Design:       "#2563EB",
  Power:        "#0047AB",
  Sensors:      "#60B8FF",
  Software:     "#29A8E0",
  Audio:        "#1565C0",
  Camera:       "#4299E1",
  Licensing:    "#0D47A1",
  Billing:      "#1976D2",
};

/** Data type → blue-family color + bg */
export const dataTypeColors: Record<string, { color: string; bg: string }> = {
  Picklist: { color: "#1E90FF", bg: "rgba(30,144,255,0.13)" },
  Number:   { color: "#00D4FF", bg: "rgba(0,212,255,0.12)" },
  Boolean:  { color: "#3AABFF", bg: "rgba(58,171,255,0.12)" },
  Checkbox: { color: "#3AABFF", bg: "rgba(58,171,255,0.12)" },
  Text:     { color: "#0070D6", bg: "rgba(0,112,214,0.11)" },
  Date:     { color: "#60B8FF", bg: "rgba(96,184,255,0.12)" },
};

/** Dependency rule type → blue-family color */
export const depTypeColors: Record<string, string> = {
  AUTO_ADD:   "#00D4FF",
  DEPENDS_ON: "#1E90FF",
  REQUIRES:   "#3AABFF",
  EXCLUDES:   "#FF4066",  // semantic — exclusion is destructive
};

/** Bundle status → semantic color */
export const statusColors: Record<string, string> = {
  success: "#00C875",
  error:   "#FF4066",
  running: "#00D4FF",
  pending: "rgba(90,122,154,0.35)",
};

/** Log level → color */
export const logColors: Record<string, string> = {
  success: "#00C875",
  error:   "#FF4066",
  warning: "#F59E0B",
  info:    "#00D4FF",
};

// ─── MODE-AWARE HELPERS ───────────────────────────────────────────────────────

/** Returns the correct token set for the current mode */
export function tokens(isDark: boolean) {
  return isDark ? dark : light;
}

/** Returns a blue-family action accent — replacing old rainbow accents */
export function actionAccent(hue: "primary" | "secondary" | "tertiary" | "deep" | "cyan"): string {
  switch (hue) {
    case "primary":   return "#1E90FF";
    case "secondary": return "#3AABFF";
    case "tertiary":  return "#60B8FF";
    case "deep":      return "#0047AB";
    case "cyan":      return "#00D4FF";
  }
}

/** Standard ambient particle colors for background decorations */
export const ambientParticles = ["#1E90FF", "#00D4FF", "#3AABFF", "#60B8FF"];

/** Standard action accent palette (replaces old mixed-color arrays) */
export const actionAccents = {
  create:   "#1E90FF",
  import:   "#3AABFF",
  update:   "#00D4FF",
  clone:    "#0070D6",
  view:     "#60B8FF",
  deploy:   "#0047AB",
  generate: "#00D4FF",
  alert:    "#F59E0B",   // semantic warning
  delete:   "#FF4066",   // semantic error
} as const;
