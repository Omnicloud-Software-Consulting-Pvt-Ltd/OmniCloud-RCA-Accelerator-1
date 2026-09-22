/**
 * §TEMPORARY diagnostic — regression coverage for `captureDonorXmlDiagnostic`. Proves the capture is
 * byte-identical to the source (never reconstructed), the integrity hash actually verifies against an
 * independently-computed hash (not just the function's own self-report), the diagnostic never issues any
 * mutating Salesforce call, and normal donor content is never redacted (only genuine credential shapes).
 *
 * Needs a TypeScript-aware runner (e.g. `npx tsx --test`) to actually execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { SalesforceClient } from "@/lib/salesforce/client";
import { captureDonorXmlDiagnostic, redactCredentials } from "./donorXmlDiagnostic";
import { resolveAttributeBasedPricingDonor } from "./donorInspection";

const SAMPLE_DONOR_XML = `<ExpressionSetDefinition>
  <fullName>Rev_Mgmt_Default_Pricing_Procedure2_V1</fullName>
  <versions>
    <steps><name>PS1</name><actionType>PricingSettings</actionType><stepType>BusinessKnowledgeModel</stepType><label>Pricing Settings</label>
      <parameters><input>true</input><name>ContractId</name><output>false</output><type>Parameter</type><value>ItemContract</value></parameters>
      <parameters><input>false</input><name>NetUnitPrice</name><output>true</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
    </steps>
    <steps><name>ContractId</name><actionType>ListPrice</actionType><stepType>BusinessKnowledgeModel</stepType><label>List Price</label><parentStep>ListContainer11</parentStep>
      <parameters><input>false</input><name>Out</name><output>true</output><type>Parameter</type><value>ItemContractPrice</value></parameters>
    </steps>
    <steps><name>Product2Id</name><actionType>ListPrice</actionType><stepType>BusinessKnowledgeModel</stepType><label>Price Book Entries</label>
      <parameters><input>false</input><name>Out</name><output>true</output><type>Parameter</type><value>ListPrice</value></parameters>
    </steps>
    <steps><name>PriceAdjustmentScheduleId</name><actionType>AttributeDiscount</actionType><stepType>BusinessKnowledgeModel</stepType><label>Attribute Discount Entries</label><parentStep>ListContainer27</parentStep>
      <parameters><input>true</input><name>InputUnitPrice</name><output>false</output><type>Parameter</type><value>NetUnitPrice</value></parameters>
      <parameters><input>true</input><name>IsContractEnabled</name><output>false</output><type>Parameter</type><value>false</value></parameters>
    </steps>
  </versions>
</ExpressionSetDefinition>`;

async function buildMockClient(opts: { donorXml: string; guardAgainstMutation?: boolean }): Promise<SalesforceClient> {
  const zip = new JSZip();
  zip.file("unpackaged/expressionSetDefinitions/Rev_Mgmt_Default_Pricing_Procedure2_V1.expressionSetDefinition-meta.xml", opts.donorXml);
  const zipBase64 = await zip.generateAsync({ type: "base64" });

  const guard = (label: string) => {
    if (opts.guardAgainstMutation) throw new Error(`§TEST FAILURE — the read-only diagnostic must never call ${label}`);
  };

  return {
    apiVersion: "62.0",
    logDebug() { /* no-op */ },
    async metadataSoapCall(soapAction: string) {
      if (soapAction === "retrieve") return `<result><id>proc-1</id><done>true</done></result>`;
      if (soapAction === "checkRetrieveStatus") return `<result><id>proc-1</id><done>true</done><success>true</success><zipFile>${zipBase64}</zipFile></result>`;
      guard(`metadataSoapCall("${soapAction}")`);
      throw new Error(`unexpected metadataSoapCall: ${soapAction}`);
    },
    async createRecord() { guard("createRecord"); throw new Error("unexpected createRecord"); },
    async updateRecord() { guard("updateRecord"); throw new Error("unexpected updateRecord"); },
    async query() { guard("query"); throw new Error("unexpected query"); },
  } as unknown as SalesforceClient;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "donor-xml-diagnostic-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("§Requirement 3 — captured raw XML file is byte-identical to the original source, never reconstructed", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });

    assert.equal(result.success, true, `expected success; got: ${result.error}`);
    const written = await fs.readFile(result.artifactPaths!.rawXml, "utf8");
    assert.equal(written, SAMPLE_DONOR_XML, "the written file must be byte-for-byte identical to the original retrieved XML — no pretty-printing, no normalization, no reconstruction");
  });
});

test("§Requirement 1/4 — capture occurs before parsing: the reported hash matches an INDEPENDENTLY computed hash of the original source string, and hashesMatch is true", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });

    const independentHash = createHash("sha256").update(SAMPLE_DONOR_XML, "utf8").digest("hex");
    assert.equal(result.rawCaptureHash, independentHash, "rawCaptureHash must match a hash computed independently by this test, not just the function's own self-report");
    assert.equal(result.parserInputHash, independentHash);
    assert.equal(result.hashesMatch, true);
  });
});

test("§Requirement 5 — relevant.json's raw XML for each of the 4 target-type nodes is a literal, verbatim substring of the captured raw XML file (never reconstructed from parsed fields)", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });
    assert.equal(result.success, true);

    const rawXmlOnDisk = await fs.readFile(result.artifactPaths!.rawXml, "utf8");
    const relevant = JSON.parse(await fs.readFile(result.artifactPaths!.relevantNodes, "utf8"));

    assert.equal(relevant.pricingSettings.length, 1);
    assert.equal(relevant.listPrice.length, 2);
    assert.equal(relevant.attributeDiscount.length, 1);

    for (const category of ["pricingSettings", "listPrice", "attributeDiscount"] as const) {
      for (const node of relevant[category]) {
        assert.ok(
          rawXmlOnDisk.includes(node.completeRawXmlNode),
          `${category} [${node.occurrenceIndex}]'s completeRawXmlNode must be a literal substring of the captured raw XML — it is not`,
        );
      }
    }
  });
});

test("§Requirement 2/9 — variables.json builds its table from real parameter bindings found in the raw XML (never invented), and existing donor-selection behavior is unaffected by running this diagnostic", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });
    assert.equal(result.success, true);

    const { variables } = JSON.parse(await fs.readFile(result.artifactPaths!.variables, "utf8"));
    const netUnitPrice = variables.find((v: { variable: string }) => v.variable === "NetUnitPrice");
    assert.ok(netUnitPrice, "NetUnitPrice must appear in the variable table");
    assert.ok(netUnitPrice.producedBy.some((p: { name: string }) => p.name === "PS1"), "PricingSettings (PS1) must be recorded as producing NetUnitPrice");
    assert.ok(netUnitPrice.consumedBy.some((p: { name: string }) => p.name === "PriceAdjustmentScheduleId"), "AttributeDiscount must be recorded as consuming NetUnitPrice");

    // §Requirement 9 — running the diagnostic must not disturb the SEPARATE, real donor-selection path.
    const freshClient = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const donorResolution = await resolveAttributeBasedPricingDonor(freshClient);
    assert.ok(donorResolution.selection, "existing donor-selection behavior must be completely unaffected by this diagnostic module existing/running");
  });
});

test("§Requirement 6/7 — the diagnostic never issues a mutating Salesforce call (read-only)", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML, guardAgainstMutation: true });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });
    assert.equal(result.success, true, "the guarded mock client would have thrown if any mutating call were attempted — success here proves none was");
  });
});

test("§Requirement 8 — normal Salesforce Ids, variable names, and pricing configuration are NEVER redacted", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Rev_Mgmt_Default_Pricing_Procedure2_V1", outDir: dir });
    assert.deepEqual(result.redactionsApplied, [], "an ordinary donor XML (Ids, variable names, bindings, structure) must never trigger any redaction");
  });
});

test("§Requirement 8 — a genuine credential-shaped value IS redacted from the written file, and the redaction is explicitly reported (never silent)", () => {
  const withCredential = `<ExpressionSetDefinition><versions><steps><name>X</name><description>Authorization: Bearer sk-ant-abcdefghijklmnop1234567890</description></steps></versions></ExpressionSetDefinition>`;
  const { text, redactions } = redactCredentials(withCredential);
  assert.ok(!text.includes("sk-ant-abcdefghijklmnop1234567890"), "the credential value itself must not survive into the redacted text");
  assert.ok(redactions.length > 0, "a redaction must be explicitly reported, never silent");
});

test("donor not found among retrieved files is reported as a clean failure, never a throw or a guess", async () => {
  await withTempDir(async dir => {
    const client = await buildMockClient({ donorXml: SAMPLE_DONOR_XML });
    const result = await captureDonorXmlDiagnostic(client, { donorFullName: "Some_Other_Donor_Name", outDir: dir });
    assert.equal(result.success, false);
    assert.match(result.error!, /No retrieved ExpressionSetDefinition file matched/);
  });
});
