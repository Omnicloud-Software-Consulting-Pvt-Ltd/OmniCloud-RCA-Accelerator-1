import Anthropic from "@anthropic-ai/sdk";

/**
 * Turns whatever the Anthropic SDK throws (or any other error) from the
 * Product Creation AI routes (generate-payload, generate-payload-multi)
 * into a clean, user-facing message + HTTP status — never the raw
 * provider error body. Shared by both routes so an invalid/missing key
 * (or any other Anthropic-side failure) reads identically for Single and
 * Multiple Product generation instead of each route inventing its own
 * wording.
 */
export const AI_KEY_UNAVAILABLE_MESSAGE =
  "Product AI generation is unavailable because the configured AI API key is invalid or missing. Complete Setup to add a valid Anthropic API key.";

export function describeProductAiError(err: unknown): { status: number; message: string } {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 503, message: AI_KEY_UNAVAILABLE_MESSAGE };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, message: `Product AI generation failed: ${err.message}` };
  }
  return { status: 500, message: err instanceof Error ? err.message : "Product AI generation failed" };
}
