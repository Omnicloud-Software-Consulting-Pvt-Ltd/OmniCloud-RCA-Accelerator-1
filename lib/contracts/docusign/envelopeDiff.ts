/**
 * Recursive structured diff between two raw DocuSign JSON responses (e.g. an
 * API-created envelope vs. one created manually in the DocuSign web UI).
 * Built for the "Compare Envelopes" diagnostic — never used by production
 * sending/parsing paths.
 */

export interface EnvelopeDiffEntry {
  path: string;
  apiValue: unknown;
  manualValue: unknown;
  /**
   * Automatic classification — a starting point for triage, not a verdict.
   * EVERY diff is still reported regardless of classification; nothing is
   * hidden by being classified low-priority.
   *   - "strong-delivery-candidate": a field that, by itself, plausibly
   *     fully explains total non-delivery (email overrides/suppression,
   *     signing mode, brand).
   *   - "possibly-delivery-relevant": known to affect notification/
   *     authentication/routing behavior, but not a one-field explanation on
   *     its own.
   *   - "expected-or-irrelevant": everything else (names, generated ids,
   *     free-text content, structural noise).
   */
  classification: "strong-delivery-candidate" | "possibly-delivery-relevant" | "expected-or-irrelevant";
}

/** Keys that are inherently unique per envelope/recipient/request/tab — always skipped, whether present, absent, or differing, on either side. Includes generated IDs, timestamps, and IP addresses per the "ignore generated/unique-per-request values" rule. */
const ALWAYS_IGNORED_KEYS = new Set([
  "envelopeId", "documentId", "recipientId", "recipientIdGuid", "customFieldId", "templateId", "accountId",
  "tabId", "uri", "envelopeUri", "documentBase64", "logTime", "ipAddress", "senderIpAddress", "recipientIpAddress",
  "createdDateTime", "sentDateTime", "completedDateTime", "statusChangedDateTime", "deliveredDateTime",
  "signedDateTime", "declinedDateTime", "voidedDateTime", "deletedDateTime", "lastModifiedDateTime",
  "initialSentDateTime", "deliveredDateTimeUTC",
]);

/** Keys whose CONTENT is expected to differ (subject/body text, names, the recipient's own email) — a presence/absence mismatch is still reported, but two different values for the same key are not. */
const CONTENT_ONLY_KEYS = new Set([
  "name", "emailSubject", "emailBlurb", "subject", "message", "email", "userName", "senderName", "note",
]);

/**
 * A field difference here would, on its own, plausibly fully explain total
 * non-delivery — email-behavior overrides, suppression, embedded-vs-remote
 * signing, and branding. Checked FIRST — a key never appears in both this
 * set and POSSIBLY_DELIVERY_RELEVANT_KEYS.
 */
const STRONG_DELIVERY_CANDIDATE_KEYS = new Set([
  "emailsettings", "suppressemailnotifications", "deliverymethod", "clientuserid",
  "brandid", "brandlock", "issignatureproviderenvelope", "signinglocation", "isbulkrecipient",
]);

/** Known to plausibly affect notification/authentication/routing behavior, but not a one-field explanation for total non-delivery by itself. */
const POSSIBLY_DELIVERY_RELEVANT_KEYS = new Set([
  "emailnotification", "notification", "reminders", "reminderenabled", "reminderdelay",
  "reminderfrequency", "expirations", "expireenabled", "expireafter", "expirewarn", "messagelock",
  "recipientslock", "usedisclosure", "allowreassign", "allowmarkup", "enablewetsign",
  "enforcesignervisibility", "signercansignonmobile", "authoritativecopy", "is21cfrpart11",
  "useaccountdefaults", "recipientauthenticationstatus",
  "identityverification", "authenticationmethod", "requireidlookup", "embeddedrecipientstarturl",
  "recipienttype", "recipientsuppliestabs", "signineachlocation", "requiresignonpaper", "cansignoffline",
  "recipientsignatureproviders", "rolename", "defaultrecipient", "excludeddocuments",
  "accesscode", "sendercansignmanually", "routingorder",
]);

function classify(leafKey: string): EnvelopeDiffEntry["classification"] {
  const k = leafKey.toLowerCase();
  if (STRONG_DELIVERY_CANDIDATE_KEYS.has(k)) return "strong-delivery-candidate";
  if (POSSIBLY_DELIVERY_RELEVANT_KEYS.has(k)) return "possibly-delivery-relevant";
  return "expected-or-irrelevant";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function diffEnvelopeJson(apiValue: unknown, manualValue: unknown, pathPrefix = ""): EnvelopeDiffEntry[] {
  const out: EnvelopeDiffEntry[] = [];
  const leafKey = pathPrefix.split(/[.[]/).pop() ?? pathPrefix;

  if (ALWAYS_IGNORED_KEYS.has(leafKey)) return out;

  const bothPresent = apiValue !== undefined && manualValue !== undefined;
  if (CONTENT_ONLY_KEYS.has(leafKey) && bothPresent) return out;

  if (isPlainObject(apiValue) || isPlainObject(manualValue)) {
    const a = isPlainObject(apiValue) ? apiValue : {};
    const b = isPlainObject(manualValue) ? manualValue : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      out.push(...diffEnvelopeJson(a[key], b[key], pathPrefix ? `${pathPrefix}.${key}` : key));
    }
    return out;
  }

  if (Array.isArray(apiValue) || Array.isArray(manualValue)) {
    const a = Array.isArray(apiValue) ? apiValue : [];
    const b = Array.isArray(manualValue) ? manualValue : [];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      out.push(...diffEnvelopeJson(a[i], b[i], `${pathPrefix}[${i}]`));
    }
    return out;
  }

  if (apiValue !== manualValue) {
    out.push({ path: pathPrefix, apiValue, manualValue, classification: classify(leafKey) });
  }
  return out;
}

const RANK: Record<EnvelopeDiffEntry["classification"], number> = {
  "strong-delivery-candidate": 0,
  "possibly-delivery-relevant": 1,
  "expected-or-irrelevant": 2,
};

/** Sorts strongest-candidate diffs first, then possibly-relevant, then everything else — nothing is dropped, only ordered. */
export function sortDiffs(diffs: EnvelopeDiffEntry[]): EnvelopeDiffEntry[] {
  return [...diffs].sort((a, b) => RANK[a.classification] - RANK[b.classification] || a.path.localeCompare(b.path));
}
