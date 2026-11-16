"use client";

import RecordFields, { AUDIT_SECTION, type RecordSectionConfig } from "@/components/data/shared/RecordFields";
import type { ContractDetail } from "@/lib/contracts/types";

/** Contract Fields on the Contract workspace's Overview tab — section layout only; rendering is the shared RecordFields view. */
const SECTIONS: RecordSectionConfig[] = [
  {
    title: "Contract Information",
    icon: "file-text",
    slots: [
      { label: "Contract Number", names: ["ContractNumber"] },
      { label: "Contract Status", names: ["Status"], badge: true },
      { label: "Contract Type", names: ["ContractType"] },
      // Salesforce's standard Contract term is always in months.
      { label: "Contract Term", names: ["ContractTerm"], unit: "months" },
      { label: "Start Date", names: ["StartDate"] },
      { label: "End Date", names: ["EndDate"] },
      { label: "Associated With CLM", names: ["IsAssociatedWithClm"], labelPattern: /associated with cl?m/i },
    ],
  },
  {
    title: "Account & Ownership",
    icon: "briefcase",
    slots: [
      { label: "Account Name", names: ["AccountId"] },
      { label: "Owner", names: ["OwnerId"] },
      { label: "Record Type", names: ["RecordTypeId"] },
    ],
  },
  {
    title: "Commercial Information",
    icon: "dollar-sign",
    slots: [
      { label: "Price Book", names: ["Pricebook2Id"] },
    ],
  },
  AUDIT_SECTION,
];

export default function ContractOverview({ isDark, detail }: { isDark: boolean; detail: ContractDetail }) {
  return <RecordFields isDark={isDark} data={detail} sections={SECTIONS} />;
}
