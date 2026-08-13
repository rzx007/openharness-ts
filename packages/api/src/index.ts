export { AnthropicClient } from "./providers/anthropic";
export { CodexSubscriptionClient, buildCodexHeaders, resolveCodexUrl } from "./providers/codex";
export { OpenAICompatibleClient } from "./providers/openai";
export {
  PROVIDERS,
  detectProvider,
  detectProviderFromEnv,
  findByName,
  resolveProviderScopedBaseUrl,
} from "./providers/registry";
export type {
  ProviderSpec,
  ProviderConfig,
  BackendType,
} from "./providers/registry";
export {
  ModelCatalogService,
  createModelCatalogService,
} from "./models/catalog";
export type {
  ModelsDevCatalog,
  ModelsDevProvider,
  ModelsDevModel,
  ModelsDevCost,
} from "./models/catalog";

export { AuthenticationFailure, RateLimitFailure, RequestFailure } from "./errors";
