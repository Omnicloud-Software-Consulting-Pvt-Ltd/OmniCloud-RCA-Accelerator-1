import type { SalesforceClient } from "@/lib/salesforce/client";
import { queryAt } from "@/lib/billing/server/billingDocuments";
import { discoverTaxMetadata } from "@/lib/tax/server/metadata";
import { getTaxConnection, loadSnapshot, productsByPolicy, taxablePolicyIds as taxablePolicies } from "@/lib/tax/server/records";
import { calculationReadiness, readStandardTax } from "@/lib/tax/server/engine";
import type { MissingObject, TaxDashboard } from "@/lib/tax/types";

/** Tax Dashboard — every number read live from the connected org. Configuration status and calculation readiness are kept apart. */
export async function getTaxDashboard(client: SalesforceClient): Promise<TaxDashboard> {
  const meta = await discoverTaxMetadata(client);
  const [snap, connection] = await Promise.all([loadSnapshot(client, meta), getTaxConnection(client)]);
  const [products, dt, taxed] = await Promise.all([
    productsByPolicy(client, meta, snap.policies.map(p => p.id)),
    readStandardTax(client, meta.apiVersion, snap),
    // A failed count is "unavailable" (null), never 0.
    queryAt(client, meta.apiVersion, "SELECT COUNT(Id) c FROM Invoice WHERE TotalTaxAmount > 0").catch(() => null),
  ]);
  const activeEngines = snap.engines.filter(e => e.status === "Active");
  const activePolicies = snap.policies.filter(p => p.status === "Active");
  const activeTreatments = snap.treatments.filter(t => t.status === "Active");
  const taxable = activeTreatments.filter(t => t.taxable && activeEngines.some(e => e.id === t.engineId));
  const effectiveRates = snap.rates.filter(r => r.effective);
  // A product is taxable when its active policy resolves to an active taxable treatment.
  const taxablePolicyIds = taxablePolicies(snap.engines, snap.policies, snap.treatments);
  const taxableProducts = products.filter(p => p.taxPolicyId && taxablePolicyIds.has(p.taxPolicyId));
  const nativeActive = activeEngines.filter(e => e.native).length;
  const calc = calculationReadiness(dt, nativeActive);
  const configured = activeEngines.length > 0 && taxablePolicyIds.size > 0 && effectiveRates.length > 0 && taxableProducts.length > 0;
  const configurationDetail = configured
    ? `${activeEngines.length} active engine(s), ${taxablePolicyIds.size} taxable polic${taxablePolicyIds.size === 1 ? "y" : "ies"}, ${effectiveRates.length} effective rate(s), ${taxableProducts.length} taxable product(s).`
    : [!activeEngines.length && "no active tax engine", !taxablePolicyIds.size && "no active policy with a taxable treatment", !effectiveRates.length && "no effective tax rate", !taxableProducts.length && "no product mapped to a taxable policy"].filter(Boolean).join(", ");
  return {
    success: true, connection, apiVersion: meta.apiVersion,
    engines: snap.engines, providers: snap.providers, policies: snap.policies, treatments: snap.treatments, items: snap.items, rates: snap.rates,
    legalEntities: snap.legalEntities, taxableProducts,
    stats: {
      activeEngines: activeEngines.length, activePolicies: activePolicies.length, activeTreatments: activeTreatments.length, taxableTreatments: taxable.length,
      items: snap.items.length, effectiveRates: effectiveRates.length, productsWithPolicy: products.length, taxedInvoices: taxed ? Number(taxed[0]?.c) || 0 : null,
    },
    status: {
      configuration: configured ? "READY" : snap.policies.length || snap.treatments.length ? "INCOMPLETE" : "NOT CONFIGURED",
      configurationDetail: configured ? configurationDetail : `Missing: ${configurationDetail}.`,
      calculation: calc.ready ? "READY" : dt || nativeActive ? "BLOCKED" : "UNKNOWN",
      calculationDetail: calc.ready ? "Salesforce's tax engine can calculate invoice tax (only an actual invoice proves it — see Verification)." : calc.reason ?? "—",
    },
    missingObjects: Object.values(meta.objects).filter((o): o is MissingObject => !o.exists),
  };
}
