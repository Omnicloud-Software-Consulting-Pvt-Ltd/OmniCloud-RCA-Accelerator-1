import { test } from "node:test";
import assert from "node:assert/strict";
import type { SalesforceClient } from "@/lib/salesforce/client";
import type { OrderBillingState } from "@/lib/billing/server/orderBilling";
import {
  CHAIN_STAGES, CHAIN_WRITE_OBJECTS, chainApiFor, chainComplete, completePolicyChain, orderBillingPrerequisite, pickReferenceItem, planChain,
  type ChainApi, type ChainSnapshot, type ReferenceItem,
} from "@/lib/billing/server/policyChainCompletion";

const POLICY = "1BPg80000007BpxGAE", TREATMENT = "1BTg80000007qczGAA", DESKTOP = "01tg8000006f8uUAAQ";
const REF: ReferenceItem = { id: "1BDg8000000U6cfGAC", name: "Billing Treatment Item - Advance", treatmentName: "Billing Treatment - Advance", policyName: "Billing Policy - Advance", fields: { ProcessingOrder: 1, Type: "Remainder", BillingType: "Advance", Sequencing: "Manual", Controller: "BillingScheduleGroup", Handling0Amount: "CreateInvoice" } };

/** In-memory org that enforces the Salesforce platform rules the workflow depends on (R1, R2, R5) and logs every write. */
function org(o: { selection?: string; legalEntityId?: string | null; otherDefault?: string | null; required?: string[]; ref?: ReferenceItem | null; failOn?: string } = {}) {
  const s: ChainSnapshot = {
    policy: { id: POLICY, name: "Desktop Standard Billing Policy", status: "Draft", selection: o.selection ?? "Default", defaultTreatmentId: o.otherDefault ?? null },
    treatment: { id: TREATMENT, name: "Desktop Standard Billing Treatment", status: "Draft", policyId: POLICY, legalEntityId: o.legalEntityId ?? null, milestone: false, billable: true },
    items: [], products: [{ id: DESKTOP, name: "Desktop" }],
  };
  const writes: { op: string; sobject: string; id: string; body: unknown }[] = [];
  const reject = (error: string) => ({ ok: false as const, status: 400, code: "FIELD_CUSTOM_VALIDATION_EXCEPTION", error });
  const api: ChainApi = {
    snapshot: async () => structuredClone(s),
    referenceItem: async () => ({ item: o.ref === undefined ? REF : o.ref, candidates: o.ref === null ? [] : [{ id: REF.id, name: REF.name }] }),
    itemRequiredFields: async () => o.required ?? ["Name", "BillingTreatmentId", "Status", "ProcessingOrder", "Type"],
    createItem: async (t, fields) => {
      writes.push({ op: "create", sobject: "BillingTreatmentItem", id: "", body: fields });
      if (s.treatment!.status !== "Draft") return reject("Can't create or update a billing treatment item when the billing treatment is Active or Inactive.");
      const id = "1BDg8000000NEWAAA";
      s.items.push({ id, name: String(fields.Name), status: String(fields.Status), treatmentId: t.id, fields });
      return { ok: true, id };
    },
    update: async (sobject, id, change) => {
      writes.push({ op: "update", sobject, id, body: change });
      if (o.failOn === sobject) return reject("Simulated Salesforce rejection");
      if (sobject === "BillingTreatmentItem") { if (s.treatment!.status !== "Draft") return reject("R2"); s.items.find(i => i.id === id)!.status = String(change.fields!.Status); }
      if (sobject === "BillingTreatment") { if (!s.items.some(i => i.status === "Active")) return reject("A billable billing treatment must have at least one Active billing treatment item."); s.treatment!.status = String(change.fields!.Status); }
      if (sobject === "BillingPolicy") {
        if (change.references?.DefaultBillingTreatmentId) s.policy!.defaultTreatmentId = change.references.DefaultBillingTreatmentId.id;
        if (change.fields?.Status === "Active") { if (!s.policy!.defaultTreatmentId) return reject("Can't change status to Active when the default billing treatment is null."); s.policy!.status = "Active"; }
      }
      return { ok: true, id };
    },
  };
  return { api, s, writes };
}
const input = { policyId: POLICY, treatmentId: TREATMENT, productId: DESKTOP };

test("happy path: five confirmed stages in Salesforce's order, each verified → BILLING_CONFIGURATION_READY", async () => {
  const f = org();
  const preview = await completePolicyChain(f.api, input);
  assert.equal(preview.status, "AWAITING_CONFIRMATION");
  assert.equal(preview.next?.stage, "create-item");
  assert.equal(f.writes.length, 0, "a preview writes nothing");
  // preview shows object, operation, parent, all fields, lookups and lifecycle
  const c = preview.next!;
  assert.deepEqual([c.object, c.operation], ["BillingTreatmentItem", "create"]);
  assert.deepEqual(c.lookups, [{ field: "BillingTreatmentId", sobject: "BillingTreatment", id: TREATMENT, name: "Desktop Standard Billing Treatment" }]);
  assert.deepEqual(Object.fromEntries(c.fields.map(x => [x.field, x.to])), { Name: "Desktop Standard Billing Treatment Item", Status: "Draft", ProcessingOrder: 1, Type: "Remainder", BillingType: "Advance", Sequencing: "Manual", Controller: "BillingScheduleGroup", Handling0Amount: "CreateInvoice" });
  assert.ok(!JSON.stringify(c.fields).includes(REF.id), "no Ids copied from the model item");
  assert.ok(c.lifecycle.length > 0);

  for (const stage of CHAIN_STAGES) {
    const r = await completePolicyChain(f.api, { ...input, confirm: stage });
    assert.equal(r.performed?.stage, stage);
    assert.equal(r.performed?.verified, true, stage);
  }
  const done = await completePolicyChain(f.api, input);
  assert.equal(done.status, "BILLING_CONFIGURATION_READY");
  assert.deepEqual(f.writes.map(w => `${w.op}:${w.sobject}`), ["create:BillingTreatmentItem", "update:BillingTreatmentItem", "update:BillingTreatment", "update:BillingPolicy", "update:BillingPolicy"]);
});

test("no automatic chaining: one confirmation performs exactly one stage", async () => {
  const f = org();
  await completePolicyChain(f.api, { ...input, confirm: "create-item" });
  const r = await completePolicyChain(f.api, input);
  assert.equal(f.writes.length, 1);
  assert.equal(f.s.items[0].status, "Draft", "the item is not auto-activated");
  assert.equal(f.s.treatment!.status, "Draft", "the parent treatment is not auto-activated");
  assert.equal(r.next?.stage, "activate-item");
});

test("a confirmation for a stage that isn't next writes nothing", async () => {
  const f = org();
  const r = await completePolicyChain(f.api, { ...input, confirm: "activate-policy" });
  assert.equal(f.writes.length, 0);
  assert.match(r.message, /Nothing was changed/);
});

test("1. a Billing Treatment Item must exist (and be Active) before treatment activation", () => {
  const f = org();
  const st = planChain(f.s, { item: REF, candidates: [] }, []);
  const t = st.find(x => x.stage === "activate-treatment")!;
  assert.equal(t.state, "waiting");
  // Even planned in isolation, the treatment stage is blocked without an Active item.
  const s2 = structuredClone(f.s); s2.items = [{ id: "1BDg8000000NEWAAA", name: "x", status: "Draft", treatmentId: TREATMENT, fields: {} }];
  const st2 = planChain(s2, { item: REF, candidates: [] }, []);
  assert.equal(st2.find(x => x.stage === "activate-item")!.state, "ready");
  s2.items[0].status = "Active"; s2.treatment!.status = "Draft";
  assert.equal(planChain(s2, { item: REF, candidates: [] }, []).find(x => x.stage === "activate-treatment")!.state, "ready");
  s2.items[0].status = "Draft";
  const blocked = planChain({ ...s2, items: [] }, { item: REF, candidates: [] }, []);
  assert.equal(blocked.find(x => x.stage === "create-item")!.state, "ready");
});

test("Legal Entity: not required for Default selection; required (STOP, not invented) for LegalEntity selection", () => {
  const draftActiveItem = (sel: string) => { const f = org({ selection: sel }); f.s.items = [{ id: "1BDg8000000NEWAAA", name: "x", status: "Active", treatmentId: TREATMENT, fields: {} }]; return planChain(f.s, { item: REF, candidates: [] }, []); };
  assert.equal(draftActiveItem("Default").find(x => x.stage === "activate-treatment")!.state, "ready");
  const st = draftActiveItem("LegalEntity").find(x => x.stage === "activate-treatment")!;
  assert.equal(st.state, "blocked");
  assert.deepEqual([st.blockers[0].object, st.blockers[0].field], ["BillingTreatment", "LegalEntityId"]);
});

test("2. the treatment must be Active before it is assigned as the policy default", () => {
  const f = org(); f.s.items = [{ id: "1BDg8000000NEWAAA", name: "x", status: "Active", treatmentId: TREATMENT, fields: {} }];
  const st = planChain(f.s, { item: REF, candidates: [] }, []);
  assert.equal(st.find(x => x.stage === "set-default")!.state, "waiting");
  const forced = planChain({ ...f.s, treatment: { ...f.s.treatment!, status: "Draft" } }, { item: REF, candidates: [] }, []).find(x => x.stage === "set-default")!;
  assert.ok(forced.state !== "ready");
});

test("an existing different default treatment is never overwritten", () => {
  const f = org({ otherDefault: "1BTg80000007CIzGAM" }); f.s.items = [{ id: "1BDg8000000NEWAAA", name: "x", status: "Active", treatmentId: TREATMENT, fields: {} }]; f.s.treatment!.status = "Active";
  const st = planChain(f.s, { item: REF, candidates: [] }, []).find(x => x.stage === "set-default")!;
  assert.equal(st.state, "blocked");
  assert.match(st.blockers[0].message, /not overwritten/);
});

test("3. the policy default must be set before policy activation", () => {
  const f = org(); f.s.items = [{ id: "1BDg8000000NEWAAA", name: "x", status: "Active", treatmentId: TREATMENT, fields: {} }]; f.s.treatment!.status = "Active";
  const st = planChain(f.s, { item: REF, candidates: [] }, []);
  assert.equal(st.find(x => x.stage === "set-default")!.state, "ready");
  assert.equal(st.find(x => x.stage === "activate-policy")!.state, "waiting");
});

test("4. a policy is never reported READY while its treatment chain is incomplete", async () => {
  const f = org(); f.s.policy!.status = "Active"; // e.g. activated elsewhere with nothing behind it
  assert.equal(chainComplete(f.s), false);
  const r = await completePolicyChain(f.api, input);
  assert.notEqual(r.status, "BILLING_CONFIGURATION_READY");
  f.s.policy!.defaultTreatmentId = TREATMENT; f.s.treatment!.status = "Active";
  assert.equal(chainComplete(f.s), false, "an Active treatment without an Active item is still incomplete");
});

test("a Salesforce rejection is returned verbatim as STAGE_FAILED and nothing is reported done", async () => {
  const f = org({ failOn: "BillingTreatmentItem" });
  await completePolicyChain(f.api, { ...input, confirm: "create-item" });
  const r = await completePolicyChain(f.api, { ...input, confirm: "activate-item" });
  assert.equal(r.status, "STAGE_FAILED");
  assert.equal(r.performed?.salesforce?.error, "Simulated Salesforce rejection");
  assert.equal(f.s.items[0].status, "Draft");
});

test("missing model item or an org-required field the model can't supply blocks creation", () => {
  const f = org();
  assert.equal(planChain(f.s, { item: null, candidates: [] }, [])[0].state, "blocked");
  const st = planChain(f.s, { item: REF, candidates: [] }, ["Name", "InvoiceNumberStart"])[0];
  assert.equal(st.state, "blocked");
  assert.equal(st.blockers[0].field, "InvoiceNumberStart");
});

test("5–9. the whole workflow writes ONLY billing configuration objects — no Order activation, Billing Schedule, Invoice, InvoiceLineTax or tax configuration", async () => {
  const f = org();
  for (const stage of CHAIN_STAGES) await completePolicyChain(f.api, { ...input, confirm: stage });
  for (const w of f.writes) assert.ok(CHAIN_WRITE_OBJECTS.has(w.sobject), w.sobject);
  const touched = new Set(f.writes.map(w => w.sobject));
  for (const forbidden of ["Order", "OrderItem", "BillingSchedule", "Invoice", "InvoiceLine", "InvoiceLineTax", "TaxEngine", "TaxPolicy", "TaxTreatment", "TaxTreatmentItem", "TaxRate", "DecisionTable", "Product2"]) assert.ok(!touched.has(forbidden), forbidden);
  // No write ever sets an order status.
  assert.ok(!JSON.stringify(f.writes).includes("Activated"));
});

test("the real Salesforce adapter refuses any object outside billing configuration before calling Salesforce", async () => {
  const client = new Proxy({}, { get: () => { throw new Error("Salesforce must not be called"); } }) as unknown as SalesforceClient;
  const api = chainApiFor(client);
  for (const o of ["Order", "BillingSchedule", "Invoice", "InvoiceLineTax", "TaxTreatment"]) {
    await assert.rejects(api.update(o as "BillingPolicy", "801g800000ykKfjAAE", { fields: { Status: "Activated" } }), /Refusing to write/);
  }
});

test("order prerequisite (read-only): chain passes; remaining app setup is reported, not performed", () => {
  const state = {
    order: { id: "801g800000ykKfjAAE", number: "00000127", status: "Draft", activated: false },
    items: [{ id: "802g800000DWKlhAAH", product: { id: DESKTOP, name: "Desktop", code: "DS001" }, issues: [], pendingActions: ["billing-treatment"] }],
    readiness: { ready: false, checks: [], blockers: [] },
  } as unknown as OrderBillingState;
  const p = orderBillingPrerequisite(state);
  assert.equal(p.chainPassed, true);
  assert.equal(p.eligibleForActivation, true);
  assert.deepEqual(p.pendingSetup, [{ itemId: "802g800000DWKlhAAH", product: "Desktop", actions: ["billing-treatment"] }]);
  const blocked = orderBillingPrerequisite({ ...state, items: [{ ...state.items[0], issues: [{ severity: "error", message: 'Billing Policy "Desktop Standard Billing Policy" is Draft — activate it before billing this order.' }] }] } as OrderBillingState);
  assert.deepEqual([blocked.chainPassed, blocked.eligibleForActivation], [false, false]);
});

test("model item: identical Advance/Remainder patterns aren't ambiguous (oldest used); differing patterns are", () => {
  const a = { ...REF, id: "1BDg8000000U6cfGAC" }, b = { ...REF, id: "1BDg8000000W2BZGA0", name: "Desktop Standard Billing Treatment Item" };
  assert.equal(pickReferenceItem([a, b])?.id, a.id);
  assert.equal(pickReferenceItem([a, { ...b, fields: { ...b.fields, Handling0Amount: "None" } }]), null);
  assert.equal(pickReferenceItem([]), null);
});
