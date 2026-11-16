import type { RampApi } from "./api";
import { addDays, addMonths, wholeMonths } from "@/lib/ramp/schedule";

/**
 * TEST-ONLY in-memory Salesforce org implementing RampApi — a MOCK. It reproduces the behaviour verified in p10/p12 and documented in
 * the Revenue Management Developer Guide v68 closely enough to exercise every RAMP step end to end, but passing tests against it is
 * NOT live Salesforce verification. Options model the org differences (p10 has no group ramp) and failure modes (pricing not saved,
 * async delays, rejected writes).
 */
type Row = Record<string, unknown>;
export interface FakeOrgOptions {
  /** p12-like (group ramp + compound) when true; p10-like when false. */
  groupRamp?: boolean;
  /** Force pricing saves prices (LastPricedDate, NetUnitPrice). false = the "calculated, not saved" symptom. */
  pricingPersists?: boolean;
  /** Number of quote reads that still show the async work as not done after a commit / clone. */
  asyncLag?: number;
  rejectCommit?: string;
  rejectPrs?: string;
  /** Clock shared with the test (LastPricedDate / CreatedDate). */
  now?: () => string;
  /** Observe every SOQL the code sends (tests assert the exact query). */
  onQuery?: (soql: string) => void;
  /** Make matching queries fail like a Salesforce error. */
  failQuery?: (soql: string) => boolean;
  /** Objects whose Describe fails (returns nothing). */
  failDescribe?: string[];
  /** Reject inserts of these objects with this Salesforce message. */
  rejectInsert?: Record<string, string>;
  /** Org allows several ramp schedules on one quote (like p12 #40). Default false: EditGroup is refused once the quote has one. */
  multipleRampSchedules?: boolean;
  /** EditRampSchedule ignores these fields (to test a Salesforce that doesn't keep them). */
  editRampScheduleIgnores?: string[];
}
export interface FakeCall { method: string; path: string; body?: unknown }

const PICK = { seg: ["Yearly", "Custom", "FreeTrial", "Prorated"], qlgSeg: ["Custom", "Yearly", "Prorated"], up: ["Standard", "Compound"], dur: ["Months", "Days"], bf: ["MilestonePlan", "Weekly", "Monthly", "Quarterly", "Semi-Annual", "Annual"] };

export function fakeOrg(seed: Partial<Record<string, Row[]>>, opts: FakeOrgOptions = {}) {
  const groupRamp = opts.groupRamp ?? true;
  const s: Record<string, Row[]> = { Account: [], Quote: [], QuoteLineItem: [], QuoteLineGroup: [], Product2: [], ProductSellingModel: [], ProductSellingModelOption: [], ProductRampSegment: [], ExpressionSet: [], ExpressionSetVersion: [], ContextTag: [], ContextAttributeMapping: [] };
  for (const [k, v] of Object.entries(seed)) s[k] = (v ?? []).map(r => ({ ...r }));
  const calls: FakeCall[] = [];
  const contexts = new Map<string, Row>();
  let seq = 0, lag = 0;
  const id = (p: string) => `${p}${String(++seq).padStart(15 - p.length, "0")}`.slice(0, 15) + "AAA";
  const now = opts.now ?? (() => new Date(Date.now() + seq * 1000).toISOString());
  const f = (name: string, cu: string, picklist: string[] = []) => ({ name, createable: cu.includes("c"), updateable: cu.includes("u"), picklistValues: picklist.map(value => ({ value, active: true })) });
  const describes: Record<string, Row> = {
    Product2: { createable: true, updateable: true, fields: [f("Id", ""), f("Name", "cu"), f("IsActive", "cu"), f("ProductCode", "cu"), f("CanRamp", ""), f("UsageModelType", "cu"), f("Type", "c")] },
    ProductRampSegment: { createable: true, updateable: true, fields: [f("Id", ""), f("Name", ""), f("ProductId", "c"), f("ProductSellingModelId", "c"), f("SegmentType", "cu", PICK.seg), f("TrialDuration", "cu"), f("DurationType", "cu", PICK.dur)] },
    // Createable / required as in p10 / p12 (2026-11-10): QuoteId, PricebookEntryId, Quantity, Product2Id required; ProductSellingModelId NOT createable (it follows the PricebookEntry).
    QuoteLineItem: { createable: true, updateable: true, fields: [f("QuoteId", "c"), f("Product2Id", "c"), f("PricebookEntryId", "c"), ...["Id", "ProductSellingModelId", "SellingModelType", "NetUnitPrice", "NetTotalPrice", "ApplUnitPriceUpliftPct", ...(groupRamp ? ["RampUpliftType"] : [])].map(n => f(n, "", n === "RampUpliftType" ? PICK.up : [])), ...["Quantity", "UnitPrice", "Discount", "StartDate", "EndDate", "SubscriptionTerm", "PeriodBoundary", "QuoteLineGroupId", "RampIdentifier", "SegmentIdentifier", "SegmentName", "UnitPriceUplift"].map(n => f(n, "cu")), f("SegmentType", "cu", PICK.seg), f("BillingFrequency", "cu", PICK.bf)] },
    QuoteLineGroup: { createable: true, updateable: true, fields: groupRamp
      ? [f("Id", ""), f("Name", "cu"), f("Description", "cu"), f("QuoteId", "c"), f("SortOrder", "cu"), f("IsRamped", "cu"), f("SegmentType", "cu", PICK.qlgSeg), f("StartDate", "cu"), f("EndDate", "cu"), f("UnitPriceUplift", "cu"), f("RampUpliftType", "cu", PICK.up), f("Discount", "cu"), f("ParentQuoteLineGroupId", "cu")] // p12: Discount = segment group discount (Trial segments carry 100)
      : [f("Id", ""), f("Name", "cu"), f("Description", "cu"), f("QuoteId", "c"), f("SortOrder", "cu"), f("IsRamped", ""), f("SegmentType", "", PICK.qlgSeg), f("StartDate", "cu"), f("EndDate", "cu"), f("UnitPriceUplift", "cu"), f("ParentQuoteLineGroupId", "cu")] },
    // p12 ProductSellingModel (2026-11-10): SellingModelType OneTime | TermDefined | Evergreen, PricingTermUnit Months | Quarterly | Semi-Annual | Weekly | Annual.
    ProductSellingModel: { createable: true, updateable: true, fields: [f("Id", ""), f("Name", "cu"), f("SellingModelType", "c", ["OneTime", "TermDefined", "Evergreen"]), f("Status", "cu", ["Draft", "Inactive", "Active"]), f("PricingTerm", "c"), f("PricingTermUnit", "c", ["Months", "Quarterly", "Semi-Annual", "Weekly", "Annual"])] },
    PricebookEntry: { createable: true, updateable: true, fields: [f("Id", ""), f("Product2Id", "c"), f("Pricebook2Id", "c"), f("UnitPrice", "cu"), f("IsActive", "cu"), f("ProductSellingModelId", "c")] },
    // As in p10 / p12 (verified 2026-11-09): QuoteAccountId carries the account; AccountId is the Opportunity-derived standard field.
    Quote: { createable: true, updateable: true, fields: [f("Id", ""), f("Name", "cu"), f("QuoteNumber", ""), f("Status", "u", ["Draft", "Needs Review", "In Review", "Approved", "Rejected", "Presented", "Accepted", "Denied"]), f("QuoteAccountId", "cu"), f("AccountId", ""), f("OpportunityId", "c"), f("ExpirationDate", "cu"), f("StartDate", "cu"), f("Description", "cu"), f("GrandTotal", ""), f("LastModifiedDate", ""), f("Pricebook2Id", "cu"), f("CalculationStatus", ""), f("LastPricedDate", "")] },
  };
  const REL: Record<string, string> = { QuoteAccount: "Account", Product2: "Product2", ProductSellingModel: "ProductSellingModel", QuoteLineGroup: "QuoteLineGroup", Product: "Product2" };
  const relRow = (row: Row, rel: string) => s[REL[rel] ?? rel]?.find(r => r.Id === row[rel === "Product" ? "ProductId" : `${rel}Id`]) ?? null;
  const val = (row: Row, field: string): unknown => (field.includes(".") ? (relRow(row, field.split(".")[0])?.[field.split(".")[1]] ?? null) : row[field] ?? null);

  function splitTop(where: string, sep: " AND " | " OR "): string[] {
    const out: string[] = []; let depth = 0, q = false, cur = "";
    for (let i = 0; i < where.length; i++) {
      const c = where[i];
      if (c === "'" && where[i - 1] !== "\\") q = !q;
      if (!q && c === "(") depth++;
      if (!q && c === ")") depth--;
      if (!q && depth === 0 && where.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map(x => x.trim());
  }
  const lit = (v: string): unknown => (v === "true" ? true : v === "false" ? false : v === "null" ? null : v.startsWith("'") ? v.slice(1, -1).replace(/\\'/g, "'") : Number(v));
  function cond(row: Row, c: string): boolean {
    c = c.trim();
    if (c.startsWith("(") && c.endsWith(")")) { const inner = c.slice(1, -1); const ors = splitTop(inner, " OR "); return ors.length > 1 ? ors.some(o => cond(row, o)) : splitTop(inner, " AND ").every(a => cond(row, a)); }
    let m = /^([\w.]+) IN \((SELECT .+)\)$/.exec(c);
    if (m) { const sub = query(m[2]); const field = /^SELECT (\w+)/.exec(m[2])![1]; return sub.some(r => r[field] === val(row, m![1])); }
    m = /^([\w.]+) IN \((.+)\)$/.exec(c);
    if (m) return m[2].split(",").map(x => lit(x.trim())).includes(val(row, m[1]));
    m = /^([\w.]+) LIKE '(.*)'$/.exec(c);
    if (m) { const needle = m[2].replace(/%/g, "").toLowerCase(); return String(val(row, m[1]) ?? "").toLowerCase().includes(needle); }
    m = /^([\w.]+) (=|!=|>=|<=) (.+)$/.exec(c);
    if (m) { const a = val(row, m[1]), b = lit(m[3]); return m[2] === "=" ? a === b : m[2] === "!=" ? a !== b : m[2] === ">=" ? String(a) >= String(b) : String(a) <= String(b); }
    throw new Error(`fake SOQL: unsupported condition ${c}`);
  }
  function query(soql: string): Row[] {
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: OFFSET (\d+))?$/.exec(soql.trim());
    if (!m) throw new Error(`fake SOQL: unsupported ${soql}`);
    const [, select, obj, where, order, limit, offset] = m;
    let rows = (s[obj] ?? []).filter(r => !where || splitTop(where, " AND ").every(c => cond(r, c)));
    if (order) {
      const keys = order.split(",").map(k => k.trim().split(/\s+/)).map(([field, dir]) => ({ field, desc: dir === "DESC" }));
      rows = [...rows].sort((a, b) => { for (const k of keys) { const c = String(val(a, k.field) ?? "~").localeCompare(String(val(b, k.field) ?? "~")) * (k.desc ? -1 : 1); if (c) return c; } return 0; });
    }
    if (offset) rows = rows.slice(Number(offset));
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map(r => {
      const out: Row = {};
      for (const fld of select.split(",").map(x => x.trim())) {
        if (fld.includes(".")) { const [rel, sub] = fld.split("."); out[rel] = { ...(out[rel] as Row | undefined), [sub]: val(r, fld) }; }
        else out[fld] = r[fld] ?? null;
      }
      return out;
    });
  }

  const quoteOf = (qid: string) => s.Quote.find(q => q.Id === qid)!;
  const price = (qid: string) => {
    const lines = s.QuoteLineItem.filter(l => l.QuoteId === qid);
    const groups = new Map(s.QuoteLineGroup.map(g => [g.Id, g]));
    const byRamp = new Map<string, Row[]>();
    for (const l of lines) if (l.RampIdentifier) byRamp.set(String(l.RampIdentifier), [...(byRamp.get(String(l.RampIdentifier)) ?? []), l]);
    for (const l of lines) {
      const g = l.QuoteLineGroupId ? groups.get(l.QuoteLineGroupId as string) : null;
      const uplift = Number(g && g.IsRamped ? g.UnitPriceUplift ?? 0 : l.UnitPriceUplift ?? 0);
      const method = g?.RampUpliftType ?? l.RampUpliftType ?? "Standard";
      let appl = uplift;
      if (method === "Compound" && l.RampIdentifier) {
        const chain = (byRamp.get(String(l.RampIdentifier)) ?? []).filter(x => String(x.StartDate) <= String(l.StartDate)).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
        let fct = 1; for (const x of chain) { const gx = x.QuoteLineGroupId ? groups.get(x.QuoteLineGroupId as string) : null; fct *= 1 + Number(gx && gx.IsRamped ? gx.UnitPriceUplift ?? 0 : x.UnitPriceUplift ?? 0) / 100; }
        appl = Math.round((fct - 1) * 1e6) / 1e4;
      }
      l.ApplUnitPriceUpliftPct = appl;
      if (method === "Compound" && g) l.RampUpliftType = "Compound";
      l.NetUnitPrice = Math.round(Number(l.UnitPrice ?? 0) * (1 + appl / 100) * (1 - Number(l.Discount ?? 0) / 100) * 100) / 100;
      l.NetTotalPrice = Math.round(Number(l.NetUnitPrice) * Number(l.Quantity ?? 1) * 100) / 100;
    }
    quoteOf(qid).CalculationStatus = "CompletedWithPricing";
    quoteOf(qid).LastPricedDate = now();
  };

  const api: RampApi = {
    apiVersion: "v68.0", instanceUrl: "https://fake.my.salesforce.com",
    query: async <T,>(q: string) => {
      opts.onQuery?.(q);
      if (opts.failQuery?.(q)) throw new Error("INVALID_FIELD: simulated Salesforce query failure");
      if (/FROM Quote\b/.test(q) && lag > 0) lag--; // async work becomes visible after N quote reads
      return query(q) as T[];
    },
    describe: async o => (opts.failDescribe?.includes(o) ? null : (describes[o] as Row) ?? null),
    async call(method, path, body) {
      calls.push({ method, path, body });
      const b = (body ?? {}) as Row;
      if (method === "POST" && path === "/sobjects/ProductRampSegment") {
        if (opts.rejectPrs) return { status: 400, body: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: opts.rejectPrs }] };
        const rid = id("1FT"); s.ProductRampSegment.push({ Id: rid, Name: `PPRS-${seq}`, CreatedDate: now(), TrialDuration: null, DurationType: null, ...b });
        const p = s.Product2.find(x => x.Id === b.ProductId); if (p) p.CanRamp = true;
        return { status: 201, body: { id: rid, success: true, errors: [] } };
      }
      // Record inserts (Quote / QuoteLineGroup / QuoteLineItem) with the createable + required fields verified in p10 / p12 (2026-11-10).
      const ins = /^\/sobjects\/(Quote|QuoteLineGroup|QuoteLineItem)$/.exec(path);
      if (ins && method === "POST") {
        const obj = ins[1];
        if (opts.rejectInsert?.[obj]) return { status: 400, body: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: opts.rejectInsert[obj] }] };
        const desc = describes[obj] as { fields: { name: string; createable: boolean }[] };
        const bad = Object.keys(b).filter(k => !desc.fields.some(fl => fl.name === k && fl.createable));
        if (bad.length) return { status: 400, body: [{ errorCode: "INVALID_FIELD_FOR_INSERT_UPDATE", message: `Unable to create/update fields: ${bad.join(", ")}.` }] };
        const need = obj === "Quote" ? ["Name"] : obj === "QuoteLineGroup" ? ["Name", "QuoteId"] : ["QuoteId", "PricebookEntryId", "Quantity", "Product2Id"];
        const miss = need.filter(k => b[k] === undefined || b[k] === null || b[k] === "");
        if (miss.length) return { status: 400, body: [{ errorCode: "REQUIRED_FIELD_MISSING", message: `Required fields are missing: [${miss.join(", ")}]` }] };
        if (obj === "Quote") {
          const rid = id("0Q0");
          s.Quote.push({ Status: "Draft", CalculationStatus: "NotStarted", LastPricedDate: null, LastModifiedDate: now(), ...b, Id: rid, QuoteNumber: String(s.Quote.length + 100).padStart(8, "0"), AccountId: null });
          return { status: 201, body: { id: rid, success: true, errors: [] } };
        }
        if (obj === "QuoteLineGroup") {
          if (!s.Quote.some(q => q.Id === b.QuoteId)) return { status: 400, body: [{ errorCode: "INVALID_CROSS_REFERENCE_KEY", message: "invalid cross reference id" }] };
          const rid = id("1C9");
          s.QuoteLineGroup.push({ IsRamped: false, SegmentType: null, StartDate: null, EndDate: null, UnitPriceUplift: null, RampUpliftType: null, ParentQuoteLineGroupId: null, SortOrder: s.QuoteLineGroup.filter(g => g.QuoteId === b.QuoteId).length + 1, ...b, Id: rid });
          return { status: 201, body: { id: rid, success: true, errors: [] } };
        }
        const pbe = (s.PricebookEntry ?? []).find(e => e.Id === b.PricebookEntryId);
        if (!pbe || pbe.Product2Id !== b.Product2Id) return { status: 400, body: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "field integrity exception: PricebookEntryId (pricebook entry is for a different product)" }] };
        const psm = (s.ProductSellingModel ?? []).find(x => x.Id === pbe.ProductSellingModelId);
        // Salesforce's own rule (verbatim from p12): subscription lines must carry a Billing Frequency.
        if ((psm?.SellingModelType === "TermDefined" || psm?.SellingModelType === "Evergreen") && !b.BillingFrequency) return { status: 400, body: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: "When the SellingModelType is Evergreen or Term-Defined, BillingFrequency can't be null: Billing Frequency", fields: ["BillingFrequency"] }] };
        if (b.BillingFrequency && !PICK.bf.includes(String(b.BillingFrequency))) return { status: 400, body: [{ errorCode: "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST", message: `bad value for restricted picklist field: ${b.BillingFrequency}` }] };
        const rid = id("0QL");
        s.QuoteLineItem.push({ Discount: 0, RampIdentifier: null, CreatedDate: now(), ...b, Id: rid, ProductSellingModelId: pbe.ProductSellingModelId ?? null, SellingModelType: psm?.SellingModelType ?? null, UnitPrice: b.UnitPrice ?? pbe.UnitPrice });
        return { status: 201, body: { id: rid, success: true, errors: [] } };
      }
      let m = /^\/sobjects\/QuoteLineItem\/(\w+)$/.exec(path);
      if (m && method === "PATCH") { const l = s.QuoteLineItem.find(x => x.Id === m![1]); if (!l) return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "not found" }] }; Object.assign(l, b); return { status: 204, body: null }; }
      m = /^\/connect\/revenue-management\/sales-transaction-contexts\/(\w+)\/actions\/ramp-deal-create$/.exec(path);
      if (m) {
        const l = s.QuoteLineItem.find(x => x.Id === m![1]);
        if (!l) return { status: 400, body: { success: false, errors: [{ errorCode: "INVALID_API_INPUT", message: "line not found" }] } };
        const prod = s.Product2.find(x => x.Id === l.Product2Id);
        if (prod?.CanRamp === false) return { status: 201, body: { success: false, errors: [{ errorCode: "INVALID_API_INPUT", message: "You can't ramp products that aren't rampable." }] } };
        const ctx = `ctx${++seq}`; contexts.set(ctx, { ...b });
        return { status: 201, body: { success: true, errors: [], transactionContextId: ctx } };
      }
      if (path === "/connect/rev/sales-transaction/actions/place") {
        const graph = (b.graph ?? {}) as { records?: { record: Row }[] };
        const quoteRec = graph.records?.find(r => (r.record.attributes as Row).type === "Quote")?.record;
        const qid = String((quoteRec?.attributes as Row)?.id ?? "");
        if (!s.Quote.some(q => q.Id === qid)) return { status: 400, body: { isSuccess: false, errorResponse: [{ errorCode: "INVALID_API_INPUT", message: "Input Representation cannot be null" }] } };
        const ctxId = (b.contextDetails as Row | undefined)?.contextId as string | undefined;
        if (ctxId) {
          if (opts.rejectCommit) return { status: 201, body: { isSuccess: false, errorResponse: [{ errorCode: "UNKNOWN_EXCEPTION", message: opts.rejectCommit }] } };
          const c = contexts.get(ctxId); if (!c) return { status: 400, body: { isSuccess: false, errorResponse: [{ errorCode: "INVALID_INPUT", message: "context not found" }] } };
          const base = s.QuoteLineItem.find(x => x.Id === c.transactionLineId)!;
          const baseStart = String(base.StartDate), baseEnd = String(base.EndDate);
          const ramp = `RDI${++seq}`; const months = Number(c.subscriptionTerm);
          const years = Math.ceil(months / 12);
          for (let i = 0; i < years; i++) {
            const start = addMonths(baseStart, i * 12), fullEnd = addDays(addMonths(baseStart, (i + 1) * 12), -1);
            const end = fullEnd > baseEnd ? baseEnd : fullEnd;
            const target = i === 0 ? base : (() => { const n: Row = { ...base, Id: id("0QL"), CreatedDate: now(), PeriodBoundary: null }; s.QuoteLineItem.push(n); return n; })();
            Object.assign(target, { RampIdentifier: ramp, SegmentIdentifier: `SEG${seq}${i}`, SegmentName: `Year ${i + 1}`, SegmentType: "Yearly", StartDate: start, EndDate: end, SubscriptionTerm: Math.max(1, Math.round((wholeMonths(start, end) ?? 12) / 12)) });
          }
          contexts.delete(ctxId);
          quoteOf(qid).CalculationStatus = "CompletedWithoutPricing";
          lag = opts.asyncLag ?? 0;
          return { status: 201, body: { isSuccess: true, salesTransactionId: qid, errorResponse: [] } };
        }
        const action = b.groupRampAction as string | undefined;
        const groupRecs = (graph.records ?? []).filter(r => (r.record.attributes as Row).type === "QuoteLineGroup").map(r => r.record);
        if (action === "EditGroup" || action === "EditRampSchedule") {
          if (!groupRamp) return { status: 400, body: { isSuccess: false, errorResponse: [{ errorCode: "INVALID_API_INPUT", message: "Ramp deals for groups isn't enabled." }] } };
          for (const rec of groupRecs) {
            const g = s.QuoteLineGroup.find(x => x.Id === (rec.attributes as Row).id)!;
            const { attributes: _a, ...fields } = rec; void _a;
            // p12 (2026-11-10, verbatim): EditGroup on a quote that already has a ramp schedule — even on its own segment 1, even with only
            // Name / RampUpliftType — is refused as a conversion. Orgs like p12 #40 that hold several schedules: refused on a ramped group.
            const quoteHasSchedule = s.QuoteLineGroup.some(x => x.QuoteId === qid && x.IsRamped);
            if (action === "EditGroup" && (opts.multipleRampSchedules ? !!g.IsRamped : quoteHasSchedule)) return { status: 400, body: { contextDetails: { isBuiltInTransaction: false }, isSuccess: false, salesTransactionId: qid, errorResponse: [{ errorCode: "FIELD_INTEGRITY_EXCEPTION", message: `You can’t convert a group to a ramped segment when the ${qid} has a ramp schedule. Clone the last segment in the ramp schedule to add segments.`, referenceId: qid }] } };
            const wasRamped = !!g.IsRamped;
            if (action === "EditRampSchedule") for (const k of opts.editRampScheduleIgnores ?? []) delete (fields as Row)[k];
            Object.assign(g, fields);
            if (action === "EditGroup" && !wasRamped && g.IsRamped) {
              // p12: a converted segment (and its lines) gets RampUpliftType = Compound unless the request says otherwise.
              if (groupRamp && !("RampUpliftType" in fields)) g.RampUpliftType = "Compound";
              for (const l of s.QuoteLineItem.filter(x => x.QuoteLineGroupId === g.Id)) Object.assign(l, { RampIdentifier: `RDI${l.Product2Id}`, SegmentIdentifier: `SEG${++seq}`, SegmentName: g.Name, StartDate: g.StartDate, EndDate: g.EndDate, ...(groupRamp ? { RampUpliftType: g.RampUpliftType } : {}) });
            }
            if (action === "EditRampSchedule") for (const l of s.QuoteLineItem.filter(x => x.QuoteLineGroupId === g.Id)) Object.assign(l, { StartDate: g.StartDate, EndDate: g.EndDate });
            if ("Name" in fields) for (const l of s.QuoteLineItem.filter(x => x.QuoteLineGroupId === g.Id)) l.SegmentName = g.Name;
            // Salesforce copies the segment group's uplift + method onto its lines (p12 RAMP 23: group 5 / 10 → lines 5 / 10).
            for (const l of s.QuoteLineItem.filter(x => x.QuoteLineGroupId === g.Id)) { if ("UnitPriceUplift" in fields) l.UnitPriceUplift = g.UnitPriceUplift; if ("RampUpliftType" in fields) l.RampUpliftType = g.RampUpliftType; }
          }
          return { status: 201, body: { isSuccess: true, salesTransactionId: qid, errorResponse: [] } };
        }
        if (b.pricingPref === "Force") {
          if (opts.pricingPersists !== false) price(qid); else quoteOf(qid).CalculationStatus = "CompletedWithoutPricing";
          return { status: 201, body: { isSuccess: true, salesTransactionId: qid, errorResponse: [] } };
        }
        return { status: 201, body: { isSuccess: true, salesTransactionId: qid, errorResponse: [] } };
      }
      if (path === "/connect/rev/sales-transaction/actions/clone") {
        const gid = (b.recordIds as string[])[0];
        const g = s.QuoteLineGroup.find(x => x.Id === gid);
        if (!g) return { status: 400, body: { success: false, errors: [{ errorCode: "INVALID_API_INPUT", message: "record not found" }] } };
        // "Last segment" is per ramp: the ramped groups whose lines share this group's RampIdentifiers (a quote can hold several ramps).
        const rids = new Set(s.QuoteLineItem.filter(l => l.QuoteLineGroupId === gid && l.RampIdentifier).map(l => l.RampIdentifier));
        const ramped = s.QuoteLineGroup.filter(x => x.QuoteId === g.QuoteId && x.IsRamped && (x.Id === gid || s.QuoteLineItem.some(l => l.QuoteLineGroupId === x.Id && rids.has(l.RampIdentifier)))).sort((a, c) => String(a.StartDate).localeCompare(String(c.StartDate)));
        if (ramped[ramped.length - 1].Id !== gid) return { status: 400, body: { success: false, errors: [{ errorCode: "INVALID_API_INPUT", message: "You can clone only the last ramp segment." }] } };
        const start = addDays(String(g.EndDate), 1), end = addDays(addMonths(start, 12), -1);
        const ng: Row = { ...g, Id: id("1C9"), Name: `${g.Name} - Clone`, SortOrder: Number(g.SortOrder ?? 0) + 1, StartDate: start, EndDate: end };
        s.QuoteLineGroup.push(ng);
        for (const l of s.QuoteLineItem.filter(x => x.QuoteLineGroupId === gid)) s.QuoteLineItem.push({ ...l, Id: id("0QL"), QuoteLineGroupId: ng.Id, SegmentIdentifier: `SEG${++seq}`, StartDate: start, EndDate: end, CreatedDate: now() });
        lag = opts.asyncLag ?? 0;
        return { status: 201, body: { requestId: `req${seq}`, salesTransactionId: g.QuoteId, success: true, errors: [] } };
      }
      return { status: 404, body: [{ errorCode: "NOT_FOUND", message: `fake: no handler for ${method} ${path}` }] };
    },
  };
  return { api, store: s, calls };
}
