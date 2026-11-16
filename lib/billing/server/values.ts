import type { BillingFieldMeta } from "@/lib/billing/types";

export type CoerceResult = { ok: true; value: unknown } | { ok: false; reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_TYPES = new Set(["int", "double", "currency", "percent", "long"]);

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Match a free-text picklist value to the org's real active values (by value, then label, case-insensitively). */
export function matchPicklistValue(field: BillingFieldMeta, raw: string): string | null {
  const needle = raw.trim().toLowerCase();
  const byValue = field.picklistValues.find(p => p.value.toLowerCase() === needle);
  if (byValue) return byValue.value;
  const byLabel = field.picklistValues.find(p => p.label.toLowerCase() === needle);
  if (byLabel) return byLabel.value;
  const squashed = needle.replace(/[\s_-]+/g, "");
  return field.picklistValues.find(p => p.value.toLowerCase().replace(/[\s_-]+/g, "") === squashed || p.label.toLowerCase().replace(/[\s_-]+/g, "") === squashed)?.value ?? null;
}

/**
 * Convert a UI/AI-provided value into exactly what Salesforce expects for the
 * field's Describe type. Never invents a value — anything that can't be
 * converted faithfully is reported back instead of being sent.
 */
export function coerceFieldValue(field: BillingFieldMeta, raw: unknown): CoerceResult {
  if (isEmptyValue(raw)) return { ok: true, value: null };

  switch (field.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1", "on", "enabled"].includes(s)) return { ok: true, value: true };
      if (["false", "no", "n", "0", "off", "disabled"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: `"${raw}" isn't a yes/no value.` };
    }
    case "int":
    case "long":
    case "double":
    case "currency":
    case "percent": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,%\s₹$€£]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, reason: `"${raw}" isn't a number.` };
      if ((field.type === "int" || field.type === "long") && !Number.isInteger(n)) return { ok: false, reason: `${field.label} must be a whole number.` };
      return { ok: true, value: n };
    }
    case "date": {
      const s = String(raw).trim();
      const d = DATE_RE.test(s) ? s : (() => { const parsed = new Date(s); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10); })();
      if (!d) return { ok: false, reason: `"${raw}" isn't a valid date (use YYYY-MM-DD).` };
      return { ok: true, value: d };
    }
    case "datetime": {
      const s = String(raw).trim();
      const parsed = new Date(DATE_RE.test(s) ? `${s}T00:00:00Z` : s);
      if (Number.isNaN(parsed.getTime())) return { ok: false, reason: `"${raw}" isn't a valid date/time.` };
      return { ok: true, value: parsed.toISOString() };
    }
    case "picklist": {
      const matched = matchPicklistValue(field, String(raw));
      if (!matched) return { ok: false, reason: `"${raw}" isn't an allowed ${field.label} value (allowed: ${field.picklistValues.map(p => p.value).join(", ") || "none"}).` };
      return { ok: true, value: matched };
    }
    case "multipicklist": {
      const parts = (Array.isArray(raw) ? raw : String(raw).split(/[;,]/)).map(p => String(p).trim()).filter(Boolean);
      const matched: string[] = [];
      for (const p of parts) {
        const m = matchPicklistValue(field, p);
        if (!m) return { ok: false, reason: `"${p}" isn't an allowed ${field.label} value.` };
        matched.push(m);
      }
      return { ok: true, value: matched.join(";") };
    }
    case "reference":
      return { ok: false, reason: "Reference fields must be set through a lookup, not as text." };
    default: {
      const s = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : JSON.stringify(raw);
      if (field.length && s.length > field.length) return { ok: false, reason: `${field.label} is limited to ${field.length} characters (got ${s.length}).` };
      return { ok: true, value: s };
    }
  }
}

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(type);
}
