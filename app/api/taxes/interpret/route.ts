// /api/taxes/interpret — AI prompt → structured tax configuration spec, resolved and previewed in Salesforce. Never writes.
// Same handler as /api/billing/tax/interpret (shared lib/tax service layer).
export { POST } from "@/app/api/billing/tax/interpret/route";
