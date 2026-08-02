import type { Config } from "tailwindcss";

// Tailwind v4: primary config via @theme in globals.css
// This file handles darkMode selector and content scanning only
const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // === OMNICLOUD BRAND PALETTE ===
        // Core brand from Omnion mascot identity
        brand: {
          50:  "#E8F4FF",
          100: "#C8E5FF",
          200: "#9ACFFF",
          300: "#5FB0FF",
          400: "#3399FF",
          500: "#1E90FF", // Primary brand blue
          600: "#0070D6",
          700: "#0054AB",
          800: "#0047AB", // Deep brand blue
          900: "#003380",
          950: "#001F5B", // Brand navy
        },
        // Accent palette
        cyan: {
          400: "#22DEFF",
          500: "#00D4FF", // Electric cyan accent
          600: "#00B8E0",
        },
        violet: {
          400: "#9D8FFA",
          500: "#7B6EF6", // AI purple accent
          600: "#5A48E8",
        },
        emerald: {
          400: "#34EFA8",
          500: "#00E5A0", // Success / active
          600: "#00C285",
        },
        amber: {
          400: "#FFB84D",
          500: "#FF9E00", // Warning
        },
        rose: {
          400: "#FF6B8A",
          500: "#FF4066", // Error / production
        },

        // === VOID SCALE (Dark backgrounds) ===
        void: {
          50:  "#0A1628",
          100: "#070F1E",
          200: "#050C18",
          300: "#030A14",
          400: "#020810",
          500: "#01060D", // Deepest void
          600: "#000508",
          700: "#000406",
          800: "#000304",
          900: "#000203",
          950: "#000102",
        },

        // === CLOUD SCALE (Surfaces) ===
        cloud: {
          50:  "#F5F8FF",
          100: "#EEF3FF",
          200: "#E4EDFF",
          300: "#D0E2FF",
          400: "#B3CCFF",
          500: "#8AB0F7",
          600: "#5A88E8",
          700: "#3A66C8",
          800: "#2549A0",
          900: "#163378",
          950: "#0B1E50",
        },

        // === SEMANTIC TOKENS ===
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },

      // === TYPOGRAPHY ===
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "JetBrains Mono", "Fira Code", "monospace"],
        display: ["var(--font-geist-sans)", "Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem", letterSpacing: "0.05em" }],
        xs:   ["0.75rem",  { lineHeight: "1rem",      letterSpacing: "0.025em" }],
        sm:   ["0.875rem", { lineHeight: "1.25rem",   letterSpacing: "0.01em" }],
        base: ["1rem",     { lineHeight: "1.5rem",    letterSpacing: "0em" }],
        lg:   ["1.125rem", { lineHeight: "1.75rem",   letterSpacing: "-0.01em" }],
        xl:   ["1.25rem",  { lineHeight: "1.75rem",   letterSpacing: "-0.015em" }],
        "2xl":["1.5rem",   { lineHeight: "2rem",      letterSpacing: "-0.02em" }],
        "3xl":["1.875rem", { lineHeight: "2.25rem",   letterSpacing: "-0.025em" }],
        "4xl":["2.25rem",  { lineHeight: "2.5rem",    letterSpacing: "-0.03em" }],
        "5xl":["3rem",     { lineHeight: "1",         letterSpacing: "-0.035em" }],
        "6xl":["3.75rem",  { lineHeight: "1",         letterSpacing: "-0.04em" }],
        "7xl":["4.5rem",   { lineHeight: "1",         letterSpacing: "-0.045em" }],
        "display-sm": ["2rem",   { lineHeight: "2.5rem",  letterSpacing: "-0.04em" }],
        "display-md": ["2.75rem",{ lineHeight: "3.25rem", letterSpacing: "-0.045em" }],
        "display-lg": ["3.75rem",{ lineHeight: "4.25rem", letterSpacing: "-0.05em" }],
        "display-xl": ["4.5rem", { lineHeight: "5rem",    letterSpacing: "-0.055em" }],
      },
      fontWeight: {
        thin:       "100",
        extralight: "200",
        light:      "300",
        normal:     "400",
        medium:     "500",
        semibold:   "600",
        bold:       "700",
        extrabold:  "800",
        black:      "900",
      },
      letterSpacing: {
        tightest: "-0.05em",
        tighter:  "-0.025em",
        tight:    "-0.015em",
        normal:   "0em",
        wide:     "0.025em",
        wider:    "0.05em",
        widest:   "0.1em",
        caps:     "0.15em",
      },

      // === SPACING ===
      spacing: {
        "4.5":  "1.125rem",
        "5.5":  "1.375rem",
        "6.5":  "1.625rem",
        "7.5":  "1.875rem",
        "8.5":  "2.125rem",
        "13":   "3.25rem",
        "15":   "3.75rem",
        "18":   "4.5rem",
        "22":   "5.5rem",
        "26":   "6.5rem",
        "30":   "7.5rem",
        "34":   "8.5rem",
        "38":   "9.5rem",
        "42":   "10.5rem",
        "46":   "11.5rem",
        "50":   "12.5rem",
        "54":   "13.5rem",
        "58":   "14.5rem",
        "62":   "15.5rem",
        "66":   "16.5rem",
        "70":   "17.5rem",
        "76":   "19rem",
        "80":   "20rem",
        "88":   "22rem",
        "96":   "24rem",
        "104":  "26rem",
        "112":  "28rem",
        "120":  "30rem",
        "128":  "32rem",
      },

      // === BORDER RADIUS ===
      borderRadius: {
        none:   "0",
        sm:     "0.25rem",
        DEFAULT:"0.375rem",
        md:     "0.5rem",
        lg:     "0.75rem",
        xl:     "1rem",
        "2xl":  "1.25rem",
        "3xl":  "1.5rem",
        "4xl":  "2rem",
        "5xl":  "2.5rem",
        "6xl":  "3rem",
        full:   "9999px",
      },

      // === SHADOWS ===
      boxShadow: {
        // Glow effects
        "glow-xs":     "0 0 8px rgba(30, 144, 255, 0.3)",
        "glow-sm":     "0 0 16px rgba(30, 144, 255, 0.35)",
        "glow-md":     "0 0 32px rgba(30, 144, 255, 0.4)",
        "glow-lg":     "0 0 64px rgba(30, 144, 255, 0.45)",
        "glow-xl":     "0 0 128px rgba(30, 144, 255, 0.5)",
        "glow-cyan":   "0 0 32px rgba(0, 212, 255, 0.4)",
        "glow-violet": "0 0 32px rgba(123, 110, 246, 0.4)",
        "glow-white":  "0 0 24px rgba(255, 255, 255, 0.15)",
        // Elevation
        "elevation-1": "0 1px 2px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(30, 144, 255, 0.08)",
        "elevation-2": "0 4px 8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(30, 144, 255, 0.12)",
        "elevation-3": "0 8px 24px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(30, 144, 255, 0.15)",
        "elevation-4": "0 16px 48px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(30, 144, 255, 0.2)",
        // Glass
        "glass":       "0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
        "glass-lg":    "0 16px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)",
        // Inner
        "inner-glow":  "inset 0 0 20px rgba(30, 144, 255, 0.15)",
        "inner-glow-strong": "inset 0 0 40px rgba(30, 144, 255, 0.25)",
      },

      // === ANIMATIONS ===
      keyframes: {
        // Core
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "fade-out": {
          "0%":   { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "slide-up": {
          "0%":   { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-down": {
          "0%":   { opacity: "0", transform: "translateY(-24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          "0%":   { opacity: "0", transform: "translateX(32px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          "0%":   { opacity: "0", transform: "translateX(-32px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          "0%":   { opacity: "0", transform: "scale(0.92)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // Floating (mascot)
        "float": {
          "0%, 100%": { transform: "translateY(0px) rotate(0deg)" },
          "33%":      { transform: "translateY(-12px) rotate(0.5deg)" },
          "66%":      { transform: "translateY(-6px) rotate(-0.5deg)" },
        },
        "float-slow": {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%":      { transform: "translateY(-20px)" },
        },
        // Pulse / Glow
        "pulse-glow": {
          "0%, 100%": { opacity: "0.6", boxShadow: "0 0 20px rgba(30, 144, 255, 0.3)" },
          "50%":      { opacity: "1",   boxShadow: "0 0 60px rgba(30, 144, 255, 0.6)" },
        },
        "pulse-ring": {
          "0%":   { transform: "scale(1)", opacity: "0.8" },
          "100%": { transform: "scale(2)", opacity: "0" },
        },
        "glow-breathe": {
          "0%, 100%": { opacity: "0.3" },
          "50%":      { opacity: "0.8" },
        },
        // Scan line
        "scan": {
          "0%":   { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        // Grid
        "grid-move": {
          "0%":   { transform: "translateY(0)" },
          "100%": { transform: "translateY(40px)" },
        },
        // Shimmer
        "shimmer": {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        // Orbit
        "orbit": {
          "0%":   { transform: "rotate(0deg) translateX(60px) rotate(0deg)" },
          "100%": { transform: "rotate(360deg) translateX(60px) rotate(-360deg)" },
        },
        // Spin slow
        "spin-slow": {
          "0%":   { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        // Type cursor
        "cursor-blink": {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0" },
        },
        // Gradient shift
        "gradient-shift": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%":      { backgroundPosition: "100% 50%" },
        },
        // Noise
        "noise": {
          "0%, 100%": { transform: "translate(0, 0)" },
          "10%": { transform: "translate(-1%, -1%)" },
          "20%": { transform: "translate(1%, 0%)" },
          "30%": { transform: "translate(0%, 1%)" },
          "40%": { transform: "translate(-1%, 1%)" },
          "50%": { transform: "translate(1%, -1%)" },
          "60%": { transform: "translate(0%, 0%)" },
          "70%": { transform: "translate(-1%, 0%)" },
          "80%": { transform: "translate(1%, 1%)" },
          "90%": { transform: "translate(0%, -1%)" },
        },
      },
      animation: {
        "fade-in":        "fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-out":       "fade-out 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up":       "slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up-fast":  "slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-down":     "slide-down 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-right": "slide-in-right 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-left":  "slide-in-left 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in":       "scale-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        "float":          "float 6s ease-in-out infinite",
        "float-slow":     "float-slow 8s ease-in-out infinite",
        "pulse-glow":     "pulse-glow 3s ease-in-out infinite",
        "pulse-ring":     "pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "glow-breathe":   "glow-breathe 4s ease-in-out infinite",
        "scan":           "scan 3s linear infinite",
        "grid-move":      "grid-move 20s linear infinite",
        "shimmer":        "shimmer 2.5s linear infinite",
        "orbit":          "orbit 8s linear infinite",
        "spin-slow":      "spin-slow 20s linear infinite",
        "cursor-blink":   "cursor-blink 1.2s ease-in-out infinite",
        "gradient-shift": "gradient-shift 6s ease infinite",
        "noise":          "noise 0.3s steps(1) infinite",
      },
      transitionTimingFunction: {
        "expo-out":     "cubic-bezier(0.16, 1, 0.3, 1)",
        "expo-in":      "cubic-bezier(0.7, 0, 0.84, 0)",
        "expo-in-out":  "cubic-bezier(0.87, 0, 0.13, 1)",
        "spring":       "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "smooth":       "cubic-bezier(0.4, 0, 0.2, 1)",
        "swift":        "cubic-bezier(0.55, 0, 0.1, 1)",
      },
      transitionDuration: {
        "0":   "0ms",
        "75":  "75ms",
        "100": "100ms",
        "150": "150ms",
        "200": "200ms",
        "250": "250ms",
        "300": "300ms",
        "400": "400ms",
        "500": "500ms",
        "600": "600ms",
        "700": "700ms",
        "800": "800ms",
        "1000":"1000ms",
        "1200":"1200ms",
        "1500":"1500ms",
        "2000":"2000ms",
      },

      // === BACKDROP BLUR ===
      backdropBlur: {
        xs:   "2px",
        sm:   "4px",
        DEFAULT:"8px",
        md:   "12px",
        lg:   "16px",
        xl:   "24px",
        "2xl":"40px",
        "3xl":"64px",
      },

      // === Z-INDEX ===
      zIndex: {
        "1":   "1",
        "2":   "2",
        "3":   "3",
        "5":   "5",
        "60":  "60",
        "70":  "70",
        "80":  "80",
        "90":  "90",
        "100": "100",
        "200": "200",
        "max": "2147483647",
      },

      // === BACKGROUND IMAGES ===
      backgroundImage: {
        "gradient-radial":  "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":   "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "gradient-mesh":    "radial-gradient(at 40% 20%, hsl(210, 100%, 25%) 0px, transparent 50%), radial-gradient(at 80% 0%, hsl(195, 100%, 30%) 0px, transparent 50%), radial-gradient(at 0% 50%, hsl(218, 100%, 15%) 0px, transparent 50%)",
        "glass-gradient":   "linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)",
        "shimmer-gradient": "linear-gradient(90deg, transparent 0%, rgba(30,144,255,0.15) 50%, transparent 100%)",
        "grid-lines":       "linear-gradient(rgba(30,144,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(30,144,255,0.05) 1px, transparent 1px)",
        "dot-grid":         "radial-gradient(rgba(30,144,255,0.15) 1px, transparent 1px)",
        "noise-texture":    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.05'/%3E%3C/svg%3E\")",
      },

      // === SCREENS ===
      screens: {
        xs:   "480px",
        sm:   "640px",
        md:   "768px",
        lg:   "1024px",
        xl:   "1280px",
        "2xl":"1536px",
        "3xl":"1920px",
        "4xl":"2560px",
      },
    },
  },
  plugins: [],
};

export default config;
