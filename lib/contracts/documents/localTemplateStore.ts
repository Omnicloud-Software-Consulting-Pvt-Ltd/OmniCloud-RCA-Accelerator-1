"use client";

import { BUILTIN_TEMPLATES } from "@/lib/contracts/documents/builtinTemplates";
import { DEFAULT_BRANDING } from "@/lib/contracts/documents/render";
import { findUnrecognizedTags } from "@/lib/contracts/documents/pdfTagConverter";
import type { BrandingConfig, CompanySettings, ContractTemplate } from "@/lib/contracts/types";

/**
 * Client-side (browser localStorage) template + company-settings store —
 * the ENTIRE persistence layer for Documents/Template Studio. Built-in
 * templates are never stored anywhere; they're read straight from the
 * bundled `BUILTIN_TEMPLATES` array on every call. "My Templates" live only
 * in this browser's localStorage — there is no server, no database, and no
 * network request anywhere in this file, so Documents works identically
 * whether or not Postgres/DATABASE_URL is configured for the rest of the
 * app (DocuSign settings/e-signature state still use Postgres — unrelated
 * and untouched).
 *
 * Every export here is `async` even though the work is synchronous — this
 * is the seam a future real backend would slot into (swap the body for a
 * `fetch()` call) without touching a single call site in TemplateStudio.tsx.
 */

const TEMPLATES_KEY = "omnicloud_contract_templates_v1";
const COMPANY_SETTINGS_KEY = "omnicloud_contract_company_settings_v1";
const BUILTIN_ID_PREFIX = "builtin-";

interface StoredTemplate {
  id: string;
  name: string;
  bodyHtml: string;
  branding: Partial<BrandingConfig>;
  description: string;
  isDefault: boolean;
  createdBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function readStored(): StoredTemplate[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // Corrupt/unavailable storage degrades to "no custom templates yet", never a thrown error.
  }
}

function writeStored(rows: StoredTemplate[]): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(rows));
  } catch {
    // Storage full/disabled (private browsing) — the in-memory result of this
    // operation call still gets returned to the caller; it just won't survive a reload.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function builtinToTemplate(def: (typeof BUILTIN_TEMPLATES)[number]): ContractTemplate {
  return {
    id: `${BUILTIN_ID_PREFIX}${def.key}`,
    name: def.name,
    isBuiltin: true,
    bodyHtml: def.bodyHtml,
    uploadFilename: null,
    uploadMime: null,
    hasUpload: false,
    branding: DEFAULT_BRANDING,
    unrecognizedTags: findUnrecognizedTags(def.bodyHtml),
    createdAt: "",
    updatedAt: "",
    version: 1,
    description: "",
    isDefault: false,
    createdBy: null,
  };
}

function storedToTemplate(row: StoredTemplate): ContractTemplate {
  return {
    id: row.id,
    name: row.name,
    isBuiltin: false,
    bodyHtml: row.bodyHtml,
    uploadFilename: null,
    uploadMime: null,
    hasUpload: false,
    branding: { ...DEFAULT_BRANDING, ...row.branding },
    unrecognizedTags: findUnrecognizedTags(row.bodyHtml),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    description: row.description,
    isDefault: row.isDefault,
    createdBy: row.createdBy,
  };
}

function isBuiltinId(id: string): boolean {
  return id.startsWith(BUILTIN_ID_PREFIX);
}

export async function listTemplates(): Promise<ContractTemplate[]> {
  const builtins = BUILTIN_TEMPLATES.map(builtinToTemplate);
  const custom = readStored()
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(storedToTemplate);
  return [...builtins, ...custom];
}

export async function getTemplate(id: string): Promise<ContractTemplate | null> {
  if (isBuiltinId(id)) {
    const def = BUILTIN_TEMPLATES.find(d => `${BUILTIN_ID_PREFIX}${d.key}` === id);
    return def ? builtinToTemplate(def) : null;
  }
  const row = readStored().find(r => r.id === id);
  return row ? storedToTemplate(row) : null;
}

export async function createTemplate(input: { name: string; bodyHtml: string; branding?: Partial<BrandingConfig>; description?: string }): Promise<ContractTemplate> {
  const now = new Date().toISOString();
  const row: StoredTemplate = {
    id: newId(),
    name: input.name,
    bodyHtml: input.bodyHtml,
    branding: { ...DEFAULT_BRANDING, ...(input.branding ?? {}) },
    description: input.description ?? "",
    isDefault: false,
    createdBy: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  writeStored([...readStored(), row]);
  return storedToTemplate(row);
}

/** Built-ins are immutable — throws if the target template is a built-in. */
export async function updateTemplate(id: string, patch: { name?: string; bodyHtml?: string; branding?: Partial<BrandingConfig>; description?: string }): Promise<ContractTemplate | null> {
  if (isBuiltinId(id)) throw new Error("Built-in templates are immutable — duplicate it to make an editable copy.");
  const rows = readStored();
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const updated: StoredTemplate = {
    ...rows[idx],
    name: patch.name ?? rows[idx].name,
    bodyHtml: patch.bodyHtml ?? rows[idx].bodyHtml,
    branding: { ...rows[idx].branding, ...(patch.branding ?? {}) },
    description: patch.description ?? rows[idx].description,
    version: rows[idx].version + 1,
    updatedAt: new Date().toISOString(),
  };
  rows[idx] = updated;
  writeStored(rows);
  return storedToTemplate(updated);
}

/** Duplicating a built-in (or a custom template) always creates an editable copy under "My Templates". */
export async function duplicateTemplate(id: string, input?: { name?: string; description?: string }): Promise<ContractTemplate | null> {
  const existing = await getTemplate(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const row: StoredTemplate = {
    id: newId(),
    name: input?.name?.trim() || `${existing.name} (Copy)`,
    bodyHtml: existing.bodyHtml,
    branding: existing.branding,
    description: input?.description ?? existing.description,
    isDefault: false,
    createdBy: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  writeStored([...readStored(), row]);
  return storedToTemplate(row);
}

/** Built-ins can never be deleted. */
export async function deleteTemplate(id: string): Promise<boolean> {
  if (isBuiltinId(id)) throw new Error("Built-in templates cannot be deleted.");
  const rows = readStored();
  const next = rows.filter(r => r.id !== id);
  if (next.length === rows.length) return false;
  writeStored(next);
  return true;
}

/** Exactly one template may be marked default — clearing any previous default happens in the same write. */
export async function setDefaultTemplate(id: string): Promise<ContractTemplate | null> {
  const target = await getTemplate(id);
  if (!target) return null;
  const rows = readStored().map(r => ({ ...r, isDefault: r.id === id }));
  writeStored(rows);
  return getTemplate(id);
}

/* ── Company settings — one record, this browser only. ── */

const EMPTY_COMPANY_SETTINGS: CompanySettings = {
  companyName: "", address: "", phone: "", email: "", website: "", taxNumber: "", registrationNumber: "", logoUrl: null,
};

export async function getCompanySettings(): Promise<CompanySettings> {
  if (!hasLocalStorage()) return EMPTY_COMPANY_SETTINGS;
  try {
    const raw = window.localStorage.getItem(COMPANY_SETTINGS_KEY);
    return raw ? { ...EMPTY_COMPANY_SETTINGS, ...JSON.parse(raw) } : EMPTY_COMPANY_SETTINGS;
  } catch {
    return EMPTY_COMPANY_SETTINGS;
  }
}

export async function updateCompanySettings(patch: Partial<CompanySettings>): Promise<CompanySettings> {
  const current = await getCompanySettings();
  const merged = { ...current, ...patch };
  if (hasLocalStorage()) {
    try {
      window.localStorage.setItem(COMPANY_SETTINGS_KEY, JSON.stringify(merged));
    } catch {
      // Storage full/disabled — the merged value is still returned for this session's use.
    }
  }
  return merged;
}
