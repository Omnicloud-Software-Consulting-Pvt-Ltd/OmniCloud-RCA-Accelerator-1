/**
 * Hand-rolled DocuSign REST client — mirrors the style of
 * lib/salesforce/client.ts (a small class/functions over `fetch`, no heavy
 * SDK dependency) rather than pulling in `docusign-esign`. Covers exactly
 * what the Contract module's e-signature flow needs (§5): OAuth authorize/
 * exchange/refresh/userinfo, and envelope create-and-send + combined-document
 * fetch.
 */

export class DocuSignError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "DocuSignError";
    this.status = status;
    this.body = body;
  }
}

export type DocuSignEnvironment = "demo" | "production";

const AUTH_BASE: Record<DocuSignEnvironment, string> = {
  demo: "https://account-d.docusign.com",
  production: "https://account.docusign.com",
};

export function docuSignAuthBase(environment: DocuSignEnvironment): string {
  return AUTH_BASE[environment];
}

/** First 4 + last 2 chars only — enough to recognize which key without exposing the whole value in logs/diagnostics. Shared by Settings and the /connect OAuth trace log so both mask identically. */
export function maskDocuSignClientId(clientId: string): string {
  if (clientId.length <= 8) return "*".repeat(clientId.length);
  return `${clientId.slice(0, 4)}${"*".repeat(clientId.length - 6)}${clientId.slice(-2)}`;
}

/** §5.1: standard OAuth 2.0 Authorization Code Grant against the org's chosen DocuSign environment. */
export function docuSignAuthorizeUrl(environment: DocuSignEnvironment, clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    scope: "signature extended",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${docuSignAuthBase(environment)}/oauth/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function exchangeAuthorizationCode(
  environment: DocuSignEnvironment,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<ExchangedTokens> {
  const authBaseUrl = docuSignAuthBase(environment);
  const tokenUrl = `${authBaseUrl}/oauth/token`;
  // Sanitized pre-request trace — never the secret/code themselves, only
  // their presence/length, so a trimmed-vs-untrimmed or stale-credential
  // mismatch is provable from logs alone.
  console.log(
    `[DOCUSIGN TOKEN EXCHANGE]\n` +
    `environment = ${environment}\n` +
    `authBaseUrl = ${authBaseUrl}\n` +
    `tokenUrl = ${tokenUrl}\n` +
    `clientIdMasked = ${maskDocuSignClientId(clientId)}\n` +
    `clientIdLength = ${clientId.length}\n` +
    `clientSecretPresent = ${!!clientSecret}\n` +
    `clientSecretLength = ${clientSecret.length}\n` +
    `redirectUri = ${redirectUri}\n` +
    `grantType = authorization_code\n` +
    `authorizationCodePresent = ${!!code}`,
  );

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
  });
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  console.log(
    `[DOCUSIGN TOKEN EXCHANGE]\n` +
    `tokenHttpStatus = ${res.status}\n` +
    `tokenError = ${body?.error ?? "(none)"}\n` +
    `tokenErrorDescription = ${body?.error_description ?? "(none)"}`,
  );
  if (!res.ok || !body?.access_token) {
    throw new DocuSignError(body?.error_description ?? "Failed to exchange DocuSign authorization code", res.status, body);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? "", expiresIn: body.expires_in };
}

/**
 * §5.1: auto-refresh proactively (caller enforces the 60s skew window — see
 * lib/contracts/docusign/oauth.ts). If the refresh token itself is dead
 * (`invalid_grant`), the thrown DocuSignError's body carries
 * `invalidGrant: true` so the caller can distinguish "needs reauthorization"
 * from a transient failure.
 */
export async function refreshAccessToken(
  environment: DocuSignEnvironment,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<ExchangedTokens> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${docuSignAuthBase(environment)}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !body?.access_token) {
    throw new DocuSignError(body?.error_description ?? "Failed to refresh DocuSign access token", res.status, {
      ...body,
      invalidGrant: body?.error === "invalid_grant",
    });
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken, expiresIn: body.expires_in };
}

export interface DocuSignAccount {
  account_id: string;
  is_default: boolean;
  account_name: string;
  base_uri: string;
}

export interface DocuSignUserInfo {
  sub: string;
  name: string;
  email: string;
  accounts: DocuSignAccount[];
}

/** §5.1: validate a connection with a real identity call, not just local expiry-timestamp bookkeeping. */
export async function getUserInfo(environment: DocuSignEnvironment, accessToken: string): Promise<DocuSignUserInfo> {
  const res = await fetch(`${docuSignAuthBase(environment)}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new DocuSignError("Failed to fetch DocuSign user info", res.status, body);
  return body as DocuSignUserInfo;
}

export interface EnvelopeSignerInput {
  name: string;
  email: string;
  recipientId: string;
  /**
   * DocuSign's routingOrder — recipients sharing the same routingOrder are
   * notified in PARALLEL (immediately, all at once); a recipient with a
   * HIGHER routingOrder is only notified once every recipient at a lower
   * routingOrder has completed. Callers currently always pass 1 for every
   * signer (parallel signing is this app's default and, right now, its only
   * supported mode — there's no UI yet for a user to opt into sequential
   * routing).
   */
  routingOrder: number;
  /** 0-based position used ONLY to vertically stack each signer's placeholder signHereTab so they don't overlap on the page — has no bearing on DocuSign's actual routing/notification behavior. Deliberately separate from `routingOrder` (conflating the two used to make every recipient after the first also skip the page-position stacking whenever routingOrder was held constant). */
  tabStackIndex: number;
  /**
   * NOT used by production Send-for-Signature — that flow always omits this
   * field and relies on DocuSign's own default (`"email"` for a `signers`
   * recipient). Exists ONLY so the DocuSign Settings "Email Delivery Control
   * Test" can run the one specific controlled experiment raised during the
   * API-vs-manual-envelope investigation: does explicitly sending
   * `deliveryMethod: "email"` (rather than relying on the implicit default)
   * change DocuSign's actual delivery behavior. Omitted entirely (not even
   * sent as undefined) unless a caller explicitly sets it.
   */
  deliveryMethodOverride?: "email";
  /**
   * NOT used by production Send-for-Signature — that flow always sends this
   * signer's explicit signHereTab. Exists ONLY for the "Control Test B"
   * experiment: DocuSign's own documentation ("Freeform Signing" — see the
   * DocuSign Developer blog "Let your signers decide where to place the
   * tabs for you") describes `recipientSuppliesTabs` as a value DocuSign
   * reports back when a recipient was sent with ZERO tabs, not a flag the
   * sender is documented to toggle directly while still supplying its own
   * tabs — DocuSign's own generated SDK model gives the field itself no
   * substantive description at all. So this control test reproduces the
   * manual envelope's actual configuration (no tabs supplied) rather than
   * setting the undocumented flag directly, since forcing it alongside an
   * explicit signHereTab would be the unsupported/contradictory combination
   * the field's own (near-total lack of) documentation gives no basis to
   * assume is valid.
   */
  omitTabs?: boolean;
}

export interface CreateEnvelopeResult {
  envelopeId: string;
  status: string;
  /** DocuSign's own timestamp for this status transition (its create-and-send response's `statusDateTime`) — the authoritative "sent at," not our own clock. Null if DocuSign didn't return one. */
  statusDateTime: string | null;
}

/**
 * §5.2: create AND send in one call (status: "sent" in the request body
 * below — literal, not "created" — so DocuSign sends the envelope
 * immediately rather than leaving it as an editable draft). Recipients are
 * REMOTE email signers: no `clientUserId` is ever set on a signer (that's
 * what would make DocuSign treat them as an embedded/captive signer instead
 * of emailing them directly). `deliveryMethod: "email"` is sent EXPLICITLY
 * for every signer — verified via a controlled A/B test (an envelope relying
 * on DocuSign's implicit default silently never emailed the recipient, even
 * though DocuSign reported status "sent"/"Sent Invitations"; the identical
 * envelope with `deliveryMethod` explicitly set delivered successfully).
 * signHereTabs use a fixed, stacked position on page 1 (a disclosed
 * limitation, not a bug — see §5.2 point 4) rather than an anchor-string
 * match, since the generated PDF doesn't currently embed a reliable anchor
 * string.
 */
function maskEmailForLog(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}

/**
 * Sanitized pre-send diagnostic — logs the EXACT payload about to be POSTed
 * to DocuSign (never the access token). Reads fields back off the already-
 * built `body`/`opts` rather than re-deriving them, so this can never drift
 * from what's actually sent.
 */
function logEnvelopeRequest(
  opts: { emailSubject: string; emailBody: string; documentBase64: string; documentName: string; signers: EnvelopeSignerInput[] },
  body: { documents: { documentId: string; fileExtension: string }[]; status: string },
): void {
  const lines = [
    `documentCount = ${body.documents.length}`,
    `documentId = ${body.documents[0]?.documentId}`,
    `fileExtension = ${body.documents[0]?.fileExtension}`,
    `documentByteLength (pre-base64) = ${Math.floor((opts.documentBase64.length * 3) / 4)}`,
    `documentBase64Length = ${opts.documentBase64.length}`,
    `emailSubject = ${opts.emailSubject}`,
    `emailBlurbPresent = ${!!opts.emailBody}`,
    `status = ${body.status}`,
    ...opts.signers.flatMap((s, i) => [
      `signer[${i}].recipientId = ${s.recipientId}`,
      `signer[${i}].name = ${s.name}`,
      `signer[${i}].emailMasked = ${maskEmailForLog(s.email)}`,
      `signer[${i}].routingOrder = ${s.routingOrder}`,
      `signer[${i}].clientUserIdPresent = false`, // EnvelopeSignerInput has no clientUserId field at all — see its type def above.
      `signer[${i}].deliveryMethod = ${s.deliveryMethodOverride ?? "email"}`, // always explicit now — verified production fix, not a control-test-only value.
      `signer[${i}].signHereTabCount = ${s.omitTabs ? 0 : 1}`,
    ]),
  ];
  console.log(`[DOCUSIGN ENVELOPE REQUEST]\n${lines.join("\n")}`);
}

export async function createAndSendEnvelope(opts: {
  baseUri: string;
  accountId: string;
  accessToken: string;
  emailSubject: string;
  emailBody: string;
  documentBase64: string;
  documentName: string;
  signers: EnvelopeSignerInput[];
}): Promise<CreateEnvelopeResult> {
  const url = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes`;
  const body = {
    emailSubject: opts.emailSubject,
    emailBlurb: opts.emailBody,
    documents: [{ documentBase64: opts.documentBase64, name: opts.documentName, fileExtension: "pdf", documentId: "1" }],
    recipients: {
      signers: opts.signers.map(s => ({
        email: s.email,
        name: s.name,
        recipientId: s.recipientId,
        routingOrder: String(s.routingOrder),
        // Verified production fix: always explicit, never left to DocuSign's
        // implicit default. `deliveryMethodOverride` is a no-op today (its
        // only allowed value is already "email") — kept only so the Test A/B
        // control-test plumbing above doesn't need to change.
        deliveryMethod: s.deliveryMethodOverride ?? "email",
        ...(s.omitTabs ? {} : {
          tabs: {
            signHereTabs: [
              { documentId: "1", pageNumber: "1", xPosition: "72", yPosition: String(120 + 60 * s.tabStackIndex) },
            ],
          },
        }),
      })),
    },
    status: "sent",
  };

  logEnvelopeRequest(opts, body);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new DocuSignError((json?.message as string) ?? "Failed to create/send DocuSign envelope", res.status, json);
  return { envelopeId: json.envelopeId as string, status: json.status as string, statusDateTime: (json.statusDateTime as string) ?? null };
}

export interface EnvelopeSummary {
  envelopeId: string;
  status: string;
  emailSubject: string | null;
  sentDateTime: string | null;
  createdDateTime: string | null;
  statusChangedDateTime: string | null;
}

/** GET the envelope itself — real, current status/timestamps straight from DocuSign, not our own bookkeeping. */
export async function getEnvelope(opts: { baseUri: string; accountId: string; accessToken: string; envelopeId: string }): Promise<EnvelopeSummary> {
  const url = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes/${opts.envelopeId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.accessToken}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new DocuSignError((json?.message as string) ?? "Failed to fetch the envelope from DocuSign", res.status, json);
  return {
    envelopeId: json.envelopeId as string,
    status: json.status as string,
    emailSubject: (json.emailSubject as string) ?? null,
    sentDateTime: (json.sentDateTime as string) ?? null,
    createdDateTime: (json.createdDateTime as string) ?? null,
    statusChangedDateTime: (json.statusChangedDateTime as string) ?? null,
  };
}

export interface EnvelopeRecipientSummary {
  name: string;
  email: string;
  recipientId: string;
  routingOrder: string | null;
  status: string | null;
  deliveryMethod: string | null;
  clientUserIdPresent: boolean;
  sentDateTime: string | null;
  deliveredDateTime: string | null;
  signedDateTime: string | null;
  declinedDateTime: string | null;
  /** DocuSign-reported (String "true"/"false"/null) — surfaced for the Compare/Control-Test tooling; NOT something production sending sets or relies on. */
  recipientSuppliesTabs: string | null;
  totalTabCount: number | null;
}

/** GET the envelope's actual recipient records — DocuSign's own view of each signer's delivery/status, not what we requested. */
export async function getEnvelopeRecipients(opts: { baseUri: string; accountId: string; accessToken: string; envelopeId: string }): Promise<EnvelopeRecipientSummary[]> {
  // include_extended=true — otherwise DocuSign omits recipientSuppliesTabs (and some tab-count detail) from this response.
  const url = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes/${opts.envelopeId}/recipients?include_extended=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.accessToken}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new DocuSignError((json?.message as string) ?? "Failed to fetch envelope recipients from DocuSign", res.status, json);
  const signers = (json?.signers as Record<string, unknown>[] | undefined) ?? [];
  return signers.map(s => ({
    name: (s.name as string) ?? "",
    email: (s.email as string) ?? "",
    recipientId: (s.recipientId as string) ?? "",
    routingOrder: (s.routingOrder as string) ?? null,
    status: (s.status as string) ?? null,
    deliveryMethod: (s.deliveryMethod as string) ?? null,
    clientUserIdPresent: !!s.clientUserId,
    sentDateTime: (s.sentDateTime as string) ?? null,
    deliveredDateTime: (s.deliveredDateTime as string) ?? null,
    signedDateTime: (s.signedDateTime as string) ?? null,
    declinedDateTime: (s.declinedDateTime as string) ?? null,
    recipientSuppliesTabs: (s.recipientSuppliesTabs as string) ?? null,
    totalTabCount: s.totalTabCount != null ? Number(s.totalTabCount) : null,
  }));
}

export interface EnvelopeAuditEvent {
  eventName: string | null;
  eventDateTime: string | null;
  raw: Record<string, string>;
}

/**
 * GET the envelope's audit events (DocuSign Connect-independent — this is a
 * pull, not a webhook), if the account's plan/scope has this enabled.
 * Best-effort: some DocuSign plans return 403/404 for this endpoint, which
 * is not itself evidence of anything wrong with the envelope — callers
 * should treat a failure here as "unavailable," not as a diagnostic result.
 */
export async function getEnvelopeAuditEvents(opts: { baseUri: string; accountId: string; accessToken: string; envelopeId: string }): Promise<EnvelopeAuditEvent[] | null> {
  const url = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes/${opts.envelopeId}/audit_events`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.accessToken}` } });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  // Log the RAW response (email-redacted) before parsing it — the eventName/
  // eventDateTime extraction below assumes DocuSign's eventFields use the
  // keys "EventName" and "LogTime"/"EventDateTime"; if that assumption is
  // wrong for this account/plan, eventName comes back null with no way to
  // tell why unless the actual raw shape is visible here.
  const redacted = JSON.stringify(json).replace(/[^\s"]+@[^\s"]+\.[^\s"]+/g, m => maskEmailForLog(m));
  console.log(`[DOCUSIGN AUDIT RAW]\n${redacted}`);
  const events = (json?.auditEvents as { eventFields?: { name: string; value: string }[] }[] | undefined) ?? [];
  return events.map(e => {
    const raw: Record<string, string> = {};
    for (const f of e.eventFields ?? []) raw[f.name] = f.value;
    return { eventName: raw.EventName ?? null, eventDateTime: raw.LogTime ?? raw.EventDateTime ?? null, raw };
  });
}

/** Recursively masks any email-like string found anywhere in a raw DocuSign JSON response — used only by the raw diagnostic dump below, never by production sending/parsing paths. */
function redactEmailsDeep(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/[^\s"]+@[^\s"]+\.[^\s"]+/g, m => maskEmailForLog(m));
  if (Array.isArray(value)) return value.map(redactEmailsDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactEmailsDeep(v);
    return out;
  }
  return value;
}

/**
 * Full-fidelity, sanitized dump of an envelope's raw DocuSign responses —
 * NOT the narrowed EnvelopeSummary/EnvelopeRecipientSummary shapes above.
 * Exists purely for manual side-by-side comparison of two envelopes (e.g. an
 * API-created one vs. a manually-created one in the DocuSign web UI) when the
 * curated fields aren't enough to explain a behavioral difference. Read-only;
 * never used by envelope creation or by the production Send-for-Signature/
 * Check-Status paths. Emails are redacted; every other field is preserved
 * verbatim so nothing gets silently dropped from the comparison.
 */
export async function getEnvelopeRawDump(opts: { baseUri: string; accountId: string; accessToken: string; envelopeId: string }): Promise<{
  envelope: Record<string, unknown> | null;
  recipients: Record<string, unknown> | null;
  notification: Record<string, unknown> | null;
  auditEvents: Record<string, unknown> | null;
}> {
  const headers = { Authorization: `Bearer ${opts.accessToken}` };
  const base = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes/${opts.envelopeId}`;

  const fetchJson = async (url: string): Promise<Record<string, unknown> | null> => {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json ? (redactEmailsDeep(json) as Record<string, unknown>) : null;
  };

  const [envelope, recipients, notification, auditEvents] = await Promise.all([
    fetchJson(`${base}?include=recipients,tabs`),
    fetchJson(`${base}/recipients?include_extended=true&include_tabs=true`),
    fetchJson(`${base}/notification`),
    fetchJson(`${base}/audit_events`),
  ]);

  return { envelope, recipients, notification, auditEvents };
}

/** §5.5: fetch the envelope's combined signed PDF + Certificate of Completion. */
export async function fetchCombinedDocument(opts: { baseUri: string; accountId: string; accessToken: string; envelopeId: string }): Promise<Buffer> {
  const url = `${opts.baseUri}/restapi/v2.1/accounts/${opts.accountId}/envelopes/${opts.envelopeId}/documents/combined`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: "application/pdf" } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new DocuSignError("Failed to fetch the signed document from DocuSign", res.status, body);
  }
  return Buffer.from(await res.arrayBuffer());
}
