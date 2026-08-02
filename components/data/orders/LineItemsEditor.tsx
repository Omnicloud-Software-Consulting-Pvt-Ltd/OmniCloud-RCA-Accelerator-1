"use client";

import { useEffect, useMemo, useState } from "react";
import ProductCatalogBrowser, { type CatalogAddedInfo } from "@/components/data/orders/ProductCatalogBrowser";
import LineItemTree from "@/components/data/quotes/LineItemTree";
import BundleConfiguratorDialog from "@/components/data/orders/BundleConfiguratorDialog";
import { Section, Ic, tokens, formatCurrency } from "@/components/data/quotes/shared";
import { quoteApiGet, quoteApiPost } from "@/lib/quotes/client/apiClient";
import { updateDraftNode, removeDraftNode, findRootByProductId } from "@/lib/quotes/util/draftTree";
import { collectAllProductIds } from "@/lib/quotes/util/lineItemProductIds";
import { buildAutoSelectedDraftChildren, createRootDraft } from "@/lib/quotes/bundles/autoSelect";
import { validateDraftForest } from "@/lib/quotes/bundles/validate";
import { buildProductInfoLookup } from "@/lib/quotes/util/productInfoLookup";
import { sumDraftTreeTotal } from "@/lib/quotes/pricing/calc";
import type { CatalogProduct, PricingModel, QuoteLineItemDraft } from "@/lib/quotes/types";
import type { ExistingOrderItem, OrderProductConfigurationResult } from "@/lib/orders/types";

/** Order-side line item staging editor — orchestrates the catalog browser, pending
 * draft tree, and bundle configurator exactly like the Quote module's LineItemsEditor,
 * reusing the identical object-agnostic bundle/validation services (§0); only the two
 * API calls specific to this staging step (schema + product-configure) are routed to
 * the Order endpoints. */
export default function LineItemsEditor({ isDark, pricebookId, initialRoots, onChange, existingLineItems, onAdjustExistingQuantity }: {
  isDark: boolean;
  pricebookId: string;
  initialRoots?: QuoteLineItemDraft[];
  onChange: (roots: QuoteLineItemDraft[], valid: boolean) => void;
  /** Order items already persisted on this Order (only passed when adding more products to an EXISTING order) — used purely to mark the catalog as "Added", never mutated here. */
  existingLineItems?: ExistingOrderItem[];
  /** Bumps/decrements an already-persisted order item's quantity via the real Salesforce update/delete endpoints — only provided by OrderWorkspace's "Add More Products" step. */
  onAdjustExistingQuantity?: (lineItemId: string, currentQuantity: number, delta: number) => void;
}) {
  const t = tokens(isDark);
  const [roots, setRoots] = useState<QuoteLineItemDraft[]>(initialRoots ?? []);
  const [configs, setConfigs] = useState<OrderProductConfigurationResult[]>([]);
  const [pendingConfig, setPendingConfig] = useState<OrderProductConfigurationResult | null>(null);
  const [pricingModel, setPricingModel] = useState<PricingModel>("Indeterminate");
  const [addError, setAddError] = useState<string | null>(null);
  // §Slow Add fix (Issue 2): products whose /products/configure call is
  // still in flight — the placeholder root is already visible in Pending
  // Order Items by the time this is set (synchronous state update), this
  // only drives the catalog button's "Adding…" transient label.
  const [pendingProductIds, setPendingProductIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    quoteApiGet<{ oiSchema: { pricingModel: PricingModel } }>("Resolve OrderItem schema", "/api/orders/line-items/schema")
      .then(res => setPricingModel(res.oiSchema.pricingModel))
      .catch(() => setPricingModel("Indeterminate"));
  }, []);

  const resolveInfo = useMemo(() => buildProductInfoLookup(configs), [configs]);
  // §Bundle detection visibility: the LAST configure-time diagnostics seen
  // per product — always populated (never null) even when the product
  // wasn't detected as a bundle, specifically so "why isn't this a bundle"
  // is answerable from the UI instead of only a server console log.
  const bundleDiagnosticsByProductId = useMemo(() => {
    const map = new Map<string, OrderProductConfigurationResult["bundleDiagnostics"]>();
    for (const c of configs) map.set(c.product.id, c.bundleDiagnostics);
    return map;
  }, [configs]);
  const validation = useMemo(() => validateDraftForest(roots, resolveInfo), [roots, resolveInfo]);
  const total = useMemo(() => sumDraftTreeTotal(roots), [roots]);

  useEffect(() => {
    onChange(roots, validation.valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, validation.valid]);

  async function handleAdd(product: CatalogProduct) {
    setAddError(null);
    const existing = findRootByProductId(roots, product.id);
    if (existing) {
      // Already a root line — this is a pure client-side quantity bump, no
      // Salesforce round-trip at all (Issue 2B: Add must not create
      // OrderItems in Salesforce on every click).
      setRoots(r => updateDraftNode(r, existing.draftId, { quantity: existing.quantity + 1 }));
      return;
    }

    // §Optimistic UI (Issue 2A): insert a placeholder root SYNCHRONOUSLY,
    // before the (potentially slow, bundle-expanding) /products/configure
    // call is even sent — the user sees the product in Pending Order Items
    // and the catalog button flip to "Adding…"/"Added" immediately, never
    // waiting on Salesforce for visible feedback. `isBundleParent` starts
    // false and is corrected in place once the real configuration resolves.
    const placeholder = createRootDraft(product, false);
    setRoots(r => [...r, placeholder]);
    setPendingProductIds(prev => new Set(prev).add(product.id));

    const rollbackPlaceholder = () => {
      setRoots(r => removeDraftNode(r, placeholder.draftId));
      setPendingProductIds(prev => { const next = new Set(prev); next.delete(product.id); return next; });
    };

    try {
      const res = await quoteApiPost<{ configuration: OrderProductConfigurationResult }>(
        `Configure product: ${product.name}`, "/api/orders/products/configure", { product, pricebookId },
      );
      const configuration = res.configuration;
      setConfigs(c => [...c, configuration]);

      if (configuration.billingTreatment?.blocks && configuration.billingTreatment.outcome !== "no-billing-policy") {
        rollbackPlaceholder();
        setAddError(configuration.billingTreatment.message ?? "This product cannot be added due to a billing configuration issue.");
        return;
      }

      if (configuration.requiresConfiguration) {
        // Ambiguous bundle choices need the user's input — the placeholder
        // can't become the real draft on its own; remove it and hand off to
        // the configurator dialog, which builds and adds the real draft.
        rollbackPlaceholder();
        setPendingConfig(configuration);
        return;
      }

      const children = configuration.bundle
        ? buildAutoSelectedDraftChildren(configuration.bundle.components, configuration.bundle.groups, placeholder.draftId)
        : [];
      const resolvedPatch: Partial<QuoteLineItemDraft> = {
        isBundleParent: !!configuration.bundle?.isBundle,
        sellingModelOptionId: configuration.sellingModel.chosen?.id ?? null,
        sellingModelName: configuration.sellingModel.chosen?.name ?? null,
        sellingModelType: configuration.sellingModel.chosen?.type ?? null,
        billingFrequency: configuration.billingFrequency?.value ?? null,
        billingFrequencySource: configuration.billingFrequency?.source ?? null,
        subscriptionTerm: configuration.subscriptionTerm?.value ?? null,
        billingTreatmentOutcome: configuration.billingTreatment?.outcome ?? null,
        children,
      };
      // Update the SAME placeholder node in place — never push a second row.
      setRoots(r => updateDraftNode(r, placeholder.draftId, resolvedPatch));
      setPendingProductIds(prev => { const next = new Set(prev); next.delete(product.id); return next; });
    } catch (err) {
      rollbackPlaceholder();
      setAddError(err instanceof Error ? err.message : "Failed to resolve product configuration.");
    }
  }

  function handleConfirmConfigured(draft: QuoteLineItemDraft) {
    setRoots(r => [...r, draft]);
    setPendingConfig(null);
  }

  // §Product Catalog "Added" state — every product already on this Order,
  // pending in this session or already persisted in Salesforce, root-level
  // (editable quantity) or a bundle child anywhere in either tree
  // (informational only — bundle children stay confined to the bundle tree).
  const addedProducts = useMemo(() => {
    const map = new Map<string, CatalogAddedInfo>();
    for (const root of roots) {
      map.set(root.productId, {
        quantity: root.quantity,
        editable: true,
        onIncrement: () => setRoots(r => updateDraftNode(r, root.draftId, { quantity: root.quantity + 1 })),
        onDecrement: () => setRoots(r => (
          root.quantity <= 1 ? removeDraftNode(r, root.draftId) : updateDraftNode(r, root.draftId, { quantity: root.quantity - 1 })
        )),
      });
    }
    for (const item of existingLineItems ?? []) {
      if (map.has(item.productId)) continue; // a pending draft for the same product takes precedence
      map.set(item.productId, {
        quantity: item.quantity,
        editable: !!onAdjustExistingQuantity,
        onIncrement: onAdjustExistingQuantity ? () => onAdjustExistingQuantity(item.id, item.quantity, 1) : undefined,
        onDecrement: onAdjustExistingQuantity ? () => onAdjustExistingQuantity(item.id, item.quantity, -1) : undefined,
      });
    }
    for (const id of collectAllProductIds(roots)) if (!map.has(id)) map.set(id, { quantity: 0, editable: false });
    for (const id of collectAllProductIds(existingLineItems ?? [])) if (!map.has(id)) map.set(id, { quantity: 0, editable: false });
    return map;
  }, [roots, existingLineItems, onAdjustExistingQuantity]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Section title="Product Catalog" icon="search" isDark={isDark}>
        <ProductCatalogBrowser isDark={isDark} pricebookId={pricebookId} onAdd={handleAdd} addedProducts={addedProducts} pendingProductIds={pendingProductIds} />
        {addError && <div style={{ marginTop: 8, fontSize: 12, color: t.error }}>{addError}</div>}
      </Section>

      <Section title="Pending Order Items" icon="layers" isDark={isDark}>
        <LineItemTree
          isDark={isDark}
          roots={roots}
          pricingModel={pricingModel}
          onUpdate={(id, patch) => setRoots(r => updateDraftNode(r, id, patch))}
          onRemove={id => setRoots(r => removeDraftNode(r, id))}
          pendingProductIds={pendingProductIds}
          bundleDiagnosticsByProductId={bundleDiagnosticsByProductId}
        />

        {validation.unresolvedNodes.length > 0 && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 10, border: `1px solid ${t.error}50`, fontSize: 12 }}>
            {validation.unresolvedNodes.map((n, i) => (
              <div key={i} style={{ color: t.error, display: "flex", alignItems: "center", gap: 6 }}>
                <Ic n="alert" s={12} /> {n.message}
              </div>
            ))}
          </div>
        )}
        {validation.userSelectionsRequired.length > 0 && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 10, border: `1px solid ${t.warn}50`, fontSize: 12, color: t.body }}>
            {validation.userSelectionsRequired.map((u, i) => (
              <div key={i}>Component group &quot;{u.groupName}&quot; in {u.path.join(" → ")} has no selection — add one of its candidates if needed.</div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, fontSize: 14, fontWeight: 700, color: t.heading }}>
          Total: {formatCurrency(total)}
        </div>
      </Section>

      {pendingConfig && (
        <BundleConfiguratorDialog
          isDark={isDark}
          configuration={pendingConfig}
          onConfirm={handleConfirmConfigured}
          onCancel={() => setPendingConfig(null)}
        />
      )}
    </div>
  );
}
