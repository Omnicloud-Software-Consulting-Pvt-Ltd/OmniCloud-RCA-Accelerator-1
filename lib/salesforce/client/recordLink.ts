"use client";

import { loadSession } from "@/lib/auth/session";

/**
 * A bare `<instanceUrl>/<recordId>` link — Salesforce's own id-based redirect
 * resolves this to the correct record page regardless of object type or
 * Lightning/Classic, so callers never need to know (or hardcode) the SObject
 * API name for whatever was just created.
 */
export function salesforceRecordUrl(recordId: string): string | null {
  const instanceUrl = loadSession()?.instanceUrl;
  if (!instanceUrl) return null;
  return `${instanceUrl.replace(/\/+$/, "")}/${recordId}`;
}
