"use client";

import type { BrandingConfig } from "@/lib/contracts/types";

/**
 * Per-Contract draft documents — "Save Draft" writes here, browser
 * localStorage only, never uploaded to Salesforce (§8). A draft is promoted
 * to a real generated document only via "Generate Contract Document", which
 * uploads to Salesforce and then deletes the draft that produced it (see
 * ContractDocuments.tsx) — drafts and generated documents never coexist for
 * the same piece of work.
 */

export interface DraftDocument {
  id: string;
  contractId: string;
  templateId: string;
  templateName: string;
  name: string;
  bodyHtml: string;
  branding: BrandingConfig;
  savedAt: string;
}

const DRAFTS_KEY = "omnicloud_contract_document_drafts_v1";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function readAll(): DraftDocument[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows: DraftDocument[]): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(rows));
  } catch {
    // Storage full/disabled — the caller still gets its result back for this session's use.
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listDrafts(contractId: string): Promise<DraftDocument[]> {
  return readAll()
    .filter(d => d.contractId === contractId)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function getDraft(id: string): Promise<DraftDocument | null> {
  return readAll().find(d => d.id === id) ?? null;
}

/** Pass an existing draft's `id` to update it in place; omit to create a new one. */
export async function saveDraft(input: {
  id?: string; contractId: string; templateId: string; templateName: string;
  name: string; bodyHtml: string; branding: BrandingConfig;
}): Promise<DraftDocument> {
  const rows = readAll();
  const now = new Date().toISOString();
  const idx = input.id ? rows.findIndex(d => d.id === input.id) : -1;

  const draft: DraftDocument = {
    id: input.id ?? newId(),
    contractId: input.contractId,
    templateId: input.templateId,
    templateName: input.templateName,
    name: input.name,
    bodyHtml: input.bodyHtml,
    branding: input.branding,
    savedAt: now,
  };

  if (idx >= 0) rows[idx] = draft;
  else rows.push(draft);
  writeAll(rows);
  return draft;
}

export async function deleteDraft(id: string): Promise<void> {
  writeAll(readAll().filter(d => d.id !== id));
}
