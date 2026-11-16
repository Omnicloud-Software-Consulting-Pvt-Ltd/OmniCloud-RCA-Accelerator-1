import { redirect } from "next/navigation";
import { rateLibraryDataUrl } from "@/lib/taxLibrary/navigation";

// /data/tax-rate-library — direct-access path for the Global Tax Rate Library. The page itself is a view of the Taxes workspace
// inside /data (app shell, sidebar, breadcrumbs, URL-restored on refresh).
export default function TaxRateLibraryRedirect() {
  redirect(rateLibraryDataUrl());
}
