import { WebProviderError } from "./types.js";

export function formatWebError(toolName: "web_search" | "web_fetch", error: unknown): string {
  if (error instanceof WebProviderError) {
    return `${toolName} failed [${error.code}]: ${error.message}`;
  }
  return `${toolName} failed [unknown]: ${error instanceof Error ? error.message : String(error)}`;
}
