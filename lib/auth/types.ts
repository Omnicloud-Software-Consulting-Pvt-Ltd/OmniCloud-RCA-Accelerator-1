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
