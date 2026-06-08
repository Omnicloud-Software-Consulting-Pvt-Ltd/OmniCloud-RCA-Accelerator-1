export type AuthStage = "idle" | "popup" | "loading" | "success" | "error";
export type MascotMood = "float" | "thinking" | "success" | "error";

export interface SessionData {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
  userId: string;
  username: string;
  displayName?: string;
  email?: string;
  environment: "sandbox" | "production";
  expiresAt: number;
}

/**
 * App-level identity = "who is the Omnicloud team member using the app".
 * Distinct from SessionData (which is the Salesforce org connection).
 * In Phase A this is populated by a dev stub; in Phase B by Microsoft Entra.
 */
export interface IdentityData {
  email: string;
  name: string;
  /** How the identity was established. "stub" = Phase A dev bypass. */
  provider: "stub" | "microsoft";
  signedInAt: number;
}
