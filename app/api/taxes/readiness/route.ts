// /api/taxes/readiness — Read-only Salesforce tax engine readiness (decision table, permissions, configuration).
// Same handler as /api/billing/tax/readiness (shared lib/tax service layer).
export { GET } from "@/app/api/billing/tax/readiness/route";
