// /api/taxes/plan — Dependency-ordered, metadata-validated preview of a tax configuration spec. Never writes.
// Same handler as /api/billing/tax/plan (shared lib/tax service layer).
export { POST } from "@/app/api/billing/tax/plan/route";
