"use client";

import RecordFields, { AUDIT_SECTION, withSlotHelp, type RecordSectionConfig } from "@/components/data/shared/RecordFields";
import { TransactionTaxHelp } from "@/components/data/taxes/NativeTaxGuidance";
import type { QuoteDetail } from "@/lib/quotes/types";

/** Quote Fields on the Quote workspace's Overview tab — section layout only; rendering is the shared RecordFields view. */
const SECTIONS: RecordSectionConfig[] = [
  {
    title: "Quote Information",
    icon: "file-text",
    slots: [
      { label: "Quote Name", names: ["Name"] },
      { label: "Quote Number", names: ["QuoteNumber"] },
      { label: "Quote Status", names: ["Status"], badge: true },
      { label: "Calculation Status", names: ["CalculationStatus"], badge: true },
      { label: "Syncing", names: ["IsSyncing"] },
      { label: "Can Create Quote Line Items", names: ["CanCreateQuoteLineItems"] },
    ],
  },
  {
    title: "Ownership & Commercial Setup",
    icon: "briefcase",
    slots: [
      { label: "Account Name", names: ["AccountId", "QuoteAccountId"] },
      { label: "Owner", names: ["OwnerId"] },
      { label: "Price Book", names: ["Pricebook2Id"] },
      { label: "Record Type", names: ["RecordTypeId"] },
    ],
  },
  {
    title: "Pricing Summary",
    icon: "dollar-sign",
    slots: [
      { label: "Subtotal", names: ["Subtotal"] },
      { label: "Total Price", names: ["TotalPrice"] },
      { label: "Discount", names: ["Discount"] },
      { label: "Tax", names: ["TotalTaxAmount", "Tax"] },
      { label: "Grand Total", names: ["GrandTotal"] },
      { label: "Line Item Count", names: ["LineItemCount"] },
      { label: "Last Priced Date", names: ["LastPricedDate"] },
    ],
  },
  {
    title: "Proposal Information",
    icon: "send",
    slots: [
      { label: "Proposal Duration", names: ["ProposalDuration__c"], labelPattern: /^proposal duration$/i },
      { label: "Proposed ACV", names: ["ProposedACV__c"], labelPattern: /^proposed acv$/i },
    ],
    // Any other proposal fields this org has added (custom fields vary per org).
    collect: /propos/i,
  },
  AUDIT_SECTION,
];

export default function QuoteOverview({ isDark, detail }: { isDark: boolean; detail: QuoteDetail }) {
  return <RecordFields isDark={isDark} data={detail} sections={withSlotHelp(SECTIONS, ["TotalTaxAmount", "Tax"], <TransactionTaxHelp isDark={isDark} />)} />;
}
