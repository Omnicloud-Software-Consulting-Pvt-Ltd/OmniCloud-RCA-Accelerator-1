/** Envelope building, status mapping, contract/org ownership and signed-file idempotency — against a fake DocuSign API (MOCKED). */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocuSignApi } from "./client";
import { DocuSignApiError, docuSignApi } from "./client";
import { CONTRACT_FIELD, EnvelopeNotFoundError, ORG_FIELD, buildEnvelopeDefinition, correctRecipient, getContractEnvelope, listContractEnvelopes, signerTabs, toEnvelopeView } from "./envelopes";
import { allowedEnvelopeActions, assertActionAllowed, envelopeStatusView, recipientStatusLabel } from "./status";
import { parseSignedFileDescription, planSignedFiles, signedFileDescription } from "./signedDocuments";
import type { RecipientInput } from "./types";

const CONTRACT = "800A0000000001AAA";
const ORG = "acme.my.salesforce.com";
const ENV1 = "11111111-aaaa-bbbb-cccc-000000000001";

const r = (o: Partial<RecipientInput>): RecipientInput => ({ key: "k", name: "Pat Lee", email: "pat@example.com", type: "signer", role: "", order: 1, ...o });

test("envelope definition: documents, routing order, recipient types, hidden contract/org fields, status 'sent'", () => {
  const def = buildEnvelopeDefinition({
    contractId: CONTRACT, orgKey: ORG,
    documents: [{ title: "MSA", fileExtension: "PDF", base64: "QUJD" }, { title: "Annex.docx", fileExtension: "docx", base64: "REVG" }],
    recipients: [
      r({ name: "Pat Lee", order: 1, note: "Thanks!", placement: { mode: "free", includeDate: false, includeName: false, includeInitials: false } }),
      r({ name: "Sam Ops", email: "sam@example.com", type: "cc", order: 2 }),
      r({ name: "Viv Legal", email: "viv@example.com", type: "viewer", order: 2 }),
    ],
    emailSubject: "Please sign {{ContractName}}", emailMessage: "From {{CompanyName}}", placeholders: { ContractName: "MSA 2026", CompanyName: "Acme" },
  }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(def.status, "sent");
  assert.equal(def.emailSubject, "Please sign MSA 2026");
  assert.equal(def.emailBlurb, "From Acme");
  assert.deepEqual(def.documents.map((d: { documentId: string; name: string; fileExtension: string }) => [d.documentId, d.name, d.fileExtension]), [["1", "MSA.pdf", "pdf"], ["2", "Annex.docx", "docx"]]);
  assert.deepEqual(def.recipients.signers.map((s: Record<string, string>) => [s.recipientId, s.routingOrder, s.note]), [["1", "1", "Thanks!"]]);
  assert.equal(def.recipients.signers[0].tabs, undefined, "free-form: no tabs, the signer places their own signature");
  assert.equal(def.recipients.carbonCopies[0].email, "sam@example.com");
  assert.equal(def.recipients.certifiedDeliveries[0].routingOrder, "2");
  assert.deepEqual(def.customFields.textCustomFields.map((f: Record<string, string>) => [f.name, f.value, f.show]), [[CONTRACT_FIELD, CONTRACT, "false"], [ORG_FIELD, ORG, "false"]]);
});

test("{{RecipientName}} gives each recipient their own resolved email", () => {
  const def = buildEnvelopeDefinition({ contractId: CONTRACT, orgKey: ORG, documents: [{ title: "a", fileExtension: "pdf", base64: "" }],
    recipients: [r({ name: "Pat", placement: { mode: "free", includeDate: false, includeName: false, includeInitials: false } }), r({ name: "Sam", email: "s@example.com", type: "cc", order: 2 })],
    emailSubject: "Hi {{RecipientName}}", emailMessage: "Dear {{RecipientName}}", placeholders: {} }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(def.recipients.signers[0].emailNotification.emailSubject, "Hi Pat");
  assert.equal(def.recipients.carbonCopies[0].emailNotification.emailBody, "Dear Sam");
});

test("signature fields: anchor tabs fail loudly if the text is missing; fixed tabs use page + position", () => {
  const anchor = signerTabs({ mode: "anchor", anchorText: "Customer Signed Date:", includeDate: true, includeName: true, includeInitials: true })!;
  assert.equal(anchor.signHereTabs[0].anchorString, "Customer Signed Date:");
  assert.equal(anchor.signHereTabs[0].anchorIgnoreIfNotPresent, "false");
  assert.ok(anchor.dateSignedTabs && anchor.fullNameTabs && anchor.initialHereTabs);
  const fixed = signerTabs({ mode: "fixed", page: 3, position: "bottom-right", includeDate: false, includeName: false, includeInitials: false })!;
  assert.deepEqual([fixed.signHereTabs[0].pageNumber, fixed.signHereTabs[0].documentId], ["3", "1"]);
  assert.equal(fixed.dateSignedTabs, undefined);
  assert.equal(signerTabs({ mode: "free", includeDate: true, includeName: true, includeInitials: true }), undefined);
});

test("status mapping uses DocuSign's values; actions follow the envelope state", () => {
  assert.equal(envelopeStatusView("completed").label, "Completed");
  assert.equal(envelopeStatusView("voided", "Envelope has expired.").label, "Expired");
  assert.equal(envelopeStatusView("voided", "Customer changed mind").label, "Voided");
  assert.equal(envelopeStatusView("timedout").label, "Expired");
  assert.equal(envelopeStatusView("weird").label, "weird");
  assert.equal(recipientStatusLabel("autoresponded"), "Email bounced");
  assert.deepEqual(allowedEnvelopeActions("sent"), ["resend", "correct", "void"]);
  assert.deepEqual(allowedEnvelopeActions("completed"), ["download-signed", "download-certificate", "store"]);
  assert.deepEqual(allowedEnvelopeActions("voided"), []);
  assert.match(assertActionAllowed("sent", "download-signed")!, /only after everyone has signed/);
  assert.match(assertActionAllowed("completed", "void")!, /can't be done/);
  assert.equal(assertActionAllowed("delivered", "resend"), null);
});

test("envelope view: signer progress, documents without the certificate, correctable recipients only while in flight", () => {
  const raw = { envelopeId: ENV1, status: "delivered", recipients: {
    signers: [{ recipientId: "1", name: "Pat", email: "p@x.com", routingOrder: "1", status: "completed" }, { recipientId: "2", name: "Sam", email: "s@x.com", routingOrder: "2", status: "sent" }],
    carbonCopies: [{ recipientId: "3", name: "Ops", email: "o@x.com", routingOrder: "3", status: "created" }],
  }, envelopeDocuments: [{ documentId: "1", name: "MSA.pdf", type: "content" }, { documentId: "certificate", name: "Summary", type: "summary" }] };
  const v = toEnvelopeView(raw);
  assert.deepEqual([v.signedCount, v.signerCount], [1, 2]);
  assert.deepEqual(v.documents, [{ documentId: "1", name: "MSA.pdf" }]);
  assert.deepEqual(v.recipients.map(x => [x.name, x.canCorrect]), [["Pat", false], ["Sam", true], ["Ops", true]]);
  assert.equal(toEnvelopeView({ ...raw, status: "completed" }).recipients.some(x => x.canCorrect), false);
});

function fakeApi(envelopes: Record<string, unknown>[]): DocuSignApi & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    accountId: "acc", calls,
    async json<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (method !== "GET") return {} as T;
      if (path.startsWith("/envelopes?")) return { envelopes } as T;
      const m = /^\/envelopes\/([^/?]+)(\/custom_fields)?/.exec(path);
      const env = envelopes.find(e => e.envelopeId === m?.[1]);
      if (!env) throw new DocuSignApiError("not found", 404, "ENVELOPE_DOES_NOT_EXIST", null);
      return (m?.[2] ? env.customFields : env) as T;
    },
    async binary() { return { buffer: Buffer.from("%PDF"), contentType: "application/pdf" }; },
  };
}
const fields = (contract: string, org: string) => ({ textCustomFields: [{ name: CONTRACT_FIELD, value: contract }, { name: ORG_FIELD, value: org }] });

test("authorization boundary: only envelopes of THIS contract and org are listed or opened", async () => {
  const api = fakeApi([
    { envelopeId: ENV1, status: "sent", customFields: fields(CONTRACT, ORG) },
    { envelopeId: "22222222-aaaa-bbbb-cccc-000000000002", status: "sent", customFields: fields("800A0000000009AAA", ORG) },
    { envelopeId: "33333333-aaaa-bbbb-cccc-000000000003", status: "sent", customFields: fields(CONTRACT, "other.my.salesforce.com") },
  ]);
  const list = await listContractEnvelopes(api, CONTRACT, ORG);
  assert.deepEqual(list.map(e => e.envelopeId), [ENV1]);
  assert.ok(api.calls[0].path.includes(encodeURIComponent(`${CONTRACT_FIELD}=${CONTRACT}`)));
  assert.equal((await getContractEnvelope(api, ENV1, CONTRACT, ORG)).view.envelopeId, ENV1);
  await assert.rejects(getContractEnvelope(api, "22222222-aaaa-bbbb-cccc-000000000002", CONTRACT, ORG), EnvelopeNotFoundError);
  await assert.rejects(getContractEnvelope(api, "33333333-aaaa-bbbb-cccc-000000000003", CONTRACT, ORG), EnvelopeNotFoundError);
  await assert.rejects(getContractEnvelope(api, "44444444-aaaa-bbbb-cccc-000000000004", CONTRACT, ORG), EnvelopeNotFoundError);
});

test("envelopes listed without custom fields are checked one by one (never assumed to belong)", async () => {
  const api = fakeApi([{ envelopeId: ENV1, status: "sent" }]);
  (api as unknown as { json: DocuSignApi["json"] }).json = (async (method: string, path: string) => {
    if (path.startsWith("/envelopes?")) return { envelopes: [{ envelopeId: ENV1, status: "sent" }] };
    if (path.endsWith("/custom_fields")) return fields(CONTRACT, ORG);
    throw new Error("unexpected");
  }) as DocuSignApi["json"];
  assert.equal((await listContractEnvelopes(api, CONTRACT, ORG)).length, 1);
});

test("correcting a CC recipient updates the right DocuSign collection and resends", async () => {
  const api = fakeApi([]);
  await correctRecipient(api, ENV1, { recipientId: "3", type: "cc", name: " New Name ", email: "new@example.com" });
  assert.equal(api.calls[0].method, "PUT");
  assert.match(api.calls[0].path, /\/recipients\?resend_envelope=true$/);
  assert.deepEqual(api.calls[0].body, { carbonCopies: [{ recipientId: "3", name: "New Name", email: "new@example.com" }] });
});

test("signed files: marker round-trip; already-stored copies are reused, never duplicated", () => {
  const m = { kind: "signed" as const, envelopeId: ENV1, documentId: "1" };
  assert.deepEqual(parseSignedFileDescription(signedFileDescription(m)), m);
  assert.deepEqual(parseSignedFileDescription(signedFileDescription({ kind: "certificate", envelopeId: ENV1, documentId: null })), { kind: "certificate", envelopeId: ENV1, documentId: null });
  assert.equal(parseSignedFileDescription("Generated from template: MSA"), null);
  const docs = [{ documentId: "1", name: "MSA.pdf" }, { documentId: "2", name: "Annex.pdf" }];
  const plan = planSignedFiles(ENV1, docs, [
    { contentVersionId: "068A", title: "MSA - Signed", description: signedFileDescription(m) },
    { contentVersionId: "068B", title: "Other", description: signedFileDescription({ kind: "signed", envelopeId: "99999999-aaaa-bbbb-cccc-000000000009", documentId: "2" }) },
  ], "Contract 0001");
  assert.deepEqual(plan.map(p => [p.marker.kind, p.marker.documentId, p.title, p.existing?.contentVersionId ?? null]), [
    ["signed", "1", "MSA - Signed", "068A"],
    ["signed", "2", "Annex - Signed", null],
    ["certificate", null, "Contract 0001 - Certificate of Completion", null],
  ]);
});

test("client: one refresh + retry on 401, DocuSign errors keep their code, non-DocuSign hosts refused", async () => {
  let n = 0;
  const seen: string[] = [];
  const api = docuSignApi({ baseUri: "https://demo.docusign.net", accountId: "acc", tokens: { get: async () => "old", refresh: async () => "new" },
    fetchImpl: async (_url, init) => { seen.push((init!.headers as Record<string, string>).Authorization); n++; return n === 1 ? new Response("", { status: 401 }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 }); } });
  assert.deepEqual(await api.json("GET", "/envelopes/x"), { ok: 1 });
  assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
  const failing = docuSignApi({ baseUri: "https://demo.docusign.net", accountId: "acc", tokens: { get: async () => "t", refresh: async () => null },
    fetchImpl: async () => new Response(JSON.stringify({ errorCode: "ANCHOR_TAB_STRING_NOT_FOUND", message: "Anchor not found" }), { status: 400 }) });
  await assert.rejects(failing.json("POST", "/envelopes", {}), (e: unknown) => e instanceof DocuSignApiError && e.errorCode === "ANCHOR_TAB_STRING_NOT_FOUND" && e.status === 400);
  assert.throws(() => docuSignApi({ baseUri: "https://evil.example.com", accountId: "acc", tokens: { get: async () => "t", refresh: async () => null } }), /isn't a DocuSign address/);
});
