"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import Image from "next/image";
import { loadSession, clearSession } from "@/lib/auth/session";
import { loadIdentity, isSetupComplete, clearIdentity, clearSetup } from "@/lib/auth/identity";
import type { SessionData } from "@/lib/auth/types";
import RCAAttributeStudio from "@/components/data/RCAAttributeStudio";
import BundleOrchestrationWorkspace from "@/components/data/BundleOrchestrationWorkspace";
import RCProductWorkspace from "@/components/metadata/RCProductWorkspace";

function Ic({ n, s = 18 }: { n: string; s?: number }) {
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

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "0,0,0";
  return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`;
}

type AppMode = "browse" | "workflow" | "preview" | "success";
type FieldType = "text" | "email" | "phone" | "url" | "number" | "currency" | "date" | "select" | "textarea";
interface FieldDef { id: string; label: string; type: FieldType; required?: boolean; placeholder?: string; options?: string[]; span?: 1 | 2 }
interface SectionDef { id: string; label: string; icon: string; fields: FieldDef[] }
interface StatDef { label: string; value: string; trend?: string; trendUp?: boolean }
interface ActionDef { id: string; title: string; desc: string; icon: string; accent: string; badge?: string; workflow?: string }
interface DataObject { id: string; label: string; icon: string; groupId: string; groupLabel: string; badge?: string; color: string; stats: StatDef[]; actions: ActionDef[]; form?: SectionDef[]; sfApiName?: string; fieldMap?: Record<string, string> }
interface DataGroup { id: string; label: string; icon: string; color: string; items: DataObject[] }

const ACCOUNT_FORM: SectionDef[] = [
  {
    id: "basic",
    label: "Basic Information",
    icon: "building",
    fields: [
      { id: "accountName", label: "Account Name", type: "text", required: true, placeholder: "Enter account name", span: 2 },
      { id: "phone", label: "Phone", type: "phone", placeholder: "(555) 000-0000" },
      { id: "website", label: "Website", type: "url", placeholder: "https://example.com" },
      { id: "accountNumber", label: "Account Number", type: "text", placeholder: "ACC-0001" },
      { id: "type", label: "Type", type: "select", options: ["Analyst", "Competitor", "Customer", "Integrator", "Investor", "Partner", "Press", "Prospect", "Reseller", "Other"] },
      { id: "industry", label: "Industry", type: "select", options: ["Agriculture", "Apparel", "Banking", "Biotechnology", "Chemicals", "Communications", "Construction", "Consulting", "Education", "Electronics", "Energy", "Engineering", "Entertainment", "Environmental", "Finance", "Food & Beverage", "Government", "Healthcare", "Hospitality", "Insurance", "Machinery", "Manufacturing", "Media", "Not For Profit", "Recreation", "Retail", "Shipping", "Technology", "Telecommunications", "Transportation", "Utilities", "Other"] },
    ],
  },
  {
    id: "business",
    label: "Business Details",
    icon: "briefcase",
    fields: [
      { id: "annualRevenue", label: "Annual Revenue", type: "currency", placeholder: "0.00" },
      { id: "employees", label: "Employees", type: "number", placeholder: "0" },
      { id: "tickerSymbol", label: "Ticker Symbol", type: "text", placeholder: "ACME" },
      { id: "ownership", label: "Ownership", type: "select", options: ["Public", "Private", "Subsidiary", "Other"] },
    ],
  },
  {
    id: "billing",
    label: "Billing Address",
    icon: "map-pin",
    fields: [
      { id: "billingStreet", label: "Billing Street", type: "text", placeholder: "123 Main St", span: 2 },
      { id: "billingCity", label: "City", type: "text", placeholder: "San Francisco" },
      { id: "billingState", label: "State", type: "text", placeholder: "CA" },
      { id: "billingZip", label: "Zip", type: "text", placeholder: "94105" },
      { id: "billingCountry", label: "Country", type: "select", options: ["United States", "Canada", "United Kingdom", "Australia", "Germany", "France", "Japan", "India", "Brazil", "Other"] },
    ],
  },
  {
    id: "relationships",
    label: "Relationships",
    icon: "git-branch",
    fields: [
      { id: "parentAccount", label: "Parent Account", type: "text", placeholder: "Search accounts..." },
      { id: "accountOwner", label: "Account Owner", type: "text", placeholder: "Search users..." },
      { id: "accountSource", label: "Account Source", type: "select", options: ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"] },
      { id: "rating", label: "Rating", type: "select", options: ["Hot", "Warm", "Cold"] },
    ],
  },
  {
    id: "notes",
    label: "Notes",
    icon: "file-text",
    fields: [
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter account description...", span: 2 },
    ],
  },
];

const CONTACT_FORM: SectionDef[] = [
  {
    id: "identity",
    label: "Identity",
    icon: "user",
    fields: [
      { id: "firstName", label: "First Name", type: "text", required: true, placeholder: "John" },
      { id: "lastName", label: "Last Name", type: "text", required: true, placeholder: "Doe" },
      { id: "title", label: "Title", type: "text", placeholder: "VP of Sales" },
      { id: "email", label: "Email", type: "email", placeholder: "john@example.com" },
      { id: "phone", label: "Phone", type: "phone", placeholder: "(555) 000-0000" },
      { id: "mobile", label: "Mobile", type: "phone", placeholder: "(555) 000-0001" },
    ],
  },
  {
    id: "organization",
    label: "Organization",
    icon: "building",
    fields: [
      { id: "accountName", label: "Account Name", type: "text", placeholder: "Search accounts..." },
      { id: "department", label: "Department", type: "text", placeholder: "Sales" },
      { id: "reportsTo", label: "Reports To", type: "text", placeholder: "Search contacts..." },
    ],
  },
  {
    id: "address",
    label: "Address",
    icon: "map-pin",
    fields: [
      { id: "mailingStreet", label: "Mailing Street", type: "text", placeholder: "123 Main St", span: 2 },
      { id: "mailingCity", label: "City", type: "text", placeholder: "San Francisco" },
      { id: "mailingState", label: "State", type: "text", placeholder: "CA" },
      { id: "mailingZip", label: "Zip", type: "text", placeholder: "94105" },
      { id: "mailingCountry", label: "Country", type: "select", options: ["United States", "Canada", "United Kingdom", "Australia", "Germany", "France", "Japan", "India", "Brazil", "Other"] },
    ],
  },
  {
    id: "notes",
    label: "Notes",
    icon: "file-text",
    fields: [
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter contact description...", span: 2 },
    ],
  },
];

const OPPORTUNITY_FORM: SectionDef[] = [
  {
    id: "details",
    label: "Opportunity Details",
    icon: "trending-up",
    fields: [
      { id: "opportunityName", label: "Opportunity Name", type: "text", required: true, placeholder: "Enter opportunity name", span: 2 },
      { id: "accountName", label: "Account Name", type: "text", required: true, placeholder: "Search accounts..." },
      { id: "closeDate", label: "Close Date", type: "date", required: true },
      { id: "stage", label: "Stage", type: "select", options: ["Prospecting", "Qualification", "Needs Analysis", "Value Proposition", "Id Decision Makers", "Perception Analysis", "Proposal Price Quote", "Negotiation Review", "Closed Won", "Closed Lost"] },
      { id: "amount", label: "Amount", type: "currency", placeholder: "0.00" },
      { id: "probability", label: "Probability", type: "number", placeholder: "0" },
    ],
  },
  {
    id: "additional",
    label: "Additional Info",
    icon: "info",
    fields: [
      { id: "leadSource", label: "Lead Source", type: "select", options: ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"] },
      { id: "type", label: "Type", type: "select", options: ["Existing Customer", "New Customer"] },
      { id: "priceBook", label: "Price Book", type: "select", options: ["Standard Price Book", "Custom Price Book"] },
      { id: "campaignSource", label: "Campaign Source", type: "text", placeholder: "Search campaigns..." },
    ],
  },
  {
    id: "forecast",
    label: "Forecast",
    icon: "bar-chart",
    fields: [
      { id: "forecastCategory", label: "Forecast Category", type: "select", options: ["Omitted", "Pipeline", "Best Case", "Commit", "Closed"] },
      { id: "nextStep", label: "Next Step", type: "textarea", placeholder: "Describe the next step...", span: 2 },
    ],
  },
  {
    id: "notes",
    label: "Notes",
    icon: "file-text",
    fields: [
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter opportunity description...", span: 2 },
    ],
  },
];

const ORDER_FORM: SectionDef[] = [
  {
    id: "details",
    label: "Order Details",
    icon: "shopping-cart",
    fields: [
      { id: "orderName", label: "Order Name", type: "text", required: true, placeholder: "Enter order name", span: 2 },
      { id: "account", label: "Account", type: "text", required: true, placeholder: "Search accounts..." },
      { id: "contract", label: "Contract", type: "text", placeholder: "Search contracts..." },
      { id: "orderDate", label: "Order Date", type: "date" },
      { id: "status", label: "Status", type: "select", options: ["Draft", "Activated", "Cancelled"] },
      { id: "type", label: "Type", type: "select", options: ["New Business", "Renewal", "Amendment", "Add-On"] },
    ],
  },
  {
    id: "pricing",
    label: "Pricing",
    icon: "dollar-sign",
    fields: [
      { id: "priceBook", label: "Price Book", type: "select", options: ["Standard Price Book", "Custom Price Book"] },
      { id: "currency", label: "Currency", type: "select", options: ["USD", "EUR", "GBP", "CAD", "AUD"] },
      { id: "discount", label: "Discount %", type: "number", placeholder: "0" },
      { id: "billingFrequency", label: "Billing Frequency", type: "select", options: ["Monthly", "Quarterly", "Annual", "One-Time"] },
    ],
  },
  {
    id: "billing",
    label: "Billing Address",
    icon: "map-pin",
    fields: [
      { id: "billingStreet", label: "Street", type: "text", placeholder: "123 Main St", span: 2 },
      { id: "billingCity", label: "City", type: "text", placeholder: "San Francisco" },
      { id: "billingState", label: "State", type: "text", placeholder: "CA" },
      { id: "billingCountry", label: "Country", type: "select", options: ["United States", "Canada", "United Kingdom", "Australia", "Germany", "France", "Japan", "India", "Brazil", "Other"] },
    ],
  },
  {
    id: "notes",
    label: "Notes",
    icon: "file-text",
    fields: [
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter order description...", span: 2 },
    ],
  },
];

const BUNDLE_FORM: SectionDef[] = [
  {
    id: "details",
    label: "Bundle Details",
    icon: "package",
    fields: [
      { id: "bundleName", label: "Bundle Name", type: "text", required: true, placeholder: "Enter bundle name", span: 2 },
      { id: "catalog", label: "Catalog", type: "select", options: ["Enterprise Catalog", "SMB Catalog", "Partner Catalog"] },
      { id: "category", label: "Category", type: "select", options: ["Software", "Hardware", "Services", "Support", "Other"] },
      { id: "bundleType", label: "Bundle Type", type: "select", options: ["Static", "Dynamic", "Configurable"] },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    icon: "sliders",
    fields: [
      { id: "minQuantity", label: "Min Quantity", type: "number", placeholder: "1" },
      { id: "maxQuantity", label: "Max Quantity", type: "number", placeholder: "100" },
      { id: "allowCustomConfig", label: "Allow Custom Config", type: "select", options: ["Yes", "No"] },
      { id: "isConfigurable", label: "Is Configurable", type: "select", options: ["Yes", "No"] },
    ],
  },
  {
    id: "pricing",
    label: "Pricing",
    icon: "dollar-sign",
    fields: [
      { id: "listPrice", label: "List Price", type: "currency", placeholder: "0.00" },
      { id: "pricingMethod", label: "Pricing Method", type: "select", options: ["List", "Cost Plus", "Custom"] },
      { id: "discountType", label: "Discount Type", type: "select", options: ["Flat", "Percentage", "None"] },
    ],
  },
  {
    id: "description",
    label: "Description",
    icon: "file-text",
    fields: [
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter bundle description...", span: 2 },
      { id: "notes", label: "Notes", type: "textarea", placeholder: "Enter additional notes...", span: 2 },
    ],
  },
];

const DEFAULT_FORM: SectionDef[] = [
  {
    id: "basic",
    label: "Basic Information",
    icon: "file-text",
    fields: [
      { id: "name", label: "Name", type: "text", required: true, placeholder: "Enter name", span: 2 },
      { id: "status", label: "Status", type: "select", options: ["Active", "Inactive", "Draft"] },
      { id: "owner", label: "Owner", type: "text", placeholder: "Search users..." },
      { id: "description", label: "Description", type: "textarea", placeholder: "Enter description...", span: 2 },
    ],
  },
  {
    id: "details",
    label: "Details",
    icon: "info",
    fields: [
      { id: "notes", label: "Notes", type: "textarea", placeholder: "Enter notes...", span: 2 },
    ],
  },
];

const DATA_GROUPS: DataGroup[] = [
  {
    id: "crm",
    label: "Core CRM",
    icon: "users",
    color: "#00D4FF",
    items: [
      {
        id: "accounts",
        label: "Accounts",
        icon: "building",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "247",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "247" },
          { label: "Active", value: "198" },
          { label: "New 30d", value: "12" },
          { label: "Pipeline", value: "$24.5M" },
        ],
        actions: [
          { id: "create-account", title: "Create Account", desc: "Add a new account record", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "import-accounts", title: "Import Accounts", desc: "Bulk import from CSV or file", icon: "upload", accent: "#3AABFF", badge: "AI" },
          { id: "bulk-update", title: "Bulk Update", desc: "Update multiple accounts at once", icon: "edit", accent: "#00D4FF" },
          { id: "ai-insights", title: "AI Insights", desc: "Get AI-powered account insights", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "relationship-map", title: "Relationship Map", desc: "Visualize account relationships", icon: "git-branch", accent: "#00D4FF" },
          { id: "duplicate-detection", title: "Duplicate Detection", desc: "Find and merge duplicates", icon: "search", accent: "#3AABFF", badge: "AI" },
          { id: "segmentation", title: "Segmentation", desc: "Segment accounts by criteria", icon: "filter", accent: "#3AABFF", badge: "AI" },
          { id: "analytics", title: "Analytics", desc: "View account analytics", icon: "bar-chart", accent: "#00D4FF" },
        ],
        form: ACCOUNT_FORM,
        sfApiName: "Account",
        fieldMap: {
          accountName: "Name", phone: "Phone", website: "Website", accountNumber: "AccountNumber",
          type: "Type", industry: "Industry", annualRevenue: "AnnualRevenue", employees: "NumberOfEmployees",
          tickerSymbol: "TickerSymbol", ownership: "Ownership", billingStreet: "BillingStreet",
          billingCity: "BillingCity", billingState: "BillingState", billingZip: "BillingPostalCode",
          billingCountry: "BillingCountry", description: "Description",
        },
      },
      {
        id: "contacts",
        label: "Contacts",
        icon: "users",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "1.2k",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "1284" },
          { label: "Active", value: "1156" },
          { label: "New 30d", value: "34" },
          { label: "Open Tasks", value: "89" },
        ],
        actions: [
          { id: "create-contact", title: "Create Contact", desc: "Add a new contact record", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "import-contacts", title: "Import Contacts", desc: "Bulk import from CSV or file", icon: "upload", accent: "#3AABFF" },
          { id: "relationship-map", title: "Relationship Map", desc: "Visualize contact relationships", icon: "git-branch", accent: "#00D4FF" },
          { id: "activity-timeline", title: "Activity Timeline", desc: "View contact activity history", icon: "clock", accent: "#60B8FF" },
          { id: "duplicate-check", title: "Duplicate Check", desc: "Find and merge duplicates", icon: "search", accent: "#3AABFF", badge: "AI" },
          { id: "email-campaign", title: "Email Campaign", desc: "Send targeted email campaigns", icon: "send", accent: "#00D4FF" },
        ],
        form: CONTACT_FORM,
        sfApiName: "Contact",
        fieldMap: {
          firstName: "FirstName", lastName: "LastName", title: "Title", email: "Email",
          phone: "Phone", mobile: "MobilePhone", department: "Department",
          mailingStreet: "MailingStreet", mailingCity: "MailingCity", mailingState: "MailingState",
          mailingZip: "MailingPostalCode", mailingCountry: "MailingCountry", description: "Description",
        },
      },
      {
        id: "leads",
        label: "Leads",
        icon: "user-plus",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "89",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "89" },
          { label: "Unowned", value: "14" },
          { label: "Converted", value: "23" },
          { label: "Hot", value: "11" },
        ],
        actions: [
          { id: "create-lead", title: "Create Lead", desc: "Add a new lead record", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "import-leads", title: "Import Leads", desc: "Bulk import from CSV or file", icon: "upload", accent: "#3AABFF", badge: "AI" },
          { id: "ai-lead-score", title: "AI Lead Score", desc: "Score leads with AI", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "convert-lead", title: "Convert Lead", desc: "Convert lead to opportunity", icon: "arrow-right", accent: "#00D4FF" },
          { id: "mass-email", title: "Mass Email", desc: "Send bulk email to leads", icon: "send", accent: "#00D4FF" },
          { id: "assignment-rules", title: "Assignment Rules", desc: "Configure lead assignment", icon: "sliders", accent: "#3AABFF" },
        ],
      },
      {
        id: "opportunities",
        label: "Opportunities",
        icon: "trending-up",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "67",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "67" },
          { label: "Open", value: "54" },
          { label: "Closed Won", value: "8" },
          { label: "Value", value: "$3.2M" },
        ],
        actions: [
          { id: "create-opportunity", title: "Create Opportunity", desc: "Add a new opportunity", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "pipeline-view", title: "Pipeline View", desc: "View opportunities pipeline", icon: "bar-chart", accent: "#00D4FF" },
          { id: "ai-forecast", title: "AI Forecast", desc: "Get AI revenue forecast", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "stage-analysis", title: "Stage Analysis", desc: "Analyze stage conversion rates", icon: "pie-chart", accent: "#3AABFF" },
          { id: "win-loss-report", title: "Win/Loss Report", desc: "Analyze win and loss trends", icon: "trending-down", accent: "#3AABFF" },
          { id: "clone-opportunity", title: "Clone Opportunity", desc: "Duplicate an opportunity", icon: "copy", accent: "#00D4FF" },
        ],
        form: OPPORTUNITY_FORM,
        sfApiName: "Opportunity",
        fieldMap: {
          opportunityName: "Name", closeDate: "CloseDate", stage: "StageName",
          amount: "Amount", probability: "Probability", leadSource: "LeadSource",
          type: "Type", forecastCategory: "ForecastCategoryName",
          nextStep: "NextStep", description: "Description",
        },
      },
      {
        id: "cases",
        label: "Cases",
        icon: "life-buoy",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "34",
        color: "#00D4FF",
        stats: [
          { label: "Open", value: "34" },
          { label: "Critical", value: "5" },
          { label: "SLA Breach", value: "2" },
          { label: "Avg", value: "1.4d" },
        ],
        actions: [
          { id: "create-case", title: "Create Case", desc: "Add a new support case", icon: "plus", accent: "#3AABFF", workflow: "create" },
          { id: "escalate", title: "Escalate", desc: "Escalate critical cases", icon: "alert", accent: "#E84444" },
          { id: "bulk-assign", title: "Bulk Assign", desc: "Assign cases to agents", icon: "users", accent: "#3AABFF" },
          { id: "sla-report", title: "SLA Report", desc: "View SLA compliance report", icon: "clock", accent: "#60B8FF" },
          { id: "knowledge-suggest", title: "Knowledge Suggest", desc: "AI-suggested knowledge articles", icon: "sparkles", accent: "#00D4FF", badge: "AI" },
        ],
      },
      {
        id: "orders",
        label: "Orders",
        icon: "shopping-cart",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "156",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "156" },
          { label: "Active", value: "142" },
          { label: "New 30d", value: "8" },
          { label: "Value", value: "$4.2M" },
        ],
        actions: [
          { id: "create-order", title: "Create Order", desc: "Add a new order", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "amend-order", title: "Amend Order", desc: "Modify an existing order", icon: "edit", accent: "#3AABFF", workflow: "create" },
          { id: "renew-subscription", title: "Renew Subscription", desc: "Renew expiring subscriptions", icon: "refresh", accent: "#00D4FF", workflow: "create" },
          { id: "billing-insights", title: "Billing Insights", desc: "AI billing analysis", icon: "dollar-sign", accent: "#60B8FF", badge: "AI" },
          { id: "payment-track", title: "Payment Track", desc: "Track payment status", icon: "credit-card", accent: "#00D4FF" },
          { id: "order-analytics", title: "Order Analytics", desc: "Analyze order trends", icon: "bar-chart", accent: "#00D4FF", badge: "AI" },
        ],
        form: ORDER_FORM,
        sfApiName: "Order",
        fieldMap: {
          orderDate: "EffectiveDate", status: "Status",
        },
      },
      {
        id: "contracts",
        label: "Contracts",
        icon: "file-contract",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "42",
        color: "#00D4FF",
        stats: [
          { label: "Active", value: "42" },
          { label: "Expiring 30d", value: "7" },
          { label: "Amended", value: "5" },
          { label: "Value", value: "$8.1M" },
        ],
        actions: [
          { id: "create-contract", title: "Create Contract", desc: "Add a new contract", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "amend-contract", title: "Amend Contract", desc: "Modify an existing contract", icon: "edit", accent: "#3AABFF" },
          { id: "renew-contract", title: "Renew Contract", desc: "Renew expiring contracts", icon: "refresh", accent: "#00D4FF" },
          { id: "expiry-alerts", title: "Expiry Alerts", desc: "AI-powered expiry notifications", icon: "alert", accent: "#60B8FF", badge: "AI" },
          { id: "analytics", title: "Analytics", desc: "View contract analytics", icon: "bar-chart", accent: "#00D4FF" },
        ],
      },
      {
        id: "products",
        label: "Products",
        icon: "package",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "312",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "312" },
          { label: "Active", value: "289" },
          { label: "Bundles", value: "47" },
          { label: "Categories", value: "18" },
        ],
        actions: [
          { id: "create-product", title: "Create Product", desc: "Add a new product", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "bulk-import", title: "Bulk Import", desc: "Import products from file", icon: "upload", accent: "#3AABFF", badge: "AI" },
          { id: "price-update", title: "Price Update", desc: "Update product pricing", icon: "dollar-sign", accent: "#00D4FF" },
          { id: "clone-product", title: "Clone Product", desc: "Duplicate a product", icon: "copy", accent: "#00D4FF" },
          { id: "catalog-view", title: "Catalog View", desc: "Browse product catalog", icon: "layers", accent: "#3AABFF" },
        ],
      },
      {
        id: "quotes",
        label: "Quotes",
        icon: "file-text",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "78",
        color: "#00D4FF",
        stats: [
          { label: "Open", value: "78" },
          { label: "Won", value: "34" },
          { label: "Draft", value: "12" },
          { label: "Value", value: "$1.8M" },
        ],
        actions: [
          { id: "create-quote", title: "Create Quote", desc: "Add a new quote", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "generate-pdf", title: "Generate PDF", desc: "Export quote as PDF", icon: "download", accent: "#3AABFF" },
          { id: "send-to-customer", title: "Send to Customer", desc: "Email quote to customer", icon: "send", accent: "#00D4FF" },
          { id: "ai-pricing", title: "AI Pricing", desc: "Get AI pricing recommendations", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "analytics", title: "Analytics", desc: "View quote analytics", icon: "bar-chart", accent: "#00D4FF" },
        ],
      },
      {
        id: "assets",
        label: "Assets",
        icon: "archive",
        groupId: "crm",
        groupLabel: "Core CRM",
        badge: "198",
        color: "#00D4FF",
        stats: [
          { label: "Total", value: "198" },
          { label: "Active", value: "181" },
          { label: "Expiring", value: "9" },
          { label: "Value", value: "$12M" },
        ],
        actions: [
          { id: "create-asset", title: "Create Asset", desc: "Add a new asset record", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "bulk-update", title: "Bulk Update", desc: "Update multiple assets", icon: "edit", accent: "#3AABFF" },
          { id: "renewal-forecast", title: "Renewal Forecast", desc: "AI-powered renewal forecast", icon: "refresh", accent: "#00D4FF", badge: "AI" },
          { id: "analytics", title: "Analytics", desc: "View asset analytics", icon: "bar-chart", accent: "#00D4FF" },
        ],
      },
    ],
  },
  {
    id: "revenue",
    label: "Revenue Cloud",
    icon: "zap",
    color: "#00D4FF",
    items: [
      {
        id: "catalogs",
        label: "Catalogs",
        icon: "layers",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "8",
        color: "#00D4FF",
        stats: [
          { label: "Catalogs", value: "8" },
          { label: "Active", value: "7" },
          { label: "Products", value: "312" },
          { label: "Categories", value: "42" },
        ],
        actions: [
          { id: "create-catalog", title: "Create Catalog", desc: "Add a new product catalog", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "add-products", title: "Add Products", desc: "Add products to catalog", icon: "package", accent: "#00D4FF" },
          { id: "manage-categories", title: "Manage Categories", desc: "Organize catalog categories", icon: "layers", accent: "#3AABFF" },
          { id: "publish-catalog", title: "Publish Catalog", desc: "Publish catalog to storefront", icon: "rocket", accent: "#00D4FF" },
          { id: "clone-catalog", title: "Clone Catalog", desc: "Duplicate a catalog", icon: "copy", accent: "#00D4FF" },
        ],
      },
      {
        id: "bundles",
        label: "Bundles",
        icon: "package",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "47",
        color: "#00D4FF",
        stats: [
          { label: "Bundles", value: "47" },
          { label: "Active", value: "44" },
          { label: "Components", value: "218" },
          { label: "Deployed", value: "42" },
        ],
        actions: [
          { id: "create-bundle", title: "Create Bundle", desc: "Add a new product bundle", icon: "plus", accent: "#00D4FF", badge: "AI", workflow: "create" },
          { id: "configure-components", title: "Configure Components", desc: "Set up bundle components", icon: "sliders", accent: "#00D4FF" },
          { id: "pricing-rules", title: "Pricing Rules", desc: "Configure bundle pricing", icon: "zap", accent: "#60B8FF" },
          { id: "clone-bundle", title: "Clone Bundle", desc: "Duplicate a bundle", icon: "copy", accent: "#00D4FF" },
          { id: "deploy-bundle", title: "Deploy Bundle", desc: "Deploy bundle to production", icon: "rocket", accent: "#00D4FF" },
          { id: "bundle-analytics", title: "Bundle Analytics", desc: "AI-powered bundle insights", icon: "bar-chart", accent: "#00D4FF", badge: "AI" },
        ],
        form: BUNDLE_FORM,
      },
      {
        id: "pricing-rules",
        label: "Pricing Rules",
        icon: "zap",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "34",
        color: "#00D4FF",
        stats: [
          { label: "Rules", value: "34" },
          { label: "Active", value: "28" },
          { label: "Overrides", value: "6" },
          { label: "Applied 7d", value: "1.4k" },
        ],
        actions: [
          { id: "create-rule", title: "Create Rule", desc: "Add a new pricing rule", icon: "plus", accent: "#60B8FF", badge: "AI", workflow: "create" },
          { id: "test-rule", title: "Test Rule", desc: "Test pricing rule logic", icon: "bolt", accent: "#00D4FF" },
          { id: "bulk-toggle", title: "Bulk Toggle", desc: "Enable or disable rules in bulk", icon: "toggle", accent: "#60B8FF" },
          { id: "rule-analytics", title: "Rule Analytics", desc: "Analyze pricing rule performance", icon: "bar-chart", accent: "#3AABFF", badge: "AI" },
          { id: "deploy-rules", title: "Deploy Rules", desc: "Deploy rules to production", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "attributes",
        label: "Attributes",
        icon: "sliders",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "89",
        color: "#00D4FF",
        stats: [
          { label: "Attributes", value: "89" },
          { label: "Types", value: "12" },
          { label: "Picklists", value: "34" },
          { label: "Deployed", value: "87" },
        ],
        actions: [
          { id: "create-attribute", title: "Create Attribute", desc: "Add a new attribute", icon: "plus", accent: "#3AABFF", workflow: "create" },
          { id: "bulk-import", title: "Bulk Import", desc: "Import attributes from file", icon: "upload", accent: "#00D4FF", badge: "AI" },
          { id: "attribute-groups", title: "Attribute Groups", desc: "Organize attributes into groups", icon: "layers", accent: "#00D4FF" },
          { id: "deploy", title: "Deploy", desc: "Deploy attributes to production", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "invoices",
        label: "Invoices",
        icon: "file-text",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "234",
        color: "#00D4FF",
        stats: [
          { label: "Open", value: "234" },
          { label: "Overdue", value: "18" },
          { label: "Paid 30d", value: "89" },
          { label: "Outstanding", value: "$234k" },
        ],
        actions: [
          { id: "create-invoice", title: "Create Invoice", desc: "Add a new invoice", icon: "plus", accent: "#00D4FF", workflow: "create" },
          { id: "send-reminders", title: "Send Reminders", desc: "Send payment reminders", icon: "send", accent: "#60B8FF" },
          { id: "bulk-collect", title: "Bulk Collect", desc: "Process payments in bulk", icon: "credit-card", accent: "#00D4FF" },
          { id: "aging-report", title: "Aging Report", desc: "AI invoice aging analysis", icon: "bar-chart", accent: "#3AABFF", badge: "AI" },
          { id: "export", title: "Export", desc: "Export invoices to file", icon: "download", accent: "#00D4FF" },
        ],
      },
      {
        id: "renewals",
        label: "Renewals",
        icon: "refresh",
        groupId: "revenue",
        groupLabel: "Revenue Cloud",
        badge: "23",
        color: "#00D4FF",
        stats: [
          { label: "Due 30d", value: "23" },
          { label: "Due 60d", value: "41" },
          { label: "Auto-Renew", value: "18" },
          { label: "At Risk", value: "5" },
        ],
        actions: [
          { id: "process-renewal", title: "Process Renewal", desc: "Process subscription renewals", icon: "refresh", accent: "#00D4FF", workflow: "create" },
          { id: "ai-risk-score", title: "AI Risk Score", desc: "Score renewal risk with AI", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "bulk-renew", title: "Bulk Renew", desc: "Renew multiple subscriptions", icon: "rocket", accent: "#00D4FF" },
          { id: "renewal-analytics", title: "Renewal Analytics", desc: "AI renewal trend analysis", icon: "bar-chart", accent: "#00D4FF", badge: "AI" },
          { id: "send-notice", title: "Send Notice", desc: "Send renewal notifications", icon: "send", accent: "#3AABFF" },
        ],
      },
    ],
  },
  {
    id: "service",
    label: "Service Cloud",
    icon: "life-buoy",
    color: "#3AABFF",
    items: [
      {
        id: "work-orders",
        label: "Work Orders",
        icon: "tool",
        groupId: "service",
        groupLabel: "Service Cloud",
        badge: "67",
        color: "#3AABFF",
        stats: [
          { label: "Open", value: "67" },
          { label: "In Progress", value: "34" },
          { label: "Completed 7d", value: "22" },
          { label: "Overdue", value: "4" },
        ],
        actions: [
          { id: "create-work-order", title: "Create Work Order", desc: "Add a new work order", icon: "plus", accent: "#3AABFF", workflow: "create" },
          { id: "assign-tech", title: "Assign Tech", desc: "Assign technician to work order", icon: "users", accent: "#00D4FF" },
          { id: "schedule", title: "Schedule", desc: "Schedule work order appointment", icon: "calendar", accent: "#60B8FF" },
          { id: "analytics", title: "Analytics", desc: "View work order analytics", icon: "bar-chart", accent: "#3AABFF" },
        ],
      },
      {
        id: "entitlements",
        label: "Entitlements",
        icon: "shield",
        groupId: "service",
        groupLabel: "Service Cloud",
        badge: "112",
        color: "#3AABFF",
        stats: [
          { label: "Active", value: "112" },
          { label: "Expiring 30d", value: "8" },
          { label: "Warnings", value: "3" },
          { label: "Coverage", value: "94%" },
        ],
        actions: [
          { id: "create-entitlement", title: "Create Entitlement", desc: "Add a new entitlement", icon: "plus", accent: "#3AABFF", workflow: "create" },
          { id: "bulk-renew", title: "Bulk Renew", desc: "Renew multiple entitlements", icon: "refresh", accent: "#00D4FF" },
          { id: "analytics", title: "Analytics", desc: "View entitlement analytics", icon: "bar-chart", accent: "#3AABFF" },
          { id: "import", title: "Import", desc: "Import entitlements from file", icon: "upload", accent: "#00D4FF" },
        ],
      },
      {
        id: "knowledge",
        label: "Knowledge",
        icon: "book",
        groupId: "service",
        groupLabel: "Service Cloud",
        badge: "456",
        color: "#3AABFF",
        stats: [
          { label: "Articles", value: "456" },
          { label: "Published", value: "421" },
          { label: "Draft", value: "23" },
          { label: "Views 7d", value: "3.4k" },
        ],
        actions: [
          { id: "create-article", title: "Create Article", desc: "Add a new knowledge article", icon: "plus", accent: "#3AABFF", badge: "AI", workflow: "create" },
          { id: "ai-suggest", title: "AI Suggest", desc: "AI-powered article suggestions", icon: "sparkles", accent: "#60B8FF", badge: "AI" },
          { id: "review-queue", title: "Review Queue", desc: "Review articles pending approval", icon: "list", accent: "#00D4FF" },
          { id: "analytics", title: "Analytics", desc: "View knowledge analytics", icon: "bar-chart", accent: "#3AABFF" },
        ],
      },
      {
        id: "queues",
        label: "Queues",
        icon: "list",
        groupId: "service",
        groupLabel: "Service Cloud",
        badge: "12",
        color: "#3AABFF",
        stats: [
          { label: "Queues", value: "12" },
          { label: "Members", value: "89" },
          { label: "Open", value: "234" },
          { label: "Avg Wait", value: "4.2h" },
        ],
        actions: [
          { id: "create-queue", title: "Create Queue", desc: "Add a new queue", icon: "plus", accent: "#3AABFF", workflow: "create" },
          { id: "manage-members", title: "Manage Members", desc: "Add or remove queue members", icon: "users", accent: "#00D4FF" },
          { id: "analytics", title: "Analytics", desc: "View queue analytics", icon: "bar-chart", accent: "#3AABFF" },
        ],
      },
    ],
  },
  {
    id: "custom",
    label: "Custom Objects",
    icon: "cube",
    color: "#60B8FF",
    items: [
      {
        id: "custom-records",
        label: "Custom Records",
        icon: "cube",
        groupId: "custom",
        groupLabel: "Custom Objects",
        badge: "∞",
        color: "#60B8FF",
        stats: [
          { label: "Objects", value: "12" },
          { label: "Records", value: "4.2k" },
          { label: "Active", value: "11" },
          { label: "Fields", value: "89" },
        ],
        actions: [
          { id: "create-record", title: "Create Record", desc: "Add a new custom record", icon: "plus", accent: "#60B8FF", badge: "AI", workflow: "create" },
          { id: "bulk-import", title: "Bulk Import", desc: "Import records from file", icon: "upload", accent: "#3AABFF", badge: "AI" },
          { id: "schema-view", title: "Schema View", desc: "View object schema", icon: "code", accent: "#00D4FF" },
          { id: "deploy", title: "Deploy", desc: "Deploy custom objects", icon: "rocket", accent: "#00D4FF" },
          { id: "analytics", title: "Analytics", desc: "AI-powered record analytics", icon: "bar-chart", accent: "#60B8FF", badge: "AI" },
        ],
      },
    ],
  },
];

const ALL_OBJECTS: DataObject[] = DATA_GROUPS.flatMap(g => g.items);
const AI_EXAMPLES = [
  "Create 50 healthcare accounts in the US...",
  "Find high-value opportunities closing this quarter...",
  "Show all contracts expiring in 30 days...",
  "Generate enterprise bundle orders for tech companies...",
  "Identify at-risk renewals with low engagement scores...",
  "Import contacts from CSV and deduplicate...",
  "Analyze churn risk for top 100 accounts...",
  "Create renewal orders for all subscriptions due next month...",
];

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
function Toast({ msg, type, onClose }: { msg: string; type: "success" | "info" | "error"; onClose: () => void }) {
  const colors = { success: "#00C875", info: "#00D4FF", error: "#E84444" };
  const c = colors[type];
  return (
    <motion.div
      initial={{ opacity: 0, y: -20, x: "-50%" }}
      animate={{ opacity: 1, y: 0, x: "-50%" }}
      exit={{ opacity: 0, y: -20, x: "-50%" }}
      className="fixed top-4 left-1/2 z-50 flex items-center gap-2.5 px-4 py-2.5 rounded-xl"
      style={{
        background: "rgba(1,9,24,0.92)",
        border: `1px solid ${c}40`,
        boxShadow: `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px ${c}18`,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      <span style={{ color: c }}>
        <Ic n={type === "success" ? "check-circle" : type === "error" ? "alert" : "info"} s={14} />
      </span>
      <span className="text-[12px] font-medium" style={{ color: "rgba(210,230,250,0.9)" }}>{msg}</span>
      <button onClick={onClose} style={{ color: "rgba(90,122,154,0.5)", marginLeft: 4 }}>
        <Ic n="x" s={12} />
      </button>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVBAR
// ─────────────────────────────────────────────────────────────────────────────
function NavBar({ session, isDark, onSignOut }: { session: SessionData; isDark: boolean; onSignOut: () => void }) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const isProduction = session.environment === "production";
  const name = session.displayName?.split(" ")[0] ?? session.username?.split("@")[0] ?? "User";
  const border = isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)";

  return (
    <div
      className="flex items-center justify-between px-4 h-14 shrink-0 z-20"
      style={{
        background: isDark ? "rgba(1,9,24,0.88)" : "rgba(228,238,255,0.95)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderBottom: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)",
      }}
    >
      <div className="flex items-center gap-3">
        <motion.button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.8)" : "rgba(0,31,91,0.76)", background: "transparent", border }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)" }}
          whileTap={{ scale: 0.96 }}
        >
          <Ic n="chevron-left" s={12} />
          Home
        </motion.button>
        <div className="h-4 w-px" style={{ background: isDark ? "rgba(0,212,255,0.12)" : "rgba(0,71,171,0.20)" }} />
        <div className="flex items-center gap-2">
          <Image
            src="/omnion.png"
            alt="Omnion"
            width={24}
            height={24}
            style={{ borderRadius: 4, filter: isDark ? "drop-shadow(0 0 6px rgba(0,212,255,0.5))" : "drop-shadow(0 0 4px rgba(0,71,171,0.3))" }}
          />
          <div>
            <span className="text-[13px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>
              Data Omnion
            </span>
            <span className="text-[10px] ml-2 font-mono" style={{ color: "rgba(0,212,255,0.5)" }}>OMNI-DATA</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div
          className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium"
          style={{
            background: isProduction ? "rgba(0,200,117,0.10)" : "rgba(0,212,255,0.10)",
            border: `1px solid ${isProduction ? "rgba(0,200,117,0.22)" : "rgba(0,212,255,0.22)"}`,
            color: isProduction ? "#00C875" : "#00D4FF",
          }}
        >
          <motion.span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: isProduction ? "#00C875" : "#00D4FF" }}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          {isProduction ? "Production" : "Sandbox"}
        </div>

        <motion.button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)" }}
          whileTap={{ scale: 0.93 }}
        >
          <Ic n={isDark ? "sun" : "moon"} s={13} />
        </motion.button>

        <div className="hidden sm:flex items-center gap-1.5">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "rgba(0,10,20,0.9)" }}
          >
            {name.charAt(0).toUpperCase()}
          </div>
          <span className="text-[11px]" style={{ color: isDark ? "rgba(140,170,200,0.7)" : "rgba(0,15,55,0.82)" }}>{name}</span>
        </div>

        <motion.button
          onClick={onSignOut}
          className="text-[10px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center gap-1"
          style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(0,31,91,0.66)", border, background: "transparent" }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.09)" }}
          whileTap={{ scale: 0.97 }}
        >
          <Ic n="x" s={11} />
          Sign out
        </motion.button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────────────────────
function SidebarItem({
  obj, isDark, selected, onSelect, collapsed,
}: { obj: DataObject; isDark: boolean; selected: boolean; onSelect: () => void; collapsed: boolean }) {
  const rgb = hexToRgb(obj.color);
  return (
    <motion.button
      onClick={onSelect}
      title={collapsed ? obj.label : undefined}
      className={`w-full text-left flex items-center gap-2 rounded-lg mb-0.5 cursor-pointer relative ${collapsed ? "justify-center px-0 py-2" : "px-2.5 py-1.5"}`}
      style={{
        background: selected
          ? isDark ? `rgba(${rgb},0.12)` : `rgba(${rgb},0.09)`
          : "transparent",
        color: selected ? obj.color : isDark ? "rgba(140,170,210,0.7)" : "rgba(0,15,55,0.82)",
        borderLeft: !collapsed && selected ? `2px solid ${obj.color}` : "2px solid transparent",
        transition: "background 0.18s, color 0.18s",
      }}
      whileHover={{
        background: selected
          ? isDark ? `rgba(${rgb},0.15)` : `rgba(${rgb},0.12)`
          : isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.09)",
      }}
      whileTap={{ scale: 0.98 }}
    >
      <span style={{ opacity: selected ? 1 : 0.65, flexShrink: 0 }}><Ic n={obj.icon} s={14} /></span>
      {!collapsed && (
        <>
          <span className="flex-1 text-[12px] font-medium truncate">{obj.label}</span>
          {obj.badge && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
              style={{
                background: selected ? `rgba(${rgb},0.18)` : isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.12)",
                color: selected ? obj.color : isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.70)",
              }}
            >
              {obj.badge}
            </span>
          )}
        </>
      )}
    </motion.button>
  );
}

function SidebarGroupSection({
  group, isDark, selectedId, onSelect, collapsed, openGroups, onToggleGroup,
}: {
  group: DataGroup; isDark: boolean; selectedId: string; onSelect: (id: string) => void;
  collapsed: boolean; openGroups: Record<string, boolean>; onToggleGroup: (id: string) => void;
}) {
  const isOpen = openGroups[group.id] ?? true;
  const borderColor = isDark ? "rgba(0,212,255,0.07)" : "rgba(0,71,171,0.12)";

  if (collapsed) {
    return (
      <div className="py-1">
        <div className="h-px mx-2 my-1" style={{ background: borderColor }} />
        {group.items.map(obj => (
          <SidebarItem key={obj.id} obj={obj} isDark={isDark} selected={selectedId === obj.id} onSelect={() => onSelect(obj.id)} collapsed />
        ))}
      </div>
    );
  }

  return (
    <div className="py-1">
      <button
        onClick={() => onToggleGroup(group.id)}
        className="w-full flex items-center gap-2 px-3 py-1.5 cursor-pointer"
        style={{ color: isDark ? "rgba(90,122,154,0.55)" : "rgba(0,31,91,0.62)" }}
      >
        <span style={{ color: group.color, opacity: 0.7 }}><Ic n={group.icon} s={12} /></span>
        <span className="flex-1 text-[10px] font-semibold tracking-wide uppercase">{group.label}</span>
        <motion.span animate={{ rotate: isOpen ? 0 : -90 }} transition={{ duration: 0.2 }}>
          <Ic n="chevron-down" s={11} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden px-2"
          >
            {group.items.map(obj => (
              <SidebarItem key={obj.id} obj={obj} isDark={isDark} selected={selectedId === obj.id} onSelect={() => onSelect(obj.id)} collapsed={false} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({
  isDark, selectedId, onSelect, collapsed, onToggle,
}: { isDark: boolean; selectedId: string; onSelect: (id: string) => void; collapsed: boolean; onToggle: () => void }) {
  const [search, setSearch] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    Object.fromEntries(DATA_GROUPS.map(g => [g.id, true]))
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return ALL_OBJECTS.filter(o => o.label.toLowerCase().includes(q) || o.groupLabel.toLowerCase().includes(q));
  }, [search]);

  const borderColor = isDark ? "rgba(0,212,255,0.1)" : "rgba(0,71,171,0.18)";

  return (
    <motion.div
      animate={{ width: collapsed ? 52 : 252 }}
      transition={{ type: "spring", stiffness: 340, damping: 34 }}
      className="shrink-0 flex flex-col h-full overflow-hidden relative"
      style={{ background: isDark ? "rgba(0,5,14,0.72)" : "rgba(216,228,247,0.97)", borderRight: `1px solid ${borderColor}` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
              className="text-[10px] font-medium tracking-widest uppercase"
              style={{ color: isDark ? "rgba(0,212,255,0.45)" : "rgba(0,71,171,0.66)" }}
            >
              CRM Objects
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button
          onClick={onToggle}
          className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(0,31,91,0.62)", marginLeft: collapsed ? "auto" : 0 }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.12)" }}
          whileTap={{ scale: 0.9 }}
        >
          <Ic n="panel-left" s={14} />
        </motion.button>
      </div>

      {/* Search */}
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="px-3 py-2 shrink-0"
            style={{ borderBottom: `1px solid ${borderColor}` }}
          >
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
              style={{ background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.09)", border: isDark ? "1px solid rgba(0,212,255,0.12)" : "1px solid rgba(0,71,171,0.20)" }}
            >
              <span style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.58)" }}><Ic n="search" s={12} /></span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search objects…"
                className="flex-1 bg-transparent outline-none text-[12px]"
                style={{ color: isDark ? "rgba(180,210,240,0.85)" : "rgba(0,31,91,0.8)" }}
              />
              {search && (
                <button onClick={() => setSearch("")} style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.56)" }}>
                  <Ic n="x" s={11} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
        <AnimatePresence mode="wait">
          {!collapsed ? (
            <motion.div key="expanded" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {filtered ? (
                <div className="py-2 px-2">
                  {filtered.length === 0 ? (
                    <p className="text-[11px] px-2 py-3" style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.58)" }}>No results</p>
                  ) : (
                    filtered.map(obj => (
                      <SidebarItem key={obj.id} obj={obj} isDark={isDark} selected={selectedId === obj.id} onSelect={() => onSelect(obj.id)} collapsed={false} />
                    ))
                  )}
                </div>
              ) : (
                DATA_GROUPS.map(group => (
                  <SidebarGroupSection
                    key={group.id} group={group} isDark={isDark} selectedId={selectedId}
                    onSelect={onSelect} collapsed={false} openGroups={openGroups}
                    onToggleGroup={id => setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }))}
                  />
                ))
              )}
            </motion.div>
          ) : (
            <motion.div key="collapsed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="py-2 flex flex-col items-center gap-1">
              {ALL_OBJECTS.map(obj => (
                <SidebarItem key={obj.id} obj={obj} isDark={isDark} selected={selectedId === obj.id} onSelect={() => onSelect(obj.id)} collapsed />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI COMMAND BAR
// ─────────────────────────────────────────────────────────────────────────────
function AICommandBar({ isDark, value, onChange, onSubmit }: {
  isDark: boolean; value: string; onChange: (v: string) => void; onSubmit: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [phIdx, setPhIdx] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setPhIdx(p => (p + 1) % AI_EXAMPLES.length), 3600);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  return (
    <div
      className="px-5 py-3.5 shrink-0"
      style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}
    >
      <motion.div
        className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
        animate={{
          borderColor: focused ? "rgba(0,212,255,0.35)" : isDark ? "rgba(0,212,255,0.1)" : "rgba(0,71,171,0.20)",
          boxShadow: focused ? "0 0 0 3px rgba(0,212,255,0.07)" : "none",
        }}
        transition={{ duration: 0.2 }}
        style={{
          background: isDark ? "rgba(0,212,255,0.03)" : "rgba(225,238,255,0.90)",
          border: "1px solid",
          borderColor: isDark ? "rgba(0,212,255,0.1)" : "rgba(0,71,171,0.20)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        <motion.span
          animate={{ rotate: focused ? [0, 360] : 0, color: focused ? "#00D4FF" : isDark ? "rgba(0,212,255,0.45)" : "rgba(0,71,171,0.66)" }}
          transition={{ duration: 0.5 }}
        >
          <Ic n="sparkles" s={15} />
        </motion.span>

        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={e => { if (e.key === "Enter" && value.trim()) onSubmit(); }}
          className="flex-1 bg-transparent outline-none text-[13px]"
          style={{ color: isDark ? "rgba(200,225,245,0.9)" : "rgba(0,15,45,0.85)" }}
          placeholder={AI_EXAMPLES[phIdx]}
        />

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden sm:flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded" style={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)", color: isDark ? "rgba(0,212,255,0.4)" : "rgba(0,71,171,0.66)" }}>
            <kbd style={{ fontFamily: "monospace" }}>⌘</kbd>
            <kbd style={{ fontFamily: "monospace" }}>K</kbd>
          </span>
          {value.trim() && (
            <motion.button
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              onClick={onSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer"
              style={{ background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)", color: "rgba(0,10,20,0.9)" }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
            >
              <Ic n="send" s={12} />
              Run
            </motion.button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION CARD
// ─────────────────────────────────────────────────────────────────────────────
function ActionCard({ action, isDark, index, onLaunch }: {
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
const RECENT_OPS = [
  { type: "Created", item: "Acme Healthcare", meta: "Account", time: "3 min ago", color: "#00D4FF" },
  { type: "Updated", item: "ENT-2025-00312", meta: "Order", time: "18 min ago", color: "#3AABFF" },
  { type: "Renewed", item: "GlobalTech Contract", meta: "Contract", time: "2 hr ago", color: "#60B8FF" },
  { type: "Generated", item: "Q4 Enterprise Bundle", meta: "Bundle", time: "5 hr ago", color: "#3AABFF" },
  { type: "Imported", item: "450 Healthcare Contacts", meta: "Contact", time: "Yesterday", color: "#00D4FF" },
];

function ObjectWorkspace({ obj, isDark, onLaunch }: {
  obj: DataObject; isDark: boolean; onLaunch: (wf: string) => void;
}) {
  const rgb = hexToRgb(obj.color);

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

          {/* Recent activity */}
          <div className="h-px mb-6" style={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.10)" }} />
          <p className="text-[10px] font-semibold tracking-widest uppercase mb-4" style={{ color: isDark ? "rgba(0,212,255,0.45)" : "rgba(0,71,171,0.62)" }}>
            Recent Activity
          </p>
          <div className="flex flex-col gap-1.5">
            {RECENT_OPS.map((op, i) => (
              <motion.div
                key={op.item}
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
// FIELD INPUT
// ─────────────────────────────────────────────────────────────────────────────
function FieldInput({ field, value, onChange, isDark }: {
  field: FieldDef; value: string; onChange: (v: string) => void; isDark: boolean;
}) {
  const [focused, setFocused] = useState(false);

  const baseStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    background: isDark
      ? focused ? "rgba(0,212,255,0.06)" : "rgba(0,212,255,0.03)"
      : focused ? "rgba(246,250,255,0.98)" : "rgba(226,239,255,0.92)",
    border: focused
      ? "1px solid rgba(0,212,255,0.35)"
      : isDark ? "1px solid rgba(0,212,255,0.13)" : "1px solid rgba(0,71,171,0.22)",
    boxShadow: focused ? "0 0 0 3px rgba(0,212,255,0.07)" : "none",
    color: isDark ? "rgba(200,225,245,0.9)" : "rgba(0,15,45,0.85)",
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
    transition: "border 0.18s, box-shadow 0.18s, background 0.18s",
  };

  const handlers = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };

  return (
    <div className={field.span === 2 ? "col-span-2" : ""}>
      <label className="block text-[11px] font-medium mb-1.5" style={{ color: isDark ? "rgba(130,160,200,0.7)" : "rgba(0,15,55,0.78)" }}>
        {field.label}
        {field.required && <span style={{ color: "#00D4FF", marginLeft: 3 }}>*</span>}
      </label>

      {field.type === "textarea" ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          {...handlers}
          rows={3}
          placeholder={field.placeholder}
          style={{ ...baseStyle, resize: "vertical" }}
        />
      ) : field.type === "select" ? (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          {...handlers}
          style={{ ...baseStyle, cursor: "pointer", appearance: "none" }}
        >
          <option value="">Select {field.label}…</option>
          {field.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      ) : (
        <input
          type={field.type === "currency" ? "text" : field.type === "phone" ? "tel" : field.type === "url" ? "url" : field.type === "email" ? "email" : field.type === "number" ? "number" : "text"}
          value={value}
          onChange={e => onChange(e.target.value)}
          {...handlers}
          placeholder={field.type === "currency" && !field.placeholder ? "$0.00" : field.placeholder}
          style={baseStyle}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKFLOW FORM (Create Record deep workspace)
// ─────────────────────────────────────────────────────────────────────────────
function WorkflowForm({ obj, isDark, formData, onChange, onPreview, onCancel }: {
  obj: DataObject; isDark: boolean;
  formData: Record<string, string>;
  onChange: (id: string, val: string) => void;
  onPreview: () => void;
  onCancel: () => void;
}) {
  const form = obj.form ?? DEFAULT_FORM;
  const requiredFields = form.flatMap(s => s.fields.filter(f => f.required));
  const filledRequired = requiredFields.filter(f => formData[f.id]?.trim()).length;
  const allFilled = filledRequired === requiredFields.length;
  const progress = requiredFields.length ? Math.min(100, (filledRequired / requiredFields.length) * 100) : 100;

  return (
    <div className="flex flex-col h-full">
      {/* Form header */}
      <div
        className="px-6 py-3.5 shrink-0 flex items-center justify-between gap-4"
        style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,71,171,0.14)" }}
      >
        <div className="flex items-center gap-3">
          <motion.button
            onClick={onCancel}
            className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
            style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)", background: "transparent" }}
            whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.09)" }}
            whileTap={{ scale: 0.97 }}
          >
            <Ic n="arrow-left" s={12} />
            Cancel
          </motion.button>
          <div className="h-4 w-px" style={{ background: isDark ? "rgba(0,212,255,0.12)" : "rgba(0,71,171,0.18)" }} />
          <div>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `rgba(${hexToRgb(obj.color)},0.2)`, color: obj.color }}>
                <Ic n={obj.icon} s={12} />
              </div>
              <span className="text-[14px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>
                Create {obj.label.replace(/s$/, "").replace(/ies$/, "y")}
              </span>
            </div>
            <p className="text-[10px] ml-7 mt-0.5" style={{ color: isDark ? "rgba(100,130,170,0.55)" : "rgba(0,15,55,0.67)" }}>
              {form.length} sections · {requiredFields.length} required fields
            </p>
          </div>
        </div>

        {/* Progress pill */}
        <div className="hidden sm:flex items-center gap-2.5 shrink-0">
          <div className="h-1.5 w-32 rounded-full overflow-hidden" style={{ background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,71,171,0.14)" }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: allFilled ? "linear-gradient(90deg, #1E90FF, #00D4FF)" : "linear-gradient(90deg, #1E90FF, #3AABFF)" }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.35 }}
            />
          </div>
          <span className="text-[10px] font-mono" style={{ color: isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.66)" }}>
            {filledRequired}/{requiredFields.length}
          </span>
        </div>
      </div>

      {/* Form sections */}
      <div className="flex-1 overflow-y-auto px-6 py-6" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          {form.map((section, si) => (
            <motion.div
              key={section.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: si * 0.055, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-xl overflow-hidden"
              style={{
                background: isDark ? "rgba(6,14,28,0.6)" : "rgba(226,239,255,0.92)",
                border: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,71,171,0.14)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              <div
                className="flex items-center gap-2 px-5 py-3"
                style={{
                  borderBottom: isDark ? "1px solid rgba(0,212,255,0.06)" : "1px solid rgba(0,71,171,0.10)",
                  background: isDark ? "rgba(0,212,255,0.025)" : "rgba(0,71,171,0.10)",
                }}
              >
                <span style={{ color: isDark ? "rgba(0,212,255,0.55)" : "rgba(0,71,171,0.70)" }}><Ic n={section.icon} s={14} /></span>
                <span className="text-[12px] font-semibold" style={{ color: isDark ? "rgba(160,190,220,0.8)" : "rgba(0,15,55,0.88)" }}>{section.label}</span>
              </div>
              <div className="p-5 grid grid-cols-2 gap-4">
                {section.fields.map(field => (
                  <FieldInput
                    key={field.id} field={field}
                    value={formData[field.id] ?? ""}
                    onChange={v => onChange(field.id, v)}
                    isDark={isDark}
                  />
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Footer actions */}
      <div
        className="px-6 py-3.5 shrink-0 flex items-center justify-between gap-3"
        style={{
          borderTop: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,71,171,0.14)",
          background: isDark ? "rgba(1,9,24,0.55)" : "rgba(220,233,255,0.90)",
        }}
      >
        <motion.button
          onClick={onCancel}
          className="text-[12px] font-medium px-4 py-2 rounded-lg cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)", background: "transparent" }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.09)" }}
          whileTap={{ scale: 0.97 }}
        >
          Cancel
        </motion.button>

        <div className="flex items-center gap-2">
          <motion.button
            className="text-[12px] font-medium px-4 py-2 rounded-lg cursor-pointer"
            style={{
              color: isDark ? "rgba(0,212,255,0.75)" : "#0047AB",
              border: isDark ? "1px solid rgba(0,212,255,0.2)" : "1px solid rgba(0,71,171,0.32)",
              background: "transparent",
            }}
            whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.09)" }}
            whileTap={{ scale: 0.97 }}
          >
            Save Draft
          </motion.button>

          <motion.button
            onClick={allFilled ? onPreview : undefined}
            className="text-[12px] font-semibold px-5 py-2 rounded-lg flex items-center gap-2"
            style={{
              background: allFilled
                ? "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)"
                : isDark ? "rgba(0,212,255,0.07)" : "rgba(0,71,171,0.12)",
              color: allFilled ? "rgba(0,10,20,0.92)" : isDark ? "rgba(0,212,255,0.28)" : "rgba(0,71,171,0.48)",
              cursor: allFilled ? "pointer" : "not-allowed",
              transition: "background 0.22s, color 0.22s",
            }}
            whileHover={allFilled ? { scale: 1.025 } : {}}
            whileTap={allFilled ? { scale: 0.97 } : {}}
          >
            <Ic n="eye" s={13} />
            Preview Record
          </motion.button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW PANEL
// ─────────────────────────────────────────────────────────────────────────────
const AI_RECS = [
  { icon: "check-circle", text: "All required fields present — record is ready to create.", ok: true },
  { icon: "info", text: "Consider adding a Description for improved search and reporting.", ok: false },
  { icon: "sparkles", text: "AI suggests linking a Parent Account based on domain pattern.", ok: false },
];

function PreviewPanel({ obj, isDark, formData, saving, onBack, onCreate, onCancel }: {
  obj: DataObject; isDark: boolean;
  formData: Record<string, string>;
  saving: boolean;
  onBack: () => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const form = obj.form ?? DEFAULT_FORM;
  const allFields = form.flatMap(s => s.fields);
  const filled = Object.entries(formData).filter(([, v]) => v.trim());
  const rgb = hexToRgb(obj.color);
  const contactName = formData.firstName ? `${formData.firstName} ${formData.lastName ?? ""}`.trim() : "";
  const recordName =
    formData.name ||
    formData.orderName ||
    formData.opportunityName ||
    contactName ||
    `New ${obj.label.replace(/s$/, "")}`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="px-6 py-3.5 shrink-0 flex items-center gap-3"
        style={{ borderBottom: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,71,171,0.14)" }}
      >
        <motion.button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)", background: "transparent" }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.09)" }}
          whileTap={{ scale: 0.97 }}
        >
          <Ic n="arrow-left" s={12} />
          Back to Form
        </motion.button>
        <div>
          <span className="text-[14px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>
            Preview Record
          </span>
          <span className="text-[10px] ml-2 font-mono" style={{ color: "rgba(0,212,255,0.5)" }}>AI REVIEW</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarWidth: "thin" }}>
        <div className="max-w-3xl mx-auto flex flex-col gap-5">

          {/* Record card */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-xl p-5"
            style={{
              background: isDark
                ? `linear-gradient(135deg, rgba(${rgb},0.09) 0%, rgba(8,16,32,0.72) 100%)`
                : `linear-gradient(135deg, rgba(${rgb},0.07) 0%, rgba(230,242,255,0.88) 100%)`,
              border: `1px solid rgba(${rgb},0.22)`,
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: `rgba(${rgb},0.2)`, color: obj.color, border: `1px solid rgba(${rgb},0.3)`, boxShadow: `0 0 16px rgba(${rgb},0.15)` }}
              >
                <Ic n={obj.icon} s={20} />
              </div>
              <div>
                <p className="text-[15px] font-bold" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.02em" }}>{recordName}</p>
                <p className="text-[11px]" style={{ color: isDark ? "rgba(100,130,170,0.6)" : "rgba(0,15,55,0.70)" }}>
                  {obj.label.replace(/s$/, "")} · {filled.length} fields populated
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <motion.span className="w-2 h-2 rounded-full" style={{ background: "#00D4FF" }} animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
                <span className="text-[10px] font-medium" style={{ color: "#00D4FF" }}>Ready</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {filled.slice(0, 8).map(([key, val]) => {
                const fd = allFields.find(f => f.id === key);
                return (
                  <div key={key} className="rounded-lg px-3 py-2" style={{ background: isDark ? "rgba(0,212,255,0.04)" : "rgba(0,71,171,0.08)", border: isDark ? "1px solid rgba(0,212,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}>
                    <p className="text-[10px] mb-0.5" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.65)" }}>{fd?.label ?? key}</p>
                    <p className="text-[12px] font-medium truncate" style={{ color: isDark ? "rgba(200,225,245,0.85)" : "rgba(0,15,45,0.8)" }}>{val}</p>
                  </div>
                );
              })}
            </div>
          </motion.div>

          {/* AI Recommendations */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="rounded-xl p-5"
            style={{
              background: isDark ? "rgba(6,14,28,0.6)" : "rgba(225,238,255,0.90)",
              border: isDark ? "1px solid rgba(0,212,255,0.14)" : "1px solid rgba(0,212,255,0.18)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span style={{ color: "#1E90FF" }}><Ic n="sparkles" s={14} /></span>
              <span className="text-[11px] font-semibold tracking-widest" style={{ color: "#1E90FF" }}>AI RECOMMENDATIONS</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {AI_RECS.map((r, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.05 }}
                  className="flex items-start gap-2.5 text-[12px] leading-relaxed"
                  style={{ color: isDark ? "rgba(160,190,220,0.75)" : "rgba(0,15,55,0.84)" }}
                >
                  <span className="mt-0.5 shrink-0" style={{ color: r.ok ? "#00C875" : isDark ? "rgba(0,212,255,0.5)" : "rgba(0,71,171,0.72)" }}>
                    <Ic n={r.icon} s={13} />
                  </span>
                  {r.text}
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Footer */}
      <div
        className="px-6 py-3.5 shrink-0 flex items-center justify-between gap-3"
        style={{ borderTop: isDark ? "1px solid rgba(0,212,255,0.08)" : "1px solid rgba(0,71,171,0.14)", background: isDark ? "rgba(1,9,24,0.55)" : "rgba(220,233,255,0.90)" }}
      >
        <motion.button
          onClick={onCancel}
          className="text-[12px] font-medium px-4 py-2 rounded-lg cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border: isDark ? "1px solid rgba(0,212,255,0.1)" : "1px solid rgba(0,71,171,0.18)", background: "transparent" }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.05)" : "rgba(0,71,171,0.09)" }}
          whileTap={{ scale: 0.97 }}
        >
          Cancel
        </motion.button>

        <div className="flex items-center gap-2">
          <motion.button
            onClick={onBack}
            className="text-[12px] font-medium px-4 py-2 rounded-lg cursor-pointer"
            style={{ color: isDark ? "rgba(0,212,255,0.8)" : "#0047AB", border: isDark ? "1px solid rgba(0,212,255,0.2)" : "1px solid rgba(0,71,171,0.32)", background: "transparent" }}
            whileHover={{ background: isDark ? "rgba(0,212,255,0.06)" : "rgba(0,71,171,0.09)" }}
            whileTap={{ scale: 0.97 }}
          >
            Back to Edit
          </motion.button>

          <motion.button
            onClick={saving ? undefined : onCreate}
            className="text-[12px] font-semibold px-5 py-2 rounded-lg flex items-center gap-2 cursor-pointer"
            style={{ background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)", color: "rgba(0,10,20,0.92)" }}
            whileHover={saving ? {} : { scale: 1.025 }}
            whileTap={saving ? {} : { scale: 0.97 }}
          >
            {saving ? (
              <>
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}>
                  <Ic n="refresh" s={13} />
                </motion.span>
                Creating…
              </>
            ) : (
              <>
                <Ic n="check-circle" s={13} />
                Create Record
              </>
            )}
          </motion.button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS PANEL
// ─────────────────────────────────────────────────────────────────────────────
function SuccessPanel({ obj, isDark, recordId, onCreateAnother, onReturn }: {
  obj: DataObject; isDark: boolean; recordId: string | null; onCreateAnother: () => void; onReturn: () => void;
}) {
  const demoId = useRef(`${obj.label.slice(0, 3).toUpperCase()}-${Math.floor(Math.random() * 90000 + 10000)}`);

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 text-center">
      <motion.div
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 240, damping: 18 }}
        className="relative mb-8"
      >
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ border: "1px solid rgba(0,212,255,0.3)" }}
          animate={{ scale: [1, 1.7, 1.7], opacity: [0.5, 0, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ border: "1px solid rgba(30,144,255,0.15)" }}
          animate={{ scale: [1, 2.2, 2.2], opacity: [0.3, 0, 0] }}
          transition={{ duration: 2, delay: 0.4, repeat: Infinity }}
        />
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center relative z-10"
          style={{
            background: "rgba(30,144,255,0.12)",
            border: "1.5px solid rgba(30,144,255,0.45)",
            color: "#1E90FF",
            boxShadow: "0 0 40px rgba(30,144,255,0.25)",
          }}
        >
          <Ic n="check-circle" s={44} />
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
        <div className="text-[10px] font-mono tracking-widest mb-2" style={{ color: "rgba(0,212,255,0.6)" }}>
          RECORD CREATED SUCCESSFULLY
        </div>
        <h2 className="text-[26px] font-black mb-2" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.03em" }}>
          {obj.label.replace(/s$/, "").replace(/ies$/, "y")} Created
        </h2>
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl mb-3"
          style={{
            background: isDark ? "rgba(0,212,255,0.08)" : "rgba(0,212,255,0.06)",
            border: "1px solid rgba(0,212,255,0.22)",
          }}
        >
          <span className="text-[10px] font-mono" style={{ color: "rgba(0,212,255,0.6)" }}>ID</span>
          <span className="text-[13px] font-mono font-semibold" style={{ color: "#00D4FF" }}>{recordId ?? demoId.current}</span>
        </div>
        <p className="text-[12px]" style={{ color: isDark ? "rgba(100,130,170,0.6)" : "rgba(0,15,55,0.70)" }}>
          {recordId ? "Record created in Salesforce." : "Demo mode — no Salesforce org connected."}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.38 }}
        className="flex items-center gap-3 mt-9"
      >
        <motion.button
          onClick={onCreateAnother}
          className="text-[12px] font-medium px-5 py-2.5 rounded-xl cursor-pointer"
          style={{
            color: isDark ? "rgba(0,212,255,0.85)" : "#0047AB",
            border: isDark ? "1px solid rgba(0,212,255,0.22)" : "1px solid rgba(0,71,171,0.32)",
            background: "transparent",
          }}
          whileHover={{ background: isDark ? "rgba(0,212,255,0.07)" : "rgba(0,71,171,0.10)" }}
          whileTap={{ scale: 0.97 }}
        >
          + Create Another
        </motion.button>

        <motion.button
          onClick={onReturn}
          className="text-[12px] font-semibold px-5 py-2.5 rounded-xl cursor-pointer flex items-center gap-2"
          style={{ background: "linear-gradient(135deg, #1E90FF 0%, #00D4FF 100%)", color: "rgba(0,10,20,0.92)" }}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
        >
          <Ic n="arrow-left" s={13} />
          Back to {obj.label}
        </motion.button>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function DataPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [session, setSession] = useState<SessionData | null>(null);
  const [mounted, setMounted] = useState(false);

  // Navigation + workspace state
  const [selectedId, setSelectedId] = useState("accounts");
  const [mode, setMode] = useState<AppMode>("browse");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Form state
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [createdRecordId, setCreatedRecordId] = useState<string | null>(null);

  // Command bar
  const [commandValue, setCommandValue] = useState("");

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: "success" | "info" | "error" } | null>(null);

  const showToast = (msg: string, type: "success" | "info" | "error" = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    setMounted(true);
    if (!loadIdentity()) { router.replace("/login"); return; }
    if (!isSetupComplete()) { router.replace("/setup"); return; }
    const s = loadSession();
    if (!s) { router.replace("/setup"); return; }
    setSession(s);
  }, [router]);

  const selectedObj = useMemo(
    () => ALL_OBJECTS.find(o => o.id === selectedId) ?? ALL_OBJECTS[0],
    [selectedId]
  );

  const handleSelectObject = (id: string) => {
    setSelectedId(id);
    if (mode !== "browse") {
      setMode("browse");
      setSidebarCollapsed(false);
      setFormData({});
    }
  };

  const handleLaunchWorkflow = (_wf: string) => {
    setMode("workflow");
    setSidebarCollapsed(true);
    setFormData({});
  };

  const handleCancelWorkflow = () => {
    setMode("browse");
    setSidebarCollapsed(false);
    setFormData({});
  };

  const handleCreateRecord = async () => {
    setSaving(true);

    if (!selectedObj.sfApiName) {
      await new Promise(r => setTimeout(r, 1200));
      setCreatedRecordId(null);
      setSaving(false);
      setMode("success");
      return;
    }

    const map = selectedObj.fieldMap ?? {};
    const sfFields: Record<string, unknown> = {};
    for (const [formKey, value] of Object.entries(formData)) {
      const sfKey = map[formKey];
      if (sfKey && value) sfFields[sfKey] = value;
    }

    try {
      const res = await fetch(`/api/sf/record/${selectedObj.sfApiName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: sfFields }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error ?? "Failed to create record", "error");
        setSaving(false);
        return;
      }
      setCreatedRecordId(data.id ?? null);
      setSaving(false);
      setMode("success");
    } catch {
      showToast("Network error — could not reach Salesforce", "error");
      setSaving(false);
    }
  };

  const handleSuccessReturn = () => {
    setMode("browse");
    setSidebarCollapsed(false);
    setFormData({});
    showToast(`${selectedObj.label.replace(/s$/, "")} created successfully`, "success");
  };

  if (!mounted || !session) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000508" }}>
        <motion.div
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          style={{ color: "rgba(0,212,255,0.4)", fontSize: "12px", fontFamily: "monospace" }}
        >
          LOADING…
        </motion.div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        height: "100vh",
        background: isDark
          ? "linear-gradient(160deg, #000508 0%, #010918 60%, #000305 100%)"
          : "linear-gradient(160deg, #D2DDEF 0%, #DCE8F6 60%, #CCDAEC 100%)",
        position: "relative",
      }}
    >
      {/* Ambient grid */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(${isDark ? "rgba(0,212,255,0.025)" : "rgba(0,71,171,0.025)"} 1px, transparent 1px), linear-gradient(90deg, ${isDark ? "rgba(0,212,255,0.025)" : "rgba(0,71,171,0.025)"} 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background: isDark
              ? "radial-gradient(ellipse 55% 40% at 72% 22%, rgba(0,212,255,0.04) 0%, transparent 60%), radial-gradient(ellipse 45% 35% at 28% 78%, rgba(0,212,255,0.03) 0%, transparent 55%)"
              : "radial-gradient(ellipse 55% 40% at 72% 22%, rgba(0,71,171,0.09) 0%, transparent 60%)",
          }}
        />
      </div>

      {/* Toast layer */}
      <AnimatePresence>
        {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>

      <div className="relative z-10 flex flex-col h-full">
        <NavBar
          session={session}
          isDark={isDark}
          onSignOut={() => { clearSession(); clearIdentity(); clearSetup(); router.replace("/login"); }}
        />

        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            isDark={isDark}
            selectedId={selectedId}
            onSelect={handleSelectObject}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(v => !v)}
          />

          {/* Main workspace panel */}
          <div
            className="flex-1 overflow-hidden flex flex-col"
            style={{
              background: isDark ? "rgba(1,9,24,0.42)" : "rgba(218,232,255,0.60)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            <AnimatePresence mode="wait">
              {mode === "browse" && (
                <motion.div
                  key="browse"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col h-full overflow-hidden"
                >
                  {selectedObj.id === "products" ? (
                    <RCProductWorkspace isDark={isDark} />
                  ) : selectedObj.id === "bundles" ? (
                    <BundleOrchestrationWorkspace isDark={isDark} />
                  ) : selectedObj.id === "attributes" ? (
                    <RCAAttributeStudio isDark={isDark} />
                  ) : (
                    <>
                      <AICommandBar
                        isDark={isDark}
                        value={commandValue}
                        onChange={setCommandValue}
                        onSubmit={() => {
                          if (commandValue.trim()) {
                            showToast("AI command queued — processing asynchronously", "info");
                            setCommandValue("");
                          }
                        }}
                      />
                      <ObjectWorkspace obj={selectedObj} isDark={isDark} onLaunch={handleLaunchWorkflow} />
                    </>
                  )}
                </motion.div>
              )}

              {(mode === "workflow" || mode === "preview") && (
                <motion.div
                  key="form"
                  initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  className="flex flex-col h-full overflow-hidden"
                >
                  {mode === "workflow" ? (
                    <WorkflowForm
                      obj={selectedObj}
                      isDark={isDark}
                      formData={formData}
                      onChange={(id, val) => setFormData(prev => ({ ...prev, [id]: val }))}
                      onPreview={() => setMode("preview")}
                      onCancel={handleCancelWorkflow}
                    />
                  ) : (
                    <PreviewPanel
                      obj={selectedObj}
                      isDark={isDark}
                      formData={formData}
                      saving={saving}
                      onBack={() => setMode("workflow")}
                      onCreate={handleCreateRecord}
                      onCancel={handleCancelWorkflow}
                    />
                  )}
                </motion.div>
              )}

              {mode === "success" && (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  className="flex flex-col h-full"
                >
                  <SuccessPanel
                    obj={selectedObj}
                    isDark={isDark}
                    recordId={createdRecordId}
                    onCreateAnother={() => { setMode("workflow"); setFormData({}); setCreatedRecordId(null); }}
                    onReturn={handleSuccessReturn}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
