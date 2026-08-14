"use client";

import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { tokens, formatCurrency } from "@/components/data/quotes/shared";
import type { StatusCount } from "@/lib/dashboard/statusStats";

/**
 * Shared enterprise-dashboard primitives (icon set, ActionCard, ObjectWorkspace)
 * originally built for the Accounts/Contacts/... generic tiles in
 * app/data/page.tsx. Extracted here so any tile — including a data-driven one
 * like the Quotes dashboard — can reuse the exact same header/stats/actions/
 * recent-activity layout, styling, hover effects, and animations without
 * duplicating the UI or importing across a page/component boundary.
 */
export function Ic({ n, s = 18 }: { n: string; s?: number }) {
  const props = {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (n) {
    case "building":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="1" />
          <path d="M9 3v18M15 3v18M3 9h6M3 15h6M15 9h6M15 15h6" />
        </svg>
      );
    case "user":
      return (
        <svg {...props}>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      );
    case "users":
      return (
        <svg {...props}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "user-plus":
      return (
        <svg {...props}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <line x1="19" y1="8" x2="19" y2="14" />
          <line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      );
    case "trending-up":
      return (
        <svg {...props}>
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
          <polyline points="17 6 23 6 23 12" />
        </svg>
      );
    case "life-buoy":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="4" />
          <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
          <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
          <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
          <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
        </svg>
      );
    case "check-square":
      return (
        <svg {...props}>
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "flag":
      return (
        <svg {...props}>
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      );
    case "book-open":
      return (
        <svg {...props}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );
    case "shopping-cart":
      return (
        <svg {...props}>
          <circle cx="9" cy="21" r="1" />
          <circle cx="20" cy="21" r="1" />
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
        </svg>
      );
    case "file-text":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "archive":
      return (
        <svg {...props}>
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case "layers":
      return (
        <svg {...props}>
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      );
    case "package":
      return (
        <svg {...props}>
          <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case "zap":
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...props}>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      );
    case "credit-card":
      return (
        <svg {...props}>
          <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      );
    case "book":
      return (
        <svg {...props}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case "tool":
      return (
        <svg {...props}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...props}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "database":
      return (
        <svg {...props}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case "globe":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "cube":
      return (
        <svg {...props}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      );
    case "lock":
      return (
        <svg {...props}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case "layout":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case "code":
      return (
        <svg {...props}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case "bolt":
      return (
        <svg {...props}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "key":
      return (
        <svg {...props}>
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      );
    case "plug":
      return (
        <svg {...props}>
          <path d="M7 6V3" />
          <path d="M17 6V3" />
          <path d="M8 6h8v6a4 4 0 0 1-4 4 4 4 0 0 1-4-4V6z" />
          <path d="M12 16v3" />
        </svg>
      );
    case "search":
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case "plus":
      return (
        <svg {...props}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case "upload":
      return (
        <svg {...props}>
          <polyline points="16 16 12 12 8 16" />
          <line x1="12" y1="12" x2="12" y2="21" />
          <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
        </svg>
      );
    case "edit":
      return (
        <svg {...props}>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      );
    case "copy":
      return (
        <svg {...props}>
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "eye":
      return (
        <svg {...props}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "toggle":
      return (
        <svg {...props}>
          <rect x="1" y="5" width="22" height="14" rx="7" ry="7" />
          <circle cx="16" cy="12" r="3" />
        </svg>
      );
    case "rocket":
      return (
        <svg {...props}>
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      );
    case "wand":
      return (
        <svg {...props}>
          <path d="M15 4V2" />
          <path d="M15 16v-2" />
          <path d="M8 9h2" />
          <path d="M20 9h2" />
          <path d="M17.8 11.8 19 13" />
          <path d="M15 9h.01" />
          <path d="M17.8 6.2 19 5" />
          <path d="m3 21 9-9" />
          <path d="M12.2 6.2 11 5" />
        </svg>
      );
    case "bar-chart":
      return (
        <svg {...props}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
          <line x1="2" y1="20" x2="22" y2="20" />
        </svg>
      );
    case "bar-chart-2":
      return (
        <svg {...props}>
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
          <line x1="2" y1="20" x2="22" y2="20" />
        </svg>
      );
    case "pie-chart":
      return (
        <svg {...props}>
          <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
          <path d="M22 12A10 10 0 0 0 12 2v10z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...props}>
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      );
    case "download":
      return (
        <svg {...props}>
          <polyline points="8 17 12 21 16 17" />
          <line x1="12" y1="12" x2="12" y2="21" />
          <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
        </svg>
      );
    case "share":
      return (
        <svg {...props}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      );
    case "filter":
      return (
        <svg {...props}>
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      );
    case "alert":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
    case "table":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
        </svg>
      );
    case "list":
      return (
        <svg {...props}>
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      );
    case "git-branch":
      return (
        <svg {...props}>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...props}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...props}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg {...props}>
          <polyline points="15 18 9 12 15 6" />
        </svg>
      );
    case "panel-left":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      );
    case "home":
      return (
        <svg {...props}>
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case "x":
      return (
        <svg {...props}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case "moon":
      return (
        <svg {...props}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      );
    case "sun":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      );
    case "arrow-right":
      return (
        <svg {...props}>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      );
    case "arrow-left":
      return (
        <svg {...props}>
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
      );
    case "check-circle":
      return (
        <svg {...props}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...props}>
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
          <path d="M5 17l.75 2.25L8 20l-2.25.75L5 23l-.75-2.25L2 20l2.25-.75L5 17z" />
          <path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z" />
        </svg>
      );
    case "cpu":
      return (
        <svg {...props}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" />
          <line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      );
    case "send":
      return (
        <svg {...props}>
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      );
    case "map-pin":
      return (
        <svg {...props}>
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      );
    case "dollar-sign":
      return (
        <svg {...props}>
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "info":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
    case "briefcase":
      return (
        <svg {...props}>
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
        </svg>
      );
    case "file-contract":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "tag":
      return (
        <svg {...props}>
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      );
    case "trending-down":
      return (
        <svg {...props}>
          <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
          <polyline points="17 18 23 18 23 12" />
        </svg>
      );
    case "star":
      return (
        <svg {...props}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case "external-link":
      return (
        <svg {...props}>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      );
    case "maximize":
      return (
        <svg {...props}>
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      );
    case "minimize":
      return (
        <svg {...props}>
          <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
        </svg>
      );
    case "chevron-up":
      return (
        <svg {...props}>
          <polyline points="18 15 12 9 6 15" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
  }
}

export function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "0,0,0";
  return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`;
}

export interface StatDef { label: string; value: string; trend?: string; trendUp?: boolean }
export interface ActionDef { id: string; title: string; desc: string; icon: string; accent: string; badge?: string; workflow?: string }

/**
 * Minimal shape ObjectWorkspace/ActionCard need to render a tile's dashboard.
 * app/data/page.tsx's richer `DataObject` (which adds form/sfApiName/fieldMap
 * for the generic create-record workflow) satisfies this structurally: any
 * tile — generic or fully data-driven like Quotes — can build one directly
 * from live data without depending on that page-specific config type.
 */
export interface DashboardObject {
  id: string;
  label: string;
  icon: string;
  groupLabel: string;
  color: string;
  stats: StatDef[];
  actions: ActionDef[];
}

export type RecentOp = { type: string; item: string; meta: string; time: string; color: string };

export const DEFAULT_RECENT_OPS: RecentOp[] = [
  { type: "Created", item: "Acme Healthcare", meta: "Account", time: "3 min ago", color: "#00D4FF" },
  { type: "Updated", item: "ENT-2025-00312", meta: "Order", time: "18 min ago", color: "#3AABFF" },
  { type: "Renewed", item: "GlobalTech Contract", meta: "Contract", time: "2 hr ago", color: "#60B8FF" },
  { type: "Generated", item: "Q4 Enterprise Bundle", meta: "Bundle", time: "5 hr ago", color: "#3AABFF" },
  { type: "Imported", item: "450 Healthcare Contacts", meta: "Contact", time: "Yesterday", color: "#00D4FF" },
];

// ─────────────────────────────────────────────────────────────────────────────
// ACTION CARD
// ─────────────────────────────────────────────────────────────────────────────
export function ActionCard({ action, isDark, index, onLaunch }: {
  action: ActionDef; isDark: boolean; index: number; onLaunch: (wf: string) => void;
}) {
  const [hov, setHov] = useState(false);
  const rgb = hexToRgb(action.accent);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => action.workflow && onLaunch(action.workflow)}
      className="relative rounded-xl p-4 flex flex-col gap-3 overflow-hidden"
      style={{
        cursor: action.workflow ? "pointer" : "default",
        background: isDark
          ? hov ? `rgba(${rgb},0.09)` : "rgba(8,16,32,0.58)"
          : hov ? `rgba(${rgb},0.06)` : "rgba(228,241,255,0.90)",
        border: hov
          ? `1px solid rgba(${rgb},0.38)`
          : isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.16)",
        boxShadow: hov ? `0 8px 32px rgba(${rgb},0.14)` : "none",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        transition: "background 0.22s, border 0.22s, box-shadow 0.22s",
      }}
    >
      <AnimatePresence>
        {hov && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute top-0 left-4 right-4 h-px pointer-events-none"
            style={{ background: `linear-gradient(90deg, transparent, rgba(${rgb},0.65), transparent)` }}
          />
        )}
      </AnimatePresence>

      <div className="flex items-start justify-between gap-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: `rgba(${rgb},0.15)`,
            color: action.accent,
            border: `1px solid rgba(${rgb},0.25)`,
            boxShadow: hov ? `0 0 14px rgba(${rgb},0.28)` : "none",
            transition: "box-shadow 0.22s",
          }}
        >
          <Ic n={action.icon} s={15} />
        </div>
        {action.badge && (
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded-full tracking-wide shrink-0"
            style={{ background: `rgba(${rgb},0.15)`, color: action.accent, border: `1px solid rgba(${rgb},0.3)` }}
          >
            {action.badge}
          </span>
        )}
      </div>

      <div className="flex-1">
        <p className="text-[13px] font-semibold mb-1" style={{ color: isDark ? "rgba(210,230,250,0.9)" : "rgba(0,15,45,0.88)", letterSpacing: "-0.01em" }}>
          {action.title}
        </p>
        <p className="text-[11px] leading-relaxed" style={{ color: isDark ? "rgba(100,130,170,0.65)" : "rgba(0,15,55,0.74)" }}>
          {action.desc}
        </p>
      </div>

      <div className="flex items-center justify-end">
        <motion.span
          animate={{ x: hov ? 3 : 0, opacity: hov ? 1 : 0.38 }}
          transition={{ type: "spring", stiffness: 400, damping: 26 }}
          style={{ color: action.accent }}
        >
          <Ic n="arrow-right" s={14} />
        </motion.span>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OBJECT WORKSPACE (browse mode)
// ─────────────────────────────────────────────────────────────────────────────
export function ObjectWorkspace({ obj, isDark, onLaunch, recentActivity, recentActivityLabel, extraSection, subtitle }: {
  obj: DashboardObject; isDark: boolean; onLaunch: (wf: string) => void;
  /** Overrides the generic demo activity feed with real per-object data (e.g. live Quote history) — defaults to the shared static feed so every other tile is unaffected. */
  recentActivity?: RecentOp[];
  recentActivityLabel?: string;
  /** Optional extra content rendered between the Actions grid and Recent Activity (e.g. an analytics breakdown panel). */
  extraSection?: ReactNode;
  /** Optional one-line description rendered under the title/badge — omitted (as today) unless a tile passes one. */
  subtitle?: string;
}) {
  const rgb = hexToRgb(obj.color);
  const activity = recentActivity ?? DEFAULT_RECENT_OPS;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={obj.id}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        className="flex flex-col flex-1 overflow-hidden"
      >
        {/* Object header */}
        <div
          className="px-6 py-4 shrink-0"
          style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}
        >
          <div className="flex items-start gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: `linear-gradient(135deg, rgba(${rgb},0.22) 0%, rgba(${rgb},0.1) 100%)`,
                border: `1px solid rgba(${rgb},0.28)`,
                color: obj.color,
                boxShadow: `0 0 20px rgba(${rgb},0.12)`,
              }}
            >
              <Ic n={obj.icon} s={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[18px] font-bold leading-tight" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                  {obj.label}
                </h2>
                <span
                  className="text-[9px] font-mono px-2 py-0.5 rounded-md"
                  style={{ background: `rgba(${rgb},0.12)`, border: `1px solid rgba(${rgb},0.22)`, color: obj.color }}
                >
                  {obj.groupLabel.toUpperCase()}
                </span>
              </div>
            </div>
          </div>

          {subtitle && (
            <p className="text-[11.5px] mb-4 max-w-2xl" style={{ color: isDark ? "rgba(140,170,205,0.72)" : "rgba(0,30,80,0.68)" }}>
              {subtitle}
            </p>
          )}

          {/* Stats row */}
          <div className="flex gap-3 flex-wrap">
            {obj.stats.map(stat => (
              <div
                key={stat.label}
                className="flex flex-col px-3 py-2 rounded-lg"
                style={{
                  background: isDark ? `rgba(${rgb},0.06)` : `rgba(${rgb},0.04)`,
                  border: isDark ? `1px solid rgba(${rgb},0.12)` : `1px solid rgba(${rgb},0.09)`,
                  minWidth: 64,
                }}
              >
                <span className="text-[17px] font-bold leading-none" style={{ color: obj.color, letterSpacing: "-0.03em" }}>{stat.value}</span>
                <span className="text-[10px] mt-1" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarWidth: "thin" }}>
          <p className="text-[10px] font-semibold tracking-widest uppercase mb-4" style={{ color: isDark ? `rgba(${rgb},0.5)` : "rgba(0,71,171,0.66)" }}>
            Actions
          </p>
          <div className="grid gap-3 mb-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
            {obj.actions.map((action, i) => (
              <ActionCard key={action.id} action={action} isDark={isDark} index={i} onLaunch={onLaunch} />
            ))}
          </div>

          {extraSection}

          {/* Recent activity */}
          <div className="h-px mb-6" style={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)" }} />
          <p className="text-[10px] font-semibold tracking-widest uppercase mb-4" style={{ color: isDark ? "rgba(0,212,255,0.45)" : "rgba(0,71,171,0.62)" }}>
            {recentActivityLabel ?? "Recent Activity"}
          </p>
          <div className="flex flex-col gap-1.5">
            {activity.map((op, i) => (
              <motion.div
                key={`${op.item}-${i}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.04 }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                style={{
                  background: isDark ? "rgba(8,16,32,0.4)" : "rgba(222,235,255,0.85)",
                  border: isDark ? "1px solid rgba(0,212,255,0.06)" : "1px solid rgba(0,71,171,0.10)",
                }}
              >
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: op.color, boxShadow: `0 0 5px ${op.color}80` }} />
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0" style={{ background: `${op.color}18`, color: op.color, minWidth: 52, textAlign: "center" }}>
                  {op.type}
                </span>
                <span className="text-[12px] font-mono font-medium flex-1 truncate" style={{ color: isDark ? "rgba(180,210,240,0.85)" : "rgba(0,15,45,0.8)" }}>
                  {op.item}
                </span>
                <span className="text-[10px] shrink-0" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.58)" }}>{op.meta}</span>
                <span className="text-[10px] shrink-0" style={{ color: isDark ? "rgba(90,120,160,0.38)" : "rgba(0,31,91,0.52)" }}>{op.time}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS BREAKDOWN PANEL (shared "Analytics" extraSection for any tile)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Renders inside `ObjectWorkspace`'s `extraSection` slot as a tile's inline
 * "Analytics" toggle (Quote/Order/Contract Analytics action cards) — real
 * per-status counts/values from the connected org, grouped identically
 * across every tile instead of each dashboard building its own breakdown UI.
 */
export function StatusBreakdownPanel({ isDark, title, breakdown, valueFieldAvailable }: {
  isDark: boolean; title: string; breakdown: StatusCount[]; valueFieldAvailable: boolean;
}) {
  const t = tokens(isDark);
  const maxCount = Math.max(1, ...breakdown.map(b => b.count));
  const sorted = breakdown.slice().sort((a, b) => b.count - a.count);

  return (
    <div className="mb-8 rounded-xl p-4" style={{ background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
      <p className="text-[10px] font-semibold tracking-widest uppercase mb-3.5" style={{ color: t.dim }}>
        {title}
      </p>
      <div className="flex flex-col gap-3">
        {sorted.map(b => (
          <div key={b.status} className="flex items-center gap-3">
            <span className="text-[11.5px] font-medium w-28 truncate shrink-0" style={{ color: t.heading }}>{b.status}</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.10)" }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(4, (b.count / maxCount) * 100)}%`, background: `linear-gradient(90deg, ${t.accentBlue}, ${t.accent})` }}
              />
            </div>
            <span className="text-[11.5px] font-semibold w-8 text-right shrink-0" style={{ color: t.heading }}>{b.count}</span>
            {valueFieldAvailable && (
              <span className="text-[11px] w-24 text-right shrink-0" style={{ color: t.dim }}>{formatCurrency(b.totalValue ?? 0)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD MODULE FRAME (shared "back to dashboard" wrapper)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Wraps an existing, untouched module (QuotesModule/OrdersModule/
 * ContractsModule/...) with the small "← Back to X Dashboard" bar shown once
 * a dashboard action card has navigated into it — identical across every
 * tile so this shell only has to be built once.
 */
export function DashboardModuleFrame({ isDark, backLabel, onBack, children }: {
  isDark: boolean; backLabel: string; onBack: () => void; children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        className="px-5 py-2 shrink-0"
        style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}
      >
        <motion.button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] font-semibold cursor-pointer px-2 py-1 rounded-lg"
          style={{ color: "#00D4FF" }}
          whileHover={{ x: -2, background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.08)" }}
        >
          <Ic n="arrow-left" s={12} /> {backLabel}
        </motion.button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
