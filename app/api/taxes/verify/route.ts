// /api/taxes/verify — Re-reads Salesforce and verifies a configuration. Never writes.
// Same handler as /api/billing/tax/verify (shared lib/tax service layer).
export { POST } from "@/app/api/billing/tax/verify/route";
