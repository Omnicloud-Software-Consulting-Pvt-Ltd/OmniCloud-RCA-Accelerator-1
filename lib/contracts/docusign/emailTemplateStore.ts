"use client";

import type { EmailTemplate } from "@/lib/contracts/docusign/emailTemplates";
import { BUILTIN_EMAIL_TEMPLATES } from "@/lib/contracts/docusign/emailTemplates";
import { LIMITS, unknownPlaceholders } from "@/lib/contracts/docusign/validation";

/**
 * Custom signature-request email templates — stored in this browser's localStorage, the same storage the Contracts module already
 * uses for contract templates and company settings (lib/contracts/documents/localTemplateStore.ts). Templates hold no secrets.
 * Limitation: they are per browser, not shared across a team, until the app has a tenant database.
 */

const KEY = "omnicloud_docusign_email_templates_v1";

function readCustom(): EmailTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as EmailTemplate[]) : [];
    return Array.isArray(parsed) ? parsed.filter(t => t && typeof t.id === "string" && typeof t.name === "string").map(t => ({ ...t, builtIn: false })) : [];
  } catch {
    return [];
  }
}

function writeCustom(list: EmailTemplate[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: change isn't kept */ }
}

export function validateTemplateInput(input: { name: string; subject: string; message: string }): string | null {
  if (!input.name.trim()) return "Give the template a name.";
  if (input.name.trim().length > 80) return "Template names must be 80 characters or fewer.";
  if (input.subject.length > LIMITS.subject * 2) return "The subject is too long.";
  if (input.message.length > LIMITS.message) return `The message must be ${LIMITS.message} characters or fewer.`;
  const unknown = [...unknownPlaceholders(input.subject), ...unknownPlaceholders(input.message)];
  if (unknown.length) return `Unknown placeholder: {{${unknown[0]}}}.`;
  return null;
}

export function listEmailTemplates(): EmailTemplate[] {
  return [...BUILTIN_EMAIL_TEMPLATES, ...readCustom().sort((a, b) => a.name.localeCompare(b.name))];
}

export function createEmailTemplate(input: { name: string; subject: string; message: string }): EmailTemplate {
  const err = validateTemplateInput(input);
  if (err) throw new Error(err);
  const t: EmailTemplate = { id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: input.name.trim(), subject: input.subject, message: input.message, builtIn: false, updatedAt: new Date().toISOString() };
  writeCustom([...readCustom(), t]);
  return t;
}

export function updateEmailTemplate(id: string, input: { name: string; subject: string; message: string }): EmailTemplate {
  const list = readCustom();
  const i = list.findIndex(t => t.id === id);
  if (i < 0) throw new Error("Built-in templates can't be changed — save a copy instead.");
  const err = validateTemplateInput(input);
  if (err) throw new Error(err);
  list[i] = { ...list[i], name: input.name.trim(), subject: input.subject, message: input.message, updatedAt: new Date().toISOString() };
  writeCustom(list);
  return list[i];
}

export function duplicateEmailTemplate(source: EmailTemplate): EmailTemplate {
  return createEmailTemplate({ name: `${source.name} (copy)`.slice(0, 80), subject: source.subject, message: source.message });
}

export function deleteEmailTemplate(id: string): void {
  const list = readCustom();
  if (!list.some(t => t.id === id)) throw new Error("Built-in templates can't be deleted.");
  writeCustom(list.filter(t => t.id !== id));
}
