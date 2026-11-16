import { normalizeApiVersionNumber, soqlEscape, type SalesforceClient } from "@/lib/salesforce/client";
import { buildSalesforceRecordUrl } from "@/lib/salesforce/recordUrl";
import { getBillingModule } from "@/lib/billing/registry";
import { billingDescribe, nameFieldOf } from "@/lib/billing/server/discovery";
import { prepareAndValidate, type PreparedNode } from "@/lib/billing/server/validate";
import { summarizeSalesforceErrors, type SalesforceErrorItem } from "@/lib/billing/server/errors";
import type { BillingCreateResponse, BillingDraftLink, BillingDraftRecord, BillingValidationResult } from "@/lib/billing/types";

interface CompositeSubrequest {
  method: "POST" | "PATCH";
  url: string;
  referenceId: string;
  body: Record<string, unknown>;
}

interface CompositeResponse {
  compositeResponse: { body: unknown; httpStatusCode: number; referenceId: string }[];
}

export type BillingCreateOutcome =
  | { ok: true; response: BillingCreateResponse }
  | { ok: false; status: number; error: string; code: string | null; possibleCause: string | null; validation: BillingValidationResult; technical: unknown };

const refIdFor = (path: string) => (path ? `n_${path.replace(/\./g, "_")}` : "n_root");

/**
 * Validate (server-side, never trusting the client's own validation) and then
 * create the whole draft tree in ONE Composite request with allOrNone=true:
 * the parent, every child (wired to the parent via `@{ref.id}`), and any
 * opted-in inbound links (e.g. Product2.BillingPolicyId). Either everything
 * is saved or nothing is — no orphaned Treatments without their Items.
 */
export async function createBillingRecords(client: SalesforceClient, draft: BillingDraftRecord, links: BillingDraftLink[] = []): Promise<BillingCreateOutcome> {
  const { result: validation, nodes } = await prepareAndValidate(client, draft, links);
  const rootNode = nodes.find(n => n.path === "");
  const rootLabel = getBillingModule(draft.moduleKey)?.singular ?? "record";

  if (!validation.valid || !rootNode) {
    const firstError = validation.issues.find(i => i.severity === "error");
    return {
      ok: false, status: 422, code: "BILLING_VALIDATION_FAILED",
      error: firstError?.message ?? `The ${rootLabel} configuration isn't valid yet.`,
      possibleCause: "Fix the highlighted issues in the configuration and try again.",
      validation, technical: { issues: validation.issues },
    };
  }

  const base = `/services/data/v${normalizeApiVersionNumber(client.apiVersion)}`;
  const requests: CompositeSubrequest[] = [];
  const orderedNodes = [...nodes].sort((a, b) => a.path.split(".").length - b.path.split(".").length || a.path.localeCompare(b.path));
  for (const node of orderedNodes) {
    const body: Record<string, unknown> = { ...node.payload };
    if (node.parentPath !== null && node.parentField) body[node.parentField] = `@{${refIdFor(node.parentPath)}.id}`;
    requests.push({ method: "POST", url: `${base}/sobjects/${node.schema.sobject}`, referenceId: refIdFor(node.path), body });
  }

  // Lookups that point at a child created above (e.g. new policy → its new default treatment):
  // the child's Id only exists after insert, so set them with a PATCH in the SAME transaction.
  for (const node of orderedNodes) {
    if (node.childReferences.length === 0) continue;
    requests.push({
      method: "PATCH",
      url: `${base}/sobjects/${node.schema.sobject}/@{${refIdFor(node.path)}.id}`,
      referenceId: `${refIdFor(node.path)}_backfill`,
      body: Object.fromEntries(node.childReferences.map(cr => [cr.field, `@{${refIdFor(cr.childPath)}.id}`])),
    });
  }

  const appliedLinks: BillingCreateResponse["links"] = [];
  let linkIndex = 0;
  for (const link of links.filter(l => l.enabled)) {
    const value = link.valueSource === "self" ? `@{${refIdFor("")}.id}` : rootNode.payload[link.valueSource.field];
    for (const target of link.targets) {
      requests.push({ method: "PATCH", url: `${base}/sobjects/${link.sobject}/${target.id}`, referenceId: `l_${linkIndex++}`, body: { [link.field]: value } });
      appliedLinks.push({ sobject: link.sobject, field: link.field, recordId: target.id, recordName: target.name });
    }
  }

  const res = await client.request<CompositeResponse>("/composite", {
    method: "POST",
    body: JSON.stringify({ allOrNone: true, compositeRequest: requests }),
  });

  const failures = res.compositeResponse.filter(r => r.httpStatusCode >= 400);
  if (failures.length > 0) {
    const items: SalesforceErrorItem[] = failures.flatMap(f => (Array.isArray(f.body) ? (f.body as SalesforceErrorItem[]) : [{ message: String(f.body) }]));
    const failedNode = orderedNodes.find(n => failures.some(f => f.referenceId === refIdFor(n.path) && Array.isArray(f.body) && (f.body as SalesforceErrorItem[]).some(e => e.errorCode !== "PROCESSING_HALTED")));
    const schemaForLabels = failedNode?.schema ?? rootNode.schema;
    const summary = summarizeSalesforceErrors(items, {
      objectLabel: failedNode ? (getBillingModule(failedNode.moduleKey)?.singular ?? failedNode.schema.label) : rootLabel,
      fieldLabel: name => schemaForLabels.fields.find(f => f.name === name)?.label ?? name,
    });
    return {
      ok: false, status: 400, code: summary.code,
      error: `Nothing was saved. ${summary.message}`,
      possibleCause: summary.possibleCause,
      validation,
      technical: { compositeRequest: requests, compositeResponse: res.compositeResponse },
    };
  }

  const idByRef = new Map(res.compositeResponse.map(r => [r.referenceId, (r.body as { id?: string } | null)?.id ?? null]));
  const created = orderedNodes.map(n => ({ node: n, id: idByRef.get(refIdFor(n.path)) ?? "" })).filter(c => c.id);
  const names = await fetchNames(client, created);

  const toEntry = ({ node, id }: { node: PreparedNode; id: string }) => ({
    path: node.path,
    id,
    sobject: node.schema.sobject,
    name: names.get(id) ?? node.displayName ?? `${getBillingModule(node.moduleKey)?.singular ?? node.schema.label}`,
    salesforceUrl: buildSalesforceRecordUrl(client.instanceUrl, node.schema.sobject, id),
  });
  const entries = created.map(toEntry);
  const root = entries.find(e => e.path === "")!;

  return {
    ok: true,
    response: {
      success: true,
      root: { id: root.id, name: root.name, sobject: root.sobject, salesforceUrl: root.salesforceUrl },
      created: entries,
      links: appliedLinks,
      validation,
    },
  };
}

/** Auto-number names (e.g. Product Usage Grant numbers) only exist after insert — read them back once per object. */
async function fetchNames(client: SalesforceClient, created: { node: PreparedNode; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byObject = new Map<string, string[]>();
  for (const c of created) {
    if (!byObject.has(c.node.schema.sobject)) byObject.set(c.node.schema.sobject, []);
    byObject.get(c.node.schema.sobject)!.push(c.id);
  }
  await Promise.all([...byObject.entries()].map(async ([sobject, ids]) => {
    try {
      const nameField = nameFieldOf(await billingDescribe(client, sobject))?.name;
      if (!nameField) return;
      const res = await client.query<Record<string, unknown>>(`SELECT Id, ${nameField} FROM ${sobject} WHERE Id IN (${ids.map(id => `'${soqlEscape(id)}'`).join(",")})`);
      for (const r of res.records) out.set(r.Id as string, (r[nameField] as string) ?? (r.Id as string));
    } catch {
      // Names are cosmetic here — the records are already committed.
    }
  }));
  return out;
}
