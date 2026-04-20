import { AuthenticationFailure, RateLimitFailure, RequestFailure } from "@openharness/api";
import type { Settings } from "@openharness/core";

export function formatApiError(err: Error, settings: Settings): string {
  if (err instanceof AuthenticationFailure) {
    const provider = settings.provider ?? "auto";
    return [
      "Authentication failed (401). No valid API key found.",
      "",
      `  Current provider: ${provider}`,
      `  Current model:    ${settings.model}`,
      "",
      "  To fix:",
      "    1. /auth login <provider> <api-key>",
      "    2. Or set environment variable (e.g. OPENROUTER_API_KEY)",
      "    3. Use /provider to check available providers",
    ].join("\n");
  }

  if (err instanceof RateLimitFailure) {
    const msg = err.message.toLowerCase();
    const isQuota =
      msg.includes("quota") ||
      msg.includes("limit exceeded") ||
      msg.includes("insufficient") ||
      msg.includes("billing") ||
      msg.includes("capacity");
    if (isQuota) {
      return [
        "API quota exceeded.",
        "",
        `  Provider: ${settings.provider ?? "auto"}`,
        `  Model:    ${settings.model}`,
        "",
        "  Your account has reached its usage limit.",
        "  Check your billing dashboard or switch to a different provider:",
        "    /provider          — list available providers",
        "    /model <new-model> — switch to a different model",
      ].join("\n");
    }
    return [
      "Rate limit hit (429). Too many requests.",
      "",
      "  Please wait a moment and try again.",
      "  If this persists, consider using a different model:",
      "    /model <new-model>",
    ].join("\n");
  }

  if (err instanceof RequestFailure) {
    return `API request failed (${err.statusCode}): ${err.message}`;
  }

  return err.message;
}
