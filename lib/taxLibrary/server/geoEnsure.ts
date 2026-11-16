/**
 * ENSURE SALESFORCE GEOGRAPHY for a Global Tax Library mapping row — the Geo Country (and Geo State) a Tax Rate needs, created only
 * when missing, after the user's explicit confirmation (the route requires `confirmed: true`). Never invents an Id: every Id returned
 * was read from, or returned by, Salesforce and then read back.
 *
 * Identity (never names):
 *  · Geo Country = GeoCountry.IsoCode (ISO 3166-1 alpha-2, e.g. "CA"; unique in Salesforce).
 *  · Geo State   = GeoState.IsoCode (the ISO 3166-2 suffix, e.g. "BC" for CA-BC) AND GeoState.GeoCountryId = that Geo Country's Id.
 *    GeoState.IsoCode is NOT unique in Salesforce, so a "BC" under another country is never reused.
 *
 * Sequence: fresh Geo Country lookup → create it if missing (a concurrent duplicate → re-read and reuse) → fresh Geo State lookup
 * under that parent → create it if missing with GeoCountryId = the parent's real Id → read back and verify IsoCode + parent.
 * If the Geo Country is created but the Geo State fails, the result says exactly that (the Geo Country is kept).
 * Identical concurrent requests (double clicks) share one in-flight run, so they can't create two Geo States.
 */

export interface GeoFieldMeta { createable: boolean; required: boolean }
export interface GeoObjectMeta { createable: boolean; fields: Record<string, GeoFieldMeta> }
export type CreateResult = { ok: true; id: string } | { ok: false; status: number; errorCode: string | null; message: string };
export interface GeoApi {
  query(soql: string): Promise<Record<string, unknown>[]>;
  create(sobject: "GeoCountry" | "GeoState", fields: Record<string, string>): Promise<CreateResult>;
  meta(sobject: "GeoCountry" | "GeoState"): Promise<GeoObjectMeta | null>;
}

export interface EnsureGeoInput {
  country: { iso: string; name: string };
  /** `code` = ISO 3166-2 (e.g. "CA-BC"); its suffix is the Salesforce GeoState.IsoCode. */
  state?: { code: string; name: string } | null;
}
export interface GeoRef { id: string; name: string; isoCode: string; created: boolean }
export interface EnsureGeoResult {
  ok: boolean;
  country: GeoRef | null;
  state: (GeoRef & { geoCountryId: string }) | null;
  steps: { action: "found" | "created" | "reused-after-duplicate" | "verified" | "failed"; object: "GeoCountry" | "GeoState"; detail: string }[];
  /** Salesforce's own error (or the app's refusal), when not ok. */
  error: string | null;
  /** Set when something WAS created before the failure (e.g. Geo Country created, Geo State failed). */
  partial: string | null;
}

const lit = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** ISO 3166-2 "CA-BC" → "BC" (what GeoState.IsoCode stores; verified in p10: "AP" for IN-AP). */
export const stateIsoOf = (code: string) => (code.includes("-") ? code.slice(code.indexOf("-") + 1) : code).toUpperCase();

export function validateEnsureInput(i: EnsureGeoInput): string | null {
  const cc = i.country?.iso?.toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(cc)) return "Country ISO code must be the 2-letter ISO 3166-1 code.";
  if (!i.country.name?.trim()) return "Country name is required.";
  if (i.state) {
    if (!i.state.code?.toUpperCase().startsWith(`${cc}-`)) return `Subdivision ${i.state.code} isn't an ISO 3166-2 code of ${cc} — it can't be created under that Geo Country.`;
    if (!/^[A-Z0-9]{1,3}$/.test(stateIsoOf(i.state.code))) return `Subdivision code ${stateIsoOf(i.state.code)} doesn't fit GeoState.IsoCode (1–3 letters/digits).`;
    if (!i.state.name?.trim()) return "Subdivision name is required.";
  }
  return null;
}

/** The fields we send must be createable, and no OTHER required field may be left empty (from the org's Describe). */
export function metaProblem(sobject: string, meta: GeoObjectMeta | null, sending: string[]): string | null {
  if (!meta) return `${sobject} isn't available to your Salesforce user in this org.`;
  if (!meta.createable) return `Your Salesforce user can't create ${sobject} records (needs the Create permission on ${sobject === "GeoCountry" ? "Geo Country" : "Geo State"}).`;
  const notCreateable = sending.filter(f => meta.fields[f] && !meta.fields[f].createable);
  if (notCreateable.length) return `${sobject} field(s) ${notCreateable.join(", ")} aren't createable for your user.`;
  const missing = sending.filter(f => !meta.fields[f] && f !== "Name");
  if (missing.length) return `${sobject} has no field ${missing.join(", ")} in this org.`;
  const otherRequired = Object.entries(meta.fields).filter(([n, f]) => f.required && !sending.includes(n)).map(([n]) => n);
  if (otherRequired.length) return `${sobject} requires ${otherRequired.join(", ")} in this org, which the Tax Library can't fill — create it under Taxes → ${sobject === "GeoCountry" ? "Geo Countries" : "Geo States"}.`;
  return null;
}

const inflight = new Map<string, Promise<EnsureGeoResult>>();

/** `scope` keeps identical requests of different orgs/users apart (e.g. instance URL + user). */
export function ensureGeography(api: GeoApi, input: EnsureGeoInput, scope = ""): Promise<EnsureGeoResult> {
  const key = `${scope}|${input.country?.iso?.toUpperCase()}|${input.state ? stateIsoOf(input.state.code) : ""}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = run(api, input).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function run(api: GeoApi, input: EnsureGeoInput): Promise<EnsureGeoResult> {
  const out: EnsureGeoResult = { ok: false, country: null, state: null, steps: [], error: null, partial: null };
  const fail = (msg: string) => { out.error = msg; return out; };
  const bad = validateEnsureInput(input);
  if (bad) return fail(bad);
  const cc = input.country.iso.toUpperCase();
  const countryName = input.country.name.trim();

  // 1. Geo Country — fresh lookup by ISO code.
  const findCountry = async () => (await api.query(`SELECT Id, Name, IsoCode FROM GeoCountry WHERE IsoCode = ${lit(cc)} LIMIT 2`))[0] ?? null;
  let c: Record<string, unknown> | null = await findCountry();
  if (c) out.steps.push({ action: "found", object: "GeoCountry", detail: `${s(c.Name)} (${cc}) ${s(c.Id)}` });
  else {
    const problem = metaProblem("GeoCountry", await api.meta("GeoCountry"), ["Name", "IsoCode"]);
    if (problem) { out.steps.push({ action: "failed", object: "GeoCountry", detail: problem }); return fail(problem); }
    const r = await api.create("GeoCountry", { Name: countryName, IsoCode: cc });
    if (!r.ok) {
      // IsoCode is unique: a concurrent create (another tab/user) wins → reuse it rather than fail.
      c = r.errorCode === "DUPLICATE_VALUE" ? await findCountry() : null;
      if (!c) { out.steps.push({ action: "failed", object: "GeoCountry", detail: r.message }); return fail(`Salesforce didn't create Geo Country ${countryName} (${cc}): ${r.message}`); }
      out.steps.push({ action: "reused-after-duplicate", object: "GeoCountry", detail: `${s(c.Name)} (${cc}) ${s(c.Id)}` });
    } else {
      c = (await api.query(`SELECT Id, Name, IsoCode FROM GeoCountry WHERE Id = ${lit(r.id)} LIMIT 1`))[0] ?? null;
      if (!c || s(c.IsoCode).toUpperCase() !== cc) return fail(`Geo Country ${r.id} was created but couldn't be read back with ISO code ${cc}.`);
      out.steps.push({ action: "created", object: "GeoCountry", detail: `${s(c.Name)} (${cc}) ${r.id}` });
    }
  }
  out.country = { id: s(c.Id), name: s(c.Name), isoCode: cc, created: out.steps.some(x => x.object === "GeoCountry" && x.action === "created") };
  if (!input.state) { out.ok = true; return out; }

  // 2. Geo State — fresh lookup by ISO suffix UNDER this Geo Country's Id (never by ISO code alone).
  const iso = stateIsoOf(input.state.code);
  const parentId = out.country.id;
  const findState = async () => (await api.query(`SELECT Id, Name, IsoCode, GeoCountryId FROM GeoState WHERE IsoCode = ${lit(iso)} AND GeoCountryId = ${lit(parentId)} LIMIT 2`))[0] ?? null;
  let st: Record<string, unknown> | null = await findState();
  if (st) out.steps.push({ action: "found", object: "GeoState", detail: `${s(st.Name)} (${iso}) ${s(st.Id)} under ${out.country.name}` });
  else {
    const partial = out.country.created ? `Geo Country ${out.country.name} (${cc}, ${parentId}) was created and is kept, but ` : "";
    const problem = metaProblem("GeoState", await api.meta("GeoState"), ["Name", "IsoCode", "GeoCountryId"]);
    if (problem) { out.steps.push({ action: "failed", object: "GeoState", detail: problem }); out.partial = partial ? `${partial}Geo State ${input.state.name} wasn't created.` : null; return fail(problem); }
    const r = await api.create("GeoState", { Name: input.state.name.trim(), IsoCode: iso, GeoCountryId: parentId });
    if (!r.ok) {
      out.steps.push({ action: "failed", object: "GeoState", detail: r.message });
      out.partial = partial ? `${partial}Geo State ${input.state.name} wasn't created.` : null;
      return fail(`Salesforce didn't create Geo State ${input.state.name} (${iso}) under ${out.country.name}: ${r.message}`);
    }
    st = (await api.query(`SELECT Id, Name, IsoCode, GeoCountryId FROM GeoState WHERE Id = ${lit(r.id)} LIMIT 1`))[0] ?? null;
    if (!st || s(st.IsoCode).toUpperCase() !== iso || s(st.GeoCountryId).slice(0, 15) !== parentId.slice(0, 15)) return fail(`Geo State ${r.id} was created but its read-back doesn't show ISO ${iso} under ${out.country.name} (${parentId}).`);
    out.steps.push({ action: "created", object: "GeoState", detail: `${s(st.Name)} (${iso}) ${r.id} under ${out.country.name}` });
  }
  out.steps.push({ action: "verified", object: "GeoState", detail: `GeoState.GeoCountryId = ${s(st.GeoCountryId)} (${out.country.name})` });
  out.state = { id: s(st.Id), name: s(st.Name), isoCode: iso, geoCountryId: s(st.GeoCountryId), created: out.steps.some(x => x.object === "GeoState" && x.action === "created") };
  out.ok = true;
  return out;
}

/** Read-back after a Tax Rate is created: does it reference exactly the intended Geo Country / Geo State? */
export function verifyRateGeo(row: { GeoCountryId?: unknown; GeoStateId?: unknown } | null, expected: { geoCountryId: string; geoStateId: string | null }): { ok: boolean; message: string } {
  if (!row) return { ok: false, message: "The Tax Rate couldn't be read back." };
  const same = (a: unknown, b: string | null) => (b === null ? !a : !!a && s(a).slice(0, 15) === b.slice(0, 15));
  const c = same(row.GeoCountryId, expected.geoCountryId), st = same(row.GeoStateId, expected.geoStateId);
  return c && st
    ? { ok: true, message: `Verified in Salesforce: GeoCountryId = ${expected.geoCountryId}${expected.geoStateId ? `, GeoStateId = ${expected.geoStateId}` : " (no Geo State)"}.` }
    : { ok: false, message: `The saved Tax Rate references GeoCountryId ${s(row.GeoCountryId) || "—"} / GeoStateId ${s(row.GeoStateId) || "—"}, not the mapping's ${expected.geoCountryId} / ${expected.geoStateId ?? "—"} (the lookup was changed in the form).` };
}
