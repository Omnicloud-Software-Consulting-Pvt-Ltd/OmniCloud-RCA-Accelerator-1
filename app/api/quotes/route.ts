import { NextRequest, NextResponse } from "next/server";
import { soqlEscape } from "@/lib/salesforce/client";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveQuoteFieldSchema, resolveQuoteListFieldSchema, diagnoseQuoteLookupFields } from "@/lib/quotes/metadata/quoteFields";
import { resolveReferencesByName } from "@/lib/quotes/quote/reference";
import { resolveQuoteNameVersioning } from "@/lib/quotes/quote/versioning";
import { buildQuotePayload } from "@/lib/quotes/quote/payload";
import type { BundleHierarchyStep, QuoteFormData, QuoteListItem } from "@/lib/quotes/types";

function step(steps: BundleHierarchyStep[], s: string, status: BundleHierarchyStep["status"], message: string, detail?: unknown) {
  steps.push({ step: s, status, message, detail, timestamp: Date.now() });
}

// POST /api/quotes — create a Quote (§3.7). Every resolution step is traced
// into `steps` and returned to the client so the execution log can show
// exactly what metadata/fields/reference-Ids/payload were used BEFORE the
// Salesforce call, and what Salesforce actually returned after it.
export async function POST(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const steps: BundleHierarchyStep[] = [];
  const warnings: string[] = [];

  let formData: QuoteFormData;
  try {
    ({ formData } = await req.json());
    if (!formData?.name?.trim()) return NextResponse.json({ error: "Quote name is required" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    step(steps, "resolve-metadata", "start", "Resolving Quote field schema via Describe.");
    const schema = await resolveQuoteFieldSchema(client);
    const lookupDiagnostics = await diagnoseQuoteLookupFields(client);
    for (const d of lookupDiagnostics) {
      step(steps, "resolve-fields", d.includedInPayload ? "success" : "info", `${d.requestedApiName}: ${d.reason}`, d);
    }
    console.log("[Quote create] Describe field diagnostics", JSON.stringify(lookupDiagnostics, null, 2));
    if (!schema.nameField) {
      step(steps, "resolve-metadata", "error", "No Name field resolved on Quote in this org.");
      return NextResponse.json({ error: "Could not resolve a Name field on Quote in this org.", steps }, { status: 422 });
    }
    step(steps, "resolve-metadata", "success", "Quote field schema resolved.", schema);

    step(steps, "resolve-references", "start", "Resolving Account/PriceBook/Opportunity by exact name.");
    const [account, pricebook, opportunity] = await resolveReferencesByName(client, [
      { objectType: "Account", name: formData.accountName ?? "" },
      { objectType: "Pricebook2", name: formData.pricebookName ?? "" },
      { objectType: "Opportunity", name: formData.opportunityName ?? "" },
    ]);
    step(steps, "resolve-references", "success", `Account=${account?.id ?? "none"}, Pricebook=${pricebook?.id ?? "none"}, Opportunity=${opportunity?.id ?? "none"}`, { account, pricebook, opportunity });

    // A name was typed and resolved to a real record, but the Quote field to carry it isn't createable —
    // the association will silently NOT happen unless we say so explicitly.
    if (formData.accountName?.trim() && account && !schema.accountField) {
      warnings.push(`Account "${account.name}" was found, but this org's Quote object has no createable Account lookup field — the Quote will be created without a direct Account link. (Account may instead derive from the linked Opportunity.)`);
    }
    if (formData.opportunityName?.trim() && opportunity && !schema.opportunityField) {
      warnings.push(`Opportunity "${opportunity.name}" was found, but this org's Quote object has no createable Opportunity lookup field.`);
    }
    if (formData.pricebookName?.trim() && pricebook && !schema.pricebookField) {
      warnings.push(`Price Book "${pricebook.name}" was found, but this org's Quote object has no createable Pricebook2 lookup field.`);
    }

    step(steps, "name-versioning", "start", "Checking for existing Quotes with this name.");
    const versioning = await resolveQuoteNameVersioning(client, schema.nameField.apiName, formData.name);
    step(steps, "name-versioning", "success", versioning.wasVersioned ? `Name versioned to "${versioning.finalName}".` : "No versioning needed.", versioning);

    const resolvedLookupIds = { accountId: account?.id ?? null, pricebookId: pricebook?.id ?? null, opportunityId: opportunity?.id ?? null };
    const payload = buildQuotePayload(schema, formData, resolvedLookupIds, versioning.finalName);
    step(steps, "build-payload", "success", "Generated Quote create payload.", payload);

    // Immediately before the Salesforce call: the resolved field map, the
    // exact field names going out, the resolved lookup Ids, and the final
    // payload — everything needed to prove what was actually sent.
    const preflight = {
      resolvedFieldMap: schema,
      fieldNames: Object.keys(payload),
      resolvedLookupIds,
      finalPayload: payload,
    };
    step(steps, "preflight", "info", `Sending ${Object.keys(payload).length} field(s) to Salesforce: ${Object.keys(payload).join(", ")}`, preflight);
    console.log("[Quote create] preflight", JSON.stringify(preflight, null, 2));

    step(steps, "salesforce-create", "start", "POST /sobjects/Quote", payload);
    const result = await client.createRecord("Quote", payload);
    if (!result.success) {
      step(steps, "salesforce-create", "error", "Salesforce rejected the create call.", result.errors);
      return NextResponse.json({ error: "Quote creation was rejected by Salesforce.", details: result.errors, steps }, { status: 422 });
    }
    step(steps, "salesforce-create", "success", `Created Quote ${result.id}.`, result);

    return NextResponse.json({
      success: true,
      id: result.id,
      finalName: versioning.finalName,
      requestedName: formData.name,
      wasVersioned: versioning.wasVersioned,
      resolvedLookups: { account, pricebook, opportunity },
      payload,
      steps,
      warnings,
    });
  } catch (err) {
    step(steps, "error", "error", err instanceof Error ? err.message : "Unknown error");
    const res = sfErrorResponse(err, "Failed to create quote");
    // Attach the trace to the error response too, so a failure is just as diagnosable as a success.
    try {
      const body = await res.clone().json();
      return NextResponse.json({ ...body, steps, warnings }, { status: res.status });
    } catch {
      return res;
    }
  }
}

// GET /api/quotes — history: 50 most recently modified Quotes (§3.7).
export async function GET(req: NextRequest) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;

  try {
    const schema = await resolveQuoteListFieldSchema(client);
    const selectFields = ["Id", "Name", "LastModifiedDate"];
    if (schema.quoteNumberField) selectFields.push(schema.quoteNumberField.apiName);
    if (schema.grandTotalField) selectFields.push(schema.grandTotalField.apiName);

    // SOQL parent-relationship traversal requires the field's Describe
    // `relationshipName` (e.g. "Account" for AccountId) — NEVER the lookup
    // field's own API name. If Describe didn't give us a relationshipName,
    // that relationship genuinely isn't traversable and the column is
    // omitted rather than guessed.
    if (schema.accountRelationshipField?.relationshipName) selectFields.push(`${schema.accountRelationshipField.relationshipName}.Name`);
    if (schema.opportunityRelationshipField?.relationshipName) selectFields.push(`${schema.opportunityRelationshipField.relationshipName}.Name`);
    if (schema.pricebookRelationshipField?.relationshipName) selectFields.push(`${schema.pricebookRelationshipField.relationshipName}.Name`);

    // "Status" isn't part of the read-only list schema — try the well-known field directly, best-effort.
    selectFields.push("Status");

    const soql = `SELECT ${selectFields.join(", ")} FROM Quote ORDER BY LastModifiedDate DESC LIMIT 50`;
    console.log("[Quote history] resolved relationship names", {
      account: schema.accountRelationshipField?.relationshipName ?? null,
      opportunity: schema.opportunityRelationshipField?.relationshipName ?? null,
      pricebook: schema.pricebookRelationshipField?.relationshipName ?? null,
    });
    console.log("[Quote history] SOQL", soql);
    const result = await client.query<Record<string, unknown>>(soql);

    const ids = result.records.map(r => r.Id as string);
    let countByQuoteId = new Map<string, number>();
    if (ids.length > 0) {
      try {
        const idList = ids.map(id => `'${soqlEscape(id)}'`).join(",");
        const counts = await client.query<{ QuoteId: string; expr0: number }>(
          `SELECT QuoteId, COUNT(Id) expr0 FROM QuoteLineItem WHERE QuoteId IN (${idList}) GROUP BY QuoteId`,
        );
        countByQuoteId = new Map(counts.records.map(c => [c.QuoteId, c.expr0]));
      } catch {
        // Aggregate query failed — line item counts are simply omitted (§3.7), not a hard error.
      }
    }

    const items: QuoteListItem[] = result.records.map(r => {
      // The JSON response nests a traversed parent record under the SAME
      // relationshipName used in the SELECT clause, not the lookup field's apiName.
      const accountRel = schema.accountRelationshipField?.relationshipName ? (r[schema.accountRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      const oppRel = schema.opportunityRelationshipField?.relationshipName ? (r[schema.opportunityRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      const pbRel = schema.pricebookRelationshipField?.relationshipName ? (r[schema.pricebookRelationshipField.relationshipName] as Record<string, unknown> | null) : null;
      return {
        id: r.Id as string,
        name: r.Name as string,
        quoteNumber: schema.quoteNumberField ? ((r[schema.quoteNumberField.apiName] as string) ?? null) : null,
        grandTotal: schema.grandTotalField ? ((r[schema.grandTotalField.apiName] as number) ?? null) : null,
        status: (r.Status as string) ?? null,
        accountName: (accountRel?.Name as string) ?? null,
        opportunityName: (oppRel?.Name as string) ?? null,
        pricebookName: (pbRel?.Name as string) ?? null,
        lastModifiedDate: r.LastModifiedDate as string,
        lineItemCount: countByQuoteId.get(r.Id as string) ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      quotes: items,
      soql,
      relationshipNames: {
        account: schema.accountRelationshipField?.relationshipName ?? null,
        opportunity: schema.opportunityRelationshipField?.relationshipName ?? null,
        pricebook: schema.pricebookRelationshipField?.relationshipName ?? null,
      },
    });
  } catch (err) {
    return sfErrorResponse(err, "Failed to list quotes");
  }
}
