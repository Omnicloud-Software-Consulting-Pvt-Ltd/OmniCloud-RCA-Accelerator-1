/** Send-for-signature validation and placeholder resolution — pure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecipientInput } from "./types";
import { documentCompatibility, parseSendRequest, resolvePlaceholders, unknownPlaceholders, validateDocumentSelection, validateEmail, validateRecipients, validateSendRequest } from "./validation";

const signer = (o: Partial<RecipientInput> = {}): RecipientInput => ({ key: "1", name: "Pat Lee", email: "pat@example.com", type: "signer", role: "Customer", order: 1, placement: { mode: "free", includeDate: true, includeName: false, includeInitials: false }, ...o });

test("recipients: at least one signer, valid names/emails/order, signer placement required", () => {
  assert.deepEqual(validateRecipients([signer()]), []);
  assert.match(validateRecipients([])[0].message, /at least one recipient/);
  assert.ok(validateRecipients([signer({ type: "cc", placement: undefined })]).some(i => /at least one Signer/.test(i.message)));
  assert.ok(validateRecipients([signer({ email: "not-an-email" })]).some(i => /isn't a valid email/.test(i.message)));
  assert.ok(validateRecipients([signer({ name: "  " })]).some(i => /full name is required/.test(i.message)));
  assert.ok(validateRecipients([signer({ name: "<script>" })]).some(i => /can't contain/.test(i.message)));
  assert.ok(validateRecipients([signer({ order: 0 })]).some(i => /signing order/.test(i.message)));
  assert.ok(validateRecipients([signer({ order: 1.5 })]).some(i => /signing order/.test(i.message)));
  assert.ok(validateRecipients([signer({ placement: undefined })]).some(i => /where this signer signs/.test(i.message)));
  assert.ok(validateRecipients([signer({ placement: { mode: "anchor", anchorText: "", includeDate: false, includeName: false, includeInitials: false } })]).some(i => /text to place/.test(i.message)));
  assert.ok(validateRecipients([signer({ placement: { mode: "fixed", page: 0, position: "bottom-left", includeDate: false, includeName: false, includeInitials: false } })]).some(i => /Page must/.test(i.message)));
  assert.ok(validateRecipients([signer(), signer({ key: "2" })]).some(i => /already added/.test(i.message)), "same email + same role twice");
  assert.deepEqual(validateRecipients([signer(), signer({ key: "2", type: "cc", placement: undefined })]), [], "same person as signer and CC is allowed");
  assert.ok(validateRecipients(Array.from({ length: 21 }, (_, i) => signer({ key: String(i), email: `p${i}@example.com` }))).some(i => /up to 20/.test(i.message)));
});

test("documents: at least one, valid unique Salesforce Ids, at most 10", () => {
  assert.deepEqual(validateDocumentSelection(["068000000000001AAA"]), []);
  assert.match(validateDocumentSelection([])[0].message, /Select at least one/);
  assert.ok(validateDocumentSelection(["bad id"]).some(i => /invalid Id/.test(i.message)));
  assert.ok(validateDocumentSelection(["068000000000001AAA", "068000000000001AAA"]).some(i => /twice/.test(i.message)));
  assert.ok(validateDocumentSelection(Array.from({ length: 11 }, (_, i) => `0680000000000${String(i).padStart(2, "0")}AAA`)).some(i => /up to 10/.test(i.message)));
});

test("placeholders: allowlisted tokens replaced as plain text, never re-evaluated; unknown tokens reported", () => {
  const values = { ContractName: "MSA {{RecipientName}}", RecipientName: "Pat", CompanyName: "Acme\nInc" };
  assert.equal(resolvePlaceholders("Hi {{RecipientName}}, sign {{ ContractName }} from {{CompanyName}}", values), "Hi Pat, sign MSA {{RecipientName}} from Acme Inc");
  assert.deepEqual(unknownPlaceholders("{{ContractName}} {{Secret}} {{constructor}}"), ["Secret", "constructor"]);
  assert.equal(resolvePlaceholders("{{Unknown}}", values), "{{Unknown}}");
});

test("email: subject required and limited to DocuSign's 100 characters after placeholders are filled in", () => {
  assert.deepEqual(validateEmail("Please sign {{ContractName}}", "Hello", { ContractName: "MSA" }), []);
  assert.ok(validateEmail("", "x", {}).some(i => /subject is required/.test(i.message)));
  assert.ok(validateEmail("{{ContractName}}", "x", { ContractName: "x".repeat(101) }).some(i => /DocuSign allows 100/.test(i.message)));
  assert.ok(validateEmail("Sign {{Nope}}", "x", {}).some(i => /Unknown placeholder/.test(i.message)));
});

test("parseSendRequest keeps only expected fields; validateSendRequest combines all rules", () => {
  const parsed = parseSendRequest({ documentIds: ["068000000000001AAA"], recipients: [{ ...signer(), evil: true, placement: { mode: "anchor", anchorText: " Customer Signed Date: ", includeDate: true, extra: 1 } }], emailSubject: "S", emailMessage: "M", accountId: "spoofed", tenantId: "x" });
  assert.equal("accountId" in parsed, false);
  assert.equal("evil" in parsed.recipients[0], false);
  assert.equal(parsed.recipients[0].placement?.anchorText, "Customer Signed Date:");
  assert.deepEqual(validateSendRequest(parsed, { ContractName: "MSA" }), []);
  assert.ok(validateSendRequest(parseSendRequest(null), {}).length >= 3);
});

test("document compatibility: DocuSign formats and the 25 MB limit", () => {
  assert.equal(documentCompatibility("PDF", 1000).compatible, true);
  assert.equal(documentCompatibility("docx", 1000).compatible, true);
  assert.match(documentCompatibility("exe", 10).reason!, /can't sign \.exe/);
  assert.match(documentCompatibility("pdf", 26 * 1024 * 1024).reason!, /25 MB/);
});
