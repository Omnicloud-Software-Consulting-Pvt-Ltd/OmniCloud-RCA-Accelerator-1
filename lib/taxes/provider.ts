/**
 * Which tax provider the CONNECTED org calculates with — derived only from the org's own Tax Engine records (the `native` flag set by
 * lib/tax/server/records.ts#readEngines: engine Type RevenueStandardTax). Client-safe; no Salesforce calls. Nothing is assumed:
 * no active engine (or engines that couldn't be read) is "unknown", never "native".
 */
import type { TaxEngineRow } from "@/lib/tax/types";

export type TaxProviderKind = "native" | "external" | "mixed" | "unknown";
export interface TaxProviderInfo {
  kind: TaxProviderKind;
  /** Active Revenue Standard Tax engines. */
  nativeEngines: string[];
  /** Active engines that calculate through an external provider (Avalara, Vertex, …). */
  externalEngines: { name: string; type: string | null; provider: string | null }[];
}

export type EngineLike = Pick<TaxEngineRow, "name" | "type" | "status" | "native"> & { provider?: { name: string } | null };

export const UNKNOWN_PROVIDER: TaxProviderInfo = { kind: "unknown", nativeEngines: [], externalEngines: [] };

export function classifyTaxProvider(engines: EngineLike[] | null | undefined): TaxProviderInfo {
  if (!engines) return UNKNOWN_PROVIDER;
  const active = engines.filter(e => e.status === "Active");
  const nativeEngines = active.filter(e => e.native).map(e => e.name);
  const externalEngines = active.filter(e => !e.native).map(e => ({ name: e.name, type: e.type, provider: e.provider?.name ?? null }));
  const kind: TaxProviderKind = nativeEngines.length && externalEngines.length ? "mixed" : nativeEngines.length ? "native" : externalEngines.length ? "external" : "unknown";
  return { kind, nativeEngines, externalEngines };
}

export const usesNativeTax = (p: TaxProviderInfo) => p.kind === "native" || p.kind === "mixed";
export const externalLabel = (p: TaxProviderInfo) => p.externalEngines.map(e => `${e.name}${e.provider ? ` (${e.provider})` : e.type ? ` (${e.type})` : ""}`).join(", ");

/* ───────────────────────────── Guidance copy ───────────────────────────── */

export const NATIVE_TITLE = "Native Salesforce Tax – Configuration Required";
export const NATIVE_MESSAGE = "This Application currently uses Salesforce Revenue Cloud's Native Tax Engine. Tax rates are maintained in your connected Salesforce org and are not automatically updated by an external tax provider.";
export const NATIVE_STEPS = [
  "Create or update the applicable Salesforce Tax Rate records.",
  "Verify the tax code, jurisdiction, product code, legal entity, currency, and effective dates as applicable.",
  "Ensure Tax Policies, Tax Treatments, and Tax Treatment Items reference the correct tax configuration.",
  "Refresh the Revenue Standard Tax Entries decision table after creating or modifying tax rates.",
  "Verify the resulting tax calculation on the invoice.",
];
export const NATIVE_NOTE = "Outdated or incomplete tax configuration can result in incorrect tax amounts.";
export const UNKNOWN_TITLE = "Tax provider/configuration not verified";
export const UNKNOWN_MESSAGE = "OmniCloud couldn't confirm which tax engine this Salesforce org uses (no active Tax Engine was found, or the engines couldn't be read). Check Engine Readiness before relying on calculated tax.";
export const TRANSACTION_NATIVE = "Tax is calculated using the tax configuration maintained in your connected Salesforce org. Tax rates are not automatically synchronized by OmniCloud.";
export const RATE_REFRESH_TIP = "After creating or modifying a Tax Rate in Salesforce, refresh the Revenue Standard Tax Entries decision table so Revenue Cloud uses the updated rate configuration.";

/** The configuration dependency each tax configuration screen depends on (Native Tax only). */
export const CONFIG_TIPS: Record<string, string> = {
  "tax-rates": RATE_REFRESH_TIP,
  "tax-treatments": "A Tax Treatment links a Tax Policy to a Tax Engine and Tax Code. Its Tax Code (and legal entity, where used) must match an effective Tax Rate, or the invoice gets no tax.",
  "tax-treatment-items": "Tax Treatment Items apply only when the parent Tax Treatment has \"Use Tax Treatment Items\" enabled. Each item's product and Tax Code must match an effective Tax Rate.",
  "tax-policies": "Products are taxed through their Tax Policy. The policy must be Active and point to an Active, taxable Tax Treatment.",
  "tax-engines": "The Revenue Standard Tax engine reads rates through its decision table. Refresh that table after rate changes so new or modified rates are used.",
};

export function transactionTaxText(p: TaxProviderInfo): string {
  if (p.kind === "native") return TRANSACTION_NATIVE;
  if (p.kind === "mixed") return `${TRANSACTION_NATIVE} Treatments on ${externalLabel(p)} are calculated by that external provider.`;
  if (p.kind === "external") return `Tax is calculated by the external tax engine configured in your connected Salesforce org: ${externalLabel(p)}. OmniCloud does not set or synchronize its tax rates.`;
  return "Tax is calculated by the tax configuration in your connected Salesforce org. The tax provider for this org hasn't been verified.";
}

export function configTipText(moduleKey: string, p: TaxProviderInfo): string | null {
  const tip = CONFIG_TIPS[moduleKey];
  if (!tip) return null;
  if (p.kind === "native") return tip;
  if (p.kind === "mixed") return `${tip} (Applies to the native engine${p.nativeEngines.length === 1 ? "" : "s"} ${p.nativeEngines.join(", ")}; ${externalLabel(p)} calculate${p.externalEngines.length === 1 ? "s" : ""} through an external provider.)`;
  if (p.kind === "external") return `This org calculates tax through ${externalLabel(p)}. Rates for that engine are maintained by the provider, not in Salesforce Tax Rate records.`;
  return "The tax provider for this org hasn't been verified, so OmniCloud can't say which configuration applies. Check Engine Readiness.";
}

/* ───────────────────────────── Interaction helpers ───────────────────────────── */

/** Keyboard handling for the info tip (Enter/Space toggle natively on the <button>). */
export const tipKeyAction = (key: string, open: boolean): "close" | null => (key === "Escape" && open ? "close" : null);

/** Banner dismissal is a per-viewer, per-org convenience — never state that must persist. Storage may be unavailable. */
export const dismissKey = (connectionKey: string) => `omnicloud_native_tax_notice_dismissed:${connectionKey}`;
export function readDismissed(storage: Pick<Storage, "getItem"> | null | undefined, connectionKey: string): boolean {
  try { return storage?.getItem(dismissKey(connectionKey)) === "1"; } catch { return false; }
}
export function writeDismissed(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, connectionKey: string, dismissed: boolean): void {
  try { if (dismissed) storage?.setItem(dismissKey(connectionKey), "1"); else storage?.removeItem(dismissKey(connectionKey)); } catch { /* storage blocked — dismissal lasts this session only */ }
}
