export { AnthropicClient } from "./providers/anthropic";
export { OpenAICompatibleClient } from "./providers/openai";
export { CopilotClient } from "./providers/copilot";
export { PROVIDERS, detectProvider } from "./providers/registry";
export type { ProviderSpec, ProviderConfig } from "./providers/registry";

export { AuthenticationFailure, RateLimitFailure, RequestFailure } from "./errors";
