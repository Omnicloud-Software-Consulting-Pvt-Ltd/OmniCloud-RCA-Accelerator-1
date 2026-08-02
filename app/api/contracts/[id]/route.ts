import { NextRequest, NextResponse } from "next/server";
import { requireSFClient, sfErrorResponse } from "@/lib/salesforce/serverSession";
import { resolveContractFieldSchema } from "@/lib/contracts/metadata/contractFields";
import { checkContractMutability } from "@/lib/contracts/metadata/contractStatus";
import { resolveReferenceByName } from "@/lib/quotes/quote/reference";
import { verifyContactById } from "@/lib/contracts/contract/contact";
import { buildContractUpdatePayload } from "@/lib/contracts/contract/payload";
import type { ContractDetail, ContractFormData } from "@/lib/contracts/types";

type Params = { params: Promise<{ id: string }> };

// GET /api/contracts/[id] — single-record read, including raw lookup Ids and
// updateableApiNames so the workspace's edit view can gate fields, and the
// current activation-mutability status (§3.6, §3.9).
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  try {
    const schema = await resolveContractFieldSchema(client);
    const record = await client.getRecord("Contract", id);
    const mutability = await checkContractMutability(client, id);

    const detail: ContractDetail = {
      id,
      contractNumber: schema.contractNumberField ? ((record[schema.contractNumberField.apiName] as string) ?? null) : null,
      record,
      accountId: schema.accountField ? ((record[schema.accountField.apiName] as string) ?? null) : null,
      pricebookId: schema.pricebookField ? ((record[schema.pricebookField.apiName] as string) ?? null) : null,
      status: (record.Status as string) ?? null,
      mutability,
      updateableApiNames: schema.updateableApiNames,
    };

    return NextResponse.json({ success: true, contract: detail });
  } catch (err) {
    return sfErrorResponse(err, "Failed to load contract");
  }
}

interface UpdateBody {
  patch: Partial<ContractFormData>;
}

// PATCH /api/contracts/[id] — setIfEditable()-gated partial update (§3.5, §3.7),
// re-resolving any changed reference fields by name/Id server-side.
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireSFClient(req);
  if ("unauthorized" in auth) return auth.unauthorized;
  const { client } = auth;
  const { id } = await params;

  let patch: Partial<ContractFormData>;
  try {
    ({ patch } = (await req.json()) as UpdateBody);
    if (!patch || typeof patch !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const schema = await resolveContractFieldSchema(client);

    const [account, companySignedBy] = await Promise.all([
      patch.accountName?.trim() ? resolveReferenceByName(client, "Account", patch.accountName) : Promise.resolve(null),
      patch.companySignedByName?.trim() ? resolveReferenceByName(client, "User", patch.companySignedByName) : Promise.resolve(null),
    ]);
    const customerSignedBy = patch.customerSignedById?.trim() ? await verifyContactById(client, patch.customerSignedById) : null;

    const payload = buildContractUpdatePayload(schema, patch, {
      accountId: account?.id ?? null,
      companySignedById: companySignedBy?.id ?? null,
      customerSignedById: customerSignedBy?.id ?? null,
    });

    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ success: true, updated: {}, message: "No editable fields changed." });
    }

    await client.updateRecord("Contract", id, payload);
    return NextResponse.json({ success: true, updated: payload });
  } catch (err) {
    return sfErrorResponse(err, "Failed to update contract");
  }
}
