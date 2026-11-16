import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReferenceQuery, currencyFieldsToFormat, displayLabel, planReferences, readPath } from "@/lib/salesforce/recordReferences";
import type { DescribeField, DescribeResult } from "@/lib/salesforce/client";

const ref = (name: string, label: string, relationshipName: string | null, referenceTo: string[]): DescribeField => ({ name, label, type: "reference", relationshipName, referenceTo });

// Shape of p10's Order describe for the lookups the overview shows.
const ORDER: DescribeResult = {
  name: "Order", label: "Order", labelPlural: "Orders", recordTypeInfos: [], urls: {},
  fields: [
    { name: "Id", label: "Order ID", type: "id" },
    ref("AccountId", "Account ID", "Account", ["Account"]),
    ref("Pricebook2Id", "Price Book ID", "Pricebook2", ["Pricebook2"]),
    ref("OwnerId", "Owner ID", "Owner", ["Group", "User"]),
    ref("BillToContactId", "Bill To Contact ID", "BillToContact", ["Contact"]),
    ref("LegalEntityId", "Legal Entity ID", "LegalEntity", ["LegalEntity"]),
    ref("ContractId", "Contract ID", "Contract", ["Contract"]),
    { name: "TotalAmount", label: "Order Amount", type: "currency" },
    { name: "GrandTotalAmount", label: "Grand Total", type: "currency" },
  ],
};

const RECORD = {
  Id: "801g500000AbCdEAAA",
  AccountId: "001g5000000AbCdEAA",
  Pricebook2Id: "01sg50000000AbCdEA",
  OwnerId: "005g5000000AbCdEAA",
  BillToContactId: "003g5000000AbCdEAA",
  LegalEntityId: "0gwa5000000AbCdEAA",
  ContractId: null,
  TotalAmount: 1800,
  GrandTotalAmount: null,
};

const NAME_FIELDS: Record<string, string> = { Account: "Name", Pricebook2: "Name", Contact: "Name", Contract: "ContractNumber" };

test("plans a relationship path for every populated lookup, using the target's own name field", () => {
  const plans = planReferences(ORDER, RECORD, s => NAME_FIELDS[s] ?? null);
  assert.deepEqual(plans.map(p => [p.field, p.path]), [
    ["AccountId", "Account.Name"],
    ["Pricebook2Id", "Pricebook2.Name"],
    ["OwnerId", "Owner.Name"], // polymorphic → generic Name entity
    ["BillToContactId", "BillToContact.Name"],
    ["LegalEntityId", null], // target not describable → resolved by Id fallback
  ]);
  assert.ok(!plans.some(p => p.field === "ContractId"), "null lookups are skipped");
  assert.equal(plans[0].id, RECORD.AccountId, "raw Id is kept");
});

test("builds one query with relationship paths and FORMAT() for populated currency fields", () => {
  const plans = planReferences(ORDER, RECORD, s => NAME_FIELDS[s] ?? null);
  const currency = currencyFieldsToFormat(ORDER, RECORD);
  assert.deepEqual(currency, ["TotalAmount"]);
  assert.equal(
    buildReferenceQuery("Order", "801g500000AbCdEAAA", plans, currency),
    "SELECT Id, Account.Name, Pricebook2.Name, Owner.Name, BillToContact.Name, FORMAT(TotalAmount) fmt0 FROM Order WHERE Id = '801g500000AbCdEAAA'",
  );
  assert.equal(buildReferenceQuery("Order", "801g500000AbCdEAAA", [], []), null);
  assert.throws(() => buildReferenceQuery("Order; DELETE", "801g500000AbCdEAAA", plans, []));
});

test("readPath walks relationships and treats a missing parent as unresolved", () => {
  const row = { Account: { Name: "Acme Corp" }, Owner: null, Pricebook2: { Name: "  " } };
  assert.equal(readPath(row, "Account.Name"), "Acme Corp");
  assert.equal(readPath(row, "Owner.Name"), null);
  assert.equal(readPath(row, "Pricebook2.Name"), null);
  assert.equal(readPath(row, "LegalEntity.Name"), null);
});

test("reference labels drop the trailing ID", () => {
  assert.equal(displayLabel(ref("CreatedById", "Created By ID", "CreatedBy", ["User"])), "Created By");
  assert.equal(displayLabel({ name: "TotalAmount", label: "Order Amount", type: "currency" }), "Order Amount");
});
