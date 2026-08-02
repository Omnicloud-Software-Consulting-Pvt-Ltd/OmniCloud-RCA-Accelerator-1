import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveContractFieldSchema, resolveContractListFieldSchema, diagnoseContractFields } from "@/lib/contracts/metadata/contractFields";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { verifyContactById } from "@/lib/contracts/contract/contact";
import { buildContractPayload } from "@/lib/contracts/contract/payload";
import type { BundleHierarchyStep } from "@/lib/quotes/types";
import type { ContractFormData, ContractListItem } from "@/lib/contracts/types";

function step(steps: BundleHierarchyStep[], s: string, status: BundleHierarchyStep["status"], message: string, detail?: unknown) {
  steps.push({ step: s, status, message, detail, timestamp: Date.now() });
}

// POST /api/contracts — create a Contract (§3.7). Every resolution step is
// traced into `steps` so the execution log can show exactly what
// metadata/fields/reference-Ids/payload were used before the Salesforce call.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const steps: BundleHierarchyStep[] = [];
  const warnings: string[] = [];

  let formData: ContractFormData;
  try {
    ({ formData } = await req.json());
    if (!formData?.accountName?.trim()) return NextResponse.json({ error: "Account is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    step(steps, "resolve-metadata", "start", "Resolving Contract field schema via Describe.");
    const schema = await resolveContractFieldSchema(client);
    step(steps, "resolve-metadata", "success", "Contract field schema resolved.", schema);

    step(steps, "resolve-references", "start", "Resolving Account/PriceBook/Company Signed By (User) by exact name.");
    const [account, pricebook, companySignedBy] = await resolveReferencesByName(client, [
      { objectType: "Account", name: formData.accountName ?? "" },
      { objectType: "Pricebook2", name: formData.pricebookName ?? "" },
      { objectType: "User", name: formData.companySignedByName ?? "" },
    ]);
    step(steps, "resolve-references", "success", `Account=${account?.id ?? "none"}, Pricebook=${pricebook?.id ?? "none"}, CompanySignedBy=${companySignedBy?.id ?? "none"}`, { account, pricebook, companySignedBy });

    // §3.3: the client-resolved Customer Signed By Contact Id is never trusted as-is — re-verify by Id.
    step(steps, "verify-customer-contact", "start", "Re-verifying Customer Signed By Contact by Id.");
    const customerSignedBy = await verifyContactById(client, formData.customerSignedById ?? "");
    step(steps, "verify-customer-contact", customerSignedBy ? "success" : "info", customerSignedBy ? `Verified ${customerSignedBy.name}.` : "No Customer Signed By Contact resolved.", customerSignedBy);

    if (formData.accountName?.trim() && !account) warnings.push(`Account "${formData.accountName}" could not be resolved to an existing record.`);
    if (formData.pricebookName?.trim() && !pricebook) warnings.push(`Price Book "${formData.pricebookName}" could not be resolved to an existing record.`);
    if (formData.companySignedByName?.trim() && !companySignedBy) warnings.push(`Company Signed By "${formData.companySignedByName}" could not be resolved to an existing User.`);
    if (formData.customerSignedById?.trim() && !customerSignedBy) warnings.push("The selected Customer Signed By Contact could not be re-verified server-side — it was omitted from the payload.");

    const resolvedLookupIds = {
      accountId: account?.id ?? null,
      pricebookId: pricebook?.id ?? null,
      companySignedById: companySignedBy?.id ?? null,
      customerSignedById: customerSignedBy?.id ?? null,
    };
    const payload = buildContractPayload(schema, formData, resolvedLookupIds);
    step(steps, "build-payload", "success", "Generated Contract create payload.", payload);
    step(steps, "preflight", "info", `Sending ${Object.keys(payload).length} field(s) to Salesforce: ${Object.keys(payload).join(", ")}`, { fieldNames: Object.keys(payload), payload });

    const fieldAudit = await diagnoseContractFields(client, schema, formData, payload);
    step(steps, "field-audit", "info", "Per-field createable/inclusion audit against this org's Describe.", fieldAudit);

    step(steps, "salesforce-create", "start", "POST /sobjects/Contract", payload);
    const result = await client.createRecord("Contract", payload);
    if (!result.success) {
      step(steps, "salesforce-create", "error", "Salesforce rejected the create call.", result.errors);
      return NextResponse.json({ error: "Contract creation was rejected by Salesforce.", details: result.errors, steps }, { status: 422 });
    }
    step(steps, "salesforce-create", "success", `Created Contract ${result.id}.`, result);

    let contractNumber: string | null = null;
    if (schema.contractNumberField) {
      try {
        const rec = await client.getRecord("Contract", result.id, [schema.contractNumberField.apiName]);
        contractNumber = (rec[schema.contractNumberField.apiName] as string) ?? null;
      } catch {
        contractNumber = null;
      }
    }

    return NextResponse.json({
      success: true,
      id: result.id,
      contractNumber,
      resolvedLookups: { account, pricebook, companySignedBy, customerSignedBy },
      payload,
      steps,
      warnings,
    });
  } catch (err) {
    step(steps, "error", "error", err instanceof Error ? err.message : "Unknown error");
    const res = sfErrorResponse(err, "Failed to create contract");
    try {
      const body = await res.clone().json();
      return NextResponse.json({ ...body, steps, warnings }, { status: res.status });
    } catch {
      return res;
    }
  }
}

// GET /api/contracts — history: 50 most recently modified Contracts (§3.9).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const schema = await resolveContractListFieldSchema(client);
    const selectFields = ["Id", "Status", "LastModifiedDate"];
    if (schema.contractNumberField) selectFields.push(schema.contractNumberField.apiName);
    if (schema.startDateField) selectFields.push(schema.startDateField.apiName);
    if (schema.endDateField) selectFields.push(schema.endDateField.apiName);
    if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);

    const soql = `SELECT ${[...new Set(selectFields)].join(", ")} FROM Contract ORDER BY LastModifiedDate DESC LIMIT 50`;
    const result = await client.query<Record<string, unknown>>(soql);

    const items: ContractListItem[] = result.records.map(r => {
      const accountRel = schema.accountRelationshipField?.relationshipName ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      return {
        id: r.Id as string,
        contractNumber: schema.contractNumberField ? ((r[schema.contractNumberField.apiName] as string) ?? null) : null,
        status: (r.Status as string) ?? null,
        accountName: (accountRel?.Name as string) ?? null,
        startDate: schema.startDateField ? ((r[schema.startDateField.apiName] as string) ?? null) : null,
        endDate: schema.endDateField ? ((r[schema.endDateField.apiName] as string) ?? null) : null,
        lastModifiedDate: r.LastModifiedDate as string,
      };
    });

    return NextResponse.json({
      success: true,
      contracts: items,
      soql,
      relationshipNames: { account: schema.accountRelationshipField?.relationshipName ?? null },
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list contracts");
  }
}
