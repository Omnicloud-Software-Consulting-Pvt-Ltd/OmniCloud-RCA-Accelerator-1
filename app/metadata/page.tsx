"use client";

import { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import Image from "next/image";
import { loadSession, clearSession } from "@/lib/auth/session";
import { loadIdentity, isSetupComplete, clearIdentity, clearSetup } from "@/lib/auth/identity";
import type { SessionData } from "@/lib/auth/types";
// ─────────────────────────────────────────────────────────────────────────────
// ICON SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function Ic({ n, s = 16 }: { n: string; s?: number }) {
  const icons: Record<string, React.ReactNode> = {
    cube: <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />,
    columns: <><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="18" rx="1" /></>,
    tag: <><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
    bolt: <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
    code: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    flow: <><rect x="2" y="3" width="6" height="6" rx="1" /><rect x="16" y="3" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><path d="M5 9v3a1 1 0 001 1h12a1 1 0 001-1V9" /><line x1="12" y1="13" x2="12" y2="15" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    "check-shield": <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></>,
    layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></>,
    globe: <><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></>,
    "file-text": <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
    "bar-chart": <><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>,
    "bar-chart-2": <><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>,
    key: <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />,
    plug: <><path d="M7 16.5a3.5 3.5 0 015 0" /><path d="M7.5 11v-2" /><path d="M16.5 11v-2" /><path d="M9 2v3" /><path d="M15 2v3" /></>,
    "user-check": <><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="8.5" cy="7" r="4" /><polyline points="17 11 19 13 23 9" /></>,
    aura: <><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    upload: <><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" /></>,
    users: <><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></>,
    rocket: <><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" /></>,
    edit: <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>,
    toggle: <><rect x="1" y="5" width="22" height="14" rx="7" /><circle cx="16" cy="12" r="3" /></>,
    bug: <><path d="M8 2l1.88 1.88" /><path d="M14.12 3.88L16 2" /><path d="M9 7.13v-1a3.003 3.003 0 116 0v1" /><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z" /><path d="M12 20v-9" /><path d="M6 13H2" /><path d="M18 13h4" /></>,
    "git-branch": <><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 01-9 9" /></>,
    play: <polygon points="5 3 19 12 5 21 5 3" />,
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    wand: <><path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8L19 13" /><path d="M15 9h.01" /><path d="M17.8 6.2L19 5" /><path d="M3 21l9-9" /><path d="M12.2 6.2L11 5" /></>,
    table: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /></>,
    list: <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>,
    search: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
    alert: <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
    share: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></>,
    download: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    refresh: <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></>,
    "arrow-right": <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></>,
    branch: <><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 01-9 9" /></>,
    "chevron-right": <polyline points="9 18 15 12 9 6" />,
    "chevron-down": <polyline points="6 9 12 15 18 9" />,
    "chevron-left": <polyline points="15 18 9 12 15 6" />,
    "panel-left": <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></>,
    home: <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    "pie-chart": <><path d="M21.21 15.89A10 10 0 118 2.83" /><path d="M22 12A10 10 0 0012 2v10z" /></>,
    "compile": <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
    "function": <><path d="M4 4l16 0" /><path d="M4 9l8 0" /><path d="M4 14l16 0" /><path d="M4 19l8 0" /></>,
    "link": <><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></>,
    moon: <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />,
    sun: <><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icons[n] ?? <circle cx="12" cy="12" r="5" />}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface StatDef { label: string; value: string }
interface ActionDef { id: string; title: string; desc: string; icon: string; accent: string; badge?: string }
interface MetaItem { id: string; label: string; icon: string; groupId: string; groupLabel: string; desc: string; stats: StatDef[]; actions: ActionDef[]; sfMetadataType?: string }
interface MetaGroup { id: string; label: string; icon: string; items: MetaItem[] }

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────
const META_GROUPS: MetaGroup[] = [
  {
    id: "objects", label: "Objects & Fields", icon: "cube",
    items: [
      {
        id: "custom-objects", label: "Custom Objects", icon: "cube",
        groupId: "objects", groupLabel: "Objects & Fields",
        sfMetadataType: "CustomObject",
        desc: "Design, manage, and deploy custom Salesforce objects with AI-assisted field mapping and relationship configuration.",
        stats: [{ label: "Total", value: "47" }, { label: "Deployed", value: "44" }, { label: "Draft", value: "3" }, { label: "Fields", value: "312" }],
        actions: [
          { id: "create-obj", title: "Create Object", desc: "Design a new custom object with AI-suggested schema and field types", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "manage-fields", title: "Manage Fields", desc: "Add, edit, reorder, or bulk-import custom fields across objects", icon: "columns", accent: "#3AABFF" },
          { id: "relationships", title: "Relationships", desc: "Configure lookup, master-detail, and junction object relationships", icon: "link", accent: "#00D4FF" },
          { id: "page-layouts", title: "Page Layouts", desc: "Drag-and-drop layout builder for record detail pages", icon: "layout", accent: "#1E90FF" },
          { id: "record-types", title: "Record Types", desc: "Segment record behavior and picklist values by business process", icon: "tag", accent: "#3AABFF" },
          { id: "validation", title: "Validation Rules", desc: "AI-generated validation logic from plain English descriptions", icon: "check-shield", accent: "#00D4FF", badge: "AI" },
          { id: "triggers", title: "Apex Triggers", desc: "Generate trigger scaffolding with AI handler pattern and best practices", icon: "bolt", accent: "#60B8FF", badge: "AI" },
          { id: "permissions", title: "Object Permissions", desc: "Configure FLS and CRUD across all profiles and permission sets at once", icon: "lock", accent: "#3AABFF" },
          { id: "deploy", title: "Deploy to Org", desc: "Package and deploy this object's full metadata to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "custom-fields", label: "Custom Fields", icon: "columns",
        groupId: "objects", groupLabel: "Objects & Fields",
        sfMetadataType: "CustomField",
        desc: "Create and manage custom fields across all objects with type validation, formula assistance, and dependency mapping.",
        stats: [{ label: "Total", value: "312" }, { label: "Text", value: "104" }, { label: "Picklist", value: "67" }, { label: "Formula", value: "51" }],
        actions: [
          { id: "add-field", title: "Add Field", desc: "Create a new custom field with type selection and inline validation", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "bulk-create", title: "Bulk Create", desc: "Import multiple fields from CSV or describe them in plain language", icon: "upload", accent: "#3AABFF", badge: "AI" },
          { id: "field-deps", title: "Field Dependencies", desc: "Map controlling fields and dependent picklist value sets", icon: "branch", accent: "#00D4FF" },
          { id: "fls-config", title: "Field Security", desc: "Set field-level security across all profiles simultaneously", icon: "lock", accent: "#3AABFF" },
          { id: "history", title: "History Tracking", desc: "Enable or disable field history tracking across multiple fields at once", icon: "clock", accent: "#60B8FF" },
          { id: "formula-builder", title: "Formula Builder", desc: "AI-assisted formula writing with syntax validation and suggestions", icon: "wand", accent: "#00D4FF", badge: "AI" },
        ],
      },
      {
        id: "record-types", label: "Record Types", icon: "tag",
        groupId: "objects", groupLabel: "Objects & Fields",
        desc: "Segment record behavior and picklist values by business process and user profile assignment.",
        stats: [{ label: "Types", value: "28" }, { label: "Objects", value: "14" }, { label: "Profiles", value: "6" }, { label: "Layouts", value: "18" }],
        actions: [
          { id: "create-rt", title: "Create Record Type", desc: "Define new business process segmentation for an object", icon: "plus", accent: "#1E90FF" },
          { id: "assign-profiles", title: "Assign to Profiles", desc: "Bulk-assign record types to profiles and permission sets", icon: "users", accent: "#3AABFF" },
          { id: "picklist-values", title: "Picklist Values", desc: "Configure which picklist values are available per record type", icon: "list", accent: "#00D4FF" },
          { id: "default-layout", title: "Default Layout", desc: "Set the default page layout per record type and profile combo", icon: "layout", accent: "#00D4FF" },
        ],
      },
    ],
  },
  {
    id: "automation", label: "Logic & Automation", icon: "bolt",
    items: [
      {
        id: "flows", label: "Flows", icon: "flow",
        groupId: "automation", groupLabel: "Logic & Automation",
        sfMetadataType: "FlowDefinition",
        desc: "Build and manage Salesforce Flows with AI-assisted logic generation, visual debugging, and version control.",
        stats: [{ label: "Total", value: "23" }, { label: "Active", value: "18" }, { label: "Inactive", value: "5" }, { label: "Errors 7d", value: "2" }],
        actions: [
          { id: "create-flow", title: "Create Flow", desc: "Generate a new flow from plain English description of your business process", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "activate", title: "Activate / Deactivate", desc: "Toggle flow status with automatic version tracking and rollback", icon: "toggle", accent: "#00D4FF" },
          { id: "debug", title: "Debug Flow", desc: "Step-by-step execution trace, fault log viewer, and variable inspector", icon: "bug", accent: "#60B8FF" },
          { id: "version", title: "Version History", desc: "Compare, restore, and annotate previous flow versions side-by-side", icon: "git-branch", accent: "#3AABFF" },
          { id: "clone-flow", title: "Clone Flow", desc: "Duplicate flow to a new object or sandbox environment", icon: "copy", accent: "#00D4FF" },
          { id: "deploy-flow", title: "Deploy", desc: "Package active flow version for deployment to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "validation-rules", label: "Validation Rules", icon: "check-shield",
        groupId: "automation", groupLabel: "Logic & Automation",
        sfMetadataType: "ValidationRule",
        desc: "AI-powered validation rule creation from natural language — generates error conditions and messages automatically.",
        stats: [{ label: "Rules", value: "56" }, { label: "Active", value: "49" }, { label: "Objects", value: "14" }, { label: "Fired 7d", value: "1.2k" }],
        actions: [
          { id: "create-vr", title: "Create Rule", desc: "Describe in plain English — AI writes the ISBLANK formula and error message", icon: "plus", accent: "#00D4FF", badge: "AI" },
          { id: "test-rule", title: "Test Rule", desc: "Run validation against sample data without deploying to production", icon: "play", accent: "#1E90FF" },
          { id: "bulk-toggle", title: "Bulk Enable / Disable", desc: "Toggle multiple rules at once for data migration windows", icon: "toggle", accent: "#60B8FF" },
          { id: "rule-analytics", title: "Rule Analytics", desc: "See which rules fire most often and which cause the most user friction", icon: "bar-chart", accent: "#3AABFF" },
        ],
      },
      {
        id: "apex-classes", label: "Apex Classes", icon: "code",
        groupId: "automation", groupLabel: "Logic & Automation",
        sfMetadataType: "ApexClass",
        desc: "Manage Apex classes with AI-assisted code generation, test coverage analysis, and deployment workflows.",
        stats: [{ label: "Classes", value: "89" }, { label: "Coverage", value: "78%" }, { label: "Test Classes", value: "31" }, { label: "Errors", value: "0" }],
        actions: [
          { id: "generate-class", title: "Generate Class", desc: "AI writes Apex class, interface, or service from natural language spec", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "run-tests", title: "Run Tests", desc: "Execute test classes and view interactive coverage report", icon: "play", accent: "#00D4FF" },
          { id: "coverage", title: "Coverage Map", desc: "Visual code coverage heatmap by class and method", icon: "pie-chart", accent: "#3AABFF" },
          { id: "compile", title: "Compile All", desc: "Force compile all Apex classes and surface compilation errors", icon: "compile", accent: "#60B8FF" },
          { id: "deploy-apex", title: "Deploy", desc: "Deploy selected Apex classes to target org", icon: "rocket", accent: "#00D4FF" },
          { id: "refactor", title: "AI Refactor", desc: "AI suggests and applies performance improvements and pattern upgrades", icon: "wand", accent: "#3AABFF", badge: "AI" },
        ],
      },
      {
        id: "apex-triggers", label: "Apex Triggers", icon: "bolt",
        groupId: "automation", groupLabel: "Logic & Automation",
        sfMetadataType: "ApexTrigger",
        desc: "Create, manage, and deploy Apex triggers with AI-generated handler patterns and best-practices enforcement.",
        stats: [{ label: "Triggers", value: "17" }, { label: "Active", value: "17" }, { label: "Objects", value: "11" }, { label: "Avg 50ms", value: "28ms" }],
        actions: [
          { id: "create-trigger", title: "Generate Trigger", desc: "AI generates trigger with TriggerHandler pattern, bulkification, and tests", icon: "plus", accent: "#60B8FF", badge: "AI" },
          { id: "trigger-tests", title: "Test Coverage", desc: "Run trigger test classes and view line-by-line coverage", icon: "play", accent: "#00D4FF" },
          { id: "disable-trigger", title: "Disable / Re-enable", desc: "Safely toggle triggers for data migration windows", icon: "toggle", accent: "#E84444" },
          { id: "deploy-trigger", title: "Deploy", desc: "Deploy triggers with their dependent handler classes", icon: "rocket", accent: "#00D4FF" },
        ],
      },
    ],
  },
  {
    id: "components", label: "UI & Components", icon: "layout",
    items: [
      {
        id: "lwc", label: "Lightning Web Components", icon: "bolt",
        groupId: "components", groupLabel: "UI & Components",
        sfMetadataType: "LightningComponentBundle",
        desc: "Design, preview, and deploy Lightning Web Components with AI code generation and live metadata sync.",
        stats: [{ label: "Components", value: "34" }, { label: "Deployed", value: "29" }, { label: "In Dev", value: "5" }, { label: "App Builder", value: "22" }],
        actions: [
          { id: "generate-lwc", title: "Generate Component", desc: "Describe UI in plain English — AI scaffolds the full LWC bundle", icon: "plus", accent: "#00D4FF", badge: "AI" },
          { id: "preview-lwc", title: "Preview", desc: "Render component in isolated preview environment before deployment", icon: "eye", accent: "#1E90FF" },
          { id: "update-meta", title: "Update Metadata", desc: "Edit targets, visibility, and exposedAttributes configuration", icon: "edit", accent: "#3AABFF" },
          { id: "deploy-lwc", title: "Deploy", desc: "Push full component bundle to org with automatic metadata sync", icon: "rocket", accent: "#00D4FF" },
          { id: "add-to-app", title: "Add to App Builder", desc: "Configure component for Lightning App Builder or Record Pages", icon: "grid", accent: "#00D4FF" },
        ],
      },
      {
        id: "aura", label: "Aura Components", icon: "aura",
        groupId: "components", groupLabel: "UI & Components",
        desc: "Legacy Aura component management with AI-assisted migration path to modern Lightning Web Components.",
        stats: [{ label: "Components", value: "12" }, { label: "Active", value: "12" }, { label: "LWC Ready", value: "8" }, { label: "Deprecated", value: "0" }],
        actions: [
          { id: "migrate-lwc", title: "Migrate to LWC", desc: "AI-assisted one-click conversion from Aura markup to LWC bundle", icon: "arrow-right", accent: "#00D4FF", badge: "AI" },
          { id: "edit-aura", title: "Edit Component", desc: "Modify controller, helper, renderer, and markup files", icon: "edit", accent: "#3AABFF" },
          { id: "deploy-aura", title: "Deploy", desc: "Deploy Aura bundle and all dependencies to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "page-layouts", label: "Page Layouts", icon: "layout",
        groupId: "components", groupLabel: "UI & Components",
        desc: "Manage record page layouts with drag-and-drop editor and AI-suggested field placement optimization.",
        stats: [{ label: "Layouts", value: "38" }, { label: "Objects", value: "14" }, { label: "Sections", value: "142" }, { label: "Actions", value: "67" }],
        actions: [
          { id: "edit-layout", title: "Open Editor", desc: "Visual drag-and-drop page layout editor with live preview", icon: "edit", accent: "#1E90FF" },
          { id: "ai-suggest", title: "AI Optimize", desc: "AI suggests optimal field placement and section grouping", icon: "wand", accent: "#3AABFF", badge: "AI" },
          { id: "clone-layout", title: "Clone Layout", desc: "Duplicate layout to another object or record type as baseline", icon: "copy", accent: "#00D4FF" },
          { id: "assign-profiles", title: "Assign to Profiles", desc: "Configure layout assignments per profile and record type combination", icon: "users", accent: "#00D4FF" },
          { id: "deploy-layout", title: "Deploy", desc: "Deploy page layouts to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
    ],
  },
  {
    id: "security", label: "Security & Access", icon: "lock",
    items: [
      {
        id: "permission-sets", label: "Permission Sets", icon: "shield",
        groupId: "security", groupLabel: "Security & Access",
        sfMetadataType: "PermissionSet",
        desc: "Create and manage permission sets with AI-assisted permission analysis and least-privilege recommendations.",
        stats: [{ label: "Sets", value: "22" }, { label: "Assigned", value: "156" }, { label: "Groups", value: "4" }, { label: "Objects", value: "31" }],
        actions: [
          { id: "create-pset", title: "Create Permission Set", desc: "Generate least-privilege permission set from role description using AI", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "assign-users", title: "Assign Users", desc: "Bulk assign permission sets to users or permission set groups", icon: "users", accent: "#3AABFF" },
          { id: "compare", title: "Compare Sets", desc: "Side-by-side permission diff between two permission sets", icon: "git-branch", accent: "#00D4FF" },
          { id: "audit", title: "Security Audit", desc: "AI identifies over-permissioned users and suggests remediation", icon: "search", accent: "#60B8FF", badge: "AI" },
          { id: "deploy-pset", title: "Deploy", desc: "Deploy permission sets and groups to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "profiles", label: "Profiles", icon: "user-check",
        groupId: "security", groupLabel: "Security & Access",
        desc: "Manage profile permissions, FLS, and layout assignments across your org with visual permission matrices.",
        stats: [{ label: "Profiles", value: "8" }, { label: "Users", value: "247" }, { label: "Custom", value: "5" }, { label: "Standard", value: "3" }],
        actions: [
          { id: "edit-profile", title: "Edit Profile", desc: "Modify object, field, and system permissions visually", icon: "edit", accent: "#1E90FF" },
          { id: "clone-profile", title: "Clone Profile", desc: "Duplicate profile as a starting point for a new role", icon: "copy", accent: "#3AABFF" },
          { id: "fls-matrix", title: "FLS Matrix", desc: "Visual field-level security matrix across all objects and profiles", icon: "table", accent: "#00D4FF" },
          { id: "profile-audit", title: "Access Audit", desc: "AI flags risky permissions and deviations from Salesforce best practices", icon: "alert", accent: "#60B8FF", badge: "AI" },
        ],
      },
    ],
  },
  {
    id: "integration", label: "Integration", icon: "plug",
    items: [
      {
        id: "named-credentials", label: "Named Credentials", icon: "key",
        groupId: "integration", groupLabel: "Integration",
        desc: "Manage external endpoint credentials for Apex callouts and flows with secure OAuth and basic auth configuration.",
        stats: [{ label: "Credentials", value: "7" }, { label: "Auth Providers", value: "3" }, { label: "Active", value: "7" }, { label: "Endpoints", value: "4" }],
        actions: [
          { id: "create-nc", title: "Create Credential", desc: "Configure new named credential with OAuth 2.0 or basic auth flow", icon: "plus", accent: "#1E90FF" },
          { id: "test-endpoint", title: "Test Endpoint", desc: "Validate endpoint connectivity and authentication flow", icon: "play", accent: "#00D4FF" },
          { id: "rotate-secret", title: "Rotate Secret", desc: "Update credential secrets safely without breaking existing callouts", icon: "refresh", accent: "#60B8FF" },
          { id: "deploy-nc", title: "Deploy", desc: "Deploy named credentials to target org (secrets excluded)", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "custom-metadata", label: "Custom Metadata Types", icon: "database",
        groupId: "integration", groupLabel: "Integration",
        desc: "Design and populate custom metadata types for deployable configuration data across environments.",
        stats: [{ label: "Types", value: "11" }, { label: "Records", value: "94" }, { label: "Fields", value: "47" }, { label: "Deployed", value: "11" }],
        actions: [
          { id: "create-cmt", title: "Create Type", desc: "Define new custom metadata type with custom fields", icon: "plus", accent: "#1E90FF" },
          { id: "add-records", title: "Manage Records", desc: "Add, edit, and organize custom metadata records", icon: "table", accent: "#3AABFF" },
          { id: "import-csv", title: "Import from CSV", desc: "Bulk import metadata records from a spreadsheet", icon: "upload", accent: "#00D4FF" },
          { id: "deploy-cmt", title: "Deploy", desc: "Deploy type definition and all records to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "remote-sites", label: "Remote Site Settings", icon: "globe",
        groupId: "integration", groupLabel: "Integration",
        desc: "Manage allowed external endpoints for Apex HTTP callouts and Visualforce remote actions.",
        stats: [{ label: "Sites", value: "9" }, { label: "Active", value: "9" }, { label: "HTTPS Only", value: "9" }, { label: "Disabled", value: "0" }],
        actions: [
          { id: "add-site", title: "Add Site", desc: "Register new external endpoint URL for Apex callouts", icon: "plus", accent: "#1E90FF" },
          { id: "bulk-enable", title: "Bulk Enable / Disable", desc: "Toggle multiple remote sites simultaneously", icon: "toggle", accent: "#60B8FF" },
          { id: "deploy-sites", title: "Deploy", desc: "Deploy remote site settings configuration to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
    ],
  },
  {
    id: "analytics", label: "Reports & Dashboards", icon: "bar-chart",
    items: [
      {
        id: "reports", label: "Reports", icon: "file-text",
        groupId: "analytics", groupLabel: "Reports & Dashboards",
        sfMetadataType: "Report",
        desc: "Create, manage, and deploy Salesforce reports with AI-suggested filters, groupings, and formula fields.",
        stats: [{ label: "Reports", value: "114" }, { label: "Folders", value: "12" }, { label: "Scheduled", value: "8" }, { label: "Subscribed", value: "23" }],
        actions: [
          { id: "create-report", title: "Create Report", desc: "AI builds a complete report from natural language description", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "schedule", title: "Schedule Report", desc: "Set automated report delivery via email on a recurring schedule", icon: "clock", accent: "#3AABFF" },
          { id: "export", title: "Export Data", desc: "Export report results as CSV, Excel, or JSON format", icon: "download", accent: "#00D4FF" },
          { id: "deploy-report", title: "Deploy", desc: "Deploy report metadata to another org or folder", icon: "rocket", accent: "#00D4FF" },
        ],
      },
      {
        id: "dashboards", label: "Dashboards", icon: "bar-chart-2",
        groupId: "analytics", groupLabel: "Reports & Dashboards",
        sfMetadataType: "Dashboard",
        desc: "Build and manage Salesforce dashboards with AI-assisted chart selection and executive data storytelling.",
        stats: [{ label: "Dashboards", value: "31" }, { label: "Components", value: "186" }, { label: "Dynamic", value: "14" }, { label: "Subscribed", value: "47" }],
        actions: [
          { id: "create-dash", title: "Create Dashboard", desc: "AI designs a full dashboard layout from your stated business goals", icon: "plus", accent: "#1E90FF", badge: "AI" },
          { id: "dynamic-dash", title: "Dynamic Filters", desc: "Configure running user and dynamic dashboard filter settings", icon: "filter", accent: "#3AABFF" },
          { id: "share-dash", title: "Share & Subscribe", desc: "Manage dashboard sharing rules and email subscription schedules", icon: "share", accent: "#00D4FF" },
          { id: "deploy-dash", title: "Deploy", desc: "Deploy dashboard and all component reports to target org", icon: "rocket", accent: "#00D4FF" },
        ],
      },
    ],
  },
];

// Flatten for search
const ALL_ITEMS: MetaItem[] = META_GROUPS.flatMap(g => g.items);

const RECENT: { type: string; item: string; meta: string; time: string; color: string }[] = [
  { type: "Created", item: "Product__c", meta: "Custom Object", time: "2 min ago", color: "#1E90FF" },
  { type: "Deployed", item: "BundleItemTrigger", meta: "Apex Trigger", time: "14 min ago", color: "#3AABFF" },
  { type: "Generated", item: "Qty must be positive", meta: "Validation Rule", time: "1 hr ago", color: "#60B8FF" },
  { type: "Modified", item: "ProductController.cls", meta: "Apex Class", time: "3 hr ago", color: "#0070D6" },
  { type: "Deployed", item: "productCard LWC", meta: "LWC Component", time: "Yesterday", color: "#00D4FF" },
];

// ─────────────────────────────────────────────────────────────────────────────
// NAV BAR
// ─────────────────────────────────────────────────────────────────────────────
function NavBar({ session, isDark, onSignOut }: { session: SessionData; isDark: boolean; onSignOut: () => void }) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const isProduction = session.environment === "production";
  const name = session.displayName?.split(" ")[0] ?? session.username?.split("@")[0] ?? "User";

  return (
    <div
      className="flex items-center justify-between px-4 h-14 shrink-0 z-20"
      style={{
        background: isDark ? "rgba(1,9,24,0.85)" : "rgba(228,238,255,0.94)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderBottom: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.18)",
      }}
    >
      {/* Left: back + branding */}
      <div className="flex items-center gap-3">
        <motion.button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer"
          style={{
            color: isDark ? "rgba(90,122,154,0.8)" : "rgba(0,31,91,0.76)",
            background: "transparent",
            border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.20)",
          }}
          whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.10)" }}
          whileTap={{ scale: 0.96 }}
        >
          <Ic n="chevron-left" s={12} />
          Home
        </motion.button>

        <div className="h-4 w-px" style={{ background: isDark ? "rgba(30,144,255,0.12)" : "rgba(0,71,171,0.20)" }} />

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
              Metadata Omnion
            </span>
            <span className="text-[10px] ml-2 font-mono" style={{ color: "rgba(30,144,255,0.55)" }}>OMNI-META</span>
          </div>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        <div
          className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium"
          style={{
            background: isProduction ? "rgba(0,200,117,0.10)" : "rgba(30,144,255,0.10)",
            border: `1px solid ${isProduction ? "rgba(0,200,117,0.22)" : "rgba(30,144,255,0.22)"}`,
            color: isProduction ? "#00C875" : "#3AABFF",
          }}
        >
          <motion.span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: isProduction ? "#00C875" : "#3AABFF" }}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          {isProduction ? "Production" : "Sandbox"}
        </div>

        <motion.button
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.7)" : "rgba(0,31,91,0.70)", border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.20)" }}
          whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.10)" }}
          whileTap={{ scale: 0.93 }}
        >
          <Ic n={isDark ? "sun" : "moon"} s={13} />
        </motion.button>

        <div className="hidden sm:flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "linear-gradient(135deg, #1E90FF, #00D4FF)", color: "white" }}>
            {name.charAt(0).toUpperCase()}
          </div>
          <span className="text-[11px]" style={{ color: isDark ? "rgba(140,170,200,0.7)" : "rgba(0,15,55,0.82)" }}>{name}</span>
        </div>

        <motion.button
          onClick={onSignOut}
          className="text-[10px] font-medium px-2.5 py-1.5 rounded-lg cursor-pointer flex items-center gap-1"
          style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(0,31,91,0.66)", border: isDark ? "1px solid rgba(30,144,255,0.09)" : "1px solid rgba(0,71,171,0.18)", background: "transparent" }}
          whileHover={{ background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.09)" }}
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
function Sidebar({
  isDark,
  selectedId,
  onSelect,
  collapsed,
  onToggle,
}: {
  isDark: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [search, setSearch] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    Object.fromEntries(META_GROUPS.map(g => [g.id, true]))
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return ALL_ITEMS.filter(i => i.label.toLowerCase().includes(q) || i.groupLabel.toLowerCase().includes(q));
  }, [search]);

  const toggleGroup = (id: string) => setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }));

  const borderColor = isDark ? "rgba(30,144,255,0.1)" : "rgba(0,71,171,0.18)";

  return (
    <motion.div
      animate={{ width: collapsed ? 52 : 248 }}
      transition={{ type: "spring", stiffness: 340, damping: 34 }}
      className="shrink-0 flex flex-col h-full overflow-hidden relative"
      style={{
        background: isDark ? "rgba(0,5,14,0.7)" : "rgba(222,234,255,0.92)",
        borderRight: `1px solid ${borderColor}`,
      }}
    >
      {/* Collapse toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 shrink-0" style={{ borderBottom: `1px solid ${borderColor}` }}>
        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="text-[10px] font-medium tracking-widest uppercase"
              style={{ color: isDark ? "rgba(30,144,255,0.45)" : "rgba(0,71,171,0.66)" }}
            >
              Metadata
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button
          onClick={onToggle}
          className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer"
          style={{ color: isDark ? "rgba(90,122,154,0.6)" : "rgba(0,31,91,0.62)", marginLeft: collapsed ? "auto" : 0 }}
          whileHover={{ background: isDark ? "rgba(30,144,255,0.08)" : "rgba(0,71,171,0.12)" }}
          whileTap={{ scale: 0.9 }}
        >
          <Ic n="panel-left" s={14} />
        </motion.button>
      </div>

      {/* Search */}
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="px-3 py-2 shrink-0"
            style={{ borderBottom: `1px solid ${borderColor}` }}
          >
            <div
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
              style={{
                background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.09)",
                border: isDark ? "1px solid rgba(30,144,255,0.12)" : "1px solid rgba(0,71,171,0.20)",
              }}
            >
              <span style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.58)" }}><Ic n="search" s={12} /></span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search metadata…"
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
          {!collapsed && (
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {/* Search results */}
              {filtered ? (
                <div className="py-2 px-2">
                  {filtered.length === 0 ? (
                    <p className="text-[11px] px-2 py-3" style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.58)" }}>No results</p>
                  ) : (
                    filtered.map(item => <SidebarItem key={item.id} item={item} isDark={isDark} selected={selectedId === item.id} onSelect={onSelect} showGroup />)
                  )}
                </div>
              ) : (
                META_GROUPS.map(group => (
                  <div key={group.id} className="py-1">
                    {/* Group header */}
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer"
                      style={{ color: isDark ? "rgba(90,122,154,0.55)" : "rgba(0,31,91,0.62)" }}
                    >
                      <Ic n={group.icon} s={12} />
                      <span className="flex-1 text-[10px] font-semibold tracking-wide uppercase">{group.label}</span>
                      <motion.span animate={{ rotate: openGroups[group.id] ? 0 : -90 }} transition={{ duration: 0.2 }}>
                        <Ic n="chevron-down" s={11} />
                      </motion.span>
                    </button>
                    <AnimatePresence initial={false}>
                      {openGroups[group.id] && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: "easeInOut" }}
                          className="overflow-hidden px-2"
                        >
                          {group.items.map(item => (
                            <SidebarItem key={item.id} item={item} isDark={isDark} selected={selectedId === item.id} onSelect={onSelect} />
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))
              )}
            </motion.div>
          )}

          {/* Collapsed: icon rail */}
          {collapsed && (
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="py-2 flex flex-col items-center gap-1"
            >
              {ALL_ITEMS.map(item => (
                <motion.button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  title={item.label}
                  className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer"
                  style={{
                    background: selectedId === item.id ? "rgba(30,144,255,0.14)" : "transparent",
                    color: selectedId === item.id ? "#1E90FF" : isDark ? "rgba(90,122,154,0.55)" : "rgba(0,31,91,0.62)",
                    border: selectedId === item.id ? "1px solid rgba(30,144,255,0.25)" : "1px solid transparent",
                  }}
                  whileHover={{ background: "rgba(30,144,255,0.08)" }}
                  whileTap={{ scale: 0.9 }}
                >
                  <Ic n={item.icon} s={14} />
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function SidebarItem({ item, isDark, selected, onSelect, showGroup = false }: {
  item: MetaItem; isDark: boolean; selected: boolean; onSelect: (id: string) => void; showGroup?: boolean;
}) {
  return (
    <motion.button
      onClick={() => onSelect(item.id)}
      className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 cursor-pointer relative"
      style={{
        background: selected
          ? isDark ? "rgba(30,144,255,0.1)" : "rgba(30,144,255,0.08)"
          : "transparent",
        color: selected
          ? "#1E90FF"
          : isDark ? "rgba(140,170,210,0.7)" : "rgba(0,15,55,0.82)",
        borderLeft: selected ? "2px solid #1E90FF" : "2px solid transparent",
      }}
      whileHover={{
        background: selected
          ? isDark ? "rgba(30,144,255,0.12)" : "rgba(30,144,255,0.1)"
          : isDark ? "rgba(30,144,255,0.05)" : "rgba(0,71,171,0.09)",
      }}
      whileTap={{ scale: 0.98 }}
    >
      <span style={{ opacity: selected ? 1 : 0.6 }}><Ic n={item.icon} s={13} /></span>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-medium block truncate">{item.label}</span>
        {showGroup && <span className="text-[10px] block" style={{ color: isDark ? "rgba(90,122,154,0.5)" : "rgba(0,31,91,0.58)" }}>{item.groupLabel}</span>}
      </div>
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION CARD
// ─────────────────────────────────────────────────────────────────────────────
function ActionCard({ action, isDark, index }: { action: ActionDef; isDark: boolean; index: number }) {
  const [hov, setHov] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="relative rounded-xl p-4 cursor-pointer flex flex-col gap-3 overflow-hidden"
      style={{
        background: isDark
          ? hov ? `rgba(${hexToRgb(action.accent)},0.08)` : "rgba(8,16,32,0.6)"
          : hov ? `rgba(${hexToRgb(action.accent)},0.05)` : "rgba(225,238,255,0.90)",
        border: hov
          ? `1px solid rgba(${hexToRgb(action.accent)},0.35)`
          : isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.16)",
        boxShadow: hov ? `0 8px 32px rgba(${hexToRgb(action.accent)},0.15)` : "none",
        transition: "background 0.25s, border 0.25s, box-shadow 0.25s",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {/* Top glow line on hover */}
      <AnimatePresence>
        {hov && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute top-0 left-4 right-4 h-px pointer-events-none"
            style={{ background: `linear-gradient(90deg, transparent, ${action.accent}60, transparent)` }}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: `rgba(${hexToRgb(action.accent)},0.15)`,
            color: action.accent,
            border: `1px solid rgba(${hexToRgb(action.accent)},0.25)`,
            boxShadow: hov ? `0 0 12px rgba(${hexToRgb(action.accent)},0.25)` : "none",
            transition: "box-shadow 0.25s",
          }}
        >
          <Ic n={action.icon} s={15} />
        </div>

        {action.badge && (
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded-full tracking-wide"
            style={{ background: `rgba(${hexToRgb(action.accent)},0.15)`, color: action.accent, border: `1px solid rgba(${hexToRgb(action.accent)},0.3)` }}
          >
            {action.badge}
          </span>
        )}
      </div>

      {/* Text */}
      <div className="flex-1">
        <p className="text-[13px] font-semibold mb-1" style={{ color: isDark ? "rgba(210,230,250,0.9)" : "rgba(0,15,45,0.88)", letterSpacing: "-0.01em" }}>
          {action.title}
        </p>
        <p className="text-[11px] leading-relaxed" style={{ color: isDark ? "rgba(100,130,170,0.65)" : "rgba(0,15,55,0.74)" }}>
          {action.desc}
        </p>
      </div>

      {/* Footer arrow */}
      <div className="flex items-center justify-end">
        <motion.span
          animate={{ x: hov ? 3 : 0, opacity: hov ? 1 : 0.4 }}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          style={{ color: action.accent }}
        >
          <Ic n="arrow-right" s={14} />
        </motion.span>
      </div>
    </motion.div>
  );
}

// Utility: hex to rgb for rgba() usage
function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "30,144,255";
  return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE PANEL
// ─────────────────────────────────────────────────────────────────────────────
type LiveRecord = { Id: string; Name?: string; MasterLabel?: string; ValidationName?: string; Label?: string; Title?: string; [key: string]: unknown };

function getRecordLabel(rec: LiveRecord): string {
  return (rec.Name ?? rec.MasterLabel ?? rec.ValidationName ?? rec.Label ?? rec.Title ?? rec.Id ?? "—") as string;
}

function WorkspacePanel({ item, isDark }: { item: MetaItem; isDark: boolean }) {
  const [liveRecords, setLiveRecords] = useState<LiveRecord[] | null>(null);
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!item.sfMetadataType) {
      setLiveRecords(null);
      setLiveTotal(null);
      setFetchError(null);
      return;
    }
    setFetching(true);
    setFetchError(null);
    setLiveRecords(null);
    fetch(`/api/sf/metadata?type=${item.sfMetadataType}&limit=10`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setFetchError(data.error); }
        else { setLiveRecords(data.records ?? []); setLiveTotal(data.total ?? 0); }
      })
      .catch(() => setFetchError("Network error"))
      .finally(() => setFetching(false));
  }, [item.id, item.sfMetadataType]);

  const displayStats = useMemo(() => {
    if (liveTotal === null) return item.stats;
    return item.stats.map((s, i) => i === 0 ? { ...s, value: String(liveTotal) } : s);
  }, [item.stats, liveTotal]);

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={item.id}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="flex flex-col h-full"
      >
        {/* Workspace header */}
        <div
          className="px-6 py-5 shrink-0"
          style={{ borderBottom: isDark ? "1px solid rgba(30,144,255,0.08)" : "1px solid rgba(0,71,171,0.14)" }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: "linear-gradient(135deg, rgba(30,144,255,0.18) 0%, rgba(0,212,255,0.14) 100%)",
                border: "1px solid rgba(30,144,255,0.2)",
                color: "#1E90FF",
              }}
            >
              <Ic n={item.icon} s={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[18px] font-bold leading-tight" style={{ color: isDark ? "white" : "#001F5B", letterSpacing: "-0.025em" }}>
                  {item.label}
                </h2>
                <span
                  className="text-[9px] font-mono px-2 py-0.5 rounded-md"
                  style={{
                    background: "rgba(30,144,255,0.1)",
                    border: "1px solid rgba(30,144,255,0.2)",
                    color: "rgba(30,144,255,0.8)",
                  }}
                >
                  {item.groupLabel.toUpperCase()}
                </span>
              </div>
              <p className="text-[12px] mt-1 leading-relaxed" style={{ color: isDark ? "rgba(100,130,170,0.7)" : "rgba(0,15,55,0.74)" }}>
                {item.desc}
              </p>
            </div>
          </div>

          {/* Stats row */}
          <div className="flex gap-4 mt-4 flex-wrap">
            {displayStats.map(stat => (
              <div
                key={stat.label}
                className="flex flex-col px-3 py-2 rounded-lg"
                style={{
                  background: isDark ? "rgba(30,144,255,0.06)" : "rgba(0,71,171,0.09)",
                  border: isDark ? "1px solid rgba(30,144,255,0.1)" : "1px solid rgba(0,71,171,0.16)",
                  minWidth: 64,
                }}
              >
                <span className="text-[18px] font-bold leading-none" style={{ color: isDark ? "#3AABFF" : "#0047AB", letterSpacing: "-0.03em" }}>{stat.value}</span>
                <span className="text-[10px] mt-1" style={{ color: isDark ? "rgba(90,120,160,0.6)" : "rgba(0,15,55,0.70)" }}>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5" style={{ scrollbarWidth: "thin" }}>
          {/* Action cards */}
          <div className="mb-2">
            <p className="text-[10px] font-semibold tracking-widest uppercase mb-4" style={{ color: isDark ? "rgba(30,144,255,0.5)" : "rgba(0,71,171,0.66)" }}>
              Actions
            </p>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {item.actions.map((action, i) => (
                <ActionCard key={action.id} action={action} isDark={isDark} index={i} />
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="my-6 h-px" style={{ background: isDark ? "rgba(30,144,255,0.07)" : "rgba(0,71,171,0.12)" }} />

          {/* Live metadata or fallback activity */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <p className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: isDark ? "rgba(30,144,255,0.5)" : "rgba(0,71,171,0.66)" }}>
                {item.sfMetadataType ? "Live from Salesforce" : "Recent Activity"}
              </p>
              {fetching && (
                <motion.span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(30,144,255,0.1)", border: "1px solid rgba(30,144,255,0.2)", color: "rgba(30,144,255,0.7)" }}
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                >
                  FETCHING…
                </motion.span>
              )}
              {!fetching && liveTotal !== null && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.20)", color: "#00D4FF" }}>
                  {liveTotal} total
                </span>
              )}
            </div>

            {item.sfMetadataType ? (
              fetchError ? (
                <div className="px-3 py-3 rounded-lg text-[11px]" style={{ background: "rgba(232,68,68,0.07)", border: "1px solid rgba(232,68,68,0.18)", color: "rgba(232,68,68,0.75)" }}>
                  {fetchError}
                </div>
              ) : fetching ? (
                <div className="flex flex-col gap-1">
                  {[...Array(5)].map((_, i) => (
                    <motion.div key={i} className="h-9 rounded-lg" style={{ background: isDark ? "rgba(30,144,255,0.04)" : "rgba(0,71,171,0.08)", border: isDark ? "1px solid rgba(30,144,255,0.06)" : "1px solid rgba(0,71,171,0.10)" }} animate={{ opacity: [0.4, 0.7, 0.4] }} transition={{ duration: 1.4, delay: i * 0.1, repeat: Infinity }} />
                  ))}
                </div>
              ) : liveRecords && liveRecords.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {liveRecords.map((rec, i) => (
                    <motion.div
                      key={rec.Id as string ?? i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 * i }}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                      style={{ background: isDark ? "rgba(8,16,32,0.4)" : "rgba(222,235,255,0.85)", border: isDark ? "1px solid rgba(30,144,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}
                    >
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "#1E90FF", boxShadow: "0 0 5px rgba(30,144,255,0.5)" }} />
                      <span className="text-[12px] font-mono font-medium flex-1 truncate" style={{ color: isDark ? "rgba(180,210,240,0.9)" : "rgba(0,15,45,0.85)" }}>
                        {getRecordLabel(rec)}
                      </span>
                      <span className="text-[9px] font-mono truncate max-w-[120px]" style={{ color: isDark ? "rgba(90,120,160,0.45)" : "rgba(0,31,91,0.56)" }}>
                        {rec.Id as string}
                      </span>
                    </motion.div>
                  ))}
                </div>
              ) : liveRecords && liveRecords.length === 0 ? (
                <p className="text-[12px] px-3 py-4" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.58)" }}>No records found in this org.</p>
              ) : null
            ) : (
              <div className="flex flex-col gap-1">
                {RECENT.map((r, i) => (
                  <motion.div
                    key={r.item + i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 + i * 0.04 }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                    style={{ background: isDark ? "rgba(8,16,32,0.4)" : "rgba(222,235,255,0.85)", border: isDark ? "1px solid rgba(30,144,255,0.07)" : "1px solid rgba(0,71,171,0.12)" }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.color, boxShadow: `0 0 5px ${r.color}80` }} />
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: `${r.color}18`, color: r.color, minWidth: 52, textAlign: "center" }}>
                      {r.type}
                    </span>
                    <span className="text-[12px] font-mono font-medium flex-1" style={{ color: isDark ? "rgba(180,210,240,0.85)" : "rgba(0,15,45,0.8)" }}>
                      {r.item}
                    </span>
                    <span className="text-[10px]" style={{ color: isDark ? "rgba(90,120,160,0.5)" : "rgba(0,31,91,0.58)" }}>{r.meta}</span>
                    <span className="text-[10px]" style={{ color: isDark ? "rgba(90,120,160,0.4)" : "rgba(0,31,91,0.55)" }}>{r.time}</span>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AMBIENT GRID
// ─────────────────────────────────────────────────────────────────────────────
function GridBg({ isDark }: { isDark: boolean }) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(${isDark ? "rgba(30,144,255,0.03)" : "rgba(0,71,171,0.08)"} 1px, transparent 1px), linear-gradient(90deg, ${isDark ? "rgba(30,144,255,0.03)" : "rgba(0,71,171,0.08)"} 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
        }}
      />
      <div className="absolute inset-0" style={{
        background: isDark
          ? "radial-gradient(ellipse 60% 40% at 75% 25%, rgba(30,144,255,0.05) 0%, transparent 60%)"
          : "radial-gradient(ellipse 60% 40% at 75% 25%, rgba(0,71,171,0.09) 0%, transparent 60%)",
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function MetadataPage() {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [session, setSession] = useState<SessionData | null>(null);
  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState("custom-objects");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!loadIdentity()) { router.replace("/login"); return; }
    if (!isSetupComplete()) { router.replace("/setup"); return; }
    const s = loadSession();
    if (!s) { router.replace("/setup"); return; }
    setSession(s);
  }, [router]);

  const selectedItem = useMemo(() => ALL_ITEMS.find(i => i.id === selectedId) ?? ALL_ITEMS[0], [selectedId]);

  if (!mounted || !session) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000508" }}>
        <motion.div
          animate={{ opacity: [0.3, 0.8, 0.3] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          style={{ color: "rgba(30,144,255,0.4)", fontSize: "12px", fontFamily: "monospace" }}
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
      <GridBg isDark={isDark} />

      <div className="relative z-10 flex flex-col h-full">
        <NavBar session={session} isDark={isDark} onSignOut={() => { clearSession(); clearIdentity(); clearSetup(); router.replace("/login"); }} />

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            isDark={isDark}
            selectedId={selectedId}
            onSelect={setSelectedId}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(v => !v)}
          />

          {/* Main workspace */}
          <div
            className="flex-1 overflow-hidden flex flex-col"
            style={{
              background: isDark ? "rgba(1,9,24,0.45)" : "rgba(218,232,255,0.80)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          >
            <WorkspacePanel item={selectedItem} isDark={isDark} />
          </div>
        </div>
      </div>
    </div>
  );
}
