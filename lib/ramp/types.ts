/**
 * RAMP MANAGEMENT — domain model (client + server safe; no Salesforce imports).
 *
 * What is Salesforce-native and what is application-managed (verified read-only in p10 / p12, API v68, 2026-11-09):
 *  · ProductRampSegment — a Salesforce record (ProductId, ProductSellingModelId, SegmentType, TrialDuration, DurationType).
 *  · Line ramp — Salesforce segment QuoteLineItems sharing a RampIdentifier, created by the Ramp Deal API
 *    (…/sales-transaction-contexts/{lineId}/actions/ramp-deal-create) and committed by Place Sales Transaction.
 *  · Group ramp — a series of QuoteLineGroups with IsRamped = true (one per segment, SortOrder 1..n), created by Place Sales
 *    Transaction groupRampAction "EditGroup" (first segment) + Clone Sales Transaction (lineScope AllLines) for the next ones.
 *  · Ramp schedule — NO Salesforce object exists (no RampSchedule / RampDeal sObject in either org). A schedule is an
 *    APPLICATION template; in Salesforce it only exists as the segment dates of the lines / ramped groups it produces.
 *  · Ramp deal / execution / history — APPLICATION records (server-side store), always linked to the Salesforce Ids they produced.
 */

export type PeriodUnit = "Monthly" | "Quarterly" | "Yearly" | "Custom";
/** Salesforce QuoteLineItem / QuoteLineGroup RampUpliftType values. */
export type UpliftMethod = "Standard" | "Compound";
/** How a segment's price is described in a schedule; Salesforce itself only takes a percentage uplift (UnitPriceUplift). */
export type PriceChangeKind = "none" | "percent" | "fixed" | "price";

export interface SchedulePeriodOverride {
  /** 1-based segment number. */
  segment: number;
  /** Percent uplift for this segment (percent kind), amount added (fixed), or the segment's unit price (price). */
  value: number | null;
  quantity?: number | null;
  discount?: number | null;
}

/** Application-managed reusable ramp schedule template. */
export interface RampSchedule {
  id: string;
  name: string;
  description: string | null;
  period: PeriodUnit;
  /** Months per segment when period = Custom. */
  customMonths: number | null;
  /** Number of segments (the last one may be shorter — prorated — when the contract doesn't divide evenly). */
  segments: number;
  /** Optional free-trial segment before the paid segments. */
  trialMonths: number | null;
  priceChange: PriceChangeKind;
  /** Default change applied to every segment after the first (percent / fixed); overrides win. */
  defaultChange: number | null;
  upliftMethod: UpliftMethod;
  /** Multiplies the base price before uplifts (preview + conversion only; Salesforce has no such field). */
  basePriceMultiplier: number;
  overrides: SchedulePeriodOverride[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  version: number;
}

export interface GeneratedSegment {
  index: number;
  name: string;
  kind: "trial" | "full" | "prorated";
  startDate: string;
  endDate: string;
  months: number;
  /** Uplift in percent to send to Salesforce (UnitPriceUplift) — relative to the base price (standard) or the previous segment (compound). */
  upliftPercent: number;
  /** Where the uplift came from: a per-segment override, the schedule default, nothing configured (sent as 0 — warned), the first
   *  segment (0 unless overridden), a free trial, "no change", or a price-based conversion. */
  upliftSource?: "override" | "default" | "unset" | "first" | "trial" | "none" | "price";
  quantity: number;
  discount: number;
  /** Preview only — what the uplift implies for the unit price. Salesforce's pricing decides the real price. */
  previewUnitPrice: number;
  previewTotal: number;
}

export interface ScheduleInput {
  contractStart: string;
  contractEnd: string;
  basePrice: number;
  baseQuantity: number;
  /** Group ramp: QuoteLineGroup has no quantity — per-segment quantity overrides are not applied (and are warned about). */
  ignoreQuantityOverrides?: boolean;
}

export interface SchedulePreview {
  segments: GeneratedSegment[];
  totalMonths: number;
  issues: { severity: "error" | "warning"; message: string }[];
  previewTotal: number;
}

export type DealKind = "line" | "group";

export interface RampDealDraft {
  id: string;
  kind: DealKind;
  name: string;
  accountId: string | null;
  accountName: string | null;
  quoteId: string | null;
  quoteName: string | null;
  /** Line ramp: the base QuoteLineItem. */
  lineId: string | null;
  /** Group ramp: the QuoteLineGroup that becomes the first segment. */
  groupId: string | null;
  groupName: string | null;
  productId: string | null;
  productName: string | null;
  sellingModelId: string | null;
  scheduleId: string | null;
  /** The schedule as applied to THIS deal (copied from the template, then edited). */
  schedule: Omit<RampSchedule, "id" | "createdAt" | "updatedAt" | "createdBy" | "version">;
  contractStart: string;
  contractEnd: string;
  basePrice: number;
  baseQuantity: number;
  /** Salesforce QuoteLineItem.PeriodBoundary to set on segment lines that have none (pricing needs one). */
  periodBoundary: "Anniversary" | "AlignToCalendar" | "DayOfPeriod" | "LastDayOfPeriod";
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  orgId: string;
  executionId: string | null;
}

export type StepId =
  | "validate" | "stage" | "commit" | "convert-group" | "clone-segments" | "edit-schedule" | "segment-values"
  | "read-back" | "price" | "verify";
export type StepStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";
export type ExecutionStatus = "pending" | "in-progress" | "waiting" | "completed" | "failed" | "interrupted";

export interface SalesforceCall { at: string; method: string; path: string; request?: unknown; status: number; response: unknown; requestId?: string | null }

export interface ExecutionStep {
  id: StepId;
  label: string;
  status: StepStatus;
  message: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Attempts so far (resume / retry). */
  attempts: number;
  /** Did this step send a Salesforce write (so a retry must re-check before writing again)? */
  wrote: boolean;
  calls: SalesforceCall[];
}

export interface VerificationCheck { id: string; label: string; passed: boolean; expected: string | null; actual: string | null; severity: "error" | "info" }

export interface SegmentResult {
  id: string;
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  quantity: number | null;
  discount: number | null;
  unitPriceUplift: number | null;
  appliedUpliftPct: number | null;
  rampUpliftType: string | null;
  unitPrice: number | null;
  netUnitPrice: number | null;
  netTotalPrice: number | null;
  groupId: string | null;
  productId: string | null;
  /** Salesforce QuoteLineItem.RampIdentifier (shared by one product's lines across a ramp's segments). */
  rampIdentifier?: string | null;
}

export interface RampExecution {
  id: string;
  dealId: string;
  kind: DealKind;
  orgId: string;
  status: ExecutionStatus;
  steps: ExecutionStep[];
  /** Salesforce artifacts discovered / produced so far — the resume state. */
  sf: {
    quoteId: string | null;
    lineId: string | null;
    groupId: string | null;
    contextId: string | null;
    rampIdentifier: string | null;
    segmentGroupIds: string[];
    segmentLineIds: string[];
    asyncRequestIds: string[];
    priceRequestedAt: string | null;
    /** Group ramp: every QuoteLineGroup on the quote when the run started — segments are the converted group + groups created after. */
    baselineGroupIds?: string[];
  };
  segments: SegmentResult[];
  quote: { calculationStatus: string | null; lastPricedDate: string | null } | null;
  verification: VerificationCheck[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export type HistoryKind = "product-segment" | "schedule" | "deal" | "group-deal" | "execution" | "pricing" | "verification";
export interface HistoryEvent {
  id: string;
  at: string;
  kind: HistoryKind;
  action: string;
  status: "success" | "failed" | "info";
  summary: string;
  orgId: string;
  userId: string | null;
  refs: { dealId?: string | null; executionId?: string | null; scheduleId?: string | null; quoteId?: string | null; accountId?: string | null; productId?: string | null; lineId?: string | null; groupId?: string | null; salesforceId?: string | null };
  detail?: unknown;
}
