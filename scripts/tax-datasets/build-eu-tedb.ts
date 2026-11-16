/**
 * Rebuilds lib/taxLibrary/datasets/eu-tedb-vat.json from the European Commission's official TEDB VAT retrieval service.
 *
 *   npx tsx scripts/tax-datasets/build-eu-tedb.ts [YYYY-MM-DD]
 *
 * Read-only: calls only the public TEDB SOAP endpoint (no key), 9 member states per request with a pause between requests.
 * Never touches Salesforce. The output is reference data that users import through the library's preview → confirm flow.
 */
import fs from "node:fs";
import path from "node:path";
import { EU_MEMBER_STATES, TEDB_ENDPOINT, TEDB_SOAP_ACTION, buildTedbRequest, parseTedbResponse, tedbManifest, tedbToRows, type TedbResult } from "../../lib/taxLibrary/tedb";

async function main() {
  const situationOn = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const results: TedbResult[] = [];
  for (let i = 0; i < EU_MEMBER_STATES.length; i += 9) {
    const batch = EU_MEMBER_STATES.slice(i, i + 9);
    const res = await fetch(TEDB_ENDPOINT, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${TEDB_SOAP_ACTION}"` }, body: buildTedbRequest([...batch], situationOn) });
    if (!res.ok) throw new Error(`TEDB HTTP ${res.status} for ${batch.join(",")}`);
    const parsed = parseTedbResponse(await res.text());
    console.log(`${batch.join(",")}: ${parsed.length} results`);
    results.push(...parsed);
    await new Promise(r => setTimeout(r, 1500));
  }
  const conv = tedbToRows(results, { retrievedOn: situationOn });
  const manifest = tedbManifest(conv, situationOn, [...EU_MEMBER_STATES]);
  const out = path.join(process.cwd(), "lib/taxLibrary/datasets/eu-tedb-vat.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ manifest, rows: conv.rows }, null, 0));
  console.log(`${results.length} TEDB results → ${conv.rows.length} rows (${conv.skipped.length} skipped) for ${conv.countries.length} countries → ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
