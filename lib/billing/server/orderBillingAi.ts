// AI interpretation for the Order → Revenue Cloud Billing workspace. Claude only turns the user's
// sentence into structured instructions from a fixed action list; every name it returns is resolved
// against the order's real Salesforce state, and each proposed step is re-checked against the same
// readiness rules the buttons use. Nothing here writes to Salesforce — the user runs each step.
import type { OrderBillingState } from "./orderBilling";

export const ORDER_BILLING_ACTIONS = ["setup", "billing-details", "activate", "schedules", "invoice", "post", "refresh"] as const;
export type OrderBillingAction = (typeof ORDER_BILLING_ACTIONS)[number];

export interface OrderBillingPlanStep {
  action: OrderBillingAction;
  label: string;
  available: boolean;
  reason: string;
  /** Resolved against real records — only present when the name/choice matched exactly one. */
  contact?: { id: string; name: string } | null;
  addressSuggestion?: number | null;
}

export interface OrderBillingAiResult {
  success: true;
  summary: string;
  steps: OrderBillingPlanStep[];
  ignored: string[];
  warnings: string[];
}

const LABELS: Record<OrderBillingAction, string> = {
  setup: "Apply Order Actions & Billing Treatments",
  "billing-details": "Set billing details (Bill To Contact / addresses)",
  activate: "Activate Order & Start Billing",
  schedules: "Create Billing Schedules",
  invoice: "Generate Invoice",
  post: "Post Invoice",
  refresh: "Refresh Billing Status",
};

export const ORDER_BILLING_SYSTEM = `You interpret instructions for an existing Salesforce Order's Revenue Cloud Billing setup.
Return ONLY a JSON object: {"summary": string, "actions": string[], "billToContactName": string|null, "addressSource": string|null, "notes": string[]}.
- "actions" may contain only these values, in the order the user wants them: ${ORDER_BILLING_ACTIONS.join(", ")}.
  setup = create/link the Order Action and apply each Order Product's Billing Treatment; billing-details = set the Bill To Contact and/or billing/shipping address;
  activate = activate the order; schedules = ask Salesforce to create billing schedules; invoice = generate the invoice; post = post the draft invoice; refresh = re-read status.
- billToContactName: a contact NAME exactly as the user wrote it, or null. addressSource: the user's words describing which address to use, or null.
- Never output Salesforce Ids, field names, amounts, or records that the user didn't mention. Put anything you can't map into "notes".`;

export function orderContextForAi(state: OrderBillingState): string {
  return [
    `Order ${state.order.number} status=${state.order.status} account=${state.order.account?.name ?? "none"}`,
    `Order Products: ${state.items.map(i => `${i.product?.name} [${i.status}]`).join("; ") || "none"}`,
    `Account contacts: ${state.accountContacts.map(c => c.name).join(", ") || "none"}`,
    `Address options: ${state.addressSuggestions.map(s => s.source).join(" | ") || "none"}`,
    `Schedules: ${state.schedules.length}; invoices: ${state.invoices.map(i => `${i.number} ${i.status}`).join(", ") || "none"}`,
  ].join("\n");
}

/** Availability of each action — mirrors the server-side guards of the mutation endpoints. */
export function actionAvailability(state: OrderBillingState, action: OrderBillingAction): { available: boolean; reason: string } {
  const pendingSetup = state.items.some(i => i.pendingActions.length);
  const detailsMissing = state.readiness.checks.filter(c => ["billTo", "billingAddress", "shippingAddress"].includes(c.id) && c.status !== "passed");
  switch (action) {
    case "setup":
      return state.order.activated ? { available: false, reason: "The order is activated — Order Products can't be changed." }
        : pendingSetup ? { available: true, reason: `${state.items.filter(i => i.pendingActions.length).length} Order Product(s) need setup.` } : { available: false, reason: "Nothing to apply — already set up." };
    case "billing-details":
      return detailsMissing.length ? { available: true, reason: `Missing: ${detailsMissing.map(c => c.label.replace(/ set$/, "")).join(", ")}.` } : { available: false, reason: "Billing details are already complete." };
    case "activate":
      return state.order.activated ? { available: false, reason: "Already activated." } : state.readiness.ready ? { available: true, reason: "Readiness checks passed." } : { available: false, reason: state.readiness.blockers[0] ?? "Complete the pending setup steps first." };
    case "schedules":
      return state.scheduleCreation;
    case "invoice": {
      const ready = state.schedules.filter(s => !s.invoiced && /readyforinvoicing/i.test(s.status ?? ""));
      return ready.length ? { available: true, reason: `${ready.length} schedule(s) ready for invoicing.` } : { available: false, reason: state.schedules.length ? "No un-invoiced schedule is Ready for Invoicing." : "No billing schedules yet." };
    }
    case "post": {
      const draft = state.invoices.find(i => /^draft$/i.test(i.status ?? ""));
      return draft ? { available: true, reason: `${draft.number} is Draft.` } : { available: false, reason: state.invoices.length ? "No Draft invoice to post." : "No invoice yet." };
    }
    case "refresh":
      return { available: true, reason: "Re-reads the order from Salesforce." };
  }
}

export async function analyzeOrderBillingPrompt(state: OrderBillingState, extract: (system: string, prompt: string) => Promise<Record<string, unknown>>, prompt: string): Promise<OrderBillingAiResult> {
  const out = await extract(ORDER_BILLING_SYSTEM, `${orderContextForAi(state)}\n\nUser instruction: ${prompt}`);
  const warnings: string[] = [];
  const ignored: string[] = [];
  const raw = Array.isArray(out.actions) ? out.actions : [];
  const actions: OrderBillingAction[] = [];
  for (const a of raw) {
    if (typeof a === "string" && (ORDER_BILLING_ACTIONS as readonly string[]).includes(a)) { if (!actions.includes(a as OrderBillingAction)) actions.push(a as OrderBillingAction); }
    else ignored.push(String(a));
  }

  // Resolve the contact name against the order Account's real Contacts only.
  let contact: OrderBillingPlanStep["contact"] = undefined;
  if (typeof out.billToContactName === "string" && out.billToContactName.trim()) {
    const want = out.billToContactName.trim().toLowerCase();
    const matches = state.accountContacts.filter(c => c.name.toLowerCase() === want);
    const partial = matches.length ? matches : state.accountContacts.filter(c => c.name.toLowerCase().includes(want));
    if (partial.length === 1) contact = partial[0] && { id: partial[0].id, name: partial[0].name };
    else { contact = null; warnings.push(partial.length ? `"${out.billToContactName}" matches ${partial.length} Contacts — choose one in Billing Details.` : `No Contact named "${out.billToContactName}" on Account ${state.order.account?.name ?? ""}.`); }
    if (!actions.includes("billing-details")) actions.unshift("billing-details");
  }
  // Resolve the address wording against the real address suggestions only.
  let addressSuggestion: number | null | undefined = undefined;
  if (typeof out.addressSource === "string" && out.addressSource.trim()) {
    const words = out.addressSource.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const scored = state.addressSuggestions.map((s, i) => ({ i, score: words.filter(w => `${s.source} ${Object.values(s.address).join(" ")}`.toLowerCase().includes(w)).length }));
    const best = Math.max(0, ...scored.map(s => s.score));
    const top = scored.filter(s => s.score === best && best > 0);
    if (top.length === 1) addressSuggestion = top[0].i;
    else { addressSuggestion = null; warnings.push(state.addressSuggestions.length ? `Couldn't tell which address "${out.addressSource}" means — pick one in Billing Details.` : "No address is on file in Salesforce for this Account — enter it in Billing Details."); }
    if (!actions.includes("billing-details")) actions.unshift("billing-details");
  }
  if (Array.isArray(out.notes)) for (const n of out.notes) if (typeof n === "string" && n.trim()) warnings.push(n.trim());
  if (!actions.length) warnings.push("No supported billing action was recognised in the instruction.");

  const steps: OrderBillingPlanStep[] = actions.map(action => {
    const av = actionAvailability(state, action);
    return { action, label: LABELS[action], ...av, ...(action === "billing-details" ? { contact, addressSuggestion } : {}) };
  });
  return { success: true, summary: typeof out.summary === "string" ? out.summary : "", steps, ignored, warnings };
}
