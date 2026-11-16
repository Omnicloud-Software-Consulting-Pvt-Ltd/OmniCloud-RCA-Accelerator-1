"use client";

import RecordFields, { withSlotHelp, type RecordSectionConfig } from "@/components/data/shared/RecordFields";
import { TransactionTaxHelp } from "@/components/data/taxes/NativeTaxGuidance";
import type { OrderDetail } from "@/lib/orders/types";

/** Overview tab of the Order workspace — section layout only; rendering is the shared RecordFields view. */
const SECTIONS: RecordSectionConfig[] = [
  {
    title: "Order Information",
    icon: "file-text",
    slots: [
      { label: "Order Number", names: ["OrderNumber"] },
      { label: "Order Status", names: ["Status"], badge: true },
      { label: "Status Code", names: ["StatusCode"] },
      { label: "Effective Date", names: ["EffectiveDate"] },
      { label: "Activated Date", names: ["ActivatedDate"] },
      { label: "Activated By", names: ["ActivatedById"] },
      { label: "Created Date", names: ["CreatedDate"] },
      { label: "Created By", names: ["CreatedById"] },
      { label: "Last Modified Date", names: ["LastModifiedDate"] },
      { label: "Last Modified By", names: ["LastModifiedById"] },
    ],
  },
  {
    title: "Account & Billing",
    icon: "briefcase",
    slots: [
      { label: "Account Name", names: ["AccountId"] },
      { label: "Bill To Contact", names: ["BillToContactId"] },
      { label: "Billing Street", names: ["BillingStreet"], wide: true },
      { label: "Billing City", names: ["BillingCity"] },
      { label: "Billing State", names: ["BillingState"] },
      { label: "Billing Postal Code", names: ["BillingPostalCode"] },
      { label: "Billing Country", names: ["BillingCountry"] },
    ],
  },
  {
    title: "Shipping",
    icon: "package",
    slots: [
      { label: "Shipping Street", names: ["ShippingStreet"], wide: true },
      { label: "Shipping City", names: ["ShippingCity"] },
      { label: "Shipping State", names: ["ShippingState"] },
      { label: "Shipping Postal Code", names: ["ShippingPostalCode"] },
      { label: "Shipping Country", names: ["ShippingCountry"] },
    ],
  },
  {
    title: "Commercial",
    icon: "dollar-sign",
    slots: [
      { label: "Price Book", names: ["Pricebook2Id"] },
      { label: "Legal Entity", names: ["LegalEntityId"] },
      { label: "Total Amount", names: ["TotalAmount"] },
      { label: "Grand Total Amount", names: ["GrandTotalAmount"] },
      { label: "Total Tax Amount", names: ["TotalTaxAmount"] },
      { label: "Total Rounded Line Amount", names: ["TotalRoundedLineAmount"], labelPattern: /rounded line amount/i },
      { label: "Discount Percentage", names: ["DiscountPercent", "DiscountPercentage"], labelPattern: /discount.*(percent|%)/i },
      { label: "Is Reduction Order", names: ["IsReductionOrder"], labelPattern: /reduction order/i },
    ],
  },
];

export default function OrderOverview({ isDark, detail }: { isDark: boolean; detail: OrderDetail }) {
  return <RecordFields isDark={isDark} data={detail} sections={withSlotHelp(SECTIONS, ["TotalTaxAmount"], <TransactionTaxHelp isDark={isDark} />)} />;
}
