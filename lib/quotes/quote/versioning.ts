import type { SalesforceClient } from "@/lib/salesforce/client";
import { soqlEscape } from "@/lib/salesforce/client";

export interface VersioningResult {
  finalName: string;
  wasVersioned: boolean;
}

/**
 * Deduplicate a Quote name against existing Quotes before creation (§3.5):
 * exact match or "{baseName} V{n}" bumps the version. Never hard-fails the
 * creation flow — a versioning-query failure degrades to using the
 * requested name unchanged.
 */
export async function resolveQuoteNameVersioning(client: SalesforceClient, nameFieldApiName: string, baseName: string): Promise<VersioningResult> {
  const escaped = soqlEscape(baseName.trim());
  try {
    const result = await client.query<{ [key: string]: string }>(
      `SELECT ${nameFieldApiName} FROM Quote WHERE ${nameFieldApiName} = '${escaped}' OR ${nameFieldApiName} LIKE '${escaped} V%' LIMIT 200`,
    );

    if (result.records.length === 0) return { finalName: baseName, wasVersioned: false };

    let maxVersion = 0;
    let exactMatch = false;
    const versionPattern = new RegExp(`^${escapeRegExp(baseName.trim())} V(\\d+)$`, "i");

    for (const record of result.records) {
      const name = record[nameFieldApiName];
      if (!name) continue;
      if (name === baseName.trim()) exactMatch = true;
      const match = name.match(versionPattern);
      if (match) maxVersion = Math.max(maxVersion, parseInt(match[1], 10));
    }

    if (!exactMatch && maxVersion === 0) return { finalName: baseName, wasVersioned: false };
    return { finalName: `${baseName.trim()} V${maxVersion + 1}`, wasVersioned: true };
  } catch {
    return { finalName: baseName, wasVersioned: false };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
