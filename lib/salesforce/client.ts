export const SF_API_VERSION = "v60.0";
// RCA-era objects (Quote, QuoteLineItem, ProductRelatedComponent, ProductSellingModelOption, ...)
// need a newer API surface than the v60.0 default used elsewhere in the app.
export const SF_API_VERSION_RCA = "v62.0";

/**
 * Escape a user-supplied string for safe interpolation into a SOQL literal
 * (backslash + single-quote escaping). Apply to every user-supplied string
 * before building a query — this is the app's only SOQL-injection defense.
 */
export function soqlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/* ── Types ── */
export interface SalesforceUserInfo {
  sub: string;
  user_id: string;
  organization_id: string;
  name: string;
  email: string;
  preferred_username: string;
  display_name: string;
  nickname: string;
  urls: Record<string, string>;
}

export interface SalesforceRecord {
  [key: string]: unknown;
  Id?: string;
  attributes?: { type: string; url: string };
}

export interface QueryResult<T = SalesforceRecord> {
  totalSize: number;
  done: boolean;
  records: T[];
  nextRecordsUrl?: string;
}

export interface CreateResult {
  id: string;
  success: boolean;
  errors: unknown[];
}

export interface DescribeResult {
  name: string;
  label: string;
  labelPlural: string;
  fields: DescribeField[];
  recordTypeInfos: unknown[];
  urls: Record<string, string>;
  /**
   * Every OTHER object with a direct foreign-key field pointing AT this
   * object — Salesforce's own authoritative relationship metadata, always
   * present on a full describe. This is the correct, name-independent way
   * to discover "which objects reference Product2" (§Inspect the actual
   * API calls, not object-name guessing): never infer a relationship object
   * by pattern-matching its name when this array already states it exactly.
   */
  childRelationships?: { childSObject: string; field: string; relationshipName: string | null }[];
}

export interface DescribeField {
  name: string;
  label: string;
  type: string;
  length?: number;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  accessible?: boolean;
  calculated?: boolean;
  custom?: boolean;
  filterable?: boolean;
  defaultedOnCreate?: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  picklistValues?: { value: string; label: string; active: boolean; defaultValue?: boolean; validFor?: string }[];
  /** Dependent-picklist metadata Salesforce Describe actually returns — never assume a picklist is independent. */
  restrictedPicklist?: boolean;
  /** The API name of this field's controlling field, when this is a dependent picklist/checkbox. Null/undefined = not dependent on anything. */
  controllerName?: string | null;
}

export interface OrgLimits {
  [key: string]: { Max: number; Remaining: number };
}

export interface CompositeResult {
  id?: string;
  success: boolean;
  errors: { message: string; statusCode: string; fields?: string[] }[];
}

/* ── Error class ── */
export class SalesforceError extends Error {
  status: number;
  errorCode?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /**
   * §Do not collapse the error: the exact response text, populated ONLY when
   * the body could not be parsed as JSON at all (a raw HTML error page, a
   * truncated stream, an empty-but-non-204 response, etc.) — previously this
   * case discarded the entire response silently (`res.json().catch(() =>
   * null)`), leaving `body: null` and no way to see what Salesforce actually
   * sent back. When `body` parses successfully, this stays null (nothing
   * lost — the parsed body already has everything).
   */
  rawText: string | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(message: string, status: number, body?: any, rawText: string | null = null) {
    super(message);
    this.name = "SalesforceError";
    this.status = status;
    this.body = body;
    this.rawText = rawText;
    this.errorCode = Array.isArray(body) ? body[0]?.errorCode : body?.errorCode;
  }
}

/* ── OAuth refresh config (enables transparent token refresh) ── */
export interface RefreshConfig {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  loginBase: string;
  /** Called with the new access token after a successful refresh. */
  onRefreshed?: (newAccessToken: string) => void;
}

/* ── SalesforceClient ── */
export class SalesforceClient {
  readonly instanceUrl: string;
  private accessToken: string;
  readonly apiVersion: string;
  private readonly refresh?: RefreshConfig;

  constructor(
    instanceUrl: string,
    accessToken: string,
    apiVersion = SF_API_VERSION,
    refresh?: RefreshConfig,
  ) {
    this.instanceUrl = instanceUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.refresh = refresh;
  }

  /* Exchange the refresh token for a fresh access token. Returns true on success. */
  private async tryRefresh(): Promise<boolean> {
    if (!this.refresh) return false;
    const { refreshToken, clientId, clientSecret, loginBase, onRefreshed } = this.refresh;
    try {
      const res = await fetch(`${loginBase}/services/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        cache: "no-store",
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.access_token) return false;
      this.accessToken = data.access_token;
      onRefreshed?.(data.access_token);
      return true;
    } catch {
      return false;
    }
  }

  get dataApiBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}`;
  }

  get toolingApiBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}/tooling`;
  }

  /* ── Core request ── */
  async request<T = unknown>(
    path: string,
    options: RequestInit = {},
    _retried = false,
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.dataApiBase}${path}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });

    if (res.status === 204) return undefined as T;

    // §Do not collapse the error: read the raw text ONCE (a Response body
    // can only be consumed once), then attempt JSON parsing — if parsing
    // fails, the raw text is kept on the thrown error rather than silently
    // discarded (the previous `res.json().catch(() => null)` swallowed a
    // non-JSON response — e.g. a Connect REST 500 returning an HTML/plain-
    // text error page — leaving `body: null` with zero diagnostic value).
    const text = await res.text();
    let body: unknown = null;
    let parseFailed = false;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }

    if (!res.ok) {
      // Access token expired → refresh once and retry transparently.
      if (res.status === 401 && !_retried && this.refresh) {
        const refreshed = await this.tryRefresh();
        if (refreshed) return this.request<T>(path, options, true);
      }
      const bodyRecord = body as { message?: string; error_description?: string } | null;
      const message = Array.isArray(body)
        ? ((body[0] as { message?: string } | undefined)?.message ?? res.statusText)
        : (bodyRecord?.message ?? bodyRecord?.error_description ?? (parseFailed ? text.slice(0, 500) : res.statusText));
      throw new SalesforceError(message, res.status, body, parseFailed ? text : null);
    }

    return body as T;
  }

  /* ── Validation ── */
  async validate(): Promise<OrgLimits> {
    return this.request<OrgLimits>("/limits");
  }

  /* ── User info ── */
  async getUserInfo(): Promise<SalesforceUserInfo> {
    return this.request<SalesforceUserInfo>(
      `${this.instanceUrl}/services/oauth2/userinfo`,
    );
  }

  /* ── SOQL ── */
  async query<T = SalesforceRecord>(soql: string): Promise<QueryResult<T>> {
    return this.request<QueryResult<T>>(
      `/query/?q=${encodeURIComponent(soql)}`,
    );
  }

  async queryAll<T = SalesforceRecord>(soql: string): Promise<T[]> {
    const records: T[] = [];
    let result = await this.query<T>(soql);
    records.push(...result.records);
    while (!result.done && result.nextRecordsUrl) {
      result = await this.request<QueryResult<T>>(result.nextRecordsUrl);
      records.push(...result.records);
    }
    return records;
  }

  /* ── Record CRUD ── */
  async getRecord(
    sobject: string,
    id: string,
    fields?: string[],
  ): Promise<SalesforceRecord> {
    const qs = fields?.length ? `?fields=${fields.join(",")}` : "";
    return this.request<SalesforceRecord>(`/sobjects/${sobject}/${id}${qs}`);
  }

  async createRecord(
    sobject: string,
    fields: Record<string, unknown>,
  ): Promise<CreateResult> {
    return this.request<CreateResult>(`/sobjects/${sobject}`, {
      method: "POST",
      body: JSON.stringify(fields),
    });
  }

  async updateRecord(
    sobject: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    return this.request(`/sobjects/${sobject}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  async deleteRecord(sobject: string, id: string): Promise<void> {
    return this.request(`/sobjects/${sobject}/${id}`, { method: "DELETE" });
  }

  /**
   * Raw binary fetch (e.g. ContentVersion VersionData) — bypasses request()'s
   * JSON parsing, since a binary body would fail `res.json()`. Used by the
   * Contract module's document-download proxy (§4.4): the app has no
   * browser-level Salesforce session cookie, so files are streamed through
   * this server rather than a direct Salesforce URL.
   */
  async getBinary(path: string, _retried = false): Promise<{ buffer: Buffer; contentType: string }> {
    const url = path.startsWith("http") ? path : `${this.dataApiBase}${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!res.ok) {
      if (res.status === 401 && !_retried && this.refresh) {
        const refreshed = await this.tryRefresh();
        if (refreshed) return this.getBinary(path, true);
      }
      throw new SalesforceError(`Failed to fetch binary content (HTTP ${res.status})`, res.status);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  /* ── Describe ── */
  async describeObject(sobject: string): Promise<DescribeResult> {
    return this.request<DescribeResult>(`/sobjects/${sobject}/describe`);
  }

  async describeSObjects(): Promise<{ sobjects: { name: string; label: string; labelPlural: string; createable: boolean; queryable: boolean }[] }> {
    return this.request("/sobjects");
  }

  /* ── Bulk / composite CRUD (capped at Salesforce's 200-record composite limit) ── */
  private static readonly COMPOSITE_LIMIT = 200;

  async compositeCreate(
    sobject: string,
    records: Record<string, unknown>[],
    allOrNone = false,
  ): Promise<CompositeResult[]> {
    if (records.length > SalesforceClient.COMPOSITE_LIMIT) {
      throw new Error(`compositeCreate: ${records.length} records exceeds the ${SalesforceClient.COMPOSITE_LIMIT}-record composite limit`);
    }
    if (records.length === 0) return [];
    return this.request<CompositeResult[]>("/composite/sobjects", {
      method: "POST",
      body: JSON.stringify({
        allOrNone,
        records: records.map(r => ({ attributes: { type: sobject }, ...r })),
      }),
    });
  }

  async compositeUpdate(
    sobject: string,
    records: { Id: string; [key: string]: unknown }[],
    allOrNone = false,
  ): Promise<CompositeResult[]> {
    if (records.length > SalesforceClient.COMPOSITE_LIMIT) {
      throw new Error(`compositeUpdate: ${records.length} records exceeds the ${SalesforceClient.COMPOSITE_LIMIT}-record composite limit`);
    }
    if (records.length === 0) return [];
    return this.request<CompositeResult[]>("/composite/sobjects", {
      method: "PATCH",
      body: JSON.stringify({
        allOrNone,
        records: records.map(r => ({ attributes: { type: sobject }, ...r })),
      }),
    });
  }

  /** Best-effort delete: reports success/failure per record rather than failing the whole batch on one bad id. */
  async compositeDelete(ids: string[], allOrNone = false): Promise<CompositeResult[]> {
    if (ids.length === 0) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += SalesforceClient.COMPOSITE_LIMIT) {
      chunks.push(ids.slice(i, i + SalesforceClient.COMPOSITE_LIMIT));
    }
    const results: CompositeResult[] = [];
    for (const chunk of chunks) {
      const qs = `ids=${chunk.join(",")}&allOrNone=${allOrNone}`;
      results.push(...(await this.request<CompositeResult[]>(`/composite/sobjects?${qs}`, { method: "DELETE" })));
    }
    return results;
  }

  /** Generic Connect REST POST — used for platform actions like Instant Pricing. */
  async connectPost<T = unknown>(path: string, body: unknown): Promise<T> {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return this.request<T>(`/connect${normalized}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * §Never lose the real Salesforce response: unlike `request()` (which
   * throws a SalesforceError on non-2xx and discards the raw text on
   * success), this NEVER throws for an HTTP-level response and ALWAYS
   * returns the complete transcript — status, statusText, content-type,
   * the raw response text read exactly once, and the JSON-parsed body
   * when parseable. Built for diagnosing an endpoint whose actual
   * response shape isn't fully known yet (e.g. a Connect/Actions resource
   * that may return an empty per-record error stub, an unexpected
   * envelope shape, or a non-JSON body) — callers that need to SEE what
   * Salesforce really sent, not just get a parsed T, should use this
   * instead of `request()`. Still throws for a genuine network-level
   * failure (fetch itself rejecting) — callers must catch that
   * separately and read `.name`/`.message`/`.cause`, never
   * `JSON.stringify()` the caught error (Error objects serialize to `{}`
   * — `message`/`stack` are non-enumerable own properties).
   */
  async requestWithDiagnostics(path: string, options: RequestInit = {}): Promise<{
    url: string;
    status: number;
    statusText: string;
    contentType: string | null;
    rawText: string;
    json: unknown;
    jsonParseError: string | null;
  }> {
    const url = path.startsWith("http") ? path : `${this.dataApiBase}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
    });
    const rawText = await res.text();
    let json: unknown = null;
    let jsonParseError: string | null = null;
    if (rawText.length > 0) {
      try {
        json = JSON.parse(rawText);
      } catch (err) {
        jsonParseError = err instanceof Error ? err.message : "Failed to parse response as JSON.";
      }
    }
    return {
      url, status: res.status, statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      rawText, json, jsonParseError,
    };
  }

  /* ── Tooling API ── */
  async toolingQuery<T = SalesforceRecord>(soql: string): Promise<QueryResult<T>> {
    return this.request<QueryResult<T>>(
      `${this.toolingApiBase}/query/?q=${encodeURIComponent(soql)}`,
    );
  }

  /* ── Metadata queries via Tooling API ── */
  async listApexClasses(limit = 50) {
    return this.toolingQuery<{ Id: string; Name: string; ApiVersion: number; Status: string; LengthWithoutComments: number }>(
      `SELECT Id, Name, ApiVersion, Status, LengthWithoutComments FROM ApexClass ORDER BY Name LIMIT ${limit}`,
    );
  }

  async listApexTriggers(limit = 50) {
    return this.toolingQuery<{ Id: string; Name: string; TableEnumOrId: string; Status: string }>(
      `SELECT Id, Name, TableEnumOrId, Status FROM ApexTrigger ORDER BY Name LIMIT ${limit}`,
    );
  }

  async listLwcComponents(limit = 50) {
    return this.toolingQuery<{ Id: string; DeveloperName: string; MasterLabel: string; ApiVersion: number }>(
      `SELECT Id, DeveloperName, MasterLabel, ApiVersion FROM LightningComponentBundle ORDER BY DeveloperName LIMIT ${limit}`,
    );
  }

  async listFlows(limit = 50) {
    return this.toolingQuery<{ Id: string; DeveloperName: string; MasterLabel: string; ProcessType: string; Status: string }>(
      `SELECT Id, DeveloperName, MasterLabel, ProcessType, Status FROM FlowDefinition ORDER BY MasterLabel LIMIT ${limit}`,
    );
  }

  async listValidationRules(limit = 50) {
    return this.toolingQuery<{ Id: string; EntityDefinitionId: string; ValidationName: string; Active: boolean }>(
      `SELECT Id, EntityDefinitionId, ValidationName, Active FROM ValidationRule ORDER BY ValidationName LIMIT ${limit}`,
    );
  }

  async listCustomObjects(limit = 50) {
    return this.toolingQuery<{ Id: string; DeveloperName: string; Label: string; DeploymentStatus: string }>(
      `SELECT Id, DeveloperName, Label, DeploymentStatus FROM CustomObject ORDER BY DeveloperName LIMIT ${limit}`,
    );
  }

  async listCustomFields(sobject?: string, limit = 50) {
    const where = sobject ? `WHERE EntityDefinition.QualifiedApiName = '${sobject}' ` : "";
    return this.toolingQuery<{ Id: string; DeveloperName: string; Label: string; DataType: string }>(
      `SELECT Id, DeveloperName, Label, DataType FROM CustomField ${where}ORDER BY DeveloperName LIMIT ${limit}`,
    );
  }

  async listPermissionSets(limit = 50) {
    return this.query<{ Id: string; Name: string; Label: string; IsCustom: boolean; Type: string }>(
      `SELECT Id, Name, Label, IsCustom, Type FROM PermissionSet WHERE IsCustom = true ORDER BY Label LIMIT ${limit}`,
    );
  }

  async listReports(limit = 50) {
    return this.query<{ Id: string; Name: string; FolderName: string; LastRunDate: string }>(
      `SELECT Id, Name, FolderName, LastRunDate FROM Report ORDER BY LastModifiedDate DESC LIMIT ${limit}`,
    );
  }

  async listDashboards(limit = 50) {
    return this.query<{ Id: string; Title: string; FolderName: string; LastModifiedDate: string }>(
      `SELECT Id, Title, FolderName, LastModifiedDate FROM Dashboard ORDER BY LastModifiedDate DESC LIMIT ${limit}`,
    );
  }
}

/* ── Server-side session helpers (only import in API routes, not client components) ── */
export const SESSION_COOKIE = "sf_session";
// 30 days — the access token inside may expire sooner, but the refresh token
// (when present) keeps the session alive transparently up to this window.
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface SFServerSession {
  instanceUrl: string;
  accessToken: string;
  /** Present for OAuth sessions; enables transparent token refresh. */
  refreshToken?: string;
  /** Needed to pick the right login host when refreshing. */
  environment?: "sandbox" | "production";
  /** Connected App creds captured at auth time, so refresh is self-contained. */
  clientId?: string;
  clientSecret?: string;
}

export function encodeSession(session: SFServerSession): string {
  return Buffer.from(JSON.stringify(session)).toString("base64url");
}

export function decodeSession(encoded: string): SFServerSession | null {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SFServerSession;
  } catch {
    return null;
  }
}

/**
 * httpOnly cookie options for the SF session.
 *
 * sameSite is "lax", not "strict": this cookie must be present when the
 * browser lands back on this app via a cross-site top-level redirect (e.g.
 * DocuSign's OAuth callback at /api/contracts/docusign/callback). Strict
 * withholds cookies on any cross-site navigation, including redirects, which
 * broke that flow entirely. Lax still omits the cookie on cross-site POSTs
 * and on fetch/XHR/iframe requests of any method, which is what actually
 * matters for CSRF — every state-changing route in this app is POST-only.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/**
 * Build a SalesforceClient from a stored session, wiring up transparent OAuth
 * refresh when a refresh token + Connected App credentials are available.
 * Pass `onRefreshed` to capture the new access token and persist it to the cookie.
 */
export function clientFromSession(
  session: SFServerSession,
  opts: { apiVersion?: string; onRefreshed?: (token: string) => void } = {},
): SalesforceClient {
  const clientId = session.clientId ?? process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = session.clientSecret ?? process.env.SALESFORCE_CLIENT_SECRET;
  const refresh: RefreshConfig | undefined =
    session.refreshToken && clientId && clientSecret
      ? {
          refreshToken: session.refreshToken,
          clientId,
          clientSecret,
          loginBase:
            session.environment === "production"
              ? "https://login.salesforce.com"
              : "https://test.salesforce.com",
          onRefreshed: opts.onRefreshed,
        }
      : undefined;
  return new SalesforceClient(
    session.instanceUrl,
    session.accessToken,
    opts.apiVersion ?? SF_API_VERSION,
    refresh,
  );
}
