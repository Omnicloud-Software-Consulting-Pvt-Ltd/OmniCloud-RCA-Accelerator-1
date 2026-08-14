/**
 * §Schema-driven native record creation — the ONE generic implementation
 * every native object (PriceAdjustmentSchedule, AttributeBasedAdjRule,
 * AttributeAdjustmentCondition, AttributeBasedAdjustment) uses for lookup
 * discovery and required-field validation. Replaces what used to be a
 * sequence of object-specific resolvers (a Product2 resolver for this
 * object, a SellingModel resolver for that one, ad hoc dual-strategy
 * fallbacks per field) — fixing one object's lookup bug kept exposing the
 * next object's version of the exact same bug, because each one had its
 * own copy of the logic. There is now exactly one copy.
 *
 * Nothing in this file ever hardcodes a Salesforce API name like
 * ProductId/Product2Id/SellingModelId/PriceAdjustmentScheduleId/
 * AttributeBasedAdjRuleId — every field this resolves comes from that
 * object's own Describe response, matched purely by Salesforce's actual
 * relationship metadata (`referenceTo`) plus generic ranking signals
 * (relationshipName/API name/label similarity to the TARGET OBJECT NAME
 * the caller passed in, plus createable/updateable) — never a per-target
 * lookup table of expected field names.
 */
import type { SalesforceClient, DescribeResult, DescribeField } from "@/lib/salesforce/client";

/* ── §2 SchemaCache — each object's Describe is requested at most once per pipeline run ── */
export class SchemaCache {
  private readonly cache = new Map<string, Promise<DescribeResult>>();
  constructor(private readonly client: SalesforceClient) {}

  get(objectName: string): Promise<DescribeResult> {
    let pending = this.cache.get(objectName);
    if (!pending) {
      pending = this.client.describeObject(objectName);
      this.cache.set(objectName, pending);
    }
    return pending;
  }
}

/* ── §1/§6 resolveReferenceField — THE single generic lookup resolver ── */
export interface ReferenceFieldCandidate {
  field: DescribeField;
  score: number;
}

export interface ReferenceFieldResolution {
  field: DescribeField | null;
  /** Every field considered, best-first — populated even when `field` is null, so a caller/debugger can see what almost matched. */
  candidates: ReferenceFieldCandidate[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A generic normalization of the TARGET OBJECT NAME the caller passed in — strips a trailing digit ("Product2" -> "product") or "__c" suffix so ranking can recognize a field name/label that dropped the same suffix, exactly as Salesforce's own convention often does. Never a per-object hardcoded pattern; derived from whatever `objectName` the caller supplies. */
function baseWord(objectName: string): string {
  return normalize(objectName.replace(/__c$/i, "").replace(/\d+$/, ""));
}

/**
 * Discovers the field on `describe` that is a lookup to `targetObjectName`.
 * `referenceTo` — Salesforce's own authoritative relationship metadata —
 * is the only thing that can ever qualify a field as a candidate at all
 * (a field either really points at that object or it doesn't; no naming
 * convention can substitute for it). When more than one field qualifies,
 * they're ranked by how closely `relationshipName`/API name/label
 * resemble the target object's own name, plus `createable`/`updateable` —
 * every signal §1 asked for, none of them a hardcoded field name.
 */
export function resolveReferenceField(describe: DescribeResult, targetObjectName: string): ReferenceFieldResolution {
  const target = normalize(targetObjectName);
  const targetBase = baseWord(targetObjectName);

  const candidates: ReferenceFieldCandidate[] = describe.fields
    .filter(f => f.type === "reference" && (f.referenceTo ?? []).some(r => normalize(r) === target))
    .map(f => {
      const relNorm = normalize(f.relationshipName ?? "");
      const nameNorm = normalize(f.name);
      const labelNorm = normalize(f.label);
      let score = 0;
      if (relNorm === target || relNorm === targetBase) score += 30;
      else if (relNorm && relNorm.includes(targetBase)) score += 15;
      if (nameNorm.includes(target) || nameNorm.includes(targetBase)) score += 20;
      if (labelNorm.includes(targetBase)) score += 10;
      if (f.createable) score += 5;
      if (f.updateable) score += 2;
      return { field: f, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates.find(c => c.field.createable) ?? candidates[0] ?? null;
  return { field: best?.field ?? null, candidates };
}

/* ── §4 required-field validation — read purely from Describe, never a hardcoded per-object list ── */
export function getRequiredFields(describe: DescribeResult): string[] {
  return describe.fields.filter(f => f.createable !== false && f.nillable === false && !f.defaultedOnCreate).map(f => f.name);
}
export function getOptionalFields(describe: DescribeResult): string[] {
  const required = new Set(getRequiredFields(describe));
  return describe.fields.filter(f => f.createable !== false && !required.has(f.name)).map(f => f.name);
}
export function getMissingFields(describe: DescribeResult, payload: Record<string, unknown>): string[] {
  return getRequiredFields(describe).filter(name => {
    const v = payload[name];
    return v === undefined || v === null || v === "";
  });
}

/* ── §Typed value fields — some Salesforce objects (AttributeAdjustmentCondition among them) store a
 * "value" polymorphically: one typed column per possible attribute data type (a string-typed column,
 * a number-typed column, a boolean-typed column, a date-typed column, a datetime-typed column), plus
 * often a picklist declaring WHICH data type this particular record is using. Populating the wrong
 * column — or leaving the data-type picklist unset — is exactly what produces Salesforce's own
 * "Select a data type" validation error. Nothing here hardcodes a literal field name: which column
 * holds which kind is discovered from that field's OWN Describe `type` (string/textarea/picklist ->
 * string; int/double/currency/percent -> number; boolean -> boolean; date -> date; datetime ->
 * datetime), narrowed to fields whose name suggests they're a value-holder. ── */
export type ValueKind = "string" | "integer" | "double" | "boolean" | "date" | "datetime" | "picklist" | "multipicklist" | "unknown";

/**
 * Maps a Salesforce attribute's own data-type value (e.g. "Text", "Integer",
 * "Number", "Boolean", "Date", "DateTime", "Currency", "Picklist",
 * "MultiPicklist" — the exact wording is org-specific, never assumed
 * literally) to a generic `ValueKind` by keyword, not by hardcoding the
 * exact string this org uses. Multi-value picklist is checked before plain
 * picklist since its own label ("MultiPicklist"/"Multi-Select Picklist")
 * always also contains "picklist". "Integer" is checked before the broader
 * numeric group so a genuinely whole-number attribute maps to `IntegerValue`
 * rather than `DoubleValue` (§4's explicit Integer/Double split).
 */
export function classifyAttributeDataType(dataType: string | null | undefined): ValueKind {
  if (!dataType) return "unknown";
  const d = dataType.toLowerCase();
  if (/multi.?(select.?)?picklist/.test(d)) return "multipicklist";
  if (/picklist/.test(d)) return "picklist";
  if (/date.?time/.test(d)) return "datetime";
  if (/\bdate\b/.test(d)) return "date";
  if (/bool|checkbox/.test(d)) return "boolean";
  if (/\binteger\b/.test(d)) return "integer";
  if (/number|decimal|double|currency|percent/.test(d)) return "double";
  if (/text|string|textarea|url|email|phone/.test(d)) return "string";
  return "unknown";
}

export interface TypedValueFieldResolution {
  kind: ValueKind;
  field: DescribeField | null;
  /** Every field on this object whose normalized name is one of `kind`'s explicit target tokens — empty when none exist. Populated even when `field` ends up null for some other reason (e.g. not createable), so a diagnosis can show what WAS found. */
  candidates: { field: DescribeField; kind: ValueKind }[];
}

/** Strips a custom-field `__c` suffix and every non-alphanumeric character, lowercased — so
 * "Boolean_Value__c", "BooleanValue", and "Boolean Value" all normalize identically. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/__c$/, "").replace(/[^a-z0-9]/g, "");
}

/**
 * §1/§4 — the ONLY mapping this resolver uses: an EXPLICIT, exact target field name per `ValueKind` —
 * never inferred from the field's own Describe `type`, never a fuzzy "contains" match, never a label
 * heuristic. This is deliberately narrower than before: matching by Describe `type` alone (e.g. "this
 * field is type=picklist, so it must hold picklist-kind values") is exactly what let a field literally
 * named `BooleanValue` (Describe-typed as a restricted picklist on some orgs, not a native checkbox) get
 * selected for a STRING/PICKLIST-kind attribute whenever it happened to iterate before the real
 * `StringValue` field — producing the "RAM 32GB"/"SSD Hard Drive 512GB" landing in `BooleanValue` bug
 * this mapping exists to make structurally impossible. Picklist and MultiPicklist both target
 * `StringValue` — this object has no separate picklist-shaped value column.
 */
const CONDITION_VALUE_FIELD_TOKENS: Partial<Record<ValueKind, string[]>> = {
  boolean: ["booleanvalue"],
  string: ["stringvalue"],
  picklist: ["stringvalue"],
  multipicklist: ["stringvalue"],
  integer: ["integervalue"],
  double: ["doublevalue", "decimalvalue"],
  date: ["datevalue"],
  datetime: ["datetimevalue"],
};

/**
 * Finds the field on `describe` whose name EXACTLY matches (after normalization) `kind`'s explicit
 * target token(s) from `CONDITION_VALUE_FIELD_TOKENS` — see that map's doc comment for why this is
 * name-exact rather than Describe-type-based. `kind === "unknown"` (or any kind with no token entry)
 * always resolves to `field: null` — there is no default, no fallback field, nothing invented.
 */
export function resolveTypedValueField(describe: DescribeResult, kind: ValueKind): TypedValueFieldResolution {
  const tokens = CONDITION_VALUE_FIELD_TOKENS[kind] ?? [];
  const candidates = tokens.length === 0 ? [] : describe.fields
    .filter(f => tokens.includes(normalizeFieldName(f.name)))
    .map(f => ({ field: f, kind }));
  const match = candidates.find(c => c.field.createable) ?? candidates[0];
  return { kind, field: match?.field ?? null, candidates };
}

const KIND_PICKLIST_KEYWORDS: Record<ValueKind, RegExp[]> = {
  string: [/^text$/i, /string/i],
  integer: [/integer/i, /whole.?number/i],
  double: [/^number$/i, /decimal/i, /double/i, /currency/i, /percent/i],
  boolean: [/boolean/i, /checkbox/i],
  date: [/^date$/i],
  datetime: [/date.?time/i],
  picklist: [/^picklist$/i, /^(single.?)?(select.?)?picklist$/i],
  multipicklist: [/multi.?(select.?)?picklist/i],
  unknown: [],
};

export interface DataTypeFieldResolution {
  /** The picklist field declaring which typed value column is in use, if this object has one — null means this object has no such field at all (not itself a problem). */
  field: DescribeField | null;
  /** The active picklist value on that field best matching `kind`, by keyword — null when the field exists but no active value plausibly matches. */
  value: string | null;
}

/**
 * Finds the picklist field (if any) that declares WHICH typed value
 * column a record is using — matched by label/name containing "data
 * type", never a hardcoded API name — and picks the active picklist
 * value that best matches `kind` by keyword (again, never assuming the
 * exact literal text this org uses for "Text"/"Number"/etc.).
 */
export function resolveDataTypeField(describe: DescribeResult, kind: ValueKind): DataTypeFieldResolution {
  const field = describe.fields.find(f => f.type === "picklist" && /data\s*type/i.test(f.label)) ??
    describe.fields.find(f => f.type === "picklist" && /datatype/i.test(f.name));
  if (!field) return { field: null, value: null };
  const keywords = KIND_PICKLIST_KEYWORDS[kind] ?? [];
  const active = (field.picklistValues ?? []).filter(v => v.active);
  const value = active.find(v => keywords.some(k => k.test(v.value) || k.test(v.label)))?.value ?? null;
  return { field, value };
}

/**
 * Converts a raw (always-string) attribute value into the JS type the resolved column expects —
 * Salesforce's REST API accepts date/datetime as ISO strings, so those pass through unchanged.
 *
 * §7/§9 — boolean is deliberately field-AWARE, not just kind-aware: the resolved `BooleanValue`-named
 * field is not guaranteed to be a native Salesforce boolean/checkbox — on some orgs it's a RESTRICTED
 * PICKLIST with active values like "True"/"False" (this is exactly what produced
 * `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST`: a raw JS `true`/`false` sent to a picklist field is not one
 * of its accepted values). When the field really is `type === "boolean"`, a native JS boolean is sent;
 * when it's a picklist, this returns whichever of the field's OWN active picklist values textually means
 * true/false (never an invented casing like a hardcoded "True"). The caller (`resolveConditionValueAssignment`)
 * only ever calls this for `kind === "boolean"` after already verifying the raw value is literally
 * "true"/"false" — this function does not (and must not) attempt that verification itself.
 */
export function convertValueForField(raw: string, kind: ValueKind, field: DescribeField): unknown {
  if (kind === "boolean") {
    const isTrue = /^true$/i.test(raw);
    if (field.type === "picklist") {
      const wanted = isTrue ? "true" : "false";
      const active = (field.picklistValues ?? []).filter(v => v.active);
      return active.find(v => v.value.toLowerCase() === wanted)?.value ?? raw;
    }
    return isTrue;
  }
  if (kind === "integer" || kind === "double") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/**
 * §3 — "any required picklists discovered from Describe": a required
 * picklist field this pipeline has no specific business logic for (not the
 * Operator field, not the data-type declarator) still needs SOME value if
 * Salesforce won't default it on create. The only non-guessed value
 * available is the org's OWN declared UI default — `picklistValues[].
 * defaultValue === true` — never an arbitrary first-active-value guess.
 * Returns null (not itself an error) when the org declared no default;
 * the field then surfaces through the normal missing-required-field
 * diagnosis instead of silently going in as a wrong guess.
 */
export function resolveDefaultPicklistValue(field: DescribeField): string | null {
  if (field.type !== "picklist") return null;
  return (field.picklistValues ?? []).find(v => v.active && v.defaultValue)?.value ?? null;
}

/** For every required picklist field not already set on `payload`, fills in the org's own declared default active value (see `resolveDefaultPicklistValue`) — mutates `payload` in place. Fields with no declared default are left alone. */
export function fillRequiredPicklistDefaults(describe: DescribeResult, payload: Record<string, unknown>): void {
  const required = new Set(getRequiredFields(describe));
  for (const f of describe.fields) {
    if (f.type !== "picklist" || !required.has(f.name) || f.name in payload) continue;
    const def = resolveDefaultPicklistValue(f);
    if (def) payload[f.name] = def;
  }
}

/**
 * §5/§6 — pulls the `fields` array out of a Salesforce REST create-error
 * response body. REST create failures return an array of
 * `{message, errorCode, fields}`; `fields` names the exact API field(s)
 * Salesforce is complaining about, when it names any at all. Never assumes
 * the body is in that shape — tolerates a bare object or anything else.
 */
export function extractSalesforceFields(responseBody: unknown): string[] {
  const bodyArray = Array.isArray(responseBody) ? responseBody : responseBody != null ? [responseBody] : [];
  return bodyArray.flatMap(b => (b && typeof b === "object" && Array.isArray((b as { fields?: unknown }).fields) ? (b as { fields: unknown[] }).fields : [])) as string[];
}

/* ── §Price-impacting eligibility — Salesforce enforces FIELD_INTEGRITY_EXCEPTION ("Ensure that your
 * attribute is price impacting") when an AttributeAdjustmentCondition/AttributeBasedAdjRule is created
 * for an attribute whose product-level association isn't flagged as price-impacting (or this org's own
 * equivalent flag). Discovered dynamically — never a hardcoded "IsPriceImpacting" API name — by matching
 * a boolean field whose name/label suggests it, so an org that renamed the flag, or modeled it on
 * AttributeDefinition instead of ProductAttributeDefinition, is still handled correctly. ── */
const PRICE_IMPACTING_KEYWORDS = [/price.?impact/i, /impacts?.?price/i, /pricing.?enabled/i, /price.?influenc/i];

export function resolvePriceImpactingField(describe: DescribeResult): DescribeField | null {
  return describe.fields.find(f => f.type === "boolean" && PRICE_IMPACTING_KEYWORDS.some(k => k.test(f.name) || k.test(f.label))) ?? null;
}

/* ── §Attribute data-type SOURCE field — WHICH field on AttributeDefinition/ProductAttributeDefinition
 * actually declares an attribute's own data type. §1 (this turn) — every label/name HEURISTIC that used
 * to rank candidates like "Input Type"/"Display Type"/"Attribute Type"/"Value Type" has been REMOVED
 * entirely: those are UI-rendering hints (how a value is displayed — text field/checkbox/dropdown), not
 * the value's actual DATA kind, and matching on them is exactly how an attribute like "RAM" (a genuine
 * string/picklist value) got misclassified as Boolean because its "Input Type" happened to say
 * "Checkbox". The ONLY field this now recognizes is the real, standard Salesforce/Revenue Cloud field
 * literally named `DataType` (normalized: case/whitespace/`__c`-suffix-insensitive, so a custom
 * `Data_Type__c` still matches, but nothing else does) — still Describe-driven (existence is verified,
 * never assumed) but no longer fuzzy-ranked. Checked on AttributeDefinition first, ProductAttributeDefinition
 * as the fallback source (see `resolveAttributeDataType` in nativeAttributeRecords.ts) — never both
 * silently merged. ── */
export interface DataTypeSourceFieldResolution {
  field: DescribeField | null;
  /** Every field that matched the exact "DataType" name (normally 0 or 1 — Salesforce disallows duplicate API names) — populated even when `field` is null, so a diagnosis can show there was truly nothing to find. */
  candidates: DescribeField[];
}

function isExactDataTypeFieldName(f: DescribeField): boolean {
  const normalized = (s: string) => s.toLowerCase().replace(/__c$/, "").replace(/[^a-z0-9]/g, "");
  return normalized(f.name) === "datatype" || normalized(f.label) === "datatype";
}

/**
 * §1/§3/§6 — the ONLY match this makes: a picklist/string/textarea field whose name or label is EXACTLY
 * "DataType"/"Data Type" (normalized) — never a fuzzy "contains" or scored-keyword match. `.field` is
 * null when this org's Describe exposes no such field at all; the caller treats that identically to "no
 * field discovered" and falls through to the next source / a hard stop before createRecord() — never a
 * guess.
 */
export function resolveAttributeDataTypeSourceField(describe: DescribeResult): DataTypeSourceFieldResolution {
  const candidates = describe.fields.filter(f => (f.type === "picklist" || f.type === "string" || f.type === "textarea") && isExactDataTypeFieldName(f));
  return { field: candidates[0] ?? null, candidates };
}

/* ── §6 — when Salesforce itself REJECTS a create call (as opposed to a pre-flight missing-field
 * check that never even calls createRecord), name EXACTLY which field and why, using that object's own
 * Describe — never a generic "create failed" message. Classifies each field Salesforce named in its
 * error response by cross-referencing that field's OWN Describe entry: missing required field, a
 * lookup Salesforce rejected the value for, a picklist Salesforce rejected the value for (with every
 * active value listed so the real fix is obvious), or any other typed value field (covers the
 * polymorphic AttributeAdjustmentCondition value/data-type columns without needing to know their names
 * in advance — whichever field Salesforce names, its own Describe `type` says what kind it is). ── */
export interface OffendingFieldDiagnosis {
  field: string;
  describeType: string | null;
  classification: "missing-required-field" | "invalid-lookup" | "invalid-picklist-value" | "invalid-value-field" | "unclassified-field";
  detail: string;
}

export interface CreateRejectionDiagnosis {
  objectName: string;
  errorCode: string | null;
  rawMessage: string;
  offendingFields: OffendingFieldDiagnosis[];
}

export function diagnoseCreateRejection(
  objectName: string,
  describe: DescribeResult,
  payload: Record<string, unknown>,
  errorCode: string | null,
  rawMessage: string,
  fieldsFromResponse: string[],
): CreateRejectionDiagnosis {
  const required = new Set(getRequiredFields(describe));
  const offendingFields: OffendingFieldDiagnosis[] = fieldsFromResponse.map(name => {
    const f = describe.fields.find(x => x.name === name) ?? null;
    const sentValue = payload[name];
    const populated = sentValue !== undefined && sentValue !== null && sentValue !== "";
    if (!populated && required.has(name)) {
      return {
        field: name, describeType: f?.type ?? null, classification: "missing-required-field",
        detail: `${name} is required on ${objectName} and was never populated in the payload sent.`,
      };
    }
    if (f?.type === "reference") {
      return {
        field: name, describeType: f.type, classification: "invalid-lookup",
        detail: `${name} is a lookup to [${(f.referenceTo ?? []).join(", ") || "an unknown object"}] — Salesforce rejected the value sent for it (${JSON.stringify(sentValue)}).`,
      };
    }
    if (f?.type === "picklist") {
      const active = (f.picklistValues ?? []).filter(v => v.active).map(v => v.value);
      return {
        field: name, describeType: f.type, classification: "invalid-picklist-value",
        detail: `${name} is a picklist — Salesforce rejected the value ${JSON.stringify(sentValue)}. Active values on this org: [${active.join(", ") || "(none active)"}].`,
      };
    }
    if (f) {
      return {
        field: name, describeType: f.type, classification: "invalid-value-field",
        detail: `${name} is a ${f.type} field — Salesforce rejected the value ${JSON.stringify(sentValue)} sent for it.`,
      };
    }
    return {
      field: name, describeType: null, classification: "unclassified-field",
      detail: `Salesforce named this field but it isn't present on ${objectName}'s own Describe response.`,
    };
  });
  return { objectName, errorCode, rawMessage, offendingFields };
}

export function formatCreateRejectionDiagnosis(d: CreateRejectionDiagnosis): string {
  const lines: string[] = [`${d.objectName} — Salesforce REJECTED this record`, `Error Code: ${d.errorCode ?? "(none)"}`, `Message: ${d.rawMessage}`, ""];
  if (d.offendingFields.length === 0) {
    lines.push("Salesforce did not name a specific field for this error (no `fields` array on the response) — see the raw message above.");
  } else {
    lines.push("Offending Field(s):");
    lines.push(...d.offendingFields.map(f => `  - ${f.field} [${f.classification}]: ${f.detail}`));
  }
  return lines.join("\n");
}

/* ── §3/§5 — one resolved lookup this create call depends on, and the unified debug log every object's creation goes through ── */
export interface ResolvedLookup {
  /** The object this lookup points at, e.g. "Product2" — for the log only, never used to guess a field name. */
  targetObject: string;
  /** Whatever `resolveReferenceField` found on THIS object's Describe for `targetObject` — null means this object's schema has no such lookup, which is not itself an error. */
  field: DescribeField | null;
  /** The value that should end up at `payload[field.name]` if `field` is non-null — null means nothing to populate (e.g. a dependent Id that hasn't been created yet). */
  value: string | null;
}

/**
 * §5 — logs, for one object, exactly what the caller asked for: Object
 * Name, Resolved Lookups (Target Object/Resolved Field/Resolved Value/
 * PASS-FAIL per lookup), Payload, Required Fields, Missing Fields — always
 * called before createRecord(). Returns the computed required/missing
 * fields so the caller (guardedCreate) doesn't recompute them separately.
 */
export function logObjectCreation(
  client: SalesforceClient,
  objectName: string,
  args: { describe: DescribeResult; payload: Record<string, unknown>; resolvedLookups: ResolvedLookup[] },
): { requiredFields: string[]; missingFields: string[] } {
  const requiredFields = getRequiredFields(args.describe);
  const missingFields = getMissingFields(args.describe, args.payload);

  const lines: string[] = [objectName, "", "Resolved Lookups"];
  if (args.resolvedLookups.length === 0) {
    lines.push("(none)");
  } else {
    for (const l of args.resolvedLookups) {
      const inPayload = l.field ? args.payload[l.field.name] : undefined;
      const pass = !!l.field && l.value != null && inPayload === l.value;
      lines.push(
        `Target Object: ${l.targetObject}`,
        `Resolved Field: ${l.field?.name ?? "(not found on this object)"}`,
        `Resolved Value: ${l.value ?? "(none)"}`,
        pass ? "PASS" : "FAIL",
        "",
      );
    }
  }

  lines.push("Payload Fields");
  const payloadKeys = Object.keys(args.payload);
  lines.push(...(payloadKeys.length > 0 ? payloadKeys.map(k => `${k} = ${JSON.stringify(args.payload[k])}`) : ["(empty)"]));

  lines.push("", "Required Fields");
  lines.push(...(requiredFields.length > 0 ? requiredFields.map(f => `${payloadKeys.includes(f) ? "✓" : "✗"} ${f}`) : ["(none)"]));

  lines.push("", "Missing Fields");
  lines.push(...(missingFields.length > 0 ? missingFields : ["(none)"]));

  client.logDebug("native-create-request", lines.join("\n"));
  return { requiredFields, missingFields };
}

/* ── §Schema diagnosis — produced automatically, using the Describe already fetched for this create
 * call (no extra Salesforce round-trip), whenever a create is ABOUT TO FAIL. Never a generic "a
 * required field couldn't be resolved" — for every missing required field, this classifies exactly
 * why: not a lookup at all (payload builder never sets it), a lookup this object's schema exposes but
 * that this create call never even attempted to resolve (a real gap in what's attempted for this
 * object), or a lookup that WAS attempted but didn't end up populated. ── */
export interface RequiredFieldDiagnosis {
  field: string;
  type: string;
  isReference: boolean;
  referenceTo: string[];
  populated: boolean;
  /** One of this create call's `resolvedLookups[].targetObject` whose target matches this field's own `referenceTo`, if any were attempted. */
  attemptedTarget: string | null;
  reason: string;
}

export interface SchemaDiagnosis {
  objectName: string;
  requiredFields: RequiredFieldDiagnosis[];
  /** Every reference field Describe returned for this object, not just the ones any resolver call happened to target. */
  referenceFields: { name: string; referenceTo: string[]; relationshipName: string | null; createable: boolean; updateable: boolean }[];
  attemptedLookups: ResolvedLookup[];
  missingFields: string[];
}

export function buildSchemaDiagnosis(
  objectName: string,
  describe: DescribeResult,
  payload: Record<string, unknown>,
  resolvedLookups: ResolvedLookup[],
): SchemaDiagnosis {
  const attemptedTargetsLower = new Set(resolvedLookups.map(l => l.targetObject.toLowerCase()));

  const requiredFields: RequiredFieldDiagnosis[] = getRequiredFields(describe).map(name => {
    const f = describe.fields.find(x => x.name === name)!;
    const isReference = f.type === "reference";
    const referenceTo = f.referenceTo ?? [];
    const v = payload[name];
    const populated = v !== undefined && v !== null && v !== "";
    const attemptedTarget = isReference ? referenceTo.find(r => attemptedTargetsLower.has(r.toLowerCase())) ?? null : null;

    let reason: string;
    if (populated) {
      reason = "Populated.";
    } else if (!isReference) {
      reason = `Required ${f.type} field — no lookup is involved here; the payload builder never sets a value for it on this object.`;
    } else if (attemptedTarget) {
      const attempt = resolvedLookups.find(l => l.targetObject.toLowerCase() === attemptedTarget.toLowerCase());
      reason = attempt?.field
        ? `Required reference to [${referenceTo.join(", ")}] — a lookup WAS resolved (${attempt.field.name}), but its value never landed in this field.`
        : `Required reference to [${referenceTo.join(", ")}] — a lookup for "${attemptedTarget}" WAS attempted on this object, but resolveReferenceField found no createable field for it.`;
    } else {
      reason = `Required reference to [${referenceTo.join(", ") || "an unknown object"}] — no lookup for any of these targets was ever attempted for ${objectName}; there is no code path in this pipeline that tries to resolve this field at all.`;
    }
    return { field: name, type: f.type, isReference, referenceTo, populated, attemptedTarget, reason };
  });

  return {
    objectName,
    requiredFields,
    referenceFields: describe.fields.filter(f => f.type === "reference").map(f => ({
      name: f.name, referenceTo: f.referenceTo ?? [], relationshipName: f.relationshipName ?? null,
      createable: f.createable ?? false, updateable: f.updateable ?? false,
    })),
    attemptedLookups: resolvedLookups,
    missingFields: requiredFields.filter(f => !f.populated).map(f => f.field),
  };
}

export function formatSchemaDiagnosis(diagnosis: SchemaDiagnosis): string {
  const lines: string[] = [`${diagnosis.objectName} — SCHEMA DIAGNOSIS`, ""];

  lines.push("Reference Fields (every one Describe returned for this object):");
  lines.push(...(diagnosis.referenceFields.length > 0
    ? diagnosis.referenceFields.map(f => `  ${f.name} — referenceTo: [${f.referenceTo.join(", ")}], relationshipName: ${f.relationshipName ?? "(none)"}, createable: ${f.createable}, updateable: ${f.updateable}`)
    : ["  (none)"]));

  lines.push("", "Required Fields:");
  lines.push(...(diagnosis.requiredFields.length > 0
    ? diagnosis.requiredFields.map(f => `  ${f.populated ? "✓" : "✗"} ${f.field} (${f.type})`)
    : ["  (none)"]));

  lines.push("", "Lookups this create call attempted:");
  lines.push(...(diagnosis.attemptedLookups.length > 0
    ? diagnosis.attemptedLookups.map(l => `  target=${l.targetObject} -> field=${l.field?.name ?? "(none found)"}, value=${l.value ?? "(none)"}`)
    : ["  (none)"]));

  lines.push("", "Why the create failed:");
  const failing = diagnosis.requiredFields.filter(f => !f.populated);
  lines.push(...(failing.length > 0
    ? failing.map(f => `  ${f.field}: ${f.reason}`)
    : ["  (no missing required fields — the failure is elsewhere, e.g. a resolved lookup that never reached the payload)"]));

  return lines.join("\n");
}

/** Logs the formatted diagnosis AND the complete raw Describe response verbatim — the Describe was already fetched (and cached) for this create call, so this is zero extra Salesforce calls. */
export function logSchemaDiagnosis(client: SalesforceClient, describe: DescribeResult, diagnosis: SchemaDiagnosis): void {
  client.logDebug("native-create-request", formatSchemaDiagnosis(diagnosis));
  client.logDebug("native-create-request", `${diagnosis.objectName} — complete raw Describe response (already fetched via SchemaCache, no extra API call)\n${JSON.stringify(describe, null, 2)}`);
}
