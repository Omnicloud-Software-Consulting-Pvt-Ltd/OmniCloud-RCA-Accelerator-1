// /api/taxes/permissions/tax-admin — Tax Admin status / self-assignment for the CURRENT user only.
// Same handler as /api/billing/tax/permissions/tax-admin (shared lib/tax service layer).
export { GET, POST } from "@/app/api/billing/tax/permissions/tax-admin/route";
