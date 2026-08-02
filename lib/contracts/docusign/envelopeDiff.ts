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
  /** Automatic classification — a starting point for triage, not a verdict. Every diff is still reported regardless of classification. */
  classification: "potentially-delivery-relevant" | "expected-or-irrelevant";
}

/** Keys that are inherently unique per envelope/recipient/request — always skipped, whether present, absent, or differing, on either side. */
const ALWAYS_IGNORED_KEYS = new Set([
  "envelopeId", "documentId", "recipientIdGuid", "customFieldId", "templateId", "accountId",
  "uri", "envelopeUri", "documentBase64", "logTime",
  "createdDateTime", "sentDateTime", "completedDateTime", "statusChangedDateTime", "deliveredDateTime",
  "signedDateTime", "declinedDateTime", "voidedDateTime", "deletedDateTime", "lastModifiedDateTime",
  "initialSentDateTime", "deliveredDateTimeUTC",
]);

/** Keys whose CONTENT is expected to differ (subject/body text, names, the recipient's own email) — a presence/absence mismatch is still reported, but two different values for the same key are not. */
const CONTENT_ONLY_KEYS = new Set([
  "name", "emailSubject", "emailBlurb", "subject", "message", "email", "userName", "senderName", "note",
]);

/** Keys known to plausibly affect notification/delivery behavior — surfaced first, not the only thing reported. */
const DELIVERY_RELEVANT_KEYS = new Set([
  "deliverymethod", "emailnotification", "notification", "reminders", "reminderenabled", "reminderdelay",
  "reminderfrequency", "expirations", "expireenabled", "expireafter", "expirewarn", "brandid", "brandlock",
  "messagelock", "recipientslock", "usedisclosure", "allowreassign", "allowmarkup", "enablewetsign",
  "enforcesignervisibility", "signercansignonmobile", "authoritativecopy", "is21cfrpart11",
  "issignatureproviderenvelope", "emailsettings", "useaccountdefaults", "recipientauthenticationstatus",
  "identityverification", "authenticationmethod", "requireidlookup", "embeddedrecipientstarturl",
  "recipienttype", "recipientsuppliestabs", "signineachlocation", "requiresignonpaper", "cansignoffline",
  "isbulkrecipient", "recipientsignatureproviders", "rolename", "defaultrecipient", "excludeddocuments",
  "clientuserid", "accesscode", "suppressemailnotifications", "sendercansignmanually",
]);

function classify(leafKey: string): EnvelopeDiffEntry["classification"] {
  return DELIVERY_RELEVANT_KEYS.has(leafKey.toLowerCase()) ? "potentially-delivery-relevant" : "expected-or-irrelevant";
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

/** Sorts delivery-relevant diffs first so the strongest candidates surface without hiding anything else. */
export function sortDiffs(diffs: EnvelopeDiffEntry[]): EnvelopeDiffEntry[] {
  return [...diffs].sort((a, b) => {
    if (a.classification === b.classification) return a.path.localeCompare(b.path);
    return a.classification === "potentially-delivery-relevant" ? -1 : 1;
  });
}
