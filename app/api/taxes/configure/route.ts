// /api/taxes/configure — Creates/activates/maps the previewed configuration (token-checked, all-or-nothing phases) and verifies it.
// Same handler as /api/billing/tax/configure (shared lib/tax service layer).
export { POST } from "@/app/api/billing/tax/configure/route";
