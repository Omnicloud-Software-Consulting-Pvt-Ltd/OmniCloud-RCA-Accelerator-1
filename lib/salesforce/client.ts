export const SF_API_VERSION = "v60.0";

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
}

export interface DescribeField {
  name: string;
  label: string;
  type: string;
  length?: number;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  picklistValues?: { value: string; label: string; active: boolean }[];
}

export interface OrgLimits {
  [key: string]: { Max: number; Remaining: number };
}

/* ── Error class ── */
export class SalesforceError extends Error {
  status: number;
  errorCode?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = "SalesforceError";
    this.status = status;
    this.body = body;
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

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // Access token expired → refresh once and retry transparently.
      if (res.status === 401 && !_retried && this.refresh) {
        const refreshed = await this.tryRefresh();
        if (refreshed) return this.request<T>(path, options, true);
      }
      const message = Array.isArray(body)
        ? (body[0]?.message ?? res.statusText)
        : (body?.message ?? body?.error_description ?? res.statusText);
      throw new SalesforceError(message, res.status, body);
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

  /* ── Describe ── */
  async describeObject(sobject: string): Promise<DescribeResult> {
    return this.request<DescribeResult>(`/sobjects/${sobject}/describe`);
  }

  async describeSObjects(): Promise<{ sobjects: { name: string; label: string; labelPlural: string; createable: boolean; queryable: boolean }[] }> {
    return this.request("/sobjects");
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

/** httpOnly cookie options for the SF session. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
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
