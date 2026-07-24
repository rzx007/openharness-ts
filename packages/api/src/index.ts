export { AnthropicClient } from "./providers/anthropic";
export { CodexSubscriptionClient, buildCodexHeaders, resolveCodexUrl } from "./providers/codex";
export { OpenAICompatibleClient } from "./providers/openai";
export {
  PROVIDERS,
  detectProvider,
  detectProviderFromEnv,
  findByName,
} from "./providers/registry";
export type {
  ProviderSpec,
  ProviderConfig,
  BackendType,
} from "./providers/registry";

export { AuthenticationFailure, RateLimitFailure, RequestFailure } from "./errors";
