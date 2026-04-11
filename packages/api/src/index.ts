export { AnthropicClient } from "./providers/anthropic";
export { OpenAICompatibleClient } from "./providers/openai";
export { CopilotClient } from "./providers/copilot";
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
