import { NextRequest, NextResponse } from "next/server";
import { soqlEscape } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveOrderFieldSchema, resolveOrderListFieldSchema, diagnoseOrderLookupFields } from "@/lib/orders/metadata/orderFields";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { buildOrderPayload } from "@/lib/orders/order/payload";
import type { BundleHierarchyStep } from "@/lib/quotes/types";
import type { OrderFormData, OrderListItem } from "@/lib/orders/types";

function step(steps: BundleHierarchyStep[], s: string, status: BundleHierarchyStep["status"], message: string, detail?: unknown) {
  steps.push({ step: s, status, message, detail, timestamp: Date.now() });
}

// POST /api/orders — create an Order (§3.9). No Name/versioning step (§3.5) —
// OrderNumber is system-assigned. Every resolution step is traced into
// `steps` and returned so the execution log can show exactly what
// metadata/fields/reference-Ids/payload were used before the Salesforce call.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const steps: BundleHierarchyStep[] = [];
  const warnings: string[] = [];

  let formData: OrderFormData;
  try {
    ({ formData } = await req.json());
    if (!formData?.accountName?.trim()) return NextResponse.json({ error: "Account is required" }, { status: 400 });
    if (!formData?.pricebookName?.trim()) return NextResponse.json({ error: "Price Book is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    step(steps, "resolve-metadata", "start", "Resolving Order field schema via Describe.");
    const schema = await resolveOrderFieldSchema(client);
    const lookupDiagnostics = await diagnoseOrderLookupFields(client);
    for (const d of lookupDiagnostics) {
      step(steps, "resolve-fields", d.includedInPayload ? "success" : "info", `${d.requestedApiName}: ${d.reason}`, d);
    }
    step(steps, "resolve-metadata", "success", "Order field schema resolved.", schema);

    step(steps, "resolve-references", "start", "Resolving Account/PriceBook/Contract/Source Quote by exact name.");
    const [account, pricebook, contract, sourceQuote] = await resolveReferencesByName(client, [
      { objectType: "Account", name: formData.accountName ?? "" },
      { objectType: "Pricebook2", name: formData.pricebookName ?? "" },
      { objectType: "Contract", name: formData.contractName ?? "" },
      { objectType: "Quote", name: formData.sourceQuoteName ?? "" },
    ]);
    step(steps, "resolve-references", "success", `Account=${account?.id ?? "none"}, Pricebook=${pricebook?.id ?? "none"}, Contract=${contract?.id ?? "none"}, SourceQuote=${sourceQuote?.id ?? "none"}`, { account, pricebook, contract, sourceQuote });

    if (formData.accountName?.trim() && account && !schema.accountField) {
      warnings.push(`Account "${account.name}" was found, but this org's Order object has no createable Account lookup field.`);
    }
    if (formData.pricebookName?.trim() && pricebook && !schema.pricebookField) {
      warnings.push(`Price Book "${pricebook.name}" was found, but this org's Order object has no createable Pricebook2 lookup field.`);
    }
    if (formData.contractName?.trim() && contract && !schema.contractField) {
      warnings.push(`Contract "${contract.name}" was found, but this org's Order object has no createable Contract lookup field.`);
    }
    if (formData.contractName?.trim() && !contract) {
      warnings.push(`Contract "${formData.contractName}" could not be resolved to an existing record.`);
    }
    if (schema.contractRequiredForContractedType && /contract/i.test(formData.type ?? "") && !contract) {
      warnings.push(`Type "${formData.type}" looks like it requires a Contract, but none was resolved — Salesforce may reject this create call.`);
    }

    const resolvedLookupIds = { accountId: account?.id ?? null, pricebookId: pricebook?.id ?? null, contractId: contract?.id ?? null, sourceQuoteId: sourceQuote?.id ?? null };
    const payload = buildOrderPayload(schema, formData, resolvedLookupIds);
    step(steps, "build-payload", "success", "Generated Order create payload.", payload);

    const preflight = { resolvedFieldMap: schema, fieldNames: Object.keys(payload), resolvedLookupIds, finalPayload: payload };
    step(steps, "preflight", "info", `Sending ${Object.keys(payload).length} field(s) to Salesforce: ${Object.keys(payload).join(", ")}`, preflight);

    step(steps, "salesforce-create", "start", "POST /sobjects/Order", payload);
    const result = await client.createRecord("Order", payload);
    if (!result.success) {
      step(steps, "salesforce-create", "error", "Salesforce rejected the create call.", result.errors);
      return NextResponse.json({ error: "Order creation was rejected by Salesforce.", details: result.errors, steps }, { status: 422 });
    }
    step(steps, "salesforce-create", "success", `Created Order ${result.id}.`, result);

    let orderNumber: string | null = null;
    try {
      const rec = await client.getRecord("Order", result.id, ["OrderNumber"]);
      orderNumber = (rec.OrderNumber as string) ?? null;
    } catch {
      orderNumber = null;
    }

    return NextResponse.json({
      success: true,
      id: result.id,
      orderNumber,
      resolvedLookups: { account, pricebook, contract, sourceQuote },
      payload,
      steps,
      warnings,
    });
  } catch (err) {
    step(steps, "error", "error", err instanceof Error ? err.message : "Unknown error");
    const res = sfErrorResponse(err, "Failed to create order");
    try {
      const body = await res.clone().json();
      return NextResponse.json({ ...body, steps, warnings }, { status: res.status });
    } catch {
      return res;
    }
  }
}

// GET /api/orders — history: 50 most recently modified Orders (§3.9).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const schema = await resolveOrderListFieldSchema(client);
    const selectFields = ["Id", "Status", "LastModifiedDate"];
    if (schema.orderNumberField) selectFields.push(schema.orderNumberField.apiName);
    if (schema.totalAmountField) selectFields.push(schema.totalAmountField.apiName);
    if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);
    if (schema.pricebookRelationshipField?.relationshipName) selectFields.push(`${schema.pricebookRelationshipField.relationshipName}.Name`);
    if (schema.contractRelationshipField?.relationshipName) selectFields.push(`${schema.contractRelationshipField.relationshipName}.ContractNumber`);

    const soql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM Order ORDER BY LastModifiedDate DESC LIMIT 50`;
    const result = await client.query<Record<string, unknown>>(soql);

    const ids = result.records.map(r => r.Id as string);
    let countByOrderId = new Map<string, number>();
    if (ids.length > 0) {
      try {
        const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
        const counts = await client.query<{ OrderId: string; expr0: number }>(
          `SELECT OrderId, COUNT(Id) expr0 FROM OrderItem WHERE OrderId IN (${idList}) GROUP BY OrderId`,
        );
        countByOrderId = new Map(counts.records.map(c => [c.OrderId, c.expr0]));
      } catch {
        // Aggregate query failed — line item counts are simply omitted, not a hard error.
      }
    }

    const items: OrderListItem[] = result.records.map(r => {
      const accountRel = schema.accountRelationshipField?.relationshipName ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      const pbRel = schema.pricebookRelationshipField?.relationshipName ? (r[schema.pricebookRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      const contractRel = schema.contractRelationshipField?.relationshipName ? (r[schema.contractRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      return {
        id: r.Id as string,
        orderNumber: schema.orderNumberField ? ((r[schema.orderNumberField.apiName] as string) ?? null) : null,
        totalAmount: schema.totalAmountField ? ((r[schema.totalAmountField.apiName] as number) ?? null) : null,
        status: (r.Status as string) ?? null,
        accountName: (accountRel?.Name as string) ?? null,
        pricebookName: (pbRel?.Name as string) ?? null,
        contractName: (contractRel?.ContractNumber as string) ?? null,
        lastModifiedDate: r.LastModifiedDate as string,
        lineItemCount: countByOrderId.get(r.Id as string) ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      orders: items,
      soql,
      relationshipNames: {
        account: schema.accountRelationshipField?.relationshipName ?? null,
        pricebook: schema.pricebookRelationshipField?.relationshipName ?? null,
        contract: schema.contractRelationshipField?.relationshipName ?? null,
      },
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list orders");
  }
}
