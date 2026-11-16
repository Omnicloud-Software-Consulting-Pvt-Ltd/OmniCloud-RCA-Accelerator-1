/**
 * Plain-language messages for Salesforce OAuth failures. Client-safe (no Node imports): used by the token route (server) and the
 * callback page (browser). Salesforce's own description is kept alongside so nothing is hidden.
 *
 * Note: a wrong username or password never reaches this app — Salesforce shows that error on its own login page and lets the user
 * retry there. These messages cover what Salesforce sends back to the callback, or what the token exchange returns.
 */

/** Errors Salesforce puts on the callback URL (`?error=…&error_description=…`) after the login/approval screen. */
export function authorizeErrorMessage(error: string, description?: string | null): string {
  const desc = (description ?? "").trim();
  const e = error.trim();
  if (e === "access_denied" && /denied/i.test(desc)) {
    return "Salesforce sign-in was cancelled (Deny was chosen). Click the Salesforce button again and choose Allow.";
  }
  if (e === "OAUTH_APP_BLOCKED" || e === "OAUTH_APP_ACCESS_DENIED" || /not approved|uninstalled|blocked/i.test(desc)) {
    return `This Salesforce org doesn't allow this Connected App for your user. A Salesforce admin of the org must approve or install the app (or grant you "Approve Uninstalled Connected Apps"). Salesforce said: ${desc || e}`;
  }
  if (e === "redirect_uri_mismatch") {
    return `The Connected App's Callback URL doesn't match this app. Salesforce said: ${desc || e}`;
  }
  return `Salesforce sign-in failed: ${desc || e}`;
}

/** Errors from the token endpoint (`/services/oauth2/token`) when exchanging the authorization code. */
export function tokenErrorMessage(error: string | undefined, description: string | undefined, redirectUri: string): string {
  const e = (error ?? "").trim();
  const desc = (description ?? "").trim();
  if (e === "invalid_client_id") {
    return "Salesforce doesn't recognise the Connected App Client ID (Consumer Key). Check it in Setup → Connected App.";
  }
  if (e === "invalid_client" || /invalid client credentials/i.test(desc)) {
    return "The Connected App Client Secret (Consumer Secret) is wrong. Re-enter it in Setup → Connected App.";
  }
  if (e === "redirect_uri_mismatch") {
    return `The Connected App's Callback URL must be exactly ${redirectUri}`;
  }
  if (e === "invalid_grant" && /expired|used/i.test(desc)) {
    return "This sign-in attempt expired or was already used. Click the Salesforce button and sign in again.";
  }
  if (e === "invalid_grant" && /inactive/i.test(desc)) {
    return `This Salesforce user or org is inactive. Salesforce said: ${desc}`;
  }
  if (e === "invalid_grant") {
    return `Salesforce rejected the sign-in (${desc || e}). Click the Salesforce button and try again; if it repeats, check the Connected App's OAuth policies (IP relaxation, permitted users).`;
  }
  return `Salesforce sign-in failed: ${desc || e || "unknown error"}`;
}
