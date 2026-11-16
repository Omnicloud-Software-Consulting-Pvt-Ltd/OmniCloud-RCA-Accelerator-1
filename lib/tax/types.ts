/**
 * Tax Management — types shared by the server (lib/tax/server) and the UI (components/data/billing/tax).
 *
 * A TaxConfigSpec is the ONE internal representation both creation modes produce (AI prompt → spec, Manual form → spec). It
 * holds names, rates and codes as the user expressed them; Salesforce Ids appear only when the user picked a record from a
 * Salesforce-backed picker. Nothing in a spec is trusted: the planner resolves every record, field, picklist value and
 * relationship against the connected org's metadata before anything is written.
 */

/** A record the user referred to: picked from Salesforce (id) or named (name / product code). */
export interface RecordRef { id?: string | null; name?: string | null }

export interface TaxEngineSpec {
  /** Use this existing TaxEngine (manual picker). */
  existingId?: string | null;
  name?: string | null;
  /** TaxEngine.Type picklist value (validated against the org), e.g. the native Revenue Standard Tax value. */
  type?: string | null;
  providerId?: string | null;
  namedCredentialId?: string | null;
  sellerCode?: string | null;
  address?: { street?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null } | null;
}

export interface TaxTreatmentSpec {
  /** Local key that items and product mappings refer to. */
  key: string;
  existingId?: string | null;
  /** Name the user gave; when absent the planner reuses an equivalent treatment or derives a name. */
  name?: string | null;
  suggestedName?: string | null;
  description?: string | null;
  taxable: boolean;
  /** Tax code as the user gave it (resolved against the org's TaxRate codes). */
  taxCode?: string | null;
  /** Tax name ("GST", "VAT") — used only to derive a code when none was given. */
  taxName?: string | null;
  /** Rate in percent (18 → 18%); 0 = zero-rated (taxable at 0%, not exempt). */
  rate?: number | null;
  /** Treatment-level legal entity (Legal Entity selection). Defaults to the configuration's legal entity. */
  legalEntity?: RecordRef | null;
  /** Resolve tax per product through Tax Treatment Items. */
  useItems?: boolean;
  /** The policy's default treatment. */
  isDefault?: boolean;
}

export interface TaxItemSpec {
  treatmentKey: string;
  product: RecordRef;
  name?: string | null;
  taxCode?: string | null;
  taxName?: string | null;
  rate?: number | null;
}

export interface TaxProductMappingSpec { product: RecordRef }

export interface TaxConfigSpec {
  engine?: TaxEngineSpec | null;
  legalEntity?: RecordRef | null;
  /** Country the tax rates apply to (ISO-2 or name). */
  country?: string | null;
  policy: { existingId?: string | null; name?: string | null; suggestedName?: string | null; description?: string | null; treatmentSelection?: string | null };
  treatments: TaxTreatmentSpec[];
  items: TaxItemSpec[];
  /** Products whose Product2 tax policy is set to this policy (products named on items are added automatically). */
  products: TaxProductMappingSpec[];
  /**
   * productCodeMode — the Product Code new Tax Rates carry. "product" (default): one rate per product, keyed to Product2.ProductCode
   * (what Salesforce matches — E1-B / E1c). "blank": ONE rate with a blank Product Code that matches every product using the tax
   * code in that geography — only when explicitly requested (proven for treatments without items, E2; overlaps are blocked).
   */
  rateDefaults?: { startDate?: string | null; endDate?: string | null; productCodeMode?: "product" | "blank" | null } | null;
}

/* ───────────────────────────── Metadata ───────────────────────────── */

export interface FieldMeta {
  name: string; label: string; type: string;
  required: boolean; createable: boolean; updateable: boolean; nillable: boolean;
  picklist: { value: string; label: string }[];
  referenceTo: string[];
  /** Describe's own flags: the record-name field, and whether Salesforce enforces uniqueness / external Id. */
  nameField?: boolean; unique?: boolean; externalId?: boolean;
}
export interface ObjectMeta { name: string; label: string; exists: true; createable: boolean; updateable: boolean; queryable: boolean; deletable?: boolean; fields: Record<string, FieldMeta> }
export interface MissingObject { name: string; exists: false; reason: string }
export interface TaxMetadata {
  apiVersion: string;
  objects: Record<string, ObjectMeta | MissingObject>;
  /** Every tax-related sObject the org exposes (for diagnostics when an expected one is missing). */
  availableTaxObjects: string[];
  /** Relationship fields discovered from the metadata, e.g. "TaxTreatment→TaxPolicy": "TaxPolicyId". */
  relationships: Record<string, string | null>;
  problems: string[];
}

/* ───────────────────────────── Records ───────────────────────────── */

export interface Named { id: string; name: string }
export interface TaxEngineRow { id: string; name: string; type: string | null; status: string | null; provider: Named | null; sellerCode: string | null; native: boolean; decisionTableId: string | null }
export interface TaxProviderRow { id: string; name: string; developerName: string | null }
export interface TaxPolicyRow { id: string; name: string; status: string | null; selection: string | null; defaultTreatmentId: string | null; description: string | null; products: number }
export interface TaxTreatmentRow { id: string; name: string; status: string | null; taxable: boolean; taxCode: string | null; productCode: string | null; policyId: string | null; engineId: string | null; legalEntityId: string | null; useItems: boolean }
export interface TaxItemRow { id: string; name: string; treatmentId: string | null; productId: string | null; productName: string | null; taxCode: string | null; productCode: string | null }
export interface TaxRateRow { id: string; name: string; taxCode: string | null; productCode: string | null; rate: number | null; usage: string | null; country: string | null; geoCountryId: string | null; legalEntityId: string | null; start: string | null; end: string | null; effective: boolean; lastModified: string | null;
  /** Decision-table dimensions beyond country (absent when the org doesn't expose the field). */
  state?: string | null; city?: string | null; zipCode?: string | null; basis?: string | null; priority?: number | null }
export interface LegalEntityRow { id: string; name: string; status: string | null; country: string | null }
export interface GeoCountryRow { id: string; name: string; iso: string }
export interface ProductRow { id: string; name: string; code: string | null; active: boolean; taxPolicyId: string | null; family: string | null }
/** A product in the verification lookup: `taxable` = its tax policy resolves to an active taxable treatment (Tax Dashboard rule). */
export interface TaxProductOption extends ProductRow { policyName: string | null; taxable: boolean }
/** One keyset page of the lookup; `nextCursor` is opaque and null on the last page. */
export interface TaxProductPage { products: TaxProductOption[]; nextCursor: string | null }

/** Objects the tax pages' SalesforceLookup searches (one endpoint: /api/taxes/lookup). */
export type TaxLookupObject = "Account" | "Contact" | "Product2" | "Invoice" | "GeoCountry" | "GeoState";
/** One record in a lookup: always a real Salesforce record (`id`), with the object-specific facts the form needs. */
export interface LookupOption {
  id: string; label: string;
  /** Identifying code shown beside the label: Product Code, ISO code, Account Number, invoice status. */
  code: string | null;
  detail: string | null;
  badge: { text: string; tone: "ok" | "warn" | "dim" } | null;
  facts?: Record<string, string | number | boolean | null>;
}
export interface LookupPage { options: LookupOption[]; nextCursor: string | null }

export interface TaxConnection { orgId: string | null; orgName: string | null; orgType: string | null; isSandbox: boolean | null; instanceUrl: string; userId: string | null; username: string | null; displayName: string | null }

export interface TaxDashboard {
  success: true;
  connection: TaxConnection;
  apiVersion: string;
  engines: TaxEngineRow[]; providers: TaxProviderRow[]; policies: TaxPolicyRow[]; treatments: TaxTreatmentRow[]; items: TaxItemRow[]; rates: TaxRateRow[];
  legalEntities: LegalEntityRow[]; taxableProducts: ProductRow[];
  stats: { activeEngines: number; activePolicies: number; activeTreatments: number; taxableTreatments: number; items: number; effectiveRates: number; productsWithPolicy: number; taxedInvoices: number | null };
  /** Configuration vs calculation readiness, kept apart. */
  status: { configuration: "READY" | "INCOMPLETE" | "NOT CONFIGURED"; configurationDetail: string; calculation: "READY" | "BLOCKED" | "UNKNOWN"; calculationDetail: string };
  missingObjects: MissingObject[];
}

/* ───────────────────────────── Plan ───────────────────────────── */

export type StepAction = "reuse" | "create" | "update" | "blocked";
export type StepPhase = "create" | "activate" | "map";
export interface PlanStep {
  id: string;
  phase: StepPhase;
  object: string;
  label: string;
  action: StepAction;
  /** The existing Salesforce record (reuse/update), else null. */
  recordId: string | null;
  /** Payload sent to Salesforce; values "@{stepId}" are replaced with that step's record Id at execution time. */
  fields: Record<string, unknown>;
  dependsOn: string[];
  detail: string;
  /** Field values the verification expects on the record afterwards ("@{stepId}" allowed). */
  expect: Record<string, unknown>;
}
export interface PlanIssue { severity: "error" | "warning" | "info"; code: string; object?: string; field?: string; message: string; action?: string }
export interface PlanSummaryRow { object: string; label: string; action: StepAction; recordId: string | null; detail: string }
export interface TaxPlan {
  success: true;
  ok: boolean;
  connection: TaxConnection;
  apiVersion: string;
  spec: TaxConfigSpec;
  resolved: {
    engine: Named & { type: string | null } | null;
    legalEntity: Named | null;
    country: { iso: string; name: string; geoCountryId: string | null } | null;
    policy: { id: string | null; name: string; selection: string; status: string | null };
    treatments: { key: string; id: string | null; name: string; taxable: boolean; taxCode: string | null; rate: number | null; useItems: boolean; legalEntity: Named | null; isDefault: boolean }[];
    items: { treatmentKey: string; product: Named & { code: string | null }; taxCode: string | null; rate: number | null }[];
    products: (Named & { code: string | null; currentPolicy: Named | null })[];
    taxCodes: { code: string; rate: number | null; exists: boolean; country: string | null }[];
  };
  steps: PlanStep[];
  issues: PlanIssue[];
  counts: { create: number; reuse: number; update: number; blocked: number };
  summary: PlanSummaryRow[];
  /** Field-level preview metadata from the org's describe: label, type and lookup target of every field a step writes. */
  fieldInfo: Record<string, Record<string, { label: string; type: string; referenceTo: string[] }>>;
  /** The plan creates Tax Rates: the engine's decision table must be refreshed (an explicit, approved step) before any invoice. */
  refreshRequired?: boolean;
  /** Display names of existing Salesforce records referenced by step values (Id → name), for the preview. */
  refNames: Record<string, string>;
  token: string;
}

/* ───────────────────────────── Execution & verification ───────────────────────────── */

export interface StepOutcome {
  stepId: string; object: string; label: string;
  status: "created" | "reused" | "updated" | "failed" | "not-run" | "rolled-back";
  recordId: string | null;
  error?: { message: string; code: string | null; field: string | null; recommendation: string } | null;
}
export interface VerificationCheck { id: string; object: string; label: string; recordId: string | null; passed: boolean; detail: string }
export interface TaxExecutionReport {
  success: boolean;
  connection: TaxConnection;
  outcome: "CREATED" | "UPDATED" | "NOTHING TO CREATE" | "PARTIAL" | "FAILED" | "STALE";
  message: string;
  steps: StepOutcome[];
  failure: { phase: StepPhase; object: string; label: string; field: string | null; code: string | null; message: string; recommendation: string; recordId: string | null } | null;
  verification: { passed: boolean; checks: VerificationCheck[] } | null;
  /** Configuration success is never reported as calculation success. */
  calculation: "NOT VERIFIED";
  plan: TaxPlan;
}

/* ───────────────────────────── Tax Configuration Assistant (operations) ───────────────────────────── */

export type AssistantOpKind = "create" | "update" | "assign" | "activate" | "deactivate" | "draft" | "end-date" | "replace" | "delete" | "show" | "configure";

/** How an operation names an existing record — names/codes only (an Id only when the user picked a record in the UI). */
export interface RecordSelector {
  id?: string | null; name?: string | null;
  taxCode?: string | null; rate?: number | null; country?: string | null; isoCode?: string | null;
  productName?: string | null; treatmentName?: string | null; policyName?: string | null;
}

export interface AssistantOperation {
  key: string;
  op: AssistantOpKind;
  /** Salesforce API name of the object the operation is about (validated against the Taxes objects). */
  object: string;
  /** The existing record (update / assign source / lifecycle / delete / show). */
  target?: RecordSelector | null;
  /** Field values (create / update), keyed by API name or label; a reference value is a RecordSelector or a name. */
  fields?: Record<string, unknown> | null;
  /** ASSIGN: the record to relate the target to. The field is chosen from metadata (kind is only a hint, e.g. "default"). */
  relation?: { object: string; target: RecordSelector; kind?: string | null; field?: string | null } | null;
  /** END-DATE / REPLACE: the date (YYYY-MM-DD). */
  date?: string | null;
  /** CONFIGURE: a whole multi-record configuration — handled by the existing planner/executor. */
  configure?: TaxConfigSpec | null;
}

export interface AssistantRequest { operations: AssistantOperation[]; selections?: Record<string, string> | null }

export interface OpChange {
  field: string; label: string; type: string; referenceTo: string[];
  current: unknown; currentDisplay: string | null;
  next: unknown; nextDisplay: string | null;
  updateable: boolean; createable: boolean;
}
export interface OpStep {
  id: string; opKey: string;
  kind: "create" | "update" | "delete" | "replace-rate";
  object: string;
  /** Existing record, or "@{stepId}" for a record created earlier in the same request. */
  recordId: string | null;
  recordName: string;
  fields: Record<string, unknown>;
  changes: OpChange[];
  detail: string;
  /** Replace-rate steps: the rate replacement input. */
  replacement?: { effectiveDate: string; changes: Record<string, unknown> } | null;
}
export type OpStatus = "ready" | "exists" | "needs-selection" | "blocked" | "no-change" | "info";
export interface OpPreview {
  key: string; op: AssistantOpKind; object: string; objectLabel: string;
  status: OpStatus;
  record: { id: string | null; name: string; status: string | null } | null;
  /** Ambiguity: choose one of these (the selection is sent back under selectionKey). */
  choices?: { selectionKey: string; prompt: string; options: { id: string; name: string; detail: string }[] }[];
  relationship?: { sourceObject: string; sourceRecord: string; field: string; fieldLabel: string; targetObject: string; targetRecord: string; updatedObject: string } | null;
  dependencies: { label: string; count: number; detail: string; cascade?: boolean }[];
  steps: OpStep[];
  issues: PlanIssue[];
  /** Follow-up operations offered to the user (e.g. "it already exists — activate it?"). */
  offers?: { label: string; operation: AssistantOperation }[];
  /** SHOW: the record's current configuration. */
  view?: { fields: { label: string; value: string }[]; related: { label: string; rows: string[] }[] } | null;
  /** Records with a Status: the status before this request and the status changes it makes (empty = none required). */
  lifecycle?: { current: string | null; changes: string[] } | null;
}
export interface AssistantPreview {
  success: true; ok: boolean;
  connection: TaxConnection;
  operations: OpPreview[];
  needsSelection: boolean;
  token: string;
}
export interface AuditEntry {
  operation: string; object: string; recordName: string; recordId: string | null;
  fields: { field: string; label: string; before: string | null; after: string | null }[];
  timestamp: string;
  result: "success" | "failed" | "verification-failed" | "not-run";
  message: string;
}
export interface AssistantResult {
  success: boolean; message: string;
  audit: AuditEntry[];
  failure: { step: string; object: string; code: string | null; field: string | null; message: string; recommendation: string } | null;
  preview: AssistantPreview;
}
