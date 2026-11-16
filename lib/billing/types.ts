import type { AppModuleLink, BillingGroupId } from "@/lib/billing/registry";

/** One field of a billing object, exactly as the connected org's Describe reports it (plus derived `required`). */
export interface BillingFieldMeta {
  name: string;
  label: string;
  type: string;
  /** Createable + not nillable + not defaulted on create (booleans excluded — they always have a value). */
  required: boolean;
  createable: boolean;
  updateable: boolean;
  nillable: boolean;
  defaultedOnCreate: boolean;
  isNameField: boolean;
  length: number | null;
  precision: number | null;
  scale: number | null;
  helpText: string | null;
  picklistValues: { value: string; label: string; isDefault: boolean; validFor?: string }[];
  restrictedPicklist: boolean;
  controllerName: string | null;
  referenceTo: string[];
  relationshipName: string | null;
  /** Billing module key for each reference target, when that target is itself a billing module (drives in-app links). */
  referenceModules: Record<string, string>;
  calculated: boolean;
  custom: boolean;
  system: boolean;
}

export interface BillingChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  /** Billing module key when the child object is itself a billing module. */
  moduleKey: string | null;
}

/** The discovered, org-specific shape of one billing module. */
export interface BillingModuleSchema {
  moduleKey: string;
  sobject: string;
  label: string;
  labelPlural: string;
  createable: boolean;
  updateable: boolean;
  queryable: boolean;
  nameField: string | null;
  statusField: string | null;
  fields: BillingFieldMeta[];
  childRelationships: BillingChildRelationship[];
  /** Resolved list columns (registry concept → real field). */
  columns: { id: string; label: string; field: string; type: string; referenceTo: string[] }[];
  /** Child modules available for inline creation, each with the child's reference field back to this parent. */
  children: { moduleKey: string; label: string; singular: string; sobject: string; parentField: string }[];
  /** Opt-in "also link" updates validated against the org (target field exists, is updateable, points at the right object). */
  inboundLinks: { sobject: string; field: string; fieldLabel: string; valueSource: "self" | { field: string }; label: string; appModule?: AppModuleLink }[];
  apiVersion: string;
}

/** Per-module discovery result, as used by the dashboard and "Inspect Salesforce Configuration". */
export interface BillingModuleStatus {
  moduleKey: string;
  group: BillingGroupId;
  available: boolean;
  sobject: string | null;
  sobjectLabel: string | null;
  candidatesTried: string[];
  createable: boolean;
  queryable: boolean;
  recordCount: number | null;
  statusBreakdown: { status: string; count: number }[] | null;
  lastModifiedDate: string | null;
  /** Why the count/breakdown couldn't be loaded, when it couldn't — never a fabricated zero. */
  countError: string | null;
}

export interface BillingStatsResponse {
  success: true;
  modules: BillingModuleStatus[];
  apiVersion: string;
  generatedAt: string;
}

export interface BillingReferenceValue {
  id: string;
  name: string;
  sobject: string;
  /** Billing module key when the referenced object is a billing module. */
  moduleKey?: string | null;
}

/** One list/history row: raw field values plus display-ready names for reference columns. */
export interface BillingRecordRow {
  id: string;
  name: string;
  status: string | null;
  createdDate: string | null;
  lastModifiedDate: string | null;
  createdByName: string | null;
  values: Record<string, unknown>;
  references: Record<string, BillingReferenceValue | null>;
  /** Records on ANOTHER object that point at this one via a supported link (e.g. Products whose BillingPolicyId = this policy). */
  linked?: { id: string; name: string }[];
}

export interface BillingListResponse {
  success: true;
  records: BillingRecordRow[];
  totalSize: number;
  soql: string;
  columns: BillingModuleSchema["columns"];
  nameField: string | null;
  statusField: string | null;
  /** Set when rows carry `linked` records — the column label (e.g. "Product") and the Salesforce field behind it. */
  linkedColumn?: { label: string; relation: string } | null;
}

export type BillingDetailSectionId = "basic" | "relationships" | "configuration" | "salesforce";

export interface BillingDetailField {
  name: string;
  label: string;
  type: string;
  value: unknown;
  reference: BillingReferenceValue | null;
  section: BillingDetailSectionId;
}

export interface BillingDetailResponse {
  success: true;
  moduleKey: string;
  sobject: string;
  id: string;
  name: string;
  status: string | null;
  fields: BillingDetailField[];
  children: { moduleKey: string | null; label: string; sobject: string; field: string; records: { id: string; name: string; status: string | null }[]; totalSize: number }[];
  salesforceUrl: string;
}

/** A record the user is about to create — plain field values plus lookups resolved to real Salesforce Ids. */
export interface BillingDraftRecord {
  /** Client-side key so the UI can track/remove child rows. Never sent to Salesforce. */
  key: string;
  moduleKey: string;
  /**
   * Set ONLY for an edit: the Salesforce Id of the existing record being updated. Always taken
   * from the record the user opened (route param) — the server rejects a draft whose recordId
   * doesn't match the URL, and never takes one from AI output.
   */
  recordId?: string;
  fields: Record<string, unknown>;
  references: Record<string, BillingReferenceValue | null>;
  /** AI-extracted names that did not resolve to exactly one record — shown for the user to pick/correct. */
  unresolved?: Record<string, { searchedName: string; sobject: string; candidates: BillingReferenceValue[] }>;
  /**
   * Lookup field → `key` of one of THIS record's children being created in the same request
   * (e.g. a new Billing Policy's DefaultBillingTreatmentId → the new treatment below it). Filled in
   * with the real Id right after insert, inside the same all-or-nothing transaction.
   */
  childReferences?: Record<string, string>;
  children: BillingDraftRecord[];
}

export interface BillingDraftLink {
  key: string;
  sobject: string;
  field: string;
  label: string;
  valueSource: "self" | { field: string };
  targets: BillingReferenceValue[];
  enabled: boolean;
  /**
   * Edit mode only ("set" semantics): the records that point at this record in Salesforce RIGHT
   * NOW. `targets` is the desired set — targets not in here get linked, entries missing from
   * `targets` get unlinked (field set to null). Loaded from Salesforce, never from local state.
   */
  originalTargets?: BillingReferenceValue[];
}

/** One field or relationship change an update would make, for the "Changes to Save" summary. */
export interface BillingChange {
  kind: "field" | "reference" | "link" | "unlink";
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

export type BillingIssueSeverity = "error" | "warning" | "info";

export interface BillingValidationIssue {
  severity: BillingIssueSeverity;
  /** Record path in the draft tree: "" = root, "0" = first child, "0.1" = second grandchild of the first child. */
  path: string;
  moduleKey: string;
  field: string | null;
  message: string;
}

/** One Salesforce record the configuration depends on, and whether it was actually found. */
export interface BillingResolvedReference {
  path: string;
  field: string | null;
  label: string;
  name: string;
  sobject: string;
  status: "found" | "inactive" | "missing" | "unresolved" | "new";
  detail?: string;
}

export interface BillingValidationResult {
  valid: boolean;
  issues: BillingValidationIssue[];
  checks: { id: string; label: string; status: "passed" | "warning" | "failed" | "skipped"; detail?: string }[];
  references: BillingResolvedReference[];
  /** Update validation only: what would change in Salesforce. */
  changes?: BillingChange[];
  /** Update validation only: the Status transition being requested, and whether Salesforce will accept it. */
  transition?: { field: string; from: string | null; to: string | null; ready: boolean; blockers: string[] } | null;
}

/** A related record shown (read-only) on the edit page, e.g. a Treatment's Treatment Items. */
export interface BillingRelatedRecord {
  id: string;
  name: string;
  moduleKey: string | null;
  sobject: string;
  status: string | null;
  summary: { label: string; value: string }[];
}

/** Everything the edit page needs, loaded fresh from Salesforce for one existing record. */
export interface BillingEditContext {
  success: true;
  moduleKey: string;
  recordId: string;
  name: string;
  status: string | null;
  /** The record's current values in the SAME draft shape the create form uses. */
  draft: BillingDraftRecord;
  /** Opt-in links in "set" mode (e.g. Products whose BillingPolicyId points at this policy). */
  links: BillingDraftLink[];
  /** Fields the user can't change right now, with the Salesforce reason (not updateable, or locked by a platform rule). */
  locks: Record<string, string>;
  /** Whole-record lock (e.g. an item whose treatment is no longer Draft) — null when editable. */
  recordLock: string | null;
  related: { title: string; relation: string; moduleKey: string | null; records: BillingRelatedRecord[]; note?: string }[];
  /** Module-specific configuration state shown on the edit page (e.g. the one-item rule for treatments). */
  health: { status: "ok" | "warning" | "error"; message: string }[];
  salesforceUrl: string;
  lastModifiedDate: string | null;
}

export interface BillingUpdateResponse {
  success: true;
  id: string;
  name: string;
  changes: BillingChange[];
  salesforceUrl: string;
  validation: BillingValidationResult;
}

export interface BillingCreateResponse {
  success: true;
  root: { id: string; name: string; sobject: string; salesforceUrl: string };
  created: { path: string; id: string; sobject: string; name: string; salesforceUrl: string }[];
  links: { sobject: string; field: string; recordId: string; recordName: string }[];
  validation: BillingValidationResult;
}

/** A single step in the AI analysis pipeline, so the UI can show exactly how a prompt was interpreted. */
export interface BillingAnalysisStep {
  id: "intent" | "object" | "fields" | "relationships" | "validation" | "config";
  label: string;
  status: "done" | "warning" | "failed";
  detail: string;
}

export interface BillingAnalysisResult {
  success: true;
  intent: "create" | "update" | "unsupported";
  /** Set for an edit analysis — the existing record the changes apply to (from the route, never from the AI). */
  recordId?: string | null;
  /** Edit analysis only: the structured changes the AI requested, after Salesforce resolution. */
  changes?: BillingChange[];
  moduleKey: string;
  objectType: string;
  confidence: number;
  summary: string;
  /** Set when the prompt describes a different (available) billing module than the one being created. */
  suggestedModuleKey: string | null;
  warnings: string[];
  assumptions: string[];
  draft: BillingDraftRecord;
  links: BillingDraftLink[];
  validation: BillingValidationResult;
  pipeline: BillingAnalysisStep[];
  /** Product named in the prompt, resolved in Salesforce, plus its current billing chain (Product → Billing Policy → Default Treatment). */
  context: {
    productName: string | null;
    product: BillingReferenceValue | null;
    productBillingPolicy: BillingReferenceValue | null;
    productDefaultTreatment: BillingReferenceValue | null;
  };
  /** Every name the AI mentioned that didn't resolve to exactly one Salesforce record, with a "create it here" option where possible. */
  unresolvedReferences: {
    path: string;
    field: string | null;
    label: string;
    searchedName: string;
    sobject: string;
    candidates: BillingReferenceValue[];
    /** Child module that can be created inline under this record to satisfy the lookup. */
    createAsChildModule: string | null;
  }[];
  /** The raw structured JSON Claude returned, for the technical details panel. */
  rawAi: unknown;
}

export interface BillingFriendlyError {
  error: string;
  code: string | null;
  possibleCause: string | null;
  technical: unknown;
}
